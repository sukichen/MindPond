#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { auditDatabase,quarantineDatabaseIssues } from './core/database-maintenance.js';
import {reservePrivateBackup} from './core/sqlite-files.js';
import { databaseFilesystem } from './core/runtime-status.js';
import {createBackupSet,restoreBackupSet,verifyBackupSet} from './core/backup-set.js';

const usage = 'Usage: mindpond-maintenance --db <file> [--check | --repair | --storage-check | --restore-to <new-file> | --backup-set <new-dir> --writers-stopped [--artifact-dir <dir>]] | --verify-set <dir> | --restore-set <dir> --to <new-dir>';
const {values, tokens} = parseArgs({tokens:true, options:{
  db:{type:'string'}, check:{type:'boolean'}, repair:{type:'boolean'},
  'storage-check':{type:'boolean'}, 'restore-to':{type:'string'},
  'artifact-dir':{type:'string'}, 'backup-set':{type:'string'},
  'verify-set':{type:'string'}, 'restore-set':{type:'string'},
  to:{type:'string'}, 'writers-stopped':{type:'boolean'},
}});
const supplied = Object.keys(values);
if (tokens.length !== supplied.length || Object.values(values).some(value => value === ''))
  throw Error(usage);
const modes = ['check','repair','storage-check','restore-to','backup-set','verify-set','restore-set'];
const selected = supplied.filter(key => modes.includes(key));
if (selected.length > 1) throw Error(usage);
const mode = selected[0] ?? 'check';
const allowed = mode === 'restore-set' ? [mode,'to'] : mode === 'verify-set' ? [mode]
  : mode === 'backup-set' ? [mode,'db','artifact-dir','writers-stopped'] : [mode,'db'];
if (supplied.some(key => !allowed.includes(key))) throw Error(usage);

if (values['verify-set']) {
  console.log(JSON.stringify(await verifyBackupSet(path.resolve(values['verify-set'])),null,2));
} else if (values['restore-set']) {
  if (!values.to) throw Error(usage);
  console.log(JSON.stringify(await restoreBackupSet(path.resolve(values['restore-set']),path.resolve(values.to)),null,2));
} else {
  if (!values.db) throw Error(usage);
  const filename = path.resolve(values.db);
  if (values['backup-set']) {
    if (!values['writers-stopped']) throw Error(usage);
    const artifactDir = path.resolve(values['artifact-dir'] ?? process.env.MINDPOND_ARTIFACT_DIR ?? filename+'.artifacts');
    console.log(JSON.stringify(await createBackupSet(filename,artifactDir,path.resolve(values['backup-set'])),null,2));
  } else if (mode === 'storage-check') {
    await checkStorage(filename);
  } else {
    await maintainDatabase(filename,mode === 'repair',values['restore-to']);
  }
}

async function checkStorage(filename:string){
  const filesystem=await databaseFilesystem(filename);
  const kind=filesystem?.kind??'unknown';
  const notice={
    network:'SQLite WAL is unsupported on network filesystems. Use durable storage mounted on one service node.',
    volatile:'The filesystem is volatile. Use persistent storage for production.',
    local_type:'Local filesystem type detected. Confirm that the volume persists across job exit and is attached to only one service node.',
    unknown:'Storage support could not be verified. Check the mount type, durability and single-node ownership before use.'
  }[kind];
  console.log(JSON.stringify({mode:'storage-check',filesystem,assessment:kind,notice},null,2));
  process.exitCode=kind==='local_type'?0:kind==='unknown'?3:2;
}

async function maintainDatabase(filename:string,repair:boolean,restoreTo?:string){
  const db=await open({filename,driver:sqlite3.Database,mode:repair?sqlite3.OPEN_READWRITE:sqlite3.OPEN_READONLY});
  try {
    await db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
    const audit=await auditDatabase(db);
    if(restoreTo){
      if(!audit.healthy)throw new Error('Backup failed integrity checks; restore refused');
      const destination=path.resolve(restoreTo);
      await reservePrivateBackup(destination);
      try{
        await db.run('VACUUM INTO ?',[destination]);await fs.chmod(destination,0o600);
        const copy=await open({filename:destination,driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});
        try{const checked=await auditDatabase(copy);if(!checked.healthy)throw new Error('Restored copy failed integrity checks');console.log(JSON.stringify({mode:'restore-copy',destination,healthy:true,artifactBytesIncluded:false,notice:'Existing databases were not changed. Stop writers before switching services. Artifact bytes are not included: restore the matching private artifact directory separately and verify SHA-256.'},null,2));}finally{await copy.close();}
      }catch(error){await fs.rm(destination,{force:true});throw error;}
    } else if(!repair || audit.healthy) {
      console.log(JSON.stringify({mode:'check',...audit},null,2));
      if(!audit.healthy)process.exitCode=2;
    } else {
      const backup=filename+'.pre-integrity-repair-'+Date.now()+'.bak';
      await reservePrivateBackup(backup);
      await db.run('VACUUM INTO ?',[backup]);
      const copy=await open({filename:backup,driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});
      try {await auditDatabase(copy);} finally {await copy.close();}
      await db.exec('BEGIN IMMEDIATE');
      try {const result=await quarantineDatabaseIssues(db);await db.exec('COMMIT');console.log(JSON.stringify({mode:'repair',backup,...result},null,2));}
      catch(error){await db.exec('ROLLBACK');throw error;}
    }
  } finally {await db.close();}
}

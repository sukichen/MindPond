#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { auditDatabase,quarantineDatabaseIssues } from './core/database-maintenance.js';
import { databaseFilesystem } from './core/runtime-status.js';
import {createBackupSet,restoreBackupSet,verifyBackupSet} from './core/backup-set.js';

const args=process.argv.slice(2);
if(args.some(arg=>['--backup-set','--verify-set','--restore-set'].includes(arg))){
  await maintainBackupSet(args);
}else if(args.includes('--storage-check')){
  const dbIndex=args.indexOf('--db');
  if(args.length!==3||dbIndex<0||!args[dbIndex+1]||args[dbIndex+1].startsWith('--'))
    throw new Error('Usage: mindpond-maintenance --db /absolute/graph.db --storage-check');
  const filesystem=await databaseFilesystem(path.resolve(args[dbIndex+1]));
  const kind=filesystem?.kind??'unknown';
  const notice={
    network:'SQLite WAL is unsupported on network filesystems. Use durable storage mounted on one service node.',
    volatile:'The filesystem is volatile. Use persistent storage for production.',
    local_type:'Local filesystem type detected. Confirm that the volume persists across job exit and is attached to only one service node.',
    unknown:'Storage support could not be verified. Check the mount type, durability and single-node ownership before use.'
  }[kind];
  console.log(JSON.stringify({mode:'storage-check',filesystem,assessment:kind,notice},null,2));
  process.exitCode=kind==='local_type'?0:kind==='unknown'?3:2;
}else{
  await maintainDatabase(args);
}

async function maintainBackupSet(args:string[]){
  const {values}=parseArgs({args,options:{
    db:{type:'string'},
    'artifact-dir':{type:'string'},
    'backup-set':{type:'string'},
    'verify-set':{type:'string'},
    'restore-set':{type:'string'},
    to:{type:'string'},
    'writers-stopped':{type:'boolean'}
  }});
  const resolve=(value:string)=>path.resolve(value);
  let result;
  if(values['backup-set']&&!values['verify-set']&&!values['restore-set']&&!values.to&&values.db&&values['writers-stopped']){
    const source=resolve(values.db);
    const artifactDir=resolve(values['artifact-dir']??process.env.MINDPOND_ARTIFACT_DIR??source+'.artifacts');
    result=await createBackupSet(source,artifactDir,resolve(values['backup-set']));
  }else if(!values['backup-set']&&!values.db&&!values['artifact-dir']&&!values['writers-stopped']){
    if(values['verify-set']&&!values['restore-set']&&!values.to){
      result=await verifyBackupSet(resolve(values['verify-set']));
    }else if(values['restore-set']&&!values['verify-set']&&values.to){
      result=await restoreBackupSet(resolve(values['restore-set']),resolve(values.to));
    }
  }
  if(!result)throw Error('Usage: mindpond-maintenance --db <file> --backup-set <new-dir> --writers-stopped [--artifact-dir <dir>] | --verify-set <dir> | --restore-set <dir> --to <new-dir>');
  console.log(JSON.stringify(result,null,2));
}

async function maintainDatabase(args:string[]){
  const dbIndex=args.indexOf('--db'),restoreIndex=args.indexOf('--restore-to');
  if(dbIndex<0 || !args[dbIndex+1] || args.some((arg,i)=>!['--db','--repair','--check','--restore-to'].includes(arg)&&i!==dbIndex+1&&i!==restoreIndex+1)||(restoreIndex>=0&&(!args[restoreIndex+1]||args.includes('--repair'))))
    throw new Error('Usage: mindpond-maintenance --db /absolute/graph.db [--storage-check | --check | --repair | --restore-to /new/database.db]. Restore creates a new file; stop writers before switching to it.');
  const filename=path.resolve(args[dbIndex+1]);await fs.access(filename);
  const repair=args.includes('--repair');
  const db=await open({filename,driver:sqlite3.Database,mode:repair?sqlite3.OPEN_READWRITE:sqlite3.OPEN_READONLY});
  try {
    await db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
    const audit=await auditDatabase(db);
    if(restoreIndex>=0){
      if(!audit.healthy)throw new Error('Backup failed integrity checks; restore refused');
      const destination=path.resolve(args[restoreIndex+1]);
      const reservation=await fs.open(destination,'wx',0o600);await reservation.close();
      try{
        await db.run('VACUUM INTO ?',[destination]);await fs.chmod(destination,0o600);
        const copy=await open({filename:destination,driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});
        try{const checked=await auditDatabase(copy);if(!checked.healthy)throw new Error('Restored copy failed integrity checks');console.log(JSON.stringify({mode:'restore-copy',destination,healthy:true,artifactBytesIncluded:false,notice:'Existing databases were not changed. Stop writers before switching services. Artifact bytes are not included: restore the matching private artifact directory separately and verify SHA-256.'},null,2));}finally{await copy.close();}
      }catch(error){await fs.rm(destination,{force:true});throw error;}
    } else if(!repair || audit.healthy) {
      console.log(JSON.stringify({mode:'check',...audit},null,2));
      if(!audit.healthy)process.exitCode=2;
    } else {
      process.umask(0o077);
      const backup=filename+'.pre-integrity-repair-'+Date.now()+'.bak';
      await db.run('VACUUM INTO ?',[backup]);await fs.chmod(backup,0o600);
      const copy=await open({filename:backup,driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});
      try {await auditDatabase(copy);} finally {await copy.close();}
      await db.exec('BEGIN IMMEDIATE');
      try {const result=await quarantineDatabaseIssues(db);await db.exec('COMMIT');console.log(JSON.stringify({mode:'repair',backup,...result},null,2));}
      catch(error){await db.exec('ROLLBACK');throw error;}
    }
  } finally {await db.close();}
}

#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { auditDatabase,quarantineDatabaseIssues } from './core/database-maintenance.js';

const args=process.argv.slice(2),dbIndex=args.indexOf('--db'),restoreIndex=args.indexOf('--restore-to');
if(dbIndex<0 || !args[dbIndex+1] || args.some((arg,i)=>!['--db','--repair','--check','--restore-to'].includes(arg)&&i!==dbIndex+1&&i!==restoreIndex+1)||(restoreIndex>=0&&(!args[restoreIndex+1]||args.includes('--repair'))))
  throw new Error('Usage: mindpond-maintenance --db /absolute/graph.db [--check | --repair | --restore-to /new/database.db]. Restore creates a new file; stop writers before switching to it.');
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
      try{const checked=await auditDatabase(copy);if(!checked.healthy)throw new Error('Restored copy failed integrity checks');console.log(JSON.stringify({mode:'restore-copy',destination,healthy:true,notice:'Existing databases were not changed. Stop writers before pointing services to the restored copy.'},null,2));}finally{await copy.close();}
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

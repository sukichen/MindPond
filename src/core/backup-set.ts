/** Offline database and immutable artifact backup. The database snapshot is the file catalog. */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import {z} from 'zod';
import {auditDatabase} from './database-maintenance.js';
import {reservePrivateBackup} from './sqlite-files.js';
import {databaseFilesystem} from './runtime-status.js';

const databaseName = 'graph.db';
const artifactsName = databaseName + '.artifacts';
const manifestName = 'manifest.json';
const digestName = 'manifest.sha256';
const format = 'mindpond.backup-set.v1';
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative().safe();
const fileRecord = z.object({size:count,sha256}).strict();
const manifestSchema = z.object({
  format:z.literal(format),
  createdAt:z.string().datetime(),
  database:fileRecord,
  artifacts:z.object({files:count,bytes:count}).strict()
}).strict();
const artifactRecord = fileRecord.extend({name:z.string().regex(/^[0-9a-f-]{36}\.blob$/)});
type FileRecord = z.infer<typeof fileRecord>;

async function privateDirectory<T>(directory:string, work:()=>Promise<T>){
  await fs.mkdir(directory,{mode:0o700});
  try {
    return await work();
  } catch (error) {
    await fs.rm(directory,{recursive:true,force:true});
    throw error;
  }
}

async function requireDirectory(directory:string){
  if (!(await fs.lstat(directory)).isDirectory()) throw Error('Expected a regular directory');
}

async function regularFile(filename:string){
  if (!(await fs.lstat(filename)).isFile()) throw Error('Expected a regular file: '+path.basename(filename));
  const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw Error('Expected a regular file: '+path.basename(filename));
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function fileEvidence(source:string, expected?:FileRecord, destination?:string):Promise<FileRecord>{
  const input=await regularFile(source);
  let output:Awaited<ReturnType<typeof fs.open>>|undefined;
  try {
    if(expected && (await input.stat()).size!==expected.size) throw Error('Backup file size does not match: '+path.basename(source));
    if(destination) output=await fs.open(destination,'wx',0o600);
    const hash=createHash('sha256');
    let size=0;
    for await(const bytes of input.createReadStream({autoClose:false})){
      size+=bytes.length;
      if(expected && size>expected.size) throw Error('Backup file size does not match: '+path.basename(source));
      hash.update(bytes);
      if(output) await output.writeFile(bytes);
    }
    const digest=hash.digest('hex');
    if(expected && (size!==expected.size||digest!==expected.sha256)) throw Error('Backup file checksum does not match: '+path.basename(source));
    await output?.sync();
    return {size,sha256:digest};
  } finally {
    try { await output?.close(); } finally { await input.close(); }
  }
}

async function readSmallFile(filename:string, limit:number){
  const file=await regularFile(filename);
  try {
    if((await file.stat()).size>limit) throw Error('Backup manifest is too large');
    const buffer=Buffer.alloc(limit+1);
    const {bytesRead}=await file.read(buffer,0,buffer.length,0);
    if(bytesRead>limit) throw Error('Backup manifest is too large');
    return buffer.subarray(0,bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

async function writePrivateFile(filename:string,text:string){
  const file=await fs.open(filename,'wx',0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncPath(filename:string){
  if(process.platform==='win32')return;
  const file=await fs.open(filename,constants.O_RDONLY);
  try { await file.sync(); } finally { await file.close(); }
}

async function artifactCatalog(database:string){
  const db=await open({filename:database,driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});
  try {
    if(!(await auditDatabase(db)).healthy) throw Error('Backup database failed integrity checks');
    if(!await db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='office_artifacts'")) return [];
    const files=z.array(artifactRecord).parse(await db.all(
      "SELECT storage_key name,size,sha256 FROM office_artifacts WHERE state='ready' ORDER BY storage_key"
    ));
    if(new Set(files.map(file=>file.name)).size!==files.length) throw Error('Duplicate committed artifact storage keys');
    return files;
  } finally {
    await db.close();
  }
}

async function requireEntries(directory:string, names:string[]){
  const entries=await fs.readdir(directory);
  const expected=new Set(names);
  if(entries.length!==expected.size||entries.some(entry=>!expected.has(entry))){
    throw Error('Backup has missing or unexpected files in '+path.basename(directory));
  }
}

export async function createBackupSet(source:string,artifactDirectory:string,destination:string){
  const sourceFile=await fs.realpath(source);
  if(!(await fs.stat(sourceFile)).isFile()) throw Error('Database must be a regular file');
  if((await databaseFilesystem(sourceFile))?.kind==='network'){
    throw Error('Database is on a network filesystem. Stop all writers and stage the matching database and WAL on a local volume before running backup-set.');
  }
  return privateDirectory(destination,async()=>{
    const database=path.join(destination,databaseName);
    const artifacts=path.join(destination,artifactsName);
    await reservePrivateBackup(database);
    const db=await open({filename:sourceFile,driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});
    try {
      await db.exec('PRAGMA busy_timeout=5000');
      await db.run('VACUUM INTO ?',[database]);
    } finally {
      await db.close();
    }
    const files=await artifactCatalog(database);
    if(files.length) await requireDirectory(artifactDirectory);
    await fs.mkdir(artifacts,{mode:0o700});
    let bytes=0;
    for(const file of files){
      await fileEvidence(path.join(artifactDirectory,file.name),file,path.join(artifacts,file.name));
      bytes+=file.size;
    }
    await syncPath(database);
    await syncPath(artifacts);
    const manifest={
      format,
      createdAt:new Date().toISOString(),
      database:await fileEvidence(database),
      artifacts:{files:files.length,bytes}
    };
    const text=JSON.stringify(manifest,null,2)+'\n';
    const manifestSha256=createHash('sha256').update(text).digest('hex');
    await writePrivateFile(path.join(destination,manifestName),text);
    // Completion marker is published only after the database and all bytes are checked.
    await writePrivateFile(path.join(destination,digestName),manifestSha256+'\n');
    await syncPath(destination);
    await syncPath(path.dirname(destination));
    return {mode:'backup-set',directory:destination,manifestSha256,...manifest};
  });
}

async function readBackupSet(directory:string,destination?:string){
  await requireDirectory(directory);
  await requireEntries(directory,[databaseName,artifactsName,manifestName,digestName]);
  const text=await readSmallFile(path.join(directory,manifestName),4096);
  const manifestSha256=createHash('sha256').update(text).digest('hex');
  const expected=(await readSmallFile(path.join(directory,digestName),128)).trim();
  if(manifestSha256!==expected) throw Error('Backup manifest checksum does not match');
  const manifest=manifestSchema.parse(JSON.parse(text));
  const artifacts=path.join(directory,artifactsName);
  await requireDirectory(artifacts);
  const source=path.join(directory,databaseName);
  const database=destination?path.join(destination,databaseName):undefined;
  await fileEvidence(source,manifest.database,database);
  const files=await artifactCatalog(database??source);
  const bytes=files.reduce((sum,file)=>sum+file.size,0);
  if(files.length!==manifest.artifacts.files||bytes!==manifest.artifacts.bytes) throw Error('Backup manifest disagrees with the database artifact catalog');
  await requireEntries(artifacts,files.map(file=>file.name));
  const restored=destination?path.join(destination,artifactsName):undefined;
  if(restored)await fs.mkdir(restored,{mode:0o700});
  for(const file of files) await fileEvidence(path.join(artifacts,file.name),file,restored?path.join(restored,file.name):undefined);
  if(restored&&destination){
    await syncPath(restored);
    await syncPath(destination);
    await syncPath(path.dirname(destination));
  }
  return {mode:destination?'restore-set':'verify-set',directory:destination??directory,healthy:true,manifestSha256,...manifest};
}

export function verifyBackupSet(directory:string){
  return readBackupSet(directory);
}

export function restoreBackupSet(directory:string,destination:string){
  return privateDirectory(destination,()=>readBackupSet(directory,destination));
}

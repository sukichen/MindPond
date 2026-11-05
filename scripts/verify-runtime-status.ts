import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {classifyDatabaseFilesystem,databaseFilesystem,RuntimeStatus} from '../src/core/runtime-status.js';
const runtime=new RuntimeStatus(),listeners=new Map<string,()=>void>();
const response={statusCode:503,writableEnded:false,once(event:string,fn:()=>void){listeners.set(event,fn);}};
runtime.middleware()({url:'/secret?token=never-record',body:'private-content'},response,()=>{});
listeners.get('close')!();listeners.get('finish')!();assert.equal(runtime.snapshot().requests,1,'a disconnected request is not counted again on finish');assert.equal(runtime.snapshot().aborted,1);
for(let i=0;i<2000;i++)runtime.observe(i,500);
const snapshot=runtime.snapshot();assert.equal(snapshot.latency.sampleCount,256);assert.equal(snapshot.recentErrors.length,20);assert.equal(snapshot.requests,2001);assert(!JSON.stringify(snapshot).includes('never-record'));assert(!JSON.stringify(snapshot).includes('private-content'));
console.log('PASS operational metrics: abort/finish de-duplication, bounded histories and no request content collection');

assert.deepEqual(classifyDatabaseFilesystem(0x6969,'linux'),{name:'NFS',kind:'network'});
assert.equal(classifyDatabaseFilesystem(0xff534d42|0,'linux').kind,'network');
assert.equal(classifyDatabaseFilesystem(0x01021994,'linux').kind,'volatile');
assert.equal(classifyDatabaseFilesystem(0xef53,'linux').kind,'local_type');
assert.equal(classifyDatabaseFilesystem(0x65735546,'linux').kind,'unknown');
assert.equal(classifyDatabaseFilesystem(0x6969,'darwin').kind,'unknown');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-storage-'));
try{
 const target=path.join(directory,'new.db');
 const preflight=spawnSync(process.execPath,[fileURLToPath(new URL('../dist/maintenance.js',import.meta.url)),'--db',target,'--storage-check'],{encoding:'utf8'});
 assert.ifError(preflight.error);
 const report=JSON.parse(preflight.stdout);
 const fsType=await databaseFilesystem(directory);
 assert.equal(report.assessment,fsType?.kind??'unknown');
 assert.equal(preflight.status,report.assessment==='local_type'?0:report.assessment==='unknown'?3:2);
 assert.deepEqual(await fs.readdir(directory),[],'preflight must not create a DB or sidecars');
 if(process.platform==='linux'){
  const dangling=path.join(directory,'dangling.db');
  await fs.symlink(target,dangling);
  assert.equal(await databaseFilesystem(dangling),null);
 }
 assert(!preflight.stdout.includes(directory),'diagnostics omit private paths');
}finally{
 await fs.rm(directory,{recursive:true,force:true});
}
console.log('PASS storage preflight: NFS, signed Linux magic, volatile/unknown classification, no database writes or private paths');

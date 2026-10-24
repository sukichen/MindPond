import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {verifyRelease} from './offline-release.mjs';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-offline-contract-')),sha=s=>createHash('sha256').update(s).digest('hex');
const data='Synthetic release file\n',manifest={format:'mindpond.offline-release.v1',version:'fixture',platform:{platform:process.platform,arch:process.arch,nodeMajor:Number(process.versions.node.split('.')[0]),nodeAbi:process.versions.modules,libc:process.report.getReport().header.glibcVersionRuntime??null},files:[{path:'fixture.txt',bytes:Buffer.byteLength(data),sha256:sha(data)}]};
async function save(){const text=JSON.stringify(manifest);await fs.writeFile(path.join(directory,'manifest.json'),text);await fs.writeFile(path.join(directory,'manifest.sha256'),sha(text));}
try{
 await fs.writeFile(path.join(directory,'fixture.txt'),data);await save();assert.equal((await verifyRelease(directory)).fileCount,1);
 await fs.writeFile(path.join(directory,'fixture.txt'),'tampered');await assert.rejects(()=>verifyRelease(directory),/contents differ/);await fs.writeFile(path.join(directory,'fixture.txt'),data);
 await fs.writeFile(path.join(directory,'unexpected.txt'),'extra');await assert.rejects(()=>verifyRelease(directory),/contents differ/);await fs.rm(path.join(directory,'unexpected.txt'));
 await fs.writeFile(path.join(directory,'manifest.sha256'),'0'.repeat(64));await assert.rejects(()=>verifyRelease(directory),/digest mismatch/);await save();
 manifest.platform.arch='different';await save();await assert.rejects(()=>verifyRelease(directory),/different OS/);manifest.platform.arch=process.arch;await save();
 if(process.platform!=='win32'){await fs.symlink(os.tmpdir(),path.join(directory,'outside'));await assert.rejects(()=>verifyRelease(directory),/external symbolic link/);}
 console.log('PASS offline release verifier: complete-file integrity, extra-file rejection, manifest digest, platform fence and external-link refusal');
}finally{await fs.rm(directory,{recursive:true,force:true});}

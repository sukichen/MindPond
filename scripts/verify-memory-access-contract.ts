/** Architectural guard in addition to the real HTTP permission regressions.
 * New authenticated consumers must not reconstruct an unrestricted role scope. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=new URL('../src/',import.meta.url),files=await fs.readdir(root,{recursive:true});
for(const file of files.filter(file=>file.endsWith('.ts'))){
 const source=await fs.readFile(new URL(file,root),'utf8');
 if(file==='core/memory-access.ts')continue;
 // The human workbench directory deliberately lists every office. Keep this
 // exception exact; role entry points must use the request-local facade.
 const checked=file==='server.ts'?source.replace('graphMemory.memoryOwners.offices()','humanOfficeDirectory()'):source;
 assert(!/\.memoryOwners\.(context|offices|assertWritable)\s*\(/.test(checked),`${file}: carry memoryAccess authority rather than rebuilding role scope`);
}
for(const file of ['role-memory-service.ts','core/role-continuity.ts','core/office-discussions.ts','core/office-collaboration.ts']){
 const source=await fs.readFile(new URL(file,root),'utf8');assert(source.includes('memoryAccess('),path.basename(file)+' must share the memory access boundary');
}
console.log('PASS memory access contract: authenticated reads, writes, continuity, learning and meeting exports use one request-local authority facade');

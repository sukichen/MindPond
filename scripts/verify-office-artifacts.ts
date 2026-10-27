/** Real MCP + raw HTTP + isolated SQLite/disk; all credentials/files are synthetic. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {request as httpRequest} from 'node:http';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {OfficeArtifacts} from '../src/core/office-artifacts.js';
import sqlite3 from 'sqlite3';
import {open,type Database} from 'sqlite';
import {roleRuntimeId} from '../src/core/roles.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {tokenDigest,type NetworkConfiguration} from '../src/integrations/network-config.js';
import {signHostSession} from '../src/integrations/host-correlation.js';
process.env.MINDPOND_ARTIFACT_MAX_FILE_BYTES=String(1024*1024);process.env.MINDPOND_ARTIFACT_MAX_TOTAL_BYTES=String(8*1024*1024);
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-artifact-fixture-')),dbPath=path.join(dir,'fixture.db');
let now=Date.now();const graph=new GraphMemory('.',{dbPath,clock:()=>now});
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const token=randomBytes(32).toString('base64url'),otherToken=randomBytes(32).toString('base64url');
const configuration:NetworkConfiguration={version:2,grants:[{principal:'human',agentId:'host',credentialId:'host',tokenHash:tokenDigest(token),domains:[],toolProfile:'office'},{principal:'human',agentId:'generic',credentialId:'generic',tokenHash:tokenDigest(otherToken),domains:[],toolProfile:'office'}]};
let network:ReturnType<typeof createNetworkMcpApp>|undefined,listener:any,reopened:GraphMemory|undefined;
const clients:Client[]=[];
const actor=(chat:string)=>({v:1 as const,principal:'human',agentId:'host',transport:'http-mcp' as const,runtimeId:roleRuntimeId('human','host','codex',chat),runtimeMode:'codex_metadata' as const,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER});
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const waitFor=async(check:()=>Promise<boolean>)=>{const end=Date.now()+4000;while(!await check()){if(Date.now()>end)throw Error('Timed out waiting for synthetic transfer state');await new Promise(r=>setTimeout(r,10));}};
try{
 // Separate service connections can upgrade one database concurrently.
 const migrationPath=path.join(dir,'migration.db');
 const migrationA=await open({filename:migrationPath,driver:sqlite3.Database}),migrationB=await open({filename:migrationPath,driver:sqlite3.Database});
 try{
  await migrationA.exec('CREATE TABLE role_messages(id TEXT PRIMARY KEY); PRAGMA busy_timeout=10000');await migrationB.exec('PRAGMA busy_timeout=10000');
  const transactional=(connection:Database)=>async<T>(work:()=>Promise<T>)=>{await connection.exec('BEGIN IMMEDIATE');try{const result=await work();await connection.exec('COMMIT');return result;}catch(error){await connection.exec('ROLLBACK');throw error;}};
  const stores=[migrationA,migrationB].map(connection=>new OfficeArtifacts(connection,graph,transactional(connection),migrationPath));
  await Promise.all(stores.map(store=>store.init()));
  assert.equal((await migrationA.all('PRAGMA table_info(role_messages)')).filter((c:any)=>c.name==='artifact_refs').length,1);
  assert.equal((await migrationA.all('PRAGMA table_info(office_artifacts)')).filter((c:any)=>c.name==='pending_blob_key').length,1);
  await Promise.all(stores.map(store=>store.close()));
 }finally{await migrationA.close();await migrationB.close();}
 console.log('PASS concurrent migration: separate SQLite connections serialize schema checks and additions');
 await graph.init();const db=(graph as any).db;
 for(const id of ['host','generic'])await graph.offices.configureAgent({id,principal:'human',name:'Synthetic '+id,host:'generic-http-mcp',state:'active',expectedRevision:0},admin);
 const hosts=['127.0.0.1'];network=createNetworkMcpApp(graph,{allowedHosts:hosts,configuration:async()=>configuration});listener=network.app.listen(0,'127.0.0.1');await new Promise<void>(r=>listener.once('listening',r));const base='http://127.0.0.1:'+listener.address().port;hosts.push(new URL(base).host);
 const transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}});const client=new Client({name:'synthetic-artifacts',version:'1'});clients.push(client);await client.connect(transport);
 const raw=(name:string,args:any={},chat='a')=>client.callTool({name,arguments:args,_meta:{threadId:chat}});
 const call=async(name:string,args:any={},chat='a')=>{const r:any=await raw(name,args,chat);assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 const denied=async(args:any,code:string,chat='a',name='office_artifact')=>{const r:any=await raw(name,args,chat);assert(r.isError,JSON.stringify(r));let parsed;try{parsed=JSON.parse(r.content[0].text);}catch{assert.equal(code,'invalid_input');assert.match(r.content[0].text,/validat|invalid|argument/i);return;}assert.equal(parsed.error.code,code,JSON.stringify(r));};
 const roles:any[]=[];
 for(const chat of ['a','b','c']){const application=await call('role_application',{action:'submit',name:'Synthetic '+chat,introduction:'Generic files only',reason:'Artifact regression',key:'apply'},chat);roles.push(await graph.roles.review({action:'approve',applicationId:application.applicationId,expectedRevision:1},admin));}
 const seats=roles.slice(0,2).map((r,i)=>({id:'seat-'+i,roleId:r.roleId,label:'Synthetic duty',role:'member'}));await graph.roles.configureOffice({id:'room',title:'Synthetic office',state:'active',expectedRevision:0,seats},admin);await graph.roles.configureOffice({id:'outside',title:'Synthetic other office',state:'active',expectedRevision:0,seats:[{id:'outside-seat',roleId:roles[2].roleId,label:'Other',role:'member'}]},admin);
 assert((await client.listTools()).tools.some(t=>t.name==='office_artifact'));assert(!(await client.listTools()).tools.some(t=>t.name.startsWith('memory_')));
 const headers=(chat='a',extra:Record<string,string>={})=>({Authorization:'Bearer '+token,'X-MindPond-Meta':JSON.stringify({threadId:chat}),...extra});
 const bytes=Buffer.concat([Buffer.from([0,255,1,128]),Buffer.from('任意原始字节🙂\n'),randomBytes(768*1024)]);
 const prepare=(data=bytes,extra:any={},chat='a')=>call('office_artifact',{action:'prepare',filename:'证据.bin',mime:'application/octet-stream',size:data.length,sha256:sha(data),key:randomUUID(),...extra},chat);
 const put=(id:string,data:Buffer,chat='a',extra:Record<string,string>={})=>fetch(base+'/artifacts/'+id+'/content',{method:'PUT',headers:headers(chat,extra),body:data});
 const get=(id:string,chat='a',extra:Record<string,string>={})=>fetch(base+'/artifacts/'+id+'/content',{headers:headers(chat,extra)});
 const privateFile=await prepare();const id=privateFile.artifact.artifactId;
 assert(!JSON.stringify(privateFile).includes(bytes.subarray(0,16).toString('base64')));assert.equal(privateFile.artifact.state,'pending');
 assert.equal((await get(id)).status,409);assert.equal((await get(id,'b')).status,404);
 assert.equal((await fetch(base+privateFile.transfer.path)).status,401);
 assert.notEqual((await fetch(base+privateFile.transfer.path,{headers:{Authorization:'Bearer '+token}})).status,200,'a bearer without the role identity never becomes a human or a last-used chat');
 const stored=await put(id,bytes);assert.equal(stored.status,201,await stored.text());
 const result=await get(id);assert.equal(result.status,200);assert.deepEqual(Buffer.from(await result.arrayBuffer()),bytes);assert.equal(result.headers.get('x-artifact-sha256'),sha(bytes));assert.match(result.headers.get('content-disposition')!,/attachment;.*filename\*=UTF-8''/);assert.equal(result.headers.get('cache-control'),'no-store');
 assert.equal((await put(id,bytes)).status,200,'lost-response retry verifies bytes without overwriting');
 const bad=Buffer.from(bytes);bad[0]=99;assert.equal((await put(id,bad)).status,422);assert.deepEqual(Buffer.from(await (await get(id)).arrayBuffer()),bytes);
 assert.equal((await get(id,'a',{Origin:'https://untrusted.example'})).status,403);assert.equal((await get(id,'a',Authorization('wrong'))).status,401);
 const head=await fetch(base+privateFile.transfer.path,{method:'HEAD',headers:headers()});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(bytes.length));assert.equal((await head.arrayBuffer()).byteLength,0);
 const range=await get(id,'a',{Range:'bytes=0-5'});assert.equal(range.status,200);assert.equal((await range.arrayBuffer()).byteLength,bytes.length);
 await denied({action:'get',artifactId:id},'not_found','b');await denied({action:'prepare',filename:'../escape',mime:'text/plain',size:0,sha256:sha(Buffer.alloc(0)),key:'traversal'},'invalid_input');
 await denied({action:'prepare',filename:'NUL.txt',mime:'text/plain',size:0,sha256:sha(Buffer.alloc(0)),key:'device'},'invalid_input');
 await denied({action:'prepare',filename:'\ud800',mime:'text/plain',size:0,sha256:sha(Buffer.alloc(0)),key:'invalid-unicode'},'invalid_input');
 await denied({action:'delete',artifactId:id},'not_found','c');
 const shared=await prepare(bytes,{scope:'recipients',recipients:[roles[1].roleId],key:'same-operation'});assert.equal((await prepare(bytes,{scope:'recipients',recipients:[roles[1].roleId],key:'same-operation'})).artifact.artifactId,shared.artifact.artifactId);
 await denied({action:'prepare',filename:'证据.bin',mime:'application/octet-stream',size:bad.length,sha256:sha(bad),scope:'recipients',recipients:[roles[1].roleId],key:'same-operation'},'idempotency_conflict');
 const sharedId=shared.artifact.artifactId;assert.equal((await put(sharedId,bytes)).status,201);assert.deepEqual(Buffer.from(await (await get(sharedId,'b')).arrayBuffer()),bytes);assert.equal((await get(sharedId,'c')).status,404);
 await denied({action:'send',recipient:roles[1].roleId,body:'Private must remain private',artifactIds:[id],key:'private-forward'},'scope_denied','a','office_message');
 const mail=await call('office_message',{action:'send',recipient:roles[1].roleId,officeId:'room',body:'Read the attached immutable file',artifactIds:[sharedId],key:'with-file'});
 const received=await call('office_receive',{action:'list'},'b');assert.deepEqual(received.messages.find((m:any)=>m.id===mail.messageId).artifactIds,[sharedId]);
 const expanded=await call('office_message',{action:'get',messageId:mail.messageId},'b');assert.equal(expanded.message.attachments[0].sha256,sha(bytes));assert.equal(expanded.message.attachments[0].artifactId,sharedId);assert(!JSON.stringify(expanded).includes('storage_key'));
 await denied({action:'send',recipient:roles[2].roleId,body:'Unauthorized forwarding',artifactIds:[sharedId],key:'forward-c'},'scope_denied','b','office_message');
 await denied({action:'delete',artifactId:sharedId},'scope_denied','b');
 const toBoth=await prepare(Buffer.from('small'),{scope:'recipients',recipients:[roles[1].roleId,roles[2].roleId]});await put(toBoth.artifact.artifactId,Buffer.from('small'));assert((await call('office_message',{action:'send',recipient:roles[2].roleId,body:'Both roles have grants',artifactIds:[toBoth.artifact.artifactId],key:'forward-authorized'},'b')).messageId);
 const office=await prepare(Buffer.from('office file'),{scope:'office',officeId:'room'}),officeId=office.artifact.artifactId;await put(officeId,Buffer.from('office file'));
 assert.equal((await get(officeId,'b')).status,200);assert.equal((await get(officeId,'c')).status,404);
 await assert.rejects(graph.artifacts.run({action:'prepare',filename:'leak.txt',mime:'text/plain',size:0,sha256:sha(Buffer.alloc(0)),scope:'office',officeId:'room',key:'foreign-office'},actor('c')),/scope_denied/,'even internal calls cannot inherit another role on the same connector');
 await graph.roles.configureOffice({id:'room',title:'Synthetic office',state:'active',expectedRevision:1,seats:seats.slice(0,1)},admin);assert.equal((await get(officeId,'b')).status,404);assert.equal((await get(sharedId,'b')).status,200,'explicit recipient permission is independent of office membership');await graph.roles.configureOffice({id:'room',title:'Synthetic office',state:'active',expectedRevision:2,seats},admin);
 configuration.grants[0].assignmentIds=['seat-0'];assert.equal((await get(officeId,'b')).status,404);delete configuration.grants[0].assignmentIds;
 const oversized=await prepare(Buffer.alloc(0),{size:graph.artifacts.limits.maxFileBytes+1,sha256:sha(Buffer.alloc(0))}).catch(e=>e);assert(oversized instanceof Error,'size budget rejected by MCP');
 console.log('PASS immutable artifacts: original binary bytes, metadata/SHA, no Base64, idempotency, safe names, role/recipient/office isolation, forwarded ACL checks and live membership/assignment changes');

 // Raw chunked requests exercise size bounds, slow-body concurrency and cancellation.
 const begin=(artifactId:string)=>{
  let resolve!:(r:{status:number;body:any})=>void,reject!:(e:any)=>void;const response=new Promise<{status:number;body:any}>((r,j)=>{resolve=r;reject=j;});
  const request=httpRequest(base+'/artifacts/'+artifactId+'/content',{method:'PUT',headers:headers('a',{'Transfer-Encoding':'chunked'})},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{body={};}resolve({status:res.statusCode!,body});});});request.on('error',reject);return {request,response};
 };
 const slow=await prepare(Buffer.from('abcdefgh'));const upload=begin(slow.artifact.artifactId);upload.request.write('ab');
 await waitFor(async()=>!!(await db.get('SELECT lease_id FROM office_artifacts WHERE id=?',[slow.artifact.artifactId])).lease_id);
 const listed=await Promise.race([call('office_artifact',{action:'list'}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Upload blocked the database queue')),1500))]);assert(listed);
 assert.equal((await put(slow.artifact.artifactId,Buffer.from('abcdefgh'))).status,503);upload.request.end('cdefgh');assert.equal((await upload.response).status,201);
 const corrupted=await prepare(Buffer.from('1234'));assert.equal((await put(corrupted.artifact.artifactId,Buffer.from('4321'))).status,422);assert.equal((await get(corrupted.artifact.artifactId)).status,409);assert.equal((await put(corrupted.artifact.artifactId,Buffer.from('1234'))).status,201);
 const tooLong=await prepare(Buffer.from('1234')),large=begin(tooLong.artifact.artifactId);large.request.end('12345');assert.equal((await large.response).status,413);
 const cancelled=await prepare(Buffer.from('1234')),abort=begin(cancelled.artifact.artifactId);void abort.response.catch(()=>{});abort.request.write('12');await waitFor(async()=>!!(await db.get('SELECT lease_id FROM office_artifacts WHERE id=?',[cancelled.artifact.artifactId])).lease_id);abort.request.destroy();await waitFor(async()=>!(await db.get('SELECT lease_id FROM office_artifacts WHERE id=?',[cancelled.artifact.artifactId])).lease_id);assert.equal((await put(cancelled.artifact.artifactId,Buffer.from('1234'))).status,201);
 const revoke=await prepare(Buffer.from('revoke')),changing=begin(revoke.artifact.artifactId);changing.request.write('re');await waitFor(async()=>!!(await db.get('SELECT lease_id FROM office_artifacts WHERE id=?',[revoke.artifact.artifactId])).lease_id);configuration.grants[0].tokenHash=tokenDigest('rotated synthetic credential');changing.request.end('voke');assert.equal((await changing.response).status,403);configuration.grants[0].tokenHash=tokenDigest(token);assert.equal((await put(revoke.artifact.artifactId,Buffer.from('revoke'))).status,201);
 const failedCommit=await prepare(Buffer.from('transaction'));const failedId=failedCommit.artifact.artifactId;
 await db.exec(`CREATE TRIGGER fixture_fail_publish BEFORE UPDATE ON office_artifacts WHEN NEW.id='${failedId}' AND NEW.state='ready' BEGIN SELECT RAISE(ABORT,'synthetic publish failure'); END`);
 assert.equal((await put(failedId,Buffer.from('transaction'))).status,500);assert.equal((await get(failedId)).status,409);const uncommitted=(await db.get('SELECT pending_blob_key FROM office_artifacts WHERE id=?',[failedId])).pending_blob_key;assert(uncommitted);await fs.stat(path.join(graph.artifacts.directory,uncommitted));
 await db.exec('DROP TRIGGER fixture_fail_publish');await graph.artifacts.sweep();await assert.rejects(fs.stat(path.join(graph.artifacts.directory,uncommitted)),{code:'ENOENT'});assert.equal((await put(failedId,Buffer.from('transaction'))).status,201);
 const removed=await prepare(Buffer.from('deleted')),deleting=begin(removed.artifact.artifactId);deleting.request.write('del');await waitFor(async()=>!!(await db.get('SELECT lease_id FROM office_artifacts WHERE id=?',[removed.artifact.artifactId])).lease_id);await call('office_artifact',{action:'delete',artifactId:removed.artifact.artifactId});deleting.request.end('eted');assert.equal((await deleting.response).status,410);
 const empty=await prepare(Buffer.alloc(0),{mime:'text/plain; charset=utf-8'});assert.equal((await put(empty.artifact.artifactId,Buffer.alloc(0))).status,201);assert.equal((await (await get(empty.artifact.artifactId)).arrayBuffer()).byteLength,0);
 console.log('PASS streaming integrity: chunked oversize rejection, slow-upload database availability, concurrent PUT fencing, aborted-body retry, checksum correction, hot credential revocation, concurrent delete and empty files');

 // Existing generic connection identity and pinned-role credentials use the same byte plane.
 const genericTransport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+otherToken,'X-MindPond-Identity':'connection'}}});const generic=new Client({name:'synthetic-generic',version:'1'});clients.push(generic);await generic.connect(genericTransport);
 const genericCall=async(name:string,arguments_:any)=>{const r:any=await generic.callTool({name,arguments:arguments_});assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 const application=await genericCall('role_application',{action:'submit',name:'Generic file role',introduction:'Files',reason:'Synthetic',key:'apply'});await graph.roles.review({action:'approve',applicationId:application.applicationId,expectedRevision:1},admin);
 const genericMeta=await genericCall('office_artifact',{action:'prepare',filename:'generic.txt',mime:'text/plain',size:4,sha256:sha(Buffer.from('file')),key:'file'});
 const genericHeaders={Authorization:'Bearer '+otherToken,'X-MindPond-Identity':'connection'};
 assert.equal((await fetch(base+genericMeta.transfer.path,{method:'PUT',headers:genericHeaders,body:'file'})).status,201);assert.equal(await (await fetch(base+genericMeta.transfer.path,{headers:genericHeaders})).text(),'file');
 const pinned=await graph.memoryOwners.issue(roles[0].roleId);assert.equal((await fetch(base+privateFile.transfer.path,{headers:{Authorization:'Bearer '+pinned.token}})).status,200);
 const otherSession=genericTransport.sessionId!;assert.equal((await get(id,'a',{'Mcp-Session-Id':otherSession})).status,404);
 // Signed host correlation is bound to the exact method and artifact; unverified metadata never reuses a chat.
 const oc={...actor('oc'),runtimeId:roleRuntimeId('human','host','opencode','oc'),runtimeMode:'opencode_metadata' as const};const ocApply=await graph.roles.application({action:'submit',name:'Signed host role',introduction:'Files',reason:'Synthetic',key:'apply'},oc);await graph.roles.review({action:'approve',applicationId:ocApply.applicationId,expectedRevision:1},admin);
 const ocMeta=await graph.artifacts.run({action:'prepare',filename:'signed.txt',mime:'text/plain',size:4,sha256:sha(Buffer.from('file')),key:'signed'},oc);
 const proof=signHostSession('oc','office_artifact_transfer',{method:'PUT',artifactId:ocMeta.artifact.artifactId},token);
 assert.equal((await fetch(base+ocMeta.transfer.path,{method:'PUT',headers:{Authorization:'Bearer '+token,'X-MindPond-Host-Context':proof},body:'file'})).status,201);
 assert.equal((await fetch(base+ocMeta.transfer.path,{headers:{Authorization:'Bearer '+token,'X-MindPond-Host-Context':proof}})).status,403);
 const tokenFile=path.join(dir,'host.token'),metaFile=path.join(dir,'host-meta.json'),input=path.join(dir,'cli-evidence.bin'),output=path.join(dir,'downloaded.bin');
 await fs.writeFile(tokenFile,token,{mode:0o600});await fs.writeFile(metaFile,JSON.stringify({threadId:'a'}),{mode:0o600});await fs.writeFile(input,bytes,{mode:0o600});
 const cli=async(args:string[])=>promisify(execFile)(process.execPath,['dist/artifact-client.js',...args,'--url',base+'/mcp','--token-file',tokenFile,'--meta-file',metaFile],{timeout:15000,maxBuffer:65536});
 const cliResult=JSON.parse((await cli(['upload','--file',input,'--key','cli-file','--recipient',roles[1].roleId])).stdout);
 assert.equal(cliResult.artifact.sha256,sha(bytes));assert(!JSON.stringify(cliResult).includes(bytes.subarray(0,16).toString('base64')));
 await cli(['download','--artifact',cliResult.artifact.artifactId,'--out',output]);assert.deepEqual(await fs.readFile(output),bytes);
 await assert.rejects(cli(['download','--artifact',cliResult.artifact.artifactId,'--out',output]),(e:any)=>e.stderr.includes('Destination already exists'));
 const cliBlob=(await db.get('SELECT storage_key FROM office_artifacts WHERE id=?',[cliResult.artifact.artifactId])).storage_key;await fs.writeFile(path.join(graph.artifacts.directory,cliBlob),bad);
 const corruptOutput=path.join(dir,'must-not-publish.bin');await assert.rejects(cli(['download','--artifact',cliResult.artifact.artifactId,'--out',corruptOutput]),(e:any)=>e.stderr.includes('checksum_mismatch'));await assert.rejects(fs.stat(corruptOutput),{code:'ENOENT'});await fs.writeFile(path.join(graph.artifacts.directory,cliBlob),bytes);
 console.log('PASS generic host CLI: local hashing, streaming upload/download, native chat correlation, byte verification, corrupt-body rejection and no destination overwrite');
 const crossToken=randomBytes(32).toString('base64url');configuration.grants.push({principal:'another-human',agentId:'another-host',credentialId:'another-host',tokenHash:tokenDigest(crossToken),domains:[],toolProfile:'office'});
 await graph.offices.configureAgent({id:'another-host',principal:'another-human',name:'Synthetic independent host',host:'generic-http-mcp',state:'active',expectedRevision:0},admin);
 const crossActor={v:1 as const,principal:'another-human',agentId:'another-host',transport:'http-mcp' as const,runtimeId:roleRuntimeId('another-human','another-host','credential','another-host'),runtimeMode:'credential' as const,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
 const crossApply=await graph.roles.application({action:'submit',name:'Another human role',introduction:'Fictional files',reason:'Synthetic',key:'apply'},crossActor);const crossRole=await graph.roles.review({action:'approve',applicationId:crossApply.applicationId,expectedRevision:1},admin);
 await denied({action:'prepare',filename:'external.txt',mime:'text/plain',size:4,sha256:sha(Buffer.from('file')),scope:'recipients',recipients:[crossRole.roleId],key:'unapproved-cross'},'scope_denied');
 await graph.roles.link({sender:roles[0].roleId,recipient:crossRole.roleId,enabled:true},admin);
 const crossFile=await prepare(Buffer.from('file'),{scope:'recipients',recipients:[crossRole.roleId]});await put(crossFile.artifact.artifactId,Buffer.from('file'));
 const crossHeaders={Authorization:'Bearer '+crossToken,'X-MindPond-Identity':'connection'};
 assert.equal(await (await fetch(base+crossFile.transfer.path,{headers:crossHeaders})).text(),'file');assert.equal((await fetch(base+privateFile.transfer.path,{headers:crossHeaders})).status,404);
 await call('office_message',{action:'send',recipient:crossRole.roleId,body:'Explicit approved cross-account attachment',artifactIds:[crossFile.artifact.artifactId],key:'cross-message'});
 console.log('PASS cross-account artifacts: explicit human link required, distinct host credentials, original-byte delivery and private-ID rejection');
 console.log('PASS host byte-plane identity: standard configured connection, per-chat metadata, exact-call signed context, dedicated role credential and foreign MCP-session rejection');

 const expiring=await prepare(Buffer.from('expire'),{retentionSeconds:1,key:'expiry'});await put(expiring.artifact.artifactId,Buffer.from('expire'));now+=2000;assert.equal((await get(expiring.artifact.artifactId)).status,410);const expiredReplay=await prepare(Buffer.from('expire'),{retentionSeconds:1,key:'expiry'});assert.equal(expiredReplay.artifact.artifactId,expiring.artifact.artifactId);assert.equal(expiredReplay.artifact.state,'expired');
 await call('office_artifact',{action:'delete',artifactId:sharedId});assert.equal((await get(sharedId,'b')).status,410);assert.equal((await prepare(bytes,{scope:'recipients',recipients:[roles[1].roleId],key:'same-operation'})).artifact.state,'deleted');assert.equal((await call('office_message',{action:'get',messageId:mail.messageId},'b')).message.attachments[0].artifactId,sharedId,'deleting bytes never deletes correspondence');
 const oldBlob=(await db.get('SELECT storage_key FROM office_artifacts WHERE id=?',[sharedId])).storage_key;await graph.artifacts.sweep();await assert.rejects(fs.stat(path.join(graph.artifacts.directory,oldBlob)),{code:'ENOENT'});
 const foreignFile=path.join(graph.artifacts.directory,randomUUID()+'.blob');await fs.writeFile(foreignFile,'not-owned-by-this-database',{mode:0o600});await fs.utimes(foreignFile,new Date(now-7200000),new Date(now-7200000));
 const orphanFiles=Array.from({length:220},()=>({id:randomUUID(),key:randomUUID()+'.part'}));
 for(const item of orphanFiles){await fs.writeFile(path.join(graph.artifacts.directory,item.key),'synthetic',{mode:0o600});await db.run("INSERT INTO office_artifacts(id,owner_role,filename,mime,size,sha256,scope,created_at,expires_at,upload_expires_at,state,pending_temp_key) VALUES(?,?,?,'text/plain',0,?,'role',0,1,1,'expired',?)",[item.id,roles[0].roleId,'abandoned.txt',sha(Buffer.alloc(0)),item.key]);}
 for(let pass=0;pass<4;pass++)await graph.artifacts.sweep();const diskFiles=await fs.readdir(graph.artifacts.directory);assert(!orphanFiles.some(f=>diskFiles.includes(f.key)),'tracked attempt cleanup progresses beyond its first 100 records');assert.equal(await fs.readFile(foreignFile,'utf8'),'not-owned-by-this-database','cleanup never scans/deletes files belonging to another database');
 assert.equal((await get(id)).status,200,'referenced immutable blobs survive orphan cleanup');
 if(process.platform!=='win32'){assert.equal((await fs.stat(graph.artifacts.directory)).mode&0o777,0o700);const blob=(await db.get('SELECT storage_key FROM office_artifacts WHERE id=?',[id])).storage_key;assert.equal((await fs.stat(path.join(graph.artifacts.directory,blob))).mode&0o777,0o600);}
 const badSymlink=await prepare(Buffer.from('safe'));await put(badSymlink.artifact.artifactId,Buffer.from('safe'));const symlinkKey=(await db.get('SELECT storage_key FROM office_artifacts WHERE id=?',[badSymlink.artifact.artifactId])).storage_key;const outside=path.join(dir,'outside.txt');await fs.writeFile(outside,'private');await fs.unlink(path.join(graph.artifacts.directory,symlinkKey));if(process.platform!=='win32'){await fs.symlink(outside,path.join(graph.artifacts.directory,symlinkKey));const response=await get(badSymlink.artifact.artifactId);assert.equal(response.status,500);assert(!(await response.text()).includes(outside));}
 const reservations:string[]=[];let quotaDenied=false;
 for(let n=0;n<12;n++){const reply:any=await raw('office_artifact',{action:'prepare',filename:'quota.bin',mime:'application/octet-stream',size:1024*1024,sha256:sha(Buffer.from('synthetic placeholder')),key:'quota-'+n});if(reply.isError){assert.equal(JSON.parse(reply.content[0].text).error.code,'payload_too_large');quotaDenied=true;break;}reservations.push(JSON.parse(reply.content[0].text).artifact.artifactId);}
 assert(quotaDenied,'global quota includes reservations, not only finished files');for(const artifactId of reservations)await call('office_artifact',{action:'delete',artifactId});
 const abandoned=await prepare(Buffer.from('pending'));now+=3600001;assert.equal((await call('office_artifact',{action:'get',artifactId:abandoned.artifact.artifactId})).artifact.state,'expired');assert.equal((await put(abandoned.artifact.artifactId,Buffer.from('pending'))).status,410);await graph.artifacts.sweep();
 console.log('PASS lifecycle: expiry/deletion revokes bytes, metadata-only tombstones fence retries, archived correspondence survives, private modes, symlink refusal and bounded owned-attempt cleanup');
 const genericRoleId=(await genericCall('role_sync',{})).identity.roleId;
 const genericBinding=await db.get("SELECT * FROM role_bindings WHERE role_id=? AND state='active'",[genericRoleId]),genericRole=await db.get('SELECT revision FROM character_roles WHERE id=?',[genericRoleId]);
 await graph.roles.disconnect({roleId:genericRoleId,bindingId:genericBinding.id,expectedRevision:genericRole.revision},admin);
 const originalRevision=(await db.get('SELECT revision FROM character_roles WHERE id=?',[roles[0].roleId])).revision;
 await graph.roles.connect({roleId:roles[0].roleId,expectedRevision:originalRevision,targetRuntimeId:genericBinding.runtime_id},admin);
 assert.equal((await genericCall('office_artifact',{action:'get',artifactId:id})).artifact.artifactId,id);const migrated=await fetch(base+privateFile.transfer.path,{headers:genericHeaders});assert.deepEqual(Buffer.from(await migrated.arrayBuffer()),bytes);assert.notEqual((await get(id)).status,200,'the detached native chat cannot keep downloading as the migrated role');
 const migratedRevision=(await db.get('SELECT revision FROM character_roles WHERE id=?',[roles[0].roleId])).revision;
 await graph.roles.connect({roleId:roles[0].roleId,expectedRevision:migratedRevision,targetRuntimeId:actor('a').runtimeId},admin);assert.equal((await get(id)).status,200);
 const snapshot=await graph.officeCollaboration.operations({action:'backup'},admin);assert.equal(snapshot.artifactBytesIncluded,false);assert.match(snapshot.notice,/Artifact bytes.*not included/);
 console.log('PASS role portability and recovery notice: changing harness/session retains immutable artifacts, detached chats lose access and database snapshots explicitly exclude file bytes');
 const stalled=await prepare(Buffer.from('1234')),shutdown=begin(stalled.artifact.artifactId);void shutdown.response.catch(()=>{});shutdown.request.write('1');await waitFor(async()=>!!(await db.get('SELECT lease_id FROM office_artifacts WHERE id=?',[stalled.artifact.artifactId])).lease_id);
 for(const c of clients)await c.close();await Promise.race([network.close(listener),new Promise((_,reject)=>setTimeout(()=>reject(Error('Shutdown waited for a stalled body')),4000))]);network=undefined;listener=undefined;await graph.close();
 reopened=new GraphMemory('.',{dbPath,clock:()=>now});await reopened.init();const restored=await reopened.artifacts.download(id,actor('a'));const chunks=[];for await(const chunk of restored.stream)chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),bytes);assert.equal((await reopened.artifacts.run({action:'get',artifactId:sharedId},actor('b'))).artifact.state,'deleted');
 console.log('PASS restart and shutdown: original bytes survive reopen; stalled transfers cancel and release leases without holding SQLite');
}finally{for(const c of clients)await c.close().catch(()=>{});await network?.close(listener);await reopened?.close();await graph.close();await fs.rm(dir,{recursive:true,force:true});}
function Authorization(value:string){return {Authorization:'Bearer '+value};}

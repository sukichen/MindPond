/** Standard MCP clients require no native metadata, plugin or modified harness. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {getEmbeddingService} from '../dist/core/embedding.js';
import {RELEASE_VERSION} from '../dist/core/release-info.js';
import {GraphMemory} from '../dist/core/graph-memory.js';
import {createNetworkMcpApp} from '../dist/integrations/network-server.js';
import {tokenDigest} from '../dist/integrations/network-config.js';
import {officeConnection} from '../dist/integrations/office-connection.js';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-generic-'));
const graph=new GraphMemory('.',{dbPath:path.join(directory,'test.db')});
const operator={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const clients:Client[]=[];let server:any,network:ReturnType<typeof createNetworkMcpApp>|undefined;
try{
 await graph.init();getEmbeddingService().generateEmbedding=async()=>[1,...Array(383).fill(0)];
 const tokens=[randomBytes(32).toString('base64url'),randomBytes(32).toString('base64url')];
 for(let i=0;i<2;i++)await graph.offices.configureAgent({id:'generic-'+i,principal:'human',name:'Example connection '+i,host:'generic-http-mcp',state:'active',expectedRevision:0},operator);
 const grants=tokens.map((token,i)=>({principal:'human',agentId:'generic-'+i,credentialId:'generic-'+i,tokenHash:tokenDigest(token),domains:[],toolProfile:'office' as const}));
 const allowedHosts=['127.0.0.1'];network=createNetworkMcpApp(graph,{configuration:async()=>({version:2,grants}),allowedHosts,maxPerAccount:32});
 server=network.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;allowedHosts.push(new URL(base).host);
 async function connect(endpoint:string,index=0,scoped=true){const client=new Client({name:'unmodified-standard-client',version:'1'});clients.push(client);const transport=new StreamableHTTPClientTransport(new URL(base+endpoint),{requestInit:{headers:{Authorization:'Bearer '+tokens[index],...(scoped?{'X-MindPond-Identity':'connection'}:{})}}});await client.connect(transport);return client;}
 async function call(client:Client,name:string,args:Record<string,unknown>={},meta?:Record<string,unknown>){const result=await client.callTool({name,arguments:args,...(meta?{_meta:meta}:{})});const data=JSON.parse((result.content as any[])[0].text);assert(!result.isError,JSON.stringify(data));return data;}
 const office=await connect('/mcp'),memory=await connect('/memory/mcp');
 assert.equal((await call(memory,'memory_identity')).owner.kind,'user');
 const application=await call(office,'role_application',{action:'submit',name:'Example role',introduction:'Synthetic standard-client test',reason:'User authorized',key:'apply'});
 const approved=await graph.roles.review({applicationId:application.applicationId,expectedRevision:1,action:'approve'},operator);
 assert.equal((await call(office,'role_sync')).identity.roleId,approved.roleId);
 assert.equal((await call(memory,'memory_identity')).owner.id,approved.roleId,'the already connected Memory endpoint follows Office approval');
 const knowledge=await call(memory,'memory_save',{content:'Synthetic role knowledge',idempotencyKey:'knowledge'});
 assert.equal(knowledge.owner.kind,'agent');
 // Metadata is irrelevant in an explicitly connection-scoped configuration.
 assert.equal((await call(memory,'memory_identity',{}, {threadId:'../not-a-chat-id','ai.opencode/sessionID':'different',progressToken:'synthetic-progress'})).owner.id,approved.roleId);
 for(const endpoint of ['/mcp','/memory/mcp']){const bridged=new Client({name:'unmodified-stdio-client',version:'1'});clients.push(bridged);await bridged.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/mcp-remote.js',import.meta.url)),'--url',base+endpoint,'--identity','connection','--token-env','MINDPOND_SYNTHETIC_TOKEN'],env:{PATH:process.env.PATH??'',MINDPOND_SYNTHETIC_TOKEN:tokens[0]},stderr:'pipe'}));const id=await call(bridged,endpoint==='/mcp'?'role_sync':'memory_identity');assert.equal(endpoint==='/mcp'?id.identity.roleId:id.owner.id,approved.roleId,'standard stdio Office/Memory share identity without host metadata');}
 const reconnected=await connect('/memory/mcp');assert.equal((await call(reconnected,'memory_identity')).owner.id,approved.roleId);
 const independent=await connect('/memory/mcp',1);assert.equal((await call(independent,'memory_identity')).owner.kind,'user','a separately configured unbound connection uses human memory');
 const secondOffice=await connect('/mcp',1),secondApp=await call(secondOffice,'role_application',{action:'submit',name:'Second role',introduction:'Independent synthetic connection',reason:'User authorized',key:'apply'});
 const second=await graph.roles.review({applicationId:secondApp.applicationId,expectedRevision:1,action:'approve'},operator);assert.equal((await call(independent,'memory_identity')).owner.id,second.roleId);
 await graph.roles.configureOffice({id:'synthetic-office',title:'Synthetic office',state:'active',expectedRevision:0,seats:[{id:'first-seat',roleId:approved.roleId,label:'First',role:'member'},{id:'second-seat',roleId:second.roleId,label:'Second',role:'member'}]},operator);
 const sent=await call(secondOffice,'office_message',{action:'send',officeId:'synthetic-office',recipient:approved.roleId,body:'Synthetic interrupted work',key:'send'});
 const taken=await call(office,'office_receive',{key:'take'}),message=taken.messages.find((m:any)=>m.id===sent.messageId);assert.equal(message.state,'processing');
 const recover={officeId:'synthetic-office',messageId:sent.messageId,action:'retry',expectedTakenAt:message.takenAt,reason:'Verify previous external results before resuming',key:'recover'};
 await assert.rejects(()=>graph.building.recoverMessage({...recover,expectedTakenAt:message.takenAt-1},operator),/stale_version/);
 await assert.rejects(()=>graph.building.recoverMessage(recover),/scope_denied/);
 const recovered=await graph.building.recoverMessage(recover,operator);assert(recovered.replacementMessageId&&recovered.replacementMessageId!==sent.messageId);
 assert.deepEqual(await graph.building.recoverMessage(recover,operator),recovered,'a lost recovery response must not produce another replacement');
 await assert.rejects(()=>graph.building.recoverMessage({...recover,reason:'different'},operator),/idempotency_conflict/);
 const oldFinish=await office.callTool({name:'office_message',arguments:{action:'finish',messageId:sent.messageId,result:'Delayed result',key:'late-finish'}});assert(oldFinish.isError,'a delayed old host cannot finish the replacement attempt');
 assert.equal((await call(office,'office_message',{action:'get',messageId:sent.messageId})).message.metadata.recovery.action,'retry');
 assert((await call(office,'office_receive',{action:'list'})).messages.some((m:any)=>m.id===recovered.replacementMessageId&&m.state==='pending'));
 const direct=await call(secondOffice,'office_message',{action:'send',recipient:approved.roleId,body:'Synthetic direct work',key:'direct'});const directTake=await call(office,'office_message',{action:'take',messageId:direct.messageId,key:'take-direct'});
 const directCancelled=await graph.building.recoverMessage({messageId:direct.messageId,action:'cancel',expectedTakenAt:directTake.takenAt,reason:'User cancelled',key:'cancel-direct'},operator);assert.equal(directCancelled.replacementMessageId,null);assert.equal((await call(office,'office_message',{action:'get',messageId:direct.messageId})).message.state,'archived');
 const status=await graph.officeCollaboration.operations({action:'status'},operator);assert.equal(status.release.version,RELEASE_VERSION);assert(status.storage.databaseBytes>0);assert(status.mcpProcesses.length>0);
 const database=(graph as any).db,originalAll=database.all.bind(database);let scans=0;database.all=(sql:string,...args:any[])=>{if(sql==='PRAGMA quick_check')scans++;return originalAll(sql,...args);};
 await graph.officeCollaboration.operations({action:'status'},operator);await graph.officeCollaboration.operations({action:'status'},operator);assert.equal(scans,0,'automatic status requests reuse the timestamped integrity result');await graph.officeCollaboration.operations({action:'checkDatabase'},operator);assert.equal(scans,1,'a human can explicitly refresh the integrity audit');database.all=originalAll;
 const backup=await graph.officeCollaboration.operations({action:'backup'},operator),drill=await graph.officeCollaboration.operations({action:'restoreDrill',id:backup.id},operator);assert(drill.healthy);assert.equal((await graph.officeCollaboration.operations({action:'status'},operator)).restoreDrill.backupId,backup.id);
 const backups=await fs.readdir(path.join(directory,'.mindpond-backups'));assert(!backups.some(n=>n.startsWith('.restore-drill-')),'temporary restored databases are cleaned');
 console.log('PASS human recovery: version guard, permissions, lost-response replay, distinct replacement, late-finish rejection, provenance, operational status and actual restore-copy drill');
 const denied=await independent.callTool({name:'memory_get',arguments:{nodeId:knowledge.id}});assert(denied.isError,'bound independent roles cannot read another role’s memory');
 const native=await connect('/memory/mcp',0,false);const missing=await native.callTool({name:'memory_identity',arguments:{}});assert(missing.isError);assert.equal(JSON.parse((missing.content as any[])[0].text).error.code,'identity_required','missing native identity never falls back to a human');
 const shared=await call(memory,'memory_save',{officeId:'synthetic-office',content:'Synthetic shared office rule',idempotencyKey:'shared'});assert(!(await independent.callTool({name:'memory_get',arguments:{nodeId:shared.id}})).isError);
 await graph.roles.configureOffice({id:'new-office',title:'New synthetic office',state:'active',expectedRevision:0,seats:[{id:'new-seat',roleId:approved.roleId,label:'New assignment',role:'member'}]},operator);
 await graph.roles.configureOffice({id:'synthetic-office',title:'Synthetic office',state:'active',expectedRevision:1,seats:[{id:'second-seat',roleId:second.roleId,label:'Second',role:'member'}]},operator);
 assert((await memory.callTool({name:'memory_get',arguments:{nodeId:shared.id}})).isError,'office knowledge follows current membership, not connection lifetime');assert(!(await memory.callTool({name:'memory_get',arguments:{nodeId:knowledge.id}})).isError);
 const registry=await graph.roles.registry(operator),firstRole=registry.roles.find((r:any)=>r.id===approved.roleId),secondRole=registry.roles.find((r:any)=>r.id===second.roleId),target=registry.chats.find((c:any)=>c.connector_id==='generic-1');assert.equal(target.chat_source,'connection');
 await assert.rejects(()=>graph.roles.connect({roleId:firstRole.id,expectedRevision:firstRole.revision,targetRuntimeId:target.runtime_id},operator),/already connected/);
 await graph.roles.disconnect({roleId:secondRole.id,expectedRevision:secondRole.revision,bindingId:secondRole.binding_id},operator);assert.equal((await call(independent,'memory_identity')).owner.kind,'user');
 await graph.roles.connect({roleId:firstRole.id,expectedRevision:firstRole.revision,targetRuntimeId:target.runtime_id},operator);assert.equal((await call(secondOffice,'role_sync')).identity.roleId,approved.roleId);assert.equal((await call(independent,'memory_identity')).owner.id,approved.roleId);assert(!(await independent.callTool({name:'memory_get',arguments:{nodeId:knowledge.id}})).isError);assert.equal((await call(memory,'memory_identity')).owner.kind,'user','explicitly detached connections become human as specified');
 console.log('PASS standard role portability: visible current connection, occupied-target refusal, explicit disconnect and cross-connection switch preserve knowledge');
 await graph.offices.configureAgent({id:'generic-0',principal:'human',name:'Example connection 0',host:'generic-http-mcp',state:'disabled',expectedRevision:1},operator);
 await assert.rejects(()=>call(memory,'memory_identity'),'revocation also rejects open standard connections');
 for(const host of ['codex','opencode','claude','generic-http-mcp']){const config=officeConnection({host,id:'example',url:'https://example.test/mcp',identityMode:'connection'});assert(config.text.includes('X-MindPond-Identity'));assert(!Object.keys(config.files??{}).length,'standard configuration never needs a plugin');if(config.config)for(const entry of Object.values((config.config as any).mcp??(config.config as any).mcpServers) as any[])assert.equal(entry.headers['X-MindPond-Identity'],'connection');}
 console.log('PASS standard MCP: paired identity without host metadata, live approval, reconnect, explicit scope, independent roles, missing-identity denial and revocation');
}finally{for(const client of clients)await client.close().catch(()=>{});await network?.close();if(server)await new Promise<void>(r=>server.close(()=>r()));await graph.close();await fs.rm(directory,{recursive:true,force:true});}

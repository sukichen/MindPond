/** Real Node worker shares the role Memory boundary; no transcript capture or personal fallback. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GraphMemory} from '../src/core/graph-memory.js';
import {roleRuntimeId} from '../src/core/roles.js';
import {createOpenCodeMemoryPlugin} from '../src/integrations/opencode-plugin.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-native-role-')),dbPath=path.join(dir,'fixture.db');
const graph=new GraphMemory('.',{dbPath}),admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const plugins:Awaited<ReturnType<typeof createOpenCodeMemoryPlugin>>[]=[];
const host={directory:dir,client:{session:{messages:async()=>{throw Error('Transcript capture must not run');}},app:{log:async()=>({})}}};
const options={dbPath,workerPath:fileURLToPath(new URL('../dist/integrations/host-worker.js',import.meta.url)),nodePath:process.execPath,timeoutMs:20000};
try{
 await graph.init();await graph.offices.configureAgent({id:'host',principal:'human',name:'OpenCode fixture',host:'opencode',state:'active',expectedRevision:0},admin);
 const roles=[];
 for(const id of ['a','b']){
  const actor={...admin,operator:false,agentId:'host',transport:'http-mcp' as const,runtimeId:roleRuntimeId('human','host','opencode',id)};
  const app=await graph.roles.application({action:'submit',name:id,introduction:'Fictional',reason:'Native roles',key:'apply'},actor);
  roles.push(await graph.roles.review({action:'approve',applicationId:app.applicationId,expectedRevision:1},admin));
 }
 const human=await graph.createNode({content:'Human-only fixture',dimension:'fact',embedding:[1,...Array(383).fill(0)]});
 const plugin=await createOpenCodeMemoryPlugin(host,options);plugins.push(plugin);
 const call=async(name:string,args:any={},sessionID='a')=>JSON.parse(await plugin.tool[name].execute(args,{sessionID}));
 assert.equal((await call('memory_identity')).owner.id,roles[0].roleId);
 assert.equal((await call('memory_identity',{},'b')).owner.id,roles[1].roleId);
 assert.equal((await call('memory_identity',{},'unbound')).owner.kind,'user');
 await assert.rejects(call('memory_get',{nodeId:human.id}),/not_found|scope_denied/);
 const schema=await call('memory_action',{tool:'memory_save',describe:true});assert(!schema.inputSchema.properties.domain&&!schema.inputSchema.properties.roleId);
 const saved=await call('memory_action',{tool:'memory_save',arguments:{content:'Native A role knowledge',idempotencyKey:'save'}});
 assert.equal(saved.owner.id,roles[0].roleId);assert.equal((await graph.getNodeById(saved.id))!.domain.id,'agent:'+roles[0].roleId);
 await assert.rejects(call('memory_get',{nodeId:saved.id},'b'),/not_found|scope_denied/);
 await assert.rejects(call('memory_action',{tool:'memory_save',arguments:{content:'Must deny',domain:{kind:'personal',id:'default'},idempotencyKey:'override'}}),/unrecognized|Unrecognized|invalid_input|invalid/i);
 await assert.rejects(call('memory_action',{tool:'memory_native_schema',describe:true}),/Unknown Memory tool/);
 const wrong=await createOpenCodeMemoryPlugin(host,{...options,dbPath:path.join(dir,'wrong.db')});plugins.push(wrong);
 assert.equal(JSON.parse(await wrong.tool.memory_identity.execute({},{sessionID:'a'})).owner.kind,'user','identity is resolved against the configured server database; deployments must pair Office and Memory');
 assert.equal(JSON.parse(await wrong.tool.memory_directory.execute({},{sessionID:'a'})).total,0);
 await plugin['chat.message']({sessionID:'a'},{parts:[]});
 assert.equal((await (graph as any).db.get("SELECT COUNT(*) n FROM nodes WHERE layer='L0'")).n,0,'No silent transcript ingestion to a personal/session domain');
 await plugin.dispose();
 const resumed=await createOpenCodeMemoryPlugin(host,options);plugins.push(resumed);
 assert.equal(JSON.parse(await resumed.tool.memory_get.execute({nodeId:saved.id},{sessionID:'a'})).content,'Native A role knowledge');
 await graph.offices.configureAgent({id:'host',principal:'human',name:'OpenCode fixture',host:'opencode',state:'disabled',expectedRevision:1},admin);
 await assert.rejects(resumed.tool.memory_get.execute({nodeId:saved.id},{sessionID:'a'}),/scope_denied|identity_required/);
 assert.equal((await graph.getNodeById(human.id))!.content,'Human-only fixture');
 console.log('PASS native OpenCode real worker: same Office role, two chat identities, configured-database identity and unbound human access, private isolation, no personal selectors/capture, reconnect and host revocation');
}finally{for(const p of plugins)await p.dispose();await graph.close();await fs.rm(dir,{recursive:true,force:true});}

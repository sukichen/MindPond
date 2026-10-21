/** Public HTTP and stdio bridge enforce the same role identity and distinct catalogs. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {issueNetworkGrant,readNetworkConfiguration} from '../src/integrations/network-config.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-network-role-')),configFile=path.join(dir,'accounts.json');
const graph=new GraphMemory('.',{dbPath:path.join(dir,'fixture.db')}),clients:Client[]=[],tokens=new Map<string,string>();
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
let network:any,listener:any;
try{
 await graph.init();
 for(const id of ['unbound-account','one','two']){
  const tokenFile=path.join(dir,id+'.token');await issueNetworkGrant({configFile,tokenFile,principal:id,...(id==='unbound-account'?{}:{agentId:id})});tokens.set(id,(await fs.readFile(tokenFile,'utf8')).trim());
  if(id!=='unbound-account')await graph.offices.configureAgent({id,principal:id,name:id,host:'codex',state:'active',expectedRevision:0},admin);
 }
 const allowedHosts=['127.0.0.1'];network=createNetworkMcpApp(graph,{configuration:()=>readNetworkConfiguration(configFile),allowedHosts,maxPerAccount:12});
 listener=network.app.listen(0,'127.0.0.1');await new Promise<void>(r=>listener.once('listening',r));const base='http://127.0.0.1:'+listener.address().port;allowedHosts.push(new URL(base).host);
 const connect=async(id:string,endpoint='/mcp',credential=tokens.get(id)!)=>{const c=new Client({name:'fixture',version:'1'});clients.push(c);await c.connect(new StreamableHTTPClientTransport(new URL(base+endpoint),{requestInit:{headers:{Authorization:'Bearer '+credential,'X-MindPond-Session':'same-installation'}}}));return c;};
 for(const endpoint of ['/mcp','/memory/mcp'])await assert.rejects(connect('unbound-account',endpoint),(e:any)=>e.code===403,'account-domain credentials cannot enter either role MCP endpoint');
 const call=async(c:Client,name:string,args:any={},threadId?:string)=>{const r:any=await c.callTool({name,arguments:args,...(threadId?{_meta:{threadId}}:{})});let data;try{data=JSON.parse(r.content[0].text);}catch{data={message:r.content[0].text};}return {r,data};};
 const office=await connect('one'),office2=await connect('two'),memory=await connect('one','/memory/mcp'),memory2=await connect('two','/memory/mcp');
 assert((await office.listTools()).tools.every(t=>!t.name.startsWith('memory_')));assert((await memory.listTools()).tools.every(t=>t.name.startsWith('memory_')));
 const roles=[];
 for(const c of [office,office2]){const app=await call(c,'role_application',{action:'submit',name:'Fictional',introduction:'Fixture',reason:'Network identity',key:'apply'},'chat');assert(!app.r.isError,JSON.stringify(app));roles.push(await graph.roles.review({action:'approve',applicationId:app.data.applicationId,expectedRevision:1},admin));}
 const identity=await call(memory,'memory_identity',{},'chat');assert.equal(identity.data.owner.id,roles[0].roleId);assert.equal(identity.data.identity.bindingId,(await call(office,'role_sync',{},'chat')).data.identity.bindingId);
 const missing=await call(memory,'memory_save',{content:'Must not save as a human',idempotencyKey:'missing'});assert(missing.r.isError);assert.equal(missing.data.error.code,'identity_required','static installation header cannot replace native chat identity');
 const saved=await call(memory,'memory_save',{content:'Role one network knowledge',idempotencyKey:'save'},'chat');assert(!saved.r.isError,JSON.stringify(saved));assert.equal(saved.data.owner.id,roles[0].roleId);
 assert((await call(memory2,'memory_get',{nodeId:saved.data.id},'chat')).r.isError);
 const excessive=await call(memory,'memory_save',{content:'Must deny',tags:Array(10001).fill('fixture'),idempotencyKey:'oversized'},'chat');assert(excessive.r.isError);assert.match(JSON.stringify(excessive.r),/maximum of 10000 elements/);
 const request=(extra:any={},body:any={})=>fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.get('one'),'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
 assert.equal((await request({Authorization:''})).status,401);assert.equal((await request({Origin:'https://untrusted.example'})).status,403);
 assert.equal((await request({}, {jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'role_sync',arguments:{x:'x'.repeat(1024*1024)}}})).status,413);
 assert.equal((await request({'mcp-session-id':'foreign-session'})).status,404);
 const bridge=new Client({name:'bridge',version:'1'});clients.push(bridge);await bridge.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/mcp-remote.js'),'--url',base+'/memory/mcp','--token-file',path.join(dir,'one.token'),'--session','same-installation'],stderr:'pipe'}));
 assert.equal((await call(bridge,'memory_get',{nodeId:saved.data.id},'chat')).data.content,'Role one network knowledge');assert((await call(bridge,'memory_identity')).r.isError,'bridge cannot lose native identity and become human');
 const dedicated=await graph.memoryOwners.issue(roles[0].roleId),dedicatedFile=path.join(dir,'dedicated.token');await fs.writeFile(dedicatedFile,dedicated.token,{mode:0o600});
 const fixed=new Client({name:'fixed-bridge',version:'1'});clients.push(fixed);await fixed.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/mcp-remote.js'),'--url',base+'/memory/mcp','--token-file',dedicatedFile],stderr:'pipe'}));
 assert.equal((await call(fixed,'memory_identity')).data.owner.id,roles[0].roleId,'verified dedicated credential is an explicit role identity, never a human');
 const rotated=path.join(dir,'rotated.token');await issueNetworkGrant({configFile,tokenFile:rotated,principal:'one',agentId:'one',rotate:true});assert.equal((await request()).status,401,'old host credential is revoked without a restart');
 tokens.set('one',(await fs.readFile(rotated,'utf8')).trim());const reconnected=await connect('one','/memory/mcp');assert.equal((await call(reconnected,'memory_get',{nodeId:saved.data.id},'chat')).data.owner.id,roles[0].roleId);
 assert.equal((await (graph as any).db.get("SELECT COUNT(*) n FROM nodes WHERE content='Must not save as a human'")).n,0);
 console.log('PASS public role-only HTTP/bridge: account-only and missing-native rejection, Office/Memory same binding, isolation, SDK/HTTP budgets, Origin/session guards, dedicated role credentials and hot rotation');
}finally{await Promise.allSettled(clients.map(c=>c.close()));if(network)await network.close(listener);await graph.close();await fs.rm(dir,{recursive:true,force:true});}

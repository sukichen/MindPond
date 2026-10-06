/** Real HTTP + stdio clients, per-account credentials, shared personal memory and isolated sessions. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {getEmbeddingService} from '../src/core/embedding.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {issueNetworkGrant,readNetworkConfiguration} from '../src/integrations/network-config.js';
import {prepareClientBundle,readClientBundle,clientLaunch} from '../src/integrations/client-bundle.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-network-'));
const configFile=path.join(dir,'server.accounts.json');
const embedding=getEmbeddingService(),oldGenerate=embedding.generateEmbedding;
embedding.generateEmbedding=async()=>[1,...Array(383).fill(0)];
const graph=new GraphMemory('.',{dbPath:path.join(dir,'central.db')});
const clients:Client[]=[],transports:StreamableHTTPClientTransport[]=[];
let network:ReturnType<typeof createNetworkMcpApp>|undefined;
let listener:import('node:http').Server|undefined;
const decode=(r:any)=>JSON.parse(r.content.find((v:any)=>v.type==='text').text);
const call=async(c:Client,name:string,args:Record<string,unknown>={})=>{const r=await c.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r));return decode(r);};
const tokenFiles=new Map<string,string>(),tokens=new Map<string,string>();
try {
  for(const principal of ['account-one','account-two','unrelated']) {
    const tokenFile=path.join(dir,principal+'.token');
    await issueNetworkGrant({configFile,tokenFile,principal,personalId:principal==='unrelated'?'private':'default'});
    tokenFiles.set(principal,tokenFile);tokens.set(principal,(await fs.readFile(tokenFile,'utf8')).trim());
  }
  assert(!((await fs.readFile(configFile,'utf8')).includes(tokens.get('account-one')!)),'server file stores only token hashes');
  await graph.init();
  const allowedHosts=['127.0.0.1:7904'];
  network=createNetworkMcpApp(graph,{configuration:()=>readNetworkConfiguration(configFile),allowedHosts,maxConnections:8,maxPerAccount:3});
  listener=network.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>listener!.once('listening',resolve));
  const port=(listener.address() as import('node:net').AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`);
  const url=new URL(`http://127.0.0.1:${port}/mcp`);
  // Tests send an explicitly allowed Host instead of broadening the production rule.
  const headers=(principal:string)=>({Authorization:`Bearer ${tokens.get(principal)}`,Host:'127.0.0.1:7904'});
  const connect=async(principal:string,logicalSession?:string)=>{
    const client=new Client({name:principal,version:'1'});clients.push(client);
    const transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:{...headers(principal),...(logicalSession?{'X-MindPond-Session':logicalSession}:{})}}});transports.push(transport);
    await client.connect(transport);return {client,transport};
  };
  const [a,b,privateClient]=await Promise.all(['account-one','account-two','unrelated'].map(p=>connect(p)));
  const capA=await call(a.client,'memory_capabilities'),capB=await call(b.client,'memory_capabilities');
  assert.notEqual(capA.mcpConnection.sessionId,capB.mcpConnection.sessionId);
  assert.equal(capA.mcpConnection.toolProfile,'work');
  assert(a.client.getInstructions()?.includes('memory_brief'));
  const sharedInput={content:'Network shared development guide: the proxy uses a checked loopback endpoint; production is unknown.',domain:{kind:'personal',id:'default'},dimensions:['environment'],memberships:[{spaceId:'project:one',memoryType:'environment'}],idempotencyKey:'shared-observation'};
  const [saved,replayed]=await Promise.all([call(a.client,'memory_save',sharedInput),call(b.client,'memory_save',sharedInput)]);
  assert.equal(saved.id,replayed.id,'one shared DB and durable idempotent receipt');
  assert.equal((await call(b.client,'memory_get',{nodeId:saved.id})).id,saved.id);
  const other=await call(b.client,'memory_save',{...sharedInput,content:'Different project endpoint remains independently scoped.',memberships:[{spaceId:'project:two',memoryType:'environment'}],idempotencyKey:'other-project'});
  const search=await call(a.client,'memory_search',{query:'development guide',spaceId:'project:one',minScore:0});
  assert(search.results.some((v:any)=>v.id===saved.id));assert(!search.results.some((v:any)=>v.id===other.id));
  const hidden=await privateClient.client.callTool({name:'memory_get',arguments:{nodeId:saved.id}});assert(hidden.isError||!!decode(hidden).error);
  const processMemory=await call(a.client,'memory_save',{content:'Only account one current investigation may read this unfinished hypothesis.',dimensions:['work']});
  const processNode=await graph.getNodeById(processMemory.id,{trackAccess:false});assert.equal(processNode!.domain.kind,'session');
  const hiddenSession=await b.client.callTool({name:'memory_get',arguments:{nodeId:processMemory.id}});assert(hiddenSession.isError||!!decode(hiddenSession).error);
  for(const args of [{sessionId:capA.mcpConnection.sessionId},{domains:[{kind:'personal',id:'private'}]}]) {
    const r=await b.client.callTool({name:'memory_brief',arguments:{task:'scope check',...args}});assert(r.isError,'widening denied');
  }
  assert(!(await b.client.listTools()).tools.some(t=>t.name==='memory_dedupe_resolve'));
  const continued=await connect('account-one','project-conversation');
  const continuedCap=await call(continued.client,'memory_capabilities');
  const durableSession=await call(continued.client,'memory_save',{content:'A resumable investigation keeps its observations through central transport restarts.',dimensions:['work']});
  const resumed=await connect('account-one','project-conversation');
  const resumedCap=await call(resumed.client,'memory_capabilities');
  assert.equal(continuedCap.mcpConnection.sessionId,resumedCap.mcpConnection.sessionId,'same account/session resumes across independent connections');
  const otherLabel=await connect('account-two','project-conversation');
  assert.notEqual((await call(otherLabel.client,'memory_capabilities')).mcpConnection.sessionId,resumedCap.mcpConnection.sessionId,'same host label is namespaced by account');
  const limited=new Client({name:'limit',version:'1'});clients.push(limited);
  await assert.rejects(limited.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:headers('account-one')}})),(error:any)=>error.code===429);
  const makeRequest=(extra:Record<string,string>={})=>fetch(url,{method:'POST',headers:{...headers('account-one'),Accept:'application/json, text/event-stream','Content-Type':'application/json',...extra},body:JSON.stringify({jsonrpc:'2.0',id:91,method:'tools/list',params:{}})});
  assert.equal((await makeRequest({Authorization:''})).status,401);
  assert.equal((await makeRequest({Origin:'https://untrusted.example'})).status,403);
  allowedHosts.pop();assert.equal((await makeRequest()).status,403,'unlisted Host denied');allowedHosts.push(`127.0.0.1:${port}`);
  assert.equal((await makeRequest({'Mcp-Session-Id':b.transport.sessionId!})).status,404,'another account cannot hijack a transport');
  assert.equal((await makeRequest()).status,400,'non-initialize request needs a session');
  assert.equal((await fetch(new URL('/api/memory/graph',url),{headers:{Host:'127.0.0.1:7904'}})).status,404,'no operator API exposed');
  console.log('PASS real central HTTP MCP: shared personal/idempotency, independent projects, account/domain/session/Origin/Host guards');

  // Proxy runs in a separate process, with no database path or local model.
  // Rebind Host allowlist to include the actual port for unmodified bridge HTTP requests.
  await Promise.all(clients.map(c=>c.close()));clients.length=0;
  await network.close(listener);listener=undefined;
  network=createNetworkMcpApp(graph,{configuration:()=>readNetworkConfiguration(configFile),allowedHosts:[`127.0.0.1:${port}`],maxPerAccount:2});
  listener=network.app.listen(port,'127.0.0.1');await new Promise<void>(resolve=>listener!.once('listening',resolve));
  const rejoined=new Client({name:'another-machine',version:'1'});clients.push(rejoined);
  await rejoined.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${tokens.get('account-one')}`,'X-MindPond-Session':'project-conversation'}}}));
  assert.equal((await call(rejoined,'memory_get',{nodeId:durableSession.id})).id,durableSession.id,'account and logical session survive transport restart without an IP binding');
  const bridge=new Client({name:'bridge-consumer',version:'1'});clients.push(bridge);
  await bridge.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/mcp-remote.js'),'--url',url.href,'--token-file',tokenFiles.get('account-two')!],stderr:'pipe'}));
  assert.equal((await call(bridge,'memory_get',{nodeId:saved.id})).id,saved.id);
  assert((await bridge.listResources()).resources.some(r=>r.uri==='mindpond://protocol/rules'));
  const policy=await bridge.readResource({uri:'mindpond://protocol/rules'});assert(policy.contents.length);
  for(const client of ['codex','claude','opencode'] as const){
    const bundle=path.join(dir,'bundle-'+client);
    await prepareClientBundle({client,directory:bundle,mcpPath:path.resolve('dist/mcp-remote.js'),remoteUrl:url.href,tokenFile:tokenFiles.get('account-two')!});
    const manifest=await readClientBundle(bundle);
    assert(!JSON.stringify(manifest).includes(tokens.get('account-two')!),'bundles contain paths, never bearer values');
    assert(!JSON.stringify(manifest).includes('MEMORY_DB_PATH'),'remote host does not open local storage');
    if(client==='opencode'){const c=JSON.parse(await fs.readFile(path.join(bundle,'opencode.json'),'utf8'));assert(c.mcp.mindpond.enabled);assert(!c.plugin);}
  }
  if(process.env.MINDPOND_TEST_OPENCODE_BIN){
    const launch=await clientLaunch(path.join(dir,'bundle-opencode'),['--pure','mcp','list']);
    const checked=await promisify(execFile)(process.env.MINDPOND_TEST_OPENCODE_BIN,launch.args,{cwd:dir,timeout:45000,maxBuffer:1000000,env:{...launch.env,XDG_CONFIG_HOME:path.join(dir,'config'),XDG_DATA_HOME:path.join(dir,'client-data'),XDG_CACHE_HOME:path.join(dir,'cache')}});
    assert.match(checked.stdout+'\n'+checked.stderr,/mindpond[\s\S]*connected/i);
    assert.doesNotMatch(checked.stdout+'\n'+checked.stderr,/disconnected|failed/i);
    console.log('PASS actual OpenCode CLI connects its generated remote bundle through the stdio bridge (no model run)');
  }else console.log('NOT_RUN actual remote OpenCode CLI: set MINDPOND_TEST_OPENCODE_BIN');
  const rotated=path.join(dir,'rotated.token');
  await issueNetworkGrant({configFile,tokenFile:rotated,principal:'account-one',personalId:'default',rotate:true});
  const revoked=await fetch(url,{method:'POST',headers:{...headers('account-one'),Host:`127.0.0.1:${port}`,'Content-Type':'application/json'},body:'{}'});
  assert.equal(revoked.status,401,'revocation takes effect without restarting');
  tokens.set('account-one',(await fs.readFile(rotated,'utf8')).trim());
  const replacement=await connect('account-one','project-conversation');
  assert.equal((await call(replacement.client,'memory_get',{nodeId:durableSession.id})).id,durableSession.id,'rotation preserves the account session and releases obsolete transport slots');
  console.log('PASS separate-process stdio bridge, three remote bundles, no local DB/model/token exposure and hot credential rotation');
} finally {
  await Promise.allSettled(clients.map(c=>c.close()));
  if(network)await network.close(listener);
  await graph.close();embedding.generateEmbedding=oldGenerate;
  await fs.rm(dir,{recursive:true,force:true});
}

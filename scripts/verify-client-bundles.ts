import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareClientBundle, readClientBundle, removeClientBundle, clientLaunch } from '../src/integrations/client-bundle.js';
const exec=promisify(execFile),root=fileURLToPath(new URL('..',import.meta.url));
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-clients-'));
const clients:Client[]=[];
async function connect(env:Record<string,string>) {
  const client=new Client({name:'isolated-contract-host',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/mcp.js')],env:{...process.env,...env,EMBEDDING_ZH_ENABLED:'false',EMBEDDING_MODEL_DIR:path.join(temp,'missing-model')} as Record<string,string>,stderr:'pipe'}));
  clients.push(client);assert.match(client.getInstructions()??'',/memory_protocol_rules/);
  return client;
}
async function call(client:Client,name:string,args:Record<string,unknown>={}) {
  const res=await client.callTool({name,arguments:args});assert(!res.isError,JSON.stringify(res));
  return JSON.parse((res.content as any[]).find(c=>c.type==='text').text);
}
try {
  const embeddingConfigPath=path.join(temp,'embedding-config.json'),modelDirectory=path.join(temp,'missing-model');await fs.writeFile(embeddingConfigPath,'{}');
  const bundles=[];
  for(const client of ['codex','claude','opencode'] as const) {
    const directory=path.join(temp,client+' bundle');
    const options={client,directory,embeddingConfigPath,modelDirectory,toolProfile:'full' as const,dbPath:path.join(temp,'shared.db'),sessionId:'session-'+client,name:'mindpond_verify',mcpPath:path.join(root,'dist/mcp.js')};
    const bundle=await prepareClientBundle(options);bundles.push(bundle);
    assert((await prepareClientBundle(options)).replayed);
    await assert.rejects(prepareClientBundle({...options,sessionId:'changed'}),/differs/);
    assert.equal((await readClientBundle(directory)).client,client);
  }
  // Exercise the actual installed CLI config parser without starting any model.
  const codexLaunch=await clientLaunch(bundles[0].directory,['mcp','get','mindpond_verify','--json']);
  const codex=await exec(codexLaunch.command,codexLaunch.args,{cwd:temp,env:codexLaunch.env,timeout:20000});
  const parsed=JSON.parse(codex.stdout);assert.equal(parsed.name,'mindpond_verify');
  assert.equal(parsed.transport.env.MINDPOND_EMBEDDING_CONFIG,embeddingConfigPath);assert.equal(parsed.transport.env.EMBEDDING_MODEL_DIR,modelDirectory);
  console.log('PASS installed Codex CLI consumes generated MCP configuration (no model run)');
  await fs.copyFile(path.join(bundles[1].directory,'mcp.json'),path.join(temp,'.mcp.json'));
  const claude=await exec('claude',['mcp','get','mindpond_verify'],{cwd:temp,timeout:30000,maxBuffer:1000000});
  assert.match(claude.stdout,/mindpond_verify/);
  if (/Connected/i.test(claude.stdout)) {
    console.log('PASS installed Claude CLI loads generated project config and connects to MindPond');
  } else if (/Pending approval/i.test(claude.stdout)) {
    console.log('PASS installed Claude CLI recognizes generated project config; live connection awaits user approval');
  } else {
    assert.fail('Claude CLI did not connect or report its expected project-config approval gate: ' + claude.stdout);
  }
  const existing={mcp:{other:{type:'local',command:['other']}},instructions:['existing.md'],theme:'system'};
  const openLaunch=await clientLaunch(bundles[2].directory,[],{OPENCODE_CONFIG_CONTENT:JSON.stringify(existing)});
  const merged=JSON.parse(openLaunch.env.OPENCODE_CONFIG_CONTENT!);assert.deepEqual(merged.mcp.other,existing.mcp.other);assert.deepEqual(merged.instructions,['existing.md',path.join(bundles[2].directory,'instructions.md')]);
  await assert.rejects(clientLaunch(bundles[2].directory,[],{OPENCODE_CONFIG_CONTENT:JSON.stringify({mcp:{mindpond_verify:{}}})}),/already declares/);
  console.log('PASS OpenCode documented config format and additive merge');
  if(process.env.MINDPOND_TEST_OPENCODE_BIN) {
    const launch=await clientLaunch(bundles[2].directory,['--pure','mcp','list']);
    const checked=await exec(process.env.MINDPOND_TEST_OPENCODE_BIN,launch.args,{cwd:temp,timeout:45000,maxBuffer:1000000,
      env:{...launch.env,XDG_CONFIG_HOME:path.join(temp,'config'),XDG_DATA_HOME:path.join(temp,'data'),XDG_CACHE_HOME:path.join(temp,'cache'),
        EMBEDDING_ZH_ENABLED:'false',EMBEDDING_MODEL_DIR:path.join(temp,'missing-model')}});
    const output=checked.stdout+'\n'+checked.stderr;
    assert.match(output,/mindpond_verify/);assert.match(output,/connected/i);
    assert.doesNotMatch(output,/disconnected|failed/i);
    console.log('PASS actual OpenCode CLI loads inline configuration and connects to MindPond (no model run)');
    const work=await prepareClientBundle({client:'opencode',directory:path.join(temp,'opencode-work'),dbPath:path.join(temp,'work.db'),personalId:'work',sessionId:'review-work',name:'mindpond_work',mcpPath:path.join(root,'dist/mcp.js')});
    const workLaunch=await clientLaunch(work.directory,['--pure','mcp','list']);
    const workConfig=JSON.parse(workLaunch.env.OPENCODE_CONFIG_CONTENT!);
    assert.equal(workConfig.mcp.mindpond_work.environment.MINDPOND_TOOL_PROFILE,'work');
    assert.equal(workConfig.mcp.mindpond_work.timeout,15000);
    const workChecked=await exec(process.env.MINDPOND_TEST_OPENCODE_BIN,workLaunch.args,{cwd:temp,timeout:45000,maxBuffer:1000000,env:{...workLaunch.env,XDG_CONFIG_HOME:path.join(temp,'config'),XDG_DATA_HOME:path.join(temp,'data'),XDG_CACHE_HOME:path.join(temp,'cache'),EMBEDDING_ZH_ENABLED:'false',EMBEDDING_MODEL_DIR:path.join(temp,'missing-model')}});
    assert.match(workChecked.stdout+'\n'+workChecked.stderr,/mindpond_work[\s\S]*connected/i);
    console.log('PASS actual OpenCode CLI connects default work profile to a separate workplace DB');

  } else console.log('NOT_RUN actual OpenCode CLI: set MINDPOND_TEST_OPENCODE_BIN to the installed executable');
  const envs=await Promise.all(bundles.map(async b=>{
    if(b.manifest.client==='codex')return parsed.transport.env;
    if(b.manifest.client==='claude')return JSON.parse(await fs.readFile(path.join(b.directory,'mcp.json'),'utf8')).mcpServers.mindpond_verify.env;
    return JSON.parse(await fs.readFile(path.join(b.directory,'opencode.json'),'utf8')).mcp.mindpond_verify.environment;
  }));
  for(const env of envs){assert.equal(env.MINDPOND_EMBEDDING_CONFIG,embeddingConfigPath);assert.equal(env.EMBEDDING_MODEL_DIR,modelDirectory);}
  console.log('PASS model configuration and local model directory propagate through all three client bundles');
  // Each real transport gets a distinct host/session; the shared personal library survives switching hosts.
  const a=await connect({...envs[0],MEMORY_TRUST_SESSION:'session-codex'});
  const scope={spaceId:'fixture/local-proxy',memoryType:'fact'};
  const saved=await call(a,'memory_save',{content:'The local proxy listens on localhost. Production deployment is unverified.',domain:{kind:'personal',id:'default'},memberships:[scope],idempotencyKey:'shared-observation'});
  await call(a,'memory_save',{content:'Local proxy configuration changes require updating the development launcher.',domain:{kind:'personal',id:'default'},memberships:[scope]});
  await call(a,'memory_save',{content:'PRIVATE-SESSION-CODEX',memberships:[scope]});
  await a.close();
  const b=await connect(envs[1]);
  const request=await call(b,'memory_organization_request_start',{...scope,idempotencyKey:'shared-review'});
  const next=await call(b,'memory_organization_request_next',{requestId:request.requestId});assert(next.job);
  await call(b,'memory_organization_validate',{jobId:next.job.id,plan:{operations:[]}});
  await call(b,'memory_organization_commit',{jobId:next.job.id,plan:{operations:[]}});
  await call(b,'memory_organization_request_report',{requestId:request.requestId,jobId:next.job.id,result:'no_change'});
  await b.close();
  const c=await connect(envs[2]);
  const recalled=await call(c,'memory_search',{query:'local proxy',...scope,minScore:0});
  assert(recalled.results.some((n:any)=>n.id===saved.id&&n.content.includes('unverified')));
  assert(!JSON.stringify(recalled).includes('PRIVATE-SESSION-CODEX'));
  const denied=await connect({...envs[2],MEMORY_TRUST_DOMAINS:'[]',MEMORY_TRUST_SESSION:''});
  assert.equal((await denied.callTool({name:'memory_search',arguments:{query:'local proxy'}})).isError,true,'explicit empty MCP binding must not disable trust');
  console.log('PASS three config transports share personal save → organization → recall; session stays private, empty grants deny');
  const directory=bundles[0].directory;
  await fs.writeFile(path.join(directory,'unrelated.txt'),'preserve me');
  const original=await fs.readFile(path.join(directory,'instructions.md'),'utf8');
  await fs.appendFile(path.join(directory,'instructions.md'),'user edit');
  await assert.rejects(removeClientBundle(directory),/changed/);
  assert(await fs.stat(path.join(directory,'config.toml')));
  await fs.writeFile(path.join(directory,'instructions.md'),original);
  assert.equal((await removeClientBundle(directory)).databaseRemoved,false);
  assert.equal(await fs.readFile(path.join(directory,'unrelated.txt'),'utf8'),'preserve me');
  assert(await fs.stat(path.join(temp,'shared.db')));
  console.log('PASS bundle removal preserves database/unrelated files and refuses modified managed files');
} finally {for(const c of clients)await c.close();await fs.rm(temp,{recursive:true,force:true});}

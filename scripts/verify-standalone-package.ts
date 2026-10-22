/** Real tarball install in a clean directory; no parent node_modules symlinks. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import {createServer as createPortProbe} from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-package-'));
const children: ChildProcess[] = [];
const env = { ...process.env, MEMORY_DB_PATH: '', NODE_PATH: '', MINDPOND_LOCAL_INFERENCE_ROOT:'',MINDPOND_EMBEDDING_MODE:'auto', MINDPOND_DATA_DIR: path.join(temp, 'data'),
  npm_config_registry: 'https://registry.npmjs.org',
  ONNXRUNTIME_NODE_INSTALL: process.env.ONNXRUNTIME_NODE_INSTALL ?? 'skip',
  EMBEDDING_MODEL_DIR: path.join(temp, 'missing-models'), EMBEDDING_ZH_ENABLED: 'false',
  MEMORY_PORT: '0', MEMORY_HOST: '127.0.0.1', MEMORY_API_KEY: '', MEMORY_CONTEXT_SECRET: '', MEMORY_OPERATOR_KEY: '',
  MEMORY_TRUST_PRINCIPAL: 'package-test', MEMORY_TRUST_DOMAINS: '[{"kind":"personal","id":"default"}]',
  MEMORY_TRUST_SESSION: 'package-session', MEMORY_TRUST_OPERATOR: '',
};
try {
  const packed = await exec('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root, maxBuffer: 4_000_000 });
  const manifest = JSON.parse(packed.stdout)[0];
  const names: string[] = manifest.files.map((f: any) => f.path);
  for(const asset of ['web/collaboration.html','web/office.js','web/office-scene.js','web/office.css','web/office-guide.html'])assert(names.includes(asset),`Installed workbench must include ${asset}`);
  assert.ok(names.includes('dist/server.js') && names.includes('dist/mcp.js') && names.includes('dist/connect.js') && names.includes('dist/models.js'));
  assert.ok(names.includes('dist/mcp-http.js')&&names.includes('dist/mcp-remote.js'));
  assert.ok(names.includes('npm-shrinkwrap.json'),'Published package must retain audited transitive pins');
  assert.ok(names.includes('examples/minimal-host/run.mjs'));
  assert.ok(names.includes('LICENSE')&&names.includes('THIRD_PARTY_NOTICES.md')&&names.includes('licenses/dependencies.txt'));
  assert.ok(names.every(n => !/^(data|logs|models|src|node_modules)\//.test(n) && !/\.db(?:\.|$)/.test(n) && n !== '.env'));
  await fs.writeFile(path.join(temp, 'package.json'), '{"private":true,"type":"module"}\n');
  // Cached dependencies are an optimization only. This remains a real npm install.
  await exec('npm', ['install', path.join(temp, manifest.filename), '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'],
    { cwd: temp, env, timeout: 180000, maxBuffer: 4_000_000 });
  const installed = path.join(temp, 'node_modules', 'mindpond');
  // npm ignores dependency-authored overrides. Prove the published shrinkwrap
  // keeps patched versions in the installed consumer, not just in this repo.
  const installedTree=JSON.parse((await exec('npm',['ls','--all','--json'],{cwd:temp,env,maxBuffer:8_000_000})).stdout);
  const versions:Record<string,string[]>= {};
  const visit=(node:any)=>{for(const [name,child] of Object.entries(node.dependencies??{}) as Array<[string,any]>){if(child.version)(versions[name]??=[]).push(child.version);visit(child);}};
  visit(installedTree);
  const policy=JSON.parse(await fs.readFile(path.join(root,'licenses/policy.json'),'utf8'));
  for(const name of Object.keys(versions))assert(!policy.baseForbiddenPackagePrefixes.some((prefix:string)=>name.startsWith(prefix)),'Default installation pulled heavyweight optional inference: '+name);
  assert(!versions.protobufjs?.some(v=>Number(v.split('.')[0])<7),'Consumer resolved vulnerable protobufjs v6');
  assert(!versions.sharp||versions.sharp.every(v=>Number(v.split('.')[1])>=35),'Consumer resolved legacy sharp');
  assert(versions.tar?.every(v=>Number(v.split('.')[0])>=7),'Consumer resolved vulnerable tar v6');
  let consumerAudit:any;
  for(let attempt=0;attempt<3;attempt++){
    try{consumerAudit=JSON.parse((await exec('npm',['audit','--omit=dev','--json','--registry=https://registry.npmjs.org'],{cwd:temp,env,timeout:60000,maxBuffer:4_000_000})).stdout);break;}
    catch(error){
      const failed=error as {stdout?:string};let report:any;
      try{report=JSON.parse(failed.stdout??'{}');}catch{}
      // Retry only a failed network/audit endpoint, never a real vulnerability.
      if(report?.metadata?.vulnerabilities||attempt===2)throw error;
      await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
    }
  }
  assert.equal(consumerAudit.metadata.vulnerabilities.total,0,'The clean consumer dependency tree must pass audit too');
  console.log('PASS installed consumer dependency versions and official production audit (0 findings)');
  assert.equal((await fs.lstat(installed)).isSymbolicLink(), false);
  const networkConfig=path.join(temp,'central.accounts.json'),networkToken=path.join(temp,'account.token');
  await exec(path.join(temp,'node_modules/.bin/mindpond-mcp-http'),['grant','--config',networkConfig,'--principal','package-account','--agent','package-host','--db',path.join(temp,'network.db'),'--token-file',networkToken],{cwd:temp,env,timeout:10000});
  const probe=createPortProbe();probe.listen(0,'127.0.0.1');await new Promise<void>(resolve=>probe.once('listening',resolve));
  const networkPort=(probe.address() as import('node:net').AddressInfo).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const central=spawn(path.join(temp,'node_modules/.bin/mindpond-mcp-http'),['serve','--config',networkConfig,'--db',path.join(temp,'network.db'),'--port',String(networkPort)],{cwd:temp,env,stdio:['ignore','pipe','pipe']});children.push(central);
  let centralOutput='';central.stdout!.on('data',v=>centralOutput+=v);central.stderr!.on('data',v=>centralOutput+=v);
  const centralDeadline=Date.now()+15000;
  while(!centralOutput.includes('[mindpond-mcp-http] listening')&&Date.now()<centralDeadline&&central.exitCode===null)await new Promise(resolve=>setTimeout(resolve,50));
  assert(centralOutput.includes('[mindpond-mcp-http] listening'),centralOutput);
  const seedNetwork=`import {MindPond} from 'mindpond';import {createHash} from 'node:crypto';const m=new MindPond({dbPath:${JSON.stringify(path.join(temp,'network.db'))}});await m.init();const admin={v:1,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};const actor={...admin,operator:false,principal:'package-account',agentId:'package-host',runtimeId:createHash('sha256').update(JSON.stringify(['package-account','package-host','codex','package-thread'])).digest('hex'),transport:'http-mcp'};const a=await m.graph.roles.application({action:'submit',name:'Package role',introduction:'Fictional',reason:'Install test',key:'apply'},actor);await m.graph.roles.review({action:'approve',applicationId:a.applicationId,expectedRevision:1},admin);await m.close();`;
  await fs.writeFile(path.join(temp,'seed-network.mjs'),seedNetwork);await exec(process.execPath,[path.join(temp,'seed-network.mjs')],{cwd:temp,env,timeout:20000});
  const remoteClient=new Client({name:'package-network',version:'1'});
  try {
    await remoteClient.connect(new StdioClientTransport({command:path.join(temp,'node_modules/.bin/mindpond-mcp-remote'),args:['--url',`http://127.0.0.1:${networkPort}/memory/mcp`,'--token-file',networkToken],env,stderr:'pipe'}));
    const denied=await remoteClient.callTool({name:'memory_identity',arguments:{}});assert(denied.isError);
    const identity:any=await remoteClient.callTool({name:'memory_identity',arguments:{},_meta:{threadId:'package-thread'}});assert(!identity.isError);assert.equal(JSON.parse(identity.content[0].text).identity.protocol,'mindpond.layered-memory.v2');
    const remoteSave=await remoteClient.callTool({name:'memory_save',arguments:{content:'Installed network entry writes to the approved role.',idempotencyKey:'package-network'},_meta:{threadId:'package-thread'}});
    assert(!remoteSave.isError);assert((await fs.stat(path.join(temp,'network.db'))).isFile());
  }finally{await remoteClient.close();}
  console.log('PASS installed host grant, central HTTP and stdio bridge preserve native role identity; missing identity denied');
  const pkg = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies.zod, '4.5.4');assert(!pkg.dependencies['@huggingface/transformers']);assert(pkg.peerDependenciesMeta['@huggingface/transformers'].optional);
  const {stdout:deviceOutput}=await exec(path.join(temp,'node_modules/.bin/mindpond-models'),['devices'],{cwd:temp,env,timeout:15000});
  const devices=JSON.parse(deviceOutput);assert.equal(devices.localInference.installed,false);assert.deepEqual(devices.backends,[]);
  async function installedBytes(directory:string):Promise<number>{let sum=0;for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())sum+=await installedBytes(file);else if(entry.isFile())sum+=(await fs.stat(file)).size;}return sum;}
  console.log(JSON.stringify({baseInstalledPackages:Object.keys(versions).length,nodeModulesBytes:await installedBytes(path.join(temp,'node_modules')),scope:'clean default runtime on this platform; excludes Node.js, model files and development tools'}));
  console.log('PASS base consumer omits Transformers/ONNX/Sharp/libvips; absent optional backend is explicit, collaboration and text search work');
  for (const format of ['json', 'text']) {
    const modelStatusOutput=(await exec(path.join(temp,'node_modules/.bin/mindpond-models'),['status'],{
      cwd:temp,env:{...env,LOG_FORMAT:format,MINDPOND_LOG_STDERR:'0'},timeout:15000,
    })).stdout;
    const modelStatus=JSON.parse(modelStatusOutput);
    assert.equal(modelStatus.activeProfile,'legacy');assert(modelStatus.presets.length>=6);
  }
  console.log('PASS installed model status keeps stdout valid JSON in both log formats');
  const connectBin=path.join(temp,'node_modules/.bin/mindpond-connect');
  const bundleDir=path.join(temp,'client-bundle');
  await exec(connectBin,['prepare','--client','claude','--directory',bundleDir,'--db',path.join(temp,'data','mindpond.db')],{cwd:temp,env,timeout:10000});
  const bundle=JSON.parse((await exec(connectBin,['inspect','--directory',bundleDir],{cwd:temp,env,timeout:10000})).stdout);
  assert.equal(bundle.client,'claude');
  const connection=JSON.parse(await fs.readFile(path.join(bundleDir,'mcp.json'),'utf8'));
  assert.equal(connection.mcpServers.mindpond.args[0],path.join(installed,'dist/mcp.js'),'installed connector resolves its own MCP entry');
  await exec(connectBin,['run','--directory',bundleDir,'--dry-run'],{cwd:temp,env,timeout:10000});
  await exec(connectBin,['remove','--directory',bundleDir],{cwd:temp,env,timeout:10000});
  console.log('PASS installed connection executable prepare/inspect/dry-run/remove without a client or model');
  const smoke = await exec(process.execPath, [path.join(installed, 'examples/minimal-host/run.mjs'), '--smoke'],
    { cwd: temp, env, timeout: 30000, maxBuffer: 4_000_000 });
  assert.match(smoke.stdout, /"state":"unavailable"/, 'missing model must expose degraded state');
  assert.match(smoke.stdout, /"status":"completed"/);
  console.log('PASS clean npm tarball install: package-only save/preview/search/organize, missing-model text fallback');

  // Bin launcher and hoisted vis-network assets are checked from the installed tree.
  const server = spawn(path.join(temp, 'node_modules/.bin/mindpond-server'), [], { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(server);
  let output = '';
  server.stdout!.on('data', chunk => { output += chunk; });
  server.stderr!.on('data', chunk => { output += chunk; });
  const start = Date.now();
  while (!/listening on .*:(\d+)/.test(output) && Date.now() - start < 15000 && server.exitCode === null)
    await new Promise(resolve => setTimeout(resolve, 50));
  const port = /listening on .*:(\d+)/.exec(output)?.[1];
  assert.ok(port, output.slice(-3000));
  const dimensionResponse=await fetch(`http://127.0.0.1:${port}/api/memory/dimensions`);
  assert.equal(dimensionResponse.status,200);
  const {configuration}=await dimensionResponse.json() as any;
  assert.equal(configuration.defaultDimension,'work');
  assert.deepEqual(configuration.definitions.slice(0,5).map((d:any)=>d.id),['profile','commitment','environment','work','practice']);
  assert(configuration.definitions.every((d:any)=>!d.label.includes('兼容')));
  for (const route of ['/', '/health', '/vendor/vis-network.min.js', '/licenses/third-party.txt']) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, route);
    if (route.includes('vendor')) assert.match(response.headers.get('content-type')!, /javascript/);
    await response.arrayBuffer();
  }
  assert.ok((await fs.stat(path.join(temp, 'data', 'mindpond.db'))).isFile());
  await assert.rejects(fs.access(path.join(installed, 'data')));
  console.log('PASS installed HTTP executable, user data directory and hoisted graph assets');

  // Use the real installed MCP SDK client, not a repository import.
  const mcpScript = `
    import assert from 'node:assert/strict';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
    import { MindPond, retrievalStatus } from 'mindpond';
    assert.equal(retrievalStatus().primary.reason,'local_runtime_not_installed');
    assert.equal(retrievalStatus().localInference.installed,false);
    const optional = new MindPond({dbPath:${JSON.stringify(path.join(temp,'data','optional-profile.db'))},retrieval:{profiles:[{profile:{id:'fixture',label:'Public fixture',model:'fixture/model',dimensions:3}}]},retrievalDependencies:{artifactDigest:async()=> 'public-fixture-digest',encoder:()=>({encode:async()=>({vectors:[[1,0,0]],device:'cpu'}),close:async()=>{},status:()=>({actualDevice:'cpu'})})}});
    await optional.init();try{await optional.save('Public optional model fallback fixture');await optional.buildRetrievalProfile('fixture');const recalled=await optional.recall('Public fixture',{retrievalProfile:'fixture',vectorAlgorithm:'hnsw'});assert.equal(recalled.retrieval.profile.algorithm.actual,'exact');assert.equal(recalled.retrieval.profile.algorithm.fallbackReason,'hnsw_unavailable');assert(recalled.results.length>0);}finally{await optional.close();}
    console.log('PASS installed model profile works without the optional native HNSW plugin');
    const seed = new MindPond({dbPath: ${JSON.stringify(path.join(temp, 'data', 'mindpond.db'))}});
    await seed.init();const human=await seed.save('Human knowledge unavailable without native chat identity');await seed.close();
    const client=new Client({name:'installed-role-memory',version:'1'});
    await client.connect(new StdioClientTransport({command:${JSON.stringify(path.join(temp,'node_modules/.bin/mindpond-mcp'))},args:[],env:{...process.env,MINDPOND_TOOL_PROFILE:'full',MEMORY_TRUST_OPERATOR:'1'}}));
    try{
      const tools=(await client.listTools()).tools;assert(tools.every(t=>t.name.startsWith('memory_')));assert(!tools.some(t=>t.name==='memory_organization_commit'||t.name==='memory_save_validate'));
      const identity=await client.callTool({name:'memory_identity',arguments:{}});assert(identity.isError);assert.equal(JSON.parse(identity.content[0].text).error.code,'identity_required');
      const denied=await client.callTool({name:'memory_save',arguments:{content:'Must not fall back to human',idempotencyKey:'deny'}});assert(denied.isError);
      assert((await client.callTool({name:'memory_get',arguments:{nodeId:human.id}})).isError);
    }finally{await client.close();}
    console.log('PASS installed stdio denies missing chat identity and full-profile bypass');
  `;
  await fs.writeFile(path.join(temp, 'mcp-smoke.mjs'), mcpScript);
  const mcp = await exec(process.execPath, [path.join(temp, 'mcp-smoke.mjs')], { cwd: temp, env, timeout: 20000, maxBuffer: 1_000_000 });
  console.log(mcp.stdout.trim());
  console.log(JSON.stringify({ node: process.version, package: pkg.version, integrity: manifest.integrity, files: names.length,
    scope: 'real package installation, synthetic model; no live-client or semantic-quality claim' }));
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
  await fs.rm(temp, { recursive: true, force: true });
}

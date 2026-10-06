/** Client-specific connection glue only. No user config replacement or model credentials. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { MEMORY_BOOTSTRAP } from '../core/bootstrap.js';
import { parseMcpToolProfile, type McpToolProfile } from '../core/mcp-tool-profile.js';
import { MindPondError } from '../core/errors.js';

export type MemoryClient = 'codex' | 'claude' | 'opencode';
export interface ClientBundleOptions {
  client: MemoryClient; directory: string; dbPath?: string; sessionId?: string;
  remoteUrl?:string;tokenFile?:string;allowHttp?:boolean;
  personalId?: string; name?: string; embeddingConfigPath?:string;modelDirectory?:string; nodePath?: string; mcpPath?: string; toolProfile?: McpToolProfile; nativeAdapter?:boolean; capturePublicMessages?:boolean;
}
interface BundleManifest {
  version: 'mindpond.connection.v1'; client: MemoryClient; name: string;
  sessionId?: string; files: Record<string,string>;
  launch: {command:string; args:string[]; env:Record<string,string>};
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const conflict=(s:string)=>new MindPondError('invalid_input',s,{nextAction:'Use a new bundle directory or resolve the modified managed file; existing client configuration is never overwritten.'});
const filenames=new Set(['config.toml','mcp.json','opencode.json','instructions.md','mindpond-plugin.mjs']);
const json=(v:unknown)=>JSON.stringify(v,null,2)+'\n';
function absolute(p:string,label:string) { if(typeof p!=='string'||!path.isAbsolute(p))throw conflict(label+' must be absolute'); return path.normalize(p); }
function toml(v:unknown):string {
  if(typeof v==='string'||typeof v==='number'||typeof v==='boolean')return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(toml).join(', ')+']';
  return '{ '+Object.entries(v as object).map(([k,x])=>`${JSON.stringify(k)} = ${toml(x)}`).join(', ')+' }';
}
export async function prepareClientBundle(options:ClientBundleOptions) {
  if(!['codex','claude','opencode'].includes(options.client))throw conflict('Unsupported client');
  const directory=absolute(options.directory,'directory'), remote=!!options.remoteUrl;
  const dbPath=remote?'':absolute(options.dbPath!,'dbPath');
  if(remote&&(options.dbPath||options.personalId||options.nativeAdapter||options.embeddingConfigPath||options.modelDirectory))throw conflict('Remote connection identities, database and model are controlled by the central server');
  if(remote){const url=new URL(options.remoteUrl!);if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol))throw conflict('Invalid remote endpoint');const token=absolute(options.tokenFile!,'tokenFile');if(token===directory||token.startsWith(directory+path.sep))throw conflict('Keep credentials outside the removable bundle');}
  if(dbPath===directory||dbPath.startsWith(directory+path.sep))throw conflict('Keep the database outside the removable connection bundle');
  const name=options.name??'mindpond';
  if(!/^[a-z][a-z0-9_-]{0,63}$/.test(name))throw conflict('name must be a simple lowercase MCP identifier');
  for(const [key,value] of Object.entries({sessionId:options.sessionId,personalId:options.personalId}))
    if(value!==undefined&&(!value.trim()||value.length>256||value!==value.trim()))throw conflict(key+' requires 1–256 characters without surrounding whitespace');
  if(remote&&options.sessionId&&!/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,127}$/u.test(options.sessionId))throw conflict('Remote session requires a stable host label of 1–128 characters');
  const toolProfile = parseMcpToolProfile(options.toolProfile ?? 'work');
  const localEnv={MINDPOND_TOOL_PROFILE:toolProfile,MEMORY_DB_PATH:dbPath,MEMORY_TRUST_PRINCIPAL:`${options.client}/local`,
    MEMORY_TRUST_DOMAINS:JSON.stringify([{kind:'personal',id:options.personalId??'default'}]),
    ...(options.embeddingConfigPath?{MINDPOND_EMBEDDING_CONFIG:absolute(options.embeddingConfigPath,'embeddingConfigPath')}:{}),
    ...(options.modelDirectory?{EMBEDDING_MODEL_DIR:absolute(options.modelDirectory,'modelDirectory')}:{}),
    MEMORY_TRUST_SESSION:options.sessionId??'',MEMORY_TRUST_OPERATOR:'0'};
  const env=remote?{MINDPOND_REMOTE_URL:options.remoteUrl!,MINDPOND_REMOTE_TOKEN_FILE:absolute(options.tokenFile!,'tokenFile'),...(options.sessionId?{MINDPOND_REMOTE_SESSION:options.sessionId}:{})}:localEnv;
  const server={command:absolute(options.nodePath??process.execPath,'nodePath'),
    args:remote?[absolute(options.mcpPath??fileURLToPath(new URL('../mcp-remote.js',import.meta.url)),'mcpPath'),...(options.allowHttp?['--allow-http']:[])]:[absolute(options.mcpPath??fileURLToPath(new URL('../mcp.js',import.meta.url)),'mcpPath')],env};
  await fs.access(server.args[0]);
  const files:Record<string,string>={'instructions.md':MEMORY_BOOTSTRAP+'\n'};
  let launch:BundleManifest['launch'];
  if(options.client==='codex') {
    files['config.toml']=`[mcp_servers.${name}]\ncommand = ${toml(server.command)}\nargs = ${toml(server.args)}\nenv = ${toml(env)}\n`;
    launch={command:'codex',args:['-c',`mcp_servers.${name}=${toml(server)}`],env:{}};
  } else if(options.client==='claude') {
    files['mcp.json']=json({mcpServers:{[name]:{type:'stdio',...server}}});
    launch={command:'claude',args:['--mcp-config',path.join(directory,'mcp.json'),'--append-system-prompt',MEMORY_BOOTSTRAP],env:{}};
  } else {
    const native=!remote&&(options.nativeAdapter??(!options.sessionId));
    if(native){
      const pluginPath=path.join(path.dirname(server.args[0]),'integrations','opencode-plugin.js');
      await fs.access(pluginPath);
      files['mindpond-plugin.mjs']=`import { createOpenCodeMemoryPlugin } from ${JSON.stringify(pathToFileURL(pluginPath).href)};\nexport default (host)=>createOpenCodeMemoryPlugin(host,${JSON.stringify({dbPath,personalId:options.personalId??'default',nodePath:server.command,capturePublicMessages:options.capturePublicMessages??true,...(options.embeddingConfigPath?{embeddingConfigPath:absolute(options.embeddingConfigPath,'embeddingConfigPath')}:{}),...(options.modelDirectory?{modelDirectory:absolute(options.modelDirectory,'modelDirectory')}: {})})});\n`;
    }
    const config={...(native?{plugin:[pathToFileURL(path.join(directory,'mindpond-plugin.mjs')).href]}:{}),mcp:{[name]:{type:'local',command:[server.command,...server.args],environment:env,enabled:!native,timeout:15000}},instructions:[path.join(directory,'instructions.md')]};
    files['opencode.json']=json(config);
    launch={command:'opencode',args:[],env:{OPENCODE_CONFIG_CONTENT:JSON.stringify(config)}};
  }
  const manifest:BundleManifest={version:'mindpond.connection.v1',client:options.client,name,...(options.sessionId?{sessionId:options.sessionId}:{}),files:Object.fromEntries(Object.entries(files).map(([n,s])=>[n,hash(s)])),launch};
  // Idempotent prepare reuses only exact bytes; no overwrite/update of owned or unrelated content.
  await fs.mkdir(path.dirname(directory),{recursive:true});
  try { await fs.mkdir(directory,{recursive:false,mode:0o700}); }
  catch(error:any) {
    if(error.code!=='EEXIST')throw error;
    const existing=await readClientBundle(directory);
    if(json(existing)!==json(manifest))throw conflict('Connection bundle differs from the requested configuration');
    return {directory,manifest,replayed:true};
  }
  for(const [name,content] of Object.entries(files))await fs.writeFile(path.join(directory,name),content,{flag:'wx',mode:0o600});
  await fs.writeFile(path.join(directory,'manifest.json'),json(manifest),{flag:'wx',mode:0o600});
  return {directory,manifest,replayed:false};
}
export async function readClientBundle(directory:string):Promise<BundleManifest> {
  absolute(directory,'directory');
  if(!(await fs.lstat(directory)).isDirectory())throw conflict('Bundle root must be a real directory');
  const mpath=path.join(directory,'manifest.json');
  if(!(await fs.lstat(mpath)).isFile())throw conflict('Manifest must be a regular file');
  const m=JSON.parse(await fs.readFile(mpath,'utf8')) as BundleManifest;
  if(m.version!=='mindpond.connection.v1'||!['codex','claude','opencode'].includes(m.client)||!m.files||!m.launch)throw conflict('Invalid connection manifest');
  for(const [name,digest] of Object.entries(m.files)) {
    if(!filenames.has(name))throw conflict('Unexpected managed file name');
    const file=path.join(directory,name);
    if(!(await fs.lstat(file)).isFile()||hash(await fs.readFile(file,'utf8'))!==digest)throw conflict('Managed file changed: '+name);
  }
  return m;
}
export async function removeClientBundle(directory:string) {
  const m=await readClientBundle(directory);
  for(const name of Object.keys(m.files))await fs.unlink(path.join(directory,name));
  await fs.unlink(path.join(directory,'manifest.json'));
  try {await fs.rmdir(directory);}catch(error:any){if(error.code!=='ENOTEMPTY')throw error;}
  return {removed:Object.keys(m.files),databaseRemoved:false,clientConfigurationChanged:false};
}
export async function clientLaunch(directory:string,extraArgs:string[]=[],environment:NodeJS.ProcessEnv=process.env) {
  const m=await readClientBundle(directory);
  const env={...environment,...m.launch.env};
  if(m.client==='opencode'&&environment.OPENCODE_CONFIG_CONTENT) {
    const current=JSON.parse(environment.OPENCODE_CONFIG_CONTENT), addition=JSON.parse(m.launch.env.OPENCODE_CONFIG_CONTENT);
    if(current.mcp?.[m.name])throw conflict('OPENCODE_CONFIG_CONTENT already declares this MCP name');
    env.OPENCODE_CONFIG_CONTENT=JSON.stringify({...current,mcp:{...current.mcp,...addition.mcp},instructions:[...new Set([...(current.instructions??[]),...addition.instructions])],plugin:[...new Set([...(current.plugin??[]),...(addition.plugin??[])])]});
  }
  return {command:m.launch.command,args:[...m.launch.args,...extraArgs],env};
}

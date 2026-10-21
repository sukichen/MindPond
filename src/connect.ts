#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { prepareClientBundle, readClientBundle, removeClientBundle, clientLaunch, type MemoryClient } from './integrations/client-bundle.js';
import { toStructuredError } from './core/errors.js';
import { prepareRoleClientBundle, roleClientLaunch } from './integrations/role-client-bundle.js';
const usage = `Usage:
  mindpond-connect office-prepare --client codex|opencode --directory /new/session --remote-url https://memory.example/mcp [--token-env MINDPOND_TOKEN] [--session public-label] [--allow-http]
  mindpond-connect office-run --directory /session [--dry-run] [-- CLI arguments]
  mindpond-connect prepare --client codex|claude|opencode --directory /new/bundle (--db /memory.db | --remote-url https://memory.example/memory/mcp --token-file /private/token)
  mindpond-connect inspect|remove|run --directory /bundle [--dry-run] [-- CLI arguments]
Office bundles use native HTTP MCP, public per-session labels and environment variable names only. Native chat IDs distinguish roles across chats; verify memory_identity after approval. Set credentials outside the LLM context.`;
async function runCli(launch:{command:string;args:string[];env:NodeJS.ProcessEnv;cwd?:string}) {
  const child=spawn(launch.command,launch.args,{env:launch.env,cwd:launch.cwd,stdio:'inherit',shell:false});
  const stop=()=>child.kill('SIGTERM');
  // The terminal already sends Ctrl-C to both processes. Keep the wrapper
  // alive so the CLI can cancel its turn without leaving an orphan TUI.
  const interrupt=()=>{if(!process.stdin.isTTY)child.kill('SIGINT');};
  process.once('SIGTERM',stop);process.on('SIGINT',interrupt);
  try {return await new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(code??(signal==='SIGINT'?130:1)));});}
  finally {process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',interrupt);}
}
try {
  const args=process.argv.slice(2), action=args.shift();
  const separator=args.indexOf('--'), extra=separator<0?[]:args.splice(separator).slice(1);
  const {values}=parseArgs({args,options:{help:{type:'boolean',short:'h'},client:{type:'string'},directory:{type:'string'},db:{type:'string'},'remote-url':{type:'string'},'token-file':{type:'string'},'token-env':{type:'string'},'allow-http':{type:'boolean'},session:{type:'string'},'embedding-config':{type:'string'},'model-dir':{type:'string'},name:{type:'string'},'dry-run':{type:'boolean'}}});
  if(!action||['help','--help','-h'].includes(action)||values.help)console.log(usage);
  else if(action==='office-prepare') {
    console.log(JSON.stringify(await prepareRoleClientBundle({directory:values.directory??'',client:values.client as 'codex'|'opencode',url:values['remote-url']??'',tokenEnv:values['token-env'],sessionLabel:values.session,allowHttp:values['allow-http']}),null,2));
  } else if(action==='office-run') {
    const launch=await roleClientLaunch(values.directory??'',extra);
    if(values['dry-run'])console.log(JSON.stringify({command:launch.command,args:launch.args,cwd:launch.cwd},null,2));
    else process.exitCode=await runCli(launch);
  } else {
  if(!values.directory||!['prepare','inspect','remove','run'].includes(action??''))throw new Error(usage);
  if(action==='prepare'&&values.session)throw new Error('Memory uses the native chat identity, not --session. Configure Office first.');
  if(action==='prepare')console.log(JSON.stringify(await prepareClientBundle({client:values.client as MemoryClient,directory:values.directory,dbPath:values.db,remoteUrl:values['remote-url'],tokenFile:values['token-file'],allowHttp:values['allow-http'],embeddingConfigPath:values['embedding-config'],modelDirectory:values['model-dir'],name:values.name}),null,2));
  else if(action==='inspect')console.log(JSON.stringify(await readClientBundle(values.directory),null,2));
  else if(action==='remove')console.log(JSON.stringify(await removeClientBundle(values.directory),null,2));
  else {
    const launch=await clientLaunch(values.directory,extra);
    if(values['dry-run'])console.log(JSON.stringify({command:launch.command,args:launch.args},null,2));
    else process.exitCode=await runCli(launch);
  }
  }
} catch(error) {console.error(JSON.stringify(toStructuredError(error)));process.exitCode=1;}

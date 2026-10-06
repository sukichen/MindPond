#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { prepareClientBundle, readClientBundle, removeClientBundle, clientLaunch, type MemoryClient } from './integrations/client-bundle.js';
import { parseMcpToolProfile } from './core/mcp-tool-profile.js';
import { toStructuredError } from './core/errors.js';
try {
  const args=process.argv.slice(2), action=args.shift();
  const separator=args.indexOf('--'), extra=separator<0?[]:args.splice(separator).slice(1);
  const {values}=parseArgs({args,options:{client:{type:'string'},directory:{type:'string'},db:{type:'string'},'remote-url':{type:'string'},'token-file':{type:'string'},'allow-http':{type:'boolean'},session:{type:'string'},personal:{type:'string'},'embedding-config':{type:'string'},'model-dir':{type:'string'},name:{type:'string'},tools:{type:'string'},native:{type:'boolean'},'no-capture':{type:'boolean'},'dry-run':{type:'boolean'}}});
  if(!values.directory||!['prepare','inspect','remove','run'].includes(action??''))throw new Error('Usage: mindpond-connect prepare --client codex|claude|opencode --directory /new/bundle (--db /memory.db | --remote-url https://memory.example/mcp --token-file /private/token) [--allow-http] [--session logical-session] [--tools work|full] [--embedding-config /profiles.json] [--model-dir /models] [--native] [--no-capture]; inspect|remove|run --directory /bundle [--dry-run] [-- client arguments]');
  if(action==='prepare')console.log(JSON.stringify(await prepareClientBundle({client:values.client as MemoryClient,directory:values.directory,dbPath:values.db,remoteUrl:values['remote-url'],tokenFile:values['token-file'],allowHttp:values['allow-http'],sessionId:values.session,personalId:values.personal,embeddingConfigPath:values['embedding-config'],modelDirectory:values['model-dir'],name:values.name,toolProfile:parseMcpToolProfile(values.tools??'work'),nativeAdapter:values.native,capturePublicMessages:!values['no-capture']}),null,2));
  else if(action==='inspect')console.log(JSON.stringify(await readClientBundle(values.directory),null,2));
  else if(action==='remove')console.log(JSON.stringify(await removeClientBundle(values.directory),null,2));
  else {
    const launch=await clientLaunch(values.directory,extra);
    if(values['dry-run'])console.log(JSON.stringify({command:launch.command,args:launch.args},null,2));
    else {
      const child=spawn(launch.command,launch.args,{env:launch.env,stdio:'inherit',shell:false});
      const stop=()=>child.kill('SIGTERM'); process.once('SIGTERM',stop);
      const code=await new Promise<number>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code)=>resolve(code??1));});
      process.removeListener('SIGTERM',stop);process.exitCode=code;
    }
  }
} catch(error) {console.error(JSON.stringify(toStructuredError(error)));process.exitCode=1;}

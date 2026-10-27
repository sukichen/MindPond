#!/usr/bin/env node
/** Host-side transport helper: hashes and streams files outside model context. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {parseArgs} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {MindPondError,toStructuredError} from './core/errors.js';
const command=process.argv[2];

let client:Client|undefined,file:Awaited<ReturnType<typeof fs.open>>|undefined,temp:string|undefined;
try{
 const {values}=parseArgs({args:process.argv.slice(3),options:{url:{type:'string'},'token-file':{type:'string'},'meta-file':{type:'string'},file:{type:'string'},out:{type:'string'},artifact:{type:'string'},mime:{type:'string'},scope:{type:'string'},recipient:{type:'string',multiple:true},office:{type:'string'},key:{type:'string'},retention:{type:'string'}},strict:true});
 if(!['upload','download'].includes(command)||!values.url||!values['token-file'])throw new MindPondError('invalid_input','Use upload --url <Office MCP URL> --token-file <private file> --file <path> --key <stable key>, or download with --artifact <id> --out <new path>. Optional --meta-file mirrors native per-chat MCP metadata; otherwise uses configured connection identity.');
 const endpoint=new URL(values.url);if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!endpoint.pathname.endsWith('/mcp')||endpoint.pathname.endsWith('/memory/mcp'))throw new MindPondError('invalid_input','Use the configured Office HTTP MCP URL without user info, query or fragment');
 const token=(await fs.readFile(values['token-file'],'utf8')).trim();if(!token||token.length>8192)throw new MindPondError('invalid_input','Host credential file is empty or too large');
 let meta:Record<string,unknown>|undefined;
 if(values['meta-file']){const stat=await fs.stat(values['meta-file']);if(!stat.isFile()||stat.size>2048)throw new MindPondError('invalid_input','Native chat metadata must be a small JSON file supplied by the host');meta=JSON.parse(await fs.readFile(values['meta-file'],'utf8'));if(!meta||Array.isArray(meta)||typeof meta!=='object')throw new MindPondError('invalid_input','Host metadata must be a JSON object');}
 const headers:Record<string,string>={Authorization:'Bearer '+token,...(meta?{'X-MindPond-Meta':JSON.stringify(meta)}:{'X-MindPond-Identity':'connection'})};
 client=new Client({name:'mindpond-artifact-host',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers}}));
 const call=async(args:Record<string,unknown>)=>{const reply=await client!.callTool({name:'office_artifact',arguments:args,...(meta?{_meta:meta}:{})});const content=reply.content as Array<{type:string;text?:string}>,text=content.find(c=>c.type==='text')?.text??'';if(reply.isError){try{const value=JSON.parse(text);throw new MindPondError(value.error?.code??'invalid_input',value.error?.message??'Artifact metadata request failed');}catch(error){if(error instanceof MindPondError)throw error;throw new MindPondError('invalid_input','Artifact metadata request failed; check scope, identity and parameters');}}return JSON.parse(text);};
 const transferURL=(route:string)=>{if(!/^\/artifacts\/[0-9a-f-]{36}\/content$/.test(route))throw new MindPondError('invalid_input','Server returned an invalid artifact route');const u=new URL(endpoint);u.pathname=endpoint.pathname.slice(0,-4)+route.slice(1);return u;};
 const checkResponse=async(response:Response)=>{if(!response.ok){const error=await response.json().catch(()=>({code:'internal',message:'File transfer failed'}));throw new MindPondError(error.code??'internal',error.message??'File transfer failed');}};
 if(command==='upload'){
  if(!values.file||!values.key)throw new MindPondError('invalid_input','upload requires --file and a stable --key');
  file=await fs.open(values.file,'r');const stat=await file.stat();if(!stat.isFile())throw new MindPondError('invalid_input','Upload source must be a regular file');
  const hash=createHash('sha256');for await(const bytes of file.createReadStream({autoClose:false,start:0}))hash.update(bytes);const sha256=hash.digest('hex');
  const prepared=await call({action:'prepare',filename:path.basename(values.file),mime:values.mime??'application/octet-stream',size:stat.size,sha256,key:values.key,scope:values.scope??(values.office?'office':values.recipient?.length?'recipients':'role'),...(values.office?{officeId:values.office}:{}),...(values.recipient?{recipients:values.recipient}:{}),...(values.retention?{retentionSeconds:Number(values.retention)}:{})});
  if(['deleted','expired'].includes(prepared.artifact.state))throw new MindPondError('artifact_unavailable','This key references a deleted or expired artifact; use a new key for a new version');
  const response=await fetch(transferURL(prepared.transfer.path),{method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream','Content-Length':String(stat.size)},body:Readable.toWeb(file.createReadStream({autoClose:false,start:0})) as ReadableStream<Uint8Array>,duplex:'half',redirect:'error',signal:AbortSignal.timeout(300000)} as RequestInit);
  await checkResponse(response);const result=await response.json();if(result.artifact?.sha256!==sha256||result.artifact?.size!==stat.size)throw new MindPondError('checksum_mismatch','Upload receipt does not match the source');console.log(JSON.stringify(result));
 }else{
  if(!values.artifact||!values.out)throw new MindPondError('invalid_input','download requires --artifact and --out');
  const metadata=await call({action:'get',artifactId:values.artifact});const response=await fetch(transferURL(metadata.transfer.path),{headers,redirect:'error',signal:AbortSignal.timeout(300000)});await checkResponse(response);if(!response.body)throw new MindPondError('internal','Download response has no body');
  const target=path.resolve(values.out);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});temp=path.join(path.dirname(target),'.mindpond-download-'+randomUUID()+'.part');file=await fs.open(temp,'wx',0o600);
  let size=0;const hash=createHash('sha256');
  for await(const chunk of Readable.fromWeb(response.body as any)){
   const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;
   if(size>metadata.artifact.size)throw new MindPondError('payload_too_large','Downloaded bytes exceed the immutable reference');
   hash.update(bytes);let offset=0;while(offset<bytes.length){const written=await file.write(bytes,offset,bytes.length-offset);if(!written.bytesWritten)throw new MindPondError('internal','Download write made no progress');offset+=written.bytesWritten;}
  }
  if(size!==metadata.artifact.size||hash.digest('hex')!==metadata.artifact.sha256)throw new MindPondError('checksum_mismatch','Downloaded size or SHA-256 does not match the immutable reference; destination was not published');
  await file.sync();await file.close();file=undefined;
  try{await fs.link(temp,target);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new MindPondError('invalid_input','Destination already exists; choose a new --out path');throw error;}await fs.unlink(temp);temp=undefined;
  console.log(JSON.stringify({artifact:metadata.artifact,savedTo:target,verified:true}));
 }
}catch(error){console.error(JSON.stringify({error:toStructuredError(error)}));process.exitCode=1;}
finally{await file?.close().catch(()=>{});if(temp)await fs.unlink(temp).catch(()=>{});await client?.close().catch(()=>{});}

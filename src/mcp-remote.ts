#!/usr/bin/env node
import {RELEASE_VERSION} from './core/release-info.js';
/** Standard stdio transport for authenticated remote Office or Memory MCP. */
import {parseArgs} from 'node:util';
import fs from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {MEMORY_BOOTSTRAP} from './core/bootstrap.js';
import {OFFICE_TOOL_TIMEOUT_MS} from './core/office-wait-policy.js';
const {values}=parseArgs({options:{url:{type:'string'},'token-file':{type:'string'},'token-env':{type:'string'},identity:{type:'string'},'allow-http':{type:'boolean'},session:{type:'string'}}});
try {
  const url=new URL(values.url??process.env.MINDPOND_REMOTE_URL??'');
  if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol))throw new Error('Invalid endpoint');
  if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!values['allow-http'])throw new Error('Use HTTPS or explicitly --allow-http for a trusted LAN');
  if(values.identity!==undefined&&!['connection','native'].includes(values.identity))throw new Error('Identity must be connection or native');
  if(values['token-env']&&values['token-file'])throw new Error('Choose one credential source');
  let token:string;
  if(values['token-env']){
    if(!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(values['token-env']))throw new Error('Invalid secret variable name');
    token=process.env[values['token-env']]??'';
  }else{
    const tokenFile=values['token-file']??process.env.MINDPOND_REMOTE_TOKEN_FILE;if(!tokenFile)throw new Error('Token file or secret environment variable required');
    const stat=await fs.stat(tokenFile);
    if(!stat.isFile()||stat.size>256||(process.platform!=='win32'&&(stat.mode&0o077)))throw new Error('Token file must be private');
    token=(await fs.readFile(tokenFile,'utf8')).trim();
  }
  if(!/^(?:mpr_)?[A-Za-z0-9_-]{43}$/.test(token))throw new Error('Invalid token');
  const session=values.session??process.env.MINDPOND_REMOTE_SESSION;
  if(session&&!/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,127}$/u.test(session))throw new Error('Invalid host session label');
  const transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${token}`,...(values.identity==='connection'?{'X-MindPond-Identity':'connection'}:{}),...(session?{'X-MindPond-Session':session}:{})},redirect:'error'}});
  const client=new Client({name:'mindpond-remote-bridge',version:RELEASE_VERSION});
  await client.connect(transport);
  const server=new Server({name:'mindpond-remote',version:RELEASE_VERSION},{capabilities:{tools:{},...(client.getServerCapabilities()?.resources?{resources:{}}:{})},instructions:client.getInstructions()??MEMORY_BOOTSTRAP});
  server.setRequestHandler(ListToolsRequestSchema,async(request,extra)=>client.listTools(request.params,{signal:extra.signal}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>client.callTool(request.params,undefined,{signal:extra.signal,timeout:OFFICE_TOOL_TIMEOUT_MS}));
  if(client.getServerCapabilities()?.resources){server.setRequestHandler(ListResourcesRequestSchema,async(request,extra)=>client.listResources(request.params,{signal:extra.signal}));
  server.setRequestHandler(ReadResourceRequestSchema,async(request,extra)=>client.readResource(request.params,{signal:extra.signal}));}
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;const timer=setTimeout(()=>process.exit(1),10000);timer.unref();try{await server.close();await transport.terminateSession();await client.close();}finally{clearTimeout(timer);}};
  process.once('SIGTERM',()=>{void close().catch(()=>{process.exitCode=1;});});
  process.once('SIGINT',()=>{void close().catch(()=>{process.exitCode=1;});});
  await server.connect(new StdioServerTransport());
  server.onclose=()=>{void close().catch(()=>{process.exitCode=1;});};
}catch {console.error('Remote MindPond connection failed. Check endpoint, TLS, credential source and identity configuration.');process.exitCode=1;}

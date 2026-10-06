#!/usr/bin/env node
/** Central network MCP process; does not expose the operator workbench/REST API. */
import 'dotenv/config';
import {parseArgs} from 'node:util';
import fs from 'node:fs/promises';
import {createServer as createHttpsServer} from 'node:https';
import {GraphMemory} from './core/graph-memory.js';
import {defaultDatabasePath} from './core/runtime-paths.js';
import {createNetworkMcpApp} from './integrations/network-server.js';
import {readNetworkConfiguration,issueNetworkGrant} from './integrations/network-config.js';
process.env.MINDPOND_LOG_STDERR='1';
let startupGraph:GraphMemory|undefined;
try {
  const args=process.argv.slice(2),command=args.shift()??'serve';
  const {values}=parseArgs({args,options:{config:{type:'string'},principal:{type:'string'},personal:{type:'string'},'token-file':{type:'string'},rotate:{type:'boolean'},db:{type:'string'},host:{type:'string'},port:{type:'string'},'allowed-host':{type:'string',multiple:true},'tls-cert':{type:'string'},'tls-key':{type:'string'}}});
  const config=values.config??process.env.MINDPOND_MCP_ACCOUNTS;
  if(!config)throw new Error('--config or MINDPOND_MCP_ACCOUNTS is required');
  if(command==='grant'){
    if(!values.principal||!values['token-file'])throw new Error('grant requires --principal and --token-file');
    console.log(JSON.stringify(await issueNetworkGrant({configFile:config,tokenFile:values['token-file'],principal:values.principal,personalId:values.personal,rotate:values.rotate}),null,2));
  }else if(command==='serve'){
    await readNetworkConfiguration(config);
    const host=values.host??'127.0.0.1',port=Number(values.port??7904);
    if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
    const allowedHosts=values['allowed-host']??(['127.0.0.1','localhost','::1'].includes(host)?[`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`]:[]);
    const graph=new GraphMemory('.',{dbPath:values.db??defaultDatabasePath()});startupGraph=graph;await graph.init();
    const network=createNetworkMcpApp(graph,{configuration:()=>readNetworkConfiguration(config),allowedHosts});
    const cert=values['tls-cert'],key=values['tls-key'];
    if(!!cert!==!!key)throw new Error('Supply both --tls-cert and --tls-key');
    const listener=cert&&key?createHttpsServer({cert:await fs.readFile(cert),key:await fs.readFile(key)},network.app):undefined;
    const server=listener?listener.listen(port,host):network.app.listen(port,host);
    server.once('error',()=>{console.error('Network MCP listener failed');process.exit(1);});
    server.once('listening',()=>{const address=server.address();console.error(`[mindpond-mcp-http] listening on ${cert?'https':'http'}://${host}:${typeof address==='object'&&address?address.port:port}/mcp`);});
    let closing=false;
    const stop=async()=>{if(closing)return;closing=true;const timeout=setTimeout(()=>process.exit(1),30000);timeout.unref();try{await network.close(server);await graph.close();clearTimeout(timeout);}catch{process.exitCode=1;}};
    process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
  }else throw new Error('Use serve or grant');
}catch{await startupGraph?.close().catch(()=>{});console.error('Network MCP startup failed. Check command options, private grant configuration and database path.');process.exitCode=1;}

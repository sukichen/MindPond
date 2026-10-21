/** Internal library regression fixture, never a public transport or shipped entry.
 * Generic task/domain operations remain library APIs; public agent MCP is role-only. */
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {GraphMemory} from '../../src/core/graph-memory.js';
import {createMemoryMcpServer} from '../../src/mcp-service.js';
import {readNetworkConfiguration,tokenDigest} from '../../src/integrations/network-config.js';
export async function scopedLibraryMcp(graph:GraphMemory,configFile:string,principal:string,token:string){
 const grant=(await readNetworkConfiguration(configFile)).grants.find(g=>g.principal===principal&&g.tokenHash===tokenDigest(token));if(!grant)throw Error('Fixture grant missing');
 const service=createMemoryMcpServer(graph,{toolProfile:'full',trusted:{v:1,principal,domains:grant.domains,sessionId:'fixture:'+principal,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER},authorizeWait:async()=>{if(!(await readNetworkConfiguration(configFile)).grants.some(g=>g.principal===principal&&g.tokenHash===grant.tokenHash))throw Error('scope_denied: fixture grant revoked');}});
 const client=new Client({name:'library-fixture',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await Promise.all([service.server.connect(a),client.connect(b)]);
 return {client,service};
}

/** Exercise the internal office engine without publishing its worker API.
 * Public HTTP MCP discovery/role tests use the unmodified real client. */
import {officeOperations} from '../../src/core/office-tools.js';
import type {GraphMemory} from '../../src/core/graph-memory.js';
import type {TrustedCallContext} from '../../src/core/trust.js';
export function attachOfficeEngine(client:any,graph:GraphMemory,actor:TrustedCallContext){
 const remote=client.callTool.bind(client),operations=new Map(officeOperations(graph).map(op=>[op.name,op]));
 client.callTool=async(request:any,schema?:any,options?:any)=>{
  const op=operations.get(request.name);if(!op)return remote(request,schema,options);
  try{const result=await op.run(op.schema.parse(request.arguments??{}),actor,{signal:options?.signal});return {content:[{type:'text',text:JSON.stringify(result)}]};}
  catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({error:error instanceof Error?error.message:String(error)})}]};}
 };
}

/** Private newline RPC transport for a trusted local runtime plugin. It is
 * never a network endpoint or a model-callable context-switch tool. */
import readline from 'node:readline';
import { GraphMemory } from '../core/graph-memory.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createOwnerMemoryServer} from '../role-memory-service.js';
import { MindPondError, toStructuredError } from '../core/errors.js';
process.env.MINDPOND_LOG_STDERR='1';
const graph=new GraphMemory();
await graph.init();
// Native adapters use the same layered-identity MCP implementation. No parallel
// personal-domain or lifecycle path may choose an identity for an agent.
const service=createOwnerMemoryServer(graph),client=new Client({name:'mindpond-native-adapter',version:'1'});
const [serverTransport,clientTransport]=InMemoryTransport.createLinkedPair();
await Promise.all([service.server.connect(serverTransport),client.connect(clientTransport)]);
let closing=false;
const calls=new Map<string,{abort:AbortController;promise:Promise<void>}>();
const close=async()=>{
  if(closing)return;closing=true;
  for(const call of calls.values())call.abort.abort();
  await Promise.allSettled([...calls.values()].map(call=>call.promise));
  await client.close();await service.close();await graph.close();
};
process.once('SIGTERM',()=>{void close().finally(()=>process.exit());});
async function execute(request:any,signal:AbortSignal){
  try{
    let result:unknown;
    if(request.tool==='__mindpond_native_schema'){
      const tools=(await client.listTools()).tools;
      const tool=tools.find(t=>t.name===request.args?.tool);
      if(!tool)throw new MindPondError('invalid_input','Unknown Memory tool');
      result={name:tool.name,description:tool.description,inputSchema:tool.inputSchema};
    }else{
      const response=await client.callTool({name:request.tool,arguments:request.args??{},_meta:{'ai.opencode/sessionID':request.sessionId}},undefined,{signal});
      const text=(response.content as Array<{type:string;text:string}>).find(c=>c.type==='text')!.text;
      let payload;try{payload=JSON.parse(text);}catch{throw new MindPondError(response.isError?'invalid_input':'internal',response.isError?text:'Invalid Memory response');}
      if(response.isError){process.stdout.write(JSON.stringify({id:request.id,error:payload.error??payload})+'\n');return;}
      result=payload;
    }
    process.stdout.write(JSON.stringify({id:request.id,result})+'\n');
  }catch(error){process.stdout.write(JSON.stringify({id:request.id,error:toStructuredError(error)})+'\n');}
}
try{
  for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})){
    let request:any;
    try{
      if(Buffer.byteLength(line)>2000000)throw new MindPondError('material_over_budget','Native request exceeds 2 MB; split complete operations into smaller stages');
      request=JSON.parse(line);
      if(typeof request.cancel==='string'){calls.get(request.cancel)?.abort.abort();continue;}
      if(closing||calls.size>=64)throw new MindPondError('temporarily_unavailable','Native worker is closing or busy',{retryable:true});
      if(typeof request.id!=='string'||!request.id||calls.has(request.id))throw new MindPondError('invalid_input','Distinct native RPC request id is required');
      const abort=new AbortController();
      const promise=execute(request,abort.signal);
      calls.set(request.id,{abort,promise});
      void promise.finally(()=>calls.delete(request.id)).catch(()=>{});
    }catch(error){process.stdout.write(JSON.stringify({id:request?.id,error:toStructuredError(error)})+'\n');}
  }
}finally{await close();}

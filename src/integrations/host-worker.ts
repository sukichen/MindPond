/** Private newline RPC transport for a trusted local runtime plugin. It is
 * never a network endpoint or a model-callable context-switch tool. */
import readline from 'node:readline';
import { GraphMemory } from '../core/graph-memory.js';
import { normalizeDomain } from '../core/domain.js';
import { MindPondError, toStructuredError } from '../core/errors.js';
import { HostSessionService } from './host-session.js';
process.env.MINDPOND_LOG_STDERR='1';
const graph=new GraphMemory();
await graph.init();
const configured=JSON.parse(process.env.MEMORY_TRUST_DOMAINS??'[]');
if(!Array.isArray(configured)||configured.some(d=>d.kind==='session'))throw new Error('Native adapter needs configured personal/team domains only');
const service=new HostSessionService(graph,configured.map(d=>normalizeDomain(d)),process.env.MEMORY_TRUST_PRINCIPAL??'opencode/local');
let closing=false;
const close=async()=>{if(closing)return;closing=true;await graph.close();};
process.once('SIGTERM',()=>{void close().finally(()=>process.exit());});
try {
  for await(const line of readline.createInterface({input:process.stdin,crlfDelay:Infinity})) {
    let request:any;
    try {
      request=JSON.parse(line);
      if(Buffer.byteLength(line)>2000000)throw new MindPondError('material_over_budget','Native request exceeds 2 MB; split complete operations into smaller stages');
      let result:unknown;
      if(request.tool==='__mindpond_host_identity')result={pondId:await graph.pondIdentity()};
      else if(request.tool==='__mindpond_host_captured')result={captured:await graph.lifecycleCaptured(request.sessionId,process.env.MEMORY_TRUST_PRINCIPAL??'opencode/local',request.args.runId,request.args.checkpointId)};
      else if(request.tool==='__mindpond_host_session_status')result={status:await graph.hostSessionStatus(request.sessionId)};
      else result=await service.call(request.sessionId,request.tool,request.args);
      process.stdout.write(JSON.stringify({id:request.id,result})+'\n');
    } catch(error) {process.stdout.write(JSON.stringify({id:request?.id,error:toStructuredError(error)})+'\n');}
  }
} finally {await close();}

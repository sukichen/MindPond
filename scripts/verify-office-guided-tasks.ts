/** Transport, identity, task state, and the temporary-to-durable discussion boundary. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {GraphMemory} from '../src/core/graph-memory.js';
import {createNetworkMcpApp} from '../src/integrations/network-server.js';
import {tokenDigest} from '../src/integrations/network-config.js';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-guided-tasks-'));
process.env.MINDPOND_EMBEDDING_MODE='text';
const graph=new GraphMemory('.',{dbPath:path.join(dir,'fixture.db')});
const human={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
const token=randomBytes(32).toString('base64url');
let network:ReturnType<typeof createNetworkMcpApp>|undefined,listener:any,client:Client|undefined;
try{
  await graph.init();
  await graph.offices.configureAgent({id:'fixture',principal:'human',name:'Synthetic',host:'codex',state:'active',expectedRevision:0},human);
  const hosts=['127.0.0.1'];
  network=createNetworkMcpApp(graph,{allowedHosts:hosts,configuration:async()=>({version:2,grants:[
    {principal:'human',agentId:'fixture',credentialId:'fixture',tokenHash:tokenDigest(token),domains:[],toolProfile:'office' as const}
  ]})});
  listener=network.app.listen(0,'127.0.0.1');
  await new Promise<void>((resolve,reject)=>listener.once('listening',resolve).once('error',reject));
  const base=new URL('http://127.0.0.1:'+listener.address().port);hosts.push(base.host);
  client=new Client({name:'guided-task-fixture',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',base),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  async function call(chat:string,name:string,args:Record<string,unknown>,errorCode?:string) {
    const envelope=['office_guided_task','office_artifact'].includes(name)?{responseBudgetBytes:65536}:{};
    const result:any=await client!.callTool({name,arguments:{...args,...envelope},_meta:{threadId:chat}});
    const payload=JSON.parse(result.content[0].text);
    if(errorCode){
      assert(result.isError,JSON.stringify(result));
      assert.equal(payload.error.code,errorCode,JSON.stringify(payload));
      assert(payload.error.nextAction);
      return payload;
    }
    assert(!result.isError,JSON.stringify(result));
    return payload;
  }
  const role:Record<string,string>={};
  for(const chat of ['lead','worker','guest']){
    const application=await call(chat,'role_application',{action:'submit',name:chat,introduction:'Specialist '+chat,reason:'Regression',key:'apply'});
    const approved=await graph.roles.review({applicationId:application.applicationId,expectedRevision:1,action:'approve'},human);
    role[chat]=approved.roleId;
  }
  for(const officeId of ['studio','other'])await graph.roles.configureOffice({
    id:officeId,title:officeId,state:'active',expectedRevision:0,
    seats:Object.entries(role).map(([name,roleId])=>({id:officeId+'-'+name,roleId,label:name,role:'member'}))
  },human);
  const officeId='studio';
  const task=(chat:string,args:Record<string,unknown>,code?:string)=>call(chat,'office_guided_task',{officeId,...args},code);
  const discussion=(chat:string,args:Record<string,unknown>,code?:string)=>call(chat,'office_discussion',args,code);
  const tools=await client.listTools();
  assert(tools.tools.some(t=>t.name==='office_guided_task'));
  assert(!tools.tools.some(t=>t.name==='memory_brief'),'task guidance must not add memory to Office MCP');

  const assignment={action:'create',ownerId:role.worker,title:'Inspect offline build',goal:'Find the first reproducible failure',acceptance:'Command and ABI evidence',instruction:'Use the staged archive',key:'assign'};
  await task('lead',assignment,'scope_denied');
  await graph.guidedTasks.settings({officeId,supervisorId:role.lead,expectedRevision:0},human);
  let waitingFinished=false;
  const waiting=call('worker','office_wait',{afterTaskChange:0,waitMs:4000}).then(result=>{
    waitingFinished=true;
    return result;
  });
  await new Promise(resolve=>setTimeout(resolve,100));
  assert(!waitingFinished,'an idle role should still be waiting before assignment');
  const created=(await task('lead',assignment)).task;
  const wake=await waiting;
  assert.equal(wake.status,'task_update');
  assert.equal(wake.wakeReason,'task_update');
  assert.equal(wake.nextCall.arguments.taskId,created.id);
  const taskId=created.id;
  assert.equal(created.status,'queued');
  assert.equal((await task('lead',assignment)).task.id,taskId);
  await task('lead',{...assignment,title:'Different'},'idempotency_conflict');
  await task('guest',{action:'get',taskId},'not_found');
  assert.deepEqual((await task('guest',{action:'list'})).tasks,[]);
  const sync=await call('worker','role_sync',{});
  assert.equal(sync.guidedTaskAttention.kind,'assignment');
  assert.deepEqual(sync.guidedTaskAttention.nextCall,wake.nextCall);
  assert.equal((await call('guest','role_sync',{})).guidedTaskAttention,undefined);
  assert.equal((await call('worker','office_wait',{waitMs:100})).status,'timeout','task wakes require explicit opt-in');
  const timeout=await call('worker','office_wait',{...wake.resume,waitMs:100});
  assert.equal(timeout.status,'timeout','already observed task changes must not wake again');
  assert.equal(timeout.resume.afterTaskChange,wake.taskUpdate.seq);
  await call('worker','office_wait',{afterTaskChange:0,replyTo:'any',waitMs:100},'invalid_input');
  const work=(await task('worker',{action:'get',taskId})).task;
  assert.deepEqual(work.guidance.memory.arguments,{task:'Inspect offline build',limit:3});
  assert.equal(work.guidance.memory.tool,'memory_brief');
  assert.deepEqual(work.claim,wake.nextCall);
  assert.equal((await task('worker',wake.nextCall.arguments)).task.status,'working');
  const working=await call('worker','role_sync',{});
  assert.equal(working.guidedTaskAttention,undefined);
  assert.equal(working.guidedTaskInProgress.nextCall.arguments.taskId,taskId);
  assert.equal((await task('worker',work.claim.arguments)).replayed,true);
  await task('worker',{action:'guide',taskId,instruction:'Privilege bypass',expectedRevision:2,key:'bad-guide'},'scope_denied');
  const blockReport={attempted:'Reproduced with the offline archive',obstacle:'Installed ABI differs from the cache',decision:'May the ABI change?',recommendation:'Keep the ABI and rebuild the cache'};
  const blockRequest={action:'block',taskId,blocker:'decision',expectedRevision:2,key:'block'};
  await task('worker',{...blockRequest,blockReport:{attempted:blockReport.attempted,obstacle:blockReport.obstacle}},'invalid_input');
  const blocked=(await task('worker',{...blockRequest,blockReport})).task;
  const leadSync=await call('lead','role_sync',{});
  assert.equal(leadSync.guidedTaskAttention.kind,'decision_needed');
  assert.deepEqual((await task('lead',leadSync.guidedTaskAttention.nextCall.arguments)).task.blockReport,blockReport);
  assert.equal((await task('lead',{action:'list',filter:'attention'})).tasks[0].id,taskId);
  const guide={action:'guide',taskId,resolveDecision:true,instruction:'Keep the ABI fixed; rebuild the cache',expectedRevision:blocked.revision,key:'decide'};
  const resolved=(await task('lead',guide)).task;
  assert.equal(resolved.status,'queued');
  assert.deepEqual((await task('lead',{action:'list',filter:'attention'})).tasks,[]);
  const decision=await call('worker','office_wait',{...wake.resume,waitMs:100});
  assert.equal(decision.taskUpdate.kind,'decision_answered');
  assert.equal(decision.nextCall.arguments.action,'claim');
  const updated=(await task('worker',{action:'get',taskId})).task;
  assert.equal(updated.guidance.instruction,'Keep the ABI fixed; rebuild the cache');
  assert.equal((await task('worker',updated.claim.arguments)).task.status,'working');

  const meetingArgs={action:'create',officeId,taskId,title:'ABI discussion',question:'What cache is missing?',doneWhen:'Reproduction verified',participants:[role.worker,role.guest],key:'meeting'};
  await discussion('guest',{...meetingArgs,participants:[role.worker]},'not_found');
  await assert.rejects(graph.discussions.run({...meetingArgs,officeId:'other'},human),(e:any)=>e.code==='not_found');
  const meeting=(await graph.discussions.run(meetingArgs,human)).room;
  assert.equal(meeting.guided_task_id,taskId);
  assert.equal((await graph.discussions.run(meetingArgs,human)).room.id,meeting.id);
  assert.equal((await task('lead',{action:'get',taskId})).task.rooms.length,0,'supervisor is not automatically invited');
  assert.equal((await task('worker',{action:'get',taskId})).task.rooms[0].id,meeting.id);
  const concurrent=(await discussion('lead',{action:'create',officeId,title:'Separate room',question:'Independent topic',doneWhen:'Answered',participants:[role.guest],key:'parallel'})).room;
  await discussion('worker',{action:'join',id:meeting.id});
  await discussion('worker',{action:'post',id:meeting.id,body:'Temporary raw transcript',key:'post'});
  const live=await discussion('worker',{action:'get',id:meeting.id});
  const close={action:'close',id:meeting.id,expectedRevision:live.room.revision,summary:'Reproduced',taskOutcome:{decision:'Use the verified local cache.',evidence:'Ran the cache verification command.',nextStep:'Attach the command and log to the task.'},key:'close'};
  await discussion('guest',close,'scope_denied');
  assert.equal((await call('worker','role_sync',{})).guidedTaskAttention,undefined,'do not interrupt a joined meeting with the ordinary task queue');
  await task('worker',{action:'submit',taskId,note:'Premature result',expectedRevision:resolved.revision+1,key:'busy'},'invalid_input');
  const locked=await graph.discussions.setLock({id:meeting.id,locked:true,expectedLockRevision:1},human);
  await discussion('worker',{...close,expectedRevision:locked.revision},'scope_denied');
  await graph.discussions.setLock({id:meeting.id,locked:false,expectedLockRevision:locked.lockRevision},human);
  close.expectedRevision=(await discussion('worker',{action:'get',id:meeting.id})).room.revision;
  assert((await discussion('worker',close)).closed);
  assert((await discussion('worker',close)).closed);
  await discussion('worker',{...close,taskOutcome:{...close.taskOutcome,nextStep:'Different instructions'}},'idempotency_conflict');
  await discussion('worker',{action:'get',id:meeting.id},'not_found');
  assert.equal((await graph.discussions.run({action:'list',officeId},human)).rooms[0].id,concurrent.id);
  const after=(await task('lead',{action:'get',taskId})).task;
  assert.deepEqual(after.rooms,[]);
  assert.deepEqual(after.outcomes.map((o:any)=>o.details),[close.taskOutcome]);
  assert.equal((await call('worker','role_sync',{})).guidedTaskAttention.kind,'meeting_outcome');
  assert(!JSON.stringify(after).includes('Temporary raw transcript'));
  await task('guest',{action:'get',taskId},'not_found');

  await graph.discussions.run({action:'close',id:concurrent.id,expectedRevision:concurrent.revision},human);
  const publish=(officeId:string)=>call('worker','office_material',{action:'publish',officeId,title:'Cache log',content:'command: verify-cache --offline',key:'log-'+officeId});
  const {materialId}=await publish(officeId);
  const otherMaterial=await publish('other');
  const upload=async (scope:'office'|'role')=>{
    const bytes=Buffer.from('verified cache log');
    const {artifact,transfer}=await call('worker','office_artifact',{action:'prepare',filename:'cache.log',mime:'text/plain',
      size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),scope,key:'file-'+scope,
      ...(scope==='office'?{officeId}:{})});
    const response=await fetch(new URL(transfer.path,base),{method:'PUT',body:bytes,
      headers:{Authorization:'Bearer '+token,'X-MindPond-Meta':JSON.stringify({threadId:'worker'})}});
    assert.equal(response.status,201,await response.text());
    return artifact.artifactId;
  };
  const artifactId=await upload('office');
  const privateArtifact=await upload('role');
  const delivery={summary:'ABI and command verified',checks:[
    {criterion:'Reproduction command',status:'verified',materialId,artifactId},
    {criterion:'Second architecture',status:'not_verified'}
  ],unknowns:'Only the primary architecture was available'};
  const submit={action:'submit',taskId,expectedRevision:after.revision,key:'submit'};
  await task('worker',{...submit,delivery:{...delivery,checks:[{criterion:'No evidence',status:'verified'}]}},'invalid_input');
  await task('worker',{...submit,delivery:{...delivery,checks:[{...delivery.checks[0],materialId:otherMaterial.materialId}]}},'not_found');
  await task('worker',{...submit,delivery:{...delivery,checks:[{...delivery.checks[0],artifactId:privateArtifact}]}},'not_found');
  const submitted=(await task('worker',{...submit,delivery})).task;
  const readyForReview=(await call('lead','role_sync',{afterTaskChange:leadSync.guidedTaskAttention.seq})).guidedTaskAttention;
  assert.equal(readyForReview.kind,'review_needed');
  assert.equal(readyForReview.taskId,taskId);
  assert.equal(readyForReview.nextCall.arguments.action,'review_queue');
  const overview=await task('lead',readyForReview.nextCall.arguments);
  const preview=overview.tasks.find((t:any)=>t.id===taskId);
  assert(preview.needsAttention && preview.reviewSuggested);
  assert.equal(preview.checks[0].artifactId,artifactId);
  assert(!JSON.stringify(preview).includes(delivery.checks[0].evidence));
  assert.deepEqual((await task('lead',preview.nextCall.arguments)).task.delivery,delivery);
  await task('guest',{action:'review_queue'},'scope_denied');
  const review={action:'review',taskId,expectedRevision:submitted.revision,verdict:'revise',note:'Attach the exact command',key:'return'};
  const returned=(await task('lead',review)).task;
  const revision=await call('worker','role_sync',{afterTaskChange:decision.taskUpdate.seq});
  assert.equal(revision.guidedTaskAttention.kind,'revision_requested');
  assert.equal((await task('worker',revision.guidedTaskAttention.nextCall.arguments)).task.note,review.note);
  const resubmitted=(await task('worker',{...submit,expectedRevision:returned.revision,note:'verify-cache --offline',key:'resubmit'})).task;
  assert.equal(resubmitted.delivery,null,'plain-text resubmission must not retain stale structured checks');
  await task('lead',{...review,expectedRevision:resubmitted.revision,key:'return-again'},'invalid_input');
  const done=(await task('lead',{...review,verdict:'accept',note:'Evidence confirmed',expectedRevision:resubmitted.revision,key:'accept'})).task;
  assert.equal(done.status,'done');
  assert.equal((await task('lead',{action:'list',filter:'closed'})).tasks[0].id,taskId);
  assert.equal((await call('worker','role_sync',{})).guidedTaskAttention,undefined,'finished tasks must not hide new work');
  const first=(await task('lead',{...assignment,title:'First pending task',key:'cursor-first'})).task;
  const second=(await task('lead',{...assignment,title:'Second pending task',key:'cursor-second'})).task;
  const firstChange=(await call('worker','role_sync',{})).guidedTaskAttention;
  assert.equal(firstChange.nextCall.arguments.taskId,first.id);
  const secondChange=(await call('worker','role_sync',{afterTaskChange:firstChange.seq})).guidedTaskAttention;
  assert.equal(secondChange.nextCall.arguments.taskId,second.id);
  assert.equal((await call('guest','office_wait',{afterTaskChange:0,waitMs:100})).status,'timeout');
  const settings=await graph.guidedTasks.settings({officeId,supervisorId:role.lead,reviewMode:'exceptions',expectedRevision:1},human);
  assert.equal(settings.reviewMode,'exceptions');
  const batch={goal:'Check one shared release',briefMaterialId:materialId,assignments:[
    {ownerId:role.worker,title:'Check dependency cache',acceptance:'Give verified evidence',key:'batch-cache'},
    {ownerId:role.guest,title:'Check runtime ABI',acceptance:'Give verified evidence',key:'batch-abi',memoryQuery:null}
  ]};
  await task('lead',{action:'dispatch',batch:{...batch,briefMaterialId:otherMaterial.materialId}},'not_found');
  await task('lead',{action:'dispatch',batch:{...batch,assignments:[batch.assignments[0],{...batch.assignments[1],ownerId:'not-a-member'}]}},'invalid_input');
  const dispatched=await task('lead',{action:'dispatch',batch});
  assert(dispatched.tasks.every((t:any)=>!t.replayed),'the failed batch must roll back all writes');
  assert.deepEqual((await task('lead',{action:'dispatch',batch})).tasks.map((t:any)=>t.replayed),[true,true]);
  const mixedDispatch=await task('lead',{action:'dispatch',batch:{...batch,assignments:[
    batch.assignments[0],{...batch.assignments[1],key:'different-batch-same-brief'}
  ]}},'idempotency_conflict');
  assert.equal(mixedDispatch.error.field,'batch.assignments');
  const batched=(await task('worker',{action:'get',taskId:dispatched.tasks[0].id})).task;
  assert.equal(batched.goal,batch.goal);
  assert.equal(batched.brief.nextCall.arguments.materialId,materialId);
  const claimed=(await task('worker',batched.claim.arguments)).task;
  const peer=(await task('guest',{action:'get',taskId:dispatched.tasks[1].id})).task;
  assert.deepEqual((await task('guest',peer.evidenceIndex.arguments)).evidence,[]);
  const published=await call('worker','office_material',{action:'publish',officeId,title:'Verified cache trace',
    version:'candidate-a',content:'Cache trace for this candidate.',key:'progress-trace'});
  assert.deepEqual((await task('guest',peer.evidenceIndex.arguments)).evidence,[],'publishing alone does not link evidence to a batch');
  const progress={...claimed.reportProgress.nextCall.arguments,note:'Private handoff draft',
    progressMaterialId:published.materialId};
  await task('worker',{...progress,progressMaterialId:otherMaterial.materialId},'not_found');
  const {task:reported}=await task('worker',progress);
  assert.equal(reported.status,'working');
  assert.equal(reported.lastReportedAt,reported.progress.reportedAt);
  assert.equal((await task('worker',progress)).replayed,true);
  const supervisorProgress=(await task('lead',{action:'list',filter:'active'})).tasks.find((t:any)=>t.id===claimed.id);
  assert.equal(supervisorProgress.progressPreview,progress.note);
  await task('guest',{action:'evidence_index',taskId:claimed.id},'not_found');
  const index=await task('guest',peer.evidenceIndex.arguments);
  assert.equal(index.evidence[0].materialId,published.materialId);
  assert.equal(index.evidence[0].sha256,published.sha256);
  assert.equal(index.evidence[0].version,'candidate-a');
  assert.equal(index.evidence[0].reportedBy,role.worker);
  assert(!JSON.stringify(index).includes(progress.note));
  assert.deepEqual((await task('worker',{action:'evidence_index',taskId:first.id})).evidence,[]);
  const separate=(await task('lead',{action:'dispatch',batch:{...batch,assignments:[{
    ...batch.assignments[1],key:'different-batch-same-brief'
  }]}})).tasks[0];
  assert.equal(separate.replayed,false,'the mixed dispatch must roll back new assignments');
  assert.deepEqual((await task('guest',{action:'evidence_index',taskId:separate.id})).evidence,[]);
  await task('lead',{action:'cancel',taskId:separate.id,expectedRevision:separate.revision,key:'cancel-separate',note:'Scope test complete'});
  const unlinked=(await task('worker',{...reported.reportProgress.nextCall.arguments,note:'Still checking',progressMaterialId:null})).task;
  assert.deepEqual((await task('guest',peer.evidenceIndex.arguments)).evidence,[]);
  const staleSubmission=await task('worker',reported.submission.nextCall.arguments,'stale_version');
  assert.equal(staleSubmission.error.details.currentRevision,unlinked.revision);
  assert.equal(staleSubmission.error.details.nextCall.arguments.taskId,claimed.id);
  const missingReport=await task('worker',unlinked.submission.nextCall.arguments,'invalid_input');
  assert.equal(missingReport.error.field,'note');
  const missingEvidence=await task('worker',{...unlinked.submission.nextCall.arguments,
    delivery:{summary:'Missing evidence',checks:[{criterion:'Cache',status:'verified'}]}},'invalid_input');
  assert.equal(missingEvidence.error.field,'delivery.checks[0]');
  const cleanDelivery={summary:'No missing evidence',observations:'One additional verified observation',
    checks:[{criterion:'Cache restored',status:'verified',materialId,conclusion:'pass',observed:'Pinned cache is complete',evidenceVersion:'candidate-a'}]};
  await task('worker',{...unlinked.submission.nextCall.arguments,delivery:cleanDelivery});
  const clean=(await task('lead',{action:'review_queue',taskId:claimed.id})).tasks[0];
  assert.equal(clean.status,'review','review priority must not change the task status');
  assert.equal(clean.reviewSuggested,false);
  assert.equal(clean.checks[0].conclusion,'pass');
  assert.equal(clean.checks[0].observed,'Pinned cache is complete');
  assert.equal(clean.checks[0].evidenceVersion,'candidate-a');
  assert.equal(clean.reviewCall.arguments.expectedRevision,clean.revision);
  assert.equal((await task('lead',clean.nextCall.arguments)).task.delivery.observations,cleanDelivery.observations);
  const secondBatch=(await task('guest',{action:'get',taskId:dispatched.tasks[1].id})).task;
  const secondClaim=(await task('guest',secondBatch.claim.arguments)).task;
  await task('guest',{action:'submit',taskId:secondClaim.id,expectedRevision:secondClaim.revision,
    delivery:{summary:'ABI mismatch',checks:[{criterion:'ABI',status:'verified',conclusion:'fail',evidence:'Measured ABI; '.repeat(45)}]},key:'abi-submit'});
  const failedCheck=(await task('lead',{action:'review_queue',taskId:secondClaim.id})).tasks[0];
  assert(failedCheck.needsAttention&&failedCheck.reviewSuggested);
  assert.equal(failedCheck.checks[0].evidencePreview.length,160);
  assert.equal(failedCheck.checks[0].observed,undefined);
  const fullList=await task('lead',{action:'list',filter:'attention'});
  const fullReports=await Promise.all(fullList.tasks.map((t:any)=>task('lead',{action:'get',taskId:t.id})));
  const compact=await task('lead',{action:'review_queue'});
  assert.equal(compact.tasks.length,fullReports.length);
  const compactBytes=Buffer.byteLength(JSON.stringify(compact));
  const fullBytes=[fullList,...fullReports].reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r)),0);
  assert(compactBytes<fullBytes);
  console.log(`Review fixture: 1 call / ${compactBytes} bytes vs ${1+fullReports.length} calls / ${fullBytes} bytes`);
  const usageTarget={officeId,taskId:done.id};
  const empty=await graph.guidedTasks.usage(usageTarget,human);
  assert.equal(empty.billable.reportedMicrousd,null);
  assert.equal(typeof empty.task.submissionToReviewMs,'number');
  const local={key:'local',phase:'work',model:'DeepSeek',meter:'local',responses:3,inputTokens:900,cachedInputTokens:100,outputTokens:25,elapsedMs:100};
  const billable={key:'estimate',phase:'review',model:'GPT',meter:'billable',costMicrousd:123,costKind:'estimate'};
  await graph.guidedTasks.usage({...usageTarget,entry:local},human);
  await graph.guidedTasks.usage({...usageTarget,entry:billable},human);
  const metered=await graph.guidedTasks.usage({...usageTarget,entry:billable},human);
  assert.equal(metered.entries.length,2);
  assert.deepEqual(metered.billable,{reportedMicrousd:null,estimatedMicrousd:123,missingCostEntries:0});
  await assert.rejects(graph.guidedTasks.usage({...usageTarget,entry:{...local,costMicrousd:1,costKind:'reported'}},human));
  await assert.rejects(graph.guidedTasks.usage({...usageTarget,entry:{...billable,costMicrousd:1}},human),/idempotency_conflict/);
  await assert.rejects(graph.guidedTasks.usage({...usageTarget,officeId:'other'},human),/not_found/);
  await graph.guidedTasks.settings({officeId,supervisorId:null,expectedRevision:2},human);
  await task('lead',{...assignment,key:'assign-after-revoke'},'scope_denied');

  await task('lead',{action:'get',taskId},'not_found');
  assert.equal((await task('worker',{action:'get',taskId})).task.status,'done');

  // Independent review is opt-in and the audit snapshot belongs to the submitted report.
  await graph.guidedTasks.settings({officeId,supervisorId:role.lead,expectedRevision:3,reviewMode:'sample',
    riskReview:{samplePercent:20,useHistory:true,requireAudit:true,verifierId:role.guest}},human);
  const pendingReview=await task('lead',{...clean.reviewCall.arguments,verdict:'accept',
    note:'Accept report submitted before audit was required'},'invalid_input');
  assert.equal(pendingReview.error.field,'verdict');
  const pendingDetail=(await task('lead',clean.nextCall.arguments)).task;
  assert.equal(pendingDetail.status,'review');
  assert.equal(pendingDetail.auditSubmissionMissing,true);
  const pendingQueue=(await task('lead',{action:'review_queue',taskId:clean.id})).tasks[0];
  assert(pendingQueue.auditSubmissionMissing&&pendingQueue.needsAttention&&pendingQueue.reviewSuggested);
  const newEvidence=await call('worker','office_material',{action:'publish',officeId,title:'Build evidence',version:'new',content:'actual output',key:'risk-new'});
  const oldEvidence=await call('worker','office_material',{action:'publish',officeId,title:'Old build evidence',version:'old',content:'previous output',key:'risk-old'});
  const risk={workType:'离线发布',targetVersion:'new',requiredChecks:['required-id']};
  const riskTask=(await task('lead',{...assignment,risk,key:'risk-assignment'})).task;
  await task('lead',{action:'review_packet',taskId:riskTask.id},'not_found');
  const riskClaim=(await task('worker',riskTask.claim?.arguments??{action:'claim',taskId:riskTask.id,key:'risk-claim',expectedRevision:riskTask.revision})).task;
  const regular=Array.from({length:15},(_,index)=>({checkId:'normal-'+index,criterion:'Standard '+index,status:'verified',
    expected:'ABI 127',observed:'ABI 127',evidenceVersion:'new',materialId:newEvidence.materialId,receipt:'report-'+index}));
  const result={summary:'Structured report',checks:[
    {checkId:'self',criterion:'Claim with no source',status:'verified',evidence:'Worker claims PASS',observed:'PASS',evidenceVersion:'new'},
    {checkId:'old',criterion:'Old version claimed as current',status:'verified',observed:'PASS',evidenceVersion:'new',materialId:oldEvidence.materialId},
    ...regular
  ]};
  const submission={action:'submit',taskId:riskTask.id,expectedRevision:riskClaim.revision,key:'risk-submit',delivery:result};
  const riskSubmitted=(await task('worker',submission)).task;
  const read={action:'review_packet',taskId:riskTask.id,limit:20};
  const packet=await task('lead',read);
  assert.equal(packet.checkCount,17);
  assert.equal(packet.profile.submissions,0,'unaudited work must not count as verified experience');
  assert.equal(packet.requiredCount,8,'20% is doubled with insufficient history, plus two exceptions');
  assert.equal(packet.checks.length,8);
  assert.equal(packet.checks[0].evidenceStatus,'self_reported');
  assert(packet.checks[0].reasons.includes('self_report_only'));
  assert(packet.checks[1].reasons.includes('version_mismatch'),'check the actual material version');
  assert.deepEqual(packet.missingCheckIds,['required-id']);
  assert.equal((await task('worker',submission)).replayed,true);
  assert.deepEqual((await task('lead',read)).checks.map((c:any)=>c.index),packet.checks.map((c:any)=>c.index));
  await task('worker',read,'scope_denied');
  await task('guest',{action:'get',taskId:riskTask.id},'not_found');
  assert.equal((await task('guest',read)).submissionId,packet.submissionId);
  await task('guest',{action:'review_queue'},'scope_denied');
  const finding={index:packet.checks[2].index,outcome:'discrepancy',observed:'ABI 118, contradicts reported ABI 127',
    method:'script',source:'isolated native ABI probe',evidenceVersion:'new',materialId:newEvidence.materialId};
  const audit={action:'audit',taskId:riskTask.id,key:'audit-finding',audit:{submissionId:packet.submissionId,entries:[finding]}};
  await task('worker',audit,'scope_denied');
  await task('guest',{...audit,key:'wrong-office-audit',audit:{...audit.audit,entries:[{...finding,materialId:otherMaterial.materialId}]}},'not_found');
  await task('guest',{...audit,key:'stale-confirmation',audit:{...audit.audit,entries:[{...finding,outcome:'confirmed',materialId:oldEvidence.materialId}]}},'invalid_input');
  assert.equal((await task('guest',audit)).risk.broadened,true);
  assert.equal((await task('guest',audit)).replayed,true);
  const expanded=await task('lead',read);
  assert.equal(expanded.requiredCount,17);
  assert.equal(expanded.checks.find((c:any)=>c.index===finding.index).finding,'discrepancy');
  const accept={action:'review',taskId:riskTask.id,expectedRevision:riskSubmitted.revision,verdict:'accept',note:'Reviewed',key:'risk-accept'};
  await task('guest',accept,'not_found');
  await task('lead',accept,'invalid_input');
  await task('lead',{...accept,auditOverride:true},'scope_denied');
  const revised=(await task('lead',{...accept,verdict:'revise',note:'Fix the missing and inaccurate checks',key:'risk-revise'})).task;
  const corrected={summary:'Corrected facts',checks:[{...regular[0],checkId:'required-id',observed:'ABI 118 is a blocker',conclusion:'fail'}]};
  const retry=(await task('worker',{...submission,delivery:corrected,expectedRevision:revised.revision,key:'corrected-submit'})).task;
  await task('guest',audit,'stale_version');
  const correctedPacket=await task('lead',read);
  assert.notEqual(correctedPacket.submissionId,packet.submissionId);
  assert(correctedPacket.checks[0].reasons.includes('reported_failure'));
  const confirm={...finding,index:0,outcome:'confirmed',observed:'Independent probe also showed ABI 118'};
  await task('guest',{...audit,key:'new-audit',audit:{submissionId:correctedPacket.submissionId,entries:[confirm]}});
  const confirmed=await task('lead',read);
  assert.equal(confirmed.pendingCount,0);
  assert.equal(confirmed.checks[0].evidenceStatus,'independently_verified');
  assert.equal(confirmed.checks[0].latestAudit.by,role.guest);
  assert.equal((await task('lead',{...accept,expectedRevision:retry.revision,key:'corrected-accept'})).task.status,'done');

  const later=(await task('lead',{...assignment,risk:{...risk,level:'high',requiredChecks:[]},key:'risk-later'})).task;
  const laterClaim=(await task('worker',{action:'claim',taskId:later.id,expectedRevision:later.revision,key:'risk-later-claim'})).task;
  const laterReport=(await task('worker',{...submission,taskId:later.id,expectedRevision:laterClaim.revision,delivery:corrected,key:'risk-later-submit'})).task;
  const laterPacket=await task('lead',{...read,taskId:later.id});
  assert.equal(laterPacket.profile.discrepancy,1);
  assert.equal(laterPacket.profile.confirmed,1);
  assert(laterPacket.checks[0].reasons.includes('high_risk'));
  const humanAccept={...accept,officeId,taskId:later.id,expectedRevision:laterReport.revision,auditOverride:true,note:'Human records an exception'};
  const overridden=await graph.guidedTasks.run(humanAccept,human);
  assert.match(overridden.task.note,/Audit override by human/);

  await graph.guidedTasks.settings({officeId,supervisorId:role.lead,expectedRevision:4,
    riskReview:{samplePercent:0,useHistory:false,requireAudit:true,verifierId:role.guest}},human);
  const required=(await task('lead',{...assignment,risk,key:'explicit-check'})).task;
  const requiredClaim=(await task('worker',{action:'claim',taskId:required.id,expectedRevision:required.revision,key:'explicit-claim'})).task;
  const requiredReport=(await task('worker',{...submission,taskId:required.id,expectedRevision:requiredClaim.revision,
    key:'explicit-submit',delivery:{summary:'Two routine observations',checks:[{...regular[0],checkId:'required-id'},regular[1]]}})).task;
  const requiredPacket=await task('lead',{...read,taskId:required.id});
  assert.equal(requiredPacket.requiredCount,1,'an explicit check must be independently audited even when routine sampling is zero');
  assert(requiredPacket.checks[0].reasons.includes('required_check'));
  await task('lead',{...accept,taskId:required.id,expectedRevision:requiredReport.revision,key:'explicit-accept'},'invalid_input');

  await graph.guidedTasks.settings({officeId,supervisorId:role.lead,expectedRevision:5,riskReview:null},human);
  await task('lead',read,'invalid_input');
  const legacy=(await task('lead',{...assignment,key:'risk-disabled'})).task;
  const legacyClaim=(await task('worker',{action:'claim',taskId:legacy.id,expectedRevision:legacy.revision,key:'legacy-claim'})).task;
  const legacyReport=(await task('worker',{action:'submit',taskId:legacy.id,expectedRevision:legacyClaim.revision,note:'Plain report',key:'legacy-submit'})).task;
  assert.equal((await task('lead',{...accept,taskId:legacy.id,expectedRevision:legacyReport.revision,key:'legacy-accept'})).task.status,'done');
  console.log('PASS opt-in risk review: post-submit sampling, false claims, stale evidence, discrepancy expansion, scoped audits, re-submission fencing, profile, override and disable');

  const db=(graph as any).db;
  assert.equal((await db.get('PRAGMA quick_check')).quick_check,'ok');
  assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
  console.log('PASS guided tasks: task wait and cursor, direct claim, progress recovery, structured blocking, review evidence access, meeting outcome and exact retry, authority revocation');
}finally{
  await client?.close();
  if(listener?.listening)await network?.close(listener);
  await graph.close();
  await fs.rm(dir,{recursive:true,force:true});
}

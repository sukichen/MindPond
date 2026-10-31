import {AsyncLocalStorage} from 'node:async_hooks';
import type {GraphMemory} from './graph-memory.js';
import type {MemoryOwner} from './memory-owners.js';
import {memoryAccess,type MemoryActor,type MemoryAuthority} from './memory-access.js';
import {MindPondError} from './errors.js';

// An explicit list prevents future administrative/identity tools from inheriting this grant.
const reads=new Set(['memory_brief','memory_search','memory_get','memory_directory','memory_connections','memory_association_get','memory_spaces','memory_host_snapshot','memory_expand','memory_neighborhood','memory_trace','memory_event_search','memory_history','memory_edit_history','memory_profile_get','memory_profile_history','memory_export','memory_improvement_list','memory_organization_policy','memory_organization_candidates','memory_organization_requests','memory_organization_request_status','memory_organization_request_events','memory_source_get']);
const writes=new Set(['memory_save','memory_save_validate','memory_update','memory_delete','memory_use_report','memory_membership_add','memory_association_upsert','memory_association_review','memory_association_delete','memory_edit_restore','memory_improvement_resolve','memory_finish','memory_organization_claim','memory_organization_validate','memory_organization_commit','memory_organization_renew','memory_organization_release','memory_organization_request_start','memory_organization_request_next','memory_organization_request_report','memory_organization_request_finish','memory_organization_request_cancel','memory_source_observe']);
type Scope={actor:MemoryActor;targetRoleId:string;revision:number};
/** One scoped invocation, including its asynchronous write hooks. Concurrent calls
 * cannot exchange targets. The authenticated actor and normal defaults never change. */
export class RoleMemoryDelegation{
 private calls=new AsyncLocalStorage<Scope>();
 constructor(private graph:GraphMemory,private authority:MemoryAuthority|undefined){}
 private active(actor:MemoryActor){const scope=this.calls.getStore();if(scope&&(scope.actor.kind!==actor.kind||scope.actor.id!==actor.id))throw new MindPondError('scope_denied','Delegation cannot change the authenticated actor');return scope;}
 async context(actor:MemoryActor,officeId?:string){
  const scope=this.active(actor),access=memoryAccess(this.graph,actor,this.authority);
  if(!scope)return access.context(officeId);
  if(officeId!==undefined)throw new MindPondError('invalid_input','A delegated call selects one role’s private knowledge; omit officeId');
  return access.delegatedContext(scope.targetRoleId,scope.revision);
 }
 target(actor:MemoryActor,officeId?:string):MemoryOwner{
  const scope=this.active(actor);if(scope&&officeId!==undefined)throw new MindPondError('invalid_input','Delegated saves cannot publish into an office');
  return scope?{kind:'agent',id:scope.targetRoleId}:officeId?{kind:'office',id:officeId}:actor;
 }
 operatorAll(actor:MemoryActor){return actor.kind==='user'&&!this.active(actor);}
 stageHost(actor:MemoryActor){const scope=this.active(actor);return actor.kind+':'+actor.id+(scope?':curate:'+scope.targetRoleId:'');}
 async writable(actor:MemoryActor,target:MemoryOwner,memoryId?:string){
  const scope=this.active(actor),access=memoryAccess(this.graph,actor,this.authority);
  if(!scope)return access.assertWritable(target,memoryId);
  if(target.kind!=='agent'||target.id!==scope.targetRoleId)throw new MindPondError('scope_denied','This delegated call can modify only its explicitly selected role’s private knowledge');
  await access.delegation(scope.targetRoleId,true,scope.revision);
 }
 check(tool:string){if(this.calls.getStore()&&!reads.has(tool)&&!writes.has(tool))throw new MindPondError('scope_denied','This operation is outside delegated knowledge access',{nextAction:'Choose a knowledge read/organization operation. Delegation never grants identity, continuity, office, script or permission administration.'});}
 async run(actor:MemoryActor,targetRoleId:string,tool:string,args:unknown,guard:()=>Promise<void>,execute:(name:string,args:unknown,actor:MemoryActor,guard:()=>Promise<void>)=>Promise<unknown>){
  if(this.calls.getStore())throw new MindPondError('invalid_input','Nested role delegation is not allowed');
  if(!reads.has(tool)&&!writes.has(tool))throw new MindPondError('scope_denied','Choose an actual knowledge read or organization operation; wrappers and administrative tools are not delegated');
  await guard();const permission=await memoryAccess(this.graph,actor,this.authority).delegation(targetRoleId,writes.has(tool));
  const scope={actor,targetRoleId,revision:permission.revision};
  return this.calls.run(scope,async()=>{
   const authorized=async()=>{await guard();await memoryAccess(this.graph,actor,this.authority).delegation(targetRoleId,writes.has(tool),scope.revision);};
   let outcome='failed';
   try{const result=await execute(tool,args,actor,authorized);await authorized();outcome=typeof result==='object'&&result!==null&&'status' in result&&result.status==='partial'?'partial':'completed';return {actor,targetRole:{id:targetRoleId,name:permission.target.name},result};}
   finally{await this.graph.roleMemoryPermissions.audit(actor,targetRoleId,tool,outcome);}
  });
 }
}

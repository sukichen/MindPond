/** Human grants for explicit, owner-scoped knowledge curation. Never role impersonation. */
import {z} from 'zod';
import type {Database} from 'sqlite';
import type {MemoryOwner} from './memory-owners.js';
import type {TrustedCallContext} from './trust.js';
import {MindPondError} from './errors.js';
const id=z.string().uuid();
export const roleMemoryPermissionSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('get'),roleId:id}).strict(),
 z.object({action:z.literal('set'),roleId:id,readOthers:z.boolean(),organizeOthers:z.boolean(),expectedRevision:z.number().int().min(0)}).strict().refine(i=>!i.organizeOthers||i.readOthers,'Organizing requires read permission')
]);
type Actor=Extract<MemoryOwner,{kind:'user'|'agent'}>;
export class RoleMemoryPermissions{
 constructor(private db:Database,private write:<T>(fn:()=>Promise<T>)=>Promise<T>,private clock=Date.now){}
 async init(){await this.db.exec(`CREATE TABLE IF NOT EXISTS role_memory_permissions(
  role_id TEXT PRIMARY KEY REFERENCES character_roles(id) ON DELETE CASCADE,
  read_others INTEGER NOT NULL CHECK(read_others IN (0,1)),
  organize_others INTEGER NOT NULL CHECK(organize_others IN (0,1) AND organize_others<=read_others),
  revision INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);}
 private async role(roleId:string){const row=await this.db.get<{id:string;name:string;principal:string;state:string}>("SELECT id,name,principal,state FROM character_roles WHERE id=? AND state IN ('active','disabled')",[roleId]);if(!row)throw new MindPondError('not_found','Role is unavailable or merged; refresh the role directory');return row;}
 async get(roleId:string){const row=await this.db.get<{read_others:number;organize_others:number;revision:number;updated_at:number}>('SELECT * FROM role_memory_permissions WHERE role_id=?',[roleId]);return {roleId,readOthers:!!row?.read_others,organizeOthers:!!row?.organize_others,revision:row?.revision??0,updatedAt:row?.updated_at??null};}
 async manage(value:unknown,a?:TrustedCallContext){
  if(!a?.operator||a.expiresAt<=this.clock())throw new MindPondError('scope_denied','Only the human manager can grant or revoke access to other roles’ memories');
  const i=roleMemoryPermissionSchema.parse(value);return this.write(async()=>{
   await this.role(i.roleId);const prior=await this.get(i.roleId);if(i.action==='get')return prior;
   if(prior.readOthers===i.readOthers&&prior.organizeOthers===i.organizeOthers)return {...prior,changed:false};
   if(prior.revision!==i.expectedRevision)throw new MindPondError('stale_version','记忆权限已被调整，请刷新后再操作。');
   const revision=prior.revision+1,at=this.clock();
   await this.db.run('INSERT INTO role_memory_permissions VALUES(?,?,?,?,?) ON CONFLICT(role_id) DO UPDATE SET read_others=excluded.read_others,organize_others=excluded.organize_others,revision=excluded.revision,updated_at=excluded.updated_at',[i.roleId,+i.readOthers,+i.organizeOthers,revision,at]);
   await this.db.run("INSERT INTO role_events(role_id,kind,body,ts) VALUES(?,'memory_permissions_changed',?,?)",[i.roleId,JSON.stringify({readOthers:i.readOthers,organizeOthers:i.organizeOthers,revision}),at]);
   await this.db.run("INSERT INTO memory_action_log(ts,action,reason) VALUES(?,'role_memory_permissions',?)",[at,JSON.stringify({roleId:i.roleId,by:a.principal,readOthers:i.readOthers,organizeOthers:i.organizeOthers,revision})]);
   return {...await this.get(i.roleId),changed:true};
  });
 }
 async authorize(actor:Actor,targetRoleId:string,write=false,expectedRevision?:number){
  const target=await this.role(targetRoleId);
  if(write&&target.state!=='active')throw new MindPondError('scope_denied','This target role is disabled; its retained knowledge is read-only for delegated operations. Ask the human to enable the role before organizing.');
  if(actor.kind==='user')return {target,revision:0};
  const source=await this.role(actor.id),policy=await this.get(actor.id);
  if(source.state!=='active'||source.id===target.id||source.principal!==target.principal||!policy.readOthers||(write&&!policy.organizeOthers))throw new MindPondError('scope_denied','This role is not authorized to '+(write?'organize':'read')+' the selected role’s memories',{nextAction:'Ask the human to enable the required switch in this role’s memory permissions. Choose a different role in the same account; ordinary operations still use your own memories.'});
  if(expectedRevision!==undefined&&policy.revision!==expectedRevision)throw new MindPondError('scope_denied','Memory delegation changed during this operation; no further work is authorized',{nextAction:'Read memory_identity again and retry only within the current human grant.'});
  return {target,revision:policy.revision};
 }
 async directory(actor:Actor,afterId='',limit=20){
  const source=actor.kind==='agent'?await this.role(actor.id):null,policy=source?await this.get(source.id):null;
  if(source&&(source.state!=='active'||!policy?.readOthers))return {roles:[],hasMore:false,nextAfterId:null,notice:'The human has not enabled reading other roles’ memories for this role.'};
  const rows=await this.db.all<Array<{id:string;name:string;state:string;memoryCount:number}>>(`SELECT r.id,r.name,r.state,(SELECT count(*) FROM nodes n JOIN memory_role_namespaces ns ON ns.domain_id=n.domain_id WHERE ns.role_id=r.id AND n.domain_kind='personal') memoryCount FROM character_roles r WHERE r.state IN ('active','disabled') AND r.id>? ${source?'AND r.principal=? AND r.id<>?':''} ORDER BY r.id LIMIT ?`,[afterId,...(source?[source.principal,source.id]:[]),limit+1]);
  return {roles:rows.slice(0,limit).map(r=>({...r,canOrganize:r.state==='active'&&(actor.kind==='user'||!!policy?.organizeOthers)})),hasMore:rows.length>limit,nextAfterId:rows.length>limit?rows[limit-1].id:null};
 }
 /** Reorganizations never transfer a broad human grant to a changed identity. */
 async revoke(roleId:string){const p=await this.get(roleId);if(!p.readOthers&&!p.organizeOthers)return;await this.db.run('UPDATE role_memory_permissions SET read_others=0,organize_others=0,revision=revision+1,updated_at=? WHERE role_id=?',[this.clock(),roleId]);}
 async audit(actor:Actor,targetRoleId:string,tool:string,outcome:string){await this.db.run("INSERT INTO memory_action_log(ts,action,reason) VALUES(?,'role_memory_action',?)",[this.clock(),JSON.stringify({actor,targetRoleId,tool,outcome})]);}
}

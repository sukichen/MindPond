/** Generic immutable file versions. Bytes never enter MCP responses or SQLite. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {constants, type ReadStream} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import type {Readable} from 'node:stream';
import type {Database} from 'sqlite';
import {z} from 'zod';
import type {GraphMemory} from './graph-memory.js';
import type {TrustedCallContext} from './trust.js';
import {MindPondError} from './errors.js';
import {digest} from './growth.js';
const uuid=z.string().uuid(),text=(n:number)=>z.string().trim().min(1).max(n);
export const artifactSchema=z.object({action:z.enum(['prepare','get','list','delete']),artifactId:uuid.optional(),filename:text(240).refine(s=>Buffer.from(s).toString('utf8')===s,'Filename must be well-formed UTF-8').refine(s=>!/[\\/\x00-\x1f\x7f]/.test(s)&&!/[. ]$/.test(s)&&!/^\.+$/.test(s)&&!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s),'Use a filename, not a path or reserved device name').optional(),mime:text(127).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[ \x21-\x7e]*)?$/).optional(),size:z.number().int().nonnegative().safe().optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),scope:z.enum(['role','recipients','office']).optional(),recipients:uuid.array().min(1).max(32).optional(),officeId:text(160).optional(),retentionSeconds:z.number().int().positive().safe().optional(),key:text(256).optional(),afterId:uuid.optional(),limit:z.number().int().min(1).max(20).default(10)}).strict();
type Row=Record<string,any>;
export interface ArtifactLimits {maxFileBytes:number;maxTotalBytes:number;retentionSeconds:number;maxRetentionSeconds:number;uploadSeconds:number}
function integer(name:string,fallback:number){const value=process.env[name];if(value===undefined)return fallback;const n=Number(value);if(!/^\d+$/.test(value)||!Number.isSafeInteger(n)||n<1)throw Error(name+' must be a positive safe integer');return n;}
const err=(code:ConstructorParameters<typeof MindPondError>[0],message:string,field?:string)=>new MindPondError(code,message,{field});
export class OfficeArtifacts{
 readonly limits:ArtifactLimits;
 readonly directory:string;
 private ephemeral:boolean;
 private active=new Map<Promise<unknown>,AbortController>();
 private downloads=new Set<ReadStream>();
 private closing=false;
 constructor(private db:Database,private graph:GraphMemory,private write:<T>(fn:()=>Promise<T>)=>Promise<T>,dbPath:string,private clock=Date.now){
  this.limits={maxFileBytes:integer('MINDPOND_ARTIFACT_MAX_FILE_BYTES',64*1024*1024),maxTotalBytes:integer('MINDPOND_ARTIFACT_MAX_TOTAL_BYTES',2*1024*1024*1024),retentionSeconds:integer('MINDPOND_ARTIFACT_RETENTION_SECONDS',30*86400),maxRetentionSeconds:integer('MINDPOND_ARTIFACT_MAX_RETENTION_SECONDS',365*86400),uploadSeconds:3600};
  if(this.limits.maxFileBytes>this.limits.maxTotalBytes||this.limits.retentionSeconds>this.limits.maxRetentionSeconds||this.limits.maxRetentionSeconds>3650*86400)throw Error('Invalid artifact size or retention limits');
  this.ephemeral=dbPath===':memory:'&&!process.env.MINDPOND_ARTIFACT_DIR;
  this.directory=path.resolve(process.env.MINDPOND_ARTIFACT_DIR??(this.ephemeral?path.join(os.tmpdir(),'mindpond-artifacts-'+randomUUID()):dbPath+'.artifacts'));
 }
 async init(){return this.write(async()=>{await this.db.exec(`
 CREATE TABLE IF NOT EXISTS office_artifacts(id TEXT PRIMARY KEY,owner_role TEXT NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,scope TEXT NOT NULL,office_id TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,upload_expires_at INTEGER NOT NULL,state TEXT NOT NULL,storage_key TEXT,lease_id TEXT,lease_until INTEGER,pending_temp_key TEXT,pending_blob_key TEXT);
 CREATE INDEX IF NOT EXISTS office_artifact_owner ON office_artifacts(owner_role,id);
 CREATE INDEX IF NOT EXISTS office_artifact_office ON office_artifacts(office_id,id);
 CREATE INDEX IF NOT EXISTS office_artifact_expiry ON office_artifacts(state,expires_at);
 CREATE TABLE IF NOT EXISTS office_artifact_recipients(artifact_id TEXT NOT NULL REFERENCES office_artifacts(id),role_id TEXT NOT NULL,PRIMARY KEY(artifact_id,role_id));
 CREATE INDEX IF NOT EXISTS office_artifact_recipient ON office_artifact_recipients(role_id,artifact_id);
 CREATE TABLE IF NOT EXISTS office_artifact_receipts(owner_role TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,artifact_id TEXT NOT NULL,PRIMARY KEY(owner_role,key));
 `);
 try{await fs.lstat(this.directory);await this.ensureDirectory();}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const artifactColumns=await this.db.all<Row[]>('PRAGMA table_info(office_artifacts)');for(const name of ['pending_temp_key','pending_blob_key'])if(!artifactColumns.some(c=>c.name===name))await this.db.exec('ALTER TABLE office_artifacts ADD COLUMN '+name+' TEXT');
 const columns=await this.db.all<Row[]>('PRAGMA table_info(role_messages)');if(!columns.some(c=>c.name==='artifact_refs'))await this.db.exec("ALTER TABLE role_messages ADD COLUMN artifact_refs TEXT NOT NULL DEFAULT '[]'");
 });}
 private async identity(a?:TrustedCallContext){if(this.closing)throw err('temporarily_unavailable','Artifact storage is closing');return (await this.graph.roles.binding(a))!;}
 private filename(key:string){if(!/^[0-9a-f-]{36}\.(?:blob|part)$/.test(key))throw err('internal','Invalid artifact storage record');return path.join(this.directory,key);}
 private async ensureDirectory(){await fs.mkdir(this.directory,{recursive:true,mode:0o700});const stat=await fs.lstat(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw err('internal','Artifact directory must be a private regular directory');if(process.platform!=='win32')await fs.chmod(this.directory,0o700);}
 private async row(id:string){const r=await this.db.get<Row>('SELECT * FROM office_artifacts WHERE id=?',[id]);if(!r)throw err('not_found','Artifact not found for this identity','artifactId');return r;}
 private async roleCanRead(r:Row,role:string,a?:TrustedCallContext){
  if(!await this.db.get("SELECT 1 FROM character_roles WHERE id=? AND state='active'",[role]))return false;
  if(r.scope==='office')return a?(await this.graph.offices.authorizedSeats(a)).some(s=>s.office_id===r.office_id):!!await this.db.get('SELECT 1 FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id WHERE rs.role_id=? AND s.office_id=? AND s.enabled=1',[role,r.office_id]);
  return r.owner_role===role||r.scope==='recipients'&&!!await this.db.get('SELECT 1 FROM office_artifact_recipients WHERE artifact_id=? AND role_id=?',[r.id,role]);
 }
 private async visible(id:string,a?:TrustedCallContext){const b=await this.identity(a),r=await this.row(id);const scoped={...a!,roleId:b.role_id,roleBindingId:b.id,roleBindingEpoch:b.epoch};if(!await this.roleCanRead(r,b.role_id,scoped))throw err('not_found','Artifact not found for this identity','artifactId');return {r,b};}
 private state(r:Row){return ['deleted','expired'].includes(r.state)?r.state:r.expires_at<=this.clock()||r.state==='pending'&&r.upload_expires_at<=this.clock()?'expired':r.state;}
 private ready(r:Row){if(this.state(r)==='expired'||this.state(r)==='deleted')throw err('artifact_unavailable','Artifact has expired or was deleted; messages retain only its reference','artifactId');if(r.state!=='ready')throw err('artifact_not_ready','Host upload has not completed; upload the original bytes and retry','artifactId');}
 private present(r:Row){return {artifactId:r.id,filename:r.filename,mime:r.mime,size:r.size,sha256:r.sha256,scope:r.scope,officeId:r.office_id,state:this.state(r),createdAt:r.created_at,expiresAt:r.expires_at,uploadExpiresAt:r.upload_expires_at,immutable:true};}
 private transfer(r:Row){return {path:'/artifacts/'+r.id+'/content',uploadMethod:'PUT',downloadMethod:'GET',authentication:'Use the host-configured Bearer and the same connection/chat identity as Office MCP. Never put credentials or file bytes into tool arguments.',resume:'An interrupted upload retries the whole file with the same artifactId; partial files are never downloadable.'};}
 async run(value:unknown,a?:TrustedCallContext):Promise<Row>{
  const i=artifactSchema.parse(value);return this.write(async()=>{
   const b=await this.identity(a);a={...a!,roleId:b.role_id,roleBindingId:b.id,roleBindingEpoch:b.epoch};
   if(i.action==='prepare'){
    if(!i.filename||!i.mime||i.size===undefined||!i.sha256||!i.key)throw err('invalid_input','prepare requires filename, mime, size, sha256 and key');
    const scope=i.scope??'role',recipients=[...new Set(i.recipients??[])].sort();
    if(scope==='office'?!i.officeId||recipients.length:scope==='recipients'?!recipients.length||!!i.officeId:!!i.officeId||!!recipients.length)throw err('invalid_input','Choose role (private), recipients with role IDs, or office with officeId; do not mix scopes');
    const retention=i.retentionSeconds??this.limits.retentionSeconds;
    if(retention>this.limits.maxRetentionSeconds)throw err('invalid_input','Requested retention exceeds the configured maximum','retentionSeconds');
    if(i.size>this.limits.maxFileBytes)throw err('payload_too_large','File exceeds the configured per-file byte limit','size');
    const hash=digest({filename:i.filename,mime:i.mime,size:i.size,sha256:i.sha256,scope,officeId:i.officeId??null,recipients,retention});
    const old=await this.db.get<Row>('SELECT * FROM office_artifact_receipts WHERE owner_role=? AND key=?',[b.role_id,i.key]);
    if(old){if(old.hash!==hash)throw err('idempotency_conflict','Artifact key belongs to different content, scope or retention');const {r}=await this.visible(old.artifact_id,a);return {artifact:this.present(r),transfer:this.transfer(r),replayed:true};}
    if(scope==='office'){
     if(!(await this.graph.offices.authorizedSeats(a!)).some(s=>s.office_id===i.officeId))throw err('scope_denied','Current role is not authorized for this office');
     const o=await this.db.get<Row>('SELECT state,deadline FROM offices WHERE id=?',[i.officeId]);if(!o||o.state!=='active'||o.deadline&&o.deadline<=this.clock())throw err('invalid_input','Office must be open to create shared artifacts');
    }
    for(const recipient of recipients){const r=await this.db.get<Row>("SELECT principal FROM character_roles WHERE id=? AND state='active'",[recipient]);if(!r||r.principal!==a!.principal&&!await this.db.get('SELECT 1 FROM role_links WHERE sender=? AND recipient=?',[b.role_id,recipient]))throw err('scope_denied','Recipient is unavailable or requires human-approved cross-account sharing','recipients');}
    const reserved=await this.db.get<Row>("SELECT COALESCE(SUM(size),0) bytes FROM office_artifacts WHERE storage_key IS NOT NULL OR state='pending'");
    if(reserved!.bytes+i.size>this.limits.maxTotalBytes)throw err('payload_too_large','Artifact storage quota reached; remove unused artifacts or ask the operator to adjust limits');
    const count=await this.db.get<Row>("SELECT count(*) n,sum(CASE WHEN state='pending' THEN 1 ELSE 0 END) pending FROM office_artifacts WHERE owner_role=? AND state IN ('pending','ready')",[b.role_id]);if(count!.n>=1024||(count!.pending??0)>=16)throw err('payload_too_large','Role artifact or pending-upload count limit reached; delete unused reservations');
    await this.ensureDirectory();
    const id=randomUUID(),now=this.clock();await this.db.run('INSERT INTO office_artifacts(id,owner_role,filename,mime,size,sha256,scope,office_id,created_at,expires_at,upload_expires_at,state,storage_key,lease_id,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,b.role_id,i.filename,i.mime,i.size,i.sha256,scope,i.officeId??null,now,now+retention*1000,now+this.limits.uploadSeconds*1000,'pending',null,null,null]);
    for(const role of recipients)await this.db.run('INSERT INTO office_artifact_recipients VALUES(?,?)',[id,role]);
    await this.db.run('INSERT INTO office_artifact_receipts VALUES(?,?,?,?)',[b.role_id,i.key,hash,id]);const r=await this.row(id);return {artifact:this.present(r),transfer:this.transfer(r),limits:this.limits};
   }
   if(i.action==='list'){
    const offices=(await this.graph.offices.authorizedSeats(a!)).map(s=>s.office_id);
    const rows=await this.db.all<Row[]>(`SELECT a.* FROM office_artifacts a WHERE a.id>? AND a.state IN ('pending','ready') AND a.expires_at>? AND (a.state='ready' OR a.upload_expires_at>?) AND ((a.scope<>'office' AND (a.owner_role=? OR EXISTS(SELECT 1 FROM office_artifact_recipients p WHERE p.artifact_id=a.id AND p.role_id=?))) OR (a.scope='office' AND a.office_id IN (SELECT value FROM json_each(?)))) ORDER BY a.id LIMIT ?`,[i.afterId??'',this.clock(),this.clock(),b.role_id,b.role_id,JSON.stringify(offices),i.limit+1]);
    const items:Row[]=[];for(const row of rows.slice(0,i.limit)){const item=this.present(row);if(Buffer.byteLength(JSON.stringify([...items,item]))>12000)break;items.push(item);}
    return {artifacts:items,hasMore:rows.length>items.length,nextAfterId:items.at(-1)?.artifactId??i.afterId??null,limits:this.limits};
   }
   if(!i.artifactId)throw err('invalid_input',i.action+' requires artifactId','artifactId');
   if(i.action==='delete'){
    const r=await this.row(i.artifactId);
    if(r.owner_role!==b.role_id){if(!await this.roleCanRead(r,b.role_id,a))throw err('not_found','Artifact not found for this identity','artifactId');throw err('scope_denied','Only the uploading role can delete this artifact');}
    await this.db.run("UPDATE office_artifacts SET state='deleted' WHERE id=?",[r.id]);r.state='deleted';
    return {artifact:this.present(r),cleanup:'New downloads are blocked immediately. Stored bytes are removed by maintenance; a download already in progress may finish. References and compact idempotency tombstones remain.'};
   }
   const {r}=await this.visible(i.artifactId,a);
   return {artifact:this.present(r),transfer:this.transfer(r),recipients:r.scope==='recipients'&&r.owner_role===b.role_id?(await this.db.all<Row[]>('SELECT role_id FROM office_artifact_recipients WHERE artifact_id=? ORDER BY role_id',[r.id])).map(v=>v.role_id):undefined};
  });
 }
 /** Called inside the message transaction: no implicit sharing or ACL expansion. */
 async attach(ids:string[],recipient:string,a?:TrustedCallContext){
  if(ids.length>8||new Set(ids).size!==ids.length)throw err('invalid_input','Use at most eight distinct artifactIds','artifactIds');
  const result=[];
  for(const id of ids){uuid.parse(id);const {r}=await this.visible(id,a);this.ready(r);if(!await this.roleCanRead(r,recipient))throw err('scope_denied','Recipient is not authorized to read this artifact; forwarding never changes its scope','artifactIds');result.push(this.present(r));}
  return result;
 }
 /** External streaming must never hold the shared SQLite transaction queue. */
 async upload(id:string,source:Readable,a:TrustedCallContext,signal:AbortSignal,recheck:()=>Promise<void>){
  const controller=new AbortController();const work=this.performUpload(id,source,a,AbortSignal.any([signal,controller.signal]),recheck);this.active.set(work,controller);try{return await work;}finally{this.active.delete(work);}
 }
 private async performUpload(id:string,source:Readable,a:TrustedCallContext,signal:AbortSignal,recheck:()=>Promise<void>){
  uuid.parse(id);const lease=randomUUID(),storageKey=randomUUID()+'.blob',tempKey=randomUUID()+'.part';
  const {r,b}=await this.write(async()=>{
   const v=await this.visible(id,a);if(v.r.owner_role!==v.b.role_id)throw err('scope_denied','Only the uploading role can transfer bytes to this reservation');
   if(['expired','deleted'].includes(this.state(v.r)))throw err('artifact_unavailable','Upload reservation has expired or was deleted');
   if(v.r.state==='pending'){
    if(v.r.lease_until>this.clock())throw new MindPondError('temporarily_unavailable','This artifact already has an active upload',{retryAfterMs:1000});
    const n=await this.db.get<Row>('SELECT count(*) n FROM office_artifacts WHERE lease_until>?',[this.clock()]);if(n!.n>=4)throw err('temporarily_unavailable','Four uploads are active; retry with the same artifactId');
    // A fresh lease owns fresh paths. Retired attempts are explicitly known, never found by scanning a shared directory.
    for(const key of [v.r.pending_temp_key,v.r.pending_blob_key])if(key&&key!==v.r.storage_key)await this.removeFile(key);
    await this.db.run('UPDATE office_artifacts SET lease_id=?,lease_until=?,pending_temp_key=?,pending_blob_key=? WHERE id=?',[lease,this.clock()+360000,tempKey,storageKey,id]);
   }
   return v;
  });
  let file:Awaited<ReturnType<typeof fs.open>>|undefined;
  const abort=()=>source.destroy(err('temporarily_unavailable','File transfer was cancelled or exceeded its time limit'));
  try{
   signal.throwIfAborted();source.once('error',()=>{});signal.addEventListener('abort',abort,{once:true});
   if(r.state!=='ready'){await this.ensureDirectory();file=await fs.open(this.filename(tempKey),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}
   const digest=createHash('sha256');let size=0;
   for await(const chunk of source.iterator({destroyOnReturn:false})){
    signal.throwIfAborted();const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;
    if(size>r.size||size>this.limits.maxFileBytes)throw err('payload_too_large','Upload is larger than its reservation','size');
    digest.update(bytes);if(file){let offset=0;while(offset<bytes.length){const written=await file.write(bytes,offset,bytes.length-offset);if(!written.bytesWritten)throw err('internal','Artifact write made no progress');offset+=written.bytesWritten;}}
   }
   if(size!==r.size)throw err('invalid_input','Upload size does not match its reservation','size');
   if(digest.digest('hex')!==r.sha256)throw err('checksum_mismatch','Upload SHA-256 does not match its reservation; resend the original bytes','sha256');
   signal.throwIfAborted();if(file){await file.sync();await file.close();file=undefined;}
   await recheck();
   return await this.write(async()=>{
    const current=await this.visible(id,a);if(current.b.id!==b.id||current.b.epoch!==b.epoch)throw err('scope_denied','Role connection changed during upload');
    if(current.r.state==='ready'){this.ready(current.r);return {artifact:this.present(current.r),replayed:true};}
    if(this.state(current.r)!=='pending')throw err('artifact_unavailable','Upload was deleted or expired before completion');
    if(current.r.lease_id!==lease||current.r.lease_until<=this.clock())throw err('stale_lease','Upload lease expired; retry the entire file');
    // Publish under a unique key, never overwrite an existing immutable version.
    await fs.link(this.filename(tempKey),this.filename(storageKey));
    if(process.platform!=='win32'){const directory=await fs.open(this.directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}}
    await this.db.run("UPDATE office_artifacts SET state='ready',storage_key=?,lease_id=NULL,lease_until=NULL WHERE id=?",[storageKey,id]);
    return {artifact:this.present({...current.r,state:'ready'}),replayed:false};
   });
  }finally{
   signal.removeEventListener('abort',abort);await file?.close().catch(()=>{});let removed=false;try{await this.removeFile(tempKey);removed=true;}catch{/* Keep the path for the next maintenance pass. */}
   await this.write(async()=>{
    await this.db.run('UPDATE office_artifacts SET lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?',[id,lease]);
    if(removed)await this.db.run('UPDATE office_artifacts SET pending_temp_key=NULL WHERE id=? AND pending_temp_key=?',[id,tempKey]);
    await this.db.run('UPDATE office_artifacts SET pending_blob_key=NULL WHERE id=? AND storage_key=pending_blob_key',[id]);
   }).catch(()=>{});
   // A link made before a failed commit remains tracked by pending_blob_key for maintenance/retry.
  }
 }
 async download(id:string,a?:TrustedCallContext):Promise<{artifact:Row;stream:ReadStream}>{
  uuid.parse(id);return this.write(async()=>{
   const {r}=await this.visible(id,a);this.ready(r);
   let file:Awaited<ReturnType<typeof fs.open>>|undefined;
   try{file=await fs.open(this.filename(r.storage_key),constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await file.stat();if(!stat.isFile()||stat.size!==r.size)throw err('internal','Artifact bytes are missing or inconsistent; restore storage from a consistent backup');if(process.platform!=='win32')await file.chmod(0o600);const stream=file.createReadStream({autoClose:true});this.downloads.add(stream);stream.once('close',()=>this.downloads.delete(stream));return {artifact:this.present(r),stream};}
   catch(error){await file?.close().catch(()=>{});if(error instanceof MindPondError)throw error;throw err('internal','Artifact bytes are unavailable; ask the operator to inspect storage');}
  });
 }
 private async removeFile(key:string){try{await fs.unlink(this.filename(key));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 /** Reap only this database's recorded paths. Other databases/files in the directory are never touched. */
 async sweep(){
  if(this.closing)return;
  const rows=await this.write(async()=>{
   await this.db.run("UPDATE office_artifacts SET state='expired' WHERE state IN ('pending','ready') AND (expires_at<=? OR (state='pending' AND upload_expires_at<=?))",[this.clock(),this.clock()]);
   await this.db.run("UPDATE office_artifacts SET state='expired' WHERE state IN ('pending','ready') AND ((scope='office' AND NOT EXISTS(SELECT 1 FROM offices WHERE id=office_id)) OR (scope='role' AND NOT EXISTS(SELECT 1 FROM character_roles WHERE id=owner_role)))");
   return this.db.all<Row[]>("SELECT id FROM office_artifacts WHERE ((state IN ('deleted','expired') AND storage_key IS NOT NULL) OR pending_temp_key IS NOT NULL OR pending_blob_key IS NOT NULL) AND (lease_until IS NULL OR lease_until<=?) ORDER BY id LIMIT 100",[this.clock()]);
  });
  for(const row of rows)await this.write(async()=>{
   const r=await this.row(row.id);if(r.lease_until>this.clock())return;
   if(['deleted','expired'].includes(r.state)&&r.storage_key){await this.removeFile(r.storage_key);await this.db.run('UPDATE office_artifacts SET storage_key=NULL WHERE id=?',[r.id]);r.storage_key=null;}
   if(r.pending_temp_key)await this.removeFile(r.pending_temp_key);
   if(r.pending_blob_key&&r.pending_blob_key!==r.storage_key)await this.removeFile(r.pending_blob_key);
   await this.db.run('UPDATE office_artifacts SET pending_temp_key=NULL,pending_blob_key=NULL WHERE id=?',[r.id]);
  });
 }
 async close(){this.closing=true;for(const c of this.active.values())c.abort();for(const stream of this.downloads)stream.destroy();await Promise.allSettled([...this.active.keys()]);if(this.ephemeral)await fs.rm(this.directory,{recursive:true,force:true});}
}

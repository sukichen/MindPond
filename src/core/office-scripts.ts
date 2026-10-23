/** Stored source artifacts only: the server never executes or installs scripts. */
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import type {Database} from 'sqlite';
import type {GraphMemory} from './graph-memory.js';
import type {TrustedCallContext} from './trust.js';
import {MindPondError} from './errors.js';
const id=z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),text=(n:number)=>z.string().trim().min(1).max(n);
export const scriptSchema=z.object({action:z.enum(['list','get','save','delete']),officeId:id.optional(),id:id.optional(),filename:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/).refine(s=>!s.endsWith('.')&&!/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s),'Use a portable filename, not a reserved device name').optional(),description:text(1000).optional(),usage:text(3000).optional(),language:text(40).optional(),content:z.string().max(131072).refine(s=>!s.includes('\0'),'Store text source only, not binary data').optional(),expectedRevision:z.number().int().min(0).optional(),key:text(256).optional(),afterId:id.optional(),offset:z.number().int().min(0).default(0),characters:z.number().int().min(256).max(8000).default(4000),limit:z.number().int().min(1).max(20).default(10),locked:z.boolean().optional()}).strict();
export const managedScriptSchema=scriptSchema.extend({roleId:z.string().uuid().optional()}).strict();
type Row=Record<string,any>;
function fail(code:'invalid_input'|'scope_denied'|'not_found'|'stale_version'|'idempotency_conflict'|'material_over_budget',message:string):never{throw new MindPondError(code,message);}
export class OfficeScripts{
 constructor(private db:Database,private graph:GraphMemory,private write:<T>(fn:()=>Promise<T>)=>Promise<T>,private clock=Date.now){}
 async init(){await this.db.exec(`
 CREATE TABLE IF NOT EXISTS office_scripts(id TEXT PRIMARY KEY,role_id TEXT REFERENCES character_roles(id) ON DELETE CASCADE,office_id TEXT REFERENCES offices(id) ON DELETE CASCADE,filename TEXT NOT NULL,description TEXT NOT NULL,usage TEXT NOT NULL,language TEXT NOT NULL,content TEXT NOT NULL,sha256 TEXT NOT NULL,revision INTEGER NOT NULL,locked INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,CHECK((role_id IS NULL)!=(office_id IS NULL)));
 CREATE INDEX IF NOT EXISTS office_script_role ON office_scripts(role_id,id);
 CREATE INDEX IF NOT EXISTS office_script_room ON office_scripts(office_id,id);
 CREATE TABLE IF NOT EXISTS office_script_receipts(owner TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,script_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(owner,key));
 `);}
 private async scope(i:Row,a?:TrustedCallContext,writing=false){
  const human=!!a?.operator&&a.expiresAt>this.clock(),b=human?null:await this.graph.roles.binding(a),roleId=i.officeId?null:human?i.roleId:b!.role_id;
  if(i.officeId&&i.roleId)fail('invalid_input','Choose either a role library or an office library');if(!i.officeId&&!roleId)fail('invalid_input','Choose a role library');
  const owner=i.officeId?'office:'+i.officeId:'role:'+roleId;
  if(i.officeId){const o=await this.db.get<Row>('SELECT state,deadline FROM offices WHERE id=?',[i.officeId]);if(!o)fail('not_found','Office not found');if(!human&&!(await this.graph.offices.authorizedSeats(a!)).some(s=>s.office_id===i.officeId))fail('scope_denied','Role no longer belongs to this office');if(writing&&!human&&(o.state!=='active'||o.deadline&&o.deadline<=this.clock()))fail('scope_denied','Office script library is read-only while the office is paused or archived');}
  else if(!await this.db.get('SELECT 1 FROM character_roles WHERE id=?',[roleId]))fail('not_found','Role not found');
  return {human,roleId,officeId:i.officeId??null,owner,writer:human?'human':b!.role_id};
 }
 private present(r:Row){const {content,...meta}=r;return {...meta,locked:!!r.locked,bytes:r.bytes??Buffer.byteLength(content)};}
 private async log(id:string,kind:string){await this.db.run('INSERT INTO role_events(role_id,kind,body,ts) VALUES(NULL,?,?,?)',[kind,JSON.stringify({scriptId:id}),this.clock()]);}
 async run(value:unknown,a?:TrustedCallContext):Promise<Row>{const i=(a?.operator?managedScriptSchema:scriptSchema).parse(value);return this.write(async()=>{
  const scope=await this.scope(i,a,['save','delete'].includes(i.action));if(!scope.human&&i.locked!==undefined)fail('scope_denied','Only a human manager can lock or unlock scripts');
  const where='role_id IS ? AND office_id IS ?',params=[scope.roleId,scope.officeId];
  if(i.action==='list'){
   const rows=await this.db.all<Row[]>("SELECT id,role_id,office_id,filename,substr(description,1,200) description,substr(usage,1,100) usage,language,sha256,revision,locked,updated_by,updated_at,length(CAST(content AS BLOB)) bytes FROM office_scripts WHERE "+where+' AND id>? ORDER BY id LIMIT ?',[...params,i.afterId??'',i.limit+1]);
   const records:Row[]=[];for(const row of rows.slice(0,i.limit)){const meta=this.present(row);if(Buffer.byteLength(JSON.stringify([...records,meta]))>12000)break;records.push(meta);}return {scripts:records,hasMore:rows.length>records.length,nextAfterId:records.at(-1)?.id??i.afterId??'',scope:scope.owner,notice:'Get complete source pages, verify revision and SHA-256, then review before any authorized local execution. Server storage does not install dependencies or grant execution/file/network permissions.'};
  }
  if(i.action!=='save'&&!i.id)fail('invalid_input','Script id is required');
  const row=i.id?await this.db.get<Row>('SELECT * FROM office_scripts WHERE id=? AND '+where,[i.id,...params]):undefined;
  if(i.action==='get'){
   if(!row)fail('not_found','Script not found in this library');if(i.expectedRevision!==undefined&&i.expectedRevision!==row.revision)fail('stale_version','Script changed; restart download at offset 0');if(i.offset>0&&i.expectedRevision===undefined)fail('invalid_input','Continuation requires expectedRevision from the first page');if(i.offset>row.content.length)fail('invalid_input','Offset exceeds script length');
   let end=Math.min(row.content.length,i.offset+i.characters);if(end<row.content.length&&/[\uD800-\uDBFF]/.test(row.content[end-1]))end--;
   return {script:this.present(row),content:row.content.slice(i.offset,end),offset:i.offset,nextOffset:end<row.content.length?end:null,totalCharacters:row.content.length,encoding:'UTF-8 after concatenating all JavaScript-character pages; verify sha256 before saving/executing locally'};
  }
  if(row?.locked&&!scope.human)fail('scope_denied','This script is locked by the human manager');
  if(i.action==='delete'){
   if(!row)fail('not_found','Script not found');if(i.expectedRevision!==row.revision)fail('stale_version','Script changed; read the current revision');await this.db.run('DELETE FROM office_scripts WHERE id=?',[i.id]);await this.db.run('DELETE FROM office_script_receipts WHERE script_id=?',[i.id]);await this.db.run('DELETE FROM office_response_pages');await this.log(i.id!,'script_deleted');return {id:i.id,deleted:true};
  }
  if(!i.filename||!i.description||!i.usage||!i.language||i.content===undefined||i.expectedRevision===undefined||!i.key)fail('invalid_input','Save requires filename,description,usage,language,content,expectedRevision (0=new),key');if(Buffer.byteLength(i.content)>131072)fail('material_over_budget','A script may contain at most 128 KiB of UTF-8 source');
  const hash=createHash('sha256').update(JSON.stringify(i)).digest('hex'),receipt=await this.db.get<Row>('SELECT * FROM office_script_receipts WHERE owner=? AND key=?',[scope.owner,i.key]);if(receipt){if(receipt.hash!==hash)fail('idempotency_conflict','Script save key has another payload');if(!await this.db.get('SELECT 1 FROM office_scripts WHERE id=? AND '+where,[receipt.script_id,...params]))fail('not_found','Saved script was deleted');return {id:receipt.script_id,revision:receipt.revision,replayed:true};}
  if((row?.revision??0)!==i.expectedRevision)fail('stale_version','Script changed; get the current revision before editing');if(i.id&&!row&&i.expectedRevision!==0)fail('not_found','Script no longer exists');
  if(!row&&(await this.db.get<Row>('SELECT COUNT(*) n FROM office_scripts WHERE '+where,params))!.n>=100)fail('invalid_input','At most 100 scripts per library');
  const scriptId=i.id??randomUUID(),revision=i.expectedRevision+1,sha256=createHash('sha256').update(i.content).digest('hex');
  // An ID from another scope must never be turned into an overwrite via UPSERT.
  if(!row&&await this.db.get('SELECT 1 FROM office_scripts WHERE id=?',[scriptId]))fail('not_found','Script id unavailable in this library');
  await this.db.run(`INSERT INTO office_scripts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET filename=excluded.filename,description=excluded.description,usage=excluded.usage,language=excluded.language,content=excluded.content,sha256=excluded.sha256,revision=excluded.revision,locked=excluded.locked,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,[scriptId,scope.roleId,scope.officeId,i.filename,i.description,i.usage,i.language,i.content,sha256,revision,i.locked===undefined?row?.locked??0:Number(i.locked),scope.writer,this.clock()]);
  await this.db.run('INSERT INTO office_script_receipts VALUES(?,?,?,?,?)',[scope.owner,i.key,hash,scriptId,revision]);await this.log(scriptId,'script_saved');return {id:scriptId,revision,sha256};
 });}
}

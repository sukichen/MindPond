/** Bounded immutable SQLite knowledge snapshots. No model/network work under the write lock. */
import {randomUUID,createHash} from 'node:crypto';
import type {Database} from 'sqlite';
import {digest,stableJSON} from './growth.js';
import {MindPondError} from './errors.js';
type Row=Record<string,any>;
export type CloneKnowledge={nodes:Row[];members:Row[];anchors:Row[];sources:Row[];associations:Row[];evidence:Row[];edges:Row[];profiles:Row[];supports:Row[];scripts:Row[];zhVectors?:Row[];profileVectors?:Row[];bodyVersions?:Row[]};
const selected='SELECT value FROM json_each(?)';
export const CLONE_LIMITS={memories:100,scripts:100,bytes:16*1024*1024,children:64,reports:32};
export function encodeKnowledge(bundle:CloneKnowledge){
 const encoded=JSON.stringify(bundle,(_k,v)=>v?.type==='Buffer'&&Array.isArray(v.data)?{$blob:Buffer.from(v.data).toString('base64')}:v);
 if(Buffer.byteLength(encoded)>CLONE_LIMITS.bytes)throw new MindPondError('material_over_budget','Selected capability snapshot exceeds 16 MiB. Select fewer memories/scripts; nothing was dispatched.');
 return encoded;
}
export function decodeKnowledge(text:string):CloneKnowledge{return JSON.parse(text,(_k,v)=>v&&typeof v==='object'&&typeof v.$blob==='string'?Buffer.from(v.$blob,'base64'):v);}
export const contentHash=(text:string)=>createHash('sha256').update(text).digest('hex');
export const assetHash=(r:Row,kind:'memory'|'script')=>digest(kind==='memory'?{content:r.content,dimensions:r.dimensions,dimension:r.dimension,tags:r.tags,importance:r.importance}: {filename:r.filename,description:r.description,usage:r.usage,language:r.language,content:r.content,locked:r.locked});
/** Compare knowledge, not access statistics or derived vector-cache work. */
export async function knowledgeFingerprint(db:Database,id:string,kind:'memory'|'script'){
 const node=await db.get<Row>(kind==='memory'?'SELECT * FROM nodes WHERE id=?':'SELECT * FROM office_scripts WHERE id=?',[id]);
 if(!node)throw new MindPondError('not_found','Private asset disappeared while examining clone changes.');
 if(kind==='script')return assetHash(node,kind);
 const members=await db.all<Row[]>('SELECT id,space_id,memory_type,active,version FROM memory_memberships WHERE memory_id=? ORDER BY id',[id]),ids=JSON.stringify(members.map(m=>m.id));
 return digest({body:assetHash(node,'memory'),verified:node.verified,layer:node.layer,supersededBy:node.superseded_by,members,
  sources:await db.get('SELECT payload FROM memory_sources WHERE memory_id=?',[id]),
  anchors:await db.all('SELECT id,text,basis,space_id,memory_type,status FROM memory_anchors WHERE memory_id=? ORDER BY id',[id]),
  associations:await db.all(`SELECT * FROM memory_associations WHERE member_a_id IN (${selected}) OR member_b_id IN (${selected}) ORDER BY id`,[ids,ids]),
  evidence:await db.all(`SELECT e.* FROM association_evidence e JOIN memory_associations a ON a.id=e.association_id WHERE a.member_a_id IN (${selected}) OR a.member_b_id IN (${selected}) ORDER BY e.association_id,e.id`,[ids,ids]),
  profiles:await db.all(`SELECT * FROM profile_records WHERE membership_id IN (${selected}) ORDER BY membership_id`,[ids]),
  supports:await db.all(`SELECT * FROM profile_supports WHERE profile_id IN (${selected}) ORDER BY profile_id,source_id`,[ids])});
}
export async function captureKnowledge(db:Database,roleId:string,memoryIds:string[],scriptIds:string[]):Promise<CloneKnowledge>{
 if(memoryIds.length>CLONE_LIMITS.memories||scriptIds.length>CLONE_LIMITS.scripts)throw new MindPondError('material_over_budget','Select at most 100 memories and 100 scripts per package.');
 const ns=await db.get<Row>('SELECT domain_id FROM memory_role_namespaces WHERE role_id=?',[roleId]),ids=JSON.stringify(memoryIds);
 const owned=await db.get<Row>(`SELECT count(*) n FROM nodes WHERE id IN (${selected}) AND domain_kind='personal' AND domain_id=? AND dimension<>'event'`,[ids,ns?.domain_id??null]);
 const ownScripts=await db.get<Row>(`SELECT count(*) n FROM office_scripts WHERE id IN (${selected}) AND role_id=?`,[JSON.stringify(scriptIds),roleId]);
 if(owned!.n!==memoryIds.length||ownScripts!.n!==scriptIds.length)throw new MindPondError('not_found','Selected assets must belong to this role’s private knowledge/script library.');
 // Check lengths in SQLite before loading potentially large bodies into the process.
 const size=await db.get<Row>(`SELECT COALESCE(sum(length(CAST(content AS BLOB))+COALESCE(length(embedding),0)),0) bytes FROM nodes WHERE id IN (${selected})`,[ids]);
 const scriptSize=await db.get<Row>(`SELECT COALESCE(sum(length(CAST(content AS BLOB))),0) bytes FROM office_scripts WHERE id IN (${selected})`,[JSON.stringify(scriptIds)]);
 if(size!.bytes+scriptSize!.bytes>CLONE_LIMITS.bytes)throw new MindPondError('material_over_budget','Selected bodies exceed the 16 MiB package limit. Select a smaller set.');
 const nodes=await db.all<Row[]>(`SELECT * FROM nodes WHERE id IN (${selected}) AND domain_kind='personal' AND domain_id=? AND dimension<>'event' ORDER BY id`,[ids,ns?.domain_id??null]);
 const scripts=await db.all<Row[]>(`SELECT * FROM office_scripts WHERE id IN (${selected}) AND role_id=? ORDER BY id`,[JSON.stringify(scriptIds),roleId]);
 if(nodes.length!==memoryIds.length||scripts.length!==scriptIds.length)throw new MindPondError('not_found','Selections must be existing private knowledge/scripts belonging to this role. Office/human/other-role data and raw events cannot be exported.');
 let estimatedBytes=size!.bytes+scriptSize!.bytes;
 const reserve=async(sql:string,args:any[])=>{const cost=await db.get<Row>(sql,args);estimatedBytes+=cost?.bytes??0;if(estimatedBytes>CLONE_LIMITS.bytes)throw new MindPondError('material_over_budget','The selected knowledge and evidence exceed the 16 MiB package budget. Select a smaller set.');};
 await reserve(`SELECT count(*)*2048 bytes FROM memory_memberships WHERE memory_id IN (${selected})`,[ids]);
 await reserve(`SELECT sum(length(CAST(text AS BLOB))+length(CAST(basis AS BLOB))+COALESCE(length(embedding),0)+COALESCE(length(zh_embedding),0)+1024) bytes FROM memory_anchors WHERE memory_id IN (${selected})`,[ids]);
 await reserve(`SELECT sum(length(CAST(payload AS BLOB))) bytes FROM memory_sources WHERE memory_id IN (${selected})`,[ids]);
 const members=await db.all<Row[]>(`SELECT * FROM memory_memberships WHERE memory_id IN (${selected}) ORDER BY id`,[ids]),mids=JSON.stringify(members.map(m=>m.id));
 await reserve(`SELECT sum(length(CAST(payload AS BLOB))) bytes FROM profile_records WHERE membership_id IN (${selected})`,[mids]);
 await reserve(`SELECT sum(length(CAST(claim AS BLOB))+length(CAST(context AS BLOB))+256) bytes FROM profile_supports WHERE profile_id IN (${selected})`,[mids]);
 const profiles=await db.all<Row[]>(`SELECT * FROM profile_records WHERE membership_id IN (${selected}) ORDER BY membership_id`,[mids]);
 const supports=await db.all<Row[]>(`SELECT * FROM profile_supports WHERE profile_id IN (${selected}) ORDER BY profile_id,source_id`,[mids]);
 const ownedMembers=new Set(members.map(m=>m.id)),missing=supports.filter(s=>!ownedMembers.has(s.source_id));
 if(missing.length)throw new MindPondError('invalid_input','A selected synthesized profile requires its supporting memories. Include the listed source memories or omit that profile.',{details:{requiredMemoryIds:(await db.all<Row[]>(`SELECT DISTINCT memory_id FROM memory_memberships WHERE id IN (${selected})`,[JSON.stringify(missing.map(s=>s.source_id))])).map(m=>m.memory_id)}});
 await reserve(`SELECT count(*)*1024 bytes FROM memory_associations WHERE member_a_id IN (${selected}) AND member_b_id IN (${selected})`,[mids,mids]);
 const associations=await db.all<Row[]>(`SELECT * FROM memory_associations WHERE member_a_id IN (${selected}) AND member_b_id IN (${selected}) ORDER BY id`,[mids,mids]);
 await reserve(`SELECT sum(length(CAST(payload AS BLOB))) bytes FROM association_evidence WHERE association_id IN (${selected})`,[JSON.stringify(associations.map(a=>a.id))]);
 await reserve(`SELECT sum(length(embedding)+256) bytes FROM memory_profile_vectors WHERE memory_id IN (${selected})`,[ids]);
 await reserve(`SELECT sum(length(CAST(label AS BLOB))+256) bytes FROM edges WHERE from_id IN (${selected}) AND to_id IN (${selected})`,[ids,ids]);
 const evidence=await db.all<Row[]>(`SELECT * FROM association_evidence WHERE association_id IN (${selected}) ORDER BY association_id,id`,[JSON.stringify(associations.map(a=>a.id))]);
 const hasZh=await db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_zh'");
 if(hasZh)await reserve(`SELECT sum(length(embedding)+256) bytes FROM nodes_zh WHERE id IN (${selected})`,[ids]);
 const bundle={nodes,members,profiles,supports,associations,evidence,scripts,
  zhVectors:hasZh?await db.all<Row[]>(`SELECT * FROM nodes_zh WHERE id IN (${selected}) ORDER BY id`,[ids]):[],
  profileVectors:await db.all<Row[]>(`SELECT * FROM memory_profile_vectors WHERE memory_id IN (${selected}) ORDER BY space_key,kind,owner_id,chunk`,[ids]),
  bodyVersions:await db.all<Row[]>(`SELECT * FROM memory_profile_body_versions WHERE memory_id IN (${selected}) ORDER BY memory_id`,[ids]),
  anchors:await db.all<Row[]>(`SELECT * FROM memory_anchors WHERE memory_id IN (${selected}) ORDER BY id`,[ids]),
  sources:await db.all<Row[]>(`SELECT * FROM memory_sources WHERE memory_id IN (${selected}) ORDER BY memory_id`,[ids]),
  edges:await db.all<Row[]>(`SELECT * FROM edges WHERE from_id IN (${selected}) AND to_id IN (${selected}) ORDER BY id`,[ids,ids])};
 encodeKnowledge(bundle);return bundle;
}
/** Only trusted, server-captured rows enter here. All IDs are reissued, all links stay within the copy. */
export async function installKnowledge(db:Database,b:CloneKnowledge,targetRoleId:string,origin:string,now:number){
 const anchorIds=new Map(b.anchors.map(a=>[a.id,randomUUID()]));
 const nodeIds=new Map(b.nodes.map(n=>[n.id,randomUUID()])),members=new Map(b.members.map(m=>[m.id,randomUUID()])),associations=new Map(b.associations.map(a=>[a.id,randomUUID()]));
 const namespace=await db.get<Row>('SELECT domain_id FROM memory_role_namespaces WHERE role_id=?',[targetRoleId]);
 const domain=namespace?.domain_id??'agent:'+targetRoleId;
 if(!namespace&&await db.get("SELECT 1 FROM nodes WHERE domain_kind='personal' AND domain_id=?",[domain]))throw new MindPondError('invalid_input','The target namespace conflicts with unassigned knowledge; ask the human to resolve ownership before copying.');
 await db.run('INSERT OR IGNORE INTO memory_role_namespaces VALUES(?,?)',[targetRoleId,domain]);
 await db.run("INSERT OR IGNORE INTO memory_domains(kind,id,status,created_at,updated_at) VALUES('personal',?,'active',?,?)",[domain,now,now]);
 const insert=async(table:string,row:Row)=>{const keys=Object.keys(row);await db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,keys.map(k=>row[k]));};
 for(const n of b.nodes)await insert('nodes',{...n,id:nodeIds.get(n.id),domain_kind:'personal',domain_id:domain,session_id:null,superseded_by:null,created_at:now,updated_at:now,access_count:0});
 for(const n of b.nodes)if(nodeIds.has(n.superseded_by))await db.run('UPDATE nodes SET superseded_by=? WHERE id=?',[nodeIds.get(n.superseded_by),nodeIds.get(n.id)]);
 for(const m of b.members)await insert('memory_memberships',{...m,id:members.get(m.id),memory_id:nodeIds.get(m.memory_id)});
 for(const a of b.anchors)await insert('memory_anchors',{...a,id:anchorIds.get(a.id),memory_id:nodeIds.get(a.memory_id)});
 for(const n of b.nodes){
  const original=JSON.parse(b.sources.find(s=>s.memory_id===n.id)?.payload??'[]');
  const provenance={uri:'mindpond:memory/'+n.id,revision:String(n.updated_at),fingerprint:'sha256:'+contentHash(n.content),context:origin+'; independent copy, source not modified; inherited claims are not newly verified.'};
  await insert('memory_sources',{memory_id:nodeIds.get(n.id),payload:stableJSON(original.length<64?[...original,provenance]:original)});
  await db.run('INSERT INTO role_knowledge_copies VALUES(?,?,?,?,?,?,?)',[nodeIds.get(n.id),'memory',n.id,n.updated_at,contentHash(n.content),origin,now]);
 }
 for(const a of b.associations){const pair=[members.get(a.member_a_id)!,members.get(a.member_b_id)!].sort();await insert('memory_associations',{...a,id:associations.get(a.id),member_a_id:pair[0],member_b_id:pair[1]});}
 for(const e of b.evidence){const payload=JSON.parse(e.payload),remap=(v:Row)=>({...v,memberAId:members.get(v.memberAId),memberBId:members.get(v.memberBId)});await insert('association_evidence',{...e,association_id:associations.get(e.association_id),payload:stableJSON({...remap(payload),...(payload.review?{review:remap(payload.review)}:{})})});}
 for(const e of b.edges)await insert('edges',{...e,id:randomUUID(),from_id:nodeIds.get(e.from_id),to_id:nodeIds.get(e.to_id)});
 for(const p of b.profiles)await insert('profile_records',{...p,membership_id:members.get(p.membership_id)});
 for(const s of b.supports)await insert('profile_supports',{...s,profile_id:members.get(s.profile_id),source_id:members.get(s.source_id)});
 for(const v of b.zhVectors??[])await insert('nodes_zh',{...v,id:nodeIds.get(v.id)});
 for(const v of b.bodyVersions??[])await insert('memory_profile_body_versions',{...v,memory_id:nodeIds.get(v.memory_id)});
 for(const v of b.profileVectors??[]){const owner=v.kind==='body'?nodeIds.get(v.owner_id):anchorIds.get(v.owner_id);if(owner)await insert('memory_profile_vectors',{...v,memory_id:nodeIds.get(v.memory_id),owner_id:owner});}
 const scriptIds=new Map<string,string>();
 for(const s of b.scripts){const id=randomUUID();scriptIds.set(s.id,id);await insert('office_scripts',{...s,id,role_id:targetRoleId,office_id:null,revision:1,updated_by:'human',updated_at:now});await db.run('INSERT INTO role_knowledge_copies VALUES(?,?,?,?,?,?,?)',[id,'script',s.id,s.revision,s.sha256,origin,now]);}
 // Existing search indexes notice this generation and reload; model-specific optional indexes rebuild lazily.
 await db.run("UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='index_generation'");
 return {memories:nodeIds,scripts:scriptIds};
}

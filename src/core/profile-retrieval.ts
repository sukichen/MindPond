/** Additive, versioned vector spaces. Legacy vectors remain a rollback target. */
import type { Database } from 'sqlite';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { embeddingSpaceKey,EMBEDDING_PRESETS,loadRetrievalConfig } from './embedding-profiles.js';
import type { EmbeddingProfile,EmbeddingRuntime,RetrievalConfig,RetrievalConfigInput,RerankerProfile } from './embedding-profiles.js';
import { LocalProfileEncoder,profileArtifactDigest } from './profile-embedding.js';
import type { ProfileEncoder } from './profile-embedding.js';
import { ProfileVectorIndex } from './profile-vector-index.js';
import { MindPondError } from './errors.js';
export interface ProfileRetrievalDependencies {
  artifactDigest?:(profile:EmbeddingProfile)=>Promise<string>;
  encoder?:(profile:EmbeddingProfile,runtime:EmbeddingRuntime)=>ProfileEncoder;
  rerank?:(profile:RerankerProfile,query:string,documents:string[])=>Promise<number[]>;
}
interface ConfiguredProfile {profile:EmbeddingProfile;runtime:EmbeddingRuntime;spaceKey?:string;artifactDigest?:string;error?:string;encoder?:ProfileEncoder}
interface Material {id:string;memoryId:string;kind:'body'|'anchor';text:string;version:string;snapshot?:string}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const unpack=(blob:Buffer)=>Array.from({length:blob.length/4},(_,i)=>blob.readFloatLE(i*4));
export class ProfileRetrieval {
  private configured=new Map<string,ConfiguredProfile>();
  private config!:RetrievalConfig;
  private builds=new Map<string,Promise<unknown>>();
  private indexes=new Map<string,{generation:string;body:ProfileVectorIndex;anchor:ProfileVectorIndex}>();
  private stopped=false;
  private buildTail:Promise<unknown>=Promise.resolve();
  private inferenceTail:Promise<unknown>=Promise.resolve();
  private queuedInference=0;
  private reranker?:{id:string;encoder:LocalProfileEncoder};
  constructor(private db:Database,private write:<T>(work:()=>Promise<T>)=>Promise<T>,private input?:RetrievalConfigInput,private dependencies:ProfileRetrievalDependencies={}){}
  async init(){
    this.stopped=false;this.configured.clear();this.config=await loadRetrievalConfig(this.input);
    await this.db.exec(`CREATE TABLE IF NOT EXISTS memory_embedding_spaces (
      space_key TEXT PRIMARY KEY, definition TEXT NOT NULL, created_at INTEGER NOT NULL,generation INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS memory_profile_vectors (
        space_key TEXT NOT NULL REFERENCES memory_embedding_spaces(space_key),
        kind TEXT NOT NULL CHECK(kind IN ('body','anchor')), owner_id TEXT NOT NULL,
        memory_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, chunk INTEGER NOT NULL,
        version TEXT NOT NULL, embedding BLOB NOT NULL,
        PRIMARY KEY(space_key,kind,owner_id,chunk));
      CREATE INDEX IF NOT EXISTS memory_profile_vectors_owner ON memory_profile_vectors(memory_id);
      CREATE TABLE IF NOT EXISTS memory_profile_body_versions (
        memory_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, version INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS profile_body_changed AFTER UPDATE OF content ON nodes
      WHEN OLD.content!=NEW.content BEGIN
        INSERT INTO memory_profile_body_versions VALUES (NEW.id,1) ON CONFLICT(memory_id) DO UPDATE SET version=version+1;
        DELETE FROM memory_profile_vectors WHERE memory_id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS profile_anchor_deleted AFTER DELETE ON memory_anchors
      BEGIN DELETE FROM memory_profile_vectors WHERE kind='anchor' AND owner_id=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS profile_anchor_changed AFTER UPDATE OF text,basis,status,content_hash ON memory_anchors
      BEGIN DELETE FROM memory_profile_vectors WHERE kind='anchor' AND owner_id=NEW.id; END;`);
    const columns=await this.db.all<Array<{name:string}>>('PRAGMA table_info(memory_embedding_spaces)');
    if(!columns.some(column=>column.name==='generation'))await this.db.exec('ALTER TABLE memory_embedding_spaces ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    await this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS profile_vector_inserted AFTER INSERT ON memory_profile_vectors
      BEGIN UPDATE memory_embedding_spaces SET generation=generation+1 WHERE space_key=NEW.space_key; END;
      CREATE TRIGGER IF NOT EXISTS profile_vector_deleted AFTER DELETE ON memory_profile_vectors
      BEGIN UPDATE memory_embedding_spaces SET generation=generation+1 WHERE space_key=OLD.space_key; END;
      CREATE TRIGGER IF NOT EXISTS profile_vector_updated AFTER UPDATE OF embedding,version ON memory_profile_vectors
      BEGIN UPDATE memory_embedding_spaces SET generation=generation+1 WHERE space_key=NEW.space_key; END;
    `);
    for(const definition of this.config.profiles){
      const entry:ConfiguredProfile={...definition};this.configured.set(entry.profile.id,entry);
      try{
        const digest=await (this.dependencies.artifactDigest??profileArtifactDigest)(entry.profile);
        entry.artifactDigest=digest;
        entry.spaceKey=embeddingSpaceKey(entry.profile,digest);
        await this.db.run('INSERT OR IGNORE INTO memory_embedding_spaces(space_key,definition,created_at) VALUES (?,?,?)',[entry.spaceKey,JSON.stringify(entry.profile),Date.now()]);
      }catch{entry.error='model_files_missing_or_unreadable';}
    }
  }
  private entry(id:string){
    const entry=this.configured.get(id);
    if(!entry)throw new MindPondError('invalid_input','Unknown or unconfigured retrieval profile',{field:'retrievalProfile',nextAction:'Read memory_retrieval_profiles; ask the operator to configure a model before selecting it'});
    return entry;
  }
  validateSelection(query:{retrievalProfile?:string;vectorAlgorithm?:string;reranker?:string;embedding?:number[]}){
    if(query.retrievalProfile&&query.retrievalProfile!=='legacy'){
      this.entry(query.retrievalProfile);
      if(query.embedding?.length)throw new MindPondError('invalid_input','Use text queries for configured profiles; unlabelled precomputed vectors cannot select a model space',{field:'embedding'});
    }
    if(query.vectorAlgorithm!==undefined&&!['exact','hnsw'].includes(query.vectorAlgorithm))throw new MindPondError('invalid_input','vectorAlgorithm must be exact or hnsw',{field:'vectorAlgorithm'});
    if(query.reranker&&!this.config.rerankers.some(r=>r.profile.id===query.reranker))throw new MindPondError('invalid_input','Unknown reranker',{field:'reranker'});
  }
  private async materials(entry:ConfiguredProfile,limit:number):Promise<Material[]>{
    const bodies=await this.db.all<Array<{id:string;content:string;version:number}>>(`SELECT n.id,n.content,COALESCE(v.version,0) version FROM nodes n LEFT JOIN memory_profile_body_versions v ON v.memory_id=n.id
      WHERE n.layer!='L0' AND n.superseded_by IS NULL AND NOT EXISTS(SELECT 1 FROM memory_profile_vectors e WHERE e.space_key=? AND e.kind='body' AND e.owner_id=n.id AND e.version=CAST(COALESCE(v.version,0) AS TEXT)) ORDER BY n.rowid LIMIT ?`,[entry.spaceKey,limit]);
    const anchors=await this.db.all<Array<{id:string;memory_id:string;text:string;basis:string;content_hash:string}>>(`SELECT a.id,a.memory_id,a.text,a.basis,a.content_hash FROM memory_anchors a JOIN nodes n ON n.id=a.memory_id
      WHERE a.status='active' AND n.superseded_by IS NULL AND n.layer!='L0' AND EXISTS(SELECT 1 FROM memory_memberships m WHERE m.memory_id=a.memory_id AND m.active=1 AND m.space_id=a.space_id AND m.memory_type=a.memory_type)
      AND NOT EXISTS(SELECT 1 FROM memory_profile_vectors e WHERE e.space_key=? AND e.kind='anchor' AND e.owner_id=a.id AND e.version=a.content_hash) ORDER BY a.rowid LIMIT ?`,[entry.spaceKey,Math.max(0,limit-bodies.length)]);
    return [...bodies.map(row=>({id:row.id,memoryId:row.id,kind:'body' as const,text:row.content,version:String(row.version)})),
      ...anchors.map(row=>({id:row.id,memoryId:row.memory_id,kind:'anchor' as const,text:row.text,version:row.content_hash,snapshot:hash(JSON.stringify([row.text,row.basis,row.content_hash]))}))];
  }
  private async coverage(entry:ConfiguredProfile){
    const body=await this.db.get<{required:number;indexed_count:number}>(`SELECT COUNT(*) required,COALESCE(SUM(EXISTS(SELECT 1 FROM memory_profile_vectors e WHERE e.space_key=? AND e.kind='body' AND e.owner_id=n.id AND e.version=CAST(COALESCE(v.version,0) AS TEXT))),0) indexed_count
      FROM nodes n LEFT JOIN memory_profile_body_versions v ON v.memory_id=n.id WHERE n.layer!='L0' AND n.superseded_by IS NULL`,[entry.spaceKey??'']);
    const anchors=await this.db.get<{required:number;indexed_count:number}>(`SELECT COUNT(*) required,COALESCE(SUM(EXISTS(SELECT 1 FROM memory_profile_vectors e WHERE e.space_key=? AND e.kind='anchor' AND e.owner_id=a.id AND e.version=a.content_hash)),0) indexed_count
      FROM memory_anchors a JOIN nodes n ON n.id=a.memory_id WHERE a.status='active' AND n.layer!='L0' AND n.superseded_by IS NULL
      AND EXISTS(SELECT 1 FROM memory_memberships m WHERE m.memory_id=a.memory_id AND m.active=1 AND m.space_id=a.space_id AND m.memory_type=a.memory_type)` ,[entry.spaceKey??'']);
    const required=body!.required+anchors!.required,indexed=body!.indexed_count+anchors!.indexed_count;
    return {required,indexed,remaining:required-indexed,complete:required===indexed};
  }
  private async activeState(){
    const rows=await this.db.all<Array<{key:string;value:string}>>("SELECT key,value FROM memory_meta WHERE key IN ('active_embedding_space','active_embedding_profile')");
    const value=rows.find(row=>row.key==='active_embedding_space')?.value;
    return value?{value,id:rows.find(row=>row.key==='active_embedding_profile')?.value}:undefined;
  }
  async catalog(){
    const active=await this.activeState();
    const profiles=[];
    for(const entry of this.configured.values()){
      const coverage=await this.coverage(entry);
      profiles.push({id:entry.profile.id,label:entry.profile.label,model:entry.profile.model,dimensions:entry.profile.dimensions,pooling:entry.profile.pooling,dtype:entry.profile.dtype,
        spaceKey:entry.spaceKey,configured:true,coverage,runtime:entry.encoder?.status()??{requestedDevice:entry.runtime.device,actualDevice:'uninitialized'},algorithm:entry.runtime.algorithm,
        building:this.builds.has(entry.profile.id),error:entry.error});
    }
    return {activeProfile:active?.value==='legacy'?'legacy':(profiles.find(p=>p.id===active?.id&&p.spaceKey===active?.value)??profiles.find(p=>p.spaceKey===active?.value))?.id??'legacy',preferredProfile:this.config.defaultProfile,
      profiles:[{id:'legacy',label:'Existing MiniLM + optional BGE mean-pooling',configured:true,compatibility:true},...profiles],
      presets:EMBEDDING_PRESETS,automaticModelDownload:false,
      rerankers:this.config.rerankers.map(r=>({...r.profile,requestedDevice:r.runtime.device,loaded:this.reranker?.id===r.profile.id})),
      guidance:'Choose a configured complete profile for memory_search/memory_brief. An operator builds/activates profiles; model text cannot install models or choose file paths. Profile changes preserve original memories and legacy vectors.'};
  }
  async devices(){
    const ort=await import('onnxruntime-node');
    let nvidia:Array<{name:string;memoryMiB:number}>=[];
    try{
      const {stdout}=await promisify(execFile)('nvidia-smi',['--query-gpu=name,memory.total','--format=csv,noheader,nounits'],{timeout:3000});
      nvidia=stdout.trim().split('\n').filter(Boolean).map(row=>{const [name,memory]=row.split(',');return {name:name.trim(),memoryMiB:Number(memory)};});
    }catch{/* No NVIDIA tools is normal on CPU/other GPU hosts. */}
    return {backends:ort.listSupportedBackends(),nvidia,defaultDevice:'cpu',note:'Bundled backend and GPU inventory do not prove inference works. actualDevice and fallback attempts are reported after a real model call.'};
  }
  private encoder(entry:ConfiguredProfile){
    if(!entry.encoder)entry.encoder=this.dependencies.encoder?.(entry.profile,entry.runtime)??new LocalProfileEncoder(entry.profile,entry.runtime,'embedding',entry.artifactDigest);
    return entry.encoder;
  }
  private async encode(entry:ConfiguredProfile,text:string,role:'query'|'document'|'anchor'){
    if(this.queuedInference>=64)throw new Error('embedding_queue_full');
    this.queuedInference++;
    const work=this.inferenceTail.then(async()=>{
      if(this.stopped)throw new Error('embedding_worker_closed');
      // One resident optional model avoids exhausting small GPUs when several profiles are configured.
      if(this.reranker){await this.reranker.encoder.close();this.reranker=undefined;}
      for(const other of this.configured.values())if(other!==entry&&other.encoder){await other.encoder.close();other.encoder=undefined;}
      return this.encoder(entry).encode(text,role);
    });
    this.inferenceTail=work.catch(()=>{});
    try{return await work;}finally{this.queuedInference--;}
  }
  async build(id:string,maxItems=64):Promise<unknown>{
    if(!Number.isInteger(maxItems)||maxItems<1||maxItems>256)throw new MindPondError('invalid_input','maxItems must be 1–256');
    if(this.stopped)throw new MindPondError('temporarily_unavailable','Embedding builder is closing',{retryable:true});
    if(this.builds.has(id))return this.builds.get(id)!;
    const entry=this.entry(id);
    const work=this.buildTail.then(()=>this.buildBatch(entry,maxItems));this.buildTail=work.catch(()=>{});this.builds.set(id,work);
    try{return await work;}finally{this.builds.delete(id);}
  }
  private async buildBatch(entry:ConfiguredProfile,maxItems:number){
    if(!entry.spaceKey)throw new MindPondError('temporarily_unavailable','Local model files are unavailable',{nextAction:'Install local model files and reopen MindPond; no automatic download is attempted'});
    const missing=await this.materials(entry,maxItems);let completed=0,skipped=0;
    const failures:Array<{kind:string;code:string}>=[];
    for(const material of missing.slice(0,maxItems)){
      if(this.stopped)break;
      try{
        const {vectors}=await this.encode(entry,material.text,material.kind==='body'?'document':'anchor');
        if(!vectors.length || vectors.some(v=>v.length!==entry.profile.dimensions||v.some(x=>!Number.isFinite(x))||!v.some(x=>x!==0)))throw new Error('invalid_model_vector');
        await this.write(async()=>{
          // Original full text + anchor basis/version must still match after slow inference.
          const current=material.kind==='body'?await this.db.get<{content:string;superseded_by:string|null;version:number}>('SELECT n.content,n.superseded_by,COALESCE(v.version,0) version FROM nodes n LEFT JOIN memory_profile_body_versions v ON v.memory_id=n.id WHERE n.id=?',[material.id]):
            await this.db.get<{text:string;basis:string;content_hash:string;status:string}>("SELECT text,basis,content_hash,status FROM memory_anchors WHERE id=?",[material.id]);
          const valid=current && ('content' in current?String(current.version)===material.version&&current.content===material.text:hash(JSON.stringify([current.text,current.basis,current.content_hash]))===material.snapshot);
          if(!current||!valid||'superseded_by' in current&&current.superseded_by||'status' in current&&current.status!=='active'){skipped++;return;}
          await this.db.run('DELETE FROM memory_profile_vectors WHERE space_key=? AND kind=? AND owner_id=?',[entry.spaceKey,material.kind,material.id]);
          for(let chunk=0;chunk<vectors.length;chunk++)await this.db.run('INSERT INTO memory_profile_vectors VALUES (?,?,?,?,?,?,?)',
            [entry.spaceKey,material.kind,material.id,material.memoryId,chunk,material.version,Buffer.from(new Float32Array(vectors[chunk]).buffer)]);
          completed++;
        });
      }catch(error){
        const message=error instanceof Error?error.message:'';
        const code=['document_exceeds_chunk_budget','invalid_model_vector','embedding_timeout','prefix_exceeds_token_budget','model_artifact_changed'].includes(message)?message:'model_or_device_unavailable';
        failures.push({kind:material.kind,code});entry.error=code;
        if(code==='model_or_device_unavailable'||code==='embedding_timeout')break;
      }
    }
    const coverage=await this.coverage(entry);
    if(!failures.length)entry.error=undefined;
    return {profileId:entry.profile.id,completed,skipped,failures,coverage,runtime:this.encoder(entry).status()};
  }
  async activate(id:string){
    return this.write(async()=>{
      let value='legacy';
      if(id!=='legacy'){
        const entry=this.entry(id),coverage=await this.coverage(entry);
        if(!entry.spaceKey||!coverage.complete)throw new MindPondError('temporarily_unavailable','Profile is not completely indexed; the previous profile stays active',{retryable:true,nextAction:'Build remaining body/anchor vectors before activation'});
        value=entry.spaceKey;
      }
      await this.db.run("INSERT INTO memory_meta(key,value) VALUES ('active_embedding_space',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[value]);
      await this.db.run("INSERT INTO memory_meta(key,value) VALUES ('active_embedding_profile',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[id]);
      return {activeProfile:id};
    });
  }
  async select(explicit?:string){
    if(explicit==='legacy')return {id:'legacy',fallback:false};
    const active=await this.activeState();
    const id=explicit??(active?.value&&active.value!=='legacy'?([...this.configured.values()].find(e=>e.profile.id===active.id&&e.spaceKey===active.value)??[...this.configured.values()].find(e=>e.spaceKey===active.value))?.profile.id:this.config.defaultProfile);
    if(!id||id==='legacy')return {id:'legacy',fallback:!!active?.value&&active.value!=='legacy',reason:active?.value&&active.value!=='legacy'?'active_profile_not_configured':undefined};
    const entry=this.entry(id),coverage=await this.coverage(entry);
    if(!entry.spaceKey||!coverage.complete){
      if(explicit)throw new MindPondError('temporarily_unavailable','Selected profile is unavailable or has pending vectors',{retryable:true,field:'retrievalProfile',nextAction:'Select legacy or wait for the operator builder',details:{remaining:coverage.remaining}});
      return {id:'legacy',fallback:true,reason:'profile_build_pending'};
    }
    return {id,fallback:false};
  }
  private async index(entry:ConfiguredProfile,algorithm=entry.runtime.algorithm){
    const cacheKey=`${entry.spaceKey}:${algorithm}:${entry.runtime.efSearch}`;
    const generation=String((await this.db.get<{generation:number}>("SELECT generation FROM memory_embedding_spaces WHERE space_key=?",[entry.spaceKey]))?.generation??0);
    const cached=this.indexes.get(cacheKey);if(cached?.generation===generation)return cached;
    const rows=await this.db.all<Array<{kind:string;owner_id:string;memory_id:string;chunk:number;version:string;embedding:Buffer}>>('SELECT kind,owner_id,memory_id,chunk,version,embedding FROM memory_profile_vectors WHERE space_key=?',[entry.spaceKey]);
    const body=new ProfileVectorIndex(),anchor=new ProfileVectorIndex();
    const vectors=(kind:string)=>rows.filter(r=>r.kind===kind).map(r=>({id:`${r.owner_id}:${r.chunk}`,version:r.version,ownerId:r.kind==='body'?r.memory_id:r.owner_id,vector:unpack(r.embedding)})).filter(r=>r.vector.length===entry.profile.dimensions&&r.vector.every(Number.isFinite));
    const runtime={...entry.runtime,algorithm};
    await body.load(vectors('body'),runtime);await anchor.load(vectors('anchor'),runtime);
    const value={generation,body,anchor};this.indexes.delete(cacheKey);this.indexes.set(cacheKey,value);
    while(this.indexes.size>2)this.indexes.delete(this.indexes.keys().next().value!);
    return value;
  }
  async search(id:string,text:string,eligible:Set<string>,anchorIds:Set<string>,limit:number,algorithm?:'exact'|'hnsw'){
    const entry=this.entry(id);
    const {vectors}=await this.encode(entry,text,'query');
    if(vectors.length!==1||vectors[0].length!==entry.profile.dimensions||vectors[0].some(x=>!Number.isFinite(x))||!vectors[0].some(x=>x!==0))throw new Error('invalid_query_vector');
    // Algorithm selection never changes the embedding-space identity.
    const indexes=await this.index(entry,algorithm);
    return {body:indexes.body.search(vectors[0],eligible,limit*4,0.3),anchors:indexes.anchor.search(vectors[0],anchorIds,limit*4,0.3),
      algorithm:indexes.body.status(),runtime:this.encoder(entry).status()};
  }
  async ownerIds(id:string){
    const entry=this.entry(id);
    const rows=await this.db.all<Array<{memory_id:string}>>("SELECT DISTINCT memory_id FROM memory_profile_vectors WHERE space_key=? AND kind='body'",[entry.spaceKey]);
    return rows.map(row=>row.memory_id);
  }
  async rerank<T extends {node:{content:string};rerankScore?:number}>(id:string,query:string,items:T[]){
    const definition=this.config.rerankers.find(r=>r.profile.id===id);
    if(!definition)throw new MindPondError('invalid_input','Unknown reranker',{field:'reranker'});
    const count=Math.min(items.length,definition.profile.maxCandidates);
    if(count<2)return {items,status:'available' as const,evaluated:0};
    if(this.queuedInference>=64)return {items,status:'failed' as const,evaluated:0,code:'reranker_queue_full'};
    this.queuedInference++;
    const work=this.inferenceTail.then(async()=>{
      if(this.stopped)throw new Error('embedding_worker_closed');
      if(this.dependencies.rerank)return this.dependencies.rerank(definition.profile,query,items.slice(0,count).map(item=>item.node.content));
      for(const entry of this.configured.values())if(entry.encoder){await entry.encoder.close();entry.encoder=undefined;}
      if(this.reranker?.id!==id){
        await this.reranker?.encoder.close();
        const profile:EmbeddingProfile={...definition.profile,dimensions:1,pooling:'cls',normalize:true,queryPrefix:'',documentPrefix:'',anchorInput:'query',maxChunks:1,chunkOverlap:0};
        const artifactDigest=await profileArtifactDigest(profile);
        this.reranker={id,encoder:new LocalProfileEncoder(profile,definition.runtime,'rerank',artifactDigest)};
      }
      const result=await this.reranker.encoder.rerank(query,items.slice(0,count).map(item=>item.node.content));
      return result.vectors.map(v=>v[0]);
    });
    this.inferenceTail=work.catch(()=>{});
    try{
      const scores=await work;
      if(scores.length!==count||scores.some(s=>!Number.isFinite(s)))throw new Error('invalid_reranker_score');
      const ranked=items.slice(0,count).map((item,index)=>({...item,rerankScore:scores[index],originalOrder:index}));
      ranked.sort((a,b)=>b.rerankScore-a.rerankScore||a.originalOrder-b.originalOrder);
      return {items:[...ranked.map(({originalOrder,...item})=>item as unknown as T),...items.slice(count)],status:'available' as const,evaluated:count,tailPreserved:items.length-count};
    }catch{return {items,status:'failed' as const,evaluated:0,code:'reranker_unavailable'};}finally{this.queuedInference--;}
  }
  async startupProfiles(){
    const active=await this.activeState();
    const entries=this.config.buildOnStartup?[...this.configured.values()]:[];
    const selected=active?.value&&active.value!=='legacy'?([...this.configured.values()].find(e=>e.profile.id===active.id&&e.spaceKey===active.value)??[...this.configured.values()].find(e=>e.spaceKey===active.value)):undefined;
    if(selected)entries.unshift(selected);
    const spaces=new Set<string>();
    return entries.filter(entry=>{const key=entry.spaceKey??entry.profile.id;if(spaces.has(key))return false;spaces.add(key);return true;}).map(entry=>entry.profile.id);
  }
  async close(){this.stopped=true;await this.reranker?.encoder.close();this.reranker=undefined;await Promise.all([...this.configured.values()].map(e=>e.encoder?.close()));await Promise.allSettled([...this.builds.values(),this.inferenceTail]);this.indexes.clear();}
}

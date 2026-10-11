import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import { GraphMemory } from '../src/core/graph-memory.js';
import { degreeNeighbours, degreeRepairPlan } from '../src/core/association-degree.js';
import { getEmbeddingService } from '../src/core/embedding.js';
import { signTeamWriteGrant } from '../src/core/domain.js';

process.env.EMBEDDING_ZH_ENABLED='false';
const vector=[1,...Array(383).fill(0)];
const embeddings=getEmbeddingService();
embeddings.generateEmbedding=async()=>vector;

if(process.argv[2]==='--worker') {
  const graph=new GraphMemory('.', {dbPath:process.argv[3]});
  try {
    await graph.init();
    for(const [a,b] of JSON.parse(process.argv[4])) {
      try {await graph.upsertAssociation(a,b,'race','work',0.5);}
      catch(error) {if(!String(error).includes('neighbour limit'))throw error;}
    }
  } finally {await graph.close();}
} else {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-degree-'));
  const dbPath=path.join(dir,'graph.db');
  let graph=new GraphMemory('.',{dbPath});
  const db=await open({filename:dbPath,driver:sqlite3.Database});
  await db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  const create=async(name:string,space='cap')=>{
    const node=await graph.createNode({dimension:'fact',content:name,embedding:vector,
      memberships:[{spaceId:space,memoryType:'work'},{spaceId:space+'-other',memoryType:'work'}]});
    const members=await graph.getMemberships(node.id,{activeOnly:true});
    return {id:node.id,member:members.find(m=>m.spaceId===space)!,other:members.find(m=>m.spaceId===space+'-other')!};
  };
  const link=(a:Awaited<ReturnType<typeof create>>,b:Awaited<ReturnType<typeof create>>,weight:number,other=false)=>
    graph.upsertAssociation(other?a.other.id:a.member.id,other?b.other.id:b.member.id,other?a.other.spaceId:a.member.spaceId,'work',weight);
  try {
    for(const maxDegree of [NaN,Infinity,0])assert.throws(()=>new GraphMemory('.',{maxDegree,dbPath}));
    await graph.init();
    const hub=await create('hub');
    const neighbours=[];
    for(let i=0;i<6;i++) {
      const node=await create('neighbour '+i);neighbours.push(node);
      await (i%2?link(node,hub,0.4+i*0.05):link(hub,node,0.4+i*0.05));
    }
    assert.equal((await degreeNeighbours(db,hub.id)).length,6);
    await link(hub,neighbours[5],0.8,true);
    await graph.upsertEdge(neighbours[5].id,hub.id,'supports',0.8);
    assert.equal((await degreeNeighbours(db,hub.id)).length,6,'duplicate scope/legacy/reverse rows consume one slot');
    const newcomer=await create('newcomer');
    await assert.rejects(link(newcomer,hub,0.4),/neighbour limit/);
    await assert.rejects(link(hub,newcomer,0.3,true),/neighbour limit/);
    await link(newcomer,hub,0.95);
    assert.equal((await degreeNeighbours(db,hub.id)).length,6);
    assert(!(await degreeNeighbours(db,hub.id)).some(n=>n.neighbour===neighbours[0].id));
    assert((await degreeNeighbours(db,hub.id)).some(n=>n.neighbour===newcomer.id));
    await graph.upsertEdge(hub.id,neighbours[0].id,'derived_from',1);
    assert.equal((await degreeNeighbours(db,hub.id)).length,6,'provenance does not consume slots');
    console.log('PASS bidirectional canonical cap, multi-space/legacy deduplication, weak rejection and stronger replacement');

    const left=await create('left'),right=await create('right');
    for(let i=0;i<6;i++) {
      await link(left,await create('left '+i),0.2);
      await link(right,await create('right '+i),0.9);
    }
    const before=await degreeNeighbours(db,left.id);
    await assert.rejects(link(left,right,0.5),/neighbour limit/);
    assert.deepEqual(await degreeNeighbours(db,left.id),before,'second endpoint refusal must not evict first endpoint');
    const total=(await graph.getStats()).total;
    await assert.rejects(graph.saveMemory('atomic save capacity test',{dimensions:['work'],memberships:[{spaceId:'cap',memoryType:'work'}],related:[
      {membershipId:left.member.id,score:0.5,reason:'test relationship',context:'capacity rollback'},
      {membershipId:right.member.id,score:0.5,reason:'test relationship',context:'capacity rollback'},
    ]}),/neighbour limit/);
    assert.equal((await graph.getStats()).total,total);
    assert.deepEqual(await degreeNeighbours(db,left.id),before,'failed save rolls back earlier evictions');
    const oversized=await Promise.all(Array.from({length:7},(_,i)=>create('save oversized '+i)));
    const related=oversized.map(n=>({membershipId:n.member.id,score:0.7,reason:'capacity fixture',context:'oversized save'}));
    const beforeOversized=(await graph.getStats()).total;
    const preview=await graph.validateMemorySave({content:'oversized preview',dimensions:['work'],memberships:[{spaceId:'cap',memoryType:'work'}],related});
    assert.equal(preview.valid,false);assert(preview.related.issues.some(issue=>issue.index===6));
    await assert.rejects(graph.saveMemory('oversized save',{dimensions:['work'],memberships:[{spaceId:'cap',memoryType:'work'}],related}),/distinct neighbour limit/);
    assert.equal((await graph.getStats()).total,beforeOversized);
    console.log('PASS both-endpoint preflight and complete save transaction rollback');

    // Changing a dimension must not revive seven archived neighbours.
    const revival=await graph.saveMemory('revival fixture',{dimensions:['work','environment'],memberships:[{spaceId:'revive',memoryType:'work'}]});
    const environment=revival.memberships.find(m=>m.memoryType==='environment')!;
    await db.run('UPDATE memory_memberships SET active=0 WHERE id=?',[environment.id]);
    for(let i=0;i<7;i++) {
      const target=await graph.saveMemory('revival neighbour '+i,{dimensions:['environment'],memberships:[{spaceId:'revive',memoryType:'environment'}]});
      const [a,b]=[environment.id,target.memberships[0].id].sort();
      await db.run('INSERT INTO memory_associations VALUES (?,?,?,?,?,?,?,?)',['revive-'+i,'revive','environment',a,b,0.7,1,1]);
    }
    const revivalVersion=(await graph.getNodeById(revival.id,{trackAccess:false}))!.updatedAt;
    await assert.rejects(graph.editMemory(revival.id,{dimensions:['work','environment'],expectedUpdatedAt:revivalVersion,reason:'test restoration capacity'}),/Reactivating memberships/);
    assert.equal((await db.get('SELECT active FROM memory_memberships WHERE id=?',[environment.id])).active,0);
    console.log('PASS validation catches oversized saves and dimension restoration cannot bypass capacity');

    process.env.MEMORY_TEAM_AUTH_SECRET=randomBytes(32).toString('hex');
    const teamGrant=signTeamWriteGrant({v:1,authorizationId:'degree-fixture',teamId:'degree-team',requestId:'fixture-user-request',operations:['save'],issuedAt:Date.now()-1000,expiresAt:Date.now()+60000},process.env.MEMORY_TEAM_AUTH_SECRET);
    const privateSource=await create('private reference source','team-reference');
    const teamNodes=[];
    for(let i=0;i<7;i++)teamNodes.push(await graph.saveMemory('team reference '+i,{dimensions:['work'],domain:{kind:'team',id:'degree-team'},teamAuthorization:teamGrant,memberships:[{spaceId:'team-reference',memoryType:'work'}]}));
    const readable={domains:[{kind:'personal' as const,id:'default'},{kind:'team' as const,id:'degree-team'}]};
    const reference=(i:number,weight:number)=>graph.linkTeamReference(privateSource.member.id,teamNodes[i].memberships[0].id,{reason:'fixture knowledge dependency',context:'private reference capacity'},weight,readable);
    for(let i=0;i<6;i++)await reference(i,0.5);
    await assert.rejects(reference(6,0.5),/neighbour limit/);
    await reference(6,0.9);
    assert.equal((await degreeNeighbours(db,privateSource.id)).length,6);
    for(const node of teamNodes)assert.equal((await degreeNeighbours(db,node.id)).length,0,'private incoming references cannot consume or mutate team knowledge');
    console.log('PASS one-way team references share the private budget without backflow or team mutation');

    // Consolidation carries the six strongest neighbours of a combined body.
    const one=await create('organize one','organize'),two=await create('organize two','organize');
    for(let i=0;i<4;i++) {
      await link(one,await create('one '+i,'organize'),0.7+i*0.01);
      await link(two,await create('two '+i,'organize'),0.8+i*0.01);
    }
    const job=await graph.claimOrganizationJob({spaceId:'organize',memoryType:'work',maxMembers:20});assert(job);
    const receipt=await graph.commitOrganizationPlan(job.id,{operations:[{kind:'consolidate',membershipIds:[one.member.id,two.member.id],content:'Combined organization knowledge.',reason:'test neighbour carry'}]});
    assert.equal((await degreeNeighbours(db,receipt.createdMemoryIds[0])).length,6);
    assert.equal((await degreeRepairPlan(db,6)).length,0);
    console.log('PASS consolidation keeps at most six neighbours without restoring archived edges');

    const race=await create('race hub','race'),targets=[];
    for(let i=0;i<16;i++)targets.push(await create('race '+i,'race'));
    const worker=(pairs:string[][])=>new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'--worker',dbPath,JSON.stringify(pairs)],{stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
      child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(output)));
    });
    await Promise.all([worker(targets.slice(0,8).map(n=>[race.member.id,n.member.id])),worker(targets.slice(8).map(n=>[n.member.id,race.member.id]))]);
    assert.equal((await degreeNeighbours(db,race.id)).length,6);
    console.log('PASS independent processes cannot exceed six using opposite directions');

    // Simulate an old DB containing modern overflow and a legacy mirror.
    const old=await create('old overflow','migration'),oldTargets=[];
    for(let i=0;i<9;i++)oldTargets.push(await create('old '+i,'migration'));
    for(let i=0;i<9;i++) {
      const [a,b]=[old.member.id,oldTargets[i].member.id].sort();
      await db.run('INSERT INTO memory_associations VALUES (?,?,?,?,?,?,?,?)',['overflow-'+i,'migration','work',a,b,0.1+i*0.1,1,1]);
    }
    await db.run("INSERT INTO edges VALUES (?, ?, ?, 'related', ?, ?)",['old-mirror',oldTargets[0].id,old.id,0.1,1]);
    await graph.close();
    graph=new GraphMemory('.',{dbPath});await graph.init();
    assert.equal((await degreeNeighbours(db,old.id)).length,6);
    assert.deepEqual((await degreeNeighbours(db,old.id)).map(n=>n.neighbour).sort(),oldTargets.slice(3).map(n=>n.id).sort());
    assert.equal(await db.get('SELECT id FROM edges WHERE id=?',['old-mirror']),undefined);
    const backups=(await fs.readdir(dir)).filter(name=>name.startsWith('.pre-degree-cap-'));assert.equal(backups.length,1);
    const backup=await open({filename:path.join(dir,backups[0],'graph.db'),driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});
    try {assert.equal((await backup.get('SELECT COUNT(*) n FROM memory_associations WHERE id LIKE ?',['overflow-%'])).n,9);}finally{await backup.close();}
    assert.equal((await fs.stat(path.join(dir,backups[0]))).mode&0o777,0o700);
    await graph.close();graph=new GraphMemory('.',{dbPath});await graph.init();
    assert.equal((await degreeNeighbours(db,old.id)).length,6);
    assert.equal((await fs.readdir(dir)).filter(name=>name.startsWith('.pre-degree-cap-')).length,1);
    assert.equal((await db.all('PRAGMA foreign_key_check')).length,0);
    console.log('PASS backed-up strongest-first migration, legacy hard deletion and stable restart');
  } finally {await graph.close();await db.close();await fs.rm(dir,{recursive:true,force:true});}
}

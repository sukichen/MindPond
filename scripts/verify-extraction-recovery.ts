import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import {GraphMemory} from '../src/core/graph-memory.js';
import {MemoryPipelineManager} from '../src/core/memory-pipeline.js';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-extraction-'));
process.env.MEMORY_DB_PATH=path.join(dir,'pond.db');
process.env.EMBEDDING_ZH_ENABLED='false';
let g=new GraphMemory();let pipeline:MemoryPipelineManager|undefined;
const atom={content:'A reusable constraint with explicit scope and an unverified exception.',type:'constraint',priority:5,sourceMessageIds:['msg-0']};
const reply=JSON.stringify({memories:[{...atom,source_message_ids:atom.sourceMessageIds}]});
try {
  await g.init();
  await g.saveMessage('session-a','Identical observation in its own scope','user','message');
  await g.saveMessage('session-b','Identical observation in its own scope','user','message');
  // No in-memory notify survives this restart: durable capture must still be consumed.
  await g.close();g=new GraphMemory();await g.init();
  let calls=0;
  pipeline=new MemoryPipelineManager(g,{chat:async()=>{calls++;return {choices:[{message:{content:reply}}]};}},{everyNConversations:100});
  await pipeline.extractL1();
  assert.equal(calls,2,'extraction must not launch hidden organization LLM calls');
  const memories=await g.getNodesByLayer('L1',20);
  assert.deepEqual(memories.map(m=>m.sessionId).sort(),['session-a','session-b'],'identical facts from different sessions remain separately attributable');
  assert.equal(await g.claimExtractionJob(),null,'injected extraction acknowledges the same durable queue');

  const raw=await g.ingestTranscript('A changed fixture observation','session-c','c');
  const first=await g.claimExtractionJob();assert(first);assert.equal(first.id,raw.extractionJobId);
  const sql=await open({filename:process.env.MEMORY_DB_PATH!,driver:sqlite3.Database});
  try {await sql.run('UPDATE memory_jobs SET lease_expires_at=0 WHERE id=?',[first.id]);}finally{await sql.close();}
  const next=await g.claimExtractionJob();assert(next);assert.equal(next.attempts,first.attempts+1);
  await assert.rejects(g.commitExtractedMemories(first.id,[atom],first.attempts),/stale_extraction_lease/);
  await pipeline.commitExtraction(first.id,'invalid JSON',first.attempts);
  assert.equal((await g.getLeasedExtractionJob(next.id))!.attempts,next.attempts,'late invalid reply cannot release the new lease');
  await assert.rejects(g.commitExtractedMemories(next.id,[atom,{...atom,sourceMessageIds:['msg-99']}],next.attempts),/outside issued job/);
  assert.equal((await g.getNodesByLayer('L1',20)).length,2,'invalid second atom cannot partially commit the first');
  const committed=await pipeline.commitExtraction(next.id,reply,next.attempts);
  assert(committed.completed);assert.deepEqual(await pipeline.commitExtraction(next.id,reply,next.attempts),committed);
  assert.equal((await g.getNodesByLayer('L1',20)).length,3);
  await assert.rejects(g.commitExtractedMemories(next.id,[{...atom,content:'different'}],next.attempts),/idempotency_conflict/);
  assert.equal(await g.claimExtractionJob(),null);
  const rawSkill=await g.ingestTranscript('Preserve the patch before restoring a verified release.','session-skill','skill');
  const skillJob=await g.claimExtractionJob();assert.equal(skillJob!.id,rawSkill.extractionJobId);
  const skillReply=JSON.stringify({memories:[{content:'Preserve the patch before restoring a verified release. Never reset the database.',type:'skill',dimensions:['lesson','skill'],anchors:[{text:'Recovery after a failed self edit',basis:'Never reset the database.',spaceId:'session:session-skill',memoryType:'skill'}],priority:7,source_message_ids:['msg-0']}]});
  assert((await pipeline.commitExtraction(skillJob!.id,skillReply,skillJob!.attempts)).completed);
  const skills=await g.listNodes({sessionId:'session-skill',dimension:'skill'});assert.equal(skills.total,1);
  const detail=await g.getNodeById(skills.nodes[0].id,{trackAccess:false});assert.equal(detail!.anchors?.length,1);
  assert.deepEqual((await g.getMemberships(detail!.id)).map(m=>m.memoryType).sort(),['lesson','skill']);
  assert((await g.pendingOrganizationScopes()).some(s=>s.domain.id==='session-skill' && s.memoryType==='skill'));
  console.log('PASS extraction dimensions, grounded anchors and durable host organization discovery');
  console.log('PASS extraction restart drain, injected/service queue parity, attempt fencing, atomic provenance/receipt, cross-session attribution and no hidden organization');
} finally {pipeline?.stop();await pipeline?.drain();await g.close();await fs.rm(dir,{recursive:true,force:true});}

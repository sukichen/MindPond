import assert from 'node:assert/strict';
import {GraphMemory} from '../dist/core/graph-memory.js';
import {getEmbeddingService} from '../dist/core/embedding.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-domain-review-'));
process.env.MEMORY_DB_PATH=path.join(dir,'test.db');process.env.EMBEDDING_ZH_ENABLED='false';
getEmbeddingService().generateEmbedding=async()=>[1,...Array(383).fill(0)];
const graph=new GraphMemory();
try {
 await graph.init();
 const a=await graph.saveMemory('Durable personal observation.',{dimensions:['fact'],memberships:[{spaceId:'legacy:fact',memoryType:'fact'}]});
 const b=await graph.saveMemory('Only current session observation.',{dimensions:['fact'],domain:{kind:'session',id:'test-current'},sessionId:'test-current',memberships:[{spaceId:'legacy:fact',memoryType:'fact'}]});
 const members=[a.memberships[0].id,b.memberships[0].id].sort();
 await graph.db.run('INSERT INTO memory_associations(id,space_id,memory_type,member_a_id,member_b_id,weight,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',['legacy-edge','legacy:fact','fact',...members,.9,Date.now(),Date.now()]);
 const hits=await graph.search({nodeId:a.id,sessionId:'test-current',maxDepth:2,minScore:.1});
 console.log('REPRODUCTION',JSON.stringify(hits.map(h=>({id:h.node.id,domain:h.node.domain,depth:h.depth,score:h.score}))));
 assert.equal(hits.some(h=>h.node.id===b.id&&h.depth>0),false);
 assert.equal((await graph.listAssociations()).length,0);
 assert.equal((await graph.getFullGraph(20)).edges.length,0);
 assert.equal((await graph.db.get('SELECT count(*) c FROM memory_associations')).c,1,'Historical record must remain intact');
 console.log('PASS legacy cross-domain association excluded from ripple, organization material and graph; original record preserved');
}finally{await graph.close();await fs.rm(dir,{recursive:true,force:true});}

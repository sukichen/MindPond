import assert from 'node:assert/strict';
import {VectorIndex,cosineSimilarity} from '../src/core/vector-index.js';
assert.equal(cosineSimilarity([1,0],[1,0,100]),0,'Different-width vectors cannot be compared by a coincidentally matching prefix');
assert.equal(cosineSimilarity([0,0],[0,0]),0);
assert.equal(cosineSimilarity([1,0],[1,0]),1);
assert.equal(cosineSimilarity([1,0],[-1,0]),-1);
for(const order of [[undefined,0],[0,undefined]]){
 const index=new VectorIndex();index.add({id:'opposite',vector:[-1,0]});
 for(const minScore of order){const hits=index.search([1,0],{topK:10,minScore});assert.equal(hits.length,minScore===undefined?1:0,'Unbounded and nonnegative-score queries need distinct cached results');}
}
const mixed=new VectorIndex();mixed.addBatch([{id:'other-space',vector:[1,0,100]},{id:'same-space',vector:[1,0]}]);
assert.deepEqual(mixed.search([1,0],{topK:10,minScore:.5}).map(r=>r.id),['same-space']);
console.log('PASS vector index: dimensions cannot match by prefix and cached unset/zero thresholds preserve negative-score filtering');

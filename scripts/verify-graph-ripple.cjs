const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const window = {};
const rendererSource = fs.readFileSync(path.join(__dirname, '../web/graph-renderer.js'), 'utf8');
vm.runInNewContext(rendererSource, { window });
const ripple = window.MindPondGraphRenderer.computeWeightedRipple;
const adjacency = new Map();
function connect(from, to, weight) {
  const edge = { fromId: from, toId: to, weight };
  for (const [a, b] of [[from, to], [to, from]]) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    adjacency.get(a).push([b, edge]);
  }
}
connect('A', 'B', .9);
connect('B', 'C', .8);
connect('C', 'E', .8);
connect('A', 'C', .35); // The two-hop path via B is stronger.
connect('A', 'D', .4);
connect('D', 'C', .9); // A cycle must not promote an already reached node.
connect('E', 'F', 0);  // Zero-weight edges must not propagate.

const result = ripple(adjacency, 'A');
const byId = new Map(result.nodes.map(node => [node.id, node]));
assert.deepEqual(Array.from(byId.get('C').path), ['A', 'B', 'C']);
assert.equal(byId.get('C').depth, 2);
assert.ok(Math.abs(byId.get('B').score - .9 * .88) < 1e-10);
assert.ok(Math.abs(byId.get('C').score - .9 * .88 * .8 * .88) < 1e-10);
assert.ok(byId.get('E').score < byId.get('C').score);
assert.ok(byId.get('C').score < byId.get('B').score);
assert.equal(byId.has('F'), false);
assert.equal(result.links.some(link => link.from === 'B' && link.to === 'C' && link.depth === 2), true);
assert.equal(result.maxDepth, 3);
assert.equal(ripple(adjacency, 'A', { maxDepth: 1 }).nodes.some(node => node.id === 'E'), false);
assert.equal(ripple(adjacency, 'A', { minScore: .6 }).nodes.some(node => node.id === 'C'), false);
assert.equal(ripple(adjacency, 'A', { maxNodes: 2 }).nodes.length, 2);
const chain = new Map();
for (let i = 0; i < 30; i++) {
  const edge = { weight: 1 };
  for (const [a, b] of [[String(i), String(i + 1)], [String(i + 1), String(i)]]) {
    if (!chain.has(a)) chain.set(a, []);
    chain.get(a).push([b, edge]);
  }
}
const longRipple = ripple(chain, '0');
assert.ok(longRipple.maxDepth > 5, 'Strong associations should continue beyond five hops');
assert.ok(longRipple.maxDepth < 30, 'Score threshold should stop distant nodes');
assert.ok(longRipple.nodes.every(node => node.score >= .055));
console.log('Weighted graph ripple: multi-hop, decay, strongest path, cycles and bounds PASS');

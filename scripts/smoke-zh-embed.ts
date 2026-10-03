import { pipeline, env } from '@huggingface/transformers';
import path from 'node:path';

env.localModelPath = path.resolve(process.env.EMBEDDING_MODEL_DIR ?? './models');
env.allowLocalModels = true;
env.allowRemoteModels = false;

const extract = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5');
console.log('model loaded OK');

async function embed(text: string): Promise<number[]> {
  const out = await extract(text, { pooling: 'cls', normalize: true });
  return Array.from(out.data);
}

const pairs: Array<[string, string]> = [
  ['水果', '西瓜'],
  ['水果', '苹果'],
  ['喜欢吃的水果', '我喜欢吃西瓜'],
  ['fruit', 'watermelon'],
  ['水果', 'fruit'],
];
const vecs = new Map<string, number[]>();
for (const [a, b] of pairs) {
  if (!vecs.has(a)) vecs.set(a, await embed(a));
  if (!vecs.has(b)) vecs.set(b, await embed(b));
  const va = vecs.get(a)!, vb = vecs.get(b)!;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < va.length; i++) { dot += va[i] * vb[i]; na += va[i] ** 2; nb += vb[i] ** 2; }
  console.log(`${a} vs ${b}: ${(dot / (Math.sqrt(na) * Math.sqrt(nb))).toFixed(4)}`);
}
const v0 = vecs.get('水果')!;
console.log('dims:', v0.length);

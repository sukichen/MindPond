/** Host-authored retrieval entrances. They are indexes, never graph nodes or facts. */
import type { Database } from 'sqlite';
import { MindPondError } from './errors.js';
import { createHash, randomUUID } from 'node:crypto';
import { getEmbeddingService } from './embedding.js';
import { getZhEmbeddingService, isChineseText, zhEnabled } from './embedding-zh.js';
import { cosineSimilarity } from './vector-index.js';

export interface MemoryAnchor {
  text: string;
  /** Exact supporting excerpt from the canonical body, not a generated justification. */
  basis: string;
  spaceId: string;
  memoryType: string;
}
export interface StoredAnchor extends MemoryAnchor {
  id: string;
  status: 'active' | 'needs_review';
}
export interface AnchorMatch { id: string; text: string; channel: string; similarity: number }
type PreparedAnchor = MemoryAnchor & { embedding: number[]; zhEmbedding: number[] };
const fingerprint = (content: string) => createHash('sha256').update(content).digest('hex');
const modelKey = () => getEmbeddingService().getModelName();
const zhModelKey = () => getZhEmbeddingService().getModelName();
const zhNotApplicable = 'not-applicable';
const bytes = (vec: number[]) => vec.length ? Buffer.from(new Float32Array(vec).buffer) : null;
const vector = (blob: Buffer | null): number[] => {
  if (!blob || blob.length % 4) return [];
  return Array.from({ length: blob.length / 4 }, (_, i) => blob.readFloatLE(i * 4));
};

export function normalizeAnchors(input: unknown, content: string, placements: Array<{spaceId:string;memoryType:string}>): MemoryAnchor[] {
  const result = diagnoseAnchors(input, content, placements);
  if (result.issues.length) {
    const issue = result.issues[0];
    throw new MindPondError('invalid_input', issue.constraint, {
      field: anchorIssueField(issue), nextAction: issue.fix,
      details: { issues: result.issues.map(i => ({ ...i, field: anchorIssueField(i) })) },
    });
  }
  return result.anchors;
}

export function anchorIssueField(issue: AnchorIssue): string {
  const field = issue.constraint.match(/anchor\.(text|basis|spaceId|memoryType)/)?.[1];
  return issue.index < 0 ? 'anchors' : `anchors[${issue.index}]${field ? '.' + field : ''}`;
}

export interface AnchorIssue { index: number; constraint: string; fix: string }

/** A02: indexed anchor diagnosis for the validate preview — never throws.
 * Mirrors every constraint normalizeAnchors enforces (which keeps its throwing
 * shape for the save path) but reports the array index, the exact constraint
 * and how to fix it, so the host corrects exactly the invalid entries and
 * keeps the valid ones. Batch-level problems use index -1. */
export function diagnoseAnchors(input: unknown, content: string, placements: Array<{spaceId:string;memoryType:string}>): { anchors: MemoryAnchor[]; issues: AnchorIssue[] } {
  const issues: AnchorIssue[] = [];
  if (input === undefined) return { anchors: [], issues };
  if (!Array.isArray(input) || input.length > 6)
    return { anchors: [], issues: [{ index: -1, constraint: 'anchors must contain at most 6 entries', fix: 'send anchors as a JSON array with 0–6 distinct entries' }] };
  const seen = new Set<string>();
  const anchors: MemoryAnchor[] = [];
  input.forEach((a, index) => {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      issues.push({ index, constraint: 'Invalid anchor', fix: 'each anchor needs {text, basis, spaceId, memoryType}' });
      return;
    }
    for (const [field, max] of [['text', 240], ['basis', 1000], ['spaceId', 128], ['memoryType', 128]] as const) {
      if (typeof a[field] !== 'string' || !a[field].trim() || a[field].length > max) {
        issues.push({ index, constraint: `anchor.${field} requires 1–${max} characters`,
          fix: field === 'text' ? 'text is the future question or trigger that should recall this memory'
            : field === 'basis' ? 'basis must be copied verbatim from this content — pick the exact supporting excerpt'
            : 'spaceId/memoryType must name one of the resolved placements returned in this preview' });
        return;
      }
    }
    const anchor = {text:a.text.trim(),basis:a.basis.trim(),spaceId:a.spaceId.trim(),memoryType:a.memoryType.trim()};
    if (!content.includes(anchor.basis)) {
      issues.push({ index, constraint: 'anchor.basis must be an exact excerpt of content',
        fix: 'copy the supporting sentence verbatim from the body — no paraphrase and no stitching across sentences' });
      return;
    }
    if (!placements.some(p => p.spaceId === anchor.spaceId && p.memoryType === anchor.memoryType)) {
      issues.push({ index, constraint: 'anchor must select an active placement of this memory',
        fix: `use one of: ${placements.map(p => `${p.spaceId}/${p.memoryType}`).join(', ') || 'the resolved placements in this preview'}` });
      return;
    }
    const key = JSON.stringify([anchor.spaceId,anchor.memoryType,anchor.text.normalize('NFKC').toLowerCase().replace(/\s+/g,' ')]);
    if (seen.has(key)) {
      issues.push({ index, constraint: 'Duplicate anchor in the same placement', fix: 'remove the duplicate or make the trigger text distinct' });
      return;
    }
    seen.add(key);
    anchors.push(anchor);
  });
  return { anchors, issues };
}

export class AnchorStore {
  private generation = '';
  private cachedRows: any[] = [];
  constructor(private db: Database, private write: <T>(work:()=>Promise<T>)=>Promise<T> = work=>work()) {}
  async init() {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS memory_anchors (
      id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      text TEXT NOT NULL, basis TEXT NOT NULL, space_id TEXT NOT NULL, memory_type TEXT NOT NULL,
      content_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      embedding BLOB, embedding_model TEXT, zh_embedding BLOB, zh_model TEXT
    );
    CREATE INDEX IF NOT EXISTS memory_anchors_owner ON memory_anchors(memory_id);
    CREATE TRIGGER IF NOT EXISTS memory_anchors_content_changed AFTER UPDATE OF content ON nodes
    WHEN OLD.content != NEW.content BEGIN
      UPDATE memory_anchors SET status='needs_review' WHERE memory_id=NEW.id;
    END;`);
  }
  async prepare(anchors: MemoryAnchor[]): Promise<PreparedAnchor[]> {
    const out: PreparedAnchor[] = [];
    for (const a of anchors) out.push({...a,
      embedding:await getEmbeddingService().generateEmbedding(a.text).catch(()=>[]),
      zhEmbedding:zhEnabled() && isChineseText(a.text) ? await getZhEmbeddingService().generateEmbedding(a.text).catch(()=>[]) : [],
    });
    return out;
  }
  /** Caller owns the transaction, authorization and optimistic concurrency check. */
  async replace(memoryId: string, content: string, anchors: PreparedAnchor[], scope?: {spaceId:string;memoryType:string}) {
    if (scope) {
      const other=await this.db.get<{n:number}>('SELECT COUNT(*) AS n FROM memory_anchors WHERE memory_id=? AND NOT(space_id=? AND memory_type=?)',[memoryId,scope.spaceId,scope.memoryType]);
      if ((other?.n ?? 0)+anchors.length>6) throw new Error('anchors exceed the memory-wide limit of 6; review other placements first');
      await this.db.run('DELETE FROM memory_anchors WHERE memory_id=? AND space_id=? AND memory_type=?',[memoryId,scope.spaceId,scope.memoryType]);
    } else await this.db.run('DELETE FROM memory_anchors WHERE memory_id=?',[memoryId]);
    for (const a of anchors) await this.db.run(`INSERT INTO memory_anchors
      (id,memory_id,text,basis,space_id,memory_type,content_hash,embedding,embedding_model,zh_embedding,zh_model)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[randomUUID(),memoryId,a.text,a.basis,a.spaceId,a.memoryType,fingerprint(content),bytes(a.embedding),modelKey(),bytes(a.zhEmbedding),isChineseText(a.text) ? zhModelKey() : zhNotApplicable]);
  }
  async list(memoryId: string): Promise<StoredAnchor[]> {
    return this.db.all('SELECT id,text,basis,space_id AS spaceId,memory_type AS memoryType,status FROM memory_anchors WHERE memory_id=? ORDER BY rowid',[memoryId]);
  }
  /** Read current DB rows so edits by another process cannot leave stale anchor indexes. */
  async candidates() {
    const generation=String((await this.db.get('SELECT value FROM memory_meta WHERE key=\'index_generation\''))?.value ?? '');
    if (generation===this.generation) return this.cachedRows;
    const rows=await this.db.all<any[]>(`SELECT a.* FROM memory_anchors a
      JOIN nodes n ON n.id=a.memory_id
      JOIN memory_memberships m ON m.memory_id=a.memory_id AND m.space_id=a.space_id AND m.memory_type=a.memory_type
      WHERE a.status='active' AND m.active=1`);
    this.cachedRows=rows.map(row=>({...row,mainVector:vector(row.embedding),zhVector:vector(row.zh_embedding),embedding:undefined,zh_embedding:undefined}));
    this.generation=generation;
    return this.cachedRows;
  }
  async search(query: string, rows: any[], minSimilarity = 0.3, useVectors=true) {
    if (!rows.length) return [];
    const [q,zh] = await Promise.all([
      useVectors?getEmbeddingService().generateEmbedding(query).catch(()=>[]):Promise.resolve([]),
      useVectors && zhEnabled() && isChineseText(query) ? getZhEmbeddingService().generateEmbedding(query).catch(()=>[]) : Promise.resolve([]),
    ]);
    const hits: Array<{memoryId:string;spaceId:string;memoryType:string;match:AnchorMatch}> = [];
    const grams = (text:string) => {
      const s=text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu,'');
      return new Set(s.length<2 ? [s] : Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2)));
    };
    const queryGrams = grams(query);
    for (const row of rows) {
      for (const [channel,queryVec,vec,key,expected] of [
        ['anchor-vector',q,row.mainVector,row.embedding_model,modelKey()],
        ['anchor-zh',zh,row.zhVector,row.zh_model,zhModelKey()],
      ] as const) {
        if (!queryVec.length || key!==expected || vec.length!==queryVec.length) continue;
        const score=cosineSimilarity(queryVec,vec);
        if (Number.isFinite(score) && score>=minSimilarity) hits.push({memoryId:row.memory_id,spaceId:row.space_id,memoryType:row.memory_type,match:{id:row.id,text:row.text,channel,similarity:score}});
      }
      const docGrams=grams(row.text);
      const overlap=[...queryGrams].filter(g=>g && docGrams.has(g)).length;
      const score=2*overlap/(queryGrams.size+docGrams.size || 1);
      if (score>=minSimilarity) hits.push({memoryId:row.memory_id,spaceId:row.space_id,memoryType:row.memory_type,match:{id:row.id,text:row.text,channel:'anchor-text',similarity:score}});
    }
    return hits;
  }
  /** Bounded recovery of vectors written while a model was unavailable. */
  async backfill() {
    const rows=await this.db.all<any[]>(`SELECT a.*,n.content FROM memory_anchors a JOIN nodes n ON n.id=a.memory_id
      WHERE a.status='active' AND (a.embedding IS NULL OR a.embedding_model IS NULL OR a.embedding_model!=? ${zhEnabled() ? "OR (a.zh_model IS NULL OR (a.zh_model!='not-applicable' AND (a.zh_embedding IS NULL OR a.zh_model!=?)))" : ''}) LIMIT 64`,zhEnabled()?[modelKey(),zhModelKey()]:[modelKey()]);
    let completed=0, changedRows=0;
    for (const row of rows) {
      const assignments:string[]=[], values:unknown[]=[];
      let mainReady=!!row.embedding && row.embedding_model===modelKey();
      let zhReady=!zhEnabled() || (!!row.zh_embedding && row.zh_model===zhModelKey());
      if (!mainReady) {
        const vec=await getEmbeddingService().generateEmbedding(row.text).catch(()=>[]);
        if (vec.length) {
          assignments.push('embedding=?','embedding_model=?');values.push(bytes(vec),modelKey());mainReady=true;
        }
      }
      if (zhEnabled() && !isChineseText(row.text)) {
        zhReady=true;
        if (row.zh_model!==zhNotApplicable) {
          assignments.push('zh_embedding=NULL','zh_model=?');values.push(zhNotApplicable);
        }
      } else if (!zhReady) {
        const vec=await getZhEmbeddingService().generateEmbedding(row.text).catch(()=>[]);
        if (vec.length) {
          assignments.push('zh_embedding=?','zh_model=?');values.push(bytes(vec),zhModelKey());zhReady=true;
        }
      }
      // Recover channels independently: one unavailable model must not erase
      // the other model's valid vector. Non-Chinese text needs no ZH backfill.
      if (!assignments.length) continue;
      // IDs change on replacement; body changes mark stale. Never revive either.
      const changed=await this.write(async()=>{
        const changed=await this.db.run(`UPDATE memory_anchors SET ${assignments.join(',')}
        WHERE id=? AND status='active' AND content_hash=?`,[...values,row.id,fingerprint(row.content)]);
        if(changed.changes)await this.db.run("UPDATE memory_meta SET value=CAST(value AS INTEGER)+1 WHERE key='index_generation'");
        return changed;
      });
      if (changed.changes) {
        changedRows++;
        if (mainReady && zhReady) completed++;
      }
    }
    return rows.length===64 && completed===64;
  }
}

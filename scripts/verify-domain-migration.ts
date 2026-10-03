/**
 * M01 verify: domain ownership is one-time, atomic, restorable, and stable.
 *
 * Regression target (roadmap M01 + B02.c reproduction): the legacy backfill
 * used to re-run on every init() and rewrote explicit personal/default rows
 * carrying a source session_id into session domains.  The fixes under test:
 *
 *  1. One-time versioned migration — PRAGMA user_version gates the domain
 *     migration; repeated init / restart / a second instance never re-run it.
 *  2. Source session ≠ ownership — a personal row carrying session_id keeps
 *     its personal domain across every re-open.
 *  3. Failure stops, never partial success — a migration error aborts init()
 *     and leaves the schema untouched (transactional DDL rollback).
 *  4. Restorable backup — a legacy upgrade writes a snapshot first.
 *  5. Audit — historically mis-migrated rows are reported for human review.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { GraphMemory } from '../src/core/graph-memory.js';

const now = Date.now();

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.MEMORY_DB_PATH = path.join(dir, 'pond.db');
  process.env.EMBEDDING_MODEL_DIR = path.join(dir, 'no-models');
  return dir;
}

function newGraph(): GraphMemory {
  return new GraphMemory();
}

async function userVersion(dbFile: string): Promise<number> {
  const raw = await open({ filename: dbFile, driver: sqlite3.Database });
  try {
    const row = await raw.get<{ user_version: number }>('PRAGMA user_version');
    return row?.user_version ?? 0;
  } finally {
    await raw.close();
  }
}

async function nodeColumns(dbFile: string): Promise<Set<string>> {
  const raw = await open({ filename: dbFile, driver: sqlite3.Database });
  try {
    const cols = await raw.all<Array<{ name: string }>>('PRAGMA table_info(nodes)');
    return new Set(cols.map(c => c.name));
  } finally {
    await raw.close();
  }
}

/** Legacy (pre-domain) schema: nodes without domain_kind/domain_id. */
async function seedLegacyDb(dbFile: string, opts: { omitSessionColumn?: boolean } = {}): Promise<void> {
  const raw = await open({ filename: dbFile, driver: sqlite3.Database });
  try {
    const sessionColumn = opts.omitSessionColumn ? '' : '  session_id TEXT,\n';
    await raw.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        dimension TEXT NOT NULL CHECK(dimension IN ('fact','event','decision','lesson')),
        layer TEXT NOT NULL DEFAULT 'L1' CHECK(layer IN ('L0','L1','L2','L3')),
        content TEXT NOT NULL,
        embedding BLOB,
        importance INTEGER NOT NULL DEFAULT 5,
        tags TEXT NOT NULL DEFAULT '[]',
        verified INTEGER DEFAULT 0,
        source TEXT,
${sessionColumn}        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    if (!opts.omitSessionColumn) {
      await raw.run(
        `INSERT INTO nodes (id, dimension, content, layer, tags, source, session_id, created_at, updated_at)
         VALUES ('legacy-session-row', 'event', 'LEGACY_SESSION_TOKEN: old session transcript', 'L0', '[]', 'conversation', 'legacy-s1', ?, ?)`,
        [now, now],
      );
      await raw.run(
        `INSERT INTO nodes (id, dimension, content, layer, tags, source, session_id, created_at, updated_at)
         VALUES ('legacy-unscoped-row', 'fact', 'LEGACY_UNSCOPED_TOKEN: unscoped fact', 'L1', '[]', 'manual', NULL, ?, ?)`,
        [now, now],
      );
    }
  } finally {
    await raw.close();
  }
}

async function readDomain(db: GraphMemory, id: string): Promise<{ kind: string; id: string }> {
  const node = await db.getNodeById(id, { trackAccess: false });
  assert.ok(node, `node ${id} must exist`);
  return { kind: node.domain.kind, id: node.domain.id };
}

// ---------------------------------------------------------------------------
// S1: fresh database — version adoption without any migration work or backup.
// ---------------------------------------------------------------------------
{
  const dir = await makeTempDir('mindpond-dommig-fresh-');
  const dbFile = process.env.MEMORY_DB_PATH!;
  const g = newGraph();
  try {
    await g.init();
    assert.equal(await userVersion(dbFile), 5, 'fresh DB adopts schema version 5');
    assert.equal(await fs.access(`${dbFile}.pre-domain-v5.bak`).then(() => true, () => false), false,
      'fresh DB must not create a migration backup');
  } finally {
    await g.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// S2: legacy upgrade — backfill once, backup restorable, no drift across
// repeated init / restart / second instance.
// ---------------------------------------------------------------------------
{
  const dir = await makeTempDir('mindpond-dommig-legacy-');
  const dbFile = process.env.MEMORY_DB_PATH!;
  const g = newGraph();
  try {
    await seedLegacyDb(dbFile);
    await g.init();

    // Legacy rows migrate conservatively; backfill is exactly the pre-domain
    // shape (session_id present, no explicit ownership yet).
    assert.deepEqual(await readDomain(g, 'legacy-session-row'), { kind: 'session', id: 'legacy-s1' });
    assert.deepEqual(await readDomain(g, 'legacy-unscoped-row'), { kind: 'personal', id: 'default' });
    assert.equal(await userVersion(dbFile), 5, 'legacy upgrade adopts schema version 5');

    // Restorable snapshot of the pre-migration state.
    const backup = path.join(`${dbFile}.pre-domain-v5.bak`);
    assert.equal(await fs.access(backup).then(() => true, () => false), true, 'legacy upgrade writes a backup');
    const raw = await open({ filename: backup, driver: sqlite3.Database });
    try {
      const cols = await raw.all<Array<{ name: string }>>('PRAGMA table_info(nodes)');
      assert.equal(cols.some(c => c.name === 'domain_kind'), false, 'backup holds the pre-domain schema');
      const count = await raw.get<{ n: number }>('SELECT COUNT(*) AS n FROM nodes');
      assert.equal(count?.n, 2, 'backup holds every legacy row');
    } finally {
      await raw.close();
    }

    // The production drift shape: explicit personal ownership carrying a
    // source session_id (public API: domain personal + sessionId metadata).
    const sourced = await g.saveMemory('PERSONAL_SOURCE_TOKEN: durable personal rule captured in session legacy-s1.', {
      domain: { kind: 'personal', id: 'default' },
      sessionId: 'legacy-s1',
      dimension: 'fact',
      source: 'knowledge',
    });
    assert.deepEqual(await readDomain(g, sourced.id), { kind: 'personal', id: 'default' });

    // Second instance over the same file while the first stays open.
    const gB = newGraph();
    try {
      await gB.init();
      assert.deepEqual(await readDomain(gB, sourced.id), { kind: 'personal', id: 'default' },
        'second instance must not rewrite ownership');
    } finally {
      await gB.close();
    }

    // Repeated re-open (restart) must never re-run the backfill.
    await g.close();
    for (let i = 0; i < 3; i++) {
      const again = newGraph();
      try {
        await again.init();
        assert.deepEqual(await readDomain(again, sourced.id), { kind: 'personal', id: 'default' },
          `restart #${i + 1}: personal row with a source session keeps its domain`);
        assert.deepEqual(await readDomain(again, 'legacy-session-row'), { kind: 'session', id: 'legacy-s1' },
          `restart #${i + 1}: legacy session row keeps its domain`);
        assert.equal(await userVersion(dbFile), 5, `restart #${i + 1}: version stays 5 (migration is one-time)`);
      } finally {
        await again.close();
      }
    }
    console.log('PASS: legacy upgrade is one-time, backed up, and drift-free across restart/second instance');
  } finally {
    try { await g.close(); } catch { /* already closed above */ }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// S3: migration failure stops init() with no partial success.
// ---------------------------------------------------------------------------
{
  const dir = await makeTempDir('mindpond-dommig-fail-');
  const dbFile = process.env.MEMORY_DB_PATH!;
  const g = newGraph();
  try {
    // Corrupt legacy shape: backfill references session_id, which is missing —
    // the transaction must roll back (no columns) and init must throw.
    await seedLegacyDb(dbFile, { omitSessionColumn: true });
    await assert.rejects(
      g.init(),
      /domain schema migration failed/,
      'a failed domain migration must stop init() instead of warn-and-continue',
    );
    const cols = await nodeColumns(dbFile);
    assert.equal(cols.has('domain_kind'), false, 'no partial success: domain_kind column rolled back');
    assert.equal(cols.has('domain_id'), false, 'no partial success: domain_id column rolled back');
    assert.equal(await userVersion(dbFile), 0, 'no partial success: version not adopted');
    assert.equal(await fs.access(`${dbFile}.pre-domain-v5.bak`).then(() => true, () => false), true,
      'failed upgrade still leaves the restorable backup behind');
    console.log('PASS: failed migration stops init and leaves schema untouched');
  } finally {
    try { await g.close(); } catch { /* db may be unusable after failed init */ }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// S4: audit reports suspected mis-migrated knowledge for human review.
// ---------------------------------------------------------------------------
{
  const dir = await makeTempDir('mindpond-dommig-audit-');
  const g = newGraph();
  try {
    await g.init();
    // Legitimate pipeline artifact in a session domain — not suspicious.
    await g.saveMemory('PIPELINE_ATOM_TOKEN: session preference atom.', {
      sessionId: 's1', dimension: 'fact', source: 'pipeline', tags: ['l1-atom', 'preference'],
    });
    // The 2026-09 bug rewrote authored standard knowledge into a session
    // domain; this is the shape a human reviewer must see.
    const damaged = await g.saveMemory('DAMAGED_KNOWLEDGE_TOKEN: authored standard knowledge stuck in a session domain.', {
      sessionId: 's9', dimension: 'fact', source: 'knowledge', tags: ['standard-knowledge'],
    });
    // Session transcript (L0) and personal rows are out of scope.  saveMemory
    // cannot author L0 rows, so the transcript is inserted in the production
    // shape (layer L0, conversation source).
    await g.saveMemory('SESSION_HYPOTHESIS_TOKEN: a session-only synthesized note.', {
      sessionId: 's1', dimension: 'decision', source: 'synthesis',
    });
    {
      const raw = await open({ filename: process.env.MEMORY_DB_PATH!, driver: sqlite3.Database });
      try {
        await raw.run(
          `INSERT INTO nodes (id, dimension, layer, content, importance, tags, verified, source, domain_kind, domain_id, session_id, created_at, updated_at)
           VALUES ('l0-transcript-row', 'event', 'L0', 'SESSION_TRANSCRIPT_TOKEN: raw conversation turn.', 3, '[]', 0, 'conversation', 'session', 's1', 's1', ?, ?)`,
          [now, now],
        );
      } finally {
        await raw.close();
      }
    }
    await g.saveMemory('PERSONAL_KNOWLEDGE_TOKEN: correctly owned personal knowledge.', {
      domain: { kind: 'personal', id: 'default' }, source: 'knowledge',
    });

    const suspects = await g.auditSuspectedDomainDrift();
    assert.deepEqual(suspects.map(s => s.id), [damaged.id],
      'audit flags exactly the authored-knowledge-in-session-domain candidate');
    assert.equal(suspects[0].sessionId, 's9');
    console.log('PASS: audit lists suspected mis-migrated rows for human review');
  } finally {
    await g.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

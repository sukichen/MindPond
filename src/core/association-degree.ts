import type { Database } from 'sqlite';

export const ASSOCIATIVE_LABELS = ['related', 'similar-to', 'caused-by', 'fixes', 'supports'];
export const DEFAULT_MAX_ASSOCIATION_DEGREE = 6;
const labels = ASSOCIATIVE_LABELS.map(label => `'${label}'`).join(',');

/** Count canonical neighbours, across directions, memberships and legacy rows.
 * Archived history is not traversable. Private → team references consume only
 * the private source's budget: team recall cannot traverse their incoming side.
 * The endpoint predicates use the association/edge/source membership indexes. */
export async function degreeNeighbours(db: Database, nodeId: string) {
  return db.all<Array<{ neighbour: string; weight: number }>>(`
    SELECT neighbour, MAX(weight) weight FROM (
      SELECT y.memory_id neighbour, a.weight FROM memory_associations a
      JOIN memory_memberships x ON x.id=a.member_a_id
      JOIN memory_memberships y ON y.id=a.member_b_id
      JOIN nodes nx ON nx.id=x.memory_id JOIN nodes ny ON ny.id=y.memory_id
      WHERE a.member_a_id IN (SELECT id FROM memory_memberships WHERE memory_id=?)
        AND x.active=1 AND y.active=1 AND nx.superseded_by IS NULL AND ny.superseded_by IS NULL
      UNION ALL
      SELECT x.memory_id, a.weight FROM memory_associations a
      JOIN memory_memberships x ON x.id=a.member_a_id
      JOIN memory_memberships y ON y.id=a.member_b_id
      JOIN nodes nx ON nx.id=x.memory_id JOIN nodes ny ON ny.id=y.memory_id
      WHERE a.member_b_id IN (SELECT id FROM memory_memberships WHERE memory_id=?)
        AND x.active=1 AND y.active=1 AND nx.superseded_by IS NULL AND ny.superseded_by IS NULL
      UNION ALL
      SELECT to_id, weight FROM edges e JOIN nodes n ON n.id=e.to_id
      WHERE from_id=? AND label IN (${labels}) AND n.superseded_by IS NULL
      UNION ALL
      SELECT from_id, weight FROM edges e JOIN nodes n ON n.id=e.from_id
      WHERE to_id=? AND label IN (${labels}) AND n.superseded_by IS NULL
      UNION ALL
      SELECT y.memory_id, r.weight FROM memory_team_references r
      JOIN memory_memberships x ON x.id=r.source_member_id
      JOIN memory_memberships y ON y.id=r.target_member_id JOIN nodes n ON n.id=y.memory_id
      WHERE r.source_member_id IN (SELECT id FROM memory_memberships WHERE memory_id=?)
        AND x.active=1 AND y.active=1 AND n.superseded_by IS NULL
    ) WHERE neighbour!=? GROUP BY neighbour ORDER BY weight, neighbour`,
  [nodeId, nodeId, nodeId, nodeId, nodeId, nodeId]);
}

/** Hard deletion includes every placement and legacy mirror so restart cannot
 * resurrect an evicted neighbour. The audit retains identifiers, not bodies. */
export async function evictDegreeNeighbour(db: Database, nodeId: string, neighbour: string, limit: number, reason: string) {
  const associations = await db.all<Array<{id:string;weight:number}>>(`SELECT a.id,a.weight FROM memory_associations a
    WHERE (a.member_a_id IN (SELECT id FROM memory_memberships WHERE memory_id=?)
      AND a.member_b_id IN (SELECT id FROM memory_memberships WHERE memory_id=?))
      OR (a.member_a_id IN (SELECT id FROM memory_memberships WHERE memory_id=?)
      AND a.member_b_id IN (SELECT id FROM memory_memberships WHERE memory_id=?))`,
  [nodeId, neighbour, neighbour, nodeId]);
  const edges = await db.all<Array<{id:string;weight:number}>>(`SELECT id,weight FROM edges
    WHERE ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) AND label IN (${labels})`,
  [nodeId, neighbour, neighbour, nodeId]);
  // Only private-owned outgoing references may be evicted, never private
  // evidence owned by an incoming reference on a team endpoint.
  const references = await db.all<Array<{id:string;weight:number}>>(`SELECT r.id,r.weight FROM memory_team_references r
    WHERE r.source_member_id IN (SELECT id FROM memory_memberships WHERE memory_id=?)
    AND r.target_member_id IN (SELECT id FROM memory_memberships WHERE memory_id=?)`, [nodeId, neighbour]);
  for (const row of associations) await db.run('DELETE FROM memory_associations WHERE id=?', [row.id]);
  for (const row of edges) await db.run('DELETE FROM edges WHERE id=?', [row.id]);
  for (const row of references) await db.run('DELETE FROM memory_team_references WHERE id=?', [row.id]);
  await db.run(`INSERT INTO memory_action_log(ts,action,node_id,from_id,to_id,reason,domain_kind,domain_id)
    SELECT ?,'association_degree_evicted',id,id,?,?,domain_kind,domain_id FROM nodes WHERE id=?`,
  [Date.now(), neighbour, JSON.stringify({limit, reason, associations, edges, references}), nodeId]);
}

/** Caller owns BEGIN IMMEDIATE. Preflight BOTH endpoints before deleting any
 * relation, so a refusal at the second endpoint cannot damage the first. */
export async function admitDegreeNeighbour(db: Database, a: string, b: string, weight: number, limit: number, oneWay = false) {
  const evictions: Array<[string, string]> = [];
  for (const [node, neighbour] of oneWay ? [[a,b]] : [[a,b],[b,a]]) {
    const neighbours = await degreeNeighbours(db, node);
    if (neighbours.some(row => row.neighbour === neighbour)) continue;
    const needed = neighbours.length - limit + 1;
    if (needed <= 0) continue;
    const weakest = neighbours.slice(0, needed);
    if (weakest.some(row => row.weight >= weight)) return false;
    for (const row of weakest) evictions.push([node, row.neighbour]);
  }
  for (const [node, neighbour] of evictions)
    await evictDegreeNeighbour(db, node, neighbour, limit, `replaced by weight ${weight}`);
  return true;
}

/** Deterministic strongest-first selection of the active graph. Startup only;
 * ordinary writes use indexed endpoint queries rather than scanning the graph. */
export async function degreeRepairPlan(db: Database, limit: number) {
  const rows = await db.all<Array<{a:string;b:string;weight:number;one_way:number}>>(`
    SELECT x.memory_id a,y.memory_id b,a.weight,0 one_way FROM memory_associations a
    JOIN memory_memberships x ON x.id=a.member_a_id JOIN memory_memberships y ON y.id=a.member_b_id
    JOIN nodes nx ON nx.id=x.memory_id JOIN nodes ny ON ny.id=y.memory_id
    WHERE x.active=1 AND y.active=1 AND nx.superseded_by IS NULL AND ny.superseded_by IS NULL
    UNION ALL SELECT e.from_id,e.to_id,e.weight,0 FROM edges e
    JOIN nodes x ON x.id=e.from_id JOIN nodes y ON y.id=e.to_id
    WHERE e.label IN (${labels}) AND x.superseded_by IS NULL AND y.superseded_by IS NULL
    UNION ALL SELECT x.memory_id,y.memory_id,r.weight,1 FROM memory_team_references r
    JOIN memory_memberships x ON x.id=r.source_member_id JOIN memory_memberships y ON y.id=r.target_member_id
    JOIN nodes nx ON nx.id=x.memory_id JOIN nodes ny ON ny.id=y.memory_id
    WHERE x.active=1 AND y.active=1 AND nx.superseded_by IS NULL AND ny.superseded_by IS NULL`);
  const pairs = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    if (row.a === row.b) continue;
    if (!row.one_way && row.a > row.b) [row.a,row.b] = [row.b,row.a];
    const key = JSON.stringify([row.a,row.b,row.one_way]);
    const previous = pairs.get(key);
    if (!previous || previous.weight < row.weight) pairs.set(key,row);
  }
  const degrees = new Map<string, Set<string>>();
  const neighbours = (id:string) => {
    if (!degrees.has(id)) degrees.set(id,new Set());
    return degrees.get(id)!;
  };
  const rejected: Array<{a:string;b:string}> = [];
  for (const row of [...pairs.values()].sort((x,y) => y.weight-x.weight || x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || x.one_way-y.one_way)) {
    const a=neighbours(row.a),b=neighbours(row.b);
    if ((!a.has(row.b) && a.size>=limit) || (!row.one_way && !b.has(row.a) && b.size>=limit)) rejected.push(row);
    else {a.add(row.b);if(!row.one_way)b.add(row.a);}
  }
  return rejected;
}

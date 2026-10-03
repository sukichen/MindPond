import type { Database } from 'sqlite';
/** An optional SQLite capability, not a model or platform-specific dependency.
 * The paged LIKE channel stays complete when FTS5/trigram is unavailable. */
export async function initializeTextIndex(db:Database):Promise<boolean> {
  await db.exec('SAVEPOINT memory_text_init');
  try {
    const hadTriggers=Number((await db.get<{n:number}>("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name IN ('memory_text_insert','memory_text_delete','memory_text_update')"))?.n??0);
    const existed=await db.get("SELECT 1 FROM sqlite_master WHERE name='memory_text'");
    await db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_text USING fts5(content,tags,content='nodes',content_rowid='rowid',tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS memory_text_insert AFTER INSERT ON nodes BEGIN
        INSERT INTO memory_text(rowid,content,tags) VALUES(new.rowid,new.content,new.tags); END;
      CREATE TRIGGER IF NOT EXISTS memory_text_delete AFTER DELETE ON nodes BEGIN
        INSERT INTO memory_text(memory_text,rowid,content,tags) VALUES('delete',old.rowid,old.content,old.tags); END;
      CREATE TRIGGER IF NOT EXISTS memory_text_update AFTER UPDATE OF content,tags ON nodes BEGIN
        INSERT INTO memory_text(memory_text,rowid,content,tags) VALUES('delete',old.rowid,old.content,old.tags);
        INSERT INTO memory_text(rowid,content,tags) VALUES(new.rowid,new.content,new.tags); END;`);
    if(!existed || hadTriggers!==3)await db.run("INSERT INTO memory_text(memory_text) VALUES('rebuild')");
    await db.exec('RELEASE memory_text_init');
    return true;
  } catch {
    await db.exec('ROLLBACK TO memory_text_init; RELEASE memory_text_init');
    // A DB may be reopened by a SQLite build without this capability. Its
    // pre-existing optional triggers must not block ordinary memory writes.
    await db.exec('DROP TRIGGER IF EXISTS memory_text_insert; DROP TRIGGER IF EXISTS memory_text_delete; DROP TRIGGER IF EXISTS memory_text_update;');
    return false;
  }
}
export function trigramExpression(tokens:string[]):string|undefined {
  if(!tokens.length || tokens.some(t=>[...t].length<3))return undefined;
  return tokens.map(t=>'"'+t.replace(/"/g,'""')+'"').join(' OR ');
}

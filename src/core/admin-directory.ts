/** Human directory windows. A cursor expands the loaded prefix, so polling can
 * refresh edited rows, include insertions and drop deletions without stale merges.
 * Exact administrative lookups must never search these bounded directories. */
import type {Database} from 'sqlite';
import {MindPondError} from './errors.js';

export type DirectoryWindows=Partial<Record<'agents'|'projects'|'offices'|'roles'|'pending'|'chats'|'connections',string>>;
const size=50;
export async function adminDirectory(db:Database, select:string, filter:string='1', params:unknown[]=[], through?:string) {
    if(through!==undefined&&(typeof through!=='string'||!through||through.length>512))
        throw new MindPondError('invalid_input','Invalid directory cursor');
    const base=`${select} WHERE ${filter}`;
    const rows=await db.all<Record<string,any>[]>(`SELECT * FROM (${base}) WHERE directory_key<=? OR directory_key IN (SELECT directory_key FROM (${base}) ORDER BY directory_key LIMIT ${size}) ORDER BY directory_key`,[...params,through??'',...params]);
    const total=(await db.get<{n:number}>(`SELECT COUNT(*) n FROM (${base})`,params))!.n;
    const last=rows.at(-1)?.directory_key;
    // The next cursor is the next window's inclusive end, not an offset. Rows
    // deleted/inserted before it cannot shift a page and hide another row.
    const next=await db.all<{directory_key:string}[]>(`SELECT directory_key FROM (${base}) WHERE directory_key>? ORDER BY directory_key LIMIT ${size}`,[...params,last??'']);
    return {rows:rows.map(({directory_key,...row})=>row),page:{total,loaded:rows.length,nextCursor:next.at(-1)?.directory_key??null}};
}

import {migrateOfficeRoleModel} from './office-model-migration.js';
/** Persistent characters bound to an authenticated HTTP-MCP runtime context.
 * Session labels are correlation values, never credentials. Operator approval
 * and mailbox ACLs remain separate from memory-domain grants. */
import type { Database } from 'sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { MindPondError } from './errors.js';
import { digest } from './growth.js';
import type { TrustedCallContext } from './trust.js';
import type { OfficeStore } from './office.js';
import { previewText, jsonBytes } from './office-context.js';
import { messageState } from './office-message-state.js';
import { BUILDING_INSTRUCTIONS } from './office-building.js';
import { deleteRoleData, deleteOfficeData } from './office-deletion.js';

type Row = Record<string, any>;
export const ROLE_INSTRUCTIONS = BUILDING_INSTRUCTIONS;

export function roleRuntimeId(principal: string, connector: string, source: string, label: string) {
  return createHash('sha256').update(JSON.stringify([principal, connector, source, label])).digest('hex');
}
function fail(message: string, code: 'not_found' | 'scope_denied' | 'invalid_input' | 'stale_version' | 'idempotency_conflict'): never {
  throw new MindPondError(code, message, { nextAction: code==='not_found'?'List permitted roles/messages and check the ID before retrying.':code==='invalid_input'?'Correct the request or missing role/session context; this is not a permission grant failure.':'Call role_sync to check this chat’s role and user approval. The host supplies chat identity; never select a role through arguments or read credentials.' });
}
export class RoleStore {
  discussionStatus?:(a?:TrustedCallContext)=>Promise<Row>;
  constructor(private db: Database, private write: <T>(fn: () => Promise<T>) => Promise<T>, private offices: OfficeStore, private clock: () => number = Date.now) {}
  async init() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS character_roles(id TEXT PRIMARY KEY,principal TEXT NOT NULL,name TEXT NOT NULL,introduction TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,primary_seat TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS role_applications(id TEXT PRIMARY KEY,principal TEXT NOT NULL,connector_id TEXT NOT NULL,runtime_id TEXT NOT NULL,mode TEXT NOT NULL,name TEXT NOT NULL,introduction TEXT NOT NULL,reason TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,role_id TEXT,created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS role_application_pending ON role_applications(principal,connector_id,runtime_id) WHERE state='pending';
      CREATE TABLE IF NOT EXISTS role_bindings(id TEXT PRIMARY KEY,principal TEXT NOT NULL,connector_id TEXT NOT NULL,runtime_id TEXT NOT NULL,role_id TEXT NOT NULL REFERENCES character_roles(id),epoch INTEGER NOT NULL,state TEXT NOT NULL,last_seen INTEGER NOT NULL,UNIQUE(principal,connector_id,runtime_id));
      CREATE TABLE IF NOT EXISTS role_receipts(principal TEXT NOT NULL,connector_id TEXT NOT NULL,runtime_id TEXT NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(principal,connector_id,runtime_id,operation,key));
      CREATE TABLE IF NOT EXISTS role_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,role_id TEXT,kind TEXT NOT NULL,body TEXT NOT NULL,ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS role_event_page ON role_events(role_id,seq);
      CREATE TABLE IF NOT EXISTS role_messages(id TEXT PRIMARY KEY,sender TEXT NOT NULL REFERENCES character_roles(id),recipient TEXT NOT NULL REFERENCES character_roles(id),kind TEXT NOT NULL,body TEXT NOT NULL,request_id TEXT,final INTEGER NOT NULL,sender_name TEXT NOT NULL,recipient_name TEXT NOT NULL,office_id TEXT,seq INTEGER NOT NULL REFERENCES role_events(seq),created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS role_message_inbox ON role_messages(recipient,seq);
      CREATE TABLE IF NOT EXISTS role_message_states(message_id TEXT PRIMARY KEY REFERENCES role_messages(id),state TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS role_links(sender TEXT NOT NULL REFERENCES character_roles(id),recipient TEXT NOT NULL REFERENCES character_roles(id),PRIMARY KEY(sender,recipient));
      CREATE TABLE IF NOT EXISTS role_seats(seat_id TEXT PRIMARY KEY REFERENCES office_seats(id),role_id TEXT NOT NULL REFERENCES character_roles(id));
      CREATE TABLE IF NOT EXISTS role_activation_dismissals(runtime_id TEXT PRIMARY KEY,principal TEXT NOT NULL,connector_id TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS role_chat_sessions(runtime_id TEXT PRIMARY KEY,principal TEXT NOT NULL,connector_id TEXT NOT NULL,source TEXT NOT NULL,native_chat_id TEXT NOT NULL,last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS role_connection_requests(id TEXT PRIMARY KEY,principal TEXT NOT NULL,connector_id TEXT NOT NULL,runtime_id TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL);
    `);
    await this.write(async()=>{
      const requestColumns=await this.db.all<Row[]>('PRAGMA table_info(role_connection_requests)');
      if(!requestColumns.some(c=>c.name==='revision'))await this.db.exec('ALTER TABLE role_connection_requests ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
      const roleColumns=await this.db.all<Row[]>('PRAGMA table_info(character_roles)');
      if(roleColumns.some(c=>c.name==='connector_id'))await this.db.exec('ALTER TABLE character_roles DROP COLUMN connector_id');
      await this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS role_one_active_binding ON role_bindings(role_id) WHERE state='active'");
      const columns=await this.db.all<Row[]>('PRAGMA table_info(role_messages)');
      if(!columns.some(c=>c.name==='reply_to'))await this.db.exec('ALTER TABLE role_messages ADD COLUMN reply_to TEXT');
      if(!columns.some(c=>c.name==='metadata'))await this.db.exec("ALTER TABLE role_messages ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
      const states=await this.db.all<Row[]>('PRAGMA table_info(role_message_states)');
      for(const [name,type] of [['taken_at','INTEGER'],['completed_at','INTEGER'],['completion','TEXT']])
        if(!states.some(c=>c.name===name))await this.db.exec(`ALTER TABLE role_message_states ADD COLUMN ${name} ${type}`);
    });
  }
  async migrateModel(){return this.write(()=>migrateOfficeRoleModel(this.db,this.clock()));}
  private actor(a?: TrustedCallContext): TrustedCallContext & { runtimeId: string; agentId: string } {
    if (!a || a.expiresAt <= this.clock() || a.operator || a.transport !== 'http-mcp' || !a.agentId)
      fail('A current authenticated HTTP MCP connector is required', 'scope_denied');
    if(!a.runtimeId)throw new MindPondError('invalid_input','The host must supply this chat’s identity',{nextAction:'Reconnect the host MCP integration, then call role_sync. Configure credentials outside chat.'});
    return a as TrustedCallContext & { runtimeId: string; agentId: string };
  }
  private admin(a?: TrustedCallContext) { if (!a?.operator || a.expiresAt <= this.clock()) fail('Current user management approval required', 'scope_denied'); }
  private async event(roleId: string | null, kind: string, body: unknown) {
    const seq = (await this.db.run('INSERT INTO role_events(role_id,kind,body,ts) VALUES(?,?,?,?)', [roleId, kind, JSON.stringify(body), this.clock()])).lastID!;
    await this.db.run('INSERT INTO memory_action_log(ts,action,node_id,reason) VALUES(?,?,?,?)', [this.clock(), 'collaboration_role_' + kind, null, JSON.stringify({ roleId, seq })]);
    return seq;
  }
  private async receipt<T>(a: TrustedCallContext & { runtimeId: string; agentId: string }, op: string, i: Row, fn: () => Promise<T>): Promise<T> {
    const p = [a.principal, a.agentId, a.runtimeId, op, i.key];
    const old = await this.db.get<Row>('SELECT hash,result FROM role_receipts WHERE principal=? AND connector_id=? AND runtime_id=? AND operation=? AND key=?', p);
    const hash = digest(i);
    if (old) { if (old.hash !== hash) fail('Same operation key has a different payload', 'idempotency_conflict'); return JSON.parse(old.result); }
    const result = await fn();
    await this.db.run('INSERT INTO role_receipts VALUES(?,?,?,?,?,?,?)', [...p, hash, JSON.stringify(result)]);
    return result;
  }
  async binding(a?: TrustedCallContext, required = true): Promise<Row | null> {
    if (a && a.expiresAt <= this.clock()) fail('Trusted context expired', 'scope_denied');
    if (!a?.runtimeId || !a.agentId || a.transport !== 'http-mcp' || a.operator) {
      if (required) this.actor(a);
      return null;
    }
    this.actor(a);
    if (!(await this.offices.agentAuthority(a))) fail('Connector or role binding is no longer authorized', 'scope_denied');
    const b = await this.db.get<Row>('SELECT b.*,r.name,r.introduction,r.state role_state,r.revision profile_revision,r.primary_seat FROM role_bindings b JOIN character_roles r ON r.id=b.role_id WHERE b.principal=? AND b.connector_id=? AND b.runtime_id=?', [a.principal, a.agentId, a.runtimeId]);
    if (!b) { if (required) fail('No approved character for this session; use role_application','invalid_input'); return null; }
    if(b.state!=='active'&&!required&&a.roleId===undefined&&a.roleBindingId===undefined&&a.roleBindingEpoch===undefined)return null;
    if (b.state !== 'active' || b.role_state !== 'active') fail('Character or session binding was disabled by the user', 'scope_denied');
    if ((a.roleId !== undefined && a.roleId !== b.role_id) ||
        (a.roleBindingId !== undefined && a.roleBindingId !== b.id) ||
        (a.roleBindingEpoch !== undefined && a.roleBindingEpoch !== b.epoch)) fail('Character binding changed; refresh identity', 'scope_denied');
    if(this.clock()-b.last_seen>60000)await this.write(async()=>{
      const changed=await this.db.run("UPDATE role_bindings SET last_seen=? WHERE id=? AND epoch=? AND state='active'",[this.clock(),b.id,b.epoch]);
      if(changed.changes)await this.event(b.role_id,'connection_observed',{bindingId:b.id});
    });
    return b;
  }
  private async badge(a: TrustedCallContext, b: Row) {
    return { chat:a.nativeChatId&&['codex_metadata','opencode_metadata'].includes(a.runtimeMode??'')?{source:a.runtimeMode==='codex_metadata'?'codex':'opencode',id:a.nativeChatId}:null,roleId: b.role_id, bindingId: b.id, bindingEpoch: b.epoch, name: b.name, introduction: b.introduction, profileRevision: b.profile_revision, bindingMode: a.runtimeMode ?? 'connection',bindingScope:a.runtimeMode==='credential'?'configured_connection':'chat_correlation', isolation: 'Authenticated connector plus session correlation; shared credentials/configuration do not isolate mutually untrusted chats.', primaryAssignmentId: b.primary_seat ?? null };
  }
  async identity(a?: TrustedCallContext) {
    const b = await this.binding(a, false);
    return b ? this.badge(a!, b) : null;
  }
  async observeChat(a:TrustedCallContext){
    const actor=this.actor(a),source=actor.runtimeMode==='credential'?'connection':actor.runtimeMode==='codex_metadata'?'codex':actor.runtimeMode==='opencode_metadata'?'opencode':null;
    const identifier=source==='connection'?(actor.credentialId??actor.agentId):actor.nativeChatId;
    if(!source||!identifier)return;
    if(roleRuntimeId(actor.principal,actor.agentId,source==='connection'?'credential':source,identifier)!==actor.runtimeId)fail('Native chat correlation does not match the authenticated runtime','invalid_input');
    return this.write(async()=>{
      if(!await this.offices.agentAuthority(actor))fail('Host credential disabled','scope_denied');
      const old=await this.db.get<Row>('SELECT * FROM role_chat_sessions WHERE runtime_id=?',[actor.runtimeId]);
      if(old&&this.clock()-old.last_seen<60000)return;
      await this.db.run('INSERT INTO role_chat_sessions VALUES(?,?,?,?,?,?) ON CONFLICT(runtime_id) DO UPDATE SET last_seen=excluded.last_seen',[actor.runtimeId,actor.principal,actor.agentId,source,identifier,this.clock()]);
      await this.event(null,'chat_observed',{connectorId:actor.agentId});
    });
  }
  async connectionRequest(a:TrustedCallContext){return this.write(async()=>{
    const actor=this.actor(a);if(!await this.offices.agentAuthority(actor))fail('Host credential disabled','scope_denied');if(await this.db.get("SELECT 1 FROM role_bindings b JOIN character_roles r ON r.id=b.role_id WHERE b.runtime_id=? AND b.principal=? AND b.connector_id=? AND b.state='active' AND r.state='active'",[actor.runtimeId,actor.principal,actor.agentId]))return null;
    if(await this.db.get("SELECT 1 FROM role_applications WHERE principal=? AND connector_id=? AND runtime_id=? AND state='pending'",[actor.principal,actor.agentId,actor.runtimeId]))return null;
    await this.db.run('DELETE FROM role_connection_requests WHERE last_seen<?',[this.clock()-86400000]);
    const old=await this.db.get<Row>('SELECT * FROM role_connection_requests WHERE runtime_id=? AND principal=? AND connector_id=?',[actor.runtimeId,actor.principal,actor.agentId]);
    const chat=await this.db.get<Row>('SELECT source,native_chat_id id FROM role_chat_sessions WHERE runtime_id=?',[actor.runtimeId]);
    const dismissed=await this.db.get<Row>('SELECT state FROM role_activation_dismissals WHERE runtime_id=?',[actor.runtimeId]);
    if(dismissed)return {state:dismissed.state,chat:chat??null,notice:'The human dismissed this activation request. Automatic sync will not create another request. Continue without a role unless the user explicitly requests a new role application.'};
    if(old){await this.db.run('UPDATE role_connection_requests SET last_seen=? WHERE id=?',[this.clock(),old.id]);return {id:old.id,state:'pending',revision:old.revision,chat:chat??null,expiresAt:this.clock()+86400000};}
    if((await this.db.get("SELECT COUNT(*) n FROM role_connection_requests")).n>=1024||(await this.db.get("SELECT COUNT(*) n FROM role_connection_requests WHERE connector_id=?",[actor.agentId])).n>=100)throw new MindPondError('temporarily_unavailable','Pending activation capacity reached; resolve or dismiss requests in the workbench');
    const id=randomUUID();await this.db.run("INSERT INTO role_connection_requests(id,principal,connector_id,runtime_id,created_at,last_seen,revision) VALUES(?,?,?,?,?,?,1)",[id,actor.principal,actor.agentId,actor.runtimeId,this.clock(),this.clock()]);await this.event(null,'connection_activation_requested',{requestId:id});return {id,state:'pending',revision:1,chat:chat??null,expiresAt:this.clock()+86400000};
  });}
  async resolveConnection(i:Row,a?:TrustedCallContext){this.admin(a);return this.write(async()=>{
    const request=await this.db.get<Row>('SELECT * FROM role_connection_requests WHERE id=?',[i.requestId]);
    if(!request)fail('Activation request no longer exists','not_found');
    if(request.revision!==i.expectedRevision)fail('Activation request changed; refresh before deciding','stale_version');
    if(i.action!=='reject'&&i.action!=='delete')fail('Choose reject or delete','invalid_input');
    const state=i.action==='reject'?'rejected':'deleted';
    await this.dismissChat(request,state);
    await this.event(null,'connection_activation_'+state,{requestId:request.id,connectorId:request.connector_id});
    return {id:request.id,state,removedFromPending:true};
  });}
  private async dismissChat(app:Row,state:string){
    // Delete the actual request. Keep only a runtime suppression marker so
    // background sync cannot recreate a request the human just removed.
    await this.db.run('DELETE FROM role_connection_requests WHERE runtime_id=?',[app.runtime_id]);
    await this.db.run('INSERT INTO role_activation_dismissals VALUES(?,?,?,?,?) ON CONFLICT(runtime_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at',[app.runtime_id,app.principal,app.connector_id,state,this.clock()]);
  }
  async deleteApplication(i:Row,a?:TrustedCallContext){this.admin(a);return this.write(async()=>{
    const app=await this.db.get<Row>('SELECT * FROM role_applications WHERE id=?',[i.applicationId]);
    if(!app)fail('Application no longer exists','not_found');
    if(app.revision!==i.expectedRevision||!['pending','rejected','cancelled'].includes(app.state))fail('Application changed; refresh before deleting','stale_version');
    await this.db.run('DELETE FROM role_applications WHERE id=?',[app.id]);
    await this.db.run("UPDATE role_receipts SET result=? WHERE principal=? AND connector_id=? AND runtime_id=? AND operation='application' AND json_extract(result,'$.applicationId')=?",[JSON.stringify({applicationId:app.id,state:'deleted'}),app.principal,app.connector_id,app.runtime_id,app.id]);
    await this.dismissChat(app,'deleted');
    await this.event(null,'application_deleted',{applicationId:app.id});return {applicationId:app.id,state:'deleted',removedFromPending:true};
  });}
  async activate(i:Row,a?:TrustedCallContext){this.admin(a);return this.write(async()=>{
    const request=await this.db.get<Row>("SELECT * FROM role_connection_requests WHERE id=? AND last_seen>?",[i.requestId,this.clock()-86400000]);
    if(!request)fail('Connection activation request expired or missing','not_found');
    const role=await this.db.get<Row>("SELECT * FROM character_roles WHERE id=? AND state='active'",[i.roleId]);
    if(!role||role.principal!==request.principal)fail('Choose an active role belonging to this human account','invalid_input');
    if(role.revision!==i.expectedRevision)fail('Role changed; refresh before activating','stale_version');
    if(!await this.offices.agentAuthority({v:1,principal:request.principal,agentId:request.connector_id,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER}))fail('Target host connection is disabled or unavailable','scope_denied');
    const blocked=await this.db.get<Row>(`SELECT p.title FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id JOIN offices o ON o.id=s.office_id
      JOIN office_project_links l ON l.office_id=o.id JOIN office_projects p ON p.id=l.project_id
      WHERE rs.role_id=? AND s.enabled=1 AND o.state IN ('active','paused') AND p.enabled=1
      AND NOT EXISTS(SELECT 1 FROM json_each(p.members) WHERE value=?) LIMIT 1`,[role.id,request.connector_id]);
    if(blocked)fail('目标连接未获项目「'+blocked.title+'」授权，请先在项目设置中允许该连接，再切换角色。','scope_denied');
    const old=await this.db.get<Row>('SELECT * FROM role_bindings WHERE principal=? AND connector_id=? AND runtime_id=?',[request.principal,request.connector_id,request.runtime_id]);
    if(old&&old.state==='active'&&old.role_id!==role.id)fail('This session already belongs to another role','invalid_input');
    const previous=await this.db.get<Row>("SELECT id,connector_id FROM role_bindings WHERE role_id=? AND state='active'",[role.id]);
    await this.fenceRole(role.id);
    await this.db.run("UPDATE role_bindings SET state='revoked',epoch=epoch+1 WHERE role_id=?",[role.id]);
    // A downloaded bearer without native chat metadata must not retain access
    // after the user moves the role to a different chat or harness.
    await this.db.run("UPDATE memory_role_credentials SET state='revoked' WHERE role_id=? AND state='active'",[role.id]);
    await this.db.run('UPDATE office_seats SET agent_id=?,revision=revision+1 WHERE id IN (SELECT seat_id FROM role_seats WHERE role_id=?)',[request.connector_id,role.id]);
    if(old)await this.db.run("UPDATE role_bindings SET role_id=?,state='active',epoch=epoch+1,last_seen=? WHERE id=?",[role.id,this.clock(),old.id]);
    else await this.db.run("INSERT INTO role_bindings VALUES(?,?,?,?,?,1,'active',?)",[randomUUID(),request.principal,request.connector_id,request.runtime_id,role.id,this.clock()]);
    await this.db.run('UPDATE character_roles SET revision=revision+1 WHERE id=?',[role.id]);
    await this.db.run("UPDATE role_applications SET state='cancelled',revision=revision+1 WHERE principal=? AND connector_id=? AND runtime_id=? AND state='pending'",[request.principal,request.connector_id,request.runtime_id]);
    await this.db.run('DELETE FROM role_connection_requests WHERE id=?',[request.id]);
    await this.db.run('DELETE FROM office_response_pages');
    await this.event(role.id,'user_activated_connection',{requestId:i.requestId,connectorId:request.connector_id,previousConnectorId:previous?.connector_id??null});return {roleId:role.id,activated:true,connectorId:request.connector_id};
  });}
  async disconnect(i:{roleId:string;expectedRevision:number;bindingId:string},a?:TrustedCallContext){this.admin(a);return this.write(async()=>{
    const role=await this.db.get<Row>('SELECT revision FROM character_roles WHERE id=?',[i.roleId]);
    const b=await this.db.get<Row>("SELECT * FROM role_bindings WHERE role_id=? AND state='active'",[i.roleId]);
    if(!role)fail('Role not found','not_found');
    if(role.revision!==i.expectedRevision||!b||b.id!==i.bindingId)fail('Role connection changed; refresh before disconnecting','stale_version');
    await this.fenceRole(i.roleId);
    await this.db.run("UPDATE role_bindings SET state='revoked',epoch=epoch+1 WHERE role_id=?",[i.roleId]);
    await this.db.run("UPDATE memory_role_credentials SET state='revoked' WHERE role_id=? AND state='active'",[i.roleId]);
    await this.dismissChat(b,'disconnected');
    await this.db.run('UPDATE character_roles SET revision=revision+1 WHERE id=?',[i.roleId]);
    await this.db.run('DELETE FROM office_response_pages');
    await this.event(i.roleId,'user_disconnected_connection',{bindingId:b.id,connectorId:b.connector_id});
    return {roleId:i.roleId,disconnected:true,notice:'The chat is now unbound (human memory). Role knowledge, mail and office assignments are preserved; in-flight role calls and dedicated credentials are revoked.'};
  });}
  async connect(i:{roleId:string;expectedRevision:number;targetRuntimeId:string},a?:TrustedCallContext){this.admin(a);return this.write(async()=>{
    const chat=await this.db.get<Row>('SELECT * FROM role_chat_sessions WHERE runtime_id=?',[i.targetRuntimeId]);
    if(!chat)fail('Chat not observed; call role_sync in the target chat first','not_found');
    const occupied=await this.db.get<Row>("SELECT role_id FROM role_bindings WHERE runtime_id=? AND principal=? AND connector_id=? AND state='active'",[chat.runtime_id,chat.principal,chat.connector_id]);
    if(occupied)fail('Target chat is already connected. Disconnect its current role before switching.','invalid_input');
    let request=await this.db.get<Row>('SELECT id FROM role_connection_requests WHERE runtime_id=?',[chat.runtime_id]);
    if(!request){request={id:randomUUID()};await this.db.run('INSERT INTO role_connection_requests VALUES(?,?,?,?,?,?,1)',[request.id,chat.principal,chat.connector_id,chat.runtime_id,this.clock(),this.clock()]);}
    else await this.db.run('UPDATE role_connection_requests SET last_seen=? WHERE id=?',[this.clock(),request.id]);
    const result=await this.activate({requestId:request.id,roleId:i.roleId,expectedRevision:i.expectedRevision},a);
    await this.db.run('DELETE FROM role_activation_dismissals WHERE runtime_id=?',[chat.runtime_id]);
    return result;
  });}
  async application(i: Row, a?: TrustedCallContext) {
    const actor = this.actor(a);
    return this.write(async () => {
      if (!(await this.offices.agentAuthority(actor))) fail('Connector disabled or binding revoked', 'scope_denied');
      if (i.action === 'status') return this.sync(actor);
      return this.receipt(actor, 'application', i, async () => {
        if (i.action === 'cancel') {
          const row = await this.db.get<Row>('SELECT * FROM role_applications WHERE id=? AND principal=? AND connector_id=? AND runtime_id=?', [i.applicationId, actor.principal, actor.agentId, actor.runtimeId]);
          if(!row)fail('Application not found for this session','not_found');
          if(row.state!=='pending')fail('Only pending applications may be cancelled','invalid_input');
          await this.db.run("UPDATE role_applications SET state='cancelled',revision=revision+1 WHERE id=?", [row.id]);
          await this.event(null, 'application_cancelled', { applicationId: row.id });
          return { applicationId: row.id, state: 'cancelled' };
        }
        if (await this.binding(actor, false)) fail('This session already has a character; user edits its profile in the workbench','invalid_input');
        if (await this.db.get('SELECT 1 FROM role_applications WHERE principal=? AND connector_id=? AND runtime_id=? AND state=?', [actor.principal, actor.agentId, actor.runtimeId, 'pending'])) fail('An application is already pending; call role_sync','invalid_input');
        const count = await this.db.get<Row>("SELECT COUNT(*) n FROM role_applications WHERE principal=? AND state='pending'", [actor.principal]);
        if (count!.n >= 100) fail('Pending application limit reached', 'invalid_input');
        await this.db.run('DELETE FROM role_activation_dismissals WHERE runtime_id=?',[actor.runtimeId]);
        const id = randomUUID();
        await this.db.run('INSERT INTO role_applications VALUES(?,?,?,?,?,?,?,?,?,1,NULL,?)', [id, actor.principal, actor.agentId, actor.runtimeId, actor.runtimeMode ?? 'connection', i.name, i.introduction, i.reason, 'pending', this.clock()]);
        await this.db.run('DELETE FROM role_connection_requests WHERE principal=? AND connector_id=? AND runtime_id=?',[actor.principal,actor.agentId,actor.runtimeId]);
        await this.event(null, 'application_submitted', { applicationId: id, principal: actor.principal, connectorId: actor.agentId });
        return { applicationId: id, state: 'pending', nextAction: 'The user can approve in MindPond → 协作办公室 → 待审核. role_sync reads the approval state; continue in the same chat.' };
      });
    });
  }
  async sync(a?: TrustedCallContext) {
    const actor = this.actor(a);
    const b = await this.binding(actor, false);
    if (!b) {
      const application = await this.db.get<Row>('SELECT id,name,introduction,state,revision,created_at FROM role_applications WHERE principal=? AND connector_id=? AND runtime_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', [actor.principal, actor.agentId, actor.runtimeId]);
      return { state: application?.state==='approved'?'unregistered':application?.state ?? 'unregistered', identity: null, application: application ?? null, instructions: ROLE_INSTRUCTIONS };
    }
    const officePage = await this.rooms({},actor);
    const contactPage = await this.contacts({}, actor);
    const processing=await this.db.all("SELECT m.id messageId,m.office_id officeId,s.taken_at takenAt FROM role_messages m JOIN role_message_states s ON s.message_id=m.id WHERE m.recipient=? AND s.state='processing' ORDER BY m.seq LIMIT 21",[b.role_id]);
    const controlRequests=await this.db.all("SELECT id,action,reason,requested_at FROM office_control_requests WHERE role_id=? AND state='requested' ORDER BY requested_at LIMIT 20",[b.role_id]);
    const waits=await this.db.all<Row[]>("SELECT id,state,conditions,expires_at FROM role_message_waits WHERE role_id=? ORDER BY started_at DESC LIMIT 10",[b.role_id]);
    const waitRecovery=waits.map(w=>{const conditions=JSON.parse(w.conditions);return {...w,conditions,resume:{afterSeq:conditions.afterSeq??0,...(conditions.replyTo?{replyTo:conditions.replyTo}:{}),waitMs:conditions.waitMs??300000}};});
    return { state: 'active', discussions:await this.discussionStatus?.(actor), identity: await this.badge(actor, b), controlRequests,waitRecovery, assignments:officePage.rooms, officesHasMore:officePage.hasMore, officesNextAfterId:officePage.nextAfterId, contacts:contactPage.contacts, contactsHasMore:contactPage.hasMore, contactsNextAfterId:contactPage.nextAfterId,
      processing:processing.slice(0,20),processingHasMore:processing.length>20,resume:{mcp:'memory',tool:'memory_resume',next:'Read current role working state on the separate Memory MCP before continuing. Follow its pages, check new messages and verify linked versions; do not infer unrecorded progress.'},instructions: ROLE_INSTRUCTIONS };
  }
  async contacts(i:Row,a?:TrustedCallContext){
    const actor=this.actor(a),b=await this.binding(actor);
    const rows=await this.db.all<Row[]>(`SELECT r.id roleId,r.name,r.introduction FROM character_roles r WHERE r.state='active' AND r.id<>? AND r.id>? AND (r.principal=? OR EXISTS(SELECT 1 FROM role_links l WHERE l.sender=? AND l.recipient=r.id)) ORDER BY r.id LIMIT ?`,[b!.role_id,i.afterId??'',actor.principal,b!.role_id,(i.limit??20)+1]);
    const contacts:Row[]=[];const budget=i.contextBudgetBytes??8192;
    for(const row of rows.slice(0,i.limit??20)){const summary={...row,introduction:previewText(row.introduction,240),introductionTruncated:Buffer.byteLength(row.introduction)>240};if(jsonBytes([...contacts,summary])>budget)break;contacts.push(summary);}
    return {contacts,hasMore:rows.length>contacts.length,nextAfterId:contacts.at(-1)?.roleId??i.afterId??'',contextBudget:{limit:budget,used:jsonBytes(contacts),unit:'utf8_bytes',appliesTo:'contacts'}};
  }
  async contact(roleId:string,a?:TrustedCallContext){
    const actor=this.actor(a),b=await this.binding(actor);
    const row=await this.db.get(`SELECT r.id roleId,r.name,r.introduction FROM character_roles r WHERE r.id=? AND r.state='active' AND (r.principal=? OR EXISTS(SELECT 1 FROM role_links l WHERE l.sender=? AND l.recipient=r.id))`,[roleId,actor.principal,b!.role_id]);
    if(!row)fail('Contact not found in permitted contacts','not_found');return {contact:row};
  }
  async rooms(i:Row,a?:TrustedCallContext){
    const actor=this.actor(a),b=await this.binding(actor),all=(await this.assignments(b!,actor)).filter(s=>s.assignmentId>(i.afterId??'')).sort((a,b)=>a.assignmentId<b.assignmentId?-1:a.assignmentId>b.assignmentId?1:0);
    const rooms:Row[]=[];const budget=i.contextBudgetBytes??8192;
    for(const row of all.slice(0,i.limit??20)){const summary={...row,title:previewText(row.title,240),duty:previewText(row.duty,240)};if(jsonBytes([...rooms,summary])>budget)break;rooms.push(summary);}
    return {rooms,hasMore:all.length>rooms.length,nextAfterId:rooms.at(-1)?.assignmentId??i.afterId??'',contextBudget:{limit:budget,used:jsonBytes(rooms),unit:'utf8_bytes',appliesTo:'rooms'}};
  }

  private async assignments(b: Row, a: TrustedCallContext) {
    const seats = await this.offices.authorizedSeats({ ...a, roleId: b.role_id, roleBindingId: b.id, roleBindingEpoch: b.epoch });
    return seats.map(s => ({ assignmentId: s.id, officeId: s.office_id, label: s.label, duty: s.role, title: s.title, state: s.office_state, deadline: s.deadline }));
  }
  async review(i: Row, a?: TrustedCallContext) {
    this.admin(a);
    return this.write(async () => {
      const app = await this.db.get<Row>('SELECT * FROM role_applications WHERE id=?', [i.applicationId]);
      if (!app || app.revision !== i.expectedRevision) fail('Application changed; refresh', 'stale_version');
      if (app.state !== 'pending') fail('Application has already been reviewed', 'stale_version');
      if (i.action === 'reject') {
        await this.db.run("UPDATE role_applications SET state='rejected',revision=revision+1 WHERE id=?", [app.id]);
        await this.dismissChat(app,'rejected');
        await this.event(null, 'application_rejected', { applicationId: app.id });
        return { state: 'rejected' };
      }
      const active = await this.db.get("SELECT 1 FROM role_bindings WHERE principal=? AND connector_id=? AND runtime_id=? AND state='active'", [app.principal, app.connector_id, app.runtime_id]);
      if (active) fail('Session already has a binding; explicit takeover is not supported by this action','invalid_input');
      if (!(await this.offices.agentAuthority({ v: 1, principal: app.principal, agentId: app.connector_id, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER }))) fail('Connector disabled; do not approve until restored', 'scope_denied');
      const roleId = randomUUID(), bindingId = randomUUID();
      await this.db.run("INSERT INTO character_roles(id,principal,name,introduction,state,revision,primary_seat,created_at) VALUES(?,?,?,?,'active',1,NULL,?)", [roleId, app.principal, i.name ?? app.name, i.introduction ?? app.introduction, this.clock()]);
      await this.db.run("INSERT INTO role_bindings VALUES(?,?,?,?,?,1,'active',?) ON CONFLICT(principal,connector_id,runtime_id) DO UPDATE SET role_id=excluded.role_id,state='active',epoch=role_bindings.epoch+1,last_seen=excluded.last_seen", [bindingId, app.principal, app.connector_id, app.runtime_id, roleId, this.clock()]);
      await this.db.run('DELETE FROM role_connection_requests WHERE runtime_id=?',[app.runtime_id]);
      await this.db.run("UPDATE role_applications SET state='approved',revision=revision+1,role_id=? WHERE id=?", [roleId, app.id]);
      await this.event(roleId, 'approved', { applicationId: app.id, profileRevision: 1 });
      const bound=await this.db.get<Row>('SELECT id FROM role_bindings WHERE principal=? AND connector_id=? AND runtime_id=?',[app.principal,app.connector_id,app.runtime_id]);
      return { state: 'approved', roleId, bindingId:bound!.id };
    });
  }
  async configure(i: Row, a?: TrustedCallContext) {
    this.admin(a);
    return this.write(async () => {
      const old = await this.db.get<Row>('SELECT * FROM character_roles WHERE id=?', [i.roleId]);
      if (!old || old.revision !== i.expectedRevision) fail('Character profile changed; refresh', 'stale_version');
      const revision = old.revision + 1;
      await this.db.run('UPDATE character_roles SET name=?,introduction=?,state=?,revision=? WHERE id=?', [i.name, i.introduction, i.state, revision, old.id]);
      if (old.state !== i.state) {
        await this.db.run('UPDATE role_bindings SET epoch=epoch+1 WHERE role_id=?', [old.id]);
        await this.fenceRole(old.id);
      }
      await this.event(old.id, 'profile_changed', { profileRevision: revision, name: i.name, introduction: i.introduction, state: i.state });
      return { roleId: old.id, revision };
    });
  }
  async deleteRole(i: {roleId: string; expectedRevision: number}, a?: TrustedCallContext) {
    this.admin(a);
    return this.write(async () => {
      const role = await this.db.get<Row>('SELECT revision FROM character_roles WHERE id=?',[i.roleId]);
      if (!role || role.revision !== i.expectedRevision) fail('Character profile changed or was deleted; refresh','stale_version');
      await this.fenceRole(i.roleId);
      await deleteRoleData(this.db,i.roleId);
      await this.event(i.roleId,'deleted',{roleId:i.roleId});
      return {deleted:true,roleId:i.roleId};
    });
  }
  async deleteOffice(i: {id: string; expectedRevision: number}, a?: TrustedCallContext) {
    this.admin(a);
    return this.write(async () => {
      const office = await this.db.get<Row>('SELECT revision FROM offices WHERE id=?',[i.id]);
      if (!office || office.revision !== i.expectedRevision) fail('Office changed or was deleted; refresh','stale_version');
      await deleteOfficeData(this.db,i.id);
      await this.event(null,'office_deleted',{officeId:i.id});
      return {deleted:true,officeId:i.id};
    });
  }
  private async fenceRole(roleId: string) {
    const sessions = 'SELECT id FROM office_sessions WHERE seat_id IN (SELECT seat_id FROM role_seats WHERE role_id=?)';
    await this.db.run(`UPDATE office_sessions SET state='closed' WHERE id IN (${sessions})`, [roleId]);
    await this.db.run(`UPDATE office_items SET status='open',revision=revision+1,epoch=epoch+1,lease_hash=NULL,lease_until=NULL,session_id=NULL WHERE status='claimed' AND session_id IN (${sessions})`, [roleId]);
  }
  async registry(a?: TrustedCallContext) {
    this.admin(a);
    // Capture BEFORE reading rows: another process may commit while we read.
    // A stale snapshot then leaves a newer revision to fetch on the next poll.
    const revision=(await this.db.get<Row>('SELECT COALESCE(MAX(seq),0) n FROM role_events'))!.n;
    const rows = await this.db.all<Row[]>(`SELECT r.*,b.id binding_id,b.epoch,b.last_seen,b.connector_id,b.runtime_id,a.name connector_name,a.host,a.state host_state,c.source chat_source,c.native_chat_id,
      EXISTS(SELECT 1 FROM memory_role_credentials c WHERE c.role_id=r.id AND c.state='active') hasMemoryCredential
      FROM character_roles r LEFT JOIN role_bindings b ON b.role_id=r.id AND b.state='active'
      LEFT JOIN office_agents a ON a.id=b.connector_id LEFT JOIN role_chat_sessions c ON c.runtime_id=b.runtime_id AND c.connector_id=b.connector_id AND c.principal=b.principal ORDER BY r.created_at,r.id LIMIT 500`);
    const roles=rows.map(({connector_id,connector_name,runtime_id,host,host_state,chat_source,native_chat_id,...role})=>({...role,connection:role.binding_id?{
      connectorId:connector_id,name:connector_name??connector_id,host,hostState:host_state,chat: native_chat_id?{source:chat_source,id:native_chat_id}:null,chatRef:runtime_id,bindingId:role.binding_id,lastSeen:role.last_seen
    }:null}));
    const pending = await this.db.all("SELECT p.*,c.source chat_source,c.native_chat_id FROM role_applications p LEFT JOIN role_chat_sessions c ON c.runtime_id=p.runtime_id AND c.connector_id=p.connector_id AND c.principal=p.principal WHERE p.state='pending' ORDER BY p.created_at LIMIT 100");
    const mappings = await this.db.all('SELECT * FROM role_seats');
    const links = await this.db.all('SELECT sender,recipient FROM role_links ORDER BY sender,recipient');
    const messages = (await this.db.all<Row[]>(`SELECT m.*,s.state,s.taken_at,s.completed_at,s.completion FROM role_messages m JOIN role_message_states s ON s.message_id=m.id ORDER BY m.seq DESC LIMIT 100`)).map(m=>({...m,state:messageState(m.state),body:previewText(m.body,700),bodyTruncated:Buffer.byteLength(m.body)>700}));
    const events = await this.db.all('SELECT seq,role_id,kind,body,ts FROM role_events ORDER BY seq DESC LIMIT 100');
    const chats=await this.db.all(`SELECT c.runtime_id,c.principal,c.connector_id,c.source chat_source,c.native_chat_id,c.last_seen,a.name connector_name,a.host,a.state host_state,b.role_id,r.name role_name
      FROM role_chat_sessions c JOIN office_agents a ON a.id=c.connector_id
      LEFT JOIN role_bindings b ON b.runtime_id=c.runtime_id AND b.principal=c.principal AND b.connector_id=c.connector_id AND b.state='active'
      LEFT JOIN character_roles r ON r.id=b.role_id ORDER BY c.last_seen DESC,c.runtime_id LIMIT 500`);
    return { revision, roles, pending, chats, connections:await this.db.all("SELECT p.*,c.source chat_source,c.native_chat_id FROM role_connection_requests p LEFT JOIN role_chat_sessions c ON c.runtime_id=p.runtime_id AND c.connector_id=p.connector_id AND c.principal=p.principal WHERE p.last_seen>? ORDER BY p.last_seen DESC LIMIT 100",[this.clock()-86400000]), mappings, links, messages, events: events.map((e: Row) => ({ ...e, body: JSON.parse(e.body) })) };
  }
  async messagePreview(id:string|{messageId?:string;seq?:number},a?:TrustedCallContext){
    this.admin(a);
    const input=typeof id==='string'?{messageId:id}:id;
    const row=await this.db.get<Row>('SELECT m.*,s.state,s.taken_at,s.completed_at,s.completion FROM role_messages m JOIN role_message_states s ON s.message_id=m.id WHERE ((? IS NOT NULL AND m.id=?) OR (? IS NOT NULL AND m.seq=?))',[input.messageId??null,input.messageId??null,input.seq??null,input.seq??null]);
    if(!row)fail('Message not found','not_found');return {message:{...row!,state:messageState(row!.state)}};
  }
  async state(a?: TrustedCallContext, afterSeq?: number) {
    this.admin(a);
    if(afterSeq!==undefined&&(!Number.isSafeInteger(afterSeq)||afterSeq<0))fail('Invalid role state cursor','invalid_input');
    const revision=(await this.db.get<Row>('SELECT COALESCE(MAX(seq),0) n FROM role_events'))!.n;
    return afterSeq===revision?{unchanged:true,revision}:this.registry(a);
  }
  async configureOffice(i: Row, a?: TrustedCallContext) {
    this.admin(a);
    return this.write(async () => {
      if(!await this.db.get('SELECT 1 FROM offices WHERE id=?',[i.id])&&await this.db.get('SELECT 1 FROM memory_office_namespaces WHERE office_id=?',[i.id]))fail('This office ID belongs to retained knowledge from a deleted office. Create a new office ID.','invalid_input');
      for (const s of i.seats ?? []) {
        if(!s.roleId)fail('Choose an approved role for every office participant','invalid_input');
        const r = await this.db.get<Row>("SELECT * FROM character_roles WHERE id=? AND state='active'", [s.roleId]);
        if(!r)fail('Choose an active approved character','invalid_input');
        const connection=await this.db.get<Row>(`SELECT connector_id FROM role_bindings WHERE role_id=? AND state='active'`,[r.id]);
        const assignment=connection??await this.db.get<Row>(`SELECT s.agent_id connector_id FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id WHERE rs.role_id=? ORDER BY s.enabled DESC,s.id LIMIT 1`,[r.id]);
        if(!assignment)fail('Connect this role to a chat before arranging its office','invalid_input');
        if(s.agentId!==undefined&&s.agentId!==assignment.connector_id)fail('Participant connection changed; reload the roles before saving','stale_version');
        s.agentId=assignment.connector_id;
        if (i.seats.filter((x: Row) => x.roleId === s.roleId).length > 1) fail('One character has one duty per office', 'invalid_input');
      }
      const result = await this.offices.configureOffice(i, a);
      // Cached envelopes may contain material or contact previews from the old grant.
      await this.db.run('DELETE FROM office_response_pages');
      if (i.seats) {
        await this.db.run('DELETE FROM role_seats WHERE seat_id IN (SELECT id FROM office_seats WHERE office_id=?)', [i.id]);
        for (const s of i.seats) {
          await this.db.run('INSERT INTO role_seats VALUES(?,?)', [s.id, s.roleId]);
          await this.db.run('UPDATE character_roles SET primary_seat=COALESCE(primary_seat,?) WHERE id=?', [s.id, s.roleId]);
        }
        // Preserve an existing primary location if still assigned, otherwise
        // choose deterministically. This never migrates knowledge or task ownership.
        await this.db.run('UPDATE character_roles SET primary_seat=(SELECT MIN(rs.seat_id) FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id WHERE rs.role_id=character_roles.id AND s.enabled=1) WHERE primary_seat IS NOT NULL AND NOT EXISTS(SELECT 1 FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id WHERE rs.role_id=character_roles.id AND rs.seat_id=primary_seat AND s.enabled=1)');
        await this.event(null, 'office_assignments_changed', { officeId: i.id });
      }
      const seats=await this.db.all('SELECT s.id,s.label,s.role,rs.role_id roleId FROM office_seats s LEFT JOIN role_seats rs ON rs.seat_id=s.id WHERE s.office_id=? AND s.enabled=1 ORDER BY s.id',[i.id]);
      await this.db.run('INSERT OR IGNORE INTO office_layout_snapshots(office_id,revision,payload,created_at) VALUES(?,?,?,?)',[i.id,result.revision,JSON.stringify({seats}),this.clock()]);
      return result;
    });
  }
  async link(i: Row, a?: TrustedCallContext) {
    this.admin(a);
    return this.write(async () => {
      for (const id of [i.sender, i.recipient]) if (!(await this.db.get('SELECT 1 FROM character_roles WHERE id=?', [id]))) fail('Unknown character', 'invalid_input');
      if (i.enabled) await this.db.run('INSERT OR IGNORE INTO role_links VALUES(?,?)', [i.sender, i.recipient]);
      else await this.db.run('DELETE FROM role_links WHERE sender=? AND recipient=?', [i.sender, i.recipient]);
      await this.db.run('DELETE FROM office_response_pages');
      await this.event(i.sender, 'contact_permission_changed', i);
      return { ok: true };
    });
  }
}

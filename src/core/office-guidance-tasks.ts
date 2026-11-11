import { randomUUID } from 'node:crypto';
import type { Database } from 'sqlite';
import { z } from 'zod';
import { MindPondError } from './errors.js';
import type { GraphMemory } from './graph-memory.js';
import { digest } from './growth.js';
import { messageStateSql } from './office-message-state.js';
import type { TrustedCallContext } from './trust.js';
import { auditSchema, checkSchema, MAX_REVIEW_CHECKS, OfficeRiskReview, riskPolicySchema, taskRiskSchema, type RiskTask } from './office-risk-review.js';

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const blockReportSchema = z.object({
  attempted: text(800), obstacle: text(800), decision: text(600).optional(), recommendation: text(600).optional()
}).strict();
const deliverySchema = z.object({
  summary: text(1200),
  checks: z.array(checkSchema).min(1).max(MAX_REVIEW_CHECKS),
  unknowns: text(800).optional(), observations: text(800).optional()
}).strict();
type Delivery = z.infer<typeof deliverySchema>;

function checkPreviews(checks: Delivery['checks']) {
  return checks.length ? {
    count:checks.length,
    previews:checks.slice(0,2).map(({criterion,observed,evidence,evidenceVersion})=>({
      criterion:criterion.slice(0,100),
      observation:(observed??evidence)?.slice(0,160),
      ...(evidenceVersion?{evidenceVersion}:{})
    }))
  } : undefined;
}
export const taskOutcomeSchema = z.object({
  decision: text(800), evidence: text(800), nextStep: text(800)
}).strict();
export type TaskOutcome = z.infer<typeof taskOutcomeSchema>;
type Audience = 'owner' | 'supervisor';

const reviewMode = z.enum(['all','sample','exceptions']);
const supervisorMode = z.enum(['manage','observe']);
const releaseRule = z.enum(['block_on_failure','require_evidence']);
const MAX_RELEASE_TASKS=100;
const assignmentFields = {
  ownerId: id, title: text(160), goal: text(1600), acceptance: text(1200),
  instruction: text(800).nullable().optional(), memoryQuery: text(300).nullable().optional(), risk:taskRiskSchema.optional(), key: text(160)
};
const assignmentSchema=z.object(assignmentFields);
const batchSchema = z.object({
  goal: text(1600), briefMaterialId: id.optional(),
  assignments: z.array(assignmentSchema.omit({goal:true}).strict()).min(1).max(8)
}).strict();
const usageNumber = z.number().int().nonnegative().max(1_000_000_000);
const usageEntry = z.object({
  key: text(160), phase: z.enum(['assignment','work','review']), model: text(100),
  meter: z.enum(['billable','local']),
  responses: usageNumber.optional(), mcpCalls: usageNumber.optional(), inputTokens: usageNumber.optional(), cachedInputTokens: usageNumber.optional(),
  outputTokens: usageNumber.optional(), elapsedMs: usageNumber.optional(), failures: usageNumber.optional(),
  costMicrousd: usageNumber.optional(), costKind: z.enum(['reported','estimate']).optional()
}).strict().superRefine((i,ctx)=>{
  const issue=(field:string,message:string)=>ctx.addIssue({code:'custom',path:[field],message});
  if (i.cachedInputTokens!==undefined && (i.inputTokens===undefined || i.cachedInputTokens>i.inputTokens))
    issue('cachedInputTokens','Cached tokens must be a subset of inputTokens.');
  if ((i.costMicrousd!==undefined)!==(i.costKind!==undefined) || (i.meter==='local' && i.costMicrousd!==undefined))
    issue('costMicrousd','Enter a cost and its kind together for a billable model. Local models use tokens and time.');
  if ([i.responses,i.mcpCalls,i.inputTokens,i.outputTokens,i.elapsedMs,i.failures,i.costMicrousd].every(v=>v===undefined))
    issue('inputTokens','Supply at least one observed metric.');
});
const usageSchema = z.object({officeId:id,taskId:id,entry:usageEntry.optional()}).strict();

export const guidedTaskSchema = z.object({
  action: z.enum(['list','dashboard','release_status','record_assessment','set_release_rule','review_queue','review_packet','audit','get','create','dispatch','guide','claim','progress','evidence_index','block','submit','review','reassign','cancel']),
  officeId: id,
  taskId: id.optional(),
  ...assignmentSchema.partial().shape,
  briefMaterialId: id.optional(),
  batch: batchSchema.optional(),
  resolveDecision: z.literal(true).optional(),
  releaseRule: releaseRule.nullable().optional(),
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  note: text(2000).optional(),
  progressMaterialId: id.nullable().optional(),
  blockReport: blockReportSchema.optional(),
  delivery: deliverySchema.optional(),
  blocker: z.enum(['dependency','decision']).optional(),
  audit:auditSchema.optional(),
  auditOverride:z.literal(true).optional(),
  includeRoutine:z.boolean().optional(),
  checkOffset:z.number().int().nonnegative().max(MAX_REVIEW_CHECKS).optional(),
  verdict: z.enum(['accept','revise']).optional(),
  expectedRevision: z.number().int().positive().optional(),
  filter: z.enum(['attention','active','closed']).optional(),
  afterId: id.optional(),
  limit: z.number().int().min(1).max(30).optional()
}).strict();
const consoleCursor = z.object({at:z.number().int().nonnegative(),key:z.string().min(1).max(180)}).strict();
const consoleSchema = z.object({
  officeId:id, roleId:id.optional(),
  status:z.enum(['queued','working','blocked','review','done','cancelled']).optional(),
  activity:z.enum(['message','task','evidence']).optional(),
  taskBefore:consoleCursor.optional(), activityBefore:consoleCursor.optional()
}).strict();
const settingsSchema = z.object({
  officeId: id,
  supervisorId: id.nullable(),
  supervisorMode: supervisorMode.optional(),
  reviewMode: reviewMode.optional(),
  riskReview:riskPolicySchema.nullable().optional(),
  expectedRevision: z.number().int().nonnegative()
}).strict();
type Row = Record<string, any>;
type TaskRow = Row & RiskTask;
type Scope = {human: boolean; roleId: string | null; principal: string; supervisor: boolean; canManage: boolean; office: Row};
const terminal = (status: string) => status === 'done' || status === 'cancelled';
const bad = (message: string): never => { throw new MindPondError('invalid_input', message); };
const denied = (message: string): never => { throw new MindPondError('scope_denied', message); };
const stale = (): never => { throw new MindPondError('stale_version', 'Task or policy changed; reload the current revision before retrying.'); };

export class OfficeGuidanceTasks {
  private riskReview:OfficeRiskReview;

  constructor(private db: Database, private graph: GraphMemory,
    private write: <T>(fn: () => Promise<T>) => Promise<T>, private clock: () => number, private read: <T>(fn: () => Promise<T>) => Promise<T>) { this.riskReview=new OfficeRiskReview(db,clock); }

  async init() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS office_guided_settings(
        office_id TEXT PRIMARY KEY REFERENCES offices(id) ON DELETE CASCADE,
        supervisor_id TEXT REFERENCES character_roles(id) ON DELETE SET NULL, revision INTEGER NOT NULL,
        review_mode TEXT NOT NULL DEFAULT 'all', risk_review TEXT, supervisor_mode TEXT NOT NULL DEFAULT 'manage'
      );
      CREATE TABLE IF NOT EXISTS office_guided_tasks(
        id TEXT PRIMARY KEY, office_id TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES character_roles(id) ON DELETE CASCADE,
        author TEXT NOT NULL, guided_by TEXT NOT NULL, guide_revision INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL, goal TEXT NOT NULL, acceptance TEXT NOT NULL, instruction TEXT, memory_query TEXT,
        status TEXT NOT NULL, blocker TEXT, note TEXT, result TEXT, revisions_requested INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
        brief_material_id TEXT, created_at INTEGER, first_claimed_at INTEGER, submitted_at INTEGER, reviewed_at INTEGER, risk_spec TEXT, review_submission_id TEXT,
        batch_id TEXT, progress_note TEXT, progress_at INTEGER, progress_material_id TEXT, release_rule TEXT,
        create_key TEXT NOT NULL, create_hash TEXT NOT NULL, UNIQUE(office_id,author,create_key)
      );
      CREATE INDEX IF NOT EXISTS office_guided_task_owner ON office_guided_tasks(owner_id,office_id,status,id);
      CREATE INDEX IF NOT EXISTS office_guided_task_office ON office_guided_tasks(office_id,id);
      CREATE TABLE IF NOT EXISTS office_guided_receipts(
        task_id TEXT NOT NULL REFERENCES office_guided_tasks(id) ON DELETE CASCADE,
        actor TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(task_id,actor,key)
      );
      CREATE TABLE IF NOT EXISTS office_guided_usage(
        task_id TEXT NOT NULL REFERENCES office_guided_tasks(id) ON DELETE CASCADE,
        key TEXT NOT NULL, entry TEXT NOT NULL, PRIMARY KEY(task_id,key)
      );
      CREATE TABLE IF NOT EXISTS office_guided_outcomes(
        task_id TEXT NOT NULL REFERENCES office_guided_tasks(id) ON DELETE CASCADE,
        discussion_id TEXT PRIMARY KEY, title TEXT NOT NULL, conclusion TEXT NOT NULL,
        author TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    await this.riskReview.init();
    await this.write(async () => {
      const taskColumns = await this.db.all<Row[]>('PRAGMA table_info(office_guided_tasks)');
      if (!taskColumns.some(c => c.name === 'block_report'))
        await this.db.exec('ALTER TABLE office_guided_tasks ADD COLUMN block_report TEXT');
      if (!taskColumns.some(c => c.name === 'delivery'))
        await this.db.exec('ALTER TABLE office_guided_tasks ADD COLUMN delivery TEXT');
      for(const [column,type] of [['brief_material_id','TEXT'],['created_at','INTEGER'],['first_claimed_at','INTEGER'],
        ['submitted_at','INTEGER'],['reviewed_at','INTEGER'],['risk_spec','TEXT'],['review_submission_id','TEXT'],
        ['batch_id','TEXT'],['progress_note','TEXT'],['progress_at','INTEGER'],['progress_material_id','TEXT'],['release_rule','TEXT']]) {
        if (!taskColumns.some(c => c.name === column))
          await this.db.exec(`ALTER TABLE office_guided_tasks ADD COLUMN ${column} ${type}`);
      }
      await this.db.exec('CREATE INDEX IF NOT EXISTS office_guided_task_batch ON office_guided_tasks(office_id,batch_id) WHERE batch_id IS NOT NULL');
      await this.db.exec('CREATE INDEX IF NOT EXISTS office_guided_task_release ON office_guided_tasks(office_id,id) WHERE release_rule IS NOT NULL');
      const settingsColumns = await this.db.all<Row[]>('PRAGMA table_info(office_guided_settings)');
      if (!settingsColumns.some(c => c.name === 'review_mode'))
        await this.db.exec("ALTER TABLE office_guided_settings ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'all'");
      if (!settingsColumns.some(c => c.name === 'risk_review'))
        await this.db.exec('ALTER TABLE office_guided_settings ADD COLUMN risk_review TEXT');
      if (!settingsColumns.some(c => c.name === 'supervisor_mode'))
        await this.db.exec("ALTER TABLE office_guided_settings ADD COLUMN supervisor_mode TEXT NOT NULL DEFAULT 'manage'");
      const outcomeColumns = await this.db.all<Row[]>('PRAGMA table_info(office_guided_outcomes)');
      if (!outcomeColumns.some(c => c.name === 'details'))
        await this.db.exec('ALTER TABLE office_guided_outcomes ADD COLUMN details TEXT');
      if (!await this.db.get("SELECT 1 FROM sqlite_master WHERE name='office_guided_changes'")) {
        await this.db.exec(`
          CREATE TABLE office_guided_changes(
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL REFERENCES office_guided_tasks(id) ON DELETE CASCADE,
            audience TEXT NOT NULL, kind TEXT NOT NULL, UNIQUE(task_id,audience)
          );
          INSERT INTO office_guided_changes(task_id,audience,kind)
            SELECT id,'owner','assignment' FROM office_guided_tasks WHERE status='queued' ORDER BY updated_at,id;
          INSERT INTO office_guided_changes(task_id,audience,kind)
            SELECT id,'supervisor',CASE WHEN status='review' THEN 'review_needed' ELSE 'decision_needed' END
            FROM office_guided_tasks WHERE status='review' OR (status='blocked' AND blocker='decision')
            ORDER BY updated_at,id;
        `);
      }
    });
    await this.db.exec(`CREATE INDEX IF NOT EXISTS office_guided_event_task
      ON office_events(office_id,json_extract(body,'$.taskId'),seq) WHERE kind='guided_task'`);
    for (const table of ['office_guided_settings','office_guided_tasks']) {
      for (const operation of ['INSERT','UPDATE','DELETE']) {
        await this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_observer_${operation} AFTER ${operation} ON ${table}
          BEGIN UPDATE office_observer_revision SET revision=revision+1 WHERE id=1; END`);
      }
    }
  }

  private async member(officeId: string, roleId: string) {
    return this.db.get<Row>(`SELECT r.id,r.name,r.principal FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id
      JOIN character_roles r ON r.id=rs.role_id WHERE s.office_id=? AND s.enabled=1 AND r.state='active' AND r.id=?`, [officeId,roleId]);
  }

  private async scope(officeId: string, context?: TrustedCallContext): Promise<Scope> {
    const office = await this.db.get<Row>('SELECT o.id,o.state,o.deadline,g.supervisor_id,g.supervisor_mode,g.revision,g.review_mode,g.risk_review FROM offices o LEFT JOIN office_guided_settings g ON g.office_id=o.id WHERE o.id=?', [officeId]);
    if (!office) throw new MindPondError('not_found','Office not found.');
    if (context?.operator && context.expiresAt > this.clock())
      return {human:true,roleId:null,principal:context.principal,supervisor:true,canManage:true,office};
    const binding = await this.graph.roles.binding(context);
    if (!binding || !context) return denied('An approved role binding is required.');
    const actor = {...context,roleId:binding.role_id,roleBindingId:binding.id,roleBindingEpoch:binding.epoch};
    if (!(await this.graph.offices.authorizedSeats(actor)).some(s=>s.office_id===officeId))
      return denied('Your current role and connection need access to this office.');
    const supervisor=office.supervisor_id===binding.role_id;
    return {human:false,roleId:binding.role_id,principal:context.principal,supervisor,
      canManage:supervisor&&office.supervisor_mode!=='observe',office};
  }

  private assertOpen(scope: Scope) {
    if (scope.office.state!=='active' || scope.office.deadline && scope.office.deadline<=this.clock())
      bad('Office is not open for task changes.');
  }

  async settings(value: unknown, context: TrustedCallContext) {
    const i = settingsSchema.parse(value);
    return this.write(async()=>{
      const scope = await this.scope(i.officeId,context);
      if (!scope.human) return denied('Only the human manager can select the task supervisor.');
      if (!['active','paused'].includes(scope.office.state)) bad('Archived office settings are read-only.');
      const revision = scope.office.revision ?? 0;
      if (revision !== i.expectedRevision) stale();
      if (i.supervisorId && !await this.member(i.officeId,i.supervisorId)) bad('Choose an active office member.');
      const mode=i.reviewMode??scope.office.review_mode??'all';
      const authority=i.supervisorMode??scope.office.supervisor_mode??'manage';
      const policy=i.riskReview===undefined?this.riskPolicy(scope):i.riskReview;
      if(i.riskReview?.verifierId&&!await this.member(i.officeId,i.riskReview.verifierId))
        return bad('Choose an active member as the independent verifier.');
      if(policy?.verifierId&&policy.verifierId===i.supervisorId)
        return bad('Choose a distinct role as the independent verifier, or leave it empty for authorized review.');

      await this.db.run(`INSERT INTO office_guided_settings(office_id,supervisor_id,revision,review_mode,risk_review,supervisor_mode) VALUES(?,?,?,?,?,?) ON CONFLICT(office_id)
        DO UPDATE SET supervisor_id=excluded.supervisor_id,revision=excluded.revision,review_mode=excluded.review_mode,risk_review=excluded.risk_review,
          supervisor_mode=excluded.supervisor_mode`,
        [i.officeId,i.supervisorId,revision+1,mode,policy?JSON.stringify(policy):null,authority]);
      // Old supervisor pages may include task content.
      await this.db.run('DELETE FROM office_response_pages');
      return {supervisorId:i.supervisorId,supervisorMode:authority,revision:revision+1,reviewMode:mode,riskReview:policy};
    });
  }

  private riskPolicy(scope:Scope) {
    return scope.office.risk_review?JSON.parse(scope.office.risk_review) as z.infer<typeof riskPolicySchema>:null;
  }

  async attention(context: TrustedCallContext, after = 0, includeInProgress = true) {
    const seats = await this.graph.offices.authorizedSeats(context);
    if (!context.roleId || !seats.length) return {};
    const officeIds = JSON.stringify([...new Set(seats.map(s => s.office_id))]);
    const change = await this.db.get<Row>(`
      SELECT t.id,t.office_id,t.title,t.status,t.revision,c.seq,c.kind,c.audience
      FROM office_guided_changes c JOIN office_guided_tasks t ON t.id=c.task_id
      JOIN offices o ON o.id=t.office_id
      LEFT JOIN office_guided_settings g ON g.office_id=t.office_id
      WHERE c.seq>? AND t.office_id IN (SELECT value FROM json_each(?))
        AND o.state='active' AND (o.deadline IS NULL OR o.deadline>?)
        AND t.status NOT IN ('done','cancelled')
        AND ((c.audience='owner' AND t.owner_id=?) OR (c.audience='supervisor' AND g.supervisor_id=?))
      ORDER BY c.seq LIMIT 1`, [after,officeIds,this.clock(),context.roleId,context.roleId]);
    if (change) {
      return {change: {
        seq:change.seq,taskId:change.id,kind:change.kind,title:change.title,status:change.status,revision:change.revision,
        nextCall: change.audience==='owner' && change.status==='queued'
          ? this.changeCall(change,'claim') : change.kind==='review_needed'
            ? {tool:'office_guided_task',arguments:{action:'review_queue',officeId:change.office_id}}
            : this.getCall(change)
      }};
    }
    if (!includeInProgress) return {};
    const current = await this.db.get<Row>(`
      SELECT t.id,t.office_id,t.title,t.revision FROM office_guided_tasks t JOIN offices o ON o.id=t.office_id
      WHERE t.owner_id=? AND t.status='working' AND t.office_id IN (SELECT value FROM json_each(?))
        AND o.state='active' AND (o.deadline IS NULL OR o.deadline>?)
      ORDER BY t.updated_at DESC,t.id LIMIT 1`,[context.roleId,officeIds,this.clock()]);
    return current ? {inProgress:{title:current.title,revision:current.revision,nextCall:this.getCall(current)}} : {};
  }

  private getCall(row: Row) {
    return {tool:'office_guided_task',arguments:{action:'get',officeId:row.office_id,taskId:row.id}};
  }

  private changeCall(row: Row, action: 'claim'|'submit'|'progress'|'review') {
    return {tool:'office_guided_task',arguments:{action,officeId:row.office_id,taskId:row.id,
      expectedRevision:row.revision,key:`${action}:${row.id}:${row.revision}`}};
  }

  private async publishChange(taskId: string, audience: Audience, kind: string) {
    await this.db.run('INSERT OR REPLACE INTO office_guided_changes(task_id,audience,kind) VALUES(?,?,?)',
      [taskId,audience,kind]);
  }

  private async clearChange(taskId: string, audience: Audience) {
    await this.db.run('DELETE FROM office_guided_changes WHERE task_id=? AND audience=?',[taskId,audience]);
  }

  private async validateDelivery(officeId: string, delivery: z.infer<typeof deliverySchema>) {
    for (const [index,check] of delivery.checks.entries()) {
      if (check.status==='verified' && !check.evidence && !check.materialId && !check.artifactId)
        throw new MindPondError('invalid_input','A verified check needs evidence.',{
          field:`delivery.checks[${index}]`,
          nextAction:'Add evidence, a published materialId or a ready office artifactId to this check. Use not_verified if you have no evidence.'
        });
      if (check.materialId && !await this.db.get(
        "SELECT 1 FROM office_materials WHERE id=? AND office_id=? AND state='published'",[check.materialId,officeId]))
        throw new MindPondError('not_found','Evidence material must be published in this task office.');
      if (check.artifactId && !await this.db.get(
        "SELECT 1 FROM office_artifacts WHERE id=? AND scope='office' AND office_id=? AND state='ready' AND expires_at>?",
        [check.artifactId,officeId,this.clock()]))
        throw new MindPondError('not_found','Evidence artifact must be ready and shared in this task office.');
    }
  }

  private async task(officeId: string, taskId: string | undefined, scope: Scope) {
    if (!taskId) return bad('This action requires taskId.');
    const row = await this.db.get<TaskRow>('SELECT * FROM office_guided_tasks WHERE id=? AND office_id=?',[taskId,officeId]);
    if (!row || (!scope.supervisor && row.owner_id!==scope.roleId))
      throw new MindPondError('not_found','Task is unavailable in this office and role.');
    return row;
  }

  private project(row: Row) {
    const lastReportedAt = Math.max(row.progress_at??0,row.submitted_at??0) || null;
    return {id:row.id,officeId:row.office_id,ownerId:row.owner_id,title:row.title,status:row.status,
      blocker:row.blocker,revision:row.revision,guidanceRevision:row.guide_revision,updatedAt:row.updated_at,
      revisionsRequested:row.revisions_requested,lastReportedAt,
      ...(row.progress_note&&['working','blocked'].includes(row.status)?{progressPreview:row.progress_note.slice(0,160)}:{})};
  }

  private async detail(row: Row, scope: Scope) {
    const owner=scope.roleId===row.owner_id;
    const open=scope.office.state==='active'&&(!scope.office.deadline||scope.office.deadline>this.clock());
    const policy=this.riskPolicy(scope);
    const outcomes = await this.db.all<Row[]>(`SELECT discussion_id discussionId,title,conclusion,author,created_at createdAt,details
      FROM office_guided_outcomes WHERE task_id=? ORDER BY created_at DESC,discussion_id LIMIT 8`, [row.id]);
    const handoff=await this.db.get<Row>(`SELECT seq eventSeq,ts at,json_extract(body,'$.previousOwnerName') previousOwnerName,
      substr(json_extract(body,'$.reason'),1,240) reason,
      substr(COALESCE(json_extract(body,'$.previousAttempt.result'),json_extract(body,'$.previousAttempt.progress.note'),
        json_extract(body,'$.previousAttempt.note')),1,400) preview,
      json_extract(body,'$.previousAttempt.progress.materialId') materialId
      FROM office_events WHERE office_id=? AND kind='guided_task' AND json_extract(body,'$.taskId')=?
        AND json_extract(body,'$.action')='reassign' ORDER BY seq DESC LIMIT 1`,[row.office_id,row.id]);
    const rooms = await this.db.all<Row[]>(`SELECT d.id,d.title FROM office_discussions d
      WHERE d.guided_task_id=? AND (d.locked=1 OR d.expires_at>?) AND (? OR EXISTS (
        SELECT 1 FROM office_discussion_members m WHERE m.room_id=d.id AND m.role_id=?
      )) ORDER BY d.id`,[row.id,this.clock(),scope.human,scope.roleId]);
    const seatArchive=scope.human?await this.db.get<Row>(
      'SELECT id FROM office_seat_item_archive WHERE office_id=? AND continuation_id=?',[row.office_id,row.id]):null;
    return {...this.project(row),goal:row.goal,acceptance:row.acceptance,note:row.note,result:row.result,
      ...(seatArchive?{seatArchiveId:seatArchive.id}:{}),
      ...(row.release_rule?{releaseRule:row.release_rule}:{}),
      blockReport:row.block_report ? JSON.parse(row.block_report) : null,
      delivery:row.delivery ? JSON.parse(row.delivery) : null,
      ...(row.progress_note?{progress:{note:row.progress_note,reportedAt:row.progress_at,materialId:row.progress_material_id}}:{}),
      ...(row.batch_id?{evidenceIndex:{tool:'office_guided_task',arguments:{action:'evidence_index',officeId:row.office_id,taskId:row.id}}}:{}),
      ...(row.risk_spec?{risk:JSON.parse(row.risk_spec)}:{}),
      ...(scope.supervisor&&row.status==='review'&&policy?.requireAudit&&!row.review_submission_id?{auditSubmissionMissing:true}:{}),
      ...(scope.supervisor&&row.review_submission_id&&policy?
        {reviewPacket:{tool:'office_guided_task',arguments:{action:'review_packet',officeId:row.office_id,taskId:row.id}}}:{}),
      ...(row.brief_material_id?{brief:{materialId:row.brief_material_id,
        nextCall:{tool:'office_material',arguments:{action:'get',officeId:row.office_id,materialId:row.brief_material_id,number:0}}}}:{}),
      guidance:{by:row.guided_by,instruction:row.instruction,
        ...(row.memory_query?{memory:{tool:'memory_brief',arguments:{task:row.memory_query,limit:3},
          instruction:'Use the separate Memory MCP before work. Check the source and applicability. If retrieval is unavailable, report it and use other permitted evidence.'}}:{})},
      ...(handoff?{handoff}:{}),
      rooms,outcomes:outcomes.map(({details,...outcome})=>({...outcome,...(details?{details:JSON.parse(details)}:{})})),
      ...(owner&&open&&['queued','blocked'].includes(row.status)?{claim:this.changeCall(row,'claim')}:{}),
      ...(owner&&open&&['working','blocked'].includes(row.status)?{reportProgress:{nextCall:this.changeCall(row,'progress'),
        instruction:'Add a short note with confirmed findings or remaining work. To share a material in the current progress report, include its published progressMaterialId.'}}:{}),
      ...(owner&&open&&row.status==='working'?{submission:{nextCall:this.changeCall(row,'submit'),
        instruction:row.release_rule?'Submit structured checks with explicit conclusions. For require_evidence, attach a published material or ready office artifact to each passing check.':
          policy?'Use delivery with summary and checks for risk review. A note can record a report while required checks remain outstanding.':
          'Add note with your conclusion, evidence and unknowns. Structured delivery is optional.',
        maxChecks:policy?MAX_REVIEW_CHECKS:5}}:{})};
  }

  private async evidenceIndex(row: Row) {
    const references = row.batch_id ? await this.db.all<Row[]>(`
      SELECT m.id materialId,m.label title,m.version,m.sha256,m.seat_id publishedBySeat,
        t.owner_id reportedBy,t.progress_at reportedAt
      FROM office_guided_tasks t JOIN office_materials m ON m.id=t.progress_material_id AND m.office_id=t.office_id
      WHERE t.office_id=? AND t.batch_id=? AND t.id<>? AND t.status<>'cancelled' AND m.state='published'
      ORDER BY t.progress_at DESC,t.id LIMIT 8`,[row.office_id,row.batch_id,row.id]) : [];
    const unique = new Map<string,Row>();
    for(const reference of references)if(!unique.has(reference.materialId))unique.set(reference.materialId,reference);
    return {evidence:[...unique.values()].map(reference=>({...reference,
      nextCall:{tool:'office_material',arguments:{action:'get',officeId:row.office_id,materialId:reference.materialId}}})),
      notice:'These are references explicitly shared by peers. Check their version, environment and applicability before reusing them.'};
  }

  private async create(i: z.infer<typeof guidedTaskSchema>, scope: Scope, context?: TrustedCallContext, batchId?:string) {
    const author=scope.roleId??'human',hash=digest(i);
    if (!scope.canManage) return denied('Task assignment requires the human manager or a supervisor with task management permission.');
    const previous = await this.db.get<Row>('SELECT * FROM office_guided_tasks WHERE office_id=? AND author=? AND create_key=?',[i.officeId,author,i.key]);
    if (previous) {
      if (previous.create_hash!==hash) throw new MindPondError('idempotency_conflict','This assignment key has another payload.');
      return {row:previous,replayed:true};
    }
    this.assertOpen(scope);
    if (!i.ownerId || !i.title || !i.goal || !i.acceptance) return bad('Assign an owner, title, goal and acceptance criteria.');
    if(i.risk&&!this.riskPolicy(scope))return bad('Enable risk review in this office before assigning risk fields.');
    const owner = await this.member(i.officeId,i.ownerId);
    if (!owner) return bad('The owner must be an active member of this office.');
    if (!scope.human) {
      await this.graph.discussions.assertMailbox(context);
      if (owner.principal!==scope.principal && !await this.db.get('SELECT 1 FROM role_links WHERE sender=? AND recipient=?',[scope.roleId,owner.id]))
        return denied('Cross-account task assignments require user permission to contact the owner.');
    }
    if (i.briefMaterialId && !await this.db.get(
      "SELECT 1 FROM office_materials WHERE id=? AND office_id=? AND state='published'",[i.briefMaterialId,i.officeId]))
      throw new MindPondError('not_found','Publish the shared brief in this office before assigning it.');
    const count = await this.db.get<Row>(`SELECT COUNT(*) n FROM office_guided_tasks WHERE office_id=? AND status NOT IN ('done','cancelled')`,[i.officeId]);
    if (count!.n>=500) return bad('This office already has 500 open tasks. Close an existing task before creating another.');
    const taskId = randomUUID(), now=this.clock();
    await this.db.run(`INSERT INTO office_guided_tasks
      (id,office_id,owner_id,author,guided_by,title,goal,acceptance,instruction,memory_query,status,updated_at,create_key,create_hash,brief_material_id,created_at,risk_spec,batch_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?)`,[taskId,i.officeId,i.ownerId,author,author,i.title,i.goal,i.acceptance,
      i.instruction??null,i.memoryQuery===undefined?i.title:i.memoryQuery,now,i.key,hash,i.briefMaterialId??null,now,i.risk?JSON.stringify(i.risk):null,batchId??null]);
    await this.publishChange(taskId,'owner','assignment');
    const row=await this.task(i.officeId,taskId,scope);
    await this.taskEvent(row,scope.roleId,'created');
    return {row,replayed:false};
  }

  private async taskEvent(row:Row,roleId:string|null,action:string,extra:Row={}) {
    const owner=await this.db.get<Row>('SELECT name FROM character_roles WHERE id=?',[row.owner_id]);
    const actor=roleId===row.owner_id?owner:roleId?
      await this.db.get<Row>('SELECT name FROM character_roles WHERE id=?',[roleId]):null;
    await this.graph.officeCollaboration.event(row.office_id,roleId,'guided_task',{
      taskId:row.id,title:row.title,revision:row.revision,status:row.status,action,
      ownerId:row.owner_id,ownerName:owner?.name,actorName:actor?.name??'用户',...extra
    });
  }

  private async reassign(row:Row,i:z.infer<typeof guidedTaskSchema>) {
    if(!i.ownerId||!i.note)return bad('Choose a new owner and explain the reassignment in note.');
    if(i.ownerId===row.owner_id)return bad('Choose a different owner.');
    if(!await this.member(i.officeId,i.ownerId))return bad('The new owner must be an active member of this office.');
    const prior=await this.db.get<Row>('SELECT name FROM character_roles WHERE id=?',[row.owner_id]);
    const run=await this.riskReview.read(row as TaskRow);
    const priorAudits=run?JSON.parse(run.audits).map(({actor,at,entries}:Row)=>({actor,at,entries})):undefined;
    const previousAttempt={
      status:row.status,revision:row.revision,note:row.note,result:row.result,blocker:row.blocker,
      blockReport:row.block_report?JSON.parse(row.block_report):null,delivery:row.delivery?JSON.parse(row.delivery):null,
      progress:row.progress_note?{note:row.progress_note,reportedAt:row.progress_at,materialId:row.progress_material_id}:null,
      submissionId:row.review_submission_id,priorAudits,firstClaimedAt:row.first_claimed_at,submittedAt:row.submitted_at,
      revisionsRequested:row.revisions_requested
    };
    await this.db.run(`UPDATE office_guided_tasks SET owner_id=?,status='queued',blocker=NULL,note=NULL,result=NULL,
      block_report=NULL,delivery=NULL,progress_note=NULL,progress_at=NULL,progress_material_id=NULL,
      first_claimed_at=NULL,submitted_at=NULL,reviewed_at=NULL,review_submission_id=NULL,revisions_requested=0 WHERE id=?`,
      [i.ownerId,row.id]);
    await this.clearChange(row.id,'supervisor');
    await this.publishChange(row.id,'owner','assignment');
    return {previousOwnerId:row.owner_id,previousOwnerName:prior?.name,previousAttempt,reason:i.note};
  }

  private async releaseAssessment(scope:Scope) {
    const officeId=scope.office.id;
    const rows=await this.db.all<TaskRow[]>(`SELECT id,office_id,owner_id,title,status,revision,release_rule,delivery,risk_spec,block_report,note
      FROM office_guided_tasks WHERE office_id=? AND release_rule IS NOT NULL ORDER BY id`,[officeId]);
    if(!rows.length)return {status:'not_configured' as const};
    const policy=this.riskPolicy(scope);
    const tasks=rows.map(row=>({row,delivery:['review','done'].includes(row.status)&&row.delivery?
      JSON.parse(row.delivery) as Delivery:null}));
    const runs=await this.riskReview.readCurrent(officeId,policy?
      tasks.filter(({delivery})=>delivery).map(({row})=>row.id):[]);
    const auditSources=[...runs.values()].flatMap(run=>(JSON.parse(run.audits) as {
      entries:{materialId?:string;artifactId?:string}[]
    }[]).flatMap(event=>event.entries));
    const refs=await this.riskReview.references(officeId,[...tasks.flatMap(({delivery})=>delivery?.checks??[]),...auditSources]);
    const findings=await Promise.all(tasks.map(async ({row,delivery})=>{
      const reason=(state:'hold'|'pending',code:string,check?:Delivery['checks'][number],detail?:string)=>({
        state,code,taskId:row.id,title:row.title,revision:row.revision,taskStatus:row.status,nextCall:this.getCall(row),
        basis:code==='independent_review_pending'?'independent_review':code==='evidence_unavailable'?'evidence_availability':
          check||delivery?'owner_report':'task_state',
        ...(check?{criterion:check.criterion.slice(0,100),...(check.evidenceVersion?{evidenceVersion:check.evidenceVersion}:{})}:{}),
        ...(check?.materialId?{materialId:check.materialId}:{}),
        ...(check?.artifactId?{artifactId:check.artifactId}:{}),
        observation:(detail??check?.observed??check?.evidence)?.slice(0,180)
      });
      if(row.status==='blocked')return reason('hold','task_blocked',undefined,
        row.block_report?JSON.parse(row.block_report).obstacle:row.note);
      if(row.status==='cancelled')return reason('pending','task_cancelled');
      if(!['review','done'].includes(row.status))return reason('pending','delivery_pending');
      if(!delivery)return reason('pending','structured_delivery_missing');
      const risk=JSON.parse(row.risk_spec??'{"level":"normal"}') as z.infer<typeof taskRiskSchema>;
      const target=risk.targetVersion;
      const checks=target?delivery.checks.filter(check=>check.evidenceVersion===target):delivery.checks;
      const failure=checks.find(check=>check.conclusion==='fail');
      if(failure)return reason('hold','reported_failure',failure);
      if(!checks.length||target&&delivery.checks.some(check=>!check.evidenceVersion))
        return reason('pending','target_version_unverified',undefined,target);
      const unavailable=checks.find(check=>check.materialId&&!refs.materials.has(check.materialId)||
        check.artifactId&&!refs.artifacts.has(check.artifactId));
      if(unavailable)return reason('pending','evidence_unavailable',unavailable,'A referenced material or attachment is unavailable.');
      const versionMismatch=target&&checks.find(check=>{
        const version=check.materialId&&refs.materials.get(check.materialId);
        return version&&version!=='unversioned'&&version!==target;
      });
      if(versionMismatch)return reason('pending','target_version_unverified',versionMismatch,target);
      const missingCheck=risk.requiredChecks?.find(required=>!checks.some(check=>check.checkId===required));
      if(missingCheck)return reason('pending','required_check_missing',undefined,missingCheck);
      const unchecked=checks.find(check=>check.status!=='verified'||check.conclusion!=='pass');
      if(unchecked)return reason('pending','check_unverified',unchecked);
      if(delivery.unknowns)return reason('pending','unknowns_reported',undefined,delivery.unknowns);
      if(row.release_rule==='require_evidence'){
        const unlinked=checks.find(check=>!check.materialId&&!check.artifactId);
        if(unlinked)return reason('pending','shared_evidence_missing',unlinked);
      }
      if(policy?.requireAudit){
        const run=runs.get(row.id);
        const packet=run?await this.riskReview.packet(row,run,false,refs,refs):null;
        if(!packet||packet.missingDelivery||packet.missingCheckIds.length||packet.pendingCount)
          return reason('pending','independent_review_pending');
      }
      return null;
    }));
    const holds=findings.filter(finding=>finding?.state==='hold');
    const pending=findings.filter(finding=>finding?.state==='pending');
    const recordable=scope.office.state==='active'&&(!scope.office.deadline||scope.office.deadline>this.clock());
    const status:'hold'|'pending'|'ready'=holds.length?'hold':pending.length?'pending':'ready';
    const snapshotId=digest({version:1,officeId,policyRevision:scope.office.revision??0,recordable,
      tasks:rows.map(row=>[row.id,row.revision,row.release_rule,row.status,runs.get(row.id)?.id,runs.get(row.id)?.audits]),
      materials:[...refs.materials].sort(),artifacts:[...refs.artifacts].sort(),findings});
    return {status,snapshotId,scope:'marked_tasks',
      counts:{total:rows.length,hold:holds.length,pending:pending.length,ready:rows.length-holds.length-pending.length},
      taskAcceptance:{accepted:rows.filter(row=>row.status==='done').length,awaitingReview:rows.filter(row=>row.status==='review').length},
      reasons:[...holds,...pending].slice(0,5),
      ...(recordable?{recordCall:{tool:'office_guided_task',arguments:{action:'record_assessment',officeId,snapshotId}}}:{}),
      notice:'Covers only tasks explicitly marked by the human manager, across all pages. This is an advisory check; task acceptance and release remain explicit.'};
  }

  private async recordAssessment(i:z.infer<typeof guidedTaskSchema>,scope:Scope) {
    const actor=scope.human?'assessment:human:'+scope.principal:'assessment:role:'+scope.roleId;
    const fingerprint=digest({officeId:i.officeId,snapshotId:i.snapshotId,note:i.note});
    const previous=await this.db.get<Row>('SELECT hash,result FROM office_collaboration_receipts WHERE actor=? AND key=? AND office_id=?',
      [actor,i.snapshotId,i.officeId]);
    if(previous){
      if(previous.hash!==fingerprint)throw new MindPondError('idempotency_conflict','This snapshot was already recorded with a different note.');
      return {...JSON.parse(previous.result),replayed:true};
    }
    const current=await this.releaseAssessment(scope);
    if(current.status==='not_configured'||current.snapshotId!==i.snapshotId)
      throw new MindPondError('stale_version','The release assessment changed before it was recorded.',{
        field:'snapshotId',nextAction:'Review the current assessment before recording it. Use its recordCall if you still want to save it.',
        details:{releaseAssessment:current}
      });
    this.assertOpen(scope);
    const {status,snapshotId,counts,taskAcceptance,reasons}=current;
    const record=await this.graph.officeCollaboration.storeRecord({
      id:randomUUID(),officeId:i.officeId,kind:'marker',author:scope.roleId??'human',title:'放行判断',
      assessment:{status,snapshotId,scope:current.scope,counts,taskAcceptance,reasons},
      ...(i.note?{note:i.note}:{})
    });
    const result={...record,recorded:true,status,snapshotId};
    await this.db.run('INSERT INTO office_collaboration_receipts VALUES(?,?,?,?,?)',
      [actor,i.snapshotId,fingerprint,JSON.stringify(result),i.officeId]);
    return result;
  }

  /** Operator UI projection. Message counts cover this office and opening the console takes no mail. */
  async console(value: unknown, context: TrustedCallContext) {
    const i=consoleSchema.parse(value);
    return this.read(async()=>{
      const scope=await this.scope(i.officeId,context);
      if(!scope.human)return denied('Only the human manager can open the office task console.');
      const office=i.officeId,role=i.roleId??null;
      const taskLimit=12,activityLimit=18;
      const tasks=await this.db.all<Row[]>(`SELECT t.id,t.title,t.owner_id ownerId,r.name ownerName,t.status,t.blocker,
        t.revision,t.updated_at updatedAt
        FROM office_guided_tasks t JOIN character_roles r ON r.id=t.owner_id
        WHERE t.office_id=? AND (? IS NULL OR t.owner_id=?) AND (? IS NULL OR t.status=?)
          AND (? IS NULL OR (t.updated_at,t.id)<(?,?))
        ORDER BY t.updated_at DESC,t.id DESC LIMIT ?`,
      [office,role,role,i.status??null,i.status??null,i.taskBefore?.at??null,i.taskBefore?.at??null,i.taskBefore?.key??null,taskLimit+1]);
      const members=await this.db.all<Row[]>(`WITH members AS (
        SELECT DISTINCT r.id,r.name FROM character_roles r JOIN role_seats rs ON rs.role_id=r.id
        JOIN office_seats s ON s.id=rs.seat_id WHERE s.office_id=? AND s.enabled=1 AND r.state='active'
      )
      SELECT r.*,t.id taskId,t.title taskTitle,t.status taskStatus,
        (SELECT COUNT(*) FROM role_messages m JOIN role_message_states s ON s.message_id=m.id
          WHERE m.office_id=? AND m.recipient=r.id AND ${messageStateSql()}='pending') pending,
        (SELECT COUNT(*) FROM role_messages m JOIN role_message_states s ON s.message_id=m.id
          WHERE m.office_id=? AND m.recipient=r.id AND s.state='processing') processing
      FROM members r LEFT JOIN office_guided_tasks t ON t.id=(
        SELECT id FROM office_guided_tasks WHERE office_id=? AND owner_id=r.id AND status NOT IN ('done','cancelled')
        ORDER BY CASE status WHEN 'working' THEN 0 WHEN 'blocked' THEN 1 WHEN 'review' THEN 2 ELSE 3 END,updated_at DESC,id DESC LIMIT 1
      ) ORDER BY r.name,r.id`,[office,office,office,office]);
      const counts=await this.db.all<{status:string;count:number}[]>(
        'SELECT status,COUNT(*) count FROM office_guided_tasks WHERE office_id=? GROUP BY status',[office]);
      // Tasks predating event recording have one explicitly labeled snapshot.
      const activitySources=[
        ['message',`SELECT m.id,m.created_at at,'message' kind,'message:'||m.id key,
          m.sender_name actor,m.recipient_name recipient,${messageStateSql()} status,substr(m.body,1,150) preview,NULL taskId,NULL action
          FROM role_messages m JOIN role_message_states s ON s.message_id=m.id
          WHERE m.office_id=? AND (? IS NULL OR ?=m.sender OR ?=m.recipient)`,[office,role,role,role]],
        ['task',`SELECT CAST(e.seq AS TEXT) id,e.ts at,'task_event' kind,'task_event:'||printf('%020d',e.seq) key,
          json_extract(e.body,'$.actorName') actor,json_extract(e.body,'$.ownerName') recipient,
          json_extract(e.body,'$.status') status,json_extract(e.body,'$.title') preview,
          json_extract(e.body,'$.taskId') taskId,json_extract(e.body,'$.action') action
          FROM office_events e WHERE e.office_id=? AND e.kind='guided_task'
            AND (? IS NULL OR ?=json_extract(e.body,'$.ownerId') OR ?=json_extract(e.body,'$.previousOwnerId')
              OR ?=json_extract(e.actor,'$.roleId'))`,[office,role,role,role,role]],
        ['task',`SELECT t.id,t.updated_at at,'task' kind,'task:'||t.id key,
          r.name actor,NULL recipient,t.status,t.title preview,t.id taskId,NULL action
          FROM office_guided_tasks t JOIN character_roles r ON r.id=t.owner_id
          WHERE t.office_id=? AND (? IS NULL OR ?=t.owner_id)
            AND NOT EXISTS (SELECT 1 FROM office_events e WHERE e.office_id=t.office_id AND e.kind='guided_task'
              AND json_extract(e.body,'$.taskId')=t.id)`,[office,role,role]],
        ['evidence',`SELECT p.id,p.created_at at,p.kind kind,p.kind||':'||p.id key,
          COALESCE(r.name,CASE p.role_id WHEN 'human' THEN '用户' ELSE '成员已不可用' END) actor,
          NULL recipient,json_extract(p.payload,'$.assessment.status') status,
          substr(json_extract(p.payload,'$.title'),1,160) preview,t.id taskId,NULL action
          FROM office_collaboration_records p LEFT JOIN character_roles r ON r.id=p.role_id
          LEFT JOIN office_guided_tasks t ON t.office_id=p.office_id AND t.id=json_extract(p.payload,'$.taskId')
          WHERE p.office_id=? AND (p.kind='progress' OR (p.kind='marker' AND json_type(p.payload,'$.assessment')='object'))
          AND (? IS NULL OR ?=p.role_id OR ?=t.owner_id)`,[office,role,role,role]]
      ] as const;
      const sources=activitySources.filter(([kind])=>!i.activity||i.activity===kind);
      const activity=await this.db.all<Row[]>(`WITH activity AS (${sources.map(([,sql])=>sql).join(' UNION ALL ')})
        SELECT * FROM activity WHERE (? IS NULL OR (at,key)<(?,?)) ORDER BY at DESC,key DESC LIMIT ?`,
      [...sources.flatMap(([, ,args])=>args),i.activityBefore?.at??null,i.activityBefore?.at??null,i.activityBefore?.key??null,activityLimit+1]);
      const taskPage=tasks.slice(0,taskLimit), activityPage=activity.slice(0,activityLimit);
      const lastTask=taskPage.at(-1),lastActivity=activityPage.at(-1);
      return {officeId:office,supervisorId:scope.office.supervisor_id??null,
        supervisorMode:scope.office.supervisor_mode??'manage',policyRevision:scope.office.revision??0,
        reviewMode:scope.office.review_mode??'all',riskReview:this.riskPolicy(scope),
        counts:Object.fromEntries(counts.map(({status,count})=>[status,count])),members,tasks:taskPage,activity:activityPage,
        priorities:await this.priorityRows(office,null),
        releaseAssessment:await this.releaseAssessment(scope),
        nextTask:tasks.length>taskLimit&&lastTask?{at:lastTask.updatedAt,key:lastTask.id}:null,
        nextActivity:activity.length>activityLimit&&lastActivity?{at:lastActivity.at,key:lastActivity.key}:null};
    });
  }

  private priorityRows(officeId:string,roleId:string|null) {
    return this.db.all<Row[]>(`SELECT t.id,t.office_id,t.title,t.status,t.blocker,COUNT(*) OVER () total
      FROM office_guided_tasks t WHERE t.office_id=? AND (? IS NULL OR t.owner_id=?) AND (t.status='blocked' OR
        (t.status='review' AND EXISTS(SELECT 1 FROM json_each(t.delivery,'$.checks') c
          WHERE json_extract(c.value,'$.conclusion')='fail')))
      ORDER BY CASE WHEN t.status='blocked' AND t.blocker='decision' THEN 0 WHEN t.status='blocked' THEN 1 ELSE 2 END,
        t.updated_at DESC,t.id LIMIT 5`,[officeId,roleId,roleId]);
  }

  private async dashboard(i:z.infer<typeof guidedTaskSchema>,scope:Scope) {
    if(!scope.supervisor)throw new MindPondError('scope_denied','Only the current office supervisor or human manager can view the office dashboard.',{
      nextAction:'Use office_guided_task list to see work assigned to your role.'
    });
    if(i.filter==='closed')return bad('The dashboard shows open tasks. Use list with filter=closed for history.');
    const limit=i.limit??12;
    const open="t.office_id=? AND t.status IN ('queued','working','blocked','review') AND (? IS NULL OR t.owner_id=?)";
    const args=[i.officeId,i.ownerId??null,i.ownerId??null];
    const counts=await this.db.get<Row>(`SELECT COUNT(*) total,
      COUNT(CASE WHEN t.status='queued' THEN 1 END) queued,
      COUNT(CASE WHEN t.status='working' THEN 1 END) working,
      COUNT(CASE WHEN t.status='blocked' THEN 1 END) blocked,
      COUNT(CASE WHEN t.status='blocked' AND t.blocker='decision' THEN 1 END) decisions,
      COUNT(CASE WHEN t.status='review' THEN 1 END) review
      FROM office_guided_tasks t WHERE ${open}`,args);
    const priorityRows=await this.priorityRows(i.officeId,i.ownerId??null);
    const rows=await this.db.all<TaskRow[]>(`SELECT t.id,t.office_id,t.owner_id,t.title,t.status,t.blocker,t.revision,t.guide_revision,t.updated_at,
      t.revisions_requested,t.progress_at,t.progress_note,t.submitted_at,t.result,t.delivery,t.block_report,t.risk_spec,
      r.name owner_name,m.id progress_material_id,
      EXISTS(SELECT 1 FROM role_seats rs JOIN office_seats s ON s.id=rs.seat_id
        WHERE rs.role_id=r.id AND s.office_id=t.office_id AND s.enabled=1 AND r.state='active') owner_available,
      (SELECT json_object('id',p.id,'title',json_extract(p.payload,'$.title'),'publishedAt',p.created_at)
        FROM office_collaboration_records p WHERE p.office_id=t.office_id AND p.kind='progress'
        AND json_extract(p.payload,'$.taskId')=t.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1) shared
      FROM office_guided_tasks t JOIN character_roles r ON r.id=t.owner_id
      LEFT JOIN office_materials m ON m.id=t.progress_material_id AND m.office_id=t.office_id AND m.state='published'
      WHERE ${open} AND t.id>? AND (? OR t.status IN ('blocked','review')) ORDER BY t.id LIMIT ?`,
      [...args,i.afterId??'',i.filter!=='attention',limit+1]);
    const page=rows.slice(0,limit).map(row=>({
      row,delivery:row.status==='review'&&row.delivery?JSON.parse(row.delivery) as Delivery:null
    }));
    const policy=this.riskPolicy(scope);
    const [refs,runs]=await Promise.all([
      this.riskReview.references(i.officeId,page.flatMap(({delivery})=>delivery?.checks??[])),
      this.riskReview.readCurrent(i.officeId,policy?page.filter(({row})=>row.status==='review').map(({row})=>row.id):[])
    ]);
    const tasks=await Promise.all(page.map(async ({row,delivery})=>{
      const blocked=row.status==='blocked'&&row.block_report?JSON.parse(row.block_report):null;
      const shared=row.shared?JSON.parse(row.shared):null;
      const projected=this.project(row);
      const reportedFailures=checkPreviews(delivery?.checks.filter(check=>check.conclusion==='fail')??[]);
      const unverifiedChecks=checkPreviews(delivery?.checks.filter(check=>check.status==='not_verified'||check.conclusion==='unknown')??[]);
      const unavailableReferences=checkPreviews(delivery?.checks.filter(check=>
        Boolean(check.materialId&&!refs.materials.has(check.materialId)||check.artifactId&&!refs.artifacts.has(check.artifactId)))??[]);
      const run=runs.get(row.id);
      const packet=run?await this.riskReview.packet(row,run,false,refs):null;
      const summary=row.status==='review'?(delivery?.summary??row.result??''):null;
      return {...projected,ownerName:row.owner_name,ownerAvailable:Boolean(row.owner_available),
        lastReportedAt:Math.max(projected.lastReportedAt??0,shared?.publishedAt??0)||null,
        ...(blocked?.obstacle?{obstacle:blocked.obstacle.slice(0,180)}:{}),
        ...(blocked?.decision?{decision:blocked.decision.slice(0,180)}:{}),
        ...(reportedFailures?{reportedFailures}:{}),
        ...(unverifiedChecks?{unverifiedChecks}:{}),
        ...(unavailableReferences?{unavailableReferences}:{}),
        ...(summary!==null?{deliveryPreview:summary.slice(0,180),
          ...(!delivery?{deliveryFormat:'note'}:{}),
          ...(summary.length>180?{deliveryPreviewTruncated:true}:{})}:{}),
        ...(policy&&row.status==='review'?{audit:{
          requiredBeforeAcceptance:policy.requireAudit,hasPacket:Boolean(packet),missingDelivery:packet?.missingDelivery??!delivery,
          missingChecks:packet?.missingCheckIds.length??null,pendingChecks:packet?.pendingCount??null,
          ...(packet?{nextCall:{tool:'office_guided_task',arguments:{action:'review_packet',officeId:i.officeId,taskId:row.id}}}:{})
        }}:{}),
        ...(delivery?.unknowns?{unknowns:delivery.unknowns.slice(0,160)}:{}),
        ...(row.progress_material_id?{materialId:row.progress_material_id}:{}),
        ...(shared?{sharedProgress:{...shared,nextCall:{tool:'office_context',arguments:{action:'records',officeId:i.officeId,kind:'progress',id:shared.id}}}}:{}),
        nextCall:this.getCall(row)};
    }));
    const nextAfterId=rows.length>limit?tasks.at(-1)?.id:null;
    const releaseAssessment=await this.releaseAssessment(scope);
    return {officeId:i.officeId,observedAt:this.clock(),supervisorId:scope.office.supervisor_id??null,
      supervisorMode:scope.office.supervisor_mode??'manage',canManage:scope.canManage,counts,tasks,
      ...(releaseAssessment.status!=='not_configured'?{releaseAssessment}:{}),
      priority:{total:priorityRows[0]?.total??0,items:priorityRows.map(row=>({id:row.id,title:row.title,
        kind:row.status==='blocked'?(row.blocker==='decision'?'decision':'blocked'):'reported_failure',nextCall:this.getCall(row)}))},
      coverage:{partial:Boolean(i.afterId||nextAfterId),filtered:Boolean(i.ownerId||i.filter==='attention')},
      nextAfterId,...(nextAfterId?{nextCall:{tool:'office_guided_task',arguments:{
        action:'dashboard',officeId:i.officeId,afterId:nextAfterId,
        ...(i.filter?{filter:i.filter}:{}),...(i.ownerId?{ownerId:i.ownerId}:{}),...(i.limit?{limit:i.limit}:{})
      }}}:{}),
      notice:'Refresh before deciding. Priority covers blocked tasks and reported failures across pages, within the selected owners. Read remaining pages or relevant details for missing evidence. Reports and markers are advisory; formal acceptance uses the current task revision and office policy.'};
  }

  private async reviewQueue(i: z.infer<typeof guidedTaskSchema>,scope: Scope) {
    if (!scope.supervisor) return denied('Only the current supervisor or human manager can read the review queue.');
    const limit=Math.min(i.limit??8,12);
    const rows=await this.db.all<TaskRow[]>(`SELECT * FROM office_guided_tasks WHERE office_id=? AND id>?
      AND (? IS NULL OR id=?) AND (status='review' OR (status='blocked' AND blocker='decision'))
      ORDER BY id LIMIT ?`,[i.officeId,i.afterId??'',i.taskId??null,i.taskId??null,limit+1]);
    const mode=scope.office.review_mode??'all';
    const page=rows.slice(0,limit).map(row=>({
      row,delivery:row.status==='review'&&row.delivery?JSON.parse(row.delivery) as z.infer<typeof deliverySchema>:null
    }));
    const references=page.flatMap(({delivery})=>delivery?.checks??[]);
    const refs=await this.riskReview.references(i.officeId,references);
    const {materials,artifacts}=refs;
    const policy=this.riskPolicy(scope);
    const tasks=await Promise.all(page.map(async ({row,delivery})=>{
      const run=policy&&row.status==='review'?await this.riskReview.read(row):null;
      if(run){
        const risk=await this.riskReview.packet(row,run,false,refs);
        const needsAttention=risk.missingDelivery||risk.missingCheckIds.length>0||risk.pendingCount>0||Boolean(delivery?.unknowns);
        return {...this.project(row),summary:(delivery?.summary??row.note??'').slice(0,240),risk,needsAttention,
          ...(delivery?.unknowns?{unknowns:delivery.unknowns.slice(0,160)}:{}),reviewSuggested:needsAttention,
          nextCall:{tool:'office_guided_task',arguments:{action:'review_packet',officeId:i.officeId,taskId:row.id}}};
      }
      const checks=(delivery?.checks??[]).map(({criterion,status,evidence,materialId,artifactId,conclusion,observed,evidenceVersion,receipt},index)=>({
        criterion:criterion.slice(0,120),status,hasEvidence:Boolean(evidence||materialId&&materials.has(materialId)||artifactId&&artifacts.has(artifactId)),
        referenceUnavailable:Boolean(materialId&&!materials.has(materialId)||artifactId&&!artifacts.has(artifactId)),
        ...(materialId&&materials.has(materialId)?{materialId}:{}),...(artifactId&&artifacts.has(artifactId)?{artifactId}:{}),
        ...(conclusion?{conclusion}:{}),index,observed,evidence,evidenceVersion:evidenceVersion??(materialId?materials.get(materialId):undefined),receipt
      }));
      const auditSubmissionMissing=row.status==='review'&&Boolean(policy?.requireAudit);
      const needsAttention=auditSubmissionMissing||row.status==='blocked'||!delivery||Boolean(delivery.unknowns)||
        checks.some(c=>c.status!=='verified'||!c.hasEvidence||c.referenceUnavailable||c.conclusion==='fail'||c.conclusion==='unknown');
      const priority=(c:typeof checks[number])=>c.conclusion==='fail'?0:
        c.status!=='verified'||c.conclusion==='unknown'||c.referenceUnavailable||!c.hasEvidence?1:2;
      const previews=[...checks].sort((a,b)=>priority(a)-priority(b)).slice(0,3);
      const sample=Number.parseInt(digest(row.id).slice(0,8),16)%4===0;
      const decision=row.status==='blocked'&&row.block_report?JSON.parse(row.block_report).decision as string|undefined:undefined;
      return {...this.project(row),summary:(delivery?.summary??row.note??row.result??'').slice(0,360),checks:
        checks.map(({index,observed,evidence,evidenceVersion,receipt,...check})=>previews.some(c=>c.index===index)?{
          ...check,...(observed?{observed:observed.slice(0,160)}:evidence?{evidencePreview:evidence.slice(0,160)}:{}),
          ...(evidenceVersion?{evidenceVersion}:{}),...(receipt?{receipt}:{}),
        }:check),needsAttention,...(auditSubmissionMissing?{auditSubmissionMissing}:{}),
        ...(decision?{decision:decision.slice(0,160)}:{}),
        ...(delivery?.unknowns?{unknowns:delivery.unknowns.slice(0,160)}:{}),
        reviewSuggested:needsAttention||mode==='all'||(mode==='sample'&&sample),
        ...(scope.canManage&&row.status==='review'&&!policy&&scope.office.state==='active'&&(!scope.office.deadline||scope.office.deadline>this.clock())
          ?{reviewCall:this.changeCall(row,'review')}:{}),
        nextCall:this.getCall(row)};
    }));
    return {tasks,riskReview:policy,reviewMode:mode,supervisorId:scope.office.supervisor_id??null,supervisorMode:scope.office.supervisor_mode??'manage',
      policyRevision:scope.office.revision??0,nextAfterId:rows.length>limit?tasks.at(-1)?.id:null,
      notice:'These are reported findings, not independent verification. Use the summary if sufficient, or open details for more evidence. Only explicit review closes a task.'};
  }

  private async audit(i:z.infer<typeof guidedTaskSchema>,scope:Scope,context?:TrustedCallContext) {
    const policy=this.riskPolicy(scope);
    if(!policy)return bad('Risk review is disabled in this office.');
    if(!scope.supervisor&&scope.roleId!==policy.verifierId)
      return denied('Only the supervisor, human manager, or appointed verifier can read or record independent review.');
    if(i.action==='audit'&&!scope.canManage&&scope.roleId!==policy.verifierId)
      return denied('Recording independent review requires the human manager, a supervisor with task management permission, or the appointed verifier.');
    if(!i.taskId)return bad('Supply taskId to open the review packet.');
    const row=await this.db.get<TaskRow>('SELECT * FROM office_guided_tasks WHERE office_id=? AND id=?',[i.officeId,i.taskId]);
    if(!row)throw new MindPondError('not_found','Task is unavailable in this office.');
    if(!scope.human&&scope.roleId===row.owner_id)return denied('A role cannot independently audit its own report.');
    const run=await this.riskReview.read(row);
    if(!run)throw new MindPondError('not_found','This task has no risk review submission.');
    if(i.action==='audit'){
      if(!i.audit||!i.key)return bad('Supply an audit receipt and a stable key.');
      if(!scope.human)await this.graph.discussions.assertMailbox(context);
      const open=row.status==='review'&&scope.office.state==='active'&&(!scope.office.deadline||scope.office.deadline>this.clock());
      const result=await this.riskReview.record(row,run,i.audit,scope.human?'human:'+scope.principal:scope.roleId!,i.key,open);
      const updated=(await this.riskReview.read(row))!;
      return {...result,risk:await this.riskReview.packet(row,updated)};
    }
    const {checks,...packet}=await this.riskReview.packet(row,run,true);
    const selected=i.includeRoutine?checks:checks.filter(check=>check.required||check.latestAudit);
    const offset=i.checkOffset??0,limit=Math.min(i.limit??8,20);
    return {...packet,checks:selected.slice(offset,offset+limit),nextCheckOffset:offset+limit<selected.length?offset+limit:null};
  }

  async usage(value: unknown,context: TrustedCallContext) {
    const i=usageSchema.parse(value);
    return this.write(async()=>{
      const scope=await this.scope(i.officeId,context);
      if(!scope.human) return denied('Only the human manager can import or read model usage.');
      const row=await this.task(i.officeId,i.taskId,scope);
      if(i.entry){
        const entry=JSON.stringify(i.entry);
        const previous=await this.db.get<Row>('SELECT entry FROM office_guided_usage WHERE task_id=? AND key=?',[row.id,i.entry.key]);
        if(previous && previous.entry!==entry)throw new MindPondError('idempotency_conflict','This usage key already records a different measurement.');
        if(!previous){
          const count=await this.db.get<Row>('SELECT COUNT(*) n FROM office_guided_usage WHERE task_id=?',[row.id]);
          if(count!.n>=100)return bad('A task can store 100 usage entries. Import an aggregate per model and phase.');
          await this.db.run('INSERT INTO office_guided_usage VALUES(?,?,?)',[row.id,i.entry.key,entry]);
        }
      }
      const entries=(await this.db.all<Row[]>('SELECT entry FROM office_guided_usage WHERE task_id=? ORDER BY rowid',[row.id]))
        .map(r=>JSON.parse(r.entry) as z.infer<typeof usageEntry>);
      const sum=(kind:'reported'|'estimate')=>{
        const known=entries.filter(e=>e.meter==='billable'&&e.costKind===kind);
        return known.length?known.reduce((n,e)=>n+e.costMicrousd!,0):null;
      };
      const changes=await this.db.get<Row>('SELECT COUNT(*) n FROM office_guided_receipts WHERE task_id=?',[row.id]);
      const elapsed=(from:number|null,to:number|null)=>from!=null&&to!=null?Math.max(0,to-from):null;
      return {entries,billable:{reportedMicrousd:sum('reported'),estimatedMicrousd:sum('estimate'),
        missingCostEntries:entries.filter(e=>e.meter==='billable'&&e.costMicrousd===undefined).length},
        task:{recordedChanges:1+changes!.n,assignmentToClaimMs:elapsed(row.created_at,row.first_claimed_at),
          claimToSubmissionMs:elapsed(row.first_claimed_at,row.submitted_at),submissionToReviewMs:elapsed(row.submitted_at,row.reviewed_at)}};
    });
  }

  async run(value: unknown, context?: TrustedCallContext): Promise<Row> {
    const i = guidedTaskSchema.parse(value);
    return this.write(async()=>{
      if ((i.action==='dispatch')!==Boolean(i.batch)) bad('Supply batch only for dispatch.');
      if (i.briefMaterialId && i.action!=='create') bad('Use briefMaterialId with create or inside batch.');
      if(i.risk&&i.action!=='create')return bad('Task risk is assigned when creating a task.');
      if(i.audit&&i.action!=='audit')return bad('Use audit receipts with action=audit.');
      if(i.auditOverride&&(i.action!=='review'||i.verdict!=='accept'))return bad('Audit override requires an explicit acceptance.');
      if (i.blockReport && i.action!=='block') bad('blockReport is only for block.');
      if (i.delivery && i.action!=='submit') bad('delivery is only for submit.');
      if (i.progressMaterialId!==undefined && i.action!=='progress') bad('progressMaterialId is only for progress.');
      if(i.resolveDecision && i.action!=='guide') bad('resolveDecision is only for guide.');
      if((i.action==='set_release_rule')!==(i.releaseRule!==undefined))
        return bad('Use set_release_rule with releaseRule, or null to remove the rule.');
      if((i.action==='record_assessment')!==(i.snapshotId!==undefined))
        return bad('Use record_assessment with snapshotId from the current release status.');
      const scope = await this.scope(i.officeId,context);
      if(i.auditOverride&&!scope.human)return denied('Only the human manager can explicitly override required review.');
      if(i.action==='reassign'&&!scope.human)return denied('Only the human manager can reassign an office task.');
      if(i.action==='set_release_rule'&&!scope.human)return denied('Only the human manager can change release rules.');
      if(i.action==='release_status'||i.action==='record_assessment'){
        if(!scope.supervisor)return denied('Only the current office supervisor or human manager can read or record a release assessment.');
        if(i.action==='record_assessment')return this.recordAssessment(i,scope);
        const releaseAssessment=await this.releaseAssessment(scope);
        return {officeId:i.officeId,observedAt:this.clock(),releaseAssessment};
      }
      if(i.action==='audit'||i.action==='review_packet')return this.audit(i,scope,context);
      if (i.action==='review_queue') return this.reviewQueue(i,scope);
      if (i.action==='dashboard') return this.dashboard(i,scope);
      if (i.action==='dispatch' && i.batch) {
        const {goal,briefMaterialId,assignments}=i.batch;
        if(new Set(assignments.map(a=>a.key)).size!==assignments.length) return bad('Use a distinct stable key for each assignment.');
        const batchId=randomUUID();
        const tasks=[],batchIds=new Set<string|null>();
        for(const assignment of assignments){
          const created=await this.create({...assignment,action:'create',officeId:i.officeId,goal,
            ...(briefMaterialId?{briefMaterialId}:{})},scope,context,batchId);
          batchIds.add(created.row.batch_id??null);
          if(batchIds.size>1||batchIds.has(null))
            throw new MindPondError('idempotency_conflict','These assignment keys do not belong to a single dispatch.',{
              field:'batch.assignments',nextAction:'Retry the original dispatch, or use new keys for a separate batch. No changes were made.'
            });
          tasks.push({...this.project(created.row),replayed:created.replayed});
        }
        return {tasks};
      }
      if (i.action==='list') {
        const limit = i.limit ?? 20;
        const filter = i.filter==='attention' ? "AND (status='review' OR (status='blocked' AND blocker='decision'))"
          : i.filter==='active' ? "AND status NOT IN ('done','cancelled')"
          : i.filter==='closed' ? "AND status IN ('done','cancelled')" : '';
        const rows = await this.db.all<Row[]>(`SELECT id,office_id,owner_id,title,status,blocker,revision,guide_revision,updated_at,revisions_requested,
          progress_at,progress_note,submitted_at
          FROM office_guided_tasks WHERE office_id=? AND id>? AND (? OR owner_id=?) ${filter} ORDER BY id LIMIT ?`,
          [i.officeId,i.afterId??'',scope.supervisor,scope.roleId,limit+1]);
        const tasks = rows.slice(0,limit).map(row=>this.project(row));
        return {tasks,supervisorId:scope.office.supervisor_id??null,supervisorMode:scope.office.supervisor_mode??'manage',
          policyRevision:scope.office.revision??0,reviewMode:scope.office.review_mode??'all',riskReview:this.riskPolicy(scope),
          nextAfterId:rows.length>limit?tasks.at(-1)?.id:null};
      }
      if (i.action==='get') return {task:await this.detail(await this.task(i.officeId,i.taskId,scope),scope)};
      if (i.action==='evidence_index') return this.evidenceIndex(await this.task(i.officeId,i.taskId,scope));
      if (!i.key) return bad('Use a stable key for every task change.');
      const author = scope.roleId ?? 'human';
      const hash = digest(i);
      if (i.action==='create') {
        const {row,replayed}=await this.create(i,scope,context);
        return {task:await this.detail(row,scope),...(replayed?{replayed:true}:{})};
      }
      const row = await this.task(i.officeId,i.taskId,scope);
      const owner = scope.roleId===row.owner_id;
      if (['guide','review','cancel','set_release_rule','reassign'].includes(i.action) ? !scope.canManage : !owner)
        return denied('This change requires the human manager, a supervisor with task management permission, or the task owner as appropriate.');
      const receipt = await this.db.get<Row>('SELECT hash FROM office_guided_receipts WHERE task_id=? AND actor=? AND key=?',[row.id,author,i.key]);
      if (receipt) {
        if (receipt.hash!==hash) throw new MindPondError('idempotency_conflict','This task change key has another payload.');
        return {task:await this.detail(row,scope),replayed:true};
      }
      if(i.action==='set_release_rule'||i.action==='reassign'){
        if(!['active','paused'].includes(scope.office.state))return bad('Archived offices do not allow reassignment or release-rule changes.');
      }else if(i.action!=='cancel')this.assertOpen(scope);
      if (i.expectedRevision!==row.revision) throw new MindPondError('stale_version','The task has changed.',{
        field:'expectedRevision',nextAction:'Read the current task and reuse your draft with the latest revision.',
        details:{currentRevision:row.revision,status:row.status,nextCall:this.getCall(row)}
      });
      if (terminal(row.status)&&i.action!=='set_release_rule') return bad('This task is already closed.');
      if (!scope.human) await this.graph.discussions.assertMailbox(context);

      let eventDetails:Row={};
      if(i.action==='reassign'){
        eventDetails=await this.reassign(row,i);
      }else if(i.action==='set_release_rule'){
        if(i.releaseRule&&!row.release_rule){
          const count=await this.db.get<Row>('SELECT COUNT(*) n FROM office_guided_tasks WHERE office_id=? AND release_rule IS NOT NULL',[i.officeId]);
          if(count!.n>=MAX_RELEASE_TASKS)return bad('Remove an existing release rule before adding another. An office supports 100 marked tasks.');
        }
        await this.db.run('UPDATE office_guided_tasks SET release_rule=? WHERE id=?',[i.releaseRule,row.id]);
      } else if (i.action==='progress') {
        if (!['working','blocked'].includes(row.status)) return bad('Report progress while the task is working or blocked.');
        if (!i.note || i.note.length>800) throw new MindPondError('invalid_input','Progress needs a note of 1–800 characters.',{field:'note'});
        if (i.progressMaterialId&&!await this.db.get(
          "SELECT 1 FROM office_materials WHERE id=? AND office_id=? AND state='published'",[i.progressMaterialId,i.officeId]))
          throw new MindPondError('not_found','The progress material must be published in this office.',{field:'progressMaterialId',
            nextAction:'Publish a material in this office first, or omit progressMaterialId to record a private task update.'});
        await this.db.run('UPDATE office_guided_tasks SET progress_note=?,progress_at=?,progress_material_id=? WHERE id=?',
          [i.note,this.clock(),i.progressMaterialId??null,row.id]);
      } else if (i.action==='guide') {
        if (i.instruction===undefined && i.memoryQuery===undefined) return bad('Provide instruction or memoryQuery, or null to clear it.');
        if (i.resolveDecision && (row.status!=='blocked' || row.blocker!=='decision' || !i.instruction))
          return bad('To resolve a pending decision, include the decision and next step in instruction.');
        await this.db.run(`UPDATE office_guided_tasks SET guided_by=?,instruction=?,memory_query=?,guide_revision=guide_revision+1,
          status=?,blocker=? WHERE id=?`, [author,i.instruction===undefined?row.instruction:i.instruction,
          i.memoryQuery===undefined?row.memory_query:i.memoryQuery,i.resolveDecision?'queued':row.status,i.resolveDecision?null:row.blocker,row.id]);
        if (i.resolveDecision) await this.clearChange(row.id,'supervisor');
        await this.publishChange(row.id,'owner',i.resolveDecision?'decision_answered':'guidance_updated');
      } else {
        let status: string, blocker: string | null = null, note = i.note ?? null;
        let result = row.result, revisions = row.revisions_requested;
        let blockReport: string | null = null, delivery = row.delivery, submissionId=row.review_submission_id;
        if (i.action==='claim' && ['queued','blocked','working'].includes(row.status)) {
          if (row.status==='working') {
            await this.db.run('INSERT INTO office_guided_receipts VALUES(?,?,?,?)',[row.id,author,i.key,hash]);
            return {task:await this.detail(row,scope)};
          }
          status = 'working';
          await this.clearChange(row.id,'supervisor');
        } else if (i.action==='block' && ['working','blocked'].includes(row.status) && i.blocker && (i.note || i.blockReport)) {
          if (i.blockReport && i.blocker==='decision' && !i.blockReport.decision)
            bad('Describe the decision needed in blockReport.decision.');
          status = 'blocked'; blocker = i.blocker;
          note = i.note ?? i.blockReport?.obstacle ?? null;
          blockReport = i.blockReport ? JSON.stringify(i.blockReport) : null;
          if (blocker==='decision') await this.publishChange(row.id,'supervisor','decision_needed');
          else await this.clearChange(row.id,'supervisor');
        } else if (i.action==='submit') {
          if(row.status!=='working') return bad('Submit from a working task. Read the current task before submitting.');
          if(!i.note&&!i.delivery) throw new MindPondError('invalid_input','Submit needs a note or a structured delivery.',{
            field:'note',nextAction:'Add note with the conclusion, supporting evidence and unknowns, or supply delivery with summary and checks.'
          });
          const policy=this.riskPolicy(scope);
          if(!policy&&(i.delivery?.checks.length??0)>5)throw new MindPondError('invalid_input','Ordinary delivery supports at most five checks.',{
            field:'delivery.checks',nextAction:'Keep the five most relevant checks. Add supporting detail in observations or link published evidence.'
          });
          if (i.delivery) await this.validateDelivery(i.officeId,i.delivery);
          submissionId=policy?await this.riskReview.submit(row,i.delivery,policy,scope.office.review_mode??'all'):null;
          status = 'review'; result = i.note ?? i.delivery?.summary;
          delivery = i.delivery ? JSON.stringify(i.delivery) : null;
          await this.publishChange(row.id,'supervisor','review_needed');
        } else if (i.action==='review' && row.status==='review' && i.verdict && i.note) {
          if (i.verdict==='revise' && revisions>=1) return bad('One revision was already requested. Accept, cancel, or assign a separate follow-up.');
          const policy=this.riskPolicy(scope);
          if(i.verdict==='accept'&&policy?.requireAudit&&!i.auditOverride){
            const run=await this.riskReview.read(row);
            if(!run)
              throw new MindPondError('invalid_input','This report has no independent review packet.',{
                field:'verdict',nextAction:'Request a revised submission to create a review packet. A human can explicitly override with a reason.',
                details:{auditSubmissionMissing:true}
              });
            const packet=await this.riskReview.packet(row,run);
            if(packet.missingDelivery||packet.missingCheckIds.length||packet.pendingCount)
              throw new MindPondError('invalid_input','Required checks are missing or still need review.',{
                field:'verdict',nextAction:'Open review_packet. Record actual independent checks or request corrected evidence. A human can explicitly override with a reason.',
                details:{pendingCount:packet.pendingCount,missingCheckIds:packet.missingCheckIds,missingDelivery:packet.missingDelivery}
              });
          }
          if(i.auditOverride)note='Audit override by human: '+note;
          status = i.verdict==='accept'?'done':'working';
          if (i.verdict==='revise') {
            revisions++;
            await this.publishChange(row.id,'owner','revision_requested');
          } else await this.clearChange(row.id,'owner');
          await this.clearChange(row.id,'supervisor');
        } else if (i.action==='cancel' && i.note) {
          status = 'cancelled';
          await this.clearChange(row.id,'owner');
          await this.clearChange(row.id,'supervisor');
        } else return bad('Check the task state. Block needs blocker and blockReport or note; submit needs delivery or note; review and cancel need note.');
        if (owner && ['claim','block','submit'].includes(i.action)) await this.clearChange(row.id,'owner');
        const now=this.clock();
        await this.db.run(`UPDATE office_guided_tasks SET status=?,blocker=?,note=?,result=?,revisions_requested=?,
          block_report=?,delivery=?,first_claimed_at=?,submitted_at=?,reviewed_at=?,review_submission_id=? WHERE id=?`,
          [status,blocker,note,result,revisions,blockReport,delivery,
            i.action==='claim'?(row.first_claimed_at??now):row.first_claimed_at,
            i.action==='submit'?now:row.submitted_at,
            status==='done'?now:row.reviewed_at,submissionId,row.id]);
      }
      await this.db.run('UPDATE office_guided_tasks SET revision=revision+1,updated_at=? WHERE id=?',[this.clock(),row.id]);
      await this.db.run('INSERT INTO office_guided_receipts VALUES(?,?,?,?)',[row.id,author,i.key,hash]);
      const updated=await this.task(i.officeId,row.id,scope);
      const action=i.action==='review'?(i.verdict==='accept'?'accepted':'revision_requested'):
        i.action==='guide'&&i.resolveDecision?'decision_answered':i.action;
      await this.taskEvent(updated,scope.roleId,action,eventDetails);
      return {task:await this.detail(updated,scope)};
    });
  }

  // The caller owns the transaction and checks current membership before linking.
  async assertActiveTaskLink(officeId: string, taskId: string, context?: TrustedCallContext) {
    const scope = await this.scope(officeId,context);
    this.assertOpen(scope);
    const row = await this.task(officeId,taskId,scope);
    if(!scope.canManage&&scope.roleId!==row.owner_id)
      return denied('Linking progress or a discussion to another role’s task requires task management permission.');
    if (terminal(row.status)) bad('Link collaboration records or discussions to an active task.');
  }

  // Called only from the authorized discussion close path, before transcript deletion.
  async keepDiscussionOutcome(room: Row, outcome: string | TaskOutcome, author: string) {
    const row = await this.db.get<Row>('SELECT id,office_id,status,title,owner_id,revision FROM office_guided_tasks WHERE id=?',[room.guided_task_id]);
    if (!row || row.office_id!==room.office_id) return bad('The discussion has no task available for its conclusion.');
    const count = await this.db.get<Row>('SELECT COUNT(*) n FROM office_guided_outcomes WHERE task_id=?',[row.id]);
    if (count!.n>=8) return bad('This task already has eight saved conclusions. Close without keeping a further conclusion.');
    const structured = typeof outcome !== 'string';
    await this.db.run(`INSERT INTO office_guided_outcomes(task_id,discussion_id,title,conclusion,author,created_at,details)
      VALUES(?,?,?,?,?,?,?)`,[row.id,room.id,room.title,structured?outcome.decision:outcome,author,this.clock(),
      structured?JSON.stringify(outcome):null]);
    if (!terminal(row.status)) await this.publishChange(row.id,'owner','meeting_outcome');
    await this.db.run('UPDATE office_guided_tasks SET revision=revision+1,updated_at=? WHERE id=?',[this.clock(),row.id]);
    await this.taskEvent({...row,revision:row.revision+1},author==='human'?null:author,'meeting_outcome');
  }
}

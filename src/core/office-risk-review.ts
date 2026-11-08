import { randomUUID } from 'node:crypto';
import type { Database } from 'sqlite';
import { z } from 'zod';
import { MindPondError } from './errors.js';
import { digest } from './growth.js';

const id=z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const text=(max:number)=>z.string().trim().min(1).max(max);
export const MAX_REVIEW_CHECKS=40;
export const riskPolicySchema=z.object({
  samplePercent:z.number().int().min(0).max(100).default(25),
  useHistory:z.boolean().default(true),
  requireAudit:z.boolean().default(true),
  verifierId:id.nullable().default(null)
}).strict();
export const taskRiskSchema=z.object({
  workType:text(80).optional(), level:z.enum(['normal','high']).default('normal'),
  targetVersion:text(160).optional(), requiredChecks:z.array(id).max(MAX_REVIEW_CHECKS).optional()
}).strict().refine(i=>!i.requiredChecks||new Set(i.requiredChecks).size===i.requiredChecks.length,'Required check IDs must be distinct.');
export const evidenceFields={
  checkId:id.optional(), expected:text(200).optional(), observed:text(240).optional(),
  evidenceVersion:text(160).optional(), receipt:text(160).optional(), attention:z.boolean().optional(),
  conclusion:z.enum(['pass','fail','unknown']).optional()
};
export const checkSchema=z.object({
  criterion:text(400),status:z.enum(['verified','not_verified']),evidence:text(800).optional(),
  materialId:id.optional(),artifactId:z.string().uuid().optional(),...evidenceFields
}).strict();
export const auditSchema=z.object({
  submissionId:z.string().uuid(),
  entries:z.array(z.object({
    index:z.number().int().min(0).max(MAX_REVIEW_CHECKS-1),
    outcome:z.enum(['confirmed','discrepancy','inconclusive']),
    observed:text(400), method:z.enum(['manual','script']), source:text(240),
    evidenceVersion:text(160).optional(),materialId:id.optional(),artifactId:z.string().uuid().optional()
  }).strict()).min(1).max(MAX_REVIEW_CHECKS)
}).strict().refine(i=>new Set(i.entries.map(e=>e.index)).size===i.entries.length,'Audit check indexes must be distinct.');

type Policy=z.infer<typeof riskPolicySchema>;
type Spec=z.infer<typeof taskRiskSchema>;
type Audit=z.infer<typeof auditSchema>;
type Check=z.infer<typeof checkSchema>;
type AuditEvent={actor:string; key:string; hash:string; at:number; entries:Audit['entries']};
export type RiskTask={id:string;office_id:string;owner_id:string;risk_spec?:string|null;review_submission_id?:string|null};
type Run={id:string;task_id:string;checks:string;sample:string;profile:string;audits:string;report_hash:string;missing:string;has_delivery:number};
export type EvidenceReferences={materials:Map<string,string>;artifacts:Set<string>};

function outcome(entries:Audit['entries']) {
  if(entries.some(e=>e.outcome==='discrepancy'))return 'discrepancy';
  if(entries.some(e=>e.outcome==='confirmed'))return 'confirmed';
  return entries.length?'inconclusive':null;
}

export class OfficeRiskReview {
  constructor(private db:Database,private clock:()=>number) {}

  async init() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS office_guided_review_runs(
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES office_guided_tasks(id) ON DELETE CASCADE,
        office_id TEXT NOT NULL, owner_id TEXT NOT NULL, work_type TEXT, created_at INTEGER NOT NULL,
        checks TEXT NOT NULL, sample TEXT NOT NULL, profile TEXT NOT NULL, missing TEXT NOT NULL,
        report_hash TEXT NOT NULL, has_delivery INTEGER NOT NULL, audits TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS office_guided_review_profile
        ON office_guided_review_runs(office_id,owner_id,work_type,created_at DESC);
      CREATE TRIGGER IF NOT EXISTS office_guided_review_observer_update AFTER UPDATE ON office_guided_review_runs
        BEGIN UPDATE office_observer_revision SET revision=revision+1 WHERE id=1; END;
    `);
  }

  async references(officeId:string,checks:Pick<Check,'materialId'|'artifactId'>[]):Promise<EvidenceReferences> {
    const materialIds=checks.flatMap(c=>c.materialId?[c.materialId]:[]);
    const artifactIds=checks.flatMap(c=>c.artifactId?[c.artifactId]:[]);
    const materials=materialIds.length?await this.db.all<{id:string;version:string}[]>(
      "SELECT id,version FROM office_materials WHERE office_id=? AND state='published' AND id IN (SELECT value FROM json_each(?))",
      [officeId,JSON.stringify(materialIds)]):[];
    const artifacts=artifactIds.length?await this.db.all<{id:string}[]>(
      "SELECT id FROM office_artifacts WHERE office_id=? AND scope='office' AND state='ready' AND expires_at>? AND id IN (SELECT value FROM json_each(?))",
      [officeId,this.clock(),JSON.stringify(artifactIds)]):[];
    return {materials:new Map(materials.map(m=>[m.id,m.version])),artifacts:new Set(artifacts.map(a=>a.id))};
  }

  private reasons(check:Check,spec:Spec,refs:EvidenceReferences) {
    const reasons:string[]=[];
    if(check.checkId&&spec.requiredChecks?.includes(check.checkId))reasons.push('required_check');
    if(spec.level==='high')reasons.push('high_risk');
    if(check.attention||check.status==='not_verified'||check.conclusion==='unknown')reasons.push('reported_uncertainty');
    if(check.conclusion==='fail')reasons.push('reported_failure');
    if(!check.observed)reasons.push('missing_observation');
    const materialVersion=check.materialId?refs.materials.get(check.materialId):undefined;
    const artifactAvailable=check.artifactId&&refs.artifacts.has(check.artifactId);
    if(!materialVersion&&!artifactAvailable)reasons.push('self_report_only');
    if(check.materialId&&!materialVersion||check.artifactId&&!artifactAvailable)reasons.push('reference_unavailable');
    if(spec.targetVersion&&(check.evidenceVersion!==spec.targetVersion||
      materialVersion&&materialVersion!=='unversioned'&&materialVersion!==spec.targetVersion))reasons.push('version_mismatch');
    return reasons;
  }

  private async profile(task:RiskTask,spec:Spec) {
    if(!spec.workType)return null;
    const rows=await this.db.all<{audits:string}[]>(`SELECT audits FROM office_guided_review_runs
      WHERE office_id=? AND owner_id=? AND work_type=? AND task_id<>? AND audits<>'[]'
      ORDER BY created_at DESC,rowid DESC LIMIT 20`,[task.office_id,task.owner_id,spec.workType,task.id]);
    const result={workType:spec.workType,submissions:rows.length,confirmed:0,discrepancy:0,inconclusive:0};
    for(const row of rows){
      const checks=new Map<number,Audit['entries']>();
      for(const {entries} of JSON.parse(row.audits) as AuditEvent[])
        for(const entry of entries)checks.set(entry.index,[...(checks.get(entry.index)??[]),entry]);
      for(const entries of checks.values()){const status=outcome(entries);if(status)result[status]++;}
    }
    return result;
  }

  async submit(task:RiskTask,delivery:{checks:Check[]}|undefined,policy:Policy,mode:string) {
    const checks=delivery?.checks??[], ids=checks.flatMap(c=>c.checkId?[c.checkId]:[]);
    if(new Set(ids).size!==ids.length)throw new MindPondError('invalid_input','Use distinct checkId values for the submitted checks.');
    const spec=JSON.parse(task.risk_spec??'{"level":"normal"}') as Spec;
    const missing=(spec.requiredChecks??[]).filter(id=>!ids.includes(id));
    const refs=await this.references(task.office_id,checks);
    const profile=policy.useHistory?await this.profile(task,spec):null;
    const regular=checks.flatMap((c,index)=>this.reasons(c,spec,refs).length?[]:[index]);
    const percent=mode==='all'?100:Math.min(100,policy.samplePercent*(profile&&
      (profile.discrepancy>0||profile.confirmed+profile.discrepancy<5)?2:1));
    // Randomness is generated after the report is received. Persist the actual sample,
    // so reads, failed writes and transport retries cannot produce another draw.
    const ranked=regular.map(index=>({index,rank:randomUUID()})).sort((a,b)=>a.rank.localeCompare(b.rank));
    const sample=ranked.slice(0,Math.ceil(regular.length*percent/100)).map(r=>r.index);
    const submissionId=randomUUID();
    await this.db.run(`INSERT INTO office_guided_review_runs
      (id,task_id,office_id,owner_id,work_type,created_at,checks,sample,profile,missing,report_hash,has_delivery)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,[submissionId,task.id,task.office_id,task.owner_id,spec.workType??null,this.clock(),
      JSON.stringify(checks),JSON.stringify(sample),JSON.stringify(profile),JSON.stringify(missing),digest(delivery??null),delivery?1:0]);
    return submissionId;
  }

  async read(task:RiskTask) {
    if(!task.review_submission_id)return null;
    return await this.db.get<Run>('SELECT * FROM office_guided_review_runs WHERE id=? AND task_id=?',
      [task.review_submission_id,task.id])??null;
  }

  async packet(task:RiskTask,run:Run,showAll=false,refs?:EvidenceReferences) {
    const checks=JSON.parse(run.checks) as Check[];
    const audits=JSON.parse(run.audits) as AuditEvent[];
    const sample=new Set<number>(JSON.parse(run.sample));
    const spec=JSON.parse(task.risk_spec??'{"level":"normal"}') as Spec;
    const references=refs??await this.references(task.office_id,checks);
    const recorded=audits.flatMap(a=>a.entries);
    const auditRefs=recorded.some(e=>e.materialId||e.artifactId)?await this.references(task.office_id,recorded):null;
    const broadened=recorded.some(e=>e.outcome==='discrepancy');
    const items=checks.map((check,index)=>{
      const observations=recorded.filter(e=>e.index===index);
      const finding=outcome(observations.filter(e=>e.outcome!=='confirmed'||(
        (!e.materialId||auditRefs?.materials.has(e.materialId))&&(!e.artifactId||auditRefs?.artifacts.has(e.artifactId)))));

      const reasons=this.reasons(check,spec,references);
      if(observations.some(e=>e.outcome==='confirmed')&&finding!== 'confirmed'&&finding!== 'discrepancy')
        reasons.push('audit_reference_unavailable');
      if(sample.has(index))reasons.push('sample');
      if(broadened)reasons.push('expanded_after_discrepancy');
      const recent=audits.flatMap(a=>a.entries.filter(e=>e.index===index).map(e=>({by:a.actor,at:a.at,...e}))).at(-1);
      return {index,checkId:check.checkId,criterion:check.criterion.slice(0,120),status:check.status,conclusion:check.conclusion,
        expected:check.expected,observed:check.observed,receipt:check.receipt,evidenceVersion:check.evidenceVersion,
        materialId:check.materialId&&references.materials.has(check.materialId)?check.materialId:undefined,
        artifactId:check.artifactId&&references.artifacts.has(check.artifactId)?check.artifactId:undefined,
        evidenceStatus:finding==='confirmed'?'independently_verified':check.materialId&&references.materials.has(check.materialId)||
          check.artifactId&&references.artifacts.has(check.artifactId)?'referenced':'self_reported',
        finding,reasons,required:reasons.length>0,pending:reasons.length>0&&finding!=='confirmed',
        ...(showAll&&recent?{latestAudit:recent}:{})};
    });
    const missingCheckIds=JSON.parse(run.missing) as string[];
    return {submissionId:run.id,reportHash:run.report_hash,targetVersion:spec.targetVersion,profile:JSON.parse(run.profile),
      checkCount:items.length,requiredCount:items.filter(i=>i.required).length,pendingCount:items.filter(i=>i.pending).length,
      missingCheckIds,missingDelivery:!run.has_delivery,broadened,
      checks:showAll?items:items.filter(i=>i.required).slice(0,5)};
  }

  async record(task:RiskTask,run:Run,audit:Audit,actor:string,key:string,open:boolean) {
    if(run.id!==audit.submissionId)throw new MindPondError('stale_version','The submission changed. Read the current review packet.');
    const events=JSON.parse(run.audits) as AuditEvent[],hash=digest(audit);
    const previous=events.find(e=>e.actor===actor&&e.key===key);
    if(previous){
      if(previous.hash!==hash)throw new MindPondError('idempotency_conflict','This audit key records different evidence.');
      return {replayed:true};
    }
    if(!open)throw new MindPondError('invalid_input','Audits require a pending submission in an open office.');
    if(events.reduce((n,e)=>n+e.entries.length,0)+audit.entries.length>160)throw new MindPondError('invalid_input','This submission reached the limit of 160 recorded check results.');
    const checks=JSON.parse(run.checks) as Check[];
    const spec=JSON.parse(task.risk_spec??'{"level":"normal"}') as Spec;
    const refs=await this.references(task.office_id,audit.entries);
    for(const entry of audit.entries){
      if(!checks[entry.index])throw new MindPondError('invalid_input','Audit index is outside the submitted checks.');
      if(entry.outcome==='confirmed'&&spec.targetVersion&&entry.evidenceVersion!==spec.targetVersion)
        throw new MindPondError('invalid_input','A confirmation must name the assigned target version.',{field:'evidenceVersion'});
      const version=entry.materialId?refs.materials.get(entry.materialId):undefined;
      if(entry.materialId&&!version||entry.artifactId&&!refs.artifacts.has(entry.artifactId))
        throw new MindPondError('not_found','Audit evidence must be available in this office.');
      if(entry.outcome==='confirmed'&&spec.targetVersion&&version&&version!=='unversioned'&&version!==spec.targetVersion)
        throw new MindPondError('invalid_input','The audit material version differs from the assigned target version.');
    }
    events.push({actor,key,hash,at:this.clock(),entries:audit.entries});
    await this.db.run('UPDATE office_guided_review_runs SET audits=? WHERE id=?',[JSON.stringify(events),run.id]);
    return {replayed:false};
  }
}

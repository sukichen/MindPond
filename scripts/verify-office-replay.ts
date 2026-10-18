/** Real browser-admin routes and SQLite: replay is read-only, bounded and office-scoped. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { GraphMemory } from '../src/core/graph-memory.js';
import { officeWorkbench } from '../src/integrations/office-workbench.js';
import type { TrustedCallContext } from '../src/core/trust.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-replay-'));
const graph=new GraphMemory('.',{dbPath:path.join(dir,'test.db')});
const admin:TrustedCallContext={v:1,principal:'operator',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};
let server:ReturnType<ReturnType<typeof express>['listen']>|undefined;
try{
  await graph.init();const db=(graph as any).db;
  await graph.offices.configureAgent({id:'connector',principal:'owner',name:'Fixture',host:'codex',state:'active',expectedRevision:0},admin);
  const enroll=async(name:string)=>{const a:TrustedCallContext={v:1,principal:'owner',agentId:'connector',runtimeId:name,transport:'http-mcp',issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};const apply=await graph.roles.application({action:'submit',name,introduction:'Fixture role',reason:'Replay',key:'apply-'+name},a);const approved=await graph.roles.review({action:'approve',applicationId:apply.applicationId,expectedRevision:1},admin);return {...a,roleId:approved.roleId,roleBindingId:approved.bindingId,roleBindingEpoch:1};};
  const a=await enroll('小栗'),b=await enroll('小麦');
  for(const id of ['one','two'])await graph.roles.configureOffice({id,title:id,state:'active',expectedRevision:0,seats:[{id:id+'-a',agentId:'connector',roleId:a.roleId,label:'A'},{id:id+'-b',agentId:'connector',roleId:b.roleId,label:'B'}]},admin);
  for(let n=0;n<105;n++)await graph.building.message({action:'send',officeId:'one',recipient:b.roleId,body:n===30?'长正文'.repeat(2000):'消息 '+n,key:'history-'+n},a);
  await graph.building.message({action:'send',officeId:'two',recipient:b.roleId,body:'Other room must not enter replay',key:'other-room'},a);
  const app=express();app.use(express.json());app.use('/api/office-admin',officeWorkbench(graph,{apiKey:'',operatorKey:'fixture-user',contextSecret:''}));server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));const base=`http://127.0.0.1:${(server.address() as any).port}/api/office-admin/`;
  let cookie='';const request=(body:any,origin?:string)=>fetch(base+'replay',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
  assert.equal((await request({action:'index',officeId:'one'})).status,401);
  const login=await fetch(base+'login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operatorKey:'fixture-user'})});cookie=login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await request({action:'index',officeId:'one'},'https://outside.invalid')).status,403);
  for(const body of [{action:'page',officeId:'one',fromSeq:99,toSeq:1},{action:'page',officeId:'one',fromSeq:1.5},{action:'page',officeId:'one',limit:1000},{action:'index',officeId:'one',unexpected:true}])assert.equal((await request(body)).status,400);
  await assert.rejects(graph.building.replay({action:'index',officeId:'one'},a),/User management/);
  const changes=(await db.get('SELECT total_changes() n')).n;
  const meta=await (await request({action:'index',officeId:'one'})).json();assert.equal(meta.count,106);assert(meta.participants.some((p:any)=>p.roleId===a.roleId&&p.name==='小栗'));
  const selectedFrom=meta.firstSeq,selectedTo=meta.lastSeq;
  await graph.building.message({action:'send',officeId:'one',recipient:b.roleId,body:'Appended after capture',key:'later'},a);
  const baseline=(await db.get('SELECT total_changes() n')).n;
  let cursor=selectedFrom-1;const events:any[]=[];
  for(let n=0;n<30;n++){const response=await request({action:'page',officeId:'one',fromSeq:selectedFrom,toSeq:selectedTo,afterSeq:cursor,limit:7});assert.equal(response.status,200);const raw=await response.text();assert(Buffer.byteLength(raw)<66000);const page=JSON.parse(raw);events.push(...page.events);if(!page.hasMore)break;assert(page.nextCursor>cursor);cursor=page.nextCursor;}
  assert.equal(events.length,106);assert.equal(new Set(events.map(e=>e.seq)).size,events.length);assert(!JSON.stringify(events).includes('Other room must not enter replay'));assert(!JSON.stringify(events).includes('Appended after capture'));
  const big=events.find(e=>e.detailAvailable);assert(big);assert(big.body.body.length<=1200);
  const message=events.find(e=>e.kind==='message');assert.equal(message.actorKey,'role:'+a.roleId);assert.equal(message.recipientKey,'role:'+b.roleId);
  const subset=await (await request({action:'page',officeId:'one',fromSeq:events[10].seq,toSeq:events[12].seq})).json();assert.deepEqual(subset.events.map((e:any)=>e.seq),events.slice(10,13).map(e=>e.seq));
  assert.equal((await db.get('SELECT total_changes() n')).n,baseline,'replay cannot mark mail read or write any business/audit row');assert(baseline>changes);
  // Deleted/moved identities are still identifiable from an actual event signature.
  await graph.roles.deleteRole({roleId:a.roleId!,expectedRevision:1},admin);
  const historical=await (await request({action:'index',officeId:'one'})).json();assert(historical.participants.some((p:any)=>p.roleId===a.roleId&&p.name==='小栗'&&p.historical));
  assert.equal((await request({action:'index',officeId:'missing'})).status,403);
  console.log('PASS replay API: admin/Origin guards, inclusive boundaries, stable upper cursor, ordered complete pages, room isolation, bounded previews, historical identities and zero database writes');
}finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));await graph.close();await fs.rm(dir,{recursive:true,force:true});}

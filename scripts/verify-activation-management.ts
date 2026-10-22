/** Real management HTTP routes: no credentials in output, no live data. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {GraphMemory} from '../src/core/graph-memory.js';
import {roleRuntimeId} from '../src/core/roles.js';
import {officeWorkbench} from '../src/integrations/office-workbench.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-activation-http-')),graph=new GraphMemory('.',{dbPath:path.join(dir,'fixture.db')});
const admin={v:1 as const,principal:'human',operator:true,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER};let server:any;
try{
 await graph.init();await graph.offices.configureAgent({id:'host',principal:'human',host:'codex',name:'Fixture host',state:'active',expectedRevision:0},admin);
 const actor=(id:string)=>({v:1 as const,principal:'human',agentId:'host',transport:'http-mcp' as const,runtimeMode:'codex_metadata' as const,runtimeId:roleRuntimeId('human','host','codex',id),nativeChatId:id,issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER});
 const app=express();app.use(express.json());app.use('/api/office-admin',officeWorkbench(graph,{apiKey:'',operatorKey:'',contextSecret:''}));server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 let cookie='';const request=async(route:string,body:any,extra:Record<string,string>={})=>{const r=await fetch(base+'/api/office-admin/'+route,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extra},body:JSON.stringify(body)});return {r,data:await r.json() as any};};
 assert.equal((await request('role/activation/resolve',{})).r.status,401);
 const login=await request('login',{});assert.equal(login.r.status,200);cookie=login.r.headers.get('set-cookie')!.split(';')[0];
 const a=actor('delete-request');await graph.roles.observeChat(a);const activation=await graph.roles.connectionRequest(a);assert(activation?.id);
 const input={requestId:activation.id,expectedRevision:1,action:'delete'};
 assert.equal((await request('role/activation/resolve',input,{Origin:'https://outside.invalid'})).r.status,403);
 assert.equal((await request('role/activation/resolve',{...input,unexpected:true})).r.status,400);
 assert.equal((await request('role/activation/resolve',{...input,expectedRevision:9})).r.status,409);
 assert.equal((await request('role/activation/resolve',input)).r.status,200);
 assert.equal((await request('role/activation/resolve',input)).r.status,404);
 assert.equal((await graph.roles.connectionRequest(a))!.state,'deleted');
 assert.equal((await graph.roles.registry(admin)).connections.length,0);
 const b=actor('reject-application');await graph.roles.observeChat(b);const application=await graph.roles.application({action:'submit',name:'Reject fixture',introduction:'Fictional',reason:'Regression',key:'apply'},b);
 assert.equal((await request('role/review',{applicationId:application.applicationId,expectedRevision:1,action:'reject'})).r.status,200);
 assert.equal((await graph.roles.connectionRequest(b))!.state,'rejected');
 assert.equal((await request('role/application/delete',{applicationId:application.applicationId,expectedRevision:1})).r.status,409);
 assert.equal((await request('role/application/delete',{applicationId:application.applicationId,expectedRevision:2})).r.status,200);
 assert(!await (graph as any).db.get('SELECT 1 FROM role_applications WHERE id=?',[application.applicationId]));
 const replay=await graph.roles.application({action:'submit',name:'Reject fixture',introduction:'Fictional',reason:'Regression',key:'apply'},b);assert.equal(replay.state,'deleted','an exact retry cannot resurrect a deleted application');
 const retry=await graph.roles.application({action:'submit',name:'User explicitly retries',introduction:'Fictional',reason:'Human requested a new application',key:'new-request'},b);assert.equal(retry.state,'pending');
 assert.equal((await graph.roles.registry(admin)).pending.length,1);
 console.log('PASS activation/application management HTTP: login, same-origin, strict schemas, CAS, hard deletion, duplicate delivery, rejected/deleted suppression, no occupied slots and explicit new application');
}finally{if(server)await new Promise<void>(r=>server.close(()=>r()));await graph.close();await fs.rm(dir,{recursive:true,force:true});}

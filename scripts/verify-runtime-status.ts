import assert from 'node:assert/strict';
import {RuntimeStatus} from '../src/core/runtime-status.js';
const runtime=new RuntimeStatus(),listeners=new Map<string,()=>void>();
const response={statusCode:503,writableEnded:false,once(event:string,fn:()=>void){listeners.set(event,fn);}};
runtime.middleware()({url:'/secret?token=never-record',body:'private-content'},response,()=>{});
listeners.get('close')!();listeners.get('finish')!();assert.equal(runtime.snapshot().requests,1,'a disconnected request is not counted again on finish');assert.equal(runtime.snapshot().aborted,1);
for(let i=0;i<2000;i++)runtime.observe(i,500);
const snapshot=runtime.snapshot();assert.equal(snapshot.latency.sampleCount,256);assert.equal(snapshot.recentErrors.length,20);assert.equal(snapshot.requests,2001);assert(!JSON.stringify(snapshot).includes('never-record'));assert(!JSON.stringify(snapshot).includes('private-content'));
console.log('PASS operational metrics: abort/finish de-duplication, bounded histories and no request content collection');

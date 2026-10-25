/** Exercise stream -> polling -> stream -> polling with the actual page handler. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../web/graph-page.js',import.meta.url),'utf8');
const timers=new Set();let timerId=0,fetches=0,polls=0;
const state={stream:null,stopped:false,pollTimer:0,cursor:0};
const context=vm.createContext({state,AbortController,TextDecoder,headers:()=>({}),setStatus(){},pollFallback:async()=>{polls++;},
 setTimeout(){return ++timerId;},setInterval(){const id=++timerId;timers.add(id);return id;},clearInterval(id){timers.delete(id);},
 fetch:async()=>{
  fetches++;if(fetches===1)throw Error('Initial transport unavailable');
  return {ok:true,body:{getReader:()=>({read:async()=>{throw Error('Transport disconnected after opening');}})}};
 }
});
vm.runInContext(source.slice(source.indexOf('async function stream(){'),source.indexOf('async function loadDimensionDefinitions()')),context);
await context.stream();assert.equal(timers.size,1);assert.equal(polls,1);
const previous=state.pollTimer;
await context.stream();assert(!timers.has(previous),'Successful stream connection stops the prior fallback');
assert.equal(timers.size,1,'A second stream failure must start polling again');
assert.notEqual(state.pollTimer,previous);assert.equal(polls,2);
state.stopped=true;await context.stream();assert.equal(timers.size,0,'Stopped page never restarts polling');
console.log('PASS graph live updates: repeated stream failure always restores one polling fallback; stopped page does not restart it');

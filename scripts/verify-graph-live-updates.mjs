/** Exercise stream -> polling -> stream -> polling with the actual page handler. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../web/graph-page.js',import.meta.url),'utf8');
const timers=new Set();let timerId=0,fetches=0,polls=0,retry;
const state={stream:null,stopped:false,pollTimer:0,cursor:0};
const context=vm.createContext({state,AbortController,TextDecoder,headers:()=>({}),setStatus(){},api:async()=>{polls++;return {log:[]};},
 setTimeout(fn){retry=fn;return ++timerId;},setInterval(){const id=++timerId;timers.add(id);return id;},clearInterval(id){timers.delete(id);},
 fetch:async()=>{
  fetches++;if(fetches===1)throw Error('Initial transport unavailable');
  return {ok:true,body:{getReader:()=>({read:async()=>{throw Error('Transport disconnected after opening');},cancel:async()=>{}})}};
 }
});
vm.runInContext(source.slice(source.indexOf('function stopStream(){'),source.indexOf('async function loadDimensionDefinitions()')),context);
await context.stream();assert.equal(timers.size,1);assert.equal(polls,1);
const previous=state.pollTimer;
let finishConnect;
context.fetch=()=>new Promise(resolve=>{finishConnect=resolve;});
retry();
assert(timers.has(previous),'Polling stays active until the replacement stream opens');
finishConnect({ok:true,body:{getReader:()=>({read:async()=>{throw Error('Second disconnect');},cancel:async()=>{}})}});
await new Promise(resolve=>setImmediate(resolve));
assert(!timers.has(previous),'Successful stream connection stops the prior fallback');
assert.equal(timers.size,1,'A second stream failure must start polling again');
assert.notEqual(state.pollTimer,previous);assert.equal(polls,2);
state.stopped=true;context.stopStream();await context.stream();assert.equal(timers.size,0,'Stopped page never restarts polling');
console.log('PASS graph live updates: repeated stream failure always restores one polling fallback; stopped page does not restart it');

// Switch from a slow role graph request to an office while reads are in flight.
const controls=new Map();
const element=id=>{
  if(!controls.has(id))controls.set(id,{value:'',checked:false,textContent:'',lastElementChild:{},replaceChildren(){}});
  return controls.get(id);
};
element('limit').value='500';
const renders=[];
const graphContext=vm.createContext({document:{getElementById:element,createElement:()=>({})},URLSearchParams,clearTimeout(){},clearInterval(){}});
const actualPage=source.replace('  main();',`
  globalThis.handlers={state,loadGraph,activityVisible,ownerQuery,changeScope};
  stream=()=>fixture.stream(state.cursor);
  state.renderer=fixture.renderer;
  api=fixture.api;
  updateLegend=()=>{};
  resetInspector=()=>{};
`);
const pending=[],cursorStarts=[];
graphContext.fixture={
  stream:cursor=>cursorStarts.push(cursor),
  api:route=>new Promise(resolve=>pending.push({route,resolve})),
  renderer:{setGraph:(nodes,edges)=>renders.push({nodes,edges})},
};
vm.runInContext(actualPage,graphContext);
const {state:graphState,loadGraph,activityVisible}=graphContext.handlers;
element('owner').value='agent:fictional-role';
const firstGraph=loadGraph();
element('owner').value='office:fictional-office';
graphState.generation++;
const secondGraph=loadGraph();
assert.match(pending[0].route,/ownerRoleId=fictional-role/);
assert.match(pending[1].route,/ownerOfficeId=fictional-office/);
pending[1].resolve({nodes:[{id:'office-a'},{id:'office-b'}],edges:[{id:'office-edge'}]});await secondGraph;
pending[0].resolve({nodes:[{id:'role-a'},{id:'role-b'}],edges:[]});await firstGraph;
assert.equal(renders.length,1,'a slow role graph cannot overwrite the selected office');
assert.equal(activityVisible({nodeId:'role-a'}),false);
assert.equal(activityVisible({nodeId:'office-a'}),true);
assert.equal(activityVisible({edgeId:'office-edge'}),true);
element('owner').value='user';assert.equal(graphContext.handlers.ownerQuery().get('ownerUser'),'true');
console.log('PASS graph ownership filters: query arguments, stale view protection, scoped activity and separate human graph');

// A commit racing the snapshot has a higher ID than the bootstrap cursor,
// so reopening the stream replays it even if the snapshot is already stale.
const scopeChange=graphContext.handlers.changeScope();
assert.match(pending[2].route,/actionlog/);
pending[2].resolve({log:[{id:41,nodeId:'other-owner'}]});
await new Promise(resolve=>setImmediate(resolve));
assert.match(pending[3].route,/graph.*ownerUser=true/);
pending[3].resolve({nodes:[{id:'human-a'},{id:'human-b'}],edges:[]});
await scopeChange;
assert.deepEqual(cursorStarts,[41]);
const processing=[];
context.process=action=>processing.push(action.id);
let finishPoll;
context.api=()=>new Promise(resolve=>{finishPoll=resolve;});
state.stopped=false;state.stream=new AbortController();
const oldController=state.stream;state.pollTimer=++timerId;
const oldPoll=context.pollFallback(oldController);
context.stopStream();state.stream=new AbortController();
finishPoll({log:[{id:99}]});
await oldPoll;
assert.deepEqual(processing,[],'an old connection poll cannot advance the new action cursor');
console.log('PASS graph snapshot cursor precedes the snapshot, and reconnect discards in-flight old polls');

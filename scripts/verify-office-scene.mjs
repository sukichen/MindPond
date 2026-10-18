/** Verify event identity, freshness, deduplication and cancellation against the actual animator. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const listeners={},animations=[];
const classList=()=>{const values=new Set();return {add(...v){v.forEach(x=>values.add(x));},remove(...v){v.forEach(x=>values.delete(x));},toggle(v,on){if(on)values.add(v);else values.delete(v);},contains(v){return values.has(v);}};};
const element=()=>({classList:classList(),style:{},dataset:{},children:[],textContent:'',append(n){this.children.push(n);},replaceChildren(){this.children=[];},remove(){this.removed=true;},setAttribute(){},getBoundingClientRect(){return {left:0,top:0,width:66,height:94};}});
function seat(id,roleId,left){const n=element(),p=element();n.dataset={seat:id,role:roleId};p.getBoundingClientRect=()=>({left,top:150,width:66,height:94});p.animate=(frames,options)=>{let resolve,reject;const finished=new Promise((r,j)=>{resolve=r;reject=j;});const animation={frames,options,finished,resolve,currentTime:0,playState:'running',pause(){this.playState='paused';},play(){this.playState='running';},updatePlaybackRate(rate){this.playbackRate=rate;},cancel(){reject(Error('cancelled'));this.cancelled=true;}};animations.push(animation);return animation;};n.querySelector=s=>s==='.office-person'?p:{textContent:roleId};return n;}
const seats=[seat('a','role-a',80),seat('b','role-b',380)],root=element(),wires=element(),status=element();root.getBoundingClientRect=()=>({left:0,top:0,width:800,height:500});root.querySelectorAll=selector=>selector==='.office-desk'?seats:[];
const document={hidden:false,body:element(),createElement:()=>element(),createElementNS:()=>element(),addEventListener(name,fn){listeners[name]=fn;}};
const media={matches:false,addEventListener(name,fn){listeners['media-'+name]=fn;}};
const window={matchMedia:()=>media};vm.runInNewContext(await fs.readFile(new URL('../web/office-navigation.js',import.meta.url),'utf8'),{window});vm.runInNewContext(await fs.readFile(new URL('../web/office-scene.js',import.meta.url),'utf8'),{window,document,Date,Set,Map,setTimeout,clearTimeout,setInterval,clearInterval});
const scene=new window.MindPondOfficeScene.Scene(root,wires,status,()=>1);
const event={seq:1,kind:'message',actor:{roleId:'role-a'},body:{recipient:'role-b'},ts:Date.now()};
scene.present([event]);assert.equal(animations.length,1);assert(animations[0].frames.some(f=>Math.abs(Number(f.transform.match(/translate\(([-.0-9]+)/)?.[1]))>100),'role event must approach the recipient without occupying their location');assert.equal(wires.children.length,1);
scene.present([event]);assert.equal(scene.queue.length,0,'duplicate event may not be replayed');
scene.present([{...event,seq:2,ts:Date.now()-60000}]);assert.equal(scene.queue.length,0,'historical catchup may not animate');
scene.present([{...event,seq:3,ts:Date.now()+10000}]);assert.equal(scene.queue.length,0,'future timestamps may not animate');
scene.present([{...event,seq:9,actor:{roleId:'role-b'},body:{recipient:'role-a'}}]);assert.equal(animations.length,1,'only one moving person can reserve the corridor at a time');assert.equal(scene.queue.length,1);
scene.reset();await Promise.resolve();assert(animations[0].cancelled);assert.equal(wires.children.length,0);
scene.present([{...event,seq:4}]);document.hidden=true;listeners.visibilitychange();await Promise.resolve();assert(animations[1].cancelled,'background tabs stop active effects');assert.equal(scene.queue.length,0);
document.hidden=false;scene.setMotion(false);scene.present([{...event,seq:5}]);assert.equal(animations.length,2);scene.setMotion(true);media.matches=true;scene.demo();assert.equal(animations.length,2,'reduced motion applies to explicit preview too');media.matches=false;scene.list=true;scene.present([{...event,seq:6}]);assert.equal(animations.length,2,'list view never plays movement');scene.list=false;scene.demo();assert(status.textContent.includes('演示'));assert.equal(scene.queue.length,2,'preview can show actions without writing a message');scene.stop();await Promise.resolve();
const html=await fs.readFile(new URL('../web/collaboration.html',import.meta.url),'utf8');assert(!html.includes('collaboration.js'));assert(!html.includes('office-legacy'));assert(html.includes('office-scene.js'));
console.log('PASS office scene: role-to-role movement, freshness, deduplication, room reset, background/reduced-motion/list cancellation, isolated visual preview and a single UI');

// The whole sprite, including clearance, must stay outside furniture and other people along every segment.
const nav=window.MindPondOfficeNavigation;
const obstacles=[{left:180,top:120,right:320,bottom:245},{left:420,top:40,right:486,bottom:134}];
const options={bounds:{left:0,top:0,right:700,bottom:500},obstacles,halfWidth:33,halfHeight:47,clearance:12};
const origin={x:90,y:180},goal={x:540,y:180};
const route=nav.planRoute(origin,goal,options);assert(route?.length>2,'a table blocking the straight path must cause a detour');
const inflated=obstacles.map(r=>nav.inflate(r,45,59));
for(let i=1;i<route.length;i++)assert(nav.clearSegment(route[i-1],route[i],inflated),'no route segment may cut through expanded collision volumes');
assert.equal(nav.planRoute(origin,{x:450,y:80},options),null,'cannot end on another person');
const sealed={...options,obstacles:[{left:200,top:0,right:280,bottom:500}]};assert.equal(nav.planRoute(origin,goal,sealed),null,'blocked rooms must wait, never fall back to a straight line');
assert.equal(nav.clearSegment({x:0,y:0},{x:100,y:100},[{left:45,top:45,right:55,bottom:55}]),false,'diagonal corner cutting is a collision');
const frames=nav.framesForRoute(route,origin);assert.equal(frames.at(-1).offset,1);assert.equal(frames.at(-1).transform,'translate(0px,0px)');
console.log('PASS navigation: full sprite volumes and clearance, furniture detour, recipient separation, sealed corridor waits, diagonal collision and exact return');

const poses=window.MindPondOfficeScene.catalog;
for(const state of ['reading','working','waiting','resting','communicating'])assert(new Set(poses[state].map(p=>p.id)).size>=3,`${state} needs visibly different actions`);
scene.beginReplay();
const historical=scene.replayEvent({...event,kind:'material_read',seq:42,ts:0},{durationMs:6000,rate:2});
const action=animations.at(-1),person=seats[0].querySelector('.office-person'),firstPose=person.dataset.pose;
assert.equal(action.options.duration,6000);assert.equal(action.playbackRate,2);
action.currentTime=2200;await new Promise(r=>setTimeout(r,140));const secondPose=person.dataset.pose;assert.notEqual(secondPose,firstPose);
action.currentTime=4200;await new Promise(r=>setTimeout(r,140));assert.notEqual(person.dataset.pose,secondPose);assert.notEqual(person.dataset.pose,firstPose,'one long activity cycles through three poses');
scene.pauseReplay();assert.equal(action.playState,'paused');scene.resumeReplay();assert.equal(action.playState,'running');scene.setReplayRate(4);assert.equal(action.playbackRate,4);action.resolve();assert.equal(await historical,'completed');scene.endReplay();scene.reset();
console.log('PASS same-state motion: three poses per state, long-activity variation, historical replay bypass, exact processing duration and pause/rate control');

// Navigating away cancels waiting-window timers too, so they cannot restart hidden scene actions.
seats[0].dataset.replayKey='role:role-a';
scene.syncWaiting([{key:'role:role-a',until:Date.now()+10000}]);assert(scene.waitTimer);
const inFlightWait=scene.waitPose();assert(scene.running);scene.stop();await inFlightWait;
assert.equal(scene.waitTimer,null);assert.equal(scene.waiting.length,0);assert.equal(scene.running,false);
console.log('PASS waiting cancellation: view changes clear pending timers and an in-flight pose cannot reschedule itself');

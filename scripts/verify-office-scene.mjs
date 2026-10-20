/** Verify event identity, freshness, deduplication and cancellation against the actual animator. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const listeners={},animations=[];
const classList=()=>{const values=new Set();return {add(...v){v.forEach(x=>values.add(x));},remove(...v){v.forEach(x=>values.delete(x));},toggle(v,on){if(on)values.add(v);else values.delete(v);},contains(v){return values.has(v);}};};
const element=()=>({classList:classList(),style:{setProperty(key,value){this[key]=value;}},dataset:{},children:[],textContent:'',append(n){this.children.push(n);},replaceChildren(){this.children=[];},remove(){this.removed=true;},setAttribute(){},getBoundingClientRect(){return {left:0,top:0,width:66,height:94};}});
function seat(id,roleId,left){const n=element(),p=element();n.dataset={seat:id,role:roleId};p.getBoundingClientRect=()=>({left,top:150,width:66,height:94});p.animate=(frames,options)=>{let resolve,reject;const finished=new Promise((r,j)=>{resolve=r;reject=j;});const animation={frames,options,finished,resolve,currentTime:0,playState:'running',pause(){this.playState='paused';},play(){this.playState='running';},updatePlaybackRate(rate){this.playbackRate=rate;},cancel(){reject(Error('cancelled'));this.cancelled=true;}};animations.push(animation);return animation;};const chair=element();chair.getBoundingClientRect=()=>({left,top:130,width:72,height:76});n.querySelector=s=>s==='.office-person'?p:s==='.office-chair'?chair:{textContent:roleId};return n;}
const seats=[seat('a','role-a',80),seat('b','role-b',380)],root=element(),wires=element(),status=element();root.getBoundingClientRect=()=>({left:0,top:0,width:800,height:500});root.querySelectorAll=selector=>selector==='.office-desk'?seats:selector==='.office-person'?seats.map(n=>n.querySelector('.office-person')):selector.startsWith('.is-live')?seats:[];
const document={hidden:false,body:element(),createElement:()=>element(),createElementNS:()=>element(),addEventListener(name,fn){listeners[name]=fn;}};
const media={matches:false,addEventListener(name,fn){listeners['media-'+name]=fn;}};
const window={matchMedia:()=>media};vm.runInNewContext(await fs.readFile(new URL('../web/office-navigation.js',import.meta.url),'utf8'),{window});vm.runInNewContext(await fs.readFile(new URL('../web/office-scene.js',import.meta.url),'utf8'),{window,document,Date,Set,Map,setTimeout,clearTimeout,setInterval,clearInterval});
const scene=new window.MindPondOfficeScene.Scene(root,wires,status,()=>1);
const event={seq:1,kind:'message',actor:{roleId:'role-a'},body:{recipient:'role-b'},ts:Date.now()};
scene.present([event]);assert.equal(animations.length,1);assert(animations[0].frames.some(f=>Math.abs(Number(f.transform.match(/translate\(([-.0-9]+)/)?.[1]))>100),'role event must approach the recipient without occupying their location');assert.equal(wires.children.length,1);
const walk=animations[0],walker=seats[0].querySelector('.office-person');
assert.equal(walker.dataset.posture,'standing');assert(seats[0].classList.contains('is-standing'),'the chair must clear the departure before obstacle sampling');
walk.currentTime=walk.options.duration*.2;await new Promise(r=>setTimeout(r,110));assert(seats[0].classList.contains('is-walking'));
const pauseIndex=walk.frames.findIndex((f,i)=>i>1&&f.transform===walk.frames[i-1].transform&&f.transform!=='translate(0px,0px)');
assert(pauseIndex>0);walk.currentTime=walk.options.duration*(walk.frames[pauseIndex-1].offset+walk.frames[pauseIndex].offset)/2;
await new Promise(r=>setTimeout(r,110));assert(!seats[0].classList.contains('is-walking'),'stop stepping during the face-to-face handoff');
walk.currentTime=walk.options.duration*.98;await new Promise(r=>setTimeout(r,110));assert.equal(walker.dataset.posture,'seated');assert(seats[0].classList.contains('is-standing'),'return animation retains the floor anchor until cleanup');
scene.present([event]);assert.equal(scene.queue.length,0,'duplicate event may not be replayed');
scene.present([{...event,seq:2,ts:Date.now()-60000}]);assert.equal(scene.queue.length,0,'historical catchup may not animate');
scene.present([{...event,seq:3,ts:Date.now()+10000}]);assert.equal(scene.queue.length,0,'future timestamps may not animate');
scene.present([{...event,seq:9,actor:{roleId:'role-b'},body:{recipient:'role-a'}}]);assert.equal(animations.length,1,'only one moving person can reserve the corridor at a time');assert.equal(scene.queue.length,1);
scene.reset();await Promise.resolve();assert(animations[0].cancelled);assert.equal(wires.children.length,0);
assert.equal(walker.dataset.posture,'seated');assert(!seats[0].classList.contains('is-walking'),'cancellation restores the seat instead of leaving a walker hovering');
scene.present([{...event,seq:4}]);document.hidden=true;listeners.visibilitychange();await Promise.resolve();assert(animations[1].cancelled,'background tabs stop active effects');assert.equal(scene.queue.length,0);
document.hidden=false;scene.setMotion(false);scene.present([{...event,seq:5}]);assert.equal(animations.length,2);scene.setMotion(true);media.matches=true;scene.demo();assert.equal(animations.length,2,'reduced motion applies to explicit preview too');media.matches=false;scene.list=true;scene.present([{...event,seq:6}]);assert.equal(animations.length,2,'list view never plays movement');scene.list=false;scene.demo();assert(status.textContent.includes('演示'));assert.equal(scene.queue.length,2,'preview can show actions without writing a message');scene.stop();await Promise.resolve();
const html=await fs.readFile(new URL('../web/collaboration.html',import.meta.url),'utf8');assert(!/<script[^>]+src=["'][^"']*\/collaboration\.js(?:[?"'])/.test(html));assert(!html.includes('office-legacy'));assert(html.includes('office-scene.js'));
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
const series=['reading','working','waiting','resting','communicating','celebrating'];
assert.equal(Object.keys(poses).length,6);
assert.equal(new Set(series.flatMap(s=>poses[s].map(p=>p.id))).size,18,'count unique clips, not repeated slots');
for(const state of series)for(const clip of poses[state]){
  assert.equal(clip.stages.length,3,'every clip needs preparation, activity and recovery');
  assert(clip.keyframes.length>=7);
  const sample=window.MindPondOfficeScene.sampleAction;
  assert.deepEqual({...sample(clip.id,0)},{...sample(clip.id,1)},'all clips return to a neutral seated pose');
  const gestures=[.15,.35,.55,.75].map(t=>{const f=sample(clip.id,t);return JSON.stringify([f.headTilt,f.headY,f.leftArm,f.rightArm,f.bodyTilt,f.bodyScale]);});
  assert(new Set(gestures).size>=3,`${clip.id} must move multiple joints through distinct keyframes`);
}
scene.beginReplay();
const historical=scene.replayEvent({...event,kind:'material_read',seq:42,ts:0},{durationMs:6000,rate:2});
const action=animations.at(-1),person=seats[0].querySelector('.office-person'),firstPose=person.dataset.pose;
assert.equal(action.options.duration,6000);assert.equal(action.playbackRate,2);
assert.equal(person.dataset.facing,'desk','reading at a workstation faces the physical computer');
action.currentTime=2200;await new Promise(r=>setTimeout(r,140));const secondPose=person.dataset.pose;assert.notEqual(secondPose,firstPose);
action.currentTime=4200;await new Promise(r=>setTimeout(r,140));assert.notEqual(person.dataset.pose,secondPose);assert.notEqual(person.dataset.pose,firstPose,'one long activity cycles through three poses');
scene.pauseReplay();assert.equal(action.playState,'paused');const frozen=JSON.stringify(person.style);await new Promise(r=>setTimeout(r,100));assert.equal(JSON.stringify(person.style),frozen,'joint animation shares the paused outer replay clock');scene.resumeReplay();assert.equal(action.playState,'running');scene.setReplayRate(4);assert.equal(action.playbackRate,4);action.resolve();assert.equal(await historical,'completed');scene.endReplay();scene.reset();
scene.demo('clap');assert.equal(person.dataset.pose,'clap','a specific animation can be previewed independently');assert.equal(scene.queue.length,0);scene.stop();
scene.demo('typing');assert.equal(person.dataset.facing,'desk','typing faces the desk instead of the viewer');scene.stop();assert.equal(person.dataset.facing,'down','after work finishes, an unoccupied role turns back toward the room');
scene.beginReplay();media.matches=true;const reduced=scene.replayEvent({...event,kind:'material_read',seq:42,ts:0},{durationMs:6000});const still=animations.at(-1),stillFrame=JSON.stringify(person.style);still.currentTime=900;await new Promise(r=>setTimeout(r,100));assert.equal(JSON.stringify(person.style),stillFrame,'reduced motion must freeze clock-driven joints too');still.currentTime=4200;await new Promise(r=>setTimeout(r,100));assert.equal(JSON.stringify(person.style),stillFrame,'reduced-motion replay keeps one static pose for the complete event');still.resolve();await reduced;media.matches=false;scene.endReplay();scene.reset();
console.log('PASS action clips: 6 series / 18 unique multi-joint sequences, three stages, neutral recovery, individual preview, shared replay pause/rate and reduced-motion freeze');

// Exercise the actual ambient scheduler with a deterministic clock, independent of real event clocks.
let idleNow=1000,idleSerial=0;const idleIntervals=new Map();
class IdleDate extends Date {static now(){return idleNow;}}
const idleWindow={matchMedia:()=>media};
vm.runInNewContext(await fs.readFile(new URL('../web/office-scene.js',import.meta.url),'utf8'),{window:idleWindow,document,Date:IdleDate,Set,Map,setTimeout,clearTimeout,setInterval(fn){const id=++idleSerial;idleIntervals.set(id,fn);return id;},clearInterval(id){idleIntervals.delete(id);}});
const ambient=new idleWindow.MindPondOfficeScene.Scene(root,wires,status,()=>1);
const advance=ms=>{idleNow+=ms;for(const fn of [...idleIntervals.values()])fn();};
assert.equal(idleIntervals.size,0,'no ambient timer before the office becomes visible');
seats[0].dataset.replayKey='role:idle-a';seats[1].dataset.replayKey='role:idle-g'; // Hashes collide modulo six.
ambient.setActive(true);assert.equal(idleIntervals.size,1,'one shared clock, not one timer per person');
advance(1500);const second=seats[1].querySelector('.office-person');
assert.equal(person.dataset.facing,'down');assert.equal(second.dataset.facing,'down');
assert.notEqual(person.dataset.pose,second.dataset.pose,'roles do not perform one synchronized loop');
const observed=new Set();for(let i=0;i<7;i++){advance(2700);observed.add(person.dataset.pose);advance(9000);advance(2700);}
assert.equal([...observed].filter(Boolean).length,6,'all six distinct rest actions rotate automatically');
ambient.present([{...event,kind:'work_pose',ts:idleNow,seq:100}]);
assert.equal(person.dataset.facing,'desk');assert.equal(person.dataset.idle,undefined,'work immediately takes ownership of the pose');
advance(1500);assert.equal(person.dataset.facing,'desk','ambient clock cannot overwrite real work');assert.equal(second.dataset.facing,'down','unrelated roles continue resting');
const foreground=animations.at(-1);foreground.resolve();await new Promise(r=>setImmediate(r));advance(1500);
assert.equal(person.dataset.facing,'down','rest resumes after the foreground event');
seats[0].dataset.busy='true';advance(1500);assert.equal(person.dataset.facing,'desk','claimed messages keep the worker facing the computer');
const workObserved=new Set();for(let i=0;i<4;i++){advance(2700);workObserved.add(person.dataset.pose);advance(9000);advance(2700);}
assert.deepEqual([...workObserved].filter(Boolean).sort(),['think','typing','write'],'a persistent processing state cycles through all three work actions');
delete seats[0].dataset.busy;advance(1500);assert.equal(person.dataset.facing,'down','last completion releases the work pose back to rest');
ambient.beginReplay();assert.equal(idleIntervals.size,0,'history has no ambient rest competing with its recorded clock');ambient.endReplay();assert.equal(idleIntervals.size,1);
ambient.setMotion(false);assert.equal(idleIntervals.size,0);ambient.setMotion(true);assert.equal(idleIntervals.size,1);
document.hidden=true;listeners.visibilitychange();assert.equal(idleIntervals.size,0);document.hidden=false;listeners.visibilitychange();assert.equal(idleIntervals.size,1);
media.matches=true;listeners['media-change']();assert.equal(idleIntervals.size,0);media.matches=false;listeners['media-change']();assert.equal(idleIntervals.size,1);
ambient.list=true;ambient.stop();ambient.startIdle();assert.equal(idleIntervals.size,0);ambient.list=false;ambient.startIdle();assert.equal(idleIntervals.size,1);
ambient.setActive(false);assert.equal(idleIntervals.size,0);listeners.visibilitychange();assert.equal(idleIntervals.size,0,'returning to the browser cannot restart a different app page');
ambient.reset();assert.equal(ambient.idleSeats.size,0);assert.equal(wires.children.length,0);
console.log('PASS ambient rest: six automatic staggered actions, one clock, work preemption/resumption, claimed tasks, replay and all visibility/motion lifecycle cancellation');

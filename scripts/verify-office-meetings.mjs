/** Exercise the shipped controller and full-volume routes, using synthetic geometry only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const intervals=new Map(),animations=[];let serial=0;
class Element{
 constructor(){this.children=[];this.dataset={};this.style={};this.className='';this.hidden=false;const classes=new Set();this.classList={add:(...v)=>v.forEach(c=>classes.add(c)),remove:(...v)=>v.forEach(c=>classes.delete(c)),contains:c=>classes.has(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)};}
 append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}replaceChildren(){this.children=[];}setAttribute(){}remove(){this.parent.children=this.parent.children.filter(n=>n!==this);}
}
const document={createElement:()=>new Element()},window={},source=await fs.readFile(new URL('../web/office-meetings.js',import.meta.url),'utf8');
vm.runInNewContext(await fs.readFile(new URL('../web/office-navigation.js',import.meta.url),'utf8'),{window});
window.MindPondOfficeScene={drawAction(){},sampleAction(){return {};}};
vm.runInNewContext(source,{window,document,Date,setInterval(fn){const id=++serial;intervals.set(id,fn);return id;},clearInterval:id=>intervals.delete(id)});
const nav=window.MindPondOfficeNavigation,{geometry,Meetings}=window.MindPondOfficeMeetings;
const room=geometry(80,400),other=geometry(1000,400),bounds={left:0,top:0,right:1880,bottom:1260};
assert.equal(room.slots[0].x,room.slots[1].x);assert.notEqual(room.slots[0].facing,room.slots[1].facing,'two attendees face one another');
for(let index=0;index<8;index++){
 const occupied=room.slots.filter((_,i)=>i!==index).map(p=>({left:p.x-33,top:p.y-47,right:p.x+33,bottom:p.y+47}));
 const obstacles=[...room.walls,room.table,...room.chairs.filter((_,i)=>i!==index),...occupied,...other.walls,other.table,...other.chairs];
 const options={bounds,obstacles,halfWidth:33,halfHeight:47,clearance:12};
 const route=nav.planRoute({x:460,y:220},room.slots[index],options);assert(route,`seat ${index} has a safe entry through the door`);
 const expanded=obstacles.map(r=>nav.inflate(r,45,59));for(let i=1;i<route.length;i++)assert(nav.clearSegment(route[i-1],route[i],expanded),'no wall/table/chair/person corner cutting');
 assert(nav.planRoute(room.slots[index],{x:460,y:220},options),'all eight occupied layouts allow a return');
 const blocked={...options,obstacles:[...obstacles,{left:room.door.x-110,top:room.y-10,right:room.door.x+110,bottom:room.y+20}]};assert.equal(nav.planRoute({x:460,y:220},room.slots[index],blocked),null,'a sealed doorway cannot be bypassed through walls');
}
console.log('PASS meeting geometry: eight seats, two rooms, real door entry/exit, full body clearance and sealed-door refusal');

const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height});
const root=new Element(),desks=new Element();desks.offsetTop=150;desks.offsetHeight=440;root.clientWidth=1200;root.clientLeft=8;root.clientTop=20;root.getBoundingClientRect=()=>rect(0,0,1200,1600);root.querySelector=()=>desks;
const makeSeat=(role,left)=>{
 const node=new Element(),person=new Element(),chair=new Element(),table=new Element(),station=new Element();node.dataset={role,seat:role};person.dataset.name=role;
 station.getBoundingClientRect=()=>rect(left,150,280,300);Object.assign(person,{offsetParent:station,offsetLeft:107,offsetTop:70,offsetWidth:66,offsetHeight:94});
 person.getBoundingClientRect=()=>{let x=0,y=0;if(person.animation&&!person.animation.cancelled){const a=person.animation,p=a.currentTime/a.duration;const next=a.frames.findIndex(f=>f.offset>=p),b=a.frames[next<0?a.frames.length-1:next],first=a.frames[Math.max(0,next-1)];const t=b.offset===first.offset?0:(p-first.offset)/(b.offset-first.offset),xy=f=>f.translate.split(' ').map(Number.parseFloat);const from=xy(first),to=xy(b);x=from[0]+(to[0]-from[0])*t;y=from[1]+(to[1]-from[1])*t;}else [x,y]=(person.style.translate||'0 0').split(' ').map(Number.parseFloat);return rect(left+107+x,220+y,66,94);};
 chair.getBoundingClientRect=()=>rect(left+104,person.dataset.posture==='standing'?253:283,72,76);table.getBoundingClientRect=()=>rect(left+49,226,182,74);
 node.querySelector=s=>s==='.office-person'?person:s==='.office-chair'?chair:null;
 person.animate=(frames,{duration})=>{let resolve,reject;const finished=new Promise((r,j)=>{resolve=r;reject=j;});const a={frames,duration,currentTime:0,finished,resolve,cancel(){this.cancelled=true;reject(Error('cancelled'));}};person.animation=a;animations.push(a);return a;};
 return {node,person,chair,table};
};
let seats=[makeSeat('a',30),makeSeat('b',380)];
root.querySelectorAll=s=>s==='.office-desk'?seats.map(r=>r.node):s.startsWith('.office-table')?seats.flatMap(r=>[r.chair,r.table]):[];
const scene={root,scale:()=>1,active:false,enabled:()=>true,status:{},running:false,queue:[],drain(){}},controller=new Meetings(scene);
const record={id:'meeting',title:'One focused question',members:[{roleId:'a',state:'joined'},{roleId:'b',state:'joined'}]};
controller.sync('office',[]);scene.active=true;controller.sync('office',[record]);assert.equal(animations.length,1,'one moving character reserves the corridors');
assert.equal(controller.moving.role,'a');assert.equal(seats[0].person.dataset.posture,'standing');assert.equal(seats[0].node.classList.contains('is-walking'),true);
animations[0].resolve();await new Promise(r=>setImmediate(r));assert.equal(animations.length,2,'second character starts after the first takes a seat: '+scene.status.textContent+' '+JSON.stringify([...controller.positions]));assert.equal(controller.positions.get('a').roomId,'meeting');
animations[1].resolve();await new Promise(r=>setImmediate(r));assert.equal(controller.moving,null);assert.equal(seats[0].person.dataset.posture,'seated');assert.equal(seats[0].person.dataset.facing,'down');
controller.sync('office',[{...record,members:[{roleId:'a',state:'left'},{roleId:'b',state:'joined'}]}]);assert.equal(controller.moving.role,'a','leave schedules a real return route');animations.at(-1).resolve();await new Promise(r=>setImmediate(r));assert.equal(controller.positions.get('a').roomId,null);assert.equal(seats[0].person.dataset.meeting,undefined);
controller.sync('office',[]);assert(controller.rooms.has('meeting'),'ended room remains while somebody is walking out');assert.equal(controller.moving.role,'b');animations.at(-1).resolve();await new Promise(r=>setImmediate(r));assert.equal(controller.rooms.size,0,'walls disappear only after the room is empty');
controller.sync('office',[record]);const first=controller.moving.animation;first.currentTime=first.duration*.4;const before=controller.point(seats[0].person);controller.prepareRebuild();seats=[makeSeat('a',30),makeSeat('b',380)];controller.sync('office',[record]);assert(Math.hypot(controller.positions.get('a').point.x-before.x,controller.positions.get('a').point.y-before.y)<.01,'snapshot rebuild preserves the current path position');
const movingPoint=controller.point(seats[0].person);controller.prepareRebuild();seats=[makeSeat('a',30),makeSeat('b',380)];controller.sync('office',[{...record,members:[{roleId:'a',state:'joined'},{roleId:'b',state:'left'}]}]);assert(Math.hypot(controller.positions.get('a').point.x-movingPoint.x,controller.positions.get('a').point.y-movingPoint.y)<.01,'membership changes and DOM rebuild together must not sample new avatars at their desks');
scene.enabled=()=>false;controller.suspend();assert.equal(controller.moving,null);assert.equal(controller.positions.get('a').roomId,'meeting','reduced motion shows actual membership without walking');
controller.setReplay(true);assert.equal(controller.layer.hidden,true);assert.equal(seats[0].person.dataset.meeting,undefined,'current meeting membership must not contaminate historical playback');controller.setReplay(false);assert.equal(seats[0].person.dataset.meeting,'meeting');
scene.enabled=()=>true;root.clientWidth=1900;root.getBoundingClientRect=()=>rect(0,0,1900,1600);
controller.sync('office',[{...record,members:[{roleId:'a',state:'joined'},{roleId:'b',state:'left'}]}]);
controller.sync('office',[{...record,members:[{roleId:'a',state:'left'},{roleId:'b',state:'joined'}]},{...record,id:'another-meeting',members:[{roleId:'a',state:'joined'}]}]);
assert.equal(controller.moving.role,'a');assert.equal(controller.moving.target.roomId,'another-meeting','changing discussion moves to the correct physical room');animations.at(-1).resolve();await new Promise(r=>setImmediate(r));if(controller.moving){animations.at(-1).resolve();await new Promise(r=>setImmediate(r));}assert.equal(controller.positions.get('a').roomId,'another-meeting');assert.equal(controller.positions.get('b').roomId,'meeting');
const retainedGeometry={...controller.rooms.get('another-meeting').geometry};controller.sync('office',[{...record,id:'another-meeting',members:[{roleId:'a',state:'joined'}]}]);assert.equal(controller.rooms.get('another-meeting').geometry.x,retainedGeometry.x,'closing another room must not relocate an occupied room');controller.suspend();
controller.reset();assert.equal(intervals.size,0);assert.equal(controller.positions.size,0);assert.equal(controller.rooms.size,0);
scene.list=true;seats[0].person.offsetParent=null;assert.doesNotThrow(()=>controller.sync('office',[record]),'list-view hidden sprites must never be measured');assert.equal(controller.initialized,false);
scene.list=false;root.getClientRects=()=>[];assert.doesNotThrow(()=>controller.sync('office',[record]),'an unopened office panel must never be measured');assert.equal(controller.initialized,false);
console.log('PASS real meeting controller: serialized entry, persistent seats, leave/close returns, snapshot continuity, reduced motion, replay isolation and teardown');

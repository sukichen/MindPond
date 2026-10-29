/** Actual UI module with delayed detail/list responses and changing lock policy. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
class Element{
 constructor(tag,text=''){Object.assign(this,{tagName:tag,textContent:text,children:[],dataset:{},attrs:{},listeners:{},value:'',hidden:false,disabled:false});}
 append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}focus(){}reportValidity(){return true;}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
}
const all=n=>[n,...n.children.flatMap(all)],tick=()=>new Promise(r=>setImmediate(r));
const root=new Element('body'),tabs=new Element('nav'),office=new Element('section'),pending=[];
const state={logged:true,authEpoch:1,office:{office:{id:'office'}}};
const context=vm.createContext({window:{crypto:webcrypto,MindPondOfficeMarkdown:{render:text=>new Element('markdown',text)}},document:{body:root,createElement:tag=>new Element(tag),querySelector:()=>tabs,getElementById:()=>office},crypto:webcrypto,TextEncoder,Uint8Array});
vm.runInContext(await fs.readFile(new URL('../web/office-resources.js',import.meta.url),'utf8'),context);
const instance=context.window.MindPondOfficeResources.mount({getState:()=>state,api:(path,args)=>new Promise((resolve,reject)=>pending.push({path,args,resolve,reject})),run:async(fn,b)=>{if(b.disabled)return;b.disabled=true;try{await fn();}finally{b.disabled=false;}},setRoomTab(){},notice(){},confirmAction:async()=>true,download(){}});
const panel=office.children.find(n=>n.id==='officeResource-discussions');panel.hidden=false;
const status=phase=>({phase,joined:2,unreadPosts:phase==='pending_posts'?4:0,unprocessedPosts:phase==='pending_posts'?4:0,waiting:0,lastPostAt:1});
const room=(revision,phase='pending_posts',locked=false)=>({id:'meeting',title:'Focused meeting',question:'One question',done_when:'Verified result',revision,locked,lockRevision:locked?2:1,expires_at:1,status:status(phase)});
const detail=(revision,phase='pending_posts',locked=false)=>({room:room(revision,phase,locked),status:status(phase),members:[],posts:[{seq:revision,body:'Snapshot '+revision,created_at:1}],exports:[],participantRequests:[],nextAfterSeq:revision,lastSeq:revision});
let refresh=instance.refresh();pending[0].resolve({rooms:[room(1)]});await refresh;
const card=all(panel).find(n=>n.className==='office-discussion-card'),summary=card.children[0];
card.open=true;for(const fn of card.listeners.toggle)fn(); // old detail remains pending
const lock=all(card).find(n=>n.textContent==='锁定会议室'),changing=lock.onclick();
pending[2].resolve({id:'meeting',revision:2,locked:true,lockRevision:2});await tick();
pending[1].resolve(detail(1));await tick();
assert(!all(card).some(n=>n.textContent==='Snapshot 1'),'detail older than the applied lock revision must not replace the room record or content');
pending[3].resolve({rooms:[room(2,'no_wait_observed',true)]});await tick();pending[4].resolve(detail(2,'no_wait_observed',true));await changing;await tick();
assert(all(card).some(n=>n.textContent==='Snapshot 2'));
console.log('PASS late pre-lock detail cannot roll back the meeting record or content');
// An earlier list response must not replace newer discussion status.
refresh=instance.refresh(true);const oldList=pending.length-1;
for(const fn of card.listeners.toggle)fn();const newDetail=pending.length-1;
pending[newDetail].resolve(detail(4,'no_wait_observed',true));await tick();
pending[oldList].resolve({rooms:[room(3,'pending_posts',true)]});await refresh;
assert(!summary.textContent.includes('有未读发言'),'an older list must not roll back a newer detail status');
assert(all(card).some(n=>n.textContent==='Snapshot 4'));
pending.at(-1).resolve(detail(4,'no_wait_observed',true));await tick();
// Delivery/read/wait observations can change without incrementing the room revision.
refresh=instance.refresh(true);const sameVersionList=pending.length-1;
for(const fn of card.listeners.toggle)fn();const sameVersionDetail=pending.length-1;
pending[sameVersionDetail].resolve(detail(4,'no_wait_observed',true));await tick();
pending[sameVersionList].resolve({rooms:[room(4,'pending_posts',true)]});await refresh;
assert(!summary.textContent.includes('有未读发言'),'request ordering also protects status updates at the same room revision');
pending.at(-1).resolve(detail(4,'no_wait_observed',true));await tick();instance.reset();
console.log('PASS stale list snapshots cannot roll back newer detail status, including observations at the same revision');

/** Execute actual UI module handlers with delayed/reordered responses. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
class Element{
 constructor(tag,text=''){Object.assign(this,{tagName:tag,textContent:text,children:[],dataset:{},attrs:{},listeners:{},value:'',hidden:false,disabled:false});}
 append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 setAttribute(key,value){this.attrs[key]=value;}addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}focus(){}reportValidity(){return true;}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
 close(){this.open=false;for(const fn of this.listeners.close??[])fn();}showModal(){this.open=true;}
}
const all=root=>[root,...root.children.flatMap(all)],body=new Element('body'),tabs=new Element('nav'),office=new Element('section');body.append(tabs,office);
const requests=[],downloaded=[],errors=[];let live=true;const state={logged:true,authEpoch:1,office:{office:{id:'office-a'}}};
const api=(path,args)=>new Promise((resolve,reject)=>requests.push({path,args,resolve,reject}));
const run=async(fn,b)=>{if(b?.disabled)return;if(b)b.disabled=true;try{await fn();}catch(error){errors.push(error);}finally{if(b)b.disabled=false;}};
const context=vm.createContext({window:{crypto:webcrypto,MindPondOfficeMarkdown:{render:text=>new Element('markdown',text)}},document:{body,createElement:tag=>new Element(tag),querySelector:s=>s==='.office-workspace-tabs'?tabs:null,getElementById:()=>office},crypto:webcrypto,TextEncoder,Uint8Array,console});
vm.runInContext(await fs.readFile(new URL('../web/office-resources.js',import.meta.url),'utf8'),context);
const tick=()=>new Promise(r=>setImmediate(r));
const resources=context.window.MindPondOfficeResources.mount({getState:()=>state,api,run,setRoomTab(){},notice(){},confirmAction:async()=>true,download:(...args)=>downloaded.push(args)});
const discussions=office.children.find(n=>n.id==='officeResource-discussions');discussions.hidden=false;
const refresh=resources.refresh();assert.equal(requests[0].args.officeId,'office-a');requests[0].resolve({rooms:[{id:'r',title:'One question',revision:1}]});await refresh;
const card=all(discussions).find(n=>n.className==='office-discussion-card');card.open=true;for(const fn of card.listeners.toggle)fn();
const page=(posts,lastSeq=posts.at(-1)?.seq??0)=>({room:{title:'One question',question:'Bounded question',done_when:'Reach one verified conclusion',revision:lastSeq,expires_at:1},members:[{name:'A',state:'joined'}],posts,lastSeq,nextAfterSeq:lastSeq,hasMore:false,exports:[]});
requests[1].resolve(page([{seq:1,authorName:'A',body:'First verified step',created_at:1}]));await tick();
const draft=all(card).find(n=>n.tagName==='textarea');draft.value='Keep this selected conclusion';assert(resources.hasDraft());
const refresh2=resources.refresh();requests[2].resolve({rooms:[{id:'r',title:'One question',revision:2}]});await refresh2;
requests[3].resolve(page([{seq:1,authorName:'A',body:'First verified step',created_at:1},{seq:2,authorName:'B',body:'New verified step',created_at:2}]));await tick();
assert.equal(card.open,true);assert.equal(all(card).find(n=>n.tagName==='textarea'),draft);assert.equal(draft.value,'Keep this selected conclusion');assert(all(card).some(n=>n.textContent==='New verified step'));
assert.equal(all(card).find(n=>n.textContent==='继续读取讨论').hidden,true,'head refresh must advance the already loaded cursor; no phantom continuation');
const form=all(card).find(n=>n.tagName==='form'),saveStart=requests.length;
form.onsubmit({preventDefault(){}});const originalPayload=requests[saveStart].args;requests[saveStart].reject(Error('Response lost'));await tick();assert(errors.some(e=>e.message==='Response lost'));
for(const fn of card.listeners.toggle)fn();requests[saveStart+1].resolve(page([{seq:3,body:'New discussion revision',created_at:3}]));await tick();
form.onsubmit({preventDefault(){}});assert.deepEqual(requests[saveStart+2].args,originalPayload,'retry must freeze the original revision/key even after a live discussion update');requests[saveStart+2].resolve({memoryId:'selected-conclusion'});await tick();requests[saveStart+3].resolve(page([{seq:4,body:'Conclusion registered',created_at:4}]));await tick();assert.equal(draft.value,'');draft.value='Another unsaved conclusion';
const lateStart=requests.length,late=resources.refresh(true);requests[lateStart].resolve({rooms:[{id:'r',title:'One question',revision:5}]});await late;state.logged=false;resources.reset();requests[lateStart+1].resolve(page([{seq:5,body:'Must not reappear',created_at:5}]));await tick();assert(!all(discussions).some(n=>n.textContent==='Must not reappear'));

const container=new Element('section');body.append(container);const start=requests.length,source='print("合成🙂")\n',sha256=createHash('sha256').update(source).digest('hex'),record={id:'script',filename:'check.py',description:'Fixture source',usage:'Review first',language:'Python 3',revision:1,sha256,bytes:Buffer.byteLength(source)};
context.window.MindPondOfficeResources.library({container,scope:{roleId:'role-a'},api,current:()=>live,notice(){},confirmAction:async()=>true,download:(...args)=>downloaded.push(args)});
assert.equal(requests[start].args.roleId,'role-a');requests[start].resolve({scripts:[record],hasMore:false});await tick();const download=all(container).find(n=>n.textContent==='下载源码');
const pending=download.onclick();requests[start+1].resolve({script:record,offset:0,content:source.slice(0,2),nextOffset:2});await tick();assert.equal(requests[start+2].args.expectedRevision,1);live=false;requests[start+2].resolve({script:record,offset:2,content:source.slice(2),nextOffset:null});await pending;assert.equal(downloaded.length,0,'a source response after navigation/logout cannot trigger a download');
live=true;const corrupt=download.onclick();requests[start+3].resolve({script:record,offset:0,content:'altered source',nextOffset:null});await corrupt;assert.equal(downloaded.length,0,'integrity failures must refuse downloads');assert(all(container).some(n=>n.textContent.includes('校验失败')));
const complete=download.onclick();requests[start+4].resolve({script:record,offset:0,content:source,nextOffset:null});await complete;assert.equal(downloaded.length,1);assert.deepEqual(downloaded[0],[source,'check.py']);
const html=await fs.readFile(new URL('../web/collaboration.html',import.meta.url),'utf8');assert(html.includes('office-resources.js?v=meetings-20261023'));assert(!html.includes('office-room-lounge'));
const collaboration=await fs.readFile(new URL('../web/office-collaboration.js',import.meta.url),'utf8');assert(!collaboration.includes('office-area-'));
console.log('PASS real resource UI: current role scope, live discussion/draft preservation, complete cursor updates, logout fences, source version/SHA-256 validation and deployed asset registration');

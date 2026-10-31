/** Shipped permission editor with controlled response ordering, failure and navigation. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
class Element{
 constructor(tag,text=''){Object.assign(this,{tagName:tag,textContent:text,children:[],attrs:{},hidden:false,disabled:false,checked:false});}
 append(...nodes){this.children.push(...nodes);}prepend(...nodes){this.children.unshift(...nodes);}setAttribute(k,v){this.attrs[k]=v;}
}
const all=n=>[n,...n.children.flatMap(all)],tick=()=>new Promise(r=>setImmediate(r));
const window={},container=new Element('section'),requests=[],busy=[];let current=true,editable=true;
vm.runInNewContext(await fs.readFile(new URL('../web/role-memory-permissions.js',import.meta.url),'utf8'),{window,document:{createElement:tag=>new Element(tag)}});
window.MindPondRoleMemoryPermissions.mount({container,roleId:'role-fixture',api:(path,args)=>new Promise((resolve,reject)=>requests.push({path,args,resolve,reject})),current:()=>current,canEdit:()=>editable,onBusy:v=>busy.push(v)});
const [read,organize]=all(container).filter(n=>n.tagName==='input'),refresh=all(container).find(n=>n.textContent==='刷新权限'),retry=all(container).find(n=>n.textContent==='重试保存');
const policy=(revision,readOthers,organizeOthers)=>({roleId:'role-fixture',revision,readOthers,organizeOthers});
assert(read.disabled&&organize.disabled);assert.equal(requests[0].path,'role/memory-permissions');requests[0].resolve(policy(0,false,false));await tick();assert(!read.checked&&!organize.checked&&!read.disabled);
organize.checked=true;organize.onchange();assert.equal(requests[1].args.readOthers,true);assert.equal(requests[1].args.organizeOthers,true);assert.equal(requests[1].args.expectedRevision,0);assert(read.disabled&&organize.disabled);assert.equal(busy.at(-1),true);
organize.onchange();assert.equal(requests.length,2,'busy edits cannot submit another policy');requests[1].resolve(policy(1,true,true));await tick();assert(read.checked&&organize.checked&&!read.disabled);assert.equal(busy.at(-1),false);
read.checked=false;read.onchange();const lost=requests[2].args;assert.equal(lost.readOthers,false);assert.equal(lost.organizeOthers,false);requests[2].reject(Error('Outcome unknown'));await tick();assert(read.checked&&organize.checked);assert.equal(retry.hidden,false,'unknown outcomes preserve the same intended request for retry');
retry.onclick();assert.deepEqual(requests[3].args,lost);requests[3].resolve(policy(2,false,false));await tick();assert(!read.checked&&!organize.checked&&retry.hidden);
// A refresh issued before saving must never roll the confirmed switches back.
refresh.onclick();const delayedRead=requests[4];organize.checked=true;organize.onchange();requests[5].resolve(policy(3,true,true));await tick();assert(read.checked&&organize.checked);delayedRead.resolve(policy(2,false,false));await tick();assert(read.checked&&organize.checked,'late read cannot undo an acknowledged save');
editable=false;read.checked=false;read.onchange();assert.equal(requests.length,6);assert(read.checked,'a concurrent profile operation cannot leave an unsaved switch visible');editable=true;
// Definite CAS rejection requires a refresh, never an endless stale retry.
read.checked=false;read.onchange();requests[6].reject(Object.assign(Error('Permission changed'),{status:409}));await tick();assert(retry.hidden&&read.checked&&organize.checked);
refresh.onclick();requests[7].resolve(policy(4,true,false));await tick();assert(read.checked&&!organize.checked);
organize.checked=true;organize.onchange();current=false;const before=busy.length;requests[8].resolve(policy(5,true,true));await tick();assert.equal(busy.length,before,'a late save cannot touch a different inspector or announce it saved');
const html=await fs.readFile(new URL('../web/collaboration.html',import.meta.url),'utf8'),app=await fs.readFile(new URL('../web/office.js',import.meta.url),'utf8'),pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
assert(html.includes('./assets/role-memory-permissions.js?'));assert(app.includes('MindPondRoleMemoryPermissions?.mount'));assert(pkg.files.includes('web/role-memory-permissions.js'));
assert(app.includes('saving || state.roleDraft?.saving || !form.reportValidity()'),'profile save must honor a permission change in flight');
console.log('PASS permission UI: human switches, dependent read/organize intent, independent CAS, busy fencing, fixed lost-response retry, late read/save ordering, stale-policy refresh and inspector/logout fences');

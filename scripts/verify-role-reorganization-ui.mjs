/** Execute the actual editor, including abandoned replies and apply retries. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
class Element{
 constructor(tag,text=''){Object.assign(this,{tagName:tag,textContent:text,children:[],listeners:{},value:'',hidden:false,disabled:false});}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[];this.append(...nodes);}setAttribute(){}addEventListener(k,f){(this.listeners[k]??=[]).push(f);}reportValidity(){return true;}
}
const html=await fs.readFile(new URL('../web/collaboration.html',import.meta.url),'utf8');assert(/<script src="\.\/assets\/role-reorganization\.js[^>]*><\/script>/.test(html));
const js=await fs.readFile(new URL('../web/office.js',import.meta.url),'utf8');assert(js.includes('MindPondRoleReorganization?.mount'));assert(js.includes("reorganizationTab=button('合并 / 拆分'"));
const window={},container=new Element('section'),requests=[],completed=[],busy=[];let active=true,dirty=0;
vm.runInNewContext(await fs.readFile(new URL('../web/role-reorganization.js',import.meta.url),'utf8'),{window,document:{createElement:tag=>new Element(tag)}});
window.MindPondRoleReorganization.mount({container,role:{id:'source',name:'Source',introduction:'Source duty'},api:(path,args)=>new Promise((resolve,reject)=>requests.push({path,args,resolve,reject})),current:()=>active,onDirty:()=>dirty++,onBusy:v=>busy.push(v),complete:async r=>completed.push(r)});
const all=n=>[n,...n.children.flatMap(all)],find=(tag,text)=>all(container).find(n=>n.tagName===tag&&(text===undefined||n.textContent===text));
const tick=()=>new Promise(r=>setImmediate(r));
requests.at(-1).resolve({records:[{id:'target',label:'Target',detail:'Target duties'}],hasMore:true,nextAfter:'target'});await tick();
const selects=all(container).filter(n=>n.tagName==='select'),[mode,target,checkpoint,kind]=selects;
assert.equal(target.value,'','merging requires explicit keeper selection');assert(!find('button','加载更多').hidden);
let loading=find('button','加载更多').onclick();assert.equal(requests.at(-1).args.after,'target');requests.at(-1).resolve({records:[{id:'target2',label:'Another',detail:'Other duties'}],hasMore:false,nextAfter:null});await loading;
target.value='target';target.onchange();assert.equal(find('input').value,'Target');assert.equal(find('textarea').value,'Target duties');assert(dirty);
const submit=()=>find('form').listeners.submit[0]({preventDefault(){}});
let previewing=submit();assert(find('fieldset').disabled);assert.equal(requests.at(-1).args.targetId,'target');assert.equal(requests.at(-1).args.introduction,'Target duties');
const plan={previewId:'preview',counts:{memories:2,cutAssociations:1},blockers:[],target:{name:'Target'},name:'Target',notice:'Disconnect both chats'};
requests.at(-1).resolve(plan);await previewing;assert(!find('button','确认并执行').hidden);
find('input').value='Custom name';find('input').oninput();assert(find('button','确认并执行').hidden,'editing invalidates the old plan');
previewing=submit();requests.at(-1).resolve({...plan,blockers:['Finish pending mail']});await previewing;assert(find('button','确认并执行').hidden);assert(all(container).some(n=>n.textContent==='Finish pending mail'));
mode.value='split';mode.onchange();const abandoned=requests.at(-1);kind.value='scripts';kind.onchange();const latest=requests.at(-1);
abandoned.resolve({records:[{id:'late-memory',label:'Abandoned',detail:'fact'}],hasMore:false});latest.resolve({records:[{id:'script',label:'<script>alert(1)</script>',detail:'sh'}],hasMore:false});await tick();assert(!all(container).some(n=>n.textContent.includes('Abandoned')));assert(all(container).some(n=>n.textContent.includes('<script>alert(1)</script>')),'labels remain literal text');
let choice=all(container).find(n=>n.tagName==='input'&&n.type==='checkbox');choice.checked=true;choice.onchange();
kind.value='memories';kind.onchange();requests.at(-1).resolve({records:[{id:'memory',label:'Verified knowledge',detail:'fact'}],hasMore:false});await tick();choice=all(container).find(n=>n.tagName==='input'&&n.type==='checkbox');choice.checked=true;choice.onchange();
previewing=submit();assert.equal(requests.at(-1).args.memoryIds[0],'memory');assert.equal(requests.at(-1).args.scriptIds[0],'script');requests.at(-1).resolve({...plan,target:null});await previewing;
let applying=find('button','确认并执行').onclick();assert.deepEqual(busy,[true]);const originalId=requests.at(-1).args.previewId;requests.at(-1).reject(Error('Response lost'));await applying;assert(!find('button','确认并执行').hidden);applying=find('button','确认并执行').onclick();assert.equal(requests.at(-1).args.previewId,originalId);requests.at(-1).resolve({targetId:'new-role'});await applying;assert.equal(completed.length,1);assert.deepEqual(busy,[true,false,true,false]);
previewing=submit();active=false;requests.at(-1).resolve(plan);await previewing;assert(find('button','确认并执行').hidden);assert.equal(completed.length,1);
console.log('PASS role UI: explicit keeper, keeper profile, paged search, per-category selections, preview invalidation/blockers, literal text, stale-response fencing, busy protection and idempotent lost-response retries');

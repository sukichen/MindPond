/** Execute actual dispatch editor with deterministic DOM and delayed responses. */
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import vm from 'node:vm';
class Element{
 constructor(tag,text=''){Object.assign(this,{tagName:tag.toUpperCase(),textContent:text,children:[],listeners:{},value:'',hidden:false,disabled:false});}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[];this.append(...nodes);}setAttribute(k,v){this[k]=v;}addEventListener(k,f){(this.listeners[k]??=[]).push(f);}reportValidity(){return true;}
}
const source=await fs.readFile(new URL('../web/role-clones.js',import.meta.url),'utf8');
const window={},requests=[],busy=[],notices=[];let active=true,key=0,dirty=0;
vm.runInNewContext(source,{window,document:{createElement:tag=>new Element(tag)},crypto:{randomUUID:()=>`key-${++key}`}});
const container=new Element('section');window.MindPondRoleClones.mount({container,role:{id:'parent',name:'Parent',introduction:'Duty',principal:'human',state:'active'},current:()=>active,onBusy:b=>busy.push(b),onDirty:()=>dirty++,notice:v=>notices.push(v),confirmAction:async()=>true,api:(route,args)=>new Promise((resolve,reject)=>requests.push({route,args,resolve,reject}))});
const all=n=>[n,...n.children.flatMap(all)],find=(tag,text)=>all(container).find(n=>n.tagName===tag.toUpperCase()&&(text===undefined||n.textContent===text));const tick=()=>new Promise(r=>setImmediate(r));
const status={lineage:null,clones:[],principals:[{principal:'human'}],limits:{memories:100},returns:{}};
requests.shift().resolve(status);await tick();assert.equal(dirty,0,'opening the tab is not an unsaved edit');
const candidate=requests.find(r=>r.args.action==='candidates'),report=requests.find(r=>r.args.action==='reports');candidate.resolve({records:[{id:'m1',label:'<script>literal text</script>',change:'new'}],hasMore:true,nextAfterId:'memory:m1'});report.resolve({reports:[],hasMore:false});await tick();assert(all(container).some(n=>n.textContent.includes('<script>literal text</script>')));
const check=find('input');const boxes=all(container).filter(n=>n.tagName==='INPUT'&&n.type==='checkbox');boxes[0].checked=true;boxes[0].onchange();assert.equal(dirty,1);
const mission=find('textarea');mission.value='Recipient task';mission.oninput();
const submit=()=>find('form').listeners.submit[0]({preventDefault(){}});submit();await tick();let dispatch=requests.at(-1);assert.equal(dispatch.args.action,'dispatch');assert.equal(dispatch.args.memoryIds[0],'m1');assert.equal(dispatch.args.scriptIds.length,0);const originalKey=dispatch.args.key;assert(find('fieldset').disabled);assert.equal(busy.at(-1),true);
dispatch.reject(Error('Lost response'));await tick();assert.equal(busy.at(-1),false);assert(!find('fieldset').disabled);submit();await tick();dispatch=requests.at(-1);assert.equal(dispatch.args.key,originalKey,'lost response retries same dispatch key');dispatch.resolve({roleId:'child',name:'Helper'});await tick();assert(notices.length);assert.equal(requests.at(-1).args.action,'status');requests.at(-1).resolve({...status,clones:[{roleId:'child',name:'Helper',mission:'Task',state:'active',connectorId:null}],clonesHasMore:true,nextAfterId:'child'});await tick();for(const request of requests.filter(r=>['candidates','reports'].includes(r.args.action)))request.resolve({records:[],reports:[],hasMore:false});await tick();assert(find('button','更多分身'));
const more=find('button','更多分身');const loading=more.onclick();assert.equal(requests.at(-1).args.afterId,'child');requests.at(-1).resolve({...status,clones:[{roleId:'child-2',name:'Helper 2',mission:'Task 2',state:'active'}],clonesHasMore:false});await loading;assert(all(container).some(n=>n.textContent==='Helper 2 · 可工作'));assert(more.hidden);
// Abandoned inspector responses cannot populate a new editor or notify another account.
const prior=all(container).length;active=false;const before=requests.length;await more.onclick();assert.equal(requests.length,before);assert.equal(all(container).length,prior);
const html=await fs.readFile(new URL('../web/collaboration.html',import.meta.url),'utf8'),app=await fs.readFile(new URL('../web/office.js',import.meta.url),'utf8'),pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
assert(html.includes('./assets/role-clones.js?'));assert(app.includes("clonesTab=button('派遣分身'"));assert(app.includes('MindPondRoleClones?.mount'));assert(pkg.files.includes('web/role-clones.js'));assert(pkg.files.includes('docs/role-clones.md'));
console.log('PASS clone UI: explicit selections, no mount dirtiness, literal labels, busy fencing, lost-response idempotency, child pagination, stale inspector guards and packaged entry point');

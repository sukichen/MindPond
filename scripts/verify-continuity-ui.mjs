/** Actual continuity UI handlers with deterministic out-of-order HTTP replies. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
class Element{
 constructor(tag,text=''){this.tagName=tag;this.textContent=text;this.children=[];this.attrs={};this.hidden=false;this.value='';}
 append(...nodes){for(const n of nodes){if(this.tagName==='select'&&!this.children.length)this.value=n.value;this.children.push(n);}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 setAttribute(name,value){this.attrs[name]=value;}addEventListener(){}focus(){}
}
const body=new Element('body'),requests=[];let live=true;
const context=vm.createContext({document:{createElement:tag=>new Element(tag),body},window:{MindPondOfficeMarkdown:{render:value=>new Element('markdown',value)}},Option:function(label,value){this.tagName='option';this.textContent=label;this.value=value;},crypto:{randomUUID:()=>String(Math.random())},console});
vm.runInContext(await fs.readFile(new URL('../web/office-continuity.js',import.meta.url),'utf8'),context);
const mount=context.window.MindPondRoleContinuity.mount,container=new Element('section');
const api=(path,args)=>new Promise((resolve,reject)=>requests.push({path,args,resolve,reject}));
mount({container,role:{id:'role-a'},offices:[],api,current:()=>live,notice(){},confirmAction:async()=>true});
function all(root){return [root,...(root.children||[]).flatMap(all)];}
const view=all(container).find(n=>n.attrs?.['aria-label']==='查看接续工作');assert.equal(requests[0].path,'role/continuity');assert.equal(requests[0].args.roleId,'role-a');
view.value='completed';view.onchange();assert.equal(requests[1].args.state,'completed');
requests[1].resolve({records:[{kind:'task',id:'finished',title:'Latest completed task',officeId:null,status:'done',priority:1,revision:1,updatedAt:1,progress:'Verified fixture outcome',sources:[]}],nextCursor:null});
await new Promise(r=>setImmediate(r));assert(all(container).some(n=>n.textContent==='Latest completed task'));
requests[0].reject(Error('Obsolete request failed'));await new Promise(r=>setImmediate(r));assert(!all(container).some(n=>n.textContent==='Obsolete request failed'));
view.value='history';view.onchange();live=false;requests[2].resolve({records:[{seq:1,reason:'Must not apply',recordedAt:1,payload:{kind:'checkpoint',goal:'Must not appear'}}]});
await new Promise(r=>setImmediate(r));assert(!all(container).some(n=>n.textContent==='Must not appear'));
live=true;view.value='archived';view.onchange();
requests[3].resolve({records:[{kind:'task',id:'archived',title:'Archived task',officeId:null,status:'done',priority:1,revision:2,updatedAt:1,archivedAt:1,progress:'Verified',nextSteps:[],blockers:[],sources:[]}],nextCursor:null});
await new Promise(r=>setImmediate(r));
const restore=all(container).find(n=>n.textContent==='恢复到已完成');const restoring=restore.onclick();
assert.equal(requests[4].path,'role/continuity/task');
view.value='resume';view.onchange();requests[5].resolve({checkpoints:[],tasks:[],recordedCheckpoints:0,activeTasks:0,attention:{pendingMessages:0,processingMessages:0,controlRequests:[]}});await new Promise(r=>setImmediate(r));
requests[4].resolve({});await new Promise(r=>setImmediate(r));assert.equal(view.value,'resume','a delayed restore must not force a different view after the user switches');
requests[6].resolve({checkpoints:[],tasks:[],recordedCheckpoints:0,activeTasks:0,attention:{pendingMessages:0,processingMessages:0,controlRequests:[]}});await restoring;
const html=await fs.readFile(new URL('../web/collaboration.html',import.meta.url),'utf8');assert(html.includes('office-continuity.js?v=role-continuity-20261022'));
const office=await fs.readFile(new URL('../web/office.js',import.meta.url),'utf8');assert(office.includes('state.authEpoch===continuityEpoch'));assert(!office.includes('state.authenticated'));
console.log('PASS real continuity UI: precise manager target, current/completed/history navigation, stale failure suppression, closed-role/auth epoch protection and deployed asset registration');

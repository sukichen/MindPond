/** Exercise the real small rule editor with delayed replies and auth changes. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
class Element{
 constructor(tag,text=''){Object.assign(this,{tagName:tag,textContent:text,children:[],dataset:{},attrs:{},listeners:{},value:'',hidden:false,disabled:false});}
 append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}focus(){}reportValidity(){return true;}
 close(){this.open=false;}showModal(){this.open=true;}remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
}
const html=await fs.readFile(new URL('../web/collaboration.html',import.meta.url),'utf8');
const scriptTags=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
assert(scriptTags.some(s=>s[1].includes('office-rules.js'))&&scriptTags.some(s=>/office\.js\?/.test(s[1])),'both the editor and main application entry must be loadable script elements');
for(const script of scriptTags)if(/src=/.test(script[1]))assert.equal(script[2].trim(),'','external script tags must close before the next entry');
const all=n=>[n,...n.children.flatMap(all)],body=new Element('body'),requests=[],notices=[],confirmations=[];
const state={logged:true,authEpoch:1},window={},context=vm.createContext({window,document:{body,createElement:tag=>new Element(tag)},crypto:webcrypto,TextEncoder});
vm.runInContext(await fs.readFile(new URL('../web/office-rules.js',import.meta.url),'utf8'),context);
const editor=window.MindPondOfficeRules.mount({getState:()=>state,api:(path,args)=>new Promise((resolve,reject)=>requests.push({path,args,resolve,reject})),notice:text=>notices.push(text),confirmAction:async text=>{confirmations.push(text);return true;}});
const policy={revision:0,rules:[{id:'memory',title:'Memory',text:'Remember verified lessons',frequency:'balanced'}],defaults:[{id:'memory',title:'Memory',text:'Remember verified lessons',frequency:'balanced'}],levels:[{id:'off',label:'关闭'},{id:'light',label:'每8次'},{id:'balanced',label:'每4次'},{id:'strong',label:'每次'},...[16,32,64,128].map(n=>({id:'every'+n,label:'每'+n+'次'}))]};
const resolveGet=()=>requests.at(-1).resolve(structuredClone(policy));const tick=()=>new Promise(r=>setImmediate(r));
const find=(tag,text)=>all(body).find(n=>n.tagName===tag&&(text===undefined||n.textContent===text));
let opening=editor.open({id:'a',title:'Office A'});assert(find('dialog').open);resolveGet();await opening;
assert.equal(find('textarea').value,policy.rules[0].text);assert(!editor.hasDraft());assert.deepEqual(find('select').children.map(o=>o.value),['off','light','balanced','strong','every16','every32','every64','every128']);find('textarea').value='Changed draft';find('textarea').listeners.input[0]();assert(editor.hasDraft());
const form=find('form'),submit=()=>form.listeners.submit[0]({preventDefault(){}});
let saving=submit();assert(find('fieldset').disabled);assert.equal(requests.at(-1).args.rules[0].text,'Changed draft');requests.at(-1).reject(Object.assign(Error('Settings changed'),{code:'stale_version'}));await saving;assert(editor.hasDraft());assert.equal(find('textarea').value,'Changed draft');assert(!find('button','重新载入').hidden);
let reloading=find('button','重新载入').onclick();await tick();resolveGet();await reloading;assert(!editor.hasDraft());assert(confirmations.some(t=>t.includes('替换未保存')));
find('button','＋ 添加守则').onclick();assert.equal(all(body).filter(n=>n.tagName==='textarea').length,2);const selects=all(body).filter(n=>n.tagName==='select');selects[1].value='every128';selects[1].listeners.change[0]();
const inputs=all(body).filter(n=>n.tagName==='input');inputs[1].value='Safety';inputs[1].listeners.input[0]();const textareas=all(body).filter(n=>n.tagName==='textarea');textareas[1].value='No secret content';textareas[1].listeners.input[0]();
saving=submit();const payload=requests.at(-1).args;assert.equal(payload.rules[1].frequency,'every128');requests.at(-1).resolve({revision:1,rules:payload.rules});await saving;assert(!editor.hasDraft());assert.equal(notices.length,1);assert.equal(all(body).filter(n=>n.tagName==='select')[1].value,'every128');
find('textarea').value='中'.repeat(700);find('textarea').listeners.input[0]();const before=requests.length;await submit();assert.equal(requests.length,before,'oversize draft is rejected before transport');assert(all(body).some(n=>n.textContent.includes('2048 字节')));
// Even after login identity changes, a late save cannot clear drafts or announce success.
find('textarea').value='Safe changed draft';find('textarea').listeners.input[0]();saving=submit();state.authEpoch++;requests.at(-1).resolve({revision:2,rules:payload.rules});await saving;assert.equal(notices.length,1);assert(editor.hasDraft());assert(find('fieldset').disabled);assert(!find('button','✕').disabled);await find('button','✕').onclick();assert.equal(body.children.length,0,'stale editor can still be closed');
// Closing during a read and opening another office fences the abandoned reply.
opening=editor.open({id:'a',title:'Office A'});const old=requests.at(-1);await find('button','✕').onclick();const next=editor.open({id:'b',title:'Office B'});const current=requests.at(-1);old.resolve({...policy,rules:[{...policy.rules[0],text:'Abandoned response'}]});await opening;current.resolve(structuredClone(policy));await next;assert.equal(find('textarea').value,policy.rules[0].text);assert.equal(current.args.officeId,'b');
const remove=find('button','删除此守则');remove.onclick();assert(!find('textarea'));saving=find('form').listeners.submit[0]({preventDefault(){}});assert.equal(requests.at(-1).args.rules.length,0);requests.at(-1).resolve({revision:1,rules:[]});await saving;
const restoring=find('button','恢复默认守则').onclick();await restoring;assert.equal(find('textarea').value,policy.rules[0].text);assert(editor.hasDraft());editor.reset();assert(!editor.hasDraft());assert.equal(body.children.length,0);
console.log('PASS rules UI: multi-rule independent levels, explicit save, byte budget, stale-revision draft retention, reload confirmation, late-reply/auth fencing, close during read, opt-out and default restore');

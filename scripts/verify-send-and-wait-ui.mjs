/** Execute the actual human editor with delayed requests, stale policies and auth changes. */
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import vm from 'node:vm';
class Element{constructor(tag,text=''){Object.assign(this,{tagName:tag,textContent:text,children:[],listeners:{},value:'',disabled:false});}append(...n){this.children.push(...n);}replaceChildren(...n){this.children=n;}setAttribute(){}addEventListener(k,f){this.listeners[k]=f;}reportValidity(){return true;}}
const window={},container=new Element('section'),requests=[],saved=[];let active=true;
vm.runInNewContext(await fs.readFile(new URL('../web/office-reply-wait.js',import.meta.url),'utf8'),{window,document:{createElement:tag=>new Element(tag)}});
const ui=window.MindPondOfficeReplyWait.mount({container,api:(route,args)=>new Promise((resolve,reject)=>requests.push({route,args,resolve,reject})),current:()=>active,onSaved:r=>saved.push(r)});
const all=n=>[n,...n.children.flatMap(all)],find=(tag,text)=>all(container).find(n=>n.tagName===tag&&(text===undefined||n.textContent===text)),input=find('input'),form=find('form'),fields=find('fieldset'),reload=find('button','重新读取设置');
const policy=(revision,minimumSeconds)=>({revision,minimumSeconds,maximumSeconds:300,defaultSeconds:300,toolTimeoutSeconds:360});
const submit=()=>form.listeners.submit({preventDefault(){}});
ui.update(policy(0,0));assert.equal(input.value,'0');assert(!ui.hasDraft());input.value='300';input.listeners.input();assert(ui.hasDraft());ui.update(policy(1,10));assert.equal(input.value,'300','poll cannot overwrite user draft');
let saving=submit();assert(fields.disabled);assert.equal(requests.at(-1).args.minimumSeconds,300);assert.equal(requests.at(-1).args.expectedRevision,0,'draft must use its original revision, never silently overwrite a newer policy');
requests.at(-1).reject(Object.assign(Error('Changed'),{code:'stale_version'}));await saving;assert(!fields.disabled);assert.equal(input.value,'300');
let reading=reload.onclick();requests.at(-1).resolve(policy(1,10));await reading;assert.equal(input.value,'10');assert(!ui.hasDraft());
input.value='300';input.listeners.input();saving=submit();const original={...requests.at(-1).args};requests.at(-1).reject(Error('Lost response'));await saving;assert(ui.hasDraft());ui.update(policy(2,300));assert.equal(input.value,'300');saving=submit();assert.deepEqual({...requests.at(-1).args},original,'lost response retains exact same save request');requests.at(-1).resolve({...policy(2,300),replayed:true});await saving;assert.equal(saved.length,1);assert(!ui.hasDraft());
ui.update(policy(1,10));assert.equal(input.value,'300','late read cannot restore old policy');
input.value='12.5';input.listeners.input();const count=requests.length;await submit();assert.equal(requests.length,count,'integer seconds validated before request');
input.value='0';input.listeners.input();saving=submit();active=false;requests.at(-1).resolve(policy(3,0));await saving;assert.equal(saved.length,1,'abandoned login cannot announce success');
const html=await fs.readFile(new URL('../web/collaboration.html',import.meta.url),'utf8'),app=await fs.readFile(new URL('../web/office.js',import.meta.url),'utf8'),pkg=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8'));
assert(html.includes('./assets/office-reply-wait.js?'));assert(html.includes('id="officeReplyWaitPolicy"'));assert(app.includes('MindPondOfficeReplyWait?.mount'));assert(app.includes('replyWaitSettings?.update(state.data.replyWaitPolicy)'));assert(pkg.files.includes('web/office-reply-wait.js'));assert(pkg.files.includes('docs/send-and-wait.md'));
console.log('PASS send-wait UI: seconds/five-minute policy, original CAS revision, draft retention, lost-response retry, late polling, input validation, auth fencing and packaged settings entry');

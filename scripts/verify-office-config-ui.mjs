/** Real configuration form callbacks: an async mode switch must not silently
 * download a different identity or discard edits made while loading. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../web/office.js',import.meta.url),'utf8');
class Node{
 constructor(tag,text){this.tagName=tag;this.textContent=text??'';this.children=[];this.dataset={};this.listeners={};this.disabled=false;}
 append(...nodes){for(const n of nodes){n.remove();n.parent=this;this.children.push(n);}}
 remove(){if(this.parent){this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}}
 replaceWith(node){const parent=this.parent,index=parent.children.indexOf(this);node.remove();parent.children[index]=node;node.parent=parent;this.parent=null;}
 addEventListener(type,fn){this.listeners[type]=fn;}
 replaceChildren(...nodes){for(const child of [...this.children])child.remove();this.append(...nodes);}
 setAttribute(name,value){this[name]=value;}
 showModal(){this.open=true;}
 close(){this.open=false;}
 focus(){this.focused=true;}
 select(){this.selected=true;}
 get firstElementChild(){return this.children[0];}
 get isConnected(){return this.root||Boolean(this.parent?.isConnected);}
 querySelector(selector){if(selector==='textarea')return this.all().find(n=>n.tagName==='textarea')??null;const key=selector.slice(6,-1).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return this.all().find(n=>key in n.dataset)??null;}
 all(){return this.children.flatMap(n=>[n,...n.all()]);}
}
const make=(tag,text)=>new Node(tag,text),root=make('div');root.root=true;
const template=mode=>({identityMode:mode,env:'SYNTHETIC_TOKEN',place:'Host settings',text:'Public '+mode+' configuration',warnings:[]});
const state={logged:true,authEpoch:1,data:{settings:{mcpUrl:'https://mindpond.example/mcp'},connectionTemplates:{host:template('connection')},credentialPolicies:{host:{assignmentIds:['seat-a']}},credentialIssuance:true}};
const dialog=make('dialog'),body=make('div'),title=make('h2');dialog.root=true;dialog.append(title,body);
const ids={officeConnectionConfig:dialog,officeConnectionConfigBody:body,officeConnectionConfigTitle:title};
const copies=[],downloads=[],navigator={clipboard:{async writeText(text){copies.push(text);}}};
let requests=[],errors=[];
const context=vm.createContext({state,make,URL,navigator,el:id=>ids[id],refresh:async()=>{},download:(text,filename)=>downloads.push({text,filename}),input(value){const n=make('input');n.value=value;return n;},label(text,control){const n=make('label',text);n.append(control);return n;},
 api(route,args){return new Promise((resolve,reject)=>requests.push({route,args,resolve,reject}));},
 async run(fn,control){control.disabled=true;try{await fn();}catch(error){errors.push(error);}finally{control.disabled=false;}},
 button(text,click){const n=make('button',text);n.click=click;return n;}
});
vm.runInContext(source.slice(source.indexOf('  function clearConnectionConfig('),source.indexOf('  function roleChoices(')),context);
context.connectionDetails({id:'host',state:'pending',revision:1},root);
let detail=root.firstElementChild,mode=detail.all().find(n=>n.tagName==='select'),restriction=detail.querySelector('[data-restrictions]'),issue=detail.querySelector('[data-issue-credential]');
assert.equal(mode.value,'connection');restriction.value='seat-a,seat-b';restriction.listeners.input();
mode.value='native';let loading=mode.listeners.change();assert(issue.disabled,'download cannot race a pending identity switch');requests.at(-1).reject(Error('Synthetic unavailable'));await loading;
assert.equal(mode.value,'connection','failure must restore the displayed active identity');assert.equal(restriction.value,'seat-a,seat-b');assert.equal(issue.disabled,false);assert.equal(errors.length,1);
mode.value='native';loading=mode.listeners.change();restriction.value='seat-a,seat-c';restriction.listeners.input();requests.at(-1).resolve(template('native'));await loading;
detail=root.firstElementChild;assert.equal(detail.all().find(n=>n.tagName==='select').value,'native');assert.equal(detail.querySelector('[data-restrictions]').value,'seat-a,seat-c','edits during the request must survive');assert.equal(detail.dataset.connectionDraft,'true');
mode=detail.all().find(n=>n.tagName==='select');mode.value='connection';loading=mode.listeners.change();requests.at(-1).resolve(template('native'));await loading;assert.equal(mode.value,'native');assert.match(errors.at(-1).message,/身份范围不一致/);
// A policy/host change arriving during the template request cannot unfreeze an old draft.
mode.value='connection';loading=mode.listeners.change();detail.dataset.configurationStale='true';requests.at(-1).resolve(template('connection'));await loading;
assert.equal(root.firstElementChild,detail,'a mode response must not replace a stale policy form');assert.equal(mode.value,'native');assert.equal(detail.querySelector('[data-issue-credential]').disabled,true);assert.match(errors.at(-1).message,/配置已更新/);
// A response from an abandoned login cannot replace a fresh form.
mode.value='connection';loading=mode.listeners.change();state.authEpoch++;detail.remove();const fresh=make('details');root.append(fresh);requests.at(-1).resolve(template('connection'));await loading;assert.equal(root.firstElementChild,fresh);
// A confirmation belongs to the login that opened it, never the next login.
state.logged=true;fresh.remove();context.connectionDetails({id:'host',state:'active',revision:1},root);
detail=root.firstElementChild;issue=detail.querySelector('[data-issue-credential]');let accept;
context.confirmAction=()=>new Promise(resolve=>accept=resolve);
const beforeConfirm=requests.length,signing=issue.click();state.authEpoch++;state.logged=false;accept(true);await signing;
assert.equal(requests.length,beforeConfirm,'logout while confirming must not issue a credential');
// Preview and copy the normal template without a credential request.
state.logged=true;detail.remove();context.connectionDetails({id:'host',host:'codex',state:'pending',revision:1},root);
detail=root.firstElementChild;
const requestCount=requests.length;
await detail.all().find(n=>n.textContent==='查看 / 复制配置模板').click();
assert.equal(requests.length,requestCount);
assert(dialog.open);
const textField=()=>body.querySelector('textarea');
const copy=()=>body.all().find(n=>n.textContent==='复制配置').click();
assert.equal(textField().value,template('connection').text);
assert(textField().readOnly);
await copy();assert.equal(copies.at(-1),template('connection').text);
const oldField=textField();context.clearConnectionConfig();assert.equal(oldField.value,'');assert.equal(body.children.length,0);

// Full config comes from the existing issuance response, then can be copied
// or downloaded without calling the endpoint again. HTTP can select the text.
const credentialButton=detail.querySelector('[data-issue-credential]');
const issuing=credentialButton.click();
assert.equal(requests.at(-1).route,'credential');
const config={token:'fixture',download:{text:'Configuration containing a synthetic credential',filename:'example.toml'}};
requests.at(-1).resolve(config);await issuing;
assert.equal(config.token,'');assert.equal(config.download.text,'');
assert.equal(textField().value,'Configuration containing a synthetic credential');
navigator.clipboard=undefined;
await copy();assert(textField().selected);
await body.all().find(n=>n.textContent==='下载配置').click();
assert.equal(downloads.at(-1).filename,'example.toml');
assert.equal(requests.length,requestCount+1);
context.clearConnectionConfig();

// A late issuance response from a departed login cannot expose a credential.
const late=credentialButton.click();state.authEpoch++;state.logged=false;
const abandoned={token:'abandoned',download:{text:'stale synthetic secret',filename:'stale.toml'}};
requests.at(-1).resolve(abandoned);await late;
assert(!dialog.open);assert.equal(body.children.length,0);assert.equal(abandoned.download.text,'');
console.log('PASS config UI: default connection identity, pending-download exclusion, failed/mismatched-mode rollback, edits retained during loading, stale-policy switch refusal and confirmation/login fencing, template and one-time config copy, manual fallback and secret cleanup');

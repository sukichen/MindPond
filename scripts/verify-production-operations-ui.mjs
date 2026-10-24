/** Actual operations UI: delayed responses, recovery replay and human-only diagnostics. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
class Element{
 constructor(tag,text=''){Object.assign(this,{tagName:tag,textContent:text,children:[],value:'',isConnected:true});}
 append(...items){this.children.push(...items);}prepend(...items){this.children.unshift(...items);}replaceChildren(...items){for(const c of this.children)c.isConnected=false;this.children=items;}
 setAttribute(){}focus(){}reportValidity(){return true;}
}
const elements=Object.fromEntries(['officeOperations','officeOperationsStatus','officeOperationsBody','officeOperationsRefresh','officeDetail'].map(id=>[id,new Element('section')]));
const calls=[],errors=[],downloads=[],notices=[];const state={logged:true,authEpoch:1,appView:'officeOperations',office:{office:{id:'room'},seats:[{id:'seat'}]},data:{characters:{roles:[{id:'role',name:'Synthetic role',state:'active'}],mappings:[{role_id:'role',seat_id:'seat'}]}}};
const run=async fn=>{try{return await fn();}catch(e){errors.push(e);}};
const events={};const context=vm.createContext({window:{addEventListener(name,fn){events[name]=fn;}},document:{hidden:false,createElement:t=>new Element(t),getElementById:id=>elements[id]},setInterval(){return 1;},clearInterval(){},crypto:webcrypto,console});
vm.runInContext(await fs.readFile(new URL('../web/office-operations.js',import.meta.url),'utf8'),context);
const api=(route,input)=>new Promise((resolve,reject)=>calls.push({route,input,resolve,reject}));
const operations=context.window.MindPondOfficeOperations.mount({getState:()=>state,api,run,showDetail(){elements.officeDetail.replaceChildren();},notice:(...v)=>notices.push(v),confirmAction:async()=>true,download:(...v)=>downloads.push(v),openOffice(){},refreshOffice:async()=>{}});
const all=n=>[n,...n.children.flatMap(all)],button=(root,text)=>all(root).find(n=>n.tagName==='button'&&n.textContent===text),tick=()=>new Promise(r=>setImmediate(r));
const snapshot={release:{version:'0.2.0',platform:'test',arch:'test'},schemaVersion:5,integrity:{healthy:true},storage:{databaseBytes:100,walBytes:0,filesystem:{availableBytes:200}},runtime:{memoryBytes:{rss:100},uptimeSeconds:60,failed:0},mcpProcesses:[],backups:[],processing:[],backlog:[],capacity:{},observedAt:1};
let pending=operations.refresh();state.authEpoch++;calls.at(-1).resolve(snapshot);await pending;assert.equal(elements.officeOperationsBody.children.length,0,'responses from a logged-out management session never render');
state.logged=true;pending=operations.refresh();calls.at(-1).resolve(snapshot);await pending;assert(button(elements.officeOperationsBody,'下载脱敏诊断'));await button(elements.officeOperationsBody,'下载脱敏诊断').onclick();assert.equal(downloads.length,1);
const fields=all(elements.officeOperationsBody).filter(n=>n.tagName==='input');fields[0].value='12';fields[1].value='80';fields[0].oninput();pending=operations.refresh();calls.at(-1).resolve(snapshot);await pending;const preserved=all(elements.officeOperationsBody).filter(n=>n.tagName==='input');assert.equal(preserved[0].value,'12');assert.equal(preserved[1].value,'80','automatic status refresh preserves unsaved capacity drafts');
const savedDownload=button(elements.officeOperationsBody,'下载脱敏诊断');operations.reset();state.logged=false;await savedDownload.onclick();assert.equal(downloads.length,1,'stale diagnostics actions cannot download after logout');
state.logged=true;state.appView='officeRooms';pending=operations.recover({id:'message',officeId:'room'});state.office={office:{id:'other'}};calls.at(-1).resolve({message:{id:'message',state:'processing'}});await pending;assert.equal(elements.officeDetail.children.length,0,'room switches fence delayed message recovery');
state.office={office:{id:'room'},seats:[{id:'seat'}]};pending=operations.recover({id:'message',officeId:'room'});calls.at(-1).resolve({message:{id:'message',recipient:'role',recipientName:'Synthetic role',state:'processing',body:'Synthetic work',takenAt:42},recoveryRecipients:[{id:'role',name:'Synthetic role'}]});await pending;
const form=all(elements.officeDetail).find(n=>n.tagName==='form');all(form).find(n=>n.tagName==='textarea').value='User reviewed previous results';
pending=button(form,'中止并重新安排').onclick();await tick();const first=calls.at(-1);assert.equal(first.route,'message/recover');first.reject(Error('Lost response'));await pending;
pending=button(form,'中止并重新安排').onclick();await tick();const replay=calls.at(-1);assert.deepEqual(replay.input,first.input,'lost-response retries keep exact key and payload');replay.resolve({replacementMessageId:'replacement'});await pending;
assert.equal(notices.at(-1)[0],'处理恢复已记录。');assert.equal(errors.length,1);
state.appView='officeOperations';state.office={office:{id:'other'},seats:[]};state.data.characters.roles.push({id:'outsider',name:'Outside role',state:'active'});
pending=operations.recover({id:'message',officeId:'room'});calls.at(-1).resolve({message:{id:'message',recipient:'role',recipientName:'Synthetic role',state:'processing',body:'Synthetic work',takenAt:42},recoveryRecipients:[{id:'role',name:'Synthetic role'}]});await pending;
const targets=all(elements.officeDetail).find(n=>n.tagName==='select');assert.deepEqual(targets.children.map(n=>n.value),['role'],'recovery from another room offers only the source office current members');
state.appView='officeOperations';const old=operations.refresh();const abandoned=calls.at(-1);events.pagehide();const beforeResume=calls.length;events.pageshow({persisted:true});assert.equal(calls.length,beforeResume+1,'BFCache resume must restart synchronization even when a pre-navigation request was pending');const resumed=calls.at(-1);abandoned.resolve(snapshot);await old;resumed.resolve(snapshot);await tick();assert(button(elements.officeOperationsBody,'下载脱敏诊断'));
console.log('PASS operations UI: auth and room response fences, reset/download privacy, recovery provenance, exact lost-response replay and BFCache recovery');

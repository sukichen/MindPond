/** Exercise production directory controls and retained drafts with real UI functions. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../web/office.js',import.meta.url),'utf8');
class Node{
 constructor(tag,text){this.tagName=tag;this.textContent=text??'';this.children=[];this.dataset={};}
 append(...nodes){for(const n of nodes){n.remove?.();n.parent=this;this.children.push(n);}}
 insertBefore(n,before){n.remove?.();n.parent=this;const i=before?this.children.indexOf(before):-1;this.children.splice(i<0?this.children.length:i,0,n);}
 remove(){if(this.parent){const i=this.parent.children.indexOf(this);this.parent.children.splice(i,1);this.parent=null;}}
 querySelector(selector){const attr=selector.slice(6,-1).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());for(const n of this.children){if(attr in n.dataset)return n;const result=n.querySelector(selector);if(result)return result;}return null;}
}
const list=new Node('div'),state={authEpoch:1,directoryThrough:{},directoryLoading:false,data:{agents:[{id:'a',name:'Synthetic host',state:'active',revision:1}],directory:{agents:{loaded:1,total:1,nextCursor:null}},choices:{roles:[{id:'off-page',name:'Off page',state:'active'}]},characters:{roles:[{id:'visible',name:'Visible',state:'active',introduction:'Full description'}]}}};
let reload=async()=>{},details=0;
const make=(tag,text)=>new Node(tag,text),context=vm.createContext({state,make,el:()=>list,hostNames:{},Map,Set,JSON,Date,
 button:(text,click)=>Object.assign(make('button',text),{click}),refresh:()=>reload(),
 connectionDetails(_a,card){details++;const input=make('input');input.value='original';input.dataset.draft='';const issue=make('button');issue.dataset.issueCredential='';card.append(input,issue);}
});
vm.runInContext(source.slice(source.indexOf('  function roleChoices('),source.indexOf('  async function refresh('))+source.slice(source.indexOf('  function agentStatus('),source.indexOf('  function renderDiagnostics(')),context);
assert.equal(context.roleChoices()[0].id,'off-page','complete selector references do not depend on loaded cards');
context.renderAgents();const card=list.children[0],draft=card.querySelector('[data-draft]');draft.value='unsaved restrictions';
state.data.agents[0]={...state.data.agents[0],last_seen:Date.now(),discovered_at:Date.now()};context.renderAgents();
assert.equal(list.children[0],card,'communication observations must reuse the card');assert.equal(draft.value,'unsaved restrictions');assert.equal(details,1,'polling must not recreate connection forms');assert.equal(card.querySelector('[data-agent]').textContent,'已观测工具发现');
draft.dataset.connectionDraft='true';state.data.agents[0]={...state.data.agents[0],state:'disabled',revision:2};context.renderAgents();assert.equal(list.children[0],card);assert.equal(draft.value,'unsaved restrictions');assert.equal(card.querySelector('[data-agent]').textContent,'接入已停用');assert.equal(card.querySelector('[data-issue-credential]').disabled,true,'a changed policy must block stale signing while retaining edits');assert(card.querySelector('[data-configuration-warning]'));
assert.equal(context.agentStatus({state:'disabled',discovered_at:Date.now()}),'接入已停用','historical discovery cannot imply usable access');
vm.runInContext(source.slice(source.indexOf('  function roleConnectionLabel('),source.indexOf('  let roleConnectionGeneration=')),context);assert.match(context.roleConnectionLabel({connection:{name:'Fixture',host:'codex',hostState:'active',chat:null}}),/聊天标识未记录/,'missing chat evidence cannot be labeled connection-shared');
assert.equal(context.agentStatus({state:'active',last_seen:1}),'已观测连接握手','a handshake never claims that the host is online');
const footer=make('div');context.directoryFooter(footer,'roles',{loaded:50,total:525,nextCursor:'role-0099'},'角色');assert.match(footer.children[0].children[0].textContent,/50 \/ 共 525/);
reload=async()=>{assert.equal(state.directoryThrough.roles,'role-0099');};await footer.children[0].children[1].click();assert.equal(state.directoryLoading,false);
reload=async()=>{throw Error('Synthetic offline');};const failed=make('div');context.directoryFooter(failed,'roles',{loaded:100,total:525,nextCursor:'role-0149'});await assert.rejects(failed.children[0].children[1].click(),/offline/);assert.equal(state.directoryThrough.roles,'role-0099','failed loading keeps the previous window');
let reject;reload=()=>new Promise((_,r)=>reject=r);const pending=failed.children[0].children[1].click();state.authEpoch++;state.directoryThrough={roles:'new-login'};state.directoryLoading=true;reject(Error('Abandoned'));await assert.rejects(pending,/Abandoned/);assert.equal(state.directoryThrough.roles,'new-login');assert.equal(state.directoryLoading,true,'abandoned request cannot release another login’s load guard');
// Missing or mismatched snapshots must never invent empty selectors/configs.
const previous={choices:{roles:[{id:'retained'}]},choicesRevision:'abc',connectionTemplates:{a:{text:'configuration'}},connectionTemplatesRevision:'def'};
const lean={choices:{unchanged:true},choicesRevision:'abc',connectionTemplates:{unchanged:true},connectionTemplatesRevision:'def'};
context.restoreProjections(lean,previous);assert.equal(lean.choices,previous.choices);assert.equal(lean.connectionTemplates,previous.connectionTemplates);
assert.throws(()=>context.restoreProjections({choices:{unchanged:true},choicesRevision:'different'},previous),/页面缓存/);
assert.throws(()=>context.restoreProjections({choices:{unchanged:true},choicesRevision:'abc'},null),/页面缓存/,'a different login cannot reuse missing state');
assert.throws(()=>context.restoreProjections({choices:{unchanged:true}},{choices:{roles:[]}}),/页面缓存/,'unchanged without a version is invalid');
const namedUnchanged={connectionTemplates:{unchanged:{text:'valid host named unchanged'}}};assert.equal(context.restoreProjections(namedUnchanged,null),namedUnchanged,'host IDs cannot collide with the unchanged marker');
// The room form promises that a blank seat label uses the selected role name,
// including roles whose rich cards have not been loaded.
let saveRoom,savedRoom;const stopSave=Error('Stop after recording payload');
context.submit=(_name,fn)=>saveRoom=fn;
context.el=id=>id==='officeSeatRows'?{children:[{dataset:{id:'new-seat'},querySelector(selector){return {value:selector==='[name=roleId]'?'off-page':selector==='[name=role]'?'member':''};}}]}:list;
context.uuid=()=> 'fixture';context.api=async(route,input)=>{savedRoom=input;throw stopSave;};
vm.runInContext(source.slice(source.indexOf("  submit('officeRoomForm',"),source.indexOf("  el('officeAddSeat')")),context);
await assert.rejects(saveRoom({get:()=>null}),error=>error===stopSave);
assert.equal(savedRoom.seats[0].label,'Off page','unloaded role cards must not produce empty seat labels');
vm.runInContext(source.slice(source.indexOf('  function seatName('),source.indexOf('  function fileCondition(')),context);
assert.equal(context.seatName('off-page'),'Off page','message/event labels use complete references');
console.log('PASS directory UI: full choices, accurate loaded/total, progressive loading, failed-page rollback, auth fences and heartbeat draft retention without claiming host liveness');

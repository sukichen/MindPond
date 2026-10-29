/** Exercise real UI request handlers with controlled response ordering. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile(new URL('../web/office.js', import.meta.url), 'utf8');
function handler(name, next) {
  const start = source.indexOf(`  async function ${name}(`);
  const end = source.indexOf(`  ${next}`, start + 1);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}
const state = { logged: true, generation: 0, loading: false, opening: false, office: null, scene: {} };
let fetcher, detail;
let timer, renderedCharacters;
const context = vm.createContext({
  state,
  replayController:{active:false,close(){}},
  scenePlayer: {reset() {},present() {}},
  api: (...args) => fetcher(...args),
  el: () => ({ scrollIntoView() {} }),
  renderOffice() {},
  renderFacilities() {},
  renderRoomChoices() {},
  showAppView() {}, setRoomTab() {},
  async closeOfficeDetail() {},
  requestAnimationFrame() {},
  fitScene() {},
  animate() {},
  document: { hidden: false },
  setTimeout(fn) { timer = fn; return 1; },
  clearTimeout() { timer = null; },
  renderCharacters(data) { renderedCharacters = data; },
  refreshSeatChoices() {},
  renderAgents() {},
  renderProjects() {},
  async clearDeletedRoom() {state.generation++;state.office=null;},
  notice() {},
  window: { matchMedia: () => ({ matches: true }) },
  showDetail: (title, value) => {
    detail = { title, value };
  }
});
vm.runInContext(
  [
    source.slice(source.indexOf('  function restoreProjections('),source.indexOf('  async function refresh(')),
    handler('openOffice', 'function seatName'),
    handler('updateOffice', 'function schedule'),
    handler('moreContainers', 'function renderFacilities'),
    source.slice(source.indexOf('  function schedule('),source.indexOf('  function submit(')),
    handler('showRecord', 'async function more'),
    source.slice(
      source.indexOf('  function mergeRecords('),
      source.indexOf('  function renderEvents(')
    )
  ].join('\n'),
  context
);
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function page(id, extra = {}) {
  return {
    office: { id },
    items: [],
    materials: [],
    events: [],
    nextCursor: 0,
    hasMore: false,
    ...extra
  };
}
// Open A then B: a late A response must never replace B.
const a = deferred(),
  b = deferred();
fetcher = (_, body) => (body.officeId === 'a' ? a.promise : b.promise);
const openingA = context.openOffice('a'),
  openingB = context.openOffice('b');
b.resolve(page('b'));
await openingB;
a.resolve(page('a'));
await openingA;
assert.equal(state.office.office.id, 'b');
// Polling an old room must not leak its events into the newly selected room.
const oldPoll = deferred();
fetcher = (_, body) => (body.officeId === 'b' ? oldPoll.promise : Promise.resolve(page('c')));
const polling = context.updateOffice();
await context.openOffice('c');
oldPoll.resolve(page('b', { events: [{ seq: 999 }], nextCursor: 999 }));
await polling;
assert.equal(state.office.office.id, 'c');
assert.equal(state.cursor, 0);
assert.equal(state.events.length, 0);
// A loaded record beyond the initial page is included in refresh requests.
state.office.items = [{ id: 'later', revision: 1, status: 'open' }];
state.office.materials = [{ id: 'text', state: 'draft' }];
fetcher = async (_, body) => {
  assert.deepEqual(Array.from(body.itemIds), ['later']);
  assert.deepEqual(Array.from(body.materialIds), ['text']);
  return page('c', {
    items: [{ id: 'later', revision: 2, status: 'completed' }],
    materials: [{ id: 'text', state: 'published' }]
  });
};
await context.updateOffice();
assert.equal(state.office.items[0].status, 'completed');
assert.equal(state.office.materials[0].state, 'published');
const merged = context.mergeRecords(
  [{ id: 'task', revision: 3, status: 'completed' }],
  [{ id: 'task', revision: 2, status: 'submitted' }]
);
assert.equal(merged[0].status, 'completed');
// Non-advancing pagination is rejected, instead of generating an infinite HTTP loop.
let calls = 0;
fetcher = async () => {
  calls++;
  return { offset: 0, content: 'abcdefgh', nextOffset: 8, sha256: 'same' };
};
await assert.rejects(context.showRecord({ roundId: 'round' }, 'Evidence'), /分页未前进/);
assert.equal(calls, 2);
// Well-formed pagination still reads the complete record.
const text = JSON.stringify({ result: 'evidence'.repeat(1600) });
fetcher = async (_, body) => ({
  offset: body.offset,
  content: text.slice(body.offset, body.offset + 8000),
  nextOffset: body.offset + 8000 < text.length ? body.offset + 8000 : null,
  sha256: 'stable'
});
await context.showRecord({ roundId: 'round' }, 'Evidence');
assert.equal(detail.value.result, 'evidence'.repeat(1600));
// Logout invalidates requests already in flight.
const late = deferred();
fetcher = () => late.promise;
const request = context.updateOffice();
state.generation++;
state.logged = false;
state.office = null;
late.resolve(page('c'));
await request;
assert.equal(state.office, null);
// One poll must BOTH advance the role cursor and render new applications.
state.logged = true; state.authEpoch = 0;
state.data = { characters: { revision: 1, pending: [] } };
context.el = () => ({ querySelectorAll: () => [] });
context.updateOffice = async () => {};
fetcher = async () => ({ agents: [], characters: { revision: 2, pending: [{ id: 'new' }] } });
context.schedule(); await timer();
assert.equal(renderedCharacters?.pending[0]?.id, 'new', 'poll must render newly arrived applications');
// Directory changes continue during editing; a separate draft must remain untouched.
state.roleDraft = {id: 'draft-role', name: 'unsaved'};
const draft = state.roleDraft;
const editPoll = deferred(); fetcher = () => editPoll.promise;
context.schedule(); const editing = timer(); state.roleEditing = true;
editPoll.resolve({ agents: [], characters: { revision: 3, pending: [] } });
await editing;
assert.equal(state.data.characters.revision, 3, 'new applications are visible even with an open draft');
assert.equal(state.roleDraft, draft, 'polling must not replace the separate editor draft');
state.roleEditing = false;
fetcher = async () => ({ agents: [], characters: { unchanged: true, revision: 3 } });
context.schedule(); await timer();
assert.equal(state.data.characters.pending.length, 0, 'unchanged snapshots preserve the latest directory');
// Logout invalidates the registry poll as well as the selected-office poll.
const lateRegistry = deferred(); fetcher = () => lateRegistry.promise;
context.schedule(); const pendingRegistry = timer();
state.authEpoch++; state.logged = false; state.data = null; timer = null;
lateRegistry.resolve({ agents: [], characters: { revision: 99, pending: [] } });
await pendingRegistry;
assert.equal(state.data, null);
assert.equal(timer, null, 'an expired poll cannot restart a timer after logout');
// Another browser deleting the selected room clears its stale cached view.
state.logged=true;state.office={office:{id:'removed-elsewhere'}};
state.data={characters:{revision:3}};
fetcher=async()=>({agents:[],offices:[],selectedOffice:{id:'removed-elsewhere',exists:false},characters:{unchanged:true,revision:3}});
context.schedule();await timer();assert.equal(state.office,null);
state.office={office:{id:'off-page'},items:[],materials:[]};fetcher=async(route)=>route==='state'?{agents:[],offices:[],selectedOffice:{id:'off-page',exists:true},characters:{unchanged:true,revision:3}}:page('off-page');context.schedule();await timer();assert.equal(state.office.office.id,'off-page','an off-page office must never be treated as deleted');
// Fit-to-all must include all desks on a narrow screen, not clamp at 20% and clip them.
const sceneState = {scene: {scale: 1, x: 0, y: 0, autoFit: true}};
const elements = {
  officeStage: {clientWidth: 264, clientHeight: 370},
  officeScene: {offsetWidth: 1872, offsetHeight: 1200, style: {}},
  officeSceneZoomValue: {}, officeSceneZoomOut: {}, officeSceneZoomIn: {}
};
const sceneContext = vm.createContext({state: sceneState, el: id => elements[id], Math});
vm.runInContext(source.slice(source.indexOf('  function applyScene('), source.indexOf('  // Application navigation')), sceneContext);
sceneContext.fitScene();
const fitted = sceneState.scene;
assert(fitted.scale < .2, 'mobile fit permits smaller than 20%');
assert(fitted.x >= 0 && fitted.y >= 0);
assert(fitted.x + 1872 * fitted.scale <= 264);
assert(fitted.y + 1200 * fitted.scale <= 370);
// Zoom about the pointer must keep its world coordinate stationary.
const point = {x: 100, y: 150};
const worldX = (point.x - fitted.x) / fitted.scale;
const worldY = (point.y - fitted.y) / fitted.scale;
sceneContext.zoomScene(1.2, point);
assert(Math.abs((point.x - fitted.x) / fitted.scale - worldX) < 1e-8);
assert(Math.abs((point.y - fitted.y) / fitted.scale - worldY) < 1e-8);
assert.equal(fitted.autoFit, false, 'user navigation must survive subsequent polls');
sceneContext.zoomScene(99);assert.equal(fitted.scale, 2);
sceneContext.zoomScene(.001);assert.equal(fitted.scale, .1);
const previous = {...fitted};elements.officeStage.clientWidth = 0;
sceneContext.fitScene();assert.deepEqual(fitted, previous, 'hidden scenes must not reset the viewport');
console.log(
  'PASS office UI: reversed opens, room-switch polling, loaded-page refresh, bounded detail pagination, logout fencing, draft isolation and mobile viewport geometry'
);

// Destructive actions have their own confirmation and cannot wipe a different
// room opened while the delete request was in flight.
const deletionState={logged:true,authEpoch:0,generation:1,roleDraft:{id:'role',dirty:true},office:{office:{id:'a'}},events:[1],cursor:9};
const view={hidden:false};let confirmed=false,deletionCalls=[],refreshes=0,closed=false;
const deletionContext=vm.createContext({state:deletionState,replayController:{close(){}},scenePlayer:{reset(){}},
  confirmAction:async()=>confirmed,
  api:async(route,body)=>{deletionCalls.push({route,body});},
  el:id=>id==='officeView'?view:id==='officeRoleInspectorBody'?{querySelectorAll:()=>[]}: {disabled:false},
  closeRoleInspector:async()=>{closed=true;deletionState.roleDraft=null;},
  refresh:async()=>{refreshes++;},updateOffice:async()=>{},closeOfficeDetail:async()=>{},setExpanded:()=>{},notice:()=>{}
});
vm.runInContext(source.slice(source.indexOf('  async function deleteCharacter('),source.indexOf('  async function closeRoleInspector(')),deletionContext);
await deletionContext.deleteCharacter({id:'role',name:'角色',revision:2});
await deletionContext.deleteRoom({id:'a',title:'A',revision:3});
assert.equal(deletionCalls.length,0,'cancelling either confirmation sends no deletion request');
confirmed=true;
deletionContext.api=async()=>{throw Error('stale_version');};
await assert.rejects(deletionContext.deleteCharacter({id:'role',name:'角色',revision:2}));
assert.equal(closed,false);assert.equal(deletionState.roleDraft.saving,false);
deletionContext.api=async(route,body)=>{deletionCalls.push({route,body});};
await deletionContext.deleteCharacter({id:'role',name:'角色',revision:2});
assert.equal(closed,true);assert.equal(deletionCalls[0].route,'role/delete');
assert.equal(deletionCalls[0].body.expectedRevision,2);assert.equal(refreshes,1);
await deletionContext.deleteRoom({id:'a',title:'A',revision:3});
assert.equal(deletionState.office,null);assert.equal(view.hidden,true);assert.equal(deletionState.generation,2);
assert.equal(deletionState.events.length,0);assert.equal(deletionState.cursor,0);
const deleting=deferred();deletionState.office={office:{id:'a'}};
deletionContext.api=()=>deleting.promise;
const pendingDelete=deletionContext.deleteRoom({id:'a',title:'A',revision:3});
await Promise.resolve();deletionState.office={office:{id:'b'}};const roomGeneration=deletionState.generation;
deleting.resolve({deleted:true});await pendingDelete;
assert.equal(deletionState.office.office.id,'b');assert.equal(deletionState.generation,roomGeneration);
console.log('PASS deletion UI: cancellation, stale version retains draft, confirmed deletion clears only its own room and fences old polls');

// Archived rooms can be deleted straight from the directory, without loading their historical view.
const makeNode=(tag,text)=>({tag,text,children:[],append(...nodes){this.children.push(...nodes);},replaceChildren(){this.children=[];},setAttribute(k,v){this[k]=v;}});
const roomList=makeNode('div'),roomCounter={};let deletedFromList;
const directoryContext=vm.createContext({state:{data:{offices:[{id:'archived',title:'旧办公室',state:'cancelled',revision:7},{id:'completed',title:'已结束办公室',state:'completed',revision:3},{id:'active',title:'开放办公室',state:'active'}]},roomQuery:'',office:null},
  make:makeNode,el:id=>id==='officeRoomList'?roomList:roomCounter,officeStates:{},openOffice(){throw Error('directory deletion must not load a room');},
  button:(text,click)=>({...makeNode('button',text),click}),directoryFooter(){},deleteRoom:record=>{deletedFromList=record;}});
vm.runInContext(source.slice(source.indexOf('  function renderRoomChoices('),source.indexOf('  function refreshSeatChoices(')),directoryContext);
directoryContext.renderRoomChoices();assert.equal(roomList.children.length,3);
for(const [i,revision] of [[0,7],[1,3]]){const remove=roomList.children[i].children[1];assert.equal(remove.text,'删除');await remove.click();assert.equal(deletedFromList.revision,revision);}
assert.equal(roomList.children[2].children.length,1,'active rooms retain their management-menu confirmation flow');
console.log('PASS archived directory: direct deletion for cancelled/completed rooms without opening the historical view');
// App routes retain the existing DOM drafts and pause playback when its view is hidden.
const routePanels=['officeRooms','officeCharacters','officeProjects','officeAgents','officeSetup'].map(id=>({dataset:{appView:id},hidden:false}));
const routeLinks=routePanels.map(p=>({dataset:{appRoute:p.dataset.appView},attrs:{},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];}}));
const roomPanels=['officeCanvas','officeMaterialPanel','officeTaskPanel','officeMessagePanel','officeTimelinePanel'].map(id=>({id,hidden:false}));
const roomTabs=roomPanels.map(p=>({dataset:{roomTab:p.id},attrs:{},setAttribute(k,v){this.attrs[k]=v;},focus(){this.focused=true;}}));
const routeElements={officePageTitle:{},officeWorkspaceEmpty:{}};
let pauseCount=0,stopCount=0;const historyEntries=[];
const routeState={appView:'officeRooms',roomTab:'officeCanvas',office:{},scene:{autoFit:true}};
const routeContext=vm.createContext({state:routeState,el:id=>routeElements[id],document:{querySelectorAll:s=>s==='[data-app-view]'?routePanels:s==='[data-app-route]'?routeLinks:s==='[data-room-tab]'?roomTabs:roomPanels},
 replayController:{pause(){pauseCount++;}},scenePlayer:{stop(){stopCount++;},setActive(on){assert.equal(on,false);stopCount++;}},requestAnimationFrame(){},location:{hash:'#officeRooms'},history:{pushState(_a,_b,hash){historyEntries.push(hash);}},Object});
vm.runInContext(source.slice(source.indexOf('  const appViews ='),source.indexOf("  document.querySelector('.office-sidebar nav')")),routeContext);
routeContext.showAppView('officeCharacters');assert.equal(routePanels.filter(p=>!p.hidden)[0].dataset.appView,'officeCharacters');assert.equal(routeLinks[1].attrs['aria-current'],'page');assert.equal(pauseCount,1);assert.equal(stopCount,1);
routeContext.setRoomTab('officeMaterialPanel',true);assert.deepEqual(roomPanels.filter(p=>!p.hidden).map(p=>p.id),['officeMaterialPanel']);assert.equal(roomTabs[1].tabIndex,0);assert(roomTabs[1].focused);
routeContext.setRoomTab('missing');assert.equal(routeState.roomTab,'officeMaterialPanel');
routeContext.syncAppRoute();assert.equal(routeState.appView,'officeRooms');assert.equal(historyEntries.length,1,'history restore cannot push another entry');
routeContext.showAppView('__proto__');assert.equal(routeState.appView,'officeRooms');assert.equal(routeElements.officeWorkspaceEmpty.hidden,true);
console.log('PASS application shell: isolated destinations, selected navigation, keyboard-ready room tabs, hidden-view playback pause and browser history restoration');

routeState.opening=true;routeState.generation=5;routeContext.showAppView('officeCharacters');assert.equal(routeState.generation,6);assert.equal(routeState.opening,false,'leaving the workspace fences an unfinished open request');
// Login derives cookie scope from the actual browser mount, rather than assuming /.
let loginHandler,loginBody;
const loginLocation={href:'http://localhost:3000/mindpond/collaboration#officeSetup'};
const loginContext=vm.createContext({URL,location:loginLocation,submit(_id,fn){loginHandler=fn;},api:async(_route,body)=>{loginBody=body;},el:()=>({reset(){}}),refresh:async()=>{},notice(){},schedule(){}});
vm.runInContext(source.slice(source.indexOf("  submit('officeLogin'"),source.indexOf("  submit('officeEndpoint'")),loginContext);
await loginHandler(new Map([['operatorKey','']]));assert.equal(loginBody.cookiePath,'/mindpond/api/office-admin');
loginLocation.href='http://127.0.0.1:7903/collaboration';await loginHandler(new Map());assert.equal(loginBody.cookiePath,'/api/office-admin');
console.log('PASS login UI: prefixed proxy and direct-root cookie scopes follow the page URL');


// Refresh real rendering functions: open messages survive unrelated/new activity.
class MailNode {
  constructor(tag,text){this.tag=tag;this.textContent=text??'';this.children=[];this.dataset={};this.open=false;this.parent=null;}
  append(...nodes){for(const n of nodes)this.insertBefore(n,null);}
  insertBefore(node,reference){if(node===reference)return;node.remove();const index=reference?this.children.indexOf(reference):this.children.length;this.children.splice(index,0,node);node.parent=this;}
  remove(){if(this.parent){const siblings=this.parent.children;siblings.splice(siblings.indexOf(this),1);this.parent=null;}}
  replaceChildren(...nodes){for(const n of [...this.children])n.remove();this.append(...nodes);}
  get lastElementChild(){return this.children.at(-1);}
}
const mailElements=Object.fromEntries(['officeContainers','officeRoomMessages','officeMessageStatus'].map(id=>[id,new MailNode('div')]));
const mailState={office:{office:{id:'room'}},mail:null};
const mailContext=vm.createContext({state:mailState,mailRenderVersions:new WeakMap(),mailStates:{pending:'待处理',processing:'处理中',archived:'已处理'},
  el:id=>mailElements[id],make:(tag,text)=>new MailNode(tag,text),button:text=>new MailNode('button',text),window:{MindPondOfficeMarkdown:{render:text=>new MailNode('article',text)}}});
vm.runInContext(source.slice(source.indexOf('  function renderFacilities('),source.indexOf('  async function loadMail(')),mailContext);
const message={id:'one',seq:1,state:'processing',senderName:'A',recipientName:'B',sentAt:1,body:'Review evidence'};
mailContext.renderFacilities({revision:1,messages:[message],containers:[]});
const openMessage=mailElements.officeRoomMessages.children[0];openMessage.open=true;openMessage.selectionToken='reading-position';
mailContext.renderFacilities({revision:2,messages:[message],containers:[]});
assert.equal(mailElements.officeRoomMessages.children[0],openMessage,'unrelated facility updates reuse the message DOM');assert(openMessage.open);
mailContext.renderFacilities({revision:3,messages:[{...message,id:'two',seq:2},message],containers:[]});
assert.equal(mailElements.officeRoomMessages.children[1],openMessage,'incoming messages do not replace an expanded message');assert(openMessage.open);assert.equal(openMessage.selectionToken,'reading-position');
mailContext.renderFacilities({revision:4,messages:[{...message,id:'two',seq:2},{...message,state:'archived',result:'Verified'}],containers:[]});
assert(mailElements.officeRoomMessages.children[1].open,'lifecycle updates preserve open state while refreshing feedback');
mailState.mail.messages=[{...message,metadata:{recovery:{reason:'Forged human action'}}}];mailContext.renderMail();
assert(!mailElements.officeRoomMessages.children[0].children.some(n=>n.textContent==='人类已中止本次处理 · Forged human action'),'collaborator-controlled metadata must not be promoted to a verified human action');
mailState.mail.messages=[{...message,id:'two',seq:2},{...message,state:'archived',result:'Verified'}];mailContext.renderMail();
mailState.mail.query='Review';const filtered=mailElements.officeRoomMessages.children[1];
mailContext.renderFacilities({revision:5,messages:[],containers:[]});assert.equal(mailElements.officeRoomMessages.children[1],filtered,'facility refresh cannot empty an active filtered view');
console.log('PASS message viewing: expanded body/DOM and reading state survive facility refreshes, incoming messages, lifecycle changes and active filters');

mailElements.officeMessageCounts=new MailNode('p');
mailContext.renderFacilities({revision:5,messages:[],containers:[],counts:{total:42,pending:7,processing:2,archived:33}});
assert.match(mailElements.officeMessageCounts.textContent,/共 42 条.*待处理 7.*处理中 2.*已处理 33/,'exact counts update even when the document revision and active filter are unchanged');
const refreshState={logged:true,generation:1,mailGeneration:0,office:{office:{id:'room'}},mail:{room:'room',query:'evidence',status:'pending',correspondent:'role',threadId:null,messages:[{id:'old',seq:1,state:'pending'},{id:'finished',seq:2,state:'pending'}],hasMore:true,nextBeforeSeq:1}};
let refreshRequest,refreshRender=0;
const refreshContext=vm.createContext({state:refreshState,Date,Map,el:()=>{throw Error('Background refresh must use applied filters, not unsaved form inputs');},renderMail(){refreshRender++;},api:async(route,body)=>{refreshRequest={route,body};return {messages:[{id:'new',seq:4,state:'pending'}],knownMessages:[{id:'old',state:'pending',matches:1},{id:'finished',state:'archived',matches:0}],hasMore:false,nextBeforeSeq:4};}});
vm.runInContext(source.slice(source.indexOf('  async function loadMail('),source.indexOf("  el('officeMessageSearch')")),refreshContext);
await refreshContext.loadMail({refresh:true});
assert.equal(refreshRequest.body.query,'evidence');assert.equal(refreshRequest.body.correspondent,'role');assert.equal(refreshRequest.body.state,'pending');
assert.deepEqual([...refreshRequest.body.knownIds],['old','finished']);
assert.deepEqual([...refreshState.mail.messages].map(m=>m.id),['new','old'],'incoming matches join the current window, older loaded messages remain, and completed messages leave the pending filter');
assert(refreshState.mail.hasMore);assert.equal(refreshRender,1);assert.equal(refreshState.mailLoading,false);
console.log('PASS live counts and filtered sync: totals are independent of loaded pages, applied filters survive edits, new arrivals appear and older reading context remains');

// Exercise the actual scene layout and ResizeObserver callback: a multi-person
// room must choose columns again after its available panel width changes.
const layoutElements={officeStage:{clientWidth:1300,clientHeight:700},officeDesks:{style:{},querySelectorAll:()=>Array.from({length:6},()=>({offsetHeight:520}))},officeScene:{style:{}}};
let layoutStops=0,resizeCallback,fitCalls=0;
const layoutContext=vm.createContext({Math,meetingScene:{width:n=>n,sync(){}},state:{scene:{autoFit:true}},replayController:{active:false},stage:layoutElements.officeStage,el:id=>layoutElements[id],scenePlayer:{stop(){layoutStops++;},startIdle(){}},ResizeObserver:class{constructor(fn){resizeCallback=fn;}observe(){}},requestAnimationFrame:fn=>fn(),fitScene(){fitCalls++;}});
vm.runInContext(source.slice(source.indexOf('  function layoutScene('),source.indexOf('  function applyScene(')),layoutContext);
vm.runInContext(source.split('\n').find(line=>line.includes('new ResizeObserver(')),layoutContext);
layoutContext.layoutScene(6);const wideColumns=layoutElements.officeDesks.style.gridTemplateColumns;
layoutElements.officeStage.clientWidth=320;resizeCallback();assert.notEqual(layoutElements.officeDesks.style.gridTemplateColumns,wideColumns);assert(Number(layoutElements.officeDesks.style.gridTemplateColumns.match(/repeat\((\d+)/)[1])<Number(wideColumns.match(/repeat\((\d+)/)[1]),'a narrower viewport must choose fewer columns');assert.equal(fitCalls,1);
const previousStops=layoutStops;resizeCallback();assert.equal(layoutStops,previousStops,'unchanged columns must not interrupt an animation');
layoutContext.state.scene.autoFit=false;resizeCallback();assert.equal(fitCalls,2,'manual camera must not be reset by a viewport resize');
layoutContext.state.scene.autoFit=true;layoutContext.replayController.active=true;layoutElements.officeStage.clientWidth=1500;const replayColumns=layoutElements.officeDesks.style.gridTemplateColumns;resizeCallback();assert.equal(layoutElements.officeDesks.style.gridTemplateColumns,replayColumns,'resizing must not rearrange historical seats or cancel replay');assert.equal(layoutStops,previousStops);
layoutContext.layoutScene(1);assert.equal(layoutElements.officeScene.style.width,'412px');
console.log('PASS responsive scene: resize recomputes multi-person columns, stable layouts preserve animations and manual camera remains under user control');

// Exercise the shipped container paginator with newer meeting snapshots in flight.
const containerState={logged:true,generation:1,office:page('office',{facilities:{revision:1,containers:[{id:'one'}],nextAfterId:'one',meetings:[{id:'first'}],counts:{total:1}}})};
let containerRequest,containerRenders=0;
const containerContext=vm.createContext({state:containerState,api:()=>containerRequest.promise,renderFacilities(){containerRenders++;}});
vm.runInContext(handler('moreContainers','function renderFacilities'),containerContext);
containerRequest=deferred();const starting=containerState.office.facilities,pendingPage=containerContext.moreContainers(starting);
const latestMeetings=[{id:'first'},{id:'second'}];containerState.office.facilities={...starting,meetings:latestMeetings,counts:{total:2}};
containerRequest.resolve({containers:[{id:'two'}],hasMore:false,nextAfterId:'two'});await pendingPage;
assert.equal(containerState.office.facilities.meetings,latestMeetings,'late paging must preserve every currently open meeting');assert.equal(containerState.office.facilities.counts.total,2);
assert.deepEqual([...containerState.office.facilities.containers].map(r=>r.id),['one','two']);assert.equal(containerRenders,1);
containerRequest=deferred();const beforeChange=containerState.office.facilities,obsoletePage=containerContext.moreContainers(beforeChange);
containerState.office.facilities={...beforeChange,revision:2,meetings:[{id:'second'}]};const afterChange=containerState.office.facilities;
containerRequest.resolve({containers:[{id:'obsolete'}],hasMore:false,nextAfterId:'obsolete'});await obsoletePage;assert.equal(containerState.office.facilities,afterChange,'a changed facility revision invalidates the container continuation');
containerRequest=deferred();const oldVisit=containerContext.moreContainers(afterChange);containerState.generation++;
containerRequest.resolve({containers:[],hasMore:false});await oldVisit;assert.equal(containerState.office.facilities,afterChange,'returning to the same office does not revive a request from another visit');
assert.equal(containerRenders,1);
console.log('PASS delayed container pages preserve live meetings/counts and reject stale revisions or office visits');

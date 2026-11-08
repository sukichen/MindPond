import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

class Element {
  constructor(tag) { Object.assign(this,{tag,children:[],dataset:{},hidden:false,value:''}); }
  append(...children){ this.children.push(...children); }
  replaceChildren(...children){ this.children=children; }
  setAttribute() {}
  after(child){ this.append(child); }
}
const all=el=>[el,...el.children.flatMap(all)];
const roots={officeView:new Element('main'),officeTabScene:new Element('button')};
const window={MindPondOfficeMarkdown:{render:text=>Object.assign(new Element('p'),{textContent:text})}};
const queue={id:'task',title:'离线验收',ownerId:'role',status:'review',revision:3,revisionsRequested:0,summary:'已交付',
  lastReportedAt:1794000000000,needsAttention:false,reviewSuggested:false,
  checks:[{criterion:'依赖已校验',status:'verified',hasEvidence:true,conclusion:'pass',observed:'缓存完整',evidenceVersion:'candidate-a'}]};
const task={...queue,goal:'离线验收',acceptance:'校验依赖',guidance:{},rooms:[],outcomes:[],
  progress:{note:'已完成第一轮取证',reportedAt:queue.lastReportedAt,materialId:'evidence'},
  evidenceIndex:{arguments:{action:'evidence_index',taskId:'task'}}};
let riskReview=null;
const calls=[];
const api=async (path,args)=>{
  calls.push({path,args});
  if(path==='guided-tasks/usage')return {
    billable:{reportedMicrousd:null,estimatedMicrousd:100,missingCostEntries:0},
    task:{recordedChanges:2,assignmentToClaimMs:null,claimToSubmissionMs:700,submissionToReviewMs:null},
    entries:[{model:'DeepSeek',phase:'work',meter:'local',inputTokens:100,outputTokens:3}]
  };
  if(path==='guided-tasks/settings'){riskReview=args.riskReview;return {};}
  if(args.action==='review_packet')return {
    submissionId:'submission',checkCount:1,requiredCount:1,pendingCount:1,missingCheckIds:[],missingDelivery:false,
    targetVersion:'candidate-a',nextCheckOffset:null,checks:queue.risk.checks
  };
  if(args.action==='get')return {task};
  if(args.action==='evidence_index')return {evidence:[{title:'另一专业的取证',version:'candidate-a',reportedBy:'role',materialId:'peer'}]};
  return {tasks:[queue],reviewMode:'exceptions',policyRevision:1,supervisorId:'role',nextAfterId:null,riskReview};
};
vm.runInNewContext(await fs.readFile(new URL('../web/office-guided-tasks.js',import.meta.url),'utf8'),{
  window,crypto:webcrypto,document:{createElement:tag=>new Element(tag),getElementById:id=>roots[id]}
});
const fixture={office:{office:{id:'office',state:'active'},seats:[{enabled:true}]},logged:true,generation:1,authEpoch:1};
const app=window.MindPondOfficeGuidedTasks.mount({getState:()=>fixture,api,run:callback=>callback(),setRoomTab:()=>{},
  notice:()=>{},memberForSeat:()=>({id:'role',state:'active',name:'主管'}),confirmAction:()=>true,
  showMaterial:(id)=>calls.push({materialId:id})});
const find=text=>all(roots.officeView).find(el=>el.textContent===text);
await app.refresh({force:true});
const panel=roots.officeView.children[0];
panel.hidden=false;
const filter=all(panel).find(el=>el.tag==='select');
filter.value='attention';
filter.onchange();
await new Promise(resolve=>setImmediate(resolve));
assert.equal(calls.at(-1).args.action,'review_queue');
assert(find('已交付 · 待验收'));
assert(find('负责人已验证 · 依赖已校验'));
assert(find('观测 · 缓存完整'));
assert(find('证据版本 · candidate-a'));
assert(all(panel).some(el=>el.textContent?.startsWith('最近报告 · ')));
find('验收…').onclick();
await new Promise(resolve=>setImmediate(resolve));
assert(find('保存验收'));
await app.openTask('task');
assert(find('已完成第一轮取证'));
find('查看同批共享证据').onclick();
await new Promise(resolve=>setImmediate(resolve));
find('另一专业的取证').onclick();
assert.equal(calls.at(-1).materialId,'peer');
find('模型用量').onclick();
await new Promise(resolve=>setImmediate(resolve));
assert.equal(calls.at(-1).path,'guided-tasks/usage');
assert(all(panel).some(el=>el.textContent?.includes('DeepSeek · 执行 · 本地资源')));
assert(all(panel).some(el=>el.textContent?.includes('实际 未知 · 估算 US$0.000100')));
console.log('PASS task UI: compact review, explicit acceptance, and separate local/billable usage');

const findLabel=text=>all(panel).find(el=>el.tag==='label'&&el.textContent===text);
find('主管与验收设置').onclick();
const riskEnabled=findLabel('开启风险验收').children[0];
assert.equal(riskEnabled.checked,false,'the feature is disabled until the operator enables it');
riskEnabled.checked=true;riskEnabled.onchange();
findLabel('常规项抽查百分比（全审为 100%）').children[0].value='20';
all(panel).find(el=>el.tag==='form').onsubmit({preventDefault(){}});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(calls.find(c=>c.path==='guided-tasks/settings').args.riskReview.samplePercent,20);
queue.risk={submissionId:'submission',requiredCount:1,pendingCount:1,missingCheckIds:[],checks:[
  {index:0,criterion:'ABI',evidenceStatus:'referenced',observed:'ABI 118',reasons:['sample']}
]};
await app.refresh({force:true});
find('打开核验清单').onclick();
await new Promise(resolve=>setImmediate(resolve));
assert(find('记录独立核验'));
assert(find('报告观测 · ABI 118'));
assert.equal(calls.at(-1).args.action,'review_packet');
console.log('PASS risk review UI: opt-in settings and evidence packet');

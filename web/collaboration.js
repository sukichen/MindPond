'use strict';
const $=id=>document.getElementById(id);
const operationKey=()=>Array.from(crypto.getRandomValues(new Uint8Array(24)),n=>n.toString(16).padStart(2,'0')).join('');
const state={workspaces:[],principal:null,thread:null,lease:null,handoffKey:operationKey(),replyKey:operationKey(),claimKey:operationKey(),inboxCursor:0,connected:false,waitAbort:null};
const node=(tag,value)=>{const e=document.createElement(tag);e.textContent=value??'';return e;};
const message=(s,error=false)=>{$('notice').hidden=false;$('notice').textContent=s;$('notice').className=error?'error':'';};
async function api(path,body,signal){const headers={'Content-Type':'application/json'};if($('apiKey').value)headers['x-api-key']=$('apiKey').value;if($('operatorKey').value)headers['x-operator-key']=$('operatorKey').value;if($('contextToken').value)headers['x-mindpond-context']=$('contextToken').value;const r=await fetch('./api/work/'+path,{method:'POST',headers,body:JSON.stringify(body??{}),signal});const d=await r.json();if(!r.ok||d.error)throw Error(d.error?.message??d.error??'请求失败');return d;}
const action=(label,fn)=>{const b=node('button',label);b.type='button';b.onclick=()=>run(fn,b);return b;};
async function run(fn,b){if(b?.disabled)return;if(b)b.disabled=true;try{await fn();}catch(e){message(e.message,true);}finally{if(b)b.disabled=false;}}
function participants(){const w=state.workspaces.find(w=>w.id===$('workspace').value);for(const [id,role] of [['recipient','worker'],['reviewer','reviewer']]){const box=$(id);box.replaceChildren();for(const m of w?.members??[])if(m.roles.includes(role)){const o=node('option',m.principal);o.value=m.principal;box.append(o);}}}
async function inbox(reset=true){if(reset){state.inboxCursor=0;$('inbox').replaceChildren();}const d=await api('inbox',{afterSeq:state.inboxCursor,unreadOnly:true,limit:20});for(const item of d.items){const article=node('article');article.append(node('strong',item.title),node('p',`${item.kind} · ${item.actor} · ${item.status}`),action('查看完整材料',()=>thread(item.taskId)));$('inbox').append(article);}if(reset&&!d.items.length)$('inbox').append(node('p','没有未读更新'));state.inboxCursor=d.nextCursor;$('moreInbox').hidden=d.items.length<20;}
async function connect(){const d=await api('workspaces');state.workspaces=d.workspaces;state.principal=d.principal;$('notice').hidden=true;$('identity').textContent=`${d.principal}${d.operator?' · 操作员':''}`;$('admin').hidden=!d.operator;$('workspaces').replaceChildren();$('workspace').replaceChildren();for(const w of d.workspaces){const o=node('option',`${w.title}${w.enabled?'':'（已停用）'}`);o.value=w.id;$('workspace').append(o);const a=node('article');a.append(node('strong',w.title),node('p',`r${w.revision} · ${w.members.map(m=>m.principal).join(' / ')}`),action('查看交接任务',()=>tasks(w)));$('workspaces').append(a);}if(!d.workspaces.length)$('workspaces').append(node('p','尚未获得协作工作区授权'));participants();await inbox();state.connected=true;await observe();scheduleObserve();}
async function tasks(w){const items=await api('task/list',{contextId:w.contextId});const box=$('workspaceTasks');box.hidden=false;box.replaceChildren(node('h2',w.title),node('p','最多显示 500 条任务；其他任务可以按 ID 打开。'));for(const t of items)box.append(action(`${t.title} · ${t.status}`,()=>thread(t.id)));}
async function thread(id,afterSeq=0){if(state.thread?.task.id!==id){state.lease=null;state.replyKey=operationKey();state.claimKey=operationKey();}const d=await api('thread',{taskId:id,afterSeq,limit:20});state.thread=d;state.liveThread=d;$('taskId').value=id;const box=$('thread');box.hidden=false;box.replaceChildren(node('h2',d.task.title),node('p',`${d.task.status} · 任务 r${d.task.revision} · 讨论 r${d.threadRevision} · 报告 v${d.reportVersion}`),node('p',`发起 ${d.creator} → 处理 ${d.recipient} → 验收 ${d.reviewer}`),node('pre',JSON.stringify(d.report,null,2)));
  const versions=node('div');for(const v of d.versions)versions.append(action(`报告 v${v.version} · ${v.author}`,async()=>{const old=await api('thread',{taskId:id,reportVersion:v.version});const p=node('pre',JSON.stringify(old.report,null,2));box.append(p);}));box.append(versions,node('h3','讨论与真实回执'));
  for(const e of d.events){const article=node('article');article.className='event'+(['read','accepted'].includes(e.kind)?' receipt':'');article.append(node('strong',`${e.kind} · ${e.actor} · #${e.seq}`),node('pre',JSON.stringify(e.payload,null,2)));box.append(article);}for(const r of d.receipts)box.append(node('p',`${r.principal}：已读至 #${r.read_seq}，接收至 #${r.accepted_seq}`));
  if(d.events.length===20)box.append(action('继续读取讨论',()=>thread(id,d.nextCursor)));
  const controls=node('div');if(d.throughSeq)for(const kind of ['read','accepted'])if(kind==='read'||state.principal===d.recipient)controls.append(action(kind==='read'?'确认这一页已读':'明确接收这一页交接',async()=>{await api('ack',{taskId:id,throughSeq:d.throughSeq,kind,eventId:operationKey()});await thread(id);await inbox();}));
  if(state.principal===d.recipient&&['open','blocked','claimed'].includes(d.task.status)&&d.iterations.length<d.maxIterations){controls.append(action('领取任务',async()=>{const r=await api('task/claim',{taskId:id,eventId:state.claimKey,agentId:state.principal,expectedRevision:d.task.revision});state.lease=r.leaseToken;state.claimKey=operationKey();await thread(id);}));if(state.lease)controls.append(action('续租',async()=>{await api('task/renew',{taskId:id,agentId:state.principal,leaseToken:state.lease});message('任务租约已续期');}));}
  box.append(controls);
  const detail=node('section');detail.id='loopDetail';box.insertBefore(detail,box.children[3]??null);loopView.renderThread(detail,d);addLoopControls(box,d);
  const body=document.createElement('textarea');body.rows=5;body.placeholder='追问、补充现场证据、修复说明或实际验收结果';const report=document.createElement('textarea');report.rows=6;report.placeholder='可选：完整新报告 JSON（仅原发起者可以修订）';box.append(body,report);
  box.append(action('发布回复 / 补充材料',async()=>{const r=await api('reply',{taskId:id,eventId:state.replyKey,body:body.value,expectedThreadRevision:d.threadRevision,...(report.value.trim()?{report:JSON.parse(report.value)}:{})});state.replyKey=operationKey();await thread(id);message(`已发布回复 #${r.seq}`);}));
  const refs=document.createElement('input');refs.placeholder='结果或验证证据引用，每项逗号分隔';box.append(refs);
  for(const status of (d.iterations[0]?.state==='pending'?[]:d.iterations.length?['blocked']:['blocked','submitted','completed']))if(status==='completed'?state.principal===d.reviewer:state.principal===d.recipient){const eventId=operationKey();box.append(action({blocked:'说明阻塞',submitted:'提交修复，等待验收',completed:'确认实际复测通过'}[status],async()=>{await api('task/transition',{taskId:id,agentId:state.principal,eventId,expectedRevision:d.task.revision,leaseToken:state.lease??undefined,status,reason:body.value,resultRefs:refs.value.split(',').map(x=>x.trim()).filter(Boolean)});state.lease=null;await thread(id);}));}
}
$('connect').onclick=e=>run(connect,e.currentTarget);$('refresh').onclick=e=>run(connect,e.currentTarget);$('moreInbox').onclick=e=>run(()=>inbox(false),e.currentTarget);$('openTask').onclick=e=>run(()=>thread($('taskId').value.trim()),e.currentTarget);$('workspace').onchange=participants;
$('handoffForm').onsubmit=e=>{e.preventDefault();run(async()=>{const r=await api('handoff',{workspaceId:$('workspace').value,recipient:$('recipient').value,reviewer:$('reviewer').value,report:JSON.parse($('report').value),idempotencyKey:state.handoffKey,maxIterations:Number($('maxIterations').value)});$('handoffReceipt').textContent=`发布成功 · ${r.taskId} · 尚不代表对方已读或接收。`;await thread(r.taskId);},e.submitter);};
$('newHandoffKey').onclick=()=>{state.handoffKey=operationKey();$('handoffReceipt').textContent='已开始新交接；上次报告仍保留。';};
$('workspaceForm').onsubmit=e=>{e.preventDefault();run(async()=>{await api('workspace/configure',JSON.parse($('workspaceConfig').value));await connect();message('共享工作区权限已保存');},e.submitter);};
$('report').value=JSON.stringify({summary:'问题摘要',project:'项目名',version:'实际版本或明确未知',environment:'实际运行条件',expected:'预期行为',actual:'实际观察到的行为',reproduction:['复现步骤；无法复现时说明限制'],evidence:[{label:'观察证据',content:'共享必要日志或代码原文，路径本身不是内容'}],attempts:[],unknowns:['尚未确认的事项'],acceptance:['可以执行的验收方法']},null,2);
$('workspaceConfig').value=JSON.stringify({id:'tool-project',teamId:'developers',title:'工具协作',expectedRevision:0,enabled:true,members:[{principal:'reporter-account',roles:['reporter','reviewer']},{principal:'developer-account',roles:['worker']}]},null,2);
let observationTimer,observing=false;
async function observe(){
  if(observing||!state.connected)return;
  observing=true;
  try{
    const data=await api('activity',{limit:30});
    loopView.renderActivity(data,id=>run(()=>thread(id)));
    const selected=state.thread?.task.id;
    const selectedTask=data.tasks.find(task=>task.taskId===selected);
    if(selectedTask&&$('loopDetail')){
      if(state.liveThread?.task.id!==selected||state.liveThread.task.revision!==selectedTask.revision)state.liveThread=await api('thread',{taskId:selected,limit:1});
      if(state.thread?.task.id===selected&&$('loopDetail'))loopView.renderThread($('loopDetail'),{...state.liveThread,waits:selectedTask.waits});
    }
  }catch(error){$('activityConnection').textContent='观察连接中断';$('activityConnection').title=error.message;}
  finally{observing=false;}
}
function scheduleObserve(){clearTimeout(observationTimer);if(!$('autoObserve').checked)return;observationTimer=setTimeout(async()=>{if(!document.hidden)await observe();scheduleObserve();},2000);}
$('autoObserve').onchange=()=>{if(!$('autoObserve').checked)$('activityConnection').textContent='自动观察已暂停';else run(observe);scheduleObserve();};
window.addEventListener('pagehide',()=>{clearTimeout(observationTimer);state.waitAbort?.abort();});
function field(parent,label,tag='input',value=''){
  const wrapper=node('div'),caption=node('label',label),input=document.createElement(tag);input.value=value;input.id='loop-field-'+operationKey();caption.htmlFor=input.id;
  if(tag==='textarea')input.rows=4;
  wrapper.append(caption,input);parent.append(wrapper);return input;
}
function addLoopControls(box,d){
  const current=d.iterations[0],terminal=['completed','cancelled'].includes(d.task.status);
  const form=node('section');form.className='loop-form';
  if(state.principal===d.recipient&&d.task.status==='claimed'&&state.lease){
    form.append(node('h3','提交本轮代码供验证'));
    const version=field(form,'明确代码版本 / commit SHA'),artifact=field(form,'验证方可访问的代码引用'),summary=field(form,'本轮修改与验证要求','textarea');
    const eventId=operationKey();
    form.append(action('提交迭代并释放租约',async()=>{await api('iteration/submit',{taskId:d.task.id,eventId,expectedRevision:d.task.revision,leaseToken:state.lease,codeVersion:version.value,artifactRef:artifact.value,summary:summary.value,resultRefs:[artifact.value]});state.lease=null;await thread(d.task.id);await observe();}));
  }
  if(state.principal===d.reviewer&&current?.state==='pending'){
    form.append(node('h3',`验证第 ${current.number} 轮 · ${current.codeVersion}`));
    const verdict=field(form,'验证结论','select');
    for(const [value,label] of [['changes_requested','需要修改'],['passed','实际验证通过'],['blocked','无法验证 / 缺少条件']]){const option=node('option',label);option.value=value;verdict.append(option);}
    const summary=field(form,'实际结果与反馈','textarea'),evidence=field(form,'验证证据 JSON（记录命令、结果或观察原文）','textarea',JSON.stringify([{label:'验证输出',content:''}],null,2));
    const eventId=operationKey();
    form.append(action('反馈本轮验证结果',async()=>{await api('verification/report',{taskId:d.task.id,eventId,expectedRevision:d.task.revision,roundId:current.roundId,codeVersion:current.codeVersion,verdict:verdict.value,summary:summary.value,evidence:JSON.parse(evidence.value)});await thread(d.task.id);await observe();}));
  }
  let wait;
  if(!terminal&&state.principal===d.recipient&&current?.state==='pending')wait={taskId:d.task.id,until:'verification_result',roundId:current.roundId,codeVersion:current.codeVersion,afterSeq:current.submissionSeq,waitMs:25000};
  if(!terminal&&state.principal===d.reviewer&&current?.state!=='pending')wait={taskId:d.task.id,until:'iteration_submitted',afterSeq:current?.resultSeq??0,waitMs:25000};
  if(wait){
    form.append(action(wait.until==='verification_result'?'挂起等待本轮验证回复':'挂起等待下一轮代码',async()=>{
      if(state.waitAbort)throw Error('页面已有一个等待中的调用');
      const abort=new AbortController();state.waitAbort=abort;message('等待已挂起；页面仍会实时观察协作过程。超时不会被当作验证失败。');
      try{const result=await api('wait',wait,abort.signal);message(result.status==='timeout'?'尚未收到匹配回复，可继续等待。':result.status==='matched'?`已收到：${loopView.label(result.iteration?.state??'matched')}`:`等待结束：${loopView.label(result.status)}`);if(result.status==='matched'&&state.thread?.task.id===d.task.id)await thread(d.task.id);}
      catch(error){if(abort.signal.aborted)message('已停止页面等待；协作任务仍保留。');else throw error;}
      finally{if(state.waitAbort===abort)state.waitAbort=null;await observe();}
    }));
  }
  form.append(action('停止页面等待',async()=>{state.waitAbort?.abort();}),action('重新读取全文与操作状态',()=>thread(d.task.id)));
  box.insertBefore(form,$('loopDetail')?.nextSibling??null);
}
run(connect);

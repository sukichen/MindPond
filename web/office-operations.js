/* Human-only operational view. Server observations never imply host execution. */
(()=>{'use strict';
 const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const bytes=n=>n==null?'未知':n>=1073741824?(n/1073741824).toFixed(1)+' GiB':n<1048576?(n/1024).toFixed(0)+' KiB':(n/1048576).toFixed(1)+' MiB';
 window.MindPondOfficeOperations={mount({getState,api,run,showDetail,notice,confirmAction,download,openOffice,refreshOffice}){
  const panel=document.getElementById('officeOperations');let generation=0,recoveryGeneration=0,loading=false,capacityDraft=null,activeActions=0;
  const runAction=async(fn,button)=>{activeActions++;try{return await run(fn,button);}finally{activeActions--;}};
  const button=(text,fn)=>{const b=node('button',text);b.type='button';b.onclick=()=>runAction(fn,b);return b;};
  const current=(ticket,epoch)=>ticket===generation&&getState().logged&&getState().authEpoch===epoch&&getState().appView==='officeOperations';
  async function recover(message){
   const state=getState(),epoch=state.authEpoch,view=state.appView,ticket=++recoveryGeneration,room=message.officeId===null?null:message.officeId??state.office?.office.id;
   const valid=()=>ticket===recoveryGeneration&&epoch===getState().authEpoch&&getState().logged&&getState().appView===view&&(view==='officeOperations'||!room||getState().office?.office.id===room);
   const full=await api(room?'message':'role/message',{...(room?{officeId:room}:{}),messageId:message.id});if(!valid())return;
   const raw=full.message,m={...raw,recipientName:raw.recipientName??raw.recipient_name,takenAt:raw.takenAt??raw.taken_at??null};if(m.state!=='processing'){notice('处理状态已变化，请查看最新消息。');return;}
   showDetail('处理恢复 · '+m.recipientName,{body:m.body});
   const detail=document.getElementById('officeDetail'),form=node('form');form.className='office-recovery-form';
   const reason=node('textarea');reason.required=true;reason.maxLength=1000;reason.rows=3;reason.placeholder='说明中止原因，以及已经完成、尚需核对的部分';
   const label=node('label','恢复说明');label.append(reason);form.append(label,node('p','原处理将明确标记为人类中止并通知发件人；重新安排会创建新消息。请先核对外部成果，避免重复执行。'));
   const target=node('select');target.setAttribute('aria-label','重新安排给');
   const offices=getState().data?.characters,officeSeats=getState().office?.office.id===room?new Set(getState().office.seats.map(s=>s.id)):null;
   const members=officeSeats?new Set((offices?.mappings??[]).filter(m=>officeSeats.has(m.seat_id)).map(m=>m.role_id)):new Set((offices?.roles??[]).filter(r=>r.state==='active').map(r=>r.id));
   for(const role of offices?.roles??[])if(role.state==='active'&&members.has(role.id)){const option=node('option',role.name);option.value=role.id;target.append(option);}
   target.value=m.recipient;form.append(node('label','重新安排给'),target);
   const key=crypto.randomUUID(),submit=async action=>{
    if(!valid()||!form.isConnected)throw Error('页面或登录状态已变化。请复制说明，重新打开消息后核对最新状态。');
    if(!form.reportValidity())return;if(!await confirmAction(action==='retry'?'中止原处理，并创建一条待处理的新消息？':'明确中止原处理，并通知发件人？'))return;
    if(!valid()||!form.isConnected)return;
    const input={...(room?{officeId:room}:{}),messageId:m.id,action,expectedTakenAt:m.takenAt,reason:reason.value.trim(),key,...(action==='retry'?{recipient:target.value}:{})};
    // Pin payload after the first request: a lost response can be replayed safely.
    if(form.recoveryPayload&&JSON.stringify(form.recoveryPayload)!==JSON.stringify(input))throw Error('上次操作结果尚未确认。请先用原内容重试，或重新打开最新消息。');
    form.recoveryPayload=input;const result=await api('message/recover',input);if(!valid()||!form.isConnected)return;
    showDetail('恢复结果',{body:result.replacementMessageId?'原处理已中止并通知发件人；已创建新消息等待领取。':'原处理已中止并通知发件人。未声明任务完成。'});notice('处理恢复已记录。');if(getState().office?.office.id===room)await refreshOffice();if(getState().appView==='officeOperations')await refresh();
   };
   form.append(button('中止并重新安排',()=>submit('retry')),button('仅中止处理',()=>submit('cancel')));detail.append(form);reason.focus();
  }
  async function refresh(){
   const s=getState();if(!s.logged||s.appView!=='officeOperations'||loading)return;const ticket=++generation,epoch=s.authEpoch;loading=true;
   const status=document.getElementById('officeOperationsStatus');status.textContent='正在读取服务状态…';
   try{const data=await api('operations',{action:'status'});if(!current(ticket,epoch))return;if(!data.release||!data.runtime||!data.storage)throw Error('服务尚未提供新版运行信息，请更新并重启 Web 和 MCP 服务。');
    const body=document.getElementById('officeOperationsBody'),advancedOpen=body.querySelector?.('.office-operations-advanced')?.open??false;body.replaceChildren();const grid=node('div');grid.className='office-health-grid';
    const card=(title,value,description)=>{const c=node('article');c.className='office-health-card';c.append(node('h3',title),node('strong',value),node('p',description));grid.append(c);return c;};
    card('服务版本',data.release.version,'数据库版本 '+data.schemaVersion+' · '+data.release.platform+' / '+data.release.arch);
    card('数据库',data.integrity.healthy?'最近检查通过':'需要检查','数据库 '+bytes(data.storage.databaseBytes)+' · WAL '+bytes(data.storage.walBytes)+'；检查于 '+new Date(data.integrityObservedAt??data.observedAt).toLocaleTimeString());
    card('可用磁盘',bytes(data.storage.filesystem?.availableBytes),'磁盘信息仅代表数据目录所在文件系统。');
    card('当前进程',bytes(data.runtime.memoryBytes.rss),'已运行 '+Math.floor(data.runtime.uptimeSeconds/60)+' 分钟；请求被拒绝 '+(data.runtime.rejected??0)+' 次，服务错误 '+(data.runtime.serverErrors??0)+' 次。任务完成需另行核对。');
    const compatible=(data.mcpProcesses??[]).every(p=>p.payload.release.version===data.release.version&&p.payload.release.lockSha256===data.release.lockSha256);
    card('MCP 进程',(data.mcpProcesses??[]).length?compatible?'最近有通信记录':'发现运行版本不一致':'尚无运行报告','仅统计最近两分钟主动报告的进程，不据此判断宿主或模型在线。');
    card('默认向量模型',({ready:'可用',disabled:'已停用 · 文本模式',unavailable:'不可用',uninitialized:'尚未验证'})[data.retrievalRuntime?.primary?.state]??'尚未核对','文本检索仍可使用；其它检索配置在记忆库查看。不自动下载模型。');
    card('最近数据库备份',data.backups[0]?new Date(data.backups[0].created_at).toLocaleString():'尚无备份记录','备份不含宿主凭据与模型。建议同时验证恢复副本。');body.append(grid);
    const attention=node('section');attention.className='office-attention';const characters=getState().data?.characters,reviewCount=(characters?.pending?.length??0)+(characters?.connections?.length??0);attention.append(node('h3','需要你处理'),node('p',reviewCount?'有 '+reviewCount+' 条可见的角色审核或连接激活请求。':'当前没有待审核或待激活请求。'));const review=node('a','打开角色与申请');review.href='#officeCharacters';attention.append(review);const pendingCount=(data.backlog??[]).filter(r=>['queued','pending'].includes(r.state)).reduce((n,r)=>n+r.count,0);attention.append(node('p',pendingCount+' 条消息等待角色处理。处理时间和在线状态需要结合实际宿主判断。'));body.prepend(attention);
    if(data.restoreDrill)body.append(node('p','最近恢复演练：'+new Date(data.restoreDrill.checkedAt).toLocaleString()+' · '+(data.restoreDrill.healthy?'副本检查通过':'未通过')));
    const actions=node('div');actions.className='office-health-actions';
    actions.append(button('检查当前数据库',async()=>{const result=await api('operations',{action:'checkDatabase'});if(!current(ticket,epoch))return;notice(result.healthy?'当前数据库检查通过。':'数据库检查发现问题，请查看诊断。',!result.healthy);await refresh();}));
    actions.append(button('创建并检查备份',async()=>{const saved=await api('operations',{action:'backup'});if(!current(ticket,epoch))return;const checked=await api('operations',{action:'checkBackup',id:saved.id});if(!current(ticket,epoch))return;notice(checked.healthy&&checked.digestMatches?'备份完整性和校验和检查通过。':'备份检查未通过。',!(checked.healthy&&checked.digestMatches));await refresh();}));
    if(data.backups[0])actions.append(button('演练恢复到临时副本',async()=>{if(!await confirmAction('从最近备份创建并检查临时恢复副本？会占用一份数据库的额外磁盘空间，运行数据保持不变。'))return;if(!current(ticket,epoch))return;const result=await api('operations',{action:'restoreDrill',id:data.backups[0].id});if(!current(ticket,epoch))return;notice(result.healthy?'恢复副本检查通过，临时副本已清理。':'恢复检查未通过。',!result.healthy);await refresh();}));
    actions.append(button('下载脱敏诊断',async()=>{if(!current(ticket,epoch))return;const safe={release:data.release,schemaVersion:data.schemaVersion,observedAt:data.observedAt,storage:data.storage,runtime:data.runtime,mcpProcesses:(data.mcpProcesses??[]).map(p=>({observedAt:p.observedAt,...p.payload})),integrityHealthy:data.integrity.healthy,backlog:data.backlog,waitCapacity:data.capacity,backupCount:data.backups.length,retrieval:data.retrieval,retrievalRuntime:data.retrievalRuntime};download(JSON.stringify(safe,null,2),'mindpond-diagnostics.json');}));body.append(actions);
    const advanced=node('details');advanced.className='office-operations-advanced';advanced.open=advancedOpen;advanced.append(node('summary','高级：等待容量、历史备份与临时记录'));
    const capacity=node('form');capacity.className='office-fields';const account=node('input'),global=node('input');account.type=global.type='number';account.min=global.min='1';account.max='128';global.max='1024';account.required=global.required=true;account.value=capacityDraft?.maxPerPrincipal??data.capacity.maxPerPrincipal;global.value=capacityDraft?.maxGlobal??data.capacity.maxGlobal;
    for(const [title,control] of [['每账户等待名额',account],['全库等待名额',global]]){const label=node('label',title);label.append(control);capacity.append(label);control.oninput=()=>{capacityDraft={maxPerPrincipal:account.value,maxGlobal:global.value};};}
    const save=node('button','保存共享容量');save.type='submit';capacity.append(save,button('取消修改',async()=>{capacityDraft=null;await refresh();}));capacity.onsubmit=event=>{event.preventDefault();void runAction(async()=>{if(!current(ticket,epoch)||!capacity.reportValidity())return;const maxPerPrincipal=Number(account.value),maxGlobal=Number(global.value);if(maxPerPrincipal>maxGlobal)throw Error('全库等待名额不能小于每账户名额。');await api('operations',{action:'capacity',maxPerPrincipal,maxGlobal});if(!current(ticket,epoch))return;capacityDraft=null;notice('共享等待容量已保存。');await refresh();},save);};advanced.append(capacity,node('p','超出容量先排队，不删除消息。保留策略仅清理临时运行记录，不清理知识或协作成果。'));
    for(const backup of data.backups??[])advanced.append(button('检查备份 '+new Date(backup.created_at).toLocaleString(),async()=>{const result=await api('operations',{action:'checkBackup',id:backup.id});if(current(ticket,epoch))showDetail('备份恢复检查',result);}));
    advanced.append(button('预览清理临时记录',async()=>{const result=await api('operations',{action:'retentionPreview',days:30});if(!current(ticket,epoch))return;showDetail('临时记录清理预览',result);const detail=document.getElementById('officeDetail');detail.append(button('确认清理临时记录',async()=>{if(!await confirmAction('清理30天前已结束等待、过期响应页和临时报告？消息、材料、记忆、交接及审计记录保留。'))return;if(!current(ticket,epoch)||!detail.isConnected)return;const applied=await api('operations',{action:'retentionApply',days:30});if(current(ticket,epoch))showDetail('清理结果',applied);}));}));body.append(advanced);
    const list=node('section');list.append(node('h3','处理中 · 需要时人工恢复'),node('p','处理时间长不代表失败。先查看消息、角色接续与实际成果，再决定是否中止或重新安排。'));
    const processingTotal=(data.backlog??[]).find(r=>r.state==='processing')?.count??data.processing?.length??0;if(processingTotal>(data.processing?.length??0))list.append(node('p','共 '+processingTotal+' 条处理中消息；这里只展示最早的50条。更多消息请到办公室通信或角色详情查看。'));
    for(const m of data.processing??[]){const row=node('article');row.className='office-item';row.append(node('strong',m.recipientName+' · '+(m.officeTitle??'直接消息')),node('p',m.takenAt?'领取于 '+new Date(m.takenAt).toLocaleString():'领取时间未知'));if(m.officeId)row.append(button('打开办公室',()=>openOffice(m.officeId)));row.append(button('查看与恢复',()=>recover(m)));list.append(row);}
    if(!data.processing?.length)list.append(node('p','当前没有正在处理的消息。'));body.append(list);
    status.textContent='更新于 '+new Date(data.observedAt).toLocaleTimeString()+' · 显示最近记录，不推测模型执行状态';
   }catch(error){if(current(ticket,epoch))status.textContent='状态读取失败，保留上次结果。'+error.message;}finally{if(ticket===generation)loading=false;}
  }
  document.getElementById('officeOperationsRefresh').onclick=()=>run(refresh);
  const observe=()=>{if(!document.hidden&&!activeActions)void refresh();};let timer=setInterval(observe,30000);
  window.addEventListener('pagehide',()=>{generation++;recoveryGeneration++;loading=false;clearInterval(timer);});
  window.addEventListener('pageshow',event=>{if(event.persisted){clearInterval(timer);timer=setInterval(observe,30000);void refresh();}});
  return {refresh,recover,reset(){capacityDraft=null;generation++;recoveryGeneration++;loading=false;document.getElementById('officeOperationsBody').replaceChildren();document.getElementById('officeOperationsStatus').textContent='登录后查看运行状态';}};
 }};
})();

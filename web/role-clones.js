/* Independent dispatch management. Server owns permissions and immutable versions. */
(() => {
 'use strict';
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const button=(text,run)=>{const n=el('button',text);n.type='button';n.onclick=run;return n;};
 const label=(text,input)=>{const n=el('label',text);n.append(input);return n;};
 const names={active:'可工作',revoked:'已撤回',purged:'派遣资料已清理'},changes={new:'新增',changed:'已修改',inherited:'继承，未修改'};
 function mount({container,role,api,current,onBusy=()=>{},onDirty=()=>{},onLifecycleChanged,notice=()=>{},confirmAction=async()=>false}){
  const root=el('div');root.className='office-clones';const status=el('p');status.setAttribute('role','status');const content=el('div');root.append(status,content);container.append(root);
  let busy=false,readEpoch=0,dispatchKey=null,dispatchPayload=null,returnKey=null,returnPayload=null;
  const call=args=>api('role/clones',{roleId:role.id,...args});
  const fail=e=>{if(current())status.textContent=e.message;};
  async function mutation(run){if(busy||!current())return;busy=true;readEpoch++;onBusy(true);root.setAttribute('aria-busy','true');try{await run();}catch(e){fail(e);}finally{busy=false;if(current()){onBusy(false);root.setAttribute('aria-busy','false');}}}
  async function load(){if(!current())return;const epoch=++readEpoch;status.textContent='正在读取派遣状态…';try{const data=await call({action:'status'});if(!current()||epoch!==readEpoch)return;content.replaceChildren();render(data);status.textContent='';}catch(e){if(epoch===readEpoch)fail(e);}}
  function render(data){
   const lineage=data.lineage;
   content.append(el('h3',lineage?'分身身份':'派遣独立分身'),el('p','分身继承你选中的私有记忆与脚本，以独立角色工作。回归经验由本体审阅吸收。不会继承办公室、聊天连接、凭证或其他角色的授权。'));
   if(lineage){
    const info=el('section');info.className='office-clone-card';info.append(el('h4','来自「'+lineage.parentName+'」 · '+names[lineage.state]),el('p',lineage.mission),el('small','版本 '+lineage.snapshotHash));
    if(lineage.state==='active'){
     const summary=el('textarea');summary.rows=4;summary.maxLength=4000;summary.placeholder='完成了什么，验证了什么，适用条件、失败尝试与待确认项';
     const returnButton=button('提交回归经验',()=>mutation(async()=>{
      if(!summary.value.trim())throw Error('请填写回归总结。');
      const payload={action:'submit',summary:summary.value.trim()};if(JSON.stringify(payload)!==returnPayload){returnKey=crypto.randomUUID();returnPayload=JSON.stringify(payload);}
      const result=await call({...payload,key:returnKey});if(!current())return;notice('经验包已提交，本体可审阅。当前聊天仍保持分身身份。');summary.value='';returnPayload=returnKey=null;status.textContent='经验包 '+result.reportId+' 已固定版本。';
     }));
     info.append(label('回归总结',summary),el('p','提交本分身新增或修改的记忆／脚本，保持原件独立。完整未修改继承项不重复提交；在会议室时须先总结退出。提交不会停止聊天。'),returnButton);
    }
    if(lineage.state==='active'||lineage.state==='revoked')for(const [action,text,question] of lineage.state==='active'?[['revoke','撤回分身','撤回后，该分身连接会被拒绝访问，保留私有知识与回归经验；不会停止宿主。确认撤回？']]:[['resume','恢复派遣','恢复分身权限；不会启动宿主。确认恢复？'],['purge','清理派遣资料','永久删除此分身的派遣快照、回归经验包与审阅记录，无法恢复。现有角色私有记忆与脚本保留。确认清理？']])info.append(button(text,()=>mutation(async()=>{if(!await confirmAction(question,{destructive:action!=='resume'})||!current())return;const result=await call({action,expectedRevision:lineage.revision});if(current()){if(onLifecycleChanged)await onLifecycleChanged(result);else await load();}})));
    content.append(info);
   }
   if(role.state==='active'&&(!lineage||lineage.state==='active'))renderDispatch(data);
   const children=el('section');children.append(el('h4','已派遣分身'));
   const appendChild=child=>{const card=el('div');card.className='office-clone-card';card.append(el('strong',(child.name??'角色已删除')+' · '+names[child.state]),el('p',child.mission),el('p',child.connectorId?'连接：'+child.hostName+' / '+child.host+' · '+(child.chatSource??'连接')+' '+(child.nativeChatId??child.runtimeId):'尚未连接聊天：在角色目录打开「'+(child.name??child.roleId)+'」，选择连接聊天。'),el('small','角色编号 '+child.roleId));children.append(card);};
   for(const child of data.clones)appendChild(child);
   if(data.clonesHasMore){let cursor=data.nextAfterId;const more=button('更多分身',async()=>{if(busy||!current())return;const epoch=readEpoch;more.disabled=true;try{const page=await call({action:'status',afterId:cursor});if(!current()||epoch!==readEpoch)return;for(const child of page.clones)appendChild(child);cursor=page.nextAfterId;more.hidden=!page.clonesHasMore;}catch(e){fail(e);}finally{if(current()&&epoch===readEpoch)more.disabled=false;}});children.append(more);}
   if(!data.clones.length)children.append(el('p','暂无派遣。'));content.append(children);
   const reports=el('section');reports.append(el('h4','回归经验审阅'));content.append(reports);void loadReports(reports);
  }
  function renderDispatch(data){
   const form=el('form'),fields=el('fieldset'),name=el('input'),mission=el('textarea'),principal=el('select'),kind=el('select'),choices=el('div'),selected=el('p'),more=button('加载更多',()=>loadChoices(true)),search=button('刷新候选',()=>loadChoices());
   name.value=role.name+' · 分身';name.maxLength=120;name.required=true;mission.rows=3;mission.maxLength=4000;mission.required=true;mission.placeholder='这个分身要帮助谁，完成什么，何时整理经验返回';
   for(const p of data.principals){const o=el('option',p.principal);o.value=p.principal;principal.append(o);}principal.value=data.principals.some(p=>p.principal===role.principal)?role.principal:data.principals[0]?.principal??'';
   for(const [value,title] of [['memory','私有记忆'],['script','私有脚本']]){const o=el('option',title);o.value=value;kind.append(o);}kind.value='memory';
   const chosen={memory:new Set(),script:new Set()};let after=null,generation=0;
   function invalidate(){onDirty();selected.textContent='已选记忆 '+chosen.memory.size+' · 脚本 '+chosen.script.size;}
   async function loadChoices(append=false){if(!current())return;const ticket=++generation,which=kind.value;search.disabled=more.disabled=true;try{const p=await call({action:'candidates',kind:which,...(append&&after?{afterId:after}:{})});if(!current()||ticket!==generation)return;if(!append)choices.replaceChildren();for(const item of p.records){const check=el('input');check.type='checkbox';check.checked=chosen[which].has(item.id);check.onchange=()=>{if(busy)return;if(check.checked)chosen[which].add(item.id);else chosen[which].delete(item.id);invalidate();};const row=label(item.label+' · '+changes[item.change],check);row.className='office-reorganization-option';choices.append(row);}after=p.nextAfterId;more.hidden=!p.hasMore;}catch(e){if(ticket===generation)fail(e);}finally{if(current()&&ticket===generation)search.disabled=more.disabled=false;}}
   kind.onchange=()=>void loadChoices();for(const input of [name,mission,principal])input.oninput=invalidate;
   const submit=el('button','创建分身');submit.type='submit';fields.append(label('分身名字',name),label('派遣任务',mission),label('使用者账户',principal),el('p','先在宿主连接里注册接收方账户；本体和分身可分别连接 Codex、OpenCode 或其他标准 MCP 宿主。'),label('选择继承内容',kind),search,choices,more,selected,el('p','只复制勾选的私有知识与脚本。未选内容不继承。每次创建固定版本，不自动同步本体后续修改。'),submit);form.append(fields);content.append(form);selected.textContent='已选记忆 0 · 脚本 0';
   form.addEventListener('submit',e=>{e.preventDefault();if(!form.reportValidity())return;void mutation(async()=>{
    const payload={action:'dispatch',name:name.value.trim(),mission:mission.value.trim(),principal:principal.value,memoryIds:[...chosen.memory],scriptIds:[...chosen.script]};
    if(JSON.stringify(payload)!==dispatchPayload){dispatchPayload=JSON.stringify(payload);dispatchKey=crypto.randomUUID();}fields.disabled=true;
    try{const result=await call({...payload,key:dispatchKey});if(!current())return;dispatchKey=dispatchPayload=null;notice('分身「'+result.name+'」已创建。请在角色目录为它连接聊天，并按需邀请进入办公室。');await load();}finally{if(current())fields.disabled=false;}
   });});void loadChoices();
  }
  async function loadReports(container,afterId){
   const epoch=readEpoch;try{const p=await call({action:'reports',...(afterId?{afterId}:{})});if(!current()||epoch!==readEpoch)return;for(const report of p.reports){const box=el('div');box.className='office-clone-card';box.append(el('strong','记忆 '+report.memories+' · 脚本 '+report.scripts+' · 已审阅 '+report.reviewed+(report.acknowledged?' · 审阅结束':'')),el('p',report.summary));if(!report.acknowledged&&report.reviewed===report.memories+report.scripts)box.append(button('确认总结已审阅',()=>mutation(async()=>{await api('role/clones',{roleId:report.parentId,action:'acknowledge',reportId:report.id});if(current())await load();})));for(const kind of ['memory','script'])box.append(button(kind==='memory'?'审阅记忆':'审阅脚本',()=>viewReturn(report,kind,box)));container.append(box);}if(!p.reports.length&&!afterId)container.append(el('p','暂无回归经验。'));if(p.hasMore){const more=button('更多经验包',async()=>{more.disabled=true;await loadReports(container,p.nextAfterId);if(current())more.hidden=true;});container.append(more);}}catch(e){fail(e);}
  }
  async function viewReturn(report,kind,box,sourceId){
   if(busy||!current())return;const epoch=readEpoch,ticket=(box.readTicket??0)+1;box.readTicket=ticket;
   try{let part=await api('role/clones',{roleId:report.parentId,action:'get',kind,reportId:report.id,...(sourceId?{sourceId}:{})}),text=part.content??'';const first=part;if(!current()||epoch!==readEpoch||ticket!==box.readTicket)return;
    while(part.nextOffset!==null&&part.nextOffset!==undefined){part=await api('role/clones',{roleId:report.parentId,action:'get',kind,reportId:report.id,sourceId:first.sourceId,offset:part.nextOffset});if(!current()||epoch!==readEpoch||ticket!==box.readTicket)return;text+=part.content;}
    if(!current()||epoch!==readEpoch||ticket!==box.readTicket)return;
    const view=el('section');view.className='office-clone-review';box.review?.replaceChildren();box.review=view;box.append(view);
    if(first.done){view.append(el('p','本类经验已审阅完成。'));return;}
    const picker=el('select');for(const item of first.items){const o=el('option',(item.decision?'已审阅 · ':'待审阅 · ')+item.label);o.value=item.sourceId;picker.append(o);}picker.value=first.sourceId;picker.onchange=()=>viewReturn(report,kind,box,picker.value);
    const body=el(kind==='script'?'pre':'div');if(kind==='memory'&&window.MindPondOfficeMarkdown)body.append(window.MindPondOfficeMarkdown.render(text));else body.textContent=text;
    view.append(picker,body,el('small','固定经验版本 '+first.assetHash));
    const metadataButton=button('查看来源与使用说明',async()=>{if(busy||!current())return;const ticketAtStart=box.readTicket;metadataButton.disabled=true;try{let m=await api('role/clones',{roleId:report.parentId,action:'get',kind,part:'metadata',reportId:report.id,sourceId:first.sourceId}),full=m.content??'';while(m.nextOffset!==null&&m.nextOffset!==undefined){if(!current()||ticketAtStart!==box.readTicket)return;m=await api('role/clones',{roleId:report.parentId,action:'get',kind,part:'metadata',reportId:report.id,sourceId:first.sourceId,offset:m.nextOffset});full+=m.content;}if(current()&&ticketAtStart===box.readTicket)view.append(el('pre',JSON.stringify(JSON.parse(full),null,2)));}catch(e){fail(e);}finally{if(current()&&ticketAtStart===box.readTicket)metadataButton.disabled=false;}});view.append(metadataButton);
    if(first.decision){view.append(el('p','已'+(first.decision.decision==='accepted'?'吸收':'跳过')+'：'+first.decision.note));return;}
    const note=el('textarea');note.rows=2;note.maxLength=2000;note.placeholder='吸收或跳过的理由（必填）';view.append(note);
    for(const [action,title] of [['import','作为独立副本添加给本体'],['review','跳过这条经验']])view.append(button(title,()=>mutation(async()=>{
     if(!note.value.trim())throw Error('请填写审阅理由。');if(action==='import'&&!await confirmAction('将此项作为独立副本添加给本体？不会覆盖现有知识；脚本不会自动执行。'))return;if(!current())return;
     await api('role/clones',{roleId:report.parentId,action,kind,reportId:report.id,sourceId:first.sourceId,note:note.value.trim(),...(action==='review'?{decision:'skipped'}:{})});if(current()){status.textContent=action==='import'?'已添加独立副本。':'已记录跳过理由。';for(const control of view.children)if(control.tagName==='BUTTON')control.disabled=true;view.append(el('p',action==='import'?'已添加独立副本。':'已跳过。'));}
    })));
   }catch(e){if(current()&&epoch===readEpoch&&ticket===box.readTicket)fail(e);}
  }
  void load();return {refresh:load};
 }
 window.MindPondRoleClones={mount};
})();

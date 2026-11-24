/* Independent dispatch management. Server owns permissions and immutable versions. */
(() => {
 'use strict';
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const button=(text,run)=>{const n=el('button',text);n.type='button';n.onclick=run;return n;};
 const label=(text,input)=>{const n=el('label',text);n.append(input);return n;};
 const names={active:'可工作',revoked:'已停用',returned:'已收回，待整理',archived:'已归档',purged:'派遣资料已清理'},changes={new:'新增',changed:'已修改',inherited:'继承，未修改'};
 function mount({container,role,api,current,onBusy=()=>{},onDirty=()=>{},onLifecycleChanged,notice=()=>{},confirmAction=async()=>false}){
  const root=el('div');root.className='office-clones';const status=el('p');status.setAttribute('role','status');const content=el('div');root.append(status,content);container.append(root);
  let busy=false,readEpoch=0,dispatchKey=null,dispatchPayload=null;
  let selectedClone=role.cloneState==='returned'?role.id:null,selectedCloneName=null;
  const call=args=>api('role/clones',{roleId:role.id,...args});
  const fail=e=>{if(current())status.textContent=e.message;};
  async function mutation(run){if(busy||!current())return;busy=true;readEpoch++;onBusy(true);root.setAttribute('aria-busy','true');try{await run();}catch(e){fail(e);}finally{busy=false;if(current()){onBusy(false);root.setAttribute('aria-busy','false');}}}
  async function load(){if(!current())return;const epoch=++readEpoch;status.textContent='正在读取派遣状态…';try{const data=await call({action:'status'});if(!current()||epoch!==readEpoch)return;content.replaceChildren();render(data);status.textContent='';}catch(e){if(epoch===readEpoch)fail(e);}}
  async function recallClone(target,summary){
   const request={roleId:target.roleId,action:'recall',expectedRevision:target.revision,...(summary?{summary}:{})};
   try{return await api('role/clones',request);}
   catch(e){
    if(e.code!=='material_over_budget'||!current())throw e;
    const confirmed=await confirmAction('新增或修改的内容超出单个经验包容量。是否先收回权限，只提交说明并保留已有经验包？剩余记忆和脚本会保留在分身名下，可由管理员另行整理。');
    if(!confirmed||!current())throw e;
    return api('role/clones',{...request,memoryIds:[],scriptIds:[]});
   }
  }
  function render(data){
   const lineage=data.lineage;
   content.append(el('h3',lineage?'分身身份':'派遣独立分身'),el('p','分身以独立角色工作，默认继承本体的全部私有记忆与脚本。回归经验由本体审阅吸收。不会继承办公室、聊天连接、凭证或其他角色的授权。'));
   if(lineage){
    const info=el('section');info.className='office-clone-card';info.append(el('h4','来自「'+lineage.parentName+'」 · '+names[lineage.state]),el('p',lineage.mission),el('small','版本 '+lineage.snapshotHash));
    const lifecycle=async(target,action,fields={})=>{
      const result=await api('role/clones',{roleId:target.roleId,action,expectedRevision:target.revision,...fields});
      if(current()){if(onLifecycleChanged)await onLifecycleChanged(result);else await load();}
    };
    if(['active','revoked'].includes(lineage.state)){
     const summary=el('textarea');summary.rows=3;summary.maxLength=4000;summary.placeholder='可选：补充完成情况、适用条件与待确认项';
     summary.oninput=onDirty;
     info.append(label('收回说明',summary),button('收回分身',()=>mutation(async()=>{
      if(!await confirmAction('收回后，此分身的工作权限立即结束。分身新建的记忆和新增或更新的脚本会生成经验包，供本体整理。')||!current())return;
      const result=await recallClone(lineage,summary.value.trim());
      if(current()){if(onLifecycleChanged)await onLifecycleChanged(result);else await load();}
     })));
     const accounts=(data.principals??[]).filter(p=>p.principal!==role.principal);
     if(lineage.state==='active'&&!role.connection&&accounts.length){
      const picker=el('select');for(const account of accounts){const option=el('option',account.principal+' · '+(account.accountAccess==='collaborator'?'同事账户':'我的连接'));option.value=account.principal;picker.append(option);}
      info.append(label('改派到其他账户',picker),button('更改接收账户',()=>mutation(async()=>{
       const account=accounts.find(option=>option.principal===picker.value);
       const note=account?.accountAccess==='collaborator'?'':' 此账户未绑定时可访问人类记忆。给同事用时，请先在「宿主连接」限制为同事账户。';
       if(!await confirmAction('将此分身及其私有记忆和脚本交给账户「'+picker.value+'」？确认这些内容可以交付给该账户。查阅其他角色记忆的授权将撤销。'+note)||!current())return;
       await lifecycle(lineage,'assign_account',{principal:picker.value});
      })));
     }
    }
    if(lineage.state==='returned'){
      info.append(el('p','在本体会话用 memory_clone（get）整理新增记忆，或在本体档案的「派遣分身」查看对应经验包。'));
      if(lineage.pendingPackages===0)info.append(button('归档分身',()=>mutation(async()=>{await lifecycle(lineage,'archive');})));
    }
    content.append(info);
   }

   const children=el('section');children.append(el('h4','已派遣分身'));
   const appendChild=child=>{
    const card=el('div');card.className='office-clone-card';
    const heading=el('div');heading.className='office-clone-heading';
    heading.append(el('strong',(child.name??'角色已删除')+' · '+names[child.state]),el('small',child.principal??'—'));
    card.append(heading,el('p',child.mission),el('p',child.state==='returned'?'待审阅经验包 '+child.pendingPackages:child.connectorId?'连接：'+child.hostName+' · '+(child.nativeChatId??'共享连接'):'未连接聊天'));
    if(child.state==='returned'&&child.pendingPackages>0)
      card.append(button('整理这位分身的经验',()=>{
        if(busy||!current())return;
        selectedClone=child.roleId;selectedCloneName=child.name;
        renderReports();
        reports.scrollIntoView({block:'start'});
      }));
    if(child.state==='active'||child.state==='revoked')card.append(button('收回分身',()=>mutation(async()=>{
      if(!await confirmAction('收回「'+child.name+'」并生成经验包？此分身的工作权限会立即结束。')||!current())return;
      await recallClone(child);if(current())await load();
    })));
    if(child.state==='returned'&&child.pendingPackages===0)card.append(button('归档分身',()=>mutation(async()=>{
      await api('role/clones',{roleId:child.roleId,action:'archive',expectedRevision:child.revision});if(current())await load();
    })));
    children.append(card);
   };
   for(const child of data.clones)appendChild(child);
   if(data.clonesHasMore){let cursor=data.nextAfterId;const more=button('更多分身',async()=>{if(busy||!current())return;const epoch=readEpoch;more.disabled=true;try{const page=await call({action:'status',afterId:cursor});if(!current()||epoch!==readEpoch)return;for(const child of page.clones)appendChild(child);cursor=page.nextAfterId;more.hidden=!page.clonesHasMore;}catch(e){fail(e);}finally{if(current()&&epoch===readEpoch)more.disabled=false;}});children.append(more);}
   if(!data.clones.length)children.append(el('p','暂无派遣。'));content.append(children);
   const reports=el('section');content.append(reports);
   function renderReports() {
    const items=el('div'),cloneId=selectedClone;
    reports.replaceChildren(el('h4',selectedCloneName?'整理 '+selectedCloneName+' 的回归经验':lineage?.state==='returned'?'交回本体的经验':'回归经验审阅'));
    if(cloneId&&cloneId!==role.id)reports.append(button('显示所有分身的经验',()=>{selectedClone=null;selectedCloneName=null;renderReports();}));
    reports.append(items);
    void loadReports(items,undefined,cloneId);
   }
   renderReports();
   if(role.state==='active'&&(!lineage||lineage.state==='active'))renderDispatch(data);
  }
  function renderDispatch(data){
   const form=el('form'),fields=el('fieldset'),name=el('input'),mission=el('textarea'),principal=el('select');
   const inheritance=el('select'),custom=el('fieldset'),kind=el('select'),choices=el('div'),selected=el('p');
   const more=button('加载更多',()=>loadChoices(true)),search=button('刷新候选',()=>loadChoices());
   for(const [value,title] of [['all','全部继承（默认）'],['custom','自定义选择']]){
    const option=el('option',title);option.value=value;inheritance.append(option);
   }
   inheritance.value='all';custom.hidden=more.hidden=true;
   name.value=role.name+' · 分身';name.maxLength=120;name.required=true;mission.rows=3;mission.maxLength=4000;mission.required=true;mission.placeholder='这个分身要帮助谁，完成什么，何时整理经验返回';
   for(const p of data.principals){const o=el('option',p.principal+' · '+(p.accountAccess==='collaborator'?'同事账户':'我的连接'));o.value=p.principal;principal.append(o);}principal.value=data.principals.some(p=>p.principal===role.principal)?role.principal:data.principals[0]?.principal??'';
   for(const [value,title] of [['memory','私有记忆'],['script','私有脚本']]){const o=el('option',title);o.value=value;kind.append(o);}kind.value='memory';
   const chosen={memory:new Set(),script:new Set()};let after=null,generation=0;
   function invalidate(){onDirty();selected.textContent='已选记忆 '+chosen.memory.size+' · 脚本 '+chosen.script.size;}
   async function loadChoices(append=false){
    if(!current()||inheritance.value!=='custom')return;
    const ticket=++generation,which=kind.value;
    search.disabled=more.disabled=true;
    if(!append){after=null;choices.replaceChildren();more.hidden=true;}
    try{
     const page=await call({action:'candidates',kind:which,...(append&&after?{afterId:after}:{})});
     if(!current()||ticket!==generation)return;
     for(const item of page.records){
      const check=el('input');check.type='checkbox';check.checked=chosen[which].has(item.id);
      check.onchange=()=>{if(busy)return;if(check.checked)chosen[which].add(item.id);else chosen[which].delete(item.id);invalidate();};
      const row=label(item.label+' · '+changes[item.change],check);row.className='office-reorganization-option';choices.append(row);
     }
     after=page.nextAfterId;more.hidden=!page.hasMore;
    }catch(e){if(ticket===generation)fail(e);}
    finally{if(current()&&ticket===generation)search.disabled=more.disabled=false;}
   }
   inheritance.onchange=()=>{
    invalidate();custom.hidden=inheritance.value!=='custom';
    if(custom.hidden)generation++;else void loadChoices();
   };
   kind.onchange=()=>void loadChoices();for(const input of [name,mission,principal])input.oninput=invalidate;
   const submit=el('button','创建分身');submit.type='submit';submit.disabled=!data.principals.length;
   custom.append(el('legend','自定义继承'),label('内容类型',kind),search,choices,more,selected,
    el('p','只复制勾选的项目。没有勾选的类别留空。'));
   fields.append(label('分身名字',name),label('派遣任务',mission),label('使用者账户',principal),
    el('p','给同事使用时，请选择同事账户。先在宿主连接登记并签发配置，再让同事的聊天调用 role_sync。'),
    label('继承内容',inheritance),el('p','继承记忆是只读快照。分身可以另存新经验，收回时交给本体整理。'),custom,submit);
   form.append(fields);content.append(form);
   form.addEventListener('submit',e=>{e.preventDefault();if(!form.reportValidity())return;void mutation(async()=>{
    const payload={action:'dispatch',name:name.value.trim(),mission:mission.value.trim(),principal:principal.value,
     ...(inheritance.value==='custom'?{memoryIds:[...chosen.memory],scriptIds:[...chosen.script]}:{})};
    if(JSON.stringify(payload)!==dispatchPayload){dispatchPayload=JSON.stringify(payload);dispatchKey=crypto.randomUUID();}fields.disabled=true;
    try{const result=await call({...payload,key:dispatchKey});if(!current())return;dispatchKey=dispatchPayload=null;notice('分身「'+result.name+'」已创建。请连接账户「'+payload.principal+'」下的目标聊天。');await load();}finally{if(current())fields.disabled=false;}
   });});
  }
  async function loadReports(container,afterId,cloneId=null){
   const epoch=readEpoch;
   try{
    const page=await call({action:'reports',...(afterId?{afterId}:{}),...(cloneId?{cloneId}:{})});
    if(!current()||epoch!==readEpoch||cloneId!==selectedClone)return false;
    for(const report of page.reports){
     const box=el('div');box.className='office-clone-card';
     const heading=el('div');heading.className='office-clone-heading';
     heading.append(el('strong',(report.cloneName??'分身')+' · '+(report.finalReturn?'收回':'阶段经验')),
      el('small',report.acknowledged?'已整理':'待整理'));
     box.append(heading,el('p',report.summary),el('p','记忆 '+report.memories+' · 脚本 '+report.scripts+' · 已审阅 '+report.reviewed));
     if(!report.acknowledged&&report.reviewed===report.memories+report.scripts)
      box.append(button('确认总结已审阅',()=>mutation(async()=>{
       await api('role/clones',{roleId:report.parentId,action:'acknowledge',reportId:report.id});if(current())await load();
      })));
     if(report.memories)box.append(button('审阅记忆',()=>viewReturn(report,'memory',box)));
     if(report.scripts)box.append(button('审阅脚本',()=>viewReturn(report,'script',box)));
     container.append(box);
    }
    if(!page.reports.length&&!afterId)container.append(el('p','暂无回归经验。'));
    if(page.hasMore){
     const more=button('更多经验包',async()=>{more.disabled=true;const loaded=await loadReports(container,page.nextAfterId,cloneId);if(current()){more.hidden=loaded;more.disabled=false;}});container.append(more);
    }
    return true;
   }catch(e){fail(e);return false;}
  }
  async function viewReturn(report,kind,box,sourceId){
   if(busy||!current())return;const epoch=readEpoch,ticket=(box.readTicket??0)+1;box.readTicket=ticket;
   try{let part=await api('role/clones',{roleId:report.parentId,action:'get',kind,reportId:report.id,...(sourceId?{sourceId}:{})}),text=part.content??'';const first=part;if(!current()||epoch!==readEpoch||ticket!==box.readTicket)return;
    while(part.nextOffset!==null&&part.nextOffset!==undefined){part=await api('role/clones',{roleId:report.parentId,action:'get',kind,reportId:report.id,sourceId:first.sourceId,offset:part.nextOffset});if(!current()||epoch!==readEpoch||ticket!==box.readTicket)return;text+=part.content;}
    if(!current()||epoch!==readEpoch||ticket!==box.readTicket)return;
    const view=el('section');view.className='office-clone-review';box.review?.remove();box.review=view;box.append(view);
    if(first.done){view.append(el('p','本类经验已审阅完成。'));return;}
    const picker=el('select');for(const item of first.items){const o=el('option',(item.decision?'已审阅 · ':'待审阅 · ')+item.label);o.value=item.sourceId;picker.append(o);}picker.value=first.sourceId;picker.onchange=()=>viewReturn(report,kind,box,picker.value);
    const body=el(kind==='script'?'pre':'div');if(kind==='memory'&&window.MindPondOfficeMarkdown)body.append(window.MindPondOfficeMarkdown.render(text));else body.textContent=text;
    view.append(picker,body,el('small','固定经验版本 '+first.assetHash));
    const metadataButton=button('查看来源与使用说明',async()=>{if(busy||!current())return;const ticketAtStart=box.readTicket;metadataButton.disabled=true;try{let m=await api('role/clones',{roleId:report.parentId,action:'get',kind,part:'metadata',reportId:report.id,sourceId:first.sourceId}),full=m.content??'';while(m.nextOffset!==null&&m.nextOffset!==undefined){if(!current()||ticketAtStart!==box.readTicket)return;m=await api('role/clones',{roleId:report.parentId,action:'get',kind,part:'metadata',reportId:report.id,sourceId:first.sourceId,offset:m.nextOffset});full+=m.content;}if(current()&&ticketAtStart===box.readTicket)view.append(el('pre',JSON.stringify(JSON.parse(full),null,2)));}catch(e){fail(e);}finally{if(current()&&ticketAtStart===box.readTicket)metadataButton.disabled=false;}});view.append(metadataButton);
    if(first.decision){view.append(el('p','已'+(first.decision.decision==='accepted'?'吸收':'跳过')+'：'+first.decision.note));return;}
    const note=el('textarea');note.rows=2;note.maxLength=2000;note.placeholder='吸收或跳过的理由（必填）';view.append(note);
    for(const [action,title] of [['import','作为独立副本添加给本体'],['review','跳过这条经验']])view.append(button(title,()=>mutation(async()=>{
     if(!note.value.trim())throw Error('请填写审阅理由。');if(action==='import'&&!await confirmAction('将此项作为独立副本添加给本体？不会覆盖现有知识；脚本不会自动执行。'))return;if(!current())return;
     await api('role/clones',{roleId:report.parentId,action,kind,reportId:report.id,sourceId:first.sourceId,note:note.value.trim(),...(action==='review'?{decision:'skipped'}:{})});if(current()){notice(action==='import'?'已添加独立副本。':'已记录跳过理由。');await load();}
    })));
   }catch(e){if(current()&&epoch===readEpoch&&ticket===box.readTicket)fail(e);}
  }
  void load();return {refresh:load};
 }
 window.MindPondRoleClones={mount};
})();

/* The task view reads durable task state. Opening a card never claims work. */
(() => {
  'use strict';
  const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  const label=(text,input)=>{const el=node('label',text);el.append(input);return el;};
  const names={queued:'待领取',working:'进行中',blocked:'遇到阻塞',review:'已交付 · 待验收',done:'已完成',cancelled:'已取消'};
  const events={created:'创建任务',claim:'领取任务',block:'报告阻塞',submit:'提交交付',accepted:'正式验收',
    revision_requested:'要求修订',cancel:'取消任务',reassign:'改派任务',progress:'报告进展',guide:'更新任务指导',
    decision_answered:'回答阻塞',set_release_rule:'调整放行规则',meeting_outcome:'保存会议结论',imported:'从工位档案接续'};
  const eventLabel=body=>events[body.action]??'任务更新';
  const describe=task=>task.status==='blocked'?(task.blocker==='decision'?'需要主管决定':'等待依赖'):names[task.status];
  const reviewModes=[['all','全审'],['sample','抽查（约四分之一）'],['exceptions','只优先看异常']];
  const releaseRules=[['','不参与放行检查'],['block_on_failure','失败即暂缓'],['require_evidence','必须有有效共享证据']];
  const releaseReasons={task_blocked:'任务阻塞',task_cancelled:'任务已取消',delivery_pending:'等待当前交付',
    structured_delivery_missing:'缺结构化交付',reported_failure:'负责人报告检查失败',target_version_unverified:'目标版本待验证',
    evidence_unavailable:'材料或附件已失效',required_check_missing:'缺指定检查',check_unverified:'检查待验证',
    unknowns_reported:'负责人报告未确认项',shared_evidence_missing:'缺共享材料或附件',independent_review_pending:'独立核验未完成'};
  const reasonNames={required_check:'指定必查',high_risk:'高风险',reported_uncertainty:'负责人未确认',reported_failure:'报告发现异常',missing_observation:'缺实际观测',
    self_report_only:'仅有自报',reference_unavailable:'证据已失效',audit_reference_unavailable:'核验证据已失效',
    version_mismatch:'证据版本待确认',sample:'本轮抽查',expanded_after_discrepancy:'发现差异后扩大复核'};
  const evidenceNames={self_reported:'角色自报',referenced:'附可查证据',independently_verified:'已有独立核验'};
  const conclusions={pass:'通过',fail:'异常',unknown:'待确认'};
  const findings={confirmed:'核验一致',discrepancy:'发现差异',inconclusive:'仍无法判断'};
  const priority=task=>task.status==='blocked'&&task.blocker==='decision'?0:task.status==='review'?1:task.status==='blocked'?2:3;

  function mount({getState,api,run,setRoomTab,notice,memberForSeat,confirmAction,showMaterial,showSeatArchive,showRecord}) {
    const panel=node('section'),tab=node('button','任务'),toolbar=node('div'),status=node('p'),list=node('div'),detail=node('section');
    const dashboard=node('section'),dashboardTab=node('button','控制台');
    dashboard.id='officeTaskDashboard';dashboard.dataset.roomPanel='';dashboard.hidden=true;
    dashboard.setAttribute('role','tabpanel');dashboard.setAttribute('aria-labelledby','officeTaskDashboardTab');
    dashboardTab.id='officeTaskDashboardTab';dashboardTab.type='button';dashboardTab.dataset.roomTab=dashboard.id;
    dashboardTab.setAttribute('role','tab');dashboardTab.setAttribute('aria-controls',dashboard.id);
    dashboardTab.setAttribute('aria-selected','false');dashboardTab.tabIndex=-1;
    panel.id='officeGuidedTasks';panel.dataset.roomPanel='';panel.hidden=true;
    panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','officeGuidedTaskTab');
    tab.id='officeGuidedTaskTab';tab.type='button';tab.dataset.roomTab=panel.id;
    tab.setAttribute('role','tab');tab.setAttribute('aria-controls',panel.id);tab.setAttribute('aria-selected','false');tab.tabIndex=-1;
    toolbar.className='office-toolbar';list.className='office-task-list';status.setAttribute('role','status');detail.className='office-item';detail.hidden=true;
    document.getElementById('officeTabScene').after(tab);
    document.getElementById('officeTabScene').after(dashboardTab);
    document.getElementById('officeView').append(panel,dashboard);
    const scope=()=>getState().office?.office.id;
    const current=()=>getState().logged&&scope();
    const locationKey=()=>JSON.stringify([scope(),getState().generation,getState().authEpoch]);
    let roomKey='',page=null,version=0,detailVersion=0,loading=false,dirty=false,paged=false;
    const call=(args,officeId=scope())=>api('guided-tasks',{...args,officeId});
    const memberChoices=()=>[...new Map((getState().office?.seats??[]).filter(s=>s.enabled).map(memberForSeat)
      .filter(r=>r?.state==='active').map(r=>[r.id,r])).values()];
    const memberName=id=>memberChoices().find(r=>r.id===id)?.name??'成员已不可用';
    const button=(name,action)=>{const b=node('button',name);b.type='button';b.onclick=()=>void run(action);return b;};
    const checkbox=checked=>{const input=node('input');input.type='checkbox';input.checked=checked;return input;};
    const select=(options,value='')=>{const el=node('select');for(const [v,name] of options){const opt=node('option',name);opt.value=v;el.append(opt);}el.value=value;return el;};
    const field=(max,required=true,multi=false)=>{const el=node(multi?'textarea':'input');el.required=required;el.maxLength=max;return el;};
    const filter=select([['active','进行中的任务'],['attention','主管待处理'],['closed','已结束'],['','全部任务']],'active');
    const more=button('继续读取',()=>refresh({append:true}));more.hidden=true;
    const settings=button('主管与验收设置',()=>switchDetail(showSettings)),assign=button('新建任务',()=>switchDetail(showCreate));
    const supervisor=node('p');
    toolbar.append(filter,button('刷新任务',()=>refresh({force:true})),assign,settings);
    panel.append(node('h3','办公室任务'),supervisor,toolbar,status,list,more,detail);
    filter.onchange=()=>void refresh({force:true});

    function resetTasks(){
      roomKey='';version++;detailVersion++;loading=false;dirty=false;paged=false;page=null;filter.value='active';
      list.replaceChildren();detail.replaceChildren();detail.hidden=true;status.textContent='';supervisor.textContent='';more.hidden=true;
      assign.disabled=true;settings.disabled=true;
    }
    resetTasks();
    async function refresh({append=false,force=false}={}) {
      if(!current()||panel.hidden&&!force)return;
      const here=locationKey();
      if(roomKey!==here){resetTasks();roomKey=here;}
      if((loading||paged)&&!force&&!append)return;
      const cursor=append?page?.nextAfterId:null;
      if(append&&!cursor)return;
      const request=++version, selected=filter.value;
      loading=true;more.disabled=true;
      try{
        const data=await call({action:selected==='attention'?'review_queue':'list',
          ...(selected&&selected!=='attention'?{filter:selected}:{}),...(cursor?{afterId:cursor}:{})});
        if(here!==locationKey()||request!==version)return;
        paged=append;
        page={...page,...data,tasks:append?[...(page?.tasks??[]),...data.tasks]:data.tasks};
        draw();
      }catch(error){if(here===locationKey()&&request===version)status.textContent=error.message;}
      finally{if(request===version){loading=false;more.disabled=false;}}
    }
    const styled=(tag,cls,value)=>{const element=node(tag,value);element.className=cls;return element;};
    const consoleRelease=styled('section','office-console-release');
    const consoleError=styled('p','office-console-error');
    consoleError.setAttribute('role','status');consoleError.hidden=true;
    const columns=styled('div','office-console-columns'),roles=styled('section','office-console-roles'),
      center=styled('div','office-console-center'),right=styled('section','office-console-detail');
    const rightBody=styled('div','office-console-detail-body');
    right.append(styled('h3','office-console-heading','关联详情'),rightBody);
    const roleRows=styled('div','office-console-role-list');
    roles.append(styled('h3','office-console-heading','角色'),roleRows);
    const taskFilters=styled('div','office-console-filters'),owner=select([['','所有负责人']]),
      taskStatus=select([['','全部状态'],...Object.entries(names)]);
    owner.setAttribute('aria-label','负责人');taskStatus.setAttribute('aria-label','任务状态');
    const taskRows=node('tbody'),table=node('table'),thead=node('thead'),headers=node('tr');
    for(const title of ['任务','负责人','状态','更新'])headers.append(node('th',title));
    thead.append(headers);table.append(thead,taskRows);
    const tableWrap=styled('div','office-console-table');tableWrap.append(table);
    const taskEmpty=styled('p','office-console-empty'),taskPager=styled('div','office-console-pager');
    const taskSection=styled('section','office-console-tasks');
    taskFilters.append(owner,taskStatus);
    const header=(name,controls)=>{const bar=styled('header','office-console-bar');bar.append(node('h3',name),controls);return bar;};
    taskSection.append(header('任务清单',taskFilters),tableWrap,taskEmpty,taskPager);

    const activityFilters=styled('div','office-console-filters'),activityRows=styled('div','office-console-feed'),
      activityPager=styled('div','office-console-pager'),activitySection=styled('section','office-console-activity');
    activitySection.append(header('协作动态',activityFilters),activityRows,activityPager);
    center.append(taskSection,activitySection);columns.append(roles,center,right);
    dashboard.append(consoleRelease,consoleError,columns);
    const mailStates={pending:'待处理',processing:'处理中',archived:'已归档'};
    const releaseTitles={hold:'暂缓',pending:'待核验',ready:'已满足放行检查',not_configured:'任务概况'};
    const consoleTime=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
    const stamp=at=>consoleTime.format(at);
    const badge=(title,state)=>{const result=styled('span','office-console-badge',title);result.title=title;result.dataset.state=state;return result;};
    const markdown=value=>window.MindPondOfficeMarkdown.render(value);
    const preview=(tag,cls,value)=>{const el=styled(tag,cls,value);el.title=value;return el;};
    const empty=text=>styled('p','office-console-empty',text);
    let dashboardKey='',dashboardVersion=0,dashboardLoading=false,consoleData=null,consoleDirty=false;
    let roleFilter='',activityFilter='',taskPages=[],activityPages=[],selection=null,selectionVersion=0,detailFingerprint='';
    let roleSignature='',ownerSignature='',releaseSignature='',taskSignature='',activitySignature='',recordedSnapshot='';
    const taskLink=(id,title)=>button(title,()=>selectDetail({kind:'task',id}));
    function resetDashboard(){
      dashboardKey='';dashboardVersion++;dashboardLoading=false;consoleData=null;consoleDirty=false;
      roleFilter='';activityFilter='';taskPages=[];activityPages=[];selection=null;selectionVersion++;detailFingerprint='';
      roleSignature='';ownerSignature='';releaseSignature='';taskSignature='';activitySignature='';recordedSnapshot='';
      owner.replaceChildren();taskStatus.value='';
      consoleRelease.replaceChildren();roleRows.replaceChildren();taskRows.replaceChildren();activityRows.replaceChildren();
      taskPager.replaceChildren();activityPager.replaceChildren();taskEmpty.hidden=true;consoleError.hidden=true;
      rightBody.replaceChildren(empty('选择任务或动态，查看相关记录。'));
    }
    resetDashboard();
    function filterRole(id){
      roleFilter=id;taskPages=[];activityPages=[];return refreshDashboard({force:true});
    }
    owner.onchange=()=>void run(()=>filterRole(owner.value));
    taskStatus.onchange=()=>{taskPages=[];void refreshDashboard({force:true});};
    function pager(container,pages,next,older){
      const go=forward=>{
        if(dashboardLoading)return;
        if(forward)pages.push(next);else pages.pop();
        return refreshDashboard({force:true});
      };
      container.replaceChildren();
      container.hidden=!pages.length&&!next;
      if(pages.length)container.append(button('返回更新记录',()=>go(false)));
      if(next)container.append(button(older,()=>go(true)));
    }
    async function refreshDashboard({force=false}={}){
      if(!current()||dashboard.hidden)return;
      const here=locationKey();
      if(dashboardKey!==here){resetDashboard();dashboardKey=here;}
      if(dashboardLoading&&!force)return;
      const ticket=++dashboardVersion;
      dashboardLoading=true;
      try{
        const data=await api('task-console',{officeId:scope(),roleId:roleFilter||undefined,status:taskStatus.value||undefined,
          activity:activityFilter||undefined,taskBefore:taskPages.at(-1),activityBefore:activityPages.at(-1)});
        if(here!==locationKey()||ticket!==dashboardVersion||dashboard.hidden)return;
        // A removed member can no longer be selected from this office's role list.
        if(roleFilter&&!data.members.some(r=>r.id===roleFilter))return filterRole('');
        consoleData=data;consoleError.hidden=true;
        drawRelease();drawRoles();drawTasks();drawActivity();
        if(!selection)await selectDetail({kind:'release'},false);
        else if(!consoleDirty)await refreshSelection();
      }catch(error){
        if(here===locationKey()&&ticket===dashboardVersion){
          consoleError.textContent='控制台读取失败 · '+error.message;consoleError.hidden=false;
        }
      }finally{if(ticket===dashboardVersion)dashboardLoading=false;}
    }
    function drawRelease(){
      const {releaseAssessment:a,counts,supervisorId,supervisorMode,policyRevision}=consoleData;
      const fingerprint=JSON.stringify([a,counts,supervisorId,supervisorMode,policyRevision,recordedSnapshot]);
      if(fingerprint===releaseSignature)return;
      releaseSignature=fingerprint;
      const reason=a.reasons?.[0];
      const decision=styled('div','office-console-decision');
      const title=button(releaseTitles[a.status],()=>selectDetail({kind:'release'}));
      title.className='office-console-decision-button';title.dataset.state=a.status;
      const summary=reason?[reason.title,releaseReasons[reason.code]].join(' · '):
        a.status==='not_configured'?'按角色或状态查看任务':'已标记的任务符合当前检查条件';
      decision.append(title,preview('span','office-console-decision-text',summary));
      if(a.taskAcceptance)decision.append(styled('small','office-console-scope',
        '已标记 '+a.counts.total+' 项 · 正式验收 '+a.taskAcceptance.accepted+' 项'));
      const actions=styled('div','office-console-actions');
      if(a.recordCall){
        const record=button(recordedSnapshot===a.snapshotId?'已留档':'记录判断',async()=>{
          if(record.disabled)return;
          const here=locationKey();record.disabled=true;
          try{
            await call(a.recordCall.arguments);
            if(here===locationKey()){recordedSnapshot=a.snapshotId;notice('判断已保存到办公室判断纪要。');await refreshDashboard({force:true});}
          }catch(error){
            if(here===locationKey()){record.disabled=false;await refreshDashboard({force:true});}
            throw error;
          }
        });
        record.disabled=recordedSnapshot===a.snapshotId;actions.append(record);
      }
      actions.append(button('主管权限 · '+(!supervisorId?'未指定':supervisorMode==='observe'?'仅观察':'管理任务'),
        ()=>selectDetail({kind:'settings'})),button('刷新控制台',()=>{
          if(!consoleDirty)detailFingerprint='';
          return refreshDashboard({force:true});
        }));
      const totals=styled('div','office-console-totals');
      for(const [status,title] of Object.entries(names)){
        const filterButton=button((status==='review'?'待验收':title)+' '+(counts[status]??0),()=>{
          taskStatus.value=taskStatus.value===status?'':status;taskStatus.onchange();
        });
        filterButton.dataset.state=status;
        totals.append(filterButton);
      }
      consoleRelease.replaceChildren(decision,actions,totals);
    }
    function drawRoles(){
      const {members}=consoleData;
      const fingerprint=JSON.stringify([members,roleFilter]);
      if(fingerprint===roleSignature)return;
      roleSignature=fingerprint;
      const choice=(id,name,summary,mail,index)=>{
        const row=button('',()=>filterRole(id));row.className='office-console-role';
        row.setAttribute('aria-pressed',String(id===roleFilter));
        const avatar=styled('span','office-console-avatar',id?Array.from(name)[0]:'全');
        avatar.dataset.color=String(index%5);avatar.setAttribute('aria-hidden','true');
        const copy=styled('span','office-console-role-copy');
        copy.append(preview('strong','office-console-ellipsis',name),preview('small','office-console-ellipsis',summary));
        if(mail)copy.append(styled('small','office-console-mail',mail));
        row.append(avatar,copy);return row;
      };
      const choices=members.map(r=>[r.id,r.name]),signature=JSON.stringify(choices);
      if(signature!==ownerSignature){
        ownerSignature=signature;owner.replaceChildren(...select([['','所有负责人'],...choices]).children);
      }
      owner.value=roleFilter;
      roleRows.replaceChildren(choice('','全办公室',members.length+' 位角色',null,0),...members.map((r,index)=>
        choice(r.id,r.name,r.taskId?(r.taskStatus==='review'?'待验收':names[r.taskStatus])+' · '+r.taskTitle:'无未结束任务','待处理 '+r.pending+' · 处理中 '+r.processing,index+1)));
    }
    function drawTasks(){
      const {tasks,nextTask,members}=consoleData;
      const fingerprint=JSON.stringify([tasks,nextTask,taskPages,selection?.id,members.map(r=>r.id)]);
      if(fingerprint===taskSignature)return;
      taskSignature=fingerprint;
      const active=new Set(members.map(r=>r.id));
      taskRows.replaceChildren(...tasks.map(task=>{
        const row=node('tr'),first=node('td'),state=node('td');
        const title=taskLink(task.id,task.title);title.className='office-console-task-link';title.title=task.title;
        const selected=selection?.kind==='task'&&selection.id===task.id;
        if(selected)title.setAttribute('aria-current','true');
        row.dataset.selected=String(selected);
        first.append(title);
        const status=task.status==='review'?'待验收':task.status==='blocked'&&task.blocker==='decision'?'待决定':names[task.status];
        const chip=badge(status,task.status);chip.title=describe(task);state.append(chip);
        const ownerName=active.has(task.ownerId)?task.ownerName:task.ownerName+' · 已离开或停用';
        row.append(first,preview('td','office-console-ellipsis',ownerName),state,node('td',stamp(task.updatedAt)));return row;
      }));
      taskEmpty.textContent='没有符合条件的任务。';taskEmpty.hidden=tasks.length>0;
      pager(taskPager,taskPages,nextTask,'较早任务');
    }
    function drawActivity(){
      const {activity,nextActivity}=consoleData;
      const fingerprint=JSON.stringify([activity,activityFilter,nextActivity,activityPages,selection?.kind,selection?.id]);
      if(fingerprint===activitySignature)return;
      activitySignature=fingerprint;
      activityFilters.replaceChildren(...[['','全部'],['message','消息'],['task','任务'],['evidence','证据']].map(([kind,title])=>{
        const filter=button(title,()=>{activityFilter=kind;activityPages=[];return refreshDashboard({force:true});});
        filter.setAttribute('aria-pressed',String(kind===activityFilter));return filter;
      }));
      activityRows.replaceChildren(...activity.map(item=>{
        const {kind,id,status,actor,recipient}=item;
        const row=button('',()=>selectDetail({kind,id,taskId:item.taskId,event:kind==='task_event'?item:null}));
        row.className='office-console-event';
        if(selection?.kind===kind&&selection.id===id)row.setAttribute('aria-current','true');
        const type={message:'消息',task:'任务快照',task_event:eventLabel(item),progress:'共享进展',marker:'判断纪要'}[kind];
        const state=kind==='task'||kind==='task_event'?names[status]:kind==='message'?mailStates[status]:kind==='marker'?releaseTitles[status]:'';
        row.append(styled('small','office-console-event-time',stamp(item.at)),badge(type,kind),
          preview('strong','office-console-ellipsis',recipient&&recipient!==actor?actor+(kind==='message'?' → ':' · 负责人 ')+recipient:actor),
          preview('span','office-console-ellipsis',item.preview??''));
        if(state)row.append(badge(state,status));
        return row;
      }));
      if(!activity.length)activityRows.append(empty('没有符合条件的动态。'));
      pager(activityPager,activityPages,nextActivity,'更早动态');
    }

    async function selectDetail(item,scroll=true){
      if(item.kind===selection?.kind&&item.id===selection?.id&&consoleDirty)return;
      const here=locationKey(),ticket=selectionVersion;
      if(consoleDirty&&!await confirmAction('放弃关联详情中尚未保存的修改？'))return;
      if(here!==locationKey()||ticket!==selectionVersion||dashboard.hidden)return;
      consoleDirty=false;selection=item;detailFingerprint='';rightBody.scrollTop=0;
      if(consoleData){drawTasks();drawActivity();}
      if(scroll&&dashboard.clientWidth<630)right.scrollIntoView?.({block:'start'});
      return refreshSelection();
    }
    async function refreshSelection(){
      const {kind,id,taskId,event}=selection;
      const {releaseAssessment,policyRevision,tasks,activity}=consoleData;
      const row=kind==='task'?tasks.find(t=>t.id===id)??activity.find(e=>e.kind===kind&&e.id===id):
        activity.find(e=>e.kind===kind&&e.id===id);
      const signature=JSON.stringify([kind,id,kind==='release'?[releaseAssessment,consoleData.priorities]:
        kind==='settings'?policyRevision:[row?.revision,row?.at,row?.status]]);
      if(signature===detailFingerprint)return;
      detailFingerprint=signature;
      const here=locationKey(),ticket=++selectionVersion;
      const valid=()=>here===locationKey()&&ticket===selectionVersion&&!dashboard.hidden;
      const view={body:rightBody,valid,setDirty:value=>{consoleDirty=value;}};
      const saved=async()=>{if(valid()){consoleDirty=false;detailFingerprint='';await refreshDashboard({force:true});}};
      if(kind==='settings'){
        rightBody.replaceChildren(node('h4','主管与验收设置'));
        if(!['active','paused'].includes(getState().office.office.state)){rightBody.append(empty('当前办公室的设置为只读。'));return;}
        drawSettings(view,consoleData,saved);return;
      }
      if(kind==='release'){drawReleaseDetail(releaseAssessment,consoleData.priorities);return;}
      if(kind==='task_event'){
        rightBody.replaceChildren(node('h4',eventLabel(event)+' · '+event.preview),
          node('p',stamp(event.at)+' · '+event.actor+' · '+names[event.status]),
          node('p','当时负责人 · '+event.recipient),taskLink(taskId,'打开当前任务'),
          button('查看完整事件',()=>showRecord({eventSeq:Number(event.id)},eventLabel(event))));
        return;
      }
      rightBody.replaceChildren(empty('正在读取关联记录…'));
      try{
        if(kind==='task'){
          const {task}=await call({action:'get',taskId:id});
          if(valid())drawConsoleTask(view,task,saved);
        }else if(kind==='message'){
          const {message}=await api('message',{officeId:scope(),messageId:id});
          if(valid())drawConsoleMessage(message);
        }else{
          const {records}=await api('records',{officeId:scope(),kind,id});
          if(!valid())return;
          const record=records[0]?.payload;
          if(!record){rightBody.replaceChildren(empty('这条记录已不可用。'));return;}
          if(kind==='marker')drawReleaseDetail(record.assessment,[],{note:record.note,at:records[0].created_at});
          else{
            rightBody.replaceChildren(node('h4',record.title),markdown(record.summary));
            for(const materialId of record.materialIds??[])rightBody.append(button('查看关联材料',()=>showMaterial(materialId,0)));
            if(taskId)rightBody.append(taskLink(taskId,'查看关联任务'));
          }
        }
      }catch(error){
        if(valid())rightBody.replaceChildren(empty(error.message),button('重试读取',()=>{
          detailFingerprint='';return refreshSelection();
        }));
      }finally{
        if(ticket===selectionVersion&&!valid())detailFingerprint='';
      }
    }
    function drawReleaseDetail(a,priorities,record){
      const title=a.status==='not_configured'?'任务概况':(record?'放行判断纪要':'放行检查')+' · '+releaseTitles[a.status];
      rightBody.replaceChildren(node('h4',title));
      if(record)rightBody.append(node('p','记录时间 · '+stamp(record.at)));
      if(a.taskAcceptance)rightBody.append(node('p','标记 '+a.counts.total+' 项 · 正式验收 '+a.taskAcceptance.accepted+
        ' 项 · 待验收 '+a.taskAcceptance.awaitingReview+' 项'));
      else rightBody.append(empty('选择任务或动态，查看相关记录。'));
      for(const reason of a.reasons??[]){
        const item=styled('div','office-console-note');
        item.append(taskLink(reason.taskId,reason.title),node('strong',releaseReasons[reason.code]),
          ...[reason.criterion,reason.observation].filter(Boolean).map(value=>node('p',value)));
        rightBody.append(item);
      }
      if(a.counts&&(a.counts.hold+a.counts.pending>(a.reasons?.length??0)))
        rightBody.append(empty('这里只列出前几项原因，可在任务详情中继续核对。'));
      if(record?.note)rightBody.append(markdown(record.note));
      if(priorities.length){
        rightBody.append(node('h4','全办公室优先异常 · '+priorities[0].total+' 项'));
        for(const task of priorities)rightBody.append(taskLink(task.id,
          (task.status==='blocked'?describe(task):'负责人报告未通过')+' · '+task.title));
      }
    }
    function drawConsoleTask(view,task,saved){
      const {body}=view;
      const ownerName=consoleData.members.find(r=>r.id===task.ownerId)?.name??memberName(task.ownerId);
      body.replaceChildren(node('h4',task.title),node('p',ownerName+' · '+describe(task)),
        node('p','正式验收 · '+(task.status==='done'?'已验收':'尚无验收记录')));
      const content=(name,value)=>{if(value)body.append(node('strong',name),markdown(value));};
      content('目标',task.goal);content('验收证据要求',task.acceptance);
      drawHandoff(view,task);
      content('卡点',task.blockReport?.obstacle);content('需要决定',task.blockReport?.decision);
      content('阶段报告',task.progress?.note);
      if(task.progress?.materialId)body.append(button('查看阶段证据',()=>showMaterial(task.progress.materialId,0)));
      content('负责人交付',task.delivery?.summary??task.result);
      for(const check of task.delivery?.checks??[]){
        const entry=styled('div','office-console-note');
        entry.append(node('strong',check.criterion),badge(check.conclusion?conclusions[check.conclusion]:'待确认',check.conclusion??'unknown'));
        for(const value of [check.observed,check.evidenceVersion&&'证据版本 '+check.evidenceVersion])
          if(value)entry.append(node('p',value));
        if(check.evidence)entry.append(markdown(check.evidence));
        if(check.materialId)entry.append(button('查看共享材料',()=>showMaterial(check.materialId,0)));
        if(check.artifactId)entry.append(node('small','办公室附件 '+check.artifactId));
        body.append(entry);
      }
      content('仍待确认',task.delivery?.unknowns);
      if(task.reviewPacket){
        const report=styled('section','office-console-note');report.hidden=true;
        body.append(button('查看独立核验',async()=>{
          const packet=await call(task.reviewPacket.arguments);
          if(!view.valid())return;
          report.hidden=false;
          report.replaceChildren(node('h4','独立核验'),node('p','必查与抽查 '+packet.requiredCount+' 项 · 尚待核验 '+packet.pendingCount+' 项'));
          for(const check of packet.checks)
            report.append(node('p',check.criterion+' · '+(findings[check.latestAudit?.outcome]??evidenceNames[check.evidenceStatus])));
        }),report);
      }
      if(['active','paused'].includes(getState().office.office.state)){
        const rule=node('details');rule.className='office-console-note';
        rule.open=Boolean(task.releaseRule);
        rule.append(node('summary','放行规则（可选）'));body.append(rule);
        releaseRuleForm({...view,body:rule},task,saved);
        drawReassign(view,task,saved);
      }
      body.append(button('打开完整任务',async()=>{
        if(consoleDirty&&!await confirmAction('放弃关联详情中尚未保存的修改？'))return;
        if(!view.valid())return;
        return switchDetail(()=>{
          if(!view.valid())return;
          consoleDirty=false;detailFingerprint='';
          return readTask(task.id);
        });
      }));
    }
    function drawConsoleMessage(message){
      rightBody.replaceChildren(node('h4',message.senderName+' → '+message.recipientName),
        node('p',mailStates[message.state]+' · '+stamp(message.sentAt)));
      if(message.quote?.body){
        const quote=node('blockquote');
        quote.append(node('strong','回复原文 · '+message.quote.senderName),markdown(message.quote.body));rightBody.append(quote);
      }
      rightBody.append(markdown(message.body));
      if(message.result)rightBody.append(node('h4','处理反馈'),markdown(message.result));
      if(message.artifactIds?.length){
        rightBody.append(node('h4','附件引用'));
        for(const id of message.artifactIds)rightBody.append(node('p',id));
      }
    }

    function draw(){
      const open=getState().office?.office.state==='active';
      assign.disabled=!open||!memberChoices().length;settings.disabled=!['active','paused'].includes(getState().office?.office.state);
      if(page.supervisorId!==undefined)supervisor.textContent=page.supervisorId?
        '主管 · '+memberName(page.supervisorId)+(page.supervisorMode==='observe'?' · 仅观察':''):'尚未指定主管。你可以直接派单。';
      status.textContent=page.tasks.length?'':'此筛选下没有任务。';
      const reviewing=filter.value==='attention';
      if(reviewing&&page.tasks.length){
        const mode=reviewModes.find(([v])=>v===page.reviewMode)?.[1]??'全审';
        status.textContent=page.riskReview&&page.reviewMode!=='all'?
          '风险验收 · 常规项基础抽查 '+page.riskReview.samplePercent+'%。每份报告的核验清单保留实际样本。':
          '当前设置 · '+mode+'。列表保留所有待验收任务。';
      }
      const unique=[...new Map(page.tasks.map(task=>[task.id,task])).values()];
      list.replaceChildren(...unique.sort((a,b)=>priority(a)-priority(b)||(reviewing?Number(b.reviewSuggested)-Number(a.reviewSuggested):0)||b.updatedAt-a.updatedAt).map(task=>{
        const row=node('article');row.className='office-item';
        row.dataset.taskStatus=task.status;const title=button(task.title,()=>openTask(task.id));title.className='office-task-title';
        const badge=node('span',describe(task));badge.className='office-task-state';
        row.append(title,badge,node('p','负责人 · '+memberName(task.ownerId)));
        if(task.lastReportedAt!=null)row.append(node('small','最近报告 · '+new Date(task.lastReportedAt).toLocaleString()));
        if(task.progressPreview)row.append(node('p',task.progressPreview));
        if(reviewing){
          row.append(node('p',task.auditSubmissionMissing?'本报告缺少核验清单':task.needsAttention?'有待确认项':task.reviewSuggested?'本轮建议复核':'报告已交，可按需查看'));
          if(task.summary)row.append(node('p',task.summary));
          if(task.decision)row.append(node('p','需要决定 · '+task.decision));
          if(task.unknowns)row.append(node('p','仍待确认 · '+task.unknowns));
          if(task.risk){
            const preview=node('ul');
            for(const check of task.risk.checks)
              preview.append(node('li',check.criterion+' · '+evidenceNames[check.evidenceStatus]+
                (check.observed?' · 观测 '+check.observed:'')+(check.reasons.length?' · '+check.reasons.map(r=>reasonNames[r]).join('、'):'')));
            row.append(node('p','抽查与必查 '+task.risk.requiredCount+' 项 · 尚待核验 '+task.risk.pendingCount+' 项'),preview);
            if(task.risk.missingCheckIds.length)row.append(node('p','缺少指定检查 · '+task.risk.missingCheckIds.join('、')));
            row.append(button('打开核验清单',()=>switchDetail(()=>showPacket(task))));
          }
          if(task.checks?.length){
            const checks=node('ul');
            for(const check of task.checks){
              const item=node('li',(check.status==='verified'&&check.hasEvidence&&!check.referenceUnavailable?'负责人已验证 · ':'待确认 · ')+check.criterion);
              if(check.conclusion)item.append(node('span',' · '+conclusions[check.conclusion]));
              if(check.observed)item.append(node('p','观测 · '+check.observed));
              if(check.evidencePreview)item.append(node('p','证据 · '+check.evidencePreview));
              if(check.evidenceVersion)item.append(node('small','证据版本 · '+check.evidenceVersion));
              if(check.materialId)item.append(button('查看共享证据',()=>showMaterial(check.materialId,0)));
              if(check.artifactId)item.append(node('small',' · 附件 '+check.artifactId));
              checks.append(item);
            }
            row.append(checks);
          }
          if(open&&task.status==='review')row.append(button('验收…',()=>switchDetail(()=>review(task))));
        }
        return row;
      }));
      more.hidden=!page.nextAfterId;
    }
    async function switchDetail(open){
      const here=locationKey(),ticket=detailVersion;
      if(dirty&&!await confirmAction('放弃尚未保存的任务修改？'))return;
      if(here===locationKey()&&ticket===detailVersion)return open();
    }
    function openDetail(title) {
      const here=locationKey(),ticket=++detailVersion,body=node('div');
      dirty=false;detail.hidden=false;detail.replaceChildren(node('h4',title),button('关闭详情',async()=>{if(dirty&&!await confirmAction('放弃尚未保存的任务修改？'))return;if(here!==locationKey()||ticket!==detailVersion)return;dirty=false;detailVersion++;detail.hidden=true;detail.replaceChildren();}),body);
      detail.scrollIntoView?.({block:'nearest'});
      return {body,here,valid:()=>here===locationKey()&&ticket===detailVersion};
    }
    function formFor(view,entries,action,submit) {
      const form=node('form'),fields=node('fieldset'),message=node('p'),save=node('button',action);
      save.type='submit';fields.className='office-fields';
      for(const entry of entries)fields.append(Array.isArray(entry)?label(...entry):entry);
      fields.append(save);form.append(fields,message);view.body.append(form);
      const setDirty=view.setDirty??(value=>{dirty=value;});
      form.oninput=()=>{if(view.valid())setDirty(true);};
      let previous='',key=crypto.randomUUID();
      form.onsubmit=event=>{
        event.preventDefault();
        if(!view.valid()||fields.disabled)return;
        void run(async()=>{
          fields.disabled=true;message.textContent='';
          try{await submit(payload=>{
            const signature=JSON.stringify(payload);
            if(signature!==previous){key=crypto.randomUUID();previous=signature;}
            return {...payload,key};
          });if(view.valid())setDirty(false);}
          catch(error){if(view.valid())message.textContent=error.message;}
          finally{fields.disabled=false;}
        });
      };
    }
    function showSettings() {
      if(!page||page.policyRevision===undefined)return;
      drawSettings(openDetail('主管与验收设置'),page,async view=>{
        view.body.replaceChildren();await refresh({force:true});
      });
    }
    function drawSettings(view,policyData,saved) {
      const revision=policyData.policyRevision;
      const choice=select([['','暂不指定'],...memberChoices().map(r=>[r.id,r.name])],policyData.supervisorId??'');
      const authority=select([['manage','管理任务'],['observe','仅观察']],policyData.supervisorMode??'manage');
      const mode=select(reviewModes.map(([key,title])=>[key,key==='sample'?'抽查':title]),policyData.reviewMode??'all');
      const policy=policyData.riskReview,risk=checkbox(Boolean(policy)),history=checkbox(policy?.useHistory??true),
        requireAudit=checkbox(policy?.requireAudit??true),percent=field(3),controls=node('fieldset');
      percent.type='number';percent.min=0;percent.max=100;percent.step=1;percent.value=String(policy?.samplePercent??25);
      const verifier=select([['','由有权限的主管或用户核验'],...memberChoices().map(r=>[r.id,r.name])],policy?.verifierId??'');
      controls.append(label('常规项抽查百分比（全审为 100%）',percent),label('用同类任务的核验履历调整抽查',history),
        label('验收前要求完成必查和抽查',requireAudit),label('独立核验角色（可选）',verifier));
      const toggle=()=>{controls.hidden=!risk.checked;controls.disabled=!risk.checked;};risk.onchange=toggle;toggle();
      view.body.append(node('p','仅观察时，主管可查看任务和证据、记录判断纪要。派单、指导、验收和取消由用户操作。'));
      formFor(view,[['主管角色',choice],['主管权限',authority],['复核方式',mode],['开启风险验收',risk],controls],'保存',async()=>{
        const riskReview=risk.checked?{samplePercent:Number(percent.value),useHistory:history.checked,
          requireAudit:requireAudit.checked,verifierId:verifier.value||null}:null;
        await api('guided-tasks/settings',{officeId:scope(),supervisorId:choice.value||null,supervisorMode:authority.value,
          reviewMode:mode.value,riskReview,expectedRevision:revision});
        if(view.valid()){notice('主管与验收设置已保存。');await saved(view);}
      });
    }
    function showCreate() {
      const view=openDetail('新建任务'),title=field(160),goal=field(1600,true,true),acceptance=field(1200,true,true),
        instruction=field(800,false,true),memory=field(300,false,true),members=memberChoices();
      const owner=select([['','选择专业角色'],...members.map(r=>[r.id,r.name])]);owner.required=true;
      const materials=(getState().office?.materials??[]).filter(m=>!m.state||m.state==='published');
      const brief=select([['','无共同材料'],...materials.map(m=>[m.id,m.title])]);
      const intro=node('p');owner.onchange=()=>{intro.textContent=members.find(r=>r.id===owner.value)?.introduction??'';};
      view.body.append(intro);
      const riskFields=[];
      const workType=field(80,false),target=field(160,false),requiredChecks=field(800,false,true);
      const riskLevel=select([['normal','常规'],['high','高风险']],'normal');
      if(page?.riskReview)riskFields.push(['工作类型（用于归集核验履历）',workType],['风险',riskLevel],
        ['目标版本（可选）',target],['指定检查编号（可选，逐行填写）',requiredChecks]);
      formFor(view,[['负责人',owner],['任务标题',title],['目标与范围',goal],['验收证据',acceptance],['共同材料（可选）',brief],
        ['任务指导（可选）',instruction],['开工先查的 Memory 问题（默认用任务标题）',memory],...riskFields],'派给角色',async key=>{
          const risk=page?.riskReview?{level:riskLevel.value,...(workType.value.trim()?{workType:workType.value.trim()}:{}),
            ...(target.value.trim()?{targetVersion:target.value.trim()}:{}),
            ...(requiredChecks.value.trim()?{requiredChecks:requiredChecks.value.split(/\s+/).filter(Boolean)}:{})}:undefined;
          const data=await call(key({action:'create',ownerId:owner.value,title:title.value,goal:goal.value,acceptance:acceptance.value,
            instruction:instruction.value.trim()||null,...(risk?{risk}:{}),...(brief.value?{briefMaterialId:brief.value}:{}),...(memory.value.trim()?{memoryQuery:memory.value.trim()}:{})}));
          if(view.valid()){dirty=false;notice('已派单，等待角色领取。');await refresh({force:true});if(view.valid())await openTask(data.task.id);}
        });
    }
    async function openTask(id) {
      if(!current())return;
      return switchDetail(()=>readTask(id));
    }
    async function readTask(id){
      setRoomTab(panel.id);
      const view=openDetail('任务详情');view.body.append(node('p','正在读取任务…'));
      const {task}=await call({action:'get',taskId:id});
      if(!view.valid())return;
      const body=view.body;
      body.replaceChildren(node('h4',task.title),node('p',describe(task)+' · '+memberName(task.ownerId)+' · 任务版本 '+task.revision),
        button('刷新详情',()=>openTask(id)),button('模型用量',()=>switchDetail(()=>showUsage(task))));
      if(task.releaseRule)body.append(node('p','放行检查 · '+releaseRules.find(([key])=>key===task.releaseRule)?.[1]));
      drawHandoff(view,task);
      drawReassign(view,task,async()=>{
        dirty=false;await refresh({force:true});if(view.valid())await openTask(task.id);
      });
      if(['active','paused'].includes(getState().office?.office.state))
        body.append(button('设置放行规则',()=>switchDetail(()=>showReleaseRule(task))));
      if(task.reviewPacket)body.append(button('打开核验清单',()=>switchDetail(()=>showPacket(task))));
      if(task.risk?.targetVersion)body.append(node('p','目标版本 · '+task.risk.targetVersion));
      if(task.risk?.requiredChecks?.length)body.append(node('p','指定检查 · '+task.risk.requiredChecks.join('、')));
      if(task.brief)body.append(button('查看共同材料',()=>showMaterial(task.brief.materialId,0)));
      if(task.evidenceIndex){
        const shared=node('div');
        body.append(button('查看同批共享证据',async()=>{
          const {evidence}=await call(task.evidenceIndex.arguments);
          if(!view.valid())return;
          shared.replaceChildren(...(evidence.length?evidence.map(reference=>{
            const entry=node('p');
            entry.append(button(reference.title,()=>showMaterial(reference.materialId,0)),
              node('small',' · '+reference.version+' · '+memberName(reference.reportedBy)));
            return entry;
          }):[node('p','本批任务暂时没有共享的阶段证据。')]));
        }),shared);
      }
      const sharedProgress=node('section');
      let progressVersion=0;
      const viewProgress=async afterId=>{
        const ticket=++progressVersion;
        const page=await api('records',{officeId:task.officeId,kind:'progress',taskId:task.id,limit:8,...(afterId?{afterId}:{})});
        if(!view.valid()||ticket!==progressVersion)return;
        if(!afterId)sharedProgress.replaceChildren(node('h5','共享进展'));
        for(const record of page.records){
          const card=node('article');card.className='office-item';
          card.append(node('strong',record.payload.title),node('small',' · '+memberName(record.role_id)+' · '+new Date(record.created_at).toLocaleString()),
            window.MindPondOfficeMarkdown.render(record.payload.summary));
          for(const materialId of record.payload.materialIds??[])card.append(button('查看关联材料',()=>showMaterial(materialId,0)));
          sharedProgress.append(card);
        }
        if(!afterId&&!page.records.length)sharedProgress.append(node('p','这个任务还没有共享进展。'));
        if(page.hasMore){
          const more=button('加载更多进展',async()=>{
            if(more.disabled)return;
            more.disabled=true;
            try{await viewProgress(page.nextAfterId);if(view.valid())more.remove();}
            finally{more.disabled=false;}
          });
          sharedProgress.append(more);
        }
      };
      body.append(button('查看共享进展',()=>viewProgress()),sharedProgress);
      const markdown=window.MindPondOfficeMarkdown.render;
      const content=(parent,name,value)=>{
        if(value)parent.append(node('strong',name),markdown(value));
      };
      for(const [name,value] of [['目标',task.goal],['验收证据',task.acceptance],['指导',task.guidance.instruction],
        ['Memory 检索问题',task.guidance.memory?.arguments.task],['当前反馈',task.blockReport?null:task.note],
        ['交付结果',task.delivery?null:task.result]]){
        content(body,name,value);
      }
      if(task.progress){
        const progress=node('section');progress.className='office-item';
        progress.append(node('h5','阶段报告'),node('small',new Date(task.progress.reportedAt).toLocaleString()));
        content(progress,'进展',task.progress.note);
        if(task.progress.materialId)progress.append(button('查看阶段证据',()=>showMaterial(task.progress.materialId,0)));
        body.append(progress);
      }
      if(task.blockReport){
        const report=node('section');report.className='office-item';
        report.append(node('h5',task.status==='blocked'?'阻塞报告':'上一次阻塞'));
        content(report,'已尝试',task.blockReport.attempted);
        content(report,'卡点',task.blockReport.obstacle);
        content(report,'需要决定',task.blockReport.decision);
        content(report,'负责人建议',task.blockReport.recommendation);
        body.append(report);
      }
      if(task.delivery){
        const delivery=node('section');delivery.className='office-item';
        delivery.append(node('h5',task.status==='working'?'上一次交付':'交付与验收证据'),markdown(task.delivery.summary));
        for(const check of task.delivery.checks){
          const row=node('div');row.className='office-task-check';
          row.append(node('strong',(check.status==='verified'?'负责人已验证 · ':'尚未验证 · ')+check.criterion));
          if(check.conclusion)row.append(node('p','报告结论 · '+conclusions[check.conclusion]));
          if(check.expected)row.append(node('p','预期 · '+check.expected));
          if(check.observed)row.append(node('p','观测 · '+check.observed));
          if(check.evidenceVersion)row.append(node('p','证据版本 · '+check.evidenceVersion));
          if(check.receipt)row.append(node('p','报告回执 · '+check.receipt));
          if(check.evidence)row.append(markdown(check.evidence));
          if(check.materialId)row.append(button('查看共享材料',()=>showMaterial(check.materialId,0)));
          if(check.artifactId){
            const reference=node('p','办公室附件编号 ');
            reference.append(node('code',check.artifactId));
            row.append(reference);
          }
          delivery.append(row);
        }
        content(delivery,'仍待确认',task.delivery.unknowns);
        content(delivery,'额外观察',task.delivery.observations);
        body.append(delivery);
      }
      if(task.guidance.instruction||task.guidance.memory)body.append(node('p','指导来源 · '+(task.guidance.by==='human'?'用户':memberName(task.guidance.by))+' · 第 '+task.guidanceRevision+' 版'));
      for(const room of task.rooms)body.append(button('打开会议室 · '+room.title,()=>window.MindPondOfficeResources.openDiscussion(room.id)));
      for(const outcome of task.outcomes){
        const summary=node('section');summary.className='office-item';
        summary.append(node('h5','会议结论 · '+outcome.title),
          node('p',(outcome.author==='human'?'用户':memberName(outcome.author))+' · '+new Date(outcome.createdAt).toLocaleString()));
        if(outcome.details){
          content(summary,'决定',outcome.details.decision);
          content(summary,'依据',outcome.details.evidence);
          content(summary,'下一步',outcome.details.nextStep);
        } else summary.append(markdown(outcome.conclusion));
        body.append(summary);
      }
      if(['done','cancelled'].includes(task.status))return;
      const state=getState().office?.office.state;
      if(state==='active'){
        body.append(button('更新任务指导',()=>showGuidance(task)));
        if(task.status==='blocked'&&task.blocker==='decision')body.append(button('回答阻塞',()=>showGuidance(task,true)));
        if(memberChoices().length>=2)body.append(button('发起任务讨论',()=>showMeeting(task)));
        if(task.status==='review')body.append(button('验收任务',()=>review(task)));
      }
      body.append(button('取消任务',async()=>{
        if(!await confirmAction('取消「'+task.title+'」？已提交的结果和已带出的会议结论仍可查看。'))return;
        if(!view.valid())return;
        await call({action:'cancel',taskId:id,expectedRevision:task.revision,note:'用户取消任务',key:crypto.randomUUID()});
        if(view.valid()){await refresh({force:true});if(view.valid())await openTask(id);}
      }));
    }
    function drawHandoff(view,task){
      if(task.seatArchiveId)view.body.append(button('查看工位档案',()=>showSeatArchive(task.seatArchiveId)));
      if(!task.handoff)return;
      const {previousOwnerName,at,reason,preview,materialId,eventSeq}=task.handoff;
      const section=styled('section','office-console-note');
      section.append(node('h5','上次改派'),node('p',[previousOwnerName,stamp(at)].filter(Boolean).join(' · ')),markdown(reason));
      if(preview)section.append(markdown(preview));
      if(materialId)section.append(button('查看此前阶段材料',()=>showMaterial(materialId,0)));
      section.append(button('查看改派前完整记录',()=>showRecord({eventSeq},'改派前记录')));
      view.body.append(section);
    }
    function drawReassign(view,task,saved){
      if(['done','cancelled'].includes(task.status)||!['active','paused'].includes(getState().office.office.state))return;
      const choices=memberChoices().filter(r=>r.id!==task.ownerId);
      if(!choices.length)return;
      const box=node('details'),owner=select([['','请选择'],...choices.map(r=>[r.id,r.name])]),reason=field(2000,true,true);
      owner.required=true;box.className='office-console-note';
      box.append(node('summary','改派任务'),node('p','保留任务编号、会议结论和此前交付。新负责人从待领取开始，需提交本轮交付。'));
      view.body.append(box);
      formFor({...view,body:box},[['新负责人',owner],['改派原因',reason]],'确认改派',async key=>{
        await call(key({action:'reassign',taskId:task.id,ownerId:owner.value,note:reason.value,expectedRevision:task.revision}));
        if(view.valid()){notice('任务已改派。');await saved();}
      });
    }
    function showReleaseRule(task) {
      const view=openDetail(task.title+' · 放行规则');
      view.body.append(node('p','只把影响本次放行的任务加入检查。任务完成或取消后规则仍会保留，可以随时移出。'));
      releaseRuleForm(view,task,async()=>{
        dirty=false;await refresh({force:true});if(view.valid())await openTask(task.id);
      });
    }
    function releaseRuleForm(view,task,saved) {
      const choice=select(releaseRules,task.releaseRule??'');
      formFor(view,[['放行规则',choice]],'保存放行规则',async key=>{
        await call(key({action:'set_release_rule',taskId:task.id,releaseRule:choice.value||null,expectedRevision:task.revision}));
        if(view.valid())await saved();
      });
    }
    function showGuidance(task,resolveDecision=false) {
      const view=openDetail(task.title+(resolveDecision?' · 回答阻塞':' · 更新指导')),instruction=field(800,resolveDecision,true),memory=field(300,false,true);
      instruction.value=resolveDecision?'':task.guidance.instruction??'';memory.value=task.guidance.memory?.arguments.task??'';
      formFor(view,[[resolveDecision?'决定与下一步':'任务指导',instruction],['Memory 检索问题（清空可关闭此提醒）',memory]],resolveDecision?'发布决定并交回负责人':'发布指导',async key=>{
        await call(key({action:'guide',taskId:task.id,expectedRevision:task.revision,instruction:instruction.value.trim()||null,memoryQuery:memory.value.trim()||null,...(resolveDecision?{resolveDecision:true}:{})}));
        if(view.valid()){dirty=false;await refresh({force:true});if(view.valid())await openTask(task.id);}
      });
    }
    function review(task) {
      const view=openDetail(task.title+' · 验收'),choices=[['accept','通过验收']];
      if(!task.revisionsRequested)choices.push(['revise','要求一次补证']);
      if(task.auditSubmissionMissing)view.body.append(node('p',task.revisionsRequested?
        '本报告缺少核验清单。通过验收时须明确跳过并说明理由。':
        '本报告缺少核验清单。可要求负责人补证并重新交付。'));
      const verdict=select(choices,task.auditSubmissionMissing&&!task.revisionsRequested?'revise':'accept'),note=field(2000,true,true);
      const override=checkbox(false);
      const fields=[['结果',verdict],['验收结论或需要补齐的证据',note]];
      if(task.auditSubmissionMissing||task.reviewPacket||task.risk?.submissionId)fields.push(['明确跳过尚未完成的核验，并在结论里说明理由',override]);
      formFor(view,fields,'保存验收',async key=>{
        const auditOverride=override.checked&&verdict.value==='accept';
        if(auditOverride&&!await confirmAction('确认跳过尚未完成的核验？理由会保留在任务记录中。'))return;
        if(!view.valid())return;
        await call(key({action:'review',taskId:task.id,expectedRevision:task.revision,verdict:verdict.value,note:note.value,
          ...(auditOverride?{auditOverride:true}:{})}));
        if(view.valid()){dirty=false;await refresh({force:true});if(view.valid())await openTask(task.id);}
      });
    }
    async function showPacket(task,{includeRoutine=false,checkOffset=0}={}) {
      const view=openDetail(task.title+' · 核验清单');
      const packet=await call({action:'review_packet',taskId:task.id,includeRoutine,checkOffset,limit:10});
      if(!view.valid())return;
      view.body.append(node('p','本版 '+packet.checkCount+' 项 · 抽查与必查 '+packet.requiredCount+' 项 · 尚待核验 '+packet.pendingCount+' 项'),
        button(includeRoutine?'只看需复核和已核验':'显示全部检查',()=>switchDetail(()=>showPacket(task,{includeRoutine:!includeRoutine}))));
      if(packet.targetVersion)view.body.append(node('p','目标版本 · '+packet.targetVersion));
      if(packet.missingDelivery)view.body.append(node('p','缺少结构化交付。'));
      if(packet.missingCheckIds.length)view.body.append(node('p','缺少指定检查 · '+packet.missingCheckIds.join('、')));
      if(packet.profile){
        const h=packet.profile;
        view.body.append(node('p','提交时履历 · '+h.workType+' · '+h.submissions+' 份已抽查交付 · 一致 '+h.confirmed+
          ' 项 · 有差异 '+h.discrepancy+' 项 · 无法判断 '+h.inconclusive+' 项'));
      }
      if(packet.broadened)view.body.append(node('p','独立核验发现差异，已扩大到本报告的其他检查。'));
      const list=node('ul');
      for(const check of packet.checks){
        const item=node('li');
        item.append(node('strong',check.criterion+' · '+evidenceNames[check.evidenceStatus]));
        for(const [name,value] of [['报告结论',conclusions[check.conclusion]],['预期',check.expected],['报告观测',check.observed],['证据版本',check.evidenceVersion],
          ['回执',check.receipt],['需复核原因',check.reasons.map(r=>reasonNames[r]).join('、')]])
          if(value)item.append(node('p',name+' · '+value));
        if(check.materialId)item.append(button('查看共享证据',()=>showMaterial(check.materialId,0)));
        if(check.artifactId)item.append(node('p','附件 · '+check.artifactId));
        if(check.latestAudit)item.append(node('p','核验 · '+findings[check.latestAudit.outcome]+' · '+check.latestAudit.observed+
          ' · '+check.latestAudit.source+' · '+(check.latestAudit.by.startsWith('human:')?'用户':memberName(check.latestAudit.by))));
        list.append(item);
      }
      view.body.append(list);
      if(checkOffset>0)view.body.append(button('上一页',()=>switchDetail(()=>showPacket(task,{includeRoutine,checkOffset:checkOffset-10}))));
      if(packet.nextCheckOffset!==null)view.body.append(button('下一页',()=>switchDetail(()=>showPacket(task,{includeRoutine,checkOffset:packet.nextCheckOffset}))));
      if(task.status!=='review'||getState().office?.office.state!=='active'||!packet.checks.length)return;
      const index=select(packet.checks.map(check=>[String(check.index),check.criterion]),String(packet.checks[0].index));
      const outcome=select(Object.entries(findings),'confirmed'),method=select([['manual','人工查看'],['script','宿主脚本']],'manual');
      const observed=field(400,true,true),source=field(240),evidenceVersion=field(160,false);
      formFor(view,[['已实际核验的检查',index],['结果',outcome],['核验方法',method],['实际观测',observed],
        ['来源或脚本运行编号',source],['实际核验的版本',evidenceVersion]],'记录独立核验',async key=>{
        await call(key({action:'audit',taskId:task.id,audit:{submissionId:packet.submissionId,entries:[{
          index:Number(index.value),outcome:outcome.value,method:method.value,observed:observed.value,source:source.value,
          ...(evidenceVersion.value.trim()?{evidenceVersion:evidenceVersion.value.trim()}:{})
        }]}}));
        if(view.valid()){dirty=false;await refresh({force:true});if(view.valid())await showPacket(task,{includeRoutine});}
      });
    }
    async function showUsage(task) {
      const view=openDetail(task.title+' · 模型用量'),target={officeId:scope(),taskId:task.id};
      const data=await api('guided-tasks/usage',target);
      if(!view.valid())return;
      const usd=n=>n===null?'未知':'US$'+(n/1e6).toFixed(6);
      const duration=n=>n===null?'未知':(n/1000).toFixed(1)+' 秒';
      view.body.append(node('p','计费模型 · 实际 '+usd(data.billable.reportedMicrousd)+' · 估算 '+usd(data.billable.estimatedMicrousd)+
        ' · 缺费用 '+data.billable.missingCostEntries+' 条'),
        node('p','领取前 '+duration(data.task.assignmentToClaimMs)+' · 领取至最后交付 '+duration(data.task.claimToSubmissionMs)+
          ' · 最后交付至验收 '+duration(data.task.submissionToReviewMs)+' · 已记录任务操作 '+data.task.recordedChanges+' 次'));
      const phase={assignment:'派单',work:'执行',review:'验收'};
      const rows=node('ul');
      for(const entry of data.entries){
        rows.append(node('li',[entry.model,phase[entry.phase],entry.meter==='local'?'本地资源':'计费模型',
          '输入 '+(entry.inputTokens??'未知'),'缓存 '+(entry.cachedInputTokens??'未知'),'输出 '+(entry.outputTokens??'未知'),
          '响应 '+(entry.responses??'未知'),'MCP '+(entry.mcpCalls??'未知'),'失败 '+(entry.failures??'未知'),'耗时 '+duration(entry.elapsedMs??null),
          ...(entry.meter==='billable'?[(entry.costKind==='estimate'?'估算 ':'费用 ')+usd(entry.costMicrousd??null)]:[])].join(' · ')));
      }
      view.body.append(rows,node('p','粘贴宿主导出的单条 JSON。key 用宿主记录的稳定编号。未记录的字段可以省略。'));
      const entry=field(4000,true,true);
      entry.placeholder='{"key":"run-001","phase":"work","model":"DeepSeek","meter":"local","inputTokens":1400,"outputTokens":250}';
      formFor(view,[['用量记录',entry]],'导入',async()=>{
        let parsed;
        try{parsed=JSON.parse(entry.value);}catch{throw Error('请输入有效的 JSON。');}
        await api('guided-tasks/usage',{...target,entry:parsed});
        if(view.valid())await showUsage(task);
      });
    }
    function showMeeting(task) {
      const view=openDetail(task.title+' · 发起讨论'),title=field(200),question=field(2000,true,true),doneWhen=field(1000,true,true);
      title.value=task.title+' · 讨论';
      const people=node('fieldset');people.className='office-task-people';people.append(node('legend','参与角色（选 2–8 位）'));
      const choices=memberChoices().map(role=>{
        const check=node('input');check.type='checkbox';check.value=role.id;check.checked=role.id===task.ownerId;
        const item=node('label');item.append(check,node('span',role.name));people.append(item);return check;
      });
      view.body.append(node('p','受邀角色自行加入。在会议期间，其他消息留在各自的工位。'));
      formFor(view,[['标题',title],['要解决的问题',question],['什么时候可以结束',doneWhen],people],'邀请讨论',async key=>{
        const participants=choices.filter(o=>o.checked).map(o=>o.value);
        if(participants.length<2||participants.length>8)throw Error('请选择 2–8 个参与角色。');
        const data=await api('discussions',key({action:'create',officeId:scope(),taskId:task.id,
          title:title.value,question:question.value,doneWhen:doneWhen.value,participants}));
        if(view.valid()){dirty=false;if(data.room)await window.MindPondOfficeResources.openDiscussion(data.room.id);else await openTask(task.id);}
      });
    }
    return {refresh:options=>dashboard.hidden?refresh(options):refreshDashboard(options),openTask,
      reset(){resetTasks();resetDashboard();},hasDraft:()=>dirty&&roomKey===locationKey()||consoleDirty&&dashboardKey===locationKey()};
  }
  window.MindPondOfficeGuidedTasks={mount,eventLabel};
})();

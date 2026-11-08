/* The task view reads durable task state. Opening a card never claims work. */
(() => {
  'use strict';
  const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  const label=(text,input)=>{const el=node('label',text);el.append(input);return el;};
  const names={queued:'待领取',working:'进行中',blocked:'遇到阻塞',review:'已交付 · 待验收',done:'已完成',cancelled:'已取消'};
  const describe=task=>task.status==='blocked'?(task.blocker==='decision'?'需要主管决定':'等待依赖'):names[task.status];
  const reviewModes=[['all','全审'],['sample','抽查（约四分之一）'],['exceptions','只优先看异常']];
  const reasonNames={required_check:'指定必查',high_risk:'高风险',reported_uncertainty:'负责人未确认',reported_failure:'报告发现异常',missing_observation:'缺实际观测',
    self_report_only:'仅有自报',reference_unavailable:'证据已失效',audit_reference_unavailable:'核验证据已失效',
    version_mismatch:'证据版本待确认',sample:'本轮抽查',expanded_after_discrepancy:'发现差异后扩大复核'};
  const evidenceNames={self_reported:'角色自报',referenced:'附可查证据',independently_verified:'已有独立核验'};
  const conclusions={pass:'通过',fail:'异常',unknown:'待确认'};
  const findings={confirmed:'核验一致',discrepancy:'发现差异',inconclusive:'仍无法判断'};
  const priority=task=>task.status==='blocked'&&task.blocker==='decision'?0:task.status==='review'?1:task.status==='blocked'?2:3;

  function mount({getState,api,run,setRoomTab,notice,memberForSeat,confirmAction,showMaterial}) {
    const panel=node('section'),tab=node('button','任务'),toolbar=node('div'),status=node('p'),list=node('div'),detail=node('section');
    panel.id='officeGuidedTasks';panel.dataset.roomPanel='';panel.hidden=true;
    panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby','officeGuidedTaskTab');
    tab.id='officeGuidedTaskTab';tab.type='button';tab.dataset.roomTab=panel.id;
    tab.setAttribute('role','tab');tab.setAttribute('aria-controls',panel.id);tab.setAttribute('aria-selected','false');tab.tabIndex=-1;
    toolbar.className='office-toolbar';list.className='office-task-list';status.setAttribute('role','status');detail.className='office-item';detail.hidden=true;
    document.getElementById('officeTabScene').after(tab);
    document.getElementById('officeView').append(panel);
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

    function reset(){
      roomKey='';version++;detailVersion++;loading=false;dirty=false;paged=false;page=null;filter.value='active';
      list.replaceChildren();detail.replaceChildren();detail.hidden=true;status.textContent='';supervisor.textContent='';more.hidden=true;
      assign.disabled=true;settings.disabled=true;
    }
    reset();
    async function refresh({append=false,force=false}={}) {
      if(!current()||panel.hidden&&!force)return;
      const here=locationKey();
      if(roomKey!==here){reset();roomKey=here;}
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
    function draw(){
      const open=getState().office?.office.state==='active';
      assign.disabled=!open||!memberChoices().length;settings.disabled=!['active','paused'].includes(getState().office?.office.state);
      if(page.supervisorId!==undefined)supervisor.textContent=page.supervisorId?'主管 · '+memberName(page.supervisorId):'尚未指定主管。你可以直接派单。';
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
      form.oninput=()=>{if(view.valid())dirty=true;};
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
          });if(view.valid())dirty=false;}
          catch(error){if(view.valid())message.textContent=error.message;}
          finally{fields.disabled=false;}
        });
      };
    }
    function showSettings() {
      if(!page||page.policyRevision===undefined)return;
      const view=openDetail('主管与验收设置'),revision=page.policyRevision;
      const choice=select([['','暂不指定'],...memberChoices().map(r=>[r.id,r.name])],page.supervisorId??'');
      const mode=select(reviewModes.map(([key,title])=>[key,key==='sample'?'抽查':title]),page.reviewMode??'all');
      const policy=page.riskReview,risk=checkbox(Boolean(policy)),history=checkbox(policy?.useHistory??true),
        requireAudit=checkbox(policy?.requireAudit??true),percent=field(3),controls=node('fieldset');
      percent.type='number';percent.min=0;percent.max=100;percent.step=1;percent.value=String(policy?.samplePercent??25);
      const verifier=select([['','由主管或用户核验'],...memberChoices().map(r=>[r.id,r.name])],policy?.verifierId??'');
      controls.append(label('常规项抽查百分比（全审为 100%）',percent),label('用同类任务的核验履历调整抽查',history),
        label('验收前要求完成必查和抽查',requireAudit),label('独立核验角色（可选）',verifier));
      const toggle=()=>{controls.hidden=!risk.checked;controls.disabled=!risk.checked;};risk.onchange=toggle;toggle();
      view.body.append(node('p','开启后，抽查在提交后确定。任务仍由主管或用户明确验收。'));
      formFor(view,[['主管角色',choice],['复核方式',mode],['开启风险验收',risk],controls],'保存',async()=>{
        const riskReview=risk.checked?{samplePercent:Number(percent.value),useHistory:history.checked,
          requireAudit:requireAudit.checked,verifierId:verifier.value||null}:null;
        await api('guided-tasks/settings',{officeId:scope(),supervisorId:choice.value||null,reviewMode:mode.value,riskReview,expectedRevision:revision});
        if(view.valid()){notice('主管与验收设置已保存。');view.body.replaceChildren();await refresh({force:true});}
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
    return {refresh,openTask,reset,hasDraft:()=>dirty&&roomKey===locationKey()};
  }
  window.MindPondOfficeGuidedTasks={mount};
})();

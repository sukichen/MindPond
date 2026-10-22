/* Human management of role working state; never uses role MCP credentials. */
(() => {
  'use strict';
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const statuses={todo:'待办',doing:'进行中',blocked:'遇到阻塞',waiting:'等待中',done:'已完成',cancelled:'已取消'};
  const summaryFields={goal:'当前目标',progress:'已做到哪里',nextSteps:'接下来做什么',blockers:'阻塞与等待',constraints:'必须遵守的约束'};
  const stamp=value=>new Date(value).toLocaleString();
  function mount({container,role,offices,api,current,notice,confirmAction}){
    const section=node('section');section.className='office-continuity';
    section.append(node('h3','接续工作'),node('p','跟随角色保存，切换聊天后继续使用。任务状态是工作记录，不代表外部验收；历史不会全部加载到新聊天。'));
    const controls=node('div');controls.className='office-continuity-controls';
    const select=node('select');select.setAttribute('aria-label','查看接续工作');
    for(const [value,label] of [['resume','当前工作'],['completed','已完成'],['archived','已封存'],['history','阶段历史']])select.append(new Option(label,value));
    const results=node('div'),feedback=node('p');feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
    let generation=0,next=null,editor=null;
    const officeName=id=>id?'办公室 · '+(offices.find(o=>o.id===id)?.title||id):'角色自己的工作';
    const request=(path,args={})=>api('role/continuity'+path,{roleId:role.id,contextBudgetBytes:32768,...args});
    const act=(label,fn)=>{const b=node('button',label);b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(error){if(current())feedback.textContent=error.message;}finally{b.disabled=false;}};return b;};
    const md=value=>window.MindPondOfficeMarkdown.render(value);
    function sources(items,card){if(!items?.length)return;const d=node('details');d.append(node('summary','来源与版本'));for(const ref of items)d.append(node('p',(ref.kind==='external'?ref.uri:ref.kind+' · '+ref.id)+(ref.revision!==undefined?' · '+ref.revision:'')));card.append(d);}
    function body(record,history=false){
      const box=node('article');box.className='office-continuity-card';
      box.append(node('h4',record.kind==='checkpoint'?officeName(record.officeId):(record.title||'任务')),
        node('p',(record.kind==='task'?(statuses[record.status]||record.status)+' · '+officeName(record.officeId)+' · ':'')+'版本 '+record.revision+' · '+stamp(record.updatedAt)));
      if(record.kind==='checkpoint'){
        for(const [key,label] of Object.entries(summaryFields)){const value=record[key];if(!value?.length)continue;box.append(node('strong',label));if(Array.isArray(value)){const list=node('ul');for(const line of value){const item=node('li');item.append(md(line));list.append(item);}box.append(list);}else box.append(md(value));}
        if(record.changesSinceRecordedAt)box.append(node('p','记录后有 '+record.changesSinceRecordedAt.messages+' 条消息变化、'+record.changesSinceRecordedAt.officeRecords+' 条办公室记录。继续前请核对通信与材料。'));
      }else{box.append(md(record.progress));for(const [key,label] of [['nextSteps','下一步'],['blockers','阻塞与等待']])if(record[key]?.length){box.append(node('strong',label));const list=node('ul');for(const line of record[key]){const item=node('li');item.append(md(line));list.append(item);}box.append(list);}}
      sources(record.sources,box);
      if(!history){const actions=node('div');actions.className='office-continuity-controls';actions.append(act('编辑',()=>edit(record.kind==='checkpoint'?'checkpoint':'task',record)));
        if(record.kind==='task'&&['done','cancelled'].includes(record.status)&&!record.archivedAt)actions.append(act('封存',async()=>{
          if(!await confirmAction('封存此已结束任务？正文与历史保留，可在“已封存”中恢复。'))return;
          await api('role/continuity/archive',{roleId:role.id,tasks:[{id:record.id,expectedRevision:record.revision}],key:crypto.randomUUID(),reason:'人类在角色接续工作页封存已结束任务'});await load();
        }));
        if(record.archivedAt)actions.append(act('恢复到已完成',async()=>{const previousView=select.value;const {id,title,status,priority,progress,nextSteps,blockers,sources}=record;await api('role/continuity/task',{roleId:role.id,...(record.officeId?{officeId:record.officeId}:{}),task:{id,title,status,priority,progress,nextSteps,blockers,sources,expectedRevision:record.revision},reason:'人类恢复已封存记录',key:crypto.randomUUID()});if(!current())return;if(select.value===previousView)select.value='completed';await load();}));
        box.append(actions);
      }return box;
    }
    async function load(more=false){
      const version=++generation,view=select.value;feedback.textContent='正在读取…';moreButton.hidden=true;if(!more){results.replaceChildren();next=null;}
      let result;try{result=await request(view==='resume'?'':view==='history'?'/history':'/tasks',view==='resume'?{cursor:more?next:undefined}:view==='history'?{beforeSeq:more?next:undefined}:{state:view,cursor:more?next:undefined});}catch(error){if(version===generation&&current()){moreButton.hidden=!next;throw error;}return;}
      if(version!==generation||!current())return;
      feedback.textContent='';next=view==='history'?result.nextBeforeSeq:result.nextCursor;
      const records=view==='resume'?[...result.checkpoints,...result.tasks]:result.records;
      if(view==='resume'&&!more){feedback.textContent='已记录 '+result.recordedCheckpoints+' 份摘要 · '+result.activeTasks+' 个未完成任务 · 待处理消息 '+result.attention.pendingMessages+' · 处理中 '+result.attention.processingMessages;
        if(result.attention.controlRequests.length)feedback.textContent+=' · 有用户运行控制请求，请先核对';}
      if(!more&&!records.length)results.append(node('p',view==='resume'?'尚无接续记录。可以先记录目标和下一步；缺失的历史进度需要核对消息与材料。':'此范围暂无记录。'));
      for(const record of records){if(view==='history'){const card=node('details');card.append(node('summary',stamp(record.recordedAt)+' · '+record.reason),body(record.payload,true));results.append(card);}else results.append(body(record));}
      moreButton.hidden=!next;
    }
    async function edit(kind,record={}){
      if(editor?.open){editor.focus();return;}
      const d=node('dialog');editor=d;d.className='office-role-dialog';d.append(node('h2',kind==='checkpoint'?'编辑接续摘要':'编辑任务'));
      const form=node('form'),error=node('p');error.setAttribute('role','alert');d.append(form,error);let dirty=false,saving=false;
      const fields={};const field=(key,label,value='',multiline=false)=>{const wrap=node('label',label),input=node(multiline?'textarea':'input');input.value=value;input.name=key;fields[key]=input;wrap.append(input);form.append(wrap);return input;};
      const owner=node('select');owner.append(new Option('角色自己的工作',''),...offices.map(o=>new Option('办公室 · '+o.title,o.id)));if(record.officeId&&!offices.some(o=>o.id===record.officeId))owner.append(new Option('已删除办公室 · '+record.officeId,record.officeId));owner.value=record.officeId||'';owner.disabled=!!record.revision;
      const ownLabel=node('label','工作范围');ownLabel.append(owner);form.append(ownLabel);
      if(kind==='checkpoint')for(const [key,label] of Object.entries(summaryFields))field(key,label+(Array.isArray(record[key])||['nextSteps','blockers','constraints'].includes(key)?'（每行一项）':''),Array.isArray(record[key])?record[key].join('\n'):record[key]||'',true);
      else{
        field('title','任务名称',record.title||'').required=true;
        const status=node('select');for(const [v,label] of Object.entries(statuses))status.append(new Option(label,v));status.value=record.status||'todo';fields.status=status;const statusLabel=node('label','状态');statusLabel.append(status);form.append(statusLabel);
        const priority=field('priority','优先级（0 最低，3 最高）',record.priority??1);priority.type='number';priority.min='0';priority.max='3';priority.required=true;
        field('progress','实际进度与已验证结果',record.progress||'',true).required=true;field('nextSteps','下一步（每行一项）',(record.nextSteps||[]).join('\n'),true);field('blockers','阻塞与等待（每行一项）',(record.blockers||[]).join('\n'),true);
      }
      const evidence=node('details');evidence.append(node('summary','来源引用（可选）'));const source=node('textarea');source.setAttribute('aria-label','来源引用 JSON');source.value=JSON.stringify(record.sources||[],null,2);evidence.append(node('p','填写实际查看过的来源。例：[{"kind":"external","uri":"repo:src/parser.ts","revision":"实际提交 SHA"}]；也支持 memory、message、material 的实际 id。'),source);form.append(evidence);
      field('reason','本次记录或修改的依据','',true).required=true;
      const submit=node('button','保存');submit.type='submit';submit.className='office-primary';const actions=node('div');actions.className='office-continuity-controls';actions.append(submit,act('取消',()=>close()));form.append(actions);
      let key=crypto.randomUUID(),priorPayload='';const taskId=record.id||crypto.randomUUID();
      async function close(){if(saving)return;if(dirty&&!await confirmAction('放弃尚未保存的接续记录修改？'))return;d.close();}
      form.addEventListener('input',()=>dirty=true);form.addEventListener('change',()=>dirty=true);d.addEventListener('cancel',e=>{e.preventDefault();void close();});d.addEventListener('close',()=>{d.remove();if(editor===d)editor=null;});
      form.onsubmit=async event=>{
        event.preventDefault();if(saving||!form.reportValidity())return;if(!current()){error.textContent='角色详情已关闭，请重新打开后再保存。';return;}
        const multiline=key=>fields[key].value.split('\n').map(v=>v.trim()).filter(Boolean),value=key=>fields[key].value.trim();
        let payload,locked=[];try{
          const sources=JSON.parse(source.value||'[]');
          payload=kind==='checkpoint'?{summary:{goal:value('goal'),progress:value('progress'),nextSteps:multiline('nextSteps'),blockers:multiline('blockers'),constraints:multiline('constraints'),sources},expectedRevision:record.revision??0}:{task:{id:taskId,expectedRevision:record.revision??0,title:value('title'),status:fields.status.value,priority:Number(fields.priority.value),progress:value('progress'),nextSteps:multiline('nextSteps'),blockers:multiline('blockers'),sources}};
          payload={roleId:role.id,...(owner.value?{officeId:owner.value}:{}),...payload,reason:value('reason')};
          const fingerprint=JSON.stringify(payload);if(priorPayload&&priorPayload!==fingerprint){error.textContent='上次提交结果不明确。请先刷新核对实际版本，再重新编辑，避免重复提交。';return;}priorPayload=fingerprint;
          saving=true;locked=[...form.querySelectorAll('input,textarea,select,button')].map(control=>[control,control.disabled]);for(const [control] of locked)control.disabled=true;
          await api('role/continuity/'+kind,{...payload,key});dirty=false;d.close();if(current()){notice('接续记录已保存');await load().catch(failure=>{if(current())feedback.textContent='记录已保存，但列表刷新失败：'+failure.message;});}
        }catch(failure){if(failure.status>=400&&failure.status<500){priorPayload='';key=crypto.randomUUID();}error.textContent=failure.message;}finally{saving=false;for(const [control,disabled] of locked)control.disabled=disabled;}
      };
      document.body.append(d);d.showModal();(fields.goal||fields.title).focus();
    }
    const moreButton=act('继续读取',()=>load(true));moreButton.hidden=true;
    controls.append(select,act('刷新',()=>load()),act('新增摘要',()=>edit('checkpoint')),act('新增任务',()=>edit('task')));
    select.onchange=()=>{void load().catch(error=>{if(current())feedback.textContent=error.message;});};
    section.append(controls,feedback,results,moreButton);container.append(section);
    void load().catch(error=>{if(current())feedback.textContent=error.message;});
  }
  window.MindPondRoleContinuity={mount};
})();

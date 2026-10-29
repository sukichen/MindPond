/* Human-only, explicit preview/apply. No polling replaces selections or drafts. */
(() => {
 'use strict';
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 const button=(text,fn)=>{const b=el('button',text);b.type='button';b.onclick=fn;return b;};
 const label=(text,input)=>{const l=el('label',text);l.append(input);return l;};
 const kinds={memories:'记忆',scripts:'脚本',tasks:'任务',checkpoints:'工作摘要',artifacts:'附件',offices:'办公室'};
 function mount({container,role,api,current,onDirty,onBusy=()=>{},complete}){
  const form=el('form'),fields=el('fieldset'),mode=el('select'),name=el('input'),intro=el('textarea'),target=el('select'),checkpoint=el('select'),picker=el('section'),kind=el('select'),query=el('input'),list=el('div'),chosen=el('p'),status=el('p'),impact=el('section');
  form.className='office-role-reorganization';
  const selected=Object.fromEntries(Object.keys(kinds).map(k=>[k,new Map()]));
  const candidates=new Map();
  let plan=null,busy=false,searchGeneration=0,after=null;
  for(const [value,text] of [['merge','合并到主角色'],['split','拆出新角色']]){const o=el('option',text);o.value=value;mode.append(o);}mode.value='merge';
  for(const [value,text] of [['target','使用主角色当前摘要'],['source','使用来源角色当前摘要']]){const o=el('option',text);o.value=value;checkpoint.append(o);}checkpoint.value='target';
  for(const [value,text] of Object.entries(kinds)){const o=el('option',text);o.value=value;kind.append(o);}kind.value='memories';
  name.value=role.name;name.required=true;name.maxLength=120;intro.value=role.introduction;intro.required=true;intro.maxLength=4000;intro.rows=5;query.type='search';query.maxLength=120;query.placeholder='搜索名称或内容';
  fields.append(label('调整方式',mode),el('p','来源角色：'+role.name));
  const targetLabel=label('保留的主角色',target),cpLabel=label('同范围摘要冲突时',checkpoint);
  fields.append(targetLabel,label('调整后的名字',name),label('调整后的定位与职责',intro),cpLabel);
  const kindLabel=label('选择迁出的内容',kind);kindLabel.hidden=list.hidden=chosen.hidden=true;picker.append(kindLabel);
  const search=button('查找',()=>load(false)),more=button('加载更多',()=>load(true));more.hidden=true;
  const toolbar=el('div');toolbar.className='office-reorganization-search';toolbar.append(query,search);
  picker.append(toolbar,list,more,chosen);
  fields.append(picker);
  const hint=el('p','合并迁移来源角色的全部私有知识、脚本、附件、工作进度和办公室资格；历史消息保留当时署名。操作后相关聊天断开，需要重新连接。记忆不自动去重，办公室共享记忆保持原位。');hint.className='office-hint';fields.append(hint);
  const preview=el('button','预览影响');preview.type='submit';const apply=button('确认并执行',commit);apply.className='office-danger';apply.hidden=true;
  fields.append(preview,impact,apply);status.setAttribute('role','status');form.append(fields,status);container.append(form);
  function invalidate(){plan=null;apply.hidden=true;impact.replaceChildren();onDirty();}
  function selectionSummary(){chosen.textContent=Object.entries(selected).map(([k,m])=>kinds[k]+' '+m.size).join(' · ');}
  async function load(append=false){
   if(!current())return;const generation=++searchGeneration,which=mode.value==='merge'?'roles':kind.value,cursor=append?after:null;
   more.disabled=true;search.disabled=true;status.textContent='正在读取…';
   try{
    const p=await api('role/reorganization/choices',{roleId:role.id,kind:which,query:query.value.trim(),...(cursor!==null?{after:cursor}:{})});
    if(!current()||generation!==searchGeneration)return;
    const output=which==='roles'?target:list;if(!append){output.replaceChildren();if(which==='roles'){const blank=el('option','请选择主角色');blank.value='';output.append(blank);target.value='';}}
    for(const item of p.records){
     if(which==='roles'){const o=el('option',item.label);o.value=item.id;output.append(o);candidates.set(item.id,item);}
     else {const c=el('input');c.type='checkbox';c.checked=selected[which].has(item.id);c.onchange=()=>{if(c.checked)selected[which].set(item.id,item.label);else selected[which].delete(item.id);selectionSummary();invalidate();};const row=label(item.label+' · '+item.detail,c);row.className='office-reorganization-option';output.append(row);}
    }
    after=p.nextAfter;more.hidden=!p.hasMore;status.textContent=p.records.length?'':'没有匹配内容。';
   }catch(e){if(current()&&generation===searchGeneration)status.textContent=e.message;}
   finally{if(current()&&generation===searchGeneration){more.disabled=false;search.disabled=false;}}
  }
  mode.onchange=()=>{invalidate();query.value='';targetLabel.hidden=cpLabel.hidden=mode.value!=='merge';kindLabel.hidden=list.hidden=chosen.hidden=mode.value!=='split';hint.textContent=mode.value==='merge'?'合并后来源角色退出目录，历史署名保留。两个角色均断开聊天连接。':'只迁移选中内容，新角色暂不连接聊天。选择办公室会为新角色增加成员资格，原角色仍保留资格；跨角色关联会断开，预览会列出数量。原角色也会断开连接。';void load();};
  kind.onchange=()=>void load();target.onchange=()=>{const option=[...target.children].find(n=>n.value===target.value);if(option&&target.value){name.value=option.textContent;intro.value=candidates.get(target.value)?.detail??role.introduction;}invalidate();};checkpoint.onchange=invalidate;name.oninput=intro.oninput=invalidate;
  query.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void load();}});
  form.addEventListener('submit',async e=>{
   e.preventDefault();if(busy||search.disabled||!current()||!form.reportValidity())return;
   invalidate();busy=true;fields.disabled=true;status.textContent='正在核对影响…';searchGeneration++;
   try{
    const i={mode:mode.value,sourceId:role.id,name:name.value.trim(),introduction:intro.value.trim()};
    if(i.mode==='merge'){if(!target.value)throw Error('请选择主角色。');Object.assign(i,{targetId:target.value,checkpointChoice:checkpoint.value});}
    else Object.assign(i,{memoryIds:[...selected.memories.keys()],scriptIds:[...selected.scripts.keys()],taskIds:[...selected.tasks.keys()],checkpointScopes:[...selected.checkpoints.keys()],artifactIds:[...selected.artifacts.keys()],officeIds:[...selected.offices.keys()]});
    const p=await api('role/reorganization/preview',i);if(!current())return;plan=p;
    const heading=el('h3','影响预览'),counts=el('dl');
    const labels={memories:'迁移记忆',scripts:'迁移脚本',tasks:'迁移任务',checkpoints:'迁移工作摘要',artifacts:'迁移附件',offices:'目标办公室',cutAssociations:'断开关联',cutEdges:'断开引用边',checkpointConflicts:'摘要冲突'};
    for(const [key,text] of Object.entries(labels)){counts.append(el('dt',text),el('dd',String(p.counts[key]??0)));}
    impact.replaceChildren(heading,el('p',role.name+' → '+(p.target?.name??p.name)),counts,el('p',p.notice));
    if(p.blockers.length){for(const b of p.blockers)impact.append(el('p',b));status.textContent='请先处理以上事项，再重新预览。';}else {apply.hidden=false;status.textContent='预览有效期 15 分钟。期间内容变化时，需要重新预览。';}
   }catch(e){if(current())status.textContent=e.message;}
   finally{busy=false;if(current())fields.disabled=false;}
  });
  async function commit(){
   if(!plan||plan.blockers.length||busy||!current())return;busy=true;onBusy(true);fields.disabled=true;status.textContent='正在执行，请勿关闭页面…';
   try{const r=await api('role/reorganization/apply',{previewId:plan.previewId});if(current())await complete(r);}
   catch(e){if(current()){status.textContent=e.message;/* Retain the plan for a lost-response retry; server apply is idempotent. */}}
   finally{busy=false;onBusy(false);if(current())fields.disabled=false;}
  }
  selectionSummary();void load();
 }
 window.MindPondRoleReorganization={mount};
})();

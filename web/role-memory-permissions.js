/* Human-only, independent-version memory grants. No role/profile form mutation. */
(() => {
 'use strict';
 const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 function mount({container,roleId,api,current,canEdit=()=>true,onBusy=()=>{}}){
  const root=node('section'),status=node('p'),read=node('input'),organize=node('input'),refresh=node('button','刷新权限'),retry=node('button','重试保存');
  root.className='office-role-memory-permissions';read.type=organize.type='checkbox';refresh.type=retry.type='button';retry.hidden=true;
  const readLabel=node('label','允许查阅其他角色记忆'),organizeLabel=node('label','允许替其他角色整理记忆');readLabel.prepend(read);organizeLabel.prepend(organize);
  read.setAttribute('aria-label','允许查阅其他角色记忆');organize.setAttribute('aria-label','允许替其他角色整理记忆');status.setAttribute('role','status');
  root.append(node('h3','记忆权限'),node('p','默认关闭。授权范围为同一账户下其他角色的私人记忆；角色操作时须明确选择对象。整理包含新增、修改、删除及关联调整。不会开放人类记忆、对方的办公室记忆、聊天、脚本或接续任务。'),readLabel,organizeLabel,node('small','更改后自动保存；开启整理会同时开启查阅，关闭查阅会同时撤销整理。合并或拆分角色后需重新授权。'),status,refresh,retry);container.append(root);
  let policy=null,busy=false,request=0,pending=null;
  const render=()=>{read.checked=!!policy?.readOthers;organize.checked=!!policy?.organizeOthers;read.disabled=organize.disabled=busy||!policy;refresh.disabled=busy;retry.disabled=busy;};
  const error=e=>[e.message||String(e),e.nextAction].filter(Boolean).join(' · ');
  async function load(){if(busy||!current())return;const own=++request;read.disabled=organize.disabled=true;status.textContent='正在读取权限…';try{const result=await api('role/memory-permissions',{action:'get',roleId});if(own!==request||!current())return;if(!policy||result.revision>=policy.revision)policy=result;pending=null;retry.hidden=true;status.textContent='开关仅由你控制；角色不能自行授权。';}catch(e){if(own===request&&current())status.textContent=error(e);}finally{if(own===request&&current())render();}}
  async function save(payload){if(busy||!current()||!canEdit()){if(current())render();return;}const own=++request;busy=true;pending=payload;render();onBusy(true);status.textContent='正在保存权限…';try{const result=await api('role/memory-permissions',payload);if(own!==request||!current())return;policy=result;pending=null;retry.hidden=true;status.textContent='权限已保存，后续操作按新权限校验。';}catch(e){if(current()){const final=e.status>=400&&e.status<500;status.textContent=error(e)+(final?' · 请刷新核对实际权限。':' · 可重试同一设置，或刷新核对实际权限。');if(final)pending=null;retry.hidden=final;}}finally{busy=false;if(current()){render();onBusy(false);}}}
  read.onchange=()=>{if(policy)void save({action:'set',roleId,readOthers:read.checked,organizeOthers:read.checked&&organize.checked,expectedRevision:policy.revision});};
  organize.onchange=()=>{if(policy)void save({action:'set',roleId,readOthers:read.checked||organize.checked,organizeOthers:organize.checked,expectedRevision:policy.revision});};
  refresh.onclick=()=>void load();retry.onclick=()=>{if(pending)void save(pending);};render();void load();
 }
 window.MindPondRoleMemoryPermissions={mount};
})();

/* Human policy editor. Polling never replaces an unsaved draft or another login. */
(()=>{'use strict';
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 function mount({container,api,current,onSaved=()=>{}}){
  let policy=null,dirty=false,busy=false,pending=null,draftRevision=null;const form=el('form'),fields=el('fieldset'),input=el('input'),save=el('button','保存等待设置'),reload=el('button','重新读取设置'),status=el('p');
  form.className='office-reply-wait-policy';fields.className='office-fields';input.type='number';input.min='0';input.max='300';input.step='1';input.required=true;input.value='0';input.setAttribute('aria-label','最短等待窗口（秒）');save.type='submit';reload.type='button';status.setAttribute('role','status');
  const label=el('label','最短等待窗口（秒）');label.append(input);fields.append(label,save,reload);
  form.append(el('h3','发信后等待反馈'),el('p','角色发送消息时可选择同时等待回复。这里设置所有角色的最短等待窗口：例如填 300，角色请求等 10 秒时也会按 5 分钟等待；收到发给该角色的新消息即可立即返回，并直接交付完整消息；新消息不一定是原消息的答复。'),fields,el('p','0 表示不设下限，最高 300 秒（5 分钟）。只影响之后开始的“发送并等待”，不强制所有消息等待。人类停止、权限变化或连接中断仍可终止等待。'),status);container.replaceChildren(form);
  const showPolicy=()=>{if(!policy)return;input.value=String(policy.minimumSeconds);dirty=false;pending=null;draftRevision=null;status.textContent=policy.minimumSeconds?'当前最短等待窗口：'+policy.minimumSeconds+' 秒。':'当前未设置最短等待窗口。';};
  function update(value){if(!current()||!value||policy&&value.revision<policy.revision)return;const changed=policy&&value.revision!==policy.revision;policy=value;input.max=String(policy.maximumSeconds);if(!dirty&&!busy)showPolicy();else if(changed&&!busy)status.textContent='设置已被其他操作更新。你的草稿仍保留；请重新读取后再保存。';}
  input.addEventListener('input',()=>{if(!dirty)draftRevision=policy?.revision??null;dirty=true;status.textContent='有尚未保存的等待设置。';});
  async function reloadPolicy(){if(busy||!current())return;busy=true;fields.disabled=true;try{const value=await api('reply-wait-policy',{action:'get'});if(!current())return;policy=value;showPolicy();}catch(e){if(current())status.textContent=e.message;}finally{busy=false;if(current())fields.disabled=false;}}
  reload.onclick=reloadPolicy;
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(busy||!current()||!policy||!form.reportValidity())return;
   const minimumSeconds=Number(input.value);if(!Number.isInteger(minimumSeconds)||minimumSeconds<0||minimumSeconds>policy.maximumSeconds){status.textContent='请填写 0 至 '+policy.maximumSeconds+' 的整数秒数。';return;}
   if(!pending||pending.minimumSeconds!==minimumSeconds)pending={action:'set',minimumSeconds,expectedRevision:draftRevision??policy.revision};
   const payload={...pending};busy=true;fields.disabled=true;status.textContent='正在保存…';
   try{const result=await api('reply-wait-policy',payload);if(!current())return;if(policy.revision<=result.revision){policy=result;dirty=false;pending=null;draftRevision=null;input.value=String(result.minimumSeconds);status.textContent='已保存；之后开始的发送等待按此下限执行。';}else status.textContent='保存后设置再次变化，请重新读取最新值。';await onSaved(result);}
   catch(e){if(current())status.textContent=e.message+(e.code==='stale_version'?' 请重新读取设置。':' 草稿已保留；重试会使用同一次保存参数。');}
   finally{busy=false;if(current())fields.disabled=false;}
  });
  return {update,hasDraft:()=>dirty||busy};
 }
 window.MindPondOfficeReplyWait={mount};
})();

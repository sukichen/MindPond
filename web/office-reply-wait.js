/* Human policy editor. Polling never replaces an unsaved draft or another login. */
(()=>{
 'use strict';
 const el=(tag,text)=>{
  const node=document.createElement(tag);
  if(text!==undefined)node.textContent=text;
  return node;
 };

 function mount({container,api,current,onSaved=()=>{}}){
  let policy=null,dirty=false,busy=false,pending=null,draftPolicy=null;
  const form=el('form'),fields=el('fieldset'),toggle=el('input'),input=el('input');
  const save=el('button','保存等待设置'),reload=el('button','重新读取设置'),status=el('p');

  form.className='office-reply-wait-policy';
  fields.className='office-fields';
  fields.disabled=true;
  toggle.type='checkbox';
  const toggleLabel=el('label');
  toggleLabel.className='office-reply-wait-toggle';
  toggleLabel.append(toggle,el('span','允许角色发信后自动等待'));

  input.type='number';
  input.min='0';
  input.max='300';
  input.step='1';
  input.required=true;
  input.value='0';
  const label=el('label','最短等待窗口（秒）');
  label.append(input);

  save.type='submit';
  reload.type='button';
  status.setAttribute('role','status');
  fields.append(toggleLabel,label,save,reload);
  form.append(
   el('h3','发信后等待反馈'),
   el('p','关闭并保存后，角色发完消息就返回，正在等待的发信也会结束等待。'),
   fields,
   el('p','开启后，角色可以随发信请求等待。收到新收件即返回完整消息。最短等待窗口设为 0 表示不设下限，最高可设 300 秒。'),
   status
  );
  container.replaceChildren(form);

  function showPolicy(){
   toggle.checked=policy.enabled!==false;
   input.disabled=!toggle.checked;
   input.value=String(policy.minimumSeconds);
   dirty=false;
   pending=null;
   draftPolicy=null;
   status.textContent=toggle.checked
    ? '发信后自动等待已开启。最短等待窗口为 '+policy.minimumSeconds+' 秒。'
    : '发信后自动等待已关闭。';
  }

  function update(value){
   if(!current()||!value||policy&&value.revision<policy.revision)return;
   const changed=policy&&value.revision!==policy.revision;
   policy=value;
   input.max=String(policy.maximumSeconds);
   if(!busy){
    fields.disabled=false;
    if(!dirty)showPolicy();
    else if(changed)status.textContent='设置已被其他操作更新。你的草稿仍保留，请重新读取后再保存。';
   }
  }

  function markDraft(){
   if(!dirty)draftPolicy=policy;
   dirty=true;
   status.textContent='有尚未保存的等待设置。';
  }
  input.addEventListener('input',markDraft);
  toggle.addEventListener('change',()=>{
   input.disabled=!toggle.checked;
   markDraft();
  });

  reload.onclick=async()=>{
   if(busy||!current())return;
   busy=true;
   fields.disabled=true;
   try{
    const value=await api('reply-wait-policy',{action:'get'});
    if(!current())return;
    if(!policy||value.revision>=policy.revision)policy=value;
    showPolicy();
   }catch(e){
    if(current())status.textContent=e.message;
   }finally{
    busy=false;
    if(current())fields.disabled=false;
   }
  };

  form.addEventListener('submit',async event=>{
   event.preventDefault();
   if(busy||!current()||!policy||!form.reportValidity())return;
   const enabled=toggle.checked;
   const base=draftPolicy??policy;
   const minimumSeconds=enabled?Number(input.value):base.minimumSeconds;
   if(!Number.isInteger(minimumSeconds)||minimumSeconds<0||minimumSeconds>policy.maximumSeconds){
    status.textContent='请填写 0 至 '+policy.maximumSeconds+' 的整数秒数。';
    return;
   }
   if(!pending||pending.enabled!==enabled||pending.minimumSeconds!==minimumSeconds){
    pending={action:'set',enabled,minimumSeconds,expectedRevision:base.revision};
   }
   busy=true;
   fields.disabled=true;
   status.textContent='正在保存…';
   try{
    const result=await api('reply-wait-policy',{...pending});
    if(!current())return;
    if(policy.revision<=result.revision){
     policy=result;
     showPolicy();
    }else{
     status.textContent='保存后设置再次变化，请重新读取最新值。';
    }
    await onSaved(result);
   }catch(e){
    if(current())status.textContent=e.message+(e.code==='stale_version'
     ? ' 请重新读取设置。'
     : ' 草稿已保留，重试会使用同一次保存参数。');
   }finally{
    busy=false;
    if(current())fields.disabled=false;
   }
  });
  return {update,hasDraft:()=>dirty||busy};
 }
 window.MindPondOfficeReplyWait={mount};
})();

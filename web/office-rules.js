/* Small human-only editor; polling never replaces an unsaved rule draft. */
(() => {
 'use strict';
 const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 function mount({getState,api,notice,confirmAction}){
  let editor=null;
  const hasDraft=()=>Boolean(editor?.dirty);
  const reset=()=>{if(editor){const old=editor;editor=null;old.dialog.close();old.dialog.remove();}};
  async function open(office){
   if(editor){editor.dialog.focus();return;}
   const state=getState();if(!state.logged)return;
   const d=node('dialog'),header=node('header'),title=node('h2','办公室守则'),close=node('button','✕'),form=node('form'),fields=node('fieldset'),cards=node('div'),status=node('p'),counter=node('p');
   const e={dialog:d,epoch:state.authEpoch,officeId:office.id,revision:0,dirty:false,saving:false,loading:true,ticket:0,defaults:[],levels:[],draft:[]};editor=e;
   d.className='office-role-dialog office-rules-editor';d.setAttribute('aria-label','办公室守则 · '+office.title);close.type='button';close.setAttribute('aria-label','关闭办公室守则');header.append(title,close);
   status.setAttribute('role','status');status.setAttribute('aria-live','polite');counter.className='office-hint';fields.disabled=true;
   const hint=node('p','每条守则可单独设置频率。首次通信、守则更新或换绑聊天后提醒，此后按角色的成功通信返回次数计数；空收件箱和等待超时不计数。');hint.className='office-hint';
   const boundary=node('p','守则随 MCP 返回单独呈现，不改写消息、不自动执行 Memory，也不增加权限。提醒不能保证模型遵守。');boundary.className='office-hint';
   const controls=node('div'),add=node('button','＋ 添加守则'),restore=node('button','恢复默认守则'),save=node('button','保存守则'),reload=node('button','重新载入');
   for(const b of [add,restore,reload])b.type='button';save.type='submit';save.className='office-primary';controls.className='office-toolbar';controls.append(add,restore,save);reload.hidden=true;
   fields.append(cards,counter,controls);form.append(fields);d.append(header,node('p',office.title),hint,form,boundary,status,reload);document.body.append(d);d.showModal();
   const current=()=>editor===e&&getState().logged&&getState().authEpoch===e.epoch;
   const message=error=>{if(current())status.textContent=[error.message||String(error),error.nextAction].filter(Boolean).join(' · ');};
   const changed=()=>{e.dirty=true;d.dataset.dirty='true';count();};
   function count(){const bytes=e.draft.reduce((sum,r)=>sum+new TextEncoder().encode(r.text.trim()).length,0);counter.textContent=e.draft.length+' / 8 条 · 正文 '+bytes+' / 2048 字节';add.disabled=e.draft.length>=8;}
   function render(){cards.replaceChildren();for(const r of e.draft){const card=node('section'),name=node('input'),frequency=node('select'),text=node('textarea'),remove=node('button','删除此守则');card.className='office-rule-card';name.value=r.title;name.maxLength=40;name.required=true;text.value=r.text;text.rows=5;text.maxLength=1000;text.required=true;
     for(const level of e.levels){const o=node('option',level.label);o.value=level.id;frequency.append(o);}frequency.value=r.frequency;
     const label=(caption,control)=>{const wrap=node('label',caption);wrap.append(control);return wrap;};
     name.addEventListener('input',()=>{r.title=name.value;changed();});text.addEventListener('input',()=>{r.text=text.value;changed();});frequency.addEventListener('change',()=>{r.frequency=frequency.value;changed();});
     remove.type='button';remove.className='office-danger';remove.onclick=()=>{e.draft=e.draft.filter(item=>item!==r);changed();render();};
     card.append(label('守则名称',name),label('提醒频率',frequency),label('守则内容',text),remove);cards.append(card);
    }if(!e.draft.length)cards.append(node('p','暂无守则，不会注入提醒。'));count();}
   async function load(){const ticket=++e.ticket;fields.disabled=true;e.loading=true;status.textContent='正在读取守则…';try{const value=await api('rules',{action:'get',officeId:e.officeId});if(!current()||ticket!==e.ticket)return;e.revision=value.revision;e.defaults=value.defaults;e.levels=value.levels;e.draft=value.rules.map(r=>({...r}));e.dirty=false;delete d.dataset.dirty;render();status.textContent='修改只在保存后生效。';reload.hidden=true;}catch(error){message(error);reload.hidden=false;}finally{if(current()&&ticket===e.ticket){e.loading=false;fields.disabled=!e.levels.length;}}}
   async function discard(){if(e.saving)return;if(e.dirty&&!await confirmAction('放弃尚未保存的办公室守则？'))return;if(editor===e)reset();}
   close.onclick=discard;d.addEventListener('cancel',event=>{event.preventDefault();void discard();});
   add.onclick=()=>{if(e.draft.length>=8)return;e.draft.push({id:crypto.randomUUID(),title:'新守则',text:'',frequency:'balanced'});changed();render();};
   restore.onclick=async()=>{if(e.dirty&&!await confirmAction('用默认守则替换当前未保存的草稿？'))return;if(!current())return;e.draft=e.defaults.map(r=>({...r}));changed();render();};
   reload.onclick=async()=>{if(e.dirty&&!await confirmAction('重新载入会替换未保存的守则草稿，继续？'))return;if(current())await load();};
   form.addEventListener('submit',async event=>{event.preventDefault();if(e.saving||e.loading||!current())return;if(!form.reportValidity())return;
    const rules=e.draft.map(r=>({...r,title:r.title.trim(),text:r.text.trim()}));if(rules.reduce((sum,r)=>sum+new TextEncoder().encode(r.text).length,0)>2048){message(Error('守则正文合计不能超过 2048 字节，请缩短内容。'));return;}
    e.saving=true;fields.disabled=true;close.disabled=true;status.textContent='正在保存…';try{const result=await api('rules',{action:'save',officeId:e.officeId,expectedRevision:e.revision,rules});if(!current())return;e.revision=result.revision;e.draft=result.rules.map(r=>({...r}));e.dirty=false;delete d.dataset.dirty;render();status.textContent='已保存，下次符合条件的通信返回时生效。';notice('办公室守则已保存。');reload.hidden=true;}catch(error){message(error);reload.hidden=false;}finally{e.saving=false;if(editor===e){fields.disabled=!current();close.disabled=false;if(!current())status.textContent='管理会话已变化，请关闭后重新打开。草稿未提交。';}}
   });
   await load();
  }
  return {open,hasDraft,reset};
 }
 window.MindPondOfficeRules={mount};
})();

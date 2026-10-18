/* Office scene: visual effects consume real events; preview never writes business data. */
(() => {
  'use strict';
  const labels={inform:'通知',request:'请求答复',reply:'回复',read:'阅读消息',accepted:'整理收件箱',item_claim:'领取任务',item_submit:'提交材料',item_verify:'反馈结果',item_create:'安排任务',item_renew:'续租',wait_pose:'等待消息',rest_pose:'休息',work_pose:'处理事情',message:'发送消息',message_read:'阅读消息',message_archive:'整理收件箱',material_read:'阅读材料',material_published:'放好材料',container:'整理容器',progress:'报告进展',claim:'领取工作',submit:'提交材料',verify:'反馈结果'};
  const catalog={
    reading:[{id:'book',label:'翻阅资料'},{id:'screen',label:'对照屏幕'},{id:'note',label:'做摘记'}],
    working:[{id:'typing',label:'键入内容'},{id:'note',label:'写便签'},{id:'think',label:'思考'}],
    waiting:[{id:'sip',label:'喝口水'},{id:'watch',label:'看时间'},{id:'stretch',label:'活动肩膀'}],
    resting:[{id:'sip',label:'喝水'},{id:'stretch',label:'伸懒腰'},{id:'relax',label:'放松'}],
    communicating:[{id:'wave',label:'挥手示意'},{id:'letter',label:'递交信件'},{id:'nod',label:'点头回应'}]
  };
  const stateFor=kind=>['material_read','message_read','read'].includes(kind)?'reading':['wait_pose','wait_started'].includes(kind)?'waiting':kind==='rest_pose'?'resting':['message','inform','request','reply'].includes(kind)?'communicating':'working';
  function props(person){
    const station=document.createElement('span');station.className='office-workstation';station.setAttribute('aria-hidden','true');
    // All markup here is fixed geometry. User names/content are rendered through textContent elsewhere.
    station.innerHTML='<span class="office-chair"></span><span class="office-monitor"><i></i></span><span class="office-table"></span><span class="office-keyboard"></span><span class="office-cup"></span><span class="office-paper-stack"></span>';
    person.innerHTML='<svg viewBox="0 0 66 94" aria-hidden="true"><g class="avatar-legs"><path d="M25 64v19m18-19v19" stroke="#4b5b5c" stroke-width="11" stroke-linecap="round"/><path d="M21 85h9m9 0h9" stroke="#344341" stroke-width="8" stroke-linecap="round"/></g><path d="M16 45q17-13 34 0v24H16z" fill="currentColor"/><path class="avatar-arm left" d="M16 47l-6 19" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><path class="avatar-arm right" d="M50 47l6 19" stroke="currentColor" stroke-width="10" stroke-linecap="round"/><g class="avatar-head"><circle cx="33" cy="24" r="19" fill="#dfbc96"/><path d="M14 23Q11 0 33 3q24 0 19 23l-8-13-22 6z" fill="#4a5143"/><circle cx="26" cy="25" r="2" fill="#37443b"/><circle cx="40" cy="25" r="2" fill="#37443b"/><path d="M29 33q4 4 8 0" fill="none" stroke="#a8755b" stroke-width="2" stroke-linecap="round"/></g><g class="avatar-item avatar-book"><path d="M12 46l21 4 21-4v24l-21 4-21-4z" fill="#e7ead6" stroke="#7f9b71" stroke-width="2"/><path d="M33 50v24" stroke="#7f9b71"/></g><g class="avatar-item avatar-note"><rect x="19" y="48" width="28" height="24" rx="2" fill="#fff3b9"/><path d="M24 54h17m-17 6h14m-14 6h10" stroke="#bba96d" stroke-width="2"/><path d="M44 47l-9 17" stroke="#596e87" stroke-width="3"/></g><g class="avatar-item avatar-mug"><path d="M29 33h17v15q-8 6-17 0z" fill="#87ada6"/><path d="M45 35q13 0 2 10" fill="none" stroke="#668d86" stroke-width="3"/></g><g class="avatar-item avatar-think"><circle cx="55" cy="9" r="10" fill="#fff6d8"/><path d="M48 19l-4 5" stroke="#cdbd83"/><circle cx="51" cy="9" r="1.5"/><circle cx="55" cy="9" r="1.5"/><circle cx="59" cy="9" r="1.5"/></g><g class="avatar-item avatar-watch"><circle cx="14" cy="52" r="7" fill="#fff9df" stroke="#6e8582" stroke-width="2"/><path d="M14 48v5l3 2" fill="none" stroke="#6e8582"/></g><g class="avatar-item avatar-laptop"><path d="M12 50h42v23H12z" fill="#6f8e8b" stroke="#456c67" stroke-width="2"/><path d="M20 55h26v12H20z" fill="#bbd5bc"/></g><g class="avatar-item avatar-letter"><path d="M15 47h36v25H15z" fill="#fff9e9" stroke="#b5a275" stroke-width="2"/><path d="M16 48l17 13 17-13" fill="none" stroke="#b5a275"/></g></svg>';
    station.append(person);return station;
  }
  class Scene {
    constructor(root,wires,status,scale){
      Object.assign(this,{root,wires,status,scale,epoch:0,queue:[],running:false,animations:new Set(),motion:true,list:false,seen:new Set(),replaying:false,variants:new Map(),waiting:[],waitTimer:null});
      document.body.classList.toggle('office-hidden',document.hidden);this.media=window.matchMedia('(prefers-reduced-motion: reduce)');this.media.addEventListener('change',()=>this.stop());
      document.addEventListener('visibilitychange',()=>{document.body.classList.toggle('office-hidden',document.hidden);if(document.hidden){if(this.replaying){this.pauseReplay();this.onReplayVisibility?.();}else this.stop();}});
    }
    reset(){this.stop();this.seen.clear();this.variants.clear();this.waiting=[];clearTimeout(this.waitTimer);this.waitTimer=null;}
    stop(){this.epoch++;this.queue=[];this.running=false;this.waiting=[];clearTimeout(this.waitTimer);this.waitTimer=null;for(const a of this.animations)a.cancel();this.animations.clear();this.wires.replaceChildren();this.root.classList.remove('replay-paused');for(const n of this.root.querySelectorAll('.is-live,.has-motion,.is-walking'))n.classList.remove('is-live','has-motion','is-walking');for(const n of this.root.querySelectorAll('.office-action-bubble'))n.remove();for(const n of this.root.querySelectorAll('.office-person'))delete n.dataset.pose;this.status.textContent=this.replaying?'历史回放已暂停。':'人物动作来自新交互；静止不代表宿主离线。';}
    enabled(){return this.motion&&!this.list&&!this.media.matches&&!document.hidden;}
    setMotion(on){this.motion=on;this.root.classList.toggle('motion-off',!on);if(!on)this.stop();}
    beginReplay(){this.stop();this.replaying=true;this.root.classList.add('is-replaying');this.status.textContent='历史回放 · 已就绪（未播放）';}
    endReplay(){this.stop();this.replaying=false;this.root.classList.remove('is-replaying');this.status.textContent='人物动作来自新交互；静止不代表宿主离线。';}
    pauseReplay(){for(const a of this.animations)a.pause();this.root.classList.add('replay-paused');}
    resumeReplay(){for(const a of this.animations)a.play();this.root.classList.remove('replay-paused');}
    setReplayRate(rate){for(const a of this.animations)a.updatePlaybackRate(rate);}
    replayEvent(e,options){return this.play({...e,replay:true,...options},this.epoch);}
    present(events,{demo=false}={}){
      if(this.replaying||!this.enabled())return;
      for(const e of events){if(!demo){if(this.seen.has(e.seq))continue;this.seen.add(e.seq);if(this.seen.size>500)this.seen.delete(this.seen.values().next().value);if(!Number.isFinite(e.ts)||Date.now()-e.ts>15000||e.ts>Date.now()+1000)continue;}if(!labels[e.kind])continue;this.queue.push({...e,demo});}
      this.queue=this.queue.slice(-8);if(!this.running)void this.drain(this.epoch);
    }
    async drain(epoch){this.running=true;try{while(this.queue.length&&epoch===this.epoch&&this.enabled()&&!this.replaying)await this.play(this.queue.shift(),epoch);}finally{if(epoch===this.epoch){this.running=false;this.status.textContent='人物动作来自新交互；静止不代表宿主离线。';}}}
    syncWaiting(waiting){this.waiting=waiting;if(!waiting.length){clearTimeout(this.waitTimer);this.waitTimer=null;return;}if(!this.waitTimer)this.waitTimer=setTimeout(()=>{this.waitTimer=null;void this.waitPose();},3000);}
    async waitPose(){const valid=this.waiting.filter(w=>w.until>Date.now());if(valid.length&&this.enabled()&&!this.replaying&&!this.running){const role=valid.shift();valid.push(role);this.waiting=valid;this.running=true;const epoch=this.epoch;await this.play({kind:'wait_pose',actorKey:role.key,localState:true},epoch);if(epoch===this.epoch){this.running=false;if(this.queue.length)void this.drain(epoch);}}this.syncWaiting(this.waiting.filter(w=>w.until>Date.now()));}
    async play(e,epoch){
      if(!e.demo&&!e.replay&&!e.localState&&Date.now()-e.ts>15000)return 'cancelled';
      const nodes=[...this.root.querySelectorAll('.office-desk')],body=e.body??{};
      const from=nodes.find(n=>(e.actorKey&&n.dataset.replayKey===e.actorKey)||n.dataset.seat===e.seat_id||n.dataset.role===(body.sender??e.actor?.roleId));
      if(!from){if(e.replay)return this.clock(e,epoch);return 'completed';}
      const to=nodes.find(n=>n.dataset.seat===body.recipient||n.dataset.role===body.recipient||(e.recipientKey&&n.dataset.replayKey===e.recipientKey)),person=from.querySelector('.office-person');
      if(!person)return e.replay?this.clock(e,epoch):'completed';
      const name=from.querySelector('strong')?.textContent??'角色',label=labels[e.kind]??e.kind;
      this.status.textContent=(e.replay?'历史回放：':e.localState?'等待窗口内：':e.demo?'动画演示（不发送消息、不启动 agent）：':'刚刚：')+name+' · '+label;
      const bubble=document.createElement('span');bubble.className='office-action-bubble';bubble.textContent=(e.demo?'演示 · ':'')+label;from.append(bubble);from.classList.add('has-motion','is-live');
      const start=person.getBoundingClientRect(),s=this.scale();
      let frames,duration=2000;
      if(this.enabled()&&to&&to!==from&&['message','inform','request','reply'].includes(e.kind)){
        const nav=window.MindPondOfficeNavigation,room=this.root.getBoundingClientRect();
        const box=n=>{const r=n.getBoundingClientRect();return {left:(r.left-room.left)/s,top:(r.top-room.top)/s,right:(r.left+r.width-room.left)/s,bottom:(r.top+r.height-room.top)/s};};
        const a=box(person),target=box(to.querySelector('.office-person')),origin={x:(a.left+a.right)/2,y:(a.top+a.bottom)/2},end={x:(target.left+target.right)/2,y:(target.top+target.bottom)/2};
        const halfWidth=(a.right-a.left)/2,halfHeight=(a.bottom-a.top)/2;
        const obstacles=[...this.root.querySelectorAll('.office-table,.office-chair,.office-monitor,.office-room-door,.office-room-lounge'),...nodes.filter(n=>n!==from).map(n=>n.querySelector('.office-person'))].map(box);
        const options={bounds:{left:12,top:28,right:room.width/s-12,bottom:room.height/s-12},obstacles,halfWidth,halfHeight,clearance:12};
        const dx=halfWidth+(target.right-target.left)/2+26,dy=halfHeight+(target.bottom-target.top)/2+26;
        const goals=[{x:end.x-dx,y:end.y},{x:end.x+dx,y:end.y},{x:end.x,y:end.y-dy},{x:end.x,y:end.y+dy}];
        const length=path=>path.reduce((n,p,i)=>n+(i?Math.hypot(p.x-path[i-1].x,p.y-path[i-1].y):0),0);
        let route;
        for(const goal of goals.sort((a,b)=>Math.hypot(a.x-origin.x,a.y-origin.y)-Math.hypot(b.x-origin.x,b.y-origin.y))){route=nav.planRoute(origin,goal,options);if(route)break;}
        if(!route){bubble.textContent=(e.demo?'演示 · ':'')+'通道不足，原地等待';this.status.textContent=bubble.textContent;frames=[{transform:'none'},{transform:'none'}];}
        else{
          from.classList.add('is-walking');frames=nav.framesForRoute(route,origin);duration=Math.max(2600,Math.min(14000,length(route)/100*2000+700));
          const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',route.map((p,i)=>(i?'L':'M')+p.x+' '+p.y).join(' '));this.wires.append(path);
        }
      }else frames=[{transform:'translateY(0)'},{transform:'translateY(-5px)'},{transform:'translateY(0)'}];
      duration=e.durationMs??duration;
      if(!this.enabled()){frames=[{},{}];from.classList.remove('is-walking');this.wires.replaceChildren();}
      const state=stateFor(e.kind),choices=catalog[state],key=(e.actorKey??from.dataset.role??from.dataset.seat)+':'+state;
      const seed=e.replay?(e.seq??0)%choices.length:this.variants.get(key)??0;this.variants.set(key,(seed+1)%choices.length);
      const animation=person.animate(frames,{duration,easing:'linear'});animation.updatePlaybackRate(e.rate??1);this.animations.add(animation);
      let last=-1;const tick=()=>{const elapsed=Number(animation.currentTime??0),phase=Math.floor(elapsed/2000),pose=choices[(seed+phase)%choices.length];if(last!==phase){last=phase;person.dataset.pose=pose.id;bubble.textContent=(e.replay?'回放 · ':e.demo?'演示 · ':'')+label+' · '+pose.label;}e.onProgress?.(Math.min(1,elapsed/duration));};tick();const timer=setInterval(tick,120);
      let result='completed';try{await animation.finished;}catch{result='cancelled';}finally{clearInterval(timer);this.animations.delete(animation);animation.cancel();bubble.remove();delete person.dataset.pose;if(epoch===this.epoch){from.classList.remove('has-motion','is-live','is-walking');this.wires.replaceChildren();}}
      return result;
    }
    async clock(e,epoch){this.status.textContent='历史回放 · '+(labels[e.kind]??e.kind);const animation=this.root.animate([{},{}],{duration:e.durationMs??2000});animation.updatePlaybackRate(e.rate??1);this.animations.add(animation);const timer=setInterval(()=>e.onProgress?.(Math.min(1,Number(animation.currentTime??0)/(e.durationMs??2000))),120);let result='completed';try{await animation.finished;}catch{result='cancelled';}finally{clearInterval(timer);this.animations.delete(animation);animation.cancel();}return result;}
    demo(state='working'){this.stop();if(this.replaying)return;if(!this.enabled()){this.status.textContent='动态效果已关闭；可使用列表查看全部信息。';return;}const nodes=[...this.root.querySelectorAll('.office-desk')];if(!nodes.length){this.status.textContent='邀请角色加入后，可以预览人物动作。';return;}const from=nodes[0],to=nodes[1]??from,kind={reading:'material_read',working:'work_pose',waiting:'wait_pose',resting:'rest_pose',communicating:'message'}[state]??'work_pose';this.present(Array.from({length:3},()=>({kind,seat_id:from.dataset.seat,body:{recipient:to.dataset.role||to.dataset.seat}})),{demo:true});}

  }
  window.MindPondOfficeScene={Scene,props,catalog,stateFor};
})();

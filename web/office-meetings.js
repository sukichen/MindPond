/* Live meeting geometry and movement. Backend membership, never decorative events, owns location. */
(() => {
  'use strict';
  const WIDTH=760,HEIGHT=720,GAP=160;
  const rect=(left,top,right,bottom)=>({left,top,right,bottom});
  function geometry(x,y){
    // Fill opposing pairs first, so even two attendees face one another across the table.
    const slots=Array.from({length:8},(_,i)=>({x:x+[305,450,160,595][Math.floor(i/2)],y:y+(i%2===0?210:540),facing:i%2===0?'down':'up'}));
    return {x,y,width:WIDTH,height:HEIGHT,slots,door:{x:x+380,y},
      table:rect(x+140,y+300,x+620,y+440),
      inboxes:slots.map((_,i)=>{const left=x+[320,440,200,560][Math.floor(i/2)]-54,top=y+(i%2===0?308:376);return rect(left,top,left+108,top+56);}),
      walls:[rect(x,y,x+270,y+10),rect(x+490,y,x+WIDTH,y+10),rect(x,y,x+10,y+HEIGHT),rect(x+WIDTH-10,y,x+WIDTH,y+HEIGHT),rect(x,y+HEIGHT-10,x+WIDTH,y+HEIGHT)],
      chairs:slots.map(p=>rect(p.x-36,p.y-35,p.x+36,p.y+25))};
  }
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const node=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const outstanding=value=>Number.isSafeInteger(value)&&value>=0?String(value>0):'unknown';
  function progressContent(member,cls){
    const content=node('span',cls),name=node('strong','office-meeting-person-name',member.name??member.roleId),counts=node('span','office-meeting-message-counts');
    content.dataset.unread=outstanding(member.unreadPosts);content.dataset.unprocessed=outstanding(member.unprocessedPosts);
    for(const [field,label,icon] of [['unreadPosts','未读','✉'],['unprocessedPosts','未处理','▤']]){
      const metric=node('span','office-meeting-message-count '+field),symbol=node('span','office-meeting-message-icon',icon);symbol.setAttribute('aria-hidden','true');
      metric.append(symbol,node('span','',label),node('b','',String(member[field]??'—')));counts.append(metric);
    }
    content.append(name,counts);return content;
  }
  class Meetings{
    constructor(scene,{openDiscussion=()=>{},navigation=null,focusArea=()=>{}}={}){
      Object.assign(this,{scene,root:scene.root,rooms:new Map(),positions:new Map(),homes:new Map(),targets:new Map(),retries:new Map(),office:null,epoch:0,moving:null,replay:false,openDiscussion,navigation,focusArea,initialized:false});
      this.layer=node('div','office-meeting-wing');this.root.append(this.layer);scene.meetings=this;
    }
    box(n){const root=this.root.getBoundingClientRect(),r=n.getBoundingClientRect(),s=this.scene.scale();return rect((r.left-root.left)/s,(r.top-root.top)/s,(r.right-root.left)/s,(r.bottom-root.top)/s);}
    point(n){const r=this.box(n);return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2};}
    capture(){
      for(const [role,home] of this.homes)if(this.positions.has(role)){
        const position=this.positions.get(role);position.point=this.point(home.person);
        // Membership names the destination; physical occupancy owns walls and departure chairs.
        const touches=room=>{const g=room?.geometry,p=position.point;return g&&p.x+33>=g.x&&p.x-33<=g.x+g.width&&p.y+47>=g.y&&p.y-47<=g.y+g.height;};
        if(!touches(this.rooms.get(position.roomId)))position.roomId=[...this.rooms.values()].find(touches)?.id??null;
      }
      this.retries.clear();
      this.epoch++;if(this.moving){clearInterval(this.moving.timer);this.homes.get(this.moving.role)?.node.classList.remove('is-walking');this.moving.animation.cancel();this.moving=null;}
    }
    prepareRebuild(){this.capture();this.rebuilding=true;}
    reset(){
      this.capture();for(const home of this.homes.values())this.release(home);
      this.rooms.clear();this.positions.clear();this.homes.clear();this.targets.clear();this.retries.clear();this.layer.replaceChildren();this.layer.style.height='0px';this.layer.hidden=true;this.navigation?.replaceChildren();if(this.navigation)this.navigation.hidden=true;this.desksButton=null;this.office=null;this.initialized=false;this.replay=false;this.rebuilding=false;this.suspended=false;this.relocated=false;
    }
    release(home){
      const person=home.person;if(!person.dataset.meeting&&!home.node.classList.contains('is-meeting'))return;
      home.progress?.remove();home.progress=null;delete person.dataset.meetingSide;delete person.dataset.meeting;delete person.dataset.meetingUnread;delete person.dataset.pose;person.style.translate='';
      home.node.classList.remove('is-meeting','is-walking');person.dataset.posture='seated';person.dataset.facing=home.node.dataset.busy==='true'?'desk':'down';
      window.MindPondOfficeScene.drawAction(person,window.MindPondOfficeScene.sampleAction('nod',0));
    }
    capacity(){return Math.max(0,...[...this.rooms.values()].map(r=>r.layoutIndex+1));}
    width(base,records=[]){const count=Math.max(this.capacity(),records.length);return count?Math.max(base+120,(count>1?WIDTH*2+GAP:WIDTH)+136):base;}
    sync(officeId,records=[]){
      // Office data is rendered once while its panel is still hidden. Measure only after reveal.
      if(this.scene.list||this.replay||this.root.getClientRects&&!this.root.getClientRects().length)return;
      if(this.office!==officeId){this.reset();this.office=officeId;}
      const nodes=[...this.root.querySelectorAll('.office-desk')].filter(n=>!n.hidden),nextHomes=new Map();
      let replaced=false;
      for(const n of nodes){const role=n.dataset.role,person=n.querySelector('.office-person');if(!role||!person)continue;const old=this.homes.get(role);if(old?.person!==person)replaced=true;nextHomes.set(role,{...old,progress:old?.person===person?old.progress:null,node:n,person});}
      if(replaced&&!this.rebuilding)this.capture();this.rebuilding=false;
      this.homes=nextHomes;
      for(const [role,home] of this.homes){
        // Measure the unshifted seated sprite; the walking anchor is below its own tucked chair.
        const station=this.box(home.person.offsetParent),p=home.person;
        const seated={x:station.left+p.offsetLeft+p.offsetWidth/2,y:station.top+p.offsetTop+p.offsetHeight/2};
        if(home.seated&&distance(home.seated,seated)>1)this.relocated=true;
        home.seated=seated;home.floor={x:seated.x,y:seated.y+125};
        if(!this.positions.has(role))this.positions.set(role,{point:home.seated,roomId:null});
      }
      const live=new Set(records.map(r=>r.id));
      for(const r of records){
        let room=this.rooms.get(r.id);
        if(!room){const used=new Set([...this.rooms.values()].map(r=>r.layoutIndex));let layoutIndex=0;while(used.has(layoutIndex))layoutIndex++;room={id:r.id,layoutIndex,slots:new Map(),element:node('section','office-meeting-room')};this.rooms.set(r.id,room);this.layer.append(room.element);this.buildRoom(room);}
        room.record=r;room.closed=false;
        for(const m of r.members??[])if(!room.slots.has(m.roleId)){const used=new Set(room.slots.values());room.slots.set(m.roleId,Array.from({length:8},(_,i)=>i).find(i=>!used.has(i)));}
        room.title.textContent=(r.locked?'🔒 ':'')+r.title;room.title.title=r.title+(r.locked?' · 已锁定，角色不能自行进出或结束会议':'');room.door.textContent=r.locked?'🔒 用户已锁定':'会议室入口';const joined=(r.members??[]).filter(m=>m.state==='joined'&&this.homes.has(m.roleId));
        room.label.textContent=joined.length+' 人讨论中 · 未读 '+joined.reduce((n,m)=>n+(m.unreadPosts??0),0)+' · 未处理 '+joined.reduce((n,m)=>n+(m.unprocessedPosts??0),0)+'（含未读）· 普通消息留在工位';
        const progressKey=JSON.stringify(joined.map(m=>[m.roleId,m.name,m.unreadPosts,m.unprocessedPosts,room.slots.get(m.roleId)]));
        if(progressKey!==room.progressKey){
          room.progressKey=progressKey;
          const local=geometry(0,0),members=new Set(joined.map(m=>m.roleId));
          for(const [role,inbox] of room.mailboxes)if(!members.has(role)){inbox.remove();room.mailboxes.delete(role);}
          for(const m of joined){
            let inbox=room.mailboxes.get(m.roleId);
            if(!inbox){inbox=node('button','office-meeting-inbox');inbox.type='button';inbox.dataset.role=m.roleId;inbox.onclick=()=>this.openDiscussion(room.id);room.mailboxes.set(m.roleId,inbox);room.progress.append(inbox);}
            inbox.dataset.unprocessed=outstanding(m.unprocessedPosts);inbox.dataset.unread=outstanding(m.unreadPosts);
            inbox.title=(m.name??m.roleId)+'的会议消息：未读 '+m.unreadPosts+'，未处理 '+m.unprocessedPosts+'（含未读）。点击查看讨论。';
            inbox.replaceChildren(progressContent(m,'office-meeting-table-mail'));
            const box=local.inboxes[room.slots.get(m.roleId)];inbox.style.left=(box.left-local.table.left)+'px';inbox.style.top=(box.top-local.table.top)+'px';
          }
        }
      }
      for(const [id,room] of this.rooms)if(!live.has(id)){room.closed=true;room.progressKey=null;room.progress.replaceChildren();room.mailboxes.clear();room.label.textContent='讨论已结束 · 等待人物离开';}
      const targets=new Map();
      for(const room of this.rooms.values())if(!room.closed)for(const m of room.record.members??[])if(m.state==='joined'&&this.homes.has(m.roleId))targets.set(m.roleId,room.id);
      // New avatar nodes still sit at their desks; their DOM boxes are not the captured live positions.
      if(!replaced&&JSON.stringify([...targets])!==JSON.stringify([...this.targets]))this.capture();
      this.targets=targets;this.prune();this.layout();
      this.renderNavigation();
      if(!this.initialized||this.suspended||!this.scene.active||!this.scene.enabled()){this.initialized=true;this.suspended=false;this.settle();}else{this.apply();this.pump();}
    }
    buildRoom(room){
      const title=node('button','office-meeting-title');title.type='button';title.onclick=()=>{if(!room.closed)this.openDiscussion(room.id);};
      const label=node('p','office-meeting-label'),table=node('div','office-meeting-table');
      const progress=node('div','office-meeting-table-messages');table.append(progress);room.mailboxes=new Map();
      const decor=node('div','office-meeting-decor');decor.setAttribute('aria-hidden','true');
      decor.innerHTML='<svg class="office-meeting-board" viewBox="0 0 190 92" fill="none"><rect x="3" y="5" width="184" height="80" rx="7" fill="#bac7bb"/><rect x="1" y="1" width="184" height="80" rx="7" fill="#f8faf2" stroke="#95aa99" stroke-width="2"/><path d="M16 15h64" stroke="#91aa94" stroke-width="4" stroke-linecap="round"/><rect x="16" y="29" width="37" height="29" rx="3" fill="#ead39c"/><rect x="65" y="29" width="37" height="29" rx="3" fill="#bbd2c3"/><rect x="114" y="29" width="37" height="29" rx="3" fill="#d6c5d4"/><path d="M22 37h23m-23 7h16m27-7h23m-23 7h16m27-7h23m-23 7h16" stroke="#677c6e" stroke-width="2" opacity=".5" stroke-linecap="round"/><path d="M12 78h161" stroke="#a8bca8" stroke-width="5" stroke-linecap="round"/><path d="M128 74h19" stroke="#799c8c" stroke-width="3" stroke-linecap="round"/></svg><svg class="office-meeting-art" viewBox="0 0 112 66" fill="none"><rect x="2" y="3" width="108" height="61" rx="6" fill="#b6b49a"/><rect x="1" y="1" width="108" height="59" rx="5" fill="#f8f4e8" stroke="#cec6ae" stroke-width="2"/><rect x="9" y="9" width="92" height="42" rx="2" fill="#e5eddb"/><circle cx="79" cy="22" r="8" fill="#e5c27e"/><path d="m9 44 23-22 27 29H9z" fill="#aac0a2"/><path d="m39 51 28-22 34 22z" fill="#7f9f85"/></svg>';
      const door=node('span','office-meeting-door','会议室入口');room.element.append(decor,title,label,table,door);room.progress=progress;room.title=title;room.label=label;room.door=door;
      room.chairs=Array.from({length:8},()=>{const chair=node('span','office-meeting-chair');chair.setAttribute('aria-hidden','true');room.element.append(chair);return chair;});
      for(const cls of ['north-left','north-right','west','east','south'])room.element.append(node('span','office-meeting-wall '+cls));
    }
    renderNavigation(){
      if(!this.navigation)return;this.navigation.hidden=!this.rooms.size||this.replay;
      if(!this.desksButton){
        const desks=node('button','','工位区');desks.type='button';desks.onclick=()=>{const boxes=[...this.homes.values()].map(h=>this.box(h.node));if(boxes.length)this.focusArea(rect(Math.min(...boxes.map(r=>r.left))-30,Math.min(...boxes.map(r=>r.top))-50,Math.max(...boxes.map(r=>r.right))+30,Math.max(...boxes.map(r=>r.bottom))+30));};this.desksButton=desks;this.navigation.append(desks);
      }
      for(const room of this.rooms.values()){
        if(!room.navigationButton){const button=node('button');button.type='button';button.onclick=()=>{const g=room.geometry;this.focusArea(rect(g.x-30,g.y-60,g.x+g.width+30,g.y+g.height+30));};room.navigationButton=button;this.navigation.append(button);}
        room.navigationButton.textContent=(room.record.locked?'🔒 已锁定 · ':'会议室 · ')+room.record.title;room.navigationButton.title=room.record.title+'（'+room.label.textContent+'）';
      }
    }

    layout(){
      if(!this.rooms.size){this.layer.style.height='0px';this.layer.hidden=true;return;}
      this.layer.hidden=this.replay;
      const available=this.root.clientWidth-116,columns=available>=WIDTH*2+GAP?2:1;
      // Keep room positions stable until everyone has left; closing never removes a wall under a walker.
      for(const room of this.rooms.values()){
        const index=room.layoutIndex;
        const x=58+(index%columns)*(WIDTH+GAP),y=this.root.querySelector('.office-desks').offsetTop+this.root.querySelector('.office-desks').offsetHeight+150+Math.floor(index/columns)*(HEIGHT+GAP);
        const previous=room.geometry;room.geometry=geometry(x+this.root.clientLeft,y+this.root.clientTop);room.element.style.left=x+'px';room.element.style.top=y+'px';
        room.element.classList.toggle('is-closing',room.closed);
        room.title.disabled=room.closed;
        for(let i=0;i<8;i++){const chair=room.chairs[i],p=room.geometry.slots[i];chair.style.left=(p.x-room.geometry.x-36)+'px';chair.style.top=(p.y-room.geometry.y-35)+'px';chair.classList.toggle('north',i%2===0);}
        if(previous&&(previous.x!==room.geometry.x||previous.y!==room.geometry.y))this.relocated=true;
      }
      this.layer.style.height=(150+Math.ceil(this.capacity()/columns)*(HEIGHT+GAP)-GAP)+'px';
      if(this.relocated){this.relocated=false;this.settle();}
    }
    target(role){const home=this.homes.get(role),room=this.rooms.get(this.targets.get(role));return room?{point:room.geometry.slots[room.slots.get(role)],roomId:room.id}:home?{point:home.seated,roomId:null}:null;}
    apply(){
      if(this.replay)return;
      for(const [role,home] of this.homes){const position=this.positions.get(role),target=this.target(role);if(!position||!target)continue;
        const away=position.roomId||target.roomId||distance(position.point,home.seated)>1;
        if(!away){this.release(home);continue;}
        const p=home.person;p.dataset.meeting=target.roomId??position.roomId??'returning';home.node.classList.add('is-meeting');
        p.style.translate=(position.point.x-home.seated.x)+'px '+(position.point.y-home.seated.y)+'px';
        const slot=this.rooms.get(position.roomId)?.geometry.slots[this.rooms.get(position.roomId)?.slots.get(role)],atMeeting=slot&&distance(position.point,slot)<=1,atHome=distance(position.point,home.seated)<=1;
        const member=this.rooms.get(target.roomId)?.record.members?.find(m=>m.roleId===role&&m.state==='joined');
        if(member){
          if(member.unreadPosts>0)p.dataset.meetingUnread=String(member.unreadPosts);else delete p.dataset.meetingUnread;
          const signature=JSON.stringify([member.name,member.unreadPosts,member.unprocessedPosts]);
          if(!home.progress){home.progress=node('span','office-meeting-avatar-progress');home.progressSignature=null;p.append(home.progress);}
          if(home.progressSignature!==signature){home.progressSignature=signature;home.progress.replaceChildren(progressContent(member,'office-meeting-avatar-mail'));}
          p.dataset.meetingSide=atMeeting&&slot.facing==='up'?'below':'above';
        }else{home.progress?.remove();home.progress=null;home.progressSignature=null;delete p.dataset.meetingSide;delete p.dataset.meetingUnread;}
        const walking=this.moving?.role===role;p.dataset.posture=walking||!atMeeting&&!atHome?'standing':'seated';
        if(!walking){if(atMeeting)p.dataset.facing=slot.facing;else if(atHome)p.dataset.facing=!target.roomId&&home.node.dataset.busy==='true'?'desk':'down';}
      }
    }
    settle(){
      this.capture();for(const role of this.homes.keys()){const target=this.target(role);if(target)this.positions.set(role,target);}
      this.apply();this.prune();
    }
    suspend(){if(!this.replay&&!this.rebuilding){this.suspended=true;this.settle();}}
    setReplay(on){
      this.settle();this.replay=on;this.layer.hidden=on||!this.rooms.size;if(this.navigation)this.navigation.hidden=on||!this.rooms.size;
      if(on)for(const home of this.homes.values())this.release(home);else this.apply();
    }
    prune(){
      for(const [role] of this.positions)if(!this.homes.has(role))this.positions.delete(role);
      for(const [id,room] of this.rooms)if(room.closed&&![...this.positions.values()].some(p=>p.roomId===id)){
        room.element.remove();room.navigationButton?.remove();this.rooms.delete(id);
      }
    }
    obstacles(role){
      const home=this.homes.get(role),boxes=[];
      for(const n of this.root.querySelectorAll('.office-table,.office-chair,.office-monitor,.office-task-light,.office-room-door,.office-desk-caption'))if(n!==home.node.querySelector('.office-chair'))boxes.push(this.box(n));
      for(const [other,h] of this.homes)if(other!==role)boxes.push(this.box(h.person));
      for(const room of this.rooms.values()){
        const g=room.geometry;boxes.push(g.table,...g.walls);
        const ownsSeat=room.id===this.positions.get(role)?.roomId||room.id===this.targets.get(role);
        room.geometry.chairs.forEach((chair,i)=>{if(!ownsSeat||room.slots.get(role)!==i)boxes.push(chair);});
      }
      return boxes;
    }
    furniture(){return this.replay?[]:[...this.rooms.values()].flatMap(r=>[r.geometry.table,...r.geometry.walls,...r.geometry.chairs]);}
    pump(){
      if(this.moving||this.replay||!this.scene.active)return;
      if(!this.scene.enabled()){this.settle();return;}
      if(this.scene.running)return;
      // One blocked role must not prevent a different role from vacating a seat or doorway.
      for(const role of this.homes.keys()){
        const p=this.positions.get(role),t=this.target(role);if(!t||Date.now()<(this.retries.get(role)??0)||p.roomId===t.roomId&&distance(p.point,t.point)<=1)continue;
        const epoch=this.epoch;void this.move(role).catch(()=>{if(epoch!==this.epoch)return;this.retries.set(role,Date.now()+1500);const motion=this.moving;if(motion?.role===role){clearInterval(motion.timer);motion.animation.cancel();this.moving=null;}this.homes.get(role)?.node.classList.remove('is-walking');this.apply();if(!this.moving)this.scene.status.textContent='人物动作暂时无法播放，稍后重试。';});
        if(this.moving)break;
      }
    }
    async move(role){
      const home=this.homes.get(role),target=this.target(role),position=this.positions.get(role),epoch=this.epoch;
      home.person.dataset.posture='standing';home.node.classList.add('is-meeting');
      const from=position.roomId||distance(position.point,home.seated)>1?position.point:home.floor;
      const to=target.roomId?target.point:home.floor;
      const room=this.root.getBoundingClientRect(),scale=this.scene.scale(),nav=window.MindPondOfficeNavigation;
      const options={bounds:rect(12,28,room.width/scale-12,room.height/scale-12),obstacles:this.obstacles(role),halfWidth:33,halfHeight:47,clearance:12};
      const route=nav.planRoute(from,to,options);
      if(!route){this.retries.set(role,Date.now()+1500);this.apply();this.scene.status.textContent='会议室通道暂时被占用，人物在原位等待。';return;}
      const length=route.reduce((n,p,i)=>n+(i?distance(p,route[i-1]):0),0),duration=Math.max(160,length/190*1000);
      const points=[];let walked=0;for(let i=0;i<route.length;i++){if(i)walked+=distance(route[i],route[i-1]);points.push({...route[i],offset:length?walked/length:i/(route.length-1)});}
      // Rising/lowering stays clear of the tucked chair, as in the existing scene navigator.
      const frames=points.map(p=>({translate:(p.x-home.seated.x)+'px '+(p.y-home.seated.y)+'px',offset:p.offset}));
      home.person.style.translate=frames[0].translate;home.person.dataset.meeting=target.roomId??position.roomId??'returning';home.node.classList.add('is-walking');
      const animation=home.person.animate(frames,{duration,easing:'linear'});
      const motion={role,animation,route:points,target,timer:null};this.moving=motion;
      const tick=()=>{if(this.moving!==motion)return;const p=Math.min(1,Number(animation.currentTime??0)/duration),index=points.findIndex(v=>v.offset>p),a=points[Math.max(0,index-1)],b=points[index<0?points.length-1:index];const dx=b.x-a.x,dy=b.y-a.y;home.person.dataset.facing=Math.abs(dx)>Math.abs(dy)?(dx>0?'right':'left'):(dy>0?'down':'up');};tick();motion.timer=setInterval(tick,80);
      this.scene.status.textContent=(home.person.dataset.name??'角色')+(target.roomId?'正在走进会议室。':'正在返回工位，普通消息仍留在座位。');
      let completed=false;
      try{await animation.finished;if(epoch===this.epoch){completed=true;this.positions.set(role,target);}}
      catch{if(epoch===this.epoch){this.retries.set(role,Date.now()+1500);this.scene.status.textContent='人物动作暂时中断，稍后重试。';}}
      finally{clearInterval(motion.timer);if(epoch===this.epoch){this.moving=null;animation.cancel();if(completed)this.retries.clear();home.node.classList.remove('is-walking');this.apply();this.prune();this.layout();this.renderNavigation();this.pump();if(!this.moving&&!this.scene.running){if(this.scene.queue.length)void this.scene.drain(this.scene.epoch);else if(!this.retries.size)this.scene.status.textContent='会议室位置已同步；普通消息保留在工位。';}}}
    }
    tick(now){
      if(this.replay)return;this.pump();
      for(const [role,home] of this.homes){const position=this.positions.get(role);if(!position?.roomId||this.moving?.role===role||home.person.dataset.posture!=='seated')continue;
        const clips=['nod','think','note'],clip=clips[(Math.floor(now/4200)+home.node.dataset.seat.length)%clips.length];
        home.person.dataset.pose=clip;window.MindPondOfficeScene.drawAction(home.person,window.MindPondOfficeScene.sampleAction(clip,(now%4200)/4200));
      }
    }
  }
  window.MindPondOfficeMeetings={Meetings,geometry};
})();

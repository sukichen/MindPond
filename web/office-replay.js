/* Read-only history player. Loading and seeking never execute a business operation. */
(() => {
  'use strict';
  class Player {
    constructor({scene,fetchPage,view,prepare,restore}){Object.assign(this,{scene,fetchPage,view,prepare,restore});this.active=false;this.loading=false;this.playing=false;this.paused=false;this.epoch=0;this.events=[];this.index=0;this.durations=new Map();this.defaultSeconds=2;this.speed=1;}
    async load(officeId,fromSeq,toSeq,threadId){
      if(!Number.isSafeInteger(fromSeq)||fromSeq<1||!Number.isSafeInteger(toSeq)||toSeq<fromSeq)throw Error('请选择有效的起止事件，起点不能晚于终点。');
      this.cancel();const epoch=this.epoch;this.loading=true;this.view.change(this);
      try{
        const meta=await this.fetchPage({action:'index',officeId,fromSeq,toSeq,...(threadId?{threadId}:{})});if(epoch!==this.epoch)return;
        if(meta.count>5000||meta.participantsLimited)throw Error('这个区间太长，请缩小起止事件范围后再载入。');
        const end=Math.min(toSeq,meta.lastSeq??0);let cursor=fromSeq-1;const events=[];
        while(cursor<end){const page=await this.fetchPage({action:'page',officeId,fromSeq,toSeq:end,afterSeq:cursor,limit:100,...(threadId?{threadId}:{})});if(epoch!==this.epoch)return;
          if(page.events.some((e,n)=>!Number.isSafeInteger(e.seq)||e.seq<=(n?page.events[n-1].seq:cursor)||e.seq<fromSeq||e.seq>end))throw Error('事件分页顺序异常，请重新载入。');
          events.push(...page.events);if(events.length>5000)throw Error('回放区间过长，请缩小范围。');
          if(!page.hasMore)break;if(!Number.isSafeInteger(page.nextCursor)||page.nextCursor<=cursor)throw Error('事件分页没有前进，请重新载入。');cursor=page.nextCursor;this.view.loading(events.length,meta.count);
        }
        if(!events.length)throw Error('所选区间内没有可回放的事件。');
        this.events=events;this.meta=meta;this.index=0;this.completed=false;this.active=true;this.scene.beginReplay();this.prepare(meta.participants);this.view.loaded(meta,this);this.select();
      }finally{if(epoch===this.epoch){this.loading=false;this.view.change(this);}}
    }
    select(){const event=this.events[this.index];if(event)this.view.select(event,this.index,this.events.length,this);this.view.change(this);}
    cancel(){this.epoch++;this.playing=false;this.paused=false;this.loading=false;this.scene.stop();}
    seek(index){if(!this.events.length)return;this.cancel();this.index=Math.max(0,Math.min(this.events.length-1,Math.trunc(index)));this.completed=false;this.select();}
    pause(){if(!this.playing)return;this.playing=false;this.paused=true;this.scene.pauseReplay();this.view.change(this);}
    play(){if(!this.active||!this.events.length||this.loading||this.playing)return;
      if(this.paused){this.paused=false;this.playing=true;this.scene.resumeReplay();this.view.change(this);return;}
      if(this.completed){this.index=0;this.completed=false;}
      this.playing=true;this.view.change(this);void this.run(this.epoch);
    }
    async run(epoch){
      try{while(epoch===this.epoch&&this.playing){const event=this.events[this.index];this.select();
        const seconds=this.durations.get(event.actorKey)??this.defaultSeconds;
        const result=await this.scene.replayEvent(event,{durationMs:seconds*1000,rate:this.speed,onProgress:progress=>{if(epoch===this.epoch)this.view.progress(progress,this);}});
        if(epoch!==this.epoch)return;
        if(result==='cancelled'){this.playing=false;this.paused=false;this.view.change(this);return;}
        if(this.index===this.events.length-1){this.completed=true;this.playing=false;this.paused=false;this.view.change(this);return;}
        this.index++;
      }}catch(error){if(epoch===this.epoch){this.playing=false;this.paused=false;this.view.error(error);this.view.change(this);}}
    }
    setSpeed(speed){if(!Number.isFinite(speed)||speed<.25||speed>16)throw Error('回放速度无效');this.speed=speed;this.scene.setReplayRate(speed);}
    setDuration(key,seconds){if(!Number.isFinite(seconds)||seconds<.5||seconds>60)throw Error('每件事的时长应为 0.5–60 秒');if(key)this.durations.set(key,seconds);else this.defaultSeconds=seconds;}
    close(){const wasActive=this.active;this.cancel();this.active=false;this.events=[];this.index=0;this.completed=false;this.scene.endReplay();if(wasActive)this.restore();this.view.change(this);}
  }
  window.MindPondOfficeReplay={Player};
})();

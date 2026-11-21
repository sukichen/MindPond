'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const names = {
    dimension_configuration_updated:'更新维度与提示词',memory_recalled:'检索完成',memory_read:'Agent 读取记忆',node_created:'写入记忆',node_updated:'修改记忆',node_deleted:'删除记忆',node_superseded:'记忆被整合',membership_created:'加入记忆空间',association_created:'建立关联',association_reweighted:'调整关联权重',association_deleted:'移除关联',association_carried:'迁移关联',association_evidence_reviewed:'复核关联依据',organization_job_claimed:'领取整理任务',organization_job_released:'释放整理任务',organization_consolidate:'整合记忆',organization_associate:'整理并关联',organization_keep:'保留记忆',organization_defer:'暂缓整理',profile_revised:'修订画像',host_checkpoint:'宿主检查点',host_work_claimed:'领取整理工作',host_work_finished:'完成整理工作',recall_feedback_recorded:'回报记忆采用情况'
  };
  const state = { renderer:null,nodes:[],edges:[],nodeById:new Map(),cursor:0,stream:null,stopped:false,pollTimer:0,reloadTimer:0,seen:new Set(),bubbleTimers:new Map(),generation:0,graphRevision:0,ownerLabels:new Map() };
  let errorTimer;
  function error(message){ $('error').textContent=message; $('error').hidden=false;clearTimeout(errorTimer);errorTimer=setTimeout(()=>$('error').hidden=true,7000); }
  function headers(){const h={};if($('apiKey').value)h['x-api-key']=$('apiKey').value;if($('operatorKey').value)h['x-operator-key']=$('operatorKey').value;return h;}
  async function api(path,body){const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{...headers(),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json().catch(()=>({}));if(!response.ok||data.ok===false)throw new Error(data.error||'HTTP '+response.status);return data;}
  function setStatus(label,live){$('streamStatus').textContent=label;$('signal').classList.toggle('live',!!live);}
  const clock=ts=>new Date(ts||Date.now()).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  function text(tag,content,cls){const el=document.createElement(tag);el.textContent=content??'';if(cls)el.className=cls;return el;}
  function safeReason(reason){if(!reason)return '';try{const o=JSON.parse(reason);if(o.recallId)return `召回 ${String(o.recallId).slice(0,8)} · ${o.resultCount??''} 条`;if(o.jobId)return `任务 ${String(o.jobId).slice(0,8)}`;if(o.spaceId)return `${o.spaceId} / ${o.memoryType||''}`;return '';}catch{return reason.length>70?reason.slice(0,70)+'…':reason;}}
  function actionName(name){return names[name]||name.replaceAll('_',' ');}
  function actionTone(name){if(name==='memory_read')return 'read';if(/delete|retire|failed/.test(name))return 'danger';if(/association|edge_|reference/.test(name))return 'link';if(/organization|profile_|host_work/.test(name))return 'organize';if(/save|created|updated|membership/.test(name))return 'write';return 'neutral';}

  function announce(message){$('activityToast').lastElementChild.textContent=message;}
  function feed(action,content){const feed=$('activityFeed');feed.querySelector('.feed-empty')?.remove();const row=document.createElement('article');row.className='feed-item '+actionTone(action.action);row.append(text('time',clock(action.ts)),text('strong',actionName(action.action)));const detail=content||safeReason(action.reason);if(detail)row.append(text('div',detail.length>180?detail.slice(0,180)+'…':detail,'detail'));row.onclick=()=>{if(action.nodeId)showNode(action.nodeId).catch(e=>error(e.message));else if(action.fromId)showNode(action.fromId).catch(e=>error(e.message));};feed.prepend(row);while(feed.children.length>80)feed.lastElementChild.remove();}
  function dimensionLabel(id){return state.dimensionDefinitions?.find(d=>d.id===id)?.label||id;}
  function ownerKey(owner){return owner?.kind==='user'?'user':owner?.kind+':'+owner?.id;}
  function ownerQuery(){
    const value=$('owner').value,q=new URLSearchParams();
    if(value==='user')q.set('ownerUser','true');
    else if(value.startsWith('agent:'))q.set('ownerRoleId',value.slice(6));
    else if(value.startsWith('office:'))q.set('ownerOfficeId',value.slice(7));
    return q;
  }
  function filtered(){return Boolean($('owner').value||$('space').value||$('type').value);}
  async function loadOwners(generation){
    const {roles,offices}=await api('./api/memory/owners');
    if(generation!==state.generation)return;
    const labels=new Map([['','全部记忆（人类管理）'],['user','人类记忆']]);
    const uniqueRoles=[...new Map(roles.map(role=>[role.id,role])).values()];
    for(const role of uniqueRoles){
      const duplicate=uniqueRoles.some(r=>r.id!==role.id&&r.name===role.name);
      labels.set('agent:'+role.id,'角色 · '+role.name+(duplicate?' · '+role.id:'')+(role.state==='active'?'':'（已停用）'));
    }
    for(const office of offices)labels.set('office:'+office.id,'办公室 · '+office.title+(office.state==='deleted'?'（已删除）':''));
    const current=new URLSearchParams(location.search).get('owner')??'';
    state.ownerLabels=labels;
    $('owner').replaceChildren(...[...labels].map(([key,label])=>new Option(label,key)));
    if(current&&!labels.has(current)) {
      $('owner').add(new Option('所选归属已不可用',current));
      $('owner').value=current;
      throw new Error('所选记忆归属已不可用，请选择其他归属。');
    }
    $('owner').value=current;
  }
  function nodeLabel(node){return node?.content?.trim().split('\n')[0].slice(0,52)||node?.id?.slice(0,12)||'记忆';}
  function resetInspector(){
    const box=$('inspector');box.style.boxShadow='';box.dataset.dimension='';
    box.replaceChildren(text('p','点击节点查看记忆正文和归属。','placeholder'));
  }
  function inspect(node,meta={}){const box=$('inspector');box.dataset.dimension=node.dimension||'';box.style.boxShadow='inset 3px 0 '+window.MindPondGraphRenderer.dimensionColor(node.dimension);const spread=meta.exploreCount!==undefined?` · 图谱探索 ${meta.exploreDepth} 跳 / ${meta.exploreCount} 条`:'';box.replaceChildren(text('div','SELECTED MEMORY / 当前记忆','eyebrow'),text('h3',nodeLabel(node)),text('div',`${state.ownerLabels.get(ownerKey(node.owner))||'记忆'} · ${node.layer||'记忆'} · ${(node.dimensions||[node.dimension]).filter(Boolean).map(dimensionLabel).join(' / ')}${meta.depth!==undefined?' · 涟漪 '+meta.depth+' 跳':''}${meta.score!==undefined?' · 得分 '+Number(meta.score).toFixed(2):''}${spread}`,'minor'),text('div',node.content||'记忆正文不可用','body'));}
  async function fetchNode(id){const cached=state.nodeById.get(id);if(cached?.content)return cached;const result=await api('./api/memory/node/'+encodeURIComponent(id)+'?scope=operator');return result.node;}
  function addTemporaryNode(node){if(state.nodeById.has(node.id))return;state.nodes.push(node);state.nodeById.set(node.id,node);state.renderer.setGraph(state.nodes,state.edges,true);$('graphCount').textContent=`${state.nodes.length} 条记忆 · ${state.edges.length} 条关联`;updateLegend();}
  function positionBubble(el,id){const point=state.renderer?.point(id);if(!point)return;const stage=$('graphStage');let x=point.x+18,y=point.y+20;const w=el.offsetWidth||280,h=el.offsetHeight||130;x=Math.max(8,Math.min(stage.clientWidth-w-8,x));y=Math.max(8,Math.min(stage.clientHeight-h-8,y));el.style.left=x+'px';el.style.top=y+'px';}
  function bubble(node,meta){const layer=$('bubbles'),id=node.id;const previous=layer.querySelector(`[data-memory-id="${CSS.escape(id)}"]`);previous?.remove();const el=document.createElement('article');el.className='read-bubble';el.dataset.memoryId=id;el.style.setProperty('--memory-color',window.MindPondGraphRenderer.dimensionColor(node.dimension));const depth=meta.depth??0,score=Number(meta.score);el.append(text('span',`↳ AGENT READ · ${meta.mode==='expand'?'展开正文':depth===0?'直接命中':depth+' 跳带出'}`,'meta'),text('span',Number.isFinite(score)?score.toFixed(2):'','score'),text('p',node.content||'内容不可用'));const open=text('button','查看完整记忆 ↗');open.onclick=()=>inspect(node,meta);el.append(open);layer.append(el);positionBubble(el,id);clearTimeout(state.bubbleTimers.get(id));state.bubbleTimers.set(id,setTimeout(()=>{el.remove();state.bubbleTimers.delete(id);},9000));while(layer.children.length>3){const oldest=layer.firstElementChild;clearTimeout(state.bubbleTimers.get(oldest.dataset.memoryId));state.bubbleTimers.delete(oldest.dataset.memoryId);oldest.remove();}}
  async function showNode(id){const generation=state.generation;if(filtered()&&!state.nodeById.has(id))return;if(state.renderer.selected!==id)state.renderer.ripple(id);const node=await fetchNode(id);if(generation!==state.generation)return;addTemporaryNode(node);if(state.renderer.selected!==id)state.renderer.ripple(id);if(state.renderer.selected===id){const focus=state.renderer.focus;inspect(node,{exploreDepth:focus?.maxDepth??0,exploreCount:focus?.nodes.length??1});}}
  async function showRead(action){const generation=state.generation;let meta={};try{meta=JSON.parse(action.reason||'{}');}catch{}const response=await api('./api/memory/node/'+encodeURIComponent(action.nodeId)+'?scope=operator');const node=response.node;if(generation!==state.generation||filtered()&&!state.nodeById.has(node.id))return;if(state.nodeById.has(node.id)){state.nodeById.set(node.id,node);state.nodes=state.nodes.map(n=>n.id===node.id?node:n);}else addTemporaryNode(node);state.renderer.reveal(node.id);if(Array.isArray(meta.path)&&meta.path.length)state.renderer.trace(meta.path);else state.renderer.flash(action);bubble(node,meta);feed(action,node.content);announce('Agent 读取了「'+nodeLabel(node)+'」');}
  function actionTarget(action){if(action.nodeId||action.fromId||action.toId)return action;const edge=state.edges.find(e=>e.id===action.edgeId);return edge?{...action,fromId:edge.fromId,toId:edge.toId}:action;}
  function activityVisible(action){
    return !filtered()||[action.nodeId,action.fromId,action.toId].some(id=>state.nodeById.has(id))||state.edgeIds?.has(action.edgeId);
  }
  function process(action){
    if(!action||!Number.isSafeInteger(action.id)||state.seen.has(action.id))return;
    state.seen.add(action.id);
    if(state.seen.size>500)state.seen.delete(state.seen.values().next().value);
    state.cursor=Math.max(state.cursor,action.id);
    if(action.action==='dimension_configuration_updated')loadDimensionDefinitions().then(scheduleReload).catch(e=>error(e.message));
    if(/^(node_|association_|membership_|organization_|profile_|edge_|role_reorganized)/.test(action.action))scheduleReload();
    if(!activityVisible(action))return;
    if(action.action==='memory_read'&&action.nodeId){
      const generation=state.generation;
      showRead(action).catch(e=>{if(generation===state.generation)error(e.message);});
      return;
    }
    state.renderer?.flash(actionTarget(action));
    feed(action);
    announce(actionName(action.action)+(action.nodeId?' · '+(state.nodeById.get(action.nodeId)?.content?.slice(0,34)||action.nodeId.slice(0,8)):''));
  }
  function scheduleReload(){
    if(state.reloadTimer)return;
    state.reloadTimer=setTimeout(()=>{
      state.reloadTimer=0;
      if(!state.loadingScope)loadGraph(true).catch(e=>error(e.message));
    },1800);
  }
  function constructRenderer(mode){state.renderer?.destroy();try{state.renderer=new window.MindPondGraphRenderer($('graphStage'),mode);}catch(e){if(mode==='gpu'){error(e.message);$('mode').value='auto';state.renderer=new window.MindPondGraphRenderer($('graphStage'),'canvas');}else throw e;}state.renderer.on('view',()=>{for(const el of $('bubbles').children)positionBubble(el,el.dataset.memoryId);});state.renderer.on('click',({nodes})=>{if(nodes[0])showNode(nodes[0]).catch(e=>error(e.message));});state.renderer.on('doubleClick',({nodes})=>{if(nodes[0])showNode(nodes[0]).catch(e=>error(e.message));});state.renderer.on('contextlost',()=>{error('图形上下文已中断，已切换Canvas 2D');$('mode').value='canvas';constructRenderer('canvas');state.renderer.setGraph(state.nodes,state.edges,false);});$('backend').textContent=`${state.renderer.backend} · ${state.renderer.renderer}`;}
  async function loadScopes(generation){
    const response=await api('./api/memory/spaces?'+ownerQuery());
    if(generation!==state.generation)return;
    const active=response.spaces.filter(s=>s.active>0);
    const spaces=[...new Set(active.map(s=>s.spaceId))],select=$('space'),current=select.value;
    select.replaceChildren(new Option('全部空间',''),...spaces.map(v=>new Option(v,v)));
    select.value=spaces.includes(current)?current:'';
    updateTypes(active);
  }
  function updateTypes(spaces){state.spaces=spaces;const selected=$('space').value,types=[...new Set(spaces.filter(s=>!selected||s.spaceId===selected).map(s=>s.memoryType))],select=$('type'),current=select.value;select.replaceChildren(new Option('全部类型',''),...types.map(v=>new Option(v,v)));select.value=types.includes(current)?current:'';}
  function updateLegend(){const counts=Object.create(null);for(const n of state.nodes){for(const dim of new Set(n.dimensions?.length?n.dimensions:[n.dimension]))counts[dim]=(counts[dim]||0)+1;}const legend=document.querySelector('.legend');legend.replaceChildren();const defs=new Map((state.dimensionDefinitions||[]).map(d=>[d.id,d]));for(const dim of new Set([...(state.dimensionDefinitions||[]).filter(d=>d.enabled||counts[d.id]).map(d=>d.id),...Object.keys(counts).filter(Boolean)])){const def=defs.get(dim),item=text('span',(def?.label||dim)+' '+(counts[dim]||0)+(def&&!def.enabled?' · 停用':''));item.title=(def?.description||dim)+'；当前画布 '+(counts[dim]||0)+' 条（受空间、类型和数量筛选影响）';item.dataset.dimension=dim;const dot=document.createElement('i');dot.style.background=window.MindPondGraphRenderer.dimensionColor(dim);item.prepend(dot);legend.append(item);}}

  async function loadGraph(preserve=true){
    const generation=state.generation,revision=++state.graphRevision,q=ownerQuery();
    q.set('limit',$('limit').value);
    q.set('includeEvents',String($('events').checked));
    if($('space').value)q.set('spaceId',$('space').value);
    if($('type').value)q.set('memoryType',$('type').value);
    const data=await api('./api/memory/graph?'+q);
    if(revision!==state.graphRevision||generation!==state.generation)return;
    state.nodes=data.nodes||[];state.edges=data.edges||[];
    state.nodeById=new Map(state.nodes.map(n=>[n.id,n]));
    state.edgeIds=new Set(state.edges.map(e=>e.id));
    state.renderer.setGraph(state.nodes,state.edges,preserve);
    $('graphCount').textContent=`${state.nodes.length} 条记忆 · ${state.edges.length} 条关联`;
    updateLegend();
    if(state.renderer.selected&&state.nodeById.has(state.renderer.selected))inspect(state.nodeById.get(state.renderer.selected));
    else if(state.nodes.length===1){
      const node=state.nodes[0],focus=state.renderer.ripple(node.id);
      inspect(node,{exploreDepth:focus?.maxDepth??0,exploreCount:focus?.nodes.length??1});
    }else resetInspector();
  }
  function bootstrapLog(log){
    for(const action of [...log].reverse()){
      state.cursor=Math.max(state.cursor,action.id);
      if(state.seen.has(action.id))continue;
      state.seen.add(action.id);
      if(activityVisible(action))feed(action,action.action==='memory_read'?state.nodeById.get(action.nodeId)?.content:undefined);
    }
  }
  async function changeScope(reloadScopes=false,reconnect=false){
    const generation=++state.generation;
    stopStream();state.cursor=0;
    state.loadingScope=true;
    clearTimeout(state.reloadTimer);state.reloadTimer=0;
    state.nodes=[];state.edges=[];state.nodeById.clear();state.edgeIds?.clear();
    state.renderer.setGraph([],[],false);
    resetInspector();
    $('activityFeed').replaceChildren(text('div','等待当前图谱的记忆操作…','feed-empty'));
    state.seen.clear();
    for(const timer of state.bubbleTimers.values())clearTimeout(timer);
    state.bubbleTimers.clear();$('bubbles').replaceChildren();
    announce('等待记忆活动');
    $('graphCount').textContent='正在加载图谱';
    if(reloadScopes){
      for(const id of ['space','type','limit','events'])$(id).disabled=true;
    }
    try{
      if(reconnect){
        await Promise.all([loadDimensionDefinitions(),loadOwners(generation)]);
        if(generation!==state.generation)return;
        sessionStorage.setItem('mindpond:graph-api-key',$('apiKey').value);
        sessionStorage.setItem('mindpond:graph-operator-key',$('operatorKey').value);
      }
      if(reloadScopes)await loadScopes(generation);
      if(generation!==state.generation)return;
      // Take the action cursor before the graph read. The stream will replay
      // changes that commit between the snapshot and the live connection.
      const {log}=await api('./api/memory/actionlog?limit=100');
      if(generation!==state.generation)return;
      await loadGraph(false);
      if(generation!==state.generation)return;
      bootstrapLog(log??[]);
      void stream();
    }catch(e){
      if(generation!==state.generation)return;
      $('graphCount').textContent='图谱暂未载入';
      setStatus('连接中断',false);
      throw e;
    }finally{
      if(generation===state.generation){
        state.loadingScope=false;
        for(const id of ['space','type','limit','events'])$(id).disabled=false;
      }
    }
  }
  function stopStream(){
    state.stream?.abort();
    state.stream=null;
    clearInterval(state.pollTimer);
    state.pollTimer=0;
  }
  async function pollFallback(controller){
    const timer=state.pollTimer;
    const current=()=>timer&&timer===state.pollTimer&&state.stream===controller&&!controller.signal.aborted&&!state.stopped;
    try{
      const {log}=await api('./api/memory/actionlog?limit=100');
      if(!current())return;
      for(const action of [...log].reverse())if(action.id>state.cursor)process(action);
      setStatus('实时轮询',true);
    }catch(e){
      if(!current())return;
      setStatus('连接中断',false);error(e.message);
    }
  }
  async function stream(controller){
    if(state.stopped)return;
    if(!controller){
      stopStream();
      controller=new AbortController();state.stream=controller;
    }
    const current=()=>state.stream===controller&&!controller.signal.aborted&&!state.stopped;
    const reconnect=delay=>setTimeout(()=>{if(current())void stream(controller);},delay);
    try{
      const response=await fetch('./api/memory/actionstream?after='+state.cursor,{headers:headers(),signal:controller.signal});
      if(!current())return;
      if(!response.ok||!response.body)throw new Error('动作流不可用（HTTP '+response.status+'）');
      clearInterval(state.pollTimer);state.pollTimer=0;
      setStatus('实时连接',true);
      const reader=response.body.getReader(),decoder=new TextDecoder();
      let buffer='';
      try{
        while(current()){
          const {value,done}=await reader.read();if(done||!current())break;
          buffer+=decoder.decode(value,{stream:true});
          let split;
          while((split=buffer.indexOf('\n\n'))>=0){
            const block=buffer.slice(0,split);buffer=buffer.slice(split+2);
            const event=block.match(/^event: (.+)$/m)?.[1],data=block.match(/^data: (.+)$/m)?.[1];
            if(event==='action'&&data){try{process(JSON.parse(data));}catch{}}
            else if(event==='stream_error')throw new Error('动作流读取失败');
          }
          if(buffer.length>100000)buffer='';
        }
      }finally{await reader.cancel().catch(()=>{});}
      if(current()){setStatus('正在重连',false);reconnect(1800);}
    }catch(e){
      if(!current())return;
      setStatus('定时更新',false);
      if(!state.pollTimer)state.pollTimer=setInterval(()=>void pollFallback(controller),1300);
      void pollFallback(controller);
      reconnect(6000);
    }
  }
  async function loadDimensionDefinitions(){
    const generation=state.generation;
    const {configuration}=await api('./api/memory/dimensions');
    if(generation!==state.generation)return;
    state.dimensionDefinitions=configuration.definitions;
    window.MindPondGraphRenderer.setDimensionDefinitions(configuration.definitions);updateLegend();
  }
  const connect=()=>changeScope(true,true);
  async function main(){
    $('apiKey').value=sessionStorage.getItem('mindpond:graph-api-key')||'';
    $('operatorKey').value=sessionStorage.getItem('mindpond:graph-operator-key')||'';
    constructRenderer($('mode').value);
    $('fit').onclick=()=>state.renderer.fit();
    $('zoomIn').onclick=()=>state.renderer.zoomBy(1.35);
    $('zoomOut').onclick=()=>state.renderer.zoomBy(1/1.35);
    $('owner').onchange=()=>{
      const url=new URL(location.href),value=$('owner').value;
      if(value)url.searchParams.set('owner',value);else url.searchParams.delete('owner');
      history.replaceState(null,'',url);
      $('space').value='';$('type').value='';
      changeScope(true,!state.ownerLabels.size).catch(e=>error(e.message));
    };
    $('reload').onclick=()=>connect().catch(e=>error(e.message));
    $('space').onchange=()=>{updateTypes(state.spaces||[]);changeScope().catch(e=>error(e.message));};
    for(const id of ['type','limit','events'])$(id).onchange=()=>changeScope().catch(e=>error(e.message));
    $('mode').onchange=()=>{constructRenderer($('mode').value);state.renderer.setGraph(state.nodes,state.edges,false);};
    $('connect').onclick=()=>connect().catch(e=>error(e.message));
    window.addEventListener('beforeunload',()=>{state.stopped=true;stopStream();});
    try{await connect();}catch(e){setStatus('图谱暂未载入',false);if(!state.ownerLabels.size)$('credentials').open=true;error(e.message);}
  }
  main();
})();

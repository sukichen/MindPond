'use strict';
/* Portable graph renderer: WebGL2 when hardware acceleration is available,
 * Canvas 2D otherwise. Layout and data are identical in both paths. */
(() => {
  const TAU = Math.PI * 2;
  const COLORS = Object.assign(Object.create(null), { fact: '#55b8ff', decision: '#d48aff', lesson: '#5af0bc', skill: '#ffc96b', event: '#708ca5' });
  const hash = value => { let h = 2166136261; for (const c of String(value)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const dimensionColor=id=>COLORS[id]||(COLORS[id]='#'+[0,8,16].map(shift=>(100+((hash(id)>>>shift)&127)).toString(16).padStart(2,'0')).join(''));
  const unit = (id, salt) => hash(id + ':' + salt) / 4294967295;
  const rgba = (hex, alpha = 1) => {
    const h = (COLORS[hex] || (String(hex).startsWith('#')?hex:dimensionColor(hex))).replace('#', '');
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, alpha];
  };
  const isEvent = n => n.dimension === 'event' || n.layer === 'L0';
  const identities = n => [...new Set((Array.isArray(n.dimensions) && n.dimensions.length ? n.dimensions : [n.dimension || 'fact']).filter(d => typeof d==='string' && d !== 'event').map(d=>{dimensionColor(d);return d;}))];
  // Allocate angular space by sqrt(count), so a large dimension gets room
  // without pushing smaller dimensions into invisible corners. The golden-ratio
  // angle sequence avoids the regular dot-grid pattern of an ordinary spiral.
  function place(n, index, total, start=0, span=TAU) {
    if(isEvent(n)){
      const angle=unit(n.id,1)*TAU,radius=970+unit(n.id,3)*210;
      return {x:Math.cos(angle)*radius,y:Math.sin(angle)*radius*.76};
    }
    const fraction=(index*.61803398875+unit(n.id,1)*.035)%1;
    const angle=start+span*fraction;
    const radius=55+790*Math.sqrt((index+.5)/Math.max(1,total))+(unit(n.id,2)-.5)*15;
    return {x:Math.cos(angle)*radius,y:Math.sin(angle)*radius*.76};
  }
  function curve(a, b, key) {
    const dx=b.x-a.x, dy=b.y-a.y, length=Math.hypot(dx,dy) || 1;
    const sign=hash(key)&1 ? 1 : -1;
    const bend=sign*Math.min(130,Math.max(25,length*.28));
    return { x:(a.x+b.x)/2-dy/length*bend, y:(a.y+b.y)/2+dx/length*bend };
  }
  function bezier(a,c,b,t) {
    const q=1-t;return {x:q*q*a.x+2*q*t*c.x+t*t*b.x,y:q*q*a.y+2*q*t*c.y+t*t*b.y};
  }
  const pairKey=(a,b)=>a<b?a+':'+b:b+':'+a;
  function splitCircleTriangles(out,center,dimensions,radius,centerAlpha,edgeAlpha){
    const steps=dimensions.length*8;
    for(let i=0;i<steps;i++){
      const color=dimensions[Math.floor(i/8)];
      const a=i*TAU/steps,b=(i+1)*TAU/steps;
      out.push(center.x,center.y,...rgba(color,centerAlpha),0,0);
      out.push(center.x,center.y,...rgba(color,edgeAlpha),Math.cos(a)*radius,Math.sin(a)*radius);
      out.push(center.x,center.y,...rgba(color,edgeAlpha),Math.cos(b)*radius,Math.sin(b)*radius);
    }
  }
  function bridgeRing(out,center,dimensions,radius){
    const steps=dimensions.length*8;
    for(let i=0;i<steps;i++){
      const a=i*TAU/steps,b=(i+1)*TAU/steps,color=rgba(dimensions[Math.floor(i/8)],.95);
      const inner=radius+1.3,outer=radius+3.6;
      const v=(angle,r)=>[center.x,center.y,...color,Math.cos(angle)*r,Math.sin(angle)*r];
      out.push(...v(a,inner),...v(a,outer),...v(b,outer));
      out.push(...v(a,inner),...v(b,outer),...v(b,inner));
    }
  }

  // Each direct hit starts at 1. A carried memory inherits the product of
  // every edge weight on its strongest visible path, with an extra hop decay.
  // Paths are evaluated per depth so a stronger two-hop path can beat a weak
  // direct edge. The visual traversal never claims that an agent read them.
  function computeWeightedRipple(adjacency, origin, options = {}) {
    const maxDepth = options.maxDepth ?? 24;
    const minScore = options.minScore ?? .055;
    const maxNodes = options.maxNodes ?? 180;
    const hopRetention = options.hopRetention ?? .88;
    const layers = [new Map([[origin, { id: origin, depth: 0, score: 1, path: [origin], scores: [1] }]])];
    const best = new Map();
    for (let depth = 0; depth <= maxDepth; depth++) {
      const layer = layers[depth];
      if (!layer?.size) break;
      for (const candidate of layer.values()) {
        const previous = best.get(candidate.id);
        if (!previous || candidate.score > previous.score) best.set(candidate.id, candidate);
        if (depth === maxDepth) continue;
        if (!layers[depth + 1]) layers[depth + 1] = new Map();
        for (const [next, edge] of adjacency.get(candidate.id) || []) {
          if (candidate.path.includes(next)) continue;
          const weight = Math.max(0, Math.min(1, Number(edge.weight ?? .5)));
          const score = candidate.score * weight * hopRetention;
          if (!Number.isFinite(score) || score < minScore) continue;
          const prior = layers[depth + 1].get(next);
          if (prior && prior.score >= score) continue;
          layers[depth + 1].set(next, {
            id: next, depth: depth + 1, score,
            path: [...candidate.path, next], scores: [...candidate.scores, score],
          });
        }
      }
      const nextLayer = layers[depth + 1];
      if (nextLayer?.size > maxNodes * 2)
        layers[depth + 1] = new Map([...nextLayer].sort((a, b) => b[1].score - a[1].score).slice(0, maxNodes * 2));
    }
    const nodes = [...best.values()].sort((a, b) => b.score - a.score).slice(0, maxNodes);
    const visible = new Set(nodes.map(node => node.id));
    const links = new Map();
    for (const node of nodes) {
      for (let i = 1; i < node.path.length; i++) {
        const from = node.path[i - 1], to = node.path[i];
        if (!visible.has(from) || !visible.has(to)) continue;
        const key = pairKey(from, to), previous = links.get(key);
        if (!previous || previous.score < node.scores[i])
          links.set(key, { from, to, depth: i, score: node.scores[i] });
      }
    }
    return { nodes, links: [...links.values()].sort((a, b) => a.depth - b.depth || b.score - a.score),
      maxDepth: Math.max(0, ...nodes.map(node => node.depth)) };
  }

  function compile(gl, kind, source) {
    const shader = gl.createShader(kind); gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader compile failed');
    return shader;
  }
  function program(gl) {
    const vertex = `#version 300 es
      in vec2 aPosition; in vec4 aColor; in vec2 aLocal;
      uniform vec2 uResolution; uniform vec2 uOffset; uniform float uZoom; uniform float uDpr; uniform float uNodeScale;
      out vec4 vColor;
      void main() {
        vec2 screen = (aPosition * uZoom + uOffset + aLocal * uNodeScale) * uDpr;
        gl_Position = vec4(screen.x / uResolution.x * 2.0 - 1.0, 1.0 - screen.y / uResolution.y * 2.0, 0.0, 1.0);
        vColor = aColor;
      }`;
    const fragment = `#version 300 es
      precision mediump float; in vec4 vColor; out vec4 outColor;
      void main() { outColor = vColor; }`;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vertex));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'shader link failed');
    return p;
  }
  function circleTriangles(out, center, color, radius, centerAlpha, edgeAlpha) {
    const count=10;
    const middle=rgba(color,centerAlpha), rim=rgba(color,edgeAlpha);
    for(let i=0;i<count;i++){
      const a=i*TAU/count,b=(i+1)*TAU/count;
      out.push(center.x,center.y,...middle,0,0);
      out.push(center.x,center.y,...rim,Math.cos(a)*radius,Math.sin(a)*radius);
      out.push(center.x,center.y,...rim,Math.cos(b)*radius,Math.sin(b)*radius);
    }
  }
  class GraphRenderer {
    constructor(host, mode = 'auto') {
      this.host = host; this.nodes = []; this.edges = []; this.positions = new Map(); this.adjacency = new Map();
      this.listeners = new Map(); this.selected = null; this.hovered = null; this.zoom = 1; this.offset = { x: 0, y: 0 };
      this.flashes = []; this.frame = 0; this.drag = null; this.lastClick = 0; this.dirtyBase = true;
      this.focus = null; this.hoverFocus = null; this.focusStartedAt = 0;
      this.edgeData=new Float32Array();this.nodeData=new Float32Array();this.glowData=new Float32Array();this.overviewEdges=[];this.nodeById=new Map();
      this.canvas = document.createElement('canvas'); this.canvas.className = 'graph-stage-canvas';
      let gl = null, renderer = '';
      if (mode !== 'canvas') {
        try {
          gl = this.canvas.getContext('webgl2', { powerPreference: 'high-performance', failIfMajorPerformanceCaveat: mode === 'auto', antialias: false, alpha: true });
          if (gl) {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
            if (mode === 'auto' && /swiftshader|llvmpipe|software/i.test(renderer)) gl = null;
          }
        } catch { gl = null; }
      }
      let gpuProgram = null;
      if (gl) { try { gpuProgram = program(gl); } catch (error) { if (mode === 'gpu') throw error; gl = null; } }
      if (!gl && mode === 'gpu') throw new Error('此浏览器无法建立硬件 WebGL2 上下文，请改用自动或兼容模式。');
      if (!gl) this.canvas = document.createElement('canvas');
      this.canvas.className = 'graph-stage-canvas'; this.host.replaceChildren(this.canvas);
      this.gl = gl; this.ctx = gl ? null : this.canvas.getContext('2d', { alpha: true });
      this.backend = gl ? 'WebGL2' : 'Canvas 2D'; this.renderer = gl ? renderer : '兼容模式';
      if (gl) {
        this.p = gpuProgram; this.edgeBuffer = gl.createBuffer(); this.nodeBuffer = gl.createBuffer(); this.glowBuffer=gl.createBuffer(); this.locations = {
          position: gl.getAttribLocation(this.p, 'aPosition'), color: gl.getAttribLocation(this.p, 'aColor'), local: gl.getAttribLocation(this.p, 'aLocal'),
          resolution: gl.getUniformLocation(this.p, 'uResolution'), offset: gl.getUniformLocation(this.p, 'uOffset'), zoom: gl.getUniformLocation(this.p, 'uZoom'),
          dpr: gl.getUniformLocation(this.p, 'uDpr'), nodeScale: gl.getUniformLocation(this.p, 'uNodeScale'),
        };
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      this.effect = document.createElement('canvas'); this.effect.className = 'graph-effect-canvas'; this.host.append(this.effect);
      this.effectCtx = this.effect.getContext('2d');
      this.bind();
      this.resizeObserver = new ResizeObserver(() => { this.resize(); if (this.nodes.length) this.fit(); else this.requestDraw(); }); this.resizeObserver.observe(host);
      this.resize();
    }
    on(name, fn) { const list = this.listeners.get(name) || []; list.push(fn); this.listeners.set(name, list); }
    emit(name, value) { for (const fn of this.listeners.get(name) || []) fn(value); }
    bind() {
      this.canvas.addEventListener('pointerdown', e => { this.drag = { x: e.clientX, y: e.clientY, ox: this.offset.x, oy: this.offset.y, moved: false }; this.canvas.setPointerCapture(e.pointerId); });
      this.canvas.addEventListener('pointermove', e => {
        if (this.drag) {
          const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
          if (this.drag.moved) { this.offset = { x: this.drag.ox + dx, y: this.drag.oy + dy }; this.dirtyBase=true; this.requestDraw(); }
        } else {
          const id = this.pick(e.offsetX, e.offsetY);
          if (id !== this.hovered) { this.hovered = id; this.hoverFocus = id ? computeWeightedRipple(this.adjacency, id, { maxDepth: 1, maxNodes: 20 }) : null; this.canvas.style.cursor = id ? 'pointer' : 'grab'; this.emit('hover', { nodeId: id }); this.requestDraw(); }
        }
      });
      this.canvas.addEventListener('pointerup', e => {
        const moved = this.drag?.moved; this.drag = null;
        if (moved) return;
        const id = this.pick(e.offsetX, e.offsetY);
        const double = id && id === this.selected && performance.now() - this.lastClick < 320;
        this.lastClick = performance.now();
        if (id) this.ripple(id);
        else { this.selected = null; this.focus = null; this.hovered = null; this.hoverFocus = null; this.dirtyBase = true; this.requestDraw(); }
        this.emit(double ? 'doubleClick' : 'click', { nodes: id ? [id] : [] });
      });
      this.canvas.addEventListener('wheel', e => {
        e.preventDefault(); const old = this.zoom, next = Math.max(.08, Math.min(8, old * Math.exp(-e.deltaY * .0012)));
        this.offset.x = e.offsetX - (e.offsetX - this.offset.x) * next / old;
        this.offset.y = e.offsetY - (e.offsetY - this.offset.y) * next / old;
        this.zoom = next; this.dirtyBase=true; this.requestDraw();
      }, { passive: false });
      this.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.emit('contextlost'); });
    }
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
      this.width = w; this.height = h; this.dpr = dpr;
      for (const c of [this.canvas, this.effect]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + 'px'; c.style.height = h + 'px'; }
      if (this.gl) this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.dirtyBase=true;
    }
    setGraph(nodes, edges, preserve = true) {
      const old = preserve ? this.positions : new Map();
      this.nodes = nodes; this.edges = edges; this.positions = new Map(); this.adjacency = new Map();
      this.nodeById = new Map(nodes.map(n=>[n.id,n]));
      const degree = new Map(nodes.map(n=>[n.id,0]));
      for (const e of edges) {
        if (!degree.has(e.fromId) || !degree.has(e.toId)) continue;
        degree.set(e.fromId,degree.get(e.fromId)+(e.weight||.5));
        degree.set(e.toId,degree.get(e.toId)+(e.weight||.5));
        if(!this.adjacency.has(e.fromId))this.adjacency.set(e.fromId,[]);
        if(!this.adjacency.has(e.toId))this.adjacency.set(e.toId,[]);
        this.adjacency.get(e.fromId).push([e.toId,e]);
        this.adjacency.get(e.toId).push([e.fromId,e]);
      }
      this.degree=degree;
      if (this.selected && this.nodeById.has(this.selected)) this.focus = computeWeightedRipple(this.adjacency, this.selected);
      else { this.selected = null; this.focus = null; }
      this.hoverFocus = this.hovered && this.nodeById.has(this.hovered)
        ? computeWeightedRipple(this.adjacency, this.hovered, { maxDepth: 1, maxNodes: 20 }) : null;
      const groups=new Map();
      for(const n of nodes.filter(n=>!isEvent(n)))for(const key of identities(n)){
        if(!groups.has(key))groups.set(key,[]);
        groups.get(key).push(n);
      }
      const ordered=[...groups].sort((a,b)=>b[1].length-a[1].length);
      const gap=Math.min(.10,TAU/Math.max(1,ordered.length)*.12),totalWeight=ordered.reduce((sum,[,group])=>sum+Math.sqrt(group.length),0);
      const spans=ordered.map(([,group])=>(TAU-gap*ordered.length)*Math.sqrt(group.length)/totalWeight);
      let start=ordered.length?Math.PI-spans[0]/2:0;
      const candidates=new Map();
      this.home=new Map();
      ordered.forEach(([,group],groupIndex)=>{
        group.sort((a,b)=>degree.get(b.id)-degree.get(a.id)||a.id.localeCompare(b.id));
        group.forEach((n,i)=>{
          if(!candidates.has(n.id))candidates.set(n.id,[]);
          candidates.get(n.id).push(place(n,i,group.length,start,spans[groupIndex]));
        });
        start+=spans[groupIndex]+gap;
      });
      for(const n of nodes.filter(n=>!isEvent(n))){
        const positions=candidates.get(n.id)||[place(n,0,1)];
        this.home.set(n.id,{x:positions.reduce((sum,p)=>sum+p.x,0)/positions.length,
          y:positions.reduce((sum,p)=>sum+p.y,0)/positions.length});
      }
      for (const n of nodes.filter(isEvent)) this.home.set(n.id,place(n,0,1));
      for (const n of nodes) this.positions.set(n.id,old.get(n.id)||{...this.home.get(n.id)});
      this.overviewEdges=edges.filter(e=>e.kind==='semantic'&&this.positions.has(e.fromId)&&this.positions.has(e.toId))
        .sort((a,b)=>(b.weight||0)-(a.weight||0)).slice(0,Math.min(850,Math.max(240,Math.round(nodes.length*.82))));
      if (!preserve || old.size === 0) this.relax();
      if (!preserve || old.size === 0) this.fit();
      this.rebuildBuffers(); this.requestDraw();
    }
    relax() {
      // Bounded topology pull, with a strong home force to prevent dense
      // communities from collapsing into an unreadable ball.
      for (let step = 0; step < 12; step++) {
        const delta = new Map();
        for (const e of this.overviewEdges) {
          const a=this.positions.get(e.fromId),b=this.positions.get(e.toId);
          if(!a||!b||e.fromId===e.toId)continue;
          const dx=b.x-a.x,dy=b.y-a.y,k=.005*Math.max(.2,e.weight||.5);
          const da=delta.get(e.fromId)||{x:0,y:0},db=delta.get(e.toId)||{x:0,y:0};
          da.x+=dx*k;da.y+=dy*k;db.x-=dx*k;db.y-=dy*k;
          delta.set(e.fromId,da);delta.set(e.toId,db);
        }
        for(const n of this.nodes){
          const p=this.positions.get(n.id),home=this.home.get(n.id),d=delta.get(n.id)||{x:0,y:0};
          p.x+=Math.max(-8,Math.min(8,d.x+(home.x-p.x)*.16));
          p.y+=Math.max(-8,Math.min(8,d.y+(home.y-p.y)*.16));
        }
      }
    }
    rebuildBuffers() {
      const nodeData=[],glowData=[],edgeData=[];
      for(const e of this.overviewEdges){
        const a=this.positions.get(e.fromId),b=this.positions.get(e.toId);if(!a||!b)continue;
        const control=curve(a,b,pairKey(e.fromId,e.toId));
        const from=this.nodeById.get(e.fromId),to=this.nodeById.get(e.toId);
        const ca=rgba(from?.dimension,.38*Math.max(.35,e.weight||.5)),cb=rgba(to?.dimension,.38*Math.max(.35,e.weight||.5));
        const steps=10;
        for(let i=0;i<steps;i++){
          for(const j of [i,i+1]){
            const t=j/steps,p=bezier(a,control,b,t);
            const color=ca.map((v,k)=>v+(cb[k]-v)*t);
            edgeData.push(p.x,p.y,...color,0,0);
          }
        }
      }
      for(const n of this.nodes){
        const p=this.positions.get(n.id);
        const degree=this.degree.get(n.id)||0;
        const size=isEvent(n)?2.2:n.layer==='L3'?7.2:n.layer==='L2'?5.8:3.2+Math.min(2.3,Math.sqrt(degree)*.8)+(n.importance||5)*.1;
        const dims=identities(n);
        circleTriangles(glowData,p,n.dimension,size*2.4,isEvent(n)?.04:.20,0);
        if(dims.length>1){splitCircleTriangles(nodeData,p,dims,size,.98,.92);bridgeRing(nodeData,p,dims,size);}
        else circleTriangles(nodeData,p,n.dimension,size,isEvent(n)?.5:.98,isEvent(n)?.42:.92);
      }
      this.edgeData=new Float32Array(edgeData);this.nodeData=new Float32Array(nodeData);this.glowData=new Float32Array(glowData);
      if(this.gl){
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER,this.edgeBuffer);this.gl.bufferData(this.gl.ARRAY_BUFFER,this.edgeData,this.gl.STATIC_DRAW);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER,this.glowBuffer);this.gl.bufferData(this.gl.ARRAY_BUFFER,this.glowData,this.gl.STATIC_DRAW);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER,this.nodeBuffer);this.gl.bufferData(this.gl.ARRAY_BUFFER,this.nodeData,this.gl.STATIC_DRAW);
      }
      this.dirtyBase=true;
    }
    fit(ids) {
      const positions = (ids?.length ? ids : this.nodes.filter(n => !isEvent(n)).map(n=>n.id)).map(id=>this.positions.get(id)).filter(Boolean);
      if (!positions.length) return;
      const xs = positions.map(p=>p.x), ys = positions.map(p=>p.y);
      const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
      this.zoom = Math.max(.08,Math.min(2,Math.min((this.width-90)/Math.max(1,maxX-minX),(this.height-90)/Math.max(1,maxY-minY))));
      this.offset={x:this.width/2-(minX+maxX)/2*this.zoom,y:this.height/2-(minY+maxY)/2*this.zoom}; this.dirtyBase=true; this.requestDraw();
    }
    pick(x,y) {
      let best = null, d2 = 14*14;
      for (const n of this.nodes) {
        const p=this.positions.get(n.id); if(!p)continue;
        const sx=p.x*this.zoom+this.offset.x, sy=p.y*this.zoom+this.offset.y;
        const dist=(sx-x)**2+(sy-y)**2;
        if(dist<d2){best=n.id;d2=dist;}
      }
      return best;
    }
    nodeScale() { const cap=this.nodes.length<=3?2.6:this.nodes.length<100?1.6:1;
      return Math.max(.36, Math.min(cap, Math.sqrt(this.width*this.height / Math.max(1,this.nodes.length*600)))); }
    point(id) { const p=this.positions.get(id); return p ? {x:p.x*this.zoom+this.offset.x,y:p.y*this.zoom+this.offset.y} : null; }
    reveal(id) { const p=this.point(id); if(!p)return; if(p.x<70||p.x>this.width-70||p.y<95||p.y>this.height-95){this.offset.x+=this.width/2-p.x;this.offset.y+=this.height/2-p.y;this.dirtyBase=true;this.requestDraw();} }
    zoomBy(factor) { const old=this.zoom,next=Math.max(.08,Math.min(8,old*factor));this.offset.x=this.width/2-(this.width/2-this.offset.x)*next/old;this.offset.y=this.height/2-(this.height/2-this.offset.y)*next/old;this.zoom=next;this.dirtyBase=true;this.requestDraw(); }
    flash(action) {
      const now=performance.now();
      const ids=[action.nodeId,action.fromId,action.toId].filter(id=>this.positions.has(id));
      for (const id of ids) this.flashes.push({id,start:now,life:1700,color:action.action?.includes('delete')?'#ff786d':action.action?.includes('association')?'#9abaff':'#ffe29b'});
      if (action.fromId && action.toId && this.positions.has(action.fromId) && this.positions.has(action.toId))
        this.flashes.push({from:action.fromId,to:action.toId,start:now,life:1400,color:'#89d9ff'});
      this.requestDraw();
    }
    trace(path) {
      if(!Array.isArray(path))return;
      const now=performance.now();
      for(let i=0;i<path.length;i++) {
        const id=path[i];if(!this.positions.has(id))continue;
        this.flashes.push({id,start:now+i*260,life:1250,color:i?'#75d7ff':'#ffe29b'});
        if(i>0&&id!==path[i-1]&&this.positions.has(path[i-1]))
          this.flashes.push({from:path[i-1],to:id,start:now+(i-1)*260,life:900,color:'#6fd9fb'});
      }
      this.requestDraw();
    }
    ripple(id) {
      if (!this.positions.has(id)) return null;
      this.selected = id;
      this.focus = computeWeightedRipple(this.adjacency, id);
      this.focusStartedAt = performance.now();
      this.dirtyBase = true;
      this.requestDraw();
      return this.focus;
    }
    requestDraw() { if (!this.frame) this.frame=requestAnimationFrame(t=>{this.frame=0;this.draw(t);}); }
    draw(t) {
      if (this.dirtyBase) { if (this.gl) this.drawGl(); else this.drawCanvas(); this.dirtyBase=false; this.emit('view'); }
      const fx=this.effectCtx, d=this.dpr; fx.clearRect(0,0,this.effect.width,this.effect.height);
      if(this.selected){fx.fillStyle='rgba(3,11,21,.58)';fx.fillRect(0,0,this.effect.width,this.effect.height);}
      const propagating = this.drawFocusLinks(fx,d,t);
      this.drawSparseLabel(fx,d);
      const active=[];
      for(const f of this.flashes){const age=t-f.start;if(age<0){active.push(f);continue;}if(age>f.life)continue;active.push(f);
        const k=age/f.life, color=f.color;
        if(f.id){const p=this.point(f.id);if(!p)continue;const r=8+k*42;
          fx.strokeStyle=color;fx.globalAlpha=(1-k)*.85;fx.lineWidth=(2.5-k*1.5)*d;fx.beginPath();fx.arc(p.x*d,p.y*d,r*d,0,TAU);fx.stroke();
          fx.fillStyle=color;fx.globalAlpha=(1-k)*.55;fx.beginPath();fx.arc(p.x*d,p.y*d,Math.max(3,12*(1-k))*d,0,TAU);fx.fill();
        } else {const a=this.point(f.from),b=this.point(f.to);if(!a||!b)continue;
          const c=curve(a,b,pairKey(f.from,f.to)),p=bezier(a,c,b,k);
          fx.strokeStyle=color;fx.globalAlpha=(1-k)*.7;fx.lineWidth=2*d;fx.beginPath();fx.moveTo(a.x*d,a.y*d);
          for(let step=1;step<=12;step++){const q=bezier(a,c,b,k*step/12);fx.lineTo(q.x*d,q.y*d);}fx.stroke();
          fx.fillStyle='#ffffff';fx.globalAlpha=1-k;fx.beginPath();fx.arc(p.x*d,p.y*d,3*d,0,TAU);fx.fill();}
      }
      fx.globalAlpha=1;this.flashes=active;
      if(this.selected){const p=this.point(this.selected);if(p){fx.strokeStyle='#ffdc93';fx.lineWidth=2*d;fx.beginPath();fx.arc(p.x*d,p.y*d,17*d,0,TAU);fx.stroke();}}
      if(active.length || propagating) this.requestDraw();
    }
    drawGl() {
      const gl=this.gl,l=this.locations;gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.p);gl.uniform2f(l.resolution,this.canvas.width,this.canvas.height);gl.uniform2f(l.offset,this.offset.x,this.offset.y);
      gl.uniform1f(l.zoom,this.zoom);gl.uniform1f(l.dpr,this.dpr);gl.uniform1f(l.nodeScale,this.nodeScale());
      const draw=(data,buffer,mode)=>{if(!data.length)return;gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
        gl.enableVertexAttribArray(l.position);gl.vertexAttribPointer(l.position,2,gl.FLOAT,false,32,0);
        gl.enableVertexAttribArray(l.color);gl.vertexAttribPointer(l.color,4,gl.FLOAT,false,32,8);
        gl.enableVertexAttribArray(l.local);gl.vertexAttribPointer(l.local,2,gl.FLOAT,false,32,24);
        gl.drawArrays(mode,0,data.length/8);};
      draw(this.edgeData,this.edgeBuffer,gl.LINES);
      draw(this.glowData,this.glowBuffer,gl.TRIANGLES);
      draw(this.nodeData,this.nodeBuffer,gl.TRIANGLES);
    }
    drawFocusLinks(ctx, d, now) {
      const focus = this.selected ? this.focus : this.hoverFocus;
      if (!focus) return false;
      const elapsed = this.selected ? Math.max(0, now - this.focusStartedAt) : Infinity;
      const waveGap = Math.min(210, 2400 / Math.max(1, focus.maxDepth));
      const revealTime = Math.min(270, waveGap * 1.3);
      for (const link of focus.links) {
        const progress = Math.min(1, Math.max(0, (elapsed - link.depth * waveGap) / revealTime));
        if (!progress) continue;
        const a = this.point(link.from), b = this.point(link.to);
        if (!a || !b) continue;
        const control = curve(a, b, pairKey(link.from, link.to));
        const fromColor = COLORS[this.nodeById.get(link.from)?.dimension] || '#a6d6ff';
        const toColor = COLORS[this.nodeById.get(link.to)?.dimension] || '#a6d6ff';
        const gradient = ctx.createLinearGradient(a.x*d, a.y*d, b.x*d, b.y*d);
        gradient.addColorStop(0, fromColor); gradient.addColorStop(1, toColor);
        ctx.strokeStyle = gradient;
        ctx.globalAlpha = (.08 + .82 * link.score) * (.12 + .88 * progress);
        ctx.lineWidth = (.8 + 1.8 * link.score) * d;
        ctx.shadowColor = fromColor; ctx.shadowBlur = 8 * link.score * d;
        ctx.beginPath(); ctx.moveTo(a.x*d, a.y*d);
        ctx.quadraticCurveTo(control.x*d, control.y*d, b.x*d, b.y*d); ctx.stroke();
        ctx.shadowBlur = 0;
        if (progress < 1 && this.selected) {
          const tip = bezier(a, control, b, progress);
          ctx.fillStyle = '#effaff'; ctx.globalAlpha = link.score * (1 - progress*.45);
          ctx.beginPath(); ctx.arc(tip.x*d, tip.y*d, (2 + link.score*2)*d, 0, TAU); ctx.fill();
        }
      }
      for (const node of focus.nodes) {
        const progress = node.depth === 0 ? 1 : Math.min(1, Math.max(0, (elapsed - node.depth * waveGap) / revealTime));
        if (!progress) continue;
        const point = this.point(node.id); if (!point) continue;
        const color = COLORS[this.nodeById.get(node.id)?.dimension] || '#a6d6ff';
        const alpha = (.10 + .90 * node.score) * (.2 + .8 * progress);
        const radius = (2.2 + 4.8 * node.score) * d;
        ctx.fillStyle = color; ctx.globalAlpha = alpha * .22;
        ctx.beginPath(); ctx.arc(point.x*d, point.y*d, radius*2.4, 0, TAU); ctx.fill();
        ctx.globalAlpha = alpha; ctx.beginPath(); ctx.arc(point.x*d, point.y*d, radius, 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
      return !!this.selected && elapsed < focus.maxDepth * waveGap + revealTime;
    }
    drawSparseLabel(ctx,d) {
      if(this.nodes.length!==1)return;
      const node=this.nodes[0],point=this.point(node.id);if(!point)return;
      const firstLine=(node.content||'记忆').trim().split('\n')[0];
      const label=firstLine.length>26?firstLine.slice(0,26)+'…':firstLine;
      ctx.font=`${12*d}px system-ui, sans-serif`;
      const width=Math.min(350,this.width-28,ctx.measureText(label).width/d+24);
      const rightFits=point.x+22+width<=this.width-12;
      const x=rightFits?point.x+22:Math.max(12,(this.width-width)/2);
      const y=Math.min(this.height-43,Math.max(12,rightFits?point.y-16:point.y+22));
      ctx.fillStyle='rgba(8,28,46,.92)';ctx.strokeStyle=COLORS[node.dimension]||'#b7d7ef';
      ctx.globalAlpha=.95;ctx.lineWidth=d;
      ctx.fillRect(x*d,y*d,width*d,32*d);ctx.strokeRect(x*d,y*d,width*d,32*d);
      ctx.fillStyle='#eff8ff';ctx.fillText(label,(x+12)*d,(y+21)*d,Math.max(1,width-24)*d);
      ctx.globalAlpha=1;
    }
    drawCanvas() {
      const ctx=this.ctx,d=this.dpr;ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,this.width,this.height);
      for(const e of this.overviewEdges){
        const a=this.point(e.fromId),b=this.point(e.toId);if(!a||!b)continue;
        if((a.x<0&&b.x<0)||(a.y<0&&b.y<0)||(a.x>this.width&&b.x>this.width)||(a.y>this.height&&b.y>this.height))continue;
        const c=curve(a,b,pairKey(e.fromId,e.toId));
        ctx.strokeStyle=COLORS[this.nodeById.get(e.fromId)?.dimension]||'#6893b7';
        ctx.globalAlpha=.38*Math.max(.35,e.weight||.5);ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.quadraticCurveTo(c.x,c.y,b.x,b.y);ctx.stroke();
      }
      for(const n of this.nodes){
        const p=this.point(n.id);if(!p||p.x<-20||p.y<-20||p.x>this.width+20||p.y>this.height+20)continue;
        const color=COLORS[n.dimension]||COLORS.event;
        const radius=(isEvent(n)?2.4:n.layer==='L3'?7:n.layer==='L2'?5.5:3.8+Math.min(2,(n.importance||5)*.18))*this.nodeScale();
        ctx.fillStyle=color;ctx.globalAlpha=isEvent(n)?.04:.10;ctx.beginPath();ctx.arc(p.x,p.y,radius*2.15,0,TAU);ctx.fill();
        ctx.globalAlpha=isEvent(n)?.55:1;
        const dims=identities(n);
        if(dims.length>1)dims.forEach((dim,i)=>{
          ctx.fillStyle=COLORS[dim];ctx.beginPath();ctx.moveTo(p.x,p.y);
          ctx.arc(p.x,p.y,radius,i*TAU/dims.length,(i+1)*TAU/dims.length);ctx.closePath();ctx.fill();
          ctx.strokeStyle=COLORS[dim];ctx.lineWidth=2;ctx.beginPath();
          ctx.arc(p.x,p.y,radius+3,i*TAU/dims.length,(i+1)*TAU/dims.length);ctx.stroke();
        });
        else {ctx.beginPath();ctx.arc(p.x,p.y,radius,0,TAU);ctx.fill();}
      }
      ctx.globalAlpha=1;
    }
    destroy(){cancelAnimationFrame(this.frame);this.resizeObserver.disconnect();this.host.replaceChildren();if(this.gl){this.gl.deleteBuffer(this.edgeBuffer);this.gl.deleteBuffer(this.nodeBuffer);this.gl.deleteBuffer(this.glowBuffer);this.gl.deleteProgram(this.p);}this.listeners.clear();}
  }
  GraphRenderer.setDimensionDefinitions=definitions=>{for(const d of definitions||[])COLORS[d.id]=d.color;};
  GraphRenderer.dimensionColor=dimensionColor;
  GraphRenderer.computeWeightedRipple = computeWeightedRipple;
  window.MindPondGraphRenderer = GraphRenderer;
})();

/* Axis-aligned navigation in scene coordinates. Rectangles include clearance for the entire sprite. */
(() => {
  'use strict';
  const inside=(p,r)=>p.x>=r.left&&p.x<=r.right&&p.y>=r.top&&p.y<=r.bottom;
  function clearSegment(a,b,obstacles){
    for(const r of obstacles){
      let low=0,high=1;
      for(const [origin,delta,min,max] of [[a.x,b.x-a.x,r.left,r.right],[a.y,b.y-a.y,r.top,r.bottom]]){
        if(Math.abs(delta)<1e-9){if(origin<min||origin>max){low=2;break;}}
        else{const t1=(min-origin)/delta,t2=(max-origin)/delta;low=Math.max(low,Math.min(t1,t2));high=Math.min(high,Math.max(t1,t2));}
      }
      if(low<=high)return false;
    }
    return true;
  }
  const inflate=(r,hx,hy)=>({left:r.left-hx,top:r.top-hy,right:r.right+hx,bottom:r.bottom+hy});
  class Heap {
    constructor(){this.items=[];}
    push(n){const a=this.items;let i=a.length;a.push(n);while(i){const p=(i-1)>>1;if(a[p].score<=n.score)break;a[i]=a[p];i=p;}a[i]=n;}
    pop(){const a=this.items,first=a[0],last=a.pop();if(a.length){let i=0;while(i*2+1<a.length){let c=i*2+1;if(c+1<a.length&&a[c+1].score<a[c].score)c++;if(a[c].score>=last.score)break;a[i]=a[c];i=c;}a[i]=last;}return first;}
  }
  function planRoute(start,goal,{bounds,obstacles,halfWidth,halfHeight,clearance=12,step=18}){
    const hx=halfWidth+clearance,hy=halfHeight+clearance,area={left:bounds.left+hx,top:bounds.top+hy,right:bounds.right-hx,bottom:bounds.bottom-hy};
    if(area.right<area.left||area.bottom<area.top||!inside(start,area)||!inside(goal,area))return null;
    const blocked=obstacles.map(r=>inflate(r,hx,hy));
    if(blocked.some(r=>inside(start,r)||inside(goal,r)))return null;
    if(clearSegment(start,goal,blocked))return [start,goal];
    // Exact start/goal coordinates plus a bounded grid. A narrow route may be declined, never clipped.
    while((area.right-area.left)/step*(area.bottom-area.top)/step>40000)step*=1.4;
    const axis=(min,max,a,b)=>[...new Set([min,max,a,b,...Array.from({length:Math.floor((max-min)/step)},(_,i)=>min+(i+1)*step)])].sort((a,b)=>a-b);
    const xs=axis(area.left,area.right,start.x,goal.x),ys=axis(area.top,area.bottom,start.y,goal.y),w=xs.length;
    const startId=ys.indexOf(start.y)*w+xs.indexOf(start.x),goalId=ys.indexOf(goal.y)*w+xs.indexOf(goal.x),cost=new Map([[startId,0]]),previous=new Map(),open=new Heap(),closed=new Set();
    const point=id=>({x:xs[id%w],y:ys[Math.floor(id/w)]}),distance=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
    open.push({id:startId,score:distance(start,goal)});
    while(open.items.length){
      const {id}=open.pop();if(closed.has(id))continue;
      if(id===goalId){let at=id,route=[goal];while(at!==startId){at=previous.get(at);route.push(point(at));}route.reverse();const smooth=[route[0]];let i=0;while(i<route.length-1){let j=route.length-1;while(j>i+1&&!clearSegment(route[i],route[j],blocked))j--;smooth.push(route[j]);i=j;}return smooth;}
      closed.add(id);const x=id%w,y=Math.floor(id/w),a=point(id);
      for(const [nx,ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]){
        if(nx<0||nx>=w||ny<0||ny>=ys.length)continue;
        const next=ny*w+nx;if(closed.has(next))continue;const b=point(next);
        if(!clearSegment(a,b,blocked))continue;
        const g=cost.get(id)+distance(a,b);if(g>=(cost.get(next)??Infinity))continue;
        cost.set(next,g);previous.set(next,id);open.push({id:next,score:g+distance(b,goal)});
      }
    }
    return null;
  }
  function framesForRoute(route,start){
    const outward=route.map(p=>({...p})),points=[...outward,{...outward.at(-1)},...outward.slice(0,-1).reverse()];
    let length=0;const lengths=points.map((p,i)=>{length+=i?Math.hypot(p.x-points[i-1].x,p.y-points[i-1].y):0;return length;});
    const pause=70,total=length+pause;
    return points.map((p,i)=>({transform:`translate(${p.x-start.x}px,${p.y-start.y}px)`,offset:(lengths[i]+(i>=outward.length?pause:0))/total}));
  }
  window.MindPondOfficeNavigation={planRoute,clearSegment,inflate,framesForRoute};
})();

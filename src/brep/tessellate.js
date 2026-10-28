'use strict';
/* Triangulate the B-rep for STL, for parts saved without display data (EXP-084).
 *
 *   tessellate(model, {tolerance}) -> {vertices: [[x,y,z]], faces: [{id, source, triangles: [[i,j,k]]}]}
 *
 * The model is a resolved, seam-split one (src/brep/procedural.js, then src/brep/split.js), as the
 * exact STEP writer uses. `tolerance` is the largest distance, in metres, between a triangle and the
 * surface or edge curve it stands for (default 1e-5, 0.01 mm).
 *
 * Every edge is sampled once, to the tolerance, and both faces that use it take those same
 * points, so the mesh closes along every edge. A face is triangulated in its surface's own (u,v):
 * after splitting, a face on a periodic surface lies inside one cell of width π, so a single
 * branch of u (and of v on a torus) holds its whole boundary. Ear clipping, with holes bridged to
 * the outer loop, gives a first triangulation over the boundary points. Then, wherever the surface
 * strays further than the tolerance from a triangle, an interior edge is bisected or the centroid
 * added, on the exact surface. Where the surface collapses to a point (a sphere's pole, a cone's
 * apex, a blend's tip) the boundary point gets one (u,v) per neighbouring side, which keeps the
 * parameter polygon simple; triangles left with no area are dropped.
 *
 * Triangles face outward: every triangle runs counter-clockwise in (u,v), which is the direction
 * of S_u × S_v, so a face that runs against its surface has all of them reversed.
 */
const G=require('../geom/eval'),{edgePath}=require('./volume');

const TAU=2*Math.PI,wrapTo=(x,ref)=>x-TAU*Math.round((x-ref)/TAU);
const PERIODIC_U=new Set(['cylinder','cone','sphere','torus','spun']);

/* Distance from q to segment ab. */
function segDist(q,a,b){
  const ab=G.sub(b,a),L=G.dot(ab,ab);if(!L)return G.dist(q,a);
  const t=Math.max(0,Math.min(1,G.dot(G.sub(q,a),ab)/L));return G.dist(q,G.add(a,G.mul(ab,t)));
}

/* Points along an edge from its start vertex to its end vertex, each chord within tol of the
 * curve (checked at the quarter points, so an S-bend inside a chord is not missed). */
function sampleEdge(e,M,tol){
  const p=edgePath(e,M.vertices),at=t=>G.curvePoint(p.c,t);
  if(p.c.type==='line'){const out=[at(p.t0),at(p.t1)];return fixEnds(out,e,M);}
  let cuts=[p.t0,p.t1];
  if(p.c.type==='bspline'){const lo=Math.min(p.t0,p.t1),hi=Math.max(p.t0,p.t1),ks=[...new Set(p.c.knots)].filter(k=>k>lo&&k<hi).sort((a,b)=>a-b);
    cuts=[p.t0,...(p.t1>p.t0?ks:ks.reverse()),p.t1];}
  const ts=[];for(let i=0;i+1<cuts.length;i++)for(let k=0;k<4;k++)ts.push(cuts[i]+(cuts[i+1]-cuts[i])*k/4);ts.push(p.t1);
  const out=[at(ts[0])];
  function rec(a,b,A,B,depth){
    const m=(a+b)/2,Mp=at(m);
    if(depth<20&&(segDist(Mp,A,B)>tol||segDist(at(a+(b-a)/4),A,B)>tol||segDist(at(a+3*(b-a)/4),A,B)>tol)){rec(a,m,A,Mp,depth+1);rec(m,b,Mp,B,depth+1);}
    else out.push(B);
  }
  for(let i=0;i+1<ts.length;i++)rec(ts[i],ts[i+1],out[out.length-1],at(ts[i+1]),0);
  return fixEnds(out,e,M);
}
/* The ends are the vertices themselves, so edges meeting there share the exact point. */
function fixEnds(out,e,M){
  if(e.v){out[0]=M.vertices.get(e.v[0]).p;out[out.length-1]=M.vertices.get(e.v[1]).p;}
  else out[out.length-1]=out[0];
  return out;
}

const area2=P=>{let a=0;for(let i=0;i<P.length;i++){const p=P[i],q=P[(i+1)%P.length];a+=p.x*q.y-q.x*p.y;}return a/2;};
const orient=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function inTri(p,a,b,c){return orient(a,b,p)>=0&&orient(b,c,p)>=0&&orient(c,a,p)>=0;}
function cross2(a,b,c,d){   // segments ab and cd cross properly
  const d1=orient(a,b,c),d2=orient(a,b,d),d3=orient(c,d,a),d4=orient(c,d,b);
  return ((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0));
}

/* One polygon from an outer loop (counter-clockwise) and holes (clockwise): each hole joined to
 * the polygon by a two-way bridge from its rightmost point to the nearest point it can see. */
function bridge(outer,holes){
  let poly=outer.slice();
  holes=holes.map(h=>{let m=0;for(let i=1;i<h.length;i++)if(h[i].x>h[m].x)m=i;return {h,m};}).sort((a,b)=>b.h[b.m].x-a.h[a.m].x);
  for(let k=0;k<holes.length;k++){
    const {h,m}=holes[k],M=h[m],rest=holes.slice(k+1).map(x=>x.h);
    const order=poly.map((p,i)=>[i,(p.x-M.x)**2+(p.y-M.y)**2]).sort((a,b)=>a[1]-b[1]);
    let best=order[0][0];
    for(const [i] of order){const P=poly[i];let ok=true;
      for(const ring of [poly,h,...rest]){for(let j=0;j<ring.length&&ok;j++)if(cross2(M,P,ring[j],ring[(j+1)%ring.length]))ok=false;if(!ok)break;}
      if(ok){best=i;break;}}
    const loop=[...h.slice(m),...h.slice(0,m+1)];
    poly=[...poly.slice(0,best+1),...loop,poly[best],...poly.slice(best+1)];
  }
  return poly;
}

/* Ear clipping of a simple polygon (counter-clockwise). Returns triangles of polygon indices. */
function earClip(P){
  const n=P.length,next=new Int32Array(n),prev=new Int32Array(n),out=[];
  for(let i=0;i<n;i++){next[i]=(i+1)%n;prev[i]=(i+n-1)%n;}
  let left=n,i=0,stall=0;
  const same=(a,b)=>a.x===b.x&&a.y===b.y;
  function ear(i,strict){
    const a=P[prev[i]],b=P[i],c=P[next[i]],o=orient(a,b,c);
    if(strict?o<=0:o<0)return false;
    for(let j=next[next[i]];j!==prev[i];j=next[j]){const q=P[j];if(same(q,a)||same(q,b)||same(q,c))continue;if(inTri(q,a,b,c))return false;}
    return true;
  }
  let strict=true;
  while(left>3){
    if(ear(i,strict)){out.push([prev[i],i,next[i]]);next[prev[i]]=next[i];prev[next[i]]=prev[i];left--;i=next[i];stall=0;strict=true;continue;}
    i=next[i];
    if(++stall>left){if(strict){strict=false;stall=0;}else{out.push([prev[i],i,next[i]]);next[prev[i]]=next[i];prev[next[i]]=prev[i];left--;stall=0;}}
  }
  out.push([prev[i],i,next[i]]);
  return out;
}

function tessellate(M,opts={}){
  const tol=opts.tolerance||1e-5,vertices=[],key=new Map(),edgeCache=new Map();
  const vid=p=>{const k=p[0]+','+p[1]+','+p[2];let i=key.get(k);if(i===undefined){i=vertices.length;vertices.push(p);key.set(k,i);}return i;};
  const edge=id=>{let s=edgeCache.get(id);if(!s){s=sampleEdge(M.edges.get(id),M,tol).map(p=>({p,i:vid(p)}));edgeCache.set(id,s);}return s;};
  const faces=[];
  for(const f of M.faces){
    const s=f.surface,ev=(u,v)=>G.surfaceEval(s,u,v);
    // boundary loops, 3D, each point once
    const loops3=f.loops.map(l=>{const pts=[];for(const co of l.coedges){let e=edge(co.edge);if(!co.sense)e=e.slice().reverse();pts.push(...e.slice(0,-1));}return pts;}).filter(l=>l.length>=2);
    if(!loops3.length){faces.push({id:f.id,source:f.source,triangles:[]});continue;}
    // (u,v), warm-started along each loop, then onto one branch
    const loopsUV=loops3.map(l=>{let near=null;return l.map(q=>{const r=G.surfaceInverse(s,q.p,near);near=r;return {u:r.u,v:r.v,p:q.p,i:q.i};});});
    const all=loopsUV.flat(),circ=k=>Math.atan2(all.reduce((a,q)=>a+Math.sin(q[k]),0),all.reduce((a,q)=>a+Math.cos(q[k]),0));
    // the split says which cell the face is in; without it, the boundary's circular mean
    const C=f.cell;
    if(PERIODIC_U.has(s.type)){const r=C?(C.u0+C.u1)/2:circ('u');for(const q of all)q.u=wrapTo(q.u,r);}
    if(s.type==='torus'){const r=C?(C.v0+C.v1)/2:circ('v');for(const q of all)q.v=wrapTo(q.v,r);}
    // A boundary on the edge of the parameter range comes back from the inverse a hair inside it
    // (u up to 2e-5 on a 1 mm wide B-spline ribbon, whose fitted edge curves sit nanometres off
    // the surface), so the straight side zigzags in (u,v). Snap it when the iso-line is within a
    // tenth of the tolerance. Only the (u,v) moves; the vertex stays the curve's own point.
    const R=G.surfaceRange(s);
    if(R)for(const q of all)for(const [key,[lo,hi]] of [['u',R[0]],['v',R[1]]])for(const b of [lo,hi]){
      if(!Number.isFinite(b)||q[key]===b||Math.abs(q[key]-b)>1e-4*(hi-lo))continue;
      const t={u:q.u,v:q.v,[key]:b};if(G.dist(ev(t.u,t.v).p,q.p)<=0.1*tol)q[key]=b;}
    // a point where the surface collapses: one (u,v) per side
    const loops=loopsUV.map(L=>{const out=[];
      for(let k=0;k<L.length;k++){const q=L[k],e=ev(q.u,q.v),a=L[(k+L.length-1)%L.length],b=L[(k+1)%L.length];
        const nu=G.norm(e.du),nv=G.norm(e.dv),big=Math.max(nu,nv)||1;
        if(nu<1e-9*big&&L.length>2)out.push({...q,u:a.u},{...q,u:b.u});
        else if(nv<1e-9*big&&L.length>2)out.push({...q,v:a.v},{...q,v:b.v});
        else out.push(q);}
      return out;});
    // 2D coordinates scaled to roughly metres at the face's middle
    const mu=all.reduce((a,q)=>a+q.u,0)/all.length,mv=all.reduce((a,q)=>a+q.v,0)/all.length,e0=ev(mu,mv);
    const su=G.norm(e0.du)||1,sv=G.norm(e0.dv)||1;
    const pts=[];for(const L of loops)for(const q of L){q.x=q.u*su;q.y=q.v*sv;q.k=pts.length;pts.push(q);}
    // outer loop counter-clockwise, holes clockwise
    let outer=0;loops.forEach((L,k)=>{if(Math.abs(area2(L))>Math.abs(area2(loops[outer])))outer=k;});
    const ring=(L,ccw)=>(area2(L)>0)===ccw?L:L.slice().reverse();
    const poly=bridge(ring(loops[outer],true),loops.filter((_,k)=>k!==outer).map(L=>ring(L,false)));
    let tris=earClip(poly).map(t=>t.map(j=>poly[j].k));
    // boundary segments stay as they are; everything else may be split
    const boundary=new Set();for(const L of loops)for(let k=0;k<L.length;k++){const a=L[k].k,b=L[(k+1)%L.length].k;boundary.add(a<b?a+','+b:b+','+a);}
    if(s.type!=='plane')tris=refine(pts,tris,boundary,ev,tol,opts.maxTriangles||200000,su,sv);
    // to global indices, outward, no zero-area triangles
    const sign=f.sameSense?1:-1,out=[];
    for(const t of tris){
      const g=t.map(j=>pts[j].i===undefined?(pts[j].i=vid(pts[j].p)):pts[j].i);
      if(g[0]===g[1]||g[1]===g[2]||g[0]===g[2])continue;
      const [A,B,C]=g.map(j=>vertices[j]);if(!G.norm(G.cross(G.sub(B,A),G.sub(C,A))))continue;
      out.push(sign>0?g:[g[0],g[2],g[1]]);
    }
    faces.push({id:f.id,source:f.source,triangles:out,...(opts.debug?{uv:pts,local:tris}:{})});
  }
  return {vertices,faces};
}

/* Bisect interior edges, or add centroids, until every triangle is within tol of the surface. */
function refine(pts,tris,boundary,ev,tol,limit,su,sv){
  const T=tris.slice(),edges=new Map(),k=(a,b)=>a<b?a+','+b:b+','+a;
  const link=(t,on)=>{const x=T[t];for(let j=0;j<3;j++){const kk=k(x[j],x[(j+1)%3]);let s=edges.get(kk);if(!s)edges.set(kk,s=new Set());on?s.add(t):s.delete(t);}};
  T.forEach((_,t)=>link(t,true));
  const point=(u,v)=>{const p={u,v,p:ev(u,v).p,k:pts.length};pts.push(p);return p.k;};
  // A split is kept only if every new triangle still runs counter-clockwise in (u,v). On a sliver
  // a rounded midpoint can land on the wrong side, and an inverted triangle breaks the mesh.
  const ccw=t=>orient(uv(t[0]),uv(t[1]),uv(t[2]))>0;
  const mid3=(a,b)=>G.mul(G.add(pts[a].p,pts[b].p),0.5);
  const dev=(a,b)=>G.dist(ev((pts[a].u+pts[b].u)/2,(pts[a].v+pts[b].v)/2).p,mid3(a,b));
  const uv=j=>({x:pts[j].u*su,y:pts[j].v*sv});
  // An interior edge between two boundary points can run along a straight stretch of the boundary
  // (a cone's seam line has only its two end points). Its midpoint would then sit on the boundary,
  // where the neighbouring face has no point, and the mesh would open there: such a split is refused.
  const nb=pts.length,bseg=[...boundary].map(kk=>kk.split(',').map(Number));
  const onBoundary=(a,b,u,v)=>{if(a>=nb||b>=nb)return false;const q={x:u*su,y:v*sv};
    return bseg.some(([i,j])=>{const A=uv(i),B=uv(j),L=Math.hypot(B.x-A.x,B.y-A.y);if(!L)return false;
      const t=((q.x-A.x)*(B.x-A.x)+(q.y-A.y)*(B.y-A.y))/(L*L);if(t<=0||t>=1)return false;
      return Math.abs((B.x-A.x)*(q.y-A.y)-(B.y-A.y)*(q.x-A.x))/L<=1e-12*L;});};
  // Of the two diagonals of a convex quad, keep the one nearer the surface: on a cylinder that is
  // the straight line along the axis, which then needs no splitting.
  // Only edges next to a change are looked at again. A flip whose new diagonal already exists
  // would make the mesh non-manifold, so it is refused whatever the (u,v) tests say.
  function flips(keys){
    const changed=new Set();
    for(let pass=0;pass<50&&keys.size;pass++){const again=new Set();
      for(const kk of keys){const set=edges.get(kk);if(!set||set.size!==2||boundary.has(kk))continue;
        const [t1,t2]=[...set],x=T[t1],y=T[t2];if(!x||!y)continue;
        const i=x.findIndex((z,j)=>y.includes(z)&&y.includes(x[(j+1)%3]));if(i<0)continue;
        const a=x[i],b=x[(i+1)%3],c=x[(i+2)%3],d=y.find(z=>z!==a&&z!==b);
        if(d===undefined||c===d||edges.get(k(c,d))?.size)continue;
        // strictly convex, with a margin: a corner a rounding error off the new diagonal (the
        // midpoint of a straight ruling) would leave a triangle with no area
        const A=uv(a),B=uv(b),Cc=uv(c),Dd=uv(d),L2=(Cc.x-Dd.x)**2+(Cc.y-Dd.y)**2;
        if(orient(A,Dd,Cc)<=1e-9*L2||orient(Dd,B,Cc)<=1e-9*L2)continue;
        if(dev(c,d)>=dev(a,b)*0.999)continue;
        link(t1,false);link(t2,false);T[t1]=[a,d,c];T[t2]=[d,b,c];link(t1,true);link(t2,true);changed.add(t1).add(t2);
        for(const e of [k(a,d),k(d,b),k(b,c),k(c,a)])again.add(e);}
      keys=again;}
    return [...changed];
  }
  const keysOf=ts=>{const out=new Set();for(const t of ts){const x=T[t];if(x)for(let j=0;j<3;j++)out.add(k(x[j],x[(j+1)%3]));}return out;};
  flips(new Set(edges.keys()));
  let queue=T.map((_,t)=>t);
  while(queue.length&&T.length<limit){
    const nextQ=[];
    for(const t of queue){
      const x=T[t];if(!x)continue;
      // the interior edge furthest off the surface
      let worst=null,wd=tol;
      for(let j=0;j<3;j++){const a=x[j],b=x[(j+1)%3];if(boundary.has(k(a,b)))continue;
        const d=G.dist(ev((pts[a].u+pts[b].u)/2,(pts[a].v+pts[b].v)/2).p,mid3(a,b));if(d>wd){wd=d;worst=[a,b];}}
      if(worst&&onBoundary(worst[0],worst[1],(pts[worst[0]].u+pts[worst[1]].u)/2,(pts[worst[0]].v+pts[worst[1]].v)/2))worst=null;
      if(worst){
        const [a,b]=worst,m=point((pts[a].u+pts[b].u)/2,(pts[a].v+pts[b].v)/2);
        // keep the winding: the edge runs a->b or b->a inside each triangle
        const plan=[...edges.get(k(a,b))].map(s=>{const y=T[s],c=y.find(z=>z!==a&&z!==b),fwd=(y.indexOf(a)+1)%3===y.indexOf(b);
          return [s,fwd?[[a,m,c],[m,b,c]]:[[b,m,c],[m,a,c]]];});
        if(plan.every(([,ns])=>ns.every(ccw))){
          for(const [s,ns] of plan){link(s,false);T[s]=null;for(const n of ns){T.push(n);link(T.length-1,true);nextQ.push(T.length-1);}}
          continue;
        }
        pts.pop();
      }
      const uc=(pts[x[0]].u+pts[x[1]].u+pts[x[2]].u)/3,vc=(pts[x[0]].v+pts[x[1]].v+pts[x[2]].v)/3;
      const c3=G.mul(G.add(G.add(pts[x[0]].p,pts[x[1]].p),pts[x[2]].p),1/3);
      if(G.dist(ev(uc,vc).p,c3)>tol){
        const m=point(uc,vc),ns=[[x[0],x[1],m],[x[1],x[2],m],[x[2],x[0],m]];
        if(!ns.every(ccw)){pts.pop();continue;}
        link(t,false);T[t]=null;
        for(const n of ns){T.push(n);link(T.length-1,true);nextQ.push(T.length-1);}
      }
    }
    queue=[...new Set([...nextQ,...(nextQ.length?flips(keysOf(nextQ)):[])])];
  }
  return T.filter(Boolean);
}

/* A triangulation as the STL writers' model: one entry per face, with its own vertex list. */
function toMeshModel(t){
  const faces=t.faces.map((f,index)=>{const map=new Map(),V=[];
    const tris=f.triangles.map(tr=>tr.map(g=>{let i=map.get(g);if(i===undefined){i=V.length;V.push(t.vertices[g]);map.set(g,i);}return i;}));
    return {index,vertices:V,triangles:tris,cycles:[],tag:null,direction:null,parameters:null};});
  return {faces,faceCount:faces.length,triangleCount:faces.reduce((a,f)=>a+f.triangles.length,0)};
}

/* Checks on a triangulation: each undirected edge used exactly twice, in opposite directions,
 * and the enclosed volume (divergence theorem over the triangles). */
function check(t){
  const dir=new Map();let volume=0;
  for(const f of t.faces)for(const [a,b,c] of f.triangles){
    for(const [p,q] of [[a,b],[b,c],[c,a]]){const kk=p+','+q;dir.set(kk,(dir.get(kk)||0)+1);}
    volume+=G.dot(t.vertices[a],G.cross(t.vertices[b],t.vertices[c]))/6;
  }
  let open=0,bad=0;
  for(const [kk,n] of dir){const [p,q]=kk.split(','),r=dir.get(q+','+p)||0;if(n>1)bad++;if(r!==n)open++;}
  return {triangles:t.faces.reduce((a,f)=>a+f.triangles.length,0),vertices:t.vertices.length,openEdges:open,repeatedEdges:bad,volume};
}

module.exports={tessellate,toMeshModel,check};

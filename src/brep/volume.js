'use strict';
/* Exact enclosed volume of a neutral B-rep model, computed from the surfaces and edge curves
 * themselves, without tessellating.
 *
 *   volume(model, {segments, split, origin}) -> {volume (m³), faces, unsupported:[...]}
 *
 * The model can be a raw native build (src/brep/native.js, curves still data — the unsupported
 * list then names what resolution would have fixed), a resolved one (src/brep/procedural.js,
 * intersections and blends fitted — everything integrates) or a STEP read (src/step/read.js).
 *
 * Divergence theorem: V = (1/3) ∬ S·(S_u × S_v) du dv over every face, in the surface's own
 * parameters (u,v), where S_u × S_v is the natural normal. Green's theorem turns each face
 * integral into a line integral round the face's loops, evaluated along the exact edge curves
 * with composite Gauss–Legendre:
 *
 *   K-form  ∬ g du dv =  ∮ K dv,  K(u,v) = ∫ from u_ref to u of g(s,v) ds
 *   H-form  ∬ g du dv = −∮ H du,  H(u,v) = ∫ from v_ref to v of g(u,t) dt
 *
 * A face whose loops wrap round the periodic u direction (a hole's cylinder, a cone's base
 * circle, a hemisphere's equator) uses the H-form, which needs no seam because H is periodic in
 * u. v_ref goes at the apex of a cone and at the pole inside a hemisphere, so those degenerate
 * boundary pieces contribute nothing. A face that does not wrap in u uses the K-form, where
 * degenerate pieces at a pole (dv = 0) drop out on their own.
 *
 * The boundary integrand loses smoothness at the knots of B-spline curves, so an edge's Gauss
 * nodes are laid out span by span there and evenly everywhere else (EXP-078); the inner
 * integrals likewise get at least one rule per knot span of the surface.
 *
 * B-spline faces invert the parametrisation edge by edge, outward from each edge's midpoint
 * with warm starts and lightly damped Newton: a point where the surface degenerates (a blend
 * whose two contacts meet) has no unique (u,v), so continuity along the edge decides. du/dt and
 * dv/dt come from the (u,v) path itself where it degenerates and from the exact surface rates
 * elsewhere. Where consecutive edges meet at one 3D point but different (u,v), a straight
 * parameter-space segment closes the loop: it has no length in 3D, but Green's theorem in (u,v)
 * needs the loop closed, and without it three-sided blend faces integrate to 0.
 * Planes use offset × area, the area by the shoelace integral.
 *
 * Loops run counter-clockwise about the face's outward normal (STEP's convention, which
 * native.js reproduces), so face orientation is already in the loop direction.
 */
const G=require('../geom/eval');

const GL=[[-0.9739065285171717,0.0666713443086881],[-0.8650633666889845,0.1494513491505806],[-0.6794095682990244,0.2190863625159820],[-0.4333953941292472,0.2692667193099963],[-0.1488743389816312,0.2955242247147529],
          [0.1488743389816312,0.2955242247147529],[0.4333953941292472,0.2692667193099963],[0.6794095682990244,0.2190863625159820],[0.8650633666889845,0.1494513491505806],[0.9739065285171717,0.0666713443086881]];
const TAU=G.TAU;
function gauss(f,a,b,segments){const h=(b-a)/segments;let s=0;for(let k=0;k<segments;k++){const m=a+(k+0.5)*h;for(const [x,w] of GL)s+=w*f(m+x*h/2);}return s*h/2;}
/* The same, but split at the given breakpoints (B-spline knots, where the integrand loses
 * smoothness and plain Gauss–Legendre loses its accuracy). At least one rule per span: on a
 * knot span the integrand of a non-rational bicubic is a polynomial of degree <= 8, which
 * 10-point Gauss integrates exactly. */
function gaussSplit(f,a,b,segments,breaks){
  if(!breaks||a===b)return gauss(f,a,b,segments);
  const lo=Math.min(a,b),hi=Math.max(a,b),pts=[lo,...breaks.filter(k=>k>lo&&k<hi),hi];
  const per=Math.max(1,Math.ceil(segments/(pts.length-1)));
  let s=0;for(let i=0;i+1<pts.length;i++)s+=gauss(f,pts[i],pts[i+1],per);
  return a<b?s:-s;
}

/* Gauss nodes and weights [t, w] for a boundary walk: B-spline curves split at their knots
 * (a smooth integrand on each span), everything else `segments` equal pieces. */
function pathNodes(p,segments){
  const out=[],lo=Math.min(p.t0,p.t1),hi=Math.max(p.t0,p.t1);
  let cuts=[lo,hi];
  if(p.c.type==='bspline'){const ks=[...new Set(p.c.knots)].filter(k=>k>lo&&k<hi);if(ks.length)cuts=[lo,...ks,hi];}
  const per=cuts.length>2?Math.max(2,Math.ceil(segments/(cuts.length-1))):segments,sign=p.t1>=p.t0?1:-1;
  const spans=[];for(let i=0;i+1<cuts.length;i++)spans.push([cuts[i],cuts[i+1]]);if(sign<0)spans.reverse();
  for(const [a0,b0] of spans){const a=sign>0?a0:b0,b=sign>0?b0:a0,h=(b-a)/per;
    for(let k=0;k<per;k++){const m=a+(k+0.5)*h;for(const [x,w] of GL)out.push([m+x*h/2,w*h/2]);}}
  return out;
}

/* The parameter path an edge traverses from its start vertex to its end vertex. Resolved edges
 * (src/brep/procedural.js) carry t0/t1 of their own and are used as-is. A raw ring edge — no
 * vertices — runs once round: over 2π on a periodic curve, and over the curve's own range on a
 * closed B-spline, which is where the 2π shortcut read distributor as −6e15 mm³. */
function edgePath(e,V){
  const c=e.curve.type==='trimmed'?e.curve.basis:e.curve;
  if(e.t0!==undefined&&e.t1!==undefined)return {c,t0:e.t0,t1:e.t1};
  const periodic=c.type==='circle'||c.type==='ellipse';
  if(!e.v){const [a,b]=G.curveRange(c);
    if(periodic)return {c,t0:a,t1:a+(e.sameSense?TAU:-TAU)};   // once round
    return e.sameSense?{c,t0:a,t1:b}:{c,t0:b,t1:a};}
  const ps=V.get(e.v[0]).p,pe=V.get(e.v[1]).p;
  let ts=G.curveProject(c,ps).t,te=G.curveProject(c,pe).t;
  if(periodic){
    if(e.v[0]===e.v[1])te=ts+(e.sameSense?TAU:-TAU);
    else if(e.sameSense){while(te<=ts)te+=TAU;}else{while(te>=ts)te-=TAU;}
  }
  return {c,t0:ts,t1:te};
}

/* Surface parametrisations: eval(u,v) -> {S, Su, Sv}; param(P) -> [u, v] with u an angle where
 * the surface is periodic in u, param(P, guess) taking a [u,v] warm start where it helps. */
function frame(a,x){const z=G.unit(a),xx=G.unit(G.sub(x,G.mul(z,G.dot(x,z))));return {z,x:xx,y:G.cross(z,xx)};}
function parametrise(s){
  const ang=(F,q)=>Math.atan2(G.dot(q,F.y),G.dot(q,F.x));
  const rho=(F,u)=>G.add(G.mul(F.x,Math.cos(u)),G.mul(F.y,Math.sin(u))),drho=(F,u)=>G.add(G.mul(F.x,-Math.sin(u)),G.mul(F.y,Math.cos(u)));
  switch(s.type){
    case 'cylinder':{const F=frame(s.a,s.x);return {periodicU:true,vRef:0,
      eval:(u,v)=>({S:G.add(G.add(s.p,G.mul(F.z,v)),G.mul(rho(F,u),s.r)),Su:G.mul(drho(F,u),s.r),Sv:F.z}),
      param:P=>{const q=G.sub(P,s.p);return [ang(F,q),G.dot(q,F.z)];}};}
    case 'cone':{const F=frame(s.a,s.x),t=Math.tan(s.angle);return {periodicU:true,vRef:t?-s.r/t:0,     // v_ref at the apex
      eval:(u,v)=>{const R=s.r+v*t;return {S:G.add(G.add(s.p,G.mul(F.z,v)),G.mul(rho(F,u),R)),Su:G.mul(drho(F,u),R),Sv:G.add(F.z,G.mul(rho(F,u),t))};},
      param:P=>{const q=G.sub(P,s.p);return [ang(F,q),G.dot(q,F.z)];}};}
    case 'sphere':{const F=frame(s.a,s.x);return {periodicU:true,vRef:-Math.PI/2,
      eval:(u,v)=>{const cr=Math.cos(v),sr=Math.sin(v),R=rho(F,u);
        return {S:G.add(s.c,G.mul(G.add(G.mul(R,cr),G.mul(F.z,sr)),s.r)),Su:G.mul(drho(F,u),s.r*cr),Sv:G.mul(G.add(G.mul(R,-sr),G.mul(F.z,cr)),s.r)};},
      param:P=>{const q=G.sub(P,s.c),h=G.dot(q,F.z),rr=Math.hypot(G.dot(q,F.x),G.dot(q,F.y));return [ang(F,q),Math.atan2(h,rr)];}};}
    case 'torus':{const F=frame(s.a,s.x);return {periodicU:true,vRef:0,
      eval:(u,v)=>{const R=rho(F,u),cv=Math.cos(v),sv=Math.sin(v);
        return {S:G.add(s.c,G.add(G.mul(R,s.R+s.r*cv),G.mul(F.z,s.r*sv))),Su:G.mul(drho(F,u),s.R+s.r*cv),Sv:G.add(G.mul(R,-s.r*sv),G.mul(F.z,s.r*cv))};},
      param:P=>{const q=G.sub(P,s.c),h=G.dot(q,F.z),rr=Math.hypot(G.dot(q,F.x),G.dot(q,F.y));return [ang(F,q),Math.atan2(h,rr-s.R)];}};}
    /* SWEPT_SURF: the section curve translated along d. `scale` scales the sweep parameter
     * only, so it doesn't change the surface geometry (EXP-078, Dekor's 311 faces). */
    case 'swept':{const c=s.curve.type==='trimmed'?s.curve.basis:s.curve;return {periodicU:false,vRef:0,uBreaks:c.type==='bspline'?[...new Set(c.knots)]:undefined,
      eval:(u,v)=>{const q=G.curvePoint(c,u);return {S:G.add(q,G.mul(s.d,v)),Su:G.curveTangent(c,u),Sv:s.d};},
      param:(P,guess)=>{const r=G.surfaceInverse(s,P,guess===undefined?null:{u:guess[0],v:guess[1]});return [r.u,r.v];}};}
    case 'bspline':{let last=null;return {periodicU:false,vRef:s.kv[s.dv],uBreaks:[...new Set(s.ku)],vBreaks:[...new Set(s.kv)],
      eval:(u,v)=>{const e=G.bsplineSurface(s,u,v);return {S:e.p,Su:e.du,Sv:e.dv};},
      param:(P,guess)=>{const g=guess===undefined?last:guess?{u:guess[0],v:guess[1]}:null;const r=G.bsplineProject(s,P,g);last=r;return [r.u,r.v];}};}
  }
  return null;
}

/* B-spline face boundaries: the (u,v) path is built edge by edge, outward from each edge's
 * midpoint, each point inverted with the previous one as warm start. du/dt and dv/dt come from
 * the exact surface rates where Newton's determinant shows the surface regular, and from finite
 * differences of the (u,v) path where it degenerates (a blend's tip, where the two contacts
 * meet). Straight parameter-space segments close the loop between edges that share a 3D point
 * but not a (u,v) point. */
function boundarySamplesBspline(face,M,par,segments){
  const loops=[],GAP=4;
  for(const loop of face.loops){
    const pts=[],ends=[];
    for(const co of loop.coedges){
      let p=edgePath(M.edges.get(co.edge),M.vertices);if(!co.sense)p={c:p.c,t0:p.t1,t1:p.t0};
      const nodes=pathNodes(p,segments),n=nodes.length,chain=new Array(n+2),m=n>>1;
      // The (u,v) chain runs through the interior nodes and one step past each end, so the loop
      // closes on the edges' true endpoints without a second inversion: outward from the middle,
      // each point inverted with its neighbour as warm start. A degenerate point (a blend's tip,
      // where the two contacts meet) keeps to its own branch this way.
      chain[m+1]=par.param(G.curvePoint(p.c,nodes[m][0]),null);
      for(let i=m;i>=1;i--)chain[i]=par.param(G.curvePoint(p.c,nodes[i-1][0]),chain[i+1]);
      chain[0]=par.param(G.curvePoint(p.c,p.t0),chain[1]);
      for(let i=m+2;i<=n;i++)chain[i]=par.param(G.curvePoint(p.c,nodes[i-1][0]),chain[i-1]);
      chain[n+1]=par.param(G.curvePoint(p.c,p.t1),chain[n]);
      const h=1e-6*Math.abs(p.t1-p.t0);
      nodes.forEach(([t,w],i)=>{const j=i+1;
        // (du, dv)/dt from S_u du + S_v dv = P'(t), exact where surface regular; finite differences
        // of the (u,v) chain only where it degenerates (a blend's tip)
        const [u,v]=chain[j],e=par.eval(u,v),D=G.curveTangent(p.c,t);let A=G.dot(e.Su,e.Su),B=G.dot(e.Su,e.Sv),C=G.dot(e.Sv,e.Sv);
        // a toleranced edge is off the surface by r: the foot then moves at a rate that also
        // depends on the curvature (the r·S_uu terms). Left out, the loft control's side faces
        // came out 1e-4 mm³ short at a 0.83 µm gap (EXP-085).
        const r=G.sub(G.curvePoint(p.c,t),e.S);
        if(G.dot(r,r)>1e-24){const k=1e-6,a=par.eval(u+k,v),b=par.eval(u-k,v),c=par.eval(u,v+k),d=par.eval(u,v-k);
          A-=G.dot(r,G.sub(a.Su,b.Su))/(2*k);C-=G.dot(r,G.sub(c.Sv,d.Sv))/(2*k);B-=G.dot(r,G.sub(c.Su,d.Su))/(2*k);}
        const det=A*C-B*B;
        if(det>1e-6*Math.abs(A*C)){const x1=G.dot(D,e.Su),y1=G.dot(D,e.Sv);pts.push({u,v,du:(C*x1-B*y1)/det,dv:(A*y1-B*x1)/det,w});return;}
        const a=par.param(G.curvePoint(p.c,t+h),chain[j]),b=par.param(G.curvePoint(p.c,t-h),chain[j]);
        pts.push({u:chain[j][0],v:chain[j][1],du:(a[0]-b[0])/(2*h),dv:(a[1]-b[1])/(2*h),w});});
      ends.push({start:chain[0],end:chain[n+1],at:pts.length});
    }
    // close parameter-space gaps between consecutive edges, inserting after each edge
    const out=[];let k=0;
    for(let i=0;i<ends.length;i++){
      while(k<ends[i].at)out.push(pts[k++]);
      const A=ends[i].end,B=ends[(i+1)%ends.length].start,du=B[0]-A[0],dv=B[1]-A[1];
      if(Math.hypot(du,dv)>1e-9)for(let g=0;g<GAP;g++){const m=(g+0.5)/GAP;for(const [x,w] of GL){const s=m+x/(2*GAP);
        out.push({u:A[0]+du*s,v:A[1]+dv*s,du,dv,w:w/(2*GAP)});}}
    }
    loops.push(out);
  }
  return loops;
}

/* Per-point boundary samples for a face: parameters, their rates along the curve, Gauss weight. */
function boundarySamples(face,M,par,segments){
  const loops=[];
  for(const loop of face.loops){
    const pts=[];
    for(const co of loop.coedges){
      let p=edgePath(M.edges.get(co.edge),M.vertices);if(!co.sense)p={c:p.c,t0:p.t1,t1:p.t0};
      for(const [t,w] of pathNodes(p,segments)){
        const P=G.curvePoint(p.c,t),D=G.curveTangent(p.c,t),[u,v]=par.param(P),e=par.eval(u,v);
        // (du, dv)/dt from S_u du + S_v dv = P'(t), least squares
        const a=G.dot(e.Su,e.Su),b=G.dot(e.Su,e.Sv),c=G.dot(e.Sv,e.Sv),x1=G.dot(D,e.Su),y1=G.dot(D,e.Sv),det=a*c-b*b;
        pts.push({u,v,du:(c*x1-b*y1)/det,dv:(a*y1-b*x1)/det,w});}
    }
    loops.push(pts);
  }
  return loops;
}
const wrapTo=(x,ref)=>x-TAU*Math.round((x-ref)/TAU);
/* Branch for an angle that does not wrap round the face. The cut has to fall outside the face,
 * so it goes in one of the widest gaps between boundary samples. When two gaps tie (a half sphere
 * or half torus, bounded by two opposite circles) the boundary alone cannot tell the sides apart;
 * the loop direction can: the face's (u,v) area, ∮ u dv or −∮ v du, comes out with the sign of its
 * orientation only when the cut is outside it. Returns the centre of the chosen branch. */
function chooseBranch(angles,signedArea,orientation){
  const a=angles.map(x=>((x%TAU)+TAU)%TAU).sort((p,q)=>p-q),gaps=[];
  for(let i=0;i<a.length;i++){const next=i+1<a.length?a[i+1]:a[0]+TAU;gaps.push({size:next-a[i],mid:a[i]+(next-a[i])/2});}
  const widest=gaps.reduce((m,g)=>Math.max(m,g.size),0),cands=gaps.filter(g=>g.size>=widest*0.999).map(g=>g.mid+Math.PI);
  for(const c of cands)if(signedArea(c)*orientation>0)return c;
  return cands[0];
}
function faceIntegral(face,M,segments,O){
  const s=face.surface;
  if(s.type==='plane'){
    const F=frame(s.n,s.x),off=G.dot(G.sub(s.p,O),F.z);let a=0;
    for(const loop of face.loops)for(const co of loop.coedges){
      let p=edgePath(M.edges.get(co.edge),M.vertices);if(!co.sense)p={c:p.c,t0:p.t1,t1:p.t0};
      for(const [t,w] of pathNodes(p,segments))a+=w*G.dot(G.sub(G.curvePoint(p.c,t),O),F.x)*G.dot(G.curveTangent(p.c,t),F.y);
    }
    return off*a/3;
  }
  const par=parametrise(s);if(!par)return null;
  const g=(u,v)=>{const e=par.eval(u,v);return G.dot(G.sub(e.S,O),G.cross(e.Su,e.Sv));};
  const loops=face.surface.type==='bspline'?boundarySamplesBspline(face,M,par,segments):boundarySamples(face,M,par,segments);
  const wraps=par.periodicU&&loops.some(L=>Math.abs(L.reduce((sum,q)=>sum+q.du*q.w,0))>1);
  let total=0;
  if(wraps){            // H-form, H periodic in u
    let vref=par.vRef;
    if(s.type==='sphere'){   // a wrapping sphere face contains at most one pole: integrate from that one
      const all=loops.flat(),o=face.sameSense?1:-1,area=r=>-all.reduce((x,q)=>x+(q.v-r)*q.du*q.w,0);
      vref=area(-Math.PI/2)*o>0?-Math.PI/2:Math.PI/2;}
    if(s.type==='torus'){const all=loops.flat();vref=chooseBranch(all.map(q=>q.v),c=>-all.reduce((x,q)=>x+wrapTo(q.v,c)*q.du*q.w,0),face.sameSense?1:-1);for(const q of all)q.v=wrapTo(q.v,vref);}
    for(const L of loops)for(const q of L){
      const H=gaussSplit(t=>g(q.u,t),vref,q.v,8,par.vBreaks);total+=-H*q.du*q.w;}
  }else{                // K-form, one consistent branch of u across the face
    const all=loops.flat(),o=face.sameSense?1:-1;let uref=all[0].u;
    if(par.periodicU){
      const c=chooseBranch(all.map(q=>q.u),c=>all.reduce((x,q)=>x+wrapTo(q.u,c)*q.dv*q.w,0),o);
      for(const q of all)q.u=wrapTo(q.u,c);uref=c;}
    if(s.type==='torus'&&!loops.some(L=>Math.abs(L.reduce((x,q)=>x+q.dv*q.w,0))>1)){
      const c=chooseBranch(all.map(q=>q.v),c=>-all.reduce((x,q)=>x+wrapTo(q.v,c)*q.du*q.w,0),o);
      for(const q of all)q.v=wrapTo(q.v,c);}
    for(const q of all){const K=gaussSplit(x=>g(x,q.v),uref,q.u,8,par.uBreaks);total+=K*q.dv*q.w;}
  }
  return total/3;
}

/* Why an edge's curve can't be integrated along, or null if it can. On a resolved model every
 * edge curve is exact or fitted, so this only ever fires on a raw native model. */
const EXACT_CURVES=new Set(['line','circle','ellipse','bspline']);
function curveIssue(e){
  if(e.tolerant||!e.curve)return 'tolerant edge';
  const c=e.curve.type==='trimmed'?e.curve.basis:e.curve;
  return EXACT_CURVES.has(c.type)?null:c.type==='spcurve'?'SP-curve edge':c.type+' curve';
}

/* A toleranced edge doesn't lie exactly on its faces. The loft control C16's top edges are
 * exact circles, but the side patches end on cubics up to 0.83 µm inside them (Parasolid gives
 * those edges a 2.07 µm tolerance; SolidWorks' STEP has the same gap). Each face's boundary
 * integral runs along its own foot curve, the plane's along the circle itself, so the faces
 * left a strip 0.83 µm wide uncovered, and the volume depended on where the origin was (0.0028
 * mm³ per mm along the loft's axis, 2e-5 of the part). This adds the flux through the ribbon
 * from each face's foot curve F to the edge curve C, which closes the shell:
 *   ΔV = −(1/3) ∫ R·(C' × (C − F)) dt,  R = (C + F)/2, t along the coedge.
 * R is linear across the ribbon and C' stands in for F', so the error is second order in the
 * gap (about 1e-17 m³ here). Edges without a tolerance are on their faces to rounding and get
 * nothing. */
function ribbon(face,M,segments,O){
  // the same foot the face's own boundary integral uses
  const s=face.surface,par=s.type==='plane'?null:parametrise(s);
  const foot=par?C=>{const [u,v]=par.param(C);return par.eval(u,v).S;}:C=>G.sub(C,G.mul(s.n,G.dot(G.sub(C,s.p),s.n)));
  let dv=0;
  for(const loop of face.loops)for(const co of loop.coedges){
    const e=M.edges.get(co.edge);if(!e.tolerance)continue;
    let p=edgePath(e,M.vertices);if(!co.sense)p={c:p.c,t0:p.t1,t1:p.t0};
    for(const [t,w] of pathNodes(p,segments)){
      const C=G.curvePoint(p.c,t),D=G.curveTangent(p.c,t),F=foot(C);
      dv-=w*G.dot(G.sub(G.mul(G.add(C,F),0.5),O),G.cross(D,G.sub(C,F)))/3;
    }
  }
  return dv;
}

/* Periodic faces are integrated after the seam split (src/brep/split.js), as the STEP writer
 * and the triangulator see them. Unsplit, the H-form goes wrong on faces whose loops don't
 * simply wrap round u: a sphere with vertex-less hole circles, a cylinder face with a slit edge
 * used both ways. On four online parts it gave 0, negative, or 20% to 170% off what OpenCascade
 * measures on our STEP; split, all four agree (EXP-085). Only a resolved model can be split; a
 * STEP read is already cut at its seams, and a raw native build with inexact curves goes
 * unsupported anyway. If the split itself fails, the volume is refused rather than measured
 * unsplit. opts.split=false skips it. opts.origin moves the point the divergence integral is taken about: on a closed
 * shell the volume doesn't depend on it, so a change shows faces that don't meet. */
function volume(model,opts={}){
  const segments=opts.segments||64,O=opts.origin||[0,0,0];
  let v=0;const unsupported=new Set();
  // the split needs a resolved model (every edge with its t0 -> t1)
  const resolved=[...model.edges.values()].every(e=>e.t0!==undefined)&&model.faces.every(f=>f.loops.every(l=>l.coedges.every(co=>!curveIssue(model.edges.get(co.edge)))));
  let M=model;
  if(resolved&&opts.split!==false){
    try{M=require('./split').split(model);}
    catch(e){return {volume:undefined,faces:model.faces.length,unsupported:['seam split: '+e.message]};}
  }else if(model.faces.some(f=>!f.loops.length))M=require('./seams').addSeams(model);
  for(const f of M.faces){
    const issues=f.loops.flatMap(l=>l.coedges.map(co=>curveIssue(M.edges.get(co.edge)))).filter(Boolean);
    if(issues.length){for(const i of issues)unsupported.add(i);continue;}
    const x=faceIntegral(f,M,segments,O);if(x===null)unsupported.add(f.surface.type);else v+=x+ribbon(f,M,segments,O);
  }
  return {volume:unsupported.size?undefined:v,faces:M.faces.length,unsupported:[...unsupported]};
}

module.exports={volume,edgePath,parametrise};

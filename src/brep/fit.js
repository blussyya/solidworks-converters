/* B-spline fits for the procedural geometry STEP cannot hold (used by src/brep/procedural.js).
 *
 * Everything here is fitted to exact points. "Exact" means: computed from the defining data in
 * the Parasolid body to floating-point precision (Newton on the defining surfaces, the SP_CURVE's
 * own 2D B-spline, the blend's spine and supports), never taken from the display mesh.
 *
 *   interp(points, params, degree)  global B-spline interpolation (The NURBS Book A9.1),
 *                                   averaged knots, banded solve
 *   fitPoints(fn, ss, tol)          adaptive: interpolate fn at the parameters ss, measure the
 *                                   distance from fn at the mid-parameters to the fitted curve,
 *                                   add those points where it exceeds tol, repeat
 *   edgeCurve(edge, curve, p0, p1)  INTERSECTION and SP_CURVE edges -> cubic B-spline from p0
 *                                   to p1 (the edge's vertices, which it passes through exactly)
 *   blendSurface(blend, face, N)    rolling-ball blend -> rational B-spline surface. Along the
 *                                   spine it is cubic; across, each section is the exact circular
 *                                   arc as a rational quadratic, and the homogeneous control
 *                                   points are interpolated along the spine.
 * Every fit reports `error`: the largest distance found from exact points to the fit (metres).
 *
 * Isomorphic: loads in Node and as a plain browser script (global SLDPRTFit).
 */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('../geom/eval'));
  else root.SLDPRTFit=factory(root.SLDPRTGeom);
})(typeof self!=='undefined'?self:this,function(G){
'use strict';
const {add,sub,mul,dot,cross,norm,unit,dist}=G;
const TAU=2*Math.PI;

/* ---------------- interpolation ---------------- */
/* Curve of `degree` through points[k] (any dimension) at params[k] (increasing, 0 .. 1). */
function interp(points,params,degree){
  const n=points.length-1,p=Math.min(degree||3,n),dim=points[0].length;
  const knots=[];for(let i=0;i<=p;i++)knots.push(params[0]);
  for(let j=1;j<=n-p;j++){let s=0;for(let i=j;i<j+p;i++)s+=params[i];knots.push(s/p);}
  for(let i=0;i<=p;i++)knots.push(params[n]);
  const W=2*p+1,rows=[],rhs=points.map(q=>q.slice());
  for(let k=0;k<=n;k++){
    const row=new Float64Array(W),sp=G.span(knots,p,n+1,params[k]),B=G.basisFuns(knots,p,sp,params[k]);
    for(let j=0;j<=p;j++){const col=sp-p+j,idx=col-k+p;if(idx<0||idx>=W){if(B[j]!==0)throw Error('interp: band');continue;}row[idx]=B[j];}
    rows.push(row);
  }
  for(let k=0;k<=n;k++){const piv=rows[k][p];if(!piv)throw Error('interp: singular');
    for(let i=k+1;i<=Math.min(n,k+p);i++){const a=rows[i][k-i+p];if(!a)continue;const f=a/piv;
      for(let j=k;j<=Math.min(n,k+p);j++)rows[i][j-i+p]-=f*rows[k][j-k+p];
      for(let d=0;d<dim;d++)rhs[i][d]-=f*rhs[k][d];}}
  const x=new Array(n+1);
  for(let k=n;k>=0;k--){const v=rhs[k].slice();for(let j=k+1;j<=Math.min(n,k+p);j++)for(let d=0;d<dim;d++)v[d]-=rows[k][j-k+p]*x[j][d];
    x[k]=v.map(c=>c/rows[k][p]);}
  return {degree:p,ctrl:x,knots};
}
function chordParams(pts){
  const L=[0];for(let i=1;i<pts.length;i++)L.push(L[i-1]+dist(pts[i],pts[i-1]));
  const T=L[L.length-1]||1;return L.map(x=>x/T);
}
/* Parameter of the point of B-spline c nearest q, starting at t. */
function nearestParam(c,q,t){
  const [a,b]=G.curveRange(c);
  for(let it=0;it<40;it++){const e=G.bsplineCurve(c,t),d=e.d,dd=dot(d,d);if(!dd)break;
    const step=dot(sub(q,e.p),d)/dd;const nt=Math.min(b,Math.max(a,t+step));if(Math.abs(nt-t)<1e-16)break;t=nt;}
  return t;
}
/* Adaptive fit of the exact point function fn over parameters starting at ss (sorted). */
function fitPoints(fn,ss,tol,opts){
  opts=opts||{};
  let s=ss.slice(),pts=s.map((x,i)=>opts.fixed&&opts.fixed[i]?opts.fixed[i]:fn(x));
  if(opts.ends){pts[0]=opts.ends[0];pts[pts.length-1]=opts.ends[1];}
  let curve,error=Infinity;
  for(let round=0;round<16;round++){
    const t=chordParams(pts);
    curve={type:'bspline',...interp(pts,t,3),weights:null,closed:false};
    const bad=[];error=0;
    for(let i=0;i<s.length-1;i++){
      let e=0;
      for(const f of [0.5,0.25,0.75]){const q=fn(s[i]+(s[i+1]-s[i])*f),u=nearestParam(curve,q,t[i]+(t[i+1]-t[i])*f);e=Math.max(e,dist(q,G.bsplineCurve(curve,u).p));}
      error=Math.max(error,e);if(e>tol)bad.push(i);
    }
    if(!bad.length||s.length>20000)break;
    const ns=[],np=[];
    for(let i=0;i<s.length;i++){ns.push(s[i]);np.push(pts[i]);if(bad.includes(i)){const m=(s[i]+s[i+1])/2;ns.push(m);np.push(fn(m));}}
    s=ns;pts=np;
  }
  return {curve,error,samples:s.length};
}

/* ---------------- exact points ---------------- */
/* Foot of p on surface s, seeded by the previous foot on the same surface (cache). */
function footOn(s,p,cache){
  const near=cache&&cache.get(s);
  // A constant-radius rolling-ball blend is a pipe round its spine, so its foot is exact: the
  // nearest spine point c, then r along p - c. Parasolid uses one as the offset of a blend
  // (a fillet run along an earlier fillet: the second's spine meets the first offset by the
  // second's radius), and 5 parts in the online sample need it (EXP-085).
  if(s.type==='blend'&&Math.abs(Math.abs(s.range[0])-Math.abs(s.range[1]))<1e-12){
    const sp=spineOf(s,1e-10).curve,t=near?spineParam(sp,p,near.t):G.curveProject(sp,p).t;
    const c=G.curvePoint(sp,t),v=sub(p,c),rho=norm(v),r=Math.abs(s.range[0]);
    if(cache)cache.set(s,{t});
    if(!rho)throw Error('blend: point on the spine');
    const n=mul(v,1/rho);
    return {q:add(c,mul(n,r)),n,d:rho-r};
  }
  const r=G.surfaceInverse(s,p,near),e=G.surfaceEval(s,r.u,r.v);
  if(cache)cache.set(s,{u:r.u,v:r.v});
  const n=unit(cross(e.du,e.dv));
  return {q:e.p,n,d:dot(sub(p,e.p),n)};
}
/* Point on S1 ∩ S2 in the plane through g normal to T (Newton on the three equations). */
function corrector(S1,S2,g,T,cache){
  let X=g,lm=false;
  for(let it=0;it<(lm?400:40);it++){
    const a=footOn(S1,X,cache),b=footOn(S2,X,cache);
    const F=[a.d,b.d,dot(sub(X,g),T)];
    const M=[a.n,b.n,T],det=dot(M[0],cross(M[1],M[2]));
    // Where the surfaces touch (a blend that runs out tangentially) the normals are parallel and
    // Newton divides by ~0. The point is still where both distances vanish: find it by damped
    // least squares in the plane normal to T, and check that it got there.
    if(lm||Math.abs(det)<1e-8){lm=true;
      const e1=unit(cross(T,Math.abs(T[0])<0.9?[1,0,0]:[0,1,0])),e2=cross(T,e1);
      const j=[[dot(a.n,e1),dot(a.n,e2)],[dot(b.n,e1),dot(b.n,e2)]],mu=1e-12;
      const A11=j[0][0]*j[0][0]+j[1][0]*j[1][0]+mu,A12=j[0][0]*j[0][1]+j[1][0]*j[1][1],A22=j[0][1]*j[0][1]+j[1][1]*j[1][1]+mu;
      const g1=j[0][0]*F[0]+j[1][0]*F[1],g2=j[0][1]*F[0]+j[1][1]*F[1],dd=A11*A22-A12*A12;
      const x1=(A22*g1-A12*g2)/dd,x2=(A11*g2-A12*g1)/dd;
      const D=add(add(mul(e1,-x1),mul(e2,-x2)),mul(T,-F[2]));X=add(X,D);
      if(norm(D)<1e-16+1e-15*norm(X))break;
      continue;
    }
    // Δ = -M^{-1} F, rows of M are the gradients
    const c0=cross(M[1],M[2]),c1=cross(M[2],M[0]),c2=cross(M[0],M[1]);
    const D=mul(add(add(mul(c0,F[0]),mul(c1,F[1])),mul(c2,F[2])),-1/det);
    X=add(X,D);
    if(norm(D)<1e-16+1e-15*norm(X))break;
  }
  if(lm){const a=footOn(S1,X,cache),b=footOn(S2,X,cache);
    if(Math.max(Math.abs(a.d),Math.abs(b.d))>1e-8)throw Error('intersection: surfaces tangent, no common point ('+Math.max(Math.abs(a.d),Math.abs(b.d)).toExponential(1)+' m)');}
  return X;
}
/* The surfaces touch at X: their normals are parallel and the curve's direction is undefined. */
function singular(S1,S2,X,cache){const a=footOn(S1,X,cache),b=footOn(S2,X,cache);return Math.max(Math.abs(a.d),Math.abs(b.d))<1e-9&&norm(cross(a.n,b.n))<1e-6;}
function tangentAt(S1,S2,X,cache){const a=footOn(S1,X,cache),b=footOn(S2,X,cache);return unit(cross(a.n,b.n));}
/* March along S1 ∩ S2 from A towards B (or once round, when ring). dir0 orients the start. */
function march(S1,S2,A,B,dir0,scale,ring){
  const cache=new Map();
  let X,T;
  // a curve can start where the surfaces touch (a 'T' limit); the vertex is the point there
  if(singular(S1,S2,A,cache)){X=A;T=unit(dir0);}
  else{X=corrector(S1,S2,A,unit(dir0),cache);T=tangentAt(S1,S2,X,cache);if(dot(T,dir0)<0)T=mul(T,-1);}
  const pts=[X];let h=scale/16,travelled=0;
  // how far B itself is from the curve: a spine's limit point can sit a little off it
  // (a blend's spine runs on past where the offsets meet): then the march ends on the curve point
  // nearest B, not on B, or the fit is pulled off the curve (0.6 mm on 2f121983's spines). A vertex
  // is on its curve to within the model's tolerance and stays as it is.
  // (its own cache: the march's warm starts must stay near the march, not jump to B)
  let offB=0,Bc=B;if(!ring){try{Bc=corrector(S1,S2,B,T,new Map());offB=dist(B,Bc);}catch(e){offB=0;}if(offB<=1e-7)Bc=B;}
  for(let k=0;k<100000;k++){
    // B must be near as well as ahead: on 14f9214b the end is 17 mm away across a loop but only
    // 2 mm ahead along the starting tangent, and a half-space test alone stopped at once
    if(!ring&&dot(sub(B,X),T)<=h*1.2&&dist(B,X)<=h*1.5+offB){pts.push(Bc);return pts;}
    if(ring&&travelled>3*h&&dist(X,A)<=h*1.2){pts.push(pts[0]);return pts;}
    let Y,T2;
    for(;;){Y=corrector(S1,S2,add(X,mul(T,h)),T,cache);T2=tangentAt(S1,S2,Y,cache);if(dot(T2,T)<0)T2=mul(T2,-1);
      if(dot(T2,T)>Math.cos(4*Math.PI/180)||h<scale*1e-6)break;h/=2;}
    travelled+=dist(X,Y);X=Y;T=T2;pts.push(X);
    if(dot(T2,T)>Math.cos(1*Math.PI/180))h=Math.min(h*1.5,scale/16);
  }
  throw Error('intersection: march did not reach the end');
}
/* Exact points from A to B along the chart Parasolid stores between them. The chart lies on the
 * branch the curve takes, so following it can't go the other way round a closed intersection or
 * leave a touching point along the wrong branch, which one long march can (14f9214b, 2f121983).
 * Each chord between chart points is sampled and each sample corrected onto the curve in the plane
 * normal to the chord; the corrected points must come out in order along the chord and evenly
 * spaced, or the chord is too coarse there and this throws rather than fit through a wrong point. */
function chartMarch(S1,S2,A,B,chart){
  try{return chartPoly(S1,S2,A,B,chart);}catch(e){if(/chart too coarse/.test(e.message))return null;throw e;}
}
function chartPoly(S1,S2,A,B,chart){
  const near=q=>{let best=0,bd=Infinity;chart.forEach((x,i)=>{const d=dist(x,q);if(d<bd){bd=d;best=i;}});return best;};
  const ia=near(A),ib=near(B);if(ia===ib)return null;
  const step=ib>ia?1:-1,way=[A];
  // the chart point nearest A is a waypoint when it lies past A towards the rest of the chart
  // (a blend's spine starts at a touching point with the first chart point just inside it)
  const inside=(k,from,dir)=>dist(chart[k],from)>1e-9&&dot(sub(chart[k],from),sub(chart[k+dir],chart[k]))>0;
  if(inside(ia,A,step))way.push(chart[ia]);
  for(let k=ia+step;k!==ib;k+=step)way.push(chart[k]);
  if(dist(chart[ib],B)>1e-9&&dot(sub(B,chart[ib]),sub(chart[ib],chart[ib-step]))>0)way.push(chart[ib]);
  way.push(B);
  const cache=new Map(),poly=[A],n=16;
  for(let i=0;i+1<way.length;i++){const P=way[i],Q=way[i+1],L=dist(P,Q);if(L<1e-12)continue;
    const T=unit(sub(Q,P));let prev=P,prevS=0;
    for(let k=1;k<=n;k++){const X=k===n?Q:corrector(S1,S2,add(P,mul(sub(Q,P),k/n)),T,cache),sX=dot(sub(X,P),T);
      if(!(sX>prevS)||dist(X,prev)>3*L/n)throw Error('intersection: chart too coarse to follow ('+(dist(X,prev)*1e3).toFixed(3)+' mm step)');
      poly.push(X);prev=X;prevS=sX;}}
  return poly;
}
/* Exact point at fraction s of a polyline of exact points: Newton in the plane normal to the chord. */
function polyFn(S1,S2,poly){
  const L=[0];for(let i=1;i<poly.length;i++)L.push(L[i-1]+dist(poly[i],poly[i-1]));const tot=L[L.length-1];
  const cache=new Map();
  return {ss:L.map(x=>x/tot),fn:s=>{
    const x=s*tot;let i=1;while(i<L.length-1&&L[i]<x)i++;
    const a=poly[i-1],b=poly[i],f=(x-L[i-1])/((L[i]-L[i-1])||1);
    if(f<=0)return a;if(f>=1)return b;
    return corrector(S1,S2,add(a,mul(sub(b,a),f)),unit(sub(b,a)),cache);}};
}

/* ---------------- edges ---------------- */
function edgeCurve(e,c,p0,p1,opts){
  const tol=(opts&&opts.tolerance)||1e-8;
  if(c.type==='spcurve')return spcurveEdge(e,c,p0,p1,tol);
  if(c.type==='intersection'){
    const [S1,S2]=c.surfaces;
    if(S1.type==='blendBound'||S2.type==='blendBound')return contactEdge(e,c,p0,p1,tol);
    return intersectionEdge(e,c,p0,p1,tol);
  }
  throw Error('fit: edge curve '+c.type);
}
function intersectionEdge(e,c,p0,p1,tol){
  const [S1,S2]=c.surfaces,chart=c.chart;
  // chart direction runs along the curve; the edge runs along it when sameSense
  const ring=!p0;
  let A=p0,B=p1,dir;
  const near=q=>{let best=0,bd=Infinity;chart.forEach((x,i)=>{const d=dist(x,q);if(d<bd){bd=d;best=i;}});return best;};
  if(ring){A=chart[0];B=A;}
  const ia=near(A),cd=ia<chart.length-1?sub(chart[ia+1],chart[ia]):sub(chart[ia],chart[ia-1]);
  dir=e.sameSense?cd:mul(cd,-1);
  let scale=0;for(let i=1;i<chart.length;i++)scale+=dist(chart[i],chart[i-1]);
  if(!ring)scale=Math.max(Math.min(scale,4*dist(A,B)),dist(A,B));
  let poly;
  const sa=!ring&&singular(S1,S2,A,new Map()),sb=!ring&&singular(S1,S2,B,new Map());
  if(!ring&&(poly=chartMarch(S1,S2,A,B,chart))){/* along the chart */}
  else if(sa&&!sb){
    // march away from the touching point, where the direction is well defined, and turn round
    const ib=near(B),cb=ib>0?sub(chart[ib],chart[ib-1]):sub(chart[ib+1],chart[ib]);
    poly=march(S1,S2,B,A,e.sameSense?mul(cb,-1):cb,scale||1e-3,false).reverse();
  }else poly=march(S1,S2,A,B,dir,scale||1e-3,ring);
  if(ring){/* the start is a point of the curve: make it the edge's vertex */}
  const {ss,fn}=polyFn(S1,S2,poly);
  const r=fitPoints(fn,ss,tol,{fixed:poly});
  const [a,b]=G.curveRange(r.curve);
  return {curve:r.curve,t0:a,t1:b,error:r.error,ringStart:ring?poly[0]:null};
}
/* Contact curve of a blend with one support: Parasolid gives it as the intersection of the
 * support with a BLEND_BOUND surface; its points are the feet of the spine on the support. */
function contactEdge(e,c,p0,p1,tol){
  const [S1,S2]=c.surfaces,bb=S1.type==='blendBound'?S1:S2,S=bb===S1?S2:S1,b=bb.blend;
  let i=b.surfaces.indexOf(S);if(i<0)i=bb.boundary-1;
  if(i<0||i>1)throw Error('blend boundary: support not found');
  const sp=spineOf(b,tol).curve,cache=new Map(),fn=t=>contact(b,i,G.curvePoint(sp,t),cache);
  const [lo,hi]=G.curveRange(sp);
  const paramOf=p=>{const K=400;let best=lo,bd=Infinity;for(let k=0;k<=K;k++){const t=lo+(hi-lo)*k/K,d=dist(fn(t),p);if(d<bd){bd=d;best=t;}}
    let a=Math.max(lo,best-(hi-lo)/K),z=Math.min(hi,best+(hi-lo)/K);
    for(let k=0;k<100;k++){const m1=a+(z-a)*0.382,m2=a+(z-a)*0.618;if(dist(fn(m1),p)<dist(fn(m2),p))z=m2;else a=m1;}
    return (a+z)/2;};
  if(!p0)throw Error('blend boundary: closed contact curve');
  const ta=paramOf(p0),tb=paramOf(p1),a=Math.min(ta,tb),z=Math.max(ta,tb),ss=[];
  for(let k=0;k<=16;k++)ss.push(a+(z-a)*k/16);
  const r=fitPoints(fn,ss,tol,{ends:ta<tb?[p0,p1]:[p1,p0]});
  const [x,y]=G.curveRange(r.curve);
  return ta<=tb?{curve:r.curve,t0:x,t1:y,error:r.error}:{curve:r.curve,t0:y,t1:x,error:r.error};
}
/* SP_CURVE: the surface's image of its 2D B-spline. On a plane the image is itself a B-spline. */
function spcurveEdge(e,c,p0,p1,tol){
  const S=c.surface;
  let ta=p0?G.curveProject(c,p0).t:G.curveRange(c)[0],tb=p1?G.curveProject(c,p1).t:G.curveRange(c)[1];
  // a projection at a degenerate tip (a blend's u=0 station, where the v parameter is free until
  // the Newton settles) can return the same parameter for both end vertices; the 2D curve's own
  // range, oriented by which 3D end is nearer, is then the only usable one
  if(Math.abs(ta-tb)<=1e-12){const [a,b]=G.curveRange(c);
    if(p0&&dist(G.curvePoint(c,a),p0)>dist(G.curvePoint(c,a),p1)){ta=b;tb=a;}else{ta=a;tb=b;}}
  let t0=ta,t1=tb;
  if(S.type==='plane'){
    const y=cross(S.n,S.x),c2=c.c2;
    const curve={type:'bspline',degree:c2.degree,knots:c2.knots,weights:c2.weights,closed:false,
      ctrl:c2.ctrl.map(q=>add(S.p,add(mul(S.x,q[0]),mul(y,q[1]))))};
    return {curve,t0,t1,error:0};
  }
  const lo=Math.min(ta,tb),hi=Math.max(ta,tb),N=Math.max(8,c.c2.ctrl.length*2);
  const ss=[];for(let i=0;i<=N;i++)ss.push(lo+(hi-lo)*i/N);
  const fn=t=>G.curvePoint(c,t);
  const ends=p0?(ta<tb?[p0,p1]:[p1,p0]):null;
  const finish=r=>{const [a,b]=G.curveRange(r.curve);
    return ta<=tb?{curve:r.curve,t0:a,t1:b,error:r.error}:{curve:r.curve,t0:b,t1:a,error:r.error};};
  let out,firstErr=null;
  try{out=finish(fitPoints(fn,ss,tol,{ends}));}
  catch(err){firstErr=err;}
  // Parasolid's own (u,v) for a blended_edge is inherited from a spine we never see: the 2D
  // curve's u is a scale of Parasolid's choice, not of our reconstructed spine, so the plain fit
  // can miss by a wide margin. What is exact is the arc direction (v across the section). When
  // the curve runs along one axis, anchor it on the fitted surface through the edge's vertices.
  if((!out||out.error>tol)&&S.uRange&&p0&&p1){
    let alt=null;
    try{alt=reanchor(S,c,p0,p1,N,tol);}catch(err){if(!firstErr)firstErr=err;}
    if(alt&&(!out||alt.error<=out.error))out=alt;
  }
  if(!out&&ends&&dist(ends[0],ends[1])<Math.max(64*tol,1e-9)){
    // whole image under the reporting floor: a line between the ends, sag irrelevant
    out={curve:{type:'bspline',degree:1,knots:[0,0,1,1],weights:null,closed:false,ctrl:[ends[0],ends[1]]},t0:0,t1:1,error:0};}
  if(!out)throw firstErr||Error('fit: SP-curve edge '+e.id);
  return out;
}

/* Re-anchor an SP_CURVE on a fitted blend by its vertices: the edge lies on the blend, so the
 * section (v-line) or boundary curve (u-line) that passes through both vertices is the curve.
 * Refit against that, in the fitted surface's own parameters. */
function reanchor(S,c,p0,p1,N,tol){
  const [d,z]=G.curveRange(c.c2),M=24,us=[],vs=[];
  for(let i=0;i<=M;i++){const q=G.curvePoint(c.c2,d+(z-d)*i/M);us.push(q[0]);vs.push(q[1]);}
  const umin=Math.min(...us),umax=Math.max(...us),vmin=Math.min(...vs),vmax=Math.max(...vs);
  const uSpan=umax-umin,vSpan=vmax-vmin,K=32;
  const nearest=(row,q)=>{let best=Infinity;for(const x of row)best=Math.min(best,dist(x,q));return best;};
  if(uSpan<1e-3){   // constant u: one section, both vertices on its arc
    const score=t=>{const row=[];for(let j=0;j<=K;j++)row.push(G.surfaceEval(S,t,j/K).p);
      return nearest(row,p0)+nearest(row,p1);};
    let bt=0,bs=Infinity;for(let i=0;i<=64;i++){const s=score(i/64);if(s<bs){bs=s;bt=i/64;}}
    let h=1/64;for(let i=0;i<40;i++){const s1=score(Math.max(0,bt-h/2)),s2=score(Math.min(1,bt+h/2));
      if(s1<bs){bs=s1;bt=Math.max(0,bt-h/2);}else if(s2<bs){bs=s2;bt=Math.min(1,bt+h/2);}h/=2;}
    // v anchors: where on the section the two vertices sit (coarse, then a fine pass)
    const anchors=q=>{let jA=0,dq=Infinity;
      for(let j=0;j<=K;j++){const s=dist(G.surfaceEval(S,bt,j/K).p,q);if(s<dq){dq=s;jA=j;}}
      let bv=jA/K,bq=dq;
      for(let w=-Math.ceil(K/2);w<=Math.ceil(K/2);w++){const v=Math.min(1,Math.max(0,jA/K+w/(K*K)));
        const s=dist(G.surfaceEval(S,bt,v).p,q);if(s<bq){bq=s;bv=v;}}
      return bv;};
    const vA=anchors(p0),vB=anchors(p1);
    // the 2D curve's own start maps to the anchor whose image sits nearest its start vertex;
    // when both images are closer to one vertex (a sliver), fall back to the 2D v direction
    const startV=G.curvePoint(c.c2,d)[1];
    const fwd=(startV-vmin)*(vmax-vmin)>=0? vA<=vB : vB<=vA;
    const a0=Math.min(vA,vB),a1=Math.max(vA,vB);
    const ends=fwd?[p0,p1]:[p1,p0];
    const r=fitPoints(s=>G.surfaceEval(S,bt,a0+(a1-a0)*s).p,
      Array.from({length:N+1},(_,i)=>i/N),tol,{ends});
    const [x,y]=G.curveRange(r.curve);
    return fwd?{curve:r.curve,t0:x,t1:y,error:r.error}:{curve:r.curve,t0:y,t1:x,error:r.error};
  }
  if(vSpan<1e-3){   // constant v: a contact curve along the blend's boundary
    const vc=vmin===vmax?vmin:(Math.abs(vmin)<=Math.abs(vmax)?vmin:vmax);
    const anchors=q=>{let bt2=0,dq=Infinity;
      for(let i=0;i<=256;i++){const s=dist(G.surfaceEval(S,i/256,vc).p,q);if(s<dq){dq=s;bt2=i/256;}}
      let bvv=bt2,bq=dq;
      for(let w=-8;w<=8;w++){const t=Math.min(1,Math.max(0,bt2+w/(256*8)));
        const s=dist(G.surfaceEval(S,t,vc).p,q);if(s<bq){bq=s;bvv=t;}}
      return bvv;};
    const tA=anchors(p0),tB=anchors(p1);
    const startU=us[0],mid=(umin+umax)/2;
    // the fit runs from the lower anchor to the higher, so the anchors give the direction; the
    // 2D curve's start only decides a tie (both ends found at the same parameter)
    const fwd=tA!==tB?tA<tB:startU<mid;
    const b0=Math.min(tA,tB),b1=Math.max(tA,tB);
    const ends=fwd?[p0,p1]:[p1,p0];
    const r=fitPoints(s=>G.surfaceEval(S,b0+(b1-b0)*s,vc).p,
      Array.from({length:N+1},(_,i)=>i/N),tol,{ends});
    const [x,y]=G.curveRange(r.curve);
    return fwd?{curve:r.curve,t0:x,t1:y,error:r.error}:{curve:r.curve,t0:y,t1:x,error:r.error};
  }
  return null;
}

/* ---------------- blends ---------------- */
/* An evaluable spine: exact curves as they are, an intersection curve fitted tightly. */
const spineMemo=new WeakMap();
function spineOf(b,tol){
  if(spineMemo.has(b))return spineMemo.get(b);
  let c=b.spine;if(c.type==='trimmed')c=c.basis;
  let out;
  if(c.type==='line'||c.type==='circle'||c.type==='ellipse'||c.type==='bspline')out={curve:c,error:0};
  else if(c.type==='intersection'){
    if(!c.start||!c.end)throw Error('blend: intersection spine without limits');
    const A=c.start.p,B=c.end.p,cd=sub(c.chart[1],c.chart[0]);
    let scale=0;for(let i=1;i<c.chart.length;i++)scale+=dist(c.chart[i],c.chart[i-1]);
    const poly=chartMarch(c.surfaces[0],c.surfaces[1],A,B,c.chart)||march(c.surfaces[0],c.surfaces[1],A,B,cd,scale,false);
    const {ss,fn}=polyFn(c.surfaces[0],c.surfaces[1],poly);
    const r=fitPoints(fn,ss,tol/10,{fixed:poly});out={curve:r.curve,error:r.error};
  }else throw Error('blend: spine '+c.type);
  spineMemo.set(b,out);return out;
}
/* Contact of the ball centred at x with support i of blend b. */
function contact(b,i,x,cache){
  const S=b.surfaces[i];
  if(S.type==='blend'&&Math.abs(S.range[0])<1e-12&&Math.abs(S.range[1])<1e-12){
    const k=spineOf(S,1e-10).curve;           // a zero-radius blend: the ball touches its spine
    return G.curvePoint(k,G.curveProject(k,x).t);
  }
  return footOn(S,x,cache).q;
}
/* Spine parameter nearest x (unwrapped near `ref` for periodic spines). */
function spineParam(sp,x,ref){
  let t=sp.type==='bspline'?nearestParam(sp,x,ref===undefined?G.curveProject(sp,x).t:ref):G.curveProject(sp,x).t;
  if(ref!==undefined&&G.periodic(sp)){while(t-ref>Math.PI)t-=TAU;while(ref-t>Math.PI)t+=TAU;}
  return t;
}
function blendSurface(b,face,N,opts){
  const tol=(opts&&opts.tolerance)||1e-8;
  if(b.blendType!=='R'&&b.blendType!=='E')throw Error('blend: type '+b.blendType);
  const r=Math.abs(b.range[0]);
  if(Math.abs(Math.abs(b.range[1])-r)>1e-12)throw Error('blend: variable or chamfer blend');
  const SP=spineOf(b,tol),sp=SP.curve,cache=new Map();
  // spine range covered by the face: project its boundary (vertices and edge samples)
  const pts=[];
  for(const l of face.loops)for(const co of l.coedges){const e=N.edges.get(co.edge);
    if(e.v)for(const v of e.v)pts.push(N.vertices.get(v).p);
    let c=e.curve;if(c.type==='trimmed')c=c.basis;
    if(c.type==='intersection')pts.push(...c.chart.filter(q=>Math.abs(dist(q,G.curvePoint(sp,G.curveProject(sp,q).t))-r)<r*0.5));
    else if(e.v&&c.type!=='spcurve'){const a=G.curveProject(c,N.vertices.get(e.v[0]).p).t,z=G.curveProject(c,N.vertices.get(e.v[1]).p).t;
      let dz=z-a;if(G.periodic(c)){dz=e.sameSense?((dz%TAU)+TAU)%TAU:-((((-dz)%TAU)+TAU)%TAU);}
      for(let k=1;k<8;k++)pts.push(G.curvePoint(c,a+dz*k/8));}}
  const ref=G.curveProject(sp,pts[0]).t;
  // a boundary point is at distance r from its section's centre
  const ts=pts.map(q=>spineParam(sp,q,ref));
  let t0=Math.min(...ts),t1=Math.max(...ts);
  const span=t1-t0;
  const lim=[b.start,b.end].filter(Boolean).filter(x=>x.type==='T').map(x=>spineParam(sp,x.p,ref));
  t0-=span*0.02;t1+=span*0.02;
  for(const x of lim){if(Math.abs(x-t0)<span*0.05)t0=Math.max(t0,x);if(Math.abs(x-t1)<span*0.05)t1=Math.min(t1,x);}
  if(!G.periodic(sp)){const [a,z]=G.curveRange(sp);t0=Math.max(t0,a);t1=Math.min(t1,z);}
  // section at spine parameter t: circular arc from the support-0 contact to the support-1
  // contact, as rational quadratic control points in homogeneous form
  let segs=1;
  const section=t=>{
    const c=G.curvePoint(sp,t),P1=contact(b,0,c,cache),P2=contact(b,1,c,cache);
    const a1=sub(P1,c),a2=sub(P2,c),th=Math.acos(Math.max(-1,Math.min(1,dot(a1,a2)/(norm(a1)*norm(a2)||1))));
    if(segs===1){const w=Math.cos(th/2),bis=unit(add(a1,a2));const M=norm(add(a1,a2))<1e-15?P1:add(c,mul(bis,r/w));
      return {th,c,h:[[...P1,1],[...mul(M,w),w],[...P2,1]]};}
    // two segments: split at the arc's midpoint
    const bis=unit(add(a1,a2)),Q=add(c,mul(bis,r)),w=Math.cos(th/4);
    const M1=add(c,mul(unit(add(a1,mul(bis,r))),r/w)),M2=add(c,mul(unit(add(a2,mul(bis,r))),r/w));
    return {th,c,h:[[...P1,1],[...mul(M1,w),w],[...Q,1],[...mul(M2,w),w],[...P2,1]]};
  };
  let maxTh=0;for(let k=0;k<=16;k++)maxTh=Math.max(maxTh,section(t0+(t1-t0)*k/16).th);
  if(maxTh>2.2)segs=2;
  if(maxTh>3.1)throw Error('blend: section arc of '+maxTh+' rad');
  let us=[];for(let k=0;k<=8;k++)us.push(t0+(t1-t0)*k/8);
  const vknots=segs===1?[0,0,0,1,1,1]:[0,0,0,0.5,0.5,1,1,1];
  let surf,error=Infinity,secs=us.map(section);
  for(let round=0;round<14;round++){
    const params=us.map(u=>(u-t0)/(t1-t0)),rows=secs[0].h.length;
    const cols=[];for(let j=0;j<rows;j++)cols.push(interp(secs.map(s=>s.h[j]),params,3));
    const ku=cols[0].knots,nu=cols[0].ctrl.length;
    const ctrl=[],weights=[];
    for(let i=0;i<nu;i++){ctrl.push([]);weights.push([]);for(let j=0;j<rows;j++){const h=cols[j].ctrl[i];ctrl[i].push([h[0]/h[3],h[1]/h[3],h[2]/h[3]]);weights[i].push(h[3]);}}
    surf={type:'bspline',du:3,dv:2,ctrl,weights,ku,kv:vknots,uClosed:false,vClosed:false,fitted:'blend',spine:sp,radius:r};
    const bad=[];error=0;
    for(let i=0;i<us.length-1;i++){let e=0;
      for(const f of [0.5,0.25,0.75])for(const v of [0,0.2,0.4,0.5,0.6,0.8,1]){
        const X=G.bsplineSurface(surf,params[i]+(params[i+1]-params[i])*f,v).p;
        const t=spineParam(sp,X,us[i]),d=Math.abs(dist(X,G.curvePoint(sp,t))-r);e=Math.max(e,d);}
      error=Math.max(error,e);if(e>tol)bad.push(i);}
    if(!bad.length||us.length>4000)break;
    const nu2=[],ns=[];
    for(let i=0;i<us.length;i++){nu2.push(us[i]);ns.push(secs[i]);if(bad.includes(i)){const m=(us[i]+us[i+1])/2;nu2.push(m);ns.push(section(m));}}
    us=nu2;secs=ns;
  }
  // sections were interpolated, but the boundary rows must lie on the supports: check them too
  // uRange: the spine range t0..t1 the fit covers, so SP_CURVE pcurves in the blend's raw (u,v),
  // whose u is the spine curve's own parameter, can be remapped into the fit's [0, 1]; on the
  // surface object itself, because resolve passes only surf through its memo
  surf.uRange=[t0,t1];
  return {surface:surf,error:Math.max(error,SP.error),uRange:[t0,t1]};
}

return {interp,fitPoints,edgeCurve,blendSurface,corrector,march,nearestParam,spineOf,contact,reanchor};
});

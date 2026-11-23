'use strict';
/* Pieces of the curve fitter and the evaluator that EXP-103 changed, on hand-built geometry:
 * the dense pass in fitPoints, which ends a fit is pinned to, the B-spline surface's extension
 * past its edge, and a swept surface past the end of an open B-spline section. */
const test=require('node:test'),assert=require('assert/strict');
const F=require('../src/brep/fit'),G=require('../src/geom/eval');

const lineDist=(c,q)=>{const [a,b]=G.curveRange(c);let t=a,bd=Infinity;
  for(let i=0;i<=2000;i++){const x=a+(b-a)*i/2000,d=G.dist(G.bsplineCurve(c,x).p,q);if(d<bd){bd=d;t=x;}}
  return G.dist(G.bsplineCurve(c,F.nearestParam(c,q,t)).p,q);};

// A narrow bump between the cheap samples: with 9 starting points the intervals are 1/8 long, the
// cheap samples sit at 1/32 steps, and the bump at 0.515625 is 1/64 from the nearest of them,
// where it is under 1e-13 m. The dense samples at 1/10 steps of an interval see it.
const bump=s=>[s,0,3e-7*Math.exp(-(((s-0.515625)/0.004)**2))];
const nine=Array.from({length:9},(_,i)=>i/8);
const missBy=(r,f)=>{let w=0;for(let i=0;i<=20000;i++)w=Math.max(w,lineDist(r.curve,f(i/20000)));return w;};

test('fitPoints: a bump between the cheap samples is fitted, not stepped over',()=>{
  const r=F.fitPoints(bump,nine,1e-8);
  assert(missBy(r,bump)<=1e-8,'fit is '+missBy(r,bump).toExponential(2)+' m off the curve between samples');
  assert(r.error<=1e-8,'reported '+r.error);
});

test('fitPoints: out of rounds before the dense pass, the error still includes it',()=>{
  // one round: the cheap check passes, and the loop ends before the dense pass would run
  const r=F.fitPoints(bump,nine,1e-8,{maxRounds:1}),miss=missBy(r,bump);
  assert(miss>1e-7,'expected the one-round fit to miss the bump, it is '+miss.toExponential(2)+' off');
  assert(r.error>=miss/2,'reported '+r.error.toExponential(2)+' for a fit '+miss.toExponential(2)+' off');
});

test('SP_CURVE ends: a vertex off the curve but within the edge tolerance is not pinned',()=>{
  // a quarter circle on a cylinder of radius 1e-2 m, as an SP_CURVE (a straight line in (u,v));
  // the far vertex sits 1e-6 m outside the cylinder, as a tolerant vertex can
  const R=1e-2,cyl={type:'cylinder',p:[0,0,0],a:[0,0,1],x:[1,0,0],r:R};
  const c={type:'spcurve',surface:cyl,c2:{type:'bspline',degree:1,knots:[0,0,1,1],ctrl:[[0,0.002],[Math.PI/2,0.002]],weights:null}};
  const p0=G.curvePoint(c,0),p1=G.add(G.curvePoint(c,1),[0,1e-6,0]);
  const offCyl=r=>{let w=0;for(let i=0;i<=4000;i++){const p=G.bsplineCurve(r.curve,r.t0+(r.t1-r.t0)*i/4000).p;w=Math.max(w,Math.abs(Math.hypot(p[0],p[1])-R));}return w;};
  // within the edge's tolerance: the curve stays on the cylinder and ends next to the vertex
  const free=F.edgeCurve({id:1,sameSense:true,tolerance:2e-5},c,p0,p1,{tolerance:1e-8});
  assert(free.error<=1e-8,'error '+free.error);
  assert(offCyl(free)<=1e-8,'curve leaves the cylinder by '+offCyl(free).toExponential(2));
  assert(Math.abs(G.dist(G.bsplineCurve(free.curve,free.t1).p,p1)-1e-6)<1e-9,'end not next to the vertex');
  // no edge tolerance (an exact edge): pinned as before, and the hook is there
  const pinned=F.edgeCurve({id:1,sameSense:true},c,p0,p1,{tolerance:1e-8});
  assert(G.dist(G.bsplineCurve(pinned.curve,pinned.t1).p,p1)<1e-15,'exact edge: end not on the vertex');
  assert(offCyl(pinned)>5e-7,'expected the pinned fit to reach the vertex');
  assert(pinned.error>=1e-6*0.99,'pinned 1e-6 m off the curve, reported '+pinned.error.toExponential(2));
  // further off than the edge's tolerance: pinned, and the error says how far (EXP-103 blind check)
  const far=G.add(G.curvePoint(c,1),[0,1e-4,0]),r=F.edgeCurve({id:1,sameSense:true,tolerance:2e-5},c,p0,far,{tolerance:1e-8});
  assert(G.dist(G.bsplineCurve(r.curve,r.t1).p,far)<1e-15,'end not on the far vertex');
  assert(r.error>=1e-4*0.99,'vertex 1e-4 m off, reported '+r.error.toExponential(2));
  // an exact edge with a tolerant vertex: the vertex's own tolerance frees its end, and only its end
  const exact={id:1,sameSense:true},v1=F.edgeCurve(exact,c,p0,p1,{tolerance:1e-8,vertexTolerance:[0,2e-5]});
  assert(v1.error<=1e-8&&offCyl(v1)<=1e-8,'tolerant far vertex: error '+v1.error.toExponential(2));
  const v0=F.edgeCurve(exact,c,p0,p1,{tolerance:1e-8,vertexTolerance:[2e-5,0]});
  assert(v0.error>=1e-6*0.99,'the near vertex\'s tolerance freed the far end: error '+v0.error.toExponential(2));
});

test('B-spline surface past its edge: the cross term is the exact mixed derivative',()=>{
  // Past v=1 the surface is S(u,1) + b Sv(u,1), so there du = Su(u,1) + b d(Sv)/du (u,1). Reference
  // for d(Sv)/du on the edge: Richardson-extrapolated central differences of the exact Sv, good to
  // about 1e-12 relative. A differenced cross term carries about 1e-10, which is what EXP-103 saw
  // keep a foot far out on the extension from settling.
  const ctrl=[];for(let i=0;i<5;i++){ctrl.push([]);for(let j=0;j<4;j++)ctrl[i].push([i/4+0.05*j*j,j/3,Math.sin(i*1.3)*Math.cos(j*0.7)*0.4+0.1*i*j*j]);}
  const s={type:'bspline',du:3,dv:3,ctrl,weights:null,ku:[0,0,0,0,0.4,1,1,1,1],kv:[0,0,0,0,1,1,1,1]};
  const Sv=u=>G.surfaceEval(s,u,1).dv,cd=(u,h)=>G.mul(G.sub(Sv(u+h),Sv(u-h)),1/(2*h));
  let worst=0;
  for(const u of [0.15,0.3,0.62,0.8]){const h=2e-3,ref=G.sub(G.mul(cd(u,h/2),4/3),G.mul(cd(u,h),1/3));
    for(const b of [0.5,8,40]){const du=G.surfaceEval(s,u,1+b).du,want=G.add(G.surfaceEval(s,u,1).du,G.mul(ref,b));
      worst=Math.max(worst,G.norm(G.sub(du,want))/G.norm(want));}}
  assert(worst<2e-11,'cross term off by '+worst.toExponential(2)+' (relative)');
});

test('swept surface past the end of an open B-spline section: straight on; closed: unchanged',()=>{
  const sec={type:'bspline',degree:3,knots:[0,0,0,0,1,1,1,1],ctrl:[[0,0,0],[1,1,0],[2,-1,0],[3,0,0]],weights:null,closed:false,periodic:false};
  const sw={type:'swept',curve:sec,d:[0,0,1]};
  const end=G.bsplineCurve(sec,1),p=G.surfaceEval(sw,1.25,0.5).p,want=G.add(G.add(end.p,G.mul(end.d,0.25)),[0,0,0.5]);
  assert(G.dist(p,want)<1e-15,'open section: '+G.dist(p,want));
  const closed={...sec,closed:true},q=G.surfaceEval({...sw,curve:closed},1.25,0.5).p,before=G.add(G.bsplineCurve(closed,1.25).p,[0,0,0.5]);
  assert(G.dist(q,before)<1e-15,'closed section changed: '+G.dist(q,before));
  // and a foot past the end of the open one lands on the extension
  const r=G.surfaceInverse(sw,G.add(want,[0,0,0]));
  assert(Math.abs(r.u-1.25)<1e-9&&Math.abs(r.v-0.5)<1e-9,'foot at '+r.u+', '+r.v);
});

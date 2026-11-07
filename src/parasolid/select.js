/* The active configuration of a file with no Config-N-ModelHeader (before about SW2020), from the
 * saved display mesh (EXP-094, EXP-098).
 *
 * A configuration matches when its B-rep has as many faces as the display (the native count,
 * before the STEP export splits periodic faces) and its box equals the union of the display's
 * per-face analytic bounds within 1e-8 m. The B-rep box is every vertex (single-vertex loops
 * included: without them 118a3cb0's config 268 is 2 mm off) plus every edge's extremes, after
 * procedural curves are fitted as the STEP export fits them. Lines, circles and ellipses give
 * exact extremes. Other curves give 257 samples, which bound the box from inside. The display pads
 * faces at tolerant vertices (300f9732: 2.5e-8 m), so those parts miss and fall back (EXP-098).
 * Tied configurations in the corpus export identical STEP, but the test can't guarantee that, so
 * several matches are ranked by how well the display mesh's vertices and normals sit on each
 * one's surfaces (meshResidual), and equal ones keep the lowest ID. With no match, or no display,
 * the caller keeps the lowest ID.
 *
 * Isomorphic: Node, or a browser script after src/display.js, src/geom/eval.js, src/brep/native.js
 * and src/brep/procedural.js (global SLDPRTSelect). */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('../display'),require('../geom/eval'),require('../brep/native'),require('../brep/procedural'));
  else root.SLDPRTSelect=factory(root.SLDPRTDisplay,root.SLDPRTGeom,root.SLDPRTNative,root.SLDPRTProcedural);
})(typeof self!=='undefined'?self:this,function(display,G,native,Procedural){
'use strict';
const BAR=1e-8,SAMPLES=256,TAU=2*Math.PI;

function grow(b,p){for(let k=0;k<3;k++){if(p[k]<b.min[k])b.min[k]=p[k];if(p[k]>b.max[k])b.max[k]=p[k];}}
const empty=()=>({min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]});
const gap=(a,b)=>Math.max(...[0,1,2].flatMap(k=>[Math.abs(a.min[k]-b.min[k]),Math.abs(a.max[k]-b.max[k])]));

/* Union of the display's per-face bounds, or null when any face lacks them. */
function displayBox(d){
  if(!d.faces.length||d.faces.some(f=>!f.bounds))return null;
  const b=empty();for(const f of d.faces){grow(b,f.bounds.min);grow(b,f.bounds.max);}
  return b;
}

/* An edge's parameter range on its curve (same as brep/volume.js edgePath). */
function range(e,V){
  const c=e.curve.type==='trimmed'?e.curve.basis:e.curve;
  if(e.t0!==undefined&&e.t1!==undefined)return {c,t0:e.t0,t1:e.t1};
  const periodic=c.type==='circle'||c.type==='ellipse';
  if(!e.v){const [a,b]=G.curveRange(c);
    if(periodic)return {c,t0:a,t1:a+(e.sameSense?TAU:-TAU)};
    return e.sameSense?{c,t0:a,t1:b}:{c,t0:b,t1:a};}
  const ps=V.get(e.v[0]).p,pe=V.get(e.v[1]).p;
  let ts=G.curveProject(c,ps).t,te=G.curveProject(c,pe).t;
  if(periodic){
    if(e.v[0]===e.v[1])te=ts+(e.sameSense?TAU:-TAU);
    else if(e.sameSense){while(te<=ts)te+=TAU;}else{while(te>=ts)te-=TAU;}
  }
  return {c,t0:ts,t1:te};
}

/* Grow b by an edge's points: its ends, plus each coordinate's turning points on a circle or
 * ellipse inside the edge's range, or samples on any other curve. */
function edgeExtremes(b,r){
  const {c,t0,t1}=r,lo=Math.min(t0,t1),hi=Math.max(t0,t1);
  grow(b,G.curvePoint(c,t0));grow(b,G.curvePoint(c,t1));
  if(c.type==='line')return;
  if(c.type==='circle'||c.type==='ellipse'){
    const {x,y}=G.frame(c.n,c.x),r1=c.type==='circle'?c.r:c.r1,r2=c.type==='circle'?c.r:c.r2;
    for(let k=0;k<3;k++){
      const t=Math.atan2(r2*y[k],r1*x[k]);
      for(const u of [t,t+Math.PI]){const v=lo+(((u-lo)%TAU)+TAU)%TAU;if(v<=hi)grow(b,G.curvePoint(c,v));}
    }
    return;
  }
  for(let i=1;i<SAMPLES;i++)grow(b,G.curvePoint(c,t0+(t1-t0)*i/SAMPLES));
}

/* {faces, box} of a parsed partition as the STEP export builds it (hidden bodies left out,
 * intersection and blend geometry fitted). Single-vertex loops are in the native vertex map only. */
function brepBox(parsed){
  const n=native.build(parsed),m=Procedural.resolve(n),b=empty();
  for(const v of n.vertices.values())grow(b,v.p);
  for(const e of m.edges.values()){
    if(!e.curve)continue;
    edgeExtremes(b,range(e,m.vertices));
  }
  return {faces:m.faces.length,box:b,model:m};
}

/* How far the display mesh is from a B-rep, as {pos, ang}: per display face, up to PER_FACE of its
 * vertices are checked against each B-rep surface for distance (m) and for the angle between the
 * surface normal and the stored mesh normal (rad, either sign). Each display face takes the surface
 * that keeps every checked vertex within BAR and has the smallest worst angle, else the closest one;
 * the part's result is the worst face. Positions alone can't separate a 1 mm chamfer from a 1 mm
 * fillet: the flat chamfer is meshed from its corners, which lie on the fillet's cylinder too, but
 * its normals are 45 degrees off the cylinder's there. Surfaces count as unbounded, so this only
 * ranks configurations that passed the box test. On the SW2011 cubes the mesh normals are within
 * 2.2e-7 rad of their own surfaces (EXP-098). */
const PER_FACE=8,NEAR=3,PREFILTER=1e-6;
function meshResidual(d,m){
  const at=(s,p,nd)=>{let r;try{r=G.surfaceDistance(s,p);}catch(_){return {pos:Infinity,ang:Math.PI/2};}
    const c=r.n?Math.min(1,Math.abs(G.dot(r.n,nd))/Math.hypot(...nd)):0;return {pos:Math.abs(r.d),ang:Math.acos(c)};};
  let pos=0,ang=0;
  for(const f of d.faces){
    const n=f.vertices.length/3;if(!n)continue;
    const k=Math.min(n,PER_FACE),pts=[];
    for(let i=0;i<k;i++){const j=3*Math.floor(i*n/k);pts.push({p:[f.vertices[j],f.vertices[j+1],f.vertices[j+2]],n:[f.normals[j],f.normals[j+1],f.normals[j+2]]});}
    // surfaces through the first vertex, or the NEAR closest when none is
    const first=m.faces.map(b=>({s:b.surface,pos:at(b.surface,pts[0].p,pts[0].n).pos})).sort((x,y)=>x.pos-y.pos);
    const tried=first.filter((x,i)=>x.pos<=PREFILTER||i<NEAR);
    let best=null;
    for(const t of tried){
      const r=pts.map(q=>at(t.s,q.p,q.n)),fp=Math.max(...r.map(x=>x.pos)),fa=Math.max(...r.map(x=>x.ang));
      if(!best||better({pos:fp,ang:fa},best))best={pos:fp,ang:fa};
    }
    pos=Math.max(pos,best.pos);ang=Math.max(ang,best.ang);
  }
  return {pos,ang};
}
/* a beats b: both within BAR and a's angle is smaller, or a is closer. */
function better(a,b){
  if(a.pos<=BAR&&b.pos<=BAR)return a.ang<b.ang;
  return a.pos<b.pos;
}

/* candidates: [{name, parsed}] in ascending ID order. Returns {name|null, matches, rows}. */
function choose(raw,candidates,inflateRaw,inflateZlib){
  const d=display.parseSLDPRT(raw,inflateRaw,inflateZlib),want=displayBox(d),rows=[];
  if(!want)return {name:null,matches:[],rows,reason:'no display bounds'};
  for(const c of candidates){
    const row={name:c.name};rows.push(row);
    if(!c.parsed||c.parsed.error){row.error=c.parsed?String(c.parsed.error):'unreadable';continue;}
    try{const r=brepBox(c.parsed);row.faces=r.faces;if(r.faces===d.faces.length){row.gap=gap(r.box,want);row.model=r.model;}}
    catch(e){row.error=e.message;}
  }
  const fits=rows.filter(r=>r.gap<=BAR),matches=fits.map(r=>r.name);
  // Face count and box can tie different shapes (EXP-098: cubes with a fillet, a chamfer or
  // 3-5 mm holes all pass). The mesh residual breaks the tie; equal residuals keep the lowest ID.
  let pick=fits[0];
  if(fits.length>1){
    for(const r of fits)try{r.residual=meshResidual(d,r.model);}catch(e){r.residual={pos:Infinity,ang:Math.PI/2};}
    for(const r of fits)if(better(r.residual,pick.residual))pick=r;
  }
  for(const r of rows)delete r.model;
  return {name:pick?pick.name:null,matches,rows,displayFaces:d.faces.length};
}

return {choose,displayBox,brepBox,meshResidual,BAR};
});

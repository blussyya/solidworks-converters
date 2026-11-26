/* Resolve a native B-rep (src/brep/native.js) into geometry a STEP file can hold.
 *
 *   resolve(N, opts) -> {vertices, edges, faces, bodies, report}
 *
 * Every edge gets a 3D curve of type line, circle, ellipse or bspline and the parameters
 * t0 -> t1 it runs over (t1 < t0 when it runs against the curve). Every face keeps its surface
 * unless the surface is procedural.
 *
 *   exact      line, circle, ellipse, B-curve, trimmed curves (the edge's vertices trim them);
 *              plane, cylinder, cone, sphere, torus, B-surface, swept (linear extrusion),
 *              spun (revolution), offset.
 *   pcurves    SP_CURVE: its 2D B-curve is exact in the surface's (u, v) and is kept as a PCURVE;
 *              the 3D curve STEP also needs is fitted (exact on a plane: a plane maps a 2D
 *              B-spline to a 3D one by an affine map).
 *   fitted     INTERSECTION curves and the contact curves of blends: cubic B-splines through
 *              exact points; rolling-ball blends: rational B-spline surfaces whose u-sections are
 *              the exact circular arcs. See src/brep/fit.js.
 * report.maxError is the largest distance found between a fitted curve or surface and the exact
 * geometry, in metres, measured at points between the interpolation points. report.maxEdgeGap is
 * the largest distance from a tolerant edge's curve to the faces it bounds (the model's own gap).
 *
 * Isomorphic: loads in Node and as a plain browser script (global SLDPRTProcedural).
 */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('../geom/eval'),require('./fit'));
  else root.SLDPRTProcedural=factory(root.SLDPRTGeom,root.SLDPRTFit);
})(typeof self!=='undefined'?self:this,function(G,Fit){
'use strict';
const TAU=2*Math.PI;
const mod=(x,m)=>((x%m)+m)%m;

function resolve(N,opts){
  opts=opts||{};
  const tol=opts.tolerance||1e-8;
  const report={exactEdges:0,fittedCurves:0,pcurveEdges:0,fittedSurfaces:0,maxError:0,errors:{curve:0,surface:0},tolerantEdges:0,maxEdgeGap:0};
  const vertices=new Map();for(const v of N.vertices.values())vertices.set(v.id,{id:v.id,p:v.p});
  const P=id=>vertices.get(id).p;
  const faceOf=new Map(N.faces.map(f=>[f.id,f]));

  // surfaces first: blends become B-splines, and curves on them must see the B-spline
  // A blend surface can carry more than one face (f666f342: blend 15483 under faces 13093 and 13171,
  // whose spine ranges are 0.018..0.332 and 0.208..0.722). A fit covers only the spine its face
  // needs, so each such face gets its own fit, and an edge on that surface is evaluated on the fit of
  // the face it bounds. Reusing the first face's fit put the other's edges up to 4.2 cm off (EXP-121).
  const facesOn=new Map();for(const f of N.faces){if(!facesOn.has(f.surface))facesOn.set(f.surface,[]);facesOn.get(f.surface).push(f);}
  const perFace=s=>s.type==='blend'&&(facesOn.get(s)||[]).length>1;
  const surfMemo=new Map(),faceMemo=new Map();
  const faces=N.faces.map(f=>({id:f.id,surface:surface(f.surface,f),sameSense:f.sameSense,loops:f.loops}));
  function surface(s,f){
    const m=perFace(s)?(faceMemo.get(s)||faceMemo.set(s,new Map()).get(s)):null;
    if(m?m.has(f.id):surfMemo.has(s))return m?m.get(f.id):surfMemo.get(s);
    let out=s;
    if(s.type==='blend'){
      const r=Fit.blendSurface(s,f,N,{tolerance:tol});
      out=r.surface;report.fittedSurfaces++;report.errors.surface=Math.max(report.errors.surface,r.error);
    }else if(s.type==='offset'&&s.basis&&s.basis.type==='blend'){
      // an offset of a blend: the blend underneath is fitted too (none in the online sample; head_back's
      // 144 offsets are of B-splines and swept surfaces, EXP-086)
      out={...s,basis:surface(s.basis,f)};
    }else if(s.type==='blendBound')throw Error('resolve: face '+f.id+' lies on a blend boundary surface');
    if(m)m.set(f.id,out);else surfMemo.set(s,out);return out;
  }
  const blendish=s=>s.type==='blend'||s.type==='blendBound'||(s.type==='offset'&&blendish(s.basis));
  const edgeFaces=new Map();for(const f of N.faces)for(const l of f.loops)for(const co of l.coedges){if(!edgeFaces.has(co.edge))edgeFaces.set(co.edge,[]);edgeFaces.get(co.edge).push(f);}
  const fitted=(q,e)=>{if(!perFace(q))return surfMemo.get(q);const m=faceMemo.get(q),f=(edgeFaces.get(e.id)||[]).find(x=>x.surface===q);return m&&(f?m.get(f.id):m.values().next().value);};

  const edges=new Map();
  for(const e of N.edges.values()){
    let c=e.curve;if(c.type==='trimmed')c=c.basis;
    const p0=e.v?P(e.v[0]):null,p1=e.v?P(e.v[1]):null;
    let out;
    if(c.type==='line'||c.type==='circle'||c.type==='ellipse'||(c.type==='bspline'&&c.dim!==2)){
      out={curve:c,...range(c,e.sameSense,p0,p1,e,e.v?Math.max(...e.v.map(v=>N.vertices.get(v).tolerance||0)):0)};report.exactEdges++;
    }else if(c.type==='spcurve'||c.type==='intersection'){
      // fit against the resolved surfaces, not the raw ones: an SP_CURVE pcurve on a blend
      // surface must see the fitted B-spline. Its raw (u,v) is Parasolid's own blend parameter,
      // unrelated to the fitted surface's spine parameterisation -- when the plain fit can't
      // reach the tolerance, spcurveEdge re-anchors the curve geometrically instead.
      if(c.type==='spcurve')c={...c,surface:fitted(c.surface,e)||c.surface};
      // a blend's contact curve (one surface a BLEND_BOUND) is built from the raw blend and its
      // raw supports, which may be blends themselves; the fitted copies would not be found there
      else if(!c.surfaces.some(q=>q.type==='blendBound'))c={...c,surfaces:c.surfaces.map(q=>q.type==='blend'&&Math.abs(Math.abs(q.range[0])-Math.abs(q.range[1]))<1e-12?q:fitted(q,e)||q)};
      const fo={tolerance:tol,faceOf,vertexTolerance:e.v?e.v.map(v=>N.vertices.get(v).tolerance||0):null};
      let r=Fit.edgeCurve(e,c,p0,p1,fo);
      // An SP_CURVE on a fitted blend is in Parasolid's blend (u,v), which we only approximate: v is the
      // angle across the section, u close to the spine's arc length but not equal (EXP-121). When that
      // fit misses the bar and the edge has a fin on a surface we evaluate exactly, fit the fin instead;
      // Parasolid keeps the two within the edge's tolerance. f666f342 edges 1192, 1232, 1206, 11862:
      // 2.4e-2 to 2.7e-3 m on the blend, 7.4e-9 to 1.4e-11 m from their B-spline and offset fins.
      if(c.type==='spcurve'&&c.surface.fitted&&r.error>tol)for(const pc of e.pcurves||[]){let k=pc.curve;if(k.type==='trimmed')k=k.basis;
        if(k.type!=='spcurve'||blendish(k.surface))continue;
        try{const r2=Fit.edgeCurve(e,k,p0,p1,fo);if(r2.error<r.error)r={...r2,fromFin:pc.face};}catch(x){}}
      out={curve:r.curve,t0:r.t0,t1:r.t1,fit:r.error,fromFin:r.fromFin};report.fittedCurves++;report.errors.curve=Math.max(report.errors.curve,r.error);
    }else throw Error('resolve: edge '+e.id+' curve '+c.type);
    // exact curves in the faces' parameter spaces (SP_CURVE fins), on the resolved surfaces
    const pcurves=(e.pcurves||[]).map(pc=>{let k=pc.curve;if(k.type==='trimmed')k=k.basis;if(k.type!=='spcurve')return null;
      const f=faces.find(x=>x.id===pc.face);if(!f||f.surface!==k.surface)return null;return {face:pc.face,surface:f.surface,c2:k.c2};}).filter(Boolean);
    if(pcurves.length)report.pcurveEdges++;
    if(e.tolerant)report.tolerantEdges++;
    edges.set(e.id,{id:e.id,v:e.v,curve:out.curve,t0:out.t0,t1:out.t1,sameSense:out.t1>out.t0,pcurves,fit:out.fit,tolerance:e.tolerance,fromFin:out.fromFin});
  }
  // A tolerant edge has a curve per face and no 3D curve; we use the first face's. Parasolid
  // lets the faces miss each other by the edge's tolerance, so measure how far the curve is
  // from the other face: the file's uncertainty has to cover it. The same for an edge fitted from
  // a fin instead of its own curve (above).
  const facesOf=new Map();
  for(const f of faces)for(const l of f.loops)for(const co of l.coedges){if(!facesOf.has(co.edge))facesOf.set(co.edge,[]);facesOf.get(co.edge).push(f);}
  for(const e of N.edges.values()){const r=edges.get(e.id);if(!e.tolerant&&!r.fromFin)continue;let gap=0;
    for(let k=0;k<=16;k++){const X=G.curvePoint(r.curve,r.t0+(r.t1-r.t0)*k/16);
      for(const f of facesOf.get(e.id)||[])gap=Math.max(gap,Math.abs(G.surfaceDistance(f.surface,X).d));}
    r.gap=gap;report.maxEdgeGap=Math.max(report.maxEdgeGap,gap);}
  // a fitted blend's parametrisation is ours, so its face sense is too: the blend meets its
  // supports tangentially, so take the neighbour whose normal is most nearly parallel and agree
  for(const f of faces){if(!f.surface.fitted)continue;
    let best=null,bd=-1;
    for(const l of f.loops)for(const co of l.coedges){const e=edges.get(co.edge);
      const X=G.curvePoint(e.curve,(e.t0+e.t1)/2);
      for(const g of faces){if(g===f||g.surface.fitted||!g.loops.some(m=>m.coedges.some(c=>c.edge===e.id)))continue;
        const ng=G.mul(G.surfaceFoot(g.surface,X).n,g.sameSense?1:-1),nf=G.surfaceFoot(f.surface,X).n,d=G.dot(ng,nf);
        if(Math.abs(d)>bd){bd=Math.abs(d);best=d;}}}
    if(best===null)throw Error('resolve: blend face '+f.id+' has no neighbour to orient it by');
    f.sameSense=best>0;
  }
  report.maxError=Math.max(report.errors.curve,report.errors.surface);
  return {source:N.source,unit:'m',vertices,edges,faces,bodies:N.bodies,report};
}

/* Parameters of an exact curve between the edge's vertices, in the edge's direction. */
function range(c,same,p0,p1,e,vtol){
  const proj=p=>G.curveProject(c,p);
  if(!p0){   // closed edge without a vertex
    if(c.type==='circle'||c.type==='ellipse')return same?{t0:0,t1:TAU}:{t0:TAU,t1:0};
    const [a,b]=G.curveRange(c);return same?{t0:a,t1:b}:{t0:b,t1:a};
  }
  const a=proj(p0),b=proj(p1);
  const gap=Math.max(a.d,b.d);
  // a tolerant vertex may sit off the curve by up to its own tolerance (0739c559: 30 µm of 48)
  if(gap>Math.max(1e-6,(e.tolerance||0)*2,vtol||0))throw Error('resolve: edge '+e.id+' vertices are '+gap.toExponential(2)+' m off its curve');
  let t0=a.t,t1=b.t;
  if(c.type==='circle'||c.type==='ellipse'){
    if(same){t1=t0+mod(t1-t0,TAU);if(t1-t0<1e-12)t1=t0+TAU;}
    else{t1=t0-mod(t0-t1,TAU);if(t0-t1<1e-12)t1=t0-TAU;}
  }else if(c.type==='bspline'&&c.closed&&e.v[0]===e.v[1]){const [x,y]=G.curveRange(c);t0=same?x:y;t1=same?y:x;}
  else if((t1>t0)!==same)throw Error('resolve: edge '+e.id+' runs against its sense ('+t0+' -> '+t1+')');
  return {t0,t1};
}

return {resolve,range};
});

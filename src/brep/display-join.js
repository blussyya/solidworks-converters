/* Join the saved display faces to the native B-rep faces (EXP-104).
 *
 * The display mesh names a face by the node_id its section wrote (metadata.rawId). merge() in
 * src/parasolid/partition.js moves the node_ids of later sections so they stay unique, and a
 * partition can hold several bodies that each number their faces from 1, so rawId alone can name
 * more than one native face. The join narrows the candidates (native face .displayId === rawId) by:
 *   1. surface type from the display tag (4001 plane ... 4010 spun; a tag outside the table filters nothing),
 *   2. geometry: the native face's vertices (and points on its ring edges) inside the display face's stored
 *      bounds, and the display vertices on the native surface (plane, cylinder, cone, sphere, torus have a
 *      closed form here). A candidate that passes the bounds test beats one that has nothing to test.
 * Display order is not used: faces come mostly grouped by body but not exactly, and inside a body
 * they do not follow the native face order (EXP-104 order.js).
 *
 * Result per display face: {face, how, candidates}. how is
 *   'id'        one native face has the id
 *   'type'      the surface type left one
 *   'geometry'  the bounds and surface check left one
 *   'ambiguous' several are left; face is null
 *   'none'      no id block, no native face with the id, or none of the right type; face is null
 *
 * Isomorphic: loads in Node and as a plain browser script (global SLDPRTDisplayJoin).
 */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('../geom/eval'));
  else root.SLDPRTDisplayJoin=factory(root.SLDPRTGeom);
})(typeof self!=='undefined'?self:this,function(G){
'use strict';

const TAG_TYPE={4001:'plane',4002:'cylinder',4003:'cone',4004:'sphere',4005:'torus',4006:'bspline',4007:'blend',4009:'swept',4010:'spun'};
// metres: Parasolid's 1e-5 m edge tolerance (EXP-097); float32 vertex rounding is far below it
const TOL=1e-5;

const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],norm=a=>Math.hypot(a[0],a[1],a[2]);
const perp=(q,a)=>{const h=dot(q,a);return [q[0]-a[0]*h,q[1]-a[1]*h,q[2]-a[2]*h];};

/* Signed distance from p to an analytic surface; null for a surface with no closed form here. */
function residual(s,p){
  switch(s.type){
    case 'plane':return dot(sub(p,s.p),s.n);
    case 'cylinder':return norm(perp(sub(p,s.p),s.a))-s.r;
    case 'cone':{const q=sub(p,s.p),rho=norm(perp(q,s.a));return (rho-(s.r+dot(q,s.a)*Math.tan(s.angle)))*Math.cos(s.angle);}
    case 'sphere':return norm(sub(p,s.c))-s.r;
    case 'torus':{const q=sub(p,s.c),rad=perp(q,s.a),rho=norm(rad);if(rho===0)return NaN;
      return norm(sub(q,rad.map(x=>x*s.R/rho)))-s.r;}
  }
  return null;
}

/* Points that must lie inside the face's bounds: its edge vertices, plus 32 points on each closed
 * circle or ellipse edge (a ring edge has no vertices, and a disc or a full cylinder has nothing else). */
function nativePoints(M,face){
  const out=new Set(),pts=[];
  for(const l of face.loops||[])for(const c of l.coedges||[]){
    const e=M.edges.get(c.edge);if(!e)continue;
    if(e.v){for(const v of e.v)if(v!==null)out.add(v);}
    else if(e.curve&&(e.curve.type==='circle'||e.curve.type==='ellipse'))
      for(let k=0;k<32;k++){const p=G.curvePoint(e.curve,k*G.TAU/32);if(p.every(Number.isFinite))pts.push(p);}
  }
  return [...out].map(v=>M.vertices.get(v)).filter(Boolean).map(v=>v.p).concat(pts);
}

/* {ok, inside}: ok is false when a test contradicts the candidate. inside is true when the native face's
 * points lie within the stored bounds, which is positive evidence; it is null when there is nothing to
 * test (no bounds, or a face with no vertices and no ring edge). */
function geometry(M,df,nf){
  let inside=null;
  if(df.bounds){
    const vs=nativePoints(M,nf);
    if(vs.length)inside=vs.every(p=>p.every((x,k)=>x>=df.bounds.min[k]-TOL&&x<=df.bounds.max[k]+TOL));
    if(inside===false)return {ok:false,inside};
  }
  if(df.vertices&&df.vertexCount&&residual(nf.surface,[0,0,0])!==null){
    // median, not max: boundary vertices sit up to 1.2e-4 m off the surface on faces that are
    // certainly the right ones (unique id, Pocket Wheel; EXP-097 saw the same), interior ones do not
    const r=[];for(let i=0;i<df.vertexCount;i++)r.push(Math.abs(residual(nf.surface,[df.vertices[3*i],df.vertices[3*i+1],df.vertices[3*i+2]])));
    r.sort((a,b)=>a-b);
    if(!(r[r.length>>1]<=TOL))return {ok:false,inside};
  }
  return {ok:true,inside};
}

function join(displayFaces,M){
  const byId=new Map();
  for(const f of M.faces){const k=f.displayId!==undefined?f.displayId:f.id;if(!byId.has(k))byId.set(k,[]);byId.get(k).push(f);}
  return displayFaces.map(df=>{
    const rawId=df.metadata&&df.metadata.rawId;
    let c=df.metadata?byId.get(rawId)||[]:[];
    if(!c.length)return {face:null,how:'none',candidates:0};
    if(c.length===1){
      const t=TAG_TYPE[df.metadata.typeTag];
      return t&&c[0].surface.type!==t?{face:null,how:'none',candidates:1}:{face:c[0],how:'id',candidates:1};
    }
    const n=c.length,t=TAG_TYPE[df.metadata.typeTag];
    if(t)c=c.filter(f=>f.surface.type===t);
    if(!c.length)return {face:null,how:'none',candidates:n};
    if(c.length===1)return {face:c[0],how:'type',candidates:n};
    let ok=c.map(f=>({f,...geometry(M,df,f)})).filter(g=>g.ok);
    if(ok.some(g=>g.inside))ok=ok.filter(g=>g.inside);   // a candidate with positive evidence beats ones that can't be tested
    if(ok.length===1)return {face:ok[0].f,how:'geometry',candidates:n};
    return {face:null,how:'ambiguous',candidates:n};
  });
}

return {join,residual,TOL,TAG_TYPE};
});

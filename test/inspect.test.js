'use strict';
/* The B-rep inspector server: starts on a sample, checks the shapes of its JSON endpoints. */
const test=require('node:test'),assert=require('assert/strict'),fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..'),SAMPLE=path.join(ROOT,'samples/sw2022/C04_cube_hole_5mm.SLDPRT');

test('inspect server: page, summary, mesh and face endpoints',async()=>{
  const {start}=require('../src/inspect');
  const {server,url}=await start(SAMPLE,{port:0});
  try{
    const origin=new URL(url).origin;
    const page=await fetch(origin+'/');assert.equal(page.status,200);
    const html=await page.text();assert(/<canvas/.test(html));
    for(const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new (require('vm').Script)(m[1]);
    assert(!/<script[^>]+src=/.test(html),'no external scripts');

    const sum=await (await fetch(origin+'/api/summary')).json();
    assert.equal(sum.counts.faces,7);assert.equal(sum.faces.length,7);
    assert.deepEqual(Object.keys(sum.faces[0]).sort(),['id','node','type']);
    assert.equal(sum.counts.surfaceTypes.plane,6);assert.equal(sum.counts.surfaceTypes.cylinder,1);

    const mesh=await (await fetch(origin+'/api/mesh')).json();
    assert.equal(mesh.displayFaces,7);assert(['exact','partial','none'].includes(mesh.mapping.kind));
    assert.equal(Buffer.from(mesh.pos,'base64').length%12,0);
    assert.equal(Buffer.from(mesh.idx,'base64').length/12,mesh.triangles);
    if(mesh.mapping.kind==='exact')for(const f of mesh.faces)assert(sum.faces.some(x=>x.id===f.brep));

    const cyl=sum.faces.find(f=>f.type==='cylinder'),r=await fetch(origin+'/api/face/'+cyl.id);
    assert.equal(r.status,200);const f=await r.json();
    assert.equal(f.id,cyl.id);assert.equal(f.type,'cylinder');
    assert(Array.isArray(f.vertices));   // a full-circle edge has no vertices
    assert(Array.isArray(f.edges)&&f.edges.some(e=>e.line&&e.line.length>1));
    assert.equal(f.surfaces.length,1);const s=f.surfaces[0];assert(!s.error,s.error);
    const pl=await (await fetch(origin+'/api/face/'+sum.faces.find(x=>x.type==='plane').id)).json();
    assert(pl.vertices.length>0&&pl.vertices[0].p.length===3&&pl.vertices[0].id>0);
    assert(s.pos.length>0&&s.pos.length%3===0&&s.tri.length%3===0&&s.ext.length===s.tri.length/3);
    assert(s.tri.every(i=>i>=0&&i<s.pos.length/3));
    assert.equal(s.extension,false);assert.equal(s.extensionTriangles,0);
    assert(f.bounds.min.length===3&&Array.isArray(f.notEvaluable));

    assert.equal((await fetch(origin+'/api/face/999999')).status,404);
    assert.equal((await fetch(origin+'/api/nope')).status,404);
  }finally{server.close();}
});

test('inspect: B-spline faces get an extension band marked separately',async()=>{
  const {sampleSurface}=require('../src/inspect');
  // a flat bicubic-free patch: degree 1 B-spline, 2x2 control points on the unit square
  const s={type:'bspline',du:1,dv:1,ctrl:[[[0,0,0],[0,1,0]],[[1,0,0],[1,1,0]]],weights:null,ku:[0,0,1,1],kv:[0,0,1,1],uPeriodic:false,vPeriodic:false};
  const r=sampleSurface(s,[]);
  assert(!r.error,r.error);assert(r.extension);
  assert(r.extensionTriangles>0&&r.storedTriangles>0);
  assert.equal(r.ext.filter(x=>x===0).length,r.storedTriangles);
});

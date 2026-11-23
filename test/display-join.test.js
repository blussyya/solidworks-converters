'use strict';
/* Display faces join native faces by the id their own section wrote, then surface type and geometry
 * (src/brep/display-join.js, EXP-104). The corpus cases are the parts where merge() moved ids
 * (a4ecc6f5: a LocalBodies body) or two bodies of one partition share an id (2f121983: id 253). */
const test=require('node:test'),assert=require('assert/strict'),fs=require('fs'),path=require('path');
const S=require('../src'),N=require('../src/brep/native'),P=require('../src/parasolid/partition'),DJ=require('../src/brep/display-join');
const {CORPUS}=require('./helpers/common');

const ROOT=CORPUS&&path.join(CORPUS,'test files online');
const needsOnline={skip:ROOT&&fs.existsSync(ROOT)?false:'no "test files online" in the corpus'};
function file(sha8){
  for(const y of fs.readdirSync(ROOT).filter(d=>/^\d{4}$/.test(d)))for(const f of fs.readdirSync(path.join(ROOT,y)))if(f.startsWith(sha8+'_'))return path.join(ROOT,y,f);
  throw Error('missing online part '+sha8);
}
function load(sha8){const f=file(sha8),d=S.parse(f),M=N.build(S.readBrep(f).parsed),display=d.faces.filter(x=>x.metadata);return {d,M,display,joined:DJ.join(display,M)};}
/* edge ids stored in the display record against the section ids of the native face's edges: no geometry involved */
function sameEdges(M,df,nf){
  const want=new Set(df.metadata.edgeRecords.map(e=>e.id)),got=new Set();
  for(const l of nf.loops)for(const c of l.coedges)got.add(M.edges.get(c.edge).displayId);
  return want.size===got.size&&[...want].every(x=>got.has(x));
}

test('merge keeps each section\'s own node_id beside the shifted one',()=>{
  const sec=()=>({nodes:[{index:1,type:12,values:{highest_node_id:3},pointers:[]},{index:2,type:14,values:{node_id:3},pointers:[]}],unresolved:[]});
  const m=P.merge([sec(),sec()]);
  const faces=m.nodes.filter(n=>n.type===14).map(n=>n.values);
  assert.deepEqual(faces.map(v=>v.section_node_id),[3,3]);
  assert.deepEqual(faces.map(v=>v.node_id),[3,6]);               // unique, as the model builder needs
  assert.deepEqual(faces.map(v=>v.merge_section),[0,1]);
});

test('join: type, geometry and the unmatched cases, on a hand-built model',()=>{
  const plane=z=>({type:'plane',p:[0,0,z],n:[0,0,1],x:[1,0,0]});
  const cyl={type:'cylinder',p:[0,0,0],a:[0,0,1],x:[1,0,0],r:1};
  const nat=(id,displayId,surface)=>({id,displayId,surface,loops:[]});
  const M={faces:[nat(1,5,plane(0)),nat(2,5,cyl),nat(3,5,plane(1)),nat(4,9,plane(0)),nat(5,9,plane(0)),nat(6,7,plane(0))],edges:new Map(),vertices:new Map()};
  const df=(rawId,typeTag,z)=>({vertexCount:3,vertices:new Float32Array([0,0,z,1,0,z,0,1,z]),bounds:null,metadata:{rawId,typeTag}});
  const r=DJ.join([df(5,4002,0),df(5,4001,1),df(9,4001,0),df(7,4001,0),df(8,4001,0),df(7,4002,0)],M);
  assert.deepEqual(r.map(x=>x.how),['type','geometry','ambiguous','id','none','none']);
  assert.equal(r[0].face.id,2);                                    // the cylinder, by its tag
  assert.equal(r[1].face.id,3);                                    // the plane at z = 1: the one at z = 0 is 1 m away
  assert.equal(r[2].face,null);                                    // two identical planes: no honest pick
  assert.equal(r[3].face.id,6);
  assert.equal(r[5].face,null);                                    // id 7 is a plane, the tag says cylinder
});

test('2f121983: id 253 names a cylinder in one body and a plane in another',needsOnline,()=>{
  const {M,display,joined}=load('2f121983');
  assert.equal(display.length,155);
  assert(joined.every(x=>x.face&&x.how!=='ambiguous'));
  assert.equal(new Set(joined.map(x=>x.face)).size,155);          // before: 154 targets, both 253s on the cylinder
  const two=display.map((d,i)=>[d,joined[i].face]).filter(([d])=>d.metadata.rawId===253);
  assert.deepEqual(two.map(([d,f])=>[d.metadata.typeTag,f.surface.type]).sort(),[[4001,'plane'],[4002,'cylinder']]);
  assert.notEqual(two[0][1].body,two[1][1].body);
  assert.notEqual(two[0][1].id,two[1][1].id);                      // the plane's merged id was renumbered
  for(const [d,f] of two)assert(sameEdges(M,d,f));
});

test('a4ecc6f5: LocalBodies faces join through their own ids, ids 2, 31 and 228 reach the right body',needsOnline,()=>{
  const {M,display,joined}=load('a4ecc6f5');
  assert.equal(display.length,961);
  assert(joined.every(x=>x.face));                                 // before: 949 matched, 3 of them to the wrong face
  assert.equal(new Set(joined.map(x=>x.face)).size,961);
  display.forEach((d,i)=>assert(sameEdges(M,d,joined[i].face),'face '+d.metadata.rawId));
  const bodies=new Set();
  for(const id of [2,31,228]){
    const hit=display.map((d,i)=>[d,joined[i].face]).filter(([d])=>d.metadata.rawId===id);
    assert.equal(hit.length,2);assert.notEqual(hit[0][1].body,hit[1][1].body);
    for(const [,f] of hit)bodies.add(f.body);
  }
  assert.equal(bodies.size,2);
});

test('d2515121: 114 bodies, 2,512 display faces; the join agrees with the display\'s edge ids',needsOnline,()=>{
  const {M,display,joined}=load('d2515121');
  const m=joined.filter(x=>x.face);
  assert(m.length>=2500,'matched '+m.length);                       // before: 180
  joined.forEach((x,i)=>{if(x.face)assert(sameEdges(M,display[i],x.face),'face '+display[i].metadata.rawId);});
  assert.equal(new Set(m.map(x=>x.face)).size,m.length);
});

test('a shifted id mostly fails to join (control)',needsOnline,()=>{
  const {M,display}=load('a4ecc6f5');
  const shifted=display.map(d=>({...d,metadata:{...d.metadata,rawId:d.metadata.rawId+1}}));
  const m=DJ.join(shifted,M).filter(x=>x.face);
  assert(m.length<display.length/10,'matched '+m.length+' of '+display.length);
});

test('inspect: the mesh maps 2f121983\'s two id-253 faces to two different B-rep faces',needsOnline,()=>{
  const m=require('../src/inspect').load(file('2f121983')).getMesh();
  assert.equal(m.faces.length,155);
  assert.equal(m.mapping.kind,'exact');                             // before: partial, 154 distinct targets
  assert.equal(new Set(m.faces.map(f=>f.brep)).size,155);
});

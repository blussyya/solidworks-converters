'use strict';
/* B-rep triangulation (src/brep/tessellate.js), the STL source for parts saved without display data.
 * Every mesh must close (each edge used once in each direction) and enclose the exact volume to
 * within what the chord tolerance allows. */
const test=require('node:test'),assert=require('assert/strict'),fs=require('fs'),path=require('path');
const S=require('../src'),N=require('../src/brep/native'),P=require('../src/brep/procedural'),Sp=require('../src/brep/split'),T=require('../src/brep/tessellate'),V=require('../src/brep/volume');
const {CORPUS}=require('./helpers/common');

function run(file,tolerance){
  const R=P.resolve(N.build(S.readBrep(file).parsed));
  return {exact:V.volume(R).volume,check:T.check(T.tessellate(Sp.split(R),{tolerance}))};
}

test('samples close and enclose the exact volume',()=>{
  // relative volume error allowed: planes are exact, curved faces lose chord sag
  const cases=[['sw2022/C00_cube_10mm.SLDPRT',1e-12],['sw2011/C10_cube_shell_1mm.SLDPRT',1e-12],['sw2022/C04_cube_hole_5mm.SLDPRT',2e-3],['sw2022/C15_torus.SLDPRT',5e-3]];
  for(const [f,rel] of cases){
    const {exact,check}=run(path.join(__dirname,'..','samples',f),1e-5);
    assert.equal(check.openEdges,0,f);assert.equal(check.repeatedEdges,0,f);
    assert(Math.abs(check.volume-exact)<=rel*exact,`${f}: ${check.volume} against ${exact}`);
  }
});

test('a finer tolerance gets closer to the exact volume',()=>{
  const f=path.join(__dirname,'..','samples','sw2022','C15_torus.SLDPRT');
  const a=run(f,1e-4),b=run(f,1e-5);
  assert(Math.abs(b.check.volume-b.exact)<Math.abs(a.check.volume-a.exact));
  assert(b.check.triangles>a.check.triangles);
});

const ONLINE=CORPUS&&path.join(CORPUS,'test files online');
test('a part saved without display data still converts to STL',{skip:ONLINE&&fs.existsSync(ONLINE)?false:'no "test files online" in the corpus'},()=>{
  const dir=path.join(ONLINE,'2026'),f=path.join(dir,fs.readdirSync(dir).find(x=>x.startsWith('d889c6fc_')));
  const m=S.meshModel(f);
  assert.match(m.source,/^B-rep tessellation/);assert.equal(m.faceCount,8);
  const stl=S.toSTL(f);assert.equal(stl.length,84+50*m.triangleCount);
});

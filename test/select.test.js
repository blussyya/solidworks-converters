'use strict';
/* Configuration choice from the display (src/parasolid/select.js, EXP-098). Configurations that tie
 * on face count and box are ranked by the display mesh: the SW2011 cubes with a 1 mm fillet and a
 * 1 mm chamfer share every mesh vertex position, and only the normals tell them apart. */
const test=require('node:test'),assert=require('assert/strict'),fs=require('fs'),path=require('path'),zlib=require('zlib');
const P=require('../src/parasolid/partition'),S=require('../src/parasolid/select');
const {CORPUS}=require('./helpers/common');

const DIR=CORPUS&&path.join(CORPUS,'test files new','SW2011');
const needs={skip:DIR&&fs.existsSync(DIR)?false:'no "test files new/SW2011" in the corpus'};
const cube=n=>new Uint8Array(fs.readFileSync(path.join(DIR,n,'model.SLDPRT')));
const iR=b=>zlib.inflateRawSync(b),iZ=b=>zlib.inflateSync(b);

test('a tie on face count and box goes to the shape the display mesh shows',needs,()=>{
  for(const [a,b] of [['C03_cube_fillet_1mm','C09_cube_chamfer_1mm'],['C05_cube_hole_3mm','C04_cube_hole_5mm']]){
    const cands=[a,b].map(name=>({name,parsed:P.readBody(cube(name)).parsed}));
    for(const want of [a,b]){
      const r=S.choose(cube(want),cands,iR,iZ);
      assert.deepEqual(r.matches,[a,b],want);   // the box test alone can't tell them apart
      assert.equal(r.name,want);
    }
  }
});

test('identical candidates keep the lowest',needs,()=>{
  const parsed=P.readBody(cube('C04_cube_hole_5mm')).parsed;
  const r=S.choose(cube('C04_cube_hole_5mm'),[{name:'first',parsed},{name:'second',parsed}],iR,iZ);
  assert.equal(r.name,'first');
});

// EXP-102: a plain cube with a split line fitted a filleted cube's planes when display faces could
// share a B-rep face. Each display face now needs a face of its own.
test('a split-line cube is not read as a filleted one, in either candidate order',needs,()=>{
  const names=['C03_cube_fillet_1mm','C09_cube_chamfer_1mm','C18_cube_split_line'];
  const cands=names.map(name=>({name,parsed:P.readBody(cube(name)).parsed}));
  for(const want of names)for(const order of [cands,[...cands].reverse()])
    assert.equal(S.choose(cube(want),order,iR,iZ).name,want);
});

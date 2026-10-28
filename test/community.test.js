'use strict';
/* Parts the community sent in (dump: "test files new/SW2026", loose files in "test files new/SW2022",
 * and "test files new/re-exports": controlled parts opened and saved again in SolidWorks 2026).
 * A re-export must carry the same body as the part it came from: same vertices to the nanometre,
 * same volume. Skipped when the dump has no re-exports folder. */
const test=require('node:test'),assert=require('assert/strict'),fs=require('fs'),path=require('path');
const S=require('../src');
const {CORPUS}=require('./helpers/common');

const NEW=CORPUS&&path.join(CORPUS,'test files new');
const needs={skip:NEW&&fs.existsSync(path.join(NEW,'re-exports'))?false:'no "test files new/re-exports" in the corpus'};
const vertexSet=f=>[...S.brep.model(S.readBrep(f).parsed).vertices.values()].map(v=>v.p.map(x=>Math.round(x*1e9)).join(',')).sort();

test('re-exports keep the body they were saved from',needs,()=>{
  const pairs=[
    ['test files original/plate4.sldprt','test files new/re-exports/plate4-1997to2026kevinrahhal.sldprt',1997],
    ['test files new/SW2011/C00_cube_10mm/model.SLDPRT','test files new/re-exports/C00_cube_10mm-2011-to-2026/model.SLDPRT',2010],
    ['test files new/SW2011/C01_cube_20mm/model.SLDPRT','test files new/re-exports/C01_cube_20mm-2011-to-2026/model.SLDPRT',2010],
    ['test files new/SW2022/holefillets1-2022-neetn33t.SLDPRT','test files new/re-exports/holefillets1-2022to2026reexport-Furthen64-kevinR.SLDPRT',2022]];
  for(const [a,b,year] of pairs){
    const A=path.join(CORPUS,a),B=path.join(CORPUS,b);
    if(!fs.existsSync(B))continue;
    assert.deepEqual(vertexSet(B),vertexSet(A),b);
    assert.equal(S.volume(B).volume,S.volume(A).volume,b);
    // the 2026 save is the last entry of History, and the first is where the part started
    const h=S.info(B).saved.history;
    assert.equal(h[h.length-1].release,'SolidWorks 2026',b);assert.equal(h[0].date.year,year,b);
    // a re-save writes a new DisplayLists stream
    assert.equal(S.info(B).displayListsVersion,19000,b);
  }
});

test('community parts read: B-rep and display mesh agree',needs,()=>{
  for(const f of [...fs.readdirSync(path.join(NEW,'SW2026')).map(x=>path.join(NEW,'SW2026',x)),...fs.readdirSync(path.join(NEW,'SW2022')).map(x=>path.join(NEW,'SW2022',x))]){
    if(!/\.sldprt$/i.test(f))continue;
    const i=S.info(f);
    assert.equal(i.brep.error,null,f);assert.equal(i.brep.graphErrors,0,f);
    assert.equal(i.display.faces,i.brep.census.FACE,f);
  }
});

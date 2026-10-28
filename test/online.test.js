'use strict';
/* The online sample (dump: "test files online", one folder per save year, 2007-2026), EXP-084.
 * Each case is a layout first seen there: helix nodes, chunked sections, the active configuration,
 * bodies kept in LocalBodies, DisplayLists with no tessellation, cosmetic-thread bands. The last
 * test reads every part's B-rep. Skipped when the dump has no "test files online". */
const test=require('node:test'),assert=require('assert/strict'),fs=require('fs'),path=require('path');
const S=require('../src'),P=require('../src/parasolid/partition');
const {CORPUS}=require('./helpers/common');

const ROOT=CORPUS&&path.join(CORPUS,'test files online');
const needsOnline={skip:ROOT&&fs.existsSync(ROOT)?false:'no "test files online" in the corpus'};
const years=()=>fs.readdirSync(ROOT).filter(d=>/^\d{4}$/.test(d));
/* A part by the sha256 prefix its file name starts with. */
function part(sha8){
  for(const y of years())for(const f of fs.readdirSync(path.join(ROOT,y)))if(f.startsWith(sha8+'_'))return fs.readFileSync(path.join(ROOT,y,f));
  throw Error('missing online part '+sha8);
}
const faces=parsed=>parsed.nodes.filter(n=>n.type===14).length;

test('helix forms: 163 is the surface helix, 184 the curve helix',needsOnline,()=>{
  const {parsed}=P.readBody(part('073482d3'));
  assert.equal(parsed.error,null);
  const by=new Map(parsed.nodes.map(n=>[n.index,n]));
  const su=parsed.nodes.filter(n=>n.type===125&&n.values.analytic_form).map(n=>by.get(n.values.analytic_form));
  const cu=parsed.nodes.filter(n=>n.type===135&&n.values.analytic_form).map(n=>by.get(n.values.analytic_form));
  assert(su.length&&su.every(n=>n.type===163&&n.name==='HELIX_SU_FORM'));
  assert(cu.length&&cu.every(n=>n.type===184&&n.name==='HELIX_CU_FORM'));
  const h=su[0].values;
  assert.equal(h.hand,'+');assert.equal(h.pitch,0.0008);assert.equal(h.gap,null);assert.equal(h.turns[0],0);
  assert(Math.abs(h.turns[1]-13.75)<1e-9);
});

test('a body over 1 MiB is read from its chunks',needsOnline,()=>{
  const r=S.info(part('51f01927'));
  assert.equal(r.brep.error,null);assert.equal(r.brep.graphErrors,0);
  assert.equal(r.brep.census.FACE,428);assert.equal(r.display.faces,428);
  // legacy DisplayLists__ZLB, split the same way
  assert.equal(S.info(part('82981f2a')).display.faces,532);
});

test('the configuration active at save time is the one read',needsOnline,()=>{
  for(const [sha,name,n] of [['c613782b','Contents/Config-3-Partition',13],['03afebf4','Contents/Config-7-Partition',7]]){
    const r=P.readBody(part(sha));
    assert.deepEqual(r.configuration,{name,by:'Header2'},sha);
    assert.equal(faces(r.parsed),n,sha);
  }
});

test('LocalBodies are added unless SolidWorks marks them used up',needsOnline,()=>{
  const r=P.readBody(part('2e6e140a'));
  assert.equal(r.kind,'partition + local');assert.equal(r.parsed.sections,9);
  assert.equal(faces(r.parsed),1117);
  // each section is cut out of a larger model: only its BODY and ATTRIB_DEF chain links dangle
  const by=new Map(r.parsed.nodes.map(n=>[n.index,n]));
  assert.deepEqual([...new Set(r.parsed.unresolved.map(u=>by.get(u.from).name+'.'+u.field))].sort(),['ATTRIB_DEF.next','BODY.next','BODY.previous']);
  assert.equal(S.info(part('2e6e140a')).brep.graphErrors,0);
  // BODY_IN_LIGHTWEIGHT_PERM = 0: a LocalBody a later feature used up is not added again
  const pin=P.readBody(part('6fd68589'));
  assert.equal(pin.kind,'partition');assert.equal(faces(pin.parsed),500);
  // ...and reference sheets in the partition are skipped: 88 + 212 + 244 faces, as drawn
  const d=P.readBody(part('d0d61cde'));
  assert.equal(d.parsed.hidden.length,4);
  assert.equal(require('../src/brep/native').build(d.parsed).faces.length,544);
});

test('DisplayLists without tessellation and cosmetic threads',needsOnline,()=>{
  assert.deepEqual(S.info(part('d889c6fc')).display.errors,['DisplayLists holds no tessellation (saved without display data)']);
  const d=S.info(part('a0ab30c8')).display;
  assert.equal(d.faces,37);assert.equal(d.overlays,4);assert.equal(d.rejected,0);
});

test('every online part: the B-rep reads with no graph failures',needsOnline,t=>{
  let n=0;const bad=[];
  for(const y of years())for(const f of fs.readdirSync(path.join(ROOT,y))){
    const r=S.info(fs.readFileSync(path.join(ROOT,y,f)));n++;
    if(r.brepError||r.brep.error||r.brep.graphErrors)bad.push(`${y}/${f}: ${r.brepError||r.brep.error||r.brep.graphErrors+' graph errors'}`);
  }
  assert.deepEqual(bad,[]);
  t.diagnostic(`${n} parts, ${years().length} save years`);
});

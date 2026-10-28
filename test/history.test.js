'use strict';
/* Which release saved a part (src/container/history.js): the release table, the bundled samples,
 * and every real part in the corpus, whose saves span SolidWorks 97 to 2024. The build dates are
 * the files' own (moDateCodeHistory_c), so each row checks the version against the calendar. */
const test=require('node:test'),assert=require('assert/strict'),path=require('path');
const S=require('../src'),H=require('../src/container/history');
const {CORPUS,needsCorpus}=require('./helpers/common');

test('release codes name the SolidWorks release',()=>{
  const cases={44:'SolidWorks 95',629:'SolidWorks 95+',822:'SolidWorks 98',1500:'SolidWorks 2000',1950:'SolidWorks 2001 Plus',3400:'SolidWorks 2007',
    4400:'SolidWorks 2010',4700:'SolidWorks 2011',5000:'SolidWorks 2012',6000:'SolidWorks 2013',15000:'SolidWorks 2022',19000:'SolidWorks 2026',19100:'SolidWorks 2026+'};
  for(const [v,name] of Object.entries(cases))assert.equal(H.release(+v),name,v);
  assert.equal(H.release(0),null);assert.equal(H.release(12),'before SolidWorks 95');
});

test('samples: SW2011 and SW2022 saves',()=>{
  const at=f=>S.info(path.join(__dirname,'..','samples',f)).saved;
  const a=at('sw2011/C10_cube_shell_1mm.SLDPRT'),b=at('sw2022/C00_cube_10mm.SLDPRT');
  assert.equal(a.version,4700);assert.equal(a.release,'SolidWorks 2011');assert.deepEqual(a.history.map(h=>[h.version,h.date.year,h.created]),[[4700,2010,true]]);
  assert.equal(b.version,15000);assert.equal(b.release,'SolidWorks 2022');assert.deepEqual(b.history.map(h=>[h.version,h.date.year,h.created]),[[15000,2022,true]]);
});

test('real parts: every save, with its build year',needsCorpus,t=>{
  // [file, last-saved version, [version, build year] per History entry]
  const rows=[
    ['plate4.sldprt',629,[[627,1997],[629,1997]]],
    ['SW2000-s01.SLDPRT',1500,[[1500,2000]]],
    ['chainwheel.sldprt',1950,[[1950,2001]]],
    ['usb hub case (ultimate test)/USB hub case TOP.SLDPRT',13000,[[13000,2020]]],
    ['Dekor.SLDPRT',14000,[[14000,2020]]],
    ['cube.SLDPRT',15000,[[15000,2022]]],
    ['Pocket Wheel.SLDPRT',16000,[[16000,2023]]],
    ['distributor main boss rev a.SLDPRT',17000,[[17000,2024]]],
    ['PTC GE8080-8.SLDPRT',17000,[[12000,2019],[14000,2021],[17000,2024]]],
  ];
  for(const [f,v,h] of rows){
    const s=S.info(path.join(CORPUS,'test files original',f)).saved;
    assert.equal(s.error,undefined,f);assert.equal(s.version,v,f);
    assert.deepEqual(s.history.map(e=>[e.version,e.date.year]),h,f);
  }
  const up=S.info(path.join(CORPUS,'test files new/SW2022/C23_cube_sw2011_to_2022/model.SLDPRT')).saved;
  assert.deepEqual(up.history.map(e=>[e.release,e.created]),[['SolidWorks 2011',true],['SolidWorks 2022',false]]);
  t.diagnostic(`${rows.length} real parts, saved from 1997 to 2024`);
});

test('a file that is not a part is reported as one',needsCorpus,()=>{
  const r=S.info(path.join(CORPUS,'test files original/usb hub case (ultimate test)/USB hub case TOP ORIGINAL.STEP'));
  assert.equal(r.container,'not a SolidWorks part');assert.equal(r.saved,undefined);
});

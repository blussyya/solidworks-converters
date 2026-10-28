'use strict';
/* The exact volume against references that don't depend on our own reading (EXP-085).
 *
 * C20 (two r = 5 mm cylinders, 20 mm long, crossed at right angles) has a closed form:
 * 2·π·r²·L − 16·r³/3. SolidWorks' own STEP is 2.1e-8 off it because it writes the four
 * intersection ellipses as B-splines.
 *
 * C16 (a square-to-circle loft) doesn't quite close in the file: the top edges are exact circles,
 * the side patches end on cubics up to 0.83 µm inside them. OpenCascade on either STEP gives a
 * volume that depends on where it happens to centre the integral (1.7e-5 off). The reference is
 * OpenCascade on a watertight rebuild: the four full side patches, the bottom, and a top face
 * bounded by the patches' own top rows. */
const test=require('node:test'),assert=require('assert/strict'),path=require('path');
const S=require('../src'),N=require('../src/brep/native'),P=require('../src/brep/procedural'),V=require('../src/brep/volume');
const {CORPUS,needsCorpus}=require('./helpers/common');
const part=(era,m)=>path.join(CORPUS,'test files new',era,m,'model.SLDPRT');
const resolved=f=>P.resolve(N.build(S.readBrep(f).parsed));

test('crossed cylinders match the closed form',needsCorpus,()=>{
  const r=5,L=20,exact=2*Math.PI*r*r*L-16*r**3/3;
  for(const era of ['SW2011','SW2022']){
    const v=S.volume(part(era,'C20_cylinders_crossed')).volume*1e9;
    assert(Math.abs(v-exact)/exact<1e-13,era+' '+v);
  }
});

test('the loft matches a watertight rebuild and does not depend on the origin',needsCorpus,()=>{
  for(const [era,ref] of [['SW2011',893.819774066],['SW2022',739.806316095]]){
    const R=resolved(part(era,'C16_loft_spline'));
    const a=V.volume(R).volume*1e9,b=V.volume(R,{origin:[0,0.01,0]}).volume*1e9;
    assert(Math.abs(a-ref)/ref<5e-9,era+' '+a);
    assert(Math.abs(a-b)/ref<5e-9,era+' moved '+(b-a));
  }
});

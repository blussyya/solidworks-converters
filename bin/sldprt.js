#!/usr/bin/env node
'use strict';
/**
 * sldprt — command line for the SLDPRT readers. No dependencies; Node 18+.
 *
 *   sldprt info    <model.SLDPRT> [--allow-large-sections] what is in the file
 *   sldprt parse   <model.SLDPRT>                      display mesh as JSON (stdout)
 *   sldprt convert <model.SLDPRT> [--stl F] [--step F] [--ascii] [--mesh|--faceted] [--scale N] [--allow-large-sections]
 *   sldprt brep    <model.SLDPRT> [--json|--nodes] [--volume] [--allow-large-sections] native Parasolid body
 *   sldprt render  <model.SLDPRT> [out.png]            six-view PNG contact sheet
 *   sldprt view    <model.SLDPRT> [--still] [--dark]   interactive terminal viewer
 *   sldprt serve   [--port N] [--host H] [--open]      browser viewer
 */
const fs=require('fs'),path=require('path');

const USAGE=`usage: sldprt <command> [options]

  info    <model.SLDPRT> [--allow-large-sections]
                                            container, streams, versions, counts, B-rep census
  parse   <model.SLDPRT>                    display mesh as JSON on stdout
  convert <model.SLDPRT> [--stl out.stl] [--step out.step] [--ascii] [--mesh|--faceted] [--scale N]
                                            --allow-large-sections bypasses the aggregate section limit
                                            STL and/or STEP; with neither flag both are written
                                            next to the input. STEP is exact, from the B-rep;
                                            --mesh writes it from the display mesh (planes exact,
                                            the rest triangles), --faceted all triangles. --scale
                                            applies to STL and mesh STEP (exact STEP is in mm)
  brep    <model.SLDPRT> [--json | --nodes] [--volume] [--allow-large-sections]
                                            native Parasolid B-rep: node census and graph checks
                                            (--json: summary as JSON, --nodes: every typed node,
                                            --volume: exact volume; --allow-large-sections bypasses
                                            the aggregate section limit for trusted files
  render  <model.SLDPRT> [out.png]          six-view contact sheet of the display mesh
  view    <model.SLDPRT> [--still] [--dark] [--edges|--no-edges]
                                            interactive terminal viewer (truecolor terminal)
  serve   [--port 8080] [--host 127.0.0.1] [--open]
                                            browser viewer at /web/index.html

Formats: modern SLDPRT (SolidWorks 2015+) and SolidWorks 2011 OLE2 parts. See README.md.`;

const json=v=>JSON.stringify(v,(_,x)=>ArrayBuffer.isView(x)?Array.from(x):x);
const opt=(a,name,def)=>{const i=a.indexOf(name);return i>=0&&a[i+1]&&!a[i+1].startsWith('--')?a[i+1]:def;};
const has=(a,name)=>a.indexOf(name)>=0;
function need(a,cmd){if(!a[0]||a[0].startsWith('--')){console.error(`usage: sldprt ${cmd} <model.SLDPRT>`);process.exit(2);}if(!fs.existsSync(a[0])){console.error('no such file: '+a[0]);process.exit(2);}return a[0];}

const commands={
 info(a){
  const S=require('../src'),file=need(a,'info'),opts={allowLargeSections:has(a,'--allow-large-sections')};const r=S.info(file,opts);
  if(has(a,'--json')){console.log(JSON.stringify(r,null,2));return 0;}
  const L=[];
  L.push(`container   ${r.container}, ${r.bytes} bytes${r.containerError?' — '+r.containerError:''}`);
  if(r.saved&&r.saved.version){const s=r.saved,c=s.history.find(h=>h.created),d=h=>h.date?` (build ${h.date.year}/${String(h.date.day).padStart(3,'0')})`:'';
   const last=s.history.length?s.history[s.history.length-1]:null;
   L.push(`saved in    ${s.release}, version ${s.version}${last&&last.version===s.version?d(last):''}`);
   if(c&&c.version!==s.version)L.push(`created in  ${c.release}, version ${c.version}${d(c)}`);
   if(s.error)L.push(`            History not read: ${s.error}`);}
  if(r.displayListsVersion)L.push(`DisplayLists version ${r.displayListsVersion}`);
  if(r.streams)L.push(`streams     ${r.streams.length}`);
  const d=r.display;
  L.push(`display     ${d.errors.length?'not read: '+d.errors.join('; '):`${d.faces} faces, ${d.triangles} triangles (${d.format})`}`);
  if(Object.keys(d.surfaceTags).length)L.push(`surface tags ${Object.entries(d.surfaceTags).map(([k,v])=>`${k}×${v}`).join('  ')}`);
  if(d.rejected)L.push(`            ${d.rejected} candidate face records rejected — output is PARTIAL`);
  if(d.overlays)L.push(`            ${d.overlays} cosmetic thread band${d.overlays>1?'s':''} (drawn over faces, not exported)`);
  if(r.partitions)for(const p of r.partitions)L.push(`partition   ${p.stream}: ${p.sections.join(' + ')||'none'} (${p.chain})`);
  if(r.brep){const c=r.brep.census,pick=['BODY','SHELL','FACE','LOOP','EDGE','VERTEX'].filter(k=>c[k]).map(k=>`${c[k]} ${k.toLowerCase()}`);
   const surf=Object.entries(c).filter(([k])=>/^(PLANE|CYLINDER|CONE|SPHERE|TORUS|B_SURFACE|SWEPT_SURF|BLENDED_EDGE|OFFSET_SURF|SPUN_SURF)$/.test(k)).map(([k,v])=>`${k.toLowerCase()}×${v}`);
   L.push(`B-rep       ${r.brep.error?'not read: '+r.brep.error:`${r.brep.nodes} nodes from ${r.brep.source}: ${pick.join(', ')}`}`);
   if(surf.length)L.push(`surfaces    ${surf.join('  ')}`);
   L.push(`graph checks ${r.brep.graphChecks} run, ${r.brep.graphErrors} failed`);}
  else if(r.brepError)L.push(`B-rep       not read: ${r.brepError}`);
  console.log(L.join('\n'));return r.container==='not a SolidWorks part'?1:0;
 },
 parse(a){
  const S=require('../src');const r=S.parse(need(a,'parse'));
  process.stdout.write(json(r)+'\n');
  return r.errors.length||r.rejected.length?1:0;
 },
 convert(a){
  const file=need(a,'convert'),C=require('../src/convert'),S=require('../src');
  const brepOpts={allowLargeSections:has(a,'--allow-large-sections')};
  const base=file.replace(/\.[^.\/\\]*$/,''),name=path.basename(base);
  const wantStl=has(a,'--stl')||!has(a,'--step'),wantStep=has(a,'--step')||!has(a,'--stl');
  const scale=Number(opt(a,'--scale',String(C.SCALE)));
  if(!Number.isFinite(scale)||scale<=0){console.error('--scale must be a positive number, got '+JSON.stringify(opt(a,'--scale','')));return 2;}
  const mode=has(a,'--faceted')?'faceted':has(a,'--mesh')?'mesh':'exact';
  const out={input:file};let m=null;
  const mesh=()=>{if(m)return m;
   m=S.meshModel(file,brepOpts);out.mesh=m.source;out.faces=m.faceCount;out.triangles=m.triangleCount;return m;};
  if(wantStl){const f=opt(a,'--stl',base+'.converted.stl');
   const buf=has(a,'--ascii')?Buffer.from(C.toSTLAscii(mesh(),{scale,name}),'ascii'):C.toSTLBinary(mesh(),{scale});
   fs.writeFileSync(f,buf);out.stl={file:f,bytes:buf.length,format:has(a,'--ascii')?'ascii':'binary'};}
  if(wantStep){const f=opt(a,'--step',base+'.converted.step');let r;
   if(mode==='exact'){
    try{r=S.toSTEP(file,{name,...brepOpts});}
    catch(e){console.log(JSON.stringify(out,null,2));console.error('exact STEP failed: '+e.message+'\n--mesh or --faceted writes STEP from the display mesh instead');return 1;}
   }else{const x=C.toSTEP(mesh(),{scale,name,mode:mode==='faceted'?'faceted':'auto'});r={text:x.text,report:{mode,...x.report}};}
   fs.writeFileSync(f,r.text);out.step={file:f,bytes:r.text.length,...r.report};}
  console.log(JSON.stringify(out,null,2));return 0;
 },
 brep(a){
  const S=require('../src'),file=need(a,'brep'),opts={allowLargeSections:has(a,'--allow-large-sections')};const r=S.readBrep(file,opts);
  if(has(a,'--nodes')){process.stdout.write(json({source:r.source,kind:r.kind,header:r.parsed.header,error:r.parsed.error,nodes:r.parsed.nodes.map(n=>({type:n.type,name:n.name,index:n.index,values:n.values}))})+'\n');return r.parsed.error?1:0;}
  const sum={source:r.source,kind:r.kind,schema:r.parsed.header&&r.parsed.header.schema,error:r.parsed.error,terminated:r.parsed.terminated,
   nodes:r.parsed.nodes.length,census:S.parasolid.census(r.parsed),graphChecks:r.graph.checks,graphErrors:r.graph.errors,unresolvedPointers:r.parsed.unresolved.length};
  if(has(a,'--json')){console.log(JSON.stringify(sum,null,2));return sum.error||sum.graphErrors.length?1:0;}
  console.log(`source   ${sum.source} (${sum.kind})\nschema   ${sum.schema}\nnodes    ${sum.nodes}${sum.error?'  — stopped: '+sum.error:''}`);
  console.log('census   '+Object.entries(sum.census).map(([k,v])=>`${k}×${v}`).join('  '));
  console.log(`graph    ${sum.graphChecks} checks, ${sum.graphErrors.length} failed${sum.graphErrors.length?':\n  '+sum.graphErrors.slice(0,20).join('\n  '):''}`);
  if(has(a,'--volume')){let v;try{v=S.volume(a[0],opts);}catch(e){v={error:e.message};}
   console.log('volume   '+(v.error?'not computed: '+v.error:v.volume===undefined?'not computed: unsupported '+v.unsupported.join(', '):(v.volume*1e9).toFixed(6)+' mm³ (exact, from the B-rep)'));}
  return sum.error||sum.graphErrors.length?1:0;
 },
 render(a){
  const file=need(a,'render'),R=require('../src/render');
  const out=a[1]&&!a[1].startsWith('--')?a[1]:file.replace(/\.[^.\/\\]*$/,'')+'.sheet.png';
  const s=R.renderSheet(file,out,{});console.log(out);console.log(JSON.stringify(s));return 0;
 },
 view(a){return require('../src/terminal-viewer').main(['node','sldprt view',...a]);},
 serve(a){
  require('../src/serve').start({port:opt(a,'--port','8080'),host:opt(a,'--host','127.0.0.1'),open:has(a,'--open')})
   .then(({url})=>console.log(`\n  SLDPRT viewer  ${url}\n  stop          Ctrl-C\n`))
   .catch(e=>{console.error('cannot listen: '+e.message);process.exit(1);});
  process.on('SIGINT',()=>process.exit(0));
  return null;
 },
};

const [cmd,...rest]=process.argv.slice(2);
if(!cmd||cmd==='-h'||cmd==='--help'||cmd==='help'){console.log(USAGE);process.exit(0);}
if(!commands[cmd]){console.error(`unknown command: ${cmd}\n\n${USAGE}`);process.exit(2);}
let code;
try{code=commands[cmd](rest);}catch(e){console.error(e.message);code=1;}
if(typeof code==='number')process.exitCode=code;

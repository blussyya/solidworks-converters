'use strict';
/**
 * Local server for the B-rep inspector (web/inspect.html).
 *
 *   GET /                 the page
 *   GET /api/summary      faces (id, surface type, node), counts, file name
 *   GET /api/mesh         the saved display mesh, compact (base64 typed arrays), plus whether its
 *                         faces map to B-rep faces
 *   GET /api/face/:id     one B-rep face: its surface sampled on a grid, vertices, edge curves
 *
 * node:http only. The part loads once; everything else is computed on request and cached.
 * Nothing here fits or resolves surfaces (procedural.resolve is far too slow on large parts):
 * what the geometry evaluator cannot evaluate is skipped and reported in `notes`.
 */
const http=require('http'),fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const S=require('./index'),N=require('./brep/native'),G=require('./geom/eval');

const PAGE=path.resolve(__dirname,'..','web','inspect.html');
const TAU=2*Math.PI;
const GRID=28;          // cells per side across the stored patch
const BAND=0.4;         // extension band, as a fraction of the stored span on each side

const fin=x=>typeof x==='number'&&isFinite(x);
const r6=x=>Math.round(x*1e7)/1e7;
const pt=p=>p.map(r6);
const msg=e=>String(e&&e.message||e);

function base(s){while(s&&s.type==='offset'&&s.basis)s=s.basis;return s;}
function extendable(s){return base(s).type==='bspline';}      // B-splines, and offsets of them
function safeRange(s){try{const r=G.surfaceRange(s);return r&&r.every(a=>a.every(fin))?r:null;}catch(e){return null;}}
function evalAt(s,u,v){try{const e=G.surfaceEval(s,u,v);return e&&e.p.every(fin)?e.p:null;}catch(e){return null;}}

/* The smallest arc (start, span) covering a list of angles. */
function arc(angles){
  if(angles.length<2)return [-Math.PI,TAU];
  const a=angles.map(t=>((t%TAU)+TAU)%TAU).sort((x,y)=>x-y);
  let gap=-1,at=0;
  for(let i=0;i<a.length;i++){const g=(i+1<a.length?a[i+1]:a[0]+TAU)-a[i];if(g>gap){gap=g;at=(i+1)%a.length;}}
  const span=TAU-gap;
  return span>TAU*0.97?[-Math.PI,TAU]:[a[at],span];
}

/* (u,v) box for a surface with no stored range, from the points that belong to it. */
function boxFromPoints(s,pts){
  const b=base(s).type,us=[],vs=[];
  for(const p of pts){try{const q=G.surfaceInverse(s,p);if(fin(q.u)&&fin(q.v)){us.push(q.u);vs.push(q.v);}}catch(e){}}
  if(!us.length)return null;
  const ext=a=>Math.max(...a)-Math.min(...a),isAng=['cylinder','cone','sphere','torus','spun'].includes(b),big=isAng?0:Math.max(ext(us),ext(vs));
  const lin=a=>{const lo=Math.min(...a),hi=Math.max(...a),m=Math.max((hi-lo)*0.15,big*0.2,1e-3);return [lo-m,hi+m];};
  let U,V;
  const periodicU=['cylinder','cone','sphere','torus','spun'].includes(b),periodicV=b==='torus';
  if(periodicU){const [a0,sp]=arc(us),m=sp<TAU?sp*0.1:0;U=[a0-m,a0+sp+m];}else U=lin(us);
  if(periodicV){const [a0,sp]=arc(vs),m=sp<TAU?sp*0.1:0;V=[a0-m,a0+sp+m];}else V=lin(vs);
  return [U,V];
}

/* Sample a surface. Returns {pos,tri,ext,range,...} or {error}. `pts` are known points on it. */
function sampleSurface(s,pts){
  const out={type:s.type,node:s.node===undefined?null:s.node};
  if(s.type==='offset')out.offset=s.d;
  let stored=safeRange(s),box,canExt=extendable(s);
  if(s.type==='swept'||s.type==='spun'){
    // one parameter has a stored range, the other is free: the free one comes from the points
    const f=boxFromPoints(s,pts);
    if(stored&&f){stored=s.type==='swept'?[stored[0],f[1]]:[f[0],stored[1]];}
    else if(!stored)stored=f;
    if(stored&&!stored.every(a=>a.every(fin)))stored=f;
    out.rangeNote='one parameter taken from the face\'s own points (surface has no bounded range there)';
  }else if(!stored){
    stored=boxFromPoints(s,pts);
    out.rangeNote=stored?'range taken from the face\'s own points (analytic surface, nothing stored)':null;
  }
  if(!stored)return {...out,error:'no parameter range could be found'};
  box=stored;
  out.range={u:box[0].map(r6),v:box[1].map(r6)};
  const mid=evalAt(s,(box[0][0]+box[0][1])/2,(box[1][0]+box[1][1])/2);
  if(!mid)return {...out,error:'surface type "'+s.type+'" cannot be evaluated here'};
  const [u0,u1]=box[0],[v0,v1]=box[1],du=(u1-u0)/GRID,dv=(v1-v0)/GRID;
  const ku=canExt?Math.ceil(BAND*GRID):0,kv=ku;
  const nu=GRID+2*ku,nv=GRID+2*kv;
  const pos=[],ok=[],idx=new Int32Array((nu+1)*(nv+1)).fill(-1);
  for(let i=0;i<=nu;i++)for(let j=0;j<=nv;j++){
    const p=evalAt(s,u0+(i-ku)*du,v0+(j-kv)*dv);
    if(p){idx[i*(nv+1)+j]=pos.length/3;pos.push(...pt(p));}
  }
  const tri=[],ext=[];let extTris=0,drop=0;
  for(let i=0;i<nu;i++)for(let j=0;j<nv;j++){
    const a=idx[i*(nv+1)+j],b=idx[(i+1)*(nv+1)+j],c=idx[(i+1)*(nv+1)+j+1],d=idx[i*(nv+1)+j+1];
    if(a<0||b<0||c<0||d<0){drop++;continue;}
    const inside=i>=ku&&i<ku+GRID&&j>=kv&&j<kv+GRID,e=inside?0:1;
    tri.push(a,b,c,a,c,d);ext.push(e,e);extTris+=2*e;
  }
  Object.assign(out,{pos,tri,ext,extension:canExt,extensionTriangles:extTris,storedTriangles:ext.length-extTris});
  if(canExt)out.extensionNote='band of '+Math.round(BAND*100)+'% of the stored span on each side, evaluated past the knot range';
  if(drop)out.skippedCells=drop;
  return out;
}

/* Sample an edge curve between its vertices. */
function sampleEdge(e,M){
  const out={id:e.id,type:e.curve&&e.curve.type||null};
  const vs=(e.v||[]).map(id=>M.vertices.get(id)).filter(Boolean),p0=vs[0]&&vs[0].p,p1=vs[1]&&vs[1].p;
  const c=e.curve;
  if(!c){out.line=p0&&p1?[pt(p0),pt(p1)]:null;out.note='no curve stored';return out;}
  const chord=why=>{out.line=p0&&p1&&p0!==p1?[pt(p0),pt(p1)]:null;out.chord=true;out.note=why;return out;};
  try{
    if(c.type==='line'){if(p0&&p1){out.line=[pt(p0),pt(p1)];return out;}return chord('line without two vertices');}
    let t0,t1;
    const R=(()=>{try{return G.curveRange(c);}catch(x){return null;}})();
    if(p0&&p1){t0=G.curveProject(c,p0).t;t1=G.curveProject(c,p1).t;}
    const closed=p0&&p1&&vs[0].id===vs[1].id;
    if(c.type==='circle'||c.type==='ellipse'){
      if(!fin(t0)||closed||!p0){t0=0;t1=TAU;}else if(t1<=t0)t1+=TAU;
    }else if(!(fin(t0)&&fin(t1)&&t1>t0)){
      if(R&&R.every(fin)){t0=R[0];t1=R[1];}
      else if(Array.isArray(c.chart)&&c.chart.length>1){out.line=c.chart.map(pt);out.note='stored chart points only';return out;}
      else return chord('curve type "'+c.type+'" not evaluable; vertex-to-vertex chord shown');
    }
    const n=c.type==='bspline'||c.type==='trimmed'?96:64,line=[];
    for(let i=0;i<=n;i++){const p=G.curvePoint(c,t0+(t1-t0)*i/n);if(!p.every(fin))throw Error('non-finite point');line.push(pt(p));}
    out.line=line;out.range=[r6(t0),r6(t1)];return out;
  }catch(x){
    if(c.chart&&c.chart.length>1){out.line=c.chart.map(pt);out.note='stored chart points only ('+msg(x)+')';return out;}
    return chord('not evaluable ('+msg(x)+'); chord shown');
  }
}

function bounds(arrs){
  const mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity];
  for(const a of arrs)for(let i=0;i<a.length;i+=3)for(let k=0;k<3;k++){const x=a[i+k];if(x<mn[k])mn[k]=x;if(x>mx[k])mx[k]=x;}
  return mn[0]===Infinity?null:{min:mn,max:mx};
}

function load(file,opts){
  const t0=Date.now(),B=S.readBrep(file,opts||{}),M=N.build(B.parsed);
  const byId=new Map(M.faces.map(f=>[f.id,f])),cache=new Map();
  const model={file,name:path.basename(file),M,byId,cache,loadMs:Date.now()-t0,mesh:null,meshError:null};

  model.summary=()=>{
    const types={};for(const f of M.faces)types[f.surface.type]=(types[f.surface.type]||0)+1;
    return {file:model.name,loadMs:model.loadMs,
      counts:{faces:M.faces.length,edges:M.edges.size,vertices:M.vertices.size,surfaceTypes:types},
      faces:M.faces.map(f=>({id:f.id,type:f.surface.type,node:f.surface.node===undefined?null:f.surface.node}))};
  };

  model.getMesh=()=>{
    if(model.mesh||model.meshError)return model.mesh||{error:model.meshError};
    let d;try{d=S.parse(file);}catch(e){model.meshError=msg(e);return {error:model.meshError};}
    const faces=d.faces||[];let nv=0,nt=0;
    for(const f of faces){nv+=f.vertices.length;nt+=f.triangleIndices.length;}
    const pos=new Float32Array(nv),idx=new Uint32Array(nt),meta=[];let vo=0,io=0,matched=0;
    for(const f of faces){
      const base=vo/3;pos.set(f.vertices,vo);vo+=f.vertices.length;
      for(let i=0;i<f.triangleIndices.length;i++)idx[io+i]=f.triangleIndices[i]+base;
      // The saved mesh only names a B-rep face when the record carries an id that exists in the body
      const rid=f.metadata&&f.metadata.rawId,brep=byId.has(rid)?rid:null;if(brep!==null)matched++;
      meta.push({brep,first:io/3,count:f.triangleIndices.length/3});io+=f.triangleIndices.length;
    }
    const used=new Set(meta.map(m=>m.brep).filter(x=>x!==null));
    const mapping=matched===faces.length&&faces.length>0&&used.size===matched
      ?{kind:'exact',note:'each display face carries a B-rep face id that exists in the body'}
      :matched>0?{kind:'partial',note:matched+' of '+faces.length+' display faces carry a B-rep face id; the rest are not selectable'}
      :{kind:'none',note:'this file\'s display faces carry no B-rep face id; clicking the mesh cannot select a B-rep face'};
    model.mesh={format:d.format,mapping,displayFaces:faces.length,brepFaces:M.faces.length,triangles:nt/3,
      faces:meta,pos:Buffer.from(pos.buffer).toString('base64'),idx:Buffer.from(idx.buffer).toString('base64'),
      bounds:bounds([pos])};
    return model.mesh;
  };

  model.getFace=id=>{
    if(cache.has(id))return cache.get(id);
    const f=byId.get(id);if(!f)return null;
    const s=f.surface,notes=[],notEval=[],surfaces=[];
    // face vertices and edges, through its loops
    const edgeIds=new Set(),vIds=new Set();
    for(const l of f.loops||[])for(const c of l.coedges||[])edgeIds.add(c.edge);
    const edges=[];
    for(const eid of edgeIds){const e=M.edges.get(eid);if(!e){notEval.push('edge '+eid+' missing');continue;}
      for(const v of e.v||[])vIds.add(v);const se=sampleEdge(e,M);edges.push(se);if(se.chord||!se.line)notEval.push('edge '+eid+': '+se.note);}
    const vertices=[...vIds].map(v=>M.vertices.get(v)).filter(Boolean).map(v=>({id:v.id,p:pt(v.p)}));
    const own=vertices.map(v=>v.p);for(const e of edges)if(e.line&&!e.chord)own.push(...e.line);   // ring edges have no vertices: their curve points place the face
    const out={id:f.id,type:s.type,node:s.node===undefined?null:s.node,sameSense:f.sameSense,
      counts:{loops:(f.loops||[]).length,edges:edges.length,vertices:vertices.length},vertices,edges,surfaces,notes,notEvaluable:notEval};
    if(s.type==='blend'){
      let sp=s.spine,spineInfo=null;
      out.blend={blendType:s.blendType||null,range:s.range||null,supports:(s.surfaces||[]).map(x=>({type:x.type,node:x.node===undefined?null:x.node,offset:x.d}))};
      notes.push('The blend surface itself cannot be evaluated here (no fitting is done). Its spine\'s surfaces are shown instead.');
      notEval.push('blend surface (node '+(s.node===undefined?'?':s.node)+')');
      if(sp&&sp.type==='trimmed'&&sp.basis){notes.push('spine is a trimmed curve; its basis is used');sp=sp.basis;}
      if(sp){
        spineInfo={type:sp.type,node:sp.node===undefined?null:sp.node};
        const chart=Array.isArray(sp.chart)?sp.chart.filter(p=>Array.isArray(p)&&p.every(fin)):[];
        const ends={};for(const k of ['start','end'])if(sp[k]&&sp[k].p&&sp[k].p.every(fin))ends[k]=pt(sp[k].p);
        out.chart=chart.map(pt);out.spine=Object.assign(spineInfo,{ends,chartPoints:chart.length,chordalError:sp.chordalError===undefined?null:sp.chordalError});
        const known=[...chart,...Object.values(ends),...own];
        (sp.surfaces||[]).forEach((ss,i)=>{
          const r=sampleSurface(ss,known);r.role='spine surface '+(i+1);surfaces.push(r);
          if(r.error)notEval.push(r.role+' (node '+r.node+', '+r.type+'): '+r.error);
        });
        if(!sp.surfaces||!sp.surfaces.length)notes.push('spine type "'+sp.type+'" has no surfaces to show');
        if(!chart.length)notes.push('spine has no stored chart points');
      }else notes.push('this blend has no spine');
      // the blend's own support surfaces, for reference
    }else{
      const r=sampleSurface(s,own);r.role='face surface';surfaces.push(r);
      if(r.error)notEval.push('face surface ('+r.type+'): '+r.error);
    }
    const clouds=[];
    for(const x of surfaces)if(x.pos)clouds.push(x.pos);
    clouds.push(own.flat());if(out.chart)clouds.push(out.chart.flat());
    for(const e of edges)if(e.line)clouds.push(e.line.flat());
    if(out.spine)clouds.push(Object.values(out.spine.ends).flat());
    out.bounds=bounds(clouds);
    cache.set(id,out);return out;
  };
  return model;
}

function sendJSON(res,code,obj){
  const body=JSON.stringify(obj);
  res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(body);
}

/* start(file, {port=8081, host='127.0.0.1', open=false}) -> Promise<{server, url, model}> */
function start(file,opts){
  opts=opts||{};
  const host=opts.host||'127.0.0.1',model=load(file,{allowLargeSections:!!opts.allowLargeSections});
  const server=http.createServer((req,res)=>{
    let p;try{p=decodeURIComponent(new URL(req.url,'http://x').pathname);}catch(e){res.writeHead(400);return res.end('Bad request');}
    try{
      if(p==='/'||p==='/inspect.html'||p==='/web/inspect.html'){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(fs.readFileSync(PAGE));}
      if(p==='/favicon.ico'){res.writeHead(204);return res.end();}
      if(p==='/api/summary')return sendJSON(res,200,model.summary());
      if(p==='/api/mesh'){const m=model.getMesh();return sendJSON(res,m.error?500:200,m);}
      let m=/^\/api\/face\/(\d+)$/.exec(p);
      if(m){const f=model.getFace(Number(m[1]));return f?sendJSON(res,200,f):sendJSON(res,404,{error:'no face '+m[1]});}
      sendJSON(res,404,{error:'not found: '+p});
    }catch(e){sendJSON(res,500,{error:msg(e)});}
  });
  const port0=opts.port===undefined||opts.port===null||opts.port===''?8081:Number(opts.port);
  if(!Number.isInteger(port0)||port0<0||port0>65535)return Promise.reject(Error('invalid port '+opts.port));
  return new Promise((resolve,reject)=>{
    const listen=(port,n)=>{
      server.once('error',e=>{if(e.code==='EADDRINUSE'&&port!==0&&n<12)return listen(port+1,n+1);reject(e);});
      server.listen(port,host,()=>{
        const url='http://'+(host==='0.0.0.0'?'localhost':host)+':'+server.address().port+'/';
        if(opts.open){const c=process.platform==='win32'?spawn('cmd',['/c','start','',url],{detached:true,stdio:'ignore'})
          :spawn(process.platform==='darwin'?'open':'xdg-open',[url],{detached:true,stdio:'ignore'});c.on('error',()=>{});c.unref();}
        resolve({server,url,model});
      });
    };
    listen(port0,0);
  });
}

module.exports={start,load,sampleSurface,sampleEdge};

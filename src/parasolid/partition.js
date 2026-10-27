/* Parasolid partition streams inside a SLDPRT: section framing and body selection.
 *
 * Section frame (EXP-074; 242/242 sections, 70/70 Partition and 65/65 GhostPartition streams
 * chain exactly to their end):
 *
 *   u32le size | GUID 231dd571-da81-48a2-a858-98b21b89ef99 | chunks | 8 zero bytes
 *   chunk = u32le inflated | u32le compressed | zlib[compressed]
 *
 * The payload is the chunks' output joined. Most sections have one chunk (so size = compressed
 * + 32); a body over 1 MiB is a 1 MiB chunk followed by more, either 4 KiB ones or one remainder
 * (EXP-084: 1,142,601 bytes in 24 chunks, 1,863,177 bytes in 2).
 *
 * Config-N-Partition      = "(partition)" section, then a "(deltas)" section
 * Config-N-GhostPartition = one "(partition)" section
 * Config-0-FeatureBodies/LocalBodies (imported bodies) and Config-N-ResolvedFeatures carry the
 * same frame after a stream-specific prefix.
 *
 * Configuration: N is the one that was active when the file was saved. Header2 is a copy of that
 * configuration's Config-N-ModelHeader (after a rename only the document name differs), so N is the
 * ModelHeader closest to Header2 (EXP-084: Config-3 of 0-3, Config-7 of 1 and 7). Files without
 * ModelHeaders (before about SW2020) get the lowest N; in the corpus their configurations all have
 * the same face count, but that does not make them the same shape.
 *
 * Bodies: the first section of Config-N-Partition, plus the bodies in
 * Config-N-FeatureBodies/LocalBodies (imported, one per section). Of all of them, the ones whose
 * BODY_IN_LIGHTWEIGHT_PERM attribute is 0 aren't part of the finished part: LocalBodies a later
 * feature used up, and sheets kept for reference. Those LocalBodies are left out, and partition
 * bodies are listed in `parsed.hidden` for the model builder to skip. 187 of 188 parts then match
 * their display face count. Last resort: the first section with faces in any other GUID-bearing
 * stream.
 *
 * Isomorphic: takes a Uint8Array (a Node Buffer is one) and loads in Node and as a plain browser
 * script (global SLDPRTPartition, after src/inflate.js, src/container/*.js and xt.js). Node
 * decompresses with zlib, the browser with src/inflate.js; pass {inflateRaw, inflate} as the
 * last argument to use another. Logic moved from the EXP-072 extractor and EXP-074 section walker.
 */
(function(root,factory){
  if(typeof module==='object'&&module.exports){
    const zlib=require('zlib'),MAX=128*1024*1024;
    module.exports=factory(require('../container/modern'),require('../container/ole'),require('./xt'),
      {inflateRaw:b=>zlib.inflateRawSync(b,{maxOutputLength:MAX}),inflate:b=>zlib.inflateSync(b,{maxOutputLength:MAX})},
      require('../container/blast'));
  }else root.SLDPRTPartition=factory(root.SLDPRTModern,root.SLDPRTOLE,root.SLDPRTXT,root.SLDPRTInflate,root.SLDPRTBlast);
})(typeof self!=='undefined'?self:this,function(modern,OLE,xt,defaultCodec,Blast){
'use strict';
const {parse}=xt;
const MAX=128*1024*1024;
const GUID=new Uint8Array([0x23,0x1d,0xd5,0x71,0xda,0x81,0x48,0xa2,0xa8,0x58,0x98,0xb2,0x1b,0x89,0xef,0x99]);
const GUID_HEX='231dd571da8148a2a85898b21b89ef99';
const u8=b=>b instanceof Uint8Array?b:new Uint8Array(b);
const u32=(b,at)=>(b[at]|b[at+1]<<8|b[at+2]<<16|b[at+3]<<24)>>>0;
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const latin1=b=>{let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode.apply(null,b.subarray(i,Math.min(b.length,i+8192)));return s;};
/* first index of `pat` in b at or after `from`, or -1 */
function find(b,pat,from){
  for(let i=b.indexOf(pat[0],from||0);i>=0&&i+pat.length<=b.length;i=b.indexOf(pat[0],i+1)){
    let k=1;while(k<pat.length&&b[i+k]===pat[k])k++;if(k===pat.length)return i;}
  return -1;
}
const isGuid=(b,at)=>at>=0&&at+16<=b.length&&find(b.subarray(at,at+16),GUID,0)===0;

/* Every named stream as {name: Uint8Array}, for either container. */
function streams(raw,codec){
  raw=u8(raw);codec=codec||defaultCodec;
  if(modern.isOLE2(raw)){
    const o=OLE.read(raw),out={};
    for(const e of o.entries)try{out[e.name]=u8(o.stream(e));}catch(_){/* storage entries */}
    return out;
  }
  const s=modern.decompressOpenSX(raw,codec.inflateRaw,codec.inflate),out={};
  for(const k of Object.keys(s))out[k]=u8(s[k]);
  return out;
}

/* The chunks of the section at `pos` (size already read), joined. Throws on a bad frame. */
function payload(b,pos,size,codec){
  const end=pos+4+size-8,parts=[];let p=pos+20,total=0;
  if(end>b.length||end<p)throw Error('size');
  while(p<end){
    if(p+8>end)throw Error('chunk header');
    const inflated=u32(b,p),compressed=u32(b,p+4);
    if(!compressed||p+8+compressed>end)throw Error('chunk length');
    let z;try{z=u8(codec.inflate(b.subarray(p+8,p+8+compressed)));}catch(_){throw Error('zlib');}
    if(z.length!==inflated)throw Error('inflated length');
    parts.push(z);total+=z.length;p+=8+compressed;
  }
  for(let i=end;i<end+8;i++)if(b[i]!==0)throw Error('tail not zero');
  if(parts.length===1)return parts[0];
  const out=new Uint8Array(total);let at=0;for(const z of parts){out.set(z,at);at+=z.length;}return out;
}

/* Walk a chain of sections starting at `pos`. Stops with `error` at the first frame that does not
 * validate; the sections read so far are returned. */
function sections(b,pos,codec){
  b=u8(b);codec=codec||defaultCodec;
  const out=[];
  while(pos<b.length){
    if(pos+28>b.length)return {out,error:`leftover ${b.length-pos}`};
    const size=u32(b,pos);
    if(!isGuid(b,pos+4))return {out,error:'guid'};
    let body;try{body=payload(b,pos,size,codec);}catch(e){return {out,error:e.message};}
    const head=latin1(body.subarray(0,64));
    const kind=(head.match(/TRANSMIT FILE(?: \((\w+)\))?/)||[])[1]||(/TRANSMIT FILE/.test(head)?'plain':'?');
    out.push({start:pos,kind,body,tail:hex(b.subarray(pos+4+size-8,pos+4+size))});
    pos+=4+size;
  }
  return {out,error:null};
}

/* Config-N-Partition stream names, configuration 0 first, then ascending. */
function partitionNames(names){
  const n=k=>+/Config-(\d+)-Partition$/.exec(k)[1];
  return names.filter(k=>/(?:^|\/)Config-\d+-Partition$/.test(k)).sort((a,b)=>n(a)-n(b));
}

/* Bytes shared at both ends, as a share of the longer one. */
function closeness(a,b){
  let p=0,q=0;const n=Math.min(a.length,b.length);
  while(p<n&&a[p]===b[p])p++;
  while(q<n-p&&a[a.length-1-q]===b[b.length-1-q])q++;
  return (p+q)/Math.max(a.length,b.length,1);
}

/* The partition of the configuration active at save time: the one whose ModelHeader is closest to
 * Header2, else the lowest N. */
function activePartition(s,candidates){
  const h=s.Header2;let best=null,score=0;
  if(h)for(const name of candidates){
    const m=s[name.replace(/Partition$/,'ModelHeader')];if(!m)continue;
    const c=closeness(u8(m),u8(h));if(c>score){score=c;best=name;}
  }
  return {name:best||candidates[0],by:best?'Header2':'lowest'};
}

/* The first payload of the saved configuration's partition, as the EXP-072 extractor reads it. */
function extractPrimary(raw,all,codec){
  raw=u8(raw);codec=codec||defaultCodec;
  const s=all||streams(raw,codec),candidates=partitionNames(Object.keys(s));
  if(!candidates.length)throw Error('No Config-N-Partition stream');
  const {name,by}=activePartition(s,candidates),stream=s[name];
  if(hex(stream.subarray(4,20))!==GUID_HEX)throw Error(name+' does not start with the section GUID');
  const size=u32(stream,0);
  return {name,stream,candidates,chosenBy:by,inner:payload(stream,0,size,codec),compressedBytes:size-32};
}

/* Summary of every partition-bearing stream: section kinds, chain status. For `sldprt info`. */
function survey(raw,all,codec){
  all=all||streams(raw,codec);const rows=[];
  for(const [k,b] of Object.entries(all)){
    const g=find(b,GUID,0);if(g<4)continue;
    if(/Partition$/.test(k)){const w=sections(b,g-4,codec);rows.push({stream:k,bytes:b.length,prefix:g-4,sections:w.out.map(x=>({offset:x.start,kind:x.kind,bytes:x.body.length})),chain:w.error?'broken: '+w.error:'complete'});}
    else{
      const found=[];
      for(let h=g;h>=4;h=find(b,GUID,h+1)){
        const w=sections(b.subarray(0,h-4+4+u32(b,h-4)),h-4,codec);
        if(w.error||w.out.length!==1)continue;
        found.push({offset:w.out[0].start,kind:w.out[0].kind,bytes:w.out[0].body.length});
      }
      rows.push({stream:k,bytes:b.length,prefix:g-4,sections:found,chain:'embedded'});
    }
  }
  return rows;
}

/* Pre-2011 files (EXP-077) have no Config-N-Partition. Their body is one of:
 *   Config-N-Body   u32le compressed length | PKWARE DCL implode   -> neutral binary "PS" transmit
 *                   (chainwheel: Parasolid 13, schema 13006 itself, no edit scripts)
 *   <config name>   u32le length | bare binary transmit, little-endian, starting "B"
 *                   (plate4: stream "Default", Parasolid 9, schema 9008)
 * A part with no solid (SW2000-s01: planes and origin only) has neither. */
function legacyBody(all){
  for(const [k,b] of Object.entries(all)){
    if(b.length<8||u32(b,0)!==b.length-4)continue;
    if(/^Config-\d+-Body$/.test(k)){const inner=u8(Blast.blast(b.subarray(4),{maxOutput:MAX}).data);if(latin1(inner.subarray(0,4))==='PS\0\0')return {name:k,inner,kind:'body (PKWARE implode)'};}
    else if(b[4]===66&&/^: TRANSMIT FILE/.test(latin1(b.subarray(9,24))))return {name:k,inner:b.subarray(4),kind:'body (bare binary)'};
  }
  return null;
}

/* The saved solid body, parsed. Returns {source, kind, parsed}; throws if no body exists. */
/* BODY index -> its BODY_IN_LIGHTWEIGHT_PERM value. SolidWorks sets it to 0 on a body that isn't
 * part of the finished part: an imported body a later feature used up, a surface body kept for
 * reference. 187 of 188 parts' display face counts agree (EXP-084). Bodies without it count as in. */
function inPart(q){
  const by=new Map(q.nodes.map(n=>[n.index,n])),out=new Map();
  const name=d=>{const n=by.get(d)&&by.get(by.get(d).values.identifier);if(!n)return '';const v=n.values.string;return Array.isArray(v)?v.join(''):v;};
  for(const a of q.nodes){
    if(a.type!==81||by.get(a.values.owner)?.type!==12||name(a.values.definition)!=='BODY_IN_LIGHTWEIGHT_PERM')continue;
    const v=(a.values.fields||[]).map(i=>by.get(i)).find(n=>n&&n.type===82);
    if(v)out.set(a.values.owner,v.values.values[0]);
  }
  return out;
}

/* Every section in a stream that has other data between its sections (LocalBodies). */
function embedded(b,codec){
  const out=[];
  for(let g=find(b,GUID,0);g>=4;g=find(b,GUID,g+1)){
    const end=g-4+4+u32(b,g-4);if(end>b.length)continue;
    const w=sections(b.subarray(0,end),g-4,codec);if(!w.error&&w.out.length===1)out.push(w.out[0]);
  }
  return out;
}

/* Several parse results as one: each later one's node indices and pointers moved past the
 * previous maximum. Pointer fields hold only node indices (0 = null), so they shift as a whole.
 * node_ids are moved the same way, because each section numbers its own from 1 and the model
 * builder keys faces and edges by them. */
function merge(parts){
  const out={...parts[0],nodes:[...parts[0].nodes],unresolved:[...parts[0].unresolved],sections:parts.length};
  for(const q of parts.slice(1)){
    const off=out.nodes.reduce((m,n)=>Math.max(m,n.index),0),sh=i=>i?i+off:i;
    const idOff=out.nodes.reduce((m,n)=>Math.max(m,typeof n.values.node_id==='number'?n.values.node_id:0,typeof n.values.highest_node_id==='number'?n.values.highest_node_id:0),0);
    for(const n of q.nodes){
      const values={...n.values};
      if(typeof values.node_id==='number')values.node_id+=idOff;
      if(typeof values.highest_node_id==='number')values.highest_node_id+=idOff;
      for(const f of new Set(n.pointers.map(p=>p.field)))values[f]=Array.isArray(values[f])?values[f].map(sh):sh(values[f]);
      out.nodes.push({...n,index:n.index+off,values,pointers:n.pointers.map(p=>({...p,target:p.target+off}))});
    }
    out.unresolved.push(...q.unresolved.map(u=>({...u,from:u.from+off,target:u.target+off})));
  }
  return out;
}

function readBody(raw,options={},codec){
  raw=u8(raw);codec=codec||options.codec||defaultCodec;
  const all=streams(raw,codec);
  if(modern.isOLE2(raw)&&!partitionNames(Object.keys(all)).length){
    const l=legacyBody(all);
    if(!l)throw Error('No Parasolid body: no Config-N-Partition, Config-N-Body or transmit stream (a part with no solid has none)');
    return {source:l.name,kind:l.kind,parsed:parse(l.inner,true,options)};
  }
  const primary=extractPrimary(raw,all,codec);
  let parsed=parse(primary.inner,true,options),source=primary.name,kind='partition';
  const local=all[primary.name.replace(/^(?:Contents\/)?(Config-\d+)-Partition$/,'$1-FeatureBodies/LocalBodies')];
  if(!parsed.error){
    const hidden=[...inPart(parsed)].filter(([,v])=>v===0).map(([b])=>b);
    const bodies=local?embedded(local,codec).map(x=>parse(x.body,true,options)).filter(q=>!q.error&&q.nodes.some(n=>n.type===14)&&![...inPart(q).values()].includes(0)):[];
    if(bodies.length){parsed=merge([parsed,...bodies]);source=primary.name+' + '+bodies.length+' LocalBodies';kind='partition + local';}
    if(hidden.length)parsed={...parsed,hidden};
  }
  if(!parsed.error&&!parsed.nodes.some(n=>n.type===14)){
    for(const [k,b] of Object.entries(all)){
      const g=find(b,GUID,0);if(g<4||/Partition$/.test(k))continue;
      for(const x of sections(b,g-4,codec).out){
        const q=parse(x.body,true,options);
        if(!q.error&&q.nodes.some(n=>n.type===14)){parsed=q;source=k;kind=x.kind;break;}
      }
      if(source!==primary.name)break;
    }
  }
  return {source,kind,parsed,partitions:primary.candidates,configuration:{name:primary.name,by:primary.chosenBy}};
}

return {GUID,streams,sections,extractPrimary,survey,legacyBody,readBody};
});

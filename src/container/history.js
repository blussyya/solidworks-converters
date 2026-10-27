/* Which SolidWorks release saved a part. No external dependencies.
 *
 *   saved(names, get) -> {version, release, history:[{version, release, date, created}], error?}
 *
 * names are the container's stream names, get(name) returns a stream's bytes. The last-saved
 * version is in the name of the _MO_VERSION_<n> stream (modern: a path prefix, OLE2: an empty
 * stream). The History stream (moVersionHistory_c, EXP-080) lists every release that saved the
 * file: u32 count, then per save u32, u16, u32 unix time, a string, u32 version and a
 * moDateCodeHistory_c (u32 1, u32 whose low 24 bits are the build date YYYYDDD and whose top
 * byte is 1 on the release that created the file).
 *
 * Release codes are SolidWorks' own (API help, VersionHistory): one per major release, 1000 per
 * year from 2013. A code between two rows is a release we have no row for; it is reported as the
 * row below it with a '+'.
 */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.SLDPRTHistory=factory();
})(typeof self!=='undefined'?self:this,function(){
  'use strict';
  const ROWS=[[44,'SolidWorks 95'],[822,'SolidWorks 98'],[1500,'SolidWorks 2000'],[1750,'SolidWorks 2001'],[1950,'SolidWorks 2001 Plus'],
    [2200,'SolidWorks 2003'],[3400,'SolidWorks 2007'],[3800,'SolidWorks 2008'],[4100,'SolidWorks 2009'],[4400,'SolidWorks 2010'],
    [4700,'SolidWorks 2011'],[5000,'SolidWorks 2012']];
  function release(v){
    if(!Number.isInteger(v)||v<=0)return null;
    if(v>=6000)return 'SolidWorks '+(2007+Math.floor(v/1000))+(v%1000?'+':'');
    let r=null;for(const [code,name] of ROWS)if(v>=code)r=v===code?name:name+'+';
    return r||'before SolidWorks 95';
  }
  function parseHistory(b){
    const d=new DataView(b.buffer,b.byteOffset,b.byteLength);let o=0;
    const need=n=>{if(o+n>b.length)throw Error('History truncated at byte '+o);};
    const u8=()=>(need(1),b[o++]),u16=()=>(need(2),o+=2,d.getUint16(o-2,true)),u32=()=>(need(4),o+=4,d.getUint32(o-4,true));
    function object(){const t=u16();if(t!==0xffff){if(!(t&0x8000))throw Error('History: expected a class at byte '+(o-2));return;}u16();const n=u16();need(n);o+=n;}
    // UTF-16 behind ff fe ff and a u8 count; files before 2001 (SW2000-s01) have a u8 count of 8-bit chars
    function string(){let n=u8(),s='';if(n===0xff){if(u16()!==0xfffe)throw Error('History: expected a string at byte '+o);n=u8();need(2*n);for(let i=0;i<n;i++)s+=String.fromCharCode(u16());}else{need(n);for(let i=0;i<n;i++)s+=String.fromCharCode(b[o++]);}return s;}
    object();const n=u32(),out=[];if(n>1000)throw Error('History: '+n+' entries');
    for(let i=0;i<n;i++){
      // the date codes are a counted list: one per save in every file but plate4 (SW97, two)
      u32();u16();const time=u32(),comment=string(),version=u32();object();const k=u32();if(k>100)throw Error('History: '+k+' date codes');
      const w=[];for(let j=0;j<k;j++)w.push(u32());const code=k?w[k-1]&0xffffff:0;
      out.push({version,release:release(version),date:code?{year:Math.floor(code/1000),day:code%1000}:null,created:k>0&&(w[0]>>>24)===1,time:time?new Date(time*1000).toISOString():null,comment});
    }
    return out;
  }
  function saved(names,get){
    const out={version:null,release:null,history:[]};
    for(const s of names){const m=/(?:^|\/)_MO_VERSION_(\d+)(?:\/|$)/.exec(s);if(m)out.version=Math.max(out.version||0,+m[1]);}
    out.release=release(out.version);
    const h=names.find(s=>/(?:^|\/)History$/.test(s));
    if(h)try{out.history=parseHistory(get(h));}catch(e){out.error=e.message;}
    return out;
  }
  return {saved,release,parseHistory};
});

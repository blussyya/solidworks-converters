'use strict';
/* The modern container's directory (src/container/modern.js readDirectory) on the bundled
 * samples: it finds every stream the scan finds, rejects a damaged record, and the reader falls
 * back to the scan when the directory is gone. */
const test=require('node:test'),assert=require('assert/strict'),fs=require('fs'),path=require('path'),zlib=require('zlib');
const modern=require('../src/container/modern');
const iR=b=>zlib.inflateRawSync(b),iZ=b=>zlib.inflateSync(b);
const dir=path.join(__dirname,'..','samples','sw2022');
const files=fs.readdirSync(dir).filter(f=>/\.sldprt$/i.test(f)).map(f=>path.join(dir,f));

test('the directory lists the same streams as the scan, in the same order',t=>{
  let streams=0;
  for(const f of files){
    const b=fs.readFileSync(f),entries=modern.readDirectory(b);
    assert(entries&&entries.length,f);
    const a=modern.decompressOpenSX(b,iR,iZ),s=modern.scanOpenSX(b,iR,iZ);
    assert.deepEqual(Object.keys(a),Object.keys(s),f);
    for(const k of Object.keys(a))assert(Buffer.from(a[k]).equals(Buffer.from(s[k])),f+' '+k);
    assert.deepEqual(entries.filter(e=>e.size>0).map(e=>e.name),Object.keys(s),f);
    for(let i=1;i<entries.length;i++)assert(entries[i].header>entries[i-1].header,f);
    streams+=entries.length;
  }
  t.diagnostic(`${files.length} files, ${streams} directory entries`);
});

test('a damaged directory record is rejected and the scan takes over',()=>{
  const b=Buffer.from(fs.readFileSync(files[0])),entries=modern.readDirectory(b);
  // find the first central record: it holds the first entry's name a second time
  const h=entries[0].header,nameLen=entries[0].name.length,name=b.subarray(h+30,h+30+nameLen);
  const rec=b.indexOf(name,h+30+nameLen+entries[0].compSize)-46;
  assert(rec>0);
  const bad=Buffer.from(b);bad[rec+16]^=1;                 // the CRC in the first central record
  assert.equal(modern.readDirectory(bad),null);
  assert.deepEqual(Object.keys(modern.decompressOpenSX(bad,iR,iZ)),Object.keys(modern.scanOpenSX(b,iR,iZ)));
});

test('a stream that fails its CRC stops the read',()=>{
  const b=Buffer.from(fs.readFileSync(files[0])),e=modern.readDirectory(b).find(e=>e.compSize>64);
  b[e.dataStart+(e.compSize>>1)]^=0x10;
  assert.throws(()=>modern.decompressOpenSX(b,iR,iZ));
});

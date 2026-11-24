// Boundary cycles on faces with a seam (EXP-115). Needs no corpus.
const test=require('node:test'),assert=require('assert/strict');
const {boundaryCycles}=require('../src/display');

// A cylinder band as one triangle strip: bottom and top vertices alternate, at angles 0, 90, 180,
// 270 and 360 degrees. The 360-degree pair repeats the 0-degree coordinates, so the seam is drawn at
// both ends of the strip. Block1 ids: 1 bottom ring, 2 top ring, 3 seam. Strip edges follow the
// reader: (v, v+1), then (i-2, i) and (i-1, i) per new vertex.
function band(seamId){
  const vertices=[],n=5;
  for(let k=0;k<n;k++){const a=k%4*Math.PI/2;vertices.push(Math.cos(a),Math.sin(a),0,Math.cos(a),Math.sin(a),1);}
  const V=2*n,triangleIndices=[],edgeAnnotations=[];
  const id=(a,b)=>{const lo=Math.min(a,b),hi=Math.max(a,b);
    if(hi-lo===2)return lo%2===0?1:2;            // along a ring
    if(hi-lo===1&&lo%2===0&&(lo===0||lo===V-2))return seamId; // the seam pair at either end
    return 0;};
  const add=(a,b)=>edgeAnnotations.push({strip:0,vertices:[a,b],id:id(a,b)});
  add(0,1);
  for(let i=2;i<V;i++){triangleIndices.push(...(i%2===0?[i-2,i-1,i]:[i-1,i-2,i]));add(i-2,i);add(i-1,i);}
  return {vertices:Float32Array.from(vertices),vertexCount:V,triangleIndices:Uint32Array.from(triangleIndices),edgeAnnotations};
}

test('a face with a seam gets one cycle that walks the seam on both sides',()=>{
  const cycles=boundaryCycles(band(3));
  assert.equal(cycles.length,1);
  const ids=cycles[0].edgeIds;
  assert.equal(ids.length,10);
  assert.equal(ids.filter(x=>x===1).length,4);
  assert.equal(ids.filter(x=>x===2).length,4);
  assert.equal(ids.filter(x=>x===3).length,2);
});

test('the same band without a seam id gives the two rings, as before',()=>{
  const cycles=boundaryCycles(band(0));
  assert.equal(cycles.length,2);
  assert.deepEqual(cycles.map(c=>c.edgeIds.length).sort(),[4,4]);
  for(const c of cycles)assert.equal(new Set(c.edgeIds).size,1);
});

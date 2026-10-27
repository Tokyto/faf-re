'use strict';
const assert=require('node:assert/strict'),C=require('../core.js');
const map={width:512,depth:512,sea:17.5,waterEnabled:true,name:'polygon.scmap',samples:new Uint16Array(513*513).fill(58*128)};
const text='regionalwater 3 polygon 35 6 20 20 100 20 100 50 50 50 50 100 20 100 terrain preserve';
const r=C.parseDefinition(text)[0];assert.equal(r.points.length,6);assert.deepEqual(C.validate([r],map),[]);
assert(C.contains(r,30,70));assert(!C.contains(r,70,70));assert.equal(C.waterAt(map,[r],30,70),35);assert.equal(C.waterAt(map,[r],70,70),17.5);
assert.deepEqual(C.parseDefinition(C.serialize([r],map)),[r]);assert(C.serialize([r],map).includes('regionalwater 3'));
const reversed=C.updateBounds({...r,points:r.points.toReversed()});
for(let z=0;z<120;z+=.5)for(let x=0;x<120;x+=.5){assert.equal(C.contains(r,x,z),C.contains(reversed,x,z));assert.equal(C.contains(r,x,z),C.spansAtZ(r,z).some(([a,b])=>x>=a&&x<b));}
const clone=C.cloneRegion(r);clone.points[0].x=12;assert.equal(r.points[0].x,20);
const shapes=C.parseDefinition('regionalwater 3 polygon 35 3 0 0 40 0 0 40 terrain preserve polygon 50 3 40 40 40 10 10 40 terrain preserve');assert.deepEqual(C.validate(shapes,map),[]);
for(const bad of ['regionalwater 3 polygon 35 4 10 10 100 100 10 100 100 10 terrain preserve',
 'regionalwater 3 polygon 35 3 10 10 20 20 30 30 terrain preserve',
 'regionalwater 3 polygon 35 4 10 10 100 10 100 100 10 10 terrain preserve',
 'regionalwater 3 polygon 35 3 10 10 100 10 10 100 terrain gentle',
 'regionalwater 2 polygon 35 3 10 10 100 10 10 100 terrain preserve'])assert.throws(()=>C.parseDefinition(bad));
const touch=C.parseDefinition('regionalwater 3 polygon 35 3 10 10 100 10 10 100 terrain preserve region 10 10 20 20 40 terrain preserve');assert(C.validate(touch,map).some(e=>e.code==='overlap'));
const outside=C.parseDefinition('regionalwater 3 polygon 35 3 10 10 600 10 10 100 terrain preserve');assert(C.validate(outside,map).some(e=>e.code==='outside'));
const cell={width:2,depth:2,sea:17.5,waterEnabled:true,name:'saddle.scmap',samples:Uint16Array.from([60,0,60,0,60,0,60,0,60],v=>v*128)};
const diag=C.parseDefinition('regionalwater 3 polygon 35 3 0 0 2 2 0 2 terrain preserve');
const a=C.analyzeRegion(cell,diag,0);assert.equal(a.edgeMin,30);assert(a.unsafe>0);assert(a.segments.length>0);
const make=(n,cx,cz)=>C.updateBounds({height:35,mode:'preserve',points:Array.from({length:n},(_,i)=>{const a=i*2*Math.PI/n,r=i%2?36:54;return {x:Math.round((cx+Math.cos(a)*r)/2)*2,z:Math.round((cz+Math.sin(a)*r)/2)*2};})});
const eight=Array.from({length:8},(_,i)=>make(32,64+(i%4)*128,64+Math.floor(i/4)*128));assert.deepEqual(C.validate(eight,map),[]);const out=C.serialize(eight,map);assert(Buffer.byteLength(out)<=4096);assert.deepEqual(C.parseDefinition(out),eight);
console.log('PASS: concave polygons, overlapping bounding boxes, boundary/winding/scanline agreement, deep copies, round trips, 8 × 32 vertices and quadratic dry-edge minimum between terrain vertices.');

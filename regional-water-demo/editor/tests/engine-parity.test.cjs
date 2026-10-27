'use strict';
const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),C=require('../core.js');
const checker=process.argv[2];if(!checker)throw Error('Pass the compiled engine_check executable.');
let seed=362532;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
const cases=[];
for(let k=0;k<1500;k++){
 const map={width:k%4===0?2048:1024,depth:k%9===0?512:k%4===0?2048:1024,sea:k%6===0?40:17.5,waterEnabled:k%17!==0,name:'test.scmap'};
 const regions=[];for(let i=0,n=1+random(9);i<n;i++){const x=2*random(510),z=2*random(510);regions.push({x0:x,z0:z,x1:x+2+2*random(255),z1:z+2+2*random(255),height:[10,35,50,-20,499,8192][random(6)],mode:random(3)===0?'gentle':'preserve'});}
 const text='regionalwater 2\n'+regions.map(r=>`region ${r.x0} ${r.z0} ${r.x1} ${r.z1} ${r.height} terrain ${r.mode}`).join('\n')+'\n';
 cases.push({map,text,expected:C.validate(regions,map).length===0});
}
// Explicit valid layouts, both terrain modes, low lakes and each capacity.
for(let n=1;n<=8;n++)for(const mode of ['preserve','gentle']){
 const map={width:4096,depth:4096,sea:17.5,waterEnabled:true,name:'author.scmap'};
 const rs=Array.from({length:n},(_,i)=>({x0:100+i*400,z0:200,x1:228+i*400,z1:328,height:mode==='gentle'?35:10+i*5,mode}));
 cases.push({map,text:C.serialize(rs,map),expected:true});
}
for(const height of ['-8192','8192','8192.00001','-0','1e-20','1e-99','+35','NaN','Infinity']){
 const map={width:512,depth:512,sea:17.5,waterEnabled:true};const text=`regionalwater 1\nregion 2 2 128 128 ${height}\nterrain preserve\n`;
 let expected=false;try{expected=!C.validate(C.parseDefinition(text),map).length;}catch{}
 cases.push({map,text,expected});
}
// v3 polygon acceptance and serialized output versus the actual engine.
for(let k=0;k<200;k++){
 const map={width:512,depth:512,sea:17.5,waterEnabled:k%11!==0,name:'polygons.scmap'};
 const rs=Array.from({length:1+random(8)},(_,i)=>{const n=[8,16,32][random(3)],cx=64+(i%4)*128,cz=64+Math.floor(i/4)*128;
  return C.updateBounds({height:[10,35,50][random(3)],mode:'preserve',points:Array.from({length:n},(_,j)=>{const a=j*2*Math.PI/n,r=j%2?28:50;return{x:Math.round((cx+Math.cos(a)*r)/2)*2,z:Math.round((cz+Math.sin(a)*r)/2)*2};})});});
 const text='regionalwater 3\n'+rs.map(r=>`polygon ${r.height} ${r.points.length} ${r.points.map(p=>`${p.x} ${p.z}`).join(' ')} terrain preserve`).join('\n')+'\n';
 cases.push({map,text,expected:C.validate(rs,map).length===0});
}
for(const text of [
 'regionalwater 3 polygon 35 3 0 0 40 0 0 40 terrain preserve polygon 50 3 40 40 40 10 10 40 terrain preserve',
 'regionalwater 3 polygon 35 4 10 10 100 100 10 100 100 10 terrain preserve',
 'regionalwater 3 polygon 35 3 10 10 20 20 30 30 terrain preserve',
 'regionalwater 3 polygon 35 4 10 10 100 10 100 100 10 10 terrain preserve',
 'regionalwater 3 polygon 35 3 10 10 100 10 10 100 terrain gentle',
 'regionalwater 3 polygon 35 3 10 10 600 10 10 100 terrain preserve',
 'regionalwater 3 polygon 35 3 10 10 100 10 10 100 terrain preserve region 10 10 20 20 50 terrain preserve']){
 const map={width:512,depth:512,sea:17.5,waterEnabled:true};let expected=false;try{expected=C.validate(C.parseDefinition(text),map).length===0;}catch{}cases.push({map,text,expected});
}
const input=cases.map(({map:m,text})=>`${m.width} ${m.depth} ${m.sea} ${m.waterEnabled?1:0} ${Buffer.byteLength(text)}\n${text}`).join('');
const result=spawnSync(checker,[],{input,encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(result.status,0,result.stderr);
const outcomes=result.stdout.trim().split('\n');assert.equal(outcomes.length,cases.length);
cases.forEach((c,i)=>assert.equal(outcomes[i]==='OK',c.expected,`Engine mismatch in case ${i}: ${c.text}`));
console.log(`PASS: ${cases.length} definitions checked against the actual C++ v0.6 parser and validator, including exported 1–8 lake layouts.`);

/* Regional Water Editor 0.2 — standalone polygon and rectangle definitions. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RWCore = api;
})(globalThis, function () {
  'use strict';
  const MAX_REGIONS = 8, MAX_BYTES = 4096, MAX_DIMENSION = 4096, MAX_VERTICES = 32;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const separated = (a, b) => a.x1 < b.x0 || b.x1 < a.x0 || a.z1 < b.z0 || b.z1 < a.z0;
  const boxContains = (r, x, z) => x >= r.x0 && x < r.x1 && z >= r.z0 && z < r.z1;
  const isPolygon = r => Array.isArray(r.points);
  const vertices = r => isPolygon(r) ? r.points : [{x:r.x0,z:r.z0},{x:r.x1,z:r.z0},{x:r.x1,z:r.z1},{x:r.x0,z:r.z1}];
  const cloneRegion = r => isPolygon(r) ? {...r,points:r.points.map(p=>({...p}))} : {...r};
  const cross = (a,b,c) => (b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
  const validCoordinate = n => Number.isInteger(n) && n >= 0 && n <= 32768 && n % 2 === 0;
  const onSegment = (a,b,p) => cross(a,b,p)===0 && p.x>=Math.min(a.x,b.x)&&p.x<=Math.max(a.x,b.x)&&p.z>=Math.min(a.z,b.z)&&p.z<=Math.max(a.z,b.z);
  function segmentsTouch(a,b,c,d) {
    const ac=cross(a,b,c),ad=cross(a,b,d),ca=cross(c,d,a),cb=cross(c,d,b);
    return ((ac>0&&ad<0||ac<0&&ad>0)&&(ca>0&&cb<0||ca<0&&cb>0)) ||
      ac===0&&onSegment(a,b,c)||ad===0&&onSegment(a,b,d)||ca===0&&onSegment(c,d,a)||cb===0&&onSegment(c,d,b);
  }
  function polygonError(points) {
    if(points.length<3||points.length>MAX_VERTICES)return 'A polygon requires 3 to 32 vertices.';
    let area=0;
    for(let i=0;i<points.length;i++) {
      const a=points[i],b=points[(i+1)%points.length],c=points[(i+2)%points.length];
      if(!validCoordinate(a.x)||!validCoordinate(a.z))return 'Vertex coordinates must be even integers from 0 to 32768.';
      if(points.slice(i+1).some(p=>p.x===a.x&&p.z===a.z))return 'Polygon vertices must be unique. Do not repeat the first vertex at the end.';
      if(cross(a,b,c)===0&&(a.x-b.x)*(c.x-b.x)+(a.z-b.z)*(c.z-b.z)>0)return 'A polygon edge must not backtrack over itself.';
      area+=a.x*b.z-b.x*a.z;
      for(let j=i+1;j<points.length;j++)if(j!==i+1&&!(i===0&&j===points.length-1)&&segmentsTouch(a,b,points[j],points[(j+1)%points.length]))return 'Polygon edges cross or touch themselves.';
    }
    return area===0?'A polygon must have nonzero area.':null;
  }
  function updateBounds(r) {
    if(!isPolygon(r))return r;
    r.x0=Math.min(...r.points.map(p=>p.x));r.z0=Math.min(...r.points.map(p=>p.z));
    r.x1=Math.max(...r.points.map(p=>p.x));r.z1=Math.max(...r.points.map(p=>p.z));return r;
  }
  function contains(r,x,z) {
    if(!boxContains(r,x,z))return false;if(!isPolygon(r))return true;
    let inside=false;
    for(let i=0,j=r.points.length-1;i<r.points.length;j=i++) {
      const a=r.points[j],b=r.points[i];
      if((a.z>z)!==(b.z>z)&&x<a.x+(z-a.z)*(b.x-a.x)/(b.z-a.z))inside=!inside;
    }
    return inside;
  }
  function spansAtZ(r,z) {
    if(z<r.z0||z>=r.z1)return [];
    if(!isPolygon(r))return [[r.x0,r.x1]];
    const xs=[];
    for(let i=0,j=r.points.length-1;i<r.points.length;j=i++) {
      const a=r.points[j],b=r.points[i];if((a.z>z)!==(b.z>z))xs.push(a.x+(z-a.z)*(b.x-a.x)/(b.z-a.z));
    }
    xs.sort((a,b)=>a-b);const spans=[];for(let i=0;i+1<xs.length;i+=2)spans.push([xs[i],xs[i+1]]);return spans;
  }
  function regionsTouch(a,b) {
    if(separated(a,b))return false;const av=vertices(a),bv=vertices(b);
    for(let i=0;i<av.length;i++)for(let j=0;j<bv.length;j++)if(segmentsTouch(av[i],av[(i+1)%av.length],bv[j],bv[(j+1)%bv.length]))return true;
    return contains(a,bv[0].x,bv[0].z)||contains(b,av[0].x,av[0].z);
  }
  const finiteHeight = v => Number.isFinite(v) && Number.isFinite(Math.fround(v)) && Math.fround(v) >= -8192 && Math.fround(v) <= 8192;
  const validRect = r => ['x0', 'z0', 'x1', 'z1'].every(k => Number.isInteger(r[k]) && r[k] >= 0 && r[k] <= 32768 && r[k] % 2 === 0) && r.x0 < r.x1 && r.z0 < r.z1;
  const numberPattern = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

  class Reader {
    constructor(buffer) {
      if (ArrayBuffer.isView(buffer)) this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      else this.view = new DataView(buffer);
      this.pos = 0;
    }
    need(n) {
      if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.view.byteLength)
        throw new Error('The SCMAP is incomplete or has an invalid data length.');
    }
    skip(n) { this.need(n); this.pos += n; }
    u8() { this.need(1); return this.view.getUint8(this.pos++); }
    u16() { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
    u32() { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
    f32() { this.need(4); const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
    nul(wide = false) {
      for (let i = 0; i <= 65536; i++) if ((wide ? this.u16() : this.u8()) === 0) return;
      throw new Error('An SCMAP string is too long or unterminated.');
    }
  }

  // The standard v56/v60 prefix, through the original water settings. Texture,
  // prop, scenario and script payloads are neither interpreted nor rewritten.
  function parseSCMap(buffer, name = 'map.scmap') {
    const r = new Reader(buffer);
    if (r.u32() !== 0x1a70614d || r.u32() !== 2) throw new Error('Unsupported SCMAP. Select a .scmap file, not _scenario.lua.');
    if (r.u32() !== 0xbeeffeed || r.u32() !== 2) throw new Error('Unsupported preview header. Save a working copy in FAF Map Editor as SCMAP v56 or v60.');
    const previewWidth = r.f32(), previewDepth = r.f32();
    if (!Number.isFinite(previewWidth) || !Number.isFinite(previewDepth)) throw new Error('Invalid SCMAP preview dimensions.');
    r.nul(true);
    const metaCount = r.u32();
    if (metaCount > 65536) throw new Error('Invalid SCMAP preview metadata.');
    r.skip(metaCount * 8);
    const previewBytes = r.u32();
    if (previewBytes > 64 * 1024 * 1024) throw new Error('SCMAP preview is too large.');
    r.skip(previewBytes);
    const version = r.u32();
    if (version !== 56 && version !== 60) throw new Error(`SCMAP v${version} is not supported. Save a working copy as v56 or v60.`);
    const width = r.u32(), depth = r.u32(), scale = r.f32();
    if (width < 2 || depth < 2 || width > MAX_DIMENSION || depth > MAX_DIMENSION)
      throw new Error(`Supported map dimensions are 2 to ${MAX_DIMENSION} units on each axis.`);
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid SCMAP height scale.');
    const count = (width + 1) * (depth + 1);
    r.need(count * 2);
    const samples = new Uint16Array(count);
    let minimum = 65535, maximum = 0;
    const scale128 = Math.fround(scale * 128);
    for (let i = 0; i < count; i++) {
      const raw = r.u16();
      // Match the engine's CHeightField::Rescale and its fixed 1/128 storage.
      const sample = scale === 1 / 128 ? raw : Math.trunc(clamp(Math.fround(raw * scale128), 0, 65535));
      samples[i] = sample; minimum = Math.min(minimum, sample); maximum = Math.max(maximum, sample);
    }
    r.u8(); // stratum shader flag
    r.nul(); r.nul(); r.nul(); // shader, background, sky cube
    const environments = r.u32();
    if (environments > 1024) throw new Error('Invalid SCMAP environment count.');
    for (let i = 0; i < environments; i++) { r.nul(); r.nul(); }
    r.skip(23 * 4); // lighting, sun, ambience, specular, bloom, fog
    const waterFlag = r.u8();
    const sea = r.f32(), deep = r.f32(), abyss = r.f32();
    if (waterFlag > 1 || ![sea, deep, abyss].every(Number.isFinite) || !finiteHeight(sea))
      throw new Error('Could not reliably read the original SCMAP water level. The SCMAP is never overwritten.');
    return { name, version, width, depth, sea, waterEnabled: waterFlag === 1,
      samples, minimum: minimum / 128, maximum: maximum / 128, demo: false };
  }

  function parseDefinition(text) {
    if(new TextEncoder().encode(text).length>MAX_BYTES)throw new Error('The definition exceeds 4096 bytes.');
    const tokens=text.replace(/^\uFEFF/,'').replace(/#[^\n]*/g,'').split(/[ \t\r\n]+/).filter(Boolean);
    if(tokens[0]!=='regionalwater'||!['1','2','3'].includes(tokens[1]))throw new Error('Expected a regionalwater 1, 2 or 3 header.');
    const regions=[];
    for(let p=2;p<tokens.length;) {
      if(regions.length===MAX_REGIONS)throw new Error('At most eight regions are supported.');
      let r,modeOffset,next,heightText;
      if(tokens[p]==='region') {
        if(tokens.length-p<8)throw new Error('Incomplete region record.');
        const bounds=tokens.slice(p+1,p+5);heightText=tokens[p+5];
        if(!bounds.every(v=>/^-?\d+$/.test(v)))throw new Error('Invalid rectangle coordinates.');
        const [x0,z0,x1,z1]=bounds.map(Number);r={x0,z0,x1,z1,height:Number(heightText)};modeOffset=p+6;next=p+8;
      } else if(tokens[p]==='polygon'&&tokens[1]==='3') {
        heightText=tokens[p+1];const nText=tokens[p+2];
        if(!/^\d+$/.test(nText||''))throw new Error('Missing polygon vertex count.');
        const n=Number(nText);if(n<3||n>MAX_VERTICES||tokens.length-p<5+2*n)throw new Error('A polygon requires 3 to 32 complete X/Z coordinates.');
        const points=[];for(let i=0;i<n;i++){const x=tokens[p+3+2*i],z=tokens[p+4+2*i];if(!/^-?\d+$/.test(x)||! /^-?\d+$/.test(z))throw new Error('Invalid polygon coordinate.');points.push({x:Number(x),z:Number(z)});}
        const error=polygonError(points);if(error)throw new Error(error);
        r=updateBounds({points,height:Number(heightText)});modeOffset=p+3+2*n;next=modeOffset+2;
      } else throw new Error('Expected region or polygon in schema 3.');
      if(!numberPattern.test(heightText||'')||!finiteHeight(r.height)||(r.height!==0&&Math.fround(r.height)===0)||!validRect(r))throw new Error('Invalid bounds or water height.');
      if(tokens[modeOffset]!=='terrain'||!['preserve','gentle'].includes(tokens[modeOffset+1]))throw new Error('Expected terrain preserve or terrain gentle.');
      r.mode=tokens[modeOffset+1];if(isPolygon(r)&&r.mode!=='preserve')throw new Error('Polygons only support terrain preserve.');
      regions.push(r);p=next;
    }
    if(!regions.length||tokens[1]==='1'&&regions.length!==1)throw new Error('Missing region, or schema 1 contains multiple regions.');
    return regions;
  }

  function validate(regions,map) {
    const errors=[],add=(code,message,indices=[])=>errors.push({code,message,indices});
    if(!map){add('map','Open an .scmap file first.');return errors;}
    if(!map.waterEnabled||!Number.isFinite(map.sea))add('water','Enable original water in the map editor and save the map again.');
    if(!regions.length)add('empty','Add at least one lake. To restore original water, remove the .regionalwater file from the map folder.');
    if(regions.length>MAX_REGIONS)add('count','The engine supports at most eight lakes.');
    let totalSamples=0;
    for(let i=0;i<regions.length;i++) {
      const r=regions[i],tag=`Lake ${i+1}: `;
      if(isPolygon(r)){const error=polygonError(r.points);if(error)add('polygon',tag+error,[i]);}
      if(!validRect(r))add('bounds',tag+'bounds must be even integers from 0 to 32768 and region size must be positive.',[i]);
      if(!finiteHeight(r.height)||(r.height!==0&&Math.fround(r.height)===0))add('height',tag+'enter a finite height from −8192 to 8192.',[i]);
      if(!['preserve','gentle'].includes(r.mode))add('mode',tag+'unknown terrain mode.',[i]);
      if(r.x1>map.width||r.z1>map.depth)add('outside',tag+'the entire region must lie inside the map.',[i]);
      if(isPolygon(r)&&r.mode!=='preserve')add('polygon-mode',tag+'polygon requires Preserve map terrain.',[i]);
      if(!validRect(r)||!finiteHeight(r.height)||r.mode!=='gentle'||isPolygon(r))continue;
      const h=Math.fround(r.height);
      if(map.width!==map.depth||r.x0<=64||r.z0<=64||r.x1+64>=map.width||r.z1+64>=map.depth||r.x1-r.x0<128||r.z1-r.z0<128||h<12||Math.max(h,map.sea)+4>500)
        add('gentle',tag+'test basins require a square map, region at least 128 × 128, more than 64 units of margin, water height at least 12 and a dry edge no higher than 500.',[i]);
      totalSamples+=(r.x1-r.x0+129)*(r.z1-r.z0+129);
    }
    if(totalSamples>1048576)add('budget','Test basins exceed the combined limit of 1,048,576 height samples.');
    const expand=r=>{if(r.mode!=='gentle')return r;const copy=cloneRegion(r);copy.x0-=64;copy.z0-=64;copy.x1+=64;copy.z1+=64;return copy;};
    for(let i=0;i<regions.length;i++)for(let j=i+1;j<regions.length;j++) {
      const a=regions[i],b=regions[j];
      if(!validRect(a)||!validRect(b)||isPolygon(a)&&polygonError(a.points)||isPolygon(b)&&polygonError(b.points))continue;
      if(regionsTouch(a,b))add('overlap',`Lakes ${i+1} and ${j+1} overlap or touch. Their boundaries must be separate.`,[i,j]);
      else if((a.mode==='gentle'||b.mode==='gentle')&&regionsTouch(expand(a),expand(b)))add('edit-overlap',`The test basin affects another lake (${i+1}, ${j+1}).`,[i,j]);
    }
    return errors;
  }

  function serialize(regions,map) {
    const errors=validate(regions,map);if(errors.length)throw new Error(errors[0].message);
    const schema=regions.some(isPolygon)?3:2,cleanName=String(map.name||'map.scmap').replace(/[\r\n\u2028\u2029]/g,' ');
    const text=`# Regional Water Editor 0.2 | engine v0.${schema===3?'6':'5'}+ | offline\n# ${cleanName}\nregionalwater ${schema}\n`+
      regions.map(r=>isPolygon(r)?`polygon ${r.height} ${r.points.length} ${r.points.map(p=>`${p.x} ${p.z}`).join(' ')} terrain preserve`:
        `region ${r.x0} ${r.z0} ${r.x1} ${r.z1} ${Object.is(r.height,-0)?0:r.height} terrain ${r.mode}`).join('\n')+'\n';
    if(new TextEncoder().encode(text).length>MAX_BYTES)throw new Error('Output exceeds 4096 bytes.');return text;
  }

  function heightAt(map, x, z) {
    x = clamp(x, 0, map.width); z = clamp(z, 0, map.depth);
    const x0 = Math.floor(x), z0 = Math.floor(z), x1 = Math.min(x0 + 1, map.width), z1 = Math.min(z0 + 1, map.depth);
    const tx = x - x0, tz = z - z0, stride = map.width + 1, a = map.samples;
    const top = a[z0 * stride + x0] * (1 - tx) + a[z0 * stride + x1] * tx;
    const bottom = a[z1 * stride + x0] * (1 - tx) + a[z1 * stride + x1] * tx;
    return (top * (1 - tz) + bottom * tz) / 128;
  }

  const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  function basinHeight(r, sea, x, z, original) {
    const hx = (r.x1 - r.x0) / 2, hz = (r.z1 - r.z0) / 2;
    const dx = Math.abs(x - (r.x0 + r.x1) / 2), dz = Math.abs(z - (r.z0 + r.z1) / 2);
    const outside = Math.hypot(Math.max(0, dx - hx), Math.max(0, dz - hz));
    if (outside >= 64 || hx <= 0 || hz <= 0) return original;
    const rim = Math.max(Math.fround(r.height), sea) + 4;
    if (outside > 0) return rim + (original - rim) * smooth(outside / 64);
    const bank = smooth((Math.hypot(dx / hx, dz / hz) - .35) / .5), floor = Math.fround(r.height) - 12;
    return floor + (rim - floor) * bank;
  }

  function effectiveHeightAt(map, regions, x, z) {
    let h = heightAt(map, x, z);
    for (const r of regions) if (r.mode === 'gentle' && !isPolygon(r) && validRect(r) && finiteHeight(r.height)) h = basinHeight(r, map.sea, x, z, h);
    return h;
  }
  function waterAt(map, regions, x, z) {
    for (const r of regions) if (validRect(r) && finiteHeight(r.height) && contains(r, x, z)) return Math.fround(r.height);
    return map.sea;
  }

  // Scan actual edges through height cells, plus a bounded interior estimate.
  // An outer map edge has no neighbouring sea and needs no dry separator.
  function analyzeRegion(map,regions,index) {
    const r=regions[index];
    if(!r||!validRect(r)||!finiteHeight(r.height)||r.x1>map.width||r.z1>map.depth||isPolygon(r)&&polygonError(r.points))return null;
    const height=Math.fround(r.height),limit=Math.max(height,map.sea),sameLevel=height===map.sea;
    let edgeMin=Infinity,edgeCount=0,unsafe=0,tight=0;const segments=[];
    const edge=(a,b)=>{
      if(a.x===b.x&&(a.x===0||a.x===map.width)||a.z===b.z&&(a.z===0||a.z===map.depth))return;
      const ts=[0,1],dx=b.x-a.x,dz=b.z-a.z;
      if(dx)for(let x=Math.floor(Math.min(a.x,b.x))+1;x<Math.max(a.x,b.x);x++)ts.push((x-a.x)/dx);
      if(dz)for(let z=Math.floor(Math.min(a.z,b.z))+1;z<Math.max(a.z,b.z);z++)ts.push((z-a.z)/dz);
      ts.sort((a,b)=>a-b);const at=t=>({x:a.x+dx*t,z:a.z+dz*t});let run=null;
      for(let i=0;i+1<ts.length;i++) {
        const lo=ts[i],hi=ts[i+1];if(hi-lo<1e-12)continue;
        const p=at(lo),q=at(hi),m=at((lo+hi)/2),h0=effectiveHeightAt(map,regions,p.x,p.z),h1=effectiveHeightAt(map,regions,q.x,q.z),hm=effectiveHeightAt(map,regions,m.x,m.z);
        // Along a straight edge inside one height cell, bilinear terrain is
        // quadratic. Check its interior minimum as well as both endpoints.
        const aa=2*(h0+h1-2*hm),bb=h1-h0-aa,u=aa>0?-bb/(2*aa):-1;
        let minimum=Math.min(h0,h1,hm);if(u>0&&u<1)minimum=Math.min(minimum,aa*u*u+bb*u+h0);
        edgeMin=Math.min(edgeMin,minimum);edgeCount++;
        const bad=!sameLevel&&minimum<=limit;if(bad)unsafe++;else if(!sameLevel&&minimum<limit+1)tight++;
        if(bad&&run===null)run=p;
        if(run!==null&&(!bad||i===ts.length-2)){segments.push({x0:run.x,z0:run.z,x1:q.x,z1:q.z});run=null;}
      }
      if(run!==null)segments.push({x0:run.x,z0:run.z,x1:b.x,z1:b.z});
    };
    const points=vertices(r);for(let i=0;i<points.length;i++)edge(points[i],points[(i+1)%points.length]);
    const nx=Math.min(128,r.x1-r.x0),nz=Math.min(128,r.z1-r.z0);let wet=0,deepest=0,samples=0;
    for(let j=0;j<nz;j++)for(let i=0;i<nx;i++) {
      const x=r.x0+(i+.5)/nx*(r.x1-r.x0),z=r.z0+(j+.5)/nz*(r.z1-r.z0);
      if(!contains(r,x,z))continue;samples++;
      const d=height-effectiveHeightAt(map,regions,x,z);if(d>0){wet++;deepest=Math.max(deepest,d);}
    }
    return {edgeMin,edgeCount,unsafe,tight,sameLevel,segments,wetRatio:samples?wet/samples:0,deepest,limit};
  }

  function snap(v, max) { return clamp(Math.round(v / 2) * 2, 0, Math.floor(max / 2) * 2); }
  function demo() {
    const width = 512, depth = 512, sea = 17.5, samples = new Uint16Array(513 * 513);
    for (let z = 0; z <= depth; z++) for (let x = 0; x <= width; x++) {
      let h = 14 + 3 * Math.sin(x / 58) * Math.cos(z / 74);
      const radius = (Math.abs((x - 256) / 220) ** 4 + Math.abs((z - 256) / 215) ** 4) ** .25;
      const isle = smooth((1.06 - radius) / .16);
      h = h * (1 - isle) + (58 + 3 * Math.sin(x / 32) * Math.sin(z / 29)) * isle;
      for (const p of [{x:166,z:182,h:35}, {x:352,z:310,h:50}]) {
        const d = Math.hypot((x - p.x) / 60, (z - p.z) / 76);
        if (d < 1) h = p.h - 14 + (58 - p.h + 14) * smooth((d - .35) / .65);
      }
      samples[z * 513 + x] = Math.round(clamp(h * 128, 0, 65535));
    }
    return {
      map: { name: 'demo.scmap', version: 60, width, depth, sea, waterEnabled: true, samples, minimum: 10, maximum: 62, demo: true },
      regions: [{ x0: 100, z0: 100, x1: 232, z1: 264, height: 35, mode: 'preserve' }, { x0: 286, z0: 228, x1: 418, z1: 392, height: 50, mode: 'preserve' }]
    };
  }
  return { MAX_REGIONS, MAX_BYTES, MAX_DIMENSION, MAX_VERTICES, clamp, contains, validRect, finiteHeight, isPolygon, vertices, cloneRegion, polygonError, updateBounds, regionsTouch, spansAtZ,
    parseSCMap, parseDefinition, validate, serialize, heightAt, basinHeight, effectiveHeightAt, waterAt, analyzeRegion, snap, demo };
});

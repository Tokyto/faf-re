(function () {
  'use strict';
  const C = window.RWCore, $ = id => document.getElementById(id);
  const palette = ['#74e5cb', '#f4be74', '#94baff', '#e6a0dc', '#a9d981', '#fb9c8c', '#a7a0ff', '#78d3ed'];
  const state = { map: null, regions: [], selected: -1, tool: 'select', past: [], future: [], saved: '',
    camera: { zoom: 1, x: 0, y: 0 }, drag: null, space: false, busy: false, analyses: [], errors: [], warnings: [], notice: '', drawing: [], polyCursor: null, selectedVertex: -1 };
  const canvas = $('mapCanvas'), ctx = canvas.getContext('2d'), wrap = $('canvasWrap');
  const bitmap = document.createElement('canvas'), bctx = bitmap.getContext('2d');
  let baseGrid = null, previewWidth = 0, previewDepth = 0, frame = 0, previewNeeded = false, formNeeded = false, toastTimer;
  let formBefore = null, lastPreviewTime = 0, renderTimer = 0;
  const f = (n, digits = 2) => Number.isFinite(n) ? n.toLocaleString('cs-CZ', { maximumFractionDigits: digits }) : '—';
  const signature = regions => JSON.stringify(regions.map(r=>[r.x0,r.z0,r.x1,r.z1,r.height,r.mode,C.isPolygon(r)?r.points.map(p=>[p.x,p.z]):null]), (_, v) => typeof v === 'number' && !Number.isFinite(v) ? String(v) : v);
  const capture = () => ({ regions: state.regions.map(C.cloneRegion), selected: state.selected, selectedVertex: state.selectedVertex });
  const dirty = () => state.map && !state.map.demo && signature(state.regions) !== state.saved;
  const editing = el => el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);

  function toast(message, error = false) {
    clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 5500);
  }
  function record(before) {
    if (signature(before.regions) !== signature(state.regions)) {
      state.past.push(before); if (state.past.length > 80) state.past.shift(); state.future = [];
    }
  }
  function change(mutator) { if (state.busy) return; const before = capture(); mutator(); record(before); schedule(true, true); }
  function undo() {
    if(state.tool==='polygon'&&state.drawing.length){state.drawing.pop();schedule(false,false);return;}
    if (!state.past.length || state.drag || state.busy) return;
    state.future.push(capture()); const previous = state.past.pop(); state.regions = previous.regions; state.selected = previous.selected; state.selectedVertex=previous.selectedVertex??-1;
    formBefore = null; schedule(true, true);
  }
  function redo() {
    if (!state.future.length || state.drag || state.busy) return;
    state.past.push(capture()); const next = state.future.pop(); state.regions = next.regions; state.selected = next.selected; state.selectedVertex=next.selectedVertex??-1;
    formBefore = null; schedule(true, true);
  }
  function setTool(tool) {
    if (!state.map || state.busy) return;
    if ((tool === 'draw'||tool==='polygon') && state.regions.length >= C.MAX_REGIONS) { toast('At most eight lakes are supported per map.', true); return; }
    cancelDrag(); state.drawing=[];state.polyCursor=null;state.selectedVertex=-1;state.tool = tool;
    if(tool==='polygon')state.selected=-1;
    canvas.style.cursor = tool === 'draw'||tool==='polygon' ? 'crosshair' : 'default'; schedule(false, true); canvas.focus();
  }

  function finishPolygon() {
    if(state.drawing.length<3){toast('A polygon needs at least three vertices.',true);return;}
    const error=C.polygonError(state.drawing);if(error){toast(error,true);return;}
    const r=C.updateBounds({points:state.drawing.map(p=>({...p})),height:Math.round((state.map.sea+12)*2)/2,mode:'preserve'});
    change(()=>{state.regions.push(r);state.selected=state.regions.length-1;state.selectedVertex=-1;state.drawing=[];state.polyCursor=null;state.tool='select';});
  }

  function transform() {
    const w = wrap.clientWidth, h = wrap.clientHeight, m = state.map;
    const fit = m ? Math.min(Math.max(10, w - 76) / m.width, Math.max(10, h - 72) / m.depth) : 1;
    const scale = fit * state.camera.zoom;
    return { w, h, scale, ox: w / 2 - (m ? m.width : 0) * scale / 2 + state.camera.x,
      oz: h / 2 - (m ? m.depth : 0) * scale / 2 + state.camera.y };
  }
  function point(e) { const rect = canvas.getBoundingClientRect(); return { px: e.clientX - rect.left, py: e.clientY - rect.top }; }
  function world(p, t = transform()) { return { x: (p.px - t.ox) / t.scale, z: (p.py - t.oz) / t.scale }; }
  function fit() { state.camera = { zoom: 1, x: 0, y: 0 }; drawCanvas(); $('zoomLabel').textContent = '100 %'; }
  function zoom(factor, px, py) {
    if (!state.map) return;
    const t = transform(), anchor = world({ px: px ?? t.w / 2, py: py ?? t.h / 2 }, t);
    state.camera.zoom = C.clamp(state.camera.zoom * factor, .5, 16);
    const next = transform(); state.camera.x += (px ?? t.w / 2) - (next.ox + anchor.x * next.scale);
    state.camera.y += (py ?? t.h / 2) - (next.oz + anchor.z * next.scale);
    $('zoomLabel').textContent = f(state.camera.zoom * 100, 0) + ' %'; drawCanvas();
  }

  function prepareBaseGrid() {
    const m = state.map; if (!m) return;
    const long = Math.max(m.width, m.depth), res = Math.min(768, long);
    previewWidth = Math.max(1, Math.round(res * m.width / long)); previewDepth = Math.max(1, Math.round(res * m.depth / long));
    baseGrid = new Float32Array(previewWidth * previewDepth);
    for (let z = 0; z < previewDepth; z++) for (let x = 0; x < previewWidth; x++)
      baseGrid[z * previewWidth + x] = C.heightAt(m, (x + .5) / previewWidth * m.width, (z + .5) / previewDepth * m.depth);
    bitmap.width = previewWidth; bitmap.height = previewDepth;
  }
  function buildPreview() {
    if (!state.map) return;
    const m = state.map, w = previewWidth, h = previewDepth;
    const regions = state.regions.filter(r => C.validRect(r) && C.finiteHeight(r.height));
    const gentle = regions.filter(r => r.mode === 'gentle' && !C.isPolygon(r));
    const grid = gentle.length ? new Float32Array(baseGrid) : baseGrid;
    if (gentle.length) for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
      const wx = (x + .5) / w * m.width, wz = (z + .5) / h * m.depth, p = z * w + x;
      for (const r of gentle) grid[p] = C.basinHeight(r, m.sea, wx, wz, grid[p]);
    }
    const image = bctx.createImageData(w, h), data = image.data;
    const water = $('waterCheck').checked && m.waterEnabled, contours = $('contourCheck').checked;
    const range = Math.max(18, m.maximum - m.minimum);
    for (let z = 0; z < h; z++) {
      const rowSpans=regions.map(r=>C.spansAtZ(r,(z+.5)/h*m.depth));
      for (let x = 0; x < w; x++) {
      const p = z * w + x, y = grid[p], left = grid[z * w + Math.max(0, x - 1)], up = grid[Math.max(0, z - 1) * w + x];
      const right = grid[z * w + Math.min(w - 1, x + 1)], down = grid[Math.min(h - 1, z + 1) * w + x];
      const slope = C.clamp(.88 + (left - right) * .05 * w / m.width + (up - down) * .06 * h / m.depth, .45, 1.28);
      const t = C.clamp((y - m.minimum) / range, 0, 1);
      let red = (74 + t * 80) * slope, green = (91 + t * 56) * slope, blue = (77 + t * 60) * slope;
      let level = m.sea, local = -1;
      const wx = (x + .5) / w * m.width;
      for (let i = 0; i < regions.length; i++) if (rowSpans[i].some(span=>wx>=span[0]&&wx<span[1])) { level = Math.fround(regions[i].height); local = i; break; }
      if (water && y < level) {
        const d = C.clamp((level - y) / 28, 0, 1), shore = 1 - d;
        red = 16 + 18 * shore; green = 49 + 48 * shore; blue = 72 + 46 * shore;
        if (local >= 0) { red += 4; green += 10; blue += 3; }
        const shade = .86 + .14 * slope; red *= shade; green *= shade; blue *= shade;
      }
      if (contours && (Math.floor(y / 4) !== Math.floor(left / 4) || Math.floor(y / 4) !== Math.floor(up / 4))) { red *= .7; green *= .7; blue *= .7; }
      const q = p * 4; data[q] = red; data[q + 1] = green; data[q + 2] = blue; data[q + 3] = 255;
    }
    }
    bctx.putImageData(image, 0, 0); lastPreviewTime = performance.now();
  }

  function drawCanvas() {
    const t = transform(), dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(t.w * dpr) || canvas.height !== Math.round(t.h * dpr)) {
      canvas.width = Math.round(t.w * dpr); canvas.height = Math.round(t.h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, t.w, t.h); ctx.fillStyle = '#091219'; ctx.fillRect(0, 0, t.w, t.h);
    if (!state.map) {
      ctx.strokeStyle = '#1b2c3590'; ctx.lineWidth = 1;
      for (let x = 22; x < t.w; x += 36) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, t.h); ctx.stroke(); }
      for (let z = 22; z < t.h; z += 36) { ctx.beginPath(); ctx.moveTo(0, z); ctx.lineTo(t.w, z); ctx.stroke(); }
      return;
    }
    const m = state.map, sx = x => t.ox + x * t.scale, sz = z => t.oz + z * t.scale;
    ctx.imageSmoothingEnabled = true; ctx.drawImage(bitmap, t.ox, t.oz, m.width * t.scale, m.depth * t.scale);
    ctx.save(); ctx.beginPath(); ctx.rect(t.ox, t.oz, m.width * t.scale, m.depth * t.scale); ctx.clip();
    if ($('boundsCheck').checked) state.regions.forEach((r,i)=>{
      if(!C.validRect(r))return;
      const selected=i===state.selected,points=C.vertices(r),x=sx(points[0].x),z=sz(points[0].z);
      ctx.beginPath();points.forEach((p,j)=>j?ctx.lineTo(sx(p.x),sz(p.z)):ctx.moveTo(sx(p.x),sz(p.z)));ctx.closePath();
      ctx.fillStyle=palette[i]+(selected?'10':'05');ctx.fill();ctx.strokeStyle=palette[i];ctx.lineWidth=selected?2:1.2;ctx.setLineDash(selected?[]:[5,4]);ctx.stroke();ctx.setLineDash([]);
      ctx.font='11px Segoe UI,sans-serif';const label=`${i+1} · ${f(r.height)}`,textWidth=ctx.measureText(label).width+17;
      ctx.fillStyle='#07151be6';ctx.fillRect(x+1,z+1,textWidth+6,23);ctx.fillStyle=palette[i];ctx.fillText(label,x+9,z+16);
      if(selected&&state.tool==='select')points.forEach((p,j)=>{
        const hx=sx(p.x),hz=sz(p.z),active=C.isPolygon(r)&&j===state.selectedVertex,size=active?10:8;
        ctx.fillStyle=active?palette[i]:'#0e2026';ctx.fillRect(hx-size/2,hz-size/2,size,size);ctx.strokeStyle=palette[i];ctx.lineWidth=1.5;ctx.strokeRect(hx-size/2,hz-size/2,size,size);
      });
    });
    if ($('riskCheck').checked) {
      ctx.strokeStyle = '#ff7d7d'; ctx.lineWidth = 3; ctx.setLineDash([]);
      for (const a of state.analyses) if (a) for (const segment of a.segments) {
        ctx.beginPath(); ctx.moveTo(sx(segment.x0), sz(segment.z0)); ctx.lineTo(sx(segment.x1), sz(segment.z1)); ctx.stroke();
      }
    }
    if (state.drag?.type === 'draw') {
      const r = state.drag.rect, x = sx(r.x0), z = sz(r.z0);
      ctx.fillStyle = '#85eadb20'; ctx.fillRect(x, z, (r.x1 - r.x0) * t.scale, (r.z1 - r.z0) * t.scale);
      ctx.strokeStyle = '#c3fff0'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.strokeRect(x, z, (r.x1 - r.x0) * t.scale, (r.z1 - r.z0) * t.scale); ctx.setLineDash([]);
      ctx.fillStyle = '#e2fff6'; ctx.font = '12px Consolas, monospace'; ctx.fillText(`${r.x1-r.x0} × ${r.z1-r.z0}`, x + 8, z + 18);
    }
    if(state.tool==='polygon'&&state.drawing.length){
      const points=state.drawing;ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(sx(p.x),sz(p.z)):ctx.moveTo(sx(p.x),sz(p.z)));
      if(state.polyCursor)ctx.lineTo(sx(state.polyCursor.x),sz(state.polyCursor.z));
      ctx.strokeStyle='#a4f7df';ctx.lineWidth=2;ctx.stroke();
      ctx.setLineDash([4,4]);ctx.lineTo(sx(points[0].x),sz(points[0].z));ctx.stroke();ctx.setLineDash([]);
      points.forEach((p,i)=>{ctx.fillStyle=i===0?'#f4be74':'#a4f7df';ctx.fillRect(sx(p.x)-4,sz(p.z)-4,8,8);});
    }
    ctx.restore();
    ctx.strokeStyle = '#526773'; ctx.lineWidth = 1; ctx.strokeRect(t.ox, t.oz, m.width * t.scale, m.depth * t.scale);
    const spacing = Math.max(2, Math.pow(2, Math.ceil(Math.log2(85 / t.scale))));
    ctx.font = '10px Consolas, monospace'; ctx.fillStyle = '#9aafbd'; ctx.strokeStyle = '#59707d'; ctx.textAlign = 'center';
    for (let x = 0; x <= m.width; x += spacing) if (sx(x) >= 12 && sx(x) <= t.w - 12) {
      const y = C.clamp(t.oz - 9, 14, t.h - 12); ctx.fillText(String(x), sx(x), y);
    }
    ctx.textAlign = 'right';
    for (let z = 0; z <= m.depth; z += spacing) if (sz(z) >= 15 && sz(z) <= t.h - 12) ctx.fillText(String(z), C.clamp(t.ox - 7, 29, t.w - 10), sz(z) + 3);
    ctx.textAlign = 'left';
  }

  function computeChecks() {
    state.errors = C.validate(state.regions, state.map); state.warnings = [];
    state.analyses = state.map ? state.regions.map((_, i) => C.analyzeRegion(state.map, state.regions, i)) : [];
    for (let i = 0; i < state.analyses.length; i++) {
      const a = state.analyses[i]; if (!a) continue;
      if (a.unsafe) state.warnings.push({ indices: [i], message: `Lake ${i + 1}: boundary lacks dry separation above ${f(a.limit)}. Move red sections to higher terrain or edit the shore.` });
      else if (a.tight) state.warnings.push({ indices: [i], message: `Lake ${i + 1}: shore clearance is under 1 unit above the higher water level. Raise it or move the boundary.` });
      if (a.wetRatio === 0) state.warnings.push({ indices: [i], message: `Lake ${i + 1}: the preview found no flooded terrain. Check the region and water height.` });
    }
  }
  function renderList() {
    $('regionCount').textContent = `${state.regions.length} / ${C.MAX_REGIONS}`; const list = $('regionList'); list.replaceChildren();
    if (!state.regions.length) { const p = document.createElement('p'); p.className = 'listempty'; p.textContent = state.map ? 'Click + Polygon to draw a lake boundary. Press Enter to finish.' : 'Open a map, then add a lake using + Polygon.'; list.append(p); return; }
    state.regions.forEach((r, i) => {
      const b = document.createElement('button'); b.className = 'regionrow' + (i === state.selected ? ' selected' : ''); b.style.setProperty('--color', palette[i]); b.setAttribute('aria-pressed', i === state.selected ? 'true' : 'false'); b.setAttribute('aria-label', `Lake ${i+1}, water level ${f(r.height)}`);
      const dot = document.createElement('span'); dot.className = 'dot';
      const name = document.createElement('span'); name.className = 'regionname'; name.textContent = `Lake ${i+1}`;
      const detail = document.createElement('small'); detail.textContent = `${C.isPolygon(r)?r.points.length+' vertices':f(r.x1-r.x0,0)+' × '+f(r.z1-r.z0,0)} · ${r.mode === 'gentle' ? 'test basin' : 'map terrain'}`; name.append(detail);
      const height = document.createElement('span'); height.className = 'regionheight'; height.textContent = f(r.height);
      b.append(dot, name, height);
      if ([...state.errors, ...state.warnings].some(e => e.indices.includes(i))) { const flag = document.createElement('span'); flag.className = 'rowflag'; flag.textContent = '!'; flag.title = 'Region has warnings or errors'; b.append(flag); }
      b.onclick = () => { state.selected = i; state.selectedVertex=-1;state.drawing=[];state.polyCursor=null;state.tool = 'select'; schedule(false, true); }; list.append(b);
    });
  }
  function renderInspector(fillForm) {
    const r=state.regions[state.selected];$('inspector').hidden=!r;if(!r)return;
    const poly=C.isPolygon(r);$('selectedTitle').textContent=`Lake ${state.selected+1}`;
    if(fillForm){$('heightInput').value=Number.isFinite(r.height)?String(r.height):'';for(const key of ['x0','z0','x1','z1'])$(key+'Input').value=Number.isFinite(r[key])?String(r[key]):'';$('modeInput').value=r.mode;}
    $('boundsGrid').hidden=poly;$('polygonControls').hidden=!poly;$('convertBtn').hidden=poly;
    const diff=Math.fround(r.height)-state.map.sea;$('seaDiff').textContent=`Sea ${f(state.map.sea)} · difference ${diff>0?'+':''}${f(diff)}`;
    $('dimensions').textContent=(poly?'Polygon · bounds ':'Region ')+`${f(r.x1-r.x0,0)} × ${f(r.z1-r.z0,0)} · even coordinates.`;
    $('gentleNote').hidden=r.mode!=='gentle';
    if(poly){$('vertexCount').textContent=`${r.points.length} / ${C.MAX_VERTICES}`;renderVertices(r,fillForm);}
    const a=state.analyses[state.selected],box=$('stats');box.replaceChildren();
    if(a){const stats=[['Flooded · estimate',`${f(a.wetRatio*100,0)} %`],['Max depth · estimate',f(a.deepest)],['Lowest separating edge',a.edgeCount?f(a.edgeMin):'map edge']];
      for(let i=0;i<stats.length;i++){const div=document.createElement('div');div.className='stat'+(i===2?' wide':'');const label=document.createElement('span'),value=document.createElement('strong');label.textContent=stats[i][0];value.textContent=stats[i][1];div.append(label,value);box.append(div);}}
  }
  function removeVertex(index){const r=state.regions[state.selected];if(!r||!C.isPolygon(r)||r.points.length<=3)return;change(()=>{r.points.splice(index,1);C.updateBounds(r);state.selectedVertex=Math.min(index,r.points.length-1);});}
  function renderVertices(r,fillForm){
    const table=$('vertexTable');if(!fillForm&&table.children.length===r.points.length)return;table.replaceChildren();
    r.points.forEach((p,i)=>{
      const row=document.createElement('div');row.className='vertex-row'+(i===state.selectedVertex?' selected':'');const number=document.createElement('span');number.textContent=String(i+1);row.append(number);
      for(const key of ['x','z']){const input=document.createElement('input');input.type='number';input.step='2';input.min='0';input.max=String(key==='x'?state.map.width:state.map.depth);input.value=Number.isFinite(p[key])?String(p[key]):'';input.setAttribute('aria-label',`Bod ${i+1} ${key.toUpperCase()}`);input.dataset.vertex=String(i);input.dataset.axis=key;
        input.onfocus=()=>{state.selectedVertex=i;formBefore=capture();drawCanvas();};
        input.oninput=()=>{if(state.busy)return;r.points[i][key]=input.value===''?NaN:Number(input.value);C.updateBounds(r);schedule(true,false);};
        const commit=()=>{if(formBefore){record(formBefore);formBefore=null;}schedule(false,false);};input.onchange=commit;input.onblur=commit;row.append(input);}
      const del=document.createElement('button');del.className='danger';del.textContent='×';del.title=`Odebrat bod ${i+1}`;del.setAttribute('aria-label',del.title);del.dataset.removeVertex=String(i);del.disabled=r.points.length<=3;del.onclick=()=>removeVertex(i);row.append(del);table.append(row);
    });
  }
  function renderStatus() {
    let title = 'Start by opening a map', type = '', note = 'The app reads terrain and saves a separate water definition. The map is not overwritten.';
    if (state.map) {
      if (state.errors.length) { title = state.regions.length || !state.map.waterEnabled ? 'Fix the definition' : 'Add your first lake'; type = state.regions.length || !state.map.waterEnabled ? 'error' : ''; }
      else if (state.warnings.length) { title = 'Check the shores'; type = 'warn'; note = 'Engine rules passed. Terrain warnings do not block export; check them before playing.'; }
      else { title = 'Ready to export'; type = 'ok'; note = 'Engine rules and boundary checks passed. Preview is approximate; test unit movement in game.'; }
      if (state.map.demo) { title = 'Demo'; type = ''; note = 'This is demo terrain. Open a real .scmap file to export.'; }
    }
    $('statusTitle').textContent = title; $('statusLine').className = 'statusline ' + type; $('statusNote').textContent = note;
    const list = $('issueList'); list.replaceChildren();
    const append = (message, cls) => { const p = document.createElement('p'); p.className = 'issue '+cls; p.textContent = message; list.append(p); };
    if (state.map) for (const e of state.errors) append(e.message, 'error');
    for (const w of state.warnings) append(w.message, '');
    if (state.notice) append(state.notice, 'info');
    if(state.regions.some(C.isPolygon))append('Polygons require experimental engine v0.6 or later and use schema 3.','info');
    if (state.regions.some(r => r.mode === 'gentle')) append('The preview simulates gentle terrain edits. The basin is created when the game loads.', 'info');
    if(state.tool==='polygon'&&state.drawing.length){$('statusTitle').textContent=`Finish polygon · ${state.drawing.length} vertices`;$('statusNote').textContent='Press Enter or click the first point to finish. Backspace removes the last point; Esc cancels.';}
    const canSave = state.map && !state.map.demo && !state.errors.length && !state.busy && !state.drawing.length;
    $('saveBtn').disabled = !canSave;
    $('saveHint').textContent = state.busy ? 'Loading…' : state.map ? (dirty() ? 'Unsaved changes · ' : '') + state.map.name + '.regionalwater' : 'Output: .regionalwater file';
    $('saveBtn').title = canSave ? 'Download water definition for the map' : state.map?.demo ? 'Open a real SCMAP to export.' : state.errors[0]?.message || 'Open an SCMAP first.';
  }
  function renderUI(fillForm = false) {
    computeChecks(); renderList(); renderInspector(fillForm); renderStatus();
    const ready = !!state.map && !state.busy;
    for (const id of ['importBtn','selectBtn','zoomOutBtn','zoomInBtn','fitBtn']) $(id).disabled = !ready;
    $('drawBtn').disabled=$('polygonBtn').disabled=!ready||state.regions.length>=C.MAX_REGIONS;
    $('polygonBtn').classList.toggle('active',state.tool==='polygon');$('polygonBtn').setAttribute('aria-pressed',String(state.tool==='polygon'));
    $('finishPolygonBtn').hidden=state.tool!=='polygon';$('finishPolygonBtn').disabled=!ready||state.drawing.length<3;
    $('selectBtn').classList.toggle('active', state.tool === 'select'); $('drawBtn').classList.toggle('active', state.tool === 'draw');
    $('selectBtn').setAttribute('aria-pressed', String(state.tool === 'select')); $('drawBtn').setAttribute('aria-pressed', String(state.tool === 'draw'));
    $('undoBtn').disabled = state.busy || (!state.past.length&&!state.drawing.length); $('redoBtn').disabled = state.busy || !state.future.length;
    $('openMapBtn').disabled = state.busy;
    for (const el of $('inspector').querySelectorAll('input,select,button')) el.disabled=state.busy;
    const selectedRegion=state.regions[state.selected];if(selectedRegion&&C.isPolygon(selectedRegion)){$('modeInput').disabled=true;for(const el of $('vertexTable').querySelectorAll('button'))el.disabled=state.busy||selectedRegion.points.length<=3;}
    $('toolHint').textContent = state.tool==='polygon'?`Click to add vertices (${state.drawing.length}/32). Enter or first vertex finishes; Backspace removes one.` : state.tool === 'draw' ? 'Drag to draw a region. Keep its boundary in dry terrain. Esc cancels.' : 'Select a lake; drag to move or resize using corners. Arrows move by 2.';
    document.title = (dirty() ? '• ' : '') + 'Regional Water — water editor';
  }
  function schedule(preview = false, form = false) {
    previewNeeded ||= preview; formNeeded ||= form;
    if (frame || renderTimer) return;
    const draw = () => { frame = 0; const pf = previewNeeded, ff = formNeeded; previewNeeded = formNeeded = false; renderUI(ff); if (pf && state.map) buildPreview(); drawCanvas(); };
    const delay = previewNeeded ? Math.max(0, 60 - (performance.now() - lastPreviewTime)) : 0;
    if (delay > 0) renderTimer = setTimeout(() => { renderTimer = 0; frame = requestAnimationFrame(draw); }, delay);
    else frame = requestAnimationFrame(draw);
  }

  async function openMap(file) {
    if (!file || state.busy) return false;
    if (!/\.scmap$/i.test(file.name)) { toast('Choose an .scmap file.', true); return false; }
    if (file.size > 512 * 1024 * 1024) { toast('SCMAP exceeds 512 MB, which this version does not support.', true); return false; }
    state.busy = true; renderUI(false);
    try {
      const bytes = await file.slice(0, 128 * 1024 * 1024).arrayBuffer();
      const map = C.parseSCMap(bytes, file.name);
      const keep = state.map && !state.map.demo && state.map.name === map.name && state.map.width === map.width && state.map.depth === map.depth;
      if (!keep && (dirty()||state.drawing.length) && !confirm('Current changes are unsaved. Opening another map will discard them. Continue?')) return false;
      if (!keep) { state.regions = []; state.selected = -1; state.past = []; state.future = []; state.saved = signature([]); }
      state.map = map; state.notice = keep ? 'Terrain reloaded. Current regions were retained and checked against the new heightmap.' : '';
      if(!keep){state.tool='select';state.drawing=[];state.polyCursor=null;state.selectedVertex=-1;} formBefore = null; prepareBaseGrid(); updateMapHeader(); fit();
      toast(keep ? 'Terrain reloaded; water regions retained.' : 'Map loaded. Add a lake or load existing regions.');
      return true;
    } catch (e) { toast(e.message || 'Could not load the map.', true); return false; }
    finally { state.busy = false; schedule(true, true); }
  }
  function updateMapHeader() {
    const m = state.map; $('empty').hidden = !!m; $('mapName').textContent = m.name;
    if (m.demo) { const tag = document.createElement('span'); tag.className = 'demo-tag'; tag.textContent = 'DEMO'; $('mapName').append(tag); }
    $('mapFacts').textContent = `${f(m.width,0)} × ${f(m.depth,0)} · SCMAP v${m.version} · original water level ${f(m.sea)}${m.waterEnabled ? '' : ' · WATER DISABLED'}`;
  }
  async function importDefinition(file) {
    if (!state.map || !file || state.busy) return;
    state.busy = true; renderUI(false);
    try {
      if (file.size > C.MAX_BYTES) throw new Error('The definition exceeds 4096 bytes.');
      const regions = C.parseDefinition(await file.text());
      if ((dirty()||state.drawing.length) && !confirm('Loading this definition replaces unsaved regions. Continue?')) return;
      const before = capture(); state.regions = regions; state.selected = 0;state.selectedVertex=-1;state.drawing=[];state.polyCursor=null; state.tool = 'select'; record(before);
      const matching = file.name === state.map.name + '.regionalwater';
      state.saved = matching ? signature(regions) : '';
      state.notice = matching ? '' : `Loaded from ${file.name}. Output will use the current map name; check that these regions match its terrain.`;
      toast('Water regions loaded.');
    } catch (e) { toast(e.message || 'Could not load the definition.', true); }
    finally { state.busy = false; schedule(true, true); }
  }
  function save() {
    if (state.busy || state.map?.demo || !state.map) return;
    if(state.drawing.length){toast('Finish the polygon with Enter or cancel with Esc first.',true);return;}
    try {
      const text = C.serialize(state.regions, state.map), name = state.map.name + '.regionalwater';
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' }), url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      state.saved = signature(state.regions); schedule(false, false);
      toast(`Definition sent for download. Place ${name} beside the SCMAP and check its name has no (1).`);
    } catch (e) { toast(e.message, true); $('validationCard').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }
  async function handleFiles(files) {
    if (state.busy) { toast('Please wait for loading to finish.'); return; }
    const maps = [...files].filter(f => /\.scmap$/i.test(f.name)), definitions = [...files].filter(f => /\.regionalwater$/i.test(f.name));
    if (maps.length > 1 || definitions.length > 1) { toast('Open one map and at most one matching water definition.', true); return; }
    if (!maps.length && !definitions.length) { toast('Drop an .scmap or .regionalwater file.', true); return; }
    if (maps.length && !await openMap(maps[0])) return;
    if (definitions.length) { if (!state.map) toast('Open an .scmap map first.', true); else await importDefinition(definitions[0]); }
  }

  function hitCorner(p) {
    const r=state.regions[state.selected];if(!r||!C.validRect(r)||!$('boundsCheck').checked)return null;
    const t=transform();
    if(C.isPolygon(r)){for(let i=0;i<r.points.length;i++)if(Math.hypot(p.px-t.ox-r.points[i].x*t.scale,p.py-t.oz-r.points[i].z*t.scale)<=10)return {vertex:i};}
    else for(const [xk,zk] of [['x0','z0'],['x1','z0'],['x0','z1'],['x1','z1']])if(Math.hypot(p.px-t.ox-r[xk]*t.scale,p.py-t.oz-r[zk]*t.scale)<=10)return {xk,zk};
    return null;
  }
  function nearestEdge(p) {
    const r=state.regions[state.selected];if(!r||!C.isPolygon(r)||!C.validRect(r)||!$('boundsCheck').checked)return null;
    const w=world(p),t=transform();let best=null;
    for(let i=0;i<r.points.length;i++){
      const a=r.points[i],b=r.points[(i+1)%r.points.length],dx=b.x-a.x,dz=b.z-a.z;
      const u=C.clamp(((w.x-a.x)*dx+(w.z-a.z)*dz)/(dx*dx+dz*dz||1),0,1),x=a.x+u*dx,z=a.z+u*dz,distance=Math.hypot(x-w.x,z-w.z)*t.scale;
      if(distance<=10&&(!best||distance<best.distance))best={index:i,x,z,distance};
    }
    return best;
  }
  function cancelDrag() {
    if(!state.drag)return;const d=state.drag;
    if(d.before&&d.type!=='draw'){state.regions=d.before.regions;state.selected=d.before.selected;state.selectedVertex=d.before.selectedVertex??-1;}
    if(d.type==='pan')state.camera=d.camera;
    state.drag=null;if(canvas.hasPointerCapture(d.pointerId))canvas.releasePointerCapture(d.pointerId);schedule(true,true);
  }
  canvas.addEventListener('pointerdown',e=>{
    if(!state.map||state.busy||state.drag||(e.button!==0&&e.button!==1))return;
    const p=point(e),w=world(p);canvas.focus();e.preventDefault();
    const d={pointerId:e.pointerId,start:p,world:w,before:capture()};
    if(e.button===1||state.space)state.drag={...d,type:'pan',camera:{...state.camera}};
    else if(state.tool==='polygon'){
      if(w.x<0||w.z<0||w.x>state.map.width||w.z>state.map.depth)return;
      const q={x:C.snap(w.x,state.map.width),z:C.snap(w.z,state.map.depth)},first=state.drawing[0],t=transform();
      if(first&&state.drawing.length>=3&&Math.hypot((q.x-first.x)*t.scale,(q.z-first.z)*t.scale)<=10){finishPolygon();return;}
      if(state.drawing.some(v=>v.x===q.x&&v.z===q.z))return;
      if(state.drawing.length>=C.MAX_VERTICES){toast('At most 32 vertices. Press Enter to finish or Backspace to remove a vertex.',true);return;}
      state.drawing.push(q);state.polyCursor=q;schedule(false,false);return;
    }else if(state.tool==='draw'){
      if(w.x<0||w.z<0||w.x>state.map.width||w.z>state.map.depth||state.regions.length>=C.MAX_REGIONS)return;
      const x=C.snap(w.x,state.map.width),z=C.snap(w.z,state.map.depth);state.drag={...d,type:'draw',anchor:{x,z},rect:{x0:x,z0:z,x1:x,z1:z}};
    }else{
      const corner=hitCorner(p);
      if(corner){state.selectedVertex=corner.vertex??-1;state.drag={...d,type:corner.vertex!==undefined?'vertex':'resize',corner,original:C.cloneRegion(state.regions[state.selected])};}
      else{
        let hit=-1;
        if(state.selected>=0&&(C.contains(state.regions[state.selected],w.x,w.z)||nearestEdge(p)))hit=state.selected;
        else for(let i=state.regions.length-1;i>=0;i--)if(C.contains(state.regions[i],w.x,w.z)){hit=i;break;}
        if(hit<0){state.selected=-1;state.selectedVertex=-1;schedule(false,true);return;}
        state.selected=hit;state.selectedVertex=-1;d.before.selected=hit;d.before.selectedVertex=-1;state.drag={...d,type:'move',original:C.cloneRegion(state.regions[hit])};
      }
    }
    canvas.setPointerCapture(e.pointerId);schedule(false,true);
  });
  canvas.addEventListener('pointermove',e=>{
    if(!state.map)return;const p=point(e),w=world(p),d=state.drag;
    if(w.x>=0&&w.z>=0&&w.x<=state.map.width&&w.z<=state.map.depth){const h=C.effectiveHeightAt(state.map,state.regions,w.x,w.z),level=C.waterAt(state.map,state.regions,w.x,w.z);
      $('coords').textContent=`X ${f(w.x,0)}   Z ${f(w.z,0)}   ·   terrain ${f(h)}   ·   water level ${state.map.waterEnabled?f(level):'disabled'}   ·   depth ${state.map.waterEnabled?f(Math.max(0,level-h)):'—'}`;}
    if(!d){
      if(state.tool==='polygon'){state.polyCursor={x:C.snap(w.x,state.map.width),z:C.snap(w.z,state.map.depth)};drawCanvas();}
      canvas.style.cursor=state.space?'grab':state.tool==='draw'||state.tool==='polygon'?'crosshair':hitCorner(p)?'move':'default';return;
    }
    if(e.pointerId!==d.pointerId)return;
    if(d.type==='pan'){state.camera.x=d.camera.x+p.px-d.start.px;state.camera.y=d.camera.y+p.py-d.start.py;drawCanvas();return;}
    if(d.type==='draw'){const x=C.snap(w.x,state.map.width),z=C.snap(w.z,state.map.depth);d.rect={x0:Math.min(x,d.anchor.x),z0:Math.min(z,d.anchor.z),x1:Math.max(x,d.anchor.x),z1:Math.max(z,d.anchor.z)};drawCanvas();return;}
    const r=state.regions[state.selected],o=d.original;
    if(d.type==='move'){
      const dx=C.clamp(Math.round((w.x-d.world.x)/2)*2,-o.x0,Math.floor(state.map.width/2)*2-o.x1),dz=C.clamp(Math.round((w.z-d.world.z)/2)*2,-o.z0,Math.floor(state.map.depth/2)*2-o.z1);
      if(C.isPolygon(o)){r.points=o.points.map(v=>({x:v.x+dx,z:v.z+dz}));C.updateBounds(r);}
      else Object.assign(r,{x0:o.x0+dx,x1:o.x1+dx,z0:o.z0+dz,z1:o.z1+dz});
    }else if(d.type==='vertex'){
      r.points[d.corner.vertex]={x:C.snap(w.x,state.map.width),z:C.snap(w.z,state.map.depth)};C.updateBounds(r);
    }else if(d.type==='resize'){
      const x=C.snap(w.x,state.map.width),z=C.snap(w.z,state.map.depth),{xk,zk}=d.corner;r[xk]=xk==='x0'?Math.min(x,o.x1-2):Math.max(x,o.x0+2);r[zk]=zk==='z0'?Math.min(z,o.z1-2):Math.max(z,o.z0+2);
    }
    schedule(true,true);drawCanvas();
  });
  function endDrag(e){
    const d=state.drag;if(!d||e.pointerId!==d.pointerId)return;state.drag=null;if(canvas.hasPointerCapture(d.pointerId))canvas.releasePointerCapture(d.pointerId);
    if(d.type==='draw'){
      if(d.rect.x1-d.rect.x0>=2&&d.rect.z1-d.rect.z0>=2){const height=Math.round((state.map.sea+12)*2)/2;state.regions.push({...d.rect,height,mode:'preserve'});state.selected=state.regions.length-1;state.selectedVertex=-1;state.tool='select';record(d.before);}
      else toast('Drag to draw a region. Minimum size is 2 × 2.');
    }else if(d.type!=='pan')record(d.before);schedule(true,true);
  }
  canvas.addEventListener('dblclick',e=>{
    if(state.busy||!state.map)return;
    if(state.tool==='polygon'){finishPolygon();return;}
    if(state.tool!=='select')return;const edge=nearestEdge(point(e)),r=state.regions[state.selected];if(!edge||!r)return;
    if(r.points.length>=C.MAX_VERTICES){toast('The polygon already has 32 vertices.',true);return;}
    const v={x:C.snap(edge.x,state.map.width),z:C.snap(edge.z,state.map.depth)};if(r.points.some(p=>p.x===v.x&&p.z===v.z))return;
    change(()=>{r.points.splice(edge.index+1,0,v);C.updateBounds(r);state.selectedVertex=edge.index+1;});
  });
  canvas.addEventListener('pointerup',endDrag);
  canvas.addEventListener('pointercancel',()=>cancelDrag());
  canvas.addEventListener('lostpointercapture',()=>{if(state.drag)cancelDrag();});
  canvas.addEventListener('wheel',e=>{if(!state.map)return;e.preventDefault();const p=point(e);zoom(Math.exp(-C.clamp(e.deltaY,-200,200)*.002),p.px,p.py);},{passive:false});
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  wrap.addEventListener('dragover',e=>{e.preventDefault();wrap.classList.add('dragover');});
  wrap.addEventListener('dragleave',e=>{if(!wrap.contains(e.relatedTarget))wrap.classList.remove('dragover');});
  wrap.addEventListener('drop',e=>{e.preventDefault();wrap.classList.remove('dragover');handleFiles(e.dataTransfer.files);});
  // Dropping a map anywhere in the window must not navigate away from work.
  document.addEventListener('dragover',e=>e.preventDefault());
  document.addEventListener('drop',e=>{if(!wrap.contains(e.target)){e.preventDefault();handleFiles(e.dataTransfer.files);}});

  $('openMapBtn').onclick=$('emptyOpenBtn').onclick=()=>{$('mapInput').value='';$('mapInput').click();};
  $('mapInput').onchange=e=>openMap(e.target.files[0]);
  $('importBtn').onclick=()=>{$('definitionInput').value='';$('definitionInput').click();};
  $('definitionInput').onchange=e=>importDefinition(e.target.files[0]);
  $('saveBtn').onclick=save; $('undoBtn').onclick=undo;$('redoBtn').onclick=redo;
  $('selectBtn').onclick=()=>setTool('select');$('drawBtn').onclick=()=>setTool('draw');$('polygonBtn').onclick=()=>setTool('polygon');$('finishPolygonBtn').onclick=finishPolygon;
  $('convertBtn').onclick=()=>{const r=state.regions[state.selected];if(!r||C.isPolygon(r))return;change(()=>{r.points=C.vertices(r);r.mode='preserve';state.selectedVertex=-1;});};
  $('zoomInBtn').onclick=()=>zoom(1.3);$('zoomOutBtn').onclick=()=>zoom(1/1.3);$('fitBtn').onclick=fit;
  for(const id of ['waterCheck','contourCheck'])$(id).onchange=()=>schedule(true,false);
  for(const id of ['boundsCheck','riskCheck'])$(id).onchange=()=>drawCanvas();
  $('demoBtn').onclick=()=>{const d=C.demo();state.map=d.map;state.regions=d.regions;state.selected=0;state.saved=signature(d.regions);state.past=[];state.future=[];prepareBaseGrid();updateMapHeader();fit();schedule(true,true);toast('Demo ready. Move the lakes or change their water levels.');};
  $('helpBtn').onclick=()=>$('helpDialog').showModal();$('closeHelpBtn').onclick=()=>$('helpDialog').close();
  $('helpDialog').addEventListener('click',e=>{if(e.target===$('helpDialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
  function removeSelected(){if(state.selected<0)return;change(()=>{state.regions.splice(state.selected,1);state.selected=Math.min(state.selected,state.regions.length-1);state.selectedVertex=-1;});}
  $('deleteBtn').onclick=removeSelected;
  for(const [id,key] of [['heightInput','height'],['x0Input','x0'],['z0Input','z0'],['x1Input','x1'],['z1Input','z1']]) {
    const input=$(id);
    input.addEventListener('focus',()=>{formBefore=capture();});
    input.addEventListener('input',()=>{
      const r=state.regions[state.selected];if(!r||state.busy)return;
      const text=input.value.trim().replace(',','.');r[key]=text!==''&&/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)?Number(text):NaN;
      schedule(true,false);
    });
    input.addEventListener('change',()=>{if(formBefore){record(formBefore);formBefore=null;}schedule(true,false);});
    input.addEventListener('blur',()=>{if(formBefore){record(formBefore);formBefore=null;}schedule(false,false);});
  }
  $('modeInput').onchange=e=>{if(state.selected<0)return;change(()=>{state.regions[state.selected].mode=e.target.value;});};
  function stepHeight(delta){const r=state.regions[state.selected];if(!r)return;change(()=>{r.height=(Number.isFinite(r.height)?Math.round(r.height*1000):0)/1000+delta;});}
  $('heightUpBtn').onclick=()=>stepHeight(.5);$('heightDownBtn').onclick=()=>stepHeight(-.5);
  document.addEventListener('keydown',e=>{
    if($('helpDialog').open)return;
    const input=editing(e.target),mod=e.ctrlKey||e.metaKey;
    if(e.key==='Escape'){if(state.drag)cancelDrag();else if(state.tool==='draw'||state.tool==='polygon')setTool('select');return;}
    if(mod&&e.key.toLowerCase()==='s'){e.preventDefault();if(document.activeElement?.blur)document.activeElement.blur();save();return;}
    if(input)return;
    if(state.tool==='polygon'&&!state.busy){if(e.key==='Enter'){e.preventDefault();finishPolygon();return;}if(e.key==='Backspace'||e.key==='Delete'){e.preventDefault();state.drawing.pop();schedule(false,false);return;}}
    if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();return;}
    if(mod&&e.key.toLowerCase()==='y'){e.preventDefault();redo();return;}
    if(e.code==='Space'&&(e.target===canvas||e.target===document.body)){state.space=true;e.preventDefault();canvas.style.cursor='grab';return;}
    if(state.busy||!state.map||state.drag)return;
    if(e.key==='Delete'||e.key==='Backspace'){if(state.selected>=0){e.preventDefault();const r=state.regions[state.selected];if(C.isPolygon(r)&&state.selectedVertex>=0)removeVertex(state.selectedVertex);else removeSelected();}return;}
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)&&state.selected>=0){
      const r=state.regions[state.selected];if(!C.validRect(r))return;e.preventDefault();const step=e.shiftKey?10:2;
      let dx=e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0,dz=e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0;
      if(C.isPolygon(r)&&state.selectedVertex>=0){const v=r.points[state.selectedVertex];change(()=>{v.x=C.snap(v.x+dx,state.map.width);v.z=C.snap(v.z+dz,state.map.depth);C.updateBounds(r);});}
      else{dx=C.clamp(dx,-r.x0,Math.floor(state.map.width/2)*2-r.x1);dz=C.clamp(dz,-r.z0,Math.floor(state.map.depth/2)*2-r.z1);
        change(()=>{if(C.isPolygon(r)){r.points=r.points.map(p=>({x:p.x+dx,z:p.z+dz}));C.updateBounds(r);}else{r.x0+=dx;r.x1+=dx;r.z0+=dz;r.z1+=dz;}});}

    }
  });
  document.addEventListener('keyup',e=>{if(e.code==='Space'){state.space=false;canvas.style.cursor=state.tool==='draw'||state.tool==='polygon'?'crosshair':'default';}});
  window.addEventListener('blur',()=>{state.space=false;if(state.drag)cancelDrag();});
  window.addEventListener('beforeunload',e=>{if(dirty()||state.map&&!state.map.demo&&state.drawing.length){e.preventDefault();e.returnValue='';}});
  new ResizeObserver(()=>drawCanvas()).observe(wrap);
  // Read-only diagnostics for verification; no file-writing or hidden network API.
  window.RWEditor={getState:()=>({map:state.map?{name:state.map.name,width:state.map.width,depth:state.map.depth,sea:state.map.sea,demo:state.map.demo}:null,regions:state.regions.map(C.cloneRegion),selectedVertex:state.selectedVertex,drawing:state.drawing.map(p=>({...p})),selected:state.selected,errors:state.errors.map(e=>({...e})),warnings:state.warnings.map(w=>({...w})),dirty:!!dirty()})};
  state.saved=signature([]);renderUI(true);drawCanvas();
})();

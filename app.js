'use strict';
/* Self-contained canvas viewer for the stitched Arulco world map.
   One strategic 16x16 square grid (A-P rows down, 1-16 columns across). A level switcher
   swaps the imagery between Surface and the underground basement levels (B1/B2/B3).
   Grid cells are drawn 2:1 wide to match JA2's tactical proportions (iso tile = 40x20). */
(function () {
  const DATA = window.JA2_DATA;
  const loading = document.getElementById('loading');
  if (!DATA) { loading.textContent = 'data.js not found — run `node build/build.js` first.'; return; }
  const M = DATA.manifest, OV = DATA.overlays;
  const LETTERS = M.grid.letters;
  const GW = M.grid.cellW, GH = M.grid.cellH, BOUNDS = M.grid.bounds;
  const ASPECT = 1.0;               // tiles are rendered natively at 2:1 (cellW:cellH = 2:1), no display stretch
  const DETAIL_MIN_ZOOM = 0.12;
  const PYR = M.pyramid, PT_W = PYR ? PYR.tile[0] : GW, PT_H = PYR ? PYR.tile[1] : GH, PEXT = (PYR && PYR.ext) || 'webp';
  const LEVEL_Z = { surface: 0, b1: 1, b2: 2, b3: 3 }; // map level id -> sector Z
  const MC = { town: '#f0c674', mine: '#e08a3c', sam: '#d9534f', heli: '#4ba3d9', ship: '#9b7fd9', garrison: '#ff6b6b', patrol: '#50b4e6', poi: '#3fd0c0', creatures: '#cf6fd0', roads: '#caa46a', terrain: '#7faa4a', npc: '#5fcf8f', loot: '#c79a5b' }; // marker colors
  // terrain (biome) tint colors by MovementCosts <Here> type
  const TC = { TOWN: '#999999', ROAD: '#caa46a', PLAINS: '#9bbf5a', SAND: '#d9c47a', SPARSE: '#7faa4a', DENSE: '#3f6e2e', SWAMP: '#5a6b3a', WATER: '#3a73b5', HILLS: '#a07b4a', TROPICS: '#3fa06a', FARMLAND: '#b7c24a', COASTAL: '#5ab0c0', GROUNDBARRIER: '#555555', EDGEOFWORLD: '#1a1a1a', NS_RIVER: '#3a73b5', EW_RIVER: '#3a73b5' };
  const terrainColor = (h) => h ? (TC[h] || TC[h.split('_')[0]] || '#888888') : null;
  // Marker icon per indicator type, drawn as a solid-COLOUR silhouette (emoji tinted via source-atop
  // compositing) so each indicator shows in its legend colour. Cached by glyph+colour+size.
  const ICON = { mine: '⛏', sam: '🚀', heli: '🚁', ship: '✈', garrison: '⚔', poi: '★', creature: '🐛', queen: '👑', npc: '🧍', dealer: '💲', loot: '📦' };
  const iconCache = new Map();
  function coloredIcon(ch, color, px) {
    const key = ch + color + px;
    let out = iconCache.get(key);
    if (out) return out;
    // Render the glyph large + tint to a solid colour.
    const base = Math.ceil(px * 2.6), fs = Math.round(px * 1.6);
    const tmp = document.createElement('canvas'); tmp.width = tmp.height = base;
    const tg = tmp.getContext('2d');
    tg.font = fs + 'px sans-serif'; tg.textAlign = 'center'; tg.textBaseline = 'middle';
    tg.fillText(ch, base / 2, base / 2);
    tg.globalCompositeOperation = 'source-atop'; tg.fillStyle = color; tg.fillRect(0, 0, base, base);
    // Measure the actual ink bounds and NORMALISE so every glyph (emoji vs text-style ✈/⚔/★) ends up
    // the same visual size — its longest side scaled to px — centred in a px*1.35 box.
    const S = Math.ceil(px * 1.35); out = document.createElement('canvas'); out.width = out.height = S;
    const d = tg.getImageData(0, 0, base, base).data;
    let minX = base, minY = base, maxX = -1, maxY = -1;
    for (let y = 0; y < base; y++) for (let x = 0; x < base; x++) if (d[(y * base + x) * 4 + 3] > 16) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (maxX >= minX) {
      const iw = maxX - minX + 1, ih = maxY - minY + 1, k = px / Math.max(iw, ih), dw = iw * k, dh = ih * k;
      out.getContext('2d').drawImage(tmp, minX, minY, iw, ih, (S - dw) / 2, (S - dh) / 2, dw, dh);
    }
    iconCache.set(key, out);
    return out;
  }

  const canvas = document.getElementById('map');
  const ctx = canvas.getContext('2d');
  function codeToGrid(code) { const m = /^([A-P])(\d{1,2})/.exec(code); return m ? { sx: +m[2] - 1, sy: LETTERS.indexOf(m[1]) } : null; }

  // ---- levels ----
  const levels = {};
  for (const id of M.levelOrder) {
    const lv = M.levels[id], src = 'dist/' + lv.overview.image;
    // surface reuses the preload <img>; point it at the manifest's overview (manifest drives png vs webp).
    const el = id === 'surface' ? document.getElementById('ov-surface') : null;
    if (el && !el.getAttribute('src').endsWith(lv.overview.image)) el.src = src;
    levels[id] = { id, label: lv.label, sectors: lv.sectors, byCode: new Map(lv.sectors.map((s) => [s.code, s])), img: el, src,
      srcRoof: lv.overview.imageRoof ? 'dist/' + lv.overview.imageRoof : null, imgRoof: null };
  }
  let cur = levels[M.defaultLevel] || levels[M.levelOrder[0]];

  // ---- view + transforms (X stretched by ASPECT) ----
  let cw = 0, ch = 0, dpr = 1, minZoom = 0.01;
  const view = { x: 0, y: 0, zoom: 1 };
  const toScreen = (wx, wy) => ({ x: (wx - view.x) * view.zoom * ASPECT + cw / 2, y: (wy - view.y) * view.zoom + ch / 2 });
  const toWorld = (px, py) => ({ x: (px - cw / 2) / (view.zoom * ASPECT) + view.x, y: (py - ch / 2) / view.zoom + view.y });
  // Keep the map in view: the screen centre must always stay over the map, so the map's edges/corners
  // can be dragged to the centre of the screen but no further.
  function clampView() {
    view.x = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, view.x));
    view.y = Math.max(BOUNDS.minY, Math.min(BOUNDS.maxY, view.y));
  }

  // ---- grid geometry ----
  const center = (sx, sy) => ({ x: sx * GW + GW / 2, y: sy * GH + GH / 2 });
  const outline = (sx, sy) => [{ x: sx * GW, y: sy * GH }, { x: sx * GW + GW, y: sy * GH }, { x: sx * GW + GW, y: sy * GH + GH }, { x: sx * GW, y: sy * GH + GH }];
  const pick = (wx, wy) => ({ sx: Math.floor(wx / GW), sy: Math.floor(wy / GH) });
  function drawGrid() {
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i <= 16; i++) {
      let a = toScreen(i * GW, 0), b = toScreen(i * GW, 16 * GH); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      a = toScreen(0, i * GH); b = toScreen(16 * GW, i * GH); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.fillStyle = '#f0c674'; ctx.font = `bold ${Math.max(14, Math.min(36, 0.26 * GH * view.zoom))}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let c = 1; c <= 16; c++) { const p = toScreen((c - 0.5) * GW, -0.35 * GH); ctx.fillText(String(c), p.x, p.y); }
    for (let r = 0; r < 16; r++) { const p = toScreen(-0.45 * GW, (r + 0.5) * GH); ctx.fillText(LETTERS[r], p.x, p.y); }
  }

  // ---- image loading ----
  function imgReady(img) { return img && img.complete && img.naturalWidth > 0; }
  function ensureLevelImg(lv) {
    if (!lv.img) { lv.img = new Image(); lv.img.src = lv.src; }
    // Roof-overlay overview (surface only): lazily load so the Roofs toggle can composite it over the base.
    if (lv.srcRoof && !lv.imgRoof) { lv.imgRoof = new Image(); lv.imgRoof.onload = schedule; lv.imgRoof.onerror = () => { lv.roofErr = true; schedule(); }; lv.imgRoof.src = lv.srcRoof; if (lv.imgRoof.decode) lv.imgRoof.decode().then(schedule).catch(() => {}); }
    const img = lv.img;
    const ready = () => { loading.classList.add('hidden'); schedule(); };
    if (imgReady(img)) loading.classList.add('hidden');
    else img.addEventListener('load', ready, { once: true });
    if (img.decode) img.decode().then(ready).catch(() => {});
    return img;
  }
  ensureLevelImg(cur);

  // LRU cache of decoded detail tiles. At these resolutions each tile decodes to many MB, so panning a
  // big map can pile up decoded bitmaps faster than GC frees them -> the browser slows then hangs. Two
  // fixes: (a) decode via createImageBitmap — async and OFF the main thread, so panning never blocks on
  // a decode (tiles just stream in), and (b) close() a tile's bitmap the instant it's evicted, freeing
  // the memory deterministically rather than waiting for GC. Budget ~512 MB, sized by the PYRAMID TILE
  // (not the whole sector), so the cache holds far more tiles than the ~10-20 ever on screen — revisits
  // are instant while memory stays bounded. Don't prefetch off-screen tiles.
  const detailCache = new Map(); // image -> { bmp: ImageBitmap | null }  (entry present while decoding)
  const DETAIL_CACHE_MAX = Math.max(8, Math.floor(512 * 1048576 / (PT_W * PT_H * 4)));
  function getDetail(image) {
    let e = detailCache.get(image);
    if (e) { detailCache.delete(image); detailCache.set(image, e); return e.bmp; } // touch -> most-recently-used
    e = { bmp: null, dead: false };
    detailCache.set(image, e);
    fetch('dist/' + image).then((r) => r.blob()).then(createImageBitmap).then((bmp) => {
      if (e.dead) { bmp.close(); return; } // evicted while still decoding -> free it now (else it leaks)
      e.bmp = bmp; schedule();
    }).catch(() => {});
    while (detailCache.size > DETAIL_CACHE_MAX) { // evict oldest; free its bitmap now, or mark it to free on decode
      const k = detailCache.keys().next().value, ev = detailCache.get(k);
      detailCache.delete(k); ev.dead = true; if (ev.bmp) ev.bmp.close();
    }
    return e.bmp; // null until decoded; the draw loop just skips it until then
  }

  // ---- controls ----
  const levelSel = document.getElementById('level');
  for (const id of M.levelOrder) { const o = document.createElement('option'); o.value = id; o.textContent = levels[id].label; levelSel.appendChild(o); }
  levelSel.value = cur.id;
  levelSel.addEventListener('change', () => {
    cur = levels[levelSel.value];
    if (!imgReady(ensureLevelImg(cur))) loading.classList.remove('hidden');
    if (selected) showInfo(selected.sx, selected.sy); // refresh readout for the new level
    schedule();
  });
  // Layer visibility (grid/detail are plain checkboxes; the rest are interactive legend rows).
  const layers = { grid: true, detail: true, roofs: true, cool: false, town: true, mine: true, sam: true, heli: true, ship: true, garrison: false, patrol: false, poi: false, npc: false, loot: false, creatures: false, roads: false, terrain: false };
  const topToggles = [['grid', 't-grid'], ['detail', 't-detail'], ['roofs', 't-roofs']];
  for (const [k, id] of topToggles) {
    const el = document.getElementById(id); el.checked = layers[k]; el.addEventListener('change', () => { layers[k] = el.checked; schedule(); });
  }
  // The map's layer state is `layers` (above) — the source of truth. Browsers restore checkbox state on
  // reload/bfcache; ignore that and re-assert our defaults onto the boxes so the boxes and map never desync.
  window.addEventListener('pageshow', () => { for (const [k, id] of topToggles) { const el = document.getElementById(id); if (el) el.checked = layers[k]; } schedule(); });
  // Legend doubles as per-layer visibility toggles.
  (function buildLegend() {
    const el = document.getElementById('legend'); if (!el) return;
    el.innerHTML = '<div class="leg-title">Layers</div>';
    const rows = [
      ['town', MC.town, 'Town', 'dot'], ['mine', MC.mine, 'Mine', 'icon'], ['sam', MC.sam, 'SAM site', 'icon'],
      ['heli', MC.heli, 'Heli refuel', 'icon'], ['ship', MC.ship, 'Airport (Bobby Ray)', 'icon'],
      ['garrison', MC.garrison, 'Enemy garrison', 'icon'], ['patrol', MC.patrol, 'Patrol routes', 'line'],
      ['poi', MC.poi, 'Quests & POIs', 'icon'], ['npc', MC.npc, 'NPCs & dealers', 'icon'], ['loot', MC.loot, 'Loot (map items)', 'icon'], ['creatures', MC.creatures, 'Creature zones', 'icon'],
      ['roads', MC.roads, 'Roads & rivers', 'line'], ['terrain', MC.terrain, 'Terrain (biome)', 'dot'], ['cool', null, 'Difficulty 0 → 20', 'grad'],
    ];
    for (const [key, color, label, kind] of rows) {
      const row = document.createElement('label'); row.className = 'leg-row' + (layers[key] ? '' : ' off');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = layers[key]; cb.dataset.layer = key;
      let sw; // swatch: a colour silhouette icon, a dot, a line sample, or the difficulty gradient
      if (kind === 'icon') {
        if (key === 'npc') { // this layer uses two icons (person = NPC, $ = dealer) — show both
          sw = document.createElement('span'); sw.className = 'leg-pair';
          sw.append(coloredIcon(ICON.npc, color, 16), coloredIcon(ICON.dealer, color, 16));
        } else { sw = coloredIcon(key === 'creatures' ? ICON.creature : ICON[key], color, 20); sw.className = 'leg-ic'; }
      }
      else { sw = document.createElement('span'); sw.className = kind === 'grad' ? 'leg-grad' : kind === 'line' ? 'leg-line' : 'leg-dot'; if (kind === 'line') sw.style.background = color; else if (kind === 'dot') sw.style.setProperty('--c', color); }
      const txt = document.createElement('span'); txt.textContent = label;
      row.append(cb, sw, txt);
      cb.addEventListener('change', () => { layers[key] = cb.checked; row.classList.toggle('off', !cb.checked); schedule(); });
      el.appendChild(row);
    }
  })();

  // ---- help dialog + collapsible panel ----
  (function ui() {
    const help = document.getElementById('help'), helpBtn = document.getElementById('help-btn');
    if (help && helpBtn) {
      helpBtn.addEventListener('click', () => { if (help.showModal) help.showModal(); else help.setAttribute('open', ''); });
      const closeBtn = document.getElementById('help-close');
      if (closeBtn) closeBtn.addEventListener('click', () => help.close());
      help.addEventListener('click', (e) => { if (e.target === help) help.close(); }); // click backdrop to close
    }
    const panel = document.getElementById('panel'), cBtn = document.getElementById('collapse-btn');
    if (panel && cBtn) {
      const setCollapsed = (v) => {
        panel.classList.toggle('collapsed', v);
        cBtn.textContent = v ? '☰' : '‹';
        cBtn.title = v ? 'Expand panel' : 'Collapse panel';
        try { localStorage.setItem('ja2PanelCollapsed', v ? '1' : '0'); } catch (e) {}
      };
      cBtn.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
      try { if (localStorage.getItem('ja2PanelCollapsed') === '1') setCollapsed(true); } catch (e) {}
    }
    // Reset view -> fit the whole map
    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) resetBtn.addEventListener('click', () => { fit(); clampView(); markInteracting(); schedule(); scheduleURLSync(); });
    // Copy a shareable link to the current view + selection
    const copyBtn = document.getElementById('copy-link');
    function fallbackCopy(text, done) {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) {} ta.remove();
    }
    if (copyBtn) copyBtn.addEventListener('click', () => {
      syncURL(); // ensure the hash reflects the current view before copying
      const done = () => { copyBtn.textContent = '✓ Copied'; copyBtn.classList.add('copied'); setTimeout(() => { copyBtn.textContent = '🔗 Copy link'; copyBtn.classList.remove('copied'); }, 1300); };
      const text = location.href;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      else fallbackCopy(text, done);
    });
    // Keyboard controls: arrows / WASD pan, +/- zoom, F fit, Esc deselect
    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (help && help.open)) return;
      if (e.key === 'Escape') { deselect(); return; }
      const sx = 90 / (view.zoom * ASPECT), sy = 90 / view.zoom;
      let handled = true;
      switch (e.key) {
        case 'ArrowLeft': case 'a': case 'A': view.x -= sx; break;
        case 'ArrowRight': case 'd': case 'D': view.x += sx; break;
        case 'ArrowUp': case 'w': case 'W': view.y -= sy; break;
        case 'ArrowDown': case 's': case 'S': view.y += sy; break;
        case '+': case '=': view.zoom = Math.min(4, view.zoom * 1.25); break;
        case '-': case '_': view.zoom = Math.max(minZoom, view.zoom / 1.25); break;
        case 'f': case 'F': fit(); break;
        default: handled = false;
      }
      if (handled) { clampView(); markInteracting(); schedule(); scheduleURLSync(); e.preventDefault(); }
    });
  })();

  // ---- render ----
  let hovered = null, selected = null, pending = false, interacting = false, interactTimer = null;
  function schedule() { if (!pending) { pending = true; requestAnimationFrame(draw); } }
  // While actively panning/zooming, skip the expensive layers (detail tiles, per-sector tints) and
  // draw only the cheap overview + markers; once motion settles, redraw at full quality.
  function markInteracting() {
    interacting = true;
    if (interactTimer) clearTimeout(interactTimer);
    interactTimer = setTimeout(() => { interacting = false; schedule(); }, 120);
  }
  function draw() {
    pending = false;
    const live = !interacting; // full quality only when not actively moving
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0c0e'; ctx.fillRect(0, 0, cw, ch);
    const zx = view.zoom * ASPECT, zy = view.zoom;

    // When roofs are on (and this level has a roof overlay), draw the roofless base + roof overlay TOGETHER,
    // only once BOTH have decoded — otherwise the base shows first and buildings flash roofless on reload.
    // (roofErr falls back to base-only so a failed roof image can't leave the overview blank.)
    const wantRoofOv = layers.roofs && cur.srcRoof && !cur.roofErr;
    if (imgReady(cur.img) && (!wantRoofOv || imgReady(cur.imgRoof))) {
      const tl = toScreen(BOUNDS.minX, BOUNDS.minY);
      ctx.imageSmoothingEnabled = live; // nearest-neighbour while moving is cheaper; smooth on settle
      ctx.drawImage(cur.img, tl.x, tl.y, BOUNDS.width * zx, BOUNDS.height * zy);
      if (wantRoofOv) ctx.drawImage(cur.imgRoof, tl.x, tl.y, BOUNDS.width * zx, BOUNDS.height * zy);
    }

    if (layers.detail && view.zoom >= DETAIL_MIN_ZOOM && live && PYR) {
      ctx.imageSmoothingEnabled = true;
      // Pick the pyramid level whose native sector width is the smallest >= the on-screen sector width
      // (tiles at least 1:1 -> crisp); fall back to the highest level when zoomed in past native.
      const dispW = GW * zx;
      let L = PYR.levels[0];
      for (const lv of PYR.levels) { L = lv; if (lv.w >= dispW) break; }
      const twW = GW / L.cols, twH = GH / L.rows; // world units covered by one tile at this level
      for (const s of cur.sectors) {
        const sp = toScreen(s.gx, s.gy);
        if (sp.x + GW * zx < 0 || sp.y + GH * zy < 0 || sp.x > cw || sp.y > ch) continue; // sector off-screen
        for (let row = 0; row < L.rows; row++) for (let col = 0; col < L.cols; col++) {
          const tp = toScreen(s.gx + col * twW, s.gy + row * twH), tw = twW * zx, th = twH * zy;
          if (tp.x + tw < 0 || tp.y + th < 0 || tp.x > cw || tp.y > ch) continue; // load only on-screen tiles
          const key = L.z + '_' + col + '_' + row;
          const hasRoof = layers.roofs && s.roofTiles && s.roofTiles.indexOf(key) >= 0;
          const bmp = getDetail('sectors/' + s.tiles + '/z' + key + '.' + PEXT);
          // Roofed tiles: draw the roofless base + roof tile TOGETHER, only once both have decoded, so a
          // tile never flashes roofless while streaming in (the lower pyramid level / overview shows through).
          const rb = hasRoof ? getDetail('sectors/' + s.tiles + '/z' + key + '_roof.' + PEXT) : null;
          if (hasRoof) {
            if (bmp && rb) { ctx.drawImage(bmp, tp.x, tp.y, tw + 1, th + 1); ctx.drawImage(rb, tp.x, tp.y, tw + 1, th + 1); } // +1px overlap hides seams
          } else if (bmp) {
            ctx.drawImage(bmp, tp.x, tp.y, tw + 1, th + 1);
          }
        }
      }
    }

    if (layers.terrain && cur.id === 'surface' && live) drawTerrain();
    if (layers.cool && live) drawCoolness();
    if (layers.grid) drawGrid();
    if (cur.id !== 'surface') drawSectorOutlines();
    if (hovered) drawOutline(hovered.sx, hovered.sy, 'rgba(240,198,116,0.95)', 2);
    if (cur.id === 'surface') {
      if (layers.roads && live) drawRoads();
      if (layers.patrol && live) drawPatrols();
      if (layers.town) { drawTownOutlines(); for (const t of OV.towns) { const c = centroid(t.sectors); if (c) centerLabel(c.x, c.y, t.name, '#ffe9b0'); } }
    }
    drawSectorIcons(); // colour-silhouette icons fanned along the top of each sector (no dots)
    if (selected) drawSelection(); // selected-sector highlight, always on top
  }
  // Highlight the currently-selected sector: faint fill + double stroke so it reads on any background.
  function drawSelection() {
    const c = outline(selected.sx, selected.sy).map((p) => toScreen(p.x, p.y));
    ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y); ctx.closePath();
    ctx.fillStyle = 'rgba(79,210,255,0.13)'; ctx.fill();
    drawOutline(selected.sx, selected.sy, 'rgba(0,0,0,0.8)', 6);
    drawOutline(selected.sx, selected.sy, '#4fd2ff', 3);
  }

  function drawOutline(sx, sy, color, width) {
    const pts = outline(sx, sy).map((p) => toScreen(p.x, p.y));
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); ctx.closePath();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }
  // Centered text label (no dot) — used for town names.
  function centerLabel(wx, wy, text, color) {
    if (view.zoom <= 0.035) return;
    const p = toScreen(wx, wy);
    ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(text, p.x, p.y);
    ctx.fillStyle = color || '#ffe9b0'; ctx.fillText(text, p.x, p.y);
  }
  function centroid(codes) {
    let x = 0, y = 0, n = 0;
    for (const c of codes) { const g = codeToGrid(c); if (g) { const p = center(g.sx, g.sy); x += p.x; y += p.y; n++; } }
    return n ? { x: x / n, y: y / n } : null;
  }
  function drawTownOutlines() {
    for (const t of OV.towns) {
      const set = new Set(t.sectors);
      const segs = [];
      for (const code of t.sectors) {
        const g = codeToGrid(code); if (!g) continue;
        const c = outline(g.sx, g.sy).map((p) => toScreen(p.x, p.y)); // [TL, TR, BR, BL]
        const edges = [[0, 1, 0, -1], [1, 2, 1, 0], [2, 3, 0, 1], [3, 0, -1, 0]]; // from, to, dx, dy
        for (const [a, b, dx, dy] of edges) {
          const nx = g.sx + dx, ny = g.sy + dy;
          const inTown = nx >= 0 && nx < 16 && ny >= 0 && ny < 16 && set.has(LETTERS[ny] + (nx + 1));
          if (!inTown) segs.push([c[a], c[b]]);
        }
      }
      for (const [w, color] of [[4, 'rgba(0,0,0,0.6)'], [2, '#f0c674']]) {
        ctx.lineWidth = w; ctx.strokeStyle = color; ctx.beginPath();
        for (const [p, q] of segs) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
        ctx.stroke();
      }
    }
  }
  // On basement levels, outline the cells that actually have a map (they're sparse and all dark).
  function drawSectorOutlines() {
    for (const [w, color] of [[3, 'rgba(0,0,0,0.5)'], [1.5, 'rgba(240,198,116,0.7)']]) {
      ctx.lineWidth = w; ctx.strokeStyle = color; ctx.beginPath();
      for (const s of cur.sectors) {
        const c = outline(s.sx, s.sy).map((p) => toScreen(p.x, p.y));
        ctx.moveTo(c[0].x, c[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y); ctx.closePath();
      }
      ctx.stroke();
    }
  }
  // Difficulty/"coolness" heatmap: tint each sector green(easy)->red(hard), 0-20.
  function drawCoolness() {
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.font = `bold ${Math.max(10, Math.min(26, 0.2 * GH * view.zoom))}px sans-serif`;
    const showNum = view.zoom > 0.028;
    for (const code in OV.coolness) {
      const g = codeToGrid(code); if (!g) continue;
      const v = OV.coolness[code];
      const c = outline(g.sx, g.sy).map((p) => toScreen(p.x, p.y)); // [TL, TR, BR, BL]
      ctx.fillStyle = `hsla(${120 * (1 - v / 20)},75%,45%,0.4)`;
      ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y); ctx.closePath(); ctx.fill();
      if (showNum) {
        const px = c[2].x - (c[1].x - c[0].x) * 0.07, py = c[2].y - (c[3].y - c[0].y) * 0.08; // bottom-right corner
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.strokeText(v, px, py);
        ctx.fillStyle = '#fff'; ctx.fillText(v, px, py);
      }
    }
  }
  // All point indicators as colour-silhouette icons, fanned along the TOP of their sector (no dots).
  // Surface: mine/sam/heli/ship/garrison/poi. Any level: creatures (cells filtered by sector Z).
  function drawSectorIcons() {
    const sh = GH * view.zoom;                                      // sector height on screen (px)
    if (sh < 36) return;                                            // too small to place icons cleanly
    const px = Math.round(Math.max(13, Math.min(26, sh * 0.2)));    // glyph size, proportional + bounded
    const bySector = new Map();
    const add = (g, ch, color) => {
      if (!g || g.sx < 0 || g.sx >= 16 || g.sy < 0 || g.sy >= 16) return;
      const k = g.sy * 16 + g.sx; let e = bySector.get(k);
      if (!e) { e = { sx: g.sx, sy: g.sy, icons: [] }; bySector.set(k, e); }
      e.icons.push({ ch, color });
    };
    if (cur.id === 'surface') {
      if (layers.mine) for (const m of OV.mines) add(codeToGrid(m.code), ICON.mine, MC.mine);
      if (layers.sam) for (const s of OV.samSites) add(codeToGrid(s.code), ICON.sam, MC.sam);
      if (layers.heli) for (const h of OV.heliSites || []) add(codeToGrid(h.code), ICON.heli, MC.heli);
      if (layers.ship) for (const s of OV.shipping || []) add(codeToGrid(s.code), ICON.ship, MC.ship);
      if (layers.garrison) for (const code in OV.garrisons || {}) add(codeToGrid(code), ICON.garrison, MC.garrison);
      if (layers.poi) { const seen = new Set(); for (const p of OV.pois || []) { if (seen.has(p.code)) continue; seen.add(p.code); add(codeToGrid(p.code), ICON.poi, MC.poi); } }
    }
    if (layers.creatures) { const z = LEVEL_Z[cur.id]; for (const c of (OV.creatures && OV.creatures.cells) || []) if (c.z === z) add(codeToGrid(c.code), c.role === 'queen' ? ICON.queen : ICON.creature, MC.creatures); }
    if (layers.npc) { // one icon per sector (a $ if any dealer is present, else a person)
      const z = LEVEL_Z[cur.id], role = {};
      for (const p of OV.npcs || []) if ((p.z || 0) === z && (!role[p.code] || p.role === 'dealer')) role[p.code] = p.role;
      for (const code in role) add(codeToGrid(code), role[code] === 'dealer' ? ICON.dealer : ICON.npc, MC.npc);
    }
    if (layers.loot) { // sectors with parsed loot at this level (key is CODE or CODE_B<z>)
      const z = LEVEL_Z[cur.id];
      for (const key in OV.items || {}) {
        const e = OV.items[key]; if (e.partial || !(e.count > 0)) continue;
        const mb = /^([A-P]\d{1,2})(?:_B(\d))?$/.exec(key); if (!mb || (mb[2] ? +mb[2] : 0) !== z) continue;
        add(codeToGrid(mb[1]), ICON.loot, MC.loot);
      }
    }
    const step = px * 1.05, margin = Math.max(2, sh * 0.05), ih = Math.ceil(px * 1.35);
    for (const e of bySector.values()) {
      const top = toScreen(e.sx * GW + GW * 0.5, e.sy * GH); // top-border midpoint of the sector
      const cy = top.y + margin + ih / 2;                    // anchor by top edge: sit just BELOW the border
      let x = top.x - (e.icons.length - 1) * step / 2;
      for (const ic of e.icons) { const img = coloredIcon(ic.ch, ic.color, px); ctx.drawImage(img, Math.round(x - img.width / 2), Math.round(cy - img.height / 2)); x += step; }
    }
  }
  // Terrain/biome tint per sector (from MovementCosts <Here>).
  function drawTerrain() {
    for (const code in OV.terrain || {}) {
      const g = codeToGrid(code); if (!g) continue;
      const col = terrainColor(OV.terrain[code].here); if (!col) continue;
      const c = outline(g.sx, g.sy).map((p) => toScreen(p.x, p.y));
      ctx.fillStyle = col + '66';
      ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y); ctx.closePath(); ctx.fill();
    }
  }
  // Road (tan) + river (blue) network from per-sector cardinal traversability.
  function drawRoads() {
    const link = (g, nx, ny, color) => { const a = toScreen(g.x, g.y), b = center(nx, ny), s = toScreen(b.x, b.y); ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(s.x, s.y); ctx.stroke(); };
    for (const code in OV.terrain || {}) {
      const g0 = codeToGrid(code); if (!g0) continue;
      const t = OV.terrain[code], h = center(g0.sx, g0.sy);
      if (g0.sx < 15) { if (t.e === 'ROAD') link(h, g0.sx + 1, g0.sy, MC.roads); else if (/RIVER/.test(t.e || '')) link(h, g0.sx + 1, g0.sy, '#3a73b5'); }
      if (g0.sy < 15) { if (t.s === 'ROAD') link(h, g0.sx, g0.sy + 1, MC.roads); else if (/RIVER/.test(t.s || '')) link(h, g0.sx, g0.sy + 1, '#3a73b5'); }
    }
  }
  // Enemy patrol routes (polyline through each patrol's waypoint sectors).
  function drawPatrols() {
    ctx.strokeStyle = 'rgba(80,180,230,0.7)'; ctx.lineWidth = 2;
    for (const pat of OV.patrols || []) {
      const pts = pat.sectors.map((c) => { const g = codeToGrid(c); return g ? toScreen(g.sx * GW + GW / 2, g.sy * GH + GH / 2) : null; }).filter(Boolean);
      if (pts.length < 2) continue;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); ctx.stroke();
    }
  }

  // ---- interaction ----
  let dragging = false, last = null, moved = 0;
  canvas.addEventListener('mousedown', (e) => { dragging = true; moved = 0; last = { x: e.clientX, y: e.clientY }; canvas.classList.add('drag'); });
  window.addEventListener('mouseup', () => { dragging = false; canvas.classList.remove('drag'); });
  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      const dx = e.clientX - last.x, dy = e.clientY - last.y; moved += Math.abs(dx) + Math.abs(dy);
      view.x -= dx / (view.zoom * ASPECT); view.y -= dy / view.zoom; clampView(); last = { x: e.clientX, y: e.clientY }; markInteracting(); schedule(); scheduleURLSync();
    } else {
      const w = toWorld(e.clientX, e.clientY), s = pick(w.x, w.y);
      const h = (s.sx >= 0 && s.sx < 16 && s.sy >= 0 && s.sy < 16) ? s : null;
      if ((h && (!hovered || h.sx !== hovered.sx || h.sy !== hovered.sy)) || (!h && hovered)) { hovered = h; schedule(); }
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const before = toWorld(e.clientX, e.clientY);
    view.zoom = Math.max(minZoom, Math.min(4, view.zoom * Math.exp(-e.deltaY * 0.0015)));
    const after = toWorld(e.clientX, e.clientY);
    view.x += before.x - after.x; view.y += before.y - after.y; clampView(); markInteracting(); schedule(); scheduleURLSync();
  }, { passive: false });
  // Select (or deselect) the sector under a screen point — shared by mouse click and touch tap.
  function tapSelect(px, py) {
    const w = toWorld(px, py), s = pick(w.x, w.y);
    const inGrid = s.sx >= 0 && s.sx < 16 && s.sy >= 0 && s.sy < 16;
    if (!inGrid || (selected && selected.sx === s.sx && selected.sy === s.sy)) deselect(); // off-grid or re-tap toggles off
    else selectSector(s.sx, s.sy);
  }
  canvas.addEventListener('click', (e) => { if (moved <= 4) tapSelect(e.clientX, e.clientY); });

  // ---- touch: 1 finger pans, 2 fingers pinch-zoom, a tap selects ----
  let tStart = null, tPinch = null; // active single-touch gesture / two-finger pinch
  const tDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const tMid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault(); // claim the gesture so the browser doesn't pan/zoom the page (and no synthetic click)
    if (e.touches.length === 1) { const t = e.touches[0]; tStart = { x: t.clientX, y: t.clientY, moved: 0, multi: false }; tPinch = null; }
    else if (e.touches.length >= 2) { const m = tMid(e.touches[0], e.touches[1]); tPinch = { dist: tDist(e.touches[0], e.touches[1]), cx: m.x, cy: m.y }; if (tStart) tStart.multi = true; }
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length >= 2 && tPinch) {
      const m = tMid(e.touches[0], e.touches[1]), d = tDist(e.touches[0], e.touches[1]);
      const wOld = toWorld(tPinch.cx, tPinch.cy); // world point under the old midpoint
      if (d > 0 && tPinch.dist > 0) view.zoom = Math.max(minZoom, Math.min(4, view.zoom * (d / tPinch.dist)));
      const wNew = toWorld(m.x, m.y); view.x += wOld.x - wNew.x; view.y += wOld.y - wNew.y; // keep it under the (moved) midpoint
      tPinch = { dist: d, cx: m.x, cy: m.y }; if (tStart) tStart.multi = true;
      clampView(); markInteracting(); schedule(); scheduleURLSync();
    } else if (e.touches.length === 1 && tStart) {
      const t = e.touches[0], dx = t.clientX - tStart.x, dy = t.clientY - tStart.y;
      tStart.moved += Math.abs(dx) + Math.abs(dy);
      view.x -= dx / (view.zoom * ASPECT); view.y -= dy / view.zoom; tStart.x = t.clientX; tStart.y = t.clientY;
      clampView(); markInteracting(); schedule(); scheduleURLSync();
    }
  }, { passive: false });
  canvas.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
      if (tStart && !tStart.multi && tStart.moved <= 12 && e.changedTouches.length) { const t = e.changedTouches[0]; tapSelect(t.clientX, t.clientY); }
      tStart = null; tPinch = null;
    } else if (e.touches.length === 1) { const t = e.touches[0]; tStart = { x: t.clientX, y: t.clientY, moved: 99, multi: true }; tPinch = null; } // resume pan from remaining finger
  }, { passive: false });
  // Select a sector: highlight + info panel; the URL captures it for sharing (no zoom — keeps view).
  function selectSector(sx, sy) {
    selected = { sx, sy };
    showInfo(sx, sy);
    syncURL();
    schedule();
  }
  function deselect() {
    selected = null;
    document.getElementById('info').classList.add('hidden');
    syncURL();
    schedule();
  }
  // The URL hash captures the LIVE view so any view (pan + zoom + selection) is shareable:
  //   #@<col>,<row>,<zoom>[,<SECTOR>]   (col/row = grid-fraction centre, 0..16)
  // A bare sector code (#C13) is still accepted as input and frames that sector. replaceState fires
  // no hashchange; the location.hash fallback (rarely needed) is guarded by ignoreHashOnce.
  let ignoreHashOnce = false, urlTimer = null;
  function viewToken() {
    const gx = +(view.x / GW).toFixed(2), gy = +(view.y / GH).toFixed(2), z = +view.zoom.toFixed(4);
    return '@' + gx + ',' + gy + ',' + z + (selected ? ',' + LETTERS[selected.sy] + (selected.sx + 1) : '');
  }
  function syncURL() {
    const tok = viewToken();
    if (history && history.replaceState) {
      try { history.replaceState(null, '', location.pathname + location.search + '#' + tok); return; } catch (e) { /* file:// */ }
    }
    ignoreHashOnce = true; location.hash = tok; setTimeout(() => { ignoreHashOnce = false; }, 0);
  }
  function scheduleURLSync() { if (urlTimer) clearTimeout(urlTimer); urlTimer = setTimeout(syncURL, 250); } // debounced for pan/zoom

  function showInfo(sx, sy) {
    const box = document.getElementById('info');
    if (sx < 0 || sx >= 16 || sy < 0 || sy >= 16) { box.classList.add('hidden'); return; }
    const code = LETTERS[sy] + (sx + 1);
    const town = OV.towns.find((t) => t.sectors.includes(code));
    const here = cur.byCode.has(code);
    const onLevels = M.levelOrder.filter((id) => levels[id].byCode.has(code)).map((id) => levels[id].label);
    const O = OV;
    // Build a list of [label, value] rows, rendered as an aligned key/value table.
    const rows = [];
    if (!here) rows.push(['', `no map on ${cur.label}`]);
    if (town) rows.push(['Town', town.name + (town.militia ? ` · militia (max ${O.militiaCap || 20})` : '') + (town.loyalty ? ' · loyalty' : '')]);
    if (code in (O.coolness || {})) rows.push(['Difficulty', O.coolness[code] + ' / 20']);
    const ter = (O.terrain || {})[code];
    if (ter && ter.here) rows.push(['Terrain', ter.here.toLowerCase().replace(/_/g, ' ')]);
    const water = ['', 'fresh water', 'salt water', 'poisoned water'][(O.water || {})[code] || 0];
    if (water) rows.push(['Water', water]);
    const mine = (O.mines || []).find((m) => m.code === code);
    if (mine) rows.push(['Mine', `⛏ ${mine.mineral} · ~$${mine.production}/period` + (mine.underground.length ? ` · sublevels ${mine.underground.join(', ')}` : '')]);
    const ship = (O.shipping || []).find((s) => s.code === code), sites = [];
    if (O.samSites.some((s) => s.code === code)) sites.push('🚀 SAM');
    if ((O.heliSites || []).some((h) => h.code === code)) sites.push('🚁 Heli');
    if (ship) sites.push('✈ Airport (' + ship.name + ')');
    if (sites.length) rows.push(['Sites', sites.join(' · ')]);
    const gar = (O.garrisons || {})[code];
    if (gar) rows.push(['Garrison', '⚔ ~' + gar.pop + (gar.elite ? ` (${gar.elite}% elite)` : '')]);
    if ((O.bloodcats || {})[code]) rows.push(['Bloodcats', '⚠ up to ' + O.bloodcats[code]]);
    if ((O.facilities || {})[code]) rows.push(['Facilities', O.facilities[code].join(', ')]);
    const pois = (O.pois || []).filter((p) => p.code === code);
    if (pois.length) rows.push(['Quest/POI', '📖 ' + pois.map((p) => p.label).join(', ')]);
    const np = (O.npcs || []).filter((p) => p.code === code && (p.z || 0) === LEVEL_Z[cur.id]);
    if (np.length) rows.push(['NPCs', '🧍 ' + np.map((p) => p.role === 'dealer' ? p.name + ' ($)' : p.name).join(', ')]);
    const loot = (O.items || {})[cur.id === 'surface' ? code : code + '_B' + LEVEL_Z[cur.id]];
    if (loot && loot.partial) rows.push(['Loot', '📦 newer map format — not parsed']);
    else if (loot) rows.push(['Loot', `📦 ${loot.count}: ` + loot.notable.map((x) => x.name + (x.qty > 1 ? '×' + x.qty : '')).join(', ')]);
    const cr = ((O.creatures && O.creatures.cells) || []).find((c) => c.code === code && c.z === LEVEL_Z[cur.id]);
    if (cr) rows.push(['Creatures', (cr.role === 'queen' ? '👑' : '🐛') + ' ' + cr.zone + (cr.role === 'attack' ? ' (surface attack)' : ` (${cr.role})`)]);
    if (onLevels.length > 1) rows.push(['Maps', onLevels.join(', ')]);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    document.getElementById('i-code').textContent = code;
    document.getElementById('i-name').textContent = OV.sectorNames[code] || '—';
    document.getElementById('i-meta').innerHTML = rows.map(([k, v]) => `<div class="i-row"><span class="i-k">${esc(k)}</span><span class="i-v">${esc(v)}</span></div>`).join('');
    box.classList.remove('hidden');
  }

  // ---- sizing / init ----
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2); // cap: a 3x tablet would otherwise redraw ~2.25x more pixels per frame
    cw = window.innerWidth; ch = window.innerHeight;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    clampView(); schedule();
  }
  function fit() {
    const z = Math.min(cw / (BOUNDS.width * ASPECT), ch / BOUNDS.height) * 0.94;
    view.zoom = z; minZoom = z * 0.6;
    view.x = BOUNDS.minX + BOUNDS.width / 2; view.y = BOUNDS.minY + BOUNDS.height / 2;
  }
  function focusSector(code) {
    const g = codeToGrid(code); if (!g || g.sx < 0 || g.sy < 0 || g.sx >= 16 || g.sy >= 16) return false;
    const c = center(g.sx, g.sy); view.x = c.x; view.y = c.y; view.zoom = Math.min(1, Math.max(0.5, minZoom * 18)); clampView();
    selected = { sx: g.sx, sy: g.sy }; // a shared link both zooms to and highlights the sector
    showInfo(g.sx, g.sy); return true;
  }
  function applyHash() {
    if (ignoreHashOnce) { ignoreHashOnce = false; return; } // our own write — don't reprocess
    let h = (location.hash || '').replace(/^#/, '');
    try { h = decodeURIComponent(h); } catch (e) { /* malformed % escape from a pasted URL — keep raw */ }
    h = h.trim();
    if (!h) return;
    if (h[0] === '@') { // full view: #@col,row,zoom[,SECTOR]
      const p = h.slice(1).split(',');
      const gx = parseFloat(p[0]), gy = parseFloat(p[1]), z = parseFloat(p[2]);
      if (isFinite(gx) && isFinite(gy)) { view.x = gx * GW; view.y = gy * GH; }
      if (isFinite(z)) view.zoom = Math.max(minZoom, Math.min(4, z));
      clampView();
      const g = codeToGrid((p[3] || '').toUpperCase());
      selected = (g && g.sx >= 0 && g.sx < 16 && g.sy >= 0 && g.sy < 16) ? { sx: g.sx, sy: g.sy } : null;
      if (selected) showInfo(selected.sx, selected.sy); else document.getElementById('info').classList.add('hidden');
      schedule();
    } else if (focusSector(h.toUpperCase())) { // bare sector code: frame + select it
      schedule();
    }
  }
  window.addEventListener('hashchange', applyHash);
  window.addEventListener('resize', resize);
  const qp = new URLSearchParams(location.search);
  const qLevel = qp.get('level');
  if (qLevel && levels[qLevel]) { cur = levels[qLevel]; levelSel.value = qLevel; ensureLevelImg(cur); }
  for (const k of ['grid', 'detail', 'roofs', 'cool', 'town', 'mine', 'sam', 'heli', 'ship', 'garrison', 'patrol', 'poi', 'npc', 'loot', 'creatures', 'roads', 'terrain']) {
    if (!qp.has(k)) continue;
    layers[k] = qp.get(k) !== '0';
    const cb = document.getElementById('t-' + k) || document.querySelector(`#legend input[data-layer="${k}"]`);
    if (cb) { cb.checked = layers[k]; cb.closest('.leg-row')?.classList.toggle('off', !layers[k]); }
  }
  resize(); fit(); if (location.hash) applyHash(); schedule();
})();

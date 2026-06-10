'use strict';
// Composites one parsed sector into an isometric RGBA image.
// Projection (source/TileEngine/Isometric Utils.cpp): for grid (col,row),
//   screenX = (col-row)*20, screenY = (col+row)*10  (tile = 40x20).
// Tiles are blitted at screen point + STI subimage offset (offX,offY), minus cell elevation.
//
// Layers are collected back-to-front (land, object, [shadow], struct, roof, onroof, each in
// anti-diagonal NW->SE order), but the per-pixel blit is gated by a per-pixel Z-BUFFER that
// replicates JA2's real renderer (source/TileEngine/renderworld.cpp + Render Z.cpp). Each source
// pixel draws iff its Z >= the buffered Z (">=" so equal Z "burns through" -> draws over, exactly
// like the game's ...ZSameZBurnsThrough / TransZ blitters), and the painter order breaks remaining
// ties. Multi-tile WALL structures additionally get a per-column sloped Z (their .jsd "Z-strip"),
// so their far columns occlude objects standing a row+ behind them — the occlusion a flat painter's
// algorithm misses. This matches the engine's gate exactly: the sloped strip is used only for tiles
// that are BOTH a wall-type slot (WALL_TILE) and carry a multi-tile ZStripInfo (MULTI_Z_TILE); every
// other element uses a flat per-element Z. (See build/structure.js for the .jsd / ZStripInfo parse.)

const HALF_TILE_X = 20; // WORLD_TILE_X / 2
const HALF_TILE_Y = 10; // WORLD_TILE_Y / 2
const WALL_HEIGHT = 50; // roof/onroof layers are raised this many px to sit on the walls (renderworld.cpp)

// --- JA2 Z model (renderworld.h, Render Z.cpp) ---
// Z = worldY*Z_SUBLAYERS + layerZ. worldY = GetMapXYWorldY(x,y) = (col*10 + row*10) + const; the const
// is identical for every tile in a sector so it cancels in the per-pixel comparison -> worldY = (col+row)*10.
// Render Z.cpp: LandZLevel/ObjectZLevel return a FLAT constant (0/1) for plain land/objects; only
// struct/roof/onroof scale with worldY. Roof/OnRoof add WALL_HEIGHT(50) to worldY first (sit on walls).
// Net: a struct at (col,row) has Z = (col+row)*80 + STRUCT_Z_LEVEL(4).
const Z_SUBLAYERS = 8;
const CELL_SIZE = 10;                 // CELL_X_SIZE == CELL_Y_SIZE
const LAND_Z_LEVEL = 0, OBJECT_Z_LEVEL = 1, SHADOW_Z_LEVEL = 2, STRUCT_Z_LEVEL = 4, ROOF_Z_LEVEL = 5, ONROOF_Z_LEVEL = 6;
const Z_STRIP_DELTA_Y = Z_SUBLAYERS * 10; // 80: per-strip Z step for the sloped wall columns
const HALF_WORLD_X = 20;               // WORLD_TILE_X / 2 — the 20px Z-strip width

// Wall tile-type slots (TileDat.h TileTypeDefines): FIRSTWALL..FOURTHWALL. TileDat.cpp sets WALL_TILE
// for these. The .jsd-derived sloped strip is applied to EVERY multi-tile structure (renderworld.cpp
// blits both wall and non-wall multi-tile structs through a strip-walking blitter — the wall slots via
// Blt..ZSameZBurnsThrough, the others via Blt..TransZIncClip — both of which read ppZStripInfo). The
// ONE difference is the Z tie-break: the wall (and all single-tile) blitters draw when new Z >= buffered
// ("equal burns through", `ja`), whereas the non-wall multi-tile blitter draws only when new Z STRICTLY
// > buffered (`jae`). That strict tie-break is what makes a big multi-tile prop's far columns (whose
// strip lowers their Z to exactly the back tile's level) sit BEHIND the wall in front instead of
// "burning through" it — the Tixa-prison shackle/crate-over-wall bug. So `isWallType` selects the
// equal-burns-through tie-break for wall-slot strips.
const FIRSTWALL = 36, FOURTHWALL = 39;
const isWallType = (t) => t >= FIRSTWALL && t <= FOURTHWALL;

// Per-pixel-column Z OFFSET (relative to the wall's base Z) across a wall sprite's width, walking the
// strips exactly as renderworld.cpp's ZSameZBurnsThrough blitter (~5300-5510) with no left clipping
// (the webmap sizes the canvas to fit, so it never clips): Z starts at bInitialZChange*delta over a
// `ubFirstZStripWidth`-px first strip, then steps pbZChange[i]*delta every 20px. The result is cached
// per (zstrip, width). `zstrip` is the parsed ZStripInfo from build/structure.js.
const _zColCache = new WeakMap(); // ZStripInfo -> Map(width -> Int32Array)
function wallZColumns(zstrip, width) {
  let byW = _zColCache.get(zstrip);
  if (!byW) { byW = new Map(); _zColCache.set(zstrip, byW); }
  let cols = byW.get(width);
  if (cols !== undefined) return cols;
  const { bInitialZChange, ubFirstZStripWidth, pbZChange } = zstrip;
  cols = new Int32Array(width);
  let z = bInitialZChange * Z_STRIP_DELTA_Y, colsToGo = ubFirstZStripWidth, zi = 0;
  for (let x = 0; x < width; x++) {
    cols[x] = z;
    if (--colsToGo === 0) {            // crossed a strip boundary: apply this strip's step
      z += (zi < pbZChange.length ? pbZChange[zi] : 0) * Z_STRIP_DELTA_Y;
      zi++;
      colsToGo = HALF_WORLD_X;
    }
  }
  byW.set(width, cols);
  return cols;
}

function diagonalOrder(rows, cols) {
  const size = rows * cols;
  const order = new Array(size);
  for (let i = 0; i < size; i++) order[i] = i;
  order.sort((a, b) => {
    const ca = a % cols, ra = (a / cols) | 0;
    const cb = b % cols, rb = (b / cols) | 0;
    const ka = ca + ra, kb = cb + rb;
    if (ka !== kb) return ka - kb;
    return ca - cb;
  });
  return order;
}

function renderSector(dat, resolver, opts = {}) {
  const { rows, cols, heights, tilesetId } = dat;
  // Per-tile elevation: vanilla maps encode this ambiguously (magnitude in the high byte),
  // and raw-subtracting it explodes the canvas. Disabled by default for a clean overview;
  // when enabled, use a gentle level offset (sHeight >> 8 levels) rather than the raw value.
  const applyHeight = !!opts.applyHeight;
  const includeShadows = !!opts.shadows;
  // roofPass splits the roof layers into their own render so the viewer can toggle them at runtime:
  // 'base' paints everything BUT roofs (revealing building interiors); 'overlay' paints ONLY roofs
  // (transparent elsewhere). Crucially both still collect roof ops in Pass 1, so the bounds/origin are
  // identical between the two passes and they warp pixel-aligned — letting the overlay composite exactly
  // over the base. null = the original single-image behaviour.
  const roofPass = opts.roofPass || null;
  const includeRoofs = roofPass ? true : opts.roofs !== false;
  // Roof handling. 'all' = draw every roof (surface: overhead building roofs).
  // 'exterior' = underground: a basement's roof layer is the cave ceiling that blankets the whole
  // map; the game only shows it over unreachable rock and reveals the floor inside the walls. We
  // reproduce that statically by drawing roof/onroof ONLY on cells with no floor tile (FloorAtGridNo
  // in worlddef.cpp: floor = tileset slots 60-63), so reachable rooms show their floor.
  const roofMode = opts.roofMode || 'all';
  const FLOOR_MIN = 60, FLOOR_MAX = 63;
  let hasFloor = null;
  if (roofMode === 'exterior') {
    hasFloor = new Uint8Array(rows * cols);
    for (let i = 0; i < hasFloor.length; i++) {
      const c = dat.land[i];
      if (c) for (let k = 0; k < c.length; k++) if (c[k].type >= FLOOR_MIN && c[k].type <= FLOOR_MAX) { hasFloor[i] = 1; break; }
    }
  }
  // Per-layer Z (Render Z.cpp *ZLevel) + screen lift. LAND/OBJECT use a FLAT constant z; struct/roof/
  // onroof scale with worldY. `lift` raises the sprite on screen AND deepens worldY (roofs sit up on
  // the walls). `zBias` shifts only the Z, not the screen position (shadows get worldY-80 so they sit
  // just under the ground/structs; shadow layer is off in the normal build).
  const LAYER_INFO = {
    land:   { z: LAND_Z_LEVEL,   scaled: false, lift: 0,           zBias: 0,   roof: false },
    object: { z: OBJECT_Z_LEVEL, scaled: false, lift: 0,           zBias: 0,   roof: false },
    shadow: { z: SHADOW_Z_LEVEL, scaled: true,  lift: 0,           zBias: -80, roof: false },
    struct: { z: STRUCT_Z_LEVEL, scaled: true,  lift: 0,           zBias: 0,   roof: false },
    roof:   { z: ROOF_Z_LEVEL,   scaled: true,  lift: WALL_HEIGHT, zBias: 0,   roof: true },
    onroof: { z: ONROOF_Z_LEVEL, scaled: true,  lift: WALL_HEIGHT, zBias: 0,   roof: true },
  };
  const layerNames = ['land', 'object'];
  if (includeShadows) layerNames.push('shadow');
  layerNames.push('struct');
  if (includeRoofs) layerNames.push('roof', 'onroof');

  const order = diagonalOrder(rows, cols);

  // Pass 1: collect blit ops (with their per-op base Z and any wall Z-strip) and compute bounds.
  const ops = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const layerName of layerNames) {
    const layer = dat[layerName];
    const info = LAYER_INFO[layerName];
    const isRoof = info.roof;
    const lift = info.lift; // raise roofs onto the walls (screen lift; Z gets the same worldY bump)
    const isStruct = layerName === 'struct';
    for (let oi = 0; oi < order.length; oi++) {
      const gridno = order[oi];
      if (isRoof && hasFloor && hasFloor[gridno]) continue; // underground: floor shows, no ceiling here
      const cell = layer[gridno];
      if (!cell) continue;
      const col = gridno % cols, row = (gridno / cols) | 0;
      const baseX = (col - row) * HALF_TILE_X;
      const elev = applyHeight ? (heights[gridno] >> 8) * 5 : 0;
      const baseY = (col + row) * HALF_TILE_Y - elev - lift;
      // worldY = (col+row)*CELL_SIZE (+const that cancels); roofs add WALL_HEIGHT, shadows -80.
      const worldY = (col + row) * CELL_SIZE + lift + info.zBias;
      const baseZ = info.scaled ? Math.max(worldY * Z_SUBLAYERS + info.z, 0) : info.z;
      for (let ni = 0; ni < cell.length; ni++) {
        const node = cell[ni];
        const sti = resolver.resolve(tilesetId, node.type);
        if (!sti) continue;
        const sub = sti.subimages[node.sub - 1];
        if (!sub) continue;
        const bx = baseX + sub.offX;
        const by = baseY + sub.offY;
        // Sloped Z-strip + tie-break, for multi-tile STRUCT subimages that carry ZStripInfo (our
        // resolver attaches sti.zstrips[sub] iff the .jsd marks ubNumberOfTiles>1 for that subimage —
        // the engine's MULTI_Z_TILE). `zcols` is the per-column Z offset (null = flat). `strict` picks
        // the engine's `jae` (strictly-greater) tie-break for NON-wall multi-tile props, so their far,
        // strip-lowered columns are occluded by an equal-Z wall in front rather than burning through it.
        let zcols = null, strict = false;
        if (isStruct && sti.zstrips) {
          const zs = sti.zstrips[node.sub - 1];
          if (zs) { zcols = wallZColumns(zs, sub.w); strict = !isWallType(node.type); }
        }
        ops.push({ bx, by, sub, isRoof, baseZ, zcols, strict });
        if (bx < minX) minX = bx;
        if (by < minY) minY = by;
        if (bx + sub.w > maxX) maxX = bx + sub.w;
        if (by + sub.h > maxY) maxY = by + sub.h;
      }
    }
  }

  if (!isFinite(minX)) return null; // empty map
  const W = maxX - minX;
  const H = maxY - minY;
  const canvas = new Uint8Array(W * H * 4);
  // Per-pixel Z-buffer (JA2 gpZBuffer). Init to a sentinel below any real Z so the first pixel at a
  // location always draws; thereafter a pixel draws iff its Z >= the buffered Z (">=" lets equal Z
  // "burn through" and draw over, exactly like JA2's blitters), and painter order resolves ties.
  const Z_EMPTY = -0x40000000;
  const zbuf = new Int32Array(W * H).fill(Z_EMPTY);

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (roofPass === 'base' && op.isRoof) continue;     // base pass: skip roofs (reveal interiors)
    if (roofPass === 'overlay' && !op.isRoof) continue; // overlay pass: roofs only (transparent elsewhere)
    const { bx, by, sub, baseZ, zcols, strict } = op;
    const dx = bx - minX, dy = by - minY;
    const { w, h, rgba } = sub;
    for (let y = 0; y < h; y++) {
      const cy = dy + y;
      if (cy < 0 || cy >= H) continue;
      const srcRow = y * w * 4;
      const rowBase = cy * W;
      for (let x = 0; x < w; x++) {
        if (rgba[srcRow + x * 4 + 3]) {
          const cx = dx + x;
          if (cx < 0 || cx >= W) continue;
          const idx = rowBase + cx;
          const pz = zcols ? baseZ + zcols[x] : baseZ; // multi-tile: per-column sloped Z; else flat baseZ
          // tie-break: non-wall multi-tile props use strict `>` (equal stays occluded); everything
          // else uses `>=` (equal burns through). Matches the engine's jae vs ja blitters.
          if (strict ? (pz <= zbuf[idx]) : (pz < zbuf[idx])) continue;
          zbuf[idx] = pz;
          const di = idx * 4;
          canvas[di] = rgba[srcRow + x * 4];
          canvas[di + 1] = rgba[srcRow + x * 4 + 1];
          canvas[di + 2] = rgba[srcRow + x * 4 + 2];
          canvas[di + 3] = 255;
        }
      }
    }
  }

  return { canvas, width: W, height: H, originX: -minX, originY: -minY };
}

// Un-project an isometric sector render into an axis-aligned square (top-down tile grid),
// so sectors fill their square cell and tessellate seamlessly.
// The square's full extent maps exactly onto the tile grid 0..159 (corner = corner tile centre),
// so every output pixel lands inside the rendered diamond -> fully opaque, no corner artifacts.
//   square(qx,qy) -> tile(col,row) with col = qx*159/(N-1), row = qy*159/(N-1)
//   iso local screen = ((col-row)*20, (col+row)*10) + image origin
const SECTOR_GRID_MAX = 159; // last tile index in a 160x160 sector
function warpToSquare(img, N) {
  const { canvas, width, height, originX, originY } = img;
  const out = new Uint8Array(N * N * 4);
  const s = SECTOR_GRID_MAX / (N - 1); // tiles per output pixel
  for (let qy = 0; qy < N; qy++) {
    const row = qy * s;
    for (let qx = 0; qx < N; qx++) {
      const col = qx * s;
      const fx = (col - row) * 20 + originX;
      const fy = (col + row) * 10 + originY;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const di = (qy * N + qx) * 4;
      if (x0 >= 0 && y0 >= 0 && x0 + 1 < width && y0 + 1 < height) {
        const i00 = (y0 * width + x0) * 4, i10 = i00 + 4, i01 = i00 + width * 4, i11 = i01 + 4;
        if (canvas[i00 + 3] && canvas[i10 + 3] && canvas[i01 + 3] && canvas[i11 + 3]) {
          const dx = fx - x0, dy = fy - y0;
          for (let c = 0; c < 3; c++) {
            const top = canvas[i00 + c] * (1 - dx) + canvas[i10 + c] * dx;
            const bot = canvas[i01 + c] * (1 - dx) + canvas[i11 + c] * dx;
            out[di + c] = (top * (1 - dy) + bot * dy + 0.5) | 0;
          }
          out[di + 3] = 255;
          continue;
        }
      }
      // edge / partially-transparent neighborhood: nearest opaque
      const sx = Math.round(fx), sy = Math.round(fy);
      if (sx >= 0 && sy >= 0 && sx < width && sy < height) {
        const si = (sy * width + sx) * 4;
        if (canvas[si + 3]) { out[di] = canvas[si]; out[di + 1] = canvas[si + 1]; out[di + 2] = canvas[si + 2]; out[di + 3] = 255; }
      }
    }
  }
  return { canvas: out, width: N, height: N };
}

// Map the map's CONTENT DIAMOND (the central diamond of the tile grid, whose corners are the
// road-exit edge-midpoints) directly onto an axis-aligned OW x OH rectangle — i.e. "un-project,
// rotate 45°, crop to the inscribed square". With OW = 2*OH the output is rendered natively at the
// 2:1 tactical proportion (no display stretch). Keeps all real content (roads reach the corners)
// and cuts only the blank-desert tile-grid corners. Buildings appear at 45° (tactical look).
//   final(px,py) -> tile(col,row): col = 79.5*(1 + nx - ny), row = 79.5*(nx + ny)   (nx,ny in 0..1)
//   iso local screen = ((col-row)*20, (col+row)*10) + image origin
function warpToContentSquare(img, OW, OH, gridMax = SECTOR_GRID_MAX) {
  const { canvas, width, height, originX, originY } = img;
  const out = new Uint8Array(OW * OH * 4);
  // Half the tile grid: 79.5 for a standard 160-tile map, 179.5 for a 360-tile AIMNAS bigmap.
  const HC = gridMax / 2;
  for (let py = 0; py < OH; py++) {
    const nx = py / (OH - 1); // rotate output 90° CW (current left edge -> top)
    for (let px = 0; px < OW; px++) {
      const ny = 1 - px / (OW - 1);
      const col = HC * (1 + nx - ny);
      const row = HC * (nx + ny);
      const fx = (col - row) * 20 + originX;
      const fy = (col + row) * 10 + originY;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const di = (py * OW + px) * 4;
      if (x0 >= 0 && y0 >= 0 && x0 + 1 < width && y0 + 1 < height) {
        const i00 = (y0 * width + x0) * 4, i10 = i00 + 4, i01 = i00 + width * 4, i11 = i01 + 4;
        if (canvas[i00 + 3] && canvas[i10 + 3] && canvas[i01 + 3] && canvas[i11 + 3]) {
          const dx = fx - x0, dy = fy - y0;
          for (let c = 0; c < 3; c++) {
            const top = canvas[i00 + c] * (1 - dx) + canvas[i10 + c] * dx;
            const bot = canvas[i01 + c] * (1 - dx) + canvas[i11 + c] * dx;
            out[di + c] = (top * (1 - dy) + bot * dy + 0.5) | 0;
          }
          out[di + 3] = 255;
          continue;
        }
      }
      const sx = Math.round(fx), sy = Math.round(fy);
      if (sx >= 0 && sy >= 0 && sx < width && sy < height) {
        const si = (sy * width + sx) * 4;
        if (canvas[si + 3]) { out[di] = canvas[si]; out[di + 1] = canvas[si + 1]; out[di + 2] = canvas[si + 2]; out[di + 3] = 255; }
      }
    }
  }
  return { canvas: out, width: OW, height: OH };
}

module.exports = { renderSector, warpToSquare, warpToContentSquare };

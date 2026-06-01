'use strict';
// Composites one parsed sector into an isometric RGBA image.
// Projection (source/TileEngine/Isometric Utils.cpp): for grid (col,row),
//   screenX = (col-row)*20, screenY = (col+row)*10  (tile = 40x20).
// Tiles are blitted at screen point + STI subimage offset (offX,offY), minus cell elevation.
// Layers are painted globally back-to-front: land, object, [shadow], struct, roof, onroof —
// each pass traversing tiles in anti-diagonal (NW->SE) order (painter's algorithm).

const HALF_TILE_X = 20; // WORLD_TILE_X / 2
const HALF_TILE_Y = 10; // WORLD_TILE_Y / 2
const WALL_HEIGHT = 50; // roof/onroof layers are raised this many px to sit on the walls (renderworld.cpp)

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
  const layerNames = ['land', 'object'];
  if (includeShadows) layerNames.push('shadow');
  layerNames.push('struct');
  if (includeRoofs) layerNames.push('roof', 'onroof');

  const order = diagonalOrder(rows, cols);

  // Pass 1: collect blit ops and compute bounds.
  const ops = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const layerName of layerNames) {
    const layer = dat[layerName];
    const isRoof = layerName === 'roof' || layerName === 'onroof';
    const lift = isRoof ? WALL_HEIGHT : 0; // raise roofs onto the walls
    for (let oi = 0; oi < order.length; oi++) {
      const gridno = order[oi];
      if (isRoof && hasFloor && hasFloor[gridno]) continue; // underground: floor shows, no ceiling here
      const cell = layer[gridno];
      if (!cell) continue;
      const col = gridno % cols, row = (gridno / cols) | 0;
      const baseX = (col - row) * HALF_TILE_X;
      const elev = applyHeight ? (heights[gridno] >> 8) * 5 : 0;
      const baseY = (col + row) * HALF_TILE_Y - elev - lift;
      for (let ni = 0; ni < cell.length; ni++) {
        const node = cell[ni];
        const sti = resolver.resolve(tilesetId, node.type);
        if (!sti) continue;
        const sub = sti.subimages[node.sub - 1];
        if (!sub) continue;
        const bx = baseX + sub.offX;
        const by = baseY + sub.offY;
        ops.push({ bx, by, sub, isRoof });
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

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (roofPass === 'base' && op.isRoof) continue;     // base pass: skip roofs (reveal interiors)
    if (roofPass === 'overlay' && !op.isRoof) continue; // overlay pass: roofs only (transparent elsewhere)
    const { bx, by, sub } = op;
    const dx = bx - minX, dy = by - minY;
    const { w, h, rgba } = sub;
    for (let y = 0; y < h; y++) {
      const cy = dy + y;
      if (cy < 0 || cy >= H) continue;
      const srcRow = y * w * 4;
      const dstRow = (cy * W + dx) * 4;
      for (let x = 0; x < w; x++) {
        if (rgba[srcRow + x * 4 + 3]) {
          const cx = dx + x;
          if (cx < 0 || cx >= W) continue;
          const di = dstRow + x * 4;
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
function warpToContentSquare(img, OW, OH) {
  const { canvas, width, height, originX, originY } = img;
  const out = new Uint8Array(OW * OH * 4);
  const HC = SECTOR_GRID_MAX / 2; // 79.5
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

'use strict';
// Minimal zero-dependency PNG encoder (RGBA truecolor + 8-bit indexed). Uses Node's built-in zlib.
const zlib = require('zlib');

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = data.length;
  const buf = Buffer.alloc(12 + len);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4, 'latin1');
  data.copy(buf, 8);
  buf.writeUInt32BE(crc32(buf, 4, 8 + len), 8 + len);
  return buf;
}

function ihdrChunk(w, h, colorType) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return chunk('IHDR', ihdr);
}

// rgba: Uint8Array of length w*h*4 (RGBA, row-major top->bottom)
function encodePNG(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (none)
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([SIG, ihdrChunk(w, h, 6), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- Median-cut quantization to <=256 colors (alpha ignored; opaque images only) ---
function boxStats(colors, count) {
  let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
  for (const c of colors) {
    const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    if (r < rmin) rmin = r; if (r > rmax) rmax = r;
    if (g < gmin) gmin = g; if (g > gmax) gmax = g;
    if (b < bmin) bmin = b; if (b > bmax) bmax = b;
  }
  const rr = rmax - rmin, gr = gmax - gmin, br = bmax - bmin;
  const maxRange = Math.max(rr, gr, br);
  return { colors, count, maxRange, channel: maxRange === rr ? 16 : (maxRange === gr ? 8 : 0) };
}

function quantize(rgba, n, hist, maxColors) {
  const keys = [...hist.keys()];
  if (keys.length <= maxColors) {
    const map = new Map(); const palette = [];
    keys.forEach((c, i) => { map.set(c, i); palette.push([(c >> 16) & 255, (c >> 8) & 255, c & 255]); });
    return { palette, map };
  }
  let boxes = [boxStats(keys, n)];
  while (boxes.length < maxColors) {
    let bi = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].colors.length > 1 && boxes[i].maxRange > best) { best = boxes[i].maxRange; bi = i; }
    if (bi < 0) break;
    const b = boxes[bi], sh = b.channel;
    b.colors.sort((a, c) => ((a >> sh) & 255) - ((c >> sh) & 255));
    let acc = 0, split = 0;
    for (let i = 0; i < b.colors.length; i++) { acc += hist.get(b.colors[i]); if (acc * 2 >= b.count) { split = i + 1; break; } }
    if (split <= 0) split = 1; if (split >= b.colors.length) split = b.colors.length - 1;
    const left = b.colors.slice(0, split), right = b.colors.slice(split);
    let lc = 0; for (const c of left) lc += hist.get(c);
    boxes.splice(bi, 1, boxStats(left, lc), boxStats(right, b.count - lc));
  }
  const palette = [], map = new Map();
  boxes.forEach((b, idx) => {
    let r = 0, g = 0, bl = 0, cnt = 0;
    for (const c of b.colors) { const w = hist.get(c); r += ((c >> 16) & 255) * w; g += ((c >> 8) & 255) * w; bl += (c & 255) * w; cnt += w; map.set(c, idx); }
    palette.push([Math.round(r / cnt), Math.round(g / cnt), Math.round(bl / cnt)]);
  });
  return { palette, map };
}

// Encode an opaque RGBA buffer as an 8-bit indexed PNG (<=256 colors, median-cut).
function encodeIndexedPNG(rgba, w, h) {
  const n = w * h;
  const hist = new Map();
  for (let i = 0; i < n; i++) { const o = i * 4; const k = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2]; hist.set(k, (hist.get(k) || 0) + 1); }
  const { palette, map } = quantize(rgba, n, hist, 256);
  const raw = Buffer.allocUnsafe((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    const row = y * (w + 1) + 1, base = y * w * 4;
    for (let x = 0; x < w; x++) { const o = base + x * 4; raw[row + x] = map.get((rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2]); }
  }
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach((c, i) => { plte[i * 3] = c[0]; plte[i * 3 + 1] = c[1]; plte[i * 3 + 2] = c[2]; });
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([SIG, ihdrChunk(w, h, 3), chunk('PLTE', plte), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { encodePNG, encodeIndexedPNG };

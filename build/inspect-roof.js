'use strict';
// One-off visual check for the roof base/overlay split: decode a sector's base + roof-overlay WebP
// (via dwebp -> PAM), and emit downscaled PNGs: base alone (interiors), overlay over grey (roofs),
// and overlay composited over base (should match the original roofed look, pixel-aligned).
//   node build/inspect-roof.js A9
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { encodePNG } = require('./png');
const cfg = require('./config');

const code = process.argv[2] || 'A9';
const W = 1600, H = 800; // downscaled for readability

function dwebpPam(webpPath) {
  const tmp = path.join(os.tmpdir(), `insp_${path.basename(webpPath)}.pam`);
  execFileSync('dwebp', ['-scale', String(W), String(H), '-pam', webpPath, '-o', tmp], { stdio: 'ignore' });
  const buf = fs.readFileSync(tmp);
  // Parse PAM header up to ENDHDR\n
  const hdrEnd = buf.indexOf('ENDHDR\n') + 7;
  const hdr = buf.slice(0, hdrEnd).toString('ascii');
  const w = +/WIDTH (\d+)/.exec(hdr)[1], h = +/HEIGHT (\d+)/.exec(hdr)[1];
  fs.unlinkSync(tmp);
  return { rgba: buf.slice(hdrEnd), w, h };
}

const dbg = path.join(cfg.DIST, 'debug');
fs.mkdirSync(dbg, { recursive: true });
const base = dwebpPam(path.join(cfg.DIST, 'sectors', `${code}.webp`));
const roof = dwebpPam(path.join(cfg.DIST, 'sectors', `${code}_roof.webp`));
const n = base.w * base.h;

// base alone
fs.writeFileSync(path.join(dbg, `roofchk_${code}_base.png`), encodePNG(Buffer.from(base.rgba), base.w, base.h));

// overlay over neutral grey (so transparent vs roof is obvious)
const onGrey = Buffer.alloc(n * 4);
for (let i = 0; i < n; i++) {
  const a = roof.rgba[i * 4 + 3];
  if (a) { onGrey[i*4]=roof.rgba[i*4]; onGrey[i*4+1]=roof.rgba[i*4+1]; onGrey[i*4+2]=roof.rgba[i*4+2]; onGrey[i*4+3]=255; }
  else { onGrey[i*4]=90; onGrey[i*4+1]=90; onGrey[i*4+2]=96; onGrey[i*4+3]=255; }
}
fs.writeFileSync(path.join(dbg, `roofchk_${code}_overlay.png`), encodePNG(onGrey, roof.w, roof.h));

// composite overlay over base (the roofs-ON look)
const comp = Buffer.from(base.rgba);
for (let i = 0; i < n; i++) {
  if (roof.rgba[i * 4 + 3]) { comp[i*4]=roof.rgba[i*4]; comp[i*4+1]=roof.rgba[i*4+1]; comp[i*4+2]=roof.rgba[i*4+2]; comp[i*4+3]=255; }
}
fs.writeFileSync(path.join(dbg, `roofchk_${code}_composite.png`), encodePNG(comp, base.w, base.h));

console.log(`${code}: base ${base.w}x${base.h}, roof ${roof.w}x${roof.h} -> dist/debug/roofchk_${code}_{base,overlay,composite}.png`);

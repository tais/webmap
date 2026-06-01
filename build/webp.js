'use strict';
// WebP encoding via the system `cwebp` (libwebp) — keeps the build free of npm dependencies, in the
// same spirit as the Firefox screenshots used for verification. Raw RGBA is fed through a PAM (P7)
// temp file so we skip a wasteful PNG re-encode. Lossy `-q` compresses RGB; alpha is kept losslessly,
// so the transparent tile-corner cutouts stay clean. Requires `cwebp` on PATH (`brew install webp`).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let counter = 0;
function encodeWebpToFile(rgba, w, h, quality, outPath) {
  const header = Buffer.from(`P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`, 'ascii');
  const body = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const tmp = path.join(os.tmpdir(), `wm_${process.pid}_${counter++}.pam`);
  fs.writeFileSync(tmp, Buffer.concat([header, body]));
  try {
    // -sharp_yuv: better RGB->YUV so chroma-subsampling doesn't soften the game art's coloured edges.
    execFileSync('cwebp', ['-quiet', '-sharp_yuv', '-q', String(quality), '-o', outPath, '--', tmp]);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
  return fs.statSync(outPath).size;
}

function checkCwebp() {
  try { execFileSync('cwebp', ['-version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

module.exports = { encodeWebpToFile, checkCwebp };

'use strict';
// ETRLE (Encoded Transparent Run-Length Encoding) decoder.
// Per scanline: read control byte c.
//   c == 0      -> end of scanline
//   c & 0x80    -> transparent run of (c & 0x7F) pixels
//   else        -> literal run of (c & 0x7F) palette indices copied from the stream
// Each scanline's runs fill exactly `width` pixels, then a 0 byte terminates the line.
function decodeEtrle(src, at, width, height) {
  const indices = new Uint8Array(width * height);
  const alpha = new Uint8Array(width * height); // 0 = transparent, 255 = opaque
  let p = at;
  for (let y = 0; y < height; y++) {
    let x = 0;
    const row = y * width;
    while (true) {
      if (p >= src.length) return { indices, alpha };
      const c = src[p++];
      if (c === 0) break; // end of scanline
      const n = c & 0x7F;
      if (c & 0x80) {
        x += n; // transparent run
      } else {
        for (let k = 0; k < n; k++) {
          if (x < width) {
            indices[row + x] = src[p + k];
            alpha[row + x] = 255;
            x++;
          }
        }
        p += n;
      }
    }
  }
  return { indices, alpha };
}

module.exports = { decodeEtrle };

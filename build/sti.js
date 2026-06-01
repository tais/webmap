'use strict';
// STI / STCI image decoder (8-bit indexed + ETRLE). See source/sgp/imgfmt.h.
const { decodeEtrle } = require('./etrle');

const STCI_TRANSPARENT = 0x01;
const STCI_ALPHA = 0x02;
const STCI_RGB = 0x04;
const STCI_INDEXED = 0x08;
const STCI_ZLIB = 0x10;
const STCI_ETRLE = 0x20;

// Returns { width, height, flags, transIndex, nSub, palette, subimages: [{offX,offY,w,h,rgba}] }
// or null for unsupported / non-STI buffers.
function decodeSti(buf) {
  if (!buf || buf.length < 64 || buf.toString('latin1', 0, 4) !== 'STCI') return null;
  const flags = buf.readUInt32LE(16);
  const height = buf.readUInt16LE(20);
  const width = buf.readUInt16LE(22);
  const transIndex = buf.readUInt32LE(12);
  if (!(flags & STCI_INDEXED)) return null; // 16-bit RGB STIs are not used for tile graphics
  const nSub = buf.readUInt16LE(28);
  const palOff = 64;
  const palette = buf.subarray(palOff, palOff + 768); // 256 * RGB
  const subTableOff = palOff + 768;
  const pixelOff = subTableOff + nSub * 16;
  const subimages = [];
  for (let i = 0; i < nSub; i++) {
    const so = subTableOff + i * 16;
    const dataOffset = buf.readUInt32LE(so + 0);
    const offX = buf.readInt16LE(so + 8);
    const offY = buf.readInt16LE(so + 10);
    const sh = buf.readUInt16LE(so + 12);
    const sw = buf.readUInt16LE(so + 14);
    const { indices, alpha } = decodeEtrle(buf, pixelOff + dataOffset, sw, sh);
    const rgba = new Uint8Array(sw * sh * 4);
    for (let j = 0; j < sw * sh; j++) {
      if (alpha[j]) {
        const idx = indices[j];
        rgba[j * 4] = palette[idx * 3];
        rgba[j * 4 + 1] = palette[idx * 3 + 1];
        rgba[j * 4 + 2] = palette[idx * 3 + 2];
        rgba[j * 4 + 3] = 255;
      }
    }
    subimages.push({ offX, offY, w: sw, h: sh, rgba });
  }
  return { width, height, flags, transIndex, nSub, palette, subimages };
}

module.exports = { decodeSti, STCI_INDEXED, STCI_ETRLE, STCI_RGB };

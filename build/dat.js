'use strict';
// Parses a JA2 tactical map .dat into the data we need to render it.
// Format confirmed from source/TileEngine/worlddef.cpp LoadWorld():
//   f32 major, u8 minor, [if major>=7: i32 rows, i32 cols], i32 flags, i32 tilesetId, i32 soldierSize,
//   int16 height[size], 4*u8 layer counts (nibble-packed) per tile,
//   then layers grouped: land, object, struct, shadow, roof, onroof.
//   Each node = u8 type + subindex (u8 for all layers EXCEPT object = u16).
//   We stop after the onroof layer (room info / optional sections are not needed for rendering).

function parseDat(buf) {
  let p = 0;
  const major = buf.readFloatLE(p); p += 4;
  const minor = buf.readUInt8(p); p += 1;
  let rows = 160, cols = 160;
  if (major >= 7.0) { rows = buf.readInt32LE(p); p += 4; cols = buf.readInt32LE(p); p += 4; }
  const flags = buf.readInt32LE(p); p += 4;
  const tilesetId = buf.readInt32LE(p); p += 4;
  const soldierSize = buf.readInt32LE(p); p += 4;
  const size = rows * cols;

  const heights = new Int16Array(size);
  for (let i = 0; i < size; i++) { heights[i] = buf.readInt16LE(p); p += 2; }

  const cLand = new Uint8Array(size);
  const cObj = new Uint8Array(size);
  const cStruct = new Uint8Array(size);
  const cShadow = new Uint8Array(size);
  const cRoof = new Uint8Array(size);
  const cOnRoof = new Uint8Array(size);
  const cellFlags = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const b0 = buf[p++], b1 = buf[p++], b2 = buf[p++], b3 = buf[p++];
    cLand[i] = b0 & 0x0F; cellFlags[i] = (b0 & 0xF0) >> 4;
    cObj[i] = b1 & 0x0F; cStruct[i] = (b1 & 0xF0) >> 4;
    cShadow[i] = b2 & 0x0F; cRoof[i] = (b2 & 0xF0) >> 4;
    cOnRoof[i] = b3 & 0x0F;
  }

  function readLayer(counts, u16sub) {
    const layer = new Array(size);
    for (let i = 0; i < size; i++) {
      const c = counts[i];
      if (!c) { layer[i] = null; continue; }
      const arr = new Array(c);
      for (let k = 0; k < c; k++) {
        const type = buf[p++];
        let sub;
        if (u16sub) { sub = buf.readUInt16LE(p); p += 2; } else { sub = buf[p++]; }
        arr[k] = { type, sub };
      }
      layer[i] = arr;
    }
    return layer;
  }

  const land = readLayer(cLand, false);
  const object = readLayer(cObj, true);
  const struct = readLayer(cStruct, false);
  const shadow = readLayer(cShadow, false);
  const roof = readLayer(cRoof, false);
  const onroof = readLayer(cOnRoof, false);

  return {
    major, minor, rows, cols, flags, tilesetId, soldierSize, size,
    heights, land, object, struct, shadow, roof, onroof,
    counts: { land: cLand, object: cObj, struct: cStruct, shadow: cShadow, roof: cRoof, onroof: cOnRoof },
    bytesConsumed: p, fileSize: buf.length,
  };
}

module.exports = { parseDat };

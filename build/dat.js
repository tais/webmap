'use strict';
// Parses a JA2 tactical map .dat into the data we need to render it (through the onroof layer).
// ONE parser reads EVERY map version — vanilla (5.x), Unfinished Business (6.x), 1.13 (7.x) and the
// current 8.x — because the header and the world-tile data are shared; only two header fields are
// version-gated. Byte layout confirmed against source/TileEngine/worlddef.cpp (EvaluateWorldData
// ~2458-2522 and LoadWorld):
//   f32 dMajorMapVersion
//   u8  ubMinorMapVersion        — present only if major >= 4.00 (every real map; vanilla is 5.00)
//   i32 rows, i32 cols           — present only if major >= 7.00 (variable size / bigmaps);
//                                  pre-v7 maps (vanilla, UB) are the fixed OLD_WORLD 160x160
//   i32 flags, i32 tilesetId, i32 soldierSize
//   i16 height[rows*cols]
//   per-tile layer counts: 4 bytes nibble-packed (land|worldflags, object|struct, shadow|roof, onroof|-)
//   layers land, object, struct, shadow, roof, onroof — each node = u8 type + sub-index, where the sub
//     is u16 for the OBJECT layer and u8 for every other layer. This is version-INDEPENDENT: it matches
//     the source's skip of exactly `2*totalNodes + objectCount` bytes for the whole world-data block.
//   [room info / exit grids / world items / soldiers ... follow — version-dependent, post-onroof, NOT
//    needed for rendering; the item offset (incl. the v6<27 quirk) is handled in overlays.js.]
// v8 differs from v7 only in those later (post-onroof) sections (larger team sizes), so a v8 map's tile
// data is byte-identical in shape to a v7 map and renders the same.

const OLD_WORLD = 160; // OLD_WORLD_ROWS / OLD_WORLD_COLS — fixed map dimensions for pre-v7 maps

function parseDat(buf) {
  let p = 0;
  const major = buf.readFloatLE(p); p += 4;
  let minor = 0;
  if (major >= 4.0) { minor = buf.readUInt8(p); p += 1; } // vanilla (5.00) and up always carry a minor byte
  let rows = OLD_WORLD, cols = OLD_WORLD;
  if (major >= 7.0) { rows = buf.readInt32LE(p); p += 4; cols = buf.readInt32LE(p); p += 4; } // v7+ variable size
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

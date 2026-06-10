'use strict';
// JA2 "Structure Data" (.jsd, id "J2SD") parser + ZStripInfo derivation.
//
// Each STI tile graphic may be paired with a same-named .jsd that describes the structure's
// physical/collision data. The piece the renderer needs is the per-subimage ZStripInfo, which the
// game's AddZStripInfoToVObject (source/TileEngine/structure.cpp ~2180-2532) builds ONLY for
// structures spanning more than one tile (DB_STRUCTURE.ubNumberOfTiles > 1, doors excepted). Those
// are the wide multi-tile WALL sprites; their per-column Z slope is what makes a wall occlude objects
// that stand a row or two behind it — the occlusion a flat per-element Z-buffer misses.
//
// Binary format (source/TileEngine/Structure Internals.h, all little-endian, packed):
//   STRUCTURE_FILE_HEADER (16 bytes):
//     char szId[4] = "J2SD"
//     u16 usNumberOfStructures   (== usNumberOfImages; one entry per STI subimage)
//     u16 usNumberOfStructuresStored
//     u16 usStructureDataSize
//     u8  fFlags                 (0x01 = AUXIMAGEDATA, 0x02 = STRUCTUREDATA)
//     u8  bUnused[3]
//     u16 usNumberOfImageTileLocsStored
//   then, if fFlags & 0x01: AuxObjectData[usNumberOfImages]  (16 bytes each)
//        and if usNumberOfImageTileLocsStored>0: RelTileLoc[that count] (2 bytes each)
//   then, if fFlags & 0x02: usStructureDataSize bytes of packed DB_STRUCTURE / DB_STRUCTURE_TILE.
//     The structure block is a sparse set of usNumberOfStructuresStored records, each:
//       DB_STRUCTURE (16 bytes):
//         u8 ubArmour, u8 ubHitPoints, u8 ubDensity, u8 ubNumberOfTiles,
//         u32 fFlags, u16 usStructureNumber, u8 ubWallOrientation,
//         i8 bDestructionPartner, i8 bPartnerDelta, i8 bZTileOffsetX, i8 bZTileOffsetY, u8 bUnused
//       followed by ubNumberOfTiles * DB_STRUCTURE_TILE (32 bytes each):
//         i16 sPosRelToBase, i8 bXPosRelToBase, i8 bYPosRelToBase, u8 Shape[25],
//         u8 fFlags, u8 ubVehicleHitLocation, u8 bUnused
//     usStructureNumber is the destination index in a [usNumberOfStructures]-sized sparse array.

const HALF = 20; // WORLD_TILE_X / 2

// AUXIMAGEDATA / STRUCTUREDATA flags + size constants from the headers above.
const STRUCTURE_FILE_CONTAINS_AUXIMAGEDATA = 0x01;
const STRUCTURE_FILE_CONTAINS_STRUCTUREDATA = 0x02;
const HEADER_SIZE = 16;
const AUX_SIZE = 16;
const RELTILE_SIZE = 2;
const DB_STRUCTURE_SIZE = 16;
const DB_STRUCTURE_TILE_SIZE = 32;

// DB_STRUCTURE.fFlags bits we care about (Structure Internals.h).
const STRUCTURE_SLIDINGDOOR = 0x00040000;
const STRUCTURE_DOOR = 0x00080000;
const STRUCTURE_DDOOR_LEFT = 0x00400000;
const STRUCTURE_DDOOR_RIGHT = 0x00800000;
const STRUCTURE_ANYDOOR = STRUCTURE_DOOR | STRUCTURE_DDOOR_LEFT | STRUCTURE_DDOOR_RIGHT | 0x00020000; // 0x00CC0000
const STRUCTURE_CORPSE = 0x40000000;

// Replicate AddZStripInfoToVObject for ONE subimage's geometry (structure.cpp ~2335-2525).
// From the sprite's blit offset-X and width, derive the per-20px-strip Z slope:
//   bInitialZChange  — Z bias (in strip-steps) at the leftmost column
//   ubFirstZStripWidth — width (px) of the first, possibly partial, strip
//   pbZChange[]      — signed step (+1/0/-1) applied at each subsequent 20px strip boundary
// Returns null when no slope is produced (a flat tile leaves the Z-buffer untouched, as the game does).
function deriveZStrip(sOffsetX, usWidth) {
  let sLeftHalfWidth, sRightHalfWidth;
  if (sOffsetX <= 0) {
    sRightHalfWidth = usWidth + sOffsetX - HALF;
    if (sRightHalfWidth >= 0) {
      sLeftHalfWidth = -sOffsetX + HALF; // Case 1: straddles bottom corner
    } else {
      // Case 2: all on left side. NB modulo of a negative — match C's truncated-toward-zero %.
      sLeftHalfWidth = usWidth - cmod(sRightHalfWidth, HALF);
      sRightHalfWidth = 0;
    }
  } else if (sOffsetX < HALF) {
    sLeftHalfWidth = HALF - sOffsetX;
    sRightHalfWidth = usWidth - sLeftHalfWidth;
    if (sRightHalfWidth <= 0) { // Case 3 (shouldn't happen for multi-tile)
      sRightHalfWidth = 0;
      sLeftHalfWidth = HALF;
    }
    // else Case 4: straddles bottom corner
  } else {
    // Case 5: all on right side (shouldn't happen for multi-tile)
    sLeftHalfWidth = 0;
    sRightHalfWidth = usWidth;
  }

  let ubNumIncreasing = 0, ubNumStable = 0, ubNumDecreasing = 0;
  if (sLeftHalfWidth > 0) ubNumIncreasing = (sLeftHalfWidth / HALF) | 0;
  if (sRightHalfWidth > 0) {
    ubNumStable = 1;
    if (sRightHalfWidth > HALF) ubNumDecreasing = (sRightHalfWidth / HALF) | 0;
  }

  let ubFirstZStripWidth;
  if (sLeftHalfWidth > 0) {
    ubFirstZStripWidth = sLeftHalfWidth % HALF;
    if (ubFirstZStripWidth === 0) { ubNumIncreasing--; ubFirstZStripWidth = HALF; }
  } else {
    if (sOffsetX > 2 * HALF) ubFirstZStripWidth = HALF - ((sOffsetX - 2 * HALF) % HALF);
    else ubFirstZStripWidth = 2 * HALF - sOffsetX;
    if (ubFirstZStripWidth === 0) { ubNumDecreasing--; ubFirstZStripWidth = HALF; }
  }

  const ubNumberOfZChanges = ubNumIncreasing + ubNumStable + ubNumDecreasing;
  let pbZChange, bInitialZChange;
  if (ubNumberOfZChanges > 0) {
    pbZChange = new Int8Array(ubNumberOfZChanges);
    let k = 0;
    for (let i = 0; i < ubNumIncreasing; i++) pbZChange[k++] = 1;
    for (let i = 0; i < ubNumStable; i++) pbZChange[k++] = 0;
    for (; k < ubNumberOfZChanges; k++) pbZChange[k] = -1;
    if (ubNumIncreasing > 0) bInitialZChange = -ubNumIncreasing;
    else if (ubNumStable > 0) bInitialZChange = 0;
    else bInitialZChange = -ubNumDecreasing;
  } else {
    pbZChange = new Int8Array([0]);
    bInitialZChange = 0;
  }
  return { bInitialZChange, ubFirstZStripWidth, ubNumberOfZChanges, pbZChange };
}

// C truncated-toward-zero modulo (JS % already truncates toward zero, but be explicit).
function cmod(a, b) { return a % b; }

// Parse a .jsd buffer. Returns:
//   { usNumberOfStructures, ubNumberOfTilesPerStruct: Int32Array, anyMultiTile, doorFlag: Uint8Array }
// where the arrays are indexed by usStructureNumber (== STI subimage index). doorFlag marks ANYDOOR
// (non-sliding) structures that the game excludes from ZStrips. Returns null for a non-J2SD buffer.
function parseJsd(buf) {
  if (!buf || buf.length < HEADER_SIZE || buf.toString('latin1', 0, 4) !== 'J2SD') return null;
  const usNumberOfStructures = buf.readUInt16LE(4);
  const usNumberOfStructuresStored = buf.readUInt16LE(6);
  const usStructureDataSize = buf.readUInt16LE(8);
  const fFlags = buf.readUInt8(10);
  const usNumberOfImageTileLocsStored = buf.readUInt16LE(14);
  if (usNumberOfStructures === 0) return null;

  let p = HEADER_SIZE;
  if (fFlags & STRUCTURE_FILE_CONTAINS_AUXIMAGEDATA) {
    p += AUX_SIZE * usNumberOfStructures; // one AuxObjectData per image
    if (usNumberOfImageTileLocsStored > 0) p += RELTILE_SIZE * usNumberOfImageTileLocsStored;
  }

  const numTiles = new Int32Array(usNumberOfStructures);     // ubNumberOfTiles per subimage (0 = none)
  const door = new Uint8Array(usNumberOfStructures);         // 1 = ANYDOOR & !SLIDINGDOOR (no ZStrip)
  let anyMultiTile = false;

  if (fFlags & STRUCTURE_FILE_CONTAINS_STRUCTUREDATA) {
    const end = p + usStructureDataSize;
    for (let s = 0; s < usNumberOfStructuresStored; s++) {
      if (p + DB_STRUCTURE_SIZE > end || p + DB_STRUCTURE_SIZE > buf.length) break;
      const ubNumberOfTiles = buf.readUInt8(p + 3);
      const dbFlags = buf.readUInt32LE(p + 4);
      const usStructureNumber = buf.readUInt16LE(p + 8);
      if (usStructureNumber < usNumberOfStructures) {
        numTiles[usStructureNumber] = ubNumberOfTiles;
        // The game's gate (structure.cpp 2310): allow ZStrip unless ANYDOOR-but-not-SLIDINGDOOR.
        const isAnyDoor = (dbFlags & STRUCTURE_ANYDOOR) !== 0;
        const isSliding = (dbFlags & STRUCTURE_SLIDINGDOOR) !== 0;
        if (isAnyDoor && !isSliding) door[usStructureNumber] = 1;
      }
      if (ubNumberOfTiles > 1 || (dbFlags & STRUCTURE_CORPSE)) anyMultiTile = true;
      p += DB_STRUCTURE_SIZE + ubNumberOfTiles * DB_STRUCTURE_TILE_SIZE;
    }
  }

  return { usNumberOfStructures, numTiles, door, anyMultiTile };
}

// Build the per-subimage ZStripInfo array for an STI, given its parsed .jsd and the STI's subimages.
// Mirrors AddZStripInfoToVObject: a subimage gets a strip iff its structure has ubNumberOfTiles>1
// (the door exclusion aside). Returns an array (length = #subimages) of { ... } | null, or null if
// this STI has no multi-tile structures at all (no ZStrip array allocated, exactly like the game).
function buildZStripsForSti(jsd, subimages) {
  if (!jsd || !jsd.anyMultiTile) return null;
  const out = new Array(subimages.length).fill(null);
  for (let i = 0; i < subimages.length; i++) {
    const nTiles = i < jsd.numTiles.length ? jsd.numTiles[i] : 0;
    if (nTiles > 1 && !jsd.door[i]) {
      const sub = subimages[i];
      out[i] = deriveZStrip(sub.offX, sub.w);
    }
  }
  return out;
}

module.exports = { parseJsd, deriveZStrip, buildZStripsForSti };

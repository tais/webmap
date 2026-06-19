'use strict';
// Parse the WORLD ITEMS (loot) section of a JA2 tactical .dat map: which items are placed where.
//
// The 1.13 format (major>=6 && minor>26) is a recursively-nested, variable-size structure, so the old
// fixed-52-byte reader can't walk it. Layout (spec traced from the engine source — worlddef.cpp
// LoadWorld, World Items.cpp LoadWorldItemsFromMap, Item Types.h, SaveLoadGame.cpp ::Load):
//   u32 count, then `count` WORLDITEMs. Each WORLDITEM = fixed POD (12/16/18 bytes by major) + an
//   OBJECTTYPE. An OBJECTTYPE = 5B POD (usItem,ubNumberOfObjects,ubMission,fFlags) + i32 stackN +
//   stackN * StackedObjectData. Each StackedObjectData = ObjectData blob (16/32/40/48B by version) +
//   i32 attachN + attachN * OBJECTTYPE (recursion). After a stack entry an LBENODE follows IFF the
//   item is IC_LBEGEAR and the entry's bLBE == -1 (LBENODE = 20B POD + i32 invN + invN * OBJECTTYPE).
// All values little-endian; structs are naturally aligned (no #pragma pack).
const IC_LBEGEAR = 0x00020000;

// ObjectData blob width by map version (SaveLoadGame.cpp StackedObjectData::Load).
function objectDataLen(major, minor) {
  if (major >= 8 && minor >= 31) return 48;
  if (major >= 7 && minor >= 31) return 48;
  if (major >= 7 && minor >= 30) return 40;
  if (major >= 7 && minor >= 28) return 32;
  return 16; // older / pre-ITS
}

// Byte offset of the world-items count, just past the tile layers + room info (worlddef.cpp LoadWorld).
function worldItemsOffset(dat) {
  let p = dat.bytesConsumed;
  if (dat.major === 6.0 && dat.minor < 27) p += 37 * 4;  // russian-map junk block (old maps only)
  p += dat.size * (dat.minor < 29 ? 1 : 2);              // room info: 1 byte/tile pre-29, else 2
  return p;
}

const SANE = 200000; // guard against runaway counts on a mis-parse

function loadObject(ctx) {
  const { buf } = ctx;
  if (ctx.p + 9 > buf.length) { ctx.ok = false; return null; }
  const usItem = buf.readUInt16LE(ctx.p);
  const count = buf[ctx.p + 2];
  ctx.p += 5;                                   // OBJECTTYPE POD
  const stackN = buf.readInt32LE(ctx.p); ctx.p += 4;
  if (stackN < 0 || stackN > SANE) { ctx.ok = false; return { usItem, count }; }
  let status = null;
  const attachments = [];
  for (let s = 0; s < stackN && ctx.ok; s++) {
    if (ctx.p + ctx.objLen + 4 > buf.length) { ctx.ok = false; break; }
    if (status === null) status = buf.readInt16LE(ctx.p);   // ObjectData union: INT16 objectStatus @0
    const bLBE = buf.readInt8(ctx.p + 2);                   // OBJECT_LBE.bLBE @2
    ctx.p += ctx.objLen;
    const attachN = buf.readInt32LE(ctx.p); ctx.p += 4;
    if (attachN < 0 || attachN > SANE) { ctx.ok = false; break; }
    for (let a = 0; a < attachN && ctx.ok; a++) { const at = loadObject(ctx); if (at && at.usItem) attachments.push(at.usItem); }
    if (ctx.ok && ctx.lbeSet && ctx.lbeSet.has(usItem) && bLBE === -1) {
      if (ctx.p + 24 > buf.length) { ctx.ok = false; break; }
      ctx.p += 20;                                          // LBENODE POD
      const invN = buf.readInt32LE(ctx.p); ctx.p += 4;
      if (invN < 0 || invN > SANE) { ctx.ok = false; break; }
      for (let c = 0; c < invN && ctx.ok; c++) loadObject(ctx);
    }
  }
  return { usItem, count, status, attachments };
}

// parseWorldItems(buf, dat, lbeSet) -> { items:[{gridNo,level,usItem,count,status,attachments}], count, complete } | null
// lbeSet = Set of item indices whose usItemClass is IC_LBEGEAR (needed to walk past LBE contents).
function parseWorldItems(buf, dat, lbeSet) {
  if (!(dat.flags & 0x8)) return null;                      // MAP_WORLDITEMS_SAVED
  const newFmt = dat.major >= 6.0 && dat.minor > 26;
  let p = worldItemsOffset(dat);
  if (p + 4 > buf.length) return null;
  const n = buf.readUInt32LE(p); p += 4;
  if (n < 0 || n > SANE) return null;
  const ctx = { buf, p, objLen: objectDataLen(dat.major, dat.minor), lbeSet, ok: true };
  const items = [];
  for (let i = 0; i < n && ctx.ok; i++) {
    if (newFmt) {
      let podLen, gridNo, level, usFlags, bVisible;
      if (dat.major < 7.0) { // 12B POD, INT16 sGridNo
        if (ctx.p + 12 > buf.length) { ctx.ok = false; break; }
        gridNo = buf.readInt16LE(ctx.p + 2); level = buf[ctx.p + 4]; usFlags = buf.readUInt16LE(ctx.p + 8); bVisible = buf.readInt8(ctx.p + 11); podLen = 12;
      } else {               // 16B (major7) or 18B (major8) POD, INT32 sGridNo @4
        podLen = dat.major < 8.0 ? 16 : 18;
        if (ctx.p + podLen > buf.length) { ctx.ok = false; break; }
        gridNo = buf.readInt32LE(ctx.p + 4); level = buf[ctx.p + 8]; usFlags = buf.readUInt16LE(ctx.p + 10); bVisible = buf.readInt8(ctx.p + 13);
      }
      ctx.p += podLen;
      const obj = loadObject(ctx);
      if (!ctx.ok || !obj) break;
      items.push({ gridNo, level, usFlags, bVisible, usItem: obj.usItem, count: obj.count, status: obj.status, attachments: obj.attachments });
    } else {                 // legacy fixed 52-byte OLD_WORLDITEM_101
      if (ctx.p + 52 > buf.length) { ctx.ok = false; break; }
      items.push({ gridNo: buf.readInt16LE(ctx.p + 2), level: buf[ctx.p + 4], usItem: buf.readUInt16LE(ctx.p + 8), count: buf[ctx.p + 10], status: null, attachments: [] });
      ctx.p += 52;
    }
  }
  return { items, count: n, complete: ctx.ok, endOffset: ctx.p };
}

module.exports = { parseWorldItems, worldItemsOffset, objectDataLen, IC_LBEGEAR };

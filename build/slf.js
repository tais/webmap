'use strict';
// SLF (Sir-Tech Library File) archive reader.
// Layout (confirmed from source/ext/VFS/src/Ext/slf/vfs_slf_library.cpp):
//   532-byte header; int32 LE @512 = entry count; directory table at EOF = count * 280 bytes.
//   Per DIRENTRY (280 bytes): name = bytes[0..255] (NUL-terminated latin1),
//   uiOffset u32 LE @+256, uiLength u32 LE @+260, ubState byte @+264 (0 = OK).
const fs = require('fs');

const ENTRY_SIZE = 280;

function normalize(name) {
  return name.replace(/\\/g, '/').toLowerCase();
}

function openSlf(filePath) {
  const data = fs.readFileSync(filePath);
  const count = data.readInt32LE(512);
  const dirStart = data.length - count * ENTRY_SIZE;
  const index = new Map();
  for (let i = 0; i < count; i++) {
    const o = dirStart + i * ENTRY_SIZE;
    if (o < 0 || o + ENTRY_SIZE > data.length) break;
    if (data[o + 264] !== 0) continue; // skip non-OK (deleted/old) entries
    let end = data.indexOf(0, o);
    if (end < 0 || end > o + 256) end = o + 256;
    const name = data.toString('latin1', o, end);
    const offset = data.readUInt32LE(o + 256);
    const length = data.readUInt32LE(o + 260);
    index.set(normalize(name), { name, offset, length });
  }
  return {
    data,
    count,
    index,
    names() { return [...index.values()].map((e) => e.name); },
    has(name) { return index.has(normalize(name)); },
    get(name) {
      const e = index.get(normalize(name));
      return e ? data.subarray(e.offset, e.offset + e.length) : null;
    },
  };
}

module.exports = { openSlf };

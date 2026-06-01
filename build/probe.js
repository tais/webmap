'use strict';
// Phase 0 sanity probe: verify SLF/STI/tileset/dat decoders against the real game data.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { openSlf } = require('./slf');
const { decodeSti } = require('./sti');
const { createTilesetResolver } = require('./tilesets');
const { parseDat } = require('./dat');
const { encodePNG } = require('./png');

function sectorCode(name) {
  // e.g. "J9.dat" -> "J9", "I13_b1.dat" -> "I13_b1"
  return name.replace(/\.dat$/i, '');
}

console.log('=== Maps.slf ===');
const maps = openSlf(cfg.MAPS_SLF);
const datNames = maps.names().filter((n) => /\.dat$/i.test(n));
const surface = datNames.filter((n) => /^[A-P]([1-9]|1[0-6])\.dat$/i.test(path.basename(n)));
const underground = datNames.filter((n) => /_b[123]\.dat$/i.test(n));
console.log(`total entries: ${maps.count}, .dat files: ${datNames.length}`);
console.log(`surface sectors: ${surface.length}, underground: ${underground.length}`);
console.log('sample:', datNames.slice(0, 8).map(sectorCode).join(', '));

console.log('\n=== Ja2Set.dat.xml + Tilesets.slf ===');
const res = createTilesetResolver(cfg.JA2SET_XML, cfg.TILESETS_SLF);
console.log(`tilesets parsed: ${res.tilesets.filter(Boolean).length}, Tilesets.slf entries: ${res.slf.count}`);
console.log('tileset 0 name:', res.tilesets[0].name, '| file[0..3]:', res.tilesets[0].files.slice(0, 4));
const earth = res.resolve(0, 0); // type 0 of generic = first ground texture
console.log('resolve(0,0):', earth ? `${earth.width}x${earth.height}, ${earth.nSub} subimages` : 'MISSING');

console.log('\n=== parse a sample map ===');
const sampleName = datNames.find((n) => /^j9\.dat$/i.test(path.basename(n))) || datNames[0];
const datBuf = maps.get(sampleName);
const m = parseDat(datBuf);
console.log(`${sampleName}: major=${m.major} minor=${m.minor} ${m.rows}x${m.cols} tileset=${m.tilesetId}`);
console.log(`bytesConsumed=${m.bytesConsumed} / fileSize=${m.fileSize} (consumed before optional/room sections)`);
function layerStats(name, layer, counts) {
  let tiles = 0, nodes = 0, maxType = 0, maxSub = 0;
  for (let i = 0; i < layer.length; i++) {
    if (layer[i]) {
      tiles++;
      nodes += layer[i].length;
      for (const n of layer[i]) { if (n.type > maxType) maxType = n.type; if (n.sub > maxSub) maxSub = n.sub; }
    }
  }
  console.log(`  ${name.padEnd(7)} tiles=${String(tiles).padStart(6)} nodes=${String(nodes).padStart(6)} maxType=${maxType} maxSub=${maxSub}`);
}
layerStats('land', m.land);
layerStats('object', m.object);
layerStats('struct', m.struct);
layerStats('shadow', m.shadow);
layerStats('roof', m.roof);
layerStats('onroof', m.onroof);

// Resolve every distinct (type,sub) reference in this map; report hit rate.
const refs = new Set();
for (const layer of [m.land, m.object, m.struct, m.roof, m.onroof]) {
  for (const cell of layer) if (cell) for (const n of cell) refs.add(n.type * 100000 + n.sub);
}
let ok = 0, bad = 0;
for (const key of refs) {
  const type = Math.floor(key / 100000), sub = key % 100000;
  const sti = res.resolve(m.tilesetId, type);
  if (sti && sti.subimages[sub - 1]) ok++; else bad++;
}
console.log(`distinct tile refs: ${refs.size}, resolvable: ${ok}, unresolved: ${bad}`);
console.log('resolver stats:', res.stats);

// Dump a couple of tileset STIs to PNG for eyeballing.
fs.mkdirSync(path.join(cfg.DIST, 'debug'), { recursive: true });
function dumpFirstSub(tilesetId, type, label) {
  const sti = res.resolve(tilesetId, type);
  if (!sti || !sti.subimages.length) { console.log(`  (no sti for ${label})`); return; }
  const s = sti.subimages[0];
  fs.writeFileSync(path.join(cfg.DIST, 'debug', `${label}.png`), encodePNG(s.rgba, s.w, s.h));
  console.log(`  wrote debug/${label}.png (${s.w}x${s.h})`);
}
console.log('\n=== debug PNG dumps ===');
dumpFirstSub(m.tilesetId, 0, 'ground_type0');
dumpFirstSub(0, 0, 'generic_type0');
console.log('\nPhase 0 probe complete.');

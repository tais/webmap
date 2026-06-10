'use strict';
// Parses Ja2Set.dat.xml (per-tileset list of STI filenames, indexed by tile TYPE)
// and resolves a (tilesetId, type) reference to a decoded STI from Tilesets.slf,
// falling back to the GENERIC tileset (0) when a tileset lacks a file for a type.
const fs = require('fs');
const { openSlf } = require('./slf');
const { decodeSti } = require('./sti');
const { parseJsd, buildZStripsForSti } = require('./structure');

const GENERIC_TILESET = 0;

function parseJa2Set(xmlPath) {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  const tilesets = [];
  const tsRe = /<Tileset\s+index="(\d+)"\s*>([\s\S]*?)<\/Tileset>/g;
  let m;
  while ((m = tsRe.exec(xml))) {
    const idx = parseInt(m[1], 10);
    const body = m[2];
    const nameM = /<Name>([\s\S]*?)<\/Name>/.exec(body);
    const files = [];
    const fileRe = /<file\s+index="(\d+)"\s*>([\s\S]*?)<\/file>/g;
    let fm;
    while ((fm = fileRe.exec(body))) {
      files[parseInt(fm[1], 10)] = fm[2].trim();
    }
    tilesets[idx] = { name: nameM ? nameM[1].trim() : '', files };
  }
  return tilesets;
}

function createTilesetResolver(ja2setXmlPath, tilesetsSlfPath) {
  const tilesets = parseJa2Set(ja2setXmlPath);
  const slf = openSlf(tilesetsSlfPath);
  const stiCache = new Map(); // slf path -> decoded STI | null
  const stats = { resolved: 0, fallback: 0, missing: 0 };

  // Fetch the .jsd structure file paired with an STI path (same `id\name`, .JSD extension), parse it,
  // and return the per-subimage ZStripInfo array (null when this STI has no multi-tile wall structures).
  // The .jsd lives in the SAME Tilesets.slf next to the STI (1266 of them). Used to drive the per-pixel
  // wall Z-strips in renderSector, exactly like the game's AddZStripInfoToVObject.
  function loadZStrips(p, sti) {
    const jpath = p.replace(/\.sti$/i, '.JSD');
    const jbuf = slf.get(jpath);
    if (!jbuf) return null;
    let jsd;
    try { jsd = parseJsd(jbuf); } catch (e) { jsd = null; }
    if (!jsd) return null;
    try { return buildZStripsForSti(jsd, sti.subimages); } catch (e) { return null; }
  }

  function loadStiByPath(p) {
    if (stiCache.has(p)) return stiCache.get(p);
    const buf = slf.get(p);
    let sti = null;
    if (buf) {
      try { sti = decodeSti(buf); } catch (e) { sti = null; }
      if (sti) sti.zstrips = loadZStrips(p, sti); // per-subimage wall Z-strips (or null)
    }
    stiCache.set(p, sti);
    return sti;
  }

  // Returns decoded STI (with .subimages) for this (tilesetId, type) or null.
  function resolve(tilesetId, type) {
    const ts = tilesets[tilesetId];
    const fname = ts && ts.files[type];
    if (fname) {
      const sti = loadStiByPath(`${tilesetId}\\${fname}`);
      if (sti) { stats.resolved++; return sti; }
      const sg = loadStiByPath(`${GENERIC_TILESET}\\${fname}`);
      if (sg) { stats.fallback++; return sg; }
    }
    const g = tilesets[GENERIC_TILESET];
    const gname = g && g.files[type];
    if (gname) {
      const sti = loadStiByPath(`${GENERIC_TILESET}\\${gname}`);
      if (sti) { stats.fallback++; return sti; }
    }
    stats.missing++;
    return null;
  }

  return { tilesets, slf, resolve, loadStiByPath, stats };
}

module.exports = { parseJa2Set, createTilesetResolver, GENERIC_TILESET };

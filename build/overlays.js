'use strict';
// Parses the game's TableData/Map XML into overlay data (embedded into dist/data.js):
//   sectorNames, water, towns(+loyalty/militia), samSites, mines, coolness (heatmap),
//   facilities, bloodcats, heliSites, shipping (in-Arulco delivery/airport sectors)
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { openSlf } = require('./slf');
const { parseDat } = require('./dat');

const LETTERS = 'ABCDEFGHIJKLMNOP';
const codeFromXY = (x, y) => LETTERS[y - 1] + x; // x=col 1..16, y=row 1..16
const read = (file) => fs.readFileSync(path.join(cfg.TABLEDATA_MAP, file), 'utf8');
const readArmy = (file) => fs.readFileSync(path.join(cfg.TABLEDATA_MAP, '..', 'Army', file), 'utf8');
const readScript = (file) => fs.readFileSync(path.join(cfg.GAME_ROOT, 'Scripts', file), 'utf8');
const readRoot = (file) => fs.readFileSync(path.join(cfg.GAME_ROOT, file), 'utf8');
// Read a TableData file by JA2 1.13 VFS priority: Data-1.13/TableData overrides Data/TableData.
const readTable = (rel) => {
  const p113 = path.resolve(cfg.GAME_ROOT, '..', 'Data-1.13', 'TableData', rel);
  const p = fs.existsSync(p113) ? p113 : path.join(cfg.TABLEDATA_MAP, '..', rel);
  return fs.readFileSync(p, 'utf8');
};
const tag = (b, t) => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(b); return m ? m[1].trim() : null; };
const numTag = (b, t) => { const v = tag(b, t); return v === null ? null : +v; };
const sector = (b) => { const v = tag(b, 'SectorGrid'); return v ? v.toUpperCase() : null; };

function parseSectorNames(xml) {
  const names = {}, water = {};
  let m; const re = /<SECTOR>([\s\S]*?)<\/SECTOR>/g;
  while ((m = re.exec(xml))) {
    const c = sector(m[1]); if (!c) continue;
    names[c] = tag(m[1], 'szExploredName') || '';
    const w = numTag(m[1], 'sWaterType'); if (w) water[c] = w;
  }
  return { names, water };
}

function parseCities(xml) {
  const towns = {};
  let m; const re = /<CITY>([\s\S]*?)<\/CITY>/g;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const id = numTag(b, 'uiIndex'); if (!id) continue;
    const tp = /<townPoint>\s*<x>([\d.]+)<\/x>\s*<y>([\d.]+)<\/y>/.exec(b);
    towns[id] = { id, name: tag(b, 'townName') || '', point: tp ? { x: +tp[1] / 10, y: +tp[2] / 10 } : null, sectors: [],
      loyalty: numTag(b, 'townUsesLoyalty') === 1, militia: numTag(b, 'townMilitiaAllowed') === 1, rebelSentiment: numTag(b, 'townRebelSentiment') };
  }
  let r; const rowRe = /<CITY_TABLE_ROW\s+row="(\d+)">([^<]*)<\/CITY_TABLE_ROW>/g;
  while ((r = rowRe.exec(xml))) {
    const row = +r[1]; if (row < 1 || row > 16) continue;
    const vals = r[2].trim().split(/\s+/).map(Number);
    for (let col = 1; col <= 16; col++) { const id = vals[col]; if (id && towns[id]) towns[id].sectors.push(codeFromXY(col, row)); }
  }
  return Object.values(towns).sort((a, b) => a.id - b.id);
}

function parseSamSites(xml) {
  const sams = []; let m; const re = /<SAM>([\s\S]*?)<\/SAM>/g;
  while ((m = re.exec(xml))) {
    const b = m[1]; const index = numTag(b, 'samIndex');
    const sec = /<samSector>\s*<x>(\d+)<\/x>\s*<y>(\d+)<\/y>/.exec(b);
    if (index && sec) sams.push({ index, code: codeFromXY(+sec[1], +sec[2]), hidden: numTag(b, 'samHidden') === 1 });
  }
  return sams;
}

// 16x16 grid of enemy-strength / progression "coolness" (0-20). -> { "A1": 5, ... }
function parseCoolness(xml) {
  const cool = {}; let r; const re = /<MAP_ROW\s+row="(\d+)">([^<]*)<\/MAP_ROW>/g;
  while ((r = re.exec(xml))) {
    const row = +r[1]; if (row < 1 || row > 16) continue;
    const vals = r[2].trim().split(/\s+/).map(Number);
    for (let col = 1; col <= 16; col++) if (Number.isFinite(vals[col - 1])) cool[codeFromXY(col, row)] = vals[col - 1];
  }
  return cool;
}

function parseFacilityTypes(xml) {
  const types = {}; let m; const re = /<FACILITYTYPE>([\s\S]*?)<\/FACILITYTYPE>/g;
  while ((m = re.exec(xml))) { const idx = numTag(m[1], 'ubIndex'); if (idx) types[idx] = tag(m[1], 'szFacilityShortName') || tag(m[1], 'szFacilityName') || ('Facility ' + idx); }
  return types;
}
function parseFacilities(xml, types) {
  const fac = {}; let m; const re = /<FACILITY>([\s\S]*?)<\/FACILITY>/g;
  while ((m = re.exec(xml))) {
    const code = sector(m[1]); const t = numTag(m[1], 'FacilityType');
    if (code && types[t]) { (fac[code] = fac[code] || []); if (!fac[code].includes(types[t])) fac[code].push(types[t]); }
  }
  return fac;
}

// Sectors with bloodcat placements -> { code: maxBloodcats } (max across difficulty tiers).
function parseBloodcats(xml) {
  const bc = {}; let m; const re = /<SECTOR>([\s\S]*?)<\/SECTOR>/g;
  while ((m = re.exec(xml))) {
    const code = sector(m[1]); if (!code) continue;
    let max = 0, g; const mx = /<ubMaxBloodcats>(\d+)<\/ubMaxBloodcats>/g;
    while ((g = mx.exec(m[1]))) max = Math.max(max, +g[1]);
    if (max > 0) bc[code] = max;
  }
  return bc;
}

function parseHeli(xml) {
  const sites = []; let m; const re = /<REFUEL>([\s\S]*?)<\/REFUEL>/g;
  while ((m = re.exec(xml))) { const sec = /<refuelSector>\s*<x>(\d+)<\/x>\s*<y>(\d+)<\/y>/.exec(m[1]); if (sec) sites.push({ code: codeFromXY(+sec[1], +sec[2]) }); }
  return sites;
}

function parseShipping(xml) {
  const dests = []; let m; const re = /<DESTINATION>([\s\S]*?)<\/DESTINATION>/g;
  while ((m = re.exec(xml))) {
    const b = m[1]; const name = tag(b, 'name'); const mx = numTag(b, 'ubMapX'), my = numTag(b, 'ubMapY');
    if (name && mx && my) dests.push({ code: codeFromXY(mx, my), name });
  }
  return dests;
}

// Enemy garrison per sector: GarrisonGroups (Sector -> Composition) x ArmyComposition (counts/quality).
function parseGarrisons(garXml, compXml) {
  const comp = {}; let m; const cre = /<COMPOSITION>([\s\S]*?)<\/COMPOSITION>/g;
  while ((m = cre.exec(compXml))) {
    const b = m[1], i = numTag(b, 'Index');
    if (i !== null) comp[i] = { pop: numTag(b, 'StartPopulation'), elite: numTag(b, 'ElitePercentage'), troop: numTag(b, 'TroopPercentage'), admin: numTag(b, 'AdminPercentage') };
  }
  const gar = {}; const gre = /<GARRISON>([\s\S]*?)<\/GARRISON>/g;
  while ((m = gre.exec(garXml))) {
    const b = m[1], code = (tag(b, 'Sector') || '').toUpperCase(), ci = numTag(b, 'Composition');
    if (code && comp[ci]) gar[code] = comp[ci];
  }
  return gar;
}

// Patrol routes: each patrol's ordered waypoint sectors (excluding the "0" placeholder).
function parsePatrols(xml) {
  const out = []; let m; const re = /<PATROL>([\s\S]*?)<\/PATROL>/g;
  while ((m = re.exec(xml))) {
    const b = m[1], size = numTag(b, 'Size');
    const wp = [];
    for (let i = 1; i <= 4; i++) { const s = tag(b, 'Sector' + i); if (s && s !== '0') wp.push(s.toUpperCase()); }
    if (wp.length >= 2) out.push({ size, sectors: wp });
  }
  return out;
}

// Mines from initmines.lua: mineral type, production rate, linked underground sectors.
function parseMines(lua, names) {
  const out = []; let m;
  const re = /Location\s*=\s*"([A-P]\d+)"\s*,\s*Type\s*=\s*MineType\.(\w+)\s*,\s*MinimumProduction\s*=\s*(\d+)\s*,\s*AssociatedUnderground\s*=\s*\{([^}]*)\}\s*,?\s*(?:Infectible\s*=\s*(\d))?/g;
  while ((m = re.exec(lua))) {
    const code = m[1].toUpperCase();
    out.push({ code, name: names[code] || 'Mine', mineral: m[2], production: +m[3], underground: m[4].match(/[A-P]\d+-\d/g) || [], infectible: m[5] === '1' });
  }
  return out;
}

// Per-sector terrain type + cardinal traversability (ROAD / rivers / barriers) from MovementCosts.xml.
function parseTerrain(xml) {
  const t = {}; let m; const re = /<Sector\s+y="([A-P])"\s+x="(\d+)">([\s\S]*?)<\/Sector>/g;
  while ((m = re.exec(xml))) {
    const code = m[1] + +m[2], b = m[3];
    t[code] = { here: tag(b, 'Here'), n: tag(b, 'North'), e: tag(b, 'East'), s: tag(b, 'South'), w: tag(b, 'West') };
  }
  return t;
}

// Creature (Crepitus) infestation zones (sci-fi mode). The attack source is on the surface (z0); the
// queen and habitats are underground (z1-3). Returns per-cell entries (code + level z + role) so the
// viewer can show them on the matching level, plus a per-zone summary.
function parseCreatures(xml) {
  const cells = [], zones = [], rank = { queen: 3, attack: 2, habitat: 1 };
  let m; const re = /<PLACEMENT>([\s\S]*?)<\/PLACEMENT>/g;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const zone = ((/<!--\s*([A-Za-z ]+?)\s*-->/.exec(b) || [])[1] || 'Creatures').trim();
    const attack = ((/<ATTACKSOURCE>\s*<SectorGrid>([^<]+)/.exec(b) || [])[1] || '').toUpperCase();
    const qm = /<QUEENSECTOR>\s*<SectorGrid>([^<]+)<\/SectorGrid>\s*<SectorZ>(\d+)/.exec(b);
    if (attack) cells.push({ code: attack, z: 0, role: 'attack', zone });
    if (qm) cells.push({ code: qm[1].toUpperCase(), z: +qm[2], role: 'queen', zone });
    let h; const hre = /<HABITATSECTOR>\s*<SectorGrid>([^<]+)<\/SectorGrid>\s*<SectorZ>(\d+)/g;
    while ((h = hre.exec(b))) cells.push({ code: h[1].toUpperCase(), z: +h[2], role: 'habitat', zone });
    zones.push({ zone, attack, queen: qm ? `${qm[1].toUpperCase()} (b${qm[2]})` : null });
  }
  const seen = new Map();
  for (const c of cells) { const k = c.code + ':' + c.z; const e = seen.get(k); if (!e || rank[c.role] > rank[e.role]) seen.set(k, c); }
  return { cells: [...seen.values()], zones };
}

// Quest / points-of-interest sectors from Mod_Settings.ini (NAME_SECTOR_X/_Y globals).
function parsePOIs(ini) {
  const val = (k) => { const m = new RegExp('^\\s*' + k + '\\s*=\\s*(\\d+)', 'm').exec(ini); return m ? +m[1] : null; };
  const sec = (pfx) => { const x = val(pfx + '_X'), y = val(pfx + '_Y'); return x >= 1 && x <= 16 && y >= 1 && y <= 16 ? codeFromXY(x, y) : null; };
  const out = [];
  const defs = [
    ['HIDEOUT_SECTOR', 'Rebel hideout'], ['BOBBYR_SHIPPING_DEST_SECTOR', 'Bobby Ray delivery ✈'],
    ['PRISON_SECTOR', 'Tixa prison'], ['HOSPITAL_SECTOR', 'Hospital'], ['PORN_SHOP_TONY_SECTOR', 'Tony (dealer)'],
    ['KINGPIN_HOUSE_SECTOR', 'Kingpin'], ['BROTHEL_SECTOR', 'Brothel'], ['INITIAL_POW_SECTOR', 'Captured merc (POW)'],
    ['CARMEN_GIVE_REWARD_SECTOR', 'Carmen (bounties)'], ['DYNAMO_CAPTIVE_SECTOR', 'Dynamo (captive)'],
  ];
  for (const [k, label] of defs) { const c = sec(k); if (c) out.push({ code: c, label }); }
  for (let i = 1; i <= 5; i++) { const c = sec('WEAPON_CACHE_' + i); if (c) out.push({ code: c, label: 'Weapon cache' }); }
  for (let i = 1; i <= 4; i++) { const c = sec('ADD_MADLAB_SECTOR_' + i); if (c) out.push({ code: c, label: 'Madlab (possible)' }); }
  return out;
}

// NPC + shopkeeper/dealer home sectors from MercProfiles.xml; Merchants.xml flags which profile
// ids are arms dealers. Keep only placed (sSectorX/Y > 0) dealers and story NPCs (Type 4).
function parseNPCs(profilesXml, merchantsXml) {
  const dealers = new Set();
  let m; const dre = /<MERCHANT>([\s\S]*?)<\/MERCHANT>/g;
  while ((m = dre.exec(merchantsXml))) { const id = numTag(m[1], 'ubShopKeeperID'); if (id != null) dealers.add(id); }
  const out = []; const pre = /<PROFILE>([\s\S]*?)<\/PROFILE>/g;
  while ((m = pre.exec(profilesXml))) {
    const b = m[1];
    const id = numTag(b, 'uiIndex'), type = numTag(b, 'Type');
    const sx = numTag(b, 'sSectorX'), sy = numTag(b, 'sSectorY'), sz = numTag(b, 'sSectorZ') || 0;
    if (id == null || !sx || !sy) continue;                 // unplaced (0,0) -> not on the map
    const isDealer = dealers.has(id);
    if (!isDealer && type !== 4) continue;                  // dealers + story NPCs only (skip AIM/MERC/generic)
    const name = (tag(b, 'zNickname') || tag(b, 'zName') || '').trim();
    if (!name) continue;
    out.push({ code: codeFromXY(sx, sy), name, role: isDealer ? 'dealer' : 'npc', z: sz });
  }
  return out;
}

// ---- world-item spawns (per-map loot), parsed straight from the tactical .dat files ----
// usItemClass bitmasks (Item Types.h). NOTABLE = what we list; WEAPON = what flags a sector as loot.
const IC = { GUN: 0x2, BLADE: 0x4, KNIFE: 0x8, LAUNCHER: 0x10, THROWN: 0x40, GRENADE: 0x100, BOMB: 0x200, AMMO: 0x400, ARMOUR: 0x800, MEDKIT: 0x1000, MONEY: 0x20000000 };
const NOTABLE = IC.GUN | IC.BLADE | IC.KNIFE | IC.LAUNCHER | IC.THROWN | IC.GRENADE | IC.BOMB | IC.AMMO | IC.ARMOUR | IC.MEDKIT | IC.MONEY;
const WEAPON = IC.GUN | IC.BLADE | IC.KNIFE | IC.LAUNCHER | IC.GRENADE | IC.BOMB | IC.ARMOUR;
function parseItemTable(xml) {
  const t = {}; let m; const re = /<ITEM>([\s\S]*?)<\/ITEM>/g;
  while ((m = re.exec(xml))) { const b = m[1], i = numTag(b, 'uiIndex'); if (i == null) continue; t[i] = { name: tag(b, 'szItemName') || tag(b, 'szLongItemName') || ('#' + i), cls: numTag(b, 'usItemClass') || 0 }; }
  return t;
}
// Each vanilla (<6.0) map stores world items as fixed 52-byte OLD_WORLDITEM_101 records (verified):
//   sGridNo @2 (INT16), object @8 -> usItem @8 (UINT16), ubNumberOfObjects @10 (UINT8).
// Newer (>=6.0, minor>26) maps use a variable recursive format — we report the count only.
function parseItems(itemTbl) {
  const slf = openSlf(cfg.MAPS_SLF);
  const dirs = [path.resolve(cfg.GAME_ROOT, '..', 'Data-1.13', 'Maps'), path.join(cfg.GAME_ROOT, 'Maps')];
  const resolve = (code) => { const fn = code.toLowerCase() + '.dat'; for (const d of dirs) { const p = path.join(d, fn); if (fs.existsSync(p)) return fs.readFileSync(p); } return slf.get(code + '.dat'); };
  const codes = new Set();
  for (const n of slf.names()) { const b = path.basename(n); if (/^[a-p]\d{1,2}(_b\d)?\.dat$/i.test(b)) codes.add(b.replace(/\.dat$/i, '').toUpperCase()); }
  for (const d of dirs) if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) { const m = /^([a-p]\d{1,2}(_b\d)?)\.dat$/i.exec(f); if (m) codes.add(m[1].toUpperCase()); }
  const out = {};
  for (const code of [...codes].sort()) {
    const buf = resolve(code); if (!buf) continue;
    let dat; try { dat = parseDat(buf); } catch (e) { continue; }
    if (!(dat.flags & 0x8)) continue; // MAP_WORLDITEMS_SAVED
    let p = dat.bytesConsumed; if (dat.major === 6.0 && dat.minor < 27) p += 37 * 4; p += dat.size * (dat.minor < 29 ? 1 : 2); // skip room info
    if (p + 4 > buf.length) continue;
    const N = buf.readUInt32LE(p), base = p + 4;
    if (N <= 0) continue;
    if (dat.major >= 6.0 && dat.minor > 26) { out[code] = { partial: true }; continue; } // variable format — can't parse loot
    if (base + N * 52 > buf.length) continue;
    const qty = {}; let weapons = false, loot = 0; // count only NOTABLE loot; ignore map triggers/Action Items (IC_MISC)
    for (let k = 0; k < N; k++) {
      const o = base + k * 52, it = buf.readUInt16LE(o + 8), num = buf[o + 10] || 1, info = itemTbl[it];
      if (!info || !(info.cls & NOTABLE)) continue;
      qty[info.name] = (qty[info.name] || 0) + num; loot += num;
      if (info.cls & WEAPON) weapons = true;
    }
    if (loot > 0) out[code] = { count: loot, weapons, notable: Object.entries(qty).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([name, q]) => ({ name, qty: q })) };
  }
  return out;
}

function build() {
  const { names: sectorNames, water } = parseSectorNames(read('SectorNames.xml'));
  const towns = parseCities(read('Cities.xml'));
  const samSites = parseSamSites(read('SamSites.xml'));
  const mines = parseMines(readScript('initmines.lua'), sectorNames);
  const terrain = parseTerrain(read('MovementCosts.xml'));
  const creatures = parseCreatures(read('CreaturePlacements.xml'));
  const pois = parsePOIs(readRoot('Mod_Settings.ini'));
  const coolness = parseCoolness(read('CoolnessBySector.xml'));
  const facilities = parseFacilities(read('Facilities.xml'), parseFacilityTypes(read('FacilityTypes.xml')));
  const bloodcats = parseBloodcats(read('BloodcatPlacements.XML'));
  const heliSites = parseHeli(read('HeliSites.xml'));
  const shipping = parseShipping(read('ShippingDestinations.xml'));
  const garrisons = parseGarrisons(readArmy('GarrisonGroups.xml'), readArmy('ArmyComposition.xml'));
  const patrols = parsePatrols(readArmy('PatrolGroups.xml'));
  const npcs = parseNPCs(readTable('MercProfiles.xml'), readTable(path.join('NPCInventory', 'Merchants.xml')));
  const militiaCap = 20; // MAX_MILITIA_PER_SECTOR default (Ja2_Options.ini)
  const items = parseItems(parseItemTable(readTable(path.join('Items', 'Items.xml'))));

  const out = { sectorNames, water, towns, samSites, mines, coolness, facilities, bloodcats, heliSites, shipping, garrisons, patrols, terrain, creatures, pois, npcs, militiaCap, items };
  fs.mkdirSync(cfg.DIST, { recursive: true });
  fs.writeFileSync(path.join(cfg.DIST, 'overlays.json'), JSON.stringify(out, null, 1));
  console.log(`overlays: ${towns.length} towns, ${mines.length} mines (${mines.map((m) => m.code + ':' + m.mineral).join(',')}), ${Object.keys(coolness).length} coolness, ` +
    `${Object.keys(facilities).length} facility, ${Object.keys(bloodcats).length} bloodcat, ${garrisons && Object.keys(garrisons).length} garrison, ${patrols.length} patrol, ` +
    `${Object.keys(terrain).length} terrain, ${creatures.zones.length} creature zones (${creatures.cells.length} cells), ${pois.length} POIs, ${npcs.length} NPCs/dealers, ${Object.keys(items).length} maps w/ items`);
  return out;
}

if (require.main === module) build();
module.exports = { build };

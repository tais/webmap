'use strict';
const path = require('path');

const GAME_ROOT = path.resolve(__dirname, '..', '..', 'JA2', 'Data');

module.exports = {
  GAME_ROOT,
  MAPS_SLF: path.join(GAME_ROOT, 'Maps.slf'),
  TILESETS_SLF: path.join(GAME_ROOT, 'Tilesets.slf'),
  RADARMAPS_SLF: path.join(GAME_ROOT, 'Radarmaps.slf'),
  JA2SET_XML: path.join(GAME_ROOT, 'Ja2Set.dat.xml'),
  TABLEDATA_MAP: path.join(GAME_ROOT, 'TableData', 'Map'),
  DIST: path.resolve(__dirname, '..', 'dist'),
  // Render scale: 1.0 = native (40px tiles). 0.5 keeps assets manageable.
  RENDER_SCALE: 1.0,
};

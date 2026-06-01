# Arulco Tactical World Map (JA2 1.13)

An interactive web map that stitches all of Jagged Alliance 2 1.13's **Arulco** tactical
maps into one zoomable strategic world map, rendered from the game's real isometric tile
graphics (not the low-res radar minimaps). These are the standard 160×160 maps — **202
surface + 38 underground sectors** — laid out on the familiar 16×16 sector grid (A–P × 1–16).

![overview](dist/overview_surface.webp)

## Using the map

Open `index.html` in a browser, or serve the folder (`python3 -m http.server`) and open it.

- **Drag** to pan, **scroll** to zoom, **click** a sector for its info. High-detail tiles
  stream in as you zoom.
- **Level** switcher — Surface / Basement 1–3.
- **Roofs** toggle — off reveals building interiors (surface).
- **Layers** panel — towns, mines, SAM sites, enemy garrisons, patrol routes, quests & POIs,
  NPCs & dealers, loot, creature zones, roads & rivers, terrain, and a difficulty heatmap.
- Touch: one-finger pan, pinch zoom, tap select. Keys: WASD/arrows pan, `+`/`−` zoom,
  `F` fit, `Esc` deselect.
- The URL captures the view — `#@<col>,<row>,<zoom>` and `#<SECTOR>` are shareable links;
  `?level=b1`, `?roofs=0`, and per-layer `?mine=0` work too.

## Building it yourself

The game data is **not** included — point the build at a JA2 1.13 install (paths in
`build/config.js`), then:

```sh
node build/build.js --webp --detail 1.0 --webp-quality 70
```

Requirements: **Node.js** (zero npm dependencies) and, for WebP output, the **`cwebp`**
tool (`brew install webp`). The build decodes the game data and writes `dist/` — the
per-sector tiles, level overviews, and `manifest.json` / `data.js`. Then open `index.html`
or serve the folder.

Handy flags: `--one <SECTOR>` renders a single sector for debugging, `--webp-quality <n>`
trades size for quality, `--detail <0..1>` scales tile resolution. Drop `--webp` for an
indexed-PNG fallback (no `cwebp` needed).

## What it reads

Everything is decoded from the game's own files, from scratch:

- **SLF** archives (maps and tilesets)
- **STI / ETRLE** images (tile graphics)
- **`.dat`** tactical maps (160×160)
- **JA2SET** tileset tables (XML) — the tile → graphic mapping
- **TableData** / scripts — sector names, towns, mines, garrisons, loot, etc. (the overlays)

Tiles are sliced into a small multi-resolution **pyramid** (6400×3200 down to 1600×800), so
the viewer only ever loads the on-screen tiles — smooth panning even at native resolution.

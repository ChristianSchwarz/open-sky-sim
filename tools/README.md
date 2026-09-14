# Mod import tools

Tools for converting external Unity asset-bundle mods (e.g. Tiny Combat Arena
aircraft) into retroflightsim-compatible glTF models.

## Why this is needed

retroflightsim is a flat-shaded, **palette-based** renderer: it has no detail
textures. Each surface is one flat colour picked by the material *name*, which
normally maps to a `PaletteCategory`.

Many low-poly mods work the same way in spirit: their entire livery (paint,
national insignia, side numbers, red trim, warning triangles) is authored as
flat polygon **"vector decals"** whose colours come from a tiny
**palette-swatch texture** � a 16x16 (or similar) image of solid colour cells,
where every triangle's UVs point at one cell.

The importer recovers those real per-polygon colours by sampling the swatch
texture at each face's UV centroid, groups faces by colour, and writes a glTF
with one mesh/material per distinct colour. Each material is named `#rrggbb`,
and the sim renders that literal colour (see `ModelManager.rawColorFor` and the
`rawColor` path in `SceneMaterialManager`). Transparent glass keeps the `GLASS`
palette category so it stays tinted.

## Requirements

```
pip install UnityPy trimesh numpy pillow
```

## In-app import (F10)

The command-line workflow below is for authoring and repeatable builds. For a
quick import while the sim is running, press **`F10`** in the app and select a
mod `.zip`. The dev server (`tools/modserver.ts`, started by `npm run serve`)
receives the upload at `POST /api/import-mod`, runs `import_mod.py` and
`pack_aircraft_mods.py` for you, and the app registers and lets you fly the
result. The Python requirements above must be installed for this to work.

By default the in-app import uses a generic flyable config (no animated control
surfaces, active flight model). **Multi-plane mod packs are split by Unity livery
material** � each aircraft becomes its own `.aircraft.pack` with its colours
preserved. To ship full fidelity for a single plane, drop a `retroflight.json`
file (the same schema as `tools/mods/*.json`) inside the mod `.zip`; the server
will use it, overriding only `bundle`/`out`/`outPrefix`.

Inspect liveries in a bundle before importing:

```
python tools/import_mod.py --bundle "mods/mod.zip" --discover
```

## Usage

The `--bundle` input can be a mod **`.zip`** (e.g. a Tiny Combat Arena workshop
download), a raw Unity asset-bundle file, or a folder. A `.zip` is unpacked and
the Unity bundle inside (identified by its `UnityFS` header) is located
automatically.

### 1. Inspect a mod

Always look before importing � this lists textures (flagging likely
palette-swatch atlases), materials (texture / colour / alpha), and every mesh
GameObject with its material(s):

```
python tools/import_mod.py --bundle "C:/Downloads/my_aircraft_mod.zip" --list
```

### 2. Import

Straight from the CLI (auto-detects the palette texture and glass):

```
python tools/import_mod.py --bundle "C:/Downloads/mod.zip" --out assets/foo_static.gltf
```

Or, for repeatability, with a JSON config (recommended). Copy
`tools/mods/_template.json`, fill in `bundle` + `out`, and tweak from there:

```
python tools/import_mod.py --config tools/mods/mod.json
```

Only `bundle` and `out` are required; every other field has a sensible default
(include everything, drop colliders/shadows, auto-detect glass and the palette
swatch). Use `--list` to discover part and material names before narrowing the
include/skip lists.

A mod can have its own convenience wrapper:

```
python tools/build_mod_gltf.py
```

### 3. Wire it into the sim

The importer produces loose glTF files under `assets/` for editing and tests.
At build time, `tools/pack_aircraft_mods.py` bundles each flyable mod into a
single `dist/assets/{id}.aircraft.pack` file. Shipped mods keep
their manifests under `assets/`; **F10 imports** stage loose glTF files under
`tools/mods/imports/` until packing � they are not written into `assets/`.

To register a flyable mod, load its pack in `src/script/state/game.ts`:

```
await this.aircraftRegistry.loadPack('mymod', 'assets/mymod.aircraft.pack');
```

For parked ramp models, reference pack URLs in
`src/script/state/staticModelViews.ts` (e.g. `pack:mymod/mymod_static.gltf`).

### 4. Build

```
npm run build
```

Runs webpack and then `npm run pack-mods`. The deployable mod output is
`dist/assets/*.aircraft.pack`, not the hundreds of loose per-mod glTF files in
`assets/`.

## Config schema (`tools/mods/*.json`)

See `tools/mods/_template.json` for a copy-paste starting point. Only `bundle`
and `out` are required.

TCA part/material naming conventions (shared materials, control-surface fallbacks,
gear meshes, glass/nozzle detection, livery discovery) live in
[`tools/tca_mapping.json`](tca_mapping.json), derived from
[`docs/tca-aircraft-mods.md`](../docs/tca-aircraft-mods.md). Per-import config
keys such as `glassParts`, `nozzleParts`, and `skipNameParts` extend that base
mapping at runtime rather than replacing it.

| Field            | Meaning                                                              |
| ---------------- | ------------------------------------------------------------------- |
| `bundle`         | **(required)** Path to a mod `.zip`, a Unity asset-bundle file, or a folder. |
| `out`            | **(required)** Output `.gltf` path (relative to project root).      |
| `bufferPrefix`   | Prefix for the `.bin` buffers (defaults to the output file stem).   |
| `groundDistance` | Distance from model origin down to the ground (2.0 for aircraft).   |
| `groundContactPercentile` | Bottom percentile of `groundParts` vertex Y used as the wheel contact plane (default 10). Avoids mesh-min spikes that float the visible tire tread. |
| `groundContactInsetM` | Extra metres to shift the model down after percentile alignment (default 0). |
| `scale`          | Uniform scale applied to geometry (default 1.0).                    |
| `rotationEuler`  | `[x, y, z]` degrees to reorient a model that faces the wrong way.   |
| `swatchMax`      | Max texture size in px treated as a palette swatch (default 64).    |
| `glassColor`     | Flat colour for glass parts with no palette tint (default `#d1f7ff`). |
| `glassParts`     | Part-name substrings always exported as glass.                      |
| `glassAutoAlpha` | Auto-treat transparent materials as glass (default `true`).         |
| `glassAlphaMax`  | Alpha below which a material counts as glass (default `0.9`).        |
| `nozzleAuto`     | Auto-detect afterburner nozzle interiors and export them as dark metal `#rrggbb` (default `#1a1a1a`, or the material's black rest `_Color`). Afterburner glow is procedural at `fx.nozzles`, not on the body mesh. Detected by `NozzleInteriorMat` or mesh-name fallbacks. |
| `nozzleColor`    | Literal `#rrggbb` for nozzle-interior faces when the source material has no dark base colour. |
| `nozzleParts`    | Extra part-name substrings to treat as nozzle interiors.            |
| `nozzleMaterials`| Extra material-name substrings to treat as nozzle interiors.        |
| `emissiveLights` | Export materials with a bright `_EmissionColor` over a dark base (e.g. nav/beacon lights) as their literal emissive colour instead of the flat `_Color` (default `true`). |
| `emissiveMaterials` | Optional allow-list of material names permitted to glow; empty means any qualifying material. |
| `materialColors` | Map of Unity material name -> `#rrggbb` **or** a `PaletteCategory` (e.g. `"GLASS"`, `"FX_FIRE"`). Overrides palette sampling for those materials. |
| `groundParts`    | Part names whose mesh sets the ground contact height (wheel meshes). Uses the bottom `groundContactPercentile` of each part's vertices, then the highest contact among parts so tricycle mains do not float. On flyable imports, also auto-generates `flight.gear.points` from each part's mesh minimum Y for FM2 physics. `gearWheelParts` is accepted as an alias. |
| `skipMaterials`  | Material-name substrings whose meshes are dropped (colliders etc.). |
| `skipExact`      | Part names dropped exactly.                                         |
| `includeExact`   | Part names always kept even if they match a skip substring.         |
| `skipNameParts`  | Part-name substrings to drop (gauges, weapons, colliders, ...).     |
| `skipClutter`    | When `true`, skip weapon/pylon/gauge clutter from [`tca_mapping.json`](tca_mapping.json) `importClutterSkip`. Defaults to `false`; cockpit/canopy/attachment empties are kept. |
| `bitmapLivery`   | When `true` (default), sample large livery bitmap textures at face UVs (downsampled to `bitmapSampleMax`, default 512). Without this, only palette swatches ? `swatchMax` are sampled. |
| `dedupeParts`    | Keep one mesh per `(name, transformRoot)`. With `includeMaterials`, also span-clusters airframe roots so a shared livery name on an unrelated larger hull (or duplicate packed copies) is not merged into the export. |
| `rescueNozzleUnderRoot` | Multi-plane imports: re-admit nozzle-interior meshes under the same transform root as the livery even when their material differs. Defaults to `true` when `includeMaterials` is set. |
| `rescueNozzleGlobal` | When `true` (default with `includeMaterials`), also re-admit off-root pooled nozzle meshes that lie near the livery hull bounds. |
| `rescueGlassGlobal` | Same spatial rescue for canopy/glass parts (off-root pooled canopies). Defaults to `true` with `includeMaterials`. |
| `rescueCockpit` | Re-admit cockpit-interior meshes (by name) under the livery root or near the hull. Defaults to `true` with `includeMaterials`. |
| `wingtipParts`   | Extra part-name substrings treated as wingtip meshes for `fx.wingtips` trail origins (default mapping matches `WingTip` / `Wingtip`). |

With `skipClutter` false (the F10 default for flyable imports), cockpit/canopy
meshes export while weapons/pylons/gauges are still skipped when
`skipClutter` is enabled. Narrow further with `skipNameParts` / `skipExact`.

Mesh names containing `Shadow` are **always** skipped (in addition to
`skipNameParts`). TCA's shared `ColliderMat` meshes are exported as an invisible
`*_collision.gltf` plus baked `collisionMesh` triangles for combat/ground hits.
`ShadowDepthOffset` / authored shadow meshes remain skipped — shared shadow materials are
referenced by GUID and usually are not bundled with a workshop mod, so their
material name cannot be resolved; the name fallback ensures those meshes are
still dropped (the sim generates its own shadow silhouette). Use `includeExact`
to keep a legitimate part whose name happens to contain one of these words.
Do **not** globally skip `WingInner*` — those meshes are wing fill on many
airframes; dropping them leaves rectangular holes in the wings.

### Per-material colour overrides

`materialColors` is the general way to fix a specific material's colour when the
palette/alpha heuristics get it wrong. The value can be either a literal
`#rrggbb` (rendered as-is) or the name of a sim `PaletteCategory` such as
`GLASS` or `VEHICLE_PLANE_GREY` (tinted by the active palette/time). Example:

```json
"materialColors": { "CanopyRubber": "#262826", "Windscreen": "GLASS" }
```

## Planet terrain

`assets/planet` is a **build product**, not a tracked asset. It is gitignored
and must be generated locally before the sim will show terrain.

The pipeline has five stages:

```
# 1. heights: WGS84 GeoTIFF -> .pdm pyramid + index.bin + manifest.json
pip install rasterio numpy
python tools/bake_planet_dem.py --input data/output_hh.tif --out assets/planet

# 2. coastlines: OSM -> .lwm masks + .lvr land polygons + inland water
pip install shapely requests
python tools/bake_osm_coast.py --manifest assets/planet/manifest.json

# 3. airfields: OSM aeroways -> an `airfields` block in manifest.json
npm run bake:airports
npm run verify:airports

# 4. cover: landcover + satellite imagery -> .plc per tile   (optional)
npm run fetch:cover
npm run bake:cover

# 5. meshes: .pdm + .lvr + .plc -> draw-ready .ptm tiles + index_mesh.bin
npm run bake:mesh
npm run verify:planet -- --dir assets/terrain

# 6. far-tile textures: leaf .ptm facets -> .ptx per coarse tile + index_tex.bin   (optional)
npm run bake:tex
```

Stage 6 rasterises every leaf's land facets top-down and folds the images up
the quadtree, so a coarse tile can paint the leaf's land-use detail as a
texture instead of one colour per facet (see `docs/terrain-far-textures.md`).
It reads only stage 5's output; without it the runtime paints facets as before.
In the game the *Far tile textures* switch on the World settings tab turns the
textures off and on, and the F9 performance HUD's terrain streaming line
(the one starting `Q`) shows `TEXn` for the number of resident tiles carrying
one.

Stage 5 is the only place terrain geometry is produced. The runtime fetches,
decodes and draws — it never triangulates — so there is no fallback path that
can drift out of sync with the bake.

Two more checks read the finished tiles back and compare them against the OSM
water they were baked from, each taking `z/x/y` arguments:

```bash
npx tsx tools/verify_water.ts 12/4387/853    # lakes: is the interior wet?
npx tsx tools/verify_rivers.ts 12/4387/853   # rivers: drawn, and in one piece?
```

`verify_water.ts` reports *interior* cells only, so a river two cells across is
invisible to it — and most are not water in the mesh at all. `verify_rivers.ts`
checks the other half: that every centreline reached the mesh as a stroke, that
the stroke covers its length, and that none of it is buried under the terrain.

Stage 4 is optional. Skip it and every land facet comes out plain grass, which
is what the bake produced before cover existed.

### Airfields

Stage 3 pulls `aeroway=*` out of OpenStreetMap and writes an `airfields` block
into `assets/planet/manifest.json`. It is the same data openairportmap.org
draws — that site is an Overpass front end over `aeroway`, so this queries
Overpass directly and caches the answer in `data/osm-cache` alongside the coast
bake's.

Per airfield it records the runways as OSM has them (centre, true heading,
measured length, width, surface, and the `ref` the designators are painted
from), the taxiways, aprons and buildings, a set of oriented rectangles the
terrain would have to be cut flat under, and one plane — height and
longitudinal gradient — fitted to the DEM across that footprint.

The mesh bake reads those rectangles and cuts the terrain to them — oriented to
the runway and following its fitted slope, rather than levelled into a shelf.
The cover bake paints the same footprints as built ground, and both the shore
classifier and the runtime height sampler treat a platform's flat core as land
whatever the coastline says, which is what keeps Gran Canaria's seaward apron
from coming out as a notch of open ocean.

It also copies the descriptions to `assets/terrain/airfields.json` — a sibling
file rather than a manifest block, because the runways, taxiways and aprons of
a whole pyramid run to 350 KB against a 44 KB manifest that is fetched before
anything can be drawn. The runtime builds each airfield's pavement, threshold
bars, painted designators, aiming points, centreline, taxiways and aprons as
flat geometry laid on the same plane the terrain was cut to, and makes each
runway solid ground.

The sim is then based at one of them: the nearest usable airfield to the play
origin, which is where the spawns are, which way the ILS points, and what the
hangars, the tower and the ramp are laid out around. The spawn menu offers the
others. AI pilots are handed every runway in the area and pick their own by
proximity, so one that takes off from a field returns to it.

Only the runway strips and the largest aprons are cut flat, so the taxiways and
the rest of the aprons are draped on the terrain instead of laid on the
airfield's plane — the network reaches a kilometre past the strips, and on the
plane it floats or buries itself by up to twenty metres. Concrete gets its own
palette tone: a slab-laid military field reads markedly paler than an asphalt
civil one, and the taxiways and aprons follow their own runway's surface.

Terminals, hangars and control towers are drawn too — as boxes, which is what
they are from the air in a sim with one flat colour per surface. Their heights
come from OSM's `height` or `building:levels` where it has them (11 of 265) and
from the kind and footprint where it does not: a hangar is built round a tail
so it is tall in proportion to its span, a terminal is a long low shed, and a
control tower is the one building at an airfield taller than it is wide. They
are obstacles the AI steers round, not collision meshes — a ground-height query
walks every scenery soup, and 265 boxes in that loop would be paid for on every
contact test of every frame.

Widths come from OSM where it has them and from the aerodrome class where it
does not, which for taxiways is almost always — 667 of 684 across the baked
airfields carry no `width` tag at all. The defaults are Annex 14's code
letters: 23 m at an international field down to 10.5 m at a light-aircraft
strip, and the same idea gives runways 45 m down to 18 m.

**The invented pad is gone.** An area with a real airfield in it no longer gets
the 1 x 4 km level box flattened at its centre, and `assets/runway01.gltf` is
only drawn for an area that has no airfield at all — a pyramid baked before
this stage existed, which still gets exactly the world it always had.

Two details worth knowing when reading the report:

- **The gradient is clamped to ICAO limits** (1% for runways over 1200 m, 2%
  below). A steeper fit is the DEM disagreeing with itself, not a runway.
- **SRTM is a surface model.** It has terminal roofs and hangars in it, and an
  airport is where those are large and numerous. The fit trims its high tail
  and reports what it dropped as `outlierMaxM` — at Gran Canaria, whose
  platform carries 59 mapped buildings, that is 31 m of terminal.

`npm run verify:airports` re-derives all of it from what is on disk, with no
network, and separates *problems* (the heights are gone, or the stored plane no
longer matches them — exit 1) from *notes* (OSM disagreeing with itself, which
it does constantly on small fields — exit 0). Add `--verbose` for a line per
airfield, or `--icao GCLP` for one.

### Height sources

Stage 1 needs one axis-aligned EPSG:4326 GeoTIFF. `data/output_hh.tif` is the
tracked one and it only covers the Canaries, so any other part of the world
has to be fetched first:

```
# 0. heights for an arbitrary bbox -> a stage 1 input GeoTIFF
npm run fetch:dem -- --bbox 7.6,45.9,7.8,46.0 --out data/imports/matterhorn.tif
python tools/bake_planet_dem.py --input data/imports/matterhorn.tif --out assets/planet
```

`fetch_planet_dem.py` reads a public 1 degree squares archive over
`/vsicurl/`, so only the windows overlapping the bbox are transferred. By
default that archive is **FABDEM** (Forest And Buildings removed Copernicus
DEM, University of Bristol, mirrored on Hugging Face) rather than raw
Copernicus DEM GLO-30: Copernicus GLO-30 is a surface model, so a hangar or a
forest canopy bakes in as terrain height, while FABDEM applies a learned
correction back to bare earth on the same 1 arcsec grid and datum. Pass
`--source copernicus` to fetch the uncorrected archive instead — useful for
reproducing an old bake, or for `compare_planet_dem.py` diffs against one.

Copernicus publishes squares only where there is land, and the tool caches
`tileList.txt` under `data/imports/` so an all-ocean square is skipped by name
rather than by waiting for a 404. FABDEM has no such index here, so an
all-ocean FABDEM square is skipped only once the fetch itself comes back
empty.

The 1 arcsec default resolution is load-bearing rather than arbitrary. Stage 1
derives the pyramid's max zoom from the source pixel, and 1 arcsec lands on
**z12** — the same depth `data/output_hh.tif` bakes to. Fetch at the default
and an imported area joins the pyramid at a uniform depth; fetch coarser (say
`--arcsec 3`, which bakes to z10) and it does not.

| Option | Meaning |
| --- | --- |
| `--bbox` | **(required)** `west,south,east,north` in degrees. Spans crossing the antimeridian are refused. |
| `--out` | Output GeoTIFF (default `data/imports/dem.tif`). |
| `--source` | `fabdem` (default) or `copernicus`. |
| `--arcsec` | Output pixel in arcseconds (default 1.0, the archive spacing). |
| `--max-span` | Refuse a bbox wider or taller than this (default 6 degrees). Bake cost grows with area. |
| `--no-snap` | Do not align the box to tiles and the shared lattice. See below — only useful for reproducing the seam bug. |
| `--refresh-tile-list` | Re-fetch the cached archive tile list. |

`data/imports/` is gitignored — these are fetched inputs, like `data/cover`.

#### Why the box gets snapped

The fetched bbox is grown outwards to whole z12 tile edges, and the pixel step
is nudged (1 arcsec → 1.0013 at z12) so a whole number of pixels spans a tile.

Both exist because `SourceSampler.sample_grid` resolves nodes outside the
raster to the sea datum — right for a standalone bake, where the raster edge
is effectively coast, and wrong the moment a second area is merged in. An area
whose raster stops halfway across a tile gets that tile half-filled with fake
ocean, and merging its neighbour later writes that ocean over real ground.
Measured on two adjacent Alpine areas, unsnapped, that is a **4.1 km** error.

Snapping to tiles alone is not enough: an arcsecond does not divide a tile
(158.2 of them), so aligning to a lattice anchored at −180 pushes the box a
sliver past the tile edge, and the bake claims the next tile along and fills
*it* with sea. Rounding the step so the lattice and the tile grid are the same
grid removes that. With both in place, neighbouring areas agree on their shared
tile edge to **0.04 m** — pure quantisation — against **8.3 m** with only the
tile snap.

### Adding an area to an existing pyramid

`bake_planet_dem.py` owns the whole tree: run it twice and you have the second
area, not both. `merge_planet_dem.py` is the additive form.

```
npm run fetch:dem -- --bbox 7.6,45.9,7.8,46.0 --out data/imports/alps.tif
npm run merge:dem -- --input data/imports/alps.tif --out assets/planet
python tools/bake_osm_coast.py --bbox 7.6,45.9,7.8,46.0
npm run bake:airports -- --bbox 7.6,45.9,7.8,46.0
npm run fetch:cover -- --bbox 7.6,45.9,7.8,46.0
npm run bake:cover -- --bbox 7.6,45.9,7.8,46.0 --osm-landuse
npm run bake:mesh -- --bbox 7.6,45.9,7.8,46.0
npm run bake:tex -- --bbox 7.6,45.9,7.8,46.0
```

`--osm-landuse` (the F9 import pipeline passes it too — see
[`--osm-landuse`](#--osm-landuse-real-vector-edges-instead-of-raster-stairsteps)
below) paints real OSM vector polygon edges over the raster classes for this
area; drop it from the `bake:cover` line to fall back to the raster-only
behaviour above.

**Pass the same `--bbox` to every stage.** It is what makes each one additive.
Without it a stage walks the whole pyramid, and since its sources only cover
the new area, every tile outside gets rewritten from nothing: stage 2 turns
other coastlines into open ocean, stage 4 writes unknown-class cover over
real cover, stage 5 re-meshes the world for no reason. With it, each stage
touches only the tiles that overlap, and merges its pyramid-wide records
(the index, the swatch table, the level skirts, the coverage box) with what
the previous bake left rather than replacing them.

Verified on two adjacent Alpine areas: baking them as two scoped runs gives a
`assets/terrain` byte-identical to one unscoped bake of both — same 60 .ptm
files, same index, same manifest.

#### The box is snapped to whole tiles

Every stage writes whole tiles, and a stage whose sources stop halfway across
one still writes all of it. What it writes over the half it has no data for is
not "nothing": it is **open ocean** from the coast bake and unknown cover from
the cover bake, on top of whatever a neighbouring area baked there.

So a hand-drawn box is grown outwards onto whole zoom-12 tile edges before any
stage sees it — by `snapBboxToTiles` for an F9 import, and again inside
`bake_osm_coast.py` for anything run by hand. `fetch_planet_dem.py` already did
this for the DEM; the other stages needed it too.

Measured on two overlapping Crimea imports before the fix: the second box's
southern edge fell at lat 45.204449, a third of the way down tile row 1019. That
row was in range, the bake rewrote all of it, and the lower two thirds came out
as sea — a 3.5 km strip of Black Sea straight across the middle of the
peninsula, over ground the first import had baked correctly. Snapped, the same
two areas stitch: every tile in row 1019 comes back 100% land at every node row.

The cost is at most one extra tile ring per side, baked with real data.

Tiles are a global quadtree, so a new area shares ancestors with everything
already baked — a z0 tile is the ancestor of a hemisphere. `build_parent` fills
any quadrant it is not given with sea level, so rebuilding an ancestor from
only the *new* children would erase the siblings a previous bake wrote. The
merge loads those siblings back off disk (`decode_tile`) and hands
`build_parent` all four.

Dequantising a sibling costs half a quantisation step — centimetres — and does
not compound, since a rebuilt ancestor is written from its children and never
from its own previous self. Merging Morocco into the Canaries pyramid preserved
every existing land node at every shared level with a peak drift of 0.04 m.

Where a new area overlaps something already baked, the new data wins.
`--dry-run` reports what would be written without touching the tree.
`compare_planet_dem.py --a DIR --b DIR` diffs two pyramids tile by tile, which
is how the above was checked.

Stage 2 shares the ancestor problem and the same fix: `build_parent_mask`
leaves any quadrant it is not given as *water*, so it reloads the siblings on
disk (`read_lwm`) before decimating. Stage 3 has no ancestors — one `.plc` per
tile, sampled directly — so it only needs the bbox. Stage 4 has no ancestors
either, but two records describe the whole tree and are merged rather than
replaced:

* **`index_mesh.bin`** — the runtime reads "not in the index" as "ocean, draw a
  patch", so an index rewritten from one scoped run would flatten every other
  area. The bake unions its output with the index already there.
* **`swatch_histogram.bin`** — the swatch table and luminance window in the
  manifest quantise *every* tile, whichever bake produced it. The colour counts
  cannot be recovered from finished `.ptm` files without decoding all of them,
  so the bake keeps them beside the tiles (32768 bins, 128 KB) and adds to
  them. **Re-baking the same area counts its colours twice**; run one unscoped
  bake to reset the table if that ever skews it.

### Importing from inside the app (F9)

Press **F9** while the dev server is running (`npm run serve`) and pick the area
on an OpenStreetMap map: drag to pan, wheel to zoom, **shift-drag** to draw the
box. The readout gives the bbox, its size in km and how many terrain tiles the
bake will touch, and refuses anything over the 6 degree limit. Name it, tick
*Satellite colour* if you want the imagery stage, and press Import.

That runs exactly the command sequence below, server-side, streaming each
stage's output back into the dialog — so it is the same bake, not a second
implementation of one. Closing the dialog does not stop it; the job is on the
server. Reload when it finishes and pick the area under *Settings -> Area*.

The map is served through `/api/osm/:z/:x/:y`, which proxies
`tile.openstreetmap.org` with an identifying User-Agent, caches every tile
under `tools/osm-cache/` and refuses zoom past 12 — enough to stay well inside
the OSM tile usage policy for picking an area. Point `OSM_TILE_URL` in
[`tools/areaImport.ts`](areaImport.ts) at your own tile server if you ever need
more than that.

### Deleting an area

Each baked area in the dialog carries a small **×**: it removes the area's
tiles from both trees, server-side, with the same streamed progress. Behind it
is `tools/delete_area.py` — the inverse of `merge_planet_dem.py`:

```
python tools/delete_area.py --name alps            # add --dry-run to just look
npm run bake:mesh -- --bbox <box it prints>
```

Only tiles no *remaining* area claims are deleted; a tile two areas overlap
belongs to both and stays. Every ancestor the area's heights were decimated
into is rebuilt from the children still on disk — otherwise the coarse view
keeps ghost mountains — and deleted outright where none survive. The manifests'
`areas`, `coverage` and airfield records shrink to match. The second command is
what the in-app delete runs for you: coarse *meshes* around the hole can only
be rebuilt by the mesh bake.

Deleting the last area is refused — that is the whole terrain.

### Flying somewhere else

Each bake records the area it covered under `areas` in the manifest, named by
`--name` (default: the input file stem). `coverage` cannot serve here — it is
the union box of everything baked, so two areas become one rectangle spanning
the sea between them, with no way back to either.

```
npm run merge:dem -- --input data/imports/alps.tif --name alps --out assets/planet
```

The *Area* control in the options panel lists them and reloads into the one you
pick; it hides itself when there is only one. Picking an area moves the ENU
origin to that area's box centre, because ENU is a tangent frame — a thousand
kilometres out, the float32 the GPU gets per vertex is coarse enough to shimmer
and the ground is below the horizon anyway.

The area holding `PLAY_ORIGIN` is *home*, found by position rather than by name
so renaming an area cannot strand the scenery somewhere it was not built for.
Home keeps that origin exactly.

**Every area gets an airbase.** Stage 4 flattens one pad per area — at
`PLAY_ORIGIN` for home, at the box centre for the rest — and the runtime puts
the runway, hangars and tower on it. Local ENU (0, 0) *is* the pad centre in
every area, which is what `airbaseOffset` already measures from, so the
placement code is the same in all of them. Runway and approach spawns therefore
work anywhere.

What does not travel is the carrier: it needs the open water ten kilometres east
of Gran Canaria, which is a fact about that island rather than about airbases,
so its two spawns fall back to the runway elsewhere. The refinery, SAM site and
warehouse stay home too — they are the Canaries scenario at offsets chosen for
that terrain. The spawn you asked for is still what gets saved, so coming home
restores it.

Each pad is measured in a frame centred on itself. A pad is an axis-aligned box
in ENU and ENU axes turn with position, so one laid out in the bake's frame
would sit skewed against the local north the runtime flattens against. Pads are
also *placed* from their baked lat/lon rather than assumed to sit at the origin:
at home that resolves to (0, 0) exactly as before, and elsewhere a foreign
area's pad lands at its real offset — 111 km away for Tenerife — and touches
nothing.

### Which way is north

Scene space is **x = east, y = up, z = south** — north is −z. Three.js is
right-handed with +Y up, so east × up is *south*; calling +z north makes the
frame left-handed and every position expressed in it comes out mirrored, with
what is really east of the pilot drawn to the west. It is also the sign the
rest of the sim has always used: `vectorHeading` reads a bearing as
atan2(x, −z).

The bake writes tile vertices and normals in those axes directly (the runtime
binds them to the GPU untouched), and `sceneFromEnu` / `enuFromScene` in
`terrain/geodesy.ts` are the only places the flip happens. Tiles carrying the
old north-on-+z layout are PTM1 v3 and are refused at load with a message
naming `npm run bake:mesh`, because a mirrored tile is exactly the kind of
wrong that looks fine until you compare it with a map.

### Tiles are baked in one frame and drawn in another

A baked tile stores its vertices as offsets from the tile centre **in the frame
the bake used** (`manifest.enuOrigin`). Drawing it from a rebased origin means
turning those offsets into the drawing frame's axes first, or every vertex
lands wrong in proportion to its distance from the tile centre — measured half
a z12 tile out, **62 m at Tenerife and 2.5 km in the Alps**.

`enuFrameRotation` supplies that rotation. It is one constant for the whole
scene, exact rather than approximate, and the identity whenever the two frames
share an origin — which is every session flying at home. Ocean patches are
built at runtime in the drawing frame already and are left alone.

### What the runtime reads

`manifest.coverage` is the bounding box of everything baked, so with two areas
far apart it spans the sea between them. Nothing at runtime treats it as the
authority any more — both tile stores gate on the index (`index.bin`,
`index_mesh.bin`), and `HeightField.loadCoarse` enumerates the index rather
than walking the box. A tile missing from the index is never requested, and
"missing" means ocean, which is what the sea ellipsoid is for.

The box survives only as the fallback when an index cannot be fetched. Even on
the single-area Canaries pyramid it over-asks: 18 coarse tiles implied by the
box against the 10 that exist.

### Terrain colour

A land facet is baked carrying two observations of the ground it covers: a
**landcover class** and a **satellite colour**. Both travel in the same four
bytes per vertex, and which of them ends up on screen is a runtime choice —
the *Terrain colour* setting in the options panel, four modes, one uniform
write each:

| Mode | Colour |
| --- | --- |
| Landcover | class picks a palette tone; the most retro of the four |
| Swatches | satellite colour snapped to the table the bake derived |
| Hybrid | palette tone for the hue, satellite luminance for a banded shade |
| Imagery | the satellite colour itself |

`fetch_cover_sources.py` pulls both sources into `data/cover` (gitignored):

* **ESA WorldCover 2021 v200** — 10 m, 11 classes, CC-BY 4.0, read from the
  public `esa-worldcover` S3 bucket. Ocean-only 3-degree tiles are not
  published at all, so 404s during the fetch are expected and skipped.
* **Sentinel-2 L2A true colour** — scenes found through the Earth Search STAC
  API, `visual` asset read from the public `sentinel-cogs` bucket. The search
  pages until it has every MGRS square over the coverage: one busy square
  fills a page on its own, and a single-page search comes back holding nothing
  but cloud-free open ocean.

Both are written at a deliberately coarse resolution (`--landcover-m`,
`--imagery-m`, default 20 m and 40 m). A facet at the finest zoom covers
30–100 m of ground, so anything sharper is averaged away in stage 4 anyway.

`bake_planet_cover.py` then resamples them onto each tile's own grid and
writes `.plc` alongside the `.pdm`.

`--patch-m` (default 250) is the one knob worth turning. WorldCover is a 10 m
product and it is right at 10 m — a single shed really is built-up — but at
the scale a facet paints, single-pixel truth is noise: the raw raster holds
1550 separate class regions on one z12 tile, 60% of them four nodes or
smaller, and the terrain comes out as confetti. A local majority filter over
the *land* classes, sized from a ground distance rather than a node count,
merges them into patches that read at the stated size. On tile `12/3744/1411`:

| | regions | median region | area in sub-250 m regions |
| --- | --- | --- | --- |
| `--patch-m 0` | 1550 | 33 m across | 23% |
| `--patch-m 250` | 44 | 260 m across | 2% |

Water and nodata are fixed points — never reassigned, never allowed to vote —
so the coastline comes through untouched. Without that the sea is the local
majority along any shore and it swallows headlands whole. Tiles are read with
a halo (`tools/cover_patches.py`, `halo_nodes`), which makes the result
identical to filtering the whole coverage at once; it also makes tile edges
*more* consistent than the unfiltered bake, because a 15-node majority barely
notices the half-pixel phase difference between two tiles' source reads
(measured on an adjacent pair: 55 and 29 disagreeing edge nodes unfiltered, 0
and 5 filtered).

Only the class raster changes. Where imagery exists the facet colours come out
bit-identical, so `Swatches` and `Imagery` are untouched and only the two
palette-driven modes get the bigger patches. Changing `--patch-m` means
re-running `npm run bake:cover` **and** `npm run bake:mesh`.

A tile is baked whole even where the source raster does not reach it, and the
part with no source falls back to class colours. That edge case is not rare: a
tile can overlap the raster by less than one pixel, which survives the bounds
test and is then rounded away, leaving a window that starts past the raster's
last column. `rasterio`'s `Window.intersection` **raises** on an empty overlap
rather than returning an empty window, so the degenerate check behind it never
ran and the whole bake died with `WindowError: Intersection is empty` instead of
skipping one tile. It shows up on a bbox about a tile wide — the raster comes
out ~123 px across and a tile asks for column 123. The window is clamped by hand
now; see `Source.read_onto`.

#### `--osm-landuse`: real vector edges instead of raster stairsteps

Every boundary the raster path produces is a WorldCover-pixel stairstep,
smoothed by the majority filter above but never a real edge — because there
never was a vector edge to begin with. `--osm-landuse` paints actual OSM
`natural=wood`/`landuse=farmland`/etc. polygons (fetched via Overpass, same
client as stage 2/3) over the class grid *after* the majority filter and
*before* the airfield stamp, so a facet boundary can trace the real mapped
shape wherever OSM has one. It is a layer on top of the raster, not a
replacement: OSM landuse tagging is patchy the same way stage 2's own
coastline coverage is, so anywhere OSM has nothing, the raster class (and its
majority-filtered patch) is left exactly as it would be without the flag.

```
python tools/bake_planet_cover.py --osm-landuse --bbox=west,south,east,north
```

A `bake_planet_cover.py` flag, not a default — it's passed explicitly by both
the F9 import pipeline (`areaImport.ts`'s `plan()`) and the manual recipe
above, but a bare `npm run bake:cover` with no `--bbox` still omits it: it
requires `shapely` (`pip install shapely`) and either `--bbox` or `--only`,
refusing to run bare since a full-pyramid rebake's tile list spans every baked
area (Crimea to the Grand Canyon) and a planet-wide Overpass fetch is not
something to trigger by omission. Add
`--refresh-osm` to bypass the Overpass cache (`data/osm-cache`, shared with
stages 2/3) the way `bake_osm_coast.py --refresh` does. Every Overpass fetch
is made one grid cell at a time (whole zoom-7 tiles, 1.4 degrees a side,
two in flight at once) and each cell's answer is cached on its own as a
gzipped pickle, so an import that overlaps or grows an earlier one only
fetches the cells it did not already have; entries from before the pickle
cache (`.json.gz`) are still read and rewritten in the new form. Painted classes never
include Sand (bake-assigned downstream by stage 5's shore-adjacency logic) or
Water (stage 2 already owns the land/water split geometrically) — see
`tools/osm_landuse.py`'s `LANDUSE_TAG_TO_CLASS` for the full tag table.

### Inland water

Lakes and rivers are not the sea and must not be baked at sea level. Dropping
them there punches a slot through the world: measured on the Colorado in the
Grand Canyon, tile 12/1545/1226, the DEM reads 734-774 m along the river while
the mesh sat it at 0 m and hung 740 m walls off both banks.

Stage 2 therefore emits a second polygon layer. Land is assembled exactly as
before — every water polygon, inland ones included, is still subtracted from it,
so the ocean shoreline is unchanged — and the inland bodies are reported
alongside it in an **LVR2** vector tile. Tiles with no lake or river in them stay
LVR1 and are left byte-identical.

Each body is one of two kinds, decided by its OSM tags:

* **Flat** — `natural=water` (any `water=*` that is not a watercourse) and
  `landuse=reservoir`. A lake sits at one elevation; water that is not level
  reads as broken from the air immediately.
* **Flowing** — `waterway=riverbank` and `water=river|stream|canal|ditch|drain`.
  A river descends across a tile, so it follows the DEM per-node instead. It is
  never flat, but it is never wrong either.

Only bodies wide enough for the node grid come through this way. The narrow ones
— which is most watercourses — are drawn instead, as strokes; see below.

`natural=bay` stays with the ocean: a bay is the sea reaching inland.

#### Rivers and canals: a stroke, not a cut

A watercourse at true width does not survive the node grid. The shoreline cut
samples grid nodes, so anything under a couple of cells across lands on one only
where the polygon happens to cross it: the river comes out as a dashed line, or,
under one cell, as nothing at all. A cell is 12 x 19 m at Potsdam z12 and four
times that a level up, and OSM tags the canals there at 12 m.

Widening them until the grid could hold them was tried and rejected. It works,
in the sense that the dashes go away — measured per flowing body on the Potsdam
bake, 19 of 32 drawn nowhere became 0 of 32 — but it buys that by drawing a 12 m
canal 48 m wide at every range, including the range where you are looking
straight down at it. There is no width in metres that is both visible from 20 km
and honest from 200 m, because the requirement is not in metres. It is in pixels.

So watercourses are cut out of the terrain problem entirely and drawn over it:

1. **Stage 2** keeps every `waterway=river|canal` centreline as a line, with the
   true width off its `width` tag or a per-kind fallback, and writes it into a
   third **LVR3** layer. It still buffers the same line into a water polygon, so
   a river wide enough to be real water still gets a real water surface with a
   shoreline cut around it — nothing about the wide ones changes.
2. **Stage 4** resamples each centreline to one point per grid cell, drops it
   onto the surface the tile actually *draws* — not the DEM, which at z10 is
   529 m of decimation away from it — and emits two vertices per point at the
   same position, carrying opposite unit offsets across the flow. The width is
   not in the geometry.
3. **The renderer** widens it, in `RiverVertProgram`. The stroke is drawn at its
   true width until that falls below `RIVER_MIN_HALF_PIXELS`, and then it holds.

The result is a canal that is 12 m wide when 12 m is more than a pixel and about
two pixels wide when it is not — the generalisation a paper chart makes, applied
where the information about pixels actually exists.

Four details that are load-bearing, two of them learned the hard way:

* The widening happens in view space and the result is **projected once**. The
  first version gave the whole stroke the centreline's depth and w, which meant
  dividing by the widened corner's own w and rebuilding a clip position around a
  different one — and that breaks the homogeneous coordinate the near-plane clip
  depends on. A vertex behind the eye kept a positive w and landed somewhere
  arbitrary on screen instead of being clipped, so the stroke flashed across the
  whole frame, sky included, every time a river passed under the aircraft.
* **No resolution snapping**, the same as the water material, which is built
  `highp` for the same reason. Snapping both banks of a two-pixel ribbon to the
  pixel grid independently collapses it on some frames and opens it on others:
  the river flickers on its own.
* It floats a twentieth of a cell above the surface. Coplanar is not enough:
  the stroke and the facet under it are projected by different vertex programs,
  so their depths differ by noise and the pair speckles.
* `RIVER_MAX_STRETCH` caps how far the pixel floor may stretch a stroke. Seen
  almost edge-on the perpendicular projects to nearly nothing, and holding the
  floor there would fan a distant reach out into a sheet lying across the
  landscape. Capped, it thins out instead.

`npx tsx tools/verify_rivers.ts z/x/y` reads the two files back and checks that
every centreline reached the mesh, that the stroke covers its length, and that
no part of it is buried under the terrain.

A flat body's height is the **5th percentile of the DEM one step outside its own
perimeter**, measured once over the whole body and stamped onto every clipped
piece — so a lake spanning four tiles, or the same lake rebuilt at four zoom
levels, cannot step or crack along a seam.

Both halves of that rule were forced by real data:

* Not the interior. Where a reservoir has dropped below its mapped extent the
  DEM under the polygon is dry canyon — on Lake Powell it spans 442 m with no
  plateau in it to find.
* Not the average. What reads as broken from the air is water standing *above*
  the ground beside it; land above water is simply a shore. Measured on the
  perimeter of that same body:

| height from | median step at the shore | shoreline leaking |
| --- | --- | --- |
| interior median | 12.6 m | 34.3% |
| perimeter median | 0.0 m | 50.0% |
| perimeter p25 | 30.1 m | 25.0% |
| **perimeter p5** | 39.9 m | **5.1%** |

The perimeter median looks best on paper and is the worst on screen. A low
percentile rather than the minimum, because the minimum is one bad DEM sample
from sinking the lake — 895 m against p5's 927 m on Powell.

For the few percent that still leak, the mesh bake clamps shoreline vertices
down to the ground they meet. The rim loses its flatness; the interior keeps it.

A body the DEM cannot answer for gets no height and is baked as flowing water.
That is never flat, which is the right way round for a fallback.

Two more rules live in the cover bake rather than in the mesh bake, because
they need something the raster does not carry:

* Bare ground within 160 m of the coast becomes **sand**. WorldCover has no
  sand class — dune, ash flat and lava field are all class 60 — so the
  distinction has to come from geometry.
* Landcover saying *open water* on a facet the OSM coast cut as **land** is a
  disagreement about where the shore is, and the coast vector wins. The
  alternative is a lake painted across a hillside.

Where imagery is missing — no scene, or no imagery fetched at all — a node
takes its class's own WorldCover map colour, so the imagery-driven modes
degrade to flat-but-plausible rather than to grey.

### Options

`bake_planet_dem.py`: `--max-zoom N` caps detail, `--clean` wipes the output
first. Do not bake past zoom 12: the source is 1 arc-second (~30 m) and z12
already oversamples it 1.6x.

`bake_planet_mesh.ts` (`npm run bake:mesh -- ...`):

| Flag | Meaning |
| --- | --- |
| `--src DIR` | input pyramid (default `assets/planet`) |
| `--out DIR` | output tree (default `assets/terrain`) |
| `--budget N` | triangles per tile (default 6144) |
| `--max-zoom N` | cap detail |
| `--only z/x/y` | bake one tile, repeatable, for debugging |
| `--limit N` | stop after N tiles, for a smoke bake |
| `--swatches N` | colours in the baked swatch table (default 24) |
| `--bbox W,S,E,N` | bake only the tiles overlapping this box |

`bake_planet_tex.ts` (`npm run bake:tex -- ...`):

| Flag | Meaning |
| --- | --- |
| `--dir DIR` | the mesh tree, read and written (default `assets/terrain`) |
| `--cache DIR` | leaf rasters, keyed by each `.ptm`'s size and mtime (default `assets/planet/tex_cache`) |
| `--size N` | texels across a far tile, a power of two (default 256) |
| `--near-size N` | texels across a near tile, at `--near-zoom` and finer (default 512) |
| `--near-zoom N` | first level counted as near; z10 and z11 by default sit right behind the leaf cut |
| `--min-zoom N` | coarsest level that gets a texture (default 4); below it the tangent-plane mapping drifts past a texel |
| `--bbox W,S,E,N` | re-rasterise only the leaves in this box, refold their ancestors, merge `index_tex.bin` |

**`--bbox` is what makes a run additive.** Two whole-pyramid artefacts —
`index_mesh.bin` and `swatch_histogram.bin` — are carried forward from disk only
when it is present. Without it they are rebuilt from the tiles this run baked
and nothing else, so a `--only` or `--limit` probe unlists every other area from
the index (the runtime reads "not in the index" as "ocean, draw a patch") and
resets the colour statistics the whole pyramid is quantised against. Both fail
silently. Pass `--bbox` around the tiles you are probing, or expect to re-bake
everything afterwards to put them back.

### The triangle budget

`--budget` is the main quality knob, and what it really controls is
**shoreline resolution**. Raising the interior height tolerance coarsens flat
ground but does nothing for the coast, because shoreline blocks are pinned to
the finest leaf size regardless of height error. So the bake buys the finest
coast that fits in 80% of the budget and spends the rest on interior detail.

Measured on real Canary z12 tiles, the coast alone costs:

| Leaf size | Coast resolution | Triangles |
| --- | --- | --- |
| 1 cell | ~17 m | ~18,000 |
| 2 cells | ~34 m | ~9,000 |
| 4 cells | ~69 m | ~4,000 |
| 8 cells | ~138 m | ~1,600 |

The default 6144 lands on a ~34 m coast at roughly 5,300 triangles and 47 KB
gzip per tile. For comparison the old runtime CDT produced a median of 3,311
triangles per tile but had no ceiling at all — its worst z12 tile was 86,463.

### Detail falls with zoom

A tile is drawn from a distance that scales with its size, so what a coarse
tile carries has to be cheaper than what a fine one does or the far field
costs more than the near field (it did: a z9 tile ran 100k triangles, most
of it landuse fill and 2 m outlines no distance could show). The bake keys
these on `z` (`tools/bake/buildTile.ts`, `meshTile.ts`):

| What | z12 (leaf) | z11 | z10 and coarser |
| --- | --- | --- | --- |
| Landuse polygons | exact fill + outline stroke, every vertex | class voted onto the facet, no extra triangles | voted onto the facet |
| Watercourse strokes | all | width ≥ 0.05 cell | width ≥ 0.05 cell |
| Stroke stream | up to `PTM_MAX_RIVER_VERTS` | ≤ budget vertices | ≤ budget vertices |
| Coast overspend | 3× budget | 3× | 1.5× |
| Coast simplify floor | 0 | 0.5 cell | 1 cell |

Fills were tried at z11 too: over Berlin that cost a mean 35k triangles per
z11 tile, six times the mesh budget, for edges under a pixel at the nearest
a z11 tile is ever drawn from. (`LANDUSE_SIMPLIFY_CELLS` still simplifies
rings on any non-leaf tile that fills, should `LANDUSE_DETAIL_MIN_ZOOM` ever
be lowered again.)

The interior tolerance is half the tile's *own* DEM geometric error (from
its `.pdm` header), floored at 1 m, and that error plus what the decimator
gave up is written to the `.ptm` header as `geometricErrorM`. The runtime
refines on the tile's own figure once it is resident; the manifest's
`levelGeometricErrorM` (the per-level max over every tile in the index) only
serves until then. It used to be copied from the height pyramid's manifest,
which is a monotone max across every merge ever run — one long-gone mountain
pinned z4–z10 at 1.6 km and had flat sea refining to z11 out to 130 km.

### Serving

`assets/terrain` is **self-contained**: the mesh bake copies the height tiles
the runtime reads (z0..queryZoom) in alongside the `.ptm` meshes, so the whole
tree is one directory that any static file server can serve.

In development `tools/modserver.ts` mounts it straight from the repo, so tiles
need no rebuild and a dev build does not spend time copying ~82 MB it did not
change. `npm run build:prod` *does* copy it into `dist/`, because a deployed
`dist/` has to stand on its own.

`.ptm` files are stored gzip-compressed and served with `Content-Encoding:
gzip`, so the browser inflates them in native code off the main thread.

If the app reports `Failed to load terrain manifest ... 404`, either the tree
has not been baked yet (`npm run bake:mesh`) or a long-running `npm run serve`
predates the last change to the mounts — restart it.

## Notes / limitations

- Colours are **flat-shaded** to match the sim's look; there are no gradients,
  speculars or actual bitmap textures. The paint *regions* are only as detailed
  as the mod's decal geometry.
- Materials whose `_MainTex` is a large (non-swatch) texture fall back to the
  material's flat `_Color`; true textured detail is not reproduced.
- Output has geometry only in LOD scene 0; scenes 1..5 are empty. Static ramp
  models use a high LOD bias so they render at LOD 0.
- `trimesh` prints a `scipy` traceback while computing normals; it falls back to
  a numpy path and the output is fine.

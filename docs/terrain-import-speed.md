# Terrain import: where the time still goes, and the plan to cut it

Written 2026-09-12, after the three coast-bake hot spots were fixed (the
quadratic region overlay, the per-piece coastline voting, and the pool
spawned once per zoom level). Numbers are from the Madeira box
(-17.53,32.30 .. -16.17,33.35; 137 tiles, 75 at z12), every download
already cached, on a 20-core Windows machine.

## Where an import stands now

| Stage | Time | Bound by |
|---|---|---|
| fetch heights | 14 s | network (sequential 1° squares, whole-square reads) |
| merge into pyramid | 6 s | CPU, mostly single-threaded encode |
| bake coastline | 240-330 s | CPU: region overlay at z9-z11, pool start-up |
| bake airfields | ~30-60 s (est.) | network + O(A·E) owner lookup |
| fetch cover sources | 39 s | network (whole-scene reads) |
| bake cover | 23 s | CPU, already multiprocess |
| bake meshes | 32 s | CPU under tsx; whole-pyramid fixed costs |
| **total, cached** | **~7 min** | |

The coast bake is still two thirds of it. Inside it:

| Phase | Time | Note |
|---|---|---|
| assemble land/water | 13-16 s | `unary_union` + `polygonize`, single-threaded GEOS |
| rasterize 75 z12 tiles | 35-42 s | almost all pool start-up: 19 spawns, each pickling the landuse set |
| write z12 (75 tiles) | 5-14 s | |
| write z11 (26 tiles) | 31-148 s | region overlay; 4× the candidates per tile |
| write z10 (14 tiles) | 61-88 s | region overlay; 16× |
| write z9 (8 tiles) | 28-65 s | region overlay; 64× |
| write z8..z0 | ~5 s | |

On a cold cache add the Overpass fetches: eight queries, strictly
sequential, up to nine attempts each with 10 s and 30 s sleeps between
rounds.

## The plan

Ordered by expected saving per hour of work. Each step is independent
and can land on its own.

### 1. Derive z9-z11 regions from z12 instead of recomputing them

**Saves 2-4 min of the coast bake.** `_clip_worker_inline` calls
`encode_regions_for_tile` at every zoom from 9 to 12, and each coarser
level queries the landuse STRtree with a box four times larger, so the
overlay does the same resolution four times over with a growing
candidate count. The z12 partition already exists and is exact.

Build a z11 tile's regions by taking its four z12 children's regions,
unioning pieces that share a class across the child boundary, and
simplifying with that level's `vector_simplify_tol`. This is the same
"decimate the children" shape the `.lwm` masks and the cover `.plc`
pyramid already use, and it keeps the region edges consistent with the
coast polygon layer, which is also simplified per level from the same
source. Keep the z12 regions in memory between levels the way
`level_grids` already carries the masks down.

Risk: a union across a child edge can produce a sliver where the two
children's simplified edges disagree. Run the union at
`OVERLAY_GRID_SIZE` and drop pieces under one grid cell.

### 2. Stop rebuilding ancestors below z8 on every import

**Saves 5-10 s per import and removes a scaling cliff.** The level loop
in `bake()` walks to z0 unconditionally. z0-z7 hold one to four tiles
each, but each one re-clips the full land multipolygon against a
near-hemisphere box, re-clips every inland body and watercourse, and
reloads siblings off disk.

Stop the walk at z8 (one tile per ~1.4° at z8) and rebuild z0-z7 out of
band with a `--top-levels` pass that decimates from z8 for the whole
pyramid. The mesh bake already needs nothing below z8 from this stage
that changes per area.

### 3. Start the worker pool early and hand workers the landuse set once

**Saves ~30 s of the coast bake.** The pool now starts once, but it
starts at the rasterize phase and every worker pickles the entire
landuse polygon list and STRtree from `initargs`. Two changes:

- Create the pool right after the Overpass fetches return, so the 19
  process start-ups overlap the single-threaded polygon assembly
  (13-16 s) instead of following it.
- Write `land`, `inland`, `courses` and the landuse polygons to one
  pickle in the run's temp dir and pass the path; each worker loads it
  once. Same bytes, but off the pipe and without the parent serialising
  19 times.

### 4. Parallelise and spatially cache the Overpass fetches

**Saves minutes on a cold cache; makes overlapping imports free.**

- Run the four coast queries (coastline, water, two landuse groups)
  concurrently, two at a time across different mirrors, and the four
  airfield queries the same way. `_MIRROR_FAILURES` needs a lock.
- Key the disk cache on a fixed grid, not the exact bbox text: fetch
  per whole z8 cell plus tag-set hash, union the cells. A widened or
  neighbouring box then re-fetches only the new cells, and the two
  bakes stop diverging on the snapped versus raw bbox.
- Write the cache at `compresslevel=1` and store the digested form
  (nodes, ways, relations this stage needs) rather than the raw
  Overpass JSON. A cache hit on a 45 MB gzip is currently 20-60 s of
  `json.load`.

### 5. Airfield bake: STRtree for the aerodrome owner lookup, and progress

**Saves most of the airfield bake's CPU; makes it visible.**
`owner()` in `bake_osm_airports.py` scans every aerodrome polygon for
every taxiway, apron and building element. An STRtree over aerodromes
makes it logarithmic. Give the script a `StageProgress` like the coast
bake so the importer's bar moves during it.

### 6. Mesh bake: bundle the worker, scope the fixed costs to the bbox

**Saves 10-20 s per import now, more as areas accumulate.**

- `bake_planet_mesh.ts` spawns `meshTileWorker.ts` with `--import tsx`
  in every worker. Pre-bundle the worker with esbuild to a `.js` and
  spawn that with empty `execArgv`. Measured elsewhere in this repo,
  tsx-loaded code runs far slower than bundled.
- `regionalGroundMeans` scans every z12 `.plc` in the pyramid, and
  the carried-index pass gunzips and decodes every tile not written
  this run (564 of 701 on Madeira). Cache the per-level maxima in the
  manifest so carried tiles need no decode, and restrict the ground
  means scan to the bbox plus one tile of halo.
- `copyHeightTiles` copies every `.pdm` z0-z11 on every import.
  Copy only tiles whose mtime is newer than the destination.

### 7. DEM fetch: windowed reads, a thread pool, and GDAL settings

**Saves ~10 s now, decisive at large boxes.** `fetch_planet_dem.py`
reads each 1° square in full with no `window=`, sequentially, with no
`rasterio.Env`. Copy `fetch_cover_sources.py`'s thread pool and set
`GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR`, `GDAL_HTTP_MULTIPLEX=YES`
and timeouts. Reproject each square into its own window of the target
grid instead of a full-grid temporary per square. Cache downloaded
squares under `data/imports/.dem-cache/` by name.

### 8. Cover fetch: crop scenes to the bbox

**Saves most of the 32 s imagery merge.** `_fetch_reprojected` reads
each Sentinel-2 scene's overview in full. A scene overlapping the box
by 5% still transfers all of it. Compute the source window from the
target bounds and read only that.

## What not to do

- Do not touch `MAX_REGIONS_PER_TILE` or `OVERLAY_GRID_SIZE`; the
  Leipzig failures that set them are documented in `osm_regions.py`.
- Do not skip the sibling reload in `build_parent_mask`; it is what
  keeps a neighbouring area's coast in the shared ancestors.
- Do not raise the DEM max span; the bake is quadratic in it.

## Verification for every step

- The `.lwm` masks the old code writes must stay byte-identical (the
  comparison script from 2026-09-12 does this per extension).
- Region partitions must keep the same region count and per-class
  areas per tile to floating-point noise.
- Time each stage with the in-app importer's own "done in" lines; the
  log already prints them.

## Status, 2026-09-13

Every step above landed except step 2, which was dropped on purpose: after
the other fixes the z8-z0 levels take about two seconds in total, and
stopping the walk would leave the coarse masks of a new area stale until
an out-of-band pass ran. Not worth a stale far-view for two seconds.

Measured on the Madeira box, warm caches, while another import was
running on the same machine:

| Stage | Before this work | Now |
|---|---|---|
| fetch heights | 14-22 s | 2-5 s (warm square cache) |
| merge into pyramid | 6 s | 6 s |
| bake coastline | 40+ min (never finished) | 30-37 s |
| bake airfields | 3.4 s | 0.9 s |
| fetch cover sources | 48 s | 37 s |
| bake cover | 23 s | 23 s |
| bake meshes | 34-44 s | 26.5 s |

Inside the coast bake: polygon assembly 317 s -> 3 s, z11 480 s -> 7 s,
z10 1480 s -> 7 s, the level walk in total 20-24 s. A cold coast fetch
is now sixteen small cell requests instead of four large ones; on a busy
evening with the mirrors rotating it took ten minutes, almost all of it
waiting on Overpass.

What changed in the output, deliberately:

- Coarse (z9-z11) landuse regions are derived from z12 and simplified at
  that level's own tolerance (15% of a cell), so they are lighter than the
  full-detail overlay the old code wrote there. Class areas agree within a
  few percent; boundary detail below a cell is gone, as it is for the
  coast layer at the same level.
- Overpass answers now cover whole z7 cells around the bbox. Land is
  clipped as before; inland bodies and watercourses outside the bbox are
  dropped before height sampling.
- The Overpass cache is `.pkl.gz`; old `.json.gz` entries are read once
  and rewritten.

Land masks stayed byte-identical through every change except a handful of
boundary pixels on three Madeira tiles, traced to one water way edited in
OSM between the two fetches and to union order.

## Second pass, 2026-09-13 afternoon

Profiling the remaining stages found three things the first pass missed.

- **Mesh bake: the airfield pad scan.** Every land node of every tile was
  tested against every pad in the manifest, recomputing each pad's reach
  on every test - 193 pads across 40 airfields once a few areas are in,
  on a Madeira tile that has two. The pads near a tile are now picked once
  per tile with their reject spans precomputed. Madeira meshing 70 s ->
  15 s, every tile byte-identical. This cost grew with every area
  imported, which is why last night's 32 s had become 70 s by the
  morning.
- **Cover bake: too many workers, and a serial ancestor pass.** A spawned
  worker costs seconds to import rasterio and shapely and the per-tile
  work is memory bound, so 19 workers were slower than one on a small
  box and slower than six on a large one. The pool is now sized by tile
  count (one per ~48 tiles, at most 8, none under 96 tiles), created
  once, and the ancestor levels run across it too. Madeira 39 s -> 12 s,
  Crimea (1511 tiles) 176 s -> 71 s.
- **Cold Overpass fetch: one stream per mirror.** Concurrent requests
  each keep to a mirror of their own, so the fetch runs as wide as there
  are mirrors without any mirror seeing two requests at once from this
  address, which is what earned 429s at concurrency two on one mirror.

Warm-cache Madeira import now: heights 5 s, merge 6 s, coast 30 s,
airfields 1 s, cover fetch 37 s, cover bake 12 s, mesh 15 s, plus a few
seconds of interpreter start-up per stage.

The mesh bake takes `--jobs N` and `--no-bundle` for diagnosis, and a
parent run with `--cpu-prof` now profiles the bundled workers too.

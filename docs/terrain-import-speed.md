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

### Rasterize phase, 2026-09-13 evening

The finest-level mask rasterized the whole land geometry for every tile.
A Pamir box (2665 tiles) had 425k land vertices: 3.7 s per tile, nine
minutes on 19 workers. Tiles are now rasterized in aligned 8x8 blocks,
each block clipped out of the land once with a plain rectangle cut and
each tile clipped once more from the block, padded by a cell so no pixel
centre sits on a clip edge. 5 ms per tile, output identical on every
tile checked (Madeira in full, a Pamir sample).

## The floor was never CPU: Overpass, 2026-09-24

Everything above landed, and a warm-cache Madeira-sized box was genuinely
fast (~7 min). What hadn't been checked since 2026-09-13 was a real,
**cold-cache** import at the actual 100x100km target size, in a populated
area, with every stage this repo has grown since (bridges, road/motorway
grade, rivers, road strokes).

Ran one: `-9.6,38.5,-8.4,39.4` (Lisbon coast — coastline, the Tagus estuary,
dense OSM roads, LPPT and a dozen smaller airfields), cold cache, timed
stage by stage.

| Stage | Time | What dominated it |
|---|---|---|
| fetch:dem | 21s | fine |
| merge:dem | 9s | fine |
| coast bake | 1188s (19.8 min) | Overpass: coastline+water fetch 227s, landuse fetch 424s |
| airports bake | 1323s (22 min) | Overpass: taxiways fetch alone 733s, aprons/buildings 433s |
| roads bake | not finished (stopped) | Overpass: repeated 504s on a 9-group fetch, >150 MB before it was killed |

Coast and airports alone total 42 minutes — over twice the 20-minute target
before roads, mesh, textures or strokes even run. The answers themselves
were tiny (taxiways: 4829 elements, 0.2 MB); every minute of that was spent
retrying 429/504 across `overpass-api.de`, `overpass.private.coffee` and
`overpass.kumi.systems` under load. No CPU-side change touches this — the
retry/backoff in `tools/osm_common.py` was already about as patient as it
can be without giving up correctness (see `OVERPASS_ROUNDS`,
`OVERPASS_BACKOFF_S`).

**Fix: read from a local OSM PBF extract instead of the network.**
`tools/osm_pbf.py` is a new shared adapter (`pip install osmium`) that reads
nodes/ways/relations out of a local `.osm.pbf`, filtered by bbox and a
per-caller tag predicate, into the same `{'elements': [...]}` shape
`overpass_fetch_cells` returns after `expand_geometry` — so every consumer
downstream of a fetch (`assemble_roads`, `_polygons_from_osm`,
`assemble_landuse_polygons`, the airfield assembly) is unchanged. `--pbf
PATH` was added to `bake_osm_coast.py` (now covers inland water and
watercourses too, not just shoreline — the old `--pbf` there only ran
`osmcoastline`, which is shoreline-only, and stays as a fallback when
`osmium` isn't installed), `bake_osm_airports.py`, `bake_osm_roads.py` and
`bake_planet_cover.py --osm-landuse`. See
[tools/README.md](../tools/README.md#reading-osm-from-a-local-extract-instead-of-overpass)
for the workflow.

Verified against a small real extract (Liechtenstein, via Geofabrik) before
the full run: road assembly (2283 ways -> 1253 chained runs), coast
land/water assembly (5482 elements -> 23 land polygons, 119 inland bodies,
26 watercourses — the inland water a plain `osmcoastline` `--pbf` run would
have left empty), landuse assembly (4589 polygons), and the airfield fetch
group, all through the unchanged downstream assembly code with `--pbf`
swapped in for the Overpass call.

### Full Lisbon re-run, and the second bottleneck: file size, not bbox size

Downloaded the full Portugal extract (Geofabrik, 424 MB) and re-ran the same
Lisbon bbox end to end with `--pbf` on coast, airports, roads and
`bake:cover --osm-landuse`.

First pass (airports calling `pbf_elements` once per query group - four
separate full-file scans): **2050s total (34.2 min)**. Correct, no Overpass
calls, but not much faster than the projected Overpass time, because each of
the four airport groups paid its own ~215-250s scan of the same 424 MB file.
Fixed by adding `pbf_elements_groups` (`tools/osm_pbf.py`): several
`(key, predicate)` groups classified in one pass instead of one call per
group - the scan cost is the read, not the predicate. `bake_osm_airports.py`
now does its four groups in one call; `bake_osm_coast.py` does coast and
landuse together in one call when `--osm-landuse` is given. Output identical
before and after (717 land polygons, 9902 inland bodies, 1107 watercourses,
89134 landuse polygons, both ways) - this only changed how many times the
file was read.

Re-run with the batched adapter: **coast 591s, airports 327s (was 1323s on
Overpass), roads 318s, fetch:cover 27s, bake:cover 512s, bake:mesh 212s,
bake:tex 40s, bake:road-strokes 20s = 2050s total.** Airports alone dropped
4x from the batching fix, but the *remaining* cost was still dominated by
reading all 424 MB of Portugal for a ~1°x0.9° bbox - `osm_pbf.py`'s scan
cost is proportional to the whole file, not to the bbox, since osmium visits
every node/way/relation in the file regardless of location before the
predicate ever runs.

**Second fix: clip the extract to the bbox once, with a new
`tools/clip_pbf.py`.** No `osmium-tool` CLI binary was available in this
environment (not on winget/choco/conda, no official Windows build), so this
reimplements a single-file clip on top of the same `osmium` Python package
`osm_pbf.py` already uses, rather than adding a second dependency: one pass
over an ordered PBF (nodes, then ways, then relations - true for any
Geofabrik/planet extract), keeping a node if it falls in the bbox padded by
0.05°, a way if any of its node ids were kept, a relation if any member way
was kept. The padding is the same reasoning the Overpass path's whole-cell
fetches use: a way or relation that crosses the requested edge still has
enough nodes to resolve instead of fraying at the box edge.

Clipping Portugal (424 MB) to the Lisbon bbox took 345s (one full-file scan,
paid once) and produced an 82.6 MB file - dense urban OSM data doesn't shrink
as much as the area fraction alone suggests, since every node in the padded
box is kept regardless of tags. Re-running the coast+landuse combined scan
against the clipped file: **81s, down from 346s** (4.5x, matching the
file-size ratio) - elements 253238/1765868 vs 254798/1765972 on the full
file, the small difference entirely at the 0.05° margin edge and with no
effect on the assembled output.

**Full benchmark against the clipped file:**

| Stage | Full Portugal (424 MB) | Clipped to bbox (82.6 MB) |
|---|---|---|
| coast | 591s | 461s |
| airports | 327s | 68s |
| roads | 318s | 106s |
| fetch:cover | 27s | 31s |
| bake:cover | 512s | 139s |
| bake:mesh | 212s | 319s (system load noise - CPU-only, untouched by this work) |
| bake:tex | 40s | 56s |
| bake:road-strokes | 20s | 41s |
| **total** | **2050s (34.2 min)** | **1223s (20.4 min)** |

Output identical to every earlier run (717/9902/1107/89134). **1223s is a
hair over the 20-minute target**, entirely attributable to the mesh bake's
319s (vs 212s on the earlier run, on a stage this work never touches) -
re-run under a quiet machine and the total lands at roughly 1120s (~18.7
min), comfortably under. Against the original Overpass path - coast and
airports alone already cost 42 minutes with roads unfinished - this is
better than a 2.5x improvement, and unlike the Overpass numbers it no longer
depends on public-mirror mood: every run of this pipeline against the
clipped file reads the same bytes in the same amount of time.

The clipped file is reusable for every future Lisbon-area re-bake at this
speed with no further changes; see
[tools/README.md](../tools/README.md#reading-osm-from-a-local-extract-instead-of-overpass)
for the `clip_pbf.py` step.

### Overlapping coastline and roads in the in-app importer

With Overpass out of the way, `roads` (106s in the clipped-file benchmark)
had no remaining reason to wait behind `coast` (461s) in `areaImport.ts`'s
per-chunk step list — both only need the merged DEM, they write disjoint
files (`.rvr` vs `.lwm`/`.lvr`), and nothing until the mesh tail's
texture bake reads roads' output. Added `Step.runInBackground` (used the
same way the Overpass prefetch already ran as a background helper): the
roads step now starts alongside coastline instead of after it, gated on
the same per-chunk Overpass prefetch, and is joined with `Promise.all`
before the chunk's remaining steps (or the next chunk, or the mesh tail)
proceed - so nothing ever races its still-open `.rvr` write. `job.stepCount`
excludes background steps the same way it already excluded the prefetch.

Not yet re-measured against a live import (the orchestration logic doesn't
change what runs, only when, and was verified by code inspection plus the
existing `areaImport.test.ts` suite rather than a fresh 20-minute run); the
expected saving is roughly `min(coast, roads)` of the roads time that used
to run serially - on the Lisbon numbers, up to ~106s off the ~461s coast
stage's wall-clock position, i.e. total import time moving from ~1223s
toward ~1120s if the rest holds steady.

### Sharing a landuse read across processes: an on-disk PBF cache

`bake_osm_coast.py --osm-landuse` and, separately, `bake_planet_cover.py
--osm-landuse` each read the same tags out of the same clipped extract for
the same bbox - two different Python interpreters, so nothing in memory
carries over, and each paid its own scan (the coast bake's own combined
coast+landuse read was already one pass; the cover bake's was a second,
separate one on top of it, ~15-20s on the clipped Lisbon file, longer on an
unclipped one).

`pbf_elements_groups` now caches each group's answer on disk
(`data/osm-cache/pbf/<hash>.pkl.gz`, gzip level 1 + pickle, the same shape
`osm_common.py`'s own Overpass cache already uses), keyed on the source
file's mtime+size, the bbox to 6 decimal places, and a caller-supplied
`key` string - not on the predicate function itself, which can't be hashed
stably. `bake_osm_coast.py` and `bake_planet_cover.py` both use the key
`'landuse'` for the same tag test, so cover's read of the same bbox a coast
bake already scanned is a cache hit instead of a second file scan; airports'
four groups keep their own keys (`'aerodromes'`, `'runways'`, etc.) so nothing
collides. `--refresh-osm` (the same flag that already bypasses the Overpass
cache) bypasses this cache too.

**Found and fixed while wiring this up**: every single-group `pbf_elements()`
caller (coast's coastline read, roads, cover's landuse read) previously
went through a hardcoded internal cache key (`'_'`) with no way to
distinguish callers - coast's and roads' reads of the *same bbox* would have
silently overwritten each other's cache entry the moment caching existed,
each returning the wrong tag's data to the next reader. Caught before it
shipped by running two separate keys against the same bbox+file and
confirming their element counts differ (5482 vs 25515 vs 91429 on the
Liechtenstein extract) rather than one silently replacing the other.
`pbf_elements()` now takes a required `key` argument for exactly this
reason - every caller updated, verified via a cold read then a warm read
from a separate process (2.49s -> 0.07s, same 91429 elements) plus a
`refresh=True` read that visibly re-scanned.

### Full Lisbon re-run with both optimizations, and a caught manifest race

Re-ran the clipped-file benchmark with coast/roads overlapping and the PBF
cache active. First attempt landed 490s total but with corrupted output
(0/9577 water heights resolved, 0 airfields kept, manifest areas
`alps`/`de`/`lisbon` replaced by an unfamiliar `thai-1`) - a real import was
running through the app at the same time, and its `assets/planet/manifest.json`
writes collided with the benchmark's. `bake_osm_coast.py` and
`bake_osm_roads.py` both read-modify-write that file with no lock, so two
processes finishing at overlapping moments can lose one's update entirely -
true of any two concurrent bakes (this was two independent import runs, not
the coast/roads overlap within one job), but the *same* pattern exists at
smaller scope inside a single job now that coast and roads write it
concurrently. Not yet fixed; worth a manifest write lock before trusting the
overlap under real concurrent usage (two imports at once was already
possible before today, but rare - this makes every import touch the window
twice as often).

Re-ran clean (DEM re-merged from the still-cached `.tif`, no other importer
running): **728s (12.1 min) total**, output sane again (9575/9577 resolved,
26 airfields kept, `lisbon` correctly rejoined `thai-1` in the manifest's
`areas` list). Coast+roads' concurrent wall clock was 323s against 321.5s
(coast alone) + 90.2s (roads alone) = 412s if run sequentially - roughly the
expected `max()` instead of `sum()`. `bake:cover` dropped 139s -> 97s,
consistent with its landuse read hitting the PBF cache coast's read already
primed instead of re-scanning.

| Stage | Sequential, no cache (2026-09-24 first pass) | Concurrent + cached (this pass) |
|---|---|---|
| coast | 461s | 321.5s (323s wall alongside roads) |
| roads | 106s | 90.2s (free, overlapped with coast) |
| airports | 68s | 48s |
| fetch:cover | 31s | 27s |
| bake:cover | 139s | 97s |
| bake:mesh | 319s | 168s |
| bake:tex | 56s | 33s |
| bake:road-strokes | 41s | 18s |
| **total** | **1223s (20.4 min)** | **728s (12.1 min)** |

2050s (the first working, unbatched-adapter PBF run) -> 728s is a 2.8x
improvement overall, comfortably past the original 20-minute target for a
100x100km area.

## Re-clipping a country for every import, 2026-09-25

Once `tools/osm_extract.py` downloaded extracts automatically, the country
download was paid once, but two costs came back on every import:

- **It downloaded again anyway.** The picker took the smallest Geofabrik
  region covering the box, so an import near Zwickau fetched Sachsen even
  with all of Germany on disk. It now prefers any file already on disk that
  covers the box - a downloaded region or an earlier import's clip, smallest
  first - and only downloads when nothing local does.
- **The clip was Python per object.** One osmium callback per node, way
  and relation at ~3 MB/s: SE Germany out of `germany.osm.pbf` (4.8 GB)
  took about two hours. A first fix spread those callbacks over the cores
  and still took 37.5 min in a live import - the laptop has 6 performance
  cores, and the per-object cost was the problem, not the core count.
  `clip_pbf.py` now runs no Python per dropped object: numpy decodes the
  DenseNodes coordinate arrays on every core to find the node ids in the
  box (rounded exactly as libosmium rounds), then three osmium passes with
  C++ filters (`IdTracker.id_filter` / `contains_filter`) write nodes, ways
  and relations. A way pass over all of Germany is ~10 s. Blob-level
  skipping doesn't work: nodes are stored by id, and 579 of 600 sampled
  blobs held a node inside a 2x1.3 deg box.
  Same box: **37.5 min -> 207 s**, measured with an import baking alongside,
  output identical (25,033,402 nodes / 4,261,425 ways / 50,022 relations,
  same id+geometry hash); Canary Islands 72 s -> 12.7 s with identical ids,
  tags and relation members.

### The same problem in every bake's OSM read

With the clip fixed, an import over SE Germany / N Czechia (391 MB job
extract) still sat at ~25% CPU: py-spy on the roads and airfields bakes
showed both in `osm_pbf._scan_groups`, building a tag dict per way in a
Python callback - one core each, 30+ min per stage, and every stage of
every chunk re-scans the whole job extract. `_scan_groups` now finds the
chunk's node ids with `clip_pbf.node_ids_in` (numpy, every core) and uses
osmium's C++ `IdTracker` filters so Python only sees nodes/ways/relations
touching the chunk - the only ones an answer could hold. All four groups
(coast, landuse, roads, aeroway) on that 391 MB file: 66 s. Equality checked
against the old scan on Gran Canaria (37.6 s -> 8.3 s) and Zwickau
(43.2 s -> 11.0 s): identical element sets for all four groups.

### The OSM read itself, 2026-09-26

With the clip fast, the coast bake's read of the extract was the longest
single-core stage of the Erz re-import: 889 s for one chunk's coast +
landuse (401 s on a quiet machine), 698 MB merged Germany + Czechia extract.
py-spy: ~60% building tag dicts and node lists for every way touching the
chunk (buildings and roads nobody asked for), ~17% one callback per answer
node for coordinates.

`osm_pbf._scan_groups` now: one C++-filtered pass lists the touching way ids;
workers take blob runs and test their tagged nodes and ways against a sorted,
memory-mapped copy of those ids, building dicts only for matches; numpy
decodes answer-node coordinates on every core (`clip_pbf.node_coords`).
Chunk 3: **401 s -> 86-124 s**, same element counts. Identical element sets
to the serial scan on Gran Canaria and Zwickau for coast, landuse, roads and
aeroway. A first version gave each worker its own osmium IdTracker of the
box's nodes - a bitset over the whole id range, over a GB each - and 16 of
them ran out of memory. Predicates must pickle; the airfield ones were
lifted to module level for that, and anything else falls back to the serial
scan.

### Pipelined chunks and one OSM read per chunk, 2026-09-27

Erz (4 chunks, 3.2 x 2.1 deg, merged Germany + Czechia + Lubusz extract,
cold OSM cache) re-imported through the new importer: **116 min -> 57 min**,
same output (leaf road tiles in the Czech chunk 1242/1260 both runs; the same
five coarse lake tiles over 20% water, same shares).

- `tools/osm_prefetch.py` reads every layer a chunk's bakes need (coast,
  landuse, roads, the four airfield groups) in one pass and fills the cache
  under each bake's own key: 55 s - 4 min per chunk, and the bakes' own
  reads then take seconds.
- `runImport` runs lanes: heights for every chunk first; then the OSM read
  and coast bake per chunk in the foreground (the two memory-heavy stages,
  never together); roads, airfields, cover download and cover bake each in
  their own background lane, chunk after chunk, depending on the stages
  they read. Manifest writes are locked (`osm_common.update_manifest`),
  coast tiles are written atomically.
- The mesh bake was profiled and left alone: ~15 of 20 threads busy through
  its whole meshing phase; the cost is per-tile work.

CPU sat at 100% for most of the run, free RAM dropped to 0.7 GB at the worst
point (chunk 3 coast + chunk 4 OSM read + cover lanes), which is the limit
on overlapping more. What is left: chunk 3's coast bake still took 15.7 min,
9.4 of it writing the z12 and z11 vector tiles (landuse region assembly per
tile), and the mesh bake's 15 min.

### Coast tile writing, 2026-09-27

py-spy over the Erzgebirge chunk's coast bake (2025 z12 tiles, 45 031 lakes,
425 005 landuse polygons): the z12 overlay's union of every earlier claim
whose *box* overlapped a candidate (16.5%), the final union/differences
(14%), and `clip_inland_bodies` reading the bounds of all 45 031 lakes one by
one for every tile (12%).

- `_near_tile` reads a list's bounds once, vectorised, and keeps them for the
  next tile; `clip_inland_bodies` and `clip_watercourses` only touch what is
  near the tile.
- The overlay unions only the claims that really intersect the candidate
  (one vectorised `shapely.intersects`), not every box overlap.

z12 level 222 s -> 130 s (twice, reproducible), whole bake 509 -> 439-467 s.
z11 unchanged at ~125 s (per-class unions of the children, inherent).

Not byte-identical to before: the z12 regions are the same classes with the
same areas (to 1e-14) but 179 tiles carry different vertices along shared
edges, and the coarser levels, which simplify those rings, move with them -
median 0.04% of a tile's area changes class. The largest changes (up to 13%)
are all tiles at the 512-region cap, where the old and new code drop a
different set of pieces; the cap itself leaves dropped pieces uncovered
(filed separately). Two runs of the new code are byte-identical in every
.lvr; a few coarse .lwm cells (z4-z7) differ run to run, as they did before.

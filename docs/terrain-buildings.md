# Buildings: OSM footprints, real roof colour, form and height: plan

Written 2026-10-08. All four phases landed the same day: 1 (OSM only),
2 (orthophoto roof colours), 3 (surface-model heights and ridges) and 4
(LoD2 as override and ground truth) - 2 to 4 for Bavaria only, baked for
the Garmisch box only. Brandenburg and Berlin followed on 2026-10-09 (see
below), baked for a Potsdam box.

## Brandenburg and Berlin (2026-10-09)

- **Roof colours:** LGB's DOP20 WMS (`isk.geobasis-bb.de/mapproxy/dop20c`,
  layer `bebb_dop20c`, Brandenburg with Berlin; white outside, like
  Bavaria's). Potsdam: 97 % of 168,132 roofs measured.
- **LoD2:** Brandenburg 1 km zips (`data.geobasis-bb.de/.../lod2_33E-N.zip`)
  and Berlin 1 km zips (`gdi.berlin.de/data/a_lod2/atom/LoD2_E_N.zip`), both
  EPSG:25833. Unlike Bavaria's, their buildings are split into
  `bldg:BuildingPart`s with no `HoeheGrund`/`HoeheDach`/`NiedrigsteTraufe`
  attributes: each part is a LoD2 building of its own (the parent's function
  handed down), its ground, ridge and lowest eave read off its surfaces'
  coordinates. Their ids are alphanumeric (`DEBBAL010009e6j7`) or
  `GUID_<stamp>_<n>`, so only `DEBY_LOD2_<n>` counts as a serial and the
  rest are hashed. Potsdam: 86 % of OSM buildings matched, 50,480 added.
- **Surface model:** Brandenburg's bDOM (20 cm, image matching, as DOM20) over
  its DGM1, 1 km zipped GeoTIFFs. A bDOM tile can only be fetched whole
  (~29 MB) and data.geobasis-bb.de serves ~0.65 MB/s in all, so each is kept
  once read, averaged to the 0.4 m fit grid as int16 cm (~7.5 MB,
  `data/imports/buildings/.dsm`). LGB's bDOM WCS is 1 m only, and so are
  Berlin's surface models: not used. On Potsdam leaf 4393/855 against LoD2:
  ridge height mean abs 0.86 m (rules alone 2.05), gable ridge direction
  within 20 deg 90 % (rules 78 %) - as on Garmisch.

## Phase 4 as built

- `tools/import_lod2.py` (`npm run bake:lod2 -- --bbox ...`): per leaf, the
  Bavarian LoD2 CityGML tiles under it (2 km, named by the even-km
  south-west corner, `download1.bayernwolke.de/a/lod2/citygml/E_N.gml`,
  ~50 MB, kept gzipped ~3.5 MB in data/imports/lod2/.cache), parsed for
  AdV roof type, ground / ridge / lowest-eave heights, footprint and the
  ridge direction (Newell normal of the largest sloped roof surface).
  Each LoD2 building goes to the OSM footprint holding its representative
  point; ONE (one building, area 0.6-1.6x), MERGED (several adding up:
  largest gives form and ridge, area-weighted heights), PARTIAL (unused).
  Store BLS1, data/imports/buildings/lod2, keyed by OSM id.
- Bake order now: LoD2 (ONE/MERGED) > surface heights and ridges > tags >
  rules. AdV 5000 (mixed) / 9999 keep the form from further down the
  ladder; 3400 mansard maps to hipped, 3900 barrel to gabled, 3600-4000
  cones, domes, towers to pyramidal, 3800 shed to skillion.
- `tools/eval_buildings.ts` (`npm run eval:buildings -- --bbox ...`): runs
  the real planBuilding per one-to-one match with the rules only, with
  the surface heights and ridges, and with the surface forms, and scores
  each against LoD2 (form confusion, ridge / eave error, gable ridge
  direction). It replaces the phase 3 scratch scripts.
- Rules retuned with it (Alpine town): flat only under 15 m2 for small /
  building=yes (was 40 / 30), hips 4 % of squarish houses, 1 % of the rest.
  Rules-only form agreement on the town leaf 79.8 -> 84.6 % ("always
  gabled" would be 87 %).

Measured, Garmisch box: 15 567 of 20 206 OSM buildings matched (12 368
one to one, 3 199 merged), 2 451 partial; 2.9 min with the town leaf's
tiles cached (4.3 min for that leaf). The bake: heights from LoD2 77 %,
surface 20 %, rules 3 %; forms from LoD2 77 %, tags 1 %, rules 22 %.
eval_buildings over 12 332 one-to-one matches:

| | rules only | + surface heights and ridges | + surface forms |
|---|---|---|---|
| form agreement | 86.4 % | 86.4 % | 61.4 % |
| ridge height, mean abs | 1.60 m | 0.75 m | 0.77 m |
| eave, mean abs | 1.44 m | 0.88 m | 0.83 m |
| gable ridge direction within 20 deg | 72 % | 88 % | 88 % |

OSM misses buildings LoD2 has: in the town leaf 2 739 of 10 406 LoD2
buildings (26 %) stand under no OSM footprint, median 26 m2 (garages,
sheds), 535 over 50 m2, 149 over 100 m2. They are added (same day):

- `import_lod2.py` writes every LoD2 building whose point is in the leaf,
  that stands under no OSM footprint of the leaf or its eight neighbours
  and overlaps them by under 20 % of its area, to the leaf's `.bvl` (BVR1,
  beside the `.bvr`): id 2^52 + the number in its gml:id, kind from its AdV
  function (31001_1xxx house / residential by area, 2463 garage, 2000
  "Wirtschaft oder Gewerbe" building=yes, 3041-3049 church, 51009_1610
  canopy; 53001 traffic structures and other 51009 structures skipped),
  and a LoD2 store record of its own, so the bake gives it LoD2's form and
  heights. measure_buildings.py and bake_planet_buildings.ts read `.bvl`
  with the `.bvr` (the colour store's signature covers both files);
  delete_area.py removes it.
- OSM airfield buildings (aeroway terminal / hangar / tower) are now kept
  in the `.bvr` as kind Airfield (14) and dropped by the plan, rather than
  left out: otherwise their LoD2 twins would read as missing and be drawn
  over the airfield model's.
- Garmisch box: 7 263 added (311 over 100 m2), 2 082 of them in the town
  leaf; 27 443 buildings baked (was 20 198), 516K triangles (was 406K),
  169K in the densest leaf; roof colours measured for 90 %. Heights from
  LoD2 83 %. Checked over the orthophoto: the additions are garden sheds,
  garages and outbuildings on real structures, none doubling an OSM
  outline. In the game the town view now meets the 300K building budget,
  so the smallest distant buildings are the first to go.
- A leaf with no OSM building at all is not visited (import_lod2 starts
  from the `.bvr`), so a hamlet OSM never mapped stays empty.

Not wired into the area import: LoD2 for all of Bavaria is ~18 000 tiles
and the better part of a terabyte to download. Run it by box. Other
German states and swissBUILDINGS3D are not wired.

## Phase 3 as built

- `tools/measure_roof_shapes.py` (`npm run bake:roof-shapes -- --bbox ...`):
  per building, Bavaria's DOM20 surface (20 cm, image matching, tiled
  GeoTIFF read over HTTP ranges, averaged to 0.4 m) over its DGM1 terrain
  (1 m lidar, whole files into the lidar stage's cache), both CC BY 4.0,
  DHHN2016. The footprint is registered onto the surface first (+-2.4 m,
  the shift covering the most standing structure, middle of the plateau),
  then the runtime's six roof templates are fitted by least squares with
  one outlier pass, both ridge orientations, both skillion sides and a
  ridge offset (+-0.5 W); lowest BIC wins. Store BHS1
  (data/imports/buildings/shape): form, flags (absent, form-sure), ridge
  azimuth, eave and ridge above ground, rmse, a height confidence,
  points. The read windows are kept (data/imports/buildings/.points, int16
  cm, ~60 MB per town leaf) so `--refit` re-runs the fit offline in two
  minutes instead of nineteen.
- Bake: confident surface heights win over tags and rules; the fitted
  ridge azimuth sets the ridge direction of any pitched roof; the fitted
  *form* is used only with `--surface-forms`.
- Rules recalibrated from the surface medians and LoD2: eaves per kind
  (house 5.2 m, residential 6.7, garage 2.4, ...), Alpine pitch 30 deg,
  hip roofs on 8 % of squarish houses and 2 % of the rest (was 35/10).

Checked against Bavaria's LoD2 (2 km CityGML tiles 656_5260 and 656_5262,
roof type, ground, ridge and lowest eave per building), 1 931 buildings
matched strictly (LoD2 centroid inside one OSM footprint, areas within
0.6-1.6x):

| | surface model | phase 1 rules / footprint |
|---|---|---|
| ridge height, mean abs error | 0.83 m (median -0.42) | 2.05 m (median +0.50) |
| gable ridge direction within 20 deg | 89 % | 74 % (long axis) |
| gables whose ridge runs across the footprint (445) | 92 % right | 0 % |
| non-gable form calls, precision | 11-27 % (by BIC gap) | - |
| flat vs pitched, accuracy | 92.4 % | 95.0 % (always pitched) |

Whole box (25 leaves): 19 902 of 20 206 buildings fitted, 283 not in the
surface model (demolished, or built since the 2024 flight), 41 min of
network reads with 4 jobs (19 min for one town leaf); store 297 KB, window
cache 112 MB. After the bake 95 % of heights come from the surface,
20.4 triangles per building (fewer hips: 411K for the box, was 465K).
Seen in the game at `?lat=47.4885&lng=11.0905&alt=780&hdg=40&pitch=-22`
(headless, terrain budget raised to 1.3M because the other session's DACH
re-mesh was dropping fresh leaves under the 600K cut): lower houses,
ridges across where the real ones run across.

The LoD2 checks are scratch scripts so far (eval_lod2.py, tune_priors.py,
eval2.py in the session scratchpad: AdV roof type mapping, strict
matching, Newell normals of the largest RoofSurface for the ridge); phase
4 should turn them into tools/eval_buildings_lod2.py.

Garmisch is 89 % gabled, 5 % flat, 3 % hipped, 2.5 % skillion by LoD2. A
first fit without ridge offset called a third of the town skillion; with
it and registration the non-gable calls were still mostly wrong, and no
prior setting beat "always gabled" (grid search over the per-form BIC
priors: best 85 % vs 89 %). The image-matched surface rounds every roof
edge, which reads as small hips at gable ends. Hence: heights and ridges
from the surface, forms from the rules. A true lidar surface (NRW DOM1,
swissSURFACE3D) may do better; `--surface-forms` is there to try it, with
LoD2 or a hand check to judge.

## Phase 2 as built

- `tools/measure_buildings.py` (`npm run bake:roof-colours -- --bbox ...`):
  per leaf with a `.bvr`, the orthophoto in 2048 px blocks at 0.5 m/px,
  only where buildings are, cached under data/imports/ortho/.cache; one
  answer per building into the colour store (BCS1, version 2,
  data/imports/buildings/store/12/x/y.bcs: sRGB, confidence, source,
  pixels, registration shift), keyed by OSM id. A leaf whose .bvr is
  unchanged is skipped; `--jobs` measures leaves in parallel.
- Source: Bavaria DOP40 WMS (`by_dop40c`, EPSG:4326, CC BY 4.0,
  "Datenquelle: Bayerische Vermessungsverwaltung - www.geodaten.bayern.de",
  verified in its GetCapabilities 2026-10-08). Outside Bavaria it answers
  white, read as no data. basemap.at, SWISSIMAGE and the other states are
  not wired yet (`SOURCES`).
- Per block: white balance from the asphalt under the leaf's OSM roads at
  half strength (full strength turned tile roofs pink); haze veil = the
  block's 0.5th-percentile value of its darkest channel less 8, off all
  channels alike; registration by FFT cross-correlation of footprint
  outlines with the gradient magnitude over +-6 m, then +-1.5 m per
  building on its own outline. Per building: footprint shrunk 1 m, less
  vegetation, median in CIELAB of the 15th-85th brightness percentile -
  both halves of a gable, as a level surface would read, because the
  game lights the roof again.
- Bake: `bake_planet_buildings.ts` reads the store (`--colour-store`,
  `--no-colours`); confidence >= 0.35 -> the roof is drawn in that colour
  (chroma x1.1) and its tone snapped to it. PBH1 version 2 carries it in
  the record's last three bytes behind `PBH_FLAG_ROOF_RGB`.
- Runtime: a `rawColor` vertex attribute (RGBA8, alpha = measured) on the
  building mesh; the vertex shader draws it in linear light under
  `uRawLight` - exactly as terrain imagery - while `uVertexRaw` is on,
  which the terrain colour setting drives: Imagery and Hybrid show the
  measured colours, Landcover and Swatch their nearest tone.

Measured, Garmisch box (25 leaves): 19 882 of 20 206 roofs measured,
96 % used; median confidence 0.92; registration shift 1.5-1.8 m median,
2.5 m at the 95th percentile; median veil 8/255; 292 blocks, 201 MB of
cache; 4.5 min with 5 jobs from the network, 2 min from the cache. Store
239 KB, .pbh 32 B per building. Checked by eye: a photo / registered
outline / measured colour panel for 250 m of town, and the game at
`?lat=47.4885&lng=11.0905&alt=780&hdg=40&pitch=-22`.

Things learnt:
- A tile roof really is about (156, 115, 93) in the mosaic; it looks
  orange in the photo only against the green around it.
- A per-channel haze veil would have been green (the darkest pixels are
  tree shade) and tinted every roof magenta.
- The veil from a 250 m probe was 34/255, from whole 1 km blocks 8/255:
  a block almost always holds something near black.
- While another session re-bakes DACH, leaves of a fresh mesh drop out of
  the draw list under the 600K terrain budget; verify with a raised
  budget (prof.mjs BUDGET=1300000) and re-run bake:buildings-pbh once that
  pipeline has graded the box.

Not wired into the area import: for all of Bavaria it would mean tens of
gigabytes of imagery. Run it by box.

## Phase 1 as built

Bake:
- `tools/bake_osm_buildings.py` (`npm run bake:buildings`): `building=*`
  ways and multipolygons from Overpass (z11 cells) or a `--pbf` extract,
  tags parsed to numbers (height, levels, roof:shape/orientation/direction/
  height/levels, roof:colour, building:colour, kind from building/amenity/
  shop), filed whole under the leaf holding the centroid -> `.bvr` (BVR1) in
  assets/planet. Footprints under 6 m2 and the airfield's own
  terminal/hangar/tower ways are dropped. `building:part` is not read.
- `tools/bake_planet_buildings.ts` (`npm run bake:buildings-pbh`): per leaf,
  the footprints into the tile's true local frame (tileSurface.ts), then
  `tools/bake/buildingPlan.ts` decides height, form, ridge and tones, and
  stands each on the drawn (graded) land: walls from 0.5 m under the lowest
  ground, eave at least 2.2 m over the highest -> `.pbh` (PBH1, gzip,
  src/script/terrain/pbh.ts) + index_buildings.bin + manifest `buildings`
  block. Records sorted most prominent first.
- Wired as the last step of `gradeSteps` (import, delete, rebake:box) and as
  a `buildings` data lane after the OSM read; `osm_prefetch.py` caches the
  `buildings` group. Mesh bake carries the manifest block; modserver and
  upload_terrain serve `.pbh` gzip; delete_area removes `.bvr`/`.pbh`.

Runtime:
- Roof geometry (`src/script/terrain/buildingRoofs.ts`): every roof is the
  lowest of 1-4 planes over the footprint (flat, skillion, gabled, hipped,
  half-hipped, pyramidal); faces are the footprint clipped to where each
  plane is lowest (convex outline whole, concave outline per earcut
  triangle), walls follow the roof along each edge so gable ends rise to
  the ridge. Courtyards force flat. Any footprint shape, not just rectangles.
- `src/script/terrain/buildingMeshes.ts`: own TileStore, extrusion on the
  main thread at 3 ms a frame, one non-indexed mesh per leaf, one draw.
  Draw range = prefix of buildings at least 2.5 px across at the tile's near
  edge; if the frame would exceed 300K building triangles the pixel floor
  rises for all tiles alike. Not counted in the terrain triangle budget.
- Colour: shaded material option `vertexTones` (VERTEX_TONES define, `tone`
  attribute, 16-entry palette table looked up in the vertex shader) with
  `BUILDING_TONES` (buildingTones.ts): 11 new palette categories
  (SCENERY_WALL_*, SCENERY_ROOF_*) in noon/midnight/nightvision. Tagged
  colours snap to the nearest tone (`nearestTone`) - phase 2's imagery
  colours will too.
- Trees and stones avoid footprints + 2 m (buildingExclusion.ts).
- Graphics tab *Buildings* toggle (`buildings` setting). F9 HUD `BLn/xK`
  (tiles extruded / thousand triangles drawn); `__terrain.buildings.stats`.

Measured, Garmisch box 11.03,47.46,11.17,47.60 (25 leaves): 20 198
buildings, 0.57 MB gz (29 B each), 23 triangles per building, 157K in the
densest leaf, bake 2.4 s. Heights: 2 % tagged height, 3 % levels, 94 %
rules; roof form tagged 5 %. Headless real GPU (Intel UHD) at
`?lat=47.484&lng=11.083&alt=900&hdg=45&pitch=-15`: 238K building triangles
drawn over 4 leaves, terrain pass GPU 10.0 -> 12.7 ms, 39.2 -> 37.2 FPS,
+5 draws. Seen on screen: gables along the long axis, hips, timber walls,
flat stadium, all standing on the ground.

Gaps left in phase 1:
- No dissolve: buildings pop in with their leaf (the terrain's lodReveal
  is not in the shaded material).
- Extrusion is synchronous per 64-building slice; a 30K-building city leaf
  takes several frames to appear. A worker would hide it.
- Memory: ~48 B per triangle on the GPU, a 160K-triangle leaf ~7.5 MB; all
  of a resident leaf is built even when only a prefix is drawn.
- No collision with buildings.
- Only Garmisch is baked. DACH needs a `--pbf` extract (Overpass at z11 is
  thousands of cells); Gran Canaria and Krim not baked.

## The problem

Villages and towns exist only as a land-use colour: the residential facet
tint near, the far texels further out. From low altitude nothing stands on
the ground except the hand-placed airfield models (`farm01`, `hangar01`,
...). OSM maps nearly every building in DACH; the open orthophotos, lidar
surface models and LoD2 city models of the same countries say what colour
its roof is, what shape and how tall.

The pipeline already has the two patterns this needs: the lidar store
(`tools/measure_lidar.py` reads a remote raster once per area and keeps
only the answers, keyed so a re-mesh keeps them) and the per-z12-leaf
sidecar next to the `.ptm` (`.ptr` roads, `.pbr` bridges, `.pfl` far land).
One gap: every lidar source in `measure_lidar.py` reads the **terrain
model** only. Heights need the **surface model** as well.

## Source ladder per attribute

Each building takes the best source available and records which one it
used and how confident it is.

| Attribute | 1. LoD2 | 2. Lidar nDSM | 3. OSM tags | 4. Heuristic |
|---|---|---|---|---|
| Footprint | LoD2 outline | - | `building=*` (Geofabrik extract, `osm_pbf.py`) | - |
| Height | eave + ridge in the model | DSM - DTM in the footprint | `height`, `building:levels` x 3 m + `roof:levels` | type x footprint area x neighbour density |
| Roof form | roof type code | template fit to nDSM | `roof:shape`, `roof:direction`/`roof:orientation` | footprint shape + region |
| Roof colour | - | - | `roof:colour` (only when imagery is unsure) | **orthophoto sample** |

## Height

- **LoD2:** most German states publish LoD2 open now (verify each licence);
  Switzerland has swissBUILDINGS3D 3.0. Eave height, ridge height and roof
  type in one: where present, both questions are answered.
- **Lidar nDSM:** most of the twelve lidar providers also publish a surface
  model (NRW DOM1, swissSURFACE3D, BEV ALS DSM, ...). Inside the footprint
  eroded by 1 m: ground = DTM median in a 2-4 m ring outside the footprint;
  ridge = p95 of the DSM; eave from the fitted planes (next section). Stored
  like the LMS1 store, keyed by OSM way id.
- **Heuristic:** a small regression (type, footprint area, neighbour count,
  land use -> height) trained where lidar exists and applied elsewhere
  (Gran Canaria, tag gaps) beats a flat "3 m per level".
- **Rejected:** shadow length from imagery. Acquisition date and sun angle
  are not known per tile.

## Roof form

1. **LoD2 roof codes** map directly (AdV: 1000 flat, 2100 shed, 3100 gable,
   3200 hip, 3300 half-hip, 3400 mansard, 3500 pyramid, ...).
2. **Template fit to the nDSM** - the main method without LoD2. Take the
   footprint's minimum-area rectangle (long axis = likely ridge), fit flat /
   shed / gable-along / gable-across / hip / half-hip to the ~100 1 m pixels
   by least squares (closed form per template once the orientation is
   fixed), pick the lowest residual with a BIC-style penalty for extra
   parameters. Output: form, ridge axis, eave and ridge height, so pitch.
   More robust than RANSAC plane detection on 1 m rasters of small houses.
3. **Imagery tie-breaker:** a gable's two planes are lit differently. Pixels
   in the footprint splitting into two brightness clusters along a straight
   line through the centre = gable with that ridge; four = hip; uniform =
   flat or gable with the sun along the ridge (ambiguous). Material helps:
   gravel grey with HVAC dots = flat, terracotta/anthracite = pitched.
4. **Heuristic prior:** small rectangular residential -> gable along the long
   axis; > ~1000 m2 or industrial/retail/commercial -> flat; Alps shallow
   gable; north Germany steep gable or half-hip; Gran Canaria almost all
   flat.
5. **Geometry:** the straight skeleton of the footprint gives hip roofs for
   any polygon; gables turn the short edges into gable walls. This is what
   OSM2World and Streets GL do, and it handles L/T shapes without
   decomposition.

## Roof colour from orthophotos

- **Licence-clean sources:** German state DOP20/DOP40, Austria basemap.at
  orthofoto (CC BY 4.0), Switzerland SWISSIMAGE (OGD), Gran Canaria GRAFCAN.
  **Not** Google, Bing or Esri World Imagery: their terms forbid derived
  extraction. Sentinel-2 at 10 m is a district tint at best.
- **Resolution:** ~0.5 m/px is plenty (a 10 x 10 m roof is 400 px). Fetch
  per z12 leaf, cache, keep one colour per building - no raster, like the
  lidar store.
- **Registration:** orthophotos are not true orthos; a roof leans away from
  nadir by h x tan(off-nadir), up to several metres. Per 250 m block,
  cross-correlate rasterised footprint edges with image gradient magnitude
  over +-6 m; per building a +-2 m search maximising uniformity in the
  eroded footprint. TrueDOP where a state offers it.
- **Sample mask:** footprint eroded 1 m, minus vegetation (2G - R - B > t,
  overhanging trees) and shadow (L* well below the roof median). Median in
  CIELAB over the 50th-90th luminance band so a gable's shaded half does
  not darken the result. Confidence = fraction kept and spread.
- **Colour balance:** orthophoto mosaics shift white balance per flight
  strip. Normalise per tile against asphalt pixels under the OSM road mask,
  which should be neutral grey.
- **Storage:** raw sRGB per building; palette mapping at runtime as for
  ground colours, so noon / midnight / night vision all work. Walls are
  invisible from nadir: OSM `building:colour`, else a regional default
  (plaster south, brick north).

## Bake and runtime shape

- `tools/measure_buildings.py` (later phases): the slow, networked part,
  once per area: imagery + lidar per leaf into a store keyed by OSM way id.
  A re-mesh does not touch it.
- `tools/bake_osm_buildings.py` + `tools/bake_planet_buildings.ts`: cheap,
  re-runnable. Footprints and tags per leaf, then a per-z12-leaf `.pbh`
  sidecar with ~24-40 bytes per building: footprint (<= 12 corners after
  simplification, 0.25 m quantised local), height, eave/ridge, roof form,
  ridge axis, roof RGB565, wall colour, flags. z12 only, no pyramid.
  **Bytes risk:** DACH is tens of millions of buildings, > 1 GB; dropping
  sheds < 20 m2 cuts much of it.
- **Runtime:** mesh built per tile, one merged draw, flat-shaded. Base at the
  lowest terrain point under the footprint, walls carried down to it so
  nothing floats. LOD: full roof within ~2 km, box with coloured top to
  ~6 km, nothing beyond (optionally roof colours into far texels so red
  villages still read). A gable house is ~14 tris and a Munich leaf holds
  50k+ buildings: a separate nearest-first triangle budget, not shared with
  the 600K terrain cap. Dithered fade-in like the leaf dissolve.
- **Exclusions:** tree and stone scatter must avoid footprints, as they
  already avoid roads and runways.

## Phases

1. **OSM only.** Footprints, tags, heuristic height and form, type colours,
   runtime mesh and budget. Works everywhere including Gran Canaria; proves
   the look and the cost.
2. **Imagery roof colour** on one small box (the Bavarian lidar test bbox
   11.03,47.46,11.17,47.60 - Gran Canaria's roofs are nearly all flat).
3. **Lidar nDSM heights + template fit**, adding the surface models.
4. **LoD2 import** for DE/CH as override **and ground truth**: a roof-form
   confusion matrix and height RMSE for phases 1 and 3, before trusting
   them in Austria and Gran Canaria.

## Open questions

- Full roof forms, or boxes with a coloured top plus gable/hip only, for the
  retro look?
- Is > 1 GB of building sidecars for DACH acceptable, or cull small
  buildings at bake time?
- LoD2 earlier? It answers form and height outright for most of DE/CH, at
  the cost of large per-state CityGML downloads.
- Open-data licence status per German state and the exact surface-model
  URLs are unverified - first step of phases 2 and 3.

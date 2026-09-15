# Terrain tile borders: the sea-level fences, the skirts, and joining tiles

Written 2026-09-14; steps 0 and 1 landed the same day, results at the
end. Numbers below are from the
`assets/terrain` bake (z12 sample of 308 tiles, one tile re-baked with
the working tree) and from `buildShoreline` run over every `.lvr` in
`assets/planet`.

## What the picture shows

The dense vertical strips at tile borders are not skirts. They are
**shore walls from the terrain down to sea level**, one per grid node,
along a one-node-wide strip of the tile that the bake classified as open
ocean. The flat lattice at the bottom of the picture is the water sheet
that strip gets, at sea level, two and a half kilometres under the Alps.

Measured on `12/4285/991` (Ticino, lake at 2456 m), fresh bake:

| | triangles |
|---|---|
| surface | 6619 |
| landuse fill | 3016 |
| shore walls | 1638, of which ~840 are one fence 2534 m tall on the east edge |
| skirts (land + water) | 930 |
| water sheet | 1660, of which 485 vertices sit at sea level, all on the east edge |
| strokes | 3322 |
| total | 15525 |

The east neighbour `12/4286/991` has no water below 1749 m. The strip is
not shared geography; it is this tile's own misclassification.

### Mechanism

`tools/bake/shoreline.ts` classifies nodes with an even-odd scanline
over the land rings, filling `ceil(x0) .. floor(x1)` per row. The land
ring of this tile leaves the east edge at grid x = **255.922** (a vertex
1.5 m inside the tile, produced by the Python clip/difference of land
minus lake) and runs from there back to the north-east corner at
x = 256. Every row between has its right crossing just under 256, so
`floor` excludes column 256: 165 border nodes are neither land nor
inland water, fall through to the open-ocean default, and are baked at
sea level. The cut then draws a wall from every land node beside them
down to that water.

The south row is immune by accident: crossings that land exactly on the
border are clamped (`regions.ts` `LAST_ROW_EPS`, the `t === 0` cases in
`shoreline.ts`), and a ring that runs *exactly* on the edge produces no
cut. A ring inset by any epsilon on the east, west or north edge does.

### How widespread

Snapping ring vertices within 0.25 cells of a tile edge onto that edge
before classification, over every coast tile in `assets/planet`:

| zoom | coast tiles | tiles changed | nodes ocean -> land/inland | of which > 100 m above sea |
|---|---|---|---|---|
| z10 | 321 | 138 | 12096 | 8935 |
| z11 | 1080 | 245 | 24066 | 19709 |
| z12 | 3984 | 302 | 26677 | 21432 |

All but a handful of the reclassified nodes lie on the border row or
column. In the baked output, walls taller than 150 m are 0.8 % of z12
triangles but occur on 69 % of z12 tiles, and 3.7 % of z11 triangles;
the worst tiles by either measure are the same ones (`12/3720/1405`,
`12/4261/1000`), so the inset is the main cause, not the only one. OSM
coast against DEM height is a real mismatch of tens to hundreds of
metres on some coasts, and stays.

## Where a z12 tile's triangles go today

Sample of 308 z12 tiles, 40265 triangles per tile on average:

| | per tile | share |
|---|---|---|
| surface + landuse fill | ~25500 | 63 % |
| strokes (rivers, outlines) | 12679 | 31 % |
| shore walls | 566 | 1.4 % (walls > 150 m: 333, 0.8 %) |
| land skirts | 591 | 1.5 % |
| water sheet | 922 | 2.3 % |
| water skirts | 31 | 0.1 % |

The skirts, the geometry that actually seals tile borders, are 1.5 %.
Border edges number ~292 per tile, about 73 per side, one every 3.5
cells. The facet-crossing stroke resample (commit `fadf022`, same day)
cuts the strokes on `12/4285/991` from 12090 to 3322; the shipped
`assets/terrain` predates it, so the 31 % above is the old figure.

## Plan

### 0. Land the instrumentation, add the two counters that matter here

Commit `fadf022` already splits the per-zoom bake summary into surface,
fill, walls, skirts, water and strokes. Add:

- `tallWallTriangles`: wall triangles whose drop exceeds
  `max(150 m, 3 x skirtDepthM)`.
- `borderWaterNodes`: nodes on the border row/column that are neither
  land nor inland water while their inward neighbour is.

These two numbers are the before/after for step 1.

### 1. Snap ring vertices to the tile edge

In `buildShoreline`, before simplification, move every ring vertex
(land, holes, inland bodies) whose grid coordinate is within
`BORDER_SNAP_CELLS` of 0 or `cells` onto that edge. Apply the same in
`buildRegionField` (`regions.ts`) so the landuse partition and the
shoreline agree at the border. Start at 0.25 cells (5 m at z12, 20 m at
z10; the census above saw insets right up to that bound, so first print
a histogram of inset distances to check the tail before fixing the
value). A vertex that genuinely sits 2 m inside the edge moves 2 m;
nothing visible.

Unit test: the `12/4285/991` east edge reduced to a ring
`(256,0) -> (255.922,166.756) -> ... -> (256,202.644) -> (256,256)`;
column 256 rows 1-165 must classify as land after the snap and as ocean
before it (that is the regression the test guards).

Verify: re-bake `--only 12/4285/991`: sea-level water vertices 485 -> 0,
walls ~1638 -> ~800. Re-bake the Alps and Madeira boxes, compare the
step-0 counters, look at the Ticino border in the pane from the exterior
camera. The Python side (`bake_osm_coast.py`) could snap to the tile box
as well so future imports do not carry the inset, but the TypeScript
snap is what fixes the LVRs already on disk.

### 2. Classify the tall walls that remain

After step 1, dump the tiles that still carry walls over 150 m and sort
them into: coast where the DEM is genuinely high at the OSM shoreline
(a real cliff or a DEM/OSM disagreement; keep), and unclaimed nodes from
another source (a gap between rings, a hole ring not matching its
exterior). Fix the latter the same way, at the classification, never by
moving terrain.

### 3. Cheaper skirts: unlock the border in the collapse pass

`collapse.ts` locks every border vertex. Let a border vertex go when it
is not a shore vertex and the chord between its two border neighbours
passes within the tile's `maxErrorM` of it (a 1D collinearity test along
the edge, same tolerance as the interior). Neighbouring tiles already
decimate their shared edge independently and rely on the skirt, whose
depth is bounded by the coarser neighbour's error, and a collapse within
the tile's own error keeps that bound. Expect the border edge count to
fall by roughly half on quiet edges: about 300 fewer triangles on a z12
tile, under 1 %. Cheap, low risk, but small; do it after 1 and 2 because
the counters from step 0 are what show whether it paid.

The skirt *depth* (2 x parent error, floor 1 % of the edge: 49 m at z12,
97 m at z11) is not a triangle cost and does not change here. The
"down to sea level" in the picture is step 1, not the skirt.

### 4. Joining tiles into one watertight mesh: assessed, not recommended

What "no gaps, fewer triangles" would take:

- **Same-level seams.** Two neighbours could produce identical border
  vertex sets if the border were decimated from data both share (the
  DEM row and the coast ring on that edge) with a tolerance fixed per
  *level*, not per tile. Today each tile settles its own tolerance
  against the budget, so the shared edge is decimated twice, differently.
  PTM already quantises border vertices to exactly representable
  coordinates, so identical inputs would give an exactly closed seam
  and no skirt would be needed there.
- **Cross-level seams.** A z12 tile next to a z11 tile still needs a
  skirt or runtime stitching. The runtime refines per node on screen
  space error with no constraint on how many levels neighbours may
  differ, so a bake-time hierarchical border (coarse vertices a subset
  of fine ones) closes the T-junctions only if the fine tile's extra
  border vertices are dropped onto the coarse chord at runtime.
- **Runtime cost.** To draw skirts only where a neighbour is at a
  different level, the land section needs per-side skirt draw ranges
  (a PTM v7, five index ranges instead of one draw) and a per-frame
  neighbour-level check per drawn tile, with the skirts toggling as
  tiles stream in and out.

The whole prize is the skirt share: 1.5 % of triangles on an average
z12 tile, 6 % on the steepest coast-only tiles. Step 3 takes a third of
that for a page of code and no format change. Revisit if the border
share ever grows past the strokes and fill, which are the budget's real
weight.

## Verification

- `npm test` (pre-existing failures: recount, do not cite a number).
- `node --import tsx tools/bake_planet_mesh.ts --only 12/4285/991 --out <scratch>`
  before and after step 1; the per-zoom summary line carries the
  counters.
- The `.ptm` inspection used for the numbers above: project each vertex
  onto the tile's local up (the frame's y axis is 30 degrees off
  vertical in the Alps; see the skirt comment in `buildTile.ts`), pair
  vertices with the same plan position, and read the drop: equal to
  `skirtDepthM` is a skirt, anything else a wall. Worth keeping as
  `tools/inspect_ptm_borders.ts` if step 2 needs it again.
- Pane: exterior camera over Ticino (`12/4285/991`) and Madeira, wireframe
  on, no vertical strips at tile borders, water at lake height.

## Results, same day

Steps 0 and 1 landed: the two counters are in the per-zoom summary line,
`buildShoreline` and `buildRegionField` snap ring vertices within
`BORDER_SNAP_CELLS` (0.25) of a tile edge onto it, and the regression
test in `shoreline.test.ts` holds the inset ring.

The inset histogram was flat: ring vertices are spread evenly in
distance from the edge, so there is no tail to tune against and a
quarter cell stays. About 60k of 20M vertices move, by 5 m or less.

Step 1 found a second, larger source while verifying. `shoreline.ts`'s
scanline had the half-open bias `regions.ts` had already fixed for
itself: a ring running exactly along the **south edge** left the whole
last row unclassified. The cut never drew water there (a crossing at the
border is clamped), but the row was still tagged *shore*, which pinned
every leaf along the south edge to one cell, hung a wall from each one
down to sea level, and switched steep tiles into coast-only tolerance.
`LAST_ROW_EPS` now applies in both fills.

`12/4285/991`, `--only` re-bake before and after:

| | before | after |
|---|---|---|
| triangles | 15525 | 9492 |
| surface | 6619 | 4021 |
| landuse fill | 3016 | 1797 |
| shore walls | 1638 | 800 |
| walls over 150 m | ~1350 | 0 |
| skirts | 930 | 190 |
| sea-level water vertices | 485 | 0 |
| border sea nodes | 257 + 165 | 0 |
| tolerance | coast-only | 125.6 m |

The skirt count fell fivefold because the south edge is no longer cut at
one-cell leaves.

### Step 2, same day: the tall walls that remained

After the Alps re-bake the counters still showed 1294 wall triangles over
150 m at z12, 6316 at z11 and 4308 at z10, with border sea nodes on 60
tiles at each coarse level. Classified by where the wall bottom sits, all
but 48 (real lake shores, drops of ~180 m) went down to **sea level**:
still phantom sea, from two more shapes the quarter-cell snap does not
reach.

- **Simplification chords the edge.** `11/2133/494`'s land ring touched
  the west edge either side of a 0.38-cell spur. Douglas-Peucker at 0.5
  cells kept the spur and dropped both border vertices, so the ring ran
  from corner to spur to corner and the whole west column fell out. The
  snap tolerance is now `max(BORDER_SNAP_CELLS, simplifyCells)`: whatever
  the simplifier treats as noise is already on the edge before it runs.
- **Unclaimed patches with no shore.** `10/1066/251` had its land ring
  63 m inside the west edge for 200 rows (the neighbour's east column is
  all land), and the z12 tiles had isolated nodes in river arms thinner
  than a cell that the body ring passed 0.1–1.5 cells away from, so the
  adoption pass had no inland node to adopt from. `buildShoreline` now
  takes the DEM: a 4-connected component of unclaimed nodes whose lowest
  finite height is more than `INLAND_SEA_MIN_M` (50 m) above the datum is
  not the sea and becomes inland water with no surface height, which the
  mesh drapes on the terrain. Nodata patches stay sea. Two `buildTile`
  tests that asserted sea level for water on an 820 m DEM were rewritten
  to give the sea a shore at the datum; the hole case now asserts draping.

Alps box, second re-bake, per zoom:

| | tall walls before | after | border sea nodes before | after |
|---|---|---|---|---|
| z10 | 4308 | 48 | 4847 on 60 tiles | 0 |
| z11 | 6316 | 62 | 2272 on 60 tiles | 0 |
| z12 | 1294 | 90 | 20 on 4 tiles | 0 |

Mean z12 tile 23789 -> 23349 triangles. What is left is the 48 lake
shores plus a few walls at real cliffs where the sea component does reach
the datum, which is what the counter should carry.

Known trade: a sliver of real sea under a cliff whose every SRTM node
reads above 50 m (a corner of a tile at a cliff foot) would now drape as
water on the cliff instead of sitting at the datum behind a wall. Not
seen in the Alps or Madeira counters; if it shows, the component size is
the discriminator to add. Not yet re-baked across an area; the Alps box
(`--bbox 5.80078125,45.3515625,8.4814453125,46.845703125`, 2170 z12
tiles) is the natural first run, and `bake:tex` after it for the far
textures of the re-meshed tiles.

### Step 3, 2026-09-15: border vertices unlocked in the collapse pass

`collapse.ts` now lets a border vertex go on the same terms as an interior
one, with two extra rules: the four tile corners stay, and a border vertex
may only collapse into a neighbour on its own border side, so the border
stays a straight line and the skirt quad simply spans a longer edge. The
existing height test over every grid node under the ring is the 1D
collinearity test along the edge for free, since the border nodes lie on
the edge of the new triangle. Tests: `collapse.test.ts` holds that a flat
plane sheds border vertices but keeps all four corners and exact tile
coverage, and that a step in the DEM along the west edge keeps the border
vertices either side of the step.

`--only` re-bake of `12/4285/991` and `12/3720/1405` (both coast-only,
steep - the worst case for this pass):

| | before | after |
|---|---|---|
| triangles per tile | 35795 | 35644 |
| skirts | 321 | 286 |
| vertices collapsed | 263 | 280 |

Under half a percent on those two, as the plan expected. Quiet edges gain
more; the per-zoom `skirts` counter from the full re-bake of the three
areas (same day) is the number to compare against the 591-per-tile figure
above.

Full re-bake of the three areas with steps 0-3, same day (skirts per tile;
the 591 above was the pre-step-1 z12 average over a 308-tile sample):

| area | zoom | tiles | triangles | skirts | walls > 150 m | border sea nodes |
|---|---|---|---|---|---|---|
| alps | z10 | 144 | 6044 | 260 | 20 | 0 |
| alps | z11 | 527 | 6247 | 268 | 34 | 0 |
| alps | z12 | 2074 | 23175 | 270 | 78 | 0 |
| brb | z10 | 12 | 3426 | 106 | 0 | 33 on 4 tiles |
| brb | z11 | 35 | 4905 | 116 | 0 | 17 on 5 tiles |
| brb | z12 | 126 | 21357 | 80 | 0 | 0 |
| mad | z10 | 14 | 3666 | 136 | 0 | 23 on 6 tiles |
| mad | z11 | 26 | 5275 | 191 | 4 | 15 on 11 tiles |
| mad | z12 | 75 | 21480 | 214 | 52 | 87 on 30 tiles |

Alps is clean. Madeira's border sea nodes are an island's real coast
meeting tile edges, which the counter cannot tell from phantom sea; its
tall walls are cliffs. Brandenburg has no sea, so its 50 coarse-level
border sea nodes on nine tiles are phantom: the walls they hang are under
150 m because the ground there is ~35 m up, so the tall-wall counter is
silent. Small, and the component-size discriminator noted under step 2 is
the fix if it is ever worth chasing.


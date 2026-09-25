# Terrain triangles: fewer where neighbouring facets are nearly coplanar

Written 2026-09-14; steps 0-3 landed the same day, results at the end.
Numbers below are from the
current `assets/planet` pyramid: 60 tiles each at z12 and z10, interior
decimation only (no coast, no cover boundaries), the tolerance doubled
until the tile fits the 6144 budget the way `buildTile` does.

## How a tile is meshed today

`tools/bake/decimate.ts` is a restricted quadtree over the 256x256 cell
grid. A block becomes one leaf when every node inside it lies within
`maxErrorM` of the bilinear surface through its four corners (plus the
region, cover and pad conditions). The tree is balanced so neighbours
differ by one level at most, and a leaf is triangulated as:

- two triangles when no neighbour is finer, or
- a fan from the leaf *centre* through corners plus one midpoint per
  finer edge: `4 + k` triangles for `k` midpoints.

`buildTile` then negotiates `maxErrorM` and `minLeafSize` against the
budget. The budget is binding on almost every tile: the search starts at
half the tile's geometric error (floored at 1 m) and coarsens until the
tile fits, landing on average at 14 m at z12 and 80 m at z10.

## Where the interior triangles go

| | z12 | z10 |
|---|---|---|
| triangles per tile (interior) | 3977 | 3847 |
| leaves per tile | 1402 | 1304 |
| leaves triangulated as a fan | 25 % | 28 % |
| triangles inside those fans | **47 %** | **51 %** |
| saved by a corner fan (`2 + k`) | **17 %** | **19 %** |
| triangles whose every edge-neighbour is within 1° | 7 % | 8 % |
| ... within 2° | 10 % | 12 % |
| ... within 4° | 19 % | 21 % |

Leaf sizes at z12 are mostly 4 and 8 cells (36k and 22k of 84k leaves);
1-cell leaves are rare (7k) because the tolerance has been raised until
they merged. So the quadtree already collapses genuinely flat ground.
What is left over is structural: fans that carry a centre vertex nobody
asked for, and the balance ripple, where one steep feature forces a
ladder of half-size leaves out across flat ground on every level.

The near-coplanar figures are the pool a merge pass can draw on. A
greedy pass will not clear the pool: removing a vertex needs *all* the
facets round it to agree, and the pool shrinks as its neighbours are
simplified. Expect roughly half of it.

## The plan

Ordered by saving per hour of work. Steps 1 and 2 are independent. Step
3 is the one the idea in the title names, and it comes after step 1
because step 1 removes the vertex it would otherwise spend most of its
collapses on.

### 0. Instrument first

Add a `--stats` flag (or a `MESH_STATS=1` env) to `bake_planet_mesh.ts`
that folds per-tile counts into the summary: triangles by origin
(two-triangle leaf, fan leaf, boundary cut, skirt, shore wall) and the
final `maxErrorM`. Every step below is judged on two numbers from this:
triangles per tile at a *fixed* tolerance, and tolerance reached at the
fixed budget. Without it a change that "saves triangles" is invisible,
because the budget search simply spends them on finer error.

### 1. Corner fan instead of centre fan

**Saves 17-19 % of interior triangles at equal tolerance.** In
`decimate.ts`, a uniform leaf with `k` midpoints is triangulated as a fan
from one *corner* through the ring: `2 + k` triangles, no centre vertex.
Pick the corner that has no midpoint on either of its edges when one
exists, otherwise any; both choices are valid triangulations of the
ring.

Why it is safe: the leaf passed the bilinear test, so every node in it,
the centre included, is within `maxErrorM` of the corner surface. The
fan from the centre was a free extra sample, not a guarantee anything
depended on. Measure the actual surface error before and after with the
step 0 stats (max |mesh - DEM| over the tile's nodes) to confirm the
bound holds; the twist term of a bilinear patch is what could exceed it,
and it is bounded by the corner heights the test already saw.

Tests: `decimate.test.ts` pins a few triangle counts (`length, 2`,
`length, 32`); the fan cases change count and need re-pinning. Keep the
T-junction test: every midpoint must still appear in the finer
neighbour's edge.

### 2. Realise the saving

Step 1 alone changes nothing on screen: the budget search lowers
`maxErrorM` until the tile is back at 6144. To actually draw fewer
triangles, either

- lower `--budget` (5120 keeps roughly today's tolerance), or
- cap the tolerance search from below at what today's bake reaches, so
  a tile that fits at today's error stops there.

The second is better for the scene: the runtime picks tiles by
`geometricErrorM` (PTM v6) and caps the scene at 600k triangles
(`TERRAIN_TRIANGLE_BUDGET` in `lod.ts`), so cheaper tiles at equal error
means more tiles refined inside the cap, not the same tiles drawn twice
as fine. Decide by looking at both with the step 0 stats and a flight
over Madeira or the Canaries.

### 3. Coplanar edge collapse as a post-pass

**Estimated 5-10 % more, on top of step 1.** After `decimate` and before
projection in `buildTile`, run a constrained edge-collapse over the
`GridTriangle` list:

1. Weld vertices by exact grid coordinate (they are exact: integers,
   halves, and the cutter's fractional crossings, all reproduced verbatim
   per triangle). Build vertex-to-triangle adjacency.
2. A vertex is a candidate when it is *interior*: not on the tile border
   (`x`/`y` of 0 or `cells`), not a shore vertex, and every triangle
   round it has the same `regionId` and the same facet cover class.
3. Collapse it into a neighbour when the normals of all its triangles
   agree within `θ` **and** the collapsed surface stays within
   `maxErrorM` of the DEM at every grid node under the fan. The angle
   alone is not enough: a large smooth hill has half-degree steps between
   facets and metres of sagitta, and dropping its crown shows in the
   silhouette. The height test is the same bilinear-or-plane check
   `decimate` uses, so the tile's error bound survives.
4. Reject a collapse that flips a triangle (signed area changes sign in
   grid space) or leaves a sliver below the marching-squares `MIN_AREA`.
5. Greedy, cheapest first (smallest max normal deviation), one pass.

`θ` starts at 2°: the table says 4° roughly doubles the pool but the
surviving facets are what the fixed-sun shading paints, and a 4° kink
merged away is a visible tone step in FACETED mode. Try both in the pane.

Border vertices stay locked in this version. Two same-level neighbours
already decimate their shared edge independently and rely on the skirt,
so unlocking them would work, but it is a separate risk and a separate
measurement.

Everything downstream takes arbitrary `GridTriangle`s: the cover walk
samples a facet's grid footprint, `landuseFill.clipToTriangle` clips to
any triangle, and skirts are found by border coordinates, so nothing
assumes a leaf shape. `costWithSkirts` runs after the pass, so the budget
search sees the reduced count.

### 4. Not doing: an angle criterion inside the quadtree

Replacing the bilinear height test with "all cell normals within θ of
the block plane" was considered and rejected. It merges gently curved
ground into single planes with unbounded height error, which is exactly
the silhouette error PTM v6 exists to bound per tile. The angle belongs
in the post-pass, guarded by the height test, not in the merge rule.

### 5. Balance relaxation, only if 1-3 are not enough

Allowing two levels of difference across a leaf edge (two midpoints per
edge, `2 + k` still holds) removes the ripple of half-size leaves that a
single steep feature forces across flat ground. It changes the
T-junction contract every consumer of the mesh relies on and is the only
step that touches the runtime seam behaviour, so it comes last and only
with a measurement from step 0 showing the ripple is still a large share.

## Verification

- `npm test` (pre-existing failures: re-count, do not cite a number).
- Step 0 stats before and after each step, same 60-tile sample, at fixed
  tolerance and at fixed budget.
- Runtime: `__fieldStats` for scene triangles at the same camera pose over
  the same area, faceted and smooth shading; screenshots in the pane for
  tone steps and silhouettes.

## Results (2026-09-14)

Steps 0-3 are in. Step 5 was not needed. What landed:

- `decimate.ts` fans a leaf from a corner (`2 + k`), and tags cut-leaf
  triangles `cut` so a wall can only hang from a chord or a grid-aligned
  edge, never a leaf diagonal. The corner fan made many diagonals between
  two shore positions, and the old position-only wall rule grew a buried
  wall from every one of them - which is how a budget test caught it.
- `collapse.ts` is the coplanar pass, run once on the mesh the budget
  search settled on. Running it inside the search made the bake four
  times slower and handed the saving straight back to the tolerance.
- `maxErrorForTile` floors the tolerance at `MIN_ERROR_CELLS` (0.25) of
  the cell size, so a quiet tile keeps the saving instead of re-spending
  it on sub-cell noise.
- `bake_planet_mesh.ts` prints, per zoom, mean triangles, mean *surface*
  triangles, median tolerance and collapsed vertices per tile.

Interior-only, same 60 real tiles, at the tolerance the corner-fan mesh
fits the budget at:

| | z12 | z10 |
|---|---|---|
| corner fan | 243201 | 228411 |
| + collapse at 2° | 226677 (-6.8 %) | 211231 (-7.5 %) |
| + collapse at 4° | 210627 (-13.4 %) | 197317 (-13.6 %) |

Madeira box, full bake, 137 tiles, before -> after:

| | before | after |
|---|---|---|
| mean triangles per tile | 27662 | 25818 |
| max | 92270 | 87365 |
| output | 31.7 MB | 29.7 MB |
| bake time | 16.2 s | 22.1 s |

The whole-tile saving is 6.7 %, well under the interior saving, because
at z12 the surface is only 5106 of a tile's 43164 triangles: the rest is
the landuse polygon fill, walls, skirts and water. **The fill is now the
triangle budget's real problem**, seven times the surface on a tile dense
with OSM polygons, and nothing here touches it. That is the next plan.

Verified in the pane over Madeira (LPMA, exterior camera): coast, walls
and facets intact, no cracks at leaf seams, 358k scene triangles at
detail scale 4 with 40 tiles drawn.

## The fill, same day

With the surface at 5106 of a z12 tile's 43164 triangles, the land-use
fill was measured next (temporary instrumentation, Madeira z12, 75 tiles):

| per tile | facets | pieces |
|---|---|---|
| fill pieces in total | | 22616 |
| facets fully covered by one polygon | 1758 | 7899 |
| facets partly covered | 1849 | 14717 |

`landuseFill` clipped each polygon *triangle* to each facet, so a facet
lying wholly inside a forest was cut into as many pieces as triangulation
diagonals crossed it. `mergePieces` now unions the fragments one region
left on one facet by cancelling shared edges, drops the collinear crossing
points along the facet edges, and re-triangulates the single loop; any
group that does not close into one loop keeps its fragments.

| Madeira, 137 tiles | original | after mesh work | after fill merge |
|---|---|---|---|
| mean triangles per tile | 27662 | 25818 | 17918 |
| z12 mean | ~44000 | 43164 | 28733 |
| output | 31.7 MB | 29.7 MB | 22.2 MB |

35 % fewer triangles than this morning. Verified in the pane: the
polygons draw on the same outlines, and the scene over LPMA went from
358k to 222k triangles for the same tiles.

Of a z12 tile's 28733, roughly 5100 are surface and 12-13k the fill;
the remaining ~11k are walls, skirts and the water sheet, which nobody
has measured yet.

## The strokes, same day

With per-stage counts in the bake summary the remainder turned out to be
the land-use outline strokes: 14125 of a z12 tile's 28733 triangles, and
the walls, skirts and water sheet only 2400 together.

| Madeira z12, per tile | |
|---|---|
| outline rings | 85 |
| ring points as mapped | 2484 |
| points after resampling every cell | 7321 |
| stroke triangles | 14125 |

A stroke is draped on the drawn surface, which is planar inside a facet,
so a straight segment needs a vertex only where it crosses from one
facet to the next. `resample` in `buildTile.ts` now samples at those
crossings, found through the facet buckets the drape already keeps, and
falls back to one sample per cell for a segment too long to search.

| Madeira, 137 tiles | original | mesh | fill | strokes |
|---|---|---|---|---|
| mean triangles per tile | 27662 | 25818 | 17918 | 15608 |
| z12 mean | ~44000 | 43164 | 28733 | 24509 |
| z12 strokes | | | 14125 | 9901 |
| output | 31.7 MB | 29.7 MB | 22.2 MB | 19.6 MB |

44 % fewer triangles than the morning's bake. Bake time is unchanged at
about 25 s; a run that read 55 s was the game running in the browser
pane at the same time, not the code.

What is left on a z12 tile: 5106 surface, 8185 fill, 9901 strokes, 853
walls, 465 skirts, 1080 water. The strokes are now bounded by the
mapped ring points themselves, and the fill by the facets a polygon
touches; the next lever on either is simplifying the rings at the leaf
level, which today keeps every OSM vertex.

## Leaf ring simplification, same day

The leaf level kept every OSM vertex. `LANDUSE_LEAF_SIMPLIFY_CELLS`
now runs Douglas-Peucker at a quarter cell (7.5 m at z12) on leaf
rings; coarser levels keep their half cell.

| Madeira z12, per tile | none | 0.1 cell | 0.25 cell |
|---|---|---|---|
| fill | 8185 | 7718 | 7288 |
| strokes | 9901 | 9120 | 8433 |
| total | 24509 | 23262 | 22145 |

Mean per tile over the box: 15608 -> 14314; output 19.6 -> 18.1 MB.
Diminishing: OSM vertices are already sparse against the cell, and
most stroke vertices are now facet crossings, which no ring tolerance
touches. Verified over LPMA: polygon outlines unchanged to the eye.

Day total: 27662 -> 14314 mean triangles per tile, -48 %.

## Shoreline measurement (2026-09-14, evening)

Question: 611 of 2153 z12 tiles are coast-only, where the water cut
alone fills the surface budget. Is it small inland bodies?

No. Per z12 tile the coast perimeter is 216 cells and the inland-body
perimeter 203, but bodies under 16 cells² contribute 21 cells and
bodies under 4 cells² 10. On the 30 busiest tiles (over 3000 boundary
cells) small bodies are 149 of ~3900. Drawing them as overlays would
buy nothing.

What a coast-only tile's 6000 surface triangles actually are (Madeira,
31 tiles): 2384 cut-cell triangles, 594 one-cell and 900 two-cell
uniform leaves beside them (the balance ripple), 1379 four-cell. So the
cut is 40 % and its ripple 25 %.

The collapse pass locked every vertex touching a cut triangle, which
kept that ripple alive. It now locks only shore vertices (tagged by any
triangle at that position). Clean A/B on the same HEAD, Madeira z12:
surface 5043 -> 4744, water sheet 1061 -> 851, walls unchanged at 579,
tile mean 14178 -> 13883. Two percent, safe, and the last cheap one.

What would move the coast-only tiles further is the cut itself, ~4
triangles per boundary cell from marching squares; that needs a
different shoreline triangulation, not a tweak.

## The water sheet (2026-09-14, evening)

Question: the water sheet was 745 of a z12 tile's triangles on Madeira,
and a sixth of a z9-z11 tile; the sea is a plane, so why so many?

A temporary breakdown by origin, Madeira z12, per tile: 554 water-side
cut triangles and 191 uniform leaves, on 322 shore vertices, 26 border
vertices and 205 interior ones. The interior ones should not exist on a
plane. Two rules in `collapse.ts` were keeping them:

- the cover-class test read the raster under a facet's bounding box, and
  every facet beside the coast reaches a land node, so it was "mixed" and
  its ring refused;
- the facet normals and the height test sample `heights` bilinearly, and a
  shore crossing sits between a wet node at sea level and a dry one at DEM
  height, so every cut facet read as tilted by that blend and failed the
  2° test.

Lifting the cover test alone changed nothing (755); the tilt was the
binding one. `collapse` now takes `isLandTriangle`, `isFlatWater` (the sea
and any lake with one measured height: judged as a level plane, no height
test), `waterClassOf` and `waterPasses`. The class is the facet's tone
judged at its centre, and a collapse must leave every facet with the class
it had, so the shallow band keeps its outline while the sheet on both sides
merges. Two wrong turns on the way:

- making the tone a hard ring class (every facet round a vertex alike)
  locked a contour as long as the coast and made it worse (938);
- letting a shore facet be shallow wherever its centre lay fanned the whole
  sheet from a few shore vertices - 14000 cells² facets - painted as
  shallows, and on a lake such a facet would sag from the clamped rim.
  A shore facet whose centre is outside the band is now class -1, a shape
  the pass may not produce. Largest shore facet after: 232 cells².

The tone rule at output changed with it: a facet is shallow if its centre
is within `max(SHALLOW_WATER_COAST_M, cell)` of the shore or it touches a
shore vertex, where before it was the nearest corner.

| water sheet per tile, Madeira | before | after |
|---|---|---|
| z9 | 745 | 459 |
| z10 | 615 | 409 |
| z11 | 878 | 497 |
| z12 | 745 | 401 |

Shore vertices are locked and unchanged, so the coastline itself is
identical. Mean z12 tile 25662 -> 25280; the rest is fill and strokes.
`BuildTileResult.searchTriangles` reports what the budget search judged,
because the sheet now collapses well under the budget after the search.

## Plan: simple-chord boundary leaves (2026-09-14, evening)

The cut is what is left. A boundary cell is pinned at `minLeafSize` and
cut by marching squares, about four triangles per cell, and the balance
rule ripples one- and two-cell leaves out from every one of them: 65 %
of a coast-only tile's surface.

A block may instead become one boundary leaf at its own size when

1. the region id changes exactly twice along its boundary ring of nodes
   (two regions, one chord; a saddle or a third region refuses),
2. every node inside lies on the same side of the straight chord between
   the two crossings as its region says (the chord *is* the drawn shore,
   so a node on the wrong side would draw the wrong ground), and
3. the land fan and the water fan, built as below, keep every node in
   the block within `maxErrorM` of the drawn heights, and within
   `padErrorM` of the padded ones - the same test the collapse uses.

The leaf is triangulated by walking its boundary ring - corners, a
midpoint on any edge whose neighbour is finer, and the two crossings, in
order along each edge - and splitting the ring at the crossings into two
convex polygons, each fanned from one crossing. Both fans contain the
chord as an edge, so the wall pass sees it exactly as it sees a cut
cell's chord today. Crossing positions are solved on the one-cell
sub-edge where the region changes, so a finer neighbour on that edge
computes the same point and there is no crack.

The balance step may split such a leaf; a child of a simple-chord
block is itself simple (a line crosses a sub-square at most twice and
its nodes were already consistent), and any child that is not falls
back to one-cell cutting.

Not changed: the budget search, `costWithSkirts`, walls, skirts, water
heights, the three-plus-region cutter, rivers. Measured against the
same HEAD on Madeira, coast-only tiles first.

### Result (landed as 284cda5)

Clean A/B in a separate worktree at HEAD, Madeira, chord leaves capped
at four cells:

| per tile | z12 before | z12 after | z11 before | z11 after |
|---|---|---|---|---|
| total | 21742 | 21853 | 6114 | 5600 |
| surface | 4744 | 4408 | 5184 | 4894 |
| walls | 578 | 378 | 674 | 433 |
| water sheet | 851 | 569 | 954 | 636 |
| fill / strokes | 7455 / 8709 | 7827 / 8971 | | |
| coast-only tiles | 31 | 8 | 14 | 5 |
| median tolerance | 24.1 m | 16.1 m | coast-only | 38.4 m |

At z12 the total is unchanged: the budget the cut no longer eats is
spent by the search on relief (tolerance 24 -> 16 m), and the extra
interior facets cost a few more fill pieces and stroke crossings. At
z11, where there is no fill, it is a straight 8 %. The cap of four
cells exists because a chord leaf's water fan is painted one tone; a
tile-sized one turned the whole sea shallow in a test.

So: not fewer triangles at the leaf level, but coast-only tiles are
now the exception and the same triangles draw finer terrain. To take
it as fewer triangles instead, lower the budget or raise
MIN_ERROR_CELLS.

## Holes beside the shore, and the seam line (2026-09-15)

Two screenshots: white triangles along a river and inside a lake, and a
straight line the length of a tile border across a hillside.

### The holes: a chord leaf that drops its midpoint

An edge-count check over the surface (`countOpenEdges` in buildTile.ts:
an interior edge must belong to two triangles, a border edge to one)
found every checked tile non-conforming *before* the collapse pass, with
the area still exact, and short of area after it. Replaying the leaves
round one such edge on `12/4261/1000`:

    LEAF 1,4 s1 cut
    LEAF 1,5 s1 cut
    LEAF 2,4 s2 chord  b = (2, 5.638) on the west edge

The chord leaf owes a midpoint at (2,5) to its finer neighbours and
`chordPolygons` puts it in the ring, but each half was fanned from the
crossing it starts at, and the fan triangle through crossing (2,5.638),
midpoint (2,5) and corner (2,4) is collinear. It was skipped as
degenerate, which is right for the triangle and wrong for the ring: the
chord side's edge then runs (2,4)-(2,5.638) in one piece while the cut
cells beside it split at (2,5). That is a T-junction, watertight in 2D,
hairline in 3D. The collapse pass then sees (2,5) with a ring of cut
cells only, judges it flat and moves it, and the sliver becomes a real
hole: `12/4240/990` lost 105 cells² of its 65536, `12/4285/991` 233.

`fanConvexRing` now picks the first ring vertex from which no fan
triangle is degenerate; one always exists, since the vertices on any one
square edge are at most a corner, a midpoint and a crossing, and the
middle one of those is safe. A second, rarer shape surfaced once the fan
refused to skip: both crossings on one edge, the boundary running along
it with a zero-area polygon between them, while the neighbour beyond the
edge cuts round the nodes. `simpleChord` refuses that block, a crossing sitting on a corner, and a
chord shaving a corner so closely that its polygon has no area (one such
ring, 5e-5 cells across, stopped the first full re-bake at 36 %); all
fall to the cutter as before.

The cutter had the same fan in miniature. Where a coast ring passes
through a grid node, one crossing snaps onto the corner and the other
edge has no geometry and defaults to its midpoint; the land ring is then
the whole cell plus that midpoint, and fanned from the first corner the
triangle through corner, snapped corner and midpoint is collinear and
was dropped, so the midpoint left this cell's outline while the
neighbour kept it. After the first full re-bake with the chord fix the
new counter still read 631 open edges on 130 z12 tiles, all this shape
(`4/17/3` at node (46,83), for one); `fan` in marchingSquares.ts now
picks its apex the same way.

A third shape survived that re-bake too (112-865 open edges per zoom,
z9 up). On a tile whose budget search settled at `minLeafSize` 2, a cut
leaf asks `edgeCrossing` over its whole two-cell edge and takes the
crossing nearest the middle, while the chord leaf across that edge
solved each one-cell sub-edge on its own and could take the other
crossing when the ring cut the edge twice (`9/529/123`, edge x 192-194 at
y 20: 192.62 against 193.9998). The cutter also snaps a crossing within
`SNAP_EPS` of a corner onto it and the chord leaf did not (`9/531/122`,
a crossing 4e-4 cells from the node). `simpleChord` now solves each
crossing over the `minLeafSize`-aligned sub-edge holding the change and
snaps it the same way, so the two sides ask the same question.

`decimate.test.ts` holds both chord shapes with an `openEdges` assertion,
`marchingSquares.test.ts` the snapped-corner cell;
each read 24 and 4 open edges on the old code. The bake summary now
prints `open edges on N tiles` per zoom beside the wall and border-sea
counters, and it should read 0.

Full re-bake with all three fixes (alps, mad and the new Berlin box,
5859 tiles): 0 open edges at every zoom. Surface triangles per z12 tile
2704 -> 2950 against the bake before the chord solve changed: a chord
whose crossing moves to the cut leaf's answer fails the side test more
often and falls to cut cells (the synthetic circle case goes 152 -> 290
triangles), which is the price of the two sides agreeing.

### The seam: skirts lit as walls

The line along the border is the skirt showing through the crack that
two independently decimated tiles always leave between their shared
edges, wider since the collapse pass may move border vertices within the
tolerance. The skirt is a vertical quad, and it was shaded from its own
face normal, so the crack came out as a strip lit differently from the
ground on either side. A land skirt now carries the normal of the surface
facet it hangs from, so whatever shows of it reads as that ground. Water
skirts have no normal.

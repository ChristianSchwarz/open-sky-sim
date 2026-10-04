# Roads: strokes near, texels far

Written 2026-09-16. OSM highways drawn over the terrain without touching a
single mesh.

## The shape of it

Roads are an **overlay**, the same mechanism the watercourses already use:
a centreline draped on the *drawn* surface, two vertices per point at one
position with opposite unit offsets across the road, widened per frame in
pixels by `RiverVertProgram` so a 5 m street holds a two-pixel floor from
altitude and is its true width underneath you. No terrain is cut; nothing
in a `.ptm` changes.

Unlike the rivers, the strokes live in a **sidecar** per tile, `.ptr`
(PTR1, `src/script/terrain/ptr.ts`), fetched on its own store and bound
into the tile's group when it lands, exactly as the `.ptx` far textures
are. Two reasons, both about performance in the wide sense:

- the widths, the class cut per zoom and the vertex cap are the things
  that get re-tuned, and a full mesh re-bake to move a road width is the
  wrong price; the road stroke bake reads the finished `.ptm` and rewrites
  only `.ptr`;
- the player can switch roads off, or to major roads only, and the
  runtime then stops fetching them at all - a pyramid with roads costs a
  player who does not want them nothing.

## Six controls on the cost

1. **Class by zoom, at the vector bake.** `bake_osm_roads.py` writes a z8
   or z9 tile with motorways and trunks only, z10 adds primary and
   secondary, z11 tertiary, and only the z12 leaf carries unclassified and
   residential streets. Service roads, tracks, paths and everything
   non-car are never fetched. Links fold into their parent class.
2. **Chaining.** OSM splits a road at every junction; the vector bake
   joins ways of one class meeting end to end at a node nothing else of
   that class touches, so a motorway is one run, not hundreds of two-point
   strokes each doubling a vertex pair.
3. **Facet-crossing sampling and a capped stream.** `drapeRoads.ts` adds a
   vertex only where a segment crosses from one facet to the next (a
   straight road on a flat facet costs two points however long), takes
   roads in class order, and stops at `--max-verts` (16384 per leaf; a
   coarse tile gets the mesh budget's worth). A full stream drops
   residential streets, never the motorway.
4. **Far tiles get roads as texels.** `bake_planet_tex.ts` paints the
   major classes one texel wide into every shipped level *after* the 2x2
   fold, with the Ground class so every colour mode shows the road grey,
   so every far tile shows the road net for zero triangles, and the moving
   map on the tactical MFD reads the same texels. Painting once into the
   leaf rasters was tried first: each fold averaged the line away (Berlin
   z10 kept 53 road texels of 262k) and the built-up class put it through
   the urban palette tone, grey on grey.
5. **Draped-line simplification.** After sampling at facet crossings,
   `simplifyDraped` drops every sample the straight chord between its
   neighbours passes within half the lift of. On flat Berlin the crossings
   were most of the stroke: leaf tiles went 4780 -> 1541 road triangles,
   and drawn road triangles over Schönefeld 133k -> 40k, which had pushed
   the terrain over its 600K budget.

6. **Curves on the leaf only, capped.** The leaf keeps road nodes to 1.5 m
   (`LEAF_SIMPLIFY_M`; coarser levels stay at half a cell), then
   `roadSpline.ts` smooths each road into a centripetal Catmull-Rom curve,
   sampled to 1 m, keeping turns of 60 degrees or more as corners. A span
   whose curve would leave its mapped segment by more than 1.5 m stays
   straight: without that cap the spline cut straight roads meeting at
   shallow angles by up to 33 m. Coarser tiles get no spline; there it
   tripled their triangles for nothing visible.

   Germany, road triangles per z12 tile: 598 with the old half-cell
   simplification, 842 at 1.5 m without the spline, 967 with it. The
   tighter simplification is most of the cost and most of the shape.

## Railways

Added 2026-10-03, riding the same files and stages as one more class
byte, `RoadClass.Rail = 7` (`RAIL_CLASS` in `bake_osm_roads.py`), past
every road class so the `cls <= cut` tests leave it out and
`keeps_class` lets it in from z9 (`RAIL_MIN_ZOOM`).

- **Which lines:** `railway=rail|light_rail|narrow_gauge`. Without a
  `service` tag it's a main line (`RoadClass.Rail`, 7, from z9). With one
  it's service track (`RoadClass.RailService`, 8): sidings, passing loops,
  spurs, yards, on the z12 leaf only and draped last, so a full city tile
  drops it first. Skipping service track entirely was the first cut, and
  it lost the second track of every passing loop (Crimea, 2026-10-03).
  `tunnel=*` and `covered=yes` are dropped at every level. Subways and trams are never
  fetched. Width is `width` if tagged, else 5 m per `tracks`; Germany maps
  a double-track line as two ways, so two strokes side by side make the
  corridor.
- **Fetch:** queries and caches of their own (`rails`, `rail_service`, beside `roads`, both
  for Overpass cells and for PBF reads, and in `osm_prefetch.py`), so a
  road cache filled before railways existed is still a hit. `--no-rail`
  bakes roads only. `--rails-only` fetches only railways and adds them to
  the leaf `.rvr` already on disk, road runs kept verbatim, then re-derives
  the coarser levels: how DACH got its rails, since most of its chunk
  extracts were gone.
- **Drape order:** `roadDrapeRank` puts rail after tertiary roads, so a
  full leaf stream drops residential streets before railways.
- **Runtime:** a third mesh per tile (`RoadMeshes.rail`) in
  `SCENERY_RAIL`, the ballast brown. Shown with ALL and MAJOR, hidden with
  OFF.
- **Far texels:** `paintRoads` paints rail at any class cut, in
  `RAIL_TEXEL_RGB`.
- **Track close up (2026-10-03):** the rail stroke draws its sleepers and
  rails in the fragment program (`RAIL_FRAGMENT` in `depthFP.ts`), no
  extra geometry. Real sizes: standard gauge, rail heads 75 mm, concrete
  sleepers 2.6 x 0.26 m every `RAIL_SLEEPER_PITCH_M` (0.64 m), one track
  per 5 m of bed. Each part is an exact box coverage of the pixel, and the
  whole track fades in over a 2.4 -> 0.8 m pixel footprint (8x the first
  cut, in two steps at the user's request). Past a pixel wider than the
  rail head, a rail is drawn at least a quarter-pixel each side wide, at no
  less than 45 % strength (`RAIL_MIN_STRENGTH`), so it still reads as a
  line where exact coverage would have faded it to nothing. The sleepers are box-filtered as a whole
  train (`sleeperCoverage`), so where a pixel spans several they settle
  into an even tint instead of shimmering. Colours are shades of the
  bed colour, so every palette keeps its own. It needs PTR version 2: an
  `along` section (metres along the stroke, 5 cm steps, wrapping at
  3276.8 m, a whole number of sleeper pitches) and `ROAD_SIDE_BIT` on the
  negative-bank vertex of each pair. Version 1 still decodes, with no
  sleepers. The sleeper phase restarts at every tile border.
- **Bridges:** a rail way with `bridge=*` is a span (`rail_bridges`), class
  byte `RAIL_CLASS`, deck = track bed + `RAIL_DECK_MARGIN_M`. The leaf rail
  stroke leaves it out and z11 adds it back, as for roads. The bridge bake
  gives the deck top `BridgeRole.RailDeck`, drawn in `SCENERY_RAIL`, and
  lays a rail stroke on it (`buildTrackStroke`, 0.2 m over the deck, one
  vertex pair per kept deck station). PBR version 2 carries it as a
  trailing PTR-layout section, and the runtime binds it with the road
  strokes' rail material, so sleepers and rails run straight across. `--rails-only` swaps the
  rail spans in each leaf `.rbr` and keeps the road spans
  (`merge_rail_bridges`). Rails now count as roads the bridge planner
  clears when a road bridge crosses them.
- **Two passes:** every rail stroke is bound twice over one geometry: the
  bed (opaque, `uRailPass` 0), then the sleepers and rails as coverage in
  alpha (`uRailPass` 1, transparent, so drawn after every bed). Where two
  tracks overlap - a turnout, a diamond, a loop a few metres off the main
  line - both sets of rails show; in one pass the later bed hid the
  earlier rails.
- **Turnouts (`tools/osm_turnouts.py`):** a track run ending at a node
  where another track passes straight through (an unsplit way, or two
  ends within 10 degrees of a line) and leaving it at 0.3-25 degrees is a
  diverging track. Its start becomes a circular arc tangent to the
  through track at the switch (300 m off a main line, 190 m on service
  track), then a straight tangent aimed at the mapped line 80 m on. The
  curve is refused (left as mapped) if it strays more than 3 m from the
  mapped line, or the way is under 15 m. One turnout per node, the
  straightest through track winning, so a Y-split is not fitted twice.
  Track keeps its nodes to 5 cm at the leaf (`RAIL_LEAF_SIMPLIFY_M`); the
  roads' 1.5 m would make the arc a chord with a kink at the switch.
- **Switch zones:** each fitted turnout also writes two leaf-only
  polylines from the switch, classes 9 (along the diverging track) and 10
  (along the through track), `sqrt(2 R 2.8)` long: where the tracks are
  2.8 m apart. They are never drawn. The stroke bake (`flagSwitchZones`)
  sets PTR v3 `flags` on the track lying on them: the diverging track
  draws no sleepers of its own, the through track draws long timbers
  (+2.9 m) toward the diverging side over a bed widened to 4.4 m, as one
  track. Points are kept at every flag change so a zone starts and ends
  within a metre. Road grade and bridge clearance skip the zone classes.
  Krim: 3280 switches found, 2106 curved, 1174 left as mapped.
- **Level crossings:** found per leaf tile (`crossing_parts`) wherever a
  road part crosses a track part. Both leave their bridges and tunnels out
  of the leaf, so any crossing left is at grade. Each writes a class-11
  polyline along the track, the road's width divided by the sine of the
  crossing angle (taken as at least 20 degrees), plus 0.5 m either side.
  The stroke bake sets `TRACK_FLAG_CROSSING` on the track there. The bed
  pass discards it, so the road shows, and the detail pass draws the rails
  with no sleepers. Krim: 348.
- **Densified near zones:** track is sampled every metre within 6 m of any
  zone's box before flagging. Otherwise a straight through track has a
  point only at mesh cells (~19 m at the leaf), and a 33 m switch zone
  held one point or none. That left diverging tracks without sleepers and
  without timbers under them (a Krim yard: 17 such points before, 4 after).
- **Three passes:** the track detail is split into a sleeper pass and a
  rail pass (`uRailPass` 1 and 2; rails at `RAIL_TOP_RENDER_ORDER`). In one
  pass a long timber of the through track drawn after the diverging track
  cut its rails into dashes.
- **Crossing furniture (`tools/bake/crossingFurniture.ts`):** the bridge
  bake reads each leaf tile's own `.rvr`. A tile with level crossings gets
  a `.pbr` even without bridges. Crossings are grouped by the road they lie
  on, chained along it (tracks under 20 m apart are one crossing). On each
  approach, on the right of the traffic, there's a St Andrew's cross (red
  and white boards on a grey post, 2 m up) and a half barrier with its arm
  raised, 2.5 m and 4 m past the outermost track bed, measured along the
  road's own polyline and offset square to it where it stands. The first
  cut offset along the straight segment at the crossing and put 358 Krim
  posts on roads that bend there. Each piece is moved out along the road,
  up to 12 m, until it is 3.2 m clear of every track and 0.5 m off every
  road; an approach with no such spot is left bare. Then it is pushed clear
  of the strokes as drawn, read back from the tile's `.ptr`
  (`pushClear`): the leaf draws roads and track as splines that can stray
  from the mapped nodes by more than a metre. It stands at the drawn road's
  height beside it (`roadHeightNear`, lift included), falling back to the
  terrain plus `strokeLiftM`. The highest terrain facet under a post sat
  1-1.5 m above the draped surface at a Krim crossing, and furniture
  floating that high looked, from above, as if it stood inside the road.
  Measure such things in the true local frame (`tileSurface.localToXZ`):
  far from the bake origin the tile's own axes lean steeply, and x/z
  distances on them are skewed by height.
  They are stored as float32 boxes in a PBR v3 section (`PBR_BOX_FLOATS`:
  centre, axes, half sizes, role, tile-local metres) and built into
  triangles at runtime (`boxGeometry`), in new `BridgeRole`s SignRed,
  SignWhite and SignPost, drawn in the metal building colours. First they
  were quantised triangles like the decks: a 2.4 cm board snapped to a step
  of several centimetres, and the arms and boards came out kinked and torn. About 250 triangles
  an approach. Krim: 254 crossings, 504 approaches.
- **Precision (RVR2):** `.rvr` points are float32 offsets from a float64
  origin per file. As absolute float32 lon/lat (RVR1, still read) they
  resolved only 0.3-0.4 m at 35 E: a siding's computed start landed
  18 cm off the main line it leaves, and turnout curves were stored on a
  coarse grid.
- **Anchored turnouts:** a turnout curve may not reshape a track past a
  node another track attaches to (`fit_arc` `max_look_m`). A second siding
  branching 50 m along the first started up to 3 m beside it once the
  first siding's curve had moved past its node, its rails ending in the
  ballast. Krim curved turnouts 2106 -> 1712.
- **Along wrap:** `along` wraps at 3276.8 m and the shader interpolates
  it, so a segment across the wrap swept back through kilometres of
  sleepers (4x dense, then a pale block). The stroke bake splits the strip
  at the wrap (`emitted`, two vertex pairs at one point).
- **Not done:** the road-grade bake treats rail as an ordinary 4 % class.
  Barriers are always open; no lights or bells.
- **Merged switch zones:** where zones overlap (a siding off a siding
  inside the first switch zone), a track lying on any diverging zone
  (within 6 cm: `DIVERGING_SAME_M`) draws no sleepers of its own, even
  where it is also the next switch's through track. The root through track
  carries the timbers for the whole complex. They reach the farthest
  diverging track within 7.5 m, in 1.5 m steps, as a 2-bit reach level in
  the flags (`TRACK_FLAG_REACH_*`), with the bed widened to match. Since
  turnout curves stop at attached nodes, overlaps are rare: none are left
  in Krim. Double slips and scissors crossings get no special
  geometry (the two passes draw their rails crossing).

Cost on the Frankfurt (Oder) chunk: 53 rail runs, about 5 % of leaf
stroke triangles, about 30 % at z9 where little else is drawn.

### Graded beds (runtime)

A stroke draped on the DEM climbs every bump: around Garmisch a third of
the track was steeper than 3 %, some of it past 100 %. `railBed.ts`
grades each track when its tile's strokes bind, and lays the bed into the
land:

- **Profile.** The track is resampled every 5 m and a dynamic programme
  over 5 cm height steps fits it no steeper than 3 %. Chain ends and level
  crossings are held to the ground, and cuttings and embankments are capped
  at 6 m: past that the grade gives way, at a steep cost, so rack railways
  and mountain lines stay steep instead of becoming canyons. Grade breaks
  are then rounded into 80 m vertical curves. Track drawn more than 2 m
  off the land is held where it was drawn, and the land is built up (or
  cut down) to it. Only past 15 m is it treated as a structure and given
  no bed.
- **Bridges.** The bake raises a rail deck to clear what it crosses,
  typically 4.4 m above where the approach was draped and 2.4 m beyond
  its end, so the approach used to run into the abutment. A track end
  within 6 m of a deck track's end is held at the deck's height. The deck
  ends come from the `.pbr` of the tile and its eight neighbours, since a
  deck often starts just across a tile border from its approach. The
  neighbours' ends are shifted by the difference between the tile origins.
  The track's last point is then put on the deck's first. The
  approach then climbs to the bridge on an embankment that stops square
  at the abutment (an open bed end), so nothing under the span is buried.
- **Keeping clear.** Some things must stay as baked: the tile's roads,
  bridges (every deck, pier and abutment triangle of the tile's and its
  neighbours' `.pbr`), lakes and the sea, and watercourses. Near one of
  them, the ground may move at most half its distance to it (1:2): not at
  all on it, a slope away from it. So a batter runs out before it reaches
  a road, a bridge or the water. On the bed itself the track still wins.
- **Retaining walls.** Where that squeezes the earthworks past 45 degrees,
  a straight concrete wall goes in: a vertical face parallel to the track,
  just clear of the steep ground (at most 3 m past the bed's edge), from
  below the ground in front up to the bed, and a flat top back to the
  bed's edge that covers the steep facets. Each run is simplified to the
  fewest straight pieces within 15 cm of its line, so a wall is a few
  quads, about 165 triangles per leaf tile around Garmisch. Walls are only
  built on leaves, and use the bridges' concrete material. A face counts
  as steep only if the beds made it so (moved 0.3 m, steepened by 0.3 per
  metre): a natural cliff a batter touches stays rock.
- **Land.** Triangles are bisected (conforming, longest edge) only where
  the bed and its 1:2 batters cannot be followed within 0.75 m. That fit
  is checked at the bed's own creases inside a triangle (track samples,
  bed edges, batter toes) as well as on a grid, since merged fields run
  to 1,400 m and a grid steps over a 5 m bed.
  - **Border triangles** may be split, but never along an edge between
    two border vertices. Border vertices never move, keep their exact
    bytes, and stay in their original soup slot and corner, so the seam
    stitcher's indices hold.
  - **Fade at borders:** the beds fade out over the last 30 m before the
    border, since land beside a fixed border could never fit them.
  - **Walls:** zero-area vertical faces are only split along an edge a
    real neighbour splits. Bisecting them on their own looped to the
    triangle cap.
  - **Stroke on top:** on the bed itself the track beats a road alongside
    (a steep edge, then a wall, rather than floating track). Beside the
    bed, kept features win. It costs about +50 % land triangles on a leaf
  with track up a valley side, much less in flat valleys.
- **Coarser tiles** (z9-z11) get the same profile with lengths scaled to
  the tile, but no new triangles, only existing vertices moved: a cutting
  is a few pixels there.
- **Worker.** Jobs run in up to two workers (`railBedWorker.ts`), finest
  tile first; the render thread only rebuilds the geometry (a few ms). The
  track binds when its bed is ready. Trees and rocks wait too, and keep
  off the bed and batters.
- **Collision.** Each leaf's beds go into `RailBedField`, as lat/lon plus
  height above the ellipsoid, so a re-base does not move them. The height
  sampler clamps the DEM into them the way it applies flatten pads, and the
  height mirror carries them to the sim worker.

`window.__railBedStats` has per-zoom totals; set `window.__railBed = false`
before tiles stream in to compare without.

## Pipeline

```
npm run bake:roads -- --bbox w,s,e,n          # OSM -> assets/planet/{z}/{x}/{y}.rvr
npm run bake:tex -- --bbox w,s,e,n            # paints major roads into the far rasters
npm run bake:road-strokes -- --bbox w,s,e,n   # .ptm + .rvr -> assets/terrain/{z}/{x}/{y}.ptr
```

The F10 import runs all three (the vector bake after the coast, the
stroke bake last). `delete_area.py` removes `.rvr` and `.ptr` with the
rest and prunes `index_roads.bin`.

The Overpass fetch uses z8 cells, a quarter of the coast bake's, because
residential streets outnumber every water feature several times over and a
z7 city cell blew the mirrors' timeout.

## Runtime

`RoadStrokes` (`src/script/terrain/roadStrokes.ts`) owns the store and
the index, and binds two meshes per tile - major (motorway to secondary)
and minor - over one shared vertex buffer, in the two road greys
(`SCENERY_ROAD_MAIN`, `SCENERY_ROAD_SECONDARY`). The class byte rides in
the padding of the cross-road offset, the same slot the `.ptm` stroke kind
uses. Render order: roads at 1 with the land-use outlines, rivers moved to
2 so a bridge over a canal still shows water.

The *Roads* setting on the Graphics tab (`RoadsSetting`, persisted as
`roads`: `ALL`, `MAJOR`, `OFF`) is a visibility flip on what is bound plus
a gate on new fetches. The F9 HUD's streaming line shows `RDn/x.xK`: tiles
with roads bound and the triangles they hold.

## Watch

- `bake_planet_mesh.ts` rewrites the terrain manifest. It carries the
  `texture` and `roads` blocks forward; a mesh bake that dropped `roads`
  (2026-09-16) turned roads off for the whole pyramid with every `.ptr`
  still on disk. Re-run `bake:road-strokes` after any re-mesh anyway: the
  strokes are draped on the old facets.

- `bake:road-strokes` prints strokes dropped per level; a leaf level with
  many dropped is the cap biting in a city, and the answer is the cap, not
  the class cut.
- The pixel-floor stretch cap (`RIVER_MAX_STRETCH`) was tuned for rivers
  seen at grazing angles; roads are straighter and longer, so a motorway
  looked along at low level is the case to check for fan-out.

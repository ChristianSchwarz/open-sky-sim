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

### Graded beds (bake)

A stroke draped on the DEM climbs every bump: around Garmisch a third of
the track was steeper than 3 %, some of it past 100 %, and the town
streets carry every building the DEM has in it. `railBed.ts` grades the
railways and roads and lays their beds into the land. It runs in the bake,
`tools/bake_planet_grade.ts`, the last stage (see Pipeline); until
2026-10-05 it ran in the browser on every tile it drew. Lines are graded in priority tiers (`BED_TIERS`), highest first:

| Tier | OSM classes | Grade | Max cut/fill | Refines the land |
|---|---|---|---|---|
| railway | rail, service track | 3 % | 6 m | yes |
| Autobahn | motorway | 5 % | 8 m | yes |
| highway | trunk, primary | 6 % | 4 m | yes |
| street | secondary, tertiary, unclassified, residential | 10 % | 1.5 m | no, moves vertices only |

Railways and Autobahns share the top rank (`bedRank`, since 2026-10-07).
Neither is graded on the ground the other's earthworks left. Where their
beds meet, they share the land as two lines of one tier do: on both
surfaces, the mean of the two (or the nearer, past 3 m apart); beside
them, the overlap of the two batters' bands, or the middle of the gap.
Each keeps its own grade, cut/fill cap and walls. Their bridges are peers
too (`bridgeRank`, under Bridges over roads). Before, the railway's
earthworks always won and the Autobahn was fitted to what they left.

Priority decides who takes the changes:

- **Who adapts.** Each line is fitted to its own ground. An embankment
  never spills onto another road or railway: a road beside one stays on its
  ground, and the face between ends at the road's edge (a wall where that is
  steeper than 45 degrees). Only on a higher line's own surface is a lower
  one held to it (below).
- **Meeting points.** Where a lower line runs onto a higher one's bed (a
  crossing, a junction), it is held to that bed's height. A point shared
  with a line graded earlier is held to its height, longer lines going
  first within a tier, so junctions meet without a step.
- **Ramps.** Near such a held point a line's cut/fill cap gives way to
  what a ramp at its own grade needs, so a street climbs to a raised
  highway rather than riding its batter.
  - A held point is "off" either its own drawn height or where the line
    next to it wants to be.
  - The second case is a road deck end, which is drawn on the deck, so it
    is never off its own drawn height. A street at Garmisch (47.4734,
    11.1157) was measured in a lidar cutting 4–10 m deep. Its deck end is
    set no deeper than the street's 1.5 m cap: sunk deeper, decks passed
    through the land. The street climbed 3.7 m in the last 5 m (74 %);
    now it ramps up at 10 %.
  - Garmisch 5×5, steep approaches: 9 → 6; over 30 %: 3 → 1. Munich 3×3
    is unchanged.
- **Level crossings** stay at their baked height, where their barriers
  and signs stand, and the road comes to them.
- **Ramps run through junctions.** A chain end is held where drawn only
  at the tile border or at a bridge it is not anchored to; at a junction it
  is free. Lines that must climb to a deck or dip under one are graded
  first in their tier, so their ramps set the junction heights, and the
  lines meeting them there are held to those and carry the ramp on. Where a
  junction an earlier line set is too far off another hold for a later
  line's grade (a street 29 m from a deck 6 m up, its other end on an
  Autobahn link at the ground), the height it would need is asked of the
  earlier line, which comes to it at its own grade in the next pass (up to
  4 passes; a junction between two junctions, the one nearer its ground
  moves). A ramp that still cannot fit is spread evenly between its holds.
- **Grade steps are capped between holds.** After the fit, every 5 m step
  is clamped to the tier's grade, or to the drawn line's own grade where
  the land there is steeper, or to the average grade between the two holds
  around it, whichever is largest. The average matters where two holds are
  further apart in height than the tier's grade allows (the ground rose
  between them): capped at the tier's grade, the last step took all the
  rest, and 3 % Munich yard tracks climbed 7 % into their holds.
- **Strokes follow their profiles.** A stroke is straight between its
  vertices, often tens of metres apart; vertex pairs are added (Douglas-
  Peucker, 10 cm) where the profile bends away from that line - a dip under
  a bridge, a vertical curve - with offset, width, distance along and track
  flags taken between the segment's ends. About +20-40 % stroke vertices.
- **Own deck or someone else's.** A road deck level with the road
  (within 2 m), running on along it further than across it, is its own
  bridge, never an underpass; rail decks never are a road's own.
- **Stray ends.** A chain's end point within 1 m of the next in plan but
  over 2 m off it in height (the bake drapes border points onto the skirt)
  is no part of the line: held, one dragged a Potsdam street 37 m down.
  Up to three are trimmed from an end, but only points lying within 2 m of
  the end point in plan (`strayCluster`): looking three points in from the
  near end of a four-point Munich street, the stray step at the far end
  took the two real points, 64 m apart, and left the strays standing 66 m
  down the skirt.
- **Under several decks.** Under a deck it gives way to, a road is held
  no higher than 5 m under the underside - a bound, so each such hold comes
  down to within 85 % of its tier's grade of the others along the line.
  Held exactly 5 m under each, the B2 at Garmisch, under a street bridge
  and then a railway bridge 3.6 m lower 15 m on, dropped 27.8 % between
  them.
- **Bridges over roads.** The bake lifts a deck over a road of its own
  rank or higher (`bridgeRank`), 5 m clear under its underside
  (`CLEARANCE_M`). Railways and Autobahns share a rank (2026-10-07): neither
  is dug down under the other's bridge, so whichever OSM has as the bridge
  goes over the other. Before, a railway bridge over an Autobahn stayed on
  the ground and the Autobahn was dug down under it. Over a lower road a
  deck stays on the ground: a railway bridge over a street, an Autobahn
  bridge over a highway. At runtime a road under any deck that is
  not its own is held 5 m below the deck's underside (its downward concrete
  faces, from the `.pbr`), the whole stroke segment the deck falls in so the
  straight stroke clears it too, and ramps down at its own grade on a
  cutting. Streets that refine the land like this get walls. Of 273,922
  spans in DACH, 33,810 are lifted and 43,558 stay down over a lower road.
- **Bridges side by side are one** (`tools/bake/bridgeJoin.ts`,
  2026-10-07). Two spans running parallel (within 15 degrees), their decks'
  edges at most 10 m apart and their tops within 4 m, for 10 m or more:
  - the parapets facing each other are left out along that stretch
    (`BridgePlan.openSides`);
  - the gap between the decks is closed by a slab from one deck's edge to
    the other's, at each one's height and thickness;
  - where the stretch ends at a deck's end, a block under the slab goes
    down to the ground.

  Over a step of more than 1 m the higher deck keeps its parapet. Over a
  step of more than 0.5 m, or beside a railway, the slab's top is concrete,
  not a road surface.

  The B2 at Garmisch: a railway deck between a street's and a link road's
  (the street's 2-3 m higher) became one structure. 5 joined stretches in
  the Garmisch 5x5, none at Kitzbühel. The bridge bake's `joined` line
  counts them, and how many cross a tile border.
  - **Across tile borders.** A span is filed in the leaf its middle is in,
    so two side by side can belong to two tiles. The bake plans every tile
    first and keeps each plan in latitude, longitude and height; each tile
    then reads its neighbours' plans in its own frame.
    - It leaves out the parapets of its own spans that face a neighbour's.
    - It builds the slab only when its span is the longer of the two (of
      two as long, the one with the lower id, `tile#index`), so the slab is
      built once.
  - **Twin viaducts.** The A7 over the Sinn (50.316, 9.843): two 750 m
    carriageways, 6-8 m apart. At a 6 m limit only their ends were
    joined; at 10 m the whole length is, across the 4319/4320 border.
  - **Spans off their own tile** (`extendSurface`). A span reading past its
    tile's mesh now reads the neighbours' land and water, converted through
    latitude, longitude and height. Before, a viaduct running on across the
    border with more than half its stations off its tile was dropped as off
    the mesh: the A7's western carriageway was never built.
- **Neighbouring bridges together.** The bake first plans every span on
  its own and notes its raised deck ends. Then, for a bridge left on the
  ground over a road it gives way to, it looks along that road (and along a
  road of its tier joining it at an end) for a raised deck end of the road's
  own within 400 m: if dipping under this bridge (5 m under its underside)
  and climbing onto that deck take more than 80 % of the road's grade over
  the distance between, this bridge is lifted over the road after all, and
  the higher line ramps to it instead. "Under" is the deck's footprint, as
  the runtime sees it, not only a centreline crossing.
- **No lift next to a junction** (`staysDownAtJunction` in the bridge bake,
  over `endJunctions`, bridges.ts).
  If a deck end stands 1.5 m or more over its ground, the bake checks
  whether the road can come down before its next junction. The road
  carrying the span on needs lift ÷ grade metres to get down. The end
  counts as at a junction if any of these holds:
  - another road leaves the end sideways, 30° or more off the span's line;
  - the carrying road meets another road (a vertex within 1.5 m) within
    that reach.

  Every road in the vectors is at ground level, so the junction pins the
  road there. In that case the span is planned again with `stayDown`: it
  stays on the ground, and the roads it crosses dip under it.
  - Before this, a Munich street's deck over a trunk road (48.130, 11.529)
    had its road fall 4-5 m in 5-10 m.
  - Rails and Autobahns are never made to dip for this (`STAY_DOWN_TIER`,
    highway and lower only). Dipping an Autobahn buried 850 m of it in
    Munich.
  - The bridge bake's `stayed down` line counts these spans.

  Munich 3×3, steep approaches (deck end vs the road beyond it, steeper
  than twice the tier's grade):

  | | Steep approaches | Over 30 % |
  |---|---|---|
  | Before | 7 | 4 |
  | After | 4 | 2 |

  Garmisch had 17 spans stayed down and no change in its steep ends.
  - Also tried: lowering a street's deck end to the height of the junction
    (land plus the lidar lift of the road meeting it). It took the three
    Garmisch street slabs at 47.484, 11.120 only from 22-36 % to 22-31 %.
    Their ends sit on a bank in the 30 m land the lidar doesn't have, and
    can't sink below it. On rail, Autobahn and highway decks it lowered an
    end of the B2 at its interchange by 5.8 m, to slip roads on
    embankments. Dropped.
- **Abutments clear of the roads beside them** (`clearAbutments`, bridge
  bake). The bake checks each span end's abutment footprint (3 m along, the
  deck's width across) against every other road, needing 1 m clear of a
  carriageway. If it isn't clear, the end runs on along its last segment in
  0.5 m steps until it is: up to 9 m for a railway, 5 m for a road.
  - **Not obstacles:**
    - the line carried on past the end, and roads meeting at the end node;
    - a road of the span's own class running along it through the deck's
      end (a street drawn 1.8 m off its slab's node had both ends of the
      slab run on 3.5 m);
    - ends shared with another span of the bridge, which stay put.
  - **The line's stroke** still ends at the old end, now on the deck.
    - A track snaps to the new deck end back along its own line, up to
      10 m off and 1.5 m to the side (railBed `DECK_SNAP_ALONG_M`), instead
      of the nearest deck end within 6 m.
    - A road rides its own deck there.
  - **The B2 at Garmisch.** The railway crosses it at 20°, and OSM ends
    the bridge 2 m short of the carriageway. Its end ran on 7 m. 10 ends
    in the Garmisch 5×5; the road checks are unchanged.
- **Which bridge is a road's own.** The bake tags every bridge with the tier
  of the line it carries (`pbr.ts` role byte, high bits; `pbrRole`,
  `pbrTier`). A road anchors to, and is never dug under, only a deck of its
  own tier (decks without a tag count as any), running on along it further
  than across it, and - where a chain of its tier carries on straight ahead
  beyond - covering the gap between. A road end on the tile border is never
  anchored: the road goes on in the neighbour (one snapped up onto a slip
  road's bridge crossing over it climbed 130 % in 5 m). Scored against the
  bake's own spans on 14 tiles: 278 of 278 own decks anchored, 1 of 3
  crossing ones (same tier) wrongly, and that one sat on the border.
- **Keep clear** only what reaches the ground: a bridge face whose corners
  (those with land under them; a deck often reaches over the tile's edge)
  all stand over 2 m above the land (a deck overhead) has
  nothing to bury, and kept, it held the land up in teeth beside a road cut
  down under the bridge.
- **Who wins the ground** (`BandResolver`): on a bed's own surface that
  bed wins, the higher tier if several; any surface beats any batter;
  batters are applied lowest tier first, so the higher has the last word.
- **Batter reach.** A batter reaches only as far as its own lift needs,
  plus 16 m for refining tiers and 4 m for streets, opening out over 4 m
  past that. A street on its own ground touches nothing past its edges.

- **Streets refine where they must.** A street segment more than 1.8 m off
  the ground the tiers above left refines the land like they do, at a
  looser 1.5 m fit. That covers ramps up to a higher line, and a railway
  cutting reaching under a street's bridge approach. One riding a higher
  line's embankment does not; that is refined already.
- **Structures and gaps.** A point with no land under it (water, a gap
  under a bridge), or drawn over 15 m off the land, lays no bed. It does
  not pull on the fit, and the curve rounding carries the nearest land
  sample's height over it. Chain ends stay held whatever is under them.
  A stroke point beside such a sample takes the height of its own kind.
- **Junctions only at one level.** Two lines sharing a plan point but
  drawn over 2 m apart cross one above the other (an overpass with no
  deck baked), and are not held to each other.
- **Grade separation.** Two surfaces of one tier over 3 m apart at a point
  are one above the other; the land takes the nearer, not their mean.

On the Garmisch 3x3 leaves (5 with roads), all tiers cost +24 % land
triangles over railways alone (+123k against +70k on a 107k base), about
1.5 s a tile in the worker. Highway over 6 %: 3.75 -> 1.99 km. Streets
over 10 %: 12.8 -> 8.4 km of 144 km. No point of any tier floats over 2 m
above the land, not counting points on a tile border (the bake drapes
those onto the border skirt) and points over a baked vertical face.
A 10 m carve under a street at a bridge used to leave its approach 7.4 m
in the air.

Per line:

- **Profile.** The track is resampled every 5 m and a dynamic programme
  over 5 cm height steps fits it no steeper than 3 %. Chain ends and level
  crossings are held to the ground, and cuttings and embankments are capped
  at 6 m: past that the grade gives way, at a steep cost, so rack railways
  and mountain lines stay steep instead of becoming canyons. Grade breaks
  are then rounded into 80 m vertical curves. Track drawn more than 2 m
  off the land is held where it was drawn, and the land is built up (or
  cut down) to it. Only past 15 m is it treated as a structure and given
  no bed.
- **Gentle grade changes** (`smoothVerticalCurves`, `BedTier.verticalRadiusM`,
  2026-10-07). Every line's profile is then smoothed towards a vertical
  radius for its tier: railway 5000 m, Autobahn 10000 m, highway 4000 m,
  street 500 m.
  - **Method.** A Whittaker smoother: least squares on the heights plus a
    penalty on each sample's second difference, weighted so a full swing
    between +-maxGrade turns over radius x 2 maxGrade. Held samples (deck
    ends, the border, junctions) stay exactly, a structure's samples are
    free, and a chain's free ends weigh 100 times more.
  - **Earthworks.** The cutting or embankment follows the smoothed line.
    - A railway's has no cap here.
    - An Autobahn's or highway's may go to twice its cap.
    - A street's keeps its 1.5 m: wider, a 10 % street went to 16-18 % beside
      its junctions.

    Where a sample would end past its band, the smoothing is loosened round
    it and solved again (up to 12 times); what remains is clamped.
  - **Rejected.** Pinning such samples to the band's edge, and a hard
    radius limit projected on sample by sample, both kinked the line at
    every pin or junction: highways' sharpest 1 % fell to 73-80 m.

  Before, the 80 m rounding was undone between held points: railway crests
  as tight as 170 m, highways' sharpest 1 % 176 m, streets' 152 m
  (Garmisch).

  After (Garmisch 5x5 / Kitzbühel 3x3):

  | Line | Sharpest 1 % | Under 500 m | Typical (p10) |
  |---|---|---|---|
  | Railway | 1231 m / 4075 m (was 116 m) | 0.1 % (was 8 %) | 4230 m |
  | Autobahn | 7803 m | 0 % | 13119 m |
  | Highway | 161 m / 526 m | 5.9 % / 1.0 % | 952 m / 6878 m |
  | Street | 113 m / 77 m | 10.9 % / 22.5 % | 467 m / 256 m |

  Mountain highways and town streets stay tight: they are held to their
  junctions every few dozen metres and to their cut/fill, and the gentler
  curve would need more earthworks than they are allowed. A railway's grade
  can reach 3.4 % beside a held point as the line meets it.
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
  Every segment of the line within batter reach of that end is cut at the
  abutment's plane, not just the last 5 m one: the one before it rounded
  its batter on 30 m under the span, which lifted spikes between the
  roads passing below and stood walls round them.
  The bed runs on to the deck's edge, where the stroke's last point is put
  (up to 8 m past the chain's own end), so no stretch of it is left in the
  air. A ramp that cannot climb to its deck within the limit spreads the
  extra grade over the whole ramp between its held points; charged by the
  metre past the limit wherever it fell, the fit kept low and climbed 11 m
  in the last 5 m.
  Roads do the same with their own decks (`BridgeRole.Deck` faces): a road
  end with a deck starting within 8 m straight ahead, still there 5 m
  further on, none 5 m behind it, and at most 16 m up, is held at the
  deck's top. A road's stretch over its own deck (deck under it 15 m
  ahead and behind) lays no bed and makes no junction.
- **Deck clearance.** Under any deck top (road or rail) the land is kept
  0.6 m below it. Some decks are baked flush with the ground or a few
  centimetres under it. Unrefined, the land over them was one merged
  sliver whose depth interpolation error happened to push it behind the
  deck. Cut into accurate pieces near a bed, the land buried the deck. So
  where the land is refined, points just inside every deck's footprint
  (its edges every 2 m, drawn a tenth of the way in) are checked too, and
  the land must come out at least 0.15 m under the deck there. Land
  lowered under a deck never counts towards a retaining wall.
- **Keeping clear.** Some things must stay as baked: bridges (every
  deck, pier and abutment triangle of the tile's and its neighbours'
  `.pbr`), lakes and the sea, and watercourses. Roads are beds of their
  own now, not kept clear of. Near one of
  them, the ground may move at most half its distance to it (1:2): not at
  all on it, a slope away from it. So a batter runs out before it reaches
  a road, a bridge or the water. On the bed itself the track still wins.
- **Retaining walls** (`retainingWalls`). Where that squeezes the
  earthworks past 45 degrees, a straight concrete wall goes in.
  - **Where.** Every 2 m along a bed and out either side (from 1 m inside
    its shoulder to 12 m past it, every 0.5 m), the designed ground - the
    earthworks' target, not the mesh - is read. The first drop steeper than
    1:1 by 1 m or more is a cliff: a batter cut short, a line's surface
    against a higher line's batter. Lower is a bank and stays one.
  - **Which side.** Each sample says for itself whether the cliff holds up
    an embankment or holds back a cutting, so one run can be both.
  - **Whose.** A cliff nearer another bed's shoulder is that bed's, so two
    lines side by side never wall the same strip.
  - **Shape.** Beside an embankment: a vertical face where the cliff ends,
    from below the ground in front up to the ground behind, and a flat top
    back over it. Beside a cutting: a face where it starts, up to the ground
    above, and a flat top out over it. Face and top reach 1.5 m past the
    cliff either side, for the land's facets that follow it. The extents are
    smoothed over 2 samples either way.
  - **Which lines.** Railways, Autobahn and highways get walls; streets do
    not, since over sparse vertices their steep facets made stray blocks.
  - **Size.** Runs shorter than 15 m are dropped. Each run is simplified to
    the fewest straight pieces within 15 cm of its line (height included).
    - A run's pieces are one strip, their corners shared: 4 vertices a
      corner (face foot and top, top front and back) where every piece had
      8, plus end caps where the strip ends.
    - A shared corner's face normal is its two pieces' between, and its foot
      the lower of theirs.
    - Garmisch 5×5: wall vertices 23,184 -> 13,800, triangles unchanged.
    - Looser simplification costs the fit. The land stood more than 1 m up
      14 % of the faces sampled at 0.15 m, 17 % at 0.25 m (vertices a
      further -21 %) and 21 % at 0.4 m (-40 %). A looser top alone (0.5 m)
      did no better than 0.25 m.
  - **Where built.** Only on leaves, in the bridges' concrete material.

  The walls were placed from the mesh's steep facets before (2026-10-07,
  the Garmisch B2 under its three bridges), one offset and one kind per
  run, at the farthest steep facet. Facets lowered under a road left steep
  slivers that raised walls where nothing was designed steep, the land
  poked out past the wall where the steep ground reached further, and two
  lines walled the strip between them twice. On the Garmisch centre leaf,
  land poking up within 0.5 m of a wall's top 1 m in front of it went from
  5 % of samples to 0 %. Median height went 3.8 -> 2.7 m and median top
  width 2.5 -> 0.7 m (plus the 1.5 m either side).
- **No wall on a road.** Neither a wall's face nor the top it reaches over
  stands on another line, or within 0.5 m of its edge: every bed, and every
  drawn line even where it has no bed (a carriageway held off the land).
  The run is checked every 2 m and stops there; what is left either side
  is a wall of its own if it is still 15 m long. A line never blocks its
  own wall: that stands at least a shoulder (0.8 m) past its edge. At
  Garmisch this took 30 % of the wall triangles off roads (5124 -> 3460),
  and none is left on a drawn line. Bridge piers keep
  the same rule (`placePiers`): a pier over a road or track, its footprint
  1 m clear of the edge, moves along the span up to 40 % of a bay, or is
  left out and the deck spans on; the bridge bake's `piers` line counts both.
- **No wall above a deck.** A wall's face and top stop 0.1 m under the
  underside of a deck over them. Where that leaves less than 1 m of wall,
  there is none. A cutting 12 m deep under a road bridge at Garmisch
  (47.513, 11.107) had walls standing 8.3 m over the underside, 6 m over
  the deck's top.
- **No land above a deck beside it either** (`DeckCeiling`, in the grading's
  `underDeck`). The road carried on a deck has no bed there, so nothing cut
  the land beside the deck: at that bridge it stood 6 m over it, the walls
  holding it with it. Within 15 m of a deck, the land stands at most
  0.5 m under the deck's top at its edge, rising off it at 1:1.5. Left as
  they are:
  - a line's own surface (carriageway and shoulder);
  - land kept as baked (water);
  - decks high over a valley (the ceiling is above the land there).

  The walls follow, since they read the same designed ground. There, land
  5-9 m off the deck went 696.5 -> 693.9 m and the walls within 9 m 696.0 ->
  694.1 m, for a deck top of 690.7-692.9 m. The road checks are unchanged.
- **Bridge concrete carried down to the graded land** (`underpinConcrete`).
  The bridge bake builds abutments and piers down to the ground as it
  reads it (an abutment to 1.5 m under its end's ground), but it runs
  before the grading. Where the grading lowers the land beside a deck
  end, for a road passing under or a cutting, the block is left hanging
  in the air with the land rising into it.
  - The grading takes every vertical concrete face of the tile's and its
    neighbours' bridges whose base stood at or under the ground the bridge
    bake read, and carries it down as a concrete face to 0.5 m under the
    graded land.
  - Never over a road (the walls' keep-clear), so no deck side becomes a
    curtain over an underpass.
  - At the Garmisch B2: 76 triangles (`wall triangles (N under bridges)`
    in the grade's summary).
  - Not the railway abutment at 47.5393, 11.1182. OSM's bridge ends about
    2 m short of the B2 carriageway it crosses, so the abutment stands
    over the road's edge and is left as it is. The embankment there ends
    in a 5 m needle at the 4348/4349 tile border, where both tiles hold
    the land at road level.
- **Land cut at the walls' faces** (`cutLandAtWalls`). The land's facets
  can't stand vertical, so a facet from the road up to land behind a face
  stood out in front of it: a green wedge on the concrete (the B2 under its
  bridges). Every facet crossing a face is cut along it.
  - **The step.** Within the piece, land in front ends at the wall's foot.
    Land behind starts 0.3 m under its top: flush with the top, the two
    fought.
  - **Behind the face, not on it.** The cut is 0.15 m behind the face.
    Positions round to the tile's quantum (8 cm at a leaf), and a step
    right on the face stood a few centimetres in front of it in places: a
    jagged green line up the wall.
  - **Corners just in front** (within 0.3 m, or the 0.15 m behind) come
    down to the foot. The mesh's own slope had its upper corners there.
  - **No cracks.**
    - Where an edge crosses a face, and both heights there, depend only on
      that edge and that piece, so the facets either side cut it alike.
    - Pieces are taken in one order everywhere.
    - A point put on a baked edge without a step is added to every triangle
      across that edge. Left out, it rounded a few centimetres off the edge
      and opened a crack.
  - **Within the piece only.**
    - A piece cuts a facet only where its line crosses it within the piece.
      Split by a line 16 m past its end, a facet's pieces mixed with the
      next piece's cut.
    - A piece's end inside a facet is a corner of the cut, so the step
      holds right to it.
    - Past the end, land behind is cut again along the end's line and meets
      the land in front. The step runs up that line, under the wall's end
      cap, and closes where the cap stops: on the face's line past the end
      it was a hole; past the cap's reach, sky showed between the cap and
      the bank.
  - **Left as baked.** No step on an edge with a corner on the tile border
    (the tile across meets it as baked). None in kept land either (water),
    except under a deck: the bridges' triangles count as kept, and that
    froze the wedges under the B2's decks.
  - Garmisch 5×5: face samples with land more than 1 m up the face 0.5 m in
    front went 10.9 % -> 3.3 %, on faces with a flat top. The checker took
    only those then; on every face it is 14 % (and land more than 1 m under
    the top 0.5 m behind it, 15 %), with no figure from before the cut. Burial and the road checks are unchanged
    (Munich too). It takes 0.36 s on a leaf.
  - **The first try** (dropped): it moved corners behind a face up to its
    top and cut facet by facet. Cover went *up* to 22 %, needles 14 -> 42,
    burial 0.001 % -> 0.1 %, and cracks opened between cut and uncut
    facets.
- **Spikes taken down** (`SoupMesh.despike`). A vertex over every
  neighbour, steeper than 1.5:1 over any, comes down until it isn't, never
  below its highest neighbour. This applies only where the grading moved it
  or a neighbour, and never on the tile border.
  - A line's bed is never one: a vertex on it has a neighbour along it at
    its height. A line over a spike floats over the dips beside it anyway.
  - Limited against the gentlest neighbour instead, a 5 m needle kept
    2.8 m of it.
  - Without the moved-only rule, coarse tiles' Wetterstein peaks were
    lowered (84 at z11).
  - Garmisch 5×5: 351 lowered at z12, 6 at z11; needles 14 -> 2.
- **No terrain over a road or a railway** (`RoadCap`,
  `SoupMesh.keepUnderRoads`). The land is fitted to the beds within a
  tolerance (0.75 m) close to the strokes' own lift (0.65 m at the leaf),
  streets do not refine at all, and land-use fills ride over the ground, so
  land poked through roads in patches. After the land moves, every vertex
  on a drawn line's carriageway or shoulder that stands within a quarter of
  the lift of the drawn surface goes down onto the line's bed, and on
  leaves every triangle still rising over a road between its corners
  (checked along each carriageway's centre and edges every 2 m) is split
  there, its new corners lowered at once, down to the least edge - with its
  own budget of 150,000 triangles past whatever the beds took (a Kitzbühel
  town tile needed 69,000). The collapse never lifts land back over a road.
  Coarse tiles only lower their vertices. Buried road samples (land over
  the drawn surface, centre and edges every 2 m): Garmisch 5x5 0.003 %,
  Kitzbühel 3x3 0.014 %, from 1-13 % before. It costs triangles: Garmisch
  z12 +20 %, Kitzbühel +45 %, and walls where the land now stands cut back
  beside a line (Garmisch 3,588 -> 7,096 wall triangles).
- **Roads meet their decks (2026-10-06, the Garmisch B2 bridges).** Five
  faults left decks and roads apart:
  - Near the tile border the grading eases its target towards what the
    unsplittable border edge can reach; a line's own surface (its
    carriageway and shoulder) is now never eased - the B2's east carriageway,
    15 m from the border, kept half its cut and was buried by the land
    (12.9 % of its samples -> 0.1 %).
  - The bridge bake read a border crossing's ground on the tile edge itself,
    which finds the skirt or nothing: every border ramp was skipped (0 in
    every bake). It reads 0.5 m inside the tile now.
  - Lines shorter than a profile step (5 m) were not graded at all: the stub
    between a deck end 2 m from the border and the border kept its drawn
    height. Graded from 0.5 m now.
  - Deck anchors were refused within the border fade (taper < 0.15, 4.5 m);
    now only for an end on the border itself (within 0.5 m).
  - A road's stretch over its own deck (under a skewed end's corner) is held
    to the deck's top, still with no bed.
  - **Road deck ends** (`.pbr` version 5, `RailBedInput.roadDeckEnds`):
    the bridge bake writes where each road span's deck ends - its top on
    the centreline, its tier, the way into the deck - and the grading holds
    a road of that tier to it, as rail decks' track ends hold a railway: a
    chain ending within 6 m and arriving along the span, or ending on the
    deck end itself whichever way it turns, and a line passing within 2 m
    along the span (an approach running on past a junction at the bridge's
    head). Guessed from what the deck triangles cover, the attachment
    failed on short spans, bent ones, skewed corners and junctions, and
    left streets 5-6 m under their decks.
  - A chain's end at its own deck's end is never trimmed as a stray (drawn
    on the ground beside a deck point 5 m higher, it looked like a skirt
    drape), and a stray end that is trimmed takes the height of the end it
    came off rather than its drawn one.
  Deck-to-road joints (deck top against the road 1 m past each span end):
  Garmisch centre 3x3 8 -> 2 over 1 m (the 16 m flyover among them),
  Kitzbühel 3x3 19 -> 4; medians 0.32 / 0.35 m. What is left is steep
  ground right at an abutment - a street climbing 1 m per metre from a
  deck in a gully, a hairpin falling away - and one primary road 1.4 m over
  its deck at a junction.
- **Skew bridges.** A span's ends run parallel to the road or track it
  crosses nearest each end (`endSkews`, `BridgePlan.endSkew`), not square to
  the deck: the deck's end face, its parapets' ends and the abutment block
  lie along that line, and the deck keeps its width across. From 5 degrees
  off square up to 50, and no further than keeps an end's corners within
  30 % of the span, and 3 m, from its end station (past 5 m the grading
  took its own deck behind a road's end for a bridge the road ends under,
  and left the road on the ground); interior deck sections nearer an
  end than its corners reach are dropped so the slab never folds back. The
  bridge bake's `skewed ends` line counts them (Garmisch 5x5: 14,
  Kitzbühel 3x3: 10). A pier with a road's or a track's centreline within
  15 m stands parallel to it the same way (`alignedAcross`, `Pier.across`,
  `BridgeGround.roadDirAt`), within the same limits; the rest stay square
  to the deck (Garmisch: 2 of 8 turned, Kitzbühel: 1 of 2).
- **Land.** Triangles are bisected (conforming, longest edge) only where
  the bed and its 1:2 batters cannot be followed within 0.75 m. That fit
  is checked at the bed's own creases inside a triangle (track samples,
  bed edges, batter toes) as well as on a grid, since merged fields run
  to 1,400 m and a grid steps over a 5 m bed.
  - **On the crease, not the middle.** An edge a crease crosses (the line,
    a bed's edge, a batter's toe, where its band opens and shuts) is split
    there, 20-80 % along it (`BedIndex.creaseCrossing`), so one vertex
    lands on the crease instead of halving after it.
  - **Taken back where flat or nearly.** After the land moves, each
    vertex the refinement made is collapsed into a neighbour
    (`SoupMesh.collapseFlat`) where the surface stays within 1.5 m of the
    refined one. At 0.75 m (the refinement's own fit) the grading still
    added half again to a Garmisch leaf's land. 1.5 m took a fifth of the
    added triangles back (the 5×5 7.4 MB instead of 8.1, road checks
    unchanged). At 3 m the land heaved up in front of the walls. Beside a drawn line (within
    2 m of its shoulder) it may go only 0.15 m lower: ribbons have no
    skirts, and land let down beside one opens a gap under its edge. Under a
    deck it may not rise at all, which keeps the clearance the refinement
    gave it. Only inside one surface (every edge round the vertex on exactly
    two triangles, so a land-use fill's outline and the stacked edges under
    it stay), never turning a triangle over or thin, never over a road,
    never removing a triangle that holds a baked slot. Edge flips between
    passes undo the needles bisection leaves along a crease.
  - **Exact against what was refined, and against the other layer.** Two
    surfaces of flat triangles differ most at a corner of one inside the
    other, or where their edges cross. So each new face is tested at those
    points (`collapseChecks`):
    - against the refined surface of its own layer as it was when the
      collapse began, so the passes never add up;
    - against the other layers as they are now. Land-use fills cover nearly
      all the land (11,280 of 16,190 triangles on the Garmisch centre leaf
      are fill over ground) and are refined apart from the ground, so no
      collapse brings a fill and the ground under it nearer than 0.2 m, or
      than they already were (`LAYER_GAP_M`).

    Three things stopped working before this:
    - Testing against the current fan let 0.15 m drift.
    - A carried error bound grew so fast that 0.5 m behaved like 0.15 m.
    - 0.15 m everywhere, the old guard against fill and ground crossing,
      kept twice the triangles needed.

    The road cap's probes also take where a face's sides cross the
    carriageway's centre and edge lines: bigger faces rose over a road edge
    between the 2 m steps.
  - **Least edge.** The refinement splits no edge under 3 m
    (`REFINE_MIN_EDGE_M`); at 1.5 m a quarter of a graded leaf's land was
    triangles under 2 m². The road cap still splits down to 1.5 m.

    Together:

    | Area | Triangles added by the grading | Graded leaves |
    |---|---|---|
    | Garmisch centre leaf | 34,225 -> 22,824 (land 50,415 -> 39,014) | |
    | Garmisch 5x5 | 485,927 -> 344,585 | 8.9 -> 7.5 MB |
    | Kitzbühel 3x3 | 506,399 -> 424,879 | 8.4 -> 7.6 MB |

    Nothing got worse:
    - buried road samples: Garmisch 0.003 %, Kitzbühel 0.005 %, was
      0.014 %;
    - no wall on a road;
    - no deck-to-road joint over 1 m.

    It costs grading time: 19 -> 24 s a leaf at Garmisch, 22 -> 36 s at
    Kitzbühel.
  - **Border triangles** may be split, but never along an edge between
    two border vertices. Border vertices never move, keep their exact
    bytes, and stay in their original soup slot and corner, so the seam
    stitcher's indices hold.
  - **Ramps across the border.** Where a line crosses the tile border,
    both tiles hold it to the same height. The bridge bake works it out
    (`borderRamps`, written as `.pbr` version 4 ramps): from each crossing
    of a leaf tile's edge it walks the lines of the same tier, nearest
    first, in the tile and its neighbours, up to 500 m, joining two lines at
    any vertex they share (a siding joining a track partway along it, not
    only end to end - walked end to end, a Munich yard missed the deck one
    junction over and climbed 11 %), and holds the crossing
    high enough to climb onto a raised deck end of that tier within 85 % of
    the grade, or low enough to pass under a bridge left on the ground over
    it - both tiles walk the same lines from the same point, so both read
    the same. A dip is every point (2 m apart) of the road under the deck,
    each with its own height to get to: one per road, the deepest under
    the ground, missed a railway deck running along the B2 and sloping
    down towards the border, 14 m from it. The crossing's ground is read
    0.5 m along the line, or towards the tile's middle where the line
    leaves the edge back outwards. The ramp is added to the line's own
    first point in from any strays at that end, not to a stray's height
    on the skirt. Deck tops, dip heights and the ground at the crossing are
    compared as heights above the ellipsoid: each tile plans in its own
    frame, whose up leans and whose origin moves tile to tile, and measured
    from its own ground a ramp missed the 1.5 m the ground rose to its deck. Round such a crossing (a strip from it in along the line, past
    the taper) the fade is lifted and the border vertices there move; the
    stitcher takes the moved border as the tile's own (`seam.orig` is set
    from the graded land). The mesh bake puts border vertices at every grid
    node within 30 m of where a road or railway crosses a leaf tile's edge
    (`BuildTileInput.forcedBorderNodes`, from the tile's `.rvr`), the same
    nodes in both tiles, so the land has vertices to move there. Held where
    drawn, a Munich flyover's ramp only had the 58-131 m on its own side of
    the border, where 3 % needs 190 m (69 % in its last 5 m; 7 % now).
    A skirt or wall (steeper than 5:1 in plan) is never ground: on the border
    line a 243 m skirt read as land 31 m under a track and made it a
    structure.
  - **Strokes fade with the land:** a line's height change is scaled by
    the same border fade, or near a border it parted from its ground (a road
    cut 7 m down under a bridge 5 m from the border lay buried in land that
    had moved 1.2 m).
  - **Fade at borders:** the beds fade out over the last 30 m before the
    border, since land beside a fixed border could never fit them. The
    distance is to the border's edges, not its vertices. Those are 300 m
    apart on a straight side: a vertex split into a sliver 2.5 m from the
    border was taken for 130 m in and lifted 6 m with a rail embankment,
    a dark fin standing on the seam.
  - **Long triangles:** a vertex of a triangle with an edge over 40 m
    moves only for the lines that refine. Moved for a street, it tilted a
    whole merged field.
  - **Normals:** a piece split along its own plane keeps the baked
    normals. A moved vertex takes the area-weighted normal of the faces
    round it, near-vertical ones left out. Splitting a 1.2 km sliver
    leaves needles 2 m wide, and a few centimetres' move tilted a needle's
    own face normal 30 degrees, shading a dark wedge across the field.
  - **Land-use fills** keep their lift over the ground under them (each
    vertex moves by what the beds do to the lowest facet beneath it).
    Moved to the same absolute height, fill and ground would fight.
  - **Walls:** zero-area vertical faces are only split along an edge a
    real neighbour splits. Bisecting them on their own looped to the
    triangle cap.
  - **Blocked splits:** where the longest-edge chain is blocked further
    along, or an edge is shared by more than two triangles (land-use fills
    stack), the triangles split along the shared edge at one midpoint
    instead of giving up: a fill left whole covered a cutting 6 m deep.
    About 3 % more triangles.
  - **Stroke on top:** on the bed itself the track beats a road alongside
    (a steep edge, then a wall, rather than floating track). Beside the
    bed, kept features win. It costs about +50 % land triangles on a leaf
  with track up a valley side, much less in flat valleys.
- **Coarser tiles** (z9-z11) get the same profile with lengths scaled to
  the tile, but no new triangles, only existing vertices moved: a cutting
  is a few pixels there.
- **Baked.** The grading rewrites the `.ptm` land (`writePtmLand`, a byte
  splice keeping water, rivers and the border table) and the `.ptr`
  strokes (`encodePtrRaw`, inserted vertices included), and writes a `.pbd`
  (`pbd.ts`) with the beds, simplified where they run straight, and the
  retaining walls. The runtime (`bedStore.ts`, `TerrainEntity.railBedJob`)
  only loads the `.pbd`: walls as a mesh, the beds for collision and as the
  trees' and rocks' keep-off mask. The inputs are what the browser used to
  assemble (`tools/bake/railBedInputs.ts`): the tile's land and strokes,
  its and its neighbours' bridges, its water, and the lidar profiles of
  its lines where the store has measured them (below).
- **Graded is final.** A graded tile carries `PTM_FLAG_GRADED` and
  `PTR_TILE_GRADED`. Grading it again would lay the beds on its own beds,
  and the stages that read a tile as the ground its lines were drawn on -
  the road strokes, the bridges, the grading - refuse it: re-bake the
  meshes and strokes of a box before grading it again.
- **Free border.** Leaves are graded in two passes: the first writes every
  leaf's beds (the box and the ring round it) to a temporary `.pbd1`; the
  second grades each leaf with its neighbours' beds and its border free
  where a bed reaches it, so both tiles move their shared border vertices
  alike, and a line running along the border keeps its profile instead of
  fading out over the last 30 m (the B2 under the railway bridge at
  Garmisch, 6-9 m from a tile border, could not dig its underpass: 3.2 m
  under the deck, 6.4 m now). An edge between two border vertices is never
  split - the seam table holds it - so near the border the target eases to
  what that edge can do: its two ends moved, linear between them. Skirt
  vertices, on the border too, are never taken for it: their feet hang up
  to hundreds of metres below.
- **Collision.** Each leaf's beds go into `RailBedField`, as lat/lon plus
  height above the ellipsoid (`bedsToGeodetic`), so a re-base does not
  move them. The height sampler resolves them by tier like the drawn
  land, applied the way flatten pads are, and the height mirror carries
  them to the sim worker.

Bridge decks the bake left level with the roads under them (a 5.5 m slip
road bridge beside the railway near 47.539 N 11.118 E) were a bake fault,
not a grading one: the planner only lifted a deck over a road crossing at
20 degrees or more, and those cross at 17-19. It now counts a road whose
centreline cuts the span's at any angle away from its very ends, as well as
one stopping short of it at 20 degrees or more (the stretch under a bridge
is often a way the road vectors leave out). Spans too short for a station
between their ends are checked at the ends too. Against the old rule,
Garmisch: 29 of 200 spans lifted, 4 more than before, none lost; Munich:
409 of 668, 38 more, 2 lost.

### Lidar

The land is a 30 m DEM: it sees no embankment, cutting or bridge approach
(around Garmisch 19 % of line length stands on more than 1 m of fill in the
lidar, 0.1 % in the DEM). `tools/measure_lidar.py` (`npm run bake:lidar`)
reads the open 1-2 m lidar terrain models along the lines and keeps only
the answers in the lidar store (`tools/bake/lidarStore.ts`, LMS1,
`data/imports/lidar/store/12/x/y.lms`, bake-only):

- **Lines:** every graded-class line of a leaf's `.rvr` every 5 m (streets
  10 m): the crown, the median of five reads across the carriageway, and
  the lift, crown minus the ground 20-40 m out on both sides (median per
  side, mean of the two).
- **Bridge ends:** per `.rbr` span end, the median lift of the approach 2-12 m
  beyond it along the span. The terrain model fills in under a short span,
  so the approach is read beyond the end, not on it.
- **Against the OSM vectors, not the mesh:** a re-mesh or re-grade keeps the
  store. A changed `.rvr`/`.rbr` (crc32 in the header) drops that half until
  the leaf is measured again.
- **Sources** in order (Bavaria DGM1, BEV ALS DTM 2025, swissALTI3D, then
  eight German states and IGN for Gran Canaria; the table is in
  tools/README.md), one source per station, each in its own datum. A 1 m
  model is read at 2 m where the service can cut it down (the WCS
  `SCALEFACTOR`, the Austrian COG's first overview): an embankment is still
  several pixels across.

The grading (`tools/bake/lidarProfiles.ts`) samples the store along each
ungraded stroke segment and fits the line to the land plus the measured
lift ('rel'). The crown in the land's datum, per tile and source (the median
of land minus lidar ground beside the lines), is kept for 'abs' but unused:
'abs' turned every error of the 30 m land beside a road into a fake
earthwork. A chain's end on the tile border with no border ramp is fitted to
the measurement too (the tile across measures the same road there): held
where drawn, a Munich street in a cutting 6.5 m deep stood up to the DEM's
ground at the border in its last 5 m, on both tiles. The bridge bake puts a deck end at the land under it plus the
measured approach lift, clamped to 0-15 m.

What a deck has to clear (water, a road under it) lifts its ends as little
as it can in all (`liftEnds` in `tools/bake/bridges.ts`): tilted within the
span's tier grade rather than raised in parallel, which put a street 5-9 m
above the slip road it meets at Kitzbühel. A measured end is lifted only
when the other alone cannot make it.

Checked on Garmisch: the store against the prototype's resampled grid,
median |lift difference| 2 cm, p95 15 cm.

The grading prints per-zoom totals: tiles, triangles added, wall
triangles, track over its limit, beds and bytes. The older bake-time road
grading (`tools/bake_planet_roadgrade.ts`, `.rgr`) is superseded; never run
it on a graded pyramid.

## Pipeline

```
npm run bake:roads -- --bbox w,s,e,n          # OSM -> assets/planet/{z}/{x}/{y}.rvr
npm run bake:tex -- --bbox w,s,e,n            # paints major roads into the far rasters
npm run bake:road-strokes -- --bbox w,s,e,n   # .ptm + .rvr -> assets/terrain/{z}/{x}/{y}.ptr
npm run bake:lidar -- --bbox w,s,e,n          # .rvr + .rbr + lidar -> data/imports/lidar/store/12/x/y.lms
npm run bake:bridges -- --bbox w,s,e,n        # .rbr + .ptm (+ store) -> .pbr bridges, deck heights
npm run bake:grade -- --bbox w,s,e,n          # beds into .ptm/.ptr, .pbd beds + walls
```

The F10 import runs all six (the vector bake after the coast, the
stroke bake, the lidar, the bridges and the grading last; a delete re-runs
the last five round the hole). The grading is the last write of a tile; see
Graded beds. `delete_area.py` removes `.rvr` and `.ptr` with the
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
  `texture`, `roads`, `bridges` and `beds` blocks forward; a mesh bake that dropped `roads`
  (2026-09-16) turned roads off for the whole pyramid with every `.ptr`
  still on disk. Re-run `bake:road-strokes` after any re-mesh anyway: the
  strokes are draped on the old facets.

- `bake:road-strokes` prints strokes dropped per level; a leaf level with
  many dropped is the cap biting in a city, and the answer is the cap, not
  the class cut.
- The pixel-floor stretch cap (`RIVER_MAX_STRETCH`) was tuned for rivers
  seen at grazing angles; roads are straighter and longer, so a motorway
  looked along at low level is the case to check for fan-out.

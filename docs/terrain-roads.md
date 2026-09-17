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

## Five controls on the cost

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

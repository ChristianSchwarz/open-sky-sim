# Far-tile cover textures: plan

Written 2026-09-13. All six steps landed the same day.

Step 5 as built: a *Far tile textures* slide toggle on the Graphics tab
(`FarTileTexturesSetting`, persisted as `farTileTextures`), which writes one
uniform (`uCoverEnabled`) and stops new sidecar fetches; textures already
attached stay with their tiles. `__terrainStats.textured` counts attached
tiles and the F9 HUD's streaming line shows it as `TEXn`.

Found 2026-09-14: `bake_planet_mesh.ts` rewrote the manifest from scratch
and dropped the `texture` block, so a mesh re-bake of any area silently
removed every texture from the runtime's view while all the `.ptx` files
stayed on disk. The mesh bake now carries the block forward and says to
re-run `bake:tex`; the import pipeline already does.

Found the same day: a dev server started before `modserver.ts` learned to
send `Content-Encoding: gzip` for `.ptx` hands the runtime raw gzip bytes,
which failed to decode and left every far tile untextured with no visible
error. `TileStore` now inflates a payload that arrives with the gzip magic
itself (one console warning per store), so a server or static host without
the header still works; restarting `npm start` gets the header back.

Runtime as built (steps 3-4): `coverTextures.ts` owns a second `TileStore`
for the sidecars, gated by `index_tex.bin` and the manifest's zoom range,
and attaches a `DataTexture` (hand-built mips, nearest both ways) to a
resident tile's land mesh when the sidecar lands - nothing waits on it.
The per-tile frame is two bake-frame vectors (local east and north at the
tile centre, scaled to tile fractions) plus the pole-ward lon shrink `k`;
`terrainVP` projects the raw position onto them for `vCoverUv`, and
`terrainFP` resolves the texel through the shared `facetColor` chunk in
`terrainCover.ts`. Verified in the browser from the 10 km preset with the
quadtree capped at z10: textured tiles show the airfield and field
polygons, the same tiles with their bindings removed are flat blobs. The
`Space` preset sat below the texture range while the floor was z6; since
the floor moved to z4 (2026-09-14) its z5 tiles are textured too, and every
baked area - alps, can, can2, crim1, mad, pb - has textures from z4 to z11.

Measured after step 2, full pyramid (2683 leaves): 120 s, 1154 textures,
288 MB raw and 20.6 MB gzipped (z11 alone 10 MB), so the shipped-bytes
worry below did not materialise at 256 texels. A scoped `--bbox` re-run
over 30 cached leaves takes 0.1 s.

## The problem

A coarse tile (z11 and below) paints one colour per facet, and its facets
are large: a z9 facet is hundreds of metres across. Every land-use polygon,
field boundary and village that the z12 leaf resolves collapses into a
majority vote per facet, so from 10 km up the ground is a patchwork of
blobs, and the moment a leaf dissolves in over its parent the detail
"switches on". The bake already has the answer in the leaves; the coarse
tiles just cannot carry it as geometry.

## The idea

Rasterise every z12 leaf's land facets - their baked `(r, g, b, class)`
words - into a small top-down image, build a 2x2 pyramid of those images
up the quadtree, ship one image per coarse tile as a sidecar next to its
`.ptm`, and have the land shader sample it per fragment instead of taking
the facet's vertex colour. Geometry stays exactly as baked; only where a
facet's colour comes from changes. A leaf keeps drawing its own facets, so
a textured parent under a dissolving leaf and the leaf itself resolve
colour through the same palette code and the crossfade still matches.

Everything the four colour modes need travels in the texel: the texture is
RGBA8 with the class in alpha, the same four bytes as `landAttr`, so
Imagery / Swatch / Hybrid / Palette stay a uniform write, never a re-bake.
Alpha 255 marks no data (sea, or ground under an area that was never baked
to z12), and such a fragment falls back to the vertex colour it has today.

## Design decisions

**Texel grid is lon/lat, not metres.** Tiles are geodetic
(`2^(z+1) x 2^z`, see `tools/bake/meshTile.ts` `tileBounds`), so a parent is
exactly its four children side by side in lon/lat. Rasterising in that
frame makes the pyramid a plain 2x2 downsample with no resampling and no
seams. The runtime turns a vertex's tile-local ENU position into that
frame with one first-order term for the change of `cos(lat)` across the
tile (`u = 0.5 + x / (W * (1 + k * v'))`, `k = tan(lat0) * spanLat`), a
per-tile `vec4` uniform. The residual at z7 is under two texels of 256;
textures are not planned below z6.

**Rasterise the leaf `.ptm`, not the source vectors.** The leaf's facets are
the already-resolved result of fills, votes, ground means and imagery.
`decodePtm` is O(1) and `enuToGeodeticApprox` exists, so a stage after the
mesh bake needs nothing the mesh bake had in memory, and a `--bbox` re-bake
re-rasterises only the leaves in the box and re-folds their ancestors.

**Sidecar file, not a PTM section.** A PTM version bump is a full ~18 min
re-bake and refuses old tiles; a sidecar is optional, so a pyramid without
it renders exactly as today. Format `PTX1`: a 16-byte header (magic,
version, size, z, x, y) and raw RGBA8, gzip on disk and served the way
`.ptm` already is (manifest `transport: gzip`). Decode is a typed-array
view, matching the PTM rule.

**Size 256 for z11 and below, ships z11..z4** (z6 at first; lowered to z4 on
2026-09-14 so the Space preset's z5 cut shows detail too - the tangent-plane
mapping's second-order error is under two texels at z4 and a dozen at z3,
which is where it stops). A parent is only drawn when
its projected width is a few hundred pixels at most, so 256 texels across
is about a texel per pixel. z12 rasters (also 256) are bake intermediates
only, kept in a cache directory and box-filtered into their parent's
quadrant. Rough shipped size, current pyramid: 1033 z11 + 310 z10 + 110 z9
+ ~60 below, x 256 KB raw = ~390 MB raw; flat-colour content should gzip
to a tenth or less. Measure after step 2 and drop z11 to 128 if it has to.

**Two sizes by level (2026-09-14).** The tiles just under the leaf cut,
z10 and z11, are the textured tiles drawn nearest the camera and the ones
where 256 texels ran short of a texel per pixel; they get 512
(`--near-size`, from `--near-zoom`). Everything coarser stays at 256. A
level's size only ever rises toward the leaf, so folding a child into a
coarser parent is one more halving (`shrinkTo`), never an upsample. Leaves
are rasterised at the finest size any parent wants and the cache is now
gzip level 1, since a megabyte of mostly flat colour per leaf shrinks
twentyfold. The runtime needs no change: every PTX1 carries its own size,
and the mip builder and byte accounting take it from the header.
Measured: 4757 leaves re-rasterised at 512 in 462 s; 1909 textures, 1.73 GB
raw, 72.3 MB gzipped (z11 37.9 MB, z10 26.0 MB, the 256 levels 8.4 MB
between them); the compressed leaf cache is 113 MB, down from 682.

**Filtering.** Nearest, clamp to edge, with mip levels supplied by the
loader (rgb box mean, class of the top-left texel per 2x2). Three's own
`generateMipmaps` would average the class byte into garbage. Building mips
for 64 K texels at upload is well under a millisecond, inside the existing
`TILE_UPLOAD_BUDGET_MS`.

**Shading.** Light stays per vertex (`vLight`); only the base colour moves
to the fragment stage for textured tiles. `facetColor` becomes a shared
GLSL chunk both programs include. `sizeReveal` does not apply: a coarse
tile carries votes, `regionSize` is 0, and it returns 1 as now.

## Steps

Each step is independently testable and leaves the game working.

1. **`tools/bake/coverTex.ts`: format and maths.** `encodePtx`/`decodePtx`;
   `rasterizeLeaf(ptm, bounds, size)` scan-converting each land triangle
   (positions -> ENU -> lon/lat -> texel, flat fill with its attr word,
   skirt triangles skipped by their depressed y); `downsample2x2` (rgb
   mean of non-empty texels, class majority, empty if all four empty);
   `mergeQuadrants(parent, child, quadrant)`. Unit tests: a single
   triangle covers the expected texels, a leaf's own raster downsampled
   equals the quadrant a parent gets, no-data propagates.
2. **`tools/bake_planet_tex.ts` and `npm run bake:tex`.** Walk
   `index_mesh.bin`, rasterise every z12 leaf into `assets/planet/tex_cache`
   (keyed by `.ptm` size+mtime, like `ground_means.json`), fold
   z11..`--min-zoom` (default 6), write `{z}/{x}/{y}.ptx` gz,
   `index_tex.bin` via `encodeTileIndex`, and a `texture` block in the
   manifest (`path, indexPath, size, minZoom, maxZoom`). `--bbox` scopes
   to leaves in the box plus their ancestors; `tools/areaImport.ts` and
   `delete_area.py` run it after the mesh stage. Print the size table.
3. **Runtime streaming.** `manifest.ts` gains `TextureStreamManifest`;
   `TerrainEntity` decodes `index_tex.bin`; the tile fetch in
   `tileStreamer.ts`/`terrainEntity.ts` fetches the sidecar alongside the
   `.ptm` for any indexed tile (a 404 or absent index entry means no
   texture, never an error). `tileMesh.ts` builds a `THREE.DataTexture`
   with the hand-built mips, adds its bytes to `TileMeshes.bytes`, and
   disposes it with the tile. Tests: index gating, byte accounting, mip
   class rule.
4. **Shaders.** Factor `facetColor` and its helpers into
   `shaders/terrainCover.ts`; `terrainVP` emits `vCoverUv` from
   `position * quantScale` and `uCoverFrame`; `terrainFP` samples
   `uCoverTex` when `uHasCoverTex > 0.5`, resolves through `facetColor`,
   and keeps `vBase` for alpha-255 texels. `tileBeforeRender` sets the
   three uniforms per draw next to `uLodFadeM`. Pixel snapping, log depth,
   fog and the dither reveal are untouched.
5. **Setting, stats, verification.** Settings dialog toggle "Far tile
   textures" (Material + Tailwind only), `__terrainStats.texturedTiles`
   and a `TEX` count on the F9 terrain line. Verify in the browser pane
   from the 10 km spawn preset over Gran Canaria: read
   `__terrainStats`, compare screenshots with the toggle off and on, and
   check a leaf dissolving over a textured parent shows no colour pop.
6. **Docs and memory.** `tools/README.md` bake order gains the stage;
   memory note on the sidecar format and why the grid is lon/lat.

## Risks and open questions

- **Shipped bytes.** The number to watch after step 2. Levers, in order:
  z11 at 128, drop z11 entirely (z12 leaves refine in at
  `LEAF_REFINE_DISTANCE_SCALE` anyway), palette-index texels.
- **Uniform arrays in the fragment stage.** `uToneColor`, `uClassTone` and
  `uSwatch` move to a stage where some ES 1.00 drivers are stricter about
  constant-index loops. Same loops the vertex stage compiles today; test
  on the integrated GPU as well.
- **Coarse tiles over partly-baked ground.** A z8 tile spanning one baked
  area and open sea is mostly no-data; the fallback path must be visually
  identical to today, which step 4's alpha-255 rule guarantees only if
  the raster never writes a land texel outside the leaf's own facets.
- **Minification shimmer.** Nearest sampling with supplied mips should hold
  since the LOD cut keeps a tile near a texel per pixel; if it shimmers,
  switch minification to linear-between-mips for rgb only (class stays
  nearest by taking it from the finer mip).

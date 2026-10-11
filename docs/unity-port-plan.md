# Unity port: parity plan

Status: draft, 2026-10-10; rendering approach revised 2026-10-11 (section 4.6). Written from five read-only code surveys (terrain formats, terrain
runtime, rendering, sim/AI, UI/input). Nothing in the repo was changed to produce it.

## 0. Progress (branch `unity-fe`)

| Milestone / stream | State | Where |
|---|---|---|
| M0 golden harness | Done: 10 suites, `npm run golden:check`, `tools/golden/golden.test.ts` | `tools/golden/`, `tests/golden/` |
| A core math, geodesy, FrameShift, tiling | Done, golden-verified | `unity/Packages/com.retro.core` |
| B terrain codecs (8 formats + PIX1) | Done, golden-verified on 32 real tiles | `unity/Packages/com.retro.terrain-data/Runtime/Codecs` |
| C LOD policy + quadtree selection | Done, golden-verified on 6 camera paths | `.../terrain-data/Runtime/Lod` |
| C streaming store, budget folding | Done: `TileCache`, `TerrainSession`, 600k fold (integration test on the real pyramid) | `.../terrain-data/Runtime/Streaming` |
| D terrain rendering | URP: tiles in wire formats, four colour modes, web lighting balance, leaf dissolve, sea; land-use reveal and far cover textures still open | `unity/Packages/com.retro.unity/Runtime/Terrain` |
| E buildings | CPU side golden-verified (earcut/`ShapeUtils` index-exact, extrusion of 3 real PBH tiles bit-identical, draw budget, tree mask, tones); Unity: `BuildingRenderer` extrudes on loader threads, `BuildingLit` | `.../terrain-data/Runtime/Buildings`, `com.retro.unity/Runtime/World` |
| E roads, rails, bridges | CPU side golden-verified on 6 .ptr + 4 .pbr tiles; Unity: `RoadRenderer` (wire-format upload, far road levels on demand, 0.9 px widening, the three rail passes), `BridgeRenderer` (decks, furniture, deck track) | `.../terrain-data/Runtime/Roads`, `com.retro.unity/Runtime/World` |
| E trees and ground clutter | CPU side golden-verified on 2 leaves; Unity: `VegetationRenderer` scatters on worker threads (road, building, airfield masks; rail-bed and surface-pad masks not wired yet), procedural instanced `VegetationBillboard` | `.../terrain-data/Runtime/Vegetation`, `com.retro.unity/Runtime/World`, `com.retro.unity/Textures` |
| F FM2 + FM3 | Done, all 26 traces match | `unity/Packages/com.retro.sim/Runtime/Physics` |
| G height queries + airfield pads | Done, golden-verified | `.../terrain-data/Runtime/Height` |
| G combat sim, colliders, arrestor, collision, player input, gun | Done, all 12 scenarios match (most to ~1e-13) | `tests/golden/combat_sim.json` |
| H dogfight geometry | Done | `.../sim/Runtime/Ai/DogfightGeometry.cs` |
| H AI pilots (4 models) | Done, all 34 closed-loop traces bit-identical (V8-exact trig in `JsTrig`) | `.../sim/Runtime/Ai` |
| O game state: spawn search, camera routes, runway pick, carrier site, recorder, re-base, all camera modes | Done, 74 tests ported from TS plus oracle checks | `unity/Packages/com.retro.game` |
| M2 terrain spike | Done: Gran Canaria on screen in Unity 6 / URP, handedness and floating origin verified | `unity/Packages/com.retro.unity`, `docs/unity-spike/` |
| M5 world detail | Done: airfields (golden-verified geometry, async build, unpaved strips repainted from the finest facet), roads/rails/bridges (in the terrain budget), rail walls, buildings, trees (road, building, bed, airfield masks), aircraft mod packs: 68 packs + F-22 (`aircraft.json` fixture: manifestToDef and hook placement), glTFast from the pack zip, material-name remap, swing wings, runway pavement as solid ground. Checked on screen at GC, Potsdam, Bautzen; F-14 sweep and Su-33 livery. Open: surface-pad mask for trees (no scenery pads yet), a pack's own flight config (none ships one), AI aircraft on packs (M7), spawn menu (M8) |
| M4 fly | The ported `CombatSim` over a streamed DEM height field with airfield pads; start on the nearest base runway (airfields.json, `PickStartRunway`) or airborne; FM2/FM3 switch; keys and gamepad go to the sim; F-22 glTF parts via glTFast with hinged surfaces and the gear clip; F1 cockpit, F2 chase, crash orbit. Verified: takeoff from GCLP 03L, crash on fine terrain, FM3 swap in flight. Open: landing not yet flown by script, no HUD (M8) | `unity/Packages/com.retro.unity/Runtime/Flight` |
| I aircraft and mods | Done for the player aircraft (see M5); AI use comes with M7 | `com.retro.game/Runtime/Aircraft`, `com.retro.unity/Runtime/Flight` |
| J aircraft fx | CPU side golden-verified (`aircraft_fx.json`, 960 frames): afterburner plumes, wingtip trails, swing-wing tips, tips from the body model; Unity shaders/renderers not written yet | `com.retro.game/Runtime/Fx` |
| J-P (sky, HUD, UI, wreck) | Not started | |

`cd dotnet && dotnet test Retro.slnx` runs every C# golden test without Unity (239 tests). All trig goes through `Retro.Core.JsTrig`, a port of V8's fdlibm, so closed-loop traces stay bit-identical to the browser.

## 1. Decisions already made

| Decision | Choice |
|---|---|
| Frontend | Unity (target Unity 6, URP, Burst, Mathematics, Collections, Jobs) |
| Simulation | Full port to C#. No Node process, no IPC. One native binary. |
| Bake pipeline | Stays as is (Python + TS tools). Unity only reads its output. |
| First deliverable | This document: a feature-parity plan before any code. |

Everything below follows from those. The web game keeps working throughout and serves as the
reference implementation ("oracle") for golden tests until Unity reaches parity.

## 2. What is ported, what is dropped

**Ported (about 60 to 65 percent of the 105k lines):**
physics (FM2, FM3, ground contact, collision), AI (four pilot models), weapons (gun), game state
slice, terrain runtime (codecs, streaming, LOD, seams, far land, roads/rails, bridges, buildings,
trees), rendering (sky, atmosphere, clouds, particles, aircraft models), HUD/OSD, settings UI,
input, audio, aircraft mod loading, crash/wreck system.

**Dropped, not ported:**

| Item | Why |
|---|---|
| Barricade stubs (`setBarricades`, `SerializedBarricade`, `carrierBarricade` spawn, `setBarricadeDrape`) | Solver was deleted in `a757fa0a`; `docs/barricade-phase-6-summary.md` is dead documentation |
| Web Worker, `simSharedState`, `simSnapshotCodec`, `combatSimClient`, `simProxyFlightModel`, height mirror (~800+ lines) | Single process in Unity; physics reads terrain data directly |
| `railBed.ts` grading (6,053 lines) | Bake-side. Runtime needs only `BandResolver`, `bedSegmentParam`, constants and `buildRailBedExclusion` |
| Angular/Material settings dialog | Rebuilt in UI Toolkit |
| `fflate`, `DecompressionStream`, SVG-to-canvas atlas generation | Replaced by `System.IO.Compression` and offline atlas bake |
| Debug globals (`__terrain`, `__terrainStats`, ...) | Replace with an in-editor debug window |
| Dev-server-only features: F9 terrain importer (map, SSE progress), F10 mod import, all `/api/*` endpoints, `modserver.ts`, `dev.mjs`, `deploy-pages.mjs` | A player build has no server; terrain and mod import stay as offline tools (the existing Python/TS pipeline) |
| Carrier-barricade spawn button (key `8`) | Barricade is gone; keep the other eight spawn modes |
| Web-only plumbing: COOP/COEP headers, `SharedArrayBuffer` fallback and 30 fps cap, reload-to-switch-area with `sessionStorage` | Not needed; area switch becomes an in-process world rebuild or re-base |
| Vestigial render features: stencil shadow-volume leftovers, `BackgroundGround` layer, DUOTONE/STATIC/DYNAMIC shading profiles | Dead; only the HD profile ships |

**Things not to copy blindly (found by the surveys):**
- Uploaded tile meshes are never evicted in production (`TileStreamer.evict` has no caller). The
  C# residency manager must release GPU meshes; see section 6.3.
- `fm2Constants.ts` comments say "+X = RIGHT" but the aircraft body +X is **port**.
- `AiPilot` finite-difference rates depend on delta; the port must use a fixed step.
- Comments in several files describe removed features. Trust the code.

## 3. Architecture

```
Unity project
|-- Packages/
|   |-- com.retro.core         double Vec3/Quat/Mat3, geodesy, FrameShift, constants (no UnityEngine dep)
|   |-- com.retro.sim          FM2, FM3, CombatSim, AI, weapons, collision, world query (no UnityEngine dep)
|   |-- com.retro.terrain-data manifest, tile index, codecs, TileStore, quadtree/LOD, height sampler
|   `-- com.retro.game         game state, spawn, carrier, camera updaters, recorder
|-- Assets/
|   |-- Rendering/   URP renderer features, HLSL includes, shaders, terrain renderer
|   |-- UI/          UI Toolkit settings, HUD rasteriser
|   `-- Scenes/      single bootstrap scene
`-- Tests/          EditMode tests, golden fixtures
```

Rules:
1. `core`, `sim` and `terrain-data` are plain C# assemblies with **no UnityEngine references**
   (`noEngineReferences: true`). They run in `dotnet test` and in Unity. This is what makes the
   golden tests cheap.
2. The sim runs on the main thread from `Update` with its own fixed-step accumulator (1/120 s).
   It does not use PhysX or `FixedUpdate`.
3. Terrain streaming and geometry generation run in Jobs; only `Mesh.SetVertexBufferData` and
   draw submission stay on the main thread.

## 4. Cross-cutting decisions (resolve these first)

### 4.1 Coordinates and handedness

- Scene axes in the TS code: x = east, y = up, **z = south** (right-handed). Aircraft body: +Z
  forward, +Y up, **+X port**. Unity is left-handed (z north).
- **Decision:** the sim, terrain data and all baked data stay in the original convention, in
  `double`. Conversion happens in exactly one place: the render boundary, where each draw gets a
  camera-relative matrix with z negated. Winding is flipped by the negative determinant (verify
  with `Graphics.RenderMesh`; fall back to flipping `Cull` in the shader).
- Never "fix" signs inside the sim piecemeal. FM2/FM3/AI signs are internally consistent
  (`physics/fm3/frames.ts` is the single mapping table).
- Headings: compass is `atan2(x, -z)`; AI heading is `atan2(fwd.x, fwd.z)`. Keep both and name
  them differently in C#.

### 4.2 Precision and floating origin

- Positions are `double` everywhere on the CPU. Unity `Transform` is float and is **not used**
  for terrain tiles, aircraft or anything planet-scale.
- Rendering is camera-relative: each frame compute `(objectOriginDouble - cameraDouble)`, cast to
  float, build the matrix, and submit with `Graphics.RenderMesh` / `RenderMeshInstanced`. This
  reproduces what `Renderer.submitCameraRelative` does today.
- The existing 20 km tangent-plane re-base (`FrameShift`, `worldRebase.ts`) is ported as is,
  because the ENU plane is only valid near its origin, not for float reasons. Everything that
  holds an ENU position must re-base: tiles, quadtree node centres, pads, colliders, AI, sim.
- Unity's `Camera` is placed at the origin each frame with the camera's rotation only.

### 4.3 Depth

The project relies on a logarithmic depth buffer (2 m near, 550 km to 3.2 Mm far), the
`uDepthPush` dissolve trick, and centimetre-level decal-over-terrain depth wins.

- **Decision gate (spike in M2):** reversed-Z float depth plus camera-relative origin, with
  explicit `Offset` per material replacing `polygonOffset`/`uDepthPush`. Measure z-fighting on
  roads, runways and the under-parent dissolve at 20 km and 100 km.
- Fallback if that fails: write `SV_Depth` with the same log function in every custom shader
  (disables early-Z; the TS game already pays this cost), or split near/far cameras.
- `SceneDepthPass` disappears: Unity provides `_CameraDepthTexture`.

### 4.4 Colour space

TS pipeline: bake bytes are sRGB, palette colours decode to linear, shaders write raw to an 8-bit
target, compose encodes at the end. Port as a **Linear** project, convert bake bytes with
`srgbToLinear` exactly where `terrainCover.ts:80` does, and compare palette swatches against the
web game with a screenshot diff in M3. This is easy to get subtly wrong.

### 4.5 Time stepping and determinism

- Flight models substep at fixed 1/120 s. Everything else in `CombatSim.step` currently uses a
  variable, clamped delta. **Decision:** the whole sim steps at fixed 1/120 s with an
  accumulator and render interpolation. Bit-matching the browser is not a goal; matching within
  tolerance on scripted inputs is.
- Use an ordered list, not a hash map, for aircraft (insertion order affects target tie-breaks).
- Seed the gun spread `Random`; it is the only sim-affecting random call.
- `Math.hypot`, `Math.sign(0)`, `Math.round` on negative halves differ between JS and C#; use
  helpers in `core` (`Js.Sign`, `Js.RoundHalfUp`, `Js.Hypot`).

### 4.6 Render pipeline: Unity's graphics framework (decided 2026-10-11)

**Decision (user, 2026-10-11): build the rendering on Unity's own graphics framework, not a
one-to-one port of the three.js renderer.** Concretely:

- **URP** (Universal Render Pipeline) with its standard Forward+ renderer. No custom SRP, no
  hand-rolled layer compositor, no log-depth shader chunk in every material.
- **Lighting:** a real directional light driven by the sun model (time of day), URP ambient
  (gradient or sky-based), URP shadows where they pay for themselves (aircraft, carrier, near
  buildings). Planform silhouette shadows are replaced by real shadow maps.
- **Materials:** URP Lit / Simple Lit / Unlit, or Shader Graph where a feature needs it
  (terrain colour modes, cover textures, dissolve). Palette categories become material
  properties or a palette texture, not per-draw uniform pokes.
- **Sky and fog:** URP skybox / procedural sky material driven by the existing CPU atmosphere
  model, URP distance fog (or a Volume-based height fog), URP post-processing (bloom for the sun,
  tonemapping, colour adjustments replacing the per-group colour sliders).
- **Anti-aliasing:** URP MSAA/SMAA/TAA and render scale instead of the mip-trick SSAA.
- **Transparency:** real alpha blending where it reads better (smoke, haze, glass, glare), not
  the Bayer-dither stipple that only works under SSAA.
- **Drawing:** GameObjects with MeshRenderer for aircraft, ships, airfields; `Graphics.RenderMesh`
  / `RenderMeshInstanced` (or BatchRendererGroup) for tiles, trees and particles; Unity
  `LODGroup` where it fits; VFX Graph or the Particle System for smoke and fire is acceptable.
- **HUD:** UI Toolkit / uGUI (Canvas). The bitmap fonts can stay as a sprite font to keep the
  look, but the HUD is no longer a software rasteriser into a texture.

Consequences:
- The look will be close to, but not pixel-identical with, the web game. Visual parity is judged
  by side-by-side screenshots, not per-pixel diffs; the golden tests stay for everything
  numeric (geodesy, codecs, LOD selection, flight models, AI).
- The retro-specific shader tricks (vertex pixel snapping, stepped fog, duotone, dither
  transparency, log-depth `uDepthPush`) are dropped unless a later art decision asks for them
  back as URP features.
- Precision is still ours to handle: Unity transforms are float, so the double-precision
  floating origin of 4.2 stays; the camera sits at the origin and objects are positioned
  relative to it each frame (or rebased every few km).
- Depth (4.3) becomes: URP reversed-Z with camera-relative positions, a near plane that grows
  with altitude, and per-material depth offset for decals (runway paint, roads). The log-depth
  fallback is only revisited if the M2 spike shows z-fighting URP can't solve.

## 5. Data delivery

The runtime reads `assets/terrain/` only (about 302k files, 17.6 GB on the dev machine:
`.ptm` 7.5 GB, `.pfl` 4.8 GB, `.pdm` 1.7 GB, `.ptx` 1.2 GB, `.ptr` 1.2 GB, `.pbd` 0.9 GB, rest
small; plus `manifest.json`, eight `index_*.bin`, `airfields.json`). `assets/planet/` is bake
source and never read. `.pbd1` files (0.6 GB) are bake temporaries and are not shipped.
`doc/terrain-hosting.md` still quotes ~3 GB / 38k files, which is out of date.

| Stream | Ext | Magic | Transport | Zoom |
|---|---|---|---|---|
| Mesh | `.ptm` | `PTM1` v6 | gzip | 0-12 |
| DEM | `.pdm` | `PDM1` | **zlib** | 0-11 |
| Far texture | `.ptx` | `PTX1` | gzip | 4-12 |
| Roads/rails | `.ptr` | `PTR1` v3 | gzip | 8-12 |
| Bridges | `.pbr` | `PBR1` v5 | gzip | 12 |
| Buildings | `.pbh` | `PBH1` v2 | gzip | 12 |
| Beds/walls | `.pbd` | `PBD1` v1 | gzip | 8-12 |
| Far land | `.pfl` | `PFL1` v1 | gzip | 12 |
| Index | `index*.bin` | `PIX1` | raw | n/a |

Full byte layouts are in the appendix. Gotchas: PTX x/y are `u16` while the rest are `u32`;
index bitmask is LSB-first; PBR v5 has trailing optional sections; `.pbd1` files in the tree are
bake temporaries.

**Recommendation:** read the existing tree directly from disk first (`FileStream` +
`GZipStream`/`ZLibStream` in a job). Defer any repack (single-file archive with an offset
table) until profiling shows 290k small files hurt; see open question 2.

## 6. Workstreams

Effort is a rough single-engineer estimate (weeks), +/- 40 percent. "Oracle" is the TS
implementation used to generate golden data.

### A. Core math and geodesy (2 w)
`utils/math.ts`, `terrain/geodesy.ts` (401), `terrain/tiling.ts`, `playArea.ts`, `FrameShift`.
Double `Vec3`, `Quat`, `Mat3`, `Mat4`; WGS84 geodetic/ECEF/ENU; `sceneFromEnu`;
`geodeticOnSurfaceAtEnu`; `FrameShift.between/point/vector/orientation/heading`.
Three.js semantics to reproduce: `Object3D.rotateX/rotateOnWorldAxis/translateZ/lookAt`
(FM2 kinematic mode), and `RigidBody.integrateAngular` right-multiply.
**Done when:** 100 percent of oracle conversion fixtures match to 1e-9 m.

### B. Terrain codecs and manifest (2 w)
Decoders for PTM, PDM, PTX, PTR, PBR, PBH, PBD, PFL, PIX1, manifest, airfields JSON.
Zero-copy `NativeArray` views over the inflated buffer (all sections are 4-byte aligned).
Parse-only: no Unity mesh yet.
**Done when:** every codec round-trips a fixture set (one tile per type per zoom band) and the
header and checksum of decoded arrays equals the oracle.

### C. Streaming, quadtree, LOD, budget (4 w)
`tileStore.ts` (byte-budget LRU, adaptive concurrency 6-32, retry, cancel), `tileStreamer.ts`
(want scoring, 4 ms upload pump), `quadtree.ts`, `lod.ts` (SSE governor, altitude to zoom curve,
`terrainViewRangeM`), `coarsenToBudget` (600k triangle cap, farthest-first folding), pinning,
speculative prefetch.
- Pure CPU, double math; ports cleanly. Rewrite the allocation-heavy parts (Frustum/Matrix4 per
  call, string-keyed maps, closures) as struct-based code.
- The margin-widened frustum widens a bounding sphere radius, not the planes; keep that.
- **Fix, don't copy:** implement GPU mesh release on eviction (the web version leaks).
**Done when:** for a scripted camera path, the set of drawn tile keys per reconcile equals the
oracle's, and the triangle total is within 1 percent.

### D. Terrain rendering (8 w)
`tileMesh.ts`, `terrainVP/FP/Cover`, `seamStitch.ts`, `farLandTiles.ts`, `coverTextures.ts`,
`oceanPatch.ts`, water.
1. Vertex layout: position `SInt16x4` (pad), normal `SNorm8x4`, colour/class `UNorm8x4`; land is
   a non-indexed soup. Alternative: `StructuredBuffer` + `DrawProcedural` to keep the 6-byte
   stride. Decide in the M2 spike.
2. One URP land material (Shader Graph or a URP-compatible HLSL shader using URP's lighting
   library, so it receives the main light, shadows, fog and ambient), per-tile data via
   `MaterialPropertyBlock` or an indexed structured buffer.
3. LOD transitions: URP's LOD cross-fade (dithered, `LOD_FADE_CROSSFADE`) replaces the custom
   leaf dissolve and the log-depth under-parent push; landuse size reveal stays as a material
   property.
4. Seam stitching: keep a CPU `NativeArray<short4>` copy, partial `SetVertexBufferData`.
   Alternative to evaluate: do the stitch in the vertex shader from a per-tile edge table,
   removing re-upload entirely.
5. Far land swap is "assign a different mesh"; port `followSeam` and the FNV fingerprint guard.
6. Cover textures: `Texture2D` point-filtered with hand-built mip chain (`SetPixelData` per
   level, `Apply(updateMipmaps:false)`).
7. Colour modes: Imagery, Swatch (24), Hybrid, Palette.
**Done when:** tile counts and the drawn cut match the oracle for scripted camera paths, and a
side-by-side screenshot over Gran Canaria reads the same (same land colours and coastline, no
holes or seams).

### E. Roads, rails, bridges, buildings, trees (8 w)
- Roads/rails (`roadStrokes`, `roadLod`, `riverVP`, `depthFP` rail detail): two verts per
  centreline point, widened in the vertex shader to a 0.9 px minimum; index-list levels at
  tolerances [0.25, 1, 4, 16] m; rail sleepers analytic with `ddx/ddy`. Draping is baked.
- Bridges (`bridgeMeshes`, PBR v5): role-split index lists, float boxes, hide by pixel size.
- Buildings (`buildingMeshes`, `buildingRoofs`, PBH): runtime extrusion is the heaviest CPU job
  (64 per step, 3 ms). Port as Burst jobs; roof triangulation replaces `THREE.ShapeUtils` with
  an ear-clipper job. Draw range by prominence, 300k triangle budget with rate-limited growth.
- Trees and clutter (`treeBillboards`, `stones`): deterministic scatter (hash01), 4x4 cells,
  shuffled prefix thinning, `RenderMeshInstanced`. Bake the SVG tree and stone atlases to PNG
  offline (biggest authoring task here).
- Exclusion masks (airfield, road, building, pad) with frame carry-through on re-base.
**Done when:** per-tile instance and triangle counts match the oracle for a fixed set of leaves.

### F. Flight models (5 w)
`physics/fm2/*` (2,036), `physics/fm3/*` (3,300 excluding reference tables), `fm2FlightModel`,
`fm3FlightModel`, `flightModel` base (1/120 accumulator, render interpolation), landing limits,
ISA atmosphere.
- Doubles throughout; FM3 core is already `Float64Array`, 13-state RK4, so it ports almost
  mechanically. Keep the 6 rad/s clamp and semi-implicit Euler in FM2.
- Do **not** fix known fidelity gaps (FM3 drag ~25 percent low at 25-40 degrees AoA, etc.).
- `defaultFm2Config` is what every aircraft flies; the config schema stays JSON-serialisable.
**Done when:** scripted-input traces (position, quaternion, velocity, omega at 1/120 s) match
the oracle to tolerance. FM3 is the better numeric golden; FM2 uses bands (see section 7).

### G. World query, collision, carrier, arrestor (4 w)
`WorldQuery`/`SceneWorldQuery`, `HeightSampler` (DEM bilinear, nodata, water check), `PadGrid`
(2000 m buckets), `RailBedField.clamp`, hill, ski jump, surface pad colliders, carrier deck
triangle soup (add an XZ grid; the TS does a linear scan), `aircraftCollision` (hull vs terrain,
pair contact, impulse solver), arrestor cables, hook placement, `triangleBvh`.
- Keep `-Infinity` for "no surface" (load-bearing).
- Float32 sites in the TS (BVH, DEM tiles, snapshots) are kept as float where they were, so
  contact results stay comparable.
- The carrier translates only; `trySnag` assumes the deck runs along +/-Z. Port as is, test it.
**Done when:** height-query fixtures (lat/lon to height, incl. pads and water) match, and the
existing belly, midair, targeting and arrestor scenarios pass in C#.

### H. AI pilots and weapons (4 w)
`AiPilot` (1,487) first, then Shaw, Aggressive, Ace; `dogfightGeometry` (pure, 22 tests, best
golden source); gun, pipper, projectile pool (480), faction targeting, wingman FORMATION.
- Seam is `PilotableAircraft` (same channel as the human): port as an interface.
- Fixed step changes finite-difference rate behaviour slightly; accept and re-tune only if a
  scenario regresses.
**Done when:** `dogfightGeometry` values match; the 86 AI tests port and pass.

### I. Aircraft and mods (3 w)
`aircraftRegistry`, `aircraftPack` (zip + `manifest.json`), `FlyableAircraftDef`, glTF models.
- Load glTF with glTFast. Material semantics come from the glTF material **name**
  (PaletteCategory, `#rrggbb`, GLASS, COLLISION): implement as a material remapper and keep the
  contract.
- Gear is a baked per-node clip named `{node}Action`, scrubbed 0..1; control surfaces are
  separate models posed by `pivot`/`axis`/`rangeRad`; wing sweep carries children.
- LOD by scene-name ordering; custom screen-width metric (reference 320 px, bias 3).
- 68 packs exist; start with the F-22 and `su33`.
- Alternative path (later): import original TCA prefabs with an Animator `GearUp` parameter.
**Done when:** F-22 and su33 load, gear scrubs, surfaces deflect with stick input.

### J. Sky, atmosphere, effects (6 w)
Sky dome (16x32 vertex-coloured, repainted on sun move), sun disc and glare (alpha-blended,
reads scene depth), atmosphere shell (full-screen analytic ray march for space), clouds
(icosphere lobes, 12-tier haze), cirrus, scenery field (9x9 tiles of 6 km), fog, palette system
(~100 categories, noon/midnight/night-vision, daytime blend), CPU atmosphere model (pure math,
ports 1:1), particles/smoke (4,800-puff instanced pool), wingtip trails, afterburner cones,
ship wakes, impact marks, planform shadows.
- Built on URP: directional light + skybox material driven by the CPU atmosphere model
  (ported 1:1), URP fog, post-processing Volume (bloom on the sun, tonemapping, colour
  adjustments). The space-view atmosphere shell becomes a full-screen pass in a small
  `ScriptableRendererFeature` (Render Graph) only if a skybox cannot do it.
- Clouds: meshes with a URP lit material and real alpha (or Shader Graph), not dither stipple.
- Smoke, fire, trails, wakes: VFX Graph or the Particle System; `RenderMeshInstanced` is the
  fallback if particle counts (4,800 puffs) cost too much.
- Target MFD view: a second URP camera rendering into a `RenderTexture` at half resolution.
**Done when:** a day, dusk and night screenshot set reads like the web game side by side.

### K. HUD / OSD (4 w)
Canvas2D today (`canvasPainter`, `text`, 320x200 logical grid, bitmap fonts 3x5/5x8/7x11).
**Decision (follows 4.6):** Unity UI (UI Toolkit or uGUI Canvas) with the three bitmap fonts as
sprite fonts; ladder, tapes and symbology drawn with UI Toolkit `Painter2D` or uGUI meshes. The
layout logic (320x200 grid, scales, focus modes) ports as plain C#. Entities: HUD (1,066),
cockpit MFDs (679), moving map, approach aids, perf HUD, exterior data, units.
**Done when:** every HUD element is present and reads the same values as the web game for the
same flight state.

### L. Settings, boot and spawn UI (4 w)
Angular Material dialog becomes UI Toolkit (UXML/USS): eight tabs (Flight, Graphics, Colours,
World, Simulation, General, Help, About), about 20 observable settings. Boot progress and
countdown, spawn panel, airfield picker, place and coordinate search (Nominatim on Enter only,
at least 1.1 s between requests, descriptive User-Agent), camera-pose startup argument,
settings persistence as one JSON file. Full option list in appendix C.

### M. Input and audio (1 w)
Unity Input System. Port `simPlayerInput` (pitch-stick unit ramps, throttle detents, wheel
brake override), keyboard layouts as presets, one gamepad (axes 0 roll, 1 pitch, 2 throttle
inverted, 3 yaw; no buttons or hats in the web game). Audio is two looping OGGs
(engine in/out) with rate and gain driven by throttle: two `AudioSource`s and a master volume.
There are no other sounds today, so sound design is out of parity scope.

### N. Crash, wreck, damage (5 w)
`wreckField` (2,986), `airframeDamage` (146), `damageSmokeField` (1,910), `debrisField`,
`impactMarks`, `landingLimits`. Mostly render-side, no feedback into physics. CPU geometry
slicing ports to C# over `Mesh` arrays, ideally with jobs. About 110 unit tests exist (node:test)
and serve as the spec. Highest CPU-geometry risk in the scene layer; schedule late.

### O. Game state, camera, integration (4 w)
Sim-relevant slice of `game.ts` (spawn placement, carrier advance/sync, `setupCombat`,
opponent/wingman spawn, building colliders, rebase), `GameState`/`PlayerViewState`, 14 camera
updaters, flight recorder (30 Hz, 600 s ring), airfield streaming (50 km), `Kernel` loop and FPS
cap. `game.ts` is 5,361 lines; do not port it whole: split by responsibility.

### P. Performance and polish (6 w, spread across phases)
Burst/jobs for building extrusion, scatter, road simplification, stitching; GPU memory
residency; shader variant stripping; profiling against the web game's draw-call and triangle
budgets (480 draw calls, 600k terrain triangles, 300k building triangles).

**Total: about 70 engineer-weeks.** One person is roughly 14 to 18 months; two to three people
roughly 6 to 9 months, since C/D/E (terrain) and F/G/H (sim) are largely independent.

## 7. Verification strategy

1. **Golden harness in TS (build first, no Unity needed).** A script that dumps fixtures from
   the oracle to JSON/binary under `tests/golden/`:
   - geodesy and `FrameShift` conversions on a lat/lon grid;
   - decoded-codec checksums per tile type;
   - quadtree cut and triangle totals for scripted camera paths;
   - height queries (including pads, water, rail beds);
   - FM2 and FM3 traces for scripted inputs at 1/120 s (existing `tools/fm3` scenarios seed
     these);
   - `dogfightGeometry` and AI decisions on scripted scenarios;
   - arrestor, belly-landing, midair scenarios.
2. **EditMode tests in Unity** (and `dotnet test` for the engine-free assemblies) compare
   against the fixtures with explicit tolerances.
3. **Behavioural tests:** the 207 physics, 86 AI and 64 state tests are tolerance-band tests.
   Port them as regression tests; do not treat them as numeric goldens.
4. **Visual diffs:** fixed-camera screenshots (terrain, sky, HUD, aircraft) compared against the
   web build. Dithered regions are masked; AA and SSAA parameters must match first.
5. **Perf budgets** recorded per milestone against the web numbers above.

## 8. Phased milestones

| # | Milestone | Streams | Exit criteria |
|---|---|---|---|
| M0 | Golden harness and repo scaffold | A, tests | Fixtures generated; empty Unity project with assemblies compiles; CI runs the engine-free tests |
| M1 | Data and math | A, B | All codecs and geodesy match the oracle |
| M2 | **Spike: one area on screen** | C (min), D (min), depth decision | Gran Canaria renders with basic LOD, camera-relative, handedness fixed, depth strategy chosen, vertex layout chosen |
| M3 | Terrain parity | C, D | Tile cut and screenshot match; dissolve, seams, far land, cover textures; memory lifetime correct |
| M4 | Fly | F, G, O (min), M | Fly FM2 and FM3 over terrain, land on a runway, crash on terrain, gear and surfaces animate (F-22) |
| M5 | World detail | E, I | Roads, rails, bridges, buildings, trees; mod packs load; airfields |
| M6 | Sky and effects | J | Sky, atmosphere, clouds, fog, sun, particles; palette and day/night |
| M7 | Combat | H, G (carrier) | AI pilots, gun, targeting, carrier ops, arrestor |
| M8 | HUD and UI | K, L | HUD, MFDs, settings, spawn search, boot flow |
| M9 | Crash and polish | N, P | Wreck system, performance pass, parity checklist |

M2 is the real risk-retirement gate: it answers depth, vertex format, handedness and
floating-origin questions on the smallest possible slice. Do not start M3 or E until M2 is
signed off.

## 9. Risk register

| Risk | Rank | Mitigation |
|---|---|---|
| Depth precision (550 km to 3.2 Mm range, decal wins) | High | M2 spike; log-Z fallback in HLSL; split cameras |
| Floating origin and re-base consistency across tiles, sim, AI, pads | High | Single `FrameShift` implementation; every position holder implements `IRebasable`; test with forced re-bases |
| Colour space / palette fidelity | Medium | Screenshot diff on palette swatches in M3 |
| Terrain geometry jobs (buildings, trees, road LOD) cost and GC | Medium | Struct-based Burst jobs; budgets measured per milestone |
| Seam stitching with separate GPU copy | Medium | Vertex-shader stitch evaluated in M2 |
| Wreck geometry slicing port | Medium-High | Scheduled last; ~110 tests as spec |
| Look drifts from the web game under URP lighting | Medium | Side-by-side screenshot reviews per milestone; palette as material data so colours can be tuned without code |
| Non-deterministic sim vs oracle | Medium | Fixed step; tolerance bands; FM3 numeric goldens |
| Data volume (17.6 GB, ~302k files) | Medium | Direct reads first; repack decision after profiling |
| Handedness mistakes | Medium | One conversion point; assertions in debug builds |
| Scope creep from "improve while porting" | High | Parity first; fidelity gaps stay (documented in `fm3-physical-flight-model.md`) |

## 10. Open questions for you

1. **Target platforms.** Windows desktop only, or also Linux/Mac, consoles, mobile? The web
   game has no touch, mobile or Android input code (only keyboard and a first-gamepad joystick
   device), so mobile would be new work. This drives shader model, IL2CPP and data delivery.
2. **Data delivery.** Ship all 17.6 GB, a regional subset (Gran Canaria + DACH + Krim), or stream
   from a server like the web game does (R2)? Decides whether a repack is needed.
3. **Keep the web game?** Continue developing it in parallel (feature changes then need porting
   twice) or freeze it once Unity reaches M4?
4. **Tooling.** Is Unity 6 (URP) acceptable, or is there a version constraint? HDRP is not
   recommended for this look.
5. **Mod authoring.** Keep the glTF + `manifest.json` pack format, or move authoring to Unity
   prefabs and an Animator (closer to TCA)?
6. **Team.** One developer or several? Determines whether sim (F, G, H) and terrain (C, D, E)
   run in parallel.

## Appendix A: terrain binary layouts

All little-endian. Sections are 4-byte aligned. Version bytes are enforced.

**Tile addressing.** Plate Carree quadtree over WGS84. Level z has `2^(z+1)` columns and `2^z`
rows; x increases east from lon -180, y increases **south** from lat +90. Span is `180/2^z`
degrees; `west = -180 + x*span`, `north = 90 - y*span`. Path template `{z}/{x}/{y}.<ext>`.
Missing tiles are synthesised as sea patches.

**PIX1 index.** `u32 magic "PIX1"`, `u16 minZoom`, `u16 maxZoom`, then per level 16 bytes
`u32 minX, minY, w, h`, then per level `ceil(w*h/8)` bitmask bytes. Bit `i=(y-minY)*w+(x-minX)`,
LSB first. `w=h=0` means empty level.

**PTM1 (v6), 72-byte header:**

| Off | Type | Field |
|---|---|---|
| 0 | u32 | `PTM1` |
| 4 | u8 | version = 6 |
| 5 | u8 | z |
| 6 | u16 | flags: bit0 land, bit1 water, bit2 rivers, bit3 GRADED |
| 8 | u32 | x |
| 12 | u32 | y |
| 16 | f32 | centerHeightM |
| 20 | f32 | quantScale (m per int16 unit, all axes) |
| 24 | u32 | borderBytes |
| 28 | f32 | boundingRadiusM |
| 32 | u32 | landVertCount (multiple of 3) |
| 36 | u32 | waterVertCount |
| 40 | u32 | waterIndexCount |
| 44 | u32 | riverVertCount |
| 48 | u32 | riverIndexCount |
| 52 | u32 | skirtSeamFactor |
| 56 | u32 | waterDeepIdx |
| 60 | u32 | waterShallowIdx |
| 64 | f32 | skirtDepthM |
| 68 | f32 | geometricErrorM |

Payload, each section padded to 4 bytes: `landPos i16x3`, `landNrm i8x4` (xyz/127 + pad),
`landAttr u8x4` (r, g, b sRGB, TerrainClass 0..15), `waterPos i16x3`, `waterTone u8`,
`waterIdx u16x3`, `riverPos i16x3`, `riverDir i8x4` (4th byte: stroke kind), `riverHalf u16`
(decimetres), `riverIdx u16x3`, optional border table (`u32 vertexCount, u32 edgeCount`,
`u32 vertices[]` side in top 2 bits W0 E1 N2 S3 + index in low 30, `f32 vertexParams[]`,
`u32 edges[]`, `f32 edgeParams[]`).
Frame: offsets from the tile-centre ENU point in the bake ENU axes (x E, y U, z S); position =
value * quantScale; place by translation + `frameFix` rotation when runtime basis differs.

**PDM1, 24-byte header:** `char[4]`, `u16 size (257)`, `u8 flags`, `u8 pad`, `f32 minH`,
`f32 maxH`, `f32 quantScale`, `f32 geometricErrorM`; then `size*size` `u16` row-major, row 0 =
north, col 0 = west. `height = minH + q*quantScale`; `0xFFFF` = nodata. File is **zlib**.

**PTX1, 16-byte header:** `u32 magic`, `u8 version=1`, `u8 z`, `u16 reserved`, `u16 x`,
`u16 y`, `u16 size`, `u16 reserved`; then RGBA8 `size*size`, alpha byte is TerrainClass,
255 = no data. Row 0 north. Grid is lon/lat over the tile box, not metres.

**PTR1 (v3), 24-byte header:** magic, `u8 ver`, `u8 z`, `u16 flags` (bit0 graded), `u32 x`,
`u32 y`, `f32 quantScale`, `u16 vertCount`, `u16 triCount`. Payload: `pos i16x3`, `dir i8x4`
(4th byte RoadClass, `0x40` side bit, mask `0x3f`), `half u16` (dm), `along u16` (0.05 m,
wraps 3276.8 m, v>=2), `flags u8` (v>=3), `idx u16x3`. Classes: 0 Motorway .. 6 Residential,
7 Rail, 8 RailService, 9/10 zone (not drawn), 11 Crossing.

**PBR1 (v5), 24-byte header:** magic, ver, z, `u16`, `u32 x`, `u32 y`, `f32 quantScale`,
`u16 vertCount`, `u16 triCount`. Base: `pos i16x3`, `nrm i8x4` (4th byte = role | (tier+1)<<4,
roles 0 Deck, 1 Concrete, 2 RailDeck, 3 SignRed, 4 SignWhite, 5 SignPost), `idx u16x3`.
v2: track strokes; v3: `u32 boxCount` + 16 f32 each; v4: `u32 rampCount` + 4 f32 each;
v5: `u32 endCount` + 7 f32 each.

**PBH1 (v2), 64-byte header:** magic, ver, z, `u16`, `u32 x`, `u32 y`, `f32 x9` (axes a, b, up),
`u32 buildingCount`, `u32 ringCount`, `u32 vertCount`. Point (u,v,h) = `u*a + v*b + h*up` from
the tile centre. 20-byte building records: `u32 firstRing`, `i16 base` (0.1 m), `u16 eave`,
`u16 ridge`, `u16 ridgeAngle` (0..65536 = 0..2 pi), `u8 roofForm` (1 Flat, 2 Gabled, 3 Hipped,
4 HalfHipped, 5 Skillion, 6 Pyramidal), `u8 roofTone`, `u8 wallTone`, `u8 ringCount`, `u8 flags`
(1 no walls, 2 roof RGB valid), `u8 rgb[3]`. Then `u8 ringSizes[]`, then `i16 u, i16 v` in
0.25 m steps. First ring CCW outline, later rings CW courtyards.

**PBD1, 32-byte header:** magic, ver, z, `u16`, `u32 x`, `u32 y`, `f32 quantScale`,
`u32 bedCount`, `u32 wallVertCount`, `u32 wallIndexCount`. 20-byte bed: `i16 A[3]`,
`i16 B[3]`, `u16 halfWidth` (cm), `u16 lift` (cm), `u8 openFlags`, `u8 tier`, `u16 batter` (cm).
Walls: `i16x3` positions, `i8x4` normals, `u32` indices.

**PFL1, 32-byte header:** magic, ver, z, `u8 levelCount`, `u8 pad`, `u32 x`, `u32 y`,
`f32 quantScale`, `u32 nearTriangles`, `u32 nearFingerprint` (FNV-1a over near int16 positions,
seam moves reverted), `u32 reserved`. Per level (finest first): 16-byte header
`f32 toleranceM, u32 triangles, u32 borderPairs, u32 pad`, then `i16x9`/tri positions,
`i8x12`/tri normals, `u8x12`/tri attrs, `u16x3`/tri regionSizes, `u32x2` borderMap.

## Appendix B: key numbers to preserve

| Constant | Value | Source |
|---|---|---|
| Fixed sim step | 1/120 s | `flightModel.ts:7` |
| Max pump delta | 1/30 s, 0.2 s pending cap | `combatSimClient.ts` |
| Gravity | 9.80665 m/s^2, -Y | |
| Terrain triangle budget | 600,000 | `lod.ts:257` |
| Building triangle budget | 300,000 | `buildingMeshes.ts` |
| SSE target | 1 px x detailScale (1..4) | `lod.ts` |
| Reconcile interval | 100 ms | `terrainEntity.ts` |
| Upload budget | 4 ms/frame | `lod.ts:271` |
| Re-base distance | 20 km | `game.ts` `REBASE_DISTANCE_M` |
| Camera near / far | 2 m / 550 km to ~3.2 Mm | `game.ts:750` |
| Projectile pool | 480, life 2.5 s | `combatSim.ts:62` |
| Max aircraft | 16 | `simSharedState.ts` |
| Smoke pool | 4,800 puffs | `damageSmokeField.ts` |
| HUD logical grid | 320 x 200 | `defs.ts` |
| Tile mesh cache | 256 MB | `lod.ts:311` |

## Appendix C: UI, input, audio, mods

### C.1 Settings (UI Toolkit tabs)

Persisted as one JSON blob (`retroflightsim.settings` in `localStorage` today; a file under
`persistentDataPath` in Unity). Each field is validated individually with a per-field default.

| Tab | Options | Settings key |
|---|---|---|
| Flight | Aircraft list; livery (if >1); find airfield or place (airfields live, places on Enter); airfield select; start buttons Approach(1), Runway(2), Head-on(3), Carrier land(4), Carrier TO(5), 10 km(6), Space(7), Wingtip(9) | `aircraftId`, `spawnMode` |
| Graphics | Render scale [1, .9, .8, .7, .6, .5]; SSAA; terrain detail distance (km, top = Off); land-use reach; finest terrain level (z); land-use region size (px); triangle cap; far tile textures; buildings; roads (ALL/MAJOR/OFF); terrain colour (LANDCOVER/SWATCH/HYBRID/IMAGERY); land-use blend; tree density 0-20x; shading (FACETED/SMOOTH) | `renderScale`, `supersampling`, `terrainDetailDistanceM`, `landuseReach`, `visibleZoom`, `landuseRevealPx`, `terrainTriangleBudget`, `farTileTextures`, `buildings`, `roads`, `terrainColour`, `landuseBlend`, `treeDensity`, `terrainShading` |
| Colours | Hue, saturation, brightness sliders for trees, terrain, water, sky; reset | `colourAdjust` |
| World | Area select ("Fly here" reloads); importer (dev only, not in player build) | `terrainArea` |
| Simulation | Time of day 0-23.75 h; flight model FM2/FM3/Debug; AI pilot model CLASSIC/SHAW/AGGRESSIVE/ACE | `daytime`, `flightModel`, `aiPilotModel` |
| General | Volume; units METRIC/IMPERIAL (not persisted today, persist it); keyboard layout; pitch stick mode | `volume`, `keyboardLayout`, `keyboardPitchStickMode` |
| Help | Live-relabelled key table, detected joystick name and axis count | n/a |
| About | Data-source credits and licence links (`DATA_SOURCES`, ODbL, CC BY 4.0, CC BY-NC-SA 4.0, dl-de/by-2-0, dl-de/zero-2-0). FABDEM is non-commercial; this matters for any Unity distribution | n/a |

Opening the dialog pauses the sim; closing resumes it. Keys are routed away from the game while
it has focus. Defaults: `techProfile` HD, `flightModel` FM2, `keyboardLayout` ARROWS,
`terrainColour` HYBRID, `terrainShading` FACETED, `aircraftId` f22, `spawnMode` headon,
`roads` ALL, `renderScale` 1, `supersampling` false, `volume` 0.7.

### C.2 Input

Devices: keyboard and the first connected gamepad. No mouse flight, touch or pointer lock.
Mouse is used only for showcase-view part picking, the land-cover tooltip, and the map.

| Layout | Pitch+ (pull) | Pitch- | Roll+ | Roll- | Yaw+ | Yaw- | Throttle+ | Throttle- |
|---|---|---|---|---|---|---|---|---|
| QWERTY | s | w | d | a | e | q | z | x |
| QWERTZ | s | w | d | a | e | q | y | x |
| AZERTY | s | z | d | q | e | a | w | x |
| DVORAK | o | , | e | a | . | ' | q | j |
| ARROWS | down | up | right | left | x | y | Num+ | Num- |

- Pitch stick modes: LAYOUT_DEFAULT (stepped latched stick on ARROWS, ramp 10 to 80 units/s,
  accel 120/s^2; full deflection while held on letter layouts) and HOLD. Pitch travel is
  asymmetric: 20 forward / 80 aft units.
- Wheel brake `W`, held, only on the ground; overrides pitch-neg/throttle on letter layouts.
- Sim keys: `F` flaps, `G` gear, `B` airbrakes, `H` tailhook, `L` FCS limiters, `A` autopilot,
  `1/2/3` pitch limiter SOFT/PREDICTIVE/SMOOTH, `Space` gun (held).
- Main-thread keys: `T` cycle target, `I` target night view, `U` HUD focus
  (DISABLED/PARTIAL/FULL), `V` force vectors, `M` moving map, `4` target view, `Tab` debug
  debris, `N` wing sweep and day/night flip (one press does both today; likely unintended).
- Views: F1 cockpit (twice = padlock), F2 exterior, F3 carrier, F4 replay, F6 AI chase, F8
  wireframe, F12 showcase, Esc menu, numpad orbit and zoom.
- Replay: Space pause, `,` `.` seek 5 s, `[` `]` speed, Home restart, Esc exit.
- Gamepad axes: 0 roll, 1 pitch, 2 throttle (inverted), 3 yaw. No buttons or hats.
- Known bugs not to port: F9 is bound twice (perf-HUD toggle unreachable); Help lists `7` as
  400 km but `SPACE_ALTITUDE_M` is 100 km; Help omits `9`.

### C.3 Audio

Two looping clips only: `engine-loop-02.ogg` (cockpit/in, 55 KB) and `engine-loop-01.ogg`
(exterior/out, 33 KB). Swapped by view; stopped on crash. `rate = 0.25 + 1.75 *
easeOutQuad(throttle)`, `gain = easeOutQuint(throttle)` with a floor once started. Master
volume 0..1. No SFX, no 3D audio, no mixer groups.

### C.4 HUD and boot overlays

- Bitmap fonts: `font-hud-small` 3x5, `-medium` 5x8, `-large` 7x11 (A-Z, 0-9, `. : -`), tinted
  per palette colour; effects NONE/BOLD(shadow). Layout is authored on a 320x200 grid.
- HUD elements: pitch ladder, altitude and heading and airspeed tapes (with focus-mode
  variants), vertical velocity, throttle, AP flag, flight-data indicators (G, AoA, Mach), AoA
  indexer (carrier on-speed 8.0-8.5 degrees), stick indicator, gun reticle and pipper, ILS
  (3 degree glideslope, carrier approach 137 KIAS), flight-path marker, stall warning, target
  box, perf line.
- Cockpit: attitude indicator, MFD1 tactical scope (ranges 5/10/20/40/80 km, default 20, moving
  map underlay), MFD2 target telemetry plus zoomed target camera (render texture), gear/flaps/
  hook status.
- Boot: "Initializing renderer 5" -> "Loading aircraft packs 15" -> "Building scene 25" ->
  "Loading aircraft 90" -> terrain 90-99 -> "Ready 100" -> "Streaming terrain N%" until the tile
  queue stays empty, then a countdown.
- Runtime DOM bits to rebuild: replay bar (buttons, scrubber, time, speed), land-cover tooltip
  (2 s mouse rest), showcase part labels, mod-status line.

### C.5 Spawn search, camera URL, reload flow

- Local airfield search: accent-folded, all words must match `icao iata name`; scores: exact
  ICAO/IATA 1000, word-prefix +50, name word start +20, else +5; ties to longer runway; limit 12.
- Coordinates: `lat, lon` decimal degrees with optional N/S/E/W and degree sign.
- Nominatim: Enter only, `limit=8`, `format=jsonv2`, minimum 1100 ms between requests, stale
  response token. Results outside baked areas are shown disabled ("no terrain baked here").
- Destination kinds: airfield, place, coordinates. Place/coordinate spawn is airborne at a
  fixed AGL heading north.
- Camera URL: `?@lat,lng,altA,hdgH,tiltT` (also `#`); `t` 0 = straight down, 90 = horizon,
  `pitch = t - 90` clamped to +/-89; rewritten every 0.5 s (fixed camera) or 1 s (flight).
  Legacy `?lat=&lng=&alt=&hdg=&pitch=`. In Unity: a start-pose command-line argument.
- Cross-area picks reload the page through `sessionStorage` today; in Unity switch area by
  rebuilding the world or re-basing, which removes the hack.

### C.6 Mods

- Source: Tiny Combat Arena Unity AssetBundles. `tools/import_mod.py` (3,655 lines) extracts
  meshes and per-polygon colours, writing `<id>.aircraft.json` + glTF files.
- Manifest keys: `id, name, displayName, canonicalName, category, description, tags, sourceMod,
  sourceModId, sourceMaterial, importMeta, body, shadow, gear, gearAnimated, static, collision,
  collisionMesh{triangles,aabb}, surfaces[], fx{nozzles,nozzleRadius,wingtips},
  attachments[], cockpitOffset, spawn, groundOffsetY, groundRestHeightM, flight`.
- Surface `control` values: pitch, roll, yaw, flaps, slats, airbrake, sweep, flaperonLeft/Right,
  stabilatorLeft/Right. Optional `swingWings {minKias, maxKias, travelSeconds}`.
- Pack: a ZIP of `manifest.json` + flattened glTF/bin by basename; paths rewritten pack-relative.
  Loaded via `pack:<id>/<file>` URLs. Excluded ids: `a4e`, `f16`.
- Model/livery grouping by `canonicalName ?? id`. Speedbrake surfaces with `control=flaps` are
  remapped to `airbrake`.
- On this machine: 67 import manifests (about 617 MB `.bin`), 68 packs (about 106 MB, largest
  3.6 MB). Only the built-in F-22 and `su33` ship in `assets/`; the web game lists the rest only
  through the dev server's `/api/aircraft-packs`.
- Port options: keep the pack format (glTFast + `System.IO.Compression`) or author in Unity
  prefabs with an Animator `GearUp` parameter, which is closer to the source mods.

### C.7 Shipped assets (tracked, 817 files)

F-22 `.glb` set (body, shadow, gear, six surfaces, scenery, static; about 330 KB total), su33
loose glTF set plus 778 `.bin` buffers (75 MB, mostly `su33_static`), scenery glTFs (control,
farm, hangar, refinery x3, runway), `samradar01.glb`, `kuz.glb` (carrier), two OGGs, three
bitmap-font PNGs. No other textures: colours are flat palette values and tree/stone atlases are
generated at runtime from SVG (must be baked to PNG for Unity).

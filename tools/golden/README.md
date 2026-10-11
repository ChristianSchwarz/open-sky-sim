# Golden fixtures for the Unity port

The TypeScript game is the reference implementation ("oracle") for the C#/Unity
port described in `docs/unity-port-plan.md`. This generator records what the
oracle computes for a fixed set of inputs; the port's tests replay the same
inputs and compare. The fixtures live in `tests/golden/` and are committed.

```bash
npm run golden:generate        # regenerate tests/golden from the current code
npm run golden:check           # fail if the code no longer matches the fixtures
npm test                       # includes tools/golden/golden.test.ts
node --import tsx tools/golden/generate.ts --select-tiles   # re-pick tile files from assets/terrain
node --import tsx tools/golden/generate.ts --only geodesy,tiling
node --import tsx tools/golden/generate.ts --select-road-tiles  # re-copy only tiles/roads/
```

## Rules

- Inputs are deterministic: seeded `Rng` (mulberry32), never `Math.random`.
- A fixture change is a contract change. If `golden:check` fails, either the
  oracle changed on purpose (regenerate, review the diff, port the change to
  C#) or something regressed (fix it).
- Tile files are copied into `tests/golden/tiles/` so the suite is hermetic:
  neither the generator nor the C# tests need the 17 GB `assets/terrain` tree.
  `--select-tiles` is the only thing that reads it, and `--check` never does.

## File format

All files are JSON written by `stringify()` in `lib.ts`: keys in insertion
order, primitive arrays on one line, non-finite doubles as the strings `"NaN"`,
`"Infinity"`, `"-Infinity"`. Each file has `suite`, `version`, `source` (the
oracle files), `notes` (conventions the port must follow) and `tolerances`.

Decoded typed arrays are described, not dumped:
`{type, length, fnv1a32, head}` where `fnv1a32` is FNV-1a (32 bit) over the
array's raw little-endian bytes and `head` is the first few elements.

`tests/golden/manifest.json` lists every file and asset with a SHA-256.

## Suites

| File | Oracle | Covers |
|---|---|---|
| `geodesy.json` | `terrain/geodesy.ts` | WGS84 <-> ECEF, ENU bases, scene axes (z = south), surface solve, `FrameShift` for re-base |
| `tiling.json` | `terrain/tiling.ts` | Plate Carree quadtree: bounds, parent/children, lon/lat lookup incl. exact edges, ranges |
| `codecs.json` + `tiles/` | `terrain/{ptm,pdm,ptx,ptr,pbr,pbh,pbd,pfl,tileIndex,demTile}.ts` | 32 real tiles across zooms, 8 PIX1 indices, PDM bilinear/nearest samples |
| `dogfight_geometry.json` | `ai/dogfightGeometry.ts` | Energy height, closure, tracking/aspect/angle-off, intercept time, ballistic aim, miss distance |
| `flight_models.json` | `physics/model/{fm2,fm3}FlightModel.ts` | 26 scripted traces at 1/120 s, sampled at 20 Hz: cruise, roll, pitch, yaw, configuration, limiters off, stall, ground idle, takeoff, graded touchdowns, FM3 post-stall |
| `ai_pilots.json` | `ai/{aiPilot,createAiPilot,shaw,aggressive,ace}` | 34 closed-loop traces at 60 Hz (sampled 20 Hz): all four pilot models through six engagements, skill tiers, ridge avoidance, navigate/straight/climb-out/RTB/approach/formation |
| `terrain_lod.json` | `terrain/{lod,quadtree,culling}.ts` | lod.ts functions, horizon culling, and quadtree draw/want lists along 6 camera paths (low pass, turn in place, leaves loading, climb, re-based Alps, 400 km orbit) |
| `heights.json` + `tiles/height/` | `terrain/{heightSampler,flattenPad,demTile}.ts` | 651 ground queries around GCLP across the fine (z11), coarse (z7) and empty tiers, with the 33 manifest flatten pads; pad blend/surface checks |
| `combat_sim.json` | `physics/sim/combatSim.ts` and its colliders, player input, guns | 12 scenarios at 60 Hz: AI duels, AI vs a firing player, keyboard takeoff, belly landings (fm2/fm3, mesh, fatal), arrestor trap, mid-air, roof landing, wingman formation |
| `roads.json` + `tiles/roads/` | `terrain/{roadStrokes,roadLod,roadExclusion,bridgeMeshes}.ts` | 6 .ptr and 4 .pbr tiles (Gran Canaria z8/z10/z12, DACH z12 with rails, switch zones, deck track, crossing furniture): stroke split by kind, far road levels in order and lazily out of order, the trees' road mask at 4800 probes, bridge role split, furniture boxes, bounding spheres |
| `flight_configs.json` | `physics/fm2/fm2AircraftConfig.ts`, `physics/fm3/f16Airframe.ts` | The exact config numbers the traces used |

## Not covered yet (later milestones)

- Rail-bed clamping in height queries (needs RailBedField and its BandResolver):
  workstream G.
- Triangle-budget folding (coarsenToBudget) and streaming priorities: workstream C, with the terrain entity.




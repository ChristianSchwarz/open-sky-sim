# Unity port: parity checklist

Status 2026-10-11, branch `unity-fe`, after M9. Built from the feature inventory in
`docs/unity-port-plan.md` (workstreams A-P, appendix C) by auditing the Unity layer
(`unity/Packages/com.retro.unity`) against the web game (`src/script`). Engine-free code that is
ported and golden-verified but not yet called from the Unity layer counts as **missing** here:
parity is what a player sees.

Legend: **done** = present and checked; **partial** = present with a named gap; **missing** =
not in the Unity build; **dropped** = deliberately not ported (plan section 2).

Short paths: `U/` = `unity/Packages/com.retro.unity/Runtime/`, `G/` = `.../com.retro.game/Runtime/`,
`TD/` = `.../com.retro.terrain-data/Runtime/`.

## Summary

Rows, not settings or keys: one row can cover several.

| Area | Done | Partial | Missing |
|---|---|---|---|
| Simulation | 11 | 2 | 0 |
| Terrain | 10 | 1 | 3 |
| World detail | 12 | 0 | 0 |
| Sky and FX | 8 | 2 | 5 |
| Aircraft | 3 | 1 | 2 |
| HUD and cockpit | 12 | 1 | 1 |
| Settings | 12 | 2 | 0 |
| Input, views, replay, audio | 6 | 3 | 4 |
| Boot and spawn | 3 | 1 | 1 |
| **Total** | **77** | **13** | **16** |

What is missing most visibly, in suggested order:
1. ~~Engine audio~~ and ~~replay (F4)~~: done since the checklist was written (see the Input table).
3. ~~Building and scenery colliders, and the glTF scenery~~: done since (see World detail).
4. ~~Target cycling (T)~~ and the ILS: done since (see HUD and cockpit).
5. ~~Settings that are only stored~~: done since (see Terrain and Settings).
6. **Terrain**: runtime seam stitching, far land (`.pfl`), rivers.
7. **Space view**: the atmosphere shell and stars are missing, and so is the sun-visibility skyline.
8. **Debug and showcase views**: F8 wireframe, V force vectors, Tab debug debris, F12 showcase and the land-cover tooltip.

## Simulation

| Feature | Status | Evidence / gap |
|---|---|---|
| FM2 + FM3 flight models, switch in flight | done | 26 golden traces; `U/Flight/PlayerFlight.cs` `SetAircraftConfig`; FM3 swap verified in flight |
| Ground contact, landing limits, wheel brake | done | `combat_sim.json` golden; takeoff from GCLP 03L |
| Combat sim, gun, projectiles, faction targeting | done | 12 golden scenarios; a 1 s burst kills the opponent |
| AI pilots (4 models), opponent + wingman | done | 34 closed-loop traces bit-identical; `U/Flight/Combat.cs` |
| Carrier: berth, steaming, deck collider, arrestor, tailhook | done | trap on wire 1 verified |
| Hill / ski-jump colliders | done | the ski jump on the base runway (see World detail); the web sends no hills either |
| Building colliders (surface pad + obstacle per building, streamed) | done | `G/Airfield/AirbaseLayout.cs` BuildingCollider (7 tests), `U/Flight/AirfieldColliders.cs`: fields within 50 km of the start at boot, then one at a time in flight once their fine ground is resident, sent with `AddStaticColliders`; an aircraft under a new roof leaves that building hollow. Verified: a flight into a GCLP terminal crashes at its wall; Tenerife's 6 buildings streamed in 31 km out. Kept from the web: a building's AI cylinder stands on its own roof (obstacleBaseY reads the pads) |
| Runway pads streamed as you fly | partial | built once at boot within 150 km; the web streams airfields within 50 km |
| Wreck field, crash break-up, fires, fuel lake, sea, deck | done | `wreck.json` 98 tests; seen on screen |
| Survivable airframe damage | done | injected scrape on the F-22, repair on respawn (`ece2e00c`) |
| Damage smoke, debris, impact marks | done | golden suites; seen on screen |
| Sim step and frame pacing | partial | Unity catches up in steps of at most 1/30 s; the web drops backlog over 0.2 s. Neither has render interpolation |
| Floating-origin re-base (20 km) | done differently | Unity draws camera-relative in doubles (`SceneFrame`), so there is no float-precision problem; `WorldRebase` is ported but uncalled. The web re-base also corrects the tangent-plane tilt far from home, and Unity does not yet. Check this on a long flight |

## Terrain

| Feature | Status | Evidence / gap |
|---|---|---|
| Streaming, quadtree LOD, 600k budget fold | done | `TD/Streaming/TerrainSession.cs`; drawn cut golden-verified |
| GPU mesh release on eviction | done | `U/Terrain/TerrainRenderer.cs` (the web leaks; fixed, not copied) |
| Four colour modes | done | `TerrainCover.hlsl`; setting applied live |
| Leaf dissolve z11 -> z12, under-parent discard | done | `TerrainLod.hlsl` |
| Skirts | done | baked in the PTM, drawn double-sided |
| Tile water (deep/shallow) | done | `TerrainRenderer.cs` |
| Open sea | partial | one camera-centred curved grid (`U/Terrain/SeaSurface.cs`) instead of per-tile `oceanPatch.ts` patches |
| Land-use size reveal (`landuseRevealPx`) | done | `TD/Land/LandMesh.cs` RegionSizes (golden `land_mesh.json`, 8 real tiles bit-exact) as a TEXCOORD0 stream; `TerrainLod.hlsl` RetroSizeReveal: leaf fills dissolve, coarser votes take their sampled colour; prepared off the main thread (`LandPrep`). Checked at 1 vs 24 px over GC |
| Runtime seam stitching | missing | border table decoded (`Ptm.cs`), nothing stitches (web `seamStitch.ts`) |
| Far land `.pfl` swap + fingerprint guard | missing | codec only (`TD/Codecs/Pfl.cs`) |
| Far cover textures `.ptx` on terrain | done | `U/Terrain/TerrainCoverTextures.cs` (own tile cache, point-sampled mip chain from `TD/Codecs/CoverTexture.cs`, coverFrame per tile, 4 tests); leaf textures past 3 km. 98 attached over GC at 6 km; on/off compared on screen |
| Smooth shading | done | the ported weld (`LandMesh.BuildSmoothLandGeometry`, golden) uploaded indexed, `RETRO_SMOOTH` interpolates colour and normal; a toggle keeps each tile's mesh until its other kind is ready. Edge-normal lean ported too |
| Rivers (`riverVP`) | missing | river arrays decoded, never drawn |
| Colour adjust (trees, terrain, water, sky) | done | `Shaders/ColourAdjust.hlsl` (the GLSL adjustColour) on the terrain facet colour, tree leaves and sky dome; water on its two palette tones (`ScenePalette.SetWaterTweak`). Checked on screen with extreme values, then restored |

## World detail

| Feature | Status | Evidence / gap |
|---|---|---|
| Roads: levels, 0.9 px widening, ALL/MAJOR/OFF | done | `U/World/RoadRenderer.cs`, `RoadStroke.shader` |
| Rails: sleepers, rails, turnouts, switch zones, level crossings, rail walls | done | `RoadRenderer.cs`, `RailWallRenderer.cs` |
| Bridges (decks, furniture, deck track) | done | `BridgeRenderer.cs` |
| Buildings (300k budget) | done | `BuildingRenderer.cs` |
| Trees: road/building/airfield/rail-bed masks, density | done | `VegetationRenderer.cs` |
| Stones / ground clutter | done | `VegetationRenderer.cs` |
| Airfields: runways, markings (near + far textures), taxiways, unpaved strips, 50 km streaming | done | `AirfieldRenderer.cs` |
| Airfield buildings (OSM boxes) | done | same box extrusion as the web |
| Airbase furniture (4 hangars, tower, 4 parked F-22s, ski jump, aprons, fallback runway) and the home scenario (refinery + 5 depots, SAM radar, warehouse as targets) | done | `U/Flight/Airbase.cs`; every glTF piece solid (17 deck-style colliders at GC), AI cylinders as setupCombat. Verified on screen at GCLP; a flight into a hangar crashes at its face. As on the web the furniture follows the area's base runway: at GCLP three hangars stand on the parallel runway 03R. Colliders take the finest LOD only (the web merges every LOD); the parked F-22s cast URP shadows instead of `f22_shadow.glb`. Targets are recorded but not selectable until T cycling |
| Apron pavement squares | done | drawn where the base airfield has no OSM aprons (GCLP has, so none there) |
| Trees: surface-pad mask | done | `VegetationRenderer.SetSurfacePads` (surfaceExclusion.ts), resident tiles re-scatter |
| Ski jump (drawn + collider) | done | 90 m past the runway spawn on the base runway, as on the web. Hills: none placed on the web either (`hills` is sent empty) |

## Sky and FX

| Feature | Status | Evidence / gap |
|---|---|---|
| Sky dome, palette day/dusk/night blend | done | `U/World/SkyRenderer.cs`; checked at five hours |
| Sun disc + glare | done | `SkyRenderer.cs` |
| Clouds + cirrus | done | `CloudRenderer.cs` |
| Fog | partial | one URP exponential fog at the terrain density; the web's per-category sky/light fog and space fog are not split |
| Sun-visibility skyline (glare and clouds dim behind terrain) | missing | `SunClock.SunVisibilityFor` ported, never called |
| Night-vision palette (I) | missing | `Palettes.HdNightVision` ported, unused |
| Atmosphere shell / space view, stars | missing | `Atmosphere`/`SkyModel` ported; spawn mode 7 flies, but against the ordinary sky |
| Afterburner plumes, wingtip trails | done | `AircraftFxRenderer.cs` |
| Ship wakes, arrestor cables | done | `CarrierFx.cs` |
| Tracers | done | wide streak instead of the 1 px point |
| Smoke, fire, dust, splash, foam, chips, sparks | done | `CombatFxView.cs`, `WreckView.cs` |
| Scorch and burn marks | done | `CombatFxView.cs` |
| Aircraft shadows | partial (by choice) | URP shadow maps replace the web's planform silhouettes; nothing beyond the 1500 m shadow distance |
| Chip minimum-pixel clamp | missing | chips can vanish at range |
| Wireframe (F8), force vectors (V), debug debris (Tab) | missing | debug features; `wantForceVectors` ported in the sim |

## Aircraft

| Feature | Status | Evidence / gap |
|---|---|---|
| glTF load from packs (68 + F-22), material-name remap | done | `U/Flight/AircraftModel.cs` (glTFast) |
| Gear clip, control surfaces, swing wings, tailhook | done | F-14 sweep checked |
| AI aircraft on packs | done | `Combat.cs` (the player's type) |
| Liveries | partial | one flat list of pack entries; the model + livery pickers in `G/Settings/SpawnPanel.cs` are not used |
| LOD by screen width | missing | the nearest LOD scene is always drawn |
| Showcase (F12), part picking and labels | missing | `ShowcaseCameraUpdater` ported, unwired |

## HUD and cockpit

| Feature | Status | Evidence / gap |
|---|---|---|
| Pitch ladder, tapes, VV, throttle, AP flag | done | `G/Overlay/Hud.cs`, `hud.json` golden |
| G / AoA / Mach, AoA indexer, stick indicator | done | |
| Gun reticle, pipper, FPM, stall warning | done | |
| Target box | done | whatever T designates |
| Target cycling (T) | done | `U/Flight/WeaponsTargets.cs` (pickTarget / collectWeaponsTargets): the ground installations in scene order (airfields as built, the authored runway, the carrier, the home targets), then live enemy aircraft, then none; the opponent at each flight start, cleared on respawn; blocked while crashed or replaying. Ground targets sized from their models (models.ts box) or, for an airfield, its longest runway at `AirfieldGeometryBuilder.OriginOf` (exact against the oracle). The key itself was not pressed in a test: the editor was unfocused and injected keys were dropped; `CycleTarget()` was |
| ILS and approach aids | done | an airfield target carries its primary runway, the carrier its live position. Seen on screen on a GCLP final and a carrier approach (needles, box, TGT/VS/GS readout, MFD2 AIRBASE AT GCLP / CARRIER AT STOSNEEHAR) |
| Attitude indicator, gear/flaps/airbrake/hook status | done | `G/Overlay/Cockpit.cs` |
| MFD1 tactical scope, ranges, moving map underlay (M) | done | every designatable target plotted, ground squares and air diamonds, the designated one bright (as the web: the wingman is not a contact) |
| MFD2 target telemetry + target camera | done | `U/Flight/TargetCameraView.cs` |
| Exterior data, units METRIC/IMPERIAL | done | |
| HUD focus (U) | done | `U/Ui/OverlayHost.cs` |
| Perf line (F9) | partial | terrain section only; detail scale hard-coded to 1 |
| Bitmap fonts 3x5, 5x8, 7x11 | done | |
| Night vision on the target camera (I) | missing | |

## Settings

| Setting | Status | Evidence / gap |
|---|---|---|
| aircraftId, spawnMode, start buttons, airfield/place/coordinate search, Nominatim | done | `U/Ui/MenuDialog.cs` |
| livery | partial | see Aircraft |
| renderScale, terrainDetailDistanceM, landuseReach, visibleZoom, terrainTriangleBudget | done | `U/Ui/SettingsBridge.cs` |
| buildings, roads, terrainColour, landuseBlend, treeDensity | done | applied live |
| supersampling | done | URP renderScale = hdSupersampleScale (2x to ~1440p, 1.5x to ~1800p); a render scale below 1 replaces it; the terrain's pixel metric follows |
| farTileTextures, landuseRevealPx, terrainShading | done | see Terrain |
| Colours tab (hue/sat/brightness x4, reset) | done | see Terrain |
| terrainArea "Fly here" | done | scene restart around the area; importer dropped (dev-server only) |
| daytime, flightModel, aiPilotModel | done | live; AI model on the next spawn, as on the web |
| units, keyboardLayout | done | |
| keyboardPitchStickMode | done | the saved mode was lost at boot (applied before the sim existed); fixed with this checklist |
| volume | done | `AudioListener.volume` over the engine sound |
| About credits | done | `SettingsTabView.cs` |
| Help key table | partial | lists keys Unity lacks (I, V, 4, Tab, F8, F12); joystick always "No device detected" (`Host.Joystick` never set) |

## Input, views, replay, audio

| Feature | Status | Evidence / gap |
|---|---|---|
| Keyboard layouts (5), sim keys F G B H L A 1 2 3 Space, wheel brake W | done | keys forwarded to the ported `SimPlayerInput` |
| Pitch stick modes | done | `SimPlayerInput` |
| Menu pauses the sim and takes the keys | partial | N and F9 still act while it is open |
| Gamepad | partial | Unity `Gamepad` sticks + triggers; generic HID joysticks (web axes 0-3, throttle axis inverted) not read |
| F1 cockpit / padlock, F2 chase, F3 carrier, F6 AI chase, Esc menu | done | `PlayerFlight.cs` (F10 free camera is Unity-only) |
| N wing sweep | partial | N toggles day/night only; sweep is the inspector field `wingSweepMode`. On the web one N press does both (noted as probably unintended) |
| M map, U HUD focus | done | |
| I night view, V vectors, 4 target view, Tab debris | missing | (T is done, see HUD and cockpit) |
| Numpad orbit, `/` `*` zoom, Numpad5, NumpadEnter | missing | only Num+/- (throttle) |
| F4 replay, recorder (30 Hz, 600 s), replay keys, replay bar | done | `U/Flight/PlayerFlight.cs` records every frame (6 s past a crash), F4 freezes the world and plays the recorded pose; Space , . [ ] arrows Home Esc; `U/Ui/ReplayBar.cs` (scrubber, buttons, speed, Cockpit/Behind/Front/Left/Right/Free/Tower views). One deliberate difference: before the crash point the airframe is drawn (the web hides it the whole replay once the wreck exists). The bar is a flat shade, not the web's gradient. Recorded devices (gear etc.) are not replayed, as on the web |
| F8 wireframe, F12 showcase, land-cover tooltip, mod-status line | missing | |
| Engine audio (two loops swapped by view, rate/gain by throttle, stop on crash) | done | `U/Flight/EngineAudio.cs`; pitch 0.96 / gain 0.73 at audio level 0.23 checked against the formula; cockpit/exterior swap and crash silence checked |
| Start camera pose argument (web `?@lat,lng,altA,hdgH,tiltT`) | missing | `G/State/CameraRoute.cs` ported; no command-line parsing |

## Boot and spawn

| Feature | Status | Evidence / gap |
|---|---|---|
| Streaming hold, 3-2-1-Go countdown | done | `U/Ui/BootOverlay.cs` |
| Boot stage labels | partial | only "Loading terrain"; `G/Settings/BootProgress.cs` stages unused |
| Spawn modes 1-7, 9 (8 dropped with the barricade) | done | Ctrl+digit and the Flight tab |
| Cross-area picks | done | in-process restart instead of a page reload |
| Backdrop blur | missing | dimmed pane only |
| Dev-server features (F9 importer, F10 mod import, `/api/*`) | dropped | plan section 2 |

## Performance

| Budget (web) | Unity | Notes |
|---|---|---|
| 600k terrain triangles | same cap, same fold | |
| 300k building triangles | same | |
| ~480 draw calls | not yet measured in a player build | editor numbers are noisy |
| Per-frame garbage | ~0.4 MB in the cockpit view (from ~1.3 MB) | overlay ~0 |

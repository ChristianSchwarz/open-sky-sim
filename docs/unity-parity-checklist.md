# Unity port: parity checklist

Status 2026-10-12, branch `unity-fe`, after M9. Built from the feature inventory in
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
| Terrain | 13 | 1 | 0 |
| World detail | 12 | 0 | 0 |
| Sky and FX | 12 | 3 | 0 |
| Aircraft | 5 | 1 | 0 |
| HUD and cockpit | 12 | 2 | 0 |
| Settings | 12 | 2 | 0 |
| Input, views, replay, audio | 11 | 2 | 0 |
| Boot and spawn | 4 | 1 | 0 |
| **Total** | **92** | **14** | **0** |

What is missing most visibly, in suggested order:
1. ~~Engine audio~~ and ~~replay (F4)~~: done since the checklist was written (see the Input table).
3. ~~Building and scenery colliders, and the glTF scenery~~: done since (see World detail).
4. ~~Target cycling (T)~~ and the ILS: done since (see HUD and cockpit).
5. ~~Settings that are only stored~~: done since (see Terrain and Settings).
6. ~~Terrain~~: seam stitching, far land and rivers done since (see Terrain).
7. ~~Space view~~: the atmosphere shell, stars and the sun-visibility skyline done since (see Sky and FX).
9. ~~The rest~~ (aircraft LOD, backdrop blur, the start camera argument) done since; the chip clamp
   turned out to be off in the web game too. Only **partial** rows remain.
8. ~~Debug and showcase views~~: done since (see Input, views).

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
| Runtime seam stitching | done | `TD/Land/SeamStitch.cs` (golden `seam_stitch.json`: 4 real GC tiles, 6 scenarios incl. masters leaving and returning, bit-exact); `TerrainRenderer.StitchSeams` per frame over the drawn non-under tiles; a moved tile's land (faceted or welded) is rebuilt from its arrays, the T-junction fill drawn with it. 99 fills over GC, no cracks seen |
| Far land `.pfl` swap + fingerprint guard | done | `U/Terrain/TerrainFarLand.cs`: the coarsest level under half a pixel at the tile's nearest point (from its quantised half-extent, the web uses the quadtree sphere), stale sidecars refused by the near fingerprint, SMOOTH welds a few a frame, levels follow the stitched border (followSeam). 47 of 51 drawn tiles attached at GC |
| Far cover textures `.ptx` on terrain | done | `U/Terrain/TerrainCoverTextures.cs` (own tile cache, point-sampled mip chain from `TD/Codecs/CoverTexture.cs`, coverFrame per tile, 4 tests); leaf textures past 3 km. 98 attached over GC at 6 km; on/off compared on screen |
| Smooth shading | done | the ported weld (`LandMesh.BuildSmoothLandGeometry`, golden) uploaded indexed, `RETRO_SMOOTH` interpolates colour and normal; a toggle keeps each tile's mesh until its other kind is ready. Edge-normal lean ported too |
| Rivers (`riverVP`) | done | each tile's water strokes in RoadStroke at true width (the web's riverMaterial sets no pixel floor), deep-water tone, after land and roads; 56 tiles at GC, seen continuing the river upstream |
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
| Fog | partial | one URP exponential fog at the terrain density, thinned by the atmosphere shell's weight above 30 km (`SPACE_FOG.scale`); the web's per-category sky/light fog is not split |
| Sun-visibility skyline (clouds dim behind terrain) | done | `U/World/SkyRenderer.cs` `UpdateSunVisibility`: the ground marched along the sun's bearing every 4 frames, `_RetroSunHidden` into `Shaders/CloudSky.shader` (body: direct, rim and ambient; haze: 0.35 + 0.65 v); a 5 deg sun behind a ridge read 0.95 |
| Night-vision palette (I) | partial | the target camera's image turned to the palette's kind of greyscale (`Shaders/NightVision.shader`): per-camera palettes do not fit Unity's draw submission, so it is an image pass, not hd-nightvision's per-category greys |
| Atmosphere shell / space view, stars | done | `Shaders/AtmosphereShell.shader` (atmosphereShellModelBuilder.ts: ray march over scene depth, cloud deck, glint, stars) drawn by `U/World/SkyRenderer.cs` from 30 km; above 100 km no dome, black clear, no cloud fields; seen from 70 and 400 km |
| Afterburner plumes, wingtip trails | done | `AircraftFxRenderer.cs` |
| Ship wakes, arrestor cables | done | `CarrierFx.cs` |
| Tracers | done | wide streak instead of the 1 px point |
| Smoke, fire, dust, splash, foam, chips, sparks | done | `CombatFxView.cs`, `WreckView.cs` |
| Scorch and burn marks | done | `CombatFxView.cs` |
| Aircraft shadows | partial (by choice) | URP shadow maps replace the web's planform silhouettes; nothing beyond the 1500 m shadow distance |
| Chip minimum-pixel clamp | done (nothing to port) | `particlesMeshVP.ts` has the clamp, but no material sets `minPixels` above 0, so the web never applies it either |
| Wireframe (F8), force vectors (V), debug debris (Tab) | done | F8 is URP's rendering-debugger wireframe (one colour, not the web's per-level hues; URP ignores GL.wireframe; may be stripped from non-development builds); V draws `ForceVectorRenderer` arrows from the model's snapshot (the web's thrust-origin override not ported); Tab bursts chips and a leak from the opponent |

## Aircraft

| Feature | Status | Evidence / gap |
|---|---|---|
| glTF load from packs (68 + F-22), material-name remap | done | `U/Flight/AircraftModel.cs` (glTFast) |
| Gear clip, control surfaces, swing wings, tailhook | done | F-14 sweep checked |
| AI aircraft on packs | done | `Combat.cs` (the player's type) |
| Liveries | partial | one flat list of pack entries; the model + livery pickers in `G/Settings/SpawnPanel.cs` are not used |
| LOD by screen width | done | `U/Flight/AircraftModel.cs` loads every body LOD scene, `AircraftView.LodFor` picks by `ModelLod.GetLodLevel` (bias 3, 320 px reference) capped at the last; past 0 no gear or surfaces. F-22: lod0 to 300 m, lod2 at 1 km, lod5 at 8 km. The pack aircraft ship one scene |
| Showcase (F12), part picking and labels | done | `U/Flight/Showcase.cs`: the airframe alone on its own layer, black, no fog, orbited; the part under the mouse named ("Mesh: …", `U/Ui/PointerLabels.cs`), yellow while held; the flight carries on without input, as on the web |

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
| Night vision on the target camera (I) | partial | see Sky and FX |

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
| Help key table | partial | joystick always "No device detected" (`Host.Joystick` never set) |

## Input, views, replay, audio

| Feature | Status | Evidence / gap |
|---|---|---|
| Keyboard layouts (5), sim keys F G B H L A 1 2 3 Space, wheel brake W | done | keys forwarded to the ported `SimPlayerInput` |
| Pitch stick modes | done | `SimPlayerInput` |
| Menu pauses the sim and takes the keys | partial | N and F9 still act while it is open |
| Gamepad | partial | Unity `Gamepad` sticks + triggers; generic HID joysticks (web axes 0-3, throttle axis inverted) not read |
| F1 cockpit / padlock, F2 chase, F3 carrier, F6 AI chase, Esc menu | done | `PlayerFlight.cs` (F10 free camera is Unity-only) |
| N wing sweep | done | AUTO -> SPREAD -> SWEPT, and the day/night flip on the same key, as on the web |
| M map, U HUD focus | done | |
| I night view, V vectors, 4 target view, Tab debris | done | 4 toggles TargetTo / TargetFrom (back to the cockpit when the target goes) |
| Numpad orbit, `/` `*` zoom, Numpad5, NumpadEnter | done | orbitCameraAroundAircraft after the view's updater; NumpadEnter is the F2 views' enemy lock or the cockpit padlock |
| F4 replay, recorder (30 Hz, 600 s), replay keys, replay bar | done | `U/Flight/PlayerFlight.cs` records every frame (6 s past a crash), F4 freezes the world and plays the recorded pose; Space , . [ ] arrows Home Esc; `U/Ui/ReplayBar.cs` (scrubber, buttons, speed, Cockpit/Behind/Front/Left/Right/Free/Tower views). One deliberate difference: before the crash point the airframe is drawn (the web hides it the whole replay once the wreck exists). The bar is a flat shade, not the web's gradient. Recorded devices (gear etc.) are not replayed, as on the web |
| F8 wireframe, F12 showcase, land-cover tooltip, mod-status line | done | tooltip after 2 s of a resting mouse: DEM ray march, then the top facet of the deepest drawn tile (a hole there is water; the web compares a drawn-land march instead). The mod-status line belongs to the dropped dev-server mod import |
| Engine audio (two loops swapped by view, rate/gain by throttle, stop on crash) | done | `U/Flight/EngineAudio.cs`; pitch 0.96 / gain 0.73 at audio level 0.23 checked against the formula; cockpit/exterior swap and crash silence checked |
| Start camera pose argument (web `?@lat,lng,altA,hdgH,tiltT`) | done | command-line `@45.93,6.87,2500a,150h,85t` (or after `-camera`, or a whole `?` query) in `U/SpikeBootstrap.cs`; the area centres on it and `PlayerFlight.EnterFixedCamera` holds the sim with the free camera there; a spawn leaves it. Checked through `EnterFixedCamera`; the argument path has not been run in a build |

## Boot and spawn

| Feature | Status | Evidence / gap |
|---|---|---|
| Streaming hold, 3-2-1-Go countdown | done | `U/Ui/BootOverlay.cs` |
| Boot stage labels | partial | only "Loading terrain"; `G/Settings/BootProgress.cs` stages unused |
| Spawn modes 1-7, 9 (8 dropped with the barricade) | done | Ctrl+digit and the Flight tab |
| Cross-area picks | done | in-process restart instead of a page reload |
| Backdrop blur | done | `U/Ui/BootOverlay.cs`: during the hold the main camera renders to a texture, `Shaders/BackdropBlur.shader` (separable Gaussian, sigma 12 CSS px) runs after it, shown under the 0.35 dim; both go to 0 over the count's first second. The HUD is not seen under it |
| Dev-server features (F9 importer, F10 mod import, `/api/*`) | dropped | plan section 2 |

## Performance

| Budget (web) | Unity | Notes |
|---|---|---|
| 600k terrain triangles | same cap, same fold | |
| 300k building triangles | same | |
| ~480 draw calls | not yet measured in a player build | editor numbers are noisy |
| Per-frame garbage | ~0.4 MB in the cockpit view (from ~1.3 MB) | overlay ~0 |

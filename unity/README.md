# Unity frontend

The C# port of the game (see `docs/unity-port-plan.md`).

- `Packages/com.retro.core`, `com.retro.terrain-data`, `com.retro.sim`: engine-free
  code (`noEngineReferences`). The same files build in `dotnet/` and are checked
  by the golden tests: `cd dotnet && dotnet test Retro.slnx`.
- `Packages/com.retro.unity`: the Unity layer (URP): `TerrainRenderer` (streams
  `assets/terrain` and draws it camera-relative with `Graphics.RenderMesh`),
  `SeaSurface`, `FlyCamera` (double-precision floating origin), `SceneFrame`
  (the only place scene axes become Unity axes), the URP shaders, and
  `Flight/` (`PlayerFlight` drives the ported `CombatSim`; `DemHeightField`
  is its collision surface) and `World/` (airfields, roads and rails,
  bridges, buildings, trees, each streamed per drawn tile; `SkyRenderer` and
  `CloudRenderer` for the time of day, palette, fog, sky and clouds).
- `RetroFlight/`: the Unity project (Unity 6, Universal 3D template). Its
  `Packages/manifest.json` references the packages above as `file:../../Packages/...`.

## Running it

1. Open `unity/RetroFlight` in Unity 6.
2. Press Play in any scene: `SpikeBootstrap` creates the camera, a sun, the
   terrain, the sea and the player's aircraft (on the nearest base runway;
   `PlayerFlight.spawnMode` picks the web game's other starts, Location is airborne at `spawnLat`/`spawnLon`) when the scene has no
   `TerrainRenderer` yet. To start elsewhere in the baked pyramid, set the
   PlayerPref `retro.spawn` to `"lat,lon"` before pressing Play (read once). The F-22 is read from `assets/*.glb` with glTFast
   (`com.unity.cloud.gltfast`); `PlayerFlight.flightModel` switches FM2/FM3.
   `PlayerFlight.aircraftId` picks any of the mod packs in `dist/assets`
   (`npm run build` makes them) and switches in flight; the choice is kept in
   the PlayerPref `retro.aircraft`.
3. Flying uses the web game's keys (the sim reads them itself): arrows for
   pitch and roll, X/Y yaw, numpad +/- throttle, G gear, F flaps, B airbrakes,
   A autopilot, Space gun. F1 cockpit, F2 chase back/front, R respawn.
   N toggles night and 14:00; `SkyRenderer.hours` on the `Sky` object sets any hour.
4. F10 toggles the free camera: WASD to move, Q/E down/up, hold the right
   mouse button to look, wheel for speed, Shift for 10x. Tile and memory
   stats are on the `Terrain` object.

The baked pyramid is found by walking up from the project to `assets/terrain`
(set `TerrainRenderer.terrainRoot` to use another one).

# Unity frontend

The C# port of the game (see `docs/unity-port-plan.md`).

- `Packages/com.retro.core`, `com.retro.terrain-data`, `com.retro.sim`: engine-free
  code (`noEngineReferences`). The same files build in `dotnet/` and are checked
  by the golden tests: `cd dotnet && dotnet test Retro.slnx`.
- `Packages/com.retro.unity`: the Unity layer (URP). Today it holds the M2
  terrain spike: `TerrainRenderer` (streams `assets/terrain` and draws it
  camera-relative with `Graphics.RenderMesh`), `SeaSurface`, `FlyCamera`
  (double-precision floating origin), `SceneFrame` (the only place scene axes
  become Unity axes) and three URP shaders.
- `RetroFlight/`: the Unity project (Unity 6, Universal 3D template). Its
  `Packages/manifest.json` references the packages above as `file:../../Packages/...`.

## Running the terrain spike

1. Open `unity/RetroFlight` in Unity 6.
2. Press Play in any scene: `SpikeBootstrap` creates a fly camera over Gran
   Canaria, a sun, the terrain and the sea when the scene has no
   `TerrainRenderer` yet.
3. WASD to move, Q/E down/up, hold the right mouse button to look, wheel for
   speed, Shift for 10x. Tile and memory stats are on the `Terrain` object.

The baked pyramid is found by walking up from the project to `assets/terrain`
(set `TerrainRenderer.terrainRoot` to use another one).

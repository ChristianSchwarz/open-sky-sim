# Retro Flight Simulator

Quick and dirty attempt to replicate the visuals of late 80s / early 90s flight simulators, using as a reference MicroProse's F-117A Nighthawk Stealth Fighter 2.0 (1991).

## Live demo

[https://ruben3d.github.io/retroflightsim/dist](https://ruben3d.github.io/retroflightsim/dist)

## How to build

You need node.js installed globally (I have been using 14.16.0).

```
$ cd retroflightsim
$ npm i
$ npm run build
```

### Terrain data

The planetary terrain under `assets/planet` is a **build product** and is not
tracked in git, so a fresh clone has no terrain until you bake it. It is
generated from `data/output_hh.tif` (tracked) plus OpenStreetMap coastlines:

```
$ pip install rasterio numpy shapely requests
$ python tools/bake_planet_dem.py --input data/output_hh.tif --out assets/planet
$ python tools/bake_osm_coast.py --manifest assets/planet/manifest.json
$ npm run bake:airports      # OSM aerodromes -> the manifest's airfields block
$ npm run fetch:cover        # landcover + satellite imagery, optional
$ npm run bake:cover
$ npm run bake:mesh
```

`data/output_hh.tif` only covers the Canaries. To add somewhere else, press
**`F9`** in the running app and drag a box on the OpenStreetMap map — the dev
server runs the whole bake for that area and streams the progress back. From
the command line it is the same six stages, sharing one `--bbox`; fetch a DEM
for that area first — `npm run fetch:dem -- --bbox 7.6,45.9,7.8,46.0 --out
data/imports/alps.tif` pulls it from the public FABDEM archive (Copernicus
GLO-30 with forest and building height bias removed) and writes the GeoTIFF
the first command above takes as `--input`. See
[`tools/README.md`](tools/README.md#height-sources).

The mesh stage ends by folding every tile's geometric error upward, so a
parent tile is always marked at least as far off as any tile beneath it and
the level-of-detail cut refines an island as one piece rather than half of
it. A tree baked before that fold existed can be brought up to date without
re-meshing: `npm run bake:errors`.

The cover stage is what gives terrain its colour: every facet is baked with
both a landcover class and a satellite colour, and the *Terrain colour*
setting picks which one paints it. Skip those two commands and the terrain
comes out a uniform green.

See [`tools/README.md`](tools/README.md#planet-terrain) for the options, and
`npm run verify:planet` to check a baked tree.

## How to run

Start the local web server:

```
$ cd retroflightsim
$ npm run serve
```
Then open `localhost:8020` in your web browser (tested on Chrome/Linux).

**Important:** F10 mod import only works when the app is served by the Node dev
server (`npm run serve`). If you use another static file server on the same port
(e.g. `ws -d dist`, Live Server, or opening `dist/index.html` directly), uploads
will fail with HTTP 405. Stop any other server on port 8020 first, then run
`npm run serve`.

`npm run serve` starts a small Node/TypeScript dev server (`tools/modserver.ts`,
run via `tsx`) that serves `dist/` and also exposes the in-app mod import endpoint.

### Importing a mod from the app (F10)

Press `F10` in the app to upload a Unity aircraft mod `.zip`. The dev server runs
the Python import pipeline (`tools/import_mod.py` + `tools/pack_aircraft_mods.py`)
to convert it into a flat-shaded, flyable aircraft, then the app registers the
imported plane(s), shows what was imported, and opens the aircraft selection menu
so you can pick one and fly. This requires a Python environment with the import
tools' dependencies installed (see `tools/README.md`):

```
pip install UnityPy trimesh numpy pillow
```

Generic imports are flyable but have no animated control surfaces and use the
active flight model. Multi-plane mod packs are imported as **one aircraft pack
per livery** (each plane appears separately in the spawn menu). For full
fidelity (control surfaces + custom flight physics), include a
`retroflight.json` import config inside the mod `.zip`.

## Instructions

### Settings

#### Flight model

The flight model selects the physics driving the simulation:
* FM2 (Rigid body): The game's own 6-DOF aerodynamic model (lift, drag, and speed-dependent control authority), configured per-aircraft.
* FM3 (Physical, post-stall): A 6-DOF rigid body whose forces come from the airframe's geometry: wing and tail strips with section aerodynamics over ±180°, a lifting line with tail downwash and wake, strake vortex lift and a slender-body fuselage. Stall, departures, deep stall, flat spins and tail slides are computed rather than scripted. Every aircraft flies the F-16's aerodynamics, checked against NASA TP-1538, through FM3's own flight control system; `L` removes the AoA and g limiters but keeps stability augmentation. Player aircraft only (AI stays on FM2). Design and validation: [docs/fm3-physical-flight-model.md](docs/fm3-physical-flight-model.md).
* Debug (Free-fly): A no-aerodynamics "free-fly" mode of the same rigid-body model, intended for debugging/inspecting scenery and models — the stick rotates the airframe directly and the plane can be stopped midair.

#### Keyboard layout

Choose your keyboard layout, for users using QWERTZ, AZERTY, Dvorak, or arrow keys.

### Plane controls

#### Keyboard

Use the OSD settings to select the keyboard layout.

QWERTY (default):
* `W`/`S`: Pitch (`W` is wheel brakes while on the ground)
* `A`/`D`: Roll
* `Q`/`E`: Yaw
* `Z`/`X`: Throttle

QWERTZ:
* `W`/`S`: Pitch (`W` is wheel brakes while on the ground)
* `A`/`D`: Roll
* `Q`/`E`: Yaw
* `Y`/`X`: Throttle

AZERTY:
* `Z`/`S`: Pitch
* `Q`/`D`: Roll
* `A`/`E`: Yaw
* `W`/`X`: Throttle (`W` is wheel brakes while on the ground)

Dvorak:
* `,`/`O`: Pitch
* `A`/`E`: Roll
* `'`/`.`: Yaw
* `Q`/`J`: Throttle

Arrows:
* `↑`/`↓`: Pitch
* `←`/`→`: Roll
* `Y`/`X`: Yaw
* `Num-`/`Num+`: Throttle

#### Joystick

The system supports a single device connected only. If the device has less than four axes the keyboard can be used to complement the missing controls. Joystick information displayed in the OSD help.

* `Axis 1`: Pitch
* `Axis 0`: Roll
* `Axis 3`: Yaw
* `Axis 2`: Throttle

### Systems
* `W`: Wheel brakes (hold, on the ground)
* `G`: Landing gear
* `F`: Flaps
* `H`: Tailhook (raise/lower; a wire only snags with the hook down)
* `K`: Rig / strike the carrier's emergency barricade — the 20 ft barrier net
  across the landing area: two dark load-strap cables between hinged stanchions,
  with a hundred feet of wide nylon engaging loops draped between them, bellying
  aft toward the groove. It catches the *wings*, not the hook, so it is the way
  down when the hook is up or unusable. Once an aircraft is in it the webbing
  wraps its collision hull, but only where the hull is broad enough to gather
  loops: the fuselage is too narrow, so it parts the webbing and comes out the
  far side. Each load belt is cut to the mast-to-mast run and does not stretch,
  with its ends shackled to a wire that pays out of the mast: driven into a
  bight the belt covers less deck, its ends draw inboard, and the wire comes out
  to make up the difference. Every stripe keeps its sewn position along the
  webbing throughout, and the wire hangs off its sheave when idle —
  coming straight under load. The stripes
  are cut to a fixed length too, so one goes taut where it grips and its spare
  webbing festoons — hanging down until it rests on the deck, then bellying out
  once it can drop no further. A stripe that catches a wing closes right round the
  section — flat on the leading edge, then curling aft along the skin above and
  below before it runs back to the strap. The webbing closes
  *around* the wings, over the leading edge and gripping above and below, with
  the two straps drawing together onto the airframe as the net is hauled along. The stanchions take ~5 s to swing
  upright and the webbing only takes a load once they are; the net is
  expendable, so an arrestment consumes it and the deck crew needs ~12 s to
  lace a replacement. Status shows in the HUD device stack as `BARRICADE`.
* `T`: Select target
* `I`: Toggle IR for the tracking camera
* `U`: Cycle through HUD focus modes (disabled, partial, full)

### Views
* `N`: Toggle day/night
* `1` / `F1`: Cockpit (`F1` again with a target toggles padlock — camera tracks the target while the HUD stays airframe-fixed, so a high target leaves the HUD at the bottom of the view)
* `2`: Toggle exterior back/front
* `3`: Toggle exterior left/right
* `4`: Toggle to/from target
* `Numpad Enter`: Toggle F1 padlock / F2 enemy lock
* `Numpad *` / `Numpad /`: Zoom the orbit view in / out

On reaching the limits of the baked terrain the player position is clamped.
(It used to *wrap* to the opposite side, a leftover from the old tiled
scenery that teleported the aircraft while the terrain stayed put.)

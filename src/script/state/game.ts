import * as THREE from 'three';
import { AudioSystem } from '../audio/audioSystem';
import { ConfigService } from '../config/configService';
import { isOverlayKeyEvent } from '../input/overlayKeys';
import { daytimePalette } from '../config/palettes/daytimePalette';
import { Palette, PaletteCategory, PaletteColor } from '../config/palettes/palette';
import { ShowcasePalette } from '../config/palettes/showcase';
import { HDMidnightPalette } from '../config/palettes/hd-midnight';
import { HDNoonPalette } from '../config/palettes/hd-noon';
import { loadSettings, SpawnMode, updateSettings } from '../config/settingsStorage';
import { KernelRenderTask, KernelUpdateTask } from '../core/kernel';
import { fm2GroundRestHeight } from '../physics/fm2/fm2AircraftConfig';
import { AIRBASE_RUNWAY as AIRBASE_RUNWAY_RAW, APPROACH_ALTITUDE_M, APPROACH_SPEED_MPS, COCKPIT_FAR, COCKPIT_FOV, HIGH_ALTITUDE_M, H_RES, PLANE_DISTANCE_TO_GROUND, RUNWAY_HALF_LENGTH_M, SPACE_ALTITUDE_M, V_RES } from '../defs';
import {
    DEFAULT_SUN_HOURS, setSunTime, SUN_DIRECTION, SUN_STATE, SUN_VISIBILITY, sunVisibilityFor,
} from '../scene/materials/shaders/sun';
import {
    DISC_DIAMETER_DEG as SUN_DISC_DIAMETER_DEG, placeSun, SUN_SET_ELEVATION_DEG,
} from '../scene/models/lib/sunModelBuilder';

/** How far out along the sun's bearing terrain is searched for a skyline. */
const SUN_SKYLINE_RANGE_M = 100_000;
/**
 * Frames between skyline searches. It is ~200 ground reads and only sets the
 * clouds' light, which a few frames' lag cannot show.
 */
const SUN_SKYLINE_EVERY_FRAMES = 4;
import { paintSkyDome, SkyDome, skyDomeOf } from '../scene/models/lib/skyDomeModelBuilder';
import { paintSunBloom } from '../scene/models/lib/sunModelBuilder';
import { ATMOSPHERE_SHELL_UNIFORMS, SHELL_MAX_AREAS } from '../scene/models/lib/atmosphereShellModelBuilder';
import { earthMap } from '../scene/earthMap';
import { SPACE_FOG } from '../scene/materials/shaders/spaceFog';
import { Model } from '../scene/models/models';
import { terrainMaxZoomForAltitudeM } from '../terrain/lod';
import { Renderer, RenderLayer, RenderTargetType } from "../render/renderer";
import { SceneCamera } from '../scene/cameras/camera';
import { DebrisField } from '../scene/entities/debrisField';
import { WreckField } from '../scene/entities/wreckField';
import { ImpactMarks } from '../scene/entities/impactMarks';
import { MovingSurface } from '../scene/entities/movingSurface';
import { DamageSmokeField } from '../scene/entities/damageSmokeField';
import { GroundTargetEntity } from '../scene/entities/groundTarget';
import { ActivePlayArea, areaContains, homeArea, resolvePlayArea, terrainAreas } from '../terrain/playArea';
import { carrierSurfaceY, chooseCarrierSite } from './carrierSite';
import { Airfield, AirfieldBuilding, airfieldsInArea } from '../terrain/airfields';
import {
    SceneRunway, airfieldChoices, headingForward, pickStartRunway, regionalHomeBase, runwayKey, sceneRunwaysOf,
} from './activeAirfield';
import {
    AIRFIELD_SURFACE_EPS_M, GroundStrip, buildAirfieldModel, buildingHeightM, combineCover, repaintGroundStrip,
    sampleGroundStrip,
} from '../scene/airfield/airfieldModel';
import { WGS84_A, WGS84_B, cloneEnuBasis, ecefToEnu, enuFrameRotation, geodeticOnSurfaceAtEnu, geodeticToEcef, geodeticToWorld, makeEnuBasis, sceneFromEnu, seaLevelSceneY, worldToGeodetic } from '../terrain/geodesy';
import { openSettingsDialog } from '../ui/settings/settingsLauncher';
import { FogQuality } from '../config/profiles/profile';
import { MAP_FOV_DEG, MAP_TRIANGLE_BUDGET, MapView, isMapViewPage, mapViewUrl } from './mapView';
import { setMapDetailScale, setMapLod } from '../terrain/quadtree';
import { setCoverUnderlay, setLeafCoverFromM } from '../terrain/coverTextures';
import { setBuildingsAtOnce } from '../terrain/buildingMeshes';
import { ArrestorCablesEntity } from '../scene/entities/arrestorCablesEntity';
import { BarricadeEntity, BarricadeRigPhase } from '../scene/entities/barricadeEntity';
import type { AirframeCollider } from '../physics/barricade/webBarricade';
import { WebDeck } from '../physics/barricade/webDeck';
import { BarricadeEngagement, BARRICADE_DECK_Y } from '../scene/entities/barricadeSpec';
import { ARRESTOR_CARRIER_ORIGIN, ArrestorCarrierPose } from '../scene/entities/arrestorCables';
import { ShipWakeEntity } from '../scene/entities/shipWake';
import {
    CockpitEntity, CockpitMFD2X, CockpitMFD2Y, CockpitMFDSize,
} from '../scene/entities/overlay/cockpit';
import { ILS_GLIDESLOPE_TAN } from '../scene/entities/overlay/approachAids';
import { ExteriorDataEntity } from '../scene/entities/overlay/exteriorData';
import { HUDEntity } from '../scene/entities/overlay/hud';
import { PerfHudEntity } from '../scene/entities/overlay/perfHud';
import { PlayerEntity, PlayerSpawnState } from '../scene/entities/player';
import {
    bakeCollisionMeshFromModel,
    createCarrierMeshCollider,
    sampleCarrierMeshSurfaceYMax,
    CarrierMeshCollider,
} from '../scene/entities/carrierDeck';
import {
    createSkiJumpCollider, sampleSkiJumpSurfaceYMax, SkiJumpCollider,
} from '../scene/entities/skiJump';
import { SurfacePadCollider, SurfacePadIndex, sampleSurfacePadY } from '../scene/entities/surfacePad';
import { buildSurfaceExclusion } from '../terrain/surfaceExclusion';
import { SceneryField, SceneryFieldSettings } from '../scene/entities/sceneryField';
import { SimpleEntity } from '../scene/entities/simpleEntity';
import { StaticSceneryEntity } from '../scene/entities/staticScenery';
import { Entity } from '../scene/entity';
import { SceneMaterialManager } from "../scene/materials/materials";
import { ModelManager } from "../scene/models/models";
import { Scene, SceneLayers } from '../scene/scene';
import { updateTargetCamera } from '../scene/utils';
import { assertIsDefined } from '../utils/asserts';
import { clamp, FORWARD, RIGHT, UP } from '../utils/math';
import { CameraUpdater } from './cameraUpdaters/cameraUpdater';
import { CockpitFrontCameraUpdater } from './cameraUpdaters/cockpitFrontCameraUpdater';
import { CrashedCameraUpdater } from './cameraUpdaters/crashedCameraUpdater';
import { ExteriorFrontBehindCameraUpdater, ExteriorViewHeading } from './cameraUpdaters/exteriorFrontBehindCameraUpdater';
import { AiExteriorCameraUpdater, AI_SPAWN_DISTANCE_M } from './cameraUpdaters/aiExteriorCameraUpdater';
import { ExteriorSideCameraUpdater, ExteriorViewSide } from './cameraUpdaters/exteriorSideCameraUpdater';
import { CarrierOverSternCameraUpdater } from './cameraUpdaters/carrierOverSternCameraUpdater';
import { TargetFromCameraUpdater } from './cameraUpdaters/targetFromCameraUpdater';
import { TargetToCameraUpdater } from './cameraUpdaters/targetToCameraUpdater';
import { StaticModelCameraUpdater } from './cameraUpdaters/staticModelCameraUpdater';
import { ShowcaseCameraUpdater } from './cameraUpdaters/showcaseCameraUpdater';
import { FixedCameraUpdater } from './cameraUpdaters/fixedCameraUpdater';
import {
    FixedCameraRates, FixedCameraTuning, fixedCameraInput, stepFixedCameraRates, zeroFixedCameraRates,
} from './cameraUpdaters/fixedCameraControl';
import { CameraRoute, cameraRouteFromLocation, clearCameraRouteFromLocation, writeCameraRouteToLocation } from './cameraRoute';
import { SpawnDestination, airfieldEntryOf, savePendingDestination, takePendingDestination } from './spawnSearch';
import type { TerrainArea } from '../terrain/manifest';
import { restoreMainCameraParameters } from './stateUtils';
import {
    StaticModelView, buildStaticModelViews, forEachStaticAircraftSlot,
} from './staticModelViews';
import { SpawnMenuEntity } from '../scene/entities/overlay/spawnMenu';
import {
    fadeOutBootProgress, hideCountdown, setBootProgress, setBootStreaming, showCountdown,
} from '../osd/bootProgress';
import { SpawnPanel } from '../osd/spawnPanel';
import { AircraftRegistry, buildF22Def, groupAircraftByModel } from './aircraftRegistry';
import { FlyableAircraftDef } from '../scene/entities/aircraftDef';
import { flightConfigWithArrestorHook } from '../scene/entities/arrestorCables';
import { Obstacle, Runway } from '../ai/worldQuery';
import { AiFlightPhase, AiPilotOptions, AiRoute, AiSkillLevel, FORMATION_SLOT } from '../ai/aiPilot';
import { AiAircraftEntity, AiAircraftSpawn } from '../scene/entities/aiAircraft';
import { Flight, FlightEndpoint, MAX_FLIGHTS, Mission } from '../mission/flightPlan';
import { MissionEditor, RunwayEnd } from '../mission/missionEditor';
import { loadMission } from '../mission/missionStore';
import { MissionOverlay } from './missionOverlay';
import { mountMissionPanel } from '../ui/mission/missionLauncher';
import { WeaponsField } from '../scene/entities/weaponsField';
import { advanceFxClock } from '../scene/fxClock';
import { Faction } from '../weapons/combatant';
import { CombatSimClient } from '../physics/sim/combatSimClient';
import { SimProxyFlightModel } from '../physics/model/simProxyFlightModel';
import { SerializedWorld, serializeStaticColliders, serializeWorld, defaultArrestorCableField, serializeArrestorCables } from '../physics/sim/serializedWorld';
import { LandArrestorWire, landArrestorFields, landArrestorWiresOf, landWireById } from '../scene/entities/landArrestorWires';
import { LandArrestorWiresEntity } from '../scene/entities/landArrestorWiresEntity';
import { osmSkiJumpsOf } from '../scene/entities/osmSkiJumps';
import { pavementColliders } from '../scene/airfield/pavementColliders';
import { SkiJumpModelLibBuilder } from '../scene/models/lib/skiJumpModelBuilder';
import { HeightFieldSender, MirrorFocus, SerializedHeightField } from '../terrain/heightMirror';
import { rebaseMeshCollider, rebaseRunway, rebaseSkiJump, rebaseSurfacePad } from './worldRebase';
import { FlightRecorder, ReplayPlayer, newReplayPose } from './flightRecorder';
import { SimAircraftSpawn, SimFlightModelKind, SimGunConfig, SimHitEvent } from '../physics/sim/simTypes';
import { PLAYER_SIM_ID, WINGMAN_SIM_ID, aiSimId } from '../physics/sim/simIds';
import { AiPilotModels, TerrainShading } from './gameDefs';
import {
    DEFAULT_TERRAIN_URL, SPACE_SKY_ALTITUDE_M, TerrainEntity, cameraFarForAltitudeM,
    isTerrainWireframe, loadTerrainManifest, setTerrainWireframe,
} from '../terrain';
import {
    isAircraftWireframe, setAircraftWireframe, isVisibleMeshesOnly, setVisibleMeshesOnly,
} from '../scene/entities/aircraftDebug';
import {
    AIRBASE_LOCAL, TARGET_LOCAL, PLAY_ORIGIN, SCENERY_SURFACE_EPS_M,
} from './worldLayout';

/**
 * The crash severity from which a ground impact that does not destroy the aircraft
 * already bends its airframe and starts to tear parts off. (A touchdown, however
 * firm, sits below it; the crash scale is speed into the ground plus a third of
 * the speed along it, over 110 m/s.)
 */
const LIVE_DAMAGE_MIN_SEVERITY = 0.3;

/** The fuselage fire burns this long, thinning to smoke and gaps, before it goes out. */
const FUSELAGE_FIRE_LIFE_S = 200;
/** ...and a faint smoke trickle carries on this long after the flames end. */
const FUSELAGE_SMOULDER_S = 240;
const WING_ROOT_FIRE_LIFE_S = 60;
const WING_ROOT_SMOULDER_S = 80;

/** How many AI opponents the combat sim spawns. */
/** Loose cloud deck: base altitude and per-puff undulation, well under HIGH_ALTITUDE_M. */
/** Altitude at which the atmosphere shell starts to fade in over the sky dome. */
const ATMOSPHERE_SHELL_FADE_IN_M = 15_000;
/**
 * The map's detail fit (Game.fitMapDetail): how often it looks, how far one
 * step moves the cut, and the share of the budget under which it refines.
 * A step changes the tile count by about its square (1.56x), so after a
 * finer step from under half the budget the view is still inside it.
 */
const MAP_DETAIL_CHECK_MS = 1000;
const MAP_DETAIL_STEP = 1.25;
const MAP_DETAIL_FINER_BELOW = 0.5;
const MAP_DETAIL_SCALE_MAX = 8;
/** The map's time of day, hours; see Game.enterMapView. */
const MAP_SUN_HOURS = 12;
/** Altitude by which the shell's sky has wholly replaced the dome. */
const SHELL_SKY_FULL_M = 30_000;
/**
 * Exposure boost for the shell's open sky while the camera is still in the
 * stratosphere, falling to none by SHELL_SKY_GAIN_END_M. The shell's exposure
 * is set for the planet seen from orbit, which leaves the sky above 25 km
 * near black where it should still be a deep blue over a bright horizon band.
 */
const SHELL_SKY_GAIN = 16;
const SHELL_SKY_GAIN_START_M = 25_000;
const SHELL_SKY_GAIN_END_M = 80_000;
/**
 * The globe map takes over from the baked tiles between these heights (m):
 * from that far out the coarse tiles are flat facets, and the map is better.
 */
const GLOBE_MAP_FADE_START_M = 35_000;
const GLOBE_MAP_FADE_END_M = 60_000;
/** How long the terrain backlog must stay empty before the boot blur lifts; see Game.holdUntilStreamed. */
const STREAM_SETTLE_MS = 600;
/** The boot blur lifts after this even if streaming never goes quiet (a failing tile, a slow link). */
const STREAM_HOLD_MAX_MS = 20_000;
/** Seconds counted down, still paused, once streaming has settled; "Go" follows. */
const STREAM_COUNTDOWN_FROM = 3;
/** How long "Go" stays up over the running flight. */
const STREAM_GO_SHOWN_MS = 800;
/** Fastest the streaming bar may advance (fraction of full per second), so it sweeps rather than jumps. */
const STREAM_BAR_RATE_PER_S = 0.5;
/** Scratch for {@link Game.updateAtmosphereShell}. */
const SHELL_CENTRE = new THREE.Vector3();
const SHELL_AXIS = new THREE.Vector3();
const SHELL_REL = new THREE.Vector3();
const SHELL_STRETCHED = new THREE.Vector3();
const SHELL_MATRIX = new THREE.Matrix4();

/** Scratch for {@link Game.updateSunEntity}. */
const SUN_FACING = new THREE.Quaternion();

const CLOUD_BASE_ALTITUDE_M = 1400;
const CLOUD_ALTITUDE_VARIATION_M = 500;
/** High-altitude cirrus streak layer, just under HIGH_ALTITUDE_M — a separate, higher band above the cumulus deck. */
const CIRRUS_BASE_ALTITUDE_M = 9200;
const CIRRUS_ALTITUDE_VARIATION_M = 400;

const AI_OPPONENT_COUNT = 1;
/** Spawn distance ahead of the player when a same-heading merge begins (m). */
const AI_ENGAGE_SPAWN_DISTANCE_M = 300;
/** Spawn distance ahead of the player for a head-on merge (m). */
const AI_HEADON_SPAWN_DISTANCE_M = 3000;

/**
 * Height above the terrain (m) the wingman is spawned at while the player is
 * still on the ground: there is no wing slot to fly on a parked lead, so it
 * starts airborne and holds overhead until the player is rolling (see
 * {@link AiFlightPhase.FORMATION}).
 */
const WINGMAN_HOLD_ALTITUDE_AGL_M = 900;
/** The wingtip start: height above the ground (m), throttle, and where the wingman sits (m) off the player. */
const CLOSE_WING_ALTITUDE_AGL_M = 1500;
const CLOSE_WING_SPAWN_THROTTLE = 0.75;
const CLOSE_WING_SIDE_M = 4;
const CLOSE_WING_ABOVE_M = 2;
/** Airspeed (m/s) the wingman is spawned with when holding overhead. */
const WINGMAN_HOLD_SPEED_MPS = 180;
/** The scrambling wingman parks this far (m) behind the player on the runway ... */
const WINGMAN_SCRAMBLE_TRAIL_M = 100;
/** ... and up to this far (m) to its right, inside the runway edge. */
const WINGMAN_SCRAMBLE_SIDE_MAX_M = 15;
/** Opponents that take off do so from another airfield this far (m) from the player, at least ... */
const OPPONENT_FIELD_MIN_M = 8000;
/** ... and at most: further out the field may not be streamed in yet. */
const OPPONENT_FIELD_MAX_M = 40000;
/** An angle wrapped to [-pi, pi]. */
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Player/AI hit-sphere radius (m) — shared airframe. */
const PLAYER_HIT_RADIUS_M = 10;
/** Shared boresight gun for player and AI (same FM/FX airframe). */
const PLAYER_GUN: SimGunConfig = {
    muzzleVelocity: 1000,
    roundsPerSecond: 20,
    damage: 8,
    ammo: 2400,
    muzzleOffset: [0, 0, 9],
    spread: 0.003,
};

/** Legacy shipped packs kept out of the spawn menu when present in dist/. */
const EXCLUDED_PACK_IDS = new Set(['a4e', 'f16']);


const MAIN_RENDER_TARGET_HD = 'MAIN_RENDER_TARGET_HD';
const CANVAS_RENDER_TARGET_HD = 'CANVAS_RENDER_TARGET_HD';
const WEAPONSTARGET_RENDER_TARGET_HD = 'WEAPONSTARGET_RENDER_TARGET_HD';
/**
 * The target MFD is drawn at this fraction of the main view's pixel density
 * per axis and stretched onto its square. It is a full second scene pass, and
 * a small, low-detail display that reads fine at half resolution.
 */
const MFD_RENDER_SCALE = 0.5;

/**
 * Supersampling factor for the HD profile's 3D render targets, resolved for
 * free by the compose pass's existing linear upscale filter (mipmap-based -
 * see setUpscaleFilter()). 2x blends a full output pixel's width and reads
 * clearly as anti-aliasing; that is the quality bar this tapers down from,
 * never up.
 *
 * Fill-rate cost is quadratic in the supersample factor (2x is 4x the
 * fragments), so a flat factor gets worse exactly where native resolution is
 * already highest - measured at 17fps (~59ms/frame) at native 4K with a flat
 * 2x, ~3.5x over the 60fps budget, with draw calls and triangle counts far
 * too low to explain it (fill rate, not geometry). Tapering to native by 4K
 * removes that same ~4x, and native pixel density there already suppresses
 * most of what the supersample exists to fix - the tuned 2x look is kept
 * intact through 1440p, where the fill-rate budget still affords it.
 */
function hdSupersampleScale(width: number, height: number): number {
    const megapixels = (width * height) / 1e6;
    if (megapixels <= 2.3) return 2;   // up to ~1440p: full tuned quality
    if (megapixels <= 4.5) return 1.5; // ~1440p-1800p transition band
    return 1;                          // 4K and above: native, no supersample
}

const AIRBASE_RUNWAY = new THREE.Vector3(AIRBASE_RUNWAY_RAW.x, AIRBASE_RUNWAY_RAW.y, AIRBASE_RUNWAY_RAW.z);
const RUNWAY_SPAWN_INSET_M = 120;
/** Paved runway strip only — biome patches fill the shoulders beside it. */
const RUNWAY_STRIP_HALF_WIDTH = 75;
/** Half-width of the physical pavement, matching assets/runway01.gltf (±40 m). */
const RUNWAY_PAVEMENT_HALF_WIDTH = 40;
/** Skirt around pad edges blending down to the surrounding ground — no hard vertical lip. */
const SURFACE_PAD_FEATHER_M = 15;
/**
 * How far around an airfield its height tiles are pinned before its taxiways
 * are draped. Wide enough for the taxiway network of a large field, which
 * reaches well past the runway strips the bake flattened.
 */
const AIRFIELD_GROUND_RADIUS_M = 4000;
/**
 * Airfields are built - pavement, buildings, target - only within this of the
 * aircraft (or of the spawn airfield, at boot), and streamed in as it flies.
 * An area can hold hundreds of them: building all 518 of DACH at boot took
 * five minutes and 2 GB.
 */
const AIRFIELD_STREAM_RADIUS_M = 50_000;
/**
 * How far the aircraft may fly from the scene origin before the origin moves
 * under it (see Game.maybeRebase). The frame's vertical leans a degree per
 * 111 km, so this keeps the horizon within 0.18 degrees of level.
 */
const REBASE_DISTANCE_M = 20_000;
/** How often the aircraft's position is checked for airfields to stream in. */
const AIRFIELD_STREAM_INTERVAL_MS = 1000;
/** Edge softening on a building's roof pad. A wall is a step, not a ramp. */
const BUILDING_PAD_FEATHER_M = 0.5;
/**
 * A building streamed in mid-flight gets no collider while an aircraft is
 * over its footprint lower than this above its roof (see aircraftUnder).
 */
const BUILDING_STREAM_CLEARANCE_M = 50;
/** Hangar-ground pavement half extent: lib:pavement unit square × scale 200. */
const HANGAR_GROUND_HALF_M = 100;
/** Kuznetsov carrier origin — open water (matches {@link ARRESTOR_CARRIER_ORIGIN}). */
const KUZ_POSITION = new THREE.Vector3(
    ARRESTOR_CARRIER_ORIGIN.x,
    ARRESTOR_CARRIER_ORIGIN.y,
    ARRESTOR_CARRIER_ORIGIN.z,
);
const KUZ_IDENTITY_QUAT = new THREE.Quaternion();
/** How far the carrier model is lifted so its draft reads ~10 m, not the mesh's 15 m. */
const KUZ_HULL_RAISE_M = 4;
/**
 * Carrier hull AABB from `assets/kuz.glb` (approx).
 * Used for approach spawn alignment along the deck axis.
 */
const KUZ_HULL = {
    minX: -34.33,
    maxX: 43.83,
    minZ: -177.88,
    maxZ: 124.28,
};
/** Lateral centreline of the carrier deck relative to {@link KUZ_POSITION}. */
const KUZ_DECK_MID_X = (KUZ_HULL.minX + KUZ_HULL.maxX) * 0.5;
/** Approximate flat-deck height for approach altitude planning (m). */
const CARRIER_DECK_Y = 14;
/** Final approach distance to the carrier stern threshold (m). */
const CARRIER_APPROACH_FINAL_DISTANCE_M = 3500;
/** Carrier final altitude (m); ~3° glide to the deck over {@link CARRIER_APPROACH_FINAL_DISTANCE_M}. */
const CARRIER_APPROACH_ALTITUDE_M = CARRIER_DECK_Y + 183;
const PLAYER_STARTING_HEADING = 0;
/** Land approach final distance — keep the airport in view at spawn. */
const LAND_APPROACH_FINAL_M = 4500;
/** Boot / respawn DEM + mesh preload radius around the plane (m). */
const TERRAIN_PRELOAD_RADIUS_M = 30000;
/** Radius of the fine DEM the sim worker is given around each aircraft (m). */
const SIM_TERRAIN_MIRROR_RADIUS_M = 12000;
/** Mirror this far ahead of the player, so a fast run-in cannot outpace it (s). */
const SIM_TERRAIN_MIRROR_LEAD_S = 30;
/** Seconds between mirror refreshes. */
const SIM_TERRAIN_MIRROR_INTERVAL_S = 0.25;
/** High-alt seed: fine DEM zoom over a wider disk than approach (m). */
const HIGH_ALT_PRELOAD_RADIUS_M = 50000;
/** Outer coarse ring so the forward horizon is not an empty void (m). */
const HIGH_ALT_OUTER_RADIUS_M = 120000;
const HIGH_ALT_OUTER_ZOOM = 8;
/** Nominal approach spawn (Y updated at flight start from DEM). */
const PLAYER_STARTING_POSITION = new THREE.Vector3(
    AIRBASE_RUNWAY.x,
    APPROACH_ALTITUDE_M,
    AIRBASE_RUNWAY.z - LAND_APPROACH_FINAL_M,
);
/** Mission AI flights fly routes, not fights (see startMission). */
const MISSION_PILOT: AiPilotOptions = { cruiseAltitude: 3000, cruiseSpeed: 200, hardDeck: 150 };
/** Line-up spot past a runway's threshold, and the gap between aircraft queued behind it (m). */
const MISSION_LINEUP_M = 150;
const MISSION_RUNWAY_SPACING_M = 120;
/** Seconds between AI take-offs from one runway end. */
const MISSION_TAKEOFF_GAP_S = 20;
const PLAYER_LAND_SPAWN: PlayerSpawnState = {
    throttle: 0,
    airborne: false,
};
const PLAYER_APPROACH_SPAWN: PlayerSpawnState = {
    velocity: FORWARD.clone().applyAxisAngle(UP, PLAYER_STARTING_HEADING).multiplyScalar(APPROACH_SPEED_MPS),
    throttle: 0.38,
    airborne: true,
};
const PLAYER_SPACE_SPAWN: PlayerSpawnState = {
    velocity: FORWARD.clone().applyAxisAngle(UP, PLAYER_STARTING_HEADING).multiplyScalar(APPROACH_SPEED_MPS),
    throttle: 1,
    airborne: true,
};

/** Height above the ground of a start over a searched place (m). */
const LOCATION_SPAWN_AGL_M = 600;
/** North: scene headings face +Z at 0, and north is scene -Z. */
const LOCATION_SPAWN_HEADING = Math.PI;

/** Kuznetsov cruise speed (45 km/h → m/s), bow heading world −Z at identity. */
const CARRIER_SPEED_KMH = 45;
const CARRIER_SPEED_MPS = CARRIER_SPEED_KMH / 3.6;

/** Carrier landing: final toward the ski-jump bow along -Z. */
const PLAYER_CARRIER_HEADING = Math.PI;
/** Within this of the ship (m), with the barricade going up or standing, the player's drawn airframe goes to the sim for the webbing. */
const BARRICADE_AIRFRAME_BAKE_M = 3000;

/**
 * Barricade spawn: in the groove, {@link CARRIER_GROOVE_DISTANCE_M} astern of
 * the ramp, hook stowed and the net already across the deck. Under two seconds
 * of flying, which is the whole point — a hook-failure arrival, with none of
 * the 2.5 km pattern in front of it.
 */
const CARRIER_GROOVE_DISTANCE_M = 20;
/**
 * On-speed, not the 400 km/h the other airborne spawns transit at: from here
 * there is no room to slow down, and the flight model wrecks any touchdown
 * above its landing envelope (90 m/s / 324 km/h — see
 * `F16_PROFILE.landingMaxSpeedMps`).
 */
const CARRIER_GROOVE_SPEED_KMH = 250;
const CARRIER_GROOVE_SPEED_MPS = CARRIER_GROOVE_SPEED_KMH / 3.6;
/**
 * Spawn height: level, the wheels 3.5 m over the deck (the CG rides ~2.05 m
 * above it on the gear), which clears the ramp and then lets the jet settle.
 *
 * Hands off, the FCS lets the nose fall to near zero AoA, which at approach
 * speed holds up only about half the weight: the jet sinks away from where it
 * points at ~5 m/s², and the sink keeps growing until it meets the deck. So it
 * must meet it early. A 3° path aimed at the webbing met the deck ~30 m short
 * at 8.2 m/s, past the gear's 8 m/s limit; aimed higher it only met it later
 * and harder (9–10 m/s, before or just after the net). From this height the
 * wheels touch ~1 s in, ~70 m short of the net, at ~6 m/s, and roll into it.
 */
const CARRIER_GROOVE_ALTITUDE_M = BARRICADE_DECK_Y + 2.05 + 3.5;

/** On-deck takeoff: 120 m aft of the bow tip, facing the ski jump (-Z). */
const CARRIER_TAKEOFF_FROM_BOW_M = 120;
const PLAYER_CARRIER_TAKEOFF_HEADING = Math.PI;
const PLAYER_CARRIER_TAKEOFF_LOCAL_Z = KUZ_HULL.minZ + CARRIER_TAKEOFF_FROM_BOW_M;

enum PlayerViewState {
    CRASHED,
    COCKPIT_FRONT,
    EXTERIOR_BEHIND,
    EXTERIOR_FRONT,
    EXTERIOR_LEFT,
    EXTERIOR_RIGHT,
    TARGET_TO,
    TARGET_FROM,
    STATIC_MODEL,
    AI_CHASE,
    CARRIER_OVER_STERN,
    SHOWCASE,
    /** Nailed to a place from the URL, see cameraRoute.ts. */
    FIXED,
}

/**
 * Fixed-camera handling: a held arrow / page key starts slow and doubles its
 * speed every second up to the cap; numpad turns ease to a fixed rate.
 */
const FIXED_CAMERA_TUNING: FixedCameraTuning = {
    startMps: 20,
    maxMps: 3000,
    growthPerS: 2,
    turnDegPerS: 45,
    easeS: 0.3,
};
/** How often the page URL follows a moving fixed camera. */
const FIXED_CAMERA_URL_INTERVAL_S = 0.5;
/** How often the page URL follows the camera in flight. */
const FLIGHT_CAMERA_URL_INTERVAL_S = 1;
const FIXED_CAMERA_MOVE_KEYS = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown',
    'Numpad4', 'Numpad6', 'Numpad8', 'Numpad2',
]);

enum GameState {
    SPAWN_MENU,
    PLAYER,
    /** Looking from the URL's fixed camera; sim paused, Escape opens the menu over it. */
    FIXED_CAMERA,
}

interface ShowcaseHighlightState {
    object: THREE.Object3D;
    originalMaterial: THREE.Material | THREE.Material[];
}

// Numpad orbit: while held, the numpad grid moves the camera around the aircraft.
// 4/6 orbit left/right (yaw), 8/2 raise/lower the camera (elevation), the corners
// combine both, and 5 recenters. Each entry is a direction that gets integrated
// over time at ORBIT_RATE.
const NUMPAD_ORBIT_DIR: Record<string, { yaw: number, pitch: number }> = {
    Numpad4: { yaw: -1, pitch: 0 },
    Numpad6: { yaw: 1, pitch: 0 },
    Numpad8: { yaw: 0, pitch: -1 },
    Numpad2: { yaw: 0, pitch: 1 },
    Numpad7: { yaw: -1, pitch: -1 },
    Numpad9: { yaw: 1, pitch: -1 },
    Numpad1: { yaw: -1, pitch: 1 },
    Numpad3: { yaw: 1, pitch: 1 },
};

// Numpad zoom: while held, / zooms out and * zooms in by scaling the orbit radius.
const NUMPAD_ZOOM_DIR: Record<string, number> = {
    NumpadDivide: 1,
    NumpadMultiply: -1,
};

// Orbit speed in radians per second while a numpad key is held.
const ORBIT_RATE = Math.PI;

// Keep the elevation short of straight up/down so the orbit never gimbal-flips.
const ORBIT_PITCH_LIMIT = Math.PI / 2 - 0.05;

// Zoom speed (fraction of radius per second) and radius multiplier bounds.
const ZOOM_RATE = 1.5;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 5.0;

const COVER_CLASS_NAMES: Record<number, string> = {
    0: 'Unknown', 1: 'Forest', 2: 'Shrub', 3: 'Grass', 4: 'Cropland', 5: 'Built-up',
    6: 'Bare ground', 7: 'Snow / ice', 8: 'Water', 9: 'Wetland', 10: 'Mangrove',
    11: 'Moss / tundra', 12: 'Sand', 13: 'Open ground', 14: 'Heath',
};

export class GameUpdateTask implements KernelUpdateTask {

    constructor(private game: Game) { }

    update(delta: number) {
        this.game.update(delta);
    }
}

export class GameRenderTask implements KernelRenderTask {

    constructor(private game: Game) { }

    render() {
        this.game.render();
    }
}

export class Game {

    private state: GameState = GameState.SPAWN_MENU;

    private scene: Scene = new Scene();
    private readonly skiJumps: SkiJumpCollider[] = [];
    private readonly carrierMeshes: CarrierMeshCollider[] = [];
    /** Flat solid surfaces (runway strip, pavement pads); gear rests on them, not the terrain below. */
    private readonly surfacePads = new SurfacePadIndex();
    /** Every runway of this play area, longest first. Empty on an old pyramid. */
    private sceneRunways: SceneRunway[] = [];
    /** Arresting wires of this area's airfields, in scene coordinates (re-based with the scene). */
    private landWires: LandArrestorWire[] = [];
    /**
     * This area's OSM ski-jump ramps (Saki's T2). Kept apart from skiJumps,
     * which addAirBase empties for its own ramp, and put back there after it.
     */
    private osmSkiJumps: SkiJumpCollider[] = [];
    /** Every airfield of this play area with its scene position; built or not. */
    private areaAirfields: Array<{ airfield: Airfield; x: number; z: number }> = [];
    /** Airfields already built into the scene, or being built right now. */
    private readonly builtAirfields = new Set<Airfield>();
    private airfieldStreamBusy = false;
    /** Set once setupCombat has handed the static world to the sim worker. */
    private worldSent = false;
    private lastAirfieldStreamMs = 0;
    /**
     * Unpaved runways whose colour is not final: the finest terrain tile
     * under them has not been drawn yet, so they carry a stand-in or a coarse
     * tile's idea of the ground.
     */
    private pendingGroundStrips: GroundStrip[] = [];
    /**
     * The parked ramp slots, rebuilt once the session's runway is known. Empty
     * until then, which is before anything can ask to look at one.
     */
    private staticModelViews: StaticModelView[] = [];
    /**
     * ICAO the player picked in the spawn menu, honoured on the next flight.
     * Ignored when that airfield is not in the area being flown.
     */
    private preferredIcao: string | undefined;
    /** A search result picked in another area, carried over the reload into it. */
    private readonly pendingDestination: SpawnDestination | undefined = takePendingDestination();
    /**
     * The area's main airfield, chosen once at boot.
     *
     * The authored furniture — apron, hangars, tower, ramp, ski jump — is laid
     * out around this one and stays there, because it is placed into the scene
     * during setup and there is no path to pick it up again.
     *
     * Undefined only on a pyramid baked before airfields existed, and then the
     * authored airbase at the ENU origin stands in for it.
     */
    private homeRunway: SceneRunway | undefined;
    /**
     * The runway the player launches from: their spawn, their heading, and
     * where the ILS points by default. Follows the spawn menu's airfield
     * picker, so it can be somewhere other than {@link homeRunway} — a real
     * secondary field, with its own drawn pavement and no hangars.
     */
    private activeRunway: SceneRunway | undefined;
    /** Static scenery collision soups (hangars, tower, depots...); solid like the carrier deck. */
    private readonly sceneryMeshes: CarrierMeshCollider[] = [];
    /**
     * Baked scenery colliders held here until all scenery is placed, then moved
     * into {@link sceneryMeshes}. Keeps ground sampling during placement from
     * seeing earlier buildings and stacking later ones on their roofs.
     */
    private readonly stagedSceneryMeshes: CarrierMeshCollider[] = [];
    /** Geographic DEM / ocean terrain when `terrain=planet` (default). */
    private planetTerrain!: TerrainEntity;
    /** Atmospheric sky dome; disabled above {@link SPACE_SKY_ALTITUDE_M}. */
    private skyEntity: SimpleEntity | undefined;
    /** Its vertex colours, repainted from the atmosphere when the sun moves. */
    private skyDome: SkyDome | undefined;
    /** The atmosphere seen from outside, a full-screen pass that fades in with altitude. */
    private atmosphereShell: SimpleEntity | undefined;
    /** The sun's model; its bloom is repainted from the same sky painter. */
    private sunModel: Model | undefined;
    /** The sun disc; parked in the sun's direction by {@link updateSunEntity}. */
    private sunEntity: SimpleEntity | undefined;
    /** Puffy low-poly cloud deck; disabled above {@link SPACE_SKY_ALTITUDE_M} alongside the sky. */
    private cloudField: SceneryField | undefined;
    /** High-altitude cirrus streak layer; disabled above {@link SPACE_SKY_ALTITUDE_M} alongside the sky. */
    private cirrusField: SceneryField | undefined;
    /**
     * Excludes the cloud/cirrus decks from the weapons-target MFD's camera
     * pass — that pass already rebuilds the whole render list a second time
     * for a tiny picture-in-picture view, and paying full cloud-field LOD
     * cost again there is pure waste. Declared once (not inline per RenderLayer)
     * so it stays a stable function reference; reads cloudField/cirrusField
     * live via `this`, so field init order relative to setupScene() doesn't matter.
     */
    private readonly excludeSkyFieldsFilter = (entity: Entity): boolean =>
        entity !== this.cloudField && entity !== this.cirrusField && entity !== this.atmosphereShell;
    /** F9-toggled live FPS / draw-call / terrain-LOD readout. */
    private perfHud: PerfHudEntity | undefined;

    /** Baked area this session flies in; decides the ENU origin and the scenery. */
    private playArea!: ActivePlayArea;
    /** Every baked area, for the spawn search to place what it finds. */
    private areaList: TerrainArea[] = [];
    /** Edge-detect for {@link captureCrashProbe}. */
    private wasCrashed = false;
    private wasLanded = true;

    /** Live Kuznetsov entity; cables / trap physics / ILS follow its pose. */
    private kuz: GroundTargetEntity | undefined;
    /** The ship's emergency barricade (K rigs and strikes it). */
    private barricade: BarricadeEntity | undefined;
    /**
     * Set by a spawn: the snapshot still carries the last flight's catch
     * until the sim steps again, which is seconds while the spawn waits for
     * terrain. Believing it would spend the fresh webbing.
     */
    private barricadeStaleAfterSpawn = false;
    /** Rig state last told to the sim, so it is only re-sent on a change. */
    private barricadeSentArmed = false;
    private barricadeSentGeneration = -1;
    private barricadeSentWebbing = false;
    /** Which aircraft and rig generation the sim has the drawn airframe of, for the webbing. */
    private barricadeAirframeKey = '';
    private readonly syncedCarrierPos = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
    private readonly syncedCarrierQuat = new THREE.Quaternion(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
    /** World bow direction and velocity for the steaming carrier. */
    private readonly carrierBowDir = new THREE.Vector3(0, 0, -1);
    private readonly carrierVelocity = new THREE.Vector3();
    /** Cruise speed of the ship: zero when it is moored on land. */
    private carrierSpeedMps = CARRIER_SPEED_MPS;
    /**
     * The carrier's deck as ground that moves: wreckage, a lake of burning fuel
     * and scorch marks that come to rest on it go along with the ship.
     */
    private readonly carrierSurface: MovingSurface = {
        velocity: this.carrierVelocity,
        contains: (x, y, z) => {
            if (this.carrierMeshes.length === 0) {
                return false;
            }
            const deckY = sampleCarrierMeshSurfaceYMax(x, z, this.carrierMeshes);
            // Over the ship, and on it rather than high above it or below it.
            return Number.isFinite(deckY) && y - deckY < 5 && y - deckY > -3;
        },
    };
    private readonly obstacles: Obstacle[] = [];
    private weaponsField: WeaponsField | undefined;
    private debrisField: DebrisField | undefined;
    private wreckField: WreckField | undefined;
    private impactMarks: ImpactMarks | undefined;
    private damageSmoke: DamageSmokeField | undefined;
    /** Countdown before AI opponents leave STRAIGHT and enter ENGAGE. */
    private aiStraightTimer = 0;
    /** Ships DEM tiles to the sim worker so it collides against the drawn terrain. */
    private heightSender: HeightFieldSender | undefined;
    private heightMirrorTimer = 0;
    private readonly heightMirrorFocus: MirrorFocus[] = [];
    /** All AI opponents; `aiOpponent` is the first, used by chase cam / targeting. */
    private readonly aiOpponents: AiAircraftEntity[] = [];
    private aiOpponent: AiAircraftEntity | undefined;
    /** The player's AI wingman: same airframe, Faction.PLAYER, flies our wing. */
    private wingman: AiAircraftEntity | undefined;

    private playerCamera: SceneCamera;
    private targetCamera: SceneCamera;
    private cameraUpdaters: Map<PlayerViewState, CameraUpdater> = new Map();
    private cameraUpdater: CameraUpdater;
    private player: PlayerEntity;

    /** Endpoints the active palette is interpolated between, from the tech profile. */
    private noonPalette: Palette = HDNoonPalette;
    private midnightPalette: Palette = HDMidnightPalette;
    /** The two blended for the current time of day; see {@link daytimePalette}. */
    private palette: Palette = HDNoonPalette;

    private cockpitRenderLayersHd: RenderLayer[];
    private cockpitTargetRenderLayersHd: RenderLayer[];
    private exteriorRenderLayersHd: RenderLayer[];
    private showcaseRenderLayersHd: RenderLayer[];
    /** Weapons-target MFD is refreshed every Nth frame to cut dual-scene cost. */
    private targetMfdFrame = 0;
    private sunSkylineFrame = 0;

    private hdResolutionWidth = 0;
    private hdResolutionHeight = 0;
    /** Render scale the HD targets were last sized with (see updateHdResolution). */
    private hdRenderScale = 0;
    private hdSupersampling = false;
    /** Real pixels per viewport pixel of the main view, as last sized. */
    private hdMainScale = 1;

    private view: PlayerViewState = PlayerViewState.COCKPIT_FRONT;
    private viewBeforeShowcase: PlayerViewState | null = null;
    private staticModelIndex = 0;
    private staticModelCameraUpdater: StaticModelCameraUpdater;
    private fixedCameraUpdater: FixedCameraUpdater;
    /** The fixed camera asked for in the page URL, if any. */
    private cameraRoute: CameraRoute | undefined = cameraRouteFromLocation();
    /** Opened by F12 as the map: the fixed camera, looking straight down (mapView.ts). */
    private readonly mapMode = isMapViewPage();
    private mapView: MapView | undefined;
    /** The map's detail scale and when it was last checked; see fitMapDetail. */
    private mapDetailScale = 1;
    private mapDetailCheckMs = 0;
    /** Finest scale allowed for the current view: one that overflowed it stays its floor. */
    private mapDetailFloor = 1;
    private mapDetailView = -1;
    /** The map's centre on the ground; see placeMapCamera. */
    private mapCentre = { lat: 0, lon: 0 };
    /** The waypoint editor's routes over the map; see enterMapView. */
    private missionOverlay: MissionOverlay | undefined;
    /** The mission ?mission= named, flown once the boot's flight has begun (startMission). */
    private mission: Mission | undefined;
    /** Its AI flights, sim ids mf0.., built on first use and kept for the session (the sim never frees a row). */
    private readonly missionAircraft: AiAircraftEntity[] = [];
    /** The player's flight, and the waypoint its HUD cue points at. */
    private missionPlayer: { flight: Flight; next: number } | undefined;
    /** AI flights parked on a runway, and when each rolls, on {@link missionClock}. */
    private missionTakeoffs: Array<{ simId: string; at: number }> = [];
    private missionClock = 0;
    private readonly _missionPoint = new THREE.Vector3();
    /** Its ground point and local up, in scene space, as last placed. */
    private readonly mapGround = new THREE.Vector3();
    private readonly mapUp = new THREE.Vector3(0, 1, 0);
    private readonly _mapOffset = new THREE.Vector3();
    private readonly _mapRay = new THREE.Ray();
    private readonly _mapPlane = new THREE.Plane();
    /** Set while the boot spawns on its way to the URL's fixed camera; see boot. */
    private urlCameraPending = false;
    /** Arrow / page keys held while looking from the fixed camera. */
    private heldFixedCameraKeys: Set<string> = new Set();
    /** Eased fixed-camera rates: forward/right/up in m/s, yaw/pitch in deg/s. */
    private fixedCameraRates: FixedCameraRates = zeroFixedCameraRates();
    /** Seconds since the URL last followed the fixed camera; NaN when it is current. */
    private fixedCameraUrlAge = NaN;
    private _fixedCameraPos = new THREE.Vector3();
    /** Seconds since the URL last followed the camera in flight. */
    private flightCameraUrlAge = 0;
    private _flightCameraDir = new THREE.Vector3();

    // Numpad orbit: how far the camera is currently orbited around the aircraft,
    // relative to the active view's default position (yaw about world UP, pitch
    // about the horizontal axis). Both zero leaves the active camera untouched.
    private viewYaw: number = 0;
    private viewPitch: number = 0;
    private viewZoom: number = 1;
    /** F2 exterior view: numpad * toggles the camera to track the AI opponent. */
    private exteriorEnemyLock = false;
    private cockpitPadlock = false;
    /** The left/right MFD overlay, for the keys that flip its pages. */
    private cockpit: CockpitEntity | undefined;
    private aiChaseHeading = ExteriorViewHeading.BACK;
    private heldOrbitKeys = new Set<string>();
    /** A flight held by the settings dialog: it is open over it and nothing moves until it closes. */
    private menuPaused = false;

    /** Flight replay: the recorder runs for the whole flight, F4 plays it back. */
    private readonly recorder = new FlightRecorder();
    private readonly replayPlayer = new ReplayPlayer(this.recorder);
    private readonly replayPose = newReplayPose();
    private replaying = false;
    /** The whole game holds still under the blurred overlay while terrain streams in; see holdUntilStreamed. */
    private streamHeld = false;
    /** Bumped per hold, so a spawn during an older hold's wait takes it over. */
    private streamHoldToken = 0;
    /** False during setup(), before the kernel draws frames: a spawn then cannot hold, index.ts does it after start. */
    private kernelRunning = false;
    private _orbitPivot = new THREE.Vector3();
    private _orbitOffset = new THREE.Vector3();
    private _orbitAxis = new THREE.Vector3();
    private _debugDebrisVel = new THREE.Vector3();
    private _debugDebrisPos = new THREE.Vector3();
    private _damageSmokeVel = new THREE.Vector3();

    private cockpitEntities: Entity[] = [];
    private exteriorEntities: Entity[] = [];

    private spawnMenu: SpawnMenuEntity;
    private spawnPanel: SpawnPanel;

    private aircraftRegistry = new AircraftRegistry();
    private currentDef: FlyableAircraftDef;
    private selectedAircraftId = 'f22';
    private modUploadInput?: HTMLInputElement;
    private modImportInFlight = false;
    private modStatusToken?: symbol;
    private showcaseRaycaster = new THREE.Raycaster();
    private showcasePointerNdc = new THREE.Vector2();
    private showcasePointerInside = false;
    private showcasePointerDown = false;
    private showcaseHighlight: ShowcaseHighlightState | undefined;

    constructor(private configService: ConfigService, private models: ModelManager, private materials: SceneMaterialManager, private renderer: Renderer,
        private audio: AudioSystem, private combatSim: CombatSimClient) {

        this.playerCamera = new SceneCamera(new THREE.PerspectiveCamera(COCKPIT_FOV, H_RES / V_RES, PLANE_DISTANCE_TO_GROUND, COCKPIT_FAR));
        this.targetCamera = new SceneCamera(new THREE.PerspectiveCamera(COCKPIT_FOV, 1, PLANE_DISTANCE_TO_GROUND, COCKPIT_FAR));

        this.currentDef = buildF22Def();
        this.player = new PlayerEntity(this.models,
            this.currentDef,
            configService.flightModels.getActive(),
            this.materials,
            this.audio.getGlobal('assets/engine-loop-02.ogg', true),
            this.audio.getGlobal('assets/engine-loop-01.ogg', true),
            PLAYER_STARTING_POSITION, PLAYER_STARTING_HEADING);

        this.spawnMenu = new SpawnMenuEntity();
        this.spawnPanel = new SpawnPanel(
            (modelIndex) => this.selectAircraftModel(modelIndex),
            (liveryIndex) => this.selectAircraftLivery(liveryIndex),
            (icao) => this.selectAirfield(icao),
            (mode) => {
                // The Flight tab is reachable mid-flight too; go through the
                // menu first so the restart is the same as Esc then spawn.
                if (this.state !== GameState.SPAWN_MENU) {
                    this.enterSpawnMenu();
                }
                void this.beginFlight(mode);
            },
            (destination) => this.goToDestination(destination),
            () => this.pauseForMenu(),
            () => this.resumeFromMenu(),
        );

        this.cameraUpdaters.set(PlayerViewState.CRASHED, new CrashedCameraUpdater(this.player, this.playerCamera.main));
        this.cameraUpdaters.set(PlayerViewState.COCKPIT_FRONT, new CockpitFrontCameraUpdater(this.player, this.playerCamera.main));
        this.cameraUpdaters.set(PlayerViewState.EXTERIOR_BEHIND, new ExteriorFrontBehindCameraUpdater(this.player, this.playerCamera.main, ExteriorViewHeading.FRONT));
        this.cameraUpdaters.set(PlayerViewState.EXTERIOR_FRONT, new ExteriorFrontBehindCameraUpdater(this.player, this.playerCamera.main, ExteriorViewHeading.BACK));
        this.cameraUpdaters.set(PlayerViewState.EXTERIOR_LEFT, new ExteriorSideCameraUpdater(this.player, this.playerCamera.main, ExteriorViewSide.LEFT));
        this.cameraUpdaters.set(PlayerViewState.EXTERIOR_RIGHT, new ExteriorSideCameraUpdater(this.player, this.playerCamera.main, ExteriorViewSide.RIGHT));
        this.cameraUpdaters.set(PlayerViewState.TARGET_TO, new TargetToCameraUpdater(this.player, this.playerCamera.main));
        this.cameraUpdaters.set(PlayerViewState.TARGET_FROM, new TargetFromCameraUpdater(this.player, this.playerCamera.main));
        this.staticModelCameraUpdater = new StaticModelCameraUpdater(this.player, this.playerCamera.main);
        this.cameraUpdaters.set(PlayerViewState.STATIC_MODEL, this.staticModelCameraUpdater);
        this.cameraUpdaters.set(PlayerViewState.CARRIER_OVER_STERN, new CarrierOverSternCameraUpdater(this.player, this.playerCamera.main));
        this.cameraUpdaters.set(PlayerViewState.SHOWCASE, new ShowcaseCameraUpdater(this.player, this.playerCamera.main));
        this.fixedCameraUpdater = new FixedCameraUpdater(this.player, this.playerCamera.main);
        this.cameraUpdaters.set(PlayerViewState.FIXED, this.fixedCameraUpdater);
        this.cameraUpdater = this.getCameraUpdater(this.view);
        this.configService.techProfiles.addChangeListener(profile => {
            this.updateHdResolution();
            this.renderer.setUpscaleFilter(true);
            this.noonPalette = profile.noonPalette;
            this.midnightPalette = profile.midnightPalette;
            this.materials.setFog(profile.fogQuality);
            this.materials.setShadingType(profile.shading);
            this.refreshDaytimePalette();
            this.renderer.setTextEffect(profile.textEffect);
        });
        this.configService.renderScale.addChangeListener(() => this.updateHdResolution());
        this.configService.supersampling.addChangeListener(() => this.updateHdResolution());
        this.configService.daytime.addChangeListener(hours => {
            // Moves the sun for the shaded ramp and the planform silhouettes, then
            // rebuilds the sky/terrain palette that goes with it.
            setSunTime(hours);
            this.refreshDaytimePalette();
            this.updateSunEntity();
        });
        this.configService.flightModels.addChangeListener(flightModel => {
            flightModel.activate();
            this.player.setFlightModel(flightModel);
            flightModel.setAircraft(flightConfigWithArrestorHook(this.currentDef));
            // The worker rebuilds the model from the aircraft config alone, which
            // drops the collision mesh; send it again.
            this.pushAircraftMeshes(PLAYER_SIM_ID, this.currentDef);
            // FM2, FM3 and DEBUG are simulated in the combat worker. A model that is not
            // sim-owned has the sim's player aircraft disabled and its state
            // injected as an external combatant (see update) for AI targeting.
            const simOwned = flightModel instanceof SimProxyFlightModel;
            this.combatSim.setEnabled(PLAYER_SIM_ID, simOwned);
            if (simOwned) {
                this.combatSim.clearExternalState(PLAYER_SIM_ID);
            }
        })

        const playerLayersHd: RenderLayer[] = [
            {
                target: MAIN_RENDER_TARGET_HD,
                camera: this.playerCamera.bgSky,
                lists: [SceneLayers.BackgroundSky]
            },
            {
                target: MAIN_RENDER_TARGET_HD,
                camera: this.playerCamera.bgGround,
                lists: [SceneLayers.BackgroundGround]
            },
            {
                target: MAIN_RENDER_TARGET_HD,
                camera: this.playerCamera.main,
                lists: [SceneLayers.Terrain, SceneLayers.EntityFlats, SceneLayers.EntityVolumes, SceneLayers.EntityFX]
            },
            {
                target: MAIN_RENDER_TARGET_HD,
                camera: this.playerCamera.bgSky,
                lists: [SceneLayers.ForegroundSky],
                // The glare veils the scene rather than replacing it, so it needs
                // the depth the main pass just wrote - read back through that
                // camera's far plane, not the background one's.
                sceneDepthFrom: this.playerCamera.main
            }
        ];
        const targetLayersHd: RenderLayer[] = [
            {
                target: WEAPONSTARGET_RENDER_TARGET_HD,
                camera: this.targetCamera.bgSky,
                lists: [SceneLayers.BackgroundSky]
            },
            {
                target: WEAPONSTARGET_RENDER_TARGET_HD,
                camera: this.targetCamera.bgGround,
                lists: [SceneLayers.BackgroundGround]
            },
            {
                target: WEAPONSTARGET_RENDER_TARGET_HD,
                camera: this.targetCamera.main,
                lists: [SceneLayers.Terrain, SceneLayers.EntityFlats, SceneLayers.EntityVolumes, SceneLayers.EntityFX],
                entityFilter: this.excludeSkyFieldsFilter
            },
            {
                target: WEAPONSTARGET_RENDER_TARGET_HD,
                camera: this.targetCamera.bgSky,
                lists: [SceneLayers.ForegroundSky],
                // The glare veils the scene rather than replacing it, so it needs
                // the depth the main pass just wrote - read back through that
                // camera's far plane, not the background one's.
                sceneDepthFrom: this.targetCamera.main
            }
        ];
        const canvasLayersHd: RenderLayer[] = [
            {
                target: CANVAS_RENDER_TARGET_HD,
                camera: this.playerCamera.main,
                lists: [SceneLayers.Overlay]
            }
        ];
        this.cockpitRenderLayersHd = [...playerLayersHd, ...canvasLayersHd];
        this.cockpitTargetRenderLayersHd = [...playerLayersHd, ...targetLayersHd, ...canvasLayersHd];
        this.exteriorRenderLayersHd = [...playerLayersHd, ...canvasLayersHd];
        const showcaseLayersHd: RenderLayer[] = [
            {
                target: MAIN_RENDER_TARGET_HD,
                camera: this.playerCamera.main,
                lists: [SceneLayers.EntityFlats, SceneLayers.EntityVolumes, SceneLayers.EntityFX],
                palette: ShowcasePalette,
            }
        ];
        this.showcaseRenderLayersHd = showcaseLayersHd;
    }

    async setup() {
        setBootProgress(5, 'Initializing renderer...');
        if (this.mapMode) {
            // Before any tile binds its texture: see setCoverUnderlay.
            setCoverUnderlay(true);
        }

        this.renderer.setPalette(this.getPalette());
        this.materials.setPalette(this.getPalette());
        this.setupControls();
        setBootProgress(15, 'Loading aircraft packs...');
        await this.loadPersistedPacks();
        const missionId = this.mapMode ? null : new URLSearchParams(location.search).get('mission');
        if (missionId) {
            try {
                this.mission = await loadMission(missionId);
            } catch (err) {
                console.error(`Mission ${missionId} could not be loaded`, err);
            }
            // Made in another area: that area's terrain, then the mission.
            if (this.mission?.area && this.mission.area !== loadSettings().terrainArea) {
                updateSettings({ terrainArea: this.mission.area });
                window.location.reload();
                return;
            }
        }
        const settings = loadSettings();
        setBootProgress(25, 'Building scene...');
        await this.setupScene(settings.spawnMode);
        this.selectAircraftById(settings.aircraftId, 'f22');
        setBootProgress(90, 'Loading aircraft...');
        // beginFlight's spawn overwrites this.cameraRoute with the spawn's
        // own pose (see syncSpawnCameraUrl), so the URL's route has to be
        // captured before that call to still know whether to boot into it.
        const urlCameraRoute = this.cameraRoute;
        const pending = this.pendingDestination;
        // The boot's spawn must not write its own pose over a URL camera it
        // is about to hand over to: the address bar showed the base airfield
        // for the rest of the session.
        this.urlCameraPending = urlCameraRoute !== undefined;
        // A mission's player starts where its flight does: stream the terrain there.
        const missionPlayer = this.mission?.flights.find(f => f.control === 'player');
        if (missionPlayer) {
            this.selectAircraftById(missionPlayer.aircraftId, settings.aircraftId);
        }
        await this.beginFlight(settings.spawnMode, missionPlayer
            ? { lat: missionPlayer.start.lat, lon: missionPlayer.start.lon }
            : pending !== undefined && pending.kind !== 'airfield' ? pending : undefined);
        this.urlCameraPending = false;
        if (urlCameraRoute) {
            this.enterFixedCamera(urlCameraRoute);
            if (this.mapMode) {
                this.enterMapView();
            }
        }
        // The map fills in as its tiles arrive; there is no flight to hold for.
        if (!this.mapView) {
            await this.waitForRequiredTerrain(90, 99);
        }
        if (this.mission) {
            await this.startMission(this.mission);
        }
        setBootProgress(100, 'Ready');
        window.addEventListener('resize', () => this.onViewportResize());
    }

    private aircraftModelGroups() {
        return groupAircraftByModel([...this.aircraftRegistry.list()]);
    }

    private selectedAircraftDef(): FlyableAircraftDef | undefined {
        return this.aircraftRegistry.get(this.selectedAircraftId)
            ?? this.aircraftModelGroups()[0]?.variants[0];
    }

    private findSelectionIndices(id: string): { modelIndex: number; liveryIndex: number } {
        const groups = this.aircraftModelGroups();
        for (let modelIndex = 0; modelIndex < groups.length; modelIndex++) {
            const liveryIndex = groups[modelIndex].variants.findIndex(def => def.id === id);
            if (liveryIndex >= 0) {
                return { modelIndex, liveryIndex };
            }
        }
        return { modelIndex: 0, liveryIndex: 0 };
    }

    private refreshAircraftMenu() {
        const groups = this.aircraftModelGroups();
        const def = this.selectedAircraftDef();
        if (def) {
            this.selectedAircraftId = def.id;
        }
        const { modelIndex, liveryIndex } = this.findSelectionIndices(this.selectedAircraftId);
        this.spawnPanel.setSelection(groups, modelIndex, liveryIndex);
    }

    /** Load aircraft packs produced by prior F10 imports (survives page reload / rebuild). */
    private async loadPersistedPacks(): Promise<void> {
        try {
            const res = await fetch('/api/aircraft-packs');
            if (!res.ok) {
                return;
            }
            const packs: { id: string; packUrl: string }[] = await res.json();
            await Promise.all(
                packs
                    .filter(p => !EXCLUDED_PACK_IDS.has(p.id))
                    .map(async p => {
                        this.models.invalidatePack(p.id);
                        return this.aircraftRegistry.loadPack(p.id, p.packUrl);
                    }),
            );
        } catch {
            // No modserver (static hosting) — built-in packs only.
        }
    }

    /** Wait for an aircraft's glTF parts to finish loading before first render. */
    private async preloadAircraftModels(def: FlyableAircraftDef): Promise<void> {
        const urls = [
            def.body,
            def.shadow,
            ...(def.gear ? [def.gear] : []),
            ...(def.collision ? [def.collision] : []),
            ...def.surfaces.map(s => s.model),
        ];
        await Promise.all(urls.map(url => this.models.waitForModel(url)));
    }

    private selectAircraftModel(modelIndex: number, liveryIndex = 0): void {
        const groups = this.aircraftModelGroups();
        const group = groups[modelIndex];
        if (!group) {
            return;
        }
        const variant = group.variants[Math.min(liveryIndex, group.variants.length - 1)];
        this.selectedAircraftId = variant.id;
        this.refreshAircraftMenu();
        this.persistSpawnSelection();
    }

    private selectAircraftLivery(liveryIndex: number): void {
        const { modelIndex } = this.findSelectionIndices(this.selectedAircraftId);
        this.selectAircraftModel(modelIndex, liveryIndex);
    }

    private selectAircraftById(id: string, fallbackId?: string): void {
        if (this.aircraftRegistry.get(id)) {
            this.selectedAircraftId = id;
        } else if (fallbackId && this.aircraftRegistry.get(fallbackId)) {
            this.selectedAircraftId = fallbackId;
        }
        this.refreshAircraftMenu();
        this.persistSpawnSelection();
    }

    private persistSpawnSelection(spawnMode?: SpawnMode): void {
        updateSettings({
            aircraftId: this.selectedAircraftId,
            ...(spawnMode !== undefined ? { spawnMode } : {}),
        });
    }

    /** Hand the sim the hitbox for a given airframe. */
    private pushAircraftMeshes(simId: string, def: FlyableAircraftDef): void {
        this.combatSim.setCollision(simId, def.collisionMesh);
        // And the barricade webbing's hull for it (see pushBarricadeHull).
        this.pushBarricadeHull(simId, def);
    }

    /** The physics the combat sim should run for the player: the active sim-owned model's. */
    private playerSimModelKind(): SimFlightModelKind {
        const active = this.configService.flightModels.getActive();
        return active instanceof SimProxyFlightModel ? active.modelKind : 'fm2';
    }

    /** Swap the player (and AI opponents) to the aircraft chosen in the spawn menu. */
    private applySelectedAircraft() {
        const def = this.selectedAircraftDef();
        if (!def || def.id === this.currentDef.id) {
            return;
        }
        this.currentDef = def;
        this.player.loadAircraft(def);
        this.configService.flightModels.getActive().setAircraft(flightConfigWithArrestorHook(def));
        this.pushAircraftMeshes(PLAYER_SIM_ID, def);
        // Same airframe for AI — only the control channel differs.
        for (let i = 0; i < this.aiOpponents.length; i++) {
            this.aiOpponents[i].loadAircraft(def);
            this.pushAircraftMeshes(this.aiOpponents[i].simId, def);
        }
        if (this.wingman) {
            this.wingman.loadAircraft(def);
            this.pushAircraftMeshes(this.wingman.simId, def);
        }
    }

    /** F10: open a file picker to upload a Unity mod .zip for import. */
    private triggerModImport(): void {
        if (this.modImportInFlight) {
            return;
        }
        if (!this.modUploadInput) {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.zip';
            input.style.display = 'none';
            input.addEventListener('change', () => {
                const file = input.files && input.files[0];
                input.value = '';
                if (file) {
                    void this.importModFromFile(file);
                }
            });
            document.body.appendChild(input);
            this.modUploadInput = input;
        }
        this.modUploadInput.click();
    }

    /** Upload the mod to the dev server, register the imported plane(s), and open the menu. */
    private async importModFromFile(file: File): Promise<void> {
        this.modImportInFlight = true;
        this.setModStatus(
            file.size > 20_000_000
                ? `Importing all liveries from ${file.name} (may take several minutes)...`
                : `Importing all liveries from ${file.name}...`,
            0,
        );
        try {
            const healthRes = await fetch('/api/health').catch(() => null);
            if (!healthRes?.ok) {
                this.setModStatus(
                    'Import unavailable: run npm run serve (or npm start) and open http://localhost:8020.',
                );
                return;
            }

            const form = new FormData();
            form.append('mod', file);
            const res = await fetch('/api/import-mod', { method: 'POST', body: form });
            await this.finishModImportResponse(res);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.setModStatus(`Import failed: ${msg}`);
        } finally {
            this.modImportInFlight = false;
        }
    }

    private async finishModImportResponse(res: Response): Promise<void> {
        let data: { ok?: boolean; error?: string; log?: string; imported?: { id: string; name: string; packUrl: string }[] };
        try {
            data = await res.json();
        } catch {
            this.setModStatus(`Import failed: unexpected response (HTTP ${res.status}).`);
            return;
        }

        if (!res.ok || !data.ok) {
            const msg = data.error || `HTTP ${res.status}`;
            this.setModStatus(`Import failed: ${msg}`);
            if (data.log) {
                console.warn('[mod import]\n' + data.log);
            }
            return;
        }

        const imported: { id: string; name: string; packUrl: string }[] = data.imported ?? [];
        this.setModStatus(`Loading ${imported.length} aircraft pack(s)...`, 0);
        const registered: string[] = [];
        await Promise.all(imported.map(async (entry) => {
            this.models.invalidatePack(entry.id);
            const id = await this.aircraftRegistry.loadPack(entry.id, entry.packUrl);
            if (id) {
                registered.push(entry.name);
            }
        }));

        if (registered.length === 0) {
            this.setModStatus('Import failed: no aircraft could be loaded.');
            return;
        }

        this.refreshAircraftMenu();
        this.selectAircraftById(imported[0].id);
        const firstDef = this.aircraftRegistry.get(imported[0].id);
        if (firstDef) {
            this.setModStatus(`Loading models for ${firstDef.name}...`, 0);
            await this.preloadAircraftModels(firstDef);
        }
        this.setModStatus(`Imported: ${registered.join(', ')}. Select and fly from the menu.`, 20000);
        this.enterSpawnMenu();
    }

    /** Show a transient status message in the #mod-status overlay. */
    private setModStatus(text: string, autoHideMs = 8000): void {
        const el = document.getElementById('mod-status');
        if (!el) {
            return;
        }
        el.textContent = text;
        el.classList.remove('hidden');
        const token = Symbol();
        this.modStatusToken = token;
        if (autoHideMs > 0) {
            window.setTimeout(() => {
                if (this.modStatusToken === token) {
                    el.classList.add('hidden');
                }
            }, autoHideMs);
        }
    }

    private coverTooltipEl?: HTMLDivElement;
    private coverTooltipMoveAt = 0;
    private coverTooltipShown = false;
    private coverTooltipClient = { x: 0, y: 0 };
    private coverTooltipNdc = new THREE.Vector2();
    private coverTooltipRaycaster = new THREE.Raycaster();

    private onCoverTooltipMove(event: MouseEvent): void {
        this.coverTooltipMoveAt = performance.now();
        this.coverTooltipClient.x = event.clientX;
        this.coverTooltipClient.y = event.clientY;
        this.hideCoverTooltip();
    }

    private hideCoverTooltip(): void {
        if (this.coverTooltipShown && this.coverTooltipEl) {
            this.coverTooltipEl.classList.add('hidden');
        }
        this.coverTooltipShown = false;
    }

    /** After 2 s without mouse movement, names the land cover under the cursor. */
    private updateCoverTooltip(): void {
        if (this.coverTooltipShown || this.coverTooltipMoveAt === 0
            || performance.now() - this.coverTooltipMoveAt < 2000) {
            return;
        }
        // One attempt per rest; a new mouse move re-arms it.
        this.coverTooltipMoveAt = 0;
        const container = document.getElementById('container');
        if (!container || this.view === PlayerViewState.SHOWCASE) {
            return;
        }
        const rect = container.getBoundingClientRect();
        const px = this.coverTooltipClient.x - rect.left;
        const py = this.coverTooltipClient.y - rect.top;
        if (px < 0 || py < 0 || px > rect.width || py > rect.height
            || rect.width <= 0 || rect.height <= 0) {
            return;
        }
        this.coverTooltipNdc.set((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);
        const camera = this.playerCamera.main;
        this.coverTooltipRaycaster.setFromCamera(this.coverTooltipNdc, camera);
        const { origin, direction } = this.coverTooltipRaycaster.ray;
        const terrain = this.planetTerrain;
        // First t at which the ray is below a surface; height() returns
        // undefined where the surface has no answer (holes, undrawn tiles).
        const march = (height: (x: number, z: number) => number | undefined): number => {
            let lo = 0;
            let hi = -1;
            const below = (t: number) => {
                const h = height(origin.x + direction.x * t, origin.z + direction.z * t);
                return h !== undefined && origin.y + direction.y * t < h;
            };
            for (let t = 10; t <= 100_000; t += Math.max(10, t * 0.02)) {
                if (below(t)) {
                    hi = t;
                    break;
                }
                lo = t;
            }
            if (hi < 0) {
                return -1;
            }
            for (let i = 0; i < 20; i++) {
                const mid = (lo + hi) / 2;
                if (below(mid)) {
                    hi = mid;
                } else {
                    lo = mid;
                }
            }
            return hi;
        };
        const tDem = march((x, z) => terrain.heightAtWorld(x, z));
        if (tDem < 0) {
            return;
        }
        // The drawn land mesh has holes where water is, so a ray that reaches
        // the DEM well before it reaches drawn land is looking at water.
        const tLand = march((x, z) => terrain.drawnHeightAtWorld(x, z));
        const isWater = tLand < 0 || tLand > tDem * 1.05 + 20;
        const cover = isWater ? { cls: 8 } : terrain.drawnCoverAtWorld(
            origin.x + direction.x * tLand, origin.z + direction.z * tLand);
        if (cover === undefined) {
            return;
        }
        let el = this.coverTooltipEl;
        if (!el) {
            el = document.createElement('div');
            el.className = 'hidden';
            Object.assign(el.style, {
                position: 'fixed', zIndex: '5', pointerEvents: 'none', color: 'white',
                background: 'rgba(0,0,0,0.8)', border: '1px solid #8a8a8a',
                borderRadius: '0.25rem', padding: '0.25rem 0.6rem', fontSize: '0.85rem',
            });
            document.body.appendChild(el);
            this.coverTooltipEl = el;
        }
        el.textContent = COVER_CLASS_NAMES[cover.cls] ?? 'Unknown';
        el.style.left = `${this.coverTooltipClient.x + 14}px`;
        el.style.top = `${this.coverTooltipClient.y + 18}px`;
        el.classList.remove('hidden');
        this.coverTooltipShown = true;
    }

    private setShowcasePickLabel(text: string | null): void {
        const el = document.getElementById('showcase-pick');
        if (!el) {
            return;
        }
        if (!text || this.view !== PlayerViewState.SHOWCASE) {
            el.textContent = '';
            el.classList.add('hidden');
            return;
        }
        el.textContent = `Mesh: ${text}`;
        el.classList.remove('hidden');
    }

    private updateShowcasePointerFromEvent(event: MouseEvent): boolean {
        const container = document.getElementById('container');
        if (!container) {
            this.showcasePointerInside = false;
            return false;
        }
        const rect = container.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
        this.showcasePointerInside = inside;
        if (!inside || rect.width <= 0 || rect.height <= 0) {
            return false;
        }
        this.showcasePointerNdc.set(
            (x / rect.width) * 2 - 1,
            -(y / rect.height) * 2 + 1,
        );
        return true;
    }

    private applyShowcaseHighlight(object: THREE.Object3D | null): void {
        if (!object || !('material' in object)) {
            this.clearShowcaseHighlight();
            return;
        }
        if (this.showcaseHighlight?.object === object) {
            return;
        }
        this.clearShowcaseHighlight();
        const drawable = object as THREE.Mesh | THREE.LineSegments | THREE.Points;
        const originalMaterial = drawable.material;
        const clones = Array.isArray(originalMaterial)
            ? originalMaterial.map(m => m.clone())
            : originalMaterial.clone();

        const tint = (m: THREE.Material) => {
            if ('uniforms' in m) {
                const shader = m as THREE.ShaderMaterial;
                const uniforms = shader.uniforms as Record<string, { value: unknown }>;
                if (uniforms.color?.value instanceof THREE.Color) {
                    uniforms.color.value = new THREE.Color('#ffff66');
                }
                if (uniforms.colorSecondary?.value instanceof THREE.Color) {
                    uniforms.colorSecondary.value = new THREE.Color('#ffe066');
                }
            }
            if ('color' in m) {
                const mat = m as THREE.MeshBasicMaterial;
                if (mat.color) {
                    mat.color.set('#ffff66');
                }
            }
        };

        if (Array.isArray(clones)) {
            clones.forEach(tint);
            drawable.material = clones;
        } else {
            tint(clones);
            drawable.material = clones;
        }

        this.showcaseHighlight = { object, originalMaterial };
    }

    private clearShowcaseHighlight(): void {
        if (!this.showcaseHighlight) {
            return;
        }
        if ('material' in this.showcaseHighlight.object) {
            const drawable = this.showcaseHighlight.object as THREE.Mesh | THREE.LineSegments | THREE.Points;
            drawable.material = this.showcaseHighlight.originalMaterial;
        }
        this.showcaseHighlight = undefined;
    }

    private updateShowcasePicking(targetWidth: number): void {
        if (this.view !== PlayerViewState.SHOWCASE) {
            return;
        }
        if (!this.showcasePointerInside) {
            this.setShowcasePickLabel(null);
            if (!this.showcasePointerDown) {
                this.clearShowcaseHighlight();
            }
            return;
        }

        this.showcaseRaycaster.setFromCamera(this.showcasePointerNdc, this.playerCamera.main);
        const intersections = this.player.raycastShowcase(
            this.showcaseRaycaster,
            targetWidth,
            this.playerCamera.main,
            ShowcasePalette,
        );
        const hit = intersections.length > 0 ? intersections[0].object : null;
        this.setShowcasePickLabel(hit ? (hit.name || '(unnamed)') : null);

        if (this.showcasePointerDown) {
            this.applyShowcaseHighlight(hit);
        } else {
            this.clearShowcaseHighlight();
        }
    }

    private clearShowcasePickingState(): void {
        this.showcasePointerDown = false;
        this.showcasePointerInside = false;
        this.setShowcasePickLabel(null);
        this.clearShowcaseHighlight();
    }

    /** Horizontal ENU spawn of the plane (used for terrain preload before Y is known). */
    /**
     * The spawn actually usable in this area.
     *
     * Every area has an airbase now — the bake flattens a pad at the centre of
     * each — and every area has a carrier: off the coast where there is one,
     * moored on level ground where there is not (see `chooseCarrierSite`).
     */
    private spawnForArea(spawn: SpawnMode): SpawnMode {
        // The close-wingman start is an airborne start over the base: it loads the terrain as an approach does.
        if (spawn === 'closeWing') {
            return 'approach';
        }
        return spawn;
    }

    private spawnCenterEnu(spawn: SpawnMode): { x: number; z: number } {
        if (spawn === 'runway') {
            const p = this.runwaySpawnPosition();
            return { x: p.x, z: p.z };
        }
        if (spawn === 'carrier') {
            const p = this.carrierApproachSpawnPosition();
            return { x: p.x, z: p.z };
        }
        if (spawn === 'carrierBarricade') {
            const p = this.carrierBarricadeSpawnPosition();
            return { x: p.x, z: p.z };
        }
        if (spawn === 'carrierTakeoff') {
            const pose = this.carrierPose();
            return {
                x: pose.position.x + KUZ_DECK_MID_X,
                z: pose.position.z + PLAYER_CARRIER_TAKEOFF_LOCAL_Z,
            };
        }
        if (spawn === 'highAlt' || spawn === 'space') {
            const f = this.spawnFrame;
            return { x: f.centerX, z: f.centerZ };
        }
        // Approach and head-on.
        return this.onRunwayAxis(LAND_APPROACH_FINAL_M);
    }

    /** Pin the tiles around the plane so the spawn area cannot be evicted. */
    private async preloadTerrainAroundPlane(x: number, z: number, spawn?: SpawnMode): Promise<void> {
        const plan = this.terrainSeedPlan(spawn);
        for (const ring of plan.rings) {
            await this.planetTerrain.pinArea(
                x, z, ring.radiusM, ring.zoom ?? this.planetTerrain.maxZoom,
            );
        }
    }

    /**
     * After a spawn the pinned set is in, but the per-frame LOD pass still
     * asks for finer tiles, cover textures and roads for a few seconds. Hold
     * the whole game still under the blurred overlay until that backlog stays
     * empty for STREAM_SETTLE_MS (or STREAM_HOLD_MAX_MS passes), so the first
     * thing the player sees is the finished view rather than it popping in.
     * Needs the kernel running: LOD is chosen in render3D, which keeps
     * drawing while update() sits out the hold.
     *
     * With `stream` false (a respawn into terrain that is all resident) the
     * overlay and the wait are skipped and only the countdown runs.
     */
    async holdUntilStreamed(stream = true): Promise<void> {
        if (this.mapView) {
            // The map has no flight to hold still: it fills in as tiles arrive.
            this.kernelRunning = true;
            fadeOutBootProgress();
            return;
        }
        const token = ++this.streamHoldToken;
        this.streamHeld = true;
        this.kernelRunning = true;
        const wasPaused = !this.player.controlsEnabled;
        this.player.setSimulationPaused(true);
        if (stream) {
            await this.waitForStreamBacklog(token);
        }
        // A newer hold (another spawn) took over; it releases the game.
        if (token !== this.streamHoldToken) {
            return;
        }
        // The blur clears over the first second of a "get ready" count,
        // still paused; the flight starts on "Go". Unconditional: a resident
        // respawn can interrupt a hold whose blur is still up.
        fadeOutBootProgress();
        for (let n = STREAM_COUNTDOWN_FROM; n > 0; n--) {
            showCountdown(String(n));
            await new Promise(r => setTimeout(r, 1000));
            if (token !== this.streamHoldToken) {
                return;
            }
        }
        showCountdown('Go');
        setTimeout(() => {
            if (token === this.streamHoldToken) {
                hideCountdown();
            }
        }, STREAM_GO_SHOWN_MS);
        this.streamHeld = false;
        // Something else (a fixed camera from the URL, the menu) may have
        // wanted the flight paused all along; only undo our own pause.
        if (!wasPaused && this.state === GameState.PLAYER && !this.menuPaused) {
            this.player.setSimulationPaused(false);
        }
    }

    /** Whether the spawn's pin rings (see terrainSeedPlan) are all resident. */
    private isSeedAreaResident(x: number, z: number, spawn: SpawnMode): boolean {
        return this.terrainSeedPlan(spawn).rings.every(ring => this.planetTerrain.isAreaResident(
            x, z, ring.radiusM, ring.zoom ?? this.planetTerrain.maxZoom));
    }

    /** The streaming bar: resolves once the LOD backlog stays empty. */
    private async waitForStreamBacklog(token: number): Promise<void> {
        setBootStreaming(0, 'Streaming terrain... 0%');
        const start = performance.now();
        let idleSince: number | undefined;
        // The backlog grows as the LOD pass finds more to want, so a plain
        // backlog/peak ratio jumps back and forth. Count what drained instead,
        // never let the bar go backwards, and move it at a capped rate so it
        // reads as a steady sweep.
        let prevBacklog = 0;
        let drained = 0;
        let shown = 0;
        let lastTick = start;
        await new Promise<void>(resolve => {
            const tick = () => {
                if (token !== this.streamHoldToken) {
                    resolve();
                    return;
                }
                const now = performance.now();
                const backlog = this.planetTerrain.streamingBacklog;
                drained += Math.max(0, prevBacklog - backlog);
                prevBacklog = backlog;
                const target = backlog > 0 ? drained / (drained + backlog) : 1;
                const step = STREAM_BAR_RATE_PER_S * (now - lastTick) / 1000;
                lastTick = now;
                shown = Math.min(Math.max(shown, target), shown + step);
                // The label reads off the same smoothed value as the bar: the
                // raw backlog count rises and falls as the LOD pass finds work.
                setBootStreaming(100 * shown, `Streaming terrain... ${Math.floor(100 * shown)}%`);
                if (backlog > 0) {
                    idleSince = undefined;
                } else {
                    idleSince ??= now;
                }
                // Let the bar finish its sweep before clearing, so it never
                // vanishes at 70%.
                const settled = idleSince !== undefined && now - idleSince >= STREAM_SETTLE_MS && shown >= 1;
                if (settled || now - start >= STREAM_HOLD_MAX_MS) {
                    resolve();
                    return;
                }
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
    }

    private reportTerrainBootProgress(meshed: number, total: number, min: number, max: number): void {
        const frac = total > 0 ? meshed / total : 1;
        const pct = min + (max - min) * frac;
        const label = total > 0
            ? `Loading terrain (${meshed}/${total})...`
            : 'Loading terrain...';
        setBootProgress(pct, label);
    }

    private async waitForRequiredTerrain(min: number, max: number): Promise<void> {
        await this.planetTerrain.waitForPinned((done, total) => {
            this.reportTerrainBootProgress(done, total, min, max);
        });
        this.player.updateDisplayTransform();
        this.cameraUpdater.update(0);
        this.playerCamera.update();
        this.render();
    }

    /**
     * Prefetch radius + pin rings for the spawn altitude.
     * High-alt: dense DEM-max core (fullRes inland) + coarse outer ring.
     */
    private terrainSeedPlan(spawn?: SpawnMode): {
        prefetchRadiusM: number;
        rings: { radiusM: number; zoom?: number; dense?: boolean }[];
    } {
        const demMax = this.planetTerrain.maxZoom;
        if (spawn === 'highAlt' && demMax !== undefined) {
            return {
                prefetchRadiusM: HIGH_ALT_OUTER_RADIUS_M,
                rings: [
                    { radiusM: HIGH_ALT_OUTER_RADIUS_M, zoom: HIGH_ALT_OUTER_ZOOM },
                    { radiusM: HIGH_ALT_PRELOAD_RADIUS_M, zoom: demMax, dense: true },
                ],
            };
        }
        if (spawn === 'space' && demMax !== undefined) {
            return {
                prefetchRadiusM: HIGH_ALT_OUTER_RADIUS_M,
                rings: [{
                    radiusM: HIGH_ALT_OUTER_RADIUS_M,
                    zoom: terrainMaxZoomForAltitudeM(SPACE_ALTITUDE_M, demMax),
                }],
            };
        }
        return {
            prefetchRadiusM: TERRAIN_PRELOAD_RADIUS_M,
            rings: [{ radiusM: TERRAIN_PRELOAD_RADIUS_M }],
        };
    }

    /**
     * Where the base is and which way it faces, in scene space.
     *
     * The real runway when the bake found one, and otherwise the authored
     * airbase at the ENU origin — which is what every area had before the
     * airfields existed, and what an older pyramid still has.
     */
    private frameOf(r: SceneRunway | undefined): { centerX: number; centerZ: number;
        heading: number; halfLength: number; halfWidth: number; slope: number } {
        return r === undefined
            ? {
                centerX: AIRBASE_RUNWAY.x, centerZ: AIRBASE_RUNWAY.z,
                heading: PLAYER_STARTING_HEADING,
                halfLength: RUNWAY_HALF_LENGTH_M, halfWidth: RUNWAY_STRIP_HALF_WIDTH,
                slope: 0,
            }
            : {
                centerX: r.center.x, centerZ: r.center.z, heading: r.heading,
                halfLength: r.halfLength, halfWidth: r.halfWidth, slope: r.slope,
            };
    }

    /** Where the authored furniture stands: the area's main airfield. */
    private get baseFrame() {
        return this.frameOf(this.homeRunway);
    }

    /** True when the airfield the furniture stands on has aprons of its own. */
    private homeHasRealAprons = false;
    /**
     * True when the home airfield has a ski-jump of its own in OSM (Saki's
     * T2): the real one is placed instead of the generic ramp down the runway.
     */
    private homeHasOwnSkiJump = false;
    /**
     * The airport buildings, as cylinders for the AI to steer around.
     *
     * Obstacles only: they are not collision meshes. A ground-height query
     * walks every scenery soup, and two hundred and sixty boxes in that loop
     * would be paid for on every contact test of every frame — for buildings
     * nothing on the ground ever taxis into.
     */
    private osmBuildings: Array<{ x: number; z: number; radius: number; height: number }> = [];

    /** Where the player starts and which way they face. */
    private get spawnFrame() {
        return this.frameOf(this.activeRunway);
    }

    /**
     * A runway-local offset in world XZ: `dx` right of the runway, `dz` along
     * it.
     *
     * The hangars, the tower, the ramp and the Canaries targets are all
     * authored as offsets from a runway pointing due north, because that is
     * what the one authored airbase was. A real runway points wherever it
     * points, so the layout turns with it — otherwise the hangar apron ends up
     * across the threshold of a runway on 021.
     */
    private airbaseAt(dx: number, dz: number): { x: number; z: number } {
        const f = this.baseFrame;
        const cos = Math.cos(f.heading);
        const sin = Math.sin(f.heading);
        return {
            x: f.centerX + dx * cos + dz * sin,
            z: f.centerZ - dx * sin + dz * cos,
        };
    }

    /** Which way the runway the player launches from is flown. */
    private get baseHeading(): number {
        return this.spawnFrame.heading;
    }

    /** A point `distance` m before the spawn runway's centre, on its axis. */
    private onRunwayAxis(distance: number): { x: number; z: number } {
        const f = this.spawnFrame;
        const fwd = headingForward(f.heading);
        return { x: f.centerX - fwd.x * distance, z: f.centerZ - fwd.z * distance };
    }

    /** Runway spawn position; Y matches FM2 gear rest height above local ground. */
    private runwaySpawnPosition(): THREE.Vector3 {
        const gearY = this.currentDef.flight
            ? fm2GroundRestHeight(this.currentDef.flight)
            : PLANE_DISTANCE_TO_GROUND;
        // Lined up at the threshold with the roll-out ahead, whatever the
        // runway's length: the inset is from the threshold, not from a fixed
        // point that happened to be inside a 3 km strip.
        // A start point a couple of hundred metres long (a deck, a ski-jump
        // run-up) is started from its very end, or there is no run left.
        const inset = Math.min(RUNWAY_SPAWN_INSET_M, this.spawnFrame.halfLength * 0.15);
        const p = this.onRunwayAxis(this.spawnFrame.halfLength - inset);
        return new THREE.Vector3(p.x, this.groundHeightAt(p.x, p.z) + gearY, p.z);
    }

    /** Short final toward the runway, AGL above DEM. */
    private landApproachSpawnPosition(): THREE.Vector3 {
        const p = this.onRunwayAxis(LAND_APPROACH_FINAL_M);
        return new THREE.Vector3(
            p.x, this.groundHeightAt(p.x, p.z) + LAND_APPROACH_FINAL_M * ILS_GLIDESLOPE_TAN, p.z);
    }

    /** Overhead the airbase at high altitude (10 km AGL). */
    private highAltSpawnPosition(): THREE.Vector3 {
        const f = this.spawnFrame;
        return new THREE.Vector3(
            f.centerX, this.groundHeightAt(f.centerX, f.centerZ) + HIGH_ALTITUDE_M, f.centerZ);
    }

    /** Overhead the airbase at a low cruising height, for the wingtip start. */
    private closeWingSpawnPosition(): THREE.Vector3 {
        const f = this.spawnFrame;
        return new THREE.Vector3(
            f.centerX, this.groundHeightAt(f.centerX, f.centerZ) + CLOSE_WING_ALTITUDE_AGL_M, f.centerZ);
    }

    /** Overhead the airbase at LEO altitude. */
    private spaceSpawnPosition(): THREE.Vector3 {
        const f = this.spawnFrame;
        return new THREE.Vector3(
            f.centerX, this.groundHeightAt(f.centerX, f.centerZ) + SPACE_ALTITUDE_M, f.centerZ);
    }

    /** Airborne spawn state pointing down the runway at approach speed. */
    private approachSpawnState(throttle: number | undefined): PlayerSpawnState {
        return {
            velocity: headingForward(this.baseHeading).multiplyScalar(APPROACH_SPEED_MPS),
            throttle: throttle ?? 0,
            airborne: true,
        };
    }

    /** Highest solid ground Y at (x, z): DEM/flat datum, hills, ski jumps, surface pads, scenery + carrier meshes. */
    private groundHeightAt(x: number, z: number): number {
        const demY = this.planetTerrain.heightAtWorld(x, z);
        return Math.max(
            demY,
            sampleSkiJumpSurfaceYMax(x, z, this.skiJumps),
            this.surfacePads.sampleYMax(x, z),
            sampleCarrierMeshSurfaceYMax(x, z, this.sceneryMeshes),
            sampleCarrierMeshSurfaceYMax(x, z, this.carrierMeshes),
        );
    }

    /**
     * Same surface, but reading the terrain off the mesh on screen rather than
     * the DEM where the two disagree — which they routinely do, because the
     * DEM query tier is a level coarser than the deepest drawn mesh.
     *
     * Only decals want this. A ground shadow has to land on the triangles the
     * depth test will compare it against or it is simply not drawn, whereas
     * physics wants the one surface that does not shift under an LOD change.
     *
     * On a pad's own footprint - runway, apron, roof - the pad *is* what is
     * drawn, and it replaces the terrain rather than competing with it. A
     * coarse tile drawn before the fine ones stream in can sit metres above a
     * runway (3 m at BER on z9), and taking the higher of the two floated the
     * shadow at canopy height over the pavement the aircraft stood on.
     */
    private drawnGroundHeightAt(x: number, z: number): number {
        const paved = this.surfacePads.sampleCoreYMax(x, z);
        const ground = paved > -Infinity
            ? paved
            : this.planetTerrain.drawnHeightAtWorld(x, z) ?? this.planetTerrain.heightAtWorld(x, z);
        return Math.max(
            ground,
            sampleSkiJumpSurfaceYMax(x, z, this.skiJumps),
            this.surfacePads.sampleYMax(x, z),
            sampleCarrierMeshSurfaceYMax(x, z, this.sceneryMeshes),
            sampleCarrierMeshSurfaceYMax(x, z, this.carrierMeshes),
        );
    }

    /**
     * Ground an obstacle cylinder stands on.
     *
     * Terrain and pavement only. Deliberately not {@link groundHeightAt},
     * which maxes in the scenery collision soups — that would read the
     * building's own roof and lift the cylinder off the top of it.
     */
    private obstacleBaseY(x: number, z: number): number {
        return Math.max(
            this.planetTerrain.heightAtWorld(x, z),
            sampleSkiJumpSurfaceYMax(x, z, this.skiJumps),
            this.surfacePads.sampleYMax(x, z),
        );
    }

    /**
     * Dev aid: snapshot the ground surfaces the instant the aircraft is
     * declared crashed, so `__lastCrash` holds the numbers even though the
     * moment itself is gone by the time anyone can type. Paired with
     * {@link groundProbe}, which reads the same thing on demand.
     */
    private captureCrashProbe(): void {
        const crashed = this.player?.isCrashed ?? false;
        const landed = this.player?.isLanded ?? false;
        // Two triggers, because "stops in mid-air" is not always a crash: the
        // sim can equally decide the aircraft is *resting* on a surface that is
        // not there. Either edge, while the drawn ground is well below, is the
        // thing worth a snapshot.
        const edge = (crashed && !this.wasCrashed) || (landed && !this.wasLanded);
        if (edge) {
            const probe = this.groundProbe();
            const above = probe.aboveDrawn as number | null;
            const suspicious = above !== null && above > 20;
            (globalThis as Record<string, unknown>).__lastCrash = probe;
            // Quiet on a normal touchdown; loud only when the aircraft met the
            // ground well above the ground, which is the bug worth shouting at.
            if (suspicious) {
                console.warn('[GROUND CONTACT IN CLEAR AIR]',
                    crashed ? 'crashed' : 'landed', probe);
            }
        }
        this.wasCrashed = crashed;
        this.wasLanded = landed;
    }

    /**
     * Dev aid: every surface that claims to be the ground under the aircraft,
     * side by side. Call `__probe()` from the console — with no argument it
     * reads the player's current position.
     *
     * The point is to tell apart the two ways an aircraft can stop in clear
     * air. If `dem` sits at the aircraft and `drawn` is far below, the mesh on
     * screen is a coarse parent that has not been replaced yet and physics is
     * right. If both sit far below, something in `worldGround` — a pad, a
     * stale carrier or scenery collider — is holding a floor up there.
     */
    private groundProbe(at?: { x: number; z: number }): Record<string, unknown> {
        if (this.planetTerrain === undefined || this.player === undefined) {
            return { ready: false, note: 'world not built yet - start a flight first' };
        }
        const p = this.player.getDisplayPosition();
        const x = at?.x ?? p.x;
        const z = at?.z ?? p.z;
        const dem = this.planetTerrain.heightAtWorld(x, z);
        const drawn = this.planetTerrain.drawnHeightAtWorld(x, z);
        const pad = this.surfacePads.sampleYMax(x, z);
        const ski = sampleSkiJumpSurfaceYMax(x, z, this.skiJumps);
        const scenery = sampleCarrierMeshSurfaceYMax(x, z, this.sceneryMeshes);
        const carrier = sampleCarrierMeshSurfaceYMax(x, z, this.carrierMeshes);
        const worldGround = this.groundHeightAt(x, z);
        const fin = (v: number) => (Number.isFinite(v) ? +v.toFixed(1) : null);
        return {
            aircraft: { x: +x.toFixed(1), y: +p.y.toFixed(1), z: +z.toFixed(1) },
            altimeterMsl: +this.planetTerrain.geodeticAltitudeAtWorld(x, p.y, z).toFixed(1),
            dem: fin(dem),
            drawn: drawn === undefined ? null : fin(drawn),
            worldGround: fin(worldGround),
            aboveDem: +(p.y - dem).toFixed(1),
            aboveDrawn: drawn === undefined ? null : +(p.y - drawn).toFixed(1),
            aboveWorldGround: +(p.y - worldGround).toFixed(1),
            contributors: { pad: fin(pad), skiJump: fin(ski), scenery: fin(scenery), carrier: fin(carrier) },
            counts: {
                surfacePads: this.surfacePads.length,
                skiJumps: this.skiJumps.length,
                sceneryMeshes: this.sceneryMeshes.length,
                carrierMeshes: this.carrierMeshes.length,
            },
            tier: this.planetTerrain.heights.heightResolutionAtWorld(x, z),
            area: this.playArea?.area.name,
        };
    }

    /**
     * Max ground Y under a footprint so wide buildings are not buried by DEM relief.
     * Samples a grid in [x±halfW]×[z±halfD].
     */
    private groundHeightMaxUnder(
        x: number,
        z: number,
        halfW: number,
        halfD: number,
        step: number = 20,
    ): number {
        const sx = Math.max(5, step);
        const sz = Math.max(5, step);
        let y = this.groundHeightAt(x, z);
        for (let dz = -halfD; dz <= halfD; dz += sz) {
            for (let dx = -halfW; dx <= halfW; dx += sx) {
                y = Math.max(y, this.groundHeightAt(x + dx, z + dz));
            }
        }
        // Include corners even when half extents are not multiples of step.
        y = Math.max(
            y,
            this.groundHeightAt(x - halfW, z - halfD),
            this.groundHeightAt(x + halfW, z - halfD),
            this.groundHeightAt(x - halfW, z + halfD),
            this.groundHeightAt(x + halfW, z + halfD),
        );
        return y;
    }

    /** On-deck carrier takeoff spawn; Y = deck surface + FM2 gear rest height. */
    private carrierTakeoffSpawnPosition(): THREE.Vector3 {
        const gearY = this.currentDef.flight
            ? fm2GroundRestHeight(this.currentDef.flight)
            : PLANE_DISTANCE_TO_GROUND;
        const pose = this.carrierPose();
        const x = pose.position.x + KUZ_DECK_MID_X;
        const z = pose.position.z + PLAYER_CARRIER_TAKEOFF_LOCAL_Z;
        return new THREE.Vector3(x, this.groundHeightAt(x, z) + gearY, z);
    }

    /** Final approach spawn relative to the live carrier stern. */
    private carrierApproachSpawnPosition(): THREE.Vector3 {
        const pose = this.carrierPose();
        return new THREE.Vector3(
            pose.position.x + KUZ_DECK_MID_X,
            pose.position.y + CARRIER_APPROACH_ALTITUDE_M,
            pose.position.z + KUZ_HULL.maxZ + CARRIER_APPROACH_FINAL_DISTANCE_M,
        );
    }

    /**
     * Short-final spawn: on the glideslope and centreline, a few seconds astern
     * of the ramp. Stern Z is taken from the live pose, so it tracks the ship.
     */
    private carrierBarricadeSpawnPosition(): THREE.Vector3 {
        const pose = this.carrierPose();
        return new THREE.Vector3(
            pose.position.x + KUZ_DECK_MID_X,
            pose.position.y + CARRIER_GROOVE_ALTITUDE_M,
            pose.position.z + KUZ_HULL.maxZ + CARRIER_GROOVE_DISTANCE_M,
        );
    }

    /**
     * Short final: on speed, level, over the ramp.
     *
     * The 2.5 km spawn starts fast and lets the pilot fly the ball down. From
     * a second out there is no time for that, and hands off the jet sinks on
     * its own ({@link CARRIER_GROOVE_ALTITUDE_M}), so it starts level and low
     * and settles onto the deck before the sink builds, then rolls into the net.
     */
    private carrierBarricadeSpawn(): PlayerSpawnState {
        const speed = this.carrierSpeedMps + CARRIER_GROOVE_SPEED_MPS;
        const velocity = FORWARD.clone()
            .applyAxisAngle(UP, PLAYER_CARRIER_HEADING)
            .multiplyScalar(speed);
        return { velocity, throttle: 0.3, airborne: true };
    }

    /** Approach airspeed in world frame (ship speed + relative groove speed). */
    private carrierApproachSpawn(): PlayerSpawnState {
        const speed = this.carrierSpeedMps + APPROACH_SPEED_MPS;
        return {
            velocity: FORWARD.clone().applyAxisAngle(UP, PLAYER_CARRIER_HEADING).multiplyScalar(speed),
            throttle: 0.38,
            airborne: true,
        };
    }

    /** On-deck takeoff: world velocity matches ship cruise along the bow. */
    private carrierTakeoffSpawn(): PlayerSpawnState {
        return {
            velocity: FORWARD.clone().applyAxisAngle(UP, PLAYER_CARRIER_TAKEOFF_HEADING).multiplyScalar(this.carrierSpeedMps),
            throttle: 0,
            airborne: false,
        };
    }

    private onViewportResize() {
        this.updateHdResolution();
    }

    private updateHdResolution() {
        const [width, height] = this.renderer.getMaxViewportResolution();
        const renderScale = this.configService.renderScale.getActive();
        const supersampling = this.configService.supersampling.getActive();
        if (width === this.hdResolutionWidth && height === this.hdResolutionHeight
            && renderScale === this.hdRenderScale && supersampling === this.hdSupersampling) {
            return;
        }

        this.hdResolutionWidth = width;
        this.hdResolutionHeight = height;
        this.hdRenderScale = renderScale;
        this.hdSupersampling = supersampling;
        // Resolved from the *main* viewport, not each target's own size: the
        // MFD sub-target is a fraction of the screen, but it should still
        // taper with it rather than staying at full supersample cost just
        // because it individually looks small-resolution.
        const supersampleScale = supersampling ? hdSupersampleScale(width, height) : 1;
        // The render-scale option replaces the supersample rather than
        // multiplying it: it exists to cut fill rate, and a 2x supersample
        // at 50% would cost exactly what native does. The compose pass's
        // linear magnification stretches the smaller texture to the screen;
        // the HUD canvas and the weapons display keep their full size and
        // composite on top of it.
        const mainScale = renderScale < 1 ? renderScale : supersampleScale;
        this.hdMainScale = mainScale;
        // Optional: the first sizing can come before the terrain is built.
        this.planetTerrain?.setRenderScale(mainScale);

        if (!this.renderer.hasRenderTarget(MAIN_RENDER_TARGET_HD)) {
            const textColors = this.getTextColors();
            this.renderer.createRenderTarget(MAIN_RENDER_TARGET_HD, RenderTargetType.WEBGL, 0, 0, width, height, { textureScale: mainScale });
            this.renderer.createRenderTarget(CANVAS_RENDER_TARGET_HD, RenderTargetType.CANVAS, 0, 0, width, height, { textColors });
            const mfdSize = CockpitMFDSize(height, width);
            this.renderer.createRenderTarget(WEAPONSTARGET_RENDER_TARGET_HD, RenderTargetType.WEBGL, CockpitMFD2X(width, height, mfdSize), CockpitMFD2Y(width, height, mfdSize), mfdSize, mfdSize, { textureScale: supersampleScale * MFD_RENDER_SCALE });
        } else {
            this.renderer.resizeRenderTarget(MAIN_RENDER_TARGET_HD, 0, 0, width, height, mainScale);
            this.renderer.resizeRenderTarget(CANVAS_RENDER_TARGET_HD, 0, 0, width, height);
            const mfdSize = CockpitMFDSize(height, width);
            this.renderer.resizeRenderTarget(WEAPONSTARGET_RENDER_TARGET_HD, CockpitMFD2X(width, height, mfdSize), CockpitMFD2Y(width, height, mfdSize), mfdSize, mfdSize, supersampleScale * MFD_RENDER_SCALE);
        }

        this.renderer.setComposeSize(width, height);
        this.setHdCameraAspect(width, height);
    }

    private setHdCameraAspect(width: number, height: number) {
        const aspect = width / height;
        this.playerCamera.main.aspect = aspect;
        this.playerCamera.main.updateProjectionMatrix();
        this.playerCamera.update();
    }

    private getTextColors(): string[] {
        return Array.from(new Set(
            [HDNoonPalette, HDMidnightPalette]
                .flatMap(p => ([
                    PaletteColor(p, PaletteCategory.HUD_TEXT),
                    PaletteColor(p, PaletteCategory.HUD_TEXT_WARN),
                    PaletteColor(p, PaletteCategory.HUD_TEXT_SECONDARY),
                    PaletteColor(p, PaletteCategory.HUD_TEXT_EFFECT)
                ]))
        ));
    }

    /**
     * Give a runway strip the colour of the ground under it, as that ground
     * is drawn: once per tile level, since a coarse tile's facet says "crop"
     * over a district that is grass at the strip itself, and the finest tile
     * has the last word. The reading is averaged over the strip's own three
     * sample points (see {@link sampleGroundStrip}), so its worst sample is
     * what decides whether this level counts as an improvement. Cheap: a few
     * triangle tests per strip still waiting, and none once every strip is
     * final.
     */
    private paintGroundStrips(): void {
        if (this.pendingGroundStrips.length === 0) {
            return;
        }
        const finest = this.planetTerrain.maxZoom;
        this.pendingGroundStrips = this.pendingGroundStrips.filter(strip => {
            // Finalized already, by the direct finest-tile fetch in
            // finalizeGroundStrip - nothing this LOD-driven pass reads can
            // improve on that, so it is done with this strip for good.
            if (strip.paintedZoom === Infinity) {
                return false;
            }
            const cover = sampleGroundStrip(
                strip, (x, z) => this.planetTerrain.drawnCoverAtWorld(x, z));
            if (cover === undefined) {
                return true;
            }
            if (cover.zoom > strip.paintedZoom) {
                repaintGroundStrip(strip, cover, this.materials);
            }
            return cover.zoom < finest;
        });
    }

    /**
     * Bypasses the draw list entirely: fetches the finest baked tile at each
     * of a runway strip's three sample points directly (see
     * `finestCoverAtWorld`) and repaints it once, from the real satellite-
     * imagery colour rather than whatever LOD happens to be on screen.
     *
     * Fired once per strip, right when it is built, independent of the
     * per-frame `paintGroundStrips` pass above - that pass gives a strip a
     * decent interim colour the moment *something* streams in nearby; this
     * gives it its final, authoritative one, however long the fetch takes.
     */
    private finalizeGroundStrip(strip: GroundStrip): void {
        void Promise.all(strip.samples.map(
            p => this.planetTerrain.finestCoverAtWorld(p.x, p.z)))
            .then(covers => {
                const cover = combineCover(covers);
                if (cover === undefined) {
                    return;
                }
                repaintGroundStrip(strip, cover, this.materials);
                // Marks it done for paintGroundStrips above - see there.
                strip.paintedZoom = Infinity;
            });
    }

    update(delta: number) {
        this.paintGroundStrips();
        if (this.menuPaused || this.streamHeld) {
            return;
        }
        advanceFxClock(delta);
        if (this.replaying) {
            // The world holds still; only the recorded aircraft moves.
            this.replayPlayer.advance(delta);
            if (this.view === PlayerViewState.FIXED) {
                this.moveFixedCamera(delta);
            } else {
                this.updateOrbitFromKeys(delta);
            }
            this.recorder.sample(this.replayPlayer.time, this.replayPose);
            this.player.setReplayPose(this.replayPose);
            this.updateReplayHud();
            return;
        }
        if (this.state === GameState.PLAYER) {
            this.maybeRebase();
            this.streamAirfields();
            this.recordFlightFrame(delta);
        }
        if (this.state === GameState.PLAYER) {
            if ((this.view === PlayerViewState.TARGET_TO || this.view === PlayerViewState.TARGET_FROM) && !this.player.weaponsTarget) {
                this.setCockpitFrontView();
            }
            if (this.cockpitPadlock && (!this.player.weaponsTarget || this.view !== PlayerViewState.COCKPIT_FRONT)) {
                this.setCockpitPadlock(false);
            }
            this.updateOrbitFromKeys(delta);
            this.captureCrashProbe();
            this.advanceCarrier(delta);
            this.syncCarrierSystems();
            this.scene.update(delta);
            this.pumpCombatSim(delta);
            this.syncBarricade(false);
            this.syncBarricadeAirframe();
            this.updateAiStraightTimer(delta);
            this.updateMission(delta);
            this.publishAiStats();
            this.followFlightCameraInUrl(delta);

            if (this.player.isCrashed) {
                this.transitionFromPlayerToCrashed();
            } else {
                this.crashTransitionDone = false;
            }
        } else if (this.state === GameState.SPAWN_MENU || this.state === GameState.FIXED_CAMERA) {
            if (this.state === GameState.FIXED_CAMERA) {
                if (this.mapView) {
                    this.placeMapCamera();
                    this.fitMapDetail();
                } else {
                    this.moveFixedCamera(delta);
                }
                this.streamAirfields();
                this.maybeRebase();
            }
            this.advanceCarrier(delta);
            this.syncCarrierSystems();
            this.scene.update(delta);
            this.pumpCombatSim(delta);
        }
    }

    /** Seconds of wreckage still recorded after the crash, then the recording stops. */
    private static readonly REPLAY_POST_CRASH_S = 6;
    private postCrashRecorded = 0;

    private recordFlightFrame(delta: number): void {
        if (this.player.isCrashed) {
            this.postCrashRecorded += delta;
            if (this.postCrashRecorded > Game.REPLAY_POST_CRASH_S) {
                return;
            }
        } else {
            this.postCrashRecorded = 0;
        }
        const pose = this.replayPose;
        pose.position.copy(this.player.position);
        pose.quaternion.copy(this.player.quaternion);
        pose.velocity.copy(this.player.velocityVector);
        pose.devices.throttle = this.player.throttleUnit;
        this.recorder.record(delta, pose);
    }

    /** F4: watch the flight so far (up to the last ten minutes) from the replay camera. */
    private toggleReplay(): void {
        if (this.replaying) {
            this.stopReplay();
            return;
        }
        if (this.state !== GameState.PLAYER || this.menuPaused || this.recorder.length < 2) {
            return;
        }
        this.replaying = true;
        this.replayWasPaused = !this.player.controlsEnabled;
        this.player.setSimulationPaused(true);
        this.leaveShowcaseIfActive();
        this.resetOrbit();
        this.replayPlayer.start();
        if (this.view === PlayerViewState.COCKPIT_FRONT) {
            this.setReplayView(PlayerViewState.EXTERIOR_BEHIND);
        }
    }

    private replayWasPaused = false;

    private stopReplay(): void {
        if (!this.replaying) {
            return;
        }
        this.replaying = false;
        this.heldFixedCameraKeys.clear();
        this.fixedCameraRates = zeroFixedCameraRates();
        this.player.setReplayPose(undefined);
        this.player.setSimulationPaused(this.replayWasPaused);
        if (this.replayUi) {
            this.replayUi.root.style.display = 'none';
        }
    }

    /** Replay keys: space pauses, arrows seek/speed (move the camera in the free view), F4/Esc leave. True if used. */
    private handleReplayKey(event: KeyboardEvent): boolean {
        switch (event.code) {
            case 'Space': this.replayPlayer.paused = !this.replayPlayer.paused; break;
            case 'Comma': this.replayPlayer.seek(-5); break;
            case 'Period': this.replayPlayer.seek(5); break;
            case 'BracketRight': this.replayPlayer.changeSpeed(1); break;
            case 'BracketLeft': this.replayPlayer.changeSpeed(-1); break;
            case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
            case 'PageUp': case 'PageDown':
            case 'Numpad4': case 'Numpad6': case 'Numpad8': case 'Numpad2':
                // The arrows move the camera in the free view only; elsewhere
                // they seek (left/right) and change speed (up/down).
                if (this.view === PlayerViewState.FIXED) {
                    this.heldFixedCameraKeys.add(event.code);
                } else if (event.code === 'ArrowLeft') {
                    this.replayPlayer.seek(-5);
                } else if (event.code === 'ArrowRight') {
                    this.replayPlayer.seek(5);
                } else if (event.code === 'ArrowUp') {
                    this.replayPlayer.changeSpeed(1);
                } else if (event.code === 'ArrowDown') {
                    this.replayPlayer.changeSpeed(-1);
                } else {
                    return false;
                }
                break;
            case 'Home': this.replayPlayer.start(); break;
            case 'Escape': this.stopReplay(); break;
            default: return false;
        }
        return true;
    }

    private replayUi: {
        root: HTMLDivElement; play: HTMLButtonElement; seek: HTMLInputElement;
        time: HTMLSpanElement; speed: HTMLButtonElement; views: Map<PlayerViewState, HTMLButtonElement>;
    } | undefined;
    private replayScrubbing = false;

    private buildReplayUi(): NonNullable<Game['replayUi']> {
        const root = document.createElement('div');
        root.style.cssText = 'position:fixed;left:0;right:0;bottom:0;display:flex;flex-direction:column;'
            + 'gap:6px;padding:8px 16px 12px;background:linear-gradient(transparent,rgba(0,0,0,0.8));'
            + 'color:#fff;font:13px sans-serif;z-index:50;user-select:none';
        const btnCss = 'background:rgba(255,255,255,0.12);color:#fff;border:1px solid rgba(255,255,255,0.3);'
            + 'border-radius:4px;padding:4px 10px;cursor:pointer;font:inherit';
        const button = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
            const b = document.createElement('button');
            b.textContent = label;
            b.title = title;
            b.style.cssText = btnCss;
            // Keep keyboard focus off the button so Space still pauses.
            b.addEventListener('mousedown', e => e.preventDefault());
            b.addEventListener('click', onClick);
            return b;
        };
        const seek = document.createElement('input');
        seek.type = 'range';
        seek.min = '0';
        seek.max = '1000';
        seek.style.cssText = 'width:100%;cursor:pointer';
        const scrub = () => {
            this.replayPlayer.time = this.recorder.startTime + (Number(seek.value) / 1000) * this.recorder.duration;
        };
        seek.addEventListener('pointerdown', () => { this.replayScrubbing = true; });
        seek.addEventListener('input', scrub);
        seek.addEventListener('pointerup', () => { this.replayScrubbing = false; });
        seek.addEventListener('change', () => { this.replayScrubbing = false; });

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
        const play = button('Pause', 'Play / pause (Space)', () => {
            this.replayPlayer.paused = !this.replayPlayer.paused;
        });
        const time = document.createElement('span');
        time.style.cssText = 'font-family:monospace;min-width:90px';
        const speed = button('1x', 'Playback speed (click: faster, Shift-click: slower)', () => {});
        speed.addEventListener('click', e => {
            if (e.shiftKey) this.replayPlayer.changeSpeed(-1); else this.replayPlayer.cycleSpeed();
        });
        const spacer = document.createElement('span');
        spacer.style.flex = '1';
        row.append(
            button('|<', 'Restart (Home)', () => this.replayPlayer.start()),
            button('-5s', 'Back 5 s (Left or ,)', () => this.replayPlayer.seek(-5)),
            play,
            button('+5s', 'Forward 5 s (Right or .)', () => this.replayPlayer.seek(5)),
            time, speed, spacer);
        const views = new Map<PlayerViewState, HTMLButtonElement>();
        const addView = (label: string, v: PlayerViewState, title: string) => {
            const b = button(label, title, () => this.setReplayView(v));
            views.set(v, b);
            row.append(b);
        };
        addView('Cockpit', PlayerViewState.COCKPIT_FRONT, 'Cockpit (F1)');
        addView('Behind', PlayerViewState.EXTERIOR_BEHIND, 'Chase from behind (F2)');
        addView('Front', PlayerViewState.EXTERIOR_FRONT, 'From the front');
        addView('Left', PlayerViewState.EXTERIOR_LEFT, 'Left side');
        addView('Right', PlayerViewState.EXTERIOR_RIGHT, 'Right side');
        addView('Free', PlayerViewState.FIXED, 'Free camera: arrows move it, Page Up/Down raise and lower, numpad 4/6/8/2 turn');
        addView('Tower', PlayerViewState.CARRIER_OVER_STERN, 'Over-the-stern view (F3)');
        row.append(button('Exit', 'Leave replay (F4 / Esc)', () => this.stopReplay()));
        root.append(seek, row);
        document.body.appendChild(root);
        return { root, play, seek, time, speed, views };
    }

    private setReplayView(v: PlayerViewState): void {
        this.resetOrbit();
        this.heldFixedCameraKeys.clear();
        this.fixedCameraRates = zeroFixedCameraRates();
        if (v === PlayerViewState.FIXED) {
            // Free camera: starts where the current one is, then flies on its own.
            const cam = this.playerCamera.main;
            const d = cam.getWorldDirection(new THREE.Vector3());
            this.fixedCameraUpdater.setPose(
                cam.position.clone(),
                (Math.atan2(d.x, -d.z) * 180 / Math.PI + 360) % 360,
                Math.asin(Math.max(-1, Math.min(1, d.y))) * 180 / Math.PI);
            restoreMainCameraParameters(cam);
            this.setExteriorView(v);
            return;
        }
        if (v === PlayerViewState.COCKPIT_FRONT) {
            this.setCockpitFrontView();
            return;
        }
        restoreMainCameraParameters(this.playerCamera.main);
        this.setExteriorView(v);
    }

    private updateReplayHud(): void {
        const ui = this.replayUi ??= this.buildReplayUi();
        const r = this.replayPlayer;
        const rec = this.recorder;
        const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        ui.root.style.display = 'flex';
        ui.play.textContent = r.paused ? 'Play' : 'Pause';
        ui.time.textContent = `${fmt(r.time - rec.startTime)} / ${fmt(rec.duration)}`;
        ui.speed.textContent = `${r.speed}x`;
        if (!this.replayScrubbing) {
            ui.seek.value = String(Math.round(r.fraction * 1000));
        }
        for (const [v, b] of ui.views) {
            b.style.background = v === this.view ? 'rgba(80,160,255,0.6)' : 'rgba(255,255,255,0.12)';
        }
    }

    private readonly carrierAheadProbe = new THREE.Vector3();
    /** The hull materials' waterline clips, moved with the sea under the ship. */
    private carrierClipData: { clipBelowYAbs?: number }[] = [];
    /** Afloat rather than moored on land: the ship rides the sea surface as it steams. */
    private carrierAtSea = false;

    /**
     * Keep the hull on the sea it is over. Scene Y is measured from the play
     * origin's tangent plane, and the sea curves away from that plane, so a
     * ship steaming toward the origin's latitude would otherwise sink under
     * a surface rising 15 m in four kilometres.
     */
    private seatCarrierOnSea(): void {
        const kuz = this.kuz;
        if (!kuz || !this.carrierAtSea) return;
        const { x, z } = kuz.position;
        // The DEM near a coast reads as land; the sea itself is the sphere.
        const seaY = Math.min(this.planetTerrain.heightAtWorld(x, z), seaLevelSceneY(x, z) + 2);
        kuz.position.y = ARRESTOR_CARRIER_ORIGIN.y + seaY + KUZ_HULL_RAISE_M;
        for (const d of this.carrierClipData) {
            d.clipBelowYAbs = seaY + 0.05;
        }
    }

    /** True when ground lies within a few hundred metres ahead of the bow. */
    private landAheadOfCarrier(): boolean {
        const kuz = this.kuz;
        if (!kuz) return false;
        for (const dx of [KUZ_HULL.minX - 30, KUZ_DECK_MID_X, KUZ_HULL.maxX + 30]) {
            for (const dz of [KUZ_HULL.minZ - 150, KUZ_HULL.minZ - 600]) {
                this.carrierAheadProbe.set(dx, 0, dz).applyQuaternion(kuz.quaternion).add(kuz.position);
                if (this.planetTerrain.isLandAtWorld(this.carrierAheadProbe.x, this.carrierAheadProbe.z)) {
                    return true;
                }
            }
        }
        return false;
    }

    /** Steam the Kuznetsov at {@link CARRIER_SPEED_MPS} along its bow (−Z at identity). */
    private advanceCarrier(delta: number): void {
        if (!this.kuz) return;
        if (this.carrierSpeedMps > 0 && this.landAheadOfCarrier()) {
            // Land across the bow: drop anchor rather than steam into it.
            this.carrierSpeedMps = 0;
        }
        this.carrierBowDir.set(0, 0, -1).applyQuaternion(this.kuz.quaternion);
        this.carrierVelocity.copy(this.carrierBowDir).multiplyScalar(this.carrierSpeedMps);
        this.kuz.position.addScaledVector(this.carrierVelocity, delta);
        this.seatCarrierOnSea();
    }

    /** Carrier pose for arrestor visuals / latched hook (always live). */
    private carrierPose(): ArrestorCarrierPose {
        if (this.kuz) {
            return {
                position: this.kuz.position,
                quaternion: this.kuz.quaternion,
                velocity: this.carrierVelocity,
            };
        }
        return { position: KUZ_POSITION, quaternion: KUZ_IDENTITY_QUAT, velocity: this.carrierVelocity };
    }

    /**
     * When the Kuznetsov moves, keep trap cables, deck collision, and the
     * combat-sim worker in sync with its world pose.
     */
    private syncCarrierSystems(): void {
        if (!this.kuz) return;
        const p = this.kuz.position;
        const q = this.kuz.quaternion;
        if (
            Math.abs(p.x - this.syncedCarrierPos.x) < 1e-4 &&
            Math.abs(p.y - this.syncedCarrierPos.y) < 1e-4 &&
            Math.abs(p.z - this.syncedCarrierPos.z) < 1e-4 &&
            Math.abs(q.x - this.syncedCarrierQuat.x) < 1e-6 &&
            Math.abs(q.y - this.syncedCarrierQuat.y) < 1e-6 &&
            Math.abs(q.z - this.syncedCarrierQuat.z) < 1e-6 &&
            Math.abs(q.w - this.syncedCarrierQuat.w) < 1e-6
        ) {
            return;
        }
        this.syncedCarrierPos.copy(p);
        this.syncedCarrierQuat.copy(q);

        for (const m of this.carrierMeshes) {
            m.originX = p.x;
            m.originY = p.y;
            m.originZ = p.z;
        }

        // The land wires go along every time: the sim replaces the whole list.
        const field = defaultArrestorCableField(p.x, p.y, p.z, q);
        this.combatSim.setArrestorCables(
            [field, ...landArrestorFields(this.landWires)].map(serializeArrestorCables));
        this.syncBarricade(true);
        this.combatSim.setCarrierMeshOrigins(
            this.carrierMeshes.map(c => ({
                originX: c.originX, originY: c.originY, originZ: c.originZ,
            })),
        );
        this.combatSim.setCarrierVelocity(
            this.carrierVelocity.x, this.carrierVelocity.y, this.carrierVelocity.z,
        );
    }

    /** The player's barricade engagement as the sim last reported it. */
    private playerBarricadeEngagement(): number {
        const fm = this.player.getFlightModel();
        const engagement = fm instanceof SimProxyFlightModel ? fm.getBarricadeEngagement() : BarricadeEngagement.NONE;
        if (this.barricadeStaleAfterSpawn) {
            // Not believed until the sim has reported this aircraft free once.
            if (engagement === BarricadeEngagement.NONE) this.barricadeStaleAfterSpawn = false;
            return BarricadeEngagement.NONE;
        }
        return engagement;
    }

    /**
     * Tell the sim the rig state when it changes or the ship has moved, and
     * book a catch the sim reported against the webbing.
     */
    private syncBarricade(shipMoved: boolean): void {
        const rig = this.barricade;
        if (!rig || !this.kuz) return;
        if (this.playerBarricadeEngagement() !== BarricadeEngagement.NONE) {
            rig.markExpended();
        }
        const armed = rig.armed;
        const webbing = rig.webbingUp;
        if (!shipMoved && armed === this.barricadeSentArmed && rig.generation === this.barricadeSentGeneration
            && webbing === this.barricadeSentWebbing) {
            return;
        }
        this.barricadeSentArmed = armed;
        this.barricadeSentGeneration = rig.generation;
        this.barricadeSentWebbing = webbing;
        const p = this.kuz.position;
        const q = this.kuz.quaternion;
        this.combatSim.setBarricades([{
            originX: p.x, originY: p.y, originZ: p.z,
            quaternion: [q.x, q.y, q.z, q.w],
            armed,
            generation: rig.generation,
            webbing,
        }]);
    }

    /**
     * Give the sim the player's airframe as drawn, for the barricade webbing
     * to meet it with: whenever the jet is within reach of the ship, rigged
     * or not (so it is there before any net goes up), and again for a new
     * rig generation, another aircraft or the gear going up or down. Until it
     * is in (a second or two in the airframe worker) the webbing meets the
     * player with its type's hull (pushAircraftMeshes), so there is no catch
     * the webbing does not take.
     */
    private syncBarricadeAirframe(): void {
        const rig = this.barricade;
        if (!rig || !this.kuz) return;
        if (!this.player.isAlive() || this.player.position.distanceTo(this.kuz.position) > BARRICADE_AIRFRAME_BAKE_M) return;
        const fm = this.player.getFlightModel();
        const gear = fm instanceof SimProxyFlightModel ? fm.getSimGearDeployed() !== false : true;
        const key = `${this.currentDef.id}:${rig.generation}:${gear ? 'gear' : 'clean'}`;
        if (key === this.barricadeAirframeKey) return;
        const drawn = this.player.bakeDrawnAirframe();
        if (!drawn) return;
        this.barricadeAirframeKey = key;
        const triangles = Float32Array.from(drawn.triangles);
        this.barricadeAirframeBaker().postMessage({ key, kind: 'drawn', gear, triangles }, [triangles.buffer]);
        console.info(`[barricade] baking the webbing's airframe: ${triangles.length / 9} drawn triangles`);
    }

    /**
     * The webbing's hull for an aircraft type (its collision mesh), for every
     * aircraft of it: the AI's, and the player's until its drawn airframe is
     * in. Built once per type in the airframe worker.
     */
    private pushBarricadeHull(simId: string, def: FlyableAircraftDef): void {
        const hull = this.barricadeHulls.get(def.id);
        if (hull) {
            this.combatSim.setBarricadeAirframe(simId, hull, true);
            return;
        }
        const waiting = this.barricadeHullWaiting.get(def.id);
        if (waiting) {
            waiting.add(simId);
            return;
        }
        if (!def.collisionMesh || def.collisionMesh.triangles.length < 9) return;
        this.barricadeHullWaiting.set(def.id, new Set([simId]));
        const triangles = Float32Array.from(def.collisionMesh.triangles);
        this.barricadeAirframeBaker().postMessage({ key: def.id, kind: 'hull', triangles }, [triangles.buffer]);
    }
    private readonly barricadeHulls = new Map<string, AirframeCollider>();
    private readonly barricadeHullWaiting = new Map<string, Set<string>>();

    /** The worker that turns airframes into the webbing's colliders (webAirframeWorker.ts). */
    private barricadeAirframeBaker(): Worker {
        if (this.barricadeAirframeWorker) return this.barricadeAirframeWorker;
        const worker = new Worker(new URL('../physics/barricade/webAirframeWorker.ts', import.meta.url));
        worker.onmessage = (e: MessageEvent<{ key: string; kind: 'drawn' | 'hull'; airframe: AirframeCollider }>) => {
            const { key, kind, airframe } = e.data;
            if (kind === 'hull') {
                this.barricadeHulls.set(key, airframe);
                for (const simId of this.barricadeHullWaiting.get(key) ?? []) this.combatSim.setBarricadeAirframe(simId, airframe, true);
                this.barricadeHullWaiting.delete(key);
                return;
            }
            if (key !== this.barricadeAirframeKey) return;
            console.info(`[barricade] airframe for the webbing: ${airframe.triangles} triangles, coverage p99 ${airframe.coverageP99.toFixed(3)} m`);
            this.combatSim.setBarricadeAirframe(PLAYER_SIM_ID, airframe, false, true);
        };
        worker.onerror = e => console.error('[barricade] airframe worker', e.message);
        return this.barricadeAirframeWorker = worker;
    }
    private barricadeAirframeWorker: Worker | undefined;

    /**
     * The carrier's deck under the barricade, from its mesh (as the gear meets
     * it), for the drawn webbing and stanchions to stand on; sampled ahead a
     * little each frame (WebDeck).
     */
    private barricadeDeckMap(): WebDeck | undefined {
        const kuz = this.kuz;
        if (!kuz || this.carrierMeshes.length === 0) return undefined;
        // A new carrier (another area) has a deck of its own.
        if (this.barricadeDeckFor !== kuz) {
            this.barricadeDeck = undefined;
            this.barricadeDeckFor = kuz;
        }
        const deck = this.barricadeDeck ??= new WebDeck(
            (x, z) => sampleCarrierMeshSurfaceYMax(x, z, this.carrierMeshes),
            () => ({ origin: kuz.position, quaternion: kuz.quaternion }));
        const t0 = performance.now();
        while (performance.now() - t0 < 0.5 && !deck.fill(4)) { /* more */ }
        return deck;
    }
    private barricadeDeck: WebDeck | undefined;
    private barricadeDeckFor: unknown;

    /**
     * Pump one frame into the combat sim worker after entities have latched their
     * inputs. When the player's model is not sim-owned, inject its live state so
     * in-worker AI pilots can still target it.
     */
    private pumpCombatSim(delta: number): void {
        this.updateHeightFieldMirror(delta);
        if (!(this.configService.flightModels.getActive() instanceof SimProxyFlightModel)) {
            this.combatSim.setExternalState(
                PLAYER_SIM_ID, Faction.PLAYER,
                this.player.position, this.player.velocityVector, this.player.isAlive());
        }
        this.combatSim.tick(delta);
    }

    /**
     * Start mirroring the DEM into the sim worker. The worker decides crashes,
     * so it reads the same tiles the renderer draws rather than a lattice
     * sampled once at boot.
     */
    private startHeightFieldMirror(): void {
        const heights = this.planetTerrain.heights;
        this.combatSim.setHeightField(this.heightFieldConfig());
        this.heightSender = new HeightFieldSender(
            heights, update => this.combatSim.postHeightTiles(update),
        );
        this.heightSender.sendCoarse();
        this.heightMirrorTimer = SIM_TERRAIN_MIRROR_INTERVAL_S;
        this.updateHeightFieldMirror(0);
    }

    /** The sim worker's DEM sampler config, in the current frame. */
    private heightFieldConfig(): SerializedHeightField {
        const heights = this.planetTerrain.heights;
        return {
            basis: cloneEnuBasis(this.planetTerrain.basis),
            seaLevel: heights.seaLevel,
            queryZoom: heights.queryZoom,
            coarseZoom: heights.coarseZoom,
            pads: [...heights.flattenPads],
        };
    }

    /** Keep the worker's fine tier over the player (lead included) and the AI. */
    private updateHeightFieldMirror(delta: number): void {
        if (!this.heightSender) return;
        this.heightMirrorTimer += delta;
        if (this.heightMirrorTimer < SIM_TERRAIN_MIRROR_INTERVAL_S) return;
        this.heightMirrorTimer = 0;

        const focus = this.heightMirrorFocus;
        focus.length = 0;
        const p = this.player.position;
        const v = this.player.velocityVector;
        focus.push({ x: p.x, z: p.z });
        focus.push({
            x: p.x + v.x * SIM_TERRAIN_MIRROR_LEAD_S,
            z: p.z + v.z * SIM_TERRAIN_MIRROR_LEAD_S,
        });
        for (const ai of this.aiOpponents) {
            if (ai.isAlive()) {
                focus.push({ x: ai.position.x, z: ai.position.z });
            }
        }
        if (this.wingman?.isAlive()) {
            focus.push({ x: this.wingman.position.x, z: this.wingman.position.z });
        }
        this.heightSender.update(focus, SIM_TERRAIN_MIRROR_RADIUS_M);
    }

    render() {
        this.player.updateDisplayTransform();

        if (this.state === GameState.PLAYER || this.state === GameState.SPAWN_MENU
            || this.state === GameState.FIXED_CAMERA) {
            this.cameraUpdater.update(0);
            if (!this.cockpitPadlock
                && (this.view !== PlayerViewState.AI_CHASE
                    && (this.exteriorEnemyLock && this.isF2ExteriorView()
                        || this.viewYaw !== 0 || this.viewPitch !== 0 || this.viewZoom !== 1)
                    || this.view === PlayerViewState.AI_CHASE
                        && (this.viewYaw !== 0 || this.viewPitch !== 0 || this.viewZoom !== 1))) {
                this.orbitCameraAroundAircraft();
            }
            this.playerCamera.update();
            this.applyAltitudeCameraFar();
            if (this.mapView) {
                // Straight down from high up, the sky and the weather are
                // between the camera and the map, and stay off. The shell
                // stays on, but only for the globe map where nothing was baked.
                this.updateAtmosphereShell();
                ATMOSPHERE_SHELL_UNIFORMS.uMapMode.value = 1;
                (ATMOSPHERE_SHELL_UNIFORMS.uMapWater.value as THREE.Color)
                    .set(PaletteColor(this.palette, PaletteCategory.TERRAIN_WATER));
                // Never the globe over baked terrain: the map keeps the bake.
                ATMOSPHERE_SHELL_UNIFORMS.uGlobe.value = 0;
                SPACE_FOG.scale = 0;
                this.updateHdResolution();
                this.renderer.render(this.scene, this.exteriorRenderLayersHd);
                this.mapView.updateOverlay();
                this.missionOverlay?.update();
                return;
            }
            // Aim the target-window camera before the MFD's 3D layer is drawn (and
            // before its orientation is copied to the background cameras), so a
            // moving target stays centred instead of lagging a frame and stuttering.
            if (this.player.weaponsTarget) {
                updateTargetCamera(this.player, this.playerCamera.main, this.targetCamera.main);
            }
            this.targetCamera.update();
            this.applySpaceSkyState();
            this.updateAtmosphereShell();
            this.updateSunVisibility();
        }
        this.updateHdResolution();
        this.updateShowcasePicking(this.hdResolutionWidth || H_RES);
        this.updateCoverTooltip();

        let layers: RenderLayer[];
        if (this.view === PlayerViewState.SHOWCASE) {
            layers = this.showcaseRenderLayersHd;
        } else {
            layers = this.cockpitRenderLayersHd;
            if (this.view !== PlayerViewState.COCKPIT_FRONT) {
                layers = this.exteriorRenderLayersHd;
            } else if (this.player.weaponsTarget) {
                layers = this.cockpitTargetRenderLayersHd;
            }
        }

        if (this.player.weaponsTarget && this.view !== PlayerViewState.SHOWCASE) {
            const weaponsTargetId = WEAPONSTARGET_RENDER_TARGET_HD;
            const nightVisionPalette = this.player.nightVision ? this.configService.techProfiles.getActive().nightVisionPalette : undefined;
            // The target MFD is a full scene pass; rebuild it every fourth frame.
            const refreshTargetMfd = this.targetMfdFrame++ % 4 === 1;
            for (let i = 0; i < layers.length; i++) {
                const layer = layers[i];
                if (layer.target === weaponsTargetId) {
                    layer.palette = nightVisionPalette;
                    layer.skipRefresh = !refreshTargetMfd;
                } else {
                    layer.skipRefresh = false;
                }
            }
        } else if (this.view === PlayerViewState.SHOWCASE) {
            for (let i = 0; i < layers.length; i++) {
                layers[i].palette = ShowcasePalette;
                layers[i].skipRefresh = false;
            }
        } else {
            for (let i = 0; i < layers.length; i++) {
                layers[i].palette = undefined;
                layers[i].skipRefresh = false;
            }
        }
        this.applySpaceClearColor(layers);
        this.renderer.render(this.scene, layers);
    }

    /** Raise main / target far planes with altitude so the planetary limb stays in range. */
    private applyAltitudeCameraFar(): void {
        const altitude = this.playerCamera.main.position.y;
        // The map's camera can be higher than a flight's far plane reaches.
        const far = this.mapView ? Math.max(cameraFarForAltitudeM(altitude), altitude * 1.5)
            : cameraFarForAltitudeM(altitude);
        if (Math.abs(this.playerCamera.main.far - far) > 1) {
            this.playerCamera.main.far = far;
            this.playerCamera.main.updateProjectionMatrix();
        }
        if (Math.abs(this.targetCamera.main.far - far) > 1) {
            this.targetCamera.main.far = far;
            this.targetCamera.main.updateProjectionMatrix();
        }
    }

    /**
     * Sets how much of the sun's disc the camera can see over the terrain, for
     * the clouds' lighting.
     *
     * Walks the ground out along the sun's bearing and keeps the steepest angle
     * it subtends from the camera: that is the skyline the sun has to clear. The
     * step widens with range, as the picking march does, since a far ridge
     * needs far less resolution to be found.
     */
    private updateSunVisibility(): void {
        if (this.sunSkylineFrame++ % SUN_SKYLINE_EVERY_FRAMES !== 0) {
            return;
        }
        const cam = this.playerCamera.main.position;
        const horizontal = Math.hypot(SUN_DIRECTION.x, SUN_DIRECTION.z);
        let skylineDeg = -90;
        if (horizontal > 1e-4) {
            const dx = SUN_DIRECTION.x / horizontal;
            const dz = SUN_DIRECTION.z / horizontal;
            let steepest = -Infinity;
            for (let t = 20; t <= SUN_SKYLINE_RANGE_M; t += Math.max(20, t * 0.03)) {
                const h = this.planetTerrain.heightAtWorld(cam.x + dx * t, cam.z + dz * t);
                steepest = Math.max(steepest, (h - cam.y) / t);
            }
            skylineDeg = Math.atan(steepest) * THREE.MathUtils.RAD2DEG;
        }
        SUN_VISIBILITY.value = sunVisibilityFor(
            SUN_STATE.elevationDeg, skylineDeg, SUN_DISC_DIAMETER_DEG);
    }

    /**
     * Feeds the atmosphere shell the frame's camera and the planet's place.
     *
     * The ellipsoid's centre and polar axis are expressed in scene axes from
     * the terrain's ENU basis, so the shell agrees with the tiles to the
     * metre. The centre goes in camera-relative and the camera's height above
     * the ellipsoid comes from doubles here, because the shader's floats
     * cannot difference two numbers 6.4 Mm long.
     */
    private updateAtmosphereShell(): void {
        if (!this.atmosphereShell) {
            return;
        }
        const camera = this.playerCamera.main;
        const altitude = camera.position.y;
        // The map draws the shell at any height, for the globe map outside
        // the baked areas (uMapMode), and without the air.
        const weight = this.mapView ? 1
            : THREE.MathUtils.smoothstep(altitude, ATMOSPHERE_SHELL_FADE_IN_M, SPACE_SKY_ALTITUDE_M);
        const show = weight > 0 && this.view !== PlayerViewState.SHOWCASE;
        SPACE_FOG.scale = show ? 1 - weight : 1;
        this.atmosphereShell.enabled = show;
        if (!show) {
            return;
        }
        const basis = this.planetTerrain.basis;
        const centre = sceneFromEnu(ecefToEnu(basis, { x: 0, y: 0, z: 0 }), SHELL_CENTRE);
        const m = basis.ecefToEnu;
        // Polar axis (ECEF z) in ENU is the third column of the ecef->enu matrix.
        SHELL_AXIS.set(m[2], m[8], -m[5]).normalize();

        // Height above the ellipsoid, in doubles: distance from the centre with
        // the polar axis stretched by a / b, less the equatorial radius.
        const rel = SHELL_REL.set(-centre.x + camera.position.x, -centre.y + camera.position.y,
            -centre.z + camera.position.z);
        const along = rel.dot(SHELL_AXIS) * (WGS84_A / WGS84_B - 1);
        const stretched = SHELL_STRETCHED.copy(rel).addScaledVector(SHELL_AXIS, along);
        const height = stretched.length() - WGS84_A;

        const u = ATMOSPHERE_SHELL_UNIFORMS;
        u.uCentre.value.copy(centre).sub(camera.position);
        u.uAxis.value.copy(SHELL_AXIS);
        // The equator's 0 E and 90 E directions, the same way: ECEF x and y.
        u.uEcefX.value.set(m[0], m[6], -m[3]).normalize();
        u.uEcefY.value.set(m[1], m[7], -m[4]).normalize();
        // The point under the camera, for the colour map's detail block. The
        // stretch already put a / b on the polar part; geodetic latitude takes
        // it once more.
        const px = stretched.dot(u.uEcefX.value);
        const py = stretched.dot(u.uEcefY.value);
        const pz = stretched.dot(SHELL_AXIS) * (WGS84_A / WGS84_B);
        earthMap().update(
            THREE.MathUtils.radToDeg(Math.atan2(pz, Math.hypot(px, py))),
            THREE.MathUtils.radToDeg(Math.atan2(py, px)), height);
        const areas = this.areaList;
        const count = Math.min(areas.length, SHELL_MAX_AREAS);
        const rad = THREE.MathUtils.DEG2RAD;
        for (let i = 0; i < count; i++) {
            const a = areas[i];
            u.uAreas.value[i].set(a.west * rad, a.south * rad, a.east * rad, a.north * rad);
        }
        u.uAreaCount.value = count;
        u.uGlobe.value = THREE.MathUtils.smoothstep(height, GLOBE_MAP_FADE_START_M, GLOBE_MAP_FADE_END_M);
        u.uSun.value.copy(SUN_DIRECTION);
        u.uCamHeight.value = height;
        u.uWeight.value = weight;
        u.uSkyWeight.value = THREE.MathUtils.smoothstep(altitude, ATMOSPHERE_SHELL_FADE_IN_M, SHELL_SKY_FULL_M);
        u.uSkyGain.value = THREE.MathUtils.lerp(SHELL_SKY_GAIN, 1,
            THREE.MathUtils.smoothstep(altitude, SHELL_SKY_GAIN_START_M, SHELL_SKY_GAIN_END_M));
        SHELL_MATRIX.makeRotationFromQuaternion(camera.quaternion);
        u.uCamRot.value.setFromMatrix4(SHELL_MATRIX);
        const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
        u.uTanHalfFov.value.set(tanHalf * camera.aspect, tanHalf);
    }

    /** Hide the flat sky billboard in space; restore it in atmosphere. */
    private applySpaceSkyState(): void {
        if (!this.skyEntity) {
            return;
        }
        const altitude = this.playerCamera.main.position.y;
        const showcase = this.view === PlayerViewState.SHOWCASE;
        const inSpace = altitude >= SPACE_SKY_ALTITUDE_M && !showcase;
        this.skyEntity.enabled = !inSpace;
        // The weather fades out under the globe map as it takes over (the
        // shell paints the map over every scene pixel, clouds included), and
        // is switched off only once the map covers it completely.
        const cloudsShown = altitude < GLOBE_MAP_FADE_END_M || showcase;
        if (this.cloudField) {
            this.cloudField.enabled = cloudsShown;
        }
        if (this.cirrusField) {
            this.cirrusField.enabled = cloudsShown;
        }
    }

    /** Black clear behind terrain when above the atmosphere threshold. */
    private applySpaceClearColor(layers: RenderLayer[]): void {
        const inSpace = this.skyEntity !== undefined
            && !this.skyEntity.enabled
            && this.view !== PlayerViewState.SHOWCASE;
        for (let i = 0; i < layers.length; i++) {
            const layer = layers[i];
            if (inSpace && layer.target === MAIN_RENDER_TARGET_HD) {
                layer.clearColor = '#000000';
            } else {
                layer.clearColor = undefined;
            }
        }
    }

    getPlayer(): PlayerEntity {
        return this.player;
    }

    private resetOrbit() {
        this.viewYaw = 0;
        this.viewPitch = 0;
        this.viewZoom = 1;
    }

    // Accumulates the orbit yaw/pitch/zoom from any held numpad keys.
    private updateOrbitFromKeys(delta: number) {
        if (this.heldOrbitKeys.size === 0) {
            return;
        }
        let yawDir = 0;
        let pitchDir = 0;
        let zoomDir = 0;
        for (const code of this.heldOrbitKeys) {
            const dir = NUMPAD_ORBIT_DIR[code];
            if (dir) {
                yawDir += dir.yaw;
                pitchDir += dir.pitch;
            }
            const zoom = NUMPAD_ZOOM_DIR[code];
            if (zoom !== undefined) {
                zoomDir += zoom;
            }
        }
        this.viewYaw += yawDir * ORBIT_RATE * delta;
        this.viewPitch = clamp(this.viewPitch + pitchDir * ORBIT_RATE * delta,
            -ORBIT_PITCH_LIMIT, ORBIT_PITCH_LIMIT);
        if (zoomDir !== 0) {
            this.viewZoom = clamp(this.viewZoom * (1 + zoomDir * ZOOM_RATE * delta),
                ZOOM_MIN, ZOOM_MAX);
        }
    }

    // Orbits the active player camera around the view pivot by `viewYaw` (about the
    // world UP axis) and `viewPitch` (elevation), keeping the subject centred.
    private orbitCameraAroundAircraft() {
        if (this.view === PlayerViewState.STATIC_MODEL) {
            this._orbitPivot.copy(this.staticModelViews[this.staticModelIndex].position);
        } else if (this.view === PlayerViewState.AI_CHASE && this.aiOpponent) {
            this._orbitPivot.copy(this.aiOpponent.getDisplayPosition());
        } else if (this.view === PlayerViewState.CARRIER_OVER_STERN && this.kuz) {
            this._orbitPivot.copy(this.kuz.position);
        } else {
            this._orbitPivot.copy(this.player.getDisplayPosition());
        }
        this._orbitOffset
            .copy(this.playerCamera.main.position)
            .sub(this._orbitPivot)
            .applyAxisAngle(UP, this.viewYaw);
        // Elevation: rotate about the horizontal axis perpendicular to the offset.
        this._orbitAxis
            .copy(UP)
            .cross(this._orbitOffset);
        if (this._orbitAxis.lengthSq() > 1e-6) {
            this._orbitAxis.normalize();
            this._orbitOffset.applyAxisAngle(this._orbitAxis, this.viewPitch);
        }
        this._orbitOffset.multiplyScalar(this.viewZoom);
        this.playerCamera.main.position
            .copy(this._orbitPivot)
            .add(this._orbitOffset);
        this.playerCamera.main.up.copy(UP);
        if (this.view === PlayerViewState.AI_CHASE && this.aiOpponent?.enabled) {
            this.playerCamera.main.lookAt(this.player.getDisplayPosition());
        } else if (this.exteriorEnemyLock && this.isF2ExteriorView() && this.aiOpponent?.enabled) {
            this.playerCamera.main.lookAt(this.aiOpponent.getDisplayPosition());
        } else {
            this.playerCamera.main.lookAt(this._orbitPivot);
        }
    }

    private isF2ExteriorView(): boolean {
        return this.view === PlayerViewState.EXTERIOR_BEHIND
            || this.view === PlayerViewState.EXTERIOR_FRONT;
    }

    private toggleExteriorEnemyLock(): void {
        if (!this.aiOpponent?.enabled) {
            return;
        }
        this.exteriorEnemyLock = !this.exteriorEnemyLock;
        this.resetOrbit();
        this.syncExteriorEnemyLockTarget();
    }

    private syncExteriorEnemyLockTarget(): void {
        const target = this.exteriorEnemyLock && this.aiOpponent?.enabled
            ? this.aiOpponent
            : undefined;
        (this.cameraUpdaters.get(PlayerViewState.EXTERIOR_BEHIND) as ExteriorFrontBehindCameraUpdater)
            .setLookAtTarget(target);
        (this.cameraUpdaters.get(PlayerViewState.EXTERIOR_FRONT) as ExteriorFrontBehindCameraUpdater)
            .setLookAtTarget(target);
    }

    private clearExteriorEnemyLock(): void {
        if (!this.exteriorEnemyLock) {
            return;
        }
        this.exteriorEnemyLock = false;
        this.syncExteriorEnemyLockTarget();
    }

    private setCockpitPadlock(enabled: boolean): void {
        this.cockpitPadlock = enabled && !!this.player.weaponsTarget;
        if (this.cockpitPadlock) {
            this.resetOrbit();
        }
        (this.cameraUpdaters.get(PlayerViewState.COCKPIT_FRONT) as CockpitFrontCameraUpdater)
            .setPadlock(this.cockpitPadlock);
    }

    /** Tab: emit debris + hit smoke from the enemy plane for VFX debugging. */
    private debugEmitDebris(): void {
        if (!this.aiOpponent?.enabled) {
            return;
        }
        this._debugDebrisPos.copy(this.aiOpponent.getDisplayPosition());
        this.aiOpponent.readVelocity(this._debugDebrisVel);
        this.debrisField?.spawnDebugBurst(this._debugDebrisPos, this._debugDebrisVel);
        this.damageSmoke?.spawnDebugLeak(this.aiOpponent.simId);
    }

    private getDamageSmokePose(targetId: string): { position: THREE.Vector3; quaternion: THREE.Quaternion; velocity: THREE.Vector3; isAlive: boolean; isCrashed: boolean } | undefined {
        if (targetId === PLAYER_SIM_ID) {
            return {
                position: this.player.getDisplayPosition(),
                quaternion: this.player.getDisplayQuaternion(),
                velocity: this.player.getDisplayVelocity(),
                isAlive: this.player.isAlive(),
                isCrashed: this.player.isCrashed,
            };
        }
        for (let i = 0; i < this.aiOpponents.length; i++) {
            const ai = this.aiOpponents[i];
            if (ai.simId === targetId && ai.enabled) {
                return this.aiDamageSmokePose(ai);
            }
        }
        if (this.wingman && this.wingman.simId === targetId && this.wingman.enabled) {
            return this.aiDamageSmokePose(this.wingman);
        }
        return undefined;
    }

    private aiDamageSmokePose(ai: AiAircraftEntity): { position: THREE.Vector3; quaternion: THREE.Quaternion; velocity: THREE.Vector3; isAlive: boolean; isCrashed: boolean } {
        ai.readVelocity(this._damageSmokeVel);
        return {
            position: ai.getDisplayPosition(),
            quaternion: ai.getDisplayQuaternion(),
            velocity: this._damageSmokeVel,
            isAlive: ai.isAlive(),
            isCrashed: ai.isCrashed(),
        };
    }

    /**
     * Terrain wireframe coloured by QT zoom (one hue per LOD), plus aircraft
     * wireframe and visibility filtering for LOD debugging.
     */
    private toggleWireframeDebug(): void {
        setTerrainWireframe(!isTerrainWireframe());
        setAircraftWireframe(!isAircraftWireframe());
        setVisibleMeshesOnly(!isVisibleMeshesOnly());
    }

    private setupControls() {
        document.addEventListener('keydown', (event: KeyboardEvent) => {
            if (isOverlayKeyEvent(event)) {
                return;
            }
            if (event.code === 'F9') {
                event.preventDefault();
                void openSettingsDialog('World');
                return;
            }
            if (event.code === 'F10') {
                event.preventDefault();
                this.triggerModImport();
                return;
            }
            if (this.mapView) {
                // The map is the whole page: its keys, nothing of the free
                // camera's, and no menu on Escape.
                if (this.mapView.handleKey(event) || event.code === 'Escape' || event.code === 'F12') {
                    event.preventDefault();
                    event.stopPropagation();
                }
                return;
            }
            if (event.code === 'F12' && !event.shiftKey) {
                event.preventDefault();
                if (!event.repeat) {
                    this.openTerrainView();
                }
                return;
            }
            if (event.code === 'F4') {
                event.preventDefault();
                if (!event.repeat) {
                    this.toggleReplay();
                }
                return;
            }
            if (this.replaying && this.handleReplayKey(event)) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            if (this.state === GameState.SPAWN_MENU) {
                if (event.code === 'Escape') {
                    // The menu lives in the settings dialog; Esc closes that
                    // (seen as an overlay key above), so it has to reopen too.
                    event.preventDefault();
                    event.stopPropagation();
                    this.spawnPanel.show();
                }
                return;
            }
            if (this.state === GameState.FIXED_CAMERA) {
                if (event.code === 'Escape') {
                    // Opens the menu over the free camera, which stays put:
                    // closing the dialog lands back here, and only a spawn
                    // from it (via enterSpawnMenu) leaves this state.
                    event.preventDefault();
                    // As for a flight below: the dialog's own Esc handler
                    // would otherwise close it within this same key press.
                    event.stopPropagation();
                    this.heldFixedCameraKeys.clear();
                    this.fixedCameraRates = zeroFixedCameraRates();
                    this.spawnPanel.show();
                } else if (event.key === 'F8') {
                    event.preventDefault();
                    this.toggleWireframeDebug();
                } else if (FIXED_CAMERA_MOVE_KEYS.has(event.code)) {
                    event.preventDefault();
                    this.heldFixedCameraKeys.add(event.code);
                }
                return;
            }
            if (this.state !== GameState.PLAYER) {
                return;
            }
            if (event.code === 'Escape') {
                // Opens the menu; the dialog opening pauses the flight
                // (pauseForMenu) and closing it resumes.
                event.preventDefault();
                // The dialog attaches within this same key press (its opening
                // promises settle between listeners); without this its own Esc
                // handler, further down the dispatch, closes it straight away.
                event.stopPropagation();
                this.spawnPanel.show();
                return;
            }
            switch (event.key) {
                case 'F1': {
                    event.preventDefault();
                    this.resetOrbit();
                    if (this.view !== PlayerViewState.COCKPIT_FRONT) {
                        this.setCockpitFrontView();
                    } else if (this.player.weaponsTarget) {
                        // Second F1 in cockpit toggles padlock on the current target.
                        this.setCockpitPadlock(!this.cockpitPadlock);
                    }
                    break;
                }
                case 'F2': {
                    event.preventDefault();
                    this.resetOrbit();
                    this.setExteriorBehindFrontView();
                    break;
                }
                case 'F3': {
                    event.preventDefault();
                    this.resetOrbit();
                    this.setCarrierOverSternView();
                    break;
                }
                case 'F6': {
                    event.preventDefault();
                    this.resetOrbit();
                    this.setAiChaseView();
                    break;
                }
                case 'F8': {
                    event.preventDefault();
                    this.toggleWireframeDebug();
                    break;
                }
                case 'F9': {
                    event.preventDefault();
                    if (this.perfHud) {
                        this.perfHud.enabled = !this.perfHud.enabled;
                    }
                    break;
                }
                case 'F12': {
                    // Shift+F12 only: plain F12 opens the terrain view, above.
                    event.preventDefault();
                    this.toggleShowcaseView();
                    break;
                }
            }

            if (event.code === 'KeyV') {
                event.preventDefault();
                this.player.setForceVectorsEnabled(!this.player.forceVectorsEnabled);
            } else if (event.code === 'KeyN') {
                // Wing sweep: AUTO (Mach schedule) -> SPREAD -> SWEPT. Visual only.
                event.preventDefault();
                this.player.cycleWingSweepMode();
            } else if (event.code === 'KeyM') {
                // The tactical MFD's map page: the cover rasters under the scope.
                event.preventDefault();
                this.cockpit?.setMovingMapEnabled(!this.cockpit.movingMapEnabled);
            } else if (event.code === 'Tab') {
                if (event.repeat) {
                    return;
                }
                event.preventDefault();
                this.debugEmitDebris();
            } else if (event.code === 'Numpad5') {
                event.preventDefault();
                this.resetOrbit();
            } else if (event.code === 'NumpadEnter' && this.isF2ExteriorView()) {
                event.preventDefault();
                this.toggleExteriorEnemyLock();
            } else if (event.code === 'NumpadEnter' && this.view === PlayerViewState.COCKPIT_FRONT) {
                event.preventDefault();
                if (this.player.weaponsTarget) {
                    this.setCockpitPadlock(!this.cockpitPadlock);
                }
            } else if (event.code in NUMPAD_ORBIT_DIR || event.code in NUMPAD_ZOOM_DIR) {
                event.preventDefault();
                this.heldOrbitKeys.add(event.code);
            }
        }, { capture: true });

        document.addEventListener('keyup', (event: KeyboardEvent) => {
            this.heldOrbitKeys.delete(event.code);
            this.heldFixedCameraKeys.delete(event.code);
        });

        window.addEventListener('blur', () => {
            this.heldOrbitKeys.clear();
            this.heldFixedCameraKeys.clear();
            this.clearShowcasePickingState();
        });

        document.addEventListener('mousemove', (event: MouseEvent) => {
            this.updateShowcasePointerFromEvent(event);
            this.onCoverTooltipMove(event);
        });
        document.addEventListener('mousedown', (event: MouseEvent) => {
            if (event.button !== 0 || this.view !== PlayerViewState.SHOWCASE) {
                return;
            }
            this.showcasePointerDown = true;
            this.updateShowcasePointerFromEvent(event);
        });
        document.addEventListener('mouseup', (event: MouseEvent) => {
            if (event.button !== 0) {
                return;
            }
            this.showcasePointerDown = false;
            this.clearShowcaseHighlight();
        });

        document.addEventListener('keypress', (event: KeyboardEvent) => {
            if (!isOverlayKeyEvent(event) && this.state === GameState.PLAYER) {
                switch (event.key) {
                    case '4': {
                        if (this.player.weaponsTarget) {
                            this.setTargetView();
                        }
                        break;
                    }
                    case 'k': {
                        // Deck crew: rig the barricade, or strike it.
                        this.barricade?.toggle();
                        break;
                    }
                }
            } else if (this.state === GameState.SPAWN_MENU) {
                switch (event.key) {
                    case '1': {
                        void this.beginFlight('approach');
                        break;
                    }
                    case '2': {
                        void this.beginFlight('runway');
                        break;
                    }
                    case '3': {
                        void this.beginFlight('headon');
                        break;
                    }
                    case '4': {
                        void this.beginFlight('carrier');
                        break;
                    }
                    case '5': {
                        void this.beginFlight('carrierTakeoff');
                        break;
                    }
                    case '6': {
                        void this.beginFlight('highAlt');
                        break;
                    }
                    case '7': {
                        void this.beginFlight('space');
                        break;
                    }
                    case '8': {
                        void this.beginFlight('carrierBarricade');
                        break;
                    }
                    case '9': {
                        void this.beginFlight('closeWing');
                        break;
                    }
                }
            }

            switch (event.key) {
                case 'n': {
                    // Quick day/night flip: jumps the time-of-day setting between
                    // the default afternoon sun and midnight.
                    this.configService.daytime.setActive(
                        SUN_STATE.dayFactor > 0.5 ? 0 : DEFAULT_SUN_HOURS);
                    break;
                }
            }
        });
    }

    private leaveShowcaseIfActive() {
        if (this.view !== PlayerViewState.SHOWCASE) {
            return;
        }
        this.player.setShowcaseMode(false);
        this.player.setSimulationPaused(false);
        this.scene.setRenderFilter(undefined);
        this.viewBeforeShowcase = null;
        this.clearShowcasePickingState();
    }

    /**
     * F12: the terrain seen straight down, in a tab of its own, centred on
     * the aircraft in flight and on the camera anywhere else.
     */
    /**
     * The map mode: this page was opened by F12 as the map. The fixed camera
     * turns straight down through a long lens, the fog and the sky's altitude
     * effects go, and the map's own input (mapView.ts) drives the camera.
     */
    private enterMapView(): void {
        const fixed = this.fixedCameraUpdater;
        this.materials.setFog(FogQuality.NONE);
        for (const e of [this.cloudField, this.cirrusField]) {
            if (e) {
                e.enabled = false;
            }
        }
        // The fog is by distance whatever the fog setting, and the map camera
        // is kilometres up: with it, the whole map washes to sky colour.
        this.materials.setFogDensityScale(0);
        setMapLod(true);
        setLeafCoverFromM(1e9);
        // The map is always at noon, whatever the flight's time of day. Set
        // here, not through config.daytime, whose listener saves the setting.
        setSunTime(MAP_SUN_HOURS);
        this.refreshDaytimePalette();
        this.updateSunEntity();
        setBuildingsAtOnce(true);
        // Smooth shading reads better as a map: the slopes as relief, not
        // facets. Not saved, like the budget below.
        this.configService.terrainShading.setActive(TerrainShading.SMOOTH);
        // Leaves held further out (setMapLod) cost triangles: at the flight
        // budget a wide map merged patches of them back into flat parents,
        // squares that came and went. Not saved: only the settings dialog
        // writes this setting, and the map never opens it.
        this.configService.triangleBudget.setActive(
            Math.max(this.configService.triangleBudget.getActive(), MAP_TRIANGLE_BUDGET));
        SPACE_FOG.scale = 0;
        if (this.perfHud) {
            this.perfHud.enabled = false;
        }
        // The boot parked an aircraft at the base; the map marks the real one instead.
        this.player.enabled = false;
        const route = this.cameraRoute;
        this.mapCentre = route ? { lat: route.lat, lon: route.lon } : { ...this.playArea.origin };
        const basis = () => this.planetTerrain.basis;
        const centre = this.mapCentre;
        this.mapView = new MapView({
            container: document.getElementById('container')!,
            camera: this.playerCamera.main,
            pan: (dx, dz) => {
                const w = geodeticToWorld(basis(), centre.lat, centre.lon, 0);
                const g = geodeticOnSurfaceAtEnu(basis(), w.x + dx, -(w.z + dz));
                centre.lat = g.lat;
                centre.lon = g.lon;
            },
            centre: () => geodeticToWorld(basis(), centre.lat, centre.lon, 0),
            worldOf: (lat, lon) => geodeticToWorld(basis(), lat, lon, 0),
            geodeticOf: (x, z) => geodeticOnSurfaceAtEnu(basis(), x, -z),
            writeRoute: (lat, lon) => writeCameraRouteToLocation({
                lat, lon, altM: fixed.getPosition(this._fixedCameraPos).y, headingDeg: 0, pitchDeg: -89,
            }),
            groundAt: (px, py) => this.mapGroundAt(px, py),
        });
        this.placeMapCamera();
        // The waypoint editor: its panel in the left pane, its routes over the map.
        const editor = new MissionEditor({
            aircraft: this.aircraftRegistry.list().map(d => ({ id: d.id, name: d.name })),
            defaultAircraftId: this.currentDef.id,
            area: this.playArea.area.name,
            centre: () => ({ ...centre }),
            runwayEndAt: (lat, lon) => this.runwayEndAt(lat, lon),
        });
        this.missionOverlay = new MissionOverlay(
            this.mapView, editor, this.playerCamera.main, () => this.areaAirfields);
        void mountMissionPanel(document.body.appendChild(document.createElement('rfs-mission-panel')), editor);
    }

    /**
     * The runway end a click on the map means: on or beside a runway, the end
     * nearer the click - the threshold a take-off rolls from or a landing
     * touches down after.
     */
    private runwayEndAt(lat: number, lon: number): RunwayEnd | undefined {
        const basis = this.planetTerrain.basis;
        const p = geodeticToWorld(basis, lat, lon, 0);
        let best: RunwayEnd | undefined;
        let bestAcross = Infinity;
        for (const r of this.sceneRunways) {
            const fwd = headingForward(r.heading);
            const dx = p.x - r.center.x;
            const dz = p.z - r.center.z;
            const along = dx * fwd.x + dz * fwd.z;
            const across = Math.abs(dx * fwd.z - dz * fwd.x);
            if (across > Math.max(150, r.halfWidth * 3) || Math.abs(along) > r.halfLength + 500 || across >= bestAcross) {
                continue;
            }
            // Landing on the low designator flies along `heading`, from the end behind the centre.
            const [low, high] = r.ref.split('/');
            const mid = geodeticOnSurfaceAtEnu(basis, r.center.x, -r.center.z);
            best = { airfield: runwayKey(r), designator: along < 0 || !high ? low : high, lat: mid.lat, lon: mid.lon };
            bestAcross = across;
        }
        return best;
    }

    /**
     * Fly a mission: the player from its flight's start, every AI flight
     * spawned with its aircraft and handed its route (AiFlightPhase.WAYPOINT).
     * AI flights sharing a runway end line up one behind another and roll
     * MISSION_TAKEOFF_GAP_S apart, the one furthest down the runway first.
     */
    private async startMission(m: Mission): Promise<void> {
        const endKey = (f: Flight) => f.start.kind === 'runway' ? `${f.start.airfield}/${f.start.designator}` : '';
        const onEnd = new Map<string, number>();
        for (const f of m.flights) {
            onEnd.set(endKey(f), (onEnd.get(endKey(f)) ?? 0) + 1);
        }
        const slot = new Map<string, number>();
        let pool = 0;
        for (const f of m.flights) {
            const key = endKey(f);
            const k = slot.get(key) ?? 0;
            slot.set(key, k + 1);
            const def = (f.control === 'player' ? this.currentDef : this.aircraftRegistry.get(f.aircraftId))
                ?? this.currentDef;
            const back = (onEnd.get(key)! - 1 - k) * MISSION_RUNWAY_SPACING_M;
            const pose = await this.missionPose(f.start, def, back);
            if (!pose) {
                console.warn(`Mission flight ${f.name}: no runway ${f.start.kind === 'runway' ? key : ''} here`);
                continue;
            }
            const route = await this.missionRoute(f);
            if (f.control === 'player') {
                this.player.reset(pose.position, pose.heading, {
                    velocity: pose.velocity, throttle: pose.throttle ?? 0, airborne: pose.airborne ?? false,
                });
                this.combatSim.setRoute(PLAYER_SIM_ID, route);
                this.missionPlayer = { flight: f, next: 0 };
                continue;
            }
            if (pool >= MAX_FLIGHTS) {
                break;
            }
            await this.preloadAircraftModels(def);
            const simId = `mf${pool}`;
            let ai = this.missionAircraft[pool];
            if (ai) {
                ai.loadAircraft(def);
                ai.respawn(pose);
            } else {
                ai = new AiAircraftEntity(this.models, def, this.combatSim, simId, Faction.PLAYER, pose,
                    this.materials, PLAYER_GUN, MISSION_PILOT);
                ai.setGroundHeightAt((x, z) => this.drawnGroundHeightAt(x, z));
                if (this.wreckField) ai.setWreckField(this.wreckField);
                this.scene.add(ai);
                this.missionAircraft.push(ai);
            }
            this.combatSim.setRoute(simId, route);
            if (pose.airborne) {
                this.combatSim.setPhase(simId, AiFlightPhase.WAYPOINT);
            } else {
                this.combatSim.setPhase(simId, AiFlightPhase.GROUND_IDLE);
                this.missionTakeoffs.push({ simId, at: this.missionClock + k * MISSION_TAKEOFF_GAP_S });
            }
            pool++;
        }
    }

    /** Where and how a flight starts: on a runway end `back` metres short of the usual spot, or in the air. */
    private async missionPose(
        e: FlightEndpoint, def: FlyableAircraftDef, back: number,
    ): Promise<AiAircraftSpawn | undefined> {
        const basis = this.planetTerrain.basis;
        if (e.kind === 'air') {
            const p = geodeticToWorld(basis, e.lat, e.lon, e.altM);
            // A compass bearing, clockwise from north; scene heading PI is north.
            const heading = Math.PI - THREE.MathUtils.degToRad(e.headingDeg);
            return {
                position: new THREE.Vector3(p.x, p.y, p.z), heading, airborne: true, throttle: 0.8,
                velocity: headingForward(heading).multiplyScalar(e.speedMps),
            };
        }
        const near = geodeticToWorld(basis, e.lat, e.lon, 0);
        await this.buildAirfieldsNear(near.x, near.z);
        const r = this.missionRunway(e);
        if (!r) {
            return undefined;
        }
        const heading = e.designator === r.ref.split('/')[0] ? r.heading : r.heading + Math.PI;
        const fwd = headingForward(heading);
        // From the threshold the take-off rolls away from, the line-up spot and then back along the runway.
        const fromCentre = -r.halfLength + Math.max(60, MISSION_LINEUP_M + back);
        const x = r.center.x + fwd.x * Math.min(fromCentre, r.halfLength - 200);
        const z = r.center.z + fwd.z * Math.min(fromCentre, r.halfLength - 200);
        const rest = def.flight ? fm2GroundRestHeight(def.flight) : PLANE_DISTANCE_TO_GROUND;
        return {
            position: new THREE.Vector3(x, this.groundHeightAt(x, z) + rest, z), heading,
            airborne: false, throttle: 0, velocity: new THREE.Vector3(),
        };
    }

    /** A flight's waypoints in the scene frame, for the worker (which re-bases them with the scene). */
    private async missionRoute(f: Flight): Promise<AiRoute> {
        const basis = this.planetTerrain.basis;
        const end = f.land;
        const at = end && geodeticToWorld(basis, end.lat, end.lon, 0);
        let land: AiRoute['land'] = at && { x: at.x, z: at.z };
        if (land && end?.kind === 'runway') {
            await this.buildAirfieldsNear(land.x, land.z);
            const r = this.missionRunway(end);
            // The end picked: landing on the high designator is the runway turned round.
            if (r) {
                land = { ...land, heading: end.designator === r.ref.split('/')[0] ? r.heading : r.heading + Math.PI };
            }
        }
        return {
            points: f.waypoints.map(w => {
                const p = geodeticToWorld(basis, w.lat, w.lon, w.altM);
                return { x: p.x, y: p.y, z: p.z, speed: w.speedMps };
            }),
            next: 0,
            land,
        };
    }

    private missionRunway(e: FlightEndpoint & { kind: 'runway' }): SceneRunway | undefined {
        return this.sceneRunways.find(s => runwayKey(s) === e.airfield && s.ref.split('/').includes(e.designator));
    }

    /** Per frame while flying: AI flights rolling in turn, and the player's waypoint cue. */
    private updateMission(delta: number): void {
        this.missionClock += delta;
        if (this.missionTakeoffs.length > 0) {
            this.missionTakeoffs = this.missionTakeoffs.filter(t => {
                if (this.missionClock < t.at) {
                    return true;
                }
                this.combatSim.setPhase(t.simId, AiFlightPhase.TAKEOFF_ROLL);
                return false;
            });
        }
        const mp = this.missionPlayer;
        if (!mp) {
            return;
        }
        const w = mp.flight.waypoints[mp.next];
        if (!w) {
            const land = mp.flight.land;
            this.player.waypointCue = land?.kind === 'runway' ? `LAND ${land.designator}` : undefined;
            return;
        }
        // Geodetic every frame, so a re-base cannot leave it pointing at the old frame.
        const p = geodeticToWorld(this.planetTerrain.basis, w.lat, w.lon, 0, this._missionPoint);
        const dx = p.x - this.player.position.x;
        const dz = p.z - this.player.position.z;
        const dist = Math.hypot(dx, dz);
        // The capture radius the AI flies by (AiPilot.doWaypoint).
        const v = Math.max(50, this.player.velocityVector.length());
        if (dist < Math.max(400, 0.5 * v * v / 9.81)) {
            mp.next++;
            return;
        }
        const bearing = Math.round((540 - THREE.MathUtils.radToDeg(Math.atan2(dx, dz))) % 360);
        this.player.waypointCue = `WP${mp.next + 1} ${String(bearing).padStart(3, '0')} ${(dist / 1852).toFixed(1)}NM`;
    }

    /**
     * Hold the map camera over its centre, at the height its zoom asks for.
     *
     * The centre is kept as latitude and longitude, and the camera is put on
     * the true vertical there and turned to look down it: the scene's own
     * vertical leans away from it by degrees far from the frame's origin, and
     * a camera stood up along that would look at the wrong place - and carry
     * the next re-base (maybeRebase, read off the camera) there with it.
     */
    private placeMapCamera(): void {
        const map = this.mapView!;
        const { lat, lon } = this.mapCentre;
        const basis = this.planetTerrain.basis;
        const ground = geodeticToWorld(basis, lat, lon, 0, this._fixedCameraPos);
        const groundAlt = Math.max(0, this.planetTerrain.heightAtWorld(ground.x, ground.z) - ground.y);
        const above = map.cameraHeightAboveGround();
        // Tilted, the camera swings south round the centre at the same
        // distance, so the scale there holds; straight down it is right above.
        const localToScene = enuFrameRotation(makeEnuBasis(lat, lon, 0), basis);
        const tilt = map.tiltRad;
        const groundPoint = geodeticToWorld(basis, lat, lon, groundAlt);
        this.mapGround.copy(groundPoint);
        this.mapUp.set(0, 1, 0).applyQuaternion(localToScene);
        const offset = this._mapOffset.set(0, Math.cos(tilt), Math.sin(tilt))
            .multiplyScalar(above).applyQuaternion(localToScene);
        this.fixedCameraUpdater.setPosition(groundPoint.add(offset));
        this.fixedCameraUpdater.setStraightDown(localToScene, tilt);
        const camera = this.playerCamera.main;
        const near = Math.max(PLANE_DISTANCE_TO_GROUND, above * 0.02);
        if (camera.fov !== MAP_FOV_DEG || Math.abs(camera.near - near) > near * 0.1) {
            camera.fov = MAP_FOV_DEG;
            camera.near = near;
            camera.updateProjectionMatrix();
        }
    }

    /**
     * Keep the map's request inside the triangle budget. Over it, the budget
     * folds tiles into their parents, and which ones changes with every tile
     * that arrives: the map flickers. So once streaming has gone quiet, a
     * view that needed folding asks for a coarser cut, and one well under the
     * budget for a finer one - but never finer than a scale that has already
     * overflowed for this view. The count does not move smoothly with the
     * scale (a leaf holds several times its parent's triangles), so without
     * that floor the two rules took turns, a level flip every second.
     */
    private fitMapDetail(): void {
        const now = performance.now();
        if (now - this.mapDetailCheckMs < MAP_DETAIL_CHECK_MS) {
            return;
        }
        this.mapDetailCheckMs = now;
        const s = this.planetTerrain.stats;
        if (s.queued > 0 || s.inflight > 0 || s.pendingUploads > 0) {
            return;
        }
        const view = this.mapView!.viewVersion;
        if (view !== this.mapDetailView) {
            this.mapDetailView = view;
            this.mapDetailFloor = 1;
        }
        const budget = this.configService.triangleBudget.getActive();
        let scale = this.mapDetailScale;
        if (s.coarsenedTiles > 0 || s.triangleBudgetHit) {
            scale = Math.min(MAP_DETAIL_SCALE_MAX, scale * MAP_DETAIL_STEP);
            this.mapDetailFloor = scale;
        } else if (s.triangles < budget * MAP_DETAIL_FINER_BELOW && scale > this.mapDetailFloor) {
            scale = Math.max(this.mapDetailFloor, scale / MAP_DETAIL_STEP);
        }
        if (scale !== this.mapDetailScale) {
            this.mapDetailScale = scale;
            setMapDetailScale(scale);
        }
    }

    /** The map's ground plane (through its centre, square to the local up) under a CSS pixel. */
    private mapGroundAt(px: number, py: number): THREE.Vector3 | undefined {
        const container = document.getElementById('container')!;
        const camera = this.playerCamera.main;
        camera.updateMatrixWorld();
        const ndc = this._mapOffset.set(
            (px / container.clientWidth) * 2 - 1, -(py / container.clientHeight) * 2 + 1, 0.5);
        const ray = this._mapRay;
        ray.origin.copy(camera.position);
        ray.direction.copy(ndc.unproject(camera)).sub(camera.position).normalize();
        this._mapPlane.setFromNormalAndCoplanarPoint(this.mapUp, this.mapGround);
        return ray.intersectPlane(this._mapPlane, new THREE.Vector3()) ?? undefined;
    }

    private openTerrainView(): void {
        let aircraft: { lat: number; lon: number; headingDeg?: number } | undefined;
        if (this.state === GameState.PLAYER) {
            const p = this.player.position;
            const g = worldToGeodetic(this.planetTerrain.basis, p.x, p.y, p.z);
            const f = FORWARD.clone().applyQuaternion(this.player.quaternion);
            const headingDeg = (Math.atan2(f.x, -f.z) * 180 / Math.PI + 360) % 360;
            aircraft = { lat: g.lat, lon: g.lon, headingDeg };
        } else {
            const route = this.state === GameState.FIXED_CAMERA ? this.fixedCameraRoute() : this.cameraRoute;
            if (route) {
                aircraft = { lat: route.lat, lon: route.lon };
            }
        }
        const at = aircraft ?? this.playArea.origin;
        window.open(mapViewUrl({ lat: at.lat, lon: at.lon, aircraft }), '_blank');
    }

    private toggleShowcaseView() {
        if (this.view === PlayerViewState.SHOWCASE) {
            this.exitShowcaseView();
        } else if (!this.player.isCrashed) {
            this.enterShowcaseView();
        }
    }

    private enterShowcaseView() {
        this.viewBeforeShowcase = this.view;
        this.resetOrbit();
        restoreMainCameraParameters(this.playerCamera.main);
        this.player.setShowcaseMode(true);
        this.player.setSimulationPaused(true);
        this.scene.setRenderFilter(entity => entity === this.player);
        this.clearShowcasePickingState();
        this.setShowcaseView();
    }

    private exitShowcaseView() {
        this.player.setShowcaseMode(false);
        this.player.setSimulationPaused(false);
        this.scene.setRenderFilter(undefined);
        this.resetOrbit();
        const previous = this.viewBeforeShowcase ?? PlayerViewState.COCKPIT_FRONT;
        this.viewBeforeShowcase = null;
        restoreMainCameraParameters(this.playerCamera.main);
        this.clearShowcasePickingState();
        this.restoreView(previous);
    }

    private setShowcaseView() {
        this.view = PlayerViewState.SHOWCASE;
        this.player.exteriorView = true;
        this.cameraUpdater = this.getCameraUpdater(this.view);
        for (let i = 0; i < this.cockpitEntities.length; i++) {
            this.cockpitEntities[i].enabled = false;
        }
        for (let i = 0; i < this.exteriorEntities.length; i++) {
            this.exteriorEntities[i].enabled = false;
        }
    }

    private restoreView(view: PlayerViewState) {
        switch (view) {
            case PlayerViewState.COCKPIT_FRONT:
                this.setCockpitFrontView();
                break;
            case PlayerViewState.EXTERIOR_BEHIND:
            case PlayerViewState.EXTERIOR_FRONT:
                this.setExteriorView(view);
                break;
            case PlayerViewState.EXTERIOR_LEFT:
            case PlayerViewState.EXTERIOR_RIGHT:
                this.setExteriorView(view);
                break;
            case PlayerViewState.TARGET_TO:
            case PlayerViewState.TARGET_FROM:
                if (this.player.weaponsTarget) {
                    this.setExteriorView(view);
                } else {
                    this.setCockpitFrontView();
                }
                break;
            case PlayerViewState.STATIC_MODEL:
                this.setStaticModelView(this.staticModelIndex);
                break;
            default:
                this.setCockpitFrontView();
                break;
        }
    }

    private setCockpitFrontView() {
        this.leaveShowcaseIfActive();
        restoreMainCameraParameters(this.playerCamera.main);
        this.view = PlayerViewState.COCKPIT_FRONT;
        this.player.exteriorView = false;
        this.cameraUpdater = this.getCameraUpdater(this.view);
        // Entering cockpit always starts unlocked; toggle padlock with F1 / Numpad Enter.
        this.setCockpitPadlock(false);
        for (let i = 0; i < this.cockpitEntities.length; i++) {
            this.cockpitEntities[i].enabled = true;
        }
        for (let i = 0; i < this.exteriorEntities.length; i++) {
            this.exteriorEntities[i].enabled = false;
        }
    }

    private setExteriorBehindFrontView() {
        restoreMainCameraParameters(this.playerCamera.main);
        if (this.view !== PlayerViewState.EXTERIOR_BEHIND) {
            this.setExteriorView(PlayerViewState.EXTERIOR_BEHIND);
        } else {
            this.setExteriorView(PlayerViewState.EXTERIOR_FRONT);
        }
    }


    private setCarrierOverSternView() {
        restoreMainCameraParameters(this.playerCamera.main);
        this.setExteriorView(PlayerViewState.CARRIER_OVER_STERN);
    }

    private setTargetView() {
        restoreMainCameraParameters(this.playerCamera.main);
        if (this.view !== PlayerViewState.TARGET_TO) {
            this.setExteriorView(PlayerViewState.TARGET_TO);
        } else {
            this.setExteriorView(PlayerViewState.TARGET_FROM);
        }
    }

    private setAiChaseView() {
        if (!this.aiOpponent || !this.aiOpponent.enabled || !this.cameraUpdaters.has(PlayerViewState.AI_CHASE)) {
            return;
        }
        restoreMainCameraParameters(this.playerCamera.main);
        if (this.view !== PlayerViewState.AI_CHASE) {
            this.aiChaseHeading = ExteriorViewHeading.BACK;
        } else {
            this.aiChaseHeading = this.aiChaseHeading === ExteriorViewHeading.BACK
                ? ExteriorViewHeading.FRONT
                : ExteriorViewHeading.BACK;
        }
        (this.cameraUpdaters.get(PlayerViewState.AI_CHASE) as AiExteriorCameraUpdater)
            .setHeading(this.aiChaseHeading);
        this.setExteriorView(PlayerViewState.AI_CHASE);
    }


    private setStaticModelView(index: number) {
        restoreMainCameraParameters(this.playerCamera.main);
        const entry = this.staticModelViews[index];
        this.staticModelCameraUpdater.setTarget(entry.position, entry.heading);
        this.setExteriorView(PlayerViewState.STATIC_MODEL);
    }

    private setExteriorView(view: PlayerViewState) {
        this.leaveShowcaseIfActive();
        if (view !== PlayerViewState.EXTERIOR_BEHIND && view !== PlayerViewState.EXTERIOR_FRONT) {
            this.clearExteriorEnemyLock();
        }
        this.setCockpitPadlock(false);
        this.view = view;
        this.player.exteriorView = true;
        this.cameraUpdater = this.getCameraUpdater(this.view);
        for (let i = 0; i < this.cockpitEntities.length; i++) {
            this.cockpitEntities[i].enabled = false;
        }
        for (let i = 0; i < this.exteriorEntities.length; i++) {
            this.exteriorEntities[i].enabled = true;
        }
    }

    private getCameraUpdater(view: PlayerViewState): CameraUpdater {
        const updater = this.cameraUpdaters.get(view);
        assertIsDefined(updater);
        return updater;
    }

    /** Views that keep running after a crash rather than cutting to the crash camera. */
    private keepsViewThroughCrash(view: PlayerViewState): boolean {
        switch (view) {
            case PlayerViewState.COCKPIT_FRONT:
            case PlayerViewState.EXTERIOR_BEHIND:
            case PlayerViewState.EXTERIOR_FRONT:
            case PlayerViewState.EXTERIOR_LEFT:
            case PlayerViewState.EXTERIOR_RIGHT:
            case PlayerViewState.AI_CHASE:
            case PlayerViewState.TARGET_TO:
            case PlayerViewState.TARGET_FROM:
                return true;
            default:
                return false;
        }
    }

    /**
     * A hard ground impact that did not destroy the aircraft: it bends and
     * tears from this on (see WreckField.applyDamage), not only when it finally
     * crashes. The same crash scale as the break-up, from the speed into the ground
     * and the speed along it.
     */
    private noteSurvivableImpact(hit: SimHitEvent): void {
        // The fatal impact is the break-up's business; this is for ones it survives.
        if (hit.impactSpeed === undefined || hit.damage >= 50) {
            return;
        }
        const along = Math.hypot(hit.velocity[0], hit.velocity[2]);
        // The sim says how hard it was when it has worked that out (a belly landing's damage grows
        // linearly from nothing); otherwise it is the speed into the ground and along it.
        const severity = hit.severity ?? (hit.impactSpeed + 0.35 * along) / 110;
        if (severity < (hit.severity !== undefined ? 0.2 : LIVE_DAMAGE_MIN_SEVERITY)) {
            return;
        }
        const at = this._survivableHit.set(hit.position[0], hit.position[1], hit.position[2]);
        if (hit.targetId === PLAYER_SIM_ID) {
            this.player.noteGroundImpact(severity, at);
            return;
        }
        const ai = this.aiOpponents.find(a => a.simId === hit.targetId)
            ?? (this.wingman?.simId === hit.targetId ? this.wingman : undefined);
        ai?.noteGroundImpact(severity, at);
    }

    private readonly _survivableHit = new THREE.Vector3();

    /** What a point on the ground is, for the colour of the dust thrown up from it. */
    private surfaceKindAt(x: number, z: number): 'dirt' | 'water' | 'concrete' {
        if (!Number.isFinite(sampleCarrierMeshSurfaceYMax(x, z, this.carrierMeshes))) {
            if (!this.planetTerrain.isLandAtWorld(x, z) && this.surfacePads.sampleYMax(x, z) === -Infinity) {
                return 'water';
            }
        } else {
            return 'concrete'; // the carrier's deck
        }
        if (this.surfacePads.sampleYMax(x, z) !== -Infinity) {
            return 'concrete';
        }
        for (const r of this.sceneRunways) {
            const dx = x - r.center.x;
            const dz = z - r.center.z;
            const s = Math.sin(r.heading);
            const c = Math.cos(r.heading);
            if (Math.abs(dx * s + dz * c) <= r.halfLength && Math.abs(dx * c - dz * s) <= r.halfWidth + 3) {
                return 'concrete';
            }
        }
        return 'dirt';
    }

    /** Unit normal of the drawn ground at a point, from its slope. */
    private groundNormalAt(x: number, z: number): THREE.Vector3 {
        const h = 2;
        return new THREE.Vector3(
            -(this.drawnGroundHeightAt(x + h, z) - this.drawnGroundHeightAt(x - h, z)) / (2 * h),
            1,
            -(this.drawnGroundHeightAt(x, z + h) - this.drawnGroundHeightAt(x, z - h)) / (2 * h),
        ).normalize();
    }

    /** Set once the crash has been handled, so a view that carries on through it is not reset every frame. */
    private crashTransitionDone = false;

    transitionFromPlayerToCrashed() {
        if (this.view === PlayerViewState.CRASHED || this.crashTransitionDone) {
            return;
        }
        this.crashTransitionDone = true;
        this.damageSmoke?.ensureCrashPlume(PLAYER_SIM_ID);
        this.leaveShowcaseIfActive();
        // A flight view carries on through the crash with the same angles and
        // distance (the camera follows the cockpit piece, see the player's
        // wreck pose); anything else falls back to the orbiting crash camera.
        const keepView = PlayerViewState.CARRIER_OVER_STERN === this.view || this.keepsViewThroughCrash(this.view);
        if (!keepView) {
            this.resetOrbit();
        }
        if (this.view !== PlayerViewState.COCKPIT_FRONT || !keepView) {
            restoreMainCameraParameters(this.playerCamera.main);
        }
        if (!keepView) {
            this.view = PlayerViewState.CRASHED;
            this.cameraUpdater = this.getCameraUpdater(this.view);
        }
        this.player.exteriorView = true;
        for (let i = 0; i < this.cockpitEntities.length; i++) {
            this.cockpitEntities[i].enabled = false;
        }
        for (let i = 0; i < this.exteriorEntities.length; i++) {
            this.exteriorEntities[i].enabled = false;
        }
    }

    /** The settings dialog opened, by Esc, the ⋮ button or F9: a flight holds still under it. */
    private pauseForMenu() {
        if (this.state !== GameState.PLAYER || this.menuPaused) {
            return;
        }
        this.menuPaused = true;
        this.player.setSimulationPaused(true);
        this.heldOrbitKeys.clear();
    }

    /** The menu closed: a flight the dialog paused picks up again. A spawn has already cleared the flag. */
    private resumeFromMenu() {
        if (!this.menuPaused) {
            return;
        }
        this.menuPaused = false;
        if (this.state === GameState.PLAYER) {
            this.player.setSimulationPaused(false);
        }
    }

    private enterSpawnMenu() {
        this.menuPaused = false;
        this.state = GameState.SPAWN_MENU;
        this.player.setSimulationPaused(true);
        this.spawnMenu.afterCrash = false;
        this.spawnMenu.enabled = true;
        this.refreshAircraftMenu();
        this.spawnPanel.show();
        // The aircraft stays where it is: only a spawn button places it
        // (beginFlight), so opening the menu never moves anything.
        this.setCockpitFrontView();
    }

    /**
     * Arrow keys slide the fixed camera along and across its heading, Page
     * Up/Down raise and lower it, numpad 4/6 turn it and 8/2 pitch it. Moves
     * accelerate for as long as the key is held, see FIXED_CAMERA_TUNING.
     */
    private moveFixedCamera(delta: number): void {
        const r = this.fixedCameraRates;
        const input = fixedCameraInput(this.heldFixedCameraKeys);
        if (!stepFixedCameraRates(r, input, delta, FIXED_CAMERA_TUNING)) {
            if (!Number.isNaN(this.fixedCameraUrlAge)) {
                // Came to rest: the URL gets the exact final pose.
                this.syncFixedCameraUrl();
            }
            return;
        }
        this.fixedCameraUpdater.move(r.forward * delta, r.right * delta, r.up * delta);
        this.fixedCameraUpdater.turn(r.yaw * delta, r.pitch * delta);
        this.fixedCameraUrlAge = (Number.isNaN(this.fixedCameraUrlAge) ? 0 : this.fixedCameraUrlAge) + delta;
        if (this.fixedCameraUrlAge >= FIXED_CAMERA_URL_INTERVAL_S) {
            this.syncFixedCameraUrl();
            this.fixedCameraUrlAge = 0;
        }
    }

    /** The fixed camera's pose as a route: geodetic position, heading, pitch. */
    private fixedCameraRoute(): CameraRoute {
        const p = this.fixedCameraUpdater.getPosition(this._fixedCameraPos);
        const g = worldToGeodetic(this.planetTerrain.basis, p.x, p.y, p.z);
        return {
            lat: g.lat, lon: g.lon, altM: g.height,
            headingDeg: this.fixedCameraUpdater.heading, pitchDeg: this.fixedCameraUpdater.pitch,
        };
    }

    /** Write the camera's pose back to the page URL so it can be copied or reloaded. */
    private syncFixedCameraUrl(): void {
        this.cameraRoute = this.fixedCameraRoute();
        writeCameraRouteToLocation(this.cameraRoute);
        this.fixedCameraUrlAge = NaN;
    }

    /**
     * While flying, keep the page URL on the camera's current pose (whichever
     * view is active), so a copy or reload opens the fixed camera there.
     */
    private followFlightCameraInUrl(delta: number): void {
        this.flightCameraUrlAge += delta;
        if (this.flightCameraUrlAge < FLIGHT_CAMERA_URL_INTERVAL_S) {
            return;
        }
        this.flightCameraUrlAge = 0;
        const camera = this.playerCamera.main;
        camera.updateMatrixWorld();
        const p = camera.getWorldPosition(this._fixedCameraPos);
        const d = camera.getWorldDirection(this._flightCameraDir);
        const g = worldToGeodetic(this.planetTerrain.basis, p.x, p.y, p.z);
        // Same convention as FixedCameraUpdater: north is scene −z, up positive.
        const headingDeg = (Math.atan2(d.x, -d.z) * 180 / Math.PI + 360) % 360;
        const pitchDeg = Math.asin(Math.max(-1, Math.min(1, d.y))) * 180 / Math.PI;
        this.cameraRoute = { lat: g.lat, lon: g.lon, altM: g.height, headingDeg, pitchDeg };
        writeCameraRouteToLocation(this.cameraRoute);
    }

    /**
     * Write the just-placed spawn's pose to the page URL, replacing whatever
     * camera route brought us here: otherwise a reload or copied link right
     * after spawning would drop the player back at that URL's area instead
     * of the runway/carrier/approach they actually spawned into.
     */
    private syncSpawnCameraUrl(headingRad: number): void {
        if (this.urlCameraPending) {
            return;
        }
        const p = this.player.position;
        const g = worldToGeodetic(this.planetTerrain.basis, p.x, p.y, p.z);
        // Player heading is a scene rotation (0 = +z); the URL/camera
        // convention is heading from north = scene −z, i.e. +180°.
        const headingDeg = (headingRad * 180 / Math.PI + 180 + 360) % 360;
        this.cameraRoute = { lat: g.lat, lon: g.lon, altM: g.height, headingDeg, pitchDeg: 0 };
        writeCameraRouteToLocation(this.cameraRoute);
        this.flightCameraUrlAge = 0;
    }

    /** Scene position of a URL camera: its altitude is metres above the ellipsoid. */
    private cameraRouteWorld(route: CameraRoute): THREE.Vector3 {
        return geodeticToWorld(this.planetTerrain.basis, route.lat, route.lon, route.altM);
    }

    /**
     * Look from the URL's camera with the sim held. The aircraft stays where
     * the boot put it; the HUD and cockpit are off since nobody is in them.
     */
    private enterFixedCamera(route: CameraRoute) {
        this.cameraRoute = route;
        writeCameraRouteToLocation(route);
        // The boot spawn just wrote its own pose to the URL; put ours back.
        writeCameraRouteToLocation(route);
        this.state = GameState.FIXED_CAMERA;
        this.player.setSimulationPaused(true);
        this.spawnMenu.enabled = false;
        this.spawnPanel.hide();
        this.leaveShowcaseIfActive();
        this.resetOrbit();
        this.setCockpitPadlock(false);
        restoreMainCameraParameters(this.playerCamera.main);
        this.fixedCameraUpdater.setPose(this.cameraRouteWorld(route), route.headingDeg, route.pitchDeg);
        this.view = PlayerViewState.FIXED;
        this.player.exteriorView = true;
        this.cameraUpdater = this.getCameraUpdater(this.view);
        for (let i = 0; i < this.cockpitEntities.length; i++) {
            this.cockpitEntities[i].enabled = false;
        }
        for (let i = 0; i < this.exteriorEntities.length; i++) {
            this.exteriorEntities[i].enabled = false;
        }
        console.log(`fixed camera at (${route.lat}, ${route.lon}) ${route.altM} m, `
            + `heading ${route.headingDeg}, pitch ${route.pitchDeg}`);
    }

    /** Begin a flight using the aircraft + livery chosen in the spawn menu. */
    private async beginFlight(requested: SpawnMode, at?: { lat: number; lon: number }) {
        // Persist what was asked for, fly what this area allows: coming back
        // home should restore the runway start rather than the one an
        // imported area forced.
        this.persistSpawnSelection(requested);
        const spawn = this.spawnForArea(requested);
        const def = this.selectedAircraftDef();
        if (def) {
            await this.preloadAircraftModels(def);
        }
        this.applySelectedAircraft();
        this.state = GameState.PLAYER;
        this.stopReplay();
        this.recorder.clear();
        const seedMode: SpawnMode = at !== undefined ? 'approach' : spawn;
        const center = at !== undefined ? this.locationSpawnPosition(at) : this.spawnCenterEnu(spawn);
        // Respawning where the last flight was finds the whole pinned ring
        // still resident (pins are never released): nothing to stream, so no
        // blur and no streaming wait, only the countdown.
        const resident = this.kernelRunning && this.isSeedAreaResident(center.x, center.z, seedMode);
        if (this.kernelRunning && !resident) {
            // A respawn: blur the old view straight away rather than showing
            // the aircraft jump and the terrain around it fill in.
            this.streamHeld = true;
            hideCountdown();
            setBootStreaming(0, 'Loading terrain...');
        }
        // Held until the terrain under the spawn is in (see below); the menu
        // already paused it, the boot path has not.
        this.player.setSimulationPaused(true);
        this.spawnMenu.enabled = false;
        this.spawnPanel.hide();
        this.damageSmoke?.reset();
        this.wreckField?.clear();
        this.impactMarks?.clear();
        // A respawn at another airfield of a big area can land where nothing
        // has streamed in yet: build it, and its neighbours, before placing.
        const near = at !== undefined
            ? geodeticToWorld(this.planetTerrain.basis, at.lat, at.lon, 0)
            : this.activeRunway?.center;
        if (near !== undefined) {
            await this.buildAirfieldsNear(near.x, near.z);
        }

        // Place the plane first, then warm DEM/meshes around it with the
        // simulation still paused from the menu. The other order - warm, then
        // place - left the aircraft sitting live on the runway for the whole
        // preload, which for the 10 km spawn is several hundred tiles: long
        // enough to read as the spawn having done nothing. Pausing rather
        // than stepping through the wait means an airborne spawn does not
        // spend its groove falling into terrain that is not there yet.
        const closeWing = requested === 'closeWing' && at === undefined;
        const place = () => {
            if (closeWing) {
                // Airborne over the base, level, at a cruising speed.
                this.player.reset(this.closeWingSpawnPosition(), this.baseHeading,
                    this.approachSpawnState(CLOSE_WING_SPAWN_THROTTLE));
            } else if (at !== undefined) {
                this.player.reset(this.locationSpawnPosition(at), LOCATION_SPAWN_HEADING, {
                    velocity: headingForward(LOCATION_SPAWN_HEADING).multiplyScalar(APPROACH_SPEED_MPS),
                    throttle: PLAYER_APPROACH_SPAWN.throttle,
                    airborne: true,
                });
            } else if (spawn === 'runway') {
                this.player.reset(this.runwaySpawnPosition(), this.baseHeading, PLAYER_LAND_SPAWN);
            } else if (spawn === 'carrier') {
                this.player.reset(
                    this.carrierApproachSpawnPosition(),
                    PLAYER_CARRIER_HEADING,
                    this.carrierApproachSpawn(),
                );
            } else if (spawn === 'carrierBarricade') {
                this.player.reset(
                    this.carrierBarricadeSpawnPosition(),
                    PLAYER_CARRIER_HEADING,
                    this.carrierBarricadeSpawn(),
                );
            } else if (spawn === 'carrierTakeoff') {
                this.player.reset(
                    this.carrierTakeoffSpawnPosition(),
                    PLAYER_CARRIER_TAKEOFF_HEADING,
                    this.carrierTakeoffSpawn(),
                );
            } else if (spawn === 'highAlt') {
                this.player.reset(this.highAltSpawnPosition(), this.baseHeading,
                    this.approachSpawnState(PLAYER_SPACE_SPAWN.throttle));
            } else if (spawn === 'space') {
                this.player.reset(this.spaceSpawnPosition(), this.baseHeading,
                    this.approachSpawnState(PLAYER_SPACE_SPAWN.throttle));
            } else {
                // Approach and head-on both start on a short final toward the runway.
                this.player.reset(this.landApproachSpawnPosition(), this.baseHeading,
                    this.approachSpawnState(PLAYER_APPROACH_SPAWN.throttle));
            }
        };
        place();
        // The map has no flight to seed: its own tiles stream in on screen.
        if (!this.mapMode) {
            await this.preloadTerrainAroundPlane(center.x, center.z, seedMode);
        }
        // Again, now that the DEM under the spawn is resident: a runway or
        // final picked at another airfield was placed above whatever height
        // the coarse tier answered.
        place();
        const spawnHeading = at !== undefined ? LOCATION_SPAWN_HEADING
            : spawn === 'carrier' || spawn === 'carrierBarricade' ? PLAYER_CARRIER_HEADING
            : spawn === 'carrierTakeoff' ? PLAYER_CARRIER_TAKEOFF_HEADING : this.baseHeading;
        this.syncSpawnCameraUrl(spawnHeading);
        this.player.setSimulationPaused(false);
        if (this.kernelRunning) {
            void this.holdUntilStreamed(!resident);
        }

        // Fresh sortie: the deck crew has struck the barricade, except for the
        // barricade arrival, which starts with fresh webbing across the deck.
        this.barricade?.reset(at === undefined && spawn === 'carrierBarricade');
        this.barricadeStaleAfterSpawn = true;
        this.syncBarricade(true);
        if (at === undefined && spawn === 'carrierBarricade') {
            // A barricade arrival is a deck exercise, not a sortie: an opponent
            // spawned a few hundred metres ahead would be inside the ship.
            this.clearOtherAircraft();
            this.setCarrierOverSternView();
        } else {
            this.spawnOpponent(spawn === 'headon');
            this.spawnWingman(closeWing, at === undefined && spawn === 'runway');
            this.setCockpitFrontView();
        }
        if (this.aiOpponent?.enabled) {
            this.player.setWeaponsTarget(this.aiOpponent);
        }
    }

    /**
     * Build the shared combat systems: a {@link SceneWorldQuery} for AI terrain
     * and obstacle awareness, the projectile pool, the player's gun + AI
     * autopilot, and one AI-flown opponent.
     */
    /**
     * The static world as the sim worker wants it: colliders, obstacles, and
     * every runway with the active one first. Sent once by setupCombat and
     * again after every re-base.
     */
    private serializeSceneWorld(): SerializedWorld {
        // The AI is handed every runway in the area, with the one this session
        // is based at first: `runway()` means "the main one" and a pilot picks
        // its own by proximity. On a pyramid with no airfields this is the
        // authored airbase, exactly as it always was.
        const runways: Runway[] = this.sceneRunways.length > 0
            ? this.sceneRunways.filter(r => !r.startOnly)
                .sort((a, b) => Number(b === this.activeRunway) - Number(a === this.activeRunway))
                .map(r => ({
                    center: r.center.clone(),
                    heading: r.heading,
                    halfLength: r.halfLength,
                    halfWidth: r.halfWidth,
                }))
            : [{
                center: AIRBASE_RUNWAY.clone(),
                heading: PLAYER_STARTING_HEADING,
                halfLength: RUNWAY_HALF_LENGTH_M,
                halfWidth: RUNWAY_STRIP_HALF_WIDTH,
            }];

        return serializeWorld(
            [], this.obstacles, runways, this.skiJumps, this.carrierMeshes,
            (() => {
                const pose = this.carrierPose();
                return [defaultArrestorCableField(
                    pose.position.x, pose.position.y, pose.position.z, pose.quaternion,
                ), ...landArrestorFields(this.landWires)];
            })(),
            this.surfacePads.pads,
            this.sceneryMeshes,
        );
    }

    private setupCombat() {
        this.obstacles.length = 0;
        // The cylinder stands on the ground, not on Y = 0. Those are the same
        // point only at the play area's origin: scene Y is up from the tangent
        // plane there, so the ground falls away from it with distance and a
        // cylinder pinned to zero floats. At the Canaries airfield that put the
        // hangars a few tens of metres up; at a Crimean one, over a hundred —
        // an invisible column near every airbase that stopped an aircraft in
        // clear air. Same root as the altimeter reading raw Y: Y = 0 is not
        // the ground.
        const addObstacle = (x: number, z: number, radius: number, height: number) =>
            this.obstacles.push({
                position: new THREE.Vector3(x, this.obstacleBaseY(x, z), z),
                radius,
                height,
            });
        // Airbase hangars + control tower — placed wherever the airbase is.
        {
            const h1 = this.airbaseAt(AIRBASE_LOCAL.hangar1.x, AIRBASE_LOCAL.hangar1.z);
            const h2 = this.airbaseAt(AIRBASE_LOCAL.hangar2.x, AIRBASE_LOCAL.hangar2.z);
            const h3 = this.airbaseAt(AIRBASE_LOCAL.hangar3.x, AIRBASE_LOCAL.hangar3.z);
            const h4 = this.airbaseAt(AIRBASE_LOCAL.hangar4.x, AIRBASE_LOCAL.hangar4.z);
            const tw = this.airbaseAt(AIRBASE_LOCAL.tower.x, AIRBASE_LOCAL.tower.z);
            addObstacle(h1.x, h1.z, 45, 22);
            addObstacle(h2.x, h2.z, 45, 22);
            addObstacle(h3.x, h3.z, 45, 22);
            addObstacle(h4.x, h4.z, 45, 22);
            addObstacle(tw.x, tw.z, 25, 45);
        }
        // Every airport building OSM knows about, so an AI turning final over
        // a terminal knows it is there. A cylinder each: the pilot's avoidance
        // asks for the nearest one within a horizon, and a box would buy
        // nothing at the range that matters.
        for (const b of this.osmBuildings) {
            addObstacle(b.x, b.z, b.radius, b.height);
        }
        // Scenario scenery: only where it was actually placed.
        if (this.playArea.isHome) {
            const ref = this.airbaseAt(TARGET_LOCAL.refinery.x, TARGET_LOCAL.refinery.z);
            addObstacle(ref.x, ref.z, 70, 60);
            const sam = this.airbaseAt(TARGET_LOCAL.sam.x, TARGET_LOCAL.sam.z);
            addObstacle(sam.x, sam.z, 20, 25);
            const wh = this.airbaseAt(TARGET_LOCAL.warehouse.x, TARGET_LOCAL.warehouse.z);
            addObstacle(wh.x, wh.z, 45, 22);
        }

        // Hand the static world (terrain hills, ski jump, carrier deck, obstacles, runway)
        // to the sim worker so its AI pilots can navigate; then register the player as a
        // sim-owned aircraft (its physics + gun + autopilot all live there).
        this.combatSim.setWorld(this.serializeSceneWorld());
        this.worldSent = true;
        this.startHeightFieldMirror();
        this.combatSim.addAircraft({
            id: PLAYER_SIM_ID,
            faction: Faction.PLAYER,
            control: 'external',
            model: this.playerSimModelKind(),
            aircraftConfig: flightConfigWithArrestorHook(this.currentDef),
            pilotOptions: { cruiseAltitude: 3000, cruiseSpeed: 220, hardDeck: 150 },
            hitRadius: PLAYER_HIT_RADIUS_M,
            maxHealth: 100,
            gun: PLAYER_GUN,
            collision: this.currentDef.collisionMesh,
            spawn: this.playerSimSpawn(),
            enabled: true,
        });
        this.pushAircraftMeshes(PLAYER_SIM_ID, this.currentDef);
        this.player.setCombatSimClient(this.combatSim);
        this.player.setHasGun(true);
        this.player.setGroundHeightAt((x, z) => this.drawnGroundHeightAt(x, z));
        this.player.setAltitudeAt(
            (x, y, z) => this.planetTerrain.geodeticAltitudeAtWorld(x, y, z));

        // The weapons field is now a pure renderer of the worker's projectile pool.
        this.weaponsField = new WeaponsField(this.models, this.combatSim);
        this.scene.add(this.weaponsField);

        this.debrisField = new DebrisField(this.materials);
        this.scene.add(this.debrisField);
        this.impactMarks = new ImpactMarks(this.materials);
        this.impactMarks.setMovingSurface(this.carrierSurface);
        this.scene.add(this.impactMarks);
        this.wreckField = new WreckField();
        this.wreckField.setMovingSurface(this.carrierSurface);
        // The sea: open water that is neither land nor the carrier's deck nor a pad standing in it.
        const isOpenWater = (x: number, z: number): boolean =>
            !this.planetTerrain.isLandAtWorld(x, z)
            && !Number.isFinite(sampleCarrierMeshSurfaceYMax(x, z, this.carrierMeshes))
            && this.surfacePads.sampleYMax(x, z) === -Infinity;
        // The sea's own height, not the ground height (which includes the carrier's hull and deck).
        this.wreckField.setWaterTest(
            isOpenWater,
            (x, z) => this.planetTerrain.drawnHeightAtWorld(x, z) ?? this.planetTerrain.heightAtWorld(x, z));
        this.wreckField.onSplash = (position, _velocity, strength) => {
            this.damageSmoke?.spawnSplash(position, strength);
        };
        this.wreckField.onFoam = (position, radius, count) => {
            this.damageSmoke?.spawnFoam(position, radius, count);
        };
        this.wreckField.onMark = (position, normal, dirX, dirZ, length, width, strength) => {
            this.impactMarks?.add(position, normal, dirX, dirZ, length, width, strength);
        };
        this.wreckField.setGroundHeightAt((x, z) => this.drawnGroundHeightAt(x, z));
        this.wreckField.onBreakup = (e) => {
            // A burst per fireball-sized chunk of the hit: harder impacts throw more.
            const bursts = 1 + Math.round(e.severity * 3);
            for (let i = 0; i < bursts; i++) {
                this._debugDebrisPos.copy(e.position);
                this._debugDebrisPos.x += (Math.random() - 0.5) * 6;
                this._debugDebrisPos.z += (Math.random() - 0.5) * 6;
                this._debugDebrisPos.y += Math.random() * 3;
                this.debrisField?.spawnDebugBurst(this._debugDebrisPos, e.velocity);
            }
            // The fireball at the moment of impact, and the lake of burning fuel it leaves.
            this.damageSmoke?.spawnFireball(e.position, e.velocity, e.severity);
            const field = this.wreckField;
            // The lake is made of the fuel that falls out of the aircraft, from the crash on.
            // (On the sea there is no ground for it to spread over: the fuel just splashes.)
            if (!e.water) {
                this.damageSmoke?.addFirePool(e.position, e.velocity, e.severity);
            }
            // Dust cloud where it hit, bigger and wider for a harder hit.
            if (e.water) {
                // Into the sea: a big splash and a mist, not dust.
                this.damageSmoke?.spawnSplash(e.position, e.severity * 1.3);
            } else {
                this.damageSmoke?.spawnDust(e.position, e.velocity, Math.round(25 + 45 * e.severity), e.severity);
            }
            // Fires ride on the pieces: big at the fuselage, smaller at the wing roots.
            for (const fire of e.fires) {
                const fuselage = fire.kind === 'fuselage';
                if (fire.kind === 'brand') {
                    // A burning shard flung clear: a short, fierce fire that rides on it.
                    this.damageSmoke?.addAnchoredFire(
                        e.id, (out) => field?.fireWorld(fire, out) ?? false,
                        { rate: 26, life: 8 + Math.random() * 14, trickle: 14, small: true, drips: 0 });
                    continue;
                }
                this.damageSmoke?.addAnchoredFire(
                    e.id, (out) => field?.fireWorld(fire, out) ?? false,
                    {
                        rate: fuselage ? 44 : 15,
                        life: fuselage ? FUSELAGE_FIRE_LIFE_S : WING_ROOT_FIRE_LIFE_S,
                        trickle: fuselage ? FUSELAGE_SMOULDER_S : WING_ROOT_SMOULDER_S,
                        small: !fuselage,
                        // Burning fuel runs off the fuselage and the wing roots and falls into the lake.
                        drips: fuselage ? 9 : 3,
                    });
            }
        };
        // Fuel fires start as soon as the airframe is bent or torn, riding on the aircraft.
        this.wreckField.onDamage = (e) => {
            const entity = e.id === PLAYER_SIM_ID
                ? this.player
                : (this.aiOpponents.find(a => a.simId === e.id)
                    ?? (this.wingman?.simId === e.id ? this.wingman : undefined));
            if (!entity) {
                return;
            }
            for (const fire of e.fires) {
                const fuselage = fire.kind === 'fuselage';
                this.damageSmoke?.addAnchoredFire(
                    // Not the aircraft's own id: that would stand in for the wreck's fires at a crash.
                    e.id + ':damage',
                    (out) => entity.damagePointWorld(fire.local, out),
                    {
                        rate: fuselage ? 44 : 15,
                        life: fuselage ? FUSELAGE_FIRE_LIFE_S : WING_ROOT_FIRE_LIFE_S,
                        trickle: fuselage ? FUSELAGE_SMOULDER_S : WING_ROOT_SMOULDER_S,
                        small: !fuselage,
                        // The fuel runs out of the break and falls: the lake builds under it.
                        drips: fuselage ? 9 : 3,
                    });
            }
        };
        this.wreckField.onBurn = (position, life, intensity) => {
            this.damageSmoke?.addBurnSpot(position, life, intensity);
        };
        this.wreckField.onSplit = (position, velocity, strength) => {
            // A piece shattering on the ground: a spray of chips and a puff of dust.
            this.debrisField?.spawnDebugBurst(position, velocity);
            this.damageSmoke?.spawnDust(position, velocity, Math.round(10 + 15 * strength), strength * 0.8);
        };
        this.wreckField.onDust = (position, velocity, count, strength) => {
            this.damageSmoke?.spawnDust(position, velocity, count, strength * 0.6);
        };
        this.scene.add(this.wreckField);
        this.player.setWreckField(this.wreckField);
        this.damageSmoke = new DamageSmokeField(this.materials);
        this.damageSmoke.setGroundHeightAt((x, z) => this.drawnGroundHeightAt(x, z));
        this.damageSmoke.setMovingSurface(this.carrierSurface);
        this.damageSmoke.setWaterTest((x, z) =>
            !this.planetTerrain.isLandAtWorld(x, z)
            && !Number.isFinite(sampleCarrierMeshSurfaceYMax(x, z, this.carrierMeshes))
            && this.surfacePads.sampleYMax(x, z) === -Infinity);
        // The ground under the lake of fire is scorched as it spreads along the fuselage path.
        this.damageSmoke.onPoolMark = (position, dirX, dirZ, length, width) => {
            const ground = (x: number, z: number) => this.drawnGroundHeightAt(x, z);
            const h = 2;
            const normal = new THREE.Vector3(
                -(ground(position.x + h, position.z) - ground(position.x - h, position.z)) / (2 * h),
                1,
                -(ground(position.x, position.z + h) - ground(position.x, position.z - h)) / (2 * h),
            ).normalize();
            this.impactMarks?.add(position, normal, dirX, dirZ, length, width, 0.7);
        };
        // Burn marks appear under the fires and darken over time.
        this.damageSmoke.onBurnMark = (position, radius, strength, growSeconds) => {
            const heading = Math.random() * Math.PI * 2;
            const size = radius * 2;
            this.impactMarks?.addBurn(
                position, this.groundNormalAt(position.x, position.z),
                Math.sin(heading), Math.cos(heading), size * (0.8 + 0.5 * Math.random()), size, strength, growSeconds);
        };
        // The dust a contact throws up is the colour of what it touches.
        this.damageSmoke.surfaceAt = (x, z) => this.surfaceKindAt(x, z);
        this.damageSmoke.setPoseProvider((targetId) => this.getDamageSmokePose(targetId));
        this.scene.add(this.damageSmoke);
        this.combatSim.onHits = (hits) => {
            const gunHits = hits.filter(h => h.source !== 'scrape');
            const scrapes = hits.filter(h => h.source === 'scrape');
            if (gunHits.length > 0) {
                this.debrisField?.spawnFromHits(gunHits);
                this.damageSmoke?.spawnFromHits(gunHits);
                // A collision with another aircraft says how hard it was: the airframe bends and tears.
                for (const hit of gunHits) {
                    if (hit.severity !== undefined) {
                        this.noteSurvivableImpact(hit);
                    }
                }
            }
            if (scrapes.length > 0) {
                this.damageSmoke?.spawnGroundScrapes(scrapes);
                // Sparks fly off ground and concrete, not off water.
                this.debrisField?.spawnGroundScrapes(
                    scrapes.filter(h => this.surfaceKindAt(h.position[0], h.position[2]) !== 'water'));
                for (const scrape of scrapes) {
                    this.noteSurvivableImpact(scrape);
                }
            }
        };

        // Spawn N AI opponents (the snapshot + worker are already multi-aircraft;
        // each gets a distinct sim id ai0..aiN-1). They start disabled until the
        // player triggers a merge (see spawnOpponent). Same FlyableAircraftDef /
        // FM / FX as the player — only control: 'ai' vs keyboard/joystick.
        this.aiOpponents.length = 0;
        for (let i = 0; i < AI_OPPONENT_COUNT; i++) {
            const ai = new AiAircraftEntity(
                this.models,
                this.currentDef,
                this.combatSim,
                aiSimId(i),
                Faction.ENEMY,
                {
                    position: this.landApproachSpawnPosition().add(
                        headingForward(this.baseHeading).multiplyScalar(AI_SPAWN_DISTANCE_M)),
                    heading: this.baseHeading,
                    airborne: true,
                    throttle: PLAYER_APPROACH_SPAWN.throttle,
                    velocity: this.approachSpawnState(
                        PLAYER_APPROACH_SPAWN.throttle).velocity!.clone(),
                },
                this.materials,
                PLAYER_GUN,
                this.opponentPilotOptions(),
            );
            ai.enabled = false;
            this.combatSim.setEnabled(ai.simId, false);
            ai.setGroundHeightAt((x, z) => this.drawnGroundHeightAt(x, z));
            if (this.wreckField) ai.setWreckField(this.wreckField);
            this.scene.add(ai);
            this.aiOpponents.push(ai);
        }
        this.aiOpponent = this.aiOpponents[0];

        // The player's wingman: identical airframe/FM/FX to the opponents, but
        // Faction.PLAYER — so the projectile pool's same-faction check already
        // rules out friendly fire in both directions — and flown in the
        // FORMATION phase off the player rather than sent to ENGAGE.
        this.wingman = new AiAircraftEntity(
            this.models,
            this.currentDef,
            this.combatSim,
            WINGMAN_SIM_ID,
            Faction.PLAYER,
            {
                position: this.landApproachSpawnPosition().add(
                    RIGHT.clone().applyAxisAngle(UP, this.baseHeading)
                        .multiplyScalar(FORMATION_SLOT.side)),
                heading: this.baseHeading,
                airborne: true,
                throttle: PLAYER_APPROACH_SPAWN.throttle,
                velocity: this.approachSpawnState(
                    PLAYER_APPROACH_SPAWN.throttle).velocity!.clone(),
            },
            this.materials,
            PLAYER_GUN,
            this.opponentPilotOptions(),
        );
        this.wingman.enabled = false;
        this.combatSim.setEnabled(this.wingman.simId, false);
        this.wingman.setGroundHeightAt((x, z) => this.drawnGroundHeightAt(x, z));
        if (this.wreckField) this.wingman.setWreckField(this.wreckField);
        this.scene.add(this.wingman);

        this.cameraUpdaters.set(
            PlayerViewState.AI_CHASE,
            new AiExteriorCameraUpdater(this.player, this.playerCamera.main, this.aiOpponent!));
    }

    /** Current player transform as a combat-sim spawn descriptor. */
    private playerSimSpawn(): SimAircraftSpawn {
        return {
            position: this.player.position.toArray() as [number, number, number],
            quaternion: this.player.quaternion.toArray() as [number, number, number, number],
            velocity: this.player.velocityVector.toArray() as [number, number, number],
            landed: this.player.isLanded,
            throttle: this.player.throttleUnit,
            airborne: !this.player.isLanded,
        };
    }

    /** Pilot options for the next opponent spawn (includes active AI model). */
    private opponentPilotOptions(): AiPilotOptions {
        const model = this.configService.aiPilotModels.getActive();
        return {
            cruiseAltitude: APPROACH_ALTITUDE_M,
            cruiseSpeed: APPROACH_SPEED_MPS,
            combatSpeed: 180,
            gunRange: 900,
            hardDeck: 200,
            // CLASSIC-only knob; Shaw and Aggressive each run their own tactical
            // matrix (Offensive/Neutral/Defensive, resp. Attack/Merge/Counter).
            alwaysEngage: model === AiPilotModels.CLASSIC,
            skill: AiSkillLevel.ACE,
            model,
        };
    }

    /**
     * Spawn/enable AI opponents at the player's altitude/speed.
     * Same-heading: ahead on the player's nose. Head-on: ahead facing the player.
     */
    /** Empty sky: park every AI airframe and drop the player's autopilot target. */
    private clearOtherAircraft(): void {
        for (const ai of this.aiOpponents) {
            ai.enabled = false;
            this.combatSim.setEnabled(ai.simId, false);
        }
        if (this.wingman) {
            this.wingman.enabled = false;
            this.combatSim.setEnabled(this.wingman.simId, false);
        }
        this.aiStraightTimer = 0;
        this.combatSim.setTarget(PLAYER_SIM_ID, null);
        this.player.setWeaponsTarget(undefined);
    }

    private spawnOpponent(headOn = false) {
        if (this.aiOpponents.length === 0) {
            return;
        }
        const p = this.player.position;
        const playerForward = FORWARD.clone()
            .applyQuaternion(this.player.quaternion)
            .setY(0)
            .normalize();
        const playerHeading = Math.atan2(playerForward.x, playerForward.z);
        const right = RIGHT.clone().applyAxisAngle(UP, playerHeading);
        const speed = this.player.velocityVector.length();
        const aiHeading = headOn ? playerHeading + Math.PI : playerHeading;
        const aiForward = headOn
            ? playerForward.clone().negate()
            : playerForward.clone();
        const velocity = aiForward.multiplyScalar(speed);
        // Preserve vertical speed so co-altitude spawn stays level with the player.
        velocity.y = this.player.velocityVector.y;

        const standoff = headOn ? AI_HEADON_SPAWN_DISTANCE_M : AI_ENGAGE_SPAWN_DISTANCE_M;
        const pilotOptions = this.opponentPilotOptions();
        const scramble = this.configService.opponentsScramble.getActive();
        const field = scramble ? this.opponentField() : undefined;
        this.opponentSpawnNote = field ? `scramble ${field.runway.icao || field.runway.name} ${field.runway.ref}`
            : scramble ? `merge: no field (${this.sceneRunways.length} runways, base ${this.activeRunway?.ref ?? 'authored'})` : 'merge';
        if (field) {
            this.scrambleOpponents(field, pilotOptions);
            return;
        }
        const LATERAL_SPACING_M = 80;
        for (let i = 0; i < this.aiOpponents.length; i++) {
            const ai = this.aiOpponents[i];
            // Ahead at standoff; fan extras slightly aside.
            const lateral = this.aiOpponents.length === 1 ? 0 : (i - (this.aiOpponents.length - 1) / 2) * LATERAL_SPACING_M;
            const position = new THREE.Vector3(p.x, p.y, p.z)
                .addScaledVector(playerForward, standoff)
                .addScaledVector(right, lateral);

            // With the player parked there is no merge to fly: the opponent
            // used to be parked too, on the player's runway in ENGAGE, a
            // ground obstacle that got airborne only on its terrain guard. It
            // starts in the air above the field instead, as the wingman would.
            let throttle = this.player.throttleUnit;
            let aiVelocity = velocity;
            if (this.player.isLanded) {
                position.y = this.groundHeightAt(position.x, position.z) + WINGMAN_HOLD_ALTITUDE_AGL_M;
                aiVelocity = headingForward(aiHeading).multiplyScalar(WINGMAN_HOLD_SPEED_MPS);
                throttle = 1;
            }

            // Rebuild pilot so OSD AI-model changes apply on this merge.
            this.combatSim.setPilotOptions(ai.simId, pilotOptions);
            ai.respawn({ position, heading: aiHeading, airborne: true, throttle, velocity: aiVelocity });
            // Fight the whole friendly side — the player *and* the wingman —
            // re-picking as the fight develops, rather than tunnelling on the
            // one aircraft handed over at spawn.
            this.combatSim.setTargetFaction(ai.simId, Faction.PLAYER);
            this.combatSim.setPhase(ai.simId, AiFlightPhase.ENGAGE);
        }
        this.aiStraightTimer = 0;

        this.armPlayerAutopilot();
    }

    /**
     * Put the wingman on the player's wing for this flight. It always spawns
     * airborne: with the player parked on a runway or deck there is no wing slot
     * to sit in, so it starts overhead at {@link WINGMAN_HOLD_ALTITUDE_AGL_M}
     * and its pilot holds there until the player is actually flying.
     */
    private spawnWingman(close = false, onRunway = false): void {
        const wingman = this.wingman;
        if (!wingman) {
            return;
        }
        if (close) {
            this.spawnCloseWingman(wingman);
            return;
        }
        if (onRunway) {
            this.spawnScrambleWingman(wingman);
            return;
        }
        const p = this.player.position;
        const playerForward = FORWARD.clone()
            .applyQuaternion(this.player.quaternion)
            .setY(0)
            .normalize();
        const heading = Math.atan2(playerForward.x, playerForward.z);
        const right = RIGHT.clone().applyAxisAngle(UP, heading);

        const position = new THREE.Vector3(p.x, p.y, p.z)
            .addScaledVector(playerForward, -FORMATION_SLOT.trail)
            .addScaledVector(right, FORMATION_SLOT.side);
        position.y += FORMATION_SLOT.stack;

        let velocity: THREE.Vector3;
        let throttle: number;
        if (this.player.isLanded) {
            position.y = this.groundHeightAt(position.x, position.z) + WINGMAN_HOLD_ALTITUDE_AGL_M;
            velocity = playerForward.clone().multiplyScalar(WINGMAN_HOLD_SPEED_MPS);
            throttle = 1;
        } else {
            velocity = this.player.velocityVector.clone();
            throttle = this.player.throttleUnit;
        }

        // Rebuild the pilot so an OSD AI-model change applies to the wingman too.
        this.combatSim.setPilotOptions(wingman.simId, this.opponentPilotOptions());
        wingman.respawn({ position, heading, airborne: true, throttle, velocity });
        this.combatSim.setFormationLead(wingman.simId, PLAYER_SIM_ID);
        // Symmetrically, the wingman takes on whichever hostile is the best
        // target, and drops back to the wing when none is left alive.
        this.combatSim.setTargetFaction(wingman.simId, Faction.ENEMY);
        this.combatSim.setPhase(wingman.simId, AiFlightPhase.FORMATION);
    }

    /**
     * The runway opponents take off from when they scramble, and which way:
     * the nearest of another airfield's runways between OPPONENT_FIELD_MIN_M
     * and _MAX_M from the player. Failing that - an island with its
     * neighbours 100 km off - another runway of the player's own field, from
     * its far end, so they roll towards the player rather than in line behind.
     * Neither means an ordinary airborne merge.
     */
    private opponentField(): { runway: SceneRunway; heading: number } | undefined {
        const p = this.player.position;
        const home = this.activeRunway;
        const sameField = (r: SceneRunway) => home !== undefined && r.icao === home.icao && r.name === home.name;
        let best: SceneRunway | undefined;
        let bestD = Infinity;
        for (const r of this.sceneRunways) {
            if (sameField(r) || r.startOnly) continue;
            const d = Math.hypot(r.center.x - p.x, r.center.z - p.z);
            if (d >= OPPONENT_FIELD_MIN_M && d <= OPPONENT_FIELD_MAX_M && d < bestD) {
                bestD = d;
                best = r;
            }
        }
        if (best) {
            return { runway: best, heading: best.heading };
        }
        const other = this.sceneRunways.find(r => r !== home && sameField(r) && !r.startOnly);
        return other && home ? { runway: other, heading: wrapAngle(home.heading + Math.PI) } : undefined;
    }

    /**
     * Opponents parked on a threshold of `field`, lined up one behind another
     * facing `heading`, taking off to fight the friendly side: the pilot goes
     * from climb-out straight to its target.
     */
    private scrambleOpponents(field: { runway: SceneRunway; heading: number }, pilotOptions: AiPilotOptions): void {
        const r = field.runway;
        // The runway axis the way it is flown, to whichever end that starts from.
        const fwd = headingForward(field.heading);
        const reciprocal = Math.abs(wrapAngle(field.heading - r.heading)) > Math.PI / 2;
        const axis = reciprocal ? wrapAngle(r.heading + Math.PI) : r.heading;
        const axisFwd = headingForward(axis);
        for (let i = 0; i < this.aiOpponents.length; i++) {
            const ai = this.aiOpponents[i];
            const along = r.halfLength - RUNWAY_SPAWN_INSET_M - i * WINGMAN_SCRAMBLE_TRAIL_M;
            const x = r.center.x - axisFwd.x * along;
            const z = r.center.z - axisFwd.z * along;
            const position = new THREE.Vector3(x, this.groundHeightAt(x, z) + this.gearRestHeight(), z);
            this.combatSim.setPilotOptions(ai.simId, pilotOptions);
            ai.respawn({ position, heading: Math.atan2(fwd.x, fwd.z), airborne: false, throttle: 0, velocity: new THREE.Vector3() });
            this.combatSim.setTargetFaction(ai.simId, Faction.PLAYER);
            this.combatSim.setPhase(ai.simId, AiFlightPhase.TAKEOFF_ROLL);
        }
        this.aiStraightTimer = 0;
        this.armPlayerAutopilot();
    }

    /**
     * The player's in-worker autopilot (the `a` key) takes off, flies home and
     * lands; it does not fight. It used to be handed the opponent as a target
     * "for later", which now would turn every autopilot climb-out - and its
     * loiter - into a dogfight flown for the player.
     */
    private armPlayerAutopilot(): void {
        this.combatSim.setTarget(PLAYER_SIM_ID, null);
        this.combatSim.setPhase(PLAYER_SIM_ID, AiFlightPhase.RTB);
    }

    /**
     * The wingman parked on the runway behind the player, a little to the
     * right, nose down the runway: it rolls when the player does, holding its
     * own line, and joins the wing after climb-out (see
     * {@link AiFlightPhase.GROUND_IDLE} and the pilot's scramble).
     */
    private spawnScrambleWingman(wingman: AiAircraftEntity): void {
        const f = this.spawnFrame;
        const fwd = headingForward(f.heading);
        const side = THREE.MathUtils.clamp(f.halfWidth * 0.5, 5, WINGMAN_SCRAMBLE_SIDE_MAX_M);
        const p = this.player.position;
        const x = p.x - fwd.x * WINGMAN_SCRAMBLE_TRAIL_M + Math.cos(f.heading) * side;
        const z = p.z - fwd.z * WINGMAN_SCRAMBLE_TRAIL_M - Math.sin(f.heading) * side;
        const position = new THREE.Vector3(x, this.groundHeightAt(x, z) + this.gearRestHeight(), z);
        this.combatSim.setPilotOptions(wingman.simId, this.opponentPilotOptions());
        wingman.respawn({ position, heading: f.heading, airborne: false, throttle: 0, velocity: new THREE.Vector3() });
        this.combatSim.setFormationLead(wingman.simId, PLAYER_SIM_ID);
        this.combatSim.setTargetFaction(wingman.simId, Faction.ENEMY);
        this.combatSim.setPhase(wingman.simId, AiFlightPhase.GROUND_IDLE);
    }

    /** Height (m) of the current airframe's CG above the ground, resting on its gear. */
    private gearRestHeight(): number {
        return this.currentDef.flight ? fm2GroundRestHeight(this.currentDef.flight) : PLANE_DISTANCE_TO_GROUND;
    }

    /**
     * The wingman right beside the player on a parallel course: 4 m to the
     * right and 2 m above, abreast, at the player's speed, flying straight. It
     * holds heading, altitude and speed (it does not fly a formation slot of its
     * own, which would pull it away), so any contact is the player's doing.
     */
    private spawnCloseWingman(wingman: AiAircraftEntity): void {
        const p = this.player.position;
        const forward = FORWARD.clone().applyQuaternion(this.player.quaternion).setY(0).normalize();
        const heading = Math.atan2(forward.x, forward.z);
        const right = RIGHT.clone().applyAxisAngle(UP, heading);
        const position = new THREE.Vector3(p.x, p.y, p.z)
            .addScaledVector(right, CLOSE_WING_SIDE_M)
            .addScaledVector(UP, CLOSE_WING_ABOVE_M);
        const velocity = this.player.velocityVector.clone();
        this.combatSim.setPilotOptions(wingman.simId, this.opponentPilotOptions());
        wingman.respawn({ position, heading, airborne: true, throttle: this.player.throttleUnit, velocity });
        this.combatSim.setPhase(wingman.simId, AiFlightPhase.STRAIGHT);
    }

    /**
     * Dev telemetry, like __kernelStats: what each sim-flown aircraft's pilot
     * is doing, where it is and how fast, for the browser pane and headless
     * checks of the airfield phases. Read-only; nothing in the game uses it.
     */
    /** How the last opponent spawn was decided, for __aiStats. */
    private opponentSpawnNote = '';

    private publishAiStats(): void {
        const row = (id: string, pos: THREE.Vector3, enabled = true) => ({
            label: this.combatSim.getManeuverLabel(id) ?? '-', enabled,
            x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
            agl: Math.round(pos.y - this.groundHeightAt(pos.x, pos.z)),
        });
        const stats: Record<string, unknown> = {
            opponentSpawn: this.opponentSpawnNote,
            player: { ...row(PLAYER_SIM_ID, this.player.position), autopilot: this.player.isAutopilotEnabled,
                speed: Math.round(this.player.velocityVector.length()), landed: this.player.isLanded,
                vy: Math.round(this.player.velocityVector.y * 10) / 10,
                pitch: Math.round(Math.asin(FORWARD.clone().applyQuaternion(this.player.quaternion).y) * 573) / 10 },
        };
        if (this.wingman) stats.wingman = row(this.wingman.simId, this.wingman.position, this.wingman.enabled);
        this.aiOpponents.forEach((ai, i) => { stats[`opponent${i}`] = row(ai.simId, ai.position, ai.enabled); });
        this.missionAircraft.forEach(ai => {
            const g = worldToGeodetic(this.planetTerrain.basis, ai.position.x, ai.position.y, ai.position.z);
            stats[ai.simId] = { ...row(ai.simId, ai.position, ai.enabled), lat: g.lat, lon: g.lon };
        });
        (globalThis as Record<string, unknown>).__aiStats = stats;
    }

    /** After the straight-flight hold, promote AI opponents into ENGAGE. */
    private updateAiStraightTimer(delta: number): void {
        if (this.aiStraightTimer <= 0) {
            return;
        }
        this.aiStraightTimer -= delta;
        if (this.aiStraightTimer > 0) {
            return;
        }
        this.aiStraightTimer = 0;
        for (let i = 0; i < this.aiOpponents.length; i++) {
            const ai = this.aiOpponents[i];
            if (ai.enabled) {
                this.combatSim.setPhase(ai.simId, AiFlightPhase.ENGAGE);
            }
        }
    }

    private async setupScene(spawn: SpawnMode) {
        const manifest = await loadTerrainManifest(DEFAULT_TERRAIN_URL, setBootProgress);
        // Which baked area this session flies in, and therefore where the ENU
        // origin sits. Home keeps PLAY_ORIGIN exactly and gets the authored
        // scenery; anywhere else is terrain only, rebased onto its own centre
        // so vertices stay near the origin instead of a continent away from it.
        // A URL camera flies in whichever area holds it, not the saved one:
        // the terrain is only meshed near its area's origin.
        const routeArea = this.cameraRoute
            ? homeArea(terrainAreas(manifest), { ...this.cameraRoute, height: 0 })
            : undefined;
        if (this.cameraRoute && !routeArea) {
            console.warn(`camera route (${this.cameraRoute.lat}, ${this.cameraRoute.lon}) `
                + 'is outside every baked area');
        }
        this.playArea = resolvePlayArea(
            manifest, PLAY_ORIGIN, routeArea?.name ?? loadSettings().terrainArea,
        );
        this.areaList = terrainAreas(manifest);
        if (this.pendingDestination?.kind === 'airfield') {
            this.preferredIcao = this.pendingDestination.airfieldKey;
        }
        if (!this.playArea.isHome) {
            console.log(`flying in imported area "${this.playArea.area.name}" `
                + `(${this.playArea.origin.lat.toFixed(4)}, `
                + `${this.playArea.origin.lon.toFixed(4)}) — terrain only`);
        }
        spawn = this.spawnForArea(spawn);

        this.sunModel = this.models.getModel('lib:sun');
        const skyModel = this.models.getModel('lib:skyDome');
        this.skyEntity = new SimpleEntity(skyModel, SceneLayers.BackgroundSky, SceneLayers.BackgroundSky);
        this.scene.add(this.skyEntity);
        this.skyDome = skyDomeOf(skyModel);
        this.repaintSkyDome();

        // Above the air the dome is the wrong picture; this pass ray-marches the
        // shell instead. Its own weight keeps it off near the ground.
        this.atmosphereShell = new SimpleEntity(
            this.models.getModel('lib:atmosphereShell'), SceneLayers.ForegroundSky, SceneLayers.ForegroundSky);
        this.atmosphereShell.enabled = false;
        this.scene.add(this.atmosphereShell);

        // Same layer as the billboard, so it rides the rotation-only background
        // camera and the terrain pass paints over it where the ground is.
        // Disc into the background pass, glare into the foreground one: the
        // model keeps the two in separate LOD collections precisely so they can
        // be routed apart here.
        this.sunEntity = new SimpleEntity(this.sunModel, SceneLayers.BackgroundSky, SceneLayers.ForegroundSky);
        this.scene.add(this.sunEntity);
        this.updateSunEntity();

        // Low-poly cumulus deck, tiled around the camera (see SceneryField) with a
        // huge bounding area so it always covers wherever the player roams. Altitude
        // undulates smoothly per puff so the deck doesn't look perfectly flat.
        const cloudFieldOptions: SceneryFieldSettings = {
            tilesInField: 9,
            cellsInTile: 2,
            tileLength: 6000,
            cellVariations: [
                // Lower (negative) LOD bias than the default: clouds are huge,
                // numerous and never inspected up close like a vehicle, so
                // their haze-tier LOD levels (see cloudModelBuilder.ts) should
                // start shedding detail well before the default bias would
                // ever let them.
                { probability: 0.12, model: 'lib:cloudLarge', jitter: 1, randomRotation: true, lodBias: -2 },
                { probability: 0.18, model: 'lib:cloudMedium', jitter: 1, randomRotation: true, lodBias: -2 },
                { probability: 0.15, model: 'lib:cloudSmall', jitter: 1, randomRotation: true, lodBias: -2 },
                { probability: 0.55, model: 'lib:cloudNone', jitter: 0, randomRotation: false },
            ],
            statsKey: 'cloud',
        };
        const cloudAltitudeAt = (x: number, z: number) =>
            CLOUD_BASE_ALTITUDE_M + Math.sin(x * 0.00021) * Math.cos(z * 0.00017) * CLOUD_ALTITUDE_VARIATION_M;
        this.cloudField = new SceneryField(
            this.models,
            new THREE.Box2(new THREE.Vector2(-1e7, -1e7), new THREE.Vector2(1e7, 1e7)),
            cloudFieldOptions,
            cloudAltitudeAt,
        );
        this.scene.add(this.cloudField);

        // High-altitude cirrus streaks — a separate, sparser, much higher
        // band above the cumulus deck. Bigger tiles since streaks are large
        // and meant to read as occasional wisps rather than a solid layer.
        // No random rotation: real cirrus streaks all align with the same
        // high-altitude wind shear, so every streak keeps the same heading.
        const cirrusFieldOptions: SceneryFieldSettings = {
            tilesInField: 7,
            cellsInTile: 2,
            tileLength: 60000,
            cellVariations: [
                { probability: 0.08, model: 'lib:cirrusWide', jitter: 1, randomRotation: false },
                { probability: 0.12, model: 'lib:cirrusThin', jitter: 1, randomRotation: false },
                { probability: 0.8, model: 'lib:cirrusNone', jitter: 0, randomRotation: false },
            ],
            statsKey: 'cirrus',
        };
        const cirrusAltitudeAt = (x: number, z: number) =>
            CIRRUS_BASE_ALTITUDE_M + Math.sin(x * 0.00013 + 5) * Math.cos(z * 0.00009 + 5) * CIRRUS_ALTITUDE_VARIATION_M;
        this.cirrusField = new SceneryField(
            this.models,
            new THREE.Box2(new THREE.Vector2(-1e7, -1e7), new THREE.Vector2(1e7, 1e7)),
            cirrusFieldOptions,
            cirrusAltitudeAt,
        );
        this.scene.add(this.cirrusField);

        setBootProgress(35, 'Loading terrain...');
        this.planetTerrain = new TerrainEntity({
            manifest,
            manifestUrl: DEFAULT_TERRAIN_URL,
            materials: this.materials,
            enuOrigin: this.playArea.origin,
            terrainColour: this.configService.terrainColour,
            terrainShading: this.configService.terrainShading,
            terrainDetail: this.configService.terrainDetail,
            landuseBlend: this.configService.landuseBlend,
            landuseReach: this.configService.landuseReach,
            visibleZoom: this.configService.visibleZoom,
            landuseReveal: this.configService.landuseReveal,
            triangleBudget: this.configService.triangleBudget,
            farTileTextures: this.configService.farTileTextures,
            buildings: this.configService.buildings,
            roads: this.configService.roads,
            treeDensity: this.configService.treeDensity,
        });
        this.planetTerrain.setRenderScale(this.hdMainScale);
        await this.planetTerrain.load(DEFAULT_TERRAIN_URL);
        this.planetTerrain.setLodCamera(this.playerCamera.main);
        this.scene.add(this.planetTerrain);
        const center = this.spawnCenterEnu(spawn);
        setBootProgress(45, 'Loading terrain tiles...');
        // The airbase flatten pad is baked into both the mesh and the height
        // field, so there is no pad to lock here any more — that DEM sample and
        // the re-mesh it forced were the slowest step in the old boot.
        if (!this.mapMode) {
            await this.preloadTerrainAroundPlane(center.x, center.z, spawn);
        }
        if (this.cameraRoute && !this.mapMode) {
            const at = this.cameraRouteWorld(this.cameraRoute);
            await this.preloadTerrainAroundPlane(at.x, at.z, 'highAlt');
        }
        setBootProgress(50, 'Building terrain meshes...');
        // The airbase furniture goes around whichever runway this session is
        // based at, turned to its heading — see airbaseAt.
        // Airfields first: the runway this session is based at decides where
        // the spawns are, which way the ILS points, and where the hangars and
        // the ramp go — so it has to be chosen before any of that is placed.
        setBootProgress(60, 'Loading airfields...');
        this.surfacePads.clear();
        this.sceneryMeshes.length = 0;
        this.stagedSceneryMeshes.length = 0;
        await this.addOsmAirfields(this.scene);

        setBootProgress(68, 'Loading airbase...');
        await this.addAirBase(this.scene, this.models);

        // The rest is the Canaries scenario rather than the airfield — a
        // refinery, a SAM site and a warehouse at fixed offsets chosen for that
        // island. Somewhere else they would land on whatever happened to be
        // there.
        setBootProgress(75, 'Loading scenery...');
        if (this.playArea.isHome) {
            await this.addRefinery(this.scene, this.models);

            const samradar = new GroundTargetEntity(this.models.getModel('assets/samradar01.glb'), 0, 'SAM Radar', 'Stosneehar');
            {
                const p = this.airbaseAt(TARGET_LOCAL.sam.x, TARGET_LOCAL.sam.z);
                samradar.position.set(p.x, this.groundHeightMaxUnder(p.x, p.z, 25, 25), p.z);
            }
            this.scene.add(samradar);
            await this.addSolidSceneryMesh('assets/samradar01.glb', samradar);

            const warehouse = new GroundTargetEntity(this.models.getModel('assets/hangar01.gltf'), undefined, 'Warehouse', 'Radlydd');
            {
                const p = this.airbaseAt(TARGET_LOCAL.warehouse.x, TARGET_LOCAL.warehouse.z);
                warehouse.position.set(p.x, this.groundHeightMaxUnder(p.x, p.z, 30, 40), p.z);
            }
            warehouse.quaternion.setFromAxisAngle(UP, Math.PI / 2);
            this.scene.add(warehouse);
            await this.addSolidSceneryMesh('assets/hangar01.gltf', warehouse);
        }

        // All scenery is placed — its colliders become solid ground from here on.
        this.activateSceneryColliders();
        // And nothing grows on the pavement and roofs those pads stand for.
        this.planetTerrain.setSurfaceExclusion(buildSurfaceExclusion(this.surfacePads.pads));

        this.scene.add(this.player);

        this.setupCombat();

        const hud = new HUDEntity(this.player, this.configService);
        this.cockpitEntities.push(hud);
        this.scene.add(hud);

        const cockpit = new CockpitEntity(
            this.player, this.playerCamera.main, this.targetCamera.main,
            { basis: this.planetTerrain.basis, coverTextures: this.planetTerrain.coverTextures },
        );
        this.cockpit = cockpit;
        this.cockpitEntities.push(cockpit);
        this.scene.add(cockpit);

        const exteriorData = new ExteriorDataEntity(this.player, this.configService);
        exteriorData.enabled = false;
        this.exteriorEntities.push(exteriorData);
        this.scene.add(exteriorData);

        this.scene.add(this.spawnMenu);

        this.perfHud = new PerfHudEntity();
        this.scene.add(this.perfHud);
    }

    /**
     * Draw every airfield the bake found in this area.
     *
     * The terrain under each was already cut to its own plane by the mesh bake,
     * so the pavement here is laid on that same plane and the two agree by
     * construction rather than by both being roughly flat.
     *
     * A runway also becomes solid ground. Its collider is fitted to the drawn
     * surface rather than derived from the plane: sampling the pavement at
     * three points and taking the line through them folds in both the runway's
     * slope and the first-order curvature of the earth falling away from the
     * play origin, which over a 3 km strip is metres.
     */
    private async addOsmAirfields(scene: Scene): Promise<void> {
        const file = await this.planetTerrain.loadAirfields();
        this.spawnPanel.setSearchIndex(
            file.items.map(airfieldEntryOf), this.areaList, this.playArea.area.name);
        const here = airfieldsInArea(file, this.playArea.area.name);
        this.sceneRunways = sceneRunwaysOf(
            here, this.planetTerrain.basis, AIRFIELD_SURFACE_EPS_M);
        this.planetTerrain.setAirfieldExclusion(here);
        this.landWires = landArrestorWiresOf(here, this.planetTerrain.basis);
        this.osmSkiJumps = [];
        for (const { source, collider } of osmSkiJumpsOf(here, this.planetTerrain.basis)) {
            this.osmSkiJumps.push(collider);
            const ramp = new StaticSceneryEntity(new SkiJumpModelLibBuilder(
                'osmSkiJump', collider.length, collider.height, collider.halfWidth * 2,
            ).build(this.materials));
            ramp.position.set(collider.originX, collider.originY, collider.originZ);
            ramp.quaternion.setFromAxisAngle(UP, collider.heading);
            scene.add(ramp);
            if (!source.runUpFound) {
                console.warn(`ski-jump "${source.name}": no run-up in reach, uphill way guessed`);
            }
        }
        // The region's own base where it has one (Saki for Krim), else the
        // long runway nearest the middle of the area.
        const regionalHome = regionalHomeBase(this.playArea.area);
        this.homeRunway = pickStartRunway(this.sceneRunways, undefined, regionalHome);
        this.activeRunway = pickStartRunway(this.sceneRunways, this.preferredIcao, regionalHome);
        const homeField = this.homeRunway === undefined
            ? undefined
            : here.find(a => a.icao === this.homeRunway!.icao
                && a.name === this.homeRunway!.name);
        this.homeHasRealAprons = (homeField?.aprons.length ?? 0) > 0;
        this.homeHasOwnSkiJump = (homeField?.skiJumps?.length ?? 0) > 0;
        this.builtAirfields.clear();
        this.areaAirfields = here.map(airfield => {
            const p = geodeticToWorld(this.planetTerrain.basis, airfield.lat, airfield.lon, 0);
            return { airfield, x: p.x, z: p.z };
        });
        if (here.length === 0) {
            return;
        }
        // Every runway is solid, near or far: a pad is the airfield's own
        // fitted plane and needs no terrain, and the sim worker only gets its
        // colliders once, below in setupCombat.
        for (const runway of this.sceneRunways) {
            this.addRunwayPad(runway);
        }
        this.osmBuildings = [];
        // The rest - pavement, buildings, the target - only near the spawn;
        // the others stream in as the aircraft comes within range.
        const centre = this.activeRunway?.center;
        await this.buildAirfieldsNear(centre?.x ?? 0, centre?.z ?? 0);
        const active = this.activeRunway;
        console.log(`airfields: ${here.length} in "${this.playArea.area.name}", `
            + `${this.sceneRunways.length} runways, ${this.builtAirfields.size} built within `
            + `${AIRFIELD_STREAM_RADIUS_M / 1000} km`
            + (active ? `; based at ${active.icao || active.name} ${active.ref}` : ''));
        // Dev aid, alongside __terrain: the pavement is laid on the same plane
        // the terrain under it was cut to, and the only way to see whether
        // those two agree is to read the numbers back.
        (globalThis as Record<string, unknown>).__airfields = here;
        (globalThis as Record<string, unknown>).__runways = this.sceneRunways;
        (globalThis as Record<string, unknown>).__airfieldsBuilt = this.builtAirfields;
        (globalThis as Record<string, unknown>).__surfacePads = this.surfacePads;
        this.spawnPanel.setAirfields(
            airfieldChoices(this.sceneRunways),
            active ? runwayKey(active) : undefined);
    }

    /**
     * Build every not-yet-built airfield within AIRFIELD_STREAM_RADIUS_M of a
     * scene (x, z), nearest first: pavement, buildings, target, and solid
     * buildings (see addBuildingColliders). Runways are solid from boot.
     */
    private async buildAirfieldsNear(x: number, z: number): Promise<void> {
        const r2 = AIRFIELD_STREAM_RADIUS_M * AIRFIELD_STREAM_RADIUS_M;
        const due = this.areaAirfields
            .filter(a => !this.builtAirfields.has(a.airfield)
                && (a.x - x) ** 2 + (a.z - z) ** 2 <= r2)
            .sort((a, b) => ((a.x - x) ** 2 + (a.z - z) ** 2) - ((b.x - x) ** 2 + (b.z - z) ** 2));
        for (const { airfield } of due) {
            if (this.builtAirfields.has(airfield)) {
                continue;
            }
            this.builtAirfields.add(airfield);
            await this.buildAirfield(airfield);
        }
    }

    private async buildAirfield(airfield: Airfield): Promise<void> {
        // The ground under the taxiways has to be readable before they can be
        // draped on it, and the height store is an LRU: loaded right before
        // this field is built, not for every field of the area up front, or
        // the first fields' tiles are gone again by the time they are built.
        const primary = this.sceneRunways.find(
            r => r.primary && r.icao === airfield.icao && r.name === airfield.name);
        const at = primary?.center ?? geodeticToWorld(this.planetTerrain.basis, airfield.lat, airfield.lon, 0);
        await this.planetTerrain.heights.ensureLoadedAroundWorld(at.x, -at.z, AIRFIELD_GROUND_RADIUS_M);
        // Elevation of the real ground, which inside a runway's pad is the
        // airfield's own plane and outside it is whatever is there.
        const groundElevationAt = (e: number, n: number) =>
            this.planetTerrain.heights.geodeticHeightAtWorld(e, -n);
        // What the ground is made of, for a strip that is drawn as ground.
        const groundCoverAt = (e: number, n: number) =>
            this.planetTerrain.drawnCoverAtWorld(e, -n);

        const built = buildAirfieldModel(
            airfield, this.planetTerrain.basis, this.materials,
            groundElevationAt, groundCoverAt);
        if (built !== undefined) {
            this.pendingGroundStrips.push(...built.groundStrips);
            for (const strip of built.groundStrips) {
                // Infinity already here means the sea-level guard built it
                // (see RUNWAY_SEA_LEVEL_GUARD_M) - its cover is never
                // trusted, at any zoom, so it must not be finalized either.
                if (strip.paintedZoom !== Infinity) {
                    this.finalizeGroundStrip(strip);
                }
            }
            // A weapons target rather than plain scenery: an airfield is what
            // the ILS needles guide to, and picking one as a target is how the
            // player asks for them.
            const entity = new GroundTargetEntity(
                built.model, undefined, 'Airbase', airfield.icao || airfield.name);
            entity.position.copy(built.origin);
            if (primary !== undefined) {
                entity.approachRunway = {
                    center: primary.center.clone(),
                    heading: primary.heading,
                    halfLength: primary.halfLength,
                };
            }
            this.scene.add(entity);
            this.addPavementColliders(airfield, pavementColliders(
                built.solidPavement, built.origin, AIRFIELD_SURFACE_EPS_M));
        }
        this.addBuildingColliders(airfield);
    }

    /**
     * Make an airfield's aprons, taxiways and steel decks solid at the height
     * they are drawn, as its runways already are - before, an aircraft that
     * left the runway sank 1.5 m into them. Before setupCombat they join the
     * world it sends; streamed in later, they go to the sim worker themselves.
     */
    private addPavementColliders(airfield: Airfield, colliders: CarrierMeshCollider[]): void {
        if (colliders.length === 0) {
            return;
        }
        // Pavement appearing around an aircraft on the ground below it would
        // put it 1.5 m into the surface. Only after a teleport onto a field
        // that is not yet built; that field is left soft rather than crashing it.
        if (this.worldSent && colliders.some(c => this.aircraftInBox(c))) {
            console.warn(`airfield ${airfield.icao || airfield.name}: pavement left soft, an aircraft is on it`);
            return;
        }
        this.sceneryMeshes.push(...colliders);
        if (this.worldSent) {
            this.combatSim.addStaticColliders(serializeStaticColliders([], [], colliders));
        }
    }

    /** True when a live aircraft is inside a collider's box, up to a few metres above its top. */
    private aircraftInBox(c: CarrierMeshCollider): boolean {
        const positions: THREE.Vector3[] = [this.player.position];
        for (const ai of this.aiOpponents) {
            if (ai.isAlive()) {
                positions.push(ai.position);
            }
        }
        if (this.wingman?.isAlive()) {
            positions.push(this.wingman.position);
        }
        return positions.some(p => {
            const x = p.x - c.originX, y = p.y - c.originY, z = p.z - c.originZ;
            return x >= c.aabb.min[0] && x <= c.aabb.max[0] && z >= c.aabb.min[2] && z <= c.aabb.max[2]
                && y <= c.aabb.max[1] + BUILDING_STREAM_CLEARANCE_M;
        });
    }

    /**
     * Move the scene's origin under the aircraft - or under the fixed camera,
     * when that is what is looking - once it is {@link REBASE_DISTANCE_M}
     * from it.
     *
     * The scene is the tangent plane at its origin, so "up" is only up there:
     * at Leipzig, 175 km from the DACH centre, the horizon leaned 1.6 degrees
     * and level flight was not level. Re-basing keeps the lean under a fifth
     * of a degree. Everything holding scene coordinates is carried across by
     * the same rigid shift, so nothing on the ground moves.
     *
     * Only away from home: the carrier, the ski jump and the authored airbase
     * are colliders that cannot take a tilt, and that area is small enough
     * not to need it. Waits for a quiet moment - no sim step in flight (its
     * answer would come back in the old frame) and no airfield half built
     * from the old one.
     */
    private maybeRebase(): void {
        if (this.playArea.isHome || !this.worldSent || this.airfieldStreamBusy) {
            return;
        }
        const p = this.state === GameState.FIXED_CAMERA
            ? this.fixedCameraUpdater.getPosition(this._fixedCameraPos)
            : this.player.position;
        if (Math.hypot(p.x, p.z) < REBASE_DISTANCE_M || !this.combatSim.isIdle()) {
            return;
        }
        const under = worldToGeodetic(this.planetTerrain.basis, p.x, p.y, p.z);
        this.rebaseWorld(under.lat, under.lon);
    }

    private rebaseWorld(lat: number, lon: number): void {
        const t0 = performance.now();
        const shift = this.planetTerrain.rebaseTo(lat, lon);

        // Aircraft, trails, particles, scenery, airfields, clouds.
        this.scene.rebase(shift);
        this.recorder.rebase(shift);
        this.fixedCameraUpdater.rebase(shift);

        // The game's own records, rewritten in place so references to them
        // (the active runway, the home runway) stay good.
        for (const r of this.sceneRunways) {
            rebaseRunway(r, shift);
        }
        const pads = [...this.surfacePads.pads];
        for (const pad of pads) {
            rebaseSurfacePad(pad, shift);
        }
        this.surfacePads.clear();
        this.surfacePads.add(pads);
        for (const s of this.skiJumps) {
            rebaseSkiJump(s, shift);
        }
        for (const w of this.landWires) {
            shift.point(w.a);
            shift.point(w.b);
        }
        for (const m of this.carrierMeshes) {
            rebaseMeshCollider(m, shift);
        }
        for (const m of this.sceneryMeshes) {
            rebaseMeshCollider(m, shift);
        }
        for (const m of this.stagedSceneryMeshes) {
            rebaseMeshCollider(m, shift);
        }
        for (const o of this.obstacles) {
            shift.point(o.position);
        }
        const v = new THREE.Vector3();
        for (const b of this.osmBuildings) {
            shift.point(v.set(b.x, 0, b.z));
            b.x = v.x;
            b.z = v.z;
        }
        for (const a of this.areaAirfields) {
            shift.point(v.set(a.x, 0, a.z));
            a.x = v.x;
            a.z = v.z;
        }
        for (const strip of this.pendingGroundStrips) {
            for (const s of strip.samples) {
                shift.point(v.set(s.x, 0, s.z));
                s.x = v.x;
                s.z = v.z;
            }
        }
        for (const view of this.staticModelViews) {
            shift.point(view.position);
            view.heading = shift.heading(view.heading);
        }
        // The terrain's tree exclusions stay in the frame they were built in
        // (see TerrainEntity.rebaseTo), so they need nothing here.

        // The worker: its aircraft and rounds, then the frame its DEM mirror
        // reads in, then the world, which rebuilds the pilots.
        this.combatSim.rebase(shift);
        this.combatSim.setHeightField(this.heightFieldConfig());
        this.combatSim.setWorld(this.serializeSceneWorld());
        this.rebaseCount++;
        console.log(`re-based the scene to (${lat.toFixed(4)}, ${lon.toFixed(4)}) `
            + `in ${(performance.now() - t0).toFixed(1)} ms`);
    }

    /** How many times this session's origin has moved; a dev aid, see __rebases. */
    private rebaseCount = 0;

    /** Stream in airfields the aircraft has come within range of; throttled. */
    private streamAirfields(): void {
        if (this.areaAirfields.length === 0 || this.airfieldStreamBusy) {
            return;
        }
        const now = performance.now();
        if (now - this.lastAirfieldStreamMs < AIRFIELD_STREAM_INTERVAL_MS) {
            return;
        }
        this.lastAirfieldStreamMs = now;
        // The map and a camera placed from the URL have no aircraft flying:
        // their airfields come in around the camera.
        const p = this.state === GameState.FIXED_CAMERA
            ? this.fixedCameraUpdater.getPosition(this._fixedCameraPos) : this.player.position;
        this.airfieldStreamBusy = true;
        void this.buildAirfieldsNear(p.x, p.z)
            .catch(err => console.warn('airfield streaming failed', err))
            .finally(() => { this.airfieldStreamBusy = false; });
    }

    /**
     * Base the next flight at another airfield.
     *
     * Only the choice is recorded here. Everything derived from it — the
     * spawns, the hangars, the ILS, where the AI comes home to — is rebuilt on
     * the next `beginFlight`, because moving them under an aircraft that is
     * already flying would teleport the world around it.
     */
    private selectAirfield(icao: string): void {
        if (this.preferredIcao === icao) {
            return;
        }
        this.preferredIcao = icao;
        const picked = pickStartRunway(this.sceneRunways, icao);
        if (picked !== undefined) {
            this.activeRunway = picked;
        }
    }

    /**
     * Go to a spawn search result.
     *
     * In another area that means rebooting into it, the same way the World
     * tab's "Fly here" does, with the result carried over the reload. Here,
     * an airfield becomes the base the start buttons use, and a place or a
     * coordinate starts an airborne flight over it straight away.
     */
    private goToDestination(destination: SpawnDestination): void {
        if (destination.area === undefined) {
            return;
        }
        if (destination.area !== this.playArea.area.name) {
            savePendingDestination(destination);
            updateSettings({ terrainArea: destination.area });
            clearCameraRouteFromLocation();
            window.location.reload();
            return;
        }
        if (destination.kind === 'airfield' && destination.airfieldKey !== undefined) {
            this.selectAirfield(destination.airfieldKey);
            const active = this.activeRunway;
            this.spawnPanel.setAirfields(
                airfieldChoices(this.sceneRunways),
                active ? runwayKey(active) : undefined);
            return;
        }
        if (this.state !== GameState.SPAWN_MENU) {
            this.enterSpawnMenu();
        }
        void this.beginFlight(loadSettings().spawnMode, destination);
    }

    /** Airborne over a geodetic point, LOCATION_SPAWN_AGL_M above the ground, heading north. */
    private locationSpawnPosition(at: { lat: number; lon: number }): THREE.Vector3 {
        const p = geodeticToWorld(this.planetTerrain.basis, at.lat, at.lon, 0);
        return new THREE.Vector3(p.x, this.groundHeightAt(p.x, p.z) + LOCATION_SPAWN_AGL_M, p.z);
    }

    /**
     * One airport building: solid ground on its roof, and an obstacle round it.
     *
     * A box is an oriented rectangle at a height, which is exactly what a
     * surface pad already is - so a building needs no triangle soup at all.
     * That matters: a ground query walks every collider on every contact test
     * of every frame, and two hundred boxes of soup in that loop would be paid
     * for continuously, where two hundred analytic rectangles are a few
     * multiply-adds each.
     *
     * Being a *top* surface is what makes it solid from the side too. Fly into
     * a hangar below roof height and the ground under you is suddenly the
     * roof, so you are underground - which is the same test that decides every
     * other crash into terrain.
     */
    private buildingCollider(b: AirfieldBuilding): {
        pad: SurfacePadCollider;
        obstacle: { x: number; z: number; radius: number; height: number };
    } | undefined {
        const toWorld = (lat: number, lon: number) => sceneFromEnu(
            ecefToEnu(this.planetTerrain.basis, geodeticToEcef(lat, lon, 0)));
        const perDegLat = 110540;
        const perDegLon = Math.max(1, 111320 * Math.cos(b.lat * Math.PI / 180));
        const r = b.headingDeg * Math.PI / 180;
        // Along the footprint's long axis, and across it.
        const at = (along: number, across: number) => toWorld(
            b.lat + (along * Math.cos(r) - across * Math.sin(r)) / perDegLat,
            b.lon + (along * Math.sin(r) + across * Math.cos(r)) / perDegLon,
        );
        const centre = at(0, 0);
        const halfDepth = b.depthM / 2;
        const halfWidth = b.widthM / 2;
        const corners = [
            at(-halfDepth, -halfWidth), at(-halfDepth, halfWidth),
            at(halfDepth, halfWidth), at(halfDepth, -halfWidth),
        ];
        // The lowest corner, so a building on a slope is not floating - the
        // same rule the drawn box uses for its base.
        let baseY = Infinity;
        for (const c of corners) {
            baseY = Math.min(baseY, this.planetTerrain.heightAtWorld(c.x, c.z));
        }
        if (!Number.isFinite(baseY)) {
            return undefined;
        }
        const height = buildingHeightM(b);
        const ahead = at(halfDepth, 0);
        const pad: SurfacePadCollider = {
            centerX: centre.x,
            centerZ: centre.z,
            heading: Math.atan2(ahead.x - centre.x, ahead.z - centre.z),
            halfLength: halfDepth,
            halfWidth,
            surfaceY: baseY + height,
            baseY,
            // A wall is a step, not a ramp. Just enough that the edge is not a
            // mathematical discontinuity for the gear springs to land on.
            feather: BUILDING_PAD_FEATHER_M,
        };
        return {
            pad,
            obstacle: {
                x: centre.x, z: centre.z,
                radius: Math.hypot(b.widthM, b.depthM) / 2,
                height,
            },
        };
    }

    /**
     * Make an airfield's buildings solid. Before setupCombat they simply join
     * the world it sends; after it - an airfield streamed in mid-flight - they
     * go to the sim worker on their own, into the world it already holds.
     */
    private addBuildingColliders(airfield: Airfield): void {
        const pads: SurfacePadCollider[] = [];
        const obstacles: Obstacle[] = [];
        for (const b of airfield.buildings) {
            const collider = this.buildingCollider(b);
            if (collider === undefined) {
                continue;
            }
            // A roof appearing around an aircraft below it would put that
            // aircraft underground, which is a crash. Streaming builds fields
            // tens of km ahead, so this only happens after a teleport; that
            // building is left hollow rather than killing anyone.
            if (this.worldSent && this.aircraftUnder(collider.pad)) {
                console.warn(`airfield ${airfield.icao || airfield.name}: building left without `
                    + 'a collider, an aircraft is inside it');
                continue;
            }
            this.surfacePads.push(collider.pad);
            this.osmBuildings.push(collider.obstacle);
            pads.push(collider.pad);
            const o = collider.obstacle;
            obstacles.push({
                position: new THREE.Vector3(o.x, this.obstacleBaseY(o.x, o.z), o.z),
                radius: o.radius,
                height: o.height,
            });
        }
        if (!this.worldSent || pads.length === 0) {
            // setupCombat builds the obstacles from osmBuildings and sends it all.
            return;
        }
        this.obstacles.push(...obstacles);
        this.combatSim.addStaticColliders(serializeStaticColliders(pads, obstacles));
        this.planetTerrain.setSurfaceExclusion(buildSurfaceExclusion(this.surfacePads.pads));
    }

    /** True when any live aircraft is over `pad` and below its roof. */
    private aircraftUnder(pad: SurfacePadCollider): boolean {
        const positions: THREE.Vector3[] = [this.player.position];
        for (const ai of this.aiOpponents) {
            if (ai.isAlive()) {
                positions.push(ai.position);
            }
        }
        if (this.wingman?.isAlive()) {
            positions.push(this.wingman.position);
        }
        return positions.some(p => p.y < pad.surfaceY + BUILDING_STREAM_CLEARANCE_M
            && sampleSurfacePadY(p.x, p.z, pad) > -Infinity);
    }


    /**
     * Solid, sloping ground over one runway's pavement.
     *
     * The collider comes from the same three sampled points the drawn pavement
     * and the scene heading do, so the gear rests on the surface that is
     * visible rather than on a plane fitted separately to the same idea.
     */
    private addRunwayPad(runway: SceneRunway): void {
        this.surfacePads.push({
            centerX: runway.center.x,
            centerZ: runway.center.z,
            heading: runway.heading,
            halfLength: runway.halfLength,
            halfWidth: runway.halfWidth,
            surfaceY: runway.center.y,
            baseY: runway.center.y - AIRFIELD_SURFACE_EPS_M,
            feather: SURFACE_PAD_FEATHER_M,
            slope: runway.slope,
        });
    }

    private async addRefinery(scene: Scene, models: ModelManager) {
        const base = this.airbaseAt(TARGET_LOCAL.refinery.x, TARGET_LOCAL.refinery.z);
        const x = base.x;
        const z = base.z;
        const yAt = (px: number, pz: number, halfW = 40, halfD = 40) =>
            this.groundHeightMaxUnder(px, pz, halfW, halfD);

        const refinery = new GroundTargetEntity(models.getModel('assets/refinery_towers01.gltf'), 2, 'Oil Refinery', 'Radlydd');
        refinery.position.set(x, yAt(x, z, 80, 80), z);
        scene.add(refinery);
        await this.addSolidSceneryMesh('assets/refinery_towers01.gltf', refinery);

        const depot01a = new StaticSceneryEntity(models.getModel('assets/refinery_depot01.gltf'), 2);
        depot01a.position.set(x, yAt(x, z - 100), z - 100);
        scene.add(depot01a);
        await this.addSolidSceneryMesh('assets/refinery_depot01.gltf', depot01a);

        const depot01b = new StaticSceneryEntity(models.getModel('assets/refinery_depot01.gltf'), 2);
        depot01b.position.set(x, yAt(x, z + 100), z + 100);
        depot01b.quaternion.setFromAxisAngle(UP, Math.PI);
        scene.add(depot01b);
        await this.addSolidSceneryMesh('assets/refinery_depot01.gltf', depot01b);

        const depot01c = new StaticSceneryEntity(models.getModel('assets/refinery_depot01.gltf'), 2);
        depot01c.position.set(x + 100, yAt(x + 100, z - 100), z - 100);
        scene.add(depot01c);
        await this.addSolidSceneryMesh('assets/refinery_depot01.gltf', depot01c);

        const depot02a = new StaticSceneryEntity(models.getModel('assets/refinery_depot02.gltf'), 2);
        depot02a.position.set(x - 150, yAt(x - 150, z - 50), z - 50);
        scene.add(depot02a);
        await this.addSolidSceneryMesh('assets/refinery_depot02.gltf', depot02a);

        const depot02b = new StaticSceneryEntity(models.getModel('assets/refinery_depot02.gltf'), 2);
        depot02b.position.set(x + 150, yAt(x + 150, z + 50), z + 50);
        scene.add(depot02b);
        await this.addSolidSceneryMesh('assets/refinery_depot02.gltf', depot02b);
    }

    /** Register a flat lifted pavement as solid ground with a feathered edge skirt. */
    private addSurfacePad(
        centerX: number, centerZ: number, heading: number,
        halfLength: number, halfWidth: number,
        surfaceY: number, baseY: number,
    ): void {
        this.surfacePads.push({
            centerX, centerZ, heading, halfLength, halfWidth,
            surfaceY, baseY, feather: SURFACE_PAD_FEATHER_M,
        });
    }

    /**
     * Bake a placed scenery model into a solid ground collider (same soup
     * sampling as the carrier deck), applying the entity's rotation and scale.
     * Staged until {@link activateSceneryColliders} so it does not disturb
     * the placement of nearby scenery still being positioned.
     */
    private async addSolidSceneryMesh(
        url: string,
        entity: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 },
    ): Promise<void> {
        await this.models.waitForModel(url);
        const root = new THREE.Matrix4().compose(new THREE.Vector3(), entity.quaternion, entity.scale);
        const soup = bakeCollisionMeshFromModel(this.models.getModel(url), root);
        if (soup) {
            this.stagedSceneryMeshes.push(createCarrierMeshCollider(
                entity.position.x, entity.position.y, entity.position.z, soup,
            ));
        }
    }

    /** Make all staged scenery colliders solid; call once all scenery is placed. */
    private activateSceneryColliders(): void {
        this.sceneryMeshes.push(...this.stagedSceneryMeshes);
        this.stagedSceneryMeshes.length = 0;
    }

    /**
     * The furniture around the session's runway: apron, hangars, tower, ramp.
     *
     * The collider lists are cleared by the caller rather than here, because
     * the airfields are placed first and their runway pads must survive.
     */
    private async addAirBase(scene: Scene, models: ModelManager) {
        this.staticModelViews = buildStaticModelViews({
            at: (dx, dz) => this.airbaseAt(dx, dz),
            heading: this.baseFrame.heading,
        });
        const yAt = (px: number, pz: number, halfW = 40, halfD = 40) =>
            this.groundHeightMaxUnder(px, pz, halfW, halfD);
        const place = (dx: number, dz: number, halfW = 40, halfD = 40) => {
            const p = this.airbaseAt(dx, dz);
            return { x: p.x, y: yAt(p.x, p.z, halfW, halfD), z: p.z };
        };

        const baseHeading = this.baseFrame.heading;
        // The authored apron is two 200 m squares of pavement either side of
        // the runway, invented because the one airbase had no real ones. A
        // field that OSM maps aprons for has its own, at their own size and
        // shape, already drawn — and the squares then sit on top of them as
        // two grey rectangles that belong to nothing.
        const apron = this.homeHasRealAprons ? () => { } : (local: { x: number; z: number }) => {
            const ground = new StaticSceneryEntity(models.getModel('lib:pavement'), 5);
            const p = place(local.x, local.z, 100, 100);
            ground.position.set(p.x, p.y + SCENERY_SURFACE_EPS_M, p.z);
            ground.quaternion.setFromAxisAngle(UP, baseHeading);
            ground.scale.set(200, 1, 200);
            this.addSurfacePad(
                p.x, p.z, baseHeading, HANGAR_GROUND_HALF_M, HANGAR_GROUND_HALF_M,
                p.y + SCENERY_SURFACE_EPS_M, p.y);
            scene.add(ground);
        };
        apron(AIRBASE_LOCAL.hangarGround1);
        apron(AIRBASE_LOCAL.hangarGround2);

        // The authored runway model, only where the bake found no real one.
        //
        // It is a 3 km strip of pavement at the ENU origin with no relation to
        // anything on the ground, which is exactly what it was for while the
        // world had one invented airbase in it. Draw it beside a real GCLP and
        // it is a second airport in a field eight kilometres north.
        if (this.homeRunway === undefined) {
            const runway = new GroundTargetEntity(
                models.getModel('assets/runway01.gltf'), 0, 'Airbase', 'Stosneehar');
            runway.position.copy(AIRBASE_RUNWAY);
            const runwayPadY = yAt(AIRBASE_RUNWAY.x, AIRBASE_RUNWAY.z, 80, 900);
            runway.position.y = runwayPadY + SCENERY_SURFACE_EPS_M;
            scene.add(runway);
            // The pavement is solid ground: gear rests on its top, not the pad below.
            this.addSurfacePad(
                AIRBASE_RUNWAY.x, AIRBASE_RUNWAY.z, PLAYER_STARTING_HEADING,
                RUNWAY_HALF_LENGTH_M, RUNWAY_PAVEMENT_HALF_WIDTH,
                runway.position.y, runwayPadY,
            );
        }

        // Kuznetsov carrier from data/kuz.blend (exported via tools/export_kuz.py).
        // Collision soup is baked from the same GLB used for rendering.
        await this.models.waitForModel('assets/kuz.glb');
        const kuzModel = models.getModel('assets/kuz.glb');

        // At home the ship has its old berth ten kilometres off the coast. In
        // any other area it takes open water if there is some within reach and
        // otherwise level ground, where it stays moored.
        let atSea = true;
        if (!this.playArea.isHome) {
            const area = this.playArea.area;
            const basis = this.planetTerrain.basis;
            const f = this.baseFrame;
            const site = chooseCarrierSite({ x: f.centerX, z: f.centerZ }, f.halfLength + 800, {
                groundAt: (x, z) => this.planetTerrain.heightAtWorld(x, z),
                isLand: (x, z) => this.planetTerrain.isLandAtWorld(x, z),
                usable: (x, z) => {
                    if (this.surfacePads.sampleYMax(x, z) !== -Infinity) {
                        return false;
                    }
                    const g = worldToGeodetic(basis, x, 0, z);
                    return areaContains(area, g.lat, g.lon);
                },
            });
            KUZ_POSITION.x = site.x;
            KUZ_POSITION.z = site.z;
            atSea = site.atSea;
            // The search ran on whatever tier was resident; seat the hull on the fine one.
            await this.planetTerrain.pinArea(
                site.x, site.z, 1500, this.planetTerrain.maxZoom ?? 0);
        }
        this.carrierSpeedMps = atSea ? CARRIER_SPEED_MPS : 0;
        // The carrier is authored at scene y = 0, but ten km from the play
        // origin the sea is drawn ~8 m lower (the earth curves away from the
        // tangent plane), which left the ship hovering over the water. Sit it
        // on the drawn sea surface and move the hull's waterline clip with it.
        // Moored on land, the highest ground under the hull is that surface.
        const seaY = atSea
            ? this.planetTerrain.heightAtWorld(KUZ_POSITION.x, KUZ_POSITION.z)
            : carrierSurfaceY(KUZ_POSITION.x, KUZ_POSITION.z,
                (x, z) => this.planetTerrain.heightAtWorld(x, z));
        // The hull mesh runs 15 m below its origin; the real ship draws ~10 m,
        // so ride the model that much higher. The clip stays at the sea.
        KUZ_POSITION.y = ARRESTOR_CARRIER_ORIGIN.y + seaY + KUZ_HULL_RAISE_M;
        const clipData: { clipBelowYAbs?: number }[] = [];
        for (const level of kuzModel.lod) {
            for (const root of [...level.flats, ...level.volumes]) {
                root.traverse(obj => {
                    const mats = (obj as THREE.Mesh).material;
                    for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
                        const d = m.userData as { clipBelowYAbs?: number } | undefined;
                        if (d && typeof d.clipBelowYAbs === 'number' && d.clipBelowYAbs > -1e20) {
                            d.clipBelowYAbs = seaY + 0.05;
                            clipData.push(d);
                        }
                    }
                });
            }
        }
        this.carrierClipData = clipData;
        this.carrierAtSea = atSea;
        this.carrierMeshes.length = 0;
        const kuzCollision = bakeCollisionMeshFromModel(kuzModel);
        if (kuzCollision) {
            this.carrierMeshes.push(createCarrierMeshCollider(
                KUZ_POSITION.x,
                KUZ_POSITION.y,
                KUZ_POSITION.z,
                kuzCollision,
            ));
        }
        const kuz = new GroundTargetEntity(kuzModel, 0, 'Carrier', 'Stosneehar');
        kuz.position.copy(KUZ_POSITION);
        this.kuz = kuz;
        const carrierUpdater = this.cameraUpdaters.get(PlayerViewState.CARRIER_OVER_STERN);
        if (carrierUpdater instanceof CarrierOverSternCameraUpdater) {
            carrierUpdater.setCarrier(kuz);
        }
        scene.add(kuz);

        const arrestorCables = new ArrestorCablesEntity(
            this.materials,
            () => this.carrierPose(),
            () => this.player,
            (x, z) => this.groundHeightAt(x, z),
        );
        scene.add(arrestorCables);
        this.player.setArrestorCarrierPoseProvider(() => this.carrierPose());
        scene.add(new LandArrestorWiresEntity(this.materials, () => this.landWires, () => this.player));
        this.player.setLandWireProvider(id => landWireById(this.landWires, id));

        const barricade = new BarricadeEntity(
            this.materials,
            () => this.carrierPose(),
            () => {
                const w = this.combatSim.getBarricadeWeb();
                // With the player where it is drawn, for the webbing to go with it (BarricadeEntity.webToDrawn).
                return w && { ...w, drawn: { position: this.player.getDisplayPosition(), quaternion: this.player.getDisplayQuaternion() } };
            },
            () => this.barricadeDeckMap(),
        );
        this.barricade = barricade;
        // Debug: the sim's barricade webbing (particle count, solver ms of the last step).
        (globalThis as Record<string, unknown>).__barricadeWeb = (full = false) => {
            const w = this.combatSim.getBarricadeWeb();
            if (!w) return undefined;
            const layout = (barricade as unknown as { webLayout?: { upperBelt: number[]; lowerBelt: number[]; straps: number[][] } }).webLayout;
            return {
                generation: w.generation, particles: w.positions.length / 3, stepMs: w.stepMs,
                tetherKN: w.tetherForce?.map(f => +(f / 1e3).toFixed(0)), payout: w.payout?.map(p => +p.toFixed(1)),
                contacts: w.contacts, substeps: w.substeps, reactionKN: w.reaction?.map(r => +(r * 60 / 1e3).toFixed(0)),
                positions: full ? Array.from(w.positions) : undefined,
                drawnPositions: full && barricade.lastWebDrawn ? Array.from(barricade.lastWebDrawn) : undefined,
                warm: w.warm,
                // The dearest web step since the last call, every sim step counted.
                peakMs: this.combatSim.takeBarricadeWebPeakMs(),
                body: w.body,
                chains: full && layout ? [layout.upperBelt, layout.lowerBelt, ...layout.straps] : undefined,
            };
        };
        // Debug: the webbing against the carrier's real deck (its mesh, as the gear meets it), not the
        // flat plane the solver floors it on: the lowest gap, sim and drawn, and the jet's height.
        (globalThis as Record<string, unknown>).__barricadeDeckGap = () => {
            const w = this.combatSim.getBarricadeWeb();
            if (!w) return undefined;
            const pose = this.carrierPose();
            const cq = pose.quaternion ?? new THREE.Quaternion();
            const p = new THREE.Vector3();
            const gaps = (pos: ArrayLike<number>) => {
                let worst = Infinity, at = -1, deck = NaN, local: number[] = [];
                for (let i = 0; i < pos.length; i += 3) {
                    p.set(pos[i], pos[i + 1], pos[i + 2]).applyQuaternion(cq).add(pose.position as THREE.Vector3);
                    const y = sampleCarrierMeshSurfaceYMax(p.x, p.z, this.carrierMeshes);
                    if (!(y > 0)) continue;
                    if (p.y - y < worst) { worst = p.y - y; at = i / 3; deck = y; local = [pos[i], pos[i + 1], pos[i + 2]]; }
                }
                return { gap: +worst.toFixed(3), particle: at, deckWorldY: +deck.toFixed(2), local: local.map(v => +v.toFixed(2)) };
            };
            const jet = this.player.getDisplayPosition();
            const under = sampleCarrierMeshSurfaceYMax(jet.x, jet.z, this.carrierMeshes);
            const flat = new THREE.Vector3(0, BARRICADE_DECK_Y, 0).applyQuaternion(cq).add(pose.position as THREE.Vector3).y;
            return {
                sim: gaps(w.positions), drawn: barricade.lastWebDrawn ? gaps(barricade.lastWebDrawn) : undefined,
                jetAboveDeck: +(jet.y - under).toFixed(2), flatDeckWorldY: +flat.toFixed(2),
            };
        };
        scene.add(barricade);
        this.player.setBarricadeStatusProvider(() =>
            barricade.status(this.playerBarricadeEngagement() !== BarricadeEngagement.NONE));

        if (atSea) {
            const shipWake = new ShipWakeEntity(this.materials, () => this.carrierPose());
            scene.add(shipWake);
        }

        // Carrier-style ski jump down the home runway from the spawn, rising
        // toward +Z (takeoff). It used to stand 90 m ahead, which a standing
        // start reached at ~40 m/s - far under the 68 m/s the jet flies at - and
        // was thrown off it into the ground (the autopilot, at GCXO). 400 m of
        // run-up brings it to the ramp at ~70.
        this.skiJumps.length = 0;
        this.skiJumps.push(...this.osmSkiJumps);
        // A home airfield with a ski-jump of its own (Saki's T2) gets that one
        // only, not the generic ramp down its runway as well.
        if (!this.homeHasOwnSkiJump) {
            const skiJumpAheadM = 400;
            const home = this.baseFrame;
            const skiJumpHeading = home.heading;
            const fwd = headingForward(skiJumpHeading);
            // That far past where an aircraft lines up on the home runway.
            const fromCentre = home.halfLength - RUNWAY_SPAWN_INSET_M - skiJumpAheadM;
            const skiJumpOrigin = new THREE.Vector3(
                home.centerX - fwd.x * fromCentre, 0, home.centerZ - fwd.z * fromCentre);
            skiJumpOrigin.y = yAt(skiJumpOrigin.x, skiJumpOrigin.z, 30, 40);
            this.skiJumps.push(createSkiJumpCollider(
                skiJumpOrigin.x,
                skiJumpOrigin.y,
                skiJumpOrigin.z,
                skiJumpHeading,
            ));
            const skiJump = new StaticSceneryEntity(models.getModel('lib:skiJump'));
            skiJump.position.copy(skiJumpOrigin);
            skiJump.quaternion.setFromAxisAngle(UP, skiJumpHeading);
            scene.add(skiJump);
        }

        const hangar1 = new StaticSceneryEntity(models.getModel('assets/hangar01.gltf'));
        {
            const p = place(AIRBASE_LOCAL.hangar1.x, AIRBASE_LOCAL.hangar1.z, 40, 50);
            hangar1.position.set(p.x, p.y, p.z);
        }
        hangar1.quaternion.setFromAxisAngle(UP, baseHeading + Math.PI / 2);
        scene.add(hangar1);
        await this.addSolidSceneryMesh('assets/hangar01.gltf', hangar1);

        const hangar2 = new StaticSceneryEntity(models.getModel('assets/hangar01.gltf'));
        {
            const p = place(AIRBASE_LOCAL.hangar2.x, AIRBASE_LOCAL.hangar2.z, 40, 50);
            hangar2.position.set(p.x, p.y, p.z);
        }
        hangar2.quaternion.setFromAxisAngle(UP, baseHeading + Math.PI / 2);
        scene.add(hangar2);
        await this.addSolidSceneryMesh('assets/hangar01.gltf', hangar2);

        const hangar3 = new StaticSceneryEntity(models.getModel('assets/hangar01.gltf'));
        {
            const p = place(AIRBASE_LOCAL.hangar3.x, AIRBASE_LOCAL.hangar3.z, 40, 50);
            hangar3.position.set(p.x, p.y, p.z);
        }
        hangar3.quaternion.setFromAxisAngle(UP, baseHeading + Math.PI / 2);
        scene.add(hangar3);
        await this.addSolidSceneryMesh('assets/hangar01.gltf', hangar3);

        const hangar4 = new StaticSceneryEntity(models.getModel('assets/hangar01.gltf'));
        {
            const p = place(AIRBASE_LOCAL.hangar4.x, AIRBASE_LOCAL.hangar4.z, 40, 50);
            hangar4.position.set(p.x, p.y, p.z);
        }
        hangar4.quaternion.setFromAxisAngle(UP, baseHeading + Math.PI);
        scene.add(hangar4);
        await this.addSolidSceneryMesh('assets/hangar01.gltf', hangar4);

        const staticAircraft: Promise<void>[] = [];
        forEachStaticAircraftSlot(this.staticModelViews, (type, position, heading) => {
            const gy = yAt(position.x, position.z, 15, 15);
            const plane = new StaticSceneryEntity(models.getModel(type.body), type.lodBias);
            plane.position.copy(position).setY(gy + PLANE_DISTANCE_TO_GROUND);
            plane.quaternion.setFromAxisAngle(UP, heading);
            scene.add(plane);
            staticAircraft.push(this.addSolidSceneryMesh(type.body, plane));

            const shadow = new StaticSceneryEntity(models.getModel(type.shadow), type.lodBias);
            shadow.position.copy(position).setY(gy + SCENERY_SURFACE_EPS_M);
            shadow.quaternion.setFromAxisAngle(UP, heading);
            scene.add(shadow);
        });
        await Promise.all(staticAircraft);

        const tower = new StaticSceneryEntity(models.getModel('assets/control01.gltf'));
        {
            const p = place(AIRBASE_LOCAL.tower.x, AIRBASE_LOCAL.tower.z, 30, 30);
            tower.position.set(p.x, p.y, p.z);
        }
        tower.quaternion.setFromAxisAngle(UP, -Math.PI / 2);
        scene.add(tower);
        await this.addSolidSceneryMesh('assets/control01.gltf', tower);
    }


    private getPalette(): Palette {
        return this.palette;
    }

    /**
     * Rebuilds the active palette from the current sun position and pushes it to
     * the renderer and the materials.
     */
    /**
     * Points the sun disc down {@link SUN_DIRECTION}. Only called when the sun
     * actually moves - the time of day is a setting here, not a running clock.
     *
     * The disc is hidden once it is wholly under the geometric horizon. Terrain
     * covers it before that, so the two hand over without a visible pop; what
     * this does not model is the horizon dipping at altitude, where a real sun
     * stays up a few degrees longer than it does at sea level.
     */
    private updateSunEntity() {
        if (!this.sunEntity) {
            return;
        }
        this.sunEntity.enabled = SUN_STATE.elevationDeg > SUN_SET_ELEVATION_DEG;
        if (!this.sunEntity.enabled) {
            return;
        }
        placeSun(SUN_DIRECTION, this.sunEntity.position, SUN_FACING);
        this.sunEntity.quaternion = SUN_FACING;
    }

    private refreshDaytimePalette() {
        this.palette = daytimePalette(this.noonPalette, this.midnightPalette);
        // Forwards to the material manager too, so every live material picks up
        // the new colours without a rebuild.
        this.renderer.setPalette(this.palette);
        this.repaintSkyDome();
    }

    /**
     * Rebakes the sky dome's vertex colours for the current sun and palette.
     *
     * Only when one of the two actually changes: the atmosphere is CPU code and
     * the time of day is a setting here, not a running clock, so a few hundred
     * vertices at that rate costs nothing. Both a new time of day and a new
     * tech profile land here, since either changes what the dome should hold.
     */
    private repaintSkyDome() {
        if (this.skyDome) {
            paintSkyDome(this.skyDome, this.noonPalette, this.midnightPalette,
                SUN_STATE.nightMix, SUN_DIRECTION);
        }
        // The bloom shares the dome's painter, so the two agree by construction
        // rather than by two sets of constants being kept in step by hand.
        if (this.sunModel) {
            paintSunBloom(this.sunModel, this.noonPalette, this.midnightPalette,
                SUN_STATE.nightMix, SUN_DIRECTION, this.palette);
        }
        // Dev aids, alongside __terrain. The sun is worth
        // reaching for because its two halves are drawn in different passes,
        // and the only way to see that from outside is to walk their parents.
        (globalThis as Record<string, unknown>).__probe =
            (at?: { x: number; z: number }) => this.groundProbe(at);
        (globalThis as Record<string, unknown>).__skyDome = this.skyDome;
        (globalThis as Record<string, unknown>).__shell = ATMOSPHERE_SHELL_UNIFORMS;
        (globalThis as Record<string, unknown>).__player = this.player;
        (globalThis as Record<string, unknown>).__carrierNudge = (dz: number) => { this.kuz?.position.addScaledVector(this.carrierBowDir, dz); };
        (globalThis as Record<string, unknown>).__terrainProbe = (x: number, z: number) => ({
            land: this.planetTerrain.isLandAtWorld(x, z), dem: this.planetTerrain.heightAtWorld(x, z),
            drawn: this.planetTerrain.drawnHeightAtWorld(x, z),
        });
        (globalThis as Record<string, unknown>).__carrier = () => ({
            position: this.kuz?.position.toArray(), speed: this.carrierSpeedMps,
            meshes: this.carrierMeshes.length,
            groundUnder: this.kuz ? this.groundHeightAt(this.kuz.position.x, this.kuz.position.z) : undefined,
            demAt: this.kuz ? this.planetTerrain.heightAtWorld(this.kuz.position.x, this.kuz.position.z) : undefined,
            drawnAt: this.kuz ? this.planetTerrain.drawnHeightAtWorld(this.kuz.position.x, this.kuz.position.z) : undefined,
            rebases: this.rebaseCount,
            quat: this.kuz?.quaternion.toArray(),
        });
        // Re-base now - under the aircraft, or onto a given origin - and how
        // many have happened.
        (globalThis as Record<string, unknown>).__rebaseNow = (lat?: number, lon?: number) => {
            const p = this.player.position;
            const under = worldToGeodetic(this.planetTerrain.basis, p.x, p.y, p.z);
            this.rebaseWorld(lat ?? under.lat, lon ?? under.lon);
        };
        (globalThis as Record<string, unknown>).__rebases = () => this.rebaseCount;
        (globalThis as Record<string, unknown>).__setSunHours = (hours: number) => {
            setSunTime(hours);
            this.refreshDaytimePalette();
            this.updateSunEntity();
        };
        (globalThis as Record<string, unknown>).__sunVisibility = () => SUN_VISIBILITY.value;
        (globalThis as Record<string, unknown>).__sunModel = this.sunModel;
        // Unpaved strips still in their stand-in tone: empty once every one
        // has been drawn over ground that is on screen.
        (globalThis as Record<string, unknown>).__groundStripsPending =
            () => this.pendingGroundStrips;
    }
}

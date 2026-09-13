import * as THREE from 'three';
import { AudioSystem } from '../audio/audioSystem';
import { ConfigService } from '../config/configService';
import { isOverlayKeyEvent } from '../input/overlayKeys';
import { daytimePalette } from '../config/palettes/daytimePalette';
import { Palette, PaletteCategory, PaletteColor } from '../config/palettes/palette';
import { SVGAMidnightPalette } from '../config/palettes/svga-midnight';
import { SVGANoonPalette } from '../config/palettes/svga-noon';
import { ShowcasePalette } from '../config/palettes/showcase';
import { HDMidnightPalette } from '../config/palettes/hd-midnight';
import { HDNoonPalette } from '../config/palettes/hd-noon';
import { VGAMidnightPalette } from '../config/palettes/vga-midnight';
import { VGANoonPalette } from '../config/palettes/vga-noon';
import { DisplayResolution, getDisplayResolutionSize } from '../config/profiles/profile';
import { loadSettings, SpawnMode, updateSettings } from '../config/settingsStorage';
import { KernelRenderTask, KernelUpdateTask } from '../core/kernel';
import { FlightRecorder } from '../physics/flightRecorder';
import { fm2GroundRestHeight } from '../physics/fm2/fm2AircraftConfig';
import { AIRBASE_RUNWAY as AIRBASE_RUNWAY_RAW, APPROACH_ALTITUDE_M, APPROACH_FINAL_DISTANCE_M, APPROACH_SPEED_MPS, COCKPIT_FAR, COCKPIT_FOV, HI_H_RES, HI_V_RES, HIGH_ALTITUDE_M, H_RES, isTelemetryGraphKey, LO_H_RES, LO_V_RES, PLANE_DISTANCE_TO_GROUND, RUNWAY_HALF_LENGTH_M, SPACE_ALTITUDE_M, V_RES } from '../defs';
import { DEFAULT_SUN_HOURS, setSunTime, SUN_DIRECTION, SUN_STATE } from '../scene/materials/shaders/sun';
import { placeSun, SUN_SET_ELEVATION_DEG } from '../scene/models/lib/sunModelBuilder';
import { paintSkyDome, SkyDome, skyDomeOf } from '../scene/models/lib/skyDomeModelBuilder';
import { paintSunBloom } from '../scene/models/lib/sunModelBuilder';
import { Model } from '../scene/models/models';
import { terrainMaxZoomForAltitudeM } from '../terrain/lod';
import { Renderer, RenderLayer, RenderTargetType } from "../render/renderer";
import { SceneCamera } from '../scene/cameras/camera';
import { DebrisField } from '../scene/entities/debrisField';
import { DamageSmokeField } from '../scene/entities/damageSmokeField';
import { GroundTargetEntity } from '../scene/entities/groundTarget';
import { ActivePlayArea, resolvePlayArea } from '../terrain/playArea';
import { Airfield, AirfieldBuilding, airfieldsInArea } from '../terrain/airfields';
import {
    SceneRunway, airfieldChoices, headingForward, pickStartRunway, sceneRunwaysOf,
} from './activeAirfield';
import {
    AIRFIELD_SURFACE_EPS_M, buildAirfieldModel, buildingHeightM,
} from '../scene/airfield/airfieldModel';
import { ecefToEnu, geodeticToEcef, sceneFromEnu } from '../terrain/geodesy';
import { openSettingsDialog } from '../ui/settings/settingsLauncher';
import { ArrestorCablesEntity } from '../scene/entities/arrestorCablesEntity';
import { ARRESTOR_CARRIER_ORIGIN, ArrestorCarrierPose } from '../scene/entities/arrestorCables';
import { ShipWakeEntity } from '../scene/entities/shipWake';
import {
    CockpitEntity, CockpitMFD1X, CockpitMFD1Y, CockpitMFD2X, CockpitMFD2Y, CockpitMFDSize,
} from '../scene/entities/overlay/cockpit';
import { ILS_GLIDESLOPE_TAN } from '../scene/entities/overlay/approachAids';
import { ExteriorDataEntity } from '../scene/entities/overlay/exteriorData';
import { HUDEntity } from '../scene/entities/overlay/hud';
import { PerfHudEntity } from '../scene/entities/overlay/perfHud';
import { TelemetryGraph } from '../scene/entities/overlay/telemetryGraph';
import { TelemetryGraphWindow } from '../scene/entities/overlay/telemetryGraphWindow';
import { PlayerEntity, PlayerSpawnState } from '../scene/entities/player';
import { AircraftCollisionMesh } from '../scene/entities/aircraftDef';
import {
    bakeCollisionMeshFromModel,
    createCarrierMeshCollider,
    sampleCarrierMeshSurfaceYMax,
    CarrierMeshCollider,
} from '../scene/entities/carrierDeck';
import {
    createSkiJumpCollider, sampleSkiJumpSurfaceYMax, SkiJumpCollider,
} from '../scene/entities/skiJump';
import { SurfacePadCollider, sampleSurfacePadYMax } from '../scene/entities/surfacePad';
import { SceneryField, SceneryFieldSettings } from '../scene/entities/sceneryField';
import { SimpleEntity } from '../scene/entities/simpleEntity';
import { StaticSceneryEntity } from '../scene/entities/staticScenery';
import { Entity } from '../scene/entity';
import { SceneMaterialManager } from "../scene/materials/materials";
import { ModelManager } from "../scene/models/models";
import { Scene, SceneLayers } from '../scene/scene';
import { updateTargetCamera } from '../scene/utils';
import { assertIsDefined } from '../utils/asserts';
import { clamp, FORWARD, RIGHT, UP, toDegrees } from '../utils/math';
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
import { restoreMainCameraParameters } from './stateUtils';
import {
    StaticModelView, buildStaticModelViews, forEachStaticAircraftSlot,
} from './staticModelViews';
import { SpawnMenuEntity } from '../scene/entities/overlay/spawnMenu';
import { setBootProgress } from '../osd/bootProgress';
import { SpawnPanel } from '../osd/spawnPanel';
import { AircraftRegistry, buildF22Def, groupAircraftByModel } from './aircraftRegistry';
import { FlyableAircraftDef } from '../scene/entities/aircraftDef';
import { flightConfigWithArrestorHook } from '../scene/entities/arrestorCables';
import { Obstacle, Runway } from '../ai/worldQuery';
import { AiFlightPhase, AiPilotOptions, AiSkillLevel, FORMATION_SLOT } from '../ai/aiPilot';
import { AiAircraftEntity } from '../scene/entities/aiAircraft';
import { WeaponsField } from '../scene/entities/weaponsField';
import { Faction } from '../weapons/combatant';
import { CombatSimClient } from '../physics/sim/combatSimClient';
import { SimProxyFlightModel } from '../physics/model/simProxyFlightModel';
import { serializeWorld, defaultArrestorCableField } from '../physics/sim/serializedWorld';
import { HeightFieldSender, MirrorFocus } from '../terrain/heightMirror';
import { SimAircraftDesc, SimAircraftSpawn, SimGunConfig } from '../physics/sim/simTypes';
import { PLAYER_SIM_ID, WINGMAN_SIM_ID, aiSimId } from '../physics/sim/simIds';
import { AiPilotModels } from './gameDefs';
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

/** How many AI opponents the combat sim spawns. */
/** Loose cloud deck: base altitude and per-puff undulation, well under HIGH_ALTITUDE_M. */
/** Scratch for {@link Game.updateSunEntity}. */
const SUN_FACING = new THREE.Quaternion();

const CLOUD_BASE_ALTITUDE_M = 1400;
const CLOUD_ALTITUDE_VARIATION_M = 500;
/** High-altitude cirrus streak layer, just under HIGH_ALTITUDE_M — a separate, higher band above the cumulus deck. */
const CIRRUS_BASE_ALTITUDE_M = 9200;
const CIRRUS_ALTITUDE_VARIATION_M = 400;

const AI_OPPONENT_COUNT = 1;
/** Seconds the AI flies straight before engaging. */
const AI_STRAIGHT_DURATION_SEC = 1;
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
/** Airspeed (m/s) the wingman is spawned with when holding overhead. */
const WINGMAN_HOLD_SPEED_MPS = 180;

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


const MAIN_RENDER_TARGET_LO = 'MAIN_RENDER_TARGET_LO';
const CANVAS_RENDER_TARGET_LO = 'CANVAS_RENDER_TARGET_LO';
const MAIN_RENDER_TARGET_HI = 'MAIN_RENDER_TARGET_HI';
const CANVAS_RENDER_TARGET_HI = 'CANVAS_RENDER_TARGET_HI';
const MAIN_RENDER_TARGET_HD = 'MAIN_RENDER_TARGET_HD';
const CANVAS_RENDER_TARGET_HD = 'CANVAS_RENDER_TARGET_HD';
const WEAPONSTARGET_RENDER_TARGET_LO = 'WEAPONSTARGET_RENDER_TARGET_LO';
const WEAPONSTARGET_RENDER_TARGET_HI = 'WEAPONSTARGET_RENDER_TARGET_HI';
const WEAPONSTARGET_RENDER_TARGET_HD = 'WEAPONSTARGET_RENDER_TARGET_HD';

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
const RUNWAY_STRIP_HALF_LENGTH = RUNWAY_HALF_LENGTH_M + 150;
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
/** Edge softening on a building's roof pad. A wall is a step, not a ramp. */
const BUILDING_PAD_FEATHER_M = 0.5;
/** Hangar-ground pavement half extent: lib:pavement unit square × scale 200. */
const HANGAR_GROUND_HALF_M = 100;
/** Kuznetsov carrier origin — open water (matches {@link ARRESTOR_CARRIER_ORIGIN}). */
const KUZ_POSITION = new THREE.Vector3(
    ARRESTOR_CARRIER_ORIGIN.x,
    ARRESTOR_CARRIER_ORIGIN.y,
    ARRESTOR_CARRIER_ORIGIN.z,
);
const KUZ_IDENTITY_QUAT = new THREE.Quaternion();
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
const CARRIER_APPROACH_FINAL_DISTANCE_M = 2500;
/** Carrier final altitude (m); ~3° glide to the deck over {@link CARRIER_APPROACH_FINAL_DISTANCE_M}. */
const CARRIER_APPROACH_ALTITUDE_M = CARRIER_DECK_Y + 130;
const PLAYER_STARTING_HEADING = 0;
/** Land approach final distance — keep the airport in view at spawn. */
const LAND_APPROACH_FINAL_M = 3500;
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
const PLAYER_LAND_POSITION = new THREE.Vector3(
    AIRBASE_RUNWAY.x,
    PLANE_DISTANCE_TO_GROUND,
    AIRBASE_RUNWAY.z - RUNWAY_HALF_LENGTH_M + RUNWAY_SPAWN_INSET_M,
);
const PLAYER_LAND_HEADING = PLAYER_STARTING_HEADING;
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

/** Kuznetsov cruise speed (45 km/h → m/s), bow heading world −Z at identity. */
const CARRIER_SPEED_KMH = 45;
const CARRIER_SPEED_MPS = CARRIER_SPEED_KMH / 3.6;

/** Carrier landing: final toward the ski-jump bow along -Z. */
const PLAYER_CARRIER_HEADING = Math.PI;

/**
 * Barricade spawn: in the groove, {@link CARRIER_GROOVE_DISTANCE_M} astern of
 * the ramp, hook stowed and the net already across the deck. Under two seconds
 * of flying, which is the whole point — a hook-failure arrival, with none of
 * the 2.5 km pattern in front of it.
 */
const CARRIER_GROOVE_DISTANCE_M = 50;
/**
 * On-speed, not the 400 km/h the other airborne spawns transit at: from here
 * there is no room to slow down, and the flight model wrecks any touchdown
 * above its landing envelope (90 m/s / 324 km/h — see
 * `F16_PROFILE.landingMaxSpeedMps`).
 */
const CARRIER_GROOVE_SPEED_KMH = 250;
const CARRIER_GROOVE_SPEED_MPS = CARRIER_GROOVE_SPEED_KMH / 3.6;
/**
 * Aimed at the webbing rather than at the wires the ball is rigged for: with
 * the hook up the wires are scenery, and the flatter path clears the ramp by
 * ~5 m instead of the ~1 m that put the gear through the rounddown.
 */
const CARRIER_GROOVE_AIM_FROM_STERN_M = 0;  // barricade removed
/** ~3° glideslope, the same one the ILS needles and the ball are drawn from. */
const CARRIER_GROOVE_ALTITUDE_M = CARRIER_DECK_Y
    + (CARRIER_GROOVE_DISTANCE_M + CARRIER_GROOVE_AIM_FROM_STERN_M) * ILS_GLIDESLOPE_TAN;

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
}

enum GameState {
    SPAWN_MENU,
    PLAYER,
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
    private readonly surfacePads: SurfacePadCollider[] = [];
    /** Every runway of this play area, longest first. Empty on an old pyramid. */
    private sceneRunways: SceneRunway[] = [];
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
        entity !== this.cloudField && entity !== this.cirrusField;
    /** F9-toggled live FPS / draw-call / terrain-LOD readout. */
    private perfHud: PerfHudEntity | undefined;

    /** Baked area this session flies in; decides the ENU origin and the scenery. */
    private playArea!: ActivePlayArea;
    /** Edge-detect for {@link captureCrashProbe}. */
    private wasCrashed = false;
    private wasLanded = true;

    /** Live Kuznetsov entity; cables / trap physics / ILS follow its pose. */
    private kuz: GroundTargetEntity | undefined;
    private readonly syncedCarrierPos = new THREE.Vector3(Number.NaN, Number.NaN, Number.NaN);
    private readonly syncedCarrierQuat = new THREE.Quaternion(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
    /** World bow direction and velocity for the steaming carrier. */
    private readonly carrierBowDir = new THREE.Vector3(0, 0, -1);
    private readonly carrierVelocity = new THREE.Vector3();
    private readonly obstacles: Obstacle[] = [];
    private weaponsField: WeaponsField | undefined;
    private debrisField: DebrisField | undefined;
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
    private noonPalette: Palette = VGANoonPalette;
    private midnightPalette: Palette = VGAMidnightPalette;
    /** The two blended for the current time of day; see {@link daytimePalette}. */
    private palette: Palette = VGANoonPalette;

    private cockpitRenderLayersLo: RenderLayer[];
    private cockpitTargetRenderLayersLo: RenderLayer[];
    private exteriorRenderLayersLo: RenderLayer[];
    private showcaseRenderLayersLo: RenderLayer[];
    private cockpitRenderLayersHi: RenderLayer[];
    private cockpitTargetRenderLayersHi: RenderLayer[];
    private exteriorRenderLayersHi: RenderLayer[];
    private showcaseRenderLayersHi: RenderLayer[];
    private cockpitRenderLayersHd: RenderLayer[];
    private cockpitTargetRenderLayersHd: RenderLayer[];
    private exteriorRenderLayersHd: RenderLayer[];
    private showcaseRenderLayersHd: RenderLayer[];
    /** Weapons-target MFD is refreshed every Nth frame to cut dual-scene cost. */
    private targetMfdFrame = 0;

    private hdResolutionWidth = 0;
    private hdResolutionHeight = 0;

    private view: PlayerViewState = PlayerViewState.COCKPIT_FRONT;
    private viewBeforeShowcase: PlayerViewState | null = null;
    private staticModelIndex = 0;
    private staticModelCameraUpdater: StaticModelCameraUpdater;

    // Numpad orbit: how far the camera is currently orbited around the aircraft,
    // relative to the active view's default position (yaw about world UP, pitch
    // about the horizontal axis). Both zero leaves the active camera untouched.
    private viewYaw: number = 0;
    private viewPitch: number = 0;
    private viewZoom: number = 1;
    /** F2 exterior view: numpad * toggles the camera to track the AI opponent. */
    private exteriorEnemyLock = false;
    private cockpitPadlock = false;
    private aiChaseHeading = ExteriorViewHeading.BACK;
    private heldOrbitKeys = new Set<string>();
    private _orbitPivot = new THREE.Vector3();
    private _orbitOffset = new THREE.Vector3();
    private _orbitAxis = new THREE.Vector3();
    private _debugDebrisVel = new THREE.Vector3();
    private _debugDebrisPos = new THREE.Vector3();
    private _damageSmokeVel = new THREE.Vector3();

    private cockpitEntities: Entity[] = [];
    private readonly telemetryGraph = new TelemetryGraph();
    private readonly telemetryGraphWindow = new TelemetryGraphWindow();
    private readonly telemetryAccel = new THREE.Vector3();
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

    private flightRecorder = new FlightRecorder();

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
            () => void this.beginFlight('approach'),
            () => void this.beginFlight('runway'),
            () => void this.beginFlight('headon'),
            () => void this.beginFlight('carrier'),
            () => void this.beginFlight('carrierBarricade'),
            () => void this.beginFlight('carrierTakeoff'),
            () => void this.beginFlight('highAlt'),
            () => void this.beginFlight('space'),
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
        this.cameraUpdater = this.getCameraUpdater(this.view);
        this.configService.techProfiles.addChangeListener(profile => {
            if (profile.resolution === DisplayResolution.HD_RES) {
                this.updateHdResolution();
                this.renderer.setUpscaleFilter(true);
            } else {
                this.setStandardCameraAspect();
                const [width, height] = getDisplayResolutionSize(profile.resolution);
                this.renderer.setComposeSize(width, height);
                this.renderer.setUpscaleFilter(false);
                this.hdResolutionWidth = 0;
                this.hdResolutionHeight = 0;
            }
            this.noonPalette = profile.noonPalette;
            this.midnightPalette = profile.midnightPalette;
            this.materials.setFog(profile.fogQuality);
            this.materials.setShadingType(profile.shading);
            this.refreshDaytimePalette();
            this.renderer.setTextEffect(profile.textEffect);
        });
        this.configService.daytime.addChangeListener(hours => {
            // Moves the sun for the shaded ramp and the shadow prisms, then
            // rebuilds the sky/terrain palette that goes with it.
            setSunTime(hours);
            this.refreshDaytimePalette();
            this.updateSunEntity();
        });
        this.configService.shadowQuality.addChangeListener(quality => {
            this.renderer.setShadowQuality(quality);
        });
        this.configService.flightModels.addChangeListener(flightModel => {
            flightModel.activate();
            this.player.setFlightModel(flightModel);
            flightModel.setAircraft(flightConfigWithArrestorHook(this.currentDef));
            // FM2/DEBUG are simulated in the combat worker; JSBSim runs in its own
            // worker, so the sim-owned player aircraft is disabled and its state is
            // injected as an external combatant (see update) for AI targeting.
            const simOwned = flightModel instanceof SimProxyFlightModel;
            this.combatSim.setEnabled(PLAYER_SIM_ID, simOwned);
            if (simOwned) {
                this.combatSim.clearExternalState(PLAYER_SIM_ID);
            }
        })

        const playerLayersLo: RenderLayer[] = [
            {
                target: MAIN_RENDER_TARGET_LO,
                camera: this.playerCamera.bgSky,
                lists: [SceneLayers.BackgroundSky]
            },
            {
                target: MAIN_RENDER_TARGET_LO,
                camera: this.playerCamera.bgGround,
                lists: [SceneLayers.BackgroundGround]
            },
            {
                target: MAIN_RENDER_TARGET_LO,
                camera: this.playerCamera.main,
                lists: [SceneLayers.Terrain, SceneLayers.EntityFlats, SceneLayers.EntityVolumes, SceneLayers.EntityFX],
                shadows: true
            },
            {
                target: MAIN_RENDER_TARGET_LO,
                camera: this.playerCamera.bgSky,
                lists: [SceneLayers.ForegroundSky],
                // The glare veils the scene rather than replacing it, so it needs
                // the depth the main pass just wrote - read back through that
                // camera's far plane, not the background one's.
                sceneDepthFrom: this.playerCamera.main
            }
        ];
        const playerLayersHi: RenderLayer[] = [
            {
                target: MAIN_RENDER_TARGET_HI,
                camera: this.playerCamera.bgSky,
                lists: [SceneLayers.BackgroundSky]
            },
            {
                target: MAIN_RENDER_TARGET_HI,
                camera: this.playerCamera.bgGround,
                lists: [SceneLayers.BackgroundGround]
            },
            {
                target: MAIN_RENDER_TARGET_HI,
                camera: this.playerCamera.main,
                lists: [SceneLayers.Terrain, SceneLayers.EntityFlats, SceneLayers.EntityVolumes, SceneLayers.EntityFX],
                shadows: true
            },
            {
                target: MAIN_RENDER_TARGET_HI,
                camera: this.playerCamera.bgSky,
                lists: [SceneLayers.ForegroundSky],
                // The glare veils the scene rather than replacing it, so it needs
                // the depth the main pass just wrote - read back through that
                // camera's far plane, not the background one's.
                sceneDepthFrom: this.playerCamera.main
            }
        ];
        const targetLayersLo: RenderLayer[] = [
            {
                target: WEAPONSTARGET_RENDER_TARGET_LO,
                camera: this.targetCamera.bgSky,
                lists: [SceneLayers.BackgroundSky]
            },
            {
                target: WEAPONSTARGET_RENDER_TARGET_LO,
                camera: this.targetCamera.bgGround,
                lists: [SceneLayers.BackgroundGround]
            },
            {
                target: WEAPONSTARGET_RENDER_TARGET_LO,
                camera: this.targetCamera.main,
                lists: [SceneLayers.Terrain, SceneLayers.EntityFlats, SceneLayers.EntityVolumes, SceneLayers.EntityFX],
                entityFilter: this.excludeSkyFieldsFilter
            },
            {
                target: WEAPONSTARGET_RENDER_TARGET_LO,
                camera: this.targetCamera.bgSky,
                lists: [SceneLayers.ForegroundSky],
                // The glare veils the scene rather than replacing it, so it needs
                // the depth the main pass just wrote - read back through that
                // camera's far plane, not the background one's.
                sceneDepthFrom: this.targetCamera.main
            }
        ];
        const targetLayersHi: RenderLayer[] = [
            {
                target: WEAPONSTARGET_RENDER_TARGET_HI,
                camera: this.targetCamera.bgSky,
                lists: [SceneLayers.BackgroundSky]
            },
            {
                target: WEAPONSTARGET_RENDER_TARGET_HI,
                camera: this.targetCamera.bgGround,
                lists: [SceneLayers.BackgroundGround]
            },
            {
                target: WEAPONSTARGET_RENDER_TARGET_HI,
                camera: this.targetCamera.main,
                lists: [SceneLayers.Terrain, SceneLayers.EntityFlats, SceneLayers.EntityVolumes, SceneLayers.EntityFX],
                entityFilter: this.excludeSkyFieldsFilter
            },
            {
                target: WEAPONSTARGET_RENDER_TARGET_HI,
                camera: this.targetCamera.bgSky,
                lists: [SceneLayers.ForegroundSky],
                // The glare veils the scene rather than replacing it, so it needs
                // the depth the main pass just wrote - read back through that
                // camera's far plane, not the background one's.
                sceneDepthFrom: this.targetCamera.main
            }
        ];
        const canvasLayersLo: RenderLayer[] = [
            {
                target: CANVAS_RENDER_TARGET_LO,
                camera: this.playerCamera.main,
                lists: [SceneLayers.Overlay]
            }
        ];
        const canvasLayersHi: RenderLayer[] = [
            {
                target: CANVAS_RENDER_TARGET_HI,
                camera: this.playerCamera.main,
                lists: [SceneLayers.Overlay]
            }
        ];
        this.cockpitRenderLayersLo = [...playerLayersLo, ...canvasLayersLo];
        this.cockpitTargetRenderLayersLo = [...playerLayersLo, ...targetLayersLo, ...canvasLayersLo];
        this.exteriorRenderLayersLo = [...playerLayersLo, ...canvasLayersLo];
        const showcaseLayersLo: RenderLayer[] = [
            {
                target: MAIN_RENDER_TARGET_LO,
                camera: this.playerCamera.main,
                lists: [SceneLayers.EntityFlats, SceneLayers.EntityVolumes, SceneLayers.EntityFX],
                palette: ShowcasePalette,
            }
        ];
        this.showcaseRenderLayersLo = showcaseLayersLo;
        this.cockpitRenderLayersHi = [...playerLayersHi, ...canvasLayersHi];
        this.cockpitTargetRenderLayersHi = [...playerLayersHi, ...targetLayersHi, ...canvasLayersHi];
        this.exteriorRenderLayersHi = [...playerLayersHi, ...canvasLayersHi];
        const showcaseLayersHi: RenderLayer[] = [
            {
                target: MAIN_RENDER_TARGET_HI,
                camera: this.playerCamera.main,
                lists: [SceneLayers.EntityFlats, SceneLayers.EntityVolumes, SceneLayers.EntityFX],
                palette: ShowcasePalette,
            }
        ];
        this.showcaseRenderLayersHi = showcaseLayersHi;

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
                lists: [SceneLayers.Terrain, SceneLayers.EntityFlats, SceneLayers.EntityVolumes, SceneLayers.EntityFX],
                shadows: true
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
        const textColors = this.getTextColors();

        this.renderer.createRenderTarget(MAIN_RENDER_TARGET_LO, RenderTargetType.WEBGL, 0, 0, LO_H_RES, LO_V_RES);
        this.renderer.createRenderTarget(CANVAS_RENDER_TARGET_LO, RenderTargetType.CANVAS, 0, 0, LO_H_RES, LO_V_RES, { textColors });
        this.renderer.createRenderTarget(MAIN_RENDER_TARGET_HI, RenderTargetType.WEBGL, 0, 0, HI_H_RES, HI_V_RES);
        this.renderer.createRenderTarget(CANVAS_RENDER_TARGET_HI, RenderTargetType.CANVAS, 0, 0, HI_H_RES, HI_V_RES, { textColors });
        const LO_MFD_SIZE = CockpitMFDSize(LO_V_RES, LO_H_RES);
        this.renderer.createRenderTarget(WEAPONSTARGET_RENDER_TARGET_LO, RenderTargetType.WEBGL, CockpitMFD2X(LO_H_RES, LO_V_RES, LO_MFD_SIZE), CockpitMFD2Y(LO_H_RES, LO_V_RES, LO_MFD_SIZE), LO_MFD_SIZE, LO_MFD_SIZE);
        const HI_MFD_SIZE = CockpitMFDSize(HI_V_RES, HI_H_RES);
        this.renderer.createRenderTarget(WEAPONSTARGET_RENDER_TARGET_HI, RenderTargetType.WEBGL, CockpitMFD2X(HI_H_RES, HI_V_RES, HI_MFD_SIZE), CockpitMFD2Y(HI_H_RES, HI_V_RES, HI_MFD_SIZE), HI_MFD_SIZE, HI_MFD_SIZE);
        this.renderer.setPalette(this.getPalette());
        this.materials.setPalette(this.getPalette());
        this.setupControls();
        setBootProgress(15, 'Loading aircraft packs...');
        await this.loadPersistedPacks();
        const settings = loadSettings();
        setBootProgress(25, 'Building scene...');
        await this.setupScene(settings.spawnMode);
        this.selectAircraftById(settings.aircraftId, 'f22');
        setBootProgress(90, 'Loading aircraft...');
        await this.beginFlight(settings.spawnMode);
        await this.waitForRequiredTerrain(90, 99);
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

    /**
     * Triangle soup of the aircraft as it is *drawn*, for the barricade webbing
     * to lie on.
     *
     * The hitbox the sim already has is a separate, much coarser model — right
     * for bullets and crashes, and wrong for this: webbing solved against it and
     * drawn against the real airframe reads as threaded through the wings. Baked
     * once per airframe and cached, since it is only the gross shape and does not
     * move with the control surfaces.
     */
    /** Hand the sim both the hitbox and the drawn shape for a given airframe. */
    private pushAircraftMeshes(simId: string, def: FlyableAircraftDef): void {
        this.combatSim.setCollision(simId, def.collisionMesh);
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
     * each — so runway and approach starts work anywhere. The carrier does not
     * travel: it needs the open water east of Gran Canaria, so its two spawns
     * fall back to the runway rather than dropping the player at a ship that
     * is not there.
     */
    private spawnForArea(spawn: SpawnMode): SpawnMode {
        if (this.playArea === undefined || this.playArea.isHome) {
            return spawn;
        }
        return spawn === 'carrier' || spawn === 'carrierBarricade' || spawn === 'carrierTakeoff'
            ? 'runway' : spawn;
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
        const p = this.onRunwayAxis(this.spawnFrame.halfLength - RUNWAY_SPAWN_INSET_M);
        return new THREE.Vector3(p.x, this.groundHeightAt(p.x, p.z) + gearY, p.z);
    }

    /** Short final toward the runway, AGL above DEM. */
    private landApproachSpawnPosition(): THREE.Vector3 {
        const p = this.onRunwayAxis(LAND_APPROACH_FINAL_M);
        return new THREE.Vector3(
            p.x, this.groundHeightAt(p.x, p.z) + APPROACH_ALTITUDE_M, p.z);
    }

    /** Overhead the airbase at high altitude (10 km AGL). */
    private highAltSpawnPosition(): THREE.Vector3 {
        const f = this.spawnFrame;
        return new THREE.Vector3(
            f.centerX, this.groundHeightAt(f.centerX, f.centerZ) + HIGH_ALTITUDE_M, f.centerZ);
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
            sampleSurfacePadYMax(x, z, this.surfacePads),
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
     */
    private drawnGroundHeightAt(x: number, z: number): number {
        const drawnY = this.planetTerrain.drawnHeightAtWorld(x, z);
        return Math.max(
            drawnY ?? this.planetTerrain.heightAtWorld(x, z),
            sampleSkiJumpSurfaceYMax(x, z, this.skiJumps),
            sampleSurfacePadYMax(x, z, this.surfacePads),
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
            sampleSurfacePadYMax(x, z, this.surfacePads),
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
        const pad = sampleSurfacePadYMax(x, z, this.surfacePads);
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
            CARRIER_APPROACH_ALTITUDE_M,
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
     * Short final: on speed and already on the glidepath.
     *
     * The 2.5 km spawn starts level and fast and lets the pilot fly the ball
     * down. From a second out there is no time for that, so this one arrives
     * trimmed the way the arrival ends — approach speed, and a velocity
     * carrying the sink that holds 3° relative to the deck. Sink is scaled by
     * the closure on the ship, not by groundspeed: the glidepath is drawn on a
     * deck that is itself moving away.
     */
    private carrierBarricadeSpawn(): PlayerSpawnState {
        const speed = CARRIER_SPEED_MPS + CARRIER_GROOVE_SPEED_MPS;
        const velocity = FORWARD.clone()
            .applyAxisAngle(UP, PLAYER_CARRIER_HEADING)
            .multiplyScalar(speed);
        velocity.y = -CARRIER_GROOVE_SPEED_MPS * ILS_GLIDESLOPE_TAN;
        return { velocity, throttle: 0.3, airborne: true };
    }

    /** Approach airspeed in world frame (ship speed + relative groove speed). */
    private carrierApproachSpawn(): PlayerSpawnState {
        const speed = CARRIER_SPEED_MPS + APPROACH_SPEED_MPS;
        return {
            velocity: FORWARD.clone().applyAxisAngle(UP, PLAYER_CARRIER_HEADING).multiplyScalar(speed),
            throttle: 0.38,
            airborne: true,
        };
    }

    /** On-deck takeoff: world velocity matches ship cruise along the bow. */
    private carrierTakeoffSpawn(): PlayerSpawnState {
        return {
            velocity: FORWARD.clone().applyAxisAngle(UP, PLAYER_CARRIER_TAKEOFF_HEADING).multiplyScalar(CARRIER_SPEED_MPS),
            throttle: 0,
            airborne: false,
        };
    }

    private onViewportResize() {
        if (this.configService.techProfiles.getActive().resolution === DisplayResolution.HD_RES) {
            this.updateHdResolution();
        }
    }

    private updateHdResolution() {
        const [width, height] = this.renderer.getMaxViewportResolution();
        if (width === this.hdResolutionWidth && height === this.hdResolutionHeight) {
            return;
        }

        this.hdResolutionWidth = width;
        this.hdResolutionHeight = height;
        // Resolved from the *main* viewport, not each target's own size: the
        // MFD sub-target is a fraction of the screen, but it should still
        // taper with it rather than staying at full supersample cost just
        // because it individually looks small-resolution.
        const supersampleScale = hdSupersampleScale(width, height);

        if (!this.renderer.hasRenderTarget(MAIN_RENDER_TARGET_HD)) {
            const textColors = this.getTextColors();
            this.renderer.createRenderTarget(MAIN_RENDER_TARGET_HD, RenderTargetType.WEBGL, 0, 0, width, height, { textureScale: supersampleScale });
            this.renderer.createRenderTarget(CANVAS_RENDER_TARGET_HD, RenderTargetType.CANVAS, 0, 0, width, height, { textColors });
            const mfdSize = CockpitMFDSize(height, width);
            this.renderer.createRenderTarget(WEAPONSTARGET_RENDER_TARGET_HD, RenderTargetType.WEBGL, CockpitMFD2X(width, height, mfdSize), CockpitMFD2Y(width, height, mfdSize), mfdSize, mfdSize, { textureScale: supersampleScale });
        } else {
            this.renderer.resizeRenderTarget(MAIN_RENDER_TARGET_HD, 0, 0, width, height, supersampleScale);
            this.renderer.resizeRenderTarget(CANVAS_RENDER_TARGET_HD, 0, 0, width, height);
            const mfdSize = CockpitMFDSize(height, width);
            this.renderer.resizeRenderTarget(WEAPONSTARGET_RENDER_TARGET_HD, CockpitMFD2X(width, height, mfdSize), CockpitMFD2Y(width, height, mfdSize), mfdSize, mfdSize, supersampleScale);
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

    private setStandardCameraAspect() {
        const aspect = H_RES / V_RES;
        this.playerCamera.main.aspect = aspect;
        this.playerCamera.main.updateProjectionMatrix();
        this.targetCamera.main.aspect = 1;
        this.targetCamera.main.updateProjectionMatrix();
        this.playerCamera.update();
        this.targetCamera.update();
    }

    private getTextColors(): string[] {
        return Array.from(new Set(
            [VGANoonPalette, VGAMidnightPalette, SVGANoonPalette, SVGAMidnightPalette, HDNoonPalette, HDMidnightPalette]
                .flatMap(p => ([
                    PaletteColor(p, PaletteCategory.HUD_TEXT),
                    PaletteColor(p, PaletteCategory.HUD_TEXT_WARN),
                    PaletteColor(p, PaletteCategory.HUD_TEXT_SECONDARY),
                    PaletteColor(p, PaletteCategory.HUD_TEXT_EFFECT)
                ]))
        ));
    }

    update(delta: number) {
        if (this.state === GameState.PLAYER) {
            if ((this.view === PlayerViewState.TARGET_TO || this.view === PlayerViewState.TARGET_FROM) && !this.player.weaponsTarget) {
                this.setCockpitFrontView();
            }
            if (this.cockpitPadlock && (!this.player.weaponsTarget || this.view !== PlayerViewState.COCKPIT_FRONT)) {
                this.setCockpitPadlock(false);
            }
            this.updateOrbitFromKeys(delta);
            this.captureCrashProbe();
            this.recordTelemetry(delta);
            this.advanceCarrier(delta);
            this.syncCarrierSystems();
            this.scene.update(delta);
            this.pumpCombatSim(delta);
            this.updateAiStraightTimer(delta);

            if (this.flightRecorder.isRecording()) {
                this.flightRecorder.record(this.getShownAircraft().captureFlightSample(), delta);
            }

            if (this.player.isCrashed) {
                this.transitionFromPlayerToCrashed();
            }
        } else if (this.state === GameState.SPAWN_MENU) {
            this.advanceCarrier(delta);
            this.syncCarrierSystems();
            this.scene.update(delta);
            this.pumpCombatSim(delta);
        }
    }

    /** Steam the Kuznetsov at {@link CARRIER_SPEED_MPS} along its bow (−Z at identity). */
    private advanceCarrier(delta: number): void {
        if (!this.kuz) return;
        this.carrierBowDir.set(0, 0, -1).applyQuaternion(this.kuz.quaternion);
        this.carrierVelocity.copy(this.carrierBowDir).multiplyScalar(CARRIER_SPEED_MPS);
        this.kuz.position.addScaledVector(this.carrierVelocity, delta);
    }

    /**
     * Step the barricade's raise/lower animation, feeding it the sim's live
     * engagement flag so an arrestment expends the webbing.
     */
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

        const field = defaultArrestorCableField(p.x, p.y, p.z, q);
        this.combatSim.setArrestorCables([{
            originX: field.originX,
            originY: field.originY,
            originZ: field.originZ,
            deckAxis: [field.deckAxis.x, field.deckAxis.y, field.deckAxis.z],
            segmentsLocal: field.segments.map(s => [
                s.a.x - field.originX, s.a.y - field.originY, s.a.z - field.originZ,
                s.b.x - field.originX, s.b.y - field.originY, s.b.z - field.originZ,
            ] as [number, number, number, number, number, number]),
        }]);
        this.combatSim.setCarrierMeshOrigins(
            this.carrierMeshes.map(c => ({
                originX: c.originX, originY: c.originY, originZ: c.originZ,
            })),
        );
        this.combatSim.setCarrierVelocity(
            this.carrierVelocity.x, this.carrierVelocity.y, this.carrierVelocity.z,
        );
    }

    /**
     * Pump one frame into the combat sim worker after entities have latched their
     * inputs. When the player is flying the separate JSBSim worker (not sim-owned),
     * inject its live state so in-worker AI pilots can still target it.
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
        this.combatSim.setHeightField({
            basis: this.planetTerrain.basis,
            seaLevel: heights.seaLevel,
            queryZoom: heights.queryZoom,
            coarseZoom: heights.coarseZoom,
            pads: [...heights.flattenPads],
        });
        this.heightSender = new HeightFieldSender(
            heights, update => this.combatSim.postHeightTiles(update),
        );
        this.heightSender.sendCoarse();
        this.heightMirrorTimer = SIM_TERRAIN_MIRROR_INTERVAL_S;
        this.updateHeightFieldMirror(0);
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

        if (this.state === GameState.PLAYER || this.state === GameState.SPAWN_MENU) {
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
            // Aim the target-window camera before the MFD's 3D layer is drawn (and
            // before its orientation is copied to the background cameras), so a
            // moving target stays centred instead of lagging a frame and stuttering.
            if (this.player.weaponsTarget) {
                updateTargetCamera(this.player, this.playerCamera.main, this.targetCamera.main);
            }
            this.targetCamera.update();
            this.applySpaceSkyState();
        }
        const resolution = this.configService.techProfiles.getActive().resolution;
        if (resolution === DisplayResolution.HD_RES) {
            this.updateHdResolution();
        }
        const showcasePickWidth = resolution === DisplayResolution.LO_RES
            ? LO_H_RES
            : resolution === DisplayResolution.HI_RES
                ? HI_H_RES
                : this.hdResolutionWidth || H_RES;
        this.updateShowcasePicking(showcasePickWidth);

        let layers: RenderLayer[];
        if (this.view === PlayerViewState.SHOWCASE) {
            if (resolution === DisplayResolution.LO_RES) {
                layers = this.showcaseRenderLayersLo;
            } else if (resolution === DisplayResolution.HI_RES) {
                layers = this.showcaseRenderLayersHi;
            } else {
                layers = this.showcaseRenderLayersHd;
            }
        } else if (resolution === DisplayResolution.LO_RES) {
            layers = this.cockpitRenderLayersLo;
            if (this.view !== PlayerViewState.COCKPIT_FRONT) {
                layers = this.exteriorRenderLayersLo;
            } else if (this.player.weaponsTarget) {
                layers = this.cockpitTargetRenderLayersLo;
            }
        } else if (resolution === DisplayResolution.HI_RES) {
            layers = this.cockpitRenderLayersHi;
            if (this.view !== PlayerViewState.COCKPIT_FRONT) {
                layers = this.exteriorRenderLayersHi;
            } else if (this.player.weaponsTarget) {
                layers = this.cockpitTargetRenderLayersHi;
            }
        } else {
            layers = this.cockpitRenderLayersHd;
            if (this.view !== PlayerViewState.COCKPIT_FRONT) {
                layers = this.exteriorRenderLayersHd;
            } else if (this.player.weaponsTarget) {
                layers = this.cockpitTargetRenderLayersHd;
            }
        }

        if (this.player.weaponsTarget && this.view !== PlayerViewState.SHOWCASE) {
            const weaponsTargetId = resolution === DisplayResolution.LO_RES ? WEAPONSTARGET_RENDER_TARGET_LO
                : resolution === DisplayResolution.HI_RES ? WEAPONSTARGET_RENDER_TARGET_HI
                    : WEAPONSTARGET_RENDER_TARGET_HD;
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
        const far = cameraFarForAltitudeM(this.playerCamera.main.position.y);
        if (Math.abs(this.playerCamera.main.far - far) > 1) {
            this.playerCamera.main.far = far;
            this.playerCamera.main.updateProjectionMatrix();
        }
        if (Math.abs(this.targetCamera.main.far - far) > 1) {
            this.targetCamera.main.far = far;
            this.targetCamera.main.updateProjectionMatrix();
        }
    }

    /** Hide the flat sky billboard in space; restore it in atmosphere. */
    private applySpaceSkyState(): void {
        if (!this.skyEntity) {
            return;
        }
        const inSpace = this.playerCamera.main.position.y >= SPACE_SKY_ALTITUDE_M
            && this.view !== PlayerViewState.SHOWCASE;
        this.skyEntity.enabled = !inSpace;
        if (this.cloudField) {
            this.cloudField.enabled = !inSpace;
        }
        if (this.cirrusField) {
            this.cirrusField.enabled = !inSpace;
        }
    }

    /** Black clear behind terrain when above the atmosphere threshold. */
    private applySpaceClearColor(layers: RenderLayer[]): void {
        const inSpace = this.skyEntity !== undefined
            && !this.skyEntity.enabled
            && this.view !== PlayerViewState.SHOWCASE;
        const mainTargets = new Set([MAIN_RENDER_TARGET_LO, MAIN_RENDER_TARGET_HI, MAIN_RENDER_TARGET_HD]);
        for (let i = 0; i < layers.length; i++) {
            const layer = layers[i];
            if (inSpace && mainTargets.has(layer.target)) {
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

    private openTelemetryGraphWindow(): void {
        const borderColor = PaletteColor(this.getPalette(), PaletteCategory.HUD_TEXT_SECONDARY);
        this.telemetryGraphWindow.open(this.telemetryGraph, borderColor);
    }

    /** The aircraft currently on screen: the AI opponent in the F6 chase view, otherwise the player. */
    private getShownAircraft(): PlayerEntity | AiAircraftEntity {
        if (this.view === PlayerViewState.AI_CHASE && this.aiOpponent && this.aiOpponent.enabled) {
            return this.aiOpponent;
        }
        return this.player;
    }

    private recordTelemetry(delta: number): void {
        this.player.getAccelerationWorld(this.telemetryAccel);
        this.telemetryGraph.record(delta, {
            g: this.player.loadFactorG,
            aoaDeg: toDegrees(this.player.angleOfAttack),
            accelG: this.telemetryAccel.length() / 9.80665,
            stick: this.player.pitchStickUnitsValue,
            elevator: this.player.commandedElevator,
        });
    }

    private setupControls() {
        document.addEventListener('keydown', (event: KeyboardEvent) => {
            if (isOverlayKeyEvent(event)) {
                return;
            }
            if (isTelemetryGraphKey(event)) {
                event.preventDefault();
                this.openTelemetryGraphWindow();
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
            if (this.state === GameState.SPAWN_MENU) {
                return;
            }
            if (this.state !== GameState.PLAYER) {
                return;
            }
            if (event.code === 'Escape') {
                event.preventDefault();
                this.enterSpawnMenu();
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
                    // Terrain wireframe coloured by QT zoom (one hue per LOD).
                    // Aircraft wireframe + visibility filtering for LOD debugging.
                    setTerrainWireframe(!isTerrainWireframe());
                    setAircraftWireframe(!isAircraftWireframe());
                    setVisibleMeshesOnly(!isVisibleMeshesOnly());
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
                    event.preventDefault();
                    this.toggleShowcaseView();
                    break;
                }
            }

            if (event.code === 'KeyR') {
                event.preventDefault();
                this.flightRecorder.toggle(this.configService.flightModels.getActiveKey());
            } else if (event.code === 'KeyV') {
                event.preventDefault();
                this.player.setForceVectorsEnabled(!this.player.forceVectorsEnabled);
            } else if (event.code === 'Tab') {
                if (event.repeat) {
                    return;
                }
                event.preventDefault();
                this.debugEmitDebris();
            } else if (event.code === 'Numpad5') {
                event.preventDefault();
                this.resetOrbit();
            } else if (event.code === 'NumpadMultiply' && this.isF2ExteriorView()) {
                event.preventDefault();
                this.toggleExteriorEnemyLock();
            } else if (event.code === 'NumpadMultiply' && this.view === PlayerViewState.COCKPIT_FRONT) {
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
        });

        window.addEventListener('blur', () => {
            this.heldOrbitKeys.clear();
            this.clearShowcasePickingState();
        });

        document.addEventListener('mousemove', (event: MouseEvent) => {
            this.updateShowcasePointerFromEvent(event);
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
        // Entering cockpit always starts unlocked; toggle padlock with F1 / Numpad*.
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

    private setExteriorSideView() {
        restoreMainCameraParameters(this.playerCamera.main);
        if (this.view !== PlayerViewState.EXTERIOR_RIGHT) {
            this.setExteriorView(PlayerViewState.EXTERIOR_RIGHT);
        } else {
            this.setExteriorView(PlayerViewState.EXTERIOR_LEFT);
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

    private cycleStaticModelView() {
        if (this.view !== PlayerViewState.STATIC_MODEL) {
            this.staticModelIndex = 0;
        } else {
            this.staticModelIndex = (this.staticModelIndex + 1) % this.staticModelViews.length;
        }
        this.setStaticModelView(this.staticModelIndex);
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

    transitionFromPlayerToCrashed() {
        if (this.view === PlayerViewState.CRASHED) {
            return;
        }
        this.damageSmoke?.ensureCrashPlume(PLAYER_SIM_ID);
        this.leaveShowcaseIfActive();
        // Keep orbit state for carrier view so numpad still works after crash
        if (this.view !== PlayerViewState.CARRIER_OVER_STERN) {
            this.resetOrbit();
        }
        restoreMainCameraParameters(this.playerCamera.main);
        // Keep carrier view on crash; otherwise switch to crash camera
        if (this.view !== PlayerViewState.CARRIER_OVER_STERN) {
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

    private enterSpawnMenu() {
        this.state = GameState.SPAWN_MENU;
        this.flightRecorder.stop();
        this.player.setSimulationPaused(true);
        this.spawnMenu.afterCrash = false;
        this.spawnMenu.enabled = true;
        this.spawnPanel.setTitle('Retro Flight Sim');
        this.refreshAircraftMenu();
        this.spawnPanel.show();

        this.player.reset(this.runwaySpawnPosition(), this.baseHeading, PLAYER_LAND_SPAWN);
        this.damageSmoke?.reset();
        this.setCockpitFrontView();
    }

    /** Begin a flight using the aircraft + livery chosen in the spawn menu. */
    private async beginFlight(requested: SpawnMode) {
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
        this.player.setSimulationPaused(false);
        this.spawnMenu.enabled = false;
        this.spawnPanel.hide();
        this.damageSmoke?.reset();

        // Warm DEM/meshes *before* the plane is placed: the sim worker keeps
        // stepping through this await, and a spawn half a second from the ramp
        // would otherwise spend its whole groove waiting for tiles.
        const center = this.spawnCenterEnu(spawn);
        await this.preloadTerrainAroundPlane(center.x, center.z, spawn);

        if (spawn === 'runway') {
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
        if (spawn === 'carrierBarricade') {
            // A barricade arrival is a deck exercise, not a sortie: an opponent
            // spawned a few hundred metres ahead would be inside the ship.
            this.clearOtherAircraft();
            this.setCarrierOverSternView();
        } else {
            this.spawnOpponent(spawn === 'headon');
            this.spawnWingman();
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

        // The AI is handed every runway in the area, with the one this session
        // is based at first: `runway()` means "the main one" and a pilot picks
        // its own by proximity. On a pyramid with no airfields this is the
        // authored airbase, exactly as it always was.
        const runways: Runway[] = this.sceneRunways.length > 0
            ? [...this.sceneRunways]
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

        // Hand the static world (terrain hills, ski jump, carrier deck, obstacles, runway)
        // to the sim worker so its AI pilots can navigate; then register the player as a
        // sim-owned aircraft (its physics + gun + autopilot all live there).
        this.combatSim.setWorld(serializeWorld(
            [], this.obstacles, runways, this.skiJumps, this.carrierMeshes,
            (() => {
                const pose = this.carrierPose();
                return [defaultArrestorCableField(
                    pose.position.x, pose.position.y, pose.position.z, pose.quaternion,
                )];
            })(),
            this.surfacePads,
            this.sceneryMeshes,
        ));
        this.startHeightFieldMirror();
        this.combatSim.addAircraft({
            id: PLAYER_SIM_ID,
            faction: Faction.PLAYER,
            control: 'external',
            kinematic: false,
            aircraftConfig: flightConfigWithArrestorHook(this.currentDef),
            pilotOptions: { cruiseAltitude: 3000, cruiseSpeed: 220, hardDeck: 150 },
            hitRadius: PLAYER_HIT_RADIUS_M,
            maxHealth: 100,
            gun: PLAYER_GUN,
            collision: this.currentDef.collisionMesh,
            spawn: this.playerSimSpawn(),
            enabled: true,
        });
        // The drawn airframe, for the barricade webbing to lie on. Separate from
        // the hitbox above, which stays coarse for bullets and crashes.
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
        this.damageSmoke = new DamageSmokeField(this.materials);
        this.damageSmoke.setPoseProvider((targetId) => this.getDamageSmokePose(targetId));
        this.scene.add(this.damageSmoke);
        this.combatSim.onHits = (hits) => {
            const gunHits = hits.filter(h => h.source !== 'scrape');
            const scrapes = hits.filter(h => h.source === 'scrape');
            if (gunHits.length > 0) {
                this.debrisField?.spawnFromHits(gunHits);
                this.damageSmoke?.spawnFromHits(gunHits);
            }
            if (scrapes.length > 0) {
                this.damageSmoke?.spawnGroundScrapes(scrapes);
                this.debrisField?.spawnGroundScrapes(scrapes);
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
        const LATERAL_SPACING_M = 80;
        for (let i = 0; i < this.aiOpponents.length; i++) {
            const ai = this.aiOpponents[i];
            // Ahead at standoff; fan extras slightly aside.
            const lateral = this.aiOpponents.length === 1 ? 0 : (i - (this.aiOpponents.length - 1) / 2) * LATERAL_SPACING_M;
            const position = new THREE.Vector3(p.x, p.y, p.z)
                .addScaledVector(playerForward, standoff)
                .addScaledVector(right, lateral);

            // Rebuild pilot so OSD AI-model changes apply on this merge.
            this.combatSim.setPilotOptions(ai.simId, pilotOptions);
            ai.respawn({
                position,
                heading: aiHeading,
                airborne: !this.player.isLanded,
                throttle: this.player.throttleUnit,
                velocity,
            });
            // Fight the whole friendly side — the player *and* the wingman —
            // re-picking as the fight develops, rather than tunnelling on the
            // one aircraft handed over at spawn.
            this.combatSim.setTargetFaction(ai.simId, Faction.PLAYER);
            this.combatSim.setPhase(ai.simId, AiFlightPhase.ENGAGE);
        }
        this.aiStraightTimer = 0;

        // The player's in-worker autopilot flies home and lands (RTB); it also
        // knows about the primary opponent should combat logic be enabled for it later.
        this.combatSim.setTarget(PLAYER_SIM_ID, this.aiOpponents[0].simId);
        this.combatSim.setPhase(PLAYER_SIM_ID, AiFlightPhase.RTB);
    }

    /**
     * Put the wingman on the player's wing for this flight. It always spawns
     * airborne: with the player parked on a runway or deck there is no wing slot
     * to sit in, so it starts overhead at {@link WINGMAN_HOLD_ALTITUDE_AGL_M}
     * and its pilot holds there until the player is actually flying.
     */
    private spawnWingman(): void {
        const wingman = this.wingman;
        if (!wingman) {
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
        const manifest = await loadTerrainManifest();
        // Which baked area this session flies in, and therefore where the ENU
        // origin sits. Home keeps PLAY_ORIGIN exactly and gets the authored
        // scenery; anywhere else is terrain only, rebased onto its own centre
        // so vertices stay near the origin instead of a continent away from it.
        this.playArea = resolvePlayArea(
            manifest, PLAY_ORIGIN, loadSettings().terrainArea,
        );
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
            landuseReveal: this.configService.landuseReveal,
            triangleBudget: this.configService.triangleBudget,
            farTileTextures: this.configService.farTileTextures,
        });
        await this.planetTerrain.load(DEFAULT_TERRAIN_URL);
        this.planetTerrain.setLodCamera(this.playerCamera.main);
        this.scene.add(this.planetTerrain);
        const center = this.spawnCenterEnu(spawn);
        setBootProgress(45, 'Loading terrain tiles...');
        // The airbase flatten pad is baked into both the mesh and the height
        // field, so there is no pad to lock here any more — that DEM sample and
        // the re-mesh it forced were the slowest step in the old boot.
        await this.preloadTerrainAroundPlane(center.x, center.z, spawn);
        setBootProgress(50, 'Building terrain meshes...');
        // The airbase furniture goes around whichever runway this session is
        // based at, turned to its heading — see airbaseAt.
        // Airfields first: the runway this session is based at decides where
        // the spawns are, which way the ILS points, and where the hangars and
        // the ramp go — so it has to be chosen before any of that is placed.
        setBootProgress(60, 'Loading airfields...');
        this.surfacePads.length = 0;
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

        this.scene.add(this.player);

        this.setupCombat();

        const hud = new HUDEntity(this.player, this.configService);
        this.cockpitEntities.push(hud);
        this.scene.add(hud);

        const cockpit = new CockpitEntity(
            this.player, this.playerCamera.main, this.targetCamera.main,
        );
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
        const here = airfieldsInArea(file, this.playArea.area.name);
        this.sceneRunways = sceneRunwaysOf(
            here, this.planetTerrain.basis, AIRFIELD_SURFACE_EPS_M);
        this.homeRunway = pickStartRunway(this.sceneRunways);
        this.activeRunway = pickStartRunway(this.sceneRunways, this.preferredIcao);
        const homeField = this.homeRunway === undefined
            ? undefined
            : here.find(a => a.icao === this.homeRunway!.icao
                && a.name === this.homeRunway!.name);
        this.homeHasRealAprons = (homeField?.aprons.length ?? 0) > 0;
        if (here.length === 0) {
            return;
        }
        // The ground under the taxiways has to be readable before they can be
        // draped on it, and an airfield two hundred kilometres away has none of
        // its height tiles resident at boot. Pinned per airfield rather than
        // for the whole area: they can be a degree apart.
        for (const runway of this.sceneRunways) {
            if (runway.primary) {
                await this.planetTerrain.heights.ensureLoadedAroundWorld(
                    runway.center.x, -runway.center.z, AIRFIELD_GROUND_RADIUS_M);
            }
        }
        // Elevation of the real ground, which inside a runway's pad is the
        // airfield's own plane and outside it is whatever is there.
        const groundElevationAt = (e: number, n: number) =>
            this.planetTerrain.heights.geodeticHeightAtWorld(e, -n);

        for (const airfield of here) {
            const built = buildAirfieldModel(
                airfield, this.planetTerrain.basis, this.materials, groundElevationAt);
            if (built === undefined) {
                continue;
            }
            // A weapons target rather than plain scenery: an airfield is what
            // the ILS needles guide to, and picking one as a target is how the
            // player asks for them.
            const entity = new GroundTargetEntity(
                built.model, undefined, 'Airbase', airfield.icao || airfield.name);
            entity.position.copy(built.origin);
            const primary = this.sceneRunways.find(
                r => r.primary && r.icao === airfield.icao && r.name === airfield.name);
            if (primary !== undefined) {
                entity.approachRunway = {
                    center: primary.center.clone(),
                    heading: primary.heading,
                    halfLength: primary.halfLength,
                };
            }
            scene.add(entity);
        }
        for (const runway of this.sceneRunways) {
            this.addRunwayPad(runway);
        }
        this.osmBuildings = [];
        for (const airfield of here) {
            for (const b of airfield.buildings) {
                this.addBuildingCollider(b);
            }
        }
        const active = this.activeRunway;
        console.log(`airfields: ${here.length} in "${this.playArea.area.name}", `
            + `${this.sceneRunways.length} runways`
            + (active ? `; based at ${active.icao || active.name} ${active.ref}` : ''));
        // Dev aid, alongside __terrain: the pavement is laid on the same plane
        // the terrain under it was cut to, and the only way to see whether
        // those two agree is to read the numbers back.
        (globalThis as Record<string, unknown>).__airfields = here;
        (globalThis as Record<string, unknown>).__runways = this.sceneRunways;
        this.spawnPanel.setAirfields(
            airfieldChoices(this.sceneRunways),
            active ? (active.icao || active.name) : undefined);
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
    private addBuildingCollider(b: AirfieldBuilding): void {
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
            return;
        }
        const height = buildingHeightM(b);
        const ahead = at(halfDepth, 0);
        this.surfacePads.push({
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
        });
        this.osmBuildings.push({
            x: centre.x, z: centre.z,
            radius: Math.hypot(b.widthM, b.depthM) / 2,
            height,
        });
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

        // The carrier and its cables need open water ten kilometres east, which
        // is a fact about Gran Canaria and not about airbases. An imported area
        // gets the runway and the hangars; a ship parked on a mountainside it
        // does not.
        if (!this.playArea.isHome) {
            return;
        }

        // Kuznetsov carrier from data/kuz.blend (exported via tools/export_kuz.py).
        // Collision soup is baked from the same GLB used for rendering.
        await this.models.waitForModel('assets/kuz.glb');
        const kuzModel = models.getModel('assets/kuz.glb');
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

        const shipWake = new ShipWakeEntity(this.materials, () => this.carrierPose());
        scene.add(shipWake);

        // Carrier-style ski jump 90 m ahead of the runway spawn, rising toward +Z (takeoff).
        this.skiJumps.length = 0;
        const skiJumpAheadM = 90;
        const home = this.baseFrame;
        const skiJumpHeading = home.heading;
        const fwd = headingForward(skiJumpHeading);
        // Ninety metres past where an aircraft lines up on the home runway.
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

    private isLandAt(worldX: number, worldZ: number): boolean {
        return this.planetTerrain.isLandAtWorld(worldX, worldZ);
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
        // Dev aids, alongside __terrain / __shadowSettings. The sun is worth
        // reaching for because its two halves are drawn in different passes,
        // and the only way to see that from outside is to walk their parents.
        (globalThis as Record<string, unknown>).__probe =
            (at?: { x: number; z: number }) => this.groundProbe(at);
        (globalThis as Record<string, unknown>).__skyDome = this.skyDome;
        (globalThis as Record<string, unknown>).__sunModel = this.sunModel;
    }
}

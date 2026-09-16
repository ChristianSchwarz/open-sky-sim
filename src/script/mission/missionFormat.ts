/**
 * The mission document: what an authored mission *is*, on disk and in memory.
 *
 * Pure types and constants. No three.js, no DOM, no `fs` — this module is
 * imported by the browser and by tests, and it must stay importable from both.
 *
 * A mission is stored GEODETICALLY. Scene metres are anchored at
 * `resolvePlayArea(...).origin`, which moves when the play area changes, so a
 * scene-metre mission would silently relocate the day someone bakes a new area.
 * `missionResolve.ts` converts once, on the main thread, at launch.
 */

/**
 * Bumped only for a breaking shape change — a reader that sees an unknown
 * scheme must refuse the file rather than guess. `loadTerrainManifest` sets the
 * precedent with `retro-terrain/1`.
 */
export const MISSION_SCHEME = 'retro-mission/1';

/**
 * Additive revisions inside one scheme. `validateMission` ACCEPTS
 * `version <= MISSION_VERSION` and rejects anything higher with "needs a newer
 * build": a forward-compatible reader would silently drop the fields it cannot
 * see, and the editor would then write that loss straight back to disk on the
 * next save.
 */
export const MISSION_VERSION = 1;

/**
 * Hard ceiling on the aircraft a mission may put in the sim, split by faction
 * because it is a pool of pre-built entities, not an allocation.
 *
 * `encodeSnapshotInto` builds its id list from `this.order` with NO `enabled`
 * filter, and throws `aircraft count N exceeds shared bank` above
 * `SIM_SHARED_MAX_AIRCRAFT`. The throw lands inside the worker's step handler,
 * comes back as `{type:'error'}`, and the sim then stalls with `busy` cleared
 * and no state published — a frozen sim, not a visible exception. 'player',
 * 'wing0' and 'ai0' already hold three of those rows, so a mission gets 13.
 *
 * Enforced in three places on purpose: here in the validator, again in
 * `missionResolve`, and again at pool assignment. `missionFormat.test.ts`
 * asserts the arithmetic against the real `SIM_SHARED_MAX_AIRCRAFT` so that a
 * future entity added anywhere fails at the source instead of here.
 *
 * The bank, not the CPU, is what bounds this. Measured on a full bank of routed
 * AI aircraft, `CombatSim.step` costs 0.099 ms mean / 0.168 ms p95 at 16 against
 * 0.041 ms at 3 — roughly linear, and about 170x under the 20 ms the client
 * warns at; `encodeSnapshotInto` is another 0.02 ms. So raising the ceiling is a
 * question about the terrain mirror's tile budget and about `postMessage` on the
 * non-SharedArrayBuffer path, never about pilot or physics cost.
 *
 * `AiAircraftEntity.faction` is `readonly` and the sim protocol has no
 * `setFaction`, so a flight is assigned from the sub-pool that already matches
 * its faction. Exceeding either sub-pool is an ERROR, not a clamp: silently
 * dropping half a mission's opposition is worse than refusing to fly it.
 */
export const MISSION_MAX_ENEMY = 7;
export const MISSION_MAX_FRIENDLY = 6;
export const MISSION_MAX_AIRCRAFT = MISSION_MAX_ENEMY + MISSION_MAX_FRIENDLY;

/**
 * Sim ids reserved for the mission pool, one list per faction.
 *
 * Fixed strings rather than generated, because they are the wire identity of a
 * row that lives for the whole session, and because none of them may collide
 * with 'player', 'ai0' or 'wing0' — the three that exist outside any mission.
 */
export const MISSION_POOL_IDS = {
    enemy: ['me0', 'me1', 'me2', 'me3', 'me4', 'me5', 'me6'],
    player: ['mf0', 'mf1', 'mf2', 'mf3', 'mf4', 'mf5'],
} as const satisfies Record<MissionFaction, readonly string[]>;

/** Members in one flight. Beyond this the wing slots stop being distinguishable. */
export const MISSION_MAX_FLIGHT_SIZE = 8;

/** Line-abreast spacing (m) between members of one flight at spawn. */
export const MISSION_FLIGHT_SPACING_M = 120;

/**
 * Default horizontal capture radius (m).
 *
 * At 220 m/s and MAX_BANK_NAV (45 deg) the turn radius is roughly 5 km, so a
 * capture circle much tighter than this on a sharp corner is flown past, and
 * the aircraft then spirals trying to reacquire a fix it keeps overshooting.
 */
export const DEFAULT_CAPTURE_RADIUS_M = 2000;

/**
 * Leg-to-leg course change (deg) above which the editor warns.
 *
 * `commandHeading` latches a turn direction past TURN_LATCH_ENTER (150 deg) and
 * holds it until the error drops below TURN_LATCH_RELEASE (110 deg), so a
 * near-reversal is flown as a wide committed turn that will not take the
 * shorter side. Correct behaviour that reads as a bug — so warn at authoring
 * time rather than letting it be discovered in the air.
 */
export const MISSION_COURSE_WARN_DEG = 150;

export type MissionFaction = 'player' | 'enemy';
export type MissionLegAction = 'transit' | 'engage' | 'orbit' | 'land';
export type MissionSkill = 'ROOKIE' | 'VETERAN' | 'ACE';
export type MissionAiModel = 'CLASSIC' | 'SHAW' | 'AGGRESSIVE' | 'ACE';

export const MISSION_FACTIONS: readonly MissionFaction[] = ['player', 'enemy'];
export const MISSION_LEG_ACTIONS: readonly MissionLegAction[] =
    ['transit', 'engage', 'orbit', 'land'];
export const MISSION_SKILLS: readonly MissionSkill[] = ['ROOKIE', 'VETERAN', 'ACE'];
export const MISSION_AI_MODELS: readonly MissionAiModel[] =
    ['CLASSIC', 'SHAW', 'AGGRESSIVE', 'ACE'];

/**
 * A point on the planet. Degrees; `altitudeM` is metres above the WGS84
 * ellipsoid — the number the DEM itself stores and `geodeticHeightAtWorld`
 * returns, NOT scene Y (which is curvature-corrected) and NOT MSL. The shipped
 * manifest has `seaLevel: 0`, so ellipsoidal and MSL coincide today; they are
 * not the same datum and this field means the first one.
 *
 * When `agl` is true the author meant height above the ground under the fix,
 * and `missionResolve` adds the terrain elevation at launch — which is when
 * tiles are actually resident. Outside where the player has already flown, the
 * editor's own elevation is a 611 m-lattice guess, so AGL is the honest default
 * for a fix placed on open map.
 */
export interface MissionPoint {
    lat: number;
    lon: number;
    altitudeM: number;
    agl?: boolean;
}

export interface MissionDoc {
    scheme: typeof MISSION_SCHEME;
    version: number;
    /** Slug, non-empty; equals the filename stem, so the store needs no index. */
    id: string;
    name: string;
    /** `TerrainArea.name` from `manifest.areas[]` — never `manifest.coverage`. */
    area: string;
    description?: string;
    /**
     * ISO-8601 UTC, written by the server on save. The editor compares it
     * against the listing on reload to warn before overwriting a newer save.
     */
    savedUtc?: string;
    player: MissionPlayerStart;
    flights: MissionFlight[];
    routes: MissionRoute[];
}

export interface MissionPlayerStart {
    /**
     * Airfield key exactly as `airfieldChoices()` emits it: `icao || name`, and
     * resolved by `findRunwayByKey` — NOT by `pickStartRunway`, which only ever
     * compares `icao` and so cannot match the four shipped ICAO-less fields.
     */
    airfield?: string;
    /** Explicit start; when absent the runway named by `airfield` is used. */
    position?: MissionPoint;
    /** TRUE bearing in degrees. Absent → the runway's own bearing. */
    headingDeg?: number;
    airborne: boolean;
    speedMps?: number;
    /**
     * `FlyableAircraftDef.id`, applied via `selectAircraftById` BEFORE
     * `beginFlight` awaits `preloadAircraftModels`. Absent → whatever the spawn
     * menu already had selected.
     */
    aircraftType?: string;
}

export interface MissionFlight {
    /** Slug, unique in the doc. Mapped to a pooled sim id by `missionResolve`. */
    id: string;
    name?: string;
    /** Decides which sub-pool the flight draws from; cannot change at runtime. */
    faction: MissionFaction;
    /** `FlyableAircraftDef.id`. */
    aircraftType?: string;
    /**
     * Durable fallback for `aircraftType`. Pack ids gain `_2`/`_3` suffixes on
     * re-import and packs only exist under the dev server, but
     * `FlyableAircraftDef.canonicalName` survives both. Neither present → the
     * player's own airframe.
     */
    aircraftCanonicalName?: string;
    /**
     * 1..{@link MISSION_MAX_FLIGHT_SIZE}. Member 0 is the element lead and is
     * the only one given the route; the rest fly FORMATION off it, because the
     * wing-slot law in `doFormation` already solves intra-flight geometry —
     * giving every member the same route and the same capture radii converges
     * them onto one point. Members spawn line-abreast at
     * {@link MISSION_FLIGHT_SPACING_M} along the spawn heading's right vector;
     * without that offset they share one track and stack on top of each other.
     */
    count: number;
    start: MissionSpawn;
    /** `MissionRoute.id`. Absent → `AiFlightPhase.NAVIGATE`, the existing loiter. */
    routeId?: string;
    /**
     * Faction hunted on an `engage` leg, applied with `setTargetFaction`.
     * Absent → no auto-targeting at all. Per-flight rather than per-leg because
     * target scanning lives in `CombatSim`, not in the pilot.
     */
    engages?: MissionFaction;
    pilot?: MissionPilot;
}

export interface MissionSpawn {
    position: MissionPoint;
    /** TRUE bearing in degrees; converted to a scene heading on resolve. */
    headingDeg: number;
    airborne: boolean;
    /**
     * Scalar. `missionResolve` turns it into the velocity vector
     * `AiAircraftSpawn` wants by projecting it along the resolved SCENE heading
     * — the second and last place the bearing flip is applied — and derives a
     * throttle guess from it.
     */
    speedMps?: number;
    /**
     * Parked on the ground. `MissionRunner` sequences TAKEOFF_ROLL, because
     * GROUND_IDLE has no self-transition; the pilot then joins its route from
     * `doClimbOut` on its own.
     */
    onGround?: boolean;
}

/**
 * The subset of `AiPilotOptions` a mission may set. These are captured into
 * `private readonly` fields in the `AiPilot` constructor, so they apply at spawn
 * and cannot change in flight — which is exactly why per-leg altitude and speed
 * live on {@link MissionLeg} instead.
 */
export interface MissionPilot {
    skill?: MissionSkill;
    model?: MissionAiModel;
    cruiseAltitudeM?: number;
    cruiseSpeedMps?: number;
    hardDeckM?: number;
}

export interface MissionRoute {
    id: string;
    name?: string;
    /**
     * Restart at leg 0 on completion. When false the pilot drops to
     * `AiFlightPhase.NAVIGATE` and releases the route — without that branch a
     * finished flight orbits its last fix forever.
     */
    loop: boolean;
    legs: MissionLeg[];
}

export interface MissionLeg {
    id: string;
    at: MissionPoint;
    /** Absent → the flight's cruise speed. */
    speedMps?: number;
    /** Absent → {@link DEFAULT_CAPTURE_RADIUS_M}. Horizontal only. */
    captureRadiusM?: number;
    action: MissionLegAction;
    /**
     * `action: 'land'`: airfield key, as {@link MissionPlayerStart.airfield}. An
     * unresolvable key here is a validator ERROR, not a warning: "land somewhere
     * else" is a mission that flies and is silently wrong.
     */
    airfield?: string;
    /** `action: 'orbit'`: seconds held over the fix before advancing. */
    holdSeconds?: number;
    /** Author label drawn on the plan view. */
    label?: string;
}

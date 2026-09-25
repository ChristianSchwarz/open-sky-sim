/**
 * Play-area layout on Gran Canaria (coastal flat near GCLP).
 *
 * ENU origin is the airbase geodetic point so world Y ≈ MSL height and
 * curvature error stays tiny across the local scenery.
 */

/** WGS84 origin for planet ENU (airbase). */
export const PLAY_ORIGIN = {
    lat: 28.0015,
    lon: -15.3937,
    height: 0,
} as const;

/** Runway centre in local ENU metres. */
export const AIRBASE_RUNWAY = { x: 0, y: 0, z: 0 };

/**
 * Flatten DEM under the runway + hangar apron so large flats are not buried.
 * Half-extents and feather are metres in ENU.
 */
export const AIRBASE_FLATTEN_PAD = {
    centerX: AIRBASE_RUNWAY.x,
    centerZ: AIRBASE_RUNWAY.z,
    halfW: 500,
    halfD: 2000,
    featherM: 80,
} as const;

/** Lift thin pavement / runway meshes above the pad (needs headroom vs far-plane depth). */
export const SCENERY_SURFACE_EPS_M = 1.5;

/** Carrier ~10 km offshore (east/SE of GCLP coastal airbase). */
export const CARRIER_ORIGIN = { x: 10000, y: 0, z: -2000 };

/**
 * The airbase furniture, as offsets from the *runway*: `x` right of it, `z`
 * along it.
 *
 * Authored against a runway pointing due north, because for a long time there
 * was one airbase and that is where it pointed. They are applied through
 * `Game.airbaseAt`, which turns them to whatever the session's runway actually
 * does — a real one on 021 would otherwise get its apron laid across the
 * threshold.
 */
export const AIRBASE_LOCAL = {
    hangarGround1: { x: -140, z: -60 },
    hangarGround2: { x: 140, z: -60 },
    hangar1: { x: -170, z: 0 },
    hangar2: { x: -170, z: -60 },
    hangar3: { x: -170, z: -120 },
    hangar4: { x: 170, z: -10 },
    tower: { x: 80, z: 300 },
    rampX: 80,
    rampZ: [-40, -70, -100, -130],
} as const;

export const TARGET_LOCAL = {
    sam: { x: -1000, z: 400 },
    refinery: { x: -2700, z: 2300 },
    warehouse: { x: -5000, z: 2000 },
} as const;

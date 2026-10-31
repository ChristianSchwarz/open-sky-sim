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

/**
 * Where to put the carrier in an area that is not Gran Canaria.
 *
 * At home the ship has always sat ten kilometres off the east coast. Elsewhere
 * there may be no sea at all, so the search takes open water if it can find
 * any, and otherwise the flattest ground it can: a ship moored on a plain.
 * Ground that is level enough is also what a lake looks like to the DEM.
 *
 * Pure geometry over injected samplers, so the choice can be tested.
 */

/** The hull's extent in carrier-local metres (assets/kuz.glb). */
const HULL = { minX: -34.33, maxX: 43.83, minZ: -177.88, maxZ: 124.28 };
/** The deck's lateral centreline, which is where an aircraft is lined up. */
const DECK_MID_X = (HULL.minX + HULL.maxX) * 0.5;

/** How far beyond the bow the takeoff roll and climb-out are kept clear (m). */
const BOW_CLEAR_M = 1500;
/**
 * How far ahead of the bow open water is required before a berth counts as
 * sea: the ship steams along its heading, so a berth with a coast a few
 * kilometres ahead is a ship about to run aground (45 km/h is 13 minutes).
 */
const SEA_RUN_M = 9000;
/** How far astern the final approach is kept clear (m). */
const STERN_CLEAR_M = 3500;
/** Corridor sample spacing (m). */
const CORRIDOR_STEP_M = 250;
/** Land under the bow may rise this far above the deck before it counts against a site (m). */
const BOW_SLACK_M = 10;
/** The approach is a ~3 degree slope; terrain is allowed to climb at 2 degrees under it. */
const STERN_RISE_PER_M = 0.035;
/** Footprint samples across and along the hull. */
const FOOT_NX = 5;
const FOOT_NZ = 9;

/** Search rings, nearest first. Water is looked for further out than flat land. */
const WATER_MAX_RADIUS_M = 40000;
const LAND_MAX_RADIUS_M = 14000;
const RING_STEP_M = 1000;
const BEARINGS = 24;

export interface CarrierSiteSamplers {
    /** Scene Y of the surface at a scene point (sea level over water). */
    groundAt(x: number, z: number): number;
    /** True where the DEM says ground rather than sea. */
    isLand(x: number, z: number): boolean;
    /** False outside the area's data, or on something already built there. */
    usable(x: number, z: number): boolean;
}

export interface CarrierSite {
    /** Carrier origin on the scene's horizontal plane. */
    x: number;
    z: number;
    /**
     * Surface height the hull is to sit on: the sea, or the highest ground
     * under it. The ship rides this plane with its keel cut off there.
     */
    surfaceY: number;
    /** Open water: the ship may steam. Otherwise it is moored. */
    atSea: boolean;
}

/** Footprint sample points, carrier-local. */
function footprint(): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    for (let i = 0; i < FOOT_NX; i++) {
        for (let j = 0; j < FOOT_NZ; j++) {
            out.push({
                x: HULL.minX + (HULL.maxX - HULL.minX) * i / (FOOT_NX - 1),
                z: HULL.minZ + (HULL.maxZ - HULL.minZ) * j / (FOOT_NZ - 1),
            });
        }
    }
    return out;
}

const FOOTPRINT = footprint();

/** Corridor sample distances: bow side (negative local z) and stern side. */
const BOW_SAMPLES: number[] = [];
for (let d = CORRIDOR_STEP_M; d <= BOW_CLEAR_M; d += CORRIDOR_STEP_M) {
    BOW_SAMPLES.push(HULL.minZ - d);
}
const SEA_RUN_SAMPLES: number[] = [];
for (let d = 500; d <= SEA_RUN_M; d += 500) {
    SEA_RUN_SAMPLES.push(HULL.minZ - d);
}
const STERN_SAMPLES: number[] = [];
for (let d = CORRIDOR_STEP_M; d <= STERN_CLEAR_M; d += CORRIDOR_STEP_M) {
    STERN_SAMPLES.push(HULL.maxZ + d);
}

/** True when everything the ship and its approach cross is sea. */
function isOpenWater(x: number, z: number, s: CarrierSiteSamplers): boolean {
    for (const p of FOOTPRINT) {
        if (!s.usable(x + p.x, z + p.z) || s.isLand(x + p.x, z + p.z)) {
            return false;
        }
    }
    for (const lz of SEA_RUN_SAMPLES) {
        // Bow wide as well as the centreline: a headland off to one side clips the hull.
        for (const dx of [HULL.minX - 40, DECK_MID_X, HULL.maxX + 40]) {
            if (s.isLand(x + dx, z + lz)) {
                return false;
            }
        }
    }
    // Only the first kilometre astern has to be water; further out the
    // approach is high enough that a coast under it is no obstacle.
    for (const lz of STERN_SAMPLES) {
        if (lz - HULL.maxZ > 1000) {
            break;
        }
        if (s.isLand(x + DECK_MID_X, z + lz)) {
            return false;
        }
    }
    return true;
}

/**
 * Cost of mooring on land here, or Infinity if the footprint is unusable.
 * Relief under the hull dominates; terrain across the bow and up the
 * approach counts by how far it pokes above the line an aircraft flies.
 */
function landCost(x: number, z: number, s: CarrierSiteSamplers): { cost: number; surfaceY: number } {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of FOOTPRINT) {
        if (!s.usable(x + p.x, z + p.z)) {
            return { cost: Infinity, surfaceY: 0 };
        }
        const h = s.groundAt(x + p.x, z + p.z);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
    }
    let cost = (hi - lo) * 4;
    for (const lz of BOW_SAMPLES) {
        const h = s.groundAt(x + DECK_MID_X, z + lz);
        cost += Math.max(0, h - (hi + BOW_SLACK_M));
    }
    for (const lz of STERN_SAMPLES) {
        const h = s.groundAt(x + DECK_MID_X, z + lz);
        const allowed = hi + 10 + (lz - HULL.maxZ) * STERN_RISE_PER_M;
        cost += Math.max(0, h - allowed);
    }
    return { cost, surfaceY: hi };
}

/**
 * The carrier's berth near `centre` (scene metres): the nearest open water
 * within 40 km, else the best moored position within 14 km, else the
 * least-bad one. `minRadiusM` keeps it off the airbase itself.
 */
export function chooseCarrierSite(
    centre: { x: number; z: number },
    minRadiusM: number,
    s: CarrierSiteSamplers,
): CarrierSite {
    const at = (r: number, k: number, phase: number) => {
        const a = ((k + phase) / BEARINGS) * Math.PI * 2;
        return { x: centre.x + Math.cos(a) * r, z: centre.z + Math.sin(a) * r };
    };

    // Water: nearest ring first; on a ring prefer the bearing that faces east
    // (the original berth), by starting there and stepping outwards.
    const start = Math.max(minRadiusM, RING_STEP_M);
    for (let r = start; r <= WATER_MAX_RADIUS_M; r += RING_STEP_M) {
        for (let k = 0; k < BEARINGS; k++) {
            const p = at(r, k, 0);
            if (isOpenWater(p.x, p.z, s)) {
                // groundAt over water is the sea surface itself.
                let y = -Infinity;
                for (const f of FOOTPRINT) {
                    y = Math.max(y, s.groundAt(p.x + f.x, p.z + f.z));
                }
                return { x: p.x, z: p.z, surfaceY: y, atSea: true };
            }
        }
    }

    let best: { x: number; z: number; surfaceY: number; cost: number } | undefined;
    for (let r = start; r <= LAND_MAX_RADIUS_M; r += RING_STEP_M / 2) {
        for (let k = 0; k < BEARINGS; k++) {
            const p = at(r, k, 0.5);
            const c = landCost(p.x, p.z, s);
            // A hair of preference for nearer, so ties stay beside the airbase.
            const cost = c.cost + r / 2000;
            if (best === undefined || cost < best.cost) {
                best = { x: p.x, z: p.z, surfaceY: c.surfaceY, cost };
            }
        }
    }
    if (best !== undefined && Number.isFinite(best.cost)) {
        return { x: best.x, z: best.z, surfaceY: best.surfaceY, atSea: false };
    }
    // Nothing usable anywhere: park it beside the runway and let it sit.
    const p = at(start, 0, 0);
    return { x: p.x, z: p.z, surfaceY: s.groundAt(p.x, p.z), atSea: false };
}

/** Highest surface under the hull at a berth: what the ship is seated on once the DEM there is fine. */
export function carrierSurfaceY(x: number, z: number, groundAt: (x: number, z: number) => number): number {
    let y = -Infinity;
    for (const f of FOOTPRINT) {
        y = Math.max(y, groundAt(x + f.x, z + f.z));
    }
    return y;
}

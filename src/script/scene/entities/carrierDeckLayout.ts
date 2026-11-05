/**
 * The Kuznetsov's flight deck, laid out once for everything that stands on it:
 * the arrestor wires, the barricade, the paint, the lights and the Luna
 * landing sight, plus the approach geometry the HUD and the spawns fly.
 *
 * Carrier-local metres (kuz.glb): bow toward −Z, starboard +X, deck ≈ Y 13.5.
 *
 * Measured off the 1996 plan view of the ship (2.57 px/m over the 302 m hull):
 * the landing area is angled 7° to port from the ship's centreline, its axis
 * starting at the stern on that centreline and leaving the port deck edge
 * about 198 m forward. The mesh's port sponson follows the same line.
 *
 * Positions on the angled deck are given as a station (metres from the stern
 * along the axis) and an offset (metres to starboard of the axis, as seen by
 * a pilot landing on it).
 */
import * as THREE from 'three';

/** Ship centreline, carrier-local X (the keel's middle; not the hull AABB's). */
export const KUZ_CENTRELINE_X = 6.1;
/** Stern (aft-most hull point), carrier-local Z. */
export const KUZ_STERN_Z = 124.28;
/** Bow (ski-jump lip), carrier-local Z. */
export const KUZ_BOW_Z = -177.88;
/** Nominal deck height over the landing area, carrier-local Y. */
export const KUZ_DECK_Y = 13.55;

/** Angled deck: degrees to port of the ship's centreline. */
export const ANGLED_DECK_DEG = 7;
const A = (ANGLED_DECK_DEG * Math.PI) / 180;
const SIN = Math.sin(A);
const COS = Math.cos(A);

/** Unit landing direction along the angled deck (toward the bow and port). */
export const ANGLED_DECK_AXIS: Readonly<THREE.Vector3> = new THREE.Vector3(-SIN, 0, -COS);
/** Unit direction to starboard of the angled axis. */
export const ANGLED_DECK_RIGHT: Readonly<THREE.Vector3> = new THREE.Vector3(COS, 0, -SIN);
/** Yaw of the angled axis about +Y relative to the ship's bow (rad). */
export const ANGLED_DECK_YAW_RAD = A;

/** Half-width of the landing area between the red foul lines (m). */
export const LANDING_AREA_HALF_WIDTH_M = 13.5;
/** Where the axis leaves the port deck edge (station, m). */
export const ANGLED_DECK_END_STATION_M = 198;

/** Four arrestor wires, stern to bow (station, m): about 12 m apart. */
export const ARRESTOR_WIRE_STATIONS_M = [45.5, 57.6, 70.2, 81.5] as const;
/** Pilot's aim point for the hook: between wires 2 and 3 (station, m). */
export const HOOK_TOUCHDOWN_STATION_M = 64;

/** Carrier-local XZ of a point on the angled deck. */
export function angledDeckPoint(
    stationM: number,
    offsetM = 0,
    out: { x: number; z: number } = { x: 0, z: 0 },
): { x: number; z: number } {
    out.x = KUZ_CENTRELINE_X + ANGLED_DECK_AXIS.x * stationM + ANGLED_DECK_RIGHT.x * offsetM;
    out.z = KUZ_STERN_Z + ANGLED_DECK_AXIS.z * stationM + ANGLED_DECK_RIGHT.z * offsetM;
    return out;
}

/** Station and offset of a carrier-local XZ point (inverse of {@link angledDeckPoint}). */
export function angledDeckCoords(x: number, z: number): { station: number; offset: number } {
    const dx = x - KUZ_CENTRELINE_X;
    const dz = z - KUZ_STERN_Z;
    return {
        station: dx * ANGLED_DECK_AXIS.x + dz * ANGLED_DECK_AXIS.z,
        offset: dx * ANGLED_DECK_RIGHT.x + dz * ANGLED_DECK_RIGHT.z,
    };
}

/** Station on the ship's own centreline (m from the stern) to carrier-local Z. */
export function shipStationZ(stationM: number): number {
    return KUZ_STERN_Z - stationM;
}

/*
 * Ski-jump take-off positions (plan view, measured like the angled deck).
 * Positions 1 and 2 stand either side of the centreline about 110 m from the
 * lip; their yellow lanes close to ~2 m apart at the foot of the lip. Position
 * 3, on the port waist, has the long run: its lane joins position 1's.
 */
/** Carrier-local Z where the light lip band starts (the ramp's last 5 m). */
export const SKI_JUMP_LIP_Z = -172;
/** Carrier-local Z where the lanes end, just short of the lip band. */
export const SKI_JUMP_LANE_END_Z = -168;

export interface TakeoffPosition {
    readonly name: string;
    /** Where the aircraft holds (nose wheel), carrier-local XZ. */
    readonly start: { x: number; z: number };
    /** Lane polyline from the start to its end at the lip, carrier-local XZ. */
    readonly lane: readonly { x: number; z: number }[];
}

const P1 = { x: KUZ_CENTRELINE_X - 11.5, z: -64 };
const P2 = { x: KUZ_CENTRELINE_X + 13.5, z: -64 };
const P1_END = { x: KUZ_CENTRELINE_X - 1, z: SKI_JUMP_LANE_END_Z };
const P2_END = { x: KUZ_CENTRELINE_X + 1, z: SKI_JUMP_LANE_END_Z };
const P3 = { x: KUZ_CENTRELINE_X - 20, z: 27 };

export const TAKEOFF_POSITIONS: readonly TakeoffPosition[] = [
    { name: '1', start: P1, lane: [P1, P1_END] },
    { name: '2', start: P2, lane: [P2, P2_END] },
    { name: '3', start: P3, lane: [P3, P1, P1_END] },
];

/** Scene heading (rad, 0 faces +Z) along a carrier-local direction, the ship unturned. */
export function headingAlong(dx: number, dz: number): number {
    return Math.atan2(dx, dz);
}

/**
 * The angled deck as a runway for the AI pilot, carrier-local: from the stern
 * (station 0) to where the axis leaves the port edge, landed on toward the bow.
 */
export function angledDeckRunwayLocal(): { x: number; z: number; heading: number; halfLength: number; halfWidth: number } {
    const halfLength = ANGLED_DECK_END_STATION_M / 2;
    const c = angledDeckPoint(halfLength);
    return {
        x: c.x, z: c.z,
        heading: headingAlong(ANGLED_DECK_AXIS.x, ANGLED_DECK_AXIS.z),
        halfLength,
        halfWidth: LANDING_AREA_HALF_WIDTH_M,
    };
}

/**
 * The carrier's glide path (deg): steeper than a runway's 3°, as the
 * Kuznetsov's is flown, and what the jets here settle into on their own at
 * approach speed with gear and flaps out (~6 m/s of sink at 85 m/s). On a 3°
 * path they sat at the top of their lift curve and sagged 3-5 m low over the
 * stern. The AI, the HUD's needles and cue, the Luna and the spawns all fly it.
 */
export const CARRIER_GLIDESLOPE_DEG = 4;
export const CARRIER_GLIDESLOPE_TAN = Math.tan((CARRIER_GLIDESLOPE_DEG * Math.PI) / 180);

/** WGS84 ellipsoid constants and geodetic ↔ ECEF ↔ ENU transforms. */

import * as THREE from 'three';

export const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
export const WGS84_B = WGS84_A * (1 - WGS84_F);

export interface Geodetic {
    /** Degrees. */
    lat: number;
    /** Degrees. */
    lon: number;
    /** Metres above ellipsoid. */
    height: number;
}

export interface Ecef {
    x: number;
    y: number;
    z: number;
}

export interface Enu {
    /** East (m). */
    e: number;
    /** North (m). */
    n: number;
    /** Up (m). */
    u: number;
}

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export function degToRad(d: number): number {
    return d * DEG;
}

function radToDeg(r: number): number {
    return r * RAD;
}

/** Geodetic (degrees, metres) → ECEF metres. */
export function geodeticToEcef(
    latDeg: number,
    lonDeg: number,
    height: number,
    out: Ecef = { x: 0, y: 0, z: 0 },
): Ecef {
    const lat = degToRad(latDeg);
    const lon = degToRad(lonDeg);
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinLon = Math.sin(lon);
    const cosLon = Math.cos(lon);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    out.x = (N + height) * cosLat * cosLon;
    out.y = (N + height) * cosLat * sinLon;
    out.z = (N * (1 - WGS84_E2) + height) * sinLat;
    return out;
}

/** ECEF metres → geodetic (degrees, metres). Bowring closed form. */
export function ecefToGeodetic(
    x: number,
    y: number,
    z: number,
    out: Geodetic = { lat: 0, lon: 0, height: 0 },
): Geodetic {
    const lon = Math.atan2(y, x);
    const p = Math.hypot(x, y);
    const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    const lat = Math.atan2(
        z + WGS84_E2 * WGS84_B / (1 - WGS84_E2) * sinT * sinT * sinT,
        p - WGS84_E2 * WGS84_A * cosT * cosT * cosT,
    );
    const sinLat = Math.sin(lat);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    out.lat = radToDeg(lat);
    out.lon = radToDeg(lon);
    out.height = p / Math.cos(lat) - N;
    return out;
}

/** ENU basis at origin geodetic; columns are ECEF unit vectors for e, n, u. */
export interface EnuBasis {
    origin: Ecef;
    lat0: number;
    lon0: number;
    /** Row-major 3×3: ECEF delta → ENU. */
    ecefToEnu: Float64Array;
    /** Row-major 3×3: ENU → ECEF delta. */
    enuToEcef: Float64Array;
}

export function makeEnuBasis(lat0: number, lon0: number, height0: number = 0): EnuBasis {
    const origin = geodeticToEcef(lat0, lon0, height0);
    const lat = degToRad(lat0);
    const lon = degToRad(lon0);
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinLon = Math.sin(lon);
    const cosLon = Math.cos(lon);
    const ex = -sinLon, ey = cosLon, ez = 0;
    const nx = -sinLat * cosLon, ny = -sinLat * sinLon, nz = cosLat;
    const ux = cosLat * cosLon, uy = cosLat * sinLon, uz = sinLat;
    const ecefToEnuMat = new Float64Array([
        ex, ey, ez,
        nx, ny, nz,
        ux, uy, uz,
    ]);
    const enuToEcefMat = new Float64Array([
        ex, nx, ux,
        ey, ny, uy,
        ez, nz, uz,
    ]);
    return { origin, lat0, lon0, ecefToEnu: ecefToEnuMat, enuToEcef: enuToEcefMat };
}

/** An independent copy: the matrices are not shared. */
export function cloneEnuBasis(b: EnuBasis): EnuBasis {
    return {
        origin: { ...b.origin },
        lat0: b.lat0,
        lon0: b.lon0,
        ecefToEnu: b.ecefToEnu.slice(),
        enuToEcef: b.enuToEcef.slice(),
    };
}

export function ecefToEnu(basis: EnuBasis, ecef: Ecef, out: Enu = { e: 0, n: 0, u: 0 }): Enu {
    const dx = ecef.x - basis.origin.x;
    const dy = ecef.y - basis.origin.y;
    const dz = ecef.z - basis.origin.z;
    const m = basis.ecefToEnu;
    out.e = m[0] * dx + m[1] * dy + m[2] * dz;
    out.n = m[3] * dx + m[4] * dy + m[5] * dz;
    out.u = m[6] * dx + m[7] * dy + m[8] * dz;
    return out;
}

export function enuToEcef(basis: EnuBasis, enu: Enu, out: Ecef = { x: 0, y: 0, z: 0 }): Ecef {
    const m = basis.enuToEcef;
    out.x = basis.origin.x + m[0] * enu.e + m[1] * enu.n + m[2] * enu.u;
    out.y = basis.origin.y + m[3] * enu.e + m[4] * enu.n + m[5] * enu.u;
    out.z = basis.origin.z + m[6] * enu.e + m[7] * enu.n + m[8] * enu.u;
    return out;
}

/**
 * Approximate geodetic from local ENU on the tangent plane.
 * Height is recovered from the ECEF conversion, not from a DEM.
 */
export function enuToGeodeticApprox(basis: EnuBasis, e: number, n: number, u: number = 0): Geodetic {
    const ecef = enuToEcef(basis, { e, n, u });
    return ecefToGeodetic(ecef.x, ecef.y, ecef.z);
}

/** Below this the ground point under an ENU column is found. */
const SURFACE_SOLVE_TOL_M = 0.01;
const SURFACE_SOLVE_MAX_STEPS = 4;

/**
 * The geodetic point on the ground straight below (or above) an ENU `(e, n)`
 * - "straight" meaning along the play origin's up, which is scene Y.
 *
 * Reading `(e, n)` at u = 0 instead answers for a point on the origin's
 * tangent plane, which far out is hundreds of metres above the ground and,
 * because the vertical tilts with distance, not over the same spot: 65 km out
 * that is 3.5 m sideways, a hundred at the corner of a big area. The mesh is
 * placed through geodetic -> ECEF -> ENU, so this is the lat/lon whose drawn
 * vertex actually sits at `(e, n)`.
 *
 * `heightAt` is the ground's elevation above the ellipsoid; omit it for the
 * ellipsoid itself. A few fixed-point steps settle it, starting from the
 * spherical drop, which is already within centimetres of the ellipsoid.
 */
export function geodeticOnSurfaceAtEnu(
    basis: EnuBasis, e: number, n: number,
    heightAt?: (lat: number, lon: number) => number,
    out: Geodetic = { lat: 0, lon: 0, height: 0 },
): Geodetic {
    let u = -(e * e + n * n) / (2 * WGS84_A);
    for (let i = 0; ; i++) {
        const ecef = enuToEcef(basis, { e, n, u }, _solveEcef);
        ecefToGeodetic(ecef.x, ecef.y, ecef.z, out);
        const target = heightAt === undefined ? 0 : heightAt(out.lat, out.lon);
        const miss = target - out.height;
        if (Math.abs(miss) < SURFACE_SOLVE_TOL_M || i + 1 >= SURFACE_SOLVE_MAX_STEPS) {
            return out;
        }
        u += miss;
    }
}
const _solveEcef: Ecef = { x: 0, y: 0, z: 0 };

/**
 * Scene Y of the sea surface at scene (x, z): the first-order curvature of the
 * earth falling away from the play origin, ~8 m at 10 km. Things laid on open
 * water (a ship, its wake) use this rather than y = 0, which far out hangs in
 * the air above the drawn sea.
 */
export function seaLevelSceneY(x: number, z: number): number {
    return -(x * x + z * z) / (2 * WGS84_A);
}

/**
 * Scene space: **x = east, y = up, z = south**. North is −z.
 *
 * The sign is not a matter of taste. Three.js is right-handed with +Y up, so
 * east × up is *south*; calling +z north makes the frame left-handed and every
 * position expressed in it comes out as the mirror image of the place it
 * describes — an island's east coast drawn on the pilot's west side. It also
 * has to agree with the rest of the sim, which settled this long before the
 * terrain existed: `vectorHeading` reads a bearing as atan2(x, −z).
 *
 * Everything crossing the ENU ↔ scene boundary goes through these two, so the
 * flip lives in one place instead of being re-derived at each call site.
 */
export function sceneFromEnu(enu: Enu, out: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    return out.set(enu.e, enu.u, -enu.n);
}

export function enuFromScene(world: THREE.Vector3, out: Enu = { e: 0, n: 0, u: 0 }): Enu {
    out.e = world.x;
    out.n = -world.z;
    out.u = world.y;
    return out;
}

/** Geodetic (lat/lon/altitude) → scene space, via the ENU basis. */
export function geodeticToWorld(
    basis: EnuBasis,
    latDeg: number,
    lonDeg: number,
    altitudeM: number,
    out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
    const ecef = geodeticToEcef(latDeg, lonDeg, altitudeM);
    const enu = ecefToEnu(basis, ecef);
    return sceneFromEnu(enu, out);
}

/** Scene space (x/y/z) → geodetic (lat/lon/altitude), via the ENU basis. */
export function worldToGeodetic(
    basis: EnuBasis,
    x: number,
    y: number,
    z: number,
): Geodetic {
    const enu = enuFromScene(new THREE.Vector3(x, y, z));
    const ecef = enuToEcef(basis, enu);
    return ecefToGeodetic(ecef.x, ecef.y, ecef.z);
}

/** ENU north of a scene z. North runs against z, so the map is its own inverse. */
export function northFromSceneZ(z: number): number {
    return -z;
}

/** Scene z of an ENU north. Named for the direction it reads, not the sign. */
export function sceneZFromNorth(n: number): number {
    return -n;
}

/** Scene-space (x=east, y=up, z=south) rotation of one ENU basis. */
function sceneRotation(basis: EnuBasis, out: THREE.Matrix4): THREE.Matrix4 {
    const m = basis.ecefToEnu;
    // Rows of `m` are the east, north and up axes; scene order is east, up,
    // south — hence the negated north row, which is what keeps this a proper
    // rotation rather than a reflection.
    return out.set(
        m[0], m[1], m[2], 0,
        m[6], m[7], m[8], 0,
        -m[3], -m[4], -m[5], 0,
        0, 0, 0, 1,
    );
}

const _from = new THREE.Matrix4();
const _to = new THREE.Matrix4();

/**
 * Rotation carrying vectors expressed in `from`'s axes into `to`'s axes.
 *
 * ENU is a tangent frame, so two of them at different points are related by a
 * rotation, not just an offset: at Tenerife the axes of a Gran Canaria frame
 * are turned half a degree, and in the Alps by sixteen.
 *
 * This matters because a baked tile stores its vertices as offsets from the
 * tile centre *in the frame the bake used*. Place that tile in a different
 * frame without rotating it and every vertex lands wrong in proportion to its
 * distance from the tile centre — 62 m at Tenerife, 2.5 km in the Alps,
 * measured half a z12 tile out. The offset is exact, not an approximation, and
 * collapses to the identity when the two frames share an origin.
 */
export function enuFrameRotation(from: EnuBasis, to: EnuBasis): THREE.Quaternion {
    sceneRotation(from, _from).transpose();
    sceneRotation(to, _to);
    return new THREE.Quaternion().setFromRotationMatrix(_to.multiply(_from));
}


/**
 * The rigid move that re-expresses scene coordinates of one ENU frame in
 * another: `p' = rotation·p + offset` for points, `rotation·v` for
 * directions and velocities, `rotation·q` for orientations.
 *
 * This is what a mid-flight re-base hands every holder of scene state. Both
 * frames describe the same physical world, so applying it moves nothing on
 * the ground; it only turns the axes so that "up" is up again where the
 * aircraft now is.
 */
export class FrameShift {
    private readonly _v = new THREE.Vector3();
    private readonly _yaw = new THREE.Vector3();

    constructor(readonly rotation: THREE.Quaternion, readonly offset: THREE.Vector3) {}

    /** The shift from one ENU frame's scene coordinates to another's. */
    static between(from: EnuBasis, to: EnuBasis): FrameShift {
        // Offset: where the old origin lands in the new frame.
        return new FrameShift(enuFrameRotation(from, to), sceneFromEnu(ecefToEnu(to, from.origin)));
    }

    /** Structured-clone-safe form, for the sim worker. */
    toArrays(): { rotation: [number, number, number, number]; offset: [number, number, number] } {
        return {
            rotation: this.rotation.toArray() as [number, number, number, number],
            offset: this.offset.toArray() as [number, number, number],
        };
    }

    static fromArrays(a: { rotation: number[]; offset: number[] }): FrameShift {
        return new FrameShift(
            new THREE.Quaternion().fromArray(a.rotation), new THREE.Vector3().fromArray(a.offset));
    }

    /**
     * A scene heading (0 = +Z, see vectorHeading) turned into the new frame.
     * Only the yaw survives; the tilt a heading cannot hold is the caller's to
     * drop or carry (see {@link slopedHeading}).
     */
    heading(h: number): number {
        return this.slopedHeading(h, 0).heading;
    }

    /**
     * A heading with a rise per metre along it, turned into the new frame. The
     * part of the tilt that lies along the axis comes out as a change of slope.
     */
    slopedHeading(h: number, slope: number): { heading: number; slope: number } {
        const d = this.vector(this._yaw.set(Math.sin(h), slope, Math.cos(h)));
        const run = Math.hypot(d.x, d.z);
        return { heading: Math.atan2(d.x, d.z), slope: d.y / run };
    }

    /** A position, in place. */
    point<T extends THREE.Vector3>(p: T): T {
        p.applyQuaternion(this.rotation).add(this.offset);
        return p;
    }

    /** A direction, velocity or angular rate, in place. */
    vector<T extends THREE.Vector3>(v: T): T {
        v.applyQuaternion(this.rotation);
        return v;
    }

    /** An orientation (local → scene), in place. */
    orientation<T extends THREE.Quaternion>(q: T): T {
        q.premultiply(this.rotation);
        return q;
    }

    /** An object's position and quaternion, in place; its own matrix is refreshed if it does not auto-update. */
    object(o: THREE.Object3D): void {
        this.point(o.position);
        this.orientation(o.quaternion);
        if (!o.matrixAutoUpdate) {
            o.updateMatrix();
        }
    }

    /** xyz triples in a flat array, from `start` to `end` (exclusive, in triples), in place. */
    points(a: { [i: number]: number }, start: number, end: number, stride = 3): void {
        const v = this._v;
        for (let i = start; i < end; i++) {
            const k = i * stride;
            v.set(a[k], a[k + 1], a[k + 2]);
            this.point(v);
            a[k] = v.x;
            a[k + 1] = v.y;
            a[k + 2] = v.z;
        }
    }
}

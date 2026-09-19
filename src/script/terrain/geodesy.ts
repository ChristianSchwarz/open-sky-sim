/** WGS84 ellipsoid constants and geodetic ↔ ECEF ↔ ENU transforms. */

import * as THREE from 'three';

export const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_B = WGS84_A * (1 - WGS84_F);

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


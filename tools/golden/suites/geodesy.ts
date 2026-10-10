/**
 * Geodesy and re-base fixtures: WGS84 <-> ECEF <-> ENU <-> scene, the
 * tangent-plane surface solve, and FrameShift (workstream A of the Unity port).
 *
 * Scene axes are x = east, y = up, z = SOUTH. The expected values here are the
 * contract that keeps the C# port from mirroring the world.
 */
import * as THREE from 'three';
import {
    ecefToEnu, ecefToGeodetic, enuFromScene, enuToEcef, enuToGeodeticApprox, EnuBasis,
    enuFrameRotation, FrameShift, geodeticOnSurfaceAtEnu, geodeticToEcef, geodeticToWorld,
    makeEnuBasis, northFromSceneZ, sceneFromEnu, sceneZFromNorth, seaLevelSceneY,
    worldToGeodetic, WGS84_A, WGS84_B,
} from '../../../src/script/terrain/geodesy';
import { arr, Rng, SuiteOutput } from '../lib';

/** Hand-picked places, including the awkward ones (poles, antimeridian, high). */
const POINTS: ReadonlyArray<readonly [number, number, number, string]> = [
    [0, 0, 0, 'null island'],
    [0, 180, 0, 'antimeridian east'],
    [0, -180, 100, 'antimeridian west'],
    [89.9, 10, 0, 'near north pole'],
    [-89.9, 170, 0, 'near south pole'],
    [28.0015, -15.3937, 0, 'play origin (GCLP)'],
    [27.9, -15.6, 2000, 'Gran Canaria, airborne'],
    [52.52, 13.405, 34, 'Berlin'],
    [47.421, 10.985, 2962, 'Zugspitze'],
    [44.9, 34.1, 100, 'Crimea'],
    [-33.87, 151.2, 20, 'Sydney'],
    [35.68, 139.7, 40, 'Tokyo'],
    [0.0001, 0.0001, 8848, 'equator, high'],
    [60, -179.9, 0, 'Bering'],
    [-60, 179.9, 10000, 'south Pacific, high'],
    [-0.5, -0.5, -100, 'below the ellipsoid'],
    [45, 45, 0, '45 degrees'],
    [-45, -45, 0, '45 degrees south'],
];

/** ENU origins to express points in: the home frame and re-base targets far from it. */
const ORIGINS: ReadonlyArray<readonly [number, number, number, string]> = [
    [28.0015, -15.3937, 0, 'home (PLAY_ORIGIN)'],
    [28.3, -16.3, 0, 'Tenerife-ish, 100 km out'],
    [47.3, 11.0, 700, 'Alps'],
    [52.52, 13.4, 34, 'Berlin'],
    [44.6, 33.5, 0, 'Crimea'],
    [0, 0, 0, 'equator'],
    [-33.9, 151.2, 0, 'southern hemisphere'],
    [80, 20, 0, 'high latitude'],
];

/** Ground height used by the surface solve; the C# side reimplements it from these coefficients. */
const HEIGHT_FN = { c0: 100, cLat: 2, cLon: 0.5 };
const heightAt = (lat: number, lon: number): number => HEIGHT_FN.c0 + HEIGHT_FN.cLat * lat + HEIGHT_FN.cLon * lon;

function basisJson(b: EnuBasis): unknown {
    return {
        origin: [b.origin.x, b.origin.y, b.origin.z],
        lat0: b.lat0,
        lon0: b.lon0,
        ecefToEnu: arr(b.ecefToEnu),
        enuToEcef: arr(b.enuToEcef),
    };
}

export function geodesySuite(): SuiteOutput {
    const rng = new Rng(0x6E0DE5);

    // 1. Pure geodetic <-> ECEF.
    const points = POINTS.map(([lat, lon, h]) => [lat, lon, h] as [number, number, number]);
    for (let i = 0; i < 40; i++) {
        points.push([rng.range(-89.5, 89.5), rng.range(-180, 180), rng.range(-200, 12000)]);
    }
    const geodeticEcef = points.map(([lat, lon, h]) => {
        const e = geodeticToEcef(lat, lon, h);
        const back = ecefToGeodetic(e.x, e.y, e.z);
        return {
            lat, lon, height: h,
            ecef: [e.x, e.y, e.z],
            roundTrip: { lat: back.lat, lon: back.lon, height: back.height },
        };
    });

    // 2. ENU bases and conversions through them.
    const bases = ORIGINS.map(([lat0, lon0, h0, label]) => {
        const basis = makeEnuBasis(lat0, lon0, h0);
        const probes = [] as unknown[];
        // A ring of points around the origin, 0..120 km out, at several heights.
        for (let i = 0; i < 12; i++) {
            const bearing = (i / 12) * 2 * Math.PI + rng.range(0, 0.2);
            const dist = [0, 500, 3000, 12000, 30000, 65000, 120000][i % 7];
            const dLat = (dist * Math.cos(bearing)) / 111000;
            const dLon = (dist * Math.sin(bearing)) / (111000 * Math.max(0.05, Math.cos(lat0 * Math.PI / 180)));
            const lat = Math.max(-89, Math.min(89, lat0 + dLat));
            const lon = lon0 + dLon;
            const height = [0, 50, 1200, 9000][i % 4];
            const ecef = geodeticToEcef(lat, lon, height);
            const enu = ecefToEnu(basis, ecef);
            const ecefBack = enuToEcef(basis, enu);
            const scene = sceneFromEnu(enu);
            const world = geodeticToWorld(basis, lat, lon, height);
            const geo = worldToGeodetic(basis, world.x, world.y, world.z);
            const approx = enuToGeodeticApprox(basis, enu.e, enu.n, enu.u);
            const surface = geodeticOnSurfaceAtEnu(basis, enu.e, enu.n, heightAt);
            const surfaceSea = geodeticOnSurfaceAtEnu(basis, enu.e, enu.n);
            const enuAgain = enuFromScene(scene);
            probes.push({
                lat, lon, height,
                ecef: [ecef.x, ecef.y, ecef.z],
                enu: [enu.e, enu.n, enu.u],
                ecefBack: [ecefBack.x, ecefBack.y, ecefBack.z],
                scene: arr(scene.toArray()),
                world: arr(world.toArray()),
                worldToGeodetic: { lat: geo.lat, lon: geo.lon, height: geo.height },
                enuToGeodeticApprox: { lat: approx.lat, lon: approx.lon, height: approx.height },
                enuFromScene: [enuAgain.e, enuAgain.n, enuAgain.u],
                surfaceSolve: { lat: surface.lat, lon: surface.lon, height: surface.height },
                surfaceSolveEllipsoid: { lat: surfaceSea.lat, lon: surfaceSea.lon, height: surfaceSea.height },
                seaLevelSceneY: seaLevelSceneY(scene.x, scene.z),
            });
        }
        return { label, lat0, lon0, height0: h0, basis: basisJson(basis), probes };
    });

    // 3. Frame shifts between every ordered pair of a handful of origins.
    const shiftPairs: Array<[number, number]> = [[0, 1], [1, 0], [0, 2], [2, 0], [2, 3], [3, 4], [0, 5], [5, 6], [0, 7], [4, 4]];
    const shifts = shiftPairs.map(([fromIdx, toIdx]) => {
        const from = makeEnuBasis(ORIGINS[fromIdx][0], ORIGINS[fromIdx][1], ORIGINS[fromIdx][2]);
        const to = makeEnuBasis(ORIGINS[toIdx][0], ORIGINS[toIdx][1], ORIGINS[toIdx][2]);
        const shift = FrameShift.between(from, to);
        const rot = enuFrameRotation(from, to);
        const samples = [] as unknown[];
        for (let i = 0; i < 6; i++) {
            const p = new THREE.Vector3(rng.range(-80000, 80000), rng.range(-200, 9000), rng.range(-80000, 80000));
            const v = new THREE.Vector3(rng.range(-300, 300), rng.range(-50, 50), rng.range(-300, 300));
            const q = new THREE.Quaternion(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize();
            const h = rng.range(-Math.PI, Math.PI);
            const slope = rng.range(-0.3, 0.3);
            const sloped = shift.slopedHeading(h, slope);
            samples.push({
                point: { in: arr(p.toArray()), out: arr(shift.point(p.clone()).toArray()) },
                vector: { in: arr(v.toArray()), out: arr(shift.vector(v.clone()).toArray()) },
                orientation: { in: arr(q.toArray()), out: arr(shift.orientation(q.clone()).toArray()) },
                heading: { in: h, out: shift.heading(h) },
                slopedHeading: { heading: h, slope, outHeading: sloped.heading, outSlope: sloped.slope },
            });
        }
        return {
            from: fromIdx, to: toIdx,
            rotation: arr(shift.rotation.toArray()),
            frameRotation: arr(rot.toArray()),
            offset: arr(shift.offset.toArray()),
            samples,
        };
    });

    // 4. North/south helpers (their own inverse).
    const northHelpers = [-50000, -1, 0, 1, 12345.5].map(z => ({
        z, north: northFromSceneZ(z), sceneZ: sceneZFromNorth(z),
    }));

    return {
        files: [{
            file: 'geodesy.json',
            data: {
                suite: 'geodesy',
                version: 1,
                source: 'src/script/terrain/geodesy.ts',
                notes: [
                    'Scene axes: x = east, y = up, z = south (north = -z).',
                    'Quaternions are compared up to sign (q and -q are the same rotation).',
                    'surfaceSolve uses heightFn: height(lat, lon) = c0 + cLat*lat + cLon*lon.',
                    'rotation/frameRotation/orientation are [x, y, z, w].',
                ],
                tolerances: { metres: 1e-6, degrees: 1e-9, quaternion: 1e-12, radians: 1e-12 },
                constants: { WGS84_A, WGS84_B },
                heightFn: HEIGHT_FN,
                geodeticEcef,
                bases,
                shifts,
                northHelpers,
                origins: ORIGINS.map(([lat, lon, h, label]) => ({ lat, lon, height: h, label })),
            },
        }],
    };
}

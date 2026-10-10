/**
 * Terrain LOD fixtures (workstream C): the pure functions of lod.ts, and the
 * quadtree's draw/want selection along scripted camera paths.
 *
 * The world is fully determined by fixture files: tiles/manifest.json (level
 * errors, max zoom, ENU origin) and tiles/index/index_mesh.bin (which tiles
 * exist; absent = ocean). Residency is "exists in the index and z <=
 * residentMaxZoom", so paths can exercise both the normal cut and the
 * parent-waits-for-children rule.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import {
    adjustDetailScale, cameraFarForAltitudeM, clampDetailDistanceM, clampLanduseRevealPx,
    clampTriangleBudget, detailFalloff, DETAIL_DISTANCE_OFF, ellipsoidSagittaM, FRUSTUM_CULL_MARGIN_TAN,
    landuseRevealScale, refineDistanceM, shouldRefine, terrainMaxZoomForAltitudeM, terrainViewRangeM,
} from '../../../src/script/terrain/lod';
import { behindHorizon } from '../../../src/script/terrain/culling';
import { EnuBasis, makeEnuBasis, sceneFromEnu, ecefToEnu, WGS84_A, geodeticToWorld } from '../../../src/script/terrain/geodesy';
import { TerrainManifest } from '../../../src/script/terrain/manifest';
import { Quadtree } from '../../../src/script/terrain/quadtree';
import { tileOriginWorld } from '../../../src/script/terrain/tileMesh';
import { TileIndex } from '../../../src/script/terrain/tileIndex';
import { approxTileEdgeMetres, TileKey, tileKeyString } from '../../../src/script/terrain/tiling';
import { arr, Rng, SuiteOutput } from '../lib';
import type { SuiteContext } from '../generate';

const DEG = Math.PI / 180;

interface CameraPath {
    name: string;
    /** ENU origin the scene frame is built on (the game re-bases near the aircraft). */
    origin: [number, number, number];
    /** Earth centre in that frame: the game's initial (0, -A, 0), or exact after a re-base. */
    earthCenter: 'initial' | 'exact';
    /** Start lat/lon/alt, heading (deg, 0 = north), pitch (deg, + = nose up). */
    start: [number, number, number];
    headingDeg: number;
    pitchDeg: number;
    /** Per-frame changes. */
    velocity: [number, number, number];
    yawRateDegPerFrame: number;
    frames: number;
    fovYDeg: number;
    aspect: number;
    screenHeightPx: number;
    detailScale: number;
    detailDistanceM: number;
    leafScale: number;
    visibleZoomCap: number;
    residentMaxZoom: number;
}

const PATHS: CameraPath[] = [
    {
        name: 'gc_low_pass', origin: [28.0015, -15.3937, 0], earthCenter: 'initial',
        start: [27.95, -15.6, 1500], headingDeg: 0, pitchDeg: -8, velocity: [0, 0, -25],
        yawRateDegPerFrame: 0, frames: 6, fovYDeg: 50, aspect: 16 / 9, screenHeightPx: 480,
        detailScale: 1, detailDistanceM: 12000, leafScale: 1.5, visibleZoomCap: Infinity, residentMaxZoom: 12,
    },
    {
        name: 'gc_turn_in_place', origin: [28.0015, -15.3937, 0], earthCenter: 'initial',
        start: [27.9, -15.45, 3000], headingDeg: 0, pitchDeg: -15, velocity: [0, 0, 0],
        yawRateDegPerFrame: 45, frames: 8, fovYDeg: 50, aspect: 16 / 9, screenHeightPx: 360,
        detailScale: 1.4, detailDistanceM: DETAIL_DISTANCE_OFF, leafScale: 1.5, visibleZoomCap: Infinity, residentMaxZoom: 12,
    },
    {
        name: 'gc_leaves_loading', origin: [28.0015, -15.3937, 0], earthCenter: 'initial',
        start: [27.93, -15.5, 900], headingDeg: 45, pitchDeg: -10, velocity: [15, 0, -15],
        yawRateDegPerFrame: 2, frames: 6, fovYDeg: 60, aspect: 4 / 3, screenHeightPx: 480,
        detailScale: 1, detailDistanceM: 12000, leafScale: 3, visibleZoomCap: Infinity, residentMaxZoom: 11,
    },
    {
        name: 'gc_climb', origin: [28.0015, -15.3937, 0], earthCenter: 'initial',
        start: [27.8, -15.5, 8000], headingDeg: 300, pitchDeg: -30, velocity: [0, 1500, 0],
        yawRateDegPerFrame: 0, frames: 8, fovYDeg: 50, aspect: 16 / 9, screenHeightPx: 720,
        detailScale: 2, detailDistanceM: 12000, leafScale: 1.5, visibleZoomCap: 11, residentMaxZoom: 12,
    },
    {
        name: 'alps_rebased', origin: [47.4, 11.0, 0], earthCenter: 'exact',
        start: [47.4, 11.0, 4000], headingDeg: 180, pitchDeg: -12, velocity: [0, 0, 30],
        yawRateDegPerFrame: 1, frames: 8, fovYDeg: 50, aspect: 16 / 9, screenHeightPx: 400,
        detailScale: 1, detailDistanceM: 12000, leafScale: 1.5, visibleZoomCap: Infinity, residentMaxZoom: 12,
    },
    {
        name: 'orbit_400km', origin: [47.0, 10.0, 0], earthCenter: 'exact',
        start: [47.0, 10.0, 400000], headingDeg: 0, pitchDeg: -70, velocity: [2000, 0, 0],
        yawRateDegPerFrame: 0, frames: 4, fovYDeg: 50, aspect: 16 / 9, screenHeightPx: 1080,
        detailScale: 1, detailDistanceM: 12000, leafScale: 1.5, visibleZoomCap: Infinity, residentMaxZoom: 12,
    },
];

/** Camera orientation: yaw about +Y (heading clockwise from north, north = -Z), then pitch about the camera's +X. */
function cameraQuaternion(headingDeg: number, pitchDeg: number): THREE.Quaternion {
    // A three.js camera looks down -Z, which is north in scene axes, so heading 0 needs no yaw.
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -headingDeg * DEG);
    const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchDeg * DEG);
    return yaw.multiply(pitch);
}

function readFixtures(ctx: SuiteContext): { manifest: TerrainManifest; index: TileIndex } {
    const tiles = path.join(ctx.goldenRoot, 'tiles');
    const manifest = JSON.parse(fs.readFileSync(path.join(tiles, 'manifest.json'), 'utf8')) as TerrainManifest;
    const index = TileIndex.decode(new Uint8Array(fs.readFileSync(path.join(tiles, 'index', 'index_mesh.bin'))));
    return { manifest, index };
}

function lodFunctions(): unknown {
    const rng = new Rng(0x10D);
    const keys: TileKey[] = [{ z: 0, x: 0, y: 0 }, { z: 2, x: 3, y: 1 }, { z: 8, x: 233, y: 88 }, { z: 12, x: 3682, y: 1416 }, { z: 11, x: 2114, y: 427 }];
    const altitudes = [-50, 0, 500, 3000, 6000, 10000, 15000, 18500, 22000, 30000, 55000, 100000, 150000, 250000, 400000, 2e6];
    const refine: unknown[] = [];
    for (let i = 0; i < 60; i++) {
        const err = [0.5, 30, 400, 2392.04, 6538.09][i % 5] * rng.range(0.5, 2);
        const dist = rng.range(1, 400000);
        const h = [720, 1080, 1440][i % 3];
        const fov = [40, 50, 70][i % 3];
        const scale = [1, 1.3, 4][i % 3];
        const knee = [DETAIL_DISTANCE_OFF, 12000, 2000, 0][i % 4];
        refine.push({
            geometricErrorM: err, distanceM: dist, screenHeightPx: h, fovYDeg: fov, detailScale: scale, kneeM: knee,
            shouldRefine: shouldRefine(err, dist, h, fov, scale),
            refineDistanceM: refineDistanceM(err, h, fov, scale, knee),
            detailFalloff: detailFalloff(dist, knee),
        });
    }
    return {
        refine,
        altitude: altitudes.map(a => ({
            altitudeM: a,
            terrainViewRangeM: terrainViewRangeM(a),
            cameraFarForAltitudeM: cameraFarForAltitudeM(a),
            maxZoom12: terrainMaxZoomForAltitudeM(a, 12),
            maxZoom12Coastal: terrainMaxZoomForAltitudeM(a, 12, true),
            maxZoom9Coastal: terrainMaxZoomForAltitudeM(a, 9, true),
        })),
        sagitta: keys.map(k => ({ key: k, ellipsoidSagittaM: ellipsoidSagittaM(k) })),
        landuseRevealScale: [[1080, 50, 6], [720, 70, 1], [1440, 40, 24], [900, 60, 0]].map(([h, f, px]) => ({
            screenHeightPx: h, fovYDeg: f, minPx: px, scale: landuseRevealScale(h, f, px),
        })),
        adjustDetailScale: [[1, 30], [1, 26], [1, 20], [2, 22], [3.9, 40], [1.02, 10], [2, 25]].map(([cur, ema]) => ({
            current: cur, frameEmaMs: ema, next: adjustDetailScale(cur, ema),
        })),
        clamps: {
            detailDistance: [0, 1000, 12000, 39999, 40000, Infinity, NaN].map(v => ({ value: v, out: clampDetailDistanceM(v) })),
            landuseRevealPx: [0, 6, 30, NaN].map(v => ({ value: v, out: clampLanduseRevealPx(v) })),
            triangleBudget: [1000, 600000.4, 600000.5, 5e6, NaN].map(v => ({ value: v, out: clampTriangleBudget(v) })),
        },
        frustumCullMarginTan: FRUSTUM_CULL_MARGIN_TAN,
    };
}

function horizonCases(): unknown {
    const rng = new Rng(0x4071);
    const earth = new THREE.Vector3(0, -WGS84_A, 0);
    const out: unknown[] = [];
    for (let i = 0; i < 40; i++) {
        const cam = new THREE.Vector3(rng.range(-2e5, 2e5), [100, 3000, 50000, 400000, -10][i % 5], rng.range(-2e5, 2e5));
        const pt = new THREE.Vector3(rng.range(-3e6, 3e6), rng.range(-6e5, 1e3), rng.range(-3e6, 3e6));
        const r = rng.range(10, 2e5);
        out.push({ camera: arr(cam.toArray()), center: arr(pt.toArray()), radius: r, behind: behindHorizon(pt, r, cam, earth, WGS84_A) });
    }
    return out;
}

function runPath(p: CameraPath, manifest: TerrainManifest, index: TileIndex): unknown {
    const basis: EnuBasis = makeEnuBasis(p.origin[0], p.origin[1], p.origin[2]);
    const earthCenter = p.earthCenter === 'initial'
        ? new THREE.Vector3(0, -WGS84_A, 0)
        : sceneFromEnu(ecefToEnu(basis, { x: 0, y: 0, z: 0 }));
    const maxZoom = manifest.mesh.maxZoom;
    const quadtree = new Quadtree({
        manifest,
        tilePosition: id => tileOriginWorld(id, 0, basis),
        tileRadius: id => approxTileEdgeMetres(id) * 0.75,
        isResident: id => index.has(id) && id.z <= p.residentMaxZoom,
        isOcean: id => !index.has(id),
        earthCenter,
        maxZoom,
    });

    const startPos = geodeticToWorld(basis, p.start[0], p.start[1], p.start[2]);
    const camera = new THREE.PerspectiveCamera(p.fovYDeg, p.aspect, 2, cameraFarForAltitudeM(startPos.y));
    camera.position.copy(startPos);
    let heading = p.headingDeg;
    const frames: unknown[] = [];
    for (let f = 0; f < p.frames; f++) {
        camera.quaternion.copy(cameraQuaternion(heading, p.pitchDeg));
        camera.far = cameraFarForAltitudeM(camera.position.y);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        const nowMs = 1000 + f * 100;
        const { draw, wants } = quadtree.update(
            camera, p.screenHeightPx, p.fovYDeg, p.detailScale, p.detailDistanceM, undefined, p.leafScale, nowMs, p.visibleZoomCap,
        );
        frames.push({
            frame: f,
            nowMs,
            position: arr(camera.position.toArray()),
            quaternion: arr(camera.quaternion.toArray()),
            far: camera.far,
            projectionMatrix: arr(camera.projectionMatrix.elements),
            matrixWorldInverse: arr(camera.matrixWorldInverse.elements),
            // Compact: keys in visit order; per-node state only where it is not the default.
            draw: {
                count: draw.length,
                keys: draw.map(n => n.key).join(','),
                state: draw.map(n => (n.resident ? 'R' : n.ocean ? 'O' : '-')).join(''),
                under: draw.flatMap((n, i) => (n.under ? [i] : [])),
                fade: draw.flatMap((n, i) => (n.fadeM !== 0 ? [[i, n.fadeM, n.fadeFromMs]] : [])),
            },
            wants: wants.map(w => ({ key: tileKeyString(w.id), ssePx: w.ssePx, distanceM: w.distanceM, inFrustum: w.inFrustum, pinned: w.pinned })),
        });
        camera.position.add(new THREE.Vector3(...p.velocity));
        heading += p.yawRateDegPerFrame;
    }
    return {
        ...p,
        detailDistanceM: p.detailDistanceM,
        visibleZoomCap: p.visibleZoomCap,
        basisOrigin: p.origin,
        earthCenterScene: arr(earthCenter.toArray()),
        maxZoom,
        frames,
    };
}

export function quadtreeSuite(ctx: SuiteContext): SuiteOutput {
    const { manifest, index } = readFixtures(ctx);
    return {
        files: [{
            file: 'terrain_lod.json',
            data: {
                suite: 'terrain_lod',
                version: 1,
                source: 'src/script/terrain/{lod,quadtree,culling}.ts',
                notes: [
                    'World: tiles/manifest.json (mesh.levelGeometricErrorM, mesh.maxZoom) and tiles/index/index_mesh.bin.',
                    'tilePosition(id) = tileOriginWorld(id, 0, basis): lon/lat midpoint of tileBounds at height 0, geodetic -> ECEF -> ENU -> scene.',
                    'tileRadius(id) = approxTileEdgeMetres(id) * 0.75. isOcean = !index.has(id). isResident = index.has(id) && z <= residentMaxZoom. tileErrorM not supplied.',
                    'Camera: THREE.PerspectiveCamera(fovYDeg, aspect, near 2, far = cameraFarForAltitudeM(position.y)); quaternion = yaw(-heading about +Y) * pitch(about +X); projection/view matrices recorded column-major.',
                    'Each frame: quadtree.update(camera, screenHeightPx, fovYDeg, detailScale, detailDistanceM, pinned = undefined, leafScale, nowMs, visibleZoomCap); then position += velocity, heading += yawRate.',
                    'One Quadtree instance per path: node state (takeoverAt, dissolving, errorFromTile) carries across frames.',
                    'Order of draw and wants is the visit order (depth first, roots (0,0,0) then (0,1,0), children in childrenOf order).',
                    'draw.keys: comma-joined z/x/y; draw.state: one char per node, R resident, O ocean, - neither; draw.under: indices drawn as dissolving under-parents; draw.fade: [index, fadeM, fadeFromMs] for nodes with fadeM != 0.',
                ],
                tolerances: { metres: 1e-6, relative: 1e-12 },
                lod: lodFunctions(),
                horizon: horizonCases(),
                paths: PATHS.map(p => runPath(p, manifest, index)),
            },
        }],
    };
}

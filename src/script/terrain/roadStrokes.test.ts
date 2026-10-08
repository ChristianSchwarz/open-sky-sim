import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { RoadsMode } from '../state/gameDefs';
import { ROAD_SIDE_BIT, RoadClass, decodePtr, encodePtr } from './ptr';
import { RoadStrokes, buildRoadMeshes, roadTriangles, trackDetailReachM } from './roadStrokes';
import { RAIL_DETAIL_FADE_M } from '../scene/materials/shaders/depthFP';
import { TileMeshes } from './tileMesh';

const ID = { z: 12, x: 4402, y: 856 };
const Q = 0.1;

/** Two strokes of two points each: one primary (major), one residential (minor). */
function sidecar(quantScale: number = Q) {
    const positions = new Float32Array([
        0, 1, 0, 0, 1, 0, 10, 1, 0, 10, 1, 0,        // primary
        0, 1, 5, 0, 1, 5, 10, 1, 5, 10, 1, 5,        // residential
    ]);
    const directions = new Float32Array([
        0, 0, 1, 0, 0, -1, 0, 0, 1, 0, 0, -1,
        0, 0, 1, 0, 0, -1, 0, 0, 1, 0, 0, -1,
    ]);
    const halfWidthsM = new Float32Array([6, 6, 6, 6, 2.5, 2.5, 2.5, 2.5]);
    const classes = Uint8Array.from([
        RoadClass.Primary, RoadClass.Primary, RoadClass.Primary, RoadClass.Primary,
        RoadClass.Residential, RoadClass.Residential, RoadClass.Residential, RoadClass.Residential,
    ]);
    const indices = Uint32Array.from([0, 1, 3, 0, 3, 2, 4, 5, 7, 4, 7, 6]);
    const bytes = encodePtr({ id: ID, quantScale, positions, directions, halfWidthsM, classes, indices });
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return decodePtr(copy.buffer);
}

const major = new THREE.MeshBasicMaterial();
const minor = new THREE.MeshBasicMaterial();
const rail = new THREE.MeshBasicMaterial();
const mats = { major, minor, rail };

describe('buildRoadMeshes', () => {
    it('splits the one vertex buffer into a major and a minor mesh by class', () => {
        const roads = buildRoadMeshes(sidecar(), Q, mats);
        assert.ok(roads.major && roads.minor);
        assert.equal(roads.major.geometry.getIndex()!.count, 6);
        assert.equal(roads.minor.geometry.getIndex()!.count, 6);
        assert.equal(roads.major.material, major);
        assert.equal(roads.minor.material, minor);
        // Both index lists address the same positions, halves and offsets.
        assert.equal(roads.major.geometry.getAttribute('position').count, 8);
        assert.equal(roads.minor.geometry.getAttribute('riverHalf').count, 8);
        assert.equal((roads.minor.geometry.getAttribute('riverDir') as THREE.InterleavedBufferAttribute).itemSize, 3);
        assert.equal(roadTriangles(roads), 4);
        assert.equal(roads.group.scale.x, 1, 'same quantisation step as the tile: no rescale');
    });

    it('leaves out a class the tile has none of', () => {
        const tile = sidecar();
        // Everything primary.
        for (let v = 0; v < 8; v++) {
            tile.directions[v * 4 + 3] = RoadClass.Primary;
        }
        const roads = buildRoadMeshes(tile, Q, mats);
        assert.ok(roads.major);
        assert.equal(roads.minor, undefined);
        assert.equal(roads.major.geometry.getIndex()!.count, 12);
    });

    it('puts railways in a mesh of their own, shown with the major roads', () => {
        const tile = sidecar();
        // The second stroke becomes a railway, its negative bank marked.
        for (let v = 4; v < 8; v++) {
            tile.directions[v * 4 + 3] = RoadClass.Rail | (v % 2 === 1 ? ROAD_SIDE_BIT : 0);
        }
        const roads = buildRoadMeshes(tile, Q, mats);
        assert.ok(roads.major && roads.rail);
        assert.equal(roads.minor, undefined);
        assert.equal(roads.rail.material, rail);
        assert.equal(roads.rail.geometry.getIndex()!.count, 6);
        // Service track (a siding beside the main line) draws as rail too.
        const service = sidecar();
        for (let v = 4; v < 8; v++) {
            service.directions[v * 4 + 3] = RoadClass.RailService | (v % 2 === 1 ? ROAD_SIDE_BIT : 0);
        }
        assert.equal(buildRoadMeshes(service, Q, mats).rail!.geometry.getIndex()!.count, 6);
        // Only the rail mesh carries the track attributes its program reads.
        assert.ok(roads.rail.geometry.getAttribute('riverMeta'));
        assert.ok(roads.rail.geometry.getAttribute('railAlong'));
        assert.equal(roads.major.geometry.getAttribute('railAlong'), undefined);
        assert.equal(roadTriangles(roads), 4);

        const strokes = new RoadStrokes({
            manifest: { roads: { path: '', indexPath: '', encoding: 'PTR1', minZoom: 8, maxZoom: 12 } } as never,
            baseUrl: '.', majorMaterial: major, minorMaterial: minor, railMaterial: rail,
        });
        (strokes as unknown as { attached: Set<unknown> }).attached.add(roads);
        strokes.setMode(RoadsMode.MAJOR);
        assert.equal(roads.rail.visible, true);
        strokes.setMode(RoadsMode.OFF);
        assert.equal(roads.rail.visible, false);
    });

    it('rescales a sidecar quantised in another step than its tile', () => {
        const roads = buildRoadMeshes(sidecar(0.2), Q, mats);
        assert.ok(Math.abs(roads.group.scale.x - 2) < 1e-6);
    });
});

describe('RoadStrokes', () => {
    const manifest = {
        version: 4, scheme: 'retro-terrain/1' as const, ellipsoid: 'WGS84' as const, seaLevel: 0,
        coverage: { west: 0, south: 0, east: 1, north: 1 },
        enuOrigin: { lat: 0, lon: 0, height: 0 },
        mesh: {
            path: '{z}/{x}/{y}.ptm', indexPath: 'index_mesh.bin', minZoom: 0, maxZoom: 12,
            encoding: 'PTM1', triangleBudget: 6144, levelGeometricErrorM: [], levelSkirtDepthM: [],
        },
        height: { path: '', indexPath: '', tileSize: 257, minZoom: 0, maxZoom: 12, queryZoom: 12, coarseZoom: 6 },
        flattenPads: [],
    };

    it('is disabled, and attaches nothing, on a pyramid baked without roads', () => {
        const strokes = new RoadStrokes({ manifest, baseUrl: '.', majorMaterial: major, minorMaterial: minor, railMaterial: rail });
        assert.equal(strokes.enabled, false);
        assert.equal(strokes.has({ z: 12, x: 1, y: 1 }), false);
        const meshes: TileMeshes = { group: new THREE.Group(), bytes: 0, geometricErrorM: 0 };
        strokes.attach({ z: 12, x: 1, y: 1 }, meshes, 0);
        assert.equal(meshes.roads, undefined);
    });

    it('the mode is a visibility flip on what is bound: MAJOR hides the streets, OFF both', () => {
        const withRoads = { ...manifest, roads: { path: '{z}/{x}/{y}.ptr', indexPath: 'index_roads.bin', encoding: 'PTR1', minZoom: 8, maxZoom: 12 } };
        const strokes = new RoadStrokes({ manifest: withRoads, baseUrl: '.', majorMaterial: major, minorMaterial: minor, railMaterial: rail });
        assert.equal(strokes.enabled, true);
        assert.equal(strokes.has({ z: 7, x: 1, y: 1 }), false, 'below the baked range');
        assert.equal(strokes.has({ z: 12, x: 1, y: 1 }), true, 'no index yet: assume present');
        // Bind by hand, the way attach() does once the sidecar lands.
        const meshes: TileMeshes = { group: new THREE.Group(), bytes: 0, geometricErrorM: 0 };
        meshes.group.scale.setScalar(Q);
        const roads = buildRoadMeshes(sidecar(), Q, mats);
        (strokes as unknown as { attached: Set<unknown> }).attached.add(roads);
        meshes.roads = roads;
        strokes.setMode(RoadsMode.MAJOR);
        assert.equal(roads.major!.visible, true);
        assert.equal(roads.minor!.visible, false);
        assert.equal(strokes.trianglesOf(meshes), 2);
        strokes.setMode(RoadsMode.OFF);
        assert.equal(roads.major!.visible, false);
        assert.equal(strokes.trianglesOf(meshes), 0);
        strokes.setMode(RoadsMode.ALL);
        assert.equal(roads.minor!.visible, true);
        assert.equal(strokes.trianglesOf(meshes), 4);
        // Released: the in-flight guard state, and nothing counted any more.
        strokes.release(meshes);
        assert.equal(meshes.roads, 'none');
        assert.equal(strokes.trianglesOf(meshes), 0);
    });
});

describe('track detail reach', () => {
    it('is never closer than where the shader has faded every fragment out', () => {
        // Any pixel, any surface past the reach: the larger of the two
        // footprints the rail shader takes (fwidth across and along, both
        // in-surface directions) must be past the end of the fade.
        let seed = 11;
        const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        const unit = () => new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
        let worst = Infinity;
        for (let i = 0; i < 20000; i++) {
            const fov = 20 + rand() * 80;
            const aspect = 1 + rand() * 1.5;
            const height = 300 + Math.floor(rand() * 2000);
            const width = height * aspect;
            const reach = trackDetailReachM(fov, aspect, height);
            const tanV = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
            const ray = (px: number, py: number) => new THREE.Vector3(
                (2 * px / width - 1) * tanV * aspect, (1 - 2 * py / height) * tanV, -1);
            const px = rand() * (width - 1);
            const py = rand() * (height - 1);
            const centre = ray(px, py);
            const n = unit();
            if (Math.abs(n.dot(centre.clone().normalize())) < 0.05) {
                continue;
            }
            const p = centre.clone().normalize().multiplyScalar(reach * (1 + rand() * 0.01));
            const hit = (d: THREE.Vector3) => d.clone().multiplyScalar(n.dot(p) / n.dot(d));
            const dx = hit(ray(px + 1, py)).sub(p);
            const dy = hit(ray(px, py + 1)).sub(p);
            const a = new THREE.Vector3().crossVectors(n, unit()).normalize();
            const l = new THREE.Vector3().crossVectors(n, a);
            const fp = (u: THREE.Vector3) => Math.abs(dx.dot(u)) + Math.abs(dy.dot(u));
            worst = Math.min(worst, Math.max(fp(a), fp(l)));
        }
        assert.ok(worst >= RAIL_DETAIL_FADE_M[1] * 0.999, `a pixel ${worst} m wide still shows detail`);
    });

    it('reaches kilometres, not tens of kilometres, at ordinary sizes', () => {
        const reach = trackDetailReachM(60, 16 / 9, 1080);
        assert.ok(reach > 3000 && reach < 12000, `${reach}`);
    });
});

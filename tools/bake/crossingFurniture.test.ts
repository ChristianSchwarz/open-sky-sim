import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BridgeRole } from '../../src/script/terrain/pbr';
import { RoadClass } from '../../src/script/terrain/ptr';
import { buildBoxMesh, IDENTITY_FRAME } from './bridgeMesh';
import { planCrossingFurniture, pushClear } from './crossingFurniture';
import { RoadLine } from './rvr';

/**
 * Plan metres straight from lon/lat x 1000: x east, z north, as plain axes.
 * The ground is flat at 10 m.
 */
const surface = {
    toXZ: (lon: number, lat: number) => ({ x: lon * 1000, z: lat * 1000 }),
    landH: () => 10,
};
const line = (cls: number, widthM: number, ...xz: number[]): RoadLine => {
    const points = [];
    for (let i = 0; i + 1 < xz.length; i += 2) {
        points.push({ lon: xz[i] / 1000, lat: xz[i + 1] / 1000 });
    }
    return { cls, widthM, points };
};

describe('planCrossingFurniture', () => {
    // A track along x, a 7 m road along z across it at the origin.
    const parts = [
        line(RoadClass.Rail, 5, -100, 0, 100, 0),
        line(RoadClass.Secondary, 7, 0, -100, 0, 100),
        line(RoadClass.Crossing, 7, -4, 0, 4, 0),
    ];

    it('furnishes both approaches, on the right of the traffic, clear of the track', () => {
        const stats = { crossings: 0, sides: 0 };
        const boxes = planCrossingFurniture(parts, surface, stats);
        assert.deepEqual(stats, { crossings: 1, sides: 2 });
        const posts = boxes.filter(b => b.role === BridgeRole.SignPost);
        assert.equal(posts.length, 2);
        for (const p of posts) {
            const [x, h, z] = p.centre;
            // Beside the road's edge, past the track bed, standing on the ground.
            assert.ok(Math.abs(x) > 3.5 && Math.abs(x) < 5.5, `post x ${x}`);
            assert.ok(Math.abs(z) > 4, `post z ${z}`);
            assert.ok(Math.abs(h - p.half[1] - 10) < 1e-9);
            // Traffic from the south (z < 0) drives north; its right is east (x > 0).
            assert.equal(Math.sign(x), -Math.sign(z));
        }
        // Both colours of stripe, on the boards and the arms.
        assert.ok(boxes.some(b => b.role === BridgeRole.SignRed));
        assert.ok(boxes.some(b => b.role === BridgeRole.SignWhite));
    });

    it('furnishes a crossing over several tracks once, outside the outermost', () => {
        const multi = [
            ...parts,
            line(RoadClass.Rail, 5, -100, 5, 100, 5),
            line(RoadClass.Crossing, 7, -4, 5, 4, 5),
        ];
        const stats = { crossings: 0, sides: 0 };
        const boxes = planCrossingFurniture(multi, surface, stats);
        assert.equal(stats.crossings, 1);
        const posts = boxes.filter(b => b.role === BridgeRole.SignPost).map(b => b.centre[2]);
        assert.ok(Math.min(...posts) < -2.5 && Math.max(...posts) > 7.5, posts.join(','));
    });

    it('moves furniture off a siding that runs where it would stand', () => {
        // A siding 6 m south of the crossing, far enough not to be grouped
        // with it here (it has no crossing of its own), right where the
        // southern barrier would go.
        const withSiding = [...parts, line(RoadClass.RailService, 5, -100, -6, 100, -6)];
        const boxes = planCrossingFurniture(withSiding, surface);
        for (const b of boxes.filter(q => q.role === BridgeRole.SignPost)) {
            assert.ok(Math.abs(b.centre[2] - -6) >= 3.2, `post at z ${b.centre[2]} on the siding`);
        }
    });

    it('follows a road that bends at the crossing, keeping off it', () => {
        // The road comes up from the south, crosses the track, then bends
        // sharply east 8 m on: a straight-line offset lands back on it.
        const bent = [
            line(RoadClass.Rail, 5, -100, 0, 100, 0),
            line(RoadClass.Secondary, 7, 0, -100, 0, 8, 100, 20),
            line(RoadClass.Crossing, 7, -4, 0, 4, 0),
        ];
        const boxes = planCrossingFurniture(bent, surface);
        const road = [{ x: 0, z: -100 }, { x: 0, z: 8 }, { x: 100, z: 20 }];
        const off = (x: number, z: number) => Math.min(...[0, 1].map(i => {
            const a = road[i], b = road[i + 1];
            const dx = b.x - a.x, dz = b.z - a.z;
            const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
            return Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
        }));
        const posts = boxes.filter(b => b.role === BridgeRole.SignPost);
        assert.ok(posts.length >= 1);
        for (const b of posts) {
            assert.ok(off(b.centre[0], b.centre[2]) >= 3.5 + 0.5 - 1e-6, `post at ${b.centre[0].toFixed(1)},${b.centre[2].toFixed(1)}`);
        }
    });

    it('stands on the lifted level the strokes are drawn at', () => {
        const lifted = planCrossingFurniture(parts, surface, undefined, 0.7);
        const post = lifted.find(b => b.role === BridgeRole.SignPost)!;
        assert.ok(Math.abs(post.centre[1] - post.half[1] - 10.7) < 1e-9);
    });

    it('leaves a tile without crossings bare, and builds closed boxes', () => {
        assert.deepEqual(planCrossingFurniture(parts.slice(0, 2), surface), []);
        const mesh = buildBoxMesh(planCrossingFurniture(parts, surface), IDENTITY_FRAME);
        assert.equal(mesh.triangleCount % 12, 0, 'six faces of two triangles per box');
        assert.ok(mesh.triangleCount > 0);
    });
});

describe('pushClear', () => {
    it('moves a point out of every drawn stroke it stands in, straight away from it', () => {
        const road = { a: { x: -50, z: 0 }, b: { x: 50, z: 0 }, clearance: 3.4 };
        const track = { a: { x: 0, z: -50 }, b: { x: 0, z: 50 }, clearance: 3.2 };
        const p = pushClear({ x: 10, z: 1.5 }, [road]);
        assert.ok(Math.abs(p.x - 10) < 1e-9 && p.z >= 3.4, `${p.x},${p.z}`);
        // Pushed off the road onto the track, and off that again.
        const q = pushClear({ x: 1, z: 2 }, [road, track]);
        assert.ok(Math.abs(q.z) >= 3.4 - 1e-6 && Math.abs(q.x) >= 3.2 - 1e-6, `${q.x},${q.z}`);
        assert.deepEqual(pushClear({ x: 10, z: 8 }, [road, track]), { x: 10, z: 8 });
    });
});


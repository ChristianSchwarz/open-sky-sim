import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { XZ, smoothRoad } from './roadSpline';

/** Largest distance from any sample of `line` to the polyline `path`. */
function maxOffPath(line: readonly XZ[], path: readonly XZ[]): number {
    let worst = 0;
    for (const p of line) {
        let best = Infinity;
        for (let i = 0; i + 1 < path.length; i++) {
            const a = path[i], b = path[i + 1];
            const dx = b.x - a.x, dz = b.z - a.z;
            const len2 = dx * dx + dz * dz;
            const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
            best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t));
        }
        worst = Math.max(worst, best);
    }
    return worst;
}

const has = (line: readonly XZ[], p: XZ) => line.some(q => Math.hypot(q.x - p.x, q.z - p.z) < 1e-9);

describe('smoothRoad', () => {
    it('leaves a straight road as its two ends', () => {
        const out = smoothRoad([{ x: 0, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }, { x: 400, z: 0 }]);
        // Collinear: every span is its own chord, so nothing is added.
        assert.equal(out.length, 4);
        assert.ok(out.every(p => Math.abs(p.z) < 1e-9));
    });

    it('rounds a gentle bend, through every mapped node, within the tolerance of a true arc', () => {
        // Nodes every 10 degrees on a 200 m radius: a motorway curve as the
        // leaf simplifier leaves it, each segment within 0.76 m of the arc.
        const r = 200;
        const nodes: XZ[] = [];
        for (let deg = 0; deg <= 90; deg += 10) {
            const a = (deg * Math.PI) / 180;
            nodes.push({ x: r * Math.sin(a), z: r - r * Math.cos(a) });
        }
        const out = smoothRoad(nodes, 0.5);
        assert.ok(out.length > nodes.length, `no samples added (${out.length})`);
        for (const n of nodes) {
            assert.ok(has(out, n), `mapped node ${n.x},${n.z} missing`);
        }
        // The polyline cut the arc by r(1 - cos 5deg) = 0.76 m. Inside, the
        // curve follows the arc within the tolerance; the two end spans leave
        // along their end segments (see smoothRoad), which costs them up to
        // the polyline's own error and no more.
        const off = (p: XZ) => Math.abs(Math.hypot(p.x, p.z - r) - r);
        const first = out.findIndex(p => Math.hypot(p.x - nodes[1].x, p.z - nodes[1].z) < 1e-9);
        const last = out.findIndex(p => Math.hypot(p.x - nodes[nodes.length - 2].x, p.z - nodes[nodes.length - 2].z) < 1e-9);
        for (let i = first; i <= last; i++) {
            assert.ok(off(out[i]) < 0.6, `interior sample ${off(out[i]).toFixed(2)} m off the arc`);
        }
        for (const p of out) {
            assert.ok(off(p) < 0.8, `end sample ${off(p).toFixed(2)} m off the arc`);
        }
    });

    it('leaves a span straight where its curve would stray past the offset cap', () => {
        // Nodes 20 degrees apart on 200 m: each span's curve sits 3 m off
        // its segment, past the 1.5 m a leaf node may move. Rounding these is
        // how straight roads meeting at shallow angles got cut by 30 m.
        const r = 200;
        const nodes: XZ[] = [];
        for (let deg = 0; deg <= 80; deg += 20) {
            const a = (deg * Math.PI) / 180;
            nodes.push({ x: r * Math.sin(a), z: r - r * Math.cos(a) });
        }
        assert.equal(smoothRoad(nodes, 0.5).length, nodes.length);
        // With the cap lifted the same nodes do get rounded.
        assert.ok(smoothRoad(nodes, 0.5, 60, 10).length > nodes.length);
    });

    it('keeps a right-angle junction sharp', () => {
        const nodes = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }];
        const out = smoothRoad(nodes);
        assert.ok(has(out, { x: 100, z: 0 }));
        // Each leg stays on its own straight: nothing cuts the corner.
        assert.equal(maxOffPath(out, nodes) < 1e-9, true);
        assert.equal(out.length, 3);
    });

    it('does not overshoot on unevenly spaced nodes', () => {
        // A 3 m hop then 300 m runs with a small kink. Centripetal rules out
        // loops and cusps, not every bulge: easing into the kink rises a
        // metre and a half over a 300 m span, which is what a road through
        // those nodes does. The uniform variant swings several times further.
        const nodes = [{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 300, z: 20 }, { x: 600, z: 20 }];
        const out = smoothRoad(nodes, 0.5);
        const hull = { minZ: Math.min(...nodes.map(n => n.z)), maxZ: Math.max(...nodes.map(n => n.z)) };
        for (const p of out) {
            assert.ok(p.z >= hull.minZ - 2 && p.z <= hull.maxZ + 2, `sample at z ${p.z.toFixed(2)} overshoots`);
        }
        // And it never runs backwards along the road.
        for (let i = 0; i + 1 < out.length; i++) {
            assert.ok(out[i + 1].x > out[i].x, `sample ${i + 1} doubles back`);
        }
    });

    it('leaves each end along its own end segment, so clipped pieces meet without a kink', () => {
        const nodes = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 200, z: 30 }, { x: 300, z: 30 }];
        const out = smoothRoad(nodes, 0.1);
        const dir = (a: XZ, b: XZ) => Math.atan2(b.z - a.z, b.x - a.x);
        assert.ok(Math.abs(dir(out[0], out[1])) < 0.02, 'start tangent strays from the first segment');
        const n = out.length;
        assert.ok(Math.abs(dir(out[n - 2], out[n - 1])) < 0.02, 'end tangent strays from the last segment');
    });

    it('drops duplicate nodes and passes short lines through', () => {
        assert.deepEqual(smoothRoad([{ x: 1, z: 1 }, { x: 1, z: 1 }, { x: 5, z: 1 }]), [{ x: 1, z: 1 }, { x: 5, z: 1 }]);
        assert.deepEqual(smoothRoad([{ x: 1, z: 1 }]), [{ x: 1, z: 1 }]);
    });
});

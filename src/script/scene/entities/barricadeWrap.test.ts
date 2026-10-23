import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import {
    barricadeCatches,
    BARRICADE_DECK_Y,
    BARRICADE_HALF_SPAN_M,
    BARRICADE_HEIGHT_M,
    BARRICADE_LOCAL_Z,
    BARRICADE_MID_X,
    BARRICADE_STRAP_COUNT,
    buildBarricadeField,
} from './barricadeSpec';
import { buildAirframeProfile, buildBarricadeShape } from './barricadeWrap';

/** Swept wings on a box fuselage, body frame (+Z forward), span 12 m. */
function testAirframe(): number[] {
    const t: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
        t.push(...a, ...b, ...c, ...a, ...c, ...d);
    };
    for (const s of [-1, 1]) {
        // root LE, tip LE, tip TE, root TE
        quad([s * 1, 0, 1.5], [s * 6, 0, -1.5], [s * 6, 0, -3], [s * 1, 0, -2]);
    }
    const box = [[-1, -0.8], [1, 0.8]];
    const [x0, y0] = box[0];
    const [x1, y1] = box[1];
    const z0 = -6, z1 = 6;
    quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]); // top
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // bottom
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // nose
    return t;
}

const polylineLength = (pts: THREE.Vector3[]) => {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += pts[i - 1].distanceTo(pts[i]);
    return len;
};


const GEAR: [number, number, number][] = [[0, -1.7, 3], [-1.5, -1.7, -1], [1.5, -1.7, -1]];
const profile = buildAirframeProfile({ triangles: testAirframe() }, GEAR);
const BOW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

function caughtAt(pastNet: number, x = BARRICADE_MID_X) {
    const position = new THREE.Vector3(x, BARRICADE_DECK_Y + 1.7, BARRICADE_LOCAL_Z - pastNet);
    return buildBarricadeShape(1, true, { pose: { position, quaternion: BOW }, profile });
}

describe('barricade profile', () => {
    it('finds both leading edges root to tip and the spine between them', () => {
        const [a, b] = profile.leadingEdge;
        assert.ok(a.length >= 6 && b.length >= 6, `${a.length}/${b.length} edge samples`);
        assert.ok(a[0].x > a[a.length - 1].x && b[0].x < b[b.length - 1].x, 'ordered root to tip');
        // Swept: the tip is aft of the root.
        assert.ok(a[a.length - 1].z < a[0].z - 2);
        assert.ok(profile.crest.some(p => p.y > 0.7), 'crest rides the fuselage top');
    });
});

describe('barricade shape', () => {
    it('draws nothing but stanchions while stowed', () => {
        const s = buildBarricadeShape(0, true);
        assert.equal(s.upper.length + s.lower.length + s.verticals.length, 0);
        assert.ok(Math.abs(s.stanchions[0].top.y - BARRICADE_DECK_Y) < 1e-9, 'stanchion lies flat');
    });

    it('hangs a sagging curtain between the stanchion tops when rigged', () => {
        const s = buildBarricadeShape(1, true);
        assert.ok(Math.abs(s.stanchions[1].top.y - (BARRICADE_DECK_Y + BARRICADE_HEIGHT_M)) < 1e-9);
        const mid = s.upper[Math.floor(s.upper.length / 2)];
        const sag = BARRICADE_DECK_Y + BARRICADE_HEIGHT_M - mid.y;
        assert.ok(sag > 0.5 && sag < 3, `upper strap sags ${sag.toFixed(2)} m`);
        assert.equal(s.verticals.length, BARRICADE_STRAP_COUNT);
        for (const v of s.verticals) {
            assert.ok(Math.abs(v[0].z - BARRICADE_LOCAL_Z) < 1e-9, 'flat curtain across the deck');
        }
    });

    it('wraps the webbing on the wings of a caught aircraft', () => {
        const s = caughtAt(20);
        const deck = BARRICADE_DECK_Y;
        for (const p of [...s.upper, ...s.lower, ...s.verticals.flat()]) {
            assert.ok(p.y >= deck, 'below the deck');
        }
        // Straps hooked on each wing.
        const hooked = s.verticals.filter((_, j) => s.slung[j]);
        assert.ok(hooked.some(v => v[1].x < BARRICADE_MID_X - 2), 'nothing hooked on the port wing');
        assert.ok(hooked.some(v => v[1].x > BARRICADE_MID_X + 2), 'nothing hooked on the starboard wing');
        for (const v of hooked) {
            // Round the edge: at wing height, well ahead of where the upper strap lies.
            assert.ok(v.slice(1, -1).some(p => Math.abs(p.y - (deck + 1.7)) < 0.1 && p.z < v[0].z - 1),
                'sling never reaches the leading edge');
        }
        const [cL, cR] = s.cables;
        // Every strap runs to the joint on its own side, where the lower
        // strap meets the purchase cable.
        s.verticals.forEach((v, j) => {
            const joint = j < s.verticals.length / 2 ? s.lower[0] : s.lower[s.lower.length - 1];
            assert.ok(v[v.length - 1].distanceTo(joint) < 1e-6, `strap ${j} not at its joint`);
            assert.ok(joint.distanceTo(cR[1]) < 1e-6 || joint.distanceTo(cL[1]) < 1e-6, 'joint off the purchase cable');
        });
        // Shackles trail aft of the wingtips toward their sheaves.
        assert.ok(cL[1].z > BARRICADE_LOCAL_Z - 20 && cL[1].x < BARRICADE_MID_X - 6);
        assert.ok(cR[1].z > BARRICADE_LOCAL_Z - 20 && cR[1].x > BARRICADE_MID_X + 6);
        assert.ok(Math.abs(cL[0].x - (BARRICADE_MID_X - BARRICADE_HALF_SPAN_M)) < 1e-9);
    });

    it('lays the upper strap on the wing, never through it', () => {
        const s = caughtAt(20);
        const wingY = BARRICADE_DECK_Y + 1.7;
        const onWing = s.upper.filter(p => Math.abs(p.x - BARRICADE_MID_X) > 2 && Math.abs(p.x - BARRICADE_MID_X) < 5.8);
        assert.ok(onWing.length >= 6, `${onWing.length} points on the wings`);
        for (const p of onWing) {
            assert.ok(p.y > wingY && p.y < wingY + 0.2, `strap at y=${(p.y - BARRICADE_DECK_Y).toFixed(2)}`);
        }
        const hooked = s.verticals.filter((_, j) => s.slung[j]);
        assert.ok(hooked.filter(v => v[1].x < BARRICADE_MID_X).length >= 2, 'port wing hooks');
        assert.ok(hooked.filter(v => v[1].x > BARRICADE_MID_X).length >= 2, 'starboard wing hooks');
    });

    it('folds each engaging strap over the wing, and the glove under it', () => {
        const s = caughtAt(20);
        const wingY = BARRICADE_DECK_Y + 1.7;
        const hooked = s.verticals.filter((_, j) => s.slung[j]);
        assert.ok(hooked.length >= 4);
        for (const v of hooked) {
            // From the upper strap forward over the top skin, and only then down.
            const below = v.findIndex(p => p.y < wingY - 0.01);
            const over = below < 0 ? v : v.slice(0, below);
            assert.ok(over.some(p => p.z < v[0].z - 1), 'goes down before reaching forward over the wing');
        }
        assert.ok(s.glove.some(g => g.some(p => p.y < wingY - 0.03)), 'nothing under the wing');
    });

    it('keeps the free tail off the wingtip taut', () => {
        const s = caughtAt(10);
        const u = s.upper;
        // Between the port shackle and the port tip: a slight droop at most.
        const tipIdx = u.findIndex(p => p.x > BARRICADE_MID_X - 6.2);
        const a = u[0];
        const b = u[tipIdx];
        let droop = 0;
        for (let i = 1; i < tipIdx; i++) {
            const t = (u[i].x - a.x) / (b.x - a.x);
            droop = Math.max(droop, a.y + (b.y - a.y) * t - u[i].y);
        }
        assert.ok(droop > 0 && droop < 0.4, `droop ${droop.toFixed(2)} m`);
    });

    it('holds the lower strap off the deck, against the front of the gear', () => {
        const s = caughtAt(20);
        // Off the deck everywhere, ends included.
        for (const p of s.lower) assert.ok(p.y > BARRICADE_DECK_Y + 0.4, `lower strap ${(p.y - BARRICADE_DECK_Y).toFixed(2)} m up`);
        // Nose gear at body z=+3 → local z = CG − 3; the strap is just ahead of it.
        const cgZ = BARRICADE_LOCAL_Z - 20;
        const nose = s.lower.reduce((m, p) => (p.z < m.z ? p : m));
        assert.ok(nose.z < cgZ - 3 && nose.z > cgZ - 3.5, `lower strap at z=${nose.z.toFixed(2)}`);
    });

    it('draws every vertical strap three times its rigged length once caught', () => {
        const rigged = buildBarricadeShape(1, true).verticals.map(polylineLength);
        for (const past of [5, 20, 40]) {
            const caught = caughtAt(past).verticals;
            caught.forEach((v, j) => {
                const len = polylineLength(v);
                const want = rigged[j] * 3;
                // Never short of three times the rigged length (a few per cent);
                // longer only where its joint is out of reach and it runs taut.
                assert.ok(len > want * 0.95, `strap ${j} ${len.toFixed(2)} m, want ${want.toFixed(2)} at ${past} m`);
                if (len > want * 1.05) {
                    // Out of reach: the last run goes straight to the joint, no bow.
                    assert.ok(v[v.length - 2].distanceTo(v[v.length - 1]) > 0.5, `strap ${j} long but not taut at ${past} m`);
                }
            });
        }
    });

    it('lays spare strap on the deck in folds, never a hairpin', () => {
        const floor = BARRICADE_DECK_Y + 0.05;
        for (const past of [5, 20, 40]) {
            caughtAt(past).verticals.forEach((v, j) => {
                for (let i = 1; i + 1 < v.length; i++) {
                    if (v[i - 1].y > floor || v[i].y > floor || v[i + 1].y > floor) continue;
                    const a = v[i].clone().sub(v[i - 1]);
                    const b = v[i + 1].clone().sub(v[i]);
                    if (a.lengthSq() < 1e-8 || b.lengthSq() < 1e-8) continue;
                    const turn = (a.angleTo(b) * 180) / Math.PI;
                    assert.ok(turn < 120, `strap ${j} turns ${turn.toFixed(0)} deg on the deck at ${past} m`);
                }
            });
        }
    });

    it('hangs nothing in the air once the upper strap is gone', () => {
        // The test airframe's highest skin is its spine, 0.8 m over the wing.
        const top = BARRICADE_DECK_Y + 1.7 + 0.8 + 0.15;
        for (const past of [5, 20, 40]) {
            caughtAt(past).verticals.forEach((v, j) => {
                for (const p of v) assert.ok(p.y < top, `strap ${j} ${(p.y - BARRICADE_DECK_Y).toFixed(2)} m up at ${past} m`);
            });
        }
    });

    it('never runs a caught strap through the wing', () => {
        const past = 20;
        const pos = new THREE.Vector3(BARRICADE_MID_X, BARRICADE_DECK_Y + 1.7, BARRICADE_LOCAL_Z - past);
        const s = caughtAt(past);
        // The test wing is the plane y = 0 of the body frame; the bow turns body x and z round.
        const inWing = (p: THREE.Vector3) => {
            const bx = Math.abs(p.x - pos.x);
            const bz = -(p.z - pos.z);
            if (bx < 1.05 || bx > 5.95) return false;
            const le = 1.5 - (3 * (bx - 1)) / 5;
            const te = -2 - (bx - 1) / 5;
            return bz < le - 0.05 && bz > te + 0.05;
        };
        s.verticals.forEach((v, j) => {
            for (let i = 1; i < v.length; i++) {
                const a = v[i - 1].y - pos.y;
                const b = v[i].y - pos.y;
                if (a * b >= 0) continue;
                const cross = v[i - 1].clone().lerp(v[i], a / (a - b));
                assert.ok(!inWing(cross), `strap ${j} goes through the wing at x=${(cross.x - pos.x).toFixed(2)}`);
            }
        });
    });

    it('stays sane when the aircraft is caught off centre', () => {
        const s = caughtAt(30, BARRICADE_MID_X + 8);
        const pts = [...s.upper, ...s.lower, ...s.verticals.flat()];
        assert.ok(pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)));
        assert.equal(s.verticals.length, BARRICADE_STRAP_COUNT);
    });
});

/**
 * A cranked arrow like the F-16XL: a long strake reaching far forward beside
 * the cockpit, then the main wing swept hard back to the tips. A taut hull
 * from the tips to the strake bridged clean over this wing.
 */
function crankedArrow(): number[] {
    const t: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
        t.push(...a, ...b, ...c, ...a, ...c, ...d);
    };
    for (const s of [-1, 1]) {
        quad([s * 0.9, 0, 5], [s * 2, 0, 1], [s * 2, 0, -4], [s * 0.9, 0, -4]); // strake + inner wing
        quad([s * 2, 0, 1], [s * 5, 0, -3], [s * 5, 0, -4.5], [s * 2, 0, -4]); // outer wing
    }
    quad([-0.9, 0.9, -7], [0.9, 0.9, -7], [0.9, 0.9, 7], [-0.9, 0.9, 7]); // fuselage top
    return t;
}

describe('barricade wrap on a cranked delta', () => {
    const arrow = buildAirframeProfile({ triangles: crankedArrow() }, GEAR);
    const position = new THREE.Vector3(BARRICADE_MID_X, BARRICADE_DECK_Y + 1.7, BARRICADE_LOCAL_Z - 20);
    const s = buildBarricadeShape(1, true, { pose: { position, quaternion: BOW }, profile: arrow });
    const wingY = BARRICADE_DECK_Y + 1.7;

    it('lays the upper strap on the outer wing instead of bridging over it', () => {
        const onOuter = s.upper.filter(p => {
            const ax = Math.abs(p.x - BARRICADE_MID_X);
            return ax > 2.6 && ax < 4.6;
        });
        assert.ok(onOuter.length >= 4, `${onOuter.length} points over the outer wings`);
        for (const p of onOuter) {
            // Outer leading edge in body z: 1 - 4(ax - 2)/3; local z = CG z - body z.
            const ax = Math.abs(p.x - BARRICADE_MID_X);
            const edgeZ = position.z - (1 - (4 * (ax - 2)) / 3);
            assert.ok(p.y > wingY && p.y < wingY + 0.2, `strap ${(p.y - wingY).toFixed(2)} m off the wing`);
            // Folded back over the wing, up to 2 m behind the edge where the chord allows.
            assert.ok(p.z > edgeZ && p.z < edgeZ + 2.05, `strap ${(p.z - edgeZ).toFixed(2)} m behind the edge`);
        }
    });

    it('gloves both wings tight, over and under', () => {
        const sleeves = s.glove.filter(g => g.some(p => p.y > wingY) && g.some(p => p.y < wingY));
        const edgeSamples = arrow.leadingEdge[0].length + arrow.leadingEdge[1].length;
        assert.equal(sleeves.length, edgeSamples, 'a sleeve at every edge sample');
        for (const g of sleeves) {
            // Tight: nothing on the sleeve stands more than a few cm off the plate wing.
            for (const p of g) assert.ok(Math.abs(p.y - wingY) < 0.06, `sleeve ${(p.y - wingY).toFixed(3)} m off the skin`);
        }
        const under = s.glove.filter(g => g.every(p => p.y < wingY));
        const over = s.glove.filter(g => g.every(p => p.y > wingY));
        assert.equal(under.length, 4, 'two under-wing bands per side');
        assert.equal(over.length, 2, 'one top-skin band per side');
        for (const b of [...under, ...over]) {
            assert.ok(b.length >= 4);
            const xs = b.map(p => p.x - BARRICADE_MID_X);
            assert.ok(xs.every(x => Math.sign(x) === Math.sign(xs[0])), 'band crosses the fuselage');
        }
    });

    it('keeps every wing sling sewn at its upper station', () => {
        // The same fraction of the way along each strap as when rigged.
        const at = (pts: THREE.Vector3[], u: number) => {
            let total = 0;
            for (let i = 1; i < pts.length; i++) total += pts[i - 1].distanceTo(pts[i]);
            let left = u * total;
            for (let i = 1; i < pts.length; i++) {
                const seg = pts[i - 1].distanceTo(pts[i]);
                if (left <= seg) return new THREE.Vector3().lerpVectors(pts[i - 1], pts[i], seg > 0 ? left / seg : 0);
                left -= seg;
            }
            return pts[pts.length - 1].clone();
        };
        // A wing sling still starts where the upper strap lay.
        const n = s.verticals.length;
        s.verticals.forEach((v, j) => {
            const u = (j + 1) / (n + 1);
            if (s.slung[j]) assert.ok(v[0].distanceTo(at(s.upper, u)) < 1e-6, `strap ${j} left its upper station`);
        });
    });

    it('draws no glove until something is caught', () => {
        assert.equal(buildBarricadeShape(1, true).glove.length, 0);
    });

    it('slings straps round both outer wings', () => {
        // Each sling's turn round the edge: its foremost point at wing height.
        const slung = s.verticals.filter((_, j) => s.slung[j])
            .map(v => v.slice(1, -1).filter(p => Math.abs(p.y - wingY) < 0.1).reduce((m, p) => (p.z < m.z ? p : m)));
        assert.ok(slung.filter(p => p.x - BARRICADE_MID_X < -2.4).length >= 2, 'port outer wing');
        assert.ok(slung.filter(p => p.x - BARRICADE_MID_X > 2.4).length >= 2, 'starboard outer wing');
    });
});

describe('barricadeCatches', () => {
    it('follows the carrier yaw', () => {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
        const f = buildBarricadeField(100, 0, 200, q, true, 1);
        const before = f.center.clone().addScaledVector(f.deckAxis, -1).addScaledVector(f.upAxis, 2);
        const after = f.center.clone().addScaledVector(f.deckAxis, 1).addScaledVector(f.upAxis, 2);
        const vel = f.deckAxis.clone().multiplyScalar(50);
        assert.equal(barricadeCatches(f, before, after, vel, new THREE.Vector3()), true);
        assert.equal(barricadeCatches(f, after, before, vel.clone().negate(), new THREE.Vector3()), false);
        // A ship steaming at the same speed has nothing to catch.
        assert.equal(barricadeCatches(f, before, after, vel, vel), false);
    });
});

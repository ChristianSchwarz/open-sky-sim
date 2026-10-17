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
        const hooked = s.verticals.filter(v => v.length > 2);
        assert.ok(hooked.some(v => v[1].x < BARRICADE_MID_X - 2), 'nothing hooked on the port wing');
        assert.ok(hooked.some(v => v[1].x > BARRICADE_MID_X + 2), 'nothing hooked on the starboard wing');
        for (const v of hooked) {
            // Round the edge: ahead of where the upper strap lies, at wing height.
            const nose = v.slice(1, -1).reduce((m, p) => (p.z < m.z ? p : m));
            assert.ok(nose.z < v[0].z, 'sling never reaches the leading edge');
            assert.ok(Math.abs(nose.y - (deck + 1.7)) < 0.3, `edge at y=${nose.y.toFixed(2)}`);
        }
        // Nothing threads the fuselage.
        for (const v of s.verticals) {
            assert.ok(Math.abs(v[0].x - BARRICADE_MID_X) >= profile.fuselageHalfWidth - 1e-6);
        }
        // Shackles trail aft of the wingtips toward their sheaves.
        const [cL, cR] = s.cables;
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
        const hooked = s.verticals.filter(v => v.length > 2);
        assert.ok(hooked.filter(v => v[1].x < BARRICADE_MID_X).length >= 2, 'port wing hooks');
        assert.ok(hooked.filter(v => v[1].x > BARRICADE_MID_X).length >= 2, 'starboard wing hooks');
    });

    it('slings each hooked strap over and under the wing', () => {
        const s = caughtAt(20);
        const wingY = BARRICADE_DECK_Y + 1.7;
        const hooked = s.verticals.filter(v => v.length > 2);
        assert.ok(hooked.length >= 4);
        for (const v of hooked) {
            const nose = v.slice(1, -1).reduce((m, p) => (p.z < m.z ? p : m));
            // Behind the edge (aft is +z here) and within the wing's chord.
            const onChord = v.filter(p => p.z > nose.z + 0.05 && p.z < nose.z + 1.3);
            const over = onChord.filter(p => p.y > wingY + 0.03);
            const under = onChord.filter(p => p.y < wingY - 0.03);
            assert.ok(over.length >= 1, `nothing over the wing at x=${(nose.x - BARRICADE_MID_X).toFixed(1)}`);
            assert.ok(under.length >= 2, `nothing under the wing at x=${(nose.x - BARRICADE_MID_X).toFixed(1)}`);
            // Over first, then round the edge, then under: the strap does not cut through.
            const iNose = v.indexOf(nose);
            assert.ok(v.slice(1, iNose).every(p => p.y >= wingY), 'top run dips into the wing');
            assert.ok(v.slice(iNose + 1, -1).every(p => p.y <= wingY), 'bottom run rises into the wing');
        }
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

    it('traps the gear with the lower strap', () => {
        const s = caughtAt(20);
        const nose = s.lower.reduce((m, p) => (p.z < m.z ? p : m));
        // Nose gear at body z=+3 → local z = CG − 3; the strap is just ahead of it.
        const cgZ = BARRICADE_LOCAL_Z - 20;
        assert.ok(nose.z < cgZ - 3 && nose.z > cgZ - 3.5, `lower strap at z=${nose.z.toFixed(2)}`);
        assert.ok(nose.y < BARRICADE_DECK_Y + 1, 'on the leg, not the fuselage');
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

    it('draws no glove until something is caught', () => {
        assert.equal(buildBarricadeShape(1, true).glove.length, 0);
    });

    it('slings straps round both outer wings', () => {
        const slung = s.verticals.filter(v => v.length > 2).map(v => v.slice(1, -1).reduce((m, p) => (p.z < m.z ? p : m)));
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

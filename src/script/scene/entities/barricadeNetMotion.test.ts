import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { BARRICADE_DECK_Y, BARRICADE_HEIGHT_M, BARRICADE_LOCAL_Z, BARRICADE_MID_X } from './barricadeSpec';
import { BarricadeNetMotion, resample } from './barricadeNetMotion';
import { buildAirframeProfile, buildBarricadeShape } from './barricadeWrap';

/** Swept wings on a box fuselage, body frame (+Z forward), span 12 m. */
function testAirframe(): number[] {
    const t: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
        t.push(...a, ...b, ...c, ...a, ...c, ...d);
    };
    for (const s of [-1, 1]) quad([s, 0, 1.5], [s * 6, 0, -1.5], [s * 6, 0, -3], [s, 0, -2]);
    quad([-1, 0.8, -6], [1, 0.8, -6], [1, 0.8, 6], [-1, 0.8, 6]);
    return t;
}

const profile = buildAirframeProfile({ triangles: testAirframe() }, [[0, -1.7, 3], [-1.5, -1.7, -1], [1.5, -1.7, -1]]);
const BOW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const HALF_SPAN = 6;

function at(pastNet: number) {
    const position = new THREE.Vector3(BARRICADE_MID_X, BARRICADE_DECK_Y + 1.7, BARRICADE_LOCAL_Z - pastNet);
    return { position, shape: buildBarricadeShape(1, true, { pose: { position, quaternion: BOW }, profile }) };
}

function caught(): { motion: BarricadeNetMotion; position: THREE.Vector3; target: ReturnType<typeof at>['shape'] } {
    const rest = buildBarricadeShape(1, true);
    const { position, shape } = at(4);
    const motion = new BarricadeNetMotion();
    motion.begin(rest, shape, position, new THREE.Vector3(0, 0, -60), HALF_SPAN);
    return { motion, position, target: shape };
}

describe('barricade net motion', () => {
    it('picks the webbing up from the curtain instead of snapping it on', () => {
        const { motion, position, target } = caught();
        const drawn = motion.step(0, target, position, HALF_SPAN);
        // The free end is still up at the stanchion head, not down at its shackle.
        assert.ok(drawn.upper[0].y > BARRICADE_DECK_Y + BARRICADE_HEIGHT_M - 1.5, `end at y=${(drawn.upper[0].y - BARRICADE_DECK_Y).toFixed(2)}`);
        assert.ok(drawn.upper[0].distanceTo(target.upper[0]) > 3);
        // The middle, on the wings, is already where the wrap has it.
        const mid = Math.floor(drawn.upper.length / 2);
        assert.ok(drawn.upper[mid].distanceTo(resample(target.upper, drawn.upper.length)[mid]) < 0.05);
    });

    it('settles onto the wrap once the aircraft is still', () => {
        const { motion, position, target } = caught();
        let drawn = motion.step(0, target, position, HALF_SPAN);
        for (let i = 0; i < 60 * 6; i++) drawn = motion.step(1 / 60, target, position, HALF_SPAN);
        const want = resample(target.upper, drawn.upper.length);
        const worst = Math.max(...drawn.upper.map((p, i) => p.distanceTo(want[i])));
        assert.ok(worst < 0.05, `still ${worst.toFixed(3)} m off`);
    });

    it('swings the loose webbing forward while the aircraft decelerates', () => {
        const motion = new BarricadeNetMotion();
        let v = 50;
        let past = 4;
        let { position, shape } = at(past);
        motion.begin(buildBarricadeShape(1, true), shape, position, new THREE.Vector3(0, 0, -v), HALF_SPAN);
        let lead = 0;
        for (let i = 0; i < 60; i++) {
            v = Math.max(0, v - 30 / 60);
            past += v / 60;
            ({ position, shape } = at(past));
            const drawn = motion.step(1 / 60, shape, position, HALF_SPAN);
            // Forward is −z: how far the free end runs ahead of where the wrap puts it.
            if (i > 30) lead = Math.max(lead, resample(shape.upper, drawn.upper.length)[0].z - drawn.upper[0].z);
        }
        assert.ok(lead > 0.2, `tail led by only ${lead.toFixed(2)} m`);
    });

    it('never puts webbing through the deck', () => {
        const { motion, position, target } = caught();
        for (let i = 0; i < 120; i++) {
            const drawn = motion.step(1 / 60, target, position, HALF_SPAN);
            for (const p of [...drawn.upper, ...drawn.lower, ...drawn.verticals.flat()]) {
                assert.ok(p.y >= BARRICADE_DECK_Y, `y=${p.y}`);
            }
        }
    });
});

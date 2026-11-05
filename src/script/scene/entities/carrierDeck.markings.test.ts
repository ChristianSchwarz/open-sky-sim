import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ANGLED_DECK_AXIS,
    ANGLED_DECK_RIGHT,
    HOOK_TOUCHDOWN_STATION_M,
    KUZ_DECK_Y,
    TAKEOFF_POSITIONS,
    angledDeckCoords,
    angledDeckPoint,
    CARRIER_GLIDESLOPE_DEG,
} from './carrierDeckLayout';
import { carrierDeckMarkings } from './carrierDeckMarkings';
import { CarrierDeckSurface } from './carrierDeckSurface';
import { LUNA_DEG_PER_CELL, lunaCell, lunaCellForEye } from './carrierLights';
import * as THREE from 'three';
import {
    CARRIER_CG_ABOVE_HOOK_M,
    CARRIER_EYE_ABOVE_HOOK_M,
    computeIlsDeviation,
} from './overlay/approachAids';

/** A deck plate from (x0, z0) to (x1, z1) at height y, as two triangles, either winding. */
function plate(x0: number, z0: number, x1: number, z1: number, y: number, flip = false): number[] {
    const a = [x0, y, z0], b = [x1, y, z0], c = [x1, y, z1], d = [x0, y, z1];
    return flip ? [...a, ...c, ...b, ...a, ...d, ...c] : [...a, ...b, ...c, ...a, ...c, ...d];
}

function area(xyz: number[]): number {
    let sum = 0;
    for (let i = 0; i < xyz.length; i += 9) {
        const ax = xyz[i], az = xyz[i + 2], bx = xyz[i + 3], bz = xyz[i + 5], cx = xyz[i + 6], cz = xyz[i + 8];
        sum += Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
    }
    return sum;
}

describe('carrier deck layout', () => {
    it('runs the angled deck 7° to port of the bow', () => {
        assert.ok(Math.abs(Math.atan2(-ANGLED_DECK_AXIS.x, -ANGLED_DECK_AXIS.z) * 180 / Math.PI - 7) < 1e-9);
        assert.ok(Math.abs(ANGLED_DECK_AXIS.x * ANGLED_DECK_RIGHT.x + ANGLED_DECK_AXIS.z * ANGLED_DECK_RIGHT.z) < 1e-12);
        // Starboard of the axis is +X, the island's side.
        assert.ok(ANGLED_DECK_RIGHT.x > 0.99);
    });

    it('maps stations and offsets both ways', () => {
        const p = angledDeckPoint(80, -6);
        const back = angledDeckCoords(p.x, p.z);
        assert.ok(Math.abs(back.station - 80) < 1e-9 && Math.abs(back.offset + 6) < 1e-9);
    });

    it('starts every take-off lane at its position and ends it at the lip', () => {
        for (const pos of TAKEOFF_POSITIONS) {
            assert.deepEqual(pos.lane[0], pos.start);
            assert.ok(pos.lane[pos.lane.length - 1].z < -160);
        }
    });
});

describe('carrier deck surface', () => {
    it('drapes paint on each face it crosses, at that face\'s height, either winding', () => {
        const deck = new CarrierDeckSurface([
            ...plate(-10, -10, 0, 10, 13.5),
            ...plate(0, -10, 10, 10, 14, true),
        ]);
        // A 2 x 4 m rectangle straddling the step.
        const out = deck.drape([-1, -2, 1, -2, 1, 2, -1, -2, 1, 2, -1, 2], 0.04);
        assert.ok(Math.abs(area(out) - 8) < 1e-6, `area ${area(out)}`);
        for (let i = 0; i < out.length; i += 3) {
            const expected = out[i] < -1e-9 ? 13.54 : out[i] > 1e-9 ? 14.04 : undefined;
            if (expected !== undefined) assert.ok(Math.abs(out[i + 1] - expected) < 1e-9);
        }
    });

    it('drops paint off the deck, and ignores walls and the island roof', () => {
        const wall = [0, 10, 0, 0, 14, 0, 5, 14, 0];
        const roof = plate(20, -10, 30, 10, 25);
        const deck = new CarrierDeckSurface([...plate(-10, -10, 10, 10, 13.5), ...wall, ...roof]);
        const out = deck.drape([5, 0, 25, 0, 25, 4], 0);
        // Half of this triangle's x span lies on the deck.
        assert.ok(out.length > 0);
        for (let i = 0; i < out.length; i += 3) assert.ok(out[i] <= 10 + 1e-9);
        assert.ok(Number.isNaN(deck.heightAt(25, 0)));
        assert.ok(Math.abs(deck.heightAt(1, 1) - 13.5) < 1e-9);
    });

    it('paints white, yellow, red and dark on the landing area and the ski-jump', () => {
        const marks = carrierDeckMarkings();
        for (const paint of ['white', 'yellow', 'red', 'dark', 'lip'] as const) {
            assert.ok((marks.get(paint)?.length ?? 0) > 0, paint);
        }
    });
});

describe('Luna landing sight', () => {
    it('shows the middle cell on the path and steps one cell per band', () => {
        assert.equal(lunaCell(0), 2);
        assert.equal(lunaCell(LUNA_DEG_PER_CELL), 1);
        assert.equal(lunaCell(5), 0);
        assert.equal(lunaCell(-LUNA_DEG_PER_CELL), 3);
        assert.equal(lunaCell(-5), 4);
    });

    it('reads the eye against the glide path down the angled deck', () => {
        const eyeAt = (short: number, aboveDeg: number) => {
            const p = angledDeckPoint(HOOK_TOUCHDOWN_STATION_M - short);
            const y = KUZ_DECK_Y + CARRIER_EYE_ABOVE_HOOK_M
                + short * Math.tan((CARRIER_GLIDESLOPE_DEG + aboveDeg) * Math.PI / 180);
            return lunaCellForEye(p.x, y, p.z);
        };
        assert.equal(eyeAt(1500, 0), 2, 'on the ball');
        assert.equal(eyeAt(1500, 0.5), 1, 'a little high');
        assert.equal(eyeAt(800, -1.2), 4, 'low: red');
        // From ahead of the sight, or far off to the side, it shows nothing.
        const ahead = angledDeckPoint(HOOK_TOUCHDOWN_STATION_M + 50);
        assert.equal(lunaCellForEye(ahead.x, 30, ahead.z), -1);
        const wide = angledDeckPoint(HOOK_TOUCHDOWN_STATION_M - 500, 600);
        assert.equal(lunaCellForEye(wide.x, 40, wide.z), -1);
    });
});

describe('carrier ILS', () => {
    const origin = { x: 1000, y: 2, z: -500 };
    const onPath = (short: number, offset: number) => {
        const p = angledDeckPoint(HOOK_TOUCHDOWN_STATION_M - short, offset);
        const y = KUZ_DECK_Y + CARRIER_CG_ABOVE_HOOK_M + short * Math.tan(CARRIER_GLIDESLOPE_DEG * Math.PI / 180);
        return new THREE.Vector3(origin.x + p.x, origin.y + y, origin.z + p.z);
    };

    it('centres both needles on the angled-deck path', () => {
        const d = computeIlsDeviation(onPath(2000, 0), 'Carrier', origin)!;
        assert.ok(Math.abs(d.localizer) < 1e-6 && Math.abs(d.glideslope) < 1e-6, JSON.stringify(d));
    });

    it('reads starboard of the axis the way the airfield ILS reads +X at heading π', () => {
        // Starboard is +X, and the airfield convention at heading π reads +X as positive.
        const d = computeIlsDeviation(onPath(2000, 40), 'Carrier', origin)!;
        assert.ok(d.localizer > 0.3, JSON.stringify(d));
    });
});

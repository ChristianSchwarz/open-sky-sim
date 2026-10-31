import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Rgb } from '../../atmosphere/atmosphere';
import {
    HAZE_HORIZON_SAMPLES, HAZE_UNIFORMS, SCATTER_ALTITUDE_BINS, saturatedHorizon, setHazeSkyTweak, setScatterSun,
} from './haze';
import { defaultColourTweak } from './colourAdjust';

/** Warm towards the sun, cool away from it, like a late-afternoon dome. */
function domeFor(sun: THREE.Vector3) {
    return (x: number, _y: number, z: number, out: [number, number, number]) => {
        const toward = (x * sun.x + z * sun.z) / Math.hypot(sun.x, sun.z);
        out[0] = 0.6 + 0.3 * toward;
        out[1] = 0.65;
        out[2] = 0.8 - 0.2 * toward;
    };
}

describe('aerial perspective', () => {
    const sun = new THREE.Vector3(1, 0.15, 0).normalize();
    setHazeSkyTweak(defaultColourTweak());
    setScatterSun(domeFor(sun), sun, 0);
    const u = HAZE_UNIFORMS;

    it('turns its saturated horizon into the dome colour at midday', () => {
        const r = 61 * Math.PI / 180;
        const noon = new THREE.Vector3(Math.cos(r), Math.sin(r), 0);
        setScatterSun(domeFor(noon), noon, 0);
        const bearing0 = Math.atan2(noon.x, noon.z);
        const dir = new THREE.Vector3();
        const phys: Rgb = [0, 0, 0];
        for (let i = 0; i < HAZE_HORIZON_SAMPLES; i++) {
            const b = bearing0 + i / (HAZE_HORIZON_SAMPLES - 1) * Math.PI;
            dir.set(Math.sin(b), 0, Math.cos(b));
            saturatedHorizon(dir, u.uScatterSun.value,
                u.uScatterSunT.value[0].toArray() as Rgb, u.uScatterMs.value[0].toArray() as Rgb, phys);
            const shown = u.uScatterGain.value[i].clone().multiply(new THREE.Vector3(...phys));
            const want = u.uHazeHorizon.value[i];
            for (const c of ['x', 'y', 'z'] as const) {
                assert.ok(Math.abs(shown[c] / want[c] - 1) < 0.05, `bearing ${i} ${c}: ${shown[c]} vs ${want[c]}`);
            }
        }
        setScatterSun(domeFor(sun), sun, 0);
    });

    it('keeps a finite, modest gain with the sun just below the horizon', () => {
        const dusk = new THREE.Vector3(1, -0.04, 0).normalize();
        const noonGain = (() => {
            const r = 61 * Math.PI / 180;
            const noon = new THREE.Vector3(Math.cos(r), Math.sin(r), 0);
            setScatterSun(domeFor(noon), noon, 0);
            return u.uScatterGain.value[8].clone();
        })();
        setScatterSun(domeFor(dusk), dusk, 0.3);
        for (const g of u.uScatterGain.value) {
            assert.ok(Number.isFinite(g.x) && g.x < 1000 * noonGain.x);
        }
        setScatterSun(domeFor(sun), sun, 0);
    });

    it('scatters more light towards the sun than away from it', () => {
        const dir = new THREE.Vector3(sun.x, 0, sun.z).normalize();
        const toward: Rgb = [0, 0, 0];
        const away: Rgb = [0, 0, 0];
        const sunT = u.uScatterSunT.value[0].toArray() as Rgb;
        const sky = u.uScatterMs.value[0].toArray() as Rgb;
        saturatedHorizon(dir, u.uScatterSun.value, sunT, sky, toward);
        saturatedHorizon(dir.negate(), u.uScatterSun.value, sunT, sky, away);
        assert.ok(toward[1] > 3 * away[1]);
    });

    it('reddens a low sun more at sea level than higher up', () => {
        const low = u.uScatterSunT.value[0];
        const high = u.uScatterSunT.value[SCATTER_ALTITUDE_BINS - 1];
        assert.ok(low.z / low.x < high.z / high.x);
        assert.ok(low.x < high.x);
    });

    it('has no bearing for a sun straight overhead', () => {
        const up = new THREE.Vector3(0, 1, 0);
        setScatterSun((_x, _y, _z, out) => { out[0] = out[1] = out[2] = 0.5; }, up, 0);
        assert.equal(u.uHazeSunXZ.value.length(), 0);
    });
});

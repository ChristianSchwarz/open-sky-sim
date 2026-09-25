import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Fm3Aero } from './aeroModel';
import { F16_AIRFRAME } from './f16Airframe';

const DEG = Math.PI / 180;

describe('FM3 aerodynamics on the F-16 airframe', () => {
    const aero = new Fm3Aero(F16_AIRFRAME);

    it('is laterally symmetric in symmetric flight', () => {
        const c = aero.coefficients({ alpha: 8 * DEG });
        assert.ok(Math.abs(c.CY) < 1e-9 && Math.abs(c.Cl) < 1e-9 && Math.abs(c.Cn) < 1e-9,
            `CY ${c.CY} Cl ${c.Cl} Cn ${c.Cn}`);
    });

    it('has a plausible lift slope and zero-lift drag', () => {
        const c0 = aero.coefficients({ alpha: 0 });
        const c8 = aero.coefficients({ alpha: 8 * DEG });
        const slope = (c8.CL - c0.CL) / (8 * DEG);
        assert.ok(slope > 2.8 && slope < 5.0, `CLα ${slope.toFixed(2)}/rad`);
        assert.ok(c0.CD > 0.012 && c0.CD < 0.035, `CD at α=0: ${c0.CD.toFixed(4)}`);
    });

    it('keeps lifting past 20° and peaks before 55°', () => {
        let best = -Infinity, bestDeg = 0;
        for (let deg = 0; deg <= 70; deg += 2.5) {
            const cl = aero.coefficients({ alpha: deg * DEG }).CL;
            if (cl > best) { best = cl; bestDeg = deg; }
        }
        assert.ok(bestDeg >= 20 && bestDeg <= 55, `CLmax ${best.toFixed(2)} at ${bestDeg}°`);
    });

    it('pitches nose-down with trailing-edge-down stabilator', () => {
        const base = aero.coefficients({ alpha: 5 * DEG }).Cm;
        const down = aero.coefficients({ alpha: 5 * DEG, controls: { stabL: 10 * DEG, stabR: 10 * DEG } }).Cm;
        assert.ok(down - base < -0.03, `ΔCm ${(down - base).toFixed(3)}`);
    });

    it('rolls right with the right flaperon up', () => {
        const c = aero.coefficients({ alpha: 5 * DEG, controls: { flapR: -10 * DEG, flapL: 10 * DEG } });
        assert.ok(c.Cl > 0.005, `Cl ${c.Cl.toFixed(4)}`);
    });

    it('yaws right with the rudder trailing edge to starboard', () => {
        const c = aero.coefficients({ alpha: 5 * DEG, controls: { rudder: 10 * DEG } });
        assert.ok(c.Cn > 0.005, `Cn ${c.Cn.toFixed(4)}`);
        assert.ok(c.CY < 0, `CY ${c.CY.toFixed(4)}`);
    });

    it('is directionally stable with a stable dihedral effect at low alpha', () => {
        const c = aero.coefficients({ alpha: 5 * DEG, beta: 5 * DEG });
        assert.ok(c.Cn > 0, `Cnβ sign: Cn ${c.Cn.toFixed(4)}`);
        assert.ok(c.Cl < 0, `Clβ sign: Cl ${c.Cl.toFixed(4)}`);
        assert.ok(c.CY < 0, `CYβ sign: CY ${c.CY.toFixed(4)}`);
    });

    it('damps pitch, roll and yaw', () => {
        const speed = 150;
        const base = aero.coefficients({ alpha: 5 * DEG, speed });
        const q = aero.coefficients({ alpha: 5 * DEG, speed, q: 0.2 });
        const p = aero.coefficients({ alpha: 5 * DEG, speed, p: 0.5 });
        const r = aero.coefficients({ alpha: 5 * DEG, speed, r: 0.2 });
        const cmq = (q.Cm - base.Cm) / (0.2 * F16_AIRFRAME.reference.chordM / (2 * speed));
        const clp = (p.Cl - base.Cl) / (0.5 * F16_AIRFRAME.reference.spanM / (2 * speed));
        const cnr = (r.Cn - base.Cn) / (0.2 * F16_AIRFRAME.reference.spanM / (2 * speed));
        assert.ok(cmq < 0, `Cmq ${cmq.toFixed(2)}`);
        assert.ok(clp < 0, `Clp ${clp.toFixed(3)}`);
        assert.ok(cnr < 0, `Cnr ${cnr.toFixed(3)}`);
    });
});

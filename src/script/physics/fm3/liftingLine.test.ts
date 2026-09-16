import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AeroEnvironment, Fm3Aero } from './aeroModel';
import { Fm3Airframe } from './fm3Airframe';
import { SectionParams } from './sectionAero';

const DEG = Math.PI / 180;

/** A thin, attached, frictionless section: only the lifting line shapes the result. */
const THIN: SectionParams = {
    cnAlpha: 2 * Math.PI,
    alpha0: 0,
    alphaSep: 40 * DEG,
    sepWidth: 2 * DEG,
    cd0: 0,
    suctionEta: 1,
    cd90: 1.2,
    cm0: 0,
    reverseSlopeFactor: 0.6,
    reverseAlphaSep: 6 * DEG,
    tau1: 0,
    tau2: 0,
    thickness: 0,
};

/** A straight (unswept quarter-chord) trapezoidal wing and nothing else. */
function wing(aspect: number, taper: number, strips: number): Fm3Airframe {
    const span = 10;
    const area = span * span / aspect;
    const rootChord = 2 * area / (span * (1 + taper));
    const tipChord = rootChord * taper;
    return {
        name: 'test wing',
        reference: { areaM2: area, spanM: span, chordM: area / span, momentRef: [0, 0, 0] },
        mass: { massKg: 1000, cg: [0, 0, 0], inertia: { ixx: 1, iyy: 1, izz: 1, ixz: 0 } },
        surfaces: [{
            name: 'wing', role: 'wing',
            rootLE: [0.25 * rootChord, 0, 0], rootChord,
            tipLE: [0.25 * tipChord, span / 2, 0], tipChord,
            mirror: true, strips, section: THIN,
        }],
        strakes: [], bodies: [], bluffBodies: [], engines: [], actuators: [],
        miscCd0: 0, bodyWaveDrag: [], wakeTau: 1,
    };
}

describe('FM3 lifting line', () => {
    it("matches Helmbold's lift slope for a straight rectangular wing", () => {
        const aero = new Fm3Aero(wing(6, 1, 16));
        const alpha = 4 * DEG;
        const c = aero.coefficients({ alpha, speed: 60 });
        const slope = c.CL / alpha;
        const helmbold = 2 * Math.PI * 6 / (2 + Math.sqrt(36 + 4));
        assert.ok(Math.abs(slope - helmbold) / helmbold < 0.07, `CLα ${slope.toFixed(3)} vs Helmbold ${helmbold.toFixed(3)}`);
        for (let i = 0; i < aero.wingStripCount; i++) {
            assert.ok(aero.inducedVelocity[i] < 0, `strip ${i} should see downwash, got ${aero.inducedVelocity[i]}`);
        }
    });

    it('gives a tapered wing near-elliptic induced drag', () => {
        const aspect = 8;
        const aero = new Fm3Aero(wing(aspect, 0.4, 16));
        const c = aero.coefficients({ alpha: 5 * DEG, speed: 60 });
        const e = c.CL * c.CL / (Math.PI * aspect * c.CD);
        assert.ok(e > 0.9 && e < 1.05, `span efficiency ${e.toFixed(3)} (CL ${c.CL.toFixed(3)}, CD ${c.CD.toFixed(4)})`);
    });

    it('damps roll', () => {
        const aero = new Fm3Aero(wing(6, 1, 16));
        const speed = 60;
        const p = 0.5;
        const c = aero.coefficients({ alpha: 2 * DEG, speed, p });
        const clp = c.Cl / (p * 10 / (2 * speed));
        assert.ok(clp < -0.3 && clp > -0.7, `Clp ${clp.toFixed(3)}`);
    });

    it('settles circulation without ringing on a fast, low-aspect wing', () => {
        const airframe = wing(3, 0.23, 8);
        const aero = new Fm3Aero(airframe);
        const speed = 300;
        const env: AeroEnvironment = { rho: 1.0, soundSpeed: 1e9, heightAboveGround: Infinity, gearDown: 0 };
        const at = (deg: number) => [0, -speed * Math.sin(deg * DEG), speed * Math.cos(deg * DEG)];

        const [vx4, vy4, vz4] = at(4);
        aero.reset();
        aero.settle(vx4, vy4, vz4, 0, 0, 0, env, 200);
        const steady = Float64Array.from(aero.circulation);

        const [vx3, vy3, vz3] = at(3);
        aero.reset();
        aero.settle(vx3, vy3, vz3, 0, 0, 0, env, 200);
        let peak = 0;
        for (let step = 0; step < 240; step++) {
            aero.advance(1 / 120, vx4, vy4, vz4, 0, 0, 0, env);
            const mid = aero.circulation[aero.wingStripCount / 4];
            peak = Math.max(peak, mid);
        }
        for (let i = 0; i < aero.wingStripCount; i++) {
            const err = Math.abs(aero.circulation[i] - steady[i]) / Math.abs(steady[i]);
            assert.ok(err < 0.01, `strip ${i} circulation off by ${(100 * err).toFixed(2)}%`);
        }
        const midSteady = steady[aero.wingStripCount / 4];
        assert.ok(peak < midSteady * 1.1, `overshoot ${(peak / midSteady).toFixed(3)}`);
    });
});

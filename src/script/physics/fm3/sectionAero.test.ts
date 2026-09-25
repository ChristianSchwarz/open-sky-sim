import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    advanceSeparation, flapEffectiveness, NO_MODIFIERS, regimeAngle, SectionForces, sectionForces,
    SectionParams, separationTarget, slopeMachFactor, staticSeparation,
} from './sectionAero';

const DEG = Math.PI / 180;

const SYMMETRIC: SectionParams = {
    cnAlpha: 6.0,
    alpha0: 0,
    alphaSep: 16 * DEG,
    sepWidth: 2.5 * DEG,
    cd0: 0.008,
    suctionEta: 0.95,
    cd90: 1.9,
    cm0: 0,
    reverseSlopeFactor: 0.6,
    reverseAlphaSep: 6 * DEG,
    tau1: 3,
    tau2: 1.5,
    thickness: 0.04,
};

const CAMBERED: SectionParams = { ...SYMMETRIC, alpha0: -1.5 * DEG, cm0: -0.03 };

function out(): SectionForces {
    return { cn: 0, cc: 0, cdProfile: 0, xcp: 0, cm: 0 };
}

/** Section forces with the separation state at its static value. */
function steady(alpha: number, p: SectionParams, mach = 0): SectionForces {
    const f = separationTarget(alpha, 0, 100, 1, p, NO_MODIFIERS, mach);
    return sectionForces(alpha, f, p, NO_MODIFIERS, mach, out());
}

/** Lift and drag along / across a wind that comes from angle `alpha`. */
function liftDrag(alpha: number, s: SectionForces): { cl: number; cd: number } {
    return {
        cl: s.cn * Math.cos(alpha) + s.cc * Math.sin(alpha),
        cd: s.cn * Math.sin(alpha) - s.cc * Math.cos(alpha) + s.cdProfile,
    };
}

describe('FM3 section aerodynamics', () => {
    it('starts on the attached lift slope', () => {
        const s = steady(2 * DEG, SYMMETRIC);
        const { cl, cd } = liftDrag(2 * DEG, s);
        assert.ok(Math.abs(cl - 6.0 * Math.sin(2 * DEG)) < 0.01, `cl ${cl}`);
        assert.ok(cd > 0 && cd < 0.012, `cd ${cd}`);
    });

    it('is odd in alpha for a symmetric section', () => {
        for (const deg of [3, 12, 25, 60, 120, 170]) {
            const a = steady(deg * DEG, SYMMETRIC);
            const b = steady(-deg * DEG, SYMMETRIC);
            assert.ok(Math.abs(a.cn + b.cn) < 1e-12, `cn at ±${deg}°`);
            assert.ok(Math.abs(a.cc - b.cc) < 1e-12, `cc at ±${deg}°`);
        }
    });

    it('makes lift at zero alpha when cambered', () => {
        const { cl } = liftDrag(0, steady(0, CAMBERED));
        assert.ok(Math.abs(cl - 6.0 * Math.sin(1.5 * DEG)) < 0.005, `cl0 ${cl}`);
    });

    it('peaks near the separation angle and falls away after it', () => {
        let best = -Infinity;
        let bestDeg = 0;
        for (let deg = 0; deg <= 40; deg += 0.5) {
            const { cl } = liftDrag(deg * DEG, steady(deg * DEG, SYMMETRIC));
            if (cl > best) { best = cl; bestDeg = deg; }
        }
        assert.ok(bestDeg > 11 && bestDeg < 26, `peak at ${bestDeg}°`);
        assert.ok(best > 1.1 && best < 1.8, `clmax ${best}`);
        const post = liftDrag(40 * DEG, steady(40 * DEG, SYMMETRIC)).cl;
        assert.ok(post < best, 'lift should fall past the peak');
    });

    it('becomes a flat plate at 90° with the centre of pressure at mid-chord', () => {
        const s = steady(90 * DEG, SYMMETRIC);
        assert.ok(Math.abs(s.cn - SYMMETRIC.cd90) < 0.02, `cn ${s.cn}`);
        assert.ok(Math.abs(s.xcp - 0.5) < 0.01, `xcp ${s.xcp}`);
        assert.ok(Math.abs(s.cc) < 1e-4, `cc ${s.cc}`);
    });

    it('is continuous through ±90° and ±180°', () => {
        for (const edge of [90, -90, 180, -180]) {
            const lo = edge > 0 ? edge - 0.01 : edge + 0.01;
            const hi = Math.abs(edge) === 180 ? -lo : (edge > 0 ? edge + 0.01 : edge - 0.01);
            const a = steady(lo * DEG, SYMMETRIC);
            const b = steady(hi * DEG, SYMMETRIC);
            assert.ok(Math.abs(a.cn - b.cn) < 0.02, `cn jumps at ${edge}°: ${a.cn} vs ${b.cn}`);
            assert.ok(Math.abs(a.xcp - b.xcp) < 0.02 || Math.abs(edge) === 180, `xcp jumps at ${edge}°`);
        }
    });

    it('pushes the right way in reverse flow', () => {
        // Wind from behind and slightly below: the plate is still pushed up.
        assert.ok(steady(175 * DEG, SYMMETRIC).cn > 0);
        assert.ok(steady(-175 * DEG, SYMMETRIC).cn < 0);
        assert.equal(regimeAngle(175 * DEG, 0) > 0, true);
    });

    it('delays separation on a fast pitch-up and reattachment on the way down (hysteresis)', () => {
        const chord = 3;
        const speed = 60;
        const dt = 1 / 120;
        const loopArea = (reducedFreq: number) => {
            const omega = reducedFreq * 2 * speed / chord;
            let f = staticSeparation(16 * DEG, SYMMETRIC.alphaSep, SYMMETRIC.sepWidth);
            let area = 0;
            let prevAlpha = 16 * DEG;
            let prevCn = 0;
            const period = 2 * Math.PI / omega;
            const steps = Math.round(3 * period / dt);
            for (let i = 0; i <= steps; i++) {
                const t = i * dt;
                const alpha = (16 + 10 * Math.sin(omega * t)) * DEG;
                const rate = 10 * DEG * omega * Math.cos(omega * t);
                const target = separationTarget(alpha, rate, speed, chord, SYMMETRIC, NO_MODIFIERS, 0);
                f = advanceSeparation(f, target, dt, speed, chord, SYMMETRIC.tau1);
                const cn = sectionForces(alpha, f, SYMMETRIC, NO_MODIFIERS, 0, out()).cn;
                if (t > 2 * period) area += 0.5 * (cn + prevCn) * (alpha - prevAlpha);
                prevAlpha = alpha;
                prevCn = cn;
            }
            return Math.abs(area);
        };
        const slow = loopArea(0.002);
        const fast = loopArea(0.1);
        assert.ok(fast > 5 * slow, `loop area fast ${fast} vs slow ${slow}`);
        assert.ok(fast > 0.005, `fast loop area ${fast}`);
    });

    it('follows Prandtl–Glauert subsonically', () => {
        assert.ok(Math.abs(slopeMachFactor(0.6, 6) - 1.25) < 1e-9);
        assert.ok(slopeMachFactor(2, 6) < 1, 'supersonic slope should be lower');
    });

    it("matches Glauert's flap effectiveness", () => {
        assert.ok(Math.abs(flapEffectiveness(1) - 1) < 1e-12);
        assert.ok(Math.abs(flapEffectiveness(0) - 0) < 1e-12);
        const quarter = flapEffectiveness(0.25);
        assert.ok(quarter > 0.55 && quarter < 0.65, `τ(0.25) ${quarter}`);
    });
});

/**
 * Fits the F-16 airframe's physical parameters (F16AeroParams) to NASA
 * TP-1538's figure 9 (lift) and figure 10 (pitching moment at δh = 0, ±25°),
 * plus the reference roll damping up to the AoA limit and stable pitch damping
 * through the deep stall: a seeded random search inside physical bounds, then
 * coordinate descent from the best point. Prints the best parameters for
 * f16Airframe.ts.
 *
 * TP-1538's figures are the airplane as flown, so every point is taken with
 * the leading-edge flaps on the FCS schedule.
 *
 * Runs bundled; a few minutes:
 *
 *     node_modules/.bin/esbuild tools/fm3/calibrate.ts --bundle --platform=node --outfile=<tmp>/cal.cjs
 *     node <tmp>/cal.cjs [randomSamples=250] [descentRounds=4]
 */
import { Fm3Aero } from '../../src/script/physics/fm3/aeroModel';
import { buildF16Airframe, F16_AERO_PARAMS, F16AeroParams } from '../../src/script/physics/fm3/f16Airframe';
import { leadingEdgeFlapSchedule } from '../../src/script/physics/fm3/fcs';
import { F16_TABLES } from '../../src/script/physics/fm3/reference/f16Tables';
import { TP1538_FIG10_PITCH, TP1538_FIG9_LIFT } from '../../src/script/physics/fm3/reference/tp1538';

const DEG = Math.PI / 180;
const SPEED = 60;
const SEA_LEVEL_PRESSURE = 101325;
type Key = keyof F16AeroParams;

/** Physical bounds for each fitted parameter. */
const BOUNDS: Record<Key, [number, number]> = {
    innerAlphaSep: [10 * DEG, 28 * DEG],
    // Polhamus: the vortex lift is the lost leading-edge suction; recovering
    // much more than all of it is not physical.
    innerVortexLift: [0.5, 1.5],
    innerVortexCp: [0.25, 0.6],
    outerAlphaSep: [10 * DEG, 28 * DEG],
    outerPlateShape: [0.2, 0.56],
    stabAlphaSep: [12 * DEG, 32 * DEG],
    stabSepWidth: [3 * DEG, 8 * DEG],
    stabPlateShape: [0.2, 0.56],
    stabVortexLift: [0, 1.6],
    stabBurstStart: [30 * DEG, 70 * DEG],
    stabBurstEnd: [45 * DEG, 90 * DEG],
    stabQFactor: [0.7, 1.0],
    strakeSpan: [0.6, 1.3],
    strakeBurstTE: [35 * DEG, 65 * DEG],
    strakeBurstApex: [50 * DEG, 88 * DEG],
    // The inboard wing panel is ~7.7 m² a side; the vortex covers part of it.
    strakeAugArea: [0, 6],
    strakeAugX: [-1.5, 2.5],
    bodyCrossflowCd: [0.8, 2.0],
};
const KEYS = Object.keys(BOUNDS) as Key[];

/** Where roll damping is checked: up to just past the 25° AoA limit. */
const CLP_ALPHAS_DEG = [15, 20, 25, 30];
/** Where pitch damping (Cmq + Cmα̇) must stay below the ceiling: the deep-stall range. */
const DAMPING_ALPHAS_DEG = [60, 70, 80];
const DAMPING_CEILING = -0.5;

function valid(p: F16AeroParams): boolean {
    return p.stabBurstEnd > p.stabBurstStart + 5 * DEG && p.strakeBurstApex > p.strakeBurstTE + 5 * DEG;
}

/** Leading-edge flap deflection at `deg` in the tunnel's airflow. */
function lef(deg: number): number {
    return leadingEdgeFlapSchedule(deg * DEG, 0.5 * 1.225 * SPEED * SPEED, SEA_LEVEL_PRESSURE);
}

function referenceClp(deg: number): number {
    const table = F16_TABLES.Clp;
    const rows = table.rows!, data = table.data as number[];
    const alpha = deg * DEG;
    for (let i = 1; i < rows.length; i++) {
        if (alpha <= rows[i]) {
            const t = (alpha - rows[i - 1]) / (rows[i] - rows[i - 1]);
            return data[i - 1] + t * (data[i] - data[i - 1]);
        }
    }
    return data[data.length - 1];
}

interface Score { total: number; cm: number; cl: number; clp: number; damping: number }

function score(p: F16AeroParams): Score {
    if (!valid(p)) return { total: Infinity, cm: Infinity, cl: Infinity, clp: Infinity, damping: Infinity };
    const airframe = buildF16Airframe(p);
    const aero = new Fm3Aero(airframe);
    let cmSum = 0, cmW = 0;
    for (const deflection of [0, 25, -25]) {
        const ref = TP1538_FIG10_PITCH.Cm[deflection];
        TP1538_FIG10_PITCH.alphaDeg.forEach((deg, i) => {
            const c = aero.coefficients({
                alpha: deg * DEG, speed: SPEED,
                controls: { stabL: deflection * DEG, stabR: deflection * DEG, lef: lef(deg) },
            });
            // The deep-stall band decides whether the trim point exists at all.
            const w = deg >= 40 && deg <= 70 ? 2 : 1;
            cmSum += w * (c.Cm - ref[i]) ** 2;
            cmW += w;
        });
    }
    let clSum = 0;
    TP1538_FIG9_LIFT.alphaDeg.forEach((deg, i) => {
        const c = aero.coefficients({ alpha: deg * DEG, speed: SPEED, controls: { lef: lef(deg) } });
        clSum += (c.CL - TP1538_FIG9_LIFT.CL[i]) ** 2;
    });
    let clpSum = 0;
    const rate = 0.3, rollHat = rate * airframe.reference.spanM / (2 * SPEED);
    for (const deg of CLP_ALPHAS_DEG) {
        const controls = { lef: lef(deg) };
        const steady = aero.coefficients({ alpha: deg * DEG, speed: SPEED, controls });
        const rolling = aero.coefficients({ alpha: deg * DEG, speed: SPEED, p: rate, controls });
        clpSum += ((rolling.Cl - steady.Cl) / rollHat - referenceClp(deg)) ** 2;
    }
    // TP-1538's deep-stall trim is weak but stable, so pitch damping has to stay
    // negative through it. The static points above cannot see the lags that
    // decide that; a forced oscillation can.
    let excess = 0, worstDamping = -Infinity;
    for (const deg of DAMPING_ALPHAS_DEG) {
        const damping = aero.pitchDamping({
            alpha: deg * DEG, speed: SPEED, controls: { stabL: 25 * DEG, stabR: 25 * DEG, lef: lef(deg) },
        });
        worstDamping = Math.max(worstDamping, damping);
        excess += Math.max(0, damping - DAMPING_CEILING) ** 2;
    }
    const cm = Math.sqrt(cmSum / cmW);
    const cl = Math.sqrt(clSum / TP1538_FIG9_LIFT.alphaDeg.length);
    const clp = Math.sqrt(clpSum / CLP_ALPHAS_DEG.length);
    const dampingExcess = Math.sqrt(excess / DAMPING_ALPHAS_DEG.length);
    // A Cm error of 0.03 matters about as much as a lift error of 0.15, a
    // roll-damping error of 0.1, or pitch damping a whole unit short of the
    // ceiling. At a third of its weight the fit trades roll damping for lift,
    // and Clp collapses at the AoA limit.
    return { total: cm + 0.2 * cl + 0.3 * clp + 0.03 * dampingExcess, cm, cl, clp, damping: worstDamping };
}

let seed = 20260915;
function rand(): number {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
}

function describe(p: F16AeroParams): string {
    return KEYS.map(k => {
        const v = p[k];
        const deg = /AlphaSep|SepWidth|Burst/.test(k);
        return `    ${k}: ${deg ? `${(v / DEG).toFixed(1)} * DEG` : v.toFixed(3)},`;
    }).join('\n');
}

const summary = (sc: Score) => `total ${sc.total.toFixed(4)} (Cm rms ${sc.cm.toFixed(4)}, CL rms ${sc.cl.toFixed(3)}, `
    + `Clp rms ${sc.clp.toFixed(3)}, worst Cmq+Cmα̇ ${sc.damping.toFixed(2)})`;

const samples = Number(process.argv[2] ?? 250);
const rounds = Number(process.argv[3] ?? 4);

let best = { ...F16_AERO_PARAMS };
let bestScore = score(best);
console.log(`start: ${summary(bestScore)}`);

for (let s = 0; s < samples; s++) {
    const p = { ...best };
    // Perturb a few parameters at a time, around the incumbent.
    for (const k of KEYS) {
        if (rand() < 0.35) {
            const [lo, hi] = BOUNDS[k];
            const span = hi - lo;
            p[k] = Math.min(hi, Math.max(lo, p[k] + (rand() - 0.5) * 0.5 * span));
        }
    }
    const sc = score(p);
    if (sc.total < bestScore.total) {
        best = p;
        bestScore = sc;
        console.log(`random ${s}: ${summary(sc)}`);
    }
}

for (let r = 0; r < rounds; r++) {
    const fraction = 0.15 / (r + 1);
    for (const k of KEYS) {
        const [lo, hi] = BOUNDS[k];
        for (const dir of [1, -1]) {
            const p = { ...best };
            p[k] = Math.min(hi, Math.max(lo, p[k] + dir * fraction * (hi - lo)));
            const sc = score(p);
            if (sc.total < bestScore.total) {
                best = p;
                bestScore = sc;
                console.log(`descent ${r} ${k}: ${summary(sc)}`);
                break;
            }
        }
    }
}

console.log(`\nbest: ${summary(bestScore)}`);
console.log('export const F16_AERO_PARAMS: F16AeroParams = {');
console.log(describe(best));
console.log('};');

/**
 * FM3 virtual wind tunnel: the default F-16's coefficients next to the Stevens &
 * Lewis tables (NASA TP-1538 data, α −10..45°), plus FM3's own high-alpha
 * sweep to 90°, for calibrating the airframe's physical parameters.
 *
 * Runs bundled — under `node --import tsx` physics code is ~50x slower:
 *
 *     node_modules/.bin/esbuild tools/fm3/windTunnel.ts --bundle --platform=node --outfile=<tmp>/wt.cjs
 *     node <tmp>/wt.cjs
 */
import { Fm3Aero, StaticCondition } from '../../src/script/physics/fm3/aeroModel';
import { F16_AIRFRAME } from '../../src/script/physics/fm3/f16Airframe';
import { leadingEdgeFlapSchedule } from '../../src/script/physics/fm3/fcs';
import { F16_TABLES } from '../../src/script/physics/fm3/reference/f16Tables';

const DEG = Math.PI / 180;
const SPEED = 60;
const aero = new Fm3Aero(F16_AIRFRAME);

function interp1(xs: number[], ys: number[], x: number): number {
    if (x <= xs[0]) return ys[0];
    for (let i = 1; i < xs.length; i++) {
        if (x <= xs[i]) {
            const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
            return ys[i - 1] + t * (ys[i] - ys[i - 1]);
        }
    }
    return ys[ys.length - 1];
}

function ref1(name: string, x: number): number {
    const t = F16_TABLES[name];
    return interp1(t.rows!, t.data as number[], x);
}

function ref2(name: string, row: number, col: number): number {
    const t = F16_TABLES[name];
    const rows = t.rows!;
    const data = t.data as number[][];
    const colValues = rows.map((_, i) => interp1(t.columns!, data[i], col));
    return interp1(rows, colValues, row);
}

/** The leading-edge flaps on the FCS schedule in the tunnel's airflow, as calibrate.ts fits them. */
const lefAt = (alpha: number) => leadingEdgeFlapSchedule(alpha, 0.5 * 1.225 * SPEED * SPEED, 101325);
const coef = (c: StaticCondition) => aero.coefficients({ speed: SPEED, ...c, controls: { lef: lefAt(c.alpha), ...c.controls } });
const f = (x: number, w = 7, d = 3) => x.toFixed(d).padStart(w);
const stab = (deg: number) => ({ stabL: deg * DEG, stabR: deg * DEG });

console.log('Longitudinal (δh = 0 unless noted; leading-edge flaps on schedule throughout); FM3 | reference');
console.log('  α°     CL           CD             Cm            Cm δh=-25      Cm δh=+25');
for (const alpha of F16_TABLES.CLDh.rows!) {
    const c = coef({ alpha });
    const up = coef({ alpha, controls: stab(-25) });
    const dn = coef({ alpha, controls: stab(25) });
    console.log(
        `${f(alpha / DEG, 5, 0)} ${f(c.CL)} ${f(ref2('CLDh', alpha, 0))} ${f(c.CD)} ${f(ref2('CDDh', alpha, 0))}`
        + ` ${f(c.Cm)} ${f(ref2('CmDh', alpha, 0))} ${f(up.Cm)} ${f(ref2('CmDh', alpha, -25 * DEG))}`
        + ` ${f(dn.Cm)} ${f(ref2('CmDh', alpha, 25 * DEG))}`,
    );
}

console.log('\nLateral-directional per rad of β (from β = ±5°); FM3 | reference');
console.log('  α°     Cnβ            Clβ            CYβ');
const b = 5 * DEG;
for (const alpha of F16_TABLES.Cnb.rows!) {
    const plus = coef({ alpha, beta: b });
    const minus = coef({ alpha, beta: -b });
    const cnb = (plus.Cn - minus.Cn) / (2 * b);
    const clb = (plus.Cl - minus.Cl) / (2 * b);
    const cyb = (plus.CY - minus.CY) / (2 * b);
    const refCnb = (ref2('Cnb', alpha, b) - ref2('Cnb', alpha, -b)) / (2 * b);
    const refClb = (ref2('Clb', alpha, b) - ref2('Clb', alpha, -b)) / (2 * b);
    console.log(`${f(alpha / DEG, 5, 0)} ${f(cnb)} ${f(refCnb)} ${f(clb)} ${f(refClb)} ${f(cyb)} ${f(F16_TABLES.CYb.value!)}`);
}

console.log('\nDamping (per unit of rate·length/2V); FM3 | reference');
console.log('  α°     Cmq              Clp            Cnr');
const { chordM, spanM } = F16_AIRFRAME.reference;
for (const alpha of F16_TABLES.Cmq.rows!) {
    const base = coef({ alpha });
    const q = 0.2, p = 0.3, r = 0.2;
    const cmq = (coef({ alpha, q }).Cm - base.Cm) / (q * chordM / (2 * SPEED));
    const clp = (coef({ alpha, p }).Cl - base.Cl) / (p * spanM / (2 * SPEED));
    const cnr = (coef({ alpha, r }).Cn - base.Cn) / (r * spanM / (2 * SPEED));
    console.log(`${f(alpha / DEG, 5, 0)} ${f(cmq, 8, 2)} ${f(ref1('Cmq', alpha), 8, 2)} ${f(clp)} ${f(ref1('Clp', alpha))} ${f(cnr)} ${f(ref1('Cnr', alpha))}`);
}

console.log('\nPitching moment by component (δh = 0), about the reference CG');
const groupNames = aero.groupLoads().map(g => g.name);
console.log('  α°  ' + groupNames.map(n => n.slice(0, 9).padStart(10)).join('') + '     total');
const { areaM2 } = F16_AIRFRAME.reference;
for (const deg of [0, 10, 20, 30, 40, 45, 50, 55, 60, 65, 70, 80, 90]) {
    const c = coef({ alpha: deg * DEG });
    const qSc = 0.5 * 1.225 * SPEED * SPEED * areaM2 * chordM;
    // Sim +X is NASA −y, so NASA pitching moment = −M_x(sim).
    const parts = aero.groupLoads().map(g => -g.moment[0] / qSc);
    console.log(`${f(deg, 5, 0)} ${parts.map(p => f(p, 10)).join('')} ${f(c.Cm, 9)}`);
}

console.log('\nNormal force by component (δh = 0), on wing area');
console.log('  α°  ' + groupNames.map(n => n.slice(0, 9).padStart(10)).join('') + '     total');
for (const deg of [10, 20, 30, 40, 50, 60, 70, 90]) {
    const c = coef({ alpha: deg * DEG });
    const qS = 0.5 * 1.225 * SPEED * SPEED * areaM2;
    const parts = aero.groupLoads().map(g => g.force[1] / qS);
    const cn = c.CL * Math.cos(deg * DEG) + c.CD * Math.sin(deg * DEG);
    console.log(`${f(deg, 5, 0)} ${parts.map(p => f(p, 10)).join('')} ${f(cn, 9)}`);
}

console.log('\nStarboard lifting strips at α = 20 / 35 / 60°: strip α°, separation f, induced angle°, cl, wake q');
const starboard = (group: string) => group;
for (const deg of [20, 35, 60]) {
    coef({ alpha: deg * DEG });
    const strips = aero.stripDiagnostics();
    console.log(`  α = ${deg}°`);
    let lastGroup = '';
    strips.forEach((s, i) => {
        if (s.group !== lastGroup) { lastGroup = starboard(s.group); process.stdout.write(`\n    ${s.group.padEnd(13)}`); }
        process.stdout.write(` [${i}] ${f(s.alpha / DEG, 5, 1)} ${f(s.separation, 5, 2)} ${f(s.inducedAngle / DEG, 5, 1)} ${f(s.cl, 5, 2)} ${f(s.wakeQ, 4, 2)} |`);
    });
    console.log('');
}

console.log('\nFM3 past the tables (δh = 0 / full nose-down +25 / full nose-up -25)');
console.log('  α°     CL      CD      Cm      Cm+25   Cm-25');
for (let deg = 45; deg <= 90; deg += 5) {
    const alpha = deg * DEG;
    const c = coef({ alpha });
    console.log(`${f(deg, 5, 0)} ${f(c.CL)} ${f(c.CD)} ${f(c.Cm)} ${f(coef({ alpha, controls: stab(25) }).Cm)} ${f(coef({ alpha, controls: stab(-25) }).Cm)}`);
}

// The static tables hold no lags. A slow pitch oscillation about the CG does:
// the moment in phase with α̇ is Cmq + Cmα̇, and it must stay negative through
// the deep stall for TP-1538's weak but stable trim.
console.log('\nPitch damping by forced oscillation (±5° at 0.8 rad/s, stabilator +25°, LEF 25°): Cmq + Cmα̇');
const noseDown = { ...stab(25), lef: 25 * DEG };
console.log('  ' + [30, 40, 50, 60, 70, 80]
    .map(deg => `${deg}° ${f(aero.pitchDamping({ speed: SPEED, alpha: deg * DEG, controls: noseDown }), 6, 2)}`)
    .join('   '));

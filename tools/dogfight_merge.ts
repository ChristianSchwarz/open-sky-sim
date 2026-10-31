/**
 * Fly AI-vs-AI merges headless on the real flight model and score them: the
 * bench for tuning the dogfight AI (src/script/physics/sim/dogfightMerge.ts).
 *
 * Every pairing of pilot models flies every merge in MERGE_SETUPS from both
 * sides, so a result is never just the side it started on. Gun spread is the
 * only randomness; it is seeded, so a run repeats exactly.
 *
 * Usage:
 *   node --import tsx tools/dogfight_merge.ts                 # full matrix
 *   node --import tsx tools/dogfight_merge.ts --blue ACE --red SHAW --setup head-on --trace 1
 *   node --import tsx tools/dogfight_merge.ts --models ACE,CLASSIC --seconds 120
 */

import { AiPilotModels } from '../src/script/state/gameDefs';
import * as fs from 'node:fs';
import { MERGE_SETUPS, MergeResult, MergeSide, MergeSideResult, runMerge } from '../src/script/physics/sim/dogfightMerge';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

/** mulberry32, so gun spread repeats run to run. */
function seedRandom(seed: number): void {
    let s = seed >>> 0;
    Math.random = () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const ALL_MODELS: string[] = [AiPilotModels.CLASSIC, AiPilotModels.SHAW, AiPilotModels.AGGRESSIVE, AiPilotModels.ACE];

/**
 * BASE is a frozen copy of the classic pilot (src/script/ai/aiPilotBaseline.ts,
 * untracked: copy aiPilot.ts there before changing it) so a change can fight
 * what it replaces.
 */
const BASELINE = 'src/script/ai/aiPilotBaseline.ts';
const baseline = fs.existsSync(BASELINE) ? require('../' + BASELINE).AiPilot : undefined;
if (baseline) ALL_MODELS.push('BASE');

const parseModel = (s: string) => {
    const name = s.toUpperCase();
    if (!ALL_MODELS.includes(name)) throw new Error(`unknown model ${s} (${ALL_MODELS.join(', ')})`);
    return name;
};
const sideFor = (name: string): MergeSide => name === 'BASE'
    ? { model: AiPilotModels.CLASSIC, pilot: (ac, world, options) => new baseline(ac, world, options) }
    : { model: name as AiPilotModels };

const seconds = Number(arg('seconds') ?? 180);
const traceEvery = Number(arg('trace') ?? 0);
const setups = arg('setup') ? MERGE_SETUPS.filter(s => s.name === arg('setup')) : MERGE_SETUPS;
if (setups.length === 0) throw new Error(`unknown setup (${MERGE_SETUPS.map(s => s.name).join(', ')})`);

let pairs: [string, string][];
if (arg('blue') || arg('red')) {
    pairs = [[parseModel(arg('blue') ?? 'ACE'), parseModel(arg('red') ?? 'ACE')]];
} else {
    const models = arg('models') ? arg('models')!.split(',').map(parseModel) : ALL_MODELS;
    pairs = [];
    for (const b of models) for (const r of models) pairs.push([b, r]);
}

const fmt = (r: MergeSideResult) => {
    const fate = r.midair ? `MIDAIR@${r.lostAt!.toFixed(0)}` : r.shotDown ? `KILLED@${r.lostAt!.toFixed(0)}` : r.crashed ? `CRASH@${r.lostAt!.toFixed(0)}` : 'alive';
    return `${fate.padEnd(10)} hits ${String(r.hitsScored).padStart(2)} rds ${String(Math.round(r.roundsFired)).padStart(4)}`
        + ` off ${r.offensiveS.toFixed(0).padStart(3)}s nose ${r.noseOnS.toFixed(0).padStart(3)}s`
        + ` minAlt ${r.minAltitude.toFixed(0).padStart(5)} minV ${r.minSpeed.toFixed(0).padStart(3)} slow ${r.slowS.toFixed(0).padStart(3)}s`;
};
const topLabels = (r: MergeSideResult) => Object.entries(r.labels)
    .sort((x, y) => y[1] - x[1]).slice(0, 4).map(([l, s]) => `${l}:${s.toFixed(0)}`).join(' ');

interface Tally { win: number; loss: number; draw: number; crash: number; midair: number; shotDown: number; off: number; def: number; fights: number }
const tally = new Map<string, Tally>();
const tallyOf = (m: string) => {
    let t = tally.get(m);
    if (!t) tally.set(m, t = { win: 0, loss: 0, draw: 0, crash: 0, midair: 0, shotDown: 0, off: 0, def: 0, fights: 0 });
    return t;
};
const record = (model: string, me: MergeSideResult, won: boolean, lostFight: boolean) => {
    const t = tallyOf(model);
    t.fights++;
    if (won) t.win++; else if (lostFight) t.loss++; else t.draw++;
    if (me.crashed) t.crash++;
    if (me.midair) t.midair++;
    if (me.shotDown) t.shotDown++;
    t.off += me.offensiveS;
    t.def += me.defensiveS;
};

const verbose = pairs.length === 1 || process.argv.includes('--verbose');
const started = Date.now();
for (const [blue, red] of pairs) {
    for (const setup of setups) {
        seedRandom(1);
        const res: MergeResult = runMerge(setup, sideFor(blue), sideFor(red), { seconds, traceEvery });
        console.log(`${blue.padEnd(10)} vs ${red.padEnd(10)} ${setup.name.padEnd(15)} -> ${res.winner.padEnd(4)}`
            + ` ${res.duration.toFixed(0).padStart(3)}s minR ${res.minRange.toFixed(0)}`);
        console.log(`   blue ${fmt(res.blue)}`);
        console.log(`   red  ${fmt(res.red)}`);
        if (verbose) {
            console.log(`   blue labels ${topLabels(res.blue)}`);
            console.log(`   red  labels ${topLabels(res.red)}`);
        }
        for (const s of res.trace ?? []) {
            console.log(`     t=${String(s.t).padStart(5)} R=${String(s.range).padStart(5)}`
                + ` B[${s.blue.join(',')}] ${s.blueSpeed}m/s ${s.blueLabel.padEnd(14)}`
                + ` R[${s.red.join(',')}] ${s.redSpeed}m/s ${s.redLabel}`);
        }
        record(blue, res.blue, res.winner === 'blue', res.winner === 'red');
        record(red, res.red, res.winner === 'red', res.winner === 'blue');
    }
}

console.log(`\n${'model'.padEnd(11)} fights  win loss draw  crashed midair shotDown  offensive/fight defensive/fight`);
for (const [m, t] of tally) {
    console.log(`${m.padEnd(11)} ${String(t.fights).padStart(6)} ${String(t.win).padStart(4)} ${String(t.loss).padStart(4)}`
        + ` ${String(t.draw).padStart(4)} ${String(t.crash).padStart(8)} ${String(t.midair).padStart(6)} ${String(t.shotDown).padStart(8)}`
        + ` ${(t.off / t.fights).toFixed(1).padStart(16)} ${(t.def / t.fights).toFixed(1).padStart(15)}`);
}
console.log(`(${((Date.now() - started) / 1000).toFixed(1)} s)`);

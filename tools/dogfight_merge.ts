/**
 * Fly AI-vs-AI merges headless on the real flight model and score them: the
 * bench for tuning the dogfight AI (src/script/physics/sim/dogfightMerge.ts).
 *
 * Every pairing of pilot models flies every merge in MERGE_SETUPS from both
 * sides, so a result is never just the side it started on. Gun spread is the
 * only randomness; runMerge seeds it, so a run repeats exactly.
 *
 * Usage:
 *   node --import tsx tools/dogfight_merge.ts                 # full matrix
 *   node --import tsx tools/dogfight_merge.ts --blue ACE --red SHAW --setup head-on --trace 1
 *   node --import tsx tools/dogfight_merge.ts --models ACE,CLASSIC --seconds 120
 *   node --import tsx tools/dogfight_merge.ts --html dogfights.html   # replay every fight in a browser
 *   node --import tsx tools/dogfight_merge.ts --models CLASSIC,TUNABLE:rookie,TUNABLE:ace
 *   node --import tsx tools/dogfight_merge.ts --models CLASSIC,TUNABLE --personality aggression=1,skill=0.5
 */

import { AiPilotModels } from '../src/script/state/gameDefs';
import { AI_PERSONALITY_PRESETS, aiPersonalityPreset } from '../src/script/ai/tunable/aiPersonality';
import * as fs from 'node:fs';
import { MERGE_SETUPS, MergeResult, MergeSide, MergeSideResult, runMerge, straightPilot } from '../src/script/physics/sim/dogfightMerge';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

const ALL_MODELS: string[] = [AiPilotModels.CLASSIC, AiPilotModels.SHAW, AiPilotModels.AGGRESSIVE, AiPilotModels.ACE];
/**
 * STRAIGHT holds its heading and altitude and never dodges or shoots: a
 * stand-in for a player who flies straight through the merge, so a pass has
 * to be cleared by the AI alone. Only with --models or --blue/--red.
 */
const EXTRA_MODELS = ['STRAIGHT'];

/**
 * BASE is a frozen copy of the classic pilot (src/script/ai/aiPilotBaseline.ts,
 * untracked: copy aiPilot.ts there before changing it) so a change can fight
 * what it replaces.
 */
const BASELINE = 'src/script/ai/aiPilotBaseline.ts';
const baseline = fs.existsSync(BASELINE) ? require('../' + BASELINE).AiPilot : undefined;
if (baseline) ALL_MODELS.push('BASE');

/** TUNABLE, or TUNABLE:<preset> (rookie, ace, berserker, ...): the tunable pilot, see --personality. */
const isTunable = (name: string) => name === 'TUNABLE' || name.startsWith('TUNABLE:');
const parseModel = (s: string) => {
    const name = s.toUpperCase();
    if (isTunable(name)) {
        const preset = name.split(':')[1]?.toLowerCase();
        if (preset && !aiPersonalityPreset(preset)) {
            throw new Error(`unknown personality preset ${preset} (${AI_PERSONALITY_PRESETS.map(p => p.id).join(', ')})`);
        }
        return name;
    }
    if (!ALL_MODELS.includes(name) && !EXTRA_MODELS.includes(name)) {
        throw new Error(`unknown model ${s} (${[...ALL_MODELS, ...EXTRA_MODELS].join(', ')})`);
    }
    return name;
};
/** `--opt combatSpeed=238,gunRange=1100`: pilot options for both sides, over the game's. */
const extraOptions: Record<string, number> = Object.fromEntries((arg('opt') ?? '').split(',').filter(Boolean)
    .map(kv => kv.split('=')).map(([k, v]) => [k, Number(v)]));
/** `--personality aggression=1,skill=0.4`: TUNABLE knobs for every tunable side, over its preset. */
const personalityOverrides: Record<string, number> = Object.fromEntries((arg('personality') ?? '').split(',').filter(Boolean)
    .map(kv => kv.split('=')).map(([k, v]) => [k, Number(v)]));
const sideFor = (name: string): MergeSide => isTunable(name)
    ? {
        model: AiPilotModels.TUNABLE,
        options: {
            ...extraOptions,
            personality: { ...aiPersonalityPreset(name.split(':')[1]?.toLowerCase() ?? 'veteran'), ...personalityOverrides },
        },
    }
    : name === 'BASE'
    ? { model: AiPilotModels.CLASSIC, options: extraOptions, pilot: (ac, world, options) => new baseline(ac, world, options) }
    : name === 'STRAIGHT'
        ? { model: AiPilotModels.CLASSIC, pilot: ac => straightPilot(ac) }
        : { model: name as AiPilotModels, options: extraOptions };


const seconds = Number(arg('seconds') ?? 180);
/** `--html <file>`: also write tools/dogfight_viewer.html with every fight's trace in it. */
const htmlOut = arg('html');
const traceEvery = Number(arg('trace') ?? (htmlOut ? 0.1 : 0));
const printTrace = arg('trace') !== undefined;
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

interface Tally {
    win: number; loss: number; draw: number; crash: number; midair: number; shotDown: number;
    off: number; def: number; fights: number;
    rounds: number; hits: number;
    /** Seconds into the fight of each gun kill this model scored. */
    killTimes: number[];
}
const tally = new Map<string, Tally>();
const tallyOf = (m: string) => {
    let t = tally.get(m);
    if (!t) tally.set(m, t = { win: 0, loss: 0, draw: 0, crash: 0, midair: 0, shotDown: 0, off: 0, def: 0, fights: 0, rounds: 0, hits: 0, killTimes: [] });
    return t;
};
const record = (model: string, me: MergeSideResult, them: MergeSideResult, won: boolean, lostFight: boolean) => {
    const t = tallyOf(model);
    t.rounds += me.roundsFired;
    t.hits += me.hitsScored;
    if (them.shotDown) t.killTimes.push(them.lostAt!);
    t.fights++;
    if (won) t.win++; else if (lostFight) t.loss++; else t.draw++;
    if (me.crashed) t.crash++;
    if (me.midair) t.midair++;
    if (me.shotDown) t.shotDown++;
    t.off += me.offensiveS;
    t.def += me.defensiveS;
};

/**
 * One fight for the viewer. Samples are flat number rows (positions in m,
 * attitudes x/y/z/w, speeds, a firing bit per side, label indices) so the full
 * matrix stays a few MB.
 */
const labelIds = new Map<string, number>();
const labelId = (l: string) => labelIds.get(l) ?? (labelIds.set(l, labelIds.size), labelIds.size - 1);
const fate = (r: MergeSideResult) => r.midair ? 'midair' : r.shotDown ? 'shot down' : r.crashed ? 'crashed' : 'alive';
const replays: unknown[] = [];
const replayOf = (blue: string, red: string, res: MergeResult) => ({
    blue, red, setup: res.setup, winner: res.winner, duration: Math.round(res.duration * 10) / 10,
    minRange: Math.round(res.minRange),
    blueFate: fate(res.blue), redFate: fate(res.red), blueLostAt: res.blue.lostAt, redLostAt: res.red.lostAt,
    blueHits: res.blue.hitsScored, redHits: res.red.hitsScored,
    samples: (res.trace ?? []).map(s => [
        s.t, ...s.blue, ...s.blueQuat, ...s.red, ...s.redQuat, s.blueSpeed, s.redSpeed,
        (s.blueFiring ? 1 : 0) | (s.redFiring ? 2 : 0), labelId(s.blueLabel), labelId(s.redLabel),
    ]),
});

const verbose = pairs.length === 1 || process.argv.includes('--verbose');
const started = Date.now();
for (const [blue, red] of pairs) {
    for (const setup of setups) {
        const res: MergeResult = runMerge(setup, sideFor(blue), sideFor(red), { seconds, traceEvery });
        console.log(`${blue.padEnd(10)} vs ${red.padEnd(10)} ${setup.name.padEnd(15)} -> ${res.winner.padEnd(4)}`
            + ` ${res.duration.toFixed(0).padStart(3)}s minR ${res.minRange.toFixed(0)}`);
        console.log(`   blue ${fmt(res.blue)}`);
        console.log(`   red  ${fmt(res.red)}`);
        if (verbose) {
            console.log(`   blue labels ${topLabels(res.blue)}`);
            console.log(`   red  labels ${topLabels(res.red)}`);
        }
        if (htmlOut) replays.push(replayOf(blue, red, res));
        for (const s of printTrace ? res.trace ?? [] : []) {
            console.log(`     t=${String(s.t).padStart(5)} R=${String(s.range).padStart(5)}`
                + ` B[${s.blue.join(',')}] ${s.blueSpeed}m/s ${s.blueLabel.padEnd(14)}`
                + ` R[${s.red.join(',')}] ${s.redSpeed}m/s ${s.redLabel}`);
        }
        record(blue, res.blue, res.red, res.winner === 'blue', res.winner === 'red');
        record(red, res.red, res.blue, res.winner === 'red', res.winner === 'blue');
    }
}

const median = (xs: number[]) => {
    if (xs.length === 0) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pct = (hits: number, rounds: number) => rounds > 0 ? (100 * hits / rounds).toFixed(1) + '%' : '-';
console.log(`\n${'model'.padEnd(11)} fights  win loss draw  crashed midair shotDown  offensive/fight defensive/fight`
    + `   rounds  hits  hit%  kills  kill-time median/mean`);
const all = { rounds: 0, hits: 0, killTimes: [] as number[], fights: 0 };
for (const [m, t] of tally) {
    console.log(`${m.padEnd(11)} ${String(t.fights).padStart(6)} ${String(t.win).padStart(4)} ${String(t.loss).padStart(4)}`
        + ` ${String(t.draw).padStart(4)} ${String(t.crash).padStart(8)} ${String(t.midair).padStart(6)} ${String(t.shotDown).padStart(8)}`
        + ` ${(t.off / t.fights).toFixed(1).padStart(16)} ${(t.def / t.fights).toFixed(1).padStart(15)}`
        + ` ${String(Math.round(t.rounds)).padStart(8)} ${String(t.hits).padStart(5)} ${pct(t.hits, t.rounds).padStart(5)}`
        + ` ${String(t.killTimes.length).padStart(6)} ${median(t.killTimes).toFixed(0).padStart(10)}`
        + `/${(t.killTimes.reduce((a, b) => a + b, 0) / Math.max(1, t.killTimes.length)).toFixed(0)} s`);
    all.rounds += t.rounds;
    all.hits += t.hits;
    all.killTimes.push(...t.killTimes);
    all.fights += t.fights;
}
// Each fight is counted once per side above; here once.
console.log(`all: ${all.fights / 2} fights, ${all.killTimes.length} kills, hit rate ${pct(all.hits, all.rounds)},`
    + ` kill time median ${median(all.killTimes).toFixed(0)} s mean ${(all.killTimes.reduce((a, b) => a + b, 0) / Math.max(1, all.killTimes.length)).toFixed(0)} s`);
console.log(`(${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (htmlOut) {
    const data = JSON.stringify({ labels: [...labelIds.keys()], fights: replays });
    const page = fs.readFileSync('tools/dogfight_viewer.html', 'utf8').replace('/*MERGES*/null', () => data);
    fs.writeFileSync(htmlOut, page);
    console.log(`wrote ${htmlOut} (${replays.length} fights, ${(page.length / 1e6).toFixed(1)} MB)`);
}

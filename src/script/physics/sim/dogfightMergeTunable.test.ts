import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AI_PERSONALITY_PRESETS, aiPersonalityPreset, AiPersonality, defaultAiPersonality } from '../../ai/tunable/aiPersonality';
import { AiPilotModels } from '../../state/gameDefs';
import { GAME_HEADON, MERGE_SETUPS, MergeSide, runMerge, straightPilot } from './dogfightMerge';

/**
 * The TUNABLE pilot flown through real merges on FM2: every preset must fly
 * safely, and the knobs must move results the way they say. Runs are seeded,
 * so these repeat exactly.
 */
const tunable = (personality: Partial<AiPersonality>): MergeSide =>
    ({ model: AiPilotModels.TUNABLE, options: { personality } });
const CLASSIC: MergeSide = { model: AiPilotModels.CLASSIC };
const STRAIGHT: MergeSide = { model: AiPilotModels.CLASSIC, pilot: ac => straightPilot(ac) };

/** Wins and losses of `side` against `other` over every merge, from both ends. */
function score(side: MergeSide, other: MergeSide, seconds = 120): { wins: number; losses: number } {
    let wins = 0, losses = 0;
    for (const s of MERGE_SETUPS) {
        const a = runMerge(s, side, other, { seconds });
        const b = runMerge(s, other, side, { seconds });
        wins += Number(a.winner === 'blue') + Number(b.winner === 'red');
        losses += Number(a.winner === 'red') + Number(b.winner === 'blue');
    }
    return { wins, losses };
}

for (const preset of AI_PERSONALITY_PRESETS) {
    describe(`Dogfight merge: TUNABLE ${preset.id}`, () => {
        it('passes a head-on merge against itself without a midair', () => {
            const r = runMerge(GAME_HEADON, tunable(preset.personality), tunable(preset.personality), { seconds: 30 });
            assert.equal(r.blue.midair || r.red.midair, false, 'collided at the merge');
        });

        it('never crashes, collides or hangs in the vertical against the classic pilot', () => {
            for (const s of MERGE_SETUPS) {
                const r = runMerge(s, tunable(preset.personality), CLASSIC, { seconds: 120 });
                assert.equal(r.blue.crashed, false, `${s.name}: crashed`);
                assert.equal(r.blue.midair, false, `${s.name}: midair or ground scrape`);
                assert.ok(r.blue.minSpeed > 50, `${s.name}: slowed to ${r.blue.minSpeed.toFixed(0)} m/s`);
                assert.ok(r.blue.slowS < 20, `${s.name}: ${r.blue.slowS.toFixed(0)} s under 90 m/s`);
            }
        });
    });
}

describe('Dogfight merge: TUNABLE knobs', () => {
    it('defaults the personality when none is given', () => {
        const a = runMerge(GAME_HEADON, { model: AiPilotModels.TUNABLE }, CLASSIC, { seconds: 30 });
        const b = runMerge(GAME_HEADON, tunable(defaultAiPersonality()), CLASSIC, { seconds: 30 });
        assert.deepEqual(a.blue, b.blue);
    });

    it('skill makes the difference against the classic pilot', () => {
        const ace = score(tunable(aiPersonalityPreset('ace')!), CLASSIC);
        const rookie = score(tunable(aiPersonalityPreset('rookie')!), CLASSIC);
        assert.ok(ace.wins >= 8, `ace ${JSON.stringify(ace)}`);
        assert.ok(rookie.wins <= 2, `rookie ${JSON.stringify(rookie)}`);
        assert.ok(rookie.losses > ace.losses + 6, `ace ${JSON.stringify(ace)} rookie ${JSON.stringify(rookie)}`);
    });

    it('at full skill it beats every other pilot model', () => {
        // Bench 2026-11-01: 18/3, 18/2, 20/0 and 22/0 of 24 against Classic, Shaw,
        // Aggressive and Ace; before the skill work, 11/12, 5/4, 12/5 and 16/6.
        for (const model of [AiPilotModels.CLASSIC, AiPilotModels.SHAW, AiPilotModels.AGGRESSIVE, AiPilotModels.ACE]) {
            const r = score(tunable(aiPersonalityPreset('ace')!), { model }, 180);
            assert.ok(r.wins >= 15 && r.losses <= 4, `against ${model}: ${JSON.stringify(r)}`);
        }
    });

    it('an aggressive pilot takes the head-on gun pass and a timid one turns aside', () => {
        const bold = runMerge(GAME_HEADON, tunable({ aggression: 1 }), STRAIGHT, { seconds: 10 });
        const timid = runMerge(GAME_HEADON, tunable({ aggression: 0 }), STRAIGHT, { seconds: 10 });
        assert.ok((bold.blue.labels['TUNABLE:GUN_PASS'] ?? 0) > 1, JSON.stringify(bold.blue.labels));
        assert.equal(timid.blue.labels['TUNABLE:GUN_PASS'], undefined, JSON.stringify(timid.blue.labels));
        assert.ok((timid.blue.labels['TUNABLE:LEAD_TURN'] ?? 0) > 1, JSON.stringify(timid.blue.labels));
    });

    it('a defensive pilot breaks and jinks where an undefended one does not', () => {
        const time = (defensiveness: number, maneuver: string) => MERGE_SETUPS.reduce((sum, s) =>
            sum + (runMerge(s, tunable({ defensiveness }), CLASSIC, { seconds: 120 }).blue.labels[`TUNABLE:${maneuver}`] ?? 0), 0);
        // Skilled pilots defend at any defensiveness once they lose a nose race,
        // and unload out of guns range, so the gap is in jinks more than breaks.
        assert.ok(time(1, 'BREAK') > time(0, 'BREAK'));
        assert.ok(time(1, 'JINK') > 0);
        assert.equal(time(0, 'JINK'), 0);
    });

    it('an energy fighter zooms for height a turn fighter does not take', () => {
        const zoom = (energyFighting: number) => MERGE_SETUPS.reduce((sum, s) =>
            sum + (runMerge(s, tunable({ energyFighting }), CLASSIC, { seconds: 120 }).blue.labels['TUNABLE:ZOOM'] ?? 0), 0);
        assert.equal(zoom(0), 0);
        assert.ok(zoom(1) > 10, `zoomed ${zoom(1).toFixed(0)} s`);
    });

    it('gun discipline trades rounds for hit rate', () => {
        const fire = (gunDiscipline: number) => {
            let rounds = 0, hits = 0;
            for (const s of MERGE_SETUPS) {
                const r = runMerge(s, tunable({ gunDiscipline }), CLASSIC, { seconds: 120 });
                rounds += r.blue.roundsFired;
                hits += r.blue.hitsScored;
            }
            return { rounds, rate: hits / Math.max(1, rounds) };
        };
        const spray = fire(0), sniper = fire(1);
        assert.ok(spray.rounds > sniper.rounds * 1.5, `${JSON.stringify(spray)} vs ${JSON.stringify(sniper)}`);
        assert.ok(sniper.rate > spray.rate * 1.5, `${JSON.stringify(spray)} vs ${JSON.stringify(sniper)}`);
    });
});

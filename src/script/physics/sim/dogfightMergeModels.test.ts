import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AiPilotModels } from '../../state/gameDefs';
import { GAME_HEADON, MERGE_SETUPS, MergeSide, runMerge, straightPilot } from './dogfightMerge';

/**
 * The Shaw, Aggressive and Ace pilots flown through real merges on FM2. Until
 * their shared FlightControlComputer took the classic pilot's tracking law,
 * climb cap and merge deconfliction (and their tactics stopped aiming on
 * body axes), none of them ever shot anything down: 0 wins in 96 fights
 * each, 4-11 midairs per matrix, and 62-76 of 96 fights spent over 20 s
 * below 90 m/s, hanging in the vertical.
 */
const setup = (name: string) => MERGE_SETUPS.find(s => s.name === name)!;

/**
 * One kill per model the bench shows it scoring (runs are seeded, so they repeat).
 * Since the gun fires its full cyclic rate, symmetric head-on gun passes often
 * end with both shot down (Shaw head-on and Ace low against Classic now do).
 * Since the stick is rate-limited (2026-11-05) Aggressive and Ace lose the
 * head-on one to Classic's equal pass, and win low (Aggressive also offset
 * 600 m, red 600 m high, red fast, tail chase; Ace offset 600 m, beam,
 * oblique, tail chase).
 */
const KILLS: { model: AiPilotModels; red: AiPilotModels; setup: string }[] = [
    { model: AiPilotModels.SHAW, red: AiPilotModels.CLASSIC, setup: 'low' },
    { model: AiPilotModels.AGGRESSIVE, red: AiPilotModels.CLASSIC, setup: 'low' },
    { model: AiPilotModels.ACE, red: AiPilotModels.CLASSIC, setup: 'low' },
];

for (const { model, red, setup: killSetup } of KILLS) {
    describe(`Dogfight merge: ${model} pilot`, () => {
        it('passes a head-on merge against itself without a midair', () => {
            const r = runMerge(GAME_HEADON, { model }, { model }, { seconds: 30 });
            assert.equal(r.blue.midair || r.red.midair, false, 'collided at the merge');
            assert.ok(r.minRange > 30, `passed ${r.minRange.toFixed(0)} m apart`);
        });

        it(`shoots down ${red} from the ${killSetup} merge`, () => {
            const r = runMerge(setup(killSetup), { model }, { model: red });
            assert.equal(r.winner, 'blue', `blue ${JSON.stringify(r.blue)} red ${JSON.stringify(r.red)}`);
            assert.equal(r.red.shotDown, true);
        });

        it('never crashes, collides or hangs in the vertical against the classic pilot', () => {
            for (const s of MERGE_SETUPS.slice(0, 6)) {
                const r = runMerge(s, { model }, { model: AiPilotModels.CLASSIC }, { seconds: 120 });
                assert.equal(r.blue.crashed, false, `${s.name}: crashed`);
                assert.equal(r.blue.midair, false, `${s.name}: midair`);
                assert.ok(r.blue.minSpeed > 50, `${s.name}: slowed to ${r.blue.minSpeed.toFixed(0)} m/s`);
                assert.ok(r.blue.slowS < 20, `${s.name}: ${r.blue.slowS.toFixed(0)} s under 90 m/s`);
            }
        });
    });
}

/**
 * Every model against a target that flies straight through the merge, as a
 * player may: the head-on gun pass must kill it, and the AI must clear the
 * pass alone. Before the gun pass and the exact miss solution, models took
 * one to three minutes to kill it, or never did.
 */
const STRAIGHT: MergeSide = { model: AiPilotModels.CLASSIC, pilot: ac => straightPilot(ac) };
for (const model of [AiPilotModels.CLASSIC, AiPilotModels.SHAW, AiPilotModels.AGGRESSIVE, AiPilotModels.ACE]) {
    describe(`Dogfight merge: ${model} pilot against a target flying straight`, () => {
        it('kills it on the first head-on pass', () => {
            const r = runMerge(GAME_HEADON, { model }, STRAIGHT, { seconds: 15 });
            assert.equal(r.red.shotDown, true, `red ${JSON.stringify(r.red)}`);
            assert.ok(r.red.lostAt! < 10, `killed at ${r.red.lostAt!.toFixed(1)} s`);
        });

        it('kills it from every merge and never flies into it', () => {
            for (const s of MERGE_SETUPS) {
                const r = runMerge(s, { model }, STRAIGHT, { seconds: 90 });
                assert.equal(r.blue.midair || r.blue.crashed, false, `${s.name}: collided or crashed`);
                assert.equal(r.red.shotDown, true, `${s.name}: not killed`);
            }
        });
    });
}

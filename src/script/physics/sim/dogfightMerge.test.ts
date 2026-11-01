import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AiPilotModels } from '../../state/gameDefs';
import { GAME_HEADON, MERGE_SETUPS, runMerge } from './dogfightMerge';

/**
 * The classic pilot (the game's default opponent) flown through real merges
 * on FM2 against the other pilot models. Before these were pinned, no pilot
 * ever shot another down: head-on merges ended in midairs, and every turning
 * fight ended with both aircraft hanging at 10 m/s in the vertical.
 */
describe('Dogfight merge: classic pilot', () => {
    it('passes a head-on merge against itself without a midair', () => {
        const r = runMerge(GAME_HEADON, { model: AiPilotModels.CLASSIC }, { model: AiPilotModels.CLASSIC }, { seconds: 30 });
        assert.equal(r.blue.midair || r.red.midair, false, 'collided at the merge');
        assert.ok(r.minRange > 30, `passed ${r.minRange.toFixed(0)} m apart`);
    });

    it('keeps its fighting speed through a turning fight', () => {
        const r = runMerge(GAME_HEADON, { model: AiPilotModels.CLASSIC }, { model: AiPilotModels.ACE });
        assert.equal(r.blue.crashed, false);
        assert.ok(r.blue.minSpeed > 60, `slowed to ${r.blue.minSpeed.toFixed(0)} m/s`);
        assert.ok(r.blue.slowS < 20, `${r.blue.slowS.toFixed(0)} s under 90 m/s`);
    });

    it('shoots down Shaw from the game\'s head-on merge', () => {
        const r = runMerge(GAME_HEADON, { model: AiPilotModels.CLASSIC }, { model: AiPilotModels.SHAW });
        assert.equal(r.winner, 'blue', `blue ${JSON.stringify(r.blue)} red ${JSON.stringify(r.red)}`);
        assert.equal(r.red.shotDown, true);
    });

    // All four models now share the gun pass and the tracking law, so the
    // classic pilot no longer beats the others by default; it must still
    // fight cleanly and kill often.
    it('fights the other pilot models cleanly and scores in most merges', () => {
        let kills = 0;
        let fights = 0;
        for (const setup of MERGE_SETUPS.slice(0, 6)) {
            for (const red of [AiPilotModels.SHAW, AiPilotModels.AGGRESSIVE, AiPilotModels.ACE]) {
                const r = runMerge(setup, { model: AiPilotModels.CLASSIC }, { model: red }, { seconds: 120 });
                fights++;
                assert.equal(r.blue.crashed || r.blue.midair, false, `${setup.name} vs ${red}: crashed`);
                if (r.red.shotDown) kills++;
            }
        }
        assert.ok(kills >= fights / 2, `killed ${kills} of ${fights}`);
    });
});

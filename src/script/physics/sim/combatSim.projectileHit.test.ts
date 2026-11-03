import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Faction } from '../../weapons/combatant';
import { CombatSim } from './combatSim';

/**
 * Rounds against a target that moves during the step. The target's pose is its
 * end-of-step one, so the round's step must be tested relative to the target,
 * not as its world segment.
 */
describe('CombatSim projectile hits', () => {
    const DT = 1 / 60;

    /**
     * A target crossing at 1,200 m/s (20 m a step, hit radius 10 m) and a round
     * going across its path at 1,000 m/s. They meet 40 % of the way through the
     * step at x = -12; the round's world segment never comes within 12 m of the
     * target's end-of-step centre.
     */
    function crossing(roundX: number, roundZ0: number): number {
        const sim = new CombatSim();
        sim.setExternalState('target', true, Faction.PLAYER, new THREE.Vector3(0, 0, 0), new THREE.Vector3(1200, 0, 0), true);
        sim.spawnProjectile(new THREE.Vector3(roundX, 0, roundZ0), new THREE.Vector3(0, 0, 1000), Faction.ENEMY, 7);
        sim.step(DT, {});
        return sim.encodeSnapshot().hits.filter(h => h.targetId === 'target').length;
    }

    it('hits a target that crosses the round mid-step', () => {
        assert.equal(crossing(-12, -1000 * DT * 0.4), 1);
    });

    it('misses a round that crossed the target\'s end point before the target got there', () => {
        // The round starts at the target's end-of-step centre and flies on, so its
        // world segment starts inside the hit sphere; but at the start of the step
        // the target was still 20 m short, and the two never come within 12.8 m.
        assert.equal(crossing(0, 0), 0);
    });
});

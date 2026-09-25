import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { AiFlightPhase } from '../../ai/aiPilot';
import { Combatant, Faction } from '../../weapons/combatant';
import { defaultFm2Config } from '../fm2/fm2AircraftConfig';
import { CombatSim } from './combatSim';
import { serializeWorld } from './serializedWorld';

/**
 * Faction target selection: an opponent set on `Faction.PLAYER` must fight the
 * whole friendly side — the player and the wingman — re-picking as the fight
 * develops, instead of tunnelling on whichever aircraft it was handed at spawn.
 *
 * Both friendlies are *external* combatants (scripted position/velocity, the
 * same way the render thread mirrors the player in), so each scenario's
 * geometry is exact.
 */

const BANDIT_ID = 'ai0';
const PLAYER_ID = 'player';
const WINGMAN_ID = 'wing0';

function banditSim(quaternion: THREE.Quaternion = new THREE.Quaternion()): CombatSim {
    const sim = new CombatSim();
    sim.setWorld(serializeWorld([], [], [{
        center: new THREE.Vector3(0, 0, 0),
        heading: 0,
        halfLength: 1000,
        halfWidth: 30,
    }], [], [], []));
    sim.addAircraft({
        id: BANDIT_ID,
        faction: Faction.ENEMY,
        control: 'ai',
        kinematic: false,
        aircraftConfig: defaultFm2Config,
        pilotOptions: { cruiseAltitude: 3000, cruiseSpeed: 200, hardDeck: 150 },
        hitRadius: 10,
        maxHealth: 100,
        spawn: {
            position: [0, 3000, 0],
            quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
            velocity: [0, 0, 200],
            landed: false,
            throttle: 0.7,
            airborne: true,
        },
        enabled: true,
    });
    sim.setPhase(BANDIT_ID, AiFlightPhase.ENGAGE);
    return sim;
}

/** Park a scripted friendly at a fixed point. */
function friendly(sim: CombatSim, id: string, x: number, y: number, z: number, alive = true): void {
    sim.setExternalState(
        id, true, Faction.PLAYER,
        new THREE.Vector3(x, y, z), new THREE.Vector3(0, 0, 200), alive);
}

/** Which combatant the bandit's pilot is currently pointed at, by id. */
function currentTargetId(sim: CombatSim): string | undefined {
    return (sim as unknown as { aircraft: Map<string, { autoTargetId?: string }> })
        .aircraft.get(BANDIT_ID)?.autoTargetId;
}

/** Step long enough for at least one full target re-scan. */
function stepScan(sim: CombatSim, seconds = 0.75): void {
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
        sim.step(dt, {});
    }
}

describe('CombatSim faction targeting', () => {
    it('takes the wingman when it is the closer friendly, not the player', () => {
        const sim = banditSim();
        friendly(sim, PLAYER_ID, 0, 3000, 3000);
        friendly(sim, WINGMAN_ID, 0, 3000, 800);

        sim.setTargetFaction(BANDIT_ID, Faction.PLAYER);
        assert.equal(currentTargetId(sim), WINGMAN_ID);
    });

    it('takes the player when the player is the closer friendly', () => {
        const sim = banditSim();
        friendly(sim, PLAYER_ID, 0, 3000, 800);
        friendly(sim, WINGMAN_ID, 0, 3000, 3000);

        sim.setTargetFaction(BANDIT_ID, Faction.PLAYER);
        assert.equal(currentTargetId(sim), PLAYER_ID);
    });

    it('prefers the friendly it is already pointed at over one barely closer behind it', () => {
        // Bandit nose on +Z.
        const sim = banditSim();
        friendly(sim, PLAYER_ID, 0, 3000, 1000);      // dead ahead
        friendly(sim, WINGMAN_ID, 0, 3000, -900);     // slightly closer, but astern

        sim.setTargetFaction(BANDIT_ID, Faction.PLAYER);
        assert.equal(currentTargetId(sim), PLAYER_ID,
            'range alone would turn its back on the aircraft it is already tracking');
    });

    it('switches to the other friendly once the fight moves decisively', () => {
        const sim = banditSim();
        friendly(sim, PLAYER_ID, 0, 3000, 600);
        friendly(sim, WINGMAN_ID, 0, 3000, 4000);
        sim.setTargetFaction(BANDIT_ID, Faction.PLAYER);
        assert.equal(currentTargetId(sim), PLAYER_ID);

        // The player extends away; the wingman closes right in.
        friendly(sim, PLAYER_ID, 0, 3000, 6000);
        friendly(sim, WINGMAN_ID, 0, 3000, 500);
        stepScan(sim);
        assert.equal(currentTargetId(sim), WINGMAN_ID);
    });

    it('does not swap back and forth between friendlies at a similar range', () => {
        const sim = banditSim();
        friendly(sim, PLAYER_ID, -60, 3000, 1000);
        friendly(sim, WINGMAN_ID, 60, 3000, 1010);
        sim.setTargetFaction(BANDIT_ID, Faction.PLAYER);

        const first = currentTargetId(sim);
        assert.ok(first, 'expected a target');
        for (let i = 0; i < 8; i++) {
            stepScan(sim);
            assert.equal(currentTargetId(sim), first, 'target must not chatter');
        }
    });

    it('rolls onto the surviving friendly when its target dies', () => {
        const sim = banditSim();
        friendly(sim, PLAYER_ID, 0, 3000, 3000);
        friendly(sim, WINGMAN_ID, 0, 3000, 800);
        sim.setTargetFaction(BANDIT_ID, Faction.PLAYER);
        assert.equal(currentTargetId(sim), WINGMAN_ID);

        friendly(sim, WINGMAN_ID, 0, 3000, 800, false);
        // A dead target is replaced immediately, not on the next scheduled scan.
        sim.step(1 / 60, {});
        assert.equal(currentTargetId(sim), PLAYER_ID);
    });

    it('clears the target when the whole faction is down', () => {
        const sim = banditSim();
        friendly(sim, PLAYER_ID, 0, 3000, 800);
        sim.setTargetFaction(BANDIT_ID, Faction.PLAYER);
        assert.equal(currentTargetId(sim), PLAYER_ID);

        friendly(sim, PLAYER_ID, 0, 3000, 800, false);
        sim.step(1 / 60, {});
        assert.equal(currentTargetId(sim), undefined);
    });

    it('never selects a same-faction aircraft', () => {
        const sim = banditSim();
        // Only friendlies to the *player* side exist; a second bandit must be
        // invisible to faction selection.
        sim.addAircraft({
            id: 'ai1',
            faction: Faction.ENEMY,
            control: 'ai',
            kinematic: false,
            aircraftConfig: defaultFm2Config,
            hitRadius: 10,
            maxHealth: 100,
            spawn: {
                position: [0, 3000, 200],
                quaternion: [0, 0, 0, 1],
                velocity: [0, 0, 200],
                landed: false,
                throttle: 0.7,
                airborne: true,
            },
            enabled: true,
        });
        friendly(sim, PLAYER_ID, 0, 3000, 2500);

        sim.setTargetFaction(BANDIT_ID, Faction.PLAYER);
        assert.equal(currentTargetId(sim), PLAYER_ID);
    });

    it('an explicit setTarget cancels faction selection', () => {
        const sim = banditSim();
        friendly(sim, PLAYER_ID, 0, 3000, 3000);
        friendly(sim, WINGMAN_ID, 0, 3000, 800);
        sim.setTargetFaction(BANDIT_ID, Faction.PLAYER);
        assert.equal(currentTargetId(sim), WINGMAN_ID);

        sim.setTarget(BANDIT_ID, PLAYER_ID);
        stepScan(sim);
        assert.equal(currentTargetId(sim), undefined,
            'auto-selection must stay off once a target is set explicitly');
    });
});

/** The pilot must actually receive the switch, not just the bookkeeping id. */
describe('CombatSim faction targeting reaches the pilot', () => {
    it('hands the newly selected combatant to the pilot', () => {
        const sim = banditSim();
        friendly(sim, PLAYER_ID, 0, 3000, 3000);
        friendly(sim, WINGMAN_ID, 0, 3000, 800);
        sim.setTargetFaction(BANDIT_ID, Faction.PLAYER);

        const bandit = (sim as unknown as {
            aircraft: Map<string, { pilot: { setTarget(t: Combatant | undefined): void } }>;
        }).aircraft.get(BANDIT_ID)!;
        const seen: (Combatant | undefined)[] = [];
        const realSetTarget = bandit.pilot.setTarget.bind(bandit.pilot);
        bandit.pilot.setTarget = (t) => { seen.push(t); realSetTarget(t); };

        friendly(sim, WINGMAN_ID, 0, 3000, 800, false);
        sim.step(1 / 60, {});

        assert.equal(seen.length, 1, 'expected exactly one re-target');
        const pos = new THREE.Vector3();
        seen[0]!.readPosition(pos);
        assert.equal(pos.z, 3000, 'pilot should now hold the surviving friendly');
    });
});

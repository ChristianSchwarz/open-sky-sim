import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { AiFlightPhase, FORMATION_SLOT } from '../../ai/aiPilot';
import { Combatant, Faction } from '../../weapons/combatant';
import { defaultFm2Config } from '../fm2/fm2AircraftConfig';
import { CombatSim } from './combatSim';
import { serializeWorld } from './serializedWorld';

/**
 * End-to-end check of the wingman on the real FM2 airframe, through the same
 * worker-side API the game drives (`addAircraft` / `setFormationLead` /
 * `setPhase`). The formation unit tests in `ai/aiPilot.formation.test.ts` run
 * against a kinematic stand-in; this one proves the loops actually fly a real
 * aircraft onto the wing.
 *
 * The lead is an *external* combatant — a scripted position/velocity, exactly
 * how the render thread mirrors the player into the sim — so the reference the
 * wingman flies on is exact.
 */

const WING_ID = 'wing0';
const LEAD_ID = 'lead';

function flatWorldSim(): CombatSim {
    const sim = new CombatSim();
    sim.setWorld(serializeWorld([], [], [{
        center: new THREE.Vector3(0, 0, 0),
        heading: 0,
        halfLength: 1000,
        halfWidth: 30,
    }], [], [], []));
    return sim;
}

/** Read a sim aircraft back out through its Combatant face. */
function readPosition(sim: CombatSim, id: string, out: THREE.Vector3): THREE.Vector3 {
    const aircraft = (sim as unknown as { aircraft: Map<string, Combatant> }).aircraft.get(id);
    assert.ok(aircraft, `no sim aircraft ${id}`);
    return aircraft.readPosition(out);
}

function addWingman(sim: CombatSim, position: THREE.Vector3, velocity: THREE.Vector3): void {
    sim.addAircraft({
        id: WING_ID,
        faction: Faction.PLAYER,
        control: 'ai',
        kinematic: false,
        aircraftConfig: defaultFm2Config,
        pilotOptions: { cruiseAltitude: 3000, cruiseSpeed: 200, hardDeck: 150 },
        hitRadius: 10,
        maxHealth: 100,
        spawn: {
            position: [position.x, position.y, position.z],
            quaternion: [0, 0, 0, 1],
            velocity: [velocity.x, velocity.y, velocity.z],
            landed: false,
            throttle: 0.7,
            airborne: true,
        },
        enabled: true,
    });
}

describe('CombatSim wingman', () => {
    it('flies a real FM2 airframe onto the lead\'s wing', () => {
        const sim = flatWorldSim();
        const leadPos = new THREE.Vector3(0, 3000, 0);
        const leadVel = new THREE.Vector3(0, 0, 200);

        addWingman(sim, new THREE.Vector3(250, 3000, -1000), leadVel.clone());
        sim.setExternalState(LEAD_ID, true, Faction.PLAYER, leadPos, leadVel, true);
        sim.setFormationLead(WING_ID, LEAD_ID);
        sim.setPhase(WING_ID, AiFlightPhase.FORMATION);

        const slot = new THREE.Vector3();
        const wing = new THREE.Vector3();
        const startError = readPosition(sim, WING_ID, wing).distanceTo(
            slot.set(FORMATION_SLOT.side, 3000 + FORMATION_SLOT.stack, -FORMATION_SLOT.trail));
        assert.ok(startError > 800, `startError=${startError}`);

        const dt = 1 / 60;
        for (let i = 0; i < 120 / dt; i++) {
            leadPos.addScaledVector(leadVel, dt);
            sim.setExternalState(LEAD_ID, true, Faction.PLAYER, leadPos, leadVel, true);
            sim.step(dt, {});
        }

        // Lead flies +Z, so the wing slot is offset in +X / -Z from its position.
        slot.set(
            leadPos.x + FORMATION_SLOT.side,
            leadPos.y + FORMATION_SLOT.stack,
            leadPos.z - FORMATION_SLOT.trail,
        );
        readPosition(sim, WING_ID, wing);
        const endError = wing.distanceTo(slot);
        assert.ok(endError < 150, `expected to be on the wing, slot error=${endError}`);
        // Lateral station is the one a pilot actually sees out of the canopy.
        assert.ok(Math.abs(wing.x - slot.x) < 30, `lateral offset=${wing.x - slot.x}`);
    });

    it('does not shoot its own lead — friendly rounds pass the player through', () => {
        const sim = flatWorldSim();
        // Wingman parked directly astern of the lead, guns pointed straight at it.
        const leadPos = new THREE.Vector3(0, 3000, 300);
        const leadVel = new THREE.Vector3(0, 0, 200);
        sim.setExternalState(LEAD_ID, true, Faction.PLAYER, leadPos, leadVel, true);

        sim.addAircraft({
            id: WING_ID,
            faction: Faction.PLAYER,
            control: 'external',
            kinematic: false,
            aircraftConfig: defaultFm2Config,
            hitRadius: 10,
            maxHealth: 100,
            gun: {
                muzzleVelocity: 1000,
                roundsPerSecond: 20,
                damage: 8,
                ammo: 500,
                muzzleOffset: [0, 0, 9],
            },
            spawn: {
                position: [0, 3000, 0],
                quaternion: [0, 0, 0, 1],
                velocity: [0, 0, 200],
                landed: false,
                throttle: 0.7,
                airborne: true,
            },
            enabled: true,
        });

        const dt = 1 / 60;
        const hits: string[] = [];
        for (let i = 0; i < 240; i++) {
            leadPos.addScaledVector(leadVel, dt);
            sim.setExternalState(LEAD_ID, true, Faction.PLAYER, leadPos, leadVel, true);
            sim.step(dt, {
                [WING_ID]: {
                    pitch: 0, roll: 0, yaw: 0, throttle: 0.7,
                    landingGearDeployed: false,
                    flapsExtended: false,
                    airbrakesExtended: false,
                    hookDeployed: false,
                    wheelBrakesApplied: false,
                    pitchLimiterMode: 0,
                    limitersEnabled: true,
                    wantForceVectors: false,
                    firing: true,
                },
            });
            for (const hit of (sim as unknown as { hits: { targetId: string }[] }).hits) {
                hits.push(hit.targetId);
            }
        }
        assert.deepEqual(hits.filter(id => id === LEAD_ID), [],
            'a same-faction wingman must never damage its lead');
    });
});

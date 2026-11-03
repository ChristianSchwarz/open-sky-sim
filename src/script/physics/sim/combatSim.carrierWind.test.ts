import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Faction } from '../../weapons/combatant';
import { FcsPitchLimiter } from '../fm2/fcs';
import { defaultFm2Config, fm2GroundRestHeight } from '../fm2/fm2AircraftConfig';
import { CarrierMeshCollider } from '../../scene/entities/carrierDeck';
import { CombatSim } from './combatSim';
import { serializeWorld } from './serializedWorld';

/**
 * On a moving carrier's deck the gear runs in the deck's frame, but the air
 * does not move with the ship: the flight model must see wind over the deck.
 */
function flatDeckCollider(half: number, deckY: number): CarrierMeshCollider {
    return {
        originX: 0, originY: 0, originZ: 0,
        triangles: [
            -half, deckY, -half, half, deckY, -half, half, deckY, half,
            -half, deckY, -half, half, deckY, half, -half, deckY, half,
        ],
        aabb: { min: [-half, deckY, -half], max: [half, deckY, half] },
    };
}

const BRAKED_RUNUP = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0.3,
    landingGearDeployed: true, flapsExtended: true, airbrakesExtended: false,
    hookDeployed: false, wheelBrakesApplied: true, pitchLimiterMode: FcsPitchLimiter.SOFT,
    limitersEnabled: true, wantForceVectors: false, firing: false,
} as const;

describe('CombatSim carrier deck frame', () => {
    it('gives the flight model the wind over the deck, not the speed over it', () => {
        const deckY = 18;
        const sim = new CombatSim();
        sim.setWorld(serializeWorld([], [], [{
            center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: 100, halfWidth: 20,
        }], [], [flatDeckCollider(60, deckY)]));
        // Ship steaming at 12.5 m/s the way the jet's nose points (-Z).
        const shipVel = new THREE.Vector3(0, 0, -12.5);
        sim.setCarrierVelocity(shipVel.x, shipVel.y, shipVel.z);
        const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
        sim.addAircraft({
            id: 'deck', faction: Faction.PLAYER, control: 'external', kinematic: false,
            aircraftConfig: defaultFm2Config, hitRadius: 5, maxHealth: 100,
            spawn: {
                position: [0, deckY + fm2GroundRestHeight(defaultFm2Config), 0],
                quaternion: [quat.x, quat.y, quat.z, quat.w],
                velocity: [shipVel.x, shipVel.y, shipVel.z],
                throttle: 0.3, landed: true, airborne: false,
            },
            enabled: true,
        });

        const dt = 1 / 60;
        let originZ = 0;
        for (let i = 0; i < 30; i++) {
            originZ += shipVel.z * dt;
            sim.setCarrierMeshOrigins([{ originX: 0, originY: 0, originZ }]);
            sim.step(dt, { deck: { ...BRAKED_RUNUP } });
        }

        const a = (sim as unknown as {
            aircraft: Map<string, { model: { velocityVector: THREE.Vector3; velBody: THREE.Vector3 } }>;
        }).aircraft.get('deck')!;
        // Held by its brakes, it moves with the ship...
        const overDeck = a.model.velocityVector.clone().sub(shipVel);
        assert.ok(overDeck.length() < 1, `moving ${overDeck.length().toFixed(2)} m/s over the deck`);
        // ...and its aero saw the ship's speed as headwind on the nose.
        const air = a.model.velBody;
        assert.ok(Math.abs(air.length() - 12.5) < 1, `airspeed ${air.length().toFixed(2)} m/s`);
        assert.ok(air.z > 11, `headwind along the nose ${air.z.toFixed(2)} m/s`);
    });
});

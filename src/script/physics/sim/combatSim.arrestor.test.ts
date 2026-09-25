import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Faction } from '../../weapons/combatant';
import { FcsPitchLimiter } from '../fm2/fcs';
import { defaultFm2Config, fm2GroundRestHeight } from '../fm2/fm2AircraftConfig';
import {
    ARRESTOR_CABLE_LOCAL_Z,
    ARRESTOR_CABLE_Y,
    ARRESTOR_CARRIER_ORIGIN,
    ARRESTOR_DECK_MID_X,
    DEFAULT_ARRESTOR_HOOK_BODY,
} from '../../scene/entities/arrestorCables';
import { CarrierMeshCollider } from '../../scene/entities/carrierDeck';
import { CombatSim } from './combatSim';
import { defaultArrestorCableField, serializeWorld } from './serializedWorld';

/** Flat deck plate for ride-along tests (local Y above water so carrierHeightAt > 0). */
function flatDeckCollider(half = 30, deckY = 18): CarrierMeshCollider {
    const triangles = [
        -half, deckY, -half, half, deckY, -half, half, deckY, half,
        -half, deckY, -half, half, deckY, half, -half, deckY, half,
    ];
    return {
        originX: 0,
        originY: 0,
        originZ: 0,
        triangles,
        aabb: { min: [-half, deckY, -half], max: [half, deckY, half] },
    };
}

const IDLE_INPUT = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0,
    landingGearDeployed: true,
    flapsExtended: true,
    airbrakesExtended: false,
    hookDeployed: true,
    wheelBrakesApplied: true,
    pitchLimiterMode: FcsPitchLimiter.SOFT,
    limitersEnabled: true,
    wantForceVectors: false,
    firing: false,
} as const;

describe('CombatSim arrestor trap', () => {
    it('snags a cable and stops along the deck', () => {
        const origin = ARRESTOR_CARRIER_ORIGIN;
        const field = defaultArrestorCableField(origin.x, origin.y, origin.z);
        const sim = new CombatSim();
        sim.setWorld(serializeWorld([], [], [{
            center: new THREE.Vector3(0, 0, 0),
            heading: 0,
            halfLength: 100,
            halfWidth: 20,
        }], [], [], [field]));

        const cableZ = origin.z + ARRESTOR_CABLE_LOCAL_Z[0];
        const hookY = origin.y + ARRESTOR_CABLE_Y;
        const midX = origin.x + ARRESTOR_DECK_MID_X;
        const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
        const vel = new THREE.Vector3(0, 0, -55);

        // heading π: body hook maps to world offset applied below.
        const hookBodyWorld = new THREE.Vector3(
            DEFAULT_ARRESTOR_HOOK_BODY[0],
            DEFAULT_ARRESTOR_HOOK_BODY[1],
            DEFAULT_ARRESTOR_HOOK_BODY[2],
        ).applyQuaternion(quat);
        const startHookZ = cableZ + 0.8;
        const cg = new THREE.Vector3(
            midX - hookBodyWorld.x,
            hookY - hookBodyWorld.y,
            startHookZ - hookBodyWorld.z,
        );

        sim.addAircraft({
            id: 'trap-test',
            faction: Faction.PLAYER,
            control: 'external',
            kinematic: false,
            aircraftConfig: defaultFm2Config,
            hitRadius: 5,
            maxHealth: 100,
            spawn: {
                position: [cg.x, cg.y, cg.z],
                quaternion: [quat.x, quat.y, quat.z, quat.w],
                velocity: [vel.x, vel.y, vel.z],
                throttle: 0,
                // airborne:false ⇒ gear starts deployed (player input mirrors that).
                landed: false,
                airborne: false,
            },
            enabled: true,
        });
        // Worker-side player input owns the hook: press H to lower it.
        sim.keyDown('trap-test', 'h', false);

        const dt = 1 / 60;
        let latched = false;
        let stopped = false;
        for (let i = 0; i < 600; i++) {
            // Player input overwrites this each step; keep gear down / throttle idle.
            sim.step(dt, {
                'trap-test': {
                    pitch: 0, roll: 0, yaw: 0, throttle: 0,
                    landingGearDeployed: true,
                    flapsExtended: true,
                    airbrakesExtended: false,
                    hookDeployed: true,
                    wheelBrakesApplied: false,
                    pitchLimiterMode: FcsPitchLimiter.SOFT,
                    limitersEnabled: true,
                    wantForceVectors: false,
                    firing: false,
                },
            });
            const snap = (sim as unknown as {
                aircraft: Map<string, {
                    arrestorLatch: number;
                    arrestorHeld: boolean;
                    model: { velocityVector: THREE.Vector3; isLanded: () => boolean };
                }>;
            }).aircraft.get('trap-test')!;
            if (snap.arrestorLatch >= 0) latched = true;
            const along = -snap.model.velocityVector.z;
            if (latched && along < 1 && snap.model.isLanded()) {
                stopped = true;
                assert.equal(snap.arrestorLatch >= 0, true, 'cable should stay latched while stopped');
                assert.equal(snap.arrestorHeld, true, 'expected held-after-stop state');
                break;
            }
        }
        assert.equal(latched, true, 'expected cable snag');
        assert.equal(stopped, true, 'expected stop after trap');

        // Stay parked a few frames — cable must remain bent/latched.
        for (let i = 0; i < 30; i++) {
            sim.step(dt, {
                'trap-test': {
                    pitch: 0, roll: 0, yaw: 0, throttle: 0,
                    landingGearDeployed: true,
                    flapsExtended: true,
                    airbrakesExtended: false,
                    hookDeployed: true,
                    wheelBrakesApplied: true,
                    pitchLimiterMode: FcsPitchLimiter.SOFT,
                    limitersEnabled: true,
                    wantForceVectors: false,
                    firing: false,
                },
            });
        }
        const parked = (sim as unknown as {
            aircraft: Map<string, { arrestorLatch: number; arrestorHeld: boolean }>;
        }).aircraft.get('trap-test')!;
        assert.ok(parked.arrestorLatch >= 0, 'cable should remain on hook while standing still');
        assert.equal(parked.arrestorHeld, true);
    });

    it('landed aircraft matches setCarrierVelocity on deck', () => {
        const deckY = 18;
        const deck = flatDeckCollider(40, deckY);
        const sim = new CombatSim();
        sim.setWorld(serializeWorld([], [], [{
            center: new THREE.Vector3(0, 0, 0),
            heading: 0,
            halfLength: 100,
            halfWidth: 20,
        }], [], [deck]));

        const restY = fm2GroundRestHeight(defaultFm2Config);
        const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
        const shipVel = new THREE.Vector3(0, 0, -12.5);
        sim.setCarrierVelocity(shipVel.x, shipVel.y, shipVel.z);

        const spawnX = 2;
        const spawnZ = -3;
        sim.addAircraft({
            id: 'ride-test',
            faction: Faction.PLAYER,
            control: 'external',
            kinematic: false,
            aircraftConfig: defaultFm2Config,
            hitRadius: 5,
            maxHealth: 100,
            spawn: {
                position: [spawnX, deckY + restY, spawnZ],
                quaternion: [quat.x, quat.y, quat.z, quat.w],
                velocity: [shipVel.x, shipVel.y, shipVel.z],
                throttle: 0,
                landed: true,
                airborne: false,
            },
            enabled: true,
        });

        const dt = 1 / 60;
        const steps = 120;
        type RideAc = {
            model: {
                position: THREE.Vector3;
                velocityVector: THREE.Vector3;
                isLanded: () => boolean;
            };
            carrierParkLocalX: number;
            carrierParkLocalZ: number;
            carrierParkLocalValid: boolean;
        };

        // Capture ship-local offset at the initial mesh origin (mirrors spawn).
        sim.step(dt, { 'ride-test': { ...IDLE_INPUT } });
        const parked0 = (sim as unknown as { aircraft: Map<string, RideAc> }).aircraft.get('ride-test')!;
        assert.equal(parked0.carrierParkLocalValid, true);
        const localX = parked0.carrierParkLocalX;
        const localZ = parked0.carrierParkLocalZ;

        let originX = 0;
        let originZ = 0;
        for (let i = 0; i < steps; i++) {
            originX += shipVel.x * dt;
            originZ += shipVel.z * dt;
            sim.setCarrierMeshOrigins([{ originX, originY: 0, originZ }]);
            sim.step(dt, { 'ride-test': { ...IDLE_INPUT } });
        }

        const a = (sim as unknown as { aircraft: Map<string, RideAc> }).aircraft.get('ride-test')!;
        assert.equal(a.model.isLanded(), true);
        assert.equal(a.carrierParkLocalValid, true);
        assert.ok(
            Math.abs(a.carrierParkLocalX - localX) < 1e-9,
            `local X drifted: ${a.carrierParkLocalX} vs ${localX}`,
        );
        assert.ok(
            Math.abs(a.carrierParkLocalZ - localZ) < 1e-9,
            `local Z drifted: ${a.carrierParkLocalZ} vs ${localZ}`,
        );
        assert.ok(
            Math.abs(a.model.velocityVector.z - shipVel.z) < 0.05,
            `expected ship vz, got ${a.model.velocityVector.z}`,
        );
        assert.ok(
            Math.abs(a.model.position.x - (originX + localX)) < 0.05,
            `world X ${a.model.position.x} vs ${originX + localX}`,
        );
        assert.ok(
            Math.abs(a.model.position.z - (originZ + localZ)) < 0.05,
            `world Z ${a.model.position.z} vs ${originZ + localZ}`,
        );
    });
});

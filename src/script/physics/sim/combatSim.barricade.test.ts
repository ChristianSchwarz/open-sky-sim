import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Faction } from '../../weapons/combatant';
import { FcsPitchLimiter } from '../fm2/fcs';
import { defaultFm2Config, fm2GroundRestHeight } from '../fm2/fm2AircraftConfig';
import { CarrierMeshCollider } from '../../scene/entities/carrierDeck';
import {
    BarricadeEngagement,
    BARRICADE_DECK_Y,
    BARRICADE_HALF_SPAN_M,
    BARRICADE_LOCAL_Z,
    BARRICADE_MAX_DECEL_MPS2,
    BARRICADE_MID_X,
    BARRICADE_PULL_OUT_M,
} from '../../scene/entities/barricadeSpec';
import { CombatSim } from './combatSim';
import { serializeWorld, SerializedBarricade } from './serializedWorld';

/*
 * The deck has to be there: without it the aircraft is in free fall and every
 * assertion fails for reasons that have nothing to do with the net.
 */
function flatDeck(): CarrierMeshCollider {
    const y = BARRICADE_DECK_Y;
    const x0 = -60, x1 = 60, z0 = -150, z1 = 150;
    return {
        originX: 0,
        originY: 0,
        originZ: 0,
        triangles: [
            x0, y, z0, x1, y, z0, x1, y, z1,
            x0, y, z0, x1, y, z1, x0, y, z1,
        ],
        aabb: { min: [x0, y, z0], max: [x1, y, z1] },
    };
}

const INPUT = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0,
    landingGearDeployed: true,
    flapsExtended: true,
    airbrakesExtended: false,
    hookDeployed: false,
    wheelBrakesApplied: false,
    pitchLimiterMode: FcsPitchLimiter.SOFT,
    limitersEnabled: true,
    wantForceVectors: false,
    firing: false,
} as const;

type Ac = {
    barricadeState: BarricadeEngagement;
    model: { position: THREE.Vector3; velocityVector: THREE.Vector3; isLanded: () => boolean };
};

const ID = 'net-test';
const HEADING_BOW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

function rig(armed: boolean, generation = 1): SerializedBarricade {
    return { originX: 0, originY: 0, originZ: 0, quaternion: [0, 0, 0, 1], armed, generation };
}

/** A sim with the deck and one aircraft rolling at `speed` toward the bow, `aft` metres short of the net. */
function rollingAt(opts: { speed: number; aft?: number; x?: number; height?: number; armed?: boolean }): CombatSim {
    const sim = new CombatSim();
    sim.setWorld(serializeWorld([], [], [], [], [flatDeck()]));
    sim.setBarricades([rig(opts.armed ?? true)]);
    const onDeck = opts.height === undefined;
    const y = BARRICADE_DECK_Y + (opts.height ?? fm2GroundRestHeight(defaultFm2Config));
    const q = HEADING_BOW;
    sim.addAircraft({
        id: ID,
        faction: Faction.PLAYER,
        control: 'ai',
        kinematic: false,
        aircraftConfig: defaultFm2Config,
        hitRadius: 5,
        maxHealth: 100,
        spawn: {
            position: [BARRICADE_MID_X + (opts.x ?? 0), y, BARRICADE_LOCAL_Z + (opts.aft ?? 10)],
            quaternion: [q.x, q.y, q.z, q.w],
            velocity: [0, 0, -opts.speed],
            throttle: 0,
            landed: onDeck,
            airborne: !onDeck,
        },
        enabled: true,
    });
    return sim;
}

function ac(sim: CombatSim): Ac {
    return (sim as unknown as { aircraft: Map<string, Ac> }).aircraft.get(ID)!;
}

const DT = 1 / 60;

describe('CombatSim barricade', () => {
    it('catches a rolling aircraft and stops it within the run-out', () => {
        const sim = rollingAt({ speed: 60 });
        let caughtAtZ = NaN;
        let peakDecel = 0;
        let prevVz = ac(sim).model.velocityVector.z;
        for (let i = 0; i < 900 && ac(sim).barricadeState !== BarricadeEngagement.HELD; i++) {
            sim.step(DT, { [ID]: { ...INPUT } });
            const a = ac(sim);
            if (Number.isNaN(caughtAtZ) && a.barricadeState !== BarricadeEngagement.NONE) {
                caughtAtZ = a.model.position.z;
            }
            if (a.barricadeState === BarricadeEngagement.PULLING) {
                peakDecel = Math.max(peakDecel, (a.model.velocityVector.z - prevVz) / DT);
            }
            prevVz = a.model.velocityVector.z;
        }
        const a = ac(sim);
        assert.equal(a.barricadeState, BarricadeEngagement.HELD);
        assert.ok(Math.abs(caughtAtZ - BARRICADE_LOCAL_Z) < 2, `caught at z=${caughtAtZ}`);
        const runOut = caughtAtZ - a.model.position.z;
        assert.ok(runOut > 40 && runOut <= BARRICADE_PULL_OUT_M + 1, `run-out ${runOut.toFixed(1)} m`);
        assert.ok(peakDecel <= BARRICADE_MAX_DECEL_MPS2 * 1.05, `peak ${(peakDecel / 9.81).toFixed(2)} g`);
        assert.ok(Math.abs(a.model.velocityVector.z) < 1, `still moving ${a.model.velocityVector.z}`);
    });

    it('holds the aircraft at full throttle until fresh webbing is rigged', () => {
        const sim = rollingAt({ speed: 50 });
        for (let i = 0; i < 900 && ac(sim).barricadeState !== BarricadeEngagement.HELD; i++) {
            sim.step(DT, { [ID]: { ...INPUT } });
        }
        assert.equal(ac(sim).barricadeState, BarricadeEngagement.HELD);
        const heldZ = ac(sim).model.position.z;
        for (let i = 0; i < 120; i++) {
            sim.step(DT, { [ID]: { ...INPUT, throttle: 1 } });
        }
        assert.ok(Math.abs(ac(sim).model.position.z - heldZ) < 0.5, 'dragged the net forward');
        // The main thread has not heard of the catch and still says armed:
        // the same generation must not re-arm the expended webbing.
        sim.setBarricades([rig(true, 1)]);
        assert.equal(ac(sim).barricadeState, BarricadeEngagement.HELD);
        sim.setBarricades([rig(true, 2)]);
        assert.equal(ac(sim).barricadeState, BarricadeEngagement.NONE);
    });

    it('lets an aircraft through when the webbing is down', () => {
        const sim = rollingAt({ speed: 40, armed: false });
        for (let i = 0; i < 60; i++) {
            sim.step(DT, { [ID]: { ...INPUT } });
        }
        assert.equal(ac(sim).barricadeState, BarricadeEngagement.NONE);
        assert.ok(ac(sim).model.position.z < BARRICADE_LOCAL_Z - 10);
    });

    it('misses outside the stanchions', () => {
        const sim = rollingAt({ speed: 40, x: BARRICADE_HALF_SPAN_M + 2 });
        for (let i = 0; i < 60; i++) {
            sim.step(DT, { [ID]: { ...INPUT } });
        }
        assert.equal(ac(sim).barricadeState, BarricadeEngagement.NONE);
    });

    it('misses an aircraft flying over the stanchions', () => {
        const sim = rollingAt({ speed: 80, height: 15 });
        for (let i = 0; i < 30; i++) {
            sim.step(DT, { [ID]: { ...INPUT, landingGearDeployed: false } });
        }
        assert.ok(ac(sim).model.position.z < BARRICADE_LOCAL_Z, 'never reached the net');
        assert.equal(ac(sim).barricadeState, BarricadeEngagement.NONE);
    });
});

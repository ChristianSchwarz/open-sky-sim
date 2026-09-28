import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { SceneWorldQuery } from '../../ai/worldQuery';
import { SurfacePadCollider } from '../../scene/entities/surfacePad';
import { Faction } from '../../weapons/combatant';
import { defaultFm2Config } from '../fm2/fm2AircraftConfig';
import { CombatSim } from './combatSim';
import { serializeStaticColliders, serializeWorld } from './serializedWorld';

/**
 * An airfield streamed in mid-flight sends its buildings to the sim on their
 * own (`addStaticColliders`) rather than as a whole new world, which would
 * leave every pilot holding the old one.
 */

const ROOF: SurfacePadCollider = {
    centerX: 500, centerZ: 500, heading: 0.4,
    halfLength: 30, halfWidth: 20,
    surfaceY: 30, baseY: 0, feather: 0.5,
};

function serializedFlatWorld() {
    return serializeWorld([], [], [{
        center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: 1000, halfWidth: 30,
    }], [], [], []);
}

function worldOf(sim: CombatSim): SceneWorldQuery {
    const world = (sim as unknown as { world: SceneWorldQuery | undefined }).world;
    assert.ok(world, 'the sim has no world');
    return world;
}

const OBSTACLE = { position: new THREE.Vector3(500, 0, 500), radius: 36, height: 30 };

describe('CombatSim.addStaticColliders', () => {
    it('makes a roof solid in the world the sim already holds', () => {
        const sim = new CombatSim();
        sim.setWorld(serializedFlatWorld());
        const world = worldOf(sim);
        assert.equal(world.groundHeightAt(500, 500), 0);

        sim.addStaticColliders(serializeStaticColliders([ROOF], [OBSTACLE]));

        assert.equal(worldOf(sim), world, 'the world was replaced, not extended');
        assert.equal(world.groundHeightAt(500, 500), 30);
        assert.equal(world.groundHeightAt(700, 700), 0);
        assert.equal(world.obstacles().length, 1);
        assert.equal(world.obstacles()[0].radius, 36);
    });

    it('holds colliders sent before the world and applies them when it arrives', () => {
        const sim = new CombatSim();
        sim.addStaticColliders(serializeStaticColliders([ROOF], []));
        sim.setWorld(serializedFlatWorld());
        assert.equal(worldOf(sim).groundHeightAt(500, 500), 30);
    });

    it('leaves an AI pilot in place, reading the extended world', () => {
        const sim = new CombatSim();
        sim.setWorld(serializedFlatWorld());
        sim.addAircraft({
            id: 'ai0',
            faction: Faction.ENEMY,
            control: 'ai',
            kinematic: false,
            aircraftConfig: defaultFm2Config,
            pilotOptions: { cruiseAltitude: 3000, cruiseSpeed: 200, hardDeck: 150 },
            hitRadius: 10,
            maxHealth: 100,
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
        const aircraft = (sim as unknown as { aircraft: Map<string, { pilot: unknown }> }).aircraft.get('ai0');
        assert.ok(aircraft?.pilot, 'no pilot was built');
        const pilot = aircraft.pilot;

        sim.addStaticColliders(serializeStaticColliders([ROOF], [OBSTACLE]));

        assert.equal(aircraft.pilot, pilot, 'the pilot was rebuilt');
        assert.equal(worldOf(sim).groundHeightAt(500, 500), 30);
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { computeTacticalGeometry } from '../shaw/shawGeometry';
import { AceTacticalFSM } from './aceTacticalFsm';
import { AceSnapshot } from './aceTypes';

function snap(opts: {
    pos: [number, number, number];
    vel: [number, number, number];
    acc?: [number, number, number];
    corner?: number;
}): AceSnapshot {
    const velocity = new THREE.Vector3(...opts.vel);
    const forward = velocity.lengthSq() > 1e-6
        ? velocity.clone().normalize()
        : new THREE.Vector3(0, 0, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, forward).normalize();
    up.crossVectors(forward, right).normalize();
    return {
        position: new THREE.Vector3(...opts.pos),
        velocity,
        forward,
        up,
        right,
        acceleration: new THREE.Vector3(...(opts.acc ?? [0, 0, 0])),
        altitude: opts.pos[1],
        airspeed: velocity.length(),
        cornerVelocity: opts.corner ?? 200,
        maxG: 9,
    };
}

describe('AceTacticalFSM state classification', () => {
    it('classifies a bandit in front and in range as CONTROL', () => {
        const fsm = new AceTacticalFSM({ gunRange: 900 });
        const self = snap({ pos: [0, 2000, 0], vel: [0, 0, 200] });
        const target = snap({ pos: [0, 2000, 800], vel: [0, 0, 190] });
        const command = fsm.update(self, target, 1 / 60);
        assert.equal(command.stateName, 'CONTROL');
    });

    it('classifies a bandit tracking our six as EVADE', () => {
        const fsm = new AceTacticalFSM({ gunRange: 900 });
        const self = snap({ pos: [0, 2000, 800], vel: [0, 0, 180] });
        const target = snap({ pos: [0, 2000, 0], vel: [0, 0, 200] });
        const command = fsm.update(self, target, 1 / 60);
        assert.equal(command.stateName, 'EVADE');
    });

    it('classifies a distant head-on pass as MERGE', () => {
        const fsm = new AceTacticalFSM({ gunRange: 900 });
        const self = snap({ pos: [0, 2000, 0], vel: [0, 0, 200] });
        const target = snap({ pos: [0, 2000, 6000], vel: [0, 0, -200] });
        const geom = computeTacticalGeometry(self, target);
        assert.ok(geom.range > 5000, `range=${geom.range}`);
        const command = fsm.update(self, target, 1 / 60);
        assert.equal(command.stateName, 'MERGE');
        assert.equal(command.maneuverName, 'LEAD_TURN');
    });
});

describe('AceTacticalFSM energy discipline', () => {
    it('enters RESET and zoom-climbs away when decisively down on energy', () => {
        const fsm = new AceTacticalFSM({ gunRange: 900 });
        // Low and slow against a bandit that is high and fast, and not being
        // tracked: the classic "leave and rebuild" picture.
        const self = snap({ pos: [0, 400, 0], vel: [0, 0, 120] });
        const target = snap({ pos: [3000, 4000, 0], vel: [0, 0, 260] });
        const geom = computeTacticalGeometry(self, target);
        assert.ok(geom.energyDelta < -900, `energyDelta=${geom.energyDelta}`);

        const command = fsm.update(self, target, 1 / 60);
        assert.equal(command.stateName, 'RESET');
        assert.equal(command.maneuverName, 'ZOOM_CLIMB');
        // Extending means opening the range, not pressing the LOS.
        assert.ok(command.targetDirection.dot(geom.losVector) < 0);
        assert.equal(command.fireGuns, false, 'never shoots while extending');
    });

    it('never extends while the bandit is pointing at us, however bad the energy state', () => {
        const fsm = new AceTacticalFSM({ gunRange: 900 });
        const self = snap({ pos: [0, 400, 1500], vel: [0, 0, 120] });
        const target = snap({ pos: [0, 4000, 0], vel: [0, 0, 260] });
        const geom = computeTacticalGeometry(self, target);
        assert.ok(geom.energyDelta < -900, `energyDelta=${geom.energyDelta}`);
        assert.ok(geom.taa < 70 * Math.PI / 180, `taa=${geom.taa}`);

        const command = fsm.update(self, target, 1 / 60);
        assert.notEqual(command.stateName, 'RESET');
    });
});

describe('AceTacticalFSM signature maneuvers', () => {
    it('answers a close merge with a pull into the vertical', () => {
        const fsm = new AceTacticalFSM({ gunRange: 900 });
        // Offset laterally so the pass is neutral rather than a guns snapshot.
        const self = snap({ pos: [0, 2000, 0], vel: [0, 0, 200] });
        const target = snap({ pos: [600, 2000, 900], vel: [0, 0, -200] });
        const command = fsm.update(self, target, 1 / 60);
        assert.equal(command.stateName, 'MERGE');
        assert.equal(command.maneuverName, 'VERTICAL_REPOSITION');
        assert.ok(command.targetDirection.y > 0.7, `aim.y=${command.targetDirection.y}`);
    });

    it('requests a Cobra when a fast bandit closes to guns range on our six', () => {
        const fsm = new AceTacticalFSM({ gunRange: 900 });
        const self = snap({ pos: [0, 3000, 500], vel: [0, 0, 150] });
        const target = snap({ pos: [0, 3000, 0], vel: [0, 0, 280] });
        const command = fsm.update(self, target, 1 / 60);
        assert.equal(command.stateName, 'EVADE');
        assert.equal(command.maneuverName, 'COBRA_BRAKE');
        assert.equal(command.postStall, 'COBRA');
        assert.equal(command.useAirbrakes, true);
    });

    it('requests a Kulbit once the bandit has slid past', () => {
        const fsm = new AceTacticalFSM({ gunRange: 900 });
        // Bandit behind us but now separating: the overshoot has happened.
        const self = snap({ pos: [0, 3000, 700], vel: [0, 0, 240] });
        const target = snap({ pos: [0, 3000, 100], vel: [0, 0, 140] });
        const command = fsm.update(self, target, 1 / 60);
        assert.equal(command.stateName, 'EVADE');
        assert.equal(command.maneuverName, 'KULBIT');
        assert.equal(command.postStall, 'KULBIT');
    });

    it('rolls the scissors aim out of plane over time instead of holding one direction', () => {
        const fsm = new AceTacticalFSM({ gunRange: 900 });
        // Close but stable range: no overshoot either way, so it scissors.
        const self = snap({ pos: [0, 3000, 850], vel: [0, 0, 200] });
        const target = snap({ pos: [0, 3000, 0], vel: [0, 0, 200] });

        const first = fsm.update(self, target, 1 / 60);
        assert.equal(first.maneuverName, 'ROLLING_SCISSORS');
        const firstDir = first.targetDirection.clone();

        for (let i = 0; i < 30; i++) {
            fsm.update(self, target, 1 / 60);
        }
        const later = fsm.update(self, target, 1 / 60);
        assert.equal(later.maneuverName, 'ROLLING_SCISSORS');
        assert.ok(
            later.targetDirection.distanceTo(firstDir) > 0.2,
            'barrel phase should sweep the aim around the LOS',
        );
    });

    it('barrel-roll attacks rather than overshooting at knife range', () => {
        const fsm = new AceTacticalFSM({ gunRange: 900 });
        const self = snap({ pos: [0, 3000, 0], vel: [0, 0, 300] });
        const target = snap({ pos: [0, 3000, 400], vel: [0, 0, 150] });
        const command = fsm.update(self, target, 1 / 60);
        assert.equal(command.stateName, 'CONTROL');
        assert.equal(command.maneuverName, 'BARREL_ROLL_ATTACK');
        assert.equal(command.useAirbrakes, true);
    });
});

describe('AceTacticalFSM gunnery', () => {
    it('leads a crossing target off the raw line of sight', () => {
        const fsm = new AceTacticalFSM({ gunRange: 900, bulletSpeed: 1000 });
        // Dead six but the bandit is crossing hard to the right.
        const self = snap({ pos: [0, 3000, 0], vel: [0, 0, 200] });
        const target = snap({ pos: [0, 3000, 600], vel: [120, 0, 160] });
        const geom = computeTacticalGeometry(self, target);
        const command = fsm.update(self, target, 1 / 60);

        assert.equal(command.stateName, 'CONTROL');
        assert.equal(command.maneuverName, 'LEAD_PURSUIT');
        // The lead solution must point ahead of the bandit, not at it.
        assert.ok(command.targetDirection.x > geom.losVector.x + 0.05,
            `aim.x=${command.targetDirection.x} los.x=${geom.losVector.x}`);
    });
});

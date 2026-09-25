import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { AiPilotModels } from '../../state/gameDefs';
import { clamp } from '../../utils/math';
import { Combatant, Faction } from '../../weapons/combatant';
import { AiFlightPhase } from '../aiPilot';
import { PilotableAircraft } from '../aircraftControls';
import { createAiPilot } from '../createAiPilot';
import { Runway, WorldQuery } from '../worldQuery';
import { AceAiPilot } from './aceAiPilot';

const FORWARD = new THREE.Vector3(0, 0, 1);

class FakeAircraft implements PilotableAircraft {
    readonly position = new THREE.Vector3();
    readonly velocity = new THREE.Vector3();
    readonly quaternion = new THREE.Quaternion();
    heading = 0;
    pitchAngle = 0;
    airspeed = 200;
    crashed = false;

    pitchCmd = 0;
    rollCmd = 0;
    throttleCmd = 0;
    airbrakes = false;

    setPitch(pitch: number): void { this.pitchCmd = pitch; }
    setRoll(roll: number): void { this.rollCmd = roll; }
    setYaw(_yaw: number): void { /* not modelled */ }
    setThrottle(throttle: number): void { this.throttleCmd = throttle; }
    setWheelBrakes(_applied: boolean): void { /* not modelled */ }
    setLandingGearDeployed(_deployed: boolean): void { /* not modelled */ }
    setFlapsExtended(_extended: boolean): void { /* not modelled */ }
    setAirbrakesExtended(extended: boolean): void { this.airbrakes = extended; }

    getPosition(): THREE.Vector3 { return this.position; }
    getVelocity(): THREE.Vector3 { return this.velocity; }
    getQuaternion(): THREE.Quaternion { return this.quaternion; }
    getAirspeed(): number { return this.airspeed; }
    getAltitude(): number { return this.position.y; }
    getAngleOfAttack(): number { return 0; }
    getLoadFactorG(): number { return 1; }
    getStallStatus(): number { return -1; }
    isLanded(): boolean { return false; }
    isCrashed(): boolean { return this.crashed; }
    isGearDeployed(): boolean { return false; }
    isFlapsExtended(): boolean { return false; }
    isAirbrakesExtended(): boolean { return this.airbrakes; }

    /** Same coarse kinematic stand-in the Shaw/Aggressive pilot tests fly. */
    step(delta: number): void {
        const TURN_RATE_MAX = 1.0;
        const PITCH_RATE_MAX = 0.8;
        this.heading += this.rollCmd * TURN_RATE_MAX * delta;
        this.pitchAngle = clamp(this.pitchAngle + this.pitchCmd * PITCH_RATE_MAX * delta, -1.3, 1.3);
        const equilibriumSpeed = 50 + this.throttleCmd * 300;
        this.airspeed = Math.max(30, this.airspeed + (equilibriumSpeed - this.airspeed) * 0.5 * delta);
        const fwd = new THREE.Vector3(
            Math.sin(this.heading) * Math.cos(this.pitchAngle),
            Math.sin(this.pitchAngle),
            Math.cos(this.heading) * Math.cos(this.pitchAngle),
        );
        this.velocity.copy(fwd).multiplyScalar(this.airspeed);
        this.position.addScaledVector(this.velocity, delta);
        this.quaternion.setFromUnitVectors(FORWARD, fwd);
    }
}

class FakeTarget implements Combatant {
    faction = Faction.PLAYER;
    readonly position = new THREE.Vector3();
    readonly velocity = new THREE.Vector3();
    alive = true;
    hitRadius = 10;

    readPosition(target: THREE.Vector3): THREE.Vector3 { return target.copy(this.position); }
    readVelocity(target: THREE.Vector3): THREE.Vector3 { return target.copy(this.velocity); }
    getHitRadius(): number { return this.hitRadius; }
    isAlive(): boolean { return this.alive; }
    applyDamage(_amount: number): void { /* ignore */ }

    step(delta: number): void { this.position.addScaledVector(this.velocity, delta); }
}

class FlatWorld implements WorldQuery {
    groundHeightAt(): number { return 0; }
    isLand(): boolean { return true; }
    obstacles(): [] { return []; }
    runway(): Runway {
        return { center: new THREE.Vector3(), heading: 0, halfLength: 1000, halfWidth: 30 };
    }
}

/** Bandit closing fast from directly astern — the Cobra picture. */
function sixOClockThreat(altitude: number): { ac: FakeAircraft; tgt: FakeTarget } {
    const ac = new FakeAircraft();
    ac.position.set(0, altitude, 500);
    ac.airspeed = 150;
    ac.velocity.set(0, 0, 150);
    ac.quaternion.setFromUnitVectors(FORWARD, new THREE.Vector3(0, 0, 1));

    const tgt = new FakeTarget();
    tgt.position.set(0, altitude, 0);
    tgt.velocity.set(0, 0, 280);
    return { ac, tgt };
}

describe('createAiPilot factory', () => {
    it('returns AceAiPilot when model is ACE', () => {
        const pilot = createAiPilot(new FakeAircraft(), new FlatWorld(), { model: AiPilotModels.ACE });
        assert.ok(pilot instanceof AceAiPilot);
    });
});

describe('AceAiPilot post-stall maneuvers', () => {
    it('flies a Cobra when a fast bandit closes to guns range on the six', () => {
        const { ac, tgt } = sixOClockThreat(3000);
        const pilot = new AceAiPilot(ac, new FlatWorld(), { gunRange: 900, combatSpeed: 200 });
        pilot.setPhase(AiFlightPhase.ENGAGE);
        pilot.setTarget(tgt);

        pilot.update(1 / 60);
        assert.equal(pilot.getAceStateLabel(), 'EVADE');
        assert.equal(pilot.getPostStallManeuver(), 'COBRA');
        assert.equal(pilot.getManeuverLabel(), 'ACE:COBRA_BRAKE');
        // Departed flight: full aft stick, airbrakes out, throttle chopped.
        assert.equal(ac.pitchCmd, 1);
        assert.equal(ac.airbrakes, true);
        assert.equal(ac.throttleCmd, 0);
    });

    it('vetoes the Cobra when there is no height to recover in', () => {
        const { ac, tgt } = sixOClockThreat(300);
        const pilot = new AceAiPilot(ac, new FlatWorld(), { gunRange: 900, combatSpeed: 200 });
        pilot.setPhase(AiFlightPhase.ENGAGE);
        pilot.setTarget(tgt);

        pilot.update(1 / 60);
        assert.equal(pilot.getAceStateLabel(), 'EVADE');
        assert.equal(pilot.getPostStallManeuver(), undefined,
            'must not depart from controlled flight down low');
    });

    it('recovers from the Cobra and hands control back to the flight control computer', () => {
        const { ac, tgt } = sixOClockThreat(3000);
        const pilot = new AceAiPilot(ac, new FlatWorld(), { gunRange: 900, combatSpeed: 200 });
        pilot.setPhase(AiFlightPhase.ENGAGE);
        pilot.setTarget(tgt);

        pilot.update(1 / 60);
        assert.equal(pilot.getPostStallManeuver(), 'COBRA');

        // The maneuver is timed: it must end on its own, not latch forever.
        for (let i = 0; i < 180; i++) {
            pilot.update(1 / 60);
            ac.step(1 / 60);
            tgt.step(1 / 60);
            if (pilot.getPostStallManeuver() === undefined) break;
        }
        assert.equal(pilot.getPostStallManeuver(), undefined);
        // ...and not immediately re-entered: the cooldown has to run out first.
        pilot.update(1 / 60);
        assert.equal(pilot.getPostStallManeuver(), undefined);
    });
});

describe('AceAiPilot trigger discipline', () => {
    it('fires when the ballistic solution connects', () => {
        const ac = new FakeAircraft();
        ac.position.set(0, 3000, 0);
        ac.airspeed = 200;
        ac.velocity.set(0, 0, 200);
        ac.quaternion.setFromUnitVectors(FORWARD, new THREE.Vector3(0, 0, 1));

        const tgt = new FakeTarget();
        tgt.position.set(0, 3000, 600);
        tgt.velocity.set(0, 0, 200);

        const pilot = new AceAiPilot(ac, new FlatWorld(), { gunRange: 900, combatSpeed: 200 });
        pilot.setPhase(AiFlightPhase.ENGAGE);
        pilot.setTarget(tgt);
        pilot.update(1 / 60);

        assert.equal(pilot.getAceStateLabel(), 'CONTROL');
        assert.equal(pilot.isFiring, true);
    });

    it('holds fire on a hard-crossing target the nose is pointed straight at', () => {
        const ac = new FakeAircraft();
        ac.position.set(0, 3000, 0);
        ac.airspeed = 200;
        ac.velocity.set(0, 0, 200);
        ac.quaternion.setFromUnitVectors(FORWARD, new THREE.Vector3(0, 0, 1));

        // Same range and the same zero tracking angle as above, but crossing
        // fast: an angular gun cone would shoot, the ballistic solution won't.
        const tgt = new FakeTarget();
        tgt.position.set(0, 3000, 600);
        tgt.velocity.set(200, 0, 0);

        const pilot = new AceAiPilot(ac, new FlatWorld(), { gunRange: 900, combatSpeed: 200 });
        pilot.setPhase(AiFlightPhase.ENGAGE);
        pilot.setTarget(tgt);
        pilot.update(1 / 60);

        assert.equal(pilot.isFiring, false);
    });
});

describe('AceAiPilot engagement', () => {
    it('flies a sustained engagement without losing control or the target', () => {
        const ac = new FakeAircraft();
        ac.position.set(0, 3000, 0);
        ac.airspeed = 200;
        ac.velocity.set(0, 0, 200);
        ac.quaternion.setFromUnitVectors(FORWARD, new THREE.Vector3(0, 0, 1));

        const tgt = new FakeTarget();
        tgt.position.set(300, 3100, 1400);
        tgt.velocity.set(-40, 0, 180);

        const pilot = new AceAiPilot(ac, new FlatWorld(), { gunRange: 900, combatSpeed: 200 });
        pilot.setPhase(AiFlightPhase.ENGAGE);
        pilot.setTarget(tgt);

        const seen = new Set<string>();
        for (let i = 0; i < 600; i++) {
            pilot.update(1 / 60);
            ac.step(1 / 60);
            tgt.step(1 / 60);
            seen.add(pilot.getManeuverLabel());
            assert.ok(Number.isFinite(ac.position.x + ac.position.y + ac.position.z),
                'position must stay finite');
            assert.ok(ac.pitchCmd >= -1 && ac.pitchCmd <= 1, `pitch=${ac.pitchCmd}`);
            assert.ok(ac.rollCmd >= -1 && ac.rollCmd <= 1, `roll=${ac.rollCmd}`);
        }
        assert.equal(pilot.getPhase(), AiFlightPhase.ENGAGE);
        for (const label of seen) {
            assert.ok(label.startsWith('ACE:'), `unexpected label ${label}`);
        }
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { clamp } from '../../utils/math';
import { AiFlightPhase } from '../aiPilot';
import { PilotableAircraft } from '../aircraftControls';
import { createAiPilot } from '../createAiPilot';
import { AiPilotModels } from '../../state/gameDefs';
import { Runway, WorldQuery } from '../worldQuery';
import { Combatant, Faction } from '../../weapons/combatant';
import { AggressiveAiPilot } from './aggressiveAiPilot';
import { AirframeSlowSpeeds } from '../airfield/airframePerformance';

const FORWARD = new THREE.Vector3(0, 0, 1);

class FakeAircraft implements PilotableAircraft {
    readonly position = new THREE.Vector3();
    readonly velocity = new THREE.Vector3();
    readonly quaternion = new THREE.Quaternion();
    heading = 0;
    pitchAngle = 0;
    airspeed = 200;
    crashed = false;

    private pitchCmd = 0;
    private rollCmd = 0;
    private throttleCmd = 0;

    setPitch(pitch: number): void { this.pitchCmd = pitch; }
    setRoll(roll: number): void { this.rollCmd = roll; }
    setYaw(_yaw: number): void { /* not modelled */ }
    setThrottle(throttle: number): void { this.throttleCmd = throttle; }
    setWheelBrakes(_applied: boolean): void { /* not modelled */ }
    setLandingGearDeployed(_deployed: boolean): void { /* not modelled */ }
    setFlapsExtended(_extended: boolean): void { /* not modelled */ }
    setAirbrakesExtended(_extended: boolean): void { /* not modelled */ }

    getPosition(): THREE.Vector3 { return this.position; }
    getVelocity(): THREE.Vector3 { return this.velocity; }
    getQuaternion(): THREE.Quaternion { return this.quaternion; }
    getAirspeed(): number { return this.airspeed; }
    getAltitude(): number { return this.position.y; }
    getAngleOfAttack(): number { return 0; }
    getLoadFactorG(): number { return 1; }
    getStallStatus(): number { return -1; }
    getSlowSpeeds(): AirframeSlowSpeeds { return { minFlyingSpeed: 68, maxTouchdownSpeed: 90 }; }
    isLanded(): boolean { return false; }
    isCrashed(): boolean { return this.crashed; }
    isGearDeployed(): boolean { return false; }
    isFlapsExtended(): boolean { return false; }
    isAirbrakesExtended(): boolean { return false; }

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
}

class FlatWorld implements WorldQuery {
    groundHeightAt(): number { return 0; }
    isLand(): boolean { return true; }
    obstacles(): [] { return []; }
    runway(): Runway {
        return { center: new THREE.Vector3(), heading: 0, halfLength: 1000, halfWidth: 30 };
    }
}

describe('createAiPilot factory', () => {
    it('returns AggressiveAiPilot when model is AGGRESSIVE', () => {
        const ac = new FakeAircraft();
        const pilot = createAiPilot(ac, new FlatWorld(), { model: AiPilotModels.AGGRESSIVE });
        assert.ok(pilot instanceof AggressiveAiPilot);
    });
});

describe('AggressiveAiPilot engage scenarios', () => {
    it('stays offensive and eventually fires from the target six', () => {
        const ac = new FakeAircraft();
        ac.position.set(0, 2000, 0);
        ac.airspeed = 200;
        ac.velocity.set(0, 0, 200);
        ac.quaternion.setFromUnitVectors(FORWARD, new THREE.Vector3(0, 0, 1));

        const tgt = new FakeTarget();
        tgt.position.set(0, 2000, 700);
        tgt.velocity.set(0, 0, 160);

        const pilot = new AggressiveAiPilot(ac, new FlatWorld(), { gunRange: 900, combatSpeed: 200 });
        pilot.setPhase(AiFlightPhase.ENGAGE);
        pilot.setTarget(tgt);

        let fired = false;
        for (let i = 0; i < 180; i++) {
            pilot.update(1 / 60);
            ac.step(1 / 60);
            fired = fired || pilot.isFiring;
            if (pilot.getAggressiveStateLabel() === 'ATTACK' && fired) break;
        }
        assert.equal(pilot.getAggressiveStateLabel(), 'ATTACK');
        assert.ok(pilot.getManeuverLabel().startsWith('AGGRESSIVE:'));
        assert.ok(fired || pilot.getManeuverLabel().includes('PURSUIT') || pilot.getManeuverLabel().includes('YO_YO'));
    });

    it('turns a tail threat into SCISSORS_COUNTER and keeps pressing (no break/extend)', () => {
        const ac = new FakeAircraft();
        ac.position.set(0, 2000, 800);
        ac.airspeed = 180;
        ac.velocity.set(0, 0, 180);

        const tgt = new FakeTarget();
        tgt.position.set(0, 2000, 0);
        tgt.velocity.set(0, 0, 200);

        const pilot = new AggressiveAiPilot(ac, new FlatWorld(), {});
        pilot.setPhase(AiFlightPhase.ENGAGE);
        pilot.setTarget(tgt);

        let sawCounter = false;
        for (let i = 0; i < 90; i++) {
            pilot.update(1 / 60);
            ac.step(1 / 60);
            sawCounter = sawCounter || pilot.getAggressiveStateLabel() === 'COUNTER';
            // Never a "defensive"/disengage label — every maneuver keeps pressing.
            assert.ok(!pilot.getManeuverLabel().toUpperCase().includes('EXTEND'));
            assert.ok(!pilot.getManeuverLabel().toUpperCase().includes('BREAK'));
        }
        assert.ok(sawCounter, 'expected COUNTER state');
    });

    it('selects HIGH_YO_YO under high closure at short range', () => {
        const ac = new FakeAircraft();
        ac.position.set(0, 2000, 0);
        ac.airspeed = 300;
        ac.velocity.set(0, 0, 300);

        const tgt = new FakeTarget();
        tgt.position.set(0, 2000, 500);
        tgt.velocity.set(0, 0, 150);

        const pilot = new AggressiveAiPilot(ac, new FlatWorld(), { gunRange: 900, combatSpeed: 200 });
        pilot.setPhase(AiFlightPhase.ENGAGE);
        pilot.setTarget(tgt);
        pilot.update(1 / 60);
        assert.equal(pilot.getAggressiveStateLabel(), 'ATTACK');
        assert.equal(pilot.getManeuverLabel(), 'AGGRESSIVE:HIGH_YO_YO');
    });
});

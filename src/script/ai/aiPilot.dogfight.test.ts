import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { clamp } from '../utils/math';
import { AiFlightPhase, AiPilot, DogfightMode } from './aiPilot';
import { angleOff } from './dogfightGeometry';
import { PilotableAircraft } from './aircraftControls';
import { Runway, WorldQuery } from './worldQuery';
import { Combatant, Faction } from '../weapons/combatant';
import { AirframeSlowSpeeds } from './airfield/airframePerformance';

/**
 * Scenario tests for the ENGAGE-phase dogfight sub-state-machine in aiPilot.ts.
 * These drive the real {@link AiPilot} decision logic against lightweight test
 * doubles — no rendering, no physics worker, no Three.js scene — exercising
 * exactly the {@link PilotableAircraft}/{@link Combatant}/{@link WorldQuery}
 * boundary the pilot is written against.
 */

const FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * A minimal kinematic stand-in for the FM2 flight model: turns/pitches toward
 * the AI's commanded rate and drifts airspeed toward a throttle-implied
 * equilibrium. Not a real flight model — just enough closed-loop dynamics for
 * the pilot's mode-transition timing to be exercised realistically.
 */
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

    /** Advance the fake dynamics by `delta` seconds. */
    step(delta: number): void {
        const TURN_RATE_MAX = 1.0;   // rad/s
        const PITCH_RATE_MAX = 0.8;  // rad/s
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

/** A test-controlled opponent: position/velocity are whatever the test sets, frozen unless changed explicitly. */
class FakeTarget implements Combatant {
    readonly faction = Faction.ENEMY;
    readonly position = new THREE.Vector3();
    readonly velocity = new THREE.Vector3();
    private alive = true;

    readPosition(target: THREE.Vector3): THREE.Vector3 { return target.copy(this.position); }
    readVelocity(target: THREE.Vector3): THREE.Vector3 { return target.copy(this.velocity); }
    getHitRadius(): number { return 10; }
    isAlive(): boolean { return this.alive; }
    applyDamage(_amount: number): void { this.alive = false; }
}

/** Flat, obstacle-free world so terrain/obstacle avoidance never interferes with these tests. */
class FlatWorld implements WorldQuery {
    groundHeightAt(): number { return 0; }
    isLand(): boolean { return true; }
    obstacles(): [] { return []; }
    runway(): Runway {
        return { center: new THREE.Vector3(), heading: 0, halfLength: 1000, halfWidth: 30 };
    }
}

function runFrames(pilot: AiPilot, aircraft: FakeAircraft, frames: number, dt: number): boolean {
    let firedAtLeastOnce = false;
    for (let i = 0; i < frames; i++) {
        pilot.update(dt);
        aircraft.step(dt);
        firedAtLeastOnce = firedAtLeastOnce || pilot.isFiring;
    }
    return firedAtLeastOnce;
}

describe('AiPilot dogfight sub-states', () => {
    it('stays in a tracking mode and opens fire on an easy in-trail shot', () => {
        const aircraft = new FakeAircraft();
        aircraft.position.set(0, 3000, 0);
        aircraft.heading = 0;
        aircraft.airspeed = 220; // comfortably under the default 240 m/s speed cap
        aircraft.velocity.set(0, 0, 220);

        const target = new FakeTarget();
        target.position.set(0, 3000, 500);
        target.velocity.set(0, 0, 220); // same heading, in-trail: AI is dead astern, good aspect

        const pilot = new AiPilot(aircraft, new FlatWorld(), { gunRange: 900 });
        pilot.setTarget(target);
        pilot.setPhase(AiFlightPhase.ENGAGE);

        const fired = runFrames(pilot, aircraft, 30, 1 / 60);

        assert.ok(fired, 'expected the AI to open fire on an easy in-trail shot');
        assert.ok(
            pilot.getDogfightMode() === DogfightMode.PURSUE || pilot.getDogfightMode() === DogfightMode.LAG_PURSUE,
            `expected a tracking mode, got ${DogfightMode[pilot.getDogfightMode()]}`,
        );
    });

    it('breaks defensively within the reaction delay when the target is on its tail, and never fires while defensive', () => {
        const aircraft = new FakeAircraft();
        aircraft.position.set(0, 3000, 0);
        aircraft.heading = 0;
        aircraft.airspeed = 250;
        aircraft.velocity.set(0, 0, 250);

        const target = new FakeTarget();
        target.position.set(0, 3000, -400); // dead astern of the AI
        target.velocity.set(0, 0, 250);      // pointed straight at the AI: a live gun threat

        const pilot = new AiPilot(aircraft, new FlatWorld(), { gunRange: 900 });
        pilot.setTarget(target);
        pilot.setPhase(AiFlightPhase.ENGAGE);

        let everFired = false;
        let sawDefensive = false;
        const dt = 1 / 60;
        for (let i = 0; i < 60; i++) { // 1s, well past the ACE-tier 0.25s reaction delay
            pilot.update(dt);
            aircraft.step(dt);
            everFired = everFired || pilot.isFiring;
            sawDefensive = sawDefensive || pilot.getDogfightMode() === DogfightMode.DEFENSIVE_BREAK;
        }

        assert.ok(sawDefensive, 'expected the AI to enter DEFENSIVE_BREAK once the threat is sustained');
        assert.equal(everFired, false, 'the AI should not fire while it is being tracked from behind');
    });

    it('extends to rebuild energy when far below the target\'s energy state, and holds it for the minimum duration', () => {
        const aircraft = new FakeAircraft();
        aircraft.position.set(0, 500, 0); // low and slow
        aircraft.heading = 0;
        aircraft.airspeed = 100;
        aircraft.velocity.set(0, 0, 100);

        const target = new FakeTarget();
        // Far away (no threat) and at an energy state the AI's speed cap cannot
        // reach, so it cannot recover within the test window.
        target.position.set(0, 5000, 6000);
        target.velocity.set(0, 0, 300);

        const pilot = new AiPilot(aircraft, new FlatWorld(), { gunRange: 900, maxSpeed: 240 });
        pilot.setTarget(target);
        pilot.setPhase(AiFlightPhase.ENGAGE);

        const dt = 1 / 60;
        pilot.update(dt);
        aircraft.step(dt);
        assert.equal(pilot.getDogfightMode(), DogfightMode.EXTEND, 'expected an immediate extend given the large energy deficit');

        let everFired = false;
        let leftExtendEarly = false;
        const minDurationFrames = Math.ceil(2.0 / dt); // EXTEND_MIN_DURATION
        for (let i = 0; i < minDurationFrames; i++) {
            pilot.update(dt);
            aircraft.step(dt);
            everFired = everFired || pilot.isFiring;
            if (pilot.getDogfightMode() !== DogfightMode.EXTEND) {
                leftExtendEarly = true;
            }
        }

        assert.equal(leftExtendEarly, false, 'expected the AI to hold EXTEND for at least its minimum duration');
        assert.equal(everFired, false, 'the AI should not fire while disengaged and rebuilding energy');
    });

    it('switches to lag pursuit on a wide-angle-off crossing merge instead of forcing an unflyable lead turn', () => {
        const aircraft = new FakeAircraft();
        aircraft.position.set(0, 3000, 0);
        aircraft.heading = 0;
        aircraft.airspeed = 250;
        aircraft.velocity.set(0, 0, 250);

        const target = new FakeTarget();
        target.position.set(1000, 3000, 1000);
        // ~155 deg angle-off (past LAG_ANGLE_OFF_TRIGGER); a 90 deg cross stays in lead.
        target.velocity.set(0, 0, -250);

        const pilot = new AiPilot(aircraft, new FlatWorld(), { gunRange: 900 });
        pilot.setTarget(target);
        pilot.setPhase(AiFlightPhase.ENGAGE);

        pilot.update(1 / 60);

        assert.equal(pilot.getDogfightMode(), DogfightMode.LAG_PURSUE);
    });

    it('does not break defensively on a head-on merge where the target is ahead', () => {
        const aircraft = new FakeAircraft();
        aircraft.position.set(0, 3000, 0);
        aircraft.heading = 0;
        aircraft.airspeed = 250;
        aircraft.velocity.set(0, 0, 250);

        const target = new FakeTarget();
        target.position.set(0, 3000, 500); // ahead, both pointed at each other
        target.velocity.set(0, 0, -250);

        const pilot = new AiPilot(aircraft, new FlatWorld(), { gunRange: 900 });
        pilot.setTarget(target);
        pilot.setPhase(AiFlightPhase.ENGAGE);

        let sawDefensive = false;
        const dt = 1 / 60;
        for (let i = 0; i < 60; i++) {
            pilot.update(dt);
            aircraft.step(dt);
            sawDefensive = sawDefensive || pilot.getDogfightMode() === DogfightMode.DEFENSIVE_BREAK;
        }

        assert.equal(sawDefensive, false, 'head-on merge should stay offensive, not break away');
    });

    it('gains angles against a constant-rate level turn instead of losing them', () => {
        const aircraft = new FakeAircraft();
        aircraft.position.set(0, 3000, 500);
        aircraft.heading = Math.PI;
        aircraft.airspeed = 220;
        aircraft.velocity.set(0, 0, -220);

        const target = new FakeTarget();
        target.position.set(0, 3000, 0);
        target.velocity.set(0, 0, 220);

        const pilot = new AiPilot(aircraft, new FlatWorld(), { gunRange: 900, alwaysEngage: true });
        pilot.setTarget(target);
        pilot.setPhase(AiFlightPhase.ENGAGE);

        const dt = 1 / 60;
        let startAo = angleOff(aircraft.velocity, target.velocity);
        for (let i = 0; i < 240; i++) {
            pilot.update(dt);
            aircraft.step(dt);
            // Target flies a gentle constant left turn.
            target.velocity.set(-Math.sin(i * 0.02) * 220, 0, Math.cos(i * 0.02) * 220);
            if (i === 60) {
                startAo = angleOff(aircraft.velocity, target.velocity);
            }
        }
        const endAo = angleOff(aircraft.velocity, target.velocity);
        assert.ok(endAo < startAo, `expected angle-off to shrink (${startAo} -> ${endAo})`);
    });

    it('holds fire when the nose is off the ballistic solution', () => {
        const aircraft = new FakeAircraft();
        aircraft.position.set(0, 3000, 0);
        aircraft.heading = Math.PI / 2; // beam to target
        aircraft.airspeed = 220;
        aircraft.velocity.set(220, 0, 0);

        const target = new FakeTarget();
        target.position.set(0, 3000, 500);
        target.velocity.set(0, 0, 220);

        const pilot = new AiPilot(aircraft, new FlatWorld(), { gunRange: 900 });
        pilot.setTarget(target);
        pilot.setPhase(AiFlightPhase.ENGAGE);

        pilot.update(1 / 60);
        assert.equal(pilot.isFiring, false, 'should not fire when the nose is off the solution');
    });
});

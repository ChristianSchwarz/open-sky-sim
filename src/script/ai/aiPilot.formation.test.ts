import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { clamp } from '../utils/math';
import { Combatant, Faction } from '../weapons/combatant';
import { AiFlightPhase, AiPilot, FORMATION_SLOT } from './aiPilot';
import { PilotableAircraft } from './aircraftControls';
import { Runway, WorldQuery } from './worldQuery';

/**
 * Scenario tests for the FORMATION (wingman) phase in aiPilot.ts: rejoining a
 * moving lead, holding the wing slot, peeling off onto a bandit and rejoining
 * afterwards. Same test doubles as the dogfight suite — a crude kinematic
 * airframe, a scripted lead/target and a flat world — so the real pilot control
 * loops run closed-loop without any renderer or physics worker.
 */

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
    isLanded(): boolean { return false; }
    isCrashed(): boolean { return this.crashed; }
    isGearDeployed(): boolean { return false; }
    isFlapsExtended(): boolean { return false; }
    isAirbrakesExtended(): boolean { return false; }

    step(delta: number): void {
        const TURN_RATE_MAX = 1.0;
        const PITCH_RATE_MAX = 0.8;
        // Roll right (+1) turns toward a *decreasing* heading in this frame:
        // `bank` is atan2(right.y, up.y), so right-wing-down is negative bank,
        // and the pilot's heading loop is written against that sign (see the
        // comment in AiPilot.commandHeading). These tests assert convergence, so
        // unlike the mode-transition suites the sign here has to be right.
        this.heading -= this.rollCmd * TURN_RATE_MAX * delta;
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

/** A scripted lead/bandit: flies whatever constant velocity the test sets. */
class FakeCombatant implements Combatant {
    readonly position = new THREE.Vector3();
    readonly velocity = new THREE.Vector3();
    private alive = true;

    constructor(readonly faction: Faction) { }

    readPosition(target: THREE.Vector3): THREE.Vector3 { return target.copy(this.position); }
    readVelocity(target: THREE.Vector3): THREE.Vector3 { return target.copy(this.velocity); }
    getHitRadius(): number { return 10; }
    isAlive(): boolean { return this.alive; }
    applyDamage(_amount: number): void { this.alive = false; }
    kill(): void { this.alive = false; }

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

/** The wing slot the pilot should settle into, in world space, for a lead flying +Z. */
function slotForLeadHeadingZero(lead: FakeCombatant): THREE.Vector3 {
    return new THREE.Vector3(
        lead.position.x + FORMATION_SLOT.side,
        lead.position.y + FORMATION_SLOT.stack,
        lead.position.z - FORMATION_SLOT.trail,
    );
}

/** A wingman trailing the lead, already airborne and pointed the same way. */
function wingmanBehindLead(offsetBack: number, offsetRight = 0): {
    ac: FakeAircraft; lead: FakeCombatant; pilot: AiPilot;
} {
    const lead = new FakeCombatant(Faction.PLAYER);
    lead.position.set(0, 3000, 0);
    lead.velocity.set(0, 0, 200);

    const ac = new FakeAircraft();
    ac.position.set(offsetRight, 3000, -offsetBack);
    ac.airspeed = 200;
    ac.velocity.set(0, 0, 200);
    ac.quaternion.setFromUnitVectors(FORWARD, new THREE.Vector3(0, 0, 1));

    const pilot = new AiPilot(ac, new FlatWorld(), { cruiseSpeed: 200, cruiseAltitude: 3000 });
    pilot.setFormationLead(lead);
    pilot.setPhase(AiFlightPhase.FORMATION);
    return { ac, lead, pilot };
}

function fly(pilot: AiPilot, ac: FakeAircraft, lead: FakeCombatant, seconds: number): void {
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
        pilot.update(dt);
        ac.step(dt);
        lead.step(dt);
    }
}

describe('AiPilot FORMATION phase', () => {
    it('rejoins a moving lead and settles into the wing slot', () => {
        const { ac, lead, pilot } = wingmanBehindLead(1200, 400);
        const startError = ac.position.distanceTo(slotForLeadHeadingZero(lead));
        assert.ok(startError > 1000, `startError=${startError}`);

        fly(pilot, ac, lead, 90);

        assert.equal(pilot.getPhase(), AiFlightPhase.FORMATION);
        const endError = ac.position.distanceTo(slotForLeadHeadingZero(lead));
        assert.ok(endError < 120, `expected to be on the wing, slot error=${endError}`);
        // Formation is flown, not chased: it ends up matching the lead's speed.
        assert.ok(Math.abs(ac.airspeed - 200) < 25, `airspeed=${ac.airspeed}`);
    });

    it('holds station once settled instead of drifting off', () => {
        const { ac, lead, pilot } = wingmanBehindLead(FORMATION_SLOT.trail, FORMATION_SLOT.side);
        fly(pilot, ac, lead, 20);
        const settled = ac.position.distanceTo(slotForLeadHeadingZero(lead));

        fly(pilot, ac, lead, 60);
        const later = ac.position.distanceTo(slotForLeadHeadingZero(lead));

        assert.equal(pilot.getPhase(), AiFlightPhase.FORMATION);
        assert.ok(later < 120, `drifted off the wing: ${settled} -> ${later}`);
    });

    it('flies the lead through a turn', () => {
        const { ac, lead, pilot } = wingmanBehindLead(FORMATION_SLOT.trail, FORMATION_SLOT.side);
        fly(pilot, ac, lead, 15);

        // Lead turns 45 degrees right and holds it.
        lead.velocity.set(Math.sin(Math.PI / 4) * 200, 0, Math.cos(Math.PI / 4) * 200);
        fly(pilot, ac, lead, 45);

        assert.equal(pilot.getPhase(), AiFlightPhase.FORMATION);
        // Same heading as the lead, and still alongside rather than left behind.
        const wingHeading = Math.atan2(ac.velocity.x, ac.velocity.z);
        assert.ok(Math.abs(wingHeading - Math.PI / 4) < 0.35, `heading=${wingHeading}`);
        assert.ok(ac.position.distanceTo(lead.position) < 400,
            `lost the lead: ${ac.position.distanceTo(lead.position)}`);
    });

    it('holds overhead rather than descending onto a parked lead', () => {
        const lead = new FakeCombatant(Faction.PLAYER);
        lead.position.set(0, 0, 0);
        lead.velocity.set(0, 0, 0);

        const ac = new FakeAircraft();
        ac.position.set(0, 900, -200);
        ac.airspeed = 180;
        ac.velocity.set(0, 0, 180);

        const pilot = new AiPilot(ac, new FlatWorld(), { cruiseAltitude: 900, cruiseSpeed: 180 });
        pilot.setFormationLead(lead);
        pilot.setPhase(AiFlightPhase.FORMATION);
        fly(pilot, ac, lead, 60);

        assert.equal(pilot.getPhase(), AiFlightPhase.FORMATION);
        assert.ok(ac.position.y > 400, `dove at a parked lead: y=${ac.position.y}`);
        // A hold is a hold: it stays in the overhead, not miles downrange.
        const horizontal = Math.hypot(ac.position.x - lead.position.x, ac.position.z - lead.position.z);
        assert.ok(horizontal < 4000, `wandered off the hold: ${horizontal}`);
    });
});

describe('AiPilot wingman engagement handover', () => {
    it('peels off to ENGAGE as soon as a live bandit is assigned', () => {
        const { ac, lead, pilot } = wingmanBehindLead(FORMATION_SLOT.trail, FORMATION_SLOT.side);
        fly(pilot, ac, lead, 5);
        assert.equal(pilot.getPhase(), AiFlightPhase.FORMATION);

        const bandit = new FakeCombatant(Faction.ENEMY);
        bandit.position.set(0, 3000, ac.position.z + 2000);
        bandit.velocity.set(0, 0, 180);
        pilot.setTarget(bandit);

        pilot.update(1 / 60);
        assert.equal(pilot.getPhase(), AiFlightPhase.ENGAGE);
    });

    it('rejoins the lead when the bandit dies, instead of going back to a lone patrol', () => {
        const { ac, lead, pilot } = wingmanBehindLead(FORMATION_SLOT.trail, FORMATION_SLOT.side);
        const bandit = new FakeCombatant(Faction.ENEMY);
        bandit.position.set(0, 3000, 1500);
        bandit.velocity.set(0, 0, 180);
        pilot.setTarget(bandit);
        pilot.update(1 / 60);
        assert.equal(pilot.getPhase(), AiFlightPhase.ENGAGE);

        bandit.kill();
        pilot.update(1 / 60);
        assert.equal(pilot.getPhase(), AiFlightPhase.FORMATION);
    });

    it('falls back to a lone patrol when there is no lead to rejoin', () => {
        const ac = new FakeAircraft();
        ac.position.set(0, 3000, 0);
        ac.velocity.set(0, 0, 200);
        const pilot = new AiPilot(ac, new FlatWorld(), {});
        const bandit = new FakeCombatant(Faction.ENEMY);
        bandit.position.set(0, 3000, 1500);
        bandit.velocity.set(0, 0, 180);
        pilot.setTarget(bandit);
        pilot.setPhase(AiFlightPhase.ENGAGE);
        pilot.update(1 / 60);

        bandit.kill();
        pilot.update(1 / 60);
        assert.equal(pilot.getPhase(), AiFlightPhase.NAVIGATE);
    });

    it('drops to a lone patrol if the lead is lost', () => {
        const { ac, lead, pilot } = wingmanBehindLead(FORMATION_SLOT.trail, FORMATION_SLOT.side);
        fly(pilot, ac, lead, 2);
        lead.kill();
        pilot.update(1 / 60);
        assert.equal(pilot.getPhase(), AiFlightPhase.NAVIGATE);
    });
});

/**
 * AI pilot traces (workstream H): every pilot model flies scripted scenarios
 * closed-loop against the kinematic FakeAircraft of the TS dogfight tests, and
 * every 3rd frame (20 Hz) the fixture records what the pilot commanded and
 * where the fake aircraft went. The C# port reimplements FakeAircraft and the
 * target scripts exactly, so any difference is the pilot's.
 */
import * as THREE from 'three';
import { AiFlightPhase, AiSkillLevel } from '../../../src/script/ai/aiPilot';
import { AiPilotController } from '../../../src/script/ai/aiPilotController';
import { PilotableAircraft } from '../../../src/script/ai/aircraftControls';
import { createAiPilot } from '../../../src/script/ai/createAiPilot';
import { Obstacle, Runway, WorldQuery } from '../../../src/script/ai/worldQuery';
import { AiPilotModels } from '../../../src/script/state/gameDefs';
import { clamp } from '../../../src/script/utils/math';
import { Combatant, Faction } from '../../../src/script/weapons/combatant';
import { SuiteOutput } from '../lib';

const DT = 1 / 60;
const FORWARD = new THREE.Vector3(0, 0, 1);

/** Kinematic stand-in from aiPilot.dogfight.test.ts, plus recorded discrete commands. */
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
    yawCmd = 0;
    throttleCmd = 0;
    brakes = false;
    gear = false;
    flaps = false;
    airbrakes = false;

    setPitch(pitch: number): void { this.pitchCmd = pitch; }
    setRoll(roll: number): void { this.rollCmd = roll; }
    setYaw(yaw: number): void { this.yawCmd = yaw; }
    setThrottle(throttle: number): void { this.throttleCmd = throttle; }
    setWheelBrakes(applied: boolean): void { this.brakes = applied; }
    setLandingGearDeployed(deployed: boolean): void { this.gear = deployed; }
    setFlapsExtended(extended: boolean): void { this.flaps = extended; }
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
    isGearDeployed(): boolean { return this.gear; }
    isFlapsExtended(): boolean { return this.flaps; }
    isAirbrakesExtended(): boolean { return this.airbrakes; }

    /** Sync velocity/quaternion to heading/pitch without moving (initial state). */
    orient(): void {
        const fwd = new THREE.Vector3(
            Math.sin(this.heading) * Math.cos(this.pitchAngle),
            Math.sin(this.pitchAngle),
            Math.cos(this.heading) * Math.cos(this.pitchAngle),
        );
        this.velocity.copy(fwd).multiplyScalar(this.airspeed);
        this.quaternion.setFromUnitVectors(FORWARD, fwd);
    }

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

/**
 * A scripted target: straight line at constant velocity, or a level circle
 * about `center` at `turnRate` rad/s (positive = turning toward +x from +z).
 */
interface TargetScript {
    position: [number, number, number];
    velocity: [number, number, number];
    turnRate?: number;
}

class ScriptedTarget implements Combatant {
    readonly faction = Faction.PLAYER;
    readonly position: THREE.Vector3;
    readonly velocity: THREE.Vector3;
    private readonly turnRate: number;

    constructor(s: TargetScript) {
        this.position = new THREE.Vector3(...s.position);
        this.velocity = new THREE.Vector3(...s.velocity);
        this.turnRate = s.turnRate ?? 0;
    }

    readPosition(target: THREE.Vector3): THREE.Vector3 { return target.copy(this.position); }
    readVelocity(target: THREE.Vector3): THREE.Vector3 { return target.copy(this.velocity); }
    getHitRadius(): number { return 10; }
    isAlive(): boolean { return true; }
    applyDamage(_amount: number): void { /* scripted targets ignore damage */ }

    /** Rotate velocity about +Y by turnRate*dt (exact rotation), then move. */
    step(dt: number): void {
        if (this.turnRate !== 0) {
            const a = this.turnRate * dt;
            const c = Math.cos(a), s = Math.sin(a);
            const vx = this.velocity.x, vz = this.velocity.z;
            this.velocity.x = vx * c + vz * s;
            this.velocity.z = -vx * s + vz * c;
        }
        this.position.addScaledVector(this.velocity, dt);
    }
}

/** Ground models the C# side reimplements: flat, or a ridge across z in [ridgeZ0, ridgeZ1]. */
type GroundSpec = { kind: 'flat' } | { kind: 'ridge'; z0: number; z1: number; height: number };

class TestWorld implements WorldQuery {
    private readonly runwayList: Runway[] = [
        { center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: 1500, halfWidth: 30 },
        { center: new THREE.Vector3(12000, 0, 8000), heading: Math.PI / 2, halfLength: 1000, halfWidth: 25 },
    ];

    constructor(private readonly ground: GroundSpec) {}

    groundHeightAt(_x: number, z: number): number {
        if (this.ground.kind === 'ridge' && z >= this.ground.z0 && z <= this.ground.z1) {
            return this.ground.height;
        }
        return 0;
    }
    isLand(): boolean { return true; }
    obstacles(): readonly Obstacle[] { return []; }
    runways(): readonly Runway[] { return this.runwayList; }
    runway(): Runway { return this.runwayList[0]; }
    nearestRunway(x: number, z: number): Runway {
        let best = this.runwayList[0];
        let bestD = Infinity;
        for (const r of this.runwayList) {
            const d = Math.hypot(r.center.x - x, r.center.z - z);
            if (d < bestD) { bestD = d; best = r; }
        }
        return best;
    }
}

interface Scenario {
    name: string;
    model: AiPilotModels;
    skill?: AiSkillLevel;
    phase: AiFlightPhase;
    /** Own aircraft: position, heading (rad, 0 = +Z), pitch (rad), airspeed. */
    own: { position: [number, number, number]; heading: number; pitch: number; airspeed: number; throttle: number };
    target?: TargetScript;
    lead?: TargetScript;
    ground: GroundSpec;
    duration: number;
}

const ENGAGEMENTS: Array<Omit<Scenario, 'name' | 'model' | 'phase' | 'ground' | 'duration'> & { tag: string }> = [
    { tag: 'in_trail', own: { position: [0, 3000, 0], heading: 0, pitch: 0, airspeed: 220, throttle: 0.7 },
        target: { position: [0, 3000, 700], velocity: [0, 0, 200] } },
    { tag: 'head_on', own: { position: [0, 3000, 0], heading: 0, pitch: 0, airspeed: 230, throttle: 0.8 },
        target: { position: [0, 3000, 4000], velocity: [0, 0, -230] } },
    { tag: 'defensive', own: { position: [0, 3000, 0], heading: 0, pitch: 0, airspeed: 220, throttle: 0.7 },
        target: { position: [0, 3000, -600], velocity: [0, 0, 240] } },
    { tag: 'crossing', own: { position: [0, 3000, 0], heading: 0, pitch: 0, airspeed: 220, throttle: 0.7 },
        target: { position: [2000, 3200, 2000], velocity: [-220, 0, 0] } },
    { tag: 'turning_target', own: { position: [0, 3000, 0], heading: 0, pitch: 0, airspeed: 220, throttle: 0.7 },
        target: { position: [300, 3000, 1500], velocity: [0, 0, 200], turnRate: 0.15 } },
    { tag: 'low_energy', own: { position: [0, 1500, 0], heading: 0.4, pitch: 0, airspeed: 150, throttle: 0.5 },
        target: { position: [1000, 4500, 3000], velocity: [150, 0, 120] } },
];

function scenarios(): Scenario[] {
    const out: Scenario[] = [];
    const models: Array<[AiPilotModels, string]> = [
        [AiPilotModels.CLASSIC, 'classic'], [AiPilotModels.SHAW, 'shaw'],
        [AiPilotModels.AGGRESSIVE, 'aggressive'], [AiPilotModels.ACE, 'ace'],
    ];
    for (const [model, tag] of models) {
        for (const e of ENGAGEMENTS) {
            out.push({
                name: `${tag}_${e.tag}`, model, phase: AiFlightPhase.ENGAGE, own: e.own, target: e.target,
                ground: { kind: 'flat' }, duration: 15,
            });
        }
    }
    // Skill tiers change the classic pilot's reaction and energy thresholds.
    for (const [skill, tag] of [[AiSkillLevel.ROOKIE, 'rookie'], [AiSkillLevel.VETERAN, 'veteran']] as const) {
        out.push({
            name: `classic_defensive_${tag}`, model: AiPilotModels.CLASSIC, skill, phase: AiFlightPhase.ENGAGE,
            own: ENGAGEMENTS[2].own, target: ENGAGEMENTS[2].target, ground: { kind: 'flat' }, duration: 15,
        });
    }
    // Low-level engagement toward a ridge: terrain and hard-deck protection.
    out.push({
        name: 'classic_low_ridge', model: AiPilotModels.CLASSIC, phase: AiFlightPhase.ENGAGE,
        own: { position: [0, 400, 0], heading: 0, pitch: 0, airspeed: 220, throttle: 0.7 },
        target: { position: [0, 450, 1200], velocity: [0, 0, 210] },
        ground: { kind: 'ridge', z0: 3000, z1: 3600, height: 700 }, duration: 15,
    });
    // Non-combat phases (the other models delegate these to the classic pilot).
    const cruise = { position: [0, 3000, 0] as [number, number, number], heading: 0, pitch: 0, airspeed: 220, throttle: 0.6 };
    out.push(
        { name: 'classic_navigate', model: AiPilotModels.CLASSIC, phase: AiFlightPhase.NAVIGATE, own: { ...cruise, position: [5000, 2000, 9000] }, ground: { kind: 'flat' }, duration: 20 },
        { name: 'classic_straight', model: AiPilotModels.CLASSIC, phase: AiFlightPhase.STRAIGHT, own: { ...cruise, heading: 1.0 }, ground: { kind: 'flat' }, duration: 12 },
        { name: 'classic_climb_out', model: AiPilotModels.CLASSIC, phase: AiFlightPhase.CLIMB_OUT, own: { position: [0, 300, 1500], heading: 0, pitch: 0.1, airspeed: 120, throttle: 1 }, ground: { kind: 'flat' }, duration: 15 },
        { name: 'classic_rtb', model: AiPilotModels.CLASSIC, phase: AiFlightPhase.RTB, own: { ...cruise, position: [9000, 2500, 15000], heading: 2.5 }, ground: { kind: 'flat' }, duration: 25 },
        { name: 'classic_approach', model: AiPilotModels.CLASSIC, phase: AiFlightPhase.APPROACH, own: { position: [0, 500, -8000], heading: 0, pitch: 0, airspeed: 120, throttle: 0.4 }, ground: { kind: 'flat' }, duration: 25 },
        { name: 'classic_formation', model: AiPilotModels.CLASSIC, phase: AiFlightPhase.FORMATION, own: { ...cruise, position: [-400, 2900, -600] },
            lead: { position: [0, 3000, 0], velocity: [0, 0, 210], turnRate: 0.05 }, ground: { kind: 'flat' }, duration: 20 },
        { name: 'shaw_formation', model: AiPilotModels.SHAW, phase: AiFlightPhase.FORMATION, own: { ...cruise, position: [-400, 2900, -600] },
            lead: { position: [0, 3000, 0], velocity: [0, 0, 210] }, ground: { kind: 'flat' }, duration: 12 },
    );
    return out;
}

function run(s: Scenario): unknown {
    const ac = new FakeAircraft();
    ac.position.set(...s.own.position);
    ac.heading = s.own.heading;
    ac.pitchAngle = s.own.pitch;
    ac.airspeed = s.own.airspeed;
    ac.throttleCmd = s.own.throttle;
    ac.orient();
    const world = new TestWorld(s.ground);
    const pilot: AiPilotController = createAiPilot(ac, world, { model: s.model, skill: s.skill });
    const target = s.target ? new ScriptedTarget(s.target) : undefined;
    const lead = s.lead ? new ScriptedTarget(s.lead) : undefined;
    pilot.setTarget(target);
    pilot.setFormationLead(lead);
    pilot.setPhase(s.phase);

    const steps = Math.round(s.duration / DT);
    const samples: unknown[] = [];
    let firedFrames = 0;
    for (let step = 1; step <= steps; step++) {
        pilot.update(DT);
        if (pilot.isFiring) firedFrames++;
        if (step % 3 === 0) {
            samples.push({
                step,
                pitch: ac.pitchCmd, roll: ac.rollCmd, yaw: ac.yawCmd, throttle: ac.throttleCmd,
                gear: ac.gear, flaps: ac.flaps, airbrakes: ac.airbrakes, brakes: ac.brakes,
                firing: pilot.isFiring,
                phase: AiFlightPhase[pilot.getPhase()],
                label: pilot.getManeuverLabel(),
                position: [ac.position.x, ac.position.y, ac.position.z],
                heading: ac.heading, pitchAngle: ac.pitchAngle, airspeed: ac.airspeed,
            });
        }
        ac.step(DT);
        target?.step(DT);
        lead?.step(DT);
    }
    return {
        name: s.name,
        model: AiPilotModels[s.model],
        skill: s.skill === undefined ? null : AiSkillLevel[s.skill],
        phase: AiFlightPhase[s.phase],
        own: s.own,
        target: s.target ?? null,
        lead: s.lead ?? null,
        ground: s.ground,
        duration: s.duration,
        steps,
        firedFrames,
        samples,
    };
}

export function aiSuite(): SuiteOutput {
    const traces = scenarios().map(run);
    return {
        files: [{
            file: 'ai_pilots.json',
            data: {
                suite: 'ai_pilots',
                version: 1,
                source: 'src/script/ai/{aiPilot,createAiPilot,shaw/*,aggressive/*,ace/*}.ts',
                notes: [
                    'dt = 1/60. Each frame: pilot.update(dt), record (every 3rd frame), aircraft.step(dt), target.step(dt), lead.step(dt).',
                    'FakeAircraft is the kinematic double of aiPilot.dogfight.test.ts: heading += roll*1.0*dt; pitch = clamp(pitch + pitchCmd*0.8*dt, -1.3, 1.3); airspeed relaxes toward 50 + 300*throttle at 0.5/s, floor 30; quaternion = setFromUnitVectors(+Z, fwd).',
                    'Before the first frame the aircraft is oriented (velocity and quaternion from heading/pitch/airspeed) without moving; throttleCmd starts at own.throttle; gear/flaps/airbrakes/brakes start false.',
                    'Targets: velocity rotated about +Y by turnRate*dt each frame (vx*c + vz*s, -vx*s + vz*c), then position += velocity*dt. readPosition/readVelocity copy; hit radius 10; always alive.',
                    'World: runways [(0,0,0) heading 0, half 1500x30; (12000,0,8000) heading pi/2, half 1000x25]; nearestRunway by horizontal distance; ground flat 0 or a ridge of `height` for z in [z0, z1]; isLand true; no obstacles.',
                    'Pilot built with createAiPilot(aircraft, world, {model, skill}); then setTarget, setFormationLead, setPhase.',
                    'labels: getManeuverLabel(); phase: AiFlightPhase enum name.',
                ],
                tolerances: { command: 1e-9, position: 1e-6, angle: 1e-9 },
                traces,
            },
        }],
    };
}

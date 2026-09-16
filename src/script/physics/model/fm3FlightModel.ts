/**
 * FM3 — physical flight model.
 *
 * A 6-DOF rigid body (full inertia tensor, engine rotor momentum, RK4, no rate
 * limit) whose loads come from the airframe's geometry: lifting surfaces cut
 * into strips with full-range section aerodynamics and unsteady separation, a
 * lifting line with the tail's downwash delay and wake, strake vortex lift and
 * slender-body fuselage forces (physics/fm3/aeroModel.ts). Stall, departure,
 * deep stall and spins are whatever those produce; nothing here is keyed to a
 * manoeuvre. A fly-by-wire system (physics/fm3/fcs.ts) flies it through
 * rate- and position-limited actuators, and spring-damper gear carries it on
 * the ground.
 *
 * It runs inside the combat-sim worker exactly where FM2 does, so the gun,
 * damage, carrier decks and arrestor wires work unchanged.
 *
 * See docs/fm3-physical-flight-model.md.
 */
import * as THREE from 'three';
import { WorldQuery } from '../../ai/worldQuery';
import { clamp, FORWARD, RIGHT } from '../../utils/math';
import { computeAirDensity, computeSpeedOfSound } from '../aeroUtils';
import {
    adjustF16ThrottleInput, f16ThrottleAudioLevel, formatF16ThrottleHud, getF16EngineNozzleColor,
    getF16ThrottleZone, isF16AbDetentBand, stepF16ThrottleDetent,
} from '../f16Engine';
import { defaultFm2Config, Fm2AircraftConfig } from '../fm2/fm2AircraftConfig';
import { Fm3Actuators } from '../fm3/actuators';
import { AeroEnvironment, Fm3Aero } from '../fm3/aeroModel';
import { F16_FCS, Fm3Fcs, Fm3FcsConfig, Fm3FcsInput } from '../fm3/fcs';
import { F16_AIRFRAME } from '../fm3/f16Airframe';
import { CHANNEL_INDEX, Fm3Airframe } from '../fm3/fm3Airframe';
import { inertiaNasaToSim, nasaToSim, Vec3 } from '../fm3/frames';
import { Fm3GroundContact } from '../fm3/groundContact';
import { Fm3Engine } from '../fm3/propulsion';
import { invert3x3, RigidBody6, rotateBodyToWorld, rotateWorldToBody, WrenchFunction } from '../fm3/rigidBody6';
import { FlightModel, ForceVectorSample } from './flightModel';

const GRAVITY = 9.80665;
const DEG = Math.PI / 180;

export class Fm3FlightModel extends FlightModel {
    private readonly config: Fm2AircraftConfig;
    readonly airframe: Fm3Airframe;
    readonly aero: Fm3Aero;
    private readonly rb = new RigidBody6();
    private readonly actuators: Fm3Actuators;
    private readonly fcs: Fm3Fcs;
    private readonly fcsConfig: Fm3FcsConfig;
    private readonly engine: Fm3Engine;
    private readonly gear: Fm3GroundContact;
    private world: WorldQuery | undefined;

    private readonly env: AeroEnvironment = { rho: 1.225, soundSpeed: 340, heightAboveGround: Infinity, gearDown: 1 };
    private readonly nozzle: Vec3;
    private readonly thrustAxis: Vec3;
    private readonly massKg: number;

    private thrustN = 0;
    private stall = -1;
    /** Steps the rigid body's NaN guard has rolled back. */
    nanGuardTrips = 0;
    private sideslipRad = 0;

    private readonly fcsInput: Fm3FcsInput = {
        pitchStick: 0, rollStick: 0, pedal: 0, alpha: 0, beta: 0, p: 0, q: 0, r: 0, nz: 1,
        qbar: 0, staticPressure: 101325, landed: true, limitersEnabled: true, flapsExtended: true, airbrakesExtended: false,
    };

    // Scratch.
    private readonly vb = new Float64Array(3);
    private readonly fAero = new Float64Array(3);
    private readonly mAero = new Float64Array(3);
    private readonly tmp = new Float64Array(3);
    private readonly tmp2 = new Float64Array(3);
    private readonly prevVel = new Float64Array(3);
    private stageLoadFactor = 1;
    private readonly wrench: WrenchFunction;

    constructor(config: Fm2AircraftConfig = defaultFm2Config) {
        super();
        this.config = config;
        this.airframe = config.fm3 ?? F16_AIRFRAME;
        this.fcsConfig = F16_FCS;
        this.aero = new Fm3Aero(this.airframe);
        this.actuators = new Fm3Actuators(this.airframe, this.aero.controls);
        this.fcs = new Fm3Fcs(this.fcsConfig);

        const engine = this.airframe.engines[0];
        this.engine = new Fm3Engine({
            idleThrustN: engine ? engine.idleThrustN : config.engine.idleThrustKn * 1000,
            milThrustN: engine ? engine.milThrustN : config.engine.milThrustKn * 1000,
            abMinThrustN: config.engine.afterburner ? (engine ? engine.abMinThrustN : config.engine.abMinThrustKn * 1000) : 0,
            maxThrustN: config.engine.afterburner
                ? (engine ? engine.maxThrustN : config.engine.abMaxThrustKn * 1000)
                : (engine ? engine.milThrustN : config.engine.milThrustKn * 1000),
            milLeverEnd: config.engine.milLeverEnd,
            abMinLeverEnd: config.engine.abMinLeverEnd,
        });
        const cg = this.airframe.mass.cg;
        this.nozzle = engine ? nasaToSim([engine.nozzle[0] - cg[0], engine.nozzle[1] - cg[1], engine.nozzle[2] - cg[2]]) : [0, 0, 0];
        this.thrustAxis = engine ? nasaToSim(engine.axis) : [0, 0, 1];

        this.massKg = this.airframe.mass.massKg;
        this.rb.setMassProperties(this.massKg, inertiaNasaToSim(this.airframe.mass.inertia));
        const h = engine?.rotorMomentum ?? 0;
        this.rb.rotorMomentum[0] = this.thrustAxis[0] * h;
        this.rb.rotorMomentum[1] = this.thrustAxis[1] * h;
        this.rb.rotorMomentum[2] = this.thrustAxis[2] * h;

        this.gear = new Fm3GroundContact(config.gear);
        this.obj.up.set(0, 1, 0);

        this.wrench = (pos, vel, quat, omega, stage, force, moment) => {
            const vb = this.vb;
            rotateWorldToBody(quat, vel[0], vel[1], vel[2], vb);
            const fa = this.fAero;
            const ma = this.mAero;
            this.aero.evaluate(vb[0], vb[1], vb[2], omega[0], omega[1], omega[2], this.env, fa, ma, stage === 0);
            const t = this.thrustN;
            const ax = this.thrustAxis[0] * t, ay = this.thrustAxis[1] * t, az = this.thrustAxis[2] * t;
            const n = this.nozzle;
            moment[0] = ma[0] + (n[1] * az - n[2] * ay);
            moment[1] = ma[1] + (n[2] * ax - n[0] * az);
            moment[2] = ma[2] + (n[0] * ay - n[1] * ax);
            rotateBodyToWorld(quat, fa[0] + ax, fa[1] + ay, fa[2] + az, force);
            force[1] -= this.massKg * GRAVITY;
            let gearUp = 0;
            if (this.landingGearDeployed) {
                gearUp = this.gear.addForces(pos, vel, quat, omega, this.wheelBrakesApplied, force, moment, stage === 0);
            }
            if (stage === 0) {
                this.stageLoadFactor = (fa[1] + gearUp) / (this.massKg * GRAVITY);
            }
        };
        this.reset();
    }

    setWorldQuery(world: WorldQuery | undefined): void {
        this.world = world;
        this.gear.world = world;
    }

    reset(): void {
        super.reset();
        this.rb.pos.fill(0);
        this.rb.vel.fill(0);
        this.rb.quat[0] = 0; this.rb.quat[1] = 0; this.rb.quat[2] = 0; this.rb.quat[3] = 1;
        this.rb.omega.fill(0);
        this.aero.reset();
        this.actuators.reset();
        this.fcs.reset();
        this.engine.power = 0;
        this.thrustN = 0;
        this.stall = -1;
        this.stageLoadFactor = 1;
        this.sideslipRad = 0;
        for (let i = 0; i < this.gear.count; i++) this.gear.compression[i] = 0;
    }

    /** Pull externally set pose and velocity into the rigid body. */
    private adoptExternalState(): void {
        const p = this.obj.position, q = this.obj.quaternion, v = this.velocity;
        this.rb.pos[0] = p.x; this.rb.pos[1] = p.y; this.rb.pos[2] = p.z;
        this.rb.quat[0] = q.x; this.rb.quat[1] = q.y; this.rb.quat[2] = q.z; this.rb.quat[3] = q.w;
        this.rb.vel[0] = v.x; this.rb.vel[1] = v.y; this.rb.vel[2] = v.z;
    }

    private publishState(): void {
        this.obj.position.set(this.rb.pos[0], this.rb.pos[1], this.rb.pos[2]);
        this.obj.quaternion.set(this.rb.quat[0], this.rb.quat[1], this.rb.quat[2], this.rb.quat[3]);
        this.velocity.set(this.rb.vel[0], this.rb.vel[1], this.rb.vel[2]);
    }

    /**
     * Airborne spawn: match the engine to the lever, settle the aerodynamic
     * states for the current flight condition, and trim the pitch integrator
     * so the aircraft starts near 1 g instead of with a transient.
     */
    syncEffectiveThrottle(): void {
        super.syncEffectiveThrottle();
        this.engine.sync(this.throttle);
        this.effectiveThrottle = this.engine.equivalentLever();
        this.adoptExternalState();
        this.refreshAtmosphere();
        this.readSensors();
        const vb = this.vb;
        const w = this.rb.omega;
        this.aero.settle(vb[0], vb[1], vb[2], w[0], w[1], w[2], this.env);
        this.fcs.trimTo(0, this.fcsInput);
    }

    clearAngularVelocity(): void {
        this.rb.omega.fill(0);
    }

    contactSpeedIntoNormal(pointWorld: THREE.Vector3, normalWorld: THREE.Vector3): number {
        const t = this.tmp;
        rotateBodyToWorld(this.obj.quaternion.toArray(), this.rb.omega[0], this.rb.omega[1], this.rb.omega[2], t);
        const rx = pointWorld.x - this.obj.position.x;
        const ry = pointWorld.y - this.obj.position.y;
        const rz = pointWorld.z - this.obj.position.z;
        const vx = this.velocity.x + (t[1] * rz - t[2] * ry);
        const vy = this.velocity.y + (t[2] * rx - t[0] * rz);
        const vz = this.velocity.z + (t[0] * ry - t[1] * rx);
        const vn = vx * normalWorld.x + vy * normalWorld.y + vz * normalWorld.z;
        return vn < 0 ? -vn : 0;
    }

    /** Scrape friction at a contact point: an impulse opposing its velocity (as FM2). */
    applyContactDragAt(pointWorld: THREE.Vector3, dt: number, dragPerSec: number, massFraction: number, maxFrac: number): void {
        if (dt <= 0) return;
        const q = this.obj.quaternion.toArray();
        const t = this.tmp;
        rotateBodyToWorld(q, this.rb.omega[0], this.rb.omega[1], this.rb.omega[2], t);
        const rx = pointWorld.x - this.obj.position.x;
        const ry = pointWorld.y - this.obj.position.y;
        const rz = pointWorld.z - this.obj.position.z;
        const vx = this.velocity.x + (t[1] * rz - t[2] * ry);
        const vy = this.velocity.y + (t[2] * rx - t[0] * rz);
        const vz = this.velocity.z + (t[0] * ry - t[1] * rx);
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (speed < 1e-3) return;
        let frac = 1 - Math.exp(-dragPerSec * dt);
        if (frac > maxFrac) frac = maxFrac;
        const j = -frac * this.massKg * massFraction;
        this.applyImpulse(vx * j, vy * j, vz * j, ry * (vz * j) - rz * (vy * j), rz * (vx * j) - rx * (vz * j), rx * (vy * j) - ry * (vx * j));
    }

    applyExternalWrench(impulseWorld: THREE.Vector3, angularImpulseWorld: THREE.Vector3): void {
        this.applyImpulse(impulseWorld.x, impulseWorld.y, impulseWorld.z, angularImpulseWorld.x, angularImpulseWorld.y, angularImpulseWorld.z);
    }

    /** Linear impulse (world) into velocity; angular impulse (world) through the full inertia tensor. */
    private applyImpulse(jx: number, jy: number, jz: number, lx: number, ly: number, lz: number): void {
        this.velocity.x += jx / this.massKg;
        this.velocity.y += jy / this.massKg;
        this.velocity.z += jz / this.massKg;
        if (lx !== 0 || ly !== 0 || lz !== 0) {
            const b = this.tmp2;
            rotateWorldToBody(this.obj.quaternion.toArray(), lx, ly, lz, b);
            const Ii = this.rb.inertiaInv;
            this.rb.omega[0] += Ii[0] * b[0] + Ii[1] * b[1] + Ii[2] * b[2];
            this.rb.omega[1] += Ii[3] * b[0] + Ii[4] * b[1] + Ii[5] * b[2];
            this.rb.omega[2] += Ii[6] * b[0] + Ii[7] * b[1] + Ii[8] * b[2];
        }
    }

    private refreshAtmosphere(): void {
        const altitude = this.atmosphereAltitudeM;
        this.env.rho = computeAirDensity(altitude);
        this.env.soundSpeed = computeSpeedOfSound(altitude);
        const p = this.rb.pos;
        this.env.heightAboveGround = p[1] - this.gear.groundHeightAt(p[0], p[2]);
        this.env.gearDown = this.landingGearDeployed ? 1 : 0;
    }

    /** Air data and body rates from the current rigid-body state into the FCS input. */
    private readSensors(): void {
        const vb = this.vb;
        rotateWorldToBody(this.rb.quat, this.rb.vel[0], this.rb.vel[1], this.rb.vel[2], vb);
        const speed = Math.sqrt(vb[0] * vb[0] + vb[1] * vb[1] + vb[2] * vb[2]);
        const input = this.fcsInput;
        let alpha: number;
        if (speed > 1) {
            alpha = Math.atan2(-vb[1], vb[2]);
            this.sideslipRad = Math.asin(clamp(-vb[0] / speed, -1, 1));
        } else {
            // Tail-slide apex: the velocity vector says nothing; fall back to attitude (as FM2).
            const t = this.tmp;
            rotateBodyToWorld(this.rb.quat, 0, 0, 1, t);
            alpha = Math.asin(clamp(t[1], -1, 1));
            this.sideslipRad = 0;
        }
        input.alpha = alpha;
        input.beta = this.sideslipRad;
        const w = this.rb.omega;
        input.p = w[2];
        input.q = -w[0];
        input.r = -w[1];
        input.nz = this.stageLoadFactor;
        input.qbar = 0.5 * this.env.rho * speed * speed;
        input.staticPressure = this.env.rho * 287.053 * (this.env.soundSpeed * this.env.soundSpeed / (1.4 * 287.053));
        input.pitchStick = this.pitch;
        input.rollStick = this.roll;
        input.pedal = this.yaw;
        input.landed = this.landed;
        input.limitersEnabled = this.limitersEnabled;
        input.flapsExtended = this.flapsExtended;
        input.airbrakesExtended = this.airbrakesExtended;
        this.angleOfAttackRad = alpha;
    }

    step(delta: number): void {
        if (this.crashed) return;
        this.adoptExternalState();
        this.refreshAtmosphere();

        const altitude = this.atmosphereAltitudeM;
        this.engine.update(delta, this.throttle);
        this.effectiveThrottle = this.engine.equivalentLever();
        this.thrustN = this.engine.thrustN(this.env.rho, altitude);
        this.engineThrustN = this.thrustN;

        this.readSensors();
        this.fcs.update(this.fcsInput, delta, this.actuators.command);
        this.actuators.update(delta);
        this.publishSurfaceCommands();

        const vb = this.vb;
        const w = this.rb.omega;
        this.aero.advance(delta, vb[0], vb[1], vb[2], w[0], w[1], w[2], this.env);

        if (this.landingGearDeployed) {
            this.gear.samplePlanes(this.rb.pos, this.rb.quat);
        } else {
            for (let i = 0; i < this.gear.count; i++) this.gear.compression[i] = 0;
        }

        this.prevVel.set(this.rb.vel);
        if (!this.rb.step(delta, this.wrench)) {
            this.nanGuardTrips++;
            this.rb.omega.fill(0);
        }
        this.accelWorld.set(
            (this.rb.vel[0] - this.prevVel[0]) / delta,
            (this.rb.vel[1] - this.prevVel[1]) / delta,
            (this.rb.vel[2] - this.prevVel[2]) / delta,
        );
        this.loadFactorG = this.stageLoadFactor;

        if (this.landingGearDeployed) {
            const excess = this.gear.excessPenetration(this.rb.pos, this.rb.quat);
            if (excess > 0) {
                this.rb.pos[1] += excess;
                if (this.rb.vel[1] < 0) this.rb.vel[1] = 0;
            }
        }
        this.publishState();
        this.clampParkedGroundSpeed();
        this.updateStall();
        this.handleGroundState();
    }

    private publishSurfaceCommands(): void {
        const pos = this.aero.controls;
        const stab = 0.5 * (pos[CHANNEL_INDEX.stabL] + pos[CHANNEL_INDEX.stabR]);
        const maxStab = this.fcsConfig.pitch.maxStab;
        const maxAileron = this.fcsConfig.roll.maxAileron;
        const maxRudder = this.fcsConfig.yaw.maxRudder;
        this.commandedElevator = clamp(-stab / maxStab, -1, 1);
        this.commandedAileron = clamp(0.5 * (pos[CHANNEL_INDEX.flapL] - pos[CHANNEL_INDEX.flapR]) / maxAileron, -1, 1);
        this.commandedRudder = clamp(pos[CHANNEL_INDEX.rudder] / maxRudder, -1, 1);
        this.elevatorCommandLimitHigh = 1;
        this.elevatorCommandLimitLow = -1;
    }

    private updateStall(): void {
        if (this.landed) {
            this.stall = -1;
            return;
        }
        const separated = this.aero.wingSeparatedFraction();
        this.stall = separated > 0.15 ? Math.min(1, (separated - 0.15) / 0.5) : -1;
    }

    /** Stop residual creep once settled on the runway with the engine idle (as FM2). */
    private clampParkedGroundSpeed(): void {
        if (!this.landed) return;
        const terrainY = this.gear.groundHeightAt(this.obj.position.x, this.obj.position.z);
        if (this.obj.position.y > terrainY + this.gear.restHeight + 0.25) return;
        if (this.throttle > 0.01 || this.effectiveThrottle > 0.05) return;
        if (Math.hypot(this.velocity.x, this.velocity.z) > 0.25) return;
        this.velocity.x = 0;
        this.velocity.z = 0;
        this.rb.vel[0] = 0;
        this.rb.vel[2] = 0;
    }

    /** Landed and crash rules on the configured envelope (as FM2). */
    private handleGroundState(): void {
        const terrainY = this.gear.groundHeightAt(this.obj.position.x, this.obj.position.z);
        const restY = terrainY + this.gear.restHeight;
        const onGround = this.obj.position.y <= restY + 0.25;
        if (this.obj.position.y > restY + 0.3) this.landed = false;

        if (this.landingGearDeployed) {
            const minY = restY - this.gear.maxStroke;
            if (this.obj.position.y < minY) {
                this.obj.position.y = minY;
                this.rb.pos[1] = minY;
                if (this.velocity.y < 0) {
                    this.velocity.y = 0;
                    this.rb.vel[1] = 0;
                }
            }
        }
        if (!onGround) return;

        const fwd = new THREE.Vector3().copy(FORWARD).applyQuaternion(this.obj.quaternion);
        const right = new THREE.Vector3().copy(RIGHT).applyQuaternion(this.obj.quaternion);
        const speed = this.velocity.length();
        const pitchAngle = Math.asin(clamp(fwd.y, -1, 1));
        const rollAngle = Math.asin(clamp(right.y, -1, 1));
        const env = this.config.envelope;
        let maxCompress = 0;
        for (const c of this.gear.compression) maxCompress = Math.max(maxCompress, c);
        const oleoBottomed = !this.landingGearDeployed || maxCompress >= this.gear.maxStroke * 0.95;
        const hardContact = oleoBottomed && this.velocity.y < -env.landingMaxVerticalSpeedMps;
        const badAttitude = Math.abs(rollAngle) > env.landingMaxRollRad || pitchAngle < env.landingMinPitchRad;
        if (!this.landed && (hardContact || speed > env.landingMaxSpeedMps)) {
            if (!this.landingGearDeployed || hardContact || badAttitude) {
                this.crashed = true;
                return;
            }
        }
        if (!this.landingGearDeployed && this.velocity.y < -1.0) {
            this.crashed = true;
            return;
        }
        if (speed < env.landingMaxSpeedMps && Math.abs(rollAngle) < env.landingMaxRollRad) {
            this.landed = true;
        }
    }

    getStallStatus(): number {
        return this.stall;
    }

    /** Sideslip angle (rad), NASA convention: positive with the wind from starboard. */
    getSideslip(): number {
        return this.sideslipRad;
    }

    getGearCompression(): ReadonlyArray<number> {
        return this.gear.compression;
    }

    getForceVectorSnapshot(): ForceVectorSample[] {
        const vb = this.vb;
        rotateWorldToBody(this.rb.quat, this.rb.vel[0], this.rb.vel[1], this.rb.vel[2], vb);
        const samples = this.aero.forceVectorSnapshot(vb[0], vb[1], vb[2]);
        samples.push({
            part: 'engine', kind: 'thrust', origin: [this.nozzle[0], this.nozzle[1], this.nozzle[2]],
            vec: [this.thrustAxis[0] * this.thrustN, this.thrustAxis[1] * this.thrustN, this.thrustAxis[2] * this.thrustN],
        });
        const wgt = this.tmp;
        rotateWorldToBody(this.rb.quat, 0, -this.massKg * GRAVITY, 0, wgt);
        samples.push({ part: 'cg', kind: 'weight', origin: [0, 0, 0], vec: [wgt[0], wgt[1], wgt[2]] });
        return samples;
    }

    // --- Throttle quadrant: FM2's F100 quadrant for afterburning engines. ---
    private get afterburner(): boolean { return this.config.engine.afterburner; }
    getThrottleHudText(): string { return this.afterburner ? formatF16ThrottleHud(this.throttle) : super.getThrottleHudText(); }
    useAfterburnerThrottleDetents(): boolean { return this.afterburner; }
    stepThrottleDetent(current: number, direction: 1 | -1): number { return this.afterburner ? stepF16ThrottleDetent(current, direction) : super.stepThrottleDetent(current, direction); }
    isInThrottleAbDetentBand(lever: number): boolean { return this.afterburner ? isF16AbDetentBand(lever) : super.isInThrottleAbDetentBand(lever); }
    adjustThrottleInput(current: number, step: number): number { return this.afterburner ? adjustF16ThrottleInput(current, step) : super.adjustThrottleInput(current, step); }
    getThrottleZone(): string { return this.afterburner ? getF16ThrottleZone(this.effectiveThrottle) : 'mil'; }
    getThrottleAudioLevel(): number { return this.afterburner ? f16ThrottleAudioLevel(this.effectiveThrottle) : super.getThrottleAudioLevel(); }
    getEngineNozzleColor(): string { return this.afterburner ? getF16EngineNozzleColor(this.effectiveThrottle) : super.getEngineNozzleColor(); }
}

export { invert3x3, DEG };

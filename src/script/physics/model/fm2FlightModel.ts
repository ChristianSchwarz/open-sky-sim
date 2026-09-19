/**
 * FM2 — rigid-body "parts" flight model.
 *
 * Unlike the kinematic Realistic model (which rotates the airframe directly from
 * stick authority), FM2 is a genuine 6-DOF rigid body. Every aerodynamic force
 * is produced by a discrete lifting surface at its real location, so all moments
 * — and the pitch/roll/yaw rate damping — emerge from the geometry. A fly-by-wire
 * layer closes rate/g loops around the airframe to give crisp jet handling. Landing
 * gear is modelled as spring-damper contact points, so weight-on-wheels, takeoff
 * rotation and ground stability are also just rigid-body reactions.
 *
 * See physics/fm2/* for the building blocks.
 */
import * as THREE from 'three';
import {
    MAX_ALTITUDE, MAX_SPEED, PITCH_RATE, PLANE_DISTANCE_TO_GROUND, ROLL_RATE, YAW_RATE,
} from '../../defs';
import { clamp, FORWARD, isZero, RIGHT, UP } from '../../utils/math';
import {
    computeAirDensity, computeDynamicPressure, computeIsaAirDensity,
    computeMachNumber, computeThrustDensityFactor,
} from '../aeroUtils';
import {
    adjustF16ThrottleInput, computeF16EngineThrustN, f16ThrottleAudioLevel,
    formatF16ThrottleHud, getF16EngineNozzleColor, getF16ThrottleZone,
    isF16AbDetentBand, stepF16ThrottleDetent,
} from '../f16Engine';
import { AeroSurface } from '../fm2/aeroSurface';
import { Fm2Fcs } from '../fm2/fcs';
import { Fm2AircraftConfig, defaultFm2Config, fm2GroundRestHeight } from '../fm2/fm2AircraftConfig';
import { forebodyAsymmetryCy } from '../fm2/forebodyAsymmetry';
import { RigidBody } from '../fm2/rigidBody';
import { FlightModel, ForceVectorSample } from './flightModel';
import { WorldQuery } from '../../ai/worldQuery';

const GRAVITY = 9.80665;

const THROTTLE_UP_RATE = 0.10;
const THROTTLE_DOWN_RATE = 0.07;

/**
 * Half-extent (m) of the XZ samples around each gear point. A single point
 * under the axle lets the tyre mesh dig into rising terrain by ~radius×slope;
 * taking the max height in this footprint keeps the whole wheel above the deck.
 */
const GEAR_CONTACT_FOOTPRINT_M = 0.45;
/** Finite-difference half-step (m) for heightfield surface normals. */
const GROUND_NORMAL_EPS_M = 0.5;

/** Optional per-model behaviour flags (orthogonal to the aircraft config). */
export interface Fm2ModelOptions {
    /**
     * No-aerodynamics "free-fly" mode: stick rotates the airframe directly and
     * speed follows the throttle. Handy for inspecting scenery/models without the
     * rigid-body aerodynamics fighting the camera (the old DEBUG flight model).
     */
    kinematic?: boolean;
}

interface SurfaceControls {
    wingLeftAoa: number;
    wingRightAoa: number;
    htailLeftAoa: number;
    htailRightAoa: number;
    vtailAoa: number;
    aileronLeftAoa: number;
    aileronRightAoa: number;
}

export class Fm2FlightModel extends FlightModel {

    private readonly config: Fm2AircraftConfig;
    private readonly kinematic: boolean;

    private readonly rb: RigidBody;
    private readonly fcs: Fm2Fcs;

    private readonly fuselage: AeroSurface;
    private readonly wingLeft: AeroSurface;
    private readonly wingRight: AeroSurface;
    private readonly htailLeft: AeroSurface;
    private readonly htailRight: AeroSurface;
    private readonly vtail: AeroSurface;
    /** Optional dedicated aileron surfaces (present when the config supplies them). */
    private readonly aileronLeft?: AeroSurface;
    private readonly aileronRight?: AeroSurface;
    /** Optional forward strake/LERX surface (present when the config supplies it) —
     *  the real, fixed-arm source of the post-stall nose-up moment (see
     *  `Fm2SurfaceSet.foreStrake`). Replaces the old scripted CG relocation. */
    private readonly foreStrake?: AeroSurface;
    /** All lifting surfaces in build order — the single list the step and the
     *  force-vector snapshot both iterate. */
    private readonly allSurfaces: AeroSurface[];

    /** Current integration timestep (s), published to the surfaces each step so
     *  their unsteady separation-state lag advances at the true dt. */
    private currentStepDt = 1 / 120;

    /** Reference dynamic pressure at the design cruise condition (Pa). */
    private readonly qRef: number;

    private stall = -1;

    /** Per-leg oleo compression from the last gear-force step (m). */
    private readonly gearCompression: number[];

    /** Body Y when level on flat ground (deepest gear contact at world y=0). */
    private get groundRestY(): number {
        return fm2GroundRestHeight(this.config);
    }

    private get maxGearStrokeM(): number {
        return this.config.gear.maxStrokeM ?? 0.35;
    }

    /** Terrain / obstacle query from the combat worker (optional). */
    private world: WorldQuery | undefined;

    // Scratch vectors (avoid per-step allocation in the worker).
    private readonly velBody = new THREE.Vector3();
    private readonly forceBody = new THREE.Vector3();
    private readonly momentBody = new THREE.Vector3();
    private readonly forceWorld = new THREE.Vector3();
    private readonly gearForceWorld = new THREE.Vector3();
    private readonly gearMomentBody = new THREE.Vector3();
    private readonly invOrient = new THREE.Quaternion();
    private readonly _fwd = new THREE.Vector3();
    private readonly _right = new THREE.Vector3();
    private readonly _v = new THREE.Vector3();
    private readonly _v2 = new THREE.Vector3();
    private readonly _gearWorld = new THREE.Vector3();
    private readonly _contactVel = new THREE.Vector3();
    private readonly _omegaWorld = new THREE.Vector3();
    private readonly _friction = new THREE.Vector3();
    private readonly _groundNormal = new THREE.Vector3();
    private readonly _vTan = new THREE.Vector3();
    private readonly _impulseR = new THREE.Vector3();
    /** Last forebody asymmetry side force (body frame, N); for the debug overlay. */
    private readonly forebodyForceBody = new THREE.Vector3();

    constructor(config: Fm2AircraftConfig = defaultFm2Config, options: Fm2ModelOptions = {}) {
        super();
        this.config = config;
        this.kinematic = options.kinematic ?? false;
        this.rb = new RigidBody(config.geometry.massKg, {
            x: config.inertia.pitch,
            y: config.inertia.yaw,
            z: config.inertia.roll,
        });
        this.fcs = new Fm2Fcs(config.fcs);
        this.fuselage = new AeroSurface(config.surfaces.fuselage);
        this.wingLeft = new AeroSurface(config.surfaces.wingLeft);
        this.wingRight = new AeroSurface(config.surfaces.wingRight);
        this.htailLeft = new AeroSurface(config.surfaces.htailLeft);
        this.htailRight = new AeroSurface(config.surfaces.htailRight);
        this.vtail = new AeroSurface(config.surfaces.vtail);
        if (config.surfaces.aileronLeft) {
            this.aileronLeft = new AeroSurface(config.surfaces.aileronLeft);
        }
        if (config.surfaces.aileronRight) {
            this.aileronRight = new AeroSurface(config.surfaces.aileronRight);
        }
        if (config.surfaces.foreStrake) {
            this.foreStrake = new AeroSurface(config.surfaces.foreStrake);
        }
        this.allSurfaces = [
            this.fuselage, this.wingLeft, this.wingRight,
            this.htailLeft, this.htailRight, this.vtail,
            ...(this.aileronLeft ? [this.aileronLeft] : []),
            ...(this.aileronRight ? [this.aileronRight] : []),
            ...(this.foreStrake ? [this.foreStrake] : []),
        ];
        this.qRef = 0.5 * computeIsaAirDensity(config.envelope.cruiseAltitudeM)
            * config.envelope.cruiseSpeedMps ** 2;
        this.gearCompression = new Array(config.gear.points.length).fill(0);
        this.obj.up.copy(UP);
    }

    /** Terrain height + obstacles for gear contact (flat Y=0 when unset). */
    setWorldQuery(world: WorldQuery | undefined): void {
        this.world = world;
    }

    /** Solid ground Y under a world XZ (hills + flat datum). */
    private groundHeightAt(x: number, z: number): number {
        return this.world?.groundHeightAt(x, z) ?? 0;
    }

    /**
     * Highest solid ground under a gear tyre footprint (center + ±footprint on X/Z).
     * Flat ground unchanged; on ramps/hills the uphill side of the tyre sets the contact.
     */
    private groundHeightUnderGear(x: number, z: number): number {
        const r = GEAR_CONTACT_FOOTPRINT_M;
        return Math.max(
            this.groundHeightAt(x, z),
            this.groundHeightAt(x + r, z),
            this.groundHeightAt(x - r, z),
            this.groundHeightAt(x, z + r),
            this.groundHeightAt(x, z - r),
        );
    }

    reset(): void {
        super.reset();
        this.rb.reset();
        this.fcs.reset();
        this.stall = -1;
        for (let i = 0; i < this.gearCompression.length; i++) {
            this.gearCompression[i] = 0;
        }
        for (const s of this.allSurfaces) {
            s.resetState();
        }
    }

    /** Keep the rigid body in sync after external teleports / solid-world pushes. */
    override snapPhysicsState(): void {
        super.snapPhysicsState();
        this.rb.orientation.copy(this.obj.quaternion);
        this.rb.velocityWorld.copy(this.velocity);
    }

    /** Zero body rates (kinematic deck park). */
    clearAngularVelocity(): void {
        this.rb.angularVelocityBody.set(0, 0, 0);
    }

    /**
     * Inward speed of the body at `pointWorld` along `normalWorld` (m/s).
     * Zero when the contact is separating or sliding purely tangentially.
     */
    contactSpeedIntoNormal(pointWorld: THREE.Vector3, normalWorld: THREE.Vector3): number {
        this.rb.orientation.copy(this.obj.quaternion);
        this.rb.velocityWorld.copy(this.velocity);
        this._impulseR.subVectors(pointWorld, this.obj.position);
        this._omegaWorld.copy(this.rb.angularVelocityBody).applyQuaternion(this.rb.orientation);
        this._contactVel.crossVectors(this._omegaWorld, this._impulseR).add(this.rb.velocityWorld);
        const vn = this._contactVel.dot(normalWorld);
        return vn < 0 ? -vn : 0;
    }

    /**
     * Mild drag at a world contact point while scraping a solid.
     * Bleeds a fraction of the contact-point velocity into an impulse at that
     * point (linear + angular) — no bounce, no whole-body speed dump.
     */
    applyContactDragAt(
        pointWorld: THREE.Vector3,
        dt: number,
        dragPerSec: number,
        massFraction: number,
        maxFrac: number,
    ): void {
        if (this.kinematic || dt <= 0) return;

        this.rb.orientation.copy(this.obj.quaternion);
        this.rb.velocityWorld.copy(this.velocity);
        this.invOrient.copy(this.rb.orientation).invert();

        this._impulseR.subVectors(pointWorld, this.obj.position);
        this._omegaWorld.copy(this.rb.angularVelocityBody).applyQuaternion(this.rb.orientation);
        this._contactVel.crossVectors(this._omegaWorld, this._impulseR).add(this.rb.velocityWorld);

        const speed = this._contactVel.length();
        if (speed < 1e-3) {
            this.velocity.copy(this.rb.velocityWorld);
            return;
        }

        let frac = 1 - Math.exp(-dragPerSec * dt);
        if (frac > maxFrac) frac = maxFrac;
        // Impulse opposing contact velocity; scaled so a tip scrape does not act like full-mass braking.
        const jScale = -frac * this.rb.mass * massFraction;
        this._friction.copy(this._contactVel).multiplyScalar(jScale);

        this.rb.velocityWorld.addScaledVector(this._friction, 1 / this.rb.mass);
        this._v.crossVectors(this._impulseR, this._friction).applyQuaternion(this.invOrient);
        const I = this.rb.inertia;
        this.rb.angularVelocityBody.x += this._v.x / I.x;
        this.rb.angularVelocityBody.y += this._v.y / I.y;
        this.rb.angularVelocityBody.z += this._v.z / I.z;

        this.velocity.copy(this.rb.velocityWorld);
        this.obj.quaternion.copy(this.rb.orientation);
    }

    /**
     * Take a wrench from something that has hold of the airframe.
     *
     * Same book-keeping as the scrape friction above, in both halves: the linear
     * impulse goes straight into world velocity, and the angular impulse into
     * the body rates through the inertia. Applying impulses rather than forces
     * keeps both independent of how long the caller's step happened to be.
     */
    applyExternalWrench(impulseWorld: THREE.Vector3, angularImpulseWorld: THREE.Vector3): void {
        if (this.kinematic) return;
        const linear = impulseWorld.lengthSq() > 1e-12;
        const angular = angularImpulseWorld.lengthSq() > 1e-12;
        if (!linear && !angular) return;

        this.rb.orientation.copy(this.obj.quaternion);
        this.rb.velocityWorld.copy(this.velocity);
        this.invOrient.copy(this.rb.orientation).invert();

        if (linear) {
            this.rb.velocityWorld.addScaledVector(impulseWorld, 1 / this.rb.mass);
            this.velocity.copy(this.rb.velocityWorld);
        }
        if (angular) {
            this._v.copy(angularImpulseWorld).applyQuaternion(this.invOrient);
            const I = this.rb.inertia;
            this.rb.angularVelocityBody.x += this._v.x / I.x;
            this.rb.angularVelocityBody.y += this._v.y / I.y;
            this.rb.angularVelocityBody.z += this._v.z / I.z;
        }
    }

    step(delta: number): void {
        if (this.crashed) return;

        if (this.kinematic) {
            this.stepKinematic(delta);
            return;
        }

        this.spoolThrottle(delta);
        // Publish the timestep for the surfaces' unsteady separation-state lag.
        this.currentStepDt = delta;

        // Adopt any externally set orientation / velocity as the rigid-body state.
        this.rb.orientation.copy(this.obj.quaternion);
        this.rb.velocityWorld.copy(this.velocity);

        // Height above the ellipsoid, not scene Y: away from the play area's
        // origin the two differ by up to ~1.8 km, and feeding raw Y to the ISA
        // model would fly the aircraft through air a fifth too dense out there.
        const altitude = this.atmosphereAltitudeM;
        const airDensity = computeAirDensity(altitude);

        // Body-frame velocity through the air.
        this.invOrient.copy(this.rb.orientation).invert();
        this.velBody.copy(this.rb.velocityWorld).applyQuaternion(this.invOrient);
        const speed = this.velBody.length();

        // Aircraft angle of attack (in the body X-plane) and sideslip.
        const aoa = this.computeBodyAoa(speed);
        this.angleOfAttackRad = aoa;

        const dynamicPressure = computeDynamicPressure(airDensity, speed);
        const mach = computeMachNumber(speed, altitude);

        // Fly-by-wire: stick/pedals + state → surface commands.
        const fcsOut = this.fcs.update({
            pitchStick: this.pitch,
            rollStick: this.roll,
            // Negated so positive pedal yaws the nose the same way as the other
            // flight models (right pedal -> nose right); only the pilot command
            // is flipped, the yaw-damper/ARI feedback keeps its stabilizing sign.
            yawPedal: -this.yaw,
            pitchRate: this.rb.angularVelocityBody.x,
            yawRate: this.rb.angularVelocityBody.y,
            rollRate: this.rb.angularVelocityBody.z,
            loadFactorG: this.loadFactorG,
            aoaRad: aoa,
            dynamicPressure,
            qRef: this.qRef,
            speed,
            altitudeM: altitude,
            flapsExtended: this.flapsExtended,
            landed: this.landed,
            pitchLimiterMode: this.pitchLimiterMode,
            limitersEnabled: this.limitersEnabled,
        }, delta);

        const controls = this.mapControls(fcsOut.elevator, fcsOut.aileron, fcsOut.rudder);

        // Publish the FCS-commanded deflections for the visible surfaces, in the
        // SAME polarity as the raw pilot stick they replace (so the aircraft defs'
        // existing per-surface sign/range still render correctly):
        //  - elevator: the g-command law already uses +cmd = nose-up = +aft stick,
        //    so it is exposed as-is.
        //  - aileron/rudder: the FCS commands the surface with the OPPOSITE internal
        //    sign to the stick (a +aileron cmd makes a −roll moment; the pilot yaw is
        //    negated on the way in via `yawPedal: -this.yaw`), so both are negated
        //    here to preserve the visual deflection direction.
        this.commandedElevator = fcsOut.elevator;
        this.commandedAileron = -fcsOut.aileron;
        this.commandedRudder = -fcsOut.rudder;
        this.elevatorCommandLimitHigh = fcsOut.elevatorLimitHi;
        this.elevatorCommandLimitLow = fcsOut.elevatorLimitLo;

        // ---- Aerodynamic force & moment build-up from the rigid parts. ----
        this.forceBody.set(0, 0, 0);
        this.momentBody.set(0, 0, 0);

        const flaps = this.config.flaps;
        const camber = this.flapsExtended ? flaps.aoaBiasRad : 0;
        const stallShift = this.flapsExtended ? flaps.stallReductionRad : 0;
        const wingExtraCd = this.flapsExtended ? flaps.extraCd : 0;

        // Blended lifting body at the CG (no flaps, no control incidence).
        this.accumulateSurface(this.fuselage, 0, 0, 0, 0, airDensity);
        this.accumulateSurface(this.wingLeft, controls.wingLeftAoa, camber, stallShift, wingExtraCd, airDensity);
        this.accumulateSurface(this.wingRight, controls.wingRightAoa, camber, stallShift, wingExtraCd, airDensity);
        this.accumulateSurface(this.htailLeft, controls.htailLeftAoa, 0, 0, 0, airDensity);
        this.accumulateSurface(this.htailRight, controls.htailRightAoa, 0, 0, 0, airDensity);
        this.accumulateSurface(this.vtail, controls.vtailAoa, 0, 0, 0, airDensity);
        if (this.aileronLeft) {
            this.accumulateSurface(this.aileronLeft, controls.aileronLeftAoa, 0, 0, 0, airDensity);
        }
        if (this.aileronRight) {
            this.accumulateSurface(this.aileronRight, controls.aileronRightAoa, 0, 0, 0, airDensity);
        }
        if (this.foreStrake) {
            // Real forward strake/LERX: no flaps, no control incidence — its
            // own lift curve (vortex lift + unsteady lag) through its real,
            // fixed arm ahead of the CG is the genuine post-stall pitch-up
            // source (replaces the old scripted CG relocation).
            this.accumulateSurface(this.foreStrake, 0, 0, 0, 0, airDensity);
        }

        // Forebody vortex asymmetry (Ericsson nose slice) — only in the subscale
        // /laminar Reynolds regime; at full-scale it contributes nothing.
        this.applyForebodyAsymmetry(aoa, dynamicPressure, speed);

        // Fuselage / parasite / gear / wave drag along the relative wind.
        this.addBodyDrag(dynamicPressure, speed, mach);

        // Thrust along the nose (+Z body).
        const thrustN = this.computeThrustN(this.effectiveThrottle, altitude);
        this.engineThrustN = thrustN;
        this.forceBody.z += thrustN;

        // Landing-gear reactions (computed in world, moment folded into body frame).
        this.computeGearForces();

        // Load factor: specific normal (body-up) force / g, incl. gear reaction.
        const gearBodyUpY = this._v.copy(this.gearForceWorld).applyQuaternion(this.invOrient).y;
        this.loadFactorG = (this.forceBody.y + gearBodyUpY) / (this.config.geometry.massKg * GRAVITY);

        // Transonic pitch-damping augmentation (added Cmq): only ramps in above the
        // configured qNorm knee, so the whole maneuvering envelope is untouched and
        // only transonic overspeed gets the extra short-period damping.
        this.applyTransonicPitchDamp(dynamicPressure, this.rb.angularVelocityBody.x);

        // ---- Integrate rotational dynamics (body frame). ----
        this.momentBody.add(this.gearMomentBody);
        this.rb.integrateAngular(this.momentBody, delta);

        // ---- Integrate translational dynamics (world frame). ----
        this.forceWorld.copy(this.forceBody).applyQuaternion(this.rb.orientation);
        this.forceWorld.add(this.gearForceWorld);
        this.forceWorld.y -= this.config.geometry.massKg * GRAVITY; // gravity
        this.accelWorld.copy(this.forceWorld).divideScalar(this.config.geometry.massKg);
        this.rb.integrateLinear(this.forceWorld, delta, this.obj.position);

        // Publish rigid-body state back to the base model.
        this.obj.quaternion.copy(this.rb.orientation);
        this.velocity.copy(this.rb.velocityWorld);
        // Soft springs alone tunnel on rising terrain; clamp contacts to the
        // heightfield (hills, ski jumps, flat datum — anything groundHeightAt returns).
        this.resolveGearTerrainPenetration();
        this.clampParkedGroundSpeed();

        this.updateStallState(speed, aoa, altitude);
        this.handleGroundState();
    }

    private spoolThrottle(delta: number): void {
        if (this.effectiveThrottle > this.throttle) {
            this.effectiveThrottle = Math.max(this.throttle, this.effectiveThrottle - THROTTLE_DOWN_RATE * delta);
        } else if (this.effectiveThrottle < this.throttle) {
            this.effectiveThrottle = Math.min(this.throttle, this.effectiveThrottle + THROTTLE_UP_RATE * delta);
        }
    }

    private mapControls(elevator: number, aileron: number, rudder: number): SurfaceControls {
        const maxStabilator = this.config.fcs.maxStabilatorRad;
        const maxAileron = this.config.aileronMaxDeflectionRad;
        const maxRudder = this.config.fcs.maxRudderRad;
        // Elevator: +cmd = nose up → negative stabilator incidence (tail lift down).
        // A single real hardware deflection limit applies at every speed/AoA — no
        // artificial high-AoA authority boost.
        const elevatorAoa = -elevator * maxStabilator;
        // Differential tail (taileron) assists roll.
        const taileronAoa = aileron * this.config.fcs.taileronRollFraction * maxStabilator;
        // Roll incidence goes to the dedicated aileron surfaces when present; only
        // an airframe without them falls back to deflecting the whole wing (legacy).
        const aileronAoa = aileron * maxAileron;
        const hasAilerons = this.aileronLeft !== undefined || this.aileronRight !== undefined;
        return {
            wingLeftAoa: hasAilerons ? 0 : aileronAoa,
            wingRightAoa: hasAilerons ? 0 : -aileronAoa,
            htailLeftAoa: elevatorAoa + taileronAoa,
            htailRightAoa: elevatorAoa - taileronAoa,
            vtailAoa: -rudder * maxRudder,
            aileronLeftAoa: hasAilerons ? aileronAoa : 0,
            aileronRightAoa: hasAilerons ? -aileronAoa : 0,
        };
    }

    /** Delivered thrust (N) at altitude for the configured engine. */
    private computeThrustN(lever: number, altitude: number): number {
        const e = this.config.engine;
        if (e.afterburner) {
            // Afterburner F100-class quadrant + lapse for the default aircraft.
            return computeF16EngineThrustN(lever, altitude);
        }
        // Plain idle→military schedule with the same ISA density lapse.
        const slKn = e.idleThrustKn + (e.milThrustKn - e.idleThrustKn) * clamp(lever, 0, 1);
        const rho = computeAirDensity(altitude);
        return slKn * 1000 * computeThrustDensityFactor(rho, altitude);
    }

    private accumulateSurface(
        surface: AeroSurface, controlAoa: number, camber: number,
        stallShift: number, extraCd: number, airDensity: number,
    ): void {
        surface.accumulate({
            velocityBody: this.velBody,
            angularVelocityBody: this.rb.angularVelocityBody,
            airDensity,
            controlDeltaAoaRad: controlAoa,
            camberBiasRad: camber,
            stallShiftRad: stallShift,
            extraCd,
            dt: this.currentStepDt,
        }, this.forceBody, this.momentBody);
    }

    /**
     * Forebody vortex asymmetry — the high-alpha "nose slice" (Ericsson,
     * ICAS-92-4.6R). Above the onset AoA a slender forebody sheds an asymmetric
     * vortex pair whose side force, acting on the long nose arm, makes a large
     * yawing moment. The direction locks in with the vehicle's own coning motion
     * (moving-wall / transition coupling), so it is self-reinforcing → a yaw
     * departure. This coupling only develops in LAMINAR / subscale flow; at
     * full-scale Reynolds numbers it is suppressed, which is why the real cobra
     * stays symmetric. We therefore apply it ONLY in the subscale/laminar regime
     * (see {@link FlightModel.setForebodyLaminar}); at full-scale (default) it is
     * a no-op and the airframe stays laterally symmetric.
     */
    private applyForebodyAsymmetry(aoa: number, dynamicPressure: number, speed: number): void {
        this.forebodyForceBody.set(0, 0, 0);
        const cfg = this.config.forebodyAsymmetry;
        if (!cfg || !this.forebodyLaminar) return;

        const cy = forebodyAsymmetryCy(
            aoa,
            this.rb.angularVelocityBody.y, // yaw rate about +Y (the coning motion)
            this.rb.angularVelocityBody.x, // pitch rate about +X (nose-AoA shift)
            speed, cfg,
        );
        if (cy === 0) return;

        // Side force along body +X, applied at the nose (0, 0, armZ) relative to
        // the (fixed) CG, giving a pure yawing moment about +Y.
        const fx = dynamicPressure * cfg.refAreaM2 * cy;
        this.forebodyForceBody.set(fx, 0, 0);
        this.forceBody.x += fx;
        this.momentBody.y += cfg.armZ * fx;
    }

    /**
     * Transonic pitch-damping augmentation (an added aerodynamic Cmq term).
     *
     * The geometric tail damping keeps the short period well-damped through the
     * normal envelope, but as q climbs into transonic overspeed the short-period
     * frequency rises and the FCS's fixed actuator/sensor lag erodes its phase
     * margin faster than the natural damping grows, so the closed loop rings (a
     * hands-off ~Mach 0.98 −4 g ↔ +8 g limit cycle). This adds a pitch-rate
     * damping MOMENT that scales with q̄·S·c and ramps in only ABOVE the qNorm
     * knee, so the whole maneuvering envelope (incl. the structural-g pulls and
     * the low-speed / high-AoA cobra, all below the knee) is byte-for-byte
     * unchanged. pitchRate about +X is nose-down-positive, so the moment opposes
     * the rate regardless of sign.
     */
    private applyTransonicPitchDamp(dynamicPressure: number, pitchRate: number): void {
        const cfg = this.config.transonicPitchDamp;
        if (!cfg) return;
        const qNorm = dynamicPressure / Math.max(this.qRef, 1);
        if (qNorm <= cfg.qKnee) return;
        const ramp = clamp(qNorm / cfg.qKnee - 1, 0, cfg.maxRamp ?? 2);
        const g = this.config.geometry;
        this.momentBody.x -= cfg.gain * dynamicPressure * g.wingAreaM2 * g.meanChordM * pitchRate * ramp;
    }

    /**
     * No-aerodynamics free-fly step (kinematic / DEBUG mode). Stick rotates the
     * airframe directly, speed follows the throttle, with simple ground and
     * altitude clamps. Ported from the old standalone DebugFlightModel so the
     * capability lives on the single model as a config-selected mode.
     */
    private stepKinematic(delta: number): void {
        this.effectiveThrottle = this.throttle;
        this.engineThrustN = 0;

        // No FCS in free-fly mode: drive the visible surfaces straight from the
        // raw stick (already in the exposed display polarity) so they still animate.
        this.commandedElevator = this.pitch;
        this.commandedAileron = this.roll;
        this.commandedRudder = this.yaw;
        this.elevatorCommandLimitHigh = 1;
        this.elevatorCommandLimitLow = -1;

        if (!isZero(this.roll)) this.obj.rotateZ(this.roll * ROLL_RATE * delta);
        if (!isZero(this.pitch)) this.obj.rotateX(-this.pitch * PITCH_RATE * delta);
        if (!isZero(this.yaw)) this.obj.rotateY(-this.yaw * YAW_RATE * delta);

        // Automatic yaw into the turn when rolling (coordinated look-around feel).
        const forward = this.obj.getWorldDirection(this._v);
        if (-0.99 < forward.y && forward.y < 0.99) {
            const prjForward = forward.setY(0);
            const up = this._v2.copy(UP).applyQuaternion(this.obj.quaternion);
            const prjUp = up.projectOnPlane(prjForward).setY(0);
            const sign = (prjForward.x * prjUp.z - prjForward.z * prjUp.x) > 0 ? -1 : 1;
            this.obj.rotateOnWorldAxis(UP,
                sign * prjUp.length() * prjUp.length() * prjForward.length() * 2.0 * YAW_RATE * delta);
        }

        const speed = this.effectiveThrottle * MAX_SPEED;
        this.obj.translateZ(speed * delta);

        if (this.obj.position.y < PLANE_DISTANCE_TO_GROUND) {
            this.obj.position.y = PLANE_DISTANCE_TO_GROUND;
            const d = this.obj.getWorldDirection(this._v);
            if (d.y < 0.0) {
                d.setY(0).add(this.obj.position);
                this.obj.lookAt(d);
            }
        }
        if (this.obj.position.y > MAX_ALTITUDE) this.obj.position.y = MAX_ALTITUDE;

        const prevVel = this._v2.copy(this.velocity);
        this.velocity.copy(FORWARD).applyQuaternion(this.obj.quaternion).multiplyScalar(speed);
        if (delta > 0) {
            this.accelWorld.copy(this.velocity).sub(prevVel).divideScalar(delta);
        } else {
            this.accelWorld.set(0, 0, 0);
        }

        this.landed = this.obj.position.y <= PLANE_DISTANCE_TO_GROUND;
        this.stall = -1;
    }

    /** Parasite (fuselage + gear) and transonic wave drag along the relative wind. */
    private addBodyDrag(dynamicPressure: number, speed: number, mach: number): void {
        if (speed < 1e-3) return;
        const waveDrag = this.config.waveDrag;
        let cd0 = this.config.bodyCd0
            + (this.landingGearDeployed ? this.config.gearCd : 0)
            + (this.airbrakesExtended ? (this.config.airbrakeCd ?? 0) : 0);
        if (mach > waveDrag.machOnset) {
            const excess = (mach - waveDrag.machOnset) / waveDrag.machOnset;
            cd0 += waveDrag.scale * excess * excess;
        }
        const dragN = dynamicPressure * this.config.geometry.wingAreaM2 * cd0;
        // Opposes body velocity (acts through CG, no moment).
        this._v.copy(this.velBody).multiplyScalar(-dragN / speed);
        this.forceBody.add(this._v);
    }

    /**
     * Upward unit normal of the solid heightfield at (x, z). Flat ground → +Y;
     * ramps/hills tilt so gear spring/friction act along the local surface.
     */
    private sampleGroundNormal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
        const e = GROUND_NORMAL_EPS_M;
        const hL = this.groundHeightAt(x - e, z);
        const hR = this.groundHeightAt(x + e, z);
        const hD = this.groundHeightAt(x, z - e);
        const hU = this.groundHeightAt(x, z + e);
        return out.set(-(hR - hL) / (2 * e), 1, -(hU - hD) / (2 * e)).normalize();
    }

    /** Spring-damper landing gear. Accumulates world force and body moment. */
    private computeGearForces(): void {
        this.gearForceWorld.set(0, 0, 0);
        this.gearMomentBody.set(0, 0, 0);
        for (let i = 0; i < this.gearCompression.length; i++) {
            this.gearCompression[i] = 0;
        }

        if (!this.landingGearDeployed) return;

        this._omegaWorld.copy(this.rb.angularVelocityBody).applyQuaternion(this.rb.orientation);

        const gear = this.config.gear;
        const maxStroke = this.maxGearStrokeM;
        for (let i = 0; i < gear.points.length; i++) {
            const gp = gear.points[i];
            this._v.set(gp[0], gp[1], gp[2]).applyQuaternion(this.rb.orientation);
            this._gearWorld.copy(this._v).add(this.obj.position);
            const groundY = this.groundHeightUnderGear(this._gearWorld.x, this._gearWorld.z);
            const penetration = groundY - this._gearWorld.y;
            if (penetration <= 0) continue;

            const compression = penetration < maxStroke ? penetration : maxStroke;
            this.gearCompression[i] = compression;

            this.sampleGroundNormal(this._gearWorld.x, this._gearWorld.z, this._groundNormal);

            // Velocity of the contact point through the world.
            this._contactVel.crossVectors(this._omegaWorld, this._v).add(this.rb.velocityWorld);
            const vIntoSurface = this._contactVel.dot(this._groundNormal);

            // Spring-damper along the local heightfield normal (not always +Y).
            let normalMag = gear.stiffness * penetration - gear.damping * vIntoSurface;
            if (normalMag < 0) normalMag = 0;

            this._friction.copy(this._groundNormal).multiplyScalar(normalMag);

            // Friction in the tangent plane, opposing sliding along the surface.
            this._vTan.copy(this._contactVel).addScaledVector(this._groundNormal, -vIntoSurface);
            const vh = this._vTan.length();
            if (vh > 1e-3) {
                const rolling = this.wheelBrakesApplied ? gear.brakeFriction : gear.rollFriction;
                const mu = Math.max(rolling, gear.sideFriction * this.sideSlipFraction(this._vTan.x, this._vTan.z));
                this._friction.addScaledVector(this._vTan, -(mu * normalMag) / vh);
            }

            this.gearForceWorld.add(this._friction);

            // Moment about CG: r_world × F_world, expressed in the body frame.
            this._v2.crossVectors(this._v, this._friction).applyQuaternion(this.invOrient);
            this.gearMomentBody.add(this._v2);
        }
    }

    /**
     * Lift the body so no gear contact tunnels deeper than the oleo stroke
     * below the local heightfield. Correction is vertical: the solid constraint
     * is y ≥ groundHeightAt(x,z) (hills, ramps, flat — anything WorldQuery returns).
     */
    private resolveGearTerrainPenetration(): void {
        if (!this.landingGearDeployed) return;

        const gear = this.config.gear;
        const maxStroke = this.maxGearStrokeM;
        let maxPen = 0;
        for (const gp of gear.points) {
            this._v.set(gp[0], gp[1], gp[2]).applyQuaternion(this.rb.orientation);
            this._gearWorld.copy(this._v).add(this.obj.position);
            const pen = this.groundHeightUnderGear(this._gearWorld.x, this._gearWorld.z) - this._gearWorld.y;
            if (pen > maxPen) maxPen = pen;
        }
        const excess = maxPen - maxStroke;
        if (excess <= 0) return;

        this.obj.position.y += excess;
        if (this.velocity.y < 0) {
            this.velocity.y = 0;
            this.rb.velocityWorld.y = 0;
        }
    }

    /** Stop residual ground creep once the aircraft has settled on the runway. */
    private clampParkedGroundSpeed(): void {
        if (!this.landed) return;
        const terrainY = this.groundHeightAt(this.obj.position.x, this.obj.position.z);
        if (this.obj.position.y > terrainY + this.groundRestY + 0.25) return;
        // Leave the rollout alone once the pilot advances the throttle.
        if (this.throttle > 0.01 || this.effectiveThrottle > 0.05) return;

        const vh = Math.hypot(this.velocity.x, this.velocity.z);
        if (vh > 0.25) return;

        this.velocity.x = 0;
        this.velocity.z = 0;
        this.rb.velocityWorld.x = 0;
        this.rb.velocityWorld.z = 0;
    }

    /** Higher effective friction for sideways (non-rolling) contact motion. */
    private sideSlipFraction(vhx: number, vhz: number): number {
        this._fwd.copy(FORWARD).applyQuaternion(this.rb.orientation);
        const fwx = this._fwd.x, fwz = this._fwd.z;
        const fwLen = Math.hypot(fwx, fwz) || 1;
        const vh = Math.hypot(vhx, vhz) || 1;
        const along = Math.abs((vhx * fwx + vhz * fwz) / (fwLen * vh));
        return clamp(1 - along, 0, 1);
    }

    /**
     * Body-frame AoA. At very low airspeed (tail-slide apex) the velocity vector
     * is unreliable, so fall back to pitch attitude for FBW / stall telemetry.
     */
    private computeBodyAoa(speed: number): number {
        if (speed > 1) {
            return Math.atan2(-this.velBody.y, this.velBody.z);
        }
        if (speed > 0.15) {
            return Math.atan2(-this.velBody.y, this.velBody.z);
        }
        this._fwd.set(0, 0, 1).applyQuaternion(this.rb.orientation);
        return Math.asin(clamp(this._fwd.y, -1, 1));
    }

    private updateStallState(speed: number, aoa: number, altitude: number): void {
        if (this.landed) { this.stall = -1; return; }
        const stallAoa = this.config.envelope.stallAoaRad;
        const minFlyingSpeed = this.config.envelope.minFlyingSpeedMps;
        const aoaStall = speed > 5 ? clamp((Math.abs(aoa) - stallAoa * 0.85) / (stallAoa * 0.3), 0, 1) : 0;
        const speedStall = altitude > PLANE_DISTANCE_TO_GROUND + 5
            ? clamp((minFlyingSpeed - speed) / minFlyingSpeed, 0, 1) : 0;
        const level = Math.max(aoaStall, speedStall);
        this.stall = level > 0 ? level : -1;
    }

    private handleGroundState(): void {
        const terrainY = this.groundHeightAt(this.obj.position.x, this.obj.position.z);
        const restY = terrainY + this.groundRestY;
        const onGround = this.obj.position.y <= restY + 0.25;

        if (this.obj.position.y > restY + 0.3) {
            this.landed = false;
        }

        // CG hard floor (gear contacts already clamped in resolveGearTerrainPenetration).
        if (this.landingGearDeployed) {
            const minY = restY - this.maxGearStrokeM;
            if (this.obj.position.y < minY) {
                this.obj.position.y = minY;
                if (this.velocity.y < 0) {
                    this.velocity.y = 0;
                    this.rb.velocityWorld.y = 0;
                }
            }
        }

        if (!onGround) return;

        this._fwd.copy(FORWARD).applyQuaternion(this.rb.orientation);
        this._right.copy(RIGHT).applyQuaternion(this.rb.orientation);
        const speed = this.velocity.length();
        const pitchAngle = Math.asin(clamp(this._fwd.y, -1, 1));
        const rollAngle = Math.asin(clamp(this._right.y, -1, 1));

        const env = this.config.envelope;
        // Sink-rate crashes only count once the oleo is bottomed (or gear is up).
        // Mid-stroke compression is normal spring travel, not a hard deck strike.
        let maxCompress = 0;
        for (let i = 0; i < this.gearCompression.length; i++) {
            if (this.gearCompression[i] > maxCompress) maxCompress = this.gearCompression[i];
        }
        const oleoBottomed = !this.landingGearDeployed
            || maxCompress >= this.maxGearStrokeM * 0.95;
        const hardContact = oleoBottomed
            && this.velocity.y < -env.landingMaxVerticalSpeedMps;
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

    getStallStatus(): number { return this.stall; }

    getGearCompression(): ReadonlyArray<number> {
        return this.gearCompression;
    }

    /**
     * Build a body-frame snapshot of the net force on each body part for the
     * debug overlay. Each of the six aerodynamic surfaces contributes its total
     * (lift + drag) force; the engine contributes thrust (body +Z) and the CG
     * carries weight (world gravity rotated into the body frame). The overlay
     * splits each force into X/Y/Z components. Kinematic (DEBUG) mode has no
     * aerodynamics, so nothing is produced.
     */
    getForceVectorSnapshot(): ForceVectorSample[] {
        if (this.kinematic) return [];

        const samples: ForceVectorSample[] = [];
        for (const s of this.allSurfaces) {
            const p = s.positionBody;
            // Lift and drag are reported as separate vectors at the surface, so the
            // overlay shows both components rather than just their resultant.
            const l = s.liftForceBody;
            const d = s.dragForceBody;
            samples.push({
                part: s.name, kind: 'lift',
                origin: [p.x, p.y, p.z], vec: [l.x, l.y, l.z],
            });
            samples.push({
                part: s.name, kind: 'drag',
                origin: [p.x, p.y, p.z], vec: [d.x, d.y, d.z],
            });
        }

        // Forebody vortex-asymmetry side force (nose slice), when live (subscale
        // regime). Drawn at the nose so the departure is visible; zero otherwise.
        const fb = this.forebodyForceBody;
        if (fb.lengthSq() > 0) {
            const armZ = this.config.forebodyAsymmetry?.armZ ?? 0;
            samples.push({
                part: 'forebody', kind: 'lift', origin: [0, 0, armZ],
                vec: [fb.x, fb.y, fb.z],
            });
        }

        // Thrust acts along the body +Z (nose) through the CG.
        samples.push({
            part: 'engine', kind: 'thrust', origin: [0, 0, 0],
            vec: [0, 0, this.engineThrustN],
        });

        // Weight: world-down force rotated into the current body frame.
        const weightWorldY = -this.config.geometry.massKg * GRAVITY;
        this._v.set(0, weightWorldY, 0);
        this.invOrient.copy(this.obj.quaternion).invert();
        this._v.applyQuaternion(this.invOrient);
        samples.push({
            part: 'cg', kind: 'weight', origin: [0, 0, 0],
            vec: [this._v.x, this._v.y, this._v.z],
        });

        return samples;
    }

    // --- Throttle quadrant behaviour. Afterburner aircraft use the F100-class
    // quadrant with MIL/AB detents; others use a plain linear 0–100% lever. ---
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

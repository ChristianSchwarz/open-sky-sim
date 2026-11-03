/**
 * A single rigid aerodynamic surface for the FM2 parts model.
 *
 * Given the aircraft's body-frame linear velocity, body angular velocity and
 * the local air density, the surface computes the lift + drag force it produces
 * and the moment that force exerts about the CG. The key detail that makes the
 * whole model behave is that the airflow seen by the surface includes the
 * velocity contributed by rotation at its own location:
 *
 *     u_local = v_body + ω × r
 *
 * A pitch rate therefore raises the AoA of the tail, a roll rate raises the AoA
 * of the down-going wing, and a yaw rate loads the fin — i.e. pitch, roll and
 * yaw aerodynamic damping all appear automatically from the geometry.
 */
import * as THREE from 'three';
import { clamp, wrapPi } from '../../utils/math';
import { SurfaceGeometry } from './fm2Constants';

export interface SurfaceInput {
    /** Body-frame velocity of the CG through the air (m/s). */
    velocityBody: THREE.Vector3;
    /** Body-frame angular velocity (rad/s). */
    angularVelocityBody: THREE.Vector3;
    /** Air density (kg/m³). */
    airDensity: number;
    /** Effective incidence added by control deflection (rad). */
    controlDeltaAoaRad: number;
    /** Symmetric camber bias, e.g. flaps (rad). */
    camberBiasRad: number;
    /** Reduction of the stall AoA, e.g. from flaps (rad). */
    stallShiftRad: number;
    /** Additional profile drag coefficient (referenced to this surface's area). */
    extraCd: number;
    /** Integration timestep (s) — drives the unsteady separation-state lag. */
    dt: number;
}

export class AeroSurface {
    readonly name: string;
    private readonly geom: SurfaceGeometry;

    /** Application point relative to the (fixed) CG — also the moment arm. */
    private readonly position = new THREE.Vector3();
    private readonly up = new THREE.Vector3();
    private readonly forward = new THREE.Vector3();
    private readonly span = new THREE.Vector3();

    private readonly _u = new THREE.Vector3();
    private readonly _rot = new THREE.Vector3();
    private readonly _dragDir = new THREE.Vector3();
    private readonly _liftDir = new THREE.Vector3();

    /** Last computed angle of attack for this surface (rad); useful telemetry. */
    lastAoaRad = 0;

    /**
     * Lagged effective AoA that the SEPARATED flow "sees" (rad). Ericsson's cobra
     * physics (ICAS-92-4.6R): dynamic pitching makes vortex formation / breakdown
     * lag the geometric AoA, so separation is delayed on rapid pitch-up (dynamic
     * lift overshoot) and reattachment is delayed on the way down (hysteresis).
     * This first-order state feeds the CL/CD separation blend and the vortex
     * window; the attached (potential-flow) term stays on the instantaneous AoA.
     * With `unsteadyTauS` unset/0 it tracks the geometric AoA exactly (quasi-steady).
     */
    private aoaSepLagged = 0;
    private sepLagInitialized = false;

    /** Last lift force this surface produced (body frame, N); for debug overlays. */
    readonly liftForceBody = new THREE.Vector3();
    /** Last drag force this surface produced (body frame, N); for debug overlays. */
    readonly dragForceBody = new THREE.Vector3();

    constructor(geom: SurfaceGeometry) {
        this.geom = geom;
        this.name = geom.name;
        this.position.fromArray(geom.position);
        this.up.fromArray(geom.up).normalize();
        this.forward.fromArray(geom.forward).normalize();
        // Spanwise axis (the direction we ignore when measuring AoA).
        this.span.copy(this.up).cross(this.forward).normalize();
    }

    get positionBody(): THREE.Vector3 {
        return this.position;
    }

    /** Clear transient (unsteady) aero state so a re-init snaps to the trim AoA. */
    resetState(): void {
        this.lastAoaRad = 0;
        this.aoaSepLagged = 0;
        this.sepLagInitialized = false;
    }

    /**
     * Accumulate this surface's aerodynamic force and moment.
     * @param input      Flight condition and control state.
     * @param outForce   Body-frame force accumulator (N) — added to.
     * @param outMoment  Body-frame moment-about-CG accumulator (N·m) — added to.
     */
    accumulate(input: SurfaceInput, outForce: THREE.Vector3, outMoment: THREE.Vector3): void {
        // Local velocity through the air at the surface: v + ω × r.
        this._rot.crossVectors(input.angularVelocityBody, this.position);
        // Once this surface's flow is separated, cut its rate-damping contribution
        // (a stalled tail damps far less). Uses last step's AoA as the separation
        // gauge so a transient high-AoA pitch overshoot can survive (cobra).
        const dampScale = this.geom.highAoaDampingScale ?? 1;
        if (dampScale < 1 && Math.abs(this.lastAoaRad) > this.geom.stallAoaRad) {
            this._rot.multiplyScalar(dampScale);
        }
        this._u.copy(input.velocityBody).add(this._rot);

        // Remove the spanwise component (that flow does not make lift here).
        const spanComp = this._u.dot(this.span);
        this._u.addScaledVector(this.span, -spanComp);

        const speedSq = this._u.lengthSq();
        if (speedSq < 1e-4) {
            this.lastAoaRad = 0;
            this.liftForceBody.set(0, 0, 0);
            this.dragForceBody.set(0, 0, 0);
            return;
        }
        const speed = Math.sqrt(speedSq);

        const uf = this._u.dot(this.forward);
        const uu = this._u.dot(this.up);
        const aoa = Math.atan2(-uu, uf);
        this.lastAoaRad = aoa;

        const effectiveAoa = aoa + input.controlDeltaAoaRad + input.camberBiasRad;

        // Advance the unsteady separation-state lag (Ericsson hysteresis). With no
        // `unsteadyTauS` (or a non-positive dt) it snaps to the geometric AoA, so
        // the surface is exactly quasi-steady. Otherwise the separated flow lags
        // with a first-order response, delaying stall on pitch-up and reattachment
        // on pitch-down.
        const tau = this.geom.unsteadyTauS ?? 0;
        if (!this.sepLagInitialized || tau <= 0 || input.dt <= 0) {
            this.aoaSepLagged = effectiveAoa;
            this.sepLagInitialized = true;
        } else {
            // The short way round: a tail slide flips atan2's AoA from +pi to
            // -pi, and lagging through 0 read as attached flow for a moment.
            this.aoaSepLagged = wrapPi(this.aoaSepLagged
                + wrapPi(effectiveAoa - this.aoaSepLagged) * (1 - Math.exp(-input.dt / tau)));
        }

        const stall = this.geom.stallAoaRad - input.stallShiftRad;
        const cl = liftCoefficient(
            effectiveAoa, this.geom.liftSlopePerRad, stall, this.geom.vortexLiftScale ?? 0,
            this.geom.zeroLiftAoaRad ?? 0, this.geom.clMax, this.aoaSepLagged,
        );
        const cd = dragCoefficient(
            effectiveAoa, cl, this.geom.cd0 + input.extraCd, this.geom.inducedK,
            stall, this.geom.flatPlateCd, this.aoaSepLagged,
        );

        // Drag acts downstream (direction the air is moving relative to surface).
        this._dragDir.copy(this._u).multiplyScalar(-1 / speed);
        // Lift is perpendicular to the relative wind, in the surface's lift plane.
        this._liftDir.crossVectors(this.span, this._dragDir).normalize();

        const q = 0.5 * input.airDensity * speedSq;
        const area = this.geom.areaM2;
        const lift = q * area * cl;
        const drag = q * area * cd;

        // Store the separated lift / drag contributions for debug overlays.
        this.liftForceBody.copy(this._liftDir).multiplyScalar(lift);
        this.dragForceBody.copy(this._dragDir).multiplyScalar(drag);

        // Force contribution.
        const fx = this._liftDir.x * lift + this._dragDir.x * drag;
        const fy = this._liftDir.y * lift + this._dragDir.y * drag;
        const fz = this._liftDir.z * lift + this._dragDir.z * drag;
        outForce.x += fx;
        outForce.y += fy;
        outForce.z += fz;

        // Moment about the (fixed) CG: r × F.
        const rx = this.position.x, ry = this.position.y, rz = this.position.z;
        outMoment.x += ry * fz - rz * fy;
        outMoment.y += rz * fx - rx * fz;
        outMoment.z += rx * fy - ry * fx;
    }
}

/** Fully-separated flat-plate lift amplitude: CL ≈ FLAT_PLATE_CL·sin(2α). A thin
 *  plate makes CL = sin(2α); ~1.1 accounts for real separated-flow suction. */
const FLAT_PLATE_CL = 1.1;
/** Logistic steepness (per rad) of the attached→separated LIFT blend across
 *  stall. Gentler than the drag knee so post-stall lift falls off smoothly. */
const LIFT_SEPARATION_STEEPNESS = 8;
/** Soft-clip knee exponent for the attached lift. Higher = stays linear longer
 *  before rounding over at ±CLmax (4 keeps cruise faithful, peak smooth). */
const CL_SOFTCLIP_EXPONENT = 4;

/**
 * Lift coefficient over the whole AoA range as a single smooth (C1-continuous)
 * curve — no piecewise plateaus or jumps. Shaped like a real airfoil (see
 * aerospaceweb.org "Lift & drag coefficients for the whole range of AoA"):
 * a linear region that rounds over at CLmax near stall, a gentle post-stall
 * decline, and an antisymmetric flat-plate sinusoid through ±90° / ±180°.
 *
 * Construction:
 *   - Attached lift: `linear = slope·(α − α0)` (α0 = zero-lift/camber angle, so a
 *     cambered surface makes lift at α=0), softly saturated toward ±CLmax with a
 *     p-norm knee — essentially linear through cruise, rounding over smoothly at
 *     the peak instead of hitting a corner.
 *   - Separated (flat-plate) lift: `FLAT_PLATE_CL·sin(2α)`.
 *   - The two are blended with a logistic window `sep` centred on stall, so the
 *     curve peaks near stall and smoothly hands over to the flat-plate behaviour.
 *
 * Profile inputs:
 *   - `alpha0` (rad): camber / zero-lift angle.
 *   - `clMaxOverride`: the attached-lift saturation asymptote (the surface's peak
 *     CL). Omitted ⇒ slope·stall. The achieved peak is slightly below this since
 *     the post-stall blend rounds it over — as on a real lift curve.
 *   - `aoaSepRad`: the (optionally lagged) AoA the SEPARATED flow sees. The
 *     attached term and the flat-plate lift magnitude use the instantaneous
 *     `aoaRad`; only the attached→separated blend and the vortex window key off
 *     `aoaSepRad`. Passing the lagged value gives Ericsson's cobra hysteresis
 *     (delayed stall / reattachment). Defaults to `aoaRad` (quasi-steady).
 */
export function liftCoefficient(
    aoaRad: number, slopePerRad: number, stallRad: number, vortexScale = 0,
    alpha0 = 0, clMaxOverride?: number, aoaSepRad = aoaRad,
): number {
    const sign = Math.sign(aoaRad) || 1;
    const clMax = clMaxOverride ?? (slopePerRad * stallRad);

    // Attached (pre-stall) lift: linear in (α − α0), softly saturated toward
    // ±CLmax with a p-norm knee so it is ~linear through cruise and rounds over
    // smoothly at the peak (no corner). Asymptotes to ±CLmax as |α| grows.
    const linear = slopePerRad * (aoaRad - alpha0);
    const norm = Math.abs(linear) / clMax;
    const attached = linear / Math.pow(1 + Math.pow(norm, CL_SOFTCLIP_EXPONENT), 1 / CL_SOFTCLIP_EXPONENT);

    // Fully-separated flat-plate lift (odd in α, so lift reverses past ±90°).
    const flat = FLAT_PLATE_CL * Math.sin(2 * aoaRad);

    // Smoothly blend attached → separated across stall using the (lagged)
    // separation-state AoA, so the hand-over itself carries the hysteresis.
    const magSep = Math.abs(aoaSepRad);
    const sep = 1 / (1 + Math.exp(-LIFT_SEPARATION_STEEPNESS * (magSep - stallRad)));
    let cl = (1 - sep) * attached + sep * flat;

    // Optional vortex / strake lift (forebody LERX): a smooth raised-cosine bump
    // spanning stall → ~90°, peaking ~50°, so it adds post-stall CL without any
    // kink (window value AND slope are 0 at both edges and at the peak). Keyed on
    // the lagged AoA so vortex breakdown lags the motion too.
    if (vortexScale > 0) {
        const vortexPeak = 50 * (Math.PI / 180);
        const vortexEnd = 90 * (Math.PI / 180);
        if (magSep > stallRad && magSep < vortexEnd) {
            const half = magSep <= vortexPeak
                ? (magSep - stallRad) / (vortexPeak - stallRad)
                : (vortexEnd - magSep) / (vortexEnd - vortexPeak);
            const window = 0.5 * (1 - Math.cos(Math.PI * clamp(half, 0, 1)));
            cl += sign * window * clMax * vortexScale;
        }
    }
    return cl;
}

/** Logistic steepness of the attached→separated drag transition (per rad). A
 *  higher value narrows the blend band around stall; ~15 gives a ~±4° window.
 *  (Walter Bislin's whole-range model uses q = 25.) */
const DRAG_SEPARATION_STEEPNESS = 15;
const DEFAULT_FLAT_PLATE_CD = 2.0;

/**
 * Drag coefficient over the whole AoA range, after Walter Bislin's model
 * (walter.bislins.ch — "Airplane Lift and Drag Coefficients for the whole Range
 * of AoA"). Two regimes are blended with a logistic window centred on stall:
 *
 *   - Attached flow: the classic parabolic drag polar
 *         CD = CD0 + K·CL²                         (Bislin CD = cd1 + cd2·CL²)
 *     where CD0 is the surface's profile/parasite drag (plus any flap/gear
 *     increment folded in) and K·CL² is induced drag.
 *   - Fully separated flow: a flat-plate / bluff-body term
 *         CDP = flatPlateCd · ½·(1 − cos 2α)       (Bislin CDP = 1 − cos 2α)
 *     which is ~0 at α = 0, peaks at α = 90°, and eases back to ~0 by 180° so a
 *     tail slide / tumble bleeds energy without locking the nose at 90°.
 *
 * `sep` ramps 0→1 through ±stall, so below stall the realistic low-drag polar
 * dominates (preserving cruise L/D) and past stall the high separated drag takes
 * over. Symmetric in α (camber is handled entirely in the lift curve).
 *
 * `aoaSepRad` is the (optionally lagged) separation-state AoA that gates the
 * blend; the flat-plate magnitude uses the instantaneous `aoaRad`. Defaults to
 * `aoaRad` (quasi-steady).
 */
export function dragCoefficient(
    aoaRad: number, cl: number, parasiticCd: number, inducedK: number,
    stallRad: number, flatPlateCd = DEFAULT_FLAT_PLATE_CD, aoaSepRad = aoaRad,
): number {
    const attached = parasiticCd + inducedK * cl * cl;
    const flatPlate = flatPlateCd * 0.5 * (1 - Math.cos(2 * aoaRad));
    const sep = 1 / (1 + Math.exp(-DRAG_SEPARATION_STEEPNESS * (Math.abs(aoaSepRad) - stallRad)));
    return (1 - sep) * attached + sep * flatPlate;
}

import * as THREE from 'three';
import { UP } from '../../utils/math';
import { Fm2AircraftConfig } from '../fm2/fm2AircraftConfig';
import { FcsPitchLimiter } from '../fm2/fcs';

const SIM_FPS = 120;
const SIM_DELTA = 1.0 / SIM_FPS;

const EMPTY_GEAR_COMPRESSION: ReadonlyArray<number> = Object.freeze([]);

/**
 * The net force acting on a single body part, serialised for the debug overlay.
 * Origin and vector are both expressed in the aircraft body frame (metres and
 * newtons respectively). The overlay decomposes `vec` into its X/Y/Z body-axis
 * components and draws one arrow per axis, rather than a single resultant arrow.
 */
/** Which kind of force a sample represents (drives the overlay colour). */
export type ForceVectorKind = 'lift' | 'drag' | 'thrust' | 'weight';

export interface ForceVectorSample {
    part: string;
    /** What the vector represents; defaults to 'lift' when omitted. */
    kind?: ForceVectorKind;
    origin: [number, number, number];
    vec: [number, number, number];
}

export abstract class FlightModel {

    protected obj = new THREE.Object3D();
    protected velocity: THREE.Vector3 = new THREE.Vector3(); // m/s

    protected crashed: boolean = false;
    protected landed: boolean = true;
    protected landingGearDeployed: boolean = true;
    protected flapsExtended: boolean = true;
    protected airbrakesExtended: boolean = false;
    protected wheelBrakesApplied: boolean = false;
    /**
     * Reynolds-number regime for high-alpha forebody flow (Ericsson, ICAS-92-4.6R).
     * false = full-scale flight: transition/motion coupling keeps forebody
     * separation symmetric, so no nose slice (the real-aircraft default).
     * true  = subscale / laminar: the forebody vortex asymmetry is live, so a
     * high-alpha maneuver (cobra) departs into a nose slice — the wind-tunnel
     * behaviour the paper warns does NOT represent full-scale flight.
     */
    protected forebodyLaminar: boolean = false;

    /** Active pitch AoA/g limiter strategy (keys 1/2/3). FM2 only. */
    protected pitchLimiterMode: FcsPitchLimiter = FcsPitchLimiter.SOFT;

    /** FBW AoA/g limiters. True = normal envelope protection; false = pilot override. */
    protected limitersEnabled: boolean = true;
    /**
     * Current elevator-command clamp bounds in [-1, 1] (positive = nose-up / aft
     * stick). With limiters ON these reflect the combined AoA/g caps; with
     * limiters OFF they are ±1. Used by the HUD stick box.
     */
    protected elevatorCommandLimitHigh: number = 1;
    protected elevatorCommandLimitLow: number = -1;

    protected pitch: number = 0; // [-1, 1]
    protected roll: number = 0; // [-1, 1]
    protected yaw: number = 0; // [-1, 1]
    protected throttle: number = 0; // [0, 1]
    protected effectiveThrottle: number = 0; // [0, 1]

    protected angleOfAttackRad: number = 0;
    protected loadFactorG: number = 1;
    protected engineThrustN: number = 0;
    /**
     * Latest FCS-commanded, post-actuator-lag surface deflections in [-1, 1],
     * expressed in the SAME polarity as the raw pilot stick they animate from
     * (positive elevator = nose-up / aft stick, positive aileron = right roll
     * stick, positive rudder = right pedal). These drive the VISIBLE control
     * surfaces so the fly-by-wire shaping (roll/yaw laws) is
     * visible on the model. They default to 0 until the first physics state.
     */
    protected commandedElevator: number = 0;
    protected commandedAileron: number = 0;
    protected commandedRudder: number = 0;
    /** World-frame linear acceleration from the last physics step (m/s²). */
    protected readonly accelWorld = new THREE.Vector3();

    /**
     * Latest per-part force vectors (body frame) for the debug overlay. Only
     * populated while {@link setForceVectorsRequested} is enabled, otherwise
     * left empty to avoid the per-step allocation / transfer cost.
     */
    protected forceVectors: ForceVectorSample[] = [];
    /** Whether the debug force-vector snapshot should be produced each step. */
    protected forceVectorsRequested: boolean = false;

    /**
     * Scene position -> height above the ellipsoid, for the atmosphere.
     *
     * The scene is a tangent plane at the play area's origin and the terrain is
     * drawn curving away from it, so a position's Y is not its altitude except
     * near that origin: at the edge of a three-degree area sea level sits some
     * 1.8 km below Y = 0. Feeding raw Y to the ISA model therefore flies the
     * aircraft through air that is far too dense out there.
     *
     * Identity until something wires the terrain in, which is also the right
     * answer for a flat world — see `HeightSampler.geodeticAltitudeAtEnu`.
     */
    private altitudeAt: (x: number, y: number, z: number) => number = (_x, y) => y;

    private prevPosition = new THREE.Vector3();
    private prevQuaternion = new THREE.Quaternion();
    private prevVelocity = new THREE.Vector3();
    private deltaRemainder: number = 0;

    abstract step(delta: number): void;

    /**
     * Called when this model becomes the active model for its entity (on
     * construction of the entity and on every runtime model swap). Lets a
     * shared-worker proxy claim ownership of its slot. No-op by default.
     */
    activate(): void {
        // No-op by default.
    }

    // --- Combat-sim mirror -------------------------------------------------
    // Populated only by the shared combat-sim proxy (see SimProxyFlightModel);
    // the defaults below mean "not simulated in the combat worker".

    /** Health in [0, maxHealth], or -1 when this model is not sim-owned. */
    getSimHealth(): number { return -1; }

    /** Remaining gun rounds, or -1 when this model is not sim-owned. */
    getSimAmmo(): number { return -1; }

    /** Whether the in-worker pilot/trigger produced a firing solution this frame. */
    getSimFiring(): boolean { return false; }

    /** Sim-owned gear state, or null when this model is not sim-owned. */
    getSimGearDeployed(): boolean | null { return null; }

    /** Sim-owned flaps state, or null when this model is not sim-owned. */
    getSimFlapsExtended(): boolean | null { return null; }

    /** Sim-owned airbrake state, or null when this model is not sim-owned. */
    getSimAirbrakesExtended(): boolean | null { return null; }

    /** Sim-owned tailhook state, or null when this model is not sim-owned. */
    getSimHookDeployed(): boolean | null { return null; }

    reset() {
        this.obj.position.set(0, 0, 0);
        this.obj.quaternion.setFromAxisAngle(UP, 0);
        this.velocity.set(0, 0, 0);
        this.crashed = false;
        this.landed = true;
        this.landingGearDeployed = true;
        this.flapsExtended = true;
        this.airbrakesExtended = false;
        this.wheelBrakesApplied = false;
        this.forebodyLaminar = false;
        this.pitchLimiterMode = FcsPitchLimiter.SOFT;
        this.limitersEnabled = true;
        this.elevatorCommandLimitHigh = 1;
        this.elevatorCommandLimitLow = -1;
        this.pitch = 0;
        this.roll = 0;
        this.yaw = 0;
        this.throttle = 0;
        this.effectiveThrottle = 0;
        this.angleOfAttackRad = 0;
        this.loadFactorG = 1;
        this.engineThrustN = 0;
        this.commandedElevator = 0;
        this.commandedAileron = 0;
        this.commandedRudder = 0;
        this.accelWorld.set(0, 0, 0);
        this.deltaRemainder = 0;
        this.syncPreviousState();
    }

    /** Align render interpolation after teleport or airborne spawn. */
    snapPhysicsState(): void {
        this.syncPreviousState();
    }

    update(delta: number): void {
        this.deltaRemainder += delta;
        while (this.deltaRemainder >= SIM_DELTA) {
            this.savePreviousState();
            this.step(SIM_DELTA);
            this.deltaRemainder -= SIM_DELTA;
        }
    }

    /** 1 = latest physics state, 0 = previous physics state. */
    getRenderInterpolationAlpha(): number {
        return 1 - this.deltaRemainder / SIM_DELTA;
    }

    getRenderPosition(target: THREE.Vector3): THREE.Vector3 {
        return target.lerpVectors(this.prevPosition, this.obj.position, this.getRenderInterpolationAlpha());
    }

    getRenderQuaternion(target: THREE.Quaternion): THREE.Quaternion {
        return target.slerpQuaternions(this.prevQuaternion, this.obj.quaternion, this.getRenderInterpolationAlpha());
    }

    getRenderVelocity(target: THREE.Vector3): THREE.Vector3 {
        return target.lerpVectors(this.prevVelocity, this.velocity, this.getRenderInterpolationAlpha());
    }

    private savePreviousState(): void {
        this.prevPosition.copy(this.obj.position);
        this.prevQuaternion.copy(this.obj.quaternion);
        this.prevVelocity.copy(this.velocity);
    }

    private syncPreviousState(): void {
        this.prevPosition.copy(this.obj.position);
        this.prevQuaternion.copy(this.obj.quaternion);
        this.prevVelocity.copy(this.velocity);
    }

    setPitch(pitch: number) {
        this.pitch = pitch;
    }

    setRoll(roll: number) {
        this.roll = roll;
    }

    setYaw(yaw: number) {
        this.yaw = yaw;
    }

    setThrottle(throttle: number) {
        this.throttle = throttle;
    }

    /** Match spooled engine state to commanded throttle (e.g. airborne spawn). */
    syncEffectiveThrottle() {
        this.effectiveThrottle = this.throttle;
    }

    /**
     * Select the aircraft this model should simulate. Only the FM2 model is
     * per-aircraft for now; every other model ignores this (generic dynamics).
     */
    setAircraft(_config: Fm2AircraftConfig): void {
        // No-op by default.
    }

    /** Wire scene Y -> true altitude. See {@link atmosphereAltitudeM}. */
    setAltitudeAt(fn: (x: number, y: number, z: number) => number): void {
        this.altitudeAt = fn;
    }

    /** Height above the ellipsoid of this aircraft — what the atmosphere sees. */
    protected get atmosphereAltitudeM(): number {
        const p = this.obj.position;
        return this.altitudeAt(p.x, p.y, p.z);
    }

    setLandingGearDeployed(deployed: boolean) {
        this.landingGearDeployed = deployed;
    }

    setFlapsExtended(extended: boolean) {
        this.flapsExtended = extended;
    }

    setAirbrakesExtended(extended: boolean) {
        this.airbrakesExtended = extended;
    }

    setWheelBrakes(applied: boolean) {
        this.wheelBrakesApplied = applied;
    }

    isWheelBrakesApplied(): boolean {
        return this.wheelBrakesApplied;
    }

    /**
     * Select the high-alpha forebody Reynolds regime (Ericsson, ICAS-92-4.6R).
     * false (default) = full-scale flight, laterally symmetric (no nose slice);
     * true = subscale / laminar, where the forebody vortex asymmetry departs a
     * cobra into a nose slice. Only the FM2 model acts on this.
     */
    setForebodyLaminar(laminar: boolean) {
        this.forebodyLaminar = laminar;
    }

    isForebodyLaminar(): boolean {
        return this.forebodyLaminar;
    }

    /** Select the pitch AoA/g limiter strategy (keys 1/2/3). Only FM2 acts on it. */
    setPitchLimiterMode(mode: FcsPitchLimiter) {
        this.pitchLimiterMode = mode;
    }

    getPitchLimiterMode(): FcsPitchLimiter {
        return this.pitchLimiterMode;
    }

    getPilotPitch(): number { return this.pitch; }
    getPilotRoll(): number { return this.roll; }
    getPilotYaw(): number { return this.yaw; }
    getPilotThrottle(): number { return this.throttle; }
    getWheelBrakesApplied(): boolean { return this.wheelBrakesApplied; }

    /** Enable/disable the FBW AoA/g limiters (false = pilot limiter override). */
    setLimitersEnabled(enabled: boolean) {
        this.limitersEnabled = enabled;
    }

    isLimitersEnabled(): boolean {
        return this.limitersEnabled;
    }

    getElevatorCommandLimitHigh(): number {
        return this.elevatorCommandLimitHigh;
    }

    getElevatorCommandLimitLow(): number {
        return this.elevatorCommandLimitLow;
    }

    setLanded(isLanded: boolean) {
        this.landed = isLanded;
    }

    isLanded(): boolean {
        return this.landed;
    }

    setCrashed(isCrashed: boolean) {
        this.crashed = isCrashed;
    }

    isCrashed(): boolean {
        return this.crashed;
    }

    set position(p: THREE.Vector3) {
        this.obj.position.copy(p);
    }

    get position() {
        return this.obj.position;
    }

    set quaternion(q: THREE.Quaternion) {
        this.obj.quaternion.copy(q);
    }

    get quaternion() {
        return this.obj.quaternion;
    }

    set velocityVector(v: THREE.Vector3) {
        this.velocity.copy(v);
    }

    get velocityVector() {
        return this.velocity;
    }

    getEffectiveThrottle(): number {
        return this.effectiveThrottle;
    }

    // [-1,1] - Values >= 0 mean stall
    abstract getStallStatus(): number;

    getAngleOfAttack(): number {
        return this.angleOfAttackRad;
    }

    getLoadFactorG(): number {
        return this.loadFactorG;
    }

    /**
     * FCS-commanded visible surface deflections in [-1, 1], in raw-stick polarity
     * (see {@link commandedElevator}). Used to animate the control surfaces so the
     * fly-by-wire shaping is visible on the model.
     */
    getCommandedElevator(): number {
        return this.commandedElevator;
    }

    getCommandedAileron(): number {
        return this.commandedAileron;
    }

    getCommandedRudder(): number {
        return this.commandedRudder;
    }

    getAccelerationWorld(target: THREE.Vector3 = this.accelWorld): THREE.Vector3 {
        return target.copy(this.accelWorld);
    }

    /**
     * Apply an external wrench to the airframe: a linear impulse (N·s, world)
     * through the centre of gravity and an angular impulse (N·m·s, world).
     *
     * For loads the flight model has no way of knowing about — something has
     * hold of the aircraft rather than air flowing over it. The two halves are
     * given separately rather than as a force at a point, because a grab is not
     * generally reducible to one: webbing pulling on both wings at once is a
     * couple, and the single point that would reproduce it does not exist.
     *
     * Models that carry no rigid body ignore it.
     */
    applyExternalWrench(_impulseWorld: THREE.Vector3, _angularImpulseWorld: THREE.Vector3): void {
        //
    }

    getEngineThrustKn(): number {
        return this.engineThrustN / 1000;
    }

    /**
     * Per-leg oleo compression (m), one entry per gear contact point.
     * Zero when gear is up or a leg is unloaded. FM2 fills this; other models
     * return an empty array.
     */
    getGearCompression(): ReadonlyArray<number> {
        return EMPTY_GEAR_COMPRESSION;
    }

    /** Mean oleo compression across contact points (m). */
    getGearCompressionMean(): number {
        const c = this.getGearCompression();
        if (c.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < c.length; i++) sum += c[i];
        return sum / c.length;
    }

    /** Enable/disable production of the debug force-vector snapshot each step. */
    setForceVectorsRequested(requested: boolean): void {
        this.forceVectorsRequested = requested;
        if (!requested) {
            this.forceVectors = [];
        }
    }

    /** Latest per-part force vectors (body frame) for the debug overlay. */
    getForceVectors(): ForceVectorSample[] {
        return this.forceVectors;
    }

    /**
     * Build a fresh, serialisable snapshot of the current per-part force vectors.
     * Base models have no aerodynamic decomposition, so this returns empty.
     */
    getForceVectorSnapshot(): ForceVectorSample[] {
        return [];
    }

    useAfterburnerThrottleDetents(): boolean {
        return false;
    }

    stepThrottleDetent(current: number, direction: 1 | -1): number {
        return Math.max(0, Math.min(1, current + direction * 0.01));
    }

    isInThrottleAbDetentBand(_lever: number): boolean {
        return false;
    }

    /** Override in models with a non-linear throttle quadrant. */
    adjustThrottleInput(current: number, step: number): number {
        return Math.max(0, Math.min(1, current + step));
    }

    /** Override in models with a non-linear throttle quadrant. */
    getThrottleHudText(): string {
        return `THR ${(100 * this.effectiveThrottle).toFixed(0)}`;
    }

    /** Normalized engine power for audio [0, 1]. */
    getThrottleAudioLevel(): number {
        return this.effectiveThrottle;
    }

    /** CSS color for engine nozzle rendering (MIL black by default). */
    getEngineNozzleColor(): string {
        return '#0a0a0a';
    }
}

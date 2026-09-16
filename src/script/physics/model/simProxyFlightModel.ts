import * as THREE from 'three';
import { FlightModel } from './flightModel';
import { Fm2AircraftConfig } from '../fm2/fm2AircraftConfig';
import {
    formatF16ThrottleHud, stepF16ThrottleDetent, isF16AbDetentBand,
    adjustF16ThrottleInput, getF16ThrottleZone, f16ThrottleAudioLevel, getF16EngineNozzleColor,
} from '../f16Engine';
import { FcsPitchLimiter } from '../fm2/fcs';
import { CombatSimClient, SimAircraftProxy } from '../sim/combatSimClient';
import { SimControlInputs, SimFlightModelKind } from '../sim/simTypes';
import { AC } from '../sim/simSnapshotCodec';
import { ForceVectorSample } from './flightModel';

/**
 * Render-side proxy for one aircraft simulated inside the shared combat sim
 * worker. Mirrors the {@link WorkerFlightModel} contract, but instead of owning
 * its own worker it shares a single {@link CombatSimClient}: it forwards
 * teleport/reset/config events, exposes its command buffer for the client to
 * pump, and applies authoritative state from each snapshot.
 */
export class SimProxyFlightModel extends FlightModel implements SimAircraftProxy {

    private lastStall = -1;
    private fm2Afterburner = true;
    private simGearDeployed = true;
    private simFlapsExtended = true;
    /** False until the first worker snapshot — defaults must not override spawn pose. */
    private simStateReady = false;
    private simAirbrakesExtended = false;
    private simHookDeployed = false;
    private simFiring = false;
    private simHealth = 100;
    private simAmmo = 0;
    private simAutopilot = false;
    private simPitchStickUnits = 0;
    private simWheelBrakes = false;
    private simLimitersEnabled = true;
    private simPitchLimiterMode = 0;
    private simArrestorLatch = -1;
    private readonly simArrestorHook = new THREE.Vector3();

    constructor(
        private readonly client: CombatSimClient,
        readonly simId: string,
        /** The physics the combat sim runs for this aircraft. */
        readonly modelKind: SimFlightModelKind,
    ) {
        super();
        this.client.registerProxy(this);
    }

    activate(): void {
        this.client.registerProxy(this);
    }

    // --- SimAircraftProxy -----------------------------------------------------

    collectInputs(): SimControlInputs {
        // Worker-owned player input overwrites these during step(); keep neutral.
        return {
            pitch: 0,
            roll: 0,
            yaw: 0,
            throttle: 0,
            landingGearDeployed: this.landingGearDeployed,
            flapsExtended: this.flapsExtended,
            airbrakesExtended: this.airbrakesExtended,
            hookDeployed: this.simHookDeployed,
            wheelBrakesApplied: false,
            pitchLimiterMode: this.pitchLimiterMode,
            limitersEnabled: this.limitersEnabled,
            wantForceVectors: this.forceVectorsRequested,
            firing: false,
        };
    }

    applyStateBuffer(buf: Float32Array, base: number, forceVectors: ForceVectorSample[]): void {
        this.obj.position.set(buf[base + AC.posX], buf[base + AC.posY], buf[base + AC.posZ]);
        this.obj.quaternion.set(buf[base + AC.qx], buf[base + AC.qy], buf[base + AC.qz], buf[base + AC.qw]);
        this.velocity.set(buf[base + AC.velX], buf[base + AC.velY], buf[base + AC.velZ]);

        this.crashed = buf[base + AC.crashed] !== 0;
        this.landed = buf[base + AC.landed] !== 0;
        this.angleOfAttackRad = buf[base + AC.aoa];
        this.loadFactorG = buf[base + AC.loadG];
        this.commandedElevator = buf[base + AC.cmdElevator];
        this.commandedAileron = buf[base + AC.cmdAileron];
        this.commandedRudder = buf[base + AC.cmdRudder];
        this.engineThrustN = buf[base + AC.engineThrustN];
        this.effectiveThrottle = buf[base + AC.effectiveThrottle];
        this.accelWorld.set(buf[base + AC.accX], buf[base + AC.accY], buf[base + AC.accZ]);
        this.forceVectors = forceVectors;

        this.lastStall = buf[base + AC.stall];
        this.simGearDeployed = buf[base + AC.gearDeployed] !== 0;
        this.simFlapsExtended = buf[base + AC.flapsExtended] !== 0;
        this.simAirbrakesExtended = buf[base + AC.airbrakesExtended] !== 0;
        this.simHookDeployed = buf[base + AC.hookDeployed] !== 0;
        this.simStateReady = true;
        this.simFiring = buf[base + AC.firing] !== 0;
        this.simHealth = buf[base + AC.health];
        this.simAmmo = buf[base + AC.ammo];

        this.pitch = buf[base + AC.inPitch];
        this.roll = buf[base + AC.inRoll];
        this.yaw = buf[base + AC.inYaw];
        this.throttle = buf[base + AC.inThrottle];
        this.simPitchStickUnits = buf[base + AC.pitchStickUnits];
        this.simWheelBrakes = buf[base + AC.wheelBrakes] !== 0;
        this.simLimitersEnabled = buf[base + AC.limitersEnabled] !== 0;
        this.simPitchLimiterMode = buf[base + AC.pitchLimiterMode];
        this.simAutopilot = buf[base + AC.autopilot] !== 0;
        this.wheelBrakesApplied = this.simWheelBrakes;
        this.pitchLimiterMode = this.simPitchLimiterMode as FcsPitchLimiter;
        this.limitersEnabled = this.simLimitersEnabled;
        this.simArrestorLatch = buf[base + AC.arrestorLatch] ?? -1;
        this.simArrestorHook.set(
            buf[base + AC.hookX] ?? 0,
            buf[base + AC.hookY] ?? 0,
            buf[base + AC.hookZ] ?? 0,
        );

        // @ts-ignore - private on the base, written for render interpolation.
        this.prevPosition.set(buf[base + AC.ppX], buf[base + AC.ppY], buf[base + AC.ppZ]);
        // @ts-ignore
        this.prevQuaternion.set(buf[base + AC.pqx], buf[base + AC.pqy], buf[base + AC.pqz], buf[base + AC.pqw]);
        // @ts-ignore
        this.prevVelocity.set(buf[base + AC.pvX], buf[base + AC.pvY], buf[base + AC.pvZ]);
        // @ts-ignore
        this.deltaRemainder = buf[base + AC.deltaRemainder];
    }

    getSimFiring(): boolean {
        return this.simFiring;
    }

    getSimHealth(): number {
        return this.simHealth;
    }

    getSimAmmo(): number {
        return this.simAmmo;
    }

    /** Raw pilot controls mirrored by the target branch's input snapshot fields. */
    getSimStickPitch(): number {
        return this.pitch;
    }

    getSimStickRoll(): number {
        return this.roll;
    }

    getSimThrottleLever(): number {
        return this.throttle;
    }

    getSimGearDeployed(): boolean | null {
        return this.simStateReady ? this.simGearDeployed : null;
    }

    getSimFlapsExtended(): boolean | null {
        return this.simStateReady ? this.simFlapsExtended : null;
    }

    getSimAirbrakesExtended(): boolean | null {
        return this.simStateReady ? this.simAirbrakesExtended : null;
    }

    getSimHookDeployed(): boolean | null {
        return this.simStateReady ? this.simHookDeployed : null;
    }

    /** Clear mirrored gear/flaps until the next worker snapshot (e.g. after respawn). */
    invalidateSimDeviceState(): void {
        this.simStateReady = false;
    }

    getSimAutopilot(): boolean {
        return this.simAutopilot;
    }

    getSimPitchStickUnits(): number {
        return this.simPitchStickUnits;
    }

    getSimWheelBrakes(): boolean {
        return this.simWheelBrakes;
    }

    /** Latched arrestor cable index, or -1 when free. */
    getArrestorLatch(): number {
        return this.simArrestorLatch;
    }

    /** World-space hook position from the latest worker snapshot. */
    getArrestorHookWorld(out: THREE.Vector3): THREE.Vector3 {
        return out.copy(this.simArrestorHook);
    }

    // --- FlightModel overrides ------------------------------------------------

    update(_delta: number): void {
        // No-op: the client pumps the shared worker once per frame.
    }

    step(_delta: number): void {
        // No-op on the main thread; simulation happens in the worker.
    }

    getStallStatus(): number {
        return this.lastStall;
    }

    reset(): void {
        super.reset();
        this.client.resetAircraft(
            this.simId, this.obj.position, this.obj.quaternion, this.velocity,
            this.landed, this.throttle, this.modelKind);
    }

    syncEffectiveThrottle(): void {
        super.syncEffectiveThrottle();
        this.client.syncEffectiveThrottle(this.simId, this.throttle);
    }

    snapPhysicsState(): void {
        super.snapPhysicsState();
        this.client.snapPhysicsState(this.simId);
    }

    set position(p: THREE.Vector3) {
        super.position = p;
        this.client.setPosition(this.simId, p);
    }

    get position(): THREE.Vector3 {
        return super.position;
    }

    set quaternion(q: THREE.Quaternion) {
        super.quaternion = q;
        this.client.setQuaternion(this.simId, q);
    }

    get quaternion(): THREE.Quaternion {
        return super.quaternion;
    }

    set velocityVector(v: THREE.Vector3) {
        super.velocityVector = v;
        this.client.setVelocity(this.simId, v);
    }

    get velocityVector(): THREE.Vector3 {
        return super.velocityVector;
    }

    setAircraft(config: Fm2AircraftConfig): void {
        this.fm2Afterburner = config.engine.afterburner;
        this.client.setAircraftConfig(this.simId, config, this.modelKind);
    }

    private isAfterburner(): boolean {
        return this.fm2Afterburner;
    }

    // Afterburner-quadrant overrides (MIL/AB detents, cone glow, audio ramp).
    getThrottleHudText(): string {
        if (!this.isAfterburner()) return super.getThrottleHudText();
        return formatF16ThrottleHud(this.throttle);
    }

    useAfterburnerThrottleDetents(): boolean {
        return this.isAfterburner();
    }

    stepThrottleDetent(current: number, direction: 1 | -1): number {
        if (!this.isAfterburner()) return super.stepThrottleDetent(current, direction);
        return stepF16ThrottleDetent(current, direction);
    }

    isInThrottleAbDetentBand(lever: number): boolean {
        if (!this.isAfterburner()) return super.isInThrottleAbDetentBand(lever);
        return isF16AbDetentBand(lever);
    }

    adjustThrottleInput(current: number, step: number): number {
        if (!this.isAfterburner()) return super.adjustThrottleInput(current, step);
        return adjustF16ThrottleInput(current, step);
    }

    getThrottleZone(): string {
        if (!this.isAfterburner()) return 'mil';
        return getF16ThrottleZone(this.effectiveThrottle);
    }

    getThrottleAudioLevel(): number {
        if (!this.isAfterburner()) return super.getThrottleAudioLevel();
        return f16ThrottleAudioLevel(this.effectiveThrottle);
    }

    getEngineNozzleColor(): string {
        if (!this.isAfterburner()) return super.getEngineNozzleColor();
        return getF16EngineNozzleColor(this.effectiveThrottle);
    }
}

import * as THREE from 'three';
import { Fm2AircraftConfig } from '../fm2/fm2AircraftConfig';
import { Faction } from '../../weapons/combatant';
import { ForceVectorSample } from '../model/flightModel';
import { KeyboardControlLayoutId } from '../../input/keyboardLayouts';
import { SerializedArrestorCables, SerializedWorld } from './serializedWorld';
import { HeightTileUpdate, SerializedHeightField } from '../../terrain/heightMirror';
import { AC_STRIDE, SnapshotBuffers } from './simSnapshotCodec';
import {
    createSimSharedState,
    isSharedBusy,
    setSharedBusy,
    SimSharedViews,
    tryPullSharedSnapshot,
} from './simSharedState';
import { AiPilotOptions } from '../../ai/aiPilot';
import {
    SimAircraftDesc, SimAircraftSpawn, SimControlInputs,
    SimControlMode, SimFlightModelKind, SimHitEvent, SimToWorkerMessage, WorkerToSimMessage,
    AircraftCollisionMesh,
} from './simTypes';

const EMPTY_FORCE_VECTORS: ForceVectorSample[] = [];
const EMPTY_MANEUVER_LABELS: Record<string, string> = {};

/** A render-side proxy the client mirrors authoritative aircraft state onto. */
export interface SimAircraftProxy {
    readonly simId: string;
    collectInputs(): SimControlInputs;
    /** Read this aircraft's row (starting at `base`) out of the flat snapshot. */
    applyStateBuffer(buffer: Float32Array, base: number, forceVectors: ForceVectorSample[]): void;
}

/**
 * Main-thread owner of the single combat sim worker. Render-side proxies
 * register here; once per frame {@link tick} pumps their control inputs into the
 * worker (coalescing frames that arrive while the worker is busy) and, on each
 * snapshot, mirrors authoritative state back onto every proxy.
 *
 * When `crossOriginIsolated`, aircraft/projectile floats live in a SharedArrayBuffer
 * double-buffer so pose can be applied every tick without waiting for a starved
 * worker `onmessage`.
 */
export class CombatSimClient {

    private readonly worker: Worker;
    private readonly proxies = new Map<string, SimAircraftProxy>();
    private readonly firing = new Map<string, boolean>();

    private busy = false;
    private pendingDelta = 0;
    private lastDelta = 0;

    private readonly shared: SimSharedViews | undefined;
    private lastSharedSeq = 0;
    private sharedIds: string[] = [];
    private sharedForceVectors: Record<string, ForceVectorSample[]> = {};

    private projectiles: Float32Array<ArrayBufferLike> = new Float32Array(0);
    private projectileCount = 0;
    private pendingHits: SimHitEvent[] = [];
    private maneuverLabels: Record<string, string> = EMPTY_MANEUVER_LABELS;
    /** Fired on the main thread whenever a snapshot carries new hits (debris / SFX). */
    onHits: ((hits: SimHitEvent[]) => void) | undefined;

    constructor() {
        this.worker = new Worker(new URL('../worker/combatSimWorker.ts', import.meta.url));
        this.post({ type: 'init' });
        if (typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated) {
            this.shared = createSimSharedState();
            this.post({ type: 'attachSharedState', buffer: this.shared.buffer });
        }
        this.worker.onmessage = (event: MessageEvent<WorkerToSimMessage>) => {
            const data = event.data;
            if (data.type === 'state') {
                const workerStepMs = data.workerStepMs ?? -1;
                if (data.shared) {
                    this.sharedIds = data.ids;
                    this.sharedForceVectors = data.forceVectors ?? {};
                    this.maneuverLabels = data.maneuverLabels ?? EMPTY_MANEUVER_LABELS;
                    this.applyHits(data.hits);
                    this.pullSharedPose();
                    this.syncBusyFromShared();
                } else {
                    this.busy = false;
                    this.applySnapshot(data);
                }
                this.flush();
            } else if (data.type === 'error') {
                this.busy = false;
                if (this.shared) {
                    setSharedBusy(this.shared, false);
                }
                console.error('[combatSimWorker]', data.message, data.stack);
                this.flush();
            }
        };
        this.worker.onerror = (event) => {
            console.error('[combatSimWorker] worker error', event.message, event.filename, event.lineno);
        };
    }

    /** True when pose is mirrored via SharedArrayBuffer (HD can run uncapped). */
    usesSharedState(): boolean {
        return this.shared !== undefined;
    }

    private post(message: SimToWorkerMessage): void {
        this.worker.postMessage(message);
    }

    setWorld(world: SerializedWorld): void {
        this.post({ type: 'setWorld', world });
    }

    /** Sampler config for the mirrored DEM. Send before any tiles. */
    setHeightField(config: SerializedHeightField): void {
        this.post({ type: 'setHeightField', config });
    }

    /** Add/drop mirrored DEM tiles; height buffers are transferred, not copied. */
    postHeightTiles(update: HeightTileUpdate): void {
        this.worker.postMessage(
            { type: 'heightTiles', update },
            update.add.map(t => t.heights.buffer as ArrayBuffer),
        );
    }

    setArrestorCables(cables: SerializedArrestorCables[]): void {
        this.post({ type: 'setArrestorCables', cables });
    }

    /**
     * The mesh the barricade webbing drapes over.
     *
     * Separate from {@link setCollision}, which is the coarse hitbox bullets and
     * crashes use and wants to stay coarse. The webbing is *drawn* lying on the
     * airframe, so it has to be solved against the airframe that is drawn —
     * against the hitbox it reads as threaded through the wings.
     */
    setCarrierMeshOrigins(origins: { originX: number; originY: number; originZ: number }[]): void {
        this.post({ type: 'setCarrierMeshOrigins', origins });
    }

    setCarrierVelocity(vx: number, vy: number, vz: number): void {
        this.post({ type: 'setCarrierVelocity', velocity: [vx, vy, vz] });
    }

    registerProxy(proxy: SimAircraftProxy): void {
        this.proxies.set(proxy.simId, proxy);
    }

    addAircraft(desc: SimAircraftDesc): void {
        this.post({ type: 'addAircraft', desc });
    }

    removeAircraft(id: string): void {
        this.post({ type: 'removeAircraft', id });
    }

    setEnabled(id: string, enabled: boolean): void {
        this.post({ type: 'setEnabled', id, enabled });
    }

    setControlMode(id: string, control: SimControlMode): void {
        this.post({ type: 'setControlMode', id, control });
    }

    setTarget(id: string, targetId: string | null): void {
        this.post({ type: 'setTarget', id, targetId });
    }

    setFormationLead(id: string, leadId: string | null): void {
        this.post({ type: 'setFormationLead', id, leadId });
    }

    /** Engage every live aircraft of `faction`, re-picking as the fight develops. */
    setTargetFaction(id: string, faction: Faction | null): void {
        this.post({ type: 'setTargetFaction', id, faction });
    }

    setPhase(id: string, phase: number): void {
        this.post({ type: 'setPhase', id, phase });
    }

    /** Rebuild the in-worker pilot (used when switching AI model on spawn). */
    setPilotOptions(id: string, options: AiPilotOptions): void {
        this.post({ type: 'setPilotOptions', id, options });
    }

    respawn(id: string, spawn: SimAircraftSpawn): void {
        this.post({ type: 'respawn', id, spawn });
    }

    /** Latest AI maneuver / phase label for an aircraft (from the last snapshot). */
    getManeuverLabel(id: string): string | undefined {
        return this.maneuverLabels[id];
    }

    resetAircraft(id: string, position: THREE.Vector3, quaternion: THREE.Quaternion, velocity: THREE.Vector3, landed: boolean, throttle: number, model: SimFlightModelKind): void {
        this.post({
            type: 'reset', id,
            position: position.toArray() as [number, number, number],
            quaternion: quaternion.toArray() as [number, number, number, number],
            velocity: velocity.toArray() as [number, number, number],
            landed, throttle, model,
        });
    }

    setAircraftConfig(id: string, aircraftConfig: Fm2AircraftConfig, model: SimFlightModelKind): void {
        this.post({ type: 'setAircraftConfig', id, aircraftConfig, model });
    }

    setCollision(id: string, collision: AircraftCollisionMesh | undefined): void {
        this.post({ type: 'setCollision', id, collision });
    }

    setPosition(id: string, position: THREE.Vector3): void {
        this.post({ type: 'setPosition', id, position: position.toArray() as [number, number, number] });
    }

    setQuaternion(id: string, quaternion: THREE.Quaternion): void {
        this.post({ type: 'setQuaternion', id, quaternion: quaternion.toArray() as [number, number, number, number] });
    }

    setVelocity(id: string, velocity: THREE.Vector3): void {
        this.post({ type: 'setVelocity', id, velocity: velocity.toArray() as [number, number, number] });
    }

    syncEffectiveThrottle(id: string, throttle: number): void {
        this.post({ type: 'syncEffectiveThrottle', id, throttle });
    }

    snapPhysicsState(id: string): void {
        this.post({ type: 'snapPhysicsState', id });
    }

    /** Inject an externally-simulated combatant (e.g. a player model outside the sim worker). */
    setExternalState(id: string, faction: Faction, position: THREE.Vector3, velocity: THREE.Vector3, alive: boolean): void {
        this.post({
            type: 'setExternalState', id, enabled: true, faction,
            position: position.toArray() as [number, number, number],
            velocity: velocity.toArray() as [number, number, number],
            alive,
        });
    }

    clearExternalState(id: string): void {
        this.post({ type: 'clearExternalState', id });
    }

    /** Latch this frame's trigger for an externally-controlled aircraft. */
    setFiring(id: string, firing: boolean): void {
        this.firing.set(id, firing);
    }

    postKeyDown(id: string, key: string, repeat = false): void {
        this.post({ type: 'keyDown', id, key, repeat });
    }

    postKeyUp(id: string, key: string): void {
        this.post({ type: 'keyUp', id, key });
    }

    setKeyboardLayout(layoutId: KeyboardControlLayoutId): void {
        this.post({ type: 'setKeyboardLayout', layoutId });
    }

    postGamepadAxes(id: string, pitch: number, roll: number, yaw: number, throttle: number, connected: boolean): void {
        this.post({ type: 'gamepadAxes', id, pitch, roll, yaw, throttle, connected });
    }

    postInputBlur(id: string): void {
        this.post({ type: 'inputBlur', id });
    }

    setInputEnabled(id: string, enabled: boolean): void {
        this.post({ type: 'setInputEnabled', id, enabled });
    }

    setForceVectorsRequested(id: string, want: boolean): void {
        this.post({ type: 'setForceVectorsRequested', id, want });
    }

    /** Pump one frame of accumulated time into the worker. Called once per frame. */
    tick(delta: number): void {
        // After tab resume / long stalls, clamp so one huge frame cannot enqueue a
        // multi-hundred-ms step (and never console.warn here — DevTools makes that a hitch loop).
        if (delta > 0.1) {
            delta = 0.05;
        }
        // Pull pose from SAB before flush so a delayed onmessage cannot freeze the aircraft.
        this.pullSharedPose();
        this.syncBusyFromShared();
        this.pendingDelta += delta;
        this.flush();
    }

    private syncBusyFromShared(): void {
        if (!this.shared) {
            return;
        }
        this.busy = isSharedBusy(this.shared);
    }

    private pullSharedPose(): void {
        if (!this.shared || this.sharedIds.length === 0) {
            return;
        }
        const pull = tryPullSharedSnapshot(this.shared, this.lastSharedSeq);
        if (!pull) {
            return;
        }
        this.lastSharedSeq = pull.seq;
        const count = Math.min(pull.aircraftCount, this.sharedIds.length);
        for (let i = 0; i < count; i++) {
            const id = this.sharedIds[i];
            this.proxies.get(id)?.applyStateBuffer(
                pull.aircraft, i * AC_STRIDE, this.sharedForceVectors[id] ?? EMPTY_FORCE_VECTORS);
        }
        this.projectiles = pull.projectiles;
        this.projectileCount = pull.projectileCount;
    }

    private flush(): void {
        if (this.shared) {
            this.busy = isSharedBusy(this.shared);
        }
        if (this.busy || this.pendingDelta <= 0 || this.proxies.size === 0) {
            return;
        }
        const inputs: Record<string, SimControlInputs> = {};
        for (const proxy of this.proxies.values()) {
            const i = proxy.collectInputs();
            i.firing = this.firing.get(proxy.simId) ?? false;
            inputs[proxy.simId] = i;
        }
        // Cap step size and drop large backlogs so a slow main thread cannot
        // enqueue multi-second worker steps that keep the UI behind forever.
        // Remainder is discarded (not carried) so pending cannot snowball when
        // snapshot RTT exceeds the step size — realtime pacing over exact catch-up.
        const MAX_STEP_DELTA = 1 / 30;
        const MAX_PENDING = 0.2;
        if (this.pendingDelta > MAX_PENDING) {
            this.pendingDelta = MAX_STEP_DELTA;
        }
        const delta = Math.min(this.pendingDelta, MAX_STEP_DELTA);
        this.pendingDelta = 0;
        this.busy = true;
        if (this.shared) {
            setSharedBusy(this.shared, true);
        }
        this.lastDelta = delta;
        this.post({ type: 'step', delta, inputs });
    }

    private applyHits(hits: SimHitEvent[]): void {
        if (hits.length === 0) {
            return;
        }
        for (let i = 0; i < hits.length; i++) {
            this.pendingHits.push(hits[i]);
        }
        this.onHits?.(hits);
    }

    private applySnapshot(snapshot: SnapshotBuffers): void {
        for (let i = 0; i < snapshot.ids.length; i++) {
            const id = snapshot.ids[i];
            this.proxies.get(id)?.applyStateBuffer(
                snapshot.aircraft, i * AC_STRIDE, snapshot.forceVectors[id] ?? EMPTY_FORCE_VECTORS);
        }
        this.maneuverLabels = snapshot.maneuverLabels ?? EMPTY_MANEUVER_LABELS;
        this.projectiles = snapshot.projectiles;
        this.projectileCount = snapshot.projectileCount;
        this.applyHits(snapshot.hits);
    }

    /** Flat projectile buffer from the latest snapshot (PROJ_STRIDE floats each). */
    getProjectileBuffer(): Float32Array {
        return this.projectiles;
    }

    /** Number of live projectiles in {@link getProjectileBuffer}. */
    getProjectileCount(): number {
        return this.projectileCount;
    }

    /** Drain hit events accumulated since the last call (for SFX / feedback). */
    drainHits(): SimHitEvent[] {
        if (this.pendingHits.length === 0) {
            return this.pendingHits;
        }
        const hits = this.pendingHits;
        this.pendingHits = [];
        return hits;
    }
}

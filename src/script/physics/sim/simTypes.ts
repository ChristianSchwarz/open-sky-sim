import { Fm2AircraftConfig } from '../fm2/fm2AircraftConfig';
import { AiPilotOptions } from '../../ai/aiPilot';
import { ForceVectorSample } from '../model/flightModel';
import { KeyboardControlLayoutId, KeyboardPitchStickMode } from '../../input/keyboardLayouts';
import { AircraftCollisionMesh } from '../../scene/entities/aircraftDef';
import { SerializedArrestorCables, SerializedBarricade, SerializedWorld } from './serializedWorld';
import { HeightTileUpdate, SerializedHeightField } from '../../terrain/heightMirror';

/**
 * Serializable protocol for the unified combat sim worker. One worker owns the
 * authoritative simulation of every aircraft (the player and all AI opponents),
 * their pilots, the projectile pool and hit detection. The main thread posts
 * control inputs + discrete events in, and receives one {@link SimSnapshot} out
 * per physics pump, which the render-side proxies mirror.
 */

export type SimControlMode = 'external' | 'ai';

/** Which physics flies a sim-owned aircraft: FM2, FM2's free-fly mode, or FM3. */
export type SimFlightModelKind = 'fm2' | 'debug' | 'fm3';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export type { AircraftCollisionMesh };

/** The normalized command channel for one externally-controlled aircraft. */
export interface SimControlInputs {
    pitch: number;
    roll: number;
    yaw: number;
    throttle: number;
    landingGearDeployed: boolean;
    flapsExtended: boolean;
    airbrakesExtended: boolean;
    /** Tailhook lowered — required to snag an arrestor cable. */
    hookDeployed: boolean;
    wheelBrakesApplied: boolean;
    pitchLimiterMode: number;
    limitersEnabled: boolean;
    wantForceVectors: boolean;
    /** Trigger held this frame (only meaningful for aircraft with a gun). */
    firing: boolean;
}

export interface SimGunConfig {
    muzzleVelocity: number;
    roundsPerSecond: number;
    damage: number;
    ammo: number;
    muzzleOffset: Vec3;
    spread?: number;
}

export interface SimAircraftSpawn {
    position: Vec3;
    quaternion: Quat;
    velocity?: Vec3;
    landed: boolean;
    throttle: number;
    airborne: boolean;
}

export interface SimAircraftDesc {
    id: string;
    /** Faction (see weapons/combatant.Faction). */
    faction: number;
    control: SimControlMode;
    /** Flight model; when absent, `kinematic` picks between 'debug' and 'fm2'. */
    model?: SimFlightModelKind;
    kinematic?: boolean;
    aircraftConfig?: Fm2AircraftConfig;
    /** Present when this aircraft can be flown by an in-worker AI pilot. */
    pilotOptions?: AiPilotOptions;
    hitRadius: number;
    maxHealth: number;
    gun?: SimGunConfig;
    /** Baked TCA collider triangles (body frame); omit → sphere hitRadius. */
    collision?: AircraftCollisionMesh;
    spawn: SimAircraftSpawn;
    enabled: boolean;
}

/** Authoritative per-aircraft state mirrored by the render-side proxy. */
export interface SimAircraftState {
    id: string;
    position: Vec3;
    quaternion: Quat;
    velocity: Vec3;
    prevPosition: Vec3;
    prevQuaternion: Quat;
    prevVelocity: Vec3;
    deltaRemainder: number;
    crashed: boolean;
    landed: boolean;
    angleOfAttackRad: number;
    loadFactorG: number;
    commandedElevator: number;
    commandedAileron: number;
    commandedRudder: number;
    accelWorld: Vec3;
    engineThrustN: number;
    effectiveThrottle: number;
    stall: number;
    forceVectors: ForceVectorSample[];
    gearDeployed: boolean;
    flapsExtended: boolean;
    airbrakesExtended: boolean;
    firing: boolean;
    health: number;
    ammo: number;
}

/** A live projectile, rendered as a tracer on the main thread. */
export interface SimProjectileState {
    position: Vec3;
    quaternion: Quat;
}

/** A confirmed hit this frame, for SFX / feedback on the main thread. */
export interface SimHitEvent {
    /** World-space impact point (mesh surface or hit-sphere entry). */
    position: Vec3;
    /** Target world velocity at impact (m/s) — debris should inherit this. */
    velocity: Vec3;
    targetId: string;
    damage: number;
    /**
     * `gun` (default): airframe fire/smoke + debris.
     * `scrape`: ground-contact puff at the impact point only (no hull fire).
     */
    source?: 'gun' | 'scrape';
}

export interface SimSnapshot {
    aircraft: SimAircraftState[];
    projectiles: SimProjectileState[];
    hits: SimHitEvent[];
}

// --- Main thread -> worker messages ------------------------------------------

export type SimToWorkerMessage =
    | { type: 'init' }
    | { type: 'attachSharedState'; buffer: SharedArrayBuffer }
    | { type: 'setWorld'; world: SerializedWorld }
    | { type: 'setHeightField'; config: SerializedHeightField }
    | { type: 'heightTiles'; update: HeightTileUpdate }
    | { type: 'setArrestorCables'; cables: SerializedArrestorCables[] }
    | { type: 'setCarrierMeshOrigins'; origins: { originX: number; originY: number; originZ: number }[] }
    | { type: 'setCarrierVelocity'; velocity: Vec3 }
    | { type: 'addAircraft'; desc: SimAircraftDesc }
    | { type: 'removeAircraft'; id: string }
    | { type: 'setEnabled'; id: string; enabled: boolean }
    | { type: 'setControlMode'; id: string; control: SimControlMode }
    | { type: 'setTarget'; id: string; targetId: string | null }
    | { type: 'setFormationLead'; id: string; leadId: string | null }
    | { type: 'setTargetFaction'; id: string; faction: number | null }
    | { type: 'setPhase'; id: string; phase: number }
    | { type: 'setPilotOptions'; id: string; options: AiPilotOptions }
    | { type: 'respawn'; id: string; spawn: SimAircraftSpawn }
    | { type: 'reset'; id: string; position: Vec3; quaternion: Quat; velocity: Vec3; landed: boolean; throttle: number; model: SimFlightModelKind }
    | { type: 'setAircraftConfig'; id: string; aircraftConfig: Fm2AircraftConfig; model: SimFlightModelKind; collision?: AircraftCollisionMesh }
    | { type: 'setCollision'; id: string; collision?: AircraftCollisionMesh }
    | { type: 'setBarricadeDrape'; id: string; drape?: AircraftCollisionMesh }
    | { type: 'setPosition'; id: string; position: Vec3 }
    | { type: 'setQuaternion'; id: string; quaternion: Quat }
    | { type: 'setVelocity'; id: string; velocity: Vec3 }
    | { type: 'syncEffectiveThrottle'; id: string; throttle: number }
    | { type: 'snapPhysicsState'; id: string }
    | { type: 'setExternalState'; id: string; enabled: boolean; faction: number; position: Vec3; velocity: Vec3; alive: boolean }
    | { type: 'clearExternalState'; id: string }
    | { type: 'step'; delta: number; inputs: Record<string, SimControlInputs> }
    | { type: 'setBarricades'; barricades: SerializedBarricade[] }
    | { type: 'keyDown'; id: string; key: string; repeat: boolean }
    | { type: 'keyUp'; id: string; key: string }
    | { type: 'setKeyboardLayout'; layoutId: KeyboardControlLayoutId }
    | { type: 'setKeyboardPitchStickMode'; mode: KeyboardPitchStickMode }
    | { type: 'gamepadAxes'; id: string; pitch: number; roll: number; yaw: number; throttle: number; connected: boolean }
    | { type: 'inputBlur'; id: string }
    | { type: 'setInputEnabled'; id: string; enabled: boolean }
    | { type: 'setForceVectorsRequested'; id: string; want: boolean };

// --- Worker -> main thread messages ------------------------------------------

/** Lightweight state when pose floats live in SharedArrayBuffer. */
export type WorkerSharedStateMessage = {
    type: 'state';
    shared: true;
    seq: number;
    ids: string[];
    forceVectors: import('./simSnapshotCodec').SnapshotBuffers['forceVectors'];
    maneuverLabels: import('./simSnapshotCodec').SnapshotBuffers['maneuverLabels'];
    hits: import('./simSnapshotCodec').SnapshotBuffers['hits'];
    workerStepMs?: number;
};

export type WorkerToSimMessage =
    | ({ type: 'state'; shared?: false } & import('./simSnapshotCodec').SnapshotBuffers & { workerStepMs?: number })
    | WorkerSharedStateMessage
    | { type: 'error'; message: string; stack?: string };

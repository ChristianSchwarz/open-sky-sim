import * as THREE from 'three';

/**
 * Command sink for an aircraft: exactly the normalized inputs a human pilot
 * produces. An AI pilot writes to this and never touches physics or control
 * surfaces directly (see {@link AircraftObservation} for the matching state
 * source). Both the player's plane and a spawned opponent implement it.
 */
interface AircraftControlChannel {
    /** [-1, 1], +1 = nose up (aft stick). */
    setPitch(pitch: number): void;
    /** [-1, 1], +1 = roll right. */
    setRoll(roll: number): void;
    /** [-1, 1], +1 = nose right (right pedal). */
    setYaw(yaw: number): void;
    /** [0, 1], 0 = idle, 1 = full (afterburner for AB-capable jets). */
    setThrottle(throttle: number): void;
    setWheelBrakes(applied: boolean): void;
    setLandingGearDeployed(deployed: boolean): void;
    setFlapsExtended(extended: boolean): void;
    setAirbrakesExtended(extended: boolean): void;
}

/**
 * Read-only rigid-body / envelope state an AI pilot observes each frame. Vectors
 * are live references owned by the aircraft; the pilot reads them within the same
 * frame it writes commands and must not retain them.
 */
interface AircraftObservation {
    /** World position (m). */
    getPosition(): THREE.Vector3;
    /** World velocity (m/s). */
    getVelocity(): THREE.Vector3;
    /** Body orientation. */
    getQuaternion(): THREE.Quaternion;
    /** Speed over ground (m/s). */
    getAirspeed(): number;
    /** Altitude above the flat datum (m) — equal to position.y. */
    getAltitude(): number;
    /** Angle of attack (rad). */
    getAngleOfAttack(): number;
    /** Load factor (g). */
    getLoadFactorG(): number;
    /** >= 0 means stalling. */
    getStallStatus(): number;
    isLanded(): boolean;
    isCrashed(): boolean;
    isGearDeployed(): boolean;
    isFlapsExtended(): boolean;
    isAirbrakesExtended(): boolean;
}

/** An aircraft an {@link AiPilot} can fully fly: it both accepts commands and reports state. */
export interface PilotableAircraft extends AircraftControlChannel, AircraftObservation { }

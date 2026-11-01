import * as THREE from 'three';

/** High-level Shaw engagement posture (Fighter Combat Ch. 2–3). */
export type TacticalState = 'OFFENSIVE' | 'NEUTRAL' | 'DEFENSIVE';

export type ManeuverType =
    // Offensive
    | 'LEAD_PURSUIT'
    | 'PURE_PURSUIT'
    | 'LAG_PURSUIT'
    | 'HIGH_YO_YO'
    | 'LOW_YO_YO'
    // Neutral
    | 'LEAD_TURN'
    | 'ENERGY_CLIMB'
    | 'HEAD_ON_ENGAGE'
    // Defensive
    | 'BREAK_TURN'
    | 'DEFENSIVE_SPIRAL'
    | 'FLAT_SCISSORS';

/** Snapshot of one aircraft for geometry / FSM evaluation (plain data). */
export interface AircraftSnapshot {
    position: THREE.Vector3;
    velocity: THREE.Vector3;
    forward: THREE.Vector3;
    up: THREE.Vector3;
    right: THREE.Vector3;
    altitude: number;
    airspeed: number;
    /** Optimal turn speed (m/s). */
    cornerVelocity: number;
    maxG: number;
    /** World-frame acceleration (m/s^2) where the pilot estimates it, for the gun lead. */
    acceleration?: THREE.Vector3;
}

export interface TacticalGeometry {
    range: number;
    /** Unit LOS from self → target. */
    losVector: THREE.Vector3;
    /** Angle off target's tail (rad): 0 = dead six, π = head-on. */
    aot: number;
    /** Aspect of target on self (rad): 0 = enemy on our six. Alias of their tracking. */
    taa: number;
    /** Antenna train angle / nose-to-LOS (rad). */
    ata: number;
    /** Positive = closing (m/s). */
    closureRate: number;
    /** Self Es − target Es (energy height, m). */
    energyDelta: number;
    selfEs: number;
    targetEs: number;
}

/**
 * High-level setpoints from the tactical FSM. The Flight Control Computer
 * turns these into stick/throttle — tactics never write surfaces directly.
 */
export interface FlightCommand {
    stateName: TacticalState;
    maneuverName: ManeuverType;
    /** World-space aim direction the nose should track. */
    targetDirection: THREE.Vector3;
    /** Desired airspeed (m/s). */
    targetSpeed: number;
    /** Preferred load factor hint (g); FCC soft-limits against airframe. */
    targetGForce: number;
    /** When true, cut throttle hard (stand-in for speedbrakes). */
    useAirbrakes: boolean;
    fireGuns: boolean;
    /** Allow the hard-turn pull when angular error is large. */
    allowHardTurn: boolean;
}

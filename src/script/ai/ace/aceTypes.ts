import * as THREE from 'three';
import { AircraftSnapshot } from '../shaw/shawTypes';

/**
 * Ace engagement posture. Unlike Shaw's fair Offensive/Neutral/Defensive
 * matrix or Aggressive's never-retreat Attack/Merge/Counter, the Ace doctrine
 * adds a deliberate {@link AceState} `RESET`: a true ace *does* trade angles
 * for energy when it is losing the energy fight, then comes back down on the
 * bandit from above instead of grinding out a losing low-speed turn circle.
 */
export type AceState =
    /** We own the angles: bandit in front, inside our control zone. */
    | 'CONTROL'
    /** Neutral / head-on / out of the control zone. */
    | 'MERGE'
    /** Bandit is tracking us from the rear hemisphere in range. */
    | 'EVADE'
    /** Deliberate energy rebuild — extend/zoom, then re-attack from above. */
    | 'RESET';

export type AceManeuverType =
    // CONTROL — converting angles into a gun solution without overshooting.
    | 'LEAD_PURSUIT'
    | 'LAG_PURSUIT'
    | 'HIGH_YO_YO'
    | 'LOW_YO_YO'
    | 'BARREL_ROLL_ATTACK'
    // MERGE — the ace answer to a neutral pass is always the vertical.
    | 'LEAD_TURN'
    | 'VERTICAL_REPOSITION'
    | 'HEAD_ON_SNAPSHOT'
    // EVADE — defeat the tracking solution, ideally by making them overshoot.
    | 'BREAK_TURN'
    | 'DEFENSIVE_SPIRAL'
    | 'ROLLING_SCISSORS'
    | 'COBRA_BRAKE'
    | 'KULBIT'
    // RESET — buy back energy height, keeping the bandit in sight.
    | 'ZOOM_CLIMB'
    | 'SPLIT_S';

/**
 * Post-stall maneuver ("PSM") request. These are the signature moves of the
 * genre's ace pilots and cannot be expressed as a {@link FlightSetpoint}: they
 * are open-loop, timed, deliberately-departed-from-controlled-flight sequences
 * that the {@link import('../shaw/flightControlComputer').FlightControlComputer}
 * closed loops would immediately fight. The FSM only *requests* one; the pilot
 * vetoes it on altitude / airspeed / cooldown grounds (see
 * {@link import('./aceAiPilot').AceAiPilot}).
 */
export type PostStallRequest =
    /** Pugachev's Cobra: airbrake + full aft stick to bleed speed and make a closing bandit overshoot. */
    | 'COBRA'
    /** Kulbit: a full max-G backflip in place, snapping the nose back onto a bandit that just slid past. */
    | 'KULBIT';

/** Snapshot plus the target acceleration the ballistic gun solution needs. */
export interface AceSnapshot extends AircraftSnapshot {
    /** World-frame acceleration (m/s^2), estimated by finite difference. */
    acceleration: THREE.Vector3;
}

/**
 * High-level setpoints from {@link import('./aceTacticalFsm').AceTacticalFSM}.
 * Field-compatible with Shaw's `FlightCommand` and Aggressive's
 * `AggressiveFlightCommand` so the same `FlightControlComputer` consumes it,
 * plus {@link postStall}, which only the Ace pilot knows how to fly.
 */
export interface AceFlightCommand {
    stateName: AceState;
    maneuverName: AceManeuverType;
    /** World-space aim direction the nose should track. */
    targetDirection: THREE.Vector3;
    /** Desired airspeed (m/s). */
    targetSpeed: number;
    /** Preferred load factor hint (g); FCC soft-limits against airframe. */
    targetGForce: number;
    /** When true, cut throttle hard (stand-in for speedbrakes). */
    useAirbrakes: boolean;
    /** Gun envelope per tactical geometry; the pilot still needs a ballistic solution to shoot. */
    fireGuns: boolean;
    /** Allow the hard-turn pull when angular error is large. */
    allowHardTurn: boolean;
    /** Requested post-stall maneuver, subject to the pilot's veto. */
    postStall?: PostStallRequest;
}

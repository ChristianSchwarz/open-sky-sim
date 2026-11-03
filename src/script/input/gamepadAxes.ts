/**
 * Gamepad axes to stick inputs: a dead zone round centre, and an idle pad
 * that hands control back to the keyboard. Pure, so it is unit-tested
 * without a browser (gamepadAxes.test.ts).
 */

import { clamp } from '../utils/math';

export const GAMEPAD_AXIS_ROLL = 0;
export const GAMEPAD_AXIS_PITCH = 1;
export const GAMEPAD_AXIS_THROTTLE = 2;
export const GAMEPAD_AXIS_YAW = 3;

/**
 * Share of the throw round centre that reads as zero. A worn stick rests a
 * few percent off centre; touch uses 0.06 with no spring to drift.
 */
export const GAMEPAD_DEAD_ZONE = 0.1;

/** Throttle axis travel (raw, -1..1) that counts as the player moving it. */
const THROTTLE_MOVE = 0.02;

/** Dead zone, then rescaled so full throw is still ±1. */
export function applyDeadZone(value: number, deadZone = GAMEPAD_DEAD_ZONE): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    const magnitude = Math.abs(value);
    if (magnitude <= deadZone) {
        return 0;
    }
    return Math.sign(value) * Math.min(1, (magnitude - deadZone) / (1 - deadZone));
}

export interface GamepadReading {
    pitch: number;
    roll: number;
    yaw: number;
    /**
     * 0..1 when the throttle axis has moved since it was last taken, else NaN:
     * the throttle stays where it is (and the keys may still move it).
     */
    throttle: number;
    /**
     * False when the pad is idle: sticks inside the dead zone, no button
     * held and the throttle axis where it was last taken. The keyboard flies then.
     */
    active: boolean;
}

/**
 * Reads one pad frame by frame. The throttle axis is taken only once it has
 * moved away from where it rested on the first read: on a standard pad
 * axis 2 is a stick that springs back to centre, which would otherwise pin
 * the throttle at 50 %.
 */
export class GamepadAxisReader {

    private throttleRest = NaN;
    private throttleTaken = false;
    /** Raw throttle axis when it was last taken. */
    private throttleApplied = NaN;

    /** Forget the throttle's rest position: a new pad, or the same one plugged back in. */
    reset(): void {
        this.throttleRest = NaN;
        this.throttleTaken = false;
        this.throttleApplied = NaN;
    }

    read(axes: readonly number[], anyButtonPressed: boolean): GamepadReading {
        const axis = (i: number) => (i < axes.length ? axes[i] : 0);
        const roll = applyDeadZone(axis(GAMEPAD_AXIS_ROLL));
        const pitch = applyDeadZone(axis(GAMEPAD_AXIS_PITCH));
        const yaw = applyDeadZone(axis(GAMEPAD_AXIS_YAW));

        let throttle = NaN;
        let throttleMoved = false;
        const raw = axes.length > GAMEPAD_AXIS_THROTTLE ? axes[GAMEPAD_AXIS_THROTTLE] : NaN;
        if (Number.isFinite(raw)) {
            if (!Number.isFinite(this.throttleRest)) {
                this.throttleRest = raw;
            }
            if (!this.throttleTaken && Math.abs(raw - this.throttleRest) > GAMEPAD_DEAD_ZONE) {
                this.throttleTaken = true;
            }
            throttleMoved = this.throttleTaken && (!Number.isFinite(this.throttleApplied)
                || Math.abs(raw - this.throttleApplied) > THROTTLE_MOVE);
            if (throttleMoved) {
                this.throttleApplied = raw;
                throttle = clamp((1 - raw) * 0.5, 0, 1);
            }
        }

        const active = pitch !== 0 || roll !== 0 || yaw !== 0 || anyButtonPressed || throttleMoved;
        return { pitch, roll, yaw, throttle, active };
    }
}

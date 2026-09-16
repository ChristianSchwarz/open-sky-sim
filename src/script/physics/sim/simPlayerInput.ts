import {
    adjustF16ThrottleInput, isF16AbDetentBand, stepF16ThrottleDetent,
} from '../f16Engine';
import { FcsPitchLimiter } from '../fm2/fcs';
import { Fm2AircraftConfig } from '../fm2/fm2AircraftConfig';
import {
    PITCH_STICK_AFT_UNITS, PITCH_STICK_BASE_UNIT_RATE, PITCH_STICK_FWD_UNITS,
    PITCH_STICK_MAX_UNIT_RATE, PITCH_STICK_UNIT_ACCEL, THROTTLE_RATE,
} from '../../defs';
import {
    getKeyboardLayout, KeyboardControlAction, KeyboardControlLayout,
    KeyboardControlLayoutId, KeyboardPitchStickMode,
} from '../../input/keyboardLayouts';
import { clamp } from '../../utils/math';
import { SimControlInputs, SimControlMode } from './simTypes';

enum Stick {
    IDLE,
    POSITIVE_ENDED,
    NEGATIVE_ENDED,
    POSITIVE,
    NEGATIVE,
}

/** Callbacks the input handler uses to mutate the owning aircraft. */
export interface SimPlayerInputSink {
    readonly control: SimControlMode;
    readonly health: number;
    isLanded(): boolean;
    isOnGround(): boolean;
    isCrashed(): boolean;
    getThrottle(): number;
    getAfterburner(): boolean;
    isGearDeployed(): boolean;
    isFlapsExtended(): boolean;
    isAirbrakesExtended(): boolean;
    isHookDeployed(): boolean;
    toggleGear(): void;
    toggleFlaps(): void;
    toggleAirbrakes(): void;
    toggleHook(): void;
    toggleAutopilot(): void;
    setPitchLimiterMode(mode: FcsPitchLimiter): void;
}

/**
 * Worker-side keyboard / gamepad input for one externally-controlled aircraft.
 * The main thread posts raw key events; this class turns them into normalized
 * {@link SimControlInputs} each physics step.
 */
export class SimPlayerInput {

    private layoutId = KeyboardControlLayoutId.ARROWS;
    private layout: KeyboardControlLayout = getKeyboardLayout(this.layoutId);
    private pitchStickMode = KeyboardPitchStickMode.LAYOUT_DEFAULT;

    private pitchState = Stick.IDLE;
    private rollState = Stick.IDLE;
    private yawState = Stick.IDLE;
    private throttleState = Stick.IDLE;
    private wheelBrakeHeld = false;
    private wKeyDown = false;
    private pitchHoldSeconds = 0;
    private pitchUnitAccum = 0;
    private keysDown = new Set<string>();

    private pitch = 0;
    private pitchStickUnits = 0;
    private roll = 0;
    private yaw = 0;
    private throttle = 0;
    private wheelBrakes = false;
    private limitersEnabled = true;
    private pitchLimiterMode = FcsPitchLimiter.SOFT;
    private firing = false;
    private forceVectorsRequested = false;

    private inputEnabled = true;

    /** Gamepad axes, or NaN when disconnected. */
    private gamepadPitch = NaN;
    private gamepadRoll = NaN;
    private gamepadYaw = NaN;
    private gamepadThrottle = NaN;

    setKeyboardLayout(layoutId: KeyboardControlLayoutId): void {
        this.layoutId = layoutId;
        this.layout = getKeyboardLayout(layoutId);
    }

    setKeyboardPitchStickMode(mode: KeyboardPitchStickMode): void {
        this.pitchStickMode = mode;
        this.pitchState = Stick.IDLE;
        this.setPitchDeflection(0);
    }

    setInputEnabled(enabled: boolean): void {
        this.inputEnabled = enabled;
        if (!enabled) {
            this.clearSticks();
        }
    }

    setForceVectorsRequested(want: boolean): void {
        this.forceVectorsRequested = want;
    }

    setGamepadAxes(pitch: number, roll: number, yaw: number, throttle: number, connected: boolean): void {
        if (!connected) {
            this.gamepadPitch = NaN;
            this.gamepadRoll = NaN;
            this.gamepadYaw = NaN;
            this.gamepadThrottle = NaN;
            return;
        }
        this.gamepadPitch = pitch;
        this.gamepadRoll = roll;
        this.gamepadYaw = yaw;
        this.gamepadThrottle = throttle;
    }

    blur(): void {
        this.keysDown.clear();
        this.clearSticks();
    }

    /** Initialize throttle after spawn / reset. */
    syncThrottle(throttle: number): void {
        this.throttle = throttle;
    }

    keyDown(key: string, repeat: boolean, sink: SimPlayerInputSink): void {
        if (repeat && this.isLayoutKey(key)) {
            return;
        }
        this.keysDown.add(key);

        if (!this.inputEnabled || sink.control === 'ai') {
            return;
        }
        if (sink.health <= 0 || sink.isCrashed()) {
            return;
        }

        if (this.handleWheelBrakeKeyDown(key, sink)) {
            return;
        }
        if (key === 'w') {
            this.wKeyDown = true;
        }
        if (key === ' ' || key === 'space') {
            this.firing = true;
            return;
        }
        this.handleLayoutKeyDown(key, sink);
        this.handleActionKeyDown(key, sink);
    }

    keyUp(key: string, sink: SimPlayerInputSink): void {
        this.keysDown.delete(key);

        if (!this.inputEnabled || sink.control === 'ai') {
            return;
        }
        if (sink.health <= 0 || sink.isCrashed()) {
            return;
        }

        if (this.handleWheelBrakeKeyUp(key)) {
            return;
        }
        if (key === 'w') {
            this.wKeyDown = false;
        }
        if (key === ' ' || key === 'space') {
            this.firing = false;
            return;
        }
        this.handleLayoutKeyUp(key);
    }

    /** Advance stick/throttle state and produce this frame's control inputs. */
    tick(delta: number, sink: SimPlayerInputSink): SimControlInputs {
        if (sink.health <= 0 || sink.isCrashed()) {
            return this.neutralInputs(false, sink);
        }
        if (!this.inputEnabled || sink.control === 'ai') {
            return this.neutralInputs(false, sink);
        }

        if (Number.isFinite(this.gamepadPitch)) {
            this.applyGamepad();
        } else {
            this.tickKeyboardSticks(delta, sink);
        }

        return {
            pitch: this.pitch,
            roll: this.roll,
            yaw: this.yaw,
            throttle: this.throttle,
            landingGearDeployed: sink.isGearDeployed(),
            flapsExtended: sink.isFlapsExtended(),
            airbrakesExtended: sink.isAirbrakesExtended(),
            hookDeployed: sink.isHookDeployed(),
            wheelBrakesApplied: this.wheelBrakes,
            pitchLimiterMode: this.pitchLimiterMode,
            limitersEnabled: this.limitersEnabled,
            wantForceVectors: this.forceVectorsRequested,
            firing: this.firing,
        };
    }

    /** Mirror values packed into the render snapshot for HUD / telemetry. */
    readMirror(out: {
        pitch: number; roll: number; yaw: number; throttle: number;
        pitchStickUnits: number; wheelBrakes: boolean;
        limitersEnabled: boolean; pitchLimiterMode: FcsPitchLimiter;
        autopilot: boolean;
    }, control: SimControlMode): void {
        out.pitch = this.pitch;
        out.roll = this.roll;
        out.yaw = this.yaw;
        out.throttle = this.throttle;
        out.pitchStickUnits = this.pitchStickUnits;
        out.wheelBrakes = this.wheelBrakes;
        out.limitersEnabled = this.limitersEnabled;
        out.pitchLimiterMode = this.pitchLimiterMode;
        out.autopilot = control === 'ai';
    }

    private applyGamepad(): void {
        this.pitch = clamp(this.gamepadPitch, -1, 1);
        this.roll = clamp(this.gamepadRoll, -1, 1);
        this.yaw = clamp(this.gamepadYaw, -1, 1);
        this.throttle = clamp(this.gamepadThrottle, 0, 1);
        this.pitchStickUnits = this.pitch >= 0
            ? this.pitch * PITCH_STICK_AFT_UNITS
            : this.pitch * PITCH_STICK_FWD_UNITS;
    }

    private tickKeyboardSticks(delta: number, sink: SimPlayerInputSink): void {
        if (this.wKeyDown && this.canApplyWheelBrakes(sink)) {
            if (!this.wheelBrakeHeld) {
                this.engageWheelBrakes();
            }
        } else if (this.wheelBrakeHeld && !(this.wKeyDown && this.canApplyWheelBrakes(sink))) {
            this.releaseWheelBrakes();
            if (this.wKeyDown) {
                this.restoreLayoutActionForKey('w');
            }
        }

        if (this.pitchState !== Stick.IDLE && !this.usesSteppedPitchStick()) {
            switch (this.pitchState) {
                case Stick.POSITIVE_ENDED:
                case Stick.NEGATIVE_ENDED:
                    this.pitchState = Stick.IDLE;
                    this.setPitchDeflection(0);
                    break;
                case Stick.NEGATIVE:
                    this.setPitchDeflection(-1);
                    break;
                case Stick.POSITIVE:
                    this.setPitchDeflection(1);
                    break;
            }
        } else if (this.usesSteppedPitchStick()) {
            if (this.pitchState === Stick.POSITIVE || this.pitchState === Stick.NEGATIVE) {
                this.pitchHoldSeconds += delta;
                const direction = this.pitchState === Stick.POSITIVE ? 1 : -1;
                const rate = Math.min(
                    PITCH_STICK_MAX_UNIT_RATE,
                    PITCH_STICK_BASE_UNIT_RATE + PITCH_STICK_UNIT_ACCEL * this.pitchHoldSeconds,
                );
                this.pitchUnitAccum += rate * delta * direction;
                const steps = Math.trunc(this.pitchUnitAccum);
                if (steps !== 0) {
                    this.stepPitchStickUnits(steps);
                    this.pitchUnitAccum -= steps;
                }
            } else if (this.pitchState === Stick.POSITIVE_ENDED || this.pitchState === Stick.NEGATIVE_ENDED) {
                this.pitchState = Stick.IDLE;
                this.pitchHoldSeconds = 0;
                this.pitchUnitAccum = 0;
            }
        }

        if (this.rollState !== Stick.IDLE) {
            switch (this.rollState) {
                case Stick.POSITIVE_ENDED:
                case Stick.NEGATIVE_ENDED:
                    this.rollState = Stick.IDLE;
                    this.roll = 0;
                    break;
                case Stick.NEGATIVE:
                    this.roll = -1;
                    break;
                case Stick.POSITIVE:
                    this.roll = 1;
                    break;
            }
        }

        if (this.yawState !== Stick.IDLE) {
            switch (this.yawState) {
                case Stick.POSITIVE_ENDED:
                case Stick.NEGATIVE_ENDED:
                    this.yawState = Stick.IDLE;
                    this.yaw = 0;
                    break;
                case Stick.NEGATIVE:
                    this.yaw = -1;
                    break;
                case Stick.POSITIVE:
                    this.yaw = 1;
                    break;
            }
        }

        if (this.throttleState !== Stick.IDLE) {
            const isPositive = this.throttleState === Stick.POSITIVE || this.throttleState === Stick.POSITIVE_ENDED;
            const step = delta * 0.01 * (isPositive ? THROTTLE_RATE : -THROTTLE_RATE);
            const skipContinuousInAbBand = sink.getAfterburner()
                && isF16AbDetentBand(this.throttle) && isPositive;
            if (this.throttleState === Stick.POSITIVE_ENDED || this.throttleState === Stick.NEGATIVE_ENDED) {
                this.throttleState = Stick.IDLE;
            }
            if (!skipContinuousInAbBand) {
                this.adjustThrottle(step, sink);
            }
        }
    }

    private handleLayoutKeyDown(key: string, sink: SimPlayerInputSink): void {
        switch (key) {
            case this.layout[KeyboardControlAction.PITCH_POS]:
                this.latchPitch(Stick.POSITIVE);
                break;
            case this.layout[KeyboardControlAction.PITCH_NEG]:
                this.latchPitch(Stick.NEGATIVE);
                break;
            case this.layout[KeyboardControlAction.ROLL_POS]:
                this.rollState = Stick.POSITIVE;
                break;
            case this.layout[KeyboardControlAction.ROLL_NEG]:
                this.rollState = Stick.NEGATIVE;
                break;
            case this.layout[KeyboardControlAction.YAW_POS]:
                this.yawState = Stick.POSITIVE;
                break;
            case this.layout[KeyboardControlAction.YAW_NEG]:
                this.yawState = Stick.NEGATIVE;
                break;
            case this.layout[KeyboardControlAction.THROTTLE_POS]:
                if (sink.getAfterburner() && isF16AbDetentBand(this.throttle)) {
                    this.stepThrottle(1, sink);
                } else {
                    this.throttleState = Stick.POSITIVE;
                }
                break;
            case this.layout[KeyboardControlAction.THROTTLE_NEG]:
                if (sink.getAfterburner() && this.throttle >= 0.99) {
                    this.stepThrottle(-1, sink);
                } else {
                    this.throttleState = Stick.NEGATIVE;
                }
                break;
        }
    }

    private handleLayoutKeyUp(key: string): void {
        switch (key) {
            case this.layout[KeyboardControlAction.PITCH_POS]:
                if (this.isActionKeyHeld(KeyboardControlAction.PITCH_NEG)) {
                    this.latchPitch(Stick.NEGATIVE);
                } else if (this.pitchState === Stick.POSITIVE) {
                    this.pitchState = Stick.POSITIVE_ENDED;
                }
                break;
            case this.layout[KeyboardControlAction.PITCH_NEG]:
                if (this.isActionKeyHeld(KeyboardControlAction.PITCH_POS)) {
                    this.latchPitch(Stick.POSITIVE);
                } else if (this.pitchState === Stick.NEGATIVE) {
                    this.pitchState = Stick.NEGATIVE_ENDED;
                }
                break;
            case this.layout[KeyboardControlAction.ROLL_POS]:
                if (this.isActionKeyHeld(KeyboardControlAction.ROLL_NEG)) {
                    this.rollState = Stick.NEGATIVE;
                } else if (this.rollState === Stick.POSITIVE) {
                    this.rollState = Stick.POSITIVE_ENDED;
                }
                break;
            case this.layout[KeyboardControlAction.ROLL_NEG]:
                if (this.isActionKeyHeld(KeyboardControlAction.ROLL_POS)) {
                    this.rollState = Stick.POSITIVE;
                } else if (this.rollState === Stick.NEGATIVE) {
                    this.rollState = Stick.NEGATIVE_ENDED;
                }
                break;
            case this.layout[KeyboardControlAction.YAW_POS]:
                if (this.isActionKeyHeld(KeyboardControlAction.YAW_NEG)) {
                    this.yawState = Stick.NEGATIVE;
                } else if (this.yawState === Stick.POSITIVE) {
                    this.yawState = Stick.POSITIVE_ENDED;
                }
                break;
            case this.layout[KeyboardControlAction.YAW_NEG]:
                if (this.isActionKeyHeld(KeyboardControlAction.YAW_POS)) {
                    this.yawState = Stick.POSITIVE;
                } else if (this.yawState === Stick.NEGATIVE) {
                    this.yawState = Stick.NEGATIVE_ENDED;
                }
                break;
            case this.layout[KeyboardControlAction.THROTTLE_POS]:
                if (this.isActionKeyHeld(KeyboardControlAction.THROTTLE_NEG)) {
                    this.throttleState = Stick.NEGATIVE;
                } else if (this.throttleState === Stick.POSITIVE) {
                    this.throttleState = Stick.POSITIVE_ENDED;
                }
                break;
            case this.layout[KeyboardControlAction.THROTTLE_NEG]:
                if (this.isActionKeyHeld(KeyboardControlAction.THROTTLE_POS)) {
                    this.throttleState = Stick.POSITIVE;
                } else if (this.throttleState === Stick.NEGATIVE) {
                    this.throttleState = Stick.NEGATIVE_ENDED;
                }
                break;
        }
    }

    private handleActionKeyDown(key: string, sink: SimPlayerInputSink): void {
        switch (key) {
            case 'f':
                sink.toggleFlaps();
                break;
            case 'g':
                sink.toggleGear();
                break;
            case 'b':
                sink.toggleAirbrakes();
                break;
            case 'h':
                sink.toggleHook();
                break;
            case 'l':
                this.toggleLimiters();
                break;
            case 'a':
                sink.toggleAutopilot();
                break;
            case '1':
                this.pitchLimiterMode = FcsPitchLimiter.SOFT;
                sink.setPitchLimiterMode(FcsPitchLimiter.SOFT);
                break;
            case '2':
                this.pitchLimiterMode = FcsPitchLimiter.PREDICTIVE;
                sink.setPitchLimiterMode(FcsPitchLimiter.PREDICTIVE);
                break;
            case '3':
                this.pitchLimiterMode = FcsPitchLimiter.SMOOTH;
                sink.setPitchLimiterMode(FcsPitchLimiter.SMOOTH);
                break;
        }
    }

    private toggleLimiters(): void {
        this.limitersEnabled = !this.limitersEnabled;
    }

    private latchPitch(direction: Stick.POSITIVE | Stick.NEGATIVE): void {
        this.pitchState = direction;
        if (this.usesSteppedPitchStick()) {
            this.pitchHoldSeconds = 0;
            this.pitchUnitAccum = 0;
            this.stepPitchStickUnits(direction === Stick.POSITIVE ? 1 : -1);
        }
    }

    private setPitchDeflection(pitch: number): void {
        this.pitch = pitch;
        this.pitchStickUnits = pitch >= 0
            ? pitch * PITCH_STICK_AFT_UNITS
            : pitch * PITCH_STICK_FWD_UNITS;
    }

    private stepPitchStickUnits(delta: number): void {
        this.pitchStickUnits = clamp(
            this.pitchStickUnits + delta,
            -PITCH_STICK_FWD_UNITS,
            PITCH_STICK_AFT_UNITS,
        );
        this.pitch = this.pitchStickUnits >= 0
            ? this.pitchStickUnits / PITCH_STICK_AFT_UNITS
            : this.pitchStickUnits / PITCH_STICK_FWD_UNITS;
    }

    private adjustThrottle(step: number, sink: SimPlayerInputSink): void {
        if (sink.getAfterburner()) {
            this.throttle = adjustF16ThrottleInput(this.throttle, step);
        } else {
            this.throttle = clamp(this.throttle + step, 0, 1);
        }
    }

    private stepThrottle(direction: 1 | -1, sink: SimPlayerInputSink): void {
        if (sink.getAfterburner()) {
            this.throttle = stepF16ThrottleDetent(this.throttle, direction);
        } else {
            this.throttle = clamp(this.throttle + direction * 0.1, 0, 1);
        }
    }

    private usesSteppedPitchStick(): boolean {
        return this.layoutId === KeyboardControlLayoutId.ARROWS
            && this.pitchStickMode !== KeyboardPitchStickMode.HOLD;
    }

    private isActionKeyHeld(action: KeyboardControlAction): boolean {
        return this.keysDown.has(this.layout[action]);
    }

    private canApplyWheelBrakes(sink: SimPlayerInputSink): boolean {
        return sink.isLanded() || sink.isOnGround();
    }

    private handleWheelBrakeKeyDown(key: string, sink: SimPlayerInputSink): boolean {
        if (key !== 'w' || !this.canApplyWheelBrakes(sink)) {
            return false;
        }
        this.wKeyDown = true;
        this.engageWheelBrakes();
        return true;
    }

    private handleWheelBrakeKeyUp(key: string): boolean {
        if (key !== 'w') {
            return false;
        }
        this.wKeyDown = false;
        if (this.wheelBrakeHeld) {
            this.releaseWheelBrakes();
            return true;
        }
        return false;
    }

    private engageWheelBrakes(): void {
        this.wheelBrakeHeld = true;
        this.wheelBrakes = true;
        if (this.pitchState === Stick.NEGATIVE) {
            this.pitchState = Stick.IDLE;
            this.pitch = 0;
        }
        if (this.throttleState === Stick.POSITIVE) {
            this.throttleState = Stick.IDLE;
        }
    }

    private releaseWheelBrakes(): void {
        this.wheelBrakeHeld = false;
        this.wheelBrakes = false;
    }

    private restoreLayoutActionForKey(key: string): void {
        if (key === this.layout[KeyboardControlAction.PITCH_NEG]) {
            this.pitchState = Stick.NEGATIVE;
        } else if (key === this.layout[KeyboardControlAction.THROTTLE_POS]) {
            this.throttleState = Stick.POSITIVE;
        }
    }

    private isLayoutKey(key: string): boolean {
        return Object.values(this.layout).includes(key);
    }

    private clearSticks(): void {
        this.pitchState = Stick.IDLE;
        this.pitchHoldSeconds = 0;
        this.pitchUnitAccum = 0;
        this.rollState = Stick.IDLE;
        this.yawState = Stick.IDLE;
        this.throttleState = Stick.IDLE;
        this.wKeyDown = false;
        this.firing = false;
        this.releaseWheelBrakes();
    }

    private neutralInputs(firing: boolean, sink: SimPlayerInputSink): SimControlInputs {
        return {
            pitch: 0, roll: 0, yaw: 0, throttle: 0,
            landingGearDeployed: true, flapsExtended: true, airbrakesExtended: false,
            // Keep the hook where the pilot left it: dropping it here would
            // shed a latched wire whenever input is disabled mid-trap.
            hookDeployed: sink.isHookDeployed(),
            wheelBrakesApplied: false,
            pitchLimiterMode: this.pitchLimiterMode,
            limitersEnabled: this.limitersEnabled,
            wantForceVectors: this.forceVectorsRequested,
            firing,
        };
    }
}

/** Whether an FM2 config uses afterburner throttle detents. */
export function fm2UsesAfterburner(config: Fm2AircraftConfig | undefined): boolean {
    return config?.engine.afterburner ?? false;
}

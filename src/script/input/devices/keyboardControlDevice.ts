import { KernelTask } from "../../core/kernel";
import { isOverlayKeyEvent } from "../overlayKeys";
import { CombatSimClient } from "../../physics/sim/combatSimClient";
import { SimProxyFlightModel } from "../../physics/model/simProxyFlightModel";
import { PLAYER_SIM_ID } from "../../physics/sim/simIds";
import { FlightModel } from "../../physics/model/flightModel";
import {
    PITCH_STICK_BASE_UNIT_RATE,
    PITCH_STICK_MAX_UNIT_RATE,
    PITCH_STICK_UNIT_ACCEL,
    THROTTLE_RATE,
} from "../../defs";
import { PlayerEntity } from "../../scene/entities/player";
import {
    KeyboardControlAction,
    KeyboardControlLayout,
    KeyboardControlLayoutId,
    KeyboardControlLayouts,
    KeyboardPitchStickMode,
    getKeyboardLayout,
} from "../keyboardLayouts";

export {
    KeyboardControlAction,
    KeyboardControlLayoutId,
    KeyboardControlLayouts,
    KeyboardPitchStickMode,
} from "../keyboardLayouts";
export type { KeyboardControlLayout } from "../keyboardLayouts";

enum Stick {
    IDLE,
    POSITIVE_ENDED,
    NEGATIVE_ENDED,
    POSITIVE,
    NEGATIVE
};

/**
 * Captures keyboard events on the main thread and forwards them to the combat
 * sim worker. Stick/throttle integration runs in the worker; only raw key
 * down/up events cross the thread boundary (non-worker models keep the legacy
 * main-thread stick path).
 */
export class KeyboardControlDevice implements KernelTask {
    private pitchState: Stick = Stick.IDLE;
    private rollState: Stick = Stick.IDLE;
    private yawState: Stick = Stick.IDLE;
    private throttleState: Stick = Stick.IDLE;
    private wheelBrakeHeld = false;
    private wKeyDown = false;

    private layout: KeyboardControlLayout = getKeyboardLayout(KeyboardControlLayoutId.ARROWS);
    private layoutId: KeyboardControlLayoutId = KeyboardControlLayoutId.ARROWS;
    private pitchStickMode = KeyboardPitchStickMode.LAYOUT_DEFAULT;
    private pitchHoldSeconds = 0;
    private pitchUnitAccum = 0;
    private keysDown = new Set<string>();

    constructor(
        private readonly combatSim: CombatSimClient,
        private readonly player: PlayerEntity,
        private readonly simId: string = PLAYER_SIM_ID,
        private readonly isWorkerControlled: () => boolean = () =>
            player.getFlightModel() instanceof SimProxyFlightModel,
    ) {
        this.setupInput();
        this.combatSim.setKeyboardLayout(this.layoutId);
    }

    private usesSteppedPitchStick(): boolean {
        return this.layoutId === KeyboardControlLayoutId.ARROWS
            && this.pitchStickMode !== KeyboardPitchStickMode.HOLD;
    }

    update(delta: number) {
        if (this.isWorkerControlled()) {
            return;
        }
        this.updateLegacyMainThread(delta);
    }

    setKeyboardLayout(layoutId: KeyboardControlLayoutId) {
        this.layoutId = layoutId;
        this.layout = getKeyboardLayout(layoutId);
        this.combatSim.setKeyboardLayout(layoutId);
    }

    getKeyboardLayoutId(): KeyboardControlLayoutId {
        return this.layoutId;
    }

    setKeyboardPitchStickMode(mode: KeyboardPitchStickMode) {
        this.pitchStickMode = mode;
        this.pitchState = Stick.IDLE;
        if (!this.isWorkerControlled()) {
            this.player.setPitch(0);
        }
        this.combatSim.setKeyboardPitchStickMode(mode);
    }

    getKeyboardPitchStickMode(): KeyboardPitchStickMode {
        return this.pitchStickMode;
    }

    private setupInput() {
        document.addEventListener('keydown', (event: KeyboardEvent) => {
            if (isOverlayKeyEvent(event)) {
                return;
            }
            const key = normalizeControlKey(event);
            if (this.isLayoutKey(key) && (key.startsWith('arrow') || key.startsWith('numpad'))) {
                event.preventDefault();
            }
            if (event.repeat && this.isLayoutKey(key)) {
                return;
            }
            if (this.isWorkerControlled()) {
                if (!this.player.controlsEnabled) {
                    return;
                }
                this.combatSim.postKeyDown(this.simId, key, event.repeat);
                return;
            }
            this.keysDown.add(key);
            if (this.handleWheelBrakeKeyDown(key)) {
                return;
            }
            if (key === 'w') {
                this.wKeyDown = true;
            }
            this.handleLegacyKeyDown(key);
        });

        document.addEventListener('keyup', (event: KeyboardEvent) => {
            const key = normalizeControlKey(event);
            if (this.isWorkerControlled()) {
                this.combatSim.postKeyUp(this.simId, key);
                return;
            }
            this.keysDown.delete(key);
            if (this.handleWheelBrakeKeyUp(key)) {
                return;
            }
            if (key === 'w') {
                this.wKeyDown = false;
            }
            this.handleLegacyKeyUp(key);
        });

        window.addEventListener('blur', () => {
            if (this.isWorkerControlled()) {
                this.combatSim.postInputBlur(this.simId);
                return;
            }
            this.keysDown.clear();
            this.pitchState = Stick.IDLE;
            this.pitchHoldSeconds = 0;
            this.pitchUnitAccum = 0;
            this.rollState = Stick.IDLE;
            this.yawState = Stick.IDLE;
            this.throttleState = Stick.IDLE;
            this.wKeyDown = false;
            this.releaseWheelBrakes();
        });
    }

    /** Legacy main-thread stick integration for non-worker models. */
    private updateLegacyMainThread(delta: number) {
        if (!this.player.controlsEnabled || this.player.isAutopilotEnabled) {
            return;
        }
        if (this.wKeyDown && this.canApplyWheelBrakes()) {
            if (!this.wheelBrakeHeld) {
                this.engageWheelBrakes();
            }
        } else if (this.wheelBrakeHeld && !(this.wKeyDown && this.canApplyWheelBrakes())) {
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
                    this.player.setPitch(0.0);
                    break;
                case Stick.NEGATIVE:
                    this.player.setPitch(-1.0);
                    break;
                case Stick.POSITIVE:
                    this.player.setPitch(1.0);
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
                    this.player.stepPitchStickUnits(steps);
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
                    this.player.setRoll(0.0);
                    break;
                case Stick.NEGATIVE:
                    this.player.setRoll(-1.0);
                    break;
                case Stick.POSITIVE:
                    this.player.setRoll(1.0);
                    break;
            }
        }

        if (this.yawState !== Stick.IDLE) {
            switch (this.yawState) {
                case Stick.POSITIVE_ENDED:
                case Stick.NEGATIVE_ENDED:
                    this.yawState = Stick.IDLE;
                    this.player.setYaw(0.0);
                    break;
                case Stick.NEGATIVE:
                    this.player.setYaw(-1.0);
                    break;
                case Stick.POSITIVE:
                    this.player.setYaw(1.0);
                    break;
            }
        }

        if (this.throttleState !== Stick.IDLE) {
            const isPositive = this.throttleState === Stick.POSITIVE || this.throttleState === Stick.POSITIVE_ENDED;
            const step = delta * 0.01 * (isPositive ? THROTTLE_RATE : -THROTTLE_RATE);
            const skipContinuousInAbBand = this.player.useAfterburnerThrottleDetents() &&
                this.player.isInThrottleAbDetentBand() && isPositive;
            if (this.throttleState === Stick.POSITIVE_ENDED || this.throttleState === Stick.NEGATIVE_ENDED) {
                this.throttleState = Stick.IDLE;
            }
            if (!skipContinuousInAbBand) {
                this.player.adjustThrottle(step);
            }
        }
    }

    private handleLegacyKeyDown(key: string) {
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
                if (this.player.useAfterburnerThrottleDetents() && this.player.isInThrottleAbDetentBand()) {
                    this.player.stepThrottle(1);
                } else {
                    this.throttleState = Stick.POSITIVE;
                }
                break;
            case this.layout[KeyboardControlAction.THROTTLE_NEG]:
                if (this.player.useAfterburnerThrottleDetents() && this.player.throttleUnit >= 0.99) {
                    this.player.stepThrottle(-1);
                } else {
                    this.throttleState = Stick.NEGATIVE;
                }
                break;
        }
    }

    private handleLegacyKeyUp(key: string) {
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

    private latchPitch(direction: Stick.POSITIVE | Stick.NEGATIVE) {
        this.pitchState = direction;
        if (this.usesSteppedPitchStick()) {
            this.pitchHoldSeconds = 0;
            this.pitchUnitAccum = 0;
            this.player.stepPitchStickUnits(direction === Stick.POSITIVE ? 1 : -1);
        }
    }

    private isActionKeyHeld(action: KeyboardControlAction): boolean {
        return this.keysDown.has(this.layout[action]);
    }

    private canApplyWheelBrakes(): boolean {
        return this.player.isLanded || this.player.isOnGround;
    }

    private handleWheelBrakeKeyDown(key: string): boolean {
        if (key !== 'w' || !this.canApplyWheelBrakes()) {
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

    private engageWheelBrakes() {
        this.wheelBrakeHeld = true;
        this.player.setWheelBrakes(true);
        if (this.pitchState === Stick.NEGATIVE) {
            this.pitchState = Stick.IDLE;
            this.player.setPitch(0);
        }
        if (this.throttleState === Stick.POSITIVE) {
            this.throttleState = Stick.IDLE;
        }
    }

    private releaseWheelBrakes() {
        this.wheelBrakeHeld = false;
        this.player.setWheelBrakes(false);
    }

    private restoreLayoutActionForKey(key: string) {
        if (key === this.layout[KeyboardControlAction.PITCH_NEG]) {
            this.pitchState = Stick.NEGATIVE;
        } else if (key === this.layout[KeyboardControlAction.THROTTLE_POS]) {
            this.throttleState = Stick.POSITIVE;
        }
    }

    private isLayoutKey(key: string) {
        return Object.values(this.layout).includes(key);
    }
}

function normalizeControlKey(event: KeyboardEvent): string {
    switch (event.code) {
        case 'NumpadAdd': return 'numpadadd';
        case 'NumpadSubtract': return 'numpadsubtract';
        default: return event.key.toLowerCase();
    }
}

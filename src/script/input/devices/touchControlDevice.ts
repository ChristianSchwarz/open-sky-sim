import { KernelTask } from "../../core/kernel";
import { CombatSimClient } from "../../physics/sim/combatSimClient";
import { SimProxyFlightModel } from "../../physics/model/simProxyFlightModel";
import { PLAYER_SIM_ID } from "../../physics/sim/simIds";
import { PlayerEntity } from "../../scene/entities/player";
import { clamp, equals } from "../../utils/math";
import type { TouchControlsMode } from "../../config/settingsStorage";
import { AUTOPILOT_KEY, WHEEL_BRAKE_ONLY_KEY } from "../keyboardLayouts";
import { TiltAngles, tiltAngles, tiltStick, upFromGravity, upInScreen } from "../tiltAxes";
import { TouchStartGate } from "../touchStartGate";

/** Stick throw in CSS pixels from centre to full deflection. */
const STICK_RADIUS_PX = 64;
/** Share of the throw around centre that reads as zero; a thumb has no detent. */
const STICK_DEAD_ZONE = 0.06;
/** Cubic share of the response curve: fine near centre, full throw at the edge. */
const STICK_EXPO = 0.4;
/** How long tilt waits for orientation readings before falling back to the accelerometer. */
const TILT_ORIENTATION_GRACE_MS = 500;
/** How long tilt waits for any reading before it gives up and says so. */
const TILT_NO_SENSOR_MS = 3000;
/** Share of each accelerometer reading taken into the up vector (~60 Hz: about 0.1 s lag). */
const TILT_GRAVITY_SMOOTHING = 0.15;

/** What the game must answer for the overlay; Game implements it. */
export interface TouchControlHost {
    isFlying(): boolean;
    cycleTouchView(): void;
}

export interface HoldButton {
    label: string;
    key: string;
    hold: boolean;
    /** Always on screen; the others sit in the panel the MORE button opens. */
    primary?: boolean;
}

// None of these may be a stick key in any layout (keyboardLayouts.test.ts):
// a button press is a key press, and the worker runs the layout keys on it too.
// So BRAKE presses the brake-only key, not the keyboard's 'w'.
export const TOUCH_BUTTONS: readonly HoldButton[] = [
    { label: 'FIRE', key: ' ', hold: true, primary: true },
    { label: 'BRAKE', key: WHEEL_BRAKE_ONLY_KEY, hold: true, primary: true },
    { label: 'GEAR', key: 'g', hold: false },
    { label: 'FLAPS', key: 'f', hold: false },
    { label: 'AIRBRK', key: 'b', hold: false },
    { label: 'HOOK', key: 'h', hold: false },
    { label: 'AP', key: AUTOPILOT_KEY, hold: false },
    { label: 'TGT', key: 't', hold: false },
];

/**
 * On-screen flight controls for touch screens: a stick that springs back
 * under the left thumb, a throttle that stays where it is left and a rudder
 * strip on the right, and buttons for the aircraft's keys: FIRE and BRAKE
 * always, the rest behind a MORE button on top of the throttle. TILT, among
 * them, flies pitch and roll by tilting the phone instead of the stick.
 *
 * The analog controls post their own axes to the worker (a real gamepad still
 * wins over them, and they over the keyboard); the buttons press the same keys
 * the keyboard does, so every key handler sees them unchanged, except BRAKE,
 * whose key brakes without the stick key that shares 'w'. Built on Pointer
 * Events, so a mouse drives it as well as a finger.
 */
export class TouchControlDevice implements KernelTask {

    private readonly root: HTMLDivElement;
    private readonly stickBase: HTMLDivElement;
    private readonly stickKnob: HTMLDivElement;
    private readonly throttleFill: HTMLDivElement;
    private readonly throttleTrack: HTMLDivElement;
    private readonly rudderKnob: HTMLDivElement;
    private readonly rudderTrack: HTMLDivElement;
    private readonly morePanel: HTMLDivElement;
    private readonly moreButton: HTMLDivElement;
    private moreOpen = false;

    /** Tilt steering: pitch and roll from how the phone is held, while no thumb is on the stick. */
    private readonly tiltButton: HTMLDivElement;
    private tiltOn = false;
    /** Where the phone was held when tilt was switched on; taken from the first reading. */
    private tiltNeutral: TiltAngles | undefined;
    private tiltPitch = 0;
    private tiltRoll = 0;
    /**
     * Where the readings come from: the fused orientation where the phone has
     * a gyroscope, else the accelerometer's gravity. Decided by the first
     * reading, since the two need not agree on signs and the centre is per source.
     */
    private tiltSource: 'orientation' | 'motion' | undefined;
    /** Smoothed up vector from the accelerometer, which also feels the hand's shake. */
    private tiltGravityUp: [number, number, number] | undefined;
    private tiltStartedAt = 0;
    private readonly onOrientation = (event: DeviceOrientationEvent) => this.readOrientation(event);
    private readonly onMotion = (event: DeviceMotionEvent) => this.readMotion(event);

    private mode: TouchControlsMode = 'auto';
    private readonly coarsePointer = window.matchMedia('(pointer: coarse)');
    private visible = false;

    /** Whether the analog controls have been taken since the last spawn or pause. */
    private active = false;
    private stickPointer: number | undefined;
    private stickOriginX = 0;
    private stickOriginY = 0;
    private throttlePointer: number | undefined;
    private rudderPointer: number | undefined;
    /** Lets go of every held button, for blur and for hiding the overlay mid-press. */
    private readonly heldReleases: (() => void)[] = [];

    private pitch = 0;
    private roll = 0;
    private yaw = 0;
    private throttle = 0;

    private lastPitch = NaN;
    private lastRoll = NaN;
    private lastYaw = NaN;
    private lastThrottle = NaN;
    private lastPostedActive = false;

    constructor(
        private readonly combatSim: CombatSimClient,
        private readonly player: PlayerEntity,
        private readonly host: TouchControlHost,
        private readonly gate: TouchStartGate,
        private readonly simId: string = PLAYER_SIM_ID,
        private readonly isWorkerControlled: () => boolean = () =>
            player.getFlightModel() instanceof SimProxyFlightModel,
    ) {
        this.root = div('position:fixed;inset:0;z-index:1;pointer-events:none;display:none;'
            + 'user-select:none;-webkit-user-select:none;font:600 12px/1 sans-serif;color:white');

        // The stick zone is the left side, lifted off the bottom edge where a thumb
        // held sideways does not reach; the stick appears where the thumb lands.
        const stickZone = div('position:absolute;left:0;bottom:20%;width:45%;height:65%;'
            + 'pointer-events:auto;touch-action:none');
        this.stickBase = div('position:absolute;display:none;'
            + `width:${STICK_RADIUS_PX * 2}px;height:${STICK_RADIUS_PX * 2}px;`
            + `margin:-${STICK_RADIUS_PX}px 0 0 -${STICK_RADIUS_PX}px;border-radius:50%;`
            + 'border:2px solid rgba(255,255,255,0.5);background:rgba(0,0,0,0.2)');
        this.stickKnob = div('position:absolute;left:50%;top:50%;width:48px;height:48px;'
            + 'margin:-24px 0 0 -24px;border-radius:50%;background:rgba(255,255,255,0.6)');
        this.stickBase.appendChild(this.stickKnob);
        stickZone.appendChild(this.stickBase);
        const stickHint = div('position:absolute;left:24px;top:50%;opacity:0.5', 'STICK');
        stickZone.appendChild(stickHint);
        this.root.appendChild(stickZone);
        this.bindStick(stickZone);

        // Throttle: a vertical track against the right edge, full power at the top.
        this.throttleTrack = div('position:absolute;right:16px;bottom:72px;width:52px;height:40%;'
            + 'border:2px solid rgba(255,255,255,0.5);border-radius:8px;background:rgba(0,0,0,0.25);'
            + 'pointer-events:auto;touch-action:none;overflow:hidden');
        this.throttleFill = div('position:absolute;left:0;right:0;bottom:0;height:0;'
            + 'background:rgba(255,255,255,0.45)');
        this.throttleTrack.appendChild(this.throttleFill);
        this.throttleTrack.appendChild(div('position:absolute;left:0;right:0;top:6px;text-align:center', 'THR'));
        this.root.appendChild(this.throttleTrack);
        this.bindThrottle();

        // Rudder: a horizontal strip under the throttle that springs back.
        this.rudderTrack = div('position:absolute;right:16px;bottom:16px;width:200px;height:44px;'
            + 'border:2px solid rgba(255,255,255,0.5);border-radius:22px;background:rgba(0,0,0,0.25);'
            + 'pointer-events:auto;touch-action:none');
        this.rudderKnob = div('position:absolute;left:50%;top:50%;width:36px;height:36px;'
            + 'margin:-18px 0 0 -18px;border-radius:50%;background:rgba(255,255,255,0.6)');
        this.rudderTrack.appendChild(this.rudderKnob);
        this.root.appendChild(this.rudderTrack);
        this.bindRudder();

        // Buttons: FIRE and BRAKE always, in a row left of the throttle; the
        // aircraft's other keys in a panel above them that MORE opens and closes,
        // so the view stays clear until they are wanted.
        const primary = div('position:absolute;right:80px;bottom:72px;display:flex;gap:6px;'
            + 'pointer-events:auto;touch-action:none');
        this.morePanel = div('position:absolute;right:80px;bottom:114px;display:none;'
            + 'grid-template-columns:repeat(4,52px);gap:6px;pointer-events:auto;touch-action:none');
        for (const spec of TOUCH_BUTTONS) {
            (spec.primary ? primary : this.morePanel).appendChild(this.makeKeyButton(spec));
        }
        // A click, not a pointerdown: iOS grants the motion-sensor permission
        // only from a gesture that has ended. And no preventDefault on the
        // pointerdown, which in Safari can cancel that click.
        this.tiltButton = button('TILT');
        this.tiltButton.addEventListener('click', () => this.setTiltOn(!this.tiltOn));
        this.morePanel.appendChild(this.tiltButton);
        const view = button('VIEW');
        view.addEventListener('pointerdown', event => {
            event.preventDefault();
            this.host.cycleTouchView();
        });
        this.morePanel.appendChild(view);
        // No fullscreen button: on a touch screen the game is always
        // fullscreen, and the next touch would only put it back (touchStartGate.ts).
        this.root.appendChild(primary);
        this.root.appendChild(this.morePanel);

        // MORE: on top of the throttle track, where the right thumb already is.
        this.moreButton = button('MORE');
        this.moreButton.style.position = 'absolute';
        this.moreButton.style.right = '16px';
        this.moreButton.style.bottom = 'calc(72px + 40% + 8px)';
        this.moreButton.style.pointerEvents = 'auto';
        this.moreButton.style.touchAction = 'none';
        this.moreButton.addEventListener('pointerdown', event => {
            event.preventDefault();
            this.setMoreOpen(!this.moreOpen);
        });
        this.root.appendChild(this.moreButton);

        document.body.appendChild(this.root);
        this.coarsePointer.addEventListener('change', () => this.updateVisibility());
        window.addEventListener('blur', () => this.releaseAll());
        // Nothing stays held under the turn-it-sideways screen.
        this.gate.onBlock = () => this.releaseAll();
    }

    private setMoreOpen(open: boolean): void {
        this.moreOpen = open;
        this.morePanel.style.display = open ? 'grid' : 'none';
        this.moreButton.style.background = open ? BUTTON_PRESSED : BUTTON_BACKGROUND;
    }

    /**
     * Switches tilt steering. Switching it on takes the way the phone is held
     * now as centre stick; switch it off and on again to re-centre.
     */
    private setTiltOn(on: boolean, why?: string): void {
        if (on) {
            // iOS sends no readings until this is granted; asked in the same click.
            // Where the browser has the call but sends readings anyway (or never
            // answers), tilt is already on: only a refusal switches it off again.
            for (const type of [DeviceOrientationEvent, window.DeviceMotionEvent]) {
                const withPermission = type as { requestPermission?: () => Promise<'granted' | 'denied'> } | undefined;
                withPermission?.requestPermission?.()
                    .then(answer => {
                        if (answer === 'denied' && this.tiltOn) {
                            this.setTiltOn(false, 'DENIED');
                        }
                    })
                    .catch(() => undefined);
            }
            this.tiltNeutral = undefined;
            this.tiltSource = undefined;
            this.tiltGravityUp = undefined;
            this.tiltStartedAt = performance.now();
            window.addEventListener('deviceorientation', this.onOrientation);
            window.addEventListener('devicemotion', this.onMotion);
        } else {
            window.removeEventListener('deviceorientation', this.onOrientation);
            window.removeEventListener('devicemotion', this.onMotion);
            if (this.stickPointer === undefined) {
                this.pitch = 0;
                this.roll = 0;
            }
        }
        this.tiltOn = on;
        this.tiltPitch = 0;
        this.tiltRoll = 0;
        this.tiltButton.style.background = on ? BUTTON_PRESSED : BUTTON_BACKGROUND;
        // Says why tilt went off again, until the next press; 'TILT' otherwise.
        this.tiltButton.textContent = why ?? 'TILT';
        this.tiltButton.style.fontSize = why ? '9px' : '11px';
    }

    private readOrientation(event: DeviceOrientationEvent): void {
        if (event.beta === null || event.gamma === null || this.tiltSource === 'motion') {
            return;
        }
        this.tiltSource = 'orientation';
        this.applyTilt(upInScreen(event.beta, event.gamma, screenAngle()));
    }

    private readMotion(event: DeviceMotionEvent): void {
        if (this.tiltSource === 'orientation') {
            return;
        }
        const g = event.accelerationIncludingGravity;
        const up = g && g.x !== null && g.y !== null && g.z !== null
            ? upFromGravity(g.x, g.y, g.z, screenAngle())
            : null;
        if (up === null) {
            return;
        }
        // Give a gyroscope's orientation readings the first moment to arrive:
        // they are steadier, and only phones without one fall back to this.
        if (this.tiltSource === undefined) {
            if (performance.now() - this.tiltStartedAt < TILT_ORIENTATION_GRACE_MS) {
                return;
            }
            this.tiltSource = 'motion';
        }
        const previous = this.tiltGravityUp;
        this.tiltGravityUp = previous === undefined ? up : [
            previous[0] + (up[0] - previous[0]) * TILT_GRAVITY_SMOOTHING,
            previous[1] + (up[1] - previous[1]) * TILT_GRAVITY_SMOOTHING,
            previous[2] + (up[2] - previous[2]) * TILT_GRAVITY_SMOOTHING,
        ];
        this.applyTilt(this.tiltGravityUp);
    }

    private applyTilt(up: readonly [number, number, number]): void {
        const angles = tiltAngles(up);
        this.tiltNeutral ??= angles;
        const stick = tiltStick(angles, this.tiltNeutral);
        this.tiltPitch = shapeAxis(stick.pitch);
        this.tiltRoll = shapeAxis(stick.roll);
    }

    setMode(mode: TouchControlsMode): void {
        this.mode = mode;
        this.updateVisibility();
        this.gate.setMode(mode);
    }

    getMode(): TouchControlsMode {
        return this.mode;
    }

    update(_delta: number): void {
        this.updateVisibility();
        if (this.tiltOn && this.tiltSource === undefined
            && performance.now() - this.tiltStartedAt > TILT_NO_SENSOR_MS) {
            // No browser says it has no sensors; it just never sends a reading.
            this.setTiltOn(false, 'NO SENSOR');
        }
        if (!this.visible || !this.player.controlsEnabled || this.player.isAutopilotEnabled
            || this.player.isCrashed) {
            // Next time the controls are taken the throttle starts from the aircraft's.
            this.deactivate();
            return;
        }
        // The thumb on the stick wins over the tilt; the tilt takes the controls
        // like a touch does, once it has a centre to measure from.
        if (this.tiltOn && this.tiltNeutral !== undefined && this.stickPointer === undefined) {
            this.activate();
            this.pitch = this.tiltPitch;
            this.roll = this.tiltRoll;
        }
        if (!this.active) {
            this.throttle = clamp(this.player.throttleUnit, 0, 1);
            this.drawThrottle();
            return;
        }
        this.post();
    }

    private updateVisibility(): void {
        const visible = this.wanted() && this.host.isFlying();
        if (visible === this.visible) {
            return;
        }
        this.visible = visible;
        this.root.style.display = visible ? 'block' : 'none';
        if (!visible) {
            this.releaseAll();
        }
    }

    private wanted(): boolean {
        return this.mode === 'on' || (this.mode === 'auto' && this.coarsePointer.matches);
    }

    private activate(): void {
        if (this.active) {
            return;
        }
        this.active = true;
        this.throttle = clamp(this.player.throttleUnit, 0, 1);
        this.drawThrottle();
    }

    private deactivate(): void {
        this.active = false;
        this.pitch = 0;
        this.roll = 0;
        this.yaw = 0;
        if (this.lastPostedActive && this.isWorkerControlled()) {
            this.combatSim.postTouchAxes(this.simId, 0, 0, 0, 0, false);
        }
        this.lastPostedActive = false;
        this.lastPitch = NaN;
        this.lastRoll = NaN;
        this.lastYaw = NaN;
        this.lastThrottle = NaN;
    }

    private post(): void {
        if (this.lastPostedActive
            && equals(this.pitch, this.lastPitch)
            && equals(this.roll, this.lastRoll)
            && equals(this.yaw, this.lastYaw)
            && equals(this.throttle, this.lastThrottle)) {
            return;
        }
        this.lastPitch = this.pitch;
        this.lastRoll = this.roll;
        this.lastYaw = this.yaw;
        this.lastThrottle = this.throttle;
        this.lastPostedActive = true;
        if (this.isWorkerControlled()) {
            this.combatSim.postTouchAxes(this.simId, this.pitch, this.roll, this.yaw, this.throttle, true);
        } else {
            this.player.setPitch(this.pitch);
            this.player.setRoll(this.roll);
            this.player.setYaw(this.yaw);
            this.player.setThrottle(this.throttle);
        }
    }

    private bindStick(zone: HTMLElement): void {
        zone.addEventListener('pointerdown', event => {
            if (this.stickPointer !== undefined) {
                return;
            }
            event.preventDefault();
            capture(zone, event.pointerId);
            this.stickPointer = event.pointerId;
            const rect = zone.getBoundingClientRect();
            this.stickOriginX = event.clientX;
            this.stickOriginY = event.clientY;
            this.stickBase.style.left = `${event.clientX - rect.left}px`;
            this.stickBase.style.top = `${event.clientY - rect.top}px`;
            this.stickBase.style.display = 'block';
            this.activate();
            this.moveStick(event);
        });
        zone.addEventListener('pointermove', event => {
            if (event.pointerId === this.stickPointer) {
                this.moveStick(event);
            }
        });
        const end = (event: PointerEvent) => {
            if (event.pointerId === this.stickPointer) {
                this.releaseStick();
            }
        };
        zone.addEventListener('pointerup', end);
        zone.addEventListener('pointercancel', end);
    }

    private moveStick(event: PointerEvent): void {
        let dx = (event.clientX - this.stickOriginX) / STICK_RADIUS_PX;
        let dy = (event.clientY - this.stickOriginY) / STICK_RADIUS_PX;
        const length = Math.hypot(dx, dy);
        if (length > 1) {
            dx /= length;
            dy /= length;
        }
        this.stickKnob.style.transform = `translate(${dx * STICK_RADIUS_PX}px,${dy * STICK_RADIUS_PX}px)`;
        // Thumb toward you is stick back, nose up, as on a gamepad.
        this.pitch = shapeAxis(dy);
        this.roll = shapeAxis(dx);
    }

    private releaseStick(): void {
        this.stickPointer = undefined;
        this.stickBase.style.display = 'none';
        this.stickKnob.style.transform = '';
        this.pitch = 0;
        this.roll = 0;
    }

    private bindThrottle(): void {
        const track = this.throttleTrack;
        const set = (event: PointerEvent) => {
            const rect = track.getBoundingClientRect();
            this.throttle = clamp((rect.bottom - event.clientY) / rect.height, 0, 1);
            this.drawThrottle();
        };
        track.addEventListener('pointerdown', event => {
            event.preventDefault();
            capture(track, event.pointerId);
            this.throttlePointer = event.pointerId;
            this.activate();
            set(event);
        });
        track.addEventListener('pointermove', event => {
            if (event.pointerId === this.throttlePointer) {
                set(event);
            }
        });
        const end = (event: PointerEvent) => {
            if (event.pointerId === this.throttlePointer) {
                this.throttlePointer = undefined;
            }
        };
        track.addEventListener('pointerup', end);
        track.addEventListener('pointercancel', end);
    }

    private drawThrottle(): void {
        this.throttleFill.style.height = `${Math.round(this.throttle * 100)}%`;
    }

    private bindRudder(): void {
        const track = this.rudderTrack;
        const set = (event: PointerEvent) => {
            const rect = track.getBoundingClientRect();
            const x = clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
            this.rudderKnob.style.transform = `translateX(${x * (rect.width / 2 - 22)}px)`;
            this.yaw = shapeAxis(x);
        };
        track.addEventListener('pointerdown', event => {
            event.preventDefault();
            capture(track, event.pointerId);
            this.rudderPointer = event.pointerId;
            this.activate();
            set(event);
        });
        track.addEventListener('pointermove', event => {
            if (event.pointerId === this.rudderPointer) {
                set(event);
            }
        });
        const end = (event: PointerEvent) => {
            if (event.pointerId === this.rudderPointer) {
                this.releaseRudder();
            }
        };
        track.addEventListener('pointerup', end);
        track.addEventListener('pointercancel', end);
    }

    private releaseRudder(): void {
        this.rudderPointer = undefined;
        this.rudderKnob.style.transform = '';
        this.yaw = 0;
    }

    private makeKeyButton(spec: HoldButton): HTMLDivElement {
        const element = button(spec.label);
        let held = false;
        const release = () => {
            if (!held) {
                return;
            }
            held = false;
            element.style.background = BUTTON_BACKGROUND;
            pressKey('keyup', spec.key);
        };
        element.addEventListener('pointerdown', event => {
            event.preventDefault();
            if (spec.hold) {
                capture(element, event.pointerId);
                held = true;
                element.style.background = BUTTON_PRESSED;
                pressKey('keydown', spec.key);
            } else {
                pressKey('keydown', spec.key);
                pressKey('keypress', spec.key);
                pressKey('keyup', spec.key);
            }
        });
        element.addEventListener('pointerup', release);
        element.addEventListener('pointercancel', release);
        this.heldReleases.push(release);
        return element;
    }

    private releaseAll(): void {
        if (this.stickPointer !== undefined) {
            this.releaseStick();
        }
        if (this.rudderPointer !== undefined) {
            this.releaseRudder();
        }
        this.throttlePointer = undefined;
        for (const release of this.heldReleases) {
            release();
        }
    }
}

const BUTTON_BACKGROUND = 'rgba(0,0,0,0.35)';
const BUTTON_PRESSED = 'rgba(255,255,255,0.45)';

function div(cssText: string, text?: string): HTMLDivElement {
    const element = document.createElement('div');
    element.style.cssText = cssText;
    if (text !== undefined) {
        element.textContent = text;
    }
    return element;
}

function button(label: string): HTMLDivElement {
    return div('width:52px;height:36px;font-size:11px;display:flex;align-items:center;justify-content:center;'
        + `border:2px solid rgba(255,255,255,0.5);border-radius:8px;background:${BUTTON_BACKGROUND}`, label);
}

/** Keeps a drag on its control when the finger slides off it. */
function capture(element: HTMLElement, pointerId: number): void {
    try {
        element.setPointerCapture(pointerId);
    } catch {
        // A pointer that is no longer down cannot be captured; the drag still works inside.
    }
}

/** Dead zone, then a cubic blend, so small thumb movements fly smoothly. */
export function shapeAxis(value: number): number {
    const magnitude = Math.abs(value);
    if (magnitude <= STICK_DEAD_ZONE) {
        return 0;
    }
    const x = Math.min(1, (magnitude - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE));
    return Math.sign(value) * (STICK_EXPO * x * x * x + (1 - STICK_EXPO) * x);
}

/**
 * Presses a key as the keyboard would, on the document where every key
 * handler listens, so the buttons behave exactly like their keys.
 */
function pressKey(type: 'keydown' | 'keypress' | 'keyup', key: string): void {
    // A key no keyboard has (the brake-only one) has no physical code either.
    const code = key === ' ' ? 'Space' : key.length === 1 ? `Key${key.toUpperCase()}` : '';
    document.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
}

/** The screen's rotation in degrees (90: landscape with the device's top to the left). */
function screenAngle(): number {
    const angle = screen.orientation?.angle;
    if (angle !== undefined) {
        return angle;
    }
    // Older iOS: window.orientation, where landscape top-left is 90 and top-right -90.
    const legacy = (window as Window & { orientation?: number }).orientation;
    return legacy === undefined ? 0 : (legacy + 360) % 360;
}

import { KernelTask } from "../../core/kernel";
import { CombatSimClient } from "../../physics/sim/combatSimClient";
import { SimProxyFlightModel } from "../../physics/model/simProxyFlightModel";
import { PLAYER_SIM_ID } from "../../physics/sim/simIds";
import { PlayerEntity } from "../../scene/entities/player";
import { equals } from "../../utils/math";
import { GamepadAxisReader } from "../gamepadAxes";

/** Same value, NaN (an untaken throttle) included. */
function sameAxis(a: number, b: number): boolean {
    return Number.isNaN(a) ? Number.isNaN(b) : equals(a, b);
}

export type JoystickStatusListener = (connected: boolean) => void;

export class JoystickControlDevice implements KernelTask {

    private connected: boolean = false;
    private id: string = '';
    private index = 0;
    private axisCount: number = 0;
    private listener: JoystickStatusListener = () => { };

    private lastPitch: number = 0;
    private lastRoll: number = 0;
    private lastYaw: number = 0;
    private lastThrottle: number = 0;
    /** Last connected flag posted to the worker; avoids per-frame disconnect spam. */
    private lastPostedConnected = false;
    /** Dead zone, idle detection and the throttle's rest position (see gamepadAxes.ts). */
    private readonly reader = new GamepadAxisReader();
    /** Non-worker path: whether the pad's sticks are on the player's controls right now. */
    private legacyApplied = false;

    constructor(
        private readonly combatSim: CombatSimClient,
        private readonly player: PlayerEntity,
        private readonly simId: string = PLAYER_SIM_ID,
        private readonly isWorkerControlled: () => boolean = () =>
            player.getFlightModel() instanceof SimProxyFlightModel,
    ) {
        this.setupEvents();
    }

    update(_delta: number) {
        if (!this.player.controlsEnabled || this.player.isAutopilotEnabled) {
            this.postGamepadDisconnected();
            return;
        }

        if (this.isWorkerControlled()) {
            if (!this.connected) {
                this.postGamepadDisconnected();
                return;
            }
            const gamepad = navigator.getGamepads()[this.index];
            if (!gamepad) {
                this.postGamepadDisconnected();
                return;
            }
            const { pitch, roll, yaw, throttle, active } = this.read(gamepad);
            if (!active) {
                // An idle pad lets the keyboard (and touch) fly: the worker
                // takes a connected pad over both.
                this.postGamepadDisconnected();
                return;
            }
            if (
                !this.lastPostedConnected
                || !sameAxis(pitch, this.lastPitch)
                || !sameAxis(roll, this.lastRoll)
                || !sameAxis(yaw, this.lastYaw)
                || !sameAxis(throttle, this.lastThrottle)
            ) {
                this.lastPitch = pitch;
                this.lastRoll = roll;
                this.lastYaw = yaw;
                this.lastThrottle = throttle;
                this.lastPostedConnected = true;
                this.combatSim.postGamepadAxes(this.simId, pitch, roll, yaw, throttle, true);
            }
            return;
        }

        if (!this.connected) {
            this.releaseLegacySticks();
            return;
        }

        const gamepad = navigator.getGamepads()[this.index];
        if (!gamepad) {
            this.releaseLegacySticks();
            return;
        }

        const { pitch, roll, yaw, throttle, active } = this.read(gamepad);
        if (!active) {
            // Idle: centre what the pad last applied once, then leave the keys be.
            this.releaseLegacySticks();
            return;
        }
        if (!this.legacyApplied || !equals(yaw, this.lastYaw)) {
            this.lastYaw = yaw;
            this.player.setYaw(yaw);
        }
        if (Number.isFinite(throttle) && !equals(throttle, this.lastThrottle)) {
            this.lastThrottle = throttle;
            this.player.setThrottle(throttle);
        }
        if (!this.legacyApplied || !equals(pitch, this.lastPitch)) {
            this.lastPitch = pitch;
            this.player.setPitch(pitch);
        }
        if (!this.legacyApplied || !equals(roll, this.lastRoll)) {
            this.lastRoll = roll;
            this.player.setRoll(roll);
        }
        this.legacyApplied = true;
    }

    private read(gamepad: Gamepad) {
        return this.reader.read(gamepad.axes, gamepad.buttons.some(b => b.pressed));
    }

    /** Non-worker path: centre the sticks the pad was holding (idle or unplugged); the throttle stays. */
    private releaseLegacySticks(): void {
        const applied = this.legacyApplied;
        this.legacyApplied = false;
        if (!applied || this.isWorkerControlled()) {
            return;
        }
        this.lastPitch = 0;
        this.lastRoll = 0;
        this.lastYaw = 0;
        this.player.setPitch(0);
        this.player.setRoll(0);
        this.player.setYaw(0);
    }

    private postGamepadDisconnected(): void {
        if (!this.isWorkerControlled() || !this.lastPostedConnected) {
            return;
        }
        this.lastPostedConnected = false;
        this.lastPitch = 0;
        this.lastRoll = 0;
        this.lastYaw = 0;
        this.lastThrottle = 0;
        this.combatSim.postGamepadAxes(this.simId, 0, 0, 0, 0, false);
    }

    isConnected(): boolean {
        return this.connected;
    }

    getDeviceId(): string {
        return this.id;
    }

    getAxisCount(): number {
        return this.axisCount;
    }

    setListener(listener: JoystickStatusListener) {
        this.listener = listener;
    }

    private setupEvents() {
        window.addEventListener("gamepadconnected", event => {
            this.use(event.gamepad);
        });
        window.addEventListener("gamepaddisconnected", event => {
            // Another pad going away leaves the one flying alone.
            if (!this.connected || event.gamepad.index !== this.index) {
                return;
            }
            this.postGamepadDisconnected();
            this.releaseLegacySticks();
            this.connected = false;
            this.id = '';
            this.index = 0;
            this.axisCount = 0;
            this.lastPitch = 0;
            this.lastRoll = 0;
            this.lastYaw = 0;
            this.lastThrottle = 0;
            this.reader.reset();
            // Fly on with a pad still plugged in, if there is one.
            const other = [...navigator.getGamepads()]
                .find(g => g && g.connected && g.index !== event.gamepad.index);
            if (other) {
                this.use(other);
            } else {
                this.listener(false);
            }
        });
    }

    private use(gamepad: Gamepad): void {
        if (this.connected && gamepad.index !== this.index) {
            // Handing over from the old pad: its sticks must not stay applied.
            this.postGamepadDisconnected();
            this.releaseLegacySticks();
        }
        this.connected = true;
        this.id = gamepad.id;
        this.index = gamepad.index;
        this.axisCount = gamepad.axes.length;
        this.reader.reset();
        this.listener(true);
    }
}

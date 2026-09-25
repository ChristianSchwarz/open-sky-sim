/**
 * FM3 surface actuators: each channel follows its command through a
 * first-order lag, a rate limit and position limits, writing straight into
 * the aerodynamic model's control array.
 */
import { CHANNEL_INDEX, Fm3Airframe, FM3_CHANNELS } from './fm3Airframe';

export class Fm3Actuators {
    readonly command = new Float64Array(FM3_CHANNELS.length);
    private readonly min = new Float64Array(FM3_CHANNELS.length);
    private readonly max = new Float64Array(FM3_CHANNELS.length);
    private readonly rate = new Float64Array(FM3_CHANNELS.length);
    private readonly tau = new Float64Array(FM3_CHANNELS.length);
    private readonly present = new Uint8Array(FM3_CHANNELS.length);

    /** @param position The array the deflections are written into (the aero model's controls). */
    constructor(airframe: Fm3Airframe, readonly position: Float64Array) {
        for (const a of airframe.actuators) {
            const i = CHANNEL_INDEX[a.channel];
            this.min[i] = a.min;
            this.max[i] = a.max;
            this.rate[i] = a.rate;
            this.tau[i] = a.tau;
            this.present[i] = 1;
        }
    }

    reset(): void {
        this.command.fill(0);
        for (let i = 0; i < this.position.length; i++) {
            this.position[i] = this.present[i] ? Math.min(this.max[i], Math.max(this.min[i], 0)) : 0;
        }
    }

    /** Put every surface exactly at its (limited) command, e.g. for a spawn. */
    snap(): void {
        for (let i = 0; i < this.position.length; i++) {
            if (!this.present[i]) continue;
            this.position[i] = Math.min(this.max[i], Math.max(this.min[i], this.command[i]));
        }
    }

    update(dt: number): void {
        for (let i = 0; i < this.position.length; i++) {
            if (!this.present[i]) {
                this.position[i] = 0;
                continue;
            }
            const cmd = Math.min(this.max[i], Math.max(this.min[i], this.command[i]));
            const pos = this.position[i];
            let next = this.tau[i] > 0 ? pos + (cmd - pos) * (1 - Math.exp(-dt / this.tau[i])) : cmd;
            const maxStep = this.rate[i] * dt;
            if (next - pos > maxStep) next = pos + maxStep;
            else if (pos - next > maxStep) next = pos - maxStep;
            this.position[i] = next;
        }
    }
}

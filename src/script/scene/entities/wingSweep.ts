import * as THREE from 'three';
import { FlyableAircraftDef, SwingWingsConfig } from './aircraftDef';

/**
 * Visual wing sweep for variable-geometry aircraft (F-14, Su-17/22...).
 * Render-only: the flight model is unaffected.
 *
 * The sweep value is normalised: 0 = wings fully spread, 1 = fully swept.
 */

const KNOTS_TO_MPS = 0.514444;

/** Used when an aircraft carries sweep surfaces but no schedule of its own. */
const DEFAULT_SWING_WINGS: SwingWingsConfig = { minKias: 400, maxKias: 500, travelSeconds: 6 };

/** Pilot's wing-sweep selection: schedule against airspeed, or hold a position. */
export enum WingSweepMode {
    AUTO,
    SPREAD,
    SWEPT,
}

/** The next mode in the AUTO -> SPREAD -> SWEPT cycle. */
export function nextWingSweepMode(mode: WingSweepMode): WingSweepMode {
    return (mode + 1) % 3;
}

/**
 * Target sweep for a mode; AUTO follows the mod's speed schedule. `airspeed` is
 * the true speed (m/s), used as the indicated speed.
 */
export function wingSweepTarget(
    mode: WingSweepMode, airspeed: number, cfg: SwingWingsConfig = DEFAULT_SWING_WINGS,
): number {
    switch (mode) {
        case WingSweepMode.SPREAD: return 0;
        case WingSweepMode.SWEPT: return 1;
        default: {
            const kias = airspeed / KNOTS_TO_MPS;
            const span = Math.max(cfg.maxKias - cfg.minKias, 1e-3);
            return Math.min(1, Math.max(0, (kias - cfg.minKias) / span));
        }
    }
}

/** Slew the current sweep toward the target at the wing actuator's rate. */
export function stepWingSweep(
    current: number, target: number, delta: number, cfg: SwingWingsConfig = DEFAULT_SWING_WINGS,
): number {
    const maxStep = delta / Math.max(cfg.travelSeconds, 1e-3);
    const diff = target - current;
    return Math.abs(diff) <= maxStep ? target : current + Math.sign(diff) * maxStep;
}

/** A hinge in the aircraft body frame, plus how far it is turned (rad). */
export interface SurfaceHinge {
    pivot: THREE.Vector3;
    axis: THREE.Vector3;
    deflection: number;
}

const _sweepQ = new THREE.Quaternion();
const _hingeQ = new THREE.Quaternion();
const _hingeAxis = new THREE.Vector3();
const _hingePivot = new THREE.Vector3();

/**
 * World pose of a hinge-pivoted surface model. A surface mounted on a sweeping
 * wing (`parent`) is first carried round the wing's pivot, taking its own hinge
 * pivot and axis with it, then deflected about that moved hinge.
 */
export function poseSurface(
    hinge: SurfaceHinge,
    parent: SurfaceHinge | undefined,
    displayPosition: THREE.Vector3,
    displayQuaternion: THREE.Quaternion,
    outPosition: THREE.Vector3,
    outQuaternion: THREE.Quaternion,
): void {
    _hingeAxis.copy(hinge.axis);
    _hingePivot.copy(hinge.pivot);
    if (parent && parent.deflection !== 0) {
        _sweepQ.setFromAxisAngle(parent.axis, parent.deflection);
        _hingeAxis.applyQuaternion(_sweepQ);
        _hingePivot.sub(parent.pivot).applyQuaternion(_sweepQ).add(parent.pivot);
        _hingeQ.setFromAxisAngle(_hingeAxis, hinge.deflection).multiply(_sweepQ);
    } else {
        _hingeQ.setFromAxisAngle(_hingeAxis, hinge.deflection);
    }
    outQuaternion.copy(displayQuaternion).multiply(_hingeQ);
    outPosition.copy(_hingePivot).applyQuaternion(displayQuaternion).add(displayPosition);
}

/** A wingtip (spread position) riding on a sweeping wing. */
export interface TipSweep {
    spread: THREE.Vector3;
    pivot: THREE.Vector3;
    axis: THREE.Vector3;
    /** Radians of rotation per unit of sweep (sign folded in). */
    radPerUnit: number;
}

/**
 * For each wingtip [left, right] of a swing-wing aircraft, the sweep surface it
 * rides on: the wing on the same side (largest travel, so not a glove fairing).
 * Null when the aircraft has no sweep surfaces or no tips.
 */
export function tipSweepsFromDef(def: FlyableAircraftDef): [TipSweep, TipSweep] | null {
    const tips = def.fx?.wingtips;
    if (!tips || tips.length < 2) {
        return null;
    }
    const wings = def.surfaces.filter(s => s.control === 'sweep' && !s.sweepParent);
    const build = (tip: [number, number, number]): TipSweep | null => {
        let best: (typeof wings)[number] | undefined;
        for (const w of wings) {
            if (Math.sign(w.pivot[0]) === Math.sign(tip[0]) && (!best || w.rangeRad > best.rangeRad)) {
                best = w;
            }
        }
        return best ? {
            spread: new THREE.Vector3().fromArray(tip),
            pivot: new THREE.Vector3().fromArray(best.pivot),
            axis: new THREE.Vector3().fromArray(best.axis),
            radPerUnit: best.sign * best.rangeRad,
        } : null;
    };
    const left = build(tips[0]);
    const right = build(tips[1]);
    return left && right ? [left, right] : null;
}

/** The tip's body-frame position at `sweepUnit` [0,1]. */
export function sweptTip(out: THREE.Vector3, tip: TipSweep, sweepUnit: number): THREE.Vector3 {
    _sweepQ.setFromAxisAngle(tip.axis, tip.radPerUnit * sweepUnit);
    return out.copy(tip.spread).sub(tip.pivot).applyQuaternion(_sweepQ).add(tip.pivot);
}

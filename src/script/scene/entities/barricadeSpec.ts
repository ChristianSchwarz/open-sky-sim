/**
 * Carrier emergency barricade: layout, world field and engagement test.
 *
 * The real thing (NAVEDTRA 14310 via Wikipedia "Arresting gear"): two
 * stanchions hinge up out of deck recesses and hold a nylon webbing about
 * 20 ft (6.1 m) high across the landing area. The webbing is an upper and a
 * lower load strap joined at their ends, laced together by vertical engaging
 * straps about 20 ft apart — several such assemblies are rigged staggered, so
 * the straps the pilot sees are much closer than that. The vertical straps
 * catch the wings; the joined ends run through a purchase cable per side to an
 * arresting engine below deck. It is stowed and only rigged for an aircraft
 * that cannot take a wire, and the webbing is thrown away after one catch.
 *
 * Here the physics is the same shape as the wires' (see arrestorCables.ts): a
 * crossing test and a deck-axis scrub to a fixed run-out. Everything the net
 * looks like is drawn from pose in barricadeWrap.ts, and never feeds back.
 */
import * as THREE from 'three';
import { ARRESTOR_DECK_MID_X } from './arrestorCables';

/** Stanchion pair centre, carrier-local X (the landing centreline). */
export const BARRICADE_MID_X = ARRESTOR_DECK_MID_X;
/** Half the distance between the stanchions (m); the wires' lane is ±18 m too. */
export const BARRICADE_HALF_SPAN_M = 18;
/** Carrier-local Z of the webbing: 19 m forward of wire 4, landing along −Z. */
export const BARRICADE_LOCAL_Z = 40;
/** Deck height under the barricade, carrier-local Y (as under the wires). */
export const BARRICADE_DECK_Y = 13.55;
/** Stanchion and upper-strap height above the deck (20 ft). */
export const BARRICADE_HEIGHT_M = 6.1;
/** Lower load strap rides this high off the deck on its deck ramps. */
export const BARRICADE_LOWER_LIFT_M = 0.35;
/**
 * Vertical engaging straps across the webbing: five staggered assemblies of
 * five, so a fighter's wing meets two or three of them, not one.
 */
export const BARRICADE_STRAP_COUNT = 25;
/** Webbing cut width, shackle to shackle, as rigged between the stanchions. */
export const BARRICADE_WEBBING_WIDTH_M = 2 * BARRICADE_HALF_SPAN_M;

/** Seconds for the stanchions to swing from flush to upright (real rigging takes ~3 min). */
export const BARRICADE_RAISE_S = 6;
/** Run-out from engagement to full stop, measured at the CG (m). */
export const BARRICADE_PULL_OUT_M = 75;
/** Deceleration cap (m/s²), ~5 g — the net arrests harder than a wire. */
export const BARRICADE_MAX_DECEL_MPS2 = 5 * 9.80665;
/** Minimum closing speed on the deck to engage (m/s); below it the net is just pushed. */
const BARRICADE_MIN_ENGAGE_SPEED_MPS = 3;
/** CG this high above the stanchion tops still drags the wings through (m). */
const BARRICADE_OVERFLY_MARGIN_M = 1.5;
/** CG must cross at least this far inside a stanchion (m). */
const BARRICADE_STANCHION_MARGIN_M = 1;

/** Engagement state reported per aircraft in the sim snapshot. */
export const enum BarricadeEngagement {
    NONE = 0,
    /** Webbing on the wings, still paying out. */
    PULLING = 1,
    /** Stopped and held; stays in the net until the rig is renewed. */
    HELD = 2,
}

/** One carrier's barricade in world space, as the sim tests it. */
export interface BarricadeField {
    /** Webbing centre at deck level. */
    readonly center: THREE.Vector3;
    /** Unit landing / run-out direction (toward the bow). */
    readonly deckAxis: THREE.Vector3;
    /** Unit stanchion-to-stanchion direction (carrier +X). */
    readonly lateralAxis: THREE.Vector3;
    /** Unit deck normal. */
    readonly upAxis: THREE.Vector3;
    /** Webbing fully up and not yet expended. */
    armed: boolean;
    /** Bumped by the rig each time fresh webbing goes up. */
    generation: number;
}

/** Build the world field from a carrier pose. */
export function buildBarricadeField(
    originX: number,
    originY: number,
    originZ: number,
    orientation: THREE.Quaternion | undefined,
    armed: boolean,
    generation: number,
): BarricadeField {
    const q = orientation ?? new THREE.Quaternion();
    const center = new THREE.Vector3(BARRICADE_MID_X, BARRICADE_DECK_Y, BARRICADE_LOCAL_Z)
        .applyQuaternion(q)
        .add(new THREE.Vector3(originX, originY, originZ));
    return {
        center,
        deckAxis: new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize(),
        lateralAxis: new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize(),
        upAxis: new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize(),
        armed,
        generation,
    };
}

const _rel = new THREE.Vector3();

/** Signed distance of a world point past the webbing plane, along the deck axis. */
export function barricadeAlong(field: BarricadeField, p: THREE.Vector3): number {
    return _rel.subVectors(p, field.center).dot(field.deckAxis);
}

/**
 * Did a CG moving prevPos → pos fly into the raised webbing this step?
 * Wings sit near the CG, so the CG crossing the plane is the catch: inside the
 * stanchions, low enough that the wings meet the straps, and closing on the
 * ship at more than a walk.
 */
export function barricadeCatches(
    field: BarricadeField,
    prevPos: THREE.Vector3,
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    shipVel: THREE.Vector3,
): boolean {
    if (!field.armed) return false;
    if (barricadeAlong(field, prevPos) >= 0 || barricadeAlong(field, pos) < 0) return false;
    const closing = vel.dot(field.deckAxis) - shipVel.dot(field.deckAxis);
    if (closing < BARRICADE_MIN_ENGAGE_SPEED_MPS) return false;
    _rel.subVectors(pos, field.center);
    if (Math.abs(_rel.dot(field.lateralAxis)) > BARRICADE_HALF_SPAN_M - BARRICADE_STANCHION_MARGIN_M) {
        return false;
    }
    return _rel.dot(field.upAxis) <= BARRICADE_HEIGHT_M + BARRICADE_OVERFLY_MARGIN_M;
}

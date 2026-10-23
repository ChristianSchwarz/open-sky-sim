/**
 * The wind in the webbing: drawing only.
 *
 * Nylon engaging straps are light. Rigged, they hang between the load straps
 * and the wind over the deck (from the bow: the ship steams into it) bellies
 * them aft and keeps them fluttering; caught, the free ones still do. Each
 * strap billows on its own slow swell, with a quicker ripple running down
 * it, from its own phase, so no two move together. Both sewn ends stay put,
 * a strap the wing holds does not move at all, and nothing goes through the
 * deck. Carrier-local coordinates, like barricadeWrap.ts.
 */
import * as THREE from 'three';
import { BARRICADE_DECK_Y } from './barricadeSpec';

type V3 = THREE.Vector3;

/** Downwind over the deck: from the bow (−z) toward the stern (+z). */
const DOWNWIND = new THREE.Vector3(0, 0, 1);
const ACROSS = new THREE.Vector3(1, 0, 0);
/** Slow belly downwind, and how much it breathes (m, rad/s). */
const BILLOW_M = 0.35;
const BILLOW_BREATH = 0.25;
const BILLOW_RATE = 1.1;
/** Quick ripple travelling down the strap (m, rad/s, waves per strap). */
const RIPPLE_M = 0.12;
const RIPPLE_RATE = 6.0;
const RIPPLE_WAVES = 1.5;
/** Sideways sway (m, rad/s). */
const SWAY_M = 0.08;
const SWAY_RATE = 2.3;
/** A strap is drawn with at least this many points, so it can bend. */
const MIN_POINTS = 10;
const DECK_CLEARANCE_M = 0.04;
/** Webbing within this height of the deck (m) moves less in the wind, and none on it. */
const DECK_HOLD_M = 0.3;

/**
 * The straps as the wind leaves them at `timeS`. Straps marked in `held` (the
 * ones folded over a wing) come back unchanged; every other one is
 * resampled to bend, displaced most at its middle and not at all at its ends.
 */
export function flutterStraps(straps: readonly V3[][], held: readonly boolean[], timeS: number): V3[][] {
    return straps.map((strap, j) => (held[j] || strap.length < 2 ? strap : flutterOne(strap, j, timeS)));
}

function flutterOne(strap: readonly V3[], j: number, t: number): V3[] {
    const pts = strap.length >= MIN_POINTS ? strap.map(p => p.clone()) : densify(strap, MIN_POINTS);
    // Arc-length parameter 0..1 along the strap.
    const arc = [0];
    for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + pts[i - 1].distanceTo(pts[i]));
    const total = arc[arc.length - 1];
    if (total < 1e-6) return pts;
    // A phase per strap, from its index: golden-ratio spread, no two alike.
    const phase = j * 2.39996;
    const billow = BILLOW_M * (1 - BILLOW_BREATH + BILLOW_BREATH * Math.sin(BILLOW_RATE * t + phase));
    const sway = SWAY_M * Math.sin(SWAY_RATE * t + phase * 1.7);
    const floor = BARRICADE_DECK_Y + DECK_CLEARANCE_M;
    for (let i = 1; i < pts.length - 1; i++) {
        const s = arc[i] / total;
        // Webbing lying on the deck is held there by friction; the wind takes what hangs.
        const lift = Math.min(1, Math.max(0, (pts[i].y - floor) / DECK_HOLD_M));
        const envelope = Math.sin(Math.PI * s) * lift;
        const ripple = RIPPLE_M * Math.sin(RIPPLE_RATE * t + phase - 2 * Math.PI * RIPPLE_WAVES * s);
        pts[i].addScaledVector(DOWNWIND, envelope * (billow + ripple)).addScaledVector(ACROSS, envelope * sway);
        pts[i].y = Math.max(pts[i].y, floor);
    }
    return pts;
}

/** `count` points evenly along a polyline (its own points' shape kept as far as `count` allows). */
function densify(pts: readonly V3[], count: number): V3[] {
    const arc = [0];
    for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1] + pts[i - 1].distanceTo(pts[i]));
    const total = arc[arc.length - 1];
    const out: V3[] = [];
    let seg = 1;
    for (let k = 0; k < count; k++) {
        const s = (k / (count - 1)) * total;
        while (seg < pts.length - 1 && arc[seg] < s) seg++;
        const len = arc[seg] - arc[seg - 1];
        const f = len > 1e-9 ? (s - arc[seg - 1]) / len : 0;
        out.push(new THREE.Vector3().lerpVectors(pts[seg - 1], pts[seg], Math.min(1, Math.max(0, f))));
    }
    return out;
}

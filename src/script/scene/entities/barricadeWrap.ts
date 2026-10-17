/**
 * What the barricade looks like, built from pose alone.
 *
 * Nothing here is simulated. The sim (barricadeSpec.ts, combatSim) decides
 * whether an aircraft is in the net and how fast it stops; this module draws
 * the webbing for that pose, deterministically, so it cannot knot or flicker.
 * (Five earlier rewrites solved the net as particles and lost to exactly that.)
 *
 * Rigged and empty, the webbing hangs between the stanchion tops: an upper load
 * strap that sags, a lower one on the deck ramps, vertical engaging straps
 * between them. Caught, it is drawn wrapped on the airframe:
 *  - the upper strap is a taut band across the wings' leading edges, lying on
 *    the skin just behind them and resting on the spine over the fuselage; off
 *    each wingtip it spans free to its shackle, and there it sags;
 *  - the lower strap is pressed against the front of the gear legs;
 *  - each vertical strap that meets a wing is hooked over its leading edge;
 *    the ones in front of the fuselage are pushed aside by the nose;
 *  - both straps end in one shackle per side, which the purchase cable pulls
 *    back toward its deck sheave at the stanchion foot.
 *
 * All coordinates are carrier-local (x lateral, y up, landing toward −z).
 */
import * as THREE from 'three';
import {
    BARRICADE_DECK_Y,
    BARRICADE_HALF_SPAN_M,
    BARRICADE_HEIGHT_M,
    BARRICADE_LOCAL_Z,
    BARRICADE_LOWER_LIFT_M,
    BARRICADE_MID_X,
    BARRICADE_STRAP_COUNT,
    BARRICADE_WEBBING_WIDTH_M,
} from './barricadeSpec';

type V3 = THREE.Vector3;

/** Spacing of the samples taken along every collision-mesh edge (m). */
const PROFILE_EDGE_STEP_M = 0.25;
/** Lateral bin width for the leading-edge profile (m). */
const PROFILE_BIN_M = 0.5;
/** Fore/aft window around the wing root in which the spine crest is sampled (m). */
const CREST_WINDOW_M = 1.0;
/** Upper strap lies this far above and behind the edge it rests on (m). */
const STRAP_ON_SKIN_UP_M = 0.06;
const STRAP_ON_SKIN_AFT_M = 0.2;
/** A vertical strap hooks this far ahead of and below the leading edge (m). */
const HOOK_AHEAD_M = 0.12;
const HOOK_BELOW_M = 0.05;
/** The lower strap sits this far up the gear leg from the wheel contact, and ahead of it (m). */
const GEAR_TRAP_UP_M = 0.55;
const GEAR_TRAP_AHEAD_M = 0.2;
/** Upper strap is cut this much longer than the lower (fraction of width): it carries less load and droops. */
const UPPER_SLACK = 0.04;
/** Rigged-net sag of the upper strap between the stanchion tops (fraction of span). */
const RIGGED_SLACK = 0.012;
/**
 * A support this far behind the taut chord still holds the strap (m). The
 * edge samples are the forward-most point per lateral bin, which staircases a
 * straight swept edge; without the allowance the band skips the whole wing.
 */
const ENVELOPE_TOLERANCE_M = 0.15;
/** Samples per sagging span. */
const SAG_SAMPLES = 8;
/** Nothing is drawn below this height over the deck (m). */
const DECK_CLEARANCE_M = 0.04;

/** The airframe as the net sees it, in the body frame (+Z forward). */
export interface BarricadeAirframeProfile {
    /** Leading edge per side (−x, +x), ordered root → tip. */
    readonly leadingEdge: readonly [readonly V3[], readonly V3[]];
    /** Fuselage top across the wing-root station, ordered −x → +x. */
    readonly crest: readonly V3[];
    /** Gear contact points. */
    readonly gear: readonly V3[];
    /** Half-width of the band the fuselage occupies, which no strap hooks. */
    readonly fuselageHalfWidth: number;
}

/** Collision soup + gear points → the profile; synthesised when the mesh is missing. */
export function buildAirframeProfile(
    mesh: { triangles: readonly number[] } | undefined,
    gear: readonly (readonly [number, number, number])[] | undefined,
): BarricadeAirframeProfile {
    const gearPts = (gear && gear.length > 0 ? gear : [[0, -1.7, 2.6], [-1.2, -1.7, -0.6], [1.2, -1.7, -0.6]])
        .map(p => new THREE.Vector3(p[0], p[1], p[2]));
    const pts = mesh ? sampleSoup(mesh.triangles) : [];
    if (pts.length === 0) {
        return syntheticProfile(gearPts);
    }
    let halfSpan = 0;
    for (const p of pts) halfSpan = Math.max(halfSpan, Math.abs(p.x));
    const fuselageHalfWidth = THREE.MathUtils.clamp(0.3 * halfSpan, 0.8, 2.2);

    // Leading edge: the forward-most sample in each lateral bin outside the fuselage.
    const bins = Math.max(1, Math.ceil((halfSpan - fuselageHalfWidth) / PROFILE_BIN_M));
    const sides: V3[][] = [[], []];
    for (let s = 0; s < 2; s++) {
        const sign = s === 0 ? -1 : 1;
        const best: (V3 | undefined)[] = new Array(bins);
        for (const p of pts) {
            const ax = p.x * sign;
            if (ax < fuselageHalfWidth || ax > halfSpan) continue;
            const b = Math.min(bins - 1, Math.floor((ax - fuselageHalfWidth) / PROFILE_BIN_M));
            if (!best[b] || p.z > best[b]!.z) best[b] = p;
        }
        for (const p of best) if (p) sides[s].push(p.clone());
    }
    if (sides[0].length === 0 || sides[1].length === 0) {
        return syntheticProfile(gearPts);
    }

    // Spine crest across the fuselage, at the wing-root station.
    const rootZ = (sides[0][0].z + sides[1][0].z) * 0.5;
    const crestBins = Math.max(2, Math.ceil((2 * fuselageHalfWidth) / (PROFILE_BIN_M * 0.5)));
    const crestBest: (V3 | undefined)[] = new Array(crestBins);
    for (const p of pts) {
        if (Math.abs(p.x) > fuselageHalfWidth || Math.abs(p.z - rootZ) > CREST_WINDOW_M) continue;
        const b = Math.min(crestBins - 1, Math.floor(((p.x + fuselageHalfWidth) / (2 * fuselageHalfWidth)) * crestBins));
        if (!crestBest[b] || p.y > crestBest[b]!.y) crestBest[b] = p;
    }
    const crest = crestBest.filter((p): p is V3 => p !== undefined).map(p => p.clone());

    return { leadingEdge: [sides[0], sides[1]], crest, gear: gearPts, fuselageHalfWidth };
}

function sampleSoup(tris: readonly number[]): V3[] {
    const out: V3[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let t = 0; t + 8 < tris.length; t += 9) {
        for (let e = 0; e < 3; e++) {
            const i = t + e * 3;
            const j = t + ((e + 1) % 3) * 3;
            a.set(tris[i], tris[i + 1], tris[i + 2]);
            b.set(tris[j], tris[j + 1], tris[j + 2]);
            const n = Math.max(1, Math.ceil(a.distanceTo(b) / PROFILE_EDGE_STEP_M));
            for (let k = 0; k < n; k++) {
                out.push(new THREE.Vector3().lerpVectors(a, b, k / n));
            }
        }
    }
    return out;
}

/** A plain swept wing, for airframes without a collision mesh. */
function syntheticProfile(gear: V3[]): BarricadeAirframeProfile {
    const half = 5;
    const fh = 1.0;
    const side = (sign: number): V3[] => {
        const out: V3[] = [];
        for (let x = fh; x <= half + 1e-6; x += PROFILE_BIN_M) {
            const t = (x - fh) / (half - fh);
            out.push(new THREE.Vector3(sign * x, -0.2, 1.0 - 2.5 * t));
        }
        return out;
    };
    const crest: V3[] = [];
    for (let x = -fh; x <= fh + 1e-6; x += 0.25) {
        crest.push(new THREE.Vector3(x, 0.8 - 0.3 * (x / fh) ** 2, 1.0));
    }
    return { leadingEdge: [side(-1), side(1)], crest, gear, fuselageHalfWidth: fh };
}

/** Everything drawn for one barricade, carrier-local. */
export interface BarricadeNetShape {
    /** Stanchion foot and head, port then starboard. */
    readonly stanchions: [{ base: V3; top: V3 }, { base: V3; top: V3 }];
    /** Load straps, shackle to shackle (−x → +x). Empty while stowed. */
    readonly upper: V3[];
    readonly lower: V3[];
    /** Vertical engaging straps, each a short polyline from upper to lower. */
    readonly verticals: V3[][];
    /** Purchase cables, sheave to shackle; only while caught. */
    readonly cables: V3[][];
}

/** Aircraft pose in carrier-local space. */
export interface BarricadeCatchPose {
    readonly position: V3;
    readonly quaternion: THREE.Quaternion;
}

/**
 * The barricade for a rig state.
 * @param raise 0 = stanchions flush, 1 = upright.
 * @param webbing whether webbing is rigged at all (false once the stanchions
 *        go down after a catch, or before fresh webbing is laced).
 * @param caught the aircraft in the net, if any — the webbing goes with it.
 */
export function buildBarricadeShape(
    raise: number,
    webbing: boolean,
    caught?: { pose: BarricadeCatchPose; profile: BarricadeAirframeProfile },
): BarricadeNetShape {
    const stanchions = stanchionPoses(raise);
    if (caught) {
        return { stanchions, ...wrapOnAirframe(caught.pose, caught.profile) };
    }
    if (!webbing || raise <= 0) {
        return { stanchions, upper: [], lower: [], verticals: [], cables: [] };
    }
    return { stanchions, ...riggedWebbing(stanchions), cables: [] };
}

/** Stanchions hinge at the deck and swing up from lying flat, head aft. */
function stanchionPoses(raise: number): [{ base: V3; top: V3 }, { base: V3; top: V3 }] {
    const theta = THREE.MathUtils.clamp(raise, 0, 1) * Math.PI * 0.5;
    const make = (x: number) => {
        const base = new THREE.Vector3(x, BARRICADE_DECK_Y, BARRICADE_LOCAL_Z);
        const top = base.clone().add(new THREE.Vector3(
            0, BARRICADE_HEIGHT_M * Math.sin(theta), BARRICADE_HEIGHT_M * Math.cos(theta),
        ));
        return { base, top };
    };
    return [make(BARRICADE_MID_X - BARRICADE_HALF_SPAN_M), make(BARRICADE_MID_X + BARRICADE_HALF_SPAN_M)];
}

function riggedWebbing(st: [{ base: V3; top: V3 }, { base: V3; top: V3 }]): Pick<BarricadeNetShape, 'upper' | 'lower' | 'verticals'> {
    const span = st[0].top.distanceTo(st[1].top);
    const upper = sagSpan(st[0].top, st[1].top, span * RIGGED_SLACK, SAG_SAMPLES * 3);
    const lift = new THREE.Vector3(0, BARRICADE_LOWER_LIFT_M, 0);
    const lower = [st[0].base.clone().add(lift), st[1].base.clone().add(lift)];
    clampToDeck(upper);
    const verticals: V3[][] = [];
    for (let j = 0; j < BARRICADE_STRAP_COUNT; j++) {
        const u = (j + 1) / (BARRICADE_STRAP_COUNT + 1);
        verticals.push([pointAtFraction(upper, u), pointAtFraction(lower, u)]);
    }
    return { upper, lower, verticals };
}

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

/** Support on the upper strap: where it lies, plus whether a vertical strap hooks there. */
interface Support {
    readonly at: V3;
    /** The leading-edge point this support rests behind; undefined over the fuselage and off the tips. */
    readonly edge?: V3;
}

function wrapOnAirframe(pose: BarricadeCatchPose, profile: BarricadeAirframeProfile): Omit<BarricadeNetShape, 'stanchions'> {
    const toLocal = (p: V3) => p.clone().applyQuaternion(pose.quaternion).add(pose.position);
    _fwd.set(0, 0, 1).applyQuaternion(pose.quaternion);
    _up.set(0, 1, 0).applyQuaternion(pose.quaternion);
    const deckFloor = BARRICADE_DECK_Y + DECK_CLEARANCE_M;
    const centreX = pose.position.x;

    // Upper strap supports: both leading edges and the spine between them.
    const supports: Support[] = [];
    for (const side of profile.leadingEdge) {
        for (const p of side) {
            const edge = toLocal(p);
            const at = edge.clone().addScaledVector(_up, STRAP_ON_SKIN_UP_M).addScaledVector(_fwd, -STRAP_ON_SKIN_AFT_M);
            supports.push({ at, edge });
        }
    }
    for (const p of profile.crest) {
        supports.push({ at: toLocal(p).addScaledVector(_up, STRAP_ON_SKIN_UP_M) });
    }
    supports.sort((a, b) => a.at.x - b.at.x);
    const band = frontEnvelope(supports);

    // Shackles: what is left of the webbing beyond each tip, laid off toward
    // the sheaves. The webbing's middle met the aircraft where it crossed.
    const sheaves = [
        new THREE.Vector3(BARRICADE_MID_X - BARRICADE_HALF_SPAN_M, BARRICADE_DECK_Y, BARRICADE_LOCAL_Z),
        new THREE.Vector3(BARRICADE_MID_X + BARRICADE_HALF_SPAN_M, BARRICADE_DECK_Y, BARRICADE_LOCAL_Z),
    ];
    const half = BARRICADE_WEBBING_WIDTH_M * 0.5;
    const offset = centreX - BARRICADE_MID_X;
    const bandPts = band.map(s => s.at);
    const centreArc = arcAtX(bandPts, centreX);
    const bandLen = polylineLength(bandPts);
    const remaining = [half + offset - centreArc, half - offset - (bandLen - centreArc)];
    const tips = [bandPts[0], bandPts[bandPts.length - 1]];
    const shackles: V3[] = [];
    const tipSlack: number[] = [];
    for (let s = 0; s < 2; s++) {
        const toSheave = sheaves[s].clone().sub(tips[s]);
        const reach = toSheave.length();
        const rem = Math.max(0.3, remaining[s]);
        shackles.push(tips[s].clone().addScaledVector(toSheave.normalize(), Math.min(rem, reach)));
        tipSlack.push(Math.max(0, rem - reach));
    }
    for (const sh of shackles) sh.y = Math.max(sh.y, deckFloor + 0.06);

    // Upper strap: shackle, band, shackle. The band lies on the airframe; the
    // two free spans off the wingtips share the strap's slack and sag.
    const freeLens = [shackles[0].distanceTo(tips[0]), shackles[1].distanceTo(tips[1])];
    const slack = BARRICADE_WEBBING_WIDTH_M * UPPER_SLACK;
    const shareOf = (s: number) =>
        tipSlack[s] + slack * freeLens[s] / Math.max(1e-6, freeLens[0] + freeLens[1]);
    const upper: V3[] = sagSpan(shackles[0], tips[0], shareOf(0), SAG_SAMPLES);
    const bandFrom = upper.length - 1;
    for (let i = 1; i < bandPts.length; i++) upper.push(bandPts[i].clone());
    const bandTo = upper.length - 1;
    const tail = sagSpan(tips[1], shackles[1], shareOf(1), SAG_SAMPLES);
    for (let k = 1; k < tail.length; k++) upper.push(tail[k]);
    clampToDeck(upper);

    // Lower strap: shackle, the front of each gear leg, shackle.
    const legs = profile.gear
        .map(g => toLocal(g).addScaledVector(_up, GEAR_TRAP_UP_M).addScaledVector(_fwd, GEAR_TRAP_AHEAD_M))
        .sort((a, b) => a.x - b.x);
    const lower = [shackles[0].clone(), ...legs, shackles[1].clone()];
    for (const p of lower) p.y = Math.max(p.y, BARRICADE_DECK_Y + BARRICADE_LOWER_LIFT_M * 0.5);

    // Vertical straps at even stations along both straps. Hooked where the
    // upper strap lies on a wing; pushed aside where the nose came through.
    const upperArc = cumulative(upper);
    const lowerArc = cumulative(lower);
    const hookFrom = upperArc[bandFrom];
    const hookTo = upperArc[bandTo];
    const verticals: V3[][] = [];
    for (let j = 0; j < BARRICADE_STRAP_COUNT; j++) {
        const u = (j + 1) / (BARRICADE_STRAP_COUNT + 1);
        const su = u * upperArc[upperArc.length - 1];
        const top = pointAtArc(upper, upperArc, su);
        const bottom = pointAtArc(lower, lowerArc, u * lowerArc[lowerArc.length - 1]);
        const dx = top.x - centreX;
        if (Math.abs(dx) < profile.fuselageHalfWidth) {
            const push = Math.sign(dx || 1) * profile.fuselageHalfWidth;
            top.x = centreX + push;
            bottom.x = centreX + push;
            verticals.push([top, bottom]);
            continue;
        }
        const edge = su >= hookFrom && su <= hookTo ? edgeNear(band, top.x) : undefined;
        if (edge) {
            const hook = edge.clone().addScaledVector(_fwd, HOOK_AHEAD_M).addScaledVector(_up, -HOOK_BELOW_M);
            verticals.push([top, hook, bottom]);
        } else {
            verticals.push([top, bottom]);
        }
    }
    for (const v of verticals) clampToDeck(v);

    const cables = [[sheaves[0].clone(), shackles[0].clone()], [sheaves[1].clone(), shackles[1].clone()]];
    return { upper, lower, verticals, cables };
}

/**
 * The band a taut strap makes when pulled aft at both ends: the forward
 * convex hull of the supports in plan. Concavities —
 * a cranked wing, the wing-root notch — are bridged as straight spans.
 */
function frontEnvelope(sorted: Support[]): Support[] {
    // Toward the bow is −z: that is the way the purchase cables do not pull.
    const ahead = (s: Support) => -s.at.z;
    const hull: Support[] = [];
    for (const s of sorted) {
        while (hull.length >= 2) {
            const a = hull[hull.length - 2];
            const b = hull[hull.length - 1];
            // Keep b only if it sticks out ahead of the chord a → s.
            const t = (b.at.x - a.at.x) / Math.max(1e-6, s.at.x - a.at.x);
            const chord = ahead(a) + (ahead(s) - ahead(a)) * t;
            if (ahead(b) >= chord - ENVELOPE_TOLERANCE_M) break;
            hull.pop();
        }
        hull.push(s);
    }
    return hull;
}

/** The leading-edge point under the band at lateral x, if the band rests on a wing there. */
function edgeNear(band: Support[], x: number): V3 | undefined {
    let best: Support | undefined;
    let bestD = Infinity;
    for (const s of band) {
        if (!s.edge) continue;
        const d = Math.abs(s.at.x - x);
        if (d < bestD) {
            bestD = d;
            best = s;
        }
    }
    return best && bestD < 0.6 ? best.edge : undefined;
}

/** a → b hanging with `surplus` metres more strap than the chord: parabola of sag s, L + 8s²/3L. */
function sagSpan(a: V3, b: V3, surplus: number, samples: number): V3[] {
    const len = a.distanceTo(b);
    const sag = surplus > 0 && len > 1e-3 ? Math.sqrt((3 * len * surplus) / 8) : 0;
    const out: V3[] = [];
    for (let k = 0; k <= samples; k++) {
        const t = k / samples;
        const p = new THREE.Vector3().lerpVectors(a, b, t);
        p.y -= sag * 4 * t * (1 - t);
        out.push(p);
    }
    return out;
}

function clampToDeck(pts: V3[]): void {
    const floor = BARRICADE_DECK_Y + DECK_CLEARANCE_M;
    for (const p of pts) p.y = Math.max(p.y, floor);
}

function cumulative(pts: readonly V3[]): number[] {
    const out = [0];
    for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + pts[i - 1].distanceTo(pts[i]));
    return out;
}

function polylineLength(pts: readonly V3[]): number {
    const c = cumulative(pts);
    return c[c.length - 1];
}

function pointAtArc(pts: readonly V3[], arc: readonly number[], s: number): V3 {
    for (let i = 1; i < pts.length; i++) {
        if (arc[i] >= s) {
            const seg = arc[i] - arc[i - 1];
            const t = seg > 1e-9 ? (s - arc[i - 1]) / seg : 0;
            return new THREE.Vector3().lerpVectors(pts[i - 1], pts[i], t);
        }
    }
    return pts[pts.length - 1].clone();
}

function pointAtFraction(pts: readonly V3[], u: number): V3 {
    const arc = cumulative(pts);
    return pointAtArc(pts, arc, u * arc[arc.length - 1]);
}

/** Arc length along a polyline (sorted by x) to lateral position x. */
function arcAtX(pts: readonly V3[], x: number): number {
    if (x <= pts[0].x) return 0;
    let s = 0;
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const seg = a.distanceTo(b);
        if (x <= b.x) {
            const t = b.x > a.x ? (x - a.x) / (b.x - a.x) : 0;
            return s + seg * t;
        }
        s += seg;
    }
    return s;
}

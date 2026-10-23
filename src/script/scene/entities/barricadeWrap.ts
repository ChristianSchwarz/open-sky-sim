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
 *  - the upper strap follows each wing's own leading edge, lying on the top
 *    skin just behind it, and crosses the fuselage over the spine at the wing
 *    root; off each wingtip it spans free and taut to its shackle.
 *    (Not a taut hull: on a strake or cranked delta the hull from the tips
 *    to the spine bridges clean over the wings and never touches them.);
 *  - the lower strap is held up off the deck by the airframe: across the
 *    front of the gear legs at strut height, and in under each wing a little
 *    below the glove, out to the shackles;
 *  - caught, the upper strap and its pendants are not drawn. Every vertical
 *    strap runs from where the upper strap held it (draped over a wing,
 *    beside the fuselage, or off a tail) to the joint on its own side of
 *    the webbing, where the lower strap meets the purchase cable: they fan
 *    out from the jet to those two points. Caught, it runs from its upper station along its path: one
 *    that meets a wing folds over it (forward over the top skin and round
 *    the leading edge), one in front of the fuselage, where the nose came
 *    through, goes out beside it, and from there it runs to its lower
 *    station. From the catch on it is drawn three times as long (the load has
 *    pulled the webbing out). Nylon that long does not stand up in hoops:
 *    the free part sags under its own weight, down to the deck where it
 *    reaches it, and what is left lies on the deck in loose folds;
 *  - the webbing gloves each wing: a tight sleeve strap round the leading
 *    edge at every edge sample, and a band along the bottom skin answering
 *    the upper strap on top. It is drawn taut, a few centimetres off the
 *    skin. The free tails off the wingtips run nearly straight to their
 *    shackles, held taut by the purchase cables;
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
/** Webbing lies this far off the skin it rests on, above or below (m): pulled tight onto it. */
const STRAP_ON_SKIN_UP_M = 0.04;
/** Upper strap lies on the top skin this far behind the leading edge (m). */
const UPPER_ON_TOP_M = 2.0;
/** A sling runs this far back under the wing before it drops to the lower strap (m). */
const SLING_UNDER_M = 1.5;
/**
 * Extra bands along the skin, at these depths behind the edge (m), so the
 * sleeves and bands read as webbing pressed onto the wing, not a cord on it.
 */
const GLOVE_TOP_BANDS_M = [1.0];
const GLOVE_UNDER_BANDS_M = [0.75, 1.5];
/** Chordwise skin samples behind each leading-edge point (m), and their fore/aft window. */
const SKIN_STEPS_M = [0, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0];
/** A skin hit this far above or below the leading edge belongs to something else (m). */
const SKIN_REACH_M = 0.6;
/** A sling clears the leading edge by this much (m). */
const HOOK_AHEAD_M = 0.04;
/**
 * Upper strap slack off the wingtips (fraction of width). The purchase
 * cables keep the webbing under tension, so this is barely a droop.
 */
const UPPER_SLACK = 0.001;
/** Rigged-net sag of the upper strap between the stanchion tops (fraction of span). */
const RIGGED_SLACK = 0.012;
/**
 * Caught, the engaging straps are drawn this many times their rigged length,
 * from the catch on: the load has pulled the webbing out, and it hangs loose.
 */
const CAUGHT_STRAP_STRETCH = 3;
/** Samples along a strap's free run. */
const DRAPE_SAMPLES = 24;
/** Spare strap lying on the deck folds from side to side: at most this far (m), at least this wavelength (m). */
const FOLD_AMPLITUDE_M = 0.35;
const FOLD_WAVELENGTH_M = [1.2, 3];
/**
 * Folded, a strap lies on at most this much of its own length per metre of
 * deck run; a run too short for that lays its folds out aft first, the way
 * the webbing was dragged.
 */
const FOLD_PER_RUN = 1.4;
/** Radius of the turn where a strap laid out aft comes back (m). */
const FOLD_TURN_M = 1.0;
/** The lower strap is caught this far up each gear leg from the wheel contact, and this far ahead of it (m). */
const GEAR_TRAP_UP_M = 0.55;
const GEAR_TRAP_AHEAD_M = 0.25;
/** Under a wing the lower strap runs this far below the glove (m), never under strut height. */
const LOWER_BELOW_WING_M = 0.5;
/** Samples per sagging span. */
const SAG_SAMPLES = 8;
/** Nothing is drawn below this height over the deck (m). */
const DECK_CLEARANCE_M = 0.04;

/**
 * Top and bottom skin behind one leading-edge point, at {@link SKIN_STEPS_M}
 * (as far as the wing reaches); the first sample is the edge itself.
 */
export interface BarricadeWingSkin {
    readonly top: readonly V3[];
    readonly bottom: readonly V3[];
}

/** The airframe as the net sees it, in the body frame (+Z forward). */
export interface BarricadeAirframeProfile {
    /** Leading edge per side (−x, +x), ordered root → tip. */
    readonly leadingEdge: readonly [readonly V3[], readonly V3[]];
    /** The skin behind each of those points, index for index. */
    readonly skin: readonly [readonly BarricadeWingSkin[], readonly BarricadeWingSkin[]];
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
    const skins: BarricadeWingSkin[][] = [[], []];
    for (let s = 0; s < 2; s++) {
        const sign = s === 0 ? -1 : 1;
        const best: (V3 | undefined)[] = new Array(bins);
        for (const p of pts) {
            const ax = p.x * sign;
            if (ax < fuselageHalfWidth || ax > halfSpan) continue;
            const b = Math.min(bins - 1, Math.floor((ax - fuselageHalfWidth) / PROFILE_BIN_M));
            if (!best[b] || p.z > best[b]!.z) best[b] = p;
        }
        for (let b = 0; b < bins; b++) {
            const edge = best[b];
            if (!edge) continue;
            sides[s].push(edge.clone());
            skins[s].push(skinBehind(edge, mesh!.triangles));
        }
    }
    if (sides[0].length === 0 || sides[1].length === 0) {
        return syntheticProfile(gearPts);
    }

    // Spine crest across the fuselage, at the wing-root station.
    // Where the upper strap, lying back on the wing, meets the fuselage.
    const rootZ = (sides[0][0].z + sides[1][0].z) * 0.5 - UPPER_ON_TOP_M;
    const crestBins = Math.max(2, Math.ceil((2 * fuselageHalfWidth) / (PROFILE_BIN_M * 0.5)));
    const crestBest: (V3 | undefined)[] = new Array(crestBins);
    for (const p of pts) {
        if (Math.abs(p.x) > fuselageHalfWidth || Math.abs(p.z - rootZ) > CREST_WINDOW_M) continue;
        const b = Math.min(crestBins - 1, Math.floor(((p.x + fuselageHalfWidth) / (2 * fuselageHalfWidth)) * crestBins));
        if (!crestBest[b] || p.y > crestBest[b]!.y) crestBest[b] = p;
    }
    const crest = crestBest.filter((p): p is V3 => p !== undefined).map(p => p.clone());

    return { leadingEdge: [sides[0], sides[1]], skin: [skins[0], skins[1]], crest, gear: gearPts, fuselageHalfWidth };
}

/**
 * The skin behind `edge` at each chord step: a vertical ray through the
 * airframe, its highest hit the top and its lowest the bottom. Edge samples
 * alone miss the inside of a large flat panel. Only hits within
 * {@link SKIN_REACH_M} of the edge's height count, so a fin or store
 * further up or down is not taken for the wing.
 */
function skinBehind(edge: V3, tris: readonly number[]): BarricadeWingSkin {
    const top: V3[] = [edge.clone()];
    const bottom: V3[] = [edge.clone()];
    // Only triangles the rays at this x can meet, behind this edge.
    const deepest = SKIN_STEPS_M[SKIN_STEPS_M.length - 1];
    const under: number[] = [];
    for (let t = 0; t + 8 < tris.length; t += 9) {
        const x0 = Math.min(tris[t], tris[t + 3], tris[t + 6]);
        const x1 = Math.max(tris[t], tris[t + 3], tris[t + 6]);
        const z0 = Math.min(tris[t + 2], tris[t + 5], tris[t + 8]);
        const z1 = Math.max(tris[t + 2], tris[t + 5], tris[t + 8]);
        if (x0 <= edge.x && x1 >= edge.x && z1 >= edge.z - deepest && z0 <= edge.z) under.push(t);
    }
    for (const d of SKIN_STEPS_M) {
        if (d <= 0) continue;
        const z = edge.z - d;
        let hi = -Infinity;
        let lo = Infinity;
        for (const t of under) {
            const y = rayHitY(tris, t, edge.x, z);
            if (y === undefined || Math.abs(y - edge.y) > SKIN_REACH_M) continue;
            if (y > hi) hi = y;
            if (y < lo) lo = y;
        }
        // Past the trailing edge: the wing ends here.
        if (hi === -Infinity) break;
        top.push(new THREE.Vector3(edge.x, hi, z));
        bottom.push(new THREE.Vector3(edge.x, lo, z));
    }
    return { top, bottom };
}

/** Height where the vertical line through (x, z) meets triangle `t`, if it does. */
function rayHitY(tris: readonly number[], t: number, x: number, z: number): number | undefined {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
    const bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5];
    const cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-12) return undefined;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) return undefined;
    return l1 * ay + l2 * by + l3 * cy;
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
    // A thin aerofoil: 10 cm up and 6 cm down within half a metre of the edge.
    const skinOf = (e: V3): BarricadeWingSkin => ({
        top: SKIN_STEPS_M.map(d => new THREE.Vector3(e.x, e.y + 0.1 * Math.min(1, d / 0.5), e.z - d)),
        bottom: SKIN_STEPS_M.map(d => new THREE.Vector3(e.x, e.y - 0.06 * Math.min(1, d / 0.5), e.z - d)),
    });
    const left = side(-1);
    const right = side(1);
    return {
        leadingEdge: [left, right], skin: [left.map(skinOf), right.map(skinOf)],
        crest, gear, fuselageHalfWidth: fh,
    };
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
    /**
     * Webbing hugging the wings while caught: a sleeve round the leading edge
     * at every edge sample, plus one band per wing along the bottom skin.
     */
    readonly glove: V3[][];
    /** Per vertical strap: true where it folds over a wing (the wing holds it). */
    readonly slung: boolean[];
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
        return { stanchions, ...wrapOnAirframe(caught.pose, caught.profile, stanchions) };
    }
    if (!webbing || raise <= 0) {
        return { stanchions, upper: [], lower: [], verticals: [], cables: [], glove: [], slung: [] };
    }
    const rig = riggedWebbing(stanchions);
    return { stanchions, ...rig, cables: [], glove: [], slung: rig.verticals.map(() => false) };
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
    /** That edge's skin, carrier-local, for a sling to run over and under. */
    readonly skin?: BarricadeWingSkin;
}

function wrapOnAirframe(
    pose: BarricadeCatchPose,
    profile: BarricadeAirframeProfile,
    stanchions: [{ base: V3; top: V3 }, { base: V3; top: V3 }],
): Omit<BarricadeNetShape, 'stanchions'> {
    const toLocal = (p: V3) => p.clone().applyQuaternion(pose.quaternion).add(pose.position);
    _fwd.set(0, 0, 1).applyQuaternion(pose.quaternion);
    _up.set(0, 1, 0).applyQuaternion(pose.quaternion);
    const deckFloor = BARRICADE_DECK_Y + DECK_CLEARANCE_M;
    const centreX = pose.position.x;

    // Upper strap supports: on the top skin of both wings just behind the
    // leading edges, and on the spine between them.
    const supports: Support[] = [];
    for (let s = 0; s < 2; s++) {
        const edges = profile.leadingEdge[s];
        for (let i = 0; i < edges.length; i++) {
            const edge = toLocal(edges[i]);
            const body = profile.skin[s][i];
            const skin = { top: body.top.map(toLocal), bottom: body.bottom.map(toLocal) };
            const at = skinPointAt(skin.top, edge, UPPER_ON_TOP_M).addScaledVector(_up, STRAP_ON_SKIN_UP_M);
            supports.push({ at, edge, skin });
        }
    }
    for (const p of profile.crest) {
        supports.push({ at: toLocal(p).addScaledVector(_up, STRAP_ON_SKIN_UP_M) });
    }
    supports.sort((a, b) => a.at.x - b.at.x);
    const band = supports;

    // Webbing ends: what is left beyond each tip, laid off toward the
    // stanchion head, where the upper tensioning pendant holds it (toward the
    // sheave once the stanchion is down). The lower strap's end is below it,
    // off the deck, where the purchase cable takes it to its deck sheave.
    // The webbing's middle met the aircraft where it crossed.
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
    // Webbing longer than the way there is not left hanging: the pendant and
    // purchase cable have hauled it in, and the tail runs straight.
    const anchors = stanchions.map((st, s) => (st.top.y - st.base.y > 1 ? st.top : sheaves[s]));
    const shackles: V3[] = [];
    for (let s = 0; s < 2; s++) {
        const toward = anchors[s].clone().sub(tips[s]);
        const reach = toward.length();
        const rem = Math.max(0.3, remaining[s]);
        shackles.push(tips[s].clone().addScaledVector(toward.normalize(), Math.min(rem, reach)));
    }
    for (const sh of shackles) sh.y = Math.max(sh.y, deckFloor + 0.06);
    const lowerEnds = shackles.map(sh => sh.clone().setY(BARRICADE_DECK_Y + GEAR_TRAP_UP_M));

    // Upper strap: shackle, band, shackle. The band lies on the airframe; the
    // two free spans off the wingtips share the strap's little slack.
    const freeLens = [shackles[0].distanceTo(tips[0]), shackles[1].distanceTo(tips[1])];
    const slack = BARRICADE_WEBBING_WIDTH_M * UPPER_SLACK;
    const shareOf = (s: number) => slack * freeLens[s] / Math.max(1e-6, freeLens[0] + freeLens[1]);
    const upper: V3[] = sagSpan(shackles[0], tips[0], shareOf(0), SAG_SAMPLES);
    const bandFrom = upper.length - 1;
    for (let i = 1; i < bandPts.length; i++) upper.push(bandPts[i].clone());
    const bandTo = upper.length - 1;
    const tail = sagSpan(tips[1], shackles[1], shareOf(1), SAG_SAMPLES);
    for (let k = 1; k < tail.length; k++) upper.push(tail[k]);
    clampToDeck(upper);

    // Vertical straps at their sewn stations on the upper strap, each the
    // length it has rigged. Slung where the upper strap lies on a wing; out
    // beside the fuselage where the nose came through; straight down past
    // the wingtips.
    const upperArc = cumulative(upper);
    const hookFrom = upperArc[bandFrom];
    const hookTo = upperArc[bandTo];
    const lengths = riggedStrapLengths();
    // Lower strap, held off the deck by the airframe: across the front of
    // each gear leg at strut height, and under each wing (outboard of the
    // gear) a little below the glove, out to the shackles.
    const legs = profile.gear
        .map(g => toLocal(g).addScaledVector(_up, GEAR_TRAP_UP_M).addScaledVector(_fwd, GEAR_TRAP_AHEAD_M))
        .sort((a, b) => a.x - b.x);
    const trapY = BARRICADE_DECK_Y + GEAR_TRAP_UP_M;
    const legMin = legs.length > 0 ? legs[0].x : centreX;
    const legMax = legs.length > 0 ? legs[legs.length - 1].x : centreX;
    const underWing: V3[] = [];
    for (const s of band) {
        if (!s.edge || !s.skin) continue;
        if (s.at.x > legMin - 0.3 && s.at.x < legMax + 0.3) continue;
        const end = skinPointAt(s.skin.bottom, s.edge, SLING_UNDER_M);
        underWing.push(new THREE.Vector3(s.at.x, Math.max(trapY, end.y - LOWER_BELOW_WING_M), end.z));
    }
    const lower = [lowerEnds[0].clone(), ...[...underWing, ...legs].sort((a, b) => a.x - b.x), lowerEnds[1].clone()];
    const lowerArc = cumulative(lower);
    const verticals: V3[][] = [];
    const slung: boolean[] = [];
    for (let j = 0; j < BARRICADE_STRAP_COUNT; j++) {
        const u = (j + 1) / (BARRICADE_STRAP_COUNT + 1);
        const su = u * upperArc[upperArc.length - 1];
        const top = pointAtArc(upper, upperArc, su);
        // Caught, every strap runs to the joint on its own side, where the
        // lower strap meets the purchase cable.
        const bottom = lowerEnds[j < BARRICADE_STRAP_COUNT / 2 ? 0 : 1].clone();
        const dx = top.x - centreX;
        let path: V3[];
        if (Math.abs(dx) < profile.fuselageHalfWidth) {
            // Out beside the fuselage, forward of the wing root and down to
            // the lower strap's height there, so it runs on to its joint under
            // the wing, not through it.
            const sign = Math.sign(dx || 1);
            const beside = top.clone();
            beside.x = centreX + sign * profile.fuselageHalfWidth;
            path = [top, beside];
            const root = band
                .filter(b => b.edge && Math.sign(b.edge.x - centreX) === sign)
                .reduce<Support | undefined>((m, b) => (!m || Math.abs(b.edge!.x - centreX) < Math.abs(m.edge!.x - centreX) ? b : m), undefined);
            if (root?.edge) {
                const ahead = root.edge.clone().addScaledVector(_fwd, HOOK_AHEAD_M);
                if (aftOf(beside, ahead) > 0) path.push(new THREE.Vector3(beside.x, beside.y, ahead.z));
            }
            const last = path[path.length - 1];
            path.push(last.clone().setY(Math.min(last.y, trapY)));
            slung.push(false);
        } else if (su < hookFrom || su > hookTo) {
            // Off a wingtip: the upper strap that held its top is gone, so it
            // has fallen, and lies on the deck from below its station to its joint.
            path = [top.clone().setY(deckFloor)];
            slung.push(false);
        } else {
            const held = edgeNear(band, top.x);
            slung.push(!!(held?.edge && held.skin));
            path = held?.edge && held.skin
                // Round the edge and back under the wing: from there it runs
                // to its joint below the wing; straight from the leading edge
                // it would cut back through the wing to a joint aft of it.
                ? [top, ...sling(held.edge, held.skin, top.x, aftOf(held.at, held.edge))]
                : [top];
        }
        verticals.push(strapOfLength(path, bottom, lengths[j] * CAUGHT_STRAP_STRETCH));
    }
    for (const v of verticals) clampToDeck(v);

    // Purchase cables to the lower strap's ends; caught, nothing else holds the webbing.
    const cables = [[sheaves[0].clone(), lowerEnds[0].clone()], [sheaves[1].clone(), lowerEnds[1].clone()]];
    // The glove: a sleeve at every edge sample, and bands along the skin
    // through them, top and bottom, one per wing and depth.
    const glove: V3[][] = [];
    const bandDepths = [
        ...GLOVE_TOP_BANDS_M.map(d => ({ d, skin: 'top' as const, sign: 1 })),
        ...GLOVE_UNDER_BANDS_M.map(d => ({ d, skin: 'bottom' as const, sign: -1 })),
    ];
    const skinBands: V3[][][] = bandDepths.map(() => [[], []]);
    for (const s of band) {
        if (!s.edge || !s.skin) continue;
        glove.push([s.at.clone(), ...sling(s.edge, s.skin, s.at.x, aftOf(s.at, s.edge))]);
        const side = s.at.x < centreX ? 0 : 1;
        bandDepths.forEach((b, i) => {
            const p = skinPointAt(s.skin![b.skin], s.edge!, b.d).addScaledVector(_up, b.sign * STRAP_ON_SKIN_UP_M);
            skinBands[i][side].push(p);
        });
    }
    for (const sides of skinBands) {
        for (const pts of sides) {
            if (pts.length >= 2) glove.push(pts);
        }
    }
    return { upper, lower, verticals, cables, glove, slung };
}

/** Each vertical strap's length as rigged, station by station: its cut. */
let rigged: number[] | undefined;
function riggedStrapLengths(): number[] {
    if (!rigged) {
        rigged = riggedWebbing(stanchionPoses(1)).verticals.map(v => polylineLength(v));
    }
    return rigged;
}

/**
 * A strap of length `length` from `path[0]` along `path` and on to `bottom`,
 * the joint it ends at. The spare length goes into the last, free run, which
 * hangs under gravity: a sag straight down from the chord (a hanging strap
 * sags down, not sideways), resting on the deck where it reaches it. When it
 * has sagged onto the deck all the way across and is still long, the rest
 * lies on the deck in folds from side to side. A strap that cannot reach is
 * drawn straight.
 */
function strapOfLength(path: V3[], bottom: V3, length: number): V3[] {
    const out = path.map(p => p.clone());
    const end = out[out.length - 1];
    const free = length - polylineLength(out);
    if (free <= end.distanceTo(bottom) + 1e-6) {
        out.push(bottom.clone());
        return out;
    }
    const floor = BARRICADE_DECK_Y + DECK_CLEARANCE_M;
    // Fully sagged: straight down to the deck at each end, and along it between.
    const feet = [end.clone().setY(floor), bottom.clone().setY(floor)];
    const flatLen = Math.max(0, end.y - floor) + feet[0].distanceTo(feet[1]) + Math.max(0, bottom.y - floor);
    if (free < flatLen) {
        // Parabolic sag s below the chord, resting on the deck: the length
        // grows with s, so s by bisection.
        const sagged = (sag: number) => {
            const pts: V3[] = [];
            for (let k = 1; k < DRAPE_SAMPLES; k++) {
                const t = k / DRAPE_SAMPLES;
                const q = end.clone().lerp(bottom, t);
                q.y = Math.max(floor, q.y - sag * 4 * t * (1 - t));
                pts.push(q);
            }
            return pts;
        };
        const lengthOf = (pts: V3[]) => polylineLength([end, ...pts, bottom]);
        let lo = 0;
        let hi = 1;
        while (hi < 1e4 && lengthOf(sagged(hi)) < free) hi *= 2;
        for (let i = 0; i < 40; i++) {
            const m = (lo + hi) / 2;
            if (lengthOf(sagged(m)) < free) lo = m;
            else hi = m;
        }
        out.push(...sagged((lo + hi) / 2), bottom.clone());
        return out;
    }
    // On the deck from foot to foot; a run too short for its folds lays out
    // aft first, out and back.
    const onDeck = free - Math.max(0, end.y - floor) - Math.max(0, bottom.y - floor);
    const direct = feet[0].distanceTo(feet[1]);
    // Out aft and back as a U, never a hairpin (a drawn ribbon spikes at one).
    const runOf = (need: number) => {
        if (direct >= need) return [feet[0], feet[1]];
        const mid = feet[0].clone().lerp(feet[1], 0.5);
        const side = feet[1].clone().sub(feet[0]).setY(0);
        if (side.lengthSq() < 1e-9) side.set(1, 0, 0);
        side.normalize();
        const r = Math.max(FOLD_TURN_M, direct / 2);
        const aft = new THREE.Vector3(0, 0, 1);
        // Legs out, a half circle between them: need ≈ 2 · legs + π r.
        const leg = Math.max(0.5, (need - Math.PI * r) / 2);
        const a = mid.clone().addScaledVector(side, -r).addScaledVector(aft, leg);
        const b = mid.clone().addScaledVector(side, r).addScaledVector(aft, leg);
        const pts = [feet[0], a];
        for (let k = 1; k < 8; k++) {
            const t = Math.PI * (1 - k / 8);
            pts.push(mid.clone().addScaledVector(aft, leg).addScaledVector(side, r * Math.cos(t)).addScaledVector(aft, r * Math.sin(t)));
        }
        pts.push(b, feet[1]);
        return pts;
    };
    // Lay it out further aft until the folds hold it all.
    let need = onDeck / FOLD_PER_RUN;
    let run = runOf(need);
    let folds = folded(run, onDeck);
    for (let i = 0; i < 8 && polylineLength([run[0], ...folds, run[run.length - 1]]) < onDeck * 0.99; i++) {
        need *= 1.25;
        run = runOf(need);
        folds = folded(run, onDeck);
    }
    if (end.y > floor + 1e-6) out.push(feet[0].clone());
    out.push(...folds);
    if (bottom.y > floor + 1e-6) out.push(feet[1].clone());
    out.push(bottom.clone());
    return out;
}

/**
 * The interior points of `run` (on the deck) folded from side to side so
 * that it is `length` long, as near as amplitude and wavelength allow: the
 * amplitude first, at the longest wavelength, then the wavelength down.
 */
function folded(run: V3[], length: number): V3[] {
    const arc = cumulative(run);
    const total = arc[arc.length - 1];
    if (total < 1e-6) return [];
    const shape = (amp: number, wave: number) => {
        const n = Math.max(1, Math.round(total / wave));
        const samples = Math.max(DRAPE_SAMPLES, n * 12);
        const pts: V3[] = [];
        for (let k = 1; k < samples; k++) {
            const sArc = (total * k) / samples;
            const p = pointAtArc(run, arc, sArc);
            // Folded square to the run's tangent, smoothed over its corners.
            const dir = pointAtArc(run, arc, Math.min(total, sArc + FOLD_TURN_M))
                .sub(pointAtArc(run, arc, Math.max(0, sArc - FOLD_TURN_M))).setY(0);
            const side = new THREE.Vector3(-dir.z, 0, dir.x);
            if (side.lengthSq() > 1e-12) side.normalize();
            const u = sArc / total;
            // Out and back n times, easing to nothing at both feet.
            const ease = Math.min(1, u / 0.1, (1 - u) / 0.1);
            p.addScaledVector(side, amp * ease * Math.sin(2 * Math.PI * n * u));
            pts.push(p);
        }
        return pts;
    };
    const lengthOf = (pts: V3[]) => polylineLength([run[0], ...pts, run[run.length - 1]]);
    const [minWave, maxWave] = FOLD_WAVELENGTH_M;
    const bisect = (f: (x: number) => number, lo: number, hi: number) => {
        // f grows from lo to hi.
        for (let i = 0; i < 30; i++) {
            const m = (lo + hi) / 2;
            if (f(m) < length) lo = m;
            else hi = m;
        }
        return (lo + hi) / 2;
    };
    if (lengthOf(shape(FOLD_AMPLITUDE_M, maxWave)) >= length) {
        return shape(bisect(a => lengthOf(shape(a, maxWave)), 0, FOLD_AMPLITUDE_M), maxWave);
    }
    // Shorter waves fold more strap into the run (rounding n makes it stepwise, near enough).
    const wave = maxWave - bisect(d => lengthOf(shape(FOLD_AMPLITUDE_M, maxWave - d)), 0, maxWave - minWave);
    return shape(FOLD_AMPLITUDE_M, wave);
}

/** The wing support under the band at lateral x, if the band rests on a wing there. */
function edgeNear(band: Support[], x: number): Support | undefined {
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
    return best && bestD < 0.6 ? best : undefined;
}

/**
 * The part of a vertical strap that wraps a wing, at lateral x: forward over
 * the top skin from under the upper strap (`topDepth` behind the edge), round
 * the edge, and back under the bottom skin to {@link SLING_UNDER_M}. The
 * caller adds the top end, on the upper strap.
 */
function sling(edge: V3, skin: BarricadeWingSkin, x: number, topDepth: number, under = true): V3[] {
    const out: V3[] = [];
    const lift = (p: V3, sign: number) => {
        const q = p.clone().addScaledVector(_up, sign * STRAP_ON_SKIN_UP_M);
        q.x = x;
        return q;
    };
    for (let k = skin.top.length - 1; k >= 0; k--) {
        if (aftOf(skin.top[k], edge) < topDepth - 1e-3) out.push(lift(skin.top[k], 1));
    }
    const nose = edge.clone().addScaledVector(_fwd, HOOK_AHEAD_M);
    nose.x = x;
    out.push(nose);
    if (!under) return out;
    for (const p of skin.bottom) {
        if (aftOf(p, edge) > 1e-6 && aftOf(p, edge) <= SLING_UNDER_M + 1e-6) out.push(lift(p, -1));
    }
    return out;
}

/** How far behind the edge a skin point lies, along the airframe's own axis. */
function aftOf(p: V3, edge: V3): number {
    return -_fwd.dot(new THREE.Vector3().subVectors(p, edge));
}

/** The skin sample `aft` metres behind the edge, or the last one the wing has. */
function skinPointAt(skin: readonly V3[], edge: V3, aft: number): V3 {
    let best = skin[0] ?? edge;
    for (const p of skin) {
        if (aftOf(p, edge) <= aft + 1e-6) best = p;
    }
    return best.clone();
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

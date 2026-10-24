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
 *    beside the fuselage, or off a tail) to its own station on the lower
 *    strap, in its rigged order along it; the lower strap runs on to the
 *    joints where the purchase cables take it. Caught, it runs from its upper station along its path: one
 *    that meets a wing folds over it (forward over the top skin and round
 *    the leading edge), one in front of the fuselage, where the nose came
 *    through, goes out beside it, and from there it runs to its lower
 *    station. While the jet pulls against the purchase cables the whole
 *    webbing is in tension and the strap runs straight to its joint; once
 *    the jet rolls back in the net the tension goes, and the strap (pulled
 *    out to three times its rigged length) sags, clear of the deck. A strap off a wingtip, its top no longer held, lies along the
 *    taut lower strap to its joint;
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
import { buildTriangleBvh, bvhHit, bvhSegmentHit, TriangleBvh } from '../../physics/collision/triangleBvh';

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
/**
 * The purchase cables keep the webbing under tension: a strap's free run to
 * its joint sags no lower than this over the deck (m), and the rest of its
 * length is taken up by the pull, not laid on the deck.
 */
const TAUT_CLEARANCE_M = 0.3;
/** A strap lying along the lower strap rides this far above it (m). */
const ON_BELT_M = 0.03;
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
    /** The drawn airframe, body frame, for keeping straps out of it. */
    readonly hull?: TriangleBvh;
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

    const hull = buildTriangleBvh(mesh!.triangles);
    return { leadingEdge: [sides[0], sides[1]], skin: [skins[0], skins[1]], crest, gear: gearPts, fuselageHalfWidth, hull };
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
    /**
     * How far the pull has let go, 0..1. While the jet pulls against the
     * purchase cables (0, the default) the whole webbing is in tension and
     * every strap runs straight to its joint; rolled back in the net, it
     * slackens (1) and the straps sag with their full length.
     */
    readonly slack?: number;
}

/**
 * The barricade for a rig state.
 * @param raise 0 = stanchions flush, 1 = upright.
 * @param webbing whether webbing is rigged at all (false once the stanchions
 *        go down after a catch, or before fresh webbing is laced).
 * @param caught the aircraft in the net, if any — the webbing goes with it.
 */
let wrapCache: { profile: BarricadeAirframeProfile; key: string; shape: BarricadeNetShape } | undefined;

export function buildBarricadeShape(
    raise: number,
    webbing: boolean,
    caught?: { pose: BarricadeCatchPose; profile: BarricadeAirframeProfile },
): BarricadeNetShape {
    const stanchions = stanchionPoses(raise);
    if (caught) {
        // Held in the net the pose stops changing; the wrap (with its hull
        // queries) is then the same frame after frame.
        const { position: p, quaternion: q } = caught.pose;
        const key = [raise, p.x, p.y, p.z, q.x, q.y, q.z, q.w, caught.pose.slack ?? 0].map(v => v.toFixed(4)).join(',');
        if (wrapCache && wrapCache.profile === caught.profile && wrapCache.key === key) return wrapCache.shape;
        const shape = { stanchions, ...wrapOnAirframe(caught.pose, caught.profile, stanchions) };
        wrapCache = { profile: caught.profile, key, shape };
        return shape;
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
    const letGo = THREE.MathUtils.clamp(pose.slack ?? 0, 0, 1);

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
    // Webbing longer than the way there is not left hanging: the purchase
    // cable has hauled it in, and the tail runs straight. Caught, the upper
    // strap's pendants have let go and nothing holds the webbing but the
    // purchase cables: the pull runs in one straight line from the airframe
    // through the joint to the deck sheave.
    const anchors = sheaves;
    void stanchions;
    const shackles: V3[] = [];
    for (let s = 0; s < 2; s++) {
        const toward = anchors[s].clone().sub(tips[s]);
        const reach = toward.length();
        const rem = Math.max(0.3, remaining[s]);
        shackles.push(tips[s].clone().addScaledVector(toward.normalize(), Math.min(rem, reach)));
    }
    for (const sh of shackles) sh.y = Math.max(sh.y, deckFloor + 0.06);


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
    // The joint, where the lower strap meets the purchase cable: out at the
    // shackle, as low as the lower strap runs under that wing, so every strap
    // pulled straight to it passes under the wing, not through it.
    const lowerEnds = shackles.map((sh, s) => {
        const side = underWing.filter(p => (s === 0 ? p.x < centreX : p.x > centreX)).map(p => p.y);
        const y = Math.min(sh.y, ...side, ...(side.length ? [] : [trapY]));
        return sh.clone().setY(Math.max(trapY, y));
    });
    let lower = [lowerEnds[0].clone(), ...[...underWing, ...legs].sort((a, b) => a.x - b.x), lowerEnds[1].clone()];
    // Routed round the airframe before the straps' stations are put on it.
    if (profile.hull) lower = clearOfHull(lower, profile.hull, pose, true);
    const lowerArc = cumulative(lower);
    const verticals: V3[][] = [];
    const slung: boolean[] = [];
    for (let j = 0; j < BARRICADE_STRAP_COUNT; j++) {
        const u = (j + 1) / (BARRICADE_STRAP_COUNT + 1);
        const su = u * upperArc[upperArc.length - 1];
        const top = pointAtArc(upper, upperArc, su);
        // Every strap stays sewn to the lower strap at its own station, in
        // its rigged order along it; the lower strap runs on to the joints.
        const bottom = pointAtArc(lower, lowerArc, u * lowerArc[lowerArc.length - 1]);
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
            // Off a wingtip: the upper strap that held its top is gone, and the
            // strap lies along the taut lower strap out from its station.
            const port = j < BARRICADE_STRAP_COUNT / 2;
            verticals.push(alongBelt(lower, lowerArc, u * lowerArc[lowerArc.length - 1], port, lengths[j] * CAUGHT_STRAP_STRETCH, sheaves[port ? 0 : 1]));
            slung.push(false);
            continue;
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
        // Taut, the strap is as long as its way to the joint (the pull has
        // stretched it straight); slack, it has its whole length to sag with.
        const taut = polylineLength(path) + path[path.length - 1].distanceTo(bottom);
        const full = lengths[j] * CAUGHT_STRAP_STRETCH;
        verticals.push(strapOfLength(path, bottom, taut + letGo * Math.max(0, full - taut)));
    }
    if (profile.hull) {
        for (let j = 0; j < verticals.length; j++) verticals[j] = clearOfHull(verticals[j], profile.hull, pose);
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
    if (profile.hull) {
        for (let k = 0; k < glove.length; k++) glove[k] = clearOfHull(glove[k], profile.hull, pose);
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
 * A strap of up to `length` from `path[0]` along `path` and on to `bottom`,
 * the joint it ends at. The spare length goes into the last, free run, which
 * sags straight down from the chord (a hanging strap sags down, not
 * sideways), but only as far as {@link TAUT_CLEARANCE_M} over the deck: the
 * purchase cable's pull takes up the rest. A strap that cannot reach is
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
    const floor = BARRICADE_DECK_Y + TAUT_CLEARANCE_M;
    // The deepest sag that keeps every point of the run over the floor.
    let maxSag = Infinity;
    for (let k = 1; k < DRAPE_SAMPLES; k++) {
        const t = k / DRAPE_SAMPLES;
        const y = end.y + (bottom.y - end.y) * t;
        maxSag = Math.min(maxSag, Math.max(0, y - floor) / (4 * t * (1 - t)));
    }
    const sagged = (sag: number) => {
        const pts: V3[] = [];
        for (let k = 1; k < DRAPE_SAMPLES; k++) {
            const t = k / DRAPE_SAMPLES;
            const q = end.clone().lerp(bottom, t);
            q.y -= sag * 4 * t * (1 - t);
            pts.push(q);
        }
        return pts;
    };
    const lengthOf = (pts: V3[]) => polylineLength([end, ...pts, bottom]);
    let sag = maxSag;
    if (lengthOf(sagged(maxSag)) > free) {
        // Long enough to sag less than the floor allows: s by bisection.
        let lo = 0;
        let hi = maxSag;
        for (let i = 0; i < 40; i++) {
            const m = (lo + hi) / 2;
            if (lengthOf(sagged(m)) < free) lo = m;
            else hi = m;
        }
        sag = (lo + hi) / 2;
    }
    out.push(...sagged(sag), bottom.clone());
    return out;
}

/**
 * A strap of up to `length` lying along the lower strap out from its station
 * (arc `at`) to the port (`port`) or starboard end, and on along the
 * purchase cable toward its sheave, ending at the station it is sewn to:
 * with nothing holding its top, the pull has laid it out along the line of
 * the pull, clear of the airframe.
 */
function alongBelt(lower: readonly V3[], arc: readonly number[], at: number, port: boolean, length: number, sheave: V3): V3[] {
    const total = arc[arc.length - 1];
    const toEnd = port ? at : total - at;
    const onBelt = Math.min(length, toEnd);
    const end = port ? lower[0] : lower[lower.length - 1];
    // Along the cable only as far as it stays clear of the deck.
    const floor = BARRICADE_DECK_Y + TAUT_CLEARANCE_M;
    const cableLen = end.distanceTo(sheave);
    const drop = end.y - sheave.y;
    const clearOnCable = drop > 1e-6 ? cableLen * Math.min(1, Math.max(0, (end.y - floor) / drop)) : cableLen;
    const onCable = Math.min(length - onBelt, clearOnCable);
    // From the far end of the strap back to its station.
    const out: V3[] = [];
    if (onCable > 1e-3) out.push(end.clone().addScaledVector(sheave.clone().sub(end).normalize(), onCable));
    const lo = port ? at - onBelt : at;
    const hi = port ? at : at + onBelt;
    const inner: V3[] = [];
    for (let i = 0; i < lower.length; i++) {
        if (arc[i] >= lo - 1e-9 && arc[i] < hi + 1e-9 && Math.abs(arc[i] - at) > 1e-9) inner.push(lower[i].clone());
    }
    if (!port) inner.reverse();
    out.push(...inner);
    for (const p of out) p.addScaledVector(_up, ON_BELT_M);
    out.push(pointAtArc(lower, arc, at));
    return out;
}

/** A strap rerouted round the airframe clears its skin by this much (m), and is rerouted at most this many times per span. */
const HULL_CLEARANCE_M = 0.06;
const HULL_REROUTES = 6;
const _hit = bvhHit();

/**
 * `pts` with every span that passes through the drawn airframe rerouted
 * round it: over the skin it crossed when the span runs nearer the top of
 * the airframe there, under it otherwise. A strap pulled straight, or
 * sagging, to its joint otherwise cuts through a tailplane, a flap or a gear
 * leg on its way.
 */
function clearOfHull(pts: V3[], hull: TriangleBvh, pose: BarricadeCatchPose, roundFront = false): V3[] {
    const inv = pose.quaternion.clone().invert();
    const toBody = (p: V3) => p.clone().sub(pose.position).applyQuaternion(inv);
    const toLocal = (p: V3) => p.clone().applyQuaternion(pose.quaternion).add(pose.position);
    const floor = BARRICADE_DECK_Y + DECK_CLEARANCE_M;
    const body = pts.map(toBody);
    const top = hull.bounds[4] + 1;
    const bottom = hull.bounds[1] - 1;
    // The next skin straight up or down from (x, y, z), body frame: through
    // the part a span hit, not to the far side of everything in that column
    // (under a wing that would be the wheel on the deck).
    const skinFrom = (x: number, y: number, z: number, up: boolean) =>
        bvhSegmentHit(hull, x, y + (up ? 0.005 : -0.005), z, x, up ? top : bottom, z, _hit) ? _hit.y : undefined;
    // The next skin straight ahead (+z, the nose) from (x, y, z).
    const front = hull.bounds[5] + 1;
    const skinAhead = (x: number, y: number, z: number) =>
        bvhSegmentHit(hull, x, y, z + 0.005, x, y, front, _hit) ? _hit.z : undefined;
    const out: V3[] = [body[0]];
    const route = (a: V3, b: V3, depth: number) => {
        if (depth >= HULL_REROUTES || !bvhSegmentHit(hull, a.x, a.y, a.z, b.x, b.y, b.z, _hit)) {
            out.push(b);
            return;
        }
        const hx = _hit.x, hy = _hit.y, hz = _hit.z;
        // The part's skin above and below the crossing: round the thinner
        // way, never under the deck.
        const hi = skinFrom(hx, hy, hz, true) ?? hy;
        const lo = skinFrom(hx, hy, hz, false) ?? hy;
        const under = new THREE.Vector3(hx, lo - HULL_CLEARANCE_M, hz);
        const overIt = new THREE.Vector3(hx, hi + HULL_CLEARANCE_M, hz);
        let via = hi - hy < hy - lo ? overIt : under;
        if (via === under && toLocal(under).y < floor) {
            // A part standing on the deck (a gear leg): the lower strap,
            // running across it, goes round its front, the way it is caught,
            // unless that is a long way; anything else over the top.
            const ahead = roundFront ? skinAhead(hx, hy, hz) : undefined;
            via = ahead !== undefined && ahead - hz < hi - hy
                ? new THREE.Vector3(hx, hy, ahead + HULL_CLEARANCE_M)
                : overIt;
        }
        route(a, via, depth + 1);
        route(via, b, depth + 1);
    };
    for (let i = 1; i < body.length; i++) route(body[i - 1], body[i], 0);
    return out.map(toLocal);
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

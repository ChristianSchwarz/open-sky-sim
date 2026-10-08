/**
 * Bridges side by side made one: two decks running parallel a few metres
 * apart (a dual carriageway's two spans, a road beside a railway over the
 * same valley) are joined into one wide structure. Along the stretch they
 * run together the parapets facing each other are left out
 * (BridgePlan.openSides) and the gap between their edges is closed by a slab
 * of its own, from one deck's edge to the other's at each one's height,
 * with a block under its ends where the decks end on the ground. Piers and
 * the outer parapets stay as each span planned them.
 */

import { BridgeRole } from '../../src/script/terrain/pbr';
import { BridgeFrame, BridgeMesh, buildPrismMesh } from './bridgeMesh';
import { BridgePlan } from './bridges';

/**
 * Widest gap between two decks' edges that is closed, metres: a motorway's
 * twin viaducts (the A7 over the Sinn) stand 6-8 m apart over most of
 * their length; at 6 m only their ends were joined.
 */
export const JOIN_GAP_M = 10;
/** Two decks overlapping by this little are side by side however close, metres (a parapet's width). */
const JOIN_OVERLAP_M = 1;
/**
 * Furthest apart in height two decks may be and still be joined, metres:
 * past it they are two levels. A street's deck beside a railway's over the
 * B2 at Garmisch stood 2-3 m above it, one structure all the same.
 */
export const JOIN_RISE_M = 4;
/** Further apart than this, the joining top is concrete, not a road surface, metres. */
const JOIN_FLAT_RISE_M = 0.5;
/** ... and than this, the higher deck keeps its parapet over the drop, metres. */
const JOIN_PARAPET_RISE_M = 1;
/** Shortest stretch side by side that is joined, metres. */
export const JOIN_MIN_M = 10;
/** Least the two decks' directions may agree (cosine) to run side by side. */
const JOIN_PARALLEL = Math.cos((15 * Math.PI) / 180);
/** A joined stretch ending this near a deck's end ends on the ground there: a block under it, metres. */
const JOIN_END_NEAR_M = 4;
/** Depth of the block under a joined slab's end along the decks, metres (an abutment's). */
const JOIN_END_DEPTH_M = 3;
/** Deepest such a block is built, metres. */
const JOIN_END_MAX_M = 8;

/** A stretch where plan `a` runs beside plan `b`. */
export interface BridgeJoin {
    a: number;
    b: number;
    /** Which side of each faces the other: 1 its left (+across), -1 its right. */
    sideA: 1 | -1;
    sideB: 1 | -1;
    /** Per station of `a` along the stretch: a's station index, and where b's centreline is beside it. */
    pairs: Array<{ i: number; sB: number; x: number; z: number; deckY: number; groundY: number; leftX: number; leftZ: number }>;
}

/** Horizontal unit tangent of a plan's deck at station `i`. */
function tangent(plan: BridgePlan, i: number): [number, number] {
    const a = plan.stations[Math.max(0, i - 1)], b = plan.stations[Math.min(plan.stations.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    return l > 1e-9 ? [dx / l, dz / l] : [1, 0];
}

/** The point of `plan`'s centreline nearest (x, z): distance along, position, deck and ground heights, left unit normal. */
function nearestOn(plan: BridgePlan, x: number, z: number) {
    const st = plan.stations;
    let best: { d: number; s: number; x: number; z: number; deckY: number; groundY: number; tx: number; tz: number; inside: boolean } | undefined;
    for (let j = 0; j + 1 < st.length; j++) {
        const a = st[j], b = st[j + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l2 = dx * dx + dz * dz;
        if (l2 < 1e-12) {
            continue;
        }
        const raw = ((x - a.x) * dx + (z - a.z) * dz) / l2;
        const t = Math.max(0, Math.min(1, raw));
        const px = a.x + dx * t, pz = a.z + dz * t;
        const d = Math.hypot(x - px, z - pz);
        if (!best || d < best.d) {
            const l = Math.sqrt(l2);
            best = {
                d, s: a.s + (b.s - a.s) * t, x: px, z: pz,
                deckY: a.deckY + (b.deckY - a.deckY) * t, groundY: a.groundY + (b.groundY - a.groundY) * t,
                tx: dx / l, tz: dz / l, inside: (raw >= 0 || j > 0) && (raw <= 1 || j + 2 < st.length),
            };
        }
    }
    return best;
}

/**
 * Every stretch where two of `plans` run side by side: parallel, their
 * decks' edges at most JOIN_GAP_M apart (and not one over the other), their
 * tops within JOIN_RISE_M, for JOIN_MIN_M or more. Each pair once, from the
 * longer plan's stations (of two as long, the lower `ids` entry's, or the
 * earlier). Tunnels are never joined.
 */
export function findJoins(plans: readonly BridgePlan[], ids?: readonly string[]): BridgeJoin[] {
    const out: BridgeJoin[] = [];
    const usable = (p: BridgePlan) => p.structure !== 'tunnel' && p.stations.length >= 2;
    for (let ia = 0; ia < plans.length; ia++) {
        for (let ib = 0; ib < plans.length; ib++) {
            const A = plans[ia], B = plans[ib];
            // The longer is a; of two as long, the lower id (stable across
            // tiles, so both see the same pair the same way round).
            const second = ids ? ids[ia] > ids[ib] : ia > ib;
            if (ia === ib || !usable(A) || !usable(B) || A.lengthM < B.lengthM || (A.lengthM === B.lengthM && second)) {
                continue;
            }
            const halfA = A.deckWidthM / 2, halfB = B.deckWidthM / 2;
            // A cheap reject: their boxes apart by more than the widest gap.
            const box = (p: BridgePlan) => [
                Math.min(...p.stations.map(s => s.x)), Math.min(...p.stations.map(s => s.z)),
                Math.max(...p.stations.map(s => s.x)), Math.max(...p.stations.map(s => s.z)),
            ];
            const [a0, a1, a2, a3] = box(A), [b0, b1, b2, b3] = box(B);
            const reach = halfA + halfB + JOIN_GAP_M;
            if (a0 - reach > b2 || b0 - reach > a2 || a1 - reach > b3 || b1 - reach > a3) {
                continue;
            }
            let run: BridgeJoin | undefined;
            const close = () => {
                if (run && run.pairs.length >= 2) {
                    const len = A.stations[run.pairs[run.pairs.length - 1].i].s - A.stations[run.pairs[0].i].s;
                    if (len >= JOIN_MIN_M) {
                        out.push(run);
                    }
                }
                run = undefined;
            };
            for (let i = 0; i < A.stations.length; i++) {
                const st = A.stations[i];
                const near = nearestOn(B, st.x, st.z);
                const [tx, tz] = tangent(A, i);
                let ok = false;
                let sideA: 1 | -1 = 1, sideB: 1 | -1 = 1;
                if (near && near.inside && Math.abs(tx * near.tx + tz * near.tz) >= JOIN_PARALLEL) {
                    const gap = near.d - halfA - halfB;
                    sideA = (near.x - st.x) * -tz + (near.z - st.z) * tx >= 0 ? 1 : -1;
                    sideB = (st.x - near.x) * -near.tz + (st.z - near.z) * near.tx >= 0 ? 1 : -1;
                    ok = gap >= -JOIN_OVERLAP_M && gap <= JOIN_GAP_M && Math.abs(st.deckY - near.deckY) <= JOIN_RISE_M;
                }
                if (ok && run && (run.sideA !== sideA || run.sideB !== sideB)) {
                    close();
                }
                if (!ok || !near) {
                    close();
                    continue;
                }
                run ??= { a: ia, b: ib, sideA, sideB, pairs: [] };
                run.pairs.push({ i, sB: near.s, x: near.x, z: near.z, deckY: near.deckY, groundY: near.groundY, leftX: -near.tz, leftZ: near.tx });
            }
            close();
        }
    }
    return out;
}

/**
 * Marks each join's stretch on both plans' facing sides as open (no parapet
 * there: BridgePlan.openSides), before their meshes are built.
 */
export function openJoinedSides(plans: BridgePlan[], joins: readonly BridgeJoin[]): void {
    for (const j of joins) {
        const A = plans[j.a], B = plans[j.b];
        const sA0 = A.stations[j.pairs[0].i].s, sA1 = A.stations[j.pairs[j.pairs.length - 1].i].s;
        const sB = j.pairs.map(p => p.sB);
        // Over a drop of more than JOIN_PARAPET_RISE_M the higher deck keeps
        // its parapet; the lower one's faces the joining slope.
        const rise = Math.max(...j.pairs.map(p => Math.abs(A.stations[p.i].deckY - p.deckY)));
        const aHigher = j.pairs.reduce((t, p) => t + A.stations[p.i].deckY - p.deckY, 0) > 0;
        if (rise <= JOIN_PARAPET_RISE_M || !aHigher) {
            (A.openSides ??= []).push({ side: j.sideA, s0: sA0, s1: sA1 });
        }
        if (rise <= JOIN_PARAPET_RISE_M || aHigher) {
            (B.openSides ??= []).push({ side: j.sideB, s0: Math.min(...sB), s1: Math.max(...sB) });
        }
    }
}

/**
 * The slab closing a join's gap, as a mesh: from a's facing deck edge to
 * b's at every station of the stretch, top at each deck's height, as thick
 * as each; a block under each end that lies at a deck's end, down to the
 * ground; the ends closed otherwise. Its top is drawn as a road deck where
 * both decks are roads at much the same height, as concrete where a railway
 * is one of them or it slopes between two levels.
 */
export function buildJoinMesh(plans: readonly BridgePlan[], join: BridgeJoin, frame: BridgeFrame): BridgeMesh {
    const A = plans[join.a], B = plans[join.b];
    const halfA = A.deckWidthM / 2, halfB = B.deckWidthM / 2;
    const rise = Math.max(...join.pairs.map(p => Math.abs(A.stations[p.i].deckY - p.deckY)));
    const top = A.deckRole === BridgeRole.RailDeck || B.deckRole === BridgeRole.RailDeck || rise > JOIN_FLAT_RISE_M
        ? BridgeRole.Concrete : BridgeRole.Deck;
    type P = [number, number, number];
    const edges = join.pairs.map(p => {
        const st = A.stations[p.i];
        const [tx, tz] = tangent(A, p.i);
        const ax = st.x - tz * halfA * join.sideA, az = st.z + tx * halfA * join.sideA;
        const bx = p.x + p.leftX * halfB * join.sideB, bz = p.z + p.leftZ * halfB * join.sideB;
        return {
            a: [ax, st.deckY, az] as P, b: [bx, p.deckY, bz] as P,
            aLow: [ax, st.deckY - A.deckThicknessM, az] as P, bLow: [bx, p.deckY - B.deckThicknessM, bz] as P,
            groundY: Math.min(st.groundY, p.groundY), tx, tz, s: st.s, sB: p.sB,
        };
    });
    const prisms: Array<{ c0: P[]; c1: P[]; topRole: number; caps: boolean }> = [];
    for (let k = 0; k + 1 < edges.length; k++) {
        const e0 = edges[k], e1 = edges[k + 1];
        // Closed at the stretch's two ends (and, harmlessly, inside the first and last piece).
        const caps = k === 0 || k + 2 === edges.length;
        prisms.push({ c0: [e0.a, e0.b, e0.bLow, e0.aLow], c1: [e1.a, e1.b, e1.bLow, e1.aLow], topRole: top, caps });
    }
    // Each end on the ground at a deck's end: a block down to it.
    for (const [e, dir] of [[edges[0], -1], [edges[edges.length - 1], 1]] as const) {
        const atEnd = e.s <= JOIN_END_NEAR_M || e.s >= A.lengthM - JOIN_END_NEAR_M
            || e.sB <= JOIN_END_NEAR_M || e.sB >= B.lengthM - JOIN_END_NEAR_M;
        const lowY = Math.min(e.aLow[1], e.bLow[1]);
        const base = Math.max(e.groundY - 1.5, lowY - JOIN_END_MAX_M);
        if (atEnd && lowY - base > 0.1) {
            const d = (JOIN_END_DEPTH_M / 2) * dir;
            const ring = (y: number): P[] => [
                [e.a[0] - e.tx * d, y, e.a[2] - e.tz * d], [e.b[0] - e.tx * d, y, e.b[2] - e.tz * d],
                [e.b[0] + e.tx * d, y, e.b[2] + e.tz * d], [e.a[0] + e.tx * d, y, e.a[2] + e.tz * d],
            ];
            prisms.push({ c0: ring(lowY), c1: ring(base), topRole: BridgeRole.Concrete, caps: false });
        }
    }
    return buildPrismMesh(prisms, frame);
}

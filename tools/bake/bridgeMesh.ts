/**
 * Turns a BridgePlan into flat-shaded triangles: deck slab, parapets, piers
 * and abutment blocks. Everything is a convex prism, and every face is
 * oriented away from its prism's own centre, so normals are right without
 * tracking winding by hand.
 *
 * The plan is in a true local frame (see tileSurface.ts): x = u and z = v
 * are horizontal, y = h is the height along the real vertical. Each vertex is
 * put back into the tile's own axes as u*a + v*b + h*up, so a pier stands on
 * the real vertical however far the tile's axes lean from it.
 * Arch ribs, truss members and cable towers are not built yet: a span of
 * those structures gets the same deck and piers as a beam.
 */

import { BridgeRole } from '../../src/script/terrain/pbr';
import { BridgePlan } from './bridges';

export const PARAPET_HEIGHT_M = 0.9;
export const PARAPET_WIDTH_M = 0.4;
/** Depth of an abutment block along the deck, metres. */
export const ABUTMENT_DEPTH_M = 3;
/** Tallest an abutment block is built: past this the end is a bad ground read, not a tall bank. */
export const ABUTMENT_MAX_M = 8;
/** Least height an abutment block is worth building. */
const ABUTMENT_MIN_M = 0.1;

type P = [number, number, number];

/** How a plan's (u, h, v) points map into the tile's axes; see LocalFrame in tileSurface.ts. */
export interface BridgeFrame {
    a: P;
    b: P;
    up: P;
}

/** u -> x, v -> z, h -> y: a plan already in the tile's own axes (tests, flat frames). */
export const IDENTITY_FRAME: BridgeFrame = { a: [1, 0, 0], b: [0, 0, 1], up: [0, 1, 0] };

export interface BridgeMesh {
    positions: Float32Array;
    normals: Float32Array;
    roles: Uint8Array;
    indices: Uint32Array;
    vertexCount: number;
    triangleCount: number;
}

class Soup {
    readonly pos: number[] = [];
    readonly nrm: number[] = [];
    readonly role: number[] = [];
    readonly idx: number[] = [];

    constructor(private readonly frame: BridgeFrame) {}

    /** A plan point (u, h, v) in the tile's own axes. */
    private real(p: P): P {
        const { a, b, up } = this.frame;
        return [
            p[0] * a[0] + p[2] * b[0] + p[1] * up[0],
            p[0] * a[1] + p[2] * b[1] + p[1] * up[1],
            p[0] * a[2] + p[2] * b[2] + p[1] * up[2],
        ];
    }

    /** One quad a-b-c-d, wound to face away from `inside` (a sheared point). */
    quad(a: P, b: P, c: P, d: P, role: number, inside: P): void {
        let pts = [this.real(a), this.real(b), this.real(c), this.real(d)];
        const ref = this.real(inside);
        const nx = (pts: P[]) => {
            const u = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
            const v = [pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]];
            return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        };
        let n = nx(pts);
        const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4 - ref[0];
        const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4 - ref[1];
        const cz = (pts[0][2] + pts[1][2] + pts[2][2] + pts[3][2]) / 4 - ref[2];
        if (n[0] * cx + n[1] * cy + n[2] * cz < 0) {
            pts = [pts[0], pts[3], pts[2], pts[1]];
            n = nx(pts);
        }
        const len = Math.hypot(n[0], n[1], n[2]);
        if (!(len > 1e-9)) {
            return;   // a degenerate face: two stations on top of each other
        }
        const base = this.pos.length / 3;
        for (const p of pts) {
            this.pos.push(p[0], p[1], p[2]);
            this.nrm.push(n[0] / len, n[1] / len, n[2] / len);
            this.role.push(role);
        }
        this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    /**
     * A prism between two four-corner sections (top-left, top-right,
     * bottom-right, bottom-left). `topRole` colours the face between the two
     * top corners; `caps` closes the two ends.
     */
    prism(c0: P[], c1: P[], topRole: number, caps: boolean, skipBottom: boolean = false): void {
        const inside: P = [0, 0, 0];
        for (const p of [...c0, ...c1]) {
            inside[0] += p[0] / 8; inside[1] += p[1] / 8; inside[2] += p[2] / 8;
        }
        const C = BridgeRole.Concrete;
        this.quad(c0[0], c0[1], c1[1], c1[0], topRole, inside);
        this.quad(c0[1], c0[2], c1[2], c1[1], C, inside);
        if (!skipBottom) {
            this.quad(c0[2], c0[3], c1[3], c1[2], C, inside);
        }
        this.quad(c0[3], c0[0], c1[0], c1[3], C, inside);
        if (caps) {
            this.quad(c0[0], c0[1], c0[2], c0[3], C, inside);
            this.quad(c1[0], c1[1], c1[2], c1[3], C, inside);
        }
    }
}

/**
 * How far (metres) a deck station may sit off the straight line between its
 * neighbours before it is kept. The plan puts a station every 8 m whether or
 * not anything changes there, so a straight, evenly graded deck is a hundred
 * boxes where one will do; this keeps the corners, the grade breaks and the
 * arch of a lifted span, and drops the rest. Piers do not use the mesh's
 * stations, so their placement is untouched.
 */
export const DECK_SIMPLIFY_TOLERANCE_M = 0.25;

/**
 * Indices of the plan's stations the deck mesh is built from: the ends, and
 * every station Douglas-Peucker finds more than `tolerance` off the chord,
 * measured in x, z and deck height together at the station's own distance.
 */
export function keptStations(plan: BridgePlan, tolerance: number): number[] {
    const st = plan.stations;
    const keep = new Uint8Array(st.length);
    keep[0] = 1;
    keep[st.length - 1] = 1;
    const stack: [number, number][] = [[0, st.length - 1]];
    while (stack.length > 0) {
        const [a, b] = stack.pop()!;
        if (b - a < 2) {
            continue;
        }
        const span = st[b].s - st[a].s;
        let worst = -1;
        let worstDev = tolerance;
        for (let i = a + 1; i < b; i++) {
            const t = span > 0 ? (st[i].s - st[a].s) / span : 0;
            const dev = Math.hypot(
                st[i].x - (st[a].x + (st[b].x - st[a].x) * t),
                st[i].deckY - (st[a].deckY + (st[b].deckY - st[a].deckY) * t),
                st[i].z - (st[a].z + (st[b].z - st[a].z) * t),
            );
            if (dev > worstDev) {
                worstDev = dev;
                worst = i;
            }
        }
        if (worst >= 0) {
            keep[worst] = 1;
            stack.push([a, worst], [worst, b]);
        }
    }
    const out: number[] = [];
    for (let i = 0; i < st.length; i++) {
        if (keep[i]) {
            out.push(i);
        }
    }
    return out;
}

/**
 * Where a point `off` metres left of the centreline lies at station `i`, in
 * plan: square across the deck, or at an end along its skewed line
 * (BridgePlan.endSkew), which keeps the same width across the deck.
 */
function across(plan: BridgePlan, i: number, off: number): [number, number] {
    const st = plan.stations[i];
    const [tx, tz] = tangentAt(plan, i);
    const px = -tz, pz = tx;
    const skew = i === 0 ? plan.endSkew?.[0] : i === plan.stations.length - 1 ? plan.endSkew?.[1] : undefined;
    if (!skew) {
        return [st.x + px * off, st.z + pz * off];
    }
    const k = off / (skew[0] * px + skew[1] * pz);
    return [st.x + skew[0] * k, st.z + skew[1] * k];
}

/** How far a skewed end's corners stand off its station along the deck, metres (0 square). */
function skewShift(plan: BridgePlan, end: 0 | 1): number {
    const skew = plan.endSkew?.[end];
    if (!skew) {
        return 0;
    }
    const i = end === 0 ? 0 : plan.stations.length - 1;
    const [tx, tz] = tangentAt(plan, i);
    const along = skew[0] * tx + skew[1] * tz, wide = skew[0] * -tz + skew[1] * tx;
    return Math.abs((plan.deckWidthM / 2) * along / wide);
}

/** Horizontal unit tangent of the deck at station `i`, from its neighbours. */
function tangentAt(plan: BridgePlan, i: number): [number, number] {
    const a = plan.stations[Math.max(0, i - 1)];
    const b = plan.stations[Math.min(plan.stations.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    return len > 1e-9 ? [dx / len, dz / len] : [1, 0];
}

function addPlan(s: Soup, plan: BridgePlan, tolerance: number): void {
    if (plan.structure === 'tunnel' || plan.stations.length < 2) {
        return;
    }
    addDeck(s, plan, tolerance);
    addPiers(s, plan);
    addAbutments(s, plan);
}

function finish(s: Soup): BridgeMesh {
    return {
        positions: Float32Array.from(s.pos),
        normals: Float32Array.from(s.nrm),
        roles: Uint8Array.from(s.role),
        indices: Uint32Array.from(s.idx),
        vertexCount: s.pos.length / 3,
        triangleCount: s.idx.length / 3,
    };
}

/**
 * How far the track floats over the deck top, metres. Far less than a
 * ground stroke's lift (a share of a cell, most of a metre at the leaf): the
 * deck is a flat face drawn from close, and the track only has to clear it
 * in the depth test.
 */
export const TRACK_LIFT_M = 0.2;

/** A track stroke in the PTR1 layout, tile-local metres (see pbr.ts). */
export interface TrackStroke {
    positions: Float32Array;
    directions: Float32Array;
    halfWidthsM: Float32Array;
    classes: Uint8Array;
    alongM: Float32Array;
    indices: Uint32Array;
}

/**
 * The track along a rail deck's top, as a stroke the road strokes' rail
 * material draws (sleepers, rails): one vertex pair per deck station the deck
 * itself kept, so the stroke lies on the very faces the deck is built from.
 * `halfM` is half the track bed's width; `classByte` the rail class, which
 * gets sideBit on the second vertex of each pair.
 */
export function buildTrackStroke(
    plan: BridgePlan, frame: BridgeFrame, halfM: number, classByte: number, sideBit: number,
    tolerance: number = DECK_SIMPLIFY_TOLERANCE_M,
): TrackStroke | undefined {
    if (plan.structure === 'tunnel' || plan.stations.length < 2) {
        return undefined;
    }
    const kept = keptStations(plan, tolerance);
    const { a, b, up } = frame;
    const real = (u: number, h: number, v: number): P => [
        u * a[0] + v * b[0] + h * up[0],
        u * a[1] + v * b[1] + h * up[1],
        u * a[2] + v * b[2] + h * up[2],
    ];
    const pos: number[] = [], dir: number[] = [], half: number[] = [], cls: number[] = [], along: number[] = [];
    const idx: number[] = [];
    let run = 0;
    let prev: P | undefined;
    for (let k = 0; k < kept.length; k++) {
        const i = kept[k];
        const st = plan.stations[i];
        const [tx, tz] = tangentAt(plan, i);
        const p = real(st.x, st.deckY + TRACK_LIFT_M, st.z);
        const d = real(-tz, 0, tx);
        const dl = Math.hypot(d[0], d[1], d[2]) || 1;
        if (prev) {
            run += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
        }
        prev = p;
        pos.push(...p, ...p);
        dir.push(d[0] / dl, d[1] / dl, d[2] / dl, -d[0] / dl, -d[1] / dl, -d[2] / dl);
        half.push(halfM, halfM);
        cls.push(classByte, classByte | sideBit);
        along.push(run, run);
        if (k > 0) {
            const l0 = (k - 1) * 2;
            idx.push(l0, l0 + 1, l0 + 3, l0, l0 + 3, l0 + 2);
        }
    }
    return {
        positions: Float32Array.from(pos), directions: Float32Array.from(dir),
        halfWidthsM: Float32Array.from(half), classes: Uint8Array.from(cls),
        alongM: Float32Array.from(along), indices: Uint32Array.from(idx),
    };
}

/** Several track strokes as one, indices rebased. */
export function concatTracks(tracks: readonly TrackStroke[]): TrackStroke {
    const verts = tracks.reduce((n, t) => n + t.positions.length / 3, 0);
    const tris = tracks.reduce((n, t) => n + t.indices.length / 3, 0);
    const out: TrackStroke = {
        positions: new Float32Array(verts * 3), directions: new Float32Array(verts * 3),
        halfWidthsM: new Float32Array(verts), classes: new Uint8Array(verts),
        alongM: new Float32Array(verts), indices: new Uint32Array(tris * 3),
    };
    let v = 0, i = 0;
    for (const t of tracks) {
        const n = t.positions.length / 3;
        out.positions.set(t.positions, v * 3);
        out.directions.set(t.directions, v * 3);
        out.halfWidthsM.set(t.halfWidthsM, v);
        out.classes.set(t.classes, v);
        out.alongM.set(t.alongM, v);
        for (let k = 0; k < t.indices.length; k++) {
            out.indices[i + k] = t.indices[k] + v;
        }
        v += n;
        i += t.indices.length;
    }
    return out;
}

/** A box in a plan's true frame (u, h, v): centre, three unit axes, half sizes along them. */
export interface PlanBox {
    centre: P;
    axes: [P, P, P];
    half: [number, number, number];
    role: number;
}

/**
 * Boxes as flat-shaded triangles in the tile's axes, every face in the box's
 * own role: the level-crossing furniture (crossingFurniture.ts).
 */
export function buildBoxMesh(boxes: readonly PlanBox[], frame: BridgeFrame): BridgeMesh {
    const s = new Soup(frame);
    for (const b of boxes) {
        const corner = (i: number, j: number, k: number): P => [
            b.centre[0] + b.axes[0][0] * b.half[0] * i + b.axes[1][0] * b.half[1] * j + b.axes[2][0] * b.half[2] * k,
            b.centre[1] + b.axes[0][1] * b.half[0] * i + b.axes[1][1] * b.half[1] * j + b.axes[2][1] * b.half[2] * k,
            b.centre[2] + b.axes[0][2] * b.half[0] * i + b.axes[1][2] * b.half[1] * j + b.axes[2][2] * b.half[2] * k,
        ];
        const faces: [P, P, P, P][] = [
            [corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(1, -1, 1)],
            [corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1)],
            [corner(-1, 1, -1), corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1)],
            [corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)],
            [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)],
            [corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1), corner(1, -1, -1)],
        ];
        for (const [a, bb, c, d] of faces) {
            s.quad(a, bb, c, d, b.role, b.centre);
        }
    }
    return finish(s);
}

/** One bridge's triangles, put into the tile's axes with `frame` (see tileSurface.ts). */
export function buildBridgeMesh(
    plan: BridgePlan, frame: BridgeFrame, tolerance: number = DECK_SIMPLIFY_TOLERANCE_M,
): BridgeMesh {
    const s = new Soup(frame);
    addPlan(s, plan, tolerance);
    return finish(s);
}

/**
 * Prisms (two four-corner sections each, as Soup.prism takes them) as one
 * mesh in the tile's axes: the slab joining two bridges side by side
 * (bridgeJoin.ts).
 */
export function buildPrismMesh(
    prisms: ReadonlyArray<{ c0: P[]; c1: P[]; topRole: number; caps: boolean }>, frame: BridgeFrame,
): BridgeMesh {
    const s = new Soup(frame);
    for (const p of prisms) {
        s.prism(p.c0, p.c1, p.topRole, p.caps);
    }
    return finish(s);
}

/** Several plans into one mesh, for a tile. */
export function buildTileBridgeMesh(
    plans: readonly BridgePlan[], frame: BridgeFrame, tolerance: number = DECK_SIMPLIFY_TOLERANCE_M,
): BridgeMesh {
    const s = new Soup(frame);
    for (const plan of plans) {
        addPlan(s, plan, tolerance);
    }
    return finish(s);
}

function addDeck(s: Soup, plan: BridgePlan, tolerance: number): void {
    const half = plan.deckWidthM / 2;
    const T = plan.deckThicknessM;
    const section = (i: number, offL: number, offR: number, top: number, bottom: number): P[] => {
        const st = plan.stations[i];
        const [lx, lz] = across(plan, i, offL), [rx, rz] = across(plan, i, offR);
        return [
            [lx, st.deckY + top, lz],
            [rx, st.deckY + top, rz],
            [rx, st.deckY + bottom, rz],
            [lx, st.deckY + bottom, lz],
        ];
    };
    const last = plan.stations.length - 1;
    // A skewed end's corners reach along the deck: no station in between may
    // stand within that, or the slab would fold back on itself.
    const shiftA = skewShift(plan, 0), shiftB = skewShift(plan, 1);
    const total = plan.stations[last].s;
    const kept = keptStations(plan, tolerance).filter((i, k, all) => k === 0 || k === all.length - 1
        || (plan.stations[i].s > shiftA + 1 && plan.stations[i].s < total - shiftB - 1));
    // A side joined to the bridge beside it (BridgePlan.openSides) has no
    // parapet along the joined stretch.
    const open = (side: 1 | -1, sa: number, sb: number) =>
        (plan.openSides ?? []).some(o => o.side === side && (sa + sb) / 2 >= o.s0 - 1e-6 && (sa + sb) / 2 <= o.s1 + 1e-6);
    for (let k = 0; k + 1 < kept.length; k++) {
        const i = kept[k], j = kept[k + 1];
        s.prism(section(i, half, -half, 0, -T), section(j, half, -half, 0, -T), plan.deckRole ?? BridgeRole.Deck, false);
        // Parapets, both sides: outer edge at the deck's edge, inner a kerb in.
        // Their undersides sit on the deck, so they are not built.
        const inner = half - PARAPET_WIDTH_M;
        const sa = plan.stations[i].s, sb = plan.stations[j].s;
        if (!open(1, sa, sb)) {
            s.prism(section(i, half, inner, PARAPET_HEIGHT_M, 0), section(j, half, inner, PARAPET_HEIGHT_M, 0),
                BridgeRole.Concrete, false, true);
        }
        if (!open(-1, sa, sb)) {
            s.prism(section(i, -inner, -half, PARAPET_HEIGHT_M, 0), section(j, -inner, -half, PARAPET_HEIGHT_M, 0),
                BridgeRole.Concrete, false, true);
        }
    }
    // Close the two ends of the slab and of each parapet so the deck is not open.
    for (const i of [0, last]) {
        const st = plan.stations[i];
        const [tx, tz] = tangentAt(plan, i);
        const endFace = (offL: number, offR: number, top: number, bottom: number) => {
            const c = section(i, offL, offR, top, bottom);
            const inside: P = [st.x - tx * (i === 0 ? -1 : 1), st.deckY, st.z - tz * (i === 0 ? -1 : 1)];
            s.quad(c[0], c[1], c[2], c[3], BridgeRole.Concrete, inside);
        };
        endFace(half, -half, 0, -T);
        const s0 = plan.stations[i].s;
        if (!open(1, s0, s0)) {
            endFace(half, half - PARAPET_WIDTH_M, PARAPET_HEIGHT_M, 0);
        }
        if (!open(-1, s0, s0)) {
            endFace(-(half - PARAPET_WIDTH_M), -half, PARAPET_HEIGHT_M, 0);
        }
    }
}

function addPiers(s: Soup, plan: BridgePlan): void {
    for (const p of plan.piers) {
        if (p.topY - p.baseY < 0.5) {
            continue;
        }
        // Its width square across the deck, or along the road beside it.
        const [px, pz] = p.across ?? [Math.cos(p.heading), Math.sin(p.heading)];
        const tx = pz, tz = -px;
        const w = p.widthM / 2;
        const d = Math.min(p.widthM * 0.6, 3) / 2;
        const ring = (y: number): P[] => [
            [p.x + px * w + tx * d, y, p.z + pz * w + tz * d],
            [p.x - px * w + tx * d, y, p.z - pz * w + tz * d],
            [p.x - px * w - tx * d, y, p.z - pz * w - tz * d],
            [p.x + px * w - tx * d, y, p.z + pz * w - tz * d],
        ];
        // Four sides only: the top is under the deck, the base underground.
        s.prism(ring(p.topY), ring(p.baseY), BridgeRole.Concrete, false);
    }
}

function addAbutments(s: Soup, plan: BridgePlan): void {
    const last = plan.stations.length - 1;
    const half = plan.deckWidthM / 2;
    for (const i of [0, last]) {
        const st = plan.stations[i];
        const top = st.deckY - plan.deckThicknessM;
        const base = Math.max(st.groundY - 1.5, top - ABUTMENT_MAX_M);
        if (top - base < ABUTMENT_MIN_M) {
            continue;
        }
        const [tx, tz] = tangentAt(plan, i);
        const d = ABUTMENT_DEPTH_M / 2;
        // Along the end's line: square across the deck, or parallel to the
        // road under a skew bridge.
        const [lx, lz] = across(plan, i, half), [rx, rz] = across(plan, i, -half);
        const ring = (y: number): P[] => [
            [lx + tx * d, y, lz + tz * d],
            [rx + tx * d, y, rz + tz * d],
            [rx - tx * d, y, rz - tz * d],
            [lx - tx * d, y, lz - tz * d],
        ];
        // Four sides: the top meets the deck's underside, the base is underground.
        s.prism(ring(top), ring(base), BridgeRole.Concrete, false);
    }
}

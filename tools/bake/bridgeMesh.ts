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

/** One bridge's triangles, put into the tile's axes with `frame` (see tileSurface.ts). */
export function buildBridgeMesh(
    plan: BridgePlan, frame: BridgeFrame, tolerance: number = DECK_SIMPLIFY_TOLERANCE_M,
): BridgeMesh {
    const s = new Soup(frame);
    addPlan(s, plan, tolerance);
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
        const [tx, tz] = tangentAt(plan, i);
        const px = -tz, pz = tx;
        return [
            [st.x + px * offL, st.deckY + top, st.z + pz * offL],
            [st.x + px * offR, st.deckY + top, st.z + pz * offR],
            [st.x + px * offR, st.deckY + bottom, st.z + pz * offR],
            [st.x + px * offL, st.deckY + bottom, st.z + pz * offL],
        ];
    };
    const last = plan.stations.length - 1;
    const kept = keptStations(plan, tolerance);
    for (let k = 0; k + 1 < kept.length; k++) {
        const i = kept[k], j = kept[k + 1];
        s.prism(section(i, half, -half, 0, -T), section(j, half, -half, 0, -T), BridgeRole.Deck, false);
        // Parapets, both sides: outer edge at the deck's edge, inner a kerb in.
        // Their undersides sit on the deck, so they are not built.
        const inner = half - PARAPET_WIDTH_M;
        s.prism(section(i, half, inner, PARAPET_HEIGHT_M, 0), section(j, half, inner, PARAPET_HEIGHT_M, 0),
            BridgeRole.Concrete, false, true);
        s.prism(section(i, -inner, -half, PARAPET_HEIGHT_M, 0), section(j, -inner, -half, PARAPET_HEIGHT_M, 0),
            BridgeRole.Concrete, false, true);
    }
    // Close the two ends of the slab and of each parapet so the deck is not open.
    for (const i of [0, last]) {
        const st = plan.stations[i];
        const [tx, tz] = tangentAt(plan, i);
        const px = -tz, pz = tx;
        const endFace = (offL: number, offR: number, top: number, bottom: number) => {
            const c: P[] = [
                [st.x + px * offL, st.deckY + top, st.z + pz * offL],
                [st.x + px * offR, st.deckY + top, st.z + pz * offR],
                [st.x + px * offR, st.deckY + bottom, st.z + pz * offR],
                [st.x + px * offL, st.deckY + bottom, st.z + pz * offL],
            ];
            const inside: P = [st.x - tx * (i === 0 ? -1 : 1), st.deckY, st.z - tz * (i === 0 ? -1 : 1)];
            s.quad(c[0], c[1], c[2], c[3], BridgeRole.Concrete, inside);
        };
        endFace(half, -half, 0, -T);
        endFace(half, half - PARAPET_WIDTH_M, PARAPET_HEIGHT_M, 0);
        endFace(-(half - PARAPET_WIDTH_M), -half, PARAPET_HEIGHT_M, 0);
    }
}

function addPiers(s: Soup, plan: BridgePlan): void {
    for (const p of plan.piers) {
        if (p.topY - p.baseY < 0.5) {
            continue;
        }
        const tx = Math.sin(p.heading), tz = -Math.cos(p.heading);
        const px = Math.cos(p.heading), pz = Math.sin(p.heading);
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
        const px = -tz, pz = tx;
        const d = ABUTMENT_DEPTH_M / 2;
        const ring = (y: number): P[] => [
            [st.x + px * half + tx * d, y, st.z + pz * half + tz * d],
            [st.x - px * half + tx * d, y, st.z - pz * half + tz * d],
            [st.x - px * half - tx * d, y, st.z - pz * half - tz * d],
            [st.x + px * half - tx * d, y, st.z + pz * half - tz * d],
        ];
        // Four sides: the top meets the deck's underside, the base is underground.
        s.prism(ring(top), ring(base), BridgeRole.Concrete, false);
    }
}

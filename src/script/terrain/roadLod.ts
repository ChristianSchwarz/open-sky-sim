/**
 * Coarser index lists over a tile's road strokes, for drawing them far off.
 *
 * A stroke is draped over its tile's land: every facet it crosses adds a
 * centreline point, so a coarse tile's roads carry a point every few tens of
 * metres although the tile is only drawn kilometres away, where a pixel spans
 * metres. Each level here drops the centreline points that lie within its
 * tolerance of the chord between the points it keeps, and the renderer picks
 * per tile the coarsest level still under half a pixel (see roadLevelFor).
 *
 * The vertices stay as they are: a level is another index list over the same
 * buffers, joining kept pairs with the quads the original segments used. A
 * chord may run above the land it was draped on, by up to the tolerance, but
 * never below it (DOWN_TOLERANCE_M), so the land never hides a road. The land
 * under a stroke is flat between two of its points (they are where it crosses
 * facet edges), so checking the dropped points bounds the whole chord.
 *
 * Junctions, ends, and points where the width, class or track flags change are
 * always kept.
 */

import { PtrTile, ROAD_CLASS_MASK, ROAD_SIDE_BIT } from './ptr';

/** Metres off the original stroke each level allows, finest first. */
export const ROAD_LOD_TOLERANCES_M: readonly number[] = [0.25, 1, 4, 16];

/** A level is used once its tolerance is at most this share of a pixel. */
export const ROAD_LOD_MAX_PIXELS = 0.5;

/** How far a chord may dip below the land it replaces: none, to rounding. */
const DOWN_TOLERANCE_M = 0.02;

/**
 * A level is kept only if it drops at least this share of the triangles of
 * the one before it; otherwise the finer one is reused.
 */
const MIN_SAVING = 0.1;

/**
 * The levels of one stroke kind of a tile, built on demand: most tiles are
 * only ever drawn at full detail, and a dense one takes milliseconds to
 * simplify. Level 0 is `indices` itself; level i uses ROAD_LOD_TOLERANCES_M[i
 * - 1]. A level that saves too little repeats the one before it, so callers
 * can compare by reference.
 */
export class RoadLevels {
    private graph: StrokeGraph | undefined;
    private graphBuilt = false;
    /** By level; a level not asked for yet is absent. */
    private readonly levels: Array<Uint16Array | undefined>;

    /** `up` is the local vertical in the tile's axes, unit length. */
    constructor(
        private readonly tile: PtrTile,
        indices: Uint16Array,
        private readonly up: readonly [number, number, number],
    ) {
        this.levels = Array.from({ length: ROAD_LOD_TOLERANCES_M.length + 1 }, (_, i) => (i === 0 ? indices : undefined));
    }

    has(level: number): boolean {
        return this.levels[Math.min(level, this.levels.length - 1)] !== undefined;
    }

    /**
     * Build `level` straight away, skipping the ones between. A level that
     * saves too little over the finest one built below it repeats that one.
     */
    build(level: number): void {
        const at = Math.min(level, this.levels.length - 1);
        if (this.levels[at]) {
            return;
        }
        if (!this.graphBuilt) {
            this.graph = strokeGraph(this.tile, this.levels[0]!);
            this.graphBuilt = true;
        }
        const finer = this.get(at - 1);
        const next = this.graph
            ? simplify(this.tile, this.levels[0]!, this.graph, this.up, ROAD_LOD_TOLERANCES_M[at - 1])
            : finer;
        this.levels[at] = next.length <= finer.length * (1 - MIN_SAVING) ? next : finer;
    }

    /** The finest built level at or below `level`. */
    get(level: number): Uint16Array {
        for (let i = Math.min(level, this.levels.length - 1); i > 0; i--) {
            const built = this.levels[i];
            if (built) {
                return built;
            }
        }
        return this.levels[0]!;
    }
}

/** Every level of `indices` at once (see RoadLevels). */
export function roadLevels(
    tile: PtrTile, indices: Uint16Array, up: readonly [number, number, number],
): Uint16Array[] {
    const levels = new RoadLevels(tile, indices, up);
    for (let i = 1; i <= ROAD_LOD_TOLERANCES_M.length; i++) {
        levels.build(i);
    }
    return Array.from({ length: ROAD_LOD_TOLERANCES_M.length + 1 }, (_, i) => levels.get(i));
}

/**
 * The level to draw where a pixel at the screen centre spans `metresPerPixel`
 * of ground: the coarsest whose tolerance stays under ROAD_LOD_MAX_PIXELS of
 * it (a corner pixel is smaller, so a little over a pixel there).
 */
export function roadLevelFor(metresPerPixel: number): number {
    let level = 0;
    for (let i = 0; i < ROAD_LOD_TOLERANCES_M.length; i++) {
        if (ROAD_LOD_TOLERANCES_M[i] <= ROAD_LOD_MAX_PIXELS * metresPerPixel) {
            level = i + 1;
        }
    }
    return level;
}

interface StrokeGraph {
    /** Centreline point of each vertex used by the list, else -1. */
    groupOf: Int32Array;
    groupCount: number;
    /** A vertex of each point, for its position, width and flags. */
    rep: Int32Array;
    neighbours: number[][];
    /** Triangle offsets (into the index list) of each segment, by segKey. */
    segTris: Map<number, number[]>;
    /** Points a run may not pass through. */
    fixed: Uint8Array;
    /** The chains between fixed points (see chainsOf). */
    chains: number[][];
}

function segKey(a: number, b: number, n: number): number {
    return a < b ? a * n + b : b * n + a;
}

/** Centreline points (the two banks of a pair share a position and class) and the segments between them. */
function strokeGraph(tile: PtrTile, indices: Uint16Array): StrokeGraph | undefined {
    const pos = tile.positions;
    const dirs = tile.directions;
    const vertexCount = pos.length / 3;
    const groupOf = new Int32Array(vertexCount).fill(-1);
    const byKey = new Map<number, number>();
    const reps: number[] = [];
    for (let i = 0; i < indices.length; i++) {
        const v = indices[i];
        if (groupOf[v] >= 0) {
            continue;
        }
        // Three int16 and a 4-bit class: 52 bits, exact in a double.
        const key = (((pos[v * 3] + 32768) * 65536 + (pos[v * 3 + 1] + 32768)) * 65536
            + (pos[v * 3 + 2] + 32768)) * 16 + (dirs[v * 4 + 3] & ROAD_CLASS_MASK);
        let g = byKey.get(key);
        if (g === undefined) {
            g = reps.length;
            byKey.set(key, g);
            reps.push(v);
        }
        groupOf[v] = g;
    }
    const n = reps.length;
    if (n === 0) {
        return undefined;
    }
    const fixed = new Uint8Array(n);
    const neighbourSets: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
    const segTris = new Map<number, number[]>();
    for (let t = 0; t < indices.length; t += 3) {
        const a = groupOf[indices[t]];
        const b = groupOf[indices[t + 1]];
        const c = groupOf[indices[t + 2]];
        const two = (a === b) !== (b === c) || (a === c && a !== b);
        if (!two) {
            // Not a segment quad half: leave it and its points alone.
            fixed[a] = 1;
            fixed[b] = 1;
            fixed[c] = 1;
            continue;
        }
        const p = a;
        const q = a !== b ? b : c;
        neighbourSets[p].add(q);
        neighbourSets[q].add(p);
        const key = segKey(p, q, n);
        const list = segTris.get(key);
        if (list) {
            list.push(t);
        } else {
            segTris.set(key, [t]);
        }
    }
    const neighbours = neighbourSets.map(s => [...s]);
    const half = tile.halfWidths;
    const flags = tile.flags;
    for (let g = 0; g < n; g++) {
        if (neighbours[g].length !== 2) {
            fixed[g] = 1;
        }
    }
    for (const [key, tris] of segTris) {
        if (tris.length !== 2) {
            // Two strokes over the same span, or a lone half: keep both ends.
            fixed[Math.floor(key / n)] = 1;
            fixed[key % n] = 1;
        }
    }
    // A width or flag change is a point the stroke must keep.
    for (let g = 0; g < n; g++) {
        if (fixed[g]) {
            continue;
        }
        const v = reps[g];
        for (const h of neighbours[g]) {
            const w = reps[h];
            if (half[v] !== half[w] || flags[v] !== flags[w]) {
                fixed[g] = 1;
                break;
            }
        }
    }
    const graph = { groupOf, groupCount: n, rep: Int32Array.from(reps), neighbours, segTris, fixed, chains: [] as number[][] };
    graph.chains = chainsOf(graph);
    return graph;
}

/** The chains between fixed points, as point lists (a closed loop starts and ends on one point). */
function chainsOf(graph: StrokeGraph): number[][] {
    const { neighbours, fixed, groupCount: n } = graph;
    const visited = new Set<number>();
    const out: number[][] = [];
    const walk = (start: number, next: number) => {
        const chain = [start];
        let prev = start;
        let cur = next;
        visited.add(segKey(start, next, n));
        while (true) {
            chain.push(cur);
            if (fixed[cur] || cur === start) {
                break;
            }
            const [a, b] = neighbours[cur];
            const nxt = a === prev ? b : a;
            visited.add(segKey(cur, nxt, n));
            prev = cur;
            cur = nxt;
        }
        out.push(chain);
    };
    for (let g = 0; g < n; g++) {
        if (!fixed[g]) {
            continue;
        }
        for (const h of neighbours[g]) {
            if (!visited.has(segKey(g, h, n))) {
                walk(g, h);
            }
        }
    }
    // Loops with no fixed point on them.
    for (let g = 0; g < n; g++) {
        for (const h of neighbours[g]) {
            if (!visited.has(segKey(g, h, n))) {
                fixed[g] = 1;
                walk(g, h);
            }
        }
    }
    return out;
}

function simplify(
    tile: PtrTile, indices: Uint16Array, graph: StrokeGraph,
    up: readonly [number, number, number], tolM: number,
): Uint16Array {
    const { rep, segTris, groupOf, groupCount: n } = graph;
    const pos = tile.positions;
    const q = tile.quantScale;
    const dirs = tile.directions;
    const [ux, uy, uz] = up;
    const out: number[] = [];
    const used = new Uint8Array(indices.length / 3);

    // Is point m within tolerance of the chord a-b?
    const near = (a: number, b: number, m: number): boolean => {
        const va = rep[a] * 3, vb = rep[b] * 3, vm = rep[m] * 3;
        const abx = (pos[vb] - pos[va]) * q, aby = (pos[vb + 1] - pos[va + 1]) * q, abz = (pos[vb + 2] - pos[va + 2]) * q;
        const amx = (pos[vm] - pos[va]) * q, amy = (pos[vm + 1] - pos[va + 1]) * q, amz = (pos[vm + 2] - pos[va + 2]) * q;
        const len2 = abx * abx + aby * aby + abz * abz;
        if (len2 < 1e-12) {
            return false;
        }
        const s = (abx * amx + aby * amy + abz * amz) / len2;
        if (s < 0 || s > 1) {
            return false;
        }
        // The point less the chord under it: positive is land above the chord.
        const dx = amx - s * abx, dy = amy - s * aby, dz = amz - s * abz;
        const rise = dx * ux + dy * uy + dz * uz;
        if (rise > DOWN_TOLERANCE_M || rise < -tolM) {
            return false;
        }
        const lx = dx - rise * ux, ly = dy - rise * uy, lz = dz - rise * uz;
        return lx * lx + ly * ly + lz * lz <= tolM * tolM;
    };

    // The vertex of point g on each bank, as segment (g, other) draws it.
    const banks = (g: number, other: number): [number, number] | undefined => {
        const tris = segTris.get(segKey(g, other, n));
        if (!tris) {
            return undefined;
        }
        let pos0 = -1, neg = -1;
        for (const t of tris) {
            for (let k = 0; k < 3; k++) {
                const v = indices[t + k];
                if (groupOf[v] !== g) {
                    continue;
                }
                const negative = (dirs[v * 4 + 3] & ROAD_SIDE_BIT) !== 0;
                if (negative) {
                    if (neg >= 0 && neg !== v) {
                        return undefined;
                    }
                    neg = v;
                } else {
                    if (pos0 >= 0 && pos0 !== v) {
                        return undefined;
                    }
                    pos0 = v;
                }
            }
        }
        return pos0 >= 0 && neg >= 0 ? [pos0, neg] : undefined;
    };

    const copySegment = (a: number, b: number) => {
        for (const t of segTris.get(segKey(a, b, n)) ?? []) {
            out.push(indices[t], indices[t + 1], indices[t + 2]);
            used[t / 3] = 1;
        }
    };

    for (const chain of graph.chains) {
        let i = 0;
        while (i < chain.length - 1) {
            let k = i + 1;
            for (let cand = i + 2; cand < chain.length; cand++) {
                let ok = chain[cand] !== chain[i];
                for (let m = i + 1; ok && m < cand; m++) {
                    ok = near(chain[i], chain[cand], chain[m]);
                }
                if (!ok) {
                    break;
                }
                k = cand;
            }
            if (k === i + 1) {
                copySegment(chain[i], chain[i + 1]);
                i = k;
                continue;
            }
            // The first segment's quad, its far end moved to the kept point,
            // bank for bank, so the winding stays the original's.
            const from = banks(chain[i + 1], chain[i]);
            const to = banks(chain[k], chain[k - 1]);
            if (!from || !to) {
                for (let m = i; m < k; m++) {
                    copySegment(chain[m], chain[m + 1]);
                }
                i = k;
                continue;
            }
            for (const t of segTris.get(segKey(chain[i], chain[i + 1], n)) ?? []) {
                for (let c = 0; c < 3; c++) {
                    const v = indices[t + c];
                    out.push(v === from[0] ? to[0] : v === from[1] ? to[1] : v);
                }
            }
            for (let m = i; m < k; m++) {
                for (const t of segTris.get(segKey(chain[m], chain[m + 1], n)) ?? []) {
                    used[t / 3] = 1;
                }
            }
            i = k;
        }
    }
    // Everything not on a chain (caps, odd triangles) as it was.
    for (let t = 0; t < indices.length; t += 3) {
        if (!used[t / 3]) {
            out.push(indices[t], indices[t + 1], indices[t + 2]);
        }
    }
    return Uint16Array.from(out);
}

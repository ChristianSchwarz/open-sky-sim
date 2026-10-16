/**
 * The graded land simplified, as the grade's last word on a leaf.
 *
 * The grading refines the land to follow the beds and keeps it under the
 * roads, and its collapse takes back only splits inside one surface: a
 * graded leaf came out with half again to twice its baked triangles. The
 * far land's simplifier (farLand.ts) already keeps everything the grading
 * must - border vertices where they are, the shore and every steep face,
 * a fill never sinking through to its ground, the land never rising at a
 * road or river point - so it runs over the graded land at a tolerance no
 * one sees from the cockpit (LAND_SIMPLIFY_M). On central Munich it left
 * 64 % of a graded leaf, fewer triangles than the bake had made.
 *
 * The border table indexes land vertices, and the simplified land numbers
 * them anew. Its border corners are the old ones, unmoved (farLand keeps
 * them): each follows a near slot (borderMap), and takes that slot's side
 * and param. A border edge is the surface's - skirts hang from it, fills
 * lie over it - so it is taken from a facet with an area in plan whose two
 * corners stand where the old edge's did.
 */

import { PtmBorder, PtmTile, borderEntryIndex, borderEntrySide, packBorderEntry } from '../../src/script/terrain/ptm';
import { regionSizes } from '../../src/script/terrain/tileMesh';
import { buildFarLand } from './farLand';

/** A facet with less area than this in plan, m^2, is a skirt or a wall, never the border's surface. */
const BORDER_SKIRT_PLAN_M2 = 0.05;
/** ... whose third corner stands at least this far off the line of the other two, metres: a skirt; nearer, a sliver of surface. */
const BORDER_SKIRT_DROP_M = 0.5;

/** Vertical tolerance the graded land is simplified to, metres. */
export const LAND_SIMPLIFY_M = 0.1;

export interface LandSoupIn {
    positions: Int16Array;
    normals: Int8Array;
    attrs: Uint8Array;
}

export interface SimplifiedLand {
    land: LandSoupIn;
    border?: PtmBorder;
}

/**
 * `land` simplified within `toleranceM`, with `tile`'s border table carried
 * onto it; undefined when it would not get lighter. `strokes` are the
 * tile-local metres of every drawn road and river point (x, y, z).
 */
export function simplifyLand(
    land: LandSoupIn, tile: Pick<PtmTile, 'quantScale' | 'border'>, up: readonly [number, number, number] | number[],
    strokes: Float32Array, toleranceM = LAND_SIMPLIFY_M,
): SimplifiedLand | undefined {
    const q = tile.quantScale;
    const n = land.positions.length / 9;
    if (n === 0) {
        return undefined;
    }
    const rs = regionSizes(land.positions, land.attrs, q);
    const fills = new Uint8Array(n);
    for (let t = 0; t < n; t++) {
        fills[t] = rs[t * 3] > 0 ? 1 : 0;
    }
    const old = tile.border;
    const borderSlots = Uint32Array.from(old?.vertices ?? [], e => borderEntryIndex(e));
    const r = buildFarLand({
        positions: land.positions, normals: land.normals, attrs: land.attrs,
        quantScale: q, fills, regionSizes: rs, borderSlots, up: up as [number, number, number], toleranceM, strokePoints: strokes,
    });
    if (r.trianglesOut >= n) {
        return undefined;
    }
    const out: LandSoupIn = { positions: r.positions, normals: r.normals, attrs: r.attrs };
    return { land: out, border: old ? carryBorder(old, land.positions, r.positions, r.borderMap, up, q) : undefined };
}

/** The old border table's entries onto the simplified land's corners. */
function carryBorder(
    old: PtmBorder, oldPos: Int16Array, newPos: Int16Array, borderMap: Uint32Array, up: readonly number[], q: number,
): PtmBorder {
    const keyAt = (P: Int16Array, i: number) => `${P[i * 3]},${P[i * 3 + 1]},${P[i * 3 + 2]}`;
    // Every (side, param) the old table gives a position.
    const sidesAt = new Map<string, Map<number, number>>();
    for (let e = 0; e < old.vertices.length; e++) {
        const key = keyAt(oldPos, borderEntryIndex(old.vertices[e]));
        const m = sidesAt.get(key) ?? sidesAt.set(key, new Map()).get(key)!;
        m.set(borderEntrySide(old.vertices[e]), old.vertexParams[e]);
    }
    const vertices: number[] = [], vertexParams: number[] = [];
    for (let i = 0; i < borderMap.length; i += 2) {
        const corner = borderMap[i];
        for (const [side, param] of sidesAt.get(keyAt(oldPos, borderMap[i + 1])) ?? []) {
            vertices.push(packBorderEntry(side, corner));
            vertexParams.push(param);
        }
    }
    // The old surface edges by their ends' positions and side.
    const edgeAt = new Map<string, [number, number]>();
    for (let e = 0; e < old.edges.length; e += 2) {
        const side = borderEntrySide(old.edges[e]);
        const a = keyAt(oldPos, borderEntryIndex(old.edges[e])), b = keyAt(oldPos, borderEntryIndex(old.edges[e + 1]));
        edgeAt.set(`${side}|${a}|${b}`, [old.edgeParams[e], old.edgeParams[e + 1]]);
    }
    const edges: number[] = [], edgeParams: number[] = [];
    // Once each, as the old table had them: two facets on one edge (a fill
    // stood on it, a sliver beside it) would hand the stitcher two strips.
    const taken = new Set<string>();
    const tris = newPos.length / 9;
    for (let t = 0; t < tris; t++) {
        // In plan (off the tile's up): a skirt or wall has no area and hangs
        // from the edge, it is not one. By area, not slope: a surface facet
        // on a cliff at the border stands near vertical and is still the edge.
        const p = [0, 1, 2].map(k => [newPos[(t * 3 + k) * 3], newPos[(t * 3 + k) * 3 + 1], newPos[(t * 3 + k) * 3 + 2]]);
        const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
        const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
        const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(nrm[0], nrm[1], nrm[2]);
        // A skirt hangs metres below the edge it is cut from; a sliver of
        // surface along the border (no area either) has its third corner on
        // the edge's line, and the bake counted its edge.
        const flat = Math.abs(nrm[0] * up[0] + nrm[1] * up[1] + nrm[2] * up[2]) * q * q / 2 < BORDER_SKIRT_PLAN_M2;
        const hangs = flat && [0, 1, 2].some(k => {
            const a = p[k], b = p[(k + 1) % 3], c = p[(k + 2) % 3];
            const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const cr = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
            const l = Math.hypot(ab[0], ab[1], ab[2]);
            return l > 0 && (Math.hypot(cr[0], cr[1], cr[2]) / l) * q > BORDER_SKIRT_DROP_M;
        });
        if (hangs) {
            continue;
        }
        for (let k = 0; k < 3; k++) {
            const ia = t * 3 + k, ib = t * 3 + (k + 1) % 3;
            const a = keyAt(newPos, ia), b = keyAt(newPos, ib);
            if (!sidesAt.has(a) || !sidesAt.has(b)) {
                continue;
            }
            for (const side of sidesAt.get(a)!.keys()) {
                const id = a < b ? `${side}|${a}|${b}` : `${side}|${b}|${a}`;
                if (taken.has(id)) {
                    continue;
                }
                const fwd = edgeAt.get(`${side}|${a}|${b}`);
                const back = fwd ? undefined : edgeAt.get(`${side}|${b}|${a}`);
                if (fwd || back) {
                    taken.add(id);
                }
                if (fwd) {
                    edges.push(packBorderEntry(side, ia), packBorderEntry(side, ib));
                    edgeParams.push(fwd[0], fwd[1]);
                } else if (back) {
                    edges.push(packBorderEntry(side, ib), packBorderEntry(side, ia));
                    edgeParams.push(back[0], back[1]);
                }
            }
        }
    }
    return {
        vertices: Uint32Array.from(vertices), vertexParams: Float32Array.from(vertexParams),
        edges: Uint32Array.from(edges), edgeParams: Float32Array.from(edgeParams),
    };
}

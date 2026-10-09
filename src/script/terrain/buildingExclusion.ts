/**
 * Whether a point of a tile stands inside one of its buildings, for the tree
 * and stone scatter: a tree growing through a roof is the one thing a house
 * from the air must never have.
 *
 * Points come in the tile's own axes, in metres (as roadExclusion.ts takes
 * them, plus the height: the PBH1 frame is a true local one and its
 * horizontal axes are not the tile's x and z). Footprints are bucketed on a
 * coarse grid and tested by ray crossing, with a small margin so a crown
 * does not overhang a wall.
 */

import { PbhTile, pbhRings } from './pbh';

const CELL_M = 64;
/** A scatter point closer than this to a wall counts as inside. */
export const BUILDING_TREE_MARGIN_M = 2;

interface Footprint {
    rings: Array<Array<[number, number]>>;
    minU: number;
    minV: number;
    maxU: number;
    maxV: number;
}

function insideRings(rings: Array<Array<[number, number]>>, u: number, v: number): boolean {
    let inside = false;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [ui, vi] = ring[i], [uj, vj] = ring[j];
            if ((vi > v) !== (vj > v) && u < (uj - ui) * (v - vi) / (vj - vi) + ui) {
                inside = !inside;
            }
        }
    }
    return inside;
}

function nearRings(rings: Array<Array<[number, number]>>, u: number, v: number, margin: number): boolean {
    const m2 = margin * margin;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [ax, ay] = ring[j], [bx, by] = ring[i];
            const ex = bx - ax, ey = by - ay;
            const len2 = ex * ex + ey * ey;
            const t = len2 > 0 ? Math.max(0, Math.min(1, ((u - ax) * ex + (v - ay) * ey) / len2)) : 0;
            const dx = ax + ex * t - u, dy = ay + ey * t - v;
            if (dx * dx + dy * dy <= m2) {
                return true;
            }
        }
    }
    return false;
}

export function buildBuildingExclusion(
    tile: PbhTile, margin = BUILDING_TREE_MARGIN_M,
): ((x: number, y: number, z: number) => boolean) | undefined {
    if (tile.buildings.length === 0) {
        return undefined;
    }
    const grid = new Map<number, Footprint[]>();
    const key = (cu: number, cv: number) => cu * 65536 + cv;
    for (const b of tile.buildings) {
        const rings = pbhRings(tile, b);
        let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
        for (const [u, v] of rings[0] ?? []) {
            minU = Math.min(minU, u); maxU = Math.max(maxU, u);
            minV = Math.min(minV, v); maxV = Math.max(maxV, v);
        }
        if (!Number.isFinite(minU)) {
            continue;
        }
        const fp: Footprint = { rings, minU: minU - margin, minV: minV - margin, maxU: maxU + margin, maxV: maxV + margin };
        for (let cu = Math.floor(fp.minU / CELL_M); cu <= Math.floor(fp.maxU / CELL_M); cu++) {
            for (let cv = Math.floor(fp.minV / CELL_M); cv <= Math.floor(fp.maxV / CELL_M); cv++) {
                const k = key(cu, cv);
                const list = grid.get(k);
                if (list) {
                    list.push(fp);
                } else {
                    grid.set(k, [fp]);
                }
            }
        }
    }
    const { a, b } = tile.frame;
    return (x, y, z) => {
        const u = x * a[0] + y * a[1] + z * a[2];
        const v = x * b[0] + y * b[1] + z * b[2];
        const list = grid.get(key(Math.floor(u / CELL_M), Math.floor(v / CELL_M)));
        if (!list) {
            return false;
        }
        for (const fp of list) {
            if (u < fp.minU || u > fp.maxU || v < fp.minV || v > fp.maxV) {
                continue;
            }
            if (insideRings(fp.rings, u, v) || (margin > 0 && nearRings(fp.rings, u, v, margin))) {
                return true;
            }
        }
        return false;
    };
}

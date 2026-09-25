/**
 * Keeps scattered trees off roads. Built from a tile's decoded road sidecar:
 * the stroke's centreline segments (edges of the stroke triangles that join
 * two distinct centreline points) go in a coarse grid, and a point is
 * rejected when it lies within the road's half-width plus a margin of one.
 */

import { PtrTile } from './ptr';

/** Clear ground kept beyond the road's own half-width, metres (a tree's canopy is ~5 m half-width). */
const ROAD_TREE_MARGIN_M = 5;
const CELL_M = 64;

export type RoadExclusion = (x: number, z: number) => boolean;

export function buildRoadExclusion(ptr: PtrTile): RoadExclusion | undefined {
    const s = ptr.quantScale;
    const pos = ptr.positions;
    const idx = ptr.indices;
    const segs: number[] = []; // ax, az, bx, bz, reach
    const seen = new Set<number>();
    const key = (a: number, b: number) => a < b ? a * 65536 + b : b * 65536 + a;
    const same = (a: number, b: number) =>
        pos[a * 3] === pos[b * 3] && pos[a * 3 + 1] === pos[b * 3 + 1] && pos[a * 3 + 2] === pos[b * 3 + 2];
    for (let i = 0; i + 2 < idx.length; i += 3) {
        for (let e = 0; e < 3; e++) {
            const a = idx[i + e];
            const b = idx[i + (e + 1) % 3];
            if (same(a, b) || !seen.add(key(a, b))) {
                continue;
            }
            const reach = Math.max(ptr.halfWidths[a], ptr.halfWidths[b]) / 10 + ROAD_TREE_MARGIN_M;
            segs.push(pos[a * 3] * s, pos[a * 3 + 2] * s, pos[b * 3] * s, pos[b * 3 + 2] * s, reach);
        }
    }
    if (segs.length === 0) {
        return undefined;
    }
    const grid = new Map<number, number[]>();
    const cellKey = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);
    for (let i = 0; i < segs.length; i += 5) {
        const r = segs[i + 4];
        const x0 = Math.floor((Math.min(segs[i], segs[i + 2]) - r) / CELL_M);
        const x1 = Math.floor((Math.max(segs[i], segs[i + 2]) + r) / CELL_M);
        const z0 = Math.floor((Math.min(segs[i + 1], segs[i + 3]) - r) / CELL_M);
        const z1 = Math.floor((Math.max(segs[i + 1], segs[i + 3]) + r) / CELL_M);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cz = z0; cz <= z1; cz++) {
                const k = cellKey(cx, cz);
                const list = grid.get(k);
                if (list) {
                    list.push(i);
                } else {
                    grid.set(k, [i]);
                }
            }
        }
    }
    return (x, z) => {
        const list = grid.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
        if (!list) {
            return false;
        }
        for (const i of list) {
            const ax = segs[i], az = segs[i + 1];
            const dx = segs[i + 2] - ax, dz = segs[i + 3] - az;
            const len2 = dx * dx + dz * dz;
            const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
            const px = ax + dx * t - x, pz = az + dz * t - z;
            const r = segs[i + 4];
            if (px * px + pz * pz < r * r) {
                return true;
            }
        }
        return false;
    };
}

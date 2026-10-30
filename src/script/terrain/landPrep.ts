/**
 * Per-tile land preparation that depends on nothing but the decoded tile's
 * own arrays: region widths and border normals. Kept free of three.js so
 * the tile decode worker (tileDecodeWorker.ts) can run it off the main
 * thread; tileMesh.ts re-exports both.
 */

import type { PtmTile } from './ptm';
import { GROUND_CLASS, hasLanduseGround } from './smoothWeld';

// TerrainClass.Ground spelled out: it is a `const enum`, and the tsx test
// runner leaves an imported const-enum binding undefined.

/**
 * Per vertex, the width in metres of the land-use region it belongs to: the
 * square root of the region's area on this tile. 0 for ground, and for every
 * vertex of a raster-only tile. See LANDUSE_REVEAL_MIN_PX for what it gates.
 *
 * A region is a connected patch of one class: triangles of the same class
 * that share a corner (by exact quantised position) are one region. The
 * colour cannot tell regions apart, as it once did, because a fill's colour
 * is the regional lattice blended per vertex and so varies across the
 * polygon. Two touching regions of one class merge, which only makes both
 * show a little earlier. Non-indexed input: three vertices per triangle.
 */
export function regionSizes(
    positions: Int16Array, attrs: Uint8Array, quantScale: number,
): Uint16Array {
    const vertexCount = positions.length / 3;
    const out = new Uint16Array(vertexCount);
    if (!hasLanduseGround(attrs)) {
        return out;
    }
    const triCount = Math.floor(vertexCount / 3);
    // Union-find over triangles.
    const parent = new Int32Array(triCount);
    for (let t = 0; t < triCount; t++) {
        parent[t] = t;
    }
    const find = (t: number): number => {
        while (parent[t] !== t) {
            parent[t] = parent[parent[t]];
            t = parent[t];
        }
        return t;
    };
    const union = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) {
            parent[ra] = rb;
        }
    };
    const triArea = new Float64Array(triCount);
    // First triangle seen at each (position, class) corner: open addressing
    // over typed arrays. A string-keyed Map here was 15 % of the main thread
    // while tiles streamed in over the Alps (2026-10-29).
    let cap = 1024;
    while (cap < vertexCount * 2) {
        cap <<= 1;
    }
    const mask = cap - 1;
    const slotTri = new Int32Array(cap).fill(-1);
    const slotXY = new Int32Array(cap);
    const slotZC = new Int32Array(cap);
    const cornerTri = (x: number, y: number, z: number, cls: number, t: number): number => {
        const xy = (x & 0xffff) | (y << 16);
        const zc = (z & 0xffff) | (cls << 16);
        let h = Math.imul(xy, 0x9e3779b1) ^ Math.imul(zc, 0x85ebca77);
        h = (h ^ (h >>> 15)) & mask;
        for (;;) {
            const at = slotTri[h];
            if (at < 0) {
                slotTri[h] = t;
                slotXY[h] = xy;
                slotZC[h] = zc;
                return -1;
            }
            if (slotXY[h] === xy && slotZC[h] === zc) {
                return at;
            }
            h = (h + 1) & mask;
        }
    };
    for (let t = 0; t < triCount; t++) {
        const v = t * 3;
        const cls = attrs[v * 4 + 3];
        if (cls === GROUND_CLASS) {
            continue;
        }
        const ax = positions[v * 3], ay = positions[v * 3 + 1], az = positions[v * 3 + 2];
        const bx = positions[v * 3 + 3] - ax, by = positions[v * 3 + 4] - ay, bz = positions[v * 3 + 5] - az;
        const cx = positions[v * 3 + 6] - ax, cy = positions[v * 3 + 7] - ay, cz = positions[v * 3 + 8] - az;
        const nx = by * cz - bz * cy;
        const ny = bz * cx - bx * cz;
        const nz = bx * cy - by * cx;
        triArea[t] = 0.5 * Math.hypot(nx, ny, nz) * quantScale * quantScale;
        for (let k = 0; k < 3; k++) {
            const i = v + k;
            const other = cornerTri(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], cls, t);
            if (other >= 0) {
                union(t, other);
            }
        }
    }
    const area = new Float64Array(triCount);
    for (let t = 0; t < triCount; t++) {
        if (attrs[t * 3 * 4 + 3] !== GROUND_CLASS) {
            area[find(t)] += triArea[t];
        }
    }
    for (let t = 0; t < triCount; t++) {
        if (attrs[t * 3 * 4 + 3] === GROUND_CLASS) {
            continue;
        }
        const size = Math.min(65535, Math.round(Math.sqrt(area[find(t)])));
        out[t * 3] = size;
        out[t * 3 + 1] = size;
        out[t * 3 + 2] = size;
    }
    return out;
}

/** Fraction of the tile's width, from each edge, that counts as its border. */
const EDGE_NORMAL_BAND = 0.01;
/** How far a border normal leans toward straight up, 0..1. */
const EDGE_NORMAL_LEAN = 0;

/**
 * Tile-edge vertices only see their own tile's triangles, so two neighbours
 * light the shared edge differently and a step shows - worst between tiles of
 * different detail, whose facets slope differently. Both sides agree on
 * straight up, so vertices on the tile's bounding-box edge lean their normal
 * toward it and the two meet in the middle. Edits `normals` in place; the
 * smooth geometry is built from the same arrays afterwards.
 */
export function leanEdgeNormals(positions: Int16Array, normals: Int8Array): void {
    const count = positions.length / 3;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let v = 0; v < count; v++) {
        minX = Math.min(minX, positions[v * 3]);
        maxX = Math.max(maxX, positions[v * 3]);
        minZ = Math.min(minZ, positions[v * 3 + 2]);
        maxZ = Math.max(maxZ, positions[v * 3 + 2]);
    }
    const edgeX = (maxX - minX) * EDGE_NORMAL_BAND;
    const edgeZ = (maxZ - minZ) * EDGE_NORMAL_BAND;
    for (let v = 0; v < count; v++) {
        const px = positions[v * 3];
        const pz = positions[v * 3 + 2];
        if (px - minX > edgeX && maxX - px > edgeX && pz - minZ > edgeZ && maxZ - pz > edgeZ) {
            continue;
        }
        const nx = (normals[v * 4] / 127) * (1 - EDGE_NORMAL_LEAN);
        const ny = (normals[v * 4 + 1] / 127) * (1 - EDGE_NORMAL_LEAN) + EDGE_NORMAL_LEAN;
        const nz = (normals[v * 4 + 2] / 127) * (1 - EDGE_NORMAL_LEAN);
        const len = Math.hypot(nx, ny, nz) || 1;
        normals[v * 4] = Math.round((nx / len) * 127);
        normals[v * 4 + 1] = Math.round((ny / len) * 127);
        normals[v * 4 + 2] = Math.round((nz / len) * 127);
    }
}

/**
 * A decoded tile's land made ready for upload: normals leaned in place and
 * the region widths set (PtmTile.landRegionSizes). Both were done at upload
 * on the main thread, where one big tile cost 30-80 ms against a 4 ms
 * upload budget and showed as a stutter while tiles streamed in.
 */
export function prepareLand(tile: PtmTile): PtmTile {
    if (tile.landPositions.length > 0) {
        leanEdgeNormals(tile.landPositions, tile.landNormals);
        tile.landRegionSizes = regionSizes(tile.landPositions, tile.landAttrs, tile.quantScale);
    }
    return tile;
}

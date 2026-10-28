/**
 * The SMOOTH land weld as plain typed arrays, with no three.js in it, so a
 * worker can run it (smoothWeldWorker.ts, SmoothWelder): the weld is tens of
 * milliseconds a leaf, and on the main thread it was a frame lost for every
 * leaf streamed in under SMOOTH and, at boot, 15 ms of every 35 for as long
 * as the resident set took to upgrade (a minute and more over 900 tiles).
 * tileMesh.ts buildSmoothLandGeometry wraps it into a geometry.
 */

/** TerrainClass.Ground: land no land-use polygon claims. */
export const GROUND_CLASS = 13;

/** The welded vertices: one per position and region, `indices` over them in the faceted vertex order. */
export interface SmoothWeld {
    positions: Int16Array;
    /** xyz and a pad byte per vertex, like the PTM's. */
    normals: Int8Array;
    /** rgb and the class per vertex, like the PTM's. */
    attrs: Uint8Array;
    sizes: Uint16Array;
    /** Per faceted vertex, its welded vertex. */
    indices: Uint16Array | Uint32Array;
}

/**
 * Whether any land vertex is TerrainClass.Ground - land no land-use polygon
 * claims, on a tile that has land-use. Only such a tile's other classes are
 * land-use regions (exact fills on the leaf, votes above it); on a raster-only
 * tile the classes *are* the ground.
 */
export function hasLanduseGround(landAttrs: Uint8Array): boolean {
    for (let i = 3; i < landAttrs.length; i += 4) {
        if (landAttrs[i] === GROUND_CLASS) {
            return true;
        }
    }
    return false;
}

/**
 * Added to every triangle's normal weight, in quantised units squared, so a
 * position touched only by zero-area triangles still gets their normal.
 */
const MIN_NORMAL_WEIGHT = 1e-3;

/** A land triangle's area (twice it, which weights the same), in quantised units squared. */
function triangleArea(positions: Int16Array, first: number): number {
    const o = first * 3;
    const ax = positions[o + 3] - positions[o], ay = positions[o + 4] - positions[o + 1], az = positions[o + 5] - positions[o + 2];
    const bx = positions[o + 6] - positions[o], by = positions[o + 7] - positions[o + 1], bz = positions[o + 8] - positions[o + 2];
    return Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
}

function regionKeyOf(attrs: Uint8Array, v: number, landuse: boolean): number {
    const cls = attrs[v * 4 + 3];
    if (!landuse || cls === GROUND_CLASS) {
        return cls;
    }
    return attrs[v * 4] | (attrs[v * 4 + 1] << 8) | (attrs[v * 4 + 2] << 16) | (cls << 24);
}

/**
 * The FACETED land welded into shared vertices, with the colour averaged
 * (mean) over the triangles of the *same region* that touch the vertex and
 * the normal averaged (mean weighted by area, renormalised) over every
 * triangle that touches the position, whatever its region.
 *
 * By area because the bake hangs vertical shore walls of a square metre or
 * two, and zero-area slivers, off corners that also carry flat field
 * triangles hundreds of metres long. Counted one each, they tilted such a
 * corner by up to 45 degrees, and the big flat triangles shaded from it
 * showed as dark fans across the fields beside every canal and lake.
 *
 * Welding is by exact match of the quantised int16 position plus the region
 * the vertex belongs to (see `regionKeyOf`), so a corner where a field meets
 * a forest is two vertices, one per region, each keeping its own colour:
 * colour smoothing happens inside a land-use region, never across the edge
 * between two. Lighting is the ground's, not the region's, so both vertices
 * share the one normal averaged over the whole corner and a slope shades
 * continuously across the edge. The class is the same for every contributor
 * to a colour and needs no vote. The position match is exact for two
 * triangles that share a corner in the bake — nothing here does
 * distance-based merging, so a genuine crack in the bake stays a crack. Only
 * within one tile: a seam at the tile boundary is not welded and stays
 * faceted, which is an accepted seam rather than a bug.
 */
export function weldSmoothLand(
    positions: Int16Array, normals: Int8Array, attrs: Uint8Array,
    /** Per-vertex region width (see regionSizes); the weld keeps the largest. */
    sizes?: Uint16Array,
): SmoothWeld | undefined {
    const vertexCount = positions.length / 3;
    if (vertexCount === 0) {
        return undefined;
    }

    // Two welds over one pass: colour (and class, size) by position+region,
    // normal by position alone. A position's slot is its normal; the output
    // vertices at one position (one per region there, rarely more than
    // three) hang off it in a list. Both in first-seen order. Typed arrays
    // and an open-addressed table rather than Maps keyed on strings: a leaf
    // has up to 100K vertices (30-50 ms a leaf with the strings).
    let capacity = 16;
    while (capacity < vertexCount * 2) {
        capacity *= 2;
    }
    const mask = capacity - 1;
    const table = new Int32Array(capacity).fill(-1);
    const slotPositions = new Int16Array(vertexCount * 3);
    const firstOut = new Int32Array(vertexCount);
    const normalSum = new Float64Array(vertexCount * 3);
    let slots = 0;
    const nextOut = new Int32Array(vertexCount);
    const outRegion = new Int32Array(vertexCount);
    const normalOf = new Int32Array(vertexCount);
    const uniquePositions = new Int16Array(vertexCount * 3);
    const colorSum = new Float64Array(vertexCount * 4);
    const vertexClass = new Uint8Array(vertexCount);
    const sizeMax = new Uint16Array(vertexCount);
    let uniqueCount = 0;
    const remap = new Uint32Array(vertexCount);
    const landuse = hasLanduseGround(attrs);
    let weight = 0;

    for (let i = 0; i < vertexCount; i++) {
        const px = positions[i * 3];
        const py = positions[i * 3 + 1];
        const pz = positions[i * 3 + 2];
        let h = (Math.imul(px, 73856093) ^ Math.imul(py, 19349663) ^ Math.imul(pz, 83492791)) & mask;
        let n = table[h];
        while (n !== -1 && (slotPositions[n * 3] !== px || slotPositions[n * 3 + 1] !== py || slotPositions[n * 3 + 2] !== pz)) {
            h = (h + 1) & mask;
            n = table[h];
        }
        if (n === -1) {
            n = slots++;
            table[h] = n;
            slotPositions[n * 3] = px;
            slotPositions[n * 3 + 1] = py;
            slotPositions[n * 3 + 2] = pz;
            firstOut[n] = -1;
        }
        const region = regionKeyOf(attrs, i, landuse);
        let idx = firstOut[n];
        while (idx !== -1 && outRegion[idx] !== region) {
            idx = nextOut[idx];
        }
        if (idx === -1) {
            idx = uniqueCount++;
            outRegion[idx] = region;
            nextOut[idx] = firstOut[n];
            firstOut[n] = idx;
            uniquePositions[idx * 3] = px;
            uniquePositions[idx * 3 + 1] = py;
            uniquePositions[idx * 3 + 2] = pz;
            normalOf[idx] = n;
            vertexClass[idx] = attrs[i * 4 + 3];
        }
        remap[i] = idx;
        if (sizes && sizes[i] > sizeMax[idx]) {
            sizeMax[idx] = sizes[i];
        }

        if (i % 3 === 0) {
            weight = triangleArea(positions, i) + MIN_NORMAL_WEIGHT;
        }
        const ni = i * 4;
        normalSum[n * 3] += normals[ni] * weight;
        normalSum[n * 3 + 1] += normals[ni + 1] * weight;
        normalSum[n * 3 + 2] += normals[ni + 2] * weight;

        const ai = i * 4;
        colorSum[idx * 4] += attrs[ai];
        colorSum[idx * 4 + 1] += attrs[ai + 1];
        colorSum[idx * 4 + 2] += attrs[ai + 2];
        colorSum[idx * 4 + 3] += 1;
    }

    const outPositions = uniquePositions.slice(0, uniqueCount * 3);
    const outNormals = new Int8Array(uniqueCount * 4);
    const outAttrs = new Uint8Array(uniqueCount * 4);
    const outSizes = sizeMax.slice(0, uniqueCount);
    for (let v = 0; v < uniqueCount; v++) {
        const n = normalOf[v];
        const nx = normalSum[n * 3];
        const ny = normalSum[n * 3 + 1];
        const nz = normalSum[n * 3 + 2];
        const len = Math.hypot(nx, ny, nz) || 1;
        outNormals[v * 4] = Math.round((nx / len) * 127);
        outNormals[v * 4 + 1] = Math.round((ny / len) * 127);
        outNormals[v * 4 + 2] = Math.round((nz / len) * 127);
        outNormals[v * 4 + 3] = 0;

        const count = colorSum[v * 4 + 3] || 1;
        outAttrs[v * 4] = Math.round(colorSum[v * 4] / count);
        outAttrs[v * 4 + 1] = Math.round(colorSum[v * 4 + 1] / count);
        outAttrs[v * 4 + 2] = Math.round(colorSum[v * 4 + 2] / count);

        outAttrs[v * 4 + 3] = vertexClass[v];
    }

    const IndexArray = uniqueCount > 65535 ? Uint32Array : Uint16Array;
    const indices = new IndexArray(vertexCount);
    indices.set(remap);
    return { positions: outPositions, normals: outNormals, attrs: outAttrs, sizes: outSizes, indices };
}

/**
 * Write the faceted positions as they are now through the weld's index:
 * seam stitching (seamStitch.ts) moves border vertices of the faceted land
 * and writes them through to a SMOOTH geometry that exists, so a weld made
 * from a copy taken before a stitch has to catch up before it is used.
 */
export function refreshWeldPositions(weldPositions: Int16Array, indices: ArrayLike<number>, faceted: Int16Array): void {
    for (let i = 0; i < indices.length; i++) {
        const v = indices[i];
        weldPositions[v * 3] = faceted[i * 3];
        weldPositions[v * 3 + 1] = faceted[i * 3 + 1];
        weldPositions[v * 3 + 2] = faceted[i * 3 + 2];
    }
}

/** What a SmoothWelder job sends: copies, the faceted geometry keeps its own arrays. */
export interface SmoothWeldRequest {
    id: number;
    positions: Int16Array;
    normals: Int8Array;
    attrs: Uint8Array;
    sizes?: Uint16Array;
}

export interface SmoothWeldReply {
    id: number;
    weld: SmoothWeld | undefined;
}

/** The buffers of a weld, to transfer rather than copy. */
export function weldBuffers(w: SmoothWeld | undefined): ArrayBuffer[] {
    return w ? [w.positions, w.normals, w.attrs, w.sizes, w.indices].map(a => a.buffer as ArrayBuffer) : [];
}

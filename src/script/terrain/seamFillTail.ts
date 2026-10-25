import * as THREE from 'three';
import { smoothGeometryFromWeld } from './tileMesh';

/**
 * A tile's T-junction fill (seamStitch.ts rebuildFill) as plain arrays, in
 * the land's own formats, so it can ride at the end of the tile's land draw
 * instead of being a draw of its own: one draw call per stitched tile, ~45 a
 * frame, measured 1.3-3.5 ms of main-thread time.
 */
export interface SeamFillData {
    /** Quantised, three per vertex, like the land's. */
    position: Int16Array;
    /** xyz and a pad byte per vertex. */
    normals: Int8Array;
    /** rgb and the class per vertex. */
    attrs: Uint8Array;
    sizes: Uint16Array;
    /** Vertices; every three a triangle. */
    count: number;
    /** Changes with every rebuild, so a geometry knows whether its copy is current. */
    version: number;
}

/** What a land geometry carries past its own triangles (userData.fillTail). */
interface FillTail {
    /** The land's own index count and vertex count: the tail starts there. */
    landIndices: number;
    landVertices: number;
    /** Vertices (and indices) the tail has room for. */
    capacity: number;
    /** The fill version written there, -1 for none. */
    version: number;
    /** Vertices written. */
    count: number;
}

/** A tail is grown to this much more than the fill it has to take, and to whole blocks of this size. */
const GROWTH = 1.5;
const BLOCK = 128;

/**
 * Whether `g` can carry a fill: an indexed land geometry in the SMOOTH
 * layout (smoothGeometryFromWeld). A faceted one is not indexed; its tile
 * keeps the fill as a mesh of its own.
 */
export function canCarryFill(g: THREE.BufferGeometry): boolean {
    return g.index !== null && g.getAttribute('coverClass') !== undefined
        && (g.getAttribute('position') as THREE.BufferAttribute).array instanceof Int16Array;
}

function tailOf(g: THREE.BufferGeometry): FillTail {
    let tail = g.userData.fillTail as FillTail | undefined;
    if (tail === undefined) {
        tail = {
            landIndices: g.index!.count,
            landVertices: g.getAttribute('position').count,
            capacity: 0,
            version: -1,
            count: 0,
        };
        g.userData.fillTail = tail;
    }
    return tail;
}

/** The version of the fill `g` carries, -1 for none. */
export function fillVersionOf(g: THREE.BufferGeometry): number {
    return (g.userData.fillTail as FillTail | undefined)?.version ?? -1;
}

/**
 * Write `fill` into the tail of `g` (canCarryFill). Returns `g`, or a copy
 * with a bigger tail when the fill does not fit: a buffer cannot grow in
 * place, so the caller swaps every reference to `g` for the copy and
 * disposes `g`. The positions go up whole - seam stitching writes them whole
 * too, and a partial upload would drop its writes made in the same frame;
 * the rest only over the tail.
 */
export function writeFill(g: THREE.BufferGeometry, fill: SeamFillData): THREE.BufferGeometry {
    let tail = tailOf(g);
    if (fill.count > tail.capacity) {
        g = grow(g, tail, Math.ceil(fill.count * GROWTH / BLOCK) * BLOCK);
        tail = tailOf(g);
    }
    const at = tail.landVertices;
    const position = g.getAttribute('position') as THREE.BufferAttribute;
    (position.array as Int16Array).set(fill.position, at * 3);
    position.needsUpdate = true;

    const normals = (g.getAttribute('normal') as THREE.InterleavedBufferAttribute).data;
    (normals.array as Int8Array).set(fill.normals, at * 4);
    normals.addUpdateRange(at * 4, fill.count * 4);
    normals.needsUpdate = true;

    const attrs = (g.getAttribute('coverColor') as THREE.InterleavedBufferAttribute).data;
    (attrs.array as Uint8Array).set(fill.attrs, at * 4);
    attrs.addUpdateRange(at * 4, fill.count * 4);
    attrs.needsUpdate = true;

    const sizes = g.getAttribute('regionSize') as THREE.BufferAttribute;
    (sizes.array as Uint16Array).set(fill.sizes, at);
    sizes.addUpdateRange(at, fill.count);
    sizes.needsUpdate = true;

    const index = g.index!;
    const indices = index.array as Uint16Array | Uint32Array;
    for (let k = 0; k < fill.count; k++) {
        indices[tail.landIndices + k] = at + k;
    }
    index.addUpdateRange(tail.landIndices, fill.count);
    index.needsUpdate = true;

    tail.count = fill.count;
    tail.version = fill.version;
    return g;
}

/** Draw `g` with its fill or without: the land's own triangles always. */
export function showFill(g: THREE.BufferGeometry, visible: boolean): void {
    const tail = g.userData.fillTail as FillTail | undefined;
    if (tail === undefined) {
        return;
    }
    g.setDrawRange(0, tail.landIndices + (visible ? tail.count : 0));
}

/**
 * `g` again with room for `capacity` fill vertices past its land. Its land
 * is copied as it is now (the seam may have moved it).
 */
function grow(g: THREE.BufferGeometry, tail: FillTail, capacity: number): THREE.BufferGeometry {
    const vertices = tail.landVertices + capacity;
    const indexCount = tail.landIndices + capacity;
    const extend = <T extends Int16Array | Int8Array | Uint8Array | Uint16Array>(
        src: T, make: new (n: number) => T, n: number,
    ): T => {
        const out = new make(n);
        out.set(src.subarray(0, Math.min(src.length, n)) as unknown as ArrayLike<number>);
        return out;
    };
    const position = (g.getAttribute('position') as THREE.BufferAttribute).array as Int16Array;
    const normals = (g.getAttribute('normal') as THREE.InterleavedBufferAttribute).data.array as Int8Array;
    const attrs = (g.getAttribute('coverColor') as THREE.InterleavedBufferAttribute).data.array as Uint8Array;
    const sizes = (g.getAttribute('regionSize') as THREE.BufferAttribute).array as Uint16Array;
    const oldIndex = g.index!.array;
    const IndexArray = vertices > 65535 ? Uint32Array : Uint16Array;
    const indices = new IndexArray(indexCount);
    indices.set(oldIndex.subarray(0, tail.landIndices) as unknown as ArrayLike<number>);
    const grown = smoothGeometryFromWeld({
        positions: extend(position.subarray(0, tail.landVertices * 3) as Int16Array, Int16Array, vertices * 3),
        normals: extend(normals.subarray(0, tail.landVertices * 4) as Int8Array, Int8Array, vertices * 4),
        attrs: extend(attrs.subarray(0, tail.landVertices * 4) as Uint8Array, Uint8Array, vertices * 4),
        sizes: extend(sizes.subarray(0, tail.landVertices) as Uint16Array, Uint16Array, vertices),
        indices,
    });
    grown.userData = { ...g.userData };
    grown.userData.fillTail = {
        landIndices: tail.landIndices, landVertices: tail.landVertices, capacity, version: -1, count: 0,
    } satisfies FillTail;
    grown.setDrawRange(0, tail.landIndices);
    return grown;
}

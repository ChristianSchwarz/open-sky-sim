/**
 * Stitches each drawn tile's border onto its neighbour's, so tiles at
 * different detail levels share one border line and no crack opens between.
 *
 * Every tile meshes its own border, and a coarse tile can only run in a
 * straight line between its own vertices, so a fine tile beside it - drawn
 * from the same ground with more vertices - strays from that line. The bake
 * keeps the two close (borderConform.ts, densifyBorder) and skirts used to
 * hide the rest; across several levels the rest was 50-125 m, and a skirt
 * deep enough for that shows as a wall.
 *
 * So for each side of each drawn tile one of the two tiles meeting there is
 * the master and the other moves onto it: the coarser of the two, or for two
 * tiles of the same level the one to the west or north. A side facing finer
 * tiles is never moved; they come to it. Each border vertex of the moving
 * tile is displaced by the difference between the master's drawn edge and its
 * own at that point along the side, and everything else baked at that point
 * - skirt, wall, landuse fill - rides along by the same amount, so it keeps
 * hanging where it hung. The tile's vertices then lie on the master's edge;
 * what is left is a T-junction where the master has a vertex the tile does
 * not, bounded by how far the bake let the two borders differ.
 *
 * The bake writes which vertices lie on which side, and where along it (see
 * PtmBorder). A tile baked without that table is drawn as it was baked: it
 * neither moves nor serves as a master.
 *
 * Moving vertices cannot close a T-junction: where the master has a vertex
 * this tile does not, the tile's straight edge cuts past it by up to the bake's
 * border tolerance (3-6 m measured on Gran Canaria, at every level pair). So
 * each moved side also gets a fill: for every edge of the tile with master
 * vertices inside its span, the sliver between the edge and the master's line
 * through those vertices, fanned from the edge's first end. It is drawn as
 * part of the tile, with the edge's normal and colour, and is rebuilt
 * whenever the tile is restitched.
 */

import * as THREE from 'three';
import {
    PTM_SIDE_E, PTM_SIDE_N, PTM_SIDE_S, PTM_SIDE_W, PtmBorder, borderEntryIndex, borderEntrySide,
} from './ptm';
import { TileKey, tileKeyString, xCount, yCount } from './tiling';

/** What the stitcher needs of a drawn tile; a TileMeshes has all of it. */
export interface StitchableTile {
    group: THREE.Object3D;
    border?: PtmBorder;
    /** The drawn land mesh; the fill copies its material and draw hook. */
    land?: THREE.Mesh;
    landGeometryFaceted?: THREE.BufferGeometry;
    landGeometrySmooth?: THREE.BufferGeometry;
    seam?: SeamState;
    /** The T-junction fill, while there is one; a child of `group`. */
    seamFill?: THREE.Mesh;
}

/** Per-tile bookkeeping, kept on the tile itself so it goes when the tile does. */
export interface SeamState {
    /** Positions of the border table's vertices as baked, 3 per entry. */
    orig: Int16Array;
    /** Each side's surface edges, sorted along the side. */
    edges: SideEdges[];
    /** Master and its version per side, as last applied. */
    signature: string;
    /**
     * Renewed whenever this tile's border moves, so tiles stitched to it
     * follow. Unique across tiles, so a master evicted and streamed back in
     * (as baked again) never matches the stamp it had before.
     */
    version: number;
}

interface SideEdges {
    lo: Float64Array;
    hi: Float64Array;
    /** Params and land vertex indices of both ends, in edge order. */
    pa: Float64Array;
    pb: Float64Array;
    va: Uint32Array;
    vb: Uint32Array;
}

const OPPOSITE = [PTM_SIDE_E, PTM_SIDE_W, PTM_SIDE_S, PTM_SIDE_N];
/** Params are float32; this much slack lets an end of the side find its edge. */
const PARAM_EPS = 1e-6;

/** The tile across `side`, at the same level; undefined past a pole. */
export function neighbourAcross(id: TileKey, side: number): TileKey | undefined {
    const cols = xCount(id.z);
    switch (side) {
        case PTM_SIDE_W: return { z: id.z, x: (id.x - 1 + cols) % cols, y: id.y };
        case PTM_SIDE_E: return { z: id.z, x: (id.x + 1) % cols, y: id.y };
        case PTM_SIDE_N: return id.y > 0 ? { z: id.z, x: id.x, y: id.y - 1 } : undefined;
        default: return id.y + 1 < yCount(id.z) ? { z: id.z, x: id.x, y: id.y + 1 } : undefined;
    }
}

/**
 * The drawn tile `id` moves its `side` onto, if any: the drawn tile covering
 * the ground across that side, when it is coarser, or the same level and to
 * the west or north. Undefined when finer tiles are drawn there (they move
 * onto this one) or nothing is.
 */
export function masterOf<T>(
    id: TileKey, side: number, drawn: ReadonlyMap<string, T>,
): { id: TileKey; tile: T } | undefined {
    const across = neighbourAcross(id, side);
    if (!across) {
        return undefined;
    }
    for (let z = id.z; z >= 0; z--) {
        const shift = id.z - z;
        const key: TileKey = { z, x: across.x >> shift, y: across.y >> shift };
        const tile = drawn.get(tileKeyString(key));
        if (tile === undefined) {
            continue;
        }
        if (z === id.z && side !== PTM_SIDE_W && side !== PTM_SIDE_N) {
            return undefined;
        }
        return { id: key, tile };
    }
    return undefined;
}

/**
 * Where `param` along this tile's `side` falls along the master's opposite
 * side. The master's side spans 2^(z - mz) of this tile's, and the two run
 * the same way (north to south, west to east).
 */
export function masterParam(id: TileKey, side: number, master: TileKey, param: number): number {
    const span = 2 ** (id.z - master.z);
    const along = side === PTM_SIDE_W || side === PTM_SIDE_E
        ? id.y - master.y * span
        : id.x - master.x * span;
    return (along + param) / span;
}

function positionsOf(g: THREE.BufferGeometry): THREE.BufferAttribute {
    return g.getAttribute('position') as THREE.BufferAttribute;
}

function stateOf(tile: StitchableTile): SeamState | undefined {
    if (tile.seam) {
        return tile.seam;
    }
    const border = tile.border;
    const g = tile.landGeometryFaceted;
    if (!border || !g || border.vertices.length === 0) {
        return undefined;
    }
    const pos = positionsOf(g).array as Int16Array;
    const orig = new Int16Array(border.vertices.length * 3);
    for (let i = 0; i < border.vertices.length; i++) {
        const v = borderEntryIndex(border.vertices[i]);
        orig[i * 3] = pos[v * 3];
        orig[i * 3 + 1] = pos[v * 3 + 1];
        orig[i * 3 + 2] = pos[v * 3 + 2];
    }
    const perSide: number[][] = [[], [], [], []];
    for (let e = 0; e < border.edges.length / 2; e++) {
        perSide[borderEntrySide(border.edges[e * 2])].push(e);
    }
    const edges = perSide.map(list => {
        list.sort((a, b) => Math.min(border.edgeParams[a * 2], border.edgeParams[a * 2 + 1])
            - Math.min(border.edgeParams[b * 2], border.edgeParams[b * 2 + 1]));
        const n = list.length;
        const out: SideEdges = {
            lo: new Float64Array(n), hi: new Float64Array(n),
            pa: new Float64Array(n), pb: new Float64Array(n),
            va: new Uint32Array(n), vb: new Uint32Array(n),
        };
        list.forEach((e, i) => {
            out.pa[i] = border.edgeParams[e * 2];
            out.pb[i] = border.edgeParams[e * 2 + 1];
            out.lo[i] = Math.min(out.pa[i], out.pb[i]);
            out.hi[i] = Math.max(out.pa[i], out.pb[i]);
            out.va[i] = borderEntryIndex(border.edges[e * 2]);
            out.vb[i] = borderEntryIndex(border.edges[e * 2 + 1]);
        });
        return out;
    });
    tile.seam = { orig, edges, signature: '', version: ++stamps };
    return tile.seam;
}

/** The edge of `side` containing `param`, or -1 where the side has no land. */
function edgeAt(edges: SideEdges, param: number): number {
    let lo = 0;
    let hi = edges.lo.length - 1;
    // Last edge starting at or before param.
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (edges.lo[mid] <= param + PARAM_EPS) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    // Edges abut, so the one found may end just short of a param that the
    // next one starts on; check a neighbour either side.
    for (const i of [found, found - 1, found + 1]) {
        if (i >= 0 && i < edges.lo.length
            && edges.lo[i] - PARAM_EPS <= param && param <= edges.hi[i] + PARAM_EPS) {
            return i;
        }
    }
    return -1;
}

/** Point at `param` on edge `i`, from vertex positions `read` gives. */
function pointOn(
    edges: SideEdges, i: number, param: number,
    read: (v: number, out: THREE.Vector3) => THREE.Vector3, out: THREE.Vector3,
): THREE.Vector3 {
    const a = read(edges.va[i], _a);
    const b = read(edges.vb[i], _b);
    const len = edges.pb[i] - edges.pa[i];
    const t = len === 0 ? 0 : Math.min(1, Math.max(0, (param - edges.pa[i]) / len));
    return out.copy(a).lerp(b, t);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _own = new THREE.Vector3();
const _master = new THREE.Vector3();
const _toLocal = new THREE.Matrix4();

const I16_MAX = 32767;
let stamps = 0;

/**
 * A master vertex closer than this (m) to the tile's edge gets no fill.
 * Every one of them used to: on Gran Canaria that was 19k triangles over 62
 * tiles for 3.1k cracks wider than half a metre. Narrower ones are still
 * covered by the skirt every tile hangs.
 */
export const SEAM_FILL_MIN_GAP_M = 0.5;

/**
 * Re-stitches every drawn tile whose neighbourhood changed since the last
 * call. `drawn` is what is on screen this pass, without the ancestors drawn
 * under a leaf dissolve; their children are what the neighbours meet.
 * Returns how many tiles moved.
 */
export function stitchSeams(drawn: ReadonlyArray<{ id: TileKey; tile: StitchableTile }>): number {
    const byKey = new Map<string, StitchableTile>();
    for (const d of drawn) {
        byKey.set(tileKeyString(d.id), d.tile);
    }
    // Masters first: coarser before finer, and among one level west and
    // north before east and south, so a master's own border has settled
    // before anything is read off it.
    const order = [...drawn].sort((a, b) => a.id.z - b.id.z || a.id.y - b.id.y || a.id.x - b.id.x);
    let moved = 0;
    for (const { id, tile } of order) {
        const state = stateOf(tile);
        if (!state) {
            continue;
        }
        const masters = [0, 1, 2, 3].map(side => {
            const m = masterOf(id, side, byKey);
            const ms = m ? stateOf(m.tile) : undefined;
            return m && ms ? { id: m.id, tile: m.tile, state: ms } : undefined;
        });
        const signature = masters
            .map(m => (m ? `${tileKeyString(m.id)}@${m.state.version}` : '-'))
            .join('|');
        if (signature === state.signature) {
            continue;
        }
        state.signature = signature;
        if (applyStitch(id, tile, state, masters)) {
            state.version = ++stamps;
            moved++;
        }
        rebuildFill(id, tile, state, masters);
    }
    return moved;
}

function applyStitch(
    id: TileKey, tile: StitchableTile, state: SeamState,
    masters: Array<{ id: TileKey; tile: StitchableTile; state: SeamState } | undefined>,
): boolean {
    const border = tile.border!;
    const attr = positionsOf(tile.landGeometryFaceted!);
    const pos = attr.array as Int16Array;
    const smoothAttr = tile.landGeometrySmooth ? positionsOf(tile.landGeometrySmooth) : undefined;
    const smoothIndex = tile.landGeometrySmooth?.getIndex()?.array;

    // This tile's own edge, as baked: where its surface was before any move.
    const firstEntry = new Map<number, number>();
    for (let i = border.vertices.length - 1; i >= 0; i--) {
        firstEntry.set(borderEntryIndex(border.vertices[i]), i);
    }
    const readOwn = (v: number, out: THREE.Vector3) => {
        const i = firstEntry.get(v)!;
        return out.set(state.orig[i * 3], state.orig[i * 3 + 1], state.orig[i * 3 + 2]);
    };

    // New position per border entry; a corner is on two sides, and the side
    // with the coarser master wins it, so it is applied last.
    const rank = (side: number) => masters[side]?.id.z ?? 99;
    const sideOrder = [0, 1, 2, 3].sort((a, b) => rank(b) - rank(a));
    // Per vertex, not per entry: a corner has an entry on each of its sides.
    const target = new Map<number, [number, number, number]>();
    for (const side of sideOrder) {
        const m = masters[side];
        if (!m) {
            continue;
        }
        const mPos = positionsOf(m.tile.landGeometryFaceted!).array as Int16Array;
        _toLocal.copy(tile.group.matrix).invert().multiply(m.tile.group.matrix);
        const readMaster = (v: number, out: THREE.Vector3) =>
            out.set(mPos[v * 3], mPos[v * 3 + 1], mPos[v * 3 + 2]).applyMatrix4(_toLocal);
        const ownEdges = state.edges[side];
        const masterEdges = m.state.edges[OPPOSITE[side]];
        for (let i = 0; i < border.vertices.length; i++) {
            if (borderEntrySide(border.vertices[i]) !== side) {
                continue;
            }
            const p = border.vertexParams[i];
            const oe = edgeAt(ownEdges, p);
            const mp = masterParam(id, side, m.id, p);
            const me = edgeAt(masterEdges, mp);
            if (oe < 0 || me < 0) {
                continue;
            }
            pointOn(ownEdges, oe, p, readOwn, _own);
            pointOn(masterEdges, me, mp, readMaster, _master);
            const q = (k: number) => Math.max(-I16_MAX, Math.min(I16_MAX,
                Math.round(state.orig[i * 3 + k] + _master.getComponent(k) - _own.getComponent(k))));
            target.set(borderEntryIndex(border.vertices[i]), [q(0), q(1), q(2)]);
        }
    }

    let changed = false;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < border.vertices.length; i++) {
        const v = borderEntryIndex(border.vertices[i]);
        const to = target.get(v) ?? [state.orig[i * 3], state.orig[i * 3 + 1], state.orig[i * 3 + 2]];
        for (let k = 0; k < 3; k++) {
            if (pos[v * 3 + k] !== to[k]) {
                pos[v * 3 + k] = to[k];
                changed = true;
                lo = Math.min(lo, v);
                hi = Math.max(hi, v);
            }
        }
        if (smoothAttr && smoothIndex) {
            const s = smoothIndex[v];
            const sp = smoothAttr.array as Int16Array;
            sp[s * 3] = to[0];
            sp[s * 3 + 1] = to[1];
            sp[s * 3 + 2] = to[2];
        }
    }
    if (changed) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(lo * 3, (hi - lo + 1) * 3);
        attr.needsUpdate = true;
        if (smoothAttr) {
            smoothAttr.needsUpdate = true;
        }
    }
    return changed;
}

/** Drops a tile's T-junction fill, freeing its buffers. */
export function disposeSeamFill(tile: StitchableTile): void {
    if (tile.seamFill) {
        tile.seamFill.removeFromParent();
        tile.seamFill.geometry.dispose();
        tile.seamFill = undefined;
    }
}

/** One fill vertex: where it is, and which border vertices it takes its look from. */
export interface FillVertex {
    x: number;
    y: number;
    z: number;
    /** The edge's two land vertices; the fill blends their colour by `t`. */
    a: number;
    b: number;
    t: number;
}

type Masters = ReadonlyArray<{ id: TileKey; tile: StitchableTile; state: SeamState } | undefined>;

/**
 * The fill for every moved side of `tile`, three vertices per triangle, in
 * the tile's own frame. Exported for the tests, which check the triangles
 * rather than a mesh.
 */
export function seamFillVertices(id: TileKey, tile: StitchableTile, state: SeamState, masters: Masters): FillVertex[] {
    const out: FillVertex[] = [];
    const pos = positionsOf(tile.landGeometryFaceted!).array as Int16Array;
    const own = (v: number) => new THREE.Vector3(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    for (let side = 0; side < 4; side++) {
        const m = masters[side];
        if (!m) {
            continue;
        }
        const mPos = positionsOf(m.tile.landGeometryFaceted!).array as Int16Array;
        const toLocal = new THREE.Matrix4().copy(tile.group.matrix).invert().multiply(m.tile.group.matrix);
        const readMaster = (v: number, o: THREE.Vector3) =>
            o.set(mPos[v * 3], mPos[v * 3 + 1], mPos[v * 3 + 2]).applyMatrix4(toLocal);
        const masterEdges = m.state.edges[OPPOSITE[side]];
        const span = 2 ** (id.z - m.id.z);
        const toMaster = (p: number) => masterParam(id, side, m.id, p);
        // The master's vertices along this tile's stretch, in this tile's
        // params and frame, sorted.
        const inner: Array<{ p: number; at: THREE.Vector3 }> = [];
        const start = toMaster(0);
        for (let i = 0; i < masterEdges.lo.length; i++) {
            const ends: Array<[number, number]> = [[masterEdges.pa[i], masterEdges.va[i]], [masterEdges.pb[i], masterEdges.vb[i]]];
            for (const [mp, v] of ends) {
                const p = (mp - start) * span;
                if (p > PARAM_EPS && p < 1 - PARAM_EPS) {
                    inner.push({ p, at: readMaster(v, new THREE.Vector3()) });
                }
            }
        }
        inner.sort((a, b) => a.p - b.p);
        const ownEdges = state.edges[side];
        // Positions are in quantised units; the group's scale is uniform.
        const minGap = SEAM_FILL_MIN_GAP_M / (tile.group.scale.x || 1);
        for (let e = 0; e < ownEdges.lo.length; e++) {
            const forward = ownEdges.pa[e] <= ownEdges.pb[e];
            const pa = forward ? ownEdges.pa[e] : ownEdges.pb[e];
            const pb = forward ? ownEdges.pb[e] : ownEdges.pa[e];
            const va = forward ? ownEdges.va[e] : ownEdges.vb[e];
            const vb = forward ? ownEdges.vb[e] : ownEdges.va[e];
            const startEdge = edgeAt(masterEdges, toMaster(pa));
            const endEdge = edgeAt(masterEdges, toMaster(pb));
            const a = own(va);
            const b = own(vb);
            const tOf = (p: number) => (pb > pa ? (p - pa) / (pb - pa) : 0);
            // The outline of the crack: the master's line from this edge's
            // start to its end, then back along the edge. Points within
            // minGap of the edge are left out, and so are the ends where the
            // edge's own ends already sit on the master's line (as a moved
            // side's do, to within quantisation) or the master has no land.
            const line: Array<{ p: number; at: THREE.Vector3 }> = [];
            let lastP = pa;
            const startAt = startEdge >= 0
                ? pointOn(masterEdges, startEdge, toMaster(pa), readMaster, new THREE.Vector3())
                : undefined;
            if (startAt && startAt.distanceTo(a) >= minGap) {
                line.push({ p: pa, at: startAt });
            }
            for (const q of inner) {
                if (q.p > pa + PARAM_EPS && q.p < pb - PARAM_EPS && q.p - lastP > PARAM_EPS
                    && q.at.distanceTo(_own.lerpVectors(a, b, tOf(q.p))) >= minGap) {
                    line.push(q);
                    lastP = q.p;
                }
            }
            const endAt = endEdge >= 0
                ? pointOn(masterEdges, endEdge, toMaster(pb), readMaster, new THREE.Vector3())
                : undefined;
            if (endAt && endAt.distanceTo(b) >= minGap) {
                line.push({ p: pb, at: endAt });
            }
            if (line.length === 0) {
                continue;
            }
            line.push({ p: pb, at: b });
            for (let i = 0; i + 1 < line.length; i++) {
                const p = line[i].at;
                const q = line[i + 1].at;
                if (_a.subVectors(p, a).cross(_b.subVectors(q, a)).lengthSq() < 1) {
                    continue;
                }
                out.push(
                    { x: a.x, y: a.y, z: a.z, a: va, b: vb, t: 0 },
                    { x: p.x, y: p.y, z: p.z, a: va, b: vb, t: tOf(line[i].p) },
                    { x: q.x, y: q.y, z: q.z, a: va, b: vb, t: tOf(line[i + 1].p) },
                );
            }
        }
    }
    return out;
}

function rebuildFill(id: TileKey, tile: StitchableTile, state: SeamState, masters: Masters): void {
    disposeSeamFill(tile);
    const land = tile.land;
    const faceted = tile.landGeometryFaceted;
    if (!land || !faceted) {
        return;
    }
    const verts = seamFillVertices(id, tile, state, masters);
    if (verts.length === 0) {
        return;
    }
    const n = verts.length;
    const position = new Int16Array(n * 3);
    const normals = new Int8Array(n * 4);
    const attrs = new Uint8Array(n * 4);
    const sizes = new Uint16Array(n);
    const nArr = (faceted.getAttribute('normal') as THREE.InterleavedBufferAttribute | undefined)?.data.array as Int8Array | undefined;
    const cArr = (faceted.getAttribute('coverColor') as THREE.InterleavedBufferAttribute | undefined)?.data.array as Uint8Array | undefined;
    const sArr = (faceted.getAttribute('regionSize') as THREE.BufferAttribute | undefined)?.array as Uint16Array | undefined;
    const clamp = (q: number) => Math.max(-I16_MAX, Math.min(I16_MAX, Math.round(q)));
    verts.forEach((v, i) => {
        position[i * 3] = clamp(v.x);
        position[i * 3 + 1] = clamp(v.y);
        position[i * 3 + 2] = clamp(v.z);
        for (let k = 0; k < 3; k++) {
            normals[i * 4 + k] = nArr ? nArr[v.a * 4 + k] : (k === 1 ? 127 : 0);
            attrs[i * 4 + k] = cArr ? Math.round(cArr[v.a * 4 + k] * (1 - v.t) + cArr[v.b * 4 + k] * v.t) : 128;
        }
        attrs[i * 4 + 3] = cArr ? cArr[v.a * 4 + 3] : 0;
        sizes[i] = sArr ? sArr[v.a] : 0;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(normals, 4), 3, 0, true));
    const attrBuffer = new THREE.InterleavedBuffer(attrs, 4);
    g.setAttribute('coverColor', new THREE.InterleavedBufferAttribute(attrBuffer, 3, 0, true));
    g.setAttribute('coverClass', new THREE.InterleavedBufferAttribute(attrBuffer, 1, 3, false));
    g.setAttribute('regionSize', new THREE.BufferAttribute(sizes, 1, false));
    for (const group of faceted.groups) {
        g.addGroup(0, n, group.materialIndex);
    }
    const mesh = new THREE.Mesh(g, land.material);
    mesh.name = 'seamFill';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    // Shared, not copied: the far cover binding lands on it later.
    mesh.userData = land.userData;
    mesh.onBeforeRender = land.onBeforeRender;
    mesh.renderOrder = land.renderOrder;
    tile.group.add(mesh);
    tile.seamFill = mesh;
}

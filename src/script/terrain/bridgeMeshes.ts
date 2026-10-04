/**
 * Bridge geometry at runtime: fetching the PBR1 sidecar a leaf tile has and
 * binding it as two shaded meshes - road surface and concrete - in the
 * tile's own group.
 *
 * Modelled on RoadStrokes: the sidecar arrives on its own store, gated by
 * index_bridges.bin, and is attached to the resident tile whenever it lands;
 * nothing waits on it. Bridges replace the road stroke under their span in the
 * leaf (see bake_osm_roads.py), so they follow the Roads setting: with roads
 * off there is no stroke and no deck either.
 *
 * Positions are quantised in the tile's own step, like the road strokes; the
 * normals are the flat face normals baked in that frame, with the material
 * role in the fourth byte, read once here to split the index list.
 */

import * as THREE from 'three';
import { RoadsMode } from '../state/gameDefs';
import { TerrainManifest, bridgeTileUrl } from './manifest';
import { BridgeRole, PBR_BOX_FLOATS, PbrTile, decodePbr } from './pbr';
import { ROAD_RENDER_ORDER, addTrackPasses, strokeGeometry } from './roadStrokes';
import { TileIndex } from './tileIndex';
import { TileMeshes } from './tileMesh';
import { TileStore } from './tileStore';
import { TileKey } from './tiling';

/** Decoded sidecars kept; a bound tile no longer needs its bytes. */
const BRIDGE_CACHE_BYTES = 16 * 1024 * 1024;

export interface BridgeMeshSet {
    group: THREE.Group;
    deck?: THREE.Mesh;
    concrete?: THREE.Mesh;
    railDeck?: THREE.Mesh;
    /** Level-crossing furniture: red stripes, white stripes and barrier posts, grey sign posts. */
    signRed?: THREE.Mesh;
    signWhite?: THREE.Mesh;
    signPost?: THREE.Mesh;
    /** Meshes past one per slot (furniture beside a role's bridge geometry). */
    extra?: THREE.Mesh[];
    /** Sleepers and rails along the rail decks, a rail stroke. */
    track?: THREE.Mesh;
    /** The deck track's sleeper and rail passes, sharing `track`'s geometry. */
    trackDetail?: THREE.Mesh;
    trackTop?: THREE.Mesh;
    /** GPU bytes bound, for the cache budget. */
    bytes: number;
}

export interface BridgeMeshesOptions {
    manifest: TerrainManifest;
    baseUrl: string;
    /** Road surface on top of a deck. */
    deckMaterial: THREE.Material;
    /** Undersides, sides, parapets, piers, abutments. */
    concreteMaterial: THREE.Material;
    /** Track bed on top of a rail bridge deck. */
    railDeckMaterial: THREE.Material;
    /** Level-crossing furniture, by colour. Absent: the furniture is not drawn. */
    signRedMaterial?: THREE.Material;
    signWhiteMaterial?: THREE.Material;
    signPostMaterial?: THREE.Material;
    /** The road strokes' rail materials, for the track on the decks: bed, then sleepers and rails. */
    trackMaterial: THREE.Material;
    trackDetailMaterial?: THREE.Material;
    trackTopMaterial?: THREE.Material;
    onBeforeRender?: THREE.Mesh['onBeforeRender'];
}

export interface BridgeMeshesStats {
    attached: number;
    inflight: number;
    queued: number;
    failed: number;
    triangles: number;
}

/** One role's index list over the shared vertices, or undefined if the tile has none. */
function roleIndices(tile: PbrTile, role: BridgeRole): Uint16Array | undefined {
    const all = tile.indices;
    let count = 0;
    for (let i = 0; i < all.length; i += 3) {
        if (tile.normals[all[i] * 4 + 3] === role) {
            count += 3;
        }
    }
    if (count === 0) {
        return undefined;
    }
    if (count === all.length) {
        return all;
    }
    const out = new Uint16Array(count);
    let o = 0;
    for (let i = 0; i < all.length; i += 3) {
        if (tile.normals[all[i] * 4 + 3] === role) {
            out[o++] = all[i];
            out[o++] = all[i + 1];
            out[o++] = all[i + 2];
        }
    }
    return out;
}

/**
 * The boxes of one role as flat-shaded triangles, in the sidecar's
 * quantisation units (metres / quantScale), so they sit in the tile's group
 * beside the bridge geometry. Undefined when there are none of that role.
 */
export function boxGeometry(boxes: Float32Array, role: BridgeRole, quantScale: number): THREE.BufferGeometry | undefined {
    const count = boxes.length / PBR_BOX_FLOATS;
    const mine: number[] = [];
    for (let i = 0; i < count; i++) {
        if (boxes[i * PBR_BOX_FLOATS + 15] === role) {
            mine.push(i);
        }
    }
    if (mine.length === 0) {
        return undefined;
    }
    const pos = new Float32Array(mine.length * 24 * 3);
    const nrm = new Float32Array(mine.length * 24 * 3);
    const idx = new Uint32Array(mine.length * 36);
    const inv = 1 / quantScale;
    let v = 0, t = 0;
    for (const i of mine) {
        const o = i * PBR_BOX_FLOATS;
        const c = [boxes[o], boxes[o + 1], boxes[o + 2]];
        const ax = [[boxes[o + 3], boxes[o + 4], boxes[o + 5]], [boxes[o + 6], boxes[o + 7], boxes[o + 8]],
            [boxes[o + 9], boxes[o + 10], boxes[o + 11]]];
        const h = [boxes[o + 12], boxes[o + 13], boxes[o + 14]];
        // Six faces: along each axis, at -h and +h, spanned by the other two.
        for (let f = 0; f < 3; f++) {
            const u = (f + 1) % 3, w = (f + 2) % 3;
            for (const sgn of [-1, 1]) {
                const base = v;
                for (const [su, sw] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
                    for (let k = 0; k < 3; k++) {
                        pos[v * 3 + k] = (c[k] + ax[f][k] * h[f] * sgn + ax[u][k] * h[u] * su + ax[w][k] * h[w] * sw) * inv;
                        nrm[v * 3 + k] = ax[f][k] * sgn;
                    }
                    v++;
                }
                idx.set([base, base + 1, base + 2, base, base + 2, base + 3], t);
                t += 6;
            }
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
}

function bridgeGeometry(tile: PbrTile, indices: Uint16Array): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tile.positions, 3));
    const normals = new THREE.InterleavedBuffer(tile.normals, 4);
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(normals, 3, 0, true));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    return g;
}

/** A material per role, in BridgeRole order. */
export interface BridgeMaterials {
    deck: THREE.Material;
    concrete: THREE.Material;
    railDeck: THREE.Material;
    signRed?: THREE.Material;
    signWhite?: THREE.Material;
    signPost?: THREE.Material;
    /** Optional: without it the track a sidecar carries is not drawn. */
    track?: THREE.Material;
    trackDetail?: THREE.Material;
    trackTop?: THREE.Material;
}

const ROLE_SLOTS: readonly [BridgeRole, 'deck' | 'concrete' | 'railDeck' | 'signRed' | 'signWhite' | 'signPost'][] = [
    [BridgeRole.Deck, 'deck'], [BridgeRole.Concrete, 'concrete'], [BridgeRole.RailDeck, 'railDeck'],
    [BridgeRole.SignRed, 'signRed'], [BridgeRole.SignWhite, 'signWhite'], [BridgeRole.SignPost, 'signPost'],
];

/**
 * Bind a decoded sidecar as a group of up to three meshes for a tile whose
 * group scale is `tileScale`. A sidecar from another bake of the mesh says so
 * in its header and is rescaled rather than drawn wrong.
 */
export function buildBridgeMeshes(
    tile: PbrTile, tileScale: number,
    materials: BridgeMaterials,
    onBeforeRender?: THREE.Mesh['onBeforeRender'],
): BridgeMeshSet {
    const group = new THREE.Group();
    group.name = `bridges:${tile.id.z}/${tile.id.x}/${tile.id.y}`;
    if (Math.abs(tile.quantScale - tileScale) > 1e-6 * tileScale) {
        group.scale.setScalar(tile.quantScale / tileScale);
    }
    group.updateMatrix();
    group.matrixAutoUpdate = false;
    const set: BridgeMeshSet = { group, bytes: 0 };
    for (const [role, slot] of ROLE_SLOTS) {
        const material = materials[slot];
        const indices = material ? roleIndices(tile, role) : undefined;
        if (!indices || !material) {
            continue;
        }
        const mesh = new THREE.Mesh(bridgeGeometry(tile, indices), material);
        // A span may overhang its tile, and its bounds are not computed.
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        if (onBeforeRender) {
            mesh.onBeforeRender = onBeforeRender;
        }
        group.add(mesh);
        set[slot] = mesh;
        set.bytes += indices.byteLength;
    }
    // Level-crossing furniture: float boxes, built here at full precision.
    if (tile.boxes) {
        for (const [role, slot] of ROLE_SLOTS) {
            const material = materials[slot];
            const g = material ? boxGeometry(tile.boxes, role, tile.quantScale) : undefined;
            if (!g || !material) {
                continue;
            }
            const mesh = new THREE.Mesh(g, material);
            mesh.frustumCulled = false;
            mesh.matrixAutoUpdate = false;
            if (onBeforeRender) {
                mesh.onBeforeRender = onBeforeRender;
            }
            group.add(mesh);
            // A tile has the furniture or the bridge geometry of a role in
            // practice; where both, the furniture rides in its own child.
            if (set[slot] === undefined) {
                set[slot] = mesh;
            } else {
                set.extra = [...(set.extra ?? []), mesh];
            }
            set.bytes += (g.getAttribute('position').array as Float32Array).byteLength * 2
                + (g.getIndex()?.array.byteLength ?? 0);
        }
    }
    const track = tile.track;
    if (track && materials.track) {
        // Bound exactly as a road sidecar's rail stroke, so the one material
        // draws the sleepers and rails on the ground and on the deck alike.
        // No switch zones on a deck: the flags are all clear.
        const flags = new Uint8Array(track.positions.length / 3);
        const stroke = { id: tile.id, quantScale: tile.quantScale, flags, ...track };
        const mesh = new THREE.Mesh(strokeGeometry(stroke, track.indices, true), materials.track);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        // After the deck, which writes depth: the stroke writes none and only
        // has to pass the test, floating TRACK_LIFT_M over the deck top.
        mesh.renderOrder = ROAD_RENDER_ORDER;
        if (onBeforeRender) {
            mesh.onBeforeRender = onBeforeRender;
        }
        group.add(mesh);
        set.track = mesh;
        const passes = addTrackPasses(group, mesh.geometry, materials.trackDetail, materials.trackTop, onBeforeRender);
        set.trackDetail = passes.sleepers;
        set.trackTop = passes.rails;
        set.bytes += track.positions.byteLength + track.directions.byteLength + track.halfWidths.byteLength
            + track.along.byteLength + track.indices.byteLength;
    }
    set.bytes += tile.positions.byteLength + tile.normals.byteLength;
    return set;
}

function triangles(set: BridgeMeshSet): number {
    let n = 0;
    for (const mesh of [set.deck, set.concrete, set.railDeck, set.signRed, set.signWhite, set.signPost,
        set.track, set.trackDetail, set.trackTop, ...(set.extra ?? [])]) {
        if (mesh) {
            n += (mesh.geometry.getIndex()?.count ?? 0) / 3;
        }
    }
    return n;
}

export class BridgeMeshes {
    private readonly store: TileStore<PbrTile> | undefined;
    private readonly minZoom: number;
    private readonly maxZoom: number;
    private readonly materials: BridgeMaterials;
    private readonly onBeforeRender: THREE.Mesh['onBeforeRender'] | undefined;
    private index: TileIndex | undefined;
    private mode: RoadsMode = RoadsMode.ALL;
    private readonly attached = new Set<BridgeMeshSet>();
    private tris = 0;

    constructor(opts: BridgeMeshesOptions) {
        const spec = opts.manifest.bridges;
        this.minZoom = spec?.minZoom ?? 0;
        this.maxZoom = spec?.maxZoom ?? -1;
        this.materials = {
            deck: opts.deckMaterial, concrete: opts.concreteMaterial, railDeck: opts.railDeckMaterial,
            signRed: opts.signRedMaterial, signWhite: opts.signWhiteMaterial, signPost: opts.signPostMaterial,
            track: opts.trackMaterial,
            trackDetail: opts.trackDetailMaterial,
            trackTop: opts.trackTopMaterial,
        };
        this.onBeforeRender = opts.onBeforeRender;
        this.store = spec === undefined ? undefined : new TileStore<PbrTile>({
            baseUrl: opts.baseUrl,
            url: (id) => bridgeTileUrl(opts.manifest, id.z, id.x, id.y, opts.baseUrl),
            decode: (buf) => decodePbr(buf),
            sizeOf: (t) => t.positions.byteLength + t.normals.byteLength + t.indices.byteLength,
            maxBytes: BRIDGE_CACHE_BYTES,
            exists: (id) => this.has(id),
        });
    }

    /** Whether the pyramid ships bridges at all. */
    get enabled(): boolean {
        return this.store !== undefined;
    }

    /** Follows the Roads setting: off hides what is attached and stops new fetches. */
    setMode(mode: RoadsMode): void {
        this.mode = mode;
        for (const set of this.attached) {
            this.applyMode(set);
        }
    }

    private applyMode(set: BridgeMeshSet): void {
        set.group.visible = this.mode !== RoadsMode.OFF;
    }

    setIndex(index: TileIndex | undefined): void {
        this.index = index;
    }

    /** Whether the bake wrote a sidecar for this tile. */
    has(id: TileKey): boolean {
        if (id.z < this.minZoom || id.z > this.maxZoom) {
            return false;
        }
        return this.index ? this.index.has(id) : true;
    }

    /**
     * Give a resident tile its bridges, now if the sidecar is decoded and
     * otherwise when it arrives. Called for every drawn tile every reconcile;
     * past the first call per tile, and for every tile above the leaf, it is
     * a field read.
     */
    attach(id: TileKey, meshes: TileMeshes, priority: number): void {
        if (meshes.bridges !== undefined || !this.store || this.mode === RoadsMode.OFF || !this.has(id)) {
            return;
        }
        if (this.store.isAbsent(id)) {
            meshes.bridges = 'none';
            return;
        }
        meshes.bridges = 'pending';
        const cached = this.store.get(id);
        if (cached) {
            this.bind(meshes, cached);
            return;
        }
        void this.store.request(id, priority).then(tile => {
            if (meshes.bridges !== 'pending') {
                return;
            }
            if (tile === null) {
                meshes.bridges = 'none';
                return;
            }
            this.bind(meshes, tile);
        });
    }

    private bind(meshes: TileMeshes, tile: PbrTile): void {
        const set = buildBridgeMeshes(
            tile, meshes.group.scale.x, this.materials, this.onBeforeRender,
        );
        this.applyMode(set);
        meshes.group.add(set.group);
        meshes.bridges = set;
        meshes.bytes += set.bytes;
        this.attached.add(set);
        this.tris += triangles(set);
    }

    /** A tile is being released; drop its bridges. */
    release(meshes: TileMeshes): void {
        const set = meshes.bridges;
        if (set !== undefined && set !== 'pending' && set !== 'none') {
            this.attached.delete(set);
            this.tris -= triangles(set);
            set.deck?.geometry.dispose();
            set.concrete?.geometry.dispose();
            set.railDeck?.geometry.dispose();
            set.signRed?.geometry.dispose();
            set.signWhite?.geometry.dispose();
            set.signPost?.geometry.dispose();
            set.extra?.forEach(m => m.geometry.dispose());
            set.track?.geometry.dispose();
            set.group.clear();
        }
        // A sidecar still in flight must not bind to a released tile.
        meshes.bridges = 'none';
    }

    /** Triangles the bridges of a drawn tile add, for the frame's count. */
    trianglesOf(meshes: TileMeshes): number {
        const set = meshes.bridges;
        if (set === undefined || set === 'pending' || set === 'none' || !set.group.visible) {
            return 0;
        }
        return triangles(set);
    }

    /** Sidecars nobody drew this generation may be evicted from the byte budget. */
    nextGeneration(): void {
        this.store?.nextGeneration();
    }

    get stats(): BridgeMeshesStats {
        const s = this.store?.stats;
        return {
            attached: this.attached.size,
            inflight: s?.inflight ?? 0,
            queued: s?.queued ?? 0,
            failed: s?.failed ?? 0,
            triangles: this.tris,
        };
    }
}

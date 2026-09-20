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
import { BridgeRole, PbrTile, decodePbr } from './pbr';
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

function bridgeGeometry(tile: PbrTile, indices: Uint16Array): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tile.positions, 3));
    const normals = new THREE.InterleavedBuffer(tile.normals, 4);
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(normals, 3, 0, true));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    return g;
}

/**
 * Bind a decoded sidecar as a group of up to two meshes for a tile whose
 * group scale is `tileScale`. A sidecar from another bake of the mesh says so
 * in its header and is rescaled rather than drawn wrong.
 */
export function buildBridgeMeshes(
    tile: PbrTile, tileScale: number,
    deckMaterial: THREE.Material, concreteMaterial: THREE.Material,
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
    for (const role of [BridgeRole.Deck, BridgeRole.Concrete]) {
        const indices = roleIndices(tile, role);
        if (!indices) {
            continue;
        }
        const mesh = new THREE.Mesh(
            bridgeGeometry(tile, indices),
            role === BridgeRole.Deck ? deckMaterial : concreteMaterial,
        );
        // A span may overhang its tile, and its bounds are not computed.
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        if (onBeforeRender) {
            mesh.onBeforeRender = onBeforeRender;
        }
        group.add(mesh);
        if (role === BridgeRole.Deck) {
            set.deck = mesh;
        } else {
            set.concrete = mesh;
        }
        set.bytes += indices.byteLength;
    }
    set.bytes += tile.positions.byteLength + tile.normals.byteLength;
    return set;
}

function triangles(set: BridgeMeshSet): number {
    let n = 0;
    for (const mesh of [set.deck, set.concrete]) {
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
    private readonly deckMaterial: THREE.Material;
    private readonly concreteMaterial: THREE.Material;
    private readonly onBeforeRender: THREE.Mesh['onBeforeRender'] | undefined;
    private index: TileIndex | undefined;
    private mode: RoadsMode = RoadsMode.ALL;
    private readonly attached = new Set<BridgeMeshSet>();
    private tris = 0;

    constructor(opts: BridgeMeshesOptions) {
        const spec = opts.manifest.bridges;
        this.minZoom = spec?.minZoom ?? 0;
        this.maxZoom = spec?.maxZoom ?? -1;
        this.deckMaterial = opts.deckMaterial;
        this.concreteMaterial = opts.concreteMaterial;
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
            tile, meshes.group.scale.x, this.deckMaterial, this.concreteMaterial, this.onBeforeRender,
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

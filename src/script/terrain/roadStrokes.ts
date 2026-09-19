/**
 * Road strokes at runtime: fetching the PTR1 sidecar a tile has, binding it
 * as two stroke meshes - major roads and minor - in the tile's own group,
 * and switching them with the player's setting.
 *
 * Modelled on CoverTextures: the sidecar arrives on its own store, gated by
 * index_roads.bin, and is attached to the resident tile whenever it lands.
 * Nothing waits on it; a tile drawn before its roads arrive is a tile of a
 * pyramid baked without roads. The setting is a visibility flip on what is
 * attached plus a gate on new fetches, so switching costs no re-stream and
 * no re-upload; "major" keeps motorways to secondaries and hides the rest.
 *
 * The geometry is bound the way the rivers are (see strokeGeometry in
 * tileMesh.ts): positions quantised in the tile's own step, the offset
 * across the road as a normalised int8 attribute, the half-width raw in
 * decimetres, widened per frame by RiverVertProgram. The class byte rides
 * in the offset's padding and is read once here, to split the index list.
 */

import * as THREE from 'three';
import { RoadsMode } from '../state/gameDefs';
import { TerrainManifest, roadTileUrl } from './manifest';
import { PtrTile, ROAD_MAJOR_MAX_CLASS, decodePtr } from './ptr';
import { TileIndex } from './tileIndex';
import { TileMeshes } from './tileMesh';
import { TileStore } from './tileStore';
import { TileKey } from './tiling';

/** Decoded sidecars kept; a bound tile no longer needs its bytes. */
const ROAD_STROKE_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * Draw order of the road strokes among a tile's meshes: over the ground and
 * the land-use outlines (1), under the rivers (2), so a bridge over a canal
 * still shows the water. The strokes write no depth, so order is all that
 * decides who wins where two overlap.
 */
export const ROAD_RENDER_ORDER = 1;

export interface RoadMeshes {
    group: THREE.Group;
    major?: THREE.Mesh;
    minor?: THREE.Mesh;
    /** GPU bytes bound, for the cache budget. */
    bytes: number;
}

export interface RoadStrokesOptions {
    manifest: TerrainManifest;
    baseUrl: string;
    /** Motorways to secondaries. */
    majorMaterial: THREE.Material;
    /** Tertiaries and below. */
    minorMaterial: THREE.Material;
    onBeforeRender?: THREE.Mesh['onBeforeRender'];
}

export interface RoadStrokesStats {
    attached: number;
    inflight: number;
    queued: number;
    failed: number;
    /** Triangles bound across attached tiles, both classes. */
    triangles: number;
}

/**
 * One class's index list over the shared stroke vertices, or undefined when
 * the tile has no stroke of that class. A pair, and every vertex of one
 * stroke, carry the same class, so a triangle's first vertex speaks for it.
 */
function classIndices(tile: PtrTile, major: boolean): Uint16Array | undefined {
    const all = tile.indices;
    const dirs = tile.directions;
    const wanted = (v: number) => (dirs[v * 4 + 3] <= ROAD_MAJOR_MAX_CLASS) === major;
    let count = 0;
    for (let i = 0; i < all.length; i += 3) {
        if (wanted(all[i])) {
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
        if (wanted(all[i])) {
            out[o++] = all[i];
            out[o++] = all[i + 1];
            out[o++] = all[i + 2];
        }
    }
    return out;
}

function strokeGeometry(tile: PtrTile, indices: Uint16Array): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tile.positions, 3));
    const dirBuffer = new THREE.InterleavedBuffer(tile.directions, 4);
    g.setAttribute('riverDir', new THREE.InterleavedBufferAttribute(dirBuffer, 3, 0, true));
    g.setAttribute('riverHalf', new THREE.BufferAttribute(tile.halfWidths, 1, false));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    return g;
}

/**
 * Bind a decoded sidecar as a group of up to two stroke meshes, major and
 * minor, for a tile whose group scale is `tileScale`. Positions are
 * quantised in the sidecar's own step, so the tile group's scale turns them
 * into metres; a sidecar from another bake of the mesh says so in its
 * header and is rescaled rather than drawn wrong.
 */
export function buildRoadMeshes(
    tile: PtrTile, tileScale: number,
    majorMaterial: THREE.Material, minorMaterial: THREE.Material,
    onBeforeRender?: THREE.Mesh['onBeforeRender'],
): RoadMeshes {
    const group = new THREE.Group();
    group.name = `roads:${tile.id.z}/${tile.id.x}/${tile.id.y}`;
    // Both steps came through a float32 header, so float32 precision is the
    // tolerance; anything past it is a different bake of the mesh.
    if (Math.abs(tile.quantScale - tileScale) > 1e-6 * tileScale) {
        group.scale.setScalar(tile.quantScale / tileScale);
    }
    group.updateMatrix();
    group.matrixAutoUpdate = false;
    const roads: RoadMeshes = { group, bytes: 0 };
    for (const major of [true, false]) {
        const indices = classIndices(tile, major);
        if (!indices) {
            continue;
        }
        const mesh = new THREE.Mesh(strokeGeometry(tile, indices), major ? majorMaterial : minorMaterial);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = ROAD_RENDER_ORDER;
        if (onBeforeRender) {
            mesh.onBeforeRender = onBeforeRender;
        }
        group.add(mesh);
        if (major) {
            roads.major = mesh;
        } else {
            roads.minor = mesh;
        }
        roads.bytes += indices.byteLength;
    }
    roads.bytes += tile.positions.byteLength + tile.directions.byteLength + tile.halfWidths.byteLength;
    return roads;
}

/** Triangles bound in both meshes, visible or not. */
export function roadTriangles(roads: RoadMeshes): number {
    let n = 0;
    for (const mesh of [roads.major, roads.minor]) {
        if (mesh) {
            n += (mesh.geometry.getIndex()?.count ?? 0) / 3;
        }
    }
    return n;
}

export class RoadStrokes {
    private readonly store: TileStore<PtrTile> | undefined;
    private readonly minZoom: number;
    private readonly maxZoom: number;
    private readonly majorMaterial: THREE.Material;
    private readonly minorMaterial: THREE.Material;
    private readonly onBeforeRender: THREE.Mesh['onBeforeRender'] | undefined;
    private index: TileIndex | undefined;
    private mode: RoadsMode = RoadsMode.ALL;
    private readonly attached = new Set<RoadMeshes>();
    private triangles = 0;

    constructor(opts: RoadStrokesOptions) {
        const spec = opts.manifest.roads;
        this.minZoom = spec?.minZoom ?? 0;
        this.maxZoom = spec?.maxZoom ?? -1;
        this.majorMaterial = opts.majorMaterial;
        this.minorMaterial = opts.minorMaterial;
        this.onBeforeRender = opts.onBeforeRender;
        this.store = spec === undefined ? undefined : new TileStore<PtrTile>({
            baseUrl: opts.baseUrl,
            url: (id) => roadTileUrl(opts.manifest, id.z, id.x, id.y, opts.baseUrl),
            decode: (buf) => decodePtr(buf),
            sizeOf: (t) => t.positions.byteLength + t.directions.byteLength
                + t.halfWidths.byteLength + t.indices.byteLength,
            maxBytes: ROAD_STROKE_CACHE_BYTES,
            exists: (id) => this.has(id),
        });
    }

    /** Whether the pyramid ships roads at all. */
    get enabled(): boolean {
        return this.store !== undefined;
    }

    /**
     * The player's switch. OFF stops new sidecars being fetched and hides
     * what is attached; MAJOR hides the minor roads only. A tile drawn while
     * off is asked again once on.
     */
    setMode(mode: RoadsMode): void {
        this.mode = mode;
        for (const roads of this.attached) {
            this.applyMode(roads);
        }
    }

    private applyMode(roads: RoadMeshes): void {
        if (roads.major) {
            roads.major.visible = this.mode !== RoadsMode.OFF;
        }
        if (roads.minor) {
            roads.minor.visible = this.mode === RoadsMode.ALL;
        }
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
     * Give a resident tile its roads, now if the sidecar is decoded and
     * otherwise when it arrives. Called for every drawn tile every
     * reconcile; past the first call per tile it is a field read.
     */
    attach(id: TileKey, meshes: TileMeshes, priority: number): void {
        if (meshes.roads !== undefined || !this.store || this.mode === RoadsMode.OFF) {
            return;
        }
        if (this.store.isAbsent(id)) {
            meshes.roads = 'none';
            return;
        }
        meshes.roads = 'pending';
        const cached = this.store.get(id);
        if (cached) {
            this.bind(id, meshes, cached);
            return;
        }
        void this.store.request(id, priority).then(tile => {
            if (meshes.roads !== 'pending') {
                return;
            }
            if (tile === null) {
                meshes.roads = 'none';
                return;
            }
            this.bind(id, meshes, tile);
        });
    }

    private bind(id: TileKey, meshes: TileMeshes, tile: PtrTile): void {
        const roads = buildRoadMeshes(
            tile, meshes.group.scale.x, this.majorMaterial, this.minorMaterial, this.onBeforeRender,
        );
        this.applyMode(roads);
        meshes.group.add(roads.group);
        meshes.roads = roads;
        meshes.bytes += roads.bytes;
        this.attached.add(roads);
        this.triangles += roadTriangles(roads);
    }

    /** A tile is being released; drop its roads. */
    release(meshes: TileMeshes): void {
        const roads = meshes.roads;
        if (roads !== undefined && roads !== 'pending' && roads !== 'none') {
            this.attached.delete(roads);
            this.triangles -= roadTriangles(roads);
            roads.major?.geometry.dispose();
            roads.minor?.geometry.dispose();
            roads.group.clear();
        }
        // A sidecar still in flight must not bind to a released tile.
        meshes.roads = 'none';
    }

    /** Triangles the roads of a drawn tile add, for the frame's count. */
    trianglesOf(meshes: TileMeshes): number {
        const roads = meshes.roads;
        if (roads === undefined || roads === 'pending' || roads === 'none') {
            return 0;
        }
        let n = 0;
        if (roads.major?.visible) {
            n += (roads.major.geometry.getIndex()?.count ?? 0) / 3;
        }
        if (roads.minor?.visible) {
            n += (roads.minor.geometry.getIndex()?.count ?? 0) / 3;
        }
        return n;
    }

    /** Sidecars nobody drew this generation may be evicted from the byte budget. */
    nextGeneration(): void {
        this.store?.nextGeneration();
    }

    get stats(): RoadStrokesStats {
        const s = this.store?.stats;
        return {
            attached: this.attached.size,
            inflight: s?.inflight ?? 0,
            queued: s?.queued ?? 0,
            failed: s?.failed ?? 0,
            triangles: this.triangles,
        };
    }
}

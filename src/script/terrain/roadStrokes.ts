/**
 * Road strokes at runtime: fetching the PTR1 sidecar a tile has, binding it
 * as up to three stroke meshes - major roads, minor roads and railways - in
 * the tile's own group,
 * and switching them with the player's setting.
 *
 * Modelled on CoverTextures: the sidecar arrives on its own store, gated by
 * index_roads.bin, and is attached to the resident tile whenever it lands.
 * Nothing waits on it; a tile drawn before its roads arrive is a tile of a
 * pyramid baked without roads. The setting is a visibility flip on what is
 * attached plus a gate on new fetches, so switching costs no re-stream and
 * no re-upload; "major" keeps motorways to secondaries and the railways and
 * hides the rest.
 *
 * The geometry is bound the way the rivers are (see strokeGeometry in
 * tileMesh.ts): positions quantised in the tile's own step, the offset
 * across the road as a normalised int8 attribute, the half-width raw in
 * decimetres, widened per frame by RiverVertProgram. The class byte rides
 * in the offset's padding and is read once here, to split the index list.
 */

import * as THREE from 'three';
import { RAIL_DETAIL_FADE_M } from '../scene/materials/shaders/depthFP';
import { RoadsMode } from '../state/gameDefs';
import { TerrainManifest, roadTileUrl } from './manifest';
import { PtrTile, ROAD_CLASS_MASK, ROAD_MAJOR_MAX_CLASS, decodePtr, isRailClass } from './ptr';
import { RoadLevels } from './roadLod';
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
    rail?: THREE.Mesh;
    /** The rail stroke's sleeper pass, over every bed: shares `rail`'s geometry. */
    railDetail?: THREE.Mesh;
    /** The rail stroke's rail pass, over every sleeper: shares `rail`'s geometry. */
    railTop?: THREE.Mesh;
    /** Set by RoadStrokes.showTrackDetail; the two passes above hide when false. */
    trackDetailInReach?: boolean;
    /** Coarser index lists for the road kinds, drawn far off (see roadLod.ts). */
    lod?: RoadLod;
    /** Triangles bound at full detail, for the resident count. */
    triangles?: number;
    /** GPU bytes bound, for the cache budget. */
    bytes: number;
}

/** A tile's road levels: which one it wants and what is built of them. */
interface RoadLod {
    want: number;
    kinds: Array<{
        mesh: THREE.Mesh;
        levels: RoadLevels;
        /** A geometry per distinct index list, sharing the full one's vertex buffers. */
        geometries: Map<Uint16Array, THREE.BufferGeometry>;
    }>;
}

export interface RoadStrokesOptions {
    manifest: TerrainManifest;
    baseUrl: string;
    /** Motorways to secondaries. */
    majorMaterial: THREE.Material;
    /** Tertiaries and below. */
    minorMaterial: THREE.Material;
    /** Railway track beds, the first pass. */
    railMaterial: THREE.Material;
    /** Sleepers, the second pass (uRailPass 1, transparent). Absent: beds only. */
    railDetailMaterial?: THREE.Material;
    /**
     * Called with a tile and its decoded sidecar before the strokes are
     * bound, which waits for it: the hook that lays railway beds into the
     * land (railBed.ts) and answers with the strokes to draw, the track on
     * its graded profile. The decoded sidecar is cached and shared, so the
     * hook must answer with a copy rather than change it.
     */
    prepare?: (id: TileKey, meshes: TileMeshes, tile: PtrTile) => Promise<PtrTile>;
    /** Rails, the third pass (uRailPass 2, transparent), drawn after every sleeper. */
    railTopMaterial?: THREE.Material;
    onBeforeRender?: THREE.Mesh['onBeforeRender'];
    /**
     * The local vertical in a tile's own axes, unit length: what the far
     * levels keep strokes above (see roadLod.ts). Without it there are none.
     */
    localUp?: (meshes: TileMeshes) => readonly [number, number, number];
}

export interface RoadStrokesStats {
    attached: number;
    inflight: number;
    queued: number;
    failed: number;
    /** Triangles bound across attached tiles, every class. */
    triangles: number;
}

/** The three meshes a sidecar splits into. */
type StrokeKind = 'major' | 'minor' | 'rail';
const STROKE_KINDS: readonly StrokeKind[] = ['major', 'minor', 'rail'];

/** A material per kind, and the rail stroke's second pass when there is one. */
export type StrokeMaterials = Readonly<Record<StrokeKind, THREE.Material>>
    & { readonly railDetail?: THREE.Material; readonly railTop?: THREE.Material };

/**
 * Draw order of the rail pass among the transparent meshes: after every
 * sleeper pass (ROAD_RENDER_ORDER), so no track's timbers cover another's rails.
 */
export const RAIL_TOP_RENDER_ORDER = ROAD_RENDER_ORDER + 0.5;

/** The sleeper and rail passes over a rail stroke's geometry, as children of `group`. */
export function addTrackPasses(
    group: THREE.Group, geometry: THREE.BufferGeometry,
    sleepers: THREE.Material | undefined, rails: THREE.Material | undefined,
    onBeforeRender?: THREE.Mesh['onBeforeRender'],
): { sleepers?: THREE.Mesh; rails?: THREE.Mesh } {
    const make = (material: THREE.Material, order: number): THREE.Mesh => {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = order;
        if (onBeforeRender) {
            mesh.onBeforeRender = onBeforeRender;
        }
        group.add(mesh);
        return mesh;
    };
    return {
        sleepers: sleepers ? make(sleepers, ROAD_RENDER_ORDER) : undefined,
        rails: rails ? make(rails, RAIL_TOP_RENDER_ORDER) : undefined,
    };
}

/**
 * Farthest, in metres, a track's sleeper and rail passes can put a fragment
 * on screen, for a camera of vertical `fovDeg` and `aspect` drawing `heightPx`
 * real pixels tall.
 *
 * The passes fade out completely once a pixel spans RAIL_DETAIL_FADE_M[1] of
 * ground (see RAIL_FRAGMENT): past this range every fragment is discarded,
 * so the draw is pure cost. Bounded low on purpose: a pixel's angle shrinks
 * by cos^2 towards a screen corner, and the footprint the shader takes, the
 * larger of fwidth across and along, is at least half their sum, which is at
 * least one screen step's length on the ground. A slanting view only ever
 * lengthens that step.
 */
export function trackDetailReachM(fovDeg: number, aspect: number, heightPx: number): number {
    const tanV = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
    const tanH = tanV * aspect;
    const centrePixel = (2 * tanV) / Math.max(1, heightPx);
    const cornerCos2 = 1 / (1 + tanV * tanV + tanH * tanH);
    return RAIL_DETAIL_FADE_M[1] / (centrePixel * cornerCos2);
}

function kindOf(byte: number): StrokeKind {
    const cls = byte & ROAD_CLASS_MASK;
    return isRailClass(cls) ? 'rail' : cls <= ROAD_MAJOR_MAX_CLASS ? 'major' : 'minor';
}

/**
 * One kind's index list over the shared stroke vertices, or undefined when
 * the tile has no stroke of that kind. A pair, and every vertex of one
 * stroke, carry the same class, so a triangle's first vertex speaks for it.
 */
function classIndices(tile: PtrTile, kind: StrokeKind): Uint16Array | undefined {
    const all = tile.indices;
    const dirs = tile.directions;
    const wanted = (v: number) => kindOf(dirs[v * 4 + 3]) === kind;
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

export function strokeGeometry(tile: PtrTile, indices: Uint16Array, rail: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tile.positions, 3));
    const dirBuffer = new THREE.InterleavedBuffer(tile.directions, 4);
    g.setAttribute('riverDir', new THREE.InterleavedBufferAttribute(dirBuffer, 3, 0, true));
    g.setAttribute('riverHalf', new THREE.BufferAttribute(tile.halfWidths, 1, false));
    if (rail) {
        // The track drawn into the stroke (RailVertProgram): which bank a
        // vertex is on rides in the class byte, the sleeper rhythm in `along`.
        g.setAttribute('riverMeta', new THREE.InterleavedBufferAttribute(dirBuffer, 1, 3, false));
        g.setAttribute('railAlong', new THREE.BufferAttribute(tile.along, 1, false));
        g.setAttribute('railFlags', new THREE.BufferAttribute(tile.flags, 1, false));
    }
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    return g;
}

/**
 * Bind a decoded sidecar as a group of up to three stroke meshes, major
 * roads, minor roads and railways, for a tile whose group scale is `tileScale`. Positions are
 * quantised in the sidecar's own step, so the tile group's scale turns them
 * into metres; a sidecar from another bake of the mesh says so in its
 * header and is rescaled rather than drawn wrong.
 */
export function buildRoadMeshes(
    tile: PtrTile, tileScale: number,
    materials: StrokeMaterials,
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
    for (const kind of STROKE_KINDS) {
        const indices = classIndices(tile, kind);
        if (!indices) {
            continue;
        }
        const mesh = new THREE.Mesh(strokeGeometry(tile, indices, kind === 'rail'), materials[kind]);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = ROAD_RENDER_ORDER;
        if (onBeforeRender) {
            mesh.onBeforeRender = onBeforeRender;
        }
        group.add(mesh);
        roads[kind] = mesh;
        roads.bytes += indices.byteLength;
        if (kind === 'rail') {
            // Every bed is opaque and drawn first; the detail passes are
            // transparent, so the renderer puts them after all of them.
            const passes = addTrackPasses(group, mesh.geometry, materials.railDetail, materials.railTop, onBeforeRender);
            roads.railDetail = passes.sleepers;
            roads.railTop = passes.rails;
        }
    }
    roads.bytes += tile.positions.byteLength + tile.directions.byteLength + tile.halfWidths.byteLength;
    return roads;
}

/** Triangles bound in every mesh, visible or not. */
export function roadTriangles(roads: RoadMeshes): number {
    let n = 0;
    for (const mesh of [roads.major, roads.minor, roads.rail, roads.railDetail, roads.railTop]) {
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
    private readonly materials: StrokeMaterials;
    private readonly prepare?: (id: TileKey, meshes: TileMeshes, tile: PtrTile) => Promise<PtrTile>;
    private readonly onBeforeRender: THREE.Mesh['onBeforeRender'] | undefined;
    private readonly localUp: RoadStrokesOptions['localUp'];
    /** Tiles that want a road level not built yet; see buildPendingLevel. */
    private readonly lodPending = new Set<RoadMeshes>();
    private index: TileIndex | undefined;
    private mode: RoadsMode = RoadsMode.ALL;
    private readonly attached = new Set<RoadMeshes>();
    private triangles = 0;

    constructor(opts: RoadStrokesOptions) {
        const spec = opts.manifest.roads;
        this.minZoom = spec?.minZoom ?? 0;
        this.maxZoom = spec?.maxZoom ?? -1;
        this.materials = {
            major: opts.majorMaterial, minor: opts.minorMaterial, rail: opts.railMaterial,
            railDetail: opts.railDetailMaterial,
            railTop: opts.railTopMaterial,
        };
        this.prepare = opts.prepare;
        this.onBeforeRender = opts.onBeforeRender;
        this.localUp = opts.localUp;
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
     * what is attached; MAJOR hides the minor roads only and keeps railways. A tile drawn while
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
        if (roads.rail) {
            roads.rail.visible = this.mode !== RoadsMode.OFF;
        }
        this.applyTrackDetail(roads);
    }

    private applyTrackDetail(roads: RoadMeshes): void {
        for (const mesh of [roads.railDetail, roads.railTop]) {
            if (mesh) {
                mesh.visible = this.mode !== RoadsMode.OFF && roads.trackDetailInReach !== false;
            }
        }
    }

    /**
     * Whether a drawn tile's sleeper and rail passes can show anything from
     * where the camera is (see trackDetailReachM). Out of reach they are
     * hidden rather than drawn to be discarded: two draws a railway tile.
     */
    showTrackDetail(meshes: TileMeshes, inReach: boolean): void {
        const roads = meshes.roads;
        if (roads === undefined || roads === 'pending' || roads === 'none'
            || roads.trackDetailInReach === inReach) {
            return;
        }
        roads.trackDetailInReach = inReach;
        this.applyTrackDetail(roads);
    }

    setIndex(index: TileIndex | undefined): void {
        this.index = index;
    }

    /** The decoded sidecar for a tile, or null when it has none; regardless of the display mode. */
    async load(id: TileKey, priority: number): Promise<PtrTile | null> {
        if (!this.store || !this.has(id) || this.store.isAbsent(id)) {
            return null;
        }
        return this.store.get(id) ?? this.store.request(id, priority).catch(() => null);
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
        if (!this.prepare) {
            this.finishBind(meshes, tile);
            return;
        }
        // Still 'pending' meanwhile; a release in between sets 'none'.
        void this.prepare(id, meshes, tile).catch(() => tile).then(prepared => {
            if (meshes.roads === 'pending' && !meshes.disposed) {
                this.finishBind(meshes, prepared);
            }
        });
    }

    private finishBind(meshes: TileMeshes, tile: PtrTile): void {
        const roads = buildRoadMeshes(
            tile, meshes.group.scale.x, this.materials, this.onBeforeRender,
        );
        this.applyMode(roads);
        if (this.localUp) {
            const up = this.localUp(meshes);
            const kinds: RoadLod['kinds'] = [];
            // A rail bed too: its sleeper and rail passes keep the full
            // geometry they were given, and only they read the spacing.
            for (const mesh of [roads.major, roads.minor, roads.rail]) {
                const index = mesh?.geometry.getIndex()?.array;
                if (mesh && index instanceof Uint16Array) {
                    kinds.push({
                        mesh, levels: new RoadLevels(tile, index, up),
                        geometries: new Map([[index, mesh.geometry]]),
                    });
                }
            }
            if (kinds.length > 0) {
                roads.lod = { want: 0, kinds };
            }
        }
        roads.triangles = roadTriangles(roads);
        meshes.group.add(roads.group);
        meshes.roads = roads;
        meshes.bytes += roads.bytes;
        this.attached.add(roads);
        this.triangles += roads.triangles;
    }

    /**
     * Draw a tile's roads at `level` (0 full; see roadLevelFor), or at the
     * finest level built below it until buildPendingLevel gets to it.
     */
    showLevel(meshes: TileMeshes, level: number): void {
        const roads = meshes.roads;
        if (roads === undefined || roads === 'pending' || roads === 'none' || !roads.lod) {
            return;
        }
        if (roads.lod.want === level) {
            return;
        }
        roads.lod.want = level;
        this.applyLevel(roads, roads.lod);
        if (roads.lod.kinds.some(k => !k.levels.has(level))) {
            this.lodPending.add(roads);
        }
    }

    /**
     * Build the road levels tiles are waiting for, for up to `budgetMs`. A
     * dense tile takes a few milliseconds a level, so a backlog drains over
     * frames instead of stalling one.
     */
    buildPendingLevels(budgetMs: number): void {
        const start = performance.now();
        for (const roads of this.lodPending) {
            const lod = roads.lod;
            if (lod) {
                for (const kind of lod.kinds) {
                    if (performance.now() - start >= budgetMs) {
                        return;
                    }
                    kind.levels.build(lod.want);
                }
                this.applyLevel(roads, lod);
            }
            this.lodPending.delete(roads);
        }
    }

    private applyLevel(roads: RoadMeshes, lod: RoadLod): void {
        for (const kind of lod.kinds) {
            const index = kind.levels.get(lod.want);
            let geometry = kind.geometries.get(index);
            if (!geometry) {
                const full = kind.geometries.values().next().value as THREE.BufferGeometry;
                geometry = new THREE.BufferGeometry();
                for (const [name, attribute] of Object.entries(full.attributes)) {
                    geometry.setAttribute(name, attribute);
                }
                geometry.setIndex(new THREE.BufferAttribute(index, 1));
                kind.geometries.set(index, geometry);
                roads.bytes += index.byteLength;
            }
            kind.mesh.geometry = geometry;
        }
    }

    /** A tile is being released; drop its roads. */
    release(meshes: TileMeshes): void {
        const roads = meshes.roads;
        if (roads !== undefined && roads !== 'pending' && roads !== 'none') {
            this.attached.delete(roads);
            this.lodPending.delete(roads);
            this.triangles -= roads.triangles ?? roadTriangles(roads);
            roads.major?.geometry.dispose();
            roads.minor?.geometry.dispose();
            roads.rail?.geometry.dispose();
            for (const kind of roads.lod?.kinds ?? []) {
                for (const geometry of kind.geometries.values()) {
                    geometry.dispose();
                }
            }
            roads.group.clear();
        }
        // A sidecar still in flight must not bind to a released tile.
        meshes.roads = 'none';
    }

    /**
     * A parent drawn under its dissolving leaves shows no roads. The leaves
     * draw their own, opaque - only their land dithers - so the parent's
     * were a second copy, draped on its coarser land and so floating metres
     * off the leaves' (graded) surface. Still attached, ready for when the
     * parent is the draw again.
     */
    setUnder(meshes: TileMeshes, under: boolean): void {
        const roads = meshes.roads;
        if (roads !== undefined && roads !== 'pending' && roads !== 'none') {
            roads.group.visible = !under;
        }
    }

    /** Triangles the roads of a drawn tile add, for the frame's count. */
    trianglesOf(meshes: TileMeshes, atFullDetail = false): number {
        const roads = meshes.roads;
        if (roads === undefined || roads === 'pending' || roads === 'none'
            || (!atFullDetail && !roads.group.visible)) {
            return 0;
        }
        let n = 0;
        for (const mesh of [roads.major, roads.minor, roads.rail, roads.railDetail, roads.railTop]) {
            // At full detail for the budget, and by the roads setting rather
            // than by what is visible: a far level makes a tile lighter, and
            // the track passes are shown and hidden per pass (the target MFD
            // shows them all), and neither may move the cut. A budget read
            // between an MFD pass and the main view's swung by the track
            // triangles every fourth frame, and folded tiles in and out.
            const shown = atFullDetail ? mesh !== undefined && this.modeShows(roads, mesh) : mesh?.visible;
            if (mesh && shown) {
                const full = atFullDetail ? roads.lod?.kinds.find(k => k.mesh === mesh)?.levels.get(0) : undefined;
                n += (full?.length ?? mesh.geometry.getIndex()?.count ?? 0) / 3;
            }
        }
        return n;
    }

    /** Whether the roads setting draws this mesh at all, whatever the pass hides. */
    private modeShows(roads: RoadMeshes, mesh: THREE.Mesh): boolean {
        if (this.mode === RoadsMode.OFF) {
            return false;
        }
        return mesh !== roads.minor || this.mode === RoadsMode.ALL;
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

/**
 * The terrain scene entity.
 *
 * Owns the stores, the streamer, the quadtree and the height field, and is the
 * only thing `Game` talks to.
 *
 * One thing to know about how this is driven: `SceneLayers.Terrain` appears in
 * six different render-layer definitions, and the renderer builds render lists
 * once per layer. So `render3D` runs several times per frame, with *different
 * cameras* — the target MFD pass among them. The old entity did all its
 * LOD work in `render3D` unguarded, which corrupted the frame-time EMA, the
 * detail scale and the quadtree traversal every single frame. Here LOD runs
 * only for the camera nominated by `setLodCamera`; every other pass just
 * attaches the group that pass already produced.
 */

import * as THREE from 'three';
import { PaletteCategory } from '../config/palettes/palette';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../scene/materials/materials';
import { Entity, ENTITY_TAGS } from '../scene/entity';
import { Scene, SceneLayers } from '../scene/scene';
import { Palette } from '../config/palettes/palette';
import { CanvasPainter } from '../render/screen/canvasPainter';
import { updateUniforms } from '../scene/utils';
import { attachToRenderList } from '../render/renderList';
import { sphereInFrustum } from './culling';
import { DemTile, decodePdm } from './demTile';
import {
    EnuBasis, WGS84_A, ecefToEnu, enuFrameRotation, geodeticToEcef, makeEnuBasis,
    northFromSceneZ,
} from './geodesy';
import { AirfieldsFile, EMPTY_AIRFIELDS, loadAirfields } from './airfields';
import { FlattenPad, padFromRecord, padReachM } from './flattenPad';
import { HeightField, HeightTier } from './heightField';
import {
    MESH_CACHE_BYTES, PREFETCH_LOOKAHEAD_S, PREFETCH_MIN_DISTANCE_M, RECONCILE_INTERVAL_MS,
    TERRAIN_DETAIL_DISTANCE_DEFAULT_M, TERRAIN_TRIANGLE_BUDGET, adjustDetailScale,
} from './lod';
import {
    TerrainManifest, baseUrlOf, heightIndexUrl, heightTileUrl, meshIndexUrl, meshTileUrl,
} from './manifest';
import { OceanPatch, buildOceanPatch, disposeOceanPatch } from './oceanPatch';
import { PtmTile, decodePtm } from './ptm';
import { QuadNode, Quadtree } from './quadtree';
import { TileIndex } from './tileIndex';
import { TileMeshes, buildSmoothLandGeometryFromFaceted, buildTileMeshes, disposeTileMeshes, tileOriginWorld } from './tileMesh';
import { TileStore } from './tileStore';
import { TileStreamer, TileWant, predictViewTarget } from './tileStreamer';
import { TileHeightIndex } from './tileHeightIndex';
import { TileKey, approxTileEdgeMetres, tileAtLonLat, tileKeyString } from './tiling';
import { enuToGeodeticApprox } from './geodesy';
import {
    CLASS_TO_TONE, LAND_TONE_BASE, LAND_TONE_COUNT, TONE_COUNT, TerrainTone,
} from './tones';
import { TERRAIN_COLOUR_MODE_INDEX, TerrainColours, TerrainShading } from '../state/gameDefs';
import { TerrainColourSetting, TerrainDetailSetting, TerrainShadingSetting } from '../config/configService';
import { publishTerrainStats, trackTerrainMaterial } from './debug';

const TONE_CATEGORIES: Record<number, PaletteCategory> = {
    [TerrainTone.Water]: PaletteCategory.TERRAIN_WATER,
    [TerrainTone.ShallowWater]: PaletteCategory.TERRAIN_SHALLOW_WATER,
    [TerrainTone.Sand]: PaletteCategory.TERRAIN_SAND,
    [TerrainTone.Grass]: PaletteCategory.TERRAIN_GRASS,
    [TerrainTone.Bare]: PaletteCategory.TERRAIN_BARE,
    [TerrainTone.Forest]: PaletteCategory.TERRAIN_FOREST,
    [TerrainTone.Scrub]: PaletteCategory.TERRAIN_SCRUB,
    [TerrainTone.Crop]: PaletteCategory.TERRAIN_CROP,
    [TerrainTone.Urban]: PaletteCategory.TERRAIN_URBAN,
    [TerrainTone.Snow]: PaletteCategory.TERRAIN_SNOW,
    [TerrainTone.Wetland]: PaletteCategory.TERRAIN_WETLAND,
};

/**
 * HYBRID mode banding: how many shade steps the imagery's luminance is cut
 * into, and how far the outermost step moves the palette tone.
 *
 * Five steps at +-35% is where it stopped reading as noise and started reading
 * as terrain: fewer and a hillside is one flat slab, more and neighbouring
 * facets stop sharing a step, which is the thing that makes it look painted
 * rather than photographed.
 */
const HYBRID_SHADE_STEPS = 5;
const HYBRID_SHADE_RANGE = 0.35;

/** Used when the pyramid predates the bake measuring its own luminance. */
const HYBRID_SHADE_FALLBACK = { mid: 0.5, spread: 0.2 };

/**
 * How far from the play origin a flatten pad is still worth carrying.
 *
 * An area spans at most three degrees, so everything that can matter is well
 * inside this; anything past it belongs to another area and is being kept out
 * of a per-frame loop, not out of the world.
 */
const PAD_RELEVANCE_M = 400_000;

export interface TerrainEntityOptions {
    manifest: TerrainManifest;
    manifestUrl: string;
    materials: SceneMaterialManager;
    /** Override the ENU origin; defaults to the manifest's. */
    enuOrigin?: { lat: number; lon: number; height?: number };
    maxZoom?: number;
    /** Live terrain colour mode. Omit and the entity stays on its default. */
    terrainColour?: TerrainColourSetting;
    /** Live faceted/smooth land shading. Omit and the entity stays FACETED. */
    terrainShading?: TerrainShadingSetting;
    terrainDetail?: TerrainDetailSetting;
}

export interface TerrainStats {
    drawn: number;
    triangles: number;
    detailScale: number;
    frameEmaMs: number;
    heightTier: HeightTier;
    queued: number;
    inflight: number;
    cacheBytes: number;
    bytesInFlight: number;
    aborted: number;
    failed: number;
    uploadMs: number;
    pendingUploads: number;
    /** TERRAIN_TRIANGLE_BUDGET cut this frame's draw list short (see syncGroup). */
    triangleBudgetHit: boolean;
}

export class TerrainEntity implements Entity {
    readonly tags = [ENTITY_TAGS.GROUND];
    enabled = true;

    readonly basis: EnuBasis;
    /** Bake frame -> drawing frame, for the baked tile offsets. */
    private readonly frameFix: THREE.Quaternion;
    readonly heights: HeightField;

    private readonly manifest: TerrainManifest;
    private readonly group = new THREE.Group();
    private readonly materials: THREE.Material[] = [];
    private readonly meshStore: TileStore<PtmTile>;
    private readonly heightStore: TileStore<DemTile>;
    private readonly streamer: TileStreamer<PtmTile, TileMeshes>;
    private readonly quadtree: Quadtree;
    private readonly oceans = new Map<string, OceanPatch>();
    private readonly pinned = new Set<string>();
    private readonly earthCenter: THREE.Vector3;
    private readonly landMaterial: THREE.ShaderMaterial;
    /**
     * Watercourse strokes. Its own material because its own vertex program
     * widens the centreline, and because it is the one part of a tile drawn
     * over the surface rather than as part of it.
     */
    private readonly riverMaterial: THREE.ShaderMaterial;
    private readonly outlineMaterial: THREE.ShaderMaterial;

    /**
     * Switch colour model. One uniform: every mode reads the same baked bytes,
     * so nothing re-streams, re-uploads or re-meshes.
     */
    setTerrainColour(mode: TerrainColours): void {
        this.landMaterial.uniforms.uTerrainMode.value = TERRAIN_COLOUR_MODE_INDEX[mode];
    }

    /** Which of a resident tile's two land geometries new uploads start on. */
    private landShading: TerrainShading = TerrainShading.FACETED;

    /**
     * Switch between flat per-facet colour and smooth (Gouraud) shading.
     *
     * A tile upload only builds the SMOOTH geometry when SMOOTH is already
     * the active setting (see buildTileMeshes) — the weld-and-average pass is
     * too expensive to pay on every streamed tile regardless of which mode is
     * showing. So switching here also builds it lazily, once, for whatever is
     * resident right now and still missing it; the geometry is then cached on
     * the tile's meshes like any other, and later switches are a pure
     * `land.geometry` swap with no rebuild.
     */
    setTerrainShading(mode: TerrainShading): void {
        this.landShading = mode;
        for (const meshes of this.streamer.values()) {
            if (mode === TerrainShading.SMOOTH && !meshes.landGeometrySmooth && meshes.landGeometryFaceted) {
                meshes.landGeometrySmooth = buildSmoothLandGeometryFromFaceted(meshes.landGeometryFaceted);
            }
            const geometry = mode === TerrainShading.SMOOTH
                ? meshes.landGeometrySmooth ?? meshes.landGeometryFaceted
                : meshes.landGeometryFaceted;
            if (meshes.land && geometry) {
                meshes.land.geometry = geometry;
            }
        }
    }

    private meshIndex: TileIndex | undefined;
    private heightIndex: TileIndex | undefined;
    private lodCamera: THREE.Camera | undefined;
    private lastReconcile = 0;
    private lastFrame = 0;
    private frameEmaMs = 16;
    private detailScale = 1;
    /**
     * How far out full detail is kept, from the *Terrain detail distance*
     * setting. Read on every reconcile rather than cached into the quadtree, so
     * moving the slider takes effect on the next pass with nothing to rebuild.
     */
    private detailDistanceM = TERRAIN_DETAIL_DISTANCE_DEFAULT_M;
    private drawList: QuadNode[] = [];
    private drawnTriangles = 0;
    /** Set for a frame where TERRAIN_TRIANGLE_BUDGET cut the draw list short. */
    private triangleBudgetHit = false;
    /**
     * Plan-view triangle indices for the drawn tiles something has asked the
     * surface height of. Built on demand and dropped as soon as the tile stops
     * being drawn, so in practice this holds the one or two tiles under the
     * aircraft. See {@link drawnHeightAtWorld}.
     */
    private readonly drawnHeightIndices = new Map<string, TileHeightIndex>();
    /** Draw list by key, rebuilt with the draw list rather than per query. */
    private drawnByKey = new Map<string, QuadNode>();
    private readonly prevCameraPos = new THREE.Vector3();
    private prevCameraTime = 0;
    private readonly cameraVel = new THREE.Vector3();
    private readonly cameraForward = new THREE.Vector3();

    constructor(opts: TerrainEntityOptions) {
        this.manifest = opts.manifest;
        const origin = opts.enuOrigin ?? opts.manifest.enuOrigin;
        this.basis = makeEnuBasis(origin.lat, origin.lon, origin.height ?? 0);
        // Tiles are baked as offsets from their centre in the *bake's* ENU
        // axes. Drawing them from a different origin means turning those
        // offsets into the drawing frame's axes; identity when the two agree.
        const baked = opts.manifest.enuOrigin;
        this.frameFix = enuFrameRotation(
            makeEnuBasis(baked.lat, baked.lon, baked.height ?? 0), this.basis,
        );
        this.group.name = 'Terrain';
        // Dev aid, alongside globalThis.__terrainStats.
        (globalThis as Record<string, unknown>).__terrain = this;

        const base = baseUrlOf(opts.manifestUrl);

        // Land is a single material now: colour is a per-facet decision inside
        // the shader, so the three tone materials it used to need have become
        // one uniform. The array is still indexed by tone, because water's two
        // groups are draw-group indices into it and the ocean patch reaches in
        // by TerrainTone.Water.
        this.landMaterial = opts.materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.TERRAIN_GRASS,
            depthWrite: true,
            shaded: true as const,
            terrain: {
                toneCategories: Array.from(
                    { length: LAND_TONE_COUNT },
                    (_, i) => TONE_CATEGORIES[LAND_TONE_BASE + i],
                ),
                classTones: CLASS_TO_TONE.map(tone => tone - LAND_TONE_BASE),
                swatches: opts.manifest.mesh.swatches ?? [],
                shadeSteps: HYBRID_SHADE_STEPS,
                shadeRange: HYBRID_SHADE_RANGE,
                shadeMid: (opts.manifest.mesh.luminance ?? HYBRID_SHADE_FALLBACK).mid,
                shadeSpread: (opts.manifest.mesh.luminance ?? HYBRID_SHADE_FALLBACK).spread,
            },
        }) as THREE.ShaderMaterial;
        this.landMaterial.side = THREE.DoubleSide;
        this.landMaterial.polygonOffset = true;
        this.landMaterial.polygonOffsetFactor = 1;
        this.landMaterial.polygonOffsetUnits = 1;
        trackTerrainMaterial(this.landMaterial);

        // Rivers take the deep-water colour: a canal is water, and reading as
        // a different blue from the lake it runs into would be worse than any
        // width error. Flat, unshaded, and never depth-written — it is a
        // stroke lying over the terrain, and writing depth would let it
        // occlude the aircraft's own shadow on the bank beside it.
        this.riverMaterial = opts.materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: TONE_CATEGORIES[TerrainTone.Water],
            depthWrite: false,
            shaded: false as const,
            river: true,
        }) as THREE.ShaderMaterial;
        trackTerrainMaterial(this.riverMaterial);

        // OSM landuse region edges, stroked like the rivers so a mapped field
        // or wood reads as a shape even where the facet colour either side of
        // it matches. Road grey rather than any land tone: it has to show
        // against every class it can border.
        this.outlineMaterial = opts.materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.SCENERY_ROAD_SECONDARY,
            depthWrite: false,
            shaded: false as const,
            river: true,
        }) as THREE.ShaderMaterial;
        trackTerrainMaterial(this.outlineMaterial);

        for (let tone = 0; tone < TONE_COUNT; tone++) {
            // Water is a flat palette fill: no sun shade, no normal smoothing.
            const water = tone === TerrainTone.Water || tone === TerrainTone.ShallowWater;
            if (!water) {
                this.materials.push(this.landMaterial);
                continue;
            }
            const mat = opts.materials.build({
                type: SceneMaterialPrimitiveType.MESH,
                category: TONE_CATEGORIES[tone],
                depthWrite: true,
                shaded: false as const,
                highp: true,
            }) as THREE.ShaderMaterial;
            mat.side = THREE.DoubleSide;
            mat.polygonOffset = true;
            // Water sits farther back than land so a coplanar beach edge
            // resolves to land rather than sky-coloured sparkles.
            mat.polygonOffsetFactor = 2;
            mat.polygonOffsetUnits = 2;
            trackTerrainMaterial(mat);
            this.materials.push(mat);
        }

        if (opts.terrainColour) {
            this.setTerrainColour(opts.terrainColour.getActive());
            opts.terrainColour.addChangeListener(mode => this.setTerrainColour(mode));
        }

        if (opts.terrainShading) {
            this.landShading = opts.terrainShading.getActive();
            opts.terrainShading.addChangeListener(mode => this.setTerrainShading(mode));
        }

        if (opts.terrainDetail) {
            this.detailDistanceM = opts.terrainDetail.getActive();
            opts.terrainDetail.addChangeListener(m => { this.detailDistanceM = m; });
        }

        this.meshStore = new TileStore<PtmTile>({
            baseUrl: base,
            url: (id) => meshTileUrl(this.manifest, id.z, id.x, id.y, base),
            decode: (buf) => decodePtm(buf),
            sizeOf: (t) => t.landPositions.byteLength + t.waterPositions.byteLength
                + t.landNormals.byteLength + t.landAttrs.byteLength
                + t.waterIndices.byteLength,
            maxBytes: MESH_CACHE_BYTES,
            exists: (id) => (this.meshIndex ? this.meshIndex.has(id) : true),
        });

        this.heightStore = new TileStore<DemTile>({
            baseUrl: base,
            url: (id) => heightTileUrl(this.manifest, id.z, id.x, id.y, base),
            decode: (buf) => decodePdm(buf),
            sizeOf: (t) => t.heights.byteLength,
            maxBytes: 64 * 1024 * 1024,
            // Same gate the mesh store has. Without it every height tile the
            // coverage box implies but the bake never wrote costs a request, a
            // 404 and a retry — which with two areas baked far apart is most
            // of the box. The zoom clause is because the index describes the
            // .pdm pyramid, which runs deeper than the height tiles copied
            // alongside the meshes.
            exists: (id) => id.z <= this.manifest.height.maxZoom
                && (this.heightIndex ? this.heightIndex.has(id) : true),
        });

        // The bake records each pad geodetically. It used to be enough to
        // assume the play origin *was* the pad centre, because there was one
        // origin and it was the airbase. Now that the origin follows the
        // selected area, a pad has to be placed where it actually is: put it
        // at the origin regardless and an imported area gets a patch of itself
        // flattened to the airbase's altitude, half a world away.
        //
        // Positioned properly, a pad belonging to another area simply lands
        // hundreds of kilometres off and never touches anything.
        const toEnu = (lat: number, lon: number) => {
            const enu = ecefToEnu(this.basis, geodeticToEcef(lat, lon, 0));
            return { e: enu.e, n: enu.n };
        };
        // Dropped here rather than carried and rejected per query. The sampler
        // walks this list on every height read — which is once per contact test
        // per frame — and the manifest now lists every pad of every airfield in
        // the pyramid, a hundred or so. A pad in another area is a thousand
        // kilometres off and can never touch anything here.
        const pads: FlattenPad[] = (opts.manifest.flattenPads ?? [])
            .map(p => padFromRecord(p, toEnu))
            .filter(p => Math.hypot(p.centerX, p.centerZ) - padReachM(p) <= PAD_RELEVANCE_M);

        this.heights = new HeightField({
            manifest: opts.manifest,
            store: this.heightStore,
            basis: this.basis,
            pads,
        });

        this.streamer = new TileStreamer<PtmTile, TileMeshes>({
            store: this.meshStore,
            upload: (id, tile) => buildTileMeshes(
                tile, this.basis, this.materials, this.riverMaterial,
                updateUniforms, this.frameFix, this.landShading, this.outlineMaterial,
            ),
            release: (_id, m) => disposeTileMeshes(m),
        });

        // The ellipsoid centre in scene space. The ENU origin sits on the
        // surface with +Y up, so the centre is one Earth radius straight down.
        this.earthCenter = new THREE.Vector3(0, -WGS84_A, 0);

        this.quadtree = new Quadtree({
            manifest: opts.manifest,
            tilePosition: (id) => tileOriginWorld(id, 0, this.basis),
            tileRadius: (id) => approxTileEdgeMetres(id) * 0.75,
            // Uploaded geometry only. A sea patch must never count here: one is
            // also built as a stand-in for a land tile that has not arrived
            // yet, and calling that resident tells the quadtree the tile is
            // done -- it stops wanting it, the streamer cancels the fetch, and
            // the island stays flat water for the rest of the session. Nodes
            // the index says are ocean are covered by isOcean everywhere
            // readiness is tested, so nothing needs this clause.
            isResident: (id) => this.streamer.has(id),
            isOcean: (id) => this.meshStore.isAbsent(id),
            earthCenter: this.earthCenter,
            maxZoom: opts.maxZoom ?? opts.manifest.mesh.maxZoom,
        });
    }

    init(_scene: Scene): void {
        // Index and coarse-tier loading is awaited by load(), which Game calls
        // before adding the entity, so there is nothing to do here.
    }

    private manifestUrl = '';

    /** Load the tile indices and the always-resident coarse height tier. */
    async load(manifestUrl: string): Promise<void> {
        this.manifestUrl = manifestUrl;
        const base = baseUrlOf(manifestUrl);
        const [meshIdx, heightIdx] = await Promise.all([
            fetchIndex(meshIndexUrl(this.manifest, base)),
            fetchIndex(heightIndexUrl(this.manifest, base)),
        ]);
        this.meshIndex = meshIdx;
        this.heightIndex = heightIdx;
        await this.heights.loadCoarse(heightIdx);
    }

    /**
     * The airfields baked beside this pyramid, or none.
     *
     * Fetched on demand rather than with the manifest: the descriptions run to
     * hundreds of kilobytes against a manifest of tens, and nothing needs them
     * until something is about to draw an airfield. The URL is resolved here
     * because this is where the manifest and the base it came from both live.
     */
    async loadAirfields(): Promise<AirfieldsFile> {
        const pointer = this.manifest.airfields;
        if (pointer === undefined || this.manifestUrl === '') {
            return EMPTY_AIRFIELDS;
        }
        return loadAirfields(`${baseUrlOf(this.manifestUrl)}/${pointer.path}`);
    }

    /** Deepest zoom the baked pyramid provides. */
    get maxZoom(): number {
        return this.manifest.mesh.maxZoom;
    }

    get coverage(): { west: number; south: number; east: number; north: number } {
        return this.manifest.coverage;
    }

    /** Nominate the camera LOD follows. Every other render pass is passive. */
    setLodCamera(camera: THREE.Camera): void {
        this.lodCamera = camera;
    }

    /** Pin tiles around a scene point so boot and spawn areas cannot be evicted. */
    async pinArea(x: number, z: number, radiusM: number, zoom: number): Promise<void> {
        const span = 180 / (1 << zoom);
        const ids = tilesAround(this.basis, x, z, radiusM, zoom, span);
        for (const id of ids) {
            this.pinned.add(tileKeyString(id));
        }
        this.streamer.setPinnedKeys(this.pinned);
        await this.streamer.ensure(ids, Number.MAX_SAFE_INTEGER);
        for (const id of ids) {
            this.meshStore.setPinned(id, true);
        }
        await this.heights.ensureLoadedAroundWorld(x, z, radiusM);
    }

    /** Keys of pinned tiles that are still neither uploaded nor known absent. */
    outstandingPinned(): string[] {
        const out: string[] = [];
        for (const key of this.pinned) {
            const [z, x, y] = key.split('/').map(Number);
            const id = { z, x, y };
            if (!this.streamer.has(id) && !this.meshStore.isAbsent(id)) {
                out.push(key);
            }
        }
        return out;
    }

    /** Resolve once every pinned tile is uploaded, reporting progress. */
    async waitForPinned(onProgress?: (done: number, total: number) => void): Promise<void> {
        const total = this.pinned.size;
        if (total === 0) {
            return;
        }
        for (let guard = 0; guard < 2000; guard++) {
            const outstanding = this.outstandingPinned();
            const done = total - outstanding.length;
            onProgress?.(done, total);
            if (outstanding.length === 0) {
                return;
            }
            this.streamer.pumpUploads();
            await new Promise(r => setTimeout(r, 16));
        }
        console.warn(
            `[terrain] gave up waiting on ${this.outstandingPinned().length} pinned tiles`,
            this.outstandingPinned().slice(0, 20),
        );
    }

    update(_delta: number): void {
        // LOD is camera-driven, so it belongs in render3D where the camera is
        // known. Nothing to do per simulation tick.
    }

    heightAtWorld(x: number, z: number): number {
        return this.heights.heightAtWorld(x, z);
    }

    /** Height above the ellipsoid of a scene point — what the altimeter reads. */
    geodeticAltitudeAtWorld(x: number, y: number, z: number): number {
        return this.heights.geodeticAltitudeAtWorld(x, y, z);
    }

    /**
     * Ground height read off the geometry actually on screen, or undefined
     * where no drawn land tile covers the point — open sea, a water cut, or
     * terrain that has not streamed in yet.
     *
     * Anything that wants one stable LOD-independent surface — physics,
     * spawns, the AI — must keep using {@link heightAtWorld}. This is for
     * things that have to survive a depth test against the drawn mesh, which
     * the DEM does not agree with; see {@link TileHeightIndex}.
     */
    drawnHeightAtWorld(x: number, z: number): number | undefined {
        // Indices are pruned to the draw list, so at most one of them can hold
        // the point and checking the cache first makes the common case — an
        // aircraft sitting over the same tile for hundreds of frames — a
        // couple of triangle tests with no lookup at all.
        for (const index of this.drawnHeightIndices.values()) {
            const y = index.heightAtWorld(x, z);
            if (y !== undefined) {
                return y;
            }
        }
        const node = this.drawnNodeAt(x, z);
        if (node === undefined || this.drawnHeightIndices.has(node.key)) {
            return undefined;
        }
        const meshes = this.streamer.get(node.id);
        if (meshes?.land === undefined) {
            return undefined;   // ocean stand-in, or water-only tile
        }
        const index = new TileHeightIndex(meshes.land, meshes.group);
        this.drawnHeightIndices.set(node.key, index);
        return index.heightAtWorld(x, z);
    }

    /** The drawn quadtree node covering a scene point, deepest level first. */
    private drawnNodeAt(x: number, z: number): QuadNode | undefined {
        if (this.drawList.length === 0) {
            return undefined;
        }
        const c = enuToGeodeticApprox(this.basis, x, northFromSceneZ(z), 0);
        // The draw list is a quadtree cut, so exactly one level holds the
        // point. Walking down from the deepest costs a handful of lookups and
        // avoids a scan of a draw list that runs to hundreds of nodes.
        for (let z0 = this.manifest.mesh.maxZoom; z0 >= 0; z0--) {
            const node = this.drawnByKey.get(tileKeyString(tileAtLonLat(z0, c.lon, c.lat)));
            if (node !== undefined) {
                return node;
            }
        }
        return undefined;
    }

    isLandAtWorld(x: number, z: number): boolean {
        return this.heights.isLandAtWorld(x, z);
    }

    render3D(
        _targetWidth: number,
        targetHeight: number,
        camera: THREE.Camera,
        lists: Map<string, THREE.Scene>,
        _palette: Palette,
    ): void {
        // Only the nominated camera drives LOD. Without this gate the target
        // MFD pass corrupts the governor and the traversal every frame.
        const isLodPass = (this.lodCamera === undefined || camera === this.lodCamera)
            && camera instanceof THREE.PerspectiveCamera;
        if (isLodPass) {
            this.viewportHeightPx = targetHeight;
            this.reconcile(camera);
        }
        this.cullSharedGroupFor(camera, isLodPass);
        const list = lists.get(SceneLayers.Terrain);
        if (list) {
            // Must go through attachToRenderList, not list.add: the renderer
            // stamps a generation on each build pass and pruneRenderList drops
            // every child that is not stamped for the current one. A plain add
            // is silently pruned again before anything is drawn.
            attachToRenderList(list, this.group);
        }
    }

    private readonly cullFrustum = new THREE.Frustum();
    private readonly cullProjScreenMatrix = new THREE.Matrix4();

    /**
     * `this.group` holds the one shared draw list the LOD-nominated camera
     * computed (see setLodCamera) — a second camera, like the weapons-target
     * MFD, is passive and gets no LOD/culling pass of its own, so it was
     * submitting and drawing every tile the main view sees regardless of
     * whether that tile is even inside its own (usually much narrower)
     * frustum. Land meshes set `frustumCulled = false` deliberately (the
     * quadtree already culled them, for the *main* camera), so THREE's own
     * per-object culling never catches this on a second camera either.
     *
     * Hiding here instead of filtering what gets attached to the render list:
     * `this.group`'s children cannot be reparented per pass without breaking
     * whichever pass runs next in the same frame (an Object3D has one
     * parent), but `visible` is a per-pass decision the renderer only reads
     * at submit time, and gets reset here every pass regardless of order.
     */
    private cullSharedGroupFor(camera: THREE.Camera, isLodPass: boolean): void {
        if (isLodPass || !(camera instanceof THREE.PerspectiveCamera)) {
            for (const child of this.group.children) {
                child.visible = true;
            }
            return;
        }
        camera.updateMatrixWorld();
        this.cullProjScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this.cullFrustum.setFromProjectionMatrix(this.cullProjScreenMatrix);
        for (const node of this.drawList) {
            const group = this.streamer.get(node.id)?.group ?? this.oceans.get(node.key)?.group;
            if (group) {
                group.visible = sphereInFrustum(node.center, node.radius, this.cullFrustum);
            }
        }
    }

    render2D(
        _targetWidth: number,
        _targetHeight: number,
        _camera: THREE.Camera,
        _lists: Set<string>,
        _painter: CanvasPainter,
        _palette: Palette,
    ): void {
        // Terrain is 3D only.
    }

    private reconcile(camera: THREE.PerspectiveCamera): void {
        // Everything below reads the camera's orientation out of its world
        // matrix -- the culling frustum here, and the prefetch direction via
        // getWorldDirection in speculativeWants. But that matrix is only
        // recomputed when the renderer submits, which happens *after* the
        // render lists are built, so without this we cull against the previous
        // pose. In a view whose orientation is set after the camera updater
        // runs -- an orbited exterior view, or looking around the cockpit --
        // it never catches up at all: measured, the frustum sat a steady 105
        // degrees away from the view direction and stayed there, pinning
        // terrain to a cone around the aircraft axis while the player looked
        // somewhere else entirely.
        camera.updateMatrixWorld();

        const now = performance.now();
        if (this.lastFrame > 0) {
            const dt = now - this.lastFrame;
            this.frameEmaMs = this.frameEmaMs * 0.9 + dt * 0.1;
        }
        this.lastFrame = now;

        this.streamer.pumpUploads();

        if (now - this.lastReconcile < RECONCILE_INTERVAL_MS) {
            return;
        }
        this.lastReconcile = now;
        this.detailScale = adjustDetailScale(this.detailScale, this.frameEmaMs);
        this.meshStore.nextGeneration();

        const r = this.quadtree.update(
            camera,
            this.viewportHeightPx,
            camera.fov,
            this.detailScale,
            this.detailDistanceM,
            (id) => this.pinned.has(tileKeyString(id)),
        );

        this.streamer.setWants(r.wants, this.speculativeWants(camera, r.wants));
        this.drawList = r.draw;
        this.syncGroup(camera.position);
        publishTerrainStats({ ...this.stats, altitudeM: camera.position.y });
    }

    /**
     * Tiles the camera is about to need, at reduced priority.
     *
     * Aimed along the direction the camera is *looking*, not the direction it
     * is travelling. In an exterior view the camera orbits the aircraft, so its
     * velocity is the aircraft's: extrapolating along it prefetched terrain
     * ahead of the aircraft while the view pointed elsewhere, and whatever the
     * player was actually looking at had to wait for the frustum pass. Speed
     * still sets how far ahead to reach, with a floor so a camera that is only
     * turning still pulls in what it is about to face.
     */
    private speculativeWants(
        camera: THREE.PerspectiveCamera, current: TileWant[],
    ): TileWant[] {
        const now = performance.now();
        if (this.prevCameraTime > 0) {
            const dt = Math.max(1e-3, (now - this.prevCameraTime) / 1000);
            this.cameraVel.subVectors(camera.position, this.prevCameraPos).divideScalar(dt);
        }
        this.prevCameraPos.copy(camera.position);
        this.prevCameraTime = now;

        camera.getWorldDirection(this.cameraForward);
        const ahead = predictViewTarget(
            camera.position.x, camera.position.y, camera.position.z,
            this.cameraForward.x, this.cameraForward.y, this.cameraForward.z,
            this.cameraVel.length(),
            PREFETCH_LOOKAHEAD_S,
            PREFETCH_MIN_DISTANCE_M,
        );
        const have = new Set(current.map(w => tileKeyString(w.id)));
        const zoom = Math.min(this.manifest.mesh.maxZoom, this.deepestDrawnZoom());
        const span = 180 / (1 << zoom);
        const ids = tilesAround(this.basis, ahead.x, ahead.z, 4000, zoom, span);
        const out: TileWant[] = [];
        for (const id of ids) {
            const key = tileKeyString(id);
            if (have.has(key) || this.streamer.has(id) || this.meshStore.isAbsent(id)) {
                continue;
            }
            out.push({
                id,
                ssePx: 1,
                distanceM: 1e6,      // never outranks something visible
                inFrustum: false,
                pinned: false,
            });
        }
        return out;
    }

    private deepestDrawnZoom(): number {
        let z = 0;
        for (const node of this.drawList) {
            if (node.id.z > z) {
                z = node.id.z;
            }
        }
        return z;
    }

    /** Viewport height in px, taken from the render target each pass. */
    private viewportHeightPx = 200;

    private syncGroup(camPos: THREE.Vector3): void {
        this.group.clear();
        this.drawnTriangles = 0;
        this.triangleBudgetHit = false;
        this.pruneDrawnHeightIndices();
        // Nearest first: when the triangle budget below has to cut the list
        // short, it is always the farthest (already coarsest, least missed)
        // tiles that go missing, never ones near the camera.
        const ordered = this.drawList.length > 1
            ? [...this.drawList].sort((a, b) =>
                a.center.distanceToSquared(camPos) - b.center.distanceToSquared(camPos))
            : this.drawList;
        for (const node of ordered) {
            const meshes = this.streamer.get(node.id);
            if (meshes) {
                if (this.drawnTriangles >= TERRAIN_TRIANGLE_BUDGET) {
                    // See TERRAIN_TRIANGLE_BUDGET: the SSE governor bounds
                    // error, not triangle count, and can still leave a
                    // pathologically large draw list over complex terrain.
                    // Everything from here on is farther than everything
                    // already added, so stopping rather than skipping keeps
                    // the gap this creates confined to the view's far edge.
                    this.triangleBudgetHit = true;
                    break;
                }
                // A sea patch built while this tile was still in flight has
                // done its job; drop it rather than hold its buffers for a
                // node that now has real geometry.
                const standIn = this.oceans.get(node.key);
                if (standIn) {
                    disposeOceanPatch(standIn);
                    this.oceans.delete(node.key);
                }
                this.group.add(meshes.group);
                this.drawnTriangles += countTriangles(meshes);
                continue;
            }
            const key = node.key;
            let patch = this.oceans.get(key);
            if (!patch) {
                patch = buildOceanPatch(
                    node.id, this.basis, this.manifest.seaLevel,
                    this.manifest.mesh.levelSkirtDepthM[node.id.z] ?? 0,
                    this.materials, updateUniforms,
                );
                this.oceans.set(key, patch);
            }
            this.group.add(patch.group);
        }
        this.pruneOceans();
    }

    /**
     * Drop height indices for tiles no longer drawn. An index that outlived
     * its tile would keep answering for a point the deeper tile now owns, and
     * hold its buffers besides.
     */
    private pruneDrawnHeightIndices(): void {
        this.drawnByKey = new Map(this.drawList.map(n => [n.key, n]));
        for (const key of this.drawnHeightIndices.keys()) {
            if (!this.drawnByKey.has(key)) {
                this.drawnHeightIndices.delete(key);
            }
        }
    }

    private pruneOceans(): void {
        if (this.oceans.size < 512) {
            return;
        }
        const live = new Set(this.drawList.map(n => n.key));
        for (const [key, patch] of this.oceans) {
            if (!live.has(key)) {
                disposeOceanPatch(patch);
                this.oceans.delete(key);
            }
        }
    }

    get stats(): TerrainStats {
        const s = this.meshStore.stats;
        return {
            drawn: this.drawList.length,
            triangles: this.drawnTriangles,
            detailScale: this.detailScale,
            frameEmaMs: this.frameEmaMs,
            heightTier: this.heights.heightResolutionAtWorld(0, 0),
            queued: s.queued,
            inflight: s.inflight,
            cacheBytes: s.cacheBytes,
            bytesInFlight: s.bytesInFlight,
            aborted: s.aborted,
            failed: s.failed,
            uploadMs: this.streamer.stats.uploadMs,
            pendingUploads: this.streamer.pendingUploads,
            triangleBudgetHit: this.triangleBudgetHit,
        };
    }
}

function countTriangles(m: TileMeshes): number {
    let n = 0;
    if (m.land) {
        n += (m.land.geometry.getAttribute('position')?.count ?? 0) / 3;
    }
    if (m.water) {
        n += (m.water.geometry.getIndex()?.count ?? 0) / 3;
    }
    return n;
}

async function fetchIndex(url: string): Promise<TileIndex | undefined> {
    try {
        const res = await fetch(url);
        if (!res.ok) {
            return undefined;
        }
        return TileIndex.decode(await res.arrayBuffer());
    } catch {
        return undefined;
    }
}

/** Tile ids covering a radius around a scene point at one zoom. */
function tilesAround(
    basis: EnuBasis, x: number, z: number, radiusM: number, zoom: number, span: number,
): TileKey[] {
    const c = enuToGeodeticApprox(basis, x, northFromSceneZ(z), 0);
    const dLat = radiusM / 110540;
    const dLon = radiusM / (111320 * Math.max(0.1, Math.cos(c.lat * Math.PI / 180)));
    const x0 = Math.floor((c.lon - dLon + 180) / span);
    const x1 = Math.floor((c.lon + dLon + 180) / span);
    const y0 = Math.floor((90 - (c.lat + dLat)) / span);
    const y1 = Math.floor((90 - (c.lat - dLat)) / span);
    const out: TileKey[] = [];
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            out.push({ z: zoom, x, y });
        }
    }
    return out;
}

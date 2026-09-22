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
import { getTreeAtlas } from '../scene/textures/treeAtlas';
import {
    TREE_DENSITY_MULTIPLIER_DEFAULT, buildTreeMesh, clampTreeDensityMultiplier, scatterTreeSpecies, treeDensityScaleForDistance,
} from './treeBillboards';
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
    LANDUSE_REVEAL_MIN_PX, LEAF_REFINE_DISTANCE_SCALE, LOD_DEPTH_PUSH_SCALE, LOD_FADE_MS,
    TERRAIN_DETAIL_DISTANCE_DEFAULT_M, TERRAIN_TRIANGLE_BUDGET,
    adjustDetailScale, landuseRevealScale,
} from './lod';
import {
    TerrainManifest, baseUrlOf, heightIndexUrl, heightTileUrl, meshIndexUrl, meshTileUrl,
    textureIndexUrl,
    bridgeIndexUrl,
    roadIndexUrl,
} from './manifest';
import { CoverBinding, CoverTextures } from './coverTextures';
import { BridgeMeshes } from './bridgeMeshes';
import { RoadStrokes } from './roadStrokes';
import { buildRoadExclusion } from './roadExclusion';
import { OceanPatch, buildOceanPatch, disposeOceanPatch } from './oceanPatch';
import { PtmTile, decodePtm } from './ptm';
import { QuadNode, Quadtree } from './quadtree';
import { TileIndex } from './tileIndex';
import { TileMeshes, buildSmoothLandGeometryFromFaceted, buildTileMeshes, disposeTileMeshes, tileOriginWorld } from './tileMesh';
import { TileStore } from './tileStore';
import { PRIORITY_IN_FRUSTUM, TileStreamer, TileWant, predictViewTarget } from './tileStreamer';
import { TileCover, TileHeightIndex } from './tileHeightIndex';
import { TileKey, approxTileEdgeMetres, parentOf, tileAtLonLat, tileKeyString } from './tiling';
import { enuToGeodeticApprox } from './geodesy';
import {
    CLASS_TO_TONE, LAND_TONE_BASE, LAND_TONE_COUNT, TONE_COUNT, TerrainTone,
} from './tones';
import { RoadsMode, TERRAIN_COLOUR_MODE_INDEX, TerrainColours, TerrainShading } from '../state/gameDefs';
import {
    FarTileTexturesSetting, LanduseBlendSetting, LanduseReachSetting, LanduseRevealSetting, RoadsSetting, TerrainColourSetting,
    TerrainDetailSetting, TerrainShadingSetting, TreeDensitySetting, TriangleBudgetSetting,
} from '../config/configService';
import { publishTerrainStats, trackTerrainMaterial } from './debug';

/**
 * The palette tone a landcover class is painted in.
 *
 * What the terrain shader does per facet in Landcover mode, for anything
 * built on the CPU that wants to match the ground it stands on.
 */
export function toneCategoryOfClass(cls: number): PaletteCategory {
    return TONE_CATEGORIES[CLASS_TO_TONE[cls] ?? TerrainTone.Grass]
        ?? PaletteCategory.TERRAIN_DEFAULT;
}

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

/** A tile's part in the leaf dissolve this pass; on its group's userData. */
interface TileLodState {
    /** Depth push (m) for a parent drawn under its children; 0 otherwise. */
    pushM: number;
    /** A dissolving leaf: the far end of its dissolve (m); 0 otherwise. */
    fadeM: number;
    /** A dissolving leaf: when its parent handed over, ms. */
    fadeFromMs: number;
}

/**
 * Per-draw uniform refresh for a tile's land mesh: the shared one, then the
 * tile's part in the leaf dissolve (see LOD_FADE_NEAR), which syncGroup
 * leaves on the tile group. The land material is one object for every tile,
 * so a per-tile value can only travel this way; updateUniforms already marks
 * shaded uniforms for upload on every draw, so this adds no upload of its own.
 * Water is unshaded and refreshed once per material per pass, so it takes no
 * part: the under-parent's water is drawn unpushed and the leaf's over it.
 */
const tileBeforeRender: THREE.Mesh['onBeforeRender'] = function (
    this: THREE.Mesh, renderer, scene, camera, geometry, material, group,
) {
    updateUniforms.call(this, renderer, scene, camera, geometry, material, group);
    const u = (material as THREE.ShaderMaterial).uniforms;
    if (!u || !u.uLodFadeM) {
        return;
    }
    const lod = this.parent?.userData.lod as TileLodState | undefined;
    u.uDepthPush.value = lod?.pushM ?? 0;
    u.uLodFadeM.value = lod?.fadeM ?? 0;
    u.uLodFadeCap.value = lod && lod.fadeM > 0
        ? Math.min(1, (performance.now() - lod.fadeFromMs) / LOD_FADE_MS)
        : 1;
    u.uLodFills.value = this.userData.landuseFills ? 1 : 0;
    // The far cover texture, where this tile has one; see CoverTextures.
    const cover = this.userData.cover as CoverBinding | undefined;
    if (cover) {
        u.uCoverTex.value = cover.texture;
        u.uHasCoverTex.value = 1;
        (u.uCoverEast.value as THREE.Vector3).copy(cover.east);
        (u.uCoverNorth.value as THREE.Vector3).copy(cover.north);
        u.uCoverK.value = cover.k;
    } else if (u.uHasCoverTex.value !== 0) {
        u.uHasCoverTex.value = 0;
        u.uCoverTex.value = noCoverTexture;
    }
};

/**
 * What uCoverTex is rebound to for a draw without a texture: the material's
 * own placeholder, read back off the first tile drawn without one. Binding
 * the previous tile's texture there instead would be harmless (the sampler
 * is not read) but keeps a released texture referenced by the material.
 */
let noCoverTexture: THREE.Texture | null = null;

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
    /** Live land-use tone/sampled colour blend. Omit and the shader default stays. */
    landuseBlend?: LanduseBlendSetting;
    /** Live leaf-refine reach. Omit and the LOD default stays. */
    landuseReach?: LanduseReachSetting;
    /** Live land-use region size threshold. Omit and LANDUSE_REVEAL_MIN_PX stays. */
    landuseReveal?: LanduseRevealSetting;
    /** Live per-frame triangle ceiling. Omit and TERRAIN_TRIANGLE_BUDGET stays. */
    triangleBudget?: TriangleBudgetSetting;
    /** Live far-tile texture switch. Omit and textures are drawn where the bake shipped them. */
    farTileTextures?: FarTileTexturesSetting;
    /** Live road switch. Omit and every road the bake shipped is drawn. */
    roads?: RoadsSetting;
    /**
     * Live overall tree density multiplier (0..20). A change re-scatters
     * every resident tile's trees (paced - see rebuildResidentTrees), not
     * just tiles streamed in afterward. Omit and TREE_DENSITY_MULTIPLIER_DEFAULT stays.
     */
    treeDensity?: TreeDensitySetting;
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
    /** Sibling groups folded into their parent to fit the triangle budget; see TerrainEntity.coarsenToBudget. */
    coarsenedTiles: number;
    /** Resident tiles drawing their far cover texture; see CoverTextures. */
    textured: number;
    texturesInflight: number;
    /** Resident tiles with road strokes bound, and the triangles they hold. */
    roadTiles: number;
    roadTriangles: number;
    /** Resident tiles with bridge geometry bound, and the triangles they hold. */
    bridgeTiles: number;
    bridgeTriangles: number;
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
    private readonly cover: CoverTextures;
    private readonly roads: RoadStrokes;
    private readonly bridges: BridgeMeshes;
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

    /**
     * Switch colour model. One uniform: every mode reads the same baked bytes,
     * so nothing re-streams, re-uploads or re-meshes.
     */
    setTerrainColour(mode: TerrainColours): void {
        this.landMaterial.uniforms.uTerrainMode.value = TERRAIN_COLOUR_MODE_INDEX[mode];
    }

    /**
     * Switch the far cover textures. One uniform, like the colour mode: the
     * textures already attached stay on their tiles, unread, and no new
     * sidecar is fetched while it is off.
     */
    setFarTileTextures(on: boolean): void {
        this.landMaterial.uniforms.uCoverEnabled.value = on ? 1 : 0;
        this.cover.setEnabled(on);
    }

    /** Switch which roads are drawn: a visibility flip on what is attached, no re-stream. */
    setRoads(mode: RoadsMode): void {
        this.roads.setMode(mode);
        this.bridges.setMode(mode);
    }

    /** Which of a resident tile's two land geometries new uploads start on. */
    private landShading: TerrainShading = TerrainShading.FACETED;
    /** Overall tree density multiplier; read fresh per tile scatter, see TerrainEntityOptions.treeDensity. */
    private treeDensity: number = TREE_DENSITY_MULTIPLIER_DEFAULT;
    /**
     * True until the boot-time pinned load finishes (see waitForPinned).
     * SMOOTH costs a second, expensive weld-and-average geometry per tile on
     * top of the always-built FACETED one - fine to pay tile-by-tile once
     * streaming is paced normally, but paying it for every one of a large
     * pinned set in one eager burst was doubling both the CPU cost and peak
     * memory of the whole boot phase, on top of everything tilesAround's
     * circular filter and waitForPinned's adaptive pacing were already
     * trying to keep down. Uploads during boot always build FACETED
     * regardless of the active setting; once boot finishes, a real SMOOTH
     * setting is applied the same lazy way a live switch already is (see
     * setTerrainShading) - once per tile, at the normal streaming pace, not
     * all at once.
     */
    private bootstrapping = true;

    /** True while upgradeResidentToSmooth is already pacing through the resident set, so a second call doesn't start a redundant one. */
    private smoothUpgradeRunning = false;

    /**
     * Switch between flat per-facet colour and smooth (Gouraud) shading.
     *
     * A tile upload only builds the SMOOTH geometry when SMOOTH is already
     * the active setting (see buildTileMeshes) — the weld-and-average pass is
     * too expensive to pay on every streamed tile regardless of which mode is
     * showing. Switching to SMOOTH swaps in whatever's already cached
     * immediately (cheap - no allocation), then hands off to
     * upgradeResidentToSmooth to build the rest: it used to build every
     * still-missing one right here, in one uninterrupted loop, which was
     * exactly the boot-time OOM (see `bootstrapping`) moved to whenever a
     * saved SMOOTH setting got applied instead of avoided.
     */
    setTerrainShading(mode: TerrainShading): void {
        this.landShading = mode;
        for (const meshes of this.streamer.values()) {
            const geometry = mode === TerrainShading.SMOOTH
                ? meshes.landGeometrySmooth ?? meshes.landGeometryFaceted
                : meshes.landGeometryFaceted;
            if (meshes.land && geometry) {
                meshes.land.geometry = geometry;
            }
        }
        if (mode === TerrainShading.SMOOTH) {
            void this.upgradeResidentToSmooth();
        }
    }

    /**
     * Paces through the resident set building any still-missing SMOOTH
     * geometry, a short burst at a time with a real yield in between - the
     * same burst/yield/GC-opportunity shape as waitForPinned, for the same
     * reason: building many of these back to back with no yield lets their
     * temporary buffers pile up as un-reclaimable garbage across the whole
     * burst instead of being reclaimed between tiles. Safe to call whenever
     * SMOOTH becomes active; only one pass ever runs at a time, and it stops
     * on its own if the mode is switched away before it finishes.
     */
    private async upgradeResidentToSmooth(): Promise<void> {
        if (this.smoothUpgradeRunning) {
            return;
        }
        this.smoothUpgradeRunning = true;
        try {
            const BUDGET_MS = 15;
            const YIELD_MS = 20;
            let moreToBuild = true;
            while (moreToBuild && this.landShading === TerrainShading.SMOOTH) {
                moreToBuild = false;
                const burstStart = Date.now();
                for (const meshes of this.streamer.values()) {
                    if (meshes.landGeometrySmooth || !meshes.landGeometryFaceted) {
                        continue;
                    }
                    const smoothLg = buildSmoothLandGeometryFromFaceted(meshes.landGeometryFaceted);
                    meshes.landGeometrySmooth = smoothLg;
                    if (smoothLg && meshes.land && this.landShading === TerrainShading.SMOOTH) {
                        meshes.land.geometry = smoothLg;
                    }
                    if (Date.now() - burstStart >= BUDGET_MS) {
                        moreToBuild = true;
                        break;
                    }
                }
                if (moreToBuild) {
                    await new Promise(r => setTimeout(r, YIELD_MS));
                }
            }
        } finally {
            this.smoothUpgradeRunning = false;
        }
    }

    /**
     * Scatters and builds this tile's tree billboards and attaches them,
     * replacing whatever was there before (if any) - used both for a freshly
     * streamed-in tile and for rebuildResidentTrees's live re-scatter when
     * the density setting changes. Async because each species group
     * present needs its own atlas texture (loaded once, cached across every
     * tile using that species) before its mesh can be built; scattering
     * itself is synchronous.
     */
    /** Density scale for this tile from its current distance to the LOD camera, times the user setting. */
    private treeScaleFor(tile: PtmTile): number {
        const distanceM = this.lodCamera
            ? this.lodCamera.position.distanceTo(tileOriginWorld(tile.id, tile.centerHeightM, this.basis))
            : 0;
        return treeDensityScaleForDistance(distanceM) * this.treeDensity;
    }

    /** Tiles rescattered this frame, capped so a big camera move spreads the work over frames. */
    private treeRescattersThisFrame = 0;

    private async attachTrees(tile: PtmTile, meshes: TileMeshes, materials: SceneMaterialManager): Promise<void> {
        // Thin out density with distance from whichever camera is currently
        // driving LOD - the same camera-to-tile distance the quadtree itself
        // already uses for refinement (see Quadtree.walk's
        // camPos.distanceTo(tilePosition(id))), so this reuses a comparison
        // already proven consistent rather than inventing a second one.
        // Falls back to full density if no LOD camera is set yet (e.g. very
        // first boot tiles).
        const densityScale = this.treeScaleFor(tile);
        meshes.treesScale = densityScale;
        meshes.treesBusy = true;
        const ptr = await this.roads.load(tile.id, 0);
        const groups = scatterTreeSpecies(tile, densityScale, ptr ? buildRoadExclusion(ptr) : undefined);
        const treeMeshes = groups.length > 0
            ? await getTreeAtlas()
                .then(atlas => [buildTreeMesh(groups, materials, atlas)])
                .catch(() => {
                    // No atlas (e.g. a canvas-less test environment) - the tile
                    // still draws, it just grows no trees.
                    return undefined;
                })
            : undefined;
        meshes.treesBusy = false;
        if (meshes.disposed) {
            return;
        }
        if (meshes.treesGroup) {
            meshes.group.remove(meshes.treesGroup);
            for (const old of meshes.trees ?? []) {
                old.geometry.dispose();
                (old.material as THREE.Material).dispose();
            }
        }
        meshes.trees = undefined;
        meshes.treesGroup = undefined;
        if (!treeMeshes || treeMeshes.length === 0) {
            return;
        }
        // scatterTreeSpecies already turns quantised positions into metres
        // (it needs real distances for area/spacing math), but the tile
        // group itself also scales by quantScale to do that same conversion
        // for the land and water meshes, whose positions stay quantised.
        // Without this wrapper the group would apply quantScale a second
        // time and every tree would collapse toward the tile origin.
        const treesGroup = new THREE.Group();
        treesGroup.scale.setScalar(1 / tile.quantScale);
        for (const trees of treeMeshes) {
            trees.onBeforeRender = tileBeforeRender;
            treesGroup.add(trees);
        }
        meshes.group.add(treesGroup);
        meshes.trees = treeMeshes;
        meshes.treesGroup = treesGroup;
    }

    /** True while rebuildResidentTrees is already pacing through the resident set, so a second call (another slider nudge) doesn't start a redundant one. */
    private treeRebuildRunning = false;
    private treeMaterials!: SceneMaterialManager;

    /**
     * Re-scatters trees for every currently resident leaf tile whose source
     * data is still cached - best-effort, since a tile uploaded a while ago
     * may have had its raw decoded bytes evicted independently of its GPU
     * resources (see TileStore); such a tile just keeps its trees at the old
     * density until it streams in again. Paced a handful of tiles at a time
     * with a real yield in between, the same shape as upgradeResidentToSmooth,
     * since scattering runs synchronously and re-attaching awaits atlas
     * textures that are normally already cached and resolve immediately.
     */
    private async rebuildResidentTrees(materials: SceneMaterialManager): Promise<void> {
        if (this.treeRebuildRunning) {
            return;
        }
        this.treeRebuildRunning = true;
        try {
            const TILES_PER_BURST = 5;
            const YIELD_MS = 16;
            const entries = this.meshStore.peekAll();
            for (let i = 0; i < entries.length; i += TILES_PER_BURST) {
                const burst = entries.slice(i, i + TILES_PER_BURST).map(({ id, value: tile }) => {
                    const meshes = this.streamer.get(id);
                    return meshes && meshes.treesRequested && !meshes.disposed ? this.attachTrees(meshes.treeSource ?? tile, meshes, materials) : undefined;
                });
                await Promise.all(burst);
                await new Promise(r => setTimeout(r, YIELD_MS));
            }
        } finally {
            this.treeRebuildRunning = false;
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
    private leafScale = LEAF_REFINE_DISTANCE_SCALE;
    /** Pixels of width a land-use region needs before it is drawn; see LANDUSE_REVEAL_MIN_PX. */
    private revealPx = LANDUSE_REVEAL_MIN_PX;
    private triangleBudget = TERRAIN_TRIANGLE_BUDGET;
    private drawList: QuadNode[] = [];
    private drawnTriangles = 0;
    /** Set for a frame where TERRAIN_TRIANGLE_BUDGET cut the draw list short. */
    private triangleBudgetHit = false;
    /** Sibling groups folded into their parent to fit the budget this reconcile; see coarsenToBudget. */
    private coarsenedTiles = 0;
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

        // Roads are the same kind of stroke as a river, in the two road
        // greys: a motorway is not a canal, but the pixel floor that keeps a
        // canal readable from altitude is exactly what a road needs too.
        const roadMaterial = (category: PaletteCategory) => {
            const m = opts.materials.build({
                type: SceneMaterialPrimitiveType.MESH,
                category,
                depthWrite: false,
                shaded: false as const,
                river: true,
            }) as THREE.ShaderMaterial;
            trackTerrainMaterial(m);
            return m;
        };
        const majorRoadMaterial = roadMaterial(PaletteCategory.SCENERY_ROAD_MAIN);
        const minorRoadMaterial = roadMaterial(PaletteCategory.SCENERY_ROAD_SECONDARY);

        // OSM landuse region edges are baked as a stroke stream beside the
        // rivers but are not drawn: the exact fills carry the shape on their
        // own, and a grey outline round every field read as a road net.

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

        if (opts.landuseReach) {
            this.leafScale = opts.landuseReach.getActive();
            opts.landuseReach.addChangeListener(s => { this.leafScale = s; });
        }
        if (opts.landuseReveal) {
            this.revealPx = opts.landuseReveal.getActive();
            opts.landuseReveal.addChangeListener(px => { this.revealPx = px; });
        }

        if (opts.triangleBudget) {
            this.triangleBudget = opts.triangleBudget.getActive();
            opts.triangleBudget.addChangeListener(n => { this.triangleBudget = n; });
        }

        this.treeMaterials = opts.materials;
        if (opts.treeDensity) {
            this.treeDensity = clampTreeDensityMultiplier(opts.treeDensity.getActive());
            opts.treeDensity.addChangeListener(n => {
                this.treeDensity = clampTreeDensityMultiplier(n);
                // Otherwise the slider only affects tiles streamed in after
                // the change - invisible if the player is just sitting over
                // forest already loaded, which is exactly when someone is
                // most likely to be watching the slider to see it do anything.
                void this.rebuildResidentTrees(opts.materials);
            });
        }

        // One uniform, like the colour mode: both colours are already baked.
        if (opts.landuseBlend) {
            this.landMaterial.uniforms.uLanduseBlend.value = opts.landuseBlend.getActive();
            opts.landuseBlend.addChangeListener(blend => {
                this.landMaterial.uniforms.uLanduseBlend.value = blend;
            });
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
            upload: (id, tile) => {
                const meshes = buildTileMeshes(
                    tile, this.basis, this.materials, this.riverMaterial,
                    tileBeforeRender, this.frameFix,
                    this.bootstrapping ? TerrainShading.FACETED : this.landShading,
                    undefined, opts.manifest.mesh.maxZoom,
                );
                // Trees are attached lazily from the draw loop (see
                // syncGroup), for the tiles actually being drawn - not here.
                // Keep the source for that: the store may evict it first.
                for (let i = 3; i < tile.landAttrs.length; i += 4) {
                    if (tile.landAttrs[i] === 1) {
                        meshes.treeSource = tile;
                        break;
                    }
                }
                return meshes;
            },
            release: (_id, m) => {
                this.cover.release(m);
                this.roads.release(m);
                this.bridges.release(m);
                disposeTileMeshes(m);
            },
        });

        // Road strokes ride beside the meshes like the textures do, bound
        // into the tile's own group when their sidecar lands.
        this.roads = new RoadStrokes({
            manifest: opts.manifest,
            baseUrl: base,
            majorMaterial: majorRoadMaterial,
            minorMaterial: minorRoadMaterial,
            onBeforeRender: tileBeforeRender,
        });

        // Bridges are lit solids on the leaf, in the two road greys: the
        // surface in the main road's, the concrete a shade off it. Both
        // depth-write, unlike the strokes they replace.
        const bridgeMaterial = (category: PaletteCategory) => {
            const m = opts.materials.build({
                type: SceneMaterialPrimitiveType.MESH,
                category,
                depthWrite: true,
                shaded: true as const,
            }) as THREE.ShaderMaterial;
            m.side = THREE.DoubleSide;
            trackTerrainMaterial(m);
            return m;
        };
        this.bridges = new BridgeMeshes({
            manifest: opts.manifest,
            baseUrl: base,
            deckMaterial: bridgeMaterial(PaletteCategory.SCENERY_ROAD_MAIN),
            concreteMaterial: bridgeMaterial(PaletteCategory.SCENERY_ROAD_SECONDARY),
            onBeforeRender: tileBeforeRender,
        });
        if (opts.roads) {
            this.setRoads(opts.roads.getActive());
            opts.roads.addChangeListener(mode => this.setRoads(mode));
        }

        // Far cover textures ride beside the meshes, in the bake's own frame:
        // a tile's positions are offsets in that frame's axes, and so is the
        // east/north frame the shader projects them onto.
        this.cover = new CoverTextures({
            manifest: opts.manifest,
            baseUrl: base,
            bakeBasis: makeEnuBasis(baked.lat, baked.lon, baked.height ?? 0),
        });
        noCoverTexture = this.landMaterial.uniforms.uCoverTex?.value ?? null;
        if (opts.farTileTextures) {
            this.setFarTileTextures(opts.farTileTextures.getActive());
            opts.farTileTextures.addChangeListener(on => this.setFarTileTextures(on));
        }

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
            tileErrorM: (id) => this.streamer.get(id)?.geometricErrorM,
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
        const texIndexUrl = textureIndexUrl(this.manifest, base);
        const roadsIndexUrl = roadIndexUrl(this.manifest, base);
        const bridgesIndexUrl = bridgeIndexUrl(this.manifest, base);
        const [meshIdx, heightIdx, texIdx, roadIdx, bridgeIdx] = await Promise.all([
            fetchIndex(meshIndexUrl(this.manifest, base)),
            fetchIndex(heightIndexUrl(this.manifest, base)),
            texIndexUrl === undefined ? Promise.resolve(undefined) : fetchIndex(texIndexUrl),
            roadsIndexUrl === undefined ? Promise.resolve(undefined) : fetchIndex(roadsIndexUrl),
            bridgesIndexUrl === undefined ? Promise.resolve(undefined) : fetchIndex(bridgesIndexUrl),
        ]);
        this.meshIndex = meshIdx;
        this.heightIndex = heightIdx;
        this.cover.setIndex(texIdx);
        this.roads.setIndex(roadIdx);
        this.bridges.setIndex(bridgeIdx);
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

    /** The far cover textures, for readers beside the land shader (the moving map). */
    get coverTextures(): CoverTextures {
        return this.cover;
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
        try {
            await this.waitForPinnedInner(onProgress);
        } finally {
            // Whether this finished, gave up at the deadline, or had nothing
            // to do: boot is over either way, and a real SMOOTH setting is
            // applied lazily now, tile by tile at the normal streaming pace,
            // rather than every pinned tile having eagerly paid for it during
            // the burst above - see `bootstrapping`.
            this.bootstrapping = false;
            if (this.landShading === TerrainShading.SMOOTH) {
                this.setTerrainShading(TerrainShading.SMOOTH);
            }
        }
    }

    private async waitForPinnedInner(onProgress?: (done: number, total: number) => void): Promise<void> {
        const total = this.pinned.size;
        if (total === 0) {
            return;
        }
        // Building a tile (landGeometry/regionSizes and friends) allocates a
        // handful of temporary buffers - union-find arrays, a corner map -
        // that turn to garbage the moment it finishes. Batching many tiles
        // into one long synchronous burst means none of that garbage can be
        // reclaimed until the whole burst ends, so peak memory during this
        // boot-time pinned load can run far higher than the tiles' own
        // steady-state footprint - enough to OOM on a large, densely
        // forested area even after cutting the pinned set's tile count (see
        // tilesAround's circular filter). But nearly every area is nowhere
        // near that limit, so paying a slow, small-burst pace unconditionally
        // punishes the common case for a problem that's actually rare.
        // Instead run at a fast pace by default and only drop to the slow,
        // GC-friendly one once real heap pressure shows up - self-correcting
        // rather than a single fixed trade-off. performance.memory is
        // Chromium-only; anywhere else this just always runs at the fast
        // pace (no way to detect pressure, and the fast pace is what every
        // area used before this was ever a problem).
        const FAST_PUMP_BUDGET_MS = 50;
        const FAST_YIELD_MS = 16;
        const SLOW_PUMP_BUDGET_MS = 15;
        const SLOW_YIELD_MS = 20;
        // Heap usage past this fraction of the engine's limit switches to the
        // slow pace; comfortably before the point an allocation would fail.
        const HEAP_PRESSURE_THRESHOLD = 0.7;
        // A wall-clock deadline rather than a fixed iteration count, so the
        // slow pace (if it ever kicks in) doesn't make this give up on a
        // legitimately large pinned set before it has actually had time to
        // finish.
        const DEADLINE_MS = 600000;
        const start = Date.now();
        while (Date.now() - start < DEADLINE_MS) {
            const outstanding = this.outstandingPinned();
            const done = total - outstanding.length;
            onProgress?.(done, total);
            if (outstanding.length === 0) {
                return;
            }
            const constrained = heapUnderPressure(HEAP_PRESSURE_THRESHOLD);
            this.streamer.pumpUploads(constrained ? SLOW_PUMP_BUDGET_MS : FAST_PUMP_BUDGET_MS);
            await new Promise(r => setTimeout(r, constrained ? SLOW_YIELD_MS : FAST_YIELD_MS));
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
        return this.drawnIndexAt(x, z)?.heightAtWorld(x, z);
    }

    /**
     * Cover of the drawn facet under a scene point, or undefined where
     * nothing is drawn yet. Same caveats as {@link drawnHeightAtWorld}: this
     * is whatever tile is on screen, at whatever level it is drawn — the
     * cover says which, and {@link maxZoom} is the level that has the last
     * word.
     */
    drawnCoverAtWorld(x: number, z: number): TileCover | undefined {
        return this.drawnIndexAt(x, z)?.coverAtWorld(x, z);
    }

    /** The index of the drawn land tile holding a scene point, if any. */
    private drawnIndexAt(x: number, z: number): TileHeightIndex | undefined {
        // Indices are pruned to the draw list, so at most one of them can hold
        // the point and checking the cache first makes the common case — an
        // aircraft sitting over the same tile for hundreds of frames — a
        // couple of triangle tests with no lookup at all.
        for (const index of this.drawnHeightIndices.values()) {
            if (index.heightAtWorld(x, z) !== undefined) {
                return index;
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
        const index = new TileHeightIndex(meshes.land, meshes.group, node.id.z);
        this.drawnHeightIndices.set(node.key, index);
        return index.heightAtWorld(x, z) === undefined ? undefined : index;
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
        this.cover.nextGeneration();
        this.roads.nextGeneration();
        this.bridges.nextGeneration();

        const r = this.quadtree.update(
            camera,
            this.viewportHeightPx,
            camera.fov,
            this.detailScale,
            this.detailDistanceM,
            (id) => this.pinned.has(tileKeyString(id)),
            this.leafScale,
            now,
        );

        const fit = this.coarsenToBudget(r.draw, camera.position);
        this.coarsenedTiles = fit.merged;
        r.wants.push(...fit.wants);
        this.streamer.setWants(r.wants, this.speculativeWants(camera, r.wants));
        this.drawList = fit.draw;
        // Land-use regions by size, see LANDUSE_REVEAL_MIN_PX: the pixel
        // threshold in metres of distance per metre of width, for this view.
        const sizeScale = this.landMaterial.uniforms.uSizeRevealScale;
        if (sizeScale) {
            sizeScale.value = landuseRevealScale(this.viewportHeightPx, camera.fov, this.revealPx);
        }
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

    /**
     * Fit the cut to the triangle budget by coarsening it, farthest first.
     *
     * The SSE governor bounds error, not cost, and over a flat land-use area
     * the leaves it asks for - twelve thousand triangles each, dozens in
     * view from a couple of thousand metres up - run past the budget on an
     * ordinary flight. The cap in syncGroup then dropped the farthest tiles
     * outright, and the far field past the cut read as a pale band of
     * nothing with a straight edge (2026-09-16). So the cut is reshaped
     * here instead: the farthest set of siblings whose parent is resident
     * is folded back into that parent, and again, until the total fits.
     * The result is still a quadtree cut - no holes, no overlap - just a
     * coarser one where the eye is least likely to notice.
     *
     * A parent stays out of reach while any grandchild is in the cut, so
     * a subtree coarsens from its leaves up. A parent that is not resident
     * cannot take over and is asked for, so the next reconcile can fold
     * into it; until then the cap below still applies.
     */
    private coarsenToBudget(
        draw: QuadNode[], camPos: THREE.Vector3,
    ): { draw: QuadNode[]; merged: number; wants: TileWant[] } {
        const cost = (node: QuadNode): number => {
            const meshes = this.streamer.get(node.id);
            return meshes ? countTriangles(meshes) : OCEAN_PATCH_TRIANGLES;
        };
        let total = 0;
        const cut = new Map<string, QuadNode>();
        // Dissolving leaf parents ride under their leaves; they are not part
        // of the cut but do cost triangles, and folding leaves into one
        // simply promotes it.
        const under = new Map<string, QuadNode>();
        for (const node of draw) {
            (node.under ? under : cut).set(node.key, node);
            total += cost(node);
        }
        if (total <= this.triangleBudget) {
            return { draw, merged: 0, wants: [] };
        }

        let merged = 0;
        const wants: TileWant[] = [];
        const asked = new Set<string>();
        while (total > this.triangleBudget) {
            // Parents with a grandchild or deeper in the cut cannot take over.
            const deep = new Set<string>();
            const parents = new Map<string, TileKey>();
            for (const node of cut.values()) {
                let id = parentOf(node.id);
                if (id === undefined) {
                    continue;
                }
                parents.set(tileKeyString(id), id);
                for (id = parentOf(id); id !== undefined; id = parentOf(id)) {
                    const key = tileKeyString(id);
                    if (deep.has(key)) {
                        break;
                    }
                    deep.add(key);
                }
            }
            // Every candidate of this round can fold independently - two
            // candidates are distinct parents, and neither is under the
            // other, or the one above would have a grandchild in the cut -
            // so the round folds them farthest first until the cut fits,
            // and the next round sees whatever parents that freed.
            const candidates: Array<{ key: string; node: QuadNode; distance: number }> = [];
            for (const [key, id] of parents) {
                if (deep.has(key)) {
                    continue;
                }
                const node = this.quadtree.node(key);
                if (!node) {
                    continue;
                }
                if (!this.streamer.get(id) && !node.ocean) {
                    if (!asked.has(key)) {
                        asked.add(key);
                        wants.push({
                            id, ssePx: node.geometricErrorM,
                            distanceM: Math.max(1, camPos.distanceTo(node.center) - node.radius),
                            inFrustum: true, pinned: false,
                        });
                    }
                    continue;
                }
                candidates.push({ key, node, distance: camPos.distanceTo(node.center) - node.radius });
            }
            if (candidates.length === 0) {
                break;
            }
            candidates.sort((a, b) => b.distance - a.distance);
            for (const { key, node } of candidates) {
                if (total <= this.triangleBudget) {
                    break;
                }
                for (const child of node.children ?? []) {
                    const c = cut.get(child.key);
                    if (c) {
                        cut.delete(child.key);
                        total -= cost(c);
                    }
                }
                if (under.has(key)) {
                    under.delete(key);
                } else {
                    total += cost(node);
                }
                node.under = false;
                cut.set(key, node);
                merged++;
            }
        }
        if (merged === 0) {
            return { draw, merged: 0, wants };
        }
        // A dissolving parent whose leaves are all gone has nothing to sit
        // under; one still holding some leaves keeps riding beneath them.
        const out: QuadNode[] = [...cut.values()];
        for (const node of under.values()) {
            if (node.children?.some(c => cut.has(c.key))) {
                out.push(node);
            }
        }
        return { draw: out, merged, wants };
    }

    private syncGroup(camPos: THREE.Vector3): void {
        this.group.clear();
        this.drawnTriangles = 0;
        this.treeRescattersThisFrame = 0;
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
                if (this.drawnTriangles >= this.triangleBudget) {
                    // See TERRAIN_TRIANGLE_BUDGET: the SSE governor bounds
                    // error, not triangle count, and can still leave a
                    // pathologically large draw list over complex terrain.
                    // Everything from here on is farther than everything
                    // already added, so stopping rather than skipping keeps
                    // the gap this creates confined to the view's far edge.
                    // coarsenToBudget has normally folded the far field
                    // into coarser tiles before this is reached; it engages
                    // only when the parents it needed were not resident.
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
                // Read per draw by tileBeforeRender. Mutated in place: this
                // runs for every drawn tile every reconcile.
                const lod = (meshes.group.userData.lod ??= { pushM: 0, fadeM: 0, fadeFromMs: 0 }) as TileLodState;
                lod.pushM = node.under ? node.geometricErrorM * LOD_DEPTH_PUSH_SCALE : 0;
                lod.fadeM = node.fadeM;
                lod.fadeFromMs = node.fadeFromMs;
                this.group.add(meshes.group);
                // Trees follow the draw selection, not residency: a cached
                // ancestor drawn beneath its children stays bare (they carry
                // the trees), while a coarse tile that is the real LOD
                // choice for its ground gets its own instead of a bare hole.
                if (meshes.treesGroup) {
                    meshes.treesGroup.visible = !node.under;
                }
                if (!node.under && !meshes.treesRequested) {
                    const src = meshes.treeSource;
                    if (src) {
                        meshes.treesRequested = true;
                        void this.attachTrees(src, meshes, this.treeMaterials);
                    }
                } else if (!node.under && meshes.treeSource && !meshes.treesBusy
                    && meshes.treesScale !== undefined && this.treeRescattersThisFrame < 1) {
                    // The camera moved since this tile's density was chosen:
                    // rescatter once it differs enough (or trees appear /
                    // vanish at the cutoff), one tile per frame.
                    const want = this.treeScaleFor(meshes.treeSource);
                    const had = meshes.treesScale;
                    const changed = (want === 0) !== (had === 0)
                        || (want > 0 && (want > had * 1.6 || want < had / 1.6));
                    if (changed) {
                        this.treeRescattersThisFrame++;
                        void this.attachTrees(meshes.treeSource, meshes, this.treeMaterials);
                    }
                }
                this.drawnTriangles += countTriangles(meshes) + this.roads.trianglesOf(meshes)
                    + this.bridges.trianglesOf(meshes);
                // Nearest first, like the meshes; a leaf never has one and
                // returns from this at once.
                const priority = PRIORITY_IN_FRUSTUM - Math.sqrt(node.center.distanceToSquared(camPos));
                this.cover.attach(node.id, meshes, priority);
                this.roads.attach(node.id, meshes, priority);
                this.bridges.attach(node.id, meshes, priority);
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
            coarsenedTiles: this.coarsenedTiles,
            textured: this.cover.stats.attached,
            texturesInflight: this.cover.stats.inflight,
            roadTiles: this.roads.stats.attached,
            roadTriangles: this.roads.stats.triangles,
            bridgeTiles: this.bridges.stats.attached,
            bridgeTriangles: this.bridges.stats.triangles,
        };
    }
}

/** What a sea stand-in costs the budget; see buildOceanPatch. */
const OCEAN_PATCH_TRIANGLES = 10;

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

/** Non-standard, Chromium-only; absent elsewhere. */
interface PerformanceMemory {
    usedJSHeapSize: number;
    jsHeapSizeLimit: number;
}

/**
 * Whether used heap is past `fraction` of the engine's limit. Returns false
 * (never throttle) where performance.memory isn't available, since there's
 * no signal to act on there - not a reason to assume the worst.
 */
function heapUnderPressure(fraction: number): boolean {
    const mem = (performance as Performance & { memory?: PerformanceMemory }).memory;
    if (!mem || !mem.jsHeapSizeLimit) {
        return false;
    }
    return mem.usedJSHeapSize / mem.jsHeapSizeLimit > fraction;
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

/**
 * Tile ids covering a radius around a scene point at one zoom.
 *
 * The longitude search half-width is widened by 1/cos(lat) so it still spans
 * radiusM real metres at any latitude - correct, and unavoidably means a
 * high-latitude location needs more, narrower tiles than an equatorial one
 * for the same physical radius. But that widened search is a rectangle, and
 * a wide, short rectangle's corners reach well outside the actual circle it
 * was sized to cover - at 52 degrees latitude the corners are farther from
 * centre than the circle's own radius by a factor of several, so without
 * this filter this pulls in a real fraction of tiles that don't cover
 * anything within radiusM at all. Since pinned tiles bypass the normal
 * cache/eviction budget entirely (see waitForPinned), every wasted tile here
 * is pure, un-evictable memory pressure toward the boot-time OOM this was
 * fixed for - filtering to the circle (with a half-diagonal margin, so a
 * tile only touching the circle's edge is still kept) removes that waste
 * without changing how much real ground ends up covered.
 */
function tilesAround(
    basis: EnuBasis, x: number, z: number, radiusM: number, zoom: number, span: number,
): TileKey[] {
    const c = enuToGeodeticApprox(basis, x, northFromSceneZ(z), 0);
    const cosLat = Math.max(0.1, Math.cos(c.lat * Math.PI / 180));
    const dLat = radiusM / 110540;
    const dLon = radiusM / (111320 * cosLat);
    const x0 = Math.floor((c.lon - dLon + 180) / span);
    const x1 = Math.floor((c.lon + dLon + 180) / span);
    const y0 = Math.floor((90 - (c.lat + dLat)) / span);
    const y1 = Math.floor((90 - (c.lat - dLat)) / span);

    // Half the diagonal of one tile, in metres, as the inclusion margin.
    const tileWidthM = span * 111320 * cosLat;
    const tileHeightM = span * 110540;
    const marginM = 0.5 * Math.hypot(tileWidthM, tileHeightM);
    const maxDistM = radiusM + marginM;

    const out: TileKey[] = [];
    for (let y = y0; y <= y1; y++) {
        const tileLat = 90 - (y + 0.5) * span;
        for (let x = x0; x <= x1; x++) {
            const tileLon = (x + 0.5) * span - 180;
            const dEastM = (tileLon - c.lon) * 111320 * cosLat;
            const dNorthM = (tileLat - c.lat) * 110540;
            if (Math.hypot(dEastM, dNorthM) <= maxDistM) {
                out.push({ z: zoom, x, y });
            }
        }
    }
    return out;
}

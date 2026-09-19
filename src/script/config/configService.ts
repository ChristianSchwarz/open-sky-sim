import { FlightModel } from "../physics/model/flightModel";
import { DEFAULT_SUN_HOURS } from "../scene/materials/shaders/sun";
import { AiPilotModels, RoadsMode, TerrainColours, TerrainShading, UnitSystems } from "../state/gameDefs";
import { assertExpr, assertIsDefined } from "../utils/asserts";
import {
    LANDUSE_REVEAL_MIN_PX, LEAF_REFINE_DISTANCE_SCALE, TERRAIN_DETAIL_DISTANCE_DEFAULT_M, TERRAIN_TRIANGLE_BUDGET,
    clampDetailDistanceM, clampLanduseRevealPx, clampLeafRefineScale, clampTriangleBudget,
} from "../terrain/lod";
import { LANDUSE_BLEND_DEFAULT, clampLanduseBlend } from "../terrain/tones";
import { TREE_DENSITY_MULTIPLIER_DEFAULT, clampTreeDensityMultiplier } from "../terrain/treeBillboards";
import { TechProfile } from "./profiles/profile";

type ProfileChangeListener = (profile: TechProfile, newId: string, oldId: string) => void;
type FlightModelChangeListener = (flightModel: FlightModel, newId: string, oldId: string) => void;
export type UnitSystemChangeListener = (unitSystem: UnitSystems) => void;
export type AiPilotModelChangeListener = (model: AiPilotModels) => void;
export type TerrainColourChangeListener = (mode: TerrainColours) => void;
export type TerrainShadingChangeListener = (mode: TerrainShading) => void;
export type LanduseBlendChangeListener = (blend: number) => void;
export type TreeDensityChangeListener = (multiplier: number) => void;
export type DaytimeChangeListener = (hours: number) => void;
export type TerrainDetailChangeListener = (distanceM: number) => void;
export type LanduseReachChangeListener = (scale: number) => void;
export type LanduseRevealChangeListener = (px: number) => void;
export type TriangleBudgetChangeListener = (triangles: number) => void;
export type FarTileTexturesChangeListener = (enabled: boolean) => void;
export type RoadsChangeListener = (mode: RoadsMode) => void;
export type RenderScaleChangeListener = (scale: number) => void;
export type SupersamplingChangeListener = (enabled: boolean) => void;

/**
 * Selectable 3D render scales, as fractions of the screen. 1 is off: the
 * scene is drawn at native size (with its supersample where the resolution
 * affords one). Anything below draws the 3D view that much smaller and
 * stretches it to the screen, with the HUD and displays drawn on top at
 * full size.
 */
export const RENDER_SCALES: readonly number[] = [1, 0.9, 0.8, 0.7, 0.6, 0.5];

export class ConfigService {

    readonly techProfiles: ConfigSet<TechProfile>;
    readonly flightModels: ConfigSet<FlightModel>;
    readonly unitSystem: UnitSystemSetting;
    readonly aiPilotModels: AiPilotModelSetting;
    readonly terrainColour: TerrainColourSetting;
    readonly terrainShading: TerrainShadingSetting;
    readonly landuseBlend: LanduseBlendSetting;
    readonly treeDensity: TreeDensitySetting;
    readonly terrainDetail: TerrainDetailSetting;
    readonly landuseReach: LanduseReachSetting;
    readonly landuseReveal: LanduseRevealSetting;
    readonly triangleBudget: TriangleBudgetSetting;
    readonly farTileTextures: FarTileTexturesSetting;
    readonly roads: RoadsSetting;
    readonly renderScale: RenderScaleSetting;
    readonly supersampling: SupersamplingSetting;
    readonly daytime: DaytimeSetting;

    constructor(
        profiles: { [id: string]: TechProfile },
        flightModels: { [id: string]: FlightModel },
        initialTechProfile?: string,
        initialFlightModel?: string,
        initialAiPilotModel?: AiPilotModels,
        initialDaytime?: number,
        initialTerrainColour?: TerrainColours,
        initialTerrainDetailM?: number,
        initialTerrainShading?: TerrainShading,
        initialLanduseBlend?: number,
        initialLanduseReach?: number,
        initialTriangleBudget?: number,
        initialLanduseRevealPx?: number,
        initialFarTileTextures?: boolean,
        initialRenderScale?: number,
        initialSupersampling?: boolean,
        initialRoads?: RoadsMode,
        initialTreeDensity?: number,
    ) {
        this.techProfiles = new ConfigSet(profiles, initialTechProfile);
        this.flightModels = new ConfigSet(flightModels, initialFlightModel);
        this.unitSystem = new UnitSystemSetting();
        this.aiPilotModels = new AiPilotModelSetting(initialAiPilotModel);
        this.terrainColour = new TerrainColourSetting(initialTerrainColour);
        this.terrainShading = new TerrainShadingSetting(initialTerrainShading);
        this.landuseBlend = new LanduseBlendSetting(initialLanduseBlend);
        this.terrainDetail = new TerrainDetailSetting(initialTerrainDetailM);
        this.landuseReach = new LanduseReachSetting(initialLanduseReach);
        this.landuseReveal = new LanduseRevealSetting(initialLanduseRevealPx);
        this.triangleBudget = new TriangleBudgetSetting(initialTriangleBudget);
        this.farTileTextures = new FarTileTexturesSetting(initialFarTileTextures);
        this.roads = new RoadsSetting(initialRoads);
        this.renderScale = new RenderScaleSetting(initialRenderScale);
        this.supersampling = new SupersamplingSetting(initialSupersampling);
        this.treeDensity = new TreeDensitySetting(initialTreeDensity);
        this.daytime = new DaytimeSetting(initialDaytime);
    }
}

type ConfigSetChangeListener<T> = (item: T, newId: string, oldId: string) => void;

/**
 * Local solar time of day, in hours (0..24). Drives the sun direction, the
 * blended sky/terrain palette and the cast shadows; see
 * {@link setSunTime} and {@link daytimePalette}.
 */
export class DaytimeSetting {
    private active: number;
    private listeners: Set<DaytimeChangeListener> = new Set();

    constructor(initialActive: number = DEFAULT_SUN_HOURS) {
        this.active = clampDaytime(initialActive);
    }

    getActive(): number {
        return this.active;
    }

    setActive(hours: number) {
        const clamped = clampDaytime(hours);
        if (clamped === this.active) return;
        this.active = clamped;
        this.notifyActive();
    }

    /** Push the current value to listeners (used once after they register). */
    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: DaytimeChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: DaytimeChangeListener) {
        this.listeners.delete(listener);
    }
}

/**
 * How far out terrain keeps full detail, in metres.
 *
 * Past it the far field is allowed to coarsen faster than screen space alone
 * would coarsen it — see {@link detailFalloff} — which is where most of the
 * triangle count above the horizon goes. The top of the slider is
 * {@link DETAIL_DISTANCE_OFF}: no falloff, the behaviour before this existed.
 */
export class TerrainDetailSetting {
    private active: number;
    private listeners: Set<TerrainDetailChangeListener> = new Set();

    constructor(initialActive: number = TERRAIN_DETAIL_DISTANCE_DEFAULT_M) {
        this.active = clampDetailDistanceM(initialActive);
    }

    getActive(): number {
        return this.active;
    }

    setActive(distanceM: number) {
        const clamped = clampDetailDistanceM(distanceM);
        if (clamped === this.active) return;
        this.active = clamped;
        this.notifyActive();
    }

    /** Push the current value to listeners (used once after they register). */
    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: TerrainDetailChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: TerrainDetailChangeListener) {
        this.listeners.delete(listener);
    }
}

/**
 * How much further out the leaf tiles - the only level carrying the exact
 * land-use fills - come in than screen-space error alone would bring them.
 * 1 is no bias; see {@link LEAF_REFINE_DISTANCE_SCALE}.
 */
export class LanduseReachSetting {
    private active: number;
    private listeners: Set<LanduseReachChangeListener> = new Set();

    constructor(initialActive: number = LEAF_REFINE_DISTANCE_SCALE) {
        this.active = clampLeafRefineScale(initialActive);
    }

    getActive(): number {
        return this.active;
    }

    setActive(scale: number) {
        const clamped = clampLeafRefineScale(scale);
        if (clamped === this.active) return;
        this.active = clamped;
        this.notifyActive();
    }

    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: LanduseReachChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: LanduseReachChangeListener) {
        this.listeners.delete(listener);
    }
}

/**
 * The smallest a land-use region may be on screen, in pixels of width, before
 * it is drawn; see {@link LANDUSE_REVEAL_MIN_PX}. Lower shows small fields
 * from further away.
 */
export class LanduseRevealSetting {
    private active: number;
    private listeners: Set<LanduseRevealChangeListener> = new Set();

    constructor(initialActive: number = LANDUSE_REVEAL_MIN_PX) {
        this.active = clampLanduseRevealPx(initialActive);
    }

    getActive(): number {
        return this.active;
    }

    setActive(px: number) {
        const clamped = clampLanduseRevealPx(px);
        if (clamped === this.active) return;
        this.active = clamped;
        this.notifyActive();
    }

    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: LanduseRevealChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: LanduseRevealChangeListener) {
        this.listeners.delete(listener);
    }
}

/**
 * Whether far tiles paint the leaf-level cover texture the bake shipped for
 * them (see CoverTextures) or one colour per facet. Off is how a pyramid
 * baked without textures always looks; on costs nothing where there are none.
 */
export class FarTileTexturesSetting {
    private active: boolean;
    private listeners: Set<FarTileTexturesChangeListener> = new Set();

    constructor(initialActive: boolean = true) {
        this.active = initialActive;
    }

    getActive(): boolean {
        return this.active;
    }

    setActive(enabled: boolean) {
        if (enabled === this.active) return;
        this.active = enabled;
        this.notifyActive();
    }

    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: FarTileTexturesChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: FarTileTexturesChangeListener) {
        this.listeners.delete(listener);
    }
}

/**
 * Which baked roads are drawn (see RoadStrokes). Off is how a pyramid baked
 * without roads always looks; on costs nothing where there are none.
 */
export class RoadsSetting {
    private active: RoadsMode;
    private listeners: Set<RoadsChangeListener> = new Set();

    constructor(initialActive: RoadsMode = RoadsMode.ALL) {
        this.active = initialActive;
    }

    getActive(): RoadsMode {
        return this.active;
    }

    setActive(mode: RoadsMode) {
        if (mode === this.active) return;
        this.active = mode;
        this.notifyActive();
    }

    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: RoadsChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: RoadsChangeListener) {
        this.listeners.delete(listener);
    }
}

/**
 * Fraction of the screen the 3D view is rendered at before being stretched
 * to full size; one of {@link RENDER_SCALES}. 1 is off. A fill-rate trade
 * only: geometry, LOD and the HUD are unaffected.
 */
export class RenderScaleSetting {
    private active: number;
    private listeners: Set<RenderScaleChangeListener> = new Set();

    constructor(initialScale: number = 1) {
        this.active = RENDER_SCALES.includes(initialScale) ? initialScale : 1;
    }

    getActive(): number {
        return this.active;
    }

    setActive(scale: number) {
        if (!RENDER_SCALES.includes(scale) || scale === this.active) return;
        this.active = scale;
        this.notifyActive();
    }

    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: RenderScaleChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: RenderScaleChangeListener) {
        this.listeners.delete(listener);
    }
}

/**
 * Whether the 3D targets are supersampled (SSAA) where the screen resolution
 * affords it - see hdSupersampleScale in game.ts. Off draws them at native
 * size with no anti-aliasing, for the fill rate. Moot while the render scale
 * is below 1, which already replaces the supersample.
 */
export class SupersamplingSetting {
    private active: boolean;
    private listeners: Set<SupersamplingChangeListener> = new Set();

    constructor(initialActive: boolean = true) {
        this.active = initialActive;
    }

    getActive(): boolean {
        return this.active;
    }

    setActive(enabled: boolean) {
        if (enabled === this.active) return;
        this.active = enabled;
        this.notifyActive();
    }

    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: SupersamplingChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: SupersamplingChangeListener) {
        this.listeners.delete(listener);
    }
}

/**
 * Hard ceiling on terrain triangles drawn per frame; see
 * {@link TERRAIN_TRIANGLE_BUDGET}. The draw list is cut at the far edge once
 * it is reached, so a low cap shows as missing far terrain, not as coarse
 * near terrain.
 */
export class TriangleBudgetSetting {
    private active: number;
    private listeners: Set<TriangleBudgetChangeListener> = new Set();

    constructor(initialActive: number = TERRAIN_TRIANGLE_BUDGET) {
        this.active = clampTriangleBudget(initialActive);
    }

    getActive(): number {
        return this.active;
    }

    setActive(triangles: number) {
        const clamped = clampTriangleBudget(triangles);
        if (clamped === this.active) return;
        this.active = clamped;
        this.notifyActive();
    }

    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: TriangleBudgetChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: TriangleBudgetChangeListener) {
        this.listeners.delete(listener);
    }
}

/** 24:00 wraps to 00:00 so the slider's two ends are the same midnight. */
function clampDaytime(hours: number): number {
    if (!Number.isFinite(hours)) return DEFAULT_SUN_HOURS;
    return ((hours % 24) + 24) % 24;
}

class ConfigSet<T> {
    private active: string;
    private set: Map<string, T>;
    private listeners: Set<ConfigSetChangeListener<T>> = new Set();

    constructor(obj: { [id: string]: T }, initialActive?: string) {
        [this.active, this.set] = this.setupMap(obj, initialActive);
    }

    private setupMap(obj: { [id: string]: T }, initialActive?: string): [string, Map<string, T>] {
        const map = new Map(Object.entries(obj));
        assertExpr(map.size > 0);
        const fallback = Object.keys(obj)[0];
        const active = initialActive !== undefined && map.has(initialActive) ? initialActive : fallback;
        return [active, map];
    }

    setActive(id: string) {
        if (id === this.active) return;
        assertExpr(this.set.has(id));

        const oldId = this.active;
        this.active = id;
        const set = this.getActive();
        for (const l of this.listeners.values()) {
            l(set, id, oldId);
        }
    }

    /** Apply the current active item to listeners (used once after listeners are registered). */
    notifyActive() {
        const set = this.getActive();
        for (const l of this.listeners.values()) {
            l(set, this.active, this.active);
        }
    }

    getActive(): T {
        const item = this.set.get(this.active);
        assertIsDefined(item);
        return item;
    }

    getActiveKey(): string {
        return this.active;
    }

    addChangeListener(listener: ConfigSetChangeListener<T>) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: ConfigSetChangeListener<T>) {
        this.listeners.delete(listener);
    }
}

export class UnitSystemSetting {
    private active: UnitSystems = UnitSystems.METRIC;
    private listeners: Set<UnitSystemChangeListener> = new Set();

    getActive(): UnitSystems {
        return this.active;
    }

    setActive(system: UnitSystems) {
        if (system === this.active) return;
        this.active = system;
        for (const listener of this.listeners.values()) {
            listener(system);
        }
    }

    addChangeListener(listener: UnitSystemChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: UnitSystemChangeListener) {
        this.listeners.delete(listener);
    }
}

export class AiPilotModelSetting {
    private active: AiPilotModels;
    private listeners: Set<AiPilotModelChangeListener> = new Set();

    constructor(initialActive: AiPilotModels = AiPilotModels.CLASSIC) {
        this.active = initialActive;
    }

    getActive(): AiPilotModels {
        return this.active;
    }

    setActive(model: AiPilotModels) {
        if (model === this.active) return;
        this.active = model;
        for (const listener of this.listeners.values()) {
            listener(model);
        }
    }

    addChangeListener(listener: AiPilotModelChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: AiPilotModelChangeListener) {
        this.listeners.delete(listener);
    }
}

/**
 * Which of the four terrain colour models is on screen.
 *
 * Every one of them is served by the same baked bytes, so this is a uniform
 * write and nothing else - no re-stream, no re-upload, no re-bake.
 */
export class TerrainColourSetting {
    private active: TerrainColours;
    private listeners: Set<TerrainColourChangeListener> = new Set();

    constructor(initialActive: TerrainColours = TerrainColours.HYBRID) {
        this.active = initialActive;
    }

    getActive(): TerrainColours {
        return this.active;
    }

    setActive(mode: TerrainColours) {
        if (mode === this.active) return;
        this.active = mode;
        this.notifyActive();
    }

    /** Push the current value to listeners (used once after they register). */
    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: TerrainColourChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: TerrainColourChangeListener) {
        this.listeners.delete(listener);
    }
}

/**
 * How land-use facets mix their two colours, 0..1: the share taken from the
 * land type's palette tone, the rest from the terrain colour sampled from
 * imagery. 0 paints the sampled colour alone, 1 the palette tone alone.
 *
 * Like the colour mode it is one uniform write - the baked bytes already hold
 * both colours - so moving the slider re-streams and re-bakes nothing.
 */
export class LanduseBlendSetting {
    private active: number;
    private listeners: Set<LanduseBlendChangeListener> = new Set();

    constructor(initialActive: number = LANDUSE_BLEND_DEFAULT) {
        this.active = clampLanduseBlend(initialActive);
    }

    getActive(): number {
        return this.active;
    }

    setActive(blend: number) {
        const clamped = clampLanduseBlend(blend);
        if (clamped === this.active) return;
        this.active = clamped;
        this.notifyActive();
    }

    /** Push the current value to listeners (used once after they register). */
    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: LanduseBlendChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: LanduseBlendChangeListener) {
        this.listeners.delete(listener);
    }
}

/**
 * Overall tree density multiplier, 0..20 (1 = the baked-in default spacing,
 * see TREE_SPACING_M2 in treeBillboards.ts; 0 turns trees off). A change
 * re-scatters every resident tile's trees (see
 * TerrainEntity.rebuildResidentTrees), not just tiles streamed in afterward.
 */
export class TreeDensitySetting {
    private active: number;
    private listeners: Set<TreeDensityChangeListener> = new Set();

    constructor(initialActive: number = TREE_DENSITY_MULTIPLIER_DEFAULT) {
        this.active = clampTreeDensityMultiplier(initialActive);
    }

    getActive(): number {
        return this.active;
    }

    setActive(multiplier: number) {
        const clamped = clampTreeDensityMultiplier(multiplier);
        if (clamped === this.active) return;
        this.active = clamped;
        this.notifyActive();
    }

    /** Push the current value to listeners (used once after they register). */
    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: TreeDensityChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: TreeDensityChangeListener) {
        this.listeners.delete(listener);
    }
}

/**
 * Flat per-facet colour (FACETED) or smooth interpolation across it
 * (SMOOTH). Unlike terrain colour this is not a uniform write: SMOOTH reads
 * a differently-built geometry, so the terrain entity swaps the land mesh
 * per tile on change rather than just updating a shader uniform.
 */
export class TerrainShadingSetting {
    private active: TerrainShading;
    private listeners: Set<TerrainShadingChangeListener> = new Set();

    constructor(initialActive: TerrainShading = TerrainShading.FACETED) {
        this.active = initialActive;
    }

    getActive(): TerrainShading {
        return this.active;
    }

    setActive(mode: TerrainShading) {
        if (mode === this.active) return;
        this.active = mode;
        this.notifyActive();
    }

    /** Push the current value to listeners (used once after they register). */
    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: TerrainShadingChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: TerrainShadingChangeListener) {
        this.listeners.delete(listener);
    }
}

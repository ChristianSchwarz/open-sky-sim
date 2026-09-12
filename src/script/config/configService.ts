import { FlightModel } from "../physics/model/flightModel";
import { DEFAULT_SUN_HOURS } from "../scene/materials/shaders/sun";
import { AiPilotModels, ShadowQualities, TerrainColours, TerrainShading, UnitSystems } from "../state/gameDefs";
import { assertExpr, assertIsDefined } from "../utils/asserts";
import {
    LEAF_REFINE_DISTANCE_SCALE, TERRAIN_DETAIL_DISTANCE_DEFAULT_M, TERRAIN_TRIANGLE_BUDGET,
    clampDetailDistanceM, clampLeafRefineScale, clampTriangleBudget,
} from "../terrain/lod";
import { LANDUSE_BLEND_DEFAULT, clampLanduseBlend } from "../terrain/tones";
import { TechProfile } from "./profiles/profile";

export type ProfileChangeListener = (profile: TechProfile, newId: string, oldId: string) => void;
export type FlightModelChangeListener = (flightModel: FlightModel, newId: string, oldId: string) => void;
export type UnitSystemChangeListener = (unitSystem: UnitSystems) => void;
export type AiPilotModelChangeListener = (model: AiPilotModels) => void;
export type ShadowQualityChangeListener = (quality: ShadowQualities) => void;
export type TerrainColourChangeListener = (mode: TerrainColours) => void;
export type TerrainShadingChangeListener = (mode: TerrainShading) => void;
export type LanduseBlendChangeListener = (blend: number) => void;
export type DaytimeChangeListener = (hours: number) => void;
export type TerrainDetailChangeListener = (distanceM: number) => void;
export type LanduseReachChangeListener = (scale: number) => void;
export type TriangleBudgetChangeListener = (triangles: number) => void;

export class ConfigService {

    readonly techProfiles: ConfigSet<TechProfile>;
    readonly flightModels: ConfigSet<FlightModel>;
    readonly unitSystem: UnitSystemSetting;
    readonly aiPilotModels: AiPilotModelSetting;
    readonly shadowQuality: ShadowQualitySetting;
    readonly terrainColour: TerrainColourSetting;
    readonly terrainShading: TerrainShadingSetting;
    readonly landuseBlend: LanduseBlendSetting;
    readonly terrainDetail: TerrainDetailSetting;
    readonly landuseReach: LanduseReachSetting;
    readonly triangleBudget: TriangleBudgetSetting;
    readonly daytime: DaytimeSetting;

    constructor(
        profiles: { [id: string]: TechProfile },
        flightModels: { [id: string]: FlightModel },
        initialTechProfile?: string,
        initialFlightModel?: string,
        initialAiPilotModel?: AiPilotModels,
        initialShadowQuality?: ShadowQualities,
        initialDaytime?: number,
        initialTerrainColour?: TerrainColours,
        initialTerrainDetailM?: number,
        initialTerrainShading?: TerrainShading,
        initialLanduseBlend?: number,
        initialLanduseReach?: number,
        initialTriangleBudget?: number,
    ) {
        this.techProfiles = new ConfigSet(profiles, initialTechProfile);
        this.flightModels = new ConfigSet(flightModels, initialFlightModel);
        this.unitSystem = new UnitSystemSetting();
        this.aiPilotModels = new AiPilotModelSetting(initialAiPilotModel);
        this.shadowQuality = new ShadowQualitySetting(initialShadowQuality);
        this.terrainColour = new TerrainColourSetting(initialTerrainColour);
        this.terrainShading = new TerrainShadingSetting(initialTerrainShading);
        this.landuseBlend = new LanduseBlendSetting(initialLanduseBlend);
        this.terrainDetail = new TerrainDetailSetting(initialTerrainDetailM);
        this.landuseReach = new LanduseReachSetting(initialLanduseReach);
        this.triangleBudget = new TriangleBudgetSetting(initialTriangleBudget);
        this.daytime = new DaytimeSetting(initialDaytime);
    }
}

export type ConfigSetChangeListener<T> = (item: T, newId: string, oldId: string) => void;

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
export function clampDaytime(hours: number): number {
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

export class ShadowQualitySetting {
    private active: ShadowQualities;
    private listeners: Set<ShadowQualityChangeListener> = new Set();

    constructor(initialActive: ShadowQualities = ShadowQualities.LOW) {
        this.active = initialActive;
    }

    getActive(): ShadowQualities {
        return this.active;
    }

    setActive(quality: ShadowQualities) {
        if (quality === this.active) return;
        this.active = quality;
        this.notifyActive();
    }

    /** Push the current value to listeners (used once after they register). */
    notifyActive() {
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: ShadowQualityChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: ShadowQualityChangeListener) {
        this.listeners.delete(listener);
    }
}

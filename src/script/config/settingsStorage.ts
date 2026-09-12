import { KeyboardControlLayoutId } from "../input/devices/keyboardControlDevice";
import { DEFAULT_SUN_HOURS } from "../scene/materials/shaders/sun";
import { AiPilotModels, FlightModels, ShadowQualities, TechProfiles, TerrainColours, TerrainShading } from "../state/gameDefs";
import {
    LEAF_REFINE_DISTANCE_SCALE, LEAF_REFINE_DISTANCE_SCALE_MAX, LEAF_REFINE_DISTANCE_SCALE_MIN,
    TERRAIN_DETAIL_DISTANCE_DEFAULT_M, TERRAIN_TRIANGLE_BUDGET, TERRAIN_TRIANGLE_BUDGET_MAX,
    TERRAIN_TRIANGLE_BUDGET_MIN,
} from "../terrain/lod";
import { LANDUSE_BLEND_DEFAULT } from "../terrain/tones";

const STORAGE_KEY = 'retroflightsim.settings';

/** Spawn menu start modes (approach / runway / merge / carrier / highAlt / space). */
export type SpawnMode = 'approach' | 'runway' | 'headon' | 'carrier' | 'carrierBarricade' | 'carrierTakeoff' | 'highAlt' | 'space';

export interface AppSettings {
    techProfile: string;
    flightModel: string;
    keyboardLayout: KeyboardControlLayoutId;
    aiPilotModel: AiPilotModels;
    /** Realtime sun shadow map resolution (OFF disables shadows). */
    shadowQuality: ShadowQualities;
    /** How baked terrain cover turns into colour on screen. */
    terrainColour: TerrainColours;
    /** Flat per-facet colour, or smooth (Gouraud) interpolation across it. */
    terrainShading: TerrainShading;
    /**
     * Share of a land-use facet's colour taken from its land type's palette
     * tone rather than the sampled terrain colour, 0..1.
     */
    landuseBlend: number;
    /** Last aircraft (+ livery) id chosen in the spawn menu. */
    aircraftId: string;
    /** Last spawn mode used to start a flight. */
    spawnMode: SpawnMode;
    /** Local solar time of day in hours (0..24); drives sun, palette and shadows. */
    daytime: number;
    /**
     * Name of the baked terrain area to fly in, from the terrain manifest's
     * `areas` list. Empty means the area holding the authored scenery.
     *
     * Not validated against a fixed set the way the others are: what is baked
     * differs per clone, and the terrain manifest is the only authority. An
     * unknown name falls back to home when the world is built.
     */
    terrainArea: string;
    /**
     * Metres out to which terrain keeps full detail; past it the far field
     * coarsens faster. `null` is the top of the slider, meaning no falloff.
     *
     * Stored rather than derived because it is a frame-rate trade the player
     * makes for their own machine, and the frame-time governor cannot make it
     * for them: the governor coarsens *everything* when it backs off, which
     * costs the ground under the aircraft first.
     */
    terrainDetailDistanceM: number | null;
    /**
     * Multiplier on the distance at which leaf tiles, and with them the exact
     * land-use fills, replace their parent. 1 is no bias.
     */
    landuseReach: number;
    /** Hard ceiling on terrain triangles drawn per frame. */
    terrainTriangleBudget: number;
    /** Master audio volume level (0.0 to 1.0). */
    volume: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
    techProfile: TechProfiles.HD,
    flightModel: FlightModels.FM2,
    keyboardLayout: KeyboardControlLayoutId.ARROWS,
    aiPilotModel: AiPilotModels.CLASSIC,
    shadowQuality: ShadowQualities.LOW,
    terrainColour: TerrainColours.HYBRID,
    terrainShading: TerrainShading.FACETED,
    landuseBlend: LANDUSE_BLEND_DEFAULT,
    aircraftId: 'f22',
    spawnMode: 'headon',
    daytime: DEFAULT_SUN_HOURS,
    terrainArea: '',
    terrainDetailDistanceM: TERRAIN_DETAIL_DISTANCE_DEFAULT_M,
    landuseReach: LEAF_REFINE_DISTANCE_SCALE,
    terrainTriangleBudget: TERRAIN_TRIANGLE_BUDGET,
    volume: 0.7,
};

const TECH_PROFILES = new Set<string>(Object.values(TechProfiles));
const FLIGHT_MODELS = new Set<string>(Object.values(FlightModels));
const KEYBOARD_LAYOUTS = new Set<number>(Object.values(KeyboardControlLayoutId).filter(v => typeof v === 'number') as number[]);
const AI_PILOT_MODELS = new Set<string>(Object.values(AiPilotModels));
const SHADOW_QUALITIES = new Set<string>(Object.values(ShadowQualities));
const TERRAIN_COLOURS = new Set<string>(Object.values(TerrainColours));
const TERRAIN_SHADING_VALUES = new Set<string>(Object.values(TerrainShading));
const SPAWN_MODES = new Set<SpawnMode>([
    'approach', 'runway', 'headon', 'carrier', 'carrierBarricade', 'carrierTakeoff', 'highAlt', 'space',
]);

export function loadSettings(): AppSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return { ...DEFAULT_SETTINGS };
        }

        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        return {
            techProfile: isValidTechProfile(parsed.techProfile) ? parsed.techProfile : DEFAULT_SETTINGS.techProfile,
            flightModel: isValidFlightModel(parsed.flightModel) ? parsed.flightModel : DEFAULT_SETTINGS.flightModel,
            keyboardLayout: isValidKeyboardLayout(parsed.keyboardLayout) ? parsed.keyboardLayout : DEFAULT_SETTINGS.keyboardLayout,
            aiPilotModel: isValidAiPilotModel(parsed.aiPilotModel) ? parsed.aiPilotModel : DEFAULT_SETTINGS.aiPilotModel,
            shadowQuality: isValidShadowQuality(parsed.shadowQuality) ? parsed.shadowQuality : DEFAULT_SETTINGS.shadowQuality,
            terrainColour: isValidTerrainColour(parsed.terrainColour) ? parsed.terrainColour : DEFAULT_SETTINGS.terrainColour,
            terrainShading: isValidTerrainShading(parsed.terrainShading) ? parsed.terrainShading : DEFAULT_SETTINGS.terrainShading,
            landuseBlend: isValidLanduseBlend(parsed.landuseBlend) ? parsed.landuseBlend : DEFAULT_SETTINGS.landuseBlend,
            aircraftId: isValidAircraftId(parsed.aircraftId) ? parsed.aircraftId : DEFAULT_SETTINGS.aircraftId,
            spawnMode: isValidSpawnMode(parsed.spawnMode) ? parsed.spawnMode : DEFAULT_SETTINGS.spawnMode,
            daytime: isValidDaytime(parsed.daytime) ? parsed.daytime : DEFAULT_SETTINGS.daytime,
            terrainArea: typeof parsed.terrainArea === 'string'
                ? parsed.terrainArea : DEFAULT_SETTINGS.terrainArea,
            // null is the top of the slider and a real value, so it cannot be
            // told from "absent" by falsiness alone.
            terrainDetailDistanceM: parsed.terrainDetailDistanceM === null
                || typeof parsed.terrainDetailDistanceM === 'number'
                ? parsed.terrainDetailDistanceM
                : DEFAULT_SETTINGS.terrainDetailDistanceM,
            landuseReach: isValidLanduseReach(parsed.landuseReach) ? parsed.landuseReach : DEFAULT_SETTINGS.landuseReach,
            terrainTriangleBudget: isValidTriangleBudget(parsed.terrainTriangleBudget)
                ? parsed.terrainTriangleBudget : DEFAULT_SETTINGS.terrainTriangleBudget,
            volume: isValidVolume(parsed.volume) ? parsed.volume : DEFAULT_SETTINGS.volume,
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveSettings(settings: AppSettings): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // Ignore quota / private-mode failures; settings still apply for the session.
    }
}

export function updateSettings(partial: Partial<AppSettings>): AppSettings {
    const next = { ...loadSettings(), ...partial };
    saveSettings(next);
    return next;
}

function isValidTechProfile(value: unknown): value is string {
    return typeof value === 'string' && TECH_PROFILES.has(value);
}

function isValidFlightModel(value: unknown): value is string {
    return typeof value === 'string' && FLIGHT_MODELS.has(value);
}

function isValidKeyboardLayout(value: unknown): value is KeyboardControlLayoutId {
    return typeof value === 'number' && KEYBOARD_LAYOUTS.has(value);
}

function isValidAiPilotModel(value: unknown): value is AiPilotModels {
    return typeof value === 'string' && AI_PILOT_MODELS.has(value);
}

function isValidShadowQuality(value: unknown): value is ShadowQualities {
    return typeof value === 'string' && SHADOW_QUALITIES.has(value);
}

function isValidTerrainColour(value: unknown): value is TerrainColours {
    return typeof value === 'string' && TERRAIN_COLOURS.has(value);
}

function isValidTerrainShading(value: unknown): value is TerrainShading {
    return typeof value === 'string' && TERRAIN_SHADING_VALUES.has(value);
}

function isValidLanduseBlend(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isValidLanduseReach(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
        && value >= LEAF_REFINE_DISTANCE_SCALE_MIN && value <= LEAF_REFINE_DISTANCE_SCALE_MAX;
}

function isValidTriangleBudget(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
        && value >= TERRAIN_TRIANGLE_BUDGET_MIN && value <= TERRAIN_TRIANGLE_BUDGET_MAX;
}

function isValidAircraftId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length < 200;
}

function isValidSpawnMode(value: unknown): value is SpawnMode {
    return typeof value === 'string' && SPAWN_MODES.has(value as SpawnMode);
}

function isValidDaytime(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 24;
}

function isValidVolume(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

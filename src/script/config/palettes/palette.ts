
export enum PaletteCategory {
    HUD_TEXT = 'HUD_TEXT',
    HUD_TEXT_EFFECT = 'HUD_TEXT_EFFECT',
    HUD_TEXT_SECONDARY = 'HUD_TEXT_SECONDARY',
    HUD_TEXT_WARN = 'HUD_TEXT_WARN',

    COCKPIT_AI_SKY = 'COCKPIT_AI_SKY',
    COCKPIT_AI_GROUND = 'COCKPIT_AI_GROUND',
    COCKPIT_MFD_BACKGROUND = 'HUD_MFD_BACKGROUND',

    BACKGROUND = 'BACKGROUND',

    FOG_SKY = 'FOG_SKY',
    FOG_TERRAIN = 'FOG_TERRAIN',
    FOG_SPECKLE = 'FOG_SPEKLE',
    FOG_LIGHT = 'FOG_LIGHT',

    SKY = 'SKY',
    SKY_CLOUD = 'SKY_CLOUD',
    /**
     * The sun disc, and the dithered corona stepped around it - one colour for
     * both, because the corona is that same light scattered forward by the air
     * between the sun and the viewer.
     */
    SKY_SUN = 'SKY_SUN',

    TERRAIN_DEFAULT = 'TERRAIN_DEFAULT',
    TERRAIN_SAND = 'TERRAIN_SAND',
    TERRAIN_BARE = 'TERRAIN_BARE',
    TERRAIN_GRASS = 'TERRAIN_GRASS',
    TERRAIN_FOREST = 'TERRAIN_FOREST',
    TERRAIN_SCRUB = 'TERRAIN_SCRUB',
    TERRAIN_CROP = 'TERRAIN_CROP',
    TERRAIN_URBAN = 'TERRAIN_URBAN',
    TERRAIN_SNOW = 'TERRAIN_SNOW',
    TERRAIN_WETLAND = 'TERRAIN_WETLAND',
    TERRAIN_WATER = 'TERRAIN_WATER',
    TERRAIN_SHALLOW_WATER = 'TERRAIN_SHALLOW_WATER',
    SCENERY_MOUNTAIN_GRASS = 'SCENERY_MOUNTAIN_GRASS',
    SCENERY_MOUNTAIN_BARE = 'SCENERY_MOUNTAIN_BARE',

    LIGHT_RED = 'LIGHT_RED',
    LIGHT_GREEN = 'LIGHT_GREEN',
    LIGHT_YELLOW = 'LIGHT_YELLOW',

    SCENERY_SPECKLE = 'SCENERY_SPEKLE',

    GLASS = 'GLASS',

    VEHICLE_PLANE_GREY = 'VEHICLE_PLANE_GREY',
    VEHICLE_PLANE_NAVY = 'VEHICLE_PLANE_NAVY',
    VEHICLE_PLANE_INTAKE = 'VEHICLE_PLANE_INTAKE',
    VEHICLE_PLANE_ENGINE = 'VEHICLE_PLANE_ENGINE',
    VEHICLE_PLANE_INTERIOR = 'VEHICLE_PLANE_INTERIOR',

    SCENERY_ROAD_MAIN = 'SCENERY_ROAD_MAIN',
    SCENERY_ROAD_SECONDARY = 'SCENERY_ROAD_SECONDARY',

    SCENERY_FIELD_GREEN = 'SCENERY_FIELD_GREEN',
    SCENERY_FIELD_GREEN_LIGHT = 'SCENERY_FIELD_GREEN_LIGHT',
    SCENERY_FIELD_YELLOW = 'SCENERY_FIELD_YELLOW',
    SCENERY_FIELD_OCHRE = 'SCENERY_FIELD_OCHRE',
    SCENERY_FIELD_RED = 'SCENERY_FIELD_RED',

    SCENERY_TREE_FOLIAGE = 'SCENERY_TREE_FOLIAGE',
    SCENERY_TREE_TRUNK = 'SCENERY_TREE_TRUNK',
    SCENERY_TREE_SHADOW = 'SCENERY_TREE_SHADOW',
    SCENERY_WOOD_PATCH = 'SCENERY_WOOD_PATCH',

    SCENERY_BIOME_PINE_PATCH = 'SCENERY_BIOME_PINE_PATCH',
    SCENERY_BIOME_BUSH_PATCH = 'SCENERY_BIOME_BUSH_PATCH',
    SCENERY_BIOME_BIRCH_PATCH = 'SCENERY_BIOME_BIRCH_PATCH',
    SCENERY_BIOME_SCRUB_PATCH = 'SCENERY_BIOME_SCRUB_PATCH',
    SCENERY_BIOME_PINE_FOLIAGE = 'SCENERY_BIOME_PINE_FOLIAGE',
    SCENERY_BIOME_BUSH_FOLIAGE = 'SCENERY_BIOME_BUSH_FOLIAGE',
    SCENERY_BIOME_BIRCH_FOLIAGE = 'SCENERY_BIOME_BIRCH_FOLIAGE',
    SCENERY_BIOME_SCRUB_FOLIAGE = 'SCENERY_BIOME_SCRUB_FOLIAGE',

    SCENERY_BUILDING_PLASTER_WHITE = 'SCENERY_BUILDING_PLASTER_WHITE',
    SCENERY_BUILDING_PLASTER_RED = 'SCENERY_BUILDING_PLASTER_RED',
    SCENERY_BUILDING_PLASTER_TEAL = 'SCENERY_BUILDING_PLASTER_TEAL',
    SCENERY_BUILDING_CONCRETE = 'SCENERY_BUILDING_CONCRETE',
    SCENERY_BUILDING_METAL = 'SCENERY_BUILDING_METAL',
    SCENERY_BUILDING_METAL_WHITE = 'SCENERY_BUILDING_METAL_WHITE',
    SCENERY_BUILDING_METAL_RED = 'SCENERY_BUILDING_METAL_RED',

    SCENERY_BASE_RUNWAY_LINES = 'SCENERY_BASE_RUNWAY_LINES',
    SCENERY_BASE_RUNWAY_THRESHOLD = 'SCENERY_BASE_RUNWAY_THRESHOLD',
    /**
     * Concrete slab pavement, as against the asphalt of
     * {@link SCENERY_ROAD_SECONDARY}.
     *
     * A military field laid in concrete plates is markedly paler than an
     * asphalt civil one, and from the air that difference is most of what
     * tells the two apart. OSM records which it is, so the sim can too.
     */
    SCENERY_BASE_CONCRETE = 'SCENERY_BASE_CONCRETE',

    FX_FIRE = 'FX_FIRE',
    FX_FIRE__B = 'FX_FIRE__B',

    FX_SMOKE = 'FX_SMOKE',
    FX_SMOKE__B = 'FX_SMOKE__B',
    FX_SMOKE__C = 'FX_SMOKE__C',
}

export const PALETTE_FX_PREFIX: string = 'FX';
/** Airframe skins (VEHICLE_PLANE_*). */
export const PALETTE_VEHICLE_PREFIX: string = 'VEHICLE';

export enum PaletteTime {
    DAY = 'day',
    NIGHT = 'night'
};

export type PaletteColors = Record<PaletteCategory, string | [string, string]>;

export type PaletteValues = {
    [PaletteCategory.FOG_SKY]: number;
    [PaletteCategory.FOG_TERRAIN]: number;
    [PaletteCategory.FOG_SPECKLE]: number;
    [PaletteCategory.FOG_LIGHT]: number;
};


export interface Palette {
    colors: PaletteColors;
    values: PaletteValues;
    time: PaletteTime;
    /**
     * Linear-light factor for colours this palette does not own.
     *
     * A raw-colour material - a mod's own `#rrggbb` material name, or the
     * canopy glass - opts out of the authored palettes, so the day-to-night
     * blend never reaches it and it would sit at noon brightness against a
     * midnight landscape. It stands in the same light as everything else
     * though, so it takes this instead: what the palette's own lit surfaces
     * were multiplied by to get where they are.
     *
     * Only blended palettes carry it. On an authored one it is absent, which
     * means neutral - the noon palette is noon, with nothing to apply.
     */
    light?: readonly [number, number, number];
}

export type PaletteFogCategories = PaletteCategory.FOG_SKY | PaletteCategory.FOG_TERRAIN | PaletteCategory.FOG_SPECKLE | PaletteCategory.FOG_LIGHT;

const FogColorCategoryMap: Map<PaletteCategory, PaletteFogCategories> = new Map([
    [PaletteCategory.SKY, PaletteCategory.FOG_SKY],
    [PaletteCategory.SCENERY_SPECKLE, PaletteCategory.FOG_SPECKLE],
    [PaletteCategory.LIGHT_RED, PaletteCategory.FOG_LIGHT],
    [PaletteCategory.LIGHT_GREEN, PaletteCategory.FOG_LIGHT],
    [PaletteCategory.LIGHT_YELLOW, PaletteCategory.FOG_LIGHT],
    [PaletteCategory.FX_FIRE, PaletteCategory.FOG_LIGHT],
]);

const FogValueCategoryMap: Map<PaletteCategory, PaletteFogCategories> = new Map([
    [PaletteCategory.SKY, PaletteCategory.FOG_SKY],
    [PaletteCategory.SCENERY_SPECKLE, PaletteCategory.FOG_SPECKLE],
    [PaletteCategory.LIGHT_RED, PaletteCategory.FOG_LIGHT],
    [PaletteCategory.LIGHT_GREEN, PaletteCategory.FOG_LIGHT],
    [PaletteCategory.LIGHT_YELLOW, PaletteCategory.FOG_LIGHT],
    [PaletteCategory.FX_FIRE, PaletteCategory.FOG_LIGHT],
    // Ocean keeps reading farther than land fog would allow.
    [PaletteCategory.TERRAIN_WATER, PaletteCategory.FOG_LIGHT],
    [PaletteCategory.TERRAIN_SHALLOW_WATER, PaletteCategory.FOG_LIGHT],
]);

export function FogColorCategory(cat: PaletteCategory): PaletteFogCategories {
    return FogColorCategoryMap.get(cat) || PaletteCategory.FOG_TERRAIN;
}

export function FogValueCategory(cat: PaletteCategory): PaletteFogCategories {
    return FogValueCategoryMap.get(cat) || PaletteCategory.FOG_TERRAIN;
}

export function PaletteColor(p: Palette, c: PaletteCategory): string {
    const v = p.colors[c];
    return typeof v === 'string' ? v : v[0];
}

export function PaletteColorShade(p: Palette, c: PaletteCategory): string {
    const v = p.colors[c];
    return typeof v === 'string' ? v : v[1];
}

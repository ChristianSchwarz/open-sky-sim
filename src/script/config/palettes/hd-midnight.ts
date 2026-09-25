import { Palette, PaletteCategory, PaletteColors, PaletteTime, PaletteValues } from "./palette";

const colors: PaletteColors = {
    [PaletteCategory.HUD_TEXT]: '#66FF66',
    [PaletteCategory.HUD_TEXT_EFFECT]: '#000000',
    [PaletteCategory.HUD_TEXT_SECONDARY]: '#66FF66',
    [PaletteCategory.HUD_TEXT_WARN]: '#FF3333',

    [PaletteCategory.COCKPIT_AI_SKY]: '#6fd4ff',
    [PaletteCategory.COCKPIT_AI_GROUND]: '#c48f7a',
    [PaletteCategory.COCKPIT_MFD_BACKGROUND]: '#2a4f28',

    [PaletteCategory.BACKGROUND]: '#0a3540',

    [PaletteCategory.FOG_SKY]: '#0a3540',
    [PaletteCategory.FOG_TERRAIN]: '#000000',
    [PaletteCategory.FOG_SPECKLE]: '#000000',
    [PaletteCategory.FOG_LIGHT]: '#ffffff',

    [PaletteCategory.SKY]: '#182028',
    [PaletteCategory.SKY_CLOUD]: ['#333c48', '#181e24'],
    [PaletteCategory.SKY_SUN]: '#3a2410',

    [PaletteCategory.TERRAIN_DEFAULT]: '#182018',
    [PaletteCategory.TERRAIN_SAND]: '#2a2620',
    [PaletteCategory.TERRAIN_GRASS]: '#182018',
    [PaletteCategory.TERRAIN_BARE]: '#1e1814',
    [PaletteCategory.TERRAIN_FOREST]: '#12201a',
    [PaletteCategory.TERRAIN_SCRUB]: '#1e2218',
    [PaletteCategory.TERRAIN_CROP]: '#222616',
    [PaletteCategory.TERRAIN_URBAN]: '#20201e',
    [PaletteCategory.TERRAIN_SNOW]: '#3a4048',
    [PaletteCategory.TERRAIN_WETLAND]: '#16241e',
    [PaletteCategory.TERRAIN_WATER]: '#182028',
    [PaletteCategory.TERRAIN_SHALLOW_WATER]: '#1a2228',
    [PaletteCategory.SCENERY_MOUNTAIN_GRASS]: ['#0f1310', '#182018'],
    [PaletteCategory.SCENERY_MOUNTAIN_BARE]: ['#0f1310', '#182018'],

    [PaletteCategory.LIGHT_RED]: '#FF2222',
    [PaletteCategory.LIGHT_GREEN]: '#22FF22',
    [PaletteCategory.LIGHT_YELLOW]: '#FFFF88',

    [PaletteCategory.GLASS]: '#0a3540',

    [PaletteCategory.VEHICLE_PLANE_GREY]: '#222222',
    [PaletteCategory.VEHICLE_PLANE_NAVY]: '#242428',
    [PaletteCategory.VEHICLE_PLANE_INTAKE]: '#141414',
    [PaletteCategory.VEHICLE_PLANE_ENGINE]: '#141414',
    [PaletteCategory.VEHICLE_PLANE_INTERIOR]: '#080808',

    [PaletteCategory.SCENERY_SPECKLE]: '#606060',

    [PaletteCategory.SCENERY_ROAD_MAIN]: '#181818',
    [PaletteCategory.SCENERY_ROAD_SECONDARY]: '#202020',

    [PaletteCategory.SCENERY_FIELD_GREEN]: '#2a4830',
    [PaletteCategory.SCENERY_FIELD_GREEN_LIGHT]: '#182820',
    [PaletteCategory.SCENERY_FIELD_YELLOW]: '#302810',
    [PaletteCategory.SCENERY_FIELD_OCHRE]: '#302018',
    [PaletteCategory.SCENERY_FIELD_RED]: '#281818',

    [PaletteCategory.SCENERY_TREE_FOLIAGE]: ['#2a4830', '#3d6448'],
    [PaletteCategory.SCENERY_TREE_SHADOW]: ['#000000', '#1a1a1a'],
    [PaletteCategory.SCENERY_TREE_TRUNK]: '#3d2818',
    [PaletteCategory.SCENERY_WOOD_PATCH]: ['#182820', '#2a4830'],
    [PaletteCategory.SCENERY_BIOME_PINE_PATCH]: ['#101810', '#182820'],
    [PaletteCategory.SCENERY_BIOME_BUSH_PATCH]: ['#182018', '#243028'],
    [PaletteCategory.SCENERY_BIOME_BIRCH_PATCH]: ['#142018', '#203028'],
    [PaletteCategory.SCENERY_BIOME_SCRUB_PATCH]: ['#201810', '#302820'],
    [PaletteCategory.SCENERY_BIOME_PINE_FOLIAGE]: ['#142018', '#243028'],
    [PaletteCategory.SCENERY_BIOME_BUSH_FOLIAGE]: ['#203018', '#304028'],
    [PaletteCategory.SCENERY_BIOME_SCRUB_FOLIAGE]: ['#302818', '#403830'],
    [PaletteCategory.SCENERY_BIOME_BIRCH_FOLIAGE]: ['#203a2a', '#365e42'],

    [PaletteCategory.SCENERY_BUILDING_PLASTER_WHITE]: '#404040',
    [PaletteCategory.SCENERY_BUILDING_PLASTER_RED]: '#381818',
    [PaletteCategory.SCENERY_BUILDING_PLASTER_TEAL]: '#143838',
    [PaletteCategory.SCENERY_BUILDING_CONCRETE]: '#404040',
    [PaletteCategory.SCENERY_BUILDING_METAL]: '#282828',
    [PaletteCategory.SCENERY_BUILDING_METAL_WHITE]: '#484848',
    [PaletteCategory.SCENERY_BUILDING_METAL_RED]: '#481010',

    [PaletteCategory.SCENERY_BASE_RUNWAY_LINES]: '#d0d0d0',
    [PaletteCategory.SCENERY_BASE_RUNWAY_THRESHOLD]: '#484848',
    [PaletteCategory.SCENERY_BASE_CONCRETE]: '#363636',

    [PaletteCategory.FX_FIRE]: '#ff9922',
    [PaletteCategory.FX_FIRE__B]: '#ffff22',

    [PaletteCategory.FX_SMOKE]: '#787878',
    [PaletteCategory.FX_SMOKE__B]: '#484848',
    [PaletteCategory.FX_SMOKE__C]: '#383838',
};

const values: PaletteValues = {
    [PaletteCategory.FOG_SKY]: 0.003,
    [PaletteCategory.FOG_TERRAIN]: 0.00002,
    [PaletteCategory.FOG_LIGHT]: 0.0,
    [PaletteCategory.FOG_SPECKLE]: 0.003
};

export const HDMidnightPalette: Palette = {
    colors: colors,
    values: values,
    time: PaletteTime.NIGHT
};

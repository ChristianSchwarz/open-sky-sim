import { Palette, PaletteCategory, PaletteColors, PaletteTime, PaletteValues } from "./palette";

const colors: PaletteColors = {
    [PaletteCategory.HUD_TEXT]: '#66FF66',
    [PaletteCategory.HUD_TEXT_EFFECT]: '#000000',
    [PaletteCategory.HUD_TEXT_SECONDARY]: '#66FF66',
    [PaletteCategory.HUD_TEXT_WARN]: '#FF3333',

    [PaletteCategory.COCKPIT_AI_SKY]: '#6fd4ff',
    [PaletteCategory.COCKPIT_AI_GROUND]: '#c48f7a',
    [PaletteCategory.COCKPIT_MFD_BACKGROUND]: '#2a4f28',

    [PaletteCategory.BACKGROUND]: '#c8e4f8',

    [PaletteCategory.FOG_SKY]: '#c8e4f8',
    [PaletteCategory.FOG_TERRAIN]: '#c8e4f8',
    [PaletteCategory.FOG_SPECKLE]: '#FFFFFF',
    [PaletteCategory.FOG_LIGHT]: '#c8e4f8',

    [PaletteCategory.SKY]: '#7aa3c4',
    [PaletteCategory.SKY_CLOUD]: ['#ffffff', '#d0dce6'],
    [PaletteCategory.SKY_SUN]: '#fff4d8',

    [PaletteCategory.TERRAIN_DEFAULT]: '#4a7a52',
    [PaletteCategory.TERRAIN_SAND]: '#b09a63',
    [PaletteCategory.TERRAIN_GRASS]: '#4a7a52',
    [PaletteCategory.TERRAIN_BARE]: '#7d5f45',
    [PaletteCategory.TERRAIN_FOREST]: '#2f6b3c',
    [PaletteCategory.TERRAIN_SCRUB]: '#6a7742',
    [PaletteCategory.TERRAIN_CROP]: '#7f8f3c',
    [PaletteCategory.TERRAIN_URBAN]: '#7d7a76',
    [PaletteCategory.TERRAIN_SNOW]: '#d8dde2',
    [PaletteCategory.TERRAIN_WETLAND]: '#3f7357',
    [PaletteCategory.TERRAIN_WATER]: '#16355e',
    [PaletteCategory.TERRAIN_SHALLOW_WATER]: '#153c6a',
    [PaletteCategory.SCENERY_MOUNTAIN_GRASS]: ['#24401f', '#4a7a52'],
    [PaletteCategory.SCENERY_MOUNTAIN_BARE]: ['#24401f', '#4a7a52'],

    [PaletteCategory.LIGHT_RED]: '#FF2222',
    [PaletteCategory.LIGHT_GREEN]: '#22FF22',
    [PaletteCategory.LIGHT_YELLOW]: '#FFFF88',

    [PaletteCategory.GLASS]: '#7aa3c4',

    [PaletteCategory.VEHICLE_PLANE_GREY]: '#909094',
    [PaletteCategory.VEHICLE_PLANE_NAVY]: '#7d8790',
    [PaletteCategory.VEHICLE_PLANE_INTAKE]: '#646568',
    [PaletteCategory.VEHICLE_PLANE_ENGINE]: '#56535a',
    [PaletteCategory.VEHICLE_PLANE_INTERIOR]: '#282828',

    [PaletteCategory.SCENERY_SPECKLE]: '#808080',

    [PaletteCategory.SCENERY_ROAD_MAIN]: '#555555',
    [PaletteCategory.SCENERY_ROAD_SECONDARY]: '#5d5d5d',

    [PaletteCategory.SCENERY_FIELD_GREEN]: '#3d523f',
    [PaletteCategory.SCENERY_FIELD_GREEN_LIGHT]: '#569862',
    [PaletteCategory.SCENERY_FIELD_YELLOW]: '#e8c858',
    [PaletteCategory.SCENERY_FIELD_OCHRE]: '#b88f52',
    [PaletteCategory.SCENERY_FIELD_RED]: '#bf7868',

    [PaletteCategory.SCENERY_TREE_FOLIAGE]: ['#569862', '#72b478'],
    [PaletteCategory.SCENERY_TREE_SHADOW]: ['#000000', '#2a2a2a'],
    [PaletteCategory.SCENERY_TREE_TRUNK]: '#6b4423',
    [PaletteCategory.SCENERY_WOOD_PATCH]: ['#3d523f', '#569862'],
    [PaletteCategory.SCENERY_BIOME_PINE_PATCH]: ['#1a3d28', '#2d5a3a'],
    [PaletteCategory.SCENERY_BIOME_BUSH_PATCH]: ['#3d5228', '#5a7a38'],
    [PaletteCategory.SCENERY_BIOME_BIRCH_PATCH]: ['#2a4530', '#4a8050'],
    [PaletteCategory.SCENERY_BIOME_SCRUB_PATCH]: ['#4a4030', '#6a5838'],
    [PaletteCategory.SCENERY_BIOME_PINE_FOLIAGE]: ['#1e4a30', '#3d6a48'],
    [PaletteCategory.SCENERY_BIOME_BUSH_FOLIAGE]: ['#4a6a28', '#6a9040'],
    [PaletteCategory.SCENERY_BIOME_SCRUB_FOLIAGE]: ['#6a5830', '#8a7848'],
    [PaletteCategory.SCENERY_BIOME_BIRCH_FOLIAGE]: ['#4a7a44', '#72b478'],

    [PaletteCategory.SCENERY_BUILDING_PLASTER_WHITE]: '#e8e8e8',
    [PaletteCategory.SCENERY_BUILDING_PLASTER_RED]: '#ef7070',
    [PaletteCategory.SCENERY_BUILDING_PLASTER_TEAL]: '#42bbbb',
    [PaletteCategory.SCENERY_BUILDING_CONCRETE]: '#a8a8a8',
    [PaletteCategory.SCENERY_BUILDING_METAL]: '#cccccc',
    [PaletteCategory.SCENERY_BUILDING_METAL_WHITE]: '#e8e8e8',
    [PaletteCategory.SCENERY_BUILDING_METAL_RED]: '#e04040',

    [PaletteCategory.SCENERY_BASE_RUNWAY_LINES]: '#d0d0d0',
    [PaletteCategory.SCENERY_BASE_RUNWAY_THRESHOLD]: '#d0d0d0',
    [PaletteCategory.SCENERY_BASE_CONCRETE]: '#8a8a8a',

    [PaletteCategory.FX_FIRE]: '#ff9922',
    [PaletteCategory.FX_FIRE__B]: '#ffff22',

    [PaletteCategory.FX_SMOKE]: '#383838',
    [PaletteCategory.FX_SMOKE__B]: '#484848',
    [PaletteCategory.FX_SMOKE__C]: '#787878',
};

const values: PaletteValues = {
    [PaletteCategory.FOG_SKY]: 0.003,
    [PaletteCategory.FOG_TERRAIN]: 0.000005,
    [PaletteCategory.FOG_LIGHT]: 0.000004,
    [PaletteCategory.FOG_SPECKLE]: 0.0005
};

export const HDNoonPalette: Palette = {
    colors: colors,
    values: values,
    time: PaletteTime.DAY
};

import { Palette, PaletteCategory, PaletteColors, PaletteTime, PaletteValues } from "./palette";

const colors: PaletteColors = {
    [PaletteCategory.HUD_TEXT]: '#66FF66',
    [PaletteCategory.HUD_TEXT_EFFECT]: '#000000',
    [PaletteCategory.HUD_TEXT_SECONDARY]: '#66FF66',
    [PaletteCategory.HUD_TEXT_WARN]: '#FF3333',

    [PaletteCategory.COCKPIT_AI_SKY]: '#6fd4ff',
    [PaletteCategory.COCKPIT_AI_GROUND]: '#c48f7a',
    [PaletteCategory.COCKPIT_MFD_BACKGROUND]: '#2a4f28',

    [PaletteCategory.BACKGROUND]: '#011014',

    [PaletteCategory.FOG_SKY]: '#011014',
    [PaletteCategory.FOG_TERRAIN]: '#000000',
    [PaletteCategory.FOG_SPECKLE]: '#000000',
    [PaletteCategory.FOG_LIGHT]: '#ffffff',

    [PaletteCategory.SKY]: '#04060a',
    [PaletteCategory.SKY_CLOUD]: ['#0e1318', '#040608'],
    [PaletteCategory.SKY_SUN]: '#120802',

    [PaletteCategory.TERRAIN_DEFAULT]: '#040604',
    [PaletteCategory.TERRAIN_SAND]: '#0b0906',
    [PaletteCategory.TERRAIN_GRASS]: '#040604',
    [PaletteCategory.TERRAIN_BARE]: '#060403',
    [PaletteCategory.TERRAIN_FOREST]: '#030605',
    [PaletteCategory.TERRAIN_SCRUB]: '#060804',
    [PaletteCategory.TERRAIN_CROP]: '#080904',
    [PaletteCategory.TERRAIN_URBAN]: '#060606',
    [PaletteCategory.TERRAIN_SNOW]: '#121418',
    [PaletteCategory.TERRAIN_WETLAND]: '#040806',
    [PaletteCategory.TERRAIN_HEATH]: '#060506',
    [PaletteCategory.TERRAIN_TUNDRA]: '#080806',
    [PaletteCategory.TERRAIN_WATER]: '#04060a',
    [PaletteCategory.TERRAIN_SHALLOW_WATER]: '#05080a',
    [PaletteCategory.SCENERY_MOUNTAIN_GRASS]: ['#020302', '#040604'],
    [PaletteCategory.SCENERY_MOUNTAIN_BARE]: ['#020302', '#040604'],

    [PaletteCategory.LIGHT_RED]: '#FF2222',
    [PaletteCategory.LIGHT_GREEN]: '#22FF22',
    [PaletteCategory.LIGHT_YELLOW]: '#FFFF88',
    [PaletteCategory.LIGHT_WHITE]: '#FFF6E0',
    [PaletteCategory.LIGHT_BLUE]: '#3A6BFF',

    [PaletteCategory.GLASS]: '#011014',

    [PaletteCategory.VEHICLE_PLANE_GREY]: '#080808',
    [PaletteCategory.VEHICLE_PLANE_NAVY]: '#08080a',
    [PaletteCategory.VEHICLE_PLANE_INTAKE]: '#030303',
    [PaletteCategory.VEHICLE_PLANE_ENGINE]: '#030303',
    [PaletteCategory.VEHICLE_PLANE_INTERIOR]: '#010101',

    [PaletteCategory.SCENERY_SPECKLE]: '#222222',

    [PaletteCategory.SCENERY_ROAD_MAIN]: '#040404',
    [PaletteCategory.SCENERY_ROAD_SECONDARY]: '#060606',
    [PaletteCategory.SCENERY_RAIL]: '#030302',

    [PaletteCategory.SCENERY_FIELD_GREEN]: '#0b180d',
    [PaletteCategory.SCENERY_FIELD_GREEN_LIGHT]: '#040a06',
    [PaletteCategory.SCENERY_FIELD_YELLOW]: '#0d0a02',
    [PaletteCategory.SCENERY_FIELD_OCHRE]: '#0d0604',
    [PaletteCategory.SCENERY_FIELD_RED]: '#0a0404',

    [PaletteCategory.SCENERY_TREE_FOLIAGE]: ['#0b180d', '#132418'],
    [PaletteCategory.SCENERY_TREE_SHADOW]: ['#000000', '#050505'],
    [PaletteCategory.SCENERY_TREE_TRUNK]: '#130a04',
    [PaletteCategory.SCENERY_WOOD_PATCH]: ['#040a06', '#0b180d'],
    [PaletteCategory.SCENERY_BIOME_PINE_PATCH]: ['#020402', '#040a06'],
    [PaletteCategory.SCENERY_BIOME_BUSH_PATCH]: ['#040604', '#080d0a'],
    [PaletteCategory.SCENERY_BIOME_BIRCH_PATCH]: ['#030604', '#060d0a'],
    [PaletteCategory.SCENERY_BIOME_SCRUB_PATCH]: ['#060402', '#0d0a06'],
    [PaletteCategory.SCENERY_BIOME_PINE_FOLIAGE]: ['#030604', '#080d0a'],
    [PaletteCategory.SCENERY_BIOME_BUSH_FOLIAGE]: ['#060d04', '#0d140a'],
    [PaletteCategory.SCENERY_BIOME_SCRUB_FOLIAGE]: ['#0d0a04', '#14110d'],
    [PaletteCategory.SCENERY_BIOME_BIRCH_FOLIAGE]: ['#06120b', '#102216'],

    [PaletteCategory.SCENERY_BUILDING_PLASTER_WHITE]: '#141414',
    [PaletteCategory.SCENERY_BUILDING_PLASTER_RED]: '#110404',
    [PaletteCategory.SCENERY_BUILDING_PLASTER_TEAL]: '#031111',
    [PaletteCategory.SCENERY_BUILDING_CONCRETE]: '#141414',
    [PaletteCategory.SCENERY_BUILDING_METAL]: '#0a0a0a',
    [PaletteCategory.SCENERY_BUILDING_METAL_WHITE]: '#181818',
    [PaletteCategory.SCENERY_BUILDING_METAL_RED]: '#180202',
    [PaletteCategory.SCENERY_WALL_PLASTER]: '#141311',
    [PaletteCategory.SCENERY_WALL_BRICK]: '#0d0604',
    [PaletteCategory.SCENERY_WALL_WOOD]: '#090603',
    [PaletteCategory.SCENERY_ROOF_TILE_RED]: '#0f0503',
    [PaletteCategory.SCENERY_ROOF_TILE_BROWN]: '#090403',
    [PaletteCategory.SCENERY_ROOF_SLATE]: '#040506',
    [PaletteCategory.SCENERY_ROOF_GREY]: '#0c0c0b',
    [PaletteCategory.SCENERY_ROOF_METAL]: '#0e1011',
    [PaletteCategory.SCENERY_ROOF_COPPER]: '#060d0a',
    [PaletteCategory.SCENERY_ROOF_GLASS]: '#101414',
    [PaletteCategory.SCENERY_ROOF_WHITE]: '#141414',

    // Paint is not lit: every marking is as dark as the runway number and
    // threshold stripes; the airfield lights do the showing.
    [PaletteCategory.SCENERY_BASE_RUNWAY_LINES]: '#181818',
    [PaletteCategory.SCENERY_BASE_RUNWAY_THRESHOLD]: '#181818',
    [PaletteCategory.SCENERY_BASE_CONCRETE]: '#0f0e0b',
    [PaletteCategory.SCENERY_BASE_DECK_RUST]: '#0b0503',

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

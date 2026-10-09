/**
 * The palette colours buildings are drawn in, as one table: the bake stores
 * an index into it per roof and per wall (PBH1), and the runtime hands the
 * table to its one material (`vertexTones`), so every building of a tile is
 * one draw whatever its colours, and still follows time of day and night
 * vision like any other palette colour.
 *
 * Append only: the indices are baked into the sidecars.
 */

import { PaletteCategory } from '../config/palettes/palette';
import { HDNoonPalette } from '../config/palettes/hd-noon';

export const enum BuildingTone {
    WallPlaster = 0,
    WallBrick = 1,
    WallWood = 2,
    WallConcrete = 3,
    WallMetal = 4,
    RoofTileRed = 5,
    RoofTileBrown = 6,
    RoofSlate = 7,
    RoofGrey = 8,
    RoofMetal = 9,
    RoofCopper = 10,
    RoofGlass = 11,
    RoofWhite = 12,
}

export const BUILDING_TONES: readonly PaletteCategory[] = [
    PaletteCategory.SCENERY_WALL_PLASTER,
    PaletteCategory.SCENERY_WALL_BRICK,
    PaletteCategory.SCENERY_WALL_WOOD,
    PaletteCategory.SCENERY_BUILDING_CONCRETE,
    PaletteCategory.SCENERY_BUILDING_METAL,
    PaletteCategory.SCENERY_ROOF_TILE_RED,
    PaletteCategory.SCENERY_ROOF_TILE_BROWN,
    PaletteCategory.SCENERY_ROOF_SLATE,
    PaletteCategory.SCENERY_ROOF_GREY,
    PaletteCategory.SCENERY_ROOF_METAL,
    PaletteCategory.SCENERY_ROOF_COPPER,
    PaletteCategory.SCENERY_ROOF_GLASS,
    PaletteCategory.SCENERY_ROOF_WHITE,
];

export const ROOF_TONES: readonly BuildingTone[] = [
    BuildingTone.RoofTileRed, BuildingTone.RoofTileBrown, BuildingTone.RoofSlate, BuildingTone.RoofGrey,
    BuildingTone.RoofMetal, BuildingTone.RoofCopper, BuildingTone.RoofGlass, BuildingTone.RoofWhite,
];

export const WALL_TONES: readonly BuildingTone[] = [
    BuildingTone.WallPlaster, BuildingTone.WallBrick, BuildingTone.WallWood, BuildingTone.WallConcrete,
    BuildingTone.WallMetal, BuildingTone.RoofWhite,
];

/** A tone's noon-palette colour as 0-255 sRGB. */
export function noonRgb(tone: BuildingTone): [number, number, number] {
    const value = HDNoonPalette.colors[BUILDING_TONES[tone]];
    const hex = (Array.isArray(value) ? value[0] : value) as string;
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The tone among `candidates` whose noon colour is nearest to 0xRRGGBB, by a
 * weighted RGB distance (the "redmean" approximation of perceived difference).
 */
export function nearestTone(rgb: number, candidates: readonly BuildingTone[]): BuildingTone {
    const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
    let best = candidates[0];
    let bestD = Infinity;
    for (const tone of candidates) {
        const [tr, tg, tb] = noonRgb(tone);
        const rm = (r + tr) / 2;
        const d = (2 + rm / 256) * (r - tr) ** 2 + 4 * (g - tg) ** 2 + (2 + (255 - rm) / 256) * (b - tb) ** 2;
        if (d < bestD) {
            bestD = d;
            best = tone;
        }
    }
    return best;
}

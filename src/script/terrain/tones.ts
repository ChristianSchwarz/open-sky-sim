/**
 * The two vocabularies a baked terrain triangle carries: what it *is*
 * (TerrainClass, observed) and how it is *painted* (TerrainTone, authored).
 *
 * TerrainClass is baked into every land vertex from a real landcover raster;
 * TerrainTone is what a palette has an opinion about. The map between them is
 * CLASS_TO_TONE, and the runtime uploads it as a uniform so the shader can
 * resolve a class to a palette colour without a second attribute.
 */

/**
 * Palette tones a terrain triangle can carry.
 *
 * The numbering is load-bearing for water: tones 0 and 1 are draw-group indices
 * into the material array, so they must stay first and may not be reordered
 * without a re-bake. Land tones 2.. are only palette slots — land is a single
 * draw group whose colour is resolved per vertex in the shader.
 */
export const enum TerrainTone {
    Water = 0,
    ShallowWater = 1,
    Sand = 2,
    Grass = 3,
    Bare = 4,
    Forest = 5,
    Scrub = 6,
    Crop = 7,
    Urban = 8,
    Snow = 9,
    Wetland = 10,
}

export const TONE_COUNT = 11;

/** The first land tone. Land tone `t` is `uToneColor[t - LAND_TONE_BASE]`. */
export const LAND_TONE_BASE = TerrainTone.Sand;
export const LAND_TONE_COUNT = TONE_COUNT - LAND_TONE_BASE;

/**
 * Observed landcover, compacted from ESA WorldCover's sparse 10..100 codes into
 * a dense 0..15 range.
 *
 * Four bits is deliberate: the class travels in one byte alongside nothing
 * else today, but keeping it nibble-sized leaves room to pack a swatch index
 * into the high nibble if the mesh stream ever needs the space back.
 */
export const enum TerrainClass {
    /** No cover data for this facet. Painted as grass, like the old bake. */
    Unknown = 0,
    Tree = 1,
    Shrub = 2,
    Grass = 3,
    Crop = 4,
    Built = 5,
    Bare = 6,
    Snow = 7,
    /**
     * Permanent inland water per the landcover raster. The OSM coast vector is
     * authoritative about land vs water, so a *land* facet carrying this class
     * is a disagreement, and it is painted as grass rather than sea.
     */
    Water = 8,
    Wetland = 9,
    Mangrove = 10,
    Moss = 11,
    /** Bare ground close enough to the shore to read as beach. Bake-assigned. */
    Sand = 12,
    /**
     * Land no OSM landuse polygon claims, on a tile that has landuse. Its
     * baked colour is a ~25 km² regional mean blended between neighbouring
     * cells (tools/bake/groundColor.ts), and the shader paints that colour
     * directly rather than a palette tone. Distinct from Unknown, whose colour
     * is a placeholder grey wherever there is no cover data.
     */
    Ground = 13,
}

export const CLASS_COUNT = 16;

/**
 * Default share of a land-use facet's colour that comes from its land type's
 * palette tone, against the terrain colour sampled from imagery (0..1). Half
 * and half keeps a field recognisably a field while still sitting in the
 * colours of the ground around it. The player picks it in the settings.
 */
export const LANDUSE_BLEND_DEFAULT = 0.5;

/** A stored or typed blend, forced into 0..1; anything unusable is the default. */
export function clampLanduseBlend(value: number): number {
    if (!Number.isFinite(value)) {
        return LANDUSE_BLEND_DEFAULT;
    }
    return Math.min(1, Math.max(0, value));
}

/** ESA WorldCover v200 map codes -> TerrainClass. */
export const WORLDCOVER_TO_CLASS: Readonly<Record<number, TerrainClass>> = {
    10: TerrainClass.Tree,
    20: TerrainClass.Shrub,
    30: TerrainClass.Grass,
    40: TerrainClass.Crop,
    50: TerrainClass.Built,
    60: TerrainClass.Bare,
    70: TerrainClass.Snow,
    80: TerrainClass.Water,
    90: TerrainClass.Wetland,
    95: TerrainClass.Mangrove,
    100: TerrainClass.Moss,
};

/**
 * Palette tone for each class, uploaded to the shader as a uniform.
 *
 * Length is CLASS_COUNT, not the number of classes actually in use: the
 * attribute is a raw nibble out of a baked file, so every value it can hold
 * needs an entry rather than an out-of-range read.
 */
export const CLASS_TO_TONE: ReadonlyArray<TerrainTone> = (() => {
    const t = new Array<TerrainTone>(CLASS_COUNT).fill(TerrainTone.Grass);
    t[TerrainClass.Unknown] = TerrainTone.Grass;
    t[TerrainClass.Tree] = TerrainTone.Forest;
    t[TerrainClass.Shrub] = TerrainTone.Scrub;
    t[TerrainClass.Grass] = TerrainTone.Grass;
    t[TerrainClass.Crop] = TerrainTone.Crop;
    t[TerrainClass.Built] = TerrainTone.Urban;
    t[TerrainClass.Bare] = TerrainTone.Bare;
    t[TerrainClass.Snow] = TerrainTone.Snow;
    t[TerrainClass.Water] = TerrainTone.Grass;
    t[TerrainClass.Wetland] = TerrainTone.Wetland;
    t[TerrainClass.Mangrove] = TerrainTone.Wetland;
    t[TerrainClass.Moss] = TerrainTone.Bare;
    t[TerrainClass.Sand] = TerrainTone.Sand;
    return t;
})();

/**
 * How a facet's two baked observations become a colour.
 *
 * These numbers go straight into uTerrainMode and the terrain vertex program
 * branches on them, so they live here - the one module both the shader and the
 * settings enum can import - rather than being written out twice.
 */
export const enum TerrainColourMode {
    /** Landcover class picks a palette tone. */
    Landcover = 0,
    /** Satellite colour, snapped to the bake's swatch table. */
    Swatch = 1,
    /** Palette tone for the hue, satellite luminance for a banded shade. */
    Hybrid = 2,
    /** The satellite colour itself. */
    Imagery = 3,
}

/** Water is drawn unshaded with shared vertices; land is flat-shaded per facet. */
export function isWaterTone(tone: number): boolean {
    return tone === TerrainTone.Water || tone === TerrainTone.ShallowWater;
}

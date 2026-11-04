/**
 * The player's view ranges, in kilometres.
 *
 * Three bands share one slider, nearest first: the far cover textures take
 * over from the facets at `textureFromKm` (the 512-texel ones of the finer
 * tiles), the ground past `coarseTextureFromKm` is drawn by the coarser tiles
 * and their 256-texel textures only, and past `blueMarbleFromKm` the Blue
 * Marble globe map is painted over it. The layers - roads, buildings,
 * airfields, trees - each stop at a range of their own.
 *
 * Every range at the top of its slider means "no limit", which is how the
 * game drew before these existed; the defaults change nothing but expose
 * where the leaf textures already started (LEAF_COVER_FROM_M).
 */

/** The bands' slider runs 0 to this; the top is "no limit". */
export const VIEW_BAND_MAX_KM = 500;

/** Each layer's slider runs 0 to its own top, which is "no limit". */
export const VIEW_LAYER_MAX_KM = {
    roads: 200,
    buildings: 50,
    airfields: 100,
    trees: 50,
} as const;

export type ViewLayer = keyof typeof VIEW_LAYER_MAX_KM;

export interface ViewRanges {
    /** Far cover textures are read from here out; under it the facets show. */
    textureFromKm: number;
    /** Past here only the 256-texel tiles are drawn (no refining into the 512 ones). */
    coarseTextureFromKm: number;
    /** Past here the Blue Marble map is painted over the terrain. */
    blueMarbleFromKm: number;
    roadsKm: number;
    buildingsKm: number;
    airfieldsKm: number;
    treesKm: number;
}

export const DEFAULT_VIEW_RANGES: ViewRanges = {
    textureFromKm: 3,
    coarseTextureFromKm: VIEW_BAND_MAX_KM,
    blueMarbleFromKm: VIEW_BAND_MAX_KM,
    roadsKm: VIEW_LAYER_MAX_KM.roads,
    buildingsKm: VIEW_LAYER_MAX_KM.buildings,
    airfieldsKm: VIEW_LAYER_MAX_KM.airfields,
    treesKm: VIEW_LAYER_MAX_KM.trees,
};

function clampKm(value: unknown, max: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : fallback;
}

/** A valid ViewRanges from anything, field by field, with the bands kept in order. */
export function sanitizeViewRanges(value: unknown): ViewRanges {
    const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<ViewRanges>;
    const d = DEFAULT_VIEW_RANGES;
    const a = clampKm(v.textureFromKm, VIEW_BAND_MAX_KM, d.textureFromKm);
    const b = Math.max(a, clampKm(v.coarseTextureFromKm, VIEW_BAND_MAX_KM, d.coarseTextureFromKm));
    const c = Math.max(b, clampKm(v.blueMarbleFromKm, VIEW_BAND_MAX_KM, d.blueMarbleFromKm));
    return {
        textureFromKm: a,
        coarseTextureFromKm: b,
        blueMarbleFromKm: c,
        roadsKm: clampKm(v.roadsKm, VIEW_LAYER_MAX_KM.roads, d.roadsKm),
        buildingsKm: clampKm(v.buildingsKm, VIEW_LAYER_MAX_KM.buildings, d.buildingsKm),
        airfieldsKm: clampKm(v.airfieldsKm, VIEW_LAYER_MAX_KM.airfields, d.airfieldsKm),
        treesKm: clampKm(v.treesKm, VIEW_LAYER_MAX_KM.trees, d.treesKm),
    };
}

export function sameViewRanges(a: ViewRanges, b: ViewRanges): boolean {
    return (Object.keys(a) as (keyof ViewRanges)[]).every(k => a[k] === b[k]);
}

/** A slider value in metres for the runtime: the top of its slider is no limit. */
export function rangeM(km: number, maxKm: number): number {
    return km >= maxKm ? Infinity : km * 1000;
}

/** The band distances in metres, Infinity where a band is off. */
export function viewBandsM(r: ViewRanges): { textureFromM: number; coarseTextureFromM: number; blueMarbleFromM: number } {
    return {
        // The first thumb has no "off": at the top it is just a long way out.
        textureFromM: r.textureFromKm * 1000,
        coarseTextureFromM: rangeM(r.coarseTextureFromKm, VIEW_BAND_MAX_KM),
        blueMarbleFromM: rangeM(r.blueMarbleFromKm, VIEW_BAND_MAX_KM),
    };
}

export function viewLayerM(r: ViewRanges, layer: ViewLayer): number {
    return rangeM(r[`${layer}Km`], VIEW_LAYER_MAX_KM[layer]);
}

export type ViewRangesChangeListener = (ranges: ViewRanges) => void;

export class ViewRangesSetting {
    private active: ViewRanges;
    private listeners: Set<ViewRangesChangeListener> = new Set();

    constructor(initial: ViewRanges = DEFAULT_VIEW_RANGES) {
        this.active = sanitizeViewRanges(initial);
    }

    getActive(): ViewRanges {
        return this.active;
    }

    setActive(ranges: ViewRanges) {
        const next = sanitizeViewRanges(ranges);
        if (sameViewRanges(next, this.active)) return;
        this.active = next;
        for (const listener of this.listeners.values()) {
            listener(this.active);
        }
    }

    addChangeListener(listener: ViewRangesChangeListener) {
        this.listeners.add(listener);
    }

    removeChangeListener(listener: ViewRangesChangeListener) {
        this.listeners.delete(listener);
    }
}

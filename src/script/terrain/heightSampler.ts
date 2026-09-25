/**
 * The one place a ground height is read out of DEM tiles.
 *
 * Both the render thread's {@link import('./heightField').HeightField} and the
 * physics worker's mirror sample through this, so the surface that is drawn,
 * the surface a shadow sits on and the surface that decides a crash cannot
 * drift apart: they are the same bilinear read of the same tile, not two code
 * paths that happen to agree.
 */

import { DemTile, sampleBilinear } from './demTile';
import {
    Ecef, Enu, EnuBasis, ecefToEnu, enuToGeodeticApprox, geodeticToEcef,
} from './geodesy';
import { FlattenPad, applyFlattenPad, padBlendWeight } from './flattenPad';
import { TileKey, tileAtLonLat, tileBounds, tileKeyString } from './tiling';

/** Heights at or below seaLevel + this are open water. */
export const WATER_HEIGHT_EPS_M = 0.5;

export type HeightTier = 'fine' | 'coarse' | 'none';

/** Resident-tile lookup. Must not fetch and must not disturb cache order. */
export type TileLookup = (id: TileKey) => DemTile | undefined;

/** Scratch for the geodetic round trip; these are called per contact test. */
const _ecef: Ecef = { x: 0, y: 0, z: 0 };
const _enu: Enu = { e: 0, n: 0, u: 0 };

export interface HeightSamplerOptions {
    basis: EnuBasis;
    seaLevel: number;
    /** The single zoom every fine query samples. */
    queryZoom: number;
    /** Always-resident fallback zoom. */
    coarseZoom: number;
    pads: FlattenPad[];
    fine: TileLookup;
    coarse: TileLookup;
}

export class HeightSampler {

    readonly basis: EnuBasis;
    readonly seaLevel: number;
    readonly queryZoom: number;
    readonly coarseZoom: number;

    private readonly pads: FlattenPad[];
    private readonly fine: TileLookup;
    private readonly coarse: TileLookup;

    constructor(opts: HeightSamplerOptions) {
        this.basis = opts.basis;
        this.seaLevel = opts.seaLevel;
        this.queryZoom = opts.queryZoom;
        this.coarseZoom = opts.coarseZoom;
        this.pads = opts.pads;
        this.fine = opts.fine;
        this.coarse = opts.coarse;
    }

    /**
     * Scene Y of the ground at a local east/north point — the height the
     * terrain mesh is actually drawn at.
     *
     * This is *not* the DEM number. The bake places every vertex through
     * geodetic → ECEF → ENU, so the surface curves away from the tangent plane:
     * a point 25 km out sits ~49 m below its own elevation above the ellipsoid.
     * Returning the raw elevation here put the sim's ground that much above the
     * ground the player could see, and the aircraft exploded in mid-air.
     */
    heightAtEnu(e: number, n: number): number {
        const g = enuToGeodeticApprox(this.basis, e, n, 0);
        const h = this.surfaceHeight(e, n, g.lon, g.lat);
        geodeticToEcef(g.lat, g.lon, h, _ecef);
        return ecefToEnu(this.basis, _ecef, _enu).u;
    }

    /**
     * Elevation above the ellipsoid — the DEM's own number, pads applied.
     * Land/water tests and anything comparing against sea level want this, not
     * the scene Y, which goes negative with distance on its own.
     */
    geodeticHeightAtEnu(e: number, n: number): number {
        const g = enuToGeodeticApprox(this.basis, e, n, 0);
        return this.surfaceHeight(e, n, g.lon, g.lat);
    }

    /**
     * Height above the ellipsoid of a point *in the air*, from its scene Y.
     *
     * The inverse of what {@link heightAtEnu} does to the ground, and for the
     * same reason: scene Y is up from the tangent plane at the play origin, so
     * it drifts below true altitude with distance — ~1.8 km at the corner of a
     * three-degree area. An altimeter reading raw Y therefore says zero while
     * the aircraft is still well above the terrain. This is the altimeter's
     * number; scene Y stays the renderer's.
     */
    geodeticAltitudeAtEnu(e: number, n: number, u: number): number {
        return enuToGeodeticApprox(this.basis, e, n, u).height;
    }

    isLandEnu(e: number, n: number): boolean {
        return this.geodeticHeightAtEnu(e, n) > this.seaLevel + WATER_HEIGHT_EPS_M;
    }

    /**
     * Sampled elevation with the flatten pads blended in.
     *
     * Water is never padded, with one exception: the flat core of an airfield
     * platform, which is ground by construction. Gran Canaria is why — the
     * airport is built out onto the shore and part of it reads as sea in the
     * DEM, and without this the aircraft would fall through the apron it is
     * visibly parked on. The mesh bake makes the same exception (see the
     * `paved` hook in tools/bake/shoreline.ts), which is what keeps the drawn
     * surface and the collision surface the same surface.
     */
    private surfaceHeight(e: number, n: number, lon: number, lat: number): number {
        const raw = this.heightAtLonLat(lon, lat);
        if (isWaterHeight(raw, this.seaLevel) && !this.inPadCore(e, n)) {
            return raw;
        }
        let h = raw;
        for (const pad of this.pads) {
            h = applyFlattenPad(h, e, n, pad);
        }
        return h;
    }

    /** True over a platform's flat core — the paved part, not its feather. */
    private inPadCore(e: number, n: number): boolean {
        for (const pad of this.pads) {
            if (padBlendWeight(e, n, pad) >= 1) {
                return true;
            }
        }
        return false;
    }

    /** Raw sample, no pad. Fine tier if resident, else coarse, else sea level. */
    heightAtLonLat(lon: number, lat: number): number {
        const fine = this.tileAt(this.queryZoom, lon, lat, this.fine);
        if (fine) {
            const h = sampleAt(fine.tile, fine.id, lon, lat);
            if (Number.isFinite(h)) {
                return h;
            }
        }
        const coarse = this.tileAt(this.coarseZoom, lon, lat, this.coarse);
        if (coarse) {
            const h = sampleAt(coarse.tile, coarse.id, lon, lat);
            if (Number.isFinite(h)) {
                return h;
            }
        }
        return this.seaLevel;
    }

    /** Which tier would answer a query here. */
    tierAtEnu(e: number, n: number): HeightTier {
        const g = enuToGeodeticApprox(this.basis, e, n, 0);
        if (this.tileAt(this.queryZoom, g.lon, g.lat, this.fine)) {
            return 'fine';
        }
        return this.tileAt(this.coarseZoom, g.lon, g.lat, this.coarse) ? 'coarse' : 'none';
    }

    /** Key (`z/x/y`) of the fine tile covering an ENU point. */
    fineTileKeyAtEnu(e: number, n: number): string {
        const g = enuToGeodeticApprox(this.basis, e, n, 0);
        return tileKeyString(tileAtLonLat(this.queryZoom, g.lon, g.lat));
    }

    private tileAt(
        z: number, lon: number, lat: number, lookup: TileLookup,
    ): { id: TileKey; tile: DemTile } | undefined {
        const id = tileAtLonLat(z, lon, lat);
        const tile = lookup(id);
        return tile ? { id, tile } : undefined;
    }
}

export function isWaterHeight(h: number, seaLevel: number): boolean {
    return !Number.isFinite(h) || h <= seaLevel + WATER_HEIGHT_EPS_M;
}

function sampleAt(tile: DemTile, id: TileKey, lon: number, lat: number): number {
    const b = tileBounds(id);
    const u = (lon - b.west) / (b.east - b.west);
    const v = (b.north - lat) / (b.north - b.south);
    return sampleBilinear(tile, u, v);
}

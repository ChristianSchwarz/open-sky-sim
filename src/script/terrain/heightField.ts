/**
 * CPU ground-height queries.
 *
 * The old HeightQuery walked from maxZoom downwards through whatever the
 * *renderer* happened to have in its LRU, so the same (x, z) returned
 * different heights depending on where the camera was. That fed spawns,
 * collisions, AI and scenery placement, and the physics worker's entire
 * terrain model was a boot-time snapshot of 25,921 such calls.
 *
 * Here the fine tier is pinned to a single zoom and lives in its own store
 * that the renderer cannot influence, and a coarse tier is loaded in full at
 * boot so a query outside the streamed area returns a coarse answer with a
 * stated bound rather than a silent lie. `heightResolutionAtWorld` reports
 * which tier answered, so the HUD can prove it never changes as you climb.
 *
 * The public queries take **scene** (x, z), because that is what every caller
 * — physics, spawns, AI, scenery — actually holds. Scene z runs south while
 * the sampler underneath works in ENU, so this class is where the two meet;
 * see `sceneFromEnu` for the sign.
 */

import { DemTile } from './demTile';
import { EnuBasis, enuToGeodeticApprox, northFromSceneZ } from './geodesy';
import { FlattenPad } from './flattenPad';
import { HeightSampler, HeightTier } from './heightSampler';
import { TerrainManifest } from './manifest';
import { LonLatBounds, TileKey } from './tiling';
import { TileIndex } from './tileIndex';
import { TileStore } from './tileStore';

export { WATER_HEIGHT_EPS_M, isWaterHeight } from './heightSampler';
export type { HeightTier } from './heightSampler';

export interface HeightFieldOptions {
    manifest: TerrainManifest;
    store: TileStore<DemTile>;
    basis: EnuBasis;
    pads?: FlattenPad[];
}

export class HeightField {
    private readonly manifest: TerrainManifest;
    private readonly store: TileStore<DemTile>;
    private readonly basis: EnuBasis;
    private readonly pads: FlattenPad[];
    /** Always-resident coarse tier, keyed by tile. */
    private readonly coarse = new Map<string, DemTile>();
    private readonly sampler: HeightSampler;

    constructor(opts: HeightFieldOptions) {
        this.manifest = opts.manifest;
        this.store = opts.store;
        this.basis = opts.basis;
        this.pads = opts.pads ?? [];
        this.sampler = new HeightSampler({
            basis: this.basis,
            seaLevel: this.manifest.seaLevel,
            queryZoom: this.manifest.height.queryZoom,
            coarseZoom: this.manifest.height.coarseZoom,
            pads: this.pads,
            // peek, not get: a CPU height query must never reorder a cache whose
            // eviction the renderer also depends on.
            fine: id => this.store.peek(id),
            coarse: id => this.coarse.get(`${id.z}/${id.x}/${id.y}`),
        });
    }

    get seaLevel(): number {
        return this.manifest.seaLevel;
    }

    get queryZoom(): number {
        return this.manifest.height.queryZoom;
    }

    get coarseZoom(): number {
        return this.manifest.height.coarseZoom;
    }

    /** Airbase flatten pads, so a mirror can apply the same flattening. */
    get flattenPads(): readonly FlattenPad[] {
        return this.pads;
    }

    /**
     * Load the coarse tier in full. Cheap: a handful of tiles.
     *
     * Driven by the index when one is available, and only by the coverage box
     * when it is not. The box is the bounding rectangle of everything baked,
     * which is the same thing as the baked area only while that area is a
     * single blob. Add a second area on the far side of the world and the box
     * swells to span the ocean between them, so walking it asks for hundreds
     * of tiles that were never baked — each one an HTTP request, a 404, and a
     * retry before the store gives up on it.
     */
    async loadCoarse(index?: TileIndex): Promise<void> {
        const z = this.coarseZoom;
        const ids = index ? index.tilesAt(z) : this.coarseIdsFromCoverage(z);
        const jobs = ids.map(id => this.store.request(id, Number.MAX_SAFE_INTEGER)
            .then(tile => {
                if (tile) {
                    this.coarse.set(`${id.z}/${id.x}/${id.y}`, tile);
                    this.store.setPinned(id, true);
                }
            }));
        await Promise.all(jobs);
    }

    /** Every tile in the coverage rectangle at `z`, baked or not. */
    private coarseIdsFromCoverage(z: number): TileKey[] {
        const cov = this.manifest.coverage;
        const span = 180 / (1 << z);
        const x0 = Math.floor((cov.west + 180) / span);
        const x1 = Math.floor((cov.east + 180) / span);
        const y0 = Math.floor((90 - cov.north) / span);
        const y1 = Math.floor((90 - cov.south) / span);
        const ids: TileKey[] = [];
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                ids.push({ z, x, y });
            }
        }
        return ids;
    }

    /** Ensure the fine tier covers a lon/lat box. Await before relying on it. */
    async ensureLoaded(bounds: LonLatBounds): Promise<void> {
        await Promise.all(this.fineTileIds(bounds).map(
            id => this.store.request(id, Number.MAX_SAFE_INTEGER),
        ));
    }

    /** Ensure the fine tier covers a radius (m) around a scene point. */
    async ensureLoadedAroundWorld(x: number, z: number, radiusM: number): Promise<void> {
        await this.ensureLoaded(boundsAroundEnu(this.basis, x, northFromSceneZ(z), radiusM));
    }

    /** Which tier would answer a query here. */
    heightResolutionAtWorld(x: number, z: number): HeightTier {
        return this.sampler.tierAtEnu(x, northFromSceneZ(z));
    }

    /**
     * Scene Y of the ground under a scene (x, z): the height the terrain mesh
     * is drawn at, curvature included. Synchronous and independent of anything
     * the renderer is doing.
     */
    heightAtWorld(x: number, z: number): number {
        return this.sampler.heightAtEnu(x, northFromSceneZ(z));
    }

    /** Elevation above the ellipsoid under a scene point — the DEM's own number. */
    geodeticHeightAtWorld(x: number, z: number): number {
        return this.sampler.geodeticHeightAtEnu(x, northFromSceneZ(z));
    }

    /**
     * Height above the ellipsoid of a scene point — what an altimeter reads.
     *
     * Scene Y is not that number away from the play origin: the terrain curves
     * away from the tangent plane, so Y = 0 sits above the ground by ~1.8 km at
     * the corner of a three-degree area. See `HeightSampler.geodeticAltitudeAtEnu`.
     */
    geodeticAltitudeAtWorld(x: number, y: number, z: number): number {
        return this.sampler.geodeticAltitudeAtEnu(x, northFromSceneZ(z), y);
    }

    isLandAtWorld(x: number, z: number): boolean {
        return this.sampler.isLandEnu(x, northFromSceneZ(z));
    }

    /** Raw sample, no pad. Fine tier if resident, else coarse, else sea level. */
    heightAtLonLat(lon: number, lat: number): number {
        return this.sampler.heightAtLonLat(lon, lat);
    }

    /** Every coarse-tier tile, for mirroring the fallback tier elsewhere. */
    coarseTiles(): { id: TileKey; tile: DemTile }[] {
        const out: { id: TileKey; tile: DemTile }[] = [];
        for (const [key, tile] of this.coarse) {
            const [z, x, y] = key.split('/').map(Number);
            out.push({ id: { z, x, y }, tile });
        }
        return out;
    }

    /** Fine-tier tile ids covering a radius (m) around a scene point. */
    fineTileIdsAroundWorld(x: number, z: number, radiusM: number): TileKey[] {
        return this.fineTileIds(boundsAroundEnu(this.basis, x, northFromSceneZ(z), radiusM));
    }

    /** A resident fine tile, or undefined. Does not fetch and does not touch LRU order. */
    peekFine(id: TileKey): DemTile | undefined {
        return this.store.peek(id);
    }

    /** True when this fine tile will never arrive — the coarse tier is all there is. */
    isFineAbsent(id: TileKey): boolean {
        return this.store.isAbsent(id);
    }

    private fineTileIds(bounds: LonLatBounds): TileKey[] {
        const z = this.queryZoom;
        const span = 180 / (1 << z);
        const x0 = Math.floor((bounds.west + 180) / span);
        const x1 = Math.floor((bounds.east + 180) / span);
        const y0 = Math.floor((90 - bounds.north) / span);
        const y1 = Math.floor((90 - bounds.south) / span);
        const ids: TileKey[] = [];
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                ids.push({ z, x, y });
            }
        }
        return ids;
    }
}

/** Lon/lat box covering `radiusM` around an ENU point. */
function boundsAroundEnu(
    basis: EnuBasis, e: number, n: number, radiusM: number,
): LonLatBounds {
    const c = enuToGeodeticApprox(basis, e, n, 0);
    const dLat = radiusM / 110540;
    const dLon = radiusM / (111320 * Math.max(0.1, Math.cos(c.lat * Math.PI / 180)));
    return {
        west: c.lon - dLon,
        east: c.lon + dLon,
        south: c.lat - dLat,
        north: c.lat + dLat,
    };
}

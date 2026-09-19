/**
 * Mirroring the DEM height field into a worker.
 *
 * The physics worker decides whether an aircraft has hit the ground, so it must
 * read the *same* terrain the renderer draws. It used to get a boot-time
 * snapshot of 25,921 height samples on a 500 m lattice instead, which over this
 * DEM sits up to ~200 m above the real surface in a barranco and ~170 m below a
 * ridge — the plane exploded in clear air over a valley and flew through
 * hillsides. So the render thread now ships the decoded DEM tiles themselves and
 * the worker samples them through the shared {@link HeightSampler}: same tiles,
 * same bilinear read, no resampling in between.
 *
 * Fine tiles follow the aircraft (see the sender in `state/game.ts`); the coarse
 * tier is small enough to ship once at boot. `tierAtWorld` reports which one
 * answered so the sim can refuse to kill anyone on a coarse guess.
 *
 * Queries here take scene (x, z) like the render thread's HeightField, so the
 * two halves of the mirror cannot disagree about which way north is.
 */

import { DemTile } from './demTile';
import { EnuBasis, northFromSceneZ } from './geodesy';
import { FlattenPad } from './flattenPad';
import { HeightSampler, HeightTier } from './heightSampler';
import { TileKey, tileKeyString } from './tiling';

/** One decoded DEM tile, structured-clone-safe (heights are transferable). */
interface SerializedDemTile {
    z: number;
    x: number;
    y: number;
    size: number;
    minH: number;
    maxH: number;
    quantScale: number;
    geometricErrorM: number;
    heights: Float32Array;
}

/** Everything but the tiles: enough to rebuild the sampler in a worker. */
export interface SerializedHeightField {
    basis: EnuBasis;
    seaLevel: number;
    queryZoom: number;
    coarseZoom: number;
    pads: FlattenPad[];
}

/** A batch of tile changes for one tier. */
export interface HeightTileUpdate {
    tier: 'fine' | 'coarse';
    add: SerializedDemTile[];
    /** Tile keys (`z/x/y`) the receiver should forget. */
    drop: string[];
    /**
     * Fine tiles that will never arrive (not baked, or permanently failed).
     * The coarse tier is the best anyone has there, so it counts as final.
     */
    absent?: string[];
}

function serializeDemTile(id: TileKey, tile: DemTile): SerializedDemTile {
    return {
        z: id.z,
        x: id.x,
        y: id.y,
        size: tile.size,
        minH: tile.minH,
        maxH: tile.maxH,
        quantScale: tile.quantScale,
        geometricErrorM: tile.geometricErrorM,
        // Copy: the render thread keeps its own tile, so the buffer cannot be
        // transferred out from under the LRU.
        heights: tile.heights.slice(),
    };
}

/**
 * Worker-side view of the render thread's height field. Answers ground height
 * from whatever tiles have been mirrored so far.
 */
export class MirroredHeightField {

    private readonly fine = new Map<string, DemTile>();
    private readonly coarse = new Map<string, DemTile>();
    /** Fine tiles the render thread says do not exist. */
    private readonly absent = new Set<string>();
    private sampler: HeightSampler | undefined;

    /** Replace the sampler config. Tiles survive; they are keyed by zoom anyway. */
    configure(cfg: SerializedHeightField): void {
        this.sampler = new HeightSampler({
            basis: cfg.basis,
            seaLevel: cfg.seaLevel,
            queryZoom: cfg.queryZoom,
            coarseZoom: cfg.coarseZoom,
            pads: cfg.pads,
            fine: id => this.fine.get(tileKeyString(id)),
            coarse: id => this.coarse.get(tileKeyString(id)),
        });
    }

    get configured(): boolean {
        return this.sampler !== undefined;
    }

    applyTiles(update: HeightTileUpdate): void {
        const map = update.tier === 'fine' ? this.fine : this.coarse;
        for (const key of update.drop) {
            map.delete(key);
            this.absent.delete(key);
        }
        for (const key of update.absent ?? []) {
            this.absent.add(key);
        }
        for (const t of update.add) {
            map.set(`${t.z}/${t.x}/${t.y}`, {
                size: t.size,
                flags: 0,
                minH: t.minH,
                maxH: t.maxH,
                quantScale: t.quantScale,
                geometricErrorM: t.geometricErrorM,
                heights: t.heights,
            });
        }
    }

    /** Sea level until configured, so a pre-boot query is flat rather than wrong. */
    heightAtWorld(x: number, z: number): number {
        return this.sampler ? this.sampler.heightAtEnu(x, northFromSceneZ(z)) : 0;
    }

    /** Elevation above the ellipsoid — for sea-level tests, not for scene Y. */
    geodeticHeightAtWorld(x: number, z: number): number {
        return this.sampler ? this.sampler.geodeticHeightAtEnu(x, northFromSceneZ(z)) : 0;
    }

    /** Height above the ellipsoid of a point in the air — the altimeter's number. */
    geodeticAltitudeAtWorld(x: number, y: number, z: number): number {
        return this.sampler ? this.sampler.geodeticAltitudeAtEnu(x, northFromSceneZ(z), y) : y;
    }

    /** Which tier answered. `none` means we have no terrain here at all. */
    tierAtWorld(x: number, z: number): HeightTier {
        return this.sampler ? this.sampler.tierAtEnu(x, northFromSceneZ(z)) : 'none';
    }

    isLandAtWorld(x: number, z: number): boolean {
        return this.sampler ? this.sampler.isLandEnu(x, northFromSceneZ(z)) : false;
    }

    /**
     * True when the answer here is as good as the render thread's: either the
     * fine tile is mirrored, or there is no fine tile to have.
     */
    isAuthoritativeAt(x: number, z: number): boolean {
        if (!this.sampler) {
            return false;
        }
        const n = northFromSceneZ(z);
        if (this.sampler.tierAtEnu(x, n) === 'fine') {
            return true;
        }
        return this.absent.has(this.sampler.fineTileKeyAtEnu(x, n));
    }

    /** Resident fine-tile keys, for the sender's book-keeping in tests. */
    fineKeys(): string[] {
        return [...this.fine.keys()];
    }
}

/** The slice of {@link import('./heightField').HeightField} the sender needs. */
export interface MirrorSource {
    readonly seaLevel: number;
    readonly queryZoom: number;
    readonly coarseZoom: number;
    coarseTiles(): { id: TileKey; tile: DemTile }[];
    fineTileIdsAroundWorld(x: number, z: number, radiusM: number): TileKey[];
    peekFine(id: TileKey): DemTile | undefined;
    isFineAbsent(id: TileKey): boolean;
    ensureLoadedAroundWorld(x: number, z: number, radiusM: number): Promise<void>;
}

/** A point the fine tier must cover — an aircraft, lead included. */
export interface MirrorFocus {
    x: number;
    z: number;
}

/**
 * Render-thread half of the mirror: keeps the worker's fine tier covering the
 * aircraft and never sends the same tile twice.
 */
export class HeightFieldSender {

    /** Fine tile keys the receiver already holds. */
    private readonly sent = new Set<string>();
    private loading = false;

    constructor(
        private readonly source: MirrorSource,
        private readonly send: (update: HeightTileUpdate) => void,
    ) { }

    /** Ship the whole coarse tier. Call once the coarse tier has loaded. */
    sendCoarse(): void {
        const tiles = this.source.coarseTiles();
        if (tiles.length === 0) {
            return;
        }
        this.send({
            tier: 'coarse',
            add: tiles.map(t => serializeDemTile(t.id, t.tile)),
            drop: [],
        });
    }

    /** Forget what the receiver holds (after a worker reset). */
    reset(): void {
        this.sent.clear();
    }

    /**
     * Bring the receiver's fine tier in line with `focus`. Sends tiles that are
     * already resident and kicks off loads for the rest, so a fast-moving
     * aircraft catches up on a later call rather than blocking this one.
     */
    update(focus: readonly MirrorFocus[], radiusM: number): void {
        if (focus.length === 0) {
            return;
        }
        const needed = new Map<string, TileKey>();
        for (const f of focus) {
            for (const id of this.source.fineTileIdsAroundWorld(f.x, f.z, radiusM)) {
                needed.set(tileKeyString(id), id);
            }
        }

        const add: SerializedDemTile[] = [];
        const absent: string[] = [];
        let missing = false;
        for (const [key, id] of needed) {
            if (this.sent.has(key)) {
                continue;
            }
            const tile = this.source.peekFine(id);
            if (!tile) {
                // A tile that will never arrive is news too: it tells the
                // receiver its coarse answer there is final, not provisional.
                if (this.source.isFineAbsent(id)) {
                    absent.push(key);
                    this.sent.add(key);
                } else {
                    missing = true;
                }
                continue;
            }
            add.push(serializeDemTile(id, tile));
            this.sent.add(key);
        }

        const drop: string[] = [];
        for (const key of this.sent) {
            if (!needed.has(key)) {
                drop.push(key);
                this.sent.delete(key);
            }
        }

        if (add.length > 0 || drop.length > 0 || absent.length > 0) {
            this.send({ tier: 'fine', add, drop, absent });
        }
        if (missing && !this.loading) {
            this.loading = true;
            Promise.all(focus.map(
                f => this.source.ensureLoadedAroundWorld(f.x, f.z, radiusM),
            )).catch(() => { /* a dead tile is handled by the coarse fallback */ })
                .then(() => { this.loading = false; });
        }
    }
}

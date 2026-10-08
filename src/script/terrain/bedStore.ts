/**
 * The baked bed sidecars (pbd.ts) at runtime: the beds a tile's roads and
 * railways were laid on by the bake (tools/bake_planet_grade.ts), and their
 * retaining walls. Modelled on BridgeMeshes: its own store, gated by
 * index_beds.bin. The grading itself is the bake's; the land and the strokes
 * arrive with the beds already in them.
 */

import { decodePbd, PbdTile } from './pbd';
import { TerrainManifest, bedTileUrl } from './manifest';
import { TileIndex } from './tileIndex';
import { TileKey } from './tiling';
import { TileStore } from './tileStore';

/** Decoded sidecars kept: beds are small, a busy leaf about 200 KB decoded. */
const BED_CACHE_BYTES = 48 * 1024 * 1024;

export class BedStore {
    private readonly store: TileStore<PbdTile> | undefined;
    private readonly minZoom: number;
    private readonly maxZoom: number;
    private index: TileIndex | undefined;

    constructor(opts: { manifest: TerrainManifest; baseUrl: string }) {
        const spec = opts.manifest.beds;
        this.minZoom = spec?.minZoom ?? 0;
        this.maxZoom = spec?.maxZoom ?? -1;
        this.store = spec === undefined ? undefined : new TileStore<PbdTile>({
            baseUrl: opts.baseUrl,
            url: (id) => bedTileUrl(opts.manifest, id.z, id.x, id.y, opts.baseUrl),
            decode: (buf) => decodePbd(buf),
            sizeOf: (t) => t.beds.byteLength + (t.walls ? t.walls.positions.byteLength * 2 + t.walls.indices.byteLength : 0),
            maxBytes: BED_CACHE_BYTES,
            exists: (id) => this.has(id),
        });
    }

    setIndex(index: TileIndex | undefined): void {
        this.index = index;
    }

    /** Whether the bake wrote beds for this tile. */
    has(id: TileKey): boolean {
        if (!this.store || id.z < this.minZoom || id.z > this.maxZoom) {
            return false;
        }
        return this.index ? this.index.has(id) : true;
    }

    /** A tile's beds and walls, or null when it has none. */
    async load(id: TileKey, priority: number): Promise<PbdTile | null> {
        if (!this.store || !this.has(id) || this.store.isAbsent(id)) {
            return null;
        }
        return this.store.get(id) ?? this.store.request(id, priority).catch(() => null);
    }

    nextGeneration(): void {
        this.store?.nextGeneration();
    }
}

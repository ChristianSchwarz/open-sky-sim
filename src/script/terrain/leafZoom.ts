import { LonLatBounds } from './tiling';

/**
 * The finest zoom an area is baked to, and so which tiles are leaves.
 *
 * Every area used to end at the pyramid's `mesh.maxZoom` (12), and "leaf" was
 * spelled `z === maxZoom` across the bake and the runtime. An area can now stop
 * short of that with `leafZoom` on its manifest entry: its tiles at that zoom
 * are the leaves, there is nothing below them, and they carry what a z12 leaf
 * would (far land, buildings, bridges, the finest land use).
 *
 * A tile belongs to the area its centre lies in. The importer snaps a capped
 * area's box to its leaf zoom's tile edges, so no leaf straddles a border;
 * coarser tiles that do straddle one sit above every leaf and are unaffected.
 */
export interface LeafZoomArea extends LonLatBounds {
    leafZoom?: number;
}

export interface TileId {
    z: number;
    x: number;
    y: number;
}

/** The leaf zoom of the tile `id`: its area's cap, else the pyramid's. */
export type LeafZoomOf = (id: TileId) => number;

export function leafZoomOf(
    areas: readonly LeafZoomArea[] | undefined,
    maxZoom: number,
): LeafZoomOf {
    const capped = (areas ?? []).filter(a => a.leafZoom !== undefined && a.leafZoom < maxZoom);
    if (capped.length === 0) {
        return () => maxZoom;
    }
    return ({ z, x, y }) => {
        const span = 180 / (1 << z);
        const lon = -180 + (x + 0.5) * span;
        const lat = 90 - (y + 0.5) * span;
        for (const a of capped) {
            if (lon >= a.west && lon <= a.east && lat >= a.south && lat <= a.north) {
                return a.leafZoom!;
            }
        }
        return maxZoom;
    };
}

/** True for the finest tiles of their area. */
export function isLeafTile(leafZoom: LeafZoomOf, id: TileId): boolean {
    return id.z === leafZoom(id);
}

/** True for tiles below their area's leaves, which are never baked. */
export function isPastLeaf(leafZoom: LeafZoomOf, id: TileId): boolean {
    return id.z > leafZoom(id);
}

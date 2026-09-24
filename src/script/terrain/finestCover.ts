/**
 * Reads a decoded tile's own land facet directly, by brute-force point-in-
 * triangle scan over its land geometry.
 *
 * Everything else that reads a facet's cover (TileHeightIndex.coverAtWorld)
 * does it through a spatial bucket grid built over geometry already bound
 * into a THREE.Mesh, because it runs every frame for a drawn tile. This is
 * for a handful of one-off lookups against a tile that was fetched purely to
 * be read - an airfield's own runway thresholds, not anything on screen - so
 * building an index for it would cost more than the scan it replaces.
 */

import { PtmTile } from './ptm';
import { TileCover } from './tileHeightIndex';

function edgeSign(
    px: number, pz: number, ax: number, az: number, bx: number, bz: number,
): number {
    return (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
}

/** Whether (x, z) falls inside triangle a/b/c, in plan view (height ignored). */
function pointInTriangle(
    x: number, z: number,
    ax: number, az: number, bx: number, bz: number, cx: number, cz: number,
): boolean {
    const d1 = edgeSign(x, z, ax, az, bx, bz);
    const d2 = edgeSign(x, z, bx, bz, cx, cz);
    const d3 = edgeSign(x, z, cx, cz, ax, az);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
}

/**
 * The observed cover of a decoded tile's land facet at a tile-local point (in
 * the tile's own quantised units, matching `landPositions` directly), or
 * undefined off every triangle - a query that fell in the tile's water or in
 * its skirt.
 */
export function coverInPtmTile(tile: PtmTile, localX: number, localZ: number, zoom: number): TileCover | undefined {
    const pos = tile.landPositions;
    const attrs = tile.landAttrs;
    const triCount = (attrs.length / 4 / 3) | 0;
    for (let t = 0; t < triCount; t++) {
        const v0 = t * 3, v1 = v0 + 1, v2 = v0 + 2;
        if (pointInTriangle(
            localX, localZ,
            pos[v0 * 3], pos[v0 * 3 + 2],
            pos[v1 * 3], pos[v1 * 3 + 2],
            pos[v2 * 3], pos[v2 * 3 + 2],
        )) {
            const a = v0 * 4;
            return { cls: attrs[a + 3], rgb: (attrs[a] << 16) | (attrs[a + 1] << 8) | attrs[a + 2], zoom };
        }
    }
    return undefined;
}

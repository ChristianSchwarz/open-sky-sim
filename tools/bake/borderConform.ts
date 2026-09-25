/**
 * Make a fine tile's border follow the coarse tile it may meet.
 *
 * The runtime's cut is not restricted to one level: a z12 tile can sit beside a
 * z9 tile, and each side meshes its own border. The coarse height grid is a
 * point decimation of the fine one, so its border can only run in a straight
 * line between its own nodes, and the fine border - following the true ground -
 * strays from that line by tens of metres (25 m median across one level, 75 m
 * across three). A skirt closes such a crack as a wall, not as ground.
 *
 * So the fine border is not left on the true ground. Wherever a side of the
 * tile lies on the boundary of an ancestor - the tile's edge is also the
 * ancestor's, which is what "a coarser neighbour can be there" means - the
 * border row or column takes the height the ancestor's border has there, read
 * along its straight line between nodes. Both tiles of a same-level seam reach
 * the same ancestor by the same rule and read the same nodes, so they still
 * agree with each other; a coarse neighbour's mesh border was itself decimated
 * from those nodes to a tolerance of a few metres. The cost is that a border
 * node can sit tens of metres off the true ground, for one cell's width.
 *
 * Only ancestors from MIN_SEAM_ZOOM down are followed. A side on a coarser
 * line (a z7 boundary) would flatten 156 km of border to 600 m nodes, and
 * what meets there is drawn from too far off for a seam to read.
 */

/** Coarsest ancestor whose border a fine tile conforms to. */
export const MIN_SEAM_ZOOM = 9;

export type Side = 'W' | 'E' | 'N' | 'S';

export interface BorderSource {
    /** `size` heights along `side` of the ancestor's grid, west->east or north->south. */
    border(z: number, x: number, y: number, side: Side): Float32Array | undefined;
}

/** The ancestor whose `side` this tile's shares, coarsest first; undefined if none from MIN_SEAM_ZOOM. */
export function seamAncestor(
    z: number, x: number, y: number, side: Side, minZoom = MIN_SEAM_ZOOM,
): { z: number; x: number; y: number } | undefined {
    let best: { z: number; x: number; y: number } | undefined;
    let ax = x;
    let ay = y;
    for (let az = z - 1; az >= minZoom; az--) {
        // The parent shares the side when this tile is its first/last child on it.
        const shares = side === 'W' ? (ax & 1) === 0
            : side === 'E' ? (ax & 1) === 1
                : side === 'N' ? (ay & 1) === 0 : (ay & 1) === 1;
        if (!shares) {
            break;
        }
        ax >>= 1;
        ay >>= 1;
        best = { z: az, x: ax, y: ay };
    }
    return best;
}

function sample(border: Float32Array, u: number): number {
    const i = Math.min(border.length - 2, Math.max(0, Math.floor(u)));
    const f = u - i;
    const a = border[i];
    const b = border[i + 1];
    return a + (b - a) * f;
}

/**
 * Overwrite the border nodes of `heights` (row-major, `size` x `size`, row 0
 * north) that lie on a coarser ancestor's border. A node whose old or new height
 * is on the other side of `seaLevel`, or that has no data, is left alone, so
 * this never moves a coastline. Returns the number of nodes changed.
 */
export function conformBorders(
    heights: Float32Array, size: number, z: number, x: number, y: number,
    seaLevel: number, source: BorderSource, minZoom = MIN_SEAM_ZOOM,
): number {
    let changed = 0;
    for (const side of ['W', 'E', 'N', 'S'] as const) {
        const a = seamAncestor(z, x, y, side, minZoom);
        if (!a) {
            continue;
        }
        const border = source.border(a.z, a.x, a.y, side);
        if (!border || border.length !== size) {
            continue;
        }
        const span = 1 << (z - a.z);
        // Where along the ancestor's side this tile's own segment starts, in tiles.
        const offset = side === 'W' || side === 'E' ? y - a.y * span : x - a.x * span;
        for (let i = 0; i < size; i++) {
            const u = ((offset + i / (size - 1)) / span) * (size - 1);
            const next = sample(border, u);
            const idx = side === 'W' ? i * size
                : side === 'E' ? i * size + size - 1
                    : side === 'N' ? i : (size - 1) * size + i;
            const old = heights[idx];
            if (!Number.isFinite(old) || !Number.isFinite(next)
                || (old > seaLevel) !== (next > seaLevel) || old === next) {
                continue;
            }
            heights[idx] = next;
            changed++;
        }
    }
    return changed;
}

/**
 * Keeps scattered vegetation off the man-made surfaces the game places
 * itself - the authored apron pavement and fallback runway, OSM building
 * footprints - which neither the baked airfields (airfieldExclusion.ts) nor
 * the road strokes (roadExclusion.ts) describe.
 *
 * Built from the same SurfacePadCollider list the gear physics stands on, so
 * whatever is solid pavement is also bare of shrubs, bushes and trees, with
 * no second description of the same footprint to drift out of step. Scene
 * x/z in, like airfieldExclusion.
 */

import { SurfacePadCollider, sampleSurfacePadY } from '../scene/entities/surfacePad';

const CELL_M = 64;

export type SurfaceExclusion = (x: number, z: number) => boolean;

/** One test over every pad (edge skirt included), or undefined when there are none. */
export function buildSurfaceExclusion(pads: readonly SurfacePadCollider[]): SurfaceExclusion | undefined {
    if (pads.length === 0) {
        return undefined;
    }
    // Bucketed like the other exclusions: a tile's scatter asks this per
    // candidate point, and an area with OSM buildings has hundreds of pads.
    const grid = new Map<number, number[]>();
    const cellKey = (cx: number, cz: number) => (cx + (1 << 20)) * (1 << 21) + (cz + (1 << 20));
    pads.forEach((pad, i) => {
        // Circumscribed radius, so the bucket range holds at any heading.
        const reach = Math.hypot(pad.halfLength + pad.feather, pad.halfWidth + pad.feather);
        const x0 = Math.floor((pad.centerX - reach) / CELL_M), x1 = Math.floor((pad.centerX + reach) / CELL_M);
        const z0 = Math.floor((pad.centerZ - reach) / CELL_M), z1 = Math.floor((pad.centerZ + reach) / CELL_M);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cz = z0; cz <= z1; cz++) {
                const k = cellKey(cx, cz);
                const list = grid.get(k);
                if (list) {
                    list.push(i);
                } else {
                    grid.set(k, [i]);
                }
            }
        }
    });
    return (x, z) => {
        const list = grid.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
        if (!list) {
            return false;
        }
        for (const i of list) {
            if (sampleSurfacePadY(x, z, pads[i]) > -Infinity) {
                return true;
            }
        }
        return false;
    };
}

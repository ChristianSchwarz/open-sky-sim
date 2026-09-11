/**
 * Regional ground colour for land no landuse polygon claims.
 *
 * Painting untagged ground with its own facet's raster sample brings back
 * exactly the WorldCover blobs the landuse fill was meant to replace, and a
 * single flat colour per tile steps at every tile edge. So the colour is
 * averaged over a whole zoom-12 tile - about 4.9 km a side, ~25 km² - and each
 * vertex blends between the four nearest tile centres. The lattice is global,
 * so neighbouring tiles and every zoom level sample the same values: no seam
 * at a tile edge, and no colour pop when LOD swaps a tile for its parent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TerrainClass } from '../../src/script/terrain/tones';
import { decodePlc } from './plc';

/** The zoom whose tiles are the averaging cells. */
export const GROUND_SAMPLE_ZOOM = 12;

/** Mean sRGB per sampling cell, keyed `${x}/${y}` at GROUND_SAMPLE_ZOOM. */
export type GroundMeans = Record<string, readonly [number, number, number]>;

/**
 * Mean dry-ground colour of every GROUND_SAMPLE_ZOOM cover tile under `src`.
 * A tile with no dry node (open water, or no cover) is left out, so the
 * sampler blends across it from its neighbours instead of dragging sea blue
 * onto the coast.
 */
export function regionalGroundMeans(src: string): GroundMeans {
    const means: GroundMeans = {};
    const zoomDir = path.join(src, String(GROUND_SAMPLE_ZOOM));
    if (!fs.existsSync(zoomDir)) {
        return means;
    }
    for (const xName of fs.readdirSync(zoomDir)) {
        const xDir = path.join(zoomDir, xName);
        if (!fs.statSync(xDir).isDirectory()) {
            continue;
        }
        for (const file of fs.readdirSync(xDir)) {
            if (!file.endsWith('.plc')) {
                continue;
            }
            const cover = decodePlc(fs.readFileSync(path.join(xDir, file)));
            let r = 0;
            let g = 0;
            let b = 0;
            let n = 0;
            for (let i = 0; i < cover.classes.length; i++) {
                if (cover.classes[i] === TerrainClass.Water) {
                    continue;
                }
                r += cover.colors[i * 3];
                g += cover.colors[i * 3 + 1];
                b += cover.colors[i * 3 + 2];
                n++;
            }
            if (n > 0) {
                means[`${xName}/${file.slice(0, -4)}`] = [r / n, g / n, b / n];
            }
        }
    }
    return means;
}

/**
 * Bilinear blend of the four sampling-cell centres around a point.
 *
 * Cells with no value drop out and the rest are renormalised, so a vertex by
 * the sea takes the land colour beside it. Undefined only when all four are
 * missing.
 */
export function groundColorAt(
    means: GroundMeans, lon: number, lat: number,
): [number, number, number] | undefined {
    const span = 180 / (1 << GROUND_SAMPLE_ZOOM);
    // Continuous cell coordinates, shifted so integers land on cell centres.
    const fx = (lon + 180) / span - 0.5;
    const fy = (90 - lat) / span - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    let r = 0;
    let g = 0;
    let b = 0;
    let w = 0;
    for (const [dx, dy, weight] of [
        [0, 0, (1 - tx) * (1 - ty)],
        [1, 0, tx * (1 - ty)],
        [0, 1, (1 - tx) * ty],
        [1, 1, tx * ty],
    ] as const) {
        const c = means[`${x0 + dx}/${y0 + dy}`];
        if (!c || weight <= 0) {
            continue;
        }
        r += c[0] * weight;
        g += c[1] * weight;
        b += c[2] * weight;
        w += weight;
    }
    if (w <= 0) {
        return undefined;
    }
    return [Math.round(r / w), Math.round(g / w), Math.round(b / w)];
}

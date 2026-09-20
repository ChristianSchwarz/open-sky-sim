/**
 * Deepen the land skirts of an already baked tile, in place.
 *
 * A skirt only closes the crack between two tiles as far down as it hangs, and
 * a tile several levels finer than its neighbour meets a border that strayed by
 * that neighbour's much larger tolerance; see SKIRT_SEAM_FACTOR in meshTile.ts.
 * A tile baked before the factor existed is brought up to it here without
 * re-meshing: each skirt bottom moves along the vector from its own top, which
 * is the local vertical at that place whatever the frame's tilt (the bake had to
 * reproject to hang it there; scaling the vector is enough to hang it deeper).
 *
 * The header word 52 records the factor applied, so a tile is deepened once,
 * and a tile baked with the factor already in it is left alone.
 */

import { decodePtm } from '../../src/script/terrain/ptm';
import { SKIRT_TOP_EPS_M } from './buildTile';

/** Header offsets, see the layout in ptm.ts. */
const SEAM_FACTOR_OFFSET = 52;
const BOUNDING_RADIUS_OFFSET = 28;
const SKIRT_DEPTH_OFFSET = 64;
const QUANT_SCALE_OFFSET = 20;

const I16_MAX = 32767;
/** Slack on a pair's length, in quantisation units, beyond the relative one. */
const LENGTH_SLACK_UNITS = 2;
const LENGTH_SLACK_REL = 0.01;
/** A pair further than this from the tile's own down direction is not a skirt. */
/** A tile that would need a coarser step than this stays as it is. */
const MAX_GROW = 1.5;
const DIRECTION_COS_MIN = Math.cos(4 * Math.PI / 180);

export interface DeepenResult {
    /** False when the tile already carries a factor, has no skirt, or would overflow. */
    changed: boolean;
    skirtDepthM: number;
    bottoms: number;
}

/**
 * Patch `raw` (a gunzipped PTM1, offset 0 so the views alias it) to hang its
 * land skirt `deepened(current depth)` deep, writing `marker` in the header.
 */
export function deepenSkirts(
    raw: Uint8Array, deepened: (depthM: number) => number, marker: number,
): DeepenResult {
    const tile = decodePtm(raw);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const none = { changed: false, skirtDepthM: tile.skirtDepthM, bottoms: 0 };
    if (view.getUint32(SEAM_FACTOR_OFFSET, true) !== 0 || !(tile.skirtDepthM > 0)) {
        return none;
    }
    const factor = deepened(tile.skirtDepthM) / tile.skirtDepthM;
    if (!(factor > 1.01)) {
        return none;
    }
    const p = tile.landPositions;
    const triCount = p.length / 9;
    const depthUnits = tile.skirtDepthM / tile.quantScale;
    const tol = Math.max(LENGTH_SLACK_UNITS, LENGTH_SLACK_REL * depthUnits);
    const key = (o: number): string => `${p[o]},${p[o + 1]},${p[o + 2]}`;

    // Pass 1: every edge about one skirt deep is a candidate top-bottom pair.
    interface Pair { a: number; b: number; tri: number; dir: [number, number, number] }
    const pairs: Pair[] = [];
    for (let t = 0; t < triCount; t++) {
        for (let e = 0; e < 3; e++) {
            const a = t * 9 + e * 3;
            const b = t * 9 + ((e + 1) % 3) * 3;
            const dx = p[b] - p[a];
            const dy = p[b + 1] - p[a + 1];
            const dz = p[b + 2] - p[a + 2];
            if (Math.abs(Math.hypot(dx, dy, dz) - depthUnits) <= tol) {
                pairs.push({ a, b, tri: t, dir: [dx, dy, dz] });
            }
        }
    }
    if (pairs.length === 0) {
        return none;
    }

    // The tile's own down: the direction most candidates agree on, within a
    // few degrees, sign aside. Steep ground has plenty of edges as long as the
    // skirt is deep, in every direction; the skirt's are all one direction, and
    // the biggest such cluster is it. Anything off it is a surface edge.
    const unit = pairs.map(({ dir }) => {
        const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
        return [dir[0] / l, dir[1] / l, dir[2] / l];
    });
    const agrees = (i: number, j: number): boolean =>
        Math.abs(unit[i][0] * unit[j][0] + unit[i][1] * unit[j][1] + unit[i][2] * unit[j][2]) >= DIRECTION_COS_MIN;
    let best = 0;
    let bestVotes = -1;
    const probe = Math.min(pairs.length, 400);
    for (let k = 0; k < probe; k++) {
        const i = Math.floor(k * pairs.length / probe);
        let votes = 0;
        for (let j = 0; j < pairs.length; j++) {
            votes += agrees(i, j) ? 1 : 0;
        }
        if (votes > bestVotes) {
            bestVotes = votes;
            best = i;
        }
    }
    const vertical = pairs.filter((_, j) => agrees(best, j));

    // Which end of a pair is the top. Not by direction: the frame is tilted
    // against the local vertical by however far the tile is from the frame's
    // origin, so no axis is "up". The top is the end the ground's own vertices
    // sit on - the bake hangs it SKIRT_TOP_EPS_M under the surface, which the
    // quantiser rounds to within a unit of it - and the bottom has none near.
    // A steep facet with an edge as long as the skirt is deep is vertical
    // enough to pass the pair test, but both its ends are on the ground, which
    // is what keeps it out.
    const skirtTri = new Set<number>(vertical.map(v => v.tri));
    const surface = new Set<string>();
    for (let t = 0; t < triCount; t++) {
        if (!skirtTri.has(t)) {
            for (let v = 0; v < 3; v++) {
                surface.add(key(t * 9 + v * 3));
            }
        }
    }
    // SKIRT_TOP_EPS_M in units, and one for the rounding either side of it.
    const reach = Math.ceil(SKIRT_TOP_EPS_M / tile.quantScale) + 1;
    const onGround = (o: number): boolean => {
        for (let dx = -reach; dx <= reach; dx++) {
            for (let dy = -reach; dy <= reach; dy++) {
                for (let dz = -reach; dz <= reach; dz++) {
                    if (surface.has(`${p[o] + dx},${p[o + 1] + dy},${p[o + 2] + dz}`)) {
                        return true;
                    }
                }
            }
        }
        return false;
    };
    const bottomOf = new Map<string, { top: number; bottom: number } | null>();
    for (const { a, b } of vertical) {
        const aTop = onGround(a);
        if (aTop === onGround(b)) {
            continue;
        }
        const top = aTop ? a : b;
        const bottom = aTop ? b : a;
        const k = key(bottom);
        const seen = bottomOf.get(k);
        // A bottom reached from two different tops is not a plain skirt.
        bottomOf.set(k, seen === undefined || (seen && key(seen.top) === key(top)) ? { top, bottom } : null);
    }

    // Move the bottoms. The quantiser fitted the tile to int16 with its shallow
    // skirt in it - often with a skirt bottom as the extreme vertex - so the
    // deeper one is only in range after the step grows to make room: every
    // position array is divided by the same k and quantScale multiplied by it,
    // which the loader's uniform tile scale undoes exactly. A few percent of a
    // decimetre is all it costs.
    const moved = new Map<string, [number, number, number]>();
    for (const [k, pair] of bottomOf) {
        if (!pair) {
            continue;
        }
        const next: [number, number, number] = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
            const top = p[pair.top + i];
            next[i] = Math.round(top + (p[pair.bottom + i] - top) * factor);
        }
        moved.set(k, next);
    }
    if (moved.size === 0) {
        return none;
    }
    let maxAbs = 0;
    for (const next of moved.values()) {
        maxAbs = Math.max(maxAbs, Math.abs(next[0]), Math.abs(next[1]), Math.abs(next[2]));
    }
    for (const arr of [p, tile.waterPositions, tile.riverPositions]) {
        for (let i = 0; i < arr.length; i++) {
            maxAbs = Math.max(maxAbs, Math.abs(arr[i]));
        }
    }
    const grow = Math.max(1, maxAbs / (I16_MAX - 1));
    if (grow > MAX_GROW) {
        return none;
    }
    if (grow > 1) {
        for (const arr of [tile.waterPositions, tile.riverPositions]) {
            for (let i = 0; i < arr.length; i++) {
                arr[i] = Math.round(arr[i] / grow);
            }
        }
        view.setFloat32(QUANT_SCALE_OFFSET, tile.quantScale * grow, true);
    }
    let radiusSq = 0;
    for (let o = 0; o < p.length; o += 3) {
        const next = moved.get(key(o));
        const x = next ? next[0] : p[o];
        const y = next ? next[1] : p[o + 1];
        const z = next ? next[2] : p[o + 2];
        p[o] = Math.round(x / grow);
        p[o + 1] = Math.round(y / grow);
        p[o + 2] = Math.round(z / grow);
        if (next) {
            radiusSq = Math.max(radiusSq, p[o] * p[o] + p[o + 1] * p[o + 1] + p[o + 2] * p[o + 2]);
        }
    }
    const skirtDepthM = tile.skirtDepthM * factor;
    view.setFloat32(SKIRT_DEPTH_OFFSET, skirtDepthM, true);
    view.setUint32(SEAM_FACTOR_OFFSET, marker, true);
    const radius = Math.sqrt(radiusSq) * tile.quantScale * grow;
    if (radius > tile.boundingRadiusM) {
        view.setFloat32(BOUNDING_RADIUS_OFFSET, radius, true);
    }
    return { changed: true, skirtDepthM, bottoms: moved.size };
}

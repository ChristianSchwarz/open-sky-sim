/**
 * The tile jobs a satellite (tools/satellite/satellite.ts) can run for a bake,
 * and the files each one reads and writes - shared by the coordinator
 * (tilePool.ts), which ships the inputs and applies the outputs, and the
 * satellite's compute worker, which runs the unchanged tile function against
 * a job directory holding exactly those inputs.
 *
 * Paths are `<root>/<z>/<x>/<y><ext>` with a root of
 *
 *   terrain  the mesh tree (--dir)
 *   lidar    the lidar store (data/imports/lidar/store)
 *   planet   the planet pyramid the store's signatures are checked against
 *
 * An input list may name files that do not exist: the coordinator sends
 * "absent" for those, so the satellite sees the same holes it would see here.
 * A list that misses a file the tile function reads makes the satellite's
 * output differ from a local run - tools/verify_satellite.ts checks that.
 */

import * as path from 'node:path';
import { FarLandConfig, FarLandResult, farLandOfTile, FAR_LAND_EXT } from './farLandTile';
import { GradeConfig, GradeResult, PASS1_EXT, bedsOfTile, gradeTile } from './gradeTile';
import { TileKey } from '../../src/script/terrain/tiling';

export type RemoteRoot = 'terrain' | 'lidar' | 'planet';
export type RemoteKind = 'grade1' | 'grade2' | 'farland';

/** What a kind's config looks like on the wire: its directories are root names, not paths. */
export type RemoteConfig = GradeConfig | FarLandConfig;

const rel = (root: RemoteRoot, k: TileKey, ext: string) => `${root}/${k.z}/${k.x}/${k.y}${ext}`;

function ring(k: TileKey, r: number): TileKey[] {
    const out: TileKey[] = [];
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            out.push({ z: k.z, x: k.x + dx, y: k.y + dy });
        }
    }
    return out;
}

/** Every file `kind` may read for tile `k`, as root-relative paths. */
export function inputsOf(kind: RemoteKind, cfg: RemoteConfig, k: TileKey): string[] {
    if (kind === 'farland') {
        return [rel('terrain', k, '.ptm'), rel('terrain', k, '.ptr')];
    }
    const g = cfg as GradeConfig;
    // railBedInputs.ts: the tile's land and strokes, the 3x3 bridges; the
    // neighbours' centre heights come with the config, not their .ptm.
    const out = [rel('terrain', k, '.ptm'), rel('terrain', k, '.ptr')];
    for (const nb of ring(k, 1)) {
        out.push(rel('terrain', nb, '.pbr'));
        if (g.lidar) {
            // lidarStore.ts: the 3x3 measurements, each checked against its leaf's vectors.
            out.push(rel('lidar', nb, '.lms'), rel('planet', nb, '.rvr'), rel('planet', nb, '.rbr'));
        }
        if (kind === 'grade2') {
            // gradeTile.ts neighbourBeds (and the tile's own .pbd, replaced or removed).
            out.push(rel('terrain', nb, PASS1_EXT), rel('terrain', nb, '.pbd'));
        }
    }
    return out;
}

/** Every file `kind` may write or remove for tile `k`. */
export function outputsOf(kind: RemoteKind, k: TileKey): string[] {
    switch (kind) {
        case 'grade1': return [rel('terrain', k, PASS1_EXT)];
        case 'grade2': return [rel('terrain', k, '.ptm'), rel('terrain', k, '.ptr'), rel('terrain', k, '.pbd')];
        case 'farland': return [rel('terrain', k, FAR_LAND_EXT)];
    }
}

/**
 * The config a satellite sends: directories replaced by root names, and the
 * grade's centre heights cut down to the 5x5 round the tile (all it reads).
 */
export function wireConfig(kind: RemoteKind, cfg: RemoteConfig, k: TileKey): RemoteConfig {
    if (kind === 'farland') {
        return { ...(cfg as FarLandConfig), dir: 'terrain' };
    }
    const g = cfg as GradeConfig;
    const centreHeights: Record<string, number> = {};
    for (const nb of ring(k, 2)) {
        const key = `${nb.z}/${nb.x}/${nb.y}`;
        if (g.centreHeights[key] !== undefined) {
            centreHeights[key] = g.centreHeights[key];
        }
    }
    return { ...g, dir: 'terrain', centreHeights, lidar: g.lidar ? { store: 'lidar', planet: 'planet' } : undefined };
}

/** Run one job against `jobDir`, which holds the job's inputs under their root names. */
export function runRemoteJob(kind: RemoteKind, cfg: RemoteConfig, k: TileKey, jobDir: string): GradeResult | FarLandResult {
    if (kind === 'farland') {
        const f = cfg as FarLandConfig;
        return farLandOfTile({ ...f, dir: path.join(jobDir, f.dir) }, k);
    }
    const g = cfg as GradeConfig;
    const local: GradeConfig = {
        ...g,
        dir: path.join(jobDir, g.dir),
        lidar: g.lidar ? { store: path.join(jobDir, g.lidar.store), planet: path.join(jobDir, g.lidar.planet) } : undefined,
    };
    return kind === 'grade1' ? bedsOfTile(local, k) : gradeTile(local, k);
}

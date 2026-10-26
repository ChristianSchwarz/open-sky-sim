/**
 * The tile jobs a satellite (tools/satellite/satellite.ts) can run for a bake,
 * and the files each one reads and writes - shared by the coordinator
 * (tilePool.ts), which ships the inputs and applies the outputs, and the
 * satellite's compute worker, which runs the unchanged tile function against
 * a job directory holding exactly those inputs.
 *
 * Paths are `<root>/<z>/<x>/<y><ext>` with a root of
 *
 *   terrain  the mesh tree (--dir / --out)
 *   lidar    the lidar store (data/imports/lidar/store)
 *   bstore   the building colour store (data/imports/buildings/store)
 *   planet   the planet pyramid: heights, vectors, cover
 *   texcache the far-tile texture bake's leaf rasters
 *   pytools  the Python scripts a Python stage runs (tools/*.py): `pytools/name.py`
 *   pbf      the OSM extract a chunk stage reads (pyChunk.ts): `pbf/name.osm.pbf`
 *
 * An input list may name files that do not exist: the coordinator sends
 * "absent" for those, so the satellite sees the same holes it would see here.
 * A list that misses a file the tile function reads makes the satellite's
 * output differ from a local run - tools/verify_satellite.ts checks that.
 *
 * An output the satellite finds missing after the run is removed here only
 * if it was among the inputs (the tile function deleted it); one that was
 * never sent and never written was not touched, and stays as it is.
 */

import * as path from 'node:path';
import { FarLandConfig, FarLandResult, farLandOfTile, FAR_LAND_EXT } from './farLandTile';
import { GradeConfig, GradeResult, PASS1_EXT, bedsOfTile, gradeTile } from './gradeTile';
import { MeshTileConfig, TileProcessResult, processTile } from './meshTile';
import { MIN_SEAM_ZOOM } from './borderConform';
import { TexLeafConfig, TexLeafResult, texLeaf } from './texLeaf';
import { PY_STAGES, PyLeafConfig, PyLeafKind, PyLeafResult, pyLeaf } from './pyLeaf';
import { PyChunkConfig, PyChunkResult, chunkInputs, chunkOutputs, pyChunk } from './pyChunk';
import { localPyImports } from './pyServe';
import { TileKey } from '../../src/script/terrain/tiling';

export type RemoteRoot = 'terrain' | 'lidar' | 'bstore' | 'planet' | 'texcache' | 'pytools' | 'pbf';
export type RemoteKind = 'grade1' | 'grade2' | 'farland' | 'mesh' | 'texleaf' | PyLeafKind | 'pychunk';

/** What a kind's config looks like on the wire: its directories are root names, not paths. */
export type RemoteConfig = GradeConfig | FarLandConfig | MeshTileConfig | TexLeafConfig | PyLeafConfig | PyChunkConfig;
export type RemoteResult = GradeResult | FarLandResult | TileProcessResult | TexLeafResult | PyLeafResult | PyChunkResult | undefined;

const isPyLeaf = (kind: RemoteKind): kind is PyLeafKind => kind in PY_STAGES;

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

const pyClosures = new Map<string, string[]>();

/** A Python stage's script and the local modules it imports, as `pytools/` paths. */
function pyInputs(toolsDir: string, entry: string): string[] {
    const key = `${toolsDir}|${entry}`;
    let files = pyClosures.get(key);
    if (!files) {
        files = localPyImports(toolsDir, entry).map(f => `pytools/${f}`);
        pyClosures.set(key, files);
    }
    return files;
}

/** Every file `kind` may read for tile `k`, as root-relative paths. */
export function inputsOf(kind: RemoteKind, cfg: RemoteConfig, k: TileKey): string[] {
    if (kind === 'pychunk') {
        const c = cfg as PyChunkConfig;
        return chunkInputs(c, k, entry => pyInputs(c.pytools, entry));
    }
    if (isPyLeaf(kind)) {
        // The script's measure_leaf: the leaf's planet files (pyLeaf.ts PY_STAGES), and the script itself.
        const stage = PY_STAGES[kind];
        return [...stage.inputs.map(ext => rel('planet', k, ext)), ...pyInputs((cfg as PyLeafConfig).pytools, stage.script)];
    }
    if (kind === 'mesh') {
        // meshTile.ts processTile: the tile's heights, road grade, coast and
        // land use, cover and road vectors; the parent's heights for the
        // skirt; and the ancestors' down to MIN_SEAM_ZOOM, whose borders
        // conformBorders follows.
        const out = ['.pdm', '.rgr', '.lvr', '.plc', '.rvr'].map(ext => rel('planet', k, ext));
        for (let az = k.z - 1; az >= 0 && (az >= MIN_SEAM_ZOOM || az === k.z - 1); az--) {
            const s = k.z - az;
            out.push(rel('planet', { z: az, x: k.x >> s, y: k.y >> s }, '.pdm'));
        }
        return out;
    }
    if (kind === 'texleaf') {
        // texLeaf.ts: the leaf's land, and its footprints when buildings are painted.
        return (cfg as TexLeafConfig).buildings ? [rel('terrain', k, '.ptm'), rel('terrain', k, '.pbh')] : [rel('terrain', k, '.ptm')];
    }
    if (kind === 'farland') {
        // The tile's own sidecar too: a leaf with nothing worth simplifying removes it.
        return [rel('terrain', k, '.ptm'), rel('terrain', k, '.ptr'), rel('terrain', k, FAR_LAND_EXT)];
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
export function outputsOf(kind: RemoteKind, k: TileKey, cfg?: RemoteConfig): string[] {
    switch (kind) {
        case 'pychunk': return chunkOutputs(cfg as PyChunkConfig, k);
        case 'grade1': return [rel('terrain', k, PASS1_EXT)];
        case 'grade2': return [rel('terrain', k, '.ptm'), rel('terrain', k, '.ptr'), rel('terrain', k, '.pbd')];
        case 'farland': return [rel('terrain', k, FAR_LAND_EXT)];
        case 'mesh': return [rel('terrain', k, '.ptm')];
        case 'texleaf': return [rel('texcache', k, '.ptx')];
        case 'lidarleaf':
        case 'roofleaf': return [rel(PY_STAGES[kind].storeRoot, k, PY_STAGES[kind].storeExt)];
    }
}

/**
 * The config a satellite sends: directories replaced by root names, and the
 * grade's centre heights cut down to the 5x5 round the tile (all it reads).
 */
export function wireConfig(kind: RemoteKind, cfg: RemoteConfig, k: TileKey): RemoteConfig {
    if (kind === 'mesh') {
        return { ...(cfg as MeshTileConfig), src: 'planet', out: 'terrain' };
    }
    if (kind === 'texleaf') {
        return { ...(cfg as TexLeafConfig), dir: 'terrain', cache: 'texcache' };
    }
    if (isPyLeaf(kind)) {
        return { ...(cfg as PyLeafConfig), planet: 'planet', store: PY_STAGES[kind].storeRoot, pytools: 'pytools' };
    }
    if (kind === 'pychunk') {
        const c = cfg as PyChunkConfig;
        return { ...c, planet: 'planet', pbf: `pbf/${path.basename(c.pbf)}`, pytools: 'pytools' };
    }
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

/**
 * Run one job against `jobDir`, which holds the job's inputs under their root
 * names. With `jobDir` empty the config's directories are the real ones (a
 * local worker, remoteJobWorker.ts). A Python stage answers asynchronously.
 */
export function runRemoteJob(kind: RemoteKind, cfg: RemoteConfig, k: TileKey, jobDir: string): RemoteResult | Promise<RemoteResult> {
    if (kind === 'pychunk') {
        return pyChunk(cfg as PyChunkConfig, k, jobDir);
    }
    if (isPyLeaf(kind)) {
        const l = cfg as PyLeafConfig;
        return pyLeaf(kind, {
            planet: path.join(jobDir, l.planet), store: path.join(jobDir, l.store), pytools: path.join(jobDir, l.pytools),
        }, k, jobDir !== '');
    }
    if (kind === 'mesh') {
        const m = cfg as MeshTileConfig;
        return processTile({ ...m, src: path.join(jobDir, m.src), out: path.join(jobDir, m.out) }, k);
    }
    if (kind === 'texleaf') {
        const t = cfg as TexLeafConfig;
        return texLeaf({ ...t, dir: path.join(jobDir, t.dir), cache: path.join(jobDir, t.cache) }, k);
    }
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

// --- the config on the wire ---------------------------------------------------

/**
 * JSON that keeps typed arrays (the mesh config's ENU bases hold
 * Float64Arrays, which plain JSON turns into objects with numbered keys).
 * The satellite decodes it in its compute thread, so this format travels with
 * the tile code and not with the exe.
 */
export function encodeWire(value: unknown): string {
    return JSON.stringify(value, (_k, v: unknown) => (ArrayBuffer.isView(v) && !(v instanceof DataView)
        ? { $typed: v.constructor.name, v: Array.from(v as unknown as ArrayLike<number>) }
        : v));
}

const TYPED: Record<string, new (v: number[]) => unknown> = {
    Float64Array, Float32Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array, Uint8Array, Uint8ClampedArray,
};

export function decodeWire<T>(text: string): T {
    return JSON.parse(text, (_k, v: unknown) => {
        if (v && typeof v === 'object' && '$typed' in v) {
            const t = v as { $typed: string; v: number[] };
            const Ctor = TYPED[t.$typed];
            if (!Ctor) {
                throw new Error(`unknown typed array ${t.$typed}`);
            }
            return new Ctor(t.v);
        }
        return v;
    }) as T;
}

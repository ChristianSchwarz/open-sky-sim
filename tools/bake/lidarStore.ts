/**
 * The lidar store: what tools/measure_lidar.py measured along a leaf's graded
 * lines and at its bridges' ends, against the best open lidar terrain model
 * there (Bavaria, Austria, Switzerland, the German states, IGN for Gran
 * Canaria). Bake-only, never shipped: data/imports/lidar/store/12/x/y.lms.
 *
 * Measured against the planet pyramid's OSM vectors (the .rvr lines and the
 * .rbr spans), not against a mesh, so a re-mesh or re-grade keeps it; a
 * re-baked .rvr or .rbr is noticed by its signature (crc32 of the file) and
 * its half of the store is ignored until measured again.
 *
 *   lines    every graded-class line (railBed.ts bedTierOf), sampled every
 *            STEP_M (STREET_STEP_M for streets): the crown (median lidar
 *            height across the carriageway) and the lift (crown minus the
 *            median lidar ground 20-40 m out beside it, both sides), in the
 *            source's own datum, and which source.
 *   bridges  per .rbr span, per end: how far the approach just beyond the end
 *            stands above the ground beside it (the prototype's approachLift).
 *
 * Layout LMS1, little-endian, gzipped, 40-byte header:
 *
 *    0  u32 magic 'LMS1'       16  u32 rvrSig (crc32 of the .rvr; 0 = none)
 *    4  u8  version = 1        20  u32 rbrSig (crc32 of the .rbr; 0 = none)
 *    5  u8  z                  24  u32 attempted (bit per source tried)
 *    6  u16 reserved           28  u32 line count
 *    8  u32 x                  32  u32 bridge count
 *   12  u32 y                  36  u32 reserved
 *
 *   per line: u8 tier, u8 reserved, u16 half width (dm), u16 n, i32 lon and
 *   i32 lat of the first sample (1e-7 degrees from the tile's south-west
 *   corner), (n - 1) x (i16 dlon, i16 dlat) to each next one, n x u16 crown
 *   (dm, CROWN_OFFSET_M; 0 = unmeasured), n x i16 lift (cm), n x u8 source.
 *   per bridge: 2 x i16 approach lift (cm; NO_LIFT = unmeasured), start end
 *   first.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { TileKey, tileBounds } from '../../src/script/terrain/tiling';

const LMS_MAGIC = 0x31534d4c; // 'LMS1'
const LMS_VERSION = 1;
const HEADER_BYTES = 40;
/** Positions are integers in this many degrees. */
export const LMS_DEG = 1e-7;
const CROWN_OFFSET_M = -200;
const CROWN_DM = 10;
export const NO_LIFT = -32768;

/** Sample spacing along railways, Autobahn and highways, and along streets, metres. */
export const STEP_M = 5;
export const STREET_STEP_M = 10;

export const LIDAR_STORE_DIR = 'data/imports/lidar/store';

/** Source ids (bit numbers of `attempted`), as tools/measure_lidar.py numbers them. */
export const LIDAR_SOURCES: Readonly<Record<number, string>> = {
    1: 'bavaria', 2: 'austria', 3: 'switzerland', 4: 'niedersachsen', 5: 'baden-wuerttemberg',
    6: 'brandenburg-berlin', 7: 'hessen', 8: 'nrw', 9: 'sachsen-anhalt', 10: 'rheinland-pfalz',
    11: 'mecklenburg-vorpommern', 12: 'sachsen', 13: 'thueringen', 14: 'schleswig-holstein',
    15: 'hamburg', 16: 'bremen', 17: 'gran-canaria',
};

export interface LmsLine {
    tier: number;
    halfM: number;
    /** Sample positions, degrees. */
    lon: Float64Array;
    lat: Float64Array;
    /** Lidar height across the carriageway, source datum, metres; NaN unmeasured. */
    crown: Float32Array;
    /** Crown minus the ground beside it, metres (fill > 0); NaN unmeasured. */
    lift: Float32Array;
    /** Source id per sample, 0 unmeasured. */
    source: Uint8Array;
}

export interface LmsTile {
    z: number;
    x: number;
    y: number;
    rvrSig: number;
    rbrSig: number;
    attempted: number;
    lines: LmsLine[];
    /** Per .rbr span, start and end approach lifts, metres; NaN unmeasured. */
    bridgeLifts: Float32Array;
}

export function encodeLms(t: LmsTile): Uint8Array {
    let bytes = HEADER_BYTES + t.bridgeLifts.length * 2;
    for (const l of t.lines) {
        const n = l.lon.length;
        bytes += 14 + (n - 1) * 4 + n * 5;
    }
    const buf = new ArrayBuffer(bytes);
    const dv = new DataView(buf);
    dv.setUint32(0, LMS_MAGIC, true);
    dv.setUint8(4, LMS_VERSION);
    dv.setUint8(5, t.z);
    dv.setUint32(8, t.x, true);
    dv.setUint32(12, t.y, true);
    dv.setUint32(16, t.rvrSig >>> 0, true);
    dv.setUint32(20, t.rbrSig >>> 0, true);
    dv.setUint32(24, t.attempted >>> 0, true);
    dv.setUint32(28, t.lines.length, true);
    dv.setUint32(32, t.bridgeLifts.length / 2, true);
    const sw = tileBounds({ z: t.z, x: t.x, y: t.y });
    let o = HEADER_BYTES;
    for (const l of t.lines) {
        const n = l.lon.length;
        dv.setUint8(o, l.tier);
        dv.setUint16(o + 2, Math.round(l.halfM * 10), true);
        dv.setUint16(o + 4, n, true);
        o += 6;
        const qx = Array.from(l.lon, v => Math.round((v - sw.west) / LMS_DEG));
        const qy = Array.from(l.lat, v => Math.round((v - sw.south) / LMS_DEG));
        dv.setInt32(o, qx[0], true);
        dv.setInt32(o + 4, qy[0], true);
        o += 8;
        for (let i = 1; i < n; i++) {
            const dx = qx[i] - qx[i - 1], dy = qy[i] - qy[i - 1];
            if (Math.abs(dx) > 32767 || Math.abs(dy) > 32767) {
                throw new Error(`LMS: samples ${i - 1}-${i} too far apart`);
            }
            dv.setInt16(o, dx, true);
            dv.setInt16(o + 2, dy, true);
            o += 4;
        }
        for (let i = 0; i < n; i++, o += 2) {
            const c = l.crown[i];
            dv.setUint16(o, Number.isFinite(c) ? Math.max(1, Math.min(65535, Math.round((c - CROWN_OFFSET_M) * CROWN_DM))) : 0, true);
        }
        for (let i = 0; i < n; i++, o += 2) {
            dv.setInt16(o, cm(l.lift[i]), true);
        }
        for (let i = 0; i < n; i++) {
            dv.setUint8(o++, l.source[i]);
        }
    }
    for (let i = 0; i < t.bridgeLifts.length; i++, o += 2) {
        dv.setInt16(o, cm(t.bridgeLifts[i]), true);
    }
    return new Uint8Array(buf);
}

function cm(v: number): number {
    return Number.isFinite(v) ? Math.max(-32767, Math.min(32767, Math.round(v * 100))) : NO_LIFT;
}

export function decodeLms(bytes: Uint8Array): LmsTile {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== LMS_MAGIC) {
        throw new Error('LMS: bad magic');
    }
    if (dv.getUint8(4) !== LMS_VERSION) {
        throw new Error(`LMS: version ${dv.getUint8(4)}`);
    }
    const z = dv.getUint8(5), x = dv.getUint32(8, true), y = dv.getUint32(12, true);
    const lineCount = dv.getUint32(28, true), bridgeCount = dv.getUint32(32, true);
    const sw = tileBounds({ z, x, y });
    const lines: LmsLine[] = [];
    let o = HEADER_BYTES;
    for (let l = 0; l < lineCount; l++) {
        const tier = dv.getUint8(o), halfM = dv.getUint16(o + 2, true) / 10, n = dv.getUint16(o + 4, true);
        o += 6;
        const lon = new Float64Array(n), lat = new Float64Array(n);
        let qx = dv.getInt32(o, true), qy = dv.getInt32(o + 4, true);
        o += 8;
        for (let i = 0; i < n; i++) {
            if (i > 0) {
                qx += dv.getInt16(o, true);
                qy += dv.getInt16(o + 2, true);
                o += 4;
            }
            lon[i] = sw.west + qx * LMS_DEG;
            lat[i] = sw.south + qy * LMS_DEG;
        }
        const crown = new Float32Array(n), lift = new Float32Array(n), source = new Uint8Array(n);
        for (let i = 0; i < n; i++, o += 2) {
            const c = dv.getUint16(o, true);
            crown[i] = c === 0 ? NaN : c / CROWN_DM + CROWN_OFFSET_M;
        }
        for (let i = 0; i < n; i++, o += 2) {
            const v = dv.getInt16(o, true);
            lift[i] = v === NO_LIFT ? NaN : v / 100;
        }
        for (let i = 0; i < n; i++) {
            source[i] = dv.getUint8(o++);
        }
        lines.push({ tier, halfM, lon, lat, crown, lift, source });
    }
    const bridgeLifts = new Float32Array(bridgeCount * 2);
    for (let i = 0; i < bridgeLifts.length; i++, o += 2) {
        const v = dv.getInt16(o, true);
        bridgeLifts[i] = v === NO_LIFT ? NaN : v / 100;
    }
    return { z, x, y, rvrSig: dv.getUint32(16, true), rbrSig: dv.getUint32(20, true), attempted: dv.getUint32(24, true), lines, bridgeLifts };
}

/** A planet vector file's signature: crc32 of its bytes, 0 when absent. */
export function fileSignature(file: string): number {
    return fs.existsSync(file) ? zlib.crc32(fs.readFileSync(file)) >>> 0 : 0;
}

export interface LineMeasure {
    /** Source datum, metres. */
    crown: number;
    /** Crown minus the ground beside, metres. */
    lift: number;
    source: number;
}

/** Index cell, metres. */
const CELL_M = 8;
/** A query this far off a measured line is not on it, metres. */
const MATCH_M = 3;
/** A query heading this far off the line's (|cos|) is a crossing line, not this one. */
const MATCH_COS = 0.8;

interface Seg {
    line: LmsLine;
    i: number;
    ax: number; ay: number; bx: number; by: number;
}

/** A leaf's lines (and its eight neighbours'), indexed in local metres. */
class LineIndex {
    readonly cells = new Map<number, Seg[]>();
    constructor(readonly lon0: number, readonly lat0: number, readonly mLon: number, readonly mLat: number) {}

    x(lon: number) { return (lon - this.lon0) * this.mLon; }
    y(lat: number) { return (lat - this.lat0) * this.mLat; }

    add(line: LmsLine) {
        for (let i = 0; i + 1 < line.lon.length; i++) {
            const s: Seg = { line, i, ax: this.x(line.lon[i]), ay: this.y(line.lat[i]), bx: this.x(line.lon[i + 1]), by: this.y(line.lat[i + 1]) };
            const c0 = Math.floor((Math.min(s.ax, s.bx) - MATCH_M) / CELL_M), c1 = Math.floor((Math.max(s.ax, s.bx) + MATCH_M) / CELL_M);
            const r0 = Math.floor((Math.min(s.ay, s.by) - MATCH_M) / CELL_M), r1 = Math.floor((Math.max(s.ay, s.by) + MATCH_M) / CELL_M);
            for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                    const key = r * 65536 + c;
                    const list = this.cells.get(key);
                    if (list) {
                        list.push(s);
                    } else {
                        this.cells.set(key, [s]);
                    }
                }
            }
        }
    }

    at(lon: number, lat: number, dirE: number, dirN: number, tier: number): LineMeasure | undefined {
        const px = this.x(lon), py = this.y(lat);
        const list = this.cells.get(Math.floor(py / CELL_M) * 65536 + Math.floor(px / CELL_M));
        if (!list) {
            return undefined;
        }
        const dl = Math.hypot(dirE, dirN) || 1;
        let best: Seg | undefined, bestD = MATCH_M, bestT = 0;
        for (const s of list) {
            if (s.line.tier !== tier) {
                continue;
            }
            const dx = s.bx - s.ax, dy = s.by - s.ay, len = Math.hypot(dx, dy);
            if (len < 1e-6 || Math.abs((dx * dirE + dy * dirN) / (len * dl)) < MATCH_COS) {
                continue;
            }
            const t = Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / (len * len)));
            const d = Math.hypot(px - s.ax - dx * t, py - s.ay - dy * t);
            if (d < bestD) {
                bestD = d;
                best = s;
                bestT = t;
            }
        }
        if (!best) {
            return undefined;
        }
        const l = best.line, i = best.i;
        const okA = Number.isFinite(l.crown[i]) && Number.isFinite(l.lift[i]);
        const okB = Number.isFinite(l.crown[i + 1]) && Number.isFinite(l.lift[i + 1]);
        if (okA && okB) {
            return {
                crown: l.crown[i] + (l.crown[i + 1] - l.crown[i]) * bestT,
                lift: l.lift[i] + (l.lift[i + 1] - l.lift[i]) * bestT,
                source: bestT < 0.5 ? l.source[i] : l.source[i + 1],
            };
        }
        // One measured end: only on its own half of the gap.
        const j = okA && bestT <= 0.5 ? i : okB && bestT >= 0.5 ? i + 1 : -1;
        return j < 0 ? undefined : { crown: l.crown[j], lift: l.lift[j], source: l.source[j] };
    }
}

const tilePath = (dir: string, k: TileKey, ext: string) => path.join(dir, String(k.z), String(k.x), `${k.y}${ext}`);

/**
 * The store, read for one bake: leaves decoded on demand (a few kept), stale
 * halves dropped against the planet pyramid's current .rvr and .rbr.
 */
export class LidarStore {
    private readonly tiles = new Map<string, LmsTile | null>();
    private readonly indices = new Map<string, LineIndex>();
    readonly stale = { lines: 0, bridges: 0 };

    constructor(readonly dir = LIDAR_STORE_DIR, readonly planetDir = 'assets/planet', private readonly keep = 32) {}

    /** Whether the store has anything at all (a bake without it skips the lidar quietly). */
    exists(): boolean {
        return fs.existsSync(this.dir);
    }

    /** The leaf's measurements, with a stale half emptied; undefined when never measured. */
    tile(k: TileKey): LmsTile | undefined {
        const key = `${k.z}/${k.x}/${k.y}`;
        let t = this.tiles.get(key);
        if (t === undefined) {
            t = null;
            const p = tilePath(this.dir, k, '.lms');
            if (fs.existsSync(p)) {
                const decoded = decodeLms(zlib.gunzipSync(fs.readFileSync(p)));
                if (decoded.rvrSig !== fileSignature(tilePath(this.planetDir, k, '.rvr'))) {
                    decoded.lines = [];
                    this.stale.lines++;
                }
                if (decoded.rbrSig !== fileSignature(tilePath(this.planetDir, k, '.rbr'))) {
                    decoded.bridgeLifts = new Float32Array(0);
                    this.stale.bridges++;
                }
                t = decoded;
            }
            this.tiles.set(key, t);
            if (this.tiles.size > this.keep * 9) {
                this.tiles.delete(this.tiles.keys().next().value!);
            }
        }
        return t ?? undefined;
    }

    private index(k: TileKey): LineIndex {
        const key = `${k.z}/${k.x}/${k.y}`;
        let idx = this.indices.get(key);
        if (!idx) {
            const b = tileBounds(k);
            const lat = (b.south + b.north) / 2;
            idx = new LineIndex(b.west, b.south, 111412.84 * Math.cos((lat * Math.PI) / 180), 111132.92);
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    for (const l of this.tile({ z: k.z, x: k.x + dx, y: k.y + dy })?.lines ?? []) {
                        idx.add(l);
                    }
                }
            }
            this.indices.set(key, idx);
            if (this.indices.size > this.keep) {
                this.indices.delete(this.indices.keys().next().value!);
            }
        }
        return idx;
    }

    /**
     * The measurement at (lon, lat) of a line of `tier` heading (dirE, dirN):
     * the nearest measured line of that tier within MATCH_M running the same
     * way, interpolated between its two samples there; undefined if none.
     */
    lineAt(k: TileKey, lon: number, lat: number, dirE: number, dirN: number, tier: number): LineMeasure | undefined {
        return this.index(k).at(lon, lat, dirE, dirN, tier);
    }

    /** A span's measured approach lift at its start (end 0) or end (1), metres; undefined unmeasured. */
    bridgeEndLift(k: TileKey, span: number, end: 0 | 1): number | undefined {
        const v = this.tile(k)?.bridgeLifts[span * 2 + end];
        return v === undefined || Number.isNaN(v) ? undefined : v;
    }
}

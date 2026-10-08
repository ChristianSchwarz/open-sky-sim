import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { test } from 'node:test';
import { tileBounds } from '../../src/script/terrain/tiling';
import { LidarStore, LmsLine, LmsTile, decodeLms, encodeLms } from './lidarStore';

const K = { z: 12, x: 4348, y: 966 };
const B = tileBounds(K);
const LAT = (B.south + B.north) / 2;
const M_LON = 111412.84 * Math.cos((LAT * Math.PI) / 180), M_LAT = 111132.92;

/** A straight line through the tile's centre, `off` metres north of it, heading (e, n), sampled every 5 m. */
function line(tier: number, e: number, n: number, off: number, crown: (i: number) => number, lift: (i: number) => number): LmsLine {
    const count = 41;
    const lon = new Float64Array(count), lat = new Float64Array(count);
    const c = new Float32Array(count), l = new Float32Array(count), s = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
        const d = (i - 20) * 5;
        lon[i] = (B.west + B.east) / 2 + (e * d) / M_LON;
        lat[i] = LAT + (n * d + off) / M_LAT;
        c[i] = crown(i);
        l[i] = lift(i);
        s[i] = 1;
    }
    return { tier, halfM: 3.5, lon, lat, crown: c, lift: l, source: s };
}

function tile(lines: LmsLine[], bridges: number[] = []): LmsTile {
    return { ...K, rvrSig: 0, rbrSig: 0, attempted: 3, lines, bridgeLifts: Float32Array.from(bridges) };
}

test('LMS1 round trip keeps positions to a centimetre and heights to their quanta', () => {
    const t = tile([line(1, 1, 0, 0, i => 700 + i * 0.37, i => (i === 7 ? NaN : i * 0.1 - 2))], [3.25, NaN]);
    const back = decodeLms(encodeLms(t));
    assert.equal(back.lines.length, 1);
    assert.equal(back.attempted, 3);
    const a = t.lines[0], b = back.lines[0];
    assert.equal(b.tier, 1);
    assert.equal(b.halfM, 3.5);
    for (let i = 0; i < a.lon.length; i++) {
        assert.ok(Math.abs((a.lon[i] - b.lon[i]) * M_LON) < 0.02 && Math.abs((a.lat[i] - b.lat[i]) * M_LAT) < 0.02, `position ${i}`);
        assert.ok(Math.abs(a.crown[i] - b.crown[i]) <= 0.05, `crown ${i}`);
        if (i === 7) {
            assert.ok(Number.isNaN(b.lift[i]));
        } else {
            assert.ok(Math.abs(a.lift[i] - b.lift[i]) <= 0.005, `lift ${i}`);
        }
    }
    assert.ok(Math.abs(back.bridgeLifts[0] - 3.25) < 1e-6);
    assert.ok(Number.isNaN(back.bridgeLifts[1]));
});

function storeWith(t: LmsTile): LidarStore {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-'));
    const p = path.join(dir, 'store', '12', String(K.x), `${K.y}.lms`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, zlib.gzipSync(encodeLms(t)));
    return new LidarStore(path.join(dir, 'store'), path.join(dir, 'planet'));
}

test('a query takes the line it runs along: not a crossing one, not the other carriageway', () => {
    const cx = (B.west + B.east) / 2;
    const store = storeWith(tile([
        line(1, 1, 0, 0, () => 700, () => 4),     // east-bound, on the centre
        line(1, 1, 0, 10, () => 702, () => -3),   // the parallel carriageway, 10 m north
        line(1, 0, 1, 0, () => 710, () => 9),     // crossing it, north-bound
        line(2, 1, 0, 0, () => 690, () => 1),     // another tier on the same spot
    ]));
    const east = store.lineAt(K, cx + 12 / M_LON, LAT + 1 / M_LAT, 1, 0, 1);
    assert.equal(east?.lift, 4);
    const other = store.lineAt(K, cx + 12 / M_LON, LAT + 9 / M_LAT, -1, 0, 1);
    assert.equal(other?.lift, -3);
    const crossing = store.lineAt(K, cx, LAT + 30 / M_LAT, 0, 1, 1);
    assert.equal(crossing?.lift, 9);
    assert.equal(store.lineAt(K, cx + 12 / M_LON, LAT, 1, 0, 2)?.lift, 1);
    assert.equal(store.lineAt(K, cx + 12 / M_LON, LAT + 5 / M_LAT, 1, 0, 1), undefined, '5 m off both carriageways');
    assert.equal(store.lineAt(K, cx + 12 / M_LON, LAT, 1, 0, 3), undefined, 'no street there');
});

test('between samples the measurement is interpolated; a gap is only bridged on its measured half', () => {
    const cx = (B.west + B.east) / 2;
    const store = storeWith(tile([line(0, 1, 0, 0, i => 700 + i, i => (i === 21 ? NaN : i))]));
    const mid = store.lineAt(K, cx + 2.5 / M_LON - 25 / M_LON, LAT, 1, 0, 0); // between samples 15 and 16
    assert.ok(mid && Math.abs(mid.lift - 15.5) < 0.05 && Math.abs(mid.crown - 715.5) < 0.1);
    assert.ok(Math.abs(store.lineAt(K, cx + 1 / M_LON, LAT, 1, 0, 0)!.lift - 20) < 1e-6, 'near the measured end of the gap');
    assert.equal(store.lineAt(K, cx + 4 / M_LON, LAT, 1, 0, 0), undefined, 'near the unmeasured end');
});

test('bridge lifts are dropped when the .rbr changed since measuring', () => {
    const t = tile([], [2, 3]);
    t.rbrSig = 12345;
    const store = storeWith(t);
    assert.equal(store.bridgeEndLift(K, 0, 0), undefined);
    assert.equal(store.stale.bridges, 1);
    const fresh = storeWith(tile([], [2, NaN]));
    assert.equal(fresh.bridgeEndLift(K, 0, 0), 2);
    assert.equal(fresh.bridgeEndLift(K, 0, 1), undefined);
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
    PTM_GEOMETRIC_ERROR_OFFSET, PTM_HEADER_BYTES, PTM_MAGIC, PTM_VERSION,
    readPtmGeometricError, writePtmGeometricError,
} from '../../src/script/terrain/ptm';
import {
    TileMeta, foldPtmErrors, newErrorFoldStats, parentTileKey, propagateGeometricErrors,
    readPtmHeaderError,
} from './errorFold';

describe('parentTileKey', () => {
    it('halves x and y and stops at the root', () => {
        assert.equal(parentTileKey('12/3725/1295'), '11/1862/647');
        assert.equal(parentTileKey('11/1862/647'), '10/931/323');
        assert.equal(parentTileKey('1/1/0'), '0/0/0');
        assert.equal(parentTileKey('0/1/0'), undefined);
    });
});

describe('propagateGeometricErrors', () => {
    // Porto Santo, 2026-09-15: the z10 tile under the island's east half
    // said 47 m while the z11 tile beneath it said 507 m, so the governor
    // held it at z10 beside a west half already drawn from the leaves.
    const own = {
        '9/465/161': 550,
        '10/931/323': 47,
        '11/1862/647': 507,
        '12/3724/1294': 418,
        '12/3724/1295': 494,
        '12/3725/1294': 4.7,
        '12/3725/1295': 18,
        '10/930/324': 46,
        '11/1861/648': 40,
        '12/3722/1296': 4.7,
    };

    it('raises a parent to the largest figure beneath it', () => {
        const drawn = propagateGeometricErrors(own);
        assert.equal(drawn.get('10/931/323'), 507);
        assert.equal(drawn.get('11/1862/647'), 507);
        assert.equal(drawn.get('9/465/161'), 550);
    });

    it('leaves a tile alone when nothing beneath it is worse', () => {
        const drawn = propagateGeometricErrors(own);
        assert.equal(drawn.get('10/930/324'), 46);
        assert.equal(drawn.get('11/1861/648'), 40);
        assert.equal(drawn.get('12/3724/1295'), 494);
    });

    it('is a fixed point: folding the folded figures changes nothing', () => {
        const once = propagateGeometricErrors(own);
        const twice = propagateGeometricErrors(Object.fromEntries(once));
        assert.deepEqual([...twice.entries()].sort(), [...once.entries()].sort());
    });

    it('does not invent a parent the pyramid lacks', () => {
        const drawn = propagateGeometricErrors({ '12/0/0': 5 });
        assert.deepEqual([...drawn.keys()], ['12/0/0']);
    });
});

/** A gzipped tile that is nothing but a header: all the fold ever touches. */
function writeHeaderOnlyTile(dir: string, key: string, errM: number): string {
    const [z, x, y] = key.split('/');
    const raw = new Uint8Array(PTM_HEADER_BYTES);
    const view = new DataView(raw.buffer);
    view.setUint32(0, PTM_MAGIC, true);
    view.setUint8(4, PTM_VERSION);
    view.setFloat32(PTM_GEOMETRIC_ERROR_OFFSET, errM, true);
    const p = path.join(dir, z, x, `${y}.ptm`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, zlib.gzipSync(raw));
    return p;
}

describe('PTM header error helpers', () => {
    it('read what write put there and refuse a non-tile', () => {
        const raw = new Uint8Array(PTM_HEADER_BYTES);
        new DataView(raw.buffer).setUint32(0, PTM_MAGIC, true);
        writePtmGeometricError(raw, 123.5);
        assert.equal(readPtmGeometricError(raw), 123.5);
        assert.throws(() => writePtmGeometricError(raw, -1), /non-negative/);
        assert.throws(() => readPtmGeometricError(new Uint8Array(PTM_HEADER_BYTES)), /magic/);
    });
});

describe('foldPtmErrors', () => {
    it('rewrites only the headers whose figure moved, and remembers them', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errorfold-'));
        try {
            const meta: Record<string, TileMeta> = {
                '10/931/323': { geometricErrorM: 47, skirtDepthM: 10 },
                '11/1862/647': { geometricErrorM: 507, skirtDepthM: 10 },
                '11/1863/647': { geometricErrorM: 30, skirtDepthM: 10 },
            };
            const paths = Object.fromEntries(Object.entries(meta).map(
                ([k, m]) => [k, writeHeaderOnlyTile(dir, k, m.geometricErrorM)],
            ));
            const untouched = fs.statSync(paths['11/1863/647']).mtimeMs;

            const stats = newErrorFoldStats();
            const drawn = foldPtmErrors(dir, meta, stats);
            assert.equal(drawn.get('10/931/323'), 507);
            assert.equal(readPtmHeaderError(paths['10/931/323']), 507);
            assert.equal(readPtmHeaderError(paths['11/1862/647']), 507);
            assert.equal(readPtmHeaderError(paths['11/1863/647']), 30);
            assert.equal(meta['10/931/323'].headerErrorM, 507);
            assert.equal(meta['11/1863/647'].headerErrorM, undefined);
            assert.equal(stats.raised, 1);
            assert.equal(stats.rewritten, 1);
            assert.equal(stats.maxRaiseM, 460);
            assert.equal(stats.raisedByZoom.get(10), 1);
            assert.equal(fs.statSync(paths['11/1863/647']).mtimeMs, untouched);

            // A second fold finds every header already right.
            const again = newErrorFoldStats();
            foldPtmErrors(dir, meta, again);
            assert.equal(again.raised, 1);
            assert.equal(again.rewritten, 0);

            // A re-baked tile arrives with its own figure in the header again
            // and the sidecar saying so; the fold brings it back up.
            meta['10/931/323'] = { geometricErrorM: 47, skirtDepthM: 10, headerErrorM: 47 };
            writeHeaderOnlyTile(dir, '10/931/323', 47);
            const third = newErrorFoldStats();
            foldPtmErrors(dir, meta, third);
            assert.equal(third.rewritten, 1);
            assert.equal(readPtmHeaderError(paths['10/931/323']), 507);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

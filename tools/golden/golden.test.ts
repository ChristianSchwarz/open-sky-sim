import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { generateAll, GOLDEN_ROOT } from './generate';
import { stringify } from './lib';

/** Walk any JSON value and return the first non-finite number's path, if any. */
function findNonFinite(v: unknown, p = '$'): string | undefined {
    if (typeof v === 'number') return Number.isFinite(v) ? undefined : p;
    if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
            const r = findNonFinite(v[i], `${p}[${i}]`);
            if (r) return r;
        }
    } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
            const r = findNonFinite(x, `${p}.${k}`);
            if (r) return r;
        }
    }
    return undefined;
}

type Json = any;

describe('golden fixtures', () => {
    const generated = generateAll();
    const byFile = new Map(generated.files.map(f => [f.file, f.data as Json]));

    it('committed fixtures match what the oracle produces now', () => {
        // If this fails the TypeScript implementation changed. Review the diff,
        // then run `npm run golden:generate` and commit the new fixtures along
        // with the C# changes that must follow.
        for (const f of generated.files) {
            const p = path.join(GOLDEN_ROOT, f.file);
            assert.ok(fs.existsSync(p), `${f.file} is missing; run npm run golden:generate`);
            assert.equal(fs.readFileSync(p, 'utf8'), stringify(f.data), `${f.file} drifted from the oracle`);
        }
    });

    it('every codec decodes every tile fixture', () => {
        const codecs = byFile.get('codecs.json');
        assert.ok(codecs.tiles.length >= 30, `only ${codecs.tiles.length} tile fixtures`);
        const exts = new Set<string>(codecs.tiles.map((t: Json) => t.ext));
        for (const ext of ['ptm', 'pdm', 'ptx', 'ptr', 'pbd', 'pbr', 'pbh', 'pfl']) {
            assert.ok(exts.has(ext), `no .${ext} fixture`);
        }
        for (const t of codecs.tiles) {
            assert.equal(t.error, undefined, `${t.file}: ${t.error}`);
        }
        assert.equal(codecs.indices.length, 8);
    });

    it('geodesy round trips within the stated tolerances', () => {
        const g = byFile.get('geodesy.json');
        for (const p of g.geodeticEcef) {
            const dh = Math.abs(p.roundTrip.height - p.height);
            assert.ok(dh < 1e-4, `height round trip ${dh} at ${p.lat},${p.lon}`);
            assert.ok(Math.abs(p.roundTrip.lat - p.lat) < 1e-8, `lat round trip at ${p.lat},${p.lon}`);
            // Longitude is undefined at the poles; elsewhere compare modulo 360.
            if (Math.abs(p.lat) < 89.8) {
                const dl = Math.abs(((p.roundTrip.lon - p.lon + 540) % 360) - 180);
                assert.ok(dl < 1e-8, `lon round trip at ${p.lat},${p.lon}`);
            }
        }
        for (const b of g.bases) {
            for (const probe of b.probes) {
                const d = Math.hypot(
                    probe.ecefBack[0] - probe.ecef[0], probe.ecefBack[1] - probe.ecef[1], probe.ecefBack[2] - probe.ecef[2]);
                assert.ok(d < 1e-5, `ENU round trip ${d} m in ${b.label}`);
            }
        }
    });

    it('scene axes keep z = south', () => {
        const g = byFile.get('geodesy.json');
        // A point north of the origin must land at negative scene z.
        const home = g.bases[0];
        const north = home.probes.find((p: Json) => p.enu[1] > 1000 && Math.abs(p.enu[0]) < p.enu[1]);
        if (north) {
            assert.ok(north.scene[2] < 0, 'north of the origin should be negative z');
            assert.equal(north.scene[2], -north.enu[1]);
        }
        for (const b of g.bases) {
            for (const p of b.probes) {
                // `+ 0` folds -0 into 0 so the origin probe compares equal.
                assert.equal(p.scene[0] + 0, p.enu[0] + 0);
                assert.equal(p.scene[1] + 0, p.enu[2] + 0);
                assert.equal(p.scene[2] + 0, -p.enu[1] + 0);
            }
        }
    });

    it('flight traces are finite and the touchdown grades hold', () => {
        const f = byFile.get('flight_models.json');
        assert.equal(findNonFinite(f.traces), undefined);
        const byName = new Map<string, Json>(f.traces.map((t: Json) => [t.name, t]));
        for (const m of ['fm2', 'fm3']) {
            assert.equal(byName.get(`${m}_touchdown_normal`).summary.crashed, false, `${m} normal touchdown`);
            assert.equal(byName.get(`${m}_touchdown_normal`).summary.maxHardLandingFraction, 0);
            const hard = byName.get(`${m}_touchdown_hard`).summary;
            assert.equal(hard.crashed, false);
            assert.ok(hard.maxHardLandingFraction > 0 && hard.maxHardLandingFraction < 1);
            assert.equal(byName.get(`${m}_touchdown_fatal`).summary.crashed, true, `${m} fatal touchdown`);
            assert.equal(byName.get(`${m}_ground_idle`).summary.crashed, false);
            assert.equal(byName.get(`${m}_ground_idle`).summary.landed, true);
            assert.ok(byName.get(`${m}_takeoff_roll`).summary.finalPosition[1] > 20, `${m} takeoff never left the ground`);
        }
    });

    it('dogfight and tiling fixtures have no non-finite values', () => {
        // Non-finite numbers are legal in the files (written as strings) but
        // none of these suites should produce one.
        assert.equal(findNonFinite(byFile.get('dogfight_geometry.json')), undefined);
        assert.equal(findNonFinite(byFile.get('tiling.json')), undefined);
    });
});

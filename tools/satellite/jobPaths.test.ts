import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isJobPath } from './jobPaths';

test('a job may name tiles, scripts, an extract and the manifest', () => {
    for (const rel of ['planet/12/4347/965.pdm', 'terrain/12/-1/2.ptm', 'planet/manifest.json', 'planet/index.bin',
        'pbf/-18.5_27.3_-12.7_30.2.osm.pbf', 'pytools/bake_osm_coast.py', 'texcache/12/1/2.ptx']) {
        assert.ok(isJobPath(rel), rel);
    }
});

test('nothing that leaves the job directory', () => {
    for (const rel of ['planet/../x', 'planet/./x', 'planet/..', 'planet/.', '../planet/x', '/etc/passwd', 'planet//x',
        'planet\\x', 'C:/x', 'c:/x', 'planet/12/a b', 'planet', '', 'Planet/x', 'planet/x\n']) {
        assert.ok(!isJobPath(rel), JSON.stringify(rel));
    }
});

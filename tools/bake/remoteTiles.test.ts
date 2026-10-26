import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeWire, encodeWire, inputsOf, outputsOf } from './remoteTiles';
import { MeshTileConfig } from './meshTile';

test('the wire keeps typed arrays, which plain JSON turns into numbered objects', () => {
    const value = { basis: { m: new Float64Array([1.5, -2, 3e-9]) }, colors: new Uint8Array([0, 255, 7]), n: 3, s: 'x' };
    const back = decodeWire<typeof value>(encodeWire(value));
    assert.ok(back.basis.m instanceof Float64Array);
    assert.deepEqual([...back.basis.m], [1.5, -2, 3e-9]);
    assert.ok(back.colors instanceof Uint8Array);
    assert.deepEqual([...back.colors], [0, 255, 7]);
    assert.equal(back.n, 3);
    assert.equal(back.s, 'x');
});

test('a mesh tile reads its heights and the ancestors whose borders it follows', () => {
    const cfg = {} as MeshTileConfig;
    const leaf = inputsOf('mesh', cfg, { z: 12, x: 4347, y: 965 });
    for (const ext of ['.pdm', '.rgr', '.lvr', '.plc', '.rvr']) {
        assert.ok(leaf.includes(`planet/12/4347/965${ext}`));
    }
    // z11 (the parent, for the skirt) down to MIN_SEAM_ZOOM 8, and no further.
    assert.ok(leaf.includes('planet/11/2173/482.pdm'));
    assert.ok(leaf.includes('planet/8/271/60.pdm'));
    assert.ok(!leaf.some(r => r.startsWith('planet/7/')));
    // A coarse tile still reads its parent.
    assert.deepEqual(inputsOf('mesh', cfg, { z: 5, x: 3, y: 4 }).filter(r => r.endsWith('.pdm')), ['planet/5/3/4.pdm', 'planet/4/1/2.pdm']);
    assert.deepEqual(outputsOf('mesh', { z: 12, x: 1, y: 2 }), ['terrain/12/1/2.ptm']);
});

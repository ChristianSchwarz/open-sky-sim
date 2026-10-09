import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildBuildingExclusion } from './buildingExclusion';
import { RoofForm, decodePbh, encodePbh } from './pbh';

describe('buildBuildingExclusion', () => {
    // The local frame turned against the tile's axes: u along x, v along -z, up along y.
    const frame = { a: [1, 0, 0] as [number, number, number], b: [0, 0, -1] as [number, number, number], up: [0, 1, 0] as [number, number, number] };
    const tile = decodePbh(encodePbh({ z: 12, x: 1, y: 1 }, frame, [{
        rings: [[[0, 0], [20, 0], [20, 20], [0, 20]], [[8, 8], [8, 12], [12, 12], [12, 8]]],
        baseM: 0, eaveM: 6, ridgeM: 6, form: RoofForm.Flat, ridgeAngle: 0, roofTone: 0, wallTone: 0, flags: 0,
    }]));

    it('marks the footprint and a margin around it, in the tile axes', () => {
        const inside = buildBuildingExclusion(tile, 1)!;
        assert.equal(inside(5, 0, -5), true); // u 5, v 5
        assert.equal(inside(5, 0, 5), false); // v -5: outside
        assert.equal(inside(20.5, 0, -10), true); // within the margin of the east wall
        assert.equal(inside(22, 0, -10), false);
    });

    it('leaves a courtyard open beyond the margin', () => {
        const inside = buildBuildingExclusion(tile, 0)!;
        assert.equal(inside(10, 0, -10), false);
        assert.equal(inside(9, 0, -6), true);
    });
});

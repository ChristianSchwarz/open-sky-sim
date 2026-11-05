import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ASPHALT_TEXEL_RGB, CONCRETE_TEXEL_RGB, airfieldPavement, paintPavement, roadPavement } from './pavementTex';
import { RAIL_TEXEL_RGB, ROAD_TEXEL_RGB } from './coverTex';
import { PTX_NO_DATA, PTX_WATER } from '../../src/script/terrain/ptx';
import { TerrainClass } from '../../src/script/terrain/tones';

// A 1 km box, 100 texels across: 10 m texels in latitude, ~6.5 m in longitude at 50 N.
const LAT = 50, LON = 8;
const DLAT = 1000 / 111229, DLON = 1000 / 71696;
const BOUNDS = { west: LON - DLON / 2, east: LON + DLON / 2, south: LAT - DLAT / 2, north: LAT + DLAT / 2 };
const SIZE = 100;

function grass(): Uint8Array {
    const out = new Uint8Array(SIZE * SIZE * 4);
    for (let i = 0; i < out.length; i += 4) {
        out[i] = 40; out[i + 1] = 120; out[i + 2] = 30; out[i + 3] = TerrainClass.Grass;
    }
    return out;
}

function texel(out: Uint8Array, lat: number, lon: number): number[] {
    const x = Math.floor(((lon - BOUNDS.west) / (BOUNDS.east - BOUNDS.west)) * SIZE);
    const y = Math.floor(((BOUNDS.north - lat) / (BOUNDS.north - BOUNDS.south)) * SIZE);
    const o = (y * SIZE + x) * 4;
    return [...out.subarray(o, o + 4)];
}

const NO_TAXI = { taxiways: [], aprons: [] };

describe('pavementTex', () => {
    it('paints a paved runway solid in its tone and leaves the ground beside it', () => {
        const field = airfieldPavement({
            lat: LAT, lon: LON, ...NO_TAXI,
            runways: [{ widthM: 60, surface: 'concrete', lengthM: 800, thresholds: [[LAT, LON - 400 / 71696], [LAT, LON + 400 / 71696]] }],
        })!;
        const out = grass();
        assert.ok(paintPavement(out, SIZE, BOUNDS, [field]) > 0);
        assert.deepEqual(texel(out, LAT, LON), [...CONCRETE_TEXEL_RGB, TerrainClass.Ground]);
        assert.deepEqual(texel(out, LAT + 100 / 111229, LON), [40, 120, 30, TerrainClass.Grass]);
        // Past the threshold: ground.
        assert.deepEqual(texel(out, LAT, LON + 450 / 71696), [40, 120, 30, TerrainClass.Grass]);
    });

    it('blends a texel the pavement only partly covers, keeping the ground class', () => {
        // A 2 m taxiway across 10 m texels: one sample row of four.
        const field = airfieldPavement({
            lat: LAT, lon: LON, runways: [], aprons: [],
            taxiways: [{ widthM: 2, points: [[LAT + 1.25 / 111229, LON - 300 / 71696], [LAT + 1.25 / 111229, LON + 300 / 71696]] }],
        })!;
        const out = grass();
        paintPavement(out, SIZE, BOUNDS, [field]);
        const [r, , , cls] = texel(out, LAT + 1.25 / 111229, LON);
        assert.equal(cls, TerrainClass.Grass);
        assert.ok(r > 40 && r < ASPHALT_TEXEL_RGB[0], `blended red ${r}`);
    });

    it('fills aprons in the field tone and skips unpaved surfaces', () => {
        const ring = (d: number) => [[LAT - d, LON - d], [LAT - d, LON + d], [LAT + d, LON + d], [LAT + d, LON - d], [LAT - d, LON - d]];
        const paved = airfieldPavement({ lat: LAT, lon: LON, runways: [], taxiways: [], aprons: [{ ring: ring(0.001) }] })!;
        const out = grass();
        paintPavement(out, SIZE, BOUNDS, [paved]);
        assert.deepEqual(texel(out, LAT, LON), [...ASPHALT_TEXEL_RGB, TerrainClass.Ground]);

        assert.equal(airfieldPavement({
            lat: LAT, lon: LON, taxiways: [], aprons: [{ ring: ring(0.001), surface: 'grass' }],
            runways: [{ widthM: 30, surface: 'grass', thresholds: [[LAT, LON - 0.003], [LAT, LON + 0.003]] }],
        }), undefined);
    });

    it('takes over no-data and water only where it holds the texel', () => {
        const field = airfieldPavement({
            lat: LAT, lon: LON, ...NO_TAXI,
            runways: [{ widthM: 60, surface: 'asphalt', thresholds: [[LAT, LON - 0.004], [LAT, LON + 0.004]] }],
        })!;
        const out = grass();
        for (let i = 3; i < out.length; i += 4) {
            out[i] = i % 8 === 3 ? PTX_WATER : PTX_NO_DATA;
        }
        paintPavement(out, SIZE, BOUNDS, [field]);
        assert.deepEqual(texel(out, LAT, LON), [...ASPHALT_TEXEL_RGB, TerrainClass.Ground]);
        assert.ok(texel(out, LAT + 200 / 111229, LON)[3] >= PTX_WATER);
    });

    it('paints every road class at its true width, rail in ballast', () => {
        const across = (latM: number) => [{ lat: LAT + latM / 111229, lon: LON - 400 / 71696 }, { lat: LAT + latM / 111229, lon: LON + 400 / 71696 }];
        const roads = roadPavement([
            // A 30 m motorway: solid.
            { cls: 0, widthM: 30, points: across(-205) },
            // A 5 m residential street: half a 10 m texel at most, so a tint.
            { cls: 6, widthM: 5, points: across(105) },
            { cls: 7, widthM: 20, points: across(305) },
            // Turnout zones are never drawn.
            { cls: 9, widthM: 40, points: across(-405) },
        ], BOUNDS)!;
        const out = grass();
        paintPavement(out, SIZE, BOUNDS, [roads]);
        assert.deepEqual(texel(out, LAT - 205 / 111229, LON), [...ROAD_TEXEL_RGB, TerrainClass.Ground]);
        assert.deepEqual(texel(out, LAT + 305 / 111229, LON), [...RAIL_TEXEL_RGB, TerrainClass.Ground]);
        const [r, g] = texel(out, LAT + 105 / 111229, LON);
        assert.ok(r > 40 && g < 120, `street tint ${r},${g}`);
        assert.deepEqual(texel(out, LAT - 405 / 111229, LON), [40, 120, 30, TerrainClass.Grass]);
    });
});

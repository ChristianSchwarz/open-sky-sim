import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BuildingTone } from '../../src/script/terrain/buildingTones';
import { BuildingKind, RoofForm, decodePbh, encodePbh, pbhRings } from '../../src/script/terrain/pbh';
import { PlanInput, idRandom, minAreaRect, planBuilding, simplifyRing } from './buildingPlan';
import { dehazed, labToRgb, rgbToLab } from './buildingColourStore';
import { BvrBuilding, ORIENTATION_ACROSS } from './bvr';

function bvr(extra: Partial<BvrBuilding> = {}): BvrBuilding {
    return {
        id: 4242, kind: BuildingKind.House, roofShape: 0, roofOrientation: 0,
        height: NaN, minHeight: NaN, levels: NaN, roofHeight: NaN, roofLevels: NaN, roofDirection: NaN,
        roofColour: -1, wallColour: -1, rings: [], ...extra,
    };
}

/** A 12 x 8 m house with its long side along u, on ground at 300 m. */
function input(extra: Partial<BvrBuilding> = {}, overrides: Partial<PlanInput> = {}): PlanInput {
    return {
        building: bvr(extra),
        rings: [[[0, 0], [12, 0], [12, 8], [0, 8]]],
        lat: 50, lon: 9, north: [0, 1],
        ground: () => 300,
        ...overrides,
    };
}

describe('simplifyRing', () => {
    it('drops near-collinear vertices and keeps corners', () => {
        const got = simplifyRing([[0, 0], [5, 0.1], [10, 0], [10, 10], [0, 10]], 0.3);
        assert.deepEqual(got, [[0, 0], [10, 0], [10, 10], [0, 10]]);
    });
});

describe('minAreaRect', () => {
    it('finds a rotated rectangle', () => {
        const a = 0.4;
        const pts: Array<[number, number]> = [[0, 0], [20, 0], [20, 5], [0, 5]].map(([x, y]) =>
            [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]);
        const r = minAreaRect(pts);
        assert.ok(Math.abs(r.long - 20) < 1e-9 && Math.abs(r.short - 5) < 1e-9);
        const d = ((r.angle - a) % Math.PI + Math.PI) % Math.PI;
        assert.ok(d < 1e-9 || Math.PI - d < 1e-9, `angle ${r.angle}`);
    });
});

describe('planBuilding', () => {
    it('gives an untagged house walls, a pitched roof and a ridge along its long side', () => {
        const p = planBuilding(input())!;
        assert.ok(p);
        assert.equal(p.heightSource, 'default');
        assert.ok(p.form === RoofForm.Gabled || p.form === RoofForm.Hipped);
        assert.ok(p.eaveM - 300 > 4.5 && p.eaveM - 300 < 6, `eave ${p.eaveM}`); // 5.2 m +- 8 %
        // 38 degree pitch over half of 8 m.
        assert.ok(Math.abs(p.ridgeM - p.eaveM - 4 * Math.tan(38 * Math.PI / 180)) < 1e-6);
        assert.ok(Math.abs(Math.sin(p.ridgeAngle)) < 1e-9, 'ridge along u');
        assert.equal(p.baseM, 299.5);
    });

    it('takes levels and a tagged shape, colour and orientation', () => {
        const p = planBuilding(input({
            levels: 3, roofShape: 3, roofColour: 0x8b0000, roofOrientation: ORIENTATION_ACROSS,
        }))!;
        assert.equal(p.heightSource, 'levels');
        assert.equal(p.form, RoofForm.Hipped);
        assert.ok(Math.abs(p.eaveM - 300 - 9.4) < 1e-9);
        assert.ok(Math.abs(Math.cos(p.ridgeAngle)) < 1e-9, 'ridge turned across');
        assert.ok(p.roofTone === BuildingTone.RoofTileRed || p.roofTone === BuildingTone.RoofTileBrown);
        assert.ok(p.formTagged);
    });

    it('puts a tagged height at the top of the roof', () => {
        const p = planBuilding(input({ height: 10, roofShape: 2 }))!;
        assert.ok(Math.abs(p.ridgeM - 310) < 1e-9);
        assert.ok(p.eaveM < p.ridgeM);
    });

    it('roofs industry flat and Gran Canaria flat', () => {
        assert.equal(planBuilding(input({ kind: BuildingKind.Industrial }))!.form, RoofForm.Flat);
        assert.equal(planBuilding(input({}, { lat: 28, lon: -15.5 }))!.form, RoofForm.Flat);
    });

    it('keeps the eave clear of the uphill ground and buries the foot downhill', () => {
        const p = planBuilding(input({}, { ground: (u) => 300 + u }))!; // 12 m of slope across the house
        assert.equal(p.baseM, 299.5);
        assert.ok(p.eaveM >= 312 + 2.2 - 1e-9);
    });

    it('leaves airfield buildings to the airfield model', () => {
        assert.equal(planBuilding(input({ kind: BuildingKind.Airfield })), undefined);
    });

    it('skips what is too small or stands on no land', () => {
        assert.equal(planBuilding(input({}, { rings: [[[0, 0], [2, 0], [2, 2], [0, 2]]] })), undefined);
        assert.equal(planBuilding(input({}, { ground: () => undefined })), undefined);
    });

    it('points a skillion uphill away from roof:direction', () => {
        // Slope faces south: the roof climbs toward north (+v).
        const p = planBuilding(input({ roofShape: 5, roofDirection: 180 }))!;
        const tu = -Math.sin(p.ridgeAngle), tv = Math.cos(p.ridgeAngle);
        assert.ok(tv > 0.99 && Math.abs(tu) < 0.01, `climbs toward (${tu}, ${tv})`);
    });

    it('takes a confident measured roof colour and snaps its tone to it', () => {
        const measured = { rgb: 0x8d5d44, confidence: 0.9, source: 1, pixels: 200, shiftE: 0, shiftN: 0 };
        const p = planBuilding(input({}, { measured }))!;
        assert.ok(p.roofMeasured);
        assert.equal(p.roofRgb, dehazed(0x8d5d44, 1.1));
        assert.ok(p.roofTone === BuildingTone.RoofTileRed || p.roofTone === BuildingTone.RoofTileBrown);
        const unsure = planBuilding(input({}, { measured: { ...measured, confidence: 0.1 } }))!;
        assert.equal(unsure.roofMeasured, false);
        assert.equal(unsure.roofRgb, undefined);
    });

    it('takes a confident surface fit for form, heights and ridge direction', () => {
        // Ridge along compass 90 (east); north is +v, so east is +u: ridge angle 0.
        const shape = { form: RoofForm.Hipped, flags: 2, azimuthDeg: 90, eaveM: 7.2, ridgeM: 11.5, rmseM: 0.3, confidence: 0.8, points: 400 };
        const p = planBuilding(input({ levels: 2, roofShape: 2 }, {
            shape, surfaceForms: true, rings: [[[0, 0], [8, 0], [8, 12], [0, 12]]],
        }))!;
        assert.equal(p.heightSource, 'surface');
        assert.equal(p.form, RoofForm.Hipped);
        assert.ok(Math.abs(p.eaveM - 307.2) < 1e-9 && Math.abs(p.ridgeM - 311.5) < 1e-9);
        assert.ok(Math.abs(Math.sin(p.ridgeAngle)) < 1e-9 && Math.cos(p.ridgeAngle) > 0, `angle ${p.ridgeAngle}`);
    });

    it('turns a north-facing azimuth into +v', () => {
        const shape = { form: RoofForm.Gabled, flags: 2, azimuthDeg: 0, eaveM: 6, ridgeM: 9, rmseM: 0.3, confidence: 0.8, points: 400 };
        const p = planBuilding(input({}, { shape }))!;
        assert.ok(Math.abs(p.ridgeAngle - Math.PI / 2) < 1e-9);
    });

    it('keeps the rules\' form unless surface forms are asked for, but takes the ridge direction', () => {
        const shape = { form: RoofForm.Hipped, flags: 2, azimuthDeg: 0, eaveM: 6, ridgeM: 9.5, rmseM: 0.3, confidence: 0.8, points: 400 };
        const p = planBuilding(input({}, { shape }))!;
        assert.equal(p.heightSource, 'surface');
        assert.equal(p.formFitted, false);
        assert.ok(Math.abs(p.ridgeM - 309.5) < 1e-9);
        assert.ok(Math.abs(p.ridgeAngle - Math.PI / 2) < 1e-9, 'ridge north, across the 12 x 8 footprint');
    });

    it('takes only the heights when the form is not sure', () => {
        const shape = { form: RoofForm.Pyramidal, flags: 0, azimuthDeg: 30, eaveM: 6, ridgeM: 9, rmseM: 0.6, confidence: 0.7, points: 400 };
        const p = planBuilding(input({ kind: BuildingKind.Industrial }, { shape }))!;
        assert.equal(p.heightSource, 'surface');
        assert.equal(p.form, RoofForm.Flat, 'the rules keep the form');
        assert.ok(Math.abs(p.ridgeM - 309) < 1e-9);
        assert.equal(p.formFitted, false);
    });

    it('falls back when the fit is unsure, low, or the building is absent from the surface', () => {
        const shape = { form: RoofForm.Flat, flags: 0, azimuthDeg: 0, eaveM: 9, ridgeM: 9, rmseM: 1.2, confidence: 0.2, points: 40 };
        assert.equal(planBuilding(input({}, { shape }))!.heightSource, 'default');
        assert.equal(planBuilding(input({}, { shape: { ...shape, confidence: 0.9, ridgeM: 1.2 } }))!.heightSource, 'default');
        const absent = planBuilding(input({}, { shape: { ...shape, flags: 1, confidence: 0 } }))!;
        assert.equal(absent.heightSource, 'default');
        assert.ok(absent.shapeAbsent);
    });

    it('puts LoD2 above the surface fit, tags and rules', () => {
        const shape = { form: RoofForm.Gabled, flags: 2, azimuthDeg: 0, eaveM: 6, ridgeM: 9, rmseM: 0.3, confidence: 0.9, points: 400 };
        const lod2 = { form: RoofForm.Hipped, match: 1, adv: 3200, azimuthDeg: 90, eaveM: 4.5, ridgeM: 8.2, parts: 1 };
        const p = planBuilding(input({ levels: 3, roofShape: 1 }, { shape, lod2, surfaceForms: true }))!;
        assert.equal(p.heightSource, 'lod2');
        assert.equal(p.formSource, 'lod2');
        assert.equal(p.form, RoofForm.Hipped);
        assert.ok(Math.abs(p.eaveM - 304.5) < 1e-9 && Math.abs(p.ridgeM - 308.2) < 1e-9);
        assert.ok(Math.abs(Math.sin(p.ridgeAngle)) < 1e-9, 'LoD2 ridge east-west, not the fit ridge north-south');
    });

    it('keeps the rest of the ladder for a mixed LoD2 roof and ignores a partial match', () => {
        const mixed = { form: undefined, match: 1, adv: 5000, azimuthDeg: undefined, eaveM: 5, ridgeM: 10, parts: 1 };
        const p = planBuilding(input({}, { lod2: mixed }))!;
        assert.equal(p.heightSource, 'lod2');
        assert.equal(p.formSource, 'rules');
        assert.ok(Math.abs(p.ridgeM - 310) < 1e-9);
        const partial = { form: RoofForm.Flat, match: 3, adv: 1000, azimuthDeg: undefined, eaveM: 3, ridgeM: 3, parts: 1 };
        assert.equal(planBuilding(input({}, { lod2: partial }))!.heightSource, 'default');
    });

    it('draws the same colours for the same id', () => {
        assert.deepEqual(planBuilding(input()), planBuilding(input()));
        assert.notEqual(idRandom(1, 2), idRandom(2, 2));
    });
});

describe('PBH1', () => {
    it('round-trips records, rings and the frame', () => {
        const a = planBuilding(input({ roofShape: 5, roofDirection: 200 }))!;
        const b = planBuilding(input({ kind: BuildingKind.Roof }, {
            rings: [[[0, 0], [30, 0], [30, 30], [0, 30]], [[10, 10], [10, 20], [20, 20], [20, 10]]],
        }))!;
        const frame = { a: [1, 0, 0] as [number, number, number], b: [0, 0, -1] as [number, number, number], up: [0, 1, 0] as [number, number, number] };
        const tile = decodePbh(encodePbh({ z: 12, x: 2170, y: 960 }, frame, [a, b]));
        assert.deepEqual(tile.id, { z: 12, x: 2170, y: 960 });
        assert.deepEqual(tile.frame, frame);
        assert.equal(tile.buildings.length, 2);
        const [da, db] = tile.buildings;
        assert.ok(Math.abs(da.baseM - a.baseM) <= 0.05 && Math.abs(da.ridgeM - a.ridgeM) <= 0.1);
        assert.ok(Math.abs(da.ridgeAngle - ((a.ridgeAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) < 1e-3);
        assert.equal(da.form, RoofForm.Skillion);
        assert.equal(db.ringCount, 2);
        assert.equal(db.flags, b.flags);
        assert.equal(da.flags & 2, 0, 'no measured colour, no flag');
        const rings = pbhRings(tile, db);
        assert.deepEqual(rings[1], b.rings[1]);
    });
});

describe('PBH1 measured roof colour', () => {
    it('round-trips with its flag', () => {
        const a = planBuilding(input())!;
        const frame = { a: [1, 0, 0] as [number, number, number], b: [0, 0, -1] as [number, number, number], up: [0, 1, 0] as [number, number, number] };
        const tile = decodePbh(encodePbh({ z: 12, x: 1, y: 1 }, frame, [{ ...a, roofRgb: 0x8d5d44 }]));
        assert.equal(tile.buildings[0].flags & 2, 2);
        assert.equal(tile.buildings[0].roofRgb, 0x8d5d44);
    });
});

describe('roof colour maths', () => {
    it('CIELAB round-trips sRGB', () => {
        for (const rgb of [0x8d5d44, 0x404448, 0xffffff, 0x000000, 0x5e9e86]) {
            const back = labToRgb(rgbToLab(rgb));
            for (const shift of [16, 8, 0]) {
                assert.ok(Math.abs(((back >> shift) & 255) - ((rgb >> shift) & 255)) <= 1, rgb.toString(16));
            }
        }
    });

    it('scales chroma and keeps lightness', () => {
        const [L, a, b] = rgbToLab(0x8d5d44);
        const [L2, a2, b2] = rgbToLab(dehazed(0x8d5d44, 1.3));
        assert.ok(Math.abs(L2 - L) < 1);
        assert.ok(Math.hypot(a2, b2) > Math.hypot(a, b) * 1.2);
        assert.equal(dehazed(0x8d5d44, 1), 0x8d5d44);
    });
});

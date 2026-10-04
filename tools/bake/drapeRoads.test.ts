import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ecefToEnu, geodeticToEcef, makeEnuBasis } from '../../src/script/terrain/geodesy';
import { PtmTile } from '../../src/script/terrain/ptm';
import {
    ALONG_STEP_M, ALONG_WRAP_M, ROAD_CLASS_MASK, ROAD_SIDE_BIT, RoadClass, TRACK_FLAG_CROSSING, TRACK_FLAG_LONG_NEG,
    TRACK_FLAG_LONG_POS, TRACK_FLAG_REACH_MASK, TRACK_FLAG_REACH_SHIFT,
    TRACK_FLAG_NO_SLEEPERS, decodePtr, encodePtr,
} from '../../src/script/terrain/ptr';
import { tileBounds } from '../../src/script/terrain/tiling';
import { densifyNearZones, drapeRoads, flagSwitchZones, reachLevel, simplifyDraped } from './drapeRoads';
import { RoadLine } from './rvr';

const ID = { z: 12, x: 4400, y: 850 };
const HEIGHT = 100;
const Q = 0.5;

/**
 * A tile whose drawn surface is one flat quad `HEIGHT` metres up, split
 * along its diagonal, built the way the bake would: tile-local metres from
 * the tile centre, in the frame of a basis at the tile's own centre so
 * "up" is y.
 */
function flatTile(): { tile: PtmTile; basis: ReturnType<typeof makeEnuBasis> } {
    const b = tileBounds(ID);
    const lat0 = (b.south + b.north) / 2;
    const lon0 = (b.west + b.east) / 2;
    const basis = makeEnuBasis(lat0, lon0, 0);
    const centre = ecefToEnu(basis, geodeticToEcef(lat0, lon0, 0));
    const local = (lon: number, lat: number) => {
        const enu = ecefToEnu(basis, geodeticToEcef(lat, lon, HEIGHT));
        return [enu.e - centre.e, enu.u - centre.u, centre.n - enu.n];
    };
    const nw = local(b.west, b.north), ne = local(b.east, b.north);
    const sw = local(b.west, b.south), se = local(b.east, b.south);
    const tris = [nw, sw, se, nw, se, ne];
    const landPositions = new Int16Array(tris.length * 3);
    tris.forEach((p, i) => {
        landPositions[i * 3] = Math.round(p[0] / Q);
        landPositions[i * 3 + 1] = Math.round(p[1] / Q);
        landPositions[i * 3 + 2] = Math.round(p[2] / Q);
    });
    const tile: PtmTile = {
        id: ID, version: 6, flags: 1, centerHeightM: 0, quantScale: Q, boundingRadiusM: 10000,
        skirtDepthM: 0, geometricErrorM: 0,
        landPositions,
        landNormals: new Int8Array(tris.length * 4),
        landAttrs: new Uint8Array(tris.length * 4),
        waterPositions: new Int16Array(0), waterTones: new Uint8Array(0), waterIndices: new Uint16Array(0),
        waterGroups: [],
        riverPositions: new Int16Array(0), riverDirections: new Int8Array(0),
        riverHalfWidths: new Uint16Array(0), riverIndices: new Uint16Array(0),
    };
    return { tile, basis };
}

function road(cls: number, widthM: number, ...lonLat: number[]): RoadLine {
    const points = [];
    for (let i = 0; i + 1 < lonLat.length; i += 2) {
        points.push({ lon: lonLat[i], lat: lonLat[i + 1] });
    }
    return { cls, widthM, points };
}

describe('drapeRoads', () => {
    const b = tileBounds(ID);
    const lat0 = (b.south + b.north) / 2;

    it('lays a road on the drawn surface, two vertices per point', () => {
        const { tile, basis } = flatTile();
        // West to east across the middle: crosses the quad's diagonal once.
        const out = drapeRoads(tile, basis, [road(RoadClass.Primary, 12, b.west + 0.001, lat0, b.east - 0.001, lat0)]);
        assert.ok(out);
        assert.equal(out.strokes, 1);
        // Two OSM points, doubled: the diagonal crossing lies on a flat
        // surface, so the simplifier drops it.
        assert.equal(out.positions.length / 3, 4);
        for (let v = 0; v < out.positions.length / 3; v++) {
            const y = out.positions[v * 3 + 1];
            assert.ok(y > HEIGHT && y < HEIGHT + 2, `vertex ${v} at ${y}, surface at ${HEIGHT}`);
        }
        assert.equal(out.triangles, 2);
        assert.equal(out.halfWidthsM[0], 6);
        assert.equal(out.classes[0], RoadClass.Primary);
        // Offsets are unit and opposite within a pair.
        const d = out.directions;
        assert.ok(Math.abs(Math.hypot(d[0], d[1], d[2]) - 1) < 1e-6);
        assert.ok(Math.abs(d[0] + d[3]) < 1e-9 && Math.abs(d[2] + d[5]) < 1e-9);
    });

    it('takes major roads first and drops the minor ones when the cap is full', () => {
        const { tile, basis } = flatTile();
        const minor = road(RoadClass.Residential, 5, b.west + 0.001, lat0 + 0.002, b.east - 0.001, lat0 + 0.002);
        const major = road(RoadClass.Motorway, 25, b.west + 0.001, lat0 - 0.002, b.east - 0.001, lat0 - 0.002);
        const out = drapeRoads(tile, basis, [minor, major], 6);
        assert.ok(out);
        assert.equal(out.strokes, 1);
        assert.equal(out.dropped, 1);
        assert.equal(out.classes[0], RoadClass.Motorway);
    });

    it('returns nothing for a tile with no roads', () => {
        const { tile, basis } = flatTile();
        assert.equal(drapeRoads(tile, basis, []), undefined);
    });

    it('round-trips through PTR1', () => {
        const { tile, basis } = flatTile();
        const out = drapeRoads(tile, basis, [road(RoadClass.Secondary, 9, b.west + 0.001, lat0, b.east - 0.001, lat0)])!;
        const bytes = encodePtr({
            id: ID, quantScale: Q, positions: out.positions, directions: out.directions,
            halfWidthsM: out.halfWidthsM, classes: out.classes, indices: out.indices,
        });
        // As the runtime sees it: a fresh, aligned buffer.
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const back = decodePtr(copy.buffer);
        assert.deepEqual(back.id, ID);
        assert.equal(back.quantScale, Q);
        assert.equal(back.positions.length, out.positions.length);
        assert.equal(back.indices.length, out.indices.length);
        assert.equal(back.halfWidths[0], 45);
        assert.equal(back.directions[3], RoadClass.Secondary);
        assert.ok(Math.abs(back.positions[1] * Q - out.positions[1]) <= Q);
    });

    it('never lets a segment span the along wrap: it splits the strip there', () => {
        const { tile, basis } = flatTile();
        // Corner to corner, ~5.7 km: past ALONG_WRAP_M once.
        const out = drapeRoads(tile, basis, [road(RoadClass.Rail, 5, b.west + 1e-5, b.south + 1e-5, b.east - 1e-5, b.north - 1e-5)])!;
        const bytes = encodePtr({
            id: ID, quantScale: Q, positions: out.positions, directions: out.directions,
            halfWidthsM: out.halfWidthsM, classes: out.classes, alongM: out.alongM, indices: out.indices,
        });
        const back = decodePtr(bytes.slice().buffer);
        let wraps = 0;
        for (let i = 0; i + 5 < back.indices.length; i += 6) {
            const a = back.indices[i], c = back.indices[i + 5];
            const da = (back.along[c] - back.along[a]) * ALONG_STEP_M;
            assert.ok(da > -1, `segment sweeps back ${da.toFixed(1)} m in the shader`);
        }
        for (let v = 0; v + 2 < out.alongM.length; v += 2) {
            if (out.alongM[v] < ALONG_WRAP_M && out.alongM[v + 2] >= ALONG_WRAP_M) wraps++;
        }
        assert.equal(wraps, 1);
    });

    it('marks the negative bank and measures each stroke along its length', () => {
        const { tile, basis } = flatTile();
        const out = drapeRoads(tile, basis, [road(RoadClass.Rail, 5, b.west + 0.001, lat0, b.east - 0.001, lat0)])!;
        const n = out.positions.length / 3;
        for (let v = 0; v < n; v++) {
            assert.equal(out.classes[v] & ROAD_CLASS_MASK, RoadClass.Rail);
            assert.equal((out.classes[v] & ROAD_SIDE_BIT) !== 0, v % 2 === 1, `side bit of vertex ${v}`);
        }
        // A pair shares its distance; the last pair sits at the stroke's length.
        assert.equal(out.alongM[0], 0);
        assert.equal(out.alongM[1], 0);
        const last = n - 2;
        const len = Math.hypot(out.positions[last * 3] - out.positions[0], out.positions[last * 3 + 2] - out.positions[2]);
        assert.ok(Math.abs(out.alongM[last] - len) < 0.5, `along ${out.alongM[last]} vs length ${len}`);
        assert.equal(out.alongM[last + 1], out.alongM[last]);

        const bytes = encodePtr({
            id: ID, quantScale: Q, positions: out.positions, directions: out.directions,
            halfWidthsM: out.halfWidthsM, classes: out.classes, alongM: out.alongM, indices: out.indices,
        });
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const back = decodePtr(copy.buffer);
        assert.equal(back.directions[1 * 4 + 3], RoadClass.Rail | ROAD_SIDE_BIT);
        const wrapped = out.alongM[last] % ALONG_WRAP_M;
        assert.ok(Math.abs(back.along[last] * ALONG_STEP_M - wrapped) <= ALONG_STEP_M);
    });
});

describe('PTR versions', () => {
    it('decodes a version 1 sidecar, which has no along section, with along zero', () => {
        const input = {
            id: ID, quantScale: Q,
            positions: new Float32Array([0, 0, 0, 0, 0, 0, 10, 0, 0, 10, 0, 0]),
            directions: new Float32Array([0, 0, 1, 0, 0, -1, 0, 0, 1, 0, 0, -1]),
            halfWidthsM: new Float32Array([2, 2, 2, 2]),
            classes: Uint8Array.from([1, 1, 1, 1]),
            alongM: new Float32Array([0, 0, 10, 10]),
            indices: Uint32Array.from([0, 1, 3, 0, 3, 2]),
        };
        const v3 = encodePtr({ ...input, flags: Uint8Array.from([1, 1, 2, 2]) });
        // Older files are the same bytes without the newer sections: version 2
        // has no flags (4 bytes here), version 1 no along (8) either.
        const header = 24, n = 4;
        const alongAt = header + n * 6 + n * 4 + n * 2;
        const flagsAt = alongAt + n * 2;
        const without = (from: number, bytes: number, version: number) => {
            const out = new Uint8Array(v3.byteLength - bytes);
            out.set(v3.subarray(0, from));
            out.set(v3.subarray(from + bytes), from);
            out[4] = version;
            return decodePtr(out.slice().buffer);
        };
        const v2 = without(flagsAt, 4, 2);
        assert.deepEqual([...v2.along], [0, 0, 200, 200]);
        assert.deepEqual([...v2.flags], [0, 0, 0, 0]);
        assert.deepEqual([...v2.indices], [0, 1, 3, 0, 3, 2]);
        const v1 = without(alongAt, 12, 1);
        assert.deepEqual([...v1.along], [0, 0, 0, 0]);
        assert.deepEqual([...v1.indices], [0, 1, 3, 0, 3, 2]);
        const back = decodePtr(v3.slice().buffer);
        assert.deepEqual([...back.along], [0, 0, 200, 200]);
        assert.deepEqual([...back.flags], [1, 1, 2, 2]);
    });
});

describe('simplifyDraped', () => {
    const line = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i * 10, z: 0 }));

    it('drops samples on a straight, flat run down to its ends', () => {
        assert.deepEqual(simplifyDraped(line(6), [5, 5, 5, 5, 5, 5], 0.5), [0, 5]);
    });

    it('drops samples on an even slope too', () => {
        assert.deepEqual(simplifyDraped(line(5), [0, 1, 2, 3, 4], 0.5), [0, 4]);
    });

    it('keeps a crest the chord would cut through', () => {
        assert.deepEqual(simplifyDraped(line(5), [0, 0, 3, 0, 0], 0.5), [0, 1, 2, 3, 4]);
    });

    it('keeps a bend in the track however flat the ground', () => {
        const bent = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
        assert.deepEqual(simplifyDraped(bent, [0, 0, 0], 0.5), [0, 1, 2]);
    });

    it('keeps a small rise under the tolerance out', () => {
        assert.deepEqual(simplifyDraped(line(3), [0, 0.4, 0], 0.5), [0, 2]);
    });
});

describe('flagSwitchZones', () => {
    const b = tileBounds(ID);
    const lat0 = (b.south + b.north) / 2;
    // Through track along +x; the diverging track leaves toward +z, offset
    // growing as s^2 / 2R, for 30 m.
    const R = 190;
    const diverging = Array.from({ length: 16 }, (_, i) => ({ x: i * 2, z: (i * 2) ** 2 / (2 * R) }));
    const through = [{ x: 0, z: 0 }, { x: 30, z: 0 }];
    const zones = [{ through: true, pts: through }, { through: false, pts: diverging }];

    it('gives the through track long timbers toward the diverging side, inside the zone only', () => {
        const grid = Array.from({ length: 41 }, (_, i) => ({ x: -5 + i, z: 0 }));
        const flags = flagSwitchZones(grid, zones);
        // The stroke's + side is up x tangent, (tz, -tx): for +x that is -z,
        // and the diverging track lies at +z, so the timbers reach to the - side.
        assert.equal(flags[15], TRACK_FLAG_LONG_NEG, 'x = 10');
        assert.equal(flags[0], 0, 'before the switch');
        assert.equal(flags[40], 0, 'past the zone');
        // Walking the other way flips the stroke's sides.
        const back = flagSwitchZones([...grid].reverse(), zones);
        assert.equal(back[25], TRACK_FLAG_LONG_POS);
    });

    it('flags a level crossing over whatever else the track does there, and densifies to find it', () => {
        // A 10 m crossing stretch in the middle of a 200 m straight sampled at its ends only.
        const crossing = [{ through: false, crossing: true, pts: [{ x: 95, z: 0 }, { x: 105, z: 0 }] }];
        const sparse = [{ x: 0, y: 0, z: 0 }, { x: 200, y: 0, z: 0 }];
        assert.ok(flagSwitchZones(sparse, crossing).every(f => f === 0), 'no point lands on it undensified');
        const grid = densifyNearZones(sparse, crossing);
        const flags = flagSwitchZones(grid, crossing);
        const on = grid.filter((_, i) => flags[i] === TRACK_FLAG_CROSSING).map(p => p.x);
        assert.ok(on.length >= 8, `${on.length} points on the crossing`);
        assert.ok(Math.min(...on) >= 95 && Math.max(...on) <= 105);
        // Densified only near the zone: the far ends stay sparse.
        assert.ok(grid.length < 40, `${grid.length} points`);
    });

    it('merges overlapping zones: one set of timbers, reaching the farthest diverging track', () => {
        // Siding 1 leaves the main line (+x) at the origin; siding 2 leaves
        // siding 1 at 20 m, inside the first zone.
        const s1 = (x: number) => x * x / (2 * R);
        const siding1 = Array.from({ length: 17 }, (_, i) => ({ x: i * 2, z: s1(i * 2) }));
        const at20 = { x: 20, z: s1(20) };
        const siding2 = Array.from({ length: 17 }, (_, i) => {
            const t = i * 2;
            return { x: 20 + t, z: s1(20) + t * (20 / R) + t * t / (2 * R) };
        });
        const merged = [
            { through: true, pts: [{ x: 0, z: 0 }, { x: 32, z: 0 }] },
            { through: false, pts: siding1 },
            { through: true, pts: [at20, ...siding1.filter(p => p.x > 20)] },
            { through: false, pts: siding2 },
        ];
        // Siding 1 inside the overlap: a diverging track, so no sleepers -
        // not the through track's long timbers of switch 2 as well.
        const onSiding1 = flagSwitchZones(siding1.filter(p => p.x > 21 && p.x < 31), merged);
        assert.ok(onSiding1.every(f => f === TRACK_FLAG_NO_SLEEPERS), onSiding1.join(','));
        // The main line carries the timbers, out past siding 2 near the end of the zone.
        const main = flagSwitchZones([{ x: 29, z: 0 }, { x: 30, z: 0 }, { x: 31, z: 0 }], merged);
        const level = (main[1] & TRACK_FLAG_REACH_MASK) >> TRACK_FLAG_REACH_SHIFT;
        assert.ok(main[1] & TRACK_FLAG_LONG_NEG);
        // Siding 2's outer rail at x = 30 must lie on the main line's timbers.
        const siding2At30 = s1(20) + 10 * (20 / R) + 100 / (2 * R);
        const timberEnd = 1.3 + 2.9 + 1.5 * level;
        assert.ok(timberEnd >= siding2At30 + 0.72, `timbers end at ${timberEnd}, rail at ${siding2At30 + 0.72}`);
        assert.equal(reachLevel(0.3), 0);
        assert.equal(reachLevel(6), 2);
        assert.equal(reachLevel(7.5), 3);
    });

    it('takes the sleepers off the diverging track inside the zone', () => {
        const grid = diverging.slice(5, -1);
        const flags = flagSwitchZones(grid, zones);
        assert.ok(flags.every(f => f === TRACK_FLAG_NO_SLEEPERS), flags.join(','));
    });

    it('drapes zone polylines as flags, never as strokes, and widens the timbered bed', () => {
        const { tile, basis } = flatTile();
        const lon = (b.west + b.east) / 2;
        // A through zone along the rail and a diverging zone beside it, 20 m
        // long; the rail short too, since a line of latitude across a whole
        // tile bows off its straight chord by more than a zone's tolerance.
        const dLon = 20 / (111320 * Math.cos(lat0 * Math.PI / 180));
        const rail = road(RoadClass.Rail, 5, lon - dLon, lat0, lon + 2 * dLon, lat0);
        const dLat = 2 / 111320;
        const zt = road(RoadClass.ZoneThrough, 0, lon, lat0, lon + dLon, lat0);
        const zd = road(RoadClass.ZoneDiverging, 0, lon, lat0, lon + dLon, lat0 + dLat);
        const out = drapeRoads(tile, basis, [rail, zt, zd])!;
        assert.equal(out.strokes, 1);
        assert.ok(out.zonePoints > 0);
        const n = out.positions.length / 3;
        let flagged = 0;
        for (let v = 0; v < n; v++) {
            if (out.flags[v]) {
                flagged++;
                assert.ok(out.halfWidthsM[v] > 4, `a timbered bed is widened: vertex ${v} flags ${out.flags[v]} half ${out.halfWidthsM[v]}`);
            }
        }
        assert.ok(flagged >= 2);
        const back = decodePtr(encodePtr({
            id: ID, quantScale: Q, positions: out.positions, directions: out.directions,
            halfWidthsM: out.halfWidthsM, classes: out.classes, alongM: out.alongM, flags: out.flags,
            indices: out.indices,
        }).slice().buffer);
        assert.deepEqual([...back.flags], [...out.flags]);
    });
});


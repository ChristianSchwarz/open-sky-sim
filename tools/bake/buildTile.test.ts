import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ecefToEnu, ecefToGeodetic, enuToEcef, geodeticToEcef, makeEnuBasis,
} from '../../src/script/terrain/geodesy';
import { padBlendWeight } from '../../src/script/terrain/flattenPad';
import { PTM_STROKE_KIND_OUTLINE, PTM_STROKE_KIND_WATER, decodePtm } from '../../src/script/terrain/ptm';
import { TerrainClass } from '../../src/script/terrain/tones';
import { Watercourse } from './lvr';
import { CoastPolygon, LonLatBounds } from './shoreline';
import { BuildTileInput, COAST_BUDGET_CEILING, TileCover, buildTile } from './buildTile';
import { RegionPolygon } from './regions';

const SIZE = 33;
const CELLS = SIZE - 1;
// A ~1.2 km tile near the Gran Canaria play origin.
const BOUNDS: LonLatBounds = {
    west: -15.40, east: -15.39,
    south: 28.00, north: 28.01,
};
const BASIS = makeEnuBasis(28.0015, -15.3937, 0);

function heightsFrom(fn: (x: number, y: number) => number): Float32Array {
    const out = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            out[y * SIZE + x] = fn(x, y);
        }
    }
    return out;
}

/** A land polygon covering grid x in [0, edge], i.e. a north-south coast. */
function coastAt(edgeCells: number): CoastPolygon {
    const lonAt = (gx: number) => BOUNDS.west + (gx / CELLS) * (BOUNDS.east - BOUNDS.west);
    return {
        exterior: [
            { lon: lonAt(-1), lat: BOUNDS.north + 1 },
            { lon: lonAt(edgeCells), lat: BOUNDS.north + 1 },
            { lon: lonAt(edgeCells), lat: BOUNDS.south - 1 },
            { lon: lonAt(-1), lat: BOUNDS.south - 1 },
        ],
        holes: [],
    };
}

/** A rectangular region in grid-space corners, converted to lon/lat. */
function regionAt(
    x0: number, y0: number, x1: number, y1: number,
    isLand: boolean, landuseClass: number | undefined,
): RegionPolygon {
    const lonAt = (gx: number) => BOUNDS.west + (gx / CELLS) * (BOUNDS.east - BOUNDS.west);
    const latAt = (gy: number) => BOUNDS.north - (gy / CELLS) * (BOUNDS.north - BOUNDS.south);
    return {
        exterior: [
            { lon: lonAt(x0), lat: latAt(y0) },
            { lon: lonAt(x1), lat: latAt(y0) },
            { lon: lonAt(x1), lat: latAt(y1) },
            { lon: lonAt(x0), lat: latAt(y1) },
        ],
        holes: [],
        isLand,
        landuseClass,
    };
}

/** Cover with one class and one colour everywhere. */
function uniformCover(cls: TerrainClass, rgb: [number, number, number]): TileCover {
    const classes = new Uint8Array(SIZE * SIZE).fill(cls);
    const colors = new Uint8Array(SIZE * SIZE * 3);
    for (let i = 0; i < SIZE * SIZE; i++) {
        colors[i * 3] = rgb[0];
        colors[i * 3 + 1] = rgb[1];
        colors[i * 3 + 2] = rgb[2];
    }
    return { size: SIZE, classes, colors };
}

/** Every distinct class present on the land facets of a decoded tile. */
function classesIn(bytes: Uint8Array): Set<number> {
    const tile = decodePtm(bytes);
    const out = new Set<number>();
    for (let v = 3; v < tile.landAttrs.length; v += 4) {
        out.add(tile.landAttrs[v]);
    }
    return out;
}

/** ENU of the tile's centre, which is what its vertices are relative to. */
function tileCentreEnu(centerHeightM = 0) {
    return ecefToEnu(BASIS, geodeticToEcef(
        (BOUNDS.south + BOUNDS.north) / 2, (BOUNDS.west + BOUNDS.east) / 2, centerHeightM));
}

/** A pad centred `de` east and `dn` north of the tile centre. */
function padAt(de: number, dn: number) {
    const centre = tileCentreEnu();
    return {
        centerX: centre.e + de, centerZ: centre.n + dn,
        halfW: 500, halfD: 2000, featherM: 80, heightMsl: 41.7,
        basis: BASIS, lat: 28.0015, lon: -15.3937,
    };
}

/**
 * The height the tile is actually *drawn* at, anywhere on it.
 *
 * Reading vertices alone cannot catch a leaf that spans a feature: its corners
 * can be exactly right while everything the triangle interpolates between them
 * is wrong. This walks the land facets and interpolates, which is what the
 * player sees. NaN where no facet covers the point.
 */
function landSurface(r: ReturnType<typeof buildTile>): (e: number, n: number) => number {
    const tile = decodePtm(r.bytes);
    const centre = tileCentreEnu(r.centerHeightM);
    const p = tile.landPositions;
    const s = tile.quantScale;
    // Absolute ENU per vertex; tile z runs south, so north flips sign.
    const at = (v: number) => ({
        e: centre.e + p[v * 3] * s,
        u: centre.u + p[v * 3 + 1] * s,
        n: centre.n - p[v * 3 + 2] * s,
    });
    return (e: number, n: number) => {
        let best = NaN;
        for (let v = 0; v + 2 < p.length / 3; v += 3) {
            const a = at(v);
            const b = at(v + 1);
            const c = at(v + 2);
            const d = (b.n - c.n) * (a.e - c.e) + (c.e - b.e) * (a.n - c.n);
            if (Math.abs(d) < 1e-9) {
                continue;               // a skirt, seen edge-on from above
            }
            const l0 = ((b.n - c.n) * (e - c.e) + (c.e - b.e) * (n - c.n)) / d;
            const l1 = ((c.n - a.n) * (e - c.e) + (a.e - c.e) * (n - c.n)) / d;
            const l2 = 1 - l0 - l1;
            if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) {
                continue;
            }
            const u = l0 * a.u + l1 * b.u + l2 * c.u;
            // The topmost facet is the one that would be seen.
            if (!(best > u)) {
                best = u;
            }
        }
        return best;
    };
}

function base(overrides: Partial<BuildTileInput> = {}): BuildTileInput {
    return {
        id: { z: 12, x: 3745, y: 1410 },
        bounds: BOUNDS,
        heights: heightsFrom((x, y) => 50 + Math.sin(x / 5) * 20 + Math.cos(y / 4) * 15),
        size: SIZE,
        seaLevel: 0,
        maxErrorM: 2,
        skirtDepthM: 25,
        basis: BASIS,
        ...overrides,
    };
}

describe('buildTile', () => {
    /**
     * The frame the vertices come out in, which nothing downstream re-derives:
     * the runtime binds these positions to the GPU untouched. Writing north on
     * +z instead of −z costs nothing that looks wrong tile by tile and draws
     * the entire planet as its own mirror image. See `sceneFromEnu`.
     */
    it('writes vertices in scene axes, with north on −z', () => {
        // Grid row 0 is the tile's north edge, so this ramps downhill going
        // south — and the summit must land on negative z.
        const ramp = heightsFrom((_x, y) => 500 - (y / CELLS) * 450);
        const tile = decodePtm(buildTile(base({
            heights: ramp, polygons: [coastAt(CELLS + 2)], skirtDepthM: 0,
        })).bytes);

        let highest = 0;
        let lowest = 0;
        for (let v = 1; v < tile.landPositions.length / 3; v++) {
            if (tile.landPositions[v * 3 + 1] > tile.landPositions[highest * 3 + 1]) {
                highest = v;
            }
            if (tile.landPositions[v * 3 + 1] < tile.landPositions[lowest * 3 + 1]) {
                lowest = v;
            }
        }
        assert.ok(tile.landPositions[highest * 3 + 2] < 0,
            `summit sits north, so z should be negative: ${tile.landPositions[highest * 3 + 2]}`);
        assert.ok(tile.landPositions[lowest * 3 + 2] > 0,
            `foot sits south, so z should be positive: ${tile.landPositions[lowest * 3 + 2]}`);
    });

    it('produces bytes that decode back to a consistent tile', () => {
        const r = buildTile(base({ polygons: [coastAt(16)] }));
        const tile = decodePtm(r.bytes);
        assert.deepEqual(tile.id, { z: 12, x: 3745, y: 1410 });
        assert.equal(tile.landPositions.length / 3, r.landTriangles * 3);
        assert.equal(tile.waterIndices.length, r.waterTriangles * 3);
        assert.ok(Math.abs(tile.skirtDepthM - 25) < 1e-3);
        assert.ok(tile.boundingRadiusM > 0);
    });

    it('is deterministic: the same input yields byte-identical output', () => {
        const input = () => base({ polygons: [coastAt(16)] });
        const a = buildTile(input()).bytes;
        const b = buildTile(input()).bytes;
        assert.deepEqual(Array.from(a), Array.from(b));
    });

    it('emits only land for an all-land tile', () => {
        const r = buildTile(base({ polygons: [coastAt(CELLS + 2)] }));
        assert.ok(r.landTriangles > 0);
        assert.equal(r.waterTriangles, 0);
        const tile = decodePtm(r.bytes);
        assert.equal(tile.waterIndices.length, 0);
        // No cover raster: every facet falls back to the unknown class, which
        // the palette paints as plain grass — what the bake did before cover.
        assert.deepEqual(classesIn(r.bytes), new Set([TerrainClass.Unknown]));
    });

    it('emits only water for a tile with no land', () => {
        const r = buildTile(base({ polygons: [] }));
        assert.equal(r.landTriangles, 0);
        assert.ok(r.waterTriangles > 0);
        const tile = decodePtm(r.bytes);
        assert.equal(tile.landPositions.length, 0);
    });

    it('draws open sea as one leaf whatever the DEM and cover say under it', () => {
        // Offshore DEMs carry bathymetry and speckle, and the cover raster
        // flickers between classes; neither is drawn, so neither may cut the sea.
        const cover = uniformCover(TerrainClass.Water, [0, 0, 255]);
        for (let i = 0; i < SIZE * SIZE; i += 3) {
            cover.classes[i] = TerrainClass.Grass;
        }
        const r = buildTile(base({
            polygons: [],
            heights: heightsFrom((x, y) => -40 + Math.sin(x * 1.7) * 30 + Math.cos(y * 2.3) * 25),
            cover,
            skirtDepthM: 0,
        }));
        assert.equal(r.landTriangles, 0);
        // Two surface triangles plus one skirt quad per border edge.
        assert.equal(r.waterTriangles, 2 + 4 * 2);
    });

    it('produces both streams for a coastal tile', () => {
        const r = buildTile(base({ polygons: [coastAt(16)] }));
        assert.ok(r.landTriangles > 0, 'land');
        assert.ok(r.waterTriangles > 0, 'water');
    });

    it('paints water near the shore as the shallow tone', () => {
        const r = buildTile(base({
            heights: heightsFrom(() => 0),
            polygons: [coastAt(16)],
        }));
        const tile = decodePtm(r.bytes);
        const [deep, shallow] = tile.waterGroups;
        assert.ok(shallow[1] > 0, 'some shallow water near the coast');
        assert.ok(deep[1] > 0, 'some deep water further out');
    });

    describe('shoreline seam', () => {
        /**
         * Land and water are separate meshes with their own vertices. They meet
         * at the marching-squares crossing points, and if the two sides put
         * those points at different heights the seam opens into a wall you can
         * see straight through. Land used to take the DEM sample there while
         * water sat at sea level, and OSM coastlines do not follow the DEM's
         * zero contour — on real tiles that was tens to hundreds of metres.
         */
        it('bridges the land/water step with a wall instead of moving terrain', () => {
            // Terrain held high right where the coastline runs, which is the
            // real situation: OSM coastlines often follow the foot of a cliff
            // whose DEM pixel reads the top.
            const r = buildTile(base({
                heights: heightsFrom(() => 400),
                polygons: [coastAt(16)],
                skirtDepthM: 0,
            }));
            const tile = decodePtm(r.bytes);

            const ys: number[] = [];
            for (let v = 0; v < tile.landPositions.length / 3; v++) {
                ys.push(tile.landPositions[v * 3 + 1] * tile.quantScale);
            }
            const top = Math.max(...ys);
            const bottom = Math.min(...ys);

            // A wall reaches from the coast down to sea level, so the land mesh
            // spans roughly the full terrain height.
            assert.ok(
                top - bottom > 380,
                `no shore wall: land spans only ${(top - bottom).toFixed(1)} m`,
            );

            // And the terrain itself is untouched. Forcing shoreline vertices
            // to sea level closed the seam but dragged real mountainside down
            // with it — up to 1360 m on Canary tiles — so most of the mesh must
            // still sit at the surface, not somewhere between.
            const atSurface = ys.filter(y => Math.abs(y - top) < 1).length;
            assert.ok(
                atSurface / ys.length > 0.6,
                `terrain was dragged down: only ${(100 * atSurface / ys.length).toFixed(0)}% `
                + 'of land vertices are still at the surface',
            );
        });

        it('still drops open water below land away from the shore', () => {
            // The depth bias has to survive offshore, where it keeps a coplanar
            // beach edge from z-fighting; it is only skipped at the seam.
            const r = buildTile(base({
                heights: heightsFrom(() => 0),
                polygons: [coastAt(16)],
                skirtDepthM: 0,
            }));
            const tile = decodePtm(r.bytes);
            let lowest = Infinity;
            for (let v = 0; v < tile.waterPositions.length / 3; v++) {
                lowest = Math.min(lowest, tile.waterPositions[v * 3 + 1] * tile.quantScale);
            }
            assert.ok(lowest < -0.4, `open water not biased down, lowest ${lowest}`);
        });
    });

    describe('triangle budget', () => {
        // A pathological coastline: a fine comb that cuts a great many cells.
        const combPolygons = (): CoastPolygon[] => {
            const lonAt = (gx: number) => BOUNDS.west + (gx / CELLS) * (BOUNDS.east - BOUNDS.west);
            const latAt = (gy: number) => BOUNDS.north - (gy / CELLS) * (BOUNDS.north - BOUNDS.south);
            const pts: Array<{ lon: number; lat: number }> = [];
            for (let i = 0; i <= CELLS; i++) {
                pts.push({ lon: lonAt(i), lat: latAt(i % 2 === 0 ? 4 : 28) });
            }
            pts.push({ lon: lonAt(CELLS), lat: latAt(-2) });
            pts.push({ lon: lonAt(0), lat: latAt(-2) });
            return [{ exterior: pts, holes: [] }];
        };

        it('coarsens a pathological coastline rather than letting it run away', () => {
            // The shoreline is allowed past the budget - coarsening it is what
            // turned rivers into dashed lines - but only as far as
            // COAST_BUDGET_CEILING. Without a ceiling a Crimea tile reached
            // 60386 triangles, ten times its budget, and one tile that heavy
            // makes the runtime coarsen LOD across the whole scene and stream
            // everything around it in more slowly.
            const budget = 400;
            const r = buildTile(base({
                heights: heightsFrom((x, y) => (x * 37 + y * 53) % 200),
                polygons: combPolygons(),
                triangleBudget: budget,
            }));
            assert.ok(
                r.triangleCount <= budget * COAST_BUDGET_CEILING,
                `${r.triangleCount} triangles exceeds the ceiling `
                + `${budget * COAST_BUDGET_CEILING}`,
            );
            assert.ok(r.attempts > 1, 'the budget actually had to bite');
            assert.ok(r.minLeafSize > 1, 'a comb this fine has to coarsen the cut');
        });

        it('keeps an ordinary coastline at full resolution, over budget or not', () => {
            // The property the dashed rivers cost us: an ordinary shoreline is
            // cut at leaf 1 even when that overspends, because a coarsened cut
            // is wrong where an overspent one is merely expensive.
            const r = buildTile(base({
                heights: heightsFrom((x, y) => 40 + Math.sin(x / 4) * 30),
                polygons: [coastAt(16)],
                triangleBudget: 400,
            }));
            assert.equal(r.minLeafSize, 1);
        });

        it('leaves a tile that already fits untouched', () => {
            const input = base({ heights: heightsFrom(() => 10), triangleBudget: 5000 });
            const r = buildTile(input);
            // The search always probes the coast first, so attempts > 1 even
            // for a tile that fits; what matters is that neither knob moved.
            assert.equal(r.maxErrorM, input.maxErrorM);
            assert.equal(r.minLeafSize, 1);
        });

        it('spends most of the budget instead of overshooting', () => {
            // The naive "alternate doubling both knobs" search landed around a
            // quarter of the budget with a needlessly coarse coast. The search
            // buys the finest coast that fits and then spends the remainder on
            // interior detail, so the result should sit near the ceiling.
            const budget = 1200;
            const r = buildTile(base({
                heights: heightsFrom((x, y) => (x * 37 + y * 53) % 200),
                polygons: [coastAt(16)],
                triangleBudget: budget,
            }));
            assert.ok(r.triangleCount <= budget, `${r.triangleCount} over budget`);
            assert.ok(
                r.triangleCount > budget * 0.4,
                `${r.triangleCount} wastes most of the ${budget} budget`,
            );
        });

        it('prefers a finer coast over a finer interior', () => {
            // A tight budget must show up as a raised interior tolerance, with
            // the shoreline kept as fine as it can afford.
            const r = buildTile(base({
                heights: heightsFrom((x, y) => (x * 37 + y * 53) % 200),
                polygons: [coastAt(16)],
                triangleBudget: 600,
            }));
            assert.ok(r.maxErrorM >= 2, 'interior tolerance did not tighten below the request');
            assert.ok(r.minLeafSize <= 8, `coast coarsened to ${r.minLeafSize} cells`);
        });
    });

    describe('flatten pad', () => {
        const pad = {
            centerX: 0, centerZ: 0, halfW: 500, halfD: 2000,
            featherM: 80, heightMsl: 41.7,
        };
        // A pad now carries the frame it is laid out in, so that one far from
        // the bake origin is measured against its own local north. Here that
        // frame is the bake's, which is what home always is.
        const pads = [{ ...pad, basis: BASIS, lat: 28.0015, lon: -15.3937 }];

        it('flattens the runway footprint to the pad height', () => {
            const bumpy = heightsFrom((x, y) => 40 + ((x * 7 + y * 11) % 23));
            const padHeightMsl = pad.heightMsl;
            // Skirts hang below the surface by design, so they would show up
            // as "core vertices" a full skirt depth under the pad height.
            // Drop them here; the skirt tests below cover them separately.
            const r = buildTile(base({
                heights: bumpy, polygons: [coastAt(CELLS + 2)],
                pads, skirtDepthM: 0,
            }));
            const tile = decodePtm(r.bytes);

            // Tile-local positions are relative to the tile centre and in scene
            // axes (z runs south), so rebuild the absolute ENU of each vertex —
            // flipping z back to north — and check the ones sitting in the
            // pad's flat core.
            const centreLon = (BOUNDS.west + BOUNDS.east) / 2;
            const centreLat = (BOUNDS.south + BOUNDS.north) / 2;
            const centre = ecefToEnu(
                BASIS,
                geodeticToEcef(centreLat, centreLon, r.centerHeightM),
            );

            let inCore = 0;
            for (let v = 0; v < tile.landPositions.length / 3; v++) {
                const e = centre.e + tile.landPositions[v * 3] * tile.quantScale;
                const u = centre.u + tile.landPositions[v * 3 + 1] * tile.quantScale;
                const n = centre.n - tile.landPositions[v * 3 + 2] * tile.quantScale;
                if (padBlendWeight(e, n, pad) < 1) {
                    continue;
                }
                inCore++;
                // ENU up tracks geodetic height to within the curvature drop
                // across a ~1 km tile, which is a few centimetres.
                assert.ok(
                    Math.abs(u - padHeightMsl) < 1.5,
                    `core vertex at ${u.toFixed(2)} m, expected ~${padHeightMsl}`,
                );
            }
            assert.ok(inCore > 0, 'no vertices landed inside the pad core');
        });

        it('changes the mesh compared with no pad at all', () => {
            const bumpy = heightsFrom((x, y) => 40 + ((x * 7 + y * 11) % 23));
            const withPad = buildTile(base({
                heights: bumpy, polygons: [coastAt(CELLS + 2)],
                pads,
            })).bytes;
            const without = buildTile(base({
                heights: bumpy, polygons: [coastAt(CELLS + 2)],
            })).bytes;
            assert.notDeepEqual(Array.from(withPad), Array.from(without));
        });

        it('cuts the platform across the whole core, not just at leaf corners', () => {
            // The pad is applied per *vertex*, so the decimator has to measure
            // its error against the padded surface: merged on the raw DEM, a
            // leaf straddling the rim meets the platform only at its corners
            // and interpolates flat across everything between them. Measured
            // at Gran Canaria, that left a 407 m leaf carrying the ground five
            // to six metres over aprons 150 m inside the flat core — and the
            // pavement, which is draped on the height query, drawn buried.
            //
            // Uniform heights are the sharpest form of it: nothing for the
            // error test to see, so without the pad the whole tile merges into
            // one leaf whose four corners all sit outside the pad.
            const PLATEAU = 300;
            const small = {
                ...padAt(0, 0), halfW: 300, halfD: 400, featherM: 80, heightMsl: 41.7,
            };
            // Under a budget, too: the tolerance the budget search negotiates
            // with gets raised until the interior merges whatever is in it, so
            // the platform needs a condition of its own that nothing relaxes.
            const r = buildTile(base({
                heights: heightsFrom(() => PLATEAU),
                polygons: [coastAt(CELLS + 2)],
                pads: [small], skirtDepthM: 0, triangleBudget: 600,
            }));
            const surface = landSurface(r);

            let checked = 0;
            // Kept a couple of cells clear of the rim: the feather is only as
            // sharp as the DEM under it, and this one steps 258 m over 80.
            for (let de = -150; de <= 150; de += 75) {
                for (let dn = -200; dn <= 200; dn += 100) {
                    const e = small.centerX + de;
                    const n = small.centerZ + dn;
                    if (padBlendWeight(e, n, small) < 1) {
                        continue;
                    }
                    const u = surface(e, n);
                    assert.ok(Number.isFinite(u), `no drawn surface over the core at ${de},${dn}`);
                    checked++;
                    assert.ok(Math.abs(u - small.heightMsl) < 1.5,
                        `drawn ground at ${u.toFixed(2)} m over a core cut to `
                        + `${small.heightMsl} m (${de},${dn} from the pad centre)`);
                }
            }
            assert.ok(checked > 0, 'no sample landed inside the pad core');
        });

        it('is a no-op when no pad is supplied', () => {
            const a = buildTile(base({ polygons: [coastAt(CELLS + 2)] })).bytes;
            const b = buildTile(base({
                polygons: [coastAt(CELLS + 2)], pads: undefined,
            })).bytes;
            assert.deepEqual(Array.from(a), Array.from(b));
        });

        it('cuts the platform to a slope rather than to a shelf', () => {
            // 0.8% along the pad axis, which is due north here. A real runway
            // is allowed 1%, and forcing one level carves a step into ground
            // that falls across the airfield.
            const gradient = 0.008;
            const sloped = [{
                ...pads[0], gradE: 0, gradN: gradient,
            }];
            const r = buildTile(base({
                heights: heightsFrom(() => 40),
                polygons: [coastAt(CELLS + 2)],
                pads: sloped, skirtDepthM: 0,
            }));
            const tile = decodePtm(r.bytes);
            const centre = ecefToEnu(BASIS, geodeticToEcef(
                (BOUNDS.south + BOUNDS.north) / 2,
                (BOUNDS.west + BOUNDS.east) / 2,
                r.centerHeightM,
            ));

            let checked = 0;
            let lowest = Infinity;
            let highest = -Infinity;
            for (let v = 0; v < tile.landPositions.length / 3; v++) {
                const e = centre.e + tile.landPositions[v * 3] * tile.quantScale;
                const u = centre.u + tile.landPositions[v * 3 + 1] * tile.quantScale;
                const n = centre.n - tile.landPositions[v * 3 + 2] * tile.quantScale;
                if (padBlendWeight(e, n, pad) < 1) {
                    continue;
                }
                checked++;
                lowest = Math.min(lowest, u);
                highest = Math.max(highest, u);
                assert.ok(Math.abs(u - (pad.heightMsl + gradient * n)) < 1.5,
                    `vertex ${n.toFixed(0)} m north sits at ${u.toFixed(2)} m`);
            }
            assert.ok(checked > 0, 'no vertices landed inside the pad core');
            assert.ok(highest - lowest > 1,
                'the platform came out level, so the gradient was ignored');
        });

        it('treats the platform as land where the coast says otherwise', () => {
            // Gran Canaria: the airport is built out onto the shore and part of
            // its apron falls outside the OSM coastline. Left as sea, that is a
            // notch of open ocean through the middle of a flattened airfield.
            const allSea: CoastPolygon[] = [];
            const withPad = buildTile(base({
                heights: heightsFrom(() => 0), polygons: allSea,
                pads, skirtDepthM: 0,
            }));
            const without = buildTile(base({
                heights: heightsFrom(() => 0), polygons: allSea, skirtDepthM: 0,
            }));
            assert.equal(without.landTriangles, 0, 'the tile should be all sea without a pad');
            assert.ok(withPad.landTriangles > 0,
                'the pad core did not become land');

            // And the surface it became sits at the pad height, not at sea
            // level. The *highest* vertex, because the land stream also holds
            // the feet of the shore walls that now drop from the platform edge
            // to the water beside it, and those belong at sea level.
            const tile = decodePtm(withPad.bytes);
            const centre = ecefToEnu(BASIS, geodeticToEcef(
                (BOUNDS.south + BOUNDS.north) / 2,
                (BOUNDS.west + BOUNDS.east) / 2,
                withPad.centerHeightM,
            ));
            let highest = -Infinity;
            let atPadHeight = 0;
            for (let v = 0; v < tile.landPositions.length / 3; v++) {
                const e = centre.e + tile.landPositions[v * 3] * tile.quantScale;
                const u = centre.u + tile.landPositions[v * 3 + 1] * tile.quantScale;
                const n = centre.n - tile.landPositions[v * 3 + 2] * tile.quantScale;
                if (padBlendWeight(e, n, pad) < 1) {
                    continue;
                }
                highest = Math.max(highest, u);
                if (Math.abs(u - pad.heightMsl) < 1.5) {
                    atPadHeight++;
                }
            }
            assert.ok(Math.abs(highest - pad.heightMsl) < 1.5,
                `platform tops out at ${highest.toFixed(2)} m, expected ~${pad.heightMsl}`);
            assert.ok(atPadHeight > 0, 'nothing was raised to the pad height');
        });
    });

    describe('skirts', () => {
        it('adds skirt geometry along the tile border', () => {
            const withSkirt = buildTile(base({
                polygons: [coastAt(CELLS + 2)], skirtDepthM: 50,
            }));
            const noSkirt = buildTile(base({
                polygons: [coastAt(CELLS + 2)], skirtDepthM: 0,
            }));
            assert.ok(
                withSkirt.landTriangles > noSkirt.landTriangles - 1,
                'skirt quads are present',
            );
            // A 32-cell border decimated to one leaf gives 4 border edges,
            // each becoming 2 triangles.
            assert.ok(withSkirt.landTriangles >= noSkirt.landTriangles);
        });

        it('hangs skirts below the surface, not above it', () => {
            const r = buildTile(base({
                heights: heightsFrom(() => 100),
                polygons: [coastAt(CELLS + 2)],
                skirtDepthM: 50,
            }));
            const tile = decodePtm(r.bytes);
            let minY = Infinity;
            let maxY = -Infinity;
            for (let v = 0; v < tile.landPositions.length / 3; v++) {
                const y = tile.landPositions[v * 3 + 1] * tile.quantScale;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            assert.ok(maxY - minY >= 49, `skirt depth not reflected: ${maxY - minY}`);
        });
    });

    it('handles the real 257-node tile size', () => {
        const size = 257;
        const heights = new Float32Array(size * size);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                heights[y * size + x] = Math.sin(x / 25) * 300 + Math.cos(y / 19) * 200;
            }
        }
        const r = buildTile({
            ...base(),
            size,
            heights,
            polygons: [coastAt(128)],
            triangleBudget: 3072,
        });
        assert.ok(r.triangleCount <= 3072, `${r.triangleCount} triangles`);
        const tile = decodePtm(r.bytes);
        assert.ok(tile.boundingRadiusM > 100);
        assert.ok(r.bytes.byteLength < 200_000, `${r.bytes.byteLength} bytes is too large`);
    });
});

describe('buildTile cover', () => {
    it('paints every facet with the observed class when cover is uniform', () => {
        const r = buildTile(base({
            polygons: [coastAt(CELLS + 2)],
            cover: uniformCover(TerrainClass.Shrub, [90, 100, 60]),
        }));
        assert.deepEqual(classesIn(r.bytes), new Set([TerrainClass.Shrub]));
        const tile = decodePtm(r.bytes);
        for (let v = 0; v < tile.landAttrs.length; v += 4) {
            assert.equal(tile.landAttrs[v], 90);
            assert.equal(tile.landAttrs[v + 1], 100);
            assert.equal(tile.landAttrs[v + 2], 60);
        }
    });

    it('splits geometry at a real cover-class boundary instead of voting it away', () => {
        // Flat, all-land, split straight down the middle: Tree on the west
        // half, Crop on the east. Height alone would merge the whole tile
        // into one leaf/two triangles - the boundary must force real facets
        // on both sides to survive into the baked mesh.
        const cover = uniformCover(TerrainClass.Tree, [40, 90, 40]);
        for (let y = 0; y < SIZE; y++) {
            for (let x = Math.ceil(SIZE / 2); x < SIZE; x++) {
                const i = y * SIZE + x;
                cover.classes[i] = TerrainClass.Crop;
                cover.colors[i * 3] = 150;
                cover.colors[i * 3 + 1] = 160;
                cover.colors[i * 3 + 2] = 70;
            }
        }
        const r = buildTile(base({
            polygons: [coastAt(CELLS + 2)],
            maxErrorM: 1e9, // nothing here forces refinement except the boundary
            cover,
        }));
        assert.deepEqual(classesIn(r.bytes), new Set([TerrainClass.Tree, TerrainClass.Crop]),
            'both classes must survive - the boundary is not a minority to be voted away');
        const tile = decodePtm(r.bytes);
        assert.ok(tile.landAttrs.length / 4 > 6,
            'a real boundary needs more than the two-triangle fan a flat, uniform tile gets');
    });

    it('takes the majority class over a facet, not whatever is at its centre', () => {
        // A single stripe of built-up two cells wide down the middle of an
        // otherwise shrubby tile. A real cover-class boundary now refuses a
        // decimator merge on its own (see DecimateInput.coverClasses), so
        // minLeafSize is pinned coarser than the stripe is wide - the floor
        // it cannot subdivide past - to keep a facet straddling the stripe
        // for majority-vote to resolve. Without that floor every facet would
        // simply split around the stripe instead, which is the new feature
        // working as intended, not a case this test is about.
        const cover = uniformCover(TerrainClass.Shrub, [90, 100, 60]);
        for (let y = 0; y < SIZE; y++) {
            for (let x = 15; x < 17; x++) {
                cover.classes[y * SIZE + x] = TerrainClass.Built;
            }
        }
        const r = buildTile(base({
            polygons: [coastAt(CELLS + 2)],
            maxErrorM: 1e9,       // coarse facets, so each spans many cells
            minLeafSize: 8,       // coarser than the 2-cell stripe
            cover,
        }));
        assert.deepEqual(classesIn(r.bytes), new Set([TerrainClass.Shrub]));
    });

    it('turns bare ground near the shore into sand, and leaves inland bare alone', () => {
        const coastal = buildTile(base({
            polygons: [coastAt(4)],
            cover: uniformCover(TerrainClass.Bare, [180, 170, 140]),
        }));
        assert.ok(classesIn(coastal.bytes).has(TerrainClass.Sand),
            'a 150 m-wide strip of land is all beach');

        // The same cover on a tile with no water at all has no shore to be
        // near, so nothing may be reclassified.
        const inland = buildTile(base({
            polygons: [coastAt(CELLS + 2)],
            cover: uniformCover(TerrainClass.Bare, [180, 170, 140]),
        }));
        assert.deepEqual(classesIn(inland.bytes), new Set([TerrainClass.Bare]));
    });

    it('does not paint sea inland when the two sources disagree about the shore', () => {
        // The OSM vector says this is all land; the raster says open water.
        // The vector wins — the alternative is a lake where a hillside is.
        const r = buildTile(base({
            polygons: [coastAt(CELLS + 2)],
            cover: uniformCover(TerrainClass.Water, [20, 40, 90]),
        }));
        assert.deepEqual(classesIn(r.bytes), new Set([TerrainClass.Grass]));
    });

    it('gives shore walls and skirts the cover of the facet they hang from', () => {
        // A coastal tile has both. Every land facet, wall and skirt included,
        // must carry the one class present — a wall in a different colour
        // reads as a painted stripe along the coast.
        const r = buildTile(base({
            polygons: [coastAt(16)],
            cover: uniformCover(TerrainClass.Tree, [30, 70, 30]),
        }));
        assert.ok(r.landTriangles > 0);
        assert.deepEqual(classesIn(r.bytes), new Set([TerrainClass.Tree]));
    });

    it('rejects cover on a different grid than the heights', () => {
        const cover = uniformCover(TerrainClass.Shrub, [90, 100, 60]);
        assert.throws(
            () => buildTile(base({ polygons: [coastAt(16)], cover: { ...cover, size: SIZE + 1 } })),
            /cover size/,
        );
    });

    it('reports the facet colours it emitted, for the swatch histogram', () => {
        const r = buildTile(base({
            polygons: [coastAt(CELLS + 2)],
            cover: uniformCover(TerrainClass.Shrub, [90, 100, 60]),
        }));
        assert.equal(r.landColors.length, r.landTriangles * 3);
        assert.equal(r.landColors[0], 90);
    });
});

describe('buildTile regions', () => {
    /** Every absolute vertex height (ENU up) among the land facets. */
    function landHeights(r: ReturnType<typeof buildTile>): number[] {
        const tile = decodePtm(r.bytes);
        const centre = tileCentreEnu(r.centerHeightM);
        const p = tile.landPositions;
        const s = tile.quantScale;
        const out: number[] = [];
        for (let v = 0; v * 3 < p.length; v++) {
            out.push(centre.u + p[v * 3 + 1] * s);
        }
        return out;
    }

    it('cuts real geometry at a landuse boundary, with no cover data at all', () => {
        // West half Tree, east half Crop, flat and all-land - height alone
        // would merge this into a single leaf, same as the flat-uniform-tile
        // case in the plain 'buildTile' suite.
        const west = regionAt(-1, -1, SIZE / 2, CELLS + 1, true, TerrainClass.Tree);
        const east = regionAt(SIZE / 2, -1, CELLS + 1, CELLS + 1, true, TerrainClass.Crop);
        const r = buildTile(base({
            polygons: [coastAt(CELLS + 2)],
            heights: heightsFrom(() => 50),
            maxErrorM: 1e9,
            regions: [west, east],
        }));
        assert.deepEqual(classesIn(r.bytes), new Set([TerrainClass.Unknown, TerrainClass.Tree, TerrainClass.Crop]),
            'both classes must survive - the region cut is not a raster vote to be merged away');
        const tile = decodePtm(r.bytes);
        assert.ok(tile.landAttrs.length / 4 > 6,
            'a real boundary needs more than the two-triangle fan a flat, uniform tile gets');
    });

    it('paints untagged land as unknown, not with the raster class, once a tile has regions', () => {
        // The polygons decide the fill; the raster's blobs must not show
        // through around them.
        const bare = regionAt(-1, -1, CELLS + 1, CELLS + 1, true, undefined);
        const r = buildTile(base({
            polygons: [coastAt(CELLS + 2)],
            cover: uniformCover(TerrainClass.Shrub, [90, 100, 60]),
            regions: [bare],
        }));
        assert.deepEqual(classesIn(r.bytes), new Set([TerrainClass.Unknown]));
    });

    it('fills each region with one colour and does not cut along raster class edges', () => {
        // Raster: west half Built, east half Tree, in two different colours.
        // Regions: one tagged Crop polygon over the whole tile. The mesh must
        // come out as Crop everywhere, in a single colour, with no split down
        // the raster's middle.
        const cover = uniformCover(TerrainClass.Built, [120, 120, 120]);
        for (let y = 0; y < SIZE; y++) {
            for (let x = Math.ceil(SIZE / 2); x < SIZE; x++) {
                const i = y * SIZE + x;
                cover.classes[i] = TerrainClass.Tree;
                cover.colors[i * 3] = 40;
                cover.colors[i * 3 + 1] = 90;
                cover.colors[i * 3 + 2] = 40;
            }
        }
        const crop = regionAt(-1, -1, CELLS + 1, CELLS + 1, true, TerrainClass.Crop);
        const r = buildTile(base({
            polygons: [coastAt(CELLS + 2)],
            heights: heightsFrom(() => 50),
            maxErrorM: 1e9,
            cover,
            regions: [crop],
        }));
        // The mesh underneath is untagged ground; the polygon is the fill on it.
        assert.deepEqual(classesIn(r.bytes), new Set([TerrainClass.Unknown, TerrainClass.Crop]));
        const tile = decodePtm(r.bytes);
        const colours = new Set<string>();
        for (let v = 0; v * 4 < tile.landAttrs.length; v++) {
            if (tile.landAttrs[v * 4 + 3] !== TerrainClass.Crop) {
                continue;
            }
            colours.add(`${tile.landAttrs[v * 4]},${tile.landAttrs[v * 4 + 1]},${tile.landAttrs[v * 4 + 2]}`);
        }
        assert.equal(colours.size, 1, `region filled with ${colours.size} colours`);
    });

    it('puts the fill edge where the polygon edge is, not on the grid', () => {
        // A Crop polygon whose east edge falls between grid nodes, on a tile
        // coarse enough that a grid cut would snap it a whole cell away.
        const edgeX = 10.37;
        const crop = regionAt(-1, -1, edgeX, CELLS + 1, true, TerrainClass.Crop);
        const r = buildTile(base({
            polygons: [coastAt(CELLS + 2)],
            heights: heightsFrom(() => 50),
            maxErrorM: 1e9,
            minLeafSize: 8,
            regions: [crop],
        }));
        const tile = decodePtm(r.bytes);
        const centre = tileCentreEnu(r.centerHeightM);
        const lat = (BOUNDS.south + BOUNDS.north) / 2;
        const edgeLon = BOUNDS.west + (edgeX / CELLS) * (BOUNDS.east - BOUNDS.west);
        const centreLon = (BOUNDS.west + BOUNDS.east) / 2;
        const edgeE = centre.e + (edgeLon - centreLon) * 111320 * Math.cos(lat * Math.PI / 180);
        let maxE = -Infinity;
        for (let v = 0; v * 4 < tile.landAttrs.length; v++) {
            if (tile.landAttrs[v * 4 + 3] === TerrainClass.Crop) {
                maxE = Math.max(maxE, centre.e + tile.landPositions[v * 3] * tile.quantScale);
            }
        }
        const cellM = ((BOUNDS.east - BOUNDS.west) / CELLS) * 111320 * Math.cos(lat * Math.PI / 180);
        assert.ok(Math.abs(maxE - edgeE) < 1.5,
            `fill reaches ${(maxE - edgeE).toFixed(2)} m past the polygon edge (a cell is ${cellM.toFixed(0)} m)`);
    });

    it('colours unmapped ground per vertex from the regional sampler, and polygons evenly', () => {
        // A sampler that ramps red from west to east: untagged ground must pick
        // it up per vertex (and so vary across the tile), while the Crop
        // polygon keeps one colour of its own.
        const crop = regionAt(-1, -1, CELLS / 2, CELLS + 1, true, TerrainClass.Crop);
        const r = buildTile(base({
            polygons: [coastAt(CELLS + 2)],
            heights: heightsFrom(() => 50),
            cover: uniformCover(TerrainClass.Grass, [90, 110, 70]),
            regions: [crop],
            groundColorAt: (lon) => {
                const t = (lon - BOUNDS.west) / (BOUNDS.east - BOUNDS.west);
                return [Math.round(40 + 160 * Math.min(1, Math.max(0, t))), 100, 60];
            },
        }));
        assert.deepEqual(classesIn(r.bytes), new Set([TerrainClass.Ground, TerrainClass.Crop]));
        const tile = decodePtm(r.bytes);
        const groundReds = new Set<number>();
        const cropColours = new Set<string>();
        for (let v = 0; v * 4 < tile.landAttrs.length; v++) {
            const a = tile.landAttrs;
            if (a[v * 4 + 3] === TerrainClass.Ground) {
                groundReds.add(a[v * 4]);
            } else if (a[v * 4 + 3] === TerrainClass.Crop) {
                cropColours.add(`${a[v * 4]},${a[v * 4 + 1]},${a[v * 4 + 2]}`);
            }
        }
        // Flat ground decimates to a few large facets, so there may be only a
        // handful of vertices - but they must carry the sampler's values at
        // their own positions: the west end dark, the east end bright.
        const reds = [...groundReds];
        assert.ok(Math.min(...reds) <= 60 && Math.max(...reds) >= 180,
            `ground reds ${reds.join(',')} did not follow the west-to-east ramp`);
        assert.equal(cropColours.size, 1, `polygon filled with ${cropColours.size} colours`);
    });

    it('does not drop a landuse-only boundary down to sea level', () => {
        // The regression case for a real bug found while building this
        // feature: a crossing between two land regions was being tagged the
        // same way as a genuine shoreline crossing, and the shore-wall pass
        // built a wall from the 200 m plateau down to sea level along every
        // Tree/Crop edge. Flat at 200 m: legitimate vertices sit either on
        // that surface or, at the tile border only, on the 25 m skirt
        // (175 m) - nothing legitimate belongs anywhere near sea level (0 m),
        // which is exactly where a spurious wall would reach.
        const west = regionAt(-1, -1, SIZE / 2, CELLS + 1, true, TerrainClass.Tree);
        const east = regionAt(SIZE / 2, -1, CELLS + 1, CELLS + 1, true, TerrainClass.Crop);
        const r = buildTile(base({
            polygons: [coastAt(CELLS + 2)],
            heights: heightsFrom(() => 200),
            maxErrorM: 1e9,
            regions: [west, east],
        }));
        for (const h of landHeights(r)) {
            assert.ok(h > 100, `vertex at ${h} - a spurious wall reached down toward sea level`);
        }
    });

    it('fills only over land where a landuse edge meets the shoreline', () => {
        // Land on the west two thirds (the coast polygon decides that, not
        // the regions); Tree in the north, Crop in the south, both running
        // right across the tile. The fill must stop at the shore.
        const shoreX = Math.round((CELLS * 2) / 3);
        const north = regionAt(-1, -1, CELLS + 1, SIZE / 2, true, TerrainClass.Tree);
        const south = regionAt(-1, SIZE / 2, CELLS + 1, CELLS + 1, true, TerrainClass.Crop);
        const r = buildTile(base({
            polygons: [coastAt(shoreX)],
            heights: heightsFrom(() => 50),
            maxErrorM: 1e9,
            minLeafSize: 1,
            regions: [north, south],
        }));
        assert.ok(r.waterTriangles > 0, 'the sea east of the coast must still be water');
        assert.deepEqual(classesIn(r.bytes), new Set([TerrainClass.Unknown, TerrainClass.Tree, TerrainClass.Crop]));
        const tile = decodePtm(r.bytes);
        const centre = tileCentreEnu(r.centerHeightM);
        const lat = (BOUNDS.south + BOUNDS.north) / 2;
        const metresPerLon = 111320 * Math.cos(lat * Math.PI / 180);
        const shoreE = centre.e
            + (BOUNDS.west + (shoreX / CELLS) * (BOUNDS.east - BOUNDS.west) - (BOUNDS.west + BOUNDS.east) / 2)
            * metresPerLon;
        const cellM = ((BOUNDS.east - BOUNDS.west) / CELLS) * metresPerLon;
        for (let v = 0; v * 4 < tile.landAttrs.length; v++) {
            const cls = tile.landAttrs[v * 4 + 3];
            if (cls !== TerrainClass.Tree && cls !== TerrainClass.Crop) {
                continue;
            }
            const e = centre.e + tile.landPositions[v * 3] * tile.quantScale;
            assert.ok(e < shoreE + cellM, `fill vertex ${(e - shoreE).toFixed(1)} m out to sea`);
        }
    });

    describe('outlines', () => {
        const kindsOf = (bytes: Uint8Array): Set<number> => {
            const tile = decodePtm(bytes);
            const kinds = new Set<number>();
            for (let v = 0; v * 4 < tile.riverDirections.length; v++) {
                kinds.add(tile.riverDirections[v * 4 + 3]);
            }
            return kinds;
        };

        it('strokes the edge of a tagged region, marked as an outline', () => {
            const west = regionAt(-1, -1, SIZE / 2, CELLS + 1, true, TerrainClass.Tree);
            const east = regionAt(SIZE / 2, -1, CELLS + 1, CELLS + 1, true, undefined);
            const r = buildTile(base({
                polygons: [coastAt(CELLS + 2)],
                heights: heightsFrom(() => 50),
                regions: [west, east],
            }));
            assert.deepEqual(kindsOf(r.bytes), new Set([PTM_STROKE_KIND_OUTLINE]));
            assert.equal(r.riverTriangles, 0, 'an outline is not a watercourse');
        });

        it('draws nothing along the tile border or around untagged land', () => {
            // A tagged region filling the tile has no edge but the border, and
            // an untagged one has no edge worth drawing at all.
            const whole = regionAt(-1, -1, CELLS + 1, CELLS + 1, true, TerrainClass.Crop);
            const filled = decodePtm(buildTile(base({
                polygons: [coastAt(CELLS + 2)], regions: [whole],
            })).bytes);
            assert.equal(filled.riverIndices.length, 0);

            const bare = regionAt(-1, -1, CELLS + 1, CELLS + 1, true, undefined);
            const untagged = decodePtm(buildTile(base({
                polygons: [coastAt(CELLS + 2)], regions: [bare],
            })).bytes);
            assert.equal(untagged.riverIndices.length, 0);
        });

        it('keeps watercourses marked as water beside outlines', () => {
            const west = regionAt(-1, -1, SIZE / 2, CELLS + 1, true, TerrainClass.Tree);
            const course: Watercourse = {
                widthM: 12,
                points: [
                    { lon: BOUNDS.west, lat: (BOUNDS.north + BOUNDS.south) / 2 },
                    { lon: BOUNDS.east, lat: (BOUNDS.north + BOUNDS.south) / 2 },
                ],
            };
            const r = buildTile(base({
                polygons: [coastAt(CELLS + 2)],
                regions: [west],
                watercourses: [course],
            }));
            assert.deepEqual(kindsOf(r.bytes), new Set([PTM_STROKE_KIND_WATER, PTM_STROKE_KIND_OUTLINE]));
            assert.ok(r.riverTriangles > 0);
        });
    });
});

describe('inland water height', () => {
    const lonAt = (gx: number) => BOUNDS.west + (gx / CELLS) * (BOUNDS.east - BOUNDS.west);
    const latAt = (gy: number) => BOUNDS.north - (gy / CELLS) * (BOUNDS.north - BOUNDS.south);
    const ringOf = (x0: number, y0: number, x1: number, y1: number) => [
        { lon: lonAt(x0), lat: latAt(y0) },
        { lon: lonAt(x1), lat: latAt(y0) },
        { lon: lonAt(x1), lat: latAt(y1) },
        { lon: lonAt(x0), lat: latAt(y1) },
    ];

    /**
     * The whole tile as land with a rectangular hole cut out of it.
     *
     * This is the shape the real bake produces: inland water is subtracted from
     * the land polygons, so a lake arrives as a hole, and every node inside it
     * classifies as "not land".
     */
    const landWithHole = (x0: number, y0: number, x1: number, y1: number): CoastPolygon => ({
        exterior: ringOf(-1, -1, CELLS + 1, CELLS + 1),
        holes: [ringOf(x0, y0, x1, y1)],
    });

    const inlandRect = (
        x0: number, y0: number, x1: number, y1: number, surfaceHeightM?: number,
    ) => ({ exterior: ringOf(x0, y0, x1, y1), holes: [], surfaceHeightM });

    /** Geodetic heights of every water vertex in a built tile. */
    function waterHeights(r: ReturnType<typeof buildTile>): number[] {
        const tile = decodePtm(r.bytes);
        const centre = ecefToEnu(BASIS, geodeticToEcef(
            (BOUNDS.south + BOUNDS.north) / 2,
            (BOUNDS.west + BOUNDS.east) / 2,
            r.centerHeightM,
        ));
        const out: number[] = [];
        for (let v = 0; v < tile.waterPositions.length / 3; v++) {
            out.push(centre.u + tile.waterPositions[v * 3 + 1] * tile.quantScale);
        }
        return out;
    }

    it('sits a lake at its own surface, not at sea level', () => {
        const r = buildTile(base({
            heights: heightsFrom(() => 820),
            polygons: [landWithHole(10, 10, 22, 22)],
            inland: [inlandRect(10, 10, 22, 22, 800)],
        }));
        const hs = waterHeights(r);
        assert.ok(hs.length > 0, 'no water vertices were produced');
        // The whole lake is within a metre of its surface: the depth bias is
        // half a metre, and the tile is small enough that ENU up is height.
        for (const h of hs) {
            assert.ok(
                Math.abs(h - 800) < 1.5,
                `water vertex at ${h.toFixed(1)} m, expected ~800`,
            );
        }
    });

    it('leaves open ocean at sea level', () => {
        // The same tile without an inland layer is what an LVR1 tile decodes
        // to, and it must bake exactly as it always did.
        const r = buildTile(base({
            heights: heightsFrom(() => 820),
            polygons: [landWithHole(10, 10, 22, 22)],
        }));
        const hs = waterHeights(r);
        assert.ok(hs.length > 0, 'no water vertices were produced');
        for (const h of hs) {
            assert.ok(Math.abs(h) < 1.5, `water vertex at ${h.toFixed(1)} m, expected ~0`);
        }
    });

    it('lets a river follow the terrain instead of flattening it', () => {
        // No surface height: flowing water descends across a tile, so a single
        // flat plane would be wrong in a way a lake's never is.
        const r = buildTile(base({
            heights: heightsFrom((_x, y) => 900 - y * 4),
            polygons: [landWithHole(10, 2, 22, CELLS - 2)],
            inland: [inlandRect(10, 2, 22, CELLS - 2)],
        }));
        const hs = waterHeights(r);
        assert.ok(hs.length > 0, 'no water vertices were produced');
        const min = Math.min(...hs);
        const max = Math.max(...hs);
        assert.ok(min > 700, `river bottomed out at ${min.toFixed(1)} m, nowhere near sea level`);
        assert.ok(max - min > 50, `river spans only ${(max - min).toFixed(1)} m; it should descend`);
    });

    it('clamps the rim of a lake down to the ground it meets', () => {
        // A surface above its own shore would leave water standing over dry
        // land, which is the one artifact that reads as broken from the air.
        const r = buildTile(base({
            heights: heightsFrom(() => 800),
            polygons: [landWithHole(10, 10, 22, 22)],
            inland: [inlandRect(10, 10, 22, 22, 900)],
        }));
        const hs = waterHeights(r);
        assert.ok(hs.length > 0, 'no water vertices were produced');
        assert.ok(
            Math.abs(Math.min(...hs) - 800) < 1.5,
            `lake rim at ${Math.min(...hs).toFixed(1)} m, expected clamping to the 800 m shore`,
        );
        assert.ok(
            Math.max(...hs) > 898,
            `lake interior at ${Math.max(...hs).toFixed(1)} m, expected it to stay flat at 900`,
        );
    });
});

/** Guards against a fixture that vacuously passes by producing no geometry. */
function tileHasLand(r: ReturnType<typeof buildTile>): boolean {
    return decodePtm(r.bytes).landPositions.length > 0;
}

describe('skirts at a distant ENU origin', () => {
    // The real bake lays the whole planet out in one ENU frame centred on the
    // play origin, so a tile on another continent sits thousands of kilometres
    // from it — and the frame's u axis is local "up" only near that origin.
    const FAR_BASIS = makeEnuBasis(28.0015, -15.3937, 0); // Canary Islands
    const CANYON: LonLatBounds = {
        west: -112.10449, east: -112.06055, south: 36.07910, north: 36.12305,
    };

    it('hangs a skirt below the tile rather than flinging it sideways', () => {
        const r = buildTile({
            id: { z: 12, x: 1545, y: 1226 },
            bounds: CANYON,
            heights: heightsFrom(() => 800),
            size: SIZE,
            seaLevel: 0,
            maxErrorM: 2,
            skirtDepthM: 178,
            basis: FAR_BASIS,
            // Without a land polygon the whole tile is ocean and there is no
            // land skirt to check at all.
            polygons: [{
                exterior: [
                    { lon: CANYON.west - 1, lat: CANYON.north + 1 },
                    { lon: CANYON.east + 1, lat: CANYON.north + 1 },
                    { lon: CANYON.east + 1, lat: CANYON.south - 1 },
                    { lon: CANYON.west - 1, lat: CANYON.south - 1 },
                ],
                holes: [],
            }],
        });
        assert.ok(tileHasLand(r), 'fixture produced no land, so it checks nothing');
        const tile = decodePtm(r.bytes);
        const centre = ecefToEnu(FAR_BASIS, geodeticToEcef(
            (CANYON.south + CANYON.north) / 2,
            (CANYON.west + CANYON.east) / 2,
            r.centerHeightM,
        ));
        let outLon = 0;
        let outLat = 0;
        let lowest = Infinity;
        for (let v = 0; v < tile.landPositions.length / 3; v++) {
            const p = enuToEcef(FAR_BASIS, {
                e: centre.e + tile.landPositions[v * 3] * tile.quantScale,
                u: centre.u + tile.landPositions[v * 3 + 1] * tile.quantScale,
                n: centre.n - tile.landPositions[v * 3 + 2] * tile.quantScale,
            });
            const g = ecefToGeodetic(p.x, p.y, p.z);
            outLon = Math.max(outLon, g.lon - CANYON.east, CANYON.west - g.lon);
            outLat = Math.max(outLat, g.lat - CANYON.north, CANYON.south - g.lat);
            lowest = Math.min(lowest, g.height);
        }
        // The terrain is flat at 800 m, so the skirt's foot belongs at 622 m.
        // Subtracting from ENU u instead only reached 765 m here — a third of
        // the drop — because u is barely vertical this far from the origin.
        assert.ok(
            Math.abs(lowest - (800 - 178)) < 2,
            `skirt foot at ${lowest.toFixed(1)} m, expected ~622 (a full ${178} m below the surface)`,
        );
        // A skirt dropped along the local vertical keeps the tile's footprint.
        // Subtracting from ENU u instead moved it 174 m sideways here, which is
        // ~0.0019 deg of longitude — two orders of magnitude past this bound.
        assert.ok(
            outLon < 1e-4,
            `land vertex ${(outLon * 111320 * 0.81).toFixed(0)} m outside the tile in longitude`,
        );
        assert.ok(
            outLat < 1e-4,
            `land vertex ${(outLat * 110540).toFixed(0)} m outside the tile in latitude`,
        );
    });
});

describe('normal orientation at a distant ENU origin', () => {
    const FAR_BASIS = makeEnuBasis(28.0015, -15.3937, 0); // Canary Islands
    const CANYON: LonLatBounds = {
        west: -112.10449, east: -112.06055, south: 36.07910, north: 36.12305,
    };
    const FULL_LAND: CoastPolygon = {
        exterior: [
            { lon: CANYON.west - 1, lat: CANYON.north + 1 },
            { lon: CANYON.east + 1, lat: CANYON.north + 1 },
            { lon: CANYON.east + 1, lat: CANYON.south - 1 },
            { lon: CANYON.west - 1, lat: CANYON.south - 1 },
        ],
        holes: [],
    };

    it('points every land normal along the local vertical, not the frame y axis', () => {
        // Rugged on purpose, in both axes. A single plane will not do it: every
        // normal is then the same one, so the old rule either flips all of them
        // or none. Real canyon terrain points normals in every direction, and
        // 31% of them came out facing into the ground on tile 12/1545/1226.
        const r = buildTile(base({
            bounds: CANYON,
            basis: FAR_BASIS,
            heights: heightsFrom((x, y) =>
                800 + Math.sin(x / 3) * 250 + Math.cos(y / 3) * 250 + Math.sin((x + y) / 2) * 120),
            polygons: [FULL_LAND],
            skirtDepthM: 178,
        }));
        const tile = decodePtm(r.bytes);
        assert.ok(tileHasLand(r), 'fixture produced no land, so it checks nothing');

        // Local up in tile-local axes, the same way buildTile derives it.
        const centre = ecefToEnu(FAR_BASIS, geodeticToEcef(
            (CANYON.south + CANYON.north) / 2,
            (CANYON.west + CANYON.east) / 2,
            r.centerHeightM,
        ));
        const above = ecefToEnu(FAR_BASIS, geodeticToEcef(
            (CANYON.south + CANYON.north) / 2,
            (CANYON.west + CANYON.east) / 2,
            r.centerHeightM + 1000,
        ));
        const ux = above.e - centre.e;
        const uy = above.u - centre.u;
        const uz = centre.n - above.n;
        const ul = Math.hypot(ux, uy, uz);

        let downward = 0;
        const count = tile.landNormals.length / 4;
        for (let v = 0; v < count; v++) {
            const nx = tile.landNormals[v * 4] / 127;
            const ny = tile.landNormals[v * 4 + 1] / 127;
            const nz = tile.landNormals[v * 4 + 2] / 127;
            if ((nx * ux + ny * uy + nz * uz) / ul < -0.01) {
                downward++;
            }
        }
        assert.equal(
            downward, 0,
            `${downward} of ${count} land normals point into the ground; `
            + 'the fixed-sun shading follows them',
        );
    });
});

describe('watercourse strokes', () => {
    /** All land, so the stroke has real terrain under it to follow. */
    const LAND = { polygons: [coastAt(CELLS + 2)] };

    /** An east-west canal along the middle of the tile. */
    function canal(widthM = 12): Watercourse {
        const lat = (BOUNDS.south + BOUNDS.north) / 2;
        return {
            widthM,
            points: [
                { lon: BOUNDS.west, lat },
                { lon: BOUNDS.east, lat },
            ],
        };
    }

    it('emits a stroke for a canal far too narrow to cut into the grid', () => {
        // A cell here is ~35 m, so a 12 m canal cannot land on a node at all.
        const plain = decodePtm(buildTile(base(LAND)).bytes);
        const withCanal = decodePtm(
            buildTile(base({ ...LAND, watercourses: [canal()] })).bytes);
        assert.equal(plain.riverIndices.length, 0);
        assert.ok(withCanal.riverIndices.length > 0);
        // ...and it changes nothing about the surface underneath it.
        assert.equal(withCanal.landPositions.length, plain.landPositions.length);
        assert.equal(withCanal.waterIndices.length, plain.waterIndices.length);
    });

    it('carries the true width, not a widened one', () => {
        const tile = decodePtm(
            buildTile(base({ ...LAND, watercourses: [canal(12)] })).bytes);
        for (let i = 0; i < tile.riverHalfWidths.length; i++) {
            assert.equal(tile.riverHalfWidths[i], 60);   // 6.0 m in decimetres
        }
    });

    it('resamples a long straight reach so the stroke follows the terrain', () => {
        // Two OSM nodes a whole tile apart: without resampling the stroke
        // would be one quad flying over everything between them.
        const tile = decodePtm(
            buildTile(base({ ...LAND, watercourses: [canal()] })).bytes);
        const pairs = tile.riverHalfWidths.length / 2;
        assert.ok(pairs > CELLS / 2, `only ${pairs} centreline points`);
        const heights = new Set<number>();
        for (let v = 0; v < tile.riverHalfWidths.length; v++) {
            heights.add(tile.riverPositions[v * 3 + 1]);
        }
        assert.ok(heights.size > 2, `stroke is flat over varying ground (${heights.size})`);
    });

    it('pairs every centreline point with opposite offsets across the flow', () => {
        const tile = decodePtm(
            buildTile(base({ ...LAND, watercourses: [canal()] })).bytes);
        for (let p = 0; p * 2 + 1 < tile.riverHalfWidths.length; p++) {
            const a = p * 2;
            const b = a + 1;
            for (let k = 0; k < 3; k++) {
                assert.equal(tile.riverPositions[a * 3 + k], tile.riverPositions[b * 3 + k]);
                // Summed rather than negated: a zero component negates to -0,
                // which is not strictly equal to the 0 on the other side.
                assert.equal(
                    tile.riverDirections[a * 4 + k] + tile.riverDirections[b * 4 + k], 0);
            }
        }
    });

    it('sits on the surface that is drawn, not on the DEM under it', () => {
        // A coarse tolerance decimates the interior hard, so the drawn surface
        // and the DEM part company by metres. Draped on the DEM the stroke
        // would be buried; the check is that every point of it is at or above
        // the land triangle it falls in.
        const r = buildTile(base({
            ...LAND, maxErrorM: 40, watercourses: [canal()], triangleBudget: undefined,
        }));
        const tile = decodePtm(r.bytes);
        const q = tile.quantScale;
        const at = (v: number) => ({
            x: tile.landPositions[v * 3] * q,
            y: tile.landPositions[v * 3 + 1] * q,
            z: tile.landPositions[v * 3 + 2] * q,
        });
        /** Height of the drawn land at (x, z), or undefined off the mesh. */
        const landY = (x: number, z: number): number | undefined => {
            for (let t = 0; t * 3 + 2 < tile.landPositions.length / 3; t++) {
                const a = at(t * 3), b = at(t * 3 + 1), c = at(t * 3 + 2);
                const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
                if (Math.abs(det) < 1e-9) continue;
                const l0 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / det;
                const l1 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det;
                const l2 = 1 - l0 - l1;
                if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
                return a.y * l0 + b.y * l1 + c.y * l2;
            }
            return undefined;
        };
        let checked = 0;
        for (let v = 0; v < tile.riverHalfWidths.length; v += 2) {
            const x = tile.riverPositions[v * 3] * q;
            const y = tile.riverPositions[v * 3 + 1] * q;
            const z = tile.riverPositions[v * 3 + 2] * q;
            const ground = landY(x, z);
            if (ground === undefined) continue;
            checked++;
            assert.ok(y >= ground - 0.05,
                `stroke ${y.toFixed(2)} below drawn land ${ground.toFixed(2)}`);
        }
        assert.ok(checked > 4, `only ${checked} points landed on the mesh`);
    });

    it('runs the offset across the flow, not along it', () => {
        const tile = decodePtm(
            buildTile(base({ ...LAND, watercourses: [canal()] })).bytes);
        // The canal runs east; the offset must be north-south (scene z), with
        // no east component to speak of.
        assert.ok(Math.abs(tile.riverDirections[0]) < 16, `east ${tile.riverDirections[0]}`);
        assert.ok(Math.abs(tile.riverDirections[2]) > 100, `south ${tile.riverDirections[2]}`);
    });
});

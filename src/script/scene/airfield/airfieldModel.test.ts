import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Airfield } from '../../terrain/airfields';
import {
    ecefToEnu, ecefToGeodetic, enuFromScene, enuToEcef, geodeticToEcef, makeEnuBasis,
} from '../../terrain/geodesy';
import { SceneMaterialManager } from '../materials/materials';
import {
    AIRFIELD_SURFACE_EPS_M, GROUND_STRIP_LIGHTEN, buildAirfieldModel, buildingHeightM, repaintGroundStrip, smoothCentreline,
} from './airfieldModel';

/**
 * The material manager only ever hands back something to bind a geometry to,
 * and building the real one drags in shader sources and a palette. Everything
 * this file checks is in the vertices.
 */
type BuiltProps = { category: string; overbright?: number; rawColor?: string };

const MATERIALS = {
    build: (p: BuiltProps) => {
        const m = new THREE.MeshBasicMaterial();
        m.userData.category = p.category;
        m.userData.overbright = p.overbright;
        m.userData.rawColor = p.rawColor;
        return m;
    },
} as unknown as SceneMaterialManager;

function materialOf(o: THREE.Object3D): BuiltProps {
    return ((o as THREE.Mesh).material as THREE.Material).userData as BuiltProps;
}

/** Palette categories the built geometry actually uses, per LOD level. */
function categories(objects: THREE.Object3D[]): Set<string> {
    return new Set(objects.map(
        o => ((o as THREE.Mesh).material as THREE.Material).userData.category as string));
}

/** Vertices of the parts drawn in one palette category. */
function verticesOf(objects: THREE.Object3D[], category: string): THREE.Vector3[] {
    return vertices(objects.filter(
        o => ((o as THREE.Mesh).material as THREE.Material).userData.category === category));
}

/** An airfield with somewhere to taxi and park. */
const SURROUNDS = {
    taxiways: [{
        widthM: 23,
        points: [[27.9300, -15.3880], [27.9360, -15.3840]],
    }],
    aprons: [{
        ring: [
            [27.9310, -15.3900], [27.9310, -15.3890],
            [27.9320, -15.3890], [27.9320, -15.3900],
            [27.9310, -15.3900],
        ],
    }],
};

const BASIS = makeEnuBasis(28.0015, -15.3937, 0);

/** Gran Canaria as the bake records it, trimmed to what the builder reads. */
function gclp(overrides: Partial<Airfield> = {}): Airfield {
    return {
        name: 'Gran Canaria',
        icao: 'GCLP',
        iata: 'LPA',
        kind: 'international',
        area: 'home',
        lat: 27.93016,
        lon: -15.38801,
        elevationM: 12.97,
        plane: { heightMsl: 12.97, gradient: -0.00385, headingDeg: 21.4354 },
        runways: [{
            ref: '03L/21R',
            headingDeg: 21.4354,
            lengthM: 3103,
            widthM: 45,
            surface: 'asphalt',
            lit: true,
            lat: 27.931904,
            lon: -15.386584,
            thresholds: [[27.918871, -15.392346], [27.944937, -15.380823]],
        }],
        taxiways: [],
        aprons: [],
        buildings: [],
        pads: [],
        ...overrides,
    };
}

/** ENU east/north of a geodetic point in the airfield's frame. */
function enuAt(lat: number, lon: number): { e: number; n: number } {
    const enu = ecefToEnu(BASIS, geodeticToEcef(lat, lon, 0));
    return { e: enu.e, n: enu.n };
}

/** Unit east/north pointing from `from` to `to`. */
function unit(
    from: { e: number; n: number }, to: { e: number; n: number },
): { e: number; n: number } {
    const de = to.e - from.e;
    const dn = to.n - from.n;
    const len = Math.hypot(de, dn) || 1;
    return { e: de / len, n: dn / len };
}

type EnuTriangle = [{ e: number; n: number }, { e: number; n: number }, { e: number; n: number }];

/**
 * The facets drawn in one palette category, back in east/north.
 *
 * Coverage is what a gap in the pavement is about, and coverage is a question
 * about the ground plane, not about scene Y — which carries the curvature drop
 * as well. See `elevationOf`.
 */
function trianglesOf(
    objects: THREE.Object3D[], category: string, origin: THREE.Vector3,
): EnuTriangle[] {
    const vs = verticesOf(objects, category).map(v => {
        const enu = enuFromScene(v.clone().add(origin));
        return { e: enu.e, n: enu.n };
    });
    const out: EnuTriangle[] = [];
    for (let i = 0; i + 2 < vs.length; i += 3) {
        out.push([vs[i], vs[i + 1], vs[i + 2]]);
    }
    return out;
}

/** True when any facet covers the east/north point. */
function covers(tris: EnuTriangle[], e: number, n: number): boolean {
    for (const [a, b, c] of tris) {
        const d = (b.n - c.n) * (a.e - c.e) + (c.e - b.e) * (a.n - c.n);
        if (Math.abs(d) < 1e-9) {
            continue;
        }
        const l0 = ((b.n - c.n) * (e - c.e) + (c.e - b.e) * (n - c.n)) / d;
        const l1 = ((c.n - a.n) * (e - c.e) + (a.e - c.e) * (n - c.n)) / d;
        if (l0 >= -1e-6 && l1 >= -1e-6 && 1 - l0 - l1 >= -1e-6) {
            return true;
        }
    }
    return false;
}

/** Shortest distance from a point to a polyline, in east/north. */
function distanceToPath(
    q: { e: number; n: number }, path: readonly { e: number; n: number }[],
): number {
    let best = Infinity;
    for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i];
        const b = path[i + 1];
        const de = b.e - a.e;
        const dn = b.n - a.n;
        const len2 = de * de + dn * dn;
        const t = len2 > 0
            ? Math.max(0, Math.min(1, ((q.e - a.e) * de + (q.n - a.n) * dn) / len2))
            : 0;
        best = Math.min(best, Math.hypot(q.e - (a.e + de * t), q.n - (a.n + dn * t)));
    }
    return best;
}

/** The sharpest turn any node of a polyline makes, in radians. */
function sharpestTurn(path: readonly { e: number; n: number }[]): number {
    let worst = 0;
    for (let i = 1; i + 1 < path.length; i++) {
        const ae = path[i].e - path[i - 1].e;
        const an = path[i].n - path[i - 1].n;
        const be = path[i + 1].e - path[i].e;
        const bn = path[i + 1].n - path[i].n;
        worst = Math.max(worst, Math.abs(Math.atan2(ae * bn - an * be, ae * be + an * bn)));
    }
    return worst;
}

function triangles(objects: THREE.Object3D[]): number {
    let n = 0;
    for (const obj of objects) {
        const geometry = (obj as THREE.Mesh).geometry;
        n += geometry.getAttribute('position').count / 3;
    }
    return n;
}

/** Every vertex of a level, in the model's own frame. */
function vertices(objects: THREE.Object3D[]): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const obj of objects) {
        const pos = (obj as THREE.Mesh).geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
            out.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
        }
    }
    return out;
}

/**
 * A vertex back as an elevation above the ellipsoid.
 *
 * Scene Y is not the elevation: the ground curves away from the tangent plane,
 * so an airfield 8 km from the play origin has its two thresholds 4 m further
 * apart in Y than in height. Everything the builder is responsible for lives in
 * elevation, so that is where the assertions belong.
 */
function elevationOf(v: THREE.Vector3, origin: THREE.Vector3): number {
    const scene = v.clone().add(origin);
    const ecef = enuToEcef(BASIS, enuFromScene(scene));
    return ecefToGeodetic(ecef.x, ecef.y, ecef.z).height;
}

describe('airfield model', () => {

    it('builds three levels of detail, coarsening', () => {
        const built = buildAirfieldModel(gclp(), BASIS, MATERIALS);
        assert.ok(built);
        assert.equal(built.model.lod.length, 3);
        const counts = built.model.lod.map(l => triangles(l.flats));
        assert.ok(counts[0] > counts[1], `level 0 ${counts[0]} vs level 1 ${counts[1]}`);
        assert.ok(counts[1] > counts[2], `level 1 ${counts[1]} vs level 2 ${counts[2]}`);
        // The coarsest level is the pavement and nothing else: two triangles.
        assert.equal(counts[2], 2);
    });

    it('is the size of the runway it was given', () => {
        const built = buildAirfieldModel(gclp(), BASIS, MATERIALS)!;
        assert.equal(built.model.maxSize, 3103);
        const flat = vertices(built.model.lod[2].flats);
        // The pavement quad's diagonal is the runway's own diagonal.
        let longest = 0;
        for (const a of flat) {
            for (const b of flat) {
                longest = Math.max(longest, a.distanceTo(b));
            }
        }
        const diagonal = Math.hypot(3103, 45);
        assert.ok(Math.abs(longest - diagonal) < 2,
            `pavement measures ${longest.toFixed(1)} m across, wanted ${diagonal.toFixed(1)}`);
    });

    it('follows the airfield plane down the runway', () => {
        const built = buildAirfieldModel(gclp(), BASIS, MATERIALS)!;
        const heights = vertices(built.model.lod[2].flats)
            .map(v => elevationOf(v, built.origin));
        // -0.385% over 3103 m is 11.95 m of fall between the thresholds.
        const spread = Math.max(...heights) - Math.min(...heights);
        assert.ok(Math.abs(spread - 0.00385 * 3103) < 0.2,
            `pavement falls ${spread.toFixed(2)} m, wanted 11.95`);
    });

    it('lifts the pavement clear of the terrain cut under it', () => {
        // Both are built on the same plane, so without the lift they are
        // coplanar and the quantised terrain wins the depth test in patches.
        const level = buildAirfieldModel(
            gclp({ plane: { heightMsl: 100, gradient: 0, headingDeg: 21.4354 } }),
            BASIS, MATERIALS)!;
        for (const v of vertices(level.model.lod[2].flats)) {
            const h = elevationOf(v, level.origin);
            assert.ok(Math.abs(h - (100 + AIRFIELD_SURFACE_EPS_M)) < 0.05,
                `vertex at ${h.toFixed(2)} m, wanted the plane plus the epsilon`);
        }
    });

    it('paints a paved runway and leaves a grass one bare', () => {
        const paved = buildAirfieldModel(gclp(), BASIS, MATERIALS)!;
        const grass = buildAirfieldModel(gclp({
            runways: [{ ...gclp().runways[0], surface: 'grass' }],
        }), BASIS, MATERIALS)!;
        assert.ok(triangles(paved.model.lod[0].flats) > 100, 'the paint is missing');
        assert.equal(triangles(grass.model.lod[0].flats), 2, 'a grass strip got painted');
    });

    it('draws taxiways and aprons at the two finest levels only', () => {
        const withSurrounds = buildAirfieldModel(gclp({
            taxiways: [{
                widthM: 23,
                points: [[27.9300, -15.3880], [27.9330, -15.3860], [27.9360, -15.3840]],
            }],
            aprons: [{
                ring: [
                    [27.9310, -15.3900], [27.9310, -15.3890],
                    [27.9320, -15.3890], [27.9320, -15.3900],
                    [27.9310, -15.3900],
                ],
            }],
        }), BASIS, MATERIALS)!;
        const bare = buildAirfieldModel(gclp(), BASIS, MATERIALS)!;
        const counts = withSurrounds.model.lod.map(l => triangles(l.flats));
        const bareCounts = bare.model.lod.map(l => triangles(l.flats));
        assert.ok(counts[0] > bareCounts[0], 'no taxiway or apron at level 0');
        assert.ok(counts[1] > bareCounts[1], 'no taxiway or apron at level 1');
        assert.equal(counts[2], bareCounts[2], 'the coarsest level grew a taxiway');
    });

    describe('following the ground', () => {

        it('drapes taxiways and aprons on the terrain, not on the plane', () => {
            // Only the runway strips are cut flat by the bake. Left on the
            // plane, GCLP's taxiway network floats up to 10 m and buries
            // itself by 19 — measured on the real manifest.
            const af = gclp(SURROUNDS);
            const GROUND = 200;
            const draped = buildAirfieldModel(
                af, BASIS, MATERIALS, () => GROUND)!;
            const onPlane = buildAirfieldModel(af, BASIS, MATERIALS)!;

            // The pavement quad is the runway, and it stays on the plane.
            const runwayY = (m: typeof draped) => {
                const vs = vertices(m.model.lod[2].flats);
                return elevationOf(vs[0], m.origin);
            };
            assert.ok(Math.abs(runwayY(draped) - runwayY(onPlane)) < 0.01,
                'the runway moved with the ground');

            // The taxiways did move, onto it. Checked through the taxiway
            // centreline, which is the one part of an airfield with a palette
            // category to itself — the pavement shares the runway's.
            const stripe = verticesOf(draped.model.lod[0].flats, 'SCENERY_FIELD_YELLOW');
            assert.ok(stripe.length > 0, 'nothing was draped');
            for (const v of stripe) {
                const h = elevationOf(v, draped.origin);
                assert.ok(Math.abs(h - (GROUND + AIRFIELD_SURFACE_EPS_M)) < 0.2,
                    `draped vertex at ${h.toFixed(2)} m, wanted the ground plus the lift`);
            }
            // ...and on the plane they sit somewhere else entirely.
            const onPlaneStripe = verticesOf(
                onPlane.model.lod[0].flats, 'SCENERY_FIELD_YELLOW');
            const planeH = elevationOf(onPlaneStripe[0], onPlane.origin);
            assert.ok(Math.abs(planeH - GROUND) > 100,
                'the undraped taxiway was already on the ground');
        });

        it('draws a taxiway whole, however finely OSM noded it', () => {
            // The nodes round a curve can be a few metres apart. An 8 m floor
            // on the *segment* dropped exactly those: 119 of 363 at Belbek,
            // punching holes through the middle of continuous taxiways.
            const coarse = gclp({
                taxiways: [{ widthM: 23, points: [[27.9300, -15.3880], [27.9320, -15.3860]] }],
            });
            // The same run, walked in 5 m steps instead of one 280 m leg.
            const steps: number[][] = [];
            for (let i = 0; i <= 56; i++) {
                steps.push([27.9300 + (0.0020 * i) / 56, -15.3880 + (0.0020 * i) / 56]);
            }
            const fine = gclp({ taxiways: [{ widthM: 23, points: steps }] });

            const area = (a: Airfield) => {
                const built = buildAirfieldModel(a, BASIS, MATERIALS, () => 0)!;
                let sum = 0;
                for (const o of built.model.lod[0].flats) {
                    const p = (o as THREE.Mesh).geometry.getAttribute('position');
                    for (let t = 0; t < p.count; t += 3) {
                        const x = new THREE.Vector3(p.getX(t), p.getY(t), p.getZ(t));
                        const y = new THREE.Vector3(p.getX(t + 1), p.getY(t + 1), p.getZ(t + 1));
                        const z = new THREE.Vector3(p.getX(t + 2), p.getY(t + 2), p.getZ(t + 2));
                        sum += y.sub(x).cross(z.sub(x)).length() / 2;
                    }
                }
                return sum;
            };
            const bare = area(gclp());
            const coarsePaved = area(coarse) - bare;
            const finePaved = area(fine) - bare;
            assert.ok(coarsePaved > 1000, 'the coarse taxiway drew nothing');
            assert.ok(Math.abs(finePaved - coarsePaved) / coarsePaved < 0.05,
                `finely noded taxiway paved ${finePaved.toFixed(0)} m2 `
                + `against ${coarsePaved.toFixed(0)} for the same run`);
        });

        it('leaves no notch on the outside of a curve', () => {
            // Each leg is laid as its own rectangle around its own
            // perpendicular. The two overlap on the inside of a bend and pull
            // apart on the outside, so without a fillet every node bites a
            // triangle of bare ground out of the outer edge — and OSM nodes a
            // curve every few metres, so a curved taxiway comes out scalloped.
            const W = 40;
            // Well west of the runway, which is drawn in the same category.
            const before: [number, number] = [27.9300, -15.3960];
            const corner: [number, number] = [27.9330, -15.3960];
            const after: [number, number] = [27.9330, -15.3900];
            const built = buildAirfieldModel(
                gclp({ taxiways: [{ widthM: W, points: [before, corner, after] }] }),
                BASIS, MATERIALS, () => 0)!;
            const paved = trianglesOf(
                built.model.lod[0].flats, 'SCENERY_ROAD_SECONDARY', built.origin);

            // Outward bisector of the turn: the direction the notch opens in.
            const c = enuAt(...corner);
            const d0 = unit(enuAt(...before), c);
            const d1 = unit(c, enuAt(...after));
            // A left turn opens the gap on the right of the run, and the
            // right-hand normal is the left one negated.
            const side = d0.e * d1.n - d0.n * d1.e > 0 ? -1 : 1;
            const bx = side * (-d0.n - d1.n);
            const by = side * (d0.e + d1.e);
            const blen = Math.hypot(bx, by);
            const half = W / 2;

            for (const r of [0.3, 0.6, 0.9]) {
                const e = c.e + (bx / blen) * half * r;
                const n = c.n + (by / blen) * half * r;
                assert.ok(covers(paved, e, n),
                    `bare ground ${(half * r).toFixed(1)} m out on the outside of the turn`);
            }
            // And the fillet is a fillet, not a blanket: past the taxiway's own
            // half width there is still nothing paved.
            const e = c.e + (bx / blen) * half * 1.6;
            const n = c.n + (by / blen) * half * 1.6;
            assert.ok(!covers(paved, e, n), 'the joint paved well past the taxiway edge');
        });

        it('follows a coarsely noded bend as a curve, not as a corner', () => {
            // Two 60 m legs meeting at 30 degrees: a bend OSM recorded with
            // one node, which without smoothing is one kink in the middle of
            // the pavement and one kink in the stripe painted down it.
            const bend = [{ e: -60, n: 0 }, { e: 0, n: 0 }, { e: 52, n: 30 }];
            const smoothed = smoothCentreline(bend, 23);

            assert.ok(smoothed.length > bend.length,
                'the bend came back with the nodes it went in with');
            // It is a curve through the same corridor, not a new route: every
            // point stays inside the pavement the chords would have laid.
            for (const q of smoothed) {
                assert.ok(distanceToPath(q, bend) <= 11.5,
                    `smoothed ${q.e.toFixed(1)},${q.n.toFixed(1)} left the pavement`);
            }
            // And it is smoother where it counts: no node turns as sharply as
            // the one it replaced.
            assert.ok(sharpestTurn(smoothed) < sharpestTurn(bend) - 0.1,
                'the smoothed bend still turns as hard as the corner did');
        });

        it('never kinks harder than the polyline it replaced', () => {
            // A short link off a long straight, which is most of how a taxiway
            // network joins up. The tangent at the shared node is taken across
            // both legs, so unclamped it comes out many times the length of
            // the short one and the cubic loops: Las Palmas went from a worst
            // turn of 36 degrees to one of 148.
            const lopsided = [{ e: -400, n: 0 }, { e: 0, n: 0 }, { e: 9, n: 5 }];
            assert.ok(sharpestTurn(smoothCentreline(lopsided, 23))
                <= sharpestTurn(lopsided) + 1e-6,
                'smoothing put a sharper bend in than the one it was given');
        });

        it('leaves a straight run alone, wobbles and all', () => {
            // A straight taxiway is noded every hundred metres and every node
            // is out by a fraction of a degree. Splining through those bows
            // the run, which alongside a runway is worse than a facet.
            const run = [
                { e: 0, n: 0 }, { e: 100, n: 0.5 }, { e: 200, n: -0.4 },
                { e: 300, n: 0.3 }, { e: 400, n: 0 },
            ];
            assert.deepEqual(smoothCentreline(run, 23), run);
        });

        it('rounds a hard corner without moving the legs it joins', () => {
            // A 90 degree turn between two 300 m legs. The corner itself eases
            // — that is the point — but the legs are surveyed pavement and a
            // curve that bent them would put the taxiway on ground nobody
            // paved, so everything a fillet's reach away from the bend has to
            // come back exactly as it went in.
            const corner = [{ e: -300, n: 0 }, { e: 0, n: 0 }, { e: 0, n: 300 }];
            const smoothed = smoothCentreline(corner, 23);

            assert.ok(sharpestTurn(smoothed) < sharpestTurn(corner),
                'the corner came back as sharp as it went in');
            for (const q of smoothed) {
                assert.ok(distanceToPath(q, corner) <= 11.5,
                    `smoothed ${q.e.toFixed(1)},${q.n.toFixed(1)} left the pavement`);
                // A fillet a width across reaches 23 m either side; past 30 m
                // the leg is untouched.
                if (Math.hypot(q.e, q.n) > 30) {
                    assert.ok(distanceToPath(q, corner) < 1e-9,
                        `the leg moved ${distanceToPath(q, corner).toFixed(2)} m `
                        + `at ${q.e.toFixed(0)},${q.n.toFixed(0)}`);
                }
            }
        });

        it('spends nothing on a curve OSM already noded finely', () => {
            // 5 m chords through a 60 m radius turn are within 3 cm of the arc
            // already. There is no curve left to add and no reason to pay for
            // the vertices.
            const arc = [];
            for (let i = 0; i <= 18; i++) {
                const a = (i * 5 * Math.PI) / 180;
                arc.push({ e: 60 * Math.sin(a), n: 60 - 60 * Math.cos(a) });
            }
            assert.equal(smoothCentreline(arc, 23).length, arc.length);
        });

        it('drops a node OSM recorded twice', () => {
            // A doubled node has no direction, and its zero-length chord
            // divides through the whole parameterisation.
            const doubled = [
                { e: 0, n: 0 }, { e: 100, n: 0 }, { e: 100, n: 0 }, { e: 200, n: 0 },
            ];
            const smoothed = smoothCentreline(doubled, 23);
            assert.equal(smoothed.length, 3);
            for (const q of smoothed) {
                assert.ok(Number.isFinite(q.e) && Number.isFinite(q.n), 'not a number');
            }
        });

        it('cuts a long taxiway into steps so it can follow a rise', () => {
            // One quad per OSM segment is flat across its whole length, so a
            // leg crossing a hill cuts through it.
            const long = gclp({
                taxiways: [{ widthM: 23, points: [[27.930, -15.388], [27.940, -15.388]] }],
            });
            const built = buildAirfieldModel(long, BASIS, MATERIALS, () => 0)!;
            const bare = buildAirfieldModel(gclp(), BASIS, MATERIALS, () => 0)!;
            const added = triangles(built.model.lod[0].flats)
                - triangles(bare.model.lod[0].flats);
            // ~1.1 km of taxiway in 20 m steps, two triangles each.
            assert.ok(added > 80, `only ${added} triangles for a kilometre of taxiway`);
        });
    });

    describe('surface', () => {

        it('paints a concrete field paler than an asphalt one', () => {
            // Soviet-era fields are laid in slabs and read markedly paler from
            // the air; that difference is most of what tells them apart.
            const asphalt = buildAirfieldModel(gclp(SURROUNDS), BASIS, MATERIALS)!;
            const concrete = buildAirfieldModel(gclp({
                ...SURROUNDS,
                runways: [{ ...gclp().runways[0], surface: 'concrete' }],
            }), BASIS, MATERIALS)!;
            const a = categories(asphalt.model.lod[0].flats);
            const c = categories(concrete.model.lod[0].flats);
            assert.ok(a.has('SCENERY_ROAD_SECONDARY'), 'asphalt is not road-coloured');
            assert.ok(c.has('SCENERY_BASE_CONCRETE'), 'concrete has no tone of its own');
            assert.ok(!c.has('SCENERY_ROAD_SECONDARY'),
                'the taxiways stayed asphalt on a concrete field');
        });

        it('lays an unpaved strip in the observed colour of the ground under it, lifted', () => {
            // Neither a field nor a road: the strip is the terrain it is cut
            // into, a shade lighter, whatever that terrain turns out to be -
            // its own observed colour, never a predefined palette swatch.
            const bare = { cls: 6 /* TerrainClass.Bare */, rgb: 0x807050, zoom: 12 };
            const built = buildAirfieldModel(gclp({
                runways: [{ ...gclp().runways[0], surface: 'grass' }],
            }), BASIS, MATERIALS, undefined, () => bare)!;
            const flats = built.model.lod[0].flats;
            assert.ok(categories(flats).has('TERRAIN_BARE'), 'strip is not the ground tone');
            const strip = materialOf(flats.find(o => materialOf(o).category === 'TERRAIN_BARE')!);
            assert.equal(strip.overbright, GROUND_STRIP_LIGHTEN,
                'the strip is not lifted above the ground');
            assert.equal(strip.rawColor, '#807050', 'the strip is a palette tone, not the observed colour');
            assert.equal(built.groundStrips.length, 1, 'the strip is not handed back');
            assert.equal(built.groundStrips[0].paintedZoom, 12,
                'the strip does not remember which tile painted it');
        });

        it('paints a strip on unmapped ground in that ground\'s own baked colour', () => {
            // The terrain shader paints TerrainClass.Ground as its blended
            // regional colour, not a tone, so the strip has to as well or it
            // is one flat green on a brown field.
            const ground = { cls: 13 /* TerrainClass.Ground */, rgb: 0x8a7a40, zoom: 12 };
            const built = buildAirfieldModel(gclp({
                runways: [{ ...gclp().runways[0], surface: 'gravel' }],
            }), BASIS, MATERIALS, undefined, () => ground)!;
            const strip = built.model.lod[0].flats.map(materialOf)
                .find(m => m.rawColor !== undefined);
            assert.ok(strip !== undefined, 'no part took the baked colour');
            assert.equal(strip.rawColor, '#8a7a40');
            assert.equal(strip.overbright, GROUND_STRIP_LIGHTEN);
        });

        it('paints a strip whose ground is not drawn yet once it is', () => {
            // At boot no tile is on screen: the strip goes out in a stand-in
            // tone and is repainted when the ground under it arrives.
            const built = buildAirfieldModel(gclp({
                runways: [{ ...gclp().runways[0], surface: 'gravel' }],
            }), BASIS, MATERIALS, undefined, () => undefined)!;
            assert.ok(categories(built.model.lod[0].flats).has('TERRAIN_BARE'),
                'gravel stand-in is not bare ground');
            assert.equal(built.groundStrips.length, 1);
            const strip = built.groundStrips[0];
            assert.equal(strip.paintedZoom, -1, 'a stand-in claims a tile painted it');
            assert.equal(strip.meshes.length, built.model.lod.length,
                'one pavement mesh per LOD level');
            repaintGroundStrip(strip, { cls: 3 /* TerrainClass.Grass */, rgb: 0, zoom: 9 }, MATERIALS);
            for (const mesh of strip.meshes) {
                assert.equal(materialOf(mesh).category, 'TERRAIN_GRASS');
                assert.equal(materialOf(mesh).overbright, GROUND_STRIP_LIGHTEN);
            }
            assert.equal(strip.paintedZoom, 9);
        });

        it('keeps the markings the same on either', () => {
            const concrete = buildAirfieldModel(gclp({
                runways: [{ ...gclp().runways[0], surface: 'concrete' }],
            }), BASIS, MATERIALS)!;
            const c = categories(concrete.model.lod[0].flats);
            assert.ok(c.has('SCENERY_BASE_RUNWAY_THRESHOLD'));
            assert.ok(c.has('SCENERY_BASE_RUNWAY_LINES'));
        });
    });

    describe('aprons', () => {

        /** The ring of a 200 x 300 m apron, listed either way round. */
        function apronRing(clockwise: boolean) {
            const ring = [
                [27.9310, -15.3900], [27.9310, -15.3880],
                [27.9330, -15.3880], [27.9330, -15.3900],
                [27.9310, -15.3900],
            ];
            return { ring: clockwise ? [...ring].reverse() : ring };
        }

        /** Face normals of every triangle in a level, in scene axes. */
        function normalsY(objects: THREE.Object3D[]): number[] {
            const out: number[] = [];
            for (const o of objects) {
                const p = (o as THREE.Mesh).geometry.getAttribute('position');
                for (let t = 0; t < p.count; t += 3) {
                    const a = new THREE.Vector3(p.getX(t), p.getY(t), p.getZ(t));
                    const b = new THREE.Vector3(p.getX(t + 1), p.getY(t + 1), p.getZ(t + 1));
                    const c = new THREE.Vector3(p.getX(t + 2), p.getY(t + 2), p.getZ(t + 2));
                    out.push(b.sub(a).cross(c.sub(a)).y);
                }
            }
            return out;
        }

        it('faces up whichever way round OSM listed the ring', () => {
            // OSM promises neither winding on a closed way and uses both: 118
            // apron rings one way and 170 the other across the baked
            // airfields. The mesh material culls back faces, so a ring
            // triangulated blind is simply not there — Saki drew seven of its
            // fourteen.
            for (const clockwise of [false, true]) {
                const built = buildAirfieldModel(
                    gclp({ aprons: [apronRing(clockwise)] }), BASIS, MATERIALS)!;
                const ys = normalsY(built.model.lod[0].flats);
                assert.ok(ys.length > 2, 'the apron produced no triangles');
                for (const y of ys) {
                    assert.ok(y > 0,
                        `a face points down with the ring ${clockwise ? 'clockwise' : 'ccw'}`);
                }
            }
        });

        it('draws the same apron either way round', () => {
            const ccw = buildAirfieldModel(
                gclp({ aprons: [apronRing(false)] }), BASIS, MATERIALS)!;
            const cw = buildAirfieldModel(
                gclp({ aprons: [apronRing(true)] }), BASIS, MATERIALS)!;
            assert.equal(triangles(cw.model.lod[0].flats),
                triangles(ccw.model.lod[0].flats));
        });
    });

    describe('buildings', () => {

        function building(over: Partial<Airfield['buildings'][0]> = {}) {
            return {
                kind: 'hangar' as const, lat: 27.9320, lon: -15.3870,
                headingDeg: 21.4354, widthM: 40, depthM: 60, ...over,
            };
        }

        /** Triangles of the volumes, as [centroid, normal] pairs. */
        function faces(objects: THREE.Object3D[]) {
            const out: Array<{ c: THREE.Vector3; n: THREE.Vector3 }> = [];
            for (const o of objects) {
                const p = (o as THREE.Mesh).geometry.getAttribute('position');
                for (let t = 0; t < p.count; t += 3) {
                    const a = new THREE.Vector3(p.getX(t), p.getY(t), p.getZ(t));
                    const b = new THREE.Vector3(p.getX(t + 1), p.getY(t + 1), p.getZ(t + 1));
                    const c = new THREE.Vector3(p.getX(t + 2), p.getY(t + 2), p.getZ(t + 2));
                    out.push({
                        c: a.clone().add(b).add(c).divideScalar(3),
                        n: b.clone().sub(a).cross(c.clone().sub(a)).normalize(),
                    });
                }
            }
            return out;
        }

        it('are volumes, not flats — they are lit and they occlude', () => {
            const built = buildAirfieldModel(
                gclp({ buildings: [building()] }), BASIS, MATERIALS, () => 0)!;
            assert.equal(built.model.lod[0].volumes.length > 0, true, 'no volumes built');
            // Ten triangles: four walls and a roof. No floor — nothing sees it.
            assert.equal(triangles(built.model.lod[0].volumes), 10);
        });

        it('faces its walls outward and its roof up', () => {
            // Wound the wrong way, a building is culled from outside and drawn
            // inside out from within — the shape is there and invisible.
            const built = buildAirfieldModel(
                gclp({ buildings: [building()] }), BASIS, MATERIALS, () => 0)!;
            const box = faces(built.model.lod[0].volumes);
            const centre = box.reduce(
                (a, f) => a.add(f.c), new THREE.Vector3()).divideScalar(box.length);
            let roofs = 0;
            for (const f of box) {
                if (f.n.y > 0.9) { roofs++; continue; }
                // Against the direction from the box's axis to the triangle.
                // Not near 1: a wall is two triangles whose centroids sit a
                // third of the way along it, so on a 60 m wall 20 m from the
                // centre the radial direction is 26 degrees off the normal.
                // The sign is the thing — inward came out at -0.98.
                const outward = f.c.clone().sub(centre).setY(0).normalize();
                assert.ok(f.n.dot(outward) > 0.5,
                    `a wall faces inward (dot ${f.n.dot(outward).toFixed(2)})`);
            }
            assert.equal(roofs, 2, 'the roof is not two up-facing triangles');
        });

        it('stands on the lowest corner, not on its centre', () => {
            // On a slope, basing it on the centre leaves one corner in the air.
            const slope = (e: number) => e * 0.1;
            const built = buildAirfieldModel(
                gclp({ buildings: [building()] }), BASIS, MATERIALS, (e) => slope(e))!;
            const ys = faces(built.model.lod[0].volumes).map(f => f.c.y);
            const base = Math.min(...ys);
            // Every wall foot is at one height, and it is the lowest ground.
            const foot = faces(built.model.lod[0].volumes)
                .filter(f => Math.abs(f.n.y) < 0.1);
            assert.ok(foot.length === 8, 'expected eight wall triangles');
            assert.ok(Number.isFinite(base));
        });

        it('infers a height from the kind and the footprint', () => {
            // Not one of Gran Canaria's sixty airport buildings carries a
            // height tag, so the inference is what gets drawn.
            const small = buildingHeightM(building({ widthM: 20, depthM: 30 }));
            const big = buildingHeightM(building({ widthM: 90, depthM: 130 }));
            assert.ok(big > small, 'a bigger hangar is not taller');
            assert.ok(small >= 6 && big <= 30, `hangar heights ${small}..${big}`);

            // A tower is the one building taller than it is wide.
            const tower = buildingHeightM(building({ kind: 'tower', widthM: 14, depthM: 16 }));
            assert.ok(tower > 16, `a tower ${tower} m tall is shorter than its footprint`);

            const terminal = buildingHeightM(
                building({ kind: 'terminal', widthM: 76, depthM: 96 }));
            assert.ok(terminal >= 8 && terminal <= 25, `terminal ${terminal} m`);
        });

        it('takes OSM at its word when it states a height', () => {
            assert.equal(buildingHeightM(building({ heightM: 42 })), 42);
            // ...but not a nonsense one.
            assert.ok(buildingHeightM(building({ heightM: 0 })) > 0);
        });

        it('are left off the coarsest level, like the taxiways', () => {
            const built = buildAirfieldModel(
                gclp({ buildings: [building()] }), BASIS, MATERIALS, () => 0)!;
            assert.ok(triangles(built.model.lod[1].volumes) > 0);
            assert.equal(triangles(built.model.lod[2].volumes), 0);
        });
    });

    it('survives an airfield with no runway at all', () => {
        assert.equal(buildAirfieldModel(gclp({ runways: [] }), BASIS, MATERIALS), undefined);
    });

    it('lays the runway along its own bearing', () => {
        // Scene axes are x east, z south, so a runway on 090 runs along x and
        // one on 000 runs along z. Getting this backwards draws every runway
        // across its own strip.
        const east = buildAirfieldModel(gclp({
            plane: { heightMsl: 10, gradient: 0, headingDeg: 90 },
            runways: [{ ...gclp().runways[0], headingDeg: 90, ref: '09/27' }],
        }), BASIS, MATERIALS)!;
        const flat = vertices(east.model.lod[2].flats);
        const spanX = Math.max(...flat.map(v => v.x)) - Math.min(...flat.map(v => v.x));
        const spanZ = Math.max(...flat.map(v => v.z)) - Math.min(...flat.map(v => v.z));
        assert.ok(Math.abs(spanX - 3103) < 2, `runway spans ${spanX.toFixed(0)} m east-west`);
        assert.ok(Math.abs(spanZ - 45) < 2, `runway spans ${spanZ.toFixed(0)} m north-south`);
    });
});

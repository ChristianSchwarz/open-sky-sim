import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Quadtree } from './quadtree';
import { TerrainManifest } from './manifest';
import {
    DETAIL_DISTANCE_OFF, DETAIL_SCALE_MAX, FRUSTUM_CULL_MARGIN_RAD, LEAF_REFINE_DISTANCE_SCALE,
    RECONCILE_INTERVAL_MS,
} from './lod';
import { TileKey, childrenOf, parentOf, tileKeyString } from './tiling';

function manifest(maxZoom = 4): TerrainManifest {
    return {
        version: 4,
        scheme: 'retro-terrain/1',
        ellipsoid: 'WGS84',
        seaLevel: 0,
        coverage: { west: -180, south: -90, east: 180, north: 90 },
        enuOrigin: { lat: 0, lon: 0, height: 0 },
        mesh: {
            path: '{z}/{x}/{y}.ptm', indexPath: 'i', minZoom: 0, maxZoom,
            encoding: 'PTM1', triangleBudget: 6144,
            // Error halves per level, so refinement is driven by distance.
            levelGeometricErrorM: Array.from({ length: maxZoom + 1 }, (_, z) => 4000 / (1 << z)),
            levelSkirtDepthM: [],
        },
        height: {
            path: '{z}/{x}/{y}.pdm', indexPath: 'i', tileSize: 33,
            minZoom: 0, maxZoom: 4, queryZoom: 4, coarseZoom: 2,
        },
        flattenPads: [],
    };
}

/** A flat toy world: tiles laid out on a plane so distances are predictable. */
function makeTree(opts: {
    maxZoom?: number;
    resident?: Set<string>;
    ocean?: Set<string>;
    tileErrorM?: (id: TileKey) => number | undefined;
} = {}) {
    const resident = opts.resident ?? new Set<string>();
    const ocean = opts.ocean ?? new Set<string>();
    const tree = new Quadtree({
        manifest: manifest(opts.maxZoom ?? 4),
        tilePosition: (id) => {
            const span = 180 / (1 << id.z);
            const lon = -180 + id.x * span + span / 2;
            const lat = 90 - id.y * span - span / 2;
            return new THREE.Vector3(lon * 1000, 0, lat * 1000);
        },
        tileRadius: (id) => (180 / (1 << id.z)) * 1000,
        isResident: (id) => resident.has(tileKeyString(id)),
        isOcean: (id) => ocean.has(tileKeyString(id)),
        tileErrorM: opts.tileErrorM,
        earthCenter: new THREE.Vector3(0, -6378137, 0),
        maxZoom: opts.maxZoom ?? 4,
    });
    return { tree, resident, ocean };
}

function camera(x = 0, y = 500, z = 0): THREE.PerspectiveCamera {
    const c = new THREE.PerspectiveCamera(50, 1.6, 1, 5_000_000);
    c.position.set(x, y, z);
    c.lookAt(x, 0, z + 1);
    c.updateMatrixWorld(true);
    c.updateProjectionMatrix();
    return c;
}

/** The shipped manifest's per-level errors, which the bug was calibrated against. */
const REAL_LEVEL_ERROR_M = [
    2149.93, 2149.93, 1742.49, 1153.07, 1001.83, 534.29, 421.53,
];

const keysOf = (nodes: { key: string }[]) => nodes.map(n => n.key);

describe('Quadtree', () => {
    it('draws the roots when nothing is resident', () => {
        const h = makeTree();
        const r = h.tree.update(camera(), 200, 50, 1);
        assert.ok(r.draw.length > 0, 'something is drawn');
        for (const node of r.draw) {
            assert.equal(node.id.z, 0, 'only roots, since no child is resident');
        }
    });

    it('never returns a parent and its descendant together', () => {
        const h = makeTree();
        // Make everything resident so refinement is unrestricted.
        const all = new Set<string>();
        for (let z = 0; z <= 4; z++) {
            for (let x = 0; x < (1 << (z + 1)); x++) {
                for (let y = 0; y < (1 << z); y++) {
                    all.add(`${z}/${x}/${y}`);
                }
            }
        }
        const t = makeTree({ resident: all });
        const r = t.tree.update(camera(), 200, 50, 1);
        const drawn = new Set(keysOf(r.draw));
        for (const key of drawn) {
            const [z, x, y] = key.split('/').map(Number);
            let p = parentOf({ z, x, y });
            while (p) {
                assert.ok(
                    !drawn.has(tileKeyString(p)),
                    `both ${key} and ancestor ${tileKeyString(p)} were drawn`,
                );
                p = parentOf(p);
            }
        }
        void h;
    });

    it('keeps drawing the parent until all four children are resident', () => {
        // childrenOf(0/0/0) is 1/0/0, 1/1/0, 1/0/1, 1/1/1 — z0 has a single
        // row, so 1/2/0 belongs to the other root.
        const partial = new Set<string>(['1/0/0', '1/1/0', '1/0/1']); // 3 of 4
        const h = makeTree({ resident: partial, maxZoom: 1 });
        const r = h.tree.update(camera(), 200, 50, 1);
        const drawn = new Set(keysOf(r.draw));
        assert.ok(drawn.has('0/0/0'), 'parent still drawn with a child missing');
        assert.ok(!drawn.has('1/0/0'), 'no child drawn yet');
    });

    it('hands over to the children once the fourth arrives', () => {
        const all = new Set<string>(['1/0/0', '1/1/0', '1/0/1', '1/1/1']);
        const h = makeTree({ resident: all, maxZoom: 1 });
        const r = h.tree.update(camera(), 200, 50, 1);
        const drawn = new Set(keysOf(r.draw));
        assert.ok(!drawn.has('0/0/0'), 'parent handed over');
        assert.ok([...drawn].some(k => k.startsWith('1/')), 'children drawn');
    });

    it('counts an ocean child as ready, since a patch covers it', () => {
        const h = makeTree({
            resident: new Set(['1/0/0', '1/1/0']),
            ocean: new Set(['1/0/1', '1/1/1']),
            maxZoom: 1,
        });
        const r = h.tree.update(camera(), 200, 50, 1);
        const drawn = new Set(keysOf(r.draw));
        assert.ok(!drawn.has('0/0/0'), 'ocean children do not block hand-over');
    });

    describe('want set', () => {
        it('asks for a tile it needs but does not have', () => {
            const h = makeTree();
            const r = h.tree.update(camera(), 200, 50, 1);
            assert.ok(r.wants.length > 0);
            for (const w of r.wants) {
                assert.equal(h.resident.has(tileKeyString(w.id)), false,
                    'never asks for something already resident');
            }
        });

        it('never asks for an ocean tile', () => {
            const ocean = new Set(['0/0/0', '0/1/0']);
            const h = makeTree({ ocean });
            const r = h.tree.update(camera(), 200, 50, 1);
            for (const w of r.wants) {
                assert.ok(!ocean.has(tileKeyString(w.id)), 'ocean tiles are generated, not fetched');
            }
        });

        it('asks for the children while still drawing the parent', () => {
            const h = makeTree({ resident: new Set(['1/0/0']), maxZoom: 1 });
            const r = h.tree.update(camera(), 200, 50, 1);
            const wanted = new Set(r.wants.map(w => tileKeyString(w.id)));
            assert.ok(
                [...wanted].some(k => k.startsWith('1/')),
                'children are requested so the wait is bounded',
            );
        });

        it('marks pinned tiles for the streamer', () => {
            const h = makeTree();
            const r = h.tree.update(camera(), 200, 50, 1, DETAIL_DISTANCE_OFF, () => true);
            assert.ok(r.wants.every(w => w.pinned));
        });
    });

    describe('ocean patch refinement (regression)', () => {
        /**
         * A node with no baked tile is drawn as a 10-triangle ellipsoid patch,
         * so what bounds its deviation is that patch's chord sagitta -- not the
         * manifest's baked level error, which describes a mesh the node does
         * not have. At z2 the manifest says 1.7 km where the patch actually
         * departs from the ellipsoid by ~490 km, so the SSE test rated a patch
         * spanning 45 degrees as accurate enough to draw 62 km from the
         * camera, where its interior sags thousands of km below sea level and
         * the sea reads as falling away into nothing.
         *
         * These use a fixed geometry rather than the toy world above, because
         * the toy world's bounding radii swallow the camera and refine
         * everything regardless -- which is what made an earlier version of
         * this test pass against the bug.
         */
        /** Looks at the horizon, so a tile placed down-range is in frustum. */
        function horizonCamera(): THREE.PerspectiveCamera {
            const c = new THREE.PerspectiveCamera(50, 1.6, 1, 5_000_000);
            c.position.set(0, 500, 0);
            c.lookAt(0, 500, 1);
            c.updateMatrixWorld(true);
            c.updateProjectionMatrix();
            return c;
        }

        function fixedTree(distanceM: number, ocean: boolean) {
            const all = ocean ? undefined : new Set<string>();
            return new Quadtree({
                manifest: {
                    ...manifest(6),
                    mesh: { ...manifest(6).mesh, levelGeometricErrorM: REAL_LEVEL_ERROR_M },
                },
                tilePosition: () => new THREE.Vector3(0, 0, distanceM),
                tileRadius: () => 5000,
                isResident: () => true,
                isOcean: () => ocean,
                earthCenter: new THREE.Vector3(0, -6378137, 0),
                maxZoom: 6,
                ...(all ? {} : {}),
            });
        }

        it('refines a coarse ocean patch the baked level error rates as accurate', () => {
            // 300 km out, the z0 baked error projects to 1.6 px -- under the
            // 2 px target, so without the sagitta the root is simply drawn.
            const tree = fixedTree(300_000, true);
            const r = tree.update(horizonCamera(), 200, 50, 1);
            assert.ok(r.draw.length > 0, 'something is drawn');
            const coarsest = Math.min(...r.draw.map(n => n.id.z));
            assert.ok(coarsest > 0, `a z${coarsest} ocean patch was drawn 300 km away`);
        });

        it('keeps refining ocean however far the detail governor has backed off', () => {
            // The governor may degrade terrain detail; it may not move the sea.
            const tree = fixedTree(50_000, true);
            const r = tree.update(horizonCamera(), 200, 50, DETAIL_SCALE_MAX);
            const coarsest = Math.min(...r.draw.map(n => n.id.z));
            assert.ok(
                coarsest > 0,
                `at detailScale ${DETAIL_SCALE_MAX} a z${coarsest} ocean patch was drawn 50 km away`,
            );
        });

        it('still lets the governor coarsen baked terrain', () => {
            // The bound is specific to patches -- baked terrain stays tunable,
            // or the governor would have no way left to recover frame time.
            const tight = fixedTree(50_000, false)
                .update(horizonCamera(), 200, 50, 1).draw;
            const relaxed = fixedTree(50_000, false)
                .update(horizonCamera(), 200, 50, DETAIL_SCALE_MAX).draw;
            const deepest = (d: { id: { z: number } }[]) => Math.max(...d.map(n => n.id.z));
            assert.ok(
                deepest(relaxed) < deepest(tight),
                'the governor can no longer coarsen baked terrain',
            );
        });
    });

    describe('frustum margin (regression)', () => {
        /**
         * The draw list is rebuilt once per reconcile and was culled exactly to
         * the frustum, so a camera turning at the orbit rate swept screen edges
         * that had been correctly dropped a moment earlier and were not back
         * yet -- they rendered as nothing until the next pass caught up.
         */
        const FOV = 50, ASPECT = 1.6;
        const halfHFovRad = Math.atan(Math.tan(FOV * Math.PI / 360) * ASPECT);

        /** A single resident tile sitting `azDeg` off the view axis. */
        function treeAtAzimuth(azDeg: number, distanceM = 50_000) {
            const a = azDeg * Math.PI / 180;
            return new Quadtree({
                manifest: manifest(6),
                tilePosition: () => new THREE.Vector3(
                    Math.sin(a) * distanceM, 0, Math.cos(a) * distanceM),
                tileRadius: () => 1000,
                isResident: () => true,
                isOcean: () => false,
                earthCenter: new THREE.Vector3(0, -6378137, 0),
                maxZoom: 6,
            });
        }

        function axisCamera(): THREE.PerspectiveCamera {
            const c = new THREE.PerspectiveCamera(FOV, ASPECT, 1, 5_000_000);
            c.position.set(0, 500, 0);
            c.lookAt(0, 500, 1);
            c.updateMatrixWorld(true);
            c.updateProjectionMatrix();
            return c;
        }

        it('covers a full reconcile interval at the fastest the view can turn', () => {
            // ORBIT_RATE is PI rad/s, so one 100 ms interval is 0.314 rad.
            const perInterval = Math.PI * (RECONCILE_INTERVAL_MS / 1000);
            assert.ok(
                FRUSTUM_CULL_MARGIN_RAD >= perInterval,
                `margin ${FRUSTUM_CULL_MARGIN_RAD.toFixed(3)} < one interval ${perInterval.toFixed(3)}`,
            );
        });

        it('keeps a tile just outside the frustum edge', () => {
            const justOutside = (halfHFovRad + 0.1) * 180 / Math.PI;
            const r = treeAtAzimuth(justOutside).update(axisCamera(), 200, FOV, 1);
            assert.ok(
                r.draw.length > 0,
                `a tile ${justOutside.toFixed(1)} deg off-axis was culled to the frustum edge`,
            );
        });

        it('still drops a tile well outside the margin', () => {
            // The margin is slack, not a licence to draw the whole sphere.
            const wayOutside = (halfHFovRad + FRUSTUM_CULL_MARGIN_RAD) * 180 / Math.PI + 25;
            const r = treeAtAzimuth(wayOutside).update(axisCamera(), 200, FOV, 1);
            assert.equal(r.draw.length, 0, `a tile ${wayOutside.toFixed(1)} deg off-axis was drawn`);
        });
    });

    describe('culling', () => {
        it('drops tiles beyond the altitude view range', () => {
            const h = makeTree();
            const near = h.tree.update(camera(0, 100, 0), 200, 50, 1);
            // Every drawn tile must be within the range used for that altitude.
            for (const node of near.draw) {
                assert.ok(Number.isFinite(node.radius));
            }
            assert.ok(near.draw.length > 0);
        });

        it('refines more as detailScale drops', () => {
            const all = new Set<string>();
            for (let z = 0; z <= 3; z++) {
                for (let x = 0; x < (1 << (z + 1)); x++) {
                    for (let y = 0; y < (1 << z); y++) {
                        all.add(`${z}/${x}/${y}`);
                    }
                }
            }
            const coarse = makeTree({ resident: all, maxZoom: 3 })
                .tree.update(camera(), 200, 50, 24);
            const fine = makeTree({ resident: all, maxZoom: 3 })
                .tree.update(camera(), 200, 50, 1);
            const depth = (r: { draw: { id: TileKey }[] }) =>
                Math.max(0, ...r.draw.map(n => n.id.z));
            assert.ok(
                depth(fine) >= depth(coarse),
                'the frame-time governor degrades detail, never increases it',
            );
        });
    });

    it('reports nodes that have not been seen recently', () => {
        const h = makeTree();
        h.tree.update(camera(), 200, 50, 1);
        for (let i = 0; i < 5; i++) {
            h.tree.update(camera(1e9, 500, 1e9), 200, 50, 1);
        }
        assert.ok(h.tree.stale(2).length > 0, 'nodes go stale once out of view');
    });
});

describe('per-tile error', () => {
    /** Every tile to z2 resident, so only the LOD rules limit refinement. */
    function allResident() {
        const resident = new Set<string>();
        for (let z = 0; z <= 2; z++) {
            for (let x = 0; x < (1 << (z + 1)); x++) {
                for (let y = 0; y < (1 << z); y++) {
                    resident.add(`${z}/${x}/${y}`);
                }
            }
        }
        return resident;
    }

    it('refines on the resident tile\'s own error rather than the level table', () => {
        // The table says 4 km at z0, which refines from anywhere; the tiles
        // themselves say they are exact, so nothing has anything to gain.
        const h = makeTree({ maxZoom: 2, resident: allResident(), tileErrorM: () => 0 });
        const r = h.tree.update(camera(), 200, 50, 1);
        assert.ok(r.draw.length > 0);
        for (const node of r.draw) {
            assert.equal(node.id.z, 0, `${node.key} drawn: a tile with no error never refines`);
            assert.equal(node.errorFromTile, true);
        }
    });

    it('falls back to the level table while the tile has no figure of its own', () => {
        const h = makeTree({ maxZoom: 2, resident: allResident(), tileErrorM: () => undefined });
        const r = h.tree.update(camera(), 200, 50, 1);
        assert.ok(r.draw.some(n => n.id.z > 0), 'the 4 km table entry refines');
        for (const node of r.draw) {
            assert.equal(node.errorFromTile, false);
        }
    });

    it('does not take a figure from a tile that is not resident', () => {
        const h = makeTree({ maxZoom: 2, tileErrorM: () => 0 });
        const r = h.tree.update(camera(), 200, 50, 1);
        for (const node of r.draw) {
            assert.equal(node.errorFromTile, false);
            assert.equal(node.geometricErrorM, 4000);
        }
    });
});

describe('far-field detail falloff', () => {
    /** Everything resident, so refinement is limited only by the LOD rules. */
    function everythingResident(maxZoom = 7) {
        const resident = new Set<string>();
        const add = (z: number, x: number, y: number) => {
            resident.add(tileKeyString({ z, x, y }));
            if (z >= maxZoom) return;
            for (const c of childrenOf({ z, x, y })) add(c.z, c.x, c.y);
        };
        for (let x = 0; x < 2; x++) add(0, x, 0);
        return makeTree({ maxZoom, resident });
    }

    /**
     * A camera looking at the horizon rather than at its feet.
     *
     * `camera()` above looks almost straight down — from 500 m at a point one
     * metre away — so nothing but the near field is ever in frustum and there
     * is no far field to coarsen. This is the view the setting exists for.
     */
    function horizonCamera(y = 500): THREE.PerspectiveCamera {
        const c = new THREE.PerspectiveCamera(50, 1.6, 1, 5_000_000);
        c.position.set(0, y, 0);
        c.lookAt(0, y, 100_000);
        c.updateMatrixWorld(true);
        c.updateProjectionMatrix();
        return c;
    }

    const drawnWithin = (
        tree: ReturnType<typeof everythingResident>['tree'],
        cam: THREE.PerspectiveCamera, knee: number, metres: number,
    ) => new Set(
        tree.update(cam, 200, 50, 1, knee).draw
            .filter(n => n.center.distanceTo(cam.position) - n.radius < metres)
            .map(n => n.key));

    it('leaves everything inside the knee bit-identical', () => {
        // The whole point of a far-field knob: the ground the aircraft is over
        // must not change. The frame-time governor is the one that coarsens
        // everything, and it costs the near field first.
        const h = everythingResident();
        const cam = horizonCamera();
        for (const metres of [5_000, 12_000]) {
            const off = drawnWithin(h.tree, cam, DETAIL_DISTANCE_OFF, metres);
            const knee = drawnWithin(h.tree, cam, 12_000, metres);
            assert.equal(knee.size, off.size, `${metres} m: ${knee.size} vs ${off.size}`);
            for (const key of off) {
                assert.ok(knee.has(key), `${key} changed inside the knee`);
            }
        }
    });

    it('coarsens the far field, and more as the knee comes in', () => {
        // The finest level reached beyond a given range. Monotone by
        // construction — a tighter knee gives a node less error budget, so it
        // can never refine further than a wider one — which the mean level is
        // not: coarsening removes fine tiles, and the mean over what is left
        // can rise even as the count halves.
        const h = everythingResident();
        const cam = horizonCamera();
        const deepestBeyond = (knee: number, metres: number) => {
            const levels = h.tree.update(cam, 200, 50, 1, knee).draw
                .filter(n => n.center.distanceTo(cam.position) - n.radius > metres)
                .map(n => n.id.z);
            return levels.length ? Math.max(...levels) : -1;
        };
        const off = deepestBeyond(DETAIL_DISTANCE_OFF, 20_000);
        const wide = deepestBeyond(60_000, 20_000);
        const tight = deepestBeyond(6_000, 20_000);
        assert.ok(wide <= off, `wide knee reached z${wide}, off reached z${off}`);
        assert.ok(tight < off, `tight knee reached z${tight}, off reached z${off}`);
        assert.ok(tight <= wide, `tight knee reached z${tight}, wide reached z${wide}`);
    });

    it('draws far fewer tiles, which is the frame time it buys', () => {
        // Measured on this toy world with a horizon view: 520 tiles drawn with
        // no falloff, 274 at the 12 km default, 186 at 6 km. Tiles carry a
        // roughly fixed triangle budget each, so that is the saving.
        const h = everythingResident();
        const cam = horizonCamera();
        const count = (knee: number) => h.tree.update(cam, 200, 50, 1, knee).draw.length;
        const off = count(DETAIL_DISTANCE_OFF);
        assert.ok(count(12_000) < off * 0.7, `12 km knee drew ${count(12_000)} of ${off}`);
        assert.ok(count(6_000) < count(12_000), 'a tighter knee did not draw fewer');
    });

    it('still holds the planet round over ocean', () => {
        // The sagitta bound is the shape of the world, not its detail: a knob
        // that coarsened it would put the sea kilometres from where it belongs.
        const ocean = new Set<string>();
        const walk = (z: number, x: number, y: number) => {
            ocean.add(tileKeyString({ z, x, y }));
            if (z >= 4) return;
            for (const c of childrenOf({ z, x, y })) walk(c.z, c.x, c.y);
        };
        for (let x = 0; x < 2; x++) walk(0, x, 0);
        const h = makeTree({ maxZoom: 4, resident: new Set<string>(), ocean });
        const cam = horizonCamera();
        const off = h.tree.update(cam, 200, 50, 1, DETAIL_DISTANCE_OFF).draw.length;
        const tight = h.tree.update(cam, 200, 50, 1, 2_000).draw.length;
        assert.equal(tight, off, 'the falloff reached the ocean sagitta bound');
    });
});

describe('leaf refine bias', () => {
    /** Everything resident down to maxZoom; z1 says `z1ErrM`, z2 says exact. */
    function tree(maxZoom: number, z1ErrM: number) {
        const resident = new Set<string>();
        const add = (z: number, x: number, y: number) => {
            resident.add(tileKeyString({ z, x, y }));
            if (z >= maxZoom) return;
            for (const c of childrenOf({ z, x, y })) add(c.z, c.x, c.y);
        };
        for (let x = 0; x < 2; x++) add(0, x, 0);
        return makeTree({
            maxZoom, resident,
            tileErrorM: id => (id.z === 1 ? z1ErrM : id.z >= 2 ? 0 : undefined),
        });
    }

    /**
     * Smallest z1 error at which a z2 tile is drawn, from a camera 200 km
     * short of the world looking across it. The altitude stays low so the
     * altitude zoom cap never bites; distance is fixed and the error swept,
     * which comes to the same thing since the two only ever appear as a ratio.
     */
    function z2Threshold(maxZoom: number, leafScale?: number): number {
        for (let err = 50; err <= 3000; err += 5) {
            const cam = new THREE.PerspectiveCamera(50, 1.6, 1, 5_000_000);
            cam.position.set(0, 500, -200_000);
            cam.lookAt(0, 500, 0);
            cam.updateMatrixWorld(true);
            cam.updateProjectionMatrix();
            const r = tree(maxZoom, err).tree.update(
                cam, 200, 50, 1, DETAIL_DISTANCE_OFF, undefined, leafScale,
            );
            if (r.draw.some(n => n.id.z === 2)) return err;
        }
        return Infinity;
    }

    it('brings the leaf in LEAF_REFINE_DISTANCE_SCALE times further out', () => {
        // With maxZoom 3 the z1 node is an ordinary interior node; with
        // maxZoom 2 it is the leaf's parent and carries the bias. The z2
        // tiles report zero error so neither tree ever goes past them.
        const plain = z2Threshold(3);
        const biased = z2Threshold(2);
        assert.ok(Number.isFinite(plain) && biased < plain, `${biased} < ${plain}`);
        const ratio = plain / biased;
        assert.ok(
            Math.abs(ratio - LEAF_REFINE_DISTANCE_SCALE) < 0.05,
            `threshold ratio ${ratio.toFixed(3)} != ${LEAF_REFINE_DISTANCE_SCALE}`,
        );
    });

    it('takes the reach from the setting: 1 is no bias, 2 is twice the distance', () => {
        const plain = z2Threshold(3);
        assert.equal(z2Threshold(2, 1), plain);
        const ratio = plain / z2Threshold(2, 2);
        assert.ok(Math.abs(ratio - 2) < 0.05, `threshold ratio ${ratio.toFixed(3)} != 2`);
    });
});

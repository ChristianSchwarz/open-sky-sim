import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    BridgeGround, BridgeSpan, CLEARANCE_M, FOOTING_M, MAX_SKEW_DEG, PIER_MIN_HEIGHT_M, PIER_SPACING_M,
    WATER_FREEBOARD_M, WATER_PIER_DEPTH_M, bridgeRank, crossingObstacle, endJunctions, planBridge, spanCrossings,
} from './bridges';
import { BED_TIERS } from '../../src/script/terrain/railBed';

const line = (len: number) => [{ x: 0, z: 0 }, { x: len, z: 0 }];

const flat = (h = 100): BridgeGround => ({ groundY: () => h });

/** A V valley `depth` metres deep, its floor at x = len/2, banks at 100 m. */
const valley = (len: number, depth: number): BridgeGround => ({
    groundY: (x) => 100 - depth * (1 - Math.abs(x - len / 2) / (len / 2)),
});

const span = (structure: BridgeSpan['structure'], len: number, layer = 0): BridgeSpan => ({
    structure, deckWidthM: 12, layer, points: line(len),
});

describe('planBridge', () => {
    it('lies flat on flat ground with no piers', () => {
        const plan = planBridge(span('beam', 200), flat())!;
        assert.equal(plan.buried, 0);
        assert.equal(plan.piers.length, 0);
        assert.deepEqual(plan.abutmentLiftM, [0, 0]);
        assert.ok(Math.abs(plan.lengthM - 200) < 1e-6);
    });

    it('starts at the ground height under its first node and ends at the one under its last', () => {
        // Banks 3.6 m apart, as at the Havel bridge: -22.9 m at the start, -19.3 m at the end.
        const ground: BridgeGround = { groundY: (x) => (x < 1 ? -22.9 : x > 699 ? -19.3 : -25) };
        const plan = planBridge(span('beam', 700), ground)!;
        const st = plan.stations;
        assert.ok(Math.abs(st[0].deckY - -22.9) < 1e-9);
        assert.ok(Math.abs(st[st.length - 1].deckY - -19.3) < 1e-9);
        assert.deepEqual(plan.abutmentLiftM, [0, 0]);
    });

    it('ends at measured approach heights where it has them, and an unmeasured end follows a measured one', () => {
        // A 60 m span on flat 30 m ground whose approaches are on 6 m fills.
        const both = planBridge(span('beam', 60), { ...flat(), endY: [106, 105] })!;
        assert.ok(Math.abs(both.stations[0].deckY - 106) < 1e-9);
        assert.ok(Math.abs(both.stations[both.stations.length - 1].deckY - 105) < 1e-9);
        assert.deepEqual(both.abutmentLiftM.map(v => Math.round(v * 10) / 10), [6, 5]);
        // Measured ends far apart are not a bad read ...
        const steep = planBridge(span('beam', 60), { ...flat(), endY: [100, 120] })!;
        assert.ok(Math.abs(steep.stations[steep.stations.length - 1].deckY - 120) < 1e-9);
        // ... but an unmeasured end that disagrees takes the measured one's height.
        const one = planBridge(span('beam', 60), { ...flat(), endY: [120, undefined] })!;
        assert.ok(one.stations.every(st => Math.abs(st.deckY - 120) < 1e-9));
    });

    it('runs between its ends in one straight grade, with no hump over water and no dip', () => {
        const ground: BridgeGround = {
            groundY: (x) => (x < 1 ? -22.9 : x > 699 ? -19.3 : -26),
            waterY: (x) => (x > 200 && x < 500 ? -26 : undefined),
        };
        const plan = planBridge(span('beam', 700), ground)!;
        const st = plan.stations;
        const first = st[0], last = st[st.length - 1];
        for (const p of st) {
            const line = first.deckY + (last.deckY - first.deckY) * (p.s / plan.lengthM);
            assert.ok(Math.abs(p.deckY - line) < 1e-6, `${p.s}: ${p.deckY} vs ${line}`);
        }
    });

    it('does not ride over a mound: the deck stays straight and passes through it', () => {
        const hill: BridgeGround = { groundY: (x) => (x > 150 && x < 250 ? 110 : 100) };
        const plan = planBridge(span('beam', 400), hill)!;
        assert.ok(plan.stations.every(s => Math.abs(s.deckY - 100) < 1e-9));
        assert.ok(plan.buried > 0);
    });

    it('distrusts an end that reads as a cliff and takes the other end height', () => {
        // A tile-edge skirt read as ground: 150 m below the rest of the span.
        const ground: BridgeGround = { groundY: (x) => (x < 1 ? -160 : -11) };
        const plan = planBridge(span('slab', 18), ground)!;
        assert.ok(plan.stations.every(s => Math.abs(s.deckY - -11) < 1e-9));
        // Whichever end is bad: the other way round gives the same deck.
        const flipped: BridgeGround = { groundY: (x) => (x > 17 ? -160 : -11) };
        assert.ok(planBridge(span('slab', 18), flipped)!.stations.every(s => Math.abs(s.deckY - -11) < 1e-9));
    });

    it('keeps two end heights a road could join as they are', () => {
        const ground: BridgeGround = { groundY: (x) => (x < 1 ? -22.9 : x > 699 ? -19.3 : -26) };
        const plan = planBridge(span('beam', 700), ground)!;
        assert.ok(Math.abs(plan.stations[0].deckY - -22.9) < 1e-9);
    });

    it('stands piers about every 50 m, evenly, on the ground under them', () => {
        const plan = planBridge(span('beam', 400), valley(400, 60))!;
        // 400 m in 8 bays of 50 m: seven joints, minus any where the deck is on the bank.
        assert.ok(plan.piers.length >= 5);
        const g = valley(400, 60);
        for (let i = 0; i < plan.piers.length; i++) {
            const p = plan.piers[i];
            assert.ok(Math.abs(p.x % PIER_SPACING_M) < 1e-6 || Math.abs((p.x % PIER_SPACING_M) - PIER_SPACING_M) < 1e-6, `${p.x}`);
            assert.ok(Math.abs(p.baseY - (g.groundY(p.x, p.z) - FOOTING_M)) < 1e-6);
            const deck = plan.stations.reduce((a, b) => Math.abs(b.x - p.x) < Math.abs(a.x - p.x) ? b : a).deckY;
            assert.ok(deck - g.groundY(p.x, p.z) >= PIER_MIN_HEIGHT_M - 1e-6);
            assert.ok(p.topY < deck);
        }
    });

    it('never stands a pier on a road: moves it along the span to free ground', () => {
        // A 150 m viaduct over a valley: joints at 50 and 100 m. A 10 m road
        // runs across it at x = 50.
        const road = (x: number, _z: number, r: number) => Math.abs(x - 50) < 5 + r;
        const plan = planBridge(span('beam', 150), { ...valley(150, 30), onRoad: road })!;
        assert.equal(plan.piers.length, 2);
        for (const p of plan.piers) {
            assert.ok(!road(p.x, p.z, p.widthM * Math.SQRT1_2), `pier at ${p.x.toFixed(1)} stands on the road`);
        }
        const moved = plan.piers.find(p => p.x < 75)!;
        assert.ok(Math.abs(moved.x - 50) < 15, `moved too far: ${moved.x}`);
        assert.ok(plan.piers.some(p => Math.abs(p.x - 100) < 1e-6), 'the other pier stays at its joint');
    });

    it('leaves a pier out when the road under it is wider than it may move', () => {
        const road = (x: number, _z: number, r: number) => Math.abs(x - 50) < 30 + r;
        const plan = planBridge(span('beam', 150), { ...valley(150, 30), onRoad: road })!;
        assert.equal(plan.piers.length, 1);
        assert.ok(Math.abs(plan.piers[0].x - 100) < 1e-6);
    });

    it('stands a pier beside a road parallel to it, and one far from any square to the deck', () => {
        // A 150 m viaduct, joints at 50 and 100 m; a road at 45 degrees passes
        // 8 m from the first joint, clear of it.
        const dir: [number, number] = [Math.SQRT1_2, Math.SQRT1_2];
        const roadDirAt = (x: number, z: number, r: number) => {
            // Distance to the line through (58, 0) along dir.
            const d = Math.abs((x - 58) * dir[1] - z * dir[0]);
            return d < r ? dir : undefined;
        };
        const plan = planBridge(span('beam', 150), { ...valley(150, 30), roadDirAt })!;
        const near = plan.piers.find(p => Math.abs(p.x - 50) < 1e-6)!;
        const far = plan.piers.find(p => Math.abs(p.x - 100) < 1e-6)!;
        assert.ok(near.across, 'the pier beside the road is turned');
        assert.ok(Math.abs(Math.abs(near.across![0] * dir[0] + near.across![1] * dir[1]) - 1) < 1e-9, 'parallel to the road');
        assert.equal(far.across, undefined, 'the pier far from it stays square');
    });

    it('turns a pier no further off square than an abutment, and not at all for a road crossing square', () => {
        const at = (deg: number) => {
            const r = (deg * Math.PI) / 180;
            const dir: [number, number] = [Math.cos(r), Math.sin(r)];
            return planBridge(span('beam', 150), { ...valley(150, 30), roadDirAt: () => dir })!.piers[0].across;
        };
        assert.equal(at(90), undefined);
        const sharp = at(10)!;
        const off = (Math.acos(Math.abs(sharp[1])) * 180) / Math.PI;
        assert.ok(Math.abs(off - MAX_SKEW_DEG) < 1e-6, `${off} degrees off square`);
    });

    it('splits a long span into whole equal bays near 50 m', () => {
        const plan = planBridge(span('beam', 706), { groundY: (x) => (x > 100 && x < 600 ? 90 : 100) })!;
        const xs = plan.piers.map(p => p.x);
        // 706 m -> 14 bays of 50.43 m, 13 joints; those over the low ground get a pier.
        assert.ok(xs.length >= 9);
        for (let i = 1; i < xs.length; i++) {
            const gap = xs[i] - xs[i - 1];
            assert.ok(Math.abs(gap - 706 / 14) < 1e-6 || Math.abs(gap / (706 / 14) - Math.round(gap / (706 / 14))) < 1e-6, `${gap}`);
        }
    });

    it('gives a span shorter than two bays no pier', () => {
        assert.equal(planBridge(span('beam', 70), valley(70, 30))!.piers.length, 0);
    });

    it('keeps the deck out of the water by the freeboard and no more', () => {
        // Water 2 m above the straight line between two 100 m banks.
        const ground: BridgeGround = {
            groundY: () => 100,
            waterY: (x) => (x > 90 && x < 110 ? 102 : undefined),
        };
        const plan = planBridge(span('beam', 200), ground)!;
        const over = plan.stations.find(s => s.inWater)!;
        assert.ok(Math.abs(over.deckY - (102 + WATER_FREEBOARD_M)) < 1e-9);
        // The whole straight deck moves up, so the ends stand on a fill.
        assert.ok(plan.stations.every(s => Math.abs(s.deckY - (102 + WATER_FREEBOARD_M)) < 1e-9));
    });

    it('does not lift a deck over water that is below its line', () => {
        const ground: BridgeGround = {
            groundY: () => 100,
            waterY: (x) => (x > 90 && x < 110 ? 96 : undefined),
        };
        const plan = planBridge(span('beam', 200), ground)!;
        assert.ok(plan.stations.every(s => Math.abs(s.deckY - 100) < 1e-9));
    });

    it('clears a road it is told of by the clearance', () => {
        const ground: BridgeGround = {
            groundY: () => 100,
            obstacleY: (x) => (x > 90 && x < 110 ? 100 : undefined),
        };
        const plan = planBridge(span('beam', 200), ground)!;
        assert.ok(Math.max(...plan.stations.map(s => s.deckY)) >= 100 + CLEARANCE_M - 1e-9);
    });

    it('lifts the whole straight deck for the clearance, ends included', () => {
        const ground: BridgeGround = {
            groundY: () => 100,
            obstacleY: (x) => (x > 90 && x < 110 ? 100 : undefined),
        };
        const plan = planBridge(span('beam', 200), ground)!;
        const under = plan.stations.filter(s => s.x > 90 && s.x < 110);
        for (const s of under) {
            assert.ok(s.deckY - plan.deckThicknessM >= 100 + CLEARANCE_M - 1e-9);
        }
        const a = plan.stations[0], b = plan.stations[plan.stations.length - 1];
        assert.ok(Math.abs(a.deckY - b.deckY) < 1e-9);
        for (const p of plan.stations) {
            assert.ok(Math.abs(p.deckY - a.deckY) < 1e-9);
        }
        assert.ok(plan.abutmentLiftM[0] > 0);
    });

    it('tilts the deck for a road near one end, lifting that end rather than both', () => {
        // A 100 m street bridge whose road passes under its last 20 m.
        const ground: BridgeGround = { groundY: () => 100, obstacleY: (x) => (x > 80 ? 100 : undefined) };
        const plan = planBridge({ ...span('beam', 100), maxGrade: 0.1 }, ground)!;
        const [liftA, liftB] = plan.abutmentLiftM;
        assert.ok(liftA < 1e-6, `start lifted ${liftA}`);
        assert.ok(liftB >= 5, `end lifted ${liftB}`);
        assert.ok((liftB - liftA) / 100 <= 0.1 + 1e-6, 'within its grade');
        for (const s of plan.stations.filter(st => st.x > 80)) {
            assert.ok(s.deckY - plan.deckThicknessM >= 100 + CLEARANCE_M - 1e-6, `${s.x}: ${s.deckY}`);
        }
    });

    it('lifts both ends when its grade will not take the whole lift at one', () => {
        const ground: BridgeGround = { groundY: () => 100, obstacleY: (x) => (x > 80 ? 100 : undefined) };
        const plan = planBridge({ ...span('beam', 100), maxGrade: 0.03 }, ground)!;
        const [liftA, liftB] = plan.abutmentLiftM;
        assert.ok(liftA > 0.5, `start lifted only ${liftA}`);
        assert.ok(Math.abs((liftB - liftA) / 100) <= 0.03 + 1e-6, 'within the railway grade');
        for (const s of plan.stations.filter(st => st.x > 80)) {
            assert.ok(s.deckY - plan.deckThicknessM >= 100 + CLEARANCE_M - 1e-6, `${s.x}: ${s.deckY}`);
        }
    });

    it('keeps a measured end where it is and lifts the unmeasured one', () => {
        // A road under the middle: either end could tilt the deck up, the lidar knows the start.
        const ground: BridgeGround = {
            groundY: () => 100, obstacleY: (x) => (x > 40 && x < 60 ? 100 : undefined), endY: [104, undefined],
        };
        const plan = planBridge({ ...span('beam', 100), maxGrade: 0.15 }, ground)!;
        assert.ok(Math.abs(plan.stations[0].deckY - 104) < 1e-6, `start at ${plan.stations[0].deckY}`);
        for (const s of plan.stations.filter(st => st.x > 40 && st.x < 60)) {
            assert.ok(s.deckY - plan.deckThicknessM >= 100 + CLEARANCE_M - 1e-6, `${s.x}: ${s.deckY}`);
        }
    });

    it('stands piers in the water, down to the river bed', () => {
        // A 100 m channel whose bed is 8 m under the banks, the water 2 m under them.
        const ground: BridgeGround = {
            groundY: (x) => (x > 150 && x < 250 ? 92 : 100),
            waterY: (x) => (x > 150 && x < 250 ? 98 : undefined),
        };
        const inChannel = planBridge(span('beam', 400), ground)!.piers.filter(p => p.x > 150 && p.x < 250);
        assert.ok(inChannel.length >= 1);
        for (const p of inChannel) {
            assert.ok(Math.abs(p.baseY - (92 - FOOTING_M)) < 1e-9);
        }
    });

    it('stands piers in water even when the mesh has no bed under it', () => {
        // Only the water sheet: the "ground" under the lake is its own surface.
        const ground: BridgeGround = {
            groundY: () => 100,
            waterY: (x) => (x > 100 && x < 600 ? 100 : undefined),
        };
        const piers = planBridge(span('beam', 700), ground)!.piers;
        const inLake = piers.filter(p => p.x > 100 && p.x < 600);
        assert.ok(inLake.length >= 8, `${inLake.length}`);
        for (const p of inLake) {
            assert.ok(Math.abs(p.baseY - (100 - WATER_PIER_DEPTH_M - FOOTING_M)) < 1e-9);
        }
        // Dry ground at deck level still gets none.
        assert.ok(piers.every(p => p.x > 100 && p.x < 600));
    });

    it('gives slab, beam, arch and truss spans piers, and hung, floating and tunnel spans none', () => {
        for (const s of ['slab', 'beam', 'arch', 'truss'] as const) {
            assert.ok(planBridge(span(s, 400), valley(400, 60))!.piers.length > 0, s);
        }
        for (const s of ['suspension', 'cable_stayed', 'floating', 'tunnel'] as const) {
            assert.equal(planBridge(span(s, 400), valley(400, 60))!.piers.length, 0, s);
        }
    });

    it('gives a deck on an embankment no pier', () => {
        assert.equal(planBridge(span('beam', 400), flat())!.piers.length, 0);
    });

    it('does not lift a layer-2 span: it adapts to its end heights like any other', () => {
        const plan = planBridge(span('beam', 200, 2), flat())!;
        assert.ok(plan.stations.every(s => Math.abs(s.deckY - 100) < 1e-9));
    });

    it('refuses a one-point span', () => {
        assert.equal(planBridge({ ...span('beam', 10), points: [{ x: 0, z: 0 }] }, flat()), undefined);
    });
});

describe('spanCrossings', () => {
    const deck = line(100);
    const at = (deg: number, x0: number) => {
        // A road through (x0, 0) at `deg` to the span, 200 m long.
        const r = deg * Math.PI / 180;
        return { points: [{ x: x0 - 100 * Math.cos(r), z: -100 * Math.sin(r) }, { x: x0 + 100 * Math.cos(r), z: 100 * Math.sin(r) }], half: 3.5 };
    };

    it('finds a road the span crosses at a shallow angle, and lifts the deck over it', () => {
        // 17 degrees: the old proximity test took it for an approach.
        const crossings = spanCrossings(deck, [at(17, 40)]);
        assert.equal(crossings.length, 1);
        assert.ok(Math.abs(crossings[0].along - 40) < 1e-6);
        const plan = planBridge({ structure: 'beam', deckWidthM: 5.5, layer: 1, points: deck },
            { ...flat(), obstacleY: crossingObstacle(deck, crossings, () => 100) })!;
        for (const st of plan.stations) {
            assert.ok(st.deckY >= 100 + CLEARANCE_M + 1.4 - 1e-9, `deck at ${st.s}: ${st.deckY}`);
        }
    });

    it('does not take a road leaving the span end at a shallow angle for one it crosses', () => {
        // A slip road from the span's far end, 10 degrees off: within a road
        // width of the centreline for 30 m, but it never cuts it.
        const r = 10 * Math.PI / 180;
        const slip = { points: [{ x: 100, z: 0 }, { x: 100 - 80 * Math.cos(r), z: 80 * Math.sin(r) }], half: 3.5 };
        assert.equal(spanCrossings(deck, [slip]).length, 0);
        // ... nor its own road running on from either end.
        assert.equal(spanCrossings(deck, [{ points: [{ x: 100, z: 0 }, { x: 300, z: 0 }], half: 3.5 }]).length, 0);
    });

    it('lifts a span too short for a station between its ends', () => {
        // 11 m over a road crossing square in the middle: stations at the ends only.
        const short = line(11);
        const crossings = spanCrossings(short, [at(90, 5.5)]);
        assert.equal(crossings.length, 1);
        const plan = planBridge({ structure: 'slab', deckWidthM: 7, layer: 1, points: short },
            { ...flat(), obstacleY: crossingObstacle(short, crossings, () => 100) })!;
        assert.equal(plan.stations.length, 2);
        assert.ok(plan.stations[0].deckY >= 100 + CLEARANCE_M + 0.6 - 1e-9, `deck ${plan.stations[0].deckY}`);
    });

    it('finds a road that stops just short of the span on either side', () => {
        // The stretch under the deck mapped as a way the vectors leave out.
        const south = { points: [{ x: 50, z: -80 }, { x: 50, z: -4 }], half: 3.5 };
        const north = { points: [{ x: 50, z: 4 }, { x: 50, z: 80 }], half: 3.5 };
        const crossings = spanCrossings(deck, [south, north]);
        assert.ok(crossings.length >= 1 && crossings.every(c => Math.abs(c.along - 50) < 1e-6));
        // ... but not one stopping there at a shallow angle.
        const r = 10 * Math.PI / 180;
        assert.equal(spanCrossings(deck, [{ points: [{ x: 50 - 80 * Math.cos(r), z: -80 * Math.sin(r) - 3 }, { x: 50, z: -3 }], half: 3.5 }]).length, 0);
    });

    it('ignores a road meeting the span at its end', () => {
        assert.equal(spanCrossings(deck, [at(90, 3)]).length, 0);
        assert.equal(spanCrossings(deck, [at(90, 9)]).length, 1);
        assert.equal(spanCrossings(deck, [at(90, 50)]).length, 1);
    });
});

describe('bridgeRank', () => {
    const tier = (name: string) => BED_TIERS.findIndex(t => t.name === name);
    it('makes railways and Autobahns peers: the bridge of either clears the other', () => {
        assert.equal(bridgeRank(tier('railway')), bridgeRank(tier('autobahn')));
    });
    it('ranks both over highways, and highways over streets', () => {
        assert.ok(bridgeRank(tier('highway')) > bridgeRank(tier('autobahn')));
        assert.ok(bridgeRank(tier('street')) > bridgeRank(tier('highway')));
    });
});

describe('endJunctions', () => {
    // A 40 m span along x from 0 to 40, its road going on from x 40 to 140.
    const span = [{ x: 0, z: 0 }, { x: 40, z: 0 }];
    const onward = Array.from({ length: 21 }, (_, i) => ({ x: 40 + i * 5, z: 0 }));
    const sideAt = (x: number) => [{ x, z: 0 }, { x, z: 30 }];

    it('finds a road meeting the one carrying the span on, and how far on', () => {
        const [a, b] = endJunctions(span, [onward, sideAt(60)], 100);
        assert.deepEqual(a, []);
        assert.equal(b.length, 1);
        assert.equal(b[0].d, 20);
        assert.equal(b[0].road, 1);
    });
    it('looks no further than asked', () => {
        assert.deepEqual(endJunctions(span, [onward, sideAt(120)], 50)[1], []);
    });
    it('finds a road leaving the end itself sideways, at 0 m', () => {
        const [, b] = endJunctions(span, [onward, sideAt(40)], 100);
        assert.equal(b[0].d, 0);
        assert.equal(b[0].road, 1);
    });
    it('does not take the road coming back along the span for a junction', () => {
        const back = [{ x: 40, z: 0 }, { x: 0, z: 0 }];
        assert.deepEqual(endJunctions(span, [onward, back], 100)[1], []);
    });
});

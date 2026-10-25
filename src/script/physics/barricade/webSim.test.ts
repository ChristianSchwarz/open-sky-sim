/**
 * Phase 4: the rigid-body webbing inside CombatSim. An aircraft whose drawn
 * airframe the sim has (setBarricadeAirframe) is stopped by the web's own
 * impulses, through its flight model, not by the scripted run-out: caught
 * centred and 3 m off at 45 m/s it must stop within the MK-7's run-out
 * under 5 g, the web holding it, and the web's step must stay in budget.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as THREE from 'three';
import { Faction } from '../../weapons/combatant';
import { FcsPitchLimiter } from '../fm2/fcs';
import { defaultFm2Config, fm2GroundRestHeight } from '../fm2/fm2AircraftConfig';
import { CarrierMeshCollider } from '../../scene/entities/carrierDeck';
import { BarricadeEngagement, BARRICADE_DECK_Y, BARRICADE_LOCAL_Z, BARRICADE_MID_X } from '../../scene/entities/barricadeSpec';
import { CombatSim } from '../sim/combatSim';
import { serializeWorld } from '../sim/serializedWorld';
import { loadWebAirframe, WebFixture } from './webFixtures.testkit.test';
import { buildRiggedWeb } from './webLayout';
import { WebSolver } from './webSolver';
import { deckAndPayoutFails, DECK_TOLERANCE_M } from './webHarness.testkit.test';

const DT = 1 / 60;
const G0 = 9.80665;
const ID = 'web-sim';
/** The MK-7 Mod 3's longest run-out, 344 ft (m). */
const MAX_RUN_OUT_M = 105;
const MAX_WEB_MS = 5;
/** Caught and slower than this (m/s), the pilot is on the brakes. */
const BRAKE_BELOW_MPS = 5;

function flatDeck(): CarrierMeshCollider {
    const y = BARRICADE_DECK_Y;
    const x0 = -60, x1 = 60, z0 = -200, z1 = 200;
    return {
        originX: 0, originY: 0, originZ: 0,
        triangles: [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1],
        aabb: { min: [x0, y, z0], max: [x1, y, z1] },
    };
}

/**
 * A deck that is not the flat plane, as the Kuznetsov's is not: 0.3 m above
 * BARRICADE_DECK_Y at the barricade, rising 0.15 m per 100 m toward the bow
 * (-z) and cambered 2 cm per 10 m off the centreline, as triangles on a 5 m grid.
 */
function shapedDeckHeight(x: number, z: number): number {
    return BARRICADE_DECK_Y + 0.3 + 0.0015 * (BARRICADE_LOCAL_Z - z) - 0.002 * Math.abs(x - BARRICADE_MID_X);
}
function shapedDeck(): CarrierMeshCollider {
    const tris: number[] = [];
    const s = 5, x0 = BARRICADE_MID_X - 60, x1 = BARRICADE_MID_X + 60, z0 = -200, z1 = 200;
    let ymin = Infinity, ymax = -Infinity;
    for (let x = x0; x < x1; x += s) {
        for (let z = z0; z < z1; z += s) {
            const c = [[x, z], [x + s, z], [x + s, z + s], [x, z + s]].map(([px, pz]) => [px, shapedDeckHeight(px, pz), pz]);
            for (const [a, b, d] of [[0, 1, 2], [0, 2, 3]]) tris.push(...c[a], ...c[b], ...c[d]);
            for (const p of c) { ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); }
        }
    }
    return { originX: 0, originY: 0, originZ: 0, triangles: tris, aabb: { min: [x0, ymin, z0], max: [x1, ymax, z1] } };
}

const INPUT = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0,
    landingGearDeployed: true, flapsExtended: true, airbrakesExtended: false, hookDeployed: false,
    wheelBrakesApplied: false, pitchLimiterMode: FcsPitchLimiter.SOFT, limitersEnabled: true,
    wantForceVectors: false, firing: false,
} as const;
type Ac = { barricadeState: BarricadeEngagement; model: { position: THREE.Vector3; velocityVector: THREE.Vector3 } };

/** The sim with a rigged barricade and the FM2 aircraft rolling at it, its drawn airframe the fixture's. */
function rolling(fixture: WebFixture, speed: number, x: number, deck = flatDeck(), deckAt = (_x: number, _z: number) => BARRICADE_DECK_Y): CombatSim {
    const sim = new CombatSim();
    sim.setWorld(serializeWorld([], [], [], [], [deck]));
    sim.setBarricades([{ originX: 0, originY: 0, originZ: 0, quaternion: [0, 0, 0, 1], armed: true, generation: 1, webbing: true }]);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    const rest = fm2GroundRestHeight(defaultFm2Config);
    const af = loadWebAirframe(fixture);
    // The fixture's wheels on the deck where the sim's aircraft rests on its gear.
    const drawn = Float32Array.from(af.triangles);
    for (let k = 1; k < drawn.length; k += 3) drawn[k] += -rest - af.bounds[1];
    sim.addAircraft({
        id: ID, faction: Faction.PLAYER, control: 'ai', kinematic: false,
        aircraftConfig: defaultFm2Config, hitRadius: 5, maxHealth: 100,
        spawn: {
            position: [BARRICADE_MID_X + x, deckAt(BARRICADE_MID_X + x, BARRICADE_LOCAL_Z + af.bounds[5] + 4) + rest, BARRICADE_LOCAL_Z + af.bounds[5] + 4],
            quaternion: [q.x, q.y, q.z, q.w], velocity: [0, 0, -speed], throttle: 0, landed: true, airborne: false,
        },
        enabled: true,
    });
    sim.setBarricadeAirframe(ID, drawn);
    return sim;
}

describe('barricade webbing in the sim', () => {
    for (const fixture of ['f22', 'f14a'] as const) {
        for (const x of [0, 3]) {
            it(`stops the ${fixture} at 45 m/s, ${x === 0 ? 'centred' : `${x} m off`}`, () => {
                const sim = rolling(fixture, 45, x);
                const a = (sim as unknown as { aircraft: Map<string, Ac> }).aircraft.get(ID)!;
                let caughtZ = NaN, peak = 0, webMs = 0, webMax = 0, frames = 0;
                let prev = a.model.velocityVector.clone();
                // 30 s: time enough to come to rest in the net and count as held.
                for (let f = 0; f < 60 * 30 && a.barricadeState !== BarricadeEngagement.HELD; f++) {
                    // The pilot brakes once the net has the jet down to walking pace (and the
                    // suite below checks it held without them too).
                    const braking = a.barricadeState !== BarricadeEngagement.NONE && a.model.velocityVector.length() < BRAKE_BELOW_MPS;
                    sim.step(DT, { [ID]: { ...INPUT, wheelBrakesApplied: braking } });
                    const web = sim.barricadeWebSnapshot()!;
                    webMs += web.stepMs;
                    webMax = Math.max(webMax, web.stepMs);
                    frames++;
                    if (Number.isNaN(caughtZ) && a.barricadeState !== BarricadeEngagement.NONE) caughtZ = a.model.position.z;
                    const v = a.model.velocityVector;
                    if (a.barricadeState !== BarricadeEngagement.NONE) peak = Math.max(peak, Math.hypot(v.x - prev.x, v.z - prev.z) / DT);
                    prev = v.clone();
                }
                const runOut = BARRICADE_LOCAL_Z - a.model.position.z;
                const solver = (sim as unknown as { barricadeWebs: { solver: WebSolver }[] }).barricadeWebs[0].solver;
                const deckPay = deckAndPayoutFails(solver);
                const line = `${fixture} x ${x}: ${JSON.stringify({ state: a.barricadeState, caughtZ: +caughtZ.toFixed(1), runOut: +runOut.toFixed(1), peakG: +(peak / G0).toFixed(2), webMs: +(webMs / frames).toFixed(2), webMax: +webMax.toFixed(2), speed: +a.model.velocityVector.length().toFixed(2), payout: Math.max(...solver.stats.payout).toFixed(1), aboveDeck: +(solver.stats.lowestY - BARRICADE_DECK_Y).toFixed(3) })}`;
                console.log(line);
                assert.equal(a.barricadeState, BarricadeEngagement.HELD, line);
                assert.ok(runOut > 20 && runOut <= MAX_RUN_OUT_M, line);
                assert.ok(peak / G0 < 5, line);
                assert.ok(webMs / frames < MAX_WEB_MS, line);
                assert.deepEqual(deckPay, [], line);
            });
        }
    }
});

/**
 * The webbing as the game laces it, through the sim (its settling in slices,
 * the cached rigged state): taut between the stanchion heads, its sag the
 * rigged gate's (0.29 m, webGates), nothing paid out. A settling cut short
 * by the step deadline once left every net of a session 2.3 m slack.
 */
describe('barricade webbing rigged in the sim', () => {
    const SAG_MAX_M = 0.35;
    const PAYOUT_MAX_M = 0.05;
    // Measured from the upper belt's corners at the stanchion heads (its ends are down at the shackles).
    const rig = buildRiggedWeb();
    const heads = rig.upperHeads;
    const midUpper = rig.upperBelt[rig.upperBelt.length >> 1];
    function riggedSag(sim: CombatSim): { sag: number; payout: number; ready: boolean } {
        const web = sim.barricadeWebSnapshot()!;
        const y = (i: number) => web.positions[3 * i + 1];
        const ends = Math.max(y(heads[0]), y(heads[1]));
        return { sag: ends - y(midUpper), payout: Math.max(...web.payout.map(Math.abs)), ready: web.warm };
    }
    function lace(sim: CombatSim, generation: number): void {
        sim.setBarricades([{ originX: 0, originY: 0, originZ: 0, quaternion: [0, 0, 0, 1], armed: true, generation, webbing: true }]);
    }
    for (const fps of [60, 40]) {
        it(`hangs taut at ${fps} fps, laced and laced again`, () => {
            const sim = new CombatSim();
            sim.setWorld(serializeWorld([], [], [], [], [flatDeck()]));
            for (const generation of [1, 2]) {
                lace(sim, generation);
                let r = riggedSag(sim);
                for (let f = 0; f < 600 && !(r.ready && f > 120); f++) {
                    sim.step(1 / fps, {});
                    r = riggedSag(sim);
                }
                const line = `${fps} fps, generation ${generation}: ${JSON.stringify({ sag: +r.sag.toFixed(3), payout: +r.payout.toFixed(3), ready: r.ready })}`;
                console.log(line);
                assert.ok(r.sag <= SAG_MAX_M, line);
                assert.ok(r.payout <= PAYOUT_MAX_M, line);
            }
        });
    }
    it('hangs taut again after a catch, laced fresh', () => {
        const sim = rolling('f22', 45, 0);
        const a = (sim as unknown as { aircraft: Map<string, Ac> }).aircraft.get(ID)!;
        // Caught (held, or still settling in the net: this test is about the lacing after it).
        for (let f = 0; f < 60 * 30 && a.barricadeState !== BarricadeEngagement.HELD; f++) sim.step(DT, { [ID]: { ...INPUT } });
        assert.notEqual(a.barricadeState, BarricadeEngagement.NONE);
        sim.removeAircraft(ID);
        lace(sim, 2);
        let r = riggedSag(sim);
        for (let f = 0; f < 300; f++) {
            sim.step(DT, {});
            r = riggedSag(sim);
        }
        const line = `after a catch, generation 2: ${JSON.stringify({ sag: +r.sag.toFixed(3), payout: +r.payout.toFixed(3) })}`;
        console.log(line);
        assert.ok(r.sag <= SAG_MAX_M, line);
        assert.ok(r.payout <= PAYOUT_MAX_M, line);
    });
});

/**
 * On a deck that is not flat (shapedDeck), through a catch and the hold:
 * no particle under the deck's surface where it is (the webbing once lay up
 * to 0.31 m under the drawn deck, floored on the flat plane).
 */
describe('barricade webbing on the real deck', () => {
    for (const x of [0, 3]) {
        it(`keeps the webbing on a raised, sloping, cambered deck, ${x} m off`, () => {
            const sim = rolling('f22', 45, x, shapedDeck(), shapedDeckHeight);
            const a = (sim as unknown as { aircraft: Map<string, Ac> }).aircraft.get(ID)!;
            const solver = () => (sim as unknown as { barricadeWebs: { solver: WebSolver }[] }).barricadeWebs[0].solver;
            let worst = Infinity, at = '';
            for (let f = 0; f < 60 * 25; f++) {
                const braking = a.barricadeState !== BarricadeEngagement.NONE && a.model.velocityVector.length() < BRAKE_BELOW_MPS;
                sim.step(DT, { [ID]: { ...INPUT, wheelBrakesApplied: braking } });
                const s = solver();
                for (let i = 0; i < s.count; i++) {
                    const gap = s.x[3 * i + 1] - shapedDeckHeight(s.x[3 * i], s.x[3 * i + 2]);
                    if (gap < worst) { worst = gap; at = `f${f} particle ${i} at ${[0, 1, 2].map(k => s.x[3 * i + k].toFixed(2)).join(', ')}`; }
                }
                if (a.barricadeState === BarricadeEngagement.HELD && f > 60 * 12) break;
            }
            const line = `shaped deck x ${x}: ${JSON.stringify({ state: a.barricadeState, runOut: +(BARRICADE_LOCAL_Z - a.model.position.z).toFixed(1), lowestAboveDeck: +worst.toFixed(3), at, jetAboveDeck: +(a.model.position.y - shapedDeckHeight(a.model.position.x, a.model.position.z)).toFixed(2) })}`;
            console.log(line);
            assert.notEqual(a.barricadeState, BarricadeEngagement.NONE, line);
            assert.ok(worst >= -DECK_TOLERANCE_M, line);
        });
    }
});

/**
 * After the stop: the jet stays in the net, on its wheels, and is not rolled
 * back out of it. Measured from the farthest the CG got: braked (the pilot on
 * the brakes below BRAKE_BELOW_MPS) under 1 m, free no more than a few metres
 * (phase 3 measured 0.7-4 m). It used to be thrown back 30-100 m, braked or
 * not: the gear caught the lower load strap, the pull 1-2 m under the CG
 * stood the jet on its nose wheel, and an off-centre catch yawed it round and
 * rolled it onto its side, wheels off the deck (see withoutGear).
 */
describe('barricade webbing holds what it stopped', () => {
    const BRAKED_BACK_M = 1;
    const FREE_BACK_M = 4;
    /** Leaning on a wingtip at most (BARRICADE_TILT_RAD is the usual ~4 deg), never over on its side. */
    const MAX_ROLL_DEG = 30;
    /** Held, then this long more (s): a rebound shows by then. */
    const AFTER_HELD_S = 4;
    for (const fixture of ['f22', 'f14a', 'f16a', 'f16xl'] as const) {
        for (const speed of [45, 60]) {
            for (const x of [0, 3, -3]) {
                it(`${fixture} at ${speed} m/s, ${x === 0 ? 'centred' : `${x} m off`}: braked and free`, () => {
                    const lines: string[] = [];
                    for (const braked of [true, false]) {
                        const sim = rolling(fixture, speed, x);
                        const a = (sim as unknown as { aircraft: Map<string, Ac & { model: { quaternion: THREE.Quaternion } }> }).aircraft.get(ID)!;
                        const solver = (sim as unknown as { barricadeWebs: { solver: WebSolver }[] }).barricadeWebs[0].solver;
                        let farthest = Infinity, maxRoll = 0, heldAt = -1, lostAfterCatch = false, caught = false;
                        const e = new THREE.Euler();
                        for (let f = 0; f < 60 * 40 && (heldAt < 0 || f - heldAt < 60 * AFTER_HELD_S); f++) {
                            const braking = braked && a.barricadeState !== BarricadeEngagement.NONE && a.model.velocityVector.length() < BRAKE_BELOW_MPS;
                            sim.step(DT, { [ID]: { ...INPUT, wheelBrakesApplied: braking } });
                            if (a.barricadeState !== BarricadeEngagement.NONE) caught = true;
                            else if (caught) lostAfterCatch = true;
                            if (heldAt < 0 && a.barricadeState === BarricadeEngagement.HELD) heldAt = f;
                            farthest = Math.min(farthest, a.model.position.z);
                            e.setFromQuaternion(a.model.quaternion, 'YXZ');
                            maxRoll = Math.max(maxRoll, Math.abs(e.z) * 180 / Math.PI);
                        }
                        const back = a.model.position.z - farthest;
                        const r = {
                            braked, state: a.barricadeState, back: +back.toFixed(2), runOut: +(BARRICADE_LOCAL_Z - farthest).toFixed(1),
                            maxRoll: +maxRoll.toFixed(1), payout: +Math.max(...solver.stats.payout).toFixed(1),
                            aboveDeck: +(solver.stats.lowestY - BARRICADE_DECK_Y).toFixed(3),
                        };
                        const line = `${fixture} ${speed} m/s x ${x}: ${JSON.stringify(r)}`;
                        console.log(line);
                        lines.push(line);
                        assert.equal(a.barricadeState, BarricadeEngagement.HELD, line);
                        assert.ok(!lostAfterCatch, `let go: ${line}`);
                        assert.ok(back <= (braked ? BRAKED_BACK_M : FREE_BACK_M), line);
                        assert.ok(maxRoll <= MAX_ROLL_DEG, line);
                        assert.ok(BARRICADE_LOCAL_Z - farthest <= MAX_RUN_OUT_M, line);
                        assert.deepEqual(deckAndPayoutFails(solver), [], line);
                    }
                });
            }
        }
    }
});

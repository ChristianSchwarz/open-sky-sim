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

const DT = 1 / 60;
const G0 = 9.80665;
const ID = 'web-sim';
/** The MK-7 Mod 3's longest run-out, 344 ft (m). */
const MAX_RUN_OUT_M = 105;
const MAX_WEB_MS = 5;

function flatDeck(): CarrierMeshCollider {
    const y = BARRICADE_DECK_Y;
    const x0 = -60, x1 = 60, z0 = -200, z1 = 200;
    return {
        originX: 0, originY: 0, originZ: 0,
        triangles: [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1],
        aabb: { min: [x0, y, z0], max: [x1, y, z1] },
    };
}

const INPUT = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0,
    landingGearDeployed: true, flapsExtended: true, airbrakesExtended: false, hookDeployed: false,
    wheelBrakesApplied: false, pitchLimiterMode: FcsPitchLimiter.SOFT, limitersEnabled: true,
    wantForceVectors: false, firing: false,
} as const;
type Ac = { barricadeState: BarricadeEngagement; model: { position: THREE.Vector3; velocityVector: THREE.Vector3 } };

/** The sim with a rigged barricade and the FM2 aircraft rolling at it, its drawn airframe the fixture's. */
function rolling(fixture: WebFixture, speed: number, x: number): CombatSim {
    const sim = new CombatSim();
    sim.setWorld(serializeWorld([], [], [], [], [flatDeck()]));
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
            position: [BARRICADE_MID_X + x, BARRICADE_DECK_Y + rest, BARRICADE_LOCAL_Z + af.bounds[5] + 4],
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
                for (let f = 0; f < 60 * 20 && a.barricadeState !== BarricadeEngagement.HELD; f++) {
                    sim.step(DT, { [ID]: { ...INPUT } });
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
                const line = `${fixture} x ${x}: ${JSON.stringify({ state: a.barricadeState, caughtZ: +caughtZ.toFixed(1), runOut: +runOut.toFixed(1), peakG: +(peak / G0).toFixed(2), webMs: +(webMs / frames).toFixed(2), webMax: +webMax.toFixed(2), speed: +a.model.velocityVector.length().toFixed(2) })}`;
                console.log(line);
                assert.equal(a.barricadeState, BarricadeEngagement.HELD, line);
                assert.ok(runOut > 20 && runOut <= MAX_RUN_OUT_M, line);
                assert.ok(peak / G0 < 5, line);
                assert.ok(webMs / frames < MAX_WEB_MS, line);
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
    const upper = buildRiggedWeb().upperBelt;
    function riggedSag(sim: CombatSim): { sag: number; payout: number; ready: boolean } {
        const web = sim.barricadeWebSnapshot()!;
        const y = (i: number) => web.positions[3 * i + 1];
        const ends = Math.max(y(upper[0]), y(upper[upper.length - 1]));
        return { sag: ends - y(upper[upper.length >> 1]), payout: Math.max(...web.payout.map(Math.abs)), ready: web.warm };
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
        for (let f = 0; f < 60 * 20 && a.barricadeState !== BarricadeEngagement.HELD; f++) sim.step(DT, { [ID]: { ...INPUT } });
        assert.equal(a.barricadeState, BarricadeEngagement.HELD);
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

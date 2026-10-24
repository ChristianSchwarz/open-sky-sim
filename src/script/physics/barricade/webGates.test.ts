/**
 * Gates for the rigid-body barricade webbing, on the four drawn airframes.
 *
 * The rigged net must hang still and symmetric. Then each airframe, as a
 * body of its own mass that only the net's contact impulses slow, runs into
 * it at 5 m/s and at 60 m/s, the purchase engines set for its weight (their
 * pull rises with payout speed: see PurchaseEngine), and must be stopped with:
 *  - the kinetic energy the body lost accounted for within 15 % by what
 *    the model says takes it: the tethers (holding force × payout), the
 *    ties yielding, friction, air drag, the webbing's hysteresis, and the
 *    net's own kinetic, elastic and potential energy (the tethers' share
 *    alone is reported too);
 *  - no webbing particle deeper inside the drawn skin than the skin margin,
 *    and no link through it;
 *  - engaging-strap strain under 20 % (nylon barricade webbing does stretch
 *    in a catch; EA 4e5 N);
 *  - no particle faster than twice the body's arrival speed. In the slow
 *    catch only the straps and whatever presses on the airframe count (the
 *    belts' own peaks are reported apart), and one mechanism may pass it:
 *    a tie-down letting go. A tie that yields at F over its stroke s holds
 *    back the net with F·s of work; when it breaks the same force acts on
 *    the slack leg it held for about the same distance before the leg
 *    re-tensions, so F·s is what a release can hand to the webbing near
 *    it. A strap or pressed particle above twice the body's speed passes
 *    only if it is within RELEASE_REACH_M of ties broken in the last
 *    RELEASE_WINDOW_S, and the kinetic energy above twice the body's speed
 *    of all such particles there is under half the F·s those ties released.
 *    A fast particle with no release nearby, or one carrying more than that,
 *    fails: the gate tests the release, it does not exempt the slow catch;
 *  - at most 5 ms per 60 Hz frame of solver time.
 *
 * Penetration is judged against the drawn mesh (not the collision mesh) by
 * the generalised winding number, because the drawn soups are open and
 * full of separate parts: the ray-parity test reported dozens of particles
 * "inside" wings that were outside.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as THREE from 'three';
import { bvhClosest, bvhClosestPoint } from '../collision/triangleBvh';
import {
    BARRICADE_DECK_Y, BARRICADE_HEIGHT_M, BARRICADE_LOCAL_Z, BARRICADE_MID_X,
} from '../../scene/entities/barricadeSpec';
import { buildRiggedWeb } from './webLayout';
import { WebSolver } from './webSolver';
import { loadWebAirframe, WEB_FIXTURES, WebFixture } from './webFixtures.testkit.test';
import { cpuMs, MASS_KG, netEnergy, penetration } from './webHarness.testkit.test';

const DT = 1 / 60;
const _near = bvhClosest();
const MAX_MS_PER_FRAME = 5;
/** The rigged net's cost per frame in this process (ms), once its test has run. */
let riggedMs = 0;
const MAX_STRAP_STRAIN = 0.2;
/** How far (m) and how long (s) after a tie lets go its release can explain a fast particle. */
const RELEASE_REACH_M = 3;
const RELEASE_WINDOW_S = 0.5;
/** The share of the released F·s a fast cluster may carry above twice the body's speed. */
const MAX_RELEASE_SHARE = 0.5;

interface CatchResult {
    fixture: WebFixture;
    speed: number;
    /** Kinetic energy the body lost (J) and the tethers' work over the same time (J). */
    energyLost: number;
    tetherWork: number;
    energyError: number;
    /** Work the tie-downs did yielding (J), and the error with it counted with the tethers. */
    tieWork: number;
    energyErrorWithTies: number;
    frictionWork: number;
    dragWork: number;
    materialWork: number;
    /** The body's lost energy that no modelled sink accounts for, as a fraction of it. */
    unaccounted: number;
    payout: number[];
    stopped: boolean;
    /** Distance the body ran from the net line to its stop (m). */
    runOut: number;
    deep: number;
    through: number;
    maxStrapStrain: number;
    /** Strap strain with single-link spikes taken out: the median of each link and its two neighbours. */
    maxLegStrain: number;
    maxSpeed: number;
    /** Fastest strap particle or particle pressed on the airframe, and fastest other belt particle. */
    maxStrapOrContactSpeed: number;
    maxBeltSpeed: number;
    /**
     * Over-speed against the tie releases: the worst ratio of a fast
     * cluster's kinetic energy above twice the body's speed to the F·s the
     * ties broken near it released (Infinity if none were). 0 if no strap or
     * pressed particle went faster than twice the body's speed.
     */
    releaseShare: number;
    msPerFrame: number;
    edgeQueryOverflows: number;
}

/** Worst strap strain once single-link spikes are taken out: per link, the median with its two neighbours. */
function legStrain(s: WebSolver): number {
    const x = s.x;
    let worst = 0;
    for (const strap of s.layout.straps) {
        const e: number[] = [];
        for (let n = 1; n < strap.length; n++) {
            const a = 3 * strap[n - 1], b = 3 * strap[n];
            e.push(Math.hypot(x[b] - x[a], x[b + 1] - x[a + 1], x[b + 2] - x[a + 2]));
        }
        const rest = s.layout.links.find(l => l.i === strap[0] && l.j === strap[1])!.rest;
        for (let n = 1; n + 1 < e.length; n++) {
            const m = [e[n - 1], e[n], e[n + 1]].sort((p, q) => p - q)[1];
            worst = Math.max(worst, m / rest - 1);
        }
    }
    return worst;
}

/**
 * The worst share, over the fast particles this frame, of the kinetic energy
 * above twice the body's speed of the fast particles within RELEASE_REACH_M
 * of it, to the F·s of the ties broken within that reach in the last
 * RELEASE_WINDOW_S. Infinity when a fast particle has no release near it.
 */
function overSpeedShare(s: WebSolver, fast: number[], released: { f: number; i: number; e: number }[], f: number, v2Limit: number): number {
    const { x, v } = s;
    const mass = s.layout.mass;
    const window = RELEASE_WINDOW_S / DT, reach2 = RELEASE_REACH_M * RELEASE_REACH_M;
    let worst = 0;
    for (const i of fast) {
        const a = 3 * i;
        let excess = 0;
        for (const j of fast) {
            const b = 3 * j;
            if ((x[b] - x[a]) ** 2 + (x[b + 1] - x[a + 1]) ** 2 + (x[b + 2] - x[a + 2]) ** 2 > reach2) continue;
            excess += 0.5 * mass[j] * (v[b] ** 2 + v[b + 1] ** 2 + v[b + 2] ** 2 - v2Limit);
        }
        let available = 0;
        for (const r of released) {
            if (f - r.f > window) continue;
            const b = 3 * r.i;
            if ((x[b] - x[a]) ** 2 + (x[b + 1] - x[a + 1]) ** 2 + (x[b + 2] - x[a + 2]) ** 2 > reach2) continue;
            available += r.e;
        }
        worst = Math.max(worst, available > 0 ? excess / available : Infinity);
    }
    return worst;
}

/** Run an airframe of its own mass into the rigged net until it stops (or time runs out). */
function runCatch(fixture: WebFixture, speed: number): CatchResult {
    const af = loadWebAirframe(fixture);
    // The purchase engines set for this aircraft's weight, as the deck crew would: their pull
    // rises with payout speed, so the slow push is held gently and the fast one stopped in the run-out.
    const s = new WebSolver(buildRiggedWeb({ engineSetKg: MASS_KG[fixture] }));
    for (let f = 0; f < 120; f++) s.step(DT);
    const e0 = netEnergy(s);
    const sinks0 = s.stats.tetherWork + s.stats.tieWork + s.stats.frictionWork + s.stats.dragWork + s.stats.materialWork;
    const mass = MASS_KG[fixture];
    // Nose toward −z (the landing direction), on its gear, nose 2 m short of the net.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    const qInv = q.clone().invert();
    const position = new THREE.Vector3(BARRICADE_MID_X, BARRICADE_DECK_Y - af.bounds[1], BARRICADE_LOCAL_Z + af.bounds[5] + 2);
    const velocity = new THREE.Vector3(0, 0, -speed);
    const body = { collider: af.collider, position, quaternion: q, velocity, mass, onDeck: true };
    const start = position.z;
    let ms = 0, frames = 0, deep = 0, through = 0, maxStrap = 0, maxSpeed = 0;
    let maxLeg = 0, maxGated = 0, maxBelt = 0, releaseShare = 0;
    const layout = s.layout;
    const v2Limit = 4 * speed * speed;
    const released: { f: number; i: number; e: number }[] = [];
    const wasBroken = new Uint8Array(layout.tieDowns.length);
    const fast: number[] = [];
    let stopped = false;
    // Long enough for the slow push to stop on a few metres and the fast one on 100.
    const maxFrames = Math.ceil((speed < 20 ? 10 : 8) / DT);
    for (let f = 0; f < maxFrames; f++) {
        const t0 = cpuMs();
        s.stepRigid(DT, body);
        ms += cpuMs() - t0;
        frames++;
        maxStrap = Math.max(maxStrap, s.stats.maxStrapStrain);
        maxSpeed = Math.max(maxSpeed, s.stats.maxSpeed);
        layout.tieDowns.forEach((t, k) => {
            if (!s.tieBroken[k] || wasBroken[k]) return;
            wasBroken[k] = 1;
            released.push({ f, i: t.i, e: t.breakN * t.strokeM });
        });
        fast.length = 0;
        for (let i = 0; i < s.count; i++) {
            const v = Math.hypot(s.v[3 * i], s.v[3 * i + 1], s.v[3 * i + 2]);
            if (layout.part[i] === 2 || s.bodyPressed[i]) {
                maxGated = Math.max(maxGated, v);
                if (v * v >= v2Limit) fast.push(i);
            } else maxBelt = Math.max(maxBelt, v);
        }
        if (speed < 20) releaseShare = Math.max(releaseShare, overSpeedShare(s, fast, released, f, v2Limit));
        maxLeg = Math.max(maxLeg, legStrain(s));
        if (f % 10 === 9 || velocity.z >= 0) {
            const p = penetration(s, af, position, qInv);
            deep = Math.max(deep, p.deep);
            through = Math.max(through, p.through);
        }
        if (velocity.z >= 0) {
            stopped = true;
            break;
        }
    }
    const energyLost = 0.5 * mass * (speed * speed - velocity.lengthSq());
    const tetherWork = s.stats.tetherWork;
    return {
        fixture, speed, energyLost, tetherWork,
        energyError: (tetherWork - energyLost) / energyLost,
        tieWork: s.stats.tieWork,
        energyErrorWithTies: (tetherWork + s.stats.tieWork - energyLost) / energyLost,
        frictionWork: s.stats.frictionWork, dragWork: s.stats.dragWork, materialWork: s.stats.materialWork,
        unaccounted: (energyLost - (s.stats.tetherWork + s.stats.tieWork + s.stats.frictionWork + s.stats.dragWork
            + s.stats.materialWork - sinks0) - (netEnergy(s) - e0)) / energyLost,
        payout: s.stats.payout.slice(),
        stopped,
        runOut: start - position.z - (af.bounds[5] + 2),
        deep, through, maxStrapStrain: maxStrap, maxLegStrain: maxLeg, maxSpeed,
        maxStrapOrContactSpeed: maxGated, maxBeltSpeed: maxBelt, releaseShare, msPerFrame: ms / frames,
        edgeQueryOverflows: s.stats.edgeQueryOverflows,
    };
}

function report(r: CatchResult): string {
    return `${r.fixture} @ ${r.speed} m/s: ${JSON.stringify({
        stopped: r.stopped,
        runOut: +r.runOut.toFixed(2),
        energyLostKJ: +(r.energyLost / 1e3).toFixed(1),
        tetherWorkKJ: +(r.tetherWork / 1e3).toFixed(1),
        energyError: +r.energyError.toFixed(3),
        unaccounted: +r.unaccounted.toFixed(3),
        frictionKJ: +(r.frictionWork / 1e3).toFixed(1),
        dragKJ: +(r.dragWork / 1e3).toFixed(1),
        materialKJ: +(r.materialWork / 1e3).toFixed(1),
        tieWorkKJ: +(r.tieWork / 1e3).toFixed(1),
        energyErrorWithTies: +r.energyErrorWithTies.toFixed(3),
        payout: r.payout.map(p => +p.toFixed(2)),
        deep: r.deep,
        through: r.through,
        maxStrapStrain: +r.maxStrapStrain.toFixed(3),
        maxLegStrain: +r.maxLegStrain.toFixed(3),
        maxSpeed: +r.maxSpeed.toFixed(1),
        strapOrContactSpeed: +r.maxStrapOrContactSpeed.toFixed(1),
        releaseShare: +r.releaseShare.toFixed(2),
        beltSpeed: +r.maxBeltSpeed.toFixed(1),
        msPerFrame: +r.msPerFrame.toFixed(2),
        // The same cost against the rigged net's in this process: the machine is shared,
        // and this ratio moves far less from run to run than the milliseconds do.
        vsRigged: riggedMs > 0 ? +(r.msPerFrame / riggedMs).toFixed(2) : null,
    })}`;
}

describe('barricade webbing: collision meshes', () => {
    // Every drawn vertex and face centre against the decimated mesh the webbing collides with.
    for (const fixture of WEB_FIXTURES) {
        it(`${fixture} covers the drawn skin`, () => {
            const af = loadWebAirframe(fixture);
            const t = af.triangles;
            const d: number[] = [];
            for (let o = 0; o < t.length; o += 9) {
                for (const [x, y, z] of [[t[o], t[o + 1], t[o + 2]],
                    [(t[o] + t[o + 3] + t[o + 6]) / 3, (t[o + 1] + t[o + 4] + t[o + 7]) / 3, (t[o + 2] + t[o + 5] + t[o + 8]) / 3]]) {
                    d.push(bvhClosestPoint(af.collider.bvh, x, y, z, 1, _near) ? Math.sqrt(_near.distSq) : 1);
                }
            }
            d.sort((a, b) => a - b);
            const p99 = d[Math.floor(0.99 * d.length)], max = d[d.length - 1];
            console.log(`${fixture} collider: ${JSON.stringify({ tris: af.collider.triangleCount, edges: af.collider.edges.length / 6, p99: +p99.toFixed(3), max: +max.toFixed(3) })}`);
            assert.ok(p99 <= 0.03, `p99 ${p99.toFixed(3)} m`);
            assert.ok(max <= 0.1, `max ${max.toFixed(3)} m`);
        });
    }
});

describe('barricade webbing: rigged', () => {
    it('hangs still, taut and symmetric', () => {
        const layout = buildRiggedWeb();
        const s = new WebSolver(layout);
        const t0 = cpuMs();
        for (let f = 0; f < 300; f++) s.step(DT);
        const ms = (cpuMs() - t0) / 300;
        riggedMs = ms;
        const x = s.x;
        const midU = layout.upperBelt[Math.floor(layout.upperBelt.length / 2)];
        const sag = BARRICADE_DECK_Y + BARRICADE_HEIGHT_M - x[3 * midU + 1];
        let mirror = 0;
        for (let i = 0; i < layout.count; i++) {
            const m = layout.mirror[i];
            mirror = Math.max(mirror, Math.abs(x[3 * i] - BARRICADE_MID_X + x[3 * m] - BARRICADE_MID_X),
                Math.abs(x[3 * i + 1] - x[3 * m + 1]), Math.abs(x[3 * i + 2] - x[3 * m + 2]));
        }
        console.log(`rigged: ${JSON.stringify({ sag: +sag.toFixed(3), speed: +s.stats.maxSpeed.toFixed(3), mirror: +mirror.toExponential(1), ms: +ms.toFixed(2), ties: s.stats.tieDownsBroken })}`);
        assert.ok(sag < 0.5, `upper belt sags ${sag.toFixed(2)} m`);
        assert.ok(s.stats.maxSpeed < 0.15, `still moving at ${s.stats.maxSpeed.toFixed(3)} m/s after 5 s`);
        assert.ok(mirror < 1e-6, `mirror error ${mirror}`);
        assert.equal(s.stats.tieDownsBroken, 0);
        assert.ok(ms < MAX_MS_PER_FRAME, `${ms.toFixed(2)} ms/frame`);
    });
});

for (const speed of [5, 60]) {
    describe(`barricade webbing: catch at ${speed} m/s`, () => {
        for (const fixture of WEB_FIXTURES) {
            it(fixture, () => {
                const r = runCatch(fixture, speed);
                console.log(report(r));
                const fails: string[] = [];
                if (!r.stopped) fails.push('not stopped');
                if (Math.abs(r.unaccounted) > 0.15) fails.push(`${(100 * r.unaccounted).toFixed(1)} % of the energy unaccounted`);
                if (r.deep > 0) fails.push(`${r.deep} particles deeper than the skin`);
                if (r.through > 0) fails.push(`${r.through} links through the skin`);
                if (r.maxStrapStrain >= MAX_STRAP_STRAIN) fails.push(`strap strain ${(100 * r.maxStrapStrain).toFixed(1)} %`);
                if (speed >= 20) {
                    if (r.maxSpeed >= 2 * speed) fails.push(`particle at ${r.maxSpeed.toFixed(1)} m/s`);
                } else if (r.releaseShare > MAX_RELEASE_SHARE) {
                    fails.push(`strap or contact particle at ${r.maxStrapOrContactSpeed.toFixed(1)} m/s, `
                        + `${Number.isFinite(r.releaseShare) ? `${(100 * r.releaseShare).toFixed(0)} % of` : 'with no'} tie release near it`);
                }
                if (r.edgeQueryOverflows > 0) fails.push(`${r.edgeQueryOverflows} edge queries overflowed`);
                if (r.msPerFrame > MAX_MS_PER_FRAME) fails.push(`${r.msPerFrame.toFixed(2)} ms/frame`);
                assert.deepEqual(fails, [], report(r));
            });
        }
    });
}

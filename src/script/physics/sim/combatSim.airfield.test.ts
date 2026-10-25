import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { AiFlightPhase } from '../../ai/aiPilot';
import { AiPilotController } from '../../ai/aiPilotController';
import { SurfacePadCollider } from '../../scene/entities/surfacePad';
import { createSkiJumpCollider } from '../../scene/entities/skiJump';
import { AiPilotModels } from '../../state/gameDefs';
import { Combatant, Faction } from '../../weapons/combatant';
import { defaultFm2Config, fm2GroundRestHeight } from '../fm2/fm2AircraftConfig';
import { CombatSim } from './combatSim';
import { serializeWorld } from './serializedWorld';
import { SimAircraftSpawn } from './simTypes';

/**
 * The AI's airfield phases on the real FM2 airframe, through the worker API
 * the game drives: a takeoff from a standstill on the threshold, and an RTB
 * that has to fly the approach down to the runway and stop.
 *
 * Runs every pilot model, built the way the game builds them: Shaw /
 * Aggressive / Ace hand their non-ENGAGE frames to the classic pilot through
 * setPhase, so a phase that keeps state has to survive that too.
 *
 * What is `todo` is known not to work yet - see docs/ai-takeoff-landing-plan.md:
 * a final joined at a large intercept angle is never captured (no pattern).
 */

const ID = 'ai0';
const HALF_LENGTH = 1500;
const HALF_WIDTH = 30;
/** Where the approach aims: 300 m past the approach threshold. */
const TOUCHDOWN_Z = -HALF_LENGTH + 300;
/**
 * Firmest acceptable touchdown (m/s, ~800 ft/min): firm for a fighter, well
 * inside the 8 m/s the FM2 gear takes before it is damaged. Most landings
 * arrive at ~2.5; with the flare attitude capped short of a tail strike a
 * few come in at 3.5.
 */
const MAX_TOUCHDOWN_SINK = 4;
const MODELS = Object.values(AiPilotModels);

interface Sample {
    pos: THREE.Vector3;
    vel: THREE.Vector3;
    phase: AiFlightPhase;
    landed: boolean;
    crashed: boolean;
}

interface Run {
    phases: AiFlightPhase[];
    /** Sample on entering the last FLARE (an earlier one may have been gone around from). */
    flare: Sample | undefined;
    /** Last sample to arrive on the ground after being airborne: the touchdown that stuck. */
    touchdown: Sample | undefined;
    /** Descent rate (m/s) on the last frame before that touchdown. */
    touchdownSink: number;
    /** Highest nose pitch (deg) in the flare or the second after touchdown. */
    maxFlarePitchDeg: number;
    /** First sample airborne after a ground start. */
    liftoff: Sample | undefined;
    /** Frames the terrain pull-up was engaged on short final (below 60 m AGL). */
    lowPullUpFrames: number;
    /** Frames the terrain pull-up was engaged while flying the pattern (RTB). */
    rtbPullUpFrames: number;
    last: Sample;
}

type SimAircraftInternals = Combatant & {
    pilot: AiPilotController & { classic?: { pullUpActive: boolean }; pullUpActive?: boolean };
    isLanded(): boolean;
    isCrashed(): boolean;
    getQuaternion(): THREE.Quaternion;
};

function sim(runwayY = 0, pads: SurfacePadCollider[] = []): CombatSim {
    const s = new CombatSim();
    s.setWorld(serializeWorld([], [], [{
        center: new THREE.Vector3(0, runwayY, 0),
        heading: 0,
        halfLength: HALF_LENGTH,
        halfWidth: HALF_WIDTH,
    }], [], [], [], pads));
    return s;
}

function add(s: CombatSim, model: AiPilotModels, spawn: SimAircraftSpawn): void {
    s.addAircraft({
        id: ID,
        faction: Faction.ENEMY,
        control: 'ai',
        kinematic: false,
        aircraftConfig: defaultFm2Config,
        pilotOptions: { cruiseAltitude: 3000, cruiseSpeed: 200, hardDeck: 150, model },
        hitRadius: 10,
        maxHealth: 100,
        spawn,
        enabled: true,
    });
}

function internals(s: CombatSim): SimAircraftInternals {
    const a = (s as unknown as { aircraft: Map<string, unknown> }).aircraft.get(ID);
    assert.ok(a, 'no sim aircraft');
    return a as SimAircraftInternals;
}

/** Step until `until` holds or `seconds` run out, recording phase changes and ground contact. */
function fly(s: CombatSim, seconds: number, until: (x: Sample) => boolean, groundY = 0): Run {
    const a = internals(s);
    const classic = a.pilot.classic ?? a.pilot;
    const dt = 1 / 60;
    const run: Run = {
        phases: [], flare: undefined, touchdown: undefined, touchdownSink: 0, maxFlarePitchDeg: -90,
        liftoff: undefined, lowPullUpFrames: 0, rtbPullUpFrames: 0, last: undefined as unknown as Sample,
    };
    let wasLanded = a.isLanded();
    let prevSink = 0;
    let sinceTouchdown = Infinity;
    const nose = new THREE.Vector3();
    for (let i = 0; i < seconds / dt; i++) {
        s.step(dt, {});
        const x: Sample = {
            pos: a.readPosition(new THREE.Vector3()),
            vel: a.readVelocity(new THREE.Vector3()),
            phase: a.pilot.getPhase(),
            landed: a.isLanded(),
            crashed: a.isCrashed(),
        };
        run.last = x;
        if (run.phases[run.phases.length - 1] !== x.phase) {
            run.phases.push(x.phase);
            if (x.phase === AiFlightPhase.FLARE) run.flare = x;
        }
        if (x.phase === AiFlightPhase.APPROACH && x.pos.y - groundY < 60 && classic.pullUpActive) {
            run.lowPullUpFrames++;
        }
        if (x.phase === AiFlightPhase.RTB && classic.pullUpActive) run.rtbPullUpFrames++;
        if (x.landed && !wasLanded && !run.liftoff) {
            run.touchdown = x;
            run.touchdownSink = prevSink;
            sinceTouchdown = 0;
        }
        sinceTouchdown += dt;
        if (x.phase === AiFlightPhase.FLARE || sinceTouchdown < 1) {
            nose.set(0, 0, 1).applyQuaternion(a.getQuaternion());
            run.maxFlarePitchDeg = Math.max(run.maxFlarePitchDeg, Math.asin(nose.y) * 180 / Math.PI);
        }
        prevSink = -x.vel.y;
        if (!x.landed && wasLanded && !run.liftoff) run.liftoff = x;
        wasLanded = x.landed;
        if (x.crashed || until(x)) break;
    }
    return run;
}

const fmt = (v: THREE.Vector3 | undefined): string => v ? v.toArray().map(c => c.toFixed(0)).join(',') : '-';
const describeRun = (run: Run): string =>
    `${run.phases.map(p => AiFlightPhase[p]).join(' > ')}; flare ${fmt(run.flare?.pos)}`
    + `; touchdown ${fmt(run.touchdown?.pos)} sink ${run.touchdownSink.toFixed(1)}`
    + ` flare pitch ${run.maxFlarePitchDeg.toFixed(1)}; end ${fmt(run.last.pos)}`;

/** A straight-in from `range` m before the runway, 1.5-3 km off the extended centreline and pointing up it. */
function straightIn(range: number, y: number, speed: number): SimAircraftSpawn {
    return {
        position: [range > 20000 ? 3000 : 1500, y, -range],
        quaternion: [0, 0, 0, 1],
        velocity: [0, 0, speed],
        landed: false,
        throttle: 0.7,
        airborne: true,
    };
}

/** Airborne at `pos`, flying `speed` m/s on `headingDeg` (0 = +Z, the runway's landing direction). */
function airborne(pos: [number, number, number], headingDeg: number, speed: number): SimAircraftSpawn {
    const h = headingDeg * Math.PI / 180;
    return {
        position: pos,
        quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), h)
            .toArray() as [number, number, number, number],
        velocity: [Math.sin(h) * speed, 0, Math.cos(h) * speed],
        landed: false,
        throttle: 0.7,
        airborne: true,
    };
}

/** Highest flare attitude (deg) accepted: a tail-scrape margin for a fighter on its main gear. */
const MAX_FLARE_PITCH_DEG = 15.5;

/**
 * Assert a run ended stopped on the runway after a touchdown in the zone.
 * `goArounds` is how many it must have flown on the way, exactly.
 */
function assertLanded(run: Run, surfaceY = 0, goArounds = 0): void {
    const info = describeRun(run);
    assert.equal(run.last.crashed, false, `crashed: ${info}`);
    if (goArounds === 0) {
        // Each phase once, in order: none re-entered from the per-frame setPhase.
        assert.deepEqual(run.phases, [
            AiFlightPhase.RTB, AiFlightPhase.APPROACH, AiFlightPhase.FLARE,
            AiFlightPhase.ROLLOUT, AiFlightPhase.GROUND_IDLE,
        ], info);
    } else {
        assert.equal(run.phases.filter(p => p === AiFlightPhase.GO_AROUND).length, goArounds, `go-arounds: ${info}`);
        assert.deepEqual(run.phases.slice(-4), [
            AiFlightPhase.APPROACH, AiFlightPhase.FLARE, AiFlightPhase.ROLLOUT, AiFlightPhase.GROUND_IDLE,
        ], info);
    }
    assert.ok(run.maxFlarePitchDeg < MAX_FLARE_PITCH_DEG, `tail strike attitude: ${info}`);
    // The terrain guard used to pull up (and raise the gear) on every short
    // final. Higher up it may still trip on a final flown low and sinking.
    assert.equal(run.lowPullUpFrames, 0, `terrain pull-up on short final: ${info}`);
    const td = run.touchdown;
    assert.ok(td, `never touched down: ${info}`);
    assert.ok(td.pos.z > TOUCHDOWN_Z - 150 && td.pos.z < TOUCHDOWN_Z + 900,
        `touched down outside the touchdown zone: ${info}`);
    assert.ok(Math.abs(td.pos.x) < HALF_WIDTH, `touched down off the centreline: ${info}`);
    assert.ok(run.touchdownSink < MAX_TOUCHDOWN_SINK, `hard landing: ${info}`);
    assert.ok(Math.abs(run.last.pos.z) < HALF_LENGTH && Math.abs(run.last.pos.x) < HALF_WIDTH,
        `stopped off the runway: ${info}`);
    assert.ok(Math.abs(run.last.pos.y - surfaceY) < 5, `stopped off the runway surface: ${info}`);
}

describe('AI airfield phases', () => {
    for (const model of MODELS) {
        it(`${model}: takes off from the threshold and climbs out`, () => {
            const s = sim();
            add(s, model, {
                position: [0, fm2GroundRestHeight(defaultFm2Config), -HALF_LENGTH + 100],
                quaternion: [0, 0, 0, 1],
                velocity: [0, 0, 0],
                landed: true,
                throttle: 0,
                airborne: false,
            });
            s.setPhase(ID, AiFlightPhase.TAKEOFF_ROLL);
            const run = fly(s, 120, x => x.pos.y > 600);
            const info = describeRun(run);
            assert.equal(run.last.crashed, false, `crashed: ${info}`);
            assert.ok(run.liftoff, `never left the ground: ${info}`);
            assert.ok(run.liftoff.pos.z < HALF_LENGTH, `lifted off past the runway end: ${fmt(run.liftoff.pos)}`);
            assert.ok(Math.abs(run.liftoff.pos.x) < HALF_WIDTH, `lifted off the centreline: ${fmt(run.liftoff.pos)}`);
            assert.ok(run.last.pos.y > 600, `did not climb out: ${info}`);
            assert.deepEqual(run.phases.slice(0, 2), [AiFlightPhase.TAKEOFF_ROLL, AiFlightPhase.CLIMB_OUT], info);
        });

        // Close in, the approach fix is only 5.5 km away and it arrives on
        // final fast: the slowing down happens on the glidepath. From further
        // out it is done before the fix, as intended.
        it(`${model}: lands from a straight-in 15 km out, arriving fast`, () => {
            const s = sim();
            add(s, model, straightIn(15000, 700, 180));
            s.setPhase(ID, AiFlightPhase.RTB);
            assertLanded(fly(s, 400, x => x.phase === AiFlightPhase.GROUND_IDLE));
        });

        it(`${model}: lands from a straight-in 35 km out, slowed before the approach fix`, () => {
            const s = sim();
            add(s, model, straightIn(35000, 1500, 220));
            s.setPhase(ID, AiFlightPhase.RTB);
            assertLanded(fly(s, 500, x => x.phase === AiFlightPhase.GROUND_IDLE));
        });

        // Joining final from anywhere: these used to cross the centreline at
        // right angles and wander off, or never come back at all.
        it(`${model}: captures final from a 90-degree crossing 6 km off the centreline`, () => {
            const s = sim();
            add(s, model, airborne([6000, 1500, -15000], 90, 200));
            s.setPhase(ID, AiFlightPhase.RTB);
            assertLanded(fly(s, 700, x => x.phase === AiFlightPhase.GROUND_IDLE));
        });

        it(`${model}: comes round from beyond the far end, flying away from the runway`, () => {
            const s = sim();
            add(s, model, airborne([-2000, 1200, 8000], 0, 200));
            s.setPhase(ID, AiFlightPhase.RTB);
            assertLanded(fly(s, 900, x => x.phase === AiFlightPhase.GROUND_IDLE));
        });

        it(`${model}: comes round from overhead the runway, heading the wrong way`, () => {
            const s = sim();
            add(s, model, airborne([0, 1000, 0], 180, 180));
            s.setPhase(ID, AiFlightPhase.RTB);
            assertLanded(fly(s, 900, x => x.phase === AiFlightPhase.GROUND_IDLE));
        });

        // Put on final in a state no pilot would land from, it has to go
        // round and come back for a second, stable approach.
        it(`${model}: goes around from an unstable final and lands on the second approach`, () => {
            const s = sim();
            // 3 km out, 200 m above the glidepath, clean and 70 m/s fast.
            add(s, model, airborne([0, 350, -4500], 0, 155));
            s.setPhase(ID, AiFlightPhase.APPROACH);
            const run = fly(s, 900, x => x.phase === AiFlightPhase.GROUND_IDLE);
            run.phases.unshift(AiFlightPhase.RTB);
            assertLanded(run, 0, 1);
        });
    }

    it('aims the glidepath at the runway, not the ground under the approach', () => {
        // The runway on a 300 m mesa over flat ground. A glidepath measured
        // from the ground under the aircraft arrives 300 m low, at the cliff.
        const top = 300;
        const s = sim(top, [{
            centerX: 0, centerZ: 0, heading: 0,
            halfLength: HALF_LENGTH + 100, halfWidth: 200,
            surfaceY: top, baseY: 0, feather: 150,
        }]);
        add(s, AiPilotModels.CLASSIC, straightIn(15000, 1000, 180));
        s.setPhase(ID, AiFlightPhase.RTB);
        const run = fly(s, 400, x => x.phase === AiFlightPhase.GROUND_IDLE, top);
        assert.ok(run.flare, `never reached the flare: ${describeRun(run)}`);
        assert.ok(run.flare.pos.y > top && run.flare.pos.y < top + 30, `flare not at the runway's height: ${describeRun(run)}`);
        assertLanded(run, top + fm2GroundRestHeight(defaultFm2Config));
    });

    /**
     * A scripted lead on the runway, as the game mirrors the player: parked
     * for `waitS`, then rolling down the centreline at 3 m/s^2, airborne at
     * 85 m/s, climbing out at 10 m/s on the runway heading.
     */
    function scriptedLead(s: CombatSim, id: string, waitS: number) {
        const pos = new THREE.Vector3(0, fm2GroundRestHeight(defaultFm2Config), -HALF_LENGTH + 100);
        const vel = new THREE.Vector3();
        let t = 0;
        return (dt: number): void => {
            t += dt;
            if (t > waitS) {
                const speed = Math.min(200, vel.z + 3 * dt);
                vel.set(0, speed > 85 ? 10 : 0, speed);
            }
            pos.addScaledVector(vel, dt);
            s.setExternalState(id, true, Faction.PLAYER, pos, vel, true);
        };
    }

    for (const model of MODELS) {
        it(`${model}: a wingman parked behind the lead waits, then scrambles beside it and joins up`, () => {
            const s = sim();
            const lead = scriptedLead(s, 'lead', 10);
            lead(0);
            // 150 m behind the lead and 12 m to the side, facing down the runway.
            s.addAircraft({
                id: ID, faction: Faction.PLAYER, control: 'ai', kinematic: false,
                aircraftConfig: defaultFm2Config,
                pilotOptions: { cruiseAltitude: 3000, cruiseSpeed: 200, hardDeck: 150, model },
                hitRadius: 10, maxHealth: 100, enabled: true,
                spawn: {
                    position: [12, fm2GroundRestHeight(defaultFm2Config), -HALF_LENGTH + 100 - 150],
                    quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], landed: true, throttle: 0, airborne: false,
                },
            });
            s.setFormationLead(ID, 'lead');
            s.setPhase(ID, AiFlightPhase.GROUND_IDLE);
            const a = internals(s);
            const p = new THREE.Vector3();
            const phases: AiFlightPhase[] = [];
            let liftoffX = NaN;
            for (let i = 0; i < 150 * 60; i++) {
                lead(1 / 60);
                s.step(1 / 60, {});
                const ph = a.pilot.getPhase();
                if (phases[phases.length - 1] !== ph) phases.push(ph);
                a.readPosition(p);
                if (i === 9 * 60) {
                    assert.equal(ph, AiFlightPhase.GROUND_IDLE, 'rolled before the lead did');
                }
                if (Number.isNaN(liftoffX) && !a.isLanded() && ph === AiFlightPhase.TAKEOFF_ROLL) liftoffX = p.x;
                if (ph === AiFlightPhase.FORMATION || a.isCrashed()) break;
            }
            const info = `${phases.map(x => AiFlightPhase[x]).join(' > ')}; end ${fmt(p)}`;
            assert.equal(a.isCrashed(), false, `crashed: ${info}`);
            assert.deepEqual(phases, [
                AiFlightPhase.GROUND_IDLE, AiFlightPhase.TAKEOFF_ROLL, AiFlightPhase.CLIMB_OUT, AiFlightPhase.FORMATION,
            ], info);
            assert.ok(Math.abs(liftoffX - 12) < 6, `left its line on the roll: lifted off at x=${liftoffX.toFixed(1)}`);
        });

        it(`${model}: an opponent takes off and goes straight for its target after climb-out`, () => {
            const s = sim();
            s.setExternalState('bandit', true, Faction.PLAYER,
                new THREE.Vector3(0, 3000, 20000), new THREE.Vector3(0, 0, -200), true);
            add(s, model, {
                position: [0, fm2GroundRestHeight(defaultFm2Config), -HALF_LENGTH + 100],
                quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], landed: true, throttle: 0, airborne: false,
            });
            s.setTarget(ID, 'bandit');
            s.setPhase(ID, AiFlightPhase.TAKEOFF_ROLL);
            const run = fly(s, 120, x => x.phase === AiFlightPhase.ENGAGE);
            const info = describeRun(run);
            assert.equal(run.last.crashed, false, `crashed: ${info}`);
            assert.deepEqual(run.phases, [AiFlightPhase.TAKEOFF_ROLL, AiFlightPhase.CLIMB_OUT, AiFlightPhase.ENGAGE], info);
            assert.ok(run.last.pos.y < 1500, `climbed to patrol height before engaging: ${info}`);
        });
    }

    it('takes off along its own runway when a parallel one has the nearer centre', () => {
        // GCLP's 03L/03R: a parallel runway 200 m off. Its own runway is well
        // away from the origin and the parallel one is on it: a pilot lining
        // up from a stale picture of where it is (a fresh one starts at the
        // origin) picks the wrong one.
        const s = new CombatSim();
        s.setWorld(serializeWorld([], [], [
            { center: new THREE.Vector3(0, 0, 3000), heading: 0, halfLength: HALF_LENGTH, halfWidth: HALF_WIDTH },
            { center: new THREE.Vector3(200, 0, 0), heading: 0, halfLength: HALF_LENGTH, halfWidth: HALF_WIDTH },
        ], [], [], []));
        add(s, AiPilotModels.CLASSIC, {
            position: [0, fm2GroundRestHeight(defaultFm2Config), 3000 - HALF_LENGTH + 100],
            quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], landed: true, throttle: 0, airborne: false,
        });
        s.setPhase(ID, AiFlightPhase.TAKEOFF_ROLL);
        s.step(1 / 60, {});
        // The runway it lined up on is its own (its tyres steer too little in
        // this sim to show the difference in the ground track before liftoff).
        const choice = (internals(s).pilot as unknown as { runwayChoice?: { center: THREE.Vector3 } }).runwayChoice;
        assert.equal(choice?.center.z, 3000, 'lined up on the parallel runway');
        const run = fly(s, 120, x => x.pos.y > 300);
        const info = describeRun(run);
        assert.equal(run.last.crashed, false, `crashed: ${info}`);
        assert.ok(run.liftoff, `never left the ground: ${info}`);
        assert.ok(Math.abs(run.liftoff.pos.x) < HALF_WIDTH, `steered off its runway: lifted off at ${fmt(run.liftoff.pos)}`);
    });

    it('takes off over the home base ski jump 400 m down the runway, flying when it gets there', () => {
        // Where the game puts it: 400 m past the runway start, as wide as the
        // runway, at GCXO's 630 m. At its old 90 m a standing start reached it
        // at ~40 m/s, far under flying speed, and in the game was thrown off it
        // into the ground.
        const ahead = 400;
        const start = -HALF_LENGTH + 120;
        const elevation = 630;
        const s = new CombatSim();
        s.setWorld(serializeWorld([], [], [{
            center: new THREE.Vector3(0, elevation, 0), heading: 0, halfLength: HALF_LENGTH, halfWidth: HALF_WIDTH,
        }], [createSkiJumpCollider(0, elevation, start + ahead, 0)], [], [], [{
            centerX: 0, centerZ: 0, heading: 0, halfLength: 6000, halfWidth: 6000,
            surfaceY: elevation, baseY: 0, feather: 100,
        }]));
        add(s, AiPilotModels.CLASSIC, {
            position: [0, elevation + fm2GroundRestHeight(defaultFm2Config), start],
            quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], landed: true, throttle: 0, airborne: false,
        });
        s.setPhase(ID, AiFlightPhase.TAKEOFF_ROLL);
        let rampSpeed = NaN;
        const run = fly(s, 120, x => {
            if (Number.isNaN(rampSpeed) && x.pos.z > start + ahead) rampSpeed = x.vel.length();
            return x.pos.y > elevation + 400;
        }, elevation);
        const info = describeRun(run);
        assert.equal(run.last.crashed, false, `crashed: ${info}`);
        assert.ok(rampSpeed > defaultFm2Config.envelope.minFlyingSpeedMps,
            `reached the ramp at ${rampSpeed.toFixed(0)} m/s, under flying speed`);
        assert.ok(run.last.pos.y > elevation + 400, `did not climb out: ${info}`);
    });

    it('rolls a standing start up a T2-sized ramp and flies off its lip', () => {
        // Saki's T2 as the bake places it: 114 m of run-up, then a ramp 59 m
        // long rising 8 m, the start inset the game uses on a run this short.
        const runUp = 114;
        const ramp = createSkiJumpCollider(0, 0, runUp, 0, 59, 8, 27);
        const s = new CombatSim();
        s.setWorld(serializeWorld([], [], [{
            center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: HALF_LENGTH, halfWidth: HALF_WIDTH,
        }], [ramp], [], [], [{
            centerX: 0, centerZ: 0, heading: 0, halfLength: 6000, halfWidth: 6000,
            surfaceY: 0, baseY: -100, feather: 100,
        }]));
        add(s, AiPilotModels.CLASSIC, {
            position: [0, fm2GroundRestHeight(defaultFm2Config), 0],
            quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], landed: true, throttle: 0, airborne: false,
        });
        s.setPhase(ID, AiFlightPhase.TAKEOFF_ROLL);
        let atLip: Sample | undefined;
        let lowestAfter = Infinity;
        let framesAfter = 0;
        const run = fly(s, 40, x => {
            if (!atLip && x.pos.z > runUp + 58) atLip = x;
            if (atLip && x.pos.z > runUp + 60) {
                lowestAfter = Math.min(lowestAfter, x.pos.y);
                framesAfter++;
            }
            return framesAfter > 600;
        });
        const info = describeRun(run);
        assert.equal(run.last.crashed, false, `crashed on the ramp: ${info}`);
        assert.ok(atLip, `never reached the lip: ${info}`);
        // Up the ramp, not through it: the gear rode the deck to its 8 m lip.
        assert.ok(atLip.pos.y > 7, `at the lip only ${atLip.pos.y.toFixed(1)} m up`);
        // Off the lip at ~49 m/s and still flying ten seconds on, never back
        // down to the ground it left.
        assert.ok(lowestAfter > 5, `sank to ${lowestAfter.toFixed(1)} m after the lip: ${info}`);
        assert.ok(run.last.pos.y > 100, `not climbing out: ${info}`);
    });

    it('lands beyond something standing on the runway at the usual aim point', () => {
        // Gran Canaria's 12 m ski jump sits on the centreline right where the
        // approach used to aim; every autopilot landing was launched off it.
        const s = sim(0, [{
            centerX: 0, centerZ: TOUCHDOWN_Z - 30, heading: 0,
            halfLength: 35, halfWidth: 12, surfaceY: 12, baseY: 0, feather: 30,
        }]);
        add(s, AiPilotModels.CLASSIC, straightIn(35000, 1500, 220));
        s.setPhase(ID, AiFlightPhase.RTB);
        const run = fly(s, 600, x => x.phase === AiFlightPhase.GROUND_IDLE);
        const info = describeRun(run);
        assert.equal(run.last.crashed, false, `crashed: ${info}`);
        assert.deepEqual(run.phases, [
            AiFlightPhase.RTB, AiFlightPhase.APPROACH, AiFlightPhase.FLARE,
            AiFlightPhase.ROLLOUT, AiFlightPhase.GROUND_IDLE,
        ], info);
        assert.ok(run.touchdown && run.touchdown.pos.z > TOUCHDOWN_Z + 100, `touched down at the obstruction: ${info}`);
        assert.ok(run.touchdownSink < MAX_TOUCHDOWN_SINK, `hard landing: ${info}`);
        assert.ok(Math.abs(run.last.pos.z) < HALF_LENGTH && Math.abs(run.last.pos.x) < HALF_WIDTH,
            `stopped off the runway: ${info}`);
    });

    // Mountains: GCXO sits at 630 m among hills to ~1000 m, and the pattern
    // flown at the glidepath's join height (~420 m over the threshold) left
    // the terrain guard pulling up wings-level for ten minutes on downwind.
    it('flies the pattern clear of a ridge beside the runway', () => {
        // An 800 m ridge on the side the aircraft comes from, where its
        // downwind and base turn would go: 2.5-6.5 km off the centreline,
        // from beyond the runway to 30 km out.
        const s = sim(0, [{
            centerX: 4500, centerZ: -13500, heading: 0, halfLength: 16500, halfWidth: 2000,
            surfaceY: 800, baseY: 0, feather: 500,
        }]);
        add(s, AiPilotModels.CLASSIC, airborne([6000, 1500, -15000], 90, 200));
        s.setPhase(ID, AiFlightPhase.RTB);
        const run = fly(s, 900, x => x.phase === AiFlightPhase.GROUND_IDLE);
        assert.equal(run.rtbPullUpFrames, 0, `terrain pull-ups in the pattern: ${describeRun(run)}`);
        assertLanded(run);
    });

    it('crosses a ridge under the final high, then descends onto the glidepath', () => {
        // A 600 m ridge across the extended centreline 9-15 km out, where the
        // glidepath is only 420-700 m up: the approach has to come in over it
        // and get down from there.
        const s = sim(0, [{
            centerX: 0, centerZ: -13000, heading: 0, halfLength: 3000, halfWidth: 6000,
            surfaceY: 600, baseY: 0, feather: 400,
        }]);
        add(s, AiPilotModels.CLASSIC, straightIn(35000, 1500, 220));
        s.setPhase(ID, AiFlightPhase.RTB);
        const run = fly(s, 900, x => x.phase === AiFlightPhase.GROUND_IDLE);
        assert.equal(run.rtbPullUpFrames, 0, `terrain pull-ups in the pattern: ${describeRun(run)}`);
        assertLanded(run);
    });

    it('diverts to the other runway when this one has used up its go-arounds', () => {
        const otherX = 30000;
        const s = new CombatSim();
        s.setWorld(serializeWorld([], [], [
            { center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: HALF_LENGTH, halfWidth: HALF_WIDTH },
            { center: new THREE.Vector3(otherX, 0, 0), heading: 0, halfLength: HALF_LENGTH, halfWidth: HALF_WIDTH },
        ], [], [], []));
        add(s, AiPilotModels.CLASSIC, airborne([0, 350, -4500], 0, 155));
        s.setPhase(ID, AiFlightPhase.APPROACH);
        // One go-around already flown here: the unstable final makes the second.
        const classic = (internals(s).pilot as unknown as { goArounds: number });
        classic.goArounds = 1;
        const run = fly(s, 900, x => x.phase === AiFlightPhase.GROUND_IDLE);
        const info = describeRun(run);
        assert.equal(run.last.crashed, false, `crashed: ${info}`);
        assert.equal(run.phases.filter(p => p === AiFlightPhase.GO_AROUND).length, 1, info);
        assert.equal(run.last.phase, AiFlightPhase.GROUND_IDLE, `did not land: ${info}`);
        assert.ok(Math.abs(run.last.pos.x - otherX) < HALF_WIDTH && Math.abs(run.last.pos.z) < HALF_LENGTH,
            `did not stop on the other runway: ${info}`);
    });
});

/**
 * Flight-model traces (workstream F): FM2 and FM3 stepped at the model's fixed
 * 1/120 s from scripted initial states and piecewise-constant control inputs.
 *
 * The C# port runs the same script and compares the sampled state. FM3 (closed
 * form, Float64) is the tight numeric reference; FM2 is deterministic too but
 * its tolerance should be set per scenario because small differences grow
 * through the stall and ground-contact scenarios.
 */
import * as THREE from 'three';
import { defaultFm2Config, fm2GroundRestHeight } from '../../../src/script/physics/fm2/fm2AircraftConfig';
import { F16_AIRFRAME } from '../../../src/script/physics/fm3/f16Airframe';
import { Fm2FlightModel } from '../../../src/script/physics/model/fm2FlightModel';
import { Fm3FlightModel } from '../../../src/script/physics/model/fm3FlightModel';
import type { FlightModel } from '../../../src/script/physics/model/flightModel';
import { FcsPitchLimiter } from '../../../src/script/physics/fm2/fcs';
import { SuiteOutput } from '../lib';

const DT = 1 / 120;
const RAD = Math.PI / 180;

type ModelKind = 'FM2' | 'FM3';

/** Everything the script can set; omitted fields keep their previous value. */
interface Controls {
    pitch?: number;
    roll?: number;
    yaw?: number;
    throttle?: number;
    gear?: boolean;
    flaps?: boolean;
    airbrakes?: boolean;
    wheelBrakes?: boolean;
    limiters?: boolean;
    pitchLimiter?: FcsPitchLimiter;
}

interface Initial {
    altitude: number;
    /** Metres per second along +Z (the nose). */
    speed: number;
    /** Sink rate in m/s (positive down), applied to velocity.y. */
    sink?: number;
    /** Nose-up pitch attitude about the body X axis, degrees (sim +X is port: nose up is a negative rotation). */
    pitchDeg?: number;
    /** Flight-path angle above the horizon, degrees. */
    gammaDeg?: number;
    gear: boolean;
    flaps?: boolean;
    throttle: number;
    limiters?: boolean;
    /** Start on the ground at rest height rather than airborne. */
    onGround?: boolean;
    /** Altitude above ground rest height; with onGround false and gear false/true this is the touchdown test height. */
    aboveRest?: number;
}

interface Scenario {
    name: string;
    model: ModelKind;
    description: string;
    initial: Initial;
    /** Input changes at a simulation time (seconds). */
    script: Array<{ t: number; set: Controls }>;
    duration: number;
}

/**
 * Not here, on purpose: gear-up belly landings. An isolated flight model has no
 * belly support (it falls through the ground within about a second); that
 * contact is the combat sim's solid-world response, so it belongs in the
 * world/collision fixtures (workstream G).
 */
const SCENARIOS: Scenario[] = [];

for (const model of ['FM2', 'FM3'] as ModelKind[]) {
    const p = model.toLowerCase();
    SCENARIOS.push(
        {
            name: `${p}_cruise`, model, description: 'Neutral stick cruise',
            initial: { altitude: 3000, speed: 250, gear: false, throttle: 0.6 },
            script: [], duration: 10,
        },
        {
            name: `${p}_roll`, model, description: 'Full roll for 3 s, then neutral',
            initial: { altitude: 4000, speed: 260, gear: false, throttle: 0.7 },
            script: [{ t: 0.5, set: { roll: 1 } }, { t: 3.5, set: { roll: 0 } }], duration: 7,
        },
        {
            name: `${p}_pitch_pull`, model, description: 'Half aft stick for 2 s, then neutral',
            initial: { altitude: 5000, speed: 240, gear: false, throttle: 0.7 },
            script: [{ t: 0.5, set: { pitch: 0.5 } }, { t: 2.5, set: { pitch: 0 } }], duration: 7,
        },
        {
            name: `${p}_yaw`, model, description: 'Rudder pedal for 2 s',
            initial: { altitude: 4000, speed: 200, gear: false, throttle: 0.5 },
            script: [{ t: 0.5, set: { yaw: 1 } }, { t: 2.5, set: { yaw: 0 } }], duration: 6,
        },
        {
            name: `${p}_configure`, model, description: 'Gear and flaps down, then airbrakes',
            initial: { altitude: 1500, speed: 120, gear: false, throttle: 0.5 },
            script: [{ t: 1, set: { gear: true, flaps: true } }, { t: 4, set: { airbrakes: true } }], duration: 9,
        },
        {
            name: `${p}_full_pull_limiters_off`, model, description: 'Full aft stick with the FCS limiters off',
            initial: { altitude: 6000, speed: 220, gear: false, throttle: 0.8, limiters: false },
            script: [{ t: 0.5, set: { pitch: 1 } }, { t: 4, set: { pitch: 0 } }], duration: 9,
        },
        {
            name: `${p}_stall_idle`, model, description: 'Idle throttle, full back stick, limiters off, from 150 m/s',
            initial: { altitude: 6000, speed: 150, gear: false, throttle: 0, limiters: false },
            script: [{ t: 0.2, set: { pitch: 1 } }], duration: 10,
        },
        {
            name: `${p}_ground_idle`, model, description: 'At rest on the runway at idle',
            initial: { altitude: 0, speed: 0, gear: true, throttle: 0, onGround: true },
            script: [], duration: 5,
        },
        {
            name: `${p}_takeoff_roll`, model, description: 'Full power, takeoff flaps, rotate at 5 s',
            initial: { altitude: 0, speed: 0, gear: true, flaps: true, throttle: 1, onGround: true },
            script: [{ t: 5, set: { pitch: 0.6 } }], duration: 16,
        },
        {
            name: `${p}_touchdown_normal`, model, description: 'Gear-down touchdown, 3 m/s sink at 70 m/s',
            initial: { altitude: 0, speed: 70, sink: 3, gear: true, throttle: 0, aboveRest: 0.2 },
            script: [], duration: 6,
        },
        {
            name: `${p}_touchdown_hard`, model, description: 'Gear-down touchdown, 11 m/s sink at 70 m/s (survivable)',
            initial: { altitude: 0, speed: 70, sink: 11, gear: true, throttle: 0, aboveRest: 0.2 },
            script: [], duration: 6,
        },
        {
            name: `${p}_touchdown_fatal`, model, description: 'Gear-down touchdown, 25 m/s sink (fatal)',
            initial: { altitude: 0, speed: 70, sink: 25, gear: true, throttle: 0, aboveRest: 0.2 },
            script: [], duration: 4,
        },
    );
}

// Post-stall FM3 only: deep alpha entry as in the NASA TP-1538 scenarios.
SCENARIOS.push(
    {
        name: 'fm3_alpha25_limiters_off', model: 'FM3', description: 'Entered at 25 degrees alpha, 120 m/s, limiters off',
        initial: { altitude: 6000, speed: 120, pitchDeg: 25, gear: false, throttle: 0.8, limiters: false },
        script: [], duration: 10,
    },
    {
        name: 'fm3_roll_post_stall', model: 'FM3', description: 'Full roll at 18 degrees alpha with limiters off',
        initial: { altitude: 6000, speed: 130, pitchDeg: 18, gear: false, throttle: 0.7, limiters: false },
        script: [{ t: 1, set: { roll: 1 } }, { t: 4, set: { roll: 0 } }], duration: 8,
    },
);

function build(kind: ModelKind): FlightModel {
    return kind === 'FM2' ? new Fm2FlightModel() : new Fm3FlightModel();
}

function applyControls(m: FlightModel, c: Controls): void {
    if (c.pitch !== undefined) m.setPitch(c.pitch);
    if (c.roll !== undefined) m.setRoll(c.roll);
    if (c.yaw !== undefined) m.setYaw(c.yaw);
    if (c.throttle !== undefined) m.setThrottle(c.throttle);
    if (c.gear !== undefined) m.setLandingGearDeployed(c.gear);
    if (c.flaps !== undefined) m.setFlapsExtended(c.flaps);
    if (c.airbrakes !== undefined) m.setAirbrakesExtended(c.airbrakes);
    if (c.wheelBrakes !== undefined) m.setWheelBrakes(c.wheelBrakes);
    if (c.limiters !== undefined) m.setLimitersEnabled(c.limiters);
    if (c.pitchLimiter !== undefined) m.setPitchLimiterMode(c.pitchLimiter);
}

function initialise(m: FlightModel, init: Initial): void {
    const rest = fm2GroundRestHeight(defaultFm2Config);
    m.reset();
    const y = init.onGround ? rest : init.aboveRest !== undefined ? rest + init.aboveRest : init.altitude;
    m.position.set(0, y, 0);
    m.quaternion.identity();
    const pitch = (init.pitchDeg ?? 0) * RAD;
    if (pitch !== 0) {
        m.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitch);
    }
    const gamma = (init.gammaDeg ?? 0) * RAD;
    m.velocityVector = new THREE.Vector3(0, init.speed * Math.sin(gamma) - (init.sink ?? 0), init.speed * Math.cos(gamma));
    m.setLanded(!!init.onGround);
    m.setLandingGearDeployed(init.gear);
    m.setFlapsExtended(!!init.flaps);
    m.setThrottle(init.throttle);
    if (init.limiters !== undefined) m.setLimitersEnabled(init.limiters);
    m.syncEffectiveThrottle();
    m.snapPhysicsState();
}

function runScenario(s: Scenario, sampleEvery: number): unknown {
    const m = build(s.model);
    initialise(m, s.initial);
    const steps = Math.round(s.duration / DT);
    const script = [...s.script].sort((a, b) => a.t - b.t);
    let next = 0;
    let maxHard = 0;
    const samples: unknown[] = [];

    const sample = (step: number): void => {
        const q = m.quaternion, p = m.position, v = m.velocityVector;
        samples.push({
            step,
            t: step * DT,
            position: [p.x, p.y, p.z],
            quaternion: [q.x, q.y, q.z, q.w],
            velocity: [v.x, v.y, v.z],
            aoa: m.getAngleOfAttack(),
            loadFactorG: m.getLoadFactorG(),
            throttleEffective: m.getEffectiveThrottle(),
            thrustKn: m.getEngineThrustKn(),
            elevator: m.getCommandedElevator(),
            aileron: m.getCommandedAileron(),
            rudder: m.getCommandedRudder(),
            gearCompressionMean: m.getGearCompressionMean(),
            landed: m.isLanded(),
            crashed: m.isCrashed(),
        });
    };

    sample(0);
    for (let step = 1; step <= steps; step++) {
        const t = (step - 1) * DT;
        while (next < script.length && script[next].t <= t + 1e-9) {
            applyControls(m, script[next].set);
            next++;
        }
        m.update(DT);
        maxHard = Math.max(maxHard, m.consumeHardLanding());
        if (step % sampleEvery === 0 || step === steps) sample(step);
    }

    const p = m.position;
    return {
        name: s.name,
        model: s.model,
        description: s.description,
        initial: s.initial,
        script: s.script,
        duration: s.duration,
        dt: DT,
        steps,
        sampleEveryStep: sampleEvery,
        summary: {
            finalPosition: [p.x, p.y, p.z],
            finalSpeed: m.velocityVector.length(),
            crashed: m.isCrashed(),
            landed: m.isLanded(),
            maxHardLandingFraction: maxHard,
        },
        samples,
    };
}

export function flightModelsSuite(): SuiteOutput {
    const sampleEvery = 6; // 20 Hz
    const traces = SCENARIOS.map(s => runScenario(s, sampleEvery));

    // The configs the models were built from, so the C# side deserialises the same numbers.
    const configs = {
        defaultFm2Config,
        f16Airframe: F16_AIRFRAME,
        fm2GroundRestHeight: fm2GroundRestHeight(defaultFm2Config),
    };

    return {
        files: [
            {
                file: 'flight_models.json',
                data: {
                    suite: 'flight_models',
                    version: 1,
                    source: 'src/script/physics/model/{fm2,fm3}FlightModel.ts',
                    notes: [
                        'Scene axes (x east, y up, z south); aircraft body +Z forward, +Y up, +X PORT.',
                        'Each trace is stepped with update(1/120) once per step; controls are applied before the step whose start time reaches `t`.',
                        'Initial state: position (0, y, 0), identity quaternion (or nose-up pitchDeg about -X), velocity along +Z, then snapPhysicsState().',
                        'World: the model default (flat ground at y = 0, no pads). Gear contact only; no belly/solid-world response.',
                        'Models reset with flaps EXTENDED; scenarios set flaps explicitly (initial.flaps, default false).',
                        'FM3 is the numeric reference; FM2 band-tests are in the original test suite.',
                    ],
                    tolerances: {
                        fm3Position: 1e-6, fm3Velocity: 1e-6, fm3Quaternion: 1e-9,
                        fm2Position: 1e-3, fm2Velocity: 1e-3, fm2Quaternion: 1e-6,
                    },
                    traces,
                },
            },
            {
                file: 'flight_configs.json',
                data: { suite: 'flight_configs', version: 1, source: 'src/script/physics/fm2/fm2AircraftConfig.ts, src/script/physics/fm3/f16Airframe.ts', configs },
            },
        ],
    };
}


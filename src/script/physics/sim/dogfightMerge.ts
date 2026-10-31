import * as THREE from 'three';
import { AiFlightPhase, AiPilotOptions, AiSkillLevel } from '../../ai/aiPilot';
import { AiPilotController } from '../../ai/aiPilotController';
import { PilotableAircraft } from '../../ai/aircraftControls';
import { WorldQuery } from '../../ai/worldQuery';
import { Faction } from '../../weapons/combatant';
import { AiPilotModels } from '../../state/gameDefs';
import { defaultFm2Config, Fm2AircraftConfig } from '../fm2/fm2AircraftConfig';
import { CombatSim } from './combatSim';
import { serializeWorld } from './serializedWorld';
import { SimGunConfig } from './simTypes';

/**
 * A two-aircraft merge flown entirely by AI pilots on the real flight model,
 * headless: the bench the dogfight AI is tuned against. Both sides are
 * symmetric `CombatSim` aircraft that target each other, so whatever happens
 * is the pilots' doing, not the airframe's.
 */

/** Side ids. Blue is Faction.PLAYER, red Faction.ENEMY (the projectile pool's friend/foe test). */
export const MERGE_BLUE = 'blue';
export const MERGE_RED = 'red';

/** The game's gun (game.ts PLAYER_GUN), so hits mean what they mean in play. */
const MERGE_GUN: SimGunConfig = {
    muzzleVelocity: 1000,
    roundsPerSecond: 20,
    damage: 8,
    ammo: 2400,
    muzzleOffset: [0, 0, 9],
    spread: 0.003,
};

/** Merge geometry. Blue starts at the origin heading +Z; red is placed relative to it. */
export interface MergeSetup {
    name: string;
    /** Blue's altitude (m, flat ground at 0). */
    altitude: number;
    /** Red's position relative to blue: ahead along +Z, lateral along +X, up. */
    ahead: number;
    lateral: number;
    up: number;
    /** Red's heading in radians; π is a head-on pass. Blue always heads 0 (+Z). */
    redHeading: number;
    blueSpeed: number;
    redSpeed: number;
}

/** The game's own head-on merge: 3 km nose to nose, co-altitude, same speed. */
export const GAME_HEADON: MergeSetup = {
    name: 'head-on', altitude: 1500, ahead: 3000, lateral: 0, up: 0,
    redHeading: Math.PI, blueSpeed: 200, redSpeed: 200,
};

/** A spread of merges: the game's, then offset, stacked, mismatched and crossing ones. */
export const MERGE_SETUPS: readonly MergeSetup[] = [
    GAME_HEADON,
    { ...GAME_HEADON, name: 'offset 600 m', lateral: 600 },
    { ...GAME_HEADON, name: 'red 600 m high', up: 600 },
    { ...GAME_HEADON, name: 'red fast', redSpeed: 250, blueSpeed: 170 },
    { ...GAME_HEADON, name: 'beam', ahead: 2500, lateral: 2500, redHeading: -Math.PI / 2 },
    { ...GAME_HEADON, name: 'low', altitude: 600 },
    { ...GAME_HEADON, name: 'offset 1500 m', lateral: -1500 },
    { ...GAME_HEADON, name: 'red 1000 m low', up: -1000, altitude: 2500 },
    { ...GAME_HEADON, name: 'slow', blueSpeed: 140, redSpeed: 140 },
    { ...GAME_HEADON, name: 'high', altitude: 6000 },
    { ...GAME_HEADON, name: 'oblique', ahead: 3000, lateral: -1500, redHeading: Math.PI * 0.75 },
    { ...GAME_HEADON, name: 'tail chase', ahead: 1500, redHeading: 0 },
];

export interface MergeSide {
    model: AiPilotModels;
    skill?: AiSkillLevel;
    /** Overrides on top of the game's opponent options. */
    options?: AiPilotOptions;
    aircraftConfig?: Fm2AircraftConfig;
    /** Build the pilot here instead of through createAiPilot (e.g. a frozen older version to fight). */
    pilot?: (aircraft: PilotableAircraft, world: WorldQuery, options: AiPilotOptions) => AiPilotController;
}

/** What one side did in the fight. */
export interface MergeSideResult {
    /** Killed by the other side's guns. */
    shotDown: boolean;
    /** Flew into the ground, not shot down. */
    crashed: boolean;
    /** Lost to a collision with the other aircraft. */
    midair: boolean;
    /** Seconds into the fight it was lost, or undefined if it survived. */
    lostAt?: number;
    hitsScored: number;
    roundsFired: number;
    /** Seconds this side had the other within 45° of its nose and inside 1.5 km. */
    noseOnS: number;
    /** Seconds this side sat in the other's rear 60° cone inside 2 km (a real offensive position). */
    offensiveS: number;
    /** Seconds the other side sat in its rear cone (it was defensive). */
    defensiveS: number;
    /** First time it fired, if it did. */
    firstShotAt?: number;
    minAltitude: number;
    minSpeed: number;
    /** Seconds spent below 90 m/s (slow, near the stall). */
    slowS: number;
    /** Seconds per maneuver label, to see what the pilot actually did. */
    labels: Record<string, number>;
}

export interface MergeResult {
    setup: string;
    blue: MergeSideResult;
    red: MergeSideResult;
    /** 'blue' | 'red' | 'draw' (both alive at the end, or both lost). */
    winner: 'blue' | 'red' | 'draw';
    duration: number;
    /** Closest approach between the two (m). */
    minRange: number;
    trace?: MergeTraceSample[];
}

export interface MergeTraceSample {
    t: number;
    blue: [number, number, number];
    red: [number, number, number];
    blueLabel: string;
    redLabel: string;
    blueSpeed: number;
    redSpeed: number;
    range: number;
}

export interface MergeRunOptions {
    /** Fight length cap (s). */
    seconds?: number;
    dt?: number;
    /** Record a trace sample every this many seconds (0 = off). */
    traceEvery?: number;
}

/** The game's opponent pilot options (game.ts opponentPilotOptions). */
function sideOptions(side: MergeSide): AiPilotOptions {
    return {
        cruiseAltitude: 1000,
        cruiseSpeed: 160,
        combatSpeed: 180,
        gunRange: 900,
        hardDeck: 200,
        alwaysEngage: side.model === AiPilotModels.CLASSIC,
        skill: side.skill ?? AiSkillLevel.ACE,
        model: side.model,
        ...side.options,
    };
}

type SimAircraftView = {
    health: number;
    firing: boolean;
    model: { isCrashed(): boolean; position: THREE.Vector3; velocityVector: THREE.Vector3 };
    pilot?: { getManeuverLabel(): string };
};

function emptySide(): MergeSideResult {
    return {
        shotDown: false, crashed: false, midair: false, hitsScored: 0, roundsFired: 0,
        noseOnS: 0, offensiveS: 0, defensiveS: 0,
        minAltitude: Infinity, minSpeed: Infinity, slowS: 0, labels: {},
    };
}

function headingQuat(heading: number): [number, number, number, number] {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    return [q.x, q.y, q.z, q.w];
}

/** Angle (rad) between `dir` and the line from `from` to `to`. */
function angleTo(dir: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3, tmp: THREE.Vector3): number {
    tmp.copy(to).sub(from);
    const d = tmp.length() * dir.length();
    return d > 1e-6 ? Math.acos(THREE.MathUtils.clamp(tmp.dot(dir) / d, -1, 1)) : 0;
}

/** Fly one merge to a kill, a crash, or the time cap. */
export function runMerge(setup: MergeSetup, blue: MergeSide, red: MergeSide, opts: MergeRunOptions = {}): MergeResult {
    const seconds = opts.seconds ?? 180;
    const dt = opts.dt ?? 1 / 60;
    const sim = new CombatSim();
    sim.setWorld(serializeWorld([], [], [{
        center: new THREE.Vector3(0, 0, -20000), heading: 0, halfLength: 1500, halfWidth: 30,
    }]));

    const add = (id: string, faction: Faction, side: MergeSide, pos: THREE.Vector3, heading: number, speed: number) => {
        const vel = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)).multiplyScalar(speed);
        sim.addAircraft({
            id, faction, control: 'ai', kinematic: false,
            aircraftConfig: side.aircraftConfig ?? defaultFm2Config,
            pilotOptions: sideOptions(side),
            hitRadius: 10, maxHealth: 100, gun: MERGE_GUN,
            spawn: {
                position: [pos.x, pos.y, pos.z], quaternion: headingQuat(heading),
                velocity: [vel.x, vel.y, vel.z], landed: false, throttle: 0.8, airborne: true,
            },
            enabled: true,
        });
    };
    add(MERGE_BLUE, Faction.PLAYER, blue, new THREE.Vector3(0, setup.altitude, 0), 0, setup.blueSpeed);
    add(MERGE_RED, Faction.ENEMY, red,
        new THREE.Vector3(setup.lateral, setup.altitude + setup.up, setup.ahead), setup.redHeading, setup.redSpeed);
    const internalsForPilot = sim as unknown as {
        world: WorldQuery;
        aircraft: Map<string, PilotableAircraft & { pilot?: AiPilotController }>;
    };
    for (const [id, side] of [[MERGE_BLUE, blue], [MERGE_RED, red]] as const) {
        if (!side.pilot) continue;
        const ac = internalsForPilot.aircraft.get(id)!;
        ac.pilot = side.pilot(ac, internalsForPilot.world, sideOptions(side));
    }
    sim.setTarget(MERGE_BLUE, MERGE_RED);
    sim.setTarget(MERGE_RED, MERGE_BLUE);
    sim.setPhase(MERGE_BLUE, AiFlightPhase.ENGAGE);
    sim.setPhase(MERGE_RED, AiFlightPhase.ENGAGE);

    const internals = sim as unknown as {
        aircraft: Map<string, SimAircraftView>;
        hits: { targetId: string; impactSpeed?: number }[];
    };
    const all = internals.aircraft;
    const a = { blue: all.get(MERGE_BLUE)!, red: all.get(MERGE_RED)! };
    const res = { blue: emptySide(), red: emptySide() };
    const trace: MergeTraceSample[] = [];
    const tmp = new THREE.Vector3();
    let minRange = Infinity;
    let t = 0;
    let nextTrace = 0;
    const NOSE_ON = THREE.MathUtils.degToRad(45);
    const REAR_CONE = THREE.MathUtils.degToRad(60);

    const lost = (s: SimAircraftView) => s.health <= 0 || s.model.isCrashed();
    while (t < seconds) {
        sim.step(dt, {});
        t += dt;
        // Gun hits carry no impact speed; collisions (midair, ground scrape) do.
        const midair = new Set<string>();
        for (const h of internals.hits) {
            const shooter = h.targetId === MERGE_BLUE ? 'red' : h.targetId === MERGE_RED ? 'blue' : undefined;
            if (!shooter) continue;
            if (h.impactSpeed === undefined) res[shooter].hitsScored++;
            else midair.add(h.targetId);
        }
        for (const [me, other] of [['blue', 'red'], ['red', 'blue']] as const) {
            const r = res[me];
            const s = a[me];
            const o = a[other];
            if (s.firing && !lost(s)) {
                r.roundsFired += MERGE_GUN.roundsPerSecond * dt;
                r.firstShotAt ??= t;
            }
            if (lost(s) || lost(o)) continue;
            const p = s.model.position;
            const v = s.model.velocityVector;
            const range = p.distanceTo(o.model.position);
            minRange = Math.min(minRange, range);
            const speed = v.length();
            r.minAltitude = Math.min(r.minAltitude, p.y);
            r.minSpeed = Math.min(r.minSpeed, speed);
            if (speed < 90) r.slowS += dt;
            if (range < 1500 && angleTo(v, p, o.model.position, tmp) < NOSE_ON) r.noseOnS += dt;
            // In the other's rear cone: the angle between the other's tail and me.
            const offTail = Math.PI - angleTo(o.model.velocityVector, o.model.position, p, tmp);
            if (range < 2000 && offTail < REAR_CONE) {
                r.offensiveS += dt;
                res[other].defensiveS += dt;
            }
            const label = s.pilot?.getManeuverLabel() ?? '';
            r.labels[label] = (r.labels[label] ?? 0) + dt;
        }
        if (opts.traceEvery && t >= nextTrace) {
            nextTrace += opts.traceEvery;
            const bp = a.blue.model.position;
            const rp = a.red.model.position;
            trace.push({
                t: Math.round(t * 10) / 10,
                blue: [Math.round(bp.x), Math.round(bp.y), Math.round(bp.z)],
                red: [Math.round(rp.x), Math.round(rp.y), Math.round(rp.z)],
                blueLabel: a.blue.pilot?.getManeuverLabel() ?? '',
                redLabel: a.red.pilot?.getManeuverLabel() ?? '',
                blueSpeed: Math.round(a.blue.model.velocityVector.length()),
                redSpeed: Math.round(a.red.model.velocityVector.length()),
                range: Math.round(bp.distanceTo(rp)),
            });
        }
        let done = false;
        for (const me of ['blue', 'red'] as const) {
            const s = a[me];
            if (res[me].lostAt === undefined && lost(s)) {
                res[me].lostAt = t;
                if (midair.has(me === 'blue' ? MERGE_BLUE : MERGE_RED)) res[me].midair = true;
                else if (s.health <= 0) res[me].shotDown = true;
                else res[me].crashed = true;
                done = true;
            }
        }
        // Let a killing burst finish landing before stopping (both may die).
        if (done) {
            for (let i = 0; i < Math.round(0.5 / dt); i++) {
                sim.step(dt, {});
                for (const h of internals.hits) {
                    if (h.impactSpeed !== undefined) continue;
                    if (h.targetId === MERGE_BLUE) res.red.hitsScored++;
                    if (h.targetId === MERGE_RED) res.blue.hitsScored++;
                }
            }
            for (const me of ['blue', 'red'] as const) {
                if (res[me].lostAt === undefined && lost(a[me])) {
                    res[me].lostAt = t;
                    res[me].shotDown = a[me].health <= 0;
                    res[me].crashed = !res[me].shotDown;
                }
            }
            break;
        }
    }
    const blueLost = res.blue.lostAt !== undefined;
    const redLost = res.red.lostAt !== undefined;
    const winner = blueLost === redLost ? 'draw' : blueLost ? 'red' : 'blue';
    return {
        setup: setup.name, blue: res.blue, red: res.red, winner,
        duration: t, minRange, trace: opts.traceEvery ? trace : undefined,
    };
}

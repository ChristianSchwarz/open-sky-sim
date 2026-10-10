/**
 * Combat-sim scenario traces (workstream G): the authoritative world the
 * worker runs (CombatSim), stepped in process at 1/60 s with scripted inputs
 * and events. Covers AI duels with guns, faction targeting, the keyboard
 * player-input path, belly/hard landings, the arrestor trap, a mid-air,
 * a roof landing and wingman formation.
 *
 * The world is the sim's own SerializedWorld (structured-clone JSON), so the
 * C# port deserialises exactly what the TS sim received. Guns have spread 0
 * (the TS spread uses an unseeded Math.random).
 */
import * as THREE from 'three';
import { AiFlightPhase } from '../../../src/script/ai/aiPilot';
import { AiPilotModels } from '../../../src/script/state/gameDefs';
import { KeyboardControlLayoutId } from '../../../src/script/input/keyboardLayouts';
import { defaultFm2Config } from '../../../src/script/physics/fm2/fm2AircraftConfig';
import { CombatSim } from '../../../src/script/physics/sim/combatSim';
import {
    defaultArrestorCableField, SerializedStaticColliders, SerializedWorld, serializeStaticColliders, serializeWorld,
} from '../../../src/script/physics/sim/serializedWorld';
import { SimAircraftDesc, SimControlInputs, SimGunConfig } from '../../../src/script/physics/sim/simTypes';
import {
    ARRESTOR_CABLE_LOCAL_Z, ARRESTOR_CABLE_Y, ARRESTOR_CARRIER_ORIGIN, ARRESTOR_DECK_MID_X, DEFAULT_ARRESTOR_HOOK_BODY,
} from '../../../src/script/scene/entities/arrestorCables';
import { CarrierMeshCollider } from '../../../src/script/scene/entities/carrierDeck';
import { SurfacePadCollider } from '../../../src/script/scene/entities/surfacePad';
import { Faction } from '../../../src/script/weapons/combatant';
import { SuiteOutput } from '../lib';

const DT = 1 / 60;
const SAMPLE_EVERY = 6;

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

/** One scripted event, applied before the step whose index it names (1-based). */
type SimEvent =
    | { step: number; kind: 'keyDown'; id: string; key: string }
    | { step: number; kind: 'keyUp'; id: string; key: string }
    | { step: number; kind: 'setPhase'; id: string; phase: string }
    | { step: number; kind: 'setTargetFaction'; id: string; faction: number | null }
    | { step: number; kind: 'setFormationLead'; id: string; leadId: string | null }
    | { step: number; kind: 'setKeyboardLayout'; layout: string }
    | { step: number; kind: 'addStaticColliders'; colliders: SerializedStaticColliders }
    | { step: number; kind: 'gamepad'; id: string; pitch: number; roll: number; yaw: number; throttle: number };

/** A gamepad axes event: external aircraft fly from the sim's own player input, as in the game. */
const pad = (step: number, id: string, throttle: number, pitch = 0, roll = 0, yaw = 0): SimEvent =>
    ({ step, kind: 'gamepad', id, pitch, roll, yaw, throttle });

/** An external (scripted) combatant moving at constant velocity, mirrored in every step. */
interface ExternalScript {
    id: string;
    faction: number;
    position: Vec3;
    velocity: Vec3;
}

interface Scenario {
    name: string;
    description: string;
    world: SerializedWorld;
    aircraft: SimAircraftDesc[];
    events: SimEvent[];
    externals: ExternalScript[];
    steps: number;
}

const GUN: SimGunConfig = { muzzleVelocity: 1000, roundsPerSecond: 20, damage: 8, ammo: 600, muzzleOffset: [0, 0, 9], spread: 0 };


const flatRunway = (halfLength = 1000, halfWidth = 30) => serializeWorld([], [], [{
    center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength, halfWidth,
}], [], [], []);

const yawQuat = (heading: number): Quat => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    return [q.x, q.y, q.z, q.w];
};

function aiAircraft(id: string, faction: Faction, model: AiPilotModels, position: Vec3, heading: number, speed: number): SimAircraftDesc {
    return {
        id, faction, control: 'ai', model: 'fm2', aircraftConfig: defaultFm2Config,
        pilotOptions: { cruiseAltitude: 3000, cruiseSpeed: 210, hardDeck: 150, model },
        hitRadius: 10, maxHealth: 100, gun: GUN,
        spawn: {
            position, quaternion: yawQuat(heading),
            velocity: [Math.sin(heading) * speed, 0, Math.cos(heading) * speed],
            landed: false, throttle: 0.7, airborne: true,
        },
        enabled: true,
    };
}

/** A 2 x 2 x 14 m box fuselage collision mesh (from combatSim.midair.test.ts). */
function boxMesh() {
    const tris: number[] = [];
    const v = (x: number, y: number, z: number) => [x, y, z * 7];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => tris.push(...a, ...b, ...c, ...a, ...c, ...d);
    quad(v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1));
    quad(v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1));
    quad(v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1), v(1, -1, -1));
    quad(v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1));
    quad(v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1));
    quad(v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1));
    return { triangles: tris, aabb: { min: [-1, -1, -7] as Vec3, max: [1, 1, 7] as Vec3 } };
}

function scenarios(): Scenario[] {
    const list: Scenario[] = [];

    // 1-2. AI against AI with guns and faction targeting.
    for (const [a, b, tag] of [
        [AiPilotModels.CLASSIC, AiPilotModels.ACE, 'classic_vs_ace'],
        [AiPilotModels.SHAW, AiPilotModels.AGGRESSIVE, 'shaw_vs_aggressive'],
    ] as const) {
        list.push({
            name: `duel_${tag}`, description: 'Two AI fighters, opposite factions, head-on start, guns live',
            world: flatRunway(),
            aircraft: [
                aiAircraft('blue', Faction.PLAYER, a, [0, 3000, -2500], 0, 210),
                aiAircraft('red', Faction.ENEMY, b, [300, 3200, 2500], Math.PI, 210),
            ],
            events: [
                { step: 1, kind: 'setPhase', id: 'blue', phase: 'ENGAGE' },
                { step: 1, kind: 'setPhase', id: 'red', phase: 'ENGAGE' },
                { step: 1, kind: 'setTargetFaction', id: 'blue', faction: Faction.ENEMY },
                { step: 1, kind: 'setTargetFaction', id: 'red', faction: Faction.PLAYER },
            ],
            externals: [], steps: 40 * 60,
        });
    }

    // 3. AI bandit against an externally flown, firing player.
    list.push({
        name: 'bandit_vs_external_player', description: 'Classic AI bandit hunting an external player that turns and fires',
        world: flatRunway(),
        aircraft: [
            aiAircraft('ai0', Faction.ENEMY, AiPilotModels.CLASSIC, [0, 3000, 3000], Math.PI, 200),
            {
                id: 'player', faction: Faction.PLAYER, control: 'external', model: 'fm2', aircraftConfig: defaultFm2Config,
                hitRadius: 10, maxHealth: 100, gun: GUN,
                spawn: { position: [0, 3000, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 220], landed: false, throttle: 0.7, airborne: true },
                enabled: true,
            },
        ],
        events: [
            { step: 1, kind: 'setPhase', id: 'ai0', phase: 'ENGAGE' },
            { step: 1, kind: 'setTargetFaction', id: 'ai0', faction: Faction.PLAYER },
            pad(1, 'player', 0.75),
            { step: 1, kind: 'keyDown', id: 'player', key: ' ' },
            pad(240, 'player', 0.9, 0.4, 0.6),
            { step: 240, kind: 'keyUp', id: 'player', key: ' ' },
            pad(420, 'player', 0.9, 0.6),
            pad(900, 'player', 0.8, 0.3, -0.5),
            { step: 900, kind: 'keyDown', id: 'player', key: ' ' },
        ],
        externals: [], steps: 30 * 60,
    });

    // 4. Keyboard player input: QWERTY layout, gear/flaps toggles, throttle up, rotate.
    list.push({
        name: 'keyboard_takeoff', description: 'Worker-side keyboard input: throttle up, rotate, gear up, flaps up',
        world: flatRunway(3000, 40),
        aircraft: [{
            id: 'player', faction: Faction.PLAYER, control: 'external', model: 'fm2', aircraftConfig: defaultFm2Config,
            hitRadius: 10, maxHealth: 100,
            spawn: { position: [0, 2, -2500], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], landed: true, throttle: 0, airborne: false },
            enabled: true,
        }],
        events: [
            { step: 1, kind: 'setKeyboardLayout', layout: 'QWERTY' },
            { step: 1, kind: 'keyDown', id: 'player', key: 'z' },
            { step: 900, kind: 'keyUp', id: 'player', key: 'z' },
            { step: 1500, kind: 'keyDown', id: 'player', key: 's' },
            { step: 1680, kind: 'keyUp', id: 'player', key: 's' },
            { step: 1900, kind: 'keyDown', id: 'player', key: 'g' },
            { step: 1902, kind: 'keyUp', id: 'player', key: 'g' },
            { step: 1950, kind: 'keyDown', id: 'player', key: 'f' },
            { step: 1952, kind: 'keyUp', id: 'player', key: 'f' },
            { step: 2000, kind: 'keyDown', id: 'player', key: 'd' },
            { step: 2060, kind: 'keyUp', id: 'player', key: 'd' },
        ],
        externals: [], steps: 40 * 60,
    });

    // 5-7. Belly landings (from combatSim.belly.test.ts), with and without a collision mesh, and a fatal one.
    const belly = (name: string, model: 'fm2' | 'fm3', sink: number, speed: number, seconds: number, mesh: boolean): Scenario => ({
        name, description: `Gear-up landing (${model}, sink ${sink} m/s, ${speed} m/s${mesh ? ', box collision mesh' : ''})`,
        world: flatRunway(5000, 200),
        aircraft: [{
            id: 'player', faction: Faction.PLAYER, control: 'external', model, aircraftConfig: defaultFm2Config,
            hitRadius: 10, maxHealth: 100, collision: mesh ? boxMesh() : undefined,
            spawn: { position: [0, 4.2, -600], quaternion: [0, 0, 0, 1], velocity: [0, -sink, speed], landed: false, throttle: 0, airborne: true },
            enabled: true,
        }],
        events: [pad(1, 'player', 0)],
        externals: [], steps: seconds * 60,
    });
    list.push(
        belly('belly_fm2', 'fm2', 3, 70, 30, false),
        belly('belly_fm3', 'fm3', 3, 70, 30, false),
        belly('belly_fm2_rough_mesh', 'fm2', 9, 70, 20, true),
        belly('belly_fm2_fatal', 'fm2', 18, 70, 8, false),
    );

    // 8. Arrestor trap (from combatSim.arrestor.test.ts).
    {
        const origin = ARRESTOR_CARRIER_ORIGIN;
        const field = defaultArrestorCableField(origin.x, origin.y, origin.z);
        const half = 30, deckY = 18;
        const deck: CarrierMeshCollider = {
            originX: 0, originY: 0, originZ: 0,
            triangles: [-half, deckY, -half, half, deckY, -half, half, deckY, half, -half, deckY, -half, half, deckY, half, -half, deckY, half],
            aabb: { min: [-half, deckY, -half], max: [half, deckY, half] },
        };
        const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
        const hookBodyWorld = new THREE.Vector3(...DEFAULT_ARRESTOR_HOOK_BODY).applyQuaternion(quat);
        const cg: Vec3 = [
            origin.x + ARRESTOR_DECK_MID_X - hookBodyWorld.x,
            origin.y + ARRESTOR_CABLE_Y - hookBodyWorld.y,
            origin.z + ARRESTOR_CABLE_LOCAL_Z[0] + 0.8 - hookBodyWorld.z,
        ];
        list.push({
            name: 'arrestor_trap', description: 'Hook down, 55 m/s along the deck, snag the first wire and stop',
            world: serializeWorld([], [], [{ center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: 100, halfWidth: 20 }], [], [deck], [field]),
            aircraft: [{
                id: 'trap', faction: Faction.PLAYER, control: 'external', kinematic: false, aircraftConfig: defaultFm2Config,
                hitRadius: 5, maxHealth: 100,
                spawn: { position: cg, quaternion: [quat.x, quat.y, quat.z, quat.w], velocity: [0, 0, -55], throttle: 0, landed: false, airborne: false },
                enabled: true,
            }],
            events: [pad(1, 'trap', 0), { step: 1, kind: 'keyDown', id: 'trap', key: 'h' }],
            externals: [], steps: 8 * 60,
        });
    }

    // 9. Mid-air (from combatSim.midair.test.ts): two box-meshed aircraft head-on.
    list.push({
        name: 'midair_head_on', description: 'Two externally flown aircraft with box meshes meeting head-on',
        world: flatRunway(),
        aircraft: (['a', 'b'] as const).map((id, i) => ({
            id, faction: Faction.PLAYER, control: 'external' as const, model: 'fm2' as const, aircraftConfig: defaultFm2Config,
            hitRadius: 10, maxHealth: 100, collision: boxMesh(),
            spawn: {
                position: [i === 0 ? 0 : 0.5, 3000, i === 0 ? -200 : 200] as Vec3,
                quaternion: yawQuat(i === 0 ? 0 : Math.PI),
                velocity: [0, 0, i === 0 ? 30 : -30] as Vec3,
                landed: false, throttle: 0.5, airborne: true,
            },
            enabled: true,
        })),
        events: [pad(1, 'a', 0.5), pad(1, 'b', 0.5)],
        externals: [], steps: 10 * 60,
    });

    // 10. A roof landing on a building streamed in mid-flight (addStaticColliders).
    {
        const roof: SurfacePadCollider = { centerX: 0, centerZ: 0, heading: 0.4, halfLength: 60, halfWidth: 40, surfaceY: 30, baseY: 0, feather: 0.5 };
        list.push({
            name: 'roof_landing', description: 'Gear-down touchdown on a building roof added with addStaticColliders',
            world: flatRunway(),
            aircraft: [{
                id: 'player', faction: Faction.PLAYER, control: 'external', model: 'fm2', aircraftConfig: defaultFm2Config,
                hitRadius: 10, maxHealth: 100,
                spawn: { position: [0, 32.5, -30], quaternion: [0, 0, 0, 1], velocity: [0, -2, 10], landed: false, throttle: 0, airborne: false },
                enabled: true,
            }],
            events: [
                { step: 1, kind: 'addStaticColliders', colliders: serializeStaticColliders([roof], [{ position: new THREE.Vector3(0, 0, 0), radius: 72, height: 30 }]) },
                pad(1, 'player', 0),
                { step: 30, kind: 'keyDown', id: 'player', key: 'w' },
            ],
            externals: [], steps: 6 * 60,
        });
    }

    // 11. Wingman in formation on an external lead, then engaging a bandit.
    list.push({
        name: 'wingman_formation', description: 'AI wingman flies formation on a scripted lead',
        world: flatRunway(),
        aircraft: [aiAircraft('wing0', Faction.PLAYER, AiPilotModels.CLASSIC, [-300, 2950, -500], 0, 210)],
        events: [
            { step: 1, kind: 'setFormationLead', id: 'wing0', leadId: 'lead' },
            { step: 1, kind: 'setPhase', id: 'wing0', phase: 'FORMATION' },
        ],
        externals: [{ id: 'lead', faction: Faction.PLAYER, position: [0, 3000, 0], velocity: [0, 0, 210] }],
        steps: 20 * 60,
    });

    return list;
}

/** Read the sim's private state the way the TS tests do. */
interface SimAircraftView {
    id: string;
    health: number;
    firing: boolean;
    arrestorLatch: number;
    arrestorHeld: boolean;
    autoTargetId: string | undefined;
    model: {
        position: THREE.Vector3; quaternion: THREE.Quaternion; velocityVector: THREE.Vector3;
        isLanded(): boolean; isCrashed(): boolean; getAngleOfAttack(): number; getEffectiveThrottle(): number;
    };
    pilot?: { getPhase(): AiFlightPhase; getManeuverLabel(): string };
    gun?: { ammoRemaining: number };
    isGearDeployed(): boolean;
    isFlapsExtended(): boolean;
}

function run(s: Scenario): unknown {
    const sim = new CombatSim();
    sim.setWorld(s.world);
    for (const d of s.aircraft) sim.addAircraft(d);
    const aircraft = (sim as unknown as { aircraft: Map<string, SimAircraftView>; projectiles: Array<{ active: boolean }> });

    const samples: unknown[] = [];
    const hits: unknown[] = [];
    const externalPos = new Map(s.externals.map(e => [e.id, new THREE.Vector3(...e.position)]));

    for (let step = 1; step <= s.steps; step++) {
        for (const e of s.externals) {
            const p = externalPos.get(e.id)!;
            sim.setExternalState(e.id, true, e.faction, p, new THREE.Vector3(...e.velocity), true);
        }
        for (const ev of s.events) {
            if (ev.step !== step) continue;
            switch (ev.kind) {
                case 'keyDown': sim.keyDown(ev.id, ev.key, false); break;
                case 'keyUp': sim.keyUp(ev.id, ev.key); break;
                case 'setPhase': sim.setPhase(ev.id, AiFlightPhase[ev.phase as keyof typeof AiFlightPhase]); break;
                case 'setTargetFaction': sim.setTargetFaction(ev.id, ev.faction); break;
                case 'setFormationLead': sim.setFormationLead(ev.id, ev.leadId); break;
                case 'setKeyboardLayout': sim.setKeyboardLayout(KeyboardControlLayoutId[ev.layout as keyof typeof KeyboardControlLayoutId]); break;
                case 'addStaticColliders': sim.addStaticColliders(ev.colliders); break;
                case 'gamepad': sim.gamepadAxes(ev.id, ev.pitch, ev.roll, ev.yaw, ev.throttle, true); break;
            }
        }
        // External aircraft fly from the sim's own player input (the gamepad/key events above).
        const inputs: Record<string, SimControlInputs> = {};
        sim.step(DT, inputs);
        for (const e of s.externals) externalPos.get(e.id)!.addScaledVector(new THREE.Vector3(...e.velocity), DT);

        const snap = sim.encodeSnapshotInto(undefined, undefined);
        for (const h of snap.hits) hits.push({ step, ...h });
        if (step % SAMPLE_EVERY === 0 || step === s.steps) {
            samples.push({
                step,
                projectiles: aircraft.projectiles.filter(p => p.active).length,
                aircraft: [...aircraft.aircraft.values()].map(a => ({
                    id: a.id,
                    position: a.model.position.toArray(),
                    quaternion: a.model.quaternion.toArray(),
                    velocity: a.model.velocityVector.toArray(),
                    aoa: a.model.getAngleOfAttack(),
                    throttle: a.model.getEffectiveThrottle(),
                    landed: a.model.isLanded(),
                    crashed: a.model.isCrashed(),
                    gear: a.isGearDeployed(),
                    flaps: a.isFlapsExtended(),
                    health: a.health,
                    ammo: a.gun ? a.gun.ammoRemaining : null,
                    firing: a.firing,
                    arrestorLatch: a.arrestorLatch,
                    arrestorHeld: a.arrestorHeld,
                    target: a.autoTargetId ?? null,
                    phase: a.pilot ? AiFlightPhase[a.pilot.getPhase()] : null,
                    label: a.pilot ? a.pilot.getManeuverLabel() : null,
                })),
            });
        }
    }
    return { ...s, dt: DT, sampleEvery: SAMPLE_EVERY, hits, samples };
}

export function combatSimSuite(): SuiteOutput {
    const traces = scenarios().map(run);
    return {
        files: [{
            file: 'combat_sim.json',
            data: {
                suite: 'combat_sim',
                version: 1,
                source: 'src/script/physics/sim/combatSim.ts (+ simPlayerInput, aircraftCollision, serializedWorld, arrestorCables, carrierDeck, surfacePad, worldQuery, weapons/gun)',
                notes: [
                    'new CombatSim(); setWorld(world); addAircraft(each desc in order). aircraftConfig is always defaultFm2Config (Fm2Defaults.Default() in C#).',
                    'Each step n = 1..steps: for each external script call setExternalState(id, true, faction, position, velocity, true); apply events with step == n in listed order; sim.step(1/60, {}); then advance external positions by velocity/60; collect hits.',
                    'Externally controlled sim aircraft fly from the sim\'s worker-side player input: gamepad events call gamepadAxes(id, pitch, roll, yaw, throttle, true); key events call keyDown(id, key, false) / keyUp(id, key). Space fires.',
                    'Samples every 6th step and the last: per aircraft in insertion order. Doubles straight from the models.',
                    'Guns: spread 0 (the TS spread is unseeded Math.random).',
                ],
                tolerances: { position: 1e-3, velocity: 1e-3, quaternion: 1e-6, health: 1e-6 },
                traces,
            },
        }],
    };
}

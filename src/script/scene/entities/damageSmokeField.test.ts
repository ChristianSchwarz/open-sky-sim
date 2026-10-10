import * as THREE from 'three';
import { describe, it } from 'node:test';
import { expect } from './testExpect';
import { DAMAGE_SMOKE_PARTICLE_COUNT } from '../../defs';
import { SceneMaterialManager } from '../materials/materials';
import { DamageSmokeField } from './damageSmokeField';

/** Enough of a material manager to build the field without a renderer. */
const stubMaterials = { build: () => new THREE.MeshBasicMaterial() } as unknown as SceneMaterialManager;

type Priv = {
    system: { particles: { isActive: boolean; position: THREE.Vector3 }[] };
    dustFlags: Uint8Array;
    pools: { trail: { position: THREE.Vector3 }[]; radius: number; origin: THREE.Vector3 }[];
    fuelDrops: { active: boolean }[];
};

function live(field: DamageSmokeField): { position: THREE.Vector3; flag: number }[] {
    const priv = field as unknown as Priv;
    return priv.system.particles
        .map((p, i) => ({ isActive: p.isActive, position: p.position, flag: priv.dustFlags[i] }))
        .filter(p => p.isActive);
}

const pools = (field: DamageSmokeField) => (field as unknown as Priv).pools;
const dropsInFlight = (field: DamageSmokeField) => (field as unknown as Priv).fuelDrops.filter(d => d.active).length;

function run(field: DamageSmokeField, seconds: number): void {
    for (let i = 0; i < seconds * 30; i++) {
        field.update(1 / 30);
    }
}

const GROUND = 4;
const impact = new THREE.Vector3(100, GROUND, -50);
const velocity = new THREE.Vector3(0, -60, 120);
const still = new THREE.Vector3(0, 0, 0);

function newField(): DamageSmokeField {
    const field = new DamageSmokeField(stubMaterials);
    field.setGroundHeightAt(() => GROUND);
    return field;
}

/**
 * A burning fuselage sliding along +Z from the impact, braking to a stop after
 * `slideSeconds`, riding 1.5 m above the ground and shedding fuel as it goes.
 */
function slidingFuselage(field: DamageSmokeField, speed: number, slideSeconds: number, drips = 9) {
    let t = 0;
    let z = 0;
    field.addAnchoredFire(
        'p', (out) => { out.set(impact.x, GROUND + 1.5, impact.z + z); return true; },
        { rate: 30, life: 200, small: false, drips });
    return {
        step: (dt: number) => {
            t += dt;
            if (t < slideSeconds) {
                z += speed * (1 - t / slideSeconds) * dt;
            }
        },
        get distance() { return z; },
    };
}

function runWith(field: DamageSmokeField, fuselage: { step: (dt: number) => void }, seconds: number): void {
    for (let i = 0; i < seconds * 30; i++) {
        fuselage.step(1 / 30);
        field.update(1 / 30);
    }
}

describe('lake of fire made of falling fuel', () => {
    it('burns nothing until fuel has actually landed', () => {
        const field = newField();
        field.addFirePool(impact, velocity, 1);
        // The spray is still in the air: no lake, no flame on the ground.
        expect(pools(field)[0].trail.length).toBe(0);
        expect(dropsInFlight(field)).toBeGreaterThan(20);
        expect(live(field).length).toBe(0);
        run(field, 4);
        expect(pools(field)[0].trail.length).toBeGreaterThan(2);
        expect(live(field).length).toBeGreaterThan(50);
    });

    it('is sprayed out of the crash ahead of the impact, in the direction of travel, onto the ground', () => {
        const field = newField();
        field.addFirePool(impact, velocity, 1);
        run(field, 5);
        const trail = pools(field)[0].trail;
        expect(trail.length).toBeGreaterThan(3);
        const zs = trail.map(p => p.position.z);
        // Travelling along +Z: the fuel lands at and beyond the impact, not behind it.
        expect(Math.min(...zs)).toBeGreaterThan(impact.z - 12);
        expect(Math.max(...zs) - impact.z).toBeGreaterThan(15);
        for (const p of trail) {
            expect(p.position.y).toBeCloseTo(GROUND, 5);
        }
    });

    it('spreads along the path as fuel runs out of the sliding fuselage, widening behind it', () => {
        const field = newField();
        // A gentle crash with no forward spray: the lake must come from the fuselage.
        field.addFirePool(impact, still, 0.3);
        const fuselage = slidingFuselage(field, 60, 5);
        runWith(field, fuselage, 10);
        const slid = fuselage.distance;
        expect(slid).toBeGreaterThan(80);

        const trail = pools(field)[0].trail;
        const zs = trail.map(p => p.position.z - impact.z);
        // Fuel landed all the way along the path, to where the fuselage ended up.
        expect(Math.max(...zs)).toBeGreaterThan(slid * 0.8);
        expect(trail.length).toBeGreaterThan(slid / 12);
        // And the flames cover that swath.
        const flames = live(field).filter(p => p.flag === 0 || p.flag === 3);
        const fz = flames.map(p => p.position.z);
        const fx = flames.map(p => p.position.x);
        const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
        expect(spread(fz)).toBeGreaterThan(slid * 0.6);
        expect(spread(fx)).toBeGreaterThan(pools(field)[0].radius);
        expect(spread(fz)).toBeGreaterThan(spread(fx));
    });

    it('stops spreading when the fuselage stops: fuel dripping onto one spot is one lake point', () => {
        const field = newField();
        field.addFirePool(impact, still, 0.3);
        const fuselage = slidingFuselage(field, 60, 4);
        runWith(field, fuselage, 8);
        const atRest = pools(field)[0].trail.length;
        runWith(field, fuselage, 30);
        // It kept dripping for 30 s more, onto the same spot.
        expect(pools(field)[0].trail.length).toBeLessThanOrEqual(atRest + 1);
    });

    it('also runs out of wreckage lying on the ground, or just above it', () => {
        const field = newField();
        field.addFirePool(impact, still, 0.3);
        // A wing root lying 30 m off to the side, a metre and a half up.
        field.addAnchoredFire(
            'p', (out) => { out.set(impact.x + 30, GROUND + 1.5, impact.z); return true; },
            { rate: 20, life: 100, small: true, drips: 6 });
        run(field, 6);
        const near = pools(field)[0].trail.filter(p => Math.hypot(p.position.x - (impact.x + 30), p.position.z - impact.z) < 3);
        expect(near.length).toBeGreaterThan(0);
    });

    it('sheds nothing from a fire that has no drips', () => {
        const field = newField();
        field.addFirePool(impact, still, 0.3);
        field.addAnchoredFire(
            'p', (out) => { out.set(impact.x + 40, GROUND + 3, impact.z); return true; },
            { rate: 20, life: 100, small: true, drips: 0 });
        run(field, 6);
        const near = pools(field)[0].trail.filter(p => Math.abs(p.position.x - (impact.x + 40)) < 6);
        expect(near.length).toBe(0);
    });

    it('carries the motion of the piece it runs out of, so fuel from a faster piece lands further on', () => {
        const reach = (speed: number): number => {
            const field = newField();
            field.addFirePool(impact, still, 0.3);
            let t = 0;
            // A fuselage flying along +X, 6 m up.
            field.addAnchoredFire(
                'p', (out) => { out.set(impact.x + speed * t, GROUND + 6, impact.z); t += 1 / 30; return true; },
                { rate: 20, life: 100, small: false, drips: 10 });
            run(field, 4);
            return Math.max(...pools(field)[0].trail.map(p => p.position.x - impact.x));
        };
        expect(reach(30)).toBeGreaterThan(reach(0) + 25);
    });

    it('draws the falling fuel as streaks of flame between the wreckage and the ground', () => {
        const field = newField();
        field.addFirePool(impact, still, 0.3);
        // The fire's own puffs are off (rate 0), so flame in mid-air under it is falling fuel.
        field.addAnchoredFire(
            'p', (out) => { out.set(impact.x + 50, GROUND + 9, impact.z); return true; },
            { rate: 0, life: 100, small: true, drips: 10 });
        run(field, 1);
        const falling = live(field).filter(p =>
            Math.abs(p.position.x - (impact.x + 50)) < 4 && p.position.y > GROUND + 1 && p.position.y < GROUND + 9);
        expect(falling.length).toBeGreaterThan(3);
    });

    describe('fallen fuel spreads out over the ground', () => {
        const SPOT = { dx: 40 };
        const spot = () => new THREE.Vector3(impact.x + SPOT.dx, GROUND, impact.z);
        type PuddlePoint = { position: THREE.Vector3; radiusNow: number; volume: number };
        const puddles = (f: DamageSmokeField) => (pools(f)[0].trail as unknown as PuddlePoint[]);
        const puddleAt = (f: DamageSmokeField): PuddlePoint | undefined =>
            puddles(f).find(p => Math.hypot(p.position.x - spot().x, p.position.z - spot().z) < 4);

        /** A wing root 1.5 m up at SPOT, shedding `drips` drops a second onto a lake from a gentle crash. */
        function fieldWithDrip(drips: number, severity = 0.3): DamageSmokeField {
            const field = newField();
            field.addFirePool(impact, still, severity);
            field.addAnchoredFire(
                'p', (out) => { out.set(spot().x, GROUND + 1.5, spot().z); return true; },
                { rate: 0, life: 200, small: true, drips });
            return field;
        }

        /** How far flames near the spot are from it. */
        function flameReach(f: DamageSmokeField): number {
            const flames = live(f).filter(p => (p.flag === 0 || p.flag === 3) && p.position.x > impact.x + 25);
            return flames.length === 0 ? 0 : Math.max(...flames.map(p => Math.hypot(p.position.x - spot().x, p.position.z - spot().z)));
        }

        it('starts as a small splash and creeps out over several seconds', () => {
            const field = fieldWithDrip(8);
            run(field, 1.2);
            const early = puddleAt(field)!;
            expect(early).toBeDefined();
            const radiusEarly = early.radiusNow;
            expect(radiusEarly).toBeLessThan(3.5);
            const reachEarly = flameReach(field);
            run(field, 12);
            expect(puddleAt(field)!.radiusNow).toBeGreaterThan(radiusEarly * 2);
            expect(puddleAt(field)!.radiusNow).toBeGreaterThan(6);
            // The flames really do cover that: several metres from where the fuel landed.
            expect(flameReach(field)).toBeGreaterThan(Math.max(6, reachEarly * 1.5));
        });

        it('spreads further where more fuel fell', () => {
            // A hard crash, so the lake's own radius is not what limits the puddle.
            const radius = (drips: number): number => {
                const field = fieldWithDrip(drips, 1.5);
                run(field, 6);
                return puddleAt(field)!.radiusNow;
            };
            const a = radius(1);
            const b = radius(12);
            expect(b).toBeGreaterThan(a + 3);
        });

        it('never spreads past the lake radius', () => {
            const field = fieldWithDrip(30);
            run(field, 40);
            for (const p of puddles(field)) {
                expect(p.radiusNow).toBeLessThanOrEqual(pools(field)[0].radius + 1e-6);
            }
        });

        it('chars the ground in new patches as the edge moves out, not all at once', () => {
            const field = fieldWithDrip(8);
            const reach: { t: number; d: number }[] = [];
            let now = 0;
            field.onPoolMark = (p, _dx, _dz, _l, _w, char) => {
                if (char && p.x > impact.x + 25) {
                    reach.push({ t: now, d: Math.hypot(p.x - spot().x, p.z - spot().z) });
                }
            };
            for (let i = 0; i < 30 * 12; i++) {
                now += 1 / 30;
                field.update(1 / 30);
            }
            expect(reach.length).toBeGreaterThan(3);
            // Patches keep arriving over several seconds, and the later ones are further out.
            expect(Math.max(...reach.map(r => r.t)) - Math.min(...reach.map(r => r.t))).toBeGreaterThan(2);
            const early = reach.filter(r => r.t < 2).map(r => r.d);
            const late = reach.filter(r => r.t >= 4).map(r => r.d);
            const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
            // On average (single patches are noisy: a drop lands a metre or two off the fire's own spot).
            expect(late.length).toBeGreaterThan(0);
            expect(mean(late)).toBeGreaterThan(mean(early) + 1);
        });
    });

    describe('burns like every other fire: flame, then more and more smoke and black', () => {
        /** Share of the puffs near the ground (just emitted) that are still flame rather than smoke or black. */
        function flameFraction(f: DamageSmokeField, nearX?: number): number {
            const low = live(f).filter(p => p.position.y < GROUND + 3 && (nearX === undefined || Math.abs(p.position.x - nearX) < 6));
            return low.length === 0 ? NaN : low.filter(p => p.flag === 0).length / low.length;
        }

        it('a fresh lake is nearly all flame; a lake nearly out gives mostly smoke and black', () => {
            const field = newField();
            field.addFirePool(impact, velocity, 1);
            run(field, 4);
            const fresh = flameFraction(field);
            run(field, 146);
            const dying = flameFraction(field);
            expect(fresh).toBeGreaterThan(0.8);
            expect(dying).toBeLessThan(0.25);
        });

        it('fuel shed by a nearly burnt-out fire is mostly smoke when it falls, a fresh fire is all flame', () => {
            type Drop = { active: boolean; flame: number; early: number };
            const dropFlame = (runSeconds: number): number => {
                const field = newField();
                field.addFirePool(impact, still, 0.3);
                field.addAnchoredFire(
                    'p', (out) => { out.set(impact.x + 60, GROUND + 14, impact.z); return true; },
                    { rate: 0, life: 12, small: true, drips: 12 });
                run(field, runSeconds);
                // Drops in flight now were released just now, by the fire as it is now.
                const drops = (field as unknown as { fuelDrops: Drop[] }).fuelDrops.filter(d => d.active);
                return drops.reduce((sum, d) => sum + d.flame, 0) / Math.max(1, drops.length);
            };
            // 11.5 of 12 seconds: burn is down to 4%, below the point where any flame is left.
            expect(dropFlame(1.0)).toBeGreaterThan(0.9);
            expect(dropFlame(11.5)).toBeLessThan(0.1);
        });
    });

    describe('on a moving carrier deck', () => {
        const DECK_V = new THREE.Vector3(0, 0, -20);
        const onDeck = {
            velocity: DECK_V,
            contains: (_x: number, y: number, _z: number) => y > GROUND - 3 && y < GROUND + 5,
        };

        it('moves the lake with the ship: the puddles and the crash site go along', () => {
            const field = newField();
            field.setMovingSurface(onDeck);
            field.addFirePool(impact, still, 0.3);
            run(field, 5);
            const first = pools(field)[0].trail[0].position.clone();
            const originAt5 = pools(field)[0].origin.clone();
            run(field, 10);
            // 10 s at 20 m/s along -Z.
            expect(first.z - pools(field)[0].trail[0].position.z).toBeCloseTo(200, 0);
            expect(originAt5.z - pools(field)[0].origin.z).toBeCloseTo(200, 0);
            expect(pools(field)[0].trail[0].position.x).toBeCloseTo(first.x, 5);
        });

        it('leaves a lake on ordinary ground where it is', () => {
            const field = newField();
            field.addFirePool(impact, still, 0.3);
            run(field, 5);
            const first = pools(field)[0].trail[0].position.clone();
            run(field, 10);
            expect(pools(field)[0].trail[0].position.distanceTo(first)).toBeLessThan(1e-6);
        });

        it('only carries what was laid on the deck, not a lake beside it', () => {
            const field = newField();
            // A deck that is only the strip x < 110.
            field.setMovingSurface({ velocity: DECK_V, contains: (x, y) => x < 110 && y < GROUND + 5 });
            field.addFirePool(new THREE.Vector3(100, GROUND, -50), still, 0.3);
            field.addFirePool(new THREE.Vector3(300, GROUND, -50), still, 0.3);
            run(field, 5);
            const beforeBeside = pools(field)[1].origin.z;
            const beforeDeck = pools(field)[0].origin.z;
            run(field, 5);
            expect(beforeDeck - pools(field)[0].origin.z).toBeCloseTo(100, 0);
            expect(pools(field)[1].origin.z).toBe(beforeBeside);
        });

        it('carries burning scratches with the ship', () => {
            const field = newField();
            field.setMovingSurface(onDeck);
            const marks: number[] = [];
            field.onBurnMark = (p) => { marks.push(p.z); };
            field.addBurnSpot(new THREE.Vector3(100, GROUND, 0), 30, 1);
            run(field, 12);
            // The scratch burns, and each patch it blackens is where the scratch now is, further along -Z.
            expect(marks.length).toBeGreaterThan(0);
            expect(Math.min(...marks)).toBeLessThan(-100);
        });

        it('falls from wreckage riding the deck with the deck\'s speed', () => {
            const field = newField();
            field.setMovingSurface(onDeck);
            field.addFirePool(impact, still, 0.3);
            let t = 0;
            // A fuselage sitting 6 m up on the deck, steaming with it.
            field.addAnchoredFire(
                'p', (out) => { out.set(impact.x + 30, GROUND + 6, impact.z + DECK_V.z * t); t += 1 / 30; return true; },
                { rate: 0, life: 100, small: false, drips: 12 });
            run(field, 5);
            const trail = pools(field)[0].trail;
            const near = trail.filter(p => p.position.x > impact.x + 20);
            expect(near.length).toBeGreaterThan(0);
            // Fuel shed in flight lands ahead along -Z of where the fuselage released it.
            expect(Math.min(...near.map(p => p.position.z))).toBeLessThan(impact.z + DECK_V.z * 3);
        });
    });

    describe('on the sea', () => {
        const SPRAY = 4;
        const MIST = 5;
        const sea = () => {
            const field = newField();
            field.setWaterTest(() => true);
            return field;
        };
        const flagged = (f: DamageSmokeField, flag: number) => live(f).filter(p => p.flag === flag);

        it('a splash throws up a column of spray and spreads a mist', () => {
            const field = sea();
            field.spawnSplash(new THREE.Vector3(100, GROUND, 0), 1);
            run(field, 0.3);
            expect(flagged(field, SPRAY).length).toBeGreaterThan(10);
            expect(flagged(field, MIST).length).toBeGreaterThan(5);
            // The spray stands up out of the water.
            expect(Math.max(...flagged(field, SPRAY).map(p => p.position.y))).toBeGreaterThan(GROUND + 2);
        });

        it('the spray is gone in a couple of seconds; the mist lingers over the water', () => {
            const field = sea();
            field.spawnSplash(new THREE.Vector3(100, GROUND, 0), 1);
            run(field, 2.6);
            expect(flagged(field, SPRAY).length).toBe(0);
            expect(flagged(field, MIST).length).toBeGreaterThan(0);
            run(field, 4);
            expect(live(field).length).toBe(0);
        });

        it('the mist spreads out along the surface, wider than the column of spray', () => {
            const field = sea();
            field.spawnSplash(new THREE.Vector3(100, GROUND, 0), 1);
            run(field, 1.2);
            const reach = (flag: number) => {
                const ps = flagged(field, flag);
                return Math.max(...ps.map(p => Math.hypot(p.position.x - 100, p.position.z)));
            };
            expect(reach(MIST)).toBeGreaterThan(4);
            expect(Math.max(...flagged(field, MIST).map(p => p.position.y))).toBeLessThan(
                Math.max(...flagged(field, SPRAY).map(p => p.position.y)));
        });

        describe('foam', () => {
            const FOAM = 6;
            const at = new THREE.Vector3(100, GROUND, 0);

            it('is laid as flat white puffs on the surface, a patch about the size of the piece', () => {
                const field = sea();
                field.spawnFoam(at, 4, 30);
                const foam = flagged(field, FOAM);
                expect(foam.length).toBe(30);
                for (const p of foam) {
                    expect(Math.hypot(p.position.x - at.x, p.position.z - at.z)).toBeLessThan(4 * 0.9 + 0.6 + 0.01);
                    // Just above the water, not in the air.
                    expect(p.position.y).toBeGreaterThan(GROUND);
                    expect(p.position.y).toBeLessThan(GROUND + 0.5);
                }
            });

            it('stays on the surface as it spreads and fades, and is gone in a few seconds', () => {
                const field = sea();
                field.spawnFoam(at, 3, 20);
                run(field, 1.5);
                for (const p of flagged(field, FOAM)) {
                    expect(p.position.y).toBeLessThan(GROUND + 0.5);
                }
                run(field, 3.5);
                expect(flagged(field, FOAM).length).toBe(0);
            });

            it('is more of it for more puffs', () => {
                const count = (n: number): number => {
                    const field = sea();
                    field.spawnFoam(at, 3, n);
                    return flagged(field, FOAM).length;
                };
                expect(count(40)).toBeGreaterThan(count(5));
            });

            it('is drawn laid flat: its quads face up, not the camera', () => {
                const field = sea();
                field.spawnFoam(at, 3, 12);
                // Sync the puffs from a camera well off to the side and read an instance's facing.
                const priv = field as unknown as {
                    syncPuffs(camera: THREE.Camera, palette: unknown): void;
                    puffs: THREE.InstancedMesh;
                };
                const camera = new THREE.PerspectiveCamera();
                camera.position.set(500, GROUND + 3, 300);
                camera.lookAt(at);
                const palette = {
                    time: 'noon',
                    colors: new Proxy({}, { get: () => '#808080' }),
                } as unknown;
                priv.syncPuffs(camera, palette);
                const m = new THREE.Matrix4();
                priv.puffs.getMatrixAt(0, m);
                const q = new THREE.Quaternion();
                m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
                const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
                // A circle's normal is +Z in its own frame: for foam it points straight up.
                expect(Math.abs(normal.y)).toBeGreaterThan(0.99);
            });
        });

        it('a harder splash is bigger', () => {
            const count = (strength: number): number => {
                const field = sea();
                field.spawnSplash(new THREE.Vector3(100, GROUND, 0), strength);
                run(field, 0.2);
                return live(field).length;
            };
            expect(count(1.5)).toBeGreaterThan(count(0.2));
        });

        it('fuel falling on the sea splashes and is gone: no lake, no flame, no burn marks', () => {
            const field = sea();
            let burnMarks = 0;
            field.onBurnMark = () => { burnMarks++; };
            field.addFirePool(impact, velocity, 1);
            let spray = 0;
            for (let i = 0; i < 30 * 6; i++) {
                field.update(1 / 30);
                spray = Math.max(spray, flagged(field, SPRAY).length);
            }
            expect(pools(field)[0].trail.length).toBe(0);
            expect(burnMarks).toBe(0);
            expect(live(field).filter(p => p.flag === 0 || p.flag === 3).length).toBe(0);
            // The spray of fuel did splash where it came down.
            expect(spray).toBeGreaterThan(0);
        });

        it('fuel shed by wreckage over the sea splashes, and leaves no lake', () => {
            const field = sea();
            field.addFirePool(impact, still, 0.3);
            field.addAnchoredFire(
                'p', (out) => { out.set(impact.x + 20, GROUND + 3, impact.z); return true; },
                { rate: 0, life: 100, small: true, drips: 10 });
            let spray = 0;
            for (let i = 0; i < 30 * 4; i++) {
                field.update(1 / 30);
                spray = Math.max(spray, flagged(field, SPRAY).length);
            }
            expect(spray).toBeGreaterThan(0);
            expect(pools(field)[0].trail.length).toBe(0);
        });

        it('the same fuel on land does make a lake, so it is the sea that stops it', () => {
            const field = newField();
            field.addFirePool(impact, velocity, 1);
            run(field, 6);
            expect(pools(field)[0].trail.length).toBeGreaterThan(0);
        });
    });

    it('is bigger and fiercer for a harder hit', () => {
        const measure = (severity: number): { radius: number; points: number } => {
            const field = newField();
            field.addFirePool(impact, velocity, severity);
            run(field, 6);
            return { radius: pools(field)[0].radius, points: pools(field)[0].trail.length };
        };
        const gentle = measure(0.3);
        const hard = measure(1.4);
        expect(hard.radius).toBeGreaterThan(gentle.radius);
        expect(hard.points).toBeGreaterThan(gentle.points);
    });

    it('stands black smoke up over the lake, then burns out without exhausting the particle pool', () => {
        const field = newField();
        field.addFirePool(impact, velocity, 1.5);
        const fuselage = slidingFuselage(field, 80, 6);
        let peak = 0;
        let sawTallBlack = false;
        for (let i = 0; i < 30 * 60; i++) {
            fuselage.step(1 / 30);
            field.update(1 / 30);
            if (i % 15 === 0) {
                const particles = live(field);
                peak = Math.max(peak, particles.length);
                sawTallBlack = sawTallBlack || particles.some(p => p.flag === 3 && p.position.y > GROUND + 12);
            }
        }
        expect(sawTallBlack).toBe(true);
        // Even a long lake with the fuselage fire leaves room in the pool for the rest of the crash.
        expect(peak).toBeLessThan(DAMAGE_SMOKE_PARTICLE_COUNT * 0.6);
    });

    it('burns out in the end and leaves nothing behind', () => {
        const field = newField();
        field.addFirePool(impact, velocity, 1);
        run(field, 230);
        expect(live(field).length).toBe(0);
    });

    it('scorches the ground under every new stretch of lake', () => {
        const field = newField();
        const chars: number[] = [];
        field.onPoolMark = (p, _dx, _dz, _length, _width, char) => { if (char) { chars.push(p.z); } };
        field.addFirePool(impact, still, 0.3);
        const fuselage = slidingFuselage(field, 60, 5);
        runWith(field, fuselage, 8);
        expect(chars.length).toBeGreaterThan(5);
        expect(Math.max(...chars) - Math.min(...chars)).toBeGreaterThan(fuselage.distance * 0.7);
    });

    it('blackens the ground under the lake, patch by patch, for as long as it burns', () => {
        const field = newField();
        const marks: { time: number; radius: number; strength: number; grow: number; z: number }[] = [];
        let now = 0;
        field.onBurnMark = (p, radius, strength, grow) => { marks.push({ time: now, radius, strength, grow, z: p.z }); };
        field.addFirePool(impact, still, 0.3);
        const fuselage = slidingFuselage(field, 60, 5);
        for (let i = 0; i < 30 * 60; i++) {
            now += 1 / 30;
            fuselage.step(1 / 30);
            field.update(1 / 30);
        }
        expect(marks.length).toBeGreaterThan(100);
        // They keep coming over time, not all at once.
        expect(marks.filter(m => m.time > 20).length).toBeGreaterThan(30);
        for (const m of marks) {
            expect(m.radius).toBeGreaterThan(0.5);
            expect(m.grow).toBeGreaterThan(10);
            expect(m.strength).toBeGreaterThan(0.5);
        }
        // Spread right along the slide, not stacked at the impact.
        expect(Math.max(...marks.map(m => m.z)) - Math.min(...marks.map(m => m.z))).toBeGreaterThan(fuselage.distance * 0.6);
    });

    it('blackens the ground under a fire sitting on it, but not one high in the air', () => {
        const burnMarks = (height: number): number => {
            const field = new DamageSmokeField(stubMaterials);
            field.setGroundHeightAt(() => 0);
            let n = 0;
            field.onBurnMark = () => { n++; };
            field.addAnchoredFire('p', (out) => { out.set(0, height, 0); return true; }, { rate: 20, life: 100, small: false });
            run(field, 20);
            return n;
        };
        expect(burnMarks(1.5)).toBeGreaterThan(5);
        expect(burnMarks(60)).toBe(0);
    });

    it('is cleared by reset, drops in flight included', () => {
        const field = newField();
        field.addFirePool(impact, velocity, 1);
        run(field, 3);
        expect(live(field).length).toBeGreaterThan(0);
        field.reset();
        expect(dropsInFlight(field)).toBe(0);
        run(field, 3);
        expect(live(field).length).toBe(0);
        expect(pools(field)[0].trail.length).toBe(0);
    });
});

describe('contact puffs', () => {
    const flagsAfter = (surface: 'dirt' | 'water' | 'concrete') => {
        const field = newField();
        field.spawnContactPuffs(impact, surface, 4, 0.5);
        return live(field).map(p => p.flag);
    };

    it('are brown dust off ground, white spray off water, gray dust off concrete', () => {
        const dirt = flagsAfter('dirt');
        const water = flagsAfter('water');
        const concrete = flagsAfter('concrete');
        expect(dirt.length).toBe(4);
        expect(dirt.every(f => f === 1)).toBe(true);
        expect(water.length).toBe(4);
        expect(water.every(f => f === 4)).toBe(true);
        expect(concrete.length).toBe(4);
        expect(concrete.every(f => f === 7)).toBe(true);
    });

    it('are small and short-lived, and fade away', () => {
        const field = newField();
        field.spawnContactPuffs(impact, 'dirt', 6, 0.5);
        expect(live(field).length).toBe(6);
        run(field, 3);
        expect(live(field).length).toBe(0);
    });

    it('come from sliding contacts, in the colour of the surface under them', () => {
        const field = newField();
        field.surfaceAt = (x) => (x < 0 ? 'water' : x < 1000 ? 'dirt' : 'concrete');
        field.spawnGroundScrapes([
            { position: [-10, GROUND, 0], velocity: [0, 0, 60], targetId: 'p', damage: 0, source: 'scrape', slide: true },
            { position: [10, GROUND, 0], velocity: [0, 0, 60], targetId: 'p', damage: 0, source: 'scrape', slide: true },
            { position: [2000, GROUND, 0], velocity: [0, 0, 60], targetId: 'p', damage: 0, source: 'scrape', slide: true },
        ]);
        const flags = new Set(live(field).map(p => p.flag));
        expect(flags.has(4)).toBe(true);
        expect(flags.has(1)).toBe(true);
        expect(flags.has(7)).toBe(true);
    });
});

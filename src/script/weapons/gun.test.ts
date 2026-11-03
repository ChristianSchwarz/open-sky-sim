import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Faction } from './combatant';
import { Gun, GunConfig } from './gun';

const config = (over: Partial<GunConfig> = {}): GunConfig => ({
    muzzleVelocity: 1000, roundsPerSecond: 20, damage: 1, ammo: 10000,
    muzzleOffset: new THREE.Vector3(), ...over,
});

describe('Gun', () => {
    it('fires at its cyclic rate, not rounded to whole sim steps', () => {
        // 20 rps at 60 Hz is a round every third step; resetting the cooldown to the
        // full interval used to skip a fourth step each time (15 rps).
        let rounds = 0;
        const gun = new Gun(config(), { spawnProjectile: () => { rounds++; } }, Faction.PLAYER);
        const q = new THREE.Quaternion(), p = new THREE.Vector3(), v = new THREE.Vector3();
        for (let i = 0; i < 600; i++) {
            gun.update(1 / 60);
            gun.tryFire(p, q, v);
        }
        assert.equal(rounds, 200);
    });

    it('spreads rounds round the barrel whichever way the aircraft points', () => {
        // Flying east (+X): dispersion jittered in world x/y used to leave the
        // rounds with almost no sideways (world z) spread.
        const dirs: THREE.Vector3[] = [];
        const gun = new Gun(config({ spread: 0.01, roundsPerSecond: 1e6 }),
            { spawnProjectile: (_o, vel) => { dirs.push(vel.clone().normalize()); } }, Faction.PLAYER);
        const east = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
        for (let i = 0; i < 400; i++) {
            gun.update(1);
            gun.tryFire(new THREE.Vector3(), east, new THREE.Vector3());
        }
        const maxZ = Math.max(...dirs.map(d => Math.abs(d.z)));
        const maxY = Math.max(...dirs.map(d => Math.abs(d.y)));
        assert.ok(dirs.every(d => d.x > 0.99), 'rounds go east');
        assert.ok(maxZ > 0.005 && maxY > 0.005, `sideways ${maxZ}, vertical ${maxY}`);
    });
});

import * as THREE from 'three';
import { Faction } from './combatant';

/** Sink that turns a fired round into a live projectile in the world. */
export interface ProjectileSink {
    spawnProjectile(origin: THREE.Vector3, velocity: THREE.Vector3, faction: Faction, damage: number): void;
}

export interface GunConfig {
    /** Muzzle velocity added to the shooter's own velocity (m/s). */
    muzzleVelocity: number;
    /** Cyclic rate (rounds per second). */
    roundsPerSecond: number;
    /** Damage per round. */
    damage: number;
    /** Rounds available. */
    ammo: number;
    /** Muzzle position in the body frame (m). */
    muzzleOffset: THREE.Vector3;
    /** Random dispersion half-angle (rad). */
    spread?: number;
}

/** Cooldown left (s) that still counts as ready. */
const COOLDOWN_EPS_S = 1e-9;

/**
 * A boresight cannon. When the trigger is pulled and the gun is off cooldown it
 * emits a round into a {@link ProjectileSink}, inheriting the shooter's velocity
 * plus muzzle velocity along the aircraft's forward axis.
 */
export class Gun {
    private cooldown = 0;
    private ammo: number;

    private readonly muzzleWorld = new THREE.Vector3();
    private readonly velWorld = new THREE.Vector3();
    private readonly fwd = new THREE.Vector3();

    constructor(
        private readonly config: GunConfig,
        private readonly sink: ProjectileSink,
        private readonly faction: Faction,
    ) {
        this.ammo = config.ammo;
    }

    get ammoRemaining(): number {
        return this.ammo;
    }

    /** Restore full ammo and clear the cooldown (used on respawn). */
    reset(): void {
        this.ammo = this.config.ammo;
        this.cooldown = 0;
    }

    update(delta: number): void {
        if (this.cooldown > 0) {
            this.cooldown -= delta;
        }
    }

    /**
     * Attempt to fire. `position`/`quaternion` are the shooter's current body
     * transform; `shooterVelocity` is its world velocity. Returns true if a round
     * was emitted this call.
     */
    tryFire(position: THREE.Vector3, quaternion: THREE.Quaternion, shooterVelocity: THREE.Vector3): boolean {
        // A hair of slack: three 1/60 s steps leave 1/20 s as 7e-18, not 0.
        if (this.cooldown > COOLDOWN_EPS_S || this.ammo <= 0) {
            return false;
        }
        // Carry the overshoot: resetting to the full interval would round the
        // cyclic rate down to a whole number of sim steps (20 rps -> 15 at 60 Hz).
        this.cooldown += 1 / this.config.roundsPerSecond;
        this.ammo -= 1;

        this.muzzleWorld.copy(this.config.muzzleOffset).applyQuaternion(quaternion).add(position);
        // Dispersion round the barrel, in the body frame: jittering world x/y
        // after the rotation left almost none sideways when flying east or west.
        this.fwd.set(0, 0, 1);
        if (this.config.spread) {
            this.fwd.x = (Math.random() - 0.5) * 2 * this.config.spread;
            this.fwd.y = (Math.random() - 0.5) * 2 * this.config.spread;
            this.fwd.normalize();
        }
        this.fwd.applyQuaternion(quaternion);
        this.velWorld.copy(this.fwd).multiplyScalar(this.config.muzzleVelocity).add(shooterVelocity);
        this.sink.spawnProjectile(this.muzzleWorld, this.velWorld, this.faction, this.config.damage);
        return true;
    }
}

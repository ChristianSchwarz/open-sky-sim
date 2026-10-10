using System;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>Sink that turns a fired round into a live projectile in the world.</summary>
    public interface IProjectileSink
    {
        void SpawnProjectile(Vec3d origin, Vec3d velocity, Faction faction, double damage);
    }

    public sealed class GunConfig
    {
        /// <summary>Muzzle velocity added to the shooter's own velocity (m/s).</summary>
        public double MuzzleVelocity;
        /// <summary>Cyclic rate (rounds per second).</summary>
        public double RoundsPerSecond;
        /// <summary>Damage per round.</summary>
        public double Damage;
        /// <summary>Rounds available.</summary>
        public double Ammo;
        /// <summary>Muzzle position in the body frame (m).</summary>
        public Vec3d MuzzleOffset;
        /// <summary>Random dispersion half-angle (rad); null or 0 is none.</summary>
        public double? Spread;
    }

    /// <summary>
    /// A boresight cannon (port of weapons/gun.ts). When the trigger is pulled and
    /// the gun is off cooldown it emits a round into an <see cref="IProjectileSink"/>,
    /// inheriting the shooter's velocity plus muzzle velocity along the forward axis.
    /// The TS spread uses Math.random; here the random source is injectable and
    /// defaults to a seeded generator, and it is only drawn from when spread != 0.
    /// </summary>
    public sealed class Gun
    {
        private readonly GunConfig config;
        private readonly IProjectileSink sink;
        private readonly Faction faction;
        private readonly Func<double> random;
        private double cooldown;
        private double ammo;

        public Gun(GunConfig config, IProjectileSink sink, Faction faction, Func<double> random = null)
        {
            this.config = config;
            this.sink = sink;
            this.faction = faction;
            this.random = random ?? Mulberry32(0x5eed);
            ammo = config.Ammo;
        }

        public double AmmoRemaining => ammo;

        /// <summary>Restore full ammo and clear the cooldown (used on respawn).</summary>
        public void Reset()
        {
            ammo = config.Ammo;
            cooldown = 0;
        }

        public void Update(double delta)
        {
            if (cooldown > 0)
            {
                cooldown -= delta;
            }
        }

        /// <summary>Attempt to fire. Returns true if a round was emitted this call.</summary>
        public bool TryFire(Vec3d position, Quatd quaternion, Vec3d shooterVelocity)
        {
            if (cooldown > 0 || ammo <= 0)
            {
                return false;
            }
            cooldown = 1 / config.RoundsPerSecond;
            ammo -= 1;

            Vec3d muzzleWorld = config.MuzzleOffset.Rotate(quaternion) + position;
            Vec3d fwd = new Vec3d(0, 0, 1).Rotate(quaternion);
            double spread = config.Spread ?? 0;
            if (spread != 0 && !double.IsNaN(spread))
            {
                fwd.X += (random() - 0.5) * 2 * spread;
                fwd.Y += (random() - 0.5) * 2 * spread;
                fwd = fwd.Normalized();
            }
            Vec3d velWorld = fwd * config.MuzzleVelocity + shooterVelocity;
            sink.SpawnProjectile(muzzleWorld, velWorld, faction, config.Damage);
            return true;
        }

        /// <summary>A small seedable PRNG in [0, 1) (mulberry32).</summary>
        public static Func<double> Mulberry32(uint seed)
        {
            uint a = seed;
            return () =>
            {
                a += 0x6D2B79F5;
                uint t = a;
                t = (t ^ (t >> 15)) * (t | 1);
                t ^= t + (t ^ (t >> 7)) * (t | 61);
                return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0;
            };
        }
    }
}

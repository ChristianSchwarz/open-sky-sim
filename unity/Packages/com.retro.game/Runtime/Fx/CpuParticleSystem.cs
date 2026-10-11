using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>One pooled particle (particleSystem.ts Particle).</summary>
    public sealed class CpuParticle
    {
        public bool IsActive;
        public double Life;
        public double Lifespan;
        public int Spawns;
        public Vec3d Position;
        public Vec3d Velocity;
        public double SizeStart;
        public double SizeEnd;
        public double RotationStart;
        public double RotationEnd;
    }

    /// <summary>particleSystem.ts ParticleSystemConfiguration.</summary>
    public sealed class CpuParticleSystemConfig
    {
        public int SystemMaxParticles;
        public bool SystemReSpawn;
        public double EmitterSpawnRatePerSecond;
        public double ParticleLifeMin;
        public double ParticleLifeMax;
        public double ParticleSizeStartMin;
        public double ParticleSizeStartMax;
        public double ParticleSizeEndMin;
        public double ParticleSizeEndMax;
        public double ParticleRotationStartMin;
        public double ParticleRotationStartMax;
        public double ParticleRotationEndMin;
        public double ParticleRotationEndMax;
    }

    /// <summary>
    /// Fixed-pool CPU particle system (port of physics/particles/particleSystem.ts
    /// with its PointEmitter). Every Math.random draw goes through the injected
    /// <c>random</c>, in the TS order, so a seeded source replays the oracle:
    /// per spawn 4 emitter draws (direction xyz, speed) then 5 config draws (life,
    /// size start, size end, rotation start, rotation end), and one draw per
    /// <see cref="Update"/> for the fractional spawn while the pool has room.
    /// A custom <see cref="ICpuParticleEmitter"/> (e.g. <see cref="SphereParticleEmitter"/>)
    /// replaces the point emitter's 4 draws with its own. Forces (<see cref="AddForce"/>)
    /// and <see cref="Rebase"/> are ported (added for debrisField.ts); the bounding box is not.
    /// </summary>
    public sealed class CpuParticleSystem
    {
        private readonly CpuParticleSystemConfig config;
        private readonly Func<double> random;
        private readonly double emitterMinSpeed;
        private readonly double emitterMaxSpeed;
        /// <summary>When set, replaces the built-in PointEmitter.</summary>
        private readonly ICpuParticleEmitter emitter;
        private readonly System.Collections.Generic.List<ICpuParticleForce> forces = new System.Collections.Generic.List<ICpuParticleForce>();
        private int aliveCount;

        public readonly CpuParticle[] Particles;

        /// <summary>The emitter position (ParticleSystem.position).</summary>
        public Vec3d Position;

        /// <summary>Spawning by rate in <see cref="Update"/> (the TS `spawning` flag, always true there).</summary>
        public bool Spawning = true;

        public int AliveCount => aliveCount;

        /// <param name="emitterMinSpeed">PointEmitter minSpeed.</param>
        /// <param name="emitterMaxSpeed">PointEmitter maxSpeed.</param>
        public CpuParticleSystem(CpuParticleSystemConfig config, double emitterMinSpeed, double emitterMaxSpeed, Func<double> random)
        {
            this.config = config;
            this.random = random ?? throw new ArgumentNullException(nameof(random));
            this.emitterMinSpeed = emitterMinSpeed;
            this.emitterMaxSpeed = emitterMaxSpeed;
            Particles = new CpuParticle[config.SystemMaxParticles];
            for (int i = 0; i < Particles.Length; i++)
            {
                Particles[i] = new CpuParticle();
            }
        }

        /// <summary>A system whose particles are placed by <paramref name="emitter"/> instead of the PointEmitter.</summary>
        public CpuParticleSystem(CpuParticleSystemConfig config, ICpuParticleEmitter emitter, Func<double> random)
            : this(config, 0, 0, random)
        {
            this.emitter = emitter ?? throw new ArgumentNullException(nameof(emitter));
        }

        /// <summary>particleSystem.ts addForce: applied to every live particle each update, in order.</summary>
        public void AddForce(ICpuParticleForce force)
        {
            forces.Add(force ?? throw new ArgumentNullException(nameof(force)));
        }

        /// <summary>
        /// particleSystem.ts rebase: the emitter position and every particle (live or not)
        /// are carried into the re-based frame (positions as points, velocities as vectors).
        /// </summary>
        public void Rebase(FrameShift shift)
        {
            Position = shift.Point(Position);
            foreach (CpuParticle p in Particles)
            {
                p.Position = shift.Point(p.Position);
                p.Velocity = shift.Vector(p.Velocity);
            }
        }

        public void Reset()
        {
            aliveCount = 0;
            foreach (CpuParticle p in Particles)
            {
                p.IsActive = false;
                p.Spawns = 0;
            }
        }

        /// <summary>
        /// Activate up to <paramref name="count"/> free particles at <see cref="Position"/>;
        /// with <paramref name="recycle"/> the oldest live ones are freed first when the pool is full.
        /// Returns the number newly activated.
        /// </summary>
        public int Burst(int count, bool recycle = false)
        {
            if (count <= 0)
            {
                return 0;
            }
            int want = Math.Min(count, config.SystemMaxParticles);
            if (recycle)
            {
                int free = config.SystemMaxParticles - aliveCount;
                if (free < want)
                {
                    FreeOldest(want - free);
                }
            }
            else if (aliveCount >= config.SystemMaxParticles)
            {
                return 0;
            }
            int before = aliveCount;
            SpawnParticles(Math.Min(want, config.SystemMaxParticles - aliveCount));
            return aliveCount - before;
        }

        private void FreeOldest(int n)
        {
            for (int freed = 0; freed < n; freed++)
            {
                int best = -1;
                double bestLife = -1;
                for (int i = 0; i < config.SystemMaxParticles; i++)
                {
                    CpuParticle p = Particles[i];
                    if (p.IsActive && p.Life > bestLife)
                    {
                        bestLife = p.Life;
                        best = i;
                    }
                }
                if (best < 0)
                {
                    break;
                }
                Particles[best].IsActive = false;
                aliveCount--;
            }
        }

        public void Update(double delta)
        {
            if (aliveCount < config.SystemMaxParticles && Spawning)
            {
                SpawnParticles(ComputeParticleCountForSpawn(delta));
            }
            for (int i = 0; i < config.SystemMaxParticles; i++)
            {
                CpuParticle p = Particles[i];
                if (!p.IsActive)
                {
                    continue;
                }
                p.Life += delta;
                if (p.Life > p.Lifespan)
                {
                    p.IsActive = false;
                    aliveCount--;
                }
                else
                {
                    for (int f = 0; f < forces.Count; f++)
                    {
                        forces[f].Apply(delta, p);
                    }
                    p.Position = p.Position.AddScaled(p.Velocity, delta);
                }
            }
        }

        private int ComputeParticleCountForSpawn(double delta)
        {
            double perDelta = delta * config.EmitterSpawnRatePerSecond;
            double b = Math.Floor(perDelta);
            double fract = perDelta - b;
            int heuristic = random() < fract ? 1 : 0;
            return (int)b + heuristic;
        }

        private void SpawnParticles(int toSpawn)
        {
            int spawned = 0;
            for (int i = 0; i < config.SystemMaxParticles && spawned < toSpawn && aliveCount < config.SystemMaxParticles; i++)
            {
                CpuParticle p = Particles[i];
                if (!p.IsActive && (config.SystemReSpawn || p.Spawns == 0))
                {
                    SpawnSingle(p);
                    spawned++;
                }
            }
        }

        private void SpawnSingle(CpuParticle p)
        {
            aliveCount++;
            p.IsActive = true;
            p.Spawns++;

            if (emitter != null)
            {
                emitter.Emit(Position, p, random);
            }
            else
            {
                EmitPoint(p);
            }

            p.Life = 0;
            p.Lifespan = RandomRange(config.ParticleLifeMin, config.ParticleLifeMax);
            p.SizeStart = RandomRange(config.ParticleSizeStartMin, config.ParticleSizeStartMax);
            p.SizeEnd = RandomRange(config.ParticleSizeEndMin, config.ParticleSizeEndMax);
            p.RotationStart = RandomRange(config.ParticleRotationStartMin, config.ParticleRotationStartMax);
            p.RotationEnd = RandomRange(config.ParticleRotationEndMin, config.ParticleRotationEndMax);
        }

        /// <summary>PointEmitter.emit.</summary>
        private void EmitPoint(CpuParticle p)
        {
            p.Position = Position;
            double vx = random() * 2 - 1;
            double vy = random() * 2 - 1;
            double vz = random() * 2 - 1;
            double speed = Lerp(random(), emitterMinSpeed, emitterMaxSpeed);
            p.Velocity = new Vec3d(vx, vy, vz).Normalized() * speed;
        }

        private static double Lerp(double t, double n0, double n1) => n0 + t * (n1 - n0);

        private double RandomRange(double min, double max) => Lerp(random(), min, max);
    }
}

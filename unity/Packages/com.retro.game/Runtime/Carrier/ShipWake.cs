using System;
using Retro.Core;
using Retro.Sim;

namespace Retro.Game
{
    /// <summary>
    /// Ship wake foam (port of shipWake.ts ShipWakeEntity, CPU half): one stern
    /// churn emitter and four Kelvin bow-wave arms (inner +-19.47 deg, outer
    /// +-38.94 deg) feeding a 2000-puff pool, plus the 2 km
    /// <see cref="SternWakeRibbon"/> behind the transom.
    ///
    /// After <see cref="Update"/> the live puffs are compacted into the instance
    /// arrays exactly as the TS fills its InstancedBufferAttributes (float32):
    /// the first <see cref="InstanceCount"/> entries are this frame's.
    /// </summary>
    public sealed class ShipWake
    {
        /// <summary>Kelvin full apex (deg).</summary>
        public const double KelvinFullAngleDeg = 38.94;
        public const double KelvinHalfAngleDeg = KelvinFullAngleDeg * 0.5;

        /// <summary>Pool size; steady-state demand (~1000-1700) fits without recycling.</summary>
        public const int FoamParticleCount = 2000;
        /// <summary>Puff height above the sea surface (m).</summary>
        public const double FoamSurfaceY = 0.18;

        public const double SternLifeMin = 10;
        public const double SternLifeSpan = 6;
        /// <summary>Speed of foam along each Kelvin arm (m/s), world frame.</summary>
        public const double BowArmSpeedMps = 4.5;

        public const double SternDitherStart = 0.72;
        public const double SternDitherEnd = 0.55;
        public const double BowDitherStart = 0.7;
        public const double BowDitherEnd = 0.1;

        /// <summary>three.js Color('#e8f0f4') in linear RGB (ColorManagement converts sRGB hex on parse).</summary>
        public static readonly double[] SternColor = { 0.8069522576650873, 0.8713671191959567, 0.9046611743890203 };
        /// <summary>three.js Color('#ffffff').</summary>
        public static readonly double[] BowColor = { 1, 1, 1 };

        private enum FoamKind { Stern, Bow }

        private sealed class FoamEmitter
        {
            public double LX, LY, LZ;
            public FoamKind Kind;
            public double Rate;
            public double? ArmDeg;
        }

        private static readonly double MidX = ArrestorCables.ArrestorDeckMidX;

        /// <summary>Stern first, then the four bow arms port-outer to starboard-outer (TS ALL_EMITTERS order).</summary>
        private static readonly FoamEmitter[] Emitters =
        {
            new FoamEmitter { LX = MidX, LY = 0.25, LZ = 122, Kind = FoamKind.Stern, Rate = 22 },
            new FoamEmitter { LX = MidX, LY = 0.3, LZ = -176, Kind = FoamKind.Bow, Rate = 12, ArmDeg = -KelvinFullAngleDeg },
            new FoamEmitter { LX = MidX, LY = 0.3, LZ = -176, Kind = FoamKind.Bow, Rate = 12, ArmDeg = -KelvinHalfAngleDeg },
            new FoamEmitter { LX = MidX, LY = 0.3, LZ = -176, Kind = FoamKind.Bow, Rate = 12, ArmDeg = KelvinHalfAngleDeg },
            new FoamEmitter { LX = MidX, LY = 0.3, LZ = -176, Kind = FoamKind.Bow, Rate = 12, ArmDeg = KelvinFullAngleDeg },
        };

        private readonly CpuParticleSystem system;
        private readonly Func<double> random;
        private readonly FoamKind[] kinds = new FoamKind[FoamParticleCount];
        private readonly double[] tint = new double[FoamParticleCount * 3];
        /// <summary>The TS keeps these accumulators in a Float32Array.</summary>
        private readonly float[] emitAccum = new float[Emitters.Length];

        /// <summary>The 2 km dithered strip; updated first in <see cref="Update"/>.</summary>
        public readonly SternWakeRibbon SternRibbon = new SternWakeRibbon();

        /// <summary>Per live puff its centre xyz in scene space, float32 (the TS `offset` attribute).</summary>
        public readonly float[] Offsets = new float[FoamParticleCount * 3];

        /// <summary>Per live puff its centre in double, for camera-relative placement.</summary>
        public readonly Vec3d[] OffsetsWorld = new Vec3d[FoamParticleCount];

        /// <summary>Per live puff the disc radius (m), float32 (`scale`).</summary>
        public readonly float[] Scales = new float[FoamParticleCount];

        /// <summary>Per live puff the disc rotation about the vertical (rad), float32 (`rotation`).</summary>
        public readonly float[] Rotations = new float[FoamParticleCount];

        /// <summary>
        /// Per live puff rgba, float32 (`color`): linear foam tint, and in a its dither
        /// opacity (stern 0.72 -> 0.55, bow 0.7 -> 0.1 over the puff's life).
        /// </summary>
        public readonly float[] Colors = new float[FoamParticleCount * 4];

        /// <summary>Live puffs written this frame (the instance count).</summary>
        public int InstanceCount { get; private set; }

        /// <summary>The underlying pool (for inspection).</summary>
        public CpuParticleSystem System => system;

        /// <param name="random">Math.random stand-in in [0, 1); seed it to replay the oracle.</param>
        public ShipWake(Func<double> random)
        {
            this.random = random ?? throw new ArgumentNullException(nameof(random));
            system = new CpuParticleSystem(new CpuParticleSystemConfig
            {
                SystemMaxParticles = FoamParticleCount,
                SystemReSpawn = true,
                EmitterSpawnRatePerSecond = 0,
                ParticleLifeMin = SternLifeMin,
                ParticleLifeMax = SternLifeMin + SternLifeSpan,
                ParticleSizeStartMin = 4,
                ParticleSizeStartMax = 7,
                ParticleSizeEndMin = 16,
                ParticleSizeEndMax = 26,
                ParticleRotationStartMin = 0,
                ParticleRotationStartMax = Math.PI * 2,
                ParticleRotationEndMin = -Math.PI,
                ParticleRotationEndMax = Math.PI,
            }, 0, 0, this.random);
            for (int i = 0; i < FoamParticleCount; i++)
            {
                kinds[i] = FoamKind.Stern;
                tint[i * 3] = SternColor[0];
                tint[i * 3 + 1] = SternColor[1];
                tint[i * 3 + 2] = SternColor[2];
            }
        }

        private void UpdateSternRibbon(ArrestorCarrierPose pose)
        {
            Vec3d stern = new Vec3d(Emitters[0].LX, 0, Emitters[0].LZ);
            Vec3d aft = new Vec3d(0, 0, 1);
            if (pose.Quaternion.HasValue)
            {
                stern = stern.Rotate(pose.Quaternion.Value);
                aft = aft.Rotate(pose.Quaternion.Value);
            }
            stern = stern + pose.Position;
            SternRibbon.Update(stern, aft);
        }

        /// <summary>One frame: ribbon, emitters, the pool step, then the instance arrays.</summary>
        public void Update(double delta, ArrestorCarrierPose pose)
        {
            Quatd? q = pose.Quaternion;
            UpdateSternRibbon(pose);

            for (int e = 0; e < Emitters.Length; e++)
            {
                FoamEmitter emitter = Emitters[e];
                emitAccum[e] = (float)(emitAccum[e] + emitter.Rate * delta);
                int n = (int)Math.Floor((double)emitAccum[e]);
                if (n <= 0)
                {
                    continue;
                }
                emitAccum[e] = (float)(emitAccum[e] - (double)n);
                Vec3d emitPos = new Vec3d(emitter.LX, emitter.LY, emitter.LZ);
                if (q.HasValue)
                {
                    emitPos = emitPos.Rotate(q.Value);
                }
                emitPos = emitPos + pose.Position;
                emitPos.Y = Geodesy.SeaLevelSceneY(emitPos.X, emitPos.Z) + FoamSurfaceY;
                system.Position = emitPos;
                int left = system.Burst(n, true);
                CpuParticle[] particles = system.Particles;
                // The TS matches "just spawned" puffs by life 0 at the emitter point;
                // the four bow arms share one point, so later arms re-match the first
                // arm's puff (kept as is: see the integration notes).
                for (int i = 0; i < particles.Length && left > 0; i++)
                {
                    CpuParticle p = particles[i];
                    if (!p.IsActive || p.Life > 1e-6)
                    {
                        continue;
                    }
                    double dx = p.Position.X - emitPos.X;
                    double dy = p.Position.Y - emitPos.Y;
                    double dz = p.Position.Z - emitPos.Z;
                    if (dx * dx + dy * dy + dz * dz > 0.05)
                    {
                        continue;
                    }
                    kinds[i] = emitter.Kind;
                    p.Position.Y = emitPos.Y;
                    if (emitter.Kind == FoamKind.Bow)
                    {
                        p.Lifespan = 14 + random() * 14;
                        p.SizeStart = 2.0 + random() * 1.5;
                        p.SizeEnd = 8 + random() * 6;
                        double armDeg = emitter.ArmDeg ?? KelvinHalfAngleDeg;
                        double armRad = armDeg * Math.PI / 180;
                        Vec3d arm = new Vec3d(JsTrig.Sin(armRad), 0, JsTrig.Cos(armRad));
                        if (q.HasValue)
                        {
                            arm = arm.Rotate(q.Value);
                        }
                        double speed = BowArmSpeedMps * (0.85 + random() * 0.3);
                        p.Velocity = arm * speed;
                        tint[i * 3] = BowColor[0];
                        tint[i * 3 + 1] = BowColor[1];
                        tint[i * 3 + 2] = BowColor[2];
                    }
                    else
                    {
                        p.Lifespan = SternLifeMin + random() * SternLifeSpan;
                        p.SizeStart = 4 + random() * 3;
                        p.SizeEnd = 16 + random() * 10;
                        double vx = (random() - 0.5) * 0.25;
                        double vz = (random() - 0.5) * 0.25;
                        p.Velocity = new Vec3d(vx, 0, vz);
                        tint[i * 3] = SternColor[0];
                        tint[i * 3 + 1] = SternColor[1];
                        tint[i * 3 + 2] = SternColor[2];
                    }
                    left--;
                }
            }

            system.Update(delta);

            int count = 0;
            CpuParticle[] ps = system.Particles;
            for (int i = 0; i < ps.Length; i++)
            {
                CpuParticle p = ps[i];
                if (!p.IsActive)
                {
                    continue;
                }
                p.Position.Y = Geodesy.SeaLevelSceneY(p.Position.X, p.Position.Z) + FoamSurfaceY;
                p.Velocity.Y = 0;
                double t = p.Lifespan > 1e-6 ? p.Life / p.Lifespan : 1;
                double alpha = kinds[i] == FoamKind.Bow
                    ? BowDitherStart + (BowDitherEnd - BowDitherStart) * t
                    : SternDitherStart + (SternDitherEnd - SternDitherStart) * t;
                OffsetsWorld[count] = p.Position;
                Offsets[count * 3] = (float)p.Position.X;
                Offsets[count * 3 + 1] = (float)p.Position.Y;
                Offsets[count * 3 + 2] = (float)p.Position.Z;
                Scales[count] = (float)(p.SizeStart + (p.SizeEnd - p.SizeStart) * t);
                Rotations[count] = (float)(p.RotationStart + (p.RotationEnd - p.RotationStart) * t);
                Colors[count * 4] = (float)tint[i * 3];
                Colors[count * 4 + 1] = (float)tint[i * 3 + 1];
                Colors[count * 4 + 2] = (float)tint[i * 3 + 2];
                Colors[count * 4 + 3] = (float)alpha;
                count++;
            }
            InstanceCount = count;
        }
    }
}

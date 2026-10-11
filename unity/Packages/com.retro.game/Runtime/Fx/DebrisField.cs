using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Sim;

namespace Retro.Game
{
    /// <summary>One drawn debris chip or spark: its mesh transform as debrisField.ts sets it.</summary>
    public struct DebrisInstance
    {
        public bool Visible;
        public Vec3d Position;
        public Quatd Quaternion;
        public Vec3d Scale;
    }

    /// <summary>
    /// Hit debris (gun chips) plus short glowing scrape sparks at ground impacts
    /// (port of scene/entities/debrisField.ts, CPU half).
    ///
    /// Two particle pools: 48 chips (<see cref="SphereParticleEmitter"/> shell 1.5-3.5 m,
    /// 2-10 m/s, gravity + drag 0.55/s, life 2.5-4.5 s) and 48 sparks (shell
    /// 0.05-0.25 m, 8-22 m/s, 18 m/s^2 down + drag 1.2/s, life 0.12-0.35 s).
    /// Slot i of each pool is a fixed mesh with a fixed palette category
    /// (<see cref="ChipCategory"/>, <see cref="SparkCategory"/>); after every entry
    /// point and <see cref="Update"/> the slot transforms are in <see cref="Chips"/> /
    /// <see cref="Sparks"/> (scene frame, doubles) and, composed as three.js
    /// Matrix4.compose, in <see cref="ChipMatrices"/> / <see cref="SparkMatrices"/>
    /// (16 floats per slot, column-major like three.js; invisible slots keep their
    /// last matrix).
    ///
    /// Random draws (Math.random in the TS) go through the injected source: the
    /// constructor draws 3 per chip for its tumble axis (48 x 3), each burst draws
    /// per particle the sphere emitter's (3 per rejection try + radius + speed) then
    /// 5 config draws, and each <see cref="Update"/> draws one per pool that has room
    /// (the zero-rate spawn check), chips first.
    /// </summary>
    public sealed class DebrisField
    {
        /// <summary>defs.ts DEBRIS_PARTICLE_COUNT.</summary>
        public const int ChipCount = 48;
        public const int DebrisPerHit = 6;
        public const int DebrisMaxHitsPerFrame = 6;
        /// <summary>Inherit only a fraction of target velocity so chips visibly peel off.</summary>
        public const double DebrisVelocityInherit = 0.2;

        public const int SparkCount = 48;
        public const int SparksPerScrape = 10;
        public const int SparkMaxScrapesPerFrame = 6;
        /// <summary>Short streak length along travel (local +Z), metres.</summary>
        public const double SparkLengthM = 0.55;
        public const double SparkWidthM = 0.06;

        /// <summary>Gray / brown palette picks for metal and dirt chips; chip i uses [i % 6].</summary>
        public static readonly PaletteCategory[] DebrisColors =
        {
            PaletteCategory.VEHICLE_PLANE_GREY,
            PaletteCategory.SCENERY_BUILDING_CONCRETE,
            PaletteCategory.SCENERY_BUILDING_METAL,
            PaletteCategory.SCENERY_FIELD_OCHRE,
            PaletteCategory.SCENERY_TREE_TRUNK,
            PaletteCategory.SCENERY_ROAD_SECONDARY,
        };

        /// <summary>Hot glowing sparks for ground scrapes; spark i uses [i % 4].</summary>
        public static readonly PaletteCategory[] SparkColors =
        {
            PaletteCategory.FX_FIRE,
            PaletteCategory.FX_FIRE__B,
            PaletteCategory.LIGHT_YELLOW,
            PaletteCategory.SCENERY_FIELD_YELLOW,
        };

        public static PaletteCategory ChipCategory(int i) => DebrisColors[i % DebrisColors.Length];

        public static PaletteCategory SparkCategory(int i) => SparkColors[i % SparkColors.Length];

        /// <summary>
        /// The chip mesh: three.js PlaneGeometry(1, 1) positions (xyz x4, in the XY plane,
        /// facing +Z) and its triangles. Drawn double-sided.
        /// </summary>
        public static readonly float[] ChipPositions =
        {
            -0.5f, 0.5f, 0f, 0.5f, 0.5f, 0f, -0.5f, -0.5f, 0f, 0.5f, -0.5f, 0f,
        };

        public static readonly ushort[] ChipIndices = { 0, 2, 1, 2, 3, 1 };

        /// <summary>The spark mesh: three.js BoxGeometry(0.06, 0.06, 0.55) positions (24 vertices) and triangles.</summary>
        public static readonly float[] SparkPositions;

        public static readonly ushort[] SparkIndices;

        static DebrisField()
        {
            BuildBox(SparkWidthM, SparkWidthM, SparkLengthM, out SparkPositions, out SparkIndices);
        }

        private readonly Func<double> random;
        private readonly SphereParticleEmitter emitter;
        private readonly SphereParticleEmitter sparkEmitter;

        /// <summary>Per-chip tumble axis (unit vectors).</summary>
        private readonly Vec3d[] spinAxes = new Vec3d[ChipCount];

        public readonly CpuParticleSystem DebrisSystem;
        public readonly CpuParticleSystem SparkSystem;

        public readonly DebrisInstance[] Chips = new DebrisInstance[ChipCount];
        public readonly DebrisInstance[] Sparks = new DebrisInstance[SparkCount];

        /// <summary>Per chip slot its model matrix (three.js compose of <see cref="Chips"/>), float32, 16 per slot.</summary>
        public readonly float[] ChipMatrices = new float[ChipCount * 16];

        /// <summary>Per spark slot its model matrix, float32, 16 per slot.</summary>
        public readonly float[] SparkMatrices = new float[SparkCount * 16];

        /// <param name="random">Math.random stand-in in [0, 1); seed it to replay the oracle.</param>
        public DebrisField(Func<double> random)
        {
            this.random = random ?? throw new ArgumentNullException(nameof(random));

            // Tight shell + low kick so chips peel off the hull instead of exploding out.
            emitter = new SphereParticleEmitter(1.5, 3.5, 2, 10);
            DebrisSystem = new CpuParticleSystem(new CpuParticleSystemConfig
            {
                SystemMaxParticles = ChipCount,
                SystemReSpawn = true,
                EmitterSpawnRatePerSecond = 0,
                ParticleLifeMin = 2.5,
                ParticleLifeMax = 4.5,
                ParticleSizeStartMin = 0.6,
                ParticleSizeStartMax = 1.4,
                ParticleSizeEndMin = 0.3,
                ParticleSizeEndMax = 0.8,
                ParticleRotationStartMin = 0,
                ParticleRotationStartMax = Math.PI * 2,
                ParticleRotationEndMin = Math.PI * 4,
                ParticleRotationEndMax = Math.PI * 10,
            }, emitter, this.random);
            DebrisSystem.AddForce(new ConstantParticleForce(new Vec3d(0, -9.80665, 0)));
            DebrisSystem.AddForce(new LinearDragParticleForce(0.55));

            for (int i = 0; i < ChipCount; i++)
            {
                double x = this.random() * 2 - 1;
                double y = this.random() * 2 - 1;
                double z = this.random() * 2 - 1;
                spinAxes[i] = new Vec3d(x, y, z).Normalized();
            }

            // Short bright streaks kicked up from the ground contact.
            sparkEmitter = new SphereParticleEmitter(0.05, 0.25, 8, 22);
            SparkSystem = new CpuParticleSystem(new CpuParticleSystemConfig
            {
                SystemMaxParticles = SparkCount,
                SystemReSpawn = true,
                EmitterSpawnRatePerSecond = 0,
                ParticleLifeMin = 0.12,
                ParticleLifeMax = 0.35,
                ParticleSizeStartMin = 0.7,
                ParticleSizeStartMax = 1.2,
                ParticleSizeEndMin = 0.15,
                ParticleSizeEndMax = 0.4,
                ParticleRotationStartMin = 0,
                ParticleRotationStartMax = 0,
                ParticleRotationEndMin = 0,
                ParticleRotationEndMax = 0,
            }, sparkEmitter, this.random);
            SparkSystem.AddForce(new ConstantParticleForce(new Vec3d(0, -18, 0)));
            SparkSystem.AddForce(new LinearDragParticleForce(1.2));

            for (int i = 0; i < ChipCount; i++) Identity(ChipMatrices, i * 16);
            for (int i = 0; i < SparkCount; i++) Identity(SparkMatrices, i * 16);
        }

        /// <summary>The tumble axis chip <paramref name="i"/> spins about.</summary>
        public Vec3d SpinAxis(int i) => spinAxes[i];

        /// <summary>Carry both pools into a re-based frame.</summary>
        public void Rebase(FrameShift shift)
        {
            DebrisSystem.Rebase(shift);
            SparkSystem.Rebase(shift);
        }

        /// <summary>
        /// Spawn a short burst at each gun hit (the first 6 events; scrapes among them
        /// are skipped, not replaced). game.ts passes only the non-scrape hits.
        /// </summary>
        public void SpawnFromHits(IReadOnlyList<SimHitEvent> hits)
        {
            int n = Math.Min(hits.Count, DebrisMaxHitsPerFrame);
            for (int i = 0; i < n; i++)
            {
                SimHitEvent hit = hits[i];
                if (hit.Source == "scrape")
                {
                    continue;
                }
                var pos = new Vec3d(hit.Position[0], hit.Position[1], hit.Position[2]);
                var vel = new Vec3d(
                    hit.Velocity[0] * DebrisVelocityInherit,
                    hit.Velocity[1] * DebrisVelocityInherit,
                    hit.Velocity[2] * DebrisVelocityInherit);
                BurstDebrisAt(pos, vel);
            }
            SyncDebrisMeshes();
        }

        /// <summary>
        /// Short glowing streaks at terrain scrape points (up to 6 scrape events a call;
        /// non-scrapes are skipped). Bias kicks sparks along the aircraft motion and up.
        /// game.ts passes only the scrapes that are not on water.
        /// </summary>
        public void SpawnGroundScrapes(IReadOnlyList<SimHitEvent> hits)
        {
            int spawned = 0;
            for (int i = 0; i < hits.Count && spawned < SparkMaxScrapesPerFrame; i++)
            {
                SimHitEvent hit = hits[i];
                if (hit.Source != "scrape")
                {
                    continue;
                }
                var pos = new Vec3d(hit.Position[0], hit.Position[1], hit.Position[2]);
                var vel = new Vec3d(
                    hit.Velocity[0] * 0.15,
                    hit.Velocity[1] * 0.15 + 6,
                    hit.Velocity[2] * 0.15);
                sparkEmitter.SetVelocityBias(vel);
                SparkSystem.Position = pos;
                SparkSystem.Burst(SparksPerScrape, true);
                spawned++;
            }
            SyncSparkMeshes();
        }

        /// <summary>
        /// One burst of 6 chips at a world position (the Tab debug key, and the wreck
        /// field's onBreakup / onSplit callbacks); the velocity is inherited at 20 %.
        /// </summary>
        public void SpawnDebugBurst(Vec3d position, Vec3d? velocity = null)
        {
            Vec3d bias = velocity.HasValue ? velocity.Value * DebrisVelocityInherit : Vec3d.Zero;
            BurstDebrisAt(position, bias);
            SyncDebrisMeshes();
        }

        private void BurstDebrisAt(Vec3d position, Vec3d velocityBias, int count = DebrisPerHit)
        {
            emitter.SetVelocityBias(velocityBias);
            DebrisSystem.Position = position;
            DebrisSystem.Burst(count, true);
        }

        /// <summary>One frame: both pools step (chips first), then the slot transforms.</summary>
        public void Update(double delta)
        {
            DebrisSystem.Update(delta);
            SparkSystem.Update(delta);
            SyncDebrisMeshes();
            SyncSparkMeshes();
        }

        private void SyncDebrisMeshes()
        {
            for (int i = 0; i < ChipCount; i++)
            {
                CpuParticle p = DebrisSystem.Particles[i];
                if (!p.IsActive)
                {
                    Chips[i].Visible = false;
                    continue;
                }
                double progress = p.Life / p.Lifespan;
                double size = p.SizeStart + (p.SizeEnd - p.SizeStart) * progress;
                double angle = p.RotationStart + (p.RotationEnd - p.RotationStart) * progress;
                var inst = new DebrisInstance
                {
                    Visible = true,
                    Position = p.Position,
                    Scale = new Vec3d(size, size * (0.55 + (i % 3) * 0.15), 1),
                    Quaternion = Quatd.FromAxisAngle(spinAxes[i], angle),
                };
                Chips[i] = inst;
                Compose(ChipMatrices, i * 16, inst);
            }
        }

        private static readonly Vec3d ForwardZ = new Vec3d(0, 0, 1);

        private void SyncSparkMeshes()
        {
            for (int i = 0; i < SparkCount; i++)
            {
                CpuParticle p = SparkSystem.Particles[i];
                if (!p.IsActive)
                {
                    Sparks[i].Visible = false;
                    continue;
                }
                double progress = p.Life / p.Lifespan;
                double lenScale = p.SizeStart + (p.SizeEnd - p.SizeStart) * progress;
                // Thin streak: shrink width as it dies, keep some length along velocity.
                double w = 0.7 + (1 - progress) * 0.5;
                Vec3d fwd = p.Velocity;
                fwd = fwd.LengthSquared < 1e-6 ? new Vec3d(0, 1, 0) : fwd.Normalized();
                var inst = new DebrisInstance
                {
                    Visible = true,
                    Position = p.Position,
                    Scale = new Vec3d(w, w, lenScale),
                    Quaternion = Quatd.FromUnitVectors(ForwardZ, fwd),
                };
                Sparks[i] = inst;
                Compose(SparkMatrices, i * 16, inst);
            }
        }

        private static void Identity(float[] te, int o)
        {
            for (int k = 0; k < 16; k++) te[o + k] = 0f;
            te[o] = te[o + 5] = te[o + 10] = te[o + 15] = 1f;
        }

        /// <summary>three.js Matrix4.compose, then each element to float32.</summary>
        internal static void Compose(float[] te, int o, Vec3d p, Quatd q, Vec3d s)
        {
            double[] e = Mat4d.Compose(p, q, s).E;
            for (int k = 0; k < 16; k++) te[o + k] = (float)e[k];
        }

        private static void Compose(float[] te, int o, DebrisInstance inst) =>
            Compose(te, o, inst.Position, inst.Quaternion, inst.Scale);

        /// <summary>three.js BoxGeometry(width, height, depth) with one segment per side: positions (float32) and indices.</summary>
        internal static void BuildBox(double width, double height, double depth, out float[] positions, out ushort[] indices)
        {
            var pos = new List<float>(72);
            var idx = new List<ushort>(36);
            int vertexCount = 0;
            // u, v, w axis indices (x = 0, y = 1, z = 2) as three.js passes them.
            void BuildPlane(int u, int v, int w, double udir, double vdir, double pw, double ph, double pd)
            {
                double widthHalf = pw / 2, heightHalf = ph / 2, depthHalf = pd / 2;
                double segW = pw / 1, segH = ph / 1;
                for (int iy = 0; iy < 2; iy++)
                {
                    double y = iy * segH - heightHalf;
                    for (int ix = 0; ix < 2; ix++)
                    {
                        double x = ix * segW - widthHalf;
                        var vec = new double[3];
                        vec[u] = x * udir;
                        vec[v] = y * vdir;
                        vec[w] = depthHalf;
                        pos.Add((float)vec[0]);
                        pos.Add((float)vec[1]);
                        pos.Add((float)vec[2]);
                    }
                }
                int a = vertexCount, b = vertexCount + 2, c = vertexCount + 3, d = vertexCount + 1;
                idx.Add((ushort)a); idx.Add((ushort)b); idx.Add((ushort)d);
                idx.Add((ushort)b); idx.Add((ushort)c); idx.Add((ushort)d);
                vertexCount += 4;
            }
            BuildPlane(2, 1, 0, -1, -1, depth, height, width);   // px
            BuildPlane(2, 1, 0, 1, -1, depth, height, -width);   // nx
            BuildPlane(0, 2, 1, 1, 1, width, depth, height);     // py
            BuildPlane(0, 2, 1, 1, -1, width, depth, -height);   // ny
            BuildPlane(0, 1, 2, 1, -1, width, height, depth);    // pz
            BuildPlane(0, 1, 2, -1, -1, width, height, -depth);  // nz
            positions = pos.ToArray();
            indices = idx.ToArray();
        }
    }
}

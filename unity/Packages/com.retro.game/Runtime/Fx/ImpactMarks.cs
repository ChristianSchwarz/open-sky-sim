using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// One instanced mesh of flat stippled blobs kept as a ring buffer (port of
    /// impactMarks.ts MarkPool). The draw inputs are <see cref="Matrices"/> (the
    /// InstancedMesh instanceMatrix: 16 float32 per instance, column-major, scene
    /// frame) and <see cref="Levels"/> (the per-instance `ditherLevel` attribute,
    /// float32); draw the first <see cref="Count"/> instances when <see cref="Visible"/>.
    /// </summary>
    public sealed class MarkPool
    {
        private sealed class Mark
        {
            public Vec3d Position;
            public Quatd Quaternion;
            public double Width = 1;
            public double Length = 1;
            /// <summary>Darkness it is heading for, and how fast it gets there (level per second); 0 rate = fixed.</summary>
            public double Target;
            public double Rate;
            /// <summary>Laid on a moving surface (a carrier deck): it goes along with it.</summary>
            public bool Moving;
        }

        private readonly List<Mark> marks = new List<Mark>();
        private readonly Func<double> random;
        private int next;
        /// <summary>Marks still darkening.</summary>
        private int growing;
        /// <summary>Marks that move with a surface.</summary>
        private int movers;

        public readonly int Capacity;

        /// <summary>instanceMatrix: 16 float32 per instance (identity until written).</summary>
        public readonly float[] Matrices;

        /// <summary>ditherLevel: one float32 per instance (0.42 until written).</summary>
        public readonly float[] Levels;

        /// <summary>Instances to draw (InstancedMesh.count): the marks laid so far, up to the capacity.</summary>
        public int Count => marks.Count;

        /// <summary>The mesh's visible flag: on after the first mark, off after <see cref="Clear"/>.</summary>
        public bool Visible { get; private set; }

        /// <summary>The ring-buffer slot the next mark goes into.</summary>
        public int Next => next;

        internal MarkPool(int capacity, Func<double> random)
        {
            Capacity = capacity;
            this.random = random;
            Matrices = new float[capacity * 16];
            Levels = new float[capacity];
            for (int i = 0; i < capacity; i++)
            {
                Levels[i] = (float)ImpactMarks.DitherMax;
                Matrices[i * 16] = Matrices[i * 16 + 5] = Matrices[i * 16 + 10] = Matrices[i * 16 + 15] = 1f;
            }
        }

        /// <summary>The mark in slot <paramref name="i"/>: its centre (lifted), orientation, width and length.</summary>
        public (Vec3d Position, Quatd Quaternion, double Width, double Length, double Target, double Rate, bool Moving) MarkAt(int i)
        {
            Mark m = marks[i];
            return (m.Position, m.Quaternion, m.Width, m.Length, m.Target, m.Rate, m.Moving);
        }

        internal void Add(
            Vec3d position, Vec3d normal, double dirX, double dirZ,
            double length, double width, double level, double target, double rate, bool moving)
        {
            Mark mark;
            if (next >= marks.Count)
            {
                mark = new Mark();
                marks.Add(mark);
            }
            else
            {
                mark = marks[next];
                if (mark.Rate > 0 && Levels[next] < mark.Target)
                {
                    // Overwriting a mark that was still darkening.
                    growing--;
                }
            }
            mark.Position = position.AddScaled(normal, ImpactMarks.SurfaceEpsilonM);
            double heading = JsMath.Hypot(dirX, dirZ) > 1e-6 ? JsTrig.Atan2(dirX, dirZ) : random() * Math.PI * 2;
            Quatd yaw = Quatd.FromAxisAngle(Vec3d.UnitY, heading);
            Quatd tilt = Quatd.FromUnitVectors(Vec3d.UnitY, normal);
            mark.Quaternion = tilt * yaw;
            mark.Width = width;
            mark.Length = length;
            mark.Target = target;
            mark.Rate = rate;
            if (mark.Moving)
            {
                movers--;
            }
            mark.Moving = moving;
            if (moving)
            {
                movers++;
            }
            if (rate > 0)
            {
                growing++;
            }

            Levels[next] = (float)level;
            Write(next, mark, rate > 0 ? ImpactMarks.BurnStartSize : 1);
            next = (next + 1) % Capacity;
            Visible = true;
        }

        private double Done(int i, Mark m) =>
            (Levels[i] - ImpactMarks.BurnStartLevel) / Math.Max(1e-6, m.Target - ImpactMarks.BurnStartLevel);

        private static double GrowSize(double done) =>
            ImpactMarks.BurnStartSize + (1 - ImpactMarks.BurnStartSize) * Math.Min(1, done);

        /// <summary>Darken the marks that are still darkening, and let them grow to full size.</summary>
        internal void Update(double delta)
        {
            if (growing <= 0)
            {
                return;
            }
            int still = 0;
            for (int i = 0; i < marks.Count; i++)
            {
                Mark mark = marks[i];
                if (mark.Rate <= 0 || Levels[i] >= mark.Target)
                {
                    continue;
                }
                Levels[i] = (float)Math.Min(mark.Target, Levels[i] + mark.Rate * delta);
                Write(i, mark, GrowSize(Done(i, mark)));
                if (Levels[i] < mark.Target)
                {
                    still++;
                }
            }
            growing = still;
        }

        /// <summary>Move the marks laid on a moving surface along with it.</summary>
        internal void Carry(Vec3d velocity, double delta)
        {
            if (movers <= 0)
            {
                return;
            }
            for (int i = 0; i < marks.Count; i++)
            {
                Mark m = marks[i];
                if (!m.Moving)
                {
                    continue;
                }
                m.Position = m.Position.AddScaled(velocity, delta);
                Write(i, m, m.Rate > 0 ? GrowSize(Done(i, m)) : 1);
            }
        }

        internal void Clear()
        {
            marks.Clear();
            next = 0;
            growing = 0;
            movers = 0;
            Visible = false;
        }

        internal void Rebase(FrameShift shift)
        {
            for (int i = 0; i < marks.Count; i++)
            {
                Mark m = marks[i];
                m.Position = shift.Point(m.Position);
                m.Quaternion = shift.Orientation(m.Quaternion);
                Write(i, m, m.Rate > 0 ? GrowSize(Done(i, m)) : 1);
            }
        }

        private void Write(int index, Mark mark, double size)
        {
            DebrisField.Compose(Matrices, index * 16, mark.Position, mark.Quaternion,
                new Vec3d(mark.Width * size, 1, mark.Length * size));
        }
    }

    /// <summary>
    /// Scorch, pock and gouge marks left on the ground by a crash, and the burn
    /// marks that appear under its fires as they burn (port of
    /// scene/entities/impactMarks.ts, CPU half). Each is a flat stippled blob
    /// (<see cref="BlobPositions"/>, an 8-sided disc of diameter 1 lying in XZ)
    /// stretched to width (x) by length (z), laid on the ground with its normal,
    /// like the aircraft's ground shadow.
    ///
    /// Two pools, each one instanced mesh: <see cref="Impact"/> (400 scars, fixed
    /// darkness) and <see cref="Burn"/> (600 burn marks that start invisible and
    /// darken and grow over their grow time), so burns never push out the scars.
    /// Marks laid where the <see cref="IMovingSurface"/> says "on deck" ride with it.
    /// Math.random is drawn only when a mark has no direction (a random heading).
    /// </summary>
    public sealed class ImpactMarks
    {
        /// <summary>Impact marks kept at once; past this the oldest is overwritten.</summary>
        public const int MaxMarks = 400;
        /// <summary>Burn marks kept at once, in a pool of their own.</summary>
        public const int MaxBurnMarks = 600;
        /// <summary>Lift above the ground so a mark clears coplanar terrain depth.</summary>
        public const double SurfaceEpsilonM = 0.12;
        public const double DitherMin = 0.12;
        public const double DitherMax = 0.42;
        /// <summary>Burn marks start at a level too thin to see (0 would mean solid) and darken to their target.</summary>
        public const double BurnStartLevel = 0.004;
        public const double BurnLevelMin = 0.18;
        public const double BurnLevelMax = 0.6;
        /// <summary>A burn mark grows from this fraction of its final size as it darkens.</summary>
        public const double BurnStartSize = 0.55;

        /// <summary>Both pools draw in this palette category (black / dark grey tones).</summary>
        public const PaletteCategory Category = PaletteCategory.SCENERY_TREE_SHADOW;

        /// <summary>
        /// The blob mesh: three.js CircleGeometry(0.5, 8).rotateX(-PI/2) positions
        /// (10 vertices, centre first, float32; normal +Y) and its 8 triangles. Drawn double-sided.
        /// </summary>
        public static readonly float[] BlobPositions;

        public static readonly ushort[] BlobIndices;

        static ImpactMarks()
        {
            const int segments = 8;
            const double radius = 0.5;
            var raw = new double[(segments + 2) * 3];
            for (int s = 0, k = 3; s <= segments; s++, k += 3)
            {
                double segment = 0 + (double)s / segments * (Math.PI * 2);
                raw[k] = radius * JsTrig.Cos(segment);
                raw[k + 1] = radius * JsTrig.Sin(segment);
                raw[k + 2] = 0;
            }
            // rotateX(-PI/2): makeRotationX then Vector3.applyMatrix4 on the float32 attribute.
            double c = JsTrig.Cos(-Math.PI / 2), sn = JsTrig.Sin(-Math.PI / 2);
            double[] e = { 1, 0, 0, 0, 0, c, sn, 0, 0, -sn, c, 0, 0, 0, 0, 1 };
            BlobPositions = new float[raw.Length];
            for (int i = 0; i < raw.Length; i += 3)
            {
                double x = (float)raw[i], y = (float)raw[i + 1], z = (float)raw[i + 2];
                double w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
                BlobPositions[i] = (float)((e[0] * x + e[4] * y + e[8] * z + e[12]) * w);
                BlobPositions[i + 1] = (float)((e[1] * x + e[5] * y + e[9] * z + e[13]) * w);
                BlobPositions[i + 2] = (float)((e[2] * x + e[6] * y + e[10] * z + e[14]) * w);
            }
            BlobIndices = new ushort[segments * 3];
            for (int i = 1; i <= segments; i++)
            {
                BlobIndices[(i - 1) * 3] = (ushort)i;
                BlobIndices[(i - 1) * 3 + 1] = (ushort)(i + 1);
                BlobIndices[(i - 1) * 3 + 2] = 0;
            }
        }

        public readonly MarkPool Impact;
        public readonly MarkPool Burn;
        private IMovingSurface moving;

        /// <param name="random">Math.random stand-in in [0, 1) (headings of direction-less marks).</param>
        public ImpactMarks(Func<double> random)
        {
            if (random == null) throw new ArgumentNullException(nameof(random));
            Impact = new MarkPool(MaxMarks, random);
            Burn = new MarkPool(MaxBurnMarks, random);
        }

        /// <summary>
        /// Whether the entity attaches its meshes at all this frame (render3D skips
        /// when both pools are empty); each pool's own <see cref="MarkPool.Visible"/> still applies.
        /// </summary>
        public bool AnyMarks => Impact.Count + Burn.Count > 0;

        /// <summary>One frame: burns darken and grow, then marks on the moving surface ride along.</summary>
        public void Update(double delta)
        {
            Burn.Update(delta);
            if (moving != null)
            {
                Vec3d v = moving.Velocity;
                Impact.Carry(v, delta);
                Burn.Carry(v, delta);
            }
        }

        /// <summary>Marks laid on this surface go along with it (null: none).</summary>
        public void SetMovingSurface(IMovingSurface surface)
        {
            moving = surface;
        }

        /// <summary>
        /// Lay a mark (the wreck field's onMark, the fire pool's onPoolMark).
        /// <paramref name="position"/> is the ground point (lifted 0.12 m along the
        /// normal here), <paramref name="normal"/> the unit ground normal,
        /// dirX/dirZ the way its long axis runs (zero: a random heading).
        /// <paramref name="strength"/> 0..1 is how dark it is.
        /// </summary>
        public void Add(
            Vec3d position, Vec3d normal, double dirX, double dirZ,
            double length, double width, double strength)
        {
            double level = DitherMin + (DitherMax - DitherMin) * Math.Min(1, Math.Max(0, strength));
            Impact.Add(
                position, normal, dirX, dirZ, length, width, level, level, 0,
                moving?.Contains(position.X, position.Y, position.Z) ?? false);
        }

        /// <summary>
        /// Lay a burn mark under a fire (damage smoke's onBurnMark). It starts
        /// invisible and darkens, and grows to its full size, over
        /// <paramref name="growSeconds"/>; <paramref name="strength"/> 0..1 is how dark it ends up.
        /// </summary>
        public void AddBurn(
            Vec3d position, Vec3d normal, double dirX, double dirZ,
            double length, double width, double strength, double growSeconds)
        {
            double target = BurnLevelMin + (BurnLevelMax - BurnLevelMin) * Math.Min(1, Math.Max(0, strength));
            Burn.Add(
                position, normal, dirX, dirZ, length, width,
                BurnStartLevel, target, (target - BurnStartLevel) / Math.Max(0.1, growSeconds),
                moving?.Contains(position.X, position.Y, position.Z) ?? false);
        }

        public void Clear()
        {
            Impact.Clear();
            Burn.Clear();
        }

        public void Rebase(FrameShift shift)
        {
            Impact.Rebase(shift);
            Burn.Rebase(shift);
        }
    }
}

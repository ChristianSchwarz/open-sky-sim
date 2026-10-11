using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// Carrier stern wake (port of sternWake.ts SternWakeRibbon): a 2 km foam
    /// ribbon laid flat on the sea behind the ship, built from a ring buffer of
    /// past stern positions so it follows the track instead of the hull.
    ///
    /// Each segment is one flat quad with its own screen-space dither level
    /// (<see cref="SegmentDither"/>), ramping from dense foam at the transom to
    /// one 4x4 Bayer level at the far end. Vertices are root-relative: put the
    /// drawn object at <see cref="ObjectPosition"/> (scene space).
    /// </summary>
    public sealed class SternWakeRibbon
    {
        /// <summary>Total trail length astern (m).</summary>
        public const double LengthM = 2000;
        /// <summary>Quads along the trail.</summary>
        public const int SegmentCount = 50;
        /// <summary>Distance the ship travels between track samples (m).</summary>
        public const double SegmentLengthM = LengthM / SegmentCount;

        /// <summary>Dither opacity right behind the transom.</summary>
        public const double DitherHead = 0.6;
        /// <summary>One 4x4 Bayer level: the ramp ends here at 2 km rather than at 0.</summary>
        public const double DitherTail = 1.0 / 16;
        /// <summary>Foam half-width at the transom (m).</summary>
        public const double HalfWidthSternM = 16;
        /// <summary>Foam half-width at the far end (m).</summary>
        public const double HalfWidthTailM = 95;
        /// <summary>Ribbon height above the waterline (m); below the foam puffs.</summary>
        public const double SurfaceY = 0.1;

        /// <summary>Pale foam white #e8f0f4 (sRGB); the material's rawColor.</summary>
        public const string ColorHex = "#e8f0f4";

        private const int SampleCount = SegmentCount + 1;

        private readonly double[] historyX = new double[SampleCount];
        private readonly double[] historyZ = new double[SampleCount];
        private int head;
        private int count;
        private bool seeded;
        private double originX;
        private double originZ;
        private double originSeaY;

        private readonly double[] stripX = new double[SampleCount];
        private readonly double[] stripZ = new double[SampleCount];
        private readonly double[] stripNX = new double[SampleCount];
        private readonly double[] stripNZ = new double[SampleCount];
        private readonly double[] stripDist = new double[SampleCount];

        /// <summary>
        /// Per segment 4 vertices xyz, root-relative, float32 (SegmentCount * 12):
        /// segment j's quad at [j * 12, j * 12 + 12), drawn with index [0, 1, 2, 2, 1, 3].
        /// Vertices 0/1 are the nearer edge (right / left of the track), 2/3 the farther.
        /// </summary>
        public readonly float[] Positions = new float[SegmentCount * 12];

        /// <summary>Whether segment j is drawn this frame.</summary>
        public readonly bool[] SegmentVisible = new bool[SegmentCount];

        /// <summary>
        /// Per segment its fixed dither opacity (the material's alphaDither), sampled at
        /// the segment mid: 0.6 at the transom down to ~0.07 at 2 km.
        /// </summary>
        public readonly double[] SegmentDither = new double[SegmentCount];

        /// <summary>Root position: the live stern at sea level + <see cref="SurfaceY"/> (scene space).</summary>
        public Vec3d ObjectPosition { get; private set; }

        public SternWakeRibbon()
        {
            for (int i = 0; i < SegmentCount; i++)
            {
                SegmentDither[i] = AlphaAt((i + 0.5) * SegmentLengthM);
            }
        }

        /// <summary>sternWakeAlphaAt: dither opacity at a distance astern, linear over the trail.</summary>
        public static double AlphaAt(double distanceAsternM)
        {
            double t = JsMath.Clamp(distanceAsternM / LengthM, 0, 1);
            return DitherHead + t * (DitherTail - DitherHead);
        }

        /// <summary>sternWakeHalfWidthAt: foam half-width (m) at a distance astern.</summary>
        public static double HalfWidthAt(double distanceAsternM)
        {
            double t = JsMath.Clamp(distanceAsternM / LengthM, 0, 1);
            return HalfWidthSternM + t * (HalfWidthTailM - HalfWidthSternM);
        }

        /// <param name="sternWorld">World position of the transom foam origin.</param>
        /// <param name="aftWorld">Unit vector pointing astern along the ship's track.</param>
        public void Update(Vec3d sternWorld, Vec3d aftWorld)
        {
            Seed(sternWorld, aftWorld);
            TryPush(sternWorld);
            Layout(sternWorld);
        }

        private void Seed(Vec3d sternWorld, Vec3d aftWorld)
        {
            if (seeded)
            {
                return;
            }
            seeded = true;
            for (int i = SampleCount - 1; i >= 0; i--)
            {
                Push(
                    sternWorld.X + aftWorld.X * i * SegmentLengthM,
                    sternWorld.Z + aftWorld.Z * i * SegmentLengthM);
            }
        }

        private void Push(double x, double z)
        {
            historyX[head] = x;
            historyZ[head] = z;
            head = (head + 1) % SampleCount;
            count = Math.Min(count + 1, SampleCount);
        }

        private int HistoryIndex(int ageFromNewest) => (head - 1 - ageFromNewest + SampleCount * 2) % SampleCount;

        private void TryPush(Vec3d sternWorld)
        {
            int n = HistoryIndex(0);
            double dx = sternWorld.X - historyX[n];
            double dz = sternWorld.Z - historyZ[n];
            if (dx * dx + dz * dz >= SegmentLengthM * SegmentLengthM)
            {
                Push(sternWorld.X, sternWorld.Z);
            }
        }

        private void Layout(Vec3d sternWorld)
        {
            originX = sternWorld.X;
            originZ = sternWorld.Z;
            originSeaY = Geodesy.SeaLevelSceneY(sternWorld.X, sternWorld.Z);
            ObjectPosition = new Vec3d(sternWorld.X, originSeaY + SurfaceY, sternWorld.Z);

            int points = Math.Min(count + 1, SampleCount);
            stripX[0] = 0;
            stripZ[0] = 0;
            stripDist[0] = 0;
            for (int k = 1; k < points; k++)
            {
                int p = HistoryIndex(k - 1);
                stripX[k] = historyX[p] - sternWorld.X;
                stripZ[k] = historyZ[p] - sternWorld.Z;
                stripDist[k] = stripDist[k - 1] + JsMath.Hypot(stripX[k] - stripX[k - 1], stripZ[k] - stripZ[k - 1]);
            }

            for (int k = 0; k < points; k++)
            {
                int a = Math.Max(0, k - 1);
                int b = Math.Min(points - 1, k + 1);
                double tx = stripX[b] - stripX[a];
                double tz = stripZ[b] - stripZ[a];
                double len = JsMath.Hypot(tx, tz);
                if (len < 1e-6)
                {
                    tx = 0;
                    tz = 1;
                }
                else
                {
                    tx /= len;
                    tz /= len;
                }
                stripNX[k] = -tz;
                stripNZ[k] = tx;
            }

            for (int j = 0; j < SegmentCount; j++)
            {
                if (j + 1 >= points)
                {
                    SegmentVisible[j] = false;
                    continue;
                }
                PlaceQuad(j, j, j + 1);
                SegmentVisible[j] = true;
            }
        }

        private void PlaceQuad(int segment, int a, int b)
        {
            double wa = HalfWidthAt(stripDist[a]);
            double wb = HalfWidthAt(stripDist[b]);
            int o = segment * 12;
            Vertex(o, stripX[a] - stripNX[a] * wa, stripZ[a] - stripNZ[a] * wa);
            Vertex(o + 3, stripX[a] + stripNX[a] * wa, stripZ[a] + stripNZ[a] * wa);
            Vertex(o + 6, stripX[b] - stripNX[b] * wb, stripZ[b] - stripNZ[b] * wb);
            Vertex(o + 9, stripX[b] + stripNX[b] * wb, stripZ[b] + stripNZ[b] * wb);
        }

        private void Vertex(int o, double x, double z)
        {
            Positions[o] = (float)x;
            Positions[o + 1] = (float)(Geodesy.SeaLevelSceneY(originX + x, originZ + z) - originSeaY);
            Positions[o + 2] = (float)z;
        }
    }
}

using Retro.Core;
using System;

namespace Retro.Sim
{
    /// <summary>Horseshoe geometry, sim body axes relative to the CG.</summary>
    public sealed class HorseshoeSet
    {
        public int Count;
        public double[] Ax, Ay, Az;
        public double[] Bx, By, Bz;
        public double[] Px, Py, Pz;
        public double[] Nx, Ny, Nz;
        /// <summary>Vortex core radius per horseshoe (m).</summary>
        public double[] Core;
        /// <summary>1 where the horseshoe also has a mirror image in a root endplate, whose nodes follow.</summary>
        public byte[] HasImage;
        public double[] Iax, Iay, Iaz;
        public double[] Ibx, Iby, Ibz;
    }

    /// <summary>
    /// Lifting-line influences for FM3 (port of physics/fm3/liftingLine.ts, after
    /// Phillips and Snyder's numerical lifting line).
    ///
    /// Every strip carries a horseshoe vortex: a bound segment on its quarter-chord
    /// line from node A to node B, and a trailing leg from each node to infinity
    /// downstream. Biot-Savart gives the velocity each horseshoe induces at every
    /// strip's control point (the middle of its own bound segment). Only the
    /// component along the receiving strip's normal changes its angle of attack, so
    /// that scalar is stored, per unit circulation, and the runtime cost of the
    /// whole induced-flow field is one matrix-vector product.
    ///
    /// The trailing legs follow the freestream, so the influences depend on the
    /// direction the wake leaves in. They are tabulated once per airframe over a
    /// grid of wake angle of attack and sideslip and interpolated bilinearly.
    /// </summary>
    public sealed class InfluenceTable
    {
        private const double InvFourPi = 1 / (4 * Math.PI);
        private const double Deg = Math.PI / 180;

        public static readonly double[] WakeAlphas = Map(new double[] { -30, -15, 0, 15, 30, 45, 60, 75, 90 });
        public static readonly double[] WakeBetas = Map(new double[] { -30, -15, 0, 15, 30 });

        private static double[] Map(double[] degrees)
        {
            var o = new double[degrees.Length];
            for (int i = 0; i < degrees.Length; i++) o[i] = degrees[i] * Deg;
            return o;
        }

        public readonly int Count;
        private readonly double[] alphas;
        private readonly double[] betas;
        /// <summary>[alphaIndex][betaIndex][receiver i][source j], flattened.</summary>
        private readonly double[] data;

        public InfluenceTable(HorseshoeSet set, double[] alphas = null, double[] betas = null)
        {
            alphas = alphas ?? WakeAlphas;
            betas = betas ?? WakeBetas;
            Count = set.Count;
            this.alphas = alphas;
            this.betas = betas;
            int n = set.Count;
            data = new double[alphas.Length * betas.Length * n * n];
            var d = new double[3];
            var v = new double[3];
            for (int ia = 0; ia < alphas.Length; ia++)
            {
                for (int ib = 0; ib < betas.Length; ib++)
                {
                    WakeDirection(alphas[ia], betas[ib], d);
                    int bas = (ia * betas.Length + ib) * n * n;
                    for (int i = 0; i < n; i++)
                    {
                        for (int j = 0; j < n; j++)
                        {
                            v[0] = 0; v[1] = 0; v[2] = 0;
                            AddHorseshoeVelocity(
                                set.Px[i], set.Py[i], set.Pz[i],
                                set.Ax[j], set.Ay[j], set.Az[j],
                                set.Bx[j], set.By[j], set.Bz[j],
                                d[0], d[1], d[2], set.Core[j] * set.Core[j], v);
                            if (set.HasImage != null && set.HasImage[j] != 0)
                            {
                                AddHorseshoeVelocity(
                                    set.Px[i], set.Py[i], set.Pz[i],
                                    set.Iax[j], set.Iay[j], set.Iaz[j],
                                    set.Ibx[j], set.Iby[j], set.Ibz[j],
                                    d[0], d[1], d[2], set.Core[j] * set.Core[j], v);
                            }
                            data[bas + i * n + j] = v[0] * set.Nx[i] + v[1] * set.Ny[i] + v[2] * set.Nz[i];
                        }
                    }
                }
            }
        }

        /// <summary>
        /// Velocity induced at P by a unit horseshoe: bound A to B, trailing legs leaving
        /// A and B along the downstream unit vector d. Adds into o[oi..oi+2].
        /// core2 (m^2) softens the singularity next to a vortex line.
        /// </summary>
        private static void AddHorseshoeVelocity(
            double px, double py, double pz,
            double ax, double ay, double az,
            double bx, double by, double bz,
            double dx, double dy, double dz,
            double core2, double[] o, int oi = 0)
        {
            double r1x = px - ax, r1y = py - ay, r1z = pz - az;
            double r2x = px - bx, r2y = py - by, r2z = pz - bz;
            double r1 = Math.Sqrt(r1x * r1x + r1y * r1y + r1z * r1z);
            double r2 = Math.Sqrt(r2x * r2x + r2y * r2y + r2z * r2z);

            // Bound segment.
            double cx = r1y * r2z - r1z * r2y;
            double cy = r1z * r2x - r1x * r2z;
            double cz = r1x * r2y - r1y * r2x;
            double dot12 = r1x * r2x + r1y * r2y + r1z * r2z;
            double boundDen = r1 * r2 * (r1 * r2 + dot12) + core2 * core2;
            double kb = boundDen > 0 ? (r1 + r2) / boundDen : 0;

            // Leg from B downstream (+) and leg from infinity into A (-).
            double legBDen = r2 * (r2 - (dx * r2x + dy * r2y + dz * r2z)) + core2;
            double legADen = r1 * (r1 - (dx * r1x + dy * r1y + dz * r1z)) + core2;
            double kB = legBDen > 0 ? 1 / legBDen : 0;
            double kA = legADen > 0 ? 1 / legADen : 0;

            o[oi] += InvFourPi * (kb * cx + kB * (dy * r2z - dz * r2y) - kA * (dy * r1z - dz * r1y));
            o[oi + 1] += InvFourPi * (kb * cy + kB * (dz * r2x - dx * r2z) - kA * (dz * r1x - dx * r1z));
            o[oi + 2] += InvFourPi * (kb * cz + kB * (dx * r2y - dy * r2x) - kA * (dx * r1y - dy * r1x));
        }

        /// <summary>
        /// Downstream unit vector in sim body axes for a wake angle of attack and
        /// sideslip (NASA conventions: the aircraft moves along
        /// (cos a cos b, sin b, sin a cos b), so the air leaves the other way).
        /// </summary>
        private static double[] WakeDirection(double alpha, double beta, double[] o)
        {
            double ca = JsTrig.Cos(alpha), sa = JsTrig.Sin(alpha);
            double cb = JsTrig.Cos(beta), sb = JsTrig.Sin(beta);
            // NASA downstream (-cos a cos b, -sin b, -sin a cos b) to sim (-y_N, -z_N, x_N).
            o[0] = sb;
            o[1] = sa * cb;
            o[2] = -ca * cb;
            return o;
        }

        /// <summary>Writes the bilinearly interpolated n x n influence matrix (row = receiver) into o.</summary>
        public void Interpolate(double alpha, double beta, double[] o)
        {
            int n = Count;
            int nn = n * n;
            Bracket(alphas, alpha, out int ia, out double ta);
            Bracket(betas, beta, out int ib, out double tb);
            int nb = betas.Length;
            int b00 = (ia * nb + ib) * nn;
            int b01 = (ia * nb + ib + 1) * nn;
            int b10 = ((ia + 1) * nb + ib) * nn;
            int b11 = ((ia + 1) * nb + ib + 1) * nn;
            double w00 = (1 - ta) * (1 - tb), w01 = (1 - ta) * tb, w10 = ta * (1 - tb), w11 = ta * tb;
            double[] dd = data;
            for (int k = 0; k < nn; k++)
            {
                o[k] = w00 * dd[b00 + k] + w01 * dd[b01 + k] + w10 * dd[b10 + k] + w11 * dd[b11 + k];
            }
        }

        /// <summary>Index of the lower grid point and the fraction towards the next, clamped to the grid.</summary>
        private static void Bracket(double[] grid, double x, out int index, out double t)
        {
            int last = grid.Length - 2;
            if (x <= grid[0]) { index = 0; t = 0; return; }
            if (x >= grid[last + 1]) { index = last; t = 1; return; }
            int i = 0;
            while (i < last && x > grid[i + 1]) i++;
            index = i;
            t = (x - grid[i]) / (grid[i + 1] - grid[i]);
        }
    }
}

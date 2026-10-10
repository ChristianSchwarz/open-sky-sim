namespace Retro.Sim
{
    /// <summary>
    /// Moments of inertia in NASA body axes (kg m^2). Products of inertia follow
    /// the integral-of-xz-dm convention used by TP-1538 and Stevens and Lewis, so
    /// the tensor's off-diagonal terms are their negatives.
    /// </summary>
    public sealed class InertiaNasa
    {
        public double Ixx;
        public double Iyy;
        public double Izz;
        public double Ixz;
        public double? Ixy;
        public double? Iyz;
    }

    /// <summary>
    /// FM3 axis conventions (port of physics/fm3/frames.ts).
    ///
    /// FM3 integrates in the sim body frame it shares with FM2 and the renderer:
    /// +Y up, +Z forward, and +X completing a right-handed set (X x Y = Z). The sim
    /// names +X "RIGHT", but for an aircraft facing +Z with +Y up, a right-handed
    /// frame puts the starboard wing on -X, and FM2's controls agree.
    ///
    /// Everything FM3 is built from and checked against (NASA TP-1538, Stevens and
    /// Lewis) uses NASA body axes instead: x forward, y out the starboard wing,
    /// z down. The two are related by a proper rotation:
    ///
    ///     x_N = +Z_sim     y_N = -X_sim     z_N = -Y_sim
    ///
    /// so NASA roll rate p = wz, pitch rate q = -wx and yaw rate r = -wy, and
    /// moments map the same way. This file is the only place the mapping is
    /// written down.
    /// </summary>
    public static class Fm3Frames
    {
        public const double FtToM = 0.3048;
        public const double Deg = System.Math.PI / 180;

        /// <summary>NASA body-axis vector to sim body-axis vector.</summary>
        public static double[] NasaToSim(double[] v) => new[] { -v[1], -v[2], v[0] };

        /// <summary>Sim body-axis vector to NASA body-axis vector.</summary>
        public static double[] SimToNasa(double[] v) => new[] { v[2], -v[0], -v[1] };

        /// <summary>
        /// The inertia tensor in sim body axes, row-major 3x3.
        ///
        /// I_sim = C I_N C^T with C the NASA-to-sim rotation above. Worked through,
        /// the diagonal permutes (Iyy, Izz, Ixx) and the one product an aircraft
        /// usually has, Ixz, lands on the (Y, Z) entries with its sign flipped back
        /// to positive, because both y_N and z_N change sign on the way over.
        /// </summary>
        public static double[] InertiaNasaToSim(InertiaNasa i)
        {
            double ixy = i.Ixy ?? 0;
            double iyz = i.Iyz ?? 0;
            var o = new double[9];
            o[0] = i.Iyy; o[1] = -iyz; o[2] = ixy;
            o[3] = -iyz; o[4] = i.Izz; o[5] = i.Ixz;
            o[6] = ixy; o[7] = i.Ixz; o[8] = i.Ixx;
            return o;
        }

        /// <summary>Body rates in NASA axes (p roll, q pitch, r yaw; rad/s) from sim body omega.</summary>
        public static double[] NasaRatesFromSimOmega(double wx, double wy, double wz, double[] o)
        {
            o[0] = wz;
            o[1] = -wx;
            o[2] = -wy;
            return o;
        }

        /// <summary>Sim body omega from NASA body rates.</summary>
        public static double[] SimOmegaFromNasaRates(double p, double q, double r, double[] o)
        {
            o[0] = -q;
            o[1] = -r;
            o[2] = p;
            return o;
        }
    }
}

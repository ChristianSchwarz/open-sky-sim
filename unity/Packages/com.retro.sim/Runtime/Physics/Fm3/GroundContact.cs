using System;

namespace Retro.Sim
{
    /// <summary>
    /// FM3 landing gear (port of physics/fm3/groundContact.ts): spring-damper legs
    /// against the terrain, like FM2's, but built for an integrator that evaluates
    /// the loads several times per step.
    ///
    /// The heightfield is sampled once per step per leg (the highest ground under
    /// the tyre footprint and the local slope) and each RK4 stage then works
    /// against that plane. Friction is split into rolling/braking along the wheel
    /// and side friction across it, capped by a friction circle, and regularised
    /// near zero slip so a parked aircraft does not chatter.
    /// </summary>
    public sealed class Fm3GroundContact
    {
        /// <summary>Half-extent (m) of the footprint samples around each leg (as FM2).</summary>
        private const double FootprintM = 0.45;
        /// <summary>Finite-difference half-step (m) for surface normals (as FM2).</summary>
        private const double NormalEpsM = 0.5;
        /// <summary>Slip speed (m/s) below which friction fades out linearly.</summary>
        private const double SlipEpsMps = 0.1;

        private readonly Fm2GearConfig gear;
        public readonly int Count;
        /// <summary>Per-leg oleo compression (m) from the last recorded evaluation.</summary>
        public readonly double[] Compression;
        private readonly double[] points;
        private readonly double[] planeX;
        private readonly double[] planeY;
        private readonly double[] planeZ;
        private readonly double[] normalX;
        private readonly double[] normalY;
        private readonly double[] normalZ;
        private readonly double[] scratch = new double[3];
        private readonly double[] scratch2 = new double[3];
        public IGroundQuery World;

        public Fm3GroundContact(Fm2GearConfig gear)
        {
            this.gear = gear;
            Count = gear.Points.Length;
            Compression = new double[Count];
            points = new double[Count * 3];
            for (int i = 0; i < Count; i++)
            {
                points[i * 3] = gear.Points[i][0];
                points[i * 3 + 1] = gear.Points[i][1];
                points[i * 3 + 2] = gear.Points[i][2];
            }
            planeX = new double[Count];
            planeY = new double[Count];
            planeZ = new double[Count];
            normalX = new double[Count];
            normalY = new double[Count];
            normalZ = new double[Count];
            for (int i = 0; i < Count; i++)
            {
                planeY[i] = double.NegativeInfinity;
                normalY[i] = 1;
            }
        }

        public double MaxStroke => gear.MaxStrokeM ?? 0.35;

        /// <summary>Body-frame height of the CG above flat ground at rest: -min(leg Y).</summary>
        public double RestHeight
        {
            get
            {
                double min = double.PositiveInfinity;
                for (int i = 0; i < Count; i++) min = Math.Min(min, points[i * 3 + 1]);
                return -min;
            }
        }

        public double GroundHeightAt(double x, double z) => World == null ? 0 : World.GroundHeightAt(x, z);

        /// <summary>Highest ground under a tyre footprint (centre and +-footprint on X/Z).</summary>
        public double GroundHeightUnderGear(double x, double z)
        {
            const double r = FootprintM;
            double a = GroundHeightAt(x, z);
            double b = GroundHeightAt(x + r, z);
            double c = GroundHeightAt(x - r, z);
            double d = GroundHeightAt(x, z + r);
            double e = GroundHeightAt(x, z - r);
            return Math.Max(Math.Max(Math.Max(Math.Max(a, b), c), d), e);
        }

        /// <summary>Sample the ground plane under each leg for the coming step.</summary>
        public void SamplePlanes(double[] pos, double[] quat)
        {
            double[] w = scratch;
            for (int i = 0; i < Count; i++)
            {
                RigidBody6.RotateBodyToWorld(quat, points[i * 3], points[i * 3 + 1], points[i * 3 + 2], w);
                double x = pos[0] + w[0], z = pos[2] + w[2];
                planeX[i] = x;
                planeZ[i] = z;
                planeY[i] = GroundHeightUnderGear(x, z);
                const double e = NormalEpsM;
                double hL = GroundHeightAt(x - e, z), hR = GroundHeightAt(x + e, z);
                double hD = GroundHeightAt(x, z - e), hU = GroundHeightAt(x, z + e);
                double nx = -(hR - hL) / (2 * e), ny = 1, nz = -(hU - hD) / (2 * e);
                double len = Math.Sqrt(nx * nx + ny * ny + nz * nz);
                nx /= len; ny /= len; nz /= len;
                normalX[i] = nx; normalY[i] = ny; normalZ[i] = nz;
            }
        }

        /// <summary>
        /// Add the gear reactions at a trial state: world force into force, body
        /// moment about the CG into moment. Returns the body-frame +Y (up) share
        /// of the reaction, for the load factor.
        /// </summary>
        public double AddForces(
            double[] pos, double[] vel, double[] quat, double[] omega,
            bool brakes, double[] force, double[] moment, bool record)
        {
            Fm2GearConfig g = gear;
            double[] r = scratch;
            double[] b = scratch2;
            double stroke = MaxStroke;
            double upBody = 0;
            // Wheel direction: the nose, in the world.
            RigidBody6.RotateBodyToWorld(quat, 0, 0, 1, b);
            double fwX = b[0], fwY = b[1], fwZ = b[2];
            for (int i = 0; i < Count; i++)
            {
                if (record) Compression[i] = 0;
                double gx = points[i * 3], gy = points[i * 3 + 1], gz = points[i * 3 + 2];
                RigidBody6.RotateBodyToWorld(quat, gx, gy, gz, r);
                double nx = normalX[i], ny = normalY[i], nz = normalZ[i];
                double pen = nx * (planeX[i] - (pos[0] + r[0]))
                    + ny * (planeY[i] - (pos[1] + r[1]))
                    + nz * (planeZ[i] - (pos[2] + r[2]));
                if (!(pen > 0)) continue;
                if (record) Compression[i] = pen < stroke ? pen : stroke;

                // Contact point velocity: v + w_world x r.
                RigidBody6.RotateBodyToWorld(quat, omega[0], omega[1], omega[2], b);
                double cvx = vel[0] + (b[1] * r[2] - b[2] * r[1]);
                double cvy = vel[1] + (b[2] * r[0] - b[0] * r[2]);
                double cvz = vel[2] + (b[0] * r[1] - b[1] * r[0]);
                double vn = cvx * nx + cvy * ny + cvz * nz;
                double fn = g.Stiffness * pen - g.Damping * vn;
                if (fn <= 0) continue;

                // Wheel axes in the ground plane.
                double ax = fwX - (fwX * nx + fwY * ny + fwZ * nz) * nx;
                double ay = fwY - (fwX * nx + fwY * ny + fwZ * nz) * ny;
                double az = fwZ - (fwX * nx + fwY * ny + fwZ * nz) * nz;
                double alen = Math.Sqrt(ax * ax + ay * ay + az * az);
                double fx = fn * nx, fy = fn * ny, fz = fn * nz;
                if (alen > 1e-6)
                {
                    ax /= alen; ay /= alen; az /= alen;
                    double lx = ny * az - nz * ay, ly = nz * ax - nx * az, lz = nx * ay - ny * ax;
                    double vAlong = cvx * ax + cvy * ay + cvz * az;
                    double vSide = cvx * lx + cvy * ly + cvz * lz;
                    double muAlong = brakes ? g.BrakeFriction : g.RollFriction;
                    double fAlong = -muAlong * fn * Slip(vAlong);
                    double fSide = -g.SideFriction * fn * Slip(vSide);
                    double cap = Math.Max(g.SideFriction, muAlong) * fn;
                    double mag = Math.Sqrt(fAlong * fAlong + fSide * fSide);
                    if (mag > cap)
                    {
                        fAlong *= cap / mag;
                        fSide *= cap / mag;
                    }
                    fx += fAlong * ax + fSide * lx;
                    fy += fAlong * ay + fSide * ly;
                    fz += fAlong * az + fSide * lz;
                }
                force[0] += fx; force[1] += fy; force[2] += fz;
                // Moment about the CG: r x F, into the body frame.
                RigidBody6.RotateWorldToBody(quat, r[1] * fz - r[2] * fy, r[2] * fx - r[0] * fz, r[0] * fy - r[1] * fx, b);
                moment[0] += b[0]; moment[1] += b[1]; moment[2] += b[2];
                RigidBody6.RotateWorldToBody(quat, fx, fy, fz, b);
                upBody += b[1];
            }
            return upBody;
        }

        /// <summary>
        /// Deepest leg penetration past the oleo stroke (m), 0 when none: the
        /// springs alone can tunnel on rising terrain, so the caller lifts the body
        /// by this much (as FM2 does).
        /// </summary>
        public double ExcessPenetration(double[] pos, double[] quat)
        {
            double[] r = scratch;
            double maxPen = 0;
            for (int i = 0; i < Count; i++)
            {
                RigidBody6.RotateBodyToWorld(quat, points[i * 3], points[i * 3 + 1], points[i * 3 + 2], r);
                double pen = GroundHeightUnderGear(pos[0] + r[0], pos[2] + r[2]) - (pos[1] + r[1]);
                if (pen > maxPen) maxPen = pen;
            }
            double excess = maxPen - MaxStroke;
            return excess > 0 ? excess : 0;
        }

        /// <summary>Sign of the slip, fading linearly to zero inside +-SlipEps.</summary>
        private static double Slip(double v)
        {
            if (v > SlipEpsMps) return 1;
            if (v < -SlipEpsMps) return -1;
            return v / SlipEpsMps;
        }
    }
}

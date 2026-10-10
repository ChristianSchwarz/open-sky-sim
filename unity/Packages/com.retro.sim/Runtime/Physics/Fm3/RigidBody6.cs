using System;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// Evaluates the loads at a trial state. Writes the net world-frame force (N,
    /// gravity included) into <paramref name="forceWorld"/> and the net body-frame
    /// moment about the CG (N m) into <paramref name="momentBody"/>. <paramref name="stage"/>
    /// is 0-3 within one RK4 step.
    /// </summary>
    public delegate void WrenchFunction(
        double[] pos, double[] vel, double[] quat, double[] omega,
        int stage, double[] forceWorld, double[] momentBody);

    /// <summary>
    /// FM3's rigid body (port of physics/fm3/rigidBody6.ts): Newton-Euler with the
    /// full inertia tensor, spinning-rotor angular momentum, and classic
    /// fourth-order Runge-Kutta.
    ///
    ///     m v' = F                      (world frame, gravity included by the caller)
    ///     I w' = M - w x (I w + h)      (body frame; h = rotor angular momentum)
    ///     q'   = 1/2 q (x) (w, 0)       (q rotates body to world)
    ///
    /// Unlike FM2's integrator there is no limit on the angular rate: a spin or a
    /// tumble keeps whatever rate the moments give it. What there is instead is a
    /// guard: a step that produces a non-finite state is rolled back and reported,
    /// so a bad input shows up as a flag rather than NaN poisoning the sim.
    ///
    /// State and scratch are preallocated; a step allocates nothing.
    /// </summary>
    public sealed class RigidBody6
    {
        private const int N = 13;

        /// <summary>A 13-component state (pos, vel, quat xyzw, omega) as four named arrays.</summary>
        private sealed class StateVector
        {
            public readonly double[] Pos = new double[3];
            public readonly double[] Vel = new double[3];
            public readonly double[] Quat = new double[4];
            public readonly double[] Omega = new double[3];

            public double this[int i]
            {
                get => i < 3 ? Pos[i] : i < 6 ? Vel[i - 3] : i < 10 ? Quat[i - 6] : Omega[i - 10];
                set
                {
                    if (i < 3) Pos[i] = value;
                    else if (i < 6) Vel[i - 3] = value;
                    else if (i < 10) Quat[i - 6] = value;
                    else Omega[i - 10] = value;
                }
            }
        }

        public double Mass = 1;
        /// <summary>Body-frame inertia tensor, row-major (kg m^2).</summary>
        public readonly double[] Inertia = { 1, 0, 0, 0, 1, 0, 0, 0, 1 };
        public readonly double[] InertiaInv = { 1, 0, 0, 0, 1, 0, 0, 0, 1 };
        /// <summary>Body-frame angular momentum of spinning machinery, e.g. an engine rotor (kg m^2/s).</summary>
        public readonly double[] RotorMomentum = new double[3];

        private readonly StateVector s = new StateVector();
        /// <summary>World position (m).</summary>
        public double[] Pos => s.Pos;
        /// <summary>World velocity (m/s).</summary>
        public double[] Vel => s.Vel;
        /// <summary>Orientation, body to world, as x, y, z, w.</summary>
        public double[] Quat => s.Quat;
        /// <summary>Body angular velocity (rad/s).</summary>
        public double[] Omega => s.Omega;

        private readonly double[] k1 = new double[N];
        private readonly double[] k2 = new double[N];
        private readonly double[] k3 = new double[N];
        private readonly double[] k4 = new double[N];
        private readonly StateVector trial = new StateVector();
        private readonly double[] saved = new double[N];
        private readonly double[] force = new double[3];
        private readonly double[] moment = new double[3];

        public RigidBody6()
        {
            s.Quat[3] = 1;
        }

        public void SetMassProperties(double mass, double[] inertia)
        {
            Mass = mass;
            for (int i = 0; i < 9; i++) Inertia[i] = inertia[i];
            Invert3x3(Inertia, InertiaInv);
        }

        /// <summary>Snapshot the whole state (e.g. before an external correction).</summary>
        public void CopyStateTo(double[] o)
        {
            for (int i = 0; i < N; i++) o[i] = s[i];
        }

        public void CopyStateFrom(double[] src)
        {
            for (int i = 0; i < N; i++) s[i] = src[i];
        }

        /// <summary>
        /// Advance by <paramref name="dt"/> seconds. Returns false if the step produced a
        /// non-finite state, in which case the state is left exactly as it was before the call.
        /// </summary>
        public bool Step(double dt, WrenchFunction wrench)
        {
            StateVector x = s;
            StateVector t = trial;
            for (int i = 0; i < N; i++) saved[i] = x[i];

            Derivative(s, k1, 0, wrench);
            for (int i = 0; i < N; i++) t[i] = x[i] + 0.5 * dt * k1[i];
            Derivative(trial, k2, 1, wrench);
            for (int i = 0; i < N; i++) t[i] = x[i] + 0.5 * dt * k2[i];
            Derivative(trial, k3, 2, wrench);
            for (int i = 0; i < N; i++) t[i] = x[i] + dt * k3[i];
            Derivative(trial, k4, 3, wrench);

            double h6 = dt / 6;
            for (int i = 0; i < N; i++)
            {
                x[i] += h6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
            }
            NormalizeQuat(s.Quat);

            for (int i = 0; i < N; i++)
            {
                double v = x[i];
                if (double.IsNaN(v) || double.IsInfinity(v))
                {
                    for (int j = 0; j < N; j++) x[j] = saved[j];
                    return false;
                }
            }
            return true;
        }

        private void Derivative(StateVector sv, double[] o, int stage, WrenchFunction wrench)
        {
            // Trial quaternions drift off unit length between stages; the loads and
            // the kinematics both want a rotation, so renormalise before using it.
            NormalizeQuat(sv.Quat);
            double[] f = force;
            double[] m = moment;
            wrench(sv.Pos, sv.Vel, sv.Quat, sv.Omega, stage, f, m);

            o[0] = sv.Vel[0];
            o[1] = sv.Vel[1];
            o[2] = sv.Vel[2];
            double invM = 1 / Mass;
            o[3] = f[0] * invM;
            o[4] = f[1] * invM;
            o[5] = f[2] * invM;

            double qx = sv.Quat[0], qy = sv.Quat[1], qz = sv.Quat[2], qw = sv.Quat[3];
            double wx = sv.Omega[0], wy = sv.Omega[1], wz = sv.Omega[2];
            o[6] = 0.5 * (qw * wx + qy * wz - qz * wy);
            o[7] = 0.5 * (qw * wy + qz * wx - qx * wz);
            o[8] = 0.5 * (qw * wz + qx * wy - qy * wx);
            o[9] = -0.5 * (qx * wx + qy * wy + qz * wz);

            // w' = I^-1 (M - w x (I w + h))
            double[] I = Inertia;
            double hx = I[0] * wx + I[1] * wy + I[2] * wz + RotorMomentum[0];
            double hy = I[3] * wx + I[4] * wy + I[5] * wz + RotorMomentum[1];
            double hz = I[6] * wx + I[7] * wy + I[8] * wz + RotorMomentum[2];
            double rx = m[0] - (wy * hz - wz * hy);
            double ry = m[1] - (wz * hx - wx * hz);
            double rz = m[2] - (wx * hy - wy * hx);
            double[] Ii = InertiaInv;
            o[10] = Ii[0] * rx + Ii[1] * ry + Ii[2] * rz;
            o[11] = Ii[3] * rx + Ii[4] * ry + Ii[5] * rz;
            o[12] = Ii[6] * rx + Ii[7] * ry + Ii[8] * rz;
        }

        private static void NormalizeQuat(double[] q)
        {
            double len = Math.Sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
            if (len > 0)
            {
                double inv = 1 / len;
                q[0] *= inv; q[1] *= inv; q[2] *= inv; q[3] *= inv;
            }
        }

        /// <summary>o = R(q) v, rotating a body vector into the world frame. <paramref name="o"/> may alias the input.</summary>
        public static void RotateBodyToWorld(double[] q, double vx, double vy, double vz, double[] o, int oi = 0)
            => RotateBodyToWorld(q[0], q[1], q[2], q[3], vx, vy, vz, o, oi);

        public static void RotateBodyToWorld(Quatd q, double vx, double vy, double vz, double[] o, int oi = 0)
            => RotateBodyToWorld(q.X, q.Y, q.Z, q.W, vx, vy, vz, o, oi);

        private static void RotateBodyToWorld(double qx, double qy, double qz, double qw, double vx, double vy, double vz, double[] o, int oi)
        {
            double tx = 2 * (qy * vz - qz * vy);
            double ty = 2 * (qz * vx - qx * vz);
            double tz = 2 * (qx * vy - qy * vx);
            o[oi] = vx + qw * tx + (qy * tz - qz * ty);
            o[oi + 1] = vy + qw * ty + (qz * tx - qx * tz);
            o[oi + 2] = vz + qw * tz + (qx * ty - qy * tx);
        }

        /// <summary>o = R(q)^T v, rotating a world vector into the body frame.</summary>
        public static void RotateWorldToBody(double[] q, double vx, double vy, double vz, double[] o, int oi = 0)
            => RotateBodyToWorld(-q[0], -q[1], -q[2], q[3], vx, vy, vz, o, oi);

        public static void RotateWorldToBody(Quatd q, double vx, double vy, double vz, double[] o, int oi = 0)
            => RotateBodyToWorld(-q.X, -q.Y, -q.Z, q.W, vx, vy, vz, o, oi);

        /// <summary>Inverse of a 3x3 row-major matrix; throws on a singular one.</summary>
        public static void Invert3x3(double[] m, double[] o)
        {
            double a = m[0], b = m[1], c = m[2];
            double d = m[3], e = m[4], f = m[5];
            double g = m[6], h = m[7], i = m[8];
            double A = e * i - f * h;
            double B = -(d * i - f * g);
            double C = d * h - e * g;
            double det = a * A + b * B + c * C;
            if (!(Math.Abs(det) > 0))
            {
                throw new InvalidOperationException("invert3x3: singular matrix");
            }
            double inv = 1 / det;
            o[0] = A * inv;
            o[1] = -(b * i - c * h) * inv;
            o[2] = (b * f - c * e) * inv;
            o[3] = B * inv;
            o[4] = (a * i - c * g) * inv;
            o[5] = -(a * f - c * d) * inv;
            o[6] = C * inv;
            o[7] = -(a * h - b * g) * inv;
            o[8] = (a * e - b * d) * inv;
        }
    }
}

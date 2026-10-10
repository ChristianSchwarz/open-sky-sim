using Retro.Core;

namespace Retro.Sim
{
    /// <summary>Diagonal inertia tensor (kg m^2).</summary>
    public struct InertiaDiagonal
    {
        /// <summary>Moment of inertia about body +X (the TS calls it RIGHT; pitch axis).</summary>
        public double X;
        /// <summary>Moment of inertia about body +Y (UP / yaw axis).</summary>
        public double Y;
        /// <summary>Moment of inertia about body +Z (FORWARD / roll axis).</summary>
        public double Z;

        public InertiaDiagonal(double x, double y, double z)
        {
            X = x;
            Y = y;
            Z = z;
        }
    }

    /// <summary>
    /// Generic 6-DOF rigid body integrator (Newton-Euler); port of physics/fm2/rigidBody.ts.
    ///
    /// Translational dynamics are integrated in the WORLD frame (so the result maps
    /// directly onto the sim's world-space velocity/position). Rotational dynamics
    /// are integrated in the BODY frame, the natural frame for the inertia tensor
    /// and for Euler's equation
    ///
    ///     I * dw/dt = M - w x (I * w)
    ///
    /// with a diagonal inertia tensor. The w x (I w) gyroscopic term couples the
    /// axes and reproduces effects such as inertial pitch-up in a rolling pull.
    /// Orientation is advanced by composing the body quaternion with the
    /// incremental rotation exp(1/2 w dt).
    /// </summary>
    public sealed class RigidBody
    {
        public readonly double Mass;
        public readonly InertiaDiagonal Inertia;

        /// <summary>Orientation: body to world.</summary>
        public Quatd Orientation = Quatd.Identity;
        /// <summary>Linear velocity, world frame (m/s).</summary>
        public Vec3d VelocityWorld;
        /// <summary>Angular velocity, body frame (rad/s): (pitch, yaw, roll) about (X, Y, Z).</summary>
        public Vec3d AngularVelocityBody;

        public RigidBody(double mass, InertiaDiagonal inertia)
        {
            Mass = mass;
            Inertia = inertia;
        }

        public void Reset()
        {
            Orientation = Quatd.Identity;
            VelocityWorld = Vec3d.Zero;
            AngularVelocityBody = Vec3d.Zero;
        }

        /// <summary>Advance the rotational state by the body-frame moment about the CG (N m).</summary>
        public void IntegrateAngular(Vec3d momentBody, double dt)
        {
            Vec3d w = AngularVelocityBody;
            InertiaDiagonal I = Inertia;

            // Iw and the gyroscopic term w x (Iw).
            var iw = new Vec3d(I.X * w.X, I.Y * w.Y, I.Z * w.Z);
            Vec3d gyro = Vec3d.Cross(w, iw);

            // dw/dt = I^-1 (M - w x Iw)
            var angAccel = new Vec3d(
                (momentBody.X - gyro.X) / I.X,
                (momentBody.Y - gyro.Y) / I.Y,
                (momentBody.Z - gyro.Z) / I.Z);

            w = w.AddScaled(angAccel, dt);

            // Prevent tumbling runaway in extreme aerobatic attitudes.
            const double maxOmega = 6.0;
            if (w.LengthSquared > maxOmega * maxOmega)
            {
                w = w * (maxOmega / w.Length);
            }
            AngularVelocityBody = w;

            // Advance orientation by the incremental body-frame rotation.
            double omega = w.Length;
            if (omega > 1e-9)
            {
                Vec3d axis = w * (1 / omega);
                Quatd dq = Quatd.FromAxisAngle(axis, omega * dt);
                Orientation = (Orientation * dq).Normalized(); // body-frame delta applied on the right
            }
        }

        /// <summary>Advance the translational state (semi-implicit Euler) by the world force, gravity included.</summary>
        public void IntegrateLinear(Vec3d forceWorld, double dt, ref Vec3d position)
        {
            VelocityWorld = VelocityWorld.AddScaled(forceWorld, dt / Mass);
            position = position.AddScaled(VelocityWorld, dt);
        }
    }
}

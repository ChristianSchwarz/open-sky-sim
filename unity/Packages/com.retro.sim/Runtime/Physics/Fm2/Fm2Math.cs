using System;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// The few JavaScript / three.js idioms the FM2 port needs that the shared
    /// math types do not carry: numeric `a || b`, Vector3.projectOnPlane, and
    /// the Object3D transforms the kinematic (DEBUG) mode drives the airframe
    /// with. Each follows node_modules/three/src term for term.
    /// </summary>
    internal static class Fm2Math
    {
        /// <summary>JS `a || b` on numbers: 0, -0 and NaN are falsy.</summary>
        public static double Or(double a, double b) => a == 0 || double.IsNaN(a) ? b : a;

        /// <summary>three.js Vector3.projectOnPlane (via projectOnVector).</summary>
        public static Vec3d ProjectOnPlane(Vec3d v, Vec3d planeNormal)
        {
            Vec3d projected;
            double denominator = planeNormal.LengthSquared;
            if (denominator == 0)
            {
                projected = Vec3d.Zero;
            }
            else
            {
                double scalar = Vec3d.Dot(planeNormal, v) / denominator;
                projected = planeNormal * scalar;
            }
            return v - projected;
        }

        /// <summary>Object3D.rotateOnAxis: q * fromAxisAngle(axis, angle) (object space).</summary>
        public static Quatd RotateOnAxis(Quatd q, Vec3d axis, double angle) => q * Quatd.FromAxisAngle(axis, angle);

        /// <summary>Object3D.rotateOnWorldAxis: fromAxisAngle(axis, angle) * q (world space, no parent).</summary>
        public static Quatd RotateOnWorldAxis(Quatd q, Vec3d axis, double angle) => Quatd.FromAxisAngle(axis, angle) * q;

        /// <summary>Object3D.translateOnAxis: position + axis.applyQuaternion(q) * distance.</summary>
        public static Vec3d TranslateOnAxis(Vec3d position, Quatd q, Vec3d axis, double distance) =>
            position + axis.Rotate(q) * distance;

        /// <summary>
        /// Object3D.getWorldDirection for a parentless, unit-scale object: the
        /// third column of Matrix4.compose(position, q, 1), normalised.
        /// </summary>
        public static Vec3d GetWorldDirection(Quatd q)
        {
            double x = q.X, y = q.Y, z = q.Z, w = q.W;
            double x2 = x + x, y2 = y + y, z2 = z + z;
            double xx = x * x2, xz = x * z2;
            double yy = y * y2, yz = y * z2;
            double wx = w * x2, wy = w * y2;
            return new Vec3d(xz + wy, yz - wx, 1 - (xx + yy)).Normalized();
        }

        /// <summary>
        /// Object3D.lookAt for a parentless, non-camera object: Matrix4.lookAt(target,
        /// position, up), then setFromRotationMatrix.
        /// </summary>
        public static Quatd LookAt(Vec3d position, Vec3d target, Vec3d up)
        {
            // Matrix4.lookAt(eye = target, target = position, up).
            Vec3d zAxis = target - position;
            if (zAxis.LengthSquared == 0)
            {
                zAxis.Z = 1;
            }
            zAxis = zAxis.Normalized();
            Vec3d xAxis = Vec3d.Cross(up, zAxis);
            if (xAxis.LengthSquared == 0)
            {
                if (Math.Abs(up.Z) == 1)
                {
                    zAxis.X += 0.0001;
                }
                else
                {
                    zAxis.Z += 0.0001;
                }
                zAxis = zAxis.Normalized();
                xAxis = Vec3d.Cross(up, zAxis);
            }
            xAxis = xAxis.Normalized();
            Vec3d yAxis = Vec3d.Cross(zAxis, xAxis);
            return Quatd.FromRotationMatrix(new Mat3d(
                xAxis.X, yAxis.X, zAxis.X,
                xAxis.Y, yAxis.Y, zAxis.Y,
                xAxis.Z, yAxis.Z, zAxis.Z));
        }
    }
}

using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// The parts of a three.js PerspectiveCamera the camera updaters touch,
    /// with three.js-exact math: a position, an orientation, an up vector for
    /// LookAt, and the projection parameters. Like any three.js camera it looks
    /// down its local -Z, with +Y up. The camera has no parent, so its world
    /// matrix is compose(position, quaternion, 1).
    ///
    /// The Unity layer copies Position/Quaternion (and Fov/Near/Far) onto its
    /// camera, converting from these right-handed scene axes (x east, y up,
    /// z south) and the -Z view direction to Unity's left-handed +Z forward.
    /// </summary>
    public sealed class CameraPose
    {
        public Vec3d Position;
        public Quatd Quaternion = Quatd.Identity;
        /// <summary>Object3D.up, which LookAt keeps the camera's +Y toward. Defaults to +Y.</summary>
        public Vec3d Up = new Vec3d(0, 1, 0);
        /// <summary>Vertical field of view, degrees.</summary>
        public double Fov = 50;
        public double Aspect = 1;
        public double Near = 0.1;
        public double Far = 2000;

        public CameraPose() { }

        /// <summary>new THREE.PerspectiveCamera(fov, aspect, near, far).</summary>
        public CameraPose(double fov, double aspect, double near, double far)
        {
            Fov = fov;
            Aspect = aspect;
            Near = near;
            Far = far;
        }

        /// <summary>
        /// Object3D.lookAt for a camera: Matrix4.lookAt(position, target, up)
        /// and setFromRotationMatrix, so the camera's -Z points at `target`.
        /// </summary>
        public void LookAt(Vec3d target)
        {
            Quaternion = LookRotation(Position, target, Up);
        }

        /// <summary>Matrix4.lookAt(eye, target, up) then Quaternion.setFromRotationMatrix.</summary>
        public static Quatd LookRotation(Vec3d eye, Vec3d target, Vec3d up)
        {
            Vec3d z = eye - target;
            if (z.LengthSquared == 0)
            {
                // eye and target are in the same position
                z.Z = 1;
            }
            z = z.Normalized();
            Vec3d x = Vec3d.Cross(up, z);
            if (x.LengthSquared == 0)
            {
                // up and z are parallel
                if (Math.Abs(up.Z) == 1)
                {
                    z.X += 0.0001;
                }
                else
                {
                    z.Z += 0.0001;
                }
                z = z.Normalized();
                x = Vec3d.Cross(up, z);
            }
            x = x.Normalized();
            Vec3d y = Vec3d.Cross(z, x);
            var m = new Mat3d(
                x.X, y.X, z.X,
                x.Y, y.Y, z.Y,
                x.Z, y.Z, z.Z);
            return Quatd.FromRotationMatrix(m);
        }

        /// <summary>Object3D.rotateOnAxis: quaternion.multiply(setFromAxisAngle(axis, angle)), axis in object space.</summary>
        public void RotateOnAxis(Vec3d axis, double angle)
        {
            Quaternion = Quaternion * Quatd.FromAxisAngle(axis, angle);
        }

        /// <summary>The world matrix, compose(position, quaternion, (1, 1, 1)).</summary>
        public Mat4d MatrixWorld() => Mat4d.Compose(Position, Quaternion, new Vec3d(1, 1, 1));

        /// <summary>Camera.matrixWorldInverse.</summary>
        public Mat4d MatrixWorldInverse() => MatrixWorld().Inverted();

        /// <summary>PerspectiveCamera.projectionMatrix after updateProjectionMatrix (zoom 1, no view offset).</summary>
        public Mat4d ProjectionMatrix() => Mat4d.PerspectiveProjection(Fov, Aspect, Near, Far);

        /// <summary>Camera.getWorldDirection: the world matrix's -Z column, normalised.</summary>
        public Vec3d GetWorldDirection()
        {
            double[] e = MatrixWorld().E;
            return -new Vec3d(e[8], e[9], e[10]).Normalized();
        }

        /// <summary>Vector3.project(camera): world point to normalised device coordinates.</summary>
        public Vec3d Project(Vec3d point)
        {
            return ApplyMatrix4(ApplyMatrix4(point, MatrixWorldInverse()), ProjectionMatrix());
        }

        /// <summary>Vector3.applyMatrix4, with the perspective divide.</summary>
        public static Vec3d ApplyMatrix4(Vec3d v, Mat4d m)
        {
            double x = v.X, y = v.Y, z = v.Z;
            double[] e = m.E;
            double w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
            return new Vec3d(
                (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
                (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
                (e[2] * x + e[6] * y + e[10] * z + e[14]) * w);
        }
    }

    /// <summary>The fixed axes of utils/math.ts.</summary>
    public static class SceneAxes
    {
        public static readonly Vec3d Up = new Vec3d(0, 1, 0);
        public static readonly Vec3d Forward = new Vec3d(0, 0, 1);
        public static readonly Vec3d Right = new Vec3d(1, 0, 0);
    }
}

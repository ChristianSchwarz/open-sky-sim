using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// The view camera the overlay is drawn over, in the three.js convention the
    /// HUD's projection maths was written for: scene frame (x east, y up,
    /// z south), the camera looks down its local -Z with +Y up, and the
    /// projection matrix is three.js/OpenGL clip space (column-major, NDC
    /// x and y in [-1, 1], y up). No parent transform, unit scale.
    /// </summary>
    public sealed class HudCamera
    {
        /// <summary>Camera position, scene frame (m).</summary>
        public Vec3d Position;
        /// <summary>Camera orientation, scene frame (three.js camera: looks down local -Z).</summary>
        public Quatd Quaternion = Quatd.Identity;
        /// <summary>Projection matrix, 16 values column-major (three.js Matrix4.elements).</summary>
        public double[] Projection = new double[16];

        /// <summary>A PerspectiveCamera's pose and projection (zoom 1, no view offset).</summary>
        public static HudCamera Perspective(Vec3d position, Quatd quaternion, double fovYDeg, double aspect, double near, double far)
        {
            var c = new HudCamera { Position = position, Quaternion = quaternion };
            Array.Copy(Mat4d.PerspectiveProjection(fovYDeg, aspect, near, far).E, c.Projection, 16);
            return c;
        }
    }

    /// <summary>
    /// A three.js camera at one pose: matrixWorld, matrixWorldInverse as
    /// Camera.updateMatrixWorld builds them (via decompose when the composed
    /// scale is not exactly one), getWorldDirection, a front plane and
    /// Vector3.project, all written term for term as three.js r185 does.
    /// </summary>
    internal sealed class ThreeCameraView
    {
        private readonly Vec3d position;
        private readonly Mat4d world;
        private readonly Mat4d worldInverse;
        private readonly double[] projection;
        private readonly Vec3d direction;
        private readonly double planeConstant;

        public ThreeCameraView(Vec3d position, Quatd quaternion, double[] projection)
        {
            this.position = position;
            this.projection = projection;
            world = Mat4d.Compose(position, quaternion, new Vec3d(1, 1, 1));
            Decompose(world, out Vec3d p, out Quatd q, out Vec3d s);
            worldInverse = s.X == 1 && s.Y == 1 && s.Z == 1
                ? world.Inverted()
                : Mat4d.Compose(p, q, new Vec3d(1, 1, 1)).Inverted();
            double[] e = world.E;
            direction = -new Vec3d(e[8], e[9], e[10]).Normalized();
            // Plane.setFromNormalAndCoplanarPoint(direction, position).
            planeConstant = -Vec3d.Dot(position, direction);
        }

        /// <summary>Camera.getWorldDirection.</summary>
        public Vec3d Direction => direction;

        /// <summary>The front plane's signed distance (positive in front of the camera).</summary>
        public double DistanceToPoint(Vec3d p) => Vec3d.Dot(direction, p) + planeConstant;

        /// <summary>Vector3.project: world -> NDC.</summary>
        public Vec3d Project(Vec3d p) => ApplyMatrix4(ApplyMatrix4(p, worldInverse.E), projection);

        public Vec3d Position => position;

        private static Vec3d ApplyMatrix4(Vec3d v, double[] e)
        {
            double x = v.X, y = v.Y, z = v.Z;
            double w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
            return new Vec3d(
                (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
                (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
                (e[2] * x + e[6] * y + e[10] * z + e[14]) * w);
        }

        /// <summary>Matrix4.decompose.</summary>
        private static void Decompose(Mat4d m, out Vec3d position, out Quatd quaternion, out Vec3d scale)
        {
            double[] te = m.E;
            position = new Vec3d(te[12], te[13], te[14]);
            double n11 = te[0], n12 = te[4], n13 = te[8];
            double n21 = te[1], n22 = te[5], n23 = te[9];
            double n31 = te[2], n32 = te[6], n33 = te[10];
            double det = n11 * (n22 * n33 - n23 * n32) -
                n12 * (n21 * n33 - n23 * n31) +
                n13 * (n21 * n32 - n22 * n31);
            if (det == 0)
            {
                scale = new Vec3d(1, 1, 1);
                quaternion = Quatd.Identity;
                return;
            }
            double sx = new Vec3d(te[0], te[1], te[2]).Length;
            double sy = new Vec3d(te[4], te[5], te[6]).Length;
            double sz = new Vec3d(te[8], te[9], te[10]).Length;
            if (det < 0) sx = -sx;
            double invSX = 1 / sx, invSY = 1 / sy, invSZ = 1 / sz;
            quaternion = Quatd.FromRotationMatrix(new Mat3d(
                te[0] * invSX, te[4] * invSY, te[8] * invSZ,
                te[1] * invSX, te[5] * invSY, te[9] * invSZ,
                te[2] * invSX, te[6] * invSY, te[10] * invSZ));
            scale = new Vec3d(sx, sy, sz);
        }
    }

    /// <summary>The utils/math.ts helpers the HUD uses, as V8 evaluates them.</summary>
    public static class HudMath
    {
        /// <summary>utils/math.ts FORWARD / UP / RIGHT: the three.js object axes (body +Z is the nose).</summary>
        public static readonly Vec3d Forward = new Vec3d(0, 0, 1);
        public static readonly Vec3d Up = new Vec3d(0, 1, 0);
        public static readonly Vec3d Right = new Vec3d(1, 0, 0);

        private const double PiOver180 = Math.PI / 180.0;
        private const double N180OverPi = 180.0 / Math.PI;

        public static double ToRadians(double degrees) => PiOver180 * degrees;

        public static double ToDegrees(double radians) => N180OverPi * radians;

        /// <summary>vectorHeading: compass bearing of a horizontal vector, whole degrees, 0 = north (-Z), clockwise.</summary>
        public static double VectorHeading(Vec3d v)
        {
            double bearing = JsMath.Round(JsTrig.Atan2(v.X, -v.Z) / (2 * Math.PI) * 360);
            if (bearing < 0) bearing = 360 + bearing;
            return bearing;
        }

        /// <summary>The HUD's heading: the nose projected on the horizontal plane.</summary>
        public static double HeadingOf(Quatd q)
        {
            Vec3d v = Forward.Rotate(q);
            v.Y = 0;
            return VectorHeading(v.Normalized());
        }

        /// <summary>calculatePitchRoll for a body quaternion: [pitch, roll] in radians.</summary>
        public static (double Pitch, double Roll) PitchRoll(Quatd quaternion)
        {
            Vec3d forward = Forward.Rotate(quaternion);
            Vec3d prjForward = new Vec3d(forward.X, 0, forward.Z).Normalized();
            double pitch = AngleTo(forward, prjForward) * JsMath.Sign(forward.Y);
            Quatd q = Quatd.FromUnitVectors(forward, prjForward);
            Vec3d right = Right.Rotate(quaternion).Rotate(q);
            q = Quatd.FromUnitVectors(prjForward, Forward);
            right = right.Rotate(q);
            double roll = JsTrig.Acos(right.X) * JsMath.Sign(right.Y);
            if (double.IsNaN(roll)) roll = 0.0;
            return (pitch, roll);
        }

        /// <summary>Vector3.angleTo.</summary>
        public static double AngleTo(Vec3d a, Vec3d b)
        {
            double denominator = Math.Sqrt(a.LengthSquared * b.LengthSquared);
            if (denominator == 0) return Math.PI / 2;
            double theta = Vec3d.Dot(a, b) / denominator;
            return JsTrig.Acos(JsMath.Clamp(theta, -1, 1));
        }
    }

    /// <summary>
    /// Port of weapons/gunPipper.ts: where the rounds are after flying the
    /// target range (or a default range with no lock), gravity drop included,
    /// no lead on the target.
    /// </summary>
    public static class GunPipper
    {
        /// <summary>GUN_PROJECTILE_GRAVITY (m/s^2), the combat sim's.</summary>
        public const double ProjectileGravity = 9.80665;

        /// <summary>GUN_AIM_DEFAULT_RANGE_M: pipper range without a weapons target (m).</summary>
        public const double DefaultRangeM = 500;

        /// <summary>GUN_MUZZLE_OFFSET: body-frame muzzle offset (m).</summary>
        public static readonly Vec3d MuzzleOffset = new Vec3d(0, 0, 9);

        public static Vec3d BulletPositionAtTime(Vec3d gunPos, Vec3d bulletVel, double tof, double gravity = ProjectileGravity)
        {
            Vec3d o = gunPos.AddScaled(bulletVel, tof);
            o.Y -= 0.5 * gravity * tof * tof;
            return o;
        }

        public static double TofForRange(Vec3d gunForward, Vec3d gunVel, double muzzleSpeed, double rangeM, double gravity = ProjectileGravity)
        {
            Vec3d bulletVel = gunForward * muzzleSpeed + gunVel;
            double speed = Math.Max(1, bulletVel.Length);
            double range = Math.Max(0, rangeM);
            double tof = range / speed;
            for (int i = 0; i < 2; i++)
            {
                Vec3d disp = bulletVel * tof;
                disp.Y -= 0.5 * gravity * tof * tof;
                double travelled = Math.Max(1e-6, disp.Length);
                tof *= range / travelled;
            }
            return Math.Max(0, tof);
        }

        /// <summary>computeGunPipperWorldPoint; targetPos null uses defaultRangeM.</summary>
        public static Vec3d WorldPoint(
            Vec3d gunPos, Vec3d gunForward, Vec3d gunVel, double muzzleSpeed, Vec3d? targetPos,
            double defaultRangeM = DefaultRangeM, double gravity = ProjectileGravity)
        {
            Vec3d bulletVel = gunForward * muzzleSpeed + gunVel;
            double rangeM = targetPos.HasValue ? Math.Max(1, Vec3d.Distance(targetPos.Value, gunPos)) : defaultRangeM;
            double tof = TofForRange(gunForward, gunVel, muzzleSpeed, rangeM, gravity);
            return BulletPositionAtTime(gunPos, bulletVel, tof, gravity);
        }
    }
}

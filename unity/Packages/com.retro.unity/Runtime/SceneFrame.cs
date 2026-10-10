using Retro.Core;
using UnityEngine;

namespace Retro.Unity
{
    /// <summary>
    /// The one place where the sim's scene axes become Unity's.
    ///
    /// The sim, the terrain data and every baked tile use a right-handed frame:
    /// x = east, y = up, z = SOUTH, in double precision. Unity is left-handed with
    /// z = north and float transforms. Rendering is camera-relative: the Unity
    /// camera sits at the origin and every object is placed at (its scene
    /// position - the camera's), computed in double and only then cast to float.
    /// Mirroring z converts handedness; Unity flips triangle winding for
    /// negative-determinant matrices on its own.
    /// </summary>
    public static class SceneFrame
    {
        /// <summary>A scene-space offset (double) to a Unity vector: z negated.</summary>
        public static Vector3 ToUnity(Vec3d sceneOffset) =>
            new Vector3((float)sceneOffset.X, (float)sceneOffset.Y, (float)-sceneOffset.Z);

        /// <summary>A Unity direction back to scene axes.</summary>
        public static Vec3d ToScene(Vector3 unity) => new Vec3d(unity.x, unity.y, -unity.z);

        /// <summary>
        /// Object-to-world matrix for a tile: Flip * Translate(origin - camera) *
        /// Rotate(frameFix) * Scale(scale), assembled in double.
        /// </summary>
        public static Matrix4x4 TileMatrix(Vec3d origin, Vec3d camera, Quatd frameFix, double scale)
        {
            Vec3d c0 = new Vec3d(scale, 0, 0).Rotate(frameFix);
            Vec3d c1 = new Vec3d(0, scale, 0).Rotate(frameFix);
            Vec3d c2 = new Vec3d(0, 0, scale).Rotate(frameFix);
            Vec3d t = origin - camera;
            var m = new Matrix4x4();
            // Each column is mirrored in z (the row-2 entries are negated).
            m.SetColumn(0, new Vector4((float)c0.X, (float)c0.Y, (float)-c0.Z, 0));
            m.SetColumn(1, new Vector4((float)c1.X, (float)c1.Y, (float)-c1.Z, 0));
            m.SetColumn(2, new Vector4((float)c2.X, (float)c2.Y, (float)-c2.Z, 0));
            m.SetColumn(3, new Vector4((float)t.X, (float)t.Y, (float)-t.Z, 1));
            return m;
        }

        /// <summary>
        /// The three.js-convention camera orientation the quadtree's frustum uses
        /// (looks down its own -Z): yaw by -heading about +Y, then pitch about +X.
        /// Heading is clockwise from north, pitch positive nose up.
        /// </summary>
        public static Quatd SceneCameraOrientation(double headingDeg, double pitchDeg)
        {
            const double deg = System.Math.PI / 180;
            return Quatd.FromAxisAngle(new Vec3d(0, 1, 0), -headingDeg * deg)
                * Quatd.FromAxisAngle(new Vec3d(1, 0, 0), pitchDeg * deg);
        }

        /// <summary>The Unity camera rotation for the same heading/pitch (Unity looks down +Z = north).</summary>
        public static Quaternion UnityCameraRotation(double headingDeg, double pitchDeg) =>
            Quaternion.Euler((float)-pitchDeg, (float)headingDeg, 0);
    }
}

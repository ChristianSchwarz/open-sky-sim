using Retro.Core;

namespace Retro.Game
{
    // Port of src/script/state/worldRebase.ts: carrying the game's own
    // scene-space records across a floating-origin re-base. The terrain and the
    // entities move themselves; what is left is plain data kept beside them -
    // colliders, runways, markers - rewritten in place so every reference to a
    // record stays valid.
    //
    // Records that are a point and a heading only hold yaw; the small tilt a
    // re-base also brings is dropped there, or, where a slope is kept, the part
    // of it along the axis goes into the slope.

    /// <summary>A runway-like record: centre, heading, and optionally a slope along it.</summary>
    public interface IRunwayRecord
    {
        Vec3d Center { get; set; }
        double Heading { get; set; }
        /// <summary>Null when the record keeps no slope.</summary>
        double? Slope { get; set; }
    }

    public static class WorldRebase
    {
        public static void RebaseRunway(IRunwayRecord r, FrameShift shift)
        {
            double? slope = r.Slope;
            var turned = shift.SlopedHeading(r.Heading, slope ?? 0);
            r.Center = shift.Point(r.Center);
            r.Heading = turned.Heading;
            if (slope != null)
            {
                r.Slope = turned.Slope;
            }
        }

        public static void RebaseSurfacePad(SurfacePadCollider pad, FrameShift shift)
        {
            var turned = shift.SlopedHeading(pad.Heading, pad.Slope ?? 0);
            double baseY = shift.Point(new Vec3d(pad.CenterX, pad.BaseY, pad.CenterZ)).Y;
            Vec3d p = shift.Point(new Vec3d(pad.CenterX, pad.SurfaceY, pad.CenterZ));
            pad.CenterX = p.X;
            pad.SurfaceY = p.Y;
            pad.CenterZ = p.Z;
            pad.BaseY = baseY;
            pad.Heading = turned.Heading;
            if (pad.Slope != null)
            {
                pad.Slope = turned.Slope;
            }
        }

        public static void RebaseSkiJump(SkiJumpCollider s, FrameShift shift)
        {
            Vec3d p = shift.Point(new Vec3d(s.OriginX, s.OriginY, s.OriginZ));
            s.OriginX = p.X;
            s.OriginY = p.Y;
            s.OriginZ = p.Z;
            s.Heading = shift.Heading(s.Heading);
        }

        /// <summary>
        /// A triangle soup about an origin. The soup's axes are the world's, so
        /// its vertices turn with them. The array is replaced, not rewritten:
        /// soups are shared with the model they were baked from.
        /// </summary>
        public static void RebaseMeshCollider(CarrierMeshCollider c, FrameShift shift)
        {
            Vec3d o = shift.Point(new Vec3d(c.OriginX, c.OriginY, c.OriginZ));
            c.OriginX = o.X;
            c.OriginY = o.Y;
            c.OriginZ = o.Z;
            double[] tris = (double[])c.Triangles.Clone();
            double[] min = { double.PositiveInfinity, double.PositiveInfinity, double.PositiveInfinity };
            double[] max = { double.NegativeInfinity, double.NegativeInfinity, double.NegativeInfinity };
            for (int i = 0; i + 2 < tris.Length; i += 3)
            {
                Vec3d v = shift.Vector(new Vec3d(tris[i], tris[i + 1], tris[i + 2]));
                tris[i] = v.X;
                tris[i + 1] = v.Y;
                tris[i + 2] = v.Z;
                for (int k = 0; k < 3; k++)
                {
                    double x = tris[i + k];
                    if (x < min[k]) min[k] = x;
                    if (x > max[k]) max[k] = x;
                }
            }
            c.Triangles = tris;
            c.Aabb = tris.Length > 0 ? new Aabb { Min = min, Max = max } : c.Aabb;
        }
    }
}

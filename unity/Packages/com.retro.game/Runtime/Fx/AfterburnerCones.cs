using System;
using Retro.Core;
using Retro.Sim;

namespace Retro.Game
{
    /// <summary>
    /// Afterburner plumes, CPU side (port of afterburnerCones.ts). One plume per
    /// nozzle: an outer halo cone, an inner core cone and a round cap ("dish"),
    /// all three in one group that sits <see cref="ConeForwardOffsetM"/> ahead of
    /// the nozzle (into the nozzle interior) and takes the aircraft's attitude.
    /// The plumes show only in the AB1/AB2 throttle zones and only when the
    /// aircraft may light them. Geometry is non-indexed float32 triangles in the
    /// plume group's frame (+Z forward, the cones point aft along -Z), rebuilt
    /// only when the stage changes, as the web game does.
    /// Colour, dither and fog are shader work (see the Unity integration notes).
    /// </summary>
    public sealed class AfterburnerCones
    {
        /// <summary>DEFAULT_ENGINE_NOZZLES: the built-in F-22's twin nozzles (body frame, +Z forward).</summary>
        public static readonly double[][] DefaultEngineNozzles = ArrestorCables.DefaultEngineNozzles;

        /// <summary>DEFAULT_RADIUS: nozzle radius (m) when a def gives none.</summary>
        public const double DefaultRadius = 0.3;

        /// <summary>CONE_FORWARD_OFFSET_M: the plume group sits this far ahead (+Z body) of the nozzle.</summary>
        public const double ConeForwardOffsetM = 0.5;

        /// <summary>CONE_LENGTHS_M['ab-min']: inner core and outer halo lengths (m) in AB1.</summary>
        public const double AbMinInnerLengthM = 3, AbMinOuterLengthM = 4.5;

        /// <summary>CONE_LENGTHS_M['ab-max']: inner core and outer halo lengths (m) in AB2.</summary>
        public const double AbMaxInnerLengthM = 4, AbMaxOuterLengthM = 6;

        /// <summary>CONE_COLOR '#ffff00': both stages, primary and secondary tone (linear RGB 1, 1, 0).</summary>
        public static readonly float[] ConeColor = { 1f, 1f, 0f };

        /// <summary>INNER_CONE_ALPHA_DITHER: the core's (and the dish's) ordered-dither opacity.</summary>
        public const double InnerConeAlphaDither = 0.35;

        /// <summary>OUTER_CONE_ALPHA_DITHER: the halo's ordered-dither opacity.</summary>
        public const double OuterConeAlphaDither = 0.15;

        /// <summary>PLUME_SEGMENTS: triangles around each cone and the dish.</summary>
        public const int PlumeSegments = 24;

        private Vec3d[] nozzles = Array.Empty<Vec3d>();
        private Vec3d[] rootPositions = Array.Empty<Vec3d>();

        public AfterburnerCones()
        {
            SetNozzles(null, null);
        }

        /// <summary>Nozzle origins in the body frame after <c>symmetrizeNozzles</c>.</summary>
        public ReadOnlySpan<Vec3d> Nozzles => nozzles;

        /// <summary>The shared base radius of every cone and dish (m).</summary>
        public double Radius { get; private set; } = DefaultRadius;

        /// <summary>Whether the plumes are drawn this frame (every plume root shares it).</summary>
        public bool Visible { get; private set; }

        /// <summary>
        /// The stage the geometry was last built for (<c>lastZone</c>); null until the
        /// first visible frame after <see cref="SetNozzles"/>. Kept while hidden.
        /// </summary>
        public F16ThrottleZone? Zone { get; private set; }

        /// <summary>Per nozzle: the plume root's scene position (nozzle origin carried by the attitude). Stale while hidden.</summary>
        public ReadOnlySpan<Vec3d> RootPositions => rootPositions;

        /// <summary>Every plume root's orientation: the aircraft's display quaternion. Stale while hidden.</summary>
        public Quatd RootRotation { get; private set; } = Quatd.Identity;

        /// <summary>Inner core cone: PlumeSegments triangles, 9 floats each (x, y, z per vertex), plume-group frame.</summary>
        public float[] InnerGeometry { get; private set; }

        /// <summary>Outer halo cone, same layout.</summary>
        public float[] OuterGeometry { get; private set; }

        /// <summary>The base cap at z = 0 facing aft (-Z), same layout; never changes with the stage.</summary>
        public float[] DishGeometry { get; private set; }

        /// <summary>Bumped whenever the cone geometry is rewritten (stage change or new nozzles), for re-upload.</summary>
        public int GeometryVersion { get; private set; }

        /// <summary>The cone lengths (inner, outer) for a stage; MIL has no plume and answers AB1's (the seed).</summary>
        public static (double Inner, double Outer) ConeLengths(F16ThrottleZone zone) =>
            zone == F16ThrottleZone.AbMax ? (AbMaxInnerLengthM, AbMaxOuterLengthM) : (AbMinInnerLengthM, AbMinOuterLengthM);

        /// <summary>
        /// writeConeGeometry: a cone from <paramref name="baseRadius"/> at z = 0 tapering to a
        /// point at z = -length; float32 like the Float32Array it fills.
        /// </summary>
        public static float[] ConeGeometry(double length, double baseRadius)
        {
            var verts = new float[PlumeSegments * 9];
            for (int i = 0; i < PlumeSegments; i++)
            {
                double a0 = ((double)i / PlumeSegments) * Math.PI * 2;
                double a1 = ((double)(i + 1) / PlumeSegments) * Math.PI * 2;
                int o = i * 9;
                verts[o] = (float)(JsTrig.Cos(a0) * baseRadius);
                verts[o + 1] = (float)(JsTrig.Sin(a0) * baseRadius);
                verts[o + 2] = 0f;
                verts[o + 3] = (float)(JsTrig.Cos(a1) * baseRadius);
                verts[o + 4] = (float)(JsTrig.Sin(a1) * baseRadius);
                verts[o + 5] = 0f;
                verts[o + 6] = 0f;
                verts[o + 7] = 0f;
                verts[o + 8] = (float)-length;
            }
            return verts;
        }

        /// <summary>writeDishGeometry: the round base cap at z = 0, wound to face aft (-Z).</summary>
        public static float[] DishGeometryFor(double radius)
        {
            var verts = new float[PlumeSegments * 9];
            for (int i = 0; i < PlumeSegments; i++)
            {
                double a0 = ((double)i / PlumeSegments) * Math.PI * 2;
                double a1 = ((double)(i + 1) / PlumeSegments) * Math.PI * 2;
                int o = i * 9;
                verts[o + 3] = (float)(JsTrig.Cos(a1) * radius);
                verts[o + 4] = (float)(JsTrig.Sin(a1) * radius);
                verts[o + 6] = (float)(JsTrig.Cos(a0) * radius);
                verts[o + 7] = (float)(JsTrig.Sin(a0) * radius);
            }
            return verts;
        }

        /// <summary>
        /// setNozzles: one plume per nozzle origin (body frame) with the def's radius;
        /// null or empty falls back to <see cref="DefaultEngineNozzles"/> and a
        /// non-positive or missing radius to <see cref="DefaultRadius"/>. Hides the
        /// plumes and forgets the stage.
        /// </summary>
        public void SetNozzles(double[][] nozzleRows, double? radius)
        {
            double[][] src = nozzleRows != null && nozzleRows.Length > 0 ? nozzleRows : DefaultEngineNozzles;
            nozzles = new Vec3d[src.Length];
            for (int i = 0; i < src.Length; i++) nozzles[i] = new Vec3d(src[i][0], src[i][1], src[i][2]);
            Radius = radius.HasValue && radius.Value > 0 ? radius.Value : DefaultRadius;
            SymmetrizeNozzles();
            rootPositions = new Vec3d[nozzles.Length];
            RootRotation = Quatd.Identity;
            Visible = false;
            WriteGeometry(F16ThrottleZone.AbMin);
            DishGeometry = DishGeometryFor(Radius);
            Zone = null;
        }

        /// <summary>
        /// symmetrizeNozzles: line every nozzle up at the mean height and depth; a
        /// twin layout also shares the mean |x|, mirrored, keeping which one is left.
        /// </summary>
        private void SymmetrizeNozzles()
        {
            if (nozzles.Length < 2) return;
            double sumY = 0, sumZ = 0;
            foreach (Vec3d n in nozzles)
            {
                sumY += n.Y;
                sumZ += n.Z;
            }
            double y = sumY / nozzles.Length;
            double z = sumZ / nozzles.Length;
            if (nozzles.Length == 2)
            {
                double x = (Math.Abs(nozzles[0].X) + Math.Abs(nozzles[1].X)) / 2;
                bool leftFirst = nozzles[0].X <= nozzles[1].X;
                nozzles[0] = new Vec3d(leftFirst ? -x : x, y, z);
                nozzles[1] = new Vec3d(leftFirst ? x : -x, y, z);
            }
            else
            {
                for (int i = 0; i < nozzles.Length; i++) nozzles[i] = new Vec3d(nozzles[i].X, y, z);
            }
        }

        private void WriteGeometry(F16ThrottleZone zone)
        {
            (double inner, double outer) = ConeLengths(zone);
            InnerGeometry = ConeGeometry(inner, Radius);
            OuterGeometry = ConeGeometry(outer, Radius);
            GeometryVersion++;
        }

        /// <summary>
        /// update: <paramref name="throttleLever"/> [0, 1] picks the stage (F16Engine.Zone:
        /// below 0.99 MIL, below 1 AB1, else AB2); the plumes show when
        /// <paramref name="plumeActive"/> and the stage is not MIL. While hidden nothing
        /// else changes; shown, the geometry follows the stage and each root is placed
        /// at its nozzle carried by the display pose.
        /// </summary>
        public void Update(double throttleLever, bool plumeActive, Vec3d displayPosition, Quatd displayQuaternion)
        {
            F16ThrottleZone zone = F16Engine.Zone(throttleLever);
            bool plumeOn = plumeActive && zone != F16ThrottleZone.Mil;
            Visible = plumeOn;
            if (!plumeOn) return;
            if (Zone != zone)
            {
                WriteGeometry(zone);
                Zone = zone;
            }
            for (int i = 0; i < nozzles.Length; i++)
            {
                rootPositions[i] = nozzles[i].Rotate(displayQuaternion) + displayPosition;
            }
            RootRotation = displayQuaternion;
        }

        /// <summary>
        /// The plume group's scene position for nozzle <paramref name="i"/>: the root moved
        /// <see cref="ConeForwardOffsetM"/> along the body +Z. The group's rotation is
        /// <see cref="RootRotation"/>; draw the three geometries with this transform.
        /// </summary>
        public Vec3d PlumePosition(int i) => new Vec3d(0, 0, ConeForwardOffsetM).Rotate(RootRotation) + rootPositions[i];
    }
}

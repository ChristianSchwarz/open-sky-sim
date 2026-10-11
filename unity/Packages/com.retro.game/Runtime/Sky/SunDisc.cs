using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>The sun glare's geometry (cap + ring merged, indexed), float32 like the TS buffers. Built facing +Z.</summary>
    public sealed class SunGlareGeometry
    {
        /// <summary>xyz per vertex in the XY plane (z = 0), units of the background-sky camera space.</summary>
        public float[] Positions;
        /// <summary>skyFalloff: 1 at (and inside) the disc's limb, falling linearly in angle to 0 at the outer edge.</summary>
        public float[] Falloff;
        /// <summary>skyCap: 1 for the cap's vertices (the part lying over the disc), 0 for the ring's.</summary>
        public float[] Cap;
        public int[] Indices;
        /// <summary>Vertices belonging to the cap (they come first).</summary>
        public int CapCount;
        public int VertexCount => Positions.Length / 3;
    }

    /// <summary>A circle mesh (three CircleGeometry): centre then segments + 1 rim vertices.</summary>
    public sealed class SunDiscGeometry
    {
        public float[] Positions;
        public int[] Indices;
    }

    /// <summary>
    /// Port of the CPU half of src/script/scene/models/lib/sunModelBuilder.ts:
    /// the faceted disc, the glare (aureole) geometry and its per-vertex
    /// falloff / cap flags, the sun's placement in the background-sky camera's
    /// space, and the glare repaint from the dome's sky painter. Math.tan has no
    /// V8-exact port and uses .NET's.
    /// </summary>
    public static class SunDisc
    {
        private const double Deg2Rad = Math.PI / 180;
        private const double Rad2Deg = 180 / Math.PI;

        /// <summary>Distance the disc is parked at in the rotation-only background-sky camera's space.</summary>
        public const double SunDistance = 500;
        /// <summary>Apparent disc diameter, degrees (about 4x the real sun).</summary>
        public const double DiscDiameterDeg = 2.2;
        /// <summary>How far the glare reaches, as an apparent diameter in degrees.</summary>
        public const double GlareDiameterDeg = 16.0;
        /// <summary>uSkyOverbright of the glare material: how hard the sky is driven at the limb.</summary>
        public const double GlareOverbright = 2.6;
        public const int GlareRadialSteps = 12;
        /// <summary>Overbright of the disc's palette material (category SKY_SUN, unshaded).</summary>
        public const double DiscOverbright = 6.0;
        public const int DiscSegments = 12;
        public const int GlareSegments = 12;
        public const double GlareInnerOverlap = 0.98;
        /// <summary>uVeilDensity = FOG_TERRAIN density of the active palette times this.</summary>
        public const double GlareVeilGain = 12;
        public const int DiscRenderOrder = 1;
        public const int GlareRenderOrder = 1;
        /// <summary>The disc is hidden below this elevation (its upper limb has set).</summary>
        public const double SunSetElevationDeg = -DiscDiameterDeg / 2;

        /// <summary>radiusForDiameter: radius at <see cref="SunDistance"/> spanning diameterDeg.</summary>
        public static double RadiusForDiameter(double diameterDeg) =>
            SunDistance * Math.Tan(diameterDeg / 2 * Deg2Rad);

        /// <summary>diameterForRadius: the apparent diameter, degrees, a radius at <see cref="SunDistance"/> spans.</summary>
        public static double DiameterForRadius(double radius) =>
            2 * JsTrig.Atan(radius / SunDistance) * Rad2Deg;

        /// <summary>three CircleGeometry(radius, segments) positions (float32) and indices.</summary>
        public static SunDiscGeometry Circle(double radius, int segments)
        {
            segments = Math.Max(3, segments);
            float[] p = new float[(segments + 2) * 3];
            for (int s = 0, i = 3; s <= segments; s++, i += 3)
            {
                double segment = 0 + (double)s / segments * (Math.PI * 2);
                p[i] = (float)(radius * JsTrig.Cos(segment));
                p[i + 1] = (float)(radius * JsTrig.Sin(segment));
            }
            int[] index = new int[segments * 3];
            for (int i = 1, k = 0; i <= segments; i++)
            {
                index[k++] = i; index[k++] = i + 1; index[k++] = 0;
            }
            return new SunDiscGeometry { Positions = p, Indices = index };
        }

        /// <summary>three RingGeometry(inner, outer, thetaSegments, phiSegments) positions (float32) and indices.</summary>
        public static SunDiscGeometry Ring(double innerRadius, double outerRadius, int thetaSegments, int phiSegments)
        {
            thetaSegments = Math.Max(3, thetaSegments);
            phiSegments = Math.Max(1, phiSegments);
            float[] p = new float[(phiSegments + 1) * (thetaSegments + 1) * 3];
            double radius = innerRadius;
            double radiusStep = (outerRadius - innerRadius) / phiSegments;
            int v = 0;
            for (int j = 0; j <= phiSegments; j++)
            {
                for (int i = 0; i <= thetaSegments; i++)
                {
                    double segment = 0 + (double)i / thetaSegments * (Math.PI * 2);
                    p[v++] = (float)(radius * JsTrig.Cos(segment));
                    p[v++] = (float)(radius * JsTrig.Sin(segment));
                    p[v++] = 0;
                }
                radius += radiusStep;
            }
            int[] index = new int[phiSegments * thetaSegments * 6];
            int k = 0;
            for (int j = 0; j < phiSegments; j++)
            {
                int level = j * (thetaSegments + 1);
                for (int i = 0; i < thetaSegments; i++)
                {
                    int segment = i + level;
                    int a = segment;
                    int b = segment + thetaSegments + 1;
                    int c = segment + thetaSegments + 2;
                    int d = segment + 1;
                    index[k++] = a; index[k++] = b; index[k++] = d;
                    index[k++] = b; index[k++] = c; index[k++] = d;
                }
            }
            return new SunDiscGeometry { Positions = p, Indices = index };
        }

        /// <summary>The disc mesh: a 12-segment circle of the disc's radius, facing +Z.</summary>
        public static SunDiscGeometry BuildDisc() => Circle(RadiusForDiameter(DiscDiameterDeg), DiscSegments);

        /// <summary>buildGlare: cap (inside the disc's rim) merged with the ring out to the glare's reach.</summary>
        public static SunGlareGeometry BuildGlare()
        {
            double innerRadius = RadiusForDiameter(DiscDiameterDeg) * GlareInnerOverlap;
            SunDiscGeometry cap = Circle(innerRadius, GlareSegments);
            SunDiscGeometry ring = Ring(innerRadius, RadiusForDiameter(GlareDiameterDeg), GlareSegments, GlareRadialSteps);
            int capCount = cap.Positions.Length / 3;

            float[] positions = new float[cap.Positions.Length + ring.Positions.Length];
            Array.Copy(cap.Positions, positions, cap.Positions.Length);
            Array.Copy(ring.Positions, 0, positions, cap.Positions.Length, ring.Positions.Length);
            int[] index = new int[cap.Indices.Length + ring.Indices.Length];
            Array.Copy(cap.Indices, index, cap.Indices.Length);
            for (int i = 0; i < ring.Indices.Length; i++)
            {
                index[cap.Indices.Length + i] = ring.Indices[i] + capCount;
            }

            int count = positions.Length / 3;
            double innerDeg = DiameterForRadius(innerRadius);
            double span = GlareDiameterDeg - innerDeg;
            float[] falloff = new float[count];
            float[] capFlag = new float[count];
            for (int v = 0; v < count; v++)
            {
                double deg = DiameterForRadius(JsMath.Hypot(positions[v * 3], positions[v * 3 + 1]));
                falloff[v] = (float)JsMath.Clamp((GlareDiameterDeg - deg) / span, 0, 1);
                capFlag[v] = v < capCount ? 1 : 0;
            }
            return new SunGlareGeometry
            {
                Positions = positions, Falloff = falloff, Cap = capFlag, Indices = index, CapCount = capCount,
            };
        }

        /// <summary>
        /// placeSun: position = sunDir * <see cref="SunDistance"/> and the
        /// rotation taking the model's +Z normal onto -sunDir (three
        /// Quaternion.setFromUnitVectors), as (x, y, z, w).
        /// </summary>
        public static void PlaceSun(double sunX, double sunY, double sunZ, double[] position, double[] quaternion)
        {
            position[0] = sunX * SunDistance;
            position[1] = sunY * SunDistance;
            position[2] = sunZ * SunDistance;
            // setFromUnitVectors((0, 0, 1), (-sunX, -sunY, -sunZ))
            double fx = 0, fy = 0, fz = 1;
            double tx = -sunX, ty = -sunY, tz = -sunZ;
            double r = fx * tx + fy * ty + fz * tz + 1;
            double qx, qy, qz, qw;
            if (r < 1e-8)
            {
                r = 0;
                if (Math.Abs(fx) > Math.Abs(fz))
                {
                    qx = -fy; qy = fx; qz = 0; qw = r;
                }
                else
                {
                    qx = 0; qy = -fz; qz = fy; qw = r;
                }
            }
            else
            {
                qx = fy * tz - fz * ty;
                qy = fz * tx - fx * tz;
                qz = fx * ty - fy * tx;
                qw = r;
            }
            double l = Math.Sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
            if (l == 0)
            {
                qx = 0; qy = 0; qz = 0; qw = 1;
            }
            else
            {
                l = 1 / l;
                qx *= l; qy *= l; qz *= l; qw *= l;
            }
            quaternion[0] = qx; quaternion[1] = qy; quaternion[2] = qz; quaternion[3] = qw;
        }

        /// <summary>
        /// paintSunBloom's direction step: each glare vertex (x, y) as the unit
        /// view direction sunDir + right * x/500 + up * y/500 (right = (z, 0, -x)
        /// normalised, up = sunDir x right), float32.
        /// </summary>
        public static float[] GlareDirections(SunGlareGeometry glare, double sunX, double sunY, double sunZ)
        {
            double rx = sunZ, ry = 0, rz = -sunX;
            if (rx * rx + ry * ry + rz * rz < 1e-9)
            {
                rx = 1; ry = 0; rz = 0;
            }
            Normalize(ref rx, ref ry, ref rz);
            double ux = sunY * rz - sunZ * ry;
            double uy = sunZ * rx - sunX * rz;
            double uz = sunX * ry - sunY * rx;
            Normalize(ref ux, ref uy, ref uz);

            int count = glare.VertexCount;
            float[] directions = new float[count * 3];
            for (int v = 0; v < count; v++)
            {
                double px = glare.Positions[v * 3] / SunDistance;
                double py = glare.Positions[v * 3 + 1] / SunDistance;
                double wx = sunX, wy = sunY, wz = sunZ;
                wx += rx * px; wy += ry * px; wz += rz * px;
                wx += ux * py; wy += uy * py; wz += uz * py;
                Normalize(ref wx, ref wy, ref wz);
                directions[v * 3] = (float)wx;
                directions[v * 3 + 1] = (float)wy;
                directions[v * 3 + 2] = (float)wz;
            }
            return directions;
        }

        /// <summary>three Vector3.normalize: multiply by 1 / (length || 1).</summary>
        private static void Normalize(ref double x, ref double y, ref double z)
        {
            double len = Math.Sqrt(x * x + y * y + z * z);
            if (len == 0) len = 1;
            double inv = 1 / len;
            x *= inv; y *= inv; z *= inv;
        }

        /// <summary>
        /// paintSunBloom: the glare's skyColor attribute (float32 linear RGB, 3
        /// per vertex) from the same painter as the dome, for the authored
        /// palettes, night mix and sun direction. The veil density for the
        /// glare shader is <see cref="VeilDensity"/>(activePalette).
        /// </summary>
        public static float[] PaintGlare(SunGlareGeometry glare, Palette noon, Palette midnight, double nightMix,
            double sunX, double sunY, double sunZ)
        {
            float[] directions = GlareDirections(glare, sunX, sunY, sunZ);
            float[] colors = new float[directions.Length];
            SkyDome.PaintDirections(directions,
                SkyDome.MakeSkyPainter(noon, midnight, nightMix, sunX, sunY, sunZ), colors);
            return colors;
        }

        /// <summary>uVeilDensity: the blended palette's FOG_TERRAIN density times <see cref="GlareVeilGain"/>.</summary>
        public static double VeilDensity(Palette active) => active.Values[PaletteCategory.FOG_TERRAIN] * GlareVeilGain;

        /// <summary>game.ts updateSunEntity: the disc and glare are drawn only while the sun is above <see cref="SunSetElevationDeg"/>.</summary>
        public static bool IsVisible(double sunElevationDeg) => sunElevationDeg > SunSetElevationDeg;
    }
}

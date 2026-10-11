using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>The sky dome's geometry: float32 buffers exactly as skyDomeModelBuilder.ts builds them.</summary>
    public sealed class SkyDomeGeometry
    {
        /// <summary>xyz per vertex, radius <see cref="SkyDome.DomeRadius"/> (rows = rings bottom to top, 33 columns with the seam duplicated).</summary>
        public float[] Positions;
        /// <summary>Unit view direction per vertex (scene axes: +X east, +Y up, +Z south).</summary>
        public float[] Directions;
        /// <summary>Triangle list, 960 triangles, wound to face the camera at the centre (front faces).</summary>
        public int[] Indices;
        public int VertexCount => Positions.Length / 3;
    }

    /// <summary>
    /// Port of the CPU half of src/script/scene/models/lib/skyDomeModelBuilder.ts:
    /// the 16-ring x 32-segment vertex-coloured dome and the sky painter that
    /// colours any view direction from the authored noon/midnight palettes, the
    /// night mix and the per-direction atmosphere shade. Repaint whenever the sun
    /// or the palette profile changes (not per frame).
    /// </summary>
    public static class SkyDome
    {
        private const double Deg2Rad = Math.PI / 180;
        private const double Rad2Deg = 180 / Math.PI;

        /// <summary>Radius in the background-sky camera's space (rotation-only camera at the origin).</summary>
        public const double DomeRadius = 1000;

        /// <summary>Ring elevations, degrees, bunched near the horizon, with a skirt below it.</summary>
        public static readonly double[] RingElevationsDeg =
        {
            -20, -8, -3, -1, 0, 1, 2.5, 4.5, 7, 10.5, 15, 21, 30, 42, 58, 90,
        };

        public const int AzimuthSegments = 32;
        /// <summary>Exponent the directional brightness ratio is softened by (times 1 - nightMix).</summary>
        public const double GainSoftness = 0.8;
        public const double SaturationHeadroomCool = 2.5;
        public const double SaturationHeadroomWarm = 6.0;
        public const double FullyWarmChroma = 0.3;
        private const double NeutralChroma = 1.0 / 3;
        private static readonly double[] LumaWeights = { 0.2126, 0.7152, 0.0722 };

        /// <summary>A painter: writes the linear sky colour for direction (x, y, z) into o[0..2] (before the gamut fit).</summary>
        public delegate void SkyPainter(double x, double y, double z, double[] o);

        private static double VerticalBlend(double elevationDeg)
        {
            double t = Math.Min(1, Math.Max(0, elevationDeg / 35));
            return t * t * (3 - 2 * t);
        }

        /// <summary>blendAuthored: the two authored palettes' base colour for a category, mixed in linear light.</summary>
        public static double[] BlendAuthored(Palette noon, Palette midnight, PaletteCategory category, double nightMix)
        {
            double[] day = SkyColor.ToLinear(SkyColor.ParseHex(noon.Color(category)));
            double[] night = SkyColor.ToLinear(SkyColor.ParseHex(midnight.Color(category)));
            return new[]
            {
                day[0] + (night[0] - day[0]) * nightMix,
                day[1] + (night[1] - day[1]) * nightMix,
                day[2] + (night[2] - day[2]) * nightMix,
            };
        }

        /// <summary>
        /// skyDomeModelBuilder.ts makeSkyPainter. Takes the two AUTHORED palettes
        /// (not the blended one: its sky colours already carry the slot gains),
        /// the night mix and the unit vector towards the sun.
        /// </summary>
        public static SkyPainter MakeSkyPainter(Palette noon, Palette midnight, double nightMix, double sunX, double sunY, double sunZ)
        {
            double[] zenith = BlendAuthored(noon, midnight, PaletteCategory.SKY, nightMix);
            double[] horizon = BlendAuthored(noon, midnight, PaletteCategory.FOG_SKY, nightMix);
            double[] nightZenith = BlendAuthored(noon, midnight, PaletteCategory.SKY, 1);
            double[] nightHorizon = BlendAuthored(noon, midnight, PaletteCategory.FOG_SKY, 1);

            double sunElevationDeg = JsTrig.Asin(Math.Max(-1, Math.Min(1, sunY))) * Rad2Deg;
            double sunBearing = JsTrig.Atan2(sunX, sunZ);
            double exponent = GainSoftness * (1 - nightMix);

            return (x, y, z, o) =>
            {
                double elevationDeg = JsTrig.Asin(Math.Max(-1, Math.Min(1, y))) * Rad2Deg;
                double azimuth = JsTrig.Atan2(x, z) - sunBearing;
                azimuth = Math.Abs(JsTrig.Atan2(JsTrig.Sin(azimuth), JsTrig.Cos(azimuth))) * Rad2Deg;

                double blend = VerticalBlend(elevationDeg);
                DomeShade shade = SkyModel.Shade(sunElevationDeg, elevationDeg, azimuth);
                double[] chroma = { shade.ChromaR, shade.ChromaG, shade.ChromaB };

                double baseLuminance = 0, baseTotal = 0, floorLuminance = 0;
                for (int c = 0; c < 3; c++)
                {
                    double b = horizon[c] + (zenith[c] - horizon[c]) * blend;
                    o[c] = b;
                    baseLuminance += LumaWeights[c] * b;
                    baseTotal += b;
                    floorLuminance += LumaWeights[c]
                        * (nightHorizon[c] + (nightZenith[c] - nightHorizon[c]) * blend);
                }

                double trust = shade.HueWeight * (1 - nightMix);

                double authoredSaturation = 0, skySaturation = 0;
                for (int c = 0; c < 3; c++)
                {
                    double authored = baseTotal > 1e-9 ? o[c] / baseTotal : NeutralChroma;
                    authoredSaturation += Math.Abs(authored - NeutralChroma);
                    skySaturation += Math.Abs(chroma[c] - NeutralChroma);
                }
                double warmth = Math.Min(1, Math.Max(0, (chroma[0] - chroma[2]) / FullyWarmChroma));
                double headroom = SaturationHeadroomCool
                    + (SaturationHeadroomWarm - SaturationHeadroomCool) * warmth;
                double reined = skySaturation > 1e-6
                    ? Math.Min(1, headroom * authoredSaturation / skySaturation)
                    : 1;

                double chromaLuminance = 0;
                for (int c = 0; c < 3; c++)
                {
                    double authored = baseTotal > 1e-9 ? o[c] / baseTotal : NeutralChroma;
                    double sky = NeutralChroma + (chroma[c] - NeutralChroma) * reined;
                    o[c] = authored + (sky - authored) * trust;
                    chromaLuminance += LumaWeights[c] * o[c];
                }

                double target = Math.Max(
                    floorLuminance, baseLuminance * Math.Pow(shade.Brightness, exponent));
                double scale = chromaLuminance > 1e-9 ? target / chromaLuminance : 0;
                for (int c = 0; c < 3; c++)
                {
                    o[c] *= scale;
                }
            };
        }

        /// <summary>fitToGamut: dims an out-of-gamut colour by 1 / its peak channel, keeping the hue.</summary>
        public static void FitToGamut(double[] c)
        {
            double peak = Math.Max(c[0], Math.Max(c[1], c[2]));
            if (peak <= 1)
            {
                return;
            }
            double scale = 1 / peak;
            for (int i = 0; i < 3; i++)
            {
                c[i] *= scale;
            }
        }

        /// <summary>
        /// paintDirections: the linear sky colour (gamut-fitted, float32 like
        /// the skyColor attribute) for every direction triple.
        /// </summary>
        public static void PaintDirections(float[] directions, SkyPainter paint, float[] colors)
        {
            double[] scratch = new double[3];
            for (int i = 0; i < colors.Length; i += 3)
            {
                paint(directions[i], directions[i + 1], directions[i + 2], scratch);
                FitToGamut(scratch);
                colors[i] = (float)scratch[0];
                colors[i + 1] = (float)scratch[1];
                colors[i + 2] = (float)scratch[2];
            }
        }

        /// <summary>
        /// paintSkyDome: the dome's skyColor attribute for the sun at
        /// (sunX, sunY, sunZ) and nightMix (SunState.NightMix). Returns a new
        /// float array, 3 per vertex, linear RGB in 0..1.
        /// </summary>
        public static float[] Paint(SkyDomeGeometry dome, Palette noon, Palette midnight, double nightMix,
            double sunX, double sunY, double sunZ)
        {
            float[] colors = new float[dome.Directions.Length];
            PaintDirections(dome.Directions, MakeSkyPainter(noon, midnight, nightMix, sunX, sunY, sunZ), colors);
            return colors;
        }

        /// <summary>buildDomeGeometry: positions, directions and indices of the 16 x 33 vertex dome.</summary>
        public static SkyDomeGeometry BuildGeometry()
        {
            int rings = RingElevationsDeg.Length;
            int columns = AzimuthSegments + 1;
            int count = rings * columns;
            float[] positions = new float[count * 3];
            float[] directions = new float[count * 3];

            for (int r = 0; r < rings; r++)
            {
                double elevation = RingElevationsDeg[r] * Deg2Rad;
                double cosElevation = JsTrig.Cos(elevation);
                double sinElevation = JsTrig.Sin(elevation);
                for (int c = 0; c < columns; c++)
                {
                    double azimuth = 2 * Math.PI * c / AzimuthSegments;
                    int i = (r * columns + c) * 3;
                    double x = cosElevation * JsTrig.Sin(azimuth);
                    double y = sinElevation;
                    double z = cosElevation * JsTrig.Cos(azimuth);
                    directions[i] = (float)x; directions[i + 1] = (float)y; directions[i + 2] = (float)z;
                    positions[i] = (float)(x * DomeRadius);
                    positions[i + 1] = (float)(y * DomeRadius);
                    positions[i + 2] = (float)(z * DomeRadius);
                }
            }

            int[] index = new int[(rings - 1) * AzimuthSegments * 6];
            int k = 0;
            for (int r = 0; r < rings - 1; r++)
            {
                for (int c = 0; c < AzimuthSegments; c++)
                {
                    int a = r * columns + c;
                    int b = a + 1;
                    int d = (r + 1) * columns + c;
                    int e = d + 1;
                    index[k++] = a; index[k++] = d; index[k++] = b;
                    index[k++] = b; index[k++] = d; index[k++] = e;
                }
            }
            return new SkyDomeGeometry { Positions = positions, Directions = directions, Indices = index };
        }
    }
}

using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Terrain;

namespace Retro.Game
{
    /// <summary>
    /// What a part is drawn in (airfieldModel.ts Paint): a palette tone, a lift
    /// over it, optionally a literal colour in its place (the tone still says
    /// how it fogs), and for runway paint the footprint past which the geometry
    /// gives way to the pavement texture.
    /// </summary>
    public sealed class AirfieldPaint
    {
        public PaletteCategory Category;
        public double Lighten = 1;
        /// <summary>`#rrggbb`, or null for the palette tone.</summary>
        public string RawColor;
        public double? MaxFootprintM;

        /// <summary>A bare tone: airfieldModel.ts passes the category itself as the paint.</summary>
        public bool Bare;

        public static AirfieldPaint Of(PaletteCategory c) => new AirfieldPaint { Category = c, Bare = true };

        /// <summary>paintKey: parts with the same key are merged into one draw.</summary>
        public string Key => Bare
            ? PaletteCategories.Key(Category)
            : PaletteCategories.Key(Category) + "*" + JsNumber(Lighten) + (RawColor ?? "")
                + (MaxFootprintM.HasValue ? "@" + JsNumber(MaxFootprintM.Value) : "");

        private static string JsNumber(double v) => v.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>One draw of an airfield level: triangles in one paint.</summary>
    public sealed class AirfieldPart
    {
        public string Key;
        public AirfieldPaint Paint;
        /// <summary>Triangle soup, xyz per vertex, relative to <see cref="AirfieldGeometry.Origin"/>, float32 as the TS stores it.</summary>
        public float[] Positions;
        /// <summary>Only on a textured pavement quad: (0,0) (0,1) (1,1) (0,0) (1,1) (1,0).</summary>
        public float[] Uvs;
        /// <summary>The runway whose marking texture a textured part samples; -1 otherwise.</summary>
        public int MarkedRunway = -1;
        /// <summary>A lit, depth-writing solid (buildings); flats are unlit paint that does not write depth.</summary>
        public bool Shaded;
    }

    public sealed class AirfieldLevel
    {
        /// <summary>Unlit ground paint, in drawing order.</summary>
        public List<AirfieldPart> Flats = new List<AirfieldPart>();
        /// <summary>Lit boxes.</summary>
        public List<AirfieldPart> Volumes = new List<AirfieldPart>();
    }

    /// <summary>An unpaved runway, to be repainted in the colour of the ground drawn under it (GroundStrip).</summary>
    public sealed class AirfieldGroundStrip
    {
        /// <summary>Scene positions of the low threshold, midpoint and high threshold.</summary>
        public Vec3d[] Samples;
        /// <summary>The key of its pavement parts in every level.</summary>
        public string PaintKey;
        /// <summary>Worst zoom painted from; -1 for the stand-in, +inf when never repainted.</summary>
        public double PaintedZoom;
        public double Lighten;
    }

    /// <summary>One airfield, built (airfieldModel.ts AirfieldModel without the three.js objects).</summary>
    public sealed class AirfieldGeometry
    {
        /// <summary>Scene position everything is relative to: the primary runway's centre, on its plane.</summary>
        public Vec3d Origin;
        /// <summary>LOD levels, finest first.</summary>
        public AirfieldLevel[] Levels;
        /// <summary>Per runway (airfield order): its paint as a coverage mask, or null when unpaved.</summary>
        public MarkingTexture[] MarkingTextures;
        public double MaxSize;
        public List<AirfieldGroundStrip> GroundStrips = new List<AirfieldGroundStrip>();
    }

    /// <summary>
    /// A real airfield built as flat-shaded geometry (port of airfieldModel.ts).
    /// Every vertex goes geodetic to ECEF to ENU, the way the bake places
    /// terrain vertices, relative to the primary runway's centre so float32
    /// keeps centimetres.
    /// </summary>
    public static class AirfieldGeometryBuilder
    {
        /// <summary>How far the pavement floats over the flattened terrain (= SCENERY_SURFACE_EPS_M).</summary>
        public const double AirfieldSurfaceEpsM = 1.5;
        private const double PaintLiftM = 0.05;
        /// <summary>Runway paint geometry is dropped where a pixel spans more ground than this.</summary>
        public const double PaintMaxFootprintM = 1.2;
        /// <summary>Closer than this the marking texture is gone and only geometry paint shows.</summary>
        public const double MarkingTextureFadeOutM = 0.15;
        private const double TaxiwayStripeM = 0.5;
        private const double DegenerateSegmentM = 0.01;
        private const double TaxiwayStepM = 20;
        public const double GroundStripLighten = 1.1;
        private const double RunwaySeaLevelGuardM = 2;

        private const double JointMinTurnRad = 1 * Math.PI / 180;
        private const double JointSagM = 0.2;
        private const int JointMaxSteps = 16;
        private const double SmoothMinTurnRad = 2 * Math.PI / 180;
        private const double SmoothSagM = 0.5;
        private const int SmoothMaxSteps = 8;
        private const double SmoothReachWidths = 1;

        /// <summary>Coarsest level that still draws taxiways, aprons and buildings.</summary>
        public const int LodWithSurrounds = 1;

        private static readonly MarkingKind[][] LodKinds =
        {
            new[] { MarkingKind.Pavement, MarkingKind.Threshold, MarkingKind.Designator, MarkingKind.Aiming, MarkingKind.Centreline, MarkingKind.Edge },
            new[] { MarkingKind.Pavement },
            new[] { MarkingKind.Pavement },
        };

        private static PaletteCategory RunwayFallbackCategory(RunwaySurface s)
        {
            switch (s)
            {
                case RunwaySurface.Concrete: return PaletteCategory.SCENERY_BASE_CONCRETE;
                case RunwaySurface.Grass: return PaletteCategory.TERRAIN_GRASS;
                case RunwaySurface.Gravel: return PaletteCategory.TERRAIN_BARE;
                default: return PaletteCategory.SCENERY_ROAD_SECONDARY;
            }
        }

        public static PaletteCategory MarkingCategory(MarkingKind kind)
        {
            switch (kind)
            {
                case MarkingKind.Threshold:
                case MarkingKind.Designator:
                    return PaletteCategory.SCENERY_BASE_RUNWAY_THRESHOLD;
                case MarkingKind.Aiming:
                case MarkingKind.Centreline:
                case MarkingKind.Edge:
                    return PaletteCategory.SCENERY_BASE_RUNWAY_LINES;
                default:
                    return PaletteCategory.SCENERY_ROAD_SECONDARY;
            }
        }

        private static PaletteCategory BuildingCategory(AirfieldBuildingKind kind)
        {
            switch (kind)
            {
                case AirfieldBuildingKind.Hangar: return PaletteCategory.SCENERY_BUILDING_METAL;
                case AirfieldBuildingKind.Terminal: return PaletteCategory.SCENERY_BUILDING_PLASTER_WHITE;
                default: return PaletteCategory.SCENERY_BUILDING_CONCRETE;
            }
        }

        private static double RunwayLighten(RunwaySurface s) =>
            s == RunwaySurface.Asphalt || s == RunwaySurface.Concrete ? 1 : GroundStripLighten;

        /// <summary>Height of one building, from OSM where it says so and from its shape where not.</summary>
        public static double BuildingHeightM(AirfieldBuilding b)
        {
            if (b.HeightM.HasValue && b.HeightM.Value > 0) return b.HeightM.Value;
            bool ofMin;
            double ratio, min, max;
            switch (b.Kind)
            {
                case AirfieldBuildingKind.Terminal: ofMin = true; ratio = 0.25; min = 6; max = 25; break;
                case AirfieldBuildingKind.Tower: ofMin = false; ratio = 1.6; min = 20; max = 45; break;
                default: ofMin = true; ratio = 0.45; min = 6; max = 30; break;
            }
            double baseM = ofMin ? Math.Min(b.WidthM, b.DepthM) : Math.Max(b.WidthM, b.DepthM);
            return Math.Min(max, Math.Max(min, baseM * ratio));
        }

        /// <summary>What the taxiways and aprons are paved with: the primary runway's concrete, else asphalt.</summary>
        private static PaletteCategory GroundSurfaceOf(Airfield airfield)
        {
            AirfieldRunway primary = Airfields.PrimaryRunway(airfield);
            return primary != null && primary.Surface == RunwaySurface.Concrete
                ? PaletteCategory.SCENERY_BASE_CONCRETE
                : PaletteCategory.SCENERY_ROAD_SECONDARY;
        }

        /// <summary>Accumulates triangles per paint, so one paint is one draw (MeshParts).</summary>
        private sealed class MeshParts
        {
            private readonly bool shaded;
            private readonly List<AirfieldPart> order = new List<AirfieldPart>();
            private readonly Dictionary<string, (AirfieldPart Part, List<double> Positions)> parts =
                new Dictionary<string, (AirfieldPart, List<double>)>();

            public MeshParts(bool shaded) => this.shaded = shaded;

            public void Add(AirfieldPaint paint, Vec3d a, Vec3d b, Vec3d c)
            {
                string key = paint.Key;
                if (!parts.TryGetValue(key, out var entry))
                {
                    entry = (new AirfieldPart { Key = key, Paint = paint, Shaded = shaded }, new List<double>());
                    parts[key] = entry;
                    order.Add(entry.Part);
                }
                List<double> p = entry.Positions;
                p.Add(a.X); p.Add(a.Y); p.Add(a.Z);
                p.Add(b.X); p.Add(b.Y); p.Add(b.Z);
                p.Add(c.X); p.Add(c.Y); p.Add(c.Z);
            }

            public void AddQuad(AirfieldPaint paint, Vec3d a, Vec3d b, Vec3d c, Vec3d d)
            {
                Add(paint, a, b, c);
                Add(paint, a, c, d);
            }

            /// <summary>A quad in a material of its own with UVs (0,0) (0,1) (1,1) (1,0) at a, b, c, d; never merged.</summary>
            public void AddTexturedQuad(AirfieldPaint paint, int runway, Vec3d a, Vec3d b, Vec3d c, Vec3d d)
            {
                string key = "textured#" + parts.Count;
                var positions = new List<double>();
                foreach (Vec3d p in new[] { a, b, c, a, c, d })
                {
                    positions.Add(p.X); positions.Add(p.Y); positions.Add(p.Z);
                }
                var part = new AirfieldPart
                {
                    Key = key, Paint = paint, MarkedRunway = runway, Shaded = shaded,
                    Uvs = new float[] { 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0 },
                };
                parts[key] = (part, positions);
                order.Add(part);
            }

            public List<AirfieldPart> Build()
            {
                foreach (AirfieldPart part in order)
                {
                    List<double> p = parts[part.Key].Positions;
                    var f = new float[p.Count];
                    for (int i = 0; i < f.Length; i++) f[i] = (float)p[i];
                    part.Positions = f;
                }
                return order;
            }
        }

        /// <summary>
        /// Build one airfield; null for one with no runway. `groundElevationAt`
        /// (ellipsoidal height of the real ground at an ENU point) drapes the
        /// taxiways, aprons and buildings; without it they lie on the plane.
        /// `triangulate` is three's ShapeUtils.triangulateShape for apron rings
        /// (<see cref="ShapeUtils.TriangulateShape"/>); null leaves the aprons out.
        /// </summary>
        public static AirfieldGeometry Build(
            Airfield airfield, EnuBasis basis,
            Func<double, double, double> groundElevationAt,
            Func<IReadOnlyList<(double X, double Y)>, List<int[]>> triangulate)
        {
            AirfieldRunway primary = Airfields.PrimaryRunway(airfield);
            if (primary == null) return null;

            (double E, double N) ToEnu(double lat, double lon)
            {
                Enu enu = Geodesy.EcefToEnu(basis, Geodesy.GeodeticToEcef(lat, lon, 0));
                return (enu.E, enu.N);
            }

            var planeCentre = ToEnu(primary.Lat, primary.Lon);
            var riseAxis = FlattenPads.BearingAxisAt(primary.Lat, primary.Lon, airfield.Plane.HeadingDeg, ToEnu);
            double ElevationAt(double e, double n) =>
                airfield.Plane.HeightMsl + airfield.Plane.Gradient
                * ((e - planeCentre.E) * riseAxis.E + (n - planeCentre.N) * riseAxis.N);

            Vec3d origin = SceneAt(basis, planeCentre.E, planeCentre.N, ElevationAt(planeCentre.E, planeCentre.N));
            Vec3d Place(double e, double n, double lift) => SceneAt(basis, e, n, ElevationAt(e, n) + lift) - origin;
            Vec3d Drape(double e, double n, double lift) =>
                SceneAt(basis, e, n, (groundElevationAt != null ? groundElevationAt(e, n) : ElevationAt(e, n)) + lift) - origin;

            var geometry = new AirfieldGeometry
            {
                Origin = origin,
                MarkingTextures = new MarkingTexture[airfield.Runways.Count],
            };

            // Paved runways in their own tone; unpaved ones in their stand-in until the ground under them is read.
            var paints = new AirfieldPaint[airfield.Runways.Count];
            for (int i = 0; i < airfield.Runways.Count; i++)
            {
                AirfieldRunway runway = airfield.Runways[i];
                double lighten = RunwayLighten(runway.Surface);
                if (runway.Surface == RunwaySurface.Asphalt || runway.Surface == RunwaySurface.Concrete)
                {
                    paints[i] = new AirfieldPaint { Category = RunwayFallbackCategory(runway.Surface), Lighten = lighten };
                }
                else
                {
                    bool nearSeaLevel = Math.Abs(airfield.Plane.HeightMsl) <= RunwaySeaLevelGuardM;
                    paints[i] = new AirfieldPaint
                    {
                        Category = nearSeaLevel ? PaletteCategory.TERRAIN_SAND : RunwayFallbackCategory(runway.Surface),
                        Lighten = lighten,
                    };
                    var samples = new List<Vec3d>();
                    foreach (var (lat, lon) in RunwaySamplePoints(runway))
                    {
                        var p = ToEnu(lat, lon);
                        samples.Add(SceneAt(basis, p.E, p.N, ElevationAt(p.E, p.N)));
                    }
                    geometry.GroundStrips.Add(new AirfieldGroundStrip
                    {
                        Samples = samples.ToArray(),
                        PaintKey = paints[i].Key,
                        PaintedZoom = nearSeaLevel ? double.PositiveInfinity : -1,
                        Lighten = lighten,
                    });
                }
                if (RunwayMarkings.IsPaintedSurface(runway.Surface))
                {
                    geometry.MarkingTextures[i] = RunwayMarkingTexture.Rasterise(
                        RunwayMarkings.For(runway.LengthM, runway.WidthM, runway.Ref, runway.Surface),
                        runway.LengthM, runway.WidthM);
                }
            }

            var levels = new AirfieldLevel[LodKinds.Length];
            double maxSize = 0;
            for (int level = 0; level < LodKinds.Length; level++)
            {
                var kinds = new HashSet<MarkingKind>(LodKinds[level]);
                var flats = new MeshParts(false);
                var solids = new MeshParts(true);
                if (level <= LodWithSurrounds)
                {
                    PaletteCategory pavement = GroundSurfaceOf(airfield);
                    AddAprons(flats, airfield, ToEnu, Drape, pavement, triangulate);
                    AddTaxiways(flats, airfield, ToEnu, Drape, kinds.Contains(MarkingKind.Centreline), pavement);
                    AddBuildings(solids, airfield, ToEnu, Drape);
                }
                // Every runway's pavement before any runway's paint.
                foreach (bool paintPass in new[] { false, true })
                {
                    for (int i = 0; i < airfield.Runways.Count; i++)
                    {
                        AirfieldRunway runway = airfield.Runways[i];
                        maxSize = Math.Max(maxSize, runway.LengthM);
                        AddRunway(flats, runway, i, paints[i], geometry.MarkingTextures[i] != null, kinds, paintPass, ToEnu, Place);
                    }
                }
                levels[level] = new AirfieldLevel { Flats = flats.Build(), Volumes = solids.Build() };
            }
            geometry.Levels = levels;
            geometry.MaxSize = Math.Max(maxSize, 1);
            return geometry;
        }

        private static IEnumerable<(double Lat, double Lon)> RunwaySamplePoints(AirfieldRunway runway)
        {
            double[] low = runway.Thresholds.Length > 0 ? runway.Thresholds[0] : new[] { runway.Lat, runway.Lon };
            double[] high = runway.Thresholds.Length > 1 ? runway.Thresholds[1] : new[] { runway.Lat, runway.Lon };
            yield return (low[0], low[1]);
            yield return (runway.Lat, runway.Lon);
            yield return (high[0], high[1]);
        }

        /// <summary>Scene position of an ENU point at an elevation, read back on the ellipsoid (not the tangent plane).</summary>
        public static Vec3d SceneAt(EnuBasis basis, double e, double n, double elevation)
        {
            Geodetic g = Geodesy.GeodeticOnSurfaceAtEnu(basis, e, n);
            return Geodesy.SceneFromEnu(Geodesy.EcefToEnu(basis, Geodesy.GeodeticToEcef(g.Lat, g.Lon, elevation)));
        }

        private static double SignedArea(IReadOnlyList<(double E, double N)> ring)
        {
            double sum = 0;
            for (int i = 0; i < ring.Count; i++)
            {
                var a = ring[i];
                var b = ring[(i + 1) % ring.Count];
                sum += a.E * b.N - b.E * a.N;
            }
            return sum;
        }

        private static void AddRunway(
            MeshParts parts, AirfieldRunway runway, int index, AirfieldPaint pavement, bool marked,
            HashSet<MarkingKind> kinds, bool paintPass, Func<double, double, (double E, double N)> toEnu,
            Func<double, double, double, Vec3d> place)
        {
            var centre = toEnu(runway.Lat, runway.Lon);
            var axis = FlattenPads.BearingAxisAt(runway.Lat, runway.Lon, runway.HeadingDeg, toEnu);
            var right = (E: axis.N, N: -axis.E);
            Vec3d At(double u, double v, double lift) => place(
                centre.E + axis.E * u + right.E * v,
                centre.N + axis.N * u + right.N * v,
                lift);

            foreach (MarkingRect rect in RunwayMarkings.For(runway.LengthM, runway.WidthM, runway.Ref, runway.Surface))
            {
                if (!kinds.Contains(rect.Kind) || (rect.Kind == MarkingKind.Pavement) != !paintPass) continue;
                if (rect.Kind == MarkingKind.Pavement)
                {
                    var (a, b, c, d) = QuadCorners(rect, At, AirfieldSurfaceEpsM);
                    if (marked) parts.AddTexturedQuad(pavement, index, a, b, c, d);
                    else parts.AddQuad(pavement, a, b, c, d);
                    continue;
                }
                var paint = new AirfieldPaint
                {
                    Category = MarkingCategory(rect.Kind),
                    Lighten = 1,
                    MaxFootprintM = marked ? PaintMaxFootprintM : (double?)null,
                };
                var q = QuadCorners(rect, At, AirfieldSurfaceEpsM + PaintLiftM);
                parts.AddQuad(paint, q.A, q.B, q.C, q.D);
            }
        }

        private static (Vec3d A, Vec3d B, Vec3d C, Vec3d D) QuadCorners(
            MarkingRect rect, Func<double, double, double, Vec3d> at, double lift)
        {
            double u0 = rect.U - rect.LengthM / 2;
            double u1 = rect.U + rect.LengthM / 2;
            double v0 = rect.V - rect.WidthM / 2;
            double v1 = rect.V + rect.WidthM / 2;
            return (at(u0, v0, lift), at(u0, v1, lift), at(u1, v1, lift), at(u1, v0, lift));
        }

        private struct TaxiwaySegment
        {
            public (double E, double N) A;
            public double De, Dn, Len, Px, Py;
        }

        private static (double, double) HeldTangent(double te, double tn, double limit)
        {
            double len = JsMath.Hypot(te, tn);
            return len > limit && len > 0 ? ((te / len) * limit, (tn / len) * limit) : (te, tn);
        }

        /// <summary>Resample a taxiway centreline through a guarded centripetal Catmull-Rom (smoothCentreline).</summary>
        public static List<(double E, double N)> SmoothCentreline(IReadOnlyList<(double E, double N)> points, double widthM)
        {
            double maxOffsetM = widthM / 2;
            double reach = widthM * SmoothReachWidths;
            var p = new List<(double E, double N)>();
            foreach (var q in points)
            {
                if (p.Count == 0 || JsMath.Hypot(q.E - p[p.Count - 1].E, q.N - p[p.Count - 1].N) >= DegenerateSegmentM) p.Add(q);
            }
            if (p.Count < 3) return p;

            var turns = new bool[p.Count];
            for (int i = 1; i < p.Count - 1; i++)
            {
                double ae = p[i].E - p[i - 1].E, an = p[i].N - p[i - 1].N;
                double be = p[i + 1].E - p[i].E, bn = p[i + 1].N - p[i].N;
                turns[i] = Math.Abs(JsTrig.Atan2(ae * bn - an * be, ae * be + an * bn)) >= SmoothMinTurnRad;
            }

            var nodes = new List<(double E, double N)>();
            var corner = new List<bool>();
            for (int i = 0; i + 1 < p.Count; i++)
            {
                nodes.Add(p[i]);
                corner.Add(turns[i]);
                double de = p[i + 1].E - p[i].E, dn = p[i + 1].N - p[i].N;
                double len = JsMath.Hypot(de, dn);
                int cuts = (turns[i] ? 1 : 0) + (turns[i + 1] ? 1 : 0);
                if (cuts == 0 || len <= cuts * reach) continue;
                foreach (double at in new[] { turns[i] ? reach : 0, turns[i + 1] ? len - reach : 0 })
                {
                    if (at > 0)
                    {
                        nodes.Add((p[i].E + (de / len) * at, p[i].N + (dn / len) * at));
                        corner.Add(false);
                    }
                }
            }
            nodes.Add(p[p.Count - 1]);
            corner.Add(false);
            p = nodes;

            double Knot((double E, double N) a, (double E, double N) b) => Math.Sqrt(JsMath.Hypot(b.E - a.E, b.N - a.N));

            var output = new List<(double E, double N)> { p[0] };
            for (int i = 0; i + 1 < p.Count; i++)
            {
                var p1 = p[i];
                var p2 = p[i + 1];
                double chordE = p2.E - p1.E, chordN = p2.N - p1.N;
                double chordLen = JsMath.Hypot(chordE, chordN);
                double dB = Knot(p1, p2);
                double limit = Math.Min(chordLen, reach);
                var (t1e, t1n) = HeldTangent(chordE, chordN, limit);
                if (corner[i])
                {
                    var p0 = p[i - 1];
                    double w = dB / (Knot(p0, p1) + dB);
                    (t1e, t1n) = HeldTangent(w * (p2.E - p0.E), w * (p2.N - p0.N), limit);
                }
                var (t2e, t2n) = HeldTangent(chordE, chordN, limit);
                if (corner[i + 1])
                {
                    var p3 = p[i + 2];
                    double w = dB / (dB + Knot(p2, p3));
                    (t2e, t2n) = HeldTangent(w * (p3.E - p1.E), w * (p3.N - p1.N), limit);
                }

                (double E, double N) At(double u)
                {
                    double uu = u * u;
                    double uuu = uu * u;
                    double h00 = 2 * uuu - 3 * uu + 1;
                    double h10 = uuu - 2 * uu + u;
                    double h01 = -2 * uuu + 3 * uu;
                    double h11 = uuu - uu;
                    return (h00 * p1.E + h10 * t1e + h01 * p2.E + h11 * t2e,
                        h00 * p1.N + h10 * t1n + h01 * p2.N + h11 * t2n);
                }

                double offset = 0;
                foreach (double u in new[] { 0.25, 0.5, 0.75 })
                {
                    var q = At(u);
                    offset = Math.Max(offset, Math.Abs((q.E - p1.E) * chordN - (q.N - p1.N) * chordE) / chordLen);
                }
                int steps = offset > maxOffsetM
                    ? 1
                    : (int)Math.Min(SmoothMaxSteps, Math.Max(1, Math.Ceiling(Math.Sqrt(offset / SmoothSagM))));
                for (int s = 1; s < steps; s++) output.Add(At((double)s / steps));
                output.Add(p2);
            }
            return output;
        }

        private static void AddTaxiways(
            MeshParts parts, Airfield airfield, Func<double, double, (double E, double N)> toEnu,
            Func<double, double, double, Vec3d> place, bool withStripe, PaletteCategory pavement)
        {
            foreach (AirfieldTaxiway taxiway in airfield.Taxiways)
            {
                var raw = new List<(double E, double N)>();
                foreach (double[] pt in taxiway.Points) raw.Add(toEnu(pt[0], pt[1]));
                List<(double E, double N)> points = SmoothCentreline(raw, taxiway.WidthM);
                var segments = new List<TaxiwaySegment>();
                for (int i = 0; i + 1 < points.Count; i++)
                {
                    var a = points[i];
                    var b = points[i + 1];
                    double de = b.E - a.E, dn = b.N - a.N;
                    double len = JsMath.Hypot(de, dn);
                    if (len < DegenerateSegmentM) continue;
                    segments.Add(new TaxiwaySegment { A = a, De = de, Dn = dn, Len = len, Px = -dn / len, Py = de / len });
                }

                void Lay(double width, double lift, PaletteCategory category)
                {
                    AirfieldPaint paint = AirfieldPaint.Of(category);
                    double h = width / 2;
                    foreach (TaxiwaySegment seg in segments)
                    {
                        int steps = (int)Math.Max(1, Math.Ceiling(seg.Len / TaxiwayStepM));
                        for (int s = 0; s < steps; s++)
                        {
                            double t0 = (double)s / steps;
                            double t1 = (double)(s + 1) / steps;
                            double e0 = seg.A.E + seg.De * t0, n0 = seg.A.N + seg.Dn * t0;
                            double e1 = seg.A.E + seg.De * t1, n1 = seg.A.N + seg.Dn * t1;
                            parts.AddQuad(paint,
                                place(e0 + seg.Px * h, n0 + seg.Py * h, lift),
                                place(e0 - seg.Px * h, n0 - seg.Py * h, lift),
                                place(e1 - seg.Px * h, n1 - seg.Py * h, lift),
                                place(e1 + seg.Px * h, n1 + seg.Py * h, lift));
                        }
                    }
                    for (int i = 0; i + 1 < segments.Count; i++)
                    {
                        AddTaxiwayJoint(parts, segments[i], segments[i + 1], h, lift, paint, place);
                    }
                }

                Lay(taxiway.WidthM, AirfieldSurfaceEpsM, pavement);
                if (withStripe) Lay(TaxiwayStripeM, AirfieldSurfaceEpsM + PaintLiftM, PaletteCategory.SCENERY_FIELD_YELLOW);
            }
        }

        /// <summary>Fills the wedge two segments leave open on the outside of a turn with a fan.</summary>
        private static void AddTaxiwayJoint(
            MeshParts parts, TaxiwaySegment prev, TaxiwaySegment next, double half, double lift,
            AirfieldPaint paint, Func<double, double, double, Vec3d> place)
        {
            double cross = prev.De * next.Dn - prev.Dn * next.De;
            double dot = prev.De * next.De + prev.Dn * next.Dn;
            double turn = JsTrig.Atan2(Math.Abs(cross), dot);
            if (turn < JointMinTurnRad) return;
            double ce = prev.A.E + prev.De;
            double cn = prev.A.N + prev.Dn;

            double side = cross > 0 ? -1 : 1;
            double signed = cross > 0 ? turn : -turn;
            double chord = Math.Max(-1, Math.Min(1, 1 - JointSagM / half));
            double perStep = 2 * JsTrig.Acos(chord);
            int steps = (int)Math.Max(1, Math.Min(JointMaxSteps, Math.Ceiling(turn / perStep)));

            double startE = prev.Px * side;
            double startN = prev.Py * side;
            Vec3d centre = place(ce, cn, lift);
            Vec3d Rim(double t)
            {
                double angle = signed * t;
                double cos = JsTrig.Cos(angle);
                double sin = JsTrig.Sin(angle);
                return place(ce + half * (startE * cos - startN * sin), cn + half * (startE * sin + startN * cos), lift);
            }

            Vec3d from = Rim(0);
            for (int s = 1; s <= steps; s++)
            {
                Vec3d to = Rim((double)s / steps);
                if (signed > 0) parts.Add(paint, centre, from, to);
                else parts.Add(paint, centre, to, from);
                from = to;
            }
        }

        /// <summary>Terminals, hangars and towers as boxes, based at the lowest corner's ground.</summary>
        private static void AddBuildings(
            MeshParts parts, Airfield airfield, Func<double, double, (double E, double N)> toEnu,
            Func<double, double, double, Vec3d> place)
        {
            foreach (AirfieldBuilding building in airfield.Buildings)
            {
                var centre = toEnu(building.Lat, building.Lon);
                double r = building.HeadingDeg * Math.PI / 180;
                double ax = JsTrig.Sin(r);
                double ay = JsTrig.Cos(r);
                double halfDepth = building.DepthM / 2;
                double halfWidth = building.WidthM / 2;
                if (halfDepth < 1 || halfWidth < 1) continue;

                (double E, double N) Corner(double along, double across) =>
                    (centre.E + ax * along + ay * across, centre.N + ay * along - ax * across);
                var feet = new[]
                {
                    Corner(-halfDepth, -halfWidth),
                    Corner(-halfDepth, halfWidth),
                    Corner(halfDepth, halfWidth),
                    Corner(halfDepth, -halfWidth),
                };
                var ground = new Vec3d[4];
                double baseY = double.PositiveInfinity;
                for (int i = 0; i < 4; i++)
                {
                    ground[i] = place(feet[i].E, feet[i].N, 0);
                    baseY = Math.Min(baseY, ground[i].Y);
                }
                double height = BuildingHeightM(building);
                AirfieldPaint paint = AirfieldPaint.Of(BuildingCategory(building.Kind));
                var low = new Vec3d[4];
                var high = new Vec3d[4];
                for (int i = 0; i < 4; i++)
                {
                    low[i] = new Vec3d(ground[i].X, baseY, ground[i].Z);
                    high[i] = new Vec3d(ground[i].X, baseY + height, ground[i].Z);
                }
                for (int i = 0; i < 4; i++)
                {
                    int j = (i + 1) % 4;
                    parts.AddQuad(paint, low[j], high[j], high[i], low[i]);
                }
                parts.AddQuad(paint, high[0], high[1], high[2], high[3]);
            }
        }

        private static void AddAprons(
            MeshParts parts, Airfield airfield, Func<double, double, (double E, double N)> toEnu,
            Func<double, double, double, Vec3d> place, PaletteCategory pavement,
            Func<IReadOnlyList<(double X, double Y)>, List<int[]>> triangulate)
        {
            if (triangulate == null) return;
            AirfieldPaint paint = AirfieldPaint.Of(pavement);
            foreach (AirfieldApron apron in airfield.Aprons)
            {
                var ring = new List<(double E, double N)>();
                foreach (double[] pt in apron.Ring) ring.Add(toEnu(pt[0], pt[1]));
                if (ring.Count > 1
                    && Math.Abs(ring[0].E - ring[ring.Count - 1].E) < 1e-6
                    && Math.Abs(ring[0].N - ring[ring.Count - 1].N) < 1e-6)
                {
                    ring.RemoveAt(ring.Count - 1);
                }
                if (ring.Count < 3) continue;
                if (SignedArea(ring) < 0) ring.Reverse();
                var contour = new List<(double X, double Y)>(ring.Count);
                foreach (var p in ring) contour.Add((p.E, p.N));
                List<int[]> faces;
                try
                {
                    faces = triangulate(contour);
                }
                catch (Exception)
                {
                    continue;
                }
                foreach (int[] f in faces)
                {
                    parts.Add(paint,
                        place(ring[f[0]].E, ring[f[0]].N, AirfieldSurfaceEpsM),
                        place(ring[f[1]].E, ring[f[1]].N, AirfieldSurfaceEpsM),
                        place(ring[f[2]].E, ring[f[2]].N, AirfieldSurfaceEpsM));
                }
            }
        }
    }
}

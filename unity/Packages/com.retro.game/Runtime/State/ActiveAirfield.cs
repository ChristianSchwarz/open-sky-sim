using System;
using System.Collections.Generic;
using System.Linq;
using Retro.Core;

namespace Retro.Game
{
    // Port of src/script/state/activeAirfield.ts: the airfields of the play
    // area as the rest of the sim needs them - in scene space, with a heading
    // you can fly.
    //
    // A scene heading is *not* a compass bearing. Scene axes are x east, y up,
    // z south, so a runway on 021 true has a scene heading of 159. Converting
    // once, here, is what stops that showing up as a sign error downstream.

    public sealed class SceneRunway : IRunwayRecord
    {
        /// <summary>Threshold-to-threshold midpoint, scene space, on the pavement.</summary>
        public Vec3d Center;
        /// <summary>Scene heading (rad) landing on the low designator; 0 faces +Z.</summary>
        public double Heading;
        public double HalfLength;
        public double HalfWidth;
        /// <summary>Rise in scene Y per metre along `Heading`.</summary>
        public double Slope;
        /// <summary>Painted designators, low end first.</summary>
        public string Ref = "";
        public RunwaySurface Surface;
        public string Icao = "";
        /// <summary>Airfield name, for the spawn menu and the target label.</summary>
        public string Name = "";
        /// <summary>True when this is the longest runway of its airfield.</summary>
        public bool Primary;

        Vec3d IRunwayRecord.Center { get => Center; set => Center = value; }
        double IRunwayRecord.Heading { get => Heading; set => Heading = value; }
        double? IRunwayRecord.Slope { get => Slope; set => Slope = value ?? 0; }
    }

    /// <summary>One entry of the airfield picker.</summary>
    public sealed class AirfieldChoice
    {
        public string Icao = "";
        public string Name = "";
        public string Ref = "";
        public double LengthM;
    }

    public static class ActiveAirfield
    {
        /// <summary>Metres per degree, good enough to step a kilometre along a runway.</summary>
        private static (double Lat, double Lon) MetresPerDegree(double latDeg)
        {
            double lat = latDeg * Math.PI / 180;
            return (
                111132.92 - 559.82 * JsTrig.Cos(2 * lat) + 1.175 * JsTrig.Cos(4 * lat),
                Math.Max(1, 111412.84 * JsTrig.Cos(lat) - 93.5 * JsTrig.Cos(3 * lat)));
        }

        /// <summary>
        /// One runway in scene space, built by sampling the pavement at both
        /// thresholds and the middle, so heading, slope and centre come from the
        /// same three points the geometry and collider were built from (and fold
        /// in the first-order curvature of the earth away from the play origin).
        /// </summary>
        public static SceneRunway SceneRunwayOf(
            Airfield airfield, AirfieldRunway runway, EnuBasis basis, double surfaceEpsM)
        {
            var perDeg = MetresPerDegree(runway.Lat);
            double r = runway.HeadingDeg * Math.PI / 180;
            Vec3d At(double along)
            {
                double lat = runway.Lat + (along * JsTrig.Cos(r)) / perDeg.Lat;
                double lon = runway.Lon + (along * JsTrig.Sin(r)) / perDeg.Lon;
                double elevation = Airfields.PlaneElevationAt(airfield, runway.HeadingDeg, along) + surfaceEpsM;
                return Geodesy.SceneFromEnu(Geodesy.EcefToEnu(basis, Geodesy.GeodeticToEcef(lat, lon, elevation)));
            }

            double half = runway.LengthM / 2;
            Vec3d centre = At(0);
            Vec3d ahead = At(half);
            Vec3d behind = At(-half);
            return new SceneRunway
            {
                Center = centre,
                Heading = JsTrig.Atan2(ahead.X - behind.X, ahead.Z - behind.Z),
                HalfLength = half,
                HalfWidth = runway.WidthM / 2,
                Slope = (ahead.Y - behind.Y) / runway.LengthM,
                Ref = runway.Ref,
                Surface = runway.Surface,
                Icao = airfield.Icao,
                Name = airfield.Name,
                Primary = false,
            };
        }

        /// <summary>Every runway of every airfield here, longest first.</summary>
        public static List<SceneRunway> SceneRunwaysOf(
            IReadOnlyList<Airfield> airfields, EnuBasis basis, double surfaceEpsM)
        {
            var output = new List<SceneRunway>();
            foreach (Airfield airfield in airfields)
            {
                SceneRunway longest = null;
                foreach (AirfieldRunway runway in airfield.Runways)
                {
                    SceneRunway scene = SceneRunwayOf(airfield, runway, basis, surfaceEpsM);
                    output.Add(scene);
                    if (longest == null || scene.HalfLength > longest.HalfLength)
                    {
                        longest = scene;
                    }
                }
                if (longest != null)
                {
                    longest.Primary = true;
                }
            }
            // Stable, like Array.prototype.sort with (a, b) => b.halfLength - a.halfLength.
            return output.OrderBy(s => s, Comparer<SceneRunway>.Create((a, b) =>
            {
                double d = b.HalfLength - a.HalfLength;
                return d > 0 ? 1 : d < 0 ? -1 : 0;
            })).ToList();
        }

        /// <summary>Below this an airfield is somewhere to visit, not somewhere to be based.</summary>
        private const double MinBaseRunwayM = 1500;

        /// <summary>
        /// The runway a session should start on: the nearest usable airfield to
        /// the play origin, not the longest in the area. Usable means paved and
        /// long enough to be a base; failing that the longest paved primary, any
        /// primary, anything at all. `preferIcao` (keyed `icao || name`, as the
        /// picker offers it) picks a named one, and is ignored when that airfield
        /// is not in this area.
        /// </summary>
        public static SceneRunway PickStartRunway(IReadOnlyList<SceneRunway> runways, string preferIcao = null)
        {
            if (runways.Count == 0)
            {
                return null;
            }
            if (JsText.Truthy(preferIcao))
            {
                string Key(SceneRunway r) => JsText.Or(r.Icao, r.Name);
                SceneRunway named = runways.FirstOrDefault(r => r.Primary && Key(r) == preferIcao)
                    ?? runways.FirstOrDefault(r => Key(r) == preferIcao);
                if (named != null)
                {
                    return named;
                }
            }
            var primaries = runways.Where(r => r.Primary).ToList();
            var paved = primaries.Where(r => r.Surface == RunwaySurface.Asphalt || r.Surface == RunwaySurface.Concrete).ToList();
            var based = paved.Where(r => r.HalfLength * 2 >= MinBaseRunwayM).ToList();
            if (based.Count > 0)
            {
                // The play origin is scene (0, 0) by construction.
                return NearestSceneRunway(based, 0, 0);
            }
            // `runways` arrives sorted longest first, and filtering preserves that.
            IReadOnlyList<SceneRunway> tier = FirstNonEmpty(paved, primaries, runways);
            return tier.Count > 0 ? tier[0] : null;
        }

        private static IReadOnlyList<T> FirstNonEmpty<T>(params IReadOnlyList<T>[] tiers)
        {
            foreach (IReadOnlyList<T> tier in tiers)
            {
                if (tier.Count > 0)
                {
                    return tier;
                }
            }
            return Array.Empty<T>();
        }

        /// <summary>Closest runway centre to a point, or null when there are none.</summary>
        public static SceneRunway NearestSceneRunway(IReadOnlyList<SceneRunway> runways, double x, double z)
        {
            SceneRunway best = null;
            double bestSq = double.PositiveInfinity;
            foreach (SceneRunway runway in runways)
            {
                double dx = runway.Center.X - x;
                double dz = runway.Center.Z - z;
                double d = dx * dx + dz * dz;
                if (d < bestSq)
                {
                    bestSq = d;
                    best = runway;
                }
            }
            return best;
        }

        /// <summary>Unit forward vector along a scene heading.</summary>
        public static Vec3d HeadingForward(double heading) => new Vec3d(JsTrig.Sin(heading), 0, JsTrig.Cos(heading));

        /// <summary>One airfield entry per `icao || name`, for a picker. Longest runway decides the order.</summary>
        public static List<AirfieldChoice> AirfieldChoices(IReadOnlyList<SceneRunway> runways)
        {
            var seen = new HashSet<string>();
            var output = new List<AirfieldChoice>();
            foreach (SceneRunway runway in runways)
            {
                if (!runway.Primary)
                {
                    continue;
                }
                // A field with no ICAO is keyed by its name; two unnamed airstrips in
                // one area would otherwise collapse into one menu entry.
                string key = JsText.Or(runway.Icao, runway.Name);
                if (!seen.Add(key))
                {
                    continue;
                }
                output.Add(new AirfieldChoice
                {
                    Icao = runway.Icao,
                    Name = runway.Name,
                    Ref = runway.Ref,
                    LengthM = runway.HalfLength * 2,
                });
            }
            return output;
        }
    }
}

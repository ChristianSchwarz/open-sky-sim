using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Terrain;

namespace Retro.Game
{
    /// <summary>
    /// airfields.json into <see cref="Airfield"/> records (the parse half of
    /// airfields.ts loadAirfields). Malformed input is no airfields, not an error.
    /// </summary>
    public static class AirfieldsJson
    {
        public static AirfieldsFile Parse(string json)
        {
            JsonValue root;
            try
            {
                root = JsonReader.Parse(json);
            }
            catch (FormatException)
            {
                return Airfields.Empty;
            }
            if (root.Kind != JsonKind.Object || root["items"].Kind != JsonKind.Array) return Airfields.Empty;
            var file = new AirfieldsFile { Source = root["source"].Str("none") };
            JsonValue cov = root["coverage"];
            if (cov.Kind == JsonKind.Object)
            {
                file.Coverage = new LonLatBounds(cov["west"].Num(0), cov["south"].Num(0), cov["east"].Num(0), cov["north"].Num(0));
            }
            foreach (JsonValue a in root["items"].Items) file.Items.Add(ParseAirfield(a));
            return file;
        }

        public static Airfield ParseAirfield(JsonValue a)
        {
            JsonValue plane = a["plane"];
            var airfield = new Airfield
            {
                Name = a["name"].Str(""),
                Icao = a["icao"].Str(""),
                Iata = a["iata"].Str(""),
                Kind = a["kind"].Str(""),
                Area = a["area"].Str(""),
                Lat = a["lat"].Num(0),
                Lon = a["lon"].Num(0),
                ElevationM = a["elevationM"].Num(0),
            };
            airfield.Plane = plane.Kind == JsonKind.Object
                ? new AirfieldPlane { HeightMsl = plane["heightMsl"].Num(0), Gradient = plane["gradient"].Num(0), HeadingDeg = plane["headingDeg"].Num(0) }
                : new AirfieldPlane { HeightMsl = airfield.ElevationM };
            foreach (JsonValue r in Rows(a["runways"]))
            {
                airfield.Runways.Add(new AirfieldRunway
                {
                    Ref = r["ref"].Str(""),
                    HeadingDeg = r["headingDeg"].Num(0),
                    LengthM = r["lengthM"].Num(0),
                    WidthM = r["widthM"].Num(0),
                    Surface = Surface(r["surface"].Str("asphalt")),
                    Lit = r["lit"].Bool(false),
                    Lat = r["lat"].Num(0),
                    Lon = r["lon"].Num(0),
                    Thresholds = r["thresholds"].Kind == JsonKind.Array ? r["thresholds"].NumberRows() : Array.Empty<double[]>(),
                    RefDerived = r["refDerived"].Kind == JsonKind.Bool ? r["refDerived"].AsBool : (bool?)null,
                });
            }
            foreach (JsonValue t in Rows(a["taxiways"]))
            {
                airfield.Taxiways.Add(new AirfieldTaxiway { WidthM = t["widthM"].Num(0), Points = t["points"].NumberRows() });
            }
            foreach (JsonValue p in Rows(a["aprons"]))
            {
                airfield.Aprons.Add(new AirfieldApron { Ring = p["ring"].NumberRows() });
            }
            foreach (JsonValue b in Rows(a["buildings"]))
            {
                airfield.Buildings.Add(new AirfieldBuilding
                {
                    Kind = b["kind"].Str("hangar") switch
                    {
                        "terminal" => AirfieldBuildingKind.Terminal,
                        "tower" => AirfieldBuildingKind.Tower,
                        _ => AirfieldBuildingKind.Hangar,
                    },
                    Lat = b["lat"].Num(0),
                    Lon = b["lon"].Num(0),
                    HeadingDeg = b["headingDeg"].Num(0),
                    WidthM = b["widthM"].Num(0),
                    DepthM = b["depthM"].Num(0),
                    HeightM = b["heightM"].OptNum,
                });
            }
            foreach (JsonValue p in Rows(a["pads"]))
            {
                airfield.Pads.Add(new FlattenPadRecord
                {
                    Lat = p["lat"].Num(0),
                    Lon = p["lon"].Num(0),
                    HalfW = p["halfW"].Num(0),
                    HalfD = p["halfD"].Num(0),
                    FeatherM = p["featherM"].Num(0),
                    HeightMsl = p["heightMsl"].Num(0),
                    HeadingDeg = p["headingDeg"].OptNum,
                    Gradient = p["gradient"].OptNum,
                    GradientHeadingDeg = p["gradientHeadingDeg"].OptNum,
                    Icao = p["icao"].Kind == JsonKind.String ? p["icao"].AsString : null,
                });
            }
            return airfield;
        }

        private static IReadOnlyList<JsonValue> Rows(JsonValue v) =>
            v.Kind == JsonKind.Array ? v.Items : Array.Empty<JsonValue>();

        public static RunwaySurface Surface(string s)
        {
            switch (s)
            {
                case "concrete": return RunwaySurface.Concrete;
                case "grass": return RunwaySurface.Grass;
                case "gravel": return RunwaySurface.Gravel;
                default: return RunwaySurface.Asphalt;
            }
        }

        /// <summary>Airfields with runways whose reference point lies within `radiusM` of the frame origin.</summary>
        public static List<Airfield> Near(IEnumerable<Airfield> airfields, EnuBasis basis, double radiusM)
        {
            var output = new List<Airfield>();
            foreach (Airfield a in airfields)
            {
                Enu e = Geodesy.EcefToEnu(basis, Geodesy.GeodeticToEcef(a.Lat, a.Lon, 0));
                if (JsMath.Hypot(e.E, e.N) <= radiusM && a.Runways.Count > 0) output.Add(a);
            }
            return output;
        }
    }
}

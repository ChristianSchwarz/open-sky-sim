using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Terrain;

namespace Retro.Game
{
    // Port of src/script/terrain/airfields.ts: the airfields the bake found, as
    // the runtime reads them. A file of its own beside the terrain manifest
    // (written by tools/bake_planet_mesh.ts), fetched once the play area is known.
    //
    // loadAirfields (fetch + JSON) is not ported: the Unity layer reads the file
    // and fills these records; a missing or malformed file maps to
    // Airfields.Empty, which is not an error (a pyramid baked before airfields
    // existed simply has none).

    public enum RunwaySurface
    {
        Asphalt,
        Concrete,
        Grass,
        Gravel,
    }

    public sealed class AirfieldRunway
    {
        /// <summary>Painted designators, low end first: `03L/21R`.</summary>
        public string Ref = "";
        /// <summary>True bearing of the low designator's landing direction.</summary>
        public double HeadingDeg;
        public double LengthM;
        public double WidthM;
        public RunwaySurface Surface;
        public bool Lit;
        /// <summary>Threshold-to-threshold midpoint.</summary>
        public double Lat;
        public double Lon;
        /// <summary>`[lat, lon]` of each threshold, low designator first.</summary>
        public double[][] Thresholds = Array.Empty<double[]>();
        /// <summary>True when OSM had no `ref` and the designators were derived.</summary>
        public bool? RefDerived;

        public AirfieldRunway Clone()
        {
            var r = (AirfieldRunway)MemberwiseClone();
            return r;
        }
    }

    public sealed class AirfieldTaxiway
    {
        public double WidthM;
        /// <summary>`[lat, lon]` along the centreline.</summary>
        public double[][] Points = Array.Empty<double[]>();
    }

    public sealed class AirfieldApron
    {
        /// <summary>`[lat, lon]` ring, closed.</summary>
        public double[][] Ring = Array.Empty<double[]>();
    }

    public enum AirfieldBuildingKind
    {
        Terminal,
        Hangar,
        Tower,
    }

    public sealed class AirfieldBuilding
    {
        public AirfieldBuildingKind Kind;
        public double Lat;
        public double Lon;
        /// <summary>Bearing of the footprint's long axis.</summary>
        public double HeadingDeg;
        /// <summary>Across the long axis.</summary>
        public double WidthM;
        /// <summary>Along it.</summary>
        public double DepthM;
        /// <summary>
        /// Height from OSM's `height` or `building:levels`; null where it has
        /// neither (almost always) and the renderer infers one.
        /// </summary>
        public double? HeightM;
    }

    /// <summary>The single plane every part of one airfield is cut to.</summary>
    public sealed class AirfieldPlane
    {
        public double HeightMsl;
        /// <summary>Rise per metre along `HeadingDeg`.</summary>
        public double Gradient;
        public double HeadingDeg;
    }

    public sealed class Airfield
    {
        public string Name = "";
        public string Icao = "";
        public string Iata = "";
        public string Kind = "";
        /// <summary>Name of the baked area this one sits in.</summary>
        public string Area = "";
        /// <summary>Aerodrome reference point.</summary>
        public double Lat;
        public double Lon;
        public double ElevationM;
        public AirfieldPlane Plane = new AirfieldPlane();
        public List<AirfieldRunway> Runways = new List<AirfieldRunway>();
        public List<AirfieldTaxiway> Taxiways = new List<AirfieldTaxiway>();
        public List<AirfieldApron> Aprons = new List<AirfieldApron>();
        public List<AirfieldBuilding> Buildings = new List<AirfieldBuilding>();
        public List<FlattenPadRecord> Pads = new List<FlattenPadRecord>();
    }

    public sealed class AirfieldsFile
    {
        public string Source = "none";
        public LonLatBounds Coverage;
        public List<Airfield> Items = new List<Airfield>();
    }

    public static class Airfields
    {
        /// <summary>EMPTY_AIRFIELDS. A fresh instance each time, so callers cannot share-mutate it.</summary>
        public static AirfieldsFile Empty => new AirfieldsFile
        {
            Source = "none",
            Coverage = new LonLatBounds(0, 0, 0, 0),
            Items = new List<Airfield>(),
        };

        /// <summary>The airfields belonging to one baked area, best first.</summary>
        public static List<Airfield> AirfieldsInArea(AirfieldsFile file, string areaName)
        {
            return file.Items.FindAll(a => a.Area == areaName);
        }

        /// <summary>
        /// Elevation of the airfield's platform plane, `distanceM` along
        /// `bearingDeg` from the primary runway's centre. The plane rises along
        /// its own bearing, so a crossing runway climbs only by the component
        /// along it.
        /// </summary>
        public static double PlaneElevationAt(Airfield airfield, double bearingDeg, double distanceM)
        {
            double angle = (bearingDeg - airfield.Plane.HeadingDeg) * Math.PI / 180;
            return airfield.Plane.HeightMsl
                + airfield.Plane.Gradient * distanceM * Math.Cos(angle);
        }

        /// <summary>Longest runway of an airfield, which is the one worth flying to.</summary>
        public static AirfieldRunway PrimaryRunway(Airfield airfield)
        {
            AirfieldRunway best = null;
            foreach (AirfieldRunway r in airfield.Runways)
            {
                if (best == null || r.LengthM > best.LengthM)
                {
                    best = r;
                }
            }
            return best;
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using Retro.Core;
using Retro.Game;
using UnityEngine;

namespace Retro.Unity
{
    /// <summary>
    /// Reads assets/terrain/airfields.json into the ported <see cref="Airfield"/>
    /// records (airfields.ts loadAirfields; the parse is the part com.retro.game
    /// leaves to the frontend). A missing or malformed file is no airfields.
    /// </summary>
    public static class AirfieldsReader
    {
        [Serializable]
        private sealed class FileJson
        {
            public string source;
            public AirfieldJson[] items;
        }

        [Serializable]
        private sealed class AirfieldJson
        {
            public string name;
            public string icao;
            public string iata;
            public string kind;
            public string area;
            public double lat;
            public double lon;
            public double elevationM;
            public PlaneJson plane;
            public RunwayJson[] runways;
        }

        [Serializable]
        private sealed class PlaneJson
        {
            public double heightMsl;
            public double gradient;
            public double headingDeg;
        }

        [Serializable]
        private sealed class RunwayJson
        {
            public string @ref;
            public double headingDeg;
            public double lengthM;
            public double widthM;
            public string surface;
            public bool lit;
            public double lat;
            public double lon;
        }

        public static List<Airfield> Read(string path)
        {
            var output = new List<Airfield>();
            if (!File.Exists(path)) return output;
            FileJson file;
            try
            {
                file = JsonUtility.FromJson<FileJson>(File.ReadAllText(path));
            }
            catch (Exception e)
            {
                Debug.LogWarning($"Retro airfields: {path} unreadable ({e.Message}); none loaded");
                return output;
            }
            if (file?.items == null) return output;
            foreach (AirfieldJson a in file.items)
            {
                var airfield = new Airfield
                {
                    Name = a.name ?? "",
                    Icao = a.icao ?? "",
                    Iata = a.iata ?? "",
                    Kind = a.kind ?? "",
                    Area = a.area ?? "",
                    Lat = a.lat,
                    Lon = a.lon,
                    ElevationM = a.elevationM,
                    Plane = a.plane == null
                        ? new AirfieldPlane { HeightMsl = a.elevationM }
                        : new AirfieldPlane { HeightMsl = a.plane.heightMsl, Gradient = a.plane.gradient, HeadingDeg = a.plane.headingDeg },
                };
                foreach (RunwayJson r in a.runways ?? Array.Empty<RunwayJson>())
                {
                    airfield.Runways.Add(new AirfieldRunway
                    {
                        Ref = r.@ref ?? "",
                        HeadingDeg = r.headingDeg,
                        LengthM = r.lengthM,
                        WidthM = r.widthM,
                        Surface = Surface(r.surface),
                        Lit = r.lit,
                        Lat = r.lat,
                        Lon = r.lon,
                    });
                }
                output.Add(airfield);
            }
            return output;
        }

        private static RunwaySurface Surface(string s)
        {
            switch (s)
            {
                case "concrete": return RunwaySurface.Concrete;
                case "grass": return RunwaySurface.Grass;
                case "gravel": return RunwaySurface.Gravel;
                default: return RunwaySurface.Asphalt;
            }
        }

        /// <summary>Airfields whose centre lies within `radiusM` of the frame origin (the play area here).</summary>
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

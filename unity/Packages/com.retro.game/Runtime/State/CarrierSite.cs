using System;
using System.Collections.Generic;

namespace Retro.Game
{
    // Port of src/script/state/carrierSite.ts: where to put the carrier in an
    // area that is not Gran Canaria. Open water if the search can find any,
    // otherwise the flattest ground it can - a ship moored on a plain. Pure
    // geometry over injected samplers.

    /// <summary>The terrain queries the berth search needs, scene metres.</summary>
    public sealed class CarrierSiteSamplers
    {
        /// <summary>Scene Y of the surface at a scene point (sea level over water).</summary>
        public Func<double, double, double> GroundAt;
        /// <summary>True where the DEM says ground rather than sea.</summary>
        public Func<double, double, bool> IsLand;
        /// <summary>False outside the area's data, or on something already built there.</summary>
        public Func<double, double, bool> Usable;
    }

    public sealed class CarrierSite
    {
        /// <summary>Carrier origin on the scene's horizontal plane.</summary>
        public double X;
        public double Z;
        /// <summary>Surface height the hull sits on: the sea, or the highest ground under it.</summary>
        public double SurfaceY;
        /// <summary>Open water: the ship may steam. Otherwise it is moored.</summary>
        public bool AtSea;
    }

    public static class CarrierSites
    {
        /// <summary>The hull's extent in carrier-local metres (assets/kuz.glb).</summary>
        private const double HullMinX = -34.33, HullMaxX = 43.83, HullMinZ = -177.88, HullMaxZ = 124.28;
        /// <summary>The deck's lateral centreline, which is where an aircraft is lined up.</summary>
        private const double DeckMidX = (HullMinX + HullMaxX) * 0.5;

        /// <summary>How far beyond the bow the takeoff roll and climb-out are kept clear (m).</summary>
        private const double BowClearM = 1500;
        /// <summary>How far ahead of the bow open water is required before a berth counts as sea.</summary>
        private const double SeaRunM = 9000;
        /// <summary>How far astern the final approach is kept clear (m).</summary>
        private const double SternClearM = 3500;
        /// <summary>Corridor sample spacing (m).</summary>
        private const double CorridorStepM = 250;
        /// <summary>Land under the bow may rise this far above the deck before it counts against a site (m).</summary>
        private const double BowSlackM = 10;
        /// <summary>The approach is a ~3 degree slope; terrain is allowed to climb at 2 degrees under it.</summary>
        private const double SternRisePerM = 0.035;
        /// <summary>Footprint samples across and along the hull.</summary>
        private const int FootNx = 5;
        private const int FootNz = 9;

        /// <summary>Search rings, nearest first. Water is looked for further out than flat land.</summary>
        private const double WaterMaxRadiusM = 40000;
        private const double LandMaxRadiusM = 14000;
        private const double RingStepM = 1000;
        private const int Bearings = 24;

        private static readonly (double X, double Z)[] Footprint = MakeFootprint();
        private static readonly List<double> BowSamples = new List<double>();
        private static readonly List<double> SeaRunSamples = new List<double>();
        private static readonly List<double> SternSamples = new List<double>();

        static CarrierSites()
        {
            for (double d = CorridorStepM; d <= BowClearM; d += CorridorStepM)
            {
                BowSamples.Add(HullMinZ - d);
            }
            for (double d = 500; d <= SeaRunM; d += 500)
            {
                SeaRunSamples.Add(HullMinZ - d);
            }
            for (double d = CorridorStepM; d <= SternClearM; d += CorridorStepM)
            {
                SternSamples.Add(HullMaxZ + d);
            }
        }

        /// <summary>Footprint sample points, carrier-local.</summary>
        private static (double X, double Z)[] MakeFootprint()
        {
            var output = new List<(double X, double Z)>();
            for (int i = 0; i < FootNx; i++)
            {
                for (int j = 0; j < FootNz; j++)
                {
                    output.Add((
                        HullMinX + (HullMaxX - HullMinX) * i / (FootNx - 1),
                        HullMinZ + (HullMaxZ - HullMinZ) * j / (FootNz - 1)));
                }
            }
            return output.ToArray();
        }

        /// <summary>True when everything the ship and its approach cross is sea.</summary>
        private static bool IsOpenWater(double x, double z, CarrierSiteSamplers s)
        {
            foreach (var p in Footprint)
            {
                if (!s.Usable(x + p.X, z + p.Z) || s.IsLand(x + p.X, z + p.Z))
                {
                    return false;
                }
            }
            double[] across = { HullMinX - 40, DeckMidX, HullMaxX + 40 };
            foreach (double lz in SeaRunSamples)
            {
                // Bow wide as well as the centreline: a headland off to one side clips the hull.
                foreach (double dx in across)
                {
                    if (s.IsLand(x + dx, z + lz))
                    {
                        return false;
                    }
                }
            }
            // Only the first kilometre astern has to be water; further out the
            // approach is high enough that a coast under it is no obstacle.
            foreach (double lz in SternSamples)
            {
                if (lz - HullMaxZ > 1000)
                {
                    break;
                }
                if (s.IsLand(x + DeckMidX, z + lz))
                {
                    return false;
                }
            }
            return true;
        }

        /// <summary>
        /// Cost of mooring on land here, or Infinity if the footprint is unusable.
        /// Relief under the hull dominates; terrain across the bow and up the
        /// approach counts by how far it pokes above the line an aircraft flies.
        /// </summary>
        private static (double Cost, double SurfaceY) LandCost(double x, double z, CarrierSiteSamplers s)
        {
            double lo = double.PositiveInfinity;
            double hi = double.NegativeInfinity;
            foreach (var p in Footprint)
            {
                if (!s.Usable(x + p.X, z + p.Z))
                {
                    return (double.PositiveInfinity, 0);
                }
                double h = s.GroundAt(x + p.X, z + p.Z);
                lo = Math.Min(lo, h);
                hi = Math.Max(hi, h);
            }
            double cost = (hi - lo) * 4;
            foreach (double lz in BowSamples)
            {
                double h = s.GroundAt(x + DeckMidX, z + lz);
                cost += Math.Max(0, h - (hi + BowSlackM));
            }
            foreach (double lz in SternSamples)
            {
                double h = s.GroundAt(x + DeckMidX, z + lz);
                double allowed = hi + 10 + (lz - HullMaxZ) * SternRisePerM;
                cost += Math.Max(0, h - allowed);
            }
            return (cost, hi);
        }

        /// <summary>
        /// The carrier's berth near `centre` (scene metres): the nearest open
        /// water within 40 km, else the best moored position within 14 km, else
        /// the least-bad one. `minRadiusM` keeps it off the airbase itself.
        /// </summary>
        public static CarrierSite ChooseCarrierSite(double centreX, double centreZ, double minRadiusM, CarrierSiteSamplers s)
        {
            (double X, double Z) At(double r, double k, double phase)
            {
                double a = ((k + phase) / Bearings) * Math.PI * 2;
                return (centreX + Math.Cos(a) * r, centreZ + Math.Sin(a) * r);
            }

            // Water: nearest ring first; on a ring start at the bearing that faces
            // east (the original berth) and step round.
            double start = Math.Max(minRadiusM, RingStepM);
            for (double r = start; r <= WaterMaxRadiusM; r += RingStepM)
            {
                for (int k = 0; k < Bearings; k++)
                {
                    var p = At(r, k, 0);
                    if (IsOpenWater(p.X, p.Z, s))
                    {
                        // GroundAt over water is the sea surface itself.
                        double y = double.NegativeInfinity;
                        foreach (var f in Footprint)
                        {
                            y = Math.Max(y, s.GroundAt(p.X + f.X, p.Z + f.Z));
                        }
                        return new CarrierSite { X = p.X, Z = p.Z, SurfaceY = y, AtSea = true };
                    }
                }
            }

            bool haveBest = false;
            double bestX = 0, bestZ = 0, bestSurfaceY = 0, bestCost = 0;
            for (double r = start; r <= LandMaxRadiusM; r += RingStepM / 2)
            {
                for (int k = 0; k < Bearings; k++)
                {
                    var p = At(r, k, 0.5);
                    var c = LandCost(p.X, p.Z, s);
                    // A hair of preference for nearer, so ties stay beside the airbase.
                    double cost = c.Cost + r / 2000;
                    if (!haveBest || cost < bestCost)
                    {
                        haveBest = true;
                        bestX = p.X;
                        bestZ = p.Z;
                        bestSurfaceY = c.SurfaceY;
                        bestCost = cost;
                    }
                }
            }
            if (haveBest && JsText.IsFinite(bestCost))
            {
                return new CarrierSite { X = bestX, Z = bestZ, SurfaceY = bestSurfaceY, AtSea = false };
            }
            // Nothing usable anywhere: park it beside the runway and let it sit.
            var q = At(start, 0, 0);
            return new CarrierSite { X = q.X, Z = q.Z, SurfaceY = s.GroundAt(q.X, q.Z), AtSea = false };
        }

        /// <summary>Highest surface under the hull at a berth: what the ship is seated on once the DEM there is fine.</summary>
        public static double CarrierSurfaceY(double x, double z, Func<double, double, double> groundAt)
        {
            double y = double.NegativeInfinity;
            foreach (var f in Footprint)
            {
                y = Math.Max(y, groundAt(x + f.X, z + f.Z));
            }
            return y;
        }
    }
}

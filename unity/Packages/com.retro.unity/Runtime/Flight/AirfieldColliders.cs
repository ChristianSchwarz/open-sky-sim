using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using UnityEngine;
using SimPad = Retro.Sim.SurfacePadCollider;

namespace Retro.Unity
{
    /// <summary>
    /// The airfields' buildings made solid (game.ts buildAirfieldsNear,
    /// addBuildingColliders, streamAirfields): every building of a field
    /// within 50 km becomes a roof pad and an AI cylinder, nearest field first,
    /// once and for good. At boot the fields around the start are built
    /// straight away; in flight one field at a time, after the fine ground
    /// under it has loaded (the web awaits ensureLoadedAroundWorld), so the
    /// frame never waits for it.
    /// </summary>
    public sealed class AirfieldColliders
    {
        // game.ts AIRFIELD_GROUND_RADIUS_M and AIRFIELD_STREAM_INTERVAL_MS.
        private const double GroundRadiusM = 4000;
        private const float StreamIntervalS = 1;
        /// <summary>How long a field waits for its fine ground before it is built on what is there.</summary>
        private const float GroundWaitS = 10;

        private readonly List<(Airfield Airfield, Vec3d At)> airfields = new List<(Airfield, Vec3d)>();
        private readonly HashSet<Airfield> built = new HashSet<Airfield>();
        private readonly EnuBasis basis;
        private readonly DemHeightField heightField;
        private (Airfield Airfield, Vec3d At, float Since)? pending;
        private float lastScan = float.NegativeInfinity;

        /// <summary>A building's pad and its cylinder, for the sim and the AI.</summary>
        public struct Built
        {
            public List<SimPad> Pads;
            public List<BuildingObstacle> Obstacles;
            public string Airfield;
            public Airfield Source;
            public int Skipped;
        }

        public AirfieldColliders(IEnumerable<Airfield> area, IReadOnlyList<SceneRunway> runways, EnuBasis basis, DemHeightField heightField)
        {
            this.basis = basis;
            this.heightField = heightField;
            foreach (Airfield a in area)
            {
                // buildAirfield: around the primary runway when there is one.
                Vec3d at = Geodesy.GeodeticToWorld(basis, a.Lat, a.Lon, 0);
                foreach (SceneRunway r in runways)
                {
                    if (r.Primary && r.Icao == a.Icao && r.Name == a.Name) at = r.Center;
                }
                airfields.Add((a, at));
            }
        }

        /// <summary>The fields within reach of a point not yet built, nearest first.</summary>
        private List<(Airfield, Vec3d)> Due(double x, double z)
        {
            double r2 = AirbaseLayout.AirfieldStreamRadiusM * AirbaseLayout.AirfieldStreamRadiusM;
            var due = new List<(Airfield, Vec3d)>();
            foreach (var (a, at) in airfields)
            {
                if (built.Contains(a)) continue;
                double dx = at.X - x, dz = at.Z - z;
                if (dx * dx + dz * dz <= r2) due.Add((a, at));
            }
            due.Sort((p, q) =>
            {
                double dp = (p.Item2.X - x) * (p.Item2.X - x) + (p.Item2.Z - z) * (p.Item2.Z - z);
                double dq = (q.Item2.X - x) * (q.Item2.X - x) + (q.Item2.Z - z) * (q.Item2.Z - z);
                return dp.CompareTo(dq);
            });
            return due;
        }

        /// <summary>Boot: every field near the start, built now (the flight has not begun).</summary>
        public List<Built> BuildNear(double x, double z)
        {
            var all = new List<Built>();
            foreach (var (a, at) in Due(x, z))
            {
                if (a.Buildings.Count > 0)
                {
                    heightField.Focus(new[] { at });
                    heightField.WaitIdle(TimeSpan.FromSeconds(5));
                }
                all.Add(Build(a, null));
            }
            return all;
        }

        /// <summary>
        /// In flight, at most once a second: start on the nearest field due, and build it once
        /// its ground has loaded. <paramref name="under"/> says whether an aircraft is inside a
        /// roof that would appear (aircraftUnder); that building is left hollow.
        /// </summary>
        public Built? Stream(Vec3d aircraft, Func<SimPad, bool> under)
        {
            float now = Time.realtimeSinceStartup;
            if (pending.HasValue)
            {
                var (a, at, since) = pending.Value;
                if (heightField.TierAtWorld(at.X, at.Z) != Retro.Terrain.HeightTier.Fine && now - since < GroundWaitS) return null;
                heightField.ReleaseFocus(this);
                pending = null;
                return Build(a, under);
            }
            if (now - lastScan < StreamIntervalS) return null;
            lastScan = now;
            List<(Airfield, Vec3d)> due = Due(aircraft.X, aircraft.Z);
            if (due.Count == 0) return null;
            var (next, nextAt) = due[0];
            // Nothing to stand on the ground: built straight away.
            if (next.Buildings.Count == 0) return Build(next, under);
            built.Add(next);
            pending = (next, nextAt, now);
            heightField.HoldFocus(this, nextAt, GroundRadiusM);
            return null;
        }

        private Built Build(Airfield a, Func<SimPad, bool> under)
        {
            built.Add(a);
            var result = new Built
            {
                Pads = new List<SimPad>(), Obstacles = new List<BuildingObstacle>(),
                Airfield = string.IsNullOrEmpty(a.Icao) ? a.Name : a.Icao, Source = a,
            };
            foreach (AirfieldBuilding b in a.Buildings)
            {
                var c = AirbaseLayout.BuildingCollider(b, basis, heightField.HeightAtWorld);
                if (!c.HasValue) continue;
                // A roof appearing round an aircraft below it would put it underground.
                if (under != null && under(c.Value.Pad))
                {
                    result.Skipped++;
                    continue;
                }
                result.Pads.Add(c.Value.Pad);
                result.Obstacles.Add(c.Value.Obstacle);
            }
            if (result.Skipped > 0)
            {
                Debug.LogWarning($"airfield {result.Airfield}: {result.Skipped} building(s) left without a collider, an aircraft is inside");
            }
            return result;
        }

        public void Release() => heightField.ReleaseFocus(this);
    }
}

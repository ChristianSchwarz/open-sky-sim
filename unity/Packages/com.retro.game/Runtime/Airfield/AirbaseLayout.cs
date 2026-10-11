using System;
using System.Collections.Generic;
using Retro.Core;
using SimPad = Retro.Sim.SurfacePadCollider;

namespace Retro.Game
{
    /// <summary>A runway-local frame: where the base is and which way it faces (game.ts frameOf).</summary>
    public struct BaseFrame
    {
        public double CenterX, CenterZ, Heading, HalfLength, HalfWidth, Slope;
    }

    /// <summary>A placed piece of scenery: scene position (y = its base) and heading about +Y.</summary>
    public struct ScenerySlot
    {
        public double X, Y, Z, Heading;
    }

    /// <summary>A building's AI obstacle cylinder before its base is stood on the ground.</summary>
    public struct BuildingObstacle
    {
        public double X, Z, Radius, Height;
    }

    /// <summary>
    /// The authored airbase furniture and the Canaries scenario scenery, as
    /// game.ts places it (worldLayout.ts AIRBASE_LOCAL / TARGET_LOCAL,
    /// staticModelViews.ts, Game.airbaseAt, frameOf, groundHeightMaxUnder,
    /// buildingCollider): offsets authored against a runway pointing due
    /// north, turned with whatever runway the area's base is.
    /// </summary>
    public static class AirbaseLayout
    {
        // worldLayout.ts AIRBASE_LOCAL: x right of the runway, z along it.
        public static readonly (double X, double Z) HangarGround1 = (-140, -60);
        public static readonly (double X, double Z) HangarGround2 = (140, -60);
        public static readonly (double X, double Z) Hangar1 = (-170, 0);
        public static readonly (double X, double Z) Hangar2 = (-170, -60);
        public static readonly (double X, double Z) Hangar3 = (-170, -120);
        public static readonly (double X, double Z) Hangar4 = (170, -10);
        public static readonly (double X, double Z) Tower = (80, 300);
        public const double RampX = 80;
        public static readonly double[] RampZ = { -40, -70, -100, -130 };

        // worldLayout.ts TARGET_LOCAL.
        public static readonly (double X, double Z) Sam = (-1000, 400);
        public static readonly (double X, double Z) Refinery = (-2700, 2300);
        public static readonly (double X, double Z) Warehouse = (-5000, 2000);

        /// <summary>worldLayout.ts PLAY_ORIGIN: the authored scenery's area is the one holding it.</summary>
        public const double PlayOriginLat = 28.0015, PlayOriginLon = -15.3937;

        /// <summary>worldLayout.ts SCENERY_SURFACE_EPS_M: thin pavement lifted over its pad.</summary>
        public const double ScenerySurfaceEpsM = 1.5;
        /// <summary>game.ts HANGAR_GROUND_HALF_M: lib:pavement's unit square at scale 200.</summary>
        public const double HangarGroundHalfM = 100;
        /// <summary>game.ts SURFACE_PAD_FEATHER_M.</summary>
        public const double SurfacePadFeatherM = 15;
        /// <summary>game.ts BUILDING_PAD_FEATHER_M: a wall is a step, not a ramp.</summary>
        public const double BuildingPadFeatherM = 0.5;
        /// <summary>game.ts BUILDING_STREAM_CLEARANCE_M.</summary>
        public const double BuildingStreamClearanceM = 50;
        /// <summary>game.ts AIRFIELD_STREAM_RADIUS_M.</summary>
        public const double AirfieldStreamRadiusM = 50000;
        // game.ts / defs.ts: the authored airbase when the bake found no runway.
        public const double RunwayHalfLengthM = 1500;
        public const double RunwayPavementHalfWidth = 40;
        public const double RunwayStripHalfWidth = 75;
        public const double PlayerStartingHeading = 0;
        /// <summary>game.ts: the ski jump stands this far past the runway spawn.</summary>
        public const double SkiJumpAheadM = 90;
        /// <summary>game.ts RUNWAY_SPAWN_INSET_M.</summary>
        public const double RunwaySpawnInsetM = 120;
        /// <summary>staticModelViews.ts RAMP_HEADING: parked nose-out, across the runway.</summary>
        public const double RampHeading = -Math.PI / 2;

        /// <summary>frameOf: the real runway, or the authored airbase at the ENU origin.</summary>
        public static BaseFrame FrameOf(SceneRunway r) => r == null
            ? new BaseFrame
            {
                CenterX = 0, CenterZ = 0, Heading = PlayerStartingHeading,
                HalfLength = RunwayHalfLengthM, HalfWidth = RunwayStripHalfWidth, Slope = 0,
            }
            : new BaseFrame
            {
                CenterX = r.Center.X, CenterZ = r.Center.Z, Heading = r.Heading,
                HalfLength = r.HalfLength, HalfWidth = r.HalfWidth, Slope = r.Slope,
            };

        /// <summary>Game.airbaseAt: a runway-local offset (dx right, dz along) in scene XZ.</summary>
        public static (double X, double Z) At(in BaseFrame f, double dx, double dz)
        {
            double cos = JsTrig.Cos(f.Heading);
            double sin = JsTrig.Sin(f.Heading);
            return (f.CenterX + dx * cos + dz * sin, f.CenterZ - dx * sin + dz * cos);
        }

        public static (double X, double Z) At(in BaseFrame f, (double X, double Z) local) => At(f, local.X, local.Z);

        /// <summary>buildStaticModelViews: the parked F-22s along the ramp, nose-out.</summary>
        public static List<(double X, double Z, double Heading)> RampSlots(in BaseFrame f)
        {
            var slots = new List<(double, double, double)>();
            foreach (double z in RampZ)
            {
                (double x, double sz) = At(f, RampX, z);
                slots.Add((x, sz, f.Heading + RampHeading));
            }
            return slots;
        }

        /// <summary>The ski jump's base, ninety metres past where an aircraft lines up on the base runway.</summary>
        public static (double X, double Z) SkiJumpOrigin(in BaseFrame f)
        {
            Vec3d fwd = ActiveAirfield.HeadingForward(f.Heading);
            double fromCentre = f.HalfLength - RunwaySpawnInsetM - SkiJumpAheadM;
            return (f.CenterX - fwd.X * fromCentre, f.CenterZ - fwd.Z * fromCentre);
        }

        /// <summary>
        /// groundHeightMaxUnder: the highest ground on a grid over a footprint (and its
        /// corners), so a wide building is not buried by relief.
        /// </summary>
        public static double GroundMaxUnder(Func<double, double, double> groundAt, double x, double z,
            double halfW, double halfD, double step = 20)
        {
            double sx = Math.Max(5, step), sz = Math.Max(5, step);
            double y = groundAt(x, z);
            for (double dz = -halfD; dz <= halfD; dz += sz)
            {
                for (double dx = -halfW; dx <= halfW; dx += sx)
                {
                    y = Math.Max(y, groundAt(x + dx, z + dz));
                }
            }
            y = Math.Max(y, Math.Max(Math.Max(groundAt(x - halfW, z - halfD), groundAt(x + halfW, z - halfD)),
                Math.Max(groundAt(x - halfW, z + halfD), groundAt(x + halfW, z + halfD))));
            return y;
        }

        /// <summary>
        /// buildingCollider: one airport building as solid ground on its roof (a pad, so flying
        /// into it below the roof puts the aircraft underground) and a cylinder for the AI to
        /// steer round. Null when the ground under it is unknown.
        /// </summary>
        public static (SimPad Pad, BuildingObstacle Obstacle)? BuildingCollider(
            AirfieldBuilding b, EnuBasis basis, Func<double, double, double> demAt)
        {
            const double perDegLat = 110540;
            double perDegLon = Math.Max(1, 111320 * JsTrig.Cos(b.Lat * Math.PI / 180));
            double r = b.HeadingDeg * Math.PI / 180;
            Vec3d At(double along, double across) => Geodesy.GeodeticToWorld(basis,
                b.Lat + (along * JsTrig.Cos(r) - across * JsTrig.Sin(r)) / perDegLat,
                b.Lon + (along * JsTrig.Sin(r) + across * JsTrig.Cos(r)) / perDegLon, 0);
            Vec3d centre = At(0, 0);
            double halfDepth = b.DepthM / 2, halfWidth = b.WidthM / 2;
            Vec3d[] corners = { At(-halfDepth, -halfWidth), At(-halfDepth, halfWidth), At(halfDepth, halfWidth), At(halfDepth, -halfWidth) };
            // The lowest corner, so a building on a slope is not floating (the drawn box's rule).
            double baseY = double.PositiveInfinity;
            foreach (Vec3d c in corners) baseY = Math.Min(baseY, demAt(c.X, c.Z));
            if (double.IsInfinity(baseY) || double.IsNaN(baseY)) return null;
            double height = AirfieldGeometryBuilder.BuildingHeightM(b);
            Vec3d ahead = At(halfDepth, 0);
            var pad = new SimPad
            {
                CenterX = centre.X, CenterZ = centre.Z,
                Heading = JsTrig.Atan2(ahead.X - centre.X, ahead.Z - centre.Z),
                HalfLength = halfDepth, HalfWidth = halfWidth,
                SurfaceY = baseY + height, BaseY = baseY,
                Feather = BuildingPadFeatherM,
            };
            return (pad, new BuildingObstacle
            {
                X = centre.X, Z = centre.Z, Radius = JsMath.Hypot(b.WidthM, b.DepthM) / 2, Height = height,
            });
        }

        /// <summary>The hangars' and the tower's AI cylinders (setupCombat): (local offset, radius, height).</summary>
        public static readonly ((double X, double Z) At, double Radius, double Height)[] AirbaseObstacles =
        {
            (Hangar1, 45, 22), (Hangar2, 45, 22), (Hangar3, 45, 22), (Hangar4, 45, 22), (Tower, 25, 45),
        };

        /// <summary>The Canaries scenario's AI cylinders, at home only: refinery, SAM site, warehouse.</summary>
        public static readonly ((double X, double Z) At, double Radius, double Height)[] TargetObstacles =
        {
            (Refinery, 70, 60), (Sam, 20, 25), (Warehouse, 45, 22),
        };
    }
}

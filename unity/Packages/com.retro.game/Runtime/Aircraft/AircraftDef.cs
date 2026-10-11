using System;
using System.Collections.Generic;
using System.Linq;
using Retro.Core;
using Retro.Sim;

namespace Retro.Game
{
    /// <summary>A hinge-pivoted control surface model (aircraftDef.ts ControlSurfaceConfig).</summary>
    public sealed class ControlSurfaceDef
    {
        public string Role = "";
        /// <summary>The surface's model file (a basename inside a pack, or an assets path).</summary>
        public string Model = "";
        /// <summary>Hinge pivot in the body frame (+X port, +Y up, +Z nose), m.</summary>
        public Vec3d Pivot;
        public Vec3d Axis;
        /// <summary>pitch, roll, yaw, flaps, slats, airbrake, sweep, flaperonLeft/Right, stabilatorLeft/Right.</summary>
        public string Control = "";
        public double Sign = 1;
        public double RangeRad;
        /// <summary>Role of the sweep surface this one rides on, or null.</summary>
        public string SweepParent;
    }

    /// <summary>When and how fast a variable-geometry wing sweeps (aircraftDef.ts SwingWingsConfig).</summary>
    public sealed class SwingWingsDef
    {
        public double MinKias;
        public double MaxKias;
        public double TravelSeconds;
    }

    /// <summary>A flyable aircraft (aircraftDef.ts FlyableAircraftDef).</summary>
    public sealed class FlyableAircraftDef
    {
        public string Id = "";
        public string Name = "";
        public string CanonicalName;
        public string ModelName;
        public string LiveryName;
        public string Body = "";
        public string Shadow = "";
        public string Gear;
        public bool GearAnimated;
        public string Collision;
        public AircraftCollisionMesh CollisionMesh;
        public Vec3d CockpitOffset = new Vec3d(0, 1.0, 6.0);
        public double[][] Wingtips;
        public double[][] Nozzles;
        public double? NozzleRadius;
        /// <summary>The pack's own FM2 config; null flies the default.</summary>
        public Fm2AircraftConfig Flight;
        public SwingWingsDef SwingWings;
        public List<ControlSurfaceDef> Surfaces = new List<ControlSurfaceDef>();
        /// <summary>The pack this def came from, or null for a built-in.</summary>
        public string PackId;
    }

    /// <summary>The built-in F-22 and pack manifests as flyable defs (port of aircraftRegistry.ts).</summary>
    public static class AircraftDefs
    {
        private const double HingeRange = Math.PI / 6;

        /// <summary>Legacy shipped packs kept out of the spawn menu (game.ts EXCLUDED_PACK_IDS).</summary>
        private static readonly HashSet<string> ExcludedPackIds = new HashSet<string> { "a4e", "f16" };

        public static bool IsExcludedPack(string id) => ExcludedPackIds.Contains(id);

        /// <summary>buildF22Def: the values that used to be hard-wired into PlayerEntity.</summary>
        public static FlyableAircraftDef F22() => new FlyableAircraftDef
        {
            Id = "f22",
            Name = "F-22",
            Body = "f22.glb",
            Shadow = "f22_shadow.glb",
            Gear = "f22_landinggear.glb",
            GearAnimated = true,
            CockpitOffset = new Vec3d(0, 1.0, 8.0),
            Flight = Fm2Defaults.Default(),
            Surfaces =
            {
                Surface("flaperonLeft", "f22_flaperon_left.glb", 4.5, -0.21, -3, 1.681781, -0.152682, 0.57654, "flaperonLeft"),
                Surface("flaperonRight", "f22_flaperon_right.glb", -4.5, -0.21, -3, -1.681781, -0.152682, 0.57654, "flaperonRight"),
                Surface("elevatorLeft", "f22_elevator_left.glb", 0, 0, -6, 1, 0, 0, "stabilatorLeft"),
                Surface("elevatorRight", "f22_elevator_right.glb", 0, 0, -6, 1, 0, 0, "stabilatorRight"),
                Surface("rudderLeft", "f22_rudder_left.glb", 2.34, 1.8, -4.05, 0.383502, 0.802989, 0.456217, "yaw"),
                Surface("rudderRight", "f22_rudder_right.glb", -2.34, 1.8, -4.05, -0.383502, 0.802989, 0.456217, "yaw"),
            },
        };

        private static ControlSurfaceDef Surface(string role, string model, double px, double py, double pz,
            double ax, double ay, double az, string control) => new ControlSurfaceDef
        {
            Role = role, Model = model, Pivot = new Vec3d(px, py, pz), Axis = new Vec3d(ax, ay, az),
            Control = control, Sign = 1, RangeRad = HingeRange,
        };

        /// <summary>A pack's file reference as the pack stores it: by basename (rewriteManifestForPack).</summary>
        public static string PackEntry(string path) =>
            path == null ? null : path.Replace('\\', '/').Split('/').Last();

        /// <summary>manifestToDef over a pack's manifest.json, file references reduced to pack basenames.</summary>
        public static FlyableAircraftDef FromPackManifest(string packId, JsonValue m)
        {
            string full = m["displayName"].Str(m["name"].Str(""));
            var def = new FlyableAircraftDef
            {
                Id = m["id"].Str(packId),
                Name = m["displayName"].Str(m["name"].Str(packId)),
                CanonicalName = m["canonicalName"].Str(null),
                ModelName = ModelDisplayName(m, full),
                LiveryName = LiveryDisplayName(m, full),
                Body = PackEntry(m["body"].Str("")),
                Shadow = PackEntry(m["shadow"].Str("")),
                Gear = PackEntry(m["gear"].Str(null)),
                GearAnimated = m["gearAnimated"].Bool(false),
                Collision = PackEntry(m["collision"].Str(null)),
                PackId = packId,
            };
            double[] cockpit = m["cockpitOffset"].Kind == JsonKind.Array ? m["cockpitOffset"].Numbers() : null;
            if (cockpit != null && cockpit.Length == 3) def.CockpitOffset = new Vec3d(cockpit[0], cockpit[1], cockpit[2]);
            JsonValue mesh = m["collisionMesh"];
            if (mesh.Kind == JsonKind.Object)
            {
                def.CollisionMesh = new AircraftCollisionMesh
                {
                    Triangles = mesh["triangles"].Numbers(),
                    Aabb = new ColliderAabb { Min = mesh["aabb"]["min"].Numbers(), Max = mesh["aabb"]["max"].Numbers() },
                };
            }
            JsonValue fx = m["fx"];
            if (fx.Kind == JsonKind.Object)
            {
                if (fx["wingtips"].Kind == JsonKind.Array) def.Wingtips = fx["wingtips"].NumberRows();
                if (fx["nozzles"].Kind == JsonKind.Array) def.Nozzles = fx["nozzles"].NumberRows();
                def.NozzleRadius = fx["nozzleRadius"].OptNum;
            }
            JsonValue sweep = m["swingWings"];
            if (sweep.Kind == JsonKind.Object)
            {
                def.SwingWings = new SwingWingsDef
                {
                    MinKias = sweep["minKias"].Num(0), MaxKias = sweep["maxKias"].Num(0), TravelSeconds = sweep["travelSeconds"].Num(1),
                };
            }
            if (m["flight"].Kind == JsonKind.Object)
            {
                // No shipped pack carries one; when one does it needs a config binder.
                throw new NotSupportedException($"pack {packId}: a pack's own flight config is not supported yet");
            }
            if (m["surfaces"].Kind == JsonKind.Array)
            {
                foreach (JsonValue s in m["surfaces"].Items)
                {
                    string role = s["role"].Str("");
                    string control = s["control"].Str("");
                    // Older packs mapped speedbrakes to the flaps axis; drive them from airbrake.
                    if (role.StartsWith("speedbrake", StringComparison.Ordinal) && control == "flaps") control = "airbrake";
                    double[] p = s["pivot"].Numbers(), a = s["axis"].Numbers();
                    def.Surfaces.Add(new ControlSurfaceDef
                    {
                        Role = role,
                        Model = PackEntry(s["path"].Str("")),
                        Pivot = new Vec3d(p[0], p[1], p[2]),
                        Axis = new Vec3d(a[0], a[1], a[2]),
                        Control = control,
                        Sign = s["sign"].Num(1),
                        RangeRad = s["rangeRad"].Num(0),
                        SweepParent = s["sweepParent"].Str(null),
                    });
                }
            }
            return def;
        }

        private static string ModelDisplayName(JsonValue m, string full)
        {
            int paren = full.LastIndexOf(" (", StringComparison.Ordinal);
            if (paren > 0) return full.Substring(0, paren);
            return m["canonicalName"].Str(full);
        }

        private static string LiveryDisplayName(JsonValue m, string full)
        {
            string material = m["sourceMaterial"].Str(null);
            if (!string.IsNullOrEmpty(material)) return material;
            int paren = full.LastIndexOf(" (", StringComparison.Ordinal);
            if (paren > 0 && full.EndsWith(")", StringComparison.Ordinal)) return full.Substring(paren + 2, full.Length - paren - 3);
            return null;
        }

        /// <summary>arrestorHookPlacementForAircraft: the hook tip at the nozzle exits, under the collision mesh's belly.</summary>
        public static double[] ArrestorHookTip(FlyableAircraftDef def)
        {
            double[][] nozzles = def.Nozzles != null && def.Nozzles.Length > 0 ? def.Nozzles : ArrestorCables.DefaultEngineNozzles;
            double tipY = def.CollisionMesh != null
                ? Math.Min(ArrestorCables.DefaultArrestorHookBody[1], def.CollisionMesh.Aabb.Min[1] + 0.35 + ArrestorCables.TailhookMountUpM)
                : ArrestorCables.DefaultArrestorHookBody[1];
            double aft = nozzles[0][2];
            for (int i = 1; i < nozzles.Length; i++) aft = Math.Min(aft, nozzles[i][2]);
            return ArrestorCables.ResolveArrestorHookTip(def.Flight?.Hook, new[] { aft }, tipY);
        }

        /// <summary>flightConfigWithArrestorHook: the def's FM2 config (default when none) with its hook tip.</summary>
        public static Fm2AircraftConfig FlightConfigWithArrestorHook(FlyableAircraftDef def) =>
            (def.Flight ?? Fm2Defaults.Default()).WithHook(ArrestorHookTip(def));
    }
}

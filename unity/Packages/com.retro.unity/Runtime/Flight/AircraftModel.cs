using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Retro.Core;
using UnityEngine;
#if RETRO_GLTFAST
using GLTFast;
#endif

namespace Retro.Unity
{
    /// <summary>A hinge-pivoted control surface (aircraftDef.ts ControlSurfaceConfig).</summary>
    public sealed class SurfaceDef
    {
        public string Role;
        public string Model;
        /// <summary>Hinge pivot in the body frame (three.js axes: +X port, +Y up, +Z nose), m.</summary>
        public Vec3d Pivot;
        public Vec3d Axis;
        public string Control;
        public double Sign;
        public double RangeRad;
    }

    /// <summary>The drawn parts of a flyable aircraft (aircraftRegistry.ts FlyableAircraftDef, visual half).</summary>
    public sealed class AircraftVisualDef
    {
        public string Body;
        public string Gear;
        public bool GearAnimated;
        public List<SurfaceDef> Surfaces = new List<SurfaceDef>();

        private const double HingeRange = Math.PI / 6;

        /// <summary>aircraftRegistry.ts buildF22Def.</summary>
        public static AircraftVisualDef F22() => new AircraftVisualDef
        {
            Body = "f22.glb",
            Gear = "f22_landinggear.glb",
            GearAnimated = true,
            Surfaces =
            {
                S("flaperonLeft", "f22_flaperon_left.glb", 4.5, -0.21, -3, 1.681781, -0.152682, 0.57654, "flaperonLeft"),
                S("flaperonRight", "f22_flaperon_right.glb", -4.5, -0.21, -3, -1.681781, -0.152682, 0.57654, "flaperonRight"),
                S("elevatorLeft", "f22_elevator_left.glb", 0, 0, -6, 1, 0, 0, "stabilatorLeft"),
                S("elevatorRight", "f22_elevator_right.glb", 0, 0, -6, 1, 0, 0, "stabilatorRight"),
                S("rudderLeft", "f22_rudder_left.glb", 2.34, 1.8, -4.05, 0.383502, 0.802989, 0.456217, "yaw"),
                S("rudderRight", "f22_rudder_right.glb", -2.34, 1.8, -4.05, -0.383502, 0.802989, 0.456217, "yaw"),
            },
        };

        private static SurfaceDef S(string role, string model, double px, double py, double pz,
            double ax, double ay, double az, string control) => new SurfaceDef
        {
            Role = role, Model = model, Pivot = new Vec3d(px, py, pz), Axis = new Vec3d(ax, ay, az),
            Control = control, Sign = 1, RangeRad = HingeRange,
        };
    }

    /// <summary>What drives the articulated parts this frame (player.ts surfaceValue inputs).</summary>
    public struct AircraftPoseInputs
    {
        public double CommandedElevator;
        public double CommandedAileron;
        public double CommandedRudder;
        /// <summary>The pilot's roll demand, blended in so a sustained roll stays visible.</summary>
        public double RollDemand;
        public double FlapsUnit;
        public double AirbrakesUnit;
        /// <summary>0 retracted .. 1 extended: the gear clip's playback position.</summary>
        public double GearUnit;
        /// <summary>Surfaces rest (crashed, showcase).</summary>
        public bool Still;
    }

    /// <summary>
    /// The aircraft's glTF parts loaded with glTFast and posed each frame from
    /// the sim, camera-relative. glTFast turns glTF's right-handed axes into
    /// Unity's by negating x; with the scene's z mirror on top, the two
    /// reflections make a half turn about +Y, so every part is placed with
    /// rotation ToUnity(q) * 180 deg about Y and no mirrored matrix.
    /// </summary>
    public sealed class AircraftModel
    {
        // player.ts
        private const double FlapsExtendedAngle = Math.PI / 5;
        private const double RollVisTaileron = 0.6;
        private const double RollVisAileron = 0.15;

        private static readonly Quaternion HalfTurnY = Quaternion.Euler(0, 180, 0);

        private readonly AircraftVisualDef def;
        private readonly Transform root;
        private Transform body;
        private Transform gear;
        private readonly List<Animation> gearAnimations = new List<Animation>();
        private readonly Transform[] surfaces;

        public bool Loaded { get; private set; }
        public string Error { get; private set; }

        public AircraftModel(AircraftVisualDef def, string assetsDir, string name = "Aircraft")
        {
            this.def = def;
            root = new GameObject(name).transform;
            surfaces = new Transform[def.Surfaces.Count];
            _ = LoadAll(assetsDir);
        }

        private async Task LoadAll(string dir)
        {
            try
            {
                body = await LoadPart(Path.Combine(dir, def.Body), "body");
                if (def.Gear != null)
                {
                    gear = await LoadPart(Path.Combine(dir, def.Gear), "gear");
                    if (gear != null) gearAnimations.AddRange(gear.GetComponentsInChildren<Animation>(true));
                }
                for (int i = 0; i < def.Surfaces.Count; i++)
                {
                    surfaces[i] = await LoadPart(Path.Combine(dir, def.Surfaces[i].Model), def.Surfaces[i].Role);
                }
                Loaded = body != null;
            }
            catch (Exception e)
            {
                Error = e.Message;
                Debug.LogException(e);
            }
        }

        private async Task<Transform> LoadPart(string path, string name)
        {
#if RETRO_GLTFAST
            var part = new GameObject(name).transform;
            part.SetParent(root, false);
            // Uninterrupted: a handful of small parts at boot, and the default agent is a
            // DontDestroyOnLoad object that errors when a load outlives play mode.
            var gltf = new GltfImport(deferAgent: new UninterruptedDeferAgent());
            if (!await gltf.LoadFile(path, new Uri(Path.GetFullPath(path))) || !await gltf.InstantiateMainSceneAsync(part))
            {
                Debug.LogError($"Retro aircraft: could not load {path}");
                UnityEngine.Object.Destroy(part.gameObject);
                return null;
            }
            return part;
#else
            await Task.CompletedTask;
            Error = "glTFast (com.unity.cloud.gltfast) is not installed";
            return null;
#endif
        }

        public void SetVisible(bool visible)
        {
            if (root.gameObject.activeSelf != visible) root.gameObject.SetActive(visible);
        }

        /// <summary>Place every part for this frame: aircraft pose in scene axes, camera position for the floating origin.</summary>
        public void Pose(Vec3d position, Quatd quaternion, Vec3d camera, in AircraftPoseInputs inputs)
        {
            if (!Loaded) return;
            Quaternion bodyRotation = SceneFrame.ToUnity(quaternion) * HalfTurnY;
            Vector3 bodyPosition = SceneFrame.ToUnity(position - camera);
            body.SetPositionAndRotation(bodyPosition, bodyRotation);
            if (gear != null)
            {
                bool show = def.GearAnimated || inputs.GearUnit > 0;
                gear.gameObject.SetActive(show);
                gear.SetPositionAndRotation(bodyPosition, bodyRotation);
                SampleGear(inputs.GearUnit);
            }
            for (int i = 0; i < surfaces.Length; i++)
            {
                if (surfaces[i] == null) continue;
                SurfaceDef s = def.Surfaces[i];
                double deflection = inputs.Still ? 0 : SurfaceValue(s, inputs) * s.RangeRad;
                // wingSweep.ts poseSurface (no sweep parents on the F-22).
                Quatd hinge = Quatd.FromAxisAngle(s.Axis.Normalized(), deflection);
                Quatd q = quaternion * hinge;
                Vec3d p = s.Pivot.Rotate(quaternion) + position;
                surfaces[i].SetPositionAndRotation(SceneFrame.ToUnity(p - camera), SceneFrame.ToUnity(q) * HalfTurnY);
            }
        }

        /// <summary>The gear clips held at a playback position (LODHelper.setPlaybackPosition).</summary>
        private void SampleGear(double unit)
        {
            foreach (Animation anim in gearAnimations)
            {
                foreach (AnimationState state in anim)
                {
                    state.enabled = true;
                    state.weight = 1;
                    state.speed = 0;
                    // glTFast clips loop; a looping clip sampled at its length lands back on frame 0.
                    state.wrapMode = WrapMode.ClampForever;
                    state.time = (float)(Math.Max(0, Math.Min(1, unit)) * state.length);
                }
                anim.Sample();
            }
        }

        /// <summary>player.ts surfaceValue.</summary>
        private static double SurfaceValue(SurfaceDef s, in AircraftPoseInputs i)
        {
            double roll = Math.Abs(i.RollDemand) > Math.Abs(i.CommandedAileron) ? i.RollDemand : i.CommandedAileron;
            double pitch = i.CommandedElevator;
            switch (s.Control)
            {
                case "pitch": return s.Sign * pitch;
                case "roll": return s.Sign * roll;
                case "yaw": return s.Sign * i.CommandedRudder;
                case "flaps": return s.Sign * i.FlapsUnit;
                case "airbrake": return s.Sign * i.AirbrakesUnit;
                case "flaperonLeft":
                    return i.FlapsUnit * -FlapsExtendedAngle - (1.0 - i.FlapsUnit * 0.5) * RollVisAileron * roll;
                case "flaperonRight":
                    return i.FlapsUnit * FlapsExtendedAngle - (1.0 - i.FlapsUnit * 0.5) * RollVisAileron * roll;
                case "stabilatorLeft": return s.Sign * (pitch - RollVisTaileron * roll);
                case "stabilatorRight": return s.Sign * (pitch + RollVisTaileron * roll);
                default: return 0;
            }
        }

        public void Destroy()
        {
            if (root != null) UnityEngine.Object.Destroy(root.gameObject);
        }
    }
}

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Retro.Core;
using Retro.Game;
using UnityEngine;
#if RETRO_GLTFAST
using GLTFast;
#endif

namespace Retro.Unity
{
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
        /// <summary>0 spread .. 1 swept (wingSweep.ts).</summary>
        public double SweepUnit;
        public double AngleOfAttack;
        /// <summary>Surfaces rest (crashed, showcase).</summary>
        public bool Still;
    }

    /// <summary>
    /// An aircraft's glTF parts loaded with glTFast and posed each frame from
    /// the sim, camera-relative: body, gear (its retract clips held at the gear
    /// position), and the hinged surfaces, swing wings carrying theirs.
    ///
    /// Materials follow the models' contract (models.ts): a glTF material
    /// named for a PaletteCategory takes that palette colour, `#rrggbb` is a
    /// literal colour, GLASS the canopy tint, COLLISION is never drawn.
    ///
    /// glTFast turns glTF's right-handed axes into Unity's by negating x; with
    /// the scene's z mirror on top, the two reflections make a half turn about
    /// +Y, so every part is placed with rotation ToUnity(q) * 180 deg about Y.
    /// </summary>
    public sealed class AircraftModel
    {
        // player.ts
        private const double FlapsExtendedAngle = Math.PI / 5;
        private const double RollVisTaileron = 0.6;
        private const double RollVisAileron = 0.15;
        private const double SlatAoaOnsetRad = 10 * Math.PI / 180;
        private const double SlatAoaFullRad = 18 * Math.PI / 180;
        // models.ts
        private const string GlassColor = "#333333";

        private static readonly Quaternion HalfTurnY = Quaternion.Euler(0, 180, 0);
        private static readonly Regex RawColor = new Regex("^#[0-9a-fA-F]{6}$");
        private static readonly Dictionary<string, Material> RemappedMaterials = new Dictionary<string, Material>();

        private readonly FlyableAircraftDef def;
        private readonly IAircraftFiles files;
        private readonly Transform root;
        private Transform body;
        private Transform gear;
        private readonly List<Animation> gearAnimations = new List<Animation>();
        private readonly Transform[] surfaces;
        private readonly int[] parentIndex;
        private readonly double[] deflections;
        // The scene poses applied last frame, for a wreck to start from.
        private Vec3d posedPosition;
        private bool gearDown;
        private Quatd posedQuaternion = Quatd.Identity;
        private readonly Vec3d[] surfacePositions;
        private readonly Quatd[] surfaceQuaternions;

        public bool Loaded { get; private set; }
        public string Error { get; private set; }
        public FlyableAircraftDef Def => def;

        public AircraftModel(FlyableAircraftDef def, IAircraftFiles files, string name = "Aircraft")
        {
            this.def = def;
            this.files = files;
            root = new GameObject(name).transform;
            surfaces = new Transform[def.Surfaces.Count];
            parentIndex = new int[def.Surfaces.Count];
            deflections = new double[def.Surfaces.Count];
            surfacePositions = new Vec3d[def.Surfaces.Count];
            surfaceQuaternions = new Quatd[def.Surfaces.Count];
            for (int i = 0; i < def.Surfaces.Count; i++)
            {
                string parent = def.Surfaces[i].SweepParent;
                parentIndex[i] = parent == null ? -1 : def.Surfaces.FindIndex(o => o.Role == parent);
            }
            _ = LoadAll();
        }

        private async Task LoadAll()
        {
            try
            {
                body = await LoadPart(def.Body, "body");
                if (def.Gear != null && root != null)
                {
                    gear = await LoadPart(def.Gear, "gear");
                    if (gear != null) gearAnimations.AddRange(gear.GetComponentsInChildren<Animation>(true));
                }
                for (int i = 0; i < def.Surfaces.Count && root != null; i++)
                {
                    surfaces[i] = await LoadPart(def.Surfaces[i].Model, def.Surfaces[i].Role);
                }
                Loaded = body != null;
                if (!Loaded && Error == null) Error = $"{def.Id}: no body";
            }
            catch (Exception e)
            {
                Error = e.Message;
                Debug.LogException(e);
            }
        }

        private async Task<Transform> LoadPart(string file, string name)
        {
            Transform part = await LoadGltf(files, file, root, name);
            if (part == null)
            {
#if !RETRO_GLTFAST
                Error = "glTFast (com.unity.cloud.gltfast) is not installed";
#endif
                return null;
            }
            Remap(part);
            return part;
        }

        /// <summary>
        /// One glTF from a pack (or the assets folder), its nearest LOD scene instantiated
        /// under a new child of `parent`; null when it cannot be read or `parent` died first.
        /// </summary>
        /// <summary>A scenery model (a hangar, the tower, a parked F-22): loaded like a part, in the palette's colours.</summary>
        public static async Task<Transform> LoadScenery(IAircraftFiles files, string file, Transform parent, string name)
        {
            Transform part = await LoadGltf(files, file, parent, name);
            if (part != null) Remap(part);
            return part;
        }

        public static async Task<Transform> LoadGltf(IAircraftFiles files, string file, Transform parent, string name)
        {
#if RETRO_GLTFAST
            if (!files.TryRead(file, out byte[] data))
            {
                Debug.LogError($"Retro: {file} not in {files.Label}");
                return null;
            }
            var part = new GameObject(name).transform;
            part.SetParent(parent, false);
            // Uninterrupted: a handful of small parts, and the default agent is a
            // DontDestroyOnLoad object that errors when a load outlives play mode.
            var gltf = new GltfImport(new FilesDownloadProvider(files), new UninterruptedDeferAgent());
            var uri = new Uri("https://aircraft.invalid/" + Uri.EscapeDataString(file));
            bool ok = file.EndsWith(".glb", StringComparison.OrdinalIgnoreCase)
                ? await gltf.Load(data, uri)
                : await gltf.LoadGltfJson(System.Text.Encoding.UTF8.GetString(data), uri);
            // A load can outlive its owner (play mode stopped, model destroyed): then it must
            // not instantiate, or the parts land in the edit-mode scene with dead materials.
            if (parent == null || part == null || !Application.isPlaying)
            {
                if (part != null) UnityEngine.Object.Destroy(part.gameObject);
                gltf.Dispose();
                return null;
            }
            if (!ok || !await gltf.InstantiateSceneAsync(part, NearestScene(gltf)))
            {
                Debug.LogError($"Retro: could not load {file} from {files.Label}");
                UnityEngine.Object.Destroy(part.gameObject);
                return null;
            }
            return part;
#else
            await Task.CompletedTask;
            return null;
#endif
        }

#if RETRO_GLTFAST
        /// <summary>models.ts sortingFn: scenes ordered by the digit their name starts with; the first is LOD 0.</summary>
        private static int NearestScene(GltfImport gltf)
        {
            int best = 0, bestDigit = int.MaxValue;
            for (int i = 0; i < gltf.SceneCount; i++)
            {
                string n = gltf.GetSceneName(i) ?? "";
                int digit = n.Length > 0 && char.IsDigit(n[0]) ? n[0] - '0' : int.MaxValue - 1;
                if (digit < bestDigit)
                {
                    bestDigit = digit;
                    best = i;
                }
            }
            return best;
        }
#endif

        /// <summary>The glTF material names as the model contract reads them.</summary>
        /// <summary>
        /// The drawn body meshes' vertices in the scene body frame (+X left wing, +Y up,
        /// +Z forward), xyz triples, for wingtip origins (aircraftFx.ts bindWingtipOrigins).
        /// glTFast negated x on import, so it is negated back. Empty until the body loads.
        /// </summary>
        public float[] BodyPositions()
        {
            if (body == null) return Array.Empty<float>();
            var xyz = new List<float>();
            var vertices = new List<Vector3>();
            foreach (MeshFilter mf in body.GetComponentsInChildren<MeshFilter>(true))
            {
                Renderer r = mf.GetComponent<Renderer>();
                if (mf.sharedMesh == null || r == null || !r.enabled) continue;
                Matrix4x4 toBody = body.worldToLocalMatrix * mf.transform.localToWorldMatrix;
                mf.sharedMesh.GetVertices(vertices);
                foreach (Vector3 v in vertices)
                {
                    Vector3 p = toBody.MultiplyPoint3x4(v);
                    xyz.Add(-p.x);
                    xyz.Add(p.y);
                    xyz.Add(p.z);
                }
            }
            return xyz.ToArray();
        }

        private static void Remap(Transform part)
        {
            foreach (Renderer r in part.GetComponentsInChildren<Renderer>(true))
            {
                Material[] mats = r.sharedMaterials;
                bool collision = false;
                for (int i = 0; i < mats.Length; i++)
                {
                    string name = mats[i] != null ? mats[i].name : "";
                    if (name == "COLLISION") collision = true;
                    mats[i] = Remapped(name);
                }
                r.sharedMaterials = mats;
                // Real shadow maps stand in for the web game's planform silhouettes.
                r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
                r.receiveShadows = true;
                // Kept in the graph for debugging, never drawn.
                if (collision) r.enabled = false;
            }
        }

        private static Material Remapped(string name)
        {
            if (RemappedMaterials.TryGetValue(name, out Material m) && m != null) return m;
            m = new Material(Shader.Find("Retro/SceneryLit")) { name = "aircraft " + name };
            // models.ts: a literal colour (a livery, the canopy) opts out of the palette but
            // stands in the same light; a category name is the palette's own colour.
            if (name == "GLASS" || name == "#d1f7ff") ScenePalette.Bind(m, "_Color", () => ScenePalette.Raw(GlassColor));
            else if (RawColor.IsMatch(name)) ScenePalette.Bind(m, "_Color", () => ScenePalette.Raw(name));
            else
            {
                PaletteCategory category = Enum.TryParse(name, out PaletteCategory c) ? c : PaletteCategory.VEHICLE_PLANE_GREY;
                ScenePalette.Bind(m, "_Color", category);
            }
            // glTFast already rewinds for Unity: these faces are front faces as they come.
            m.SetFloat("_Cull", (float)UnityEngine.Rendering.CullMode.Back);
            m.SetFloat("_GltfWinding", 1);
            RemappedMaterials[name] = m;
            return m;
        }

        public Transform Root => root;

        public void SetVisible(bool visible)
        {
            if (root != null && root.gameObject.activeSelf != visible) root.gameObject.SetActive(visible);
        }

        /// <summary>Place every part for this frame: aircraft pose in scene axes, camera position for the floating origin.</summary>
        /// <param name="damage">
        /// Damage the airframe survived (player.ts / aiAircraft.ts render3D): while it is active the
        /// bent body is drawn elsewhere, so the glTF body hides; a ripped part or one taken into the
        /// bent body hides; the rest move with the bend (TransformPart).
        /// </param>
        public void Pose(Vec3d position, Quatd quaternion, Vec3d camera, in AircraftPoseInputs inputs, AirframeDamage damage = null)
        {
            if (!Loaded) return;
            bool damaged = damage != null && damage.Active;
            body.gameObject.SetActive(!damaged);
            var unit = new Vec3d(1, 1, 1);
            Quaternion bodyRotation = SceneFrame.ToUnity(quaternion) * HalfTurnY;
            Vector3 bodyPosition = SceneFrame.ToUnity(position - camera);
            body.SetPositionAndRotation(bodyPosition, bodyRotation);
            posedPosition = position;
            posedQuaternion = quaternion;
            if (gear != null)
            {
                gearDown = def.GearAnimated || inputs.GearUnit > 0;
                bool gearGone = damaged && (damage.GearInRoot || damage.IsPartRipped(0));
                gear.gameObject.SetActive((def.GearAnimated || inputs.GearUnit > 0) && !gearGone);
                if (damaged && !gearGone)
                {
                    Vec3d gp = position;
                    Quatd gq = quaternion;
                    damage.TransformPart(0, ref gp, ref gq, position, quaternion, unit);
                    gear.SetPositionAndRotation(SceneFrame.ToUnity(gp - camera), SceneFrame.ToUnity(gq) * HalfTurnY);
                }
                else
                {
                    gear.SetPositionAndRotation(bodyPosition, bodyRotation);
                }
                if (def.GearAnimated) SampleGear(inputs.GearUnit);
            }
            for (int i = 0; i < surfaces.Length; i++)
            {
                deflections[i] = inputs.Still ? 0 : SurfaceValue(def.Surfaces[i], inputs) * def.Surfaces[i].RangeRad;
            }
            for (int i = 0; i < surfaces.Length; i++)
            {
                if (surfaces[i] == null) continue;
                SurfaceHinge? parent = parentIndex[i] >= 0 ? Hinge(parentIndex[i]) : (SurfaceHinge?)null;
                var (p, q) = WingSweep.PoseSurface(Hinge(i), parent, position, quaternion);
                surfacePositions[i] = p;
                surfaceQuaternions[i] = q;
                if (damaged)
                {
                    // Torn off by an earlier impact, or bent into the body: not drawn on its own.
                    bool gone = damage.IsPartRipped(1 + i) || damage.RootParts.Contains(1 + i);
                    surfaces[i].gameObject.SetActive(!gone);
                    if (gone) continue;
                    damage.TransformPart(1 + i, ref p, ref q, position, quaternion, unit);
                }
                else if (!surfaces[i].gameObject.activeSelf)
                {
                    surfaces[i].gameObject.SetActive(true);
                }
                surfaces[i].SetPositionAndRotation(SceneFrame.ToUnity(p - camera), SceneFrame.ToUnity(q) * HalfTurnY);
            }
        }

        /// <summary>
        /// What the wreck field needs to take this airframe apart (player.ts / aiAircraft.ts
        /// collectWreckParts): the body, the gear while it is down (or animated), and every
        /// hinged surface where it was last posed, each as its drawn meshes in the model frame.
        /// </summary>
        public WreckSource WreckSource(string id, Vec3d velocity, bool gearShown, AirframeDamage damage = null)
        {
            if (!Loaded) return null;
            var src = new WreckSource
            {
                Id = id,
                Body = WreckModelOf(body),
                Position = posedPosition,
                Quaternion = posedQuaternion,
                Velocity = velocity,
                Cockpit = def.CockpitOffset,
                Damage = damage != null && damage.Active ? damage : null,
            };
            // collectWreckParts: the gear while it is down (or animated), whatever damage did to it.
            if (gear != null && gearDown && gearShown)
            {
                src.Parts.Add(new WreckPart { Model = WreckModelOf(gear), Position = posedPosition, Quaternion = posedQuaternion, Kind = WreckPartKind.Gear, Id = 0 });
            }
            for (int i = 0; i < surfaces.Length; i++)
            {
                if (surfaces[i] == null) continue;
                src.Parts.Add(new WreckPart
                {
                    Model = WreckModelOf(surfaces[i]), Position = surfacePositions[i], Quaternion = surfaceQuaternions[i],
                    Kind = WreckPartKind.Surface, Id = 1 + i,
                });
            }
            return src;
        }

        private static readonly double[] IdentityMatrix = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };

        /// <summary>
        /// A part's drawn meshes as the wreck field reads a three.js model: positions and
        /// normals in the model frame (glTFast negated x on import and turned the winding to
        /// match, so both are undone), one mesh per material, the Unity material as the handle.
        /// Node transforms (and the gear's sampled clip) are baked in.
        /// </summary>
        private static WreckModel WreckModelOf(Transform part)
        {
            var model = new WreckModel();
            var vertices = new List<Vector3>();
            var normals = new List<Vector3>();
            var tris = new List<int>();
            Vector3 min = Vector3.positiveInfinity, max = Vector3.negativeInfinity;
            foreach (MeshFilter mf in part.GetComponentsInChildren<MeshFilter>(true))
            {
                Renderer r = mf.GetComponent<Renderer>();
                Mesh mesh = mf.sharedMesh;
                if (mesh == null || r == null || !r.enabled) continue;
                Matrix4x4 toPart = part.worldToLocalMatrix * mf.transform.localToWorldMatrix;
                mesh.GetVertices(vertices);
                mesh.GetNormals(normals);
                var positions = new float[vertices.Count * 3];
                var nrm = normals.Count == vertices.Count ? new float[vertices.Count * 3] : null;
                for (int v = 0; v < vertices.Count; v++)
                {
                    Vector3 pp = toPart.MultiplyPoint3x4(vertices[v]);
                    positions[v * 3] = -pp.x;
                    positions[v * 3 + 1] = pp.y;
                    positions[v * 3 + 2] = pp.z;
                    min = Vector3.Min(min, new Vector3(-pp.x, pp.y, pp.z));
                    max = Vector3.Max(max, new Vector3(-pp.x, pp.y, pp.z));
                    if (nrm != null)
                    {
                        Vector3 n = toPart.MultiplyVector(normals[v]).normalized;
                        nrm[v * 3] = -n.x;
                        nrm[v * 3 + 1] = n.y;
                        nrm[v * 3 + 2] = n.z;
                    }
                }
                Material[] mats = r.sharedMaterials;
                for (int sub = 0; sub < mesh.subMeshCount; sub++)
                {
                    // Lines and points are not taken apart (the TS skips them too).
                    if (mesh.GetTopology(sub) != MeshTopology.Triangles) continue;
                    mesh.GetTriangles(tris, sub);
                    var idx = new int[tris.Count];
                    for (int t = 0; t + 2 < tris.Count; t += 3)
                    {
                        idx[t] = tris[t];
                        idx[t + 1] = tris[t + 2];
                        idx[t + 2] = tris[t + 1];
                    }
                    model.Meshes.Add(new WreckMeshInput
                    {
                        Positions = positions,
                        Normals = nrm,
                        Indices = idx,
                        Matrix = IdentityMatrix,
                        Material = sub < mats.Length ? mats[sub] : mats[mats.Length - 1],
                    });
                }
            }
            Vector3 size = max - min;
            model.MaxSize = model.Meshes.Count > 0 ? Mathf.Max(size.x, Mathf.Max(size.y, size.z)) : 0;
            return model;
        }

        private SurfaceHinge Hinge(int i) => new SurfaceHinge
        {
            Pivot = def.Surfaces[i].Pivot,
            Axis = def.Surfaces[i].Axis,
            Deflection = deflections[i],
        };

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
        private static double SurfaceValue(ControlSurfaceDef s, in AircraftPoseInputs i)
        {
            double roll = Math.Abs(i.RollDemand) > Math.Abs(i.CommandedAileron) ? i.RollDemand : i.CommandedAileron;
            double pitch = i.CommandedElevator;
            switch (s.Control)
            {
                case "pitch": return s.Sign * pitch;
                case "roll": return s.Sign * roll;
                case "yaw": return s.Sign * i.CommandedRudder;
                case "flaps": return s.Sign * i.FlapsUnit;
                case "slats":
                {
                    double aoa = Math.Abs(i.AngleOfAttack);
                    double aoaDeploy = aoa <= SlatAoaOnsetRad
                        ? 0
                        : Math.Max(0, Math.Min(1, (aoa - SlatAoaOnsetRad) / (SlatAoaFullRad - SlatAoaOnsetRad)));
                    return s.Sign * Math.Max(i.FlapsUnit, aoaDeploy);
                }
                case "airbrake": return s.Sign * i.AirbrakesUnit;
                case "sweep": return s.Sign * i.SweepUnit;
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

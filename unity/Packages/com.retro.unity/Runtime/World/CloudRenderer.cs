using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Game;
using UnityEngine;
using UnityEngine.Rendering;

namespace Retro.Unity
{
    /// <summary>
    /// The cumulus and cirrus decks (game.ts cloudField / cirrusField on the
    /// ported <see cref="SceneryField"/>): two wrapped fields dealt once from a
    /// random seed, collected around the camera every frame with the web game's
    /// screen-size LOD, and drawn instanced per model and level - each cumulus
    /// as its lit solid body plus a prefix of its dithered haze, each cirrus as
    /// one dithered streak. Both decks go away at space altitude.
    /// </summary>
    [DefaultExecutionOrder(104)]
    public sealed class CloudRenderer : MonoBehaviour
    {
        public FlyCamera viewer;
        public bool cloudsEnabled = true;
        [Tooltip("0 = a new sky every session, as the web game's Math.random.")]
        public int seed;

        [Header("Stats (read only)")]
        public int cumulusDrawn;
        public int cirrusDrawn;
        public int triangles;

        private sealed class ModelMeshes
        {
            public Mesh Solid;
            public Mesh Haze; // submesh per LOD level: the haze prefix that level draws
            public int HazeLevels;
        }

        private SceneryField cumulus, cirrus;
        private readonly Dictionary<SkyShapeModel, ModelMeshes> meshes = new Dictionary<SkyShapeModel, ModelMeshes>();
        private readonly List<FieldInstance> instances = new List<FieldInstance>();
        private readonly Dictionary<(SkyShapeModel, int), List<Matrix4x4>> batches = new Dictionary<(SkyShapeModel, int), List<Matrix4x4>>();
        private readonly Plane[] planes = new Plane[6];
        private Material solidMaterial, hazeMaterial;

        private void Start()
        {
            Func<double> random = Retro.Sim.Gun.Mulberry32(seed != 0 ? (uint)seed : (uint)Environment.TickCount);
            cumulus = SkyFields.CreateCloudField(random);
            cirrus = SkyFields.CreateCirrusField(random);

            solidMaterial = new Material(Shader.Find("Retro/CloudSky")) { name = "cloud solid", enableInstancing = true };
            solidMaterial.SetFloat("_Cull", (float)CullMode.Front);
            hazeMaterial = new Material(Shader.Find("Retro/CloudSky")) { name = "cloud haze", enableInstancing = true };
            hazeMaterial.EnableKeyword("_HAZE");
            hazeMaterial.SetFloat("_Haze", 1);
            hazeMaterial.SetFloat("_ZWrite", 0);
            hazeMaterial.SetFloat("_Cull", (float)CullMode.Front);
            // After the bodies: the haze writes no depth, so a body drawn later would cover it.
            hazeMaterial.renderQueue = (int)RenderQueue.Geometry + 11;
            foreach (Material m in new[] { solidMaterial, hazeMaterial })
            {
                ScenePalette.Bind(m, "_Color", PaletteCategory.SKY_CLOUD);
                ScenePalette.Bind(m, "_ColorShade", () => ScenePalette.ToneShade(PaletteCategory.SKY_CLOUD));
            }
        }

        private ModelMeshes MeshesFor(SkyShapeModel model)
        {
            if (meshes.TryGetValue(model, out ModelMeshes m)) return m;
            m = new ModelMeshes();
            if (model is CloudModel cloud && !cloud.IsEmpty)
            {
                m.Solid = Indexed(model.Name + " solid", cloud.SolidPositions, cloud.SolidNormals, cloud.SolidIndices);
                var prefixes = new List<int>();
                for (int lod = 0; lod < cloud.LodCount; lod++)
                {
                    int count = cloud.HazeVertexCount(lod);
                    if (count > 0) prefixes.Add(count);
                }
                m.Haze = Soup(model.Name + " haze", cloud.HazePositions, cloud.HazeNormals, i => cloud.HazeDitherLevel[i], prefixes);
                m.HazeLevels = prefixes.Count;
            }
            else if (model is CirrusModel streak && !streak.IsEmpty)
            {
                m.Haze = Soup(model.Name, streak.Positions, streak.Normals, _ => (float)CirrusModel.AlphaDither,
                    new List<int> { streak.Positions.Length / 3 });
                m.HazeLevels = 1;
            }
            meshes[model] = m;
            return m;
        }

        private static Vector3[] Vectors(float[] xyz)
        {
            var v = new Vector3[xyz.Length / 3];
            for (int i = 0; i < v.Length; i++) v[i] = new Vector3(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
            return v;
        }

        private static Mesh Indexed(string name, float[] positions, float[] normals, int[] indices)
        {
            int n = positions.Length / 3;
            var mesh = new Mesh { name = name, indexFormat = n > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            mesh.SetVertices(Vectors(positions));
            mesh.SetNormals(Vectors(normals));
            mesh.SetUVs(0, new Vector2[n]);
            mesh.SetTriangles(indices, 0);
            mesh.RecalculateBounds();
            return mesh;
        }

        /// <summary>A triangle soup with sequential indices, one submesh per drawn prefix.</summary>
        private static Mesh Soup(string name, float[] positions, float[] normals, Func<int, float> dither, List<int> prefixes)
        {
            int n = positions.Length / 3;
            var mesh = new Mesh { name = name, indexFormat = n > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            mesh.SetVertices(Vectors(positions));
            mesh.SetNormals(Vectors(normals));
            var uv = new Vector2[n];
            for (int i = 0; i < n; i++) uv[i] = new Vector2(dither(i), 0);
            mesh.SetUVs(0, uv);
            mesh.subMeshCount = prefixes.Count;
            for (int s = 0; s < prefixes.Count; s++)
            {
                var idx = new int[prefixes[s]];
                for (int i = 0; i < idx.Length; i++) idx[i] = i;
                mesh.SetTriangles(idx, s, false);
            }
            mesh.RecalculateBounds();
            return mesh;
        }

        private void Update()
        {
            if (cumulus == null || viewer == null || viewer.UnityCamera == null) return;
            Vec3d cam = viewer.ScenePosition;
            Camera unityCam = viewer.UnityCamera;
            bool on = cloudsEnabled && SkyFields.FieldsEnabled(cam.Y, false);
            cumulus.Enabled = cirrus.Enabled = on;

            var view = new FieldView
            {
                CameraPosition = cam,
                TanHalfFov = Math.Tan(unityCam.fieldOfView * Math.PI / 360),
                Aspect = unityCam.aspect,
                TargetWidth = unityCam.pixelWidth,
                Frustum = null,
            };
            instances.Clear();
            cumulus.Collect(view, instances);
            int cumulusCount = instances.Count;
            cirrus.Collect(view, instances);

            // Frustum test in Unity's camera-relative, z-mirrored world (the camera sits at the origin).
            GeometryUtility.CalculateFrustumPlanes(unityCam, planes);
            foreach (List<Matrix4x4> list in batches.Values) list.Clear();
            cumulusDrawn = cirrusDrawn = triangles = 0;
            for (int i = 0; i < instances.Count; i++)
            {
                FieldInstance f = instances[i];
                double radius = (i < cumulusCount ? cumulus.CullRadius : cirrus.CullRadius) + f.Model.MaxSize / 2;
                Vec3d rel = f.Position - cam;
                var centre = new Vector3((float)rel.X, (float)(rel.Y + f.Model.CenterY), (float)-rel.Z);
                if (!GeometryUtility.TestPlanesAABB(planes, new Bounds(centre, Vector3.one * (float)(2 * radius)))) continue;
                if (!batches.TryGetValue((f.Model, f.Lod), out List<Matrix4x4> list))
                {
                    list = new List<Matrix4x4>();
                    batches[(f.Model, f.Lod)] = list;
                }
                list.Add(SceneFrame.TileMatrix(f.Position, cam, f.Rotation, 1));
                triangles += f.Model.Triangles(f.Lod);
                if (i < cumulusCount) cumulusDrawn++;
                else cirrusDrawn++;
            }

            var solid = new RenderParams(solidMaterial) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };
            var haze = new RenderParams(hazeMaterial) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };
            foreach (KeyValuePair<(SkyShapeModel Model, int Lod), List<Matrix4x4>> b in batches)
            {
                if (b.Value.Count == 0) continue;
                ModelMeshes m = MeshesFor(b.Key.Model);
                solid.worldBounds = haze.worldBounds = new Bounds(Vector3.zero, Vector3.one * 1e7f);
                if (m.Solid != null) Graphics.RenderMeshInstanced(solid, m.Solid, 0, b.Value);
                if (m.Haze != null && b.Key.Lod < m.HazeLevels) Graphics.RenderMeshInstanced(haze, m.Haze, b.Key.Lod, b.Value);
            }
        }

        private void OnDestroy()
        {
            foreach (ModelMeshes m in meshes.Values)
            {
                if (m.Solid != null) Destroy(m.Solid);
                if (m.Haze != null) Destroy(m.Haze);
            }
            meshes.Clear();
            if (solidMaterial != null) Destroy(solidMaterial);
            if (hazeMaterial != null) Destroy(hazeMaterial);
        }
    }
}

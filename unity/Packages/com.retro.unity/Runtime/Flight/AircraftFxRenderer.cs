using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Game;
using UnityEngine;
using UnityEngine.Rendering;

namespace Retro.Unity
{
    /// <summary>
    /// One aircraft's exterior FX drawn (aircraftFx.ts on the ported
    /// <see cref="AircraftFx"/>): the afterburner plumes - per nozzle a halo
    /// cone, a core cone and a dish, yellow, stippled at their dither
    /// opacities, writing depth - and the two wingtip trails, white ribbons
    /// whose segments fade with age, built camera-relative every frame.
    /// </summary>
    public sealed class AircraftFxRenderer : IDisposable
    {
        public readonly AircraftFx Fx = new AircraftFx();

        private static Material plumeMaterial, trailMaterial;
        private Mesh inner, outer, dish;
        private int geometryVersion = -1;
        // Made on first draw: a MonoBehaviour field may hold this, and Unity objects cannot be made in its constructor.
        private Mesh[] trails;
        private readonly List<Vector3> vertices = new List<Vector3>();
        private readonly List<Vector2> levels = new List<Vector2>();
        private readonly List<int> indices = new List<int>();

        private static Mesh NewDynamicMesh(string name)
        {
            var m = new Mesh { name = name };
            m.MarkDynamic();
            return m;
        }

        /// <summary>The CloudSky shader's dithered pass serves: unlit, ordered-dither stipple per vertex, two tones.</summary>
        private static Material DitherMaterial(string name, Color colour, bool zWrite, int queue)
        {
            var m = new Material(Shader.Find("Retro/CloudSky")) { name = name, renderQueue = queue };
            m.EnableKeyword("_HAZE");
            m.SetFloat("_Haze", 1);
            m.SetFloat("_ZWrite", zWrite ? 1 : 0);
            m.SetFloat("_Cull", (float)CullMode.Off);
            m.SetColor("_Color", colour);
            m.SetColor("_ColorShade", colour);
            return m;
        }

        public void Configure(FlyableAircraftDef def)
        {
            Fx.ConfigureFromDef(def);
            geometryVersion = -1;
        }

        /// <summary>Tips from the body model when the def has none (once it has loaded).</summary>
        public void BindTips(AircraftModel model)
        {
            if (Fx.WingtipsReady || model == null || !model.Loaded) return;
            Fx.BindWingtipOrigins(model.BodyPositions());
        }

        public void Draw(in AircraftFxInput input, Vec3d camera)
        {
            if (plumeMaterial == null)
            {
                var yellow = new Color(AfterburnerCones.ConeColor[0], AfterburnerCones.ConeColor[1], AfterburnerCones.ConeColor[2]);
                plumeMaterial = DitherMaterial("afterburner", yellow, true, (int)RenderQueue.Geometry + 20);
                var white = new Color(WingtipTrails.TrailColor[0], WingtipTrails.TrailColor[1], WingtipTrails.TrailColor[2]);
                trailMaterial = DitherMaterial("wingtip trails", white, false, (int)RenderQueue.Geometry + 21);
            }
            trails ??= new[] { NewDynamicMesh("left trail"), NewDynamicMesh("right trail") };
            Fx.Update(input);
            Fx.LayoutTrails(camera);
            DrawPlumes(camera);
            if (Fx.WingtipsReady)
            {
                DrawTrail(Fx.WingtipTrails.Left, trails[0], camera);
                DrawTrail(Fx.WingtipTrails.Right, trails[1], camera);
            }
        }

        private void DrawPlumes(Vec3d camera)
        {
            AfterburnerCones cones = Fx.AfterburnerCones;
            if (!cones.Visible || cones.InnerGeometry == null) return;
            if (geometryVersion != cones.GeometryVersion)
            {
                inner = Rebuild(inner, "afterburner core", cones.InnerGeometry, AfterburnerCones.InnerConeAlphaDither);
                outer = Rebuild(outer, "afterburner halo", cones.OuterGeometry, AfterburnerCones.OuterConeAlphaDither);
                dish = Rebuild(dish, "afterburner dish", cones.DishGeometry, AfterburnerCones.InnerConeAlphaDither);
                geometryVersion = cones.GeometryVersion;
            }
            var rp = new RenderParams(plumeMaterial) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };
            for (int i = 0; i < cones.RootPositions.Length; i++)
            {
                Matrix4x4 m = SceneFrame.TileMatrix(cones.PlumePosition(i), camera, cones.RootRotation, 1);
                Graphics.RenderMesh(rp, outer, 0, m);
                Graphics.RenderMesh(rp, inner, 0, m);
                Graphics.RenderMesh(rp, dish, 0, m);
            }
        }

        /// <summary>A non-indexed float32 soup as a mesh, its dither opacity in uv.x.</summary>
        private static Mesh Rebuild(Mesh mesh, string name, float[] xyz, double dither)
        {
            if (mesh == null) mesh = new Mesh { name = name };
            mesh.Clear();
            int n = xyz.Length / 3;
            var v = new Vector3[n];
            var uv = new Vector2[n];
            var idx = new int[n];
            for (int i = 0; i < n; i++)
            {
                v[i] = new Vector3(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
                uv[i] = new Vector2((float)dither, 0);
                idx[i] = i;
            }
            mesh.SetVertices(v);
            mesh.SetUVs(0, uv);
            mesh.SetTriangles(idx, 0);
            mesh.RecalculateBounds();
            return mesh;
        }

        /// <summary>
        /// The side's segments as one ribbon: each quad's corners from its matrix's
        /// axes around its double midpoint, so the trail stays exact far from the origin.
        /// </summary>
        private void DrawTrail(WingTrailSide side, Mesh mesh, Vec3d camera)
        {
            if (!side.Visible || side.DrawnCount == 0) return;
            vertices.Clear();
            levels.Clear();
            indices.Clear();
            float[] mx = side.Matrices;
            for (int k = 0; k < side.DrawnCount; k++)
            {
                int o = k * 16;
                Vec3d rel = side.Midpoints[k] - camera;
                var c = new Vector3((float)rel.X, (float)rel.Y, (float)rel.Z);
                var ax = new Vector3(mx[o], mx[o + 1], mx[o + 2]);
                var ay = new Vector3(mx[o + 4], mx[o + 5], mx[o + 6]);
                int b = vertices.Count;
                // PlaneGeometry(1, 1): (-0.5, 0.5), (0.5, 0.5), (-0.5, -0.5), (0.5, -0.5).
                vertices.Add(c - 0.5f * ax + 0.5f * ay);
                vertices.Add(c + 0.5f * ax + 0.5f * ay);
                vertices.Add(c - 0.5f * ax - 0.5f * ay);
                vertices.Add(c + 0.5f * ax - 0.5f * ay);
                var level = new Vector2(side.Levels[k], 0);
                levels.Add(level);
                levels.Add(level);
                levels.Add(level);
                levels.Add(level);
                indices.Add(b);
                indices.Add(b + 2);
                indices.Add(b + 1);
                indices.Add(b + 2);
                indices.Add(b + 3);
                indices.Add(b + 1);
            }
            mesh.Clear();
            mesh.SetVertices(vertices);
            mesh.SetUVs(0, levels);
            mesh.SetTriangles(indices, 0);
            mesh.RecalculateBounds();
            // Already camera-relative in scene axes: only the z mirror is left.
            Matrix4x4 mirror = SceneFrame.TileMatrix(camera, camera, Quatd.Identity, 1);
            Graphics.RenderMesh(new RenderParams(trailMaterial) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false },
                mesh, 0, mirror);
        }

        public void Dispose()
        {
            foreach (Mesh m in new[] { inner, outer, dish, trails?[0], trails?[1] })
            {
                if (m != null) UnityEngine.Object.Destroy(m);
            }
        }
    }
}

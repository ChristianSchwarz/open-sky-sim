using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using UnityEngine;
using UnityEngine.Rendering;

namespace Retro.Unity
{
    /// <summary>
    /// The gun rounds in flight (weaponsField.ts with tracerModelBuilder.ts):
    /// one unlit LIGHT_YELLOW streak, 0.6 x 0.6 x 12 m along the velocity, per
    /// live projectile of the sim's pool, drawn instanced. Where the web game
    /// swaps a far streak for a one-pixel point, the streak is widened to stay
    /// at least about a pixel and a half across.
    /// </summary>
    public sealed class TracerRenderer : IDisposable
    {
        // tracerModelBuilder.ts
        private const float TracerLength = 12;
        private const float TracerWidth = 0.6f;
        private const float MinWidthPx = 1.5f;

        private Mesh box;
        private Material material;
        private readonly List<Matrix4x4> matrices = new List<Matrix4x4>();

        public int Drawn { get; private set; }

        private void Build()
        {
            GameObject cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
            Mesh unit = cube.GetComponent<MeshFilter>().sharedMesh;
            UnityEngine.Object.Destroy(cube);
            var v = new List<Vector3>();
            unit.GetVertices(v);
            for (int i = 0; i < v.Count; i++) v[i] = Vector3.Scale(v[i], new Vector3(TracerWidth, TracerWidth, TracerLength));
            box = new Mesh { name = "tracer" };
            box.SetVertices(v);
            box.SetUVs(0, new Vector2[v.Count]); // dither 0: solid
            box.SetTriangles(unit.triangles, 0);
            box.RecalculateBounds();

            material = new Material(Shader.Find("Retro/CloudSky")) { name = "tracers", enableInstancing = true };
            material.EnableKeyword("_HAZE");
            material.SetFloat("_Haze", 1);
            material.SetFloat("_ZWrite", 1);
            material.SetFloat("_Cull", (float)CullMode.Off);
            ScenePalette.Bind(material, "_Color", PaletteCategory.LIGHT_YELLOW);
            ScenePalette.Bind(material, "_ColorShade", PaletteCategory.LIGHT_YELLOW);
        }

        public void Draw(CombatSim sim, Vec3d camera, Camera unityCamera)
        {
            Drawn = 0;
            if (sim.ActiveProjectileCount == 0 || unityCamera == null) return;
            if (box == null) Build();
            double pixelAngle = 2 * Math.Tan(unityCamera.fieldOfView * Math.PI / 360) / Math.Max(1, unityCamera.pixelHeight);
            matrices.Clear();
            foreach (CombatSim.ProjectileSlot slot in sim.Projectiles)
            {
                if (!slot.Active) continue;
                Quatd? q = CombatSim.ProjectileQuaternion(slot);
                if (q == null) continue;
                double d = (slot.Pos - camera).Length;
                float widen = (float)Math.Max(1, MinWidthPx * d * pixelAngle / TracerWidth);
                matrices.Add(SceneFrame.TileMatrix(slot.Pos, camera, q.Value, 1) * Matrix4x4.Scale(new Vector3(widen, widen, 1)));
            }
            Drawn = matrices.Count;
            if (Drawn == 0) return;
            var rp = new RenderParams(material)
            {
                shadowCastingMode = ShadowCastingMode.Off,
                receiveShadows = false,
                worldBounds = new Bounds(Vector3.zero, Vector3.one * 1e6f),
            };
            Graphics.RenderMeshInstanced(rp, box, 0, matrices);
        }

        public void Dispose()
        {
            if (box != null) UnityEngine.Object.Destroy(box);
            if (material != null) UnityEngine.Object.Destroy(material);
        }
    }
}

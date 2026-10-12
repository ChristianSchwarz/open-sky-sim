using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Sim;
using UnityEngine;
using UnityEngine.Rendering;

namespace Retro.Unity
{
    /// <summary>
    /// The V key's force arrows (aircraftForceVectors.ts): every per-part force
    /// the flight model reports, split into its body-axis components, each an
    /// arrow from the part's origin with two barbs at the tip, coloured by kind
    /// (lift green, drag red, thrust cyan, weight amber), drawn as one line
    /// mesh in the body frame at the aircraft's pose.
    /// </summary>
    public sealed class ForceVectorRenderer : IDisposable
    {
        // aircraftForceVectors.ts FORCE_SCALE, MAX_LEN, MIN_FORCE_N.
        private const double ForceScale = 0.0004;
        private const double MaxLen = 30;
        private const double MinForceN = 50;

        private static readonly Color32[] KindColours =
        {
            new Color32(0x55, 0xff, 0x55, 0xff), // lift
            new Color32(0xff, 0x55, 0x55, 0xff), // drag
            new Color32(0x55, 0xcc, 0xff, 0xff), // thrust
            new Color32(0xff, 0xcc, 0x33, 0xff), // weight
        };

        private readonly List<Vector3> vertices = new List<Vector3>();
        private readonly List<Color32> colours = new List<Color32>();
        private readonly List<int> indices = new List<int>();
        private Mesh mesh;
        private Material material;

        /// <summary>update + addToRenderList: this frame's arrows; none drawn when there are no samples.</summary>
        public void Draw(IReadOnlyList<ForceVectorSample> samples, Vec3d position, Quatd quaternion, Vec3d camera)
        {
            if (samples == null || samples.Count == 0) return;
            vertices.Clear();
            colours.Clear();
            indices.Clear();
            foreach (ForceVectorSample s in samples)
            {
                Color32 c = KindColours[Math.Min(KindColours.Length - 1, Math.Max(0, (int)s.Kind))];
                Axis(s.Origin, new Vec3d(1, 0, 0), s.Vec.X, c);
                Axis(s.Origin, new Vec3d(0, 1, 0), s.Vec.Y, c);
                Axis(s.Origin, new Vec3d(0, 0, 1), s.Vec.Z, c);
            }
            if (indices.Count == 0) return;
            if (mesh == null)
            {
                mesh = new Mesh { name = "force vectors" };
                mesh.MarkDynamic();
                material = new Material(Shader.Find("Hidden/Internal-Colored")) { name = "force vectors" };
                material.SetInt("_ZWrite", 0);
                material.SetInt("_Cull", (int)CullMode.Off);
            }
            mesh.Clear();
            mesh.SetVertices(vertices);
            mesh.SetColors(colours);
            mesh.SetIndices(indices, MeshTopology.Lines, 0);
            mesh.bounds = new Bounds(Vector3.zero, Vector3.one * 200);
            // Body-frame vertices in scene axes: the tile matrix mirrors them into Unity's.
            Matrix4x4 m = SceneFrame.TileMatrix(position, camera, quaternion, 1);
            Graphics.RenderMesh(new RenderParams(material) { shadowCastingMode = ShadowCastingMode.Off }, mesh, 0, m);
        }

        /// <summary>emitAxis: one component as an arrow, skipped below MIN_FORCE_N.</summary>
        private void Axis(Vec3d origin, Vec3d axis, double component, Color32 c)
        {
            double force = Math.Abs(component);
            if (force < MinForceN) return;
            double len = Math.Min(force * ForceScale, MaxLen);
            Vec3d dir = axis * (Math.Sign(component) == 0 ? 1 : Math.Sign(component));
            Vec3d tip = origin + dir * len;
            double headLen = Math.Min(len * 0.25, 2.0);
            double headWidth = headLen * 0.5;
            Vec3d reference = Math.Abs(Vec3d.Dot(dir, new Vec3d(0, 1, 0))) > 0.95 ? new Vec3d(1, 0, 0) : new Vec3d(0, 1, 0);
            Vec3d perp = Vec3d.Cross(dir, reference).Normalized();
            Vec3d back = tip - dir * headLen;
            // The web's five-point polyline: origin, tip, barb, tip, barb.
            int b = vertices.Count;
            Add(origin, c);
            Add(tip, c);
            Add(back + perp * headWidth, c);
            Add(tip, c);
            Add(back - perp * headWidth, c);
            for (int i = 0; i < 4; i++)
            {
                indices.Add(b + i);
                indices.Add(b + i + 1);
            }
        }

        private void Add(Vec3d p, Color32 c)
        {
            vertices.Add(new Vector3((float)p.X, (float)p.Y, (float)p.Z));
            colours.Add(c);
        }

        public void Dispose()
        {
            if (mesh != null) UnityEngine.Object.Destroy(mesh);
            if (material != null) UnityEngine.Object.Destroy(material);
        }
    }
}

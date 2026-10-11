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
    /// What the carrier leaves on and around itself (arrestorCablesEntity.ts,
    /// sternWake.ts, shipWake.ts on the ported <see cref="ArrestorCableShapes"/>
    /// and <see cref="ShipWake"/>): the four arrestor wires, thin black ribbons
    /// close in and one-pixel lines far off, bent to the hook while one is
    /// caught; and, at sea, the 2 km dithered foam ribbon astern plus the foam
    /// puffs lying flat on the water at the stern and bow.
    /// </summary>
    public sealed class CarrierFx : IDisposable
    {
        /// <summary>sternWake.ts / shipWake.ts foam colour (raw, not the palette).</summary>
        private static readonly Color Foam = new Color32(0xe8, 0xf0, 0xf4, 0xff);
        private const int DiscSides = 6;

        private readonly Carrier carrier;
        private readonly ArrestorCableShapes cables;
        private readonly ShipWake wake;
        private Mesh ribbons, lines, sternRibbon, puffs;
        private Material wire, foam;
        private readonly List<Vector3> v = new List<Vector3>();
        private readonly List<Vector2> uv = new List<Vector2>();
        private readonly List<int> idx = new List<int>();

        public CarrierFx(Carrier carrier, Func<double, double, double> groundAt)
        {
            this.carrier = carrier;
            cables = new ArrestorCableShapes(carrier.Pose, groundAt);
            if (carrier.AtSea) wake = new ShipWake(Retro.Sim.Gun.Mulberry32((uint)Environment.TickCount));
        }

        private static Material Unlit(string name, Color colour, int queue)
        {
            var m = new Material(Shader.Find("Retro/CloudSky")) { name = name, renderQueue = queue };
            m.EnableKeyword("_HAZE");
            m.SetFloat("_Haze", 1);
            m.SetFloat("_ZWrite", 0);
            m.SetFloat("_Cull", (float)CullMode.Off);
            m.SetColor("_Color", colour);
            m.SetColor("_ColorShade", colour);
            return m;
        }

        private static Mesh Dynamic(string name)
        {
            var m = new Mesh { name = name, indexFormat = IndexFormat.UInt32 };
            m.MarkDynamic();
            return m;
        }

        /// <summary>One frame, after the carrier and the player have their poses for it.</summary>
        public void Draw(SimAircraft player, Vec3d hingeBody, Vec3d camera, double dt)
        {
            if (wire == null)
            {
                // The wires go after the hull (EntityFX), depth-tested but not written.
                wire = Unlit("arrestor wires", Color.black, (int)RenderQueue.Geometry + 30);
                foam = Unlit("ship wake", Foam, (int)RenderQueue.Geometry + 31);
                ribbons = Dynamic("wire ribbons");
                lines = Dynamic("wire lines");
                sternRibbon = Dynamic("stern wake");
                puffs = Dynamic("wake foam");
            }
            ArrestorCarrierPose pose = carrier.Pose;
            Vec3d hinge = ArrestorCableShapes.HookHingeWorld(hingeBody, player.GetQuaternion(), player.GetPosition());
            cables.Update(pose, player.ArrestorLatch, hinge, camera);
            DrawWires(camera);
            if (wake == null) return;
            wake.Update(dt, pose);
            DrawSternRibbon(camera);
            DrawPuffs(camera);
        }

        private void DrawWires(Vec3d camera)
        {
            Matrix4x4 m = SceneFrame.TileMatrix(cables.RootPosition, camera, cables.RootRotation, 1);
            var rp = new RenderParams(wire) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };
            v.Clear();
            uv.Clear();
            idx.Clear();
            if (cables.RibbonsVisible)
            {
                foreach (ArrestorCableShape c in cables.Cables)
                {
                    foreach (float[] quad in new[] { c.RibbonA, c.RibbonB })
                    {
                        int b = v.Count;
                        for (int i = 0; i < 4; i++) v.Add(new Vector3(quad[i * 3], quad[i * 3 + 1], quad[i * 3 + 2]));
                        idx.AddRange(new[] { b, b + 1, b + 2, b + 2, b + 1, b + 3 });
                    }
                }
                Upload(ribbons, MeshTopology.Triangles);
                Graphics.RenderMesh(rp, ribbons, 0, m);
            }
            else
            {
                foreach (ArrestorCableShape c in cables.Cables)
                {
                    int b = v.Count;
                    for (int i = 0; i < 3; i++) v.Add(new Vector3(c.Line[i * 3], c.Line[i * 3 + 1], c.Line[i * 3 + 2]));
                    idx.AddRange(new[] { b, b + 1, b + 1, b + 2 });
                }
                Upload(lines, MeshTopology.Lines);
                Graphics.RenderMesh(rp, lines, 0, m);
            }
        }

        /// <summary>50 quads astern, each at its own dither level (alpha in uv.x).</summary>
        private void DrawSternRibbon(Vec3d camera)
        {
            SternWakeRibbon ribbon = wake.SternRibbon;
            v.Clear();
            uv.Clear();
            idx.Clear();
            for (int j = 0; j < ribbon.SegmentVisible.Length; j++)
            {
                if (!ribbon.SegmentVisible[j]) continue;
                int b = v.Count;
                var level = new Vector2((float)ribbon.SegmentDither[j], 0);
                for (int i = 0; i < 4; i++)
                {
                    int o = j * 12 + i * 3;
                    v.Add(new Vector3(ribbon.Positions[o], ribbon.Positions[o + 1], ribbon.Positions[o + 2]));
                    uv.Add(level);
                }
                idx.AddRange(new[] { b, b + 1, b + 2, b + 2, b + 1, b + 3 });
            }
            if (idx.Count == 0) return;
            Upload(sternRibbon, MeshTopology.Triangles);
            Graphics.RenderMesh(new RenderParams(foam) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false },
                sternRibbon, 0, SceneFrame.TileMatrix(ribbon.ObjectPosition, camera, Quatd.Identity, 1));
        }

        /// <summary>Every live puff as a flat hexagon on the water, dither opacity in uv.x; camera-relative.</summary>
        private void DrawPuffs(Vec3d camera)
        {
            int n = wake.InstanceCount;
            v.Clear();
            uv.Clear();
            idx.Clear();
            for (int k = 0; k < n; k++)
            {
                Vec3d c = wake.OffsetsWorld[k] - camera;
                var centre = new Vector3((float)c.X, (float)c.Y, (float)c.Z);
                float r = wake.Scales[k];
                float rot = wake.Rotations[k];
                var level = new Vector2(wake.Colors[k * 4 + 3], 0);
                int b = v.Count;
                v.Add(centre);
                uv.Add(level);
                // CircleGeometry(1, 6) in the disc's xy, laid onto the water's xz.
                for (int s = 0; s <= DiscSides; s++)
                {
                    double a = rot + s * 2 * Math.PI / DiscSides;
                    v.Add(centre + new Vector3((float)(r * Math.Cos(a)), 0, (float)(r * Math.Sin(a))));
                    uv.Add(level);
                }
                for (int s = 0; s < DiscSides; s++) idx.AddRange(new[] { b, b + 1 + s, b + 2 + s });
            }
            if (idx.Count == 0) return;
            Upload(puffs, MeshTopology.Triangles);
            Graphics.RenderMesh(new RenderParams(foam) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false },
                puffs, 0, SceneFrame.TileMatrix(camera, camera, Quatd.Identity, 1));
        }

        private void Upload(Mesh mesh, MeshTopology topology)
        {
            mesh.Clear();
            mesh.SetVertices(v);
            if (uv.Count == v.Count) mesh.SetUVs(0, uv);
            else mesh.SetUVs(0, new Vector2[v.Count]);
            mesh.SetIndices(idx, topology, 0);
            mesh.RecalculateBounds();
        }

        public void Dispose()
        {
            foreach (UnityEngine.Object o in new UnityEngine.Object[] { ribbons, lines, sternRibbon, puffs, wire, foam })
            {
                if (o != null) UnityEngine.Object.Destroy(o);
            }
        }
    }
}

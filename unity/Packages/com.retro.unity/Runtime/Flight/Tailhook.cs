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
    /// The player's tailhook (player.ts updateTailhook / renderTailhook on
    /// tailhookModelBuilder.ts): a black-and-white striped arm from the belly
    /// hinge, shown once the pilot lowers it (H). It swings down from flush
    /// along the belly over 1.5 s; down, it points along the airframe's
    /// hinge-to-tip; caught, it lines up with the wire it holds.
    /// </summary>
    public sealed class Tailhook : IDisposable
    {
        // player.ts and tailhookModelBuilder.ts
        private const double AnimDurationS = 1.5;
        private const float StripeLength = 0.18f;
        private const float ArmThickness = 0.08f;

        private Vec3d tipBody, hingeBody;
        private double progress;
        private Mesh mesh;
        private Material black, white;

        /// <summary>Body-frame hinge (the cable shapes bend toward the tip on its ray).</summary>
        public Vec3d HingeBody => hingeBody;

        /// <summary>The swing, 0 stowed to 1 down.</summary>
        public double Unit => progress / AnimDurationS;

        /// <summary>arrestorHookPlacementForAircraft: tip from the def, hinge up and forward of it.</summary>
        public void Configure(FlyableAircraftDef def)
        {
            double[] tip = AircraftDefs.ArrestorHookTip(def);
            tipBody = new Vec3d(tip[0], tip[1], tip[2]);
            hingeBody = new Vec3d(tip[0], tip[1] + ArrestorCables.ArrestorHookHingeUpM, tip[2] + ArrestorCables.ArrestorHookHingeFwdM);
        }

        /// <summary>The swing snapped to the sim's hook state (a respawn).</summary>
        public void Snap(SimAircraft aircraft) => progress = aircraft.IsHookDeployed() ? AnimDurationS : 0;

        private void Build()
        {
            var v = new List<Vector3>();
            var blackTris = new List<int>();
            var whiteTris = new List<int>();
            void Box(Vector3 centre, Vector3 size, List<int> tris)
            {
                int b = v.Count;
                for (int i = 0; i < 8; i++)
                {
                    v.Add(centre + Vector3.Scale(size * 0.5f, new Vector3((i & 1) == 0 ? -1 : 1, (i & 2) == 0 ? -1 : 1, (i & 4) == 0 ? -1 : 1)));
                }
                int[] faces = { 0, 2, 3, 1, 4, 5, 7, 6, 0, 1, 5, 4, 2, 6, 7, 3, 0, 4, 6, 2, 1, 3, 7, 5 };
                for (int f = 0; f < 24; f += 4)
                {
                    tris.AddRange(new[] { b + faces[f], b + faces[f + 1], b + faces[f + 2], b + faces[f], b + faces[f + 2], b + faces[f + 3] });
                }
            }
            float length = (float)ArrestorCables.TailhookArmLengthM;
            float z = 0;
            int stripe = 0;
            while (z < length - 1e-4f)
            {
                float len = Math.Min(StripeLength, length - z);
                Box(new Vector3(0, 0, z + len * 0.5f), new Vector3(ArmThickness, ArmThickness, len), stripe % 2 == 0 ? blackTris : whiteTris);
                z += len;
                stripe++;
            }
            // The tip, black for contrast at the catch point.
            Box(new Vector3(0, 0, length), new Vector3(0.18f, 0.12f, 0.22f), blackTris);
            mesh = new Mesh { name = "tailhook", subMeshCount = 2 };
            mesh.SetVertices(v);
            mesh.SetUVs(0, new Vector2[v.Count]);
            mesh.SetTriangles(blackTris, 0);
            mesh.SetTriangles(whiteTris, 1);
            mesh.RecalculateBounds();
            black = Unlit("tailhook black", PaletteCategory.VEHICLE_PLANE_INTERIOR);
            white = Unlit("tailhook white", PaletteCategory.SCENERY_BUILDING_METAL_WHITE);
        }

        private static Material Unlit(string name, PaletteCategory category)
        {
            var m = new Material(Shader.Find("Retro/CloudSky")) { name = name };
            m.EnableKeyword("_HAZE");
            m.SetFloat("_Haze", 1);
            m.SetFloat("_ZWrite", 1);
            m.SetFloat("_Cull", (float)CullMode.Off);
            ScenePalette.Bind(m, "_Color", category);
            ScenePalette.Bind(m, "_ColorShade", category);
            return m;
        }

        public void Draw(SimAircraft aircraft, ArrestorCarrierPose carrier, Vec3d camera, double dt)
        {
            progress = Math.Max(0, Math.Min(AnimDurationS, progress + (aircraft.IsHookDeployed() ? dt : -dt)));
            if (progress <= 0) return;
            if (mesh == null) Build();
            Vec3d position = aircraft.GetPosition();
            Quatd q = aircraft.GetQuaternion();
            Vec3d hinge = hingeBody.Rotate(q) + position;
            Vec3d dir = (tipBody - hingeBody).Rotate(q);
            int latch = aircraft.ArrestorLatch;
            if (latch >= 0 && carrier != null)
            {
                // Colinear hinge, tip and sheave: arm and wire leg line up.
                Vec3d sheave = ArrestorCables.ArrestorCableStartWorld(latch, carrier);
                ArrestorCables.LatchedHookTipWorld(hinge, sheave, out dir, dir);
            }
            else
            {
                dir = dir.Normalized();
            }
            Quatd turn = Quatd.FromUnitVectors(SceneAxes.Forward, dir);
            double deploy = progress / AnimDurationS;
            if (deploy < 1)
            {
                // Stowed, the arm lies flush aft along the belly and swings down from there.
                Quatd stowed = Quatd.FromUnitVectors(SceneAxes.Forward, new Vec3d(0, 0, -1).Rotate(q));
                turn = Quatd.Slerp(stowed, turn, deploy);
            }
            Matrix4x4 m = SceneFrame.TileMatrix(hinge, camera, turn, 1);
            Graphics.RenderMesh(new RenderParams(black) { shadowCastingMode = ShadowCastingMode.Off }, mesh, 0, m);
            Graphics.RenderMesh(new RenderParams(white) { shadowCastingMode = ShadowCastingMode.Off }, mesh, 1, m);
        }

        public void Dispose()
        {
            if (mesh != null) UnityEngine.Object.Destroy(mesh);
            if (black != null) UnityEngine.Object.Destroy(black);
            if (white != null) UnityEngine.Object.Destroy(white);
        }
    }
}

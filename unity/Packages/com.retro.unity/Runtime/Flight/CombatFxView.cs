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
    /// What hits and crashes leave in the air and on the ground (game.ts
    /// setupCombat's debrisField, impactMarks and damageSmoke, and their
    /// combatSim.onHits / onPoolMark / onBurnMark wiring) on the ported
    /// <see cref="DebrisField"/>, <see cref="ImpactMarks"/> and
    /// <see cref="DamageSmokeField"/>: chips and sparks, scorch and burn marks,
    /// and the smoke, fire, dust and spray puffs, all screen-dithered like the
    /// web game's.
    /// </summary>
    public sealed class CombatFxView : IDisposable
    {
        private const int Batch = 1023;

        public readonly DebrisField Debris;
        public readonly ImpactMarks Marks;
        public readonly DamageSmokeField Smoke;

        private readonly Func<double> random;
        private readonly Func<double, double, double> groundAt;
        private readonly Func<double, double, SmokeSurfaceKind> surfaceAt;

        private Mesh hexagon, blob, chip, spark;
        private Material dither;
        private Material[] chipMaterials, sparkMaterials;
        private readonly Matrix4x4[] matrices = new Matrix4x4[Batch];
        private readonly Vector4[] tonesA = new Vector4[Batch];
        private readonly Vector4[] tonesB = new Vector4[Batch];
        private readonly float[] levels = new float[Batch];
        private readonly MaterialPropertyBlock block = new MaterialPropertyBlock();

        /// <param name="poseOf">The live pose of an aircraft by sim id, or null (damageSmoke's pose provider).</param>
        /// <param name="groundAt">The drawn ground: DEM, pads, the carrier deck.</param>
        /// <param name="isWater">Open sea: not land, not the deck, not a pad.</param>
        /// <param name="surfaceAt">game.ts surfaceKindAt: what dust a contact throws up.</param>
        public CombatFxView(Func<string, DamageSmokePose> poseOf, Func<double, double, double> groundAt,
            Func<double, double, bool> isWater, Func<double, double, SmokeSurfaceKind> surfaceAt, IMovingSurface deck)
        {
            random = Retro.Sim.Gun.Mulberry32((uint)Environment.TickCount);
            this.groundAt = groundAt;
            this.surfaceAt = surfaceAt;
            Debris = new DebrisField(random);
            Marks = new ImpactMarks(random);
            Marks.SetMovingSurface(deck);
            Smoke = new DamageSmokeField(random);
            Smoke.SetPoseProvider(poseOf);
            Smoke.SetGroundHeightAt(groundAt);
            Smoke.SetWaterTest(isWater);
            Smoke.SetMovingSurface(deck);
            Smoke.SurfaceAt = surfaceAt;
            // The lake of fire scorches the ground it spreads over; the fires burn marks under them.
            Smoke.OnPoolMark = (p, dirX, dirZ, length, width, _) => Marks.Add(p, NormalAt(p.X, p.Z), dirX, dirZ, length, width, 0.7);
            Smoke.OnBurnMark = (p, radius, strength, grow) =>
            {
                double heading = random() * Math.PI * 2;
                double size = radius * 2;
                Marks.AddBurn(p, NormalAt(p.X, p.Z), Math.Sin(heading), Math.Cos(heading),
                    size * (0.8 + 0.5 * random()), size, strength, grow);
            };
        }

        /// <summary>game.ts groundNormalAt: the drawn ground's slope by central differences over 2 m.</summary>
        public Vec3d NormalAt(double x, double z)
        {
            const double h = 2;
            double dx = -(groundAt(x + h, z) - groundAt(x - h, z)) / (2 * h);
            double dz = -(groundAt(x, z + h) - groundAt(x, z - h)) / (2 * h);
            return new Vec3d(dx, 1, dz).Normalized();
        }

        /// <summary>combatSim.onHits: gun and collision hits throw chips and smoke; scrapes spark (not on water) and puff.</summary>
        public void OnHits(IReadOnlyList<SimHitEvent> hits)
        {
            var gun = new List<SimHitEvent>();
            var scrapes = new List<SimHitEvent>();
            var dry = new List<SimHitEvent>();
            foreach (SimHitEvent h in hits)
            {
                if (h.Source == "scrape")
                {
                    scrapes.Add(h);
                    if (surfaceAt(h.Position[0], h.Position[2]) != SmokeSurfaceKind.Water) dry.Add(h);
                }
                else
                {
                    gun.Add(h);
                }
            }
            if (gun.Count > 0)
            {
                Debris.SpawnFromHits(gun);
                Smoke.SpawnFromHits(gun);
            }
            if (scrapes.Count > 0)
            {
                Smoke.SpawnGroundScrapes(scrapes);
                Debris.SpawnGroundScrapes(dry);
            }
        }

        public void Update(double dt)
        {
            if (dt <= 0) return;
            Debris.Update(dt);
            Marks.Update(dt);
            Smoke.Update(dt);
        }

        /// <summary>A respawn: the sky and the ground are clean again.</summary>
        public void Reset()
        {
            Smoke.Reset();
            Marks.Clear();
        }

        private void Build()
        {
            hexagon = new Mesh { name = "smoke puff" };
            var hv = new List<Vector3> { Vector3.zero };
            var hi = new List<int>();
            // three.js CircleGeometry(1, 6): the centre, then 7 rim points (the last closing the ring).
            for (int i = 0; i <= 6; i++)
            {
                float a = i * Mathf.PI * 2 / 6;
                hv.Add(new Vector3(Mathf.Cos(a), Mathf.Sin(a), 0));
            }
            for (int i = 1; i <= 6; i++)
            {
                hi.Add(0);
                hi.Add(i);
                hi.Add(i + 1);
            }
            hexagon.SetVertices(hv);
            hexagon.SetTriangles(hi, 0);
            blob = FromArrays("impact mark", ImpactMarks.BlobPositions, ImpactMarks.BlobIndices);
            chip = FromArrays("debris chip", DebrisField.ChipPositions, DebrisField.ChipIndices);
            spark = FromArrays("spark", DebrisField.SparkPositions, DebrisField.SparkIndices);
            foreach (Mesh m in new[] { hexagon, blob, chip, spark }) m.bounds = new Bounds(Vector3.zero, Vector3.one * 1e6f);

            dither = new Material(Shader.Find("Retro/DitherInstanced")) { name = "dither puffs", enableInstancing = true };
            chipMaterials = new Material[DebrisField.ChipCount];
            sparkMaterials = new Material[DebrisField.SparkCount];
            for (int i = 0; i < chipMaterials.Length; i++) chipMaterials[i] = Unlit(DebrisField.ChipCategory(i), DebrisField.ChipCategory(i));
            for (int i = 0; i < sparkMaterials.Length; i++)
            {
                PaletteCategory c = DebrisField.SparkCategory(i);
                // Fire is a steady two-tone stipple, orange and yellow.
                sparkMaterials[i] = Unlit(c, c == PaletteCategory.FX_FIRE ? PaletteCategory.FX_FIRE__B : c);
            }
        }

        private static Mesh FromArrays(string name, float[] positions, ushort[] indices)
        {
            var v = new Vector3[positions.Length / 3];
            for (int i = 0; i < v.Length; i++) v[i] = new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
            var idx = new int[indices.Length];
            for (int i = 0; i < idx.Length; i++) idx[i] = indices[i];
            var m = new Mesh { name = name };
            m.SetVertices(v);
            m.SetUVs(0, new Vector2[v.Length]);
            m.SetTriangles(idx, 0);
            return m;
        }

        private static readonly Dictionary<(PaletteCategory, PaletteCategory), Material> unlitCache = new Dictionary<(PaletteCategory, PaletteCategory), Material>();

        /// <summary>The unlit two-tone material (CloudSky's dithered pass at opacity 1), one per palette pair.</summary>
        private static Material Unlit(PaletteCategory a, PaletteCategory b)
        {
            if (unlitCache.TryGetValue((a, b), out Material m) && m != null) return m;
            m = new Material(Shader.Find("Retro/CloudSky")) { name = "debris " + a };
            m.EnableKeyword("_HAZE");
            m.SetFloat("_Haze", 1);
            m.SetFloat("_ZWrite", 0);
            m.SetFloat("_Cull", (float)CullMode.Off);
            ScenePalette.Bind(m, "_Color", a);
            ScenePalette.Bind(m, "_ColorShade", b);
            unlitCache[(a, b)] = m;
            return m;
        }

        public void Draw(Vec3d camera, Palette palette)
        {
            if (hexagon == null) Build();
            DrawDebris(Debris.Chips, chipMaterials, chip, camera);
            DrawDebris(Debris.Sparks, sparkMaterials, spark, camera);
            Color shadow = ScenePalette.Tone(PaletteCategory.SCENERY_TREE_SHADOW).linear;
            DrawMarks(Marks.Impact, shadow, camera);
            DrawMarks(Marks.Burn, shadow, camera);
            Smoke.SyncPuffs(camera, palette);
            DrawPuffs(camera);
        }

        private static void DrawDebris(DebrisInstance[] instances, Material[] materials, Mesh mesh, Vec3d camera)
        {
            for (int i = 0; i < instances.Length; i++)
            {
                DebrisInstance d = instances[i];
                if (!d.Visible) continue;
                Matrix4x4 m = SceneFrame.TileMatrix(d.Position, camera, d.Quaternion, 1)
                    * Matrix4x4.Scale(new Vector3((float)d.Scale.X, (float)d.Scale.Y, (float)d.Scale.Z));
                Graphics.RenderMesh(new RenderParams(materials[i]) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false }, mesh, 0, m);
            }
        }

        /// <summary>A pool's instance matrices (three.js, scene frame) made camera-relative and mirrored, with its levels.</summary>
        private void DrawMarks(MarkPool pool, Color colour, Vec3d camera)
        {
            if (!pool.Visible || pool.Count == 0) return;
            var tone = new Vector4(colour.r, colour.g, colour.b, 1);
            int n = 0;
            for (int i = 0; i < pool.Count; i++)
            {
                int o = i * 16;
                float[] e = pool.Matrices;
                var m = new Matrix4x4();
                m.SetColumn(0, new Vector4(e[o], e[o + 1], -e[o + 2], 0));
                m.SetColumn(1, new Vector4(e[o + 4], e[o + 5], -e[o + 6], 0));
                m.SetColumn(2, new Vector4(e[o + 8], e[o + 9], -e[o + 10], 0));
                m.SetColumn(3, new Vector4((float)(e[o + 12] - camera.X), (float)(e[o + 13] - camera.Y), (float)-(e[o + 14] - camera.Z), 1));
                matrices[n] = m;
                tonesA[n] = tonesB[n] = tone;
                levels[n] = pool.Levels[i];
                if (++n == Batch)
                {
                    Flush(blob, n);
                    n = 0;
                }
            }
            if (n > 0) Flush(blob, n);
        }

        private void DrawPuffs(Vec3d camera)
        {
            int n = 0;
            for (int i = 0; i < Smoke.InstanceCount; i++)
            {
                matrices[n] = SceneFrame.TileMatrix(Smoke.InstancePositions[i], camera, Smoke.InstanceRotations[i], Smoke.InstanceSizes[i]);
                tonesA[n] = new Vector4(Smoke.ToneA[i * 3], Smoke.ToneA[i * 3 + 1], Smoke.ToneA[i * 3 + 2], 1);
                tonesB[n] = new Vector4(Smoke.ToneB[i * 3], Smoke.ToneB[i * 3 + 1], Smoke.ToneB[i * 3 + 2], 1);
                levels[n] = Smoke.DitherLevels[i];
                if (++n == Batch)
                {
                    Flush(hexagon, n);
                    n = 0;
                }
            }
            if (n > 0) Flush(hexagon, n);
        }

        private void Flush(Mesh mesh, int count)
        {
            block.Clear();
            block.SetVectorArray("_ToneA", tonesA);
            block.SetVectorArray("_ToneB", tonesB);
            block.SetFloatArray("_Level", levels);
            var rp = new RenderParams(dither)
            {
                matProps = block,
                shadowCastingMode = ShadowCastingMode.Off,
                receiveShadows = false,
                worldBounds = new Bounds(Vector3.zero, Vector3.one * 1e7f),
            };
            Graphics.RenderMeshInstanced(rp, mesh, 0, matrices, count);
        }

        public void Dispose()
        {
            foreach (UnityEngine.Object o in new UnityEngine.Object[] { hexagon, blob, chip, spark, dither })
            {
                if (o != null) UnityEngine.Object.Destroy(o);
            }
        }
    }
}

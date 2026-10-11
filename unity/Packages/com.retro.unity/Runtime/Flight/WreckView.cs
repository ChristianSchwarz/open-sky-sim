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
    /// Crashes (game.ts setupCombat's wreckField and its callbacks, the
    /// entities' WreckTracker) on the ported <see cref="WreckField"/>: on the
    /// frame an aircraft first reads as crashed it is taken apart into pieces
    /// that tumble, slide, burn, sink at sea or ride the carrier deck, while
    /// its own airframe is hidden; the break-up throws debris, a fireball,
    /// a lake of burning fuel or a splash, dust and fires that ride the
    /// pieces, all through <see cref="CombatFxView"/>. Pieces are drawn with
    /// the airframe's own materials.
    /// </summary>
    public sealed class WreckView : IDisposable
    {
        // game.ts fire lives and smoulders (s).
        private const double FuselageFireLifeS = 200, FuselageSmoulderS = 240;
        private const double WingRootFireLifeS = 60, WingRootSmoulderS = 80;

        public readonly WreckField Field;
        private readonly CombatFxView fx;
        private readonly Func<double> random;
        private readonly Dictionary<WreckFragment, List<(Mesh Mesh, Material Material)>> meshes =
            new Dictionary<WreckFragment, List<(Mesh, Material)>>();
        private readonly Dictionary<string, WreckTracker> trackers = new Dictionary<string, WreckTracker>();

        public WreckView(CombatFxView fx, Func<double, double, double> groundAt, Func<double, double, bool> isOpenWater,
            Func<double, double, double> seaSurface, IWreckMovingSurface deck)
        {
            this.fx = fx;
            random = Retro.Sim.Gun.Mulberry32((uint)Environment.TickCount ^ 0x5eed);
            Field = new WreckField(random);
            Field.SetGroundHeightAt(groundAt);
            Field.SetWaterTest(isOpenWater, seaSurface);
            Field.SetMovingSurface(deck);
            Field.FragmentAdded += Add;
            Field.FragmentRemoved += Remove;
            Field.OnBreakup = Breakup;
            Field.OnMark = (p, n, dirX, dirZ, length, width, strength) => fx.Marks.Add(p, n, dirX, dirZ, length, width, strength);
            Field.OnBurn = (p, life, intensity) => fx.Smoke.AddBurnSpot(p, life, intensity);
            Field.OnSplit = (p, v, strength) =>
            {
                // A piece shattering on the ground: a spray of chips and a puff of dust.
                fx.Debris.SpawnDebugBurst(p, v);
                fx.Smoke.SpawnDust(p, v, (int)Math.Round(10 + 15 * strength), strength * 0.8);
            };
            Field.OnDust = (p, v, count, strength) => fx.Smoke.SpawnDust(p, v, count, strength * 0.6);
            Field.OnSplash = (p, v, strength) => fx.Smoke.SpawnSplash(p, strength);
            Field.OnFoam = (p, radius, count) => fx.Smoke.SpawnFoam(p, radius, count);
        }

        /// <summary>game.ts onBreakup: bursts by severity, the fireball, the fuel (lake or splash), dust, and fires on the pieces.</summary>
        private void Breakup(WreckEvent e)
        {
            int bursts = 1 + (int)Math.Round(e.Severity * 3);
            for (int i = 0; i < bursts; i++)
            {
                var at = new Vec3d(e.Position.X + (random() - 0.5) * 6, e.Position.Y + random() * 3, e.Position.Z + (random() - 0.5) * 6);
                fx.Debris.SpawnDebugBurst(at, e.Velocity);
            }
            fx.Smoke.SpawnFireball(e.Position, e.Velocity, e.Severity);
            if (!e.Water) fx.Smoke.AddFirePool(e.Position, e.Velocity, e.Severity);
            if (e.Water) fx.Smoke.SpawnSplash(e.Position, e.Severity * 1.3);
            else fx.Smoke.SpawnDust(e.Position, e.Velocity, (int)Math.Round(25 + 45 * e.Severity), e.Severity);
            foreach (WreckFire fire in e.Fires)
            {
                WreckFire f = fire;
                bool Where(out Vec3d w) => Field.FireWorld(f, out w);
                switch (fire.Kind)
                {
                    case WreckFireKind.Brand:
                        // A burning shard flung clear: a short, fierce fire that rides on it.
                        fx.Smoke.AddAnchoredFire(e.Id, Where, 26, 8 + random() * 14, true, 14, 0);
                        break;
                    case WreckFireKind.Fuselage:
                        fx.Smoke.AddAnchoredFire(e.Id, Where, 44, FuselageFireLifeS, false, FuselageSmoulderS, 9);
                        break;
                    default:
                        fx.Smoke.AddAnchoredFire(e.Id, Where, 15, WingRootFireLifeS, true, WingRootSmoulderS, 3);
                        break;
                }
            }
        }

        /// <summary>
        /// Once a frame per aircraft (the entities' wreck.update): on the crash edge the airframe
        /// is taken apart. True while it is shown as a wreck, so its own model stays hidden.
        /// </summary>
        public bool Track(string id, SimAircraft a, AircraftView view)
        {
            if (!trackers.TryGetValue(id, out WreckTracker t))
            {
                t = new WreckTracker { Field = Field };
                trackers[id] = t;
            }
            Vec3d? before = t.Sample(a.IsCrashed(), a.GetVelocity());
            if (before.HasValue)
            {
                WreckSource src = view.WreckSource(id, before.Value);
                if (src != null && Field.Spawn(src)) t.Shown = true;
            }
            return t.Shown;
        }

        public void Update(double dt)
        {
            if (dt > 0) Field.Update(Math.Min(dt, 1.0 / 30));
        }

        /// <summary>A respawn: the pieces go.</summary>
        public void Clear()
        {
            Field.Clear();
            foreach (WreckTracker t in trackers.Values) t.Shown = false;
        }

        /// <summary>A new piece's meshes, once: scene-frame soup, wound for the mirrored draw.</summary>
        private void Add(WreckFragment f)
        {
            var list = new List<(Mesh, Material)>();
            foreach (WreckMeshData d in f.Meshes)
            {
                int n = d.VertexCount;
                var v = new Vector3[n];
                var nm = d.Normal != null ? new Vector3[n] : null;
                var idx = new int[n];
                for (int i = 0; i < n; i++)
                {
                    v[i] = new Vector3(d.Position[i * 3], d.Position[i * 3 + 1], d.Position[i * 3 + 2]);
                    if (nm != null) nm[i] = new Vector3(d.Normal[i * 3], d.Normal[i * 3 + 1], d.Normal[i * 3 + 2]);
                }
                // Scene-CCW faces show their backs under the z mirror: turn each triangle round.
                for (int i = 0; i + 2 < n; i += 3)
                {
                    idx[i] = i;
                    idx[i + 1] = i + 2;
                    idx[i + 2] = i + 1;
                }
                var mesh = new Mesh { name = "wreck piece", indexFormat = n > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
                mesh.SetVertices(v);
                if (nm != null) mesh.SetNormals(nm);
                else mesh.RecalculateNormals();
                mesh.SetTriangles(idx, 0);
                mesh.RecalculateBounds();
                list.Add((mesh, d.Material as Material));
            }
            meshes[f] = list;
        }

        private void Remove(WreckFragment f)
        {
            if (!meshes.TryGetValue(f, out List<(Mesh, Material)> list)) return;
            foreach ((Mesh m, _) in list) UnityEngine.Object.Destroy(m);
            meshes.Remove(f);
        }

        public void Draw(Vec3d camera)
        {
            foreach (WreckFragment f in Field.Fragments)
            {
                if (!f.Visible || !meshes.TryGetValue(f, out List<(Mesh Mesh, Material Material)> list)) continue;
                Matrix4x4 m = SceneFrame.TileMatrix(f.Position, camera, f.Quaternion, 1);
                foreach ((Mesh mesh, Material mat) in list)
                {
                    if (mat == null) continue;
                    Graphics.RenderMesh(new RenderParams(mat) { shadowCastingMode = ShadowCastingMode.On, receiveShadows = true }, mesh, 0, m);
                }
            }
        }

        public void Dispose()
        {
            foreach (List<(Mesh Mesh, Material Material)> list in meshes.Values)
            {
                foreach ((Mesh m, _) in list) UnityEngine.Object.Destroy(m);
            }
            meshes.Clear();
        }
    }
}

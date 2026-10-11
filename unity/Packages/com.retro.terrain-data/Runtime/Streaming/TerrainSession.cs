using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>What a session needs from the manifest (the engine layer parses the JSON).</summary>
    public sealed class TerrainSessionOptions
    {
        /// <summary>Folder holding {z}/{x}/{y}.ptm and index_mesh.bin.</summary>
        public string Root;
        public double[] LevelGeometricErrorM;
        public int MaxZoom;
        /// <summary>manifest.enuOrigin: the frame the tiles were baked in.</summary>
        public double BakeLat, BakeLon, BakeHeight;
        /// <summary>The frame the scene is drawn in (the play-area origin).</summary>
        public double OriginLat, OriginLon, OriginHeight;
        public long MeshCacheBytes = Lod.MeshCacheBytes;
        public int MaxConcurrentLoads = 8;
        /// <summary>TERRAIN_TRIANGLE_BUDGET: the cut is folded, then capped, to fit this.</summary>
        public int TriangleBudget = Lod.TerrainTriangleBudget;
    }

    /// <summary>One tile to draw this frame, placed in scene space (x east, y up, z south).</summary>
    public struct DrawTile
    {
        public TileKey Key;
        public PtmTile Tile;
        /// <summary>Scene position of the tile frame's origin.</summary>
        public Vec3d Origin;
        /// <summary>Rotation from the bake frame's axes into the scene's (identity when they share an origin).</summary>
        public Quatd FrameFix;
        /// <summary>Drawn as a dissolving parent under its leaves.</summary>
        public bool Under;
        /// <summary>The leaf dissolve's switch distance (0 = opaque) and when its time ramp started.</summary>
        public double FadeM;
        public double FadeFromMs;
        /// <summary>How far an under-parent is pushed back (geometricErrorM * LOD_DEPTH_PUSH_SCALE), metres.</summary>
        public double PushM;
    }

    /// <summary>Per-frame view parameters for <see cref="TerrainSession.Update"/>.</summary>
    public struct TerrainView
    {
        /// <summary>Camera position in scene metres (double).</summary>
        public Vec3d Position;
        /// <summary>three.js camera convention: looks down -Z of its own frame.</summary>
        public Quatd Orientation;
        public double FovYDeg;
        public double Aspect;
        public double ScreenHeightPx;
        public double Near;
        public double DetailScale;
        public double DetailDistanceM;
        public double LeafScale;
        public double VisibleZoomCap;
        public double NowMs;
    }

    /// <summary>
    /// The terrain's engine-free core for the Unity spike: tile index, decoded
    /// tile cache, the verified quadtree, and per-tile placement. The engine
    /// layer uploads meshes for tiles as they load, reports which are uploaded,
    /// and draws the returned list.
    /// </summary>
    public sealed class TerrainSession
    {
        public readonly EnuBasis Basis;
        public readonly EnuBasis BakeBasis;
        public readonly Quatd FrameFix;
        public readonly TileIndex MeshIndex;
        public readonly TileCache<PtmTile> Meshes;
        public readonly Quadtree Quadtree;

        private readonly TerrainSessionOptions opts;
        private readonly List<QuadNode> draw = new List<QuadNode>();
        private readonly List<TileWant> wants = new List<TileWant>();

        /// <summary>The engine layer's answer to "is this tile's mesh on the GPU"; defaults to "decoded".</summary>
        public Func<TileKey, bool> IsUploaded;

        public readonly List<DrawTile> DrawList = new List<DrawTile>();
        public int WantCount => wants.Count;

        /// <summary>Triangle budget for the drawn cut (settable at runtime, like the Graphics slider).</summary>
        public int TriangleBudget;
        /// <summary>Tiles folded into their parents by the last reconcile.</summary>
        public int CoarsenedTiles { get; private set; }
        /// <summary>The last-resort cap cut the far edge of the list (the fold's parents were not resident).</summary>
        public bool TriangleBudgetHit { get; private set; }
        /// <summary>Triangles in the draw list (land at near cost, water, ocean stand-ins).</summary>
        public int DrawnTriangles { get; private set; }

        /// <summary>What a sea stand-in costs the budget (OCEAN_PATCH_TRIANGLES).</summary>
        private const int OceanPatchTriangles = 10;

        public TerrainSession(TerrainSessionOptions opts)
        {
            this.opts = opts;
            TriangleBudget = opts.TriangleBudget;
            Basis =Geodesy.MakeEnuBasis(opts.OriginLat, opts.OriginLon, opts.OriginHeight);
            BakeBasis = Geodesy.MakeEnuBasis(opts.BakeLat, opts.BakeLon, opts.BakeHeight);
            FrameFix = Geodesy.EnuFrameRotation(BakeBasis, Basis);
            MeshIndex = TileIndex.Decode(File.ReadAllBytes(Path.Combine(opts.Root, "index_mesh.bin")));
            Meshes = new TileCache<PtmTile>(
                k => Path.Combine(opts.Root, k.Z.ToString(), k.X.ToString(), k.Y + ".ptm"),
                bytes => PtmCodec.Decode(TileFile.Inflate(bytes)),
                t => (long)t.LandPositions.Length * 2 + t.LandNormals.Length + t.LandAttrs.Length
                    + t.WaterPositions.Length * 2 + t.WaterIndices.Length * 2 + 256,
                opts.MeshCacheBytes, opts.MaxConcurrentLoads);
            IsUploaded = k => Meshes.Has(k);
            Quadtree = new Quadtree(new QuadtreeOptions
            {
                LevelGeometricErrorM = opts.LevelGeometricErrorM,
                MaxZoom = opts.MaxZoom,
                TilePosition = id => TileOrigin(id, 0),
                TileRadius = id => Tiling.ApproxEdgeMetres(id) * 0.75,
                IsResident = id => IsUploaded(id),
                IsOcean = id => !MeshIndex.Has(id) || Meshes.IsAbsent(id),
                TileErrorM = id =>
                {
                    PtmTile t = Meshes.Peek(id);
                    return t == null ? (double?)null : t.GeometricErrorM;
                },
                EarthCenter = Geodesy.SceneFromEnu(Geodesy.EcefToEnu(Basis, Vec3d.Zero)),
            });
        }

        /// <summary>tileOriginWorld: the lon/lat midpoint of the tile at a height, in scene space.</summary>
        public Vec3d TileOrigin(TileKey id, double centerHeightM)
        {
            LonLatBounds b = Tiling.Bounds(id);
            return Geodesy.GeodeticToWorld(Basis, (b.South + b.North) / 2, (b.West + b.East) / 2, centerHeightM);
        }

        /// <summary>One reconcile: walk the quadtree, queue loads, pump the cache, build the draw list.</summary>
        public void Update(TerrainView view)
        {
            double far = Lod.CameraFarForAltitudeM(view.Position.Y);
            CameraFrustum frustum = CameraFrustum.FromCamera(view.Position, view.Orientation, view.FovYDeg, view.Aspect,
                view.Near > 0 ? view.Near : 2, far);
            Meshes.NextGeneration();
            Quadtree.Update(view.Position, frustum, view.ScreenHeightPx, view.FovYDeg,
                view.DetailScale > 0 ? view.DetailScale : 1,
                view.DetailDistanceM > 0 ? view.DetailDistanceM : Lod.TerrainDetailDistanceDefaultM, null,
                view.LeafScale > 0 ? view.LeafScale : Lod.LeafRefineDistanceScale, view.NowMs,
                view.VisibleZoomCap > 0 ? view.VisibleZoomCap : double.PositiveInfinity, draw, wants);

            List<QuadNode> cut = CoarsenToBudget(draw, view.Position, wants);

            var wantList = new List<(TileKey, double)>(wants.Count);
            foreach (TileWant w in wants)
            {
                // tileStreamer.ts scoring: in-frustum first, then error over distance.
                double score = (w.Pinned ? 1e9 : 0) + (w.InFrustum ? 1e6 : 0) + w.SsePx / (1 + w.DistanceM / 1000);
                wantList.Add((w.Id, score));
            }
            Meshes.SetWants(wantList);
            Meshes.Pump();

            // Last resort (syncGroup): nearest edge first, stop at the budget, so
            // whatever the fold could not fit goes missing at the far edge.
            cut.Sort((a, b) => NearM(a, view.Position).CompareTo(NearM(b, view.Position)));
            DrawList.Clear();
            DrawnTriangles = 0;
            TriangleBudgetHit = false;
            foreach (QuadNode n in cut)
            {
                if (n.Ocean) continue;
                PtmTile tile = Meshes.Get(n.Id);
                if (tile == null) continue;
                if (DrawnTriangles >= TriangleBudget)
                {
                    TriangleBudgetHit = true;
                    break;
                }
                DrawnTriangles += TileTriangles(tile) + Extra(n.Id);
                DrawList.Add(new DrawTile
                {
                    Key = n.Id,
                    Tile = tile,
                    Origin = TileOrigin(n.Id, tile.CenterHeightM),
                    FrameFix = FrameFix,
                    Under = n.Under,
                    FadeM = n.FadeM,
                    FadeFromMs = n.FadeFromMs,
                    PushM = n.Under ? tile.GeometricErrorM * Lod.LodDepthPushScale : 0,
                });
            }
        }

        private static double NearM(QuadNode n, Vec3d cam) => Math.Max(0, Vec3d.Distance(n.Center, cam) - n.Radius);

        /// <summary>Land and water triangles of a tile (countTriangles(asNear = true)).</summary>
        public static int TileTriangles(PtmTile t) => t.LandPositions.Length / 9 + t.WaterIndices.Length / 3;

        /// <summary>
        /// What else a tile costs the budget once its sidecars are attached
        /// (terrainEntity.ts tileTriangles: roads at full detail by the roads
        /// setting, every bridge triangle). Null charges nothing.
        /// </summary>
        public Func<TileKey, int> ExtraTriangles;

        private int Extra(TileKey id) => ExtraTriangles != null ? ExtraTriangles(id) : 0;

        private int Cost(QuadNode node)
        {
            PtmTile t = IsUploaded(node.Id) ? Meshes.Peek(node.Id) : null;
            return t != null ? TileTriangles(t) + Extra(node.Id) : OceanPatchTriangles;
        }

        /// <summary>
        /// Fold the cut into coarser tiles, farthest first, until it fits the
        /// triangle budget (terrainEntity.ts coarsenToBudget). A parent with a
        /// grandchild or deeper in the cut cannot take over; a parent that is not
        /// resident is asked for (added to `wants`) so the next reconcile can fold
        /// into it. The result is still a valid quadtree cut.
        /// </summary>
        private List<QuadNode> CoarsenToBudget(List<QuadNode> drawn, Vec3d camPos, List<TileWant> wantsOut)
        {
            CoarsenedTiles = 0;
            int total = 0;
            var cut = new Dictionary<string, QuadNode>();
            var cutOrder = new List<string>();
            var under = new Dictionary<string, QuadNode>();
            foreach (QuadNode node in drawn)
            {
                if (node.Under) under[node.Key] = node;
                else
                {
                    cut[node.Key] = node;
                    cutOrder.Add(node.Key);
                }
                total += Cost(node);
            }
            if (total <= TriangleBudget) return new List<QuadNode>(drawn);

            var asked = new HashSet<string>();
            while (total > TriangleBudget)
            {
                var deep = new HashSet<string>();
                var parents = new Dictionary<string, TileKey>();
                var parentOrder = new List<string>();
                foreach (QuadNode node in cut.Values)
                {
                    TileKey? id = Tiling.Parent(node.Id);
                    if (id == null) continue;
                    string pk = id.Value.ToString();
                    if (!parents.ContainsKey(pk))
                    {
                        parents[pk] = id.Value;
                        parentOrder.Add(pk);
                    }
                    for (id = Tiling.Parent(id.Value); id != null; id = Tiling.Parent(id.Value))
                    {
                        if (!deep.Add(id.Value.ToString())) break;
                    }
                }
                var candidates = new List<(string Key, QuadNode Node, double Distance)>();
                foreach (string key in parentOrder)
                {
                    if (deep.Contains(key)) continue;
                    QuadNode node = Quadtree.Node(key);
                    if (node == null) continue;
                    if (!IsUploaded(node.Id) && !node.Ocean)
                    {
                        if (asked.Add(key))
                        {
                            wantsOut.Add(new TileWant
                            {
                                Id = node.Id,
                                SsePx = node.GeometricErrorM,
                                DistanceM = Math.Max(1, Vec3d.Distance(camPos, node.Center) - node.Radius),
                                InFrustum = true,
                                Pinned = false,
                            });
                        }
                        continue;
                    }
                    candidates.Add((key, node, Vec3d.Distance(camPos, node.Center) - node.Radius));
                }
                if (candidates.Count == 0) break;
                // Stable sort, farthest first (Array.prototype.sort is stable).
                candidates = candidates.Select((c, i) => (c, i)).OrderByDescending(t => t.c.Distance).ThenBy(t => t.i).Select(t => t.c).ToList();
                foreach (var (key, node, _) in candidates)
                {
                    if (total <= TriangleBudget) break;
                    if (node.Children != null)
                    {
                        foreach (QuadNode child in node.Children)
                        {
                            if (cut.TryGetValue(child.Key, out QuadNode c))
                            {
                                cut.Remove(child.Key);
                                total -= Cost(c);
                            }
                        }
                    }
                    if (under.ContainsKey(key)) under.Remove(key);
                    else total += Cost(node);
                    node.Under = false;
                    cut[key] = node;
                    CoarsenedTiles++;
                }
            }
            var output = new List<QuadNode>(cut.Values);
            foreach (QuadNode node in under.Values)
            {
                if (node.Children != null && node.Children.Any(c => cut.ContainsKey(c.Key))) output.Add(node);
            }
            return output;
        }
    }
}

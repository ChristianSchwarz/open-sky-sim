using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>One node of the geographic quadtree: a tile and its bookkeeping (quadtree.ts QuadNode).</summary>
    public sealed class QuadNode
    {
        public TileKey Id;
        public string Key;
        public QuadNode[] Children;
        /// <summary>Scene position of the tile centre (rebased with the world).</summary>
        public Vec3d Center;
        public double Radius;
        /// <summary>The tile's own header error once resident, the level's before that.</summary>
        public double GeometricErrorM;
        public bool ErrorFromTile;
        public bool Resident;
        public bool Ocean;
        public long LastSeen;
        /// <summary>Drawn as a dissolving parent under its leaves this pass.</summary>
        public bool Under;
        /// <summary>The leaf dissolve's switch distance, set by the parent; 0 = opaque.</summary>
        public double FadeM;
        public double FadeFromMs;
        public double? TakeoverAt;
        public bool? Dissolving;
    }

    /// <summary>A tile the walk would draw but does not have yet.</summary>
    public struct TileWant
    {
        public TileKey Id;
        public double SsePx;
        public double DistanceM;
        public bool InFrustum;
        public bool Pinned;
    }

    public sealed class QuadtreeOptions
    {
        /// <summary>manifest.mesh.levelGeometricErrorM.</summary>
        public double[] LevelGeometricErrorM;
        public int MaxZoom;
        public Func<TileKey, Vec3d> TilePosition;
        public Func<TileKey, double> TileRadius;
        /// <summary>Uploaded geometry only; a sea stand-in never counts.</summary>
        public Func<TileKey, bool> IsResident;
        /// <summary>The index says there is no tile: drawn as an ellipsoid patch.</summary>
        public Func<TileKey, bool> IsOcean;
        /// <summary>A resident tile's own header error, or null.</summary>
        public Func<TileKey, double?> TileErrorM;
        public Vec3d EarthCenter;
    }

    /// <summary>
    /// Walks the planet quadtree for one camera and produces the draw list and
    /// the want set (port of src/script/terrain/quadtree.ts). Mutates only node
    /// bookkeeping; geometry is the caller's.
    /// </summary>
    public sealed class Quadtree
    {
        private readonly QuadtreeOptions opts;
        private readonly QuadNode[] roots;
        private readonly Dictionary<string, QuadNode> nodes = new Dictionary<string, QuadNode>();
        private readonly int maxZoom;
        private long generation;

        public Quadtree(QuadtreeOptions opts)
        {
            this.opts = opts;
            maxZoom = opts.MaxZoom;
            TileKey[] r = Tiling.RootTiles();
            roots = new[] { MakeNode(r[0]), MakeNode(r[1]) };
        }

        public Vec3d EarthCenter => opts.EarthCenter;

        public void Rebase(FrameShift shift)
        {
            foreach (QuadNode node in nodes.Values) node.Center = shift.Point(node.Center);
            opts.EarthCenter = shift.Point(opts.EarthCenter);
        }

        private QuadNode MakeNode(TileKey id)
        {
            string key = id.ToString();
            if (nodes.TryGetValue(key, out QuadNode existing)) return existing;
            double[] levels = opts.LevelGeometricErrorM;
            bool hasLevel = levels != null && id.Z < levels.Length;
            double levelErr = hasLevel ? levels[id.Z] : 0;
            var node = new QuadNode
            {
                Id = id,
                Key = key,
                Center = opts.TilePosition(id),
                Radius = opts.TileRadius(id),
                GeometricErrorM = hasLevel && levelErr > 0 ? levelErr : Lod.EllipsoidSagittaM(id),
            };
            nodes[key] = node;
            return node;
        }

        /// <summary>
        /// The error that drives refinement: the sagitta for an ocean stand-in if
        /// that is larger, inflated by leafScale one level above the leaf.
        /// </summary>
        private double DrawErrorM(QuadNode node, double leafScale)
        {
            double err = node.Ocean ? Math.Max(node.GeometricErrorM, Lod.EllipsoidSagittaM(node.Id)) : node.GeometricErrorM;
            return node.Id.Z == maxZoom - 1 ? err * leafScale : err;
        }

        public int NodeCount => nodes.Count;

        public QuadNode Node(string key) => nodes.TryGetValue(key, out QuadNode n) ? n : null;

        /// <summary>
        /// Walk the tree for one camera. `cameraPosition` is in scene metres and its
        /// Y is the altitude used by the caps (as the TS uses camera.position.y).
        /// </summary>
        public void Update(
            Vec3d cameraPosition,
            CameraFrustum frustum,
            double screenHeightPx,
            double fovYDeg,
            double detailScale,
            double detailDistanceM,
            Func<TileKey, bool> pinned,
            double leafScale,
            double nowMs,
            double visibleZoomCap,
            List<QuadNode> draw,
            List<TileWant> wants)
        {
            generation++;
            draw.Clear();
            wants.Clear();
            double altitude = cameraPosition.Y;
            double range = Lod.TerrainViewRangeM(altitude);
            double zoomCap = Math.Min(Math.Min(maxZoom, visibleZoomCap), Lod.TerrainMaxZoomForAltitudeM(altitude, maxZoom, true));
            foreach (QuadNode root in roots)
            {
                Visit(root, cameraPosition, frustum, range, zoomCap, screenHeightPx, fovYDeg, detailScale,
                    detailDistanceM, pinned, leafScale, nowMs, draw, wants);
            }
        }

        private void Visit(QuadNode node, Vec3d camPos, CameraFrustum frustum, double range, double zoomCap,
            double screenHeightPx, double fovYDeg, double detailScale, double detailDistanceM,
            Func<TileKey, bool> pinned, double leafScale, double nowMs, List<QuadNode> draw, List<TileWant> wants)
        {
            node.LastSeen = generation;
            // FadeM is not reset here: a leaf's parent sets it just before visiting the leaf.
            node.Under = false;
            node.Resident = opts.IsResident(node.Id);
            node.Ocean = opts.IsOcean(node.Id);
            if (node.Resident && !node.ErrorFromTile && opts.TileErrorM != null)
            {
                double? own = opts.TileErrorM(node.Id);
                if (own.HasValue && own.Value >= 0)
                {
                    node.GeometricErrorM = own.Value;
                    node.ErrorFromTile = true;
                }
            }

            Vec3d center = node.Center;
            double centreDist = Vec3d.Distance(camPos, center);
            double distance = centreDist - node.Radius;
            if (distance > range) return;
            // A frustum widened by one reconcile's worth of rotation, so a fast turn
            // does not sweep past tiles that were dropped a moment ago.
            double margin = centreDist * Lod.FrustumCullMarginTan;
            if (!frustum.IntersectsSphere(center, node.Radius + margin)) return;
            if (Culling.BehindHorizon(center, node.Radius, camPos, opts.EarthCenter, Geodesy.Wgs84A)) return;

            double d = Math.Max(1, distance);
            // The far-field falloff rides on the governor's scale; the ocean sagitta
            // bound ignores both, because an under-refined sea is in the wrong place.
            double farScale = detailScale * Lod.DetailFalloff(d, detailDistanceM);
            bool canRefine = node.Id.Z < zoomCap && (
                Lod.ShouldRefine(DrawErrorM(node, leafScale), d, screenHeightPx, fovYDeg, farScale)
                || node.Ocean && Lod.ShouldRefine(Lod.EllipsoidSagittaM(node.Id), d, screenHeightPx, fovYDeg, 1));

            if (!canRefine)
            {
                WantThis(node, distance, pinned, wants);
                draw.Add(node);
                node.TakeoverAt = null;
                return;
            }

            if (node.Children == null)
            {
                TileKey[] ids = Tiling.Children(node.Id);
                node.Children = new[] { MakeNode(ids[0]), MakeNode(ids[1]), MakeNode(ids[2]), MakeNode(ids[3]) };
            }

            // A parent stays drawn until every child can take over: no holes while loading.
            bool ready = true;
            foreach (QuadNode c in node.Children)
            {
                if (!(opts.IsResident(c.Id) || opts.IsOcean(c.Id)))
                {
                    ready = false;
                    break;
                }
            }
            if (!ready)
            {
                WantThis(node, distance, pinned, wants);
                draw.Add(node);
                node.TakeoverAt = null;
                foreach (QuadNode c in node.Children)
                {
                    c.LastSeen = generation;
                    if (!opts.IsOcean(c.Id) && !opts.IsResident(c.Id))
                    {
                        wants.Add(new TileWant
                        {
                            Id = c.Id,
                            SsePx = c.GeometricErrorM,
                            DistanceM = Math.Max(1, Vec3d.Distance(camPos, c.Center) - c.Radius),
                            InFrustum = true,
                            Pinned = pinned != null && pinned(c.Id),
                        });
                    }
                }
                return;
            }

            if (node.Id.Z == maxZoom - 1)
            {
                DissolveLeaves(node, centreDist, farScale, screenHeightPx, fovYDeg, leafScale, nowMs, draw);
            }

            foreach (QuadNode c in node.Children)
            {
                Visit(c, camPos, frustum, range, zoomCap, screenHeightPx, fovYDeg, detailScale, detailDistanceM,
                    pinned, leafScale, nowMs, draw, wants);
            }
        }

        private static void WantThis(QuadNode node, double distance, Func<TileKey, bool> pinned, List<TileWant> wants)
        {
            if (!node.Ocean && !node.Resident)
            {
                wants.Add(new TileWant
                {
                    Id = node.Id,
                    SsePx = node.GeometricErrorM,
                    DistanceM = Math.Max(1, distance),
                    InFrustum = true,
                    Pinned = pinned != null && pinned(node.Id),
                });
            }
        }

        /// <summary>
        /// The leaf parent's part in the leaf dissolve: hand the children the
        /// distance it refined at and stay drawn under them while any of their
        /// vertices can still be dithered away.
        /// </summary>
        private void DissolveLeaves(QuadNode node, double centreDist, double farScale, double screenHeightPx,
            double fovYDeg, double leafScale, double nowMs, List<QuadNode> draw)
        {
            if (node.TakeoverAt == null)
            {
                node.TakeoverAt = nowMs;
                node.Dissolving = node.Resident;
            }
            if (node.Dissolving != true || !node.Resident)
            {
                foreach (QuadNode c in node.Children) c.FadeM = 0;
                return;
            }
            double switchM = Lod.RefineDistanceM(DrawErrorM(node, leafScale), screenHeightPx, fovYDeg, farScale);
            double farVertexM = centreDist + node.Radius;
            bool stillDissolving = farVertexM > switchM * Lod.LodFadeNear * (1 - Lod.LodFadeSoftness)
                || nowMs - node.TakeoverAt.Value < Lod.LodFadeMs;
            foreach (QuadNode c in node.Children)
            {
                c.FadeM = switchM;
                c.FadeFromMs = node.TakeoverAt.Value;
            }
            if (stillDissolving)
            {
                node.Under = true;
                draw.Add(node);
            }
        }

        /// <summary>Nodes not seen for maxAge passes, so their tiles can be released.</summary>
        public List<QuadNode> Stale(long maxAge)
        {
            var output = new List<QuadNode>();
            foreach (QuadNode node in nodes.Values)
            {
                if (generation - node.LastSeen > maxAge) output.Add(node);
            }
            return output;
        }

        public void Forget(string key) => nodes.Remove(key);
    }
}

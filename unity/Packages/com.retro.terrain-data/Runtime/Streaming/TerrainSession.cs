using System;
using System.Collections.Generic;
using System.IO;
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
        public double FadeM;
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

        public TerrainSession(TerrainSessionOptions opts)
        {
            this.opts = opts;
            Basis = Geodesy.MakeEnuBasis(opts.OriginLat, opts.OriginLon, opts.OriginHeight);
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

            var wantList = new List<(TileKey, double)>(wants.Count);
            foreach (TileWant w in wants)
            {
                // tileStreamer.ts scoring: in-frustum first, then error over distance.
                double score = (w.Pinned ? 1e9 : 0) + (w.InFrustum ? 1e6 : 0) + w.SsePx / (1 + w.DistanceM / 1000);
                wantList.Add((w.Id, score));
            }
            Meshes.SetWants(wantList);
            Meshes.Pump();

            DrawList.Clear();
            foreach (QuadNode n in draw)
            {
                if (n.Ocean) continue;
                PtmTile tile = Meshes.Get(n.Id);
                if (tile == null) continue;
                DrawList.Add(new DrawTile
                {
                    Key = n.Id,
                    Tile = tile,
                    Origin = TileOrigin(n.Id, tile.CenterHeightM),
                    FrameFix = FrameFix,
                    Under = n.Under,
                    FadeM = n.FadeM,
                });
            }
        }
    }
}

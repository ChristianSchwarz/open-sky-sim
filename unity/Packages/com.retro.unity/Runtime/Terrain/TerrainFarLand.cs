using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Retro.Core;
using Retro.Terrain;
using UnityEngine;

namespace Retro.Unity
{
    /// <summary>
    /// Far land (farLandTiles.ts): a leaf drawn from far enough off swaps its
    /// land mesh for a lighter level baked beside it (PFL1), the coarsest
    /// whose tolerance is under half a pixel at the tile's nearest point. The
    /// near land stays the tile's own; a level only follows it: its border
    /// corners are the near border's vertices (BorderMap), so it meets its
    /// neighbours where the near land would. A sidecar whose near fingerprint
    /// does not match the land as baked is stale and never used. In SMOOTH
    /// shading a level is welded the first time it is wanted, a few a frame.
    /// </summary>
    public sealed class TerrainFarLand
    {
        // farLandTiles.ts FAR_LAND_CACHE_BYTES, SMOOTH_BUILD_MS; terrainEntity.ts FAR_LAND_MAX_PIXELS.
        private const long CacheBytes = 32L << 20;
        private const double SmoothBuildMs = 2;
        public const double MaxPixels = 0.5;
        /// <summary>Sidecars turned into meshes per frame (uploads are on the main thread).</summary>
        private const int BindsPerFrame = 2;

        private sealed class Level
        {
            public double ToleranceM;
            public short[] Positions;
            public sbyte[] Normals;
            public byte[] Attrs;
            public float[] Sizes;
            public ushort[] RawSizes;
            public uint[] BorderMap;
            public Mesh Faceted;
            /// <summary>Welded for SMOOTH once wanted; Smooth == null and SmoothTried == true means it has no land.</summary>
            public Mesh Smooth;
            public bool SmoothTried;
            public short[] SmoothPositions;
            public uint[] SmoothIndices;
            public SmoothLandMesh SmoothSource;
            public float[] SmoothSizes;
        }

        private sealed class State
        {
            /// <summary>Null while pending; empty when the tile has none or its sidecar is stale.</summary>
            public List<Level> Levels;
            public int SeamVersion = -1;
        }

        private readonly TileIndex index;
        private readonly TileCache<PflTile> cache;
        private readonly int zoom;
        private readonly Dictionary<TileKey, State> states = new Dictionary<TileKey, State>();
        private readonly List<(TileKey, double)> wants = new List<(TileKey, double)>();
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private double smoothDeadlineMs;
        private int bindsThisFrame;

        public int Attached { get; private set; }

        public TerrainFarLand(string root, int zoom)
        {
            this.zoom = zoom;
            string indexPath = Path.Combine(root, "index_farland.bin");
            index = File.Exists(indexPath) ? TileIndex.Decode(File.ReadAllBytes(indexPath)) : null;
            cache = new TileCache<PflTile>(
                k => Path.Combine(root, k.Z.ToString(), k.X.ToString(), k.Y + ".pfl"),
                TileFile.Pfl,
                t =>
                {
                    long n = 64;
                    foreach (PflLevel l in t.Levels) n += l.Positions.Length * 2 + l.Normals.Length + l.Attrs.Length + l.RegionSizes.Length * 2 + l.BorderMap.Length * 4;
                    return n;
                },
                CacheBytes);
        }

        /// <summary>Whether the bake wrote far land for this tile.</summary>
        public bool Has(TileKey id) => id.Z == zoom && (index == null || index.Has(id));

        /// <summary>beginFrame: this frame's budget for welding levels.</summary>
        public void BeginFrame()
        {
            smoothDeadlineMs = clock.Elapsed.TotalMilliseconds + SmoothBuildMs;
            bindsThisFrame = 0;
        }

        /// <summary>
        /// show: the mesh to draw this tile's land with, at the coarsest far level within
        /// `maxToleranceM` (0: the near land), or null for the near land. Fetches the sidecar the
        /// first time one is wanted; a level not yet welded for SMOOTH draws the near land.
        /// </summary>
        /// <param name="seam">The near land as the stitcher left it (null: as baked); the level's border follows it.</param>
        public Mesh Pick(TileKey id, PtmTile tile, double maxToleranceM, double priority, bool smooth, StitchTile seam = null)
        {
            if (!Has(id)) return null;
            states.TryGetValue(id, out State state);
            if (state == null)
            {
                if (maxToleranceM <= 0) return null;
                if (cache.IsAbsent(id))
                {
                    states[id] = new State { Levels = new List<Level>() };
                    return null;
                }
                PflTile pfl = cache.Get(id);
                if (pfl == null)
                {
                    wants.Add((id, priority));
                    return null;
                }
                if (bindsThisFrame >= BindsPerFrame) return null;
                bindsThisFrame++;
                state = new State { Levels = Build(id, tile, pfl) };
                states[id] = state;
                if (state.Levels.Count > 0) Attached++;
            }
            Level pick = null;
            foreach (Level l in state.Levels)
            {
                if (l.ToleranceM <= maxToleranceM) pick = l;
            }
            if (pick == null) return null;
            if (smooth && !pick.SmoothTried && clock.Elapsed.TotalMilliseconds < smoothDeadlineMs) Weld(id, pick);
            Mesh chosen = smooth ? pick.Smooth : pick.Faceted;
            if (chosen != null) FollowSeam(state, seam);
            return chosen;
        }

        /// <summary>followSeam: the near border, as the stitcher left it, onto each level's border corners.</summary>
        private static void FollowSeam(State state, StitchTile seam)
        {
            int version = seam?.Seam?.Version ?? 0;
            if (state.SeamVersion == version || seam == null) return;
            state.SeamVersion = version;
            short[] near = seam.Positions;
            foreach (Level level in state.Levels)
            {
                uint[] map = level.BorderMap;
                if (map.Length == 0 || level.Positions.Length == 0) continue;
                for (int i = 0; i + 1 < map.Length; i += 2)
                {
                    long corner = map[i] * 3L, slot = map[i + 1] * 3L;
                    level.Positions[corner] = near[slot];
                    level.Positions[corner + 1] = near[slot + 1];
                    level.Positions[corner + 2] = near[slot + 2];
                }
                if (level.Faceted != null)
                {
                    Object.Destroy(level.Faceted);
                    level.Faceted = TileMeshUpload.MakeSoupLand(level.Faceted.name, level.Positions, level.Normals, level.Attrs, level.Sizes);
                }
                // The welded level: its index maps each faceted corner to the shared vertex it became.
                if (level.Smooth != null)
                {
                    for (int i = 0; i + 1 < map.Length; i += 2)
                    {
                        long v = level.SmoothIndices[map[i]] * 3L, slot = map[i + 1] * 3L;
                        level.SmoothPositions[v] = near[slot];
                        level.SmoothPositions[v + 1] = near[slot + 1];
                        level.SmoothPositions[v + 2] = near[slot + 2];
                    }
                    string name = level.Smooth.name;
                    Object.Destroy(level.Smooth);
                    level.Smooth = TileMeshUpload.MakeSmoothLand(name, level.SmoothSource, level.SmoothSizes);
                }
            }
        }

        /// <summary>build: the far levels as meshes, or none when the sidecar does not match this land as baked.</summary>
        private static List<Level> Build(TileKey id, PtmTile tile, PflTile pfl)
        {
            var levels = new List<Level>();
            short[] near = tile.LandPositions;
            if (near.Length / 9 != pfl.NearTriangles || PflCodec.LandFingerprint(near) != pfl.NearFingerprint) return levels;
            int i = 0;
            foreach (PflLevel l in pfl.Levels)
            {
                // Own copies: the border corners are rewritten as the seam moves, and the decoded sidecar may be shared.
                var level = new Level
                {
                    ToleranceM = l.ToleranceM,
                    Positions = (short[])l.Positions.Clone(),
                    Normals = (sbyte[])l.Normals.Clone(),
                    Attrs = l.Attrs,
                    RawSizes = l.RegionSizes,
                    BorderMap = l.BorderMap,
                };
                LandMesh.LeanEdgeNormals(level.Positions, level.Normals);
                level.Sizes = new float[l.RegionSizes.Length];
                for (int k = 0; k < l.RegionSizes.Length; k++) level.Sizes[k] = l.RegionSizes[k];
                if (level.Positions.Length > 0)
                {
                    level.Faceted = TileMeshUpload.MakeSoupLand($"far land {id} {i}", level.Positions, level.Normals, level.Attrs, level.Sizes);
                }
                levels.Add(level);
                i++;
            }
            return levels;
        }

        /// <summary>weld: a level for SMOOTH, from its faceted arrays as the seam left them.</summary>
        private static void Weld(TileKey id, Level level)
        {
            level.SmoothTried = true;
            if (level.Positions.Length == 0) return;
            SmoothLandMesh s = LandMesh.BuildSmoothLandGeometry(level.Positions, level.Normals, level.Attrs, level.RawSizes);
            if (s == null) return;
            var sizes = new float[s.OutSizes.Length];
            for (int k = 0; k < sizes.Length; k++) sizes[k] = s.OutSizes[k];
            level.Smooth = TileMeshUpload.MakeSmoothLand($"far land {id} smooth", s, sizes);
            level.SmoothPositions = s.OutPositions;
            level.SmoothIndices = s.Indices;
            level.SmoothSource = s;
            level.SmoothSizes = sizes;
        }

        /// <summary>Once a frame, after the draw asked: fetch what it wanted.</summary>
        public void Pump()
        {
            cache.NextGeneration();
            cache.SetWants(wants);
            wants.Clear();
            cache.Pump();
        }

        /// <summary>A tile left: its far land goes with it.</summary>
        public void Release(TileKey id)
        {
            if (!states.TryGetValue(id, out State state)) return;
            if (state.Levels != null)
            {
                if (state.Levels.Count > 0) Attached--;
                foreach (Level l in state.Levels)
                {
                    if (l.Faceted != null) Object.Destroy(l.Faceted);
                    if (l.Smooth != null) Object.Destroy(l.Smooth);
                }
            }
            states.Remove(id);
        }

        public void Dispose()
        {
            foreach (TileKey k in new List<TileKey>(states.Keys)) Release(k);
        }
    }
}

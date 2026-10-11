using System;

namespace Retro.Terrain
{
    /// <summary>The player's Roads setting (gameDefs.ts RoadsMode): MAJOR keeps motorways to secondaries and the railways.</summary>
    public enum RoadsMode
    {
        Off = 0,
        Major = 1,
        All = 2,
    }

    /// <summary>The three meshes a .ptr sidecar splits into (roadStrokes.ts StrokeKind), in draw-list order.</summary>
    public enum StrokeKind
    {
        /// <summary>Motorway to Secondary (classes 0..3): palette SCENERY_ROAD_MAIN.</summary>
        Major = 0,
        /// <summary>Tertiary and below (4..6, and the undrawn zone/crossing classes 9..11): SCENERY_ROAD_SECONDARY.</summary>
        Minor = 1,
        /// <summary>Rail and RailService (7, 8): SCENERY_RAIL, three passes (bed, sleepers, rails).</summary>
        Rail = 2,
    }

    /// <summary>
    /// Per-vertex track flags of a rail stroke (ptr.ts TRACK_FLAG_*) and the
    /// track dimensions the rail shader draws with (ptr.ts, depthFP.ts). Only
    /// the shader reads them; listed here so the URP side has one source.
    /// </summary>
    public static class TrackFlags
    {
        /// <summary>Diverging track inside a switch zone: no sleepers of its own.</summary>
        public const int NoSleepers = 1;
        /// <summary>Long timbers reaching toward the vertex's + side (the vertex without the side bit).</summary>
        public const int LongPos = 2;
        public const int LongNeg = 4;
        /// <summary>Level crossing: no bed and no sleepers, rails only.</summary>
        public const int Crossing = 8;
        public const int ReachShift = 4;
        public const int ReachMask = 0x30;
        public const int ReachLevels = 3;

        /// <summary>Sleeper pitch; AlongWrapM / this is whole (5120), so the rhythm runs through the u16 wrap.</summary>
        public const double SleeperPitchM = 0.64;
        public const double LongTimberExtraM = 2.9;
        public const double LongTimberStepM = 1.5;
        public const double RailHeadOffsetM = 0.7175;
        public const double RailHeadHalfM = 0.0375;
        public const double SleeperHalfLengthM = 1.3;
        public const double SleeperHalfWidthM = 0.13;
        /// <summary>One track per this much bed width (RAIL_TRACK_WIDTH_M in bake_osm_roads.py).</summary>
        public const double TrackPitchM = 5.0;
        /// <summary>Least strength a sub-pixel rail keeps.</summary>
        public const double RailMinStrength = 0.45;
    }

    /// <summary>
    /// A tile's road strokes split by kind, as roadStrokes.ts buildRoadMeshes
    /// binds them: every kind shares the sidecar's vertex streams (int16
    /// positions in the sidecar's own quantisation step, int8x4 directions with
    /// the class byte in the 4th lane, u16 half-widths in decimetres, u16 along
    /// in 0.05 m, u8 track flags) and has its own index list over them.
    /// </summary>
    public sealed class RoadTileMeshes
    {
        public PtrTile Tile;
        /// <summary>
        /// Uniform scale on top of the tile's own (tile quantScale): 1, or
        /// sidecar quantScale / tile quantScale when the sidecar comes from
        /// another bake of the mesh. Positions in tile-frame metres are
        /// <c>pos * GroupScale * tileScale</c>.
        /// </summary>
        public double GroupScale;
        /// <summary>Index lists by <see cref="StrokeKind"/>; null where the tile has none. May be <c>Tile.Indices</c> itself.</summary>
        public ushort[] Major;
        public ushort[] Minor;
        public ushort[] Rail;
        /// <summary>GPU bytes bound, for the cache budget (roadStrokes.ts RoadMeshes.bytes before any far level is built).</summary>
        public long Bytes;

        public ushort[] Of(StrokeKind kind) => kind switch
        {
            StrokeKind.Major => Major,
            StrokeKind.Minor => Minor,
            _ => Rail,
        };

        /// <summary>
        /// Triangles bound in every mesh (roadStrokes.ts roadTriangles): the
        /// sleeper and rail passes draw the rail list again, twice.
        /// </summary>
        public int Triangles(bool trackPasses = true)
        {
            int n = (Major?.Length ?? 0) / 3 + (Minor?.Length ?? 0) / 3 + (Rail?.Length ?? 0) / 3;
            if (trackPasses) n += 2 * ((Rail?.Length ?? 0) / 3);
            return n;
        }

        /// <summary>
        /// What the tile's roads cost the triangle budget (RoadStrokes.trianglesOf
        /// with atFullDetail): every mesh the setting draws, at full detail,
        /// whatever far level or track-detail reach is in effect, so the budget
        /// cut does not move as the view does.
        /// </summary>
        public int BudgetTriangles(RoadsMode mode)
        {
            if (mode == RoadsMode.Off) return 0;
            int n = (Major?.Length ?? 0) / 3 + (Rail?.Length ?? 0) / 3 * 3;
            if (mode == RoadsMode.All) n += (Minor?.Length ?? 0) / 3;
            return n;
        }
    }

    /// <summary>
    /// Road strokes at runtime (src/script/terrain/roadStrokes.ts): the
    /// engine-free part, splitting a decoded .ptr sidecar into the three
    /// stroke kinds, and the reach past which a track's sleeper and rail
    /// passes cannot show. Fetching, caching and the three.js binding stay in
    /// the renderer.
    /// </summary>
    public static class RoadStrokes
    {
        /// <summary>ptr.ts ROAD_MAJOR_MAX_CLASS: Secondary and finer-numbered classes are major.</summary>
        public const int RoadMajorMaxClass = (int)RoadClass.Secondary;

        /// <summary>Decoded sidecars kept (ROAD_STROKE_CACHE_BYTES).</summary>
        public const long CacheBytes = 32L * 1024 * 1024;

        /// <summary>
        /// Draw order among a tile's meshes (ROAD_RENDER_ORDER): over the ground
        /// and the land-use outlines, under the rivers (2). The strokes write
        /// no depth, so order decides who wins where two overlap.
        /// </summary>
        public const double RoadRenderOrder = 1;

        /// <summary>The rail pass, after every sleeper pass (RAIL_TOP_RENDER_ORDER).</summary>
        public const double RailTopRenderOrder = RoadRenderOrder + 0.5;

        /// <summary>depthFP.ts RAIL_DETAIL_FADE_M: pixel footprint (m) over which sleepers and rails fade out.</summary>
        public const double RailDetailFadeStartM = 0.8;
        public const double RailDetailFadeEndM = 2.4;

        /// <summary>ptr.ts isRailClass.</summary>
        public static bool IsRailClass(int cls) => cls == (int)RoadClass.Rail || cls == (int)RoadClass.RailService;

        /// <summary>The kind a vertex's class byte (4th direction lane) belongs to (roadStrokes.ts kindOf).</summary>
        public static StrokeKind KindOf(sbyte classByte)
        {
            int cls = classByte & PtrCodec.RoadClassMask;
            return IsRailClass(cls) ? StrokeKind.Rail : cls <= RoadMajorMaxClass ? StrokeKind.Major : StrokeKind.Minor;
        }

        /// <summary>
        /// One kind's index list over the shared stroke vertices, or null when
        /// the tile has no stroke of that kind; the tile's own array when every
        /// triangle is of that kind (roadStrokes.ts classIndices). A triangle's
        /// first vertex speaks for it: a pair, and every vertex of one stroke,
        /// carry the same class.
        /// </summary>
        public static ushort[] ClassIndices(PtrTile tile, StrokeKind kind)
        {
            ushort[] all = tile.Indices;
            sbyte[] dirs = tile.Directions;
            int count = 0;
            for (int i = 0; i < all.Length; i += 3)
            {
                if (KindOf(dirs[all[i] * 4 + 3]) == kind) count += 3;
            }
            if (count == 0) return null;
            if (count == all.Length) return all;
            var output = new ushort[count];
            int o = 0;
            for (int i = 0; i < all.Length; i += 3)
            {
                if (KindOf(dirs[all[i] * 4 + 3]) == kind)
                {
                    output[o++] = all[i];
                    output[o++] = all[i + 1];
                    output[o++] = all[i + 2];
                }
            }
            return output;
        }

        /// <summary>
        /// The extra uniform scale a sidecar's group gets inside a tile drawn at
        /// <paramref name="tileScale"/> (buildRoadMeshes / buildBridgeMeshes):
        /// both steps came through a float32 header, so anything past float32
        /// precision is a different bake of the mesh and is rescaled.
        /// </summary>
        public static double GroupScale(float quantScale, double tileScale) =>
            Math.Abs(quantScale - tileScale) > 1e-6 * tileScale ? quantScale / tileScale : 1;

        /// <summary>Split a decoded sidecar into its stroke kinds (roadStrokes.ts buildRoadMeshes, without the GPU binding).</summary>
        public static RoadTileMeshes Build(PtrTile tile, double tileScale)
        {
            var roads = new RoadTileMeshes { Tile = tile, GroupScale = GroupScale(tile.QuantScale, tileScale) };
            roads.Major = ClassIndices(tile, StrokeKind.Major);
            roads.Minor = ClassIndices(tile, StrokeKind.Minor);
            roads.Rail = ClassIndices(tile, StrokeKind.Rail);
            long bytes = 0;
            if (roads.Major != null) bytes += roads.Major.Length * 2L;
            if (roads.Minor != null) bytes += roads.Minor.Length * 2L;
            if (roads.Rail != null) bytes += roads.Rail.Length * 2L;
            bytes += tile.Positions.Length * 2L + tile.Directions.Length + tile.HalfWidths.Length * 2L;
            roads.Bytes = bytes;
            return roads;
        }

        /// <summary>
        /// Ground metres per pixel per metre of range at the screen centre, for
        /// a camera of vertical <paramref name="fovDeg"/> drawing
        /// <paramref name="heightPx"/> real pixels tall (terrainEntity.ts
        /// limitTrackDetail's pixelAngle).
        /// </summary>
        public static double PixelAngle(double fovDeg, double heightPx) =>
            2 * Math.Tan(fovDeg * (Math.PI / 180) / 2) / Math.Max(1, heightPx);

        /// <summary>
        /// Farthest, in metres, a track's sleeper and rail passes can put a
        /// fragment on screen (roadStrokes.ts trackDetailReachM): past it the
        /// passes fade out completely (RAIL_DETAIL_FADE_M[1] per pixel), so they
        /// are hidden rather than drawn to be discarded. Uses the corner pixel,
        /// the smallest on screen by cos^2.
        /// </summary>
        public static double TrackDetailReachM(double fovDeg, double aspect, double heightPx)
        {
            double tanV = Math.Tan(fovDeg * (Math.PI / 180) / 2);
            double tanH = tanV * aspect;
            double centrePixel = (2 * tanV) / Math.Max(1, heightPx);
            double cornerCos2 = 1 / (1 + tanV * tanV + tanH * tanH);
            return RailDetailFadeEndM / (centrePixel * cornerCos2);
        }
    }
}

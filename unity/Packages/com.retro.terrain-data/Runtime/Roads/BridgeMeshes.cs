using System;
using System.Collections.Generic;

namespace Retro.Terrain
{
    /// <summary>
    /// A bounding sphere as three.js BufferGeometry.computeBoundingSphere makes
    /// it: centre of the axis-aligned box over every vertex in the position
    /// buffer (not only the indexed ones), radius the farthest vertex from it.
    /// Units are those of the positions (quantisation steps for a sidecar).
    /// </summary>
    public struct BoundsSphere
    {
        public double CenterX, CenterY, CenterZ, Radius;

        public static BoundsSphere Of(short[] positions) => Of(positions.Length / 3, i => positions[i]);

        public static BoundsSphere Of(float[] positions) => Of(positions.Length / 3, i => positions[i]);

        private static BoundsSphere Of(int count, Func<int, double> at)
        {
            double minX = double.PositiveInfinity, minY = double.PositiveInfinity, minZ = double.PositiveInfinity;
            double maxX = double.NegativeInfinity, maxY = double.NegativeInfinity, maxZ = double.NegativeInfinity;
            for (int i = 0; i < count; i++)
            {
                double x = at(i * 3), y = at(i * 3 + 1), z = at(i * 3 + 2);
                minX = Math.Min(minX, x); minY = Math.Min(minY, y); minZ = Math.Min(minZ, z);
                maxX = Math.Max(maxX, x); maxY = Math.Max(maxY, y); maxZ = Math.Max(maxZ, z);
            }
            var s = new BoundsSphere();
            if (!(maxX < minX || maxY < minY || maxZ < minZ))
            {
                s.CenterX = (minX + maxX) * 0.5;
                s.CenterY = (minY + maxY) * 0.5;
                s.CenterZ = (minZ + maxZ) * 0.5;
            }
            double maxRadiusSq = 0;
            for (int i = 0; i < count; i++)
            {
                double dx = s.CenterX - at(i * 3), dy = s.CenterY - at(i * 3 + 1), dz = s.CenterZ - at(i * 3 + 2);
                maxRadiusSq = Math.Max(maxRadiusSq, dx * dx + dy * dy + dz * dz);
            }
            s.Radius = Math.Sqrt(maxRadiusSq);
            return s;
        }
    }

    /// <summary>Level-crossing furniture boxes of one role as flat-shaded triangles (bridgeMeshes.ts boxGeometry).</summary>
    public sealed class BridgeBoxMesh
    {
        /// <summary>xyz per vertex, in the sidecar's quantisation units (metres / quantScale), 24 vertices per box.</summary>
        public float[] Positions;
        /// <summary>Unit face normals, xyz per vertex.</summary>
        public float[] Normals;
        /// <summary>36 per box.</summary>
        public uint[] Indices;
    }

    /// <summary>
    /// One drawn part of a tile's bridges: a role's index list over the
    /// sidecar's shared int16 positions and int8x4 normals, or that role's
    /// furniture boxes.
    /// </summary>
    public sealed class BridgePart
    {
        public BridgeRole Role;
        /// <summary>Over <c>PbrTile.Positions</c>/<c>Normals</c>; null for a box part.</summary>
        public ushort[] Indices;
        /// <summary>Own float32 geometry; null for a bridge-geometry part.</summary>
        public BridgeBoxMesh Box;
        /// <summary>Over the part's whole position buffer, quantisation units (see BridgeMeshes.ShowPart).</summary>
        public BoundsSphere Bounds;

        public int Triangles => (Indices?.Length ?? Box.Indices.Length) / 3;
    }

    /// <summary>A tile's bridges as bridgeMeshes.ts buildBridgeMeshes binds them, without the GPU objects.</summary>
    public sealed class BridgeTileMeshes
    {
        public PbrTile Tile;
        /// <summary>As RoadTileMeshes.GroupScale.</summary>
        public double GroupScale;
        /// <summary>By BridgeRole (0 Deck .. 5 SignPost); null where the tile has nothing of that role.</summary>
        public BridgePart[] Slots = new BridgePart[6];
        /// <summary>Furniture of a role that also has bridge geometry, in its own draw.</summary>
        public List<BridgePart> Extra = new List<BridgePart>();
        /// <summary>
        /// The track along the rail decks, bound exactly as a road sidecar's
        /// rail stroke (all flags clear, no switch zones on a deck): draw it
        /// with the three rail passes. Null when the sidecar has none.
        /// </summary>
        public PtrTile Track;
        public BoundsSphere TrackBounds;
        public long Bytes;

        public BridgePart Slot(BridgeRole role) => Slots[(int)role];

        /// <summary>
        /// Every triangle bound (bridgeMeshes.ts triangles), the track counted
        /// three times for its bed, sleeper and rail passes. This is also what
        /// the budget charges a drawn tile whatever showLevel hides.
        /// </summary>
        public int Triangles(bool trackPasses = true)
        {
            int n = 0;
            foreach (BridgePart p in Slots) if (p != null) n += p.Triangles;
            foreach (BridgePart p in Extra) n += p.Triangles;
            if (Track != null) n += Track.Indices.Length / 3 * (trackPasses ? 3 : 1);
            return n;
        }
    }

    /// <summary>
    /// Bridge geometry at runtime (src/script/terrain/bridgeMeshes.ts): the
    /// engine-free part. A .pbr sidecar's triangles are split by the role in
    /// each vertex's 4th normal byte; its level-crossing furniture boxes are
    /// expanded to triangles; its deck track becomes a rail stroke.
    /// </summary>
    public static class BridgeMeshes
    {
        /// <summary>Decoded sidecars kept (BRIDGE_CACHE_BYTES).</summary>
        public const long CacheBytes = 16L * 1024 * 1024;

        /// <summary>
        /// Ground metres per pixel past which a part is hidden: it is under half
        /// a pixel across. A deck is ~10 m wide, a rail track ~1.5 m, a
        /// level-crossing sign ~0.5 m.
        /// </summary>
        public const double DeckHidePixelM = 20;
        public const double TrackHidePixelM = 3;
        public const double FurnitureHidePixelM = 1;

        /// <summary>The hide limit of a role's part (decks, concrete and rail decks by the deck's; signs and posts by the furniture's).</summary>
        public static double HidePixelM(BridgeRole role) =>
            role == BridgeRole.Deck || role == BridgeRole.Concrete || role == BridgeRole.RailDeck ? DeckHidePixelM : FurnitureHidePixelM;

        /// <summary>
        /// Whether a part shows (BridgeMeshes.showLevel): <paramref name="nearM"/>
        /// is the camera's distance to the part's bounding sphere in metres
        /// (max(0, |centre - eye| - radius), the sphere taken to metres by
        /// <c>GroupScale * tileScale</c> and placed with the tile), and
        /// <paramref name="pixelAngle"/> RoadStrokes.PixelAngle.
        /// </summary>
        public static bool ShowPart(double nearM, double pixelAngle, double hidePixelM) => nearM * pixelAngle <= hidePixelM;

        /// <summary>One role's index list over the shared vertices, or null if the tile has none (roleIndices).</summary>
        public static ushort[] RoleIndices(PbrTile tile, BridgeRole role)
        {
            ushort[] all = tile.Indices;
            int count = 0;
            for (int i = 0; i < all.Length; i += 3)
            {
                if (PbrCodec.Role(tile.Normals[all[i] * 4 + 3]) == role) count += 3;
            }
            if (count == 0) return null;
            if (count == all.Length) return all;
            var output = new ushort[count];
            int o = 0;
            for (int i = 0; i < all.Length; i += 3)
            {
                if (PbrCodec.Role(tile.Normals[all[i] * 4 + 3]) == role)
                {
                    output[o++] = all[i];
                    output[o++] = all[i + 1];
                    output[o++] = all[i + 2];
                }
            }
            return output;
        }

        private static readonly int[,] Corners = { { -1, -1 }, { 1, -1 }, { 1, 1 }, { -1, 1 } };

        /// <summary>
        /// The boxes of one role as flat-shaded triangles in quantisation units,
        /// so they sit in the tile beside the bridge geometry; null when there
        /// are none of that role (boxGeometry). Box record: centre xyz, three
        /// unit axes, three half sizes, role.
        /// </summary>
        public static BridgeBoxMesh BoxGeometry(float[] boxes, BridgeRole role, float quantScale)
        {
            int count = boxes.Length / PbrCodec.BoxFloats;
            var mine = new List<int>();
            for (int i = 0; i < count; i++)
            {
                if (boxes[i * PbrCodec.BoxFloats + 15] == (int)role) mine.Add(i);
            }
            if (mine.Count == 0) return null;
            var pos = new float[mine.Count * 24 * 3];
            var nrm = new float[mine.Count * 24 * 3];
            var idx = new uint[mine.Count * 36];
            double inv = 1 / (double)quantScale;
            var c = new double[3];
            var ax = new double[3, 3];
            var h = new double[3];
            int v = 0, t = 0;
            foreach (int i in mine)
            {
                int o = i * PbrCodec.BoxFloats;
                for (int k = 0; k < 3; k++)
                {
                    c[k] = boxes[o + k];
                    ax[0, k] = boxes[o + 3 + k];
                    ax[1, k] = boxes[o + 6 + k];
                    ax[2, k] = boxes[o + 9 + k];
                    h[k] = boxes[o + 12 + k];
                }
                // Six faces: along each axis, at -h and +h, spanned by the other two.
                for (int f = 0; f < 3; f++)
                {
                    int u = (f + 1) % 3, w = (f + 2) % 3;
                    for (int sgn = -1; sgn <= 1; sgn += 2)
                    {
                        int b = v;
                        for (int corner = 0; corner < 4; corner++)
                        {
                            int su = Corners[corner, 0], sw = Corners[corner, 1];
                            for (int k = 0; k < 3; k++)
                            {
                                pos[v * 3 + k] = (float)((c[k] + ax[f, k] * h[f] * sgn + ax[u, k] * h[u] * su + ax[w, k] * h[w] * sw) * inv);
                                nrm[v * 3 + k] = (float)(ax[f, k] * sgn);
                            }
                            v++;
                        }
                        idx[t] = (uint)b;
                        idx[t + 1] = (uint)(b + 1);
                        idx[t + 2] = (uint)(b + 2);
                        idx[t + 3] = (uint)b;
                        idx[t + 4] = (uint)(b + 2);
                        idx[t + 5] = (uint)(b + 3);
                        t += 6;
                    }
                }
            }
            return new BridgeBoxMesh { Positions = pos, Normals = nrm, Indices = idx };
        }

        /// <summary>
        /// The deck track as a road-sidecar rail stroke (buildBridgeMeshes): the
        /// same streams, flags all clear.
        /// </summary>
        public static PtrTile TrackStroke(PbrTile tile)
        {
            PbrTrack track = tile.Track;
            if (track == null) return null;
            return new PtrTile
            {
                Id = tile.Id,
                QuantScale = tile.QuantScale,
                Positions = track.Positions,
                Directions = track.Directions,
                HalfWidths = track.HalfWidths,
                Along = track.Along,
                Flags = new byte[track.Positions.Length / 3],
                Indices = track.Indices,
            };
        }

        /// <summary>
        /// Split a decoded sidecar into its drawn parts (buildBridgeMeshes with
        /// every material present, as terrainEntity.ts builds it).
        /// </summary>
        public static BridgeTileMeshes Build(PbrTile tile, double tileScale)
        {
            var set = new BridgeTileMeshes { Tile = tile, GroupScale = RoadStrokes.GroupScale(tile.QuantScale, tileScale) };
            long bytes = 0;
            BoundsSphere shared = default;
            bool sharedDone = false;
            for (int r = 0; r < 6; r++)
            {
                ushort[] indices = RoleIndices(tile, (BridgeRole)r);
                if (indices == null) continue;
                if (!sharedDone)
                {
                    shared = BoundsSphere.Of(tile.Positions);
                    sharedDone = true;
                }
                set.Slots[r] = new BridgePart { Role = (BridgeRole)r, Indices = indices, Bounds = shared };
                bytes += indices.Length * 2L;
            }
            // Level-crossing furniture: float boxes, built here at full precision.
            if (tile.Boxes != null)
            {
                for (int r = 0; r < 6; r++)
                {
                    BridgeBoxMesh box = BoxGeometry(tile.Boxes, (BridgeRole)r, tile.QuantScale);
                    if (box == null) continue;
                    var part = new BridgePart { Role = (BridgeRole)r, Box = box, Bounds = BoundsSphere.Of(box.Positions) };
                    // A tile has the furniture or the bridge geometry of a role
                    // in practice; where both, the furniture rides in its own draw.
                    if (set.Slots[r] == null) set.Slots[r] = part;
                    else set.Extra.Add(part);
                    bytes += box.Positions.Length * 4L * 2 + box.Indices.Length * 4L;
                }
            }
            if (tile.Track != null)
            {
                PbrTrack track = tile.Track;
                set.Track = TrackStroke(tile);
                set.TrackBounds = BoundsSphere.Of(track.Positions);
                bytes += track.Positions.Length * 2L + track.Directions.Length + track.HalfWidths.Length * 2L
                    + track.Along.Length * 2L + track.Indices.Length * 2L;
            }
            bytes += tile.Positions.Length * 2L + tile.Normals.Length;
            set.Bytes = bytes;
            return set;
        }
    }
}

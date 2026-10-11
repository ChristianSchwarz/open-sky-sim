using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>Constants of src/script/terrain/buildingMeshes.ts and pbh.ts the runtime needs.</summary>
    public static class BuildingConstants
    {
        /// <summary>Decoded sidecars kept; a bound tile no longer needs its record bytes.</summary>
        public const int CacheBytes = 24 * 1024 * 1024;
        /// <summary>Triangles every drawn building together may cost a frame.</summary>
        public const int TriangleBudget = 300_000;
        /// <summary>A building is drawn while its prominence spans at least this many pixels at its tile's near edge.</summary>
        public const double MinPixels = 2.5;
        /// <summary>Main-thread time a frame may spend extruding buildings (TS; a job system may ignore it).</summary>
        public const double BuildMs = 3;
        /// <summary>Buildings extruded per step between time checks (buildPending).</summary>
        public const int BuildChunk = 64;
        /// <summary>A tile adds its buildings over this many seconds, biggest first.</summary>
        public const double GrowSeconds = 8;
        /// <summary>...and never slower than this many buildings a second.</summary>
        public const double GrowMinPerS = 25;
        /// <summary>The longest frame step the growth counts, seconds.</summary>
        public const double GrowMaxStepS = 0.25;
        /// <summary>The budget search's ceiling on the pixel floor.</summary>
        public const double MaxPixels = 4096;

        /// <summary>
        /// pbh.ts buildingProminence: how much a building stands out from the
        /// air, in metres, the larger of its footprint's side and its height.
        /// </summary>
        public static double Prominence(double areaM2, double heightM)
        {
            return JsMax(Math.Sqrt(JsMax(0, areaM2)), heightM);
        }

        /// <summary>
        /// Ground metres per pixel per metre of range at the screen centre, as
        /// terrainEntity.ts limitTrackDetail computes it:
        /// 2 tan(fovY / 2) / max(1, heightPx). `heightPx` is the drawn height in
        /// real pixels (viewport height times render scale). Uses System.Math.Tan,
        /// so it may differ from V8 in the last bit.
        /// </summary>
        public static double PixelAngle(double fovYRadians, double heightPx)
        {
            return 2 * Math.Tan(fovYRadians / 2) / Math.Max(1, heightPx);
        }

        internal static double JsMax(double a, double b) => double.IsNaN(a) || double.IsNaN(b) ? double.NaN : Math.Max(a, b);
    }

    /// <summary>pbh.ts pbhRings: a building's rings as (u, v) metre pairs, outline first.</summary>
    public static class PbhRings
    {
        public static List<(double U, double V)[]> Of(PbhTile tile, PbhBuilding b)
        {
            var rings = new List<(double U, double V)[]>(b.RingCount);
            int v = b.FirstVert;
            for (int r = 0; r < b.RingCount; r++)
            {
                int n = tile.RingSizes[b.FirstRing + r];
                var ring = new (double U, double V)[n];
                for (int k = 0; k < n; k++, v++)
                {
                    ring[k] = (tile.Verts[v * 2], tile.Verts[v * 2 + 1]);
                }
                rings.Add(ring);
            }
            return rings;
        }
    }

    /// <summary>
    /// One tile's extruded buildings, ready for a Unity Mesh: a flat-shaded
    /// triangle soup (no index buffer; vertex i of triangle t is 3t + i), in
    /// the tile's own axes in metres from the tile centre - the PTM frame
    /// before its quantScale, placed by the tile's translation and frameFix.
    /// What buildingMeshes.ts bind() uploads.
    /// </summary>
    public sealed class BuildingTileMesh
    {
        public TileKey Id;
        public int Triangles;
        /// <summary>x, y, z per vertex (Float32Array `position`).</summary>
        public float[] Positions;
        /// <summary>Normal per vertex, xyz * 127 rounded (Int8Array `normal`, normalized); the face normal on all three.</summary>
        public sbyte[] Normals;
        /// <summary>BuildingTone index per vertex (Uint8Array `tone`).</summary>
        public byte[] Tones;
        /// <summary>sRGB r, g, b, a per vertex (Uint8Array `rawColor`, normalized): a measured roof colour with a = 255, else all 0.</summary>
        public byte[] RawColors;
        /// <summary>Triangles after the first i + 1 buildings.</summary>
        public uint[] Prefix;
        /// <summary>Per building, most prominent first, made non-increasing (bind()).</summary>
        public float[] Prominence;

        /// <summary>GPU bytes in the web game's layout (12 + 3 + 1 + 4 per vertex), for its cache budget.</summary>
        public int Bytes => Triangles * 3 * (12 + 3 + 1 + 4);
    }

    /// <summary>
    /// Extrudes one tile's PBH1 buildings into a <see cref="BuildingTileMesh"/>:
    /// buildingMeshes.ts extrude() + Soup + bind(). Owns all its state, so a
    /// builder can run on a worker thread or in steps across frames; the
    /// result is the same however the work is split.
    /// </summary>
    public sealed class BuildingTileBuilder
    {
        private readonly PbhTile _tile;
        private readonly uint[] _prefix;
        private readonly float[] _prominence;
        private float[] _pos = new float[9 * 1024];
        private sbyte[] _nrm = new sbyte[9 * 1024];
        private byte[] _tone = new byte[3 * 1024];
        private byte[] _raw = new byte[12 * 1024];
        private int _tris;
        private readonly double[] _p = new double[9];

        /// <summary>The next building to extrude.</summary>
        public int Next { get; private set; }

        public int Total => _tile.Buildings.Count;

        public bool Done => Next >= Total;

        public BuildingTileBuilder(PbhTile tile)
        {
            _tile = tile;
            _prefix = new uint[tile.Buildings.Count];
            _prominence = new float[tile.Buildings.Count];
        }

        /// <summary>
        /// The whole tile at once, or null when it has no buildings (the web
        /// game then marks the tile 'none' and never binds a mesh).
        /// </summary>
        public static BuildingTileMesh Build(PbhTile tile)
        {
            if (tile.Buildings.Count == 0)
            {
                return null;
            }
            var b = new BuildingTileBuilder(tile);
            b.Extrude(b.Total);
            return b.Finish();
        }

        /// <summary>Extrude up to `maxBuildings` more (buildPending steps by 64).</summary>
        public void Step(int maxBuildings = BuildingConstants.BuildChunk)
        {
            Extrude(Math.Min(Total, Next + maxBuildings));
        }

        private void Grow()
        {
            Array.Resize(ref _pos, _pos.Length * 2);
            Array.Resize(ref _nrm, _nrm.Length * 2);
            Array.Resize(ref _tone, _tone.Length * 2);
            Array.Resize(ref _raw, _raw.Length * 2);
        }

        /// <summary>Soup.push: `rgb` is 0xRRGGBB, or negative for none.</summary>
        private void Push(double[] p, double nx, double ny, double nz, int tone, int rgb)
        {
            if ((_tris + 1) * 9 > _pos.Length)
            {
                Grow();
            }
            int o = _tris * 9;
            for (int k = 0; k < 9; k++)
            {
                _pos[o + k] = (float)p[k];
            }
            sbyte qx = ToInt8(JsMath.Round(nx * 127)), qy = ToInt8(JsMath.Round(ny * 127)), qz = ToInt8(JsMath.Round(nz * 127));
            for (int v = 0; v < 3; v++)
            {
                _nrm[o + v * 3] = qx;
                _nrm[o + v * 3 + 1] = qy;
                _nrm[o + v * 3 + 2] = qz;
                _tone[_tris * 3 + v] = unchecked((byte)tone);
                int r = (_tris * 3 + v) * 4;
                if (rgb >= 0)
                {
                    _raw[r] = (byte)((rgb >> 16) & 255);
                    _raw[r + 1] = (byte)((rgb >> 8) & 255);
                    _raw[r + 2] = (byte)(rgb & 255);
                    _raw[r + 3] = 255;
                }
                else
                {
                    _raw[r] = _raw[r + 1] = _raw[r + 2] = _raw[r + 3] = 0;
                }
            }
            _tris++;
        }

        /// <summary>Int8Array element store of an integral double: wraps modulo 256.</summary>
        private static sbyte ToInt8(double v)
        {
            return unchecked((sbyte)TruncToInt32(v));
        }

        private static int TruncToInt32(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return 0;
            return unchecked((int)(long)Math.Truncate(v));
        }

        /// <summary>
        /// buildingMeshes.ts extrude: buildings [Next, to) into the soup, in the
        /// tile's own axes (metres): a PBH1 point (u, v, h) is u*a + v*b + h*up.
        /// </summary>
        public void Extrude(int to)
        {
            Vec3d a = _tile.Frame.A, b = _tile.Frame.B, up = _tile.Frame.Up;
            for (int i = Next; i < to; i++)
            {
                PbhBuilding bld = _tile.Buildings[i];
                List<(double U, double V)[]> rings = PbhRings.Of(_tile, bld);
                double area = 0;
                (double U, double V)[] outer = rings.Count > 0 ? rings[0] : Array.Empty<(double U, double V)>();
                for (int k = 0, j = outer.Length - 1; k < outer.Length; j = k++)
                {
                    area += (outer[j].U - outer[k].U) * (outer[j].V + outer[k].V);
                }
                _prominence[i] = (float)BuildingConstants.Prominence(Math.Abs(area / 2), bld.RidgeM - bld.BaseM);
                int roofTone = bld.RoofTone, wallTone = bld.WallTone;
                int roofRgb = (bld.Flags & PbhCodec.FlagRoofRgb) != 0 ? bld.RoofRgb : -1;
                var ringList = new IReadOnlyList<(double U, double V)>[rings.Count];
                for (int r = 0; r < rings.Count; r++) ringList[r] = rings[r];
                BuildingRoofs.BuildingTriangles(new BuildingShape
                {
                    Rings = ringList,
                    BaseM = bld.BaseM,
                    EaveM = bld.EaveM,
                    RidgeM = bld.RidgeM,
                    Form = bld.Form,
                    RidgeAngle = bld.RidgeAngle,
                    NoWalls = (bld.Flags & PbhCodec.FlagNoWalls) != 0,
                }, (q, n0, n1, n2, roof) =>
                {
                    for (int v = 0; v < 3; v++)
                    {
                        double u = q[v * 3], w = q[v * 3 + 1], h = q[v * 3 + 2];
                        _p[v * 3] = u * a.X + w * b.X + h * up.X;
                        _p[v * 3 + 1] = u * a.Y + w * b.Y + h * up.Y;
                        _p[v * 3 + 2] = u * a.Z + w * b.Z + h * up.Z;
                    }
                    double nx = n0 * a.X + n1 * b.X + n2 * up.X;
                    double ny = n0 * a.Y + n1 * b.Y + n2 * up.Y;
                    double nz = n0 * a.Z + n1 * b.Z + n2 * up.Z;
                    Push(_p, nx, ny, nz, roof ? roofTone : wallTone, roof ? roofRgb : -1);
                });
                _prefix[i] = (uint)_tris;
            }
            if (to > Next)
            {
                Next = to;
            }
        }

        /// <summary>
        /// bind(): the finished mesh. Prominence is held non-increasing (the
        /// bake sorted by its own measure) so the draw-range search can bisect.
        /// </summary>
        public BuildingTileMesh Finish()
        {
            if (!Done)
            {
                throw new InvalidOperationException($"building tile {_tile.Id}: {Next} of {Total} extruded");
            }
            for (int i = 1; i < _prominence.Length; i++)
            {
                _prominence[i] = Math.Min(_prominence[i], _prominence[i - 1]);
            }
            var mesh = new BuildingTileMesh
            {
                Id = _tile.Id,
                Triangles = _tris,
                Positions = new float[_tris * 9],
                Normals = new sbyte[_tris * 9],
                Tones = new byte[_tris * 3],
                RawColors = new byte[_tris * 12],
                Prefix = _prefix,
                Prominence = _prominence,
            };
            Array.Copy(_pos, mesh.Positions, _tris * 9);
            Array.Copy(_nrm, mesh.Normals, _tris * 9);
            Array.Copy(_tone, mesh.Tones, _tris * 3);
            Array.Copy(_raw, mesh.RawColors, _tris * 12);
            return mesh;
        }
    }

    /// <summary>A bound tile's draw state (buildingMeshes.ts BuildingMeshSet minus the GPU objects).</summary>
    public sealed class BuildingDrawSet
    {
        public readonly uint[] Prefix;
        public readonly float[] Prominence;
        /// <summary>Triangles drawn now: the draw range is [0, Shown * 3) vertices.</summary>
        public int Shown;
        /// <summary>Buildings drawn now: Shown is the triangles of this prefix.</summary>
        public int Count;
        /// <summary>Whether the mesh is drawn at all (Shown > 0); false until the first EndFrame that wants it.</summary>
        public bool Visible;
        /// <summary>Fraction of a building owed between frames.</summary>
        public double Owed;

        public BuildingDrawSet(BuildingTileMesh mesh) : this(mesh.Prefix, mesh.Prominence, mesh.Triangles)
        {
        }

        public BuildingDrawSet(uint[] prefix, float[] prominence, int triangles)
        {
            Prefix = prefix;
            Prominence = prominence;
            Shown = triangles;
            Count = 0;
            Visible = false;
        }

        public int TotalTriangles => Prefix.Length > 0 ? (int)Prefix[Prefix.Length - 1] : 0;
    }

    /// <summary>
    /// The per-frame draw ranges of buildingMeshes.ts (beginFrame / want /
    /// endFrame): every wanted tile draws the prefix of its buildings at least
    /// MinPixels across at its near edge; when the frame would draw more than
    /// <see cref="Budget"/> triangles the pixel floor is raised for all tiles
    /// alike until it fits; a tile shrinks at once but grows at a steady rate.
    /// Main-thread state; pure CPU.
    /// </summary>
    public sealed class BuildingDrawBudget
    {
        private readonly List<(BuildingDrawSet Set, double NearM)> _frame = new List<(BuildingDrawSet, double)>();
        private double _lastFrameMs;

        public int Budget = BuildingConstants.TriangleBudget;
        /// <summary>The Buildings setting.</summary>
        public bool Enabled = true;
        /// <summary>The pixel floor the budget raised MinPixels to, or MinPixels.</summary>
        public double MinPixels { get; private set; } = BuildingConstants.MinPixels;
        /// <summary>Triangles drawn by the last EndFrame.</summary>
        public int ShownTriangles { get; private set; }

        /// <summary>Start of the main pass's per-tile walk.</summary>
        public void BeginFrame()
        {
            _frame.Clear();
        }

        /// <summary>
        /// A drawn tile and its near-edge distance:
        /// max(0, |node centre - camera| - node radius). The web game calls it
        /// for every drawn leaf that is not an under-parent (node.under).
        /// </summary>
        public void Want(BuildingDrawSet set, double nearM)
        {
            if (!Enabled || set == null)
            {
                return;
            }
            _frame.Add((set, nearM));
        }

        /// <summary>The number of buildings, most prominent first, at least `minProminence` tall or wide.</summary>
        public static int CountAtLeast(float[] prominence, double minProminence)
        {
            int lo = 0, hi = prominence.Length;
            while (lo < hi)
            {
                int mid = (lo + hi) >> 1;
                if (prominence[mid] >= minProminence)
                {
                    lo = mid + 1;
                }
                else
                {
                    hi = mid;
                }
            }
            return lo;
        }

        public static int TrianglesFor(BuildingDrawSet set, double minProminence)
        {
            int n = CountAtLeast(set.Prominence, minProminence);
            return n > 0 ? (int)set.Prefix[n - 1] : 0;
        }

        private double Total(double px, double pixelAngle)
        {
            double sum = 0;
            foreach (var (set, nearM) in _frame)
            {
                sum += TrianglesFor(set, px * nearM * pixelAngle);
            }
            return sum;
        }

        /// <summary>
        /// Set every wanted tile's draw range. `pixelAngle` is ground metres per
        /// pixel per metre of range (<see cref="BuildingConstants.PixelAngle"/>);
        /// `nowMs` a monotonic clock in milliseconds (performance.now()). The
        /// first call (and any call while the clock reads 0) grows nothing.
        /// Returns the triangles drawn.
        /// </summary>
        public int EndFrame(double pixelAngle, double nowMs)
        {
            double px = BuildingConstants.MinPixels;
            if (Total(px, pixelAngle) > Budget)
            {
                double lo = px, hi = px * 2;
                while (Total(hi, pixelAngle) > Budget && hi < BuildingConstants.MaxPixels)
                {
                    lo = hi;
                    hi *= 2;
                }
                for (int i = 0; i < 12; i++)
                {
                    double mid = (lo + hi) / 2;
                    if (Total(mid, pixelAngle) > Budget)
                    {
                        lo = mid;
                    }
                    else
                    {
                        hi = mid;
                    }
                }
                px = hi;
            }
            MinPixels = px;
            int shown = 0;
            if (!Enabled)
            {
                ShownTriangles = 0;
                return 0;
            }
            double dt = _lastFrameMs == 0 ? 0 : Math.Min(BuildingConstants.GrowMaxStepS, (nowMs - _lastFrameMs) / 1000);
            _lastFrameMs = nowMs;
            foreach (var (set, nearM) in _frame)
            {
                int want = CountAtLeast(set.Prominence, px * nearM * pixelAngle);
                // Shrinking is at once, so the budget holds; growing is one by one.
                if (want <= set.Count)
                {
                    set.Count = want;
                    set.Owed = 0;
                }
                else
                {
                    double rate = Math.Max(BuildingConstants.GrowMinPerS, want / BuildingConstants.GrowSeconds);
                    double owe = set.Owed + rate * dt;
                    double add = Math.Floor(owe);
                    set.Owed = owe - add;
                    set.Count = (int)Math.Min(want, set.Count + add);
                }
                int tris = set.Count > 0 ? (int)set.Prefix[set.Count - 1] : 0;
                set.Shown = tris;
                set.Visible = tris > 0;
                shown += tris;
            }
            ShownTriangles = shown;
            return shown;
        }
    }
}

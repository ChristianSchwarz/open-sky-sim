using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using Retro.Core;
using Retro.Terrain;

namespace Retro.Game
{
    /// <summary>
    /// movingMap.ts MapTileSource: what the moving map reads off the terrain.
    /// The cover texture store provides it (PTX1 far-tile sidecars).
    /// </summary>
    public interface IMapTileSource
    {
        /// <summary>Lowest zoom the bake wrote sidecars for (zoomRange.min).</summary>
        int ZoomMin { get; }
        /// <summary>Highest zoom the bake wrote sidecars for; below ZoomMin means no chart at all.</summary>
        int ZoomMax { get; }
        /// <summary>Texels along a zoom-<paramref name="z"/> sidecar's edge (256 up to z9, 512 from z10 in the shipped bake).</summary>
        int TexelsAt(int z);
        /// <summary>
        /// The decoded sidecar if it is resident, else null. A positive
        /// <paramref name="priority"/> asks the store to fetch it (the map asks
        /// with 2e6, above anything the terrain streamer asks for); 0 only
        /// peeks, which is how the ancestor fallback probes.
        /// </summary>
        PtxTile Sidecar(TileKey id, double priority);
    }

    /// <summary>
    /// Turns a map tile's RGBA into whatever the frontend draws with
    /// (a Texture2D, nearest-filtered, no mipmaps) and frees it again. The
    /// handle comes back to the frontend's painter through
    /// <see cref="ICanvasPainter.Image"/>. Replaces movingMap.ts'
    /// document.createElement('canvas') + putImageData.
    /// </summary>
    public interface IMapRasterFactory
    {
        /// <summary>
        /// <paramref name="rgba"/> is size*size*4 bytes, opaque, row 0 north
        /// (the top of the image), column 0 west. The array is the caller's
        /// to keep; copy it if needed beyond the call.
        /// </summary>
        object Create(TileKey id, int size, byte[] rgba);
        /// <summary>The raster fell out of the renderer's cache (LRU, 48 entries) and will not be drawn again.</summary>
        void Release(object raster);
    }

    /// <summary>cockpit.ts MovingMapSource: where the moving map reads its chart from.</summary>
    public sealed class MovingMapSource
    {
        /// <summary>The terrain's ENU frame: scene position to lat/lon.</summary>
        public EnuBasis Basis;
        public IMapTileSource Tiles;
        public IMapRasterFactory Rasters;
    }

    /// <summary>movingMap.ts MapTilePlacement: a tile's box in the map frame, metres from the ownship, x east, y south.</summary>
    public struct MapTilePlacement
    {
        public double X;
        public double Y;
        public double Width;
        public double Height;
    }

    /// <summary>movingMap.ts MovingMapView.</summary>
    public struct MovingMapView
    {
        /// <summary>Pixel the ownship sits on.</summary>
        public double CenterX;
        public double CenterY;
        /// <summary>Screen pixels per metre.</summary>
        public double PixelsPerMetre;
        /// <summary>Half the drawn square, in pixels; decides which tiles are fetched.</summary>
        public double HalfExtentPx;
        public double LatDeg;
        public double LonDeg;
        /// <summary>Degrees, 0 north, clockwise; drawn up the screen.</summary>
        public double HeadingDeg;
        /// <summary>Painted where the bake has no data ("#rrggbb").</summary>
        public string WaterColor;
    }

    /// <summary>The pure functions of movingMap.ts.</summary>
    public static class MovingMapGeometry
    {
        /// <summary>Store priority for map tiles (MOVING_MAP_PRIORITY).</summary>
        public const double Priority = 2e6;

        /// <summary>Tile rasters kept (MOVING_MAP_CANVAS_CACHE); each z11 one is a megabyte of RGBA.</summary>
        public const int RasterCache = 48;

        /// <summary>metresPerDegree: metres per degree of latitude (110540), and of longitude at <paramref name="latDeg"/>.</summary>
        public static double MetresPerDegreeLat => 110540;

        public static double MetresPerDegreeLon(double latDeg) => 111320 * JsTrig.Cos(latDeg * Math.PI / 180);

        /// <summary>texelMetres: metres a texel of a zoom-<paramref name="z"/> sidecar spans north-south.</summary>
        public static double TexelMetres(int z, int texels) => (180.0 / (1 << z)) * MetresPerDegreeLat / texels;

        /// <summary>
        /// movingMapZoom: the coarsest zoom whose texels are no larger than a
        /// screen pixel at <paramref name="metresPerPixel"/>, clamped to what the
        /// bake wrote.
        /// </summary>
        public static int Zoom(double metresPerPixel, Func<int, int> texelsAt, int zoomMin, int zoomMax)
        {
            for (int z = zoomMin; z <= zoomMax; z++)
            {
                if (TexelMetres(z, texelsAt(z)) <= metresPerPixel) return z;
            }
            return zoomMax;
        }

        /// <summary>placeMapTile.</summary>
        public static MapTilePlacement Place(TileKey id, double latDeg, double lonDeg)
        {
            LonLatBounds b = Tiling.Bounds(id);
            double mLon = MetresPerDegreeLon(latDeg);
            return new MapTilePlacement
            {
                X = (b.West - lonDeg) * mLon,
                Y = (latDeg - b.North) * MetresPerDegreeLat,
                Width = (b.East - b.West) * mLon,
                Height = (b.North - b.South) * MetresPerDegreeLat,
            };
        }

        /// <summary>mapTilesInView: zoom-<paramref name="z"/> tiles within <paramref name="halfExtentM"/> of the ownship in either axis, row by row from the north-west.</summary>
        public static List<TileKey> TilesInView(int z, double latDeg, double lonDeg, double halfExtentM)
        {
            double dLat = halfExtentM / MetresPerDegreeLat;
            double dLon = halfExtentM / Math.Max(1, MetresPerDegreeLon(latDeg));
            TileRange r = Tiling.RangeForBounds(z, new LonLatBounds(lonDeg - dLon, latDeg - dLat, lonDeg + dLon, latDeg + dLat));
            var output = new List<TileKey>();
            for (int y = r.Y0; y <= r.Y1; y++)
            {
                for (int x = r.X0; x <= r.X1; x++) output.Add(new TileKey(z, x, y));
            }
            return output;
        }

        private static readonly Regex HexColor = new Regex("^#([0-9a-f]{6})\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        /// <summary>parseHexColor: "#rrggbb" (JS-trimmed) into bytes; anything else is black.</summary>
        public static byte[] ParseHexColor(string color)
        {
            Match m = HexColor.Match(JsText.Trim(color ?? ""));
            if (!m.Success) return new byte[] { 0, 0, 0 };
            int v = Convert.ToInt32(m.Groups[1].Value, 16);
            return new[] { (byte)((v >> 16) & 255), (byte)((v >> 8) & 255), (byte)(v & 255) };
        }

        /// <summary>mapTilePixels: the sidecar as opaque RGBA, no-data texels painted <paramref name="water"/>.</summary>
        public static byte[] TilePixels(PtxTile tile, byte[] water)
        {
            byte[] src = tile.Texels;
            var output = new byte[src.Length];
            for (int o = 0; o + 3 < src.Length; o += 4)
            {
                if (src[o + 3] == PtxCodec.NoData)
                {
                    output[o] = water[0];
                    output[o + 1] = water[1];
                    output[o + 2] = water[2];
                }
                else
                {
                    output[o] = src[o];
                    output[o + 1] = src[o + 1];
                    output[o + 2] = src[o + 2];
                }
                output[o + 3] = 255;
            }
            return output;
        }
    }

    /// <summary>
    /// movingMap.ts MovingMapRenderer: the far-tile cover rasters drawn under
    /// the tactical scope as a heading-up chart centred on the aircraft. Each
    /// sidecar is turned into a raster once (no-data texels painted the
    /// palette's water) and cached; the frame places every tile in view in a
    /// flat metres frame around the ownship and lets the painter's transform
    /// rotate and scale it. Tiles not resident yet are asked for and, until
    /// they arrive, the nearest cached ancestor is drawn in their place.
    /// </summary>
    public sealed class MovingMapRenderer
    {
        private readonly IMapTileSource source;
        private readonly IMapRasterFactory rasters;

        // The TS Map's insertion order, least recent first.
        private readonly LinkedList<KeyValuePair<string, object>> order = new LinkedList<KeyValuePair<string, object>>();
        private readonly Dictionary<string, LinkedListNode<KeyValuePair<string, object>>> cache =
            new Dictionary<string, LinkedListNode<KeyValuePair<string, object>>>();

        public MovingMapRenderer(IMapTileSource source, IMapRasterFactory rasters)
        {
            this.source = source;
            this.rasters = rasters;
        }

        /// <summary>Rasters currently cached.</summary>
        public int CachedRasters => cache.Count;

        /// <summary>Drop every cached raster (Release is called on each).</summary>
        public void Clear()
        {
            foreach (KeyValuePair<string, object> e in order) rasters?.Release(e.Value);
            order.Clear();
            cache.Clear();
        }

        private struct Placed
        {
            public TileKey Id;
            public object Raster;
        }

        /// <summary>
        /// render: draw the map into whatever clip the caller has set. Tiles at
        /// the chosen zoom that are not cached yet fall back to their nearest
        /// cached ancestor, drawn first so a finer sibling paints over it.
        /// </summary>
        public void Render(ICanvasPainter painter, in MovingMapView view)
        {
            int min = source.ZoomMin, max = source.ZoomMax;
            if (max < min) return;
            double metresPerPixel = 1 / view.PixelsPerMetre;
            int z = MovingMapGeometry.Zoom(metresPerPixel, source.TexelsAt, min, max);
            // The square rotates, so its corners reach sqrt(2) further than its edges.
            double halfExtentM = view.HalfExtentPx * metresPerPixel * Math.Sqrt(2);
            List<TileKey> wanted = MovingMapGeometry.TilesInView(z, view.LatDeg, view.LonDeg, halfExtentM);

            var fine = new List<Placed>();
            var coarse = new List<Placed>();
            var coarseKeys = new HashSet<string>();
            foreach (TileKey id in wanted)
            {
                object raster = RasterFor(id, view.WaterColor, true);
                if (raster != null)
                {
                    fine.Add(new Placed { Id = id, Raster = raster });
                    continue;
                }
                for (TileKey? p = Tiling.Parent(id); p.HasValue && p.Value.Z >= min; p = Tiling.Parent(p.Value))
                {
                    string key = p.Value.ToString();
                    if (coarseKeys.Contains(key)) break;
                    object c = RasterFor(p.Value, view.WaterColor, false);
                    if (c != null)
                    {
                        coarseKeys.Add(key);
                        coarse.Add(new Placed { Id = p.Value, Raster = c });
                        break;
                    }
                }
            }

            painter.PushTransform(view.CenterX, view.CenterY, -view.HeadingDeg * Math.PI / 180, view.PixelsPerMetre);
            foreach (Placed t in coarse) Draw(painter, t, view);
            foreach (Placed t in fine) Draw(painter, t, view);
            painter.PopTransform();
        }

        private static void Draw(ICanvasPainter painter, Placed t, in MovingMapView view)
        {
            MapTilePlacement place = MovingMapGeometry.Place(t.Id, view.LatDeg, view.LonDeg);
            painter.Image(t.Raster, place.X, place.Y, place.Width, place.Height);
        }

        private object RasterFor(TileKey id, string waterColor, bool fetch)
        {
            string key = id + "|" + waterColor;
            if (cache.TryGetValue(key, out LinkedListNode<KeyValuePair<string, object>> node))
            {
                // Re-insert so the iteration order stays least-recent first.
                order.Remove(node);
                order.AddLast(node);
                return node.Value.Value;
            }
            PtxTile tile = source.Sidecar(id, fetch ? MovingMapGeometry.Priority : 0);
            if (tile == null) return null;
            byte[] rgba = MovingMapGeometry.TilePixels(tile, MovingMapGeometry.ParseHexColor(waterColor));
            object raster = rasters != null ? rasters.Create(id, tile.Size, rgba) : rgba;
            if (raster == null) return null;
            cache[key] = order.AddLast(new KeyValuePair<string, object>(key, raster));
            while (cache.Count > MovingMapGeometry.RasterCache)
            {
                LinkedListNode<KeyValuePair<string, object>> oldest = order.First;
                order.RemoveFirst();
                cache.Remove(oldest.Value.Key);
                rasters?.Release(oldest.Value.Value);
            }
            return raster;
        }
    }
}

using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    public enum HeightTier
    {
        Fine,
        Coarse,
        None,
    }

    /// <summary>The rail/road bed clamp the sampler applies last (railBedField.ts); optional.</summary>
    public interface IBedClamp
    {
        double Clamp(double lon, double lat, double height);
    }

    public sealed class HeightSamplerOptions
    {
        public EnuBasis Basis;
        public double SeaLevel;
        public int QueryZoom;
        public int CoarseZoom;
        public IEnumerable<FlattenPad> Pads;
        public Func<TileKey, DemTile> Fine;
        public Func<TileKey, DemTile> Coarse;
        public IBedClamp RailBeds;
    }

    /// <summary>
    /// The single height read path shared by rendering, shadows and physics
    /// (port of heightSampler.ts): DEM bilinear at the query zoom, else the
    /// coarse tier, else sea level; then airfield pads and bed clamping, all on
    /// the true geodetic point under a scene (e, n).
    /// </summary>
    public sealed class HeightSampler
    {
        public const double WaterHeightEpsM = 0.5;

        public readonly EnuBasis Basis;
        public readonly double SeaLevel;
        public readonly int QueryZoom;
        public readonly int CoarseZoom;

        private PadGrid pads;
        private readonly IBedClamp railBeds;
        private readonly Func<TileKey, DemTile> fine;
        private readonly Func<TileKey, DemTile> coarse;

        public HeightSampler(HeightSamplerOptions opts)
        {
            Basis = opts.Basis;
            SeaLevel = opts.SeaLevel;
            QueryZoom = opts.QueryZoom;
            CoarseZoom = opts.CoarseZoom;
            pads = new PadGrid(opts.Pads ?? Array.Empty<FlattenPad>());
            railBeds = opts.RailBeds;
            fine = opts.Fine;
            coarse = opts.Coarse;
        }

        public void SetPads(IEnumerable<FlattenPad> list) => pads = new PadGrid(list);

        /// <summary>Scene Y of the ground under ENU (e, n), curvature included.</summary>
        public double HeightAtEnu(double e, double n)
        {
            Geodetic g = GroundAtEnu(e, n, out double h);
            return Geodesy.EcefToEnu(Basis, Geodesy.GeodeticToEcef(g.Lat, g.Lon, h)).U;
        }

        /// <summary>Ellipsoidal height of the ground under ENU (e, n).</summary>
        public double GeodeticHeightAtEnu(double e, double n)
        {
            GroundAtEnu(e, n, out double h);
            return h;
        }

        private Geodetic GroundAtEnu(double e, double n, out double height)
        {
            double h = 0;
            Geodetic g = Geodesy.GeodeticOnSurfaceAtEnu(Basis, e, n, (lat, lon) =>
            {
                h = SurfaceHeight(e, n, lon, lat);
                return h;
            });
            height = h;
            return g;
        }

        public double GeodeticAltitudeAtEnu(double e, double n, double u) => Geodesy.EnuToGeodeticApprox(Basis, e, n, u).Height;

        public bool IsLandEnu(double e, double n) => GeodeticHeightAtEnu(e, n) > SeaLevel + WaterHeightEpsM;

        private double SurfaceHeight(double e, double n, double lon, double lat)
        {
            double raw = HeightAtLonLat(lon, lat);
            if (IsWaterHeight(raw, SeaLevel) && !InPadCore(e, n)) return raw;
            double h = raw;
            IReadOnlyList<FlattenPad> cell = pads.At(e, n);
            if (cell != null)
            {
                for (int i = 0; i < cell.Count; i++) h = FlattenPads.Apply(h, e, n, cell[i]);
            }
            return railBeds != null ? railBeds.Clamp(lon, lat, h) : h;
        }

        private bool InPadCore(double e, double n)
        {
            IReadOnlyList<FlattenPad> cell = pads.At(e, n);
            if (cell == null) return false;
            for (int i = 0; i < cell.Count; i++)
            {
                if (FlattenPads.BlendWeight(e, n, cell[i]) >= 1) return true;
            }
            return false;
        }

        public double HeightAtLonLat(double lon, double lat)
        {
            if (TryTile(QueryZoom, lon, lat, fine, out TileKey fid, out DemTile ft))
            {
                double h = SampleAt(ft, fid, lon, lat);
                if (!double.IsNaN(h) && !double.IsInfinity(h)) return h;
            }
            if (TryTile(CoarseZoom, lon, lat, coarse, out TileKey cid, out DemTile ct))
            {
                double h = SampleAt(ct, cid, lon, lat);
                if (!double.IsNaN(h) && !double.IsInfinity(h)) return h;
            }
            return SeaLevel;
        }

        /// <summary>Which tier answers here; physics refuses to kill on a coarse guess.</summary>
        public HeightTier TierAtEnu(double e, double n)
        {
            Geodetic g = Geodesy.GeodeticOnSurfaceAtEnu(Basis, e, n);
            if (TryTile(QueryZoom, g.Lon, g.Lat, fine, out _, out _)) return HeightTier.Fine;
            return TryTile(CoarseZoom, g.Lon, g.Lat, coarse, out _, out _) ? HeightTier.Coarse : HeightTier.None;
        }

        public string FineTileKeyAtEnu(double e, double n)
        {
            Geodetic g = Geodesy.GeodeticOnSurfaceAtEnu(Basis, e, n);
            return Tiling.AtLonLat(QueryZoom, g.Lon, g.Lat).ToString();
        }

        private static bool TryTile(int z, double lon, double lat, Func<TileKey, DemTile> lookup, out TileKey id, out DemTile tile)
        {
            id = Tiling.AtLonLat(z, lon, lat);
            tile = lookup(id);
            return tile != null;
        }

        public static bool IsWaterHeight(double h, double seaLevel) =>
            double.IsNaN(h) || double.IsInfinity(h) || h <= seaLevel + WaterHeightEpsM;

        private static double SampleAt(DemTile tile, TileKey id, double lon, double lat)
        {
            LonLatBounds b = Tiling.Bounds(id);
            double u = (lon - b.West) / (b.East - b.West);
            double v = (b.North - lat) / (b.North - b.South);
            return DemCodec.SampleBilinear(tile, u, v);
        }
    }
}

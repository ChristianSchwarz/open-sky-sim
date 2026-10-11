using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Retro.Core;
using Retro.Sim;
using Retro.Terrain;

namespace Retro.Unity
{
    /// <summary>
    /// The collision surface the combat sim flies over (heightField.ts plus the
    /// worker's heightMirror.ts in one, since the sim runs on this thread): the
    /// coarse DEM tier resident from boot, the fine tier streamed around the
    /// aircraft off-thread, airfield pads on top, all through the shared
    /// <see cref="HeightSampler"/>.
    /// </summary>
    public sealed class DemHeightField : ISimHeightField
    {
        /// <summary>The fine tier kept around each focus point (m), lead included.</summary>
        public const double FocusRadiusM = 8000;
        /// <summary>Pads farther than this from the frame origin are left out (game.ts boot filter).</summary>
        public const double PadReachM = 400000;

        private readonly string root;
        private readonly TileIndex index;
        private readonly TileCache<DemTile> fine;
        private readonly Dictionary<TileKey, DemTile> coarse = new Dictionary<TileKey, DemTile>();
        private readonly HeightSampler sampler;

        public readonly EnuBasis Basis;
        public readonly double SeaLevel;

        public HeightSampler Sampler => sampler;
        public int FineResident => fine.Count;
        public int FineInFlight => fine.InFlight;
        public int CoarseResident => coarse.Count;

        public DemHeightField(string root, EnuBasis basis, double seaLevel, int queryZoom, int coarseZoom,
            IEnumerable<FlattenPadRecord> pads, long fineBudgetBytes = 48L << 20)
        {
            this.root = root;
            Basis = basis;
            SeaLevel = seaLevel;
            index = TileIndex.Decode(File.ReadAllBytes(Path.Combine(root, "index.bin")));
            fine = new TileCache<DemTile>(
                k => Path.Combine(root, k.Z.ToString(), k.X.ToString(), k.Y + ".pdm"),
                TileFile.Pdm,
                t => (long)t.Heights.Length * 4 + 64,
                fineBudgetBytes);

            (double, double) ToEnu(double lat, double lon)
            {
                Enu enu = Geodesy.EcefToEnu(basis, Geodesy.GeodeticToEcef(lat, lon, 0));
                return (enu.E, enu.N);
            }
            List<FlattenPad> padList = (pads ?? Enumerable.Empty<FlattenPadRecord>())
                .Select(p => FlattenPads.FromRecord(p, ToEnu))
                .Where(p => JsMath.Hypot(p.CenterX, p.CenterZ) - FlattenPads.ReachM(p) <= PadReachM)
                .ToList();

            sampler = new HeightSampler(new HeightSamplerOptions
            {
                Basis = basis,
                SeaLevel = seaLevel,
                QueryZoom = queryZoom,
                CoarseZoom = coarseZoom,
                Pads = padList,
                // Peek: a height read must not reorder the cache's eviction.
                Fine = id => fine.Peek(id),
                Coarse = id => coarse.TryGetValue(id, out DemTile t) ? t : null,
            });
            LoadCoarse(coarseZoom);
        }

        /// <summary>The coarse tier in full, synchronously: a handful of small tiles.</summary>
        private void LoadCoarse(int z)
        {
            foreach (TileKey id in index.TilesAt(z))
            {
                string path = Path.Combine(root, id.Z.ToString(), id.X.ToString(), id.Y + ".pdm");
                if (File.Exists(path)) coarse[id] = TileFile.Pdm(File.ReadAllBytes(path));
            }
        }

        /// <summary>
        /// Ask for the fine tier around these scene points (the aircraft, and
        /// where it will be shortly). Call every frame; loads finish off-thread.
        /// </summary>
        public void Focus(IEnumerable<Vec3d> points)
        {
            fine.NextGeneration();
            var wants = new List<(TileKey, double)>();
            var seen = new HashSet<TileKey>();
            double priority = 1;
            foreach (Vec3d p in points)
            {
                foreach (TileKey id in FineTileIdsAround(p.X, p.Z, FocusRadiusM))
                {
                    if (!seen.Add(id)) continue;
                    if (!index.Has(id)) continue;
                    // Touch resident tiles so this round's eviction keeps them.
                    if (fine.Get(id) == null) wants.Add((id, priority));
                }
                priority *= 0.5;
            }
            fine.SetWants(wants);
            fine.Pump();
        }

        /// <summary>Blocks until no fine load is in flight (spawn only).</summary>
        public void WaitIdle(TimeSpan timeout)
        {
            fine.WaitIdle(timeout);
            fine.Pump();
        }

        private IEnumerable<TileKey> FineTileIdsAround(double x, double z, double radiusM)
        {
            Geodetic c = Geodesy.GeodeticOnSurfaceAtEnu(Basis, x, -z);
            double dLat = radiusM / 110540;
            double dLon = radiusM / (111320 * Math.Max(0.1, Math.Cos(c.Lat * Math.PI / 180)));
            int zoom = sampler.QueryZoom;
            double span = 180.0 / (1 << zoom);
            int x0 = (int)Math.Floor((c.Lon - dLon + 180) / span);
            int x1 = (int)Math.Floor((c.Lon + dLon + 180) / span);
            int y0 = (int)Math.Floor((90 - (c.Lat + dLat)) / span);
            int y1 = (int)Math.Floor((90 - (c.Lat - dLat)) / span);
            for (int ty = y0; ty <= y1; ty++)
            {
                for (int tx = x0; tx <= x1; tx++) yield return new TileKey(zoom, tx, ty);
            }
        }

        // --- ISimHeightField (scene x east, z south; ENU n = -z) ---------------------

        public double HeightAtWorld(double x, double z) => sampler.HeightAtEnu(x, -z);

        public double GeodeticAltitudeAtWorld(double x, double y, double z) => sampler.GeodeticAltitudeAtEnu(x, -z, y);

        public bool IsLandAtWorld(double x, double z) => sampler.IsLandEnu(x, -z);

        /// <summary>The fine tile is resident, or there is none to have.</summary>
        public bool IsAuthoritativeAt(double x, double z)
        {
            if (sampler.TierAtEnu(x, -z) == HeightTier.Fine) return true;
            Geodetic g = Geodesy.GeodeticOnSurfaceAtEnu(Basis, x, -z);
            TileKey id = Tiling.AtLonLat(sampler.QueryZoom, g.Lon, g.Lat);
            return !index.Has(id) || fine.IsAbsent(id);
        }

        public HeightTier TierAtWorld(double x, double z) => sampler.TierAtEnu(x, -z);
    }
}

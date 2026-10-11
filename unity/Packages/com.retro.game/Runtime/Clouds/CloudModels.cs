using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// What a scenery field needs from a model (models.ts Model, as LODHelper reads it): the
    /// screen-size LOD inputs and which levels draw anything. Geometry is in model space, metres,
    /// scene axes (x east, y up, z south), origin at the cluster's base centre.
    /// </summary>
    public abstract class SkyModel
    {
        /// <summary>The lib name, e.g. "cloudLarge" (models are asked for as "lib:" + name).</summary>
        public string Name { get; }

        /// <summary>Model.maxSize: the LOD size, metres (0 = always LOD 0, the empty kinds).</summary>
        public double MaxSize { get; protected set; }

        /// <summary>Model.center.y (center is (0, CenterY, 0)).</summary>
        public double CenterY { get; protected set; }

        /// <summary>model.lod.length.</summary>
        public abstract int LodCount { get; }

        protected SkyModel(string name)
        {
            Name = name;
        }

        /// <summary>Whether LOD level `lod` carries any mesh (lodLevelHasGeometry).</summary>
        public abstract bool LevelHasGeometry(int lod);

        /// <summary>Triangles a draw at `lod` submits (countObjectTriangles over its meshes), for budgets/HUD.</summary>
        public abstract int Triangles(int lod);
    }

    /// <summary>
    /// A cumulus cluster (cloudModelBuilder.ts CloudModelLibBuilder.build): a solid, smooth-shaded
    /// body plus one haze buffer whose prefixes make the four LOD levels.
    /// </summary>
    public sealed class CloudModel : SkyModel
    {
        /// <summary>HAZE_SCATTER_HALF_ANGLE: top growth puffs scatter within this angle off straight-up.</summary>
        public static readonly double HazeScatterHalfAngle = Math.PI * 0.3;

        /// <summary>HAZE_SIDE_MAX_ANGLE: side puffs stop short of the horizon.</summary>
        public static readonly double HazeSideMaxAngle = Math.PI * 0.4;

        /// <summary>One haze density band (cloudModelBuilder.ts HazeTier).</summary>
        public readonly struct HazeTier
        {
            public readonly int PuffsPerLobe;
            /// <summary>Opaque share of the stipple (fraction of pixels kept), stored per vertex.</summary>
            public readonly double AlphaDither;
            public readonly double DistMin, DistMax, RadiusMin, RadiusMax, ThetaMin, ThetaMax;

            public HazeTier(int puffs, double alphaDither, double distMin, double distMax, double radiusMin, double radiusMax,
                double? thetaMin = null, double? thetaMax = null)
            {
                PuffsPerLobe = puffs;
                AlphaDither = alphaDither;
                DistMin = distMin;
                DistMax = distMax;
                RadiusMin = radiusMin;
                RadiusMax = radiusMax;
                ThetaMin = thetaMin ?? 0;
                ThetaMax = thetaMax ?? HazeScatterHalfAngle;
            }
        }

        /// <summary>HAZE_TIERS, densest/closest first: eight top tiers, then four side tiers.</summary>
        public static readonly HazeTier[] HazeTiers =
        {
            new HazeTier(4, 0.98, 0.15, 0.28, 0.45, 0.65),
            new HazeTier(4, 0.95, 0.25, 0.4, 0.4, 0.6),
            new HazeTier(4, 0.88, 0.35, 0.5, 0.35, 0.55),
            new HazeTier(5, 0.75, 0.5, 0.68, 0.3, 0.48),
            new HazeTier(5, 0.6, 0.68, 0.88, 0.26, 0.42),
            new HazeTier(4, 0.45, 0.88, 1.08, 0.2, 0.34),
            new HazeTier(4, 0.3, 1.08, 1.3, 0.15, 0.28),
            new HazeTier(3, 0.18, 1.3, 1.6, 0.12, 0.22),
            new HazeTier(5, 0.7, 0.55, 0.75, 0.28, 0.44, HazeScatterHalfAngle, HazeSideMaxAngle),
            new HazeTier(5, 0.5, 0.75, 0.98, 0.22, 0.36, HazeScatterHalfAngle, HazeSideMaxAngle),
            new HazeTier(4, 0.3, 0.98, 1.2, 0.17, 0.28, HazeScatterHalfAngle, HazeSideMaxAngle),
            new HazeTier(3, 0.18, 1.2, 1.5, 0.14, 0.24, HazeScatterHalfAngle, HazeSideMaxAngle),
        };

        /// <summary>LOD_HAZE_TIER_COUNTS: haze tiers drawn per LOD level, closest first.</summary>
        public static readonly int[] LodHazeTierCounts = { 12, 8, 3, 0 };

        /// <summary>Growth puffs reach ~1.6r out plus their own radius; the bound pads to 1.9r.</summary>
        public const double HazeReach = 1.9;

        /// <summary>Solid body: welded vertices (xyz float32), smooth normals, triangle list. Empty for cloudNone.</summary>
        public float[] SolidPositions { get; }
        public float[] SolidNormals { get; }
        public int[] SolidIndices { get; }

        /// <summary>
        /// Haze: non-indexed triangle soup of detail-0 icosahedron puffs (60 vertices each), all
        /// twelve tiers in HazeTiers order, flat face normals, and each vertex's tier alphaDither
        /// (float32) in HazeDitherLevel.
        /// </summary>
        public float[] HazePositions { get; }
        public float[] HazeNormals { get; }
        public float[] HazeDitherLevel { get; }

        /// <summary>Vertex count at the end of each tier in the haze buffer (12 entries).</summary>
        public int[] HazeTierEnds { get; }

        /// <summary>Haze vertices LOD level `lod` draws: a prefix of the buffer (0 at LOD 3).</summary>
        public int HazeVertexCount(int lod)
        {
            int tiers = LodHazeTierCounts[lod];
            return tiers == 0 ? 0 : HazeTierEnds[tiers - 1];
        }

        public bool IsEmpty => SolidIndices.Length == 0;

        public override int LodCount => IsEmpty ? 1 : LodHazeTierCounts.Length;

        public override bool LevelHasGeometry(int lod) => !IsEmpty && lod >= 0 && lod < LodCount;

        public override int Triangles(int lod) => LevelHasGeometry(lod) ? SolidIndices.Length / 3 + HazeVertexCount(lod) / 3 : 0;

        public CloudModel(string name, IReadOnlyList<CloudPuffLobe> lobes) : base(name)
        {
            if (lobes.Count == 0)
            {
                SolidPositions = SolidNormals = HazePositions = HazeNormals = HazeDitherLevel = Array.Empty<float>();
                SolidIndices = Array.Empty<int>();
                HazeTierEnds = new int[HazeTiers.Length];
                MaxSize = 0;
                CenterY = 0;
                return;
            }

            double baseY = double.PositiveInfinity;
            foreach (CloudPuffLobe l in lobes) baseY = Math.Min(baseY, l.Y);

            var parts = new List<float[]>(lobes.Count);
            foreach (CloudPuffLobe l in lobes)
            {
                float[] g = ThreeGeometry.Icosahedron(l.R, 2);
                FlattenBase(g, baseY - l.Y);
                ThreeGeometry.Translate(g, l.X, l.Y, l.Z);
                parts.Add(g);
            }
            (SolidPositions, SolidIndices) = ThreeGeometry.MergeVertices(ThreeGeometry.Concat(parts));
            SolidNormals = ThreeGeometry.IndexedNormals(SolidPositions, SolidIndices);

            var tiers = new List<float[]>(HazeTiers.Length);
            for (int i = 0; i < HazeTiers.Length; i++) tiers.Add(BuildHazeTier(lobes, HazeTiers[i], i, baseY));
            HazePositions = ThreeGeometry.Concat(tiers);
            HazeNormals = ThreeGeometry.SoupNormals(HazePositions);
            HazeDitherLevel = new float[HazePositions.Length / 3];
            HazeTierEnds = new int[HazeTiers.Length];
            int end = 0;
            for (int i = 0; i < tiers.Count; i++)
            {
                int count = tiers[i].Length / 3;
                for (int v = end; v < end + count; v++) HazeDitherLevel[v] = (float)HazeTiers[i].AlphaDither;
                end += count;
                HazeTierEnds[i] = end;
            }

            double maxRadius = 0, maxY = 0;
            foreach (CloudPuffLobe l in lobes)
            {
                maxRadius = Math.Max(maxRadius, JsMath.Hypot(l.X, l.Z) + l.R * HazeReach);
                maxY = Math.Max(maxY, l.Y + l.R * HazeReach);
            }
            MaxSize = 2 * maxRadius;
            CenterY = maxY / 2;
        }

        /// <summary>flattenBase: squash every vertex below the cluster's base plane onto it.</summary>
        private static void FlattenBase(float[] positions, double localFlattenY)
        {
            for (int i = 1; i < positions.Length; i += 3)
            {
                if (positions[i] < localFlattenY) positions[i] = (float)localFlattenY;
            }
        }

        /// <summary>hash01: deterministic [0,1) from sin, so a shape is stable across rebuilds.</summary>
        public static double Hash01(double n)
        {
            double s = JsTrig.Sin(n * 12.9898) * 43758.5453;
            return s - Math.Floor(s);
        }

        /// <summary>buildHazeTierGeometry: puffsPerLobe detail-0 icosahedra per lobe, kept above the base.</summary>
        private static float[] BuildHazeTier(IReadOnlyList<CloudPuffLobe> lobes, HazeTier tier, int tierIndex, double minY)
        {
            var puffs = new List<float[]>(lobes.Count * tier.PuffsPerLobe);
            for (int li = 0; li < lobes.Count; li++)
            {
                CloudPuffLobe l = lobes[li];
                for (int i = 0; i < tier.PuffsPerLobe; i++)
                {
                    double seed = li * 131 + tierIndex * 977 + i;
                    double theta = tier.ThetaMin + Hash01(seed * 1.7) * (tier.ThetaMax - tier.ThetaMin);
                    double phi = Hash01(seed * 3.1 + 11) * Math.PI * 2;
                    double dirX = JsTrig.Sin(theta) * JsTrig.Cos(phi);
                    double dirY = JsTrig.Cos(theta);
                    double dirZ = JsTrig.Sin(theta) * JsTrig.Sin(phi);
                    double dist = l.R * (tier.DistMin + Hash01(seed * 5.3 + 3) * (tier.DistMax - tier.DistMin));
                    double puffR = l.R * (tier.RadiusMin + Hash01(seed * 7.9 + 5) * (tier.RadiusMax - tier.RadiusMin));
                    double puffY = Math.Max(l.Y + dirY * dist, minY + puffR * 1.6);
                    float[] g = ThreeGeometry.Icosahedron(puffR, 0);
                    ThreeGeometry.Translate(g, l.X + dirX * dist, puffY, l.Z + dirZ * dist);
                    puffs.Add(g);
                }
            }
            return ThreeGeometry.Concat(puffs);
        }
    }

    /// <summary>
    /// A cirrus streak (cirrusModelBuilder.ts CirrusModelLibBuilder.build): squashed detail-1
    /// icosahedra merged into one unshaded, stippled soup with flat normals; one LOD level.
    /// </summary>
    public sealed class CirrusModel : SkyModel
    {
        /// <summary>The streak material's uniform alphaDither (opaque share of the stipple).</summary>
        public const double AlphaDither = 0.35;

        public float[] Positions { get; }
        public float[] Normals { get; }

        public bool IsEmpty => Positions.Length == 0;

        public override int LodCount => 1;

        public override bool LevelHasGeometry(int lod) => !IsEmpty && lod == 0;

        public override int Triangles(int lod) => LevelHasGeometry(lod) ? Positions.Length / 9 : 0;

        public CirrusModel(string name, IReadOnlyList<CirrusWisp> wisps) : base(name)
        {
            if (wisps.Count == 0)
            {
                Positions = Normals = Array.Empty<float>();
                return;
            }
            var parts = new List<float[]>(wisps.Count);
            foreach (CirrusWisp w in wisps)
            {
                float[] g = ThreeGeometry.Icosahedron(1, 1);
                ThreeGeometry.Scale(g, w.Length / 2, w.Height / 2, w.Width / 2);
                ThreeGeometry.Translate(g, w.X, w.Y, w.Z);
                parts.Add(g);
            }
            Positions = ThreeGeometry.Concat(parts);
            Normals = ThreeGeometry.SoupNormals(Positions);

            double maxRadius = 0, maxY = 0;
            foreach (CirrusWisp w in wisps)
            {
                double reach = Math.Max(w.Length, w.Width) / 2;
                maxRadius = Math.Max(maxRadius, JsMath.Hypot(w.X, w.Z) + reach);
                maxY = Math.Max(maxY, w.Y + w.Height / 2);
            }
            MaxSize = 2 * maxRadius;
            CenterY = maxY / 2;
        }
    }

    /// <summary>
    /// The seven sky models index.ts registers (lib:cloudNone/Small/Medium/Large,
    /// lib:cirrusNone/Thin/Wide), built once on first use. Building is pure CPU and thread-safe.
    /// </summary>
    public static class SkyModels
    {
        private static readonly Lazy<Dictionary<string, SkyModel>> All = new Lazy<Dictionary<string, SkyModel>>(() =>
        {
            var models = new SkyModel[]
            {
                new CloudModel("cloudNone", Array.Empty<CloudPuffLobe>()),
                new CloudModel("cloudSmall", CloudShapes.Small),
                new CloudModel("cloudMedium", CloudShapes.Medium),
                new CloudModel("cloudLarge", CloudShapes.Large),
                new CirrusModel("cirrusNone", Array.Empty<CirrusWisp>()),
                new CirrusModel("cirrusThin", CloudShapes.Thin),
                new CirrusModel("cirrusWide", CloudShapes.Wide),
            };
            var map = new Dictionary<string, SkyModel>();
            foreach (SkyModel m in models) map.Add("lib:" + m.Name, m);
            return map;
        });

        /// <summary>A model by its game URL, e.g. "lib:cloudLarge".</summary>
        public static SkyModel Get(string url) =>
            All.Value.TryGetValue(url, out SkyModel m) ? m : throw new ArgumentException($"no sky model \"{url}\"");
    }
}

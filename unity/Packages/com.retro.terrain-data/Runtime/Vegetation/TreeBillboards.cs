using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// Tree billboards over a tile's forest and shrubland facets (port of treeBillboards.ts,
    /// CPU side): the deterministic scatter, the 4 x 4 cell split, the shuffled slot order the
    /// screen-space thinning keeps a prefix of, the per-instance attributes, and how many instances
    /// to submit per frame. No bake stage: the PTM land attributes already carry a TerrainClass per
    /// triangle.
    /// </summary>
    public static class TreeBillboards
    {
        /// <summary>TerrainClass.Tree / TerrainClass.Shrub.</summary>
        public const int TreeClass = 1;
        public const int ShrubClass = 2;
        /// <summary>One forest tree per this many square metres.</summary>
        public const double TreeSpacingM2 = 200;
        /// <summary>One shrub per this many square metres of shrubland.</summary>
        public const double ShrubSpacingM2 = 60;
        public const double ShrubScale = 0.22;
        public const double BushScale = 0.5;
        /// <summary>Per-tile instance ceiling at density 1, scaled by max(1, density).</summary>
        public const int TotalTreeSafetyCap = 8000;
        /// <summary>Billboard quad: x in [-5, 5] m, y in [0, 14] m, before the instance scale.</summary>
        public const float TreeHalfWidthM = 5;
        public const float TreeHeightM = 14;

        public const double DensityNearM = 2000;
        public const double DensityFarM = 8000;
        public const double DensityFarScale = 0.08;
        public const double DensityCutoffM = 10000;

        public const double DensityMultiplierMin = 0;
        public const double DensityMultiplierMax = 20;
        public const double DensityMultiplierDefault = 1;

        /// <summary>Cells a side a tile's trees are split into (TREE_CELLS).</summary>
        public const int Cells = 4;
        /// <summary>TREE_MIN_SPACING_PX: trees closer than this on screen are thinned.</summary>
        public const double MinSpacingPx = 3;
        /// <summary>TREE_MAX_GROW: largest scale a kept tree takes to cover for dropped neighbours.</summary>
        public const double MaxGrow = 1.6;
        /// <summary>TREE_THIN_FADE: share of the keep fraction over which a cut tree shrinks to nothing.</summary>
        public const double ThinFade = 0.25;

        /// <summary>The billboard quad's four corners (x, y, z) and uv, indexed 0-1-2, 0-2-3. v = 1 at the ground.</summary>
        public static readonly float[] QuadPositions = { -TreeHalfWidthM, 0, 0, TreeHalfWidthM, 0, 0, TreeHalfWidthM, TreeHeightM, 0, -TreeHalfWidthM, TreeHeightM, 0 };
        public static readonly float[] QuadUvs = { 0, 1, 1, 1, 1, 0, 0, 0 };
        public static readonly int[] QuadIndices = { 0, 1, 2, 0, 2, 3 };

        /// <summary>treeDensityScaleForDistance: 1 near, linear to 0.08 at 8 km, 0 past 10 km.</summary>
        public static double DensityScaleForDistance(double distanceM)
        {
            if (distanceM <= DensityNearM) return 1;
            if (distanceM >= DensityCutoffM) return 0;
            if (distanceM >= DensityFarM) return DensityFarScale;
            double t = (distanceM - DensityNearM) / (DensityFarM - DensityNearM);
            return 1 + (DensityFarScale - 1) * t;
        }

        /// <summary>clampTreeDensityMultiplier: the user setting, 0..20, non-finite = 1.</summary>
        public static double ClampDensityMultiplier(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) return DensityMultiplierDefault;
            return Math.Min(DensityMultiplierMax, Math.Max(DensityMultiplierMin, value));
        }

        /// <summary>treeSpacingM: average metres between trees at this density.</summary>
        public static double SpacingM(double densityScale)
        {
            return Math.Sqrt(TreeSpacingM2 / Math.Max(densityScale, 1e-3));
        }

        /// <summary>
        /// The density a tile is scattered at (terrainEntity.ts treeScaleFor): its distance from the
        /// LOD camera to the tile origin (tileOriginWorld at the tile's centre height), thinned,
        /// times the user multiplier.
        /// </summary>
        public static double TileDensityScale(double cameraToTileOriginM, double userMultiplier)
        {
            return DensityScaleForDistance(cameraToTileOriginM) * userMultiplier;
        }

        /// <summary>
        /// Whether a tile scattered at <paramref name="had"/> should be rescattered at
        /// <paramref name="want"/> (syncGroup): crossing the cutoff either way, or a change past
        /// a factor of 1.6.
        /// </summary>
        public static bool NeedsRescatter(double want, double had)
        {
            return (want == 0) != (had == 0) || (want > 0 && (want > had * 1.6 || want < had / 1.6));
        }

        /// <summary>
        /// scatterTreeSpecies: points over the Tree and Shrub triangles at a fixed density times
        /// <paramref name="densityScale"/>, thinned evenly when the tile would pass the safety cap,
        /// each with its own species. Groups come in first-seen order. <paramref name="excluded"/>
        /// takes tile-local (x, z, y) and drops the point.
        /// </summary>
        public static List<ScatterGroup> ScatterTreeSpecies(PtmTile tile, double densityScale = 1,
            Func<double, double, double, bool> excluded = null)
        {
            int triCount = tile.LandAttrs.Length / 4 / 3;
            var groups = new List<ScatterGroup>();
            var bySpecies = new ScatterGroup[VegetationAtlas.SpeciesCount];
            int total = 0;
            double cap = TotalTreeSafetyCap * Math.Max(1, densityScale);

            double expectedTotal = 0;
            for (int t = 0; t < triCount; t++)
            {
                int c = tile.LandAttrs[t * 3 * 4 + 3];
                if (c != TreeClass && c != ShrubClass) continue;
                expectedTotal += VegetationMath.TriangleArea(VegetationMath.ReadVert(tile, t, 0), VegetationMath.ReadVert(tile, t, 1),
                    VegetationMath.ReadVert(tile, t, 2)) / (c == ShrubClass ? ShrubSpacingM2 : TreeSpacingM2) * densityScale;
            }
            double capScale = expectedTotal > cap ? cap / expectedTotal : 1;

            for (int t = 0; t < triCount; t++)
            {
                int cls = tile.LandAttrs[t * 3 * 4 + 3];
                if (cls != TreeClass && cls != ShrubClass) continue;
                Vec3d v0 = VegetationMath.ReadVert(tile, t, 0);
                Vec3d v1 = VegetationMath.ReadVert(tile, t, 1);
                Vec3d v2 = VegetationMath.ReadVert(tile, t, 2);
                double area = VegetationMath.TriangleArea(v0, v1, v2);
                Vec3d n = VegetationMath.UpNormal(v0, v1, v2);
                double expected = (area / (cls == ShrubClass ? ShrubSpacingM2 : TreeSpacingM2)) * densityScale * capScale;
                double seed = t * 97.13;
                double whole = Math.Floor(expected);
                int count = (int)whole + (VegetationMath.Hash01(seed) < expected - whole ? 1 : 0);

                for (int i = 0; i < count; i++)
                {
                    if (total >= cap) return groups;
                    double r1 = VegetationMath.Hash01(seed + i * 2.371);
                    double r2 = VegetationMath.Hash01(seed + i * 2.371 + 0.5);
                    Vec3d p = VegetationMath.PointInTriangle(v0, v1, v2, r1, r2);
                    if (excluded != null && excluded(p.X, p.Z, p.Y)) continue;
                    int species = cls == ShrubClass
                        ? (int)TreeSpecies.Shrub
                        : (int)Math.Min(Math.Floor(VegetationMath.Hash01(seed + i * 8.923) * VegetationAtlas.TreeSpeciesCount),
                            VegetationAtlas.TreeSpeciesCount - 1);
                    ScatterGroup g = bySpecies[species];
                    if (g == null)
                    {
                        g = bySpecies[species] = new ScatterGroup(species);
                        groups.Add(g);
                    }
                    int a = t * 3 * 4;
                    g.Add(p.X, p.Y, p.Z, tile.LandAttrs[a] / 255.0, tile.LandAttrs[a + 1] / 255.0, tile.LandAttrs[a + 2] / 255.0, n.X, n.Y, n.Z);
                    total++;
                }
            }
            return groups;
        }

        /// <summary>
        /// buildTreeMeshes: every group's points split over a 4 x 4 grid of the points' own x/z
        /// bounds, one draw per non-empty cell in cell order (x fastest), each built like
        /// buildTreeMesh. <paramref name="spacingM"/> is <see cref="SpacingM"/> of the scatter's
        /// density (0 turns the screen-space thinning off).
        /// </summary>
        public static List<BillboardInstances> BuildCells(IReadOnlyList<ScatterGroup> groups, double spacingM = 0)
        {
            double minX = double.PositiveInfinity, maxX = double.NegativeInfinity;
            double minZ = double.PositiveInfinity, maxZ = double.NegativeInfinity;
            foreach (ScatterGroup g in groups)
            {
                for (int k = 0; k < g.Points.Count; k += 3)
                {
                    minX = Math.Min(minX, g.Points[k]);
                    maxX = Math.Max(maxX, g.Points[k]);
                    minZ = Math.Min(minZ, g.Points[k + 2]);
                    maxZ = Math.Max(maxZ, g.Points[k + 2]);
                }
            }
            const int n = Cells;
            var cells = new List<ScatterGroup>[n * n];
            for (int c = 0; c < cells.Length; c++) cells[c] = new List<ScatterGroup>();
            double sx = n / Math.Max(maxX - minX, 1e-6), sz = n / Math.Max(maxZ - minZ, 1e-6);
            foreach (ScatterGroup g in groups)
            {
                var split = new ScatterGroup[n * n];
                for (int k = 0; k < g.Count; k++)
                {
                    double px = g.Points[k * 3], pz = g.Points[k * 3 + 2];
                    int c = (int)(Math.Min(n - 1, Math.Floor((px - minX) * sx)) + n * Math.Min(n - 1, Math.Floor((pz - minZ) * sz)));
                    ScatterGroup s = split[c];
                    if (s == null)
                    {
                        s = split[c] = new ScatterGroup(g.Kind);
                        cells[c].Add(s);
                    }
                    s.Add(px, g.Points[k * 3 + 1], pz, g.Tints[k * 3], g.Tints[k * 3 + 1], g.Tints[k * 3 + 2],
                        g.Normals[k * 3], g.Normals[k * 3 + 1], g.Normals[k * 3 + 2]);
                }
            }
            var result = new List<BillboardInstances>();
            foreach (List<ScatterGroup> cell in cells)
            {
                if (cell.Count > 0) result.Add(BuildMesh(cell, spacingM));
            }
            return result;
        }

        private static readonly (Vec3d Center, double Radius) QuadSphere = VegetationMath.GeometrySphere(new float[]
        {
            -TreeHalfWidthM, 0, 0, TreeHalfWidthM, 0, 0, TreeHalfWidthM, TreeHeightM, 0, -TreeHalfWidthM, TreeHeightM, 0,
        });

        /// <summary>
        /// buildTreeMesh: one draw's instances in shuffled slot order, with the per-instance size
        /// jitter (x0.85..1.15, shrubs x0.22, bushes x0.5) and shade (a = (0.3..0.6) * 0.72).
        /// </summary>
        public static BillboardInstances BuildMesh(IReadOnlyList<ScatterGroup> groups, double spacingM = 0)
        {
            int count = 0;
            foreach (ScatterGroup g in groups) count += g.Count;
            uint[] slot = VegetationMath.ShuffledSlots(count);
            var m = new BillboardInstances
            {
                Count = count,
                Positions = new float[count * 3],
                Scales = new float[count],
                Kinds = new float[count],
                Normals = new float[count * 3],
                Shade = new float[count * 4],
                SpacingM = spacingM,
                InvCount = 1.0 / Math.Max(1, count),
                Total = count,
            };
            int i = 0;
            foreach (ScatterGroup g in groups)
            {
                for (int k = 0; k < g.Count; k++, i++)
                {
                    double scale = (0.85 + VegetationMath.Hash01(i * 5.113 + g.Kind * 13.1 + 1) * 0.3)
                        * (g.Kind == (int)TreeSpecies.Shrub ? ShrubScale : g.Kind == (int)TreeSpecies.Bush ? BushScale : 1);
                    int s = (int)slot[i];
                    m.Scales[s] = (float)scale;
                    m.Positions[s * 3] = (float)g.Points[k * 3];
                    m.Positions[s * 3 + 1] = (float)g.Points[k * 3 + 1];
                    m.Positions[s * 3 + 2] = (float)g.Points[k * 3 + 2];
                    m.Kinds[s] = g.Kind;
                    m.Normals[s * 3] = (float)g.Normals[k * 3];
                    m.Normals[s * 3 + 1] = (float)g.Normals[k * 3 + 1];
                    m.Normals[s * 3 + 2] = (float)g.Normals[k * 3 + 2];
                    m.Shade[s * 4] = (float)g.Tints[k * 3];
                    m.Shade[s * 4 + 1] = (float)g.Tints[k * 3 + 1];
                    m.Shade[s * 4 + 2] = (float)g.Tints[k * 3 + 2];
                    m.Shade[s * 4 + 3] = (float)((0.3 + VegetationMath.Hash01(i * 6.451 + g.Kind * 17.3 + 2) * 0.3) * 0.72);
                }
            }
            (m.SphereCenter, m.SphereRadius) = VegetationMath.InstancesSphere(QuadSphere.Center, QuadSphere.Radius, m.Positions, m.Scales, count);
            return m;
        }

        /// <summary>
        /// nearDistanceInTile: how far <paramref name="eye"/> is from a draw's bounding sphere,
        /// both in the same frame (0 inside).
        /// </summary>
        public static double NearDistance(Vec3d sphereCenter, double sphereRadius, Vec3d eye)
        {
            double dx = eye.X - sphereCenter.X, dy = eye.Y - sphereCenter.Y, dz = eye.Z - sphereCenter.Z;
            return Math.Max(0, Math.Sqrt(dx * dx + dy * dy + dz * dz) - sphereRadius);
        }

        /// <summary>
        /// treeInstancesToDraw: how many of a draw's (shuffled) instances to submit - the shader's
        /// keep fraction at the draw's near edge, as a prefix. <paramref name="pixelAngle"/> is
        /// ground metres per pixel per metre of range, 2 tan(fovY / 2) / viewport height px;
        /// <paramref name="nearDistanceM"/> null (no camera) or spacing 0 submits all.
        /// </summary>
        public static int InstancesToDraw(BillboardInstances mesh, double? nearDistanceM, double pixelAngle)
        {
            return InstancesToDraw(mesh.Total, mesh.SpacingM, nearDistanceM, pixelAngle);
        }

        public static int InstancesToDraw(int total, double spacingM, double? nearDistanceM, double pixelAngle)
        {
            if (spacingM <= 0 || nearDistanceM == null) return total;
            double pixelM = nearDistanceM.Value * pixelAngle;
            if (pixelM <= 0) return total;
            double spacingPx = spacingM / pixelM;
            double keep = Math.Min(1, (spacingPx * spacingPx) / (MinSpacingPx * MinSpacingPx));
            return (int)Math.Min(total, Math.Floor(keep * total));
        }

        /// <summary>
        /// The streamer's upload gate: whether any land corner's class is one the tree or clutter
        /// scatter uses, i.e. whether the tile needs a vegetation pass at all.
        /// </summary>
        public static bool HasVegetationSource(PtmTile tile)
        {
            for (int i = 3; i < tile.LandAttrs.Length; i += 4)
            {
                int cls = tile.LandAttrs[i];
                if (cls == TreeClass || cls == ShrubClass || GroundClutter.IsOpenGround(cls)) return true;
            }
            return false;
        }
    }
}

using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// Stones, shrubs, bushes and the odd lone tree over a tile's open ground (port of stones.ts,
    /// CPU side). Grass, Bare, Moss and Ground triangles only; each candidate becomes rock or
    /// vegetation by how green the facet's baked colour is (greenSplit), and green ground is
    /// denser. The vegetation joins the tree draws; the rocks are one draw on the stone atlas.
    /// </summary>
    public static class GroundClutter
    {
        /// <summary>One instance per this many square metres at zero green bias.</summary>
        public const double ClutterSpacingM2 = 35;
        /// <summary>Density multiplier 1 + pGreen * this.</summary>
        public const double GreenDensityBoost = 3;
        /// <summary>Per-tile instance ceiling at density 1, scaled by max(1, density).</summary>
        public const int TotalClutterSafetyCap = 6000;
        /// <summary>Stone quad: x in [-0.45, 0.45] m, y in [0, 0.7] m, before the instance scale.</summary>
        public const float StoneHalfWidthM = 0.45f;
        public const float StoneHeightM = 0.7f;
        public const double GreenBiasDivisor = 0.09;
        public const double GreenTreeThreshold = 0.45;
        public const double GreenTreeMaxShare = 0.5;
        public const double GreenBushThreshold = 0.2;
        public const double GreenBushMaxShare = 0.45;

        /// <summary>The stone quad as two triangles (six vertices, not indexed) and their uv; v = 1 at the ground.</summary>
        public static readonly float[] QuadPositions =
        {
            -StoneHalfWidthM, 0, 0, StoneHalfWidthM, 0, 0, StoneHalfWidthM, StoneHeightM, 0,
            -StoneHalfWidthM, 0, 0, StoneHalfWidthM, StoneHeightM, 0, -StoneHalfWidthM, StoneHeightM, 0,
        };
        public static readonly float[] QuadUvs = { 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0 };

        private static readonly (Vec3d Center, double Radius) QuadSphere = VegetationMath.GeometrySphere(QuadPositions);

        /// <summary>OPEN_GROUND_CLASSES / CLUTTER_ELIGIBLE_CLASSES: Grass 3, Bare 6, Moss 11, Ground 13.</summary>
        public static bool IsOpenGround(int cls) => cls == 3 || cls == 6 || cls == 11 || cls == 13;

        /// <summary>greenSplit: odds of growing anything, of that being a tree, and of a non-tree being a bush.</summary>
        public static (double PGreen, double PTreeGivenGreen, double PBushGivenNotTree) GreenSplit(double r, double g, double b)
        {
            double pGreen = Math.Min(Math.Max((g - Math.Max(r, b)) / GreenBiasDivisor, 0), 1);
            double pTree = Math.Min(Math.Max((pGreen - GreenTreeThreshold) / (1 - GreenTreeThreshold), 0), 1) * GreenTreeMaxShare;
            double pBush = Math.Min(Math.Max((pGreen - GreenBushThreshold) / (1 - GreenBushThreshold), 0), 1) * GreenBushMaxShare;
            return (pGreen, pTree, pBush);
        }

        /// <summary>
        /// scatterGroundClutter: candidates over the open-ground triangles, thinned evenly when the
        /// tile would pass the cap, each turned into a rock (random shape) or vegetation (tree,
        /// bush or shrub) by its facet's colour. <paramref name="excluded"/> takes tile-local
        /// (x, z, y).
        /// </summary>
        public static GroundClutterResult Scatter(PtmTile tile, double densityScale = 1,
            Func<double, double, double, bool> excluded = null)
        {
            int triCount = tile.LandAttrs.Length / 4 / 3;
            var rocks = new List<ScatterGroup>();
            var vegetation = new List<ScatterGroup>();
            var byShape = new ScatterGroup[VegetationAtlas.RockShapeCount];
            var bySpecies = new ScatterGroup[VegetationAtlas.SpeciesCount];
            var result = new GroundClutterResult { Rocks = rocks, Vegetation = vegetation };
            int total = 0;
            double cap = TotalClutterSafetyCap * Math.Max(1, densityScale);

            double expectedTotal = 0;
            for (int t = 0; t < triCount; t++)
            {
                int c = tile.LandAttrs[t * 3 * 4 + 3];
                if (!IsOpenGround(c)) continue;
                int a = t * 3 * 4;
                double pGreen = GreenSplit(tile.LandAttrs[a] / 255.0, tile.LandAttrs[a + 1] / 255.0, tile.LandAttrs[a + 2] / 255.0).PGreen;
                expectedTotal += VegetationMath.TriangleArea(VegetationMath.ReadVert(tile, t, 0), VegetationMath.ReadVert(tile, t, 1),
                    VegetationMath.ReadVert(tile, t, 2)) / ClutterSpacingM2 * densityScale * (1 + pGreen * GreenDensityBoost);
            }
            double capScale = expectedTotal > cap ? cap / expectedTotal : 1;

            for (int t = 0; t < triCount; t++)
            {
                int cls = tile.LandAttrs[t * 3 * 4 + 3];
                if (!IsOpenGround(cls)) continue;
                Vec3d v0 = VegetationMath.ReadVert(tile, t, 0);
                Vec3d v1 = VegetationMath.ReadVert(tile, t, 1);
                Vec3d v2 = VegetationMath.ReadVert(tile, t, 2);
                double area = VegetationMath.TriangleArea(v0, v1, v2);
                Vec3d n = VegetationMath.UpNormal(v0, v1, v2);
                int a = t * 3 * 4;
                double tintR = tile.LandAttrs[a] / 255.0;
                double tintG = tile.LandAttrs[a + 1] / 255.0;
                double tintB = tile.LandAttrs[a + 2] / 255.0;
                var (pGreen, pTreeGivenGreen, pBushGivenNotTree) = GreenSplit(tintR, tintG, tintB);
                double seed = t * 61.7 + 401;
                double expected = (area / ClutterSpacingM2) * densityScale * capScale * (1 + pGreen * GreenDensityBoost);
                double whole = Math.Floor(expected);
                int count = (int)whole + (VegetationMath.Hash01(seed) < expected - whole ? 1 : 0);

                for (int i = 0; i < count; i++)
                {
                    if (total >= cap) return result;
                    double r1 = VegetationMath.Hash01(seed + i * 2.371);
                    double r2 = VegetationMath.Hash01(seed + i * 2.371 + 0.5);
                    Vec3d p = VegetationMath.PointInTriangle(v0, v1, v2, r1, r2);
                    if (excluded != null && excluded(p.X, p.Z, p.Y)) continue;

                    if (VegetationMath.Hash01(seed + i * 4.633 + 0.17) < pGreen)
                    {
                        int species;
                        if (VegetationMath.Hash01(seed + i * 3.109 + 0.41) < pTreeGivenGreen)
                        {
                            species = (int)Math.Min(Math.Floor(VegetationMath.Hash01(seed + i * 8.923) * VegetationAtlas.TreeSpeciesCount),
                                VegetationAtlas.TreeSpeciesCount - 1);
                        }
                        else if (VegetationMath.Hash01(seed + i * 6.827 + 0.63) < pBushGivenNotTree)
                        {
                            species = (int)TreeSpecies.Bush;
                        }
                        else
                        {
                            species = (int)TreeSpecies.Shrub;
                        }
                        ScatterGroup g = bySpecies[species];
                        if (g == null)
                        {
                            g = bySpecies[species] = new ScatterGroup(species);
                            vegetation.Add(g);
                        }
                        g.Add(p.X, p.Y, p.Z, tintR, tintG, tintB, n.X, n.Y, n.Z);
                    }
                    else
                    {
                        int shape = (int)Math.Min(Math.Floor(VegetationMath.Hash01(seed + i * 8.923) * VegetationAtlas.RockShapeCount),
                            VegetationAtlas.RockShapeCount - 1);
                        ScatterGroup g = byShape[shape];
                        if (g == null)
                        {
                            g = byShape[shape] = new ScatterGroup(shape);
                            rocks.Add(g);
                        }
                        g.Add(p.X, p.Y, p.Z, tintR, tintG, tintB, n.X, n.Y, n.Z);
                    }
                    total++;
                }
            }
            return result;
        }

        /// <summary>
        /// buildStoneMesh: every rock in one draw, in group order (no shuffle, never thinned), size
        /// x0.6..1.3, shade a = (0.35..0.7) * 0.9.
        /// </summary>
        public static BillboardInstances BuildStones(IReadOnlyList<ScatterGroup> rocks)
        {
            int count = 0;
            foreach (ScatterGroup g in rocks) count += g.Count;
            var m = new BillboardInstances
            {
                Count = count,
                Positions = new float[count * 3],
                Scales = new float[count],
                Kinds = new float[count],
                Normals = new float[count * 3],
                Shade = new float[count * 4],
                SpacingM = 0,
                InvCount = 0,
                Total = count,
                Stones = true,
            };
            int i = 0;
            foreach (ScatterGroup g in rocks)
            {
                for (int k = 0; k < g.Count; k++, i++)
                {
                    double scale = 0.6 + VegetationMath.Hash01(i * 5.113 + g.Kind * 13.1 + 1) * 0.7;
                    m.Scales[i] = (float)scale;
                    m.Positions[i * 3] = (float)g.Points[k * 3];
                    m.Positions[i * 3 + 1] = (float)g.Points[k * 3 + 1];
                    m.Positions[i * 3 + 2] = (float)g.Points[k * 3 + 2];
                    m.Kinds[i] = g.Kind;
                    m.Normals[i * 3] = (float)g.Normals[k * 3];
                    m.Normals[i * 3 + 1] = (float)g.Normals[k * 3 + 1];
                    m.Normals[i * 3 + 2] = (float)g.Normals[k * 3 + 2];
                    m.Shade[i * 4] = (float)g.Tints[k * 3];
                    m.Shade[i * 4 + 1] = (float)g.Tints[k * 3 + 1];
                    m.Shade[i * 4 + 2] = (float)g.Tints[k * 3 + 2];
                    m.Shade[i * 4 + 3] = (float)((0.35 + VegetationMath.Hash01(i * 6.451 + g.Kind * 17.3 + 2) * 0.35) * 0.9);
                }
            }
            (m.SphereCenter, m.SphereRadius) = VegetationMath.InstancesSphere(QuadSphere.Center, QuadSphere.Radius, m.Positions, m.Scales, count);
            return m;
        }
    }
}

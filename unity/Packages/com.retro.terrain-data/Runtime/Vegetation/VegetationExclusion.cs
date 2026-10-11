using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// The exclusion stack terrainEntity.ts attachTrees puts in front of the scatter, and the
    /// whole CPU half of that call (<see cref="Build"/>).
    /// </summary>
    public static class VegetationExclusion
    {
        /// <summary>three.js Vector3.applyMatrix4 (column-major, with the w divide).</summary>
        private static Vec3d Apply(Mat4d m, Vec3d p)
        {
            double[] e = m.E;
            double x = p.X, y = p.Y, z = p.Z;
            double w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
            return new Vec3d(
                (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
                (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
                (e[2] * x + e[6] * y + e[10] * z + e[14]) * w);
        }

        /// <summary>
        /// sceneExclusionFor: the area-wide airfield and surface masks (scene x/z) asked about a
        /// tile-local point, taken as (x, z, y). The point is rotated by the tile's frame fix, moved
        /// by its scene origin (<see cref="DrawTile.Origin"/>, <see cref="DrawTile.FrameFix"/>) and
        /// carried back through each mask's frame matrix (identity until a re-base; after one,
        /// the inverse of the accumulated shift, terrainEntity.ts rebaseTo). Null when neither mask
        /// exists.
        /// </summary>
        public static Func<double, double, double, bool> ForTile(Vec3d tileOrigin, Quatd frameFix,
            Func<double, double, bool> onAirfield, Mat4d toAirfield,
            Func<double, double, bool> onSurface, Mat4d toSurface)
        {
            if (onAirfield == null && onSurface == null) return null;
            Mat4d ta = toAirfield ?? Mat4d.Identity();
            Mat4d ts = toSurface ?? Mat4d.Identity();
            return (x, z, y) =>
            {
                Vec3d r = new Vec3d(x, y, z).Rotate(frameFix);
                var v = new Vec3d(r.X + tileOrigin.X, r.Y + tileOrigin.Y, r.Z + tileOrigin.Z);
                if (onAirfield != null)
                {
                    Vec3d w = Apply(ta, v);
                    if (onAirfield(w.X, w.Z)) return true;
                }
                if (onSurface != null)
                {
                    Vec3d w = Apply(ts, v);
                    if (onSurface(w.X, w.Z)) return true;
                }
                return false;
            };
        }

        /// <summary>
        /// attachTrees's isExcluded over tile-local (x, z, y): roads, then beds, then airfield and
        /// surface, then buildings. Null when all four are null.
        /// </summary>
        public static Func<double, double, double, bool> Combine(
            Func<double, double, bool> onRoad, Func<double, double, double, bool> onBed,
            Func<double, double, double, bool> onManMade, Func<double, double, double, bool> onBuilding)
        {
            if (onRoad == null && onManMade == null && onBed == null && onBuilding == null) return null;
            return (x, z, y) => (onRoad != null && onRoad(x, z)) || (onBed != null && onBed(x, y, z))
                || (onManMade != null && onManMade(x, z, y)) || (onBuilding != null && onBuilding(x, y, z));
        }
    }

    /// <summary>A tile's vegetation draws: tree-atlas cells (forest plus clutter vegetation) and at most one stone draw.</summary>
    public sealed class TileVegetation
    {
        public List<BillboardInstances> TreeCells = new List<BillboardInstances>();
        /// <summary>Null when the tile has no rocks.</summary>
        public BillboardInstances Stones;
        /// <summary>The density the tile was scattered at (meshes.treesScale), for <see cref="TreeBillboards.NeedsRescatter"/>.</summary>
        public double DensityScale;

        /// <summary>
        /// attachTrees, CPU half: scatter the forest and the clutter with one exclusion test, split
        /// the tree-atlas points (forest groups first, then clutter vegetation) into 4 x 4 cells
        /// with thinning spacing <see cref="TreeBillboards.SpacingM"/>(density), and the rocks into
        /// one stone draw. Positions stay tile-local metres.
        /// </summary>
        public static TileVegetation Build(PtmTile tile, double densityScale, Func<double, double, double, bool> excluded)
        {
            List<ScatterGroup> groups = TreeBillboards.ScatterTreeSpecies(tile, densityScale, excluded);
            GroundClutterResult clutter = GroundClutter.Scatter(tile, densityScale, excluded);
            var all = new List<ScatterGroup>(groups.Count + clutter.Vegetation.Count);
            all.AddRange(groups);
            all.AddRange(clutter.Vegetation);
            var result = new TileVegetation { DensityScale = densityScale };
            if (all.Count > 0) result.TreeCells = TreeBillboards.BuildCells(all, TreeBillboards.SpacingM(densityScale));
            if (clutter.Rocks.Count > 0) result.Stones = GroundClutter.BuildStones(clutter.Rocks);
            return result;
        }
    }
}

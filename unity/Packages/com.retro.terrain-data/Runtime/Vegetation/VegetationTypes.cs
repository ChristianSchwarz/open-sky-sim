using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// Billboard tree species, in atlas order (treeSprites.ts <c>Species</c>). The first
    /// <see cref="VegetationAtlas.TreeSpeciesCount"/> are the forest roster; Shrub and Bush are only
    /// scattered on shrubland and open ground.
    /// </summary>
    public enum TreeSpecies
    {
        Maple = 0,
        Pine = 1,
        Linden = 2,
        Fir = 3,
        Shrub = 4,
        Bush = 5,
    }

    /// <summary>Stone silhouettes, in atlas order (stoneSprites.ts <c>RockShape</c>).</summary>
    public enum RockShape
    {
        Round = 0,
        Angular = 1,
        Flat = 2,
        Cluster = 3,
        Slab = 4,
        Pebble = 5,
    }

    /// <summary>
    /// Atlas layout shared by the tree and stone atlases (treeAtlas.ts, stoneAtlas.ts,
    /// treeBillboardVP.ts): 2 x 3 blocks of 256 px, one per species/shape at
    /// (kind % 2, kind / 2); each block 2 x 2 cells of 128 px holding the 0, 30, 60 and 90 degree
    /// elevation views at (0,0), (1,0), (0,1), (1,1). Row 0 is the top of the image (flipY = false).
    /// </summary>
    public static class VegetationAtlas
    {
        public const int CellPx = 128;
        public const int BlockPx = CellPx * 2;
        public const int WidthPx = BlockPx * 2;
        public const int HeightPx = BlockPx * 3;
        public const int SpeciesCount = 6;
        public const int TreeSpeciesCount = 4;
        public const int RockShapeCount = 6;

        /// <summary>Upper bounds of the camera elevation tangent per view band (tan 30, 55, 80 degrees).</summary>
        public const double View30Tan = 0.5774;
        public const double View60Tan = 1.4281;
        public const double View90Tan = 5.6713;
    }

    /// <summary>
    /// Scattered points of one species or rock shape (treeBillboards.ts <c>SpeciesGroup</c>,
    /// stones.ts <c>ShapeGroup</c>): tile-local metres (x east, y up, z south, bake-frame axes,
    /// offsets from the tile centre), the baked ground colour under each (sRGB 0..1) and the
    /// up-facing unit facet normal.
    /// </summary>
    public sealed class ScatterGroup
    {
        /// <summary><see cref="TreeSpecies"/> or <see cref="RockShape"/> value.</summary>
        public readonly int Kind;
        public readonly List<double> Points = new List<double>();
        public readonly List<double> Tints = new List<double>();
        public readonly List<double> Normals = new List<double>();

        public ScatterGroup(int kind)
        {
            Kind = kind;
        }

        public int Count => Points.Count / 3;

        internal void Add(double x, double y, double z, double r, double g, double b, double nx, double ny, double nz)
        {
            Points.Add(x);
            Points.Add(y);
            Points.Add(z);
            Tints.Add(r);
            Tints.Add(g);
            Tints.Add(b);
            Normals.Add(nx);
            Normals.Add(ny);
            Normals.Add(nz);
        }
    }

    /// <summary>A tile's ground clutter (stones.ts <c>GroundClutter</c>).</summary>
    public sealed class GroundClutterResult
    {
        public List<ScatterGroup> Rocks;
        /// <summary>Shrubs, bushes and the odd tree; drawn with the tree atlas alongside the forest.</summary>
        public List<ScatterGroup> Vegetation;
    }

    /// <summary>
    /// One instanced billboard draw (one InstancedMesh in buildTreeMesh / buildStoneMesh), as plain
    /// arrays in instance (slot) order, ready for a GPU buffer. Positions are tile-local metres
    /// (the frame of <see cref="PtmTile"/> land positions times QuantScale). All per-instance
    /// arrays hold exactly the float32 values the web game uploads.
    /// </summary>
    public sealed class BillboardInstances
    {
        public int Count;
        /// <summary>xyz per instance: the billboard's ground point.</summary>
        public float[] Positions;
        /// <summary>Uniform scale per instance (instanceMatrix diagonal).</summary>
        public float[] Scales;
        /// <summary>instanceSpecies: species (tree atlas) or rock shape (stone atlas), as a float.</summary>
        public float[] Kinds;
        /// <summary>instanceNormal: xyz unit facet normal (up-facing).</summary>
        public float[] Normals;
        /// <summary>instanceShade: rgb = ground colour under the point (sRGB 0..1), a = darkening factor.</summary>
        public float[] Shade;
        /// <summary>uTreeSpacingM (trees) or 0 (stones: no screen-space thinning, never cut).</summary>
        public double SpacingM;
        /// <summary>uTreeInvCount: 1 / max(1, Count); 0 for stones (the uniform is never set there).</summary>
        public double InvCount;
        /// <summary>Instances eligible for <see cref="TreeBillboards.InstancesToDraw"/> (userData.treeTotal).</summary>
        public int Total;
        /// <summary>InstancedMesh.computeBoundingSphere, tile-local metres.</summary>
        public Vec3d SphereCenter;
        public double SphereRadius;
        /// <summary>True for the stone atlas / TERRAIN_BARE draw, false for the tree atlas / TERRAIN_FOREST.</summary>
        public bool Stones;

        /// <summary>The instanceMatrix the web game uploads, 16 floats per instance, column-major (three.js layout).</summary>
        public float[] Matrices()
        {
            var m = new float[Count * 16];
            for (int i = 0; i < Count; i++)
            {
                float s = Scales[i];
                int o = i * 16;
                m[o] = s;
                m[o + 5] = s;
                m[o + 10] = s;
                m[o + 12] = Positions[i * 3];
                m[o + 13] = Positions[i * 3 + 1];
                m[o + 14] = Positions[i * 3 + 2];
                m[o + 15] = 1;
            }
            return m;
        }
    }
}

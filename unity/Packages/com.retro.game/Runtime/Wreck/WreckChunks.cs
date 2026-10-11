using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// A mesh's triangles while the airframe is being cut (wreckField.ts ChunkMesh /
    /// SplitPart): flat per-triangle-vertex data as doubles, in the attribute order
    /// the TS copies (position, normal, color, uv). An attribute list is null until
    /// a triangle with it is added (the TS Map has no entry then).
    /// </summary>
    internal sealed class WreckChunkMesh
    {
        public object Material;
        public List<double> Pos;
        public List<double> Nrm;
        public List<double> Col;
        public int ColSize = 3;
        public List<double> Uv;
        public int UvSize = 2;

        public WreckChunkMesh(object material)
        {
            Material = material;
        }

        public bool HasPosition => Pos != null;

        /// <summary>The attributes present, in the TS Map's insertion order.</summary>
        public IEnumerable<(List<double> Data, int ItemSize, int Which)> Attrs()
        {
            if (Pos != null) yield return (Pos, 3, 0);
            if (Nrm != null) yield return (Nrm, 3, 1);
            if (Col != null) yield return (Col, ColSize, 2);
            if (Uv != null) yield return (Uv, UvSize, 3);
        }

        public int AttrCount => (Pos != null ? 1 : 0) + (Nrm != null ? 1 : 0) + (Col != null ? 1 : 0) + (Uv != null ? 1 : 0);

        /// <summary>The list for attribute <paramref name="which"/>, created on first use (attrs.set).</summary>
        public List<double> Ensure(int which, int itemSize)
        {
            switch (which)
            {
                case 0: return Pos ??= new List<double>();
                case 1: return Nrm ??= new List<double>();
                case 2:
                    if (Col == null)
                    {
                        Col = new List<double>();
                        ColSize = itemSize;
                    }
                    return Col;
                default:
                    if (Uv == null)
                    {
                        Uv = new List<double>();
                        UvSize = itemSize;
                    }
                    return Uv;
            }
        }

        /// <summary>Drop the triangles in <paramref name="remove"/> (splice at each, highest first).</summary>
        public void RemoveTriangles(HashSet<int> remove)
        {
            foreach ((List<double> data, int itemSize, int _) in Attrs())
            {
                int per = itemSize * 3;
                int tris = data.Count / per;
                var kept = new List<double>(data.Count);
                for (int t = 0; t < tris; t++)
                {
                    if (remove.Contains(t)) continue;
                    for (int k = 0; k < per; k++) kept.Add(data[t * per + k]);
                }
                // A partial trailing triangle (never happens) stays where splice would leave it.
                for (int k = tris * per; k < data.Count; k++) kept.Add(data[k]);
                data.Clear();
                data.AddRange(kept);
            }
        }
    }

    /// <summary>A section of the airframe, a gear leg, a control surface or a shard (wreckField.ts Chunk).</summary>
    internal sealed class WreckChunk
    {
        /// <summary>Body section 0-6, or -1 for a gear leg / control surface / shard.</summary>
        public int Cell;

        /// <summary>One leg of the landing gear.</summary>
        public bool Gear;

        /// <summary>For a part: which one (see WreckPart.Id).</summary>
        public int? PartId;

        /// <summary>Where a fire would sit on this section (body-origin-relative, world-oriented).</summary>
        public Vec3d? Anchor;

        public List<WreckChunkMesh> Meshes = new List<WreckChunkMesh>();

        /// <summary>Bounding box in body-origin-relative world orientation.</summary>
        public WreckBox3 Box = new WreckBox3();

        /// <summary>Weakness multiplier for the break-off test.</summary>
        public double Weakness;
    }
}

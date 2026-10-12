using System.Collections.Generic;
using System.IO;
using Retro.Core;
using Retro.Terrain;
using UnityEngine;

namespace Retro.Unity
{
    /// <summary>
    /// Far-tile cover textures (coverTextures.ts CoverTextures): a coarse tile's
    /// facets are hundreds of metres across, so where the bake wrote a PTX1
    /// sidecar for it the land shader paints the z12 leaves' answer from that
    /// raster instead (a leaf's own sparse texture only past 3 km, for its
    /// houses). Sidecars load beside the meshes on their own cache and are
    /// attached to a drawn tile when they land; nothing waits for them. The
    /// texture is point-sampled with a mip chain built here (the class byte
    /// must not be averaged), in the tile's own lon/lat frame.
    /// </summary>
    public sealed class TerrainCoverTextures
    {
        /// <summary>What a drawn tile's land is given to sample its texture.</summary>
        public sealed class Binding
        {
            public Texture2D Texture;
            /// <summary>xyz: east, scaled for SNorm16 positions; w unused.</summary>
            public Vector4 East;
            /// <summary>xyz: north, scaled likewise; w: k, the lon span's shrink toward the pole.</summary>
            public Vector4 North;
            public float FromM;
        }

        // coverTextures.ts COVER_TEXTURE_CACHE_BYTES.
        private const long CacheBytes = 48L << 20;
        /// <summary>Textures made per frame (mips are built on the main thread).</summary>
        private const int BindsPerFrame = 2;

        private readonly TileIndex index;
        private readonly TileCache<PtxTile> cache;
        private readonly EnuBasis bakeBasis;
        private readonly int minZoom, maxZoom, leafZoom;
        private readonly Dictionary<TileKey, Binding> bound = new Dictionary<TileKey, Binding>();
        private readonly List<(TileKey, double)> wants = new List<(TileKey, double)>();
        private int bindsThisFrame;

        /// <summary>The player's switch (farTileTextures): off, no new sidecars and the shader does not read them.</summary>
        public bool Enabled = true;
        public int Attached => bound.Count;

        public TerrainCoverTextures(string root, TerrainManifestTexture spec, EnuBasis bakeBasis)
        {
            this.bakeBasis = bakeBasis;
            minZoom = spec.minZoom;
            maxZoom = spec.maxZoom;
            leafZoom = spec.leafZoom;
            string indexPath = Path.Combine(root, "index_tex.bin");
            index = File.Exists(indexPath) ? TileIndex.Decode(File.ReadAllBytes(indexPath)) : null;
            cache = new TileCache<PtxTile>(
                k => Path.Combine(root, k.Z.ToString(), k.X.ToString(), k.Y + ".ptx"),
                TileFile.Ptx,
                t => (t.Texels?.Length ?? 0) + 64,
                CacheBytes);
        }

        /// <summary>has: the bake wrote a texture for this tile (a leaf's only where the index lists it).</summary>
        public bool Has(TileKey id)
        {
            if (id.Z == leafZoom) return index != null && index.Has(id);
            if (id.Z < minZoom || id.Z > maxZoom) return false;
            return index == null || index.Has(id);
        }

        /// <summary>
        /// attach: the drawn tile's binding, or null while there is none (not baked, not loaded
        /// yet, or switched off). A sidecar not yet decoded is asked for at `priority`.
        /// </summary>
        public Binding Get(TileKey id, double quantScale, double priority)
        {
            if (bound.TryGetValue(id, out Binding b)) return b;
            if (!Enabled || !Has(id) || cache.IsAbsent(id)) return null;
            PtxTile tile = cache.Get(id);
            if (tile == null)
            {
                wants.Add((id, priority));
                return null;
            }
            if (bindsThisFrame >= BindsPerFrame) return null;
            bindsThisFrame++;
            b = Bind(id, tile, quantScale);
            bound[id] = b;
            return b;
        }

        private Binding Bind(TileKey id, PtxTile tile, double quantScale)
        {
            CoverFrame frame = CoverTexture.Frame(id, bakeBasis, quantScale);
            // Linear: the bytes are sRGB the shader decodes itself, like the vertex colours.
            var tex = new Texture2D(tile.Size, tile.Size, TextureFormat.RGBA32, true, true)
            {
                filterMode = FilterMode.Point,
                wrapMode = TextureWrapMode.Clamp,
                name = "cover " + id,
            };
            List<byte[]> mips = CoverTexture.Mips(tile.Texels, tile.Size);
            for (int level = 0; level < mips.Count && level < tex.mipmapCount; level++) tex.SetPixelData(mips[level], level);
            tex.Apply(false, true);
            // Positions reach the shader as SNorm16 (raw / 32767): fold that into the frame.
            const float s = (float)TileMeshUpload.SNorm16Max;
            return new Binding
            {
                Texture = tex,
                East = new Vector4((float)frame.East.X * s, (float)frame.East.Y * s, (float)frame.East.Z * s, 0),
                North = new Vector4((float)frame.North.X * s, (float)frame.North.Y * s, (float)frame.North.Z * s, (float)frame.K),
                FromM = id.Z == leafZoom ? (float)CoverTexture.LeafCoverFromM : 0,
            };
        }

        /// <summary>Once a frame, after the draw asked: fetch what it wanted.</summary>
        public void Pump()
        {
            bindsThisFrame = 0;
            cache.NextGeneration();
            cache.SetWants(wants);
            wants.Clear();
            cache.Pump();
        }

        /// <summary>A tile left: its texture goes with it.</summary>
        public void Release(TileKey id)
        {
            if (!bound.TryGetValue(id, out Binding b)) return;
            Object.Destroy(b.Texture);
            bound.Remove(id);
        }

        public void Dispose()
        {
            foreach (Binding b in bound.Values) Object.Destroy(b.Texture);
            bound.Clear();
        }
    }
}

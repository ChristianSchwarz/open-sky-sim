/**
 * Far-tile cover textures at runtime: fetching the PTX1 sidecar a coarse
 * tile has, turning it into a GPU texture, and handing the land shader what
 * it needs to sample it.
 *
 * A coarse tile paints one colour per facet, and its facets are hundreds of
 * metres across. The sidecar carries the z12 leaves' answer down the
 * pyramid instead, and the fragment program samples it where the tile has
 * one; where it does not - no sidecar, or a no-data texel - the facet colour
 * shows as before. A leaf never has one: it draws its own facets.
 *
 * The texture arrives separately from the mesh, on its own store, and is
 * attached to the resident tile whenever it lands. Nothing waits on it: a
 * tile drawn before its texture arrives is the tile of a pyramid baked
 * without textures, which is exactly what the fallback path renders.
 *
 * Sampling. The raster's grid is the tile's lon/lat box, and a vertex only
 * knows its offset from the tile centre in the bake frame's axes - which,
 * far from that frame's origin, are nowhere near local east and up. So each
 * tile gets its own east and north directions, in those axes, and the
 * vertex program projects onto them; the one first-order term left is the
 * change of cos(lat) across the tile, which narrows the lon span toward the
 * pole. See {@link coverFrame} and docs/terrain-far-textures.md.
 */

import * as THREE from 'three';
import { EnuBasis, ecefToEnu, geodeticToEcef } from './geodesy';
import { TerrainManifest, TextureStreamManifest, textureTileUrl } from './manifest';
import { PTX_NO_DATA, PtxTile, decodePtx } from './ptx';
import { TileIndex } from './tileIndex';
import { TileMeshes } from './tileMesh';
import { TileStore } from './tileStore';
import { TileKey, tileBounds } from './tiling';

/**
 * Decoded sidecars kept in memory. The GPU texture is built at attach and
 * lives with the tile, so this only has to hold what is in flight or about
 * to be attached; an eviction here costs a re-fetch, nothing more.
 */
const COVER_TEXTURE_CACHE_BYTES = 48 * 1024 * 1024;

/** What the land material's per-draw refresh reads off a tile's land mesh. */
export interface CoverBinding {
    texture: THREE.DataTexture;
    /** Bake-frame direction of local east at the tile centre, scaled so `dot(position, east)` is the lon fraction from the centre. */
    east: THREE.Vector3;
    /** Same for north and the lat fraction. */
    north: THREE.Vector3;
    /** The lon span's shrink toward the pole, per lat fraction; see coverFrame. */
    k: number;
}

export interface CoverFrame {
    east: THREE.Vector3;
    north: THREE.Vector3;
    k: number;
}

/**
 * The lon/lat frame of a tile in the bake's axes.
 *
 * Positions are quantised offsets from the tile centre in the bake frame's
 * ENU axes (x = e, y = u, z = -n). Local east and north at the tile centre
 * are found by stepping a small way along each and taking the direction in
 * those axes; both are then scaled by `quantScale` over the tile's width or
 * height, so a dot product with the raw position gives the offset as a
 * fraction of the tile. The lon span in metres narrows toward the pole:
 * width at the south edge over the north edge gives `k`, so that
 * `u = 0.5 + e / (1 - k * n)` with `n` the lat fraction (north positive).
 */
export function coverFrame(id: TileKey, basis: EnuBasis, quantScale: number): CoverFrame {
    const b = tileBounds(id);
    const lat0 = (b.south + b.north) / 2;
    const lon0 = (b.west + b.east) / 2;
    const at = (lat: number, lon: number) => {
        const enu = ecefToEnu(basis, geodeticToEcef(lat, lon, 0));
        return new THREE.Vector3(enu.e, enu.u, -enu.n);
    };
    const centre = at(lat0, lon0);
    const stepDeg = 1e-3;
    const east = at(lat0, lon0 + stepDeg).sub(centre).normalize();
    const north = at(lat0 + stepDeg, lon0).sub(centre).normalize();
    // Chord lengths; over even a z6 tile the arc differs by a part in 10^5.
    const widthAt = (lat: number) => at(lat, b.east).distanceTo(at(lat, b.west));
    const width = widthAt(lat0);
    const height = at(b.north, lon0).distanceTo(at(b.south, lon0));
    const k = (widthAt(b.south) - widthAt(b.north)) / width;
    return {
        east: east.multiplyScalar(quantScale / width),
        north: north.multiplyScalar(quantScale / height),
        k,
    };
}

/**
 * Mip chain for a cover raster, level 0 included, down to 1x1.
 *
 * Built here rather than by the GPU: a class byte averaged is garbage, and
 * three's generateMipmaps averages every channel. Colour is the mean of the
 * block's data texels; the class is the first data texel's in row order -
 * nearest, not majority, since by the time a block is minified this far its
 * class is one texel of hundreds on screen. A block with no data stays
 * no-data. 64 K texels take well under a millisecond.
 */
export function buildCoverMips(texels: Uint8Array, size: number): Array<{ data: Uint8Array; width: number; height: number }> {
    const levels = [{ data: texels, width: size, height: size }];
    let src = texels;
    let n = size;
    while (n > 1) {
        const half = n >> 1;
        const dst = new Uint8Array(half * half * 4);
        for (let y = 0; y < half; y++) {
            for (let x = 0; x < half; x++) {
                let count = 0, r = 0, g = 0, bl = 0, cls = PTX_NO_DATA;
                for (let dy = 0; dy < 2; dy++) {
                    for (let dx = 0; dx < 2; dx++) {
                        const o = ((y * 2 + dy) * n + (x * 2 + dx)) * 4;
                        const c = src[o + 3];
                        if (c === PTX_NO_DATA) {
                            continue;
                        }
                        if (count === 0) {
                            cls = c;
                        }
                        r += src[o];
                        g += src[o + 1];
                        bl += src[o + 2];
                        count++;
                    }
                }
                const o = (y * half + x) * 4;
                if (count > 0) {
                    dst[o] = Math.round(r / count);
                    dst[o + 1] = Math.round(g / count);
                    dst[o + 2] = Math.round(bl / count);
                }
                dst[o + 3] = cls;
            }
        }
        levels.push({ data: dst, width: half, height: half });
        src = dst;
        n = half;
    }
    return levels;
}

/** GPU bytes a cover texture of `size` costs, mips included. */
export function coverTextureBytes(size: number): number {
    return Math.ceil(size * size * 4 * 4 / 3);
}

function buildCoverTexture(tile: PtxTile): THREE.DataTexture {
    const mips = buildCoverMips(tile.texels, tile.size);
    const texture = new THREE.DataTexture(tile.texels, tile.size, tile.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.mipmaps = mips;
    texture.generateMipmaps = false;
    // Nearest both ways: a texel is a texel, the way a facet is a facet. The
    // supplied mips keep minification from shimmering.
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestMipmapNearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    // Row 0 is the north edge and v = 0 must be too; and the bytes are sRGB
    // the shader decodes itself, like the vertex colours.
    texture.flipY = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
}

/** A texel of nothing, for the sampler of a draw that has no texture. */
export function makeNoCoverTexture(): THREE.DataTexture {
    const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, PTX_NO_DATA]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
}

export interface CoverTexturesOptions {
    manifest: TerrainManifest;
    /** Directory the manifest was loaded from. */
    baseUrl: string;
    /** The bake's frame, the one tile positions are expressed in. */
    bakeBasis: EnuBasis;
}

export interface CoverTexturesStats {
    /** Resident tiles with a texture attached. */
    attached: number;
    inflight: number;
    queued: number;
    failed: number;
}

export class CoverTextures {
    private readonly store: TileStore<PtxTile> | undefined;
    private readonly bakeBasis: EnuBasis;
    private readonly minZoom: number;
    private readonly maxZoom: number;
    private readonly spec: TextureStreamManifest | undefined;
    private index: TileIndex | undefined;
    private attached = 0;
    private wanted = true;

    constructor(opts: CoverTexturesOptions) {
        this.bakeBasis = opts.bakeBasis;
        const spec = opts.manifest.texture;
        this.spec = spec;
        this.minZoom = spec?.minZoom ?? 0;
        this.maxZoom = spec?.maxZoom ?? -1;
        this.store = spec === undefined ? undefined : new TileStore<PtxTile>({
            baseUrl: opts.baseUrl,
            url: (id) => textureTileUrl(opts.manifest, id.z, id.x, id.y, opts.baseUrl),
            decode: (buf) => decodePtx(buf),
            sizeOf: (t) => t.texels.byteLength,
            maxBytes: COVER_TEXTURE_CACHE_BYTES,
            exists: (id) => this.has(id),
        });
    }

    /** Whether the pyramid ships textures at all. */
    get enabled(): boolean {
        return this.store !== undefined;
    }

    /**
     * The player's switch. Off stops new sidecars being fetched; what is
     * already attached stays with its tile, and the shader is told not to
     * read it by the entity. A tile drawn while off is asked again once on.
     */
    setEnabled(on: boolean): void {
        this.wanted = on;
    }

    setIndex(index: TileIndex | undefined): void {
        this.index = index;
    }

    /** Whether the bake wrote a texture for this tile. */
    has(id: TileKey): boolean {
        if (id.z < this.minZoom || id.z > this.maxZoom) {
            return false;
        }
        return this.index ? this.index.has(id) : true;
    }

    /**
     * Give a resident tile its texture, now if the sidecar is decoded and
     * otherwise when it arrives. Called for every drawn tile every reconcile;
     * past the first call per tile it is a field read.
     */
    attach(id: TileKey, meshes: TileMeshes, priority: number): void {
        if (meshes.cover !== undefined || !this.store || !this.wanted || !meshes.land) {
            return;
        }
        if (this.store.isAbsent(id)) {
            meshes.cover = 'none';
            return;
        }
        meshes.cover = 'pending';
        const cached = this.store.get(id);
        if (cached) {
            this.bind(id, meshes, cached);
            return;
        }
        void this.store.request(id, priority).then(tile => {
            // Evicted, or a texture that turned out not to exist, meanwhile.
            if (meshes.cover !== 'pending') {
                return;
            }
            if (tile === null) {
                meshes.cover = 'none';
                return;
            }
            this.bind(id, meshes, tile);
        });
    }

    private bind(id: TileKey, meshes: TileMeshes, tile: PtxTile): void {
        const land = meshes.land;
        if (!land) {
            meshes.cover = 'none';
            return;
        }
        const frame = coverFrame(id, this.bakeBasis, meshes.group.scale.x);
        const texture = buildCoverTexture(tile);
        const binding: CoverBinding = { texture, east: frame.east, north: frame.north, k: frame.k };
        land.userData.cover = binding;
        meshes.cover = texture;
        meshes.bytes += coverTextureBytes(tile.size);
        this.attached++;
    }

    /** Zoom range the bake wrote sidecars for; `max < min` when it wrote none. */
    get zoomRange(): { min: number; max: number } {
        return { min: this.minZoom, max: this.maxZoom };
    }

    /** Texels across a sidecar at zoom `z`, as the manifest declares it. */
    texelsAt(z: number): number {
        const spec = this.spec;
        if (!spec) {
            return 1;
        }
        if (spec.nearSize !== undefined && spec.nearZoom !== undefined && z >= spec.nearZoom) {
            return spec.nearSize;
        }
        return spec.size;
    }

    /**
     * The decoded sidecar of a tile for a reader other than the land shader -
     * the cockpit's moving map. Cached tiles come back at once and count as
     * used this generation; a missing one is queued at `priority` and
     * `undefined` returned, so the caller draws what it has and asks again
     * next frame. Nothing is returned for a tile the bake never wrote.
     */
    sidecar(id: TileKey, priority: number): PtxTile | undefined {
        if (!this.store || !this.has(id) || this.store.isAbsent(id)) {
            return undefined;
        }
        const cached = this.store.get(id);
        if (cached) {
            return cached;
        }
        void this.store.request(id, priority);
        return undefined;
    }

    /** A tile is being released; forget its texture. */
    release(meshes: TileMeshes): void {
        if (meshes.cover instanceof THREE.DataTexture) {
            this.attached--;
        }
    }

    /** Textures nobody drew this generation may be evicted from the byte budget. */
    nextGeneration(): void {
        this.store?.nextGeneration();
    }

    get stats(): CoverTexturesStats {
        const s = this.store?.stats;
        return {
            attached: this.attached,
            inflight: s?.inflight ?? 0,
            queued: s?.queued ?? 0,
            failed: s?.failed ?? 0,
        };
    }
}

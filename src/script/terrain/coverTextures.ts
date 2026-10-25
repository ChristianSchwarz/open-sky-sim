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
import { LAND_TONE_BASE, TerrainTone } from './tones';
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
    /** The texture is read only past this distance (m); 0 = everywhere. A leaf's is its far-field stand-in for houses. */
    fromM: number;
}

/** How far from the camera a leaf's own cover texture replaces its facet colour. */
export const LEAF_COVER_FROM_M = 3000;

let leafCoverFromM = LEAF_COVER_FROM_M;
let underlay = false;

/**
 * The map mode: a coarse tile's water and coastline come from its cover
 * texture, not its mesh. Below the leaf the mesh draws coasts and lakes as a
 * few big triangles - lakes cut as triangular holes, sea poking into land and
 * land into sea, holes with nothing under them - while the texture has them at
 * its texel size, with no data wherever there is water. So a textured coarse
 * tile gets two sheets under its land, a textured land sheet and a water
 * sheet below it; its land facets give way over no-data texels (a negative
 * fromM tells terrainFP to discard there) and its water mesh is hidden. Bound
 * from then on: set it before the map's tiles arrive.
 */
export function setCoverUnderlay(on: boolean): void {
    underlay = on;
}

/** Below sea level, so no land is drawn over (polders, the Caspian). */
const UNDERLAY_LAND_M = -100;
const UNDERLAY_WATER_M = -150;
/** Cells a side: at z4 a cell is 0.7 degrees, its chord sagging well under a metre... at z9 far less. */
const UNDERLAY_CELLS = 32;

/**
 * Move where a leaf's cover texture takes over from its facets, for every
 * leaf bound now or later. The map mode looks down from kilometres up, where
 * LEAF_COVER_FROM_M - a distance standing in for "too small to see" - would
 * put every town under its texture: there it is out of reach, and the facets and
 * the houses (cut by size on screen, not by distance) stay.
 */
export function setLeafCoverFromM(m: number): void {
    leafCoverFromM = m;
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
    private readonly leafZoom: number;
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
        this.leafZoom = spec?.leafZoom ?? -1;
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
        if (id.z === this.leafZoom) {
            // Sparse: only what the index lists.
            return this.index ? this.index.has(id) : false;
        }
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
        const leaf = id.z === this.leafZoom;
        const sheets = underlay && !leaf;
        const binding: CoverBinding = {
            texture, east: frame.east, north: frame.north, k: frame.k,
            // Read per draw, so setLeafCoverFromM reaches leaves bound before it.
            get fromM() {
                return leaf ? leafCoverFromM : sheets ? -1 : 0;
            },
        };
        land.userData.cover = binding;
        if (sheets) {
            this.addUnderlay(id, meshes, binding);
        }
        meshes.cover = texture;
        meshes.bytes += coverTextureBytes(tile.size);
        this.attached++;
    }

    /** The map mode's two sheets under a coarse tile's land; see setCoverUnderlay. */
    private addUnderlay(id: TileKey, meshes: TileMeshes, binding: CoverBinding): void {
        const land = meshes.land!;
        const q = meshes.group.scale.x;
        const b = tileBounds(id);
        const at = (lat: number, lon: number, h: number): THREE.Vector3 => {
            const enu = ecefToEnu(this.bakeBasis, geodeticToEcef(lat, lon, h));
            return new THREE.Vector3(enu.e, enu.u, -enu.n);
        };
        const latC = (b.south + b.north) / 2;
        const lonC = (b.west + b.east) / 2;
        const origin = at(latC, lonC, meshes.centerHeightM ?? 0);
        const up = at(latC, lonC, 1).sub(at(latC, lonC, 0)).normalize();
        const n = UNDERLAY_CELLS;
        const count = (n + 1) * (n + 1);
        const sheet = (h: number): THREE.BufferAttribute => {
            const pos = new Float32Array(count * 3);
            for (let j = 0; j <= n; j++) {
                for (let i = 0; i <= n; i++) {
                    const p = at(b.north - (b.north - b.south) * j / n, b.west + (b.east - b.west) * i / n, h)
                        .sub(origin).divideScalar(q);
                    pos.set([p.x, p.y, p.z], (j * (n + 1) + i) * 3);
                }
            }
            return new THREE.BufferAttribute(pos, 3);
        };
        const index: number[] = [];
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                const a = j * (n + 1) + i;
                index.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
            }
        }
        const normals = new Float32Array(count * 3);
        for (let v = 0; v < count; v++) {
            normals.set([up.x, up.y, up.z], v * 3);
        }

        // The land sheet: the land's own material, so it is lit, coloured and
        // depth-tested as the land is; its colour is the texel's wherever there
        // is one, and no-data fragments are discarded for the water below.
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', sheet(UNDERLAY_LAND_M));
        lg.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        lg.setAttribute('coverColor', new THREE.BufferAttribute(new Uint8Array(count * 3), 3, true));
        lg.setAttribute('coverClass', new THREE.BufferAttribute(new Float32Array(count), 1));
        lg.setAttribute('regionSize', new THREE.BufferAttribute(new Float32Array(count), 1));
        lg.setIndex(index);
        lg.addGroup(0, index.length, LAND_TONE_BASE);
        const landSheet = new THREE.Mesh(lg, land.material);
        landSheet.userData.cover = binding;
        landSheet.userData.landuseFills = false;

        // The water sheet: deep water, in the tile's own water material.
        const wg = new THREE.BufferGeometry();
        wg.setAttribute('position', sheet(UNDERLAY_WATER_M));
        wg.setAttribute('secondTone', new THREE.BufferAttribute(new Float32Array(count), 1));
        wg.setIndex(index);
        wg.addGroup(0, index.length, TerrainTone.Water);
        const waterSheet = new THREE.Mesh(wg, (meshes.water ?? land).material);

        for (const s of [landSheet, waterSheet]) {
            s.frustumCulled = false;
            s.matrixAutoUpdate = false;
            s.onBeforeRender = (meshes.water && s === waterSheet ? meshes.water : land).onBeforeRender;
            meshes.group.add(s);
        }
        if (meshes.water) {
            meshes.water.visible = false;
        }
        meshes.coverUnderlay = [landSheet, waterSheet];
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

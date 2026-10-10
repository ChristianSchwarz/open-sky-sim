/**
 * Far land at runtime: a leaf drawn from far enough off swaps its land mesh
 * for a lighter level baked beside it (PFL1, see pfl.ts and
 * tools/bake/farLand.ts), once that level's tolerance is under half a pixel.
 *
 * The near geometry stays the tile's own: the seam stitcher moves its border,
 * the drawn-height index reads it, the smooth shading is built from it. A far
 * level only follows: its border corners are the near border's vertices,
 * copied over whenever the stitcher has moved them, so the far land meets its
 * neighbours exactly where the near land would. In SMOOTH shading a level is
 * welded the way the near land is (buildSmoothLandGeometry), the first time it
 * is wanted, a few a frame.
 */

import * as THREE from 'three';
import { TerrainManifest, farLandTileUrl } from './manifest';
import { PflTile, decodePfl, landFingerprint } from './pfl';
import { borderEntryIndex } from './ptm';
import { TileIndex } from './tileIndex';
import { TileMeshes, buildSmoothLandGeometryFromFaceted, leanEdgeNormals } from './tileMesh';
import { TileStore } from './tileStore';
import { TileKey } from './tiling';
import { LAND_TONE_BASE } from './tones';

/** Decoded sidecars kept; a bound one no longer needs its bytes. */
const FAR_LAND_CACHE_BYTES = 32 * 1024 * 1024;
/** Main-thread time a frame may spend welding far levels for SMOOTH shading. */
const SMOOTH_BUILD_MS = 2;

export interface FarLandLevel {
    toleranceM: number;
    geometry: THREE.BufferGeometry;
    borderMap: Uint32Array;
    /** The level welded for SMOOTH shading, once wanted; 'none' when it has no land. */
    smooth?: THREE.BufferGeometry | 'none';
}

export interface FarLandMeshes {
    levels: FarLandLevel[];
    /** SeamState.version the border corners were last copied at. */
    seamVersion: number;
    bytes: number;
}

export interface FarLandOptions {
    manifest: TerrainManifest;
    baseUrl: string;
}

export class FarLandTiles {
    private readonly store: TileStore<PflTile> | undefined;
    private readonly zoom: number;
    private index: TileIndex | undefined;
    private attached = 0;
    private triangles = 0;
    /** performance.now() past which no more levels are welded this frame. */
    private smoothDeadline = 0;

    constructor(opts: FarLandOptions) {
        const spec = opts.manifest.farLand;
        this.zoom = spec?.zoom ?? -1;
        this.store = spec === undefined ? undefined : new TileStore<PflTile>({
            baseUrl: opts.baseUrl,
            url: id => farLandTileUrl(opts.manifest, id.z, id.x, id.y, opts.baseUrl),
            decode: buf => decodePfl(buf),
            sizeOf: t => t.levels.reduce((n, l) => n + l.positions.byteLength + l.normals.byteLength
                + l.attrs.byteLength + l.regionSizes.byteLength + l.borderMap.byteLength, 0),
            maxBytes: FAR_LAND_CACHE_BYTES,
            exists: id => this.has(id),
        });
    }

    setIndex(index: TileIndex | undefined): void {
        this.index = index;
    }

    /** Whether the bake wrote far land for this tile. */
    has(id: TileKey): boolean {
        return this.store !== undefined && id.z === this.zoom && (this.index ? this.index.has(id) : true);
    }

    /** Start a frame's budget for welding levels (SMOOTH_BUILD_MS). */
    beginFrame(): void {
        this.smoothDeadline = performance.now() + SMOOTH_BUILD_MS;
    }

    /**
     * Draw a tile's land at the coarsest far level within `maxToleranceM`
     * (0: the near land), fetching its sidecar the first time one is wanted.
     * `near` is the geometry the near land is drawn with in the current
     * shading, `smooth` whether that shading is SMOOTH; without `near`, or for
     * a tile without far land, nothing changes. A level not yet welded for
     * SMOOTH draws the near land meanwhile.
     */
    show(id: TileKey, meshes: TileMeshes, maxToleranceM: number, priority: number,
        near: THREE.BufferGeometry | undefined, smooth = false): void {
        const land = meshes.land;
        if (!land || !near) {
            return;
        }
        const far = meshes.far;
        let geometry = near;
        if (maxToleranceM > 0 && far === undefined && this.has(id)) {
            this.request(id, meshes, priority);
        } else if (far !== undefined && far !== 'pending' && far !== 'none') {
            let pick: FarLandLevel | undefined;
            for (const level of far.levels) {
                if (level.toleranceM <= maxToleranceM) {
                    pick = level;
                }
            }
            if (pick && smooth && pick.smooth === undefined && performance.now() < this.smoothDeadline) {
                this.weld(meshes, far, pick);
            }
            const chosen = pick && (smooth ? pick.smooth : pick.geometry);
            if (chosen && chosen !== 'none') {
                geometry = chosen;
                this.followSeam(meshes, far);
            }
        }
        if (land.geometry !== geometry) {
            land.geometry = geometry;
        }
    }

    private request(id: TileKey, meshes: TileMeshes, priority: number): void {
        if (!this.store) {
            return;
        }
        meshes.far = 'pending';
        const bind = (tile: PflTile | null) => {
            if (meshes.far !== 'pending' || meshes.disposed) {
                return;
            }
            meshes.far = tile ? this.build(meshes, tile) ?? 'none' : 'none';
        };
        const cached = this.store.get(id);
        if (cached) {
            bind(cached);
            return;
        }
        void this.store.request(id, priority).then(bind, () => bind(null));
    }

    /** The far levels as geometries, or undefined when the sidecar does not match this land. */
    private build(meshes: TileMeshes, tile: PflTile): FarLandMeshes | undefined {
        const near = meshes.landGeometryFaceted;
        const positions = near?.getAttribute('position')?.array;
        if (!(positions instanceof Int16Array) || positions.length / 9 !== tile.nearTriangles
            || bakedFingerprint(meshes, positions) !== tile.nearFingerprint) {
            return undefined;
        }
        let bytes = 0;
        let triangles = 0;
        const levels = tile.levels.map(l => {
            // Own copies: the border corners are rewritten as the seam moves,
            // and the decoded sidecar may be cached and shared.
            const pos = l.positions.slice();
            const normals = l.normals.slice();
            leanEdgeNormals(pos, normals);
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            g.setAttribute('normal', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(normals, 4), 3, 0, true));
            const attrBuffer = new THREE.InterleavedBuffer(l.attrs, 4);
            g.setAttribute('coverColor', new THREE.InterleavedBufferAttribute(attrBuffer, 3, 0, true));
            g.setAttribute('coverClass', new THREE.InterleavedBufferAttribute(attrBuffer, 1, 3, false));
            g.setAttribute('regionSize', new THREE.BufferAttribute(l.regionSizes, 1, false));
            g.addGroup(0, pos.length / 3, LAND_TONE_BASE);
            bytes += pos.byteLength + normals.byteLength + l.attrs.byteLength + l.regionSizes.byteLength;
            triangles += pos.length / 9;
            return { toleranceM: l.toleranceM, geometry: g, borderMap: l.borderMap };
        });
        const far: FarLandMeshes = { levels, seamVersion: -1, bytes };
        meshes.bytes += bytes;
        this.attached++;
        this.triangles += triangles;
        return far;
    }

    /**
     * Weld a level for SMOOTH shading, from its faceted geometry as the seam
     * left it; followSeam keeps it there from then on.
     */
    private weld(meshes: TileMeshes, far: FarLandMeshes, level: FarLandLevel): void {
        const smooth = buildSmoothLandGeometryFromFaceted(level.geometry);
        level.smooth = smooth ?? 'none';
        if (smooth) {
            const bytes = (smooth.getAttribute('position').array as Int16Array).byteLength * 3
                + (smooth.getIndex()?.array.byteLength ?? 0);
            far.bytes += bytes;
            meshes.bytes += bytes;
        }
    }

    /** Copy the near border, as the stitcher left it, onto each level's border corners. */
    private followSeam(meshes: TileMeshes, far: FarLandMeshes): void {
        const version = meshes.seam?.version ?? 0;
        if (far.seamVersion === version) {
            return;
        }
        far.seamVersion = version;
        const near = meshes.landGeometryFaceted?.getAttribute('position')?.array as Int16Array | undefined;
        if (!near) {
            return;
        }
        for (const level of far.levels) {
            const attr = level.geometry.getAttribute('position') as THREE.BufferAttribute;
            const pos = attr.array as Int16Array;
            const map = level.borderMap;
            for (let i = 0; i < map.length; i += 2) {
                const corner = map[i] * 3, slot = map[i + 1] * 3;
                pos[corner] = near[slot];
                pos[corner + 1] = near[slot + 1];
                pos[corner + 2] = near[slot + 2];
            }
            attr.needsUpdate = true;
            // The welded level: its index maps each faceted corner to the
            // shared vertex it became.
            if (level.smooth !== undefined && level.smooth !== 'none') {
                const smoothAttr = level.smooth.getAttribute('position') as THREE.BufferAttribute;
                const smoothPos = smoothAttr.array as Int16Array;
                const welded = level.smooth.getIndex()!.array;
                for (let i = 0; i < map.length; i += 2) {
                    const v = welded[map[i]] * 3, slot = map[i + 1] * 3;
                    smoothPos[v] = near[slot];
                    smoothPos[v + 1] = near[slot + 1];
                    smoothPos[v + 2] = near[slot + 2];
                }
                smoothAttr.needsUpdate = true;
            }
        }
    }

    /** A tile is being released; drop its far land. */
    release(meshes: TileMeshes): void {
        const far = meshes.far;
        if (far !== undefined && far !== 'pending' && far !== 'none') {
            for (const level of far.levels) {
                level.geometry.dispose();
                if (level.smooth !== undefined && level.smooth !== 'none') {
                    level.smooth.dispose();
                }
                this.triangles -= level.geometry.getAttribute('position').count / 3;
            }
            this.attached--;
        }
        meshes.far = 'none';
    }

    get stats(): { attached: number; triangles: number } {
        return { attached: this.attached, triangles: this.triangles };
    }
}

/**
 * The fingerprint of the land as baked: the stitcher may have moved border
 * vertices since, and the seam state remembers where they were.
 */
function bakedFingerprint(meshes: TileMeshes, positions: Int16Array): number {
    const seam = meshes.seam;
    const border = meshes.border;
    if (!seam || !border) {
        return landFingerprint(positions);
    }
    const baked = positions.slice();
    for (let i = 0; i < border.vertices.length; i++) {
        const v = borderEntryIndex(border.vertices[i]) * 3;
        baked[v] = seam.orig[i * 3];
        baked[v + 1] = seam.orig[i * 3 + 1];
        baked[v + 2] = seam.orig[i * 3 + 2];
    }
    return landFingerprint(baked);
}

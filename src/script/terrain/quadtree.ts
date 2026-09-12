/**
 * Geographic quadtree over the ellipsoid.
 *
 * Its whole job is now to decide *what to draw* and *what to want*. It builds
 * nothing: refinement produces a scored want set that the streamer acts on,
 * and drawing reads whatever the streamer has uploaded. That split is what
 * removes the old build-dispatch, worker-pool coupling and fallback branches.
 *
 * The one invariant worth stating: a parent keeps being drawn until all four
 * of its children are resident. That is what prevents a hole appearing
 * mid-refinement, and it pairs with the streamer's parent-first priority term,
 * which keeps such moments short.
 */

import * as THREE from 'three';
import { behindHorizon, sphereInFrustum } from './culling';
import { WGS84_A } from './geodesy';
import {
    DETAIL_DISTANCE_OFF, FRUSTUM_CULL_MARGIN_TAN, LEAF_REFINE_DISTANCE_SCALE,
    detailFalloff, ellipsoidSagittaM,
    shouldRefine, terrainMaxZoomForAltitudeM, terrainViewRangeM,
} from './lod';
import { TerrainManifest } from './manifest';
import {
    TileKey, childrenOf, rootTiles, tileKeyString,
} from './tiling';
import { TileWant } from './tileStreamer';

export interface QuadNode {
    id: TileKey;
    key: string;
    children?: QuadNode[];
    /** Tile-centre in scene space, and a radius that bounds its geometry. */
    center: THREE.Vector3;
    radius: number;
    /**
     * The error refinement is tested against. The manifest's per-level figure
     * until the tile is resident, then the tile's own - see `errorFromTile`.
     */
    geometricErrorM: number;
    /** True once `geometricErrorM` has been taken from the resident tile. */
    errorFromTile: boolean;
    /** Set once the streamer has this tile uploaded. */
    resident: boolean;
    /** True when the index says there is no baked tile here. */
    ocean: boolean;
    lastSeen: number;
}

export interface QuadtreeOptions {
    manifest: TerrainManifest;
    /** Scene-space position of a tile's origin, for culling. */
    tilePosition: (id: TileKey) => THREE.Vector3;
    /** Bounding radius (m) to use before the real mesh is known. */
    tileRadius: (id: TileKey) => number;
    /** True when the streamer has this tile drawable. */
    isResident: (id: TileKey) => boolean;
    /** True when no baked tile exists (so an ocean patch is used instead). */
    isOcean: (id: TileKey) => boolean;
    /**
     * The resident tile's own header error, undefined before residency.
     *
     * The level table is one figure per zoom for the whole planet - and a
     * monotone max at that, which a mountain baked years ago pinned at 1.6 km
     * for z4-z10, so flat sea refined to z11 out to 130 km. A tile's own
     * figure lets the cut follow the terrain: sea stays coarse, relief refines.
     */
    tileErrorM?: (id: TileKey) => number | undefined;
    maxZoom?: number;
    /** Scene-space position of the ellipsoid centre, for horizon culling. */
    earthCenter: THREE.Vector3;
}

export interface QuadtreeUpdate {
    /** Tiles to draw this pass. */
    draw: QuadNode[];
    /** Tiles worth fetching, scored by the streamer. */
    wants: TileWant[];
}

const _sphereCenter = new THREE.Vector3();

export class Quadtree {
    private readonly roots: QuadNode[];
    private readonly nodes = new Map<string, QuadNode>();
    private readonly maxZoom: number;
    private generation = 0;

    constructor(private readonly opts: QuadtreeOptions) {
        this.maxZoom = opts.maxZoom ?? opts.manifest.mesh.maxZoom;
        this.roots = rootTiles().map(id => this.makeNode(id));
    }

    private makeNode(id: TileKey): QuadNode {
        const key = tileKeyString(id);
        const existing = this.nodes.get(key);
        if (existing) {
            return existing;
        }
        const levelErr = this.opts.manifest.mesh.levelGeometricErrorM[id.z];
        const node: QuadNode = {
            id,
            key,
            center: this.opts.tilePosition(id),
            radius: this.opts.tileRadius(id),
            geometricErrorM: levelErr !== undefined && levelErr > 0
                ? levelErr
                : ellipsoidSagittaM(id),
            errorFromTile: false,
            resident: false,
            ocean: false,
            lastSeen: 0,
        };
        this.nodes.set(key, node);
        return node;
    }

    /**
     * The error that should drive refinement for this node.
     *
     * `geometricErrorM` is the tile's own header figure once it is resident,
     * and the level's `levelGeometricErrorM` before that; either describes
     * the accuracy of a *baked* mesh. A node the index says has no tile never gets
     * that mesh: it is drawn as a 10-triangle ellipsoid patch, and what bounds
     * its deviation is the chord sagitta of that patch. The two differ wildly
     * at coarse zoom -- at z2 the manifest says 1.7 km while the patch actually
     * departs from the ellipsoid by ~490 km -- so using the baked figure let a
     * patch spanning 45 degrees be drawn within sight of the camera, where its
     * interior sags thousands of kilometres below sea level and the sea reads
     * as falling away into nothing.
     *
     * The node one level above the leaf is inflated by `leafScale` (the
     * *Land-use detail reach* setting, default
     * {@link LEAF_REFINE_DISTANCE_SCALE}), so the leaf - and the exact landuse
     * fills only it carries - takes over that much further out.
     */
    private drawErrorM(node: QuadNode, leafScale: number): number {
        const err = node.ocean
            ? Math.max(node.geometricErrorM, ellipsoidSagittaM(node.id))
            : node.geometricErrorM;
        return node.id.z === this.maxZoom - 1 ? err * leafScale : err;
    }

    get nodeCount(): number {
        return this.nodes.size;
    }

    /**
     * Walk the tree for one camera and produce the draw list plus the want set.
     * Pure: it mutates only bookkeeping, never geometry.
     */
    update(
        camera: THREE.PerspectiveCamera,
        screenHeightPx: number,
        fovYDeg: number,
        detailScale: number,
        /**
         * Distance past which the far field is allowed to coarsen faster.
         * {@link DETAIL_DISTANCE_OFF} leaves refinement to screen space alone.
         */
        detailDistanceM: number = DETAIL_DISTANCE_OFF,
        pinned?: (id: TileKey) => boolean,
        /** How much further out the leaf level comes in; see {@link drawErrorM}. */
        leafScale: number = LEAF_REFINE_DISTANCE_SCALE,
    ): QuadtreeUpdate {
        this.generation++;
        const draw: QuadNode[] = [];
        const wants: TileWant[] = [];

        const frustum = new THREE.Frustum().setFromProjectionMatrix(
            new THREE.Matrix4().multiplyMatrices(
                camera.projectionMatrix, camera.matrixWorldInverse,
            ),
        );
        const camPos = camera.position;
        const altitude = camPos.y;
        const range = terrainViewRangeM(altitude);
        const zoomCap = Math.min(
            this.maxZoom,
            terrainMaxZoomForAltitudeM(altitude, this.maxZoom, true),
        );

        const visit = (node: QuadNode): void => {
            node.lastSeen = this.generation;
            node.resident = this.opts.isResident(node.id);
            node.ocean = this.opts.isOcean(node.id);
            if (node.resident && !node.errorFromTile) {
                const own = this.opts.tileErrorM?.(node.id);
                if (own !== undefined && own >= 0) {
                    node.geometricErrorM = own;
                    node.errorFromTile = true;
                }
            }

            _sphereCenter.copy(node.center);
            const centreDist = camPos.distanceTo(_sphereCenter);
            const distance = centreDist - node.radius;
            if (distance > range) {
                return;
            }
            // Test against a frustum widened by one reconcile's worth of
            // rotation. Culling exactly to the edge means a fast turn sweeps
            // past tiles that were correctly dropped a moment ago and are not
            // back yet, which reads as the screen edges going empty.
            const margin = centreDist * FRUSTUM_CULL_MARGIN_TAN;
            if (!sphereInFrustum(_sphereCenter, node.radius + margin, frustum)) {
                return;
            }
            if (behindHorizon(
                _sphereCenter, node.radius, camPos, this.opts.earthCenter, WGS84_A,
            )) {
                return;
            }

            const wantThis = () => {
                if (!node.ocean && !node.resident) {
                    wants.push({
                        id: node.id,
                        ssePx: node.geometricErrorM,
                        distanceM: Math.max(1, distance),
                        inFrustum: true,
                        pinned: pinned ? pinned(node.id) : false,
                    });
                }
            };

            // Terrain *detail* may be degraded by the frame-time governor, but
            // the *shape of the planet* may not: an under-refined ocean patch
            // does not merely look coarse, it puts the sea kilometres from
            // where it belongs. So the sagitta bound is tested at detailScale
            // 1 regardless of how far the governor has backed off.
            const d = Math.max(1, distance);
            // The far-field falloff rides on the same scale as the governor, so
            // the two multiply rather than fight. Like the governor it is a
            // *detail* knob, so the sagitta bound below still ignores it.
            const farScale = detailScale * detailFalloff(d, detailDistanceM);
            const canRefine = node.id.z < zoomCap && (
                shouldRefine(
                    this.drawErrorM(node, leafScale), d, screenHeightPx, fovYDeg, farScale,
                )
                || node.ocean && shouldRefine(
                    ellipsoidSagittaM(node.id), d, screenHeightPx, fovYDeg, 1,
                )
            );

            if (!canRefine) {
                wantThis();
                draw.push(node);
                return;
            }

            if (!node.children) {
                node.children = childrenOf(node.id).map(id => this.makeNode(id));
            }

            // A parent stays drawn until every child can take over. Without
            // this the terrain shows a hole for as long as a child is loading.
            const ready = node.children.every(
                c => this.opts.isResident(c.id) || this.opts.isOcean(c.id),
            );
            if (!ready) {
                wantThis();
                draw.push(node);
                // Still ask for the children, so the wait is bounded.
                for (const c of node.children) {
                    c.lastSeen = this.generation;
                    if (!this.opts.isOcean(c.id) && !this.opts.isResident(c.id)) {
                        wants.push({
                            id: c.id,
                            ssePx: c.geometricErrorM,
                            distanceM: Math.max(1, camPos.distanceTo(c.center) - c.radius),
                            inFrustum: true,
                            pinned: pinned ? pinned(c.id) : false,
                        });
                    }
                }
                return;
            }

            for (const c of node.children) {
                visit(c);
            }
        };

        for (const root of this.roots) {
            visit(root);
        }
        return { draw, wants };
    }

    /** Nodes not seen for `maxAge` passes, so their tiles can be released. */
    stale(maxAge: number): QuadNode[] {
        const out: QuadNode[] = [];
        for (const node of this.nodes.values()) {
            if (this.generation - node.lastSeen > maxAge) {
                out.push(node);
            }
        }
        return out;
    }

    forget(key: string): void {
        this.nodes.delete(key);
    }
}

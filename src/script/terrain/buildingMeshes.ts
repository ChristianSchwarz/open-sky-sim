/**
 * Buildings at runtime: fetching a leaf's PBH1 sidecar, extruding its
 * buildings (buildingRoofs.ts) into one lit mesh in the tile's own group,
 * and drawing as much of it as the frame can afford.
 *
 * Modelled on BridgeMeshes: the sidecar has its own store, gated by
 * index_buildings.bin, and is attached to a drawn leaf whenever it lands.
 * Unlike a bridge set the mesh is built here, not baked - parameters are a
 * tenth of the triangles' bytes - so the building runs on a main-thread
 * budget of BUILDING_BUILD_MS a frame, a tile at a time, most prominent
 * building first.
 *
 * A mesh per patch of the tile (BUILDING_PATCHES a side), one draw each:
 * every face carries its palette tone index (BUILDING_TONES) and the
 * material looks it up (`vertexTones`). The records arrive most prominent
 * first, so a far patch draws a prefix of its mesh - every building at least
 * BUILDING_MIN_PIXELS across at the patch's own near edge - and a frame that
 * would draw more than BUILDING_TRIANGLE_BUDGET raises that floor for every
 * patch alike until it fits. A patch out of view is not drawn and does not
 * count: the tile round the camera is mostly behind it. The terrain's own budget never counts
 * buildings: dropping a house must never coarsen the ground under it.
 */

import * as THREE from 'three';
import { buildingTriangles } from './buildingRoofs';
import { TerrainManifest, buildingTileUrl } from './manifest';
import { PBH_FLAG_NO_WALLS, PBH_FLAG_ROOF_RGB, PbhTile, buildingProminence, decodePbh, pbhRings } from './pbh';
import { TileIndex } from './tileIndex';
import { TileMeshes } from './tileMesh';
import { TileStore } from './tileStore';
import { TileKey } from './tiling';
import { sphereInTile } from './tileFrameBounds';

/** Decoded sidecars kept; a bound tile no longer needs its record bytes. */
const BUILDING_CACHE_BYTES = 24 * 1024 * 1024;
/** Triangles every drawn building together may cost a frame. */
export const BUILDING_TRIANGLE_BUDGET = 300_000;
/** A building is drawn while its prominence spans at least this many pixels at its tile's near edge. */
export const BUILDING_MIN_PIXELS = 2.5;
/** Main-thread time a frame may spend extruding buildings. */
export const BUILDING_BUILD_MS = 3;
/**
 * Houses of one size cross the pixel floor together, so a hard cut brings a
 * whole town in at one frame. A tile adds its buildings at a steady rate
 * instead, biggest first: its whole count over this many seconds, and never
 * slower than `BUILDING_GROW_MIN_PER_S` so a small tile is not left waiting.
 */
export const BUILDING_GROW_SECONDS = 8;
const BUILDING_GROW_MIN_PER_S = 25;
/** Main-thread time a frame may spend extruding buildings on the map; see setBuildingsAtOnce. */
const MAP_BUILDING_BUILD_MS = 12;

let atOnce = false;

/**
 * The map mode: buildings come in whole, not grown in over
 * BUILDING_GROW_SECONDS, and extrude at MAP_BUILDING_BUILD_MS a frame. Both
 * paces are there to keep a flight smooth; on the map nobody is flying and a
 * town trickling in reads as the map being slow.
 */
export function setBuildingsAtOnce(on: boolean): void {
    atOnce = on;
}
/**
 * Patches a side a tile's buildings are split into. Two: the tile under the
 * camera loses the half behind it, for three more draws a tile at most.
 */
const BUILDING_PATCHES = 2;

/** The buildings of one patch of a tile, most prominent first. */
export interface BuildingPatch {
    mesh: THREE.Mesh;
    /** Triangles after the first i + 1 buildings. */
    prefix: Uint32Array;
    /** Per building, most prominent first (pbh.ts buildingProminence). */
    prominence: Float32Array;
    /** Triangles drawn now (the draw range). */
    shown: number;
    /** Buildings drawn now: the prefix `shown` is the triangles of. */
    count: number;
}

export interface BuildingMeshSet {
    group: THREE.Group;
    patches: BuildingPatch[];
    /** Triangles bound, every patch. */
    triangles: number;
    /** GPU bytes bound, for the cache budget. */
    bytes: number;
}

export interface BuildingMeshesOptions {
    manifest: TerrainManifest;
    baseUrl: string;
    /** A shaded material with `vertexTones: BUILDING_TONES`. */
    material: THREE.Material;
    onBeforeRender?: THREE.Mesh['onBeforeRender'];
}

export interface BuildingMeshesStats {
    attached: number;
    inflight: number;
    queued: number;
    failed: number;
    /** Building triangles bound on the GPU. */
    triangles: number;
    /** Of those, drawn in the last main pass. */
    shownTriangles: number;
    /** Tiles waiting to be extruded. */
    building: number;
    /** The pixel floor the budget raised BUILDING_MIN_PIXELS to, or it. */
    minPixels: number;
}

/**
 * Growable triangle soup: positions, flat normals, a tone per vertex and an
 * sRGB colour of its own (alpha 255 when measured, 0 when the tone stands).
 */
class Soup {
    pos = new Float32Array(9 * 1024);
    nrm = new Int8Array(9 * 1024);
    tone = new Uint8Array(3 * 1024);
    raw = new Uint8Array(12 * 1024);
    tris = 0;

    private grow(): void {
        const pos = new Float32Array(this.pos.length * 2);
        pos.set(this.pos);
        this.pos = pos;
        const nrm = new Int8Array(this.nrm.length * 2);
        nrm.set(this.nrm);
        this.nrm = nrm;
        const tone = new Uint8Array(this.tone.length * 2);
        tone.set(this.tone);
        this.tone = tone;
        const raw = new Uint8Array(this.raw.length * 2);
        raw.set(this.raw);
        this.raw = raw;
    }

    /** `rgb` is 0xRRGGBB, or negative for none. */
    push(p: ArrayLike<number>, n: readonly [number, number, number], tone: number, rgb: number): void {
        if ((this.tris + 1) * 9 > this.pos.length) {
            this.grow();
        }
        const o = this.tris * 9;
        for (let k = 0; k < 9; k++) {
            this.pos[o + k] = p[k];
        }
        for (let v = 0; v < 3; v++) {
            this.nrm[o + v * 3] = Math.round(n[0] * 127);
            this.nrm[o + v * 3 + 1] = Math.round(n[1] * 127);
            this.nrm[o + v * 3 + 2] = Math.round(n[2] * 127);
            this.tone[this.tris * 3 + v] = tone;
            const r = (this.tris * 3 + v) * 4;
            if (rgb >= 0) {
                this.raw[r] = (rgb >> 16) & 255;
                this.raw[r + 1] = (rgb >> 8) & 255;
                this.raw[r + 2] = rgb & 255;
                this.raw[r + 3] = 255;
            } else {
                this.raw[r] = this.raw[r + 1] = this.raw[r + 2] = this.raw[r + 3] = 0;
            }
        }
        this.tris++;
    }
}

interface PendingBuild {
    id: TileKey;
    meshes: TileMeshes;
    tile: PbhTile;
    next: number;
    soup: Soup;
    prefix: Uint32Array;
    prominence: Float32Array;
}

/**
 * Extrude buildings [from, to) of a tile into `soup`, in the tile's own axes
 * (metres): a PBH1 point (u, v, h) is u*a + v*b + h*up.
 */
function extrude(job: PendingBuild, to: number): void {
    const { tile, soup } = job;
    const { a, b, up } = tile.frame;
    const p = new Float64Array(9);
    let tone = 0;
    const emit = (
        q: ArrayLike<number>, n: readonly [number, number, number], roof: boolean, roofTone: number, wallTone: number,
        roofRgb: number,
    ) => {
        for (let v = 0; v < 3; v++) {
            const u = q[v * 3], w = q[v * 3 + 1], h = q[v * 3 + 2];
            p[v * 3] = u * a[0] + w * b[0] + h * up[0];
            p[v * 3 + 1] = u * a[1] + w * b[1] + h * up[1];
            p[v * 3 + 2] = u * a[2] + w * b[2] + h * up[2];
        }
        const nx = n[0] * a[0] + n[1] * b[0] + n[2] * up[0];
        const ny = n[0] * a[1] + n[1] * b[1] + n[2] * up[1];
        const nz = n[0] * a[2] + n[1] * b[2] + n[2] * up[2];
        tone = roof ? roofTone : wallTone;
        soup.push(p, [nx, ny, nz], tone, roof ? roofRgb : -1);
    };
    for (let i = job.next; i < to; i++) {
        const bld = tile.buildings[i];
        const rings = pbhRings(tile, bld);
        let area = 0;
        const outer = rings[0] ?? [];
        for (let k = 0, j = outer.length - 1; k < outer.length; j = k++) {
            area += (outer[j][0] - outer[k][0]) * (outer[j][1] + outer[k][1]);
        }
        job.prominence[i] = buildingProminence(Math.abs(area / 2), bld.ridgeM - bld.baseM);
        buildingTriangles({
            rings, baseM: bld.baseM, eaveM: bld.eaveM, ridgeM: bld.ridgeM, form: bld.form,
            ridgeAngle: bld.ridgeAngle, noWalls: (bld.flags & PBH_FLAG_NO_WALLS) !== 0,
        }, (q, n, roof) => emit(q, n, roof, bld.roofTone, bld.wallTone,
            (bld.flags & PBH_FLAG_ROOF_RGB) !== 0 ? bld.roofRgb : -1));
        job.prefix[i] = soup.tris;
    }
    job.next = to;
}

/** The number of buildings, most prominent first, at least `minProminence` tall or wide. */
function countAtLeast(prominence: Float32Array, minProminence: number): number {
    let lo = 0, hi = prominence.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (prominence[mid] >= minProminence) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

function trianglesFor(patch: BuildingPatch, minProminence: number): number {
    const n = countAtLeast(patch.prominence, minProminence);
    return n > 0 ? patch.prefix[n - 1] : 0;
}

const patchSphere = new THREE.Sphere();

export class BuildingMeshes {
    private readonly store: TileStore<PbhTile> | undefined;
    private readonly zoom: number;
    private readonly material: THREE.Material;
    private readonly onBeforeRender: THREE.Mesh['onBeforeRender'] | undefined;
    private index: TileIndex | undefined;
    private on = true;
    private readonly attached = new Set<BuildingMeshSet>();
    private readonly pending: PendingBuild[] = [];
    private tris = 0;
    private shownTris = 0;
    private minPixels = BUILDING_MIN_PIXELS;
    private lastFrameMs = 0;
    /** Fractions of a building owed to each patch between frames. */
    private readonly owed = new WeakMap<BuildingPatch, number>();
    /** This frame's patches of drawn leaves: their near-edge distance, and whether in view. */
    private readonly frame: Array<{ patch: BuildingPatch; nearM: number; inView: boolean }> = [];
    budget = BUILDING_TRIANGLE_BUDGET;

    constructor(opts: BuildingMeshesOptions) {
        const spec = opts.manifest.buildings;
        this.zoom = spec?.maxZoom ?? -1;
        this.material = opts.material;
        this.onBeforeRender = opts.onBeforeRender;
        this.store = spec === undefined ? undefined : new TileStore<PbhTile>({
            baseUrl: opts.baseUrl,
            url: (id) => buildingTileUrl(opts.manifest, id.z, id.x, id.y, opts.baseUrl),
            decode: (buf) => decodePbh(buf),
            sizeOf: (t) => t.verts.byteLength + t.ringSizes.byteLength + t.buildings.length * 64,
            maxBytes: BUILDING_CACHE_BYTES,
            exists: (id) => this.has(id),
        });
    }

    /** Whether the pyramid ships buildings at all. */
    get enabled(): boolean {
        return this.store !== undefined;
    }

    /** The Buildings setting: off hides what is attached and stops new fetches and builds. */
    setEnabled(on: boolean): void {
        this.on = on;
        for (const set of this.attached) {
            set.group.visible = on;
        }
    }

    setIndex(index: TileIndex | undefined): void {
        this.index = index;
    }

    /** Whether the bake wrote a sidecar for this tile. */
    has(id: TileKey): boolean {
        if (id.z !== this.zoom) {
            return false;
        }
        return this.index ? this.index.has(id) : true;
    }

    /** The decoded sidecar for a tile, or null when it has none; whatever the setting. Trees read it. */
    async load(id: TileKey, priority: number): Promise<PbhTile | null> {
        if (!this.store || !this.has(id) || this.store.isAbsent(id)) {
            return null;
        }
        return this.store.get(id) ?? this.store.request(id, priority).catch(() => null);
    }

    /**
     * Give a drawn leaf its buildings: queued for extrusion now if the
     * sidecar is decoded, otherwise when it arrives. Called for every drawn
     * tile every reconcile; past the first call it is a field read.
     */
    attach(id: TileKey, meshes: TileMeshes, priority: number): void {
        if (meshes.buildings !== undefined || !this.store || !this.on || !this.has(id)) {
            return;
        }
        if (this.store.isAbsent(id)) {
            meshes.buildings = 'none';
            return;
        }
        meshes.buildings = 'pending';
        const cached = this.store.get(id);
        if (cached) {
            this.queue(id, meshes, cached);
            return;
        }
        void this.store.request(id, priority).then(tile => {
            if (meshes.buildings !== 'pending') {
                return;
            }
            if (tile === null) {
                meshes.buildings = 'none';
                return;
            }
            this.queue(id, meshes, tile);
        });
    }

    private queue(id: TileKey, meshes: TileMeshes, tile: PbhTile): void {
        if (tile.buildings.length === 0) {
            meshes.buildings = 'none';
            return;
        }
        this.pending.push({
            id, meshes, tile, next: 0, soup: new Soup(),
            prefix: new Uint32Array(tile.buildings.length),
            prominence: new Float32Array(tile.buildings.length),
        });
    }

    /**
     * Extrude queued tiles for up to `budgetMs`, nearest first by the order
     * they were attached in, and bind each one that completes.
     */
    buildPending(budgetMs: number): void {
        if (!this.on) {
            return;
        }
        const start = performance.now();
        if (atOnce) {
            budgetMs = Math.max(budgetMs, MAP_BUILDING_BUILD_MS);
        }
        while (this.pending.length > 0 && performance.now() - start < budgetMs) {
            const job = this.pending[0];
            if (job.meshes.disposed || job.meshes.buildings !== 'pending') {
                this.pending.shift();
                continue;
            }
            const total = job.tile.buildings.length;
            while (job.next < total && performance.now() - start < budgetMs) {
                extrude(job, Math.min(total, job.next + 64));
            }
            if (job.next >= total) {
                this.pending.shift();
                this.bind(job);
            }
        }
    }

    private bind(job: PendingBuild): void {
        const { soup, meshes } = job;
        // The bake sorted by its own measure of prominence; this one reads the
        // ground a little differently, so hold it non-increasing for the
        // binary search in countAtLeast.
        for (let i = 1; i < job.prominence.length; i++) {
            job.prominence[i] = Math.min(job.prominence[i], job.prominence[i - 1]);
        }
        const group = new THREE.Group();
        group.name = `buildings:${job.id.z}/${job.id.x}/${job.id.y}`;
        // Positions are metres; the tile group scales its quantised land up.
        group.scale.setScalar(1 / meshes.group.scale.x);
        group.updateMatrix();
        group.matrixAutoUpdate = false;
        const patches = this.patchesOf(job);
        for (const patch of patches) {
            group.add(patch.mesh);
        }
        group.visible = this.on;
        const set: BuildingMeshSet = {
            group, patches, triangles: soup.tris, bytes: soup.tris * 3 * (12 + 3 + 1 + 4),
        };
        meshes.group.add(group);
        meshes.buildings = set;
        meshes.bytes += set.bytes;
        this.attached.add(set);
        this.tris += soup.tris;
    }

    /**
     * Split a tile's extruded buildings into BUILDING_PATCHES^2 meshes by
     * where each one stands, keeping their order (most prominent first).
     */
    private patchesOf(job: PendingBuild): BuildingPatch[] {
        const { soup, prefix, prominence } = job;
        const n = prefix.length;
        const startOf = (i: number) => (i === 0 ? 0 : prefix[i - 1]);
        // Each building's place in plan: the mean of its first triangle (x, z).
        const cx = new Float32Array(n), cz = new Float32Array(n);
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (let i = 0; i < n; i++) {
            const o = startOf(i) * 9;
            if (prefix[i] === startOf(i)) {
                continue;
            }
            cx[i] = (soup.pos[o] + soup.pos[o + 3] + soup.pos[o + 6]) / 3;
            cz[i] = (soup.pos[o + 2] + soup.pos[o + 5] + soup.pos[o + 8]) / 3;
            x0 = Math.min(x0, cx[i]);
            x1 = Math.max(x1, cx[i]);
            z0 = Math.min(z0, cz[i]);
            z1 = Math.max(z1, cz[i]);
        }
        const p = BUILDING_PATCHES;
        const cell = (i: number) =>
            Math.min(p - 1, Math.floor(((cx[i] - x0) / Math.max(x1 - x0, 1e-6)) * p))
            + p * Math.min(p - 1, Math.floor(((cz[i] - z0) / Math.max(z1 - z0, 1e-6)) * p));
        const members: number[][] = Array.from({ length: p * p }, () => []);
        for (let i = 0; i < n; i++) {
            members[cell(i)].push(i);
        }
        const patches: BuildingPatch[] = [];
        for (const list of members) {
            let tris = 0;
            for (const i of list) {
                tris += prefix[i] - startOf(i);
            }
            if (tris === 0) {
                continue;
            }
            const pos = new Float32Array(tris * 9), nrm = new Int8Array(tris * 9);
            const tone = new Uint8Array(tris * 3), raw = new Uint8Array(tris * 12);
            const patchPrefix = new Uint32Array(list.length), patchProminence = new Float32Array(list.length);
            let at = 0;
            list.forEach((i, k) => {
                const a = startOf(i), b = prefix[i];
                pos.set(soup.pos.subarray(a * 9, b * 9), at * 9);
                nrm.set(soup.nrm.subarray(a * 9, b * 9), at * 9);
                tone.set(soup.tone.subarray(a * 3, b * 3), at * 3);
                raw.set(soup.raw.subarray(a * 12, b * 12), at * 12);
                at += b - a;
                patchPrefix[k] = at;
                patchProminence[k] = prominence[i];
            });
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
            geometry.setAttribute('tone', new THREE.BufferAttribute(tone, 1));
            geometry.setAttribute('rawColor', new THREE.BufferAttribute(raw, 4, true));
            const mesh = new THREE.Mesh(geometry, this.material);
            // Culled by the budget pass (endFrame), against its own bounds.
            mesh.frustumCulled = false;
            mesh.matrixAutoUpdate = false;
            if (this.onBeforeRender) {
                mesh.onBeforeRender = this.onBeforeRender;
            }
            // Hidden until the next frame's budget pass gives it a draw range.
            mesh.visible = false;
            patches.push({ mesh, prefix: patchPrefix, prominence: patchProminence, shown: tris, count: 0 });
        }
        return patches;
    }

    /** A tile is being released; drop its buildings. */
    release(meshes: TileMeshes): void {
        const set = meshes.buildings;
        if (set !== undefined && set !== 'pending' && set !== 'none') {
            this.attached.delete(set);
            this.tris -= set.triangles;
            for (const patch of set.patches) {
                patch.mesh.geometry.dispose();
            }
            set.group.clear();
        }
        // A sidecar in flight or a build in the queue must not bind to a released tile.
        meshes.buildings = 'none';
    }

    /** Start of the main pass's per-tile detail walk. */
    beginFrame(): void {
        this.frame.length = 0;
    }

    /** A passive pass (the target MFD) looks elsewhere: every patch the main view gave a draw range. */
    showAll(meshes: TileMeshes): void {
        const set = meshes.buildings;
        if (set !== undefined && set !== 'pending' && set !== 'none') {
            for (const patch of set.patches) {
                patch.mesh.visible = this.on && patch.shown > 0 && patch.count > 0;
            }
        }
    }

    /**
     * A drawn tile, seen from `eye` (scene frame) through `frustum`; the draw
     * ranges are set in endFrame.
     */
    want(meshes: TileMeshes, eye: THREE.Vector3, frustum: THREE.Frustum): void {
        if (!this.on) {
            return;
        }
        const set = meshes.buildings;
        if (set !== undefined && set !== 'pending' && set !== 'none') {
            for (const patch of set.patches) {
                const s = sphereInTile(patch.mesh, meshes.group, patchSphere);
                this.frame.push({
                    patch, nearM: Math.max(0, s.distanceToPoint(eye)), inView: frustum.intersectsSphere(s),
                });
            }
        }
    }

    /**
     * Set every wanted tile's draw range: buildings at least `minPixels`
     * across, the floor raised for all tiles alike until the frame fits the
     * budget. `pixelAngle` is ground metres per pixel per metre of range.
     */
    endFrame(pixelAngle: number): void {
        const total = (px: number) => {
            let sum = 0;
            for (const { patch, nearM, inView } of this.frame) {
                if (inView) {
                    sum += trianglesFor(patch, px * nearM * pixelAngle);
                }
            }
            return sum;
        };
        let px = BUILDING_MIN_PIXELS;
        if (total(px) > this.budget) {
            let lo = px, hi = px * 2;
            while (total(hi) > this.budget && hi < 4096) {
                lo = hi;
                hi *= 2;
            }
            for (let i = 0; i < 12; i++) {
                const mid = (lo + hi) / 2;
                if (total(mid) > this.budget) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            px = hi;
        }
        this.minPixels = px;
        let shown = 0;
        if (!this.on) {
            this.shownTris = 0;
            return;
        }
        const now = performance.now();
        const dt = this.lastFrameMs === 0 ? 0 : Math.min(0.25, (now - this.lastFrameMs) / 1000);
        this.lastFrameMs = now;
        for (const { patch, nearM, inView } of this.frame) {
            // Out of view it still grows, so turning to it shows no fade-in.
            const want = countAtLeast(patch.prominence, px * nearM * pixelAngle);
            // Shrinking is at once, so the budget holds; growing is one by one.
            if (want <= patch.count || atOnce) {
                patch.count = want;
                this.owed.delete(patch);
            } else {
                const rate = Math.max(BUILDING_GROW_MIN_PER_S, want / BUILDING_GROW_SECONDS);
                const owe = (this.owed.get(patch) ?? 0) + rate * dt;
                const add = Math.floor(owe);
                this.owed.set(patch, owe - add);
                patch.count = Math.min(want, patch.count + add);
            }
            const tris = patch.count > 0 ? patch.prefix[patch.count - 1] : 0;
            if (tris !== patch.shown) {
                patch.shown = tris;
                patch.mesh.geometry.setDrawRange(0, tris * 3);
            }
            patch.mesh.visible = inView && tris > 0;
            if (inView) {
                shown += tris;
            }
        }
        this.shownTris = shown;
    }

    /** Sidecars nobody drew this generation may be evicted from the byte budget. */
    nextGeneration(): void {
        this.store?.nextGeneration();
    }

    get stats(): BuildingMeshesStats {
        const s = this.store?.stats;
        return {
            attached: this.attached.size,
            inflight: s?.inflight ?? 0,
            queued: s?.queued ?? 0,
            failed: s?.failed ?? 0,
            triangles: this.tris,
            shownTriangles: this.shownTris,
            building: this.pending.length,
            minPixels: this.minPixels,
        };
    }
}

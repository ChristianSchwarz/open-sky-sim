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
 * One mesh, one draw per tile: every face carries its palette tone index
 * (BUILDING_TONES) and the material looks it up (`vertexTones`). The
 * records arrive most prominent first, so a far tile draws a prefix of the
 * mesh - every building at least BUILDING_MIN_PIXELS across - and a frame
 * that would draw more than BUILDING_TRIANGLE_BUDGET raises that floor for
 * every tile alike until it fits. The terrain's own budget never counts
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

export interface BuildingMeshSet {
    group: THREE.Group;
    mesh: THREE.Mesh;
    /** Triangles after the first i + 1 buildings. */
    prefix: Uint32Array;
    /** Per building, most prominent first (pbh.ts buildingProminence). */
    prominence: Float32Array;
    /** Triangles drawn now (the draw range). */
    shown: number;
    /** Buildings drawn now: the prefix `shown` is the triangles of. */
    count: number;
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

function trianglesFor(set: BuildingMeshSet, minProminence: number): number {
    const n = countAtLeast(set.prominence, minProminence);
    return n > 0 ? set.prefix[n - 1] : 0;
}

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
    /** Fractions of a building owed to each tile between frames. */
    private readonly owed = new WeakMap<BuildingMeshSet, number>();
    /** This frame's drawn leaves and their near-edge distance, for the budget. */
    private readonly frame: Array<{ set: BuildingMeshSet; nearM: number }> = [];
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
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(soup.pos.slice(0, soup.tris * 9), 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(soup.nrm.slice(0, soup.tris * 9), 3, true));
        geometry.setAttribute('tone', new THREE.BufferAttribute(soup.tone.slice(0, soup.tris * 3), 1));
        geometry.setAttribute('rawColor', new THREE.BufferAttribute(soup.raw.slice(0, soup.tris * 12), 4, true));
        const mesh = new THREE.Mesh(geometry, this.material);
        // Buildings overhang their tile's edge, and the tile is culled whole.
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        if (this.onBeforeRender) {
            mesh.onBeforeRender = this.onBeforeRender;
        }
        const group = new THREE.Group();
        group.name = `buildings:${job.id.z}/${job.id.x}/${job.id.y}`;
        // Positions are metres; the tile group scales its quantised land up.
        group.scale.setScalar(1 / meshes.group.scale.x);
        group.updateMatrix();
        group.matrixAutoUpdate = false;
        group.add(mesh);
        group.visible = this.on;
        // Hidden until the next frame's budget pass gives it a draw range.
        mesh.visible = false;
        const set: BuildingMeshSet = {
            group, mesh, prefix: job.prefix, prominence: job.prominence, shown: soup.tris, count: 0,
            bytes: soup.tris * 3 * (12 + 3 + 1 + 4),
        };
        meshes.group.add(group);
        meshes.buildings = set;
        meshes.bytes += set.bytes;
        this.attached.add(set);
        this.tris += soup.tris;
    }

    /** A tile is being released; drop its buildings. */
    release(meshes: TileMeshes): void {
        const set = meshes.buildings;
        if (set !== undefined && set !== 'pending' && set !== 'none') {
            this.attached.delete(set);
            this.tris -= set.prefix[set.prefix.length - 1] ?? 0;
            set.mesh.geometry.dispose();
            set.group.clear();
        }
        // A sidecar in flight or a build in the queue must not bind to a released tile.
        meshes.buildings = 'none';
    }

    /** Start of the main pass's per-tile detail walk. */
    beginFrame(): void {
        this.frame.length = 0;
    }

    /** A drawn tile and how far its near edge is; the draw ranges are set in endFrame. */
    want(meshes: TileMeshes, nearM: number): void {
        if (!this.on) {
            return;
        }
        const set = meshes.buildings;
        if (set !== undefined && set !== 'pending' && set !== 'none') {
            this.frame.push({ set, nearM });
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
            for (const { set, nearM } of this.frame) {
                sum += trianglesFor(set, px * nearM * pixelAngle);
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
        for (const { set, nearM } of this.frame) {
            const want = countAtLeast(set.prominence, px * nearM * pixelAngle);
            // Shrinking is at once, so the budget holds; growing is one by one.
            if (want <= set.count) {
                set.count = want;
                this.owed.delete(set);
            } else {
                const rate = Math.max(BUILDING_GROW_MIN_PER_S, want / BUILDING_GROW_SECONDS);
                const owe = (this.owed.get(set) ?? 0) + rate * dt;
                const add = Math.floor(owe);
                this.owed.set(set, owe - add);
                set.count = Math.min(want, set.count + add);
            }
            const tris = set.count > 0 ? set.prefix[set.count - 1] : 0;
            if (tris !== set.shown) {
                set.shown = tris;
                set.mesh.geometry.setDrawRange(0, tris * 3);
            }
            set.mesh.visible = tris > 0;
            shown += tris;
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

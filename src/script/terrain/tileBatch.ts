/**
 * Draw-call batching for the per-tile layers that differ between tiles only
 * by their tile's matrix: water, watercourses, roads and railway beds.
 *
 * Every tile drew each of these as a mesh of its own, and three.js spends
 * several microseconds of main thread on every draw however small: 400-odd
 * of a frame's ~850 draws were these layers, a few hundred triangles each.
 * A TileBatch draws every tile's share of one material in a single
 * multi-draw (WEBGL_multi_draw, three's BatchedMesh path): the tiles'
 * vertices and indices are copied into one shared buffer (an arena), and the
 * vertex program fetches each draw's model matrix from a texture by
 * gl_DrawID (TILE_BATCH_PARS_VERTEX).
 *
 * The batch sits at the draw, not in the tiles: the meshes stay where they
 * were, and everything that decides what a tile shows - visibility, road
 * levels swapping index lists, a river's draw range - keeps working on them
 * unchanged. Per pass, the terrain offers each drawn tile's meshes
 * (TileBatcher.offer); a mesh a batch takes is drawn by it from then on, and
 * hidden from the camera on its own by its layers. Its matrixWorld is still
 * updated with the scene, camera-relative, and that is the matrix the batch
 * draws it with, so precision is what the separate draw had.
 *
 * Vertex blocks are keyed by a geometry's position attribute, so the levels
 * of one tile's roads (geometries sharing attributes, differing in index)
 * are copied once; index blocks by the index attribute, rebased into the
 * arena's vertex numbering (WebGL has no base vertex for a multi-draw). A
 * block is copied again when its attribute's version moves, and freed when a
 * geometry over it is disposed - which is how a released tile leaves.
 */

import * as THREE from 'three';

/** First-fit allocator over [0, capacity), adjacent free runs merged. */
export class RangeAllocator {
    private free: Array<{ start: number; size: number }>;

    constructor(public capacity: number) {
        this.free = capacity > 0 ? [{ start: 0, size: capacity }] : [];
    }

    /** The start of `size` units, or -1 when no free run holds them. */
    alloc(size: number): number {
        for (let i = 0; i < this.free.length; i++) {
            const run = this.free[i];
            if (run.size >= size) {
                const start = run.start;
                run.start += size;
                run.size -= size;
                if (run.size === 0) {
                    this.free.splice(i, 1);
                }
                return start;
            }
        }
        return -1;
    }

    release(start: number, size: number): void {
        if (size <= 0) {
            return;
        }
        let i = 0;
        while (i < this.free.length && this.free[i].start < start) {
            i++;
        }
        this.free.splice(i, 0, { start, size });
        // Merge with the run after, then the one before.
        const next = this.free[i + 1];
        if (next && start + size === next.start) {
            this.free[i].size += next.size;
            this.free.splice(i + 1, 1);
        }
        const prev = this.free[i - 1];
        if (prev && prev.start + prev.size === start) {
            prev.size += this.free[i].size;
            this.free.splice(i, 1);
        }
    }

    /** Make room up to `capacity`: the new tail is free. */
    grow(capacity: number): void {
        if (capacity <= this.capacity) {
            return;
        }
        this.release(this.capacity, capacity - this.capacity);
        this.capacity = capacity;
    }

    /** Units free in total, for tests and stats. */
    get freeUnits(): number {
        return this.free.reduce((n, r) => n + r.size, 0);
    }
}

type TypedArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array;
type TypedArrayCtor = { new(length: number): TypedArray };

/** How one attribute is laid out in the arena: what the first member had. */
interface ArenaAttribute {
    ctor: TypedArrayCtor;
    itemSize: number;
    normalized: boolean;
}

interface VertexBlock {
    start: number;
    count: number;
    /** Each source attribute's version when copied. */
    versions: Map<string, number>;
    indices: Map<THREE.BufferAttribute, IndexBlock>;
}

interface IndexBlock {
    start: number;
    count: number;
    version: number;
}

/** The program's per-draw matrices: four RGBA float texels each, MATRIX_TEXTURE_WIDTH texels a row. */
const MATRIX_TEXTURE_WIDTH = 256;
const MATRICES_PER_ROW = MATRIX_TEXTURE_WIDTH / 4;

const INITIAL_VERTICES = 1 << 16;
const INITIAL_INDICES = 1 << 17;

/** A draw's source attribute's element count and copy. */
function attributeSource(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): {
    array: ArrayLike<number>; stride: number; offset: number; version: number;
} {
    if ((attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
        const ia = attr as THREE.InterleavedBufferAttribute;
        return { array: ia.data.array as ArrayLike<number>, stride: ia.data.stride, offset: ia.offset, version: ia.data.version };
    }
    const ba = attr as THREE.BufferAttribute;
    return { array: ba.array as ArrayLike<number>, stride: ba.itemSize, offset: 0, version: ba.version };
}

/**
 * One material's tiles in one multi-draw. `mesh` goes into the scene where
 * the tiles' own draws of this material went; TileBatcher drives it.
 */
export class TileBatch {
    readonly mesh: THREE.Mesh;
    private readonly material: THREE.ShaderMaterial;
    private materialVersion = -1;
    private readonly layout = new Map<string, ArenaAttribute>();
    private vertices = new RangeAllocator(0);
    private indices = new RangeAllocator(0);
    private geometry: THREE.BufferGeometry;
    private readonly blocks = new Map<THREE.BufferAttribute | THREE.InterleavedBufferAttribute, VertexBlock>();
    private readonly disposeHooked = new WeakSet<THREE.BufferGeometry>();
    private members: THREE.Mesh[] = [];
    private starts = new Int32Array(64);
    private counts = new Int32Array(64);
    private drawCount = 0;
    private matrixTexture: THREE.DataTexture;

    constructor(readonly source: THREE.ShaderMaterial, renderOrder: number) {
        this.material = source.clone();
        this.syncMaterial();
        this.matrixTexture = this.makeMatrixTexture(64);
        this.geometry = new THREE.BufferGeometry();
        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.name = `tileBatch:${source.name || source.uuid.slice(0, 8)}`;
        this.mesh.frustumCulled = false;
        this.mesh.matrixAutoUpdate = false;
        this.mesh.renderOrder = renderOrder;
        // three's multi-draw path (WebGLRenderer.renderBufferDirect and the
        // program's USE_BATCHING / gl_DrawID), without BatchedMesh's own
        // instance bookkeeping. Both colour fields: three r185 tests one for
        // the program and the other for its invalidation, and with either
        // undefined the program is rebuilt on every draw.
        const flags = this.mesh as unknown as Record<string, unknown>;
        flags.isBatchedMesh = true;
        flags._colorsTexture = null;
        flags.colorTexture = null;
        flags._multiDrawStarts = this.starts;
        flags._multiDrawCounts = this.counts;
        flags._multiDrawCount = 0;
        this.mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) =>
            this.beforeRender(renderer, scene, camera, group);
        this.mesh.visible = false;
    }

    /** Start a pass: nothing offered yet. */
    begin(): void {
        this.members.length = 0;
        this.drawCount = 0;
        this.mesh.visible = false;
    }

    /**
     * Draw `mesh`'s indices [start, start + count) with this pass's batch.
     * False when the batch cannot take it (an attribute laid out differently
     * from the first member's); the caller leaves it to draw on its own.
     */
    add(mesh: THREE.Mesh, start: number, count: number): boolean {
        const geometry = mesh.geometry;
        const index = geometry.getIndex();
        const position = geometry.getAttribute('position');
        if (!index || !position || count <= 0) {
            return false;
        }
        const vb = this.vertexBlock(geometry, position);
        if (vb === undefined) {
            return false;
        }
        const ib = this.indexBlock(vb, index);
        if (ib === undefined) {
            return false;
        }
        if (this.drawCount === this.starts.length) {
            this.grow2Draws();
        }
        const bytes = (this.geometry.getIndex()!.array as Uint32Array).BYTES_PER_ELEMENT;
        this.starts[this.drawCount] = (ib.start + start) * bytes;
        this.counts[this.drawCount] = Math.min(count, ib.count - start);
        this.drawCount++;
        this.members.push(mesh);
        this.mesh.visible = true;
        return true;
    }

    get draws(): number {
        return this.drawCount;
    }

    /** Vertex and index units in use, for stats and tests. */
    get used(): { vertices: number; indices: number } {
        return {
            vertices: this.vertices.capacity - this.vertices.freeUnits,
            indices: this.indices.capacity - this.indices.freeUnits,
        };
    }

    dispose(): void {
        this.geometry.dispose();
        this.material.dispose();
        this.matrixTexture.dispose();
        this.blocks.clear();
    }

    private beforeRender(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, group: THREE.Group): void {
        // The source material's per-pass refresh (updateUniforms, through
        // the first member's own hook) writes the uniforms both share.
        const first = this.members[0];
        if (first?.onBeforeRender) {
            first.onBeforeRender(renderer, scene, camera, first.geometry, this.source, group);
        }
        this.syncMaterial();
        this.material.uniformsNeedUpdate = true;
        // Members' matrices are camera-relative for this pass (the renderer
        // re-roots the scene at the camera); the batch adds nothing to them.
        this.mesh.matrixWorld.identity();
        if (this.members.length > this.matrixTexture.image.height * MATRICES_PER_ROW) {
            this.matrixTexture.dispose();
            this.matrixTexture = this.makeMatrixTexture(this.members.length * 2);
        }
        const data = this.matrixTexture.image.data as Float32Array;
        for (let i = 0; i < this.members.length; i++) {
            data.set(this.members[i].matrixWorld.elements, i * 16);
        }
        this.matrixTexture.needsUpdate = true;
        (this.mesh as unknown as Record<string, unknown>)._multiDrawCount = this.drawCount;
    }

    /** The batch's copy of the source: its own program variant, the source's uniforms and defines. */
    private syncMaterial(): void {
        if (this.materialVersion === this.source.version) {
            return;
        }
        const keep = this.material.uniforms.uDrawMatrices;
        this.material.copy(this.source);
        this.material.uniforms = this.source.uniforms;
        this.material.defines = this.source.defines;
        // On the shared object, which the source's own program never reads.
        this.material.uniforms.uDrawMatrices = keep ?? { value: null };
        this.material.needsUpdate = true;
        this.materialVersion = this.source.version;
    }

    private makeMatrixTexture(draws: number): THREE.DataTexture {
        const rows = Math.max(1, Math.ceil(draws / MATRICES_PER_ROW));
        const t = new THREE.DataTexture(
            new Float32Array(MATRIX_TEXTURE_WIDTH * rows * 4), MATRIX_TEXTURE_WIDTH, rows,
            THREE.RGBAFormat, THREE.FloatType,
        );
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
        t.needsUpdate = true;
        if (this.material) {
            this.material.uniforms.uDrawMatrices = { value: t };
        }
        return t;
    }

    private grow2Draws(): void {
        const starts = new Int32Array(this.starts.length * 2);
        starts.set(this.starts);
        const counts = new Int32Array(this.counts.length * 2);
        counts.set(this.counts);
        this.starts = starts;
        this.counts = counts;
        const flags = this.mesh as unknown as Record<string, unknown>;
        flags._multiDrawStarts = starts;
        flags._multiDrawCounts = counts;
    }

    /** The geometry's vertices in the arena, copied if new or changed; undefined if they cannot go in. */
    private vertexBlock(
        geometry: THREE.BufferGeometry, position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    ): VertexBlock | undefined {
        for (const [name, attr] of Object.entries(geometry.attributes)) {
            if (!this.layoutAccepts(name, attr)) {
                return undefined;
            }
        }
        let vb = this.blocks.get(position);
        const count = position.count;
        if (vb === undefined) {
            let start = this.vertices.alloc(count);
            if (start < 0) {
                this.growArena(Math.max(this.vertices.capacity * 2, this.vertices.capacity + count, INITIAL_VERTICES), this.indices.capacity);
                start = this.vertices.alloc(count);
            }
            vb = { start, count, versions: new Map(), indices: new Map() };
            this.blocks.set(position, vb);
            // Zeros for any arena attribute this geometry lacks: the run may
            // be a freed one with another tile's values in it.
            for (const name of this.layout.keys()) {
                if (!geometry.attributes[name]) {
                    this.writeZeros(name, vb);
                }
            }
        }
        if (!this.disposeHooked.has(geometry)) {
            this.disposeHooked.add(geometry);
            geometry.addEventListener('dispose', () => this.freeBlock(position));
        }
        for (const [name, attr] of Object.entries(geometry.attributes)) {
            const src = attributeSource(attr);
            if (vb.versions.get(name) !== src.version) {
                this.writeAttribute(name, attr, vb);
                vb.versions.set(name, src.version);
            }
        }
        return vb;
    }

    private indexBlock(vb: VertexBlock, index: THREE.BufferAttribute): IndexBlock | undefined {
        let ib = vb.indices.get(index);
        if (ib === undefined) {
            let start = this.indices.alloc(index.count);
            if (start < 0) {
                this.growArena(this.vertices.capacity,
                    Math.max(this.indices.capacity * 2, this.indices.capacity + index.count, INITIAL_INDICES));
                start = this.indices.alloc(index.count);
            }
            ib = { start, count: index.count, version: -1 };
            vb.indices.set(index, ib);
        }
        if (ib.version !== index.version) {
            const arena = this.geometry.getIndex()!;
            const out = arena.array as Uint32Array;
            const src = index.array;
            for (let i = 0; i < ib.count; i++) {
                out[ib.start + i] = src[i] + vb.start;
            }
            arena.addUpdateRange(ib.start, ib.count);
            arena.needsUpdate = true;
            ib.version = index.version;
        }
        return ib;
    }

    /** Whether `attr` fits the arena's `name`, adding the name on first sight. */
    private layoutAccepts(name: string, attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): boolean {
        const src = attributeSource(attr);
        const ctor = (src.array as TypedArray).constructor as TypedArrayCtor;
        const known = this.layout.get(name);
        if (known) {
            return known.ctor === ctor && known.itemSize === attr.itemSize && known.normalized === attr.normalized;
        }
        this.layout.set(name, { ctor, itemSize: attr.itemSize, normalized: attr.normalized });
        if (this.vertices.capacity > 0) {
            // A late attribute: every block so far reads zeros for it.
            const arr = new ctor(this.vertices.capacity * attr.itemSize);
            this.geometry.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize, attr.normalized));
            for (const vb of this.blocks.values()) {
                vb.versions.delete(name);
            }
        }
        return true;
    }

    private writeAttribute(name: string, attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, vb: VertexBlock): void {
        const target = this.geometry.getAttribute(name) as THREE.BufferAttribute;
        const out = target.array as TypedArray;
        const n = attr.itemSize;
        const src = attributeSource(attr);
        const base = vb.start * n;
        if (src.stride === n && src.offset === 0) {
            out.set((src.array as TypedArray).subarray(0, vb.count * n), base);
        } else {
            for (let v = 0; v < vb.count; v++) {
                for (let k = 0; k < n; k++) {
                    out[base + v * n + k] = src.array[v * src.stride + src.offset + k];
                }
            }
        }
        target.addUpdateRange(base, vb.count * n);
        target.needsUpdate = true;
    }

    private writeZeros(name: string, vb: VertexBlock): void {
        const target = this.geometry.getAttribute(name) as THREE.BufferAttribute;
        const n = target.itemSize;
        (target.array as TypedArray).fill(0, vb.start * n, (vb.start + vb.count) * n);
        target.addUpdateRange(vb.start * n, vb.count * n);
        target.needsUpdate = true;
    }

    private freeBlock(position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): void {
        const vb = this.blocks.get(position);
        if (vb === undefined) {
            return;
        }
        this.blocks.delete(position);
        this.vertices.release(vb.start, vb.count);
        for (const ib of vb.indices.values()) {
            this.indices.release(ib.start, ib.count);
        }
    }

    /**
     * Room for `vertices` and `indices`: new arrays with the old contents,
     * in a new geometry (the old one's buffers are released with it).
     */
    private growArena(vertices: number, indices: number): void {
        const next = new THREE.BufferGeometry();
        for (const [name, lay] of this.layout) {
            const arr = new lay.ctor(vertices * lay.itemSize);
            const old = this.geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
            if (old) {
                arr.set(old.array as TypedArray);
            }
            next.setAttribute(name, new THREE.BufferAttribute(arr, lay.itemSize, lay.normalized));
        }
        const index = new Uint32Array(indices);
        const oldIndex = this.geometry.getIndex();
        if (oldIndex) {
            index.set(oldIndex.array as Uint32Array);
        }
        next.setIndex(new THREE.BufferAttribute(index, 1));
        // Never computed from the arena (tiles in their own frames): far off
        // and empty, so the near-first opaque sort puts the batch after the
        // tiles' own depth-writing draws, where its members used to be.
        next.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -1e8, 0), 0);
        next.boundingBox = new THREE.Box3(new THREE.Vector3(0, -1e8, 0), new THREE.Vector3(0, -1e8, 0));
        this.geometry.dispose();
        this.geometry = next;
        this.mesh.geometry = next;
        this.vertices.grow(vertices);
        this.indices.grow(indices);
    }
}

/**
 * The terrain's batches, one per registered material, under `root`. Per
 * pass: begin(), offer() every drawn tile's meshes, then the root draws.
 */
export class TileBatcher {
    readonly root = new THREE.Group();
    private readonly batches = new Map<THREE.Material, TileBatch>();
    /** Off: every mesh draws on its own again (`__debugTileBatch = false` from the console). */
    enabled = true;

    constructor() {
        this.root.name = 'tileBatches';
        this.root.matrixAutoUpdate = false;
    }

    /** Batch every offered mesh drawn with `material`, in a draw at `renderOrder`, in registration order. */
    register(material: THREE.ShaderMaterial, renderOrder: number): void {
        if (this.batches.has(material)) {
            return;
        }
        const batch = new TileBatch(material, renderOrder);
        this.batches.set(material, batch);
        this.root.add(batch.mesh);
    }

    begin(): void {
        for (const batch of this.batches.values()) {
            batch.begin();
        }
    }

    /**
     * Draw `mesh` with its material's batch this pass, if it has one and is
     * visible; a mesh taken once is hidden from the camera on its own for
     * good (layers), and drawn only through here.
     */
    offer(mesh: THREE.Mesh | undefined): void {
        if (mesh === undefined || !mesh.visible || !this.enabled) {
            if (mesh && !this.enabled && mesh.userData.tileBatched) {
                mesh.layers.enable(0);
                mesh.userData.tileBatched = false;
            }
            return;
        }
        const geometry = mesh.geometry;
        let material = mesh.material as THREE.Material | THREE.Material[];
        let start = geometry.drawRange.start;
        let end = geometry.drawRange.count === Infinity ? Infinity : start + geometry.drawRange.count;
        if (Array.isArray(material)) {
            // A one-group geometry over a material array: the water's.
            if (geometry.groups.length !== 1) {
                return;
            }
            const g = geometry.groups[0];
            material = material[g.materialIndex ?? 0];
            start = Math.max(start, g.start);
            end = Math.min(end, g.start + g.count);
        }
        const batch = material && this.batches.get(material);
        if (!batch) {
            return;
        }
        const indexCount = geometry.getIndex()?.count ?? 0;
        end = Math.min(end, indexCount);
        if (end <= start) {
            return;
        }
        if (batch.add(mesh, start, end - start)) {
            if (!mesh.userData.tileBatched) {
                mesh.layers.disableAll();
                mesh.userData.tileBatched = true;
            }
        } else if (mesh.userData.tileBatched) {
            mesh.layers.enable(0);
            mesh.userData.tileBatched = false;
        }
    }

    /** Draws this pass across every batch. */
    get draws(): number {
        let n = 0;
        for (const b of this.batches.values()) {
            n += b.draws;
        }
        return n;
    }

    dispose(): void {
        for (const b of this.batches.values()) {
            b.dispose();
        }
        this.batches.clear();
        this.root.clear();
    }
}

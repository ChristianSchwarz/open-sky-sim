/**
 * The one piece of terrain geometry still generated at runtime.
 *
 * The quadtree covers the whole ellipsoid, but the bake only produces tiles
 * where there is data — everything else is open ocean, which is unbounded and
 * cannot be baked. So a tile the index says is absent gets a flat sea-level
 * patch instead: four surface triangles plus a skirt ring, twelve vertices.
 *
 * Replacing this with a single analytic sea-level sphere does not work. A
 * whole-Earth sphere cheap enough to draw has a chord sagitta of several
 * hundred metres, so it would cut straight through the islands. You need an
 * LOD sphere, and an LOD sphere is the quadtree again.
 */

import * as THREE from 'three';
import { EnuBasis, WGS84_A, ecefToEnu, geodeticToEcef, sceneZFromNorth } from './geodesy';
import { TileKey, tileBounds } from './tiling';
import { TerrainTone } from './tones';

/** Cover colour (sRGB) and class of lifted ground; see buildOceanPatch. */
const LIFTED_COVER = [176, 150, 112, 0];

/** Surface subdivision per side. 2 keeps the patch flat but not degenerate. */
const DIVISIONS = 2;

/**
 * Least skirt depth, metres. The level's own figure is set for baked tiles,
 * which the runtime stitches to each other; a patch is not stitched, and the
 * 25 m skirt at z8 left its seam against a baked neighbour open to the sky,
 * a dashed white crack across the sea from altitude. A patch's skirt only
 * ever hangs under open sea, so a deep one cannot show as a wall.
 */
const MIN_SKIRT_M = 1_000;

/**
 * How many levels coarser a neighbour may be. A coarse ancestor padding the
 * open sea can have a whole edge as one chord, sagging under the curve by
 * edge^2 / 8R - about 7 km for a z6 edge beside a z8 patch - and from near
 * the horizon the sky showed through under a skirt shallower than that.
 */
const NEIGHBOUR_LEVELS = 2;

/** Depth that covers the sag of a neighbour's single-chord edge. */
function coarseNeighbourSagM(z: number): number {
    // Longest edge at that zoom: a parallel at the equator.
    const edge = (2 * Math.PI * WGS84_A) / 2 ** Math.max(0, z - NEIGHBOUR_LEVELS);
    return edge * edge / (8 * WGS84_A);
}

export interface OceanPatch {
    group: THREE.Group;
    bytes: number;
    /** Built without all the heights its lift wanted; rebuilt later. */
    provisional?: boolean;
}

/**
 * Build a sea-level patch for `id`. `skirtDepthM` seals the seam against a
 * neighbouring DEM tile, which hangs its own skirt down the same edge.
 * `liftAt` (degrees in, metres above sea level out) raises the surface: the
 * ground outside every baked area carries on at the height of the area's
 * edge rather than dropping to the sea, on a `liftDivisions` grid.
 */
export function buildOceanPatch(
    id: TileKey,
    basis: EnuBasis,
    seaLevel: number,
    skirtDepthM: number,
    materials: readonly THREE.Material[],
    onBeforeRender?: THREE.Mesh['onBeforeRender'],
    liftAt?: (lon: number, lat: number) => number,
    liftDivisions = DIVISIONS,
): OceanPatch {
    const b = tileBounds(id);
    const skirt = skirtDepthM > 0
        ? Math.max(skirtDepthM, MIN_SKIRT_M, 1.2 * coarseNeighbourSagM(id.z))
        : 0;
    const centreLon = (b.west + b.east) / 2;
    const centreLat = (b.south + b.north) / 2;
    const origin = ecefToEnu(basis, geodeticToEcef(centreLat, centreLon, seaLevel));

    const divisions = liftAt ? liftDivisions : DIVISIONS;
    const n = divisions + 1;
    const positions: number[] = [];
    const indices: number[] = [];

    // Scene-space offsets from the patch origin: z runs south, so the north
    // component flips. See sceneFromEnu.
    const localAt = (lon: number, lat: number, h: number) => {
        const e = ecefToEnu(basis, geodeticToEcef(lat, lon, h));
        return [e.e - origin.e, e.u - origin.u, sceneZFromNorth(e.n - origin.n)];
    };

    for (let row = 0; row < n; row++) {
        const lat = b.north + (b.south - b.north) * (row / divisions);
        for (let col = 0; col < n; col++) {
            const lon = b.west + (b.east - b.west) * (col / divisions);
            positions.push(...localAt(lon, lat, seaLevel + (liftAt ? liftAt(lon, lat) : 0)));
        }
    }
    for (let row = 0; row < divisions; row++) {
        for (let col = 0; col < divisions; col++) {
            const a = row * n + col;
            const c = a + 1;
            const d = a + n;
            const e = d + 1;
            indices.push(a, d, c, c, d, e);
        }
    }

    // Skirt: drop the boundary ring so the seam against a DEM tile is sealed.
    if (skirt > 0) {
        const ring: number[] = [];
        for (let col = 0; col < n; col++) ring.push(col);
        for (let row = 1; row < n; row++) ring.push(row * n + (n - 1));
        for (let col = n - 2; col >= 0; col--) ring.push((n - 1) * n + col);
        for (let row = n - 2; row >= 1; row--) ring.push(row * n);

        const base = positions.length / 3;
        for (const idx of ring) {
            positions.push(
                positions[idx * 3],
                positions[idx * 3 + 1] - skirt,
                positions[idx * 3 + 2],
            );
        }
        for (let i = 0; i < ring.length; i++) {
            const top = ring[i];
            const topNext = ring[(i + 1) % ring.length];
            const bot = base + i;
            const botNext = base + ((i + 1) % ring.length);
            indices.push(top, bot, topNext, topNext, bot, botNext);
        }
    }

    const geometry = new THREE.BufferGeometry();
    const pos = new Float32Array(positions);
    const idx = new Uint16Array(indices);
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    if (liftAt) {
        // Drawn with the land material, which wants what a baked land mesh
        // carries: a normal and a cover colour per vertex. The colour is a
        // plain dry ground; the shell paints the globe map over it anyway.
        geometry.computeVertexNormals();
        const count = pos.length / 3;
        const attrs = new Uint8Array(count * 4);
        for (let i = 0; i < count; i++) {
            attrs.set(LIFTED_COVER, i * 4);
        }
        const buffer = new THREE.InterleavedBuffer(attrs, 4);
        geometry.setAttribute('coverColor', new THREE.InterleavedBufferAttribute(buffer, 3, 0, true));
        geometry.setAttribute('coverClass', new THREE.InterleavedBufferAttribute(buffer, 1, 3, false));
        geometry.setAttribute('regionSize', new THREE.BufferAttribute(new Float32Array(count).fill(1e6), 1, false));
    }
    // Lifted ground is land: the water material draws its sheet at sea level.
    geometry.addGroup(0, idx.length, liftAt ? TerrainTone.Bare : TerrainTone.Water);

    const mesh = new THREE.Mesh(geometry, materials as THREE.Material[]);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false; // identity local transform, never moves
    if (onBeforeRender) {
        mesh.onBeforeRender = onBeforeRender;
    }

    const group = new THREE.Group();
    group.name = `ocean:${id.z}/${id.x}/${id.y}`;
    group.position.set(origin.e, origin.u, sceneZFromNorth(origin.n));
    group.add(mesh);
    // Position is set exactly once, right above, for the patch's whole
    // lifetime — see the matching comment in tileMesh.ts's buildTileMeshes.
    group.updateMatrix();
    group.matrixAutoUpdate = false;

    return { group, bytes: pos.byteLength + idx.byteLength };
}

export function disposeOceanPatch(p: OceanPatch): void {
    for (const child of p.group.children) {
        if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
        }
    }
    p.group.clear();
}

/**
 * Several patches drawn as one mesh, for the edge fill beside one tile: each
 * was a draw of its own, ~20 % of a frame's draws along a border (2026-10-28).
 * All carry the same attributes and the one land group; positions move into
 * the first patch's frame. The patches themselves are left as they are.
 */
export function mergeOceanPatches(patches: OceanPatch[]): THREE.Group {
    const meshes = patches.map(p => p.group.children[0] as THREE.Mesh);
    const first = meshes[0];
    const base = patches[0].group.position;
    let vertices = 0;
    let indexCount = 0;
    for (const m of meshes) {
        vertices += m.geometry.getAttribute('position').count;
        indexCount += m.geometry.getIndex()!.count;
    }
    const geometry = new THREE.BufferGeometry();
    for (const name of Object.keys(first.geometry.attributes)) {
        const a0 = first.geometry.getAttribute(name);
        const size = a0.itemSize;
        const ctor = (a0 instanceof THREE.InterleavedBufferAttribute ? a0.data.array : a0.array).constructor as
            new (n: number) => Float32Array | Uint8Array;
        const out = new ctor(vertices * size);
        let o = 0;
        for (let k = 0; k < meshes.length; k++) {
            const a = meshes[k].geometry.getAttribute(name);
            const shift = name === 'position' ? patches[k].group.position.clone().sub(base) : undefined;
            for (let i = 0; i < a.count; i++) {
                for (let c = 0; c < size; c++) {
                    // Raw components: normalized attributes keep their bytes.
                    let v = a instanceof THREE.InterleavedBufferAttribute
                        ? a.data.array[i * a.data.stride + a.offset + c]
                        : a.array[i * size + c];
                    if (shift) {
                        v += c === 0 ? shift.x : c === 1 ? shift.y : shift.z;
                    }
                    out[o++] = v;
                }
            }
        }
        geometry.setAttribute(name, new THREE.BufferAttribute(out, size, a0.normalized));
    }
    const index = vertices > 0xffff ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    let io = 0;
    let offset = 0;
    for (const m of meshes) {
        const idx = m.geometry.getIndex()!;
        for (let i = 0; i < idx.count; i++) {
            index[io++] = idx.array[i] + offset;
        }
        offset += m.geometry.getAttribute('position').count;
    }
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.addGroup(0, indexCount, first.geometry.groups[0].materialIndex ?? 0);

    const mesh = new THREE.Mesh(geometry, first.material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.onBeforeRender = first.onBeforeRender;
    const group = new THREE.Group();
    group.name = `oceans:${patches[0].group.name}`;
    group.position.copy(base);
    group.add(mesh);
    group.updateMatrix();
    group.matrixAutoUpdate = false;
    return group;
}

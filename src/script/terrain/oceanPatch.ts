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
import { EnuBasis, ecefToEnu, geodeticToEcef, sceneZFromNorth } from './geodesy';
import { TileKey, tileBounds } from './tiling';
import { TerrainTone } from './tones';

/** Surface subdivision per side. 2 keeps the patch flat but not degenerate. */
const DIVISIONS = 2;

export interface OceanPatch {
    group: THREE.Group;
    bytes: number;
}

/**
 * Build a sea-level patch for `id`. `skirtDepthM` seals the seam against a
 * neighbouring DEM tile, which hangs its own skirt down the same edge.
 */
export function buildOceanPatch(
    id: TileKey,
    basis: EnuBasis,
    seaLevel: number,
    skirtDepthM: number,
    materials: readonly THREE.Material[],
    onBeforeRender?: THREE.Mesh['onBeforeRender'],
): OceanPatch {
    const b = tileBounds(id);
    const centreLon = (b.west + b.east) / 2;
    const centreLat = (b.south + b.north) / 2;
    const origin = ecefToEnu(basis, geodeticToEcef(centreLat, centreLon, seaLevel));

    const n = DIVISIONS + 1;
    const positions: number[] = [];
    const indices: number[] = [];

    // Scene-space offsets from the patch origin: z runs south, so the north
    // component flips. See sceneFromEnu.
    const localAt = (lon: number, lat: number, h: number) => {
        const e = ecefToEnu(basis, geodeticToEcef(lat, lon, h));
        return [e.e - origin.e, e.u - origin.u, sceneZFromNorth(e.n - origin.n)];
    };

    for (let row = 0; row < n; row++) {
        const lat = b.north + (b.south - b.north) * (row / DIVISIONS);
        for (let col = 0; col < n; col++) {
            const lon = b.west + (b.east - b.west) * (col / DIVISIONS);
            positions.push(...localAt(lon, lat, seaLevel));
        }
    }
    for (let row = 0; row < DIVISIONS; row++) {
        for (let col = 0; col < DIVISIONS; col++) {
            const a = row * n + col;
            const c = a + 1;
            const d = a + n;
            const e = d + 1;
            indices.push(a, d, c, c, d, e);
        }
    }

    // Skirt: drop the boundary ring so the seam against a DEM tile is sealed.
    if (skirtDepthM > 0) {
        const ring: number[] = [];
        for (let col = 0; col < n; col++) ring.push(col);
        for (let row = 1; row < n; row++) ring.push(row * n + (n - 1));
        for (let col = n - 2; col >= 0; col--) ring.push((n - 1) * n + col);
        for (let row = n - 2; row >= 1; row--) ring.push(row * n);

        const base = positions.length / 3;
        for (const idx of ring) {
            positions.push(
                positions[idx * 3],
                positions[idx * 3 + 1] - skirtDepthM,
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
    geometry.addGroup(0, idx.length, TerrainTone.Water);

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

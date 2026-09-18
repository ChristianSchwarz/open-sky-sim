/**
 * Scatters tree billboards over a tile's already-baked forest facets.
 *
 * No new bake stage or sidecar: `PtmTile.landAttrs` already carries an
 * observed {@link TerrainClass} per land triangle (from the ESA WorldCover
 * cover bake), so a tile that streams in with `TerrainClass.Tree` triangles
 * can be scattered with trees the moment it decodes, entirely at runtime.
 *
 * Species selection has no climate/geography model behind it: this roster
 * (see treeSprites.ts) is a look-alike replica of a reference chart of named
 * central European species, not a set of world biomes, so every scattered
 * tree just picks uniformly at random (a deterministic per-instance hash)
 * across the roster - a forest is a mix of all of them, not a monoculture
 * per tile. Each species needs its own atlas texture, so one tile's forest
 * becomes up to SPECIES_COUNT separate InstancedMeshes (see
 * scatterTreeSpecies / buildSpeciesTreeMesh), one per species actually
 * present rather than one per tile.
 */

import * as THREE from 'three';
import { PaletteCategory } from '../config/palettes/palette';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../scene/materials/materials';
import { SPECIES_COUNT, Species } from '../scene/vegetation/treeSprites';
import { PtmTile } from './ptm';

// TerrainClass.Tree spelled out: it is a `const enum`, and the tsx test
// runner leaves an imported const-enum binding undefined (see tileMesh.ts's
// GROUND_CLASS for the same workaround).
const TREE_CLASS = 1;

/**
 * One tree per this many square metres of forest-classed triangle area,
 * applied uniformly everywhere - no per-tile scaling, so density does not
 * depend on how much forest a given tile happens to contain. Only leaf tiles
 * get trees at all (see terrainEntity.ts's upload callback); a coarse
 * ancestor tile is routinely resident purely as a cache fallback for an area
 * its own leaf descendants already cover, so giving it trees too was
 * multiplying density by however many LOD levels happened to be cached over
 * the same ground. The only other limit is TOTAL_TREE_SAFETY_CAP below, a
 * last-resort valve, not something that shapes normal density - but tuned
 * with real dense forest in mind: a wide, high-altitude view over
 * continuous woodland can legitimately have several dozen leaf tiles
 * resident at once, and 60 m^2/tree measured 455k total instances and a
 * ~9 FPS frame time over one such area, worse than any one tile's own cap.
 */
const TREE_SPACING_M2 = 200;
/**
 * Last-resort safety valve, not a density knob - see TREE_SPACING_M2. Kept
 * low on purpose: buildSpeciesTreeMesh builds every instance's matrix in one
 * synchronous pass (no pacing within a single tile), so this is also
 * effectively a ceiling on how long that pass can run - a large tile hitting
 * this cap is a visibly thinner treeline than its true density, not the
 * full-frame stall a much higher cap would risk once it triggers.
 */
const TOTAL_TREE_SAFETY_CAP = 20000;
const TREE_HALF_WIDTH_M = 5;
const TREE_HEIGHT_M = 14;

function hash01(n: number): number {
    const s = Math.sin(n * 12.9898) * 43758.5453;
    return s - Math.floor(s);
}

interface Vec3 {
    x: number;
    y: number;
    z: number;
}

function readVert(tile: PtmTile, triangle: number, corner: number): Vec3 {
    const v = triangle * 3 + corner;
    const s = tile.quantScale;
    return {
        x: tile.landPositions[v * 3] * s,
        y: tile.landPositions[v * 3 + 1] * s,
        z: tile.landPositions[v * 3 + 2] * s,
    };
}

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/** Uniform point-in-triangle sampling (Osada et al.), so scattered trees never land outside their facet. */
function pointInTriangle(a: Vec3, b: Vec3, c: Vec3, r1: number, r2: number): Vec3 {
    const sr1 = Math.sqrt(r1);
    const wa = 1 - sr1;
    const wb = sr1 * (1 - r2);
    const wc = sr1 * r2;
    return {
        x: wa * a.x + wb * b.x + wc * c.x,
        y: wa * a.y + wb * b.y + wc * c.y,
        z: wa * a.z + wb * b.z + wc * c.z,
    };
}

export interface SpeciesGroup {
    species: Species;
    points: Vec3[];
    /** Observed ground colour (sRGB 0..1, rgb triplets) under each point, parallel to `points`. */
    tints: number[];
}

/** Full density within this range of the camera. */
const TREE_DENSITY_NEAR_M = 3000;
/** Density falls off linearly between the two, reaching TREE_DENSITY_FAR_SCALE at this range. */
const TREE_DENSITY_FAR_M = 12000;
/** Density at TREE_DENSITY_FAR_M and beyond - thinned out, not zero, so distant forest doesn't have a hard edge. */
const TREE_DENSITY_FAR_SCALE = 0.12;

/** How much to thin out a tile's tree density for a tile this far from the camera - 1 = full, down to TREE_DENSITY_FAR_SCALE. */
export function treeDensityScaleForDistance(distanceM: number): number {
    if (distanceM <= TREE_DENSITY_NEAR_M) {
        return 1;
    }
    if (distanceM >= TREE_DENSITY_FAR_M) {
        return TREE_DENSITY_FAR_SCALE;
    }
    const t = (distanceM - TREE_DENSITY_NEAR_M) / (TREE_DENSITY_FAR_M - TREE_DENSITY_NEAR_M);
    return 1 + (TREE_DENSITY_FAR_SCALE - 1) * t;
}

/** User-adjustable overall density multiplier, see TerrainEntityOptions.treeDensity. 0 turns trees off entirely. */
export const TREE_DENSITY_MULTIPLIER_MIN = 0;
export const TREE_DENSITY_MULTIPLIER_MAX = 20;
export const TREE_DENSITY_MULTIPLIER_DEFAULT = 1;

export function clampTreeDensityMultiplier(value: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return TREE_DENSITY_MULTIPLIER_DEFAULT;
    }
    return Math.min(TREE_DENSITY_MULTIPLIER_MAX, Math.max(TREE_DENSITY_MULTIPLIER_MIN, value));
}

/**
 * Scatters points over a tile's forest-classed land triangles at a fixed,
 * tile-independent density, scaled by `densityScale` - the combination of
 * treeDensityScaleForDistance (a tile far from the camera is thinned out
 * rather than costing the same as one right underneath it) and the user's
 * overall density setting (see TREE_DENSITY_MULTIPLIER_DEFAULT) - and
 * buckets each point by an independently (per-instance) chosen species so a
 * forest reads as a mixed stand rather than one species per tile. Returns
 * one entry per species actually present (never more than SPECIES_COUNT,
 * often fewer), or an empty array for a tile with no forest.
 */
export function scatterTreeSpecies(tile: PtmTile, densityScale = 1): SpeciesGroup[] {
    const triCount = tile.landAttrs.length / 4 / 3;
    const bySpecies = new Map<Species, SpeciesGroup>();
    let total = 0;
    // The cap grows with the user's density (densityScale > 1) so the slider
    // still changes dense tiles instead of all clamping to the same count.
    const cap = TOTAL_TREE_SAFETY_CAP * Math.max(1, densityScale);

    // Pre-pass: when the tile's whole forest would exceed the safety cap,
    // thin every triangle by the same factor. Breaking out at the cap
    // instead starves every triangle after the first ones in mesh order -
    // trees on a thin rim of the wood and none in its interior.
    let expectedTotal = 0;
    for (let t = 0; t < triCount; t++) {
        if (tile.landAttrs[(t * 3) * 4 + 3] !== TREE_CLASS) {
            continue;
        }
        expectedTotal += triangleArea(readVert(tile, t, 0), readVert(tile, t, 1), readVert(tile, t, 2))
            / TREE_SPACING_M2 * densityScale;
    }
    const capScale = expectedTotal > cap ? cap / expectedTotal : 1;

    outer:
    for (let t = 0; t < triCount; t++) {
        const cls = tile.landAttrs[(t * 3) * 4 + 3];
        if (cls !== TREE_CLASS) {
            continue;
        }
        const v0 = readVert(tile, t, 0);
        const v1 = readVert(tile, t, 1);
        const v2 = readVert(tile, t, 2);
        const area = triangleArea(v0, v1, v2);
        const expected = (area / TREE_SPACING_M2) * densityScale * capScale;
        const seed = t * 97.13;
        const whole = Math.floor(expected);
        const count = whole + (hash01(seed) < expected - whole ? 1 : 0);

        for (let i = 0; i < count; i++) {
            if (total >= cap) {
                break outer;
            }
            const r1 = hash01(seed + i * 2.371);
            const r2 = hash01(seed + i * 2.371 + 0.5);
            const point = pointInTriangle(v0, v1, v2, r1, r2);
            const species = Math.min(
                Math.floor(hash01(seed + i * 8.923) * SPECIES_COUNT),
                SPECIES_COUNT - 1,
            ) as Species;

            let group = bySpecies.get(species);
            if (!group) {
                group = { species, points: [], tints: [] };
                bySpecies.set(species, group);
            }
            group.points.push(point);
            const a = (t * 3) * 4;
            group.tints.push(tile.landAttrs[a] / 255, tile.landAttrs[a + 1] / 255, tile.landAttrs[a + 2] / 255);
            total++;
        }
    }

    return [...bySpecies.values()];
}

function buildQuadGeometry(): THREE.BufferGeometry {
    const hw = TREE_HALF_WIDTH_M;
    const h = TREE_HEIGHT_M;
    const positions = new Float32Array([
        -hw, 0, 0, hw, 0, 0, hw, h, 0,
        -hw, 0, 0, hw, h, 0, -hw, h, 0,
    ]);
    // v=1 at the ground vertices, v=0 at the treetop — matches the sprite
    // atlas, whose cells are drawn canopy-up (see treeAtlas.ts / treeSprites.ts).
    const uvs = new Float32Array([
        0, 1, 1, 1, 1, 0,
        0, 1, 1, 0, 0, 0,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    return geometry;
}

/** Builds one species' worth of already-scattered points into an InstancedMesh bound to that species' atlas. */
export function buildSpeciesTreeMesh(
    group: SpeciesGroup,
    materials: SceneMaterialManager,
    atlas: THREE.Texture,
): THREE.InstancedMesh {
    const { points } = group;
    const geometry = buildQuadGeometry();
    const material = materials.build({
        type: SceneMaterialPrimitiveType.TREE_BILLBOARD,
        // The canopy is a neutral near-white in the atlas (see
        // treeSprites.ts) and gets tinted in the fragment shader by this
        // category's resolved colour, so trees read as the same forest
        // green the ground is painted rather than a fixed hue baked into
        // the sprite - and follow the same palette/time-of-day changes.
        category: PaletteCategory.TERRAIN_FOREST,
        depthWrite: true,
        map: atlas,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, points.length);
    const shade = new Float32Array(points.length * 4);
    const m = new THREE.Matrix4();
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        // A little per-instance scale jitter reads as size variation without
        // needing separate per-species geometry.
        const scale = 0.85 + hash01(i * 5.113 + group.species * 13.1 + 1) * 0.3;
        m.makeScale(scale, scale, scale);
        m.setPosition(p.x, p.y, p.z);
        mesh.setMatrixAt(i, m);
        // Small per-instance brightness variation on top of the terrain-forest
        // tint, so a dense patch doesn't read as one flat, uniform colour.
        // rgb = the sampled ground colour, a = lighter/darker variation; the
        // fragment shader mixes the ground colour 50:50 with the palette green.
        shade[i * 4] = group.tints[i * 3];
        shade[i * 4 + 1] = group.tints[i * 3 + 1];
        shade[i * 4 + 2] = group.tints[i * 3 + 2];
        shade[i * 4 + 3] = (0.3 + hash01(i * 6.451 + group.species * 17.3 + 2) * 0.3) * 0.9;
    }
    mesh.instanceMatrix.needsUpdate = true;
    geometry.setAttribute('instanceShade', new THREE.InstancedBufferAttribute(shade, 4));
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    return mesh;
}

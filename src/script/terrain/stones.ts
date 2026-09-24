/**
 * Scatters small stone, shrub and tree billboards over a tile's already-baked
 * bare/open-ground facets - the same "no new bake stage" trick
 * treeBillboards.ts uses: a tile that streams in with a natural,
 * non-forested ground class can be scattered the moment it decodes, entirely
 * at runtime, straight from PtmTile.landAttrs.
 *
 * Each candidate point picks rock, shrub or tree by how green the facet's
 * own baked ground colour is (see greenBias/greenSplit): a neutral/tan patch
 * stays all rock, a mildly green one grows mostly shrubs with the odd rock,
 * and once it leans green enough to read as proper grassland it starts
 * mixing in the occasional full tree too - the same per-triangle tint used
 * to tint every sprite kind once picked (see tints/groundRatio mixing,
 * shared with treeBillboards.ts). Shrubs and trees here reuse the exact same
 * Species sprites and buildTreeMesh path as treeBillboards.ts's own
 * forest/shrubland scatter (see scatterTreeSpecies's TREE_CLASS/SHRUB_CLASS)
 * - this is a second, independent source of vegetation instances for facets
 * landcover never classified as forest/shrubland in the first place, not a
 * replacement for it.
 *
 * Deliberately excludes anything already classified as forest/shrubland (a
 * clearing inside a wood would double up with the canopy above it),
 * farmland, built-up area, sand (beach already reads as bare) and
 * water/wetland/snow - see OPEN_GROUND_CLASSES. Roads and runways are
 * excluded the same way trees are, via the caller's exclusion callback (see
 * terrainEntity.ts's attachTrees, which scatters both from the same
 * road/airfield masks).
 */

import * as THREE from 'three';
import { PaletteCategory } from '../config/palettes/palette';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../scene/materials/materials';
import { Species, TREE_SPECIES_COUNT } from '../scene/vegetation/treeSprites';
import { ROCK_SHAPE_COUNT, RockShape } from '../scene/vegetation/stoneSprites';
import { SpeciesGroup } from './treeBillboards';
import { PtmTile } from './ptm';

// TerrainClass values spelled out: it is a `const enum`, and the tsx test
// runner leaves an imported const-enum binding undefined (see tileMesh.ts's
// GROUND_CLASS / treeBillboards.ts's TREE_CLASS for the same workaround).
// Deliberately excludes TerrainClass.Unknown (0, no cover bake for this
// facet - see tones.ts): it shows up on nearly every tile (any facet a cover
// source doesn't cover, not just a fully unbaked region), so including it
// here made terrainEntity.ts's treeSource gate below match almost every
// resident tile at once - a burst of simultaneous attachTrees() calls (atlas
// builds, road loads, per-tile synchronous mesh building) that stalled the
// whole reconcile loop to a crawl. Keeping this to real classified ground
// keeps that gate selective, at the cost of a cover-data gap (e.g. the known
// Sentinel-2 hole over Gran Canaria) staying bare until it is re-baked.
const OPEN_GROUND_CLASSES = new Set<number>([
    3, // Grass
    6, // Bare
    11, // Moss
    13, // Ground
]);

/**
 * Every class this file ever scatters onto, exposed so terrainEntity.ts's
 * upload callback can decide whether a tile needs attachTrees() called on it
 * at all (see its `treeSource` gate) without duplicating this file's class
 * list - a tile with zero Tree triangles used to skip attachTrees()
 * entirely, which silently starved pure open-ground tiles of clutter too
 * once this scatter was folded into the same call.
 */
export const CLUTTER_ELIGIBLE_CLASSES: ReadonlySet<number> = OPEN_GROUND_CLASSES;

/** One clutter instance (rock, shrub or tree) per this many square metres of eligible ground at zero green bias - denser than a forest since most of what this spacing governs is tiny (see STONE_HALF_WIDTH_M/STONE_HEIGHT_M). Actual spacing tightens further on green ground - see GREEN_DENSITY_BOOST. */
const CLUTTER_SPACING_M2 = 35;
/**
 * How much denser clutter gets as a facet's green bias rises to 1 - e.g. 1.5
 * means fully green ground gets 2.5x the instance density of bare/tan
 * ground. Applied on top of the rock/shrub/tree split (see greenSplit), so
 * grassy ground doesn't just trade rocks for shrubs one-for-one, it visibly
 * grows more stuff overall, the way a real meadow is denser with vegetation
 * than a stony patch is with rocks.
 */
const GREEN_DENSITY_BOOST = 3;
/**
 * Last-resort safety valve, not a density knob - same reasoning as
 * treeBillboards.ts's TOTAL_TREE_SAFETY_CAP: the mesh builders build every
 * instance's matrix in one synchronous pass, so this also bounds how long
 * that pass can run for a tile with a lot of open ground.
 */
const TOTAL_CLUTTER_SAFETY_CAP = 6000;
const STONE_HALF_WIDTH_M = 0.45;
const STONE_HEIGHT_M = 0.7;

/**
 * How strongly a facet's baked colour has to lean green before it grows
 * anything at all instead of staying rock, and how sharply that switches
 * over. `greenBias` is 0 for a neutral/grey/tan colour (all rocks) and rises
 * toward 1 the further green sits above red and blue; a real grassy tint
 * only has to lean mildly green to already read as "growing something", so
 * the divisor is small rather than requiring saturated green. Smaller than
 * the original tuning so more of what "open ground" actually looks like
 * (a lot of it is at least a little green) grows something - see
 * GREEN_DENSITY_BOOST for making that growth visibly denser, too.
 */
const GREEN_BIAS_DIVISOR = 0.09;
/** greenBias above which a shrub-worthy patch starts mixing in the odd full tree - grassland scattered with the occasional lone tree, not a shrub-only scrubland. */
const GREEN_TREE_THRESHOLD = 0.45;
/** Of the green portion at greenBias = 1, the largest share that goes to trees rather than shrubs - grassland stays shrub-dominant even at full green, it doesn't flip to forest. */
const GREEN_TREE_MAX_SHARE = 0.5;

interface GreenSplit {
    /** 0..1, this candidate's odds of growing anything at all (vs. staying a rock). */
    pGreen: number;
    /** 0..1, given it grows something, its odds of being a tree rather than a shrub. */
    pTreeGivenGreen: number;
}

/** How a facet's sampled ground colour splits a candidate point between rock, shrub and tree - see the constants above. */
function greenSplit(r: number, g: number, b: number): GreenSplit {
    const pGreen = Math.min(Math.max((g - Math.max(r, b)) / GREEN_BIAS_DIVISOR, 0), 1);
    const pTreeGivenGreen = Math.min(Math.max(
        (pGreen - GREEN_TREE_THRESHOLD) / (1 - GREEN_TREE_THRESHOLD), 0), 1) * GREEN_TREE_MAX_SHARE;
    return { pGreen, pTreeGivenGreen };
}

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

/** Uniform point-in-triangle sampling (Osada et al.), so scattered stones never land outside their facet. */
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

export interface ShapeGroup {
    shape: RockShape;
    points: Vec3[];
    /** Observed ground colour (sRGB 0..1, rgb triplets) under each point, parallel to `points`. */
    tints: number[];
    /** Unit up-facing surface normal (x, y, z triplets) of the facet under each point, parallel to `points`. */
    normals: number[];
}

export interface GroundClutter {
    rocks: ShapeGroup[];
    /** Species.SHRUB plus whichever of treeBillboards.ts's forest species turned up (see greenSplit) - drops straight into buildTreeMesh alongside treeBillboards.ts's own species groups. */
    vegetation: SpeciesGroup[];
}

/**
 * Scatters points over a tile's eligible open-ground triangles at a fixed,
 * tile-independent density (scaled by `densityScale` and, on green ground,
 * by GREEN_DENSITY_BOOST), and buckets each point into rock, shrub or tree
 * from that facet's own baked ground colour (see greenSplit) and, within
 * rock, an independently (per-instance) chosen shape - so a patch of open
 * ground reads as a natural mix rather than one shape or kind repeated.
 * Returns empty arrays for a tile with no eligible ground.
 */
export function scatterGroundClutter(
    tile: PtmTile, densityScale = 1, onExcluded?: (x: number, z: number) => boolean,
): GroundClutter {
    const triCount = tile.landAttrs.length / 4 / 3;
    const byShape = new Map<RockShape, ShapeGroup>();
    const bySpecies = new Map<Species, SpeciesGroup>();
    let total = 0;
    const cap = TOTAL_CLUTTER_SAFETY_CAP * Math.max(1, densityScale);

    // Pre-pass: thin every triangle by the same factor when the tile's whole
    // open-ground clutter would exceed the safety cap, so a large open tile
    // gets an evenly thinned scatter instead of clutter only along a rim of
    // mesh order. Uses each triangle's own green-boosted density so the cap
    // scale reflects the same weighting the real pass below applies.
    let expectedTotal = 0;
    for (let t = 0; t < triCount; t++) {
        const c = tile.landAttrs[(t * 3) * 4 + 3];
        if (!OPEN_GROUND_CLASSES.has(c)) {
            continue;
        }
        const a = (t * 3) * 4;
        const pGreen = greenSplit(tile.landAttrs[a] / 255, tile.landAttrs[a + 1] / 255, tile.landAttrs[a + 2] / 255).pGreen;
        expectedTotal += triangleArea(readVert(tile, t, 0), readVert(tile, t, 1), readVert(tile, t, 2))
            / CLUTTER_SPACING_M2 * densityScale * (1 + pGreen * GREEN_DENSITY_BOOST);
    }
    const capScale = expectedTotal > cap ? cap / expectedTotal : 1;

    outer:
    for (let t = 0; t < triCount; t++) {
        const cls = tile.landAttrs[(t * 3) * 4 + 3];
        if (!OPEN_GROUND_CLASSES.has(cls)) {
            continue;
        }
        const v0 = readVert(tile, t, 0);
        const v1 = readVert(tile, t, 1);
        const v2 = readVert(tile, t, 2);
        const area = triangleArea(v0, v1, v2);
        // Facet normal, pointing up (tile axes: +X east, +Y up, +Z south).
        let nx = (v1.y - v0.y) * (v2.z - v0.z) - (v1.z - v0.z) * (v2.y - v0.y);
        let ny = (v1.z - v0.z) * (v2.x - v0.x) - (v1.x - v0.x) * (v2.z - v0.z);
        let nz = (v1.x - v0.x) * (v2.y - v0.y) - (v1.y - v0.y) * (v2.x - v0.x);
        const nLen = Math.hypot(nx, ny, nz) || 1;
        const nSign = ny < 0 ? -1 / nLen : 1 / nLen;
        nx *= nSign; ny *= nSign; nz *= nSign;
        const a = (t * 3) * 4;
        const tintR = tile.landAttrs[a] / 255;
        const tintG = tile.landAttrs[a + 1] / 255;
        const tintB = tile.landAttrs[a + 2] / 255;
        const { pGreen, pTreeGivenGreen } = greenSplit(tintR, tintG, tintB);
        // A different seed offset from treeBillboards.ts's own per-triangle
        // hashing, so a facet that happens to sit at a tree/stone class
        // boundary doesn't scatter both from correlated randomness.
        const seed = t * 61.7 + 401;
        const expected = (area / CLUTTER_SPACING_M2) * densityScale * capScale * (1 + pGreen * GREEN_DENSITY_BOOST);
        const whole = Math.floor(expected);
        const count = whole + (hash01(seed) < expected - whole ? 1 : 0);

        for (let i = 0; i < count; i++) {
            if (total >= cap) {
                break outer;
            }
            const r1 = hash01(seed + i * 2.371);
            const r2 = hash01(seed + i * 2.371 + 0.5);
            const point = pointInTriangle(v0, v1, v2, r1, r2);
            if (onExcluded && onExcluded(point.x, point.z)) {
                continue;
            }

            if (hash01(seed + i * 4.633 + 0.17) < pGreen) {
                // Grows something - tree or shrub, weighted by pTreeGivenGreen.
                const species = hash01(seed + i * 3.109 + 0.41) < pTreeGivenGreen
                    ? Math.min(Math.floor(hash01(seed + i * 8.923) * TREE_SPECIES_COUNT), TREE_SPECIES_COUNT - 1) as Species
                    : Species.SHRUB;
                let group = bySpecies.get(species);
                if (!group) {
                    group = { species, points: [], tints: [], normals: [] };
                    bySpecies.set(species, group);
                }
                group.points.push(point);
                group.normals.push(nx, ny, nz);
                group.tints.push(tintR, tintG, tintB);
            } else {
                const shape = Math.min(
                    Math.floor(hash01(seed + i * 8.923) * ROCK_SHAPE_COUNT),
                    ROCK_SHAPE_COUNT - 1,
                ) as RockShape;
                let group = byShape.get(shape);
                if (!group) {
                    group = { shape, points: [], tints: [], normals: [] };
                    byShape.set(shape, group);
                }
                group.points.push(point);
                group.normals.push(nx, ny, nz);
                group.tints.push(tintR, tintG, tintB);
            }
            total++;
        }
    }

    return { rocks: [...byShape.values()], vegetation: [...bySpecies.values()] };
}

function buildQuadGeometry(): THREE.BufferGeometry {
    const hw = STONE_HALF_WIDTH_M;
    const h = STONE_HEIGHT_M;
    const positions = new Float32Array([
        -hw, 0, 0, hw, 0, 0, hw, h, 0,
        -hw, 0, 0, hw, h, 0, -hw, h, 0,
    ]);
    // v=1 at the ground vertices, v=0 at the top — matches the atlas, whose
    // cells are drawn ground-up (see stoneAtlas.ts / stoneSprites.ts).
    const uvs = new Float32Array([
        0, 1, 1, 1, 1, 0,
        0, 1, 1, 0, 0, 0,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    return geometry;
}

/**
 * Builds every shape's already-scattered points into one InstancedMesh (one
 * draw call per tile), reusing the tree-billboard shader/atlas convention
 * (see stoneAtlas.ts) - only the atlas texture, geometry size and palette
 * category differ from a tree's.
 */
export function buildStoneMesh(
    groups: ShapeGroup[],
    materials: SceneMaterialManager,
    atlas: THREE.Texture,
): THREE.InstancedMesh {
    let count = 0;
    for (const group of groups) {
        count += group.points.length;
    }
    const geometry = buildQuadGeometry();
    const material = materials.build({
        type: SceneMaterialPrimitiveType.TREE_BILLBOARD,
        // The stone is a neutral near-white in the atlas and gets tinted in
        // the fragment shader by this category's resolved colour, so stones
        // read as the same bare-ground grey/tan the terrain is painted
        // rather than a fixed hue baked into the sprite.
        category: PaletteCategory.TERRAIN_BARE,
        depthWrite: true,
        map: atlas,
    });

    const mesh = new THREE.InstancedMesh(geometry, material, count);
    const shade = new Float32Array(count * 4);
    const shapeAttr = new Float32Array(count);
    const normalAttr = new Float32Array(count * 3);
    const m = new THREE.Matrix4();
    let i = 0;
    for (const group of groups) {
        for (let k = 0; k < group.points.length; k++, i++) {
            const p = group.points[k];
            // A little per-instance scale jitter reads as size variation
            // without needing separate per-shape geometry (the billboard
            // shader always faces the camera regardless of instanceMatrix's
            // rotation, so there is nothing to gain from rotating it here -
            // see treeBillboardVP.ts).
            const scale = 0.6 + hash01(i * 5.113 + group.shape * 13.1 + 1) * 0.7;
            m.makeScale(scale, scale, scale);
            m.setPosition(p.x, p.y, p.z);
            mesh.setMatrixAt(i, m);
            shapeAttr[i] = group.shape;
            normalAttr[i * 3] = group.normals[k * 3];
            normalAttr[i * 3 + 1] = group.normals[k * 3 + 1];
            normalAttr[i * 3 + 2] = group.normals[k * 3 + 2];
            // rgb = the sampled ground colour, a = lighter/darker variation;
            // the shared shader mixes the ground colour 50:50 with the
            // palette's bare-ground colour.
            shade[i * 4] = group.tints[k * 3];
            shade[i * 4 + 1] = group.tints[k * 3 + 1];
            shade[i * 4 + 2] = group.tints[k * 3 + 2];
            shade[i * 4 + 3] = (0.35 + hash01(i * 6.451 + group.shape * 17.3 + 2) * 0.35) * 0.9;
        }
    }
    mesh.instanceMatrix.needsUpdate = true;
    geometry.setAttribute('instanceShade', new THREE.InstancedBufferAttribute(shade, 4));
    geometry.setAttribute('instanceNormal', new THREE.InstancedBufferAttribute(normalAttr, 3));
    geometry.setAttribute('instanceSpecies', new THREE.InstancedBufferAttribute(shapeAttr, 1));
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
}

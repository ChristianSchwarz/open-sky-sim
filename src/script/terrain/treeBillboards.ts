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
 * per tile. All species share one atlas (see scatterTreeSpecies /
 * buildTreeMesh), so a tile's whole forest is a single InstancedMesh with a per-instance species attribute.
 */

import * as THREE from 'three';
import { PaletteCategory } from '../config/palettes/palette';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../scene/materials/materials';
import { TREE_MAX_GROW, TREE_MIN_SPACING_PX } from '../scene/materials/shaders/treeBillboardVP';
import { nearDistanceInTile, sphereInTile } from './tileFrameBounds';
import { TREE_SPECIES_COUNT, Species } from '../scene/vegetation/treeSprites';
import { PtmTile } from './ptm';

// TerrainClass.Tree spelled out: it is a `const enum`, and the tsx test
// runner leaves an imported const-enum binding undefined (see tileMesh.ts's
// GROUND_CLASS for the same workaround).
const TREE_CLASS = 1;
// TerrainClass.Shrub, same const-enum workaround.
const SHRUB_CLASS = 2;
// TerrainClass.Mangrove: a coastal forest standing in water, scattered as one.
const MANGROVE_CLASS = 10;
// TerrainClass.Heath: dwarf shrubs, thinner than scrub.
const HEATH_CLASS = 14;
/** Shrubland is denser than woodland but each plant is small. */
const SHRUB_SPACING_M2 = 60;
/** Heath is open ground with the odd clump of heather or gorse, not a thicket. */
const HEATH_SPACING_M2 = 180;
const SHRUB_SCALE = 0.22;
/** A bush reads as a small tree-like clump, between a shrub and a full tree - see stones.ts's greenSplit, the only place that scatters this species today. */
const BUSH_SCALE = 0.5;

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

/** Every class this scatter grows something on, for terrainEntity.ts's treeSource gate. */
export const TREE_SCATTER_CLASSES: ReadonlySet<number> = new Set([
    TREE_CLASS, SHRUB_CLASS, MANGROVE_CLASS, HEATH_CLASS,
]);

/** Square metres per plant for a scattered class, or 0 for one that grows nothing here. */
function spacingOf(cls: number): number {
    switch (cls) {
        case TREE_CLASS:
        case MANGROVE_CLASS:
            return TREE_SPACING_M2;
        case SHRUB_CLASS:
            return SHRUB_SPACING_M2;
        case HEATH_CLASS:
            return HEATH_SPACING_M2;
        default:
            return 0;
    }
}
/**
 * Last-resort safety valve, not a density knob - see TREE_SPACING_M2. Kept
 * low on purpose: buildTreeMesh builds every instance's matrix in one
 * synchronous pass (no pacing within a single tile), so this is also
 * effectively a ceiling on how long that pass can run - a large tile hitting
 * this cap is a visibly thinner treeline than its true density, not the
 * full-frame stall a much higher cap would risk once it triggers.
 */
const TOTAL_TREE_SAFETY_CAP = 8000;
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
    /** Unit up-facing surface normal (x, y, z triplets) of the facet under each point, parallel to `points`. */
    normals: number[];
}

/** Full density within this range of the camera. */
const TREE_DENSITY_NEAR_M = 2000;
/** Density falls off linearly between the two, reaching TREE_DENSITY_FAR_SCALE at this range. */
const TREE_DENSITY_FAR_M = 8000;
/** Density at TREE_DENSITY_FAR_M and beyond - thinned out, not zero, so distant forest doesn't have a hard edge. */
const TREE_DENSITY_FAR_SCALE = 0.08;
/** Beyond this no trees are drawn at all: at that range they are sub-pixel and only cost overdraw, the ground colour already reads as forest. */
const TREE_DENSITY_CUTOFF_M = 10000;

/** How much to thin out a tile's tree density for a tile this far from the camera - 1 = full, down to TREE_DENSITY_FAR_SCALE. */
export function treeDensityScaleForDistance(distanceM: number): number {
    if (distanceM <= TREE_DENSITY_NEAR_M) {
        return 1;
    }
    if (distanceM >= TREE_DENSITY_CUTOFF_M) {
        return 0;
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
export function scatterTreeSpecies(
    tile: PtmTile, densityScale = 1, onRoad?: (x: number, z: number, y: number) => boolean,
): SpeciesGroup[] {
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
        const spacing = spacingOf(tile.landAttrs[(t * 3) * 4 + 3]);
        if (spacing === 0) {
            continue;
        }
        expectedTotal += triangleArea(readVert(tile, t, 0), readVert(tile, t, 1), readVert(tile, t, 2))
            / spacing * densityScale;
    }
    const capScale = expectedTotal > cap ? cap / expectedTotal : 1;

    outer:
    for (let t = 0; t < triCount; t++) {
        const cls = tile.landAttrs[(t * 3) * 4 + 3];
        const spacing = spacingOf(cls);
        if (spacing === 0) {
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
        const expected = (area / spacing) * densityScale * capScale;
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
            if (onRoad && onRoad(point.x, point.z, point.y)) {
                continue;
            }
            const pick = hash01(seed + i * 8.923);
            // Heath: mostly heather-sized shrubs, one clump in four a gorse
            // or broom bush.
            const species = (cls === SHRUB_CLASS ? Species.SHRUB
                : cls === HEATH_CLASS ? (pick < 0.25 ? Species.BUSH : Species.SHRUB)
                    : Math.min(Math.floor(pick * TREE_SPECIES_COUNT), TREE_SPECIES_COUNT - 1)) as Species;

            let group = bySpecies.get(species);
            if (!group) {
                group = { species, points: [], tints: [], normals: [] };
                bySpecies.set(species, group);
            }
            group.points.push(point);
            group.normals.push(nx, ny, nz);
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
    // Four corners and an index, not six vertices: every instance runs the
    // whole vertex program per corner, and the shared two are run once.
    const positions = new Float32Array([
        -hw, 0, 0, hw, 0, 0, hw, h, 0, -hw, h, 0,
    ]);
    // v=1 at the ground vertices, v=0 at the treetop — matches the sprite
    // atlas, whose cells are drawn canopy-up (see treeAtlas.ts / treeSprites.ts).
    const uvs = new Float32Array([
        0, 1, 1, 1, 1, 0, 0, 0,
    ]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    return geometry;
}

/** Average metres between a tile's trees at `densityScale` (see TREE_SPACING_M2). */
export function treeSpacingM(densityScale: number): number {
    return Math.sqrt(TREE_SPACING_M2 / Math.max(densityScale, 1e-3));
}

/** Cells a side a tile's trees are split into, see buildTreeMeshes. */
const TREE_CELLS = 4;

/**
 * A mesh that sets `userData.treeSizeM`, the tallest any of its instances
 * can be drawn (grown included), draws none of them once that is under this
 * many pixels at its near edge (treeInstancesToDraw). The rocks set it: at
 * well under a metre they are sub-pixel a kilometre or two out, where the
 * spacing thinning alone still submitted every one.
 */
export const TREE_MIN_SIZE_PX = 0.5;

/** Scattered points with a colour and a ground normal each: a tree species' or a rock shape's. */
export interface ScatterGroup {
    points: Vec3[];
    tints: number[];
    normals: number[];
}

/**
 * Split scattered groups into TREE_CELLS x TREE_CELLS patches of their
 * bounding box, each a list of groups (`blank` makes an empty one like its
 * source). Empty patches are left out.
 */
export function splitIntoCells<G extends ScatterGroup>(groups: G[], blank: (g: G) => G): G[][] {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const g of groups) {
        for (const p of g.points) {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minZ = Math.min(minZ, p.z);
            maxZ = Math.max(maxZ, p.z);
        }
    }
    const n = TREE_CELLS;
    const cells: G[][] = Array.from({ length: n * n }, () => []);
    const sx = n / Math.max(maxX - minX, 1e-6), sz = n / Math.max(maxZ - minZ, 1e-6);
    for (const g of groups) {
        const split: G[] = [];
        for (let k = 0; k < g.points.length; k++) {
            const p = g.points[k];
            const c = Math.min(n - 1, Math.floor((p.x - minX) * sx)) + n * Math.min(n - 1, Math.floor((p.z - minZ) * sz));
            let s = split[c];
            if (!s) {
                s = split[c] = blank(g);
                cells[c].push(s);
            }
            s.points.push(p);
            s.tints.push(g.tints[k * 3], g.tints[k * 3 + 1], g.tints[k * 3 + 2]);
            s.normals.push(g.normals[k * 3], g.normals[k * 3 + 1], g.normals[k * 3 + 2]);
        }
    }
    return cells.filter(c => c.length > 0);
}

/**
 * A seeded shuffle of `count` slots. A scattered instance's slot is its
 * thinning hash (instanceHash), so the ones any thinning keeps are spread
 * evenly over the patch and the same every build, and in slot order a
 * prefix - until orderTreesFor stores them by distance, the hash going with
 * them.
 */
export function shuffledSlots(count: number): Uint32Array {
    const slot = new Uint32Array(count);
    for (let j = 0; j < count; j++) {
        slot[j] = j;
    }
    let seed = (count * 2654435761) >>> 0 || 1;
    for (let j = count - 1; j > 0; j--) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        seed >>>= 0;
        const r = seed % (j + 1);
        const t = slot[j];
        slot[j] = slot[r];
        slot[r] = t;
    }
    return slot;
}

/** The tallest a scattered quad `heightM` high, at instance scale up to `maxScale`, is drawn: the thinning may grow it. */
export function grownSizeM(heightM: number, maxScale: number): number {
    return heightM * maxScale * TREE_MAX_GROW;
}

/**
 * A tree mesh's instances stored in the order they survive the thinning for
 * one eye (orderTreesFor), so the ones it keeps are a prefix from anywhere
 * near that eye rather than only at the patch's near edge.
 *
 * The shader keeps a tree while its hash is under the keep fraction at its
 * own distance d, (spacing / (d * pixelAngle))^2 / TREE_MIN_SPACING_PX^2
 * capped at 1, which is hash * d^2 < (spacing / (TREE_MIN_SPACING_PX *
 * pixelAngle))^2: one score per tree against one threshold per frame. Before
 * any order the instances sit in hash order and the near edge's fraction is
 * the prefix, which across a patch a kilometre or two deep submitted three
 * to five trees for every one the shader kept.
 */
interface TreeOrder {
    /**
     * The eye the order was made for, in the tile group's frame: a re-base
     * (FrameShift) moves the tile and the eye together, which is no move.
     */
    eye: THREE.Vector3;
    /** Metres per unit of the tile group's frame: it scales the quantised land up (see PtmTile.quantScale). */
    metresPerUnit: number;
    /** The nearest tree's distance from that eye, in metres. */
    nearM: number;
    /** hash * d^2 of each instance from that eye, ascending: the stored order. */
    scores: Float32Array;
}

/**
 * Past this much slack an order is made again (see treeOrderSlack): the
 * prefix then carries 40 % more trees than the shader can keep.
 */
export const TREE_REORDER_SLACK = 1.4;

const eyeInTile = new THREE.Vector3();
const toTile = new THREE.Matrix4();
const invTile = new THREE.Matrix4();
const point = new THREE.Vector3();

function eyeInTileFrame(tileGroup: THREE.Object3D, eye: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(eye).applyMatrix4(invTile.copy(tileGroup.matrix).invert());
}

/**
 * The distance inside which the thinning keeps every tree of a mesh with
 * `spacingM`: where its keep fraction reaches 1. A tree's score (TreeOrder)
 * is under its square exactly when the shader keeps it.
 */
function keepAllWithinM(spacingM: number, pixelAngle: number): number {
    return spacingM / (TREE_MIN_SPACING_PX * pixelAngle);
}

/**
 * How much more than the thinning can keep an order may have to submit
 * from `eye`, at most: (near / (near - moved))^2, with `moved` how far the
 * eye went since the order was made and `near` the larger of the nearest
 * tree's distance then and keepAllWithinM - moved. A tree that was nearer
 * than that scores under the threshold anyway; one farther off is at least
 * near - moved away now, so if it is kept now, it scored under the
 * threshold times this when the order was made. Infinite without an order,
 * or once the eye has gone as far as `near`.
 */
export function treeOrderSlack(
    mesh: THREE.InstancedMesh, tileGroup: THREE.Object3D, eye: THREE.Vector3, pixelAngle: number,
): number {
    const order = mesh.userData.treeOrder as TreeOrder | undefined;
    const spacingM: number = mesh.userData.treeSpacingM ?? 0;
    if (order === undefined || spacingM <= 0 || pixelAngle <= 0) {
        return Infinity;
    }
    const moved = eyeInTileFrame(tileGroup, eye, eyeInTile).distanceTo(order.eye) * order.metresPerUnit;
    const near = Math.max(order.nearM, keepAllWithinM(spacingM, pixelAngle) - moved);
    if (moved >= near) {
        return Infinity;
    }
    const f = near / (near - moved);
    return f * f;
}

/**
 * Store `mesh`'s instances in the order they survive the thinning seen from
 * `eye` (scene frame), see TreeOrder. A permutation of every instance
 * attribute and one upload of each; the hash travels with its tree
 * (instanceHash), so the trees the shader keeps do not change.
 */
export function orderTreesFor(mesh: THREE.InstancedMesh, tileGroup: THREE.Object3D, eye: THREE.Vector3): void {
    const total: number = mesh.userData.treeTotal ?? mesh.count;
    const geometry = mesh.geometry;
    const hashAttr = geometry.getAttribute('instanceHash') as THREE.InstancedBufferAttribute | undefined;
    if (!hashAttr || total < 2) {
        return;
    }
    // Distances in the scene's frame, in metres, as the shader measures
    // them: the tile group's matrix scales its quantised units up.
    toTile.identity();
    for (let o: THREE.Object3D | null = mesh; o !== null && o !== tileGroup; o = o.parent) {
        toTile.premultiply(o.matrix);
    }
    toTile.premultiply(tileGroup.matrix);
    const local = eyeInTileFrame(tileGroup, eye, new THREE.Vector3());
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const hashes = hashAttr.array as Float32Array;
    const scores = new Float64Array(total);
    let nearM = Infinity;
    for (let i = 0; i < total; i++) {
        point.set(matrices[i * 16 + 12], matrices[i * 16 + 13], matrices[i * 16 + 14]).applyMatrix4(toTile);
        const d2 = point.distanceToSquared(eye);
        nearM = Math.min(nearM, Math.sqrt(d2));
        scores[i] = hashes[i] * d2;
    }
    const by = new Uint32Array(total);
    for (let i = 0; i < total; i++) {
        by[i] = i;
    }
    by.sort((a, b) => scores[a] - scores[b]);
    permuteInstances(mesh.instanceMatrix, by, 16);
    for (const name of ['instanceShade', 'instanceNormal', 'instanceSpecies', 'instanceHash']) {
        const attr = geometry.getAttribute(name) as THREE.InstancedBufferAttribute | undefined;
        if (attr) {
            permuteInstances(attr, by, attr.itemSize);
        }
    }
    const sorted = new Float32Array(total);
    for (let i = 0; i < total; i++) {
        sorted[i] = scores[by[i]];
    }
    const order: TreeOrder = { eye: local, metresPerUnit: tileGroup.matrix.getMaxScaleOnAxis(), nearM, scores: sorted };
    mesh.userData.treeOrder = order;
}

function permuteInstances(attr: THREE.BufferAttribute, by: Uint32Array, size: number): void {
    const src = attr.array as Float32Array;
    const out = new Float32Array(src.length);
    for (let i = 0; i < by.length; i++) {
        const from = by[i] * size;
        for (let k = 0; k < size; k++) {
            out[i * size + k] = src[from + k];
        }
    }
    src.set(out);
    attr.needsUpdate = true;
}

/**
 * Whether ordering `mesh` for `eye` is worth its upload: the shader drops
 * more than half the trees at the patch's far edge - most of a patch, as
 * the far part holds most of its ground - and the mesh has no order yet or
 * one with more slack than TREE_REORDER_SLACK. A patch the thinning hardly
 * touches keeps nearly everything either way.
 */
export function treeReorderWanted(
    mesh: THREE.InstancedMesh, tileGroup: THREE.Object3D, eye: THREE.Vector3, pixelAngle: number,
): boolean {
    const spacingM: number = mesh.userData.treeSpacingM ?? 0;
    if (spacingM <= 0 || pixelAngle <= 0) {
        return false;
    }
    const bounds = sphereInTile(mesh, tileGroup, farSphere);
    const pixelM = (bounds.center.distanceTo(eye) + bounds.radius) * pixelAngle;
    const spacingPx = spacingM / Math.max(pixelM, 1e-9);
    const keepFar = (spacingPx * spacingPx) / (TREE_MIN_SPACING_PX * TREE_MIN_SPACING_PX);
    return keepFar < 0.5 && treeOrderSlack(mesh, tileGroup, eye, pixelAngle) > TREE_REORDER_SLACK;
}

const farSphere = new THREE.Sphere();

/** How many of `scores` (ascending) are under `bound`. */
function countUnder(scores: Float32Array, bound: number): number {
    let lo = 0, hi = scores.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (scores[mid] < bound) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/**
 * How many of a tree mesh's instances the screen-space thinning can keep
 * anywhere in it, seen from `eye` (scene frame) with `pixelAngle` ground
 * metres per pixel per metre of range, as a prefix of the stored instances.
 * The rest are never submitted - their vertex work otherwise, even for the
 * trees the shader drops. With an order (orderTreesFor), the trees scoring
 * under the threshold times the order's slack; without one, the shader's
 * keep fraction at the mesh's near edge as a prefix of the hash order.
 * Without an eye, all of them. `tileGroup` is the tile the mesh belongs to
 * (see nearDistanceInTile).
 */
export function treeInstancesToDraw(
    mesh: THREE.InstancedMesh, tileGroup: THREE.Object3D, eye: THREE.Vector3 | undefined, pixelAngle: number,
): number {
    const total: number = mesh.userData.treeTotal ?? mesh.count;
    const spacingM: number = mesh.userData.treeSpacingM ?? 0;
    if (spacingM <= 0 || eye === undefined) {
        return total;
    }
    const sizeM: number | undefined = mesh.userData.treeSizeM;
    if (sizeM !== undefined && nearDistanceInTile(mesh, tileGroup, eye) * pixelAngle * TREE_MIN_SIZE_PX > sizeM) {
        return 0;
    }
    const order = mesh.userData.treeOrder as TreeOrder | undefined;
    if (order !== undefined) {
        const slack = treeOrderSlack(mesh, tileGroup, eye, pixelAngle);
        if (!Number.isFinite(slack)) {
            return total;
        }
        const threshold = keepAllWithinM(spacingM, pixelAngle);
        // A hair over, for the float rounding between here and the shader.
        return countUnder(order.scores, threshold * threshold * slack * 1.001);
    }
    const pixelM = nearDistanceInTile(mesh, tileGroup, eye) * pixelAngle;
    if (pixelM <= 0) {
        return total;
    }
    const spacingPx = spacingM / pixelM;
    const keep = Math.min(1, (spacingPx * spacingPx) / (TREE_MIN_SPACING_PX * TREE_MIN_SPACING_PX));
    // Down: the one tree that leaves is inside the shader's fade (TREE_THIN_FADE),
    // and a patch with less than one tree left to keep is not drawn at all.
    return Math.min(total, Math.floor(keep * total));
}

/**
 * A tile's trees as TREE_CELLS x TREE_CELLS meshes (buildTreeMesh), one per
 * patch of ground that has any. A tile is 6-7 km across: as one mesh, every
 * tree in it was drawn whenever any part of it was in view, and at the count
 * its nearest corner needs. A patch is culled by its own bounds and thinned
 * by its own range, which leaves a fifth of a whole tile's trees to submit.
 */
export function buildTreeMeshes(
    groups: SpeciesGroup[],
    materials: SceneMaterialManager,
    atlas: THREE.Texture,
    spacingM = 0,
): THREE.InstancedMesh[] {
    return splitIntoCells(groups, g => ({ species: g.species, points: [], tints: [], normals: [] }))
        .map(c => buildTreeMesh(c, materials, atlas, spacingM));
}

/**
 * Builds every species' already-scattered points into one InstancedMesh (one
 * draw call per tile) bound to the shared atlas. `spacingM` (treeSpacingM)
 * lets the shader thin trees that pack tighter on screen than
 * TREE_MIN_SPACING_PX; without it every instance is drawn.
 */
export function buildTreeMesh(
    groups: SpeciesGroup[],
    materials: SceneMaterialManager,
    atlas: THREE.Texture,
    spacingM = 0,
): THREE.InstancedMesh {
    let count = 0;
    for (const group of groups) {
        count += group.points.length;
    }
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
    }) as THREE.ShaderMaterial;
    material.uniforms.uTreeSpacingM = { value: spacingM };

    const slot = shuffledSlots(count);

    const mesh = new THREE.InstancedMesh(geometry, material, count);
    const shade = new Float32Array(count * 4);
    const speciesAttr = new Float32Array(count);
    const normalAttr = new Float32Array(count * 3);
    const hashAttr = new Float32Array(count);
    const m = new THREE.Matrix4();
    let i = 0;
    for (const group of groups) {
        for (let k = 0; k < group.points.length; k++, i++) {
            const p = group.points[k];
            // A little per-instance scale jitter reads as size variation without
            // needing separate per-species geometry.
            const scale = (0.85 + hash01(i * 5.113 + group.species * 13.1 + 1) * 0.3)
                * (group.species === Species.SHRUB ? SHRUB_SCALE : group.species === Species.BUSH ? BUSH_SCALE : 1);
            m.makeScale(scale, scale, scale);
            m.setPosition(p.x, p.y, p.z);
            const s = slot[i];
            mesh.setMatrixAt(s, m);
            hashAttr[s] = (s + 0.5) / count;
            speciesAttr[s] = group.species;
            normalAttr[s * 3] = group.normals[k * 3];
            normalAttr[s * 3 + 1] = group.normals[k * 3 + 1];
            normalAttr[s * 3 + 2] = group.normals[k * 3 + 2];
            // rgb = the sampled ground colour, a = lighter/darker variation; the
            // fragment shader mixes the ground colour 50:50 with the palette green.
            shade[s * 4] = group.tints[k * 3];
            shade[s * 4 + 1] = group.tints[k * 3 + 1];
            shade[s * 4 + 2] = group.tints[k * 3 + 2];
            shade[s * 4 + 3] = (0.3 + hash01(i * 6.451 + group.species * 17.3 + 2) * 0.3) * 0.72;
        }
    }
    mesh.instanceMatrix.needsUpdate = true;
    geometry.setAttribute('instanceShade', new THREE.InstancedBufferAttribute(shade, 4));
    geometry.setAttribute('instanceNormal', new THREE.InstancedBufferAttribute(normalAttr, 3));
    geometry.setAttribute('instanceSpecies', new THREE.InstancedBufferAttribute(speciesAttr, 1));
    geometry.setAttribute('instanceHash', new THREE.InstancedBufferAttribute(hashAttr, 1));
    // Real bounding sphere (instances plus the quad) so the renderer culls
    // a tile's trees that are off-screen; the tile group's matrix is static
    // (LOD push is a shader uniform), so the sphere stays valid.
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.userData.treeTotal = count;
    mesh.userData.treeSpacingM = spacingM;
    return mesh;
}

/**
 * Binds a decoded PTM1 tile to GPU buffers.
 *
 * This is the payoff for the format's layout: nothing here copies or
 * transforms vertex data. Quantised int16 positions are bound directly and
 * turned into metres by the mesh's scale; int8 normals are bound normalized
 * through an interleaved view that skips their pad byte. A tile goes from
 * bytes to drawable without touching a single vertex on the CPU, which is why
 * the runtime needs no mesh workers at all.
 *
 * Up to three meshes come out per tile — land, water and watercourse strokes —
 * because the streams have different vertex layouts. Water carries one draw
 * group per tone; land is a single group whose colour the shader resolves per
 * vertex from the baked cover attribute. The strokes are a centreline the
 * vertex program widens, so they need their own material as well as their own
 * attributes, and they are the one stream drawn after the surface rather than
 * as part of it.
 *
 * Tiles are placed by translation only, never rotation. The shaded vertex
 * program treats the normal attribute as world-space in the STATIC and DUOTONE
 * shading paths, so a rotated tile would shade wrong; the bake writes both
 * positions and normals in scene axes (x=east, y=up, z=south) for exactly this
 * reason. See `sceneFromEnu` for why z runs south.
 */

import * as THREE from 'three';
import { TerrainShading } from '../state/gameDefs';
import { EnuBasis, ecefToEnu, geodeticToEcef, sceneFromEnu } from './geodesy';
import { PTM_STROKE_KIND_OUTLINE, PTM_STROKE_KIND_WATER, PtmTile } from './ptm';
import type { RoadMeshes } from './roadStrokes';
import { TileKey, tileBounds } from './tiling';
import { LAND_TONE_BASE, TerrainTone } from './tones';

export interface TileMeshes {
    group: THREE.Group;
    /**
     * The tile's own LOD error, from its header. Kept on the GPU record so
     * the quadtree can read it after the decoded bytes are evicted.
     */
    geometricErrorM: number;
    land?: THREE.Mesh;
    water?: THREE.Mesh;
    rivers?: THREE.Mesh;
    /** Landuse region edges; shares the rivers' vertex arrays. */
    outlines?: THREE.Mesh;
    /**
     * A tile's two possible land geometries, so a shading switch is a
     * geometry swap on `land` rather than a re-stream or re-mesh. FACETED
     * keeps the baked per-triangle replication (flat facets) and is always
     * built. SMOOTH is the same bytes welded into shared vertices, colour
     * within one land-use region only and normal across the whole corner,
     * so the unchanged shader interpolates colour inside a region, keeps a
     * hard colour edge between two, and lights the slope continuously
     * across it — it is only worth the
     * weld-and-average pass for a tile actually shown in SMOOTH mode, so it
     * is built at upload time when SMOOTH is already active, or lazily on the
     * first switch to SMOOTH otherwise (see TerrainEntity.setTerrainShading).
     */
    landGeometryFaceted?: THREE.BufferGeometry;
    landGeometrySmooth?: THREE.BufferGeometry;
    /**
     * The tile's far cover texture, once attached (see CoverTextures):
     * undefined until asked for, 'pending' while its sidecar is fetched,
     * 'none' for a tile that has no sidecar, and the texture itself after
     * it is bound to the land mesh. Disposed with the tile.
     */
    cover?: THREE.DataTexture | 'pending' | 'none';
    /**
     * The tile's road strokes, once attached (see RoadStrokes): the same
     * three states as `cover`, then the bound meshes. Released with the tile.
     */
    roads?: RoadMeshes | 'pending' | 'none';
    /**
     * Tree billboards, once attached (see treeBillboards.ts and
     * terrainEntity.ts's upload callback). One InstancedMesh per species
     * actually present in the tile's forest (a mixed stand, not a single
     * species per tile), each bound to that species' own atlas. Undefined
     * until every present species' atlas texture has loaded (or the tile
     * turned out to have no forest triangles) — trees pop in shortly after
     * the rest of a newly streamed tile, not with it.
     */
    trees?: THREE.InstancedMesh[];
    /**
     * The quantScale-cancelling wrapper `trees` is parented under (see
     * terrainEntity.ts's attachTrees) — kept so a later rebuild (e.g. the
     * tree edge-density setting changing) can remove exactly this and only
     * this from the tile group before attaching fresh ones, without
     * disturbing land/water/rivers/outlines.
     */
    treesGroup?: THREE.Group;
    /** Set once the draw loop has asked for this tile's trees, so it asks only once. */
    treesRequested?: boolean;
    /**
     * The decoded source tile, kept only when it has forest triangles. The
     * mesh store evicts raw tiles independently of their GPU meshes, so by the
     * time the draw loop asks for a tile's trees the source is routinely gone
     * (most of an Alps view found none) and the forest stayed bare forever.
     */
    treeSource?: PtmTile;
    /** Density scale the current trees were scattered with, to notice when the camera has moved far enough to rescatter. */
    treesScale?: number;
    /** True while an attach is in flight, so a rescatter never overlaps one. */
    treesBusy?: boolean;
    /**
     * Set by disposeTileMeshes. Tree attachment resolves asynchronously
     * (waiting on a shared species atlas texture) and must not touch a tile
     * that was evicted before that resolved.
     */
    disposed?: boolean;
    /** Bytes of GPU buffer, for the cache budget. */
    bytes: number;
}

/** Materials indexed by {@link TerrainTone}. */
export type ToneMaterials = readonly THREE.Material[];

// TerrainClass.Ground spelled out: it is a `const enum`, and the tsx test
// runner leaves an imported const-enum binding undefined.
const GROUND_CLASS = 13;

/**
 * Whether any land vertex is TerrainClass.Ground - land no land-use polygon
 * claims, on a tile that has land-use. Only such a tile's other classes are
 * land-use regions (exact fills on the leaf, votes above it); on a raster-only
 * tile the classes *are* the ground.
 */
export function hasLanduseGround(landAttrs: Uint8Array): boolean {
    for (let i = 3; i < landAttrs.length; i += 4) {
        if (landAttrs[i] === GROUND_CLASS) {
            return true;
        }
    }
    return false;
}

/**
 * Per vertex, the width in metres of the land-use region it belongs to: the
 * square root of the region's area on this tile. 0 for ground, and for every
 * vertex of a raster-only tile. See LANDUSE_REVEAL_MIN_PX for what it gates.
 *
 * A region is a connected patch of one class: triangles of the same class
 * that share a corner (by exact quantised position) are one region. The
 * colour cannot tell regions apart, as it once did, because a fill's colour
 * is the regional lattice blended per vertex and so varies across the
 * polygon. Two touching regions of one class merge, which only makes both
 * show a little earlier. Non-indexed input: three vertices per triangle.
 */
export function regionSizes(
    positions: Int16Array, attrs: Uint8Array, quantScale: number,
): Uint16Array {
    const vertexCount = positions.length / 3;
    const out = new Uint16Array(vertexCount);
    if (!hasLanduseGround(attrs)) {
        return out;
    }
    const triCount = Math.floor(vertexCount / 3);
    // Union-find over triangles.
    const parent = new Int32Array(triCount);
    for (let t = 0; t < triCount; t++) {
        parent[t] = t;
    }
    const find = (t: number): number => {
        while (parent[t] !== t) {
            parent[t] = parent[parent[t]];
            t = parent[t];
        }
        return t;
    };
    const union = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) {
            parent[ra] = rb;
        }
    };
    const triArea = new Float64Array(triCount);
    // First triangle seen at each (position, class) corner.
    const cornerToTri = new Map<string, number>();
    for (let t = 0; t < triCount; t++) {
        const v = t * 3;
        const cls = attrs[v * 4 + 3];
        if (cls === GROUND_CLASS) {
            continue;
        }
        const ax = positions[v * 3], ay = positions[v * 3 + 1], az = positions[v * 3 + 2];
        const bx = positions[v * 3 + 3] - ax, by = positions[v * 3 + 4] - ay, bz = positions[v * 3 + 5] - az;
        const cx = positions[v * 3 + 6] - ax, cy = positions[v * 3 + 7] - ay, cz = positions[v * 3 + 8] - az;
        const nx = by * cz - bz * cy;
        const ny = bz * cx - bx * cz;
        const nz = bx * cy - by * cx;
        triArea[t] = 0.5 * Math.hypot(nx, ny, nz) * quantScale * quantScale;
        for (let k = 0; k < 3; k++) {
            const i = v + k;
            const key = `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]},${cls}`;
            const other = cornerToTri.get(key);
            if (other === undefined) {
                cornerToTri.set(key, t);
            } else {
                union(t, other);
            }
        }
    }
    const area = new Float64Array(triCount);
    for (let t = 0; t < triCount; t++) {
        if (attrs[t * 3 * 4 + 3] !== GROUND_CLASS) {
            area[find(t)] += triArea[t];
        }
    }
    for (let t = 0; t < triCount; t++) {
        if (attrs[t * 3 * 4 + 3] === GROUND_CLASS) {
            continue;
        }
        const size = Math.min(65535, Math.round(Math.sqrt(area[find(t)])));
        out[t * 3] = size;
        out[t * 3 + 1] = size;
        out[t * 3 + 2] = size;
    }
    return out;
}

function vertexCountOf(g: THREE.BufferGeometry): number {
    return g.getAttribute('position').count;
}

function landGeometry(tile: PtmTile): THREE.BufferGeometry | undefined {
    const vertexCount = tile.landPositions.length / 3;
    if (vertexCount === 0) {
        return undefined;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tile.landPositions, 3));

    // Normals are stored xyz + one pad byte so each vertex stays 4-byte
    // aligned. Interleaving reads the three we want without repacking.
    const normalBuffer = new THREE.InterleavedBuffer(tile.landNormals as unknown as Int8Array, 4);
    g.setAttribute(
        'normal',
        new THREE.InterleavedBufferAttribute(normalBuffer, 3, 0, true),
    );

    // One buffer, two views: the colour wants normalising to 0..1, the class
    // index does not. Splitting them into separate attributes would mean two
    // uploads of data that is already interleaved on the wire.
    const attrBuffer = new THREE.InterleavedBuffer(tile.landAttrs, 4);
    g.setAttribute('coverColor', new THREE.InterleavedBufferAttribute(attrBuffer, 3, 0, true));
    g.setAttribute('coverClass', new THREE.InterleavedBufferAttribute(attrBuffer, 1, 3, false));
    // Metres, not normalised: the shader compares it with a distance.
    g.setAttribute('regionSize', new THREE.BufferAttribute(
        regionSizes(tile.landPositions, tile.landAttrs, tile.quantScale), 1, false,
    ));

    // Land is one draw: the shader resolves colour per vertex from coverColor
    // and coverClass, so there is nothing left to bucket into tone groups.
    g.addGroup(0, vertexCount, LAND_TONE_BASE);
    return g;
}

/**
 * Which region a land vertex belongs to, for the smooth weld. On a tile with
 * land-use a non-ground vertex is its whole cover word, colour and class,
 * the same notion of a region as `regionSizes`; Ground keys on class alone,
 * since its colour is the blended regional field and is meant to
 * interpolate. On a raster-only tile the classes are the ground and every
 * facet carries its own sample, so keying on colour there would split the
 * weld back into facets: class alone tells the region.
 */
function regionKeyOf(attrs: Uint8Array, v: number, landuse: boolean): number {
    const cls = attrs[v * 4 + 3];
    if (!landuse || cls === GROUND_CLASS) {
        return cls;
    }
    return attrs[v * 4] | (attrs[v * 4 + 1] << 8) | (attrs[v * 4 + 2] << 16) | (cls << 24);
}

/**
 * The FACETED land geometry welded into shared vertices, with `coverColor`
 * averaged (mean) over the triangles of the *same region* that touch the
 * vertex and `normal` averaged (mean, renormalized) over every triangle
 * that touches the position, whatever its region.
 *
 * Welding is by exact match of the quantised int16 position plus the region
 * the vertex belongs to (see `regionKeyOf`), so a corner where a field meets
 * a forest is two vertices, one per region, each keeping its own colour:
 * colour smoothing happens inside a land-use region, never across the edge
 * between two. Lighting is the ground's, not the region's, so both vertices
 * share the one normal averaged over the whole corner and a slope shades
 * continuously across the edge. The class is the same for every contributor
 * to a colour and needs no vote. The position match is exact for two
 * triangles that share a corner in the bake — nothing here does
 * distance-based merging, so a genuine crack in the bake stays a crack. Only
 * within one tile: a seam at the tile boundary is not welded and stays
 * faceted, which is an accepted seam rather than a bug.
 *
 * Takes raw arrays rather than a `PtmTile` so it can also run lazily, long
 * after the tile's decoded value is gone — see `buildSmoothLandGeometryFromFaceted`,
 * which pulls the same arrays back out of the already-built FACETED geometry.
 * Expensive (a `Map` keyed on a per-vertex string) and only ever worth paying
 * for tiles actually shown in SMOOTH mode, which is why callers gate it
 * instead of it being run unconditionally per tile upload.
 */
export function buildSmoothLandGeometry(
    positions: Int16Array, normals: Int8Array, attrs: Uint8Array,
    /** Per-vertex region width (see regionSizes); the weld keeps the largest. */
    sizes?: Uint16Array,
): THREE.BufferGeometry | undefined {
    const vertexCount = positions.length / 3;
    if (vertexCount === 0) {
        return undefined;
    }

    // Two welds over one pass: colour (and class, size) by position+region,
    // normal by position alone. `normalOf` maps each output vertex to its
    // position's normal slot.
    const keyToIndex = new Map<string, number>();
    const posKeyToNormal = new Map<string, number>();
    const uniquePositions: number[] = [];
    const normalOf: number[] = [];
    const normalSum: number[] = [];
    const colorSum: number[] = [];
    const vertexClass: number[] = [];
    const sizeMax: number[] = [];
    const remap = new Uint32Array(vertexCount);
    const landuse = hasLanduseGround(attrs);

    for (let i = 0; i < vertexCount; i++) {
        const px = positions[i * 3];
        const py = positions[i * 3 + 1];
        const pz = positions[i * 3 + 2];
        const posKey = `${px},${py},${pz}`;
        let n = posKeyToNormal.get(posKey);
        if (n === undefined) {
            n = normalSum.length / 3;
            posKeyToNormal.set(posKey, n);
            normalSum.push(0, 0, 0);
        }
        const key = `${posKey},${regionKeyOf(attrs, i, landuse)}`;
        let idx = keyToIndex.get(key);
        if (idx === undefined) {
            idx = uniquePositions.length / 3;
            keyToIndex.set(key, idx);
            uniquePositions.push(px, py, pz);
            normalOf.push(n);
            colorSum.push(0, 0, 0, 0);
            vertexClass.push(attrs[i * 4 + 3]);
            sizeMax.push(0);
        }
        remap[i] = idx;
        if (sizes && sizes[i] > sizeMax[idx]) {
            sizeMax[idx] = sizes[i];
        }

        const ni = i * 4;
        normalSum[n * 3] += normals[ni];
        normalSum[n * 3 + 1] += normals[ni + 1];
        normalSum[n * 3 + 2] += normals[ni + 2];

        const ai = i * 4;
        colorSum[idx * 4] += attrs[ai];
        colorSum[idx * 4 + 1] += attrs[ai + 1];
        colorSum[idx * 4 + 2] += attrs[ai + 2];
        colorSum[idx * 4 + 3] += 1;
    }

    const uniqueCount = uniquePositions.length / 3;
    const outPositions = new Int16Array(uniquePositions);
    const outNormals = new Int8Array(uniqueCount * 4);
    const outAttrs = new Uint8Array(uniqueCount * 4);
    const outSizes = new Uint16Array(sizeMax);
    for (let v = 0; v < uniqueCount; v++) {
        const n = normalOf[v];
        const nx = normalSum[n * 3];
        const ny = normalSum[n * 3 + 1];
        const nz = normalSum[n * 3 + 2];
        const len = Math.hypot(nx, ny, nz) || 1;
        outNormals[v * 4] = Math.round((nx / len) * 127);
        outNormals[v * 4 + 1] = Math.round((ny / len) * 127);
        outNormals[v * 4 + 2] = Math.round((nz / len) * 127);
        outNormals[v * 4 + 3] = 0;

        const count = colorSum[v * 4 + 3] || 1;
        outAttrs[v * 4] = Math.round(colorSum[v * 4] / count);
        outAttrs[v * 4 + 1] = Math.round(colorSum[v * 4 + 1] / count);
        outAttrs[v * 4 + 2] = Math.round(colorSum[v * 4 + 2] / count);

        outAttrs[v * 4 + 3] = vertexClass[v];
    }

    const IndexArray = uniqueCount > 65535 ? Uint32Array : Uint16Array;
    const indices = new IndexArray(vertexCount);
    indices.set(remap);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(outPositions, 3));
    const normalBuffer = new THREE.InterleavedBuffer(outNormals as unknown as Int8Array, 4);
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(normalBuffer, 3, 0, true));
    const attrBuffer = new THREE.InterleavedBuffer(outAttrs, 4);
    g.setAttribute('coverColor', new THREE.InterleavedBufferAttribute(attrBuffer, 3, 0, true));
    g.setAttribute('coverClass', new THREE.InterleavedBufferAttribute(attrBuffer, 1, 3, false));
    g.setAttribute('regionSize', new THREE.BufferAttribute(outSizes, 1, false));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.addGroup(0, indices.length, LAND_TONE_BASE);
    return g;
}

/**
 * Build the SMOOTH land geometry on demand from an already-resident FACETED
 * one, for a tile that was uploaded before SMOOTH became the active setting.
 *
 * `landGeometry()` binds its attributes directly to the tile's decoded arrays
 * (see the file header), so those arrays are still alive here even though the
 * `PtmTile` itself is long gone — this just reads them back out.
 */
export function buildSmoothLandGeometryFromFaceted(faceted: THREE.BufferGeometry): THREE.BufferGeometry | undefined {
    const position = faceted.getAttribute('position') as THREE.BufferAttribute;
    const normal = faceted.getAttribute('normal') as THREE.InterleavedBufferAttribute;
    const coverColor = faceted.getAttribute('coverColor') as THREE.InterleavedBufferAttribute;
    const regionSize = faceted.getAttribute('regionSize') as THREE.BufferAttribute | undefined;
    return buildSmoothLandGeometry(
        position.array as Int16Array,
        normal.data.array as Int8Array,
        coverColor.data.array as Uint8Array,
        regionSize?.array as Uint16Array | undefined,
    );
}

function waterGeometry(tile: PtmTile): THREE.BufferGeometry | undefined {
    if (tile.waterIndices.length === 0) {
        return undefined;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tile.waterPositions, 3));
    g.setIndex(new THREE.BufferAttribute(tile.waterIndices, 1));
    for (let tone = 0; tone < tile.waterGroups.length; tone++) {
        const [start, count] = tile.waterGroups[tone];
        if (count > 0) {
            g.addGroup(start, count, tone);
        }
    }
    return g;
}

/**
 * The watercourse strokes: a centreline, doubled, plus what the vertex program
 * needs to widen it.
 *
 * Both vertices of a pair sit at the same position and differ only in
 * `riverDir`, so nothing here says how wide the ribbon is on screen — that is
 * settled per frame, in pixels, by RiverVertProgram.
 */
function strokeGeometry(tile: PtmTile, kind: number): THREE.BufferGeometry | undefined {
    if (tile.riverIndices.length === 0) {
        return undefined;
    }
    // Watercourses and landuse outlines share the one stroke stream and differ
    // only in the kind byte riding in riverDir's padding (see
    // PtmRiverInput.kinds), so each gets its own index list over the same
    // vertices. Both vertices of a pair, and every vertex of one stroke, carry
    // the same kind, so a triangle's first vertex speaks for all three.
    const all = tile.riverIndices;
    const dirs = tile.riverDirections;
    let count = 0;
    for (let i = 0; i < all.length; i += 3) {
        if (dirs[all[i] * 4 + 3] === kind) {
            count += 3;
        }
    }
    if (count === 0) {
        return undefined;
    }
    let indices = all;
    if (count !== all.length) {
        indices = new Uint16Array(count);
        let o = 0;
        for (let i = 0; i < all.length; i += 3) {
            if (dirs[all[i] * 4 + 3] === kind) {
                indices[o++] = all[i];
                indices[o++] = all[i + 1];
                indices[o++] = all[i + 2];
            }
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tile.riverPositions, 3));
    // Directions are stored xyz + one pad byte, like land normals, so each
    // vertex stays 4-byte aligned.
    const dirBuffer = new THREE.InterleavedBuffer(tile.riverDirections as unknown as Int8Array, 4);
    g.setAttribute('riverDir', new THREE.InterleavedBufferAttribute(dirBuffer, 3, 0, true));
    // Raw, not normalised: the shader wants decimetres, not a 0..1 fraction.
    g.setAttribute('riverHalf', new THREE.BufferAttribute(tile.riverHalfWidths, 1, false));
    // The filtered list, not the whole stream: with every index the water
    // material drew the landuse outlines too, as blue lines round each field.
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    return g;
}

/** Scene position of a tile's local frame origin. */
export function tileOriginWorld(
    id: TileKey, centerHeightM: number, basis: EnuBasis,
): THREE.Vector3 {
    const b = tileBounds(id);
    const lon = (b.west + b.east) / 2;
    const lat = (b.south + b.north) / 2;
    // Scene axes are x=east, y=up, z=south; see sceneFromEnu.
    return sceneFromEnu(ecefToEnu(basis, geodeticToEcef(lat, lon, centerHeightM)));
}

export function buildTileMeshes(
    tile: PtmTile,
    basis: EnuBasis,
    materials: ToneMaterials,
    riverMaterial?: THREE.Material,
    onBeforeRender?: THREE.Mesh['onBeforeRender'],
    /**
     * Rotation from the frame the tile was baked in into the one being drawn.
     * Identity whenever they are the same, which is every session flying in
     * the area the bake was centred on. See `enuFrameRotation`.
     */
    frameFix?: THREE.Quaternion,
    /** Which land geometry `land` starts on. A later switch swaps geometry, not tiles. */
    shading: TerrainShading = TerrainShading.FACETED,
    /** Landuse region edges. Omit and they are not drawn. */
    outlineMaterial?: THREE.Material,
    /**
     * The pyramid's finest zoom: a tile there carries land-use regions as
     * exact fills lifted over the ground; coarser tiles carry them as votes
     * painted onto it. See LANDUSE_REVEAL_MIN_PX for why the shader cares.
     */
    leafZoom: number = Infinity,
): TileMeshes {
    const group = new THREE.Group();
    group.name = `tile:${tile.id.z}/${tile.id.x}/${tile.id.y}`;
    group.position.copy(tileOriginWorld(tile.id, tile.centerHeightM, basis));
    if (frameFix) {
        // Vertices are offsets from the tile centre in the bake's axes; the
        // position above is already in the drawing frame, so only the offsets
        // need turning. Normals ride along via the object's world matrix.
        group.quaternion.copy(frameFix);
    }
    // Positions are quantised; the mesh transform turns them into metres.
    // The scale must stay uniform: updateUniforms builds normalModelMatrix
    // from matrixWorld with getNormalMatrix (inverse transpose), so a
    // non-uniform scale would skew the baked world-space normals and wash out
    // the per-facet shading. See PtmTile.quantScale.
    group.scale.setScalar(tile.quantScale);
    // A tile's position/rotation/scale are set exactly once, right here, and
    // never change again for its lifetime - only its parent's matrixWorld
    // moves it, via the camera-relative rebase every frame (see
    // submitCameraRelative). Composing position+quaternion+scale into a local
    // matrix is real trig-and-multiply work three.js otherwise redoes for
    // every resident tile on every single frame for nothing; disabling it
    // here still leaves matrixWorld tracking the moving parent correctly
    // (matrixWorldAutoUpdate is untouched), it just stops recomputing the
    // static local matrix that world matrix is built from.
    group.updateMatrix();
    group.matrixAutoUpdate = false;

    let bytes = 0;
    const meshes: TileMeshes = { group, bytes: 0, geometricErrorM: tile.geometricErrorM };

    const lg = landGeometry(tile);
    if (lg) {
        // Only pay the weld-and-average pass for tiles that will actually be
        // drawn in SMOOTH mode. A later switch to SMOOTH builds it lazily for
        // whatever is resident at the time — see
        // TerrainEntity.setTerrainShading — rather than every tile upload
        // paying it up front regardless of the active setting.
        const smoothLg = shading === TerrainShading.SMOOTH
            ? buildSmoothLandGeometry(
                tile.landPositions, tile.landNormals, tile.landAttrs,
                (lg.getAttribute('regionSize') as THREE.BufferAttribute).array as Uint16Array,
            )
            : undefined;
        const mesh = new THREE.Mesh(
            shading === TerrainShading.SMOOTH && smoothLg ? smoothLg : lg,
            materials as THREE.Material[],
        );
        mesh.frustumCulled = false;   // the quadtree already culled this tile
        mesh.matrixAutoUpdate = false; // identity local transform, never moves
        // Read per draw into uLodFills (see TerrainEntity).
        mesh.userData.landuseFills = tile.id.z >= leafZoom;
        if (onBeforeRender) {
            mesh.onBeforeRender = onBeforeRender;
        }
        group.add(mesh);
        meshes.land = mesh;
        meshes.landGeometryFaceted = lg;
        meshes.landGeometrySmooth = smoothLg;
        bytes += tile.landPositions.byteLength + tile.landNormals.byteLength
            + tile.landAttrs.byteLength + vertexCountOf(lg) * 2;   // regionSize
        if (smoothLg) {
            bytes += smoothLg.getIndex()?.array.byteLength ?? 0;
        }
    }

    const wg = waterGeometry(tile);
    if (wg) {
        const mesh = new THREE.Mesh(wg, materials as THREE.Material[]);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false; // identity local transform, never moves
        if (onBeforeRender) {
            mesh.onBeforeRender = onBeforeRender;
        }
        group.add(mesh);
        meshes.water = mesh;
        bytes += tile.waterPositions.byteLength + tile.waterIndices.byteLength;
    }

    const og = outlineMaterial ? strokeGeometry(tile, PTM_STROKE_KIND_OUTLINE) : undefined;
    if (og) {
        const mesh = new THREE.Mesh(og, outlineMaterial);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        // Same ordering argument as the rivers below, and before them, so a
        // river crossing a field edge draws over the edge rather than under it.
        mesh.renderOrder = 1;
        if (onBeforeRender) {
            mesh.onBeforeRender = onBeforeRender;
        }
        group.add(mesh);
        meshes.outlines = mesh;
        bytes += og.getIndex()?.array.byteLength ?? 0;
    }

    const rg = riverMaterial ? strokeGeometry(tile, PTM_STROKE_KIND_WATER) : undefined;
    if (rg) {
        const mesh = new THREE.Mesh(rg, riverMaterial);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false; // identity local transform, never moves
        // After the surface it lies on, always. The stroke is lifted off the
        // ground by the pixel floor rather than sunk into it, so it has to win
        // ties against the terrain it covers rather than lose them. And after
        // the road strokes (ROAD_RENDER_ORDER), so a bridge over a canal
        // still shows the water.
        mesh.renderOrder = 2;
        if (onBeforeRender) {
            mesh.onBeforeRender = onBeforeRender;
        }
        group.add(mesh);
        meshes.rivers = mesh;
        bytes += tile.riverPositions.byteLength + tile.riverDirections.byteLength
            + tile.riverHalfWidths.byteLength + tile.riverIndices.byteLength;
    }

    meshes.bytes = bytes;
    return meshes;
}

export function disposeTileMeshes(m: TileMeshes): void {
    // `land.geometry` is only ever one of these two — dispose both directly
    // rather than through it, or the one not currently mounted would leak.
    m.landGeometryFaceted?.dispose();
    m.landGeometrySmooth?.dispose();
    m.water?.geometry.dispose();
    m.rivers?.geometry.dispose();
    m.outlines?.geometry.dispose();
    if (m.cover instanceof THREE.DataTexture) {
        m.cover.dispose();
    }
    for (const trees of m.trees ?? []) {
        trees.geometry.dispose();
        (trees.material as THREE.Material).dispose();
    }
    // A sidecar still in flight must not bind to a released tile.
    m.cover = 'none';
    // Tree attachment is the one part of a tile still resolving
    // asynchronously (an in-flight species atlas fetch) after this runs.
    m.disposed = true;
    m.treeSource = undefined;
    m.group.clear();
}

import * as THREE from 'three';
import { PaletteCategory } from '../../../config/palettes/palette';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from "../../materials/materials";

enum VegetationKind {
    OAK,
    PINE,
    BUSH,
    BIRCH,
    SCRUB,
}

/** Silhouette used for a species' distant billboard impostor. */
export enum ImpostorShape {
    /** Small camera-facing quad centred on the canopy — low shrubs. */
    DOT,
    /** Broad upright quad — round broadleaf canopies. */
    QUAD,
    /** Upright triangle — conifers and slender trees. */
    TRIANGLE,
}

/** Raw, un-merged geometry for a single plant, in local space (base at y=0). */
interface VegetationInstanceGeometry {
    foliageCategory: PaletteCategory;
    canopy: THREE.BufferGeometry[];
    trunk?: THREE.BufferGeometry;
    maxRadius: number;
    maxHeight: number;
}

interface VegetationSpec {
    foliage: PaletteCategory;
    maxRadius: number;
    maxHeight: number;
    impostor: ImpostorShape;
    buildInstance: () => { canopy: THREE.BufferGeometry[]; trunk?: THREE.BufferGeometry };
}

const VEGETATION_SPECS: Record<VegetationKind, VegetationSpec> = {
    [VegetationKind.OAK]: {
        foliage: PaletteCategory.SCENERY_TREE_FOLIAGE,
        maxRadius: 28,
        maxHeight: 44,
        impostor: ImpostorShape.QUAD,
        buildInstance: buildOakInstance,
    },
    [VegetationKind.PINE]: {
        foliage: PaletteCategory.SCENERY_BIOME_PINE_FOLIAGE,
        maxRadius: 14,
        maxHeight: 52,
        impostor: ImpostorShape.TRIANGLE,
        buildInstance: buildPineInstance,
    },
    [VegetationKind.BUSH]: {
        foliage: PaletteCategory.SCENERY_BIOME_BUSH_FOLIAGE,
        maxRadius: 12,
        maxHeight: 10,
        impostor: ImpostorShape.DOT,
        buildInstance: buildBushInstance,
    },
    [VegetationKind.BIRCH]: {
        foliage: PaletteCategory.SCENERY_BIOME_BIRCH_FOLIAGE,
        maxRadius: 10,
        maxHeight: 38,
        impostor: ImpostorShape.TRIANGLE,
        buildInstance: buildBirchInstance,
    },
    [VegetationKind.SCRUB]: {
        foliage: PaletteCategory.SCENERY_BIOME_SCRUB_FOLIAGE,
        maxRadius: 14,
        maxHeight: 14,
        impostor: ImpostorShape.DOT,
        buildInstance: buildScrubInstance,
    },
};

/**
 * Uniform shrink applied to every plant so that, even after the maximum
 * per-tree (1.15x) and per-patch (1.45x) field scaling, the tallest species
 * (pine, ~47m raw) stays under the 20m height budget: 47 * 0.25 * 1.15 * 1.45 ≈ 19.6m.
 */
const VEGETATION_SCALE = 0.25;

function buildVegetationInstance(kind: VegetationKind): VegetationInstanceGeometry {
    const spec = VEGETATION_SPECS[kind];
    const { canopy, trunk } = spec.buildInstance();
    for (const geo of canopy) {
        geo.scale(VEGETATION_SCALE, VEGETATION_SCALE, VEGETATION_SCALE);
    }
    if (trunk) {
        trunk.scale(VEGETATION_SCALE, VEGETATION_SCALE, VEGETATION_SCALE);
    }
    return {
        foliageCategory: spec.foliage,
        canopy,
        trunk,
        maxRadius: spec.maxRadius * VEGETATION_SCALE,
        maxHeight: spec.maxHeight * VEGETATION_SCALE,
    };
}

/**
 * Per-species render parts for GPU-instanced vegetation: one merged canopy
 * geometry + material, an optional trunk, and a distant billboard impostor. All
 * parts use the flat (unshaded) material so per-fragment fog stays correct once
 * the vertex shader applies each instance's transform.
 */
interface VegetationParts {
    foliageGeometry: THREE.BufferGeometry;
    foliageMaterial: THREE.Material;
    trunkGeometry?: THREE.BufferGeometry;
    trunkMaterial?: THREE.Material;
    impostorGeometry: THREE.BufferGeometry;
    impostorMaterial: THREE.Material;
    /** Lowest LOD: a single 1px point per plant, coloured like the foliage. */
    pixelMaterial: THREE.Material;
    maxRadius: number;
    maxHeight: number;
}

/**
 * Flat billboard silhouette (XY plane, base at y=0, world units at unit scale).
 * Expanded to face the camera by the impostor vertex shader.
 */
function buildImpostorGeometry(shape: ImpostorShape, maxRadius: number, maxHeight: number): THREE.BufferGeometry {
    const r = maxRadius;
    const h = maxHeight;
    let positions: number[];

    if (shape === ImpostorShape.TRIANGLE) {
        positions = [
            -r, 0, 0,
            r, 0, 0,
            0, h, 0,
        ];
    } else if (shape === ImpostorShape.QUAD) {
        positions = [
            -r, 0, 0, r, 0, 0, r, h, 0,
            -r, 0, 0, r, h, 0, -r, h, 0,
        ];
    } else {
        // DOT: a small square centred on the canopy.
        const half = r * 0.8;
        const cy = h * 0.5;
        positions = [
            -half, cy - half, 0, half, cy - half, 0, half, cy + half, 0,
            -half, cy - half, 0, half, cy + half, 0, -half, cy + half, 0,
        ];
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    return geometry;
}

function buildVegetationParts(materials: SceneMaterialManager, kind: VegetationKind): VegetationParts {
    const inst = buildVegetationInstance(kind);

    const foliageGeometry = mergeGeometries(inst.canopy);
    const foliageMaterial = materials.build({
        type: SceneMaterialPrimitiveType.MESH,
        category: inst.foliageCategory,
        depthWrite: true,
        shaded: false,
    });

    let trunkGeometry: THREE.BufferGeometry | undefined;
    let trunkMaterial: THREE.Material | undefined;
    if (inst.trunk) {
        trunkGeometry = inst.trunk.index ? inst.trunk.toNonIndexed() : inst.trunk;
        trunkMaterial = materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.SCENERY_TREE_TRUNK,
            depthWrite: true,
            shaded: false,
        });
    }

    const spec = VEGETATION_SPECS[kind];
    const impostorGeometry = buildImpostorGeometry(spec.impostor, inst.maxRadius, inst.maxHeight);
    const impostorMaterial = materials.build({
        type: SceneMaterialPrimitiveType.IMPOSTOR,
        category: inst.foliageCategory,
        depthWrite: true,
    });

    const pixelMaterial = materials.build({
        type: SceneMaterialPrimitiveType.POINT,
        category: inst.foliageCategory,
        depthWrite: false,
    });

    return {
        foliageGeometry,
        foliageMaterial,
        trunkGeometry,
        trunkMaterial,
        impostorGeometry,
        impostorMaterial,
        pixelMaterial,
        maxRadius: inst.maxRadius,
        maxHeight: inst.maxHeight,
    };
}

function makeTrunkGeometry(topRadius: number, bottomRadius: number, height: number): THREE.BufferGeometry {
    const geometry = new THREE.CylinderGeometry(topRadius, bottomRadius, height, 4, undefined, true).toNonIndexed();
    geometry.translate(0, height / 2, 0);
    geometry.rotateY(Math.PI / 4);
    return geometry;
}

function buildOakInstance(): { canopy: THREE.BufferGeometry[]; trunk?: THREE.BufferGeometry } {
    const lobes = [
        { x: 0, y: 26, z: 0, r: 18 },
        { x: 10, y: 23, z: 5, r: 14 },
        { x: -8, y: 24, z: -6, r: 12 },
        { x: 0, y: 29, z: -10, r: 13 },
    ];
    const canopy = lobes.map(l => {
        const g = new THREE.IcosahedronGeometry(l.r, 0);
        g.translate(l.x, l.y, l.z);
        return g;
    });
    return { canopy, trunk: makeTrunkGeometry(2.5, 3.5, 22) };
}

function buildPineInstance(): { canopy: THREE.BufferGeometry[]; trunk?: THREE.BufferGeometry } {
    const layers = [
        { y: 38, r: 11, h: 18 },
        { y: 26, r: 13, h: 16 },
        { y: 16, r: 10, h: 12 },
    ];
    const canopy = layers.map(l => {
        const g = new THREE.ConeGeometry(l.r, l.h, 4, undefined, true).toNonIndexed();
        g.translate(0, l.y, 0);
        g.rotateY(Math.PI / 4);
        return g;
    });
    return { canopy, trunk: makeTrunkGeometry(1.5, 2.2, 28) };
}

function buildBushInstance(): { canopy: THREE.BufferGeometry[]; trunk?: THREE.BufferGeometry } {
    const clusters = [
        { x: 0, y: 5, z: 0, r: 8 },
        { x: 6, y: 4, z: 2, r: 6 },
        { x: -5, y: 4.5, z: -3, r: 5 },
    ];
    const canopy = clusters.map(c => {
        const g = new THREE.IcosahedronGeometry(c.r, 0);
        g.translate(c.x, c.y, c.z);
        return g;
    });
    return { canopy };
}

function buildBirchInstance(): { canopy: THREE.BufferGeometry[]; trunk?: THREE.BufferGeometry } {
    const g = new THREE.IcosahedronGeometry(9, 0);
    g.translate(0, 32, 0);
    return { canopy: [g], trunk: makeTrunkGeometry(1.2, 1.6, 30) };
}

function buildScrubInstance(): { canopy: THREE.BufferGeometry[]; trunk?: THREE.BufferGeometry } {
    const tufts = [
        { x: 0, y: 4, z: 0, r: 5 },
        { x: 4, y: 3, z: 3, r: 4 },
        { x: -3, y: 3.5, z: -2, r: 3.5 },
        { x: 1, y: 5, z: -4, r: 3 },
    ];
    const canopy = tufts.map(t => {
        const g = new THREE.ConeGeometry(t.r, t.r * 1.6, 4, undefined, true).toNonIndexed();
        g.translate(t.x, t.y, t.z);
        g.rotateY(Math.PI / 4);
        return g;
    });
    return { canopy };
}

export function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
    let totalVertices = 0;
    const nonIndexed: THREE.BufferGeometry[] = [];
    for (const geo of geometries) {
        const flat = geo.index ? geo.toNonIndexed() : geo;
        nonIndexed.push(flat);
        totalVertices += flat.getAttribute('position').count;
    }

    const positions = new Float32Array(totalVertices * 3);
    let offset = 0;
    for (const geo of nonIndexed) {
        const attr = geo.getAttribute('position');
        positions.set(attr.array as Float32Array, offset);
        offset += attr.count * 3;
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.computeVertexNormals();
    return merged;
}

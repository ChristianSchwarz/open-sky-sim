import * as THREE from 'three';
import { Species, TREE_VIEWS, TreeView, generateTreeSprite } from '../vegetation/treeSprites';

/**
 * One 2x2 CanvasTexture per species: 0deg/30deg top row, 60deg/90deg bottom
 * row. `treeBillboardVP.ts` picks a quadrant per instance per frame from the
 * camera's elevation angle above the tree (0 = eye-level, 90 = straight
 * down), so the runtime only ever binds one texture per species no matter how
 * many trees or view angles are on screen.
 */
const CELL_SIZE = 128;
const ATLAS_SIZE = CELL_SIZE * 2;

/** (col, row) within the 2x2 atlas each view is rasterised into - must match the bucket layout in treeBillboardVP.ts. */
const VIEW_CELL: Record<TreeView, [number, number]> = {
    [TreeView.DEG_0]: [0, 0],
    [TreeView.DEG_30]: [1, 0],
    [TreeView.DEG_60]: [0, 1],
    [TreeView.DEG_90]: [1, 1],
};

const cache = new Map<Species, Promise<THREE.CanvasTexture>>();

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to rasterise tree sprite SVG'));
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
}

async function buildAtlas(species: Species): Promise<THREE.CanvasTexture> {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_SIZE;
    canvas.height = ATLAS_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('2D canvas context unavailable for tree atlas');
    }

    await Promise.all(TREE_VIEWS.map(async view => {
        const img = await loadSvgImage(generateTreeSprite(species, view));
        const [col, row] = VIEW_CELL[view];
        ctx.drawImage(img, col * CELL_SIZE, row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }));

    // flipY = false: canvas row order then matches vUv directly (see
    // treeBillboardVP.ts), rather than three.js's default bottom-up sampling.
    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = false;
    // magFilter stays Nearest for a crisp close-up silhouette, but minFilter
    // needs mipmaps: a tree billboard is usually seen from far off and at a
    // steep angle, minifying its atlas cell to a handful of screen pixels.
    // Without mipmaps, Nearest-sampling that picks one texel per pixel mostly
    // lands on the sprite's transparent background or antialiased edge,
    // breaking a solid canopy into a sparse scatter of dots instead of a
    // blended, still-recognisably-tree-coloured blob.
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
}

/** Lazily rasterises and caches one atlas texture per species, shared across every tile that needs it. */
export function getTreeSpeciesAtlas(species: Species): Promise<THREE.CanvasTexture> {
    let promise = cache.get(species);
    if (!promise) {
        promise = buildAtlas(species);
        cache.set(species, promise);
    }
    return promise;
}

/** Test/teardown hook: drops every cached atlas so a later call rebuilds them. */
export function clearTreeSpeciesAtlasCache(): void {
    cache.clear();
}

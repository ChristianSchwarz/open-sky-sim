import * as THREE from 'three';
import { TREE_VIEWS, TreeView } from '../vegetation/treeSprites';
import { ROCK_SHAPE_COUNT, RockShape, generateRockSprite } from '../vegetation/stoneSprites';

/**
 * One shared CanvasTexture for every stone shape, laid out exactly like
 * treeAtlas.ts's forest atlas (a 2-wide grid of shape blocks, each a 2x2
 * grid of the same 4 elevation views) so treeBillboardVP.ts's hardcoded
 * quadrant math (see its `spCol`/`spRow`/`col`/`row`) draws stones with no
 * shader changes - only this atlas and stones.ts's instance geometry differ
 * from a tree's.
 */
// Same cell size as treeAtlas.ts, not a smaller one: a mismatched atlas size
// was seen paired with a stalled renderer (a GL_INVALID_VALUE from
// glCopySubTextureCHROMIUM during a texture upload, then no further frames)
// in one debug session, and matching the already-proven tree atlas exactly
// removes that as a variable.
const CELL_SIZE = 128;
const BLOCK_SIZE = CELL_SIZE * 2;
const ATLAS_W = BLOCK_SIZE * 2;
const ATLAS_H = BLOCK_SIZE * 3;

/** (col, row) of a shape's block within the 2-wide block grid - must match treeBillboardVP.ts (species % 2, floor(species / 2)). */
function shapeBlock(shape: RockShape): [number, number] {
    return [shape % 2, Math.floor(shape / 2)];
}

/** (col, row) within the 2x2 atlas each view is rasterised into - must match the bucket layout in treeBillboardVP.ts. */
const VIEW_CELL: Record<TreeView, [number, number]> = {
    [TreeView.DEG_0]: [0, 0],
    [TreeView.DEG_30]: [1, 0],
    [TreeView.DEG_60]: [0, 1],
    [TreeView.DEG_90]: [1, 1],
};

let atlasPromise: Promise<THREE.CanvasTexture> | undefined;

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to rasterise stone sprite SVG'));
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
}

async function buildAtlas(): Promise<THREE.CanvasTexture> {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_W;
    canvas.height = ATLAS_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('2D canvas context unavailable for stone atlas');
    }

    const jobs: Promise<void>[] = [];
    for (let shape = 0 as RockShape; shape < ROCK_SHAPE_COUNT; shape++) {
        const [bx, by] = shapeBlock(shape);
        for (const view of TREE_VIEWS) {
            jobs.push(loadSvgImage(generateRockSprite(shape, view)).then(img => {
                const [col, row] = VIEW_CELL[view];
                ctx.drawImage(img, bx * BLOCK_SIZE + col * CELL_SIZE, by * BLOCK_SIZE + row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            }));
        }
    }
    await Promise.all(jobs);

    // flipY = false: canvas row order then matches vUv directly (see
    // treeBillboardVP.ts), rather than three.js's default bottom-up sampling.
    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = false;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
}

/** Lazily rasterises and caches the one shared stone atlas. */
export function getStoneAtlas(): Promise<THREE.CanvasTexture> {
    atlasPromise ??= buildAtlas();
    return atlasPromise;
}

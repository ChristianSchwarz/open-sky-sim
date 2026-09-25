/**
 * Procedural SVG billboard stone sprites - small ground clutter (see
 * ../../terrain/stones.ts) scattered on bare/grass/ground/moss facets away
 * from trees, shrubs, roads, runways and built-up areas.
 *
 * Reuses treeSprites.ts/treeBillboardVP.ts's 4-elevation-angle atlas
 * convention (see stoneAtlas.ts) so the existing tree-billboard shader draws
 * stones unmodified - only the atlas texture and instance geometry differ.
 * Each "shape" is a small irregular cluster of overlapping rounded lobes,
 * drawn near-white so the runtime tints it from the palette's bare-ground
 * colour (see stones.ts), the same trick treeSprites.ts uses for canopies.
 */

import { TreeView } from './treeSprites';

export enum RockShape {
    ROUND = 0,
    ANGULAR = 1,
    FLAT = 2,
    CLUSTER = 3,
    SLAB = 4,
    PEBBLE = 5,
}

/** Fills the whole 2x3 block grid treeAtlas.ts's layout provides, for maximum variety from one shared atlas. */
export const ROCK_SHAPE_COUNT = 6;

const FRAME = { w: 100, h: 100 };
const ROCK_FILL = '#ffffff';

function svgWrap(inner: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FRAME.w} ${FRAME.h}">${inner}</svg>`;
}

/** Deterministic 0..1 pseudo-random, so a shape's lobe scatter is fixed, not re-rolled every generation. */
function hash01(n: number): number {
    const s = Math.sin(n * 12.9898) * 43758.5453;
    return s - Math.floor(s);
}

interface Lobe {
    dx: number;
    dy: number;
    rx: number;
    ry: number;
}

/**
 * A handful of overlapping lobes clustered low in the frame, so a stone
 * reads as a squat mass sitting on the ground rather than a floating disc.
 * `flattenTop` (0 side view .. 1 straight down) rounds the lobes out toward
 * an even top-down blob, the same interpolation idea as treeSprites.ts's
 * canopyPath but much simpler - a rock's outline barely changes with view
 * angle, unlike a tree's canopy-over-trunk silhouette.
 */
function rockLobes(shape: RockShape, flattenTop: number): Lobe[] {
    const seed = 200 + shape * 31;
    const count = shape === RockShape.CLUSTER ? 5 : shape === RockShape.PEBBLE ? 2 : 3;
    const widen = shape === RockShape.FLAT || shape === RockShape.SLAB ? 1.35 : 1;
    const lobes: Lobe[] = [];
    for (let i = 0; i < count; i++) {
        const a = (Math.PI * 2 * i) / count + hash01(seed) * Math.PI;
        const d = 9 + hash01(seed + i * 5.3) * 11;
        const rx = (18 + hash01(seed + i * 7.1) * 10) * widen;
        const ry = (22 - flattenTop * 7 + hash01(seed + i * 3.7) * 5) * (shape === RockShape.SLAB ? 0.7 : 1);
        lobes.push({ dx: Math.cos(a) * d * widen, dy: Math.sin(a) * d * 0.5, rx, ry });
    }
    return lobes;
}

function rockPath(shape: RockShape, angleDeg: number): string {
    const t = Math.min(Math.max(angleDeg, 0), 90) / 90;
    const cx = FRAME.w / 2;
    // Settles toward the frame's centre looking straight down, same as a
    // tree's canopy sliding off the trunk into a top-down disc.
    const cy = FRAME.h - 32 - t * 14;
    let inner = '';
    for (const lobe of rockLobes(shape, t)) {
        const lx = cx + lobe.dx;
        const ly = cy + lobe.dy * (1 - t * 0.5);
        inner += `<ellipse cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" rx="${lobe.rx.toFixed(1)}" ry="${lobe.ry.toFixed(1)}" fill="${ROCK_FILL}"/>`;
    }
    return inner;
}

const VIEW_ANGLES_DEG: Readonly<Record<TreeView, number>> = {
    [TreeView.DEG_0]: 0,
    [TreeView.DEG_30]: 30,
    [TreeView.DEG_60]: 60,
    [TreeView.DEG_90]: 90,
};

/** Generates one stone shape's silhouette at the given view's elevation angle, as an SVG document string. */
export function generateRockSprite(shape: RockShape, view: TreeView): string {
    return svgWrap(rockPath(shape, VIEW_ANGLES_DEG[view]));
}

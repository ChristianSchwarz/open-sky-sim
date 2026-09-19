/**
 * Procedural SVG billboard tree sprites.
 *
 * Each species gets one representative silhouette, drawn at four fixed
 * elevation angles - how far down the camera is looking at it, not its
 * horizontal orbit angle: 0 degrees is eye-level (full side silhouette,
 * trunk visible), 90 degrees is looking straight down (a flat canopy disc,
 * no trunk - there is nothing to see below the crown from directly above).
 * 30 and 60 are the steps between. This matches how a tree is actually seen
 * in this game: overwhelmingly from an aircraft changing altitude and dive
 * angle over it, not orbiting around it at a fixed height (see
 * `treeBillboardVP.ts`, which computes the camera's actual elevation angle
 * and picks the nearest of these four). These are flat vector-art shapes, in
 * keeping with the renderer's palette-driven, unshaded aesthetic elsewhere
 * (see `vegetationModelBuilder.ts`'s `ImpostorShape`) — there is no
 * photographic source art, only procedurally generated silhouettes.
 *
 * The roster (maple, pine, linden, fir) is a trimmed
 * subset of a larger reference chart of named central European species
 * rather than a set of world climate zones - it is a look-alike library, not
 * a real per-species botanical model.
 *
 * A crown is a scatter of overlapping lobes rather than one smooth ellipse -
 * a lumpy, clumped outline reads as foliage; a single perfect ellipse reads
 * as a lollipop. `crownShape` picks how those lobes are arranged (a conical
 * taper for conifers, a columnar stack for birch/poplar/alder, a flat spread
 * for a wide umbrella canopy, a sparse scatter for scrub), but every
 * arrangement is still generated from the same (rx, ry, cy) envelope that's
 * interpolated between a species' side-view proportions and its top-down
 * radius - so every species interpolates smoothly and correctly across the
 * four elevation steps without hand-tuning each one's in-between frames. It
 * is drawn in a neutral near-white, not a baked colour: the runtime tints it
 * from the terrain's own forest palette colour, with a little per-instance
 * variation, so trees read as the same green the ground paints rather than a
 * fixed hue baked in here (see treeBillboardFP.ts). Only the trunk keeps a
 * real, species-specific colour, since the runtime's low-saturation canopy
 * test leaves anything already saturated untinted - and it always reaches at
 * least to the crown's own centre, not just its base edge, so it reads as
 * running up into the branches rather than handing off to the foliage at a
 * clean seam.
 *
 * The four views are packed into one 2x2 atlas per species so the runtime
 * binds a single texture per species and only has to pick a UV quadrant per
 * instance.
 */

export enum TreeView {
    DEG_0 = 0,
    DEG_30 = 1,
    DEG_60 = 2,
    DEG_90 = 3,
}

const TREE_VIEW_ANGLES_DEG: Readonly<Record<TreeView, number>> = {
    [TreeView.DEG_0]: 0,
    [TreeView.DEG_30]: 30,
    [TreeView.DEG_60]: 60,
    [TreeView.DEG_90]: 90,
};

export const TREE_VIEWS: readonly TreeView[] = [TreeView.DEG_0, TreeView.DEG_30, TreeView.DEG_60, TreeView.DEG_90];

export enum Species {
    MAPLE = 0,
    PINE = 1,
    LINDEN = 2,
    FIR = 3,
}

export const SPECIES_COUNT = 4;

/**
 * How a crown's lobes are scattered within its (rx, ry) envelope:
 * - round: a full, bushy scatter filling the whole envelope (broadleaf).
 * - conical: lobes stacked in narrowing tiers toward the top (conifers).
 * - spreading: lobes flattened into a wide, low band (an acacia's umbrella).
 * - sparse: few, small, gapped lobes - a starved or leafless-looking crown.
 * - columnar: lobes stacked with little taper - a narrow, upright crown
 *   (birch, poplar, alder), distinct from a conifer's point or a broadleaf's
 *   round scatter.
 */
type CrownShape = 'round' | 'conical' | 'spreading' | 'sparse' | 'columnar';

/** A silhouette spec is not tied to Species - see renderTreeSilhouette, used to preview species specs that aren't (yet) wired into the roster. */
export interface TreeSilhouetteSpec {
    name: string;
    /** The trunk is the one part of the sprite drawn in a real, untinted colour. */
    trunkColor: string;
    /** 0..1, scales overall tree height (side view) within the sprite frame. */
    heightScale: number;
    /** Canopy half-width at side view (0deg), relative to frame width. */
    sideRx: number;
    /** Canopy half-height at side view (0deg), relative to tree height. */
    sideRy: number;
    /** Canopy radius at straight-down view (90deg), relative to frame width. */
    topRadius: number;
    /** Trunk height at side view, relative to tree height; 0 = no trunk (shrubs). */
    trunkHeightFactor: number;
    trunkWidthFactor: number;
    crownShape: CrownShape;
    /** Deterministic seed so this species' lobe scatter is fixed, not re-randomised per generation. */
    seed: number;
}

export const SPECIES_SPECS: Record<Species, TreeSilhouetteSpec> = {
    [Species.MAPLE]: { name: 'maple', trunkColor: '#5b5a34', heightScale: 1.0, sideRx: 0.34, sideRy: 0.32, topRadius: 0.36, trunkHeightFactor: 0.35, trunkWidthFactor: 0.07, crownShape: 'round', seed: 101 },
    // A mature pine: a very tall, slender, mostly bare reddish-brown trunk
    // (~65% of the tree) topped by a narrower, taller-than-wide, irregular
    // crown of clumped foliage - not a flat, wide-spreading canopy, and not
    // a symmetric pyramid running most of the way down like the other conifers.
    [Species.PINE]: { name: 'pine', trunkColor: '#6b4226', heightScale: 1.25, sideRx: 0.26, sideRy: 0.32, topRadius: 0.26, trunkHeightFactor: 0.65, trunkWidthFactor: 0.04, crownShape: 'round', seed: 11 },
    [Species.LINDEN]: { name: 'linden', trunkColor: '#4d4a2c', heightScale: 1.05, sideRx: 0.38, sideRy: 0.38, topRadius: 0.4, trunkHeightFactor: 0.28, trunkWidthFactor: 0.085, crownShape: 'round', seed: 113 },
    [Species.FIR]: { name: 'fir', trunkColor: '#45482a', heightScale: 1.25, sideRx: 0.3, sideRy: 0.58, topRadius: 0.26, trunkHeightFactor: 0.05, trunkWidthFactor: 0.045, crownShape: 'conical', seed: 115 },
};

const FRAME = { w: 100, h: 150 };
const CANOPY_FILL = '#ffffff';

function svgWrap(inner: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FRAME.w} ${FRAME.h}">${inner}</svg>`;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/** Deterministic 0..1 pseudo-random, so a species' crown is fixed rather than re-rolled every generation. */
function hash01(n: number): number {
    const s = Math.sin(n * 12.9898) * 43758.5453;
    return s - Math.floor(s);
}

/**
 * A tapered trunk, wider at the root than at the crown, with a small root
 * flare - a plain uniform rectangle reads as a post, not a tree.
 */
function trunkPath(spec: TreeSilhouetteSpec, height: number): string {
    const topWidth = FRAME.w * spec.trunkWidthFactor;
    const baseWidth = topWidth * 1.6;
    const cx = FRAME.w / 2;
    const y0 = FRAME.h; // root
    const y1 = FRAME.h - height;
    return `<polygon points="`
        + `${(cx - baseWidth / 2).toFixed(1)},${y0.toFixed(1)} `
        + `${(cx + baseWidth / 2).toFixed(1)},${y0.toFixed(1)} `
        + `${(cx + topWidth / 2).toFixed(1)},${y1.toFixed(1)} `
        + `${(cx - topWidth / 2).toFixed(1)},${y1.toFixed(1)}`
        + `" fill="${spec.trunkColor}"/>`;
}

interface Lobe {
    dx: number;
    dy: number;
    /** 0..1, relative to the envelope's own rx/ry. */
    r: number;
}

/** Lobe offsets/sizes, in envelope-relative units (later scaled by the actual rx/ry/cy). */
function lobeLayout(shape: CrownShape, seed: number): Lobe[] {
    switch (shape) {
        case 'conical': {
            // Tiers stacked from the base up, each narrower than the last -
            // a fir's silhouette, not a ball on a stick.
            const tiers = 4;
            const lobes: Lobe[] = [];
            for (let i = 0; i < tiers; i++) {
                const t = i / (tiers - 1); // 0 at base, 1 at the tip
                lobes.push({ dx: 0, dy: lerp(0.65, -0.85, t), r: lerp(0.62, 0.22, t) });
                if (i < tiers - 1) {
                    // A pair of flanking lobes per tier below the tip, so the
                    // outline is scalloped rather than a plain stack of discs.
                    const w = lerp(0.5, 0.12, t);
                    lobes.push({ dx: -w, dy: lerp(0.6, -0.8, t), r: lerp(0.34, 0.14, t) });
                    lobes.push({ dx: w, dy: lerp(0.6, -0.8, t), r: lerp(0.34, 0.14, t) });
                }
            }
            return lobes;
        }
        case 'spreading': {
            // A low, wide band of overlapping lobes - an umbrella canopy.
            const count = 7;
            const lobes: Lobe[] = [];
            for (let i = 0; i < count; i++) {
                const u = i / (count - 1);
                const dx = lerp(-0.8, 0.8, u);
                const dy = -0.15 + 0.3 * Math.sin(u * Math.PI) + (hash01(seed + i * 3.7) - 0.5) * 0.2;
                lobes.push({ dx, dy, r: 0.4 + hash01(seed + i * 5.1) * 0.15 });
            }
            return lobes;
        }
        case 'sparse': {
            // A handful of small, gapped lobes - reads as thin or starved.
            const count = 3;
            const lobes: Lobe[] = [];
            for (let i = 0; i < count; i++) {
                const a = hash01(seed + i * 4.3) * Math.PI * 2;
                const d = 0.25 + hash01(seed + i * 6.1) * 0.35;
                lobes.push({ dx: Math.cos(a) * d, dy: Math.sin(a) * d * 0.8, r: 0.35 + hash01(seed + i * 2.9) * 0.15 });
            }
            return lobes;
        }
        case 'columnar': {
            // Lobes stacked with only a slight taper - a narrow, upright
            // crown (birch, poplar, alder), distinct from a conifer's point.
            const tiers = 5;
            const lobes: Lobe[] = [];
            for (let i = 0; i < tiers; i++) {
                const t = i / (tiers - 1);
                const jitter = (hash01(seed + i * 2.7) - 0.5) * 0.18;
                lobes.push({ dx: jitter, dy: lerp(0.85, -0.85, t), r: lerp(0.42, 0.3, t) });
            }
            return lobes;
        }
        case 'round':
        default: {
            // A full, bushy scatter of overlapping lobes across the envelope,
            // plus one central lobe to keep the middle from reading hollow.
            const count = 6;
            const lobes: Lobe[] = [{ dx: 0, dy: 0, r: 0.6 }];
            for (let i = 0; i < count; i++) {
                const a = (Math.PI * 2 * i) / count + hash01(seed) * Math.PI;
                const d = 0.45 + hash01(seed + i * 5.3) * 0.25;
                lobes.push({ dx: Math.cos(a) * d, dy: Math.sin(a) * d, r: 0.4 + hash01(seed + i * 7.7) * 0.2 });
            }
            return lobes;
        }
    }
}

function canopyPath(spec: TreeSilhouetteSpec, angleDeg: number): string {
    const t = Math.min(Math.max(angleDeg, 0), 90) / 90;
    const h = Math.min(FRAME.h * spec.heightScale, FRAME.h - 2);
    const topY = FRAME.h - h;
    const cx = FRAME.w / 2;

    // Interpolate from the side silhouette's envelope toward the straight-down
    // disc: the canopy's horizontal radius barely changes (you see about the
    // same crown width from any angle), its vertical radius collapses toward
    // that same radius (a disc, not a tall oval), and it slides from partway
    // up the trunk toward the frame's centre, as looking down flattens the
    // whole tree onto the ground plane. Every lobe is generated from this one
    // envelope, so the whole crown flattens together correctly.
    const sideRx = FRAME.w * spec.sideRx;
    const sideRy = h * spec.sideRy;
    const sideCy = topY + sideRy;
    const topR = FRAME.w * spec.topRadius;
    const topCy = FRAME.h / 2;

    const rx = lerp(sideRx, topR, t);
    const ry = lerp(sideRy, topR, t);
    const cy = lerp(sideCy, topCy, t);

    // The trunk is what you see standing beside a tree at eye level and
    // what disappears entirely once you are looking straight down its top.
    // It has to reach at least to the crown's own centre, not stop at its
    // base edge - a real trunk runs up into the branches, it doesn't hand
    // off to the foliage at a clean seam.
    // The top is held at the crown's centre at every angle (not shrunk with
    // (1 - t), which left it floating below the crown at 30/60 degrees); it
    // is only dropped once the view is straight down.
    const trunkHeight = Math.max(h * spec.trunkHeightFactor * (1 - t), FRAME.h - cy);
    const trunk = t < 0.999 ? trunkPath(spec, trunkHeight) : '';

    let canopy = '';
    for (const lobe of lobeLayout(spec.crownShape, spec.seed)) {
        const lx = cx + lobe.dx * rx;
        const ly = cy + lobe.dy * ry;
        const lrx = rx * lobe.r;
        const lry = ry * lobe.r;
        if (lrx < 0.4 || lry < 0.4) {
            continue;
        }
        canopy += `<ellipse cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" rx="${lrx.toFixed(1)}" ry="${lry.toFixed(1)}" fill="${CANOPY_FILL}"/>`;
    }
    return trunk + canopy;
}

/**
 * Renders any silhouette spec at a given elevation angle, as an SVG document
 * string - the same engine `generateTreeSprite` uses for the biome roster,
 * exposed so species specs that aren't (yet) wired into that roster can
 * still be previewed with it.
 */
function renderTreeSilhouette(spec: TreeSilhouetteSpec, angleDeg: number): string {
    return svgWrap(canopyPath(spec, angleDeg));
}

/** Generates one species' tree silhouette at the given view's elevation angle, as an SVG document string. */
export function generateTreeSprite(species: Species, view: TreeView): string {
    return renderTreeSilhouette(SPECIES_SPECS[species], TREE_VIEW_ANGLES_DEG[view]);
}

export function speciesSpriteFileName(species: Species, view: TreeView): string {
    return `${SPECIES_SPECS[species].name}-${TREE_VIEW_ANGLES_DEG[view]}deg.svg`;
}

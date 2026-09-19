/**
 * Lifting-line influences for FM3 (after Phillips & Snyder's numerical lifting
 * line).
 *
 * Every strip carries a horseshoe vortex: a bound segment on its quarter-chord
 * line from node A to node B, and a trailing leg from each node to infinity
 * downstream. Biot–Savart gives the velocity each horseshoe induces at every
 * strip's control point (the middle of its own bound segment). Only the
 * component along the receiving strip's normal changes its angle of attack, so
 * that scalar is stored, per unit circulation, and the runtime cost of the
 * whole induced-flow field is one matrix–vector product.
 *
 * The trailing legs follow the freestream, so the influences depend on the
 * direction the wake leaves in. They are tabulated once per airframe over a
 * grid of wake angle of attack and sideslip and interpolated bilinearly.
 */

const INV_FOUR_PI = 1 / (4 * Math.PI);

/**
 * Velocity induced at P by a unit horseshoe: bound A→B, trailing legs leaving
 * A and B along the downstream unit vector d. Adds into out[o..o+2].
 * `core2` (m²) softens the singularity next to a vortex line.
 */
function addHorseshoeVelocity(
    px: number, py: number, pz: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    dx: number, dy: number, dz: number,
    core2: number, out: Float64Array, o = 0,
): void {
    const r1x = px - ax, r1y = py - ay, r1z = pz - az;
    const r2x = px - bx, r2y = py - by, r2z = pz - bz;
    const r1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z);
    const r2 = Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z);

    // Bound segment.
    const cx = r1y * r2z - r1z * r2y;
    const cy = r1z * r2x - r1x * r2z;
    const cz = r1x * r2y - r1y * r2x;
    const dot12 = r1x * r2x + r1y * r2y + r1z * r2z;
    const boundDen = r1 * r2 * (r1 * r2 + dot12) + core2 * core2;
    const kb = boundDen > 0 ? (r1 + r2) / boundDen : 0;

    // Leg from B downstream (+) and leg from infinity into A (−).
    const legBDen = r2 * (r2 - (dx * r2x + dy * r2y + dz * r2z)) + core2;
    const legADen = r1 * (r1 - (dx * r1x + dy * r1y + dz * r1z)) + core2;
    const kB = legBDen > 0 ? 1 / legBDen : 0;
    const kA = legADen > 0 ? 1 / legADen : 0;

    out[o] += INV_FOUR_PI * (kb * cx + kB * (dy * r2z - dz * r2y) - kA * (dy * r1z - dz * r1y));
    out[o + 1] += INV_FOUR_PI * (kb * cy + kB * (dz * r2x - dx * r2z) - kA * (dz * r1x - dx * r1z));
    out[o + 2] += INV_FOUR_PI * (kb * cz + kB * (dx * r2y - dy * r2x) - kA * (dx * r1y - dy * r1x));
}

/**
 * Downstream unit vector in sim body axes for a wake angle of attack and
 * sideslip (NASA conventions: the aircraft moves along
 * (cos α cos β, sin β, sin α cos β), so the air leaves the other way).
 */
function wakeDirection(alpha: number, beta: number, out: Float64Array): Float64Array {
    const ca = Math.cos(alpha), sa = Math.sin(alpha);
    const cb = Math.cos(beta), sb = Math.sin(beta);
    // NASA downstream (−cosα cosβ, −sinβ, −sinα cosβ) → sim (−y_N, −z_N, x_N).
    out[0] = sb;
    out[1] = sa * cb;
    out[2] = -ca * cb;
    return out;
}

/** Horseshoe geometry, sim body axes relative to the CG. */
export interface HorseshoeSet {
    count: number;
    ax: Float64Array; ay: Float64Array; az: Float64Array;
    bx: Float64Array; by: Float64Array; bz: Float64Array;
    px: Float64Array; py: Float64Array; pz: Float64Array;
    nx: Float64Array; ny: Float64Array; nz: Float64Array;
    /** Vortex core radius per horseshoe (m). */
    core: Float64Array;
    /** 1 where the horseshoe also has a mirror image in a root endplate, whose nodes follow. */
    hasImage?: Uint8Array;
    iax?: Float64Array; iay?: Float64Array; iaz?: Float64Array;
    ibx?: Float64Array; iby?: Float64Array; ibz?: Float64Array;
}

const DEG = Math.PI / 180;
export const WAKE_ALPHAS = [-30, -15, 0, 15, 30, 45, 60, 75, 90].map(d => d * DEG);
export const WAKE_BETAS = [-30, -15, 0, 15, 30].map(d => d * DEG);

export class InfluenceTable {
    readonly count: number;
    private readonly alphas: number[];
    private readonly betas: number[];
    /** [alphaIndex][betaIndex][receiver i][source j], flattened. */
    private readonly data: Float64Array;

    constructor(set: HorseshoeSet, alphas: number[] = WAKE_ALPHAS, betas: number[] = WAKE_BETAS) {
        this.count = set.count;
        this.alphas = alphas;
        this.betas = betas;
        const n = set.count;
        this.data = new Float64Array(alphas.length * betas.length * n * n);
        const d = new Float64Array(3);
        const v = new Float64Array(3);
        for (let ia = 0; ia < alphas.length; ia++) {
            for (let ib = 0; ib < betas.length; ib++) {
                wakeDirection(alphas[ia], betas[ib], d);
                const base = (ia * betas.length + ib) * n * n;
                for (let i = 0; i < n; i++) {
                    for (let j = 0; j < n; j++) {
                        v[0] = 0; v[1] = 0; v[2] = 0;
                        addHorseshoeVelocity(
                            set.px[i], set.py[i], set.pz[i],
                            set.ax[j], set.ay[j], set.az[j],
                            set.bx[j], set.by[j], set.bz[j],
                            d[0], d[1], d[2], set.core[j] * set.core[j], v,
                        );
                        if (set.hasImage && set.hasImage[j]) {
                            addHorseshoeVelocity(
                                set.px[i], set.py[i], set.pz[i],
                                set.iax![j], set.iay![j], set.iaz![j],
                                set.ibx![j], set.iby![j], set.ibz![j],
                                d[0], d[1], d[2], set.core[j] * set.core[j], v,
                            );
                        }
                        this.data[base + i * n + j] = v[0] * set.nx[i] + v[1] * set.ny[i] + v[2] * set.nz[i];
                    }
                }
            }
        }
    }

    /** Writes the bilinearly interpolated n×n influence matrix (row = receiver) into `out`. */
    interpolate(alpha: number, beta: number, out: Float64Array): void {
        const n = this.count;
        const nn = n * n;
        const [ia, ta] = bracket(this.alphas, alpha);
        const [ib, tb] = bracket(this.betas, beta);
        const nb = this.betas.length;
        const b00 = (ia * nb + ib) * nn;
        const b01 = (ia * nb + ib + 1) * nn;
        const b10 = ((ia + 1) * nb + ib) * nn;
        const b11 = ((ia + 1) * nb + ib + 1) * nn;
        const w00 = (1 - ta) * (1 - tb), w01 = (1 - ta) * tb, w10 = ta * (1 - tb), w11 = ta * tb;
        const dd = this.data;
        for (let k = 0; k < nn; k++) {
            out[k] = w00 * dd[b00 + k] + w01 * dd[b01 + k] + w10 * dd[b10 + k] + w11 * dd[b11 + k];
        }
    }
}

/** Index of the lower grid point and the fraction towards the next, clamped to the grid. */
function bracket(grid: number[], x: number): [number, number] {
    const last = grid.length - 2;
    if (x <= grid[0]) return [0, 0];
    if (x >= grid[last + 1]) return [last, 1];
    let i = 0;
    while (i < last && x > grid[i + 1]) i++;
    return [i, (x - grid[i]) / (grid[i + 1] - grid[i])];
}

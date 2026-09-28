/**
 * Analytic collider for flat scenery surfaces (runway strip, pavement pads).
 * These meshes are placed a small epsilon above the terrain so they win the
 * depth test; the pad collider makes gear physics rest on the visible surface
 * instead of the terrain below it.
 */

/** Solid surface: an oriented rectangle, optionally sloping along its axis. */
export interface SurfacePadCollider {
    /** World XZ of the pad centre. */
    centerX: number;
    centerZ: number;
    /** Pad heading (rad); 0 = long axis aligned with +Z. */
    heading: number;
    /** Half extent along the pad axis (m). */
    halfLength: number;
    /** Half extent across the pad axis (m). */
    halfWidth: number;
    /** World Y of the surface top, at the pad centre. */
    surfaceY: number;
    /** World Y of the surrounding ground the edge skirt blends down to. */
    baseY: number;
    /** Horizontal skirt width beyond the pad edge (m); avoids a hard vertical lip. */
    feather: number;
    /**
     * Rise in world Y per metre along the pad axis. Absent means level, which
     * every hand-placed apron is.
     *
     * A real runway is not level — ICAO allows 1% along a code 3/4 runway, and
     * the terrain under one is now cut to that slope. It also carries the
     * first-order part of the earth's curvature falling away from the play
     * origin, which over a 3 km strip is metres. What is left is the
     * second-order term, about 0.25 m at a threshold, well inside the epsilon
     * the pavement is lifted by.
     */
    slope?: number;
}

/**
 * Pad surface Y at (worldX, worldZ), or -Infinity when the point is outside
 * the pad footprint (plus its feather skirt). Inside the rectangle this is the
 * pad's own plane; across the skirt it ramps down to `baseY`.
 */
export function sampleSurfacePadY(
    worldX: number,
    worldZ: number,
    pad: SurfacePadCollider,
): number {
    return padY(worldX, worldZ, pad, pad.feather);
}

/** Highest pad surface among colliders, or -Infinity when over none. */
export function sampleSurfacePadYMax(
    worldX: number,
    worldZ: number,
    pads: readonly SurfacePadCollider[],
): number {
    let maxY = -Infinity;
    for (let i = 0; i < pads.length; i++) {
        const y = padY(worldX, worldZ, pads[i], pads[i].feather);
        if (y > maxY) maxY = y;
    }
    return maxY;
}

/**
 * Highest pad surface whose own footprint - not its skirt - holds the point,
 * or -Infinity. The footprint is what is drawn (pavement, a roof); the skirt
 * exists only for the gear, and what is seen there is the terrain.
 */
export function sampleSurfacePadCoreYMax(
    worldX: number,
    worldZ: number,
    pads: readonly SurfacePadCollider[],
): number {
    let maxY = -Infinity;
    for (let i = 0; i < pads.length; i++) {
        const y = padY(worldX, worldZ, pads[i], 0);
        if (y > maxY) maxY = y;
    }
    return maxY;
}

/** Grid cell of {@link SurfacePadIndex}, metres. A runway spans a few dozen. */
const PAD_CELL_M = 256;

const padCellKey = (cx: number, cz: number) => (cx + (1 << 20)) * (1 << 21) + (cz + (1 << 20));

/**
 * The pads of a world, bucketed into a coarse grid so a ground query tests
 * only the few near it. The plain array scan above walked every runway and
 * roof in the area on every contact test of every aircraft, every step - 650
 * runways in DACH before a single building - and airfields streaming in
 * mid-flight only ever add to that. Same answers as the array functions.
 */
export class SurfacePadIndex {
    private readonly list: SurfacePadCollider[] = [];
    private readonly grid = new Map<number, number[]>();

    constructor(pads: readonly SurfacePadCollider[] = []) {
        this.add(pads);
    }

    /** Every pad, in the order added. */
    get pads(): readonly SurfacePadCollider[] {
        return this.list;
    }

    get length(): number {
        return this.list.length;
    }

    add(pads: readonly SurfacePadCollider[]): void {
        for (const pad of pads) {
            this.push(pad);
        }
    }

    push(pad: SurfacePadCollider): void {
        const i = this.list.length;
        this.list.push(pad);
        // Circumscribed radius of footprint plus skirt, so the cells hold
        // the pad at any heading.
        const reach = Math.hypot(pad.halfLength + pad.feather, pad.halfWidth + pad.feather);
        const x0 = Math.floor((pad.centerX - reach) / PAD_CELL_M);
        const x1 = Math.floor((pad.centerX + reach) / PAD_CELL_M);
        const z0 = Math.floor((pad.centerZ - reach) / PAD_CELL_M);
        const z1 = Math.floor((pad.centerZ + reach) / PAD_CELL_M);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cz = z0; cz <= z1; cz++) {
                const k = padCellKey(cx, cz);
                const cell = this.grid.get(k);
                if (cell) {
                    cell.push(i);
                } else {
                    this.grid.set(k, [i]);
                }
            }
        }
    }

    clear(): void {
        this.list.length = 0;
        this.grid.clear();
    }

    /** {@link sampleSurfacePadYMax} over this index. */
    sampleYMax(worldX: number, worldZ: number): number {
        return this.sample(worldX, worldZ, true);
    }

    /** {@link sampleSurfacePadCoreYMax} over this index. */
    sampleCoreYMax(worldX: number, worldZ: number): number {
        return this.sample(worldX, worldZ, false);
    }

    private sample(worldX: number, worldZ: number, skirt: boolean): number {
        const cell = this.grid.get(padCellKey(
            Math.floor(worldX / PAD_CELL_M), Math.floor(worldZ / PAD_CELL_M)));
        let maxY = -Infinity;
        if (cell === undefined) {
            return maxY;
        }
        for (let n = 0; n < cell.length; n++) {
            const pad = this.list[cell[n]];
            const y = padY(worldX, worldZ, pad, skirt ? pad.feather : 0);
            if (y > maxY) maxY = y;
        }
        return maxY;
    }
}

/** {@link sampleSurfacePadY} with the skirt `feather` metres wide; 0 is the footprint alone. */
function padY(worldX: number, worldZ: number, pad: SurfacePadCollider, feather: number): number {
    const cos = Math.cos(pad.heading);
    const sin = Math.sin(pad.heading);
    const dx = worldX - pad.centerX;
    const dz = worldZ - pad.centerZ;
    // World delta into pad local XZ: the inverse of the scene heading convention,
    // where +localZ is (sin h, cos h). heading 0 → identity.
    const localX = dx * cos - dz * sin;
    const localZ = dx * sin + dz * cos;
    const outX = Math.abs(localX) - pad.halfWidth;
    const outZ = Math.abs(localZ) - pad.halfLength;
    const out = Math.max(outX, outZ);
    if (out > 0 && out >= feather) return -Infinity;
    // The surface at *this* point, not at the pad centre: on a sloping runway
    // the two differ by metres, and blending toward the centre's height would
    // step the pavement down at both thresholds.
    const surfaceY = pad.surfaceY + (pad.slope ?? 0) * localZ;
    if (out <= 0) return surfaceY;
    return pad.baseY + (surfaceY - pad.baseY) * (1 - out / feather);
}

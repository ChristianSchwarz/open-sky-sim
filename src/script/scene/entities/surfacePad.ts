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
    const cos = Math.cos(pad.heading);
    const sin = Math.sin(pad.heading);
    const dx = worldX - pad.centerX;
    const dz = worldZ - pad.centerZ;
    // Rotate world delta into pad local XZ (heading 0 → identity).
    const localX = dx * cos + dz * sin;
    const localZ = -dx * sin + dz * cos;
    const outX = Math.abs(localX) - pad.halfWidth;
    const outZ = Math.abs(localZ) - pad.halfLength;
    const out = Math.max(outX, outZ);
    if (out >= pad.feather) return -Infinity;
    // The surface at *this* point, not at the pad centre: on a sloping runway
    // the two differ by metres, and blending toward the centre's height would
    // step the pavement down at both thresholds.
    const surfaceY = pad.surfaceY + (pad.slope ?? 0) * localZ;
    if (out <= 0) return surfaceY;
    return pad.baseY + (surfaceY - pad.baseY) * (1 - out / pad.feather);
}

/** Highest pad surface among colliders, or -Infinity when over none. */
export function sampleSurfacePadYMax(
    worldX: number,
    worldZ: number,
    pads: readonly SurfacePadCollider[],
): number {
    let maxY = -Infinity;
    for (let i = 0; i < pads.length; i++) {
        const y = sampleSurfacePadY(worldX, worldZ, pads[i]);
        if (y > maxY) maxY = y;
    }
    return maxY;
}

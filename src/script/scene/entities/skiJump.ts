/**
 * Carrier-style ski-jump ramp: curved incline along the runway takeoff axis.
 * Surface height is sampled for gear springs via {@link sampleSkiJumpSurfaceY}.
 */

import { NO_SURFACE_Y } from './carrierDeck';

/** Ramp length along takeoff (+Z when heading=0), metres. */
export const SKI_JUMP_LENGTH_M = 90;
/** Tip height above flat deck, metres. */
export const SKI_JUMP_HEIGHT_M = 12;
/** Ramp width across the runway, metres. */
export const SKI_JUMP_WIDTH_M = 48;

/** Analytic ski-jump collider matching the lib:skiJump mesh. */
export interface SkiJumpCollider {
    /** World XZ of the ramp origin (south/base end). */
    originX: number;
    /** World Y of the ramp base (matches the placed mesh). */
    originY: number;
    originZ: number;
    /** Runway heading (rad); 0 = takeoff along +Z. */
    heading: number;
    length: number;
    height: number;
    halfWidth: number;
}

export function createSkiJumpCollider(
    originX: number,
    originY: number,
    originZ: number,
    heading: number,
    length = SKI_JUMP_LENGTH_M,
    height = SKI_JUMP_HEIGHT_M,
    width = SKI_JUMP_WIDTH_M,
): SkiJumpCollider {
    return {
        originX,
        originY,
        originZ,
        heading,
        length,
        height,
        halfWidth: width * 0.5,
    };
}

/**
 * Deck height along the ramp for progress t in [0,1] (0 = base, 1 = tip).
 * Cosine arc: flat derivative at the base, steepest at the tip (~12° for defaults).
 */
export function skiJumpDeckHeight(t: number, height: number): number {
    const u = Math.max(0, Math.min(1, t));
    return height * (1 - Math.cos((Math.PI * 0.5) * u));
}

/**
 * Surface Y of a ski jump at (worldX, worldZ), or 0 if outside the ramp footprint.
 * Local frame: origin at base, +localZ toward tip (takeoff).
 * Returns absolute world Y ({@link SkiJumpCollider.originY} + deck height).
 */
export function sampleSkiJumpSurfaceY(worldX: number, worldZ: number, ramp: SkiJumpCollider): number {
    const cos = Math.cos(ramp.heading);
    const sin = Math.sin(ramp.heading);
    const dx = worldX - ramp.originX;
    const dz = worldZ - ramp.originZ;
    // Rotate world delta into ramp local XZ (heading 0 → identity).
    const localX = dx * cos + dz * sin;
    const localZ = -dx * sin + dz * cos;
    if (localZ < 0 || localZ > ramp.length) {
        return NO_SURFACE_Y;
    }
    if (Math.abs(localX) > ramp.halfWidth) {
        return NO_SURFACE_Y;
    }
    return ramp.originY + skiJumpDeckHeight(localZ / ramp.length, ramp.height);
}

/** Highest ski-jump surface among ramps, or {@link NO_SURFACE_Y}. */
export function sampleSkiJumpSurfaceYMax(
    worldX: number,
    worldZ: number,
    ramps: readonly SkiJumpCollider[],
): number {
    let maxY = NO_SURFACE_Y;
    for (let i = 0; i < ramps.length; i++) {
        const y = sampleSkiJumpSurfaceY(worldX, worldZ, ramps[i]);
        if (y > maxY) maxY = y;
    }
    return maxY;
}

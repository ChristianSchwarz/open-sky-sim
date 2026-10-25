/**
 * Geometry for flying round to a runway's final approach from anywhere: where
 * the aircraft is relative to the runway, and the heading that steers it onto
 * a straight leg or round a turn. Pure functions; the pilot keeps the state.
 *
 * Conventions match the pilot's: heading = atan2(x, z), so 0 flies +Z; a
 * runway's `heading` is its landing direction; "lateral" is the offset along
 * the runway's (cos h, -sin h) axis, which is the side a heading of h + 90 deg
 * flies towards.
 */

const G = 9.81;

/** Where an aircraft is, seen from a runway's touchdown point. */
export interface RunwayFrame {
    /** Distance (m) to the touchdown point along the approach: positive before it, negative past it. */
    toTouchdown: number;
    /** Offset (m) from the extended centreline, along (cos h, -sin h). */
    lateral: number;
    /** Runway heading minus aircraft heading (rad), wrapped to [-pi, pi]. */
    headingError: number;
}

export function runwayFrame(
    touchdownX: number, touchdownZ: number, runwayHeading: number,
    x: number, z: number, heading: number,
): RunwayFrame {
    const fx = Math.sin(runwayHeading);
    const fz = Math.cos(runwayHeading);
    const dx = x - touchdownX;
    const dz = z - touchdownZ;
    return {
        toTouchdown: -(dx * fx + dz * fz),
        lateral: dx * fz - dz * fx,
        headingError: wrapPi(runwayHeading - heading),
    };
}

/** World XZ of a point given in a runway frame (toTouchdown, lateral). */
export function fromRunwayFrame(
    touchdownX: number, touchdownZ: number, runwayHeading: number,
    toTouchdown: number, lateral: number,
): { x: number; z: number } {
    const fx = Math.sin(runwayHeading);
    const fz = Math.cos(runwayHeading);
    return {
        x: touchdownX - fx * toTouchdown + fz * lateral,
        z: touchdownZ - fz * toTouchdown - fx * lateral,
    };
}

/**
 * Heading to join and then hold a straight leg flown on `lineHeading`, from a
 * cross-track offset (m, along the leg's own (cos h, -sin h) axis). The
 * intercept angle grows smoothly with the offset up to `maxIntercept`, reached
 * a few `captureDistance`s out, so the aircraft turns onto the leg rather than
 * crossing it at right angles. Valid from any heading: far out it simply flies
 * at the leg at `maxIntercept`.
 */
export function lineHeading(lineHeading: number, crossTrack: number, captureDistance: number, maxIntercept: number): number {
    return lineHeading - maxIntercept * (2 / Math.PI) * Math.atan(crossTrack / captureDistance);
}

/**
 * Heading to fly round a circle of `radius` about (cx, cz). `direction` +1
 * goes round with the centre on the aircraft's (cos h, -sin h) side, -1 the
 * other way. Off the circle it steers back on, by up to 60 deg.
 */
export function arcHeading(cx: number, cz: number, radius: number, direction: 1 | -1, x: number, z: number): number {
    const dx = x - cx;
    const dz = z - cz;
    const rho = Math.max(1, Math.hypot(dx, dz));
    const ux = dx / rho;
    const uz = dz / rho;
    // Tangent: the radial turned a quarter, the way that keeps the centre on
    // the chosen side.
    const tx = direction > 0 ? uz : -uz;
    const tz = direction > 0 ? -ux : ux;
    const correction = (Math.PI / 3) * (2 / Math.PI) * Math.atan((rho - radius) / (0.5 * radius));
    return Math.atan2(tx, tz) + direction * correction;
}

/** Radius (m) of a level turn at `speed` (m/s) and `bank` (rad). */
export function turnRadius(speed: number, bank: number): number {
    return speed * speed / (G * Math.tan(bank));
}

function wrapPi(a: number): number {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}

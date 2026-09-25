/**
 * The terrain importer's arithmetic, kept free of the DOM and of Angular so it
 * can be unit tested: Web Mercator for the slippy map, and what a selected box
 * would cost to bake.
 */

export const TILE_PX = 256;
export const MIN_ZOOM = 2;
/** Matches OSM_MAX_ZOOM in tools/areaImport.ts. */
export const MAX_ZOOM = 12;
/** Matches --max-span in tools/fetch_planet_dem.py. */
export const MAX_SPAN_DEG = 3;
/** The pyramid's finest level, for estimating what a box will cost to bake. */
export const BAKE_ZOOM = 12;

export interface Box {
    west: number;
    south: number;
    east: number;
    north: number;
}

/** A baked area as /api/areas reports it. Duplicated in tools/areaImport.ts. */
export interface Area extends Box {
    name: string;
}

export function lonToWorld(lon: number, z: number): number {
    return ((lon + 180) / 360) * TILE_PX * (1 << z);
}

export function latToWorld(lat: number, z: number): number {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const s = Math.sin(clamped * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE_PX * (1 << z);
}

export function worldToLon(x: number, z: number): number {
    return (x / (TILE_PX * (1 << z))) * 360 - 180;
}

/**
 * A longitude brought back into [-180, 180). The map draws its tiles wrapped,
 * so panning east past New Zealand keeps rendering, but the world-pixel
 * arithmetic runs on regardless and would otherwise hand out 182 for the
 * Chatham Islands where the bake wants -178.
 */
export function wrapLon(lon: number): number {
    const w = ((lon + 180) % 360 + 360) % 360 - 180;
    return Object.is(w, -0) ? 0 : w;
}

/**
 * A box whose east edge lies past the antimeridian. The bake runs on one
 * WGS84 sheet, so such a box cannot be imported; it is kept unwrapped
 * (west in range, east above 180) so it still draws as one rectangle.
 */
export function crossesAntimeridian(b: Box): boolean {
    return b.east > 180;
}

export function worldToLat(y: number, z: number): number {
    const n = Math.PI - 2 * Math.PI * y / (TILE_PX * (1 << z));
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Rough ground size of a box, for the readout. */
function boxKm(b: Box): { w: number; h: number } {
    const midLat = (b.south + b.north) / 2;
    return {
        w: (b.east - b.west) * 111.32 * Math.cos(midLat * Math.PI / 180),
        h: (b.north - b.south) * 110.57,
    };
}

/** The larger side of a box in degrees, which is what the bake's limit is on. */
export function boxSpanDeg(b: Box): number {
    return Math.max(b.east - b.west, b.north - b.south);
}

/** How many z12 terrain tiles the bake will touch — the cost that matters. */
export function bakeTiles(b: Box): number {
    const span = 180 / (1 << BAKE_ZOOM);
    const nx = Math.ceil((b.east + 180) / span) - Math.floor((b.west + 180) / span);
    const ny = Math.ceil((90 - b.south) / span) - Math.floor((90 - b.north) / span);
    return Math.max(1, nx) * Math.max(1, ny);
}

/**
 * Why Import is unavailable, or undefined when it is ready.
 *
 * A greyed-out button with no reason is a guessing game, and two of these
 * are easy to hit without realising: the name field shows a placeholder
 * that reads like a value, and a box is only drawn while Shift is held.
 */
export function blockedReason(running: boolean, selection: Box | undefined, name: string): string | undefined {
    if (running) {
        return 'import running';
    }
    if (!selection) {
        return 'shift-drag on the map to choose an area';
    }
    const span = boxSpanDeg(selection);
    if (span > MAX_SPAN_DEG) {
        return `too big — ${span.toFixed(2)}° exceeds the ${MAX_SPAN_DEG}° limit`;
    }
    if (crossesAntimeridian(selection)) {
        return 'crosses the antimeridian — keep the box on one side of 180°';
    }
    if (name.trim().length === 0) {
        return 'type a name for the area';
    }
    return undefined;
}

/** "west,south .. east,north — 40 x 30 km, ~12 terrain tiles" */
export function describeBox(b: Box): string {
    const km = boxKm(b);
    const where = `${b.west.toFixed(4)},${b.south.toFixed(4)} .. `
        + `${b.east.toFixed(4)},${b.north.toFixed(4)}`;
    return `${where}  —  ${km.w.toFixed(0)} x ${km.h.toFixed(0)} km, ~${bakeTiles(b)} terrain tiles`;
}

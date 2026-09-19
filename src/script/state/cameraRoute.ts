/**
 * A fixed camera placed from the page URL.
 *
 * `?lat=45.93&lng=6.87&alt=2500&hdg=150&pitch=-5` (the same parameters work
 * after a `#`): degrees north, degrees east, metres above the ellipsoid,
 * bearing in degrees clockwise from north, and pitch in degrees with up
 * positive. Latitude and longitude are required; altitude defaults to 1000
 * m, heading and pitch to north and level. The sim stays paused; Escape
 * leaves the view for the spawn menu.
 */
export interface CameraRoute {
    lat: number;
    lon: number;
    altM: number;
    headingDeg: number;
    pitchDeg: number;
}

/** Query parameter names, in the order they are written. */
const CAMERA_ROUTE_PARAMS = ['lat', 'lng', 'alt', 'hdg', 'pitch'] as const;
const DEFAULT_ALT_M = 1000;
const PITCH_LIMIT_DEG = 89;

function stripHash(hash: string): string {
    return hash.startsWith('#') ? hash.slice(1) : hash;
}

function params(search: string, hash: string): URLSearchParams {
    const query = new URLSearchParams(search);
    const fragment = new URLSearchParams(stripHash(hash));
    for (const [k, v] of fragment) {
        if (!query.has(k)) {
            query.set(k, v);
        }
    }
    return query;
}

function num(p: URLSearchParams, key: string): number | undefined {
    const raw = p.get(key);
    if (raw === null || raw.trim() === '') {
        return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
}

/** The route in `search`/`hash`, or undefined when absent or malformed. */
export function parseCameraRoute(search: string, hash: string = ''): CameraRoute | undefined {
    const p = params(search, hash);
    const lat = num(p, 'lat');
    const lon = num(p, 'lng');
    if (lat === undefined || lon === undefined) {
        return undefined;
    }
    const altM = num(p, 'alt') ?? DEFAULT_ALT_M;
    const headingDeg = num(p, 'hdg') ?? 0;
    const pitchDeg = num(p, 'pitch') ?? 0;
    if ([lat, lon, altM, headingDeg, pitchDeg].some(n => !Number.isFinite(n))) {
        return undefined;
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return undefined;
    }
    const heading = ((headingDeg % 360) + 360) % 360;
    const pitch = Math.max(-PITCH_LIMIT_DEG, Math.min(PITCH_LIMIT_DEG, pitchDeg));
    return { lat, lon, altM, headingDeg: heading === 0 ? 0 : heading, pitchDeg: pitch === 0 ? 0 : pitch };
}

/** The route's parameter values, in {@link CAMERA_ROUTE_PARAMS} order. */
export function formatCameraRoute(route: CameraRoute): string[] {
    const fix = (n: number, digits: number) => (+n.toFixed(digits)).toString();
    return [fix(route.lat, 5), fix(route.lon, 5), fix(route.altM, 0), fix(route.headingDeg, 0), fix(route.pitchDeg, 0)];
}

/**
 * The page's query with the route's parameters set, written as-is: the values
 * are digits, dots and minus signs, and a URL that reads `lat=45.93&lng=6.87`
 * is the point, not a percent-encoded one. Other parameters are kept.
 */
export function searchWithCameraRoute(search: string, route: CameraRoute): string {
    const query = search.startsWith('?') ? search.slice(1) : search;
    const ours = new Set<string>(CAMERA_ROUTE_PARAMS);
    const kept = query
        ? query.split('&').filter(p => p.length > 0 && !ours.has(p.split('=', 1)[0]))
        : [];
    const values = formatCameraRoute(route);
    const entries = CAMERA_ROUTE_PARAMS.map((k, i) => `${k}=${values[i]}`);
    return `?${[...entries, ...kept].join('&')}`;
}

/** Rewrite the page URL's camera parameters without a navigation or history entry. */
export function writeCameraRouteToLocation(route: CameraRoute): void {
    if (typeof window === 'undefined') {
        return;
    }
    const { search, hash, pathname } = window.location;
    const next = searchWithCameraRoute(search, route);
    // The fragment form is read too; the query is the one written back.
    const fragment = new URLSearchParams(stripHash(hash));
    for (const k of CAMERA_ROUTE_PARAMS) {
        fragment.delete(k);
    }
    const rest = fragment.toString();
    const nextHash = rest === stripHash(hash) ? hash : (rest ? `#${rest}` : '');
    if (next === search && nextHash === hash) {
        return;
    }
    window.history.replaceState(window.history.state, '', `${pathname}${next}${nextHash}`);
}

/** The current page's route, if it has one. */
export function cameraRouteFromLocation(): CameraRoute | undefined {
    if (typeof window === 'undefined') {
        return undefined;
    }
    return parseCameraRoute(window.location.search, window.location.hash);
}

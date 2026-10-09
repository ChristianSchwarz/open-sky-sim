/**
 * A fixed camera placed from the page URL.
 *
 * Written the way Google Maps writes a 3D view after its `/maps/`:
 * `?@45.93,6.87,2500a,150h,85t` (the same works after a `#`). Latitude and
 * longitude in degrees come first, then suffixed values: `a` metres above
 * the ellipsoid (`m` is read the same), `h` bearing in degrees clockwise
 * from north, `t` tilt in degrees with 0 straight down and 90 at the
 * horizon. Google's other suffixes (`y` field of view, `z` zoom, `d`, `r`)
 * are accepted and ignored, so the `@...` part of a Maps URL can be pasted
 * as is. Latitude and longitude are required; altitude defaults to 1000 m,
 * heading and tilt to north and level, where Maps would look straight down.
 *
 * The older `?lat=45.93&lng=6.87&alt=2500&hdg=150&pitch=-5` form, pitch
 * being `t - 90`, is still read. The sim stays paused; Escape leaves the
 * view for the spawn menu.
 */
export interface CameraRoute {
    lat: number;
    lon: number;
    altM: number;
    headingDeg: number;
    pitchDeg: number;
}

/** The older named parameters, still read and dropped when the URL is rewritten. */
const LEGACY_PARAMS = ['lat', 'lng', 'alt', 'hdg', 'pitch'] as const;
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

/** A parameter of ours: an `@` view or one of the legacy names. */
function isRouteParam(key: string): boolean {
    return key.startsWith('@') || (LEGACY_PARAMS as readonly string[]).includes(key);
}

function num(p: URLSearchParams, key: string): number | undefined {
    const raw = p.get(key);
    if (raw === null || raw.trim() === '') {
        return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
}

interface RawRoute {
    lat: number;
    lon: number;
    altM?: number;
    headingDeg?: number;
    pitchDeg?: number;
}

/** `@lat,lng,2500a,150h,85t` as Google Maps writes it, or undefined. */
function parseAtView(view: string): RawRoute | undefined {
    // A pasted Maps URL may carry its `/data=...` path segment along.
    const [latRaw, lonRaw, ...rest] = view.replace(/^@/, '').split('/', 1)[0].split(',');
    if (latRaw === undefined || lonRaw === undefined || latRaw.trim() === '' || lonRaw.trim() === '') {
        return undefined;
    }
    const route: RawRoute = { lat: Number(latRaw), lon: Number(lonRaw) };
    for (const token of rest) {
        const m = /^\s*([-+]?\d*\.?\d+)([a-z])\s*$/i.exec(token);
        if (!m) {
            return undefined;
        }
        const value = Number(m[1]);
        switch (m[2].toLowerCase()) {
            case 'a':
            case 'm':
                route.altM = value;
                break;
            case 'h':
                route.headingDeg = value;
                break;
            case 't':
                route.pitchDeg = value - 90;
                break;
        }
    }
    return route;
}

function parseLegacy(p: URLSearchParams): RawRoute | undefined {
    const lat = num(p, 'lat');
    const lon = num(p, 'lng');
    if (lat === undefined || lon === undefined) {
        return undefined;
    }
    return { lat, lon, altM: num(p, 'alt'), headingDeg: num(p, 'hdg'), pitchDeg: num(p, 'pitch') };
}

/** The route in `search`/`hash`, or undefined when absent or malformed. */
export function parseCameraRoute(search: string, hash: string = ''): CameraRoute | undefined {
    const p = params(search, hash);
    const view = [...p.keys()].find(k => k.startsWith('@'));
    const raw = view !== undefined ? parseAtView(view) : parseLegacy(p);
    if (!raw) {
        return undefined;
    }
    const { lat, lon } = raw;
    const altM = raw.altM ?? DEFAULT_ALT_M;
    const headingDeg = raw.headingDeg ?? 0;
    const pitchDeg = raw.pitchDeg ?? 0;
    if ([lat, lon, altM, headingDeg, pitchDeg].some(n => !Number.isFinite(n))) {
        return undefined;
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return undefined;
    }
    const heading = headingDeg >= 0 && headingDeg < 360 ? headingDeg : ((headingDeg % 360) + 360) % 360;
    const pitch = Math.max(-PITCH_LIMIT_DEG, Math.min(PITCH_LIMIT_DEG, pitchDeg));
    return { lat, lon, altM, headingDeg: heading === 0 ? 0 : heading, pitchDeg: pitch === 0 ? 0 : pitch };
}

/** The route as Google Maps writes a view, `@45.93,6.87,2500a,150h,85t`. */
export function formatCameraRoute(route: CameraRoute): string {
    const fix = (n: number, digits: number) => (+n.toFixed(digits)).toString();
    return `@${fix(route.lat, 5)},${fix(route.lon, 5)},${fix(route.altM, 0)}a,`
        + `${fix(route.headingDeg, 0)}h,${fix(route.pitchDeg + 90, 0)}t`;
}

/**
 * The page's query with the route set, written as-is: `@` and `,` are legal
 * in a query, and a URL that reads like a Maps one is the point, not a
 * percent-encoded one. Other parameters are kept; any earlier route, in
 * either form, is replaced.
 */
export function searchWithCameraRoute(search: string, route: CameraRoute): string {
    const query = search.startsWith('?') ? search.slice(1) : search;
    const kept = query
        ? query.split('&').filter(p => p.length > 0 && !isRouteParam(decodeKey(p.split('=', 1)[0])))
        : [];
    return `?${[formatCameraRoute(route), ...kept].join('&')}`;
}

function decodeKey(key: string): string {
    try {
        return decodeURIComponent(key.replace(/\+/g, ' '));
    } catch {
        return key;
    }
}

/** `params` without our route, in either form. */
function withoutRoute(p: URLSearchParams): string {
    for (const k of [...p.keys()]) {
        if (isRouteParam(k)) {
            p.delete(k);
        }
    }
    return p.toString();
}

/** Rewrite the page URL's camera route without a navigation or history entry. */
export function writeCameraRouteToLocation(route: CameraRoute): void {
    if (typeof window === 'undefined') {
        return;
    }
    const { search, hash, pathname } = window.location;
    const next = searchWithCameraRoute(search, route);
    // The fragment form is read too; the query is the one written back.
    const rest = withoutRoute(new URLSearchParams(stripHash(hash)));
    const fragmentHadRoute = [...new URLSearchParams(stripHash(hash)).keys()].some(isRouteParam);
    const nextHash = !fragmentHadRoute ? hash : (rest ? `#${rest}` : '');
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

/**
 * Drop the URL's camera route, if any.
 *
 * A previous spawn or fixed-camera view leaves `@lat,lng,...` in the URL so
 * a reload or copied link lands back on it (see `writeCameraRouteToLocation`).
 * That same stickiness fights the area picker: without this, choosing a new
 * area and flying there would still boot into whatever area the leftover
 * coordinates fall in, silently ignoring the pick.
 */
export function clearCameraRouteFromLocation(): void {
    if (typeof window === 'undefined') {
        return;
    }
    const { search, hash, pathname } = window.location;
    const nextSearch = withoutRoute(new URLSearchParams(search));
    const nextHash = withoutRoute(new URLSearchParams(stripHash(hash)));
    window.history.replaceState(
        window.history.state, '',
        `${pathname}${nextSearch ? `?${nextSearch}` : ''}${nextHash ? `#${nextHash}` : ''}`,
    );
}

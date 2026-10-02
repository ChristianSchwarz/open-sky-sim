/**
 * Finding somewhere to start a flight: an airfield by ICAO, IATA or name, a
 * place by name, or a bare coordinate.
 *
 * Airfields are searched locally, across every baked area — the airfields file
 * holds them all, tagged with their area. Places are geocoded through OSM's
 * Nominatim, which is a shared public service: it is asked only when the
 * player submits a search, never per keystroke (its usage policy forbids
 * client-side autocomplete), and at most once per second.
 *
 * Whatever is found is checked against the baked areas, because the sim can
 * only start where there is terrain. A hit outside all of them is still
 * listed, so a search that finds the place but has nowhere to put it says so
 * instead of looking like it found nothing.
 */

import type { Airfield } from '../terrain/airfields';
import type { TerrainArea } from '../terrain/manifest';
import { areaContains } from '../terrain/playArea';

/** One airfield as the search sees it. */
export interface AirfieldEntry {
    icao: string;
    iata: string;
    name: string;
    area: string;
    lat: number;
    lon: number;
    /** Longest runway, m. */
    lengthM: number;
}

export function airfieldEntryOf(airfield: Airfield): AirfieldEntry {
    return {
        icao: airfield.icao,
        iata: airfield.iata ?? '',
        name: airfield.name,
        area: airfield.area,
        lat: airfield.lat,
        lon: airfield.lon,
        lengthM: airfield.runways.reduce((m, r) => Math.max(m, r.lengthM), 0),
    };
}

/** Somewhere a flight can be started from, or found but not startable. */
export interface SpawnDestination {
    kind: 'airfield' | 'place' | 'coordinates';
    /** First line: the name. */
    label: string;
    /** Second line: identifiers, area, what kind of place. */
    detail: string;
    lat: number;
    lon: number;
    /** Baked area holding it; undefined when there is no terrain there. */
    area: string | undefined;
    /** For an airfield, the key the spawn picker uses (`icao || name`). */
    airfieldKey?: string;
}

/** The key an airfield is chosen by everywhere else: `icao || name`. */
export function airfieldKey(entry: { icao: string; name: string }): string {
    return entry.icao || entry.name;
}

/** The baked area holding a point, if any. First one wins where they overlap. */
export function areaAt(areas: readonly TerrainArea[], lat: number, lon: number): string | undefined {
    return areas.find(a => areaContains(a, lat, lon))?.name;
}

function fold(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * How well an airfield matches; 0 for not at all. Identifiers beat names, a
 * whole identifier beats a prefix, a word start in the name beats the middle
 * of a word.
 */
function airfieldScore(entry: AirfieldEntry, words: readonly string[], whole: string): number {
    const icao = entry.icao.toLowerCase();
    const iata = entry.iata.toLowerCase();
    if (whole === icao || whole === iata) {
        return 1000;
    }
    const name = fold(entry.name);
    const hay = `${icao} ${iata} ${name}`;
    let score = 0;
    for (const word of words) {
        if (!hay.includes(word)) {
            return 0;
        }
        if (icao.startsWith(word) || iata.startsWith(word)) {
            score += 50;
        } else if (name.startsWith(word) || name.includes(` ${word}`) || name.includes(`-${word}`)) {
            score += 20;
        } else {
            score += 5;
        }
    }
    return score;
}

/**
 * Airfields matching `query`, best first; ties go to the longer runway, which
 * is the one more likely meant. Every word has to appear somewhere.
 */
export function searchAirfields(
    entries: readonly AirfieldEntry[], query: string, limit = 12,
): AirfieldEntry[] {
    const whole = fold(query.trim());
    const words = whole.split(/[\s,]+/).filter(w => w.length > 0);
    if (words.length === 0) {
        return [];
    }
    return entries
        .map(entry => ({ entry, score: airfieldScore(entry, words, whole) }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score || b.entry.lengthM - a.entry.lengthM)
        .slice(0, limit)
        .map(s => s.entry);
}

/**
 * A coordinate typed as `lat, lon` (or with a space between), in decimal
 * degrees, optionally with N/S/E/W suffixes. Undefined for anything else.
 */
export function parseCoordinates(query: string): { lat: number; lon: number } | undefined {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?\s*$/i
        .exec(query);
    if (m === null) {
        return undefined;
    }
    let lat = Number(m[1]);
    let lon = Number(m[3]);
    if (m[2]?.toUpperCase() === 'S') {
        lat = -lat;
    }
    if (m[4]?.toUpperCase() === 'W') {
        lon = -lon;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        return undefined;
    }
    return { lat, lon };
}

export function airfieldDestination(entry: AirfieldEntry, currentArea: string): SpawnDestination {
    const ids = [entry.icao, entry.iata].filter(id => id.length > 0).join(' / ');
    const where = entry.area === currentArea ? '' : ` · ${entry.area} (reloads)`;
    return {
        kind: 'airfield',
        label: entry.name || entry.icao || 'Unnamed airfield',
        detail: `${ids ? `${ids} · ` : ''}${Math.round(entry.lengthM)} m runway${where}`,
        lat: entry.lat,
        lon: entry.lon,
        area: entry.area,
        airfieldKey: airfieldKey(entry),
    };
}

/** Where a found point is, for the second line. */
function locationDetail(area: string | undefined, currentArea: string, prefix: string): string {
    if (area === undefined) {
        return `${prefix}no terrain baked here`;
    }
    return area === currentArea ? `${prefix}fly here` : `${prefix}${area} (reloads)`;
}

export function coordinateDestination(
    lat: number, lon: number, areas: readonly TerrainArea[], currentArea: string,
): SpawnDestination {
    const area = areaAt(areas, lat, lon);
    return {
        kind: 'coordinates',
        label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
        detail: locationDetail(area, currentArea, 'Coordinates · '),
        lat,
        lon,
        area,
    };
}

/** The fields of a Nominatim `jsonv2` result this reads. */
interface NominatimPlace {
    lat: string;
    lon: string;
    name?: string;
    display_name: string;
    type?: string;
    addresstype?: string;
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
/** Nominatim's usage policy: an absolute maximum of one request per second. */
const NOMINATIM_MIN_INTERVAL_MS = 1100;
let lastNominatimAt = 0;

export function placesFromNominatim(
    results: readonly NominatimPlace[], areas: readonly TerrainArea[], currentArea: string,
): SpawnDestination[] {
    const out: SpawnDestination[] = [];
    for (const r of results) {
        const lat = Number(r.lat);
        const lon = Number(r.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            continue;
        }
        const area = areaAt(areas, lat, lon);
        // display_name repeats the name first; the rest is the context.
        const parts = r.display_name.split(', ');
        const label = r.name || parts[0] || r.display_name;
        const context = parts.slice(r.name && parts[0] === r.name ? 1 : 0).slice(-3).join(', ');
        const kind = (r.addresstype ?? r.type ?? '').replace(/_/g, ' ');
        out.push({
            kind: 'place',
            label,
            detail: locationDetail(area, currentArea,
                [kind, context].filter(s => s.length > 0).join(' · ') + ' · '),
            lat,
            lon,
            area,
        });
    }
    // Startable first, the geocoder's own ranking within each group.
    return [
        ...out.filter(d => d.area !== undefined),
        ...out.filter(d => d.area === undefined),
    ];
}

/** Geocode a place name. Rejects on a network or HTTP failure. */
export async function searchPlaces(
    query: string, areas: readonly TerrainArea[], currentArea: string,
    fetchFn: typeof fetch = fetch,
): Promise<SpawnDestination[]> {
    const q = query.trim();
    if (q.length === 0) {
        return [];
    }
    const wait = lastNominatimAt + NOMINATIM_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, wait));
    }
    lastNominatimAt = Date.now();
    const url = `${NOMINATIM_URL}?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`;
    const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
        throw new Error(`place search failed: HTTP ${res.status}`);
    }
    return placesFromNominatim(await res.json() as NominatimPlace[], areas, currentArea);
}

/**
 * A destination in another area outlives a page reload: the world is built
 * around one area's origin, so getting to another means rebooting into it
 * (see the World tab's "Fly here"), and the boot then needs to know where in
 * it to start. Session storage, so it cannot leak into a later visit.
 */
const PENDING_KEY = 'rfs.pendingSpawn';

export function savePendingDestination(dest: SpawnDestination): void {
    try {
        sessionStorage.setItem(PENDING_KEY, JSON.stringify(dest));
    } catch {
        // No storage: the reload lands at the area's default start instead.
    }
}

/** The destination saved before a reload, removed as it is read. */
export function takePendingDestination(): SpawnDestination | undefined {
    try {
        const raw = sessionStorage.getItem(PENDING_KEY);
        sessionStorage.removeItem(PENDING_KEY);
        if (raw === null) {
            return undefined;
        }
        const dest = JSON.parse(raw) as SpawnDestination;
        return Number.isFinite(dest.lat) && Number.isFinite(dest.lon) ? dest : undefined;
    } catch {
        return undefined;
    }
}

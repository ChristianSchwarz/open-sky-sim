/**
 * LVR1 / LVR2 / LVR3 OSM water-vector tile decode.
 *
 * Bake-time only. The runtime never reads coastline vectors any more — the
 * shoreline is cut offline and baked into the mesh.
 *
 * LVR2 adds a second polygon layer: inland water, each body carrying the
 * surface height it should be baked at. LVR3 adds a third, which is not
 * polygons at all: watercourse centrelines with a true width on them, for the
 * rivers and canals too narrow for the node grid to hold. LVR1 is still
 * emitted for the great majority of tiles — the ones with no lake and no river
 * in them — and still decodes here, so all three coexist on disk indefinitely.
 */

import { unzlibSync } from 'fflate';

export const LVR_MAGIC = 0x3152564c; // 'LVR1' little-endian
export const LVR2_MAGIC = 0x3252564c; // 'LVR2' little-endian
export const LVR3_MAGIC = 0x3352564c; // 'LVR3' little-endian
export const LVR4_MAGIC = 0x3452564c; // 'LVR4' little-endian
export const LVR5_MAGIC = 0x3552564c; // 'LVR5' little-endian

/** No OSM landuse tag on this region — bare land, or water. */
export const REGION_CLASS_NONE = 0xff;

export interface LonLat {
    lon: number;
    lat: number;
}

export interface CoastPolygon {
    /** Outer ring (lon, lat), closed or open — treated as closed. */
    exterior: LonLat[];
    /** Interior rings (holes), same winding as baked by tools/bake_osm_coast.py. */
    holes: LonLat[][];
}

/**
 * One inland water body, clipped to this tile.
 *
 * `surfaceHeightM` is undefined for flowing water — a river descends across a
 * tile, so it follows the DEM per-node instead of sitting at one height — and
 * also for any body the coast bake could not measure, which is treated the
 * same way. Undefined is therefore "follow the terrain", never "sea level".
 */
export interface InlandBody {
    exterior: LonLat[];
    holes: LonLat[][];
    surfaceHeightM: number | undefined;
    /**
     * Surface height along the river through a flowing body, in lon/lat/metres.
     * Set only on LVR5 tiles, and only where the bake could fit a descent to
     * the DEM; a body without it follows the DEM per node.
     */
    profile?: RiverSample[];
}

/** One point of a river's fitted surface. */
export interface RiverSample {
    lon: number;
    lat: number;
    heightM: number;
}

/**
 * One river or canal, as a centreline and the width it really is.
 *
 * A line, not a polygon, because that is the only form a narrow watercourse
 * survives in: cut into the terrain it has to span a couple of grid cells to
 * land on a node at all, and a 12 m canal is under one cell at Potsdam z12.
 * The mesh bake drapes it over the surface and the renderer strokes it, so the
 * width it is drawn at can be a screen decision rather than a bake one.
 */
export interface Watercourse {
    /** True width on the ground, metres. */
    widthM: number;
    /** Centreline, clipped to this tile. Two points or more. */
    points: LonLat[];
}

/**
 * One piece of a combined land/water + landuse partition, clipped to this
 * tile: `isLand` is the strict base layer (a region never claims water area),
 * `landuseClass` is the OSM tag that won this piece, or undefined for bare
 * land or water with no tag. Regions are non-overlapping by construction —
 * the overlap between real OSM polygons is already resolved before baking.
 */
export interface LanduseRegion {
    exterior: LonLat[];
    holes: LonLat[][];
    isLand: boolean;
    landuseClass: number | undefined;
}

export interface CoastVectorTile {
    polygons: CoastPolygon[];
    /** Empty for an LVR1 tile, which cannot carry inland water. */
    inland: InlandBody[];
    /** Empty below LVR3, which is where watercourse centrelines start. */
    watercourses: Watercourse[];
    /** Empty below LVR4, which is where combined land+landuse regions start. */
    regions: LanduseRegion[];
}

/**
 * Decode a zlib-compressed LVR1 blob into a CoastVectorTile.
 * Accepts either the raw compressed bytes or an already-inflated payload.
 */
export function decodeLvr(bytes: ArrayBuffer | Uint8Array): CoastVectorTile {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // 'LVR' plus a version digit means the payload arrived already inflated.
    const bare = raw.byteLength >= 4
        && raw[0] === 0x4c && raw[1] === 0x56 && raw[2] === 0x52
        && (raw[3] >= 0x31 && raw[3] <= 0x35);
    const payload = bare ? raw : unzlibSync(raw);
    if (payload.byteLength < 6) {
        throw new Error(`LVR too short: ${payload.byteLength}`);
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== LVR_MAGIC && magic !== LVR2_MAGIC && magic !== LVR3_MAGIC && magic !== LVR4_MAGIC
        && magic !== LVR5_MAGIC) {
        throw new Error(`Bad LVR magic: 0x${magic.toString(16)}`);
    }
    let offset = 4;

    const readRings = (what: string): LonLat[][] => {
        if (offset + 2 > payload.byteLength) {
            throw new Error(`LVR truncated before ${what}`);
        }
        const ringCount = view.getUint16(offset, true);
        offset += 2;
        const rings: LonLat[][] = [];
        for (let r = 0; r < ringCount; r++) {
            if (offset + 2 > payload.byteLength) {
                throw new Error(`LVR truncated at ring ${r} of ${what}`);
            }
            const vertCount = view.getUint16(offset, true);
            offset += 2;
            const ring: LonLat[] = [];
            for (let v = 0; v < vertCount; v++) {
                if (offset + 8 > payload.byteLength) {
                    throw new Error(`LVR truncated at vertex ${v} of ring ${r} of ${what}`);
                }
                ring.push({
                    lon: view.getFloat32(offset, true),
                    lat: view.getFloat32(offset + 4, true),
                });
                offset += 8;
            }
            rings.push(ring);
        }
        return rings;
    };

    const polyCount = view.getUint16(offset, true);
    offset += 2;
    const polygons: CoastPolygon[] = [];
    for (let p = 0; p < polyCount; p++) {
        const rings = readRings(`polygon ${p}`);
        if (rings.length > 0) {
            polygons.push({ exterior: rings[0], holes: rings.slice(1) });
        }
    }

    const inland: InlandBody[] = [];
    // Index in the file, so the profile section (one entry per body as
    // written) still lines up when a body with no rings is skipped.
    const inlandByIndex: Array<InlandBody | undefined> = [];
    if (magic >= LVR2_MAGIC && magic <= LVR5_MAGIC) {
        if (offset + 2 > payload.byteLength) {
            throw new Error('LVR2 truncated before the inland layer');
        }
        const bodyCount = view.getUint16(offset, true);
        offset += 2;
        for (let b = 0; b < bodyCount; b++) {
            if (offset + 4 > payload.byteLength) {
                throw new Error(`LVR2 truncated at inland body ${b}`);
            }
            const height = view.getFloat32(offset, true);
            offset += 4;
            const rings = readRings(`inland body ${b}`);
            if (rings.length === 0) {
                inlandByIndex.push(undefined);
                continue;
            }
            const body: InlandBody = {
                exterior: rings[0],
                holes: rings.slice(1),
                // NaN is the bake saying "no single height here, follow the DEM".
                surfaceHeightM: Number.isNaN(height) ? undefined : height,
            };
            inland.push(body);
            inlandByIndex.push(body);
        }
    }

    const watercourses: Watercourse[] = [];
    if (magic >= LVR3_MAGIC && magic <= LVR5_MAGIC) {
        if (offset + 2 > payload.byteLength) {
            throw new Error('LVR3 truncated before the watercourse layer');
        }
        const lineCount = view.getUint16(offset, true);
        offset += 2;
        for (let l = 0; l < lineCount; l++) {
            if (offset + 6 > payload.byteLength) {
                throw new Error(`LVR3 truncated at watercourse ${l}`);
            }
            const widthM = view.getFloat32(offset, true);
            offset += 4;
            const pointCount = view.getUint16(offset, true);
            offset += 2;
            const points: LonLat[] = [];
            for (let v = 0; v < pointCount; v++) {
                if (offset + 8 > payload.byteLength) {
                    throw new Error(`LVR3 truncated at point ${v} of watercourse ${l}`);
                }
                points.push({
                    lon: view.getFloat32(offset, true),
                    lat: view.getFloat32(offset + 4, true),
                });
                offset += 8;
            }
            // A single point is not a stroke. Dropped rather than rejected:
            // a clip that grazes a tile corner can legitimately produce one.
            if (points.length >= 2) {
                watercourses.push({ widthM, points });
            }
        }
    }

    const regions: LanduseRegion[] = [];
    if (magic >= LVR4_MAGIC && magic <= LVR5_MAGIC) {
        if (offset + 2 > payload.byteLength) {
            throw new Error('LVR4 truncated before the region layer');
        }
        const regionCount = view.getUint16(offset, true);
        offset += 2;
        for (let g = 0; g < regionCount; g++) {
            if (offset + 2 > payload.byteLength) {
                throw new Error(`LVR4 truncated at region ${g}`);
            }
            const isLand = payload[offset] !== 0;
            const cls = payload[offset + 1];
            offset += 2;
            const rings = readRings(`region ${g}`);
            if (rings.length === 0) {
                continue;
            }
            regions.push({
                exterior: rings[0],
                holes: rings.slice(1),
                isLand,
                landuseClass: cls === REGION_CLASS_NONE ? undefined : cls,
            });
        }
    }

    if (magic === LVR5_MAGIC) {
        for (const body of inlandByIndex) {
            if (offset + 2 > payload.byteLength) {
                throw new Error('LVR5 truncated before a river profile');
            }
            const count = view.getUint16(offset, true);
            offset += 2;
            if (offset + count * 12 > payload.byteLength) {
                throw new Error('LVR5 truncated inside a river profile');
            }
            const samples: RiverSample[] = [];
            for (let k = 0; k < count; k++) {
                samples.push({
                    lon: view.getFloat32(offset, true),
                    lat: view.getFloat32(offset + 4, true),
                    heightM: view.getFloat32(offset + 8, true),
                });
                offset += 12;
            }
            if (body !== undefined && samples.length > 0) {
                body.profile = samples;
            }
        }
    }

    return { polygons, inland, watercourses, regions };
}

/** Encode an uncompressed LVR1/LVR2/LVR3/LVR4 payload (used by tests). */
export function encodeLvrUncompressed(
    polygons: CoastPolygon[],
    inland: InlandBody[] = [],
    watercourses: Watercourse[] = [],
    regions: LanduseRegion[] = [],
): Uint8Array {
    let byteLen = 6;
    for (const poly of polygons) {
        byteLen += 2;
        byteLen += (1 + poly.holes.length) * 2;
        for (const ring of [poly.exterior, ...poly.holes]) {
            byteLen += 2 + ring.length * 8;
        }
    }
    const profiled = inland.some(b => (b.profile?.length ?? 0) > 0);
    const layered = inland.length > 0 || watercourses.length > 0 || regions.length > 0;
    const withLines = watercourses.length > 0 || regions.length > 0 || profiled;
    const withRegions = regions.length > 0 || profiled;
    if (layered) {
        byteLen += 2;
        for (const body of inland) {
            byteLen += 4 + 2 + (1 + body.holes.length) * 2;
            for (const ring of [body.exterior, ...body.holes]) {
                byteLen += ring.length * 8;
            }
        }
    }
    if (withLines) {
        byteLen += 2;
        for (const course of watercourses) {
            byteLen += 4 + 2 + course.points.length * 8;
        }
    }
    if (profiled) {
        for (const body of inland) {
            byteLen += 2 + (body.profile?.length ?? 0) * 12;
        }
    }
    if (withRegions) {
        byteLen += 2;
        for (const region of regions) {
            byteLen += 2 + 2 + (1 + region.holes.length) * 2;
            for (const ring of [region.exterior, ...region.holes]) {
                byteLen += ring.length * 8;
            }
        }
    }
    const out = new Uint8Array(byteLen);
    const view = new DataView(out.buffer);
    const magic = profiled ? LVR5_MAGIC : regions.length > 0
        ? LVR4_MAGIC
        : (watercourses.length > 0 ? LVR3_MAGIC : (layered ? LVR2_MAGIC : LVR_MAGIC));
    view.setUint32(0, magic, true);
    view.setUint16(4, polygons.length, true);
    let offset = 6;
    for (const poly of polygons) {
        view.setUint16(offset, 1 + poly.holes.length, true);
        offset += 2;
        for (const ring of [poly.exterior, ...poly.holes]) {
            view.setUint16(offset, ring.length, true);
            offset += 2;
            for (const pt of ring) {
                view.setFloat32(offset, pt.lon, true);
                view.setFloat32(offset + 4, pt.lat, true);
                offset += 8;
            }
        }
    }
    if (layered) {
        view.setUint16(offset, inland.length, true);
        offset += 2;
        for (const body of inland) {
            view.setFloat32(offset, body.surfaceHeightM ?? NaN, true);
            offset += 4;
            view.setUint16(offset, 1 + body.holes.length, true);
            offset += 2;
            for (const ring of [body.exterior, ...body.holes]) {
                view.setUint16(offset, ring.length, true);
                offset += 2;
                for (const pt of ring) {
                    view.setFloat32(offset, pt.lon, true);
                    view.setFloat32(offset + 4, pt.lat, true);
                    offset += 8;
                }
            }
        }
    }
    if (withLines) {
        view.setUint16(offset, watercourses.length, true);
        offset += 2;
        for (const course of watercourses) {
            view.setFloat32(offset, course.widthM, true);
            offset += 4;
            view.setUint16(offset, course.points.length, true);
            offset += 2;
            for (const pt of course.points) {
                view.setFloat32(offset, pt.lon, true);
                view.setFloat32(offset + 4, pt.lat, true);
                offset += 8;
            }
        }
    }
    if (withRegions) {
        view.setUint16(offset, regions.length, true);
        offset += 2;
        for (const region of regions) {
            out[offset] = region.isLand ? 1 : 0;
            out[offset + 1] = region.landuseClass ?? REGION_CLASS_NONE;
            offset += 2;
            view.setUint16(offset, 1 + region.holes.length, true);
            offset += 2;
            for (const ring of [region.exterior, ...region.holes]) {
                view.setUint16(offset, ring.length, true);
                offset += 2;
                for (const pt of ring) {
                    view.setFloat32(offset, pt.lon, true);
                    view.setFloat32(offset + 4, pt.lat, true);
                    offset += 8;
                }
            }
        }
    }
    if (profiled) {
        for (const body of inland) {
            const samples = body.profile ?? [];
            view.setUint16(offset, samples.length, true);
            offset += 2;
            for (const smp of samples) {
                view.setFloat32(offset, smp.lon, true);
                view.setFloat32(offset + 4, smp.lat, true);
                view.setFloat32(offset + 8, smp.heightM, true);
                offset += 12;
            }
        }
    }
    return out;
}

/** True when (lon, lat) lies inside any land polygon (holes subtract). */
export function isLandLonLat(lon: number, lat: number, tile: CoastVectorTile): boolean {
    for (const poly of tile.polygons) {
        if (pointInRing(lon, lat, poly.exterior)) {
            let inHole = false;
            for (const hole of poly.holes) {
                if (pointInRing(lon, lat, hole)) {
                    inHole = true;
                    break;
                }
            }
            if (!inHole) {
                return true;
            }
        }
    }
    return false;
}

/** Ray-casting point-in-polygon on a lon/lat ring. */
function pointInRing(lon: number, lat: number, ring: LonLat[]): boolean {
    const n = ring.length;
    if (n < 3) {
        return false;
    }
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[i].lon;
        const yi = ring[i].lat;
        const xj = ring[j].lon;
        const yj = ring[j].lat;
        const intersect = ((yi > lat) !== (yj > lat))
            && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        if (intersect) {
            inside = !inside;
        }
    }
    return inside;
}

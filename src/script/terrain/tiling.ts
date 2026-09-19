/** Geographic (Plate Carrée) quadtree tiling over the whole WGS84 ellipsoid. */

export interface TileKey {
    z: number;
    x: number;
    y: number;
}

export interface LonLatBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

export function xCount(z: number): number {
    return 1 << (z + 1);
}

export function yCount(z: number): number {
    return 1 << z;
}

export function tileKeyString(id: TileKey): string {
    return `${id.z}/${id.x}/${id.y}`;
}

export function parseTileKey(key: string): TileKey {
    const [zs, xs, ys] = key.split('/');
    return { z: Number(zs), x: Number(xs), y: Number(ys) };
}

/** Lon/lat AABB for a tile (degrees). */
export function tileBounds(id: TileKey): LonLatBounds {
    const span = 180 / (1 << id.z);
    const west = -180 + id.x * span;
    const north = 90 - id.y * span;
    return { west, south: north - span, east: west + span, north };
}

export function childrenOf(id: TileKey): TileKey[] {
    const z = id.z + 1;
    const x = id.x * 2;
    const y = id.y * 2;
    return [
        { z, x, y },
        { z, x: x + 1, y },
        { z, x, y: y + 1 },
        { z, x: x + 1, y: y + 1 },
    ];
}

export function parentOf(id: TileKey): TileKey | undefined {
    if (id.z <= 0) {
        return undefined;
    }
    return { z: id.z - 1, x: id.x >> 1, y: id.y >> 1 };
}

/** Same-zoom edge neighbors (W,E,N,S). Lon wraps; lat clamps. */
function edgeNeighbors(id: TileKey): TileKey[] {
    const xc = xCount(id.z);
    const yc = yCount(id.z);
    const out: TileKey[] = [];
    const push = (x: number, y: number) => {
        if (y < 0 || y >= yc) {
            return;
        }
        const xx = ((x % xc) + xc) % xc;
        out.push({ z: id.z, x: xx, y });
    };
    push(id.x - 1, id.y);
    push(id.x + 1, id.y);
    push(id.x, id.y - 1);
    push(id.x, id.y + 1);
    return out;
}

/** Root tiles covering the whole Earth (z0: 2×1). */
export function rootTiles(): TileKey[] {
    return [
        { z: 0, x: 0, y: 0 },
        { z: 0, x: 1, y: 0 },
    ];
}

export function tileContainsLonLat(bounds: LonLatBounds, lon: number, lat: number): boolean {
    return lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north;
}

/** Tile containing a lon/lat at zoom z. */
export function tileAtLonLat(z: number, lon: number, lat: number): TileKey {
    const xc = xCount(z);
    const yc = yCount(z);
    const span = 180 / (1 << z);
    let x = Math.floor((lon + 180) / span);
    let y = Math.floor((90 - lat) / span);
    x = Math.max(0, Math.min(xc - 1, x));
    y = Math.max(0, Math.min(yc - 1, y));
    return { z, x, y };
}

function boundsOverlap(a: LonLatBounds, b: LonLatBounds): boolean {
    return a.west < b.east && a.east > b.west && a.south < b.north && a.north > b.south;
}

/** Approximate tile edge length in metres at the tile centre latitude. */
export function approxTileEdgeMetres(id: TileKey): number {
    const b = tileBounds(id);
    const midLat = 0.5 * (b.south + b.north);
    const lonM = (b.east - b.west) * 111320 * Math.cos(midLat * Math.PI / 180);
    const latM = (b.north - b.south) * 110540;
    return Math.max(lonM, latM);
}

/** Inclusive tile index range covering `b` at level `z`. */
export function tileRangeForBounds(
    z: number,
    b: LonLatBounds,
): { x0: number; y0: number; x1: number; y1: number } {
    const span = 180 / (1 << z);
    const nx = xCount(z);
    const ny = yCount(z);
    const x0 = Math.max(0, Math.floor((b.west + 180) / span));
    const x1 = Math.min(nx - 1, Math.ceil((b.east + 180) / span) - 1);
    const y0 = Math.max(0, Math.floor((90 - b.north) / span));
    const y1 = Math.min(ny - 1, Math.ceil((90 - b.south) / span) - 1);
    return { x0, y0, x1, y1 };
}

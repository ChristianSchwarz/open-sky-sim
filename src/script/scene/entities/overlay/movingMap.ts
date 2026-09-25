/**
 * The moving map: the far-tile cover rasters (PTX1 sidecars, see
 * src/script/terrain/coverTextures.ts) drawn under the tactical scope as a
 * heading-up chart centred on the aircraft.
 *
 * A sidecar's texels are the same `r, g, b, class` words the land vertices
 * carry, gridded over the tile's lon/lat box. Each one is turned into a
 * canvas once - no-data texels (sea, unbaked ground) painted the palette's
 * water - and cached; the frame then places every tile in view in a flat
 * metres frame around the ownship and lets the 2D context rotate and scale
 * it. Tiles that have not arrived yet are asked for and, until they do, the
 * nearest cached ancestor is drawn in their place, so the map is never
 * blank where the bake has data.
 */

import { PTX_NO_DATA, PtxTile } from '../../../terrain/ptx';
import { TileKey, parentOf, tileBounds, tileKeyString, tileRangeForBounds } from '../../../terrain/tiling';
import { CanvasPainter } from '../../../render/screen/canvasPainter';

/** What the map reads off the terrain; the cover texture store provides it. */
export interface MapTileSource {
    zoomRange: { min: number; max: number };
    texelsAt(z: number): number;
    sidecar(id: TileKey, priority: number): PtxTile | undefined;
}

/**
 * Store priority for map tiles: above anything the terrain streamer asks
 * for in the frustum, since the map is a handful of tiles and the pilot is
 * looking straight at it.
 */
const MOVING_MAP_PRIORITY = 2e6;

/** Tile canvases kept; each z11 one is a megabyte of RGBA. */
const MOVING_MAP_CANVAS_CACHE = 48;

/** Metres per degree of latitude, and of longitude at `latDeg`. */
export function metresPerDegree(latDeg: number): { lat: number; lon: number } {
    return {
        lat: 110540,
        lon: 111320 * Math.cos(latDeg * Math.PI / 180),
    };
}

/** Metres a texel of a zoom-`z` sidecar spans north-south. */
export function texelMetres(z: number, texels: number): number {
    return (180 / (1 << z)) * metresPerDegree(0).lat / texels;
}

/**
 * The coarsest zoom whose texels are no larger than a screen pixel at
 * `metresPerPixel`, clamped to what the bake wrote. Finer would fetch
 * texels the display cannot show; coarser blurs it.
 */
export function movingMapZoom(metresPerPixel: number, texelsAt: (z: number) => number,
    range: { min: number; max: number }): number {

    for (let z = range.min; z <= range.max; z++) {
        if (texelMetres(z, texelsAt(z)) <= metresPerPixel) {
            return z;
        }
    }
    return range.max;
}

/** A tile's box in the map frame: metres from the ownship, x east, y south. */
export interface MapTilePlacement {
    x: number;
    y: number;
    width: number;
    height: number;
}

export function placeMapTile(id: TileKey, latDeg: number, lonDeg: number): MapTilePlacement {
    const b = tileBounds(id);
    const m = metresPerDegree(latDeg);
    return {
        x: (b.west - lonDeg) * m.lon,
        y: (latDeg - b.north) * m.lat,
        width: (b.east - b.west) * m.lon,
        height: (b.north - b.south) * m.lat,
    };
}

/** Zoom-`z` tiles within `halfExtentM` of the ownship in either axis. */
export function mapTilesInView(z: number, latDeg: number, lonDeg: number, halfExtentM: number): TileKey[] {
    const m = metresPerDegree(latDeg);
    const dLat = halfExtentM / m.lat;
    const dLon = halfExtentM / Math.max(1, m.lon);
    const r = tileRangeForBounds(z, {
        west: lonDeg - dLon, east: lonDeg + dLon,
        south: latDeg - dLat, north: latDeg + dLat,
    });
    const out: TileKey[] = [];
    for (let y = r.y0; y <= r.y1; y++) {
        for (let x = r.x0; x <= r.x1; x++) {
            out.push({ z, x, y });
        }
    }
    return out;
}

/** Parse `#rrggbb` into bytes; anything else is black. */
export function parseHexColor(color: string): [number, number, number] {
    const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
    if (!m) {
        return [0, 0, 0];
    }
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** The sidecar as opaque RGBA, no-data texels painted `water`. */
export function mapTilePixels(tile: PtxTile, water: [number, number, number]): Uint8ClampedArray<ArrayBuffer> {
    const src = tile.texels;
    const out = new Uint8ClampedArray(new ArrayBuffer(src.length));
    for (let o = 0; o < src.length; o += 4) {
        if (src[o + 3] === PTX_NO_DATA) {
            out[o] = water[0];
            out[o + 1] = water[1];
            out[o + 2] = water[2];
        } else {
            out[o] = src[o];
            out[o + 1] = src[o + 1];
            out[o + 2] = src[o + 2];
        }
        out[o + 3] = 255;
    }
    return out;
}

export interface MovingMapView {
    /** Pixel the ownship sits on. */
    centerX: number;
    centerY: number;
    /** Screen pixels per metre. */
    pixelsPerMetre: number;
    /** Half the drawn square, in pixels; decides which tiles are fetched. */
    halfExtentPx: number;
    latDeg: number;
    lonDeg: number;
    /** Degrees, 0 north, clockwise; drawn up the screen. */
    headingDeg: number;
    /** Painted where the bake has no data. */
    waterColor: string;
}

export class MovingMapRenderer {
    private readonly canvases = new Map<string, HTMLCanvasElement>();

    constructor(private readonly source: MapTileSource) { }

    /**
     * Draw the map into whatever clip the caller has set. Tiles at the
     * chosen zoom that are not cached yet fall back to their nearest cached
     * ancestor, drawn first so a finer sibling paints over it.
     */
    render(painter: CanvasPainter, view: MovingMapView): void {
        const range = this.source.zoomRange;
        if (range.max < range.min) {
            return;
        }
        const metresPerPixel = 1 / view.pixelsPerMetre;
        const z = movingMapZoom(metresPerPixel, (zz) => this.source.texelsAt(zz), range);
        // The square rotates, so its corners reach sqrt(2) further than its edges.
        const halfExtentM = view.halfExtentPx * metresPerPixel * Math.SQRT2;
        const wanted = mapTilesInView(z, view.latDeg, view.lonDeg, halfExtentM);

        const fine: Array<{ id: TileKey; canvas: HTMLCanvasElement }> = [];
        const coarse = new Map<string, { id: TileKey; canvas: HTMLCanvasElement }>();
        for (const id of wanted) {
            const canvas = this.canvasFor(id, view.waterColor);
            if (canvas) {
                fine.push({ id, canvas });
                continue;
            }
            for (let p = parentOf(id); p !== undefined && p.z >= range.min; p = parentOf(p)) {
                const key = tileKeyString(p);
                if (coarse.has(key)) {
                    break;
                }
                const c = this.canvasFor(p, view.waterColor, false);
                if (c) {
                    coarse.set(key, { id: p, canvas: c });
                    break;
                }
            }
        }

        painter.pushTransform(view.centerX, view.centerY, -view.headingDeg * Math.PI / 180, view.pixelsPerMetre);
        for (const t of [...coarse.values(), ...fine]) {
            const place = placeMapTile(t.id, view.latDeg, view.lonDeg);
            painter.image(t.canvas, place.x, place.y, place.width, place.height);
        }
        painter.popTransform();
    }

    private canvasFor(id: TileKey, waterColor: string, fetch: boolean = true): HTMLCanvasElement | undefined {
        const key = `${tileKeyString(id)}|${waterColor}`;
        const cached = this.canvases.get(key);
        if (cached) {
            // Re-insert so the map's iteration order stays least-recent first.
            this.canvases.delete(key);
            this.canvases.set(key, cached);
            return cached;
        }
        const tile = this.source.sidecar(id, fetch ? MOVING_MAP_PRIORITY : 0);
        if (!tile) {
            return undefined;
        }
        const canvas = document.createElement('canvas');
        canvas.width = tile.size;
        canvas.height = tile.size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return undefined;
        }
        ctx.putImageData(new ImageData(mapTilePixels(tile, parseHexColor(waterColor)), tile.size, tile.size), 0, 0);
        this.canvases.set(key, canvas);
        while (this.canvases.size > MOVING_MAP_CANVAS_CACHE) {
            const oldest = this.canvases.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.canvases.delete(oldest);
        }
        return canvas;
    }
}

/**
 * The plan view's terrain colour, taken from the same mesh the sim draws.
 *
 * The height pyramid can only say how high a point is, so a chart built from it
 * has to guess at the shoreline by testing height against sea level — on a
 * 611 m lattice off the fine tier, which is a coastline drawn as a staircase.
 * The sim does not guess: the coast is baked OSM vector geometry carried in the
 * mesh as real water triangles, and every land triangle carries its observed
 * landcover class and its mean satellite colour. Reading those gives the chart
 * the world's actual shoreline and the world's actual colours in one pass.
 *
 * Triangles are rasterised **straight to screen resolution**, not through a
 * per-tile bitmap. The bitmap version was cheaper but it fixed the detail a
 * tile could ever show: at any zoom past its own texel size the mesh went
 * blurry, and the guard that suppressed a too-coarse tile then rejected the
 * very tiles that had just been fetched for that view — leaving the height
 * shading underneath showing through in tile-shaped rectangles. Drawing the
 * geometry at screen resolution has no such ceiling; zoom in and it stays sharp
 * because the triangles simply get bigger.
 *
 * What *is* cached is the per-facet colour, which is the expensive part:
 * resolving a landcover class and a satellite colour through the palette for
 * every triangle of every tile, on every view change, would cost far more than
 * transforming the vertices does.
 *
 * The result goes into a screen-sized buffer with an alpha channel rather than
 * onto the canvas, so the caller can composite it over the height shading and
 * let that show through wherever the mesh has nothing to say.
 */

import { EnuBasis } from '../terrain/geodesy';
import { PtmTile } from '../terrain/ptm';
import { TileKey, tileKeyString } from '../terrain/tiling';
import { tileOriginWorld } from '../terrain/tileMesh';
import { TerrainTone } from '../terrain/tones';
import { FacetPalette, Rgb, facetColour, toneColour } from '../mission/facetColour';
import { MapView } from '../mission/mapProjection';

/**
 * Tiles whose facet colours are kept. Each is a few bytes per triangle, so this
 * is single-digit megabytes — far less than the meshes it describes.
 */
const MAX_CACHED = 192;

/**
 * How many zoom levels coarser than the best tile on screen a tile may be and
 * still be drawn.
 *
 * Measured against the finest tile actually visible rather than against the
 * view, because a fine tile legitimately extends far beyond a deeply zoomed
 * view — judging by extent would throw away exactly the tiles you zoomed in to
 * see. Four keeps a real fallback ladder while dropping the ancestors that
 * cover a continent in a handful of triangles and paint the screen in enormous
 * flat blocks where nothing finer exists.
 */
const MAX_ZOOM_GAP = 4;

/**
 * Twice the screen area (px^2) below which a triangle is treated as a sliver
 * rather than a facet. `area` here is the edge cross product, so this is one
 * square pixel of actual triangle.
 */
const SLIVER_AREA = 2;

interface CoverTile {
    key: string;
    z: number;
    tile: PtmTile;
    /** Scene position of the tile's local origin. */
    originX: number;
    originZ: number;
    /** Metres per quantised unit. */
    q: number;
    /** Scene-space bounds, for the screen cull. */
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
    /** RGB per land triangle, already through the palette. */
    landRgb: Uint8Array;
    /** RGB per water draw group (deep, shallow). */
    waterRgb: Uint8Array;
    used: number;
}

export function hexToRgb(hex: string): Rgb {
    const s = hex.trim().replace('#', '');
    const n = s.length === 3
        ? parseInt(s[0] + s[0] + s[1] + s[1] + s[2] + s[2], 16)
        : parseInt(s.slice(0, 6), 16);
    if (!Number.isFinite(n)) {
        return { r: 0.5, g: 0.5, b: 0.5 };
    }
    return {
        r: ((n >> 16) & 255) / 255,
        g: ((n >> 8) & 255) / 255,
        b: (n & 255) / 255,
    };
}

/**
 * Fill one screen-space triangle, flat.
 *
 * Winding-agnostic: the edge functions are compared against the sign of the
 * signed area rather than against zero, because a clockwise triangle has all
 * three negative and would otherwise be dropped entirely.
 */
function fillTriangle(
    out: Uint8ClampedArray, w: number, h: number,
    ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
    r: number, g: number, b: number,
): void {
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    if (minX > maxX || minY > maxY) {
        return;
    }
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) {
        return;
    }
    // Skip slivers.
    //
    // A tile carries skirts — vertical geometry hanging from its edges to hide
    // cracks against its neighbours. Seen from directly above those collapse to
    // lines, and rasterised faithfully they draw tan stripes across the chart
    // on every tile boundary. Nothing on a heightfield is legitimately a sliver
    // from this viewpoint unless it is vertical, which is exactly what a skirt
    // is; a genuinely small facet has a small bounding box too and is handled
    // by the block path below.
    if (Math.abs(area) < SLIVER_AREA
        && (maxX - minX > 1 || maxY - minY > 1)) {
        return;
    }
    // Sub-pixel triangles fall between sample points and leave holes, and when
    // the whole view is zoomed out most of them are. Painting the bounding box
    // keeps the ground solid; neighbours overwrite each other in mesh order,
    // the same arbitrary-but-stable choice a depth test makes for coplanar
    // facets.
    if (maxX - minX <= 1 && maxY - minY <= 1) {
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const at = (y * w + x) * 4;
                out[at] = r; out[at + 1] = g; out[at + 2] = b; out[at + 3] = 255;
            }
        }
        return;
    }
    const positive = area > 0;
    for (let y = minY; y <= maxY; y++) {
        const sy = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
            const sx = x + 0.5;
            const w0 = (bx - ax) * (sy - ay) - (by - ay) * (sx - ax);
            const w1 = (cx - bx) * (sy - by) - (cy - by) * (sx - bx);
            const w2 = (ax - cx) * (sy - cy) - (ay - cy) * (sx - cx);
            if (positive ? (w0 < 0 || w1 < 0 || w2 < 0) : (w0 > 0 || w1 > 0 || w2 > 0)) {
                continue;
            }
            const at = (y * w + x) * 4;
            out[at] = r; out[at + 1] = g; out[at + 2] = b; out[at + 3] = 255;
        }
    }
}

export class MissionCoverRaster {

    private readonly tiles = new Map<string, CoverTile>();
    private stamp = 0;
    private paletteKey = '';
    /** Screen-sized RGBA; alpha 0 marks a pixel the mesh did not cover. */
    private buffer = new Uint8ClampedArray(0);
    private bufferW = 0;
    private bufferH = 0;

    /**
     * Take the tiles, resolving each facet's colour once.
     *
     * Cheap to call whenever the resident set changes: a tile already held
     * under the same palette is left alone.
     */
    setTiles(
        resident: ReadonlyArray<{ id: TileKey; tile: PtmTile }>,
        basis: EnuBasis,
        palette: FacetPalette,
    ): void {
        const key = JSON.stringify([
            palette.mode, palette.shadeSteps, palette.shadeRange,
            palette.shadeMid, palette.shadeSpread, palette.landuseBlend,
            palette.toneColours, palette.swatches,
        ]);
        if (key !== this.paletteKey) {
            this.tiles.clear();
            this.paletteKey = key;
        }
        for (const { id, tile } of resident) {
            const k = tileKeyString(id);
            const have = this.tiles.get(k);
            if (have !== undefined) {
                have.used = ++this.stamp;
                continue;
            }
            const built = this.build(id, tile, basis, palette);
            if (built !== undefined) {
                this.tiles.set(k, built);
            }
        }
        this.evict();
    }

    get size(): number {
        return this.tiles.size;
    }

    private evict(): void {
        if (this.tiles.size <= MAX_CACHED) {
            return;
        }
        const byAge = [...this.tiles.values()].sort((a, b) => a.used - b.used);
        for (const t of byAge.slice(0, this.tiles.size - MAX_CACHED)) {
            this.tiles.delete(t.key);
        }
    }

    private build(
        id: TileKey, tile: PtmTile, basis: EnuBasis, palette: FacetPalette,
    ): CoverTile | undefined {
        const landVerts = tile.landPositions.length / 3;
        const waterVerts = tile.waterPositions.length / 3;
        if (landVerts === 0 && waterVerts === 0) {
            return undefined;
        }
        const origin = tileOriginWorld(id, tile.centerHeightM, basis);
        const q = tile.quantScale;

        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        const sweep = (pos: Int16Array): void => {
            for (let v = 0; v < pos.length / 3; v++) {
                const x = origin.x + pos[v * 3] * q;
                const z = origin.z + pos[v * 3 + 2] * q;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (z < minZ) minZ = z;
                if (z > maxZ) maxZ = z;
            }
        };
        sweep(tile.landPositions);
        sweep(tile.waterPositions);
        if (!(maxX > minX) || !(maxZ > minZ)) {
            return undefined;
        }

        // Land is non-indexed and flat shaded, so the first vertex of each
        // triangle carries the facet's attributes.
        const triCount = Math.floor(landVerts / 3);
        const landRgb = new Uint8Array(triCount * 3);
        for (let t = 0; t < triCount; t++) {
            const a = t * 3 * 4;
            const c = facetColour(
                {
                    r: tile.landAttrs[a] / 255,
                    g: tile.landAttrs[a + 1] / 255,
                    b: tile.landAttrs[a + 2] / 255,
                },
                tile.landAttrs[a + 3],
                palette);
            landRgb[t * 3] = c.r * 255;
            landRgb[t * 3 + 1] = c.g * 255;
            landRgb[t * 3 + 2] = c.b * 255;
        }

        const waterRgb = new Uint8Array(6);
        for (let group = 0; group < 2; group++) {
            const c = toneColour(
                group === 0 ? TerrainTone.Water : TerrainTone.ShallowWater,
                palette.toneColours);
            waterRgb[group * 3] = c.r * 255;
            waterRgb[group * 3 + 1] = c.g * 255;
            waterRgb[group * 3 + 2] = c.b * 255;
        }

        return {
            key: tileKeyString(id), z: id.z, tile,
            originX: origin.x, originZ: origin.z, q,
            minX, minZ, maxX, maxZ,
            landRgb, waterRgb, used: ++this.stamp,
        };
    }

    /**
     * Rasterise every visible tile into the internal buffer and hand it back.
     *
     * Coarsest first, so a finer tile over the same ground paints last and
     * wins. Pixels no triangle covered keep alpha 0, which is how the height
     * shading underneath survives where the mesh has nothing.
     */
    render(view: MapView): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
        const w = Math.max(1, Math.floor(view.widthPx));
        const h = Math.max(1, Math.floor(view.heightPx));
        if (w !== this.bufferW || h !== this.bufferH) {
            this.buffer = new Uint8ClampedArray(w * h * 4);
            this.bufferW = w;
            this.bufferH = h;
        }
        const out = this.buffer as Uint8ClampedArray<ArrayBuffer>;
        out.fill(0);

        const scale = 1 / view.mPerPx;
        const offX = w / 2 - view.centreX * scale;
        const offY = h / 2 - view.centreZ * scale;

        const visible = [...this.tiles.values()].filter(t =>
            !(t.maxX * scale + offX < 0 || t.minX * scale + offX > w
                || t.maxZ * scale + offY < 0 || t.minZ * scale + offY > h));
        // Anything far coarser than the best tile on screen is an ancestor
        // whose facets are continents; where nothing finer covers the ground it
        // paints enormous flat blocks, which is worse than letting the height
        // shading underneath show through.
        const finest = visible.reduce((m, t) => Math.max(m, t.z), 0);
        const ordered = visible
            .filter(t => t.z >= finest - MAX_ZOOM_GAP)
            .sort((a, b) => a.z - b.z);
        for (const t of ordered) {
            this.drawTile(t, out, w, h, scale, offX, offY);
        }
        return { data: out, width: w, height: h };
    }

    private drawTile(
        t: CoverTile, out: Uint8ClampedArray, w: number, h: number,
        scale: number, offX: number, offY: number,
    ): void {
        const pos = t.tile.landPositions;
        const triCount = t.landRgb.length / 3;
        for (let i = 0; i < triCount; i++) {
            const v = i * 9;
            fillTriangle(
                out, w, h,
                (t.originX + pos[v] * t.q) * scale + offX,
                (t.originZ + pos[v + 2] * t.q) * scale + offY,
                (t.originX + pos[v + 3] * t.q) * scale + offX,
                (t.originZ + pos[v + 5] * t.q) * scale + offY,
                (t.originX + pos[v + 6] * t.q) * scale + offX,
                (t.originZ + pos[v + 8] * t.q) * scale + offY,
                t.landRgb[i * 3], t.landRgb[i * 3 + 1], t.landRgb[i * 3 + 2]);
        }

        // Water last: the OSM coast is authoritative about where the sea is,
        // and it is the whole reason this layer exists.
        const wpos = t.tile.waterPositions;
        const widx = t.tile.waterIndices;
        for (let group = 0; group < t.tile.waterGroups.length; group++) {
            const [start, count] = t.tile.waterGroups[group];
            if (count === 0) {
                continue;
            }
            const c = group === 0 ? 0 : 3;
            for (let i = start; i + 2 < start + count; i += 3) {
                const i0 = widx[i] * 3, i1 = widx[i + 1] * 3, i2 = widx[i + 2] * 3;
                fillTriangle(
                    out, w, h,
                    (t.originX + wpos[i0] * t.q) * scale + offX,
                    (t.originZ + wpos[i0 + 2] * t.q) * scale + offY,
                    (t.originX + wpos[i1] * t.q) * scale + offX,
                    (t.originZ + wpos[i1 + 2] * t.q) * scale + offY,
                    (t.originX + wpos[i2] * t.q) * scale + offX,
                    (t.originZ + wpos[i2 + 2] * t.q) * scale + offY,
                    t.waterRgb[c], t.waterRgb[c + 1], t.waterRgb[c + 2]);
            }
        }
    }

    /**
     * Composite the last rendered cover over `dest`, leaving pixels the mesh
     * did not cover untouched. Returns how many it painted.
     */
    compositeInto(dest: Uint8ClampedArray, w: number, h: number): number {
        if (w !== this.bufferW || h !== this.bufferH) {
            return 0;
        }
        const src = this.buffer;
        let painted = 0;
        for (let at = 0; at < src.length; at += 4) {
            if (src[at + 3] === 0) {
                continue;
            }
            dest[at] = src[at];
            dest[at + 1] = src[at + 1];
            dest[at + 2] = src[at + 2];
            dest[at + 3] = 255;
            painted++;
        }
        return painted;
    }

    /** Scene-space extent of everything cached, for an initial fit. */
    extent(): Array<{ x: number; z: number }> {
        const out: Array<{ x: number; z: number }> = [];
        for (const t of this.tiles.values()) {
            out.push({ x: t.minX, z: t.minZ });
            out.push({ x: t.maxX, z: t.maxZ });
        }
        return out;
    }
}

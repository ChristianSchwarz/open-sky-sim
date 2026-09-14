/**
 * PTX1 - "Planet Tile teXture", the far-tile cover texture, and the maths
 * that produces one from a leaf mesh.
 *
 * A coarse tile paints one colour per facet, and its facets are hundreds of
 * metres across, so from altitude every field boundary the z12 leaf resolves
 * collapses into a blob. This sidecar carries the leaf's answer down the
 * pyramid instead: each texel holds the same four bytes a land vertex does -
 * `r, g, b, TerrainClass` - so the runtime resolves it through the same
 * palette code and the four colour modes stay a uniform write. Alpha 255 is
 * "no data": sea, or ground under an area never baked to the leaf zoom, and
 * the shader falls back to the facet colour there.
 *
 * The texel grid is the tile's lon/lat box, row 0 at the north edge, column
 * 0 at the west edge. Tiles are geodetic (`2^(z+1) x 2^z`), so a parent is
 * exactly its four children side by side and the pyramid is a plain 2x2
 * downsample - no resampling, no seams. See docs/terrain-far-textures.md.
 *
 * The format itself - header, encode, decode - lives with the runtime in
 * src/script/terrain/ptx.ts and is re-exported here; this file is the maths
 * that produces a raster.
 */

import { EnuBasis, ecefToEnu, ecefToGeodetic, enuToEcef, geodeticToEcef } from '../../src/script/terrain/geodesy';
import { PtmTile } from '../../src/script/terrain/ptm';
import { PTX_NO_DATA } from '../../src/script/terrain/ptx';
import { TileKey } from './index';
import { LonLatBounds } from './shoreline';
import { tileBounds } from './meshTile';

export {
    PTX_HEADER_BYTES, PTX_MAGIC, PTX_NO_DATA, PTX_VERSION, PtxTile, decodePtx, encodePtx,
} from '../../src/script/terrain/ptx';

/** A raster of nothing: every texel no-data. */
export function emptyRaster(size: number): Uint8Array {
    const out = new Uint8Array(size * size * 4);
    for (let i = 3; i < out.length; i += 4) {
        out[i] = PTX_NO_DATA;
    }
    return out;
}

export function isEmptyRaster(texels: Uint8Array): boolean {
    for (let i = 3; i < texels.length; i += 4) {
        if (texels[i] !== PTX_NO_DATA) {
            return false;
        }
    }
    return true;
}

/**
 * A triangle whose lon/lat footprint is smaller than this, in texels^2, is
 * not painted. Skirts and shore walls are vertical, so top-down they are
 * lines: this is what keeps them - and their depressed vertices - out of
 * the raster without knowing which triangles they are.
 */
const MIN_TRIANGLE_AREA_TEXELS = 1e-4;

/**
 * Rasterise a leaf tile's land facets, top-down, into a `size x size` RGBA
 * raster over the tile's lon/lat box.
 *
 * Positions in the tile are offsets from the tile centre in the axes of the
 * bake's one global ENU frame (x = e, y = u, z = -n; see buildTile), so a
 * vertex goes back to lon/lat through that frame exactly, however far the
 * tile is from the frame's origin. Height is the geodetic one from the same
 * conversion, and it orders overlapping facets: a land-use fill is lifted a
 * hair above the ground it covers and has to win the texel.
 */
export function rasterizeLeaf(tile: PtmTile, basis: EnuBasis, size: number): Uint8Array {
    const out = emptyRaster(size);
    const height = new Float32Array(size * size).fill(-Infinity);
    const bounds = tileBounds(tile.id.z, tile.id.x, tile.id.y);
    const lonSpan = bounds.east - bounds.west;
    const latSpan = bounds.north - bounds.south;

    const centre = ecefToEnu(basis, geodeticToEcef(
        (bounds.south + bounds.north) / 2, (bounds.west + bounds.east) / 2, tile.centerHeightM,
    ));
    const pos = tile.landPositions;
    const q = tile.quantScale;
    const vertexCount = pos.length / 3;
    // Texel-space x, y and geodetic height per vertex.
    const tx = new Float64Array(vertexCount);
    const ty = new Float64Array(vertexCount);
    const th = new Float64Array(vertexCount);
    const enu = { e: 0, n: 0, u: 0 };
    const ecef = { x: 0, y: 0, z: 0 };
    for (let v = 0; v < vertexCount; v++) {
        enu.e = centre.e + pos[v * 3] * q;
        enu.u = centre.u + pos[v * 3 + 1] * q;
        enu.n = centre.n - pos[v * 3 + 2] * q;
        enuToEcef(basis, enu, ecef);
        const g = ecefToGeodetic(ecef.x, ecef.y, ecef.z);
        tx[v] = ((g.lon - bounds.west) / lonSpan) * size;
        ty[v] = ((bounds.north - g.lat) / latSpan) * size;
        th[v] = g.height;
    }

    const attrs = tile.landAttrs;
    for (let v = 0; v + 2 < vertexCount; v += 3) {
        fillTriangle(
            out, height, size,
            tx[v], ty[v], th[v],
            tx[v + 1], ty[v + 1], th[v + 1],
            tx[v + 2], ty[v + 2], th[v + 2],
            attrs[v * 4], attrs[v * 4 + 1], attrs[v * 4 + 2], attrs[v * 4 + 3],
        );
    }
    return out;
}

/**
 * Flat-fill one triangle by texel centres, with a height test so the
 * highest facet over a texel keeps it. The "highest" test is `>=` rather
 * than `>` on purpose: a fill sits above its ground by a lift of a few
 * centimetres, which survives the float32 height buffer only because the
 * comparison is not asked to separate it from equality noise - at a tie
 * the later triangle wins, and fills are emitted after the ground facets.
 */
function fillTriangle(
    out: Uint8Array, height: Float32Array, size: number,
    x0: number, y0: number, h0: number,
    x1: number, y1: number, h1: number,
    x2: number, y2: number, h2: number,
    r: number, g: number, b: number, cls: number,
): void {
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < MIN_TRIANGLE_AREA_TEXELS * 2) {
        return;
    }
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) {
        return;
    }
    const inv = 1 / area;
    for (let py = minY; py <= maxY; py++) {
        const cy = py + 0.5;
        for (let px = minX; px <= maxX; px++) {
            const cx = px + 0.5;
            // Barycentric weights of the texel centre.
            let w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * inv;
            let w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * inv;
            let w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) {
                continue;
            }
            const h = w0 * h0 + w1 * h1 + w2 * h2;
            const i = py * size + px;
            if (h < height[i]) {
                continue;
            }
            height[i] = h;
            const o = i * 4;
            out[o] = r;
            out[o + 1] = g;
            out[o + 2] = b;
            out[o + 3] = cls;
        }
    }
}

/**
 * Halve a raster: each output texel is the mean colour of its 2x2 block's
 * data texels and their majority class (ties to the first seen, scanning
 * the block in row order), or no-data when the whole block is.
 */
export function downsample2x2(src: Uint8Array, size: number): Uint8Array {
    if (size % 2 !== 0) {
        throw new Error(`cannot halve a ${size}-texel raster`);
    }
    const half = size / 2;
    const out = emptyRaster(half);
    const classes = new Uint8Array(4);
    for (let y = 0; y < half; y++) {
        for (let x = 0; x < half; x++) {
            let n = 0, r = 0, g = 0, b = 0;
            for (let dy = 0; dy < 2; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    const o = ((y * 2 + dy) * size + (x * 2 + dx)) * 4;
                    const cls = src[o + 3];
                    if (cls === PTX_NO_DATA) {
                        continue;
                    }
                    r += src[o];
                    g += src[o + 1];
                    b += src[o + 2];
                    classes[n++] = cls;
                }
            }
            if (n === 0) {
                continue;
            }
            let best = classes[0];
            let bestCount = 0;
            for (let i = 0; i < n; i++) {
                let count = 0;
                for (let j = 0; j < n; j++) {
                    if (classes[j] === classes[i]) {
                        count++;
                    }
                }
                if (count > bestCount) {
                    bestCount = count;
                    best = classes[i];
                }
            }
            const o = (y * half + x) * 4;
            out[o] = Math.round(r / n);
            out[o + 1] = Math.round(g / n);
            out[o + 2] = Math.round(b / n);
            out[o + 3] = best;
        }
    }
    return out;
}

/**
 * Halve a raster until it is `target` texels across. A level's size never
 * drops toward the leaf, so a child is always at least as fine as its
 * parent wants and this is one or more halvings; a coarser child would need
 * an upsample, which is a bake configuration error rather than a case.
 */
export function shrinkTo(texels: Uint8Array, size: number, target: number): Uint8Array {
    if (size < target) {
        throw new Error(`cannot grow a ${size}-texel raster to ${target}`);
    }
    let out = texels;
    let n = size;
    while (n > target) {
        out = downsample2x2(out, n);
        n /= 2;
    }
    return out;
}

/**
 * Copy a child's raster, already halved to `size / 2`, into the quadrant of
 * a `size` parent raster it covers. Quadrant (0, 0) is the north-west
 * child, (1, 1) the south-east - `x & 1`, `y & 1` of the child's key.
 */
export function mergeQuadrant(
    parent: Uint8Array, size: number, child: Uint8Array, qx: number, qy: number,
): void {
    const half = size / 2;
    if (child.byteLength !== half * half * 4) {
        throw new Error(`quadrant raster is ${child.byteLength} bytes, expected ${half}x${half} RGBA`);
    }
    for (let y = 0; y < half; y++) {
        const srcRow = y * half * 4;
        const dstRow = ((qy * half + y) * size + qx * half) * 4;
        parent.set(child.subarray(srcRow, srcRow + half * 4), dstRow);
    }
}

/** Which quadrant of its parent a tile key falls in. */
export function quadrantOf(id: TileKey): { qx: number; qy: number } {
    return { qx: id.x & 1, qy: id.y & 1 };
}

/** Lon/lat box of a tile key, the tools' `tileBounds` under the runtime's key shape. */
export function boundsOf(id: TileKey): LonLatBounds {
    return tileBounds(id.z, id.x, id.y);
}

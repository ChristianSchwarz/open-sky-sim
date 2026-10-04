/**
 * A runway's paint, rasterised into a coverage mask for the far view.
 *
 * Drawn as geometry, a 0.9 m centreline seen from a few kilometres is a tenth
 * of a pixel wide: it is either hit by a pixel centre or not, and the stripe
 * breaks up into a dotted line of full-white specks while the threshold bars
 * and numerals flicker in and out. The same paint as a texture is averaged by
 * its mipmaps instead, so a stripe too thin to draw comes out as the faint
 * lightening of the pavement it really is.
 *
 * Pure: no THREE. Two channels, both 0..255 coverage of one texel:
 *
 *   0   paint drawn in the threshold tone (threshold bars, designators)
 *   1   paint drawn in the line tone (centreline, aiming point, edges)
 *
 * Texel x runs along the runway (u, low threshold at x = 0) and texel y across
 * it (v, -widthM/2 at y = 0), which is how the pavement quad's UVs are laid.
 */

import { MarkingKind, MarkingRect } from './runwayMarkings';

/** Across the runway: the centreline is three texels wide. */
export const MARKING_TEXEL_ACROSS_M = 0.3;
/** Along it: every bar a glyph has is at least five texels. */
export const MARKING_TEXEL_ALONG_M = 0.6;
/**
 * The longest side, in texels. WebGL2 guarantees 2048 and practically every
 * GPU does 4096; a 3 km runway lands at 0.73 m a texel along, which none of
 * its paint is short enough to notice.
 */
export const MARKING_TEXTURE_MAX = 4096;

export interface MarkingTexture {
    /** Texels along the runway. */
    width: number;
    /** Texels across it. */
    height: number;
    /** `width * height` texel pairs, row by row from y = 0. */
    data: Uint8Array;
}

/** Which channel a kind of paint goes in; -1 for what is not paint. */
export function markingChannel(kind: MarkingKind): number {
    switch (kind) {
        case 'threshold':
        case 'designator':
            return 0;
        case 'aiming':
        case 'centreline':
        case 'edge':
            return 1;
        default:
            return -1;
    }
}

/**
 * Rasterise the paint of one runway.
 *
 * Each texel holds the exact fraction of it a rectangle covers - an area
 * integral, not a point sample - so the base level is already filtered and
 * the mipmaps built from it are a true average all the way down.
 */
export function rasteriseMarkings(
    rects: readonly MarkingRect[], lengthM: number, widthM: number,
): MarkingTexture {
    const width = Math.max(1, Math.min(MARKING_TEXTURE_MAX,
        Math.ceil(lengthM / MARKING_TEXEL_ALONG_M)));
    const height = Math.max(1, Math.min(MARKING_TEXTURE_MAX,
        Math.ceil(widthM / MARKING_TEXEL_ACROSS_M)));
    const texelU = lengthM / width;
    const texelV = widthM / height;
    const coverage = new Float32Array(width * height * 2);

    for (const rect of rects) {
        const channel = markingChannel(rect.kind);
        if (channel < 0) {
            continue;
        }
        // Rectangle in texel units.
        const x0 = (rect.u - rect.lengthM / 2 + lengthM / 2) / texelU;
        const x1 = (rect.u + rect.lengthM / 2 + lengthM / 2) / texelU;
        const y0 = (rect.v - rect.widthM / 2 + widthM / 2) / texelV;
        const y1 = (rect.v + rect.widthM / 2 + widthM / 2) / texelV;
        const ix0 = Math.max(0, Math.floor(x0));
        const ix1 = Math.min(width, Math.ceil(x1));
        const iy0 = Math.max(0, Math.floor(y0));
        const iy1 = Math.min(height, Math.ceil(y1));
        for (let y = iy0; y < iy1; y++) {
            const cy = Math.min(y + 1, y1) - Math.max(y, y0);
            if (cy <= 0) {
                continue;
            }
            for (let x = ix0; x < ix1; x++) {
                const cx = Math.min(x + 1, x1) - Math.max(x, x0);
                if (cx > 0) {
                    coverage[(y * width + x) * 2 + channel] += cx * cy;
                }
            }
        }
    }

    const data = new Uint8Array(coverage.length);
    for (let i = 0; i < coverage.length; i++) {
        // Paint does not overlap within a channel, but where two rectangles
        // share an edge the float sum can creep a hair past one.
        data[i] = Math.round(Math.min(1, coverage[i]) * 255);
    }
    return { width, height, data };
}

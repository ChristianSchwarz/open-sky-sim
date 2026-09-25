/**
 * The stencil alphabet painted on a runway threshold.
 *
 * Ten digits and the three suffix letters, and nothing else — a runway
 * designator is one or two digits and at most an L, C or R.
 *
 * Each glyph is a handful of axis-aligned bars in a unit box, origin at the
 * bottom-left, y up. Bars rather than strokes on a segment grid: a seven
 * segment font reads as a calculator, and real runway numerals are squared-off
 * stencils built from exactly this kind of bar. It also means every glyph comes
 * out as quads with no rotation, which is what lets the whole marking layout
 * stay one flat list of axis-aligned rectangles.
 */

export interface GlyphBar {
    /** Left edge, 0..1 across the glyph. */
    x: number;
    /** Bottom edge, 0..1 up the glyph. */
    y: number;
    w: number;
    h: number;
}

/**
 * Bar thickness as a fraction of the glyph box.
 *
 * Runway numerals are heavy — they have to read from a mile out at a shallow
 * angle — and a thin font disappears long before the runway does.
 */
export const GLYPH_STROKE = 0.24;

const T = GLYPH_STROKE;
/** A horizontal bar centred on the glyph's waist. */
const MID = { x: 0, y: 0.5 - T / 2, w: 1, h: T };
const TOP = { x: 0, y: 1 - T, w: 1, h: T };
const BOTTOM = { x: 0, y: 0, w: 1, h: T };
const LEFT = { x: 0, y: 0, w: T, h: 1 };
const RIGHT = { x: 1 - T, y: 0, w: T, h: 1 };
const LEFT_TOP = { x: 0, y: 0.5 - T / 2, w: T, h: 0.5 + T / 2 };
const LEFT_BOTTOM = { x: 0, y: 0, w: T, h: 0.5 + T / 2 };
const RIGHT_TOP = { x: 1 - T, y: 0.5 - T / 2, w: T, h: 0.5 + T / 2 };
const RIGHT_BOTTOM = { x: 1 - T, y: 0, w: T, h: 0.5 + T / 2 };

const GLYPHS: Record<string, GlyphBar[]> = {
    '0': [TOP, BOTTOM, LEFT, RIGHT],
    // A bare vertical bar, as it is painted. Centred, not on the right edge,
    // so a two-digit designator does not read as leaning.
    '1': [{ x: 0.5 - T / 2, y: 0, w: T, h: 1 }],
    '2': [TOP, RIGHT_TOP, MID, LEFT_BOTTOM, BOTTOM],
    '3': [TOP, MID, BOTTOM, RIGHT],
    '4': [LEFT_TOP, MID, RIGHT],
    '5': [TOP, LEFT_TOP, MID, RIGHT_BOTTOM, BOTTOM],
    '6': [TOP, LEFT, MID, RIGHT_BOTTOM, BOTTOM],
    '7': [TOP, RIGHT],
    '8': [TOP, MID, BOTTOM, LEFT, RIGHT],
    '9': [TOP, LEFT_TOP, MID, RIGHT, BOTTOM],
    L: [LEFT, BOTTOM],
    C: [TOP, LEFT, BOTTOM],
    // P with a straight leg. A proper R wants a diagonal, and a diagonal wants
    // a rotated quad for something that is two pixels wide by the time anyone
    // can read the number anyway.
    R: [TOP, LEFT, MID, RIGHT_TOP, { x: 1 - T, y: 0, w: T, h: 0.5 - T / 2 }],
};

/** Bars of one character, or an empty list for anything unpainted. */
export function glyphBars(ch: string): GlyphBar[] {
    return GLYPHS[ch.toUpperCase()] ?? [];
}

/** True for a character this alphabet can paint. */
export function isPaintable(ch: string): boolean {
    return glyphBars(ch).length > 0;
}

/**
 * What is painted on a runway, laid out in runway-local metres.
 *
 * Pure geometry: no THREE, no materials, no manifest. It takes a length, a
 * width and the designators, and returns axis-aligned rectangles — which is
 * what lets the whole thing be checked against a tape measure instead of
 * against a screenshot.
 *
 * Local axes, both in metres from the runway centre:
 *
 *   u   along the runway, negative at the *low* designator's threshold (the
 *       03 end of 03/21) and positive at the high one
 *   v   across the runway, positive to the right of an aircraft landing on the
 *       low designator
 *
 * The dimensions are ICAO Annex 14's, simplified where the difference would be
 * under a metre — this is a runway seen from an aircraft, not a paint schedule.
 * What is deliberately left out is the touchdown-zone ladder: it is a dozen
 * more bars per end for a pattern that is indistinguishable from the aiming
 * point at any altitude worth drawing it at.
 */

import { GlyphBar, glyphBars } from './glyphs';

export type MarkingKind =
    | 'pavement'
    | 'threshold'
    | 'designator'
    | 'aiming'
    | 'centreline'
    | 'edge';

/** An axis-aligned rectangle in runway-local metres. */
export interface MarkingRect {
    /** Centre along the runway. */
    u: number;
    /** Centre across the runway. */
    v: number;
    /** Extent along the runway. */
    lengthM: number;
    /** Extent across the runway. */
    widthM: number;
    kind: MarkingKind;
}

/** Threshold bars: 30 m long, 1.8 m wide, 1.8 m apart, 6 m in from the end. */
const THRESHOLD_BAR_LENGTH_M = 30;
const THRESHOLD_BAR_WIDTH_M = 1.8;
const THRESHOLD_BAR_GAP_M = 1.8;
const THRESHOLD_INSET_M = 6;

/** Centreline: 30 m of paint, 20 m of gap, 0.9 m wide. */
const CENTRELINE_STRIPE_M = 30;
const CENTRELINE_GAP_M = 20;
const CENTRELINE_WIDTH_M = 0.9;

/** Aiming point: two 45 x 6 m blocks starting 300 m in, 11 m off the centre. */
const AIMING_LENGTH_M = 45;
const AIMING_WIDTH_M = 6;
const AIMING_START_M = 300;
const AIMING_OFFSET_M = 11;
/** Below this there is no room for one, so short runways get none. */
const AIMING_MIN_RUNWAY_M = 1200;
/** Paint kept this far inside the pavement edge. */
const EDGE_CLEARANCE_M = 1.5;

/** Edge stripes, on paved runways wide enough to carry them. */
const EDGE_WIDTH_M = 0.9;
const EDGE_MIN_RUNWAY_WIDTH_M = 23;

/** Designators: 20 m tall, 6 m per character with 2 m between. */
const GLYPH_HEIGHT_M = 20;
const GLYPH_WIDTH_M = 6;
const GLYPH_SPACING_M = 2;
/** Gap between the end of the threshold bars and the top of the numerals. */
const DESIGNATOR_GAP_M = 12;

/**
 * Threshold bars by runway width, from Annex 14's table. A 45 m runway carries
 * twelve; a light-aircraft strip carries four, and painting twelve on it would
 * be the giveaway that nobody measured.
 */
export function thresholdBarCount(widthM: number): number {
    if (widthM >= 45) return 12;
    if (widthM >= 30) return 8;
    if (widthM >= 23) return 6;
    return 4;
}

/** True where the surface is paved, which is the only kind that gets painted. */
export function isPaintedSurface(surface: string): boolean {
    return surface === 'asphalt' || surface === 'concrete';
}

/** The two designators of a `ref`, low end first. */
export function designatorsOf(ref: string): [string, string] {
    const parts = ref.split('/').map(p => p.trim().toUpperCase());
    return [parts[0] ?? '', parts[1] ?? ''];
}

/**
 * One end's markings, in the local frame of an aircraft landing on it.
 *
 * `sign` is +1 for the low designator (landing toward +u) and -1 for the high
 * one. Everything is laid out as if landing toward +u and then multiplied
 * through, which is what keeps the two ends exact mirrors instead of two
 * hand-written blocks that drift apart.
 */
function endMarkings(
    lengthM: number, widthM: number, designator: string, sign: number,
): MarkingRect[] {
    const out: MarkingRect[] = [];
    const threshold = -sign * lengthM / 2;
    const at = (distance: number) => threshold + sign * distance;

    // Threshold bars, straddling the centreline.
    const bars = thresholdBarCount(widthM);
    const pitch = THRESHOLD_BAR_WIDTH_M + THRESHOLD_BAR_GAP_M;
    const spread = bars * pitch - THRESHOLD_BAR_GAP_M;
    for (let i = 0; i < bars; i++) {
        out.push({
            u: at(THRESHOLD_INSET_M + THRESHOLD_BAR_LENGTH_M / 2),
            v: -spread / 2 + pitch * i + THRESHOLD_BAR_WIDTH_M / 2,
            lengthM: THRESHOLD_BAR_LENGTH_M,
            widthM: THRESHOLD_BAR_WIDTH_M,
            kind: 'threshold',
        });
    }

    // Designator, reading up the runway for whoever is landing on it.
    const barsEnd = THRESHOLD_INSET_M + THRESHOLD_BAR_LENGTH_M + DESIGNATOR_GAP_M;
    out.push(...designatorRects(designator, at(barsEnd), sign));

    // Aiming point. The 11 m offset is the code 3/4 figure and belongs to a
    // 45 m runway; Annex 14 narrows the pair on narrower ones, and taken
    // literally it hangs a metre of paint off the side of a 30 m strip. Pulled
    // in to sit inside the pavement, and dropped entirely where even that
    // leaves the two blocks touching.
    const aimingOffset = Math.min(
        AIMING_OFFSET_M,
        widthM / 2 - EDGE_CLEARANCE_M - AIMING_WIDTH_M,
    );
    if (lengthM >= AIMING_MIN_RUNWAY_M && aimingOffset > AIMING_WIDTH_M / 2) {
        for (const side of [-1, 1]) {
            out.push({
                u: at(AIMING_START_M + AIMING_LENGTH_M / 2),
                v: side * (aimingOffset + AIMING_WIDTH_M / 2),
                lengthM: AIMING_LENGTH_M,
                widthM: AIMING_WIDTH_M,
                kind: 'aiming',
            });
        }
    }
    return out;
}

/**
 * The painted numerals, as rectangles.
 *
 * `baseU` is where the bottom of the characters sits and `sign` which way is
 * up for a pilot landing on this end — so the two ends read the right way up
 * from their own approaches, which is the whole point of painting them.
 */
export function designatorRects(
    designator: string, baseU: number, sign: number,
): MarkingRect[] {
    const chars = [...designator].filter(c => glyphBars(c).length > 0);
    if (chars.length === 0) {
        return [];
    }
    const pitch = GLYPH_WIDTH_M + GLYPH_SPACING_M;
    const totalWidth = chars.length * pitch - GLYPH_SPACING_M;
    const out: MarkingRect[] = [];
    chars.forEach((ch, i) => {
        // Character order runs left to right *as read*, which is -v to +v for
        // the pilot looking at it.
        const left = -sign * (totalWidth / 2) + sign * i * pitch;
        for (const bar of glyphBars(ch)) {
            out.push(glyphRect(bar, baseU, left, sign));
        }
    });
    return out;
}

function glyphRect(bar: GlyphBar, baseU: number, leftV: number, sign: number): MarkingRect {
    const uCentre = baseU + sign * (bar.y + bar.h / 2) * GLYPH_HEIGHT_M;
    const vCentre = leftV + sign * (bar.x + bar.w / 2) * GLYPH_WIDTH_M;
    return {
        u: uCentre,
        v: vCentre,
        lengthM: bar.h * GLYPH_HEIGHT_M,
        widthM: bar.w * GLYPH_WIDTH_M,
        kind: 'designator',
    };
}

/**
 * Everything painted on one runway, pavement first.
 *
 * Pavement leads so a renderer that draws in list order puts the paint on top
 * of it without needing to think about depth.
 */
export function runwayMarkings(
    lengthM: number, widthM: number, ref: string, surface: string,
): MarkingRect[] {
    const out: MarkingRect[] = [{
        u: 0, v: 0, lengthM, widthM, kind: 'pavement',
    }];
    if (!isPaintedSurface(surface)) {
        // Grass and gravel strips carry no paint at all, and painting a
        // threshold on one is the sort of detail that reads as wrong without
        // anyone being able to say why.
        return out;
    }

    const [low, high] = designatorsOf(ref);
    out.push(...endMarkings(lengthM, widthM, low, 1));
    out.push(...endMarkings(lengthM, widthM, high, -1));

    // Centreline, over the stretch the end markings leave clear.
    const clear = lengthM / 2 - (THRESHOLD_INSET_M + THRESHOLD_BAR_LENGTH_M
        + DESIGNATOR_GAP_M + GLYPH_HEIGHT_M);
    const pitch = CENTRELINE_STRIPE_M + CENTRELINE_GAP_M;
    const stripes = Math.floor((2 * clear + CENTRELINE_GAP_M) / pitch);
    for (let i = 0; i < stripes; i++) {
        const span = stripes * pitch - CENTRELINE_GAP_M;
        out.push({
            u: -span / 2 + i * pitch + CENTRELINE_STRIPE_M / 2,
            v: 0,
            lengthM: CENTRELINE_STRIPE_M,
            widthM: CENTRELINE_WIDTH_M,
            kind: 'centreline',
        });
    }

    if (widthM >= EDGE_MIN_RUNWAY_WIDTH_M) {
        for (const side of [-1, 1]) {
            out.push({
                u: 0,
                v: side * (widthM / 2 - EDGE_WIDTH_M / 2),
                lengthM,
                widthM: EDGE_WIDTH_M,
                kind: 'edge',
            });
        }
    }
    return out;
}

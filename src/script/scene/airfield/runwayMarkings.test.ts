import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GLYPH_STROKE, glyphBars, isPaintable } from './glyphs';
import {
    MarkingRect, designatorRects, designatorsOf, isPaintedSurface, runwayMarkings,
    thresholdBarCount,
} from './runwayMarkings';

/** Gran Canaria 03L/21R: 3103 m of asphalt, 45 m wide. */
const GCLP = { length: 3103, width: 45, ref: '03L/21R', surface: 'asphalt' };

function of(rects: MarkingRect[], kind: string): MarkingRect[] {
    return rects.filter(r => r.kind === kind);
}

/** Outer edges of a rect, along and across. */
function extent(r: MarkingRect) {
    return {
        u0: r.u - r.lengthM / 2, u1: r.u + r.lengthM / 2,
        v0: r.v - r.widthM / 2, v1: r.v + r.widthM / 2,
    };
}

describe('runway markings', () => {

    describe('pavement', () => {

        it('is the runway, centred, and comes first', () => {
            const rects = runwayMarkings(GCLP.length, GCLP.width, GCLP.ref, GCLP.surface);
            assert.equal(rects[0].kind, 'pavement');
            assert.equal(rects[0].lengthM, 3103);
            assert.equal(rects[0].widthM, 45);
            assert.equal(rects[0].u, 0);
            assert.equal(rects[0].v, 0);
        });

        it('is all a grass strip gets', () => {
            // A grass runway carries no paint at all. Painting a threshold on
            // one reads as wrong without anyone being able to say why.
            const rects = runwayMarkings(900, 30, '07/25', 'grass');
            assert.deepEqual(rects.map(r => r.kind), ['pavement']);
            assert.equal(isPaintedSurface('grass'), false);
            assert.equal(isPaintedSurface('concrete'), true);
        });
    });

    describe('threshold bars', () => {

        it('follows the Annex 14 table by width', () => {
            assert.equal(thresholdBarCount(45), 12);
            assert.equal(thresholdBarCount(30), 8);
            assert.equal(thresholdBarCount(23), 6);
            assert.equal(thresholdBarCount(18), 4);
        });

        it('puts a set at each end, inside the pavement', () => {
            const rects = runwayMarkings(GCLP.length, GCLP.width, GCLP.ref, GCLP.surface);
            const bars = of(rects, 'threshold');
            assert.equal(bars.length, 24, 'twelve bars at each end');
            const half = GCLP.length / 2;
            for (const bar of bars) {
                const e = extent(bar);
                assert.ok(e.u0 > -half && e.u1 < half, `bar at ${bar.u} ran off the end`);
                assert.ok(Math.abs(bar.v) < GCLP.width / 2, 'bar ran off the side');
            }
        });

        it('straddles the centreline evenly', () => {
            const bars = of(runwayMarkings(GCLP.length, GCLP.width, GCLP.ref, GCLP.surface),
                'threshold').filter(b => b.u < 0);
            const vs = bars.map(b => b.v).sort((a, b) => a - b);
            assert.equal(vs.length, 12);
            assert.ok(Math.abs(vs[0] + vs[vs.length - 1]) < 1e-9, 'the set is off centre');
        });
    });

    describe('designators', () => {

        it('splits a ref into its two ends', () => {
            assert.deepEqual(designatorsOf('03L/21R'), ['03L', '21R']);
            assert.deepEqual(designatorsOf('09/27'), ['09', '27']);
        });

        it('paints both ends', () => {
            const rects = runwayMarkings(GCLP.length, GCLP.width, GCLP.ref, GCLP.surface);
            const glyphs = of(rects, 'designator');
            const low = glyphs.filter(g => g.u < 0);
            const high = glyphs.filter(g => g.u > 0);
            assert.ok(low.length > 0 && high.length > 0, 'an end went unpainted');
        });

        it('reads the right way up from each approach', () => {
            // "1" is a single bar, so "1" against "19" isolates the direction
            // without the glyph shape getting in the way. Landing on 01 the
            // numerals must climb toward +u; landing on 19, toward -u.
            const rects = runwayMarkings(2000, 45, '01/19', 'asphalt');
            const glyphs = of(rects, 'designator');
            const low = glyphs.filter(g => g.u < 0);
            const high = glyphs.filter(g => g.u > 0);
            // Both sets start at their own threshold and run inwards.
            assert.ok(Math.max(...low.map(g => g.u)) < 0);
            assert.ok(Math.min(...high.map(g => g.u)) > 0);
            // 20 m of numeral, so each set spans that much of the runway.
            const lowSpan = Math.max(...low.map(g => extent(g).u1))
                - Math.min(...low.map(g => extent(g).u0));
            assert.ok(Math.abs(lowSpan - 20) < 0.01, `numerals spanned ${lowSpan} m`);
        });

        it('centres a two-character designator across the runway', () => {
            const rects = designatorRects('27', 0, 1);
            const vs = rects.flatMap(r => [extent(r).v0, extent(r).v1]);
            const centre = (Math.min(...vs) + Math.max(...vs)) / 2;
            assert.ok(Math.abs(centre) < 1e-9, `designator centred at ${centre}`);
        });

        it('makes room for a suffix letter', () => {
            const two = designatorRects('03', 0, 1);
            const three = designatorRects('03L', 0, 1);
            const width = (rects: MarkingRect[]) => {
                const vs = rects.flatMap(r => [extent(r).v0, extent(r).v1]);
                return Math.max(...vs) - Math.min(...vs);
            };
            assert.ok(width(three) > width(two), 'the L took no width');
        });

        it('ignores a character it cannot paint', () => {
            assert.deepEqual(designatorRects('??', 0, 1), []);
        });
    });

    describe('aiming point', () => {

        it('is a pair of blocks either side of the centreline at each end', () => {
            const aiming = of(runwayMarkings(GCLP.length, GCLP.width, GCLP.ref, GCLP.surface),
                'aiming');
            assert.equal(aiming.length, 4);
            for (const block of aiming) {
                assert.equal(block.lengthM, 45);
                assert.equal(block.widthM, 6);
            }
            const sum = aiming.reduce((a, b) => a + b.v, 0);
            assert.ok(Math.abs(sum) < 1e-9, 'the blocks are not symmetric');
        });

        it('is left off a runway too short to hold one', () => {
            const short = runwayMarkings(900, 30, '07/25', 'asphalt');
            assert.equal(of(short, 'aiming').length, 0);
        });
    });

    describe('centreline', () => {

        it('is dashed and stays clear of the end markings', () => {
            const rects = runwayMarkings(GCLP.length, GCLP.width, GCLP.ref, GCLP.surface);
            const dashes = of(rects, 'centreline');
            assert.ok(dashes.length > 20, `only ${dashes.length} dashes`);
            for (const dash of dashes) {
                assert.equal(dash.v, 0);
                assert.equal(dash.lengthM, 30);
            }
            // Clear of the numerals: no dash overlaps a painted glyph bar.
            for (const dash of dashes) {
                const d = extent(dash);
                for (const glyph of of(rects, 'designator')) {
                    const g = extent(glyph);
                    const overlaps = d.u0 < g.u1 && d.u1 > g.u0
                        && d.v0 < g.v1 && d.v1 > g.v0;
                    assert.ok(!overlaps,
                        `a dash at u ${dash.u} overlaps a numeral at u ${glyph.u}`);
                }
            }
        });

        it('is centred on the runway', () => {
            const dashes = of(runwayMarkings(GCLP.length, GCLP.width, GCLP.ref, GCLP.surface),
                'centreline');
            const sum = dashes.reduce((a, b) => a + b.u, 0) / dashes.length;
            assert.ok(Math.abs(sum) < 1e-9, `dashes centred at ${sum}`);
        });
    });

    describe('edge stripes', () => {

        it('runs the full length inside both edges', () => {
            const edges = of(runwayMarkings(GCLP.length, GCLP.width, GCLP.ref, GCLP.surface),
                'edge');
            assert.equal(edges.length, 2);
            for (const edge of edges) {
                assert.equal(edge.lengthM, GCLP.length);
                assert.ok(Math.abs(edge.v) < GCLP.width / 2, 'stripe hangs off the pavement');
                assert.ok(Math.abs(edge.v) > GCLP.width / 2 - 2, 'stripe is not at the edge');
            }
        });

        it('is left off a strip too narrow to carry one', () => {
            assert.equal(of(runwayMarkings(1400, 18, '09/27', 'asphalt'), 'edge').length, 0);
        });
    });

    describe('everything stays on the pavement', () => {

        it('for a range of real runways', () => {
            const cases: Array<[number, number, string]> = [
                [3103, 45, '03L/21R'],   // Gran Canaria
                [3395, 45, '12/30'],     // Tenerife Norte
                [2312, 45, '03/21'],     // Lanzarote
                [1101, 23, '07/25'],     // Schoenhagen
                [1886, 30, '01/19'],     // Kanab
                [863, 45, '04L/22R'],    // the short parallel at Saki
            ];
            for (const [length, width, ref] of cases) {
                for (const rect of runwayMarkings(length, width, ref, 'asphalt')) {
                    const e = extent(rect);
                    assert.ok(e.u0 >= -length / 2 - 1e-9 && e.u1 <= length / 2 + 1e-9,
                        `${ref}: ${rect.kind} at u ${rect.u} runs off the end`);
                    assert.ok(e.v0 >= -width / 2 - 1e-9 && e.v1 <= width / 2 + 1e-9,
                        `${ref}: ${rect.kind} at v ${rect.v} runs off the side`);
                }
            }
        });
    });

    describe('the stencil alphabet', () => {

        it('paints every character a designator can hold', () => {
            for (const ch of '0123456789LCR') {
                assert.ok(isPaintable(ch), `${ch} has no glyph`);
            }
        });

        it('keeps every bar inside the glyph box', () => {
            for (const ch of '0123456789LCR') {
                for (const bar of glyphBars(ch)) {
                    assert.ok(bar.x >= 0 && bar.x + bar.w <= 1 + 1e-9, `${ch} bar off in x`);
                    assert.ok(bar.y >= 0 && bar.y + bar.h <= 1 + 1e-9, `${ch} bar off in y`);
                    assert.ok(bar.w >= GLYPH_STROKE - 1e-9 || bar.h >= GLYPH_STROKE - 1e-9,
                        `${ch} has a bar thinner than the stroke`);
                }
            }
        });

        it('paints nothing for a character it does not know', () => {
            assert.deepEqual(glyphBars('%'), []);
            assert.equal(isPaintable(' '), false);
        });

        it('tells the digits apart', () => {
            // A font where two digits share a bar set paints 8 for 9.
            const seen = new Map<string, string>();
            for (const ch of '0123456789') {
                const key = JSON.stringify(glyphBars(ch));
                assert.equal(seen.get(key), undefined,
                    `${ch} is painted the same as ${seen.get(key)}`);
                seen.set(key, ch);
            }
        });
    });
});

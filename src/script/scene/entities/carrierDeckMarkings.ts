/**
 * What is painted on the Kuznetsov's flight deck, as flat triangles in
 * carrier-local XZ (see carrierDeckLayout.ts for the frame). Pure geometry:
 * no THREE, no materials; carrierDeckPaint.ts drapes it on the hull.
 *
 * Read off the 1996 plan view of the ship (2.57 px/m). The angled deck has its
 * red foul lines, a white dashed centreline, an orange dashed line inboard to
 * starboard and the white touchdown disc between wires 1 and 2. Helicopter
 * spots run up the port side and down the bow. On the ski-jump: three yellow
 * take-off lanes closing on the lip, the jet-blast deflectors and hold bars at
 * each start, white crosses, the twelve silo hatches, and a light band across
 * the lip itself.
 */
import { glyphBars } from '../airfield/glyphs';
import {
    ANGLED_DECK_END_STATION_M,
    KUZ_CENTRELINE_X,
    KUZ_BOW_Z,
    KUZ_STERN_Z,
    LANDING_AREA_HALF_WIDTH_M,
    SKI_JUMP_LIP_Z,
    TAKEOFF_POSITIONS,
    angledDeckPoint,
} from './carrierDeckLayout';

export type DeckPaint = 'white' | 'yellow' | 'red' | 'dark' | 'lip';

/** XZ point, carrier-local metres. */
export interface P2 { x: number; z: number }

/** One paint's triangles: x, z per corner, three corners per triangle. */
export type DeckPaintTriangles = Map<DeckPaint, number[]>;

/** Line widths (m). */
const FOUL_LINE_W = 0.6;
const CENTRELINE_W = 0.5;
const LANE_W = 0.5;
const THIN_W = 0.3;
/** Centreline and lane dashes (m). */
const CENTRELINE_DASH_M = 6;
const CENTRELINE_GAP_M = 5;
const LANE_DASH_M = 3;
const LANE_GAP_M = 3;
/** Helicopter spot ring radius (m) and the touchdown disc's. */
const SPOT_RADIUS_M = 3;
const TOUCHDOWN_DISC_RADIUS_M = 4.3;
const TOUCHDOWN_DISC_STATION_M = 58;
const RING_SEGMENTS = 32;

/** Helicopter spots: station from the stern down the ship's centreline, and offset to starboard (m). */
const HELO_SPOTS: readonly { station: number; offset: number }[] = [
    { station: 11.7, offset: -6.2 },
    { station: 35.8, offset: -8.2 },
    { station: 63, offset: -23.7 },
    { station: 113, offset: -19.8 },
    { station: 139, offset: -19.8 },
    { station: 164, offset: -26.8 },
    { station: 187.5, offset: -27.6 },
    { station: 205, offset: -9.3 },
    { station: 228, offset: -8.2 },
];
/** Deflector panels: this far aft of the start position, this big (m). */
const DEFLECTOR_AFT_OF_START_M = 7;
const DEFLECTOR_ALONG_M = 5;
const DEFLECTOR_ACROSS_M = 9.5;
/** Hold bars ahead of the start position (m), and how long across the lane. */
const HOLD_BAR_AHEAD_M = 1.5;
const HOLD_BAR_ACROSS_M = 6;
/** The yellow helicopter circle near the stern, on the ship's centreline (station m). */
const YELLOW_SPOT_STATION_M = 23;

class Painter {
    readonly out: DeckPaintTriangles = new Map();

    tri(paint: DeckPaint, a: P2, b: P2, c: P2): void {
        let list = this.out.get(paint);
        if (list === undefined) {
            list = [];
            this.out.set(paint, list);
        }
        list.push(a.x, a.z, b.x, b.z, c.x, c.z);
    }

    quad(paint: DeckPaint, a: P2, b: P2, c: P2, d: P2): void {
        this.tri(paint, a, b, c);
        this.tri(paint, a, c, d);
    }

    /** A stripe `width` wide from a to b. */
    stripe(paint: DeckPaint, a: P2, b: P2, width: number): void {
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) return;
        const nx = (-dz / len) * width * 0.5, nz = (dx / len) * width * 0.5;
        this.quad(paint,
            { x: a.x + nx, z: a.z + nz }, { x: b.x + nx, z: b.z + nz },
            { x: b.x - nx, z: b.z - nz }, { x: a.x - nx, z: a.z - nz });
    }

    /** Dashes along a polyline, the pattern carried across its corners. */
    dashed(paint: DeckPaint, line: readonly P2[], width: number, dash: number, gap: number): void {
        let phase = 0;
        for (let i = 0; i + 1 < line.length; i++) {
            const a = line[i], b = line[i + 1];
            const len = Math.hypot(b.x - a.x, b.z - a.z);
            let t = 0;
            while (t < len) {
                const period = dash + gap;
                const inPeriod = phase % period;
                if (inPeriod < dash) {
                    const run = Math.min(dash - inPeriod, len - t);
                    this.stripe(paint, lerp(a, b, t / len), lerp(a, b, (t + run) / len), width);
                    t += run;
                    phase += run;
                } else {
                    const run = Math.min(period - inPeriod, len - t);
                    t += run;
                    phase += run;
                }
            }
        }
    }

    ring(paint: DeckPaint, c: P2, r: number, width: number): void {
        const r0 = r - width * 0.5, r1 = r + width * 0.5;
        for (let i = 0; i < RING_SEGMENTS; i++) {
            const a0 = (i / RING_SEGMENTS) * Math.PI * 2, a1 = ((i + 1) / RING_SEGMENTS) * Math.PI * 2;
            this.quad(paint,
                polar(c, r0, a0), polar(c, r1, a0), polar(c, r1, a1), polar(c, r0, a1));
        }
    }

    disc(paint: DeckPaint, c: P2, r: number): void {
        for (let i = 0; i < RING_SEGMENTS; i++) {
            const a0 = (i / RING_SEGMENTS) * Math.PI * 2, a1 = ((i + 1) / RING_SEGMENTS) * Math.PI * 2;
            this.tri(paint, c, polar(c, r, a0), polar(c, r, a1));
        }
    }

    /** A filled rectangle centred on c, `along` × `across` on the ship's axes (Z, X). */
    rect(paint: DeckPaint, c: P2, along: number, across: number): void {
        const hz = along * 0.5, hx = across * 0.5;
        this.quad(paint,
            { x: c.x - hx, z: c.z - hz }, { x: c.x + hx, z: c.z - hz },
            { x: c.x + hx, z: c.z + hz }, { x: c.x - hx, z: c.z + hz });
    }

    /** A rectangle's outline, `line` wide, on the ship's axes. */
    outline(paint: DeckPaint, c: P2, along: number, across: number, line: number): void {
        const hz = along * 0.5, hx = across * 0.5;
        this.rect(paint, { x: c.x, z: c.z - hz + line * 0.5 }, line, across);
        this.rect(paint, { x: c.x, z: c.z + hz - line * 0.5 }, line, across);
        this.rect(paint, { x: c.x - hx + line * 0.5, z: c.z }, along - 2 * line, line);
        this.rect(paint, { x: c.x + hx - line * 0.5, z: c.z }, along - 2 * line, line);
    }

    /** A plus sign: `along` long down the ship, `across` wide. */
    cross(paint: DeckPaint, c: P2, along: number, across: number, line: number): void {
        this.rect(paint, c, along, line);
        this.rect(paint, { x: c.x - across * 0.25 - line * 0.25, z: c.z }, line, across * 0.5 - line * 0.5);
        this.rect(paint, { x: c.x + across * 0.25 + line * 0.25, z: c.z }, line, across * 0.5 - line * 0.5);
    }

    /**
     * Stencil digits centred on c, `height` tall, reading from the stern (the
     * glyph's up is the bow, −Z; its right is starboard, +X).
     */
    text(paint: DeckPaint, c: P2, s: string, height: number): void {
        const w = height * 0.6;
        const gap = height * 0.2;
        const total = s.length * w + (s.length - 1) * gap;
        let left = c.x - total * 0.5;
        for (const ch of s) {
            for (const bar of glyphBars(ch)) {
                const x0 = left + bar.x * w, x1 = left + (bar.x + bar.w) * w;
                const z0 = c.z + height * 0.5 - bar.y * height, z1 = c.z + height * 0.5 - (bar.y + bar.h) * height;
                this.quad(paint, { x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 });
            }
            left += w + gap;
        }
    }
}

function lerp(a: P2, b: P2, t: number): P2 {
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

function polar(c: P2, r: number, a: number): P2 {
    return { x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r };
}

/** Ship-centreline station and offset (m) to carrier-local XZ. */
function ship(station: number, offset: number): P2 {
    return { x: KUZ_CENTRELINE_X + offset, z: KUZ_STERN_Z - station };
}

function angled(station: number, offset = 0): P2 {
    return angledDeckPoint(station, offset);
}

/** The whole deck's paint, by paint. */
export function carrierDeckMarkings(): DeckPaintTriangles {
    const p = new Painter();

    // --- Angled deck ---------------------------------------------------------
    const end = ANGLED_DECK_END_STATION_M + 10;
    const hw = LANDING_AREA_HALF_WIDTH_M;
    // Red foul lines either side of the landing area, stern to the port edge
    // (the deck itself ends them where it runs out).
    p.stripe('red', angled(2, -hw), angled(end, -hw), FOUL_LINE_W);
    p.stripe('red', angled(2, hw), angled(190, hw), FOUL_LINE_W);
    // Orange dashed line inboard to starboard, parallel to the axis.
    p.dashed('red', [angled(5, hw + 3), angled(140, hw + 3)], THIN_W * 1.5, 4, 4);
    // White dashed centreline from the stern to the port edge.
    p.dashed('white', [angled(1), angled(end)], CENTRELINE_W, CENTRELINE_DASH_M, CENTRELINE_GAP_M);
    // The white touchdown disc on the centreline.
    p.disc('white', angled(TOUCHDOWN_DISC_STATION_M), TOUCHDOWN_DISC_RADIUS_M);

    // --- Helicopter spots ----------------------------------------------------
    HELO_SPOTS.forEach((s, i) => {
        const c = ship(s.station, s.offset);
        p.ring('white', c, SPOT_RADIUS_M, THIN_W);
        // Heading line toward the bow from the ring.
        p.stripe('white', { x: c.x, z: c.z - SPOT_RADIUS_M }, { x: c.x, z: c.z - SPOT_RADIUS_M - 2.5 }, THIN_W);
        p.text('white', c, String(i + 1), 1.8);
    });
    const yellow = ship(YELLOW_SPOT_STATION_M, 0);
    p.ring('yellow', yellow, SPOT_RADIUS_M, THIN_W);
    p.ring('yellow', yellow, SPOT_RADIUS_M * 0.45, THIN_W);
    p.cross('yellow', yellow, SPOT_RADIUS_M * 1.6, SPOT_RADIUS_M * 1.6, THIN_W);

    // --- Ski-jump ------------------------------------------------------------
    // Take-off lanes: yellow dashes from each start up to the foot of the lip.
    for (const pos of TAKEOFF_POSITIONS) {
        p.dashed('yellow', pos.lane, LANE_W, LANE_DASH_M, LANE_GAP_M);
    }
    // At each start: the jet-blast deflector panels behind the aircraft and
    // two orange hold bars across the lane in front of its nose wheel.
    for (const pos of TAKEOFF_POSITIONS) {
        const deflector = { x: pos.start.x, z: pos.start.z + DEFLECTOR_AFT_OF_START_M };
        p.outline('dark', deflector, DEFLECTOR_ALONG_M, DEFLECTOR_ACROSS_M, THIN_W);
        p.rect('dark', deflector, THIN_W, DEFLECTOR_ACROSS_M);
        for (const dz of [-HOLD_BAR_AHEAD_M, -HOLD_BAR_AHEAD_M - 1.2]) {
            p.rect('red', { x: pos.start.x, z: pos.start.z + dz }, FOUL_LINE_W, HOLD_BAR_ACROSS_M);
        }
    }
    // Light-grey double bars between positions 1 and 2.
    for (const z of [-57.7, -63.8]) {
        for (const dx of [0.9, 3.2]) {
            p.rect('white', { x: KUZ_CENTRELINE_X + dx, z }, 5, 1.2);
        }
    }
    // White crosses up the run.
    for (const c of [
        [1.5, -74.4], [-8.5, -95.5], [1.5, -95.5], [10, -95.5], [-6, -118.9], [7.4, -118.9],
    ] as const) {
        p.cross('white', { x: KUZ_CENTRELINE_X + c[0], z: c[1] }, 12, 6, THIN_W);
    }
    // The twelve silo hatches, two rows of six, between the lanes.
    for (let row = 0; row < 2; row++) {
        for (let k = 0; k < 6; k++) {
            const c = { x: KUZ_CENTRELINE_X - 0.2 + row * 3.6 - 0.1, z: -105.3 - k * 3.8 };
            p.outline('dark', c, 3.4, 3.2, THIN_W);
        }
    }
    // The light band across the lip.
    p.rect('lip', { x: KUZ_CENTRELINE_X, z: (SKI_JUMP_LIP_Z + KUZ_BOW_Z) * 0.5 }, SKI_JUMP_LIP_Z - KUZ_BOW_Z, 40);

    // --- Lift ------------------------------------------------------------------
    // The aft starboard lift's outline (the deck edge ends it outboard).
    p.outline('dark', { x: 29.5, z: 56 }, 14, 13, THIN_W);

    return p.out;
}

/**
 * Airfields on the F12 map as an ICAO 1:500 000 chart draws them: a ring
 * for a civil field, a ring in a ring for a military one, a ring with four
 * studs for one with an instrument approach, and an international airport
 * as its runway pattern over the silhouette of the field. Through each ring
 * a bar lies along the longest runway, solid when it is paved and hollow
 * when it is not.
 *
 * The bar is turned by projecting the runway's thresholds, so it follows
 * the map however it is tilted or the field lies.
 */

import { Airfield, AirfieldRunway } from '../terrain/airfields';

type PageOf = (lat: number, lon: number, heightM: number) => { x: number; y: number } | undefined;
/** {@link PageOf} on one field's ground. */
type FieldPageOf = (lat: number, lon: number) => { x: number; y: number } | undefined;

/** The chart's aerodrome blue. */
const CHART_BLUE = '#1c2a80';
const HALO = '#ffffff';
const RING_R = 7;
/** Half the runway bar, px: it reaches out past the ring both sides. */
const BAR_HALF = 13;
/** An international airport's pattern: its longest runway this long, px, at every zoom. */
const PATTERN_PX = 24;
/** Width (px) the taxiways and apron edges are drawn at to run together into the field's silhouette. */
const SILHOUETTE_STROKE = 4;
/** Further out than this (m/px) small fields are left off and no field is named. */
const GA_MAX_MPP = 250;
const LABEL_MAX_MPP = 120;
/** Symbols closer than this (px, centre to centre) overlap; the lesser field is left off. */
const MIN_SEPARATION_PX = 2 * BAR_HALF;
/** Which field keeps its symbol where two would overlap: lower first, then the longer runway. */
const KIND_RANK: Record<string, number> = { international: 0, military: 1, regional: 2, ga: 4 };

/**
 * The symbols of `airfields` that fall within `width` x `height` (page px,
 * from `left`). Zoomed out, where symbols would overlap, only the biggest
 * field of a cluster is drawn: international before military before
 * regional before small, then the longest runway.
 */
export function airfieldSymbolsSvg(
    airfields: Iterable<Airfield>, pageOf: PageOf, mpp: number, left: number, width: number, height: number,
): string {
    const placed: Array<{ a: Airfield; runway: AirfieldRunway; p: { x: number; y: number }; at: FieldPageOf }> = [];
    for (const a of airfields) {
        if (a.kind === 'ga' && mpp > GA_MAX_MPP) {
            continue;
        }
        const runway = longestRunway(a);
        // At the field's height, not sea level: on a tilted map that is the difference of a field's width.
        const at: FieldPageOf = (lat, lon) => pageOf(lat, lon, a.plane.heightMsl);
        const mid = runwaysMiddle(a);
        const p = mid && at(mid.lat, mid.lon);
        if (!runway || !p || p.x < left - 40 || p.x > left + width + 40 || p.y < -40 || p.y > height + 40) {
            continue;
        }
        placed.push({ a, runway, p, at });
    }
    placed.sort((u, v) => (KIND_RANK[u.a.kind] ?? 3) - (KIND_RANK[v.a.kind] ?? 3) || v.runway.lengthM - u.runway.lengthM);
    const kept: Array<{ x: number; y: number }> = [];
    const parts: string[] = [];
    for (const { a, runway, p, at } of placed) {
        if (kept.some(k => (k.x - p.x) ** 2 + (k.y - p.y) ** 2 < MIN_SEPARATION_PX ** 2)) {
            continue;
        }
        kept.push(p);
        const body = a.kind === 'international'
            ? patternSvg(a, p, at)
            : ringSvg(a.kind, barAngleDeg(runway, at), paved(runway));
        const label = mpp <= LABEL_MAX_MPP
            ? `<text x="${a.kind === 'international' ? PATTERN_PX / 2 + 4 : RING_R + 9}" dy="4" fill="${CHART_BLUE}" `
                + `stroke="${HALO}" stroke-width="3" paint-order="stroke">${escapeXml(a.icao || a.name)}</text>`
            : '';
        parts.push(`<g transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">${body}${label}</g>`);
    }
    return `<g class="chart-aerodromes">${parts.join('')}</g>`;
}

/** The longest runway an aircraft lands on: not a ski-jump run-up or a steel deck. */
function longestRunway(a: Airfield): AirfieldRunway | undefined {
    let best: AirfieldRunway | undefined;
    for (const r of a.runways) {
        if (!r.skiJump && r.surface !== 'metal' && (!best || r.lengthM > best.lengthM)) {
            best = r;
        }
    }
    return best;
}

/**
 * Where the symbol sits: the middle of the box round every threshold of the
 * runways landed on, so it centres on one runway and between two - not on the
 * aerodrome reference point, which OSM often puts by the terminal.
 */
function runwaysMiddle(a: Airfield): { lat: number; lon: number } | undefined {
    let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
    for (const r of a.runways) {
        if (r.skiJump || r.surface === 'metal') {
            continue;
        }
        for (const [lat, lon] of r.thresholds.length ? r.thresholds : [[r.lat, r.lon]]) {
            south = Math.min(south, lat);
            north = Math.max(north, lat);
            west = Math.min(west, lon);
            east = Math.max(east, lon);
        }
    }
    return south <= north ? { lat: (south + north) / 2, lon: (west + east) / 2 } : undefined;
}

function paved(r: AirfieldRunway): boolean {
    return r.surface === 'asphalt' || r.surface === 'concrete';
}

/** On-screen angle (deg, clockwise from +x) of the runway, from its thresholds; from its bearing with north up when they do not project. */
function barAngleDeg(r: AirfieldRunway, pageOf: FieldPageOf): number {
    const [t0, t1] = r.thresholds;
    const a = t0 && pageOf(t0[0], t0[1]);
    const b = t1 && pageOf(t1[0], t1[1]);
    if (a && b && Math.hypot(b.x - a.x, b.y - a.y) > 1e-3) {
        return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    }
    return r.headingDeg - 90;
}

/** Ring, inner ring or studs by kind, and the runway bar across it. */
function ringSvg(kind: string, angleDeg: number, solid: boolean): string {
    const stroke = (w: number) => `fill="none" stroke="${CHART_BLUE}" stroke-width="${w}"`;
    let out = `<circle r="${RING_R}" fill="none" stroke="${HALO}" stroke-width="6"/>`;
    if (kind === 'regional') {
        // Studs at the four map quarters, under the ring so it closes over their roots.
        for (const [x, y] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
            out += `<rect x="${x * (RING_R + 3) - 2.5}" y="${y * (RING_R + 3) - 2.5}" width="5" height="5" `
                + `fill="${CHART_BLUE}" stroke="${HALO}" stroke-width="1"/>`;
        }
    }
    out += `<circle r="${RING_R}" ${stroke(kind === 'regional' ? 3.5 : 2.5)}/>`;
    if (kind === 'military') {
        out += `<circle r="${RING_R - 3.5}" ${stroke(1.5)}/>`;
    }
    const bar = `x="${-BAR_HALF}" y="-2" width="${BAR_HALF * 2}" height="4"`;
    out += `<g transform="rotate(${angleDeg.toFixed(1)})">`
        + `<rect ${bar} fill="${HALO}" stroke="${HALO}" stroke-width="3"/>`
        + `<rect ${bar} fill="${solid ? CHART_BLUE : HALO}" stroke="${CHART_BLUE}" stroke-width="${solid ? 0 : 1.2}"/>`
        + '</g>';
    return out;
}

/**
 * An international airport as the chart draws one: its silhouette in solid
 * blue - the aprons filled and the taxiways drawn fat until they run together
 * into the shape of the field - and over it every runway between its
 * thresholds, a blue bar with a white middle that reaches out of the
 * silhouette. All about `p` and scaled so the longest runway is
 * {@link PATTERN_PX}, so it is the same size at every zoom.
 *
 * The silhouette comes from the field's pavement rather than its OSM boundary,
 * which the bake does not carry into airfields.json.
 */
function patternSvg(a: Airfield, p: { x: number; y: number }, pageOf: FieldPageOf): string {
    const lines: Array<{ x0: number; y0: number; x1: number; y1: number; solid: boolean }> = [];
    let longest = 0;
    for (const r of a.runways) {
        const [t0, t1] = r.thresholds;
        const u = !r.skiJump && r.surface !== 'metal' && t0 && t1 ? pageOf(t0[0], t0[1]) : undefined;
        const v = u && pageOf(t1[0], t1[1]);
        if (!u || !v) {
            continue;
        }
        lines.push({ x0: u.x - p.x, y0: u.y - p.y, x1: v.x - p.x, y1: v.y - p.y, solid: paved(r) });
        longest = Math.max(longest, Math.hypot(v.x - u.x, v.y - u.y));
    }
    if (lines.length === 0 || longest === 0) {
        return ringSvg('regional', 0, true);
    }
    const k = PATTERN_PX / longest;
    // `[lat, lon]` points as symbol coordinates, dropping any within half a pixel of the last.
    const pointsOf = (ll: number[][]): string => {
        const out: string[] = [];
        let last: { x: number; y: number } | undefined;
        for (const [lat, lon] of ll) {
            const q = pageOf(lat, lon);
            if (!q) {
                continue;
            }
            const x = (q.x - p.x) * k;
            const y = (q.y - p.y) * k;
            if (!last || Math.hypot(x - last.x, y - last.y) >= 0.5) {
                out.push(`${x.toFixed(1)},${y.toFixed(1)}`);
                last = { x, y };
            }
        }
        return out.join(' ');
    };
    const shape = a.aprons.map(ap => pointsOf(ap.ring)).filter(s => s).map(s => `<polygon points="${s}"/>`).join('')
        + a.taxiways.map(t => pointsOf(t.points)).filter(s => s.includes(' ')).map(s => `<polyline points="${s}"/>`).join('');
    const fat = (colour: string, w: number) => shape
        ? `<g fill="${colour}" stroke="${colour}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round">${shape}</g>`
        : '';
    const seg = (l: typeof lines[number], colour: string, w: number) =>
        `<line x1="${(l.x0 * k).toFixed(1)}" y1="${(l.y0 * k).toFixed(1)}" x2="${(l.x1 * k).toFixed(1)}" `
        + `y2="${(l.y1 * k).toFixed(1)}" stroke="${colour}" stroke-width="${w}" stroke-linecap="round"/>`;
    // A white outline round the whole symbol against the map, under it so none shows inside;
    // the white middle is wider on an unpaved runway, as the ring symbols' hollow bar.
    return fat(HALO, SILHOUETTE_STROKE + 3) + lines.map(l => seg(l, HALO, 7)).join('')
        + fat(CHART_BLUE, SILHOUETTE_STROKE)
        + lines.map(l => seg(l, CHART_BLUE, 4) + seg(l, HALO, l.solid ? 1.2 : 2)).join('');
}

function escapeXml(s: string): string {
    return s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}

/**
 * From an OSM building to the parameters the runtime extrudes (PBH1): how
 * high, what roof, which way the ridge runs, what colours - phase 1 of
 * docs/terrain-buildings.md, where every answer comes from the OSM tags when
 * a mapper gave one and from rules of thumb when not.
 *
 * Above everything, where an official LoD2 model stands on the footprint
 * (phase 4, tools/import_lod2.py): its roof form, eave, ridge and ridge
 * direction - the surveying office's own answer. Then:
 *
 * Where a surface model was fitted (phase 3, tools/measure_roof_shapes.py)
 * and the fit's heights are confident, its eave, ridge and ridge direction
 * win over everything below, tags included: measured beats mapped beats
 * guessed. Its roof form does not, unless the bake asks (`surfaceForms`):
 * against Bavaria's LoD2 on Garmisch, ridge heights from the surface were
 * off by 0.83 m on average where the rules were off by 2.05, and the ridge
 * direction was right for 89 % of gables where the footprint's long axis
 * was right for 74 % - but a non-gable form called from the image-matched
 * surface was right only 11-27 % of the time (docs/terrain-buildings.md,
 * phase 3).
 *
 * The rules of thumb, in order of how much they matter from the air:
 *
 *  - Height by kind and footprint, calibrated on the surface-model medians
 *    of 6 000 Garmisch buildings (house eave 5.2 m, residential 6.7, garage
 *    2.3; the others blended with the first guesses where few were
 *    measured). Tagged levels win over the rule, a tagged height over both.
 *  - Roof form by kind, size and region: pitched for houses, barns and
 *    churches, flat for anything commercial, industrial or over 1000 m^2,
 *    and nearly everything flat on Gran Canaria. A small share of squarish
 *    houses gets a hip roof: LoD2 has Garmisch 87 % gabled, 3 % hipped
 *    (tools/eval_buildings.ts scores these rules against it).
 *  - The ridge along the footprint's minimum-area rectangle's long side
 *    (roof:orientation=across turns it), the pitch by region: 38 degrees in
 *    the lowlands, 30 in the Alps.
 *  - Colours: the roof's as measured in an orthophoto (phase 2,
 *    tools/measure_buildings.py) when the measurement is confident, drawn
 *    as that colour and snapped to the tone table for the palette modes;
 *    else roof:colour / building:colour snapped to the tone table; else
 *    drawn per building from a regional mix, seeded by the OSM id so a
 *    re-bake gives every house the same colour again.
 *
 * Everything is in the PBH1 local frame of the tile: (u, v) horizontal
 * metres, heights along up.
 */

import { BuildingTone, ROOF_TONES, WALL_TONES, nearestTone } from '../../src/script/terrain/buildingTones';
import {
    BuildingKind, PBH_FLAG_NO_WALLS, PBH_MAX_RING_VERTS, PbhEncodeBuilding, RoofForm, buildingProminence,
} from '../../src/script/terrain/pbh';
import { MeasuredRoof, dehazed } from './buildingColourStore';
import { LOD2_MATCH_MERGED, LOD2_MATCH_ONE, Lod2Building } from './buildingLod2Store';
import { MeasuredShape, SHAPE_ABSENT, SHAPE_FORM_SURE } from './buildingShapeStore';
import { BvrBuilding, ORIENTATION_ACROSS } from './bvr';

export type Ring = Array<[number, number]>;

/** A storey, floor to floor. */
export const LEVEL_M = 3.0;
/** Plinth and the ground floor's extra height, added once to levels x LEVEL_M. */
const PLINTH_M = 0.4;
/** Below this footprint area a building is not drawn. */
export const MIN_AREA_M2 = 6;
/** Outline simplification: a vertex this close to its neighbours' chord goes. */
const SIMPLIFY_M = 0.3;
/** Courtyards smaller than this are filled in. */
const MIN_COURTYARD_M2 = 4;
/** The walls reach this far under the lowest ground of the footprint. */
const FOOT_BURY_M = 0.5;
/** The eave stays at least this far above the highest ground under the footprint. */
const MIN_EAVE_CLEARANCE_M = 2.2;
/** Below this confidence a measured roof colour is not used (see measure_buildings.py sample_roof). */
export const MIN_ROOF_CONFIDENCE = 0.35;
/** Chroma kept from a measured roof colour (buildingColourStore.ts dehazed); the haze is already out. */
export const ROOF_CHROMA = 1.1;
/** Below this confidence a fitted roof shape is not used (see measure_roof_shapes.py). */
export const MIN_SHAPE_CONFIDENCE = 0.4;
/** A fit whose ridge stands lower than this is a garden wall or a fence, not a building's roof. */
export const MIN_FITTED_RIDGE_M = 2.0;

const DEG = Math.PI / 180;

export function signedArea(ring: ReadonlyArray<readonly [number, number]>): number {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    }
    return a / 2;
}

/** A deterministic number in [0, 1) from an OSM id and a salt. */
export function idRandom(id: number, salt: number): number {
    let h = (Math.floor(Math.abs(id)) ^ (salt * 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    // Mix in the high part of ids beyond 2^32.
    h = (h ^ Math.floor(Math.abs(id) / 4294967296)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    return ((h ^ (h >>> 12)) >>> 0) / 4294967296;
}

function pick<T>(r: number, choices: ReadonlyArray<readonly [T, number]>): T {
    const total = choices.reduce((s, c) => s + c[1], 0);
    let x = r * total;
    for (const [value, weight] of choices) {
        x -= weight;
        if (x < 0) {
            return value;
        }
    }
    return choices[choices.length - 1][0];
}

/**
 * A closed ring with every vertex removed that sits within `tolerance` of the
 * chord between its neighbours, the least significant first. Never fewer than
 * three vertices.
 */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
    const pts = ring.slice();
    const dist = (i: number) => {
        const a = pts[(i + pts.length - 1) % pts.length], p = pts[i], b = pts[(i + 1) % pts.length];
        const ex = b[0] - a[0], ey = b[1] - a[1];
        const len = Math.hypot(ex, ey);
        if (len < 1e-9) {
            return Math.hypot(p[0] - a[0], p[1] - a[1]);
        }
        return Math.abs((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / len;
    };
    while (pts.length > 3) {
        let best = -1;
        let bestD = tolerance;
        for (let i = 0; i < pts.length; i++) {
            const d = dist(i);
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        if (best < 0) {
            break;
        }
        pts.splice(best, 1);
    }
    return pts;
}

export interface OrientedRect {
    /** Direction of the long side, radians from u toward v. */
    angle: number;
    long: number;
    short: number;
}

/** The minimum-area rectangle around a set of points, by rotating calipers over the hull. */
export function minAreaRect(points: ReadonlyArray<readonly [number, number]>): OrientedRect {
    const sorted = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o: readonly number[], a: readonly number[], b: readonly number[]) =>
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: Array<readonly [number, number]> = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
            lower.pop();
        }
        lower.push(p);
    }
    const upper: Array<readonly [number, number]> = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
        const p = sorted[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
            upper.pop();
        }
        upper.push(p);
    }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    let best: OrientedRect = { angle: 0, long: 0, short: 0 };
    let bestArea = Infinity;
    for (let i = 0; i < hull.length; i++) {
        const a = hull[i], b = hull[(i + 1) % hull.length];
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const c = Math.cos(ang), s = Math.sin(ang);
        let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
        for (const p of hull) {
            const ps = p[0] * c + p[1] * s, pt = -p[0] * s + p[1] * c;
            sMin = Math.min(sMin, ps); sMax = Math.max(sMax, ps);
            tMin = Math.min(tMin, pt); tMax = Math.max(tMax, pt);
        }
        const ls = sMax - sMin, lt = tMax - tMin;
        if (ls * lt < bestArea - 1e-9) {
            bestArea = ls * lt;
            best = ls >= lt ? { angle: ang, long: ls, short: lt } : { angle: ang + Math.PI / 2, long: lt, short: ls };
        }
    }
    return best;
}

/** The OSM roof:shape codes this bake reads, onto the forms the runtime builds. */
export function roofFormOfShape(code: number): RoofForm | undefined {
    switch (code) {
        case 1: return RoofForm.Flat;
        case 2: return RoofForm.Gabled;
        case 3: return RoofForm.Hipped;
        case 4: return RoofForm.HalfHipped;
        case 5: return RoofForm.Skillion;
        case 6: return RoofForm.Pyramidal;
        case 7: return RoofForm.Gabled; // gambrel
        case 8: return RoofForm.Hipped; // mansard
        case 9: return RoofForm.Pyramidal; // dome
        case 10: return RoofForm.Pyramidal; // onion
        case 11: return RoofForm.Gabled; // round (a barrel vault)
        case 12: return RoofForm.Gabled; // saltbox
        case 13: return RoofForm.Pyramidal; // cone
        default: return undefined;
    }
}

export interface Region {
    /** Gran Canaria and the like: flat roofs, white walls. */
    flatRoofs: boolean;
    /** The Alps: shallow pitches, timber walls on farms. */
    alpine: boolean;
    /** The North German plain: brick. */
    brick: boolean;
}

export function regionAt(lat: number, lon: number): Region {
    return {
        flatRoofs: lat < 36,
        alpine: lat > 45.5 && lat < 47.9 && lon > 5.9 && lon < 16.5,
        brick: lat > 52.3 && lon > 6 && lon < 15,
    };
}

/** Eave height in metres for a building nobody tagged, by kind and footprint. */
function defaultEaveM(kind: number, area: number): number {
    switch (kind) {
        case BuildingKind.House: return area > 250 ? 6.5 : 5.2;
        case BuildingKind.Residential: return area > 400 ? 9.5 : 6.7;
        case BuildingKind.Small: return 2.4;
        case BuildingKind.Farm: return 4.0;
        case BuildingKind.Greenhouse: return 3.0;
        case BuildingKind.Industrial: return area > 3000 ? 9.0 : 6.0;
        case BuildingKind.Commercial: return area > 2000 ? 8.0 : 6.5;
        case BuildingKind.Civic: return 8.0;
        case BuildingKind.Religious: return area > 600 ? 15.0 : 9.0;
        case BuildingKind.Roof: return 3.3;
        case BuildingKind.Tower: return 20.0;
        case BuildingKind.Tank: return 10.0;
        case BuildingKind.Ruin: return 3.0;
        default:
            // building=yes: read what it probably is off its size.
            if (area < 40) {
                return 2.4;
            }
            if (area < 300) {
                return 5.0;
            }
            if (area < 1500) {
                return 7.0;
            }
            return 8.0;
    }
}

function defaultForm(kind: number, area: number, rect: OrientedRect, region: Region, id: number): RoofForm {
    if (kind === BuildingKind.Religious) {
        return RoofForm.Gabled;
    }
    if (region.flatRoofs) {
        return RoofForm.Flat;
    }
    switch (kind) {
        case BuildingKind.Industrial:
        case BuildingKind.Commercial:
        case BuildingKind.Tank:
        case BuildingKind.Roof:
        case BuildingKind.Ruin:
            return RoofForm.Flat;
        case BuildingKind.Small:
            // Garages and sheds are mostly pitched too: LoD2 in Garmisch had a
            // flat rule for everything under 40 m^2 wrong three times in four.
            return area < 15 ? RoofForm.Flat : RoofForm.Gabled;
        case BuildingKind.Greenhouse:
            return RoofForm.Gabled;
        case BuildingKind.Tower:
            return RoofForm.Pyramidal;
    }
    if (area > 1000 || (kind === BuildingKind.Residential && area > 600) || (kind === BuildingKind.Yes && area < 15)) {
        return RoofForm.Flat;
    }
    if (kind === BuildingKind.Civic) {
        return area > 500 ? RoofForm.Flat : RoofForm.Hipped;
    }
    // A small share of squarish houses hipped, so a village is not one gable
    // repeated - small because that is what LoD2 says (3 % in Garmisch, and a
    // random pick of which is mostly wrong: these cost more than they win).
    const squarish = rect.long < rect.short * 1.35;
    if (kind !== BuildingKind.Farm && idRandom(id, 1) < (squarish ? 0.04 : 0.01)) {
        return RoofForm.Hipped;
    }
    return RoofForm.Gabled;
}

function pitchRad(kind: number, region: Region): number {
    if (kind === BuildingKind.Religious) {
        return 50 * DEG;
    }
    if (kind === BuildingKind.Greenhouse) {
        return 25 * DEG;
    }
    if (region.alpine) {
        return (kind === BuildingKind.Farm ? 25 : 30) * DEG;
    }
    return (kind === BuildingKind.Farm ? 32 : 38) * DEG;
}

function tones(b: BvrBuilding, form: RoofForm, region: Region): { roof: BuildingTone; wall: BuildingTone } {
    const r1 = idRandom(b.id, 2), r2 = idRandom(b.id, 3);
    const kind = b.kind;
    let roof: BuildingTone;
    let wall: BuildingTone;
    if (kind === BuildingKind.Greenhouse) {
        return { roof: BuildingTone.RoofGlass, wall: BuildingTone.RoofGlass };
    }
    if (form === RoofForm.Flat) {
        roof = region.flatRoofs
            ? pick(r1, [[BuildingTone.RoofWhite, 5], [BuildingTone.RoofGrey, 4], [BuildingTone.RoofTileRed, 1]])
            : kind === BuildingKind.Industrial
                ? pick(r1, [[BuildingTone.RoofMetal, 5], [BuildingTone.RoofGrey, 5]])
                : pick(r1, [[BuildingTone.RoofGrey, 7], [BuildingTone.RoofSlate, 2], [BuildingTone.RoofWhite, 1]]);
    } else if (kind === BuildingKind.Religious) {
        roof = pick(r1, [[BuildingTone.RoofSlate, 5], [BuildingTone.RoofTileRed, 3], [BuildingTone.RoofCopper, 2]]);
    } else if (kind === BuildingKind.Farm) {
        roof = pick(r1, [[BuildingTone.RoofTileRed, 4], [BuildingTone.RoofMetal, 3], [BuildingTone.RoofTileBrown, 3]]);
    } else if (region.alpine) {
        roof = pick(r1, [[BuildingTone.RoofTileBrown, 4], [BuildingTone.RoofSlate, 3], [BuildingTone.RoofTileRed, 2],
            [BuildingTone.RoofGrey, 1]]);
    } else {
        roof = pick(r1, [[BuildingTone.RoofTileRed, 9], [BuildingTone.RoofTileBrown, 5], [BuildingTone.RoofSlate, 5],
            [BuildingTone.RoofGrey, 1]]);
    }
    switch (kind) {
        case BuildingKind.Industrial:
        case BuildingKind.Tank:
            wall = pick(r2, [[BuildingTone.WallMetal, 5], [BuildingTone.WallConcrete, 5]]);
            break;
        case BuildingKind.Commercial:
        case BuildingKind.Civic:
            wall = pick(r2, [[BuildingTone.WallPlaster, 6], [BuildingTone.WallConcrete, 4]]);
            break;
        case BuildingKind.Farm:
            wall = region.alpine
                ? pick(r2, [[BuildingTone.WallWood, 6], [BuildingTone.WallPlaster, 4]])
                : region.brick
                    ? pick(r2, [[BuildingTone.WallBrick, 6], [BuildingTone.WallWood, 2], [BuildingTone.WallPlaster, 2]])
                    : pick(r2, [[BuildingTone.WallPlaster, 5], [BuildingTone.WallWood, 3], [BuildingTone.WallBrick, 2]]);
            break;
        default:
            wall = region.brick
                ? pick(r2, [[BuildingTone.WallBrick, 5], [BuildingTone.WallPlaster, 5]])
                : region.alpine
                    ? pick(r2, [[BuildingTone.WallPlaster, 8], [BuildingTone.WallWood, 2]])
                    : pick(r2, [[BuildingTone.WallPlaster, 9], [BuildingTone.WallBrick, 1]]);
    }
    if (b.roofColour >= 0) {
        roof = nearestTone(b.roofColour, ROOF_TONES);
    }
    if (b.wallColour >= 0) {
        wall = nearestTone(b.wallColour, WALL_TONES);
    }
    return { roof, wall };
}

export interface PlanInput {
    building: BvrBuilding;
    /** Its rings in the tile's local frame, (u, v) metres, as decoded. */
    rings: Ring[];
    lat: number;
    lon: number;
    /** Unit vector toward north in (u, v), for roof:direction. */
    north: [number, number];
    /** Height along up of the ground drawn at (u, v), undefined off the tile's land. */
    ground: (u: number, v: number) => number | undefined;
    /** Its roof as measured in an orthophoto, if it was. */
    measured?: MeasuredRoof;
    /** Its roof as fitted to a surface model, if it was. */
    shape?: MeasuredShape;
    /** Take the fitted roof form too, not only heights and ridge (see the notes above). */
    surfaceForms?: boolean;
    /** The LoD2 building(s) standing on it, if any were matched. */
    lod2?: Lod2Building;
}

export type HeightSource = 'lod2' | 'surface' | 'height' | 'levels' | 'default';
export type FormSource = 'lod2' | 'surface' | 'tag' | 'rules';

export interface PlannedBuilding extends PbhEncodeBuilding {
    areaM2: number;
    prominence: number;
    heightSource: HeightSource;
    formTagged: boolean;
    roofMeasured: boolean;
    /** The fitted surface's form and ridge were used, not only its heights. */
    formFitted: boolean;
    /** The surface model shows nothing on this footprint (demolished, or built since). */
    shapeAbsent: boolean;
    formSource: FormSource;
}

/** The building's PBH1 record, or undefined when it is too small or stands on no drawn land. */
export function planBuilding(input: PlanInput): PlannedBuilding | undefined {
    const b = input.building;
    if (input.rings.length === 0 || input.rings[0].length < 3 || b.kind === BuildingKind.Airfield) {
        return undefined;
    }
    // Outline counter-clockwise, courtyards clockwise, both simplified.
    let outer = simplifyRing(input.rings[0], SIMPLIFY_M);
    if (signedArea(outer) < 0) {
        outer = outer.reverse();
    }
    for (let tol = SIMPLIFY_M * 2; outer.length > PBH_MAX_RING_VERTS; tol *= 2) {
        outer = simplifyRing(outer, tol);
    }
    const holes: Ring[] = [];
    for (const ring of input.rings.slice(1)) {
        let h = simplifyRing(ring, SIMPLIFY_M);
        if (h.length < 3 || Math.abs(signedArea(h)) < MIN_COURTYARD_M2) {
            continue;
        }
        if (signedArea(h) > 0) {
            h = h.reverse();
        }
        for (let tol = SIMPLIFY_M * 2; h.length > PBH_MAX_RING_VERTS; tol *= 2) {
            h = simplifyRing(h, tol);
        }
        holes.push(h);
    }
    const area = signedArea(outer) + holes.reduce((s, h) => s + signedArea(h), 0);
    if (area < MIN_AREA_M2) {
        return undefined;
    }
    const rect = minAreaRect(outer);
    const region = regionAt(input.lat, input.lon);

    // --- form ----------------------------------------------------------------
    const tagged = roofFormOfShape(b.roofShape);
    let form = tagged ?? defaultForm(b.kind, area, rect, region, b.id);
    // A sprawling outline under a guessed pitched roof reads as a mess of
    // gable ends; flat is the safer guess.
    const rectangularity = area / Math.max(1e-6, rect.long * rect.short);
    if (tagged === undefined && form !== RoofForm.Flat && outer.length > 12 && rectangularity < 0.6) {
        form = RoofForm.Flat;
    }

    // --- heights above the reference ground ------------------------------------
    const jitter = 0.92 + 0.16 * idRandom(b.id, 4);
    const pitch = pitchRad(b.kind, region);
    const span = form === RoofForm.Pyramidal ? Math.min(rect.long, rect.short) : rect.short;
    let rise = form === RoofForm.Flat ? 0 : Math.min(12, (span / 2) * Math.tan(pitch));
    if (b.kind === BuildingKind.Religious && form !== RoofForm.Flat) {
        rise = Math.min(20, (span / 2) * Math.tan(pitch));
    }
    if (form === RoofForm.Skillion) {
        rise = Math.min(rise, 3);
    }
    if (Number.isFinite(b.roofHeight) && form !== RoofForm.Flat) {
        rise = b.roofHeight;
    } else if (Number.isFinite(b.roofLevels) && b.roofLevels > 0 && form !== RoofForm.Flat) {
        rise = Math.max(rise, b.roofLevels * 2.6);
    }
    let eave: number;
    let heightSource: HeightSource;
    if (Number.isFinite(b.height) && b.height > 1) {
        heightSource = 'height';
        if (form !== RoofForm.Flat && !Number.isFinite(b.roofHeight)) {
            rise = Math.min(rise, b.height * 0.5);
        }
        eave = Math.max(1.5, b.height - rise);
    } else if (Number.isFinite(b.levels) && b.levels > 0) {
        heightSource = 'levels';
        eave = b.levels * LEVEL_M + PLINTH_M;
    } else {
        heightSource = 'default';
        eave = defaultEaveM(b.kind, area) * jitter;
    }
    let ridge = eave + rise;

    // --- a fitted surface wins ---------------------------------------------------
    const shape = input.shape;
    const fitted = shape !== undefined && (shape.flags & SHAPE_ABSENT) === 0
        && shape.confidence >= MIN_SHAPE_CONFIDENCE && shape.ridgeM >= MIN_FITTED_RIDGE_M
        ? shape : undefined;
    const formSure = fitted !== undefined && input.surfaceForms === true && (fitted.flags & SHAPE_FORM_SURE) !== 0;
    // The fitted ridge's direction holds whatever the form: a skillion's axis
    // is along its contour, which is where a gable's ridge would run.
    const ridgeFitted = fitted !== undefined && fitted.form !== RoofForm.Flat;
    if (fitted) {
        heightSource = 'surface';
        if (formSure) {
            form = fitted.form;
        }
        ridge = fitted.ridgeM;
        // A flat fit under a pitched rule keeps a pitch from the rules below its ridge.
        eave = form === RoofForm.Flat ? fitted.ridgeM
            : fitted.form === RoofForm.Flat ? Math.max(1.5, fitted.ridgeM - rise)
                : Math.min(fitted.eaveM, fitted.ridgeM);
    }

    // --- LoD2 wins over all of it -------------------------------------------------
    const lod2 = input.lod2 !== undefined
        && (input.lod2.match === LOD2_MATCH_ONE || input.lod2.match === LOD2_MATCH_MERGED)
        && input.lod2.ridgeM >= 1.5 ? input.lod2 : undefined;
    if (lod2) {
        heightSource = 'lod2';
        if (lod2.form !== undefined) {
            form = lod2.form;
        }
        ridge = lod2.ridgeM;
        // A pitched roof whose LoD2 eave sits at its ridge (a mixed roof read
        // as one) keeps a pitch from the rules below the ridge.
        eave = form === RoofForm.Flat ? ridge
            : lod2.eaveM < ridge - 0.3 ? lod2.eaveM : Math.max(1.5, ridge - rise);
    }
    const formSource: FormSource = lod2?.form !== undefined ? 'lod2' : formSure ? 'surface'
        : tagged !== undefined ? 'tag' : 'rules';

    // --- ground -----------------------------------------------------------------
    let cu = 0, cv = 0;
    for (const [u, v] of outer) {
        cu += u;
        cv += v;
    }
    cu /= outer.length;
    cv /= outer.length;
    const samples: number[] = [];
    for (const [u, v] of outer) {
        const g = input.ground(u, v);
        if (g !== undefined) {
            samples.push(g);
        }
    }
    const centre = input.ground(cu, cv);
    if (centre !== undefined) {
        samples.push(centre);
    }
    if (samples.length === 0) {
        return undefined;
    }
    const minG = Math.min(...samples);
    const maxG = Math.max(...samples);
    const sortedG = samples.slice().sort((x, y) => x - y);
    const refG = centre ?? sortedG[Math.floor(sortedG.length / 2)];
    const eaveAbs = Math.max(refG + eave, maxG + MIN_EAVE_CLEARANCE_M);
    const ridgeAbs = eaveAbs + (ridge - eave);

    // --- ridge direction ----------------------------------------------------------
    let ridgeAngle = rect.angle;
    if (b.roofOrientation === ORIENTATION_ACROSS) {
        ridgeAngle += Math.PI / 2;
    }
    const azimuthDeg = lod2?.azimuthDeg !== undefined ? lod2.azimuthDeg
        : ridgeFitted ? fitted!.azimuthDeg : undefined;
    if (azimuthDeg !== undefined) {
        // The ridge azimuth, compass degrees, into (u, v): east is north
        // turned a quarter clockwise seen from above.
        const az = azimuthDeg * DEG;
        const [nu, nv] = input.north;
        const du = nu * Math.cos(az) + nv * Math.sin(az);
        const dv = nv * Math.cos(az) - nu * Math.sin(az);
        ridgeAngle = Math.atan2(dv, du);
    } else if (form === RoofForm.Skillion) {
        if (Number.isFinite(b.roofDirection)) {
            // roof:direction is the way the slope faces, downhill; the roof
            // climbs toward the ridge angle plus a quarter turn (buildingRoofs.ts).
            const c = b.roofDirection * DEG;
            const [nu, nv] = input.north;
            const du = nu * Math.cos(c) + nv * Math.sin(c);
            const dv = nv * Math.cos(c) - nu * Math.sin(c);
            ridgeAngle = Math.atan2(du, -dv);
        } else if (idRandom(b.id, 5) < 0.5) {
            ridgeAngle += Math.PI;
        }
    }

    const toned = tones(b, form, region);
    let roof = toned.roof;
    const wall = toned.wall;
    let roofRgb: number | undefined;
    if (input.measured && input.measured.confidence >= MIN_ROOF_CONFIDENCE) {
        roofRgb = dehazed(input.measured.rgb, ROOF_CHROMA);
        roof = nearestTone(roofRgb, ROOF_TONES);
    }
    return {
        rings: [outer, ...holes],
        baseM: minG - FOOT_BURY_M,
        eaveM: form === RoofForm.Flat ? ridgeAbs : eaveAbs,
        ridgeM: ridgeAbs,
        form,
        ridgeAngle,
        roofTone: roof,
        wallTone: wall,
        roofRgb,
        flags: b.kind === BuildingKind.Roof ? PBH_FLAG_NO_WALLS : 0,
        areaM2: area,
        prominence: buildingProminence(area, ridgeAbs - refG),
        heightSource,
        formTagged: tagged !== undefined,
        roofMeasured: roofRgb !== undefined,
        shapeAbsent: shape !== undefined && (shape.flags & SHAPE_ABSENT) !== 0,
        formFitted: formSure,
        formSource,
    };
}

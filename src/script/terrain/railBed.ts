/**
 * Road and railway beds laid into the terrain, by the bake
 * (tools/bake_planet_grade.ts, one tile at a time): no track steeper than
 * RAIL_MAX_GRADE, no road steeper than its tier allows (BED_TIERS).
 *
 * A track stroke is draped over the drawn mesh, so it climbs every bump the
 * DEM has: in the Alps a third of the track came out steeper than 3 % and
 * some of it past 100 %. A railway is not built like that. It runs on a
 * graded bed, on an embankment where the ground falls away below that line
 * and in a cutting where it rises above it.
 *
 * For a tile, its strokes and its neighbours' bridges (tools/bake/railBedInputs.ts
 * reads them from disk), this:
 *
 *   1. reads each track out of the stroke sidecar as a chain of points;
 *   2. fits it a profile no steeper than the limit, staying as close to the
 *      tile's ground as that allows (a dynamic programme over quantised
 *      heights; the ends and level crossings held to the ground, so tile
 *      borders, bridge ends and roads still meet it);
 *   3. refines the terrain triangles that profile has to move - only those,
 *      by conforming longest-edge bisection, so no crack opens - finer in
 *      the bed than on the slopes beside it;
 *   4. moves their vertices onto the bed and its 1:2 batters, and the track
 *      stroke onto the profile.
 *
 * The land mesh is a triangle soup. Triangles that are not refined keep
 * their slot (a refined one becomes degenerate in place, its pieces go on
 * the end), and triangles holding a border vertex are never touched, so the
 * seam stitcher's vertex indices stay good. Pure: nothing here knows about
 * three.js.
 *
 * Every length here is for a z12 leaf; a coarser tile scales them by its
 * size (RailBedInput.scale), so its profile has as many samples per tile
 * edge and it refines no finer than its own detail shows.
 */

import {
    PtrTile, ROAD_CLASS_MASK, RoadClass, TRACK_FLAG_CROSSING, isRailClass,
} from './ptr';
import { LineProfile, profileAt } from './lineProfile';

/** Steepest a railway may climb. */
export const RAIL_MAX_GRADE = 0.03;

/**
 * What a tier of line may do to the ground. Tiers in priority order, 0
 * highest: the higher a line, the more it keeps its own profile and the
 * more the ones below adapt to it (see layRailBeds, BandResolver).
 */
export interface BedTier {
    name: string;
    /** Steepest grade. */
    maxGrade: number;
    /** Deepest cutting or highest embankment; past it the grade gives way, metres. */
    maxEarthworkM: number;
    /** Half length of the vertical curve a grade break is rounded into, metres. */
    curveRadiusM: number;
    /**
     * Vertical radius the profile's grade changes are smoothed towards,
     * metres, within its earthworks (smoothVerticalCurves); none when absent.
     */
    verticalRadiusM?: number;
    /** Whether terrain triangles may be split to follow it (else only existing vertices move). */
    refine: boolean;
    /** Whether faces it makes too steep get retaining walls. */
    walls: boolean;
}

export const BED_TIERS: readonly BedTier[] = [
    // A railway's grade changes over thousands of metres of vertical curve
    // (DB: 2000 m at the least, 5000 m and more on main lines); the 80 m
    // rounding alone left crests 170 m in radius between held points.
    { name: 'railway', maxGrade: RAIL_MAX_GRADE, maxEarthworkM: 6, curveRadiusM: 80, verticalRadiusM: 5000, refine: true, walls: true },
    // Roads too: crests and sags of 10000 m on an Autobahn, 4000 m on a
    // highway, 500 m on a street (which still follows the land in town).
    // Rounded over 60-120 m alone, they bent at 150-180 m radius at Garmisch.
    { name: 'autobahn', maxGrade: 0.05, maxEarthworkM: 8, curveRadiusM: 120, verticalRadiusM: 10000, refine: true, walls: true },
    { name: 'highway', maxGrade: 0.06, maxEarthworkM: 4, curveRadiusM: 60, verticalRadiusM: 4000, refine: true, walls: true },
    // Streets mostly follow the terrain: their profile takes out the bumps
    // (the DEM has the buildings in it) and they ride what the tiers above
    // built, moving the land's existing vertices only - 11 km of residential
    // street a leaf tile around Garmisch would cost more than the land. A
    // street's own surface still wins over a higher line's batter. No walls:
    // over the land's sparse vertices a steep facet beside a street is one
    // triangle, and its wall came out a stray block.
    { name: 'street', maxGrade: 0.10, maxEarthworkM: 1.5, curveRadiusM: 25, verticalRadiusM: 500, refine: false, walls: false },
];
const BED_TIER_COUNT = BED_TIERS.length;
const RAIL_TIER = 0;
const AUTOBAHN_TIER = 1;

/**
 * Whose earthworks give way where two lines' meet, lowest first: a tier's
 * index, except that railways and Autobahns share one. Neither is graded
 * on the ground the other left, and where their beds meet they share it as
 * two lines of one tier do (BandResolver). Their grades, earthwork caps and
 * walls stay their own.
 */
export function bedRank(tier: number): number {
    return tier === RAIL_TIER ? AUTOBAHN_TIER : tier;
}
const STREET_TIER = 3;
/** How far the land may miss a street's bed between vertices, metres. */
const STREET_FIT_TOLERANCE_M = 1.5;

/**
 * The tier of a stroke class, or -1 for what is never graded (switch zones).
 * Secondary and tertiary roads are streets, not highways.
 */
export function bedTierOf(cls: number): number {
    if (isRailClass(cls)) {
        return 0;
    }
    switch (cls) {
        case RoadClass.Motorway: return 1;
        case RoadClass.Trunk:
        case RoadClass.Primary: return 2;
        case RoadClass.Secondary:
        case RoadClass.Tertiary:
        case RoadClass.Unclassified:
        case RoadClass.Residential: return 3;
        default: return -1;
    }
}

/** Two surfaces of one tier further apart than this at a point are grade-separated, not in conflict, metres. */
const CORE_SEPARATED_M = 3;
/** Room above the exact ramp a held point's approach may use, metres. */
const RAMP_SLACK_M = 0.5;
/** A stroke point this close to one graded before is the same point (a junction), metres. */
const HELD_SNAP_M = 1;
const HELD_CELL_M = 2;
/** Drawn this far apart in height, two points at one place are not a junction, metres. */
const HELD_DRAWN_M = 2;
/** Spacing of the profile samples, metres. */
const PROFILE_STEP_M = 5;
/** Height quantum of the profile, metres: 3 quanta per step is exactly 3 %. */
const PROFILE_QUANT_M = 0.05;
/** Bed beyond the track's own half width that stays at track height, metres. */
export const RAIL_SHOULDER_M = 0.8;
/** Batter: metres of height per metre sideways (1:2). */
export const RAIL_BATTER = 0.5;
/** Farthest a batter is carried from the bed's edge, metres. */
export const RAIL_BATTER_REACH_M = 30;
const SHOULDER_M = RAIL_SHOULDER_M;
const BATTER = RAIL_BATTER;
const BATTER_REACH_M = RAIL_BATTER_REACH_M;
/**
 * How far the land may miss its bed target between vertices, metres, at
 * least; FIT_TOLERANCE_LIFT of the strokes' lift when that is more. The
 * strokes float strokeLiftM (about 1.8 m at z12) over the facets, so this
 * much never shows on the track; any tighter costs triangles fast (0.3 m
 * tripled the land of a tile with track up a valley side).
 */
const FIT_TOLERANCE_M = 0.75;
const FIT_TOLERANCE_LIFT = 0.4;
/** Spacing of the points a triangle's fit is checked at, metres. */
const FIT_SAMPLE_M = 2;
/** Most samples along a triangle's side its fit is checked at. */
const FIT_GRID_MAX = 8;
/** Edges this short are never split to keep the land under a road, metres. */
const MIN_EDGE_M = 1.5;
/**
 * ... nor to follow a bed, metres: a crease (a bed's edge, a batter's toe)
 * placed to within a metre or so is all a z12 leaf shows, and at 1.5 m a
 * quarter of a graded leaf's land was triangles under 2 square metres.
 */
const REFINE_MIN_EDGE_M = 3;
/** Weight of the held samples (chain ends, level crossings) in the fit. */
const HOLD_WEIGHT = 1e4;
/** A drawn track this far off the land is held where it was drawn, metres; the land is brought to it. */
const OFF_LAND_M = 2;
/** ... and this far off, it is a structure, and the land is left alone, metres. */
const NO_BED_OFF_LAND_M = 15;
/** Deepest cutting or highest embankment a bed may need, metres. */
const MAX_EARTHWORK_M = 6;
/** Half length of the vertical curve a grade break is rounded into, metres. */
const CURVE_RADIUS_M = 80;
/**
 * Cost of climbing a metre past the limit, against a squared metre of
 * earthworks at one sample: high, so the grade only gives way where the
 * earthworks cap forces it.
 */
const STEEP_COST = 2000;
/** Most triangles one tile may gain. */
const MAX_NEW_TRIANGLES = 120000;
/** Most cells (samples x height states) one profile's programme may hold; past it the quantum grows. */
const MAX_PROFILE_CELLS = 8_000_000;
/** A track end this close to a deck track's end (plan, metres) belongs to that bridge. */
const DECK_SNAP_M = 6;
/** ... or this far back along the track's own line, its stroke ending on the deck (bridges' END_EXTEND_MAX_M on), metres ... */
const DECK_SNAP_ALONG_M = 10;
/** ... this far off that line at most, metres. */
const DECK_SNAP_SIDE_M = 1.5;
/** Share of its grade a road is held to between the decks it passes under: the vertical curves take some. */
const UNDERPASS_GRADE_SHARE = 0.85;
/** Floats per bed segment in RailBedResult.beds. */
export const RAIL_BED_SEGMENT_FLOATS = 11;
/**
 * Batter reach past what a bed's own lift needs (lift / BATTER), metres. A
 * tier that refines wants room: where its band opens out on a hillside the
 * refinement follows the kink. One that only moves vertices (streets) wants
 * to touch as little as it can - 144 km of street on the Garmisch tiles.
 */
const BATTER_REACH_MARGIN_M = 16;
const STREET_REACH_MARGIN_M = 4;
/**
 * A street segment this far off the ground the tiers above left refines the
 * land, metres: about the strokes' own lift over the land at z12, so less
 * never shows. (Measured against the baked land instead, streets riding a
 * railway's embankment refined too: +70 % triangles at 1 m.)
 */
const STREET_REFINE_LIFT_M = 1.8;
/** Past a batter's reach its band opens out over this far, metres, ... */
export const BATTER_FADE_M = 4;
/** ... this many metres of height per metre. */
export const BATTER_FADE_SLOPE = 5;

type V3 = [number, number, number];

export interface LandSoup {
    /** Quantised, 3 per vertex, 3 vertices per triangle. */
    positions: Int16Array;
    /** Unit normal / 127 + pad, 4 per vertex. */
    normals: Int8Array;
    /** Cover colour + class, 4 per vertex. */
    attrs: Uint8Array;
}

export interface RailBedInput {
    land: LandSoup;
    /** Metres per quantum of the land and the strokes alike. */
    quantScale: number;
    strokes: PtrTile;
    /** The real vertical, in the tile's axes. */
    up: V3;
    /** How far the strokes float over the surface (drapeRoads.ts strokeLiftM), metres. */
    liftM: number;
    /** Land vertex indices that must not move: the seam stitcher's border. */
    pinned: ReadonlySet<number>;
    /**
     * The tile's size against a z12 leaf's (2^(12 - z)): profile spacing,
     * edge lengths and cells grow by it. 1 when absent.
     */
    scale?: number;
    /**
     * Whether triangles may be split to follow the beds. Off, only the
     * vertices already there move: what a coarse tile wants, seen from
     * kilometres off, where a cutting is a few pixels and every triangle
     * counts against the terrain budget. On when absent.
     */
    refine?: boolean;
    /**
     * The ends of the track drawn on bridge decks (pbr.ts) - this tile's and
     * its neighbours', a deck often starting just across the border from
     * its approach - 3 per end, in this tile's frame, metres (see
     * deckTrackEnds). A track ending at one is held to the deck's height,
     * not the ground's, and its last point put on the deck's first: a deck
     * clears what it crosses, often 4 m above where the approach was
     * draped, and the approach climbs to it on an embankment instead of
     * running into the abutment.
     */
    deckEnds?: Float64Array;
    /**
     * The road decks' ends (pbr.ts version 5, PBR_ROAD_END_FLOATS each, the
     * tile's frame): the deck top on the centreline at each end of a road
     * span, its tier, and the deck top 1 m in. A road of that tier whose
     * chain ends within DECK_SNAP_M, arriving along the span, is held to the
     * deck's top there and climbs to it - read off the bridge bake, not
     * guessed from what the deck triangles cover, which left streets 5-6 m
     * under their decks wherever the guess failed.
     */
    roadDeckEnds?: Float64Array;
    /**
     * The top of every road bridge deck (pbr.ts BridgeRole.Deck faces) of
     * this tile and its neighbours, 9 per triangle, this tile's frame,
     * metres. A road ending where its own deck carries on is held to the
     * deck's top and its last point put on the deck's edge, as a track is
     * to its deck track: the bake raises a deck clear of what it crosses,
     * a metre over the road at the least, and the road climbs to it.
     */
    roadDecks?: Float64Array;
    /** The tier of the line each `roadDecks` triangle's bridge carries (pbr.ts pbrTier), -1 unknown. */
    roadDeckTiers?: Int8Array;
    /**
     * The tops of every bridge deck, road and rail, of this tile and its
     * neighbours, 9 per triangle, this tile's frame, metres: the land under
     * them is kept DECK_CLEAR_M below.
     */
    deckTops?: Float64Array;
    /** The tier of the line each `deckTops` triangle's bridge carries (pbr.ts pbrTier), -1 unknown. */
    deckTopTiers?: Int8Array;
    /**
     * Where lines cross this tile's border and how far off their drawn
     * height they are held there (pbr.ts version 4 ramps: x, y, z in this
     * tile's frame, then the change, metres). The bake works it out from the
     * lines and bridges of both tiles, so the tile across holds the same.
     */
    borderRamps?: Float64Array;
    /**
     * Every other face of those bridges (BridgeRole.Concrete: undersides,
     * sides, piers, abutments), same layout. The downward ones are the decks'
     * undersides, which a road passing under keeps UNDERPASS_CLEARANCE_M below.
     */
    deckConcrete?: Float64Array;
    /** Grade only the tiers up to this one (BED_TIERS index); all when absent. A dev switch. */
    maxTier?: number;
    /**
     * What else the earthworks must leave as baked, besides the tile's roads
     * (read from `strokes`): `tris` 9 per triangle (water, bridge decks,
     * piers and abutments), `segs` 7 per segment (both ends, then a half
     * width: watercourses), all in this tile's frame, metres.
     */
    keep?: { tris?: Float64Array; segs?: Float64Array };
    /**
     * Measured profiles of the lines (lineProfile.ts, from the lidar store,
     * tools/bake/lidarProfiles.ts), by the stroke vertex each segment starts
     * at. Where a sample has one, the line is fitted to it instead of to the
     * land: 'abs' to the measured height itself, 'rel' to the land plus the
     * measured embankment or cutting (what the bake uses).
     */
    measured?: { segments: ReadonlyMap<number, LineProfile>; mode: 'abs' | 'rel' };
    /**
     * The beds of the neighbouring tiles (their RailBedResult.beds, moved
     * into this tile's frame), RAIL_BED_SEGMENT_FLOATS each. The land follows
     * them as it follows its own - a bed beside the border has its batter on
     * both tiles - so both tiles give their shared border the same heights.
     */
    neighbourBeds?: Float64Array;
    /**
     * Free the border wherever a bed reaches it, the tile's own or a
     * neighbour's: its vertices move with the land, the lines near it keep
     * their profiles to the border instead of fading out over the last
     * BORDER_TAPER_M. Chain ends on the border stay held where drawn, so a
     * line crossing it meets its other half. For the bake, which grades
     * every tile with its neighbours' beds (neighbourBeds).
     */
    freeBorder?: boolean;
    /** Lay out the beds only: no land, no walls (the bake's first pass, for the neighbours). */
    bedsOnly?: boolean;
}

export interface RailBedStats {
    chains: number;
    /** Track length, and how much of it was steeper than the limit before, metres. */
    trackM: number;
    steepM: number;
    /** Track left steeper than the limit, where meeting it would take more earthworks than allowed, metres. */
    overLimitM: number;
    /** Triangles the land gained: the pieces written after its baked slots. */
    trianglesAdded: number;
    /** Triangles the refinement made that the collapse took back. */
    trianglesCollapsed: number;
    /** Land vertices taken down as spikes (SoupMesh.despike). */
    spikesLowered: number;
    /** Land facets cut along a retaining wall's face (cutLandAtWalls). */
    landCutAtWalls: number;
    /** Land vertices lowered under a drawn road or track (RoadCap), and triangles split to keep the land under one. */
    landLoweredUnderRoads: number;
    splitForRoads: number;
    verticesMoved: number;
    /** Triangles of the concrete retaining walls built where earthworks were too steep for a slope. */
    wallTriangles: number;
    /** Of those, the bridges' concrete carried down to the land graded under it. */
    underpinTriangles: number;
    /** The same per tier (BED_TIERS order): lines, their length, steeper than the tier's limit before and after. */
    byTier: Array<{ chains: number; lengthM: number; steepM: number; overLimitM: number }>;
}

export interface RailBedResult {
    /** The land with the beds laid; undefined when no vertex had to move. */
    land?: LandSoup;
    /** The strokes' positions with the track on its profiles (the input is left alone). */
    strokePositions: Int16Array;
    /**
     * The whole stroke set when vertices were added to follow the profiles
     * (a dip under a bridge, a vertical curve between vertices tens of metres
     * apart): the input's vertices first, unchanged in order, the new ones
     * after. `positions` is `strokePositions`.
     */
    strokes?: Pick<PtrTile, 'positions' | 'directions' | 'halfWidths' | 'along' | 'flags' | 'indices'>;
    /**
     * The beds, RAIL_BED_SEGMENT_FLOATS per segment: both ends in the tile's
     * own frame at design height (metres), the half width out to where the
     * shoulder starts, the most the bed leaves the ground at either end,
     * which ends are open (BED_OPEN_A | BED_OPEN_B), its tier, and how far
     * past the shoulder its batter reaches.
     */
    beds: Float64Array;
    /** Concrete retaining walls, where the earthworks are too steep to stand as slopes. */
    walls?: RailWalls;
    stats: RailBedStats;
}

interface Sample {
    u: number;
    v: number;
    ground: number;
    weight: number;
    h: number;
    /** The land under it, as baked. */
    land: number;
    /** The land under it as the higher tiers left it. */
    above?: number;
    /** Drawn far off the land: held, and no bed. */
    off: boolean;
    /** Drawn off the land at all (past offLand): held where drawn. */
    aloft?: boolean;
}

/**
 * Lay the beds of every track in `input.strokes` into `input.land`, and put
 * the strokes' rail vertices onto their profiles (in a copy). Undefined when
 * the tile has no track to grade.
 */
export function layRailBeds(input: RailBedInput): RailBedResult | undefined {
    const { land, quantScale: q, strokes, up, liftM } = input;
    const f = Math.max(1, input.scale ?? 1);
    const dims: Dims = {
        step: PROFILE_STEP_M * f,
        quant: PROFILE_QUANT_M * f,
        tolerance: Math.max(FIT_TOLERANCE_M * f, FIT_TOLERANCE_LIFT * liftM),
        sample: FIT_SAMPLE_M * f,
        minEdge: MIN_EDGE_M * f,
        refineMinEdge: REFINE_MIN_EDGE_M * f,
        cell: CELL_M * f,
        offLand: Math.max(OFF_LAND_M * f, liftM),
    };
    const frame = planFrame(up);
    const chains = bedChains(strokes).filter(c => c.tier <= (input.maxTier ?? Infinity));
    if (chains.length === 0) {
        return undefined;
    }
    const strokePositions = strokes.positions.slice();
    // The border's vertices never move (the seam stitcher's), so the beds
    // fade out over the last BORDER_TAPER_M before it: held hard, the land
    // beside a fixed border could never fit them, and the refinement would
    // grind a strip along the border down to its smallest triangles.
    // The strokes fade with them, or a line near a border parted from its
    // ground: a road cut 7 m down under a bridge 5 m from the border lay
    // buried in land that had moved 1.2 m.
    const border = new BorderIndex(land.positions, input.pinned, q, frame, dims.cell);
    const decks = deckEnds(input.deckEnds, strokes.quantScale, frame);
    const roadEnds = roadDeckEnds(input.roadDeckEnds, strokes.quantScale, frame, liftM);
    const roadDecks = input.roadDecks && input.roadDecks.length > 0
        ? new RoadDeckIndex(input.roadDecks, frame, undefined, input.roadDeckTiers) : undefined;
    const deckTops = input.deckTops && input.deckTops.length > 0
        ? new RoadDeckIndex(input.deckTops, frame, undefined, input.deckTopTiers) : undefined;
    const deckUnders = deckTops && input.deckConcrete && input.deckConcrete.length > 0
        ? new RoadDeckIndex(input.deckConcrete, frame, -UNDERSIDE_MIN_DOWN) : undefined;
    const triCount = land.positions.length / 9;
    const ground = new GroundIndex(land.positions, q, frame, dims.cell);

    // --- profiles, tier by tier ------------------------------------------------
    // Railways first, then Autobahn, highways, streets. Each tier is fitted
    // to the ground as the tiers above it have already left it, and is held
    // to them where it meets them (a crossing, a junction, a higher bed it
    // runs onto), so the lower one takes the difference: who matters more
    // keeps its line, who matters less adapts.
    const newStats = (): RailBedStats => ({
        chains: chains.length, trackM: 0, steepM: 0, overLimitM: 0, trianglesAdded: 0, trianglesCollapsed: 0, spikesLowered: 0, landCutAtWalls: 0, landLoweredUnderRoads: 0, splitForRoads: 0, verticesMoved: 0,
        wallTriangles: 0, underpinTriangles: 0, byTier: BED_TIERS.map(() => ({ chains: 0, lengthM: 0, steepM: 0, overLimitM: 0 })),
    });
    let stats = newStats();
    let beds: BedSegment[] = [];
    const sq = strokes.quantScale;
    let held = new HeldPoints();
    // Junction heights a later line needed of an earlier one (u, v, h, drawn),
    // and what the second pass holds them to.
    const needs: number[] = [];
    const forced = new HeldPoints();
    // Stroke vertices to add, per stroke segment (its first pair's vertex):
    // where along it (0..1) and the plan point and surface height there.
    let inserts = new Map<number, { b: number; at: Array<{ t: number; u: number; v: number; h: number }> }>();
    // A road deck of its own tier under a road drawn level with it, running
    // on along the road further than across it, is its own: the bridge it is
    // going onto,
    // not one it passes under (taken for one, an Autobahn was dug 7 m down
    // before its bridge, and a street 6 m beside its own short one). A
    // bridge left on the ground over a road runs across it.
    const ownDeck = (u: number, v: number, du: number, dv: number, drawn: number, tier: number): boolean =>
        roadDecks?.forTier(tier, () => {
            const top = roadDecks.top(u, v);
            if (top === undefined || Math.abs(top - drawn) > OWN_DECK_LEVEL_M) {
                return false;
            }
            const l = Math.hypot(du, dv) || 1;
            const eu = du / l, ev = dv / l;
            const run = (su: number, sv: number) => roadDecks.run(u, v, su, sv);
            return run(eu, ev) + run(-eu, -ev) >= run(-ev, eu) + run(ev, -eu);
        }) ?? false;
    // A chain end held where drawn: at the tile border, which the neighbour
    // meets, or at a bridge (not anchored to it, it meets it as drawn).
    const endHeld = (u: number, v: number, p: { u: number; v: number }, prev: { u: number; v: number }): boolean => {
        if (border.taper(u, v) < END_BORDER_FADE) {
            return true;
        }
        const l = Math.hypot(p.u - prev.u, p.v - prev.v) || 1;
        for (let s = 0; s <= ROAD_DECK_REACH_M; s += 2) {
            if (deckTops?.top(p.u + ((p.u - prev.u) / l) * s, p.v + ((p.v - prev.v) / l) * s) !== undefined) {
                return true;
            }
        }
        return false;
    };
    // Every chain's two ends, per tier: a road ending at a bridge either
    // goes onto it or under it, which the chain carrying on beyond tells.
    const chainEnds: ChainEnd[][] = BED_TIERS.map(() => []);
    for (const c of chains) {
        const P = c.chain.map(vi => frame.toPlan([strokes.positions[vi * 3] * strokes.quantScale,
            strokes.positions[vi * 3 + 1] * strokes.quantScale, strokes.positions[vi * 3 + 2] * strokes.quantScale]));
        if (P.length < 2) {
            continue;
        }
        for (const [e, f] of [[P[0], P[1]], [P[P.length - 1], P[P.length - 2]]]) {
            const l = Math.hypot(e[0] - f[0], e[1] - f[1]) || 1;
            chainEnds[c.tier].push({ u: e[0], v: e[1], du: (e[0] - f[0]) / l, dv: (e[1] - f[1]) / l });
        }
    }
    // Where a line crosses the tile border, the height both tiles hold it
    // to (RailBedInput.borderRamps): its drawn height, raised to climb onto a
    // deck of its own beyond or lowered to pass under one. Held where drawn,
    // a ramp could only use the stretch on its own side: a flyover 60 m from
    // the border climbed 19 % instead of 3 %. Keyed by the end's vertex.
    const ramps: number[] = [];
    for (let i = 0; input.borderRamps && i + 3 < input.borderRamps.length; i += 4) {
        const R = input.borderRamps;
        const [u, v] = frame.toPlan([R[i], R[i + 1], R[i + 2]]);
        ramps.push(u, v, R[i + 3]);
    }
    const rampAt = (u: number, v: number): number | undefined => {
        let best: number | undefined, bestD = RAMP_MATCH_M;
        for (let i = 0; i < ramps.length; i += 3) {
            const d = Math.hypot(ramps[i] - u, ramps[i + 1] - v);
            if (d < bestD) {
                bestD = d;
                best = ramps[i + 2];
            }
        }
        return best;
    };
    const borderHeights = new Map<number, number>();
    const freeZones: number[] = [];
    for (const c of chains) {
        const P = c.chain.map(vi => {
            const [u, v, h] = frame.toPlan([strokes.positions[vi * 3] * sq, strokes.positions[vi * 3 + 1] * sq, strokes.positions[vi * 3 + 2] * sq]);
            return { vi, u, v, h: h - liftM, half: strokes.halfWidths[vi] / 10 };
        });
        if (P.length < 2) {
            continue;
        }
        for (const atStart of [true, false]) {
            const at = (j: number) => P[atStart ? j : P.length - 1 - j];
            const e = at(0);
            if (border.taper(e.u, e.v) >= END_BORDER_FADE) {
                continue;
            }
            // The line's own first point in from a drape on the skirt, which
            // the profile drops (strayStep): the ramp is the line's height
            // there plus the change. Added to the stray's, the B2 at Garmisch
            // was held 155 m down the skirt, and once the stray was dropped,
            // at its drawn height 1 m in - 3.8 m over the dip under a railway
            // bridge 14 m on, climbing 22 % to it.
            let gj = 0;
            for (let j = 0; j < STRAY_END_POINTS && j + 2 < P.length; j++) {
                if (strayStep(at(j), at(j + 1))) {
                    gj = strayCluster(at, j) ? j + 1 : 0;
                    break;
                }
            }
            const g = at(gj), f = at(gj + 1);
            const l = Math.hypot(g.u - f.u, g.v - f.v) || 1;
            const dh = rampAt(e.u, e.v);
            const h = g.h + (dh ?? 0);
            if (dh !== undefined && Math.abs(dh) > CROSSING_MIN_MOVE_M) {
                borderHeights.set(e.vi, e === g ? h : e.h + dh);
                borderHeights.set(g.vi, h);
                // Free from the crossing in along the line, past the taper.
                const run = BORDER_TAPER_M + CROSSING_FREE_MAX_M;
                freeZones.push(e.u, e.v, g.u - ((g.u - f.u) / l) * run, g.v - ((g.v - f.v) / l) * run,
                    Math.min(CROSSING_FREE_MAX_M, g.half + SHOULDER_M + Math.abs(h - g.h) / BATTER + STREET_REACH_MARGIN_M));
            }
        }
    }
    // Neighbours' beds, as this tile's segments (plan frame).
    const neighbourBeds: BedSegment[] = [];
    for (let o = 0; input.neighbourBeds && o + RAIL_BED_SEGMENT_FLOATS <= input.neighbourBeds.length; o += RAIL_BED_SEGMENT_FLOATS) {
        const B = input.neighbourBeds;
        const [ua, va, ha] = frame.toPlan([B[o], B[o + 1], B[o + 2]]);
        const [ub, vb, hb] = frame.toPlan([B[o + 3], B[o + 4], B[o + 5]]);
        const lift = B[o + 7], tier = B[o + 9];
        // Only those near this tile's border: the rest of a neighbour is not this tile's business.
        const len = Math.hypot(ub - ua, vb - va), steps = Math.max(1, Math.ceil(len / 10));
        let near = false;
        for (let k = 0; k <= steps && !near; k++) {
            near = border.taper(ua + ((ub - ua) * k) / steps, va + ((vb - va) * k) / steps) < 1;
        }
        if (!near) {
            continue;
        }
        const sample = (u: number, v: number, h: number): Sample => ({ u, v, h, ground: h, weight: 0, land: h - lift, off: false });
        neighbourBeds.push({
            a: sample(ua, va, ha), b: sample(ub, vb, hb), half: B[o + 6], open: B[o + 8], tier, reach: B[o + 10],
            refine: BED_TIERS[tier]?.refine ?? false,
        });
    }
    if (input.freeBorder) {
        // Round every line, and every neighbour's bed, within reach of the
        // border: as far as a batter can reach.
        for (const c of chains) {
            const P = c.chain.map(vi => frame.toPlan([strokes.positions[vi * 3] * sq, strokes.positions[vi * 3 + 1] * sq, strokes.positions[vi * 3 + 2] * sq]));
            const half = Math.max(...c.chain.map(vi => strokes.halfWidths[vi] / 10));
            const r = half + SHOULDER_M + BATTER_REACH_M + BATTER_FADE_M;
            for (let i = 1; i < P.length; i++) {
                if (Math.min(border.taper(P[i - 1][0], P[i - 1][1]), border.taper(P[i][0], P[i][1])) < 1
                    || border.taper((P[i - 1][0] + P[i][0]) / 2, (P[i - 1][1] + P[i][1]) / 2) < 1) {
                    freeZones.push(P[i - 1][0], P[i - 1][1], P[i][0], P[i][1], r);
                }
            }
        }
        for (const s of neighbourBeds) {
            freeZones.push(s.a.u, s.a.v, s.b.u, s.b.v, s.half + SHOULDER_M + s.reach + BATTER_FADE_M);
        }
    }
    border.setFree(freeZones);
    for (let pass = 0; pass < GRADE_PASSES; pass++) {
        if (pass > 0) {
            if (needs.length === 0) {
                break;
            }
            for (let i = 0; i < needs.length; i += 4) {
                forced.add(needs[i], needs[i + 1], needs[i + 2], needs[i + 3]);
            }
            needs.length = 0;
            stats = newStats();
            beds = [];
            held = new HeldPoints();
            inserts = new Map();
            strokePositions.set(strokes.positions);
        }
        for (let tier = 0; tier < BED_TIERS.length; tier++) {
            const spec = BED_TIERS[tier];
            const mine = chains.filter(c => c.tier === tier);
            if (mine.length === 0) {
                continue;
            }
            // The ground as the tiers above have left it - not a peer's
            // (bedRank): a railway and an Autobahn are graded on the same land.
            const higher = beds.filter(b => bedRank(b.tier) < bedRank(tier));
            const above = higher.length > 0 ? new BedIndex(higher, dims.cell / 2) : undefined;
            const resolver = new BandResolver();
            const groundAt = (u: number, v: number, land: number): number =>
                above ? above.target(u, v, land, resolver) : land;
            // The points trimmed off each chain's ends as strays, by chain: they
            // take the height of the end they were trimmed from, not their drawn one.
            const trimmedOf = new Map<object, Array<{ vi: number; u: number; v: number; h: number }>>();
            const ptsOf = (chain: readonly number[]) => {
                const pts = chain.map(vi => {
                    const p: V3 = [strokes.positions[vi * 3] * sq, strokes.positions[vi * 3 + 1] * sq, strokes.positions[vi * 3 + 2] * sq];
                    const [u, v, h] = frame.toPlan(p);
                    return { vi, u, v, h: h - liftM, half: strokes.halfWidths[vi] / 10, crossing: (strokes.flags[vi] & TRACK_FLAG_CROSSING) !== 0 };
                });
                // An end point on the border the bake draped onto the skirt,
                // straight under the next one: held, it dragged the street 37 m
                // down. It is no part of the line.
                // Or steeper than any road climbs, and the skirt may hold
                // two of them side by side: the highway under the B2's rail
                // bridge at Garmisch ended in two points 155 m down the
                // skirt, and its profile dived 124 m to them. Everything past
                // a stray step among the last three goes.
                const stray = strayStep;
                // ... but not an end at its own bridge's deck end: drawn on the
                // ground there and on the deck beside it, a street's last two
                // points 5 m apart in height were taken for a skirt drape and
                // dropped, and the street stayed 3.7 m under its deck.
                const atDeckEnd = (p: typeof pts[number]) => tier !== RAIL_TIER
                    && roadEnds.some(e => e.tier === tier && Math.hypot(e.u - p.u, e.v - p.v) <= ROAD_END_ON_M);
                const trimmed: Array<typeof pts[number]> = [];
                const trim = (atStart: boolean): boolean => {
                    const at = (j: number) => (atStart ? pts[j] : pts[pts.length - 1 - j]);
                    for (let j = 0; j < STRAY_END_POINTS && j + 2 < pts.length; j++) {
                        if (stray(at(j), at(j + 1))) {
                            if ([...Array(j + 1).keys()].some(k => atDeckEnd(at(k)))) {
                                return false;
                            }
                            // Strays hang off one point: a stray step further in
                            // past a real stretch of line is the other end's.
                            if (!strayCluster(at, j)) {
                                return false;
                            }
                            trimmed.push(...(atStart ? pts.splice(0, j + 1) : pts.splice(pts.length - j - 1, j + 1)));
                            return true;
                        }
                    }
                    return false;
                };
                while (pts.length > 2 && trim(true)) {
                    // (trimmed)
                }
                while (pts.length > 2 && trim(false)) {
                    // (trimmed)
                }
                trimmedOf.set(pts, trimmed);
                return pts;
            };
            // A line that must climb to a deck or dip under one goes first: its
            // free ends at junctions take what its ramp needs, and the lines
            // meeting it there, held to that, carry the ramp on.
            const order = mine.map(c => {
                const pts = ptsOf(c.chain);
                const anchored = tier === RAIL_TIER
                    ? [0, pts.length - 1].some(i => nearestDeckEnd(decks, pts, i) !== undefined)
                    : [0, pts.length - 1].some(i => !onTheBorder(border.taper(pts[i].u, pts[i].v))
                        && (nearestRoadDeckEnd(roadEnds, tier, pts, i) !== undefined
                            || roadDecks?.forTier(tier, () => roadDecks.anchor(pts, i, liftM, frame, sq, chainEnds[tier])) !== undefined));
                const under = tier !== RAIL_TIER && pts.some((p, i) => {
                    const o = pts[Math.min(pts.length - 1, i + 1)], m = { u: (p.u + o.u) / 2, v: (p.v + o.v) / 2 };
                    return [p, m].some(x => deckTops?.top(x.u, x.v) !== undefined && !ownDeck(x.u, x.v, o.u - p.u, o.v - p.v, p.h, tier));
                });
                return { chain: c.chain, pts, needy: anchored || under };
            });
            order.sort((x, y) => Number(y.needy) - Number(x.needy));
            for (const { pts } of order) {
                const ts = stats.byTier[tier];
                ts.chains++;
                for (let i = 1; i < pts.length; i++) {
                    const run = Math.hypot(pts[i].u - pts[i - 1].u, pts[i].v - pts[i - 1].v);
                    ts.lengthM += run;
                    if (run > 0.5 && Math.abs(pts[i].h - pts[i - 1].h) / run > spec.maxGrade + 1e-3) {
                        ts.steepM += run;
                    }
                }
                // Resampled along the plan length, with the ground under each sample.
                const cum = [0];
                for (let i = 1; i < pts.length; i++) {
                    cum.push(cum[i - 1] + Math.hypot(pts[i].u - pts[i - 1].u, pts[i].v - pts[i - 1].v));
                }
                const length = cum[cum.length - 1];
                // Even a stub is graded: the few metres between a deck's end
                // and the tile border, skipped as shorter than a step, kept
                // their drawn height under a deck end 6.6 m above them (the
                // street bridge over the B2 at Garmisch).
                if (length < MIN_CHAIN_M) {
                    continue;
                }
                const n = Math.max(2, Math.round(length / dims.step) + 1);
                const samples: Sample[] = [];
                // The ground each sample has as baked, before any line moved it.
                const base: number[] = [];
                // Samples held under someone else's deck, with the height that took.
                const unders: Array<{ k: number; need: number }> = [];
                let seg = 0;
                for (let k = 0; k < n; k++) {
                    const s = (length * k) / (n - 1);
                    while (seg < pts.length - 2 && cum[seg + 1] < s) {
                        seg++;
                    }
                    const span = cum[seg + 1] - cum[seg];
                    const t = span > 1e-9 ? (s - cum[seg]) / span : 0;
                    const a = pts[seg], b = pts[seg + 1];
                    const u = a.u + (b.u - a.u) * t, v = a.v + (b.v - a.v) * t;
                    const draped = a.h + (b.h - a.h) * t;
                    // No land under it at all (water, a gap under a bridge): it is
                    // on a structure, and lays no bed - taken for its own
                    // ground, a street end drawn at the water carved the land
                    // round it down 10 m.
                    const landHere = ground.at(u, v);
                    const land = landHere ?? draped;
                    // Drawn well off the land - an approach the bake raised, a
                    // stroke over a dip the mesh lost - it stays where it was
                    // drawn, and the land comes to it: an embankment under it
                    // rather than a road in the air. Past NO_BED_OFF_LAND_M it is
                    // a structure the land has nothing to do with: no bed.
                    const gap = Math.abs(land - draped);
                    const off = gap > dims.offLand;
                    // A road's stretch over its own bridge, drawn on the ground
                    // under the deck: the deck carries it, and a bed there filled
                    // the land up into the deck.
                    const sl = Math.hypot(b.u - a.u, b.v - a.v) || 1;
                    const onOwnDeck = tier !== RAIL_TIER && roadDecks !== undefined
                        && roadDecks.forTier(tier, () => roadDecks.along(u, v, (b.u - a.u) / sl, (b.v - a.v) / sl));
                    const noBed = gap > NO_BED_OFF_LAND_M || landHere === undefined || onOwnDeck;
                    // Ends meet a tile border or a bridge where they were drawn:
                    // the neighbour tile and the deck were drawn to that height.
                    // At a junction an end is free: held where drawn, a ramp to a
                    // deck 29 m on climbed 21 %; the lines meeting it there are
                    // held to whatever it took, and carry the ramp on.
                    const end = (k === 0 || k === n - 1) && endHeld(u, v, k === 0 ? pts[0] : pts[pts.length - 1], k === 0 ? pts[1] : pts[pts.length - 2]);
                    // A level crossing stays at its baked height, which its
                    // barriers and signs were built at; the road comes to it.
                    const crossing = tier === RAIL_TIER && (t < 0.5 ? a.crossing : b.crossing);
                    // Fitted to its own ground, not to the slopes of the lines
                    // above it: an embankment never spills onto another road or
                    // railway - where one meets it, the face between is steep
                    // and gets a wall. Only where it runs onto a higher line's
                    // own surface is it held to it (below).
                    let wanted = off || end || crossing ? draped : land;
                    // A border end where both tiles agree on another height.
                    const atBorder = k === 0 ? borderHeights.get(pts[0].vi) : k === n - 1 ? borderHeights.get(pts[pts.length - 1].vi) : undefined;
                    if (end && atBorder !== undefined) {
                        wanted = atBorder;
                    }
                    let weight = off || end || crossing ? HOLD_WEIGHT : 1;
                    // Measured (lidar): the embankment or cutting the line
                    // really runs on, which the land's DEM is too coarse to see.
                    // An end on the tile border too, unless the bake moved it
                    // there (a ramp): the tile across measures the same road.
                    // Held where drawn, a Munich street in a cutting 6.5 m
                    // deep stood up to the DEM's ground at the border, a spike
                    // 6.5 m tall in its last 5 m on both tiles.
                    const measuredEnd = end && !off && !crossing && atBorder === undefined && border.taper(u, v) < END_BORDER_FADE;
                    const prof = (off || end || crossing) && !measuredEnd ? undefined : input.measured?.segments.get(a.vi);
                    if (prof) {
                        const m = profileAt(prof, t);
                        const h = input.measured!.mode === 'rel' ? land + m.lift : m.centre;
                        if (Number.isFinite(h)) {
                            wanted = h;
                        }
                    }
                    // On its own deck it rides the deck: still no bed under it,
                    // but at the deck's top. Held where drawn, the few metres of a
                    // street under a skewed end's corner stayed on the ground,
                    // 4.7 m under the deck it leads onto.
                    const ownTop = onOwnDeck ? deckTops?.top(u, v) : undefined;
                    if (ownTop !== undefined) {
                        wanted = ownTop;
                        weight = HOLD_WEIGHT;
                    }
                    // Running onto a higher tier's bed - crossing it, joining it -
                    // it is held to that bed's height there.
                    const onAbove = above?.coreAt(u, v, resolver);
                    if (onAbove !== undefined) {
                        wanted = onAbove;
                        weight = HOLD_WEIGHT;
                    }
                    // Passing under someone else's bridge, a road is held clear
                    // below its deck. The bake lifts a deck only over roads of its
                    // own priority or higher; a railway bridge over a street stays
                    // on the ground, and the street goes down under it on a
                    // cutting, at its own grade.
                    let underpass = false;
                    const top = tier !== RAIL_TIER && !onOwnDeck && !ownDeck(u, v, b.u - a.u, b.v - a.v, draped, tier) ? deckTops?.top(u, v) : undefined;
                    if (top !== undefined) {
                        const need = (deckUnders?.below(u, v, top) ?? top - UNDERSIDE_FALLBACK_M) - UNDERPASS_CLEARANCE_M;
                        if (wanted > need) {
                            wanted = need;
                            weight = HOLD_WEIGHT;
                            underpass = true;
                            unders.push({ k: samples.length, need });
                        }
                    }
                    base.push(off || end || crossing ? draped : land);
                    samples.push({ u, v, ground: wanted, land, above: groundAt(u, v, land), weight, h: 0, off: noBed && !underpass, aloft: off && !underpass });
                }
                // A vertex shared with a line graded before (a junction, an
                // at-grade crossing) is held to the height that line gave it.
                // Which samples those are, and the vertex: a ramp that cannot
                // fit against one asks the line that set it to come to it.
                const junctions = new Map<number, number>();
                for (let i = 0; i < pts.length; i++) {
                    const h = held.at(pts[i].u, pts[i].v, pts[i].h) ?? forced.at(pts[i].u, pts[i].v, pts[i].h);
                    if (h !== undefined) {
                        const k = Math.min(n - 1, Math.max(0, Math.round((cum[i] / length) * (n - 1))));
                        const s = samples[k];
                        s.ground = h;
                        s.weight = HOLD_WEIGHT;
                        s.off = false;
                        junctions.set(k, i);
                    }
                }
                // Passing a road deck end of its tier along the span - the
                // approach running on as part of a longer chain, past a
                // junction at the bridge's head - it is held to the deck's top
                // there, as a chain ending at it is (below). A line crossing
                // under the deck's end runs across the span, and is not.
                if (tier !== RAIL_TIER) {
                    for (const e of roadEnds) {
                        if (e.tier !== tier) {
                            continue;
                        }
                        let best = ROAD_END_PASS_M, at = -1;
                        for (let i = 0; i + 1 < pts.length; i++) {
                            const du = pts[i + 1].u - pts[i].u, dv = pts[i + 1].v - pts[i].v;
                            const l = Math.hypot(du, dv);
                            if (l < 1e-6 || Math.abs((du * e.du + dv * e.dv) / l) < ROAD_END_PASS_COS) {
                                continue;
                            }
                            const t = Math.max(0, Math.min(1, ((e.u - pts[i].u) * du + (e.v - pts[i].v) * dv) / (l * l)));
                            const d = Math.hypot(e.u - pts[i].u - du * t, e.v - pts[i].v - dv * t);
                            if (d < best) {
                                best = d;
                                at = cum[i] + t * l;
                            }
                        }
                        if (at < 0) {
                            continue;
                        }
                        const s = samples[Math.min(n - 1, Math.max(0, Math.round((at / length) * (n - 1))))];
                        s.ground = e.h - liftM;
                        s.weight = HOLD_WEIGHT;
                        s.off = false;
                    }
                }
                const step = length / (n - 1);
                // A track ending on a bridge: held at the deck's height.
                // A road ending at its own bridge: held at the deck's top.
                const anchors = tier === RAIL_TIER
                    ? [0, pts.length - 1].map(i => nearestDeckEnd(decks, pts, i))
                    // (Not on the tile border: the road goes on in the
                    // neighbour, which meets it there as drawn - one snapped
                    // up onto a slip road's bridge over it climbed 130 %. Near
                    // it is fine: the stub between a deck's end 2 m from the
                    // border and the border kept its drawn height under a deck
                    // end 6.6 m above it.)
                    : [0, pts.length - 1].map(i => onTheBorder(border.taper(pts[i].u, pts[i].v)) ? undefined
                        : nearestRoadDeckEnd(roadEnds, tier, pts, i)
                            ?? roadDecks?.forTier(tier, () => roadDecks.anchor(pts, i, liftM, frame, sq, chainEnds[tier])));
                anchors.forEach((a, end) => {
                    if (a) {
                        const s = samples[end === 0 ? 0 : n - 1];
                        s.ground = a.h - liftM;
                        s.weight = HOLD_WEIGHT;
                        s.off = false;
                        // The bed runs on to the deck's edge, where the stroke's
                        // last point is put (up to 8 m on): ending at the chain's
                        // own end, it left the road in the air up to the deck.
                        s.u = a.u;
                        s.v = a.v;
                    }
                });
                // Under a deck a road is held no higher than its clearance
                // allows: a bound, not a height. Held exactly there, a road
                // under two decks 15 m apart, one 3.6 m lower than the other
                // (the B2 at Garmisch under a street bridge, then a railway
                // bridge), dropped 3.7 m in those 15 m, 27.8 %. Each such hold
                // comes down to within this tier's grade of the others (less
                // a share the vertical curves round off beside them).
                if (unders.length > 1) {
                    const slope = spec.maxGrade * UNDERPASS_GRADE_SHARE * (length / (n - 1));
                    const kept = unders.filter(u => samples[u.k].ground === u.need && samples[u.k].weight >= HOLD_WEIGHT);
                    const caps = kept.map(u => kept.reduce((c, o) => Math.min(c, o.need + slope * Math.abs(u.k - o.k)), u.need));
                    kept.forEach((u, i) => {
                        samples[u.k].ground = caps[i];
                    });
                }
                // A structure's samples (no bed) do not pull on the fit: no
                // weight, no band - held at their drawn height, they dragged the
                // line's last stretch on the land down to the water beside it.
                // Its ends stay held whatever is under them: the neighbouring tile,
                // or the bridge, meets them where they were drawn.
                samples.forEach((sm, k) => {
                    if (sm.off && k !== 0 && k !== n - 1) {
                        sm.weight = 0;
                    }
                });
                // A junction held by a line graded before, too far off another
                // hold for this line's grade (a street 29 m from a deck 6 m up,
                // its other end where an Autobahn link meets it at the ground):
                // the height the junction would need is asked of that line,
                // which comes to it at its own grade in the next pass.
                if (pass + 1 < GRADE_PASSES) {
                    const holds: number[] = [];
                    samples.forEach((sm, k) => {
                        if (sm.weight >= HOLD_WEIGHT) {
                            holds.push(k);
                        }
                    });
                    const runStep = length / (n - 1);
                    for (let m = 0; m + 1 < holds.length; m++) {
                        const ka = holds[m], kb = holds[m + 1];
                        const ja = junctions.get(ka), jb = junctions.get(kb);
                        if (ja === undefined && jb === undefined) {
                            continue;
                        }
                        // Both junctions: the one nearer its own ground moves.
                        const aMoves = jb === undefined
                            || (ja !== undefined && Math.abs(samples[ka].ground - base[ka]) <= Math.abs(samples[kb].ground - base[kb]));
                        const [kj, ko, j] = aMoves ? [ka, kb, ja!] : [kb, ka, jb!];
                        const reach = spec.maxGrade * runStep * Math.abs(kb - ka);
                        const dh = samples[kj].ground - samples[ko].ground;
                        if (Math.abs(dh) > reach + NEED_SLACK_M) {
                            needs.push(pts[j].u, pts[j].v, samples[ko].ground + Math.sign(dh) * reach, pts[j].h);
                        }
                    }
                }
                const weights = samples.map(s => s.weight);
                const groundH = samples.map(s => s.ground);
                // The limit, unless that takes more earthworks than this tier may
                // move: a rack railway, a mountain road, a hairpin climbs steeper,
                // and there the profile stays within the cap, as gentle as that
                // allows.
                // A held point off its ground - a crossing or junction with a
                // higher line, a bridge's deck - is reached by a ramp at this
                // tier's own grade, on whatever earthworks that takes: within
                // reach of one, the cap gives way to the ramp.
                const band = samples.map(sm => sm.off && sm.weight === 0 ? Infinity : spec.maxEarthworkM);
                // Where a ramp to a held point off its ground runs.
                const rampZone = new Uint8Array(n);
                samples.forEach((h, j) => {
                    if (h.weight < HOLD_WEIGHT) {
                        return;
                    }
                    // Off its own drawn height, or off where the line beside it
                    // wants to be: a street measured in a cutting 4-10 m deep
                    // ran up to its deck's end (drawn on the deck, so no lift
                    // off its own) set no deeper than the street's cap, and
                    // climbed 3.7 m in the last 5 m to it (Garmisch, 47.4734,
                    // 11.1157).
                    let lift = Math.abs(h.ground - base[j]);
                    for (const k of [j - 1, j + 1]) {
                        if (k >= 0 && k < n && samples[k].weight < HOLD_WEIGHT && !samples[k].off) {
                            lift = Math.max(lift, Math.abs(h.ground - samples[k].ground) - spec.maxGrade * step);
                        }
                    }
                    if (lift <= spec.maxEarthworkM) {
                        return;
                    }
                    const reach = Math.ceil((lift - spec.maxEarthworkM) / (spec.maxGrade * step)) + 1;
                    for (let k = Math.max(0, j - reach); k <= Math.min(n - 1, j + reach); k++) {
                        band[k] = Math.max(band[k], lift - spec.maxGrade * step * Math.abs(k - j) + RAMP_SLACK_M);
                        rampZone[k] = 1;
                    }
                });
                const graded = gradeProfileWeighted(groundH, weights,
                    (spec.maxGrade * step) / dims.quant, band, STEEP_COST, groundH, dims.quant);
                // The grade breaks rounded into vertical curves, the dips under
                // them filled and the crests cut. A moving average never steepens
                // a line, so the limit still holds, and the held samples keep
                // their heights. It may take the earthworks a little past their
                // cap; clamping them back would put the kinks back.
                // Free in the fit, a structure's samples took any height; they
                // carry the nearest land sample's into the rounding instead, so
                // the curves on the land are not pulled towards them.
                for (let k = 0; k < n; k++) {
                    if (!samples[k].off) {
                        continue;
                    }
                    let near = -1;
                    for (let d = 1; d < n && near < 0; d++) {
                        if (k - d >= 0 && !samples[k - d].off) {
                            near = k - d;
                        } else if (k + d < n && !samples[k + d].off) {
                            near = k + d;
                        }
                    }
                    if (near >= 0) {
                        graded[k] = graded[near];
                    }
                }
                // No step steeper than the limit, or than the line already was
                // where the terrain made it give way. On a ramp to a held point
                // off its ground, the climb the limit cannot make is spread over
                // the ramp: charged by the metre past the limit wherever it
                // falls, the fit kept low to the end and climbed 11 m in the last
                // 5 m to a deck.
                const maxStep = spec.maxGrade * step;
                const holds = weights.map((w, k) => (w >= HOLD_WEIGHT ? k : -1)).filter(k => k >= 0);
                // Held exactly: where no ramp fits between two holds, the fit
                // settles short of one (a deck), and the stroke's end, put on
                // the deck, climbed 6.5 m in its last 5 m.
                const fitted = graded.slice();
                for (const k of holds) {
                    graded[k] = groundH[k];
                }
                const stepLimit = (i: number): number => {
                    // The holds either side: where they are further apart than the
                    // grade allows (a ramp to a deck, a border crossing held as both
                    // tiles agree), the difference is spread evenly between them -
                    // limited to the grade, it all went into one step (7 % on 3 %).
                    let a = -1, b = -1;
                    for (const k of holds) {
                        if (k <= i - 1) {
                            a = k;
                        } else if (k >= i && b < 0) {
                            b = k;
                        }
                    }
                    const need = a < 0 || b < 0 ? 0 : Math.abs(graded[b] - graded[a]) / (b - a);
                    // Steeper otherwise only where the ground under it is - a mountain
                    // line given way to its earthworks cap - not where the fit cut a
                    // corner to spare earthworks.
                    const own = rampZone[i] && rampZone[i - 1] ? maxStep
                        : Math.max(maxStep, Math.min(Math.abs(fitted[i] - fitted[i - 1]), Math.abs(groundH[i] - groundH[i - 1])));
                    return Math.max(own, need);
                };
                const rounded = roundGradeBreaks(graded, weights, spec.curveRadiusM / step, stepLimit);
                const design = spec.verticalRadiusM
                    // The embankment rises (or the cutting deepens) rather than the
                    // line kinking: a railway's as far as it takes (held to its cap,
                    // a quarter of its curves came out tighter than 500 m in the
                    // mountains), a road's to twice its cap. Not a street's, which
                    // follows its town's ground: there it went past its grade.
                    ? smoothVerticalCurves(rounded, weights, groundH,
                        band.map(b => (tier === RAIL_TIER ? Infinity : spec.refine ? b * VERTICAL_BAND_FACTOR : b)),
                        spec.verticalRadiusM, spec.maxGrade, step)
                    : rounded;
                for (let k = 1; k < n; k++) {
                    if (Math.abs(design[k] - design[k - 1]) > spec.maxGrade * step + dims.quant / 2) {
                        ts.overLimitM += step;
                    }
                }
                samples.forEach((s, k) => { s.h = design[k]; });
                // The stroke onto its profile, every vertex of the pair.
                const written: number[] = [];
                for (let i = 0; i < pts.length; i++) {
                    const k = Math.min(n - 2, Math.floor((cum[i] / length) * (n - 1)));
                    const t = Math.min(1, Math.max(0, (cum[i] / length) * (n - 1) - k));
                    let h = samples[k].h + (samples[k + 1].h - samples[k].h) * t;
                    // Beside a structure's sample (drawn far off the land, held
                    // there), a point takes the height of its own kind - a ground
                    // sample's, or as drawn: interpolated, a point drawn on the
                    // ground was dragged tens of metres into the air.
                    const ka = samples[k], kb = samples[k + 1];
                    if (ka.aloft || kb.aloft) {
                        const onLand = Math.abs(pts[i].h - (ground.at(pts[i].u, pts[i].v) ?? pts[i].h)) <= dims.offLand;
                        const same = !onLand ? undefined : !ka.aloft ? ka : !kb.aloft ? kb : undefined;
                        h = same ? same.h : pts[i].h;
                    }
                    // A point on a structure (over its own bridge, over water) is
                    // no junction: a road passing under the bridge, drawn at much
                    // the same height as the stretch drawn on the ground beneath
                    // the deck, was held up to the deck and buried it.
                    h = pts[i].h + (h - pts[i].h) * border.fade(pts[i].u, pts[i].v);
                    if (!ka.off && !kb.off) {
                        held.add(pts[i].u, pts[i].v, h, pts[i].h);
                    }
                    written.push(h);
                    const dh = (h - pts[i].h) / sq;
                    for (const vi of [pts[i].vi, pts[i].vi + 1]) {
                        strokePositions[vi * 3] = clampI16(strokePositions[vi * 3] + up[0] * dh);
                        strokePositions[vi * 3 + 1] = clampI16(strokePositions[vi * 3 + 1] + up[1] * dh);
                        strokePositions[vi * 3 + 2] = clampI16(strokePositions[vi * 3 + 2] + up[2] * dh);
                    }
                }
                // A stray end trimmed off goes to the height of the end it came
                // off, not its drawn one: left where drawn, it stood up or down
                // from the line as a spike.
                for (const t of trimmedOf.get(pts) ?? []) {
                    const first = Math.hypot(t.u - pts[0].u, t.v - pts[0].v) <= Math.hypot(t.u - pts[pts.length - 1].u, t.v - pts[pts.length - 1].v);
                    const dh = ((first ? written[0] : written[written.length - 1]) - t.h) / sq;
                    for (const vi of [t.vi, t.vi + 1]) {
                        strokePositions[vi * 3] = clampI16(strokePositions[vi * 3] + up[0] * dh);
                        strokePositions[vi * 3 + 1] = clampI16(strokePositions[vi * 3 + 1] + up[1] * dh);
                        strokePositions[vi * 3 + 2] = clampI16(strokePositions[vi * 3 + 2] + up[2] * dh);
                    }
                }
                // ... and its last point on the deck track's first.
                anchors.forEach((a, end) => {
                    if (a) {
                        const vi = pts[end === 0 ? 0 : pts.length - 1].vi;
                        for (const v of [vi, vi + 1]) {
                            strokePositions.set(a.q, v * 3);
                        }
                        written[end === 0 ? 0 : pts.length - 1] = a.h - liftM;
                    }
                });
                // The stroke is straight between its vertices, tens of metres
                // apart, and the profile bends between them: a dip under a
                // bridge, a vertical curve. Vertices go in where the straight
                // line strays from it - held down instead, the whole 72 m
                // stretch under a bridge, the ramps either side were squeezed
                // to 27 %.
                for (let i = 0; i + 1 < pts.length; i++) {
                    const s0 = cum[i], s1 = cum[i + 1];
                    if (s1 - s0 < 2 * STROKE_INSERT_MIN_M) {
                        continue;
                    }
                    const line: Array<{ s: number; u: number; v: number; h: number }> = [{ s: s0, u: pts[i].u, v: pts[i].v, h: written[i] }];
                    let structure = false;
                    for (let k = Math.ceil((s0 / length) * (n - 1) + 1e-9); k <= Math.floor((s1 / length) * (n - 1) - 1e-9); k++) {
                        const sk = (length * k) / (n - 1);
                        if (samples[k].off || samples[k].aloft) {
                            structure = true;
                            break;
                        }
                        if (sk - s0 < STROKE_INSERT_MIN_M || s1 - sk < STROKE_INSERT_MIN_M) {
                            continue;
                        }
                        const f = (sk - s0) / (s1 - s0);
                        const u = pts[i].u + (pts[i + 1].u - pts[i].u) * f, v = pts[i].v + (pts[i + 1].v - pts[i].v) * f;
                        const drawn = pts[i].h + (pts[i + 1].h - pts[i].h) * f;
                        line.push({ s: sk, u, v, h: drawn + (samples[k].h - drawn) * border.fade(u, v) });
                    }
                    if (structure || line.length < 2) {
                        continue;
                    }
                    line.push({ s: s1, u: pts[i + 1].u, v: pts[i + 1].v, h: written[i + 1] });
                    const keepIdx = simplifyProfile(line, STROKE_FIT_M);
                    if (keepIdx.length > 0) {
                        inserts.set(pts[i].vi, {
                            b: pts[i + 1].vi,
                            at: keepIdx.map(j => ({ t: (line[j].s - s0) / (s1 - s0), u: line[j].u, v: line[j].v, h: line[j].h })),
                        });
                    }
                }
                const half = Math.max(...pts.map(p => p.half));
                const chainBeds = beds.length;
                for (let k = 0; k + 1 < samples.length; k++) {
                    if (samples[k].off || samples[k + 1].off) {
                        continue;
                    }
                    // A bed ends square at a bridge's abutment: rounded, its batter
                    // ran on under the span and buried what the bridge crosses.
                    const open = (k === 0 && anchors[0] ? BED_OPEN_A : 0)
                        | (k + 2 === samples.length && anchors[1] ? BED_OPEN_B : 0);
                    // Its batter needs only reach as far as it takes to meet the
                    // ground it left: a line laid on its own ground touches
                    // nothing past its edges, and a hillside beside a street
                    // stays as it is.
                    const lift = Math.max(Math.abs(samples[k].h - samples[k].land), Math.abs(samples[k + 1].h - samples[k + 1].land));
                    // A street well off the ground the tiers above left it - a
                    // ramp up to a higher line, a railway cutting reaching under
                    // its bridge approach - refines the land like they do: over
                    // the land's sparse vertices alone it floated. One riding a
                    // higher line's embankment does not; that is refined already.
                    const sa = samples[k], sb = samples[k + 1];
                    const against = Math.max(Math.abs(sa.h - (sa.above ?? sa.land)), Math.abs(sb.h - (sb.above ?? sb.land)));
                    const refine = spec.refine || against > STREET_REFINE_LIFT_M;
                    const reach = Math.min(BATTER_REACH_M, lift / BATTER + (spec.refine ? BATTER_REACH_MARGIN_M : STREET_REACH_MARGIN_M));
                    beds.push({ a: samples[k], b: samples[k + 1], half, open, tier, reach, refine });
                }
                // Square at the abutment means all of it: the last segment is
                // 5 m, and the one before it rounded its batter on 30 m past the
                // abutment, lifting the ground under the span - spikes between
                // the roads passing under, and walls round them.
                anchors.forEach((a, end) => {
                    if (!a) {
                        return;
                    }
                    const p = samples[end === 0 ? 0 : n - 1], q2 = samples[end === 0 ? 1 : n - 2];
                    const len = Math.hypot(p.u - q2.u, p.v - q2.v);
                    if (len < 1e-6) {
                        return;
                    }
                    const du = (p.u - q2.u) / len, dv = (p.v - q2.v) / len;
                    for (let i = chainBeds; i < beds.length; i++) {
                        const s = beds[i];
                        const r = s.half + SHOULDER_M + s.reach + BATTER_FADE_M;
                        if (Math.min(Math.hypot(s.a.u - p.u, s.a.v - p.v), Math.hypot(s.b.u - p.u, s.b.v - p.v)) <= r) {
                            (s.cut ??= []).push(p.u, p.v, du, dv);
                        }
                    }
                });
            }
        }
    }
    for (const ts of stats.byTier) {
        stats.trackM += ts.lengthM;
        stats.steepM += ts.steepM;
        stats.overLimitM += ts.overLimitM;
    }
    const strokesOut = inserts.size > 0 ? insertStrokeVertices(strokes, strokePositions, inserts, frame, liftM) : undefined;
    const outPositions = strokesOut?.positions ?? strokePositions;
    const bedFloats = bedSegmentFloats(beds, frame);
    if (input.bedsOnly || (beds.length === 0 && neighbourBeds.length === 0)) {
        return { strokePositions: outPositions, strokes: strokesOut, beds: bedFloats, stats };
    }
    // The land follows the neighbours' beds too: their batters reach over the border.
    const landBeds = neighbourBeds.length > 0 ? [...beds, ...neighbourBeds] : beds;
    const bedIndex = new BedIndex(landBeds, dims.cell / 2);
    // Triangles are split only to follow the tiers that refine (streets
    // move the vertices there are); every tier moves them.
    const refining = landBeds.filter(b => b.refine);
    const refineIndex = refining.length > 0 ? new BedIndex(refining, dims.cell / 2) : undefined;
    const refineResolver = new BandResolver();

    // --- the mesh, deduplicated by position for adjacency ---------------------
    const mesh = new SoupMesh(land, q, frame, input.pinned, triCount, dims);
    if (refineIndex) {
        mesh.splitAt = (ua, va, ub, vb) => refineIndex.creaseCrossing(ua, va, ub, vb);
    }
    // Roads, bridges, water keep their ground: they are drawn as baked, so
    // a batter spilling onto one would bury it. See KeepIndex.
    const keep = new KeepIndex(input.keep, frame, dims.cell, (u0, v0, u1, v1) => bedIndex.anyNear(u0, v0, u1, v1), (u, v) => ground.at(u, v));
    const resolver = new BandResolver();
    // Under a bridge deck the land stays clear of it: the bake left some
    // decks flush with the ground, and with the land re-cut beside them the
    // two fought for the same pixels and the land won.
    // Beside one, no higher than it either, rising off it at a batter's
    // slope: a road bridge sunk 6 m into a hill at Garmisch (47.513, 11.107)
    // had the land - and the walls holding it - standing over its deck. A
    // line's own surface and land kept as baked stay as they are.
    const beside = input.deckTops && input.deckTops.length > 0 ? new DeckCeiling(input.deckTops, frame) : undefined;
    const underDeck = (u: number, v: number, h: number): number => {
        const top = deckTops?.top(u, v);
        if (top !== undefined) {
            return Math.min(h, top - DECK_CLEAR_M);
        }
        const c = beside?.at(u, v);
        if (c === undefined || h <= c || bedIndex.onCarriageway(u, v, SHOULDER_M) || keep.allowance(u, v) === 0) {
            return h;
        }
        return c;
    };
    // A free border (RailBedInput.freeBorder): its vertices move to the
    // beds' heights where free, but an edge between two of them is never
    // split - the seam table holds it - so the land along it can only move
    // as its two ends do. The target eases from the beds' over the last
    // BORDER_TAPER_M to exactly that: achievable, so the refinement stops
    // (aimed at the beds' own heights, it ground every triangle along the
    // border down to its smallest), and the same on both tiles, whose
    // shared vertices both take the beds' heights - the neighbours' beds
    // are this tile's too.
    const atBorder = (f: (u: number, v: number, h: number) => number) => (u: number, v: number, h: number): number => {
        const taper = border.taper(u, v);
        // A line's own surface is never eased: eased, the B2 under the
        // railway bridge at Garmisch, 15 m in from the border, kept half its
        // cut and the land buried its outer half. The batter between it and
        // the border takes the difference, as steep as it must be.
        if (taper >= 1 || bedIndex.onCarriageway(u, v, SHOULDER_M)) {
            return f(u, v, h);
        }
        const e = border.nearestEdge(u, v);
        if (!e) {
            return f(u, v, h);
        }
        const dA = border.movable(e.ua, e.va) ? f(e.ua, e.va, e.ha) - e.ha : 0;
        const dB = border.movable(e.ub, e.vb) ? f(e.ub, e.vb, e.hb) - e.hb : 0;
        const dEdge = dA + (dB - dA) * e.t;
        return h + dEdge + (f(u, v, h) - h - dEdge) * taper;
    };
    const freeTarget = input.freeBorder ? atBorder((u, v, h) => bedTarget(u, v, h)) : undefined;
    const target = (u: number, v: number, h: number): number => {
        if (freeTarget) {
            return underDeck(u, v, freeTarget(u, v, h));
        }
        const fade = border.fade(u, v);
        return underDeck(u, v, fade === 0 ? h : h + (bedTarget(u, v, h) - h) * fade);
    };
    const bedTarget = (u: number, v: number, h: number): number => {
        const bed = bedIndex.target(u, v, h, resolver);
        // On a bed itself the line wins: what is kept clear of gets a steep
        // edge (then a wall) rather than the line floating.
        if (resolver.core) {
            return bed;
        }
        const allow = keep.allowance(u, v);
        return allow === Infinity ? bed : Math.min(h + allow, Math.max(h - allow, bed));
    };

    // --- refine where the bed moves the ground -------------------------------
    const queue: number[] = [];
    for (let t = 0; t < mesh.tris.length; t++) {
        queue.push(t);
    }
    // What the refining tiers alone would make of the ground.
    const refineTarget = (u: number, v: number, h: number): number => underDeck(u, v, freeRefine ? freeRefine(u, v, h) : refineTargetBeds(u, v, h));
    const refineTargetBeds = (u: number, v: number, h: number, free = false): number => {
        const fade = free ? 1 : border.fade(u, v);
        if (fade === 0 || !refineIndex) {
            return h;
        }
        const bed = refineIndex.target(u, v, h, refineResolver);
        let out = bed;
        if (!refineResolver.core) {
            const allow = keep.allowance(u, v);
            out = allow === Infinity ? bed : Math.min(h + allow, Math.max(h - allow, bed));
        }
        return h + (out - h) * fade;
    };
    const freeRefine = input.freeBorder ? atBorder((u, v, h) => refineTargetBeds(u, v, h, true)) : undefined;
    while (input.refine !== false && refineIndex && queue.length > 0 && mesh.added < MAX_NEW_TRIANGLES) {
        const t = queue.pop()!;
        if (!mesh.tris[t].alive) {
            continue;
        }
        if (!mesh.needsSplit(t, refineTarget, refineIndex, deckTops)) {
            continue;
        }
        const made = mesh.refine(t);
        for (const c of made) {
            queue.push(c);
        }
    }

    // --- move the vertices -----------------------------------------------------
    // A vertex of a long triangle (a merged field hundreds of metres across)
    // moved for a street that does not refine tilted the whole field into a
    // long dark wedge: it follows only the lines that refine.
    // A land-use fill lies a hair over the ground it covers (FILL_LIFT_CELLS
    // in the bake); moved to the same height as that ground, the two fought
    // and the ground showed through as dark wedges. Each vertex moves by
    // what the beds do to the ground under it, and keeps its lift.
    const keepLift = (f: (u: number, v: number, h: number) => number) => (u: number, v: number, h: number): number => {
        const under = ground.lowest(u, v);
        const lift = under !== undefined && h - under > 0.005 && h - under < FILL_LIFT_MAX_M ? h - under : 0;
        return f(u, v, h - lift) + lift;
    };
    const moved = mesh.displace(keepLift(target), keepLift(refineIndex ? refineTarget : (_u, _v, h) => h), (u, v) => border.movable(u, v));
    // No terrain over a road or a railway: the land under every drawn line is
    // kept under its surface, split where it rises over one between vertices
    // (leaves only: a coarse tile's vertices are only lowered).
    const roadCap = new RoadCap(strokesOut ?? { ...strokes, positions: outPositions }, sq, frame, ROAD_CAP_CLEAR_LIFT * liftM, liftM);
    const underRoads = roadCap.empty ? { lowered: 0, split: 0 }
        : (() => {
            mesh.placeNew = keepLift(target);
            const r = mesh.keepUnderRoads(roadCap, input.refine !== false, mesh.added + ROAD_CAP_MAX_NEW);
            mesh.placeNew = undefined;
            return r;
        })();
    stats.landLoweredUnderRoads = underRoads.lowered;
    stats.splitForRoads = underRoads.split;
    if (moved === 0 && underRoads.lowered === 0 && underRoads.split === 0) {
        return { strokePositions: outPositions, strokes: strokesOut, beds: bedFloats, stats };
    }
    // Splits that left the surface flat - the top of a bed, a straight
    // batter - are taken back; not under a deck, which the land must stay below.
    stats.trianglesCollapsed = input.refine === false ? 0
        : mesh.collapseFlat(
            // Only a little lower beside a drawn line: its ribbon floats over
            // the land, and land let down beside it would open a gap under its
            // edge. Higher is up to the road cap, on the carriageway itself.
            // Under a deck, only lower: the refinement brought the land clear
            // of it, and a collapse below the refined surface keeps it clear.
            {
                limit: COLLAPSE_TOLERANCE_M, nearDown: COLLAPSE_LINE_TOLERANCE_M,
                near: (u, v) => roadCap.cap(u, v, SHOULDER_M + COLLAPSE_NEAR_LINE_M) !== undefined,
                under: (u, v) => deckTops?.top(u, v) !== undefined,
            },
            roadCap,
        );
    // Spikes left standing - one vertex held up while the land round it went
    // down to a road or a deck's clearance: under the B2's bridges at
    // Garmisch they stood 4-5 m tall and a metre wide.
    stats.spikesLowered = mesh.despike(DESPIKE_SLOPE);
    stats.trianglesAdded = mesh.pieceCount();
    stats.verticesMoved = moved;
    // Land lowered under a deck is the deck's clearance, not an earthwork:
    // walls stood round a road bridge lying on the ground. A face counts
    // only if the beds alone moved one of its corners - a street's cutting
    // under a railway bridge does.
    const byBeds = keepLift((u: number, v: number, h: number): number => {
        if (freeTarget) {
            return freeTarget(u, v, h);
        }
        const fade = border.fade(u, v);
        return fade === 0 ? h : h + (bedTarget(u, v, h) - h) * fade;
    });
    mesh.markWalls(deckTops ? (u, v, h) => Math.abs(byBeds(u, v, h) - h) >= WALL_MIN_MOVE_M : undefined);
    // Walls only where the land was refined to need them: a coarse tile's
    // cutting is a few pixels, its vertices only moved.
    // Streets get walls only where they refine the land like the tiers
    // above: over sparse vertices their steep facets made stray blocks.
    // Every line drawn on the tile, bed or not: a carriageway held off the
    // land has no bed, but a wall standing on it stands on the road all the same.
    const drawn = new DrawnLines(bedChains(strokes).map(c => ({
        points: c.chain.map(vi => frame.toPlan([strokes.positions[vi * 3] * sq, strokes.positions[vi * 3 + 1] * sq, strokes.positions[vi * 3 + 2] * sq])),
        half: c.chain.map(vi => strokes.halfWidths[vi] / 10),
    })), DRAWN_CELL_M);
    const onRoadClear = (u: number, v: number) => bedIndex.onCarriageway(u, v, WALL_ROAD_CLEAR_M) || drawn.on(u, v, WALL_ROAD_CLEAR_M);
    const pieces: WallPiece[] = [];
    const walls = input.refine === false ? undefined : retainingWalls(beds.filter(b => BED_TIERS[b.tier].walls || b.refine), frame, (u, v) => {
        const h = ground.at(u, v);
        return h === undefined ? -Infinity : target(u, v, h);
    }, onRoadClear, pieces, (u, v) => {
        const top = deckTops?.top(u, v);
        return top === undefined ? undefined : deckUnders?.below(u, v, top) ?? top - UNDERSIDE_FALLBACK_M;
    });
    // The land cut along the walls' faces: a facet's slope from the road up
    // behind a face stood in front of it, a green wedge on the concrete.
    const fitted = cutLandAtWalls(mesh.toSoup(), q, frame, pieces,
        // Kept as baked: water, and the bridges' triangles - but not the land
        // under a deck, which its clearance moves anyway: kept, the slopes
        // under the B2's bridges stood up the walls there as before.
        (u, v) => border.taper(u, v) < CUT_BORDER_TAPER
            || (keep.allowance(u, v) < CUT_KEEP_ALLOWANCE_M && deckTops?.top(u, v) === undefined));
    const landOut = fitted.soup;
    stats.landCutAtWalls = fitted.cut;
    // A bridge's abutments and piers were built down to the ground as the
    // bridge bake read it, before these earthworks: where they lowered it,
    // the concrete stood in the air over the land.
    const underpins = input.deckConcrete && input.deckConcrete.length > 0
        ? underpinConcrete(input.deckConcrete, frame, new GroundIndex(landOut.positions, q, frame, dims.cell), ground,
            (u, v) => bedIndex.onCarriageway(u, v, WALL_ROAD_CLEAR_M) || drawn.on(u, v, WALL_ROAD_CLEAR_M))
        : undefined;
    stats.underpinTriangles = underpins ? underpins.indices.length / 3 : 0;
    const allWalls = joinWalls(walls, underpins);
    stats.wallTriangles = allWalls ? allWalls.indices.length / 3 : 0;
    return { land: landOut, strokePositions: outPositions, strokes: strokesOut, beds: bedFloats, walls: allWalls, stats };
}

/** A land corner this near the tile border (BorderIndex.taper under this) is on it: an edge between two such is never stepped. */
const CUT_BORDER_TAPER = 1e-3;
/** Land kept as baked (water...) that may move less than this is never cut nor moved by a wall, metres. */
const CUT_KEEP_ALLOWANCE_M = 1;
/** Behind a face the land is held up this far under its top: as high, the two fought, metres. */
const CUT_UNDER_TOP_M = 0.3;
/** A land corner this near in front of a face is at it, and comes down to its foot, metres: the mesh's own slope stood up in front of it. */
const CUT_SNAP_M = 0.3;
/**
 * The land steps this far behind a face, not on it, metres: rounded to the
 * tile's quantum (8 cm at a leaf), a step on the face stood a few
 * centimetres in front of it in places, a jagged green line up the wall.
 */
const CUT_BEHIND_M = 0.15;
/** A crossing this near a piece's end, metres, is within it (rounding). */
const CUT_END_M = 0.01;

/**
 * The land cut along the retaining walls' faces (`pieces`): every facet
 * crossing a face's line is split there, and within the piece the land
 * steps at it - in front down at the wall's foot, behind up at its top, at
 * most. A piece's end inside a facet is a corner of the cut, so the step
 * holds right to it; past it the land runs on unstepped (a step there would
 * be a hole no face covers). A facet's slope from the road up behind a
 * face stood out in front of it as a green wedge on the concrete (the B2
 * under its bridges at Garmisch).
 *
 * Where an edge crosses a face, and both heights there, follow from that
 * edge and that piece alone, so the facets either side of an edge cut it
 * alike and no crack opens between them. Past a piece's ends a crossing
 * does not step, nor on an edge along the tile border (`fixed` at both
 * ends): the tile across meets it as baked - nor on one with an end in
 * something kept as baked (`fixed` at either: a lake beside a cutting). On a road it does: the land in
 * front only comes down, and behind is under the wall's top, which never
 * stands on one - tested crossing by crossing, a face 0.3 m off a road's
 * keep-clear stepped at one and not the next, a jagged edge up the wall.
 * The step is CUT_BEHIND_M behind the face, so rounding never brings it out
 * in front. A corner from there to CUT_SNAP_M in front of the face (within
 * its length) comes down to the foot; every facet sharing it does the same.
 * No other vertex moves: moving the corners behind a
 * face up to its top lifted the facets crossing it past a piece's end, and
 * the land stood up the faces twice as often. Facets cut nowhere go back
 * bit for bit; the originals' slots first, the pieces cut off after them.
 */
export function cutLandAtWalls(
    soup: LandSoup, q: number, frame: PlanFrame, pieces: readonly WallPiece[],
    fixed: (u: number, v: number) => boolean = () => false,
): { soup: LandSoup; cut: number } {
    if (pieces.length === 0) {
        return { soup, cut: 0 };
    }
    const { a, b, up } = frame;
    const CELL = 16;
    // Each piece's line: along it from A (tu, tv), and its front (ou, ov).
    const P = pieces.map(pc => {
        const L = Math.hypot(pc.b.u - pc.a.u, pc.b.v - pc.a.v) || 1;
        const ol = Math.hypot(pc.ou, pc.ov) || 1;
        return { pc, L, tu: (pc.b.u - pc.a.u) / L, tv: (pc.b.v - pc.a.v) / L, ou: pc.ou / ol, ov: pc.ov / ol, foot: pc.bottom + WALL_FOOT_M };
    });
    const grid = new Map<number, number[]>();
    P.forEach((p, i) => {
        const r = CUT_END_M + 1;
        for (let cu = Math.floor((Math.min(p.pc.a.u, p.pc.b.u) - r) / CELL); cu <= Math.floor((Math.max(p.pc.a.u, p.pc.b.u) + r) / CELL); cu++) {
            for (let cv = Math.floor((Math.min(p.pc.a.v, p.pc.b.v) - r) / CELL); cv <= Math.floor((Math.max(p.pc.a.v, p.pc.b.v) + r) / CELL); cv++) {
                const key = cellKey(cu, cv);
                const list = grid.get(key);
                if (list) {
                    list.push(i);
                } else {
                    grid.set(key, [i]);
                }
            }
        }
    });
    /**
     * A corner (`key`: its quantised position) or a point the cut made; one
     * on an edge of the baked facets says which (`on`); a crossing of piece
     * `of` also says how far along it.
     */
    interface Vx {
        u: number; v: number; h: number; attr: number[];
        key?: string; on?: string; of?: number; along?: number; fixed?: boolean; plain?: boolean;
    }
    const n = soup.positions.length / 9;
    const slots = new Map<number, Vx[]>();
    const extra: Vx[][] = [];
    /** Each facet cut, as its triangles. */
    const made = new Map<number, Vx[][]>();
    let cut = 0;
    const corners = (t: number): Vx[] => [0, 1, 2].map(k => {
        const o = t * 9 + k * 3;
        const [u, v, h] = frame.toPlan([soup.positions[o] * q, soup.positions[o + 1] * q, soup.positions[o + 2] * q]);
        const ao = t * 12 + k * 4;
        return {
            u, v, h, attr: [soup.attrs[ao], soup.attrs[ao + 1], soup.attrs[ao + 2], soup.attrs[ao + 3]],
            key: `${soup.positions[o]},${soup.positions[o + 1]},${soup.positions[o + 2]}`,
        };
    });
    const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    /** The baked edge a segment between two points lies on, if any. */
    const edgeOf = (x: Vx, y: Vx): string | undefined => {
        if (x.key && y.key) {
            return edgeKey(x.key, y.key);
        }
        if (x.key && y.on) {
            return y.on.split('|').includes(x.key) ? y.on : undefined;
        }
        if (y.key && x.on) {
            return x.on.split('|').includes(y.key) ? x.on : undefined;
        }
        return x.on !== undefined && x.on === y.on ? x.on : undefined;
    };
    // Unstepped points the cut put on baked edges: the facet across each
    // edge, cut or not, takes them too - left out, a point rounded a few
    // centimetres off the edge opened a crack at a wall's end.
    const onEdge = new Map<string, Map<string, Vx>>();
    const record = (x: Vx) => {
        if (x.on === undefined) {
            return;
        }
        const pts = onEdge.get(x.on) ?? onEdge.set(x.on, new Map()).get(x.on)!;
        pts.set(`${x.u.toFixed(4)},${x.v.toFixed(4)}`, x);
    };
    for (let t = 0; t < n; t++) {
        const c = corners(t);
        const near = new Set<number>();
        for (let cu = Math.floor(Math.min(c[0].u, c[1].u, c[2].u) / CELL); cu <= Math.floor(Math.max(c[0].u, c[1].u, c[2].u) / CELL); cu++) {
            for (let cv = Math.floor(Math.min(c[0].v, c[1].v, c[2].v) / CELL); cv <= Math.floor(Math.max(c[0].v, c[1].v, c[2].v) / CELL); cv++) {
                for (const i of grid.get(cellKey(cu, cv)) ?? []) {
                    near.add(i);
                }
            }
        }
        if (near.size === 0) {
            continue;
        }
        for (const x of c) {
            x.fixed = fixed(x.u, x.v);
        }
        let stepped = false;
        // Corners just in front of a face: down at its foot. Every piece near
        // the corner is in its cells' lists, whichever facet asks.
        for (const x of c) {
            if (x.fixed) {
                continue;
            }
            for (const i of grid.get(cellKey(Math.floor(x.u / CELL), Math.floor(x.v / CELL))) ?? []) {
                const p = P[i];
                const d = (x.u - p.pc.a.u) * p.ou + (x.v - p.pc.a.v) * p.ov;
                const along = (x.u - p.pc.a.u) * p.tu + (x.v - p.pc.a.v) * p.tv;
                if (d >= -CUT_BEHIND_M && d <= CUT_SNAP_M && along >= 0 && along <= p.L && x.h > p.foot) {
                    x.h = p.foot;
                    stepped = true;
                }
            }
        }
        const plane = c.map(x => ({ ...x }));
        let polys: Vx[][] = [c];
        // In one order everywhere, so two facets sharing an edge cut it alike.
        for (const i of [...near].sort((x, y) => x - y)) {
            const p = P[i];
            const next: Vx[][] = [];
            for (const poly of polys) {
                // Front of the line the land steps on, CUT_BEHIND_M behind the face.
                const d = poly.map(x => (x.u - p.pc.a.u) * p.ou + (x.v - p.pc.a.v) * p.ov + CUT_BEHIND_M);
                if (Math.max(...d) <= 0 || Math.min(...d) >= 0) {
                    next.push(poly);
                    continue;
                }
                // Each side: its corners, and the crossings with the heights it takes there.
                const front: Vx[] = [], back: Vx[] = [];
                let span = false;
                for (let k = 0; k < poly.length; k++) {
                    const x = poly[k], y = poly[(k + 1) % poly.length], dx = d[k], dy = d[(k + 1) % poly.length];
                    if (dx >= 0) {
                        front.push(x);
                    }
                    if (dx <= 0) {
                        back.push(x);
                    }
                    if ((dx > 0 && dy < 0) || (dx < 0 && dy > 0)) {
                        const f = dx / (dx - dy);
                        const u = x.u + (y.u - x.u) * f, v = x.v + (y.v - x.v) * f, h = x.h + (y.h - x.h) * f;
                        const along = (u - p.pc.a.u) * p.tu + (v - p.pc.a.v) * p.tv;
                        const attr = x.attr.map((av, m) => (m < 3 ? Math.round(av + (y.attr[m] - av) * f) : (f < 0.5 ? av : y.attr[m])));
                        const steps = along >= -CUT_END_M && along <= p.L + CUT_END_M && !x.fixed && !y.fixed;
                        const top = p.pc.a.top + (p.pc.b.top - p.pc.a.top) * Math.max(0, Math.min(1, along / p.L)) - CUT_UNDER_TOP_M;
                        const on = edgeOf(x, y);
                        front.push({ u, v, h: steps ? Math.min(h, p.foot) : h, attr, of: i, along, on, plain: !steps });
                        back.push({ u, v, h: steps ? Math.max(h, top) : h, attr, of: i, along, on, plain: !steps });
                        span ||= steps;
                    }
                }
                // The piece's ends between the two crossings: corners of the
                // cut on both sides, stepped, their height across the facet
                // read off the cut's ends.
                const cross = front.filter(x => x.of === i);
                // Past an end the land behind meets the land in front: the back
                // is cut again along the end's line, and the step runs up it,
                // under the wall's end cap. Left on the face's line past the
                // end, it opened a hole no face covered.
                const endCuts: Array<{ e: number; back: Vx; frontH: number; reach: number }> = [];
                if (cross.length === 2) {
                    const [c0, c1] = cross;
                    const ends = [0, p.L].filter(e => e > Math.min(c0.along!, c1.along!) + 1e-3 && e < Math.max(c0.along!, c1.along!) - 1e-3);
                    const at = ends.map(e => {
                        const f = (e - c0.along!) / (c1.along! - c0.along!);
                        const u = c0.u + (c1.u - c0.u) * f, v = c0.v + (c1.v - c0.v) * f;
                        // Plain height there: on the facet's own plane, as baked.
                        const plain = planeHeight(plane, u, v);
                        const top = p.pc.a.top + (p.pc.b.top - p.pc.a.top) * (e / p.L) - CUT_UNDER_TOP_M;
                        const fx: Vx = { u, v, h: Math.min(plain, p.foot), attr: c0.attr.slice() };
                        const bx: Vx = { u, v, h: Math.max(plain, top), attr: c0.attr.slice() };
                        endCuts.push({ e, back: bx, frontH: fx.h, reach: (e === 0 ? p.pc.a.reach : p.pc.b.reach) - CUT_BEHIND_M });
                        return { e, fx, bx };
                    });
                    for (const side of [front, back]) {
                        const i0 = side.findIndex(x => x.of === i);
                        const i1 = side.findIndex((x, k) => k > i0 && x.of === i);
                        // The cut runs between the two crossings: adjacent in the ring, one way round or the other.
                        const [from, ins] = i1 === i0 + 1 ? [side[i0], i1] : [side[i1], side.length];
                        const pts = at
                            .map(a => ({ d: Math.abs(a.e - from.along!), x: side === front ? a.fx : a.bx }))
                            .sort((x, y) => x.d - y.d)
                            .map(a => a.x);
                        side.splice(ins, 0, ...pts);
                    }
                }
                let backs: Vx[][] = [back];
                for (const ec of endCuts) {
                    // Into the piece from its end: along it from A, back from B.
                    const sgn = ec.e === 0 ? 1 : -1;
                    const out: Vx[][] = [];
                    for (const bp of backs) {
                        if (!bp.includes(ec.back)) {
                            out.push(bp);
                            continue;
                        }
                        const sd = bp.map(x => ((x.u - ec.back.u) * p.tu + (x.v - ec.back.v) * p.tv) * sgn);
                        const inside: Vx[] = [], outside: Vx[] = [];
                        for (let k = 0; k < bp.length; k++) {
                            const x = bp[k], y = bp[(k + 1) % bp.length], dx = sd[k], dy = sd[(k + 1) % bp.length];
                            if (dx >= 0) {
                                inside.push(x);
                            }
                            if (dx <= 0) {
                                outside.push(x === ec.back ? { ...x, h: ec.frontH } : x);
                            }
                            if ((dx > 0 && dy < 0) || (dx < 0 && dy > 0)) {
                                const f = dx / (dx - dy);
                                const cx: Vx = {
                                    u: x.u + (y.u - x.u) * f, v: x.v + (y.v - x.v) * f, h: x.h + (y.h - x.h) * f,
                                    attr: x.attr.map((av, m) => (m < 3 ? Math.round(av + (y.attr[m] - av) * f) : av)), on: edgeOf(x, y),
                                    plain: true,
                                };
                                inside.push(cx);
                                outside.push(cx);
                            }
                        }
                        // The end cap covers the step up the end's line only as far
                        // back as the wall's top reaches: there the two sides meet
                        // again, on the land as baked - stepping on past it, sky
                        // showed between the cap and the bank beyond.
                        const sAlong = (x: Vx) => (x.u - ec.back.u) * (-p.ou) + (x.v - ec.back.v) * (-p.ov);
                        const chord = (poly: Vx[]) => poly.filter(x => Math.abs(((x.u - ec.back.u) * p.tu + (x.v - ec.back.v) * p.tv)) < 1e-6);
                        const far = chord(inside).reduce((m, x) => Math.max(m, sAlong(x)), 0);
                        if (far > ec.reach + 1e-3 && ec.reach > 0) {
                            const ru = ec.back.u - p.ou * ec.reach, rv = ec.back.v - p.ov * ec.reach;
                            const R: Vx = { u: ru, v: rv, h: planeHeight(plane, ru, rv), attr: ec.back.attr.slice(), plain: true };
                            for (const poly of [inside, outside]) {
                                // Into the chord, between the corner nearest the end and the one past the reach.
                                const k = poly.findIndex((x, j) => {
                                    const y = poly[(j + 1) % poly.length];
                                    const onChord = (z: Vx) => Math.abs((z.u - ec.back.u) * p.tu + (z.v - ec.back.v) * p.tv) < 1e-6;
                                    return onChord(x) && onChord(y) && (sAlong(x) - ec.reach) * (sAlong(y) - ec.reach) < 0;
                                });
                                if (k >= 0) {
                                    poly.splice(k + 1, 0, R);
                                }
                            }
                        }
                        out.push(...[inside, outside].filter(q => q.length >= 3));
                    }
                    backs = out;
                }
                // Crossed only past the piece: no cut. Split by a line 16 m past
                // its end, a facet's pieces mixed with the next piece's cut.
                if (!span) {
                    next.push(poly);
                    continue;
                }
                next.push(front, ...backs);
                stepped = true;
            }
            polys = next;
        }
        // Cut only where it steps: a facet crossed nowhere within a piece
        // shares no stepping edge with a neighbour, and keeps its smooth
        // normals as baked.
        if (!stepped) {
            continue;
        }
        cut++;
        // The unstepped points on baked edges: the facet across each edge
        // takes them too (a stepped one it makes itself).
        for (const poly of polys) {
            for (const x of poly) {
                if (x.plain && x.on !== undefined) {
                    record(x);
                }
            }
        }
        const tris: Vx[][] = polys.flatMap(triangulateConvex);
        if (tris.length === 0) {
            continue;
        }
        made.set(t, tris);
    }
    // Every triangle with an edge on a baked edge another facet put a point
    // on, inside it: that point is a corner of it too - the facets the cut
    // left whole, and those it cut (a corner moved to a face's foot) that
    // did not cross the same line there.
    for (let t = 0; t < n && onEdge.size > 0; t++) {
        const own = made.get(t) ?? [corners(t)];
        let changed = false;
        const out = own.flatMap(tri => {
            const ring: Vx[] = [];
            for (let k = 0; k < 3; k++) {
                const a = tri[k], b = tri[(k + 1) % 3];
                ring.push(a);
                const e = edgeOf(a, b);
                const pts = e === undefined ? undefined : onEdge.get(e);
                if (pts) {
                    const du = b.u - a.u, dv = b.v - a.v, l2 = du * du + dv * dv || 1;
                    ring.push(...[...pts.values()]
                        .map(x => ({ x, f: ((x.u - a.u) * du + (x.v - a.v) * dv) / l2 }))
                        .filter(e2 => e2.f > 1e-6 && e2.f < 1 - 1e-6)
                        .sort((x, y) => x.f - y.f)
                        .map(e2 => e2.x));
                }
            }
            if (ring.length === 3) {
                return [tri];
            }
            changed = true;
            const split = triangulateConvex(ring);
            return split.length > 0 ? split : [tri];
        });
        if (changed) {
            made.set(t, out);
        }
    }
    for (const [t, tris] of made) {
        slots.set(t, tris[0]);
        extra.push(...tris.slice(1));
    }
    if (slots.size === 0) {
        return { soup, cut };
    }
    const total = n + extra.length;
    const positions = new Int16Array(total * 9);
    const normals = new Int8Array(total * 12);
    const attrs = new Uint8Array(total * 12);
    positions.set(soup.positions);
    normals.set(soup.normals);
    attrs.set(soup.attrs);
    const put = (slot: number, vs: Vx[]) => {
        const tile = vs.map(x => [0, 1, 2].map(m => x.u * a[m] + x.v * b[m] + x.h * up[m]));
        const e1 = [0, 1, 2].map(m => tile[1][m] - tile[0][m]), e2 = [0, 1, 2].map(m => tile[2][m] - tile[0][m]);
        let nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        // Facing up, and wound the way it faces.
        const flip = nrm[0] * up[0] + nrm[1] * up[1] + nrm[2] * up[2] < 0;
        if (flip) {
            nrm = nrm.map(x => -x);
        }
        const len = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
        (flip ? [0, 2, 1] : [0, 1, 2]).forEach((src, k) => {
            const po = slot * 9 + k * 3, no = slot * 12 + k * 4;
            for (let m = 0; m < 3; m++) {
                positions[po + m] = clampI16(tile[src][m] / q);
                normals[no + m] = Math.round((nrm[m] / len) * 127);
                attrs[no + m] = vs[src].attr[m];
            }
            normals[no + 3] = 0;
            attrs[no + 3] = vs[src].attr[3];
        });
        unifyCorners(attrs, slot * 12);
    };
    for (const [t, vs] of slots) {
        put(t, vs);
    }
    extra.forEach((vs, k) => put(n + k, vs));
    return { soup: { positions, normals, attrs }, cut };
}

/**
 * A convex polygon (plan u, v) as triangles, every corner kept and none
 * flat. A cut leaves several corners in a line: a fan from one of them made
 * flat triangles that spread a wall's step across the whole facet, and
 * clipping the largest ear first left the cut's corners alone in a line. A
 * fan from a corner every triangle of which has an area; else the largest
 * ears.
 */
function triangulateConvex<T extends { u: number; v: number }>(poly: readonly T[]): T[][] {
    const area = (a: T, b: T, c: T) => (b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v);
    let sign = 0;
    for (let k = 1; k + 1 < poly.length; k++) {
        sign += area(poly[0], poly[k], poly[k + 1]);
    }
    sign = Math.sign(sign) || 1;
    const n = poly.length;
    for (let apex = 0; apex < n; apex++) {
        const fan: T[][] = [];
        for (let k = 1; k + 1 < n; k++) {
            const tri = [poly[apex], poly[(apex + k) % n], poly[(apex + k + 1) % n]];
            if (area(tri[0], tri[1], tri[2]) * sign <= 1e-9) {
                break;
            }
            fan.push(tri);
        }
        if (fan.length === n - 2) {
            return fan;
        }
    }
    const ring = poly.slice();
    const out: T[][] = [];
    while (ring.length > 3) {
        let best = -1, bestArea = 1e-9;
        for (let k = 0; k < ring.length; k++) {
            const A = area(ring[(k + ring.length - 1) % ring.length], ring[k], ring[(k + 1) % ring.length]) * sign;
            if (A > bestArea) {
                bestArea = A;
                best = k;
            }
        }
        if (best < 0) {
            return out;
        }
        out.push([ring[(best + ring.length - 1) % ring.length], ring[best], ring[(best + 1) % ring.length]]);
        ring.splice(best, 1);
    }
    if (Math.abs(area(ring[0], ring[1], ring[2])) > 1e-9) {
        out.push(ring);
    }
    return out;
}

/** The height at (u, v) of the plane through a polygon's first three corners (plan u, v, h). */
function planeHeight(poly: ReadonlyArray<{ u: number; v: number; h: number }>, u: number, v: number): number {
    const [A, B, C] = poly;
    const det = (B.v - C.v) * (A.u - C.u) + (C.u - B.u) * (A.v - C.v);
    if (Math.abs(det) < 1e-12) {
        return A.h;
    }
    const l1 = ((B.v - C.v) * (u - C.u) + (C.u - B.u) * (v - C.v)) / det;
    const l2 = ((C.v - A.v) * (u - C.u) + (A.u - C.u) * (v - C.v)) / det;
    return l1 * A.h + l2 * B.h + (1 - l1 - l2) * C.h;
}

/** Beside a deck the land stands at most this far under its top at its edge, metres ... */
const DECK_BESIDE_DROP_M = 0.5;
/** ... rising off it no steeper than this (rise over run: a batter's 1:1.5) ... */
const DECK_BESIDE_SLOPE = 1 / 1.5;
/** ... out to this far, metres. */
const DECK_BESIDE_REACH_M = 15;

/**
 * How high the land beside the bridges' decks may stand (`tops`: the decks'
 * top triangles, tile frame, 9 per triangle): the top of the nearest deck
 * where it is nearest, DECK_BESIDE_DROP_M under, plus DECK_BESIDE_SLOPE of
 * the way out to there - the lowest over every deck within
 * DECK_BESIDE_REACH_M. Undefined where none is that near.
 */
export class DeckCeiling {
    private readonly cells = new Map<number, number[]>();
    private readonly tri: number[] = [];
    private static readonly CELL = 16;

    constructor(tops: Float64Array, frame: PlanFrame) {
        const C = DeckCeiling.CELL, r = DECK_BESIDE_REACH_M;
        for (let o = 0; o + 8 < tops.length; o += 9) {
            const p = [0, 3, 6].map(k => frame.toPlan([tops[o + k], tops[o + k + 1], tops[o + k + 2]]));
            const id = this.tri.length / 9;
            this.tri.push(...p[0], ...p[1], ...p[2]);
            const us = p.map(q => q[0]), vs = p.map(q => q[1]);
            for (let cu = Math.floor((Math.min(...us) - r) / C); cu <= Math.floor((Math.max(...us) + r) / C); cu++) {
                for (let cv = Math.floor((Math.min(...vs) - r) / C); cv <= Math.floor((Math.max(...vs) + r) / C); cv++) {
                    const key = cellKey(cu, cv);
                    const list = this.cells.get(key);
                    if (list) {
                        list.push(id);
                    } else {
                        this.cells.set(key, [id]);
                    }
                }
            }
        }
    }

    at(u: number, v: number): number | undefined {
        const list = this.cells.get(cellKey(Math.floor(u / DeckCeiling.CELL), Math.floor(v / DeckCeiling.CELL)));
        if (!list) {
            return undefined;
        }
        let best: number | undefined;
        for (const id of list) {
            const T = this.tri, o = id * 9;
            // The nearest point of the triangle in plan, and its height there.
            const near = nearestOnTriangle(u, v, T[o], T[o + 1], T[o + 3], T[o + 4], T[o + 6], T[o + 7]);
            const d = Math.hypot(near.u - u, near.v - v);
            if (d > DECK_BESIDE_REACH_M) {
                continue;
            }
            const h = near.a * T[o + 2] + near.b * T[o + 5] + near.c * T[o + 8];
            const c = h - DECK_BESIDE_DROP_M + DECK_BESIDE_SLOPE * d;
            if (best === undefined || c < best) {
                best = c;
            }
        }
        return best;
    }
}

/** The plan point of triangle (a, b, c) nearest (u, v), and its barycentric weights. */
function nearestOnTriangle(
    u: number, v: number, au: number, av: number, bu: number, bv: number, cu: number, cv: number,
): { u: number; v: number; a: number; b: number; c: number } {
    const det = (bv - cv) * (au - cu) + (cu - bu) * (av - cv);
    if (Math.abs(det) > 1e-12) {
        const a = ((bv - cv) * (u - cu) + (cu - bu) * (v - cv)) / det;
        const b = ((cv - av) * (u - cu) + (au - cu) * (v - cv)) / det;
        if (a >= 0 && b >= 0 && a + b <= 1) {
            return { u, v, a, b, c: 1 - a - b };
        }
    }
    // Outside: the nearest point of the nearest edge.
    let best = { u: au, v: av, a: 1, b: 0, c: 0 }, bestD = Infinity;
    const edges: Array<[number, number, number, number, number, number]> = [[au, av, bu, bv, 0, 1], [bu, bv, cu, cv, 1, 2], [cu, cv, au, av, 2, 0]];
    for (const [pu, pv, qu, qv, i, j] of edges) {
        const du = qu - pu, dv = qv - pv, l2 = du * du + dv * dv;
        const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((u - pu) * du + (v - pv) * dv) / l2)) : 0;
        const x = pu + du * t, y = pv + dv * t, d = Math.hypot(x - u, y - v);
        if (d < bestD) {
            bestD = d;
            const w = [0, 0, 0];
            w[i] = 1 - t;
            w[j] = t;
            best = { u: x, v: y, a: w[0], b: w[1], c: w[2] };
        }
    }
    return best;
}

/** How far a concrete face's base may stand over the land under it before it is carried down, metres. */
const UNDERPIN_GAP_M = 0.1;
/** A concrete face's base this near or under the ground it was built on was meant to stand on it, metres. */
const UNDERPIN_GROUNDED_M = 0.3;
/** Deepest a face is carried down, metres. */
const UNDERPIN_MAX_M = 15;
/** Along a face's base, the land is read this often, metres. */
const UNDERPIN_STEP_M = 0.5;

/**
 * The vertical concrete faces of the bridges (`concrete`, tile frame, 9 per
 * triangle) meant to stand on the ground - an abutment's, a pier's, a
 * join's end block: their base at or under the ground the bridge bake read
 * (`original`) - carried down to the land as graded (`land`), where it is
 * now lower. Never over a road (`onRoad`): a deck's face over a road cut
 * under it is no wall. The B2 at Garmisch, cut 5 m under a railway deck's
 * end: the abutment hung 2.8 m over the land, and the land rose into it.
 */
export function underpinConcrete(
    concrete: Float64Array, frame: PlanFrame,
    land: { at(u: number, v: number): number | undefined; lowest(u: number, v: number): number | undefined },
    original: { at(u: number, v: number): number | undefined },
    onRoad: (u: number, v: number) => boolean,
): RailWalls | undefined {
    const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
    const { a, b, up } = frame;
    const toTile = (u: number, v: number, h: number) => [
        u * a[0] + v * b[0] + h * up[0], u * a[1] + v * b[1] + h * up[1], u * a[2] + v * b[2] + h * up[2],
    ];
    const seen = new Set<string>();
    for (let t = 0; t + 8 < concrete.length; t += 9) {
        const P = [0, 1, 2].map(k => [concrete[t + k * 3], concrete[t + k * 3 + 1], concrete[t + k * 3 + 2]]);
        const e1 = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]];
        const e2 = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const nl = Math.hypot(n[0], n[1], n[2]);
        if (nl < 1e-9 || Math.abs((n[0] * up[0] + n[1] * up[1] + n[2] * up[2]) / nl) > 0.2) {
            continue;
        }
        // Its base: the two corners at its lowest.
        const pl = P.map(c => frame.toPlan(c as V3));
        const low = Math.min(pl[0][2], pl[1][2], pl[2][2]);
        const base = pl.filter(c => c[2] < low + 0.05);
        if (base.length !== 2) {
            continue;
        }
        const [A, B] = base;
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
        // Each base edge once (a quad's two triangles may share it).
        const key = [A, B].map(c => `${Math.round(c[0] * 20)},${Math.round(c[1] * 20)}`).sort().join('|');
        if (len < 0.2 || seen.has(key)) {
            continue;
        }
        seen.add(key);
        const mu = (A[0] + B[0]) / 2, mv = (A[1] + B[1]) / 2;
        const was = original.at(mu, mv);
        if (was === undefined || low > was + UNDERPIN_GROUNDED_M) {
            continue;
        }
        // The land along the base, and nothing on a road.
        let lowest = Infinity, gap = false, road = false;
        const steps = Math.max(1, Math.ceil(len / UNDERPIN_STEP_M));
        for (let k = 0; k <= steps && !road; k++) {
            const f = k / steps;
            const u = A[0] + (B[0] - A[0]) * f, v = A[1] + (B[1] - A[1]) * f;
            road = onRoad(u, v);
            const top = land.at(u, v), under = land.lowest(u, v);
            if (top !== undefined && top < low - UNDERPIN_GAP_M) {
                gap = true;
            }
            if (under !== undefined) {
                lowest = Math.min(lowest, under);
            }
        }
        if (road || !gap || !Number.isFinite(lowest)) {
            continue;
        }
        const foot = Math.max(low - UNDERPIN_MAX_M, lowest - WALL_FOOT_M);
        const i0 = pos.length / 3;
        for (const c of [[A[0], A[1], low], [B[0], B[1], low], [B[0], B[1], foot], [A[0], A[1], foot]]) {
            pos.push(...toTile(c[0], c[1], c[2]));
            nrm.push(n[0] / nl, n[1] / nl, n[2] / nl);
        }
        // Wound to face the way the face it continues does: (B - A) x down.
        const ab = [0, 1, 2].map(k => (B[0] - A[0]) * a[k] + (B[1] - A[1]) * b[k]);
        const out = [ab[2] * up[1] - ab[1] * up[2], ab[0] * up[2] - ab[2] * up[0], ab[1] * up[0] - ab[0] * up[1]];
        if (out[0] * n[0] + out[1] * n[1] + out[2] * n[2] >= 0) {
            idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
        } else {
            idx.push(i0, i0 + 2, i0 + 1, i0, i0 + 3, i0 + 2);
        }
    }
    return idx.length > 0
        ? { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), indices: Uint32Array.from(idx) }
        : undefined;
}

/** Two wall meshes as one. */
function joinWalls(x: RailWalls | undefined, y: RailWalls | undefined): RailWalls | undefined {
    if (!x || !y) {
        return x ?? y;
    }
    const base = x.positions.length / 3;
    const indices = new Uint32Array(x.indices.length + y.indices.length);
    indices.set(x.indices);
    for (let i = 0; i < y.indices.length; i++) {
        indices[x.indices.length + i] = y.indices[i] + base;
    }
    const positions = new Float32Array(x.positions.length + y.positions.length);
    positions.set(x.positions);
    positions.set(y.positions, x.positions.length);
    const normals = new Float32Array(x.normals.length + y.normals.length);
    normals.set(x.normals);
    normals.set(y.normals, x.normals.length);
    return { positions, normals, indices };
}

interface DeckEnd {
    u: number;
    v: number;
    /** Height of the deck track as drawn, or of a road deck's top plus the strokes' lift. */
    h: number;
    /** The quantised position, as drawn. */
    q: Int16Array;
}

/**
 * The ends of the track on one tile's bridge decks, 3 per end in that
 * tile's frame, metres: what RailBedInput.deckEnds is built from.
 */
export function deckTrackEnds(
    track: { positions: Int16Array; directions: Int8Array; indices: Uint16Array }, quantScale: number,
): Float64Array {
    const chains = railChains(track);
    const out = new Float64Array(chains.length * 6);
    chains.forEach((chain, i) => {
        [chain[0], chain[chain.length - 1]].forEach((vi, k) => {
            for (let j = 0; j < 3; j++) {
                out[i * 6 + k * 3 + j] = track.positions[vi * 3 + j] * quantScale;
            }
        });
    });
    return out;
}

/** The deck ends in plan, with where a stroke point goes to sit on one. */
function deckEnds(ends: Float64Array | undefined, q: number, frame: PlanFrame): DeckEnd[] {
    const out: DeckEnd[] = [];
    for (let i = 0; ends && i + 2 < ends.length; i += 3) {
        const p: V3 = [ends[i], ends[i + 1], ends[i + 2]];
        const [u, v, h] = frame.toPlan(p);
        out.push({ u, v, h, q: Int16Array.from(p, x => clampI16(x / q)) });
    }
    return out;
}

/** A road deck end (RailBedInput.roadDeckEnds): where, its tier, and the way out of the deck there. */
interface RoadDeckEnd extends DeckEnd {
    tier: number;
    du: number;
    dv: number;
}

/** The road deck ends in plan, their height as a stroke there is drawn (the deck's top plus the strokes' lift). */
function roadDeckEnds(ends: Float64Array | undefined, q: number, frame: PlanFrame, liftM: number): RoadDeckEnd[] {
    const out: RoadDeckEnd[] = [];
    for (let i = 0; ends && i + 6 < ends.length; i += 7) {
        const [u, v, h] = frame.toPlan([ends[i], ends[i + 1], ends[i + 2]]);
        const [iu, iv] = frame.toPlan([ends[i + 4], ends[i + 5], ends[i + 6]]);
        const l = Math.hypot(u - iu, v - iv) || 1;
        const drawn = h + liftM;
        const x = u * frame.a[0] + v * frame.b[0] + drawn * frame.up[0];
        const y = u * frame.a[1] + v * frame.b[1] + drawn * frame.up[1];
        const z = u * frame.a[2] + v * frame.b[2] + drawn * frame.up[2];
        out.push({
            u, v, h: drawn, q: Int16Array.of(clampI16(x / q), clampI16(y / q), clampI16(z / q)),
            tier: ends[i + 3], du: (u - iu) / l, dv: (v - iv) / l,
        });
    }
    return out;
}

/** A line of a road deck end's tier passing this near it, metres, along the span, is held to the deck there. */
const ROAD_END_PASS_M = 2;
/** ... running along the span within this (cosine): a line crossing under the deck's end is not its approach. */
const ROAD_END_PASS_COS = 0.7;
/** A road's chain ending this near a road deck end, metres, starts at it, whichever way it leaves. */
const ROAD_END_ON_M = 1.5;
/** Least cosine between a road arriving at a deck end and the way into the deck there: it comes on along the span. */
const ROAD_END_ALIGN_COS = 0.3;

/**
 * The road deck end a chain's end (`i`, 0 or its last) arrives at: of its
 * own tier, within DECK_SNAP_M, the chain coming in towards the deck.
 */
function nearestRoadDeckEnd(
    ends: readonly RoadDeckEnd[], tier: number, pts: ReadonlyArray<{ u: number; v: number }>, i: number,
): RoadDeckEnd | undefined {
    if (ends.length === 0 || pts.length < 2) {
        return undefined;
    }
    const p = pts[i], prev = pts[i === 0 ? 1 : pts.length - 2];
    const l = Math.hypot(p.u - prev.u, p.v - prev.v) || 1;
    const au = (p.u - prev.u) / l, av = (p.v - prev.v) / l;
    let best: RoadDeckEnd | undefined, bestD = DECK_SNAP_M;
    for (const e of ends) {
        if (e.tier !== tier) {
            continue;
        }
        const d = Math.hypot(e.u - p.u, e.v - p.v);
        // Arriving towards the deck, against the way out of it - or ending
        // on the deck's end itself (the approach starts at the span's end
        // node), whichever way it turns there: a street leaving a bridge at
        // a right angle stayed 3.7 m under its deck.
        if (d < bestD && (d <= ROAD_END_ON_M || -(au * e.du + av * e.dv) >= ROAD_END_ALIGN_COS)) {
            best = e;
            bestD = d;
        }
    }
    return best;
}

/** A road deck end this far ahead of a road's end still belongs to it, metres. */
const ROAD_DECK_REACH_M = 8;
/** ... and the deck must still be there this far past its edge: the road's own, not one it ends under. */
const ROAD_DECK_AHEAD_M = 5;
/** A vertex this far over the lowest land under it, or less, is a land-use fill's lifted over the ground, metres. */
const FILL_LIFT_MAX_M = 3;
/** Least the refined land lies under a deck it was over, metres (its vertices go DECK_CLEAR_M under). */
const DECK_FIT_M = 0.15;
/**
 * Clear height between a road and the underside of a deck over it, metres:
 * CLEARANCE_M in tools/bake/bridges.ts, which the bake lifts a deck by over
 * a road of its own priority or higher.
 */
const UNDERPASS_CLEARANCE_M = 5;
/** A deck's depth under its top where no underside was found under it, metres: a beam's (DECK_THICKNESS_M). */
const UNDERSIDE_FALLBACK_M = 1.4;
/** A concrete face whose normal points down at least this much (its up component, negated) is an underside. */
const UNDERSIDE_MIN_DOWN = 0.9;
/**
 * Most times the profiles are fitted: each pass after the first holds the
 * junctions the one before asked to move, which can ask the next junction
 * along in turn.
 */
const GRADE_PASSES = 4;
/** A junction this far past what a line's grade reaches from its other hold is asked to move, metres. */
const NEED_SLACK_M = 0.3;
/** A deck within this of a line's drawn height, running on along it, is the line's own bridge, metres. */
const OWN_DECK_LEVEL_M = 2;
/** A land triangle rising this many times its width in plan (about 79 degrees) is a skirt or wall: no ground. */
const GROUND_WALL_STEEP = 5;
/** A chain's end point this near the next in plan, metres, */
const STRAY_END_PLAN_M = 1;
/** ... and this far off it in height, metres, is a drape artefact (the skirt), not the line's. */
const STRAY_END_RISE_M = 2;
/** ... or steeper than this: no road climbs it, metres per metre. */
const STRAY_END_GRADE = 1;
/** Farthest the strays trimmed off a chain's end lie from its end point in plan, metres. */
const STRAY_END_SPREAD_M = 2;
/** How many points at a chain's end may be strays on the skirt. */
const STRAY_END_POINTS = 3;
/** A stroke straying this far from its graded profile between vertices gets a vertex there, metres. */
const STROKE_FIT_M = 0.1;
/** No vertex goes in nearer than this to a segment's ends, metres. */
const STROKE_INSERT_MIN_M = 2;
/** Farthest ahead a road's continuation past a deck is looked for, metres. */
const GAP_REACH_M = 300;
/** ... at most this far off its line, metres, */
const GAP_SIDE_M = 10;
/** ... or this share of the way along, */
const GAP_SIDE_SHARE = 0.3;
/** ... pointing back at it at least this much (cosine). */
const GAP_FACING = 0.5;
/** Share of that gap a road's own bridge covers. */
const GAP_COVER = 0.7;
/** Farthest a deck is followed along and across a road to tell its own from one it passes under, metres. */
const OWN_DECK_RUN_M = 30;
/** A border ramp this near a line's end on the border is that line's, metres. */
const RAMP_MATCH_M = 2.5;
/** A border crossing whose height moves less than this keeps the border's hold, metres. */
const CROSSING_MIN_MOVE_M = 0.1;
/** Widest the border is freed round a crossing, metres. */
const CROSSING_FREE_MAX_M = 40;
/** A chain end this close to the border (its fade) is held where drawn, for the neighbour tile. */
const END_BORDER_FADE = 0.15;
/** A chain end this near the border, metres, is on it - the line goes on in the neighbour - and never anchored to a deck. */
const END_ON_BORDER_M = 0.5;
/** Whether a border taper (BorderIndex.taper, a smoothstep over BORDER_TAPER_M) puts a point within END_ON_BORDER_M of the border. */
const onTheBorder = (taper: number): boolean => {
    const t = END_ON_BORDER_M / BORDER_TAPER_M;
    return taper < t * t * (3 - 2 * t);
};
/** Spacing of the points a deck's footprint is checked at for land over it, metres. */
const DECK_PROBE_STEP_M = 2;
/** ... drawn this share of the way in from its edges. */
const DECK_PROBE_INSET = 0.1;
/** How far below a bridge deck's top the land under it is kept, metres. */
const DECK_CLEAR_M = 0.6;
/** A deck covering a road this far ahead and behind is the road's own, metres. */
const ROAD_DECK_ALONG_M = 15;
/** Highest a road is lifted to its deck, metres; past it the deck is no part of its line. */
const ROAD_DECK_MAX_LIFT_M = 16;

/** Whether the step from a chain's point to the next one in is a drape onto the skirt (STRAY_END_*), not the line's. */
function strayStep(a: { u: number; v: number; h: number }, b: { u: number; v: number; h: number }): boolean {
    const plan = Math.hypot(a.u - b.u, a.v - b.v), rise = Math.abs(a.h - b.h);
    return rise > STRAY_END_RISE_M && (plan < STRAY_END_PLAN_M || rise > plan * STRAY_END_GRADE);
}

/**
 * Whether a chain's points 0..j from one end (`at`) lie together in plan, as
 * drapes on the skirt do, hung off the one border point. A four-point street
 * at Munich, two points 64 m apart on the line then two down the skirt at the
 * far end, had its two real points trimmed off as strays from the near end:
 * what was left was too short to grade, and stood 66 m down the skirt.
 */
function strayCluster(at: (j: number) => { u: number; v: number }, j: number): boolean {
    for (let k = 1; k <= j; k++) {
        if (Math.hypot(at(k).u - at(0).u, at(k).v - at(0).v) > STRAY_END_SPREAD_M) {
            return false;
        }
    }
    return true;
}

/** A chain's end in plan, and the way it points out of the chain (unit). */
interface ChainEnd {
    u: number;
    v: number;
    du: number;
    dv: number;
}

/** Road bridge deck tops in plan, answering where a road's own deck starts ahead of it. */
export class RoadDeckIndex {
    private readonly tris: number[][] = [];
    private readonly cells = new Map<number, number[]>();
    private static readonly CELL = 16;

    /**
     * `facingDown`, when given, keeps only the faces whose normal (by their
     * winding; the bridge bake faces them outward) points down at least that
     * much: the undersides out of a bridge's concrete.
     */
    /** Tier of the line each kept triangle's bridge carries (-1 unknown). */
    private readonly tierOf: number[] = [];
    /** While set (>= 0), the decks of other known tiers are not there: see forTier. */
    private only = -1;

    constructor(decks: Float64Array, frame: PlanFrame, facingDown?: number, tiers?: Int8Array) {
        for (let o = 0; o + 8 < decks.length; o += 9) {
            const T = [0, 3, 6].flatMap(k => frame.toPlan([decks[o + k], decks[o + k + 1], decks[o + k + 2]]));
            if (facingDown !== undefined) {
                const e1 = [T[3] - T[0], T[4] - T[1], T[5] - T[2]], e2 = [T[6] - T[0], T[7] - T[1], T[8] - T[2]];
                const nu = e1[1] * e2[2] - e1[2] * e2[1], nv = e1[2] * e2[0] - e1[0] * e2[2], nh = e1[0] * e2[1] - e1[1] * e2[0];
                const len = Math.hypot(nu, nv, nh);
                if (len < 1e-9 || nh / len > facingDown) {
                    continue;
                }
            }
            const id = this.tris.length;
            this.tris.push(T);
            this.tierOf.push(tiers?.[o / 9] ?? -1);
            const C = RoadDeckIndex.CELL;
            for (let cu = Math.floor(Math.min(T[0], T[3], T[6]) / C); cu <= Math.floor(Math.max(T[0], T[3], T[6]) / C); cu++) {
                for (let cv = Math.floor(Math.min(T[1], T[4], T[7]) / C); cv <= Math.floor(Math.max(T[1], T[4], T[7]) / C); cv++) {
                    const key = cellKey(cu, cv);
                    const list = this.cells.get(key);
                    if (list) {
                        list.push(id);
                    } else {
                        this.cells.set(key, [id]);
                    }
                }
            }
        }
    }

    /**
     * Points just inside the decks reaching into a plan box, appended to
     * `out` (u, v pairs): along every deck triangle's edges, drawn a tenth
     * of the way in towards its middle, and the middle.
     */
    probes(u0: number, v0: number, u1: number, v1: number, out: number[]): void {
        const C = RoadDeckIndex.CELL;
        const seen = new Set<number>();
        for (let cu = Math.floor(u0 / C); cu <= Math.floor(u1 / C); cu++) {
            for (let cv = Math.floor(v0 / C); cv <= Math.floor(v1 / C); cv++) {
                for (const id of this.cells.get(cellKey(cu, cv)) ?? []) {
                    if (seen.has(id)) {
                        continue;
                    }
                    seen.add(id);
                    const T = this.tris[id];
                    const mu = (T[0] + T[3] + T[6]) / 3, mv = (T[1] + T[4] + T[7]) / 3;
                    const push = (u: number, v: number) => {
                        if (u >= u0 && u <= u1 && v >= v0 && v <= v1) {
                            out.push(u, v);
                        }
                    };
                    push(mu, mv);
                    for (let k = 0; k < 3; k++) {
                        const au = T[k * 3], av = T[k * 3 + 1], bu = T[(k + 1) % 3 * 3], bv = T[(k + 1) % 3 * 3 + 1];
                        const n = Math.max(1, Math.ceil(Math.hypot(bu - au, bv - av) / DECK_PROBE_STEP_M));
                        for (let i = 0; i < n; i++) {
                            const f = i / n;
                            push(au + (bu - au) * f + (mu - au - (bu - au) * f) * DECK_PROBE_INSET,
                                av + (bv - av) * f + (mv - av - (bv - av) * f) * DECK_PROBE_INSET);
                        }
                    }
                }
            }
        }
    }

    /**
     * Whether the decks cover the gap from a road's end `p` (heading du, dv,
     * the deck starting `s` on) to where a chain of its tier carries on
     * straight ahead, if one does.
     */
    private spansGap(p: { u: number; v: number }, du: number, dv: number, s: number, ends: readonly ChainEnd[]): boolean {
        let next: ChainEnd | undefined, nextAlong = Infinity;
        for (const e of ends) {
            const wu = e.u - p.u, wv = e.v - p.v;
            const along = wu * du + wv * dv;
            const side = Math.abs(wu * dv - wv * du);
            if (along < s + ROAD_DECK_AHEAD_M || along > GAP_REACH_M || side > Math.max(GAP_SIDE_M, GAP_SIDE_SHARE * along)
                || e.du * du + e.dv * dv > -GAP_FACING) {
                continue;
            }
            if (along < nextAlong) {
                next = e;
                nextAlong = along;
            }
        }
        if (!next) {
            return true;
        }
        // Along the chord to the road beyond, not straight on: a bridge that
        // bends between its two roads (10 m to the side over 54 m at
        // Kitzbuehel) left a straight probe off its deck for the last third,
        // and the street on that side never climbed to it - a 7 m step.
        const gap = Math.hypot(next.u - p.u, next.v - p.v);
        const cu = (next.u - p.u) / gap, cv = (next.v - p.v) / gap;
        let covered = 0, total = 0;
        for (let d = s; d <= gap - ROAD_DECK_REACH_M; d += 2) {
            total++;
            if (this.top(p.u + cu * d, p.v + cv * d) !== undefined) {
                covered++;
            }
        }
        return total === 0 || covered >= GAP_COVER * total;
    }

    /** How far a deck goes on from (u, v) in direction (eu, ev) (unit), metres, up to OWN_DECK_RUN_M. */
    run(u: number, v: number, eu: number, ev: number): number {
        let d = 0;
        while (d < OWN_DECK_RUN_M && this.top(u + eu * (d + 1), v + ev * (d + 1)) !== undefined) {
            d++;
        }
        return d;
    }

    /** The highest face over a plan point lower than `limit`, if any: the underside of the deck whose top is `limit`. */
    below(u: number, v: number, limit: number): number | undefined {
        let best: number | undefined;
        for (const id of this.cells.get(cellKey(Math.floor(u / RoadDeckIndex.CELL), Math.floor(v / RoadDeckIndex.CELL))) ?? []) {
            const T = this.tris[id];
            const h = barycentricHeight(u, v, T[0], T[1], T[2], T[3], T[4], T[5], T[6], T[7], T[8]);
            if (h !== undefined && h < limit - 0.05 && (best === undefined || h > best)) {
                best = h;
            }
        }
        return best;
    }

    /**
     * `fn` with only the decks of `tier` there (and those of no known tier):
     * a road's own bridge carries its own tier - a main road climbed 6.5 m
     * onto a street's bridge over it.
     */
    forTier<R>(tier: number, fn: () => R): R {
        const was = this.only;
        this.only = tier;
        try {
            return fn();
        } finally {
            this.only = was;
        }
    }

    /** The deck top's height over a plan point, if a deck covers it. */
    top(u: number, v: number): number | undefined {
        let best: number | undefined;
        for (const id of this.cells.get(cellKey(Math.floor(u / RoadDeckIndex.CELL), Math.floor(v / RoadDeckIndex.CELL))) ?? []) {
            if (this.only >= 0 && this.tierOf[id] >= 0 && this.tierOf[id] !== this.only) {
                continue;
            }
            const T = this.tris[id];
            const h = barycentricHeight(u, v, T[0], T[1], T[2], T[3], T[4], T[5], T[6], T[7], T[8]);
            if (h !== undefined && (best === undefined || h > best)) {
                best = h;
            }
        }
        return best;
    }

    /**
     * Whether a road at (u, v) heading (du, dv) is on its own deck: one under
     * it that still covers it ROAD_DECK_ALONG_M ahead and behind. A road
     * passing under someone else's bridge is clear of it within that.
     */
    along(u: number, v: number, du: number, dv: number): boolean {
        return this.top(u, v) !== undefined
            && this.top(u + du * ROAD_DECK_ALONG_M, v + dv * ROAD_DECK_ALONG_M) !== undefined
            && this.top(u - du * ROAD_DECK_ALONG_M, v - dv * ROAD_DECK_ALONG_M) !== undefined;
    }

    /**
     * Where a road's end `i` (0 or last of `pts`) meets its own deck: under
     * it, or the first point of it within ROAD_DECK_REACH_M straight on -
     * and the deck still there ROAD_DECK_AHEAD_M further, and not behind the
     * end (a road ending under someone else's bridge has deck either side).
     */
    anchor(
        pts: ReadonlyArray<{ u: number; v: number; h: number }>, i: number, liftM: number, frame: PlanFrame, q: number,
        ends: readonly ChainEnd[] = [],
    ): DeckEnd | undefined {
        if (pts.length < 2) {
            return undefined;
        }
        const p = pts[i], prev = pts[i === 0 ? 1 : pts.length - 2];
        const len = Math.hypot(p.u - prev.u, p.v - prev.v);
        if (len < 1e-6) {
            return undefined;
        }
        const du = (p.u - prev.u) / len, dv = (p.v - prev.v) / len;
        if (this.top(p.u - du * ROAD_DECK_AHEAD_M, p.v - dv * ROAD_DECK_AHEAD_M) !== undefined) {
            return undefined;
        }
        for (let s = 0; s <= ROAD_DECK_REACH_M; s += 0.5) {
            const u = p.u + du * s, v = p.v + dv * s;
            const h = this.top(u, v);
            if (h === undefined) {
                continue;
            }
            if (this.top(u + du * ROAD_DECK_AHEAD_M, v + dv * ROAD_DECK_AHEAD_M) === undefined
                || Math.abs(h - p.h) > ROAD_DECK_MAX_LIFT_M) {
                return undefined;
            }
            // Its own runs on ahead, further than across; one crossing over
            // it (its chain broken under it) runs across.
            if (this.run(u, v, -dv, du) + this.run(u, v, dv, -du) > this.run(u, v, du, dv) + this.run(u, v, -du, -dv)) {
                return undefined;
            }
            // Where the road carries on beyond the deck (a chain of its
            // tier starting straight ahead, pointing back), its own bridge
            // spans the whole gap between; one crossing over it at a shallow
            // angle covers only its width of it, the stretch under it left
            // out of the strokes (mapped covered).
            if (!this.spansGap(p, du, dv, s, ends)) {
                return undefined;
            }
            const drawn = h + liftM;
            const x = u * frame.a[0] + v * frame.b[0] + drawn * frame.up[0];
            const y = u * frame.a[1] + v * frame.b[1] + drawn * frame.up[1];
            const z = u * frame.a[2] + v * frame.b[2] + drawn * frame.up[2];
            return { u, v, h: drawn, q: Int16Array.of(clampI16(x / q), clampI16(y / q), clampI16(z / q)) };
        }
        return undefined;
    }
}

/**
 * The deck track end a chain's end `i` of `pts` belongs to: the nearest
 * within DECK_SNAP_M - or, past that, up to DECK_SNAP_ALONG_M back along
 * the chain's own line (DECK_SNAP_SIDE_M off it at most), where the bridge
 * bake ran a span's end on to clear its abutment off a road and the track's
 * stroke now ends on the deck (a parallel track's deck end stands further
 * off the line).
 */
function nearestDeckEnd(decks: readonly DeckEnd[], pts: ReadonlyArray<{ u: number; v: number }>, i: number): DeckEnd | undefined {
    const { u, v } = pts[i];
    let best: DeckEnd | undefined;
    let bestD = DECK_SNAP_M;
    for (const d of decks) {
        const dist = Math.hypot(d.u - u, d.v - v);
        if (dist < bestD) {
            best = d;
            bestD = dist;
        }
    }
    if (best || pts.length < 2) {
        return best;
    }
    const o = pts[i === 0 ? 1 : pts.length - 2];
    const l = Math.hypot(u - o.u, v - o.v) || 1;
    const tu = (u - o.u) / l, tv = (v - o.v) / l;
    for (const d of decks) {
        const along = (d.u - u) * tu + (d.v - v) * tv, side = Math.abs(-(d.u - u) * tv + (d.v - v) * tu);
        const dist = Math.hypot(d.u - u, d.v - v);
        if (along < 0 && dist <= DECK_SNAP_ALONG_M && side <= DECK_SNAP_SIDE_M) {
            if (!best || dist < Math.hypot(best.u - u, best.v - v)) {
                best = d;
            }
        }
    }
    return best;
}

/** A wall's cliff is looked for from this far inside a bed's shoulder ... */
const WALL_INSIDE_M = 1;
/** ... to this far beyond it, metres. */
const WALL_FAR_M = 12;
/** Spacing of the designed ground read out from a bed, metres. */
const WALL_PROFILE_M = 0.5;
/** How far either side of the designed cliff a wall's face and top reach, for the land's facets that follow it, metres. */
const WALL_PAD_M = 1.5;
/** A cliff belongs to this bed unless another's shoulder is nearer it by this much, metres. */
const WALL_OWN_SLACK_M = 0.5;
/** Samples either side a wall's extent is smoothed over (the most out, the least in). */
const WALL_SMOOTH = 2;
/** Lowest drop the designed ground makes that gets a wall, metres: lower, it is a bank. */
const WALL_MIN_FACE_M = 1;
/** Clear of the steepest ground a wall's face stands, metres. */
const WALL_CLEAR_M = 0.2;
/** How far a wall's top stands above the bed, so it never fights the land at the bed's edge, metres. */
const WALL_PROUD_M = 0.05;
/** How far under a deck's underside a wall's top stops, metres. */
const WALL_UNDER_DECK_M = 0.1;
/** How far a wall's foot is sunk below the ground in front of it, metres. */
const WALL_FOOT_M = 0.5;
/** A vertex of a triangle with an edge longer than this moves only for lines that refine, metres. */
const LONG_EDGE_M = 40;
/** Shortest wall built, metres. */
const WALL_MIN_RUN_M = 15;
/** Tallest a retaining wall stands over or under its bed, metres: past every tier's earthworks cap and a deck ramp's. */
const WALL_MAX_M = 20;
/**
 * A wall's line may stray this far from its run's samples once simplified,
 * metres. Looser, its pieces are fewer but stand off the land's step: on the
 * Garmisch 5x5 the land stood more than 1 m up 14 % of the faces sampled at
 * 0.15 m, 17 % at 0.25 m (wall vertices -21 %), 21 % at 0.4 m (-40 %); a
 * looser top alone (0.5 m) did no better than 0.25 m.
 */
const WALL_SIMPLIFY_M = 0.15;
/** A wall is checked against the roads beside it this often along its run, metres. */
const WALL_STEP_M = 2;
/** How far off another line's carriageway or track a wall keeps, metres: less than a shoulder, so a line never blocks its own wall. */
const WALL_ROAD_CLEAR_M = 0.5;

/**
 * One straight piece of a retaining wall's face, plan frame: its ends and
 * tops, its foot, which way it looks (ou, ov), and how far back its top
 * reaches at each end (where its end caps stop).
 */
export interface WallPiece {
    a: { u: number; v: number; top: number; reach: number };
    b: { u: number; v: number; top: number; reach: number };
    bottom: number;
    ou: number;
    ov: number;
}

/** Retaining walls as one flat-shaded mesh: tile frame, metres. */
export interface RailWalls {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
}

/**
 * Straight concrete retaining walls where the designed ground (`ground`,
 * the earthworks' target) drops steeper than it can stand as a slope - a
 * batter cut short, a line's surface against another's batter - by
 * WALL_MIN_FACE_M or more. Every WALL_STEP_M along each bed and out either
 * side, the first such cliff says where the wall goes and which way it
 * holds, so one run can be a cutting here and an embankment there; a cliff
 * nearer another bed is that bed's. Beside an embankment: a vertical face
 * where the cliff ends, from below the ground in front up to the ground
 * behind, and a flat top back over it. Beside a cutting: a face where it
 * starts, up to the ground above, and a flat top out over it. Each run is
 * simplified to the fewest straight pieces that keep within
 * WALL_SIMPLIFY_M of it. `onRoad` says where another line runs: no wall
 * stands there.
 *
 * Walls were placed from the mesh's steep facets once, one offset and one
 * kind per run: the facets' slivers beside a road lowered under it raised
 * walls where nothing was designed steep, and the land poked out past them
 * (Garmisch, the B2 under its bridges).
 */
export function retainingWalls(
    beds: readonly BedSegment[], frame: PlanFrame,
    ground: (u: number, v: number) => number,
    onRoad?: (u: number, v: number) => boolean,
    /** Filled with the pieces built, for the land to be cut along them (cutLandAtWalls). */
    built?: WallPiece[],
    /** The underside of a deck over (u, v), if one is: no wall stands higher (WALL_UNDER_DECK_M under it). */
    ceiling?: (u: number, v: number) => number | undefined,
): RailWalls | undefined {
    if (beds.length === 0) {
        return undefined;
    }
    // The beds by cell, to tell which one a cliff belongs to.
    const CELL = 16;
    const grid = new Map<number, number[]>();
    beds.forEach((s, i) => {
        const r = s.half + SHOULDER_M + WALL_FAR_M;
        for (let cu = Math.floor((Math.min(s.a.u, s.b.u) - r) / CELL); cu <= Math.floor((Math.max(s.a.u, s.b.u) + r) / CELL); cu++) {
            for (let cv = Math.floor((Math.min(s.a.v, s.b.v) - r) / CELL); cv <= Math.floor((Math.max(s.a.v, s.b.v) + r) / CELL); cv++) {
                const key = cellKey(cu, cv);
                const list = grid.get(key);
                if (list) {
                    list.push(i);
                } else {
                    grid.set(key, [i]);
                }
            }
        }
    });
    /** How far past its shoulder the nearest bed is from (u, v), and which. */
    const nearestBed = (u: number, v: number): { seg: number; excess: number } => {
        let best = { seg: -1, excess: Infinity };
        for (const i of grid.get(cellKey(Math.floor(u / CELL), Math.floor(v / CELL))) ?? []) {
            const s = beds[i];
            const du = s.b.u - s.a.u, dv = s.b.v - s.a.v;
            const l2 = du * du + dv * dv;
            const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((u - s.a.u) * du + (v - s.a.v) * dv) / l2)) : 0;
            const excess = Math.hypot(u - s.a.u - du * t, v - s.a.v - dv * t) - s.half - SHOULDER_M;
            if (excess < best.excess) {
                best = { seg: i, excess };
            }
        }
        return best;
    };
    const pos: number[] = [];
    const nrm: number[] = [];
    const idx: number[] = [];
    const toTile = (u: number, v: number, h: number) => [
        u * frame.a[0] + v * frame.b[0] + h * frame.up[0],
        u * frame.a[1] + v * frame.b[1] + h * frame.up[1],
        u * frame.a[2] + v * frame.b[2] + h * frame.up[2],
    ];
    const quad = (corners: number[][], normal: number[]) => {
        if (!corners.every(c => c.every(Number.isFinite))) {
            return;
        }
        const base = pos.length / 3;
        for (const c of corners) {
            pos.push(...c);
            nrm.push(...normal);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    for (const side of [1, -1]) {
        // The chains: runs of segments sharing their ends.
        for (let first = 0; first < beds.length;) {
            let last = first;
            while (last + 1 < beds.length && beds[last + 1].a === beds[last].b) {
                last++;
            }
            buildChain(first, last, side);
            first = last + 1;
        }
    }

    function buildChain(first: number, last: number, side: number): void {
        // Samples every WALL_STEP_M, with their normal (out to this side).
        const samples: Array<{ u: number; v: number; h: number; nu: number; nv: number; edge: number }> = [];
        for (let k = first; k <= last; k++) {
            const seg = beds[k];
            const du = seg.b.u - seg.a.u, dv = seg.b.v - seg.a.v;
            const len = Math.hypot(du, dv);
            if (len < 1e-6) {
                continue;
            }
            const nu = (-dv / len) * side, nv = (du / len) * side;
            const n = Math.max(1, Math.ceil(len / WALL_STEP_M));
            for (let m = k === first ? 0 : 1; m <= n; m++) {
                const f = m / n;
                samples.push({
                    u: seg.a.u + du * f, v: seg.a.v + dv * f, h: seg.a.h + (seg.b.h - seg.a.h) * f,
                    nu, nv, edge: seg.half + SHOULDER_M,
                });
            }
        }
        if (samples.length < 2) {
            return;
        }
        // Out along each sample's normal, the designed ground: the first
        // drop steeper than WALL_SLOPE by WALL_MIN_FACE_M or more is a cliff
        // the earthworks could not stand as a slope, and this line's if no
        // other bed lies nearer it.
        const inner = new Float64Array(samples.length).fill(NaN);
        const outer = new Float64Array(samples.length).fill(NaN);
        const hin = new Float64Array(samples.length), hout = new Float64Array(samples.length);
        const kind = new Int8Array(samples.length);
        const steps = Math.ceil((WALL_INSIDE_M + WALL_FAR_M) / WALL_PROFILE_M);
        const prof = new Float64Array(steps + 1);
        samples.forEach((p, k) => {
            const d0 = p.edge - WALL_INSIDE_M;
            for (let j = 0; j <= steps; j++) {
                const d = d0 + j * WALL_PROFILE_M;
                prof[j] = ground(p.u + p.nu * d, p.v + p.nv * d);
            }
            for (let j = 0; j < steps;) {
                const steepAt = (i: number) => Number.isFinite(prof[i]) && Number.isFinite(prof[i + 1])
                    && Math.abs(prof[i + 1] - prof[i]) > WALL_SLOPE * WALL_PROFILE_M;
                if (!steepAt(j)) {
                    j++;
                    continue;
                }
                const way = Math.sign(prof[j + 1] - prof[j]);
                let e = j;
                while (e + 1 < steps && steepAt(e + 1) && Math.sign(prof[e + 2] - prof[e + 1]) === way) {
                    e++;
                }
                const drop = prof[j] - prof[e + 1];
                if (Math.abs(drop) >= WALL_MIN_FACE_M) {
                    const din = d0 + j * WALL_PROFILE_M, dout = d0 + (e + 1) * WALL_PROFILE_M;
                    const mid = (din + dout) / 2;
                    const near = nearestBed(p.u + p.nu * mid, p.v + p.nv * mid);
                    const own = near.seg >= first && near.seg <= last;
                    if (own || near.excess > mid - p.edge - WALL_OWN_SLACK_M) {
                        // Past the cliff by what the land's facets take to
                        // follow it: a wall exactly on it left the facets'
                        // slope standing out in front and a gap behind its top.
                        inner[k] = Math.max(p.edge, din - WALL_PAD_M);
                        outer[k] = dout + WALL_PAD_M;
                        hin[k] = Math.max(p.h - WALL_MAX_M, Math.min(p.h + WALL_MAX_M, prof[j]));
                        hout[k] = Math.max(p.h - WALL_MAX_M, Math.min(p.h + WALL_MAX_M, prof[e + 1]));
                        // 1: an embankment, held up out where the cliff ends;
                        // -1: a cutting, held back where it starts.
                        kind[k] = drop > 0 ? 1 : -1;
                    }
                    break;
                }
                j = e + 1;
            }
        });
        // Runs of one kind, smoothed: the cliff's edge steps with the
        // profile, and a wall following it would too.
        for (let k0 = 0; k0 < samples.length;) {
            if (kind[k0] === 0) {
                k0++;
                continue;
            }
            let k1 = k0;
            while (k1 + 1 < samples.length && kind[k1 + 1] === kind[k0]) {
                k1++;
            }
            buildRun(samples.slice(k0, k1 + 1), smoothExtent(inner.subarray(k0, k1 + 1), Math.min),
                smoothExtent(outer.subarray(k0, k1 + 1), Math.max), hin.subarray(k0, k1 + 1), hout.subarray(k0, k1 + 1), kind[k0] < 0);
            k0 = k1 + 1;
        }
    }

    function buildRun(
        samples: ReadonlyArray<{ u: number; v: number; nu: number; nv: number }>,
        inner: Float64Array, outer: Float64Array, hin: Float64Array, hout: Float64Array, cutting: boolean,
    ): void {
        // Beside an embankment the face stands where the steep ground ends
        // and its top reaches back over it; beside a cutting, where it starts,
        // the top reaching out.
        const face = samples.map((p, k) => {
            const d = cutting ? Math.max(0, inner[k] - WALL_CLEAR_M) : outer[k] + WALL_CLEAR_M;
            const back = cutting ? outer[k] - d : -(d - inner[k]);
            let top = (cutting ? hout[k] : hin[k]) + WALL_PROUD_M;
            const low = cutting ? hin[k] : hout[k];
            const u = p.u + p.nu * d, v = p.v + p.nv * d, ru = p.nu * back, rv = p.nv * back;
            // Never higher than a deck over it: a cutting 12 m deep under a
            // road bridge at Garmisch (47.513, 11.107) had its walls stand
            // 6 m over the deck's top, through it.
            let roofed = false;
            for (const x of [0, 0.5, 1]) {
                const c = ceiling?.(u + ru * x, v + rv * x);
                if (c !== undefined && c - WALL_UNDER_DECK_M < top) {
                    top = c - WALL_UNDER_DECK_M;
                    roofed = true;
                }
            }
            return { u, v, top, bottom: Math.min(low, top - 0.5) - WALL_FOOT_M, ru, rv, roofed, low };
        });
        // Never on another road or a track: where its face or the top it
        // reaches over would stand on one, the wall stops, and what is left
        // either side is a wall of its own if it is long enough. Nor where a
        // deck over it leaves too little of it to be a wall.
        const free = face.map(f => (!onRoad || ![0, 0.5, 1].some(x => onRoad(f.u + f.ru * x, f.v + f.rv * x)))
            && (!f.roofed || f.top - f.low >= WALL_MIN_FACE_M));
        for (let k0 = 0; k0 < face.length;) {
            if (!free[k0]) {
                k0++;
                continue;
            }
            let k1 = k0;
            while (k1 + 1 < face.length && free[k1 + 1]) {
                k1++;
            }
            let len = 0;
            for (let m = k0 + 1; m <= k1; m++) {
                len += Math.hypot(face[m].u - face[m - 1].u, face[m].v - face[m - 1].v);
            }
            if (len >= WALL_MIN_RUN_M) {
                buildWall(face.slice(k0, k1 + 1));
            }
            k0 = k1 + 1;
        }
    }

    function buildWall(face: ReadonlyArray<{ u: number; v: number; top: number; bottom: number; ru: number; rv: number }>): void {
        const keep = simplify(face.map(f => [f.u, f.v, f.top]), WALL_SIMPLIFY_M);
        // Each straight piece between two kept samples, and whether it is
        // clear of every road as built - its chord and the top over the
        // steep facets, metre by metre: the run was checked at its samples,
        // and a chord can stray off them.
        const pieces: Array<{ A: typeof face[number]; B: typeof face[number]; bottom: number; su: number; sv: number; sl: number; clear: boolean }> = [];
        for (let k = 0; k + 1 < keep.length; k++) {
            const ia = keep[k], ib = keep[k + 1];
            // The foot follows the lowest ground the span stands on.
            let bottom = Infinity;
            for (let m = ia; m <= ib; m++) {
                bottom = Math.min(bottom, face[m].bottom);
            }
            const A = face[ia], B = face[ib];
            const su = B.u - A.u, sv = B.v - A.v;
            const sl = Math.hypot(su, sv) || 1;
            let clear = true;
            if (onRoad) {
                const n = Math.max(1, Math.ceil(sl));
                for (let m = 0; m <= n && clear; m++) {
                    const f = m / n;
                    const u = A.u + su * f, v = A.v + sv * f;
                    const ru = A.ru + (B.ru - A.ru) * f, rv = A.rv + (B.rv - A.rv) * f;
                    clear = !onRoad(u, v) && !onRoad(u + ru / 2, v + rv / 2) && !onRoad(u + ru, v + rv);
                }
            }
            pieces.push({ A, B, bottom, su, sv, sl, clear });
        }
        // Each run of clear pieces as one strip, its corners shared from piece
        // to piece: 4 vertices a corner (the face's foot and top, the top's
        // front and back) where every piece had 8 of its own. A corner's face
        // normal is its two pieces' between; its foot the lower of theirs.
        for (let k0 = 0; k0 < pieces.length;) {
            if (!pieces[k0].clear) {
                k0++;
                continue;
            }
            let k1 = k0;
            while (k1 + 1 < pieces.length && pieces[k1 + 1].clear) {
                k1++;
            }
            const run = pieces.slice(k0, k1 + 1);
            k0 = k1 + 1;
            // The face looks at the side it holds nothing back on: away from
            // its top's reach.
            const outs = run.map(pc => {
                let ou = pc.sv / pc.sl, ov = -pc.su / pc.sl;
                if (ou * (pc.A.ru + pc.B.ru) + ov * (pc.A.rv + pc.B.rv) > 0) {
                    ou = -ou;
                    ov = -ov;
                }
                return [ou, ov];
            });
            const corners = [run[0].A, ...run.map(pc => pc.B)];
            const verts = corners.map((P, j) => {
                const bottom = Math.min(run[j - 1]?.bottom ?? Infinity, run[j]?.bottom ?? Infinity);
                const nu = (outs[j - 1]?.[0] ?? 0) + (outs[j]?.[0] ?? 0), nv = (outs[j - 1]?.[1] ?? 0) + (outs[j]?.[1] ?? 0);
                const nl = Math.hypot(nu, nv) || 1;
                return {
                    at: [toTile(P.u, P.v, bottom), toTile(P.u, P.v, P.top), toTile(P.u, P.v, P.top), toTile(P.u + P.ru, P.v + P.rv, P.top)],
                    face: toTile(nu / nl, nv / nl, 0),
                };
            });
            if (!verts.every(c => c.at.every(x => x.every(Number.isFinite)))) {
                continue;
            }
            const base = pos.length / 3;
            for (const c of verts) {
                pos.push(...c.at[0], ...c.at[1], ...c.at[2], ...c.at[3]);
                nrm.push(...c.face, ...c.face, ...frame.up, ...frame.up);
            }
            run.forEach((pc, j) => {
                const a = base + j * 4, b = base + (j + 1) * 4;
                // The face (A foot, B foot, B top, A top), then the top over it.
                idx.push(a, b, b + 1, a, b + 1, a + 1);
                idx.push(a + 2, b + 2, b + 3, a + 2, b + 3, a + 3);
                built?.push({
                    a: { u: pc.A.u, v: pc.A.v, top: pc.A.top, reach: Math.hypot(pc.A.ru, pc.A.rv) },
                    b: { u: pc.B.u, v: pc.B.v, top: pc.B.top, reach: Math.hypot(pc.B.ru, pc.B.rv) },
                    bottom: pc.bottom, ou: outs[j][0], ov: outs[j][1],
                });
            });
            // Closed where the strip ends: at the run's ends, and either side
            // of a piece left out for a road.
            for (const [pc, P, along] of [[run[0], run[0].A, -1], [run[run.length - 1], run[run.length - 1].B, 1]] as const) {
                quad([
                    toTile(P.u, P.v, pc.bottom), toTile(P.u + P.ru, P.v + P.rv, pc.bottom),
                    toTile(P.u + P.ru, P.v + P.rv, P.top), toTile(P.u, P.v, P.top),
                ], toTile(pc.su / pc.sl * along, pc.sv / pc.sl * along, 0));
            }
        }
    }
    if (idx.length === 0) {
        return undefined;
    }
    return { positions: Float32Array.from(pos), normals: Float32Array.from(nrm), indices: Uint32Array.from(idx) };
}

/** Each value replaced by the `pick` (Math.min or Math.max) of it and its WALL_SMOOTH neighbours either side. */
function smoothExtent(values: Float64Array, pick: (...v: number[]) => number): Float64Array {
    const out = new Float64Array(values.length);
    for (let k = 0; k < values.length; k++) {
        const near: number[] = [];
        for (let j = Math.max(0, k - WALL_SMOOTH); j <= Math.min(values.length - 1, k + WALL_SMOOTH); j++) {
            if (!Number.isNaN(values[j])) {
                near.push(values[j]);
            }
        }
        out[k] = near.length > 0 ? pick(...near) : values[k];
    }
    return out;
}

/** Douglas-Peucker over (u, v, h) points: the indices kept, first and last always. */
function simplify(points: readonly number[][], tolerance: number): number[] {
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, points.length - 1]];
    while (stack.length > 0) {
        const [i, j] = stack.pop()!;
        const a = points[i], b = points[j];
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        let worst = -1, at = -1;
        for (let k = i + 1; k < j; k++) {
            const p = points[k];
            const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / l2)) : 0;
            const e = Math.hypot(p[0] - a[0] - d[0] * t, p[1] - a[1] - d[1] * t, p[2] - a[2] - d[2] * t);
            if (e > worst) {
                worst = e;
                at = k;
            }
        }
        if (worst > tolerance) {
            keep[at] = 1;
            stack.push([i, at], [at, j]);
        }
    }
    const out: number[] = [];
    keep.forEach((k, i) => {
        if (k) {
            out.push(i);
        }
    });
    return out;
}

/** The lengths one tile works in; see layRailBeds. */
interface Dims {
    step: number;
    quant: number;
    tolerance: number;
    sample: number;
    minEdge: number;
    refineMinEdge: number;
    cell: number;
    offLand: number;
}

/** The bed segments for RailBedResult.beds: plan back to the tile's frame. */
function bedSegmentFloats(beds: readonly BedSegment[], frame: PlanFrame): Float64Array {
    const out = new Float64Array(beds.length * RAIL_BED_SEGMENT_FLOATS);
    const { a, b, up } = frame;
    beds.forEach((s, i) => {
        const o = i * RAIL_BED_SEGMENT_FLOATS;
        [s.a, s.b].forEach((p, k) => {
            out[o + k * 3] = p.u * a[0] + p.v * b[0] + p.h * up[0];
            out[o + k * 3 + 1] = p.u * a[1] + p.v * b[1] + p.h * up[1];
            out[o + k * 3 + 2] = p.u * a[2] + p.v * b[2] + p.h * up[2];
        });
        out[o + 6] = s.half;
        out[o + 7] = Math.max(Math.abs(s.a.h - s.a.land), Math.abs(s.b.h - s.b.land));
        out[o + 8] = s.open;
        out[o + 9] = s.tier;
        out[o + 10] = s.reach;
    });
    return out;
}

/** Tracks in a stroke sidecar (or a deck's track) as chains of the even (positive-side) vertex of each pair. */
export function railChains(t: Pick<PtrTile, 'indices' | 'directions'>): number[][] {
    return strokeChains(t, cls => isRailClass(cls));
}

/**
 * Every line the beds grade (bedTierOf), with its tier: in priority order,
 * and longest first within a tier, so a junction's main road is graded
 * before the side roads that hold to it.
 */
export function bedChains(t: PtrTile): Array<{ chain: number[]; tier: number }> {
    const q = t.quantScale;
    const length = (chain: number[]) => {
        let l = 0;
        for (let i = 1; i < chain.length; i++) {
            const a = chain[i - 1] * 3, b = chain[i] * 3;
            l += Math.hypot(t.positions[b] - t.positions[a], t.positions[b + 2] - t.positions[a + 2]) * q;
        }
        return l;
    };
    return strokeChains(t, cls => bedTierOf(cls) >= 0)
        .map(chain => ({ chain, tier: bedTierOf(t.directions[chain[0] * 4 + 3] & ROAD_CLASS_MASK), len: length(chain) }))
        .sort((a, b) => a.tier - b.tier || b.len - a.len)
        .map(({ chain, tier }) => ({ chain, tier }));
}

/** Lines of the classes `keep` accepts, as chains of the even vertex of each pair. */
export function strokeChains(t: Pick<PtrTile, 'indices' | 'directions'>, keep: (cls: number) => boolean): number[][] {
    const next = new Map<number, number>();
    const hasPrev = new Set<number>();
    for (let i = 0; i + 5 < t.indices.length; i += 6) {
        const a = t.indices[i], b = t.indices[i + 5];
        const cls = t.directions[a * 4 + 3] & ROAD_CLASS_MASK;
        // A chain is one class: a road changing class at a node is two lines.
        if (!keep(cls) || (t.directions[b * 4 + 3] & ROAD_CLASS_MASK) !== cls) {
            continue;
        }
        next.set(a, b);
        hasPrev.add(b);
    }
    const chains: number[][] = [];
    for (const start of next.keys()) {
        if (hasPrev.has(start)) {
            continue;
        }
        const chain = [start];
        let v = start;
        while (next.has(v) && chain.length < 100000) {
            v = next.get(v)!;
            chain.push(v);
        }
        chains.push(chain);
    }
    return chains;
}

/**
 * Heights for `ground` (one per sample) no two neighbours of which differ by
 * more than `maxSteps` quanta, closest to the ground in weighted least
 * squares: the bake's road-grade programme, with weights and any step.
 *
 * With `band`, no height is more than that many metres off its ground, and
 * a step may then exceed `maxSteps` at `steepCost` per metre of excess: the
 * grade gives way only where the band forces it.
 */
export function gradeProfileWeighted(
    ground: readonly number[], weight: readonly number[], maxSteps: number,
    band: number | readonly number[] = Infinity, steepCost = Infinity, bandCentre: readonly number[] = ground,
    quantM = PROFILE_QUANT_M,
): number[] {
    const n = ground.length;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
        lo = Math.min(lo, ground[i], bandCentre[i]);
        hi = Math.max(hi, ground[i], bandCentre[i]);
    }
    // A long chain over a big climb would want more memory than a tile is
    // worth: coarsen the quantum, keeping the slope a step allows.
    let quant = quantM;
    let stepsQ = maxSteps;
    while (n * ((hi - lo) / quant + 2) > MAX_PROFILE_CELLS) {
        quant *= 2;
        stepsQ /= 2;
    }
    const steps = Math.max(0, Math.floor(stepsQ + 1e-9));
    const base = Math.floor(lo / quant);
    const states = Math.ceil(hi / quant) - base + 1;
    let cost = new Float64Array(states);
    let nextCost = new Float64Array(states);
    const from = new Int32Array(n * states);
    const fit = (i: number, s: number): number => {
        const h = (base + s) * quant;
        const d = h - ground[i];
        return Math.abs(h - bandCentre[i]) > (typeof band === 'number' ? band : band[i]) ? Infinity : weight[i] * d * d;
    };
    for (let s = 0; s < states; s++) {
        cost[s] = fit(0, s);
    }
    const stepCost = steepCost * quant;
    const best = new Float64Array(states);
    const bestArg = new Int32Array(states);
    // A sliding-window minimum over the previous costs keeps it linear in
    // the states whatever the step.
    const dq = new Int32Array(states);
    for (let i = 1; i < n; i++) {
        let head = 0, tail = 0, next = 0;
        for (let s = 0; s < states; s++) {
            const hiIdx = Math.min(states - 1, s + steps);
            while (next <= hiIdx) {
                while (tail > head && cost[dq[tail - 1]] >= cost[next]) {
                    tail--;
                }
                dq[tail++] = next++;
            }
            while (dq[head] < s - steps) {
                head++;
            }
            best[s] = cost[dq[head]];
            bestArg[s] = dq[head];
        }
        // Past the window, each further quantum costs stepCost: an L1
        // distance transform of the window minimum.
        if (stepCost < Infinity) {
            for (let s = 1; s < states; s++) {
                if (best[s - 1] + stepCost < best[s]) {
                    best[s] = best[s - 1] + stepCost;
                    bestArg[s] = bestArg[s - 1];
                }
            }
            for (let s = states - 2; s >= 0; s--) {
                if (best[s + 1] + stepCost < best[s]) {
                    best[s] = best[s + 1] + stepCost;
                    bestArg[s] = bestArg[s + 1];
                }
            }
        }
        for (let s = 0; s < states; s++) {
            nextCost[s] = best[s] + fit(i, s);
            from[i * states + s] = bestArg[s];
        }
        [cost, nextCost] = [nextCost, cost];
    }
    let s = 0;
    for (let k = 1; k < states; k++) {
        if (cost[k] < cost[s]) {
            s = k;
        }
    }
    const out = new Array<number>(n);
    for (let i = n - 1; i >= 0; i--) {
        out[i] = (base + s) * quant;
        if (i > 0) {
            s = from[i * states + s];
        }
    }
    return out;
}

/**
 * `profile` with a moving average of 2 `radius` + 1 samples, held samples
 * (weight above 1) put back where they were with the difference tapered
 * out over the radius on either side.
 */
export function roundGradeBreaks(
    profile: readonly number[], weight: readonly number[], radius: number, stepLimit?: (i: number) => number,
): number[] {
    const n = profile.length;
    const r = Math.max(0, Math.round(radius));
    if (r === 0 || n < 3) {
        return profile.slice();
    }
    const prefix = [0];
    for (const h of profile) {
        prefix.push(prefix[prefix.length - 1] + h);
    }
    const out = profile.map((_, i) => {
        // Shrunk at the ends so the window stays centred.
        const w = Math.min(r, i, n - 1 - i);
        return (prefix[i + w + 1] - prefix[i - w]) / (2 * w + 1);
    });
    const fix = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
        if (weight[i] <= 1) {
            continue;
        }
        const d = profile[i] - out[i];
        for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) {
            const t = 1 - Math.abs(j - i) / (r + 1);
            if (Math.abs(d * t) > Math.abs(fix[j])) {
                fix[j] = d * t;
            }
        }
    }
    // A held sample keeps its own height exactly: a neighbour's tent, wider,
    // dragged a deck end 2.7 m down.
    const res = out.map((h, i) => (weight[i] > 1 ? profile[i] : h + fix[i]));
    if (stepLimit === undefined) {
        return res;
    }
    // The tent that puts a held sample back adds its own slope to the
    // average's: a street going down 4.6 m under a bridge came out at 12.8 %
    // on a 10 % ramp. No step steeper than `stepLimit` (step i - 1 to i);
    // held samples stay.
    const limit = stepLimit;
    for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < n; i++) {
            if (weight[i] <= 1) {
                res[i] = Math.min(res[i - 1] + limit(i), Math.max(res[i - 1] - limit(i), res[i]));
            }
        }
        for (let i = n - 2; i >= 0; i--) {
            if (weight[i] <= 1) {
                res[i] = Math.min(res[i + 1] + limit(i + 1), Math.max(res[i + 1] - limit(i + 1), res[i]));
            }
        }
    }
    return res;
}

/**
 * `profile` (one height per `step` metres) smoothed so its grade changes
 * gently: a Whittaker smoother - least squares on the heights plus a penalty
 * on each sample's second difference, weighted so a full swing between
 * +-`maxGrade` turns over radiusM * 2 maxGrade metres - with the held
 * samples (`weight` HOLD_WEIGHT: deck ends, the border, junctions) kept
 * exactly and a structure's (weight 0) left free. No sample may end further
 * off `ground` than `band`: round one that does the smoothing is loosened,
 * pass by pass, and solved again, so the line keeps to its earthworks,
 * bending tighter only where it must.
 *
 * Between held points a few dozen metres apart no radius can be promised,
 * so the curvature is spread as evenly as they let it be: a hard limit,
 * projected onto sample by sample, never settled there and left highway
 * profiles sharper than before.
 */
export function smoothVerticalCurves(
    profile: readonly number[], weight: readonly number[], ground: readonly number[], band: readonly number[],
    radiusM: number, maxGrade: number, step: number,
): number[] {
    const n = profile.length;
    if (n < 5) {
        return profile.slice();
    }
    const held = weight.map(w => w >= HOLD_WEIGHT);
    // The smoother's reach, about 2 lambda^(1/4) samples, over which the
    // swing of 2 maxGrade turns: radiusM * 2 maxGrade metres.
    const reach = (radiusM * 2 * maxGrade) / (2 * step);
    const lambda = reach ** 4;
    const w = weight.map((x, i) => (held[i] ? VERTICAL_HOLD_WEIGHT : Math.min(1, x)));
    // A free end stays where its fit put it: the penalty does not mind a
    // straight stretch tilting, and a street's far end, 180 m from a dip
    // under a bridge, came off the ground by half a metre.
    for (const i of [0, n - 1]) {
        if (!held[i] && weight[i] > 0) {
            w[i] = VERTICAL_END_WEIGHT;
        }
    }
    // The smoothing per second difference: loosened round a sample it took
    // past its band, so the line bends tighter there, but smoothly - pinned
    // or clamped instead, it kinked at every such sample (a mountain
    // highway's sharpest 1 % at 73 m).
    const lam = new Float64Array(Math.max(0, n - 2)).fill(lambda);
    const spread = Math.max(1, Math.round(reach));
    let h = profile.slice();
    for (let pass = 0; pass < VERTICAL_BAND_PASSES; pass++) {
        h = whittaker(profile, w, lam);
        let out = 0;
        for (let i = 0; i < n; i++) {
            if (held[i] || weight[i] <= 0 || !Number.isFinite(band[i])) {
                continue;
            }
            if (h[i] < ground[i] - band[i] - VERTICAL_BAND_SLACK_M || h[i] > ground[i] + band[i] + VERTICAL_BAND_SLACK_M) {
                for (let j = Math.max(0, i - spread); j <= Math.min(n - 3, i + spread); j++) {
                    // Most where it went past, tapering out over the reach.
                    const t = 1 - Math.abs(j + 1 - i) / (spread + 1);
                    lam[j] = Math.max(VERTICAL_LAMBDA_MIN, lam[j] * (1 - (1 - VERTICAL_LOOSEN) * Math.max(0, t)));
                }
                out++;
            }
        }
        if (out === 0) {
            break;
        }
    }
    for (let i = 0; i < n; i++) {
        if (held[i]) {
            h[i] = profile[i];
        } else if (weight[i] > 0 && Number.isFinite(band[i])) {
            // What the pull left past the band, a few tenths at most, clamped.
            h[i] = Math.min(ground[i] + band[i], Math.max(ground[i] - band[i], h[i]));
        }
    }
    return h;
}

/** Least squares of `target` (weights `w`) plus lambda[i] times each second difference i squared: (W + D' Lambda D) h = W target, five diagonals, LDL'. */
function whittaker(target: readonly number[], w: readonly number[], lambda: ArrayLike<number>): number[] {
    const n = target.length;
    const b0 = new Float64Array(n), b1 = new Float64Array(n), b2 = new Float64Array(n);
    const rhs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        b0[i] = w[i];
        rhs[i] = w[i] * target[i];
    }
    // Each second difference h[i] - 2 h[i+1] + h[i+2], squared.
    for (let i = 0; i + 2 < n; i++) {
        const l = lambda[i];
        b0[i] += l;
        b0[i + 1] += 4 * l;
        b0[i + 2] += l;
        b1[i] += -2 * l;
        b1[i + 1] += -2 * l;
        b2[i] += l;
    }
    const d = new Float64Array(n), l1 = new Float64Array(n), l2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let di = b0[i];
        if (i >= 1) {
            di -= l1[i - 1] * l1[i - 1] * d[i - 1];
        }
        if (i >= 2) {
            di -= l2[i - 2] * l2[i - 2] * d[i - 2];
        }
        d[i] = di;
        if (i + 1 < n) {
            l1[i] = (b1[i] - (i >= 1 ? l1[i - 1] * l2[i - 1] * d[i - 1] : 0)) / di;
        }
        if (i + 2 < n) {
            l2[i] = b2[i] / di;
        }
    }
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        y[i] = rhs[i] - (i >= 1 ? l1[i - 1] * y[i - 1] : 0) - (i >= 2 ? l2[i - 2] * y[i - 2] : 0);
    }
    const h = new Array<number>(n);
    for (let i = n - 1; i >= 0; i--) {
        h[i] = y[i] / d[i] - (i + 1 < n ? l1[i] * h[i + 1] : 0) - (i + 2 < n ? l2[i] * h[i + 2] : 0);
    }
    return h;
}

/** Weight of a held sample against a free one in smoothVerticalCurves: fixed, all but exactly. */
const VERTICAL_HOLD_WEIGHT = 1e9;
/** ... of a chain's free end, ... */
const VERTICAL_END_WEIGHT = 100;
/** Each pass a sample is past its band, the smoothing round it is multiplied by this, down to the least. */
const VERTICAL_LOOSEN = 0.3;
const VERTICAL_LAMBDA_MIN = 1;
/** Past its band by this much a sample counts, metres. */
const VERTICAL_BAND_SLACK_M = 0.05;
/** Passes of pinning and solving again. */
const VERTICAL_BAND_PASSES = 12;
/** How much further than its cap a line's earthworks may go for a gentle grade change. */
const VERTICAL_BAND_FACTOR = 2;

// --- geometry helpers ---------------------------------------------------------

export interface PlanFrame {
    up: V3;
    a: V3;
    b: V3;
    toPlan(p: V3): V3;
}

export function planFrame(up: V3): PlanFrame {
    const n = Math.hypot(up[0], up[1], up[2]);
    const u: V3 = [up[0] / n, up[1] / n, up[2] / n];
    const helper: V3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const d = helper[0] * u[0] + helper[1] * u[1] + helper[2] * u[2];
    let a: V3 = [helper[0] - u[0] * d, helper[1] - u[1] * d, helper[2] - u[2] * d];
    const al = Math.hypot(a[0], a[1], a[2]);
    a = [a[0] / al, a[1] / al, a[2] / al];
    const b: V3 = [u[1] * a[2] - u[2] * a[1], u[2] * a[0] - u[0] * a[2], u[0] * a[1] - u[1] * a[0]];
    return {
        up: u, a, b,
        toPlan: p => [
            p[0] * a[0] + p[1] * a[1] + p[2] * a[2],
            p[0] * b[0] + p[1] * b[1] + p[2] * b[2],
            p[0] * u[0] + p[1] * u[1] + p[2] * u[2],
        ],
    };
}

function clampI16(v: number): number {
    const r = Math.round(v);
    return r > 32767 ? 32767 : r < -32768 ? -32768 : r;
}

const CELL_M = 32;

/** The highest land facet over a plan point, from the soup as given. */
class GroundIndex {
    private readonly cells = new Map<number, number[]>();
    private readonly tri: Float64Array;

    constructor(positions: Int16Array, q: number, frame: PlanFrame, private readonly cell: number) {
        const n = positions.length / 9;
        this.tri = new Float64Array(n * 9);
        for (let t = 0; t < n; t++) {
            let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
            for (let k = 0; k < 3; k++) {
                const o = t * 9 + k * 3;
                const p = frame.toPlan([positions[o] * q, positions[o + 1] * q, positions[o + 2] * q]);
                this.tri[o] = p[0]; this.tri[o + 1] = p[1]; this.tri[o + 2] = p[2];
                u0 = Math.min(u0, p[0]); u1 = Math.max(u1, p[0]); v0 = Math.min(v0, p[1]); v1 = Math.max(v1, p[1]);
            }
            // A skirt or wall is no ground: standing on the border line, a
            // skirt (243 m deep, 0.1 m wide in plan) read as land 31 m below
            // a track crossing it, which was then taken for a structure and
            // kept off its ramp.
            const T = this.tri, o = t * 9;
            const area2 = Math.abs((T[o + 3] - T[o]) * (T[o + 7] - T[o + 1]) - (T[o + 6] - T[o]) * (T[o + 4] - T[o + 1]));
            const longest = Math.max(Math.hypot(T[o + 3] - T[o], T[o + 4] - T[o + 1]),
                Math.hypot(T[o + 6] - T[o + 3], T[o + 7] - T[o + 4]), Math.hypot(T[o] - T[o + 6], T[o + 1] - T[o + 7]));
            const rise = Math.max(T[o + 2], T[o + 5], T[o + 8]) - Math.min(T[o + 2], T[o + 5], T[o + 8]);
            if (longest > 0 && rise > GROUND_WALL_STEEP * (area2 / longest)) {
                continue;
            }
            for (let cu = Math.floor(u0 / this.cell); cu <= Math.floor(u1 / this.cell); cu++) {
                for (let cv = Math.floor(v0 / this.cell); cv <= Math.floor(v1 / this.cell); cv++) {
                    const key = cellKey(cu, cv);
                    const list = this.cells.get(key);
                    if (list) {
                        list.push(t);
                    } else {
                        this.cells.set(key, [t]);
                    }
                }
            }
        }
    }

    at(u: number, v: number): number | undefined {
        const list = this.cells.get(cellKey(Math.floor(u / this.cell), Math.floor(v / this.cell)));
        if (!list) {
            return undefined;
        }
        let best: number | undefined;
        for (const t of list) {
            const o = t * 9, T = this.tri;
            const h = barycentricHeight(u, v, T[o], T[o + 1], T[o + 2], T[o + 3], T[o + 4], T[o + 5], T[o + 6], T[o + 7], T[o + 8]);
            if (h !== undefined && (best === undefined || h > best)) {
                best = h;
            }
        }
        return best;
    }

    /** The lowest land facet over a plan point: the ground under a land-use fill lifted over it. */
    lowest(u: number, v: number): number | undefined {
        const list = this.cells.get(cellKey(Math.floor(u / this.cell), Math.floor(v / this.cell)));
        if (!list) {
            return undefined;
        }
        let best: number | undefined;
        for (const t of list) {
            const o = t * 9, T = this.tri;
            const h = barycentricHeight(u, v, T[o], T[o + 1], T[o + 2], T[o + 3], T[o + 4], T[o + 5], T[o + 6], T[o + 7], T[o + 8]);
            if (h !== undefined && (best === undefined || h < best)) {
                best = h;
            }
        }
        return best;
    }
}

function cellKey(cu: number, cv: number): number {
    return (cu + 32768) * 65536 + (cv + 32768);
}

function barycentricHeight(
    u: number, v: number,
    u0: number, v0: number, h0: number, u1: number, v1: number, h1: number, u2: number, v2: number, h2: number,
): number | undefined {
    const det = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(det) < 1e-9) {
        return undefined;
    }
    const l0 = ((v1 - v2) * (u - u2) + (u2 - u1) * (v - v2)) / det;
    const l1 = ((v2 - v0) * (u - u2) + (u0 - u2) * (v - v2)) / det;
    const l2 = 1 - l0 - l1;
    const eps = -1e-6;
    if (l0 < eps || l1 < eps || l2 < eps) {
        return undefined;
    }
    return l0 * h0 + l1 * h1 + l2 * h2;
}

interface BedSegment {
    a: Sample;
    b: Sample;
    half: number;
    /** BED_OPEN_A / BED_OPEN_B: that end stops square rather than rounded. */
    open: number;
    /** Priority, 0 highest: see BED_TIERS. */
    tier: number;
    /** How far past the shoulder its batter reaches, metres. */
    reach: number;
    /** Whether the land is refined to follow it (its tier's, or a street lifted well off its ground). */
    refine: boolean;
    /**
     * Its line's open ends near it, as plan point and outward direction
     * (u, v, du, dv per end): nothing past one belongs to the bed.
     */
    cut?: number[];
}

/** A bed segment's first end is open: nothing past it belongs to the bed. */
export const BED_OPEN_A = 1;
/** Its second end is. */
export const BED_OPEN_B = 2;

/**
 * Where along a bed segment a point projects, clamped to it, or undefined
 * when it falls past an open end. `open` is BED_OPEN_A | BED_OPEN_B.
 */
export function bedSegmentParam(
    pu: number, pv: number, du: number, dv: number, open: number,
): number | undefined {
    const l2 = du * du + dv * dv;
    if (l2 <= 1e-12) {
        return open ? undefined : 0;
    }
    const t = (pu * du + pv * dv) / l2;
    if ((t < 0 && (open & BED_OPEN_A)) || (t > 1 && (open & BED_OPEN_B))) {
        return undefined;
    }
    return Math.min(1, Math.max(0, t));
}

/** Whether a plan point lies past any of a bed's open ends (BedSegment.cut). */
function beyondCut(cut: readonly number[], u: number, v: number): boolean {
    for (let i = 0; i < cut.length; i += 4) {
        if ((u - cut[i]) * cut[i + 2] + (v - cut[i + 1]) * cut[i + 3] > 0) {
            return true;
        }
    }
    return false;
}

/** Rise per metre past which an earthwork face is a retaining wall: 45 degrees. */
const WALL_SLOPE = 1;
/** ... when the earthworks steepened it by at least this much (rise per metre), */
const WALL_STEEPENED = 0.3;
/** ... and moved it at least this far, metres. */
const WALL_MIN_MOVE_M = 0.3;
/** Plan area under which a triangle is a vertical wall, square metres. */
const WALL_PLAN_AREA_M2 = 0.01;
/**
 * How far the land may move off the refined surface when the refinement's
 * needless splits are taken back (SoupMesh.collapseFlat), metres: what the
 * refinement's own fit allows (FIT_TOLERANCE_M), on batters and the land
 * between lines. At 0.15 m everywhere the graded leaves kept twice the
 * triangles they needed; at 0.75 m the grading still added half again to a
 * Garmisch leaf's land. 1.5 m took a fifth of that back (and 0.7 MB of
 * 8.1 on the 5x5); at 3 m the land heaved up in front of the walls.
 */
const COLLAPSE_TOLERANCE_M = 1.5;
/**
 * Steepest a land vertex may stand over every neighbour round it, rise over
 * run, before it is a spike (SoupMesh.despike): past any batter's 1:1, where
 * the walls take over.
 */
const DESPIKE_SLOPE = 1.5;
/** Rounds of despiking: one taken down may leave its neighbour a spike. */
const DESPIKE_PASSES = 4;
/** A spike stands this much over its limit before it is one, metres. */
const DESPIKE_SLACK_M = 0.05;
/** A neighbour nearer than this in plan stands under it (a skirt), metres. */
const DESPIKE_MIN_RUN_M = 0.05;
/** ... and lower than it, within COLLAPSE_NEAR_LINE_M of a drawn line's shoulder, metres. */
const COLLAPSE_LINE_TOLERANCE_M = 0.15;
/** Off the refined surface by no more than this, the land has not moved (under a deck), metres. */
const COLLAPSE_SAME_M = 0.01;
const COLLAPSE_NEAR_LINE_M = 2;
/**
 * Nearest a collapse may bring a land-use fill and the ground under it,
 * metres: the fill lies 2 % of a cell over it (0.5 m at z12), and before the
 * layers were checked a 0.15 m tolerance each way kept them this far apart.
 */
const LAYER_GAP_M = 0.2;
/** Grid cell of the layer check, metres. */
const LAYER_CELL_M = 8;
/** Passes of the collapse (each followed by a pass of edge flips) over the tile. */
const COLLAPSE_PASSES = 8;
/** A flip must beat the Delaunay sum of the angles facing the edge by this much, radians: no flip-flopping. */
const FLIP_MIN_GAIN = 0.05;
/** Thinnest triangle a collapse may leave: twice its plan area over its longest edge squared. */
const COLLAPSE_MIN_SHAPE = 0.02;
/**
 * How far under a drawn road or track its land is kept, as a share of the
 * strokes' lift: the strokes float a lift over their beds, and the land is
 * fitted to the beds within a tolerance near that, so without a hard cap it
 * poked through the road in patches.
 */
const ROAD_CAP_CLEAR_LIFT = 0.25;
/** A vertex lowered under a road goes this far over its bed, metres. */
const ROAD_BED_SNAP_M = 0.05;
/** Land this little over a road's cap is no matter, metres. */
const ROAD_CAP_EPS_M = 0.02;
/** Triangles the road cap may add to a tile on top of what the beds' refinement added, however much that was. */
const ROAD_CAP_MAX_NEW = 150000;
/** An edge is split on a crease only this far in from either end, as a share of it: nearer, the pieces go thin. */
const CREASE_SPLIT_RANGE = 0.2;
/** A line shorter than this is not graded, metres. */
const MIN_CHAIN_M = 0.5;
/** Distance from the tile border over which the beds fade in, metres. */
const BORDER_TAPER_M = 30;

/**
 * The tile's border in plan, answering how far in from the border a point
 * is: the edges between border vertices, not the vertices alone - those can
 * be 300 m apart along a straight side, and a vertex split into a sliver
 * beside it, 2.5 m from the border, was taken for 130 m in and lifted the
 * full height of a rail embankment above the neighbour's edge.
 */
class BorderIndex {
    private readonly cells = new Map<number, number[]>();
    /** Segments: ua, va, ub, vb. */
    private readonly segs: number[] = [];
    /** Their ends' heights as baked: ha, hb. */
    private readonly heights: number[] = [];
    /**
     * Whether each segment runs between top vertices: a skirt hangs from the
     * border at the same plan points, and its vertices are on the border too.
     */
    private readonly onTop: boolean[] = [];

    constructor(positions: Int16Array, border: ReadonlySet<number>, q: number, frame: PlanFrame, private readonly cell: number) {
        const key = (vi: number) => `${positions[vi * 3]},${positions[vi * 3 + 1]},${positions[vi * 3 + 2]}`;
        const onBorder = new Set<string>();
        for (const vi of border) {
            onBorder.add(key(vi));
        }
        const plan = (vi: number) => frame.toPlan([positions[vi * 3] * q, positions[vi * 3 + 1] * q, positions[vi * 3 + 2] * q]);
        // The highest vertex at each plan point is the land's; the rest are
        // its skirt. A skirt hangs along the bake frame's y, not the real
        // vertical, so its foot lies centimetres off its top in plan: a
        // vertex is skirt if another within a metre stands well above it.
        const top = new Map<string, number>();
        const cellOf = (u: number, v: number) => [Math.floor(u), Math.floor(v)];
        for (const vi of border) {
            const [u, v, h] = plan(vi);
            const [cu, cv] = cellOf(u, v);
            top.set(`${cu},${cv}`, Math.max(top.get(`${cu},${cv}`) ?? -Infinity, h));
        }
        const isTop = (u: number, v: number, h: number) => {
            const [cu, cv] = cellOf(u, v);
            for (let du = -1; du <= 1; du++) {
                for (let dv = -1; dv <= 1; dv++) {
                    if ((top.get(`${cu + du},${cv + dv}`) ?? -Infinity) > h + 1) {
                        return false;
                    }
                }
            }
            return true;
        };
        const seen = new Set<string>();
        const add = (a: number, b: number) => {
            const ka = key(a), kb = key(b);
            const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
            if (seen.has(k)) {
                return;
            }
            seen.add(k);
            const [ua, va, ha] = plan(a), [ub, vb, hb] = plan(b);
            const id = this.segs.length / 4;
            this.segs.push(ua, va, ub, vb);
            this.heights.push(ha, hb);
            this.onTop.push(isTop(ua, va, ha) && isTop(ub, vb, hb));
            for (let cu = Math.floor(Math.min(ua, ub) / cell); cu <= Math.floor(Math.max(ua, ub) / cell); cu++) {
                for (let cv = Math.floor(Math.min(va, vb) / cell); cv <= Math.floor(Math.max(va, vb) / cell); cv++) {
                    const ck = cellKey(cu, cv);
                    const list = this.cells.get(ck);
                    if (list) {
                        list.push(id);
                    } else {
                        this.cells.set(ck, [id]);
                    }
                }
            }
        };
        // Every vertex on its own, and every land edge between two of them.
        for (const vi of border) {
            add(vi, vi);
        }
        for (let t = 0; t + 2 < positions.length / 3; t += 3) {
            for (let k = 0; k < 3; k++) {
                const a = t + k, b = t + (k + 1) % 3;
                if (onBorder.has(key(a)) && onBorder.has(key(b))) {
                    add(a, b);
                }
            }
        }
    }

    /**
     * Where lines cross the border at a height both tiles agree on: the
     * stretch of each from the crossing in past the taper (ua, va, ub, vb)
     * and how far either side of it is free.
     */
    private free: number[] = [];

    /**
     * Set the crossings round which the border is free: the lines through
     * them, and the land round them, keep their earthworks right up to the
     * border, whose vertices move there - both tiles hold the line to the
     * same height there (RailBedInput.borderRamps), and the stitcher takes the moved
     * border as the tile's own.
     */
    setFree(free: readonly number[]): void {
        this.free = free.slice();
        // Bucketed: the bake frees the border round every bed near it, its
        // own and its neighbours' - thousands of zones, asked about for
        // every point the refinement checks.
        this.freeCells.clear();
        const F = this.free;
        for (let i = 0; i < F.length; i += 5) {
            const r = F[i + 4];
            for (let cu = Math.floor((Math.min(F[i], F[i + 2]) - r) / this.cell); cu <= Math.floor((Math.max(F[i], F[i + 2]) + r) / this.cell); cu++) {
                for (let cv = Math.floor((Math.min(F[i + 1], F[i + 3]) - r) / this.cell); cv <= Math.floor((Math.max(F[i + 1], F[i + 3]) + r) / this.cell); cv++) {
                    const key = cellKey(cu, cv);
                    const list = this.freeCells.get(key);
                    if (list) {
                        list.push(i);
                    } else {
                        this.freeCells.set(key, [i]);
                    }
                }
            }
        }
    }
    private readonly freeCells = new Map<number, number[]>();

    /** How free of the border's hold a point is: 1 within half a crossing's radius, 0 past it. */
    private freedom(u: number, v: number): number {
        let f = 0;
        const F = this.free;
        for (const i of this.freeCells.get(cellKey(Math.floor(u / this.cell), Math.floor(v / this.cell))) ?? []) {
            const r = F[i + 4];
            const eu = F[i + 2] - F[i], ev = F[i + 3] - F[i + 1];
            const l2 = eu * eu + ev * ev;
            const t0 = l2 > 0 ? Math.max(0, Math.min(1, ((u - F[i]) * eu + (v - F[i + 1]) * ev) / l2)) : 0;
            const d = Math.hypot(u - F[i] - eu * t0, v - F[i + 1] - ev * t0);
            if (d < r) {
                const t = Math.min(1, Math.max(0, (d - r / 2) / (r / 2)));
                f = Math.max(f, 1 - t * t * (3 - 2 * t));
            }
        }
        return f;
    }

    /** Whether a border vertex at (u, v) may move: it is in a crossing's free zone. */
    movable(u: number, v: number): boolean {
        return this.freedom(u, v) > 0;
    }

    /** 0 on the border, rising smoothly to 1 at BORDER_TAPER_M in; 1 round a free crossing. */
    fade(u: number, v: number): number {
        const free = this.free.length > 0 ? this.freedom(u, v) : 0;
        return free >= 1 ? 1 : Math.max(free, this.taper(u, v));
    }

    /**
     * The border edge nearest (u, v) within BORDER_TAPER_M: its ends (plan and
     * height as baked) and where along it (0..1) the point projects.
     */
    nearestEdge(u: number, v: number): { ua: number; va: number; ha: number; ub: number; vb: number; hb: number; t: number } | undefined {
        const r = Math.ceil(BORDER_TAPER_M / this.cell);
        const cu = Math.floor(u / this.cell), cv = Math.floor(v / this.cell);
        let best = -1, bestD2 = BORDER_TAPER_M * BORDER_TAPER_M, bestT = 0;
        const S = this.segs;
        for (let du = -r; du <= r; du++) {
            for (let dv = -r; dv <= r; dv++) {
                for (const k of this.cells.get(cellKey(cu + du, cv + dv)) ?? []) {
                    // The land's own border, never its skirt: a skirt's foot
                    // hangs up to hundreds of metres below the same point,
                    // and taken for the border it hauled the land up to it.
                    if (!this.onTop[k]) {
                        continue;
                    }
                    const o = k * 4;
                    const eu = S[o + 2] - S[o], ev = S[o + 3] - S[o + 1];
                    const l2 = eu * eu + ev * ev;
                    const t = l2 > 0 ? Math.max(0, Math.min(1, ((u - S[o]) * eu + (v - S[o + 1]) * ev) / l2)) : 0;
                    const x = S[o] + eu * t - u, y = S[o + 1] + ev * t - v;
                    const d2 = x * x + y * y;
                    if (d2 < bestD2) {
                        bestD2 = d2;
                        best = k;
                        bestT = t;
                    }
                }
            }
        }
        if (best < 0) {
            return undefined;
        }
        const o = best * 4;
        return { ua: S[o], va: S[o + 1], ha: this.heights[best * 2], ub: S[o + 2], vb: S[o + 3], hb: this.heights[best * 2 + 1], t: bestT };
    }

    /** 0 on the border, rising smoothly to 1 at BORDER_TAPER_M in, free crossings or not. */
    taper(u: number, v: number): number {
        if (this.segs.length === 0) {
            return 1;
        }
        const r = Math.ceil(BORDER_TAPER_M / this.cell);
        const cu = Math.floor(u / this.cell), cv = Math.floor(v / this.cell);
        let d2 = BORDER_TAPER_M * BORDER_TAPER_M;
        const S = this.segs;
        for (let du = -r; du <= r; du++) {
            for (let dv = -r; dv <= r; dv++) {
                for (const k of this.cells.get(cellKey(cu + du, cv + dv)) ?? []) {
                    const o = k * 4;
                    const eu = S[o + 2] - S[o], ev = S[o + 3] - S[o + 1];
                    const l2 = eu * eu + ev * ev;
                    const t = l2 > 0 ? Math.max(0, Math.min(1, ((u - S[o]) * eu + (v - S[o + 1]) * ev) / l2)) : 0;
                    const x = S[o] + eu * t - u, y = S[o + 1] + ev * t - v;
                    d2 = Math.min(d2, x * x + y * y);
                }
            }
        }
        const t = Math.sqrt(d2) / BORDER_TAPER_M;
        return t * t * (3 - 2 * t);
    }
}

/** A kept triangle whose lowest corner is this far over the ground is aloft (a deck): nothing to bury, metres. */
const KEEP_ALOFT_M = 2;
/** Clear of the earthworks beyond a kept feature's own edge (a road's half width), metres. */
const KEEP_MARGIN_M = 0.5;
/** Farthest a kept feature limits the earthworks: past it, 1:2 allows more than any bed moves, metres. */
const KEEP_REACH_M = 2 * (NO_BED_OFF_LAND_M + KEEP_MARGIN_M);

/** Whether any bed reaches into a plan box. */
type Near = (u0: number, v0: number, u1: number, v1: number) => boolean;

/**
 * What the earthworks must leave as baked: the tile's roads, other
 * structures' footprints (bridge decks, piers and abutments, this tile's and
 * the neighbours'), lakes and the sea, and watercourses. Answers how far a
 * plan point is from the nearest of them; the ground there may then move at
 * most 1:2 of that distance - not at all on one, a cutting's or an
 * embankment's slope away from it - so a bed's batter runs out before it
 * reaches a road, a bridge or the water rather than burying it.
 */
class KeepIndex {
    private readonly cells = new Map<number, number[]>();
    /** Segments: ua, va, ub, vb, half. */
    private readonly segs: number[] = [];
    /** Triangles: u0, v0, u1, v1, u2, v2. */
    private readonly tris: number[] = [];

    constructor(
        keep: RailBedInput['keep'], frame: PlanFrame,
        private readonly cell: number, near: Near,
        groundAt?: (u: number, v: number) => number | undefined,
    ) {
        // Roads are beds of their own now (BED_TIERS), not kept clear of.
        const segs = keep?.segs;
        for (let o = 0; segs && o + 6 < segs.length; o += 7) {
            const pa = frame.toPlan([segs[o], segs[o + 1], segs[o + 2]]);
            const pb = frame.toPlan([segs[o + 3], segs[o + 4], segs[o + 5]]);
            this.addSeg(pa[0], pa[1], pb[0], pb[1], segs[o + 6], near);
        }
        const tris = keep?.tris;
        for (let o = 0; tris && o + 8 < tris.length; o += 9) {
            const p = [0, 3, 6].map(k => frame.toPlan([tris[o + k], tris[o + k + 1], tris[o + k + 2]]));
            // Only what comes down to the ground can be buried: a deck
            // overhead is not, and kept, it held the land up under it in
            // teeth beside a road cut down under the bridge.
            // (Judged at the corners with land under them: a deck often
            // reaches over the tile's edge.)
            if (groundAt) {
                let clear = Infinity;
                for (const c of p) {
                    const land = groundAt(c[0], c[1]);
                    if (land !== undefined) {
                        clear = Math.min(clear, c[2] - land);
                    }
                }
                if (clear !== Infinity && clear > KEEP_ALOFT_M) {
                    continue;
                }
            }
            const u0 = Math.min(p[0][0], p[1][0], p[2][0]), u1 = Math.max(p[0][0], p[1][0], p[2][0]);
            const v0 = Math.min(p[0][1], p[1][1], p[2][1]), v1 = Math.max(p[0][1], p[1][1], p[2][1]);
            if (!near(u0 - KEEP_REACH_M, v0 - KEEP_REACH_M, u1 + KEEP_REACH_M, v1 + KEEP_REACH_M)) {
                continue;
            }
            const k = this.tris.length / 6;
            this.tris.push(p[0][0], p[0][1], p[1][0], p[1][1], p[2][0], p[2][1]);
            // Negative ids are triangles.
            this.bucket(-(k + 1), u0, v0, u1, v1, KEEP_REACH_M, near);
        }
    }

    private addSeg(ua: number, va: number, ub: number, vb: number, half: number, near: Near): void {
        const u0 = Math.min(ua, ub), u1 = Math.max(ua, ub), v0 = Math.min(va, vb), v1 = Math.max(va, vb);
        const reach = half + KEEP_MARGIN_M + KEEP_REACH_M;
        if (!near(u0 - reach, v0 - reach, u1 + reach, v1 + reach)) {
            return;
        }
        const k = this.segs.length / 5;
        this.segs.push(ua, va, ub, vb, half + KEEP_MARGIN_M);
        this.bucket(k, u0, v0, u1, v1, reach, near);
    }

    private bucket(
        id: number, u0: number, v0: number, u1: number, v1: number, reach: number, near: Near,
    ): void {
        const c = this.cell;
        for (let cu = Math.floor((u0 - reach) / c); cu <= Math.floor((u1 + reach) / c); cu++) {
            for (let cv = Math.floor((v0 - reach) / c); cv <= Math.floor((v1 + reach) / c); cv++) {
                // Only cells a bed reaches: a lake's triangle can span hundreds.
                if (!near(cu * c, cv * c, (cu + 1) * c, (cv + 1) * c)) {
                    continue;
                }
                const key = cellKey(cu, cv);
                const list = this.cells.get(key);
                if (list) {
                    list.push(id);
                } else {
                    this.cells.set(key, [id]);
                }
            }
        }
    }

    /** How far the ground at (u, v) may leave its baked height, metres; Infinity when nothing kept is near. */
    allowance(u: number, v: number): number {
        const list = this.cells.get(cellKey(Math.floor(u / this.cell), Math.floor(v / this.cell)));
        if (!list) {
            return Infinity;
        }
        let d = Infinity;
        for (const id of list) {
            if (id >= 0) {
                const o = id * 5, s = this.segs;
                const du = s[o + 2] - s[o], dv = s[o + 3] - s[o + 1];
                const l2 = du * du + dv * dv;
                const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((u - s[o]) * du + (v - s[o + 1]) * dv) / l2)) : 0;
                d = Math.min(d, Math.max(0, Math.hypot(u - s[o] - du * t, v - s[o + 1] - dv * t) - s[o + 4]));
            } else {
                const o = (-id - 1) * 6;
                d = Math.min(d, Math.max(0, triangleDistance(u, v, this.tris, o) - KEEP_MARGIN_M));
            }
            if (d === 0) {
                return 0;
            }
        }
        return d === Infinity ? Infinity : d * BATTER;
    }
}

/** Plan distance from (u, v) to a triangle (u0, v0, u1, v1, u2, v2 at `o`); 0 inside. */
function triangleDistance(u: number, v: number, t: readonly number[], o: number): number {
    const ax = t[o], ay = t[o + 1], bx = t[o + 2], by = t[o + 3], cx = t[o + 4], cy = t[o + 5];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) > 1e-12) {
        const l0 = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / det;
        const l1 = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / det;
        if (l0 >= 0 && l1 >= 0 && l0 + l1 <= 1) {
            return 0;
        }
    }
    const seg = (px: number, py: number, qx: number, qy: number) => {
        const dx = qx - px, dy = qy - py;
        const l2 = dx * dx + dy * dy;
        const s = l2 > 1e-12 ? Math.min(1, Math.max(0, ((u - px) * dx + (v - py) * dy) / l2)) : 0;
        return Math.hypot(u - px - dx * s, v - py - dy * s);
    };
    return Math.min(seg(ax, ay, bx, by), seg(bx, by, cx, cy), seg(cx, cy, ax, ay));
}

/** The bed segments, bucketed, answering "how far from the nearest bed, and at what design height". */
/** Grid cell of the road surface index, metres. */
const ROAD_CAP_CELL_M = 8;
/** Spacing of the points along a road the land under it is checked at, metres. */
const ROAD_CAP_STEP_M = 2;

/**
 * The drawn roads and tracks as surfaces the land must stay under: each
 * stroke segment of the graded strokes, its drawn height at both ends and its
 * half width, plan metres. The land under a line never comes above its
 * drawn surface less `clear` - no terrain over a road or a railway.
 */
class RoadCap {
    private readonly segs: number[] = [];
    private readonly cells = new Map<number, number[]>();

    constructor(
        strokes: Pick<PtrTile, 'positions' | 'directions' | 'halfWidths' | 'indices'>, q: number, frame: PlanFrame,
        private readonly clear: number,
        /** How far the strokes float over their beds: a lowered vertex goes down to the bed, BED_SNAP_M over it. */
        private readonly lift: number,
    ) {
        const P = strokes.positions;
        for (let i = 0; i + 5 < strokes.indices.length; i += 6) {
            const a = strokes.indices[i], b = strokes.indices[i + 5];
            const cls = strokes.directions[a * 4 + 3] & ROAD_CLASS_MASK;
            if (bedTierOf(cls) < 0) {
                continue;
            }
            const A = frame.toPlan([P[a * 3] * q, P[a * 3 + 1] * q, P[a * 3 + 2] * q]);
            const B = frame.toPlan([P[b * 3] * q, P[b * 3 + 1] * q, P[b * 3 + 2] * q]);
            const half = Math.max(strokes.halfWidths[a], strokes.halfWidths[b]) / 10;
            const o = this.segs.length;
            this.segs.push(A[0], A[1], A[2], B[0], B[1], B[2], half);
            const r = half + SHOULDER_M;
            for (let cu = Math.floor((Math.min(A[0], B[0]) - r) / ROAD_CAP_CELL_M); cu <= Math.floor((Math.max(A[0], B[0]) + r) / ROAD_CAP_CELL_M); cu++) {
                for (let cv = Math.floor((Math.min(A[1], B[1]) - r) / ROAD_CAP_CELL_M); cv <= Math.floor((Math.max(A[1], B[1]) + r) / ROAD_CAP_CELL_M); cv++) {
                    const key = cellKey(cu, cv);
                    const list = this.cells.get(key);
                    if (list) {
                        list.push(o);
                    } else {
                        this.cells.set(key, [o]);
                    }
                }
            }
        }
    }

    get empty(): boolean {
        return this.segs.length === 0;
    }

    /**
     * Highest the land may stand at (u, v): under every line whose
     * carriageway - widened by `beyond`, metres - covers it; undefined off them.
     */
    cap(u: number, v: number, beyond = 0): number | undefined {
        return this.lowest(u, v, this.clear, beyond);
    }

    /** Where land over the cap is put: on the bed of the lowest line covering (u, v). */
    bed(u: number, v: number, beyond = 0): number | undefined {
        return this.lowest(u, v, this.lift - ROAD_BED_SNAP_M, beyond);
    }

    private lowest(u: number, v: number, under: number, beyond: number): number | undefined {
        const S = this.segs;
        let best: number | undefined;
        for (const o of this.cells.get(cellKey(Math.floor(u / ROAD_CAP_CELL_M), Math.floor(v / ROAD_CAP_CELL_M))) ?? []) {
            const du = S[o + 3] - S[o], dv = S[o + 4] - S[o + 1];
            const l2 = du * du + dv * dv;
            const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((u - S[o]) * du + (v - S[o + 1]) * dv) / l2)) : 0;
            if (Math.hypot(u - S[o] - du * t, v - S[o + 1] - dv * t) > S[o + 6] + beyond) {
                continue;
            }
            const h = S[o + 2] + (S[o + 5] - S[o + 2]) * t - under;
            best = best === undefined ? h : Math.min(best, h);
        }
        return best;
    }

    /**
     * Points on the carriageways (centre and both edges, every
     * ROAD_CAP_STEP_M) inside a plan box, as (u, v) pairs; with a plan
     * triangle (u, v of each corner), also where its sides cross those
     * lines - where a flat face rises highest over a road between the steps.
     */
    probes(u0: number, v0: number, u1: number, v1: number, out: number[], tri?: readonly number[]): void {
        out.length = 0;
        const S = this.segs;
        const seen = new Set<number>();
        for (let cu = Math.floor(u0 / ROAD_CAP_CELL_M); cu <= Math.floor(u1 / ROAD_CAP_CELL_M); cu++) {
            for (let cv = Math.floor(v0 / ROAD_CAP_CELL_M); cv <= Math.floor(v1 / ROAD_CAP_CELL_M); cv++) {
                for (const o of this.cells.get(cellKey(cu, cv)) ?? []) {
                    if (seen.has(o)) {
                        continue;
                    }
                    seen.add(o);
                    const du = S[o + 3] - S[o], dv = S[o + 4] - S[o + 1];
                    const len = Math.hypot(du, dv);
                    if (len < 1e-6) {
                        continue;
                    }
                    const nu = -dv / len, nv = du / len, half = S[o + 6] * 0.95;
                    const n = Math.max(1, Math.ceil(len / ROAD_CAP_STEP_M));
                    for (let k = 0; k <= n; k++) {
                        for (const off of [0, half, -half]) {
                            const u = S[o] + du * (k / n) + nu * off, v = S[o + 1] + dv * (k / n) + nv * off;
                            if (u >= u0 && u <= u1 && v >= v0 && v <= v1) {
                                out.push(u, v);
                            }
                        }
                    }
                    if (!tri) {
                        continue;
                    }
                    for (const off of [0, half, -half]) {
                        const au = S[o] + nu * off, av = S[o + 1] + nv * off;
                        for (let e = 0; e < 3; e++) {
                            const pu = tri[e * 2], pv = tri[e * 2 + 1];
                            const qu = tri[((e + 1) % 3) * 2] - pu, qv = tri[((e + 1) % 3) * 2 + 1] - pv;
                            const den = qu * dv - qv * du;
                            if (Math.abs(den) < 1e-12) {
                                continue;
                            }
                            // Along the side (s) and along the line (k), both within.
                            const s = ((au - pu) * dv - (av - pv) * du) / den;
                            const k = ((au - pu) * qv - (av - pv) * qu) / den;
                            if (s >= 0 && s <= 1 && k >= 0 && k <= 1) {
                                out.push(pu + qu * s, pv + qv * s);
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Grid cell of the drawn lines' index, metres. */
const DRAWN_CELL_M = 16;

/** The tile's drawn lines as centrelines with half widths, plan metres: what a wall must not stand on. */
class DrawnLines {
    private readonly segs: number[] = [];
    private readonly cells = new Map<number, number[]>();

    constructor(lines: ReadonlyArray<{ points: readonly V3[]; half: readonly number[] }>, private readonly cell: number) {
        for (const l of lines) {
            for (let i = 1; i < l.points.length; i++) {
                const a = l.points[i - 1], b = l.points[i];
                const half = Math.max(l.half[i - 1], l.half[i]);
                const o = this.segs.length;
                this.segs.push(a[0], a[1], b[0], b[1], half);
                const pad = half + 2;
                for (let cu = Math.floor((Math.min(a[0], b[0]) - pad) / cell); cu <= Math.floor((Math.max(a[0], b[0]) + pad) / cell); cu++) {
                    for (let cv = Math.floor((Math.min(a[1], b[1]) - pad) / cell); cv <= Math.floor((Math.max(a[1], b[1]) + pad) / cell); cv++) {
                        const key = cellKey(cu, cv);
                        const list = this.cells.get(key);
                        if (list) {
                            list.push(o);
                        } else {
                            this.cells.set(key, [o]);
                        }
                    }
                }
            }
        }
    }

    /** Whether (u, v) is on a drawn line or within `clear` (at most 2 m) of its edge. */
    on(u: number, v: number, clear: number): boolean {
        const S = this.segs;
        for (const o of this.cells.get(cellKey(Math.floor(u / this.cell), Math.floor(v / this.cell))) ?? []) {
            const du = S[o + 2] - S[o], dv = S[o + 3] - S[o + 1];
            const l2 = du * du + dv * dv;
            const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((u - S[o]) * du + (v - S[o + 1]) * dv) / l2)) : 0;
            if (Math.hypot(u - S[o] - du * t, v - S[o + 1] - dv * t) < S[o + 4] + clear) {
                return true;
            }
        }
        return false;
    }
}

class BedIndex {
    private readonly cells = new Map<number, number[]>();

    constructor(private readonly segs: readonly BedSegment[], private readonly cell: number) {
        segs.forEach((s, i) => {
            const reach = s.half + SHOULDER_M + s.reach + BATTER_FADE_M;
            const u0 = Math.min(s.a.u, s.b.u) - reach, u1 = Math.max(s.a.u, s.b.u) + reach;
            const v0 = Math.min(s.a.v, s.b.v) - reach, v1 = Math.max(s.a.v, s.b.v) + reach;
            for (let cu = Math.floor(u0 / this.cell); cu <= Math.floor(u1 / this.cell); cu++) {
                for (let cv = Math.floor(v0 / this.cell); cv <= Math.floor(v1 / this.cell); cv++) {
                    const key = cellKey(cu, cv);
                    const list = this.cells.get(key);
                    if (list) {
                        list.push(i);
                    } else {
                        this.cells.set(key, [i]);
                    }
                }
            }
        });
    }

    /**
     * The points where the land has to bend to follow the beds reaching
     * into a plan box: each sample of the track, and either side of it the
     * bed's edge and the toe of its batter. A triangle hundreds of metres
     * across (a merged field) is checked at these, not only on its own
     * grid, whose points would fall either side of a 5 m bed.
     */
    creases(u0: number, v0: number, u1: number, v1: number, out: number[]): void {
        out.length = 0;
        const seen = new Set<number>();
        for (let cu = Math.floor(u0 / this.cell); cu <= Math.floor(u1 / this.cell); cu++) {
            for (let cv = Math.floor(v0 / this.cell); cv <= Math.floor(v1 / this.cell); cv++) {
                for (const i of this.cells.get(cellKey(cu, cv)) ?? []) {
                    if (seen.has(i)) {
                        continue;
                    }
                    seen.add(i);
                    const s = this.segs[i];
                    const du = s.b.u - s.a.u, dv = s.b.v - s.a.v;
                    const len = Math.hypot(du, dv) || 1;
                    const nu = -dv / len, nv = du / len;
                    for (const p of [s.a, s.b]) {
                        const edge = s.half + SHOULDER_M;
                        const toe = edge + Math.min(s.reach, Math.abs(p.h - p.land) / BATTER);
                        // ... and where its band opens out past its reach.
                        const open = edge + s.reach, shut = open + BATTER_FADE_M;
                        for (const d of [0, edge, -edge, toe, -toe, open, -open, shut, -shut]) {
                            const u = p.u + nu * d, v = p.v + nv * d;
                            if (u >= u0 && u <= u1 && v >= v0 && v <= v1) {
                                out.push(u, v);
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Where along the plan edge (ua, va) -> (ub, vb) it crosses one of the
     * beds' creases - the line, a bed's edge, a batter's toe, where its band
     * opens out and shuts (as creases() lists them, here as lines along each
     * bed segment) - as a fraction of the edge, the crossing nearest its
     * middle within CREASE_SPLIT_RANGE; undefined when none does.
     */
    creaseCrossing(ua: number, va: number, ub: number, vb: number): number | undefined {
        const eu = ub - ua, ev = vb - va;
        let best: number | undefined, bestOff = Infinity;
        const seen = new Set<number>();
        const u0 = Math.min(ua, ub), u1 = Math.max(ua, ub), v0 = Math.min(va, vb), v1 = Math.max(va, vb);
        for (let cu = Math.floor(u0 / this.cell); cu <= Math.floor(u1 / this.cell); cu++) {
            for (let cv = Math.floor(v0 / this.cell); cv <= Math.floor(v1 / this.cell); cv++) {
                for (const i of this.cells.get(cellKey(cu, cv)) ?? []) {
                    if (seen.has(i)) {
                        continue;
                    }
                    seen.add(i);
                    const s = this.segs[i];
                    const du = s.b.u - s.a.u, dv = s.b.v - s.a.v;
                    const len = Math.hypot(du, dv);
                    if (len < 1e-6) {
                        continue;
                    }
                    const nu = -dv / len, nv = du / len;
                    const edge = s.half + SHOULDER_M;
                    const toe = (p: Sample) => edge + Math.min(s.reach, Math.abs(p.h - p.land) / BATTER);
                    const open = edge + s.reach, shut = open + BATTER_FADE_M;
                    for (const side of [1, -1]) {
                        for (const [dA, dB] of [[edge, edge], [toe(s.a), toe(s.b)], [open, open], [shut, shut]]) {
                            // The crease from P to Q, and the edge, as lines: where they meet.
                            const pu = s.a.u + nu * dA * side, pv = s.a.v + nv * dA * side;
                            const qu = s.b.u + nu * dB * side - pu, qv = s.b.v + nv * dB * side - pv;
                            const den = eu * qv - ev * qu;
                            if (Math.abs(den) < 1e-9) {
                                continue;
                            }
                            const t = ((pu - ua) * qv - (pv - va) * qu) / den;
                            const k = ((pu - ua) * ev - (pv - va) * eu) / den;
                            if (k < 0 || k > 1 || t < CREASE_SPLIT_RANGE || t > 1 - CREASE_SPLIT_RANGE) {
                                continue;
                            }
                            if (Math.abs(t - 0.5) < bestOff) {
                                bestOff = Math.abs(t - 0.5);
                                best = t;
                            }
                        }
                    }
                }
            }
        }
        return best;
    }

    /** The highest-priority tier (lowest index) among the beds reaching into the plan box; Infinity if none. */
    topTierNear(u0: number, v0: number, u1: number, v1: number): number {
        let top = Infinity;
        for (let cu = Math.floor(u0 / this.cell); cu <= Math.floor(u1 / this.cell); cu++) {
            for (let cv = Math.floor(v0 / this.cell); cv <= Math.floor(v1 / this.cell); cv++) {
                for (const i of this.cells.get(cellKey(cu, cv)) ?? []) {
                    top = Math.min(top, this.segs[i].tier);
                }
            }
        }
        return top;
    }

    /**
     * Whether (u, v) is on a line's carriageway (or track) or within `clear`
     * of its edge: its half width from the centreline. Past an open end
     * nothing is.
     */
    onCarriageway(u: number, v: number, clear: number): boolean {
        for (const i of this.cells.get(cellKey(Math.floor(u / this.cell), Math.floor(v / this.cell))) ?? []) {
            const s = this.segs[i];
            const du = s.b.u - s.a.u, dv = s.b.v - s.a.v;
            const t = bedSegmentParam(u - s.a.u, v - s.a.v, du, dv, s.open);
            if (t !== undefined && Math.hypot(u - s.a.u - du * t, v - s.a.v - dv * t) < s.half + clear) {
                return true;
            }
        }
        return false;
    }

    /** Whether any bed reaches into the plan box. */
    anyNear(u0: number, v0: number, u1: number, v1: number): boolean {
        for (let cu = Math.floor(u0 / this.cell); cu <= Math.floor(u1 / this.cell); cu++) {
            for (let cv = Math.floor(v0 / this.cell); cv <= Math.floor(v1 / this.cell); cv++) {
                if (this.cells.has(cellKey(cu, cv))) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * The ground height `h` brought within every bed's reach: on a bed, its
     * design height; beside it, no farther off that than the batter allows.
     * Each bed bounds the ground to a band that widens 1:2 from its
     * shoulder, and the ground is clamped into the bands' overlap, which -
     * unlike the nearest bed's band - is continuous where tracks of
     * different profiles run side by side, so the land has no step to chase
     * between them. Where the bands miss each other, the middle of the gap.
     */
    target(u: number, v: number, h: number, resolver: BandResolver): number {
        this.gather(u, v, resolver);
        return resolver.resolve(h);
    }

    /** The height of the highest-priority bed whose own surface (not batter) covers (u, v), if any. */
    coreAt(u: number, v: number, resolver: BandResolver): number | undefined {
        this.gather(u, v, resolver);
        const h = resolver.resolve(0);
        return resolver.core ? h : undefined;
    }

    private gather(u: number, v: number, resolver: BandResolver): void {
        resolver.reset();
        const list = this.cells.get(cellKey(Math.floor(u / this.cell), Math.floor(v / this.cell)));
        if (!list) {
            return;
        }
        for (const i of list) {
            const s = this.segs[i];
            const du = s.b.u - s.a.u, dv = s.b.v - s.a.v;
            const t = bedSegmentParam(u - s.a.u, v - s.a.v, du, dv, s.open);
            if (t === undefined || (s.cut && beyondCut(s.cut, u, v))) {
                continue;
            }
            const excess = Math.max(0, Math.hypot(u - s.a.u - du * t, v - s.a.v - dv * t) - s.half - SHOULDER_M);
            if (excess > s.reach + BATTER_FADE_M) {
                continue;
            }
            resolver.add(s.tier, s.a.h + (s.b.h - s.a.h) * t, excess, s.reach);
        }
    }
}

/**
 * Who wins the ground where beds of different priority reach the same
 * point (bedRank, 0 highest: railways and Autobahns are peers). On a bed's own surface (no excess past its
 * shoulder) that bed's height, the highest-priority surface if several: a
 * line is never buried by another's batter - where a lower line's surface
 * meets a higher one's batter, the face between them is steep and gets a
 * retaining wall. Beside the beds, each tier bounds the ground to its
 * batters' band, and the bands are applied lowest priority first, each a
 * clamp, so a higher tier's has the last word and the result stays
 * continuous. Within a rank, the bands' overlap, or the middle of the gap.
 */
export class BandResolver {
    private readonly lo = new Float64Array(BED_TIER_COUNT);
    private readonly hi = new Float64Array(BED_TIER_COUNT);
    private readonly coreLo = new Float64Array(BED_TIER_COUNT);
    private readonly coreHi = new Float64Array(BED_TIER_COUNT);
    private any = false;
    /** After resolve: whether the answer was a bed's own surface. */
    core = false;

    reset(): void {
        this.lo.fill(-Infinity);
        this.hi.fill(Infinity);
        this.coreLo.fill(-Infinity);
        this.coreHi.fill(Infinity);
        this.any = false;
        this.core = false;
    }

    /**
     * A bed at `bed`, `excess` metres past its shoulder, its batter reaching
     * `reach` (Infinity: all the way). Past the reach the band does not stop
     * dead - a step the refinement would chase wherever the ground is off -
     * but opens out steeply over BATTER_FADE_M; callers skip it past that.
     */
    add(tier: number, bed: number, excess: number, reach = Infinity): void {
        const t = bedRank(Math.min(BED_TIER_COUNT - 1, Math.max(0, tier)));
        this.any = true;
        const half = excess <= reach ? excess * BATTER : reach * BATTER + (excess - reach) * BATTER_FADE_SLOPE;
        this.lo[t] = Math.max(this.lo[t], bed - half);
        this.hi[t] = Math.min(this.hi[t], bed + half);
        if (excess <= 0) {
            this.coreLo[t] = Math.max(this.coreLo[t], bed);
            this.coreHi[t] = Math.min(this.coreHi[t], bed);
        }
    }

    resolve(h: number): number {
        this.core = false;
        if (!this.any) {
            return h;
        }
        for (let t = 0; t < BED_TIER_COUNT; t++) {
            if (this.coreLo[t] !== -Infinity) {
                this.core = true;
                // coreLo is the highest surface here, coreHi the lowest.
                const top = this.coreLo[t], bottom = this.coreHi[t];
                if (top - bottom > CORE_SEPARATED_M) {
                    // Two of a tier's surfaces this far apart at one point
                    // cross one above the other (a bridge's approach over a
                    // street beneath it): the land is the one it is nearer.
                    return Math.abs(h - top) < Math.abs(h - bottom) ? top : bottom;
                }
                return (top + bottom) / 2;
            }
        }
        let out = h;
        for (let t = BED_TIER_COUNT - 1; t >= 0; t--) {
            const lo = this.lo[t], hi = this.hi[t];
            if (lo === -Infinity) {
                continue;
            }
            out = lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, out));
        }
        return out;
    }
}

/** Heights given to the stroke points already graded, found again by plan position: junctions, at-grade crossings. */
/** Interior points of a profile line (s, h) Douglas-Peucker keeps at `tol`: where the straight stroke strays from it. */
function simplifyProfile(line: ReadonlyArray<{ s: number; h: number }>, tol: number): number[] {
    const out: number[] = [];
    const walk = (i0: number, i1: number) => {
        let worst = -1, far = tol;
        for (let j = i0 + 1; j < i1; j++) {
            const f = (line[j].s - line[i0].s) / (line[i1].s - line[i0].s);
            const d = Math.abs(line[j].h - (line[i0].h + (line[i1].h - line[i0].h) * f));
            if (d > far) {
                far = d;
                worst = j;
            }
        }
        if (worst >= 0) {
            walk(i0, worst);
            out.push(worst);
            walk(worst, i1);
        }
    };
    walk(0, line.length - 1);
    return out;
}

/**
 * The strokes with vertex pairs added inside segments (`inserts`, keyed by
 * a segment's first pair): the input's vertices first, in order, so their
 * indices hold; each new pair in the plan and at the surface height given,
 * the stroke's lift over it, its offset, width, distance along and track
 * flags taken between the segment's ends. Past the u16 index range no more
 * go in.
 */
function insertStrokeVertices(
    strokes: PtrTile, positions: Int16Array,
    inserts: ReadonlyMap<number, { b: number; at: ReadonlyArray<{ t: number; u: number; v: number; h: number }> }>,
    frame: PlanFrame, liftM: number,
): Pick<PtrTile, 'positions' | 'directions' | 'halfWidths' | 'along' | 'flags' | 'indices'> {
    const n0 = positions.length / 3;
    let added = 0;
    for (const { at } of inserts.values()) {
        added += at.length * 2;
    }
    added = Math.min(added, 65536 - n0);
    const total = n0 + Math.max(0, added);
    const pos = new Int16Array(total * 3);
    pos.set(positions);
    const dir = new Int8Array(total * 4);
    dir.set(strokes.directions);
    const half = new Uint16Array(total);
    half.set(strokes.halfWidths);
    const along = new Uint16Array(total);
    along.set(strokes.along);
    const flags = new Uint8Array(total);
    flags.set(strokes.flags);
    const q = strokes.quantScale;
    const { a: fa, b: fb, up } = frame;
    let next = n0;
    // The pairs that go into each segment, in order.
    const chainOf = new Map<number, number[]>();
    for (const [va, { b: vb, at }] of inserts) {
        const mids: number[] = [];
        for (const p of at) {
            if (next + 2 > total) {
                break;
            }
            const drawn = p.h + liftM;
            const x = p.u * fa[0] + p.v * fb[0] + drawn * up[0];
            const y = p.u * fa[1] + p.v * fb[1] + drawn * up[1];
            const z = p.u * fa[2] + p.v * fb[2] + drawn * up[2];
            for (let side = 0; side < 2; side++) {
                const m = next + side, ia = va + side, ib = vb + side;
                pos[m * 3] = clampI16(x / q);
                pos[m * 3 + 1] = clampI16(y / q);
                pos[m * 3 + 2] = clampI16(z / q);
                const d = [0, 1, 2].map(c => strokes.directions[ia * 4 + c] * (1 - p.t) + strokes.directions[ib * 4 + c] * p.t);
                const len = Math.hypot(d[0], d[1], d[2]) || 1;
                for (let c = 0; c < 3; c++) {
                    dir[m * 4 + c] = Math.round((d[c] / len) * 127);
                }
                dir[m * 4 + 3] = strokes.directions[ia * 4 + 3];
                half[m] = Math.round(strokes.halfWidths[ia] * (1 - p.t) + strokes.halfWidths[ib] * p.t);
                const run = (strokes.along[ib] - strokes.along[ia] + 65536) % 65536;
                along[m] = (strokes.along[ia] + Math.round(run * p.t)) % 65536;
                flags[m] = strokes.flags[ia] & strokes.flags[ib];
            }
            mids.push(next);
            next += 2;
        }
        if (mids.length > 0) {
            chainOf.set(va, mids);
        }
    }
    const src = strokes.indices;
    let count = 0;
    for (let i = 0; i + 5 < src.length; i += 6) {
        count += 6 * (1 + (chainOf.get(src[i])?.length ?? 0));
    }
    const idx = new Uint16Array(count + (src.length % 6));
    let o = 0;
    for (let i = 0; i + 5 < src.length; i += 6) {
        const a = src[i], b = src[i + 5];
        const mids = chainOf.get(a);
        // Only the usual quad (a, a+1, b+1, a, b+1, b) is split.
        if (!mids || src[i + 1] !== a + 1 || src[i + 2] !== b + 1 || src[i + 3] !== a || src[i + 4] !== b + 1) {
            for (let k = 0; k < 6; k++) {
                idx[o++] = src[i + k];
            }
            continue;
        }
        const seq = [a, ...mids, b];
        for (let k = 0; k + 1 < seq.length; k++) {
            const x = seq[k], y = seq[k + 1];
            idx.set([x, x + 1, y + 1, x, y + 1, y], o);
            o += 6;
        }
    }
    for (let i = src.length - (src.length % 6); i < src.length; i++) {
        idx[o++] = src[i];
    }
    return { positions: pos, directions: dir, halfWidths: half, along, flags, indices: idx.subarray(0, o) };
}

class HeldPoints {
    private readonly cells = new Map<number, number[]>();

    /** A point's plan position, the height it was given, and the height it was drawn at. */
    add(u: number, v: number, h: number, drawn: number): void {
        const key = cellKey(Math.floor(u / HELD_CELL_M), Math.floor(v / HELD_CELL_M));
        const list = this.cells.get(key);
        if (list) {
            list.push(u, v, h, drawn);
        } else {
            this.cells.set(key, [u, v, h, drawn]);
        }
    }

    /**
     * The height given to a point graded before at (u, v), when the two were
     * drawn at about the same height: one drawn far above the other is a
     * grade-separated crossing (an overpass with no deck baked), not a
     * junction.
     */
    at(u: number, v: number, drawn: number): number | undefined {
        const cu = Math.floor(u / HELD_CELL_M), cv = Math.floor(v / HELD_CELL_M);
        let best: number | undefined;
        let bestD = HELD_SNAP_M;
        for (let du = -1; du <= 1; du++) {
            for (let dv = -1; dv <= 1; dv++) {
                const list = this.cells.get(cellKey(cu + du, cv + dv));
                for (let i = 0; list && i < list.length; i += 4) {
                    const d = Math.hypot(list[i] - u, list[i + 1] - v);
                    if (d < bestD && Math.abs(list[i + 3] - drawn) <= HELD_DRAWN_M) {
                        bestD = d;
                        best = list[i + 2];
                    }
                }
            }
        }
        return best;
    }
}

/** How far the collapse may move the land off its refined surface (SoupMesh.collapseFlat), metres. */
interface CollapseLimits {
    limit: number;
    /** ... down, where `near(u, v)` or `under(u, v)`. */
    nearDown: number;
    near: (u: number, v: number) => boolean;
    /** Where the land may not rise at all: under a deck, which the refinement kept it clear of. */
    under: (u: number, v: number) => boolean;
}

interface Tri {
    /** Position ids of the three corners. */
    c: [number, number, number];
    /** Soup vertex each corner takes its normal and attributes from. */
    s: [number, number, number];
    alive: boolean;
    /**
     * The soup triangle whose slot this one is written to, or -1 for a piece
     * written after them. A triangle with a border vertex hands its slot to
     * the half that keeps its border vertices, at the same corners, so the
     * seam stitcher's soup indices still find them.
     */
    orig: number;
    /** Touched by a split or a move: written from its corners, normal recomputed. */
    dirty: boolean;
    /** Too steep to stand as a slope: a retaining wall goes in front of it (see SoupMesh.markWalls). */
    wall?: boolean;
}

/** The soup as shared positions and triangles, for conforming bisection. */
class SoupMesh {
    /** Plan coordinates (u, v, h) per position id. */
    readonly pos: number[] = [];
    readonly tris: Tri[] = [];
    added = 0;
    private readonly edges = new Map<string, number[]>();
    private readonly mids = new Map<string, number>();
    /** Scratch for the crease points needsSplit checks. */
    private readonly probe: number[] = [];
    /** Positions on the tile's border (the stitcher's): never moved, never split between. */
    private readonly borderPos = new Set<number>();
    /** Quantised position of each input position id, written back untouched while it has not moved. */
    private readonly quantised: number[] = [];
    private readonly moved = new Set<number>();
    /** The height a moved position had before the earthworks. */
    private readonly before = new Map<number, number>();
    /**
     * Where along an edge (plan ends) to split it, as a fraction: on a bed's
     * crease where one crosses it (BedIndex.creaseCrossing), so one vertex
     * lands on the crease instead of halving after it. The middle when absent.
     */
    splitAt?: (ua: number, va: number, ub: number, vb: number) => number | undefined;
    /**
     * Where a vertex made after the land moved goes, from the land's height
     * there before (u, v, h): the earthworks' target, as every vertex moved
     * to. Absent, it lies on the edge it splits - which, between a deep
     * cutting's edge and land kept as baked, tilted a lake's shore 1.5 m down.
     */
    placeNew?: (u: number, v: number, h: number) => number;

    constructor(
        private readonly land: LandSoup, private readonly q: number,
        private readonly frame: PlanFrame, borderVerts: ReadonlySet<number>, private readonly triCount: number,
        private readonly dims: Dims,
    ) {
        const ids = new Map<string, number>();
        const P = land.positions;
        for (let t = 0; t < triCount; t++) {
            const c: number[] = [];
            for (let k = 0; k < 3; k++) {
                const vi = t * 3 + k;
                const key = `${P[vi * 3]},${P[vi * 3 + 1]},${P[vi * 3 + 2]}`;
                let id = ids.get(key);
                if (id === undefined) {
                    id = this.pos.length / 3;
                    const p = frame.toPlan([P[vi * 3] * q, P[vi * 3 + 1] * q, P[vi * 3 + 2] * q]);
                    this.pos.push(p[0], p[1], p[2]);
                    this.quantised.push(P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2]);
                    ids.set(key, id);
                }
                c.push(id);
                if (borderVerts.has(vi)) {
                    this.borderPos.add(id);
                }
            }
            this.tris.push({
                c: c as [number, number, number], s: [t * 3, t * 3 + 1, t * 3 + 2],
                alive: true, orig: t, dirty: false,
            });
            this.link(t);
        }
    }

    private edgeKey(a: number, b: number): string {
        return a < b ? `${a}_${b}` : `${b}_${a}`;
    }

    private link(t: number): void {
        const c = this.tris[t].c;
        for (let k = 0; k < 3; k++) {
            const key = this.edgeKey(c[k], c[(k + 1) % 3]);
            const list = this.edges.get(key);
            if (list) {
                list.push(t);
            } else {
                this.edges.set(key, [t]);
            }
        }
    }

    private unlink(t: number): void {
        const c = this.tris[t].c;
        for (let k = 0; k < 3; k++) {
            const key = this.edgeKey(c[k], c[(k + 1) % 3]);
            const list = this.edges.get(key);
            if (list) {
                const i = list.indexOf(t);
                if (i >= 0) {
                    list.splice(i, 1);
                }
            }
        }
    }

    private edgeLength(a: number, b: number): number {
        return Math.hypot(this.pos[a * 3] - this.pos[b * 3], this.pos[a * 3 + 1] - this.pos[b * 3 + 1]);
    }

    longestEdge(t: number): { k: number; len: number } {
        const c = this.tris[t].c;
        let best = { k: 0, len: -1 };
        for (let k = 0; k < 3; k++) {
            const len = this.edgeLength(c[k], c[(k + 1) % 3]);
            if (len > best.len) {
                best = { k, len };
            }
        }
        return best;
    }

    /**
     * The edge `t` is bisected along: its longest, except that an edge
     * between two border positions is never split - a vertex there would be
     * off the seam stitcher's table. Undefined when only such edges remain.
     */
    private splitEdge(t: number): { a: number; b: number } | undefined {
        const c = this.tris[t].c;
        let best: { a: number; b: number } | undefined;
        let bestLen = -1;
        for (let k = 0; k < 3; k++) {
            const a = c[k], b = c[(k + 1) % 3];
            if (this.borderPos.has(a) && this.borderPos.has(b)) {
                continue;
            }
            const len = this.edgeLength(a, b);
            if (len > bestLen) {
                best = { a, b };
                bestLen = len;
            }
        }
        return best;
    }

    /**
     * Whether `t` must be split to follow the bed: some point of it would
     * land more than the tile tolerance off its target if only its corners
     * moved. Error-driven rather than a fixed edge length, so the
     * refinement goes into the bed's creases (its edges, the batter toes)
     * and where the bed really leaves the ground, not into every triangle
     * the track passes. Checked at the beds' creases inside it as well as
     * on its own grid (see BedIndex.creases).
     */
    needsSplit(t: number, target: (u: number, v: number, h: number) => number, beds: BedIndex, decks?: RoadDeckIndex): boolean {
        const c = this.tris[t].c;
        const P = c.map(id => [this.pos[id * 3], this.pos[id * 3 + 1], this.pos[id * 3 + 2]]);
        const longest = this.longestEdge(t).len;
        if (longest <= this.dims.refineMinEdge) {
            return false;
        }
        const u0 = Math.min(P[0][0], P[1][0], P[2][0]), u1 = Math.max(P[0][0], P[1][0], P[2][0]);
        const v0 = Math.min(P[0][1], P[1][1], P[2][1]), v1 = Math.max(P[0][1], P[1][1], P[2][1]);
        if (!beds.anyNear(u0, v0, u1, v1)) {
            return false;
        }
        const d = P.map(([u, v, h]) => target(u, v, h) - h);
        // Only streets near: a looser fit, their strokes float as high over
        // the land as this anyway.
        const tolerance = beds.topTierNear(u0, v0, u1, v1) >= STREET_TIER
            ? Math.max(this.dims.tolerance, STREET_FIT_TOLERANCE_M) : this.dims.tolerance;
        const off = (u: number, v: number, h: number, fit: number) => Math.abs(target(u, v, h) - h - fit) > tolerance;
        // The beds' own creases inside the triangle first, and the decks'
        // footprints: a deck lying flush with the ground is narrower than
        // the grid, and land spanning it with no vertex under it buried it.
        beds.creases(u0, v0, u1, v1, this.probe);
        const crease = this.probe.length;
        decks?.probes(u0, v0, u1, v1, this.probe);
        const det = (P[1][1] - P[2][1]) * (P[0][0] - P[2][0]) + (P[2][0] - P[1][0]) * (P[0][1] - P[2][1]);
        if (Math.abs(det) > 1e-9) {
            for (let i = 0; i < this.probe.length; i += 2) {
                const u = this.probe[i], v = this.probe[i + 1];
                const l0 = ((P[1][1] - P[2][1]) * (u - P[2][0]) + (P[2][0] - P[1][0]) * (v - P[2][1])) / det;
                const l1 = ((P[2][1] - P[0][1]) * (u - P[2][0]) + (P[0][0] - P[2][0]) * (v - P[2][1])) / det;
                const l2 = 1 - l0 - l1;
                if (l0 < 0 || l1 < 0 || l2 < 0) {
                    continue;
                }
                const h = l0 * P[0][2] + l1 * P[1][2] + l2 * P[2][2], fit = l0 * d[0] + l1 * d[1] + l2 * d[2];
                if (off(u, v, h, fit)) {
                    return true;
                }
                // Under a deck the land must come out below it, which the
                // fit's tolerance does not see: a deck flush with the ground
                // is a few centimetres under it.
                if (i >= crease && h + fit > decks!.top(u, v)! - DECK_FIT_M) {
                    return true;
                }
            }
        }
        // The beds' creases are checked above; the grid only catches what
        // lies between them, and is the dearest part of the refinement.
        const n = Math.min(FIT_GRID_MAX, Math.ceil(longest / this.dims.sample));
        for (let i = 0; i <= n; i++) {
            for (let j = 0; i + j <= n; j++) {
                const a = i / n, b = j / n, w = 1 - a - b;
                const u = P[0][0] * w + P[1][0] * a + P[2][0] * b;
                const v = P[0][1] * w + P[1][1] * a + P[2][1] * b;
                const h = P[0][2] * w + P[1][2] * a + P[2][2] * b;
                if (off(u, v, h, d[0] * w + d[1] * a + d[2] * b)) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Whether `t` has (next to) no area in plan: one of the bake's vertical
     * walls. Bisecting one makes walls again, the same edges over and over;
     * a wall is only split along an edge a real neighbour is split along.
     */
    private isWall(t: number): boolean {
        const [a, b, c] = this.tris[t].c;
        const p = this.pos;
        const area = (p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) - (p[c * 3] - p[a * 3]) * (p[b * 3 + 1] - p[a * 3 + 1]);
        return Math.abs(area) < WALL_PLAN_AREA_M2 * 2;
    }

    /** Conforming bisection of `t` (see splitEdge); returns the triangles made. */
    refine(t: number, depth = 0): number[] {
        const made: number[] = [];
        if (depth > 40 || this.isWall(t)) {
            return made;
        }
        for (let guard = 0; guard < 8 && this.tris[t].alive; guard++) {
            const e = this.splitEdge(t);
            if (!e) {
                return made;
            }
            const { a, b } = e;
            const across = (this.edges.get(this.edgeKey(a, b)) ?? []).filter(o => o !== t && this.tris[o].alive);
            // Land-use fills stack on shared edges: all of them split at
            // the one midpoint, or a fill over a cutting stayed whole and
            // covered it.
            if (across.length > 1) {
                made.push(...this.bisect(t, a, b));
                for (const o of across) {
                    made.push(...this.bisect(o, a, b));
                }
                return made;
            }
            if (across.length === 0) {
                made.push(...this.bisect(t, a, b));
                return made;
            }
            const n = across[0];
            const ne = this.splitEdge(n);
            if (this.isWall(n) || (ne && ((ne.a === a && ne.b === b) || (ne.a === b && ne.b === a)))) {
                made.push(...this.bisect(t, a, b), ...this.bisect(n, a, b));
                return made;
            }
            // The neighbour's own split edge first, then try again.
            const sub = this.refine(n, depth + 1);
            if (sub.length === 0) {
                // Blocked further along: both split along this edge instead.
                made.push(...this.bisect(t, a, b), ...this.bisect(n, a, b));
                return made;
            }
            made.push(...sub);
        }
        return made;
    }

    /**
     * Splits `t` at the middle of (a, b). Each half is the parent with one
     * of a and b swapped for the midpoint, corner order kept, so the winding
     * and the corners' places stay as they were.
     */
    private bisect(t: number, a: number, b: number): number[] {
        const tri = this.tris[t];
        const key = this.edgeKey(a, b);
        let m = this.mids.get(key);
        if (m === undefined) {
            m = this.pos.length / 3;
            // From the lower id, so both triangles on the edge get the one point.
            const [lo, hi] = a < b ? [a, b] : [b, a];
            const P = this.pos;
            const f = this.splitAt?.(P[lo * 3], P[lo * 3 + 1], P[hi * 3], P[hi * 3 + 1]) ?? 0.5;
            const u = P[lo * 3] + (P[hi * 3] - P[lo * 3]) * f, v = P[lo * 3 + 1] + (P[hi * 3 + 1] - P[lo * 3 + 1]) * f;
            let h = P[lo * 3 + 2] + (P[hi * 3 + 2] - P[lo * 3 + 2]) * f;
            if (this.placeNew) {
                // Split after the land moved: the land as it was there, then
                // where the earthworks put it.
                const ha = this.before.get(lo) ?? P[lo * 3 + 2], hb = this.before.get(hi) ?? P[hi * 3 + 2];
                const was = ha + (hb - ha) * f;
                h = this.placeNew(u, v, was);
                if (Math.abs(h - was) > 1e-9) {
                    this.before.set(m, was);
                    this.moved.add(m);
                }
            }
            this.pos.push(u, v, h);
            this.mids.set(key, m);
        }
        const ka = tri.c.indexOf(a), kb = tri.c.indexOf(b);
        const half = (replaced: number): Tri => {
            const c = [...tri.c] as [number, number, number];
            const s = [...tri.s] as [number, number, number];
            c[replaced] = m!;
            // The midpoint takes its attributes from a.
            s[replaced] = tri.s[ka];
            return { c, s, alive: true, orig: -1, dirty: true };
        };
        const kids = [half(kb), half(ka)];
        // A triangle in its original slot with border vertices passes the
        // slot to the half that has them all (an edge between two border
        // positions is never the one split, so one half does).
        if (tri.orig >= 0) {
            const border = tri.c.filter(id => this.borderPos.has(id));
            const heir = border.length > 0 ? kids.find(k => border.every(id => k.c.includes(id))) : undefined;
            if (heir) {
                heir.orig = tri.orig;
            }
        }
        this.unlink(t);
        tri.alive = false;
        const out: number[] = [];
        for (const kid of kids) {
            const id = this.tris.length;
            this.tris.push(kid);
            this.link(id);
            out.push(id);
        }
        this.added += 1;
        return out;
    }

    /** Every movable position onto its target; returns how many moved. */
    displace(
        target: (u: number, v: number, h: number) => number,
        /** What a vertex of long triangles is moved to instead (see LONG_EDGE_M). */
        longTarget: (u: number, v: number, h: number) => number = target,
        /** Whether a border vertex at (u, v) may move (BorderIndex.movable); none when absent. */
        borderMovable?: (u: number, v: number) => boolean,
    ): number {
        const used = new Uint8Array(this.pos.length / 3);
        // The longest edge each position is a corner of.
        const reach = new Float64Array(this.pos.length / 3);
        for (let t = 0; t < this.tris.length; t++) {
            const tri = this.tris[t];
            if (tri.alive) {
                const len = this.longestEdge(t).len;
                for (const id of tri.c) {
                    used[id] = 1;
                    reach[id] = Math.max(reach[id], len);
                }
            }
        }
        for (let id = 0; id < used.length; id++) {
            if (!used[id] || (this.borderPos.has(id) && !borderMovable?.(this.pos[id * 3], this.pos[id * 3 + 1]))) {
                continue;
            }
            const h = this.pos[id * 3 + 2];
            const t = (reach[id] > LONG_EDGE_M ? longTarget : target)(this.pos[id * 3], this.pos[id * 3 + 1], h);
            if (Math.abs(t - h) > 0.01) {
                this.pos[id * 3 + 2] = t;
                this.moved.add(id);
                this.before.set(id, h);
            }
        }
        for (const tri of this.tris) {
            if (tri.alive && (this.moved.has(tri.c[0]) || this.moved.has(tri.c[1]) || this.moved.has(tri.c[2]))) {
                tri.dirty = true;
            }
        }
        return this.moved.size;
    }

    /**
     * No land over a road or a railway: every vertex on a carriageway above
     * its road's surface (RoadCap) is lowered to it, and - where `split` -
     * a triangle whose surface still rises over a road between its corners
     * is split there (its new corners lowered at once) until it is clear or
     * down to the least edge. Border vertices stay, as the seam table has
     * them. Returns the vertices lowered and the triangles split.
     */
    keepUnderRoads(roads: RoadCap, split: boolean, maxNew: number): { lowered: number; split: number } {
        const probe: number[] = [];
        let lowered = 0, splits = 0;
        const lower = (id: number): void => {
            if (this.borderPos.has(id)) {
                return;
            }
            // The carriageway and its shoulder, which the bed holds at the
            // road's height too: with only the carriageway, a corner just past
            // its edge on a cutting's side held the land up over the edge.
            const c = roads.cap(this.pos[id * 3], this.pos[id * 3 + 1], SHOULDER_M);
            if (c !== undefined && this.pos[id * 3 + 2] > c) {
                if (!this.before.has(id)) {
                    this.before.set(id, this.pos[id * 3 + 2]);
                }
                // Down onto the road's bed, where the grading meant it: just
                // under the drawn road, a corner split between an embankment
                // and a street beside it stood half a metre up the street.
                this.pos[id * 3 + 2] = Math.min(c, roads.bed(this.pos[id * 3], this.pos[id * 3 + 1], SHOULDER_M) ?? c);
                this.moved.add(id);
                lowered++;
            }
        };
        for (let id = 0; id < this.pos.length / 3; id++) {
            lower(id);
        }
        if (split) {
            const queue: number[] = [];
            for (let t = 0; t < this.tris.length; t++) {
                if (this.tris[t].alive) {
                    queue.push(t);
                }
            }
            while (queue.length > 0 && this.added < maxNew) {
                const t = queue.pop()!;
                if (!this.tris[t].alive || this.isWall(t) || this.longestEdge(t).len <= this.dims.minEdge
                    || !this.overRoad(t, roads, probe)) {
                    continue;
                }
                const made = this.refine(t);
                if (made.length > 0) {
                    splits++;
                }
                for (const m of made) {
                    for (const id of this.tris[m].c) {
                        lower(id);
                    }
                    queue.push(m);
                }
            }
        }
        for (const tri of this.tris) {
            if (tri.alive && tri.c.some(id => this.moved.has(id))) {
                tri.dirty = true;
            }
        }
        return { lowered, split: splits };
    }

    /** Whether triangle `t`'s surface rises over a road anywhere inside it (RoadCap.probes), past ROAD_CAP_EPS_M. */
    private overRoad(t: number | readonly number[], roads: RoadCap, probe: number[]): boolean {
        const c = typeof t === 'number' ? this.tris[t].c : t;
        const p = this.pos;
        const u0 = Math.min(p[c[0] * 3], p[c[1] * 3], p[c[2] * 3]), u1 = Math.max(p[c[0] * 3], p[c[1] * 3], p[c[2] * 3]);
        const v0 = Math.min(p[c[0] * 3 + 1], p[c[1] * 3 + 1], p[c[2] * 3 + 1]), v1 = Math.max(p[c[0] * 3 + 1], p[c[1] * 3 + 1], p[c[2] * 3 + 1]);
        roads.probes(u0, v0, u1, v1, probe, [p[c[0] * 3], p[c[0] * 3 + 1], p[c[1] * 3], p[c[1] * 3 + 1], p[c[2] * 3], p[c[2] * 3 + 1]]);
        for (let i = 0; i < probe.length; i += 2) {
            const w = this.bary(c, probe[i], probe[i + 1]);
            if (!w) {
                continue;
            }
            const h = w[0] * p[c[0] * 3 + 2] + w[1] * p[c[1] * 3 + 2] + w[2] * p[c[2] * 3 + 2];
            const cap = roads.cap(probe[i], probe[i + 1]);
            if (cap !== undefined && h > cap + ROAD_CAP_EPS_M) {
                return true;
            }
        }
        return false;
    }

    /**
     * Spikes taken down: a vertex over every neighbour round it, steeper
     * than `slope` (rise over run) over any, comes down until it stands no
     * steeper over any - never below the highest of them. Limited by the
     * gentlest neighbour instead, a needle 5 m over a neighbour 0.2 m off
     * and another 1.9 m off kept 2.8 m of it. Only where the earthworks
     * moved it or a neighbour; never one on the border. A line's bed is never one - a vertex on it has a
     * neighbour along it at its height - and a line over a spike already
     * floats over the land each side of it: kept for the track on it, the
     * spikes under a siding 4.5 m over the yard beside it stood on. A spike
     * lowered may leave its neighbour one; up to DESPIKE_PASSES rounds. The
     * number lowered.
     */
    despike(slope: number): number {
        const near = new Map<number, Set<number>>();
        for (const tri of this.tris) {
            if (!tri.alive) {
                continue;
            }
            for (const a of tri.c) {
                for (const b of tri.c) {
                    if (a !== b) {
                        (near.get(a) ?? near.set(a, new Set()).get(a)!).add(b);
                    }
                }
            }
        }
        const p = this.pos;
        let lowered = 0;
        for (let pass = 0; pass < DESPIKE_PASSES; pass++) {
            let changed = 0;
            for (const [id, ns] of near) {
                // Only where the earthworks moved it or the land round it: a
                // coarse tile's peaks in the Wetterstein stood that steep.
                if (this.borderPos.has(id) || (!this.moved.has(id) && ![...ns].some(n => this.moved.has(n)))) {
                    continue;
                }
                const u = p[id * 3], v = p[id * 3 + 1], h = p[id * 3 + 2];
                let highest = -Infinity, limit = Infinity;
                for (const n of ns) {
                    const d = Math.hypot(p[n * 3] - u, p[n * 3 + 1] - v);
                    highest = Math.max(highest, p[n * 3 + 2]);
                    // A neighbour straight under it (a skirt's foot) says nothing of the slope.
                    if (d >= DESPIKE_MIN_RUN_M) {
                        limit = Math.min(limit, p[n * 3 + 2] + slope * d);
                    }
                }
                limit = Math.max(limit, highest);
                if (h > limit + DESPIKE_SLACK_M) {
                    if (!this.before.has(id)) {
                        this.before.set(id, h);
                    }
                    p[id * 3 + 2] = limit;
                    this.moved.add(id);
                    changed++;
                }
            }
            lowered += changed;
            if (changed === 0) {
                break;
            }
        }
        if (lowered > 0) {
            for (const tri of this.tris) {
                if (tri.alive && tri.c.some(id => this.moved.has(id))) {
                    tri.dirty = true;
                }
            }
        }
        return lowered;
    }

    /** How many triangles the soup gains over its baked slots: the pieces toSoup appends. */
    pieceCount(): number {
        let n = 0;
        for (const t of this.tris) {
            if (t.alive && t.orig < 0) {
                n++;
            }
        }
        return n;
    }

    /**
     * Takes back what the refinement split for nothing. Bisection follows a
     * bed's creases at whatever angle they cross the baked facets, and leaves
     * fans of triangles on what came out flat or nearly: the top of a bed, a
     * straight batter, a gentle bend. Each of the refinement's own vertices
     * (never one the bake made) is collapsed into a neighbour where the
     * surface stays within `limits` of the refined one, no triangle turns
     * over or goes thin in plan, and the vertex is inside one surface -
     * every edge round it is shared by exactly two triangles - so a land-use
     * fill's outline, an edge stacked under a fill, and the border stay.
     *
     * A land-use fill lies over the ground as triangles of its own, cut
     * apart from the ground's and refined apart; simplified apart, the two
     * would cross and the ground show through the fill. No collapse brings
     * one layer nearer another than LAYER_GAP_M (or than it was). Both tests
     * are exact (CollapseChecks). Returns the triangles removed.
     */
    collapseFlat(limits: CollapseLimits, roads?: RoadCap): number {
        const firstMid = this.quantised.length / 3;
        const ring = new Map<number, Set<number>>();
        for (let t = 0; t < this.tris.length; t++) {
            if (!this.tris[t].alive) {
                continue;
            }
            for (const id of this.tris[t].c) {
                let s = ring.get(id);
                if (!s) {
                    ring.set(id, s = new Set());
                }
                s.add(t);
            }
        }
        const p = this.pos;
        const area = (a: number, b: number, c: number) =>
            (p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) - (p[c * 3] - p[a * 3]) * (p[b * 3 + 1] - p[a * 3 + 1]);
        const checks = this.collapseChecks(limits);
        // Flips the diagonal of the quad two pieces of one surface make where
        // the other diagonal gives better-shaped triangles (the angles facing
        // the shared edge sum past 180 degrees in plan) and the surface stays
        // within the limit: bisection leaves needles along every crease, and
        // a needle's corner cannot be collapsed without folding.
        const flipPass = (touched: Set<number>): number => {
            let flipped = 0;
            const probe: number[] = [];
            for (const [key, list] of [...this.edges]) {
                const pair = list.filter(t => this.tris[t].alive);
                if (pair.length !== 2) {
                    continue;
                }
                const [t1, t2] = pair;
                const A = this.tris[t1], B = this.tris[t2];
                if (A.orig >= 0 || B.orig >= 0 || A.wall || B.wall || this.isWall(t1) || this.isWall(t2)) {
                    continue;
                }
                const [a, b] = key.split('_').map(Number);
                const c = A.c.find(id => id !== a && id !== b)!, d = B.c.find(id => id !== a && id !== b)!;
                if (c === undefined || d === undefined || c === d || this.edges.get(this.edgeKey(c, d))?.some(t => this.tris[t].alive)) {
                    continue;
                }
                const angle = (o: number, e1: number, e2: number) => {
                    const ux = p[e1 * 3] - p[o * 3], uy = p[e1 * 3 + 1] - p[o * 3 + 1];
                    const vx = p[e2 * 3] - p[o * 3], vy = p[e2 * 3 + 1] - p[o * 3 + 1];
                    return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1))));
                };
                if (angle(c, a, b) + angle(d, a, b) <= Math.PI + FLIP_MIN_GAIN) {
                    continue;
                }
                // The two new triangles, wound as t1 is: t1 holds (a, b, c) in
                // some rotation; replace b by d in one and a by d in the other.
                const rot = A.c.indexOf(a), next = A.c[(rot + 1) % 3];
                const [ea, eb] = next === b ? [a, b] : [b, a];
                const n1 = [ea, d, c], n2 = [d, eb, c];
                const sign = Math.sign(area(A.c[0], A.c[1], A.c[2]));
                if (Math.sign(area(n1[0], n1[1], n1[2])) !== sign || Math.sign(area(n2[0], n2[1], n2[2])) !== sign) {
                    continue;
                }
                // Within the limit of the refined surface, clear of the other
                // layers, and never over a road.
                const fan = [t1, t2];
                if ([n1, n2].some(n => (roads && this.overRoad(n, roads, probe)) || !checks.fits(n, [[c, d]], fan))) {
                    continue;
                }
                // Each corner keeps the attributes it had in its own triangle.
                const slot = (id: number) => (A.c.includes(id) ? A.s[A.c.indexOf(id)] : B.s[B.c.indexOf(id)]);
                this.unlink(t1);
                this.unlink(t2);
                A.c = n1 as [number, number, number];
                A.s = n1.map(slot) as [number, number, number];
                B.c = n2 as [number, number, number];
                B.s = n2.map(slot) as [number, number, number];
                A.dirty = B.dirty = true;
                this.link(t1);
                this.link(t2);
                checks.moved(t1);
                checks.moved(t2);
                ring.get(ea)?.delete(t2);
                ring.get(eb)?.delete(t1);
                ring.get(d)?.add(t1);
                ring.get(c)?.add(t2);
                for (const id of [a, b, c, d]) {
                    touched.add(id);
                }
                flipped++;
            }
            return flipped;
        };
        let removed = 0;
        // After the first pass, only the vertices round a change are tried
        // again: the rest would fail as they did.
        let retry: Set<number> | undefined;
        for (let pass = 0; pass < COLLAPSE_PASSES; pass++) {
            let changed = 0;
            const touched = new Set<number>();
            const ids = retry ? [...retry].filter(id => id >= firstMid).sort((a, b) => a - b) : undefined;
            const count = ids ? ids.length : p.length / 3 - firstMid;
            for (let i = 0; i < count; i++) {
                const m = ids ? ids[i] : firstMid + i;
                const fanSet = ring.get(m);
                if (!fanSet || fanSet.size < 3 || this.borderPos.has(m)) {
                    continue;
                }
                const fan = [...fanSet];
                // Inside one surface: every edge round m on exactly two triangles.
                const others = new Set<number>();
                let inside = true;
                for (const t of fan) {
                    if (this.isWall(t)) {
                        inside = false;
                        break;
                    }
                    for (const id of this.tris[t].c) {
                        if (id !== m) {
                            others.add(id);
                        }
                    }
                }
                for (const x of others) {
                    if (!inside) {
                        break;
                    }
                    const n = (this.edges.get(this.edgeKey(m, x)) ?? []).filter(o => this.tris[o].alive).length;
                    inside = n === 2;
                }
                if (!inside) {
                    continue;
                }
                // Shortest edges first: the least the fan has to stretch.
                const order = [...others].sort((a, b) => this.edgeLength(m, a) - this.edgeLength(m, b));
                for (const x of order) {
                    if (this.collapseInto(m, x, fan, area, checks, roads)) {
                        // The two triangles on (m, x) are gone; the rest now use x.
                        for (const t of fan) {
                            for (const id of this.tris[t].c) {
                                touched.add(id);
                            }
                            if (!this.tris[t].alive) {
                                for (const id of this.tris[t].c) {
                                    ring.get(id)?.delete(t);
                                }
                                removed++;
                            } else {
                                ring.get(x)!.add(t);
                            }
                        }
                        ring.delete(m);
                        changed++;
                        break;
                    }
                }
            }
            const flipped = flipPass(touched);
            if (changed === 0 && flipped === 0) {
                break;
            }
            retry = touched;
        }
        return removed;
    }

    /**
     * The collapse's two tests, exact for surfaces made of flat triangles:
     * two of them differ most at a corner of one inside the other or where
     * their edges cross in plan, so a new face is tested there against what
     * it replaces - the corners of the old triangles inside it, and where
     * its new edges cross theirs.
     *
     *  - `fits`: within `limits` of the refined surface of its own layer, as
     *    it was when the collapse began, so the passes never add up;
     *  - ... and no nearer the current triangles of any other layer than
     *    LAYER_GAP_M, or than the fan it replaces was.
     *
     * A layer is a piece of the land joined edge to edge: the ground, a
     * land-use fill. `moved(t)` indexes a changed triangle again.
     */
    private collapseChecks(limits: CollapseLimits): {
        fits: (c: readonly number[], edges: ReadonlyArray<readonly [number, number]>, fan: readonly number[]) => boolean;
        within: (d: number, u: number, v: number) => boolean;
        moved: (t: number) => void;
    } {
        const p = this.pos;
        const n = this.tris.length;
        // The layers, by triangle.
        const parent = new Int32Array(n);
        for (let t = 0; t < n; t++) {
            parent[t] = t;
        }
        const find = (a: number): number => {
            while (parent[a] !== a) {
                parent[a] = parent[parent[a]];
                a = parent[a];
            }
            return a;
        };
        for (const list of this.edges.values()) {
            const live = list.filter(t => this.tris[t].alive);
            if (live.length === 2) {
                parent[find(live[0])] = find(live[1]);
            }
        }
        const layer = new Int32Array(n);
        for (let t = 0; t < n; t++) {
            layer[t] = find(t);
        }
        // The refined surface (corners u, v, h), and the current triangles, by cell.
        const ref: number[] = [];
        const refLayer: number[] = [];
        const refBox: number[] = [];
        const refCells = new Map<number, number[]>();
        const cells = new Map<number, number[]>();
        const many = new Set<number>();
        const cellsOf = (c: readonly number[], visit: (key: number) => void) => {
            const cu0 = Math.floor(Math.min(p[c[0] * 3], p[c[1] * 3], p[c[2] * 3]) / LAYER_CELL_M);
            const cu1 = Math.floor(Math.max(p[c[0] * 3], p[c[1] * 3], p[c[2] * 3]) / LAYER_CELL_M);
            const cv0 = Math.floor(Math.min(p[c[0] * 3 + 1], p[c[1] * 3 + 1], p[c[2] * 3 + 1]) / LAYER_CELL_M);
            const cv1 = Math.floor(Math.max(p[c[0] * 3 + 1], p[c[1] * 3 + 1], p[c[2] * 3 + 1]) / LAYER_CELL_M);
            for (let cu = cu0; cu <= cu1; cu++) {
                for (let cv = cv0; cv <= cv1; cv++) {
                    visit(cellKey(cu, cv));
                }
            }
        };
        const push = (map: Map<number, number[]>, key: number, i: number) => {
            const list = map.get(key);
            if (!list) {
                map.set(key, [i]);
            } else if (list[list.length - 1] !== i) {
                list.push(i);
            }
        };
        const moved = (t: number): void => {
            if (this.tris[t].alive && !this.isWall(t)) {
                cellsOf(this.tris[t].c, key => push(cells, key, t));
            }
        };
        const firstLayer = new Map<number, number>();
        for (let t = 0; t < n; t++) {
            const tri = this.tris[t];
            if (!tri.alive || this.isWall(t)) {
                continue;
            }
            const r = refLayer.length;
            for (const id of tri.c) {
                ref.push(p[id * 3], p[id * 3 + 1], p[id * 3 + 2]);
            }
            refLayer.push(layer[t]);
            const c = tri.c;
            refBox.push(
                Math.min(p[c[0] * 3], p[c[1] * 3], p[c[2] * 3]), Math.min(p[c[0] * 3 + 1], p[c[1] * 3 + 1], p[c[2] * 3 + 1]),
                Math.max(p[c[0] * 3], p[c[1] * 3], p[c[2] * 3]), Math.max(p[c[0] * 3 + 1], p[c[1] * 3 + 1], p[c[2] * 3 + 1]),
            );
            cellsOf(tri.c, key => {
                push(refCells, key, r);
                push(cells, key, t);
                const l = firstLayer.get(key);
                if (l === undefined) {
                    firstLayer.set(key, layer[t]);
                } else if (l !== layer[t]) {
                    many.add(key);
                }
            });
        }
        const refStamp = new Int32Array(refLayer.length);
        const curStamp = new Int32Array(n);
        let stamp = 0;
        // Height of plan triangle c at (u, v), or undefined outside it.
        const heightIn = (c: readonly number[], u: number, v: number): number | undefined => {
            const w = this.bary(c, u, v);
            return w && w[0] * p[c[0] * 3 + 2] + w[1] * p[c[1] * 3 + 2] + w[2] * p[c[2] * 3 + 2];
        };
        // Where plan segment P -> Q crosses A -> B: [s along PQ, t along AB], or undefined.
        const cross = (pu: number, pv: number, qu: number, qv: number, au: number, av: number, bu: number, bv: number): [number, number] | undefined => {
            const du = qu - pu, dv = qv - pv, eu = bu - au, ev = bv - av;
            const den = du * ev - dv * eu;
            if (Math.abs(den) < 1e-12) {
                return undefined;
            }
            const s = ((au - pu) * ev - (av - pv) * eu) / den;
            const t = ((au - pu) * dv - (av - pv) * du) / den;
            return s > 0 && s < 1 && t >= 0 && t <= 1 ? [s, t] : undefined;
        };
        // Not nearer the other layer than the gap, or than it was.
        const clear = (old: number, now: number, other: number): boolean => {
            const was = old - other;
            return was >= 0 ? now - other >= Math.min(was, LAYER_GAP_M) : other - now >= Math.min(-was, LAYER_GAP_M);
        };
        const fanHeight = (fan: readonly number[], u: number, v: number): number | undefined => {
            for (const t of fan) {
                const h = heightIn(this.tris[t].c, u, v);
                if (h !== undefined) {
                    return h;
                }
            }
            return undefined;
        };
        // The near-line test only where it decides.
        const within = (d: number, u: number, v: number): boolean => {
            if (Math.abs(d) > limits.limit) {
                return false;
            }
            if (d > COLLAPSE_SAME_M) {
                return !limits.under(u, v);
            }
            return d >= -limits.nearDown || (!limits.near(u, v) && !limits.under(u, v));
        };
        const fits = (c: readonly number[], edges: ReadonlyArray<readonly [number, number]>, fan: readonly number[]): boolean => {
            const own = layer[fan[0]];
            let ok = true;
            stamp++;
            let layered = false;
            const u0 = Math.min(p[c[0] * 3], p[c[1] * 3], p[c[2] * 3]), u1 = Math.max(p[c[0] * 3], p[c[1] * 3], p[c[2] * 3]);
            const v0 = Math.min(p[c[0] * 3 + 1], p[c[1] * 3 + 1], p[c[2] * 3 + 1]), v1 = Math.max(p[c[0] * 3 + 1], p[c[1] * 3 + 1], p[c[2] * 3 + 1]);
            // Against the refined surface of its own layer.
            cellsOf(c, key => {
                if (!ok) {
                    return;
                }
                layered ||= many.has(key);
                for (const r of refCells.get(key) ?? []) {
                    if (refStamp[r] === stamp || refLayer[r] !== own) {
                        continue;
                    }
                    refStamp[r] = stamp;
                    if (refBox[r * 4] > u1 || refBox[r * 4 + 2] < u0 || refBox[r * 4 + 1] > v1 || refBox[r * 4 + 3] < v0) {
                        continue;
                    }
                    const o = r * 9;
                    for (let k = 0; k < 3 && ok; k++) {
                        const h = heightIn(c, ref[o + k * 3], ref[o + k * 3 + 1]);
                        ok = h === undefined || within(h - ref[o + k * 3 + 2], ref[o + k * 3], ref[o + k * 3 + 1]);
                    }
                    for (const [a, b] of edges) {
                        for (let k = 0; k < 3 && ok; k++) {
                            const A = o + k * 3, B = o + ((k + 1) % 3) * 3;
                            const st = cross(p[a * 3], p[a * 3 + 1], p[b * 3], p[b * 3 + 1], ref[A], ref[A + 1], ref[B], ref[B + 1]);
                            if (st) {
                                const h = p[a * 3 + 2] + (p[b * 3 + 2] - p[a * 3 + 2]) * st[0];
                                const u = p[a * 3] + (p[b * 3] - p[a * 3]) * st[0], v = p[a * 3 + 1] + (p[b * 3 + 1] - p[a * 3 + 1]) * st[0];
                                ok = within(h - (ref[A + 2] + (ref[B + 2] - ref[A + 2]) * st[1]), u, v);
                            }
                        }
                    }
                    if (!ok) {
                        return;
                    }
                }
            });
            if (!ok || !layered) {
                return ok;
            }
            // Against the other layers as they are now.
            cellsOf(c, key => {
                if (!ok || !many.has(key)) {
                    return;
                }
                for (const t of cells.get(key) ?? []) {
                    const tri = this.tris[t];
                    if (curStamp[t] === stamp || !tri.alive || layer[t] === own) {
                        continue;
                    }
                    curStamp[t] = stamp;
                    const q = tri.c;
                    if (Math.min(p[q[0] * 3], p[q[1] * 3], p[q[2] * 3]) > u1 || Math.max(p[q[0] * 3], p[q[1] * 3], p[q[2] * 3]) < u0
                        || Math.min(p[q[0] * 3 + 1], p[q[1] * 3 + 1], p[q[2] * 3 + 1]) > v1 || Math.max(p[q[0] * 3 + 1], p[q[1] * 3 + 1], p[q[2] * 3 + 1]) < v0
                        || this.isWall(t)) {
                        continue;
                    }
                    for (const id of tri.c) {
                        const u = p[id * 3], v = p[id * 3 + 1];
                        const now = heightIn(c, u, v);
                        const old = now === undefined ? undefined : fanHeight(fan, u, v);
                        if (now !== undefined && old !== undefined && !clear(old, now, p[id * 3 + 2])) {
                            ok = false;
                            return;
                        }
                    }
                    for (const [a, b] of edges) {
                        for (let k = 0; k < 3; k++) {
                            const A = tri.c[k], B = tri.c[(k + 1) % 3];
                            const st = cross(p[a * 3], p[a * 3 + 1], p[b * 3], p[b * 3 + 1], p[A * 3], p[A * 3 + 1], p[B * 3], p[B * 3 + 1]);
                            if (!st) {
                                continue;
                            }
                            const u = p[a * 3] + (p[b * 3] - p[a * 3]) * st[0], v = p[a * 3 + 1] + (p[b * 3 + 1] - p[a * 3 + 1]) * st[0];
                            const old = fanHeight(fan, u, v);
                            const now = p[a * 3 + 2] + (p[b * 3 + 2] - p[a * 3 + 2]) * st[0];
                            if (old !== undefined && !clear(old, now, p[A * 3 + 2] + (p[B * 3 + 2] - p[A * 3 + 2]) * st[1])) {
                                ok = false;
                                return;
                            }
                        }
                    }
                }
            });
            return ok;
        };
        return { fits, within, moved };
    }

    /** Collapses m into x if the fan stays right side up and passes the checks; whether it did. */
    private collapseInto(
        m: number, x: number, fan: readonly number[],
        area: (a: number, b: number, c: number) => number,
        checks: ReturnType<SoupMesh['collapseChecks']>,
        roads?: RoadCap,
    ): boolean {
        const probe: number[] = [];
        const kept = fan.filter(t => !this.tris[t].c.includes(x));
        // The two that go must be the refinement's own pieces: a triangle in
        // one of the bake's slots may hold border vertices, which the seam
        // table finds by slot.
        if (kept.length + 2 !== fan.length || fan.some(t => this.tris[t].c.includes(x) && this.tris[t].orig >= 0)) {
            return false;
        }
        const faces = kept.map(t => this.tris[t].c.map(id => (id === m ? x : id)) as [number, number, number]);
        for (let i = 0; i < kept.length; i++) {
            const c = faces[i];
            const before = area(...this.tris[kept[i]].c);
            const after = area(...c);
            // Same way up, and not a sliver: at least a share of its longest edge squared.
            let longest = 0;
            for (let k = 0; k < 3; k++) {
                longest = Math.max(longest, this.edgeLength(c[k], c[(k + 1) % 3]));
            }
            if (Math.sign(after) !== Math.sign(before) || Math.abs(after) < COLLAPSE_MIN_SHAPE * longest * longest) {
                return false;
            }
        }
        // The vertex itself first: where most fans fail, and the cheapest test.
        const p = this.pos;
        for (const c of faces) {
            const w = this.bary(c, p[m * 3], p[m * 3 + 1]);
            if (w) {
                const h = w[0] * p[c[0] * 3 + 2] + w[1] * p[c[1] * 3 + 2] + w[2] * p[c[2] * 3 + 2];
                if (!checks.within(h - p[m * 3 + 2], p[m * 3], p[m * 3 + 1])) {
                    return false;
                }
                break;
            }
        }
        for (const c of faces) {
            // Never up over a road; the new edges are the two from x.
            if ((roads && this.overRoad(c, roads, probe)) || !checks.fits(c, c.filter(id => id !== x).map(id => [x, id] as const), fan)) {
                return false;
            }
        }
        for (const t of fan) {
            this.unlink(t);
        }
        for (const t of fan) {
            const tri = this.tris[t];
            if (tri.c.includes(x)) {
                tri.alive = false;
                continue;
            }
            tri.c = tri.c.map(id => (id === m ? x : id)) as [number, number, number];
            tri.dirty = true;
            this.link(t);
            checks.moved(t);
        }
        return true;
    }

    /** Barycentric weights of (u, v) in plan triangle c, or undefined outside it. */
    private bary(c: readonly number[], u: number, v: number): [number, number, number] | undefined {
        const p = this.pos;
        const [a, b, d] = c;
        const det = (p[b * 3] - p[a * 3]) * (p[d * 3 + 1] - p[a * 3 + 1]) - (p[d * 3] - p[a * 3]) * (p[b * 3 + 1] - p[a * 3 + 1]);
        if (Math.abs(det) < 1e-12) {
            return undefined;
        }
        const wb = ((u - p[a * 3]) * (p[d * 3 + 1] - p[a * 3 + 1]) - (p[d * 3] - p[a * 3]) * (v - p[a * 3 + 1])) / det;
        const wd = ((p[b * 3] - p[a * 3]) * (v - p[a * 3 + 1]) - (u - p[a * 3]) * (p[b * 3 + 1] - p[a * 3 + 1])) / det;
        const wa = 1 - wb - wd;
        return wa >= -1e-6 && wb >= -1e-6 && wd >= -1e-6 ? [wa, wb, wd] : undefined;
    }

    /** Plan points (u, v pairs) of the corners of every face markWalls flagged. */
    wallPoints(): number[] {
        const out: number[] = [];
        for (const tri of this.tris) {
            if (tri.alive && tri.wall) {
                for (const id of tri.c) {
                    out.push(this.pos[id * 3], this.pos[id * 3 + 1]);
                }
            }
        }
        return out;
    }

    /**
     * Flags the faces the earthworks made too steep to stand as a slope -
     * over 45 degrees, where a cutting or an embankment is squeezed against
     * a road, the water, a bridge or the tile border: retaining walls go
     * there (retainingWalls). Only faces the beds steepened: a natural
     * cliff a batter happened to touch keeps its rock. Returns how many.
     */
    markWalls(earthwork?: (u: number, v: number, h: number) => boolean): number {
        let n = 0;
        const h = (id: number, old: boolean) => old ? this.before.get(id) ?? this.pos[id * 3 + 2] : this.pos[id * 3 + 2];
        const slope = (c: readonly number[], old: boolean): number => {
            const [a, b, d] = c;
            const p = this.pos;
            const e1 = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], h(b, old) - h(a, old)];
            const e2 = [p[d * 3] - p[a * 3], p[d * 3 + 1] - p[a * 3 + 1], h(d, old) - h(a, old)];
            const nu = e1[1] * e2[2] - e1[2] * e2[1];
            const nv = e1[2] * e2[0] - e1[0] * e2[2];
            const nh = e1[0] * e2[1] - e1[1] * e2[0];
            return Math.abs(nh) < 1e-9 ? Infinity : Math.hypot(nu, nv) / Math.abs(nh);
        };
        for (const tri of this.tris) {
            if (!tri.alive || !tri.dirty) {
                continue;
            }
            let lift = 0;
            for (const id of tri.c) {
                lift = Math.max(lift, Math.abs(h(id, false) - h(id, true)));
            }
            if (lift < WALL_MIN_MOVE_M
                || (earthwork && !tri.c.some(id => earthwork(this.pos[id * 3], this.pos[id * 3 + 1], h(id, true))))) {
                continue;
            }
            const now = slope(tri.c, false);
            if (now > WALL_SLOPE && now !== Infinity && now > slope(tri.c, true) + WALL_STEEPENED) {
                tri.wall = true;
                n++;
            }
        }
        return n;
    }

    /** The mesh as a soup again: original slots first, pieces after. */
    toSoup(): LandSoup {
        const pieces = this.tris.filter(t => t.alive && t.orig < 0);
        const total = this.triCount + pieces.length;
        const positions = new Int16Array(total * 9);
        const normals = new Int8Array(total * 12);
        const attrs = new Uint8Array(total * 12);
        const { a, b, up } = this.frame;
        const q = this.q;
        const corner = (id: number): number[] => {
            // Untouched input positions go back bit for bit: border vertices
            // above all, which the stitcher and the neighbours must find
            // exactly where they were.
            if (id * 3 < this.quantised.length && !this.moved.has(id)) {
                return [this.quantised[id * 3], this.quantised[id * 3 + 1], this.quantised[id * 3 + 2]];
            }
            const u = this.pos[id * 3], v = this.pos[id * 3 + 1], h = this.pos[id * 3 + 2];
            return [
                clampI16((u * a[0] + v * b[0] + h * up[0]) / q),
                clampI16((u * a[1] + v * b[1] + h * up[1]) / q),
                clampI16((u * a[2] + v * b[2] + h * up[2]) / q),
            ];
        };
        // A face's normal, the way the triangle it came from faced; its
        // length twice the face's area.
        const faceNormal = (tri: Tri, corners: number[][]): number[] => {
            const p = corners.map(c => c.map(x => x * q));
            const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
            const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
            const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            const so = tri.s[0] * 4;
            const ref = [this.land.normals[so], this.land.normals[so + 1], this.land.normals[so + 2]];
            return n[0] * ref[0] + n[1] * ref[1] + n[2] * ref[2] < 0 ? n.map(x => -x) : n;
        };
        // A moved vertex is shaded by the faces round it, each by its area:
        // a split of a kilometre-long baked sliver leaves needles two metres
        // wide, and a few centimetres' move across one tilted its own
        // normal 30 degrees - a dark wedge across a field. Near-vertical
        // faces (skirts) are left out; they are no part of the slope.
        const smooth = new Map<number, number[]>();
        for (const tri of this.tris) {
            if (!tri.alive || !tri.c.some(id => this.moved.has(id))) {
                continue;
            }
            const n = faceNormal(tri, tri.c.map(corner));
            const len = Math.hypot(n[0], n[1], n[2]);
            if (len < 1e-9 || (n[0] * up[0] + n[1] * up[1] + n[2] * up[2]) / len < SMOOTH_MIN_UP) {
                continue;
            }
            for (const id of tri.c) {
                if (this.moved.has(id)) {
                    const acc = smooth.get(id);
                    if (acc) {
                        acc[0] += n[0];
                        acc[1] += n[1];
                        acc[2] += n[2];
                    } else {
                        smooth.set(id, n.slice());
                    }
                }
            }
        }
        const unit = (n: number[]): number[] => {
            const len = Math.hypot(n[0], n[1], n[2]) || 1;
            return n.map(x => x / len);
        };
        const write = (slot: number, tri: Tri | undefined) => {
            const corners = tri ? tri.c.map(corner) : undefined;
            // Only a moved surface gets new normals: a piece of a triangle
            // split along its own plane keeps the baked ones, which the bake
            // smooths. Its moved corners take the faces round them; the
            // others keep the baked normal the faces beside them share.
            let nrm: Array<number[] | undefined> | undefined;
            if (tri && corners && tri.c.some(id => this.moved.has(id))) {
                const own = unit(faceNormal(tri, corners));
                nrm = tri.c.map(id => !this.moved.has(id) ? undefined : unit(smooth.get(id) ?? own));
            }
            for (let k = 0; k < 3; k++) {
                const vo = slot * 3 + k;
                // An emptied slot: degenerate, on the first corner it had.
                const src = tri ? tri.s[k] * 4 : slot * 12;
                // (The original triangles are the first triCount, in slot order.)
                const p = corners ? corners[k] : corner(this.tris[slot].c[0]);
                positions[vo * 3] = p[0];
                positions[vo * 3 + 1] = p[1];
                positions[vo * 3 + 2] = p[2];
                const n = nrm?.[k];
                if (n) {
                    normals[vo * 4] = Math.round(n[0] * 127);
                    normals[vo * 4 + 1] = Math.round(n[1] * 127);
                    normals[vo * 4 + 2] = Math.round(n[2] * 127);
                    normals[vo * 4 + 3] = this.land.normals[src + 3];
                } else {
                    normals.set(this.land.normals.subarray(src, src + 4), vo * 4);
                }
                attrs.set(this.land.attrs.subarray(src, src + 4), vo * 4);
            }
            unifyCorners(attrs, slot * 12);
        };
        // Original slots: untouched bytes, the triangle now holding the slot,
        // or degenerate when it went to pieces.
        const holder = new Array<Tri | undefined>(this.triCount);
        for (const tri of this.tris) {
            if (tri.alive && tri.orig >= 0) {
                holder[tri.orig] = tri;
            }
        }
        for (let slot = 0; slot < this.triCount; slot++) {
            const tri = holder[slot];
            if (tri && !tri.dirty) {
                positions.set(this.land.positions.subarray(slot * 9, slot * 9 + 9), slot * 9);
                normals.set(this.land.normals.subarray(slot * 12, slot * 12 + 12), slot * 12);
                attrs.set(this.land.attrs.subarray(slot * 12, slot * 12 + 12), slot * 12);
            } else {
                write(slot, tri);
            }
        }
        let slot = this.triCount;
        for (const tri of pieces) {
            write(slot++, tri);
        }
        return { positions, normals, attrs };
    }
}

/** A face steeper than this (its normal's up component) is left out of a moved vertex's shading: a skirt, a wall. */
const SMOOTH_MIN_UP = 0.25;

/** Clear ground kept past a bed's batter toe for scattered trees and rocks, metres. */
const SCATTER_MARGIN_M = 3;

/**
 * Whether a scatter point (tile frame, metres, as RailBedResult.beds) is on a
 * bed or its batters: the ground there is not where the tile's own facets
 * put it, so a tree would float or sink, and a railway keeps its cess clear
 * anyway. Undefined when there are no beds.
 */
export function buildRailBedExclusion(
    beds: Float64Array, up: V3, cellM = CELL_M,
): ((x: number, y: number, z: number) => boolean) | undefined {
    const n = beds.length / RAIL_BED_SEGMENT_FLOATS;
    if (n === 0) {
        return undefined;
    }
    const frame = planFrame(up);
    const segs = new Float64Array(n * 6); // ua, va, ub, vb, reach, open
    const cells = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
        const o = i * RAIL_BED_SEGMENT_FLOATS;
        const a = frame.toPlan([beds[o], beds[o + 1], beds[o + 2]]);
        const b = frame.toPlan([beds[o + 3], beds[o + 4], beds[o + 5]]);
        // The batter runs out where it has made up the bed's height difference.
        const reach = beds[o + 6] + SHOULDER_M + Math.min(BATTER_REACH_M, beds[o + 7] / BATTER) + SCATTER_MARGIN_M;
        segs.set([a[0], a[1], b[0], b[1], reach, beds[o + 8]], i * 6);
        const u0 = Math.floor((Math.min(a[0], b[0]) - reach) / cellM), u1 = Math.floor((Math.max(a[0], b[0]) + reach) / cellM);
        const v0 = Math.floor((Math.min(a[1], b[1]) - reach) / cellM), v1 = Math.floor((Math.max(a[1], b[1]) + reach) / cellM);
        for (let cu = u0; cu <= u1; cu++) {
            for (let cv = v0; cv <= v1; cv++) {
                const key = cellKey(cu, cv);
                const list = cells.get(key);
                if (list) {
                    list.push(i);
                } else {
                    cells.set(key, [i]);
                }
            }
        }
    }
    return (x, y, z) => {
        const [u, v] = frame.toPlan([x, y, z]);
        const list = cells.get(cellKey(Math.floor(u / cellM), Math.floor(v / cellM)));
        if (!list) {
            return false;
        }
        for (const i of list) {
            const o = i * 6;
            const du = segs[o + 2] - segs[o], dv = segs[o + 3] - segs[o + 1];
            const t = bedSegmentParam(u - segs[o], v - segs[o + 1], du, dv, segs[o + 5]);
            if (t !== undefined && Math.hypot(u - segs[o] - du * t, v - segs[o + 1] - dv * t) < segs[o + 4]) {
                return true;
            }
        }
        return false;
    };
}

/**
 * Gives a triangle one class and one colour set. A triangle's corners are
 * copied from the slots they came from, and after an edge flip or a split
 * those are different triangles' corners: a forest sliver beside a field then
 * had one corner of the field's yellow, which the shader blends across it as a
 * smear into the field. A triangle is one cover, so the odd corner takes the
 * colour and class of the other two (the first corner when all three differ).
 */
export function unifyCorners(attrs: Uint8Array, at: number): void {
    const cls = [attrs[at + 3], attrs[at + 7], attrs[at + 11]];
    if (cls[0] === cls[1] && cls[1] === cls[2]) {
        return;
    }
    const keep = cls[1] === cls[2] ? 1 : 0;
    for (let k = 0; k < 3; k++) {
        if (cls[k] !== cls[keep]) {
            attrs.copyWithin(at + k * 4, at + keep * 4, at + keep * 4 + 4);
        }
    }
}

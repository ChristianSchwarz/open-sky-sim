/**
 * The barricade webbing as particles and constraints, rigged, in
 * carrier-local metres (x across the deck, y up, landing toward −z).
 *
 * Two load straps (belts) run between the stanchions, the upper one at the
 * stanchion heads and the lower one on its deck ramps. Thirty nylon engaging
 * straps hang between them. Each is a loop: both its ends are sewn to the
 * lower belt at its station (a particle the belt shares with the strap), and
 * its eye is slung over the upper belt, free to slide along it (see
 * WebSling). Its two plies hang together and move as one, so the strap is
 * one chain, station to eye, with the loop's mass and stiffness. Each belt end is tethered: the upper ones by their tensioning
 * pendants to the stanchion heads, the lower ones by the purchase cables to
 * the deck sheaves at the stanchion feet. The lower belt is also tied down to
 * the deck along its length, which is what keeps a rigged net from bellying
 * (a belt held only at its ends is pulled up by the straps until they go
 * slack again).
 *
 * Material numbers are first estimates, chosen to be plausible, not data:
 * nylon webbing a few per cent stretch at working load, the load straps far
 * stiffer than the engaging straps.
 */
import {
    BARRICADE_DECK_Y,
    BARRICADE_HALF_SPAN_M,
    BARRICADE_HEIGHT_M,
    BARRICADE_LOCAL_Z,
    BARRICADE_LOWER_LIFT_M,
    BARRICADE_MID_X,
    BARRICADE_PULL_OUT_M,
    BARRICADE_STRAP_COUNT,
} from '../../scene/entities/barricadeSpec';

/**
 * Belt segments between neighbouring strap stations, and segments per
 * engaging strap: links of 0.38 m and 0.41 m. The edge contacts keep a
 * link from lying across a thin wing, so the net does not need links
 * shorter than the airframe's features. At 0.29 m (4 and 20) the gates held
 * as well (the slow catch's strap speeds a little higher) and the solve cost
 * 40 % more.
 */
const BELT_SEGMENTS_PER_BAY = 3;
const STRAP_SEGMENTS = 14;
/** Linear densities (kg/m): load strap, engaging strap. */
const BELT_KG_PER_M = 1.5;
const STRAP_KG_PER_M = 0.5;
/** Axial stiffness EA (N): load straps barely stretch, engaging straps do. */
export const BELT_EA_N = 2e6;
export const STRAP_EA_N = 4e5;
/** Holding force where a tether pays out (N): pendant at the head, purchase cable at the foot. */
export const PENDANT_HOLD_N = 40e3;
export const ENGINE_HOLD_N = 220e3;
/**
 * The purchase engines as hydraulic dampers, like the carrier's MK-7: a ram
 * pushes oil through an orifice, so the cable's pull rises with the square
 * of its payout speed, and a constant-run-out valve closes the orifice as
 * the cable pays out. With the orifice coefficient m_set / (2 (S - x)) shared
 * by the two engines, a jet of the set mass arriving at any speed is pulled
 * at v^2 / (2 (S - x)): the same 75 m stop the sim scripts, 0.17 m/s^2 at
 * 5 m/s and about 2.4 g at 60 m/s. The crew sets the engines for the
 * aircraft's weight, as on deck (the MK-7's weight selector); the relief
 * valve holds the pull at the 5 g the airframes are cleared for, and the
 * accumulator keeps a small static pull on the cable, which is all that
 * holds the rigged net.
 */
export interface PurchaseEngine {
    /** The weight setting (kg). */
    readonly setMassKg: number;
    /** The share of the set mass this cable stops (one of two sides: a half). */
    readonly share: number;
    /** Cable payout over which it stops a set-weight aircraft (m). */
    readonly runOutM: number;
    /** Relief valve (N). */
    readonly maxN: number;
}
/** Static pull at each lower belt end (N): the accumulator's, all that holds the rigged net on its ramps. */
export const ENGINE_PRELOAD_N = 10e3;
/**
 * With the engines set, the upper belt's ends slip at this constant pull
 * (N): just over the 20 kN it is rigged at, so it hangs as before. Two
 * alternatives were measured on the free, turning jet (webCoupled stage B):
 *  - the head pendants' 40 kN: with the lower ends' preload the jet felt
 *    120 kN aft for good, high on the airframe, and the F-22 (its nose
 *    wheel carrying 8-12 % of the weight) sat back on its tail;
 *  - the upper ends on the engines too, a quarter of the orifice each: the
 *    upper belt then pulled as hard as the lower (168 kN an end at 60 m/s),
 *    and the centre strap draped along the F-22's nose ran at 24 % (12.5 %
 *    with this hold).
 * The lower belt, low on the gear, takes the arrest; the upper keeps the
 * straps up.
 */
export const ENGINE_PRELOAD_UPPER_N = 25e3;
export const ENGINE_RUN_OUT_M = BARRICADE_PULL_OUT_M;
/** Relief at this many g on the set mass, both engines together. */
export const ENGINE_RELIEF_G = 5;
/**
 * The upper belt is cut short for this tension (N) when rigged between the
 * stanchion heads. Cut to the span it stretches under its own weight and the
 * straps' — 0.4 % is over a metre of sag on 36 m; real rigging is tensioned.
 */
const UPPER_PRETENSION_N = 20e3;
/** Every this many lower-belt particles is tied to the deck. */
const TIE_DOWN_EVERY = BELT_SEGMENTS_PER_BAY;
/**
 * A breakaway tie's rating (N). It only has to keep the lower belt down
 * against the hanging straps (32 N per tie on average, 200 N at most, rigged)
 * and wind on the open webbing (about 1 kN spread over the 30 ties), so
 * 1 kN holds with a 5x margin. At 12 kN the ties carried catch load, stored
 * belt tension and whipped the freed belt (straps at 28-42 m/s in a 5 m/s
 * catch, 15-23 % of the energy lost in the webbing).
 */
const TIE_DOWN_BREAK_N = 1e3;
/**
 * A breakaway tie yields at its rating over this stroke (m) before it lets
 * go. Cut at once, the freed belt whipped at 20-50 m/s in a 5 m/s catch.
 */
const TIE_DOWN_STROKE_M = 0.03;
/** Tie-down compliance (m/N): firm, not rigid. */
const TIE_DOWN_COMPLIANCE = 1e-6;
/**
 * The belts stop this far inboard of the stanchions (m), so every tether
 * has a length: a zero-length one has no direction to pull along, and
 * repeated chain solves flipped it back and forth (a 5 m/s two-cycle).
 */
const TETHER_LEAD_M = 0.6;

/** What a particle belongs to. */
export const enum WebPart {
    UPPER_BELT = 0,
    LOWER_BELT = 1,
    STRAP = 2,
}

/** A distance constraint between two particles. */
export interface WebLink {
    readonly i: number;
    readonly j: number;
    readonly rest: number;
    /** XPBD compliance (m/N): rest / EA. */
    readonly compliance: number;
}

/** A belt end held toward an anchor; pays out (lengthens) above its holding force. */
export interface WebTether {
    readonly i: number;
    readonly anchor: [number, number, number];
    readonly holdN: number;
    /** When set, a hydraulic engine: holdN is its static preload, and the pull rises with payout speed. */
    readonly engine?: PurchaseEngine;
}

/**
 * An engaging strap's eye, slung over the upper belt: it stays on the belt
 * but slides along it freely. The belt cannot leave the eye, the eye cannot
 * leave the belt (its ends are the belt's tethers).
 */
export interface WebSling {
    /** The eye particle (the strap's top node). */
    readonly eye: number;
    /** The upper-belt link it is rigged on (between upperBelt[link] and upperBelt[link + 1]). */
    readonly link: number;
}

/** A lower-belt particle held to its rigged spot on the deck until it is pulled off. */
export interface WebTieDown {
    readonly i: number;
    readonly at: [number, number, number];
    readonly compliance: number;
    /** Force it yields at (N), and how far it yields before it lets go (m). */
    readonly breakN: number;
    readonly strokeM: number;
}

export interface WebLayout {
    readonly count: number;
    /** Rigged positions, xyz interleaved. */
    readonly x: Float64Array;
    readonly mass: Float64Array;
    readonly part: Uint8Array;
    readonly links: WebLink[];
    readonly tethers: WebTether[];
    readonly tieDowns: WebTieDown[];
    /** Particle index of the mirror image across the centreline. */
    readonly mirror: Int32Array;
    /** Per strap: its particle indices from its eye on the upper belt down to its station on the lower. */
    readonly straps: number[][];
    /** Per strap: its eye on the upper belt. */
    readonly slings: WebSling[];
    readonly upperBelt: number[];
    readonly lowerBelt: number[];
}

/** Overrides for tests: the tethers' holding forces. */
export interface WebRigOptions {
    pendantHoldN?: number;
    engineHoldN?: number;
    /** Purchase engines set for an aircraft of this mass (kg) instead of a constant hold. */
    engineSetKg?: number;
}

/** A purchase engine's hold: hydraulic when set for an aircraft, else constant. */
function engineHold(opts: WebRigOptions): { holdN: number; engine?: PurchaseEngine } {
    if (opts.engineSetKg === undefined) return { holdN: opts.engineHoldN ?? ENGINE_HOLD_N };
    return { holdN: opts.engineHoldN ?? ENGINE_PRELOAD_N, engine: purchase(opts.engineSetKg) };
}

/** The upper belt's ends: a constant slip hold (see ENGINE_PRELOAD_UPPER_N), the head pendants' when the engines are not set. */
function headHold(opts: WebRigOptions): { holdN: number; engine?: PurchaseEngine } {
    if (opts.engineSetKg === undefined) return { holdN: opts.pendantHoldN ?? PENDANT_HOLD_N };
    return { holdN: opts.pendantHoldN ?? ENGINE_PRELOAD_UPPER_N };
}

/** One side's engine on its lower belt end: half the set mass, half the relief. */
function purchase(setMassKg: number): PurchaseEngine {
    return { setMassKg, share: 0.5, runOutM: ENGINE_RUN_OUT_M, maxN: (ENGINE_RELIEF_G * 9.80665 * setMassKg) / 2 };
}

export function buildRiggedWeb(opts: WebRigOptions = {}): WebLayout {
    const xS = BARRICADE_MID_X - BARRICADE_HALF_SPAN_M;
    const xL = xS + TETHER_LEAD_M;
    const span = 2 * (BARRICADE_HALF_SPAN_M - TETHER_LEAD_M);
    const z = BARRICADE_LOCAL_Z;
    const yTop = BARRICADE_DECK_Y + BARRICADE_HEIGHT_M;
    const yLow = BARRICADE_DECK_Y + BARRICADE_LOWER_LIFT_M;
    const beltSegs = (BARRICADE_STRAP_COUNT + 1) * BELT_SEGMENTS_PER_BAY;
    const beltSeg = span / beltSegs;
    const strapLen = yTop - yLow;
    const strapSeg = strapLen / STRAP_SEGMENTS;

    const pos: number[] = [];
    const mass: number[] = [];
    const part: number[] = [];
    const add = (px: number, py: number, pz: number, m: number, p: WebPart) => {
        pos.push(px, py, pz);
        mass.push(m);
        part.push(p);
        return mass.length - 1;
    };

    const links: WebLink[] = [];
    const link = (i: number, j: number, rest: number, ea: number) =>
        links.push({ i, j, rest, compliance: rest / ea });

    const belt = (y: number, p: WebPart, pretensionN: number) => {
        const ids: number[] = [];
        const rest = beltSeg / (1 + pretensionN / BELT_EA_N);
        for (let k = 0; k <= beltSegs; k++) {
            const ends = k === 0 || k === beltSegs ? 0.5 : 1;
            ids.push(add(xL + k * beltSeg, y, z, BELT_KG_PER_M * beltSeg * ends, p));
            if (k > 0) link(ids[k - 1], ids[k], rest, BELT_EA_N);
        }
        return ids;
    };
    const upperBelt = belt(yTop, WebPart.UPPER_BELT, UPPER_PRETENSION_N);
    const lowerBelt = belt(yLow, WebPart.LOWER_BELT, 0);

    const straps: number[][] = [];
    const slings: WebSling[] = [];
    for (let s = 0; s < BARRICADE_STRAP_COUNT; s++) {
        const k = (s + 1) * BELT_SEGMENTS_PER_BAY;
        const bottom = lowerBelt[k];
        const px = xL + k * beltSeg;
        // The eye, on the upper belt at its station (and the link to its right, where it starts).
        const top = add(px, yTop, z, 0, WebPart.STRAP);
        slings.push({ eye: top, link: k });
        const ids = [top];
        for (let n = 1; n < STRAP_SEGMENTS; n++) {
            ids.push(add(px, yTop - n * strapSeg, z, STRAP_KG_PER_M * strapSeg, WebPart.STRAP));
        }
        ids.push(bottom);
        for (let n = 1; n < ids.length; n++) link(ids[n - 1], ids[n], strapSeg, STRAP_EA_N);
        // The eye and the station carry half of the strap's end segments.
        mass[top] += STRAP_KG_PER_M * strapSeg * 0.5;
        mass[bottom] += STRAP_KG_PER_M * strapSeg * 0.5;
        straps.push(ids);
    }

    const xR = xS + 2 * BARRICADE_HALF_SPAN_M;
    const tethers: WebTether[] = [
        { i: upperBelt[0], anchor: [xS, yTop, z], ...headHold(opts) },
        { i: upperBelt[beltSegs], anchor: [xR, yTop, z], ...headHold(opts) },
        { i: lowerBelt[0], anchor: [xS, BARRICADE_DECK_Y, z], ...engineHold(opts) },
        { i: lowerBelt[beltSegs], anchor: [xR, BARRICADE_DECK_Y, z], ...engineHold(opts) },
    ];
    const tieDowns: WebTieDown[] = [];
    for (let k = TIE_DOWN_EVERY; k < beltSegs; k += TIE_DOWN_EVERY) {
        const i = lowerBelt[k];
        tieDowns.push({ i, at: [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], compliance: TIE_DOWN_COMPLIANCE, breakN: TIE_DOWN_BREAK_N, strokeM: TIE_DOWN_STROKE_M });
    }

    // Mirror: belts by index, straps by strap and node.
    const count = mass.length;
    const mirror = new Int32Array(count).fill(-1);
    for (let k = 0; k <= beltSegs; k++) {
        mirror[upperBelt[k]] = upperBelt[beltSegs - k];
        mirror[lowerBelt[k]] = lowerBelt[beltSegs - k];
    }
    for (let s = 0; s < straps.length; s++) {
        const other = straps[straps.length - 1 - s];
        for (let n = 0; n < straps[s].length; n++) mirror[straps[s][n]] = other[n];
    }

    return {
        count,
        x: Float64Array.from(pos),
        mass: Float64Array.from(mass),
        part: Uint8Array.from(part),
        links,
        tethers,
        tieDowns,
        mirror,
        straps,
        slings,
        upperBelt,
        lowerBelt,
    };
}

/**
 * Airfield flatten pad.
 *
 * The pad is baked into the mesh, so this exists only for CPU height
 * queries — and both read the same numbers out of the manifest, which is what
 * guarantees the collision surface and the drawn surface agree by
 * construction rather than by two code paths happening to match.
 */

/**
 * An oriented, optionally sloping rectangle in ENU, metres.
 *
 * Oriented because real runways run whatever bearing the terrain and the wind
 * gave them, and an axis-aligned box laid over one at 032 flattens two corners
 * of countryside and leaves the thresholds hanging.
 *
 * Sloping because a runway is not a table. ICAO allows 1% along a code 3/4
 * runway and 2% on a short one, and plenty of real fields use it — cutting a
 * dead-level shelf into ground that falls 30 m across the airfield leaves a
 * cliff at one end. A gradient of 0 with the default axis reproduces the old
 * axis-aligned level pad exactly.
 */
export interface FlattenPad {
    centerX: number;
    centerZ: number;
    /** Half extent across the pad axis (m). */
    halfW: number;
    /** Half extent along the pad axis (m). */
    halfD: number;
    featherM: number;
    /** Baked DEM height at the pad centre. */
    heightMsl: number;
    /**
     * Unit ENU direction of the long axis. Absent means due north, which is
     * what every pad baked before pads could turn was.
     *
     * Must be unit length if present — {@link padAxisFromHeading} and
     * {@link padAxisTowards} are the two ways to produce one. A zero vector
     * would collapse the local frame and flatten everything in range.
     */
    axisE?: number;
    axisN?: number;
    /**
     * The pad's plane, as a rise in metres per metre east and per metre north.
     * Absent means level.
     *
     * A vector rather than a slope along {@link axisE}/{@link axisN}, because
     * the two are not the same axis. Every pad of one airfield — both runways
     * of a crossing pair, and every apron between them — is cut to a *single*
     * plane, fitted once for the whole platform: two rectangles fitted
     * separately meet at a step, and the step lands on the taxiway joining
     * them. So the footprint turns with the runway it belongs to while the
     * plane stays the airfield's.
     *
     * Storing it in the working frame means it is built by the same
     * convergence-aware helper the axis is; see {@link padAxisTowards}.
     */
    gradE?: number;
    gradN?: number;
}

/** Pad axis for a compass bearing, in a frame whose north is the pad's north. */
export function padAxisFromHeading(headingDeg: number): { e: number; n: number } {
    const r = headingDeg * Math.PI / 180;
    return { e: Math.sin(r), n: Math.cos(r) };
}

/**
 * Pad axis from the pad centre to a point already ahead of it along the axis,
 * both in the working ENU frame.
 *
 * The one to use when the working frame's origin is not the pad. ENU axes turn
 * with position: a frame anchored 100 km west of the pad has its north rotated
 * against the pad's own by the meridian convergence between them, about a
 * degree at mid-latitudes. That is 27 m of swing at the end of a 3.4 km runway,
 * against a strip half 75 m wide — small enough to look fine and large enough
 * that the flattened ground and the drawn pavement would not be the same
 * rectangle.
 *
 * Falls back to due north if handed a degenerate pair, so a bad manifest
 * cannot produce a pad that flattens everything near it.
 */
export function padAxisTowards(
    centerE: number, centerN: number, aheadE: number, aheadN: number,
): { e: number; n: number } {
    const de = aheadE - centerE;
    const dn = aheadN - centerN;
    const len = Math.hypot(de, dn);
    return len > 1e-6 ? { e: de / len, n: dn / len } : { e: 0, n: 1 };
}

/** Along-axis and across-axis offset of an ENU point from the pad centre. */
export function padLocal(
    e: number, n: number, pad: FlattenPad,
): { along: number; across: number } {
    const de = e - pad.centerX;
    const dn = n - pad.centerZ;
    const ae = pad.axisE ?? 0;
    const an = pad.axisN ?? 1;
    // Across is the axis turned 90 degrees right, so a due-north pad keeps
    // along = north and across = east and the arithmetic is what it always was.
    return { along: de * ae + dn * an, across: de * an - dn * ae };
}

/**
 * Blend weight in [0,1]: 1 inside the core rectangle, 0 outside the pad,
 * smoothstep across the feather.
 */
export function padBlendWeight(e: number, n: number, pad: FlattenPad): number {
    // The feather may take at most half the pad. Past that there is more
    // transition than platform, and at the limit no core at all — a failure
    // that is silent, because the shape stays a smooth bump reaching full
    // weight only along one line through the middle, so the platform reads as
    // a ramp and its edges sit half way between the plane and the raw ground.
    // Clamping cannot make a too-small pad correct, but it does keep it flat.
    const feather = Math.min(
        Math.max(1, pad.featherM), Math.max(1, Math.min(pad.halfW, pad.halfD) * 0.5));
    const coreW = Math.max(0, pad.halfW - feather);
    const coreD = Math.max(0, pad.halfD - feather);
    const local = padLocal(e, n, pad);
    const dx = Math.abs(local.across);
    const dz = Math.abs(local.along);
    if (dx >= pad.halfW || dz >= pad.halfD) {
        return 0;
    }
    if (dx <= coreW && dz <= coreD) {
        return 1;
    }
    const tx = dx <= coreW ? 1 : 1 - (dx - coreW) / feather;
    const tz = dz <= coreD ? 1 : 1 - (dz - coreD) / feather;
    const t = Math.max(0, Math.min(1, Math.min(tx, tz)));
    return t * t * (3 - 2 * t);
}

/** Height the pad wants at an ENU point: its plane, not a single level. */
export function padSurfaceHeight(e: number, n: number, pad: FlattenPad): number {
    const gradE = pad.gradE ?? 0;
    const gradN = pad.gradN ?? 0;
    if (gradE === 0 && gradN === 0) {
        return pad.heightMsl;
    }
    return pad.heightMsl + gradE * (e - pad.centerX) + gradN * (n - pad.centerZ);
}

/**
 * The plane's rise per metre east and north, from a slope and the true bearing
 * it rises along, in a frame whose north is the pad's north.
 */
export function padGradientFromHeading(
    gradient: number, headingDeg: number,
): { e: number; n: number } {
    const axis = padAxisFromHeading(headingDeg);
    return { e: gradient * axis.e, n: gradient * axis.n };
}

export function applyFlattenPad(height: number, e: number, n: number, pad: FlattenPad): number {
    if (!Number.isFinite(pad.heightMsl)) {
        return height;
    }
    const w = padBlendWeight(e, n, pad);
    if (w <= 0) {
        return height;
    }
    const target = padSurfaceHeight(e, n, pad);
    const base = Number.isFinite(height) ? height : target;
    return base + (target - base) * w;
}

/**
 * How far along a bearing the axis is sampled. Only a direction is wanted, so
 * the distance just has to be long enough that the projection's own rounding
 * does not matter and short enough to stay on the same tangent plane.
 */
const AXIS_PROBE_M = 1000;

/** Metres per degree of latitude and of longitude — the usual WGS84 series. */
function metresPerDegree(latDeg: number): { lat: number; lon: number } {
    const lat = latDeg * Math.PI / 180;
    return {
        lat: 111132.92 - 559.82 * Math.cos(2 * lat) + 1.175 * Math.cos(4 * lat),
        lon: 111412.84 * Math.cos(lat) - 93.5 * Math.cos(3 * lat),
    };
}

/** A pad as the manifest records it: geodetic, with bearings rather than axes. */
export interface FlattenPadRecord {
    lat: number;
    lon: number;
    halfW: number;
    halfD: number;
    featherM: number;
    heightMsl: number;
    headingDeg?: number;
    gradient?: number;
    gradientHeadingDeg?: number;
    /**
     * ICAO identifier of the airfield this pad belongs to, where it has one.
     * Carried for the manifest's readability, not used by the pad maths.
     */
    icao?: string;
}

/**
 * The one place a manifest pad becomes a working pad.
 *
 * Shared by the mesh bake and the runtime height sampler on purpose: the pad
 * decides both the ground that is drawn and the ground an aircraft rests on,
 * and those must be the same surface by construction. `toEnu` is the only
 * thing that differs — the bake gives each pad its own frame, the runtime uses
 * the play area's — and everything about the pad's shape is derived here.
 *
 * Bearings are turned into axes by projecting a point a kilometre ahead,
 * rather than by taking sin/cos of the bearing directly, because ENU north is
 * only the pad's north at the frame's own origin. See {@link padAxisTowards}.
 */
/**
 * The ENU direction of a true bearing at a geodetic point.
 *
 * Projected from a point a kilometre ahead rather than taken as sin/cos of the
 * bearing, because ENU north is only that point's north at the frame's own
 * origin — see {@link padAxisTowards}. Shared with the airfield geometry, which
 * has to lay a runway out along exactly the axis its pad was cut along.
 */
export function bearingAxisAt(
    lat: number, lon: number, bearingDeg: number,
    toEnu: (lat: number, lon: number) => { e: number; n: number },
): { e: number; n: number } {
    const centre = toEnu(lat, lon);
    const perDeg = metresPerDegree(lat);
    const r = bearingDeg * Math.PI / 180;
    const ahead = toEnu(
        lat + (AXIS_PROBE_M * Math.cos(r)) / perDeg.lat,
        lon + (AXIS_PROBE_M * Math.sin(r)) / Math.max(1, perDeg.lon),
    );
    return padAxisTowards(centre.e, centre.n, ahead.e, ahead.n);
}

export function padFromRecord(
    p: FlattenPadRecord,
    toEnu: (lat: number, lon: number) => { e: number; n: number },
): FlattenPad {
    const centre = toEnu(p.lat, p.lon);
    const base = {
        centerX: centre.e,
        centerZ: centre.n,
        halfW: p.halfW,
        halfD: p.halfD,
        featherM: p.featherM,
        heightMsl: p.heightMsl,
    };
    if (p.headingDeg === undefined && p.gradient === undefined) {
        // A record from before pads could turn. Left with no axis and no
        // gradient at all rather than given a numerically-derived due north,
        // so a pyramid baked earlier reproduces its old heights exactly.
        return base;
    }

    const axisFor = (bearingDeg: number) => bearingAxisAt(p.lat, p.lon, bearingDeg, toEnu);

    const heading = p.headingDeg ?? 0;
    const axis = axisFor(heading);
    const gradient = p.gradient ?? 0;
    const rise = gradient === 0
        ? { e: 0, n: 0 }
        : axisFor(p.gradientHeadingDeg ?? heading);
    // A pad is compared against ENU east/north inside the sampler and inside
    // the bake, not against scene axes, so no north flip belongs anywhere here.
    return {
        ...base,
        axisE: axis.e,
        axisN: axis.n,
        gradE: gradient * rise.e,
        gradN: gradient * rise.n,
    };
}

/**
 * Radius that contains the pad and its feather whatever way it is turned.
 *
 * The cheap rejects upstream test a geodetic box around the pad, and a box
 * sized from halfW/halfD is only correct for a pad pointing north. Using the
 * circumradius makes the reject rotation-independent; it is an optimisation,
 * so being generous costs a few more full tests and nothing else.
 */
export function padReachM(pad: FlattenPad): number {
    return Math.hypot(pad.halfD + pad.featherM, pad.halfW + pad.featherM);
}

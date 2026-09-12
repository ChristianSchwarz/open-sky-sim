/**
 * The one mission validator, shared by the editor and by the dev server.
 *
 * `tools/missions.ts` imports this module directly (tools/ → src/ is a normal
 * direction here; the reverse is blocked by `rootDir: "./src"`), so a mission
 * that the browser calls valid and one the server accepts are the same set by
 * construction. The alternative — a second copy of the shape server-side, as
 * `Area` is duplicated today between areaImport.ts and importMath.ts — cannot
 * hold for a format a person is expected to hand-edit.
 *
 * The validator REJECTS rather than repairs. A repaired mission is one the
 * editor writes silently back to disk on the next save, so a file that is 90%
 * right becomes a file that is 100% different from what its author typed.
 */

import {
    DEFAULT_CAPTURE_RADIUS_M,
    MISSION_AI_MODELS,
    MISSION_COURSE_WARN_DEG,
    MISSION_FACTIONS,
    MISSION_LEG_ACTIONS,
    MISSION_MAX_ENEMY,
    MISSION_MAX_FLIGHT_SIZE,
    MISSION_MAX_FRIENDLY,
    MISSION_SCHEME,
    MISSION_SKILLS,
    MISSION_VERSION,
    MissionDoc,
    MissionFaction,
    MissionFlight,
    MissionLeg,
    MissionLegAction,
    MissionPilot,
    MissionPlayerStart,
    MissionPoint,
    MissionRoute,
    MissionSpawn,
} from './missionFormat';

export interface MissionIssue {
    /**
     * JSON-pointer-ish path, e.g. `flights[1].start.position.lat`. The editor
     * renders these into its error list and selects the named leg on click, so
     * the path is load-bearing UI, not just a debugging aid.
     */
    path: string;
    /** Lowercase, human, unpunctuated — the areaImport.ts error voice. */
    message: string;
}

export interface MissionValidation {
    ok: boolean;
    /**
     * Present only when `ok`. The normalised document: parsed, type-checked,
     * and with the *context-free* defaults applied (capture radius, hold
     * seconds, `agl`). Defaults that need the world — a leg speed falling back
     * to the flight's cruise speed, an airframe falling back to the player's —
     * are `missionResolve`'s job, because they need the registry and the
     * resolved play area.
     */
    doc?: MissionDoc;
    errors: MissionIssue[];
    /**
     * Non-fatal. Everything reportable without the world: a route nothing
     * flies, a near-reversal the turn latch will fly wide. Warnings that need
     * the manifest or the aircraft registry come from `missionResolve`.
     */
    warnings: MissionIssue[];
}

/**
 * Filename and id sanitiser, shared with `tools/missions.ts` so both sides
 * agree byte for byte.
 *
 * Copied from `slug()` in tools/areaImport.ts (hyphens, 40-char cap) rather
 * than `slugify()` in modserver.ts (underscores), with two changes the original
 * does not need and this one does:
 *
 *  - the trailing-separator trim is repeated AFTER the length cap, so the
 *    function is idempotent. Without it a name whose 40th character is a
 *    hyphen slugs to something that does not survive being slugged again, and
 *    the `missionSlug(id) === id` rule below would reject an id this very
 *    function produced.
 *  - the empty string is a legal RESULT and an illegal ID. `missionSlug('...')`
 *    is `''`, which would pass a naive containment check and write a hidden
 *    `.mission.json` with no name. Every caller must reject it; this module
 *    does so in {@link validateMission} and the server does so again.
 */
export function missionSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/^-+|-+$/g, '');
}

// --- issue plumbing --------------------------------------------------------

class Ctx {
    readonly errors: MissionIssue[] = [];
    readonly warnings: MissionIssue[] = [];

    err(path: string, message: string): void {
        this.errors.push({ path, message });
    }

    warn(path: string, message: string): void {
        this.warnings.push({ path, message });
    }
}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Required object. Reports and returns undefined when absent or the wrong shape. */
function reqRec(ctx: Ctx, v: unknown, path: string): Rec | undefined {
    if (!isRec(v)) {
        ctx.err(path, 'expected an object');
        return undefined;
    }
    return v;
}

function reqArray(ctx: Ctx, v: unknown, path: string): unknown[] | undefined {
    if (!Array.isArray(v)) {
        ctx.err(path, 'expected an array');
        return undefined;
    }
    return v;
}

function reqString(ctx: Ctx, v: unknown, path: string): string | undefined {
    if (typeof v !== 'string' || v.length === 0) {
        ctx.err(path, 'expected a non-empty string');
        return undefined;
    }
    return v;
}

function optString(ctx: Ctx, v: unknown, path: string): string | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'string') {
        ctx.err(path, 'expected a string');
        return undefined;
    }
    return v;
}

/**
 * Required finite number, optionally range-checked. NaN and Infinity are
 * rejected here rather than downstream: they survive JSON round-trips as
 * `null`, and a NaN latitude becomes a waypoint at an unrenderable position
 * that no later check looks at again.
 */
function reqNumber(
    ctx: Ctx, v: unknown, path: string, min = -Infinity, max = Infinity,
): number | undefined {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        ctx.err(path, 'expected a number');
        return undefined;
    }
    if (v < min || v > max) {
        ctx.err(path, `expected a number between ${min} and ${max}`);
        return undefined;
    }
    return v;
}

function optNumber(
    ctx: Ctx, v: unknown, path: string, min = -Infinity, max = Infinity,
): number | undefined {
    if (v === undefined) return undefined;
    return reqNumber(ctx, v, path, min, max);
}

function reqBool(ctx: Ctx, v: unknown, path: string): boolean | undefined {
    if (typeof v !== 'boolean') {
        ctx.err(path, 'expected true or false');
        return undefined;
    }
    return v;
}

function optBool(ctx: Ctx, v: unknown, path: string): boolean | undefined {
    if (v === undefined) return undefined;
    return reqBool(ctx, v, path);
}

function enumOf<T extends string>(
    ctx: Ctx, v: unknown, path: string, allowed: readonly T[], required: boolean,
): T | undefined {
    if (v === undefined) {
        if (required) ctx.err(path, `expected one of ${allowed.join(', ')}`);
        return undefined;
    }
    if (typeof v !== 'string' || !allowed.includes(v as T)) {
        ctx.err(path, `expected one of ${allowed.join(', ')}`);
        return undefined;
    }
    return v as T;
}

/**
 * An id that is safe as a filename fragment and stable under re-slugging.
 * Callers rely on `missionSlug(id) === id`, so an id is exactly what the
 * sanitiser would have produced — which is what lets the server derive a path
 * from it without a second transformation the client cannot predict.
 */
function reqId(ctx: Ctx, v: unknown, path: string): string | undefined {
    const raw = reqString(ctx, v, path);
    if (raw === undefined) return undefined;
    const slug = missionSlug(raw);
    if (slug.length === 0) {
        ctx.err(path, 'id has no letters or digits');
        return undefined;
    }
    if (slug !== raw) {
        ctx.err(path, `id must be lowercase letters, digits and hyphens (try "${slug}")`);
        return undefined;
    }
    return raw;
}

/** Reports every duplicate after the first, so one pass names them all. */
function assertUnique(ctx: Ctx, ids: (string | undefined)[], pathOf: (i: number) => string): void {
    const seen = new Set<string>();
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (id === undefined) continue;
        if (seen.has(id)) {
            ctx.err(pathOf(i), `duplicate id "${id}"`);
            continue;
        }
        seen.add(id);
    }
}

// --- geometry --------------------------------------------------------------

function toRad(d: number): number {
    return d * Math.PI / 180;
}

/**
 * Initial great-circle bearing a → b, in degrees true. Used only for the
 * course-change warning, so the sphere is plenty: the difference against the
 * ellipsoid is far below the 150 deg threshold it feeds.
 */
function initialBearingDeg(a: MissionPoint, b: MissionPoint): number {
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const dLon = toRad(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Smallest absolute angle between two bearings, 0..180 — so flying north and
 * then south is a change of 180, not of 0.
 */
function bearingDeltaDeg(a: number, b: number): number {
    return Math.abs(((b - a + 540) % 360) - 180);
}

function samePoint(a: MissionPoint, b: MissionPoint): boolean {
    return a.lat === b.lat && a.lon === b.lon;
}

// --- leaves ----------------------------------------------------------------

function readPoint(ctx: Ctx, v: unknown, path: string): MissionPoint | undefined {
    const o = reqRec(ctx, v, path);
    if (o === undefined) return undefined;
    const lat = reqNumber(ctx, o.lat, `${path}.lat`, -90, 90);
    const lon = reqNumber(ctx, o.lon, `${path}.lon`, -180, 180);
    const altitudeM = reqNumber(ctx, o.altitudeM, `${path}.altitudeM`);
    const agl = optBool(ctx, o.agl, `${path}.agl`);
    if (lat === undefined || lon === undefined || altitudeM === undefined) return undefined;
    return { lat, lon, altitudeM, agl: agl ?? false };
}

function readPilot(ctx: Ctx, v: unknown, path: string): MissionPilot | undefined {
    if (v === undefined) return undefined;
    const o = reqRec(ctx, v, path);
    if (o === undefined) return undefined;
    return {
        skill: enumOf(ctx, o.skill, `${path}.skill`, MISSION_SKILLS, false),
        model: enumOf(ctx, o.model, `${path}.model`, MISSION_AI_MODELS, false),
        cruiseAltitudeM: optNumber(ctx, o.cruiseAltitudeM, `${path}.cruiseAltitudeM`, 0),
        cruiseSpeedMps: optNumber(ctx, o.cruiseSpeedMps, `${path}.cruiseSpeedMps`, 0),
        hardDeckM: optNumber(ctx, o.hardDeckM, `${path}.hardDeckM`, 0),
    };
}

function readSpawn(ctx: Ctx, v: unknown, path: string): MissionSpawn | undefined {
    const o = reqRec(ctx, v, path);
    if (o === undefined) return undefined;
    const position = readPoint(ctx, o.position, `${path}.position`);
    const headingDeg = reqNumber(ctx, o.headingDeg, `${path}.headingDeg`, 0, 360);
    const airborne = reqBool(ctx, o.airborne, `${path}.airborne`);
    const speedMps = optNumber(ctx, o.speedMps, `${path}.speedMps`, 0);
    const onGround = optBool(ctx, o.onGround, `${path}.onGround`);
    if (position === undefined || headingDeg === undefined || airborne === undefined) {
        return undefined;
    }
    if (airborne && onGround === true) {
        ctx.err(`${path}.onGround`, 'a spawn cannot be both airborne and on the ground');
        return undefined;
    }
    return { position, headingDeg, airborne, speedMps, onGround: onGround ?? !airborne };
}

function readLeg(ctx: Ctx, v: unknown, path: string): MissionLeg | undefined {
    const o = reqRec(ctx, v, path);
    if (o === undefined) return undefined;
    const id = reqId(ctx, o.id, `${path}.id`);
    const at = readPoint(ctx, o.at, `${path}.at`);
    const action = enumOf<MissionLegAction>(
        ctx, o.action, `${path}.action`, MISSION_LEG_ACTIONS, true);
    const speedMps = optNumber(ctx, o.speedMps, `${path}.speedMps`, 0);
    const captureRadiusM = optNumber(ctx, o.captureRadiusM, `${path}.captureRadiusM`, 1);
    const airfield = optString(ctx, o.airfield, `${path}.airfield`);
    const holdSeconds = optNumber(ctx, o.holdSeconds, `${path}.holdSeconds`, 0);
    const label = optString(ctx, o.label, `${path}.label`);

    // A 'land' leg with no field lands at whatever is nearest — a mission that
    // flies and is wrong, so it is an error rather than a warning.
    if (action === 'land' && (airfield === undefined || airfield.length === 0)) {
        ctx.err(`${path}.airfield`, 'a land leg needs an airfield');
    }
    if (action === 'orbit' && !(holdSeconds !== undefined && holdSeconds > 0)) {
        ctx.err(`${path}.holdSeconds`, 'an orbit leg needs holdSeconds above zero');
    }

    if (id === undefined || at === undefined || action === undefined) return undefined;
    if (action === 'land' && airfield === undefined) return undefined;
    return {
        id,
        at,
        action,
        speedMps,
        captureRadiusM: captureRadiusM ?? DEFAULT_CAPTURE_RADIUS_M,
        airfield,
        holdSeconds: action === 'orbit' ? holdSeconds : (holdSeconds ?? 0),
        label,
    };
}

function readRoute(ctx: Ctx, v: unknown, path: string): MissionRoute | undefined {
    const o = reqRec(ctx, v, path);
    if (o === undefined) return undefined;
    const id = reqId(ctx, o.id, `${path}.id`);
    const name = optString(ctx, o.name, `${path}.name`);
    const loop = reqBool(ctx, o.loop, `${path}.loop`);
    const rawLegs = reqArray(ctx, o.legs, `${path}.legs`);
    if (rawLegs !== undefined && rawLegs.length === 0) {
        ctx.err(`${path}.legs`, 'a route needs at least one leg');
    }

    const legs: MissionLeg[] = [];
    if (rawLegs !== undefined) {
        for (let i = 0; i < rawLegs.length; i++) {
            const leg = readLeg(ctx, rawLegs[i], `${path}.legs[${i}]`);
            if (leg !== undefined) legs.push(leg);
        }
        assertUnique(ctx, legs.map(l => l.id), i => `${path}.legs[${i}].id`);
    }

    // The turn latch commits past 150 deg and will not take the shorter side,
    // so a near-reversal flies as a wide committed turn. Correct, and it reads
    // as a bug in the air — say so here instead.
    for (let i = 1; i < legs.length - 1; i++) {
        const prev = legs[i - 1].at;
        const here = legs[i].at;
        const next = legs[i + 1].at;
        if (samePoint(prev, here) || samePoint(here, next)) continue;
        const change = bearingDeltaDeg(
            initialBearingDeg(prev, here), initialBearingDeg(here, next));
        if (change > MISSION_COURSE_WARN_DEG) {
            ctx.warn(
                `${path}.legs[${i}]`,
                `turns ${Math.round(change)} deg — the ai will fly a wide committed reversal`);
        }
    }

    if (id === undefined || loop === undefined || rawLegs === undefined || legs.length === 0) {
        return undefined;
    }
    return { id, name, loop, legs };
}

function readFlight(ctx: Ctx, v: unknown, path: string): MissionFlight | undefined {
    const o = reqRec(ctx, v, path);
    if (o === undefined) return undefined;
    const id = reqId(ctx, o.id, `${path}.id`);
    const name = optString(ctx, o.name, `${path}.name`);
    const faction = enumOf<MissionFaction>(
        ctx, o.faction, `${path}.faction`, MISSION_FACTIONS, true);
    const aircraftType = optString(ctx, o.aircraftType, `${path}.aircraftType`);
    const aircraftCanonicalName =
        optString(ctx, o.aircraftCanonicalName, `${path}.aircraftCanonicalName`);
    const count = reqNumber(ctx, o.count, `${path}.count`, 1, MISSION_MAX_FLIGHT_SIZE);
    const start = readSpawn(ctx, o.start, `${path}.start`);
    const routeId = optString(ctx, o.routeId, `${path}.routeId`);
    const engages = enumOf<MissionFaction>(
        ctx, o.engages, `${path}.engages`, MISSION_FACTIONS, false);
    const pilot = readPilot(ctx, o.pilot, `${path}.pilot`);

    if (count !== undefined && !Number.isInteger(count)) {
        ctx.err(`${path}.count`, 'expected a whole number of aircraft');
        return undefined;
    }
    if (id === undefined || faction === undefined || count === undefined || start === undefined) {
        return undefined;
    }
    return {
        id, name, faction, aircraftType, aircraftCanonicalName,
        count, start, routeId, engages, pilot,
    };
}

function readPlayer(ctx: Ctx, v: unknown, path: string): MissionPlayerStart | undefined {
    const o = reqRec(ctx, v, path);
    if (o === undefined) return undefined;
    const airfield = optString(ctx, o.airfield, `${path}.airfield`);
    const position = o.position === undefined
        ? undefined
        : readPoint(ctx, o.position, `${path}.position`);
    const headingDeg = optNumber(ctx, o.headingDeg, `${path}.headingDeg`, 0, 360);
    const airborne = reqBool(ctx, o.airborne, `${path}.airborne`);
    const speedMps = optNumber(ctx, o.speedMps, `${path}.speedMps`, 0);
    const aircraftType = optString(ctx, o.aircraftType, `${path}.aircraftType`);

    // With neither an airfield nor a position there is nothing to start from,
    // and the fallback would be the player's last spawn preference — which
    // makes the same mission start somewhere else for each person who flies it.
    if (airfield === undefined && position === undefined) {
        ctx.err(path, 'the player start needs an airfield or a position');
    }
    if (airborne === true && position === undefined && headingDeg === undefined) {
        ctx.warn(path, 'an airborne start off a runway will use the runway heading');
    }
    if (airborne === undefined || (airfield === undefined && position === undefined)) {
        return undefined;
    }
    return { airfield, position, headingDeg, airborne, speedMps, aircraftType };
}

// --- the document ----------------------------------------------------------

/**
 * Total; never throws, whatever `value` is. Returns every problem it can find
 * in one pass rather than the first, because the editor renders the whole list
 * and a person fixing a mission by hand should not have to re-save five times
 * to see five errors.
 */
export function validateMission(value: unknown): MissionValidation {
    const ctx = new Ctx();
    const root = reqRec(ctx, value, '');
    if (root === undefined) {
        return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
    }

    if (root.scheme !== MISSION_SCHEME) {
        ctx.err('scheme', `expected "${MISSION_SCHEME}"`);
    }
    const version = reqNumber(ctx, root.version, 'version', 1);
    if (version !== undefined && !Number.isInteger(version)) {
        ctx.err('version', 'expected a whole number');
    } else if (version !== undefined && version > MISSION_VERSION) {
        // Reading it anyway would drop every field this build cannot see, and
        // the editor would write that loss back on the next save.
        ctx.err('version', `mission needs a newer build (this one reads up to ${MISSION_VERSION})`);
    }

    const id = reqId(ctx, root.id, 'id');
    const name = reqString(ctx, root.name, 'name');
    const area = reqString(ctx, root.area, 'area');
    const description = optString(ctx, root.description, 'description');
    const savedUtc = optString(ctx, root.savedUtc, 'savedUtc');
    const player = readPlayer(ctx, root.player, 'player');

    const rawFlights = reqArray(ctx, root.flights, 'flights');
    const flights: MissionFlight[] = [];
    if (rawFlights !== undefined) {
        for (let i = 0; i < rawFlights.length; i++) {
            const flight = readFlight(ctx, rawFlights[i], `flights[${i}]`);
            if (flight !== undefined) flights.push(flight);
        }
        assertUnique(ctx, flights.map(f => f.id), i => `flights[${i}].id`);
    }

    const rawRoutes = reqArray(ctx, root.routes, 'routes');
    const routes: MissionRoute[] = [];
    if (rawRoutes !== undefined) {
        for (let i = 0; i < rawRoutes.length; i++) {
            const route = readRoute(ctx, rawRoutes[i], `routes[${i}]`);
            if (route !== undefined) routes.push(route);
        }
        assertUnique(ctx, routes.map(r => r.id), i => `routes[${i}].id`);
    }

    // Cross-references and budgets, once the collections are known good.
    const routeIds = new Set(routes.map(r => r.id));
    for (let i = 0; i < flights.length; i++) {
        const routeId = flights[i].routeId;
        if (routeId !== undefined && !routeIds.has(routeId)) {
            ctx.err(`flights[${i}].routeId`, `no route with id "${routeId}"`);
        }
    }
    const flownRoutes = new Set(flights.map(f => f.routeId).filter(r => r !== undefined));
    for (let i = 0; i < routes.length; i++) {
        if (!flownRoutes.has(routes[i].id)) {
            ctx.warn(`routes[${i}]`, 'no flight is assigned to this route');
        }
    }

    // Faction budgets. Over-budget is an error rather than a clamp: dropping
    // half a mission's opposition on load is worse than refusing to load it.
    const budget: Record<MissionFaction, number> = { enemy: MISSION_MAX_ENEMY, player: MISSION_MAX_FRIENDLY };
    for (const faction of MISSION_FACTIONS) {
        const total = flights
            .filter(f => f.faction === faction)
            .reduce((n, f) => n + f.count, 0);
        if (total > budget[faction]) {
            ctx.err(
                'flights',
                `${total} ${faction} aircraft exceeds the limit of ${budget[faction]}`);
        }
    }

    if (ctx.errors.length > 0
        || id === undefined || name === undefined || area === undefined
        || version === undefined || player === undefined
        || rawFlights === undefined || rawRoutes === undefined) {
        return { ok: false, errors: ctx.errors, warnings: ctx.warnings };
    }

    const doc: MissionDoc = {
        scheme: MISSION_SCHEME,
        version,
        id,
        name,
        area,
        description,
        savedUtc,
        player,
        flights,
        routes,
    };
    return { ok: true, doc, errors: ctx.errors, warnings: ctx.warnings };
}

/**
 * An airfield's lights after dark, laid out from the runways, taxiways and
 * furniture the bake already describes.
 *
 * Generated rather than read from OSM: OSM's `lit=yes` is on 7 of the 1,527
 * baked runways, and the few fields mapped light by light (GCLP's 2,123
 * `navigationaid` nodes) are the exception. The layout follows ICAO Annex 14
 * in its proportions - edge lights every 60 m, approach lights out to 900 m
 * with a crossbar at 300 m, a PAPI 300 m in - so a field reads at night the
 * way a real one does from the cockpit.
 *
 * Every light is a point that is only attached at night (`userData.time`, see
 * modelMatchesPaletteTime), and some of them work:
 * - a PAPI unit shows white above its setting and red below it, so the row
 *   reads two-white-two-red on a 3 degree approach;
 * - threshold lights are green from the approach and runway end lights red
 *   from the runway, from the same fixtures, as the real ones are;
 * - the sequenced flashers of an approach light system run in towards the
 *   threshold twice a second.
 */
import * as THREE from 'three';
import { PaletteCategory, PaletteTime } from '../../config/palettes/palette';
import { Airfield, AirfieldBuilding, AirfieldNavigationAid, AirfieldRunway } from '../../terrain/airfields';
import { bearingAxisAt } from '../../terrain/flattenPad';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials/materials';
import { updateUniforms } from '../utils';

type EN = { e: number; n: number };
type Place = (e: number, n: number, lift: number) => THREE.Vector3;
type ToEnu = (lat: number, lon: number) => EN;

/** How far above the surface it stands on a light is drawn, on top of `surfaceLift`. */
const LIGHT_HEIGHT_M = 0.4;
/** Runway edge lights: spacing along, and how far outside the pavement edge. */
const EDGE_SPACING_M = 60;
const EDGE_OUTSIDE_M = 1.5;
/** Runway centreline lights, on runways at least CENTRELINE_MIN_WIDTH_M wide. */
const CENTRELINE_SPACING_M = 30;
const CENTRELINE_MIN_WIDTH_M = 45;
/** Threshold and end lights: spacing across, and how far outside the threshold. */
const THRESHOLD_SPACING_M = 3;
const THRESHOLD_OUTSIDE_M = 1;
/** Approach lights: barrettes every ALS_SPACING_M out to ALS_LENGTH_M, a crossbar at ALS_CROSSBAR_M. */
const ALS_SPACING_M = 30;
const ALS_LENGTH_M = 900;
const ALS_CROSSBAR_M = 300;
const ALS_CROSSBAR_HALF_M = 15;
const ALS_CROSSBAR_SPACING_M = 1.5;
/** Each barrette: this many lights, this far apart. */
const ALS_BARRETTE_LIGHTS = 5;
const ALS_BARRETTE_SPACING_M = 1.05;
/** The sequenced flashers run from ALS_LENGTH_M in to here, twice a second. */
const FLASHER_INNER_M = 330;
const FLASHER_CYCLE_S = 0.5;
/** Runways this long get an approach light system. */
const ALS_MIN_LENGTH_M = 1800;
/** Runways this long get lights at all, unless OSM says they are lit. */
const LIT_MIN_LENGTH_M = 800;
/**
 * A generated PAPI: this far in from the threshold (at most a fifth of the
 * runway), its inner unit this far outside the edge, units this far apart.
 */
const PAPI_DISTANCE_M = 300;
const PAPI_EDGE_M = 15;
const PAPI_SPACING_M = 9;
/** Unit settings, degrees, inner unit first: two white, two red at 3 degrees. */
const PAPI_SETTINGS_DEG = [3.5, 3 + 1 / 6, 3 - 1 / 6, 2.5];
/** An APAPI's (or a VASI's) two units. */
const APAPI_SETTINGS_DEG = [3.25, 2.75];
/** An OSM PAPI serves the threshold it is within this of, along the runway. */
const PAPI_REACH_M = 800;
/** Units of one type closer than this are each mapped as its own node. */
const PAPI_UNIT_CLUSTER_M = 40;
/** Units in a mapped installation, when the node stands for the whole row. */
const NAVAID_UNITS: Record<string, number> = { papi: 4, apapi: 2, vasi: 2 };
/**
 * Taxiway edge lights: spacing, and how far outside the edge. Real ones are
 * every 30 m on a straight; at that, and at runway-light size, GCLP's eighty
 * taxiways drowned the runways in blue.
 */
const TAXIWAY_SPACING_M = 45;
const TAXIWAY_OUTSIDE_M = 0.8;
/** No taxiway light this close to a runway's pavement. */
const TAXIWAY_RUNWAY_CLEAR_M = 10;
/** A helipad's perimeter lights, per side, corners included. */
const HELIPAD_LIGHTS_PER_SIDE = 3;

/**
 * Light sizes: metres across as seen, and the least and most pixels; and the
 * distance they fade out over (metres from the camera, whole to gone), the
 * brighter the farther.
 */
const STEADY = { sizeM: 1.2, sizePx: 2, maxPx: 6, fadeM: [3000, 8000] as const };
const BRIGHT = { sizeM: 2, sizePx: 2, maxPx: 8, fadeM: [5000, 12000] as const };
const FLASH = { sizeM: 4, sizePx: 3, maxPx: 12, fadeM: [8000, 16000] as const };
/** Taxiway lights are a fraction of a runway light's intensity: a pixel from afar. */
const DIM = { sizeM: 0.8, sizePx: 1, maxPx: 4, fadeM: [1500, 4000] as const };
type LightSize = { sizeM: number; sizePx: number; maxPx: number; fadeM: readonly [number, number] };

/** A runway is lit when OSM says so, or when it is a paved runway of some length at a field that is not a club strip. */
export function runwayIsLit(runway: AirfieldRunway, airfield: Airfield): boolean {
    if (runway.skiJump || runway.surface === 'metal') {
        return false;
    }
    if (runway.lit) {
        return true;
    }
    const paved = runway.surface === 'asphalt' || runway.surface === 'concrete';
    return paved && airfield.kind !== 'ga' && runway.lengthM >= LIT_MIN_LENGTH_M;
}

/** One light unit of a mapped PAPI, APAPI or VASI, and the runway axis it faces along. */
export interface NavaidUnit {
    aid: AirfieldNavigationAid;
    centre: EN;
    axis: EN;
}

/**
 * The light units of the mapped slope indicators: a row across the runway
 * centred on the node, or one unit per node where each is mapped as its own.
 * An aid beside no runway (no heading) has none.
 */
export function navaidUnits(airfield: Airfield, toEnu: ToEnu): NavaidUnit[] {
    const aids = airfield.navigationAids ?? [];
    const at = aids.map(a => toEnu(a.lat, a.lon));
    const units: NavaidUnit[] = [];
    aids.forEach((aid, i) => {
        const count = NAVAID_UNITS[aid.type];
        if (count === undefined || aid.headingDeg === undefined) {
            return;
        }
        const single = aids.some((other, j) => j !== i && other.type === aid.type
            && Math.hypot(at[j].e - at[i].e, at[j].n - at[i].n) < PAPI_UNIT_CLUSTER_M);
        const axis = bearingAxisAt(aid.lat, aid.lon, aid.headingDeg, toEnu);
        const n = single ? 1 : count;
        for (let k = 0; k < n; k++) {
            units.push({ aid, centre: offset(at[i], axis, 0, (k - (n - 1) / 2) * PAPI_SPACING_M), axis });
        }
    });
    return units;
}

/** `centre` moved `along` metres down `axis` and `across` to its right. */
function offset(centre: EN, axis: EN, along: number, across: number): EN {
    return {
        e: centre.e + axis.e * along + axis.n * across,
        n: centre.n + axis.n * along - axis.e * across,
    };
}

/**
 * Which PAPI units show white to an eye at `eye`: those it sees at more than
 * their setting above the horizontal. All of them world-space, Y up.
 */
export function papiWhite(units: readonly THREE.Vector3[], settingsDeg: readonly number[], eye: THREE.Vector3): boolean[] {
    return units.map((u, k) => {
        const angle = Math.atan2(eye.y - u.y, Math.hypot(eye.x - u.x, eye.z - u.z)) * 180 / Math.PI;
        return angle > settingsDeg[k];
    });
}

/** Points with something to do before each draw, given the eye and the time. */
class LightPoints extends THREE.Points {
    constructor(
        geometry: THREE.BufferGeometry, material: THREE.Material,
        readonly onEye?: (points: LightPoints, eye: THREE.Vector3, timeS: number) => void,
    ) {
        super(geometry, material);
        this.userData.time = PaletteTime.NIGHT;
        this.onBeforeRender = (renderer, scene, camera, g, m, group) => {
            updateUniforms.call(this as unknown as THREE.Mesh, renderer, scene, camera, g, m, group as THREE.Group);
            if (this.onEye !== undefined) {
                this.onEye(this, camera.getWorldPosition(_eye), performance.now() / 1000);
            }
        };
    }

    /** The world position of local point `p`. */
    world(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
        return out.copy(p).applyMatrix4(this.matrixWorld);
    }
}

const _eye = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

interface LightGroup {
    category: PaletteCategory;
    size: LightSize;
    points: THREE.Vector3[];
    onEye?: (points: LightPoints, eye: THREE.Vector3, timeS: number) => void;
}

/**
 * Shown only to an eye on the far side of the line through `at` square to
 * `facing` - the side `facing` points to.
 */
function facingOnly(at: THREE.Vector3, facing: THREE.Vector3) {
    const tip = at.clone().add(facing);
    return (points: LightPoints, eye: THREE.Vector3) => {
        const a = points.world(at, _a);
        const b = points.world(tip, _b).sub(a);
        const seen = eye.clone().sub(a).dot(b) > 0;
        points.geometry.setDrawRange(0, seen ? Infinity : 0);
    };
}

/**
 * The lights of one airfield, as night-only points in the model's frame:
 * `place` is the graded surface the runways are laid on, `drape` the ground,
 * both already lifted to the model's origin. One set per call; each LOD level
 * needs its own, an object having one parent.
 */
export function buildAirfieldLights(
    airfield: Airfield, toEnu: ToEnu, place: Place, drape: Place,
    surfaceLift: number, materials: SceneMaterialManager,
    buildingHeight: (building: AirfieldBuilding) => number,
): THREE.Object3D[] {
    const lit = airfield.runways.filter(r => runwayIsLit(r, airfield));
    if (lit.length === 0) {
        return [];
    }
    const lift = surfaceLift + LIGHT_HEIGHT_M;
    const groups: LightGroup[] = [];
    const steady = (category: PaletteCategory, size: LightSize = STEADY) => {
        const group: LightGroup = { category, size, points: [] };
        groups.push(group);
        return group.points;
    };
    const edges = steady(PaletteCategory.LIGHT_WHITE);
    const taxiway = steady(PaletteCategory.LIGHT_BLUE, DIM);
    const obstruction = steady(PaletteCategory.LIGHT_RED);
    const helipad = steady(PaletteCategory.LIGHT_GREEN);
    const approach = steady(PaletteCategory.LIGHT_WHITE);
    const papiUnits = navaidUnits(airfield, toEnu);

    const rects = lit.map(runway => {
        const a = toEnu(runway.thresholds[0][0], runway.thresholds[0][1]);
        const b = toEnu(runway.thresholds[1][0], runway.thresholds[1][1]);
        const length = Math.hypot(b.e - a.e, b.n - a.n);
        return { runway, a, b, length, axis: { e: (b.e - a.e) / length, n: (b.n - a.n) / length } };
    }).filter(r => r.length > 1);

    for (const { runway, a, length, axis } of rects) {
        const half = runway.widthM / 2;
        const at = (along: number, across: number, h = lift) => {
            const p = offset(a, axis, along, across);
            return place(p.e, p.n, h);
        };
        // Edge lights, both sides, from threshold to threshold.
        const edgeCount = Math.max(2, Math.round(length / EDGE_SPACING_M) + 1);
        for (let k = 0; k < edgeCount; k++) {
            const along = length * k / (edgeCount - 1);
            edges.push(at(along, -half - EDGE_OUTSIDE_M), at(along, half + EDGE_OUTSIDE_M));
        }
        if (runway.widthM >= CENTRELINE_MIN_WIDTH_M && airfield.kind === 'international') {
            for (let along = CENTRELINE_SPACING_M / 2; along < length; along += CENTRELINE_SPACING_M) {
                edges.push(at(along, 0, surfaceLift + 0.1));
            }
        }
        // Each end: green threshold lights seen from the approach, red end
        // lights seen from the runway, at the same fixtures.
        for (const end of [0, 1] as const) {
            const along = end === 0 ? -THRESHOLD_OUTSIDE_M : length + THRESHOLD_OUTSIDE_M;
            // Out of the runway, towards the approach to this end.
            const out = end === 0 ? -1 : 1;
            const bar: THREE.Vector3[] = [];
            for (let across = -half; across <= half + 1e-6; across += THRESHOLD_SPACING_M) {
                bar.push(at(along, across));
            }
            const centre = at(along, 0);
            const outward = at(along + out, 0).sub(centre);
            groups.push({ category: PaletteCategory.LIGHT_GREEN, size: BRIGHT, points: bar,
                onEye: facingOnly(centre, outward) });
            groups.push({ category: PaletteCategory.LIGHT_RED, size: STEADY, points: bar,
                onEye: facingOnly(centre, outward.clone().negate()) });

            const threshold = offset(a, axis, end === 0 ? 0 : length, 0);
            // The landing direction onto this end, and the approach behind it.
            const landing = end === 0 ? axis : { e: -axis.e, n: -axis.n };
            if (length >= ALS_MIN_LENGTH_M && airfield.kind !== 'ga') {
                // On poles over a dip: never below the threshold, as the real
                // ones stand. Draped instead, the lights followed every fold of
                // the ground and the centreline came out bent.
                const floorY = place(threshold.e, threshold.n, lift).y;
                const ground = (d: number, across: number) => {
                    const p = offset(threshold, landing, -d, across);
                    const v = drape(p.e, p.n, lift);
                    return v.setY(Math.max(v.y, floorY));
                };
                const flashers: THREE.Vector3[] = [];
                for (let d = ALS_SPACING_M; d <= ALS_LENGTH_M + 1e-6; d += ALS_SPACING_M) {
                    for (let k = 0; k < ALS_BARRETTE_LIGHTS; k++) {
                        approach.push(ground(d, (k - (ALS_BARRETTE_LIGHTS - 1) / 2) * ALS_BARRETTE_SPACING_M));
                    }
                    if (d >= FLASHER_INNER_M) {
                        flashers.push(ground(d, 0).add(new THREE.Vector3(0, 0.5, 0)));
                    }
                }
                for (let across = -ALS_CROSSBAR_HALF_M; across <= ALS_CROSSBAR_HALF_M + 1e-6; across += ALS_CROSSBAR_SPACING_M) {
                    if (Math.abs(across) > ALS_BARRETTE_SPACING_M * ALS_BARRETTE_LIGHTS / 2) {
                        approach.push(ground(ALS_CROSSBAR_M, across));
                    }
                }
                // Outermost first: the flash runs in towards the threshold.
                flashers.reverse();
                groups.push({
                    category: PaletteCategory.LIGHT_WHITE, size: FLASH, points: flashers,
                    onEye: (points, _eye, timeS) => {
                        const phase = (timeS % FLASHER_CYCLE_S) / FLASHER_CYCLE_S;
                        points.geometry.setDrawRange(Math.min(flashers.length - 1, Math.floor(phase * flashers.length)), 1);
                    },
                });
            }
            addPapi(groups, runway, threshold, landing, length, half, papiUnits, drape, lift);
        }
    }

    // Blue taxiway edge lights, kept clear of the runways they lead onto.
    const nearRunway = (p: EN) => rects.some(r => {
        const de = p.e - r.a.e;
        const dn = p.n - r.a.n;
        const along = de * r.axis.e + dn * r.axis.n;
        const across = de * r.axis.n - dn * r.axis.e;
        return along > -TAXIWAY_RUNWAY_CLEAR_M && along < r.length + TAXIWAY_RUNWAY_CLEAR_M
            && Math.abs(across) < r.runway.widthM / 2 + TAXIWAY_RUNWAY_CLEAR_M;
    });
    for (const tw of airfield.taxiways) {
        if (tw.taxilane) {
            continue;
        }
        const pts = tw.points.map(p => toEnu(p[0], p[1]));
        let carry = 0;
        for (let i = 0; i + 1 < pts.length; i++) {
            const len = Math.hypot(pts[i + 1].e - pts[i].e, pts[i + 1].n - pts[i].n);
            if (len < 0.01) {
                continue;
            }
            const axis = { e: (pts[i + 1].e - pts[i].e) / len, n: (pts[i + 1].n - pts[i].n) / len };
            for (let s = carry; s < len; s += TAXIWAY_SPACING_M) {
                for (const side of [-1, 1]) {
                    const p = offset(pts[i], axis, s, side * (tw.widthM / 2 + TAXIWAY_OUTSIDE_M));
                    if (!nearRunway(p)) {
                        taxiway.push(drape(p.e, p.n, lift));
                    }
                }
            }
            carry = (carry - len) % TAXIWAY_SPACING_M;
            carry = carry < 0 ? carry + TAXIWAY_SPACING_M : carry;
        }
    }

    // A red obstruction light on every control tower; a white one on a lit windsock.
    for (const building of airfield.buildings) {
        if (building.kind === 'tower') {
            const c = toEnu(building.lat, building.lon);
            obstruction.push(drape(c.e, c.n, buildingHeight(building) + 0.5));
        }
    }
    for (const sock of airfield.windsocks ?? []) {
        if (sock.lit) {
            const c = toEnu(sock.lat, sock.lon);
            edges.push(drape(c.e, c.n, 6.3));
        }
    }
    // Green perimeter lights round each helipad.
    for (const pad of airfield.helipads ?? []) {
        const c = toEnu(pad.lat, pad.lon);
        const axis = bearingAxisAt(pad.lat, pad.lon, pad.headingDeg, toEnu);
        const hd = pad.depthM / 2;
        const hw = pad.widthM / 2;
        const steps = HELIPAD_LIGHTS_PER_SIDE - 1;
        for (let k = 0; k < steps; k++) {
            const t = -1 + 2 * k / steps;
            for (const p of [offset(c, axis, hd * t, -hw), offset(c, axis, hd, hw * t),
                offset(c, axis, -hd * t, hw), offset(c, axis, -hd, -hw * t)]) {
                helipad.push(drape(p.e, p.n, lift));
            }
        }
    }

    const materialsBySize = new Map<string, THREE.Material>();
    const materialFor = (category: PaletteCategory, size: LightSize) => {
        const key = category + '|' + size.sizeM;
        let material = materialsBySize.get(key);
        if (material === undefined) {
            material = materials.build({
                type: SceneMaterialPrimitiveType.POINT, category, depthWrite: false, ...size,
            });
            materialsBySize.set(key, material);
        }
        return material;
    };
    return groups.filter(g => g.points.length > 0).map(g => {
        const geometry = new THREE.BufferGeometry().setFromPoints(g.points);
        geometry.computeBoundingSphere();
        return new LightPoints(geometry, materialFor(g.category, g.size), g.onEye);
    });
}

/**
 * The PAPI at one runway end: the mapped units that serve it, else a
 * generated four-unit row on the left of the landing direction, PAPI_DISTANCE_M
 * in. Each installation is two point sets, white and red, that swap units
 * between them as the eye's angle above each unit crosses its setting; from
 * behind, it shows nothing.
 */
function addPapi(
    groups: LightGroup[], runway: AirfieldRunway, threshold: EN, landing: EN,
    length: number, half: number, mapped: readonly NavaidUnit[],
    place: Place, lift: number,
): void {
    // Mapped units within reach of this end, beside this runway, by side.
    const left = { e: -landing.n, n: landing.e };
    const sides = new Map<number, { across: number; at: EN; settings?: number[] }[]>();
    for (const unit of mapped) {
        if (unit.aid.runway !== undefined && unit.aid.runway !== runway.ref) {
            continue;
        }
        const de = unit.centre.e - threshold.e;
        const dn = unit.centre.n - threshold.n;
        const along = de * landing.e + dn * landing.n;
        const across = de * left.e + dn * left.n;
        if (along < 0 || along > Math.min(PAPI_REACH_M, length / 2) || Math.abs(across) < half) {
            continue;
        }
        const side = Math.sign(across);
        const row = sides.get(side) ?? [];
        row.push({ across: Math.abs(across), at: unit.centre, settings: unit.aid.type === 'papi' ? undefined : APAPI_SETTINGS_DEG });
        sides.set(side, row);
    }
    if (sides.size === 0) {
        const along = Math.min(PAPI_DISTANCE_M, length / 5);
        sides.set(1, PAPI_SETTINGS_DEG.map((_, k) => {
            const across = half + PAPI_EDGE_M + k * PAPI_SPACING_M;
            return {
                across,
                at: { e: threshold.e + landing.e * along + left.e * across, n: threshold.n + landing.n * along + left.n * across },
            };
        }));
    }
    for (const row of sides.values()) {
        row.sort((x, y) => x.across - y.across);
        const settings = row.length === 4 ? PAPI_SETTINGS_DEG
            : row.length === 2 ? (row[0].settings ?? APAPI_SETTINGS_DEG)
                : row.map((_, k) => row.length === 1 ? 3 : 3.5 - k / (row.length - 1));
        const units = row.map(u => place(u.at.e, u.at.n, lift + 0.3));
        const behind = place(threshold.e, threshold.n, lift);
        const outward = place(threshold.e - landing.e, threshold.n - landing.n, lift).sub(behind);
        const show = facingOnly(behind, outward);
        const swap = (white: boolean) => (points: LightPoints, eye: THREE.Vector3) => {
            show(points, eye);
            if (points.geometry.drawRange.count === 0) {
                return;
            }
            const world = units.map(u => points.world(u, new THREE.Vector3()));
            const isWhite = papiWhite(world, settings, eye);
            const position = points.geometry.getAttribute('position') as THREE.BufferAttribute;
            let n = 0;
            units.forEach((u, k) => {
                if (isWhite[k] === white) {
                    position.setXYZ(n++, u.x, u.y, u.z);
                }
            });
            position.needsUpdate = n > 0;
            points.geometry.setDrawRange(0, n);
        };
        groups.push({ category: PaletteCategory.LIGHT_WHITE, size: BRIGHT, points: units.map(u => u.clone()), onEye: swap(true) });
        groups.push({ category: PaletteCategory.LIGHT_RED, size: BRIGHT, points: units.map(u => u.clone()), onEye: swap(false) });
    }
}

/**
 * The Kuznetsov's lights, in carrier-local metres, and the Luna optical
 * landing system (the "meatball").
 *
 * Deck lights are night-only points built the way an airfield's are
 * (airfieldLights.ts): edge lights along the landing area's foul lines, flush
 * centreline lights, a red row across the stern ramp, amber drop lights down
 * the transom under the angled centreline, yellow lights along the ski-jump
 * lanes, a red row at the lip and the ship's navigation lights.
 *
 * The Luna stands out past the port deck edge, 50 m forward of wires 2-3, facing aft down
 * the angled deck, and is lit day and night. Between two rows of green datum
 * lights, a column of five cells shows one light: amber level with the datums
 * on the glide path, higher when the eye is high, lower when low, and the
 * bottom cell red when dangerously low. The path is the one the HUD's
 * meatball flies (approachAids.ts), measured from the eye.
 */
import * as THREE from 'three';
import { PaletteCategory } from '../../config/palettes/palette';
import { BRIGHT, DIM, LightPoints, LightSize, STEADY, facingOnly } from '../airfield/airfieldLights';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials/materials';
import {
    ANGLED_DECK_AXIS,
    ANGLED_DECK_END_STATION_M,
    ANGLED_DECK_RIGHT,
    CARRIER_GLIDESLOPE_DEG,
    KUZ_CENTRELINE_X,
    LANDING_AREA_HALF_WIDTH_M,
    SKI_JUMP_LIP_Z,
    TAKEOFF_POSITIONS,
    angledDeckPoint,
} from './carrierDeckLayout';
import { CarrierDeckSurface } from './carrierDeckSurface';
import {
    CARRIER_EYE_ABOVE_HOOK_M,
    carrierGlidePathLocal,
} from './overlay/approachAids';

/** Deck lights stand this far above the deck (m). */
const LIGHT_LIFT_M = 0.25;
const EDGE_SPACING_M = 15;
const CENTRELINE_SPACING_M = 15;
const RAMP_SPACING_M = 3;
const DROP_LIGHTS = 8;
const DROP_SPACING_M = 1;
const LANE_SPACING_M = 10;
const LIP_SPACING_M = 2.5;

/**
 * Luna: where it stands (station along the angled deck, m) and how far
 * outboard of the foul line - out past the port deck edge, on its post.
 */
export const LUNA_STATION_M = 114;
const LUNA_OUTBOARD_M = 19;
/** Cell spacing and datum arms (m): larger than the real lens so it reads on a screen from a mile. */
const LUNA_CELL_SPACING_M = 0.9;
const LUNA_CELLS = 5;
const LUNA_DATUM_LIGHTS = 4;
const LUNA_DATUM_SPACING_M = 1.4;
const LUNA_DATUM_GAP_M = 1.5;
/** Height of the datum row above the deck (m). */
const LUNA_DATUM_HEIGHT_M = 3;
/** Degrees off the path per cell; the bottom cell (and below) is red. */
export const LUNA_DEG_PER_CELL = 0.4;
/** Seen only from within this angle either side of the approach (deg). */
const LUNA_AZIMUTH_HALF_DEG = 25;
/** The Luna's lights: bigger and lit by day; gone a little past the 2.5 km approach start. */
const LUNA_SIZE: LightSize = { sizeM: 0.7, sizePx: 4, maxPx: 14, fadeM: [0, 6000] };

/** Navigation light positions on the island (carrier-local, from kuz.glb). */
const MASTHEAD = new THREE.Vector3(30.08, 53.4, -0.04);
const STARBOARD_SIDELIGHT = new THREE.Vector3(38.5, 30, -10);
const PORT_SIDELIGHT = new THREE.Vector3(15.2, 30, -10);
const STERN_LIGHT_Z_PAST = 0.3;

/**
 * Which Luna cell the eye sees lit, 0 the top to LUNA_CELLS − 1 the bottom
 * (centre = on the path), from how far above the path it is (deg).
 */
export function lunaCell(aboveDeg: number): number {
    const middle = (LUNA_CELLS - 1) / 2;
    const k = Math.round(middle - aboveDeg / LUNA_DEG_PER_CELL);
    return Math.max(0, Math.min(LUNA_CELLS - 1, k));
}

/** The Luna's cell as seen from a carrier-local eye, or −1 when it cannot be seen. */
export function lunaCellForEye(x: number, y: number, z: number): number {
    const g = carrierGlidePathLocal(x, y, z, CARRIER_EYE_ABOVE_HOOK_M);
    if (g.short <= 0) return -1;
    if (Math.abs(Math.atan2(g.offset, g.short)) > (LUNA_AZIMUTH_HALF_DEG * Math.PI) / 180) return -1;
    return lunaCell(g.angleDeg - CARRIER_GLIDESLOPE_DEG);
}

const _eye = new THREE.Vector3();
const _inv = new THREE.Matrix4();

/** The ship's lights: night-only deck and navigation lights, plus the all-day Luna. */
export function buildCarrierLights(
    deck: CarrierDeckSurface, materials: SceneMaterialManager,
): { night: THREE.Object3D[]; luna: THREE.Object3D[] } {
    const night: THREE.Object3D[] = [];
    const luna: THREE.Object3D[] = [];
    const materialFor = new Map<string, THREE.Material>();
    const make = (
        category: PaletteCategory, size: LightSize, points: THREE.Vector3[],
        onEye?: (p: LightPoints, eye: THREE.Vector3, t: number) => void, allDay = false,
    ): LightPoints | undefined => {
        if (points.length === 0) return undefined;
        const key = category + '|' + size.sizeM + '|' + size.sizePx;
        let material = materialFor.get(key);
        if (material === undefined) {
            material = materials.build({ type: SceneMaterialPrimitiveType.POINT, category, depthWrite: false, ...size });
            materialFor.set(key, material);
        }
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        geometry.computeBoundingSphere();
        const p = new LightPoints(geometry, material, onEye, allDay);
        p.frustumCulled = false;
        return p;
    };
    const add = (list: THREE.Object3D[], p: LightPoints | undefined) => {
        if (p) list.push(p);
    };
    /** A point on the deck, `lift` up; undefined off the deck. */
    const onDeck = (x: number, z: number, lift = LIGHT_LIFT_M): THREE.Vector3 | undefined => {
        const y = deck.heightAt(x, z);
        return Number.isFinite(y) ? new THREE.Vector3(x, y + lift, z) : undefined;
    };
    const along = (
        from: { x: number; z: number }, to: { x: number; z: number }, spacing: number,
    ): THREE.Vector3[] => {
        const len = Math.hypot(to.x - from.x, to.z - from.z);
        const n = Math.max(1, Math.round(len / spacing));
        const out: THREE.Vector3[] = [];
        for (let i = 0; i <= n; i++) {
            const t = i / n;
            const p = onDeck(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t);
            if (p) out.push(p);
        }
        return out;
    };
    const aft = new THREE.Vector3(-ANGLED_DECK_AXIS.x, 0, -ANGLED_DECK_AXIS.z);

    // Where the deck starts along the angled axis (the stern edge under it).
    let sternStation = -5;
    while (sternStation < 20 && !Number.isFinite(deck.heightAt(angledDeckPoint(sternStation).x, angledDeckPoint(sternStation).z))) {
        sternStation += 0.25;
    }
    const end = ANGLED_DECK_END_STATION_M + 5;
    const hw = LANDING_AREA_HALF_WIDTH_M;

    // Landing area: white edge lights on both foul lines, flush centreline lights.
    add(night, make(PaletteCategory.LIGHT_WHITE, STEADY, [
        ...along(angledDeckPoint(sternStation + 1, -hw), angledDeckPoint(end, -hw), EDGE_SPACING_M),
        ...along(angledDeckPoint(sternStation + 1, hw), angledDeckPoint(190, hw), EDGE_SPACING_M),
    ]));
    add(night, make(PaletteCategory.LIGHT_WHITE, DIM,
        along(angledDeckPoint(sternStation + 2), angledDeckPoint(end), CENTRELINE_SPACING_M)));
    // Red across the ramp, seen from astern only.
    const ramp = along(angledDeckPoint(sternStation + 0.5, -hw), angledDeckPoint(sternStation + 0.5, hw), RAMP_SPACING_M);
    if (ramp.length > 0) {
        add(night, make(PaletteCategory.LIGHT_RED, STEADY, ramp, facingOnly(ramp[0], aft)));
    }
    // Amber drop lights down the transom under the angled centreline.
    const sternAt = angledDeckPoint(sternStation - 0.3);
    const sternDeck = deck.heightAt(angledDeckPoint(sternStation + 0.5).x, angledDeckPoint(sternStation + 0.5).z);
    if (Number.isFinite(sternDeck)) {
        const drops: THREE.Vector3[] = [];
        for (let i = 1; i <= DROP_LIGHTS; i++) {
            drops.push(new THREE.Vector3(sternAt.x, sternDeck - i * DROP_SPACING_M, sternAt.z));
        }
        add(night, make(PaletteCategory.LIGHT_YELLOW, STEADY, drops, facingOnly(drops[0], aft)));
    }

    // Ski-jump: yellow along each lane, white at each start, red across the lip facing aft.
    const lanes: THREE.Vector3[] = [];
    const starts: THREE.Vector3[] = [];
    for (const pos of TAKEOFF_POSITIONS) {
        for (let i = 0; i + 1 < pos.lane.length; i++) {
            lanes.push(...along(pos.lane[i], pos.lane[i + 1], LANE_SPACING_M).slice(i === 0 ? 0 : 1));
        }
        const s = onDeck(pos.start.x, pos.start.z);
        if (s) starts.push(s);
    }
    add(night, make(PaletteCategory.LIGHT_YELLOW, DIM, lanes));
    add(night, make(PaletteCategory.LIGHT_WHITE, STEADY, starts));
    const lip = along({ x: KUZ_CENTRELINE_X - 15, z: SKI_JUMP_LIP_Z - 4 }, { x: KUZ_CENTRELINE_X + 15, z: SKI_JUMP_LIP_Z - 4 }, LIP_SPACING_M);
    if (lip.length > 0) {
        add(night, make(PaletteCategory.LIGHT_RED, STEADY, lip, facingOnly(lip[0], new THREE.Vector3(0, 0, 1))));
    }

    // Navigation lights: masthead (ahead, 225°), sidelights (112.5° each side), stern (135° aft).
    add(night, make(PaletteCategory.LIGHT_WHITE, BRIGHT, [MASTHEAD.clone()], arc(MASTHEAD, 0, 112.5)));
    add(night, make(PaletteCategory.LIGHT_GREEN, BRIGHT, [STARBOARD_SIDELIGHT.clone()], arc(STARBOARD_SIDELIGHT, 0, 112.5, 1)));
    add(night, make(PaletteCategory.LIGHT_RED, BRIGHT, [PORT_SIDELIGHT.clone()], arc(PORT_SIDELIGHT, 0, 112.5, -1)));
    const sternLight = onDeck(KUZ_CENTRELINE_X, 118, 1);
    if (sternLight) {
        sternLight.z += STERN_LIGHT_Z_PAST;
        add(night, make(PaletteCategory.LIGHT_WHITE, BRIGHT, [sternLight], arc(sternLight, 180, 67.5)));
    }

    // --- The Luna ----------------------------------------------------------
    const base = angledDeckPoint(LUNA_STATION_M, -(hw + LUNA_OUTBOARD_M));
    const baseY = deck.heightAt(base.x, base.z);
    const datumY = (Number.isFinite(baseY) ? baseY : 13.5) + LUNA_DATUM_HEIGHT_M;
    const at = (across: number, up: number) => new THREE.Vector3(
        base.x + ANGLED_DECK_RIGHT.x * across, datumY + up, base.z + ANGLED_DECK_RIGHT.z * across);
    const datum: THREE.Vector3[] = [];
    for (const side of [-1, 1]) {
        for (let i = 0; i < LUNA_DATUM_LIGHTS; i++) {
            datum.push(at(side * (LUNA_DATUM_GAP_M + i * LUNA_DATUM_SPACING_M), 0));
        }
    }
    const middle = (LUNA_CELLS - 1) / 2;
    const cells: THREE.Vector3[] = [];
    for (let k = 0; k < LUNA_CELLS; k++) {
        cells.push(at(0, (middle - k) * LUNA_CELL_SPACING_M));
    }
    // The cell the eye sees, worked out in the ship's frame (the points' own).
    const see = (points: LightPoints, eye: THREE.Vector3) => {
        _inv.copy(points.matrixWorld).invert();
        const local = _eye.copy(eye).applyMatrix4(_inv);
        return lunaCellForEye(local.x, local.y, local.z);
    };
    add(luna, make(PaletteCategory.LIGHT_GREEN, LUNA_SIZE, datum, (p, eye) => {
        p.geometry.setDrawRange(0, see(p, eye) >= 0 ? Infinity : 0);
    }, true));
    add(luna, make(PaletteCategory.LIGHT_YELLOW, LUNA_SIZE, cells, (p, eye) => {
        const k = see(p, eye);
        p.geometry.setDrawRange(Math.max(0, k), k >= 0 && k < LUNA_CELLS - 1 ? 1 : 0);
    }, true));
    add(luna, make(PaletteCategory.LIGHT_RED, LUNA_SIZE, [cells[LUNA_CELLS - 1].clone()], (p, eye) => {
        p.geometry.setDrawRange(0, see(p, eye) === LUNA_CELLS - 1 ? 1 : 0);
    }, true));
    for (const o of [...night, ...luna]) o.name = 'carrierLight';
    return { night, luna };
}

/**
 * Shown only within `halfDeg` of carrier-local bearing `centreDeg` (0 the bow,
 * 90 starboard) from `at`; `side` +1 / −1 also limits it to starboard / port.
 */
function arc(at: THREE.Vector3, centreDeg: number, halfDeg: number, side = 0) {
    const local = new THREE.Vector3();
    const inv = new THREE.Matrix4();
    const centre = (centreDeg * Math.PI) / 180;
    return (points: LightPoints, eye: THREE.Vector3) => {
        inv.copy(points.matrixWorld).invert();
        local.copy(eye).applyMatrix4(inv).sub(at);
        // Bearing from the bow (−Z) toward starboard (+X).
        const bearing = Math.atan2(local.x, -local.z);
        let d = Math.abs(bearing - centre);
        if (d > Math.PI) d = 2 * Math.PI - d;
        const seen = (d * 180) / Math.PI <= halfDeg && (side === 0 || Math.sign(local.x) === side);
        points.geometry.setDrawRange(0, seen ? Infinity : 0);
    };
}

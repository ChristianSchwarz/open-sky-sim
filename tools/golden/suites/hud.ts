/**
 * The cockpit HUD and the small overlays beside it (milestone M8): the real
 * HUDEntity, ExteriorDataEntity and PerfHudEntity drawn into the recording
 * painter, plus the pure helpers they lean on (overlayUtils, displayUnits,
 * approachAids, the device-status stack the cockpit draws).
 *
 * The entities read a PlayerEntity, the ConfigService and a three.js camera.
 * Stubs return scripted values for exactly what render2D/update touch; the
 * camera is a real PerspectiveCamera whose pose and projection matrix are
 * recorded, so the port can rebuild the same view and nose cameras. The
 * HUD's FPS readout runs off performance.now, which is replaced by a
 * scripted clock while a case runs; its triangle counts come from the
 * __terrainStats / __fieldStats / __sceneTriangles globals, set per frame.
 *
 * Each case is a fresh entity run for a few frames (update then render2D);
 * every frame's whole call stream is recorded with its inputs.
 */
import * as THREE from 'three';
import { HUDEntity } from '../../../src/script/scene/entities/overlay/hud';
import { ExteriorDataEntity } from '../../../src/script/scene/entities/overlay/exteriorData';
import { PerfHudEntity } from '../../../src/script/scene/entities/overlay/perfHud';
import {
    formatHeading,
    getAircraftDeviceStatusPosition,
    getOverlayLayout,
    getOverlayLogicalHeight,
    getOverlayStrokeWidth,
    getOverlayTickStep,
    renderAircraftDeviceStatus,
} from '../../../src/script/scene/entities/overlay/overlayUtils';
import { DisplayUnits } from '../../../src/script/scene/entities/overlay/displayUnits';
import {
    aoaIndexerCue,
    carrierApproachTargetSink,
    carrierApproachTargetSpeed,
    computeIlsDeviation,
    ILS_GLIDESLOPE_TAN,
    isIlsApproachTarget,
} from '../../../src/script/scene/entities/overlay/approachAids';
import { HDNoonPalette } from '../../../src/script/config/palettes/hd-noon';
import { HDMidnightPalette } from '../../../src/script/config/palettes/hd-midnight';
import { HDNightVisionPalette } from '../../../src/script/config/palettes/hd-nightvision';
import { Palette } from '../../../src/script/config/palettes/palette';
import { CanvasPainter } from '../../../src/script/render/screen/canvasPainter';
import { Font } from '../../../src/script/render/screen/text';
import { SceneLayers } from '../../../src/script/scene/scene';
import { HUDFocusMode, UnitSystems } from '../../../src/script/state/gameDefs';
import type { PlayerEntity } from '../../../src/script/scene/entities/player';
import type { ConfigService } from '../../../src/script/config/configService';
import type { WeaponsTarget } from '../../../src/script/scene/entities/weaponsTarget';
import { RecordingPainter } from '../recordingPainter';
import { Rng, SuiteOutput } from '../lib';

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

const PALETTES: Record<string, Palette> = {
    'hd-noon': HDNoonPalette,
    'hd-midnight': HDMidnightPalette,
    'hd-nightvision': HDNightVisionPalette,
};

const LISTS = new Set<string>([SceneLayers.Overlay]);

const v3 = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
const q4 = (q: THREE.Quaternion): Q4 => [q.x, q.y, q.z, q.w];
const deg = (d: number) => d * Math.PI / 180;

/** Everything the HUD reads off the player, one frame's worth. */
interface PlayerIn {
    position: V3;
    quaternion: Q4;
    velocity: V3;
    altitudeM: number;
    stallStatus: number;
    angleOfAttack: number;
    loadFactorG: number;
    isLanded: boolean;
    autopilot: boolean;
    hasGun: boolean;
    gunAmmo: number;
    healthFraction: number;
    pitchInput: number;
    rollInput: number;
    yawInput: number;
    elevatorLimitHigh: number;
    elevatorLimitLow: number;
    throttle: number;
    throttleHudText: string;
    fcsLimitersEnabled: boolean;
    fcsPitchLimiterMode: number;
}

interface TargetIn {
    position: V3;
    localCenter: V3;
    targetType: string;
    targetLocation: string;
    airborne: boolean;
    approachRunway?: { center: V3; heading: number; halfLength: number };
}

interface CameraIn {
    position: V3;
    quaternion: Q4;
    projection: number[];
}

interface StatsIn {
    terrain?: number;
    cloud?: number;
    cirrus?: number;
    scene?: number;
}

/** A player stub over a mutable frame state. */
function stubPlayer(cur: { p: PlayerIn; target: WeaponsTarget | undefined; focus: HUDFocusMode }): PlayerEntity {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const vel = new THREE.Vector3();
    const sync = () => {
        pos.fromArray(cur.p.position);
        quat.fromArray(cur.p.quaternion);
        vel.fromArray(cur.p.velocity);
    };
    const stub = {
        get weaponsTarget() { return cur.target; },
        get stallStatus() { return cur.p.stallStatus; },
        get angleOfAttack() { return cur.p.angleOfAttack; },
        get loadFactorG() { return cur.p.loadFactorG; },
        get isLanded() { return cur.p.isLanded; },
        get isAutopilotEnabled() { return cur.p.autopilot; },
        get hasGun() { return cur.p.hasGun; },
        get gunAmmo() { return cur.p.gunAmmo; },
        get healthFraction() { return cur.p.healthFraction; },
        get pitchInput() { return cur.p.pitchInput; },
        get rollInput() { return cur.p.rollInput; },
        get yawInput() { return cur.p.yawInput; },
        get elevatorLimitHigh() { return cur.p.elevatorLimitHigh; },
        get elevatorLimitLow() { return cur.p.elevatorLimitLow; },
        get throttleUnit() { return cur.p.throttle; },
        get throttleHudText() { return cur.p.throttleHudText; },
        get hudFocusMode() { return cur.focus; },
        get fcsLimitersEnabled() { return cur.p.fcsLimitersEnabled; },
        get fcsPitchLimiterMode() { return cur.p.fcsPitchLimiterMode; },
        getDisplayAltitude: () => cur.p.altitudeM,
        getDisplayPosition: () => { sync(); return pos; },
        getDisplayQuaternion: () => { sync(); return quat; },
        getDisplayVelocity: () => { sync(); return vel; },
        getDisplayWorldDirection: (v: THREE.Vector3) => { sync(); return v.set(0, 0, 1).applyQuaternion(quat); },
        getDisplayWorldUp: (v: THREE.Vector3) => { sync(); return v.set(0, 1, 0).applyQuaternion(quat); },
    };
    return stub as unknown as PlayerEntity;
}

function stubConfig(units: UnitSystems, fm3: boolean): ConfigService {
    return {
        unitSystem: { getActive: () => units, addChangeListener: () => undefined },
        flightModels: { getActiveKey: () => (fm3 ? 'FM3' : 'FM2') },
    } as unknown as ConfigService;
}

function toTarget(t: TargetIn | null): WeaponsTarget | undefined {
    if (!t) return undefined;
    return {
        position: new THREE.Vector3(...t.position),
        localCenter: new THREE.Vector3(...t.localCenter),
        maxSize: 10,
        targetType: t.targetType,
        targetLocation: t.targetLocation,
        airborne: t.airborne,
        approachRunway: t.approachRunway ? {
            center: new THREE.Vector3(...t.approachRunway.center),
            heading: t.approachRunway.heading,
            halfLength: t.approachRunway.halfLength,
        } : undefined,
    };
}

/** Attitude: yaw a turns body +Z toward +X (forward = (sin a, 0, cos a)), then pitch up, then roll. */
function attitude(yaw: number, pitchDeg: number, rollDeg: number): THREE.Quaternion {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(-deg(pitchDeg), yaw, deg(rollDeg), 'YXZ'));
}

/** The yaw for a compass heading (0 north = -Z, clockwise). */
const yawFor = (headingDeg: number) => deg(180 - headingDeg);

/** Unit direction at yaw a climbing at gammaDeg. */
function direction(yaw: number, gammaDeg: number): THREE.Vector3 {
    const g = deg(gammaDeg);
    return new THREE.Vector3(Math.sin(yaw) * Math.cos(g), Math.sin(g), Math.cos(yaw) * Math.cos(g));
}

interface CameraSpec {
    /** Look offset from the nose: yaw right, pitch up (deg); padlock when non-zero. */
    lookYaw?: number;
    lookPitch?: number;
    fov?: number;
}

function makeCamera(p: PlayerIn, width: number, height: number, spec: CameraSpec): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(spec.fov ?? 50, width / height, 0.5, 120000);
    const quat = new THREE.Quaternion().fromArray(p.quaternion);
    camera.position.set(0, 0.9, 4.2).applyQuaternion(quat).add(new THREE.Vector3(...p.position));
    camera.quaternion.copy(quat)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    if (spec.lookYaw || spec.lookPitch) {
        camera.quaternion.multiply(new THREE.Quaternion().setFromEuler(
            new THREE.Euler(deg(spec.lookPitch ?? 0), deg(-(spec.lookYaw ?? 0)), 0, 'YXZ')));
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    return camera;
}

function cameraIn(camera: THREE.PerspectiveCamera): CameraIn {
    return { position: v3(camera.position), quaternion: q4(camera.quaternion), projection: Array.from(camera.projectionMatrix.elements) };
}

/** A flying state from a handful of numbers. */
function flying(o: {
    heading: number; pitch: number; roll: number; speed: number; gamma?: number; altitudeM: number;
    position?: V3; aoaDeg?: number; g?: number; stall?: number; throttle?: number; text?: string;
    yaw?: number; landed?: boolean; vs?: number;
}): PlayerIn {
    const yaw = o.yaw ?? yawFor(o.heading);
    const q = attitude(yaw, o.pitch, o.roll);
    const gamma = o.gamma ?? (o.pitch - (o.aoaDeg ?? 3));
    const vel = direction(yaw, gamma).multiplyScalar(o.speed);
    if (o.vs !== undefined) vel.y = o.vs;
    return {
        position: o.position ?? [1200.5, o.altitudeM, -4500.25],
        quaternion: q4(q),
        velocity: v3(vel),
        altitudeM: o.altitudeM,
        stallStatus: o.stall ?? -0.6,
        angleOfAttack: deg(o.aoaDeg ?? 3),
        loadFactorG: o.g ?? 1,
        isLanded: o.landed ?? false,
        autopilot: false,
        hasGun: true,
        gunAmmo: 412,
        healthFraction: 1,
        pitchInput: 0.05,
        rollInput: -0.1,
        yawInput: 0,
        elevatorLimitHigh: 0.85,
        elevatorLimitLow: -0.6,
        throttle: o.throttle ?? 0.82,
        throttleHudText: o.text ?? 'MIL 82%',
        fcsLimitersEnabled: true,
        fcsPitchLimiterMode: 1,
    };
}

interface FrameSpec {
    delta: number;
    player: PlayerIn;
    target: TargetIn | null;
    camera: CameraSpec;
    stats: StatsIn;
}

interface HudCase {
    name: string;
    units: UnitSystems;
    focus: HUDFocusMode;
    palette: string;
    fm3: boolean;
    sizes: [number, number][];
    frames: FrameSpec[];
}

const SIZES_ALL: [number, number][] = [[320, 200], [640, 400], [1280, 720], [1920, 1080]];

const CRUISE = flying({ heading: 47, pitch: 2, roll: 0, speed: 221.7, altitudeM: 3047.3 });
const NO_STATS: StatsIn = {};
const STATS: StatsIn = { terrain: 412345, cloud: 51234, cirrus: 2210, scene: 701999 };

/** A few frames of the same state at the usual cadence. */
function steady(player: PlayerIn, target: TargetIn | null = null, camera: CameraSpec = {}, n = 2, stats: StatsIn = NO_STATS): FrameSpec[] {
    const out: FrameSpec[] = [];
    for (let i = 0; i < n; i++) out.push({ delta: 1 / 60, player, target, camera, stats });
    return out;
}

function with_(p: PlayerIn, o: Partial<PlayerIn>): PlayerIn {
    return { ...p, ...o };
}

/** Airborne bandit ahead of (and a little above) the aircraft. */
function banditAhead(p: PlayerIn, range: number, up: number, right = 0): TargetIn {
    const q = new THREE.Quaternion().fromArray(p.quaternion);
    const pos = new THREE.Vector3(...p.position)
        .addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(q), range)
        .addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(q), up)
        .addScaledVector(new THREE.Vector3(-1, 0, 0).applyQuaternion(q), right);
    return { position: v3(pos), localCenter: [0, 1.2, -0.5], targetType: 'MiG-29', targetLocation: 'PURSUE 2.1km', airborne: true };
}

/** On (or off) a runway's approach path: dist m before the touchdown point. */
function runwayApproach(center: V3, heading: number, halfLength: number, dist: number, lateral: number, altOffset: number): PlayerIn {
    const fwdX = Math.sin(heading), fwdZ = Math.cos(heading);
    const tx = center[0] - fwdX * (halfLength - 200);
    const tz = center[2] - fwdZ * (halfLength - 200);
    const y = center[1] + dist * ILS_GLIDESLOPE_TAN + altOffset;
    const p = flying({ heading: 0, yaw: heading, pitch: 5.2, roll: 1.5, speed: 70.5, gamma: -3, altitudeM: y, aoaDeg: 8.2, throttle: 0.55, text: 'PWR 55%' });
    p.position = [tx - fwdX * dist + fwdZ * lateral, y, tz - fwdZ * dist - fwdX * lateral];
    return p;
}

function carrierApproach(origin: V3, dist: number, lateral: number, altOffset: number, aoaDeg: number): PlayerIn {
    const touchZ = origin[2] + 124.28 - 30;
    const midX = origin[0] + (-34.33 + 43.83) * 0.5;
    const y = origin[1] + 13.55 + dist * ILS_GLIDESLOPE_TAN + altOffset;
    const p = flying({ heading: 0, yaw: Math.PI, pitch: 5, roll: -2, speed: 71, gamma: -3.1, altitudeM: y, aoaDeg, throttle: 0.6, text: 'PWR 60%' });
    p.position = [midX + lateral, y, touchZ + dist];
    return p;
}

const RUNWAY = { center: [2000.5, 52.25, 3100] as V3, heading: 0.6, halfLength: 1450 };
const CARRIER_LIVE: V3 = [10400, 0, -2600];

function hudCases(): HudCase[] {
    const cases: HudCase[] = [];
    const add = (c: Omit<HudCase, 'sizes'> & { sizes?: [number, number][] }) => cases.push({ sizes: SIZES_ALL, ...c });
    const M = UnitSystems.METRIC, I = UnitSystems.IMPERIAL;
    const D = HUDFocusMode.DISABLED, P = HUDFocusMode.PARTIAL, F = HUDFocusMode.FULL;

    add({ name: 'cruise', units: M, focus: D, palette: 'hd-noon', fm3: false, frames: steady(CRUISE, null, {}, 3, STATS) });
    add({ name: 'cruise_imperial', units: I, focus: D, palette: 'hd-noon', fm3: false, frames: steady(CRUISE) });
    add({ name: 'cruise_partial_focus', units: M, focus: P, palette: 'hd-midnight', fm3: false, frames: steady(CRUISE) });
    add({ name: 'cruise_full_focus_imperial', units: I, focus: F, palette: 'hd-nightvision', fm3: false, frames: steady(CRUISE) });
    add({
        name: 'climb_banked', units: M, focus: D, palette: 'hd-noon', fm3: false,
        frames: steady(with_(flying({ heading: 312, pitch: 25, roll: 40, speed: 180.3, gamma: 20, altitudeM: 5210.6, g: 3.2 }), { pitchInput: 0.6, rollInput: 0.4, yawInput: 0.2 })),
    });
    add({
        name: 'inverted', units: I, focus: D, palette: 'hd-midnight', fm3: false,
        frames: steady(with_(flying({ heading: 181, pitch: -10, roll: 175, speed: 250, altitudeM: 7600, g: -1.2 }), { pitchInput: -0.7, rollInput: 1 })),
    });
    add({
        name: 'dive', units: M, focus: D, palette: 'hd-noon', fm3: false,
        frames: steady(with_(flying({ heading: 95, pitch: -60, roll: -30, speed: 310, gamma: -62, altitudeM: 2300, g: 5.5, throttle: 0.2, text: 'IDLE' }), { yawInput: -0.8 })),
    });
    add({
        name: 'stall_warning', units: M, focus: D, palette: 'hd-noon', fm3: false,
        frames: [0, 1, 2, 3].map(i => ({
            delta: 1 / 60, target: null, camera: {}, stats: NO_STATS,
            player: with_(flying({ heading: 10, pitch: 18, roll: -8, speed: 61.4, gamma: -3, altitudeM: 1500, aoaDeg: 21 + i * 0.4, stall: 0.3, g: 0.9 }), { pitchInput: 1, elevatorLimitHigh: 0.4 }),
        })),
    });
    add({
        name: 'stall_imperial_full', units: I, focus: F, palette: 'hd-noon', fm3: true,
        frames: steady(flying({ heading: 270, pitch: 30, roll: 0, speed: 55, gamma: 5, altitudeM: 900, aoaDeg: 25, stall: 0.9, g: 0.7 }), null, {}, 4),
    });
    add({
        name: 'supersonic_high', units: I, focus: D, palette: 'hd-midnight', fm3: false,
        frames: steady(flying({ heading: 2, pitch: 1, roll: 3, speed: 480, altitudeM: 12500, aoaDeg: 1.5, throttle: 1, text: 'AB2' }), null, {}, 2, STATS),
    });
    add({
        name: 'imperial_lowp_band', units: I, focus: D, palette: 'hd-noon', fm3: false,
        frames: [290, 300.2, 304.5, 330].map(alt => ({
            delta: 1 / 60, target: null, camera: {}, stats: NO_STATS,
            player: flying({ heading: 88, pitch: 3, roll: 5, speed: 120, altitudeM: alt }),
        })),
    });
    add({
        name: 'ground_parked', units: M, focus: D, palette: 'hd-noon', fm3: false,
        frames: steady(with_(flying({ heading: 359, pitch: 0.5, roll: 0, speed: 0, altitudeM: 12.4, landed: true, stall: 0.5, throttle: 0, text: 'IDLE' }), { velocity: [0, 0, 0] })),
    });
    add({
        name: 'below_sea_level', units: M, focus: D, palette: 'hd-noon', fm3: false,
        frames: steady(flying({ heading: 135, pitch: 4, roll: 0, speed: 90, altitudeM: -18.6, vs: -2.5 })),
    });
    add({
        name: 'autopilot_fm3', units: M, focus: P, palette: 'hd-noon', fm3: true,
        frames: steady(with_(CRUISE, { autopilot: true })),
    });
    for (const [mode, limiters] of [[2, true], [3, true], [7, true], [1, false]] as [number, boolean][]) {
        add({
            name: `fcs_mode_${mode}${limiters ? '' : '_off'}`, units: M, focus: D, palette: 'hd-midnight', fm3: false,
            sizes: [[640, 400], [1920, 1080]],
            frames: steady(with_(CRUISE, { fcsPitchLimiterMode: mode, fcsLimitersEnabled: limiters, elevatorLimitHigh: limiters ? 0.7 : 1, elevatorLimitLow: limiters ? -0.5 : -1, pitchInput: -0.9 })),
        });
    }
    add({
        name: 'gun_empty_damaged', units: M, focus: D, palette: 'hd-noon', fm3: false,
        frames: steady(with_(CRUISE, { gunAmmo: 0, healthFraction: 0.2549 })),
    });
    add({
        name: 'no_gun', units: I, focus: D, palette: 'hd-noon', fm3: false,
        frames: steady(with_(CRUISE, { hasGun: false })),
    });
    const banked = flying({ heading: 200, pitch: 8, roll: -35, speed: 205, altitudeM: 4100, g: 4.2, aoaDeg: 9 });
    add({ name: 'bandit_ahead', units: M, focus: D, palette: 'hd-noon', fm3: false, frames: steady(banked, banditAhead(banked, 650, 60, 25)) });
    add({ name: 'bandit_far', units: I, focus: P, palette: 'hd-midnight', fm3: false, frames: steady(CRUISE, banditAhead(CRUISE, 3200, -80, -200)) });
    add({ name: 'bandit_behind', units: M, focus: D, palette: 'hd-noon', fm3: false, frames: steady(CRUISE, banditAhead(CRUISE, -900, 30)) });
    add({ name: 'bandit_off_screen', units: M, focus: D, palette: 'hd-noon', fm3: false, frames: steady(CRUISE, banditAhead(CRUISE, 300, 0, 900)) });
    add({
        name: 'padlock_high', units: M, focus: D, palette: 'hd-noon', fm3: false,
        frames: steady(banked, banditAhead(banked, 800, 600, 120), { lookPitch: 32, lookYaw: 8 }),
    });
    add({
        name: 'padlock_side', units: I, focus: P, palette: 'hd-nightvision', fm3: false,
        frames: steady(CRUISE, banditAhead(CRUISE, 600, 0, -500), { lookYaw: -40, lookPitch: 5 }),
    });
    add({
        name: 'padlock_nose_behind', units: M, focus: D, palette: 'hd-noon', fm3: false,
        sizes: [[640, 400], [1280, 720]],
        frames: steady(CRUISE, banditAhead(CRUISE, -600, 40), { lookYaw: 170 }),
    });
    add({
        name: 'ground_target', units: M, focus: D, palette: 'hd-noon', fm3: false,
        frames: steady(flying({ heading: 30, pitch: -12, roll: 0, speed: 160, gamma: -14, altitudeM: 900 }), {
            position: [1200.5 + 1500 * Math.sin(yawFor(30)), 40, -4500.25 + 1500 * Math.cos(yawFor(30))],
            localCenter: [0, 3, 0], targetType: 'SAM Radar', targetLocation: 'Ridge 4', airborne: false,
        }),
    });
    // ILS: runway with its own heading, on path, off path both ways, and the legacy runway.
    const ilsTarget: TargetIn = { position: RUNWAY.center, localCenter: [0, 0, 0], targetType: 'Airbase', targetLocation: 'GCLP', airborne: false, approachRunway: RUNWAY };
    add({ name: 'ils_on_path', units: M, focus: D, palette: 'hd-noon', fm3: false, frames: steady(runwayApproach(RUNWAY.center, RUNWAY.heading, RUNWAY.halfLength, 3000, 0, 0), ilsTarget) });
    add({ name: 'ils_high_left', units: I, focus: D, palette: 'hd-midnight', fm3: false, frames: steady(with_(runwayApproach(RUNWAY.center, RUNWAY.heading, RUNWAY.halfLength, 2500, -45, 30), { angleOfAttack: deg(6.5) }), ilsTarget) });
    add({ name: 'ils_low_right_pegged', units: M, focus: P, palette: 'hd-noon', fm3: false, frames: steady(with_(runwayApproach(RUNWAY.center, RUNWAY.heading, RUNWAY.halfLength, 4000, 300, -120), { angleOfAttack: deg(11) }), ilsTarget) });
    add({ name: 'ils_past_touchdown', units: M, focus: F, palette: 'hd-noon', fm3: false, frames: steady(runwayApproach(RUNWAY.center, RUNWAY.heading, RUNWAY.halfLength, -400, 10, 5), ilsTarget) });
    add({
        name: 'ils_legacy_runway', units: I, focus: D, palette: 'hd-noon', fm3: false,
        frames: steady(runwayApproach([0, 0, 0], 0, 1500, 1800, 70, 12), { position: [0, 0, 0], localCenter: [0, 0, 0], targetType: 'Airbase', targetLocation: 'Home', airborne: false }),
    });
    add({
        name: 'airborne_airbase_not_ils', units: M, focus: D, palette: 'hd-noon', fm3: false,
        sizes: [[640, 400], [1280, 720]],
        frames: steady(CRUISE, { ...ilsTarget, airborne: true }),
    });
    const carrierTarget: TargetIn = { position: CARRIER_LIVE, localCenter: [0, 10, 0], targetType: 'Carrier', targetLocation: 'Kuznetsov', airborne: false };
    add({ name: 'carrier_on_speed', units: I, focus: D, palette: 'hd-noon', fm3: false, frames: steady(carrierApproach(CARRIER_LIVE, 1200, 0, 0, 8.3), carrierTarget) });
    add({ name: 'carrier_slow_low', units: M, focus: D, palette: 'hd-midnight', fm3: false, frames: steady(carrierApproach(CARRIER_LIVE, 900, 25, -18, 9.7), carrierTarget) });
    add({ name: 'carrier_fast_high_imperial', units: I, focus: P, palette: 'hd-nightvision', fm3: true, frames: steady(carrierApproach(CARRIER_LIVE, 1600, -60, 40, 6.1), carrierTarget) });
    // Odd sizes: fractional half widths flow through every coordinate.
    add({
        name: 'odd_sizes', units: M, focus: D, palette: 'hd-noon', fm3: false,
        sizes: [[1023, 575], [1366, 768], [800, 600], [2560, 1440], [3840, 2160], [333, 777]],
        frames: steady(banked, banditAhead(banked, 900, 30, 40), {}, 2, STATS),
    });
    // The velocity marker keeps its last direction when the aircraft stops.
    add({
        name: 'stop_keeps_fpm', units: M, focus: D, palette: 'hd-noon', fm3: false,
        sizes: [[1280, 720]],
        frames: [
            { delta: 1 / 60, player: CRUISE, target: null, camera: {}, stats: NO_STATS },
            { delta: 1 / 30, player: with_(CRUISE, { velocity: [0, 0, 0] }), target: null, camera: {}, stats: NO_STATS },
            { delta: 0.05, player: with_(CRUISE, { velocity: [0, 0.0005, 0] }), target: null, camera: {}, stats: STATS },
        ],
    });
    return cases;
}

/** Seeded variety: random attitudes, speeds, sizes, settings and targets. */
function fuzzCases(): HudCase[] {
    const rng = new Rng(0x48554421);
    const sizes: [number, number][] = [[320, 200], [640, 400], [1280, 720], [1920, 1080], [1023, 575], [1600, 900], [2560, 1440], [480, 300]];
    const palettes = Object.keys(PALETTES);
    const out: HudCase[] = [];
    for (let n = 0; n < 40; n++) {
        const units = rng.next() < 0.5 ? UnitSystems.METRIC : UnitSystems.IMPERIAL;
        const focus = rng.int(0, 2) as HUDFocusMode;
        const frames: FrameSpec[] = [];
        const heading = rng.range(0, 360);
        for (let f = 0; f < 2; f++) {
            const p = flying({
                heading: heading + f * rng.range(-3, 3),
                pitch: rng.range(-85, 85), roll: rng.range(-180, 180),
                speed: rng.range(0, 600), gamma: rng.range(-80, 80), altitudeM: rng.range(-50, 16000),
                aoaDeg: rng.range(-5, 30), g: rng.range(-3, 9), stall: rng.range(-1, 1),
                throttle: rng.next(), text: `T${rng.int(0, 120)}`,
            });
            p.pitchInput = rng.range(-1, 1);
            p.rollInput = rng.range(-1, 1);
            p.yawInput = rng.range(-1, 1);
            p.elevatorLimitHigh = rng.range(0, 1);
            p.elevatorLimitLow = rng.range(-1, 0);
            p.isLanded = rng.next() < 0.2;
            p.autopilot = rng.next() < 0.3;
            p.hasGun = rng.next() < 0.8;
            p.gunAmmo = rng.int(0, 600);
            p.healthFraction = rng.next();
            p.fcsLimitersEnabled = rng.next() < 0.8;
            p.fcsPitchLimiterMode = rng.int(1, 3);
            const kind = rng.int(0, 3);
            let target: TargetIn | null = null;
            if (kind === 1) target = banditAhead(p, rng.range(-500, 4000), rng.range(-400, 400), rng.range(-800, 800));
            if (kind === 2) target = { position: RUNWAY.center, localCenter: [0, 0, 0], targetType: 'Airbase', targetLocation: 'X', airborne: false, approachRunway: RUNWAY };
            if (kind === 3) target = { position: CARRIER_LIVE, localCenter: [0, 10, 0], targetType: 'Carrier', targetLocation: 'K', airborne: false };
            const look = rng.next() < 0.3;
            frames.push({
                delta: rng.range(0.004, 0.05), player: p, target,
                camera: look ? { lookYaw: rng.range(-120, 120), lookPitch: rng.range(-30, 60), fov: rng.range(30, 90) } : { fov: rng.range(40, 75) },
                stats: rng.next() < 0.5 ? STATS : { terrain: rng.int(0, 900000), scene: rng.int(0, 900000) },
            });
        }
        out.push({
            name: `fuzz_${n}`, units, focus, palette: rng.pick(palettes), fm3: rng.next() < 0.3,
            sizes: [rng.pick(sizes)], frames,
        });
    }
    return out;
}

/** Scripted performance.now and the perf globals, restored afterwards. */
function withClock<T>(fn: (setNow: (ms: number) => void) => T): T {
    const perf = globalThis.performance as unknown as { now: () => number };
    const saved = perf.now;
    let now = 0;
    perf.now = () => now;
    try {
        return fn(ms => { now = ms; });
    } finally {
        perf.now = saved;
        const g = globalThis as Record<string, unknown>;
        delete g.__terrainStats;
        delete g.__fieldStats;
        delete g.__sceneTriangles;
        delete g.__kernelStats;
        delete g.__drawStats;
    }
}

function setHudStats(s: StatsIn): void {
    const g = globalThis as Record<string, unknown>;
    delete g.__terrainStats;
    delete g.__fieldStats;
    delete g.__sceneTriangles;
    if (s.terrain !== undefined) g.__terrainStats = { triangles: s.terrain };
    if (s.cloud !== undefined || s.cirrus !== undefined) {
        const f: Record<string, number> = {};
        if (s.cloud !== undefined) f.cloud = s.cloud;
        if (s.cirrus !== undefined) f.cirrus = s.cirrus;
        g.__fieldStats = f;
    }
    if (s.scene !== undefined) g.__sceneTriangles = s.scene;
}

function runHud(c: HudCase, width: number, height: number) {
    return withClock(setNow => {
        const cur = { p: c.frames[0].player, target: undefined as WeaponsTarget | undefined, focus: c.focus };
        const hud = new HUDEntity(stubPlayer(cur), stubConfig(c.units, c.fm3));
        const palette = PALETTES[c.palette];
        let now = 1000;
        const frames = c.frames.map(f => {
            cur.p = f.player;
            cur.target = toTarget(f.target);
            setHudStats(f.stats);
            hud.update(f.delta);
            now += f.delta * 1000;
            setNow(now);
            const camera = makeCamera(f.player, width, height, f.camera);
            const rec = new RecordingPainter();
            hud.render2D(width, height, camera, LISTS, rec as unknown as CanvasPainter, palette);
            return {
                delta: f.delta,
                nowMs: now,
                player: f.player,
                target: f.target,
                camera: cameraIn(camera),
                stats: {
                    terrainTriangles: f.stats.terrain ?? 0,
                    cloudTriangles: (f.stats.cloud ?? 0) + (f.stats.cirrus ?? 0),
                    sceneTriangles: f.stats.scene ?? 0,
                },
                calls: rec.calls,
            };
        });
        return {
            name: `${c.name}@${width}x${height}`,
            width, height,
            units: c.units, focus: c.focus, palette: c.palette, fm3: c.fm3,
            frames,
        };
    });
}

function exteriorCases() {
    const out: unknown[] = [];
    const runs: { name: string; units: UnitSystems; palette: string; p: PlayerIn; target: TargetIn | null; sizes: [number, number][] }[] = [
        { name: 'cruise', units: UnitSystems.METRIC, palette: 'hd-noon', p: CRUISE, target: null, sizes: SIZES_ALL },
        { name: 'imperial_target', units: UnitSystems.IMPERIAL, palette: 'hd-midnight', p: flying({ heading: 271.6, pitch: 3, roll: 20, speed: 133.33, altitudeM: 2999.9 }), target: banditAhead(CRUISE, 500, 0), sizes: SIZES_ALL },
        { name: 'ground', units: UnitSystems.METRIC, palette: 'hd-noon', p: with_(flying({ heading: 0.4, pitch: 0, roll: 0, speed: 0, altitudeM: -3.7 }), { velocity: [0, 0, 0] }), target: { position: CARRIER_LIVE, localCenter: [0, 0, 0], targetType: 'Carrier', targetLocation: 'Kuznetsov', airborne: false }, sizes: [[1023, 575], [640, 400]] },
    ];
    for (const r of runs) {
        for (const [width, height] of r.sizes) {
            const cur = { p: r.p, target: toTarget(r.target), focus: HUDFocusMode.DISABLED };
            const ent = new ExteriorDataEntity(stubPlayer(cur), stubConfig(r.units, false));
            ent.update(1 / 60);
            const rec = new RecordingPainter();
            const camera = makeCamera(r.p, width, height, {});
            ent.render2D(width, height, camera, LISTS, rec as unknown as CanvasPainter, PALETTES[r.palette]);
            out.push({ name: `${r.name}@${width}x${height}`, width, height, units: r.units, palette: r.palette, player: r.p, target: r.target, calls: rec.calls });
        }
    }
    return out;
}

interface PerfStatsIn {
    kernel?: { updateMs: number; renderMs: number };
    draw?: { calls: number; triangles: number }[];
    terrain?: Record<string, number | string | boolean>;
}

function perfCases() {
    const full: PerfStatsIn = {
        kernel: { updateMs: 3.456, renderMs: 11.05 },
        draw: [{ calls: 312, triangles: 1203456 }, { calls: 40, triangles: 9876 }, { calls: 7, triangles: 12 }],
        terrain: {
            drawn: 213, triangles: 498765, detailScale: 1.23456, frameEmaMs: 14.2, heightTier: 'fine', queued: 12,
            cacheBytes: 314572800, failed: 2, textured: 30, roadTiles: 41, roadTriangles: 123456,
            bridgeTiles: 3, bridgeTriangles: 999, buildingTiles: 17, buildingShownTriangles: 54321, triangleBudgetHit: true,
        },
    };
    const sparse: PerfStatsIn = { terrain: { drawn: 0, triangles: 0, detailScale: 1, frameEmaMs: 16 } };
    const runs: { name: string; stats: PerfStatsIn; deltas: number[]; palette: string; sizes: [number, number][] }[] = [
        { name: 'none', stats: {}, deltas: [], palette: 'hd-noon', sizes: [[320, 200], [1280, 720]] },
        { name: 'full', stats: full, deltas: [1 / 60, 1 / 30, 0.0213, 1 / 144], palette: 'hd-noon', sizes: SIZES_ALL },
        { name: 'sparse', stats: sparse, deltas: [0.1, 0.2], palette: 'hd-nightvision', sizes: [[640, 400], [1023, 575]] },
        { name: 'draw_only', stats: { draw: full.draw }, deltas: [0], palette: 'hd-midnight', sizes: [[1920, 1080]] },
    ];
    const out: unknown[] = [];
    for (const r of runs) {
        for (const [width, height] of r.sizes) {
            const g = globalThis as Record<string, unknown>;
            try {
                if (r.stats.kernel) g.__kernelStats = r.stats.kernel;
                if (r.stats.draw) g.__drawStats = Object.fromEntries(r.stats.draw.map((d, i) => [`pass${i}`, d]));
                if (r.stats.terrain) g.__terrainStats = r.stats.terrain;
                const ent = new PerfHudEntity();
                for (const d of r.deltas) ent.update(d);
                const rec = new RecordingPainter();
                const camera = new THREE.PerspectiveCamera();
                ent.render2D(width, height, camera, LISTS, rec as unknown as CanvasPainter, PALETTES[r.palette]);
                out.push({ name: `${r.name}@${width}x${height}`, width, height, palette: r.palette, deltas: r.deltas, stats: r.stats, calls: rec.calls });
            } finally {
                delete g.__kernelStats;
                delete g.__drawStats;
                delete g.__terrainStats;
            }
        }
    }
    return out;
}

function deviceStatusCases() {
    const out: unknown[] = [];
    const rng = new Rng(0x44455631);
    const fonts = [Font.HUD_SMALL, Font.HUD_MEDIUM, Font.HUD_LARGE];
    const barricades = [undefined, 'BARRICADE', 'NET UP'];
    for (let i = 0; i < 24; i++) {
        const state = {
            landingGear: i === 0 ? 3 : rng.int(0, 3),
            flaps: rng.int(0, 3),
            airbrakes: rng.int(0, 3),
            tailhook: rng.int(0, 3),
            wheelBrakesApplied: rng.next() < 0.5,
            barricadeStatus: rng.pick(barricades),
        };
        const font = fonts[i % 3];
        const height = rng.pick([200, 400, 720, 1080, 575]);
        const mfdSize = rng.int(60, 300);
        const pos = getAircraftDeviceStatusPosition(height, mfdSize, font);
        const rec = new RecordingPainter();
        renderAircraftDeviceStatus(state as unknown as PlayerEntity, pos.x, pos.y, rec as unknown as CanvasPainter, '#66FF66', font);
        out.push({ ...state, barricadeStatus: state.barricadeStatus ?? null, font: font.id, height, mfdSize, position: [pos.x, pos.y], calls: rec.calls });
    }
    return out;
}

function helperCases() {
    const layout = [[320, 200], [319, 199], [480, 300], [640, 400], [800, 600], [959, 400], [960, 400], [1023, 575], [1280, 720], [1366, 768], [1920, 1080], [2560, 1440], [3840, 2160], [1080, 1920], [100, 100]]
        .map(([w, h]) => {
            const l = getOverlayLayout(w, h);
            return {
                width: w, height: h, detailScale: l.detailScale, layoutScale: l.layoutScale,
                tickStep: getOverlayTickStep(l), logicalHeight: getOverlayLogicalHeight(l), strokeWidth: getOverlayStrokeWidth(l),
            };
        });
    const headings = [0, -0, 5, 45, 359.4, 359.5, 360, 361, -1, -45, -359.6, 720.2, 1234.5, 89.99, 0.5, -0.5, 1e-9]
        .map(n => [n, formatHeading(n)]);
    const rng = new Rng(0x554e4954);
    const units = [UnitSystems.METRIC, UnitSystems.IMPERIAL].map(sys => {
        const du = new DisplayUnits(sys);
        const samples = [0, 1, 9.99, 10, 50, 99, 100, 150, 900, 995, 999, 1000, 1005, 1010, 1100, 2500, 9999, 10000, 35000, -5, -10, -100]
            .concat(Array.from({ length: 20 }, () => Math.round(rng.range(-200, 40000) * 100) / 100));
        return {
            system: sys,
            altitudeStep: du.altitudeStep, altitudeLowThreshold: du.altitudeLowThreshold,
            useBarometricAltitude: du.useBarometricAltitude, altitudeTapeLabelInterval: du.altitudeTapeLabelInterval,
            airspeedStep: du.airspeedStep, airspeedScale: du.airspeedScale, verticalSpeedBarDivisor: du.verticalSpeedBarDivisor,
            altitudeUnitLabel: du.altitudeUnitLabel(), speedUnitLabel: du.speedUnitLabel(),
            samples: samples.map(n => ({
                n,
                altitudeFromMeters: du.altitudeFromMeters(n),
                speedFromMps: du.speedFromMps(n),
                verticalSpeedFromMps: du.verticalSpeedFromMps(n),
                readout: du.formatAltitudeReadout(n),
                tape: du.formatAltitudeTape(n, false),
                tapeLowp: du.formatAltitudeTape(n, true),
                tick1: du.getAltitudeTickWidth(n, 1),
                tick10: du.getAltitudeTickWidth(n, 10),
            })),
        };
    });
    const ils: unknown[] = [];
    for (let i = 0; i < 60; i++) {
        const kind = i % 4;
        const pos: V3 = [rng.range(-6000, 14000), rng.range(-20, 900), rng.range(-9000, 9000)];
        if (kind === 0) {
            const r = computeIlsDeviation(new THREE.Vector3(...pos), 'Airbase');
            ils.push({ position: pos, targetType: 'Airbase', result: r });
        } else if (kind === 1) {
            const runway = { center: [rng.range(-3000, 3000), rng.range(0, 400), rng.range(-3000, 3000)] as V3, heading: rng.range(-Math.PI, Math.PI), halfLength: rng.range(400, 2000) };
            const r = computeIlsDeviation(new THREE.Vector3(...pos), 'Airbase', undefined, { center: new THREE.Vector3(...runway.center), heading: runway.heading, halfLength: runway.halfLength });
            ils.push({ position: pos, targetType: 'Airbase', runway, result: r });
        } else if (kind === 2) {
            const origin: V3 = [rng.range(8000, 12000), 0, rng.range(-4000, 0)];
            const r = computeIlsDeviation(new THREE.Vector3(...pos), 'Carrier', { x: origin[0], y: origin[1], z: origin[2] });
            ils.push({ position: pos, targetType: 'Carrier', carrierOrigin: origin, result: r });
        } else {
            const r = computeIlsDeviation(new THREE.Vector3(...pos), i % 8 === 3 ? 'Carrier' : 'SAM Radar');
            ils.push({ position: pos, targetType: i % 8 === 3 ? 'Carrier' : 'SAM Radar', result: r });
        }
    }
    const cues = [-5, 0, 7.99, 8, 8.25, 8.5, 8.500001, 9, 30].map(a => [a, aoaIndexerCue(a)]);
    const isIls = [
        ['Airbase', false], ['Airbase', true], ['Carrier', false], ['Carrier', true], ['SAM Radar', false], ['MiG-29', true],
    ].map(([t, airborne]) => [t, airborne, isIlsApproachTarget({ targetType: t, airborne } as WeaponsTarget)]);
    return {
        layout,
        formatHeading: headings,
        displayUnits: units,
        ils,
        aoaCues: cues,
        isIls,
        approach: {
            glideslopeTan: ILS_GLIDESLOPE_TAN,
            speedImperial: carrierApproachTargetSpeed(true), speedMetric: carrierApproachTargetSpeed(false),
            sinkImperial: carrierApproachTargetSink(true), sinkMetric: carrierApproachTargetSink(false),
        },
    };
}

export function hudSuite(): SuiteOutput {
    const hud: unknown[] = [];
    for (const c of [...hudCases(), ...fuzzCases()]) {
        for (const [w, h] of c.sizes) hud.push(runHud(c, w, h));
    }
    return {
        files: [{
            file: 'hud.json',
            data: {
                suite: 'hud',
                version: 1,
                source: [
                    'src/script/scene/entities/overlay/hud.ts',
                    'src/script/scene/entities/overlay/exteriorData.ts',
                    'src/script/scene/entities/overlay/perfHud.ts',
                    'src/script/scene/entities/overlay/overlayUtils.ts',
                    'src/script/scene/entities/overlay/displayUnits.ts',
                    'src/script/scene/entities/overlay/approachAids.ts',
                    'src/script/weapons/gunPipper.ts',
                ],
                notes: 'Painter call streams in the tools/golden/recordingPainter.ts format. HUD cases: a fresh HUDEntity per '
                    + 'case and size; per frame update(delta), performance.now = nowMs, then render2D on a PerspectiveCamera '
                    + 'with the recorded pose and projection (no parent, unit scale). player = what the PlayerEntity stub returns '
                    + '(display pose; angleOfAttack in rad; fcsPitchLimiterMode 1..3 or other); stats are the perf globals '
                    + '(cloud = cloud + cirrus). Exterior: one update + render2D. Perf: update(d) for each delta, then render2D '
                    + 'with the __kernelStats / __drawStats (values in order) / __terrainStats globals. Device status: '
                    + 'renderAircraftDeviceStatus at getAircraftDeviceStatusPosition, colour #66FF66.',
                tolerances: { calls: 'exact', helpers: 'exact' },
                helpers: helperCases(),
                hud,
                exterior: exteriorCases(),
                perf: perfCases(),
                deviceStatus: deviceStatusCases(),
            },
        }],
    };
}

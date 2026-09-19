/**
 * Carrier arrestor cables: local layout, snag detection, and deck-axis arrest.
 * Visual builder and combat-sim trap both consume these constants.
 */
import * as THREE from 'three';
import { Fm2AircraftConfig, defaultFm2Config } from '../../physics/fm2/fm2AircraftConfig';
import { DEFAULT_ENGINE_NOZZLES } from './afterburnerCones';

/** Approximate Kuznetsov deck mid-X (see KUZ_HULL in game.ts). */
export const ARRESTOR_DECK_MID_X = (-34.33 + 43.83) * 0.5;
/** Half-width of each cable across the landing lane (m). */
export const ARRESTOR_HALF_SPAN_M = 18;
/**
 * Cable height in carrier-local Y.
 * Real kuz deck under the wires is ~13.55 m; landed hook sits ~deck+1.0
 * (CG at deck+2.0, hook body Y=-1.0 after {@link TAILHOOK_MOUNT_UP_M}). Keep
 * cables at that height so a roll-out with the hook down can snag them —
 * {@link ARRESTOR_CATCH_VERT_M} covers the offset.
 */
export const ARRESTOR_CABLE_Y = 13.85;
/** Local Z of the four wires, stern → bow (landing along −Z). */
export const ARRESTOR_CABLE_LOCAL_Z = [95, 83, 71, 59] as const;

/** Max horizontal miss from cable for a catch (m). */
export const ARRESTOR_CATCH_RADIUS_M = 2.0;
/** Max |hookY − cableY| allowed for a catch (m). */
const ARRESTOR_CATCH_VERT_M = 2.5;
/** Minimum along-deck speed to snag (m/s). */
const ARRESTOR_MIN_SNAG_SPEED_MPS = 15;
/** Release when along-deck speed drops below this (m/s). */
export const ARRESTOR_STOP_SPEED_MPS = 0.5;
/** After a completed trap, drop the cable once groundspeed exceeds this (m/s). */
export const ARRESTOR_RELEASE_SPEED_MPS = 3.0;
/** Deck run-out from snag to full stop (m). */
export const ARRESTOR_PULL_OUT_M = 140;
/** Cap on arrest deceleration (m/s²); ~4 g. */
const ARRESTOR_MAX_DECEL_MPS2 = 4.0 * 9.80665;

/**
 * Whole hook assembly (hinge and tip) sits this far above the belly line it was
 * originally authored at, so the arm hangs off the fuselage instead of the air.
 */
const TAILHOOK_MOUNT_UP_M = 0.7;

/** Default body-frame hook tip — coincides with default nozzle exit Z. */
export const DEFAULT_ARRESTOR_HOOK_BODY: [number, number, number] = [
    0,
    -1.7 + TAILHOOK_MOUNT_UP_M,
    DEFAULT_ENGINE_NOZZLES[0][2],
];
/** Hinge sits this far above the tip in body Y (m). */
const ARRESTOR_HOOK_HINGE_UP_M = 0.75;
/** Hinge sits this far forward of the tip in body +Z (m). */
export const ARRESTOR_HOOK_HINGE_FWD_M = 1.0;
/** Body-frame hinge for the visible tailhook arm (belly, forward of the tip). */
export const DEFAULT_ARRESTOR_HOOK_HINGE: [number, number, number] = [
    DEFAULT_ARRESTOR_HOOK_BODY[0],
    DEFAULT_ARRESTOR_HOOK_BODY[1] + ARRESTOR_HOOK_HINGE_UP_M,
    DEFAULT_ARRESTOR_HOOK_BODY[2] + ARRESTOR_HOOK_HINGE_FWD_M,
];

/** Arm length hinge→tip (m), used by the procedural tailhook mesh. */
export const TAILHOOK_ARM_LENGTH_M = Math.hypot(
    ARRESTOR_HOOK_HINGE_UP_M,
    ARRESTOR_HOOK_HINGE_FWD_M,
);

/** Rearmost nozzle-exit Z from a nozzle list (body +Z forward → aft is min Z). */
function nozzleExitZ(
    nozzles: readonly (readonly [number, number, number])[],
): number {
    let z = nozzles[0][2];
    for (let i = 1; i < nozzles.length; i++) {
        z = Math.min(z, nozzles[i][2]);
    }
    return z;
}

/**
 * Place the arrestor hook tip at the nozzle exits (same Z as the exhaust plane).
 * Falls back to an explicit tip, then the shared default.
 */
export function resolveArrestorHookTip(opts: {
    explicitHook?: readonly [number, number, number];
    nozzleZs?: readonly number[];
    tipY?: number;
}): [number, number, number] {
    const tipY = opts.tipY ?? DEFAULT_ARRESTOR_HOOK_BODY[1];

    if (opts.nozzleZs && opts.nozzleZs.length > 0) {
        let aft = opts.nozzleZs[0];
        for (let i = 1; i < opts.nozzleZs.length; i++) {
            aft = Math.min(aft, opts.nozzleZs[i]);
        }
        return [0, tipY, aft];
    }
    if (opts.explicitHook) {
        return [opts.explicitHook[0], opts.explicitHook[1], opts.explicitHook[2]];
    }
    return [
        DEFAULT_ARRESTOR_HOOK_BODY[0],
        tipY,
        DEFAULT_ARRESTOR_HOOK_BODY[2],
    ];
}

/** Visible-arm hinge from a resolved tip (same relative offset as the default). */
function arrestorHookHingeFromTip(
    tip: readonly [number, number, number],
): [number, number, number] {
    return [
        tip[0],
        tip[1] + ARRESTOR_HOOK_HINGE_UP_M,
        tip[2] + ARRESTOR_HOOK_HINGE_FWD_M,
    ];
}

/**
 * Tip + hinge for a flyable def. Tip Z matches the nozzle exits (authored
 * `fx.nozzles`, else the shared default twin nozzles).
 */
export function arrestorHookPlacementForAircraft(def: {
    flight?: { hook?: [number, number, number] };
    collisionMesh?: { aabb: { min: [number, number, number] } };
    surfaces?: { pivot: [number, number, number] }[];
    fx?: { nozzles?: [number, number, number][] | null };
}): { tip: [number, number, number]; hinge: [number, number, number] } {
    const authored = def.fx?.nozzles;
    const nozzles = authored && authored.length > 0 ? authored : DEFAULT_ENGINE_NOZZLES;
    const tipY = def.collisionMesh
        ? Math.min(
            DEFAULT_ARRESTOR_HOOK_BODY[1],
            def.collisionMesh.aabb.min[1] + 0.35 + TAILHOOK_MOUNT_UP_M,
        )
        : DEFAULT_ARRESTOR_HOOK_BODY[1];
    const tip = resolveArrestorHookTip({
        explicitHook: def.flight?.hook,
        nozzleZs: [nozzleExitZ(nozzles)],
        tipY,
    });
    return { tip, hinge: arrestorHookHingeFromTip(tip) };
}

/** FM2 config with hook tip forced to this airframe's aft fuselage end. */
export function flightConfigWithArrestorHook(def: {
    flight?: Fm2AircraftConfig;
    collisionMesh?: { aabb: { min: [number, number, number] } };
    surfaces?: { pivot: [number, number, number] }[];
    fx?: { nozzles?: [number, number, number][] | null };
}): Fm2AircraftConfig {
    const base = def.flight ?? defaultFm2Config;
    const { tip } = arrestorHookPlacementForAircraft(def);
    return { ...base, hook: tip };
}

import { CARRIER_ORIGIN } from '../../state/worldLayout';

/** Default carrier origin (local ENU — see worldLayout). */
export const ARRESTOR_CARRIER_ORIGIN = CARRIER_ORIGIN;

/** Live carrier placement used to transform cable locals into world space. */
export interface ArrestorCarrierPose {
    position: { x: number; y: number; z: number };
    /** Identity when omitted (carrier yaw = 0). */
    quaternion?: THREE.Quaternion;
    /** World-frame ship velocity (m/s); used for parked display glue gating. */
    velocity?: { x: number; y: number; z: number };
}

/** Map a carrier-local point into world space using {@link pose}. */
export function carrierLocalToWorld(
    localX: number,
    localY: number,
    localZ: number,
    pose: ArrestorCarrierPose,
    out: THREE.Vector3,
): THREE.Vector3 {
    out.set(localX, localY, localZ);
    if (pose.quaternion) {
        out.applyQuaternion(pose.quaternion);
    }
    return out.add(pose.position as THREE.Vector3);
}


/** World position of the left sheave ("start") of cable `index`. */
export function arrestorCableStartWorld(
    index: number,
    origin: ArrestorCarrierPose | { x: number; y: number; z: number } = ARRESTOR_CARRIER_ORIGIN,
    out: THREE.Vector3,
): THREE.Vector3 {
    const locals = arrestorCableLocals();
    const i = Math.max(0, Math.min(locals.length - 1, index | 0));
    const c = locals[i];
    return carrierLocalToWorld(c.ax, c.ay, c.az, normalizeCarrierPose(origin), out);
}

function normalizeCarrierPose(
    origin: ArrestorCarrierPose | { x: number; y: number; z: number },
): ArrestorCarrierPose {
    if ('position' in origin) {
        return origin;
    }
    return { position: origin };
}

/**
 * Latched visual tip: on the hinge→sheave ray at {@link TAILHOOK_ARM_LENGTH_M},
 * so the hook arm and that cable leg stay colinear under tension.
 * Writes the unit direction hinge→tip into `outDir` when provided.
 */
export function latchedHookTipWorld(
    hinge: THREE.Vector3,
    sheave: THREE.Vector3,
    outTip: THREE.Vector3,
    outDir?: THREE.Vector3,
    fallbackDir?: THREE.Vector3,
): THREE.Vector3 {
    const dir = outDir ?? _latchedHookDir;
    dir.subVectors(sheave, hinge);
    if (dir.lengthSq() < 1e-8) {
        if (fallbackDir && fallbackDir.lengthSq() > 1e-8) {
            dir.copy(fallbackDir);
        } else {
            dir.set(0, -ARRESTOR_HOOK_HINGE_UP_M, -ARRESTOR_HOOK_HINGE_FWD_M);
        }
    }
    dir.normalize();
    return outTip.copy(hinge).addScaledVector(dir, TAILHOOK_ARM_LENGTH_M);
}

const _latchedHookDir = new THREE.Vector3();

/** One cable as local endpoints relative to the carrier origin. */
export interface ArrestorCableLocal {
    ax: number;
    ay: number;
    az: number;
    bx: number;
    by: number;
    bz: number;
}

interface ArrestorCableSegment {
    readonly a: THREE.Vector3;
    readonly b: THREE.Vector3;
}

/** World-space cable field for one carrier. */
export interface ArrestorCableField {
    originX: number;
    originY: number;
    originZ: number;
    /** Unit vector: landing / roll-out direction (toward bow). */
    deckAxis: THREE.Vector3;
    segments: ArrestorCableSegment[];
}

/** Four lateral cables in carrier-local space. */
export function arrestorCableLocals(): ArrestorCableLocal[] {
    const mid = ARRESTOR_DECK_MID_X;
    const hs = ARRESTOR_HALF_SPAN_M;
    const y = ARRESTOR_CABLE_Y;
    return ARRESTOR_CABLE_LOCAL_Z.map(z => ({
        ax: mid - hs, ay: y, az: z,
        bx: mid + hs, by: y, bz: z,
    }));
}

/** Build world segments from a carrier origin (optional yaw/orientation). */
export function buildArrestorCableField(
    originX: number,
    originY: number,
    originZ: number,
    deckAxis: THREE.Vector3 = new THREE.Vector3(0, 0, -1),
    orientation?: THREE.Quaternion,
): ArrestorCableField {
    const locals = arrestorCableLocals();
    const pose: ArrestorCarrierPose = {
        position: { x: originX, y: originY, z: originZ },
        quaternion: orientation,
    };
    const segments: ArrestorCableSegment[] = locals.map(c => ({
        a: carrierLocalToWorld(c.ax, c.ay, c.az, pose, new THREE.Vector3()),
        b: carrierLocalToWorld(c.bx, c.by, c.bz, pose, new THREE.Vector3()),
    }));
    const axis = deckAxis.clone();
    if (orientation) {
        axis.applyQuaternion(orientation);
    }
    return {
        originX,
        originY,
        originZ,
        deckAxis: axis.normalize(),
        segments,
    };
}

/** Hook world position from CG pose and body-frame hook. */
export function hookWorldPos(
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    hookBody: THREE.Vector3,
    out: THREE.Vector3,
): THREE.Vector3 {
    return out.copy(hookBody).applyQuaternion(quaternion).add(position);
}

/** Distance from point P to segment AB. */
export function distancePointToSegment(
    p: THREE.Vector3,
    a: THREE.Vector3,
    b: THREE.Vector3,
    closest?: THREE.Vector3,
): number {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const apx = p.x - a.x;
    const apy = p.y - a.y;
    const apz = p.z - a.z;
    const abLenSq = abx * abx + aby * aby + abz * abz;
    let t = abLenSq > 1e-12 ? (apx * abx + apy * aby + apz * abz) / abLenSq : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = a.x + abx * t;
    const cy = a.y + aby * t;
    const cz = a.z + abz * t;
    if (closest) closest.set(cx, cy, cz);
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dz = p.z - cz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Returns latched cable index, or -1 if no snag.
 * A stern→bow plane crossing with the hook near deck height catches even when
 * the discrete step jumps past the wire; proximity alone also catches when
 * already inside the catch radius.
 */
export function trySnag(
    hook: THREE.Vector3,
    prevHook: THREE.Vector3 | null,
    vel: THREE.Vector3,
    field: ArrestorCableField,
    hookDown: boolean,
): number {
    if (!hookDown) return -1;
    const along = vel.dot(field.deckAxis);
    if (along < ARRESTOR_MIN_SNAG_SPEED_MPS) return -1;

    for (let i = 0; i < field.segments.length; i++) {
        const seg = field.segments[i];
        const cableY = (seg.a.y + seg.b.y) * 0.5;
        if (Math.abs(hook.y - cableY) > ARRESTOR_CATCH_VERT_M) continue;

        const cableZ = (seg.a.z + seg.b.z) * 0.5;
        const midX = (seg.a.x + seg.b.x) * 0.5;
        const halfSpan = Math.abs(seg.b.x - seg.a.x) * 0.5;
        const inLane = Math.abs(hook.x - midX) <= halfSpan + ARRESTOR_CATCH_RADIUS_M;

        let crossed = false;
        if (prevHook) {
            // Landing along −Z: crossed when previous Z was aft of the wire.
            crossed = prevHook.z > cableZ && hook.z <= cableZ;
        }
        if (crossed && inLane) {
            return i;
        }

        const d = distancePointToSegment(hook, seg.a, seg.b);
        if (d <= ARRESTOR_CATCH_RADIUS_M && inLane) {
            return i;
        }
    }
    return -1;
}

/**
 * Scrub along-deck speed to reach {@link targetAlong} in {@link remainingDist}
 * metres (constant-decel profile a = v² / 2s, capped by {@link ARRESTOR_MAX_DECEL_MPS2}).
 * @returns true while still trapping (relative along-speed above stop threshold).
 */
export function applyArrestorVelocity(
    vel: THREE.Vector3,
    deckAxis: THREE.Vector3,
    dt: number,
    remainingDist: number = ARRESTOR_PULL_OUT_M,
    targetAlong: number = 0,
): boolean {
    const along = vel.dot(deckAxis);
    const rel = along - targetAlong;
    if (Math.abs(rel) <= ARRESTOR_STOP_SPEED_MPS || remainingDist <= 0) {
        if (rel !== 0) {
            vel.addScaledVector(deckAxis, -rel);
        }
        return false;
    }
    // Target stop in remainingDist: a = v_rel² / (2 s).
    const aNeeded = (rel * rel) / (2 * Math.max(remainingDist, 0.25));
    const a = Math.min(aNeeded, ARRESTOR_MAX_DECEL_MPS2);
    const dv = Math.sign(rel) * Math.min(Math.abs(rel), a * dt);
    vel.addScaledVector(deckAxis, -dv);
    return true;
}

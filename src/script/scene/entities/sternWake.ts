/**
 * Carrier stern wake: a 2 km foam ribbon laid flat on the water behind the ship.
 *
 * The strip is built from a ring buffer of past stern positions, so it stays in
 * world space and follows the ship's track instead of rotating with the hull.
 * Transparency is the engine's screen-space ordered dither (`alphaDither`), one
 * material per segment, ramping linearly from dense foam at the transom to the
 * faintest stipple the 4x4 Bayer matrix can hold at the far end.
 *
 * A ribbon rather than particles: 2 km at cruise speed is ~160 s of foam, which
 * the shared 2000-puff pool cannot hold without recycling its own tail away.
 * 50 quads cover the same length at a fixed, trivial cost.
 */
import * as THREE from 'three';
import { PaletteCategory } from '../../config/palettes/palette';
import { clamp, lerp } from '../../utils/math';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials/materials';
import { updateUniforms } from '../utils';

/** Total trail length astern (m). */
export const STERN_WAKE_LENGTH_M = 2000;
/** Quads along the trail. 50 x 40 m keeps the dither ramp smooth. */
export const STERN_WAKE_SEGMENT_COUNT = 50;
/** Distance the ship travels between track samples (m). */
export const STERN_WAKE_SEGMENT_LENGTH_M = STERN_WAKE_LENGTH_M / STERN_WAKE_SEGMENT_COUNT;

/** Dither opacity right behind the transom (roughly "fraction of pixels kept"). */
const STERN_WAKE_DITHER_HEAD = 0.6;
/**
 * One 4x4 Bayer level. The linear ramp lands here at 2 km rather than at 0:
 * below 1/16 the stipple keeps no pixels at all, so a ramp to zero would end
 * the *visible* wake a couple of hundred metres short of the asked-for length.
 */
const STERN_WAKE_DITHER_TAIL = 1 / 16;

/** Foam half-width at the transom (m); roughly the hull beam at the waterline. */
const STERN_WAKE_HALF_WIDTH_STERN_M = 16;
/** Foam half-width at the far end (m) — the turbulent core spreads ~2 deg a side. */
const STERN_WAKE_HALF_WIDTH_TAIL_M = 95;

/** Ribbon height above the waterline (m). Below the foam puffs, which win on top. */
const STERN_WAKE_SURFACE_Y = 0.1;

/** Pale foam white; overrides the water palette lookup. */
const STERN_WAKE_COLOR = '#e8f0f4';

const SAMPLE_COUNT = STERN_WAKE_SEGMENT_COUNT + 1;

/** Dither opacity at `distanceAsternM`, linear over the full trail length. */
export function sternWakeAlphaAt(distanceAsternM: number): number {
    const t = clamp(distanceAsternM / STERN_WAKE_LENGTH_M, 0, 1);
    return lerp(t, STERN_WAKE_DITHER_HEAD, STERN_WAKE_DITHER_TAIL);
}

/** Foam half-width at `distanceAsternM` (m); the trail fans out astern. */
export function sternWakeHalfWidthAt(distanceAsternM: number): number {
    const t = clamp(distanceAsternM / STERN_WAKE_LENGTH_M, 0, 1);
    return lerp(t, STERN_WAKE_HALF_WIDTH_STERN_M, STERN_WAKE_HALF_WIDTH_TAIL_M);
}

export class SternWakeRibbon {

    /** Parented by the owner so draw order against the foam puffs is fixed. */
    readonly object = new THREE.Object3D();

    private readonly history: THREE.Vector3[] = Array.from(
        { length: SAMPLE_COUNT },
        () => new THREE.Vector3(),
    );
    private head = 0;
    private count = 0;
    private seeded = false;

    private readonly segments: THREE.Mesh[] = [];
    private readonly positions: THREE.BufferAttribute[] = [];

    // Strip rebuilt each frame in root-relative XZ: point, outward normal, and
    // distance astern accumulated from the transom.
    private readonly stripX = new Float64Array(SAMPLE_COUNT);
    private readonly stripZ = new Float64Array(SAMPLE_COUNT);
    private readonly stripNX = new Float64Array(SAMPLE_COUNT);
    private readonly stripNZ = new Float64Array(SAMPLE_COUNT);
    private readonly stripDist = new Float64Array(SAMPLE_COUNT);

    constructor(materials: SceneMaterialManager) {
        for (let i = 0; i < STERN_WAKE_SEGMENT_COUNT; i++) {
            // Alpha is sampled at the segment mid so the ramp is centred on the
            // strip rather than biased toward the ship.
            const material = materials.build({
                type: SceneMaterialPrimitiveType.MESH,
                category: PaletteCategory.TERRAIN_SHALLOW_WATER,
                shaded: false,
                depthWrite: false,
                colorDither: false,
                rawColor: STERN_WAKE_COLOR,
                alphaDither: sternWakeAlphaAt((i + 0.5) * STERN_WAKE_SEGMENT_LENGTH_M),
            }) as THREE.ShaderMaterial;
            // Visible from under the surface too (the water itself depth-tests).
            material.side = THREE.DoubleSide;

            const geometry = new THREE.BufferGeometry();
            const position = new THREE.BufferAttribute(new Float32Array(4 * 3), 3);
            geometry.setAttribute('position', position);
            geometry.setIndex([0, 1, 2, 2, 1, 3]);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.frustumCulled = false;
            mesh.visible = false;
            mesh.onBeforeRender = updateUniforms;
            this.object.add(mesh);
            this.segments.push(mesh);
            this.positions.push(position);
        }
    }

    /**
     * @param sternWorld world position of the transom foam origin
     * @param aftWorld unit vector pointing astern along the ship's track
     */
    update(sternWorld: THREE.Vector3, aftWorld: THREE.Vector3): void {
        this.seed(sternWorld, aftWorld);
        this.tryPush(sternWorld);
        this.layout(sternWorld);
    }

    /** Lay the full trail out astern on the first frame so it starts complete. */
    private seed(sternWorld: THREE.Vector3, aftWorld: THREE.Vector3): void {
        if (this.seeded) {
            return;
        }
        this.seeded = true;
        for (let i = SAMPLE_COUNT - 1; i >= 0; i--) {
            this.push(
                sternWorld.x + aftWorld.x * i * STERN_WAKE_SEGMENT_LENGTH_M,
                sternWorld.z + aftWorld.z * i * STERN_WAKE_SEGMENT_LENGTH_M,
            );
        }
    }

    private push(x: number, z: number): void {
        this.history[this.head].set(x, 0, z);
        this.head = (this.head + 1) % SAMPLE_COUNT;
        this.count = Math.min(this.count + 1, SAMPLE_COUNT);
    }

    private historyAt(ageFromNewest: number): THREE.Vector3 {
        return this.history[(this.head - 1 - ageFromNewest + SAMPLE_COUNT * 2) % SAMPLE_COUNT];
    }

    private tryPush(sternWorld: THREE.Vector3): void {
        const newest = this.historyAt(0);
        const dx = sternWorld.x - newest.x;
        const dz = sternWorld.z - newest.z;
        if (dx * dx + dz * dz >= STERN_WAKE_SEGMENT_LENGTH_M * STERN_WAKE_SEGMENT_LENGTH_M) {
            this.push(sternWorld.x, sternWorld.z);
        }
    }

    /**
     * Rebuild the strip around the live stern point. Vertices are kept relative
     * to the root (<= 2 km) so the Float32 attribute stays precise at planetary
     * ranges, where absolute ENU coordinates would not be.
     */
    private layout(sternWorld: THREE.Vector3): void {
        this.object.position.set(sternWorld.x, STERN_WAKE_SURFACE_Y, sternWorld.z);

        // Point 0 is the live transom; the rest is the sampled track astern.
        const points = Math.min(this.count + 1, SAMPLE_COUNT);
        this.stripX[0] = 0;
        this.stripZ[0] = 0;
        this.stripDist[0] = 0;
        for (let k = 1; k < points; k++) {
            const p = this.historyAt(k - 1);
            this.stripX[k] = p.x - sternWorld.x;
            this.stripZ[k] = p.z - sternWorld.z;
            this.stripDist[k] = this.stripDist[k - 1]
                + Math.hypot(this.stripX[k] - this.stripX[k - 1], this.stripZ[k] - this.stripZ[k - 1]);
        }

        // Outward normal per point, from the tangent across both neighbours, so
        // adjacent quads share an edge and the strip stays seamless in a turn.
        for (let k = 0; k < points; k++) {
            const a = Math.max(0, k - 1);
            const b = Math.min(points - 1, k + 1);
            let tx = this.stripX[b] - this.stripX[a];
            let tz = this.stripZ[b] - this.stripZ[a];
            const len = Math.hypot(tx, tz);
            if (len < 1e-6) {
                tx = 0;
                tz = 1;
            } else {
                tx /= len;
                tz /= len;
            }
            this.stripNX[k] = -tz;
            this.stripNZ[k] = tx;
        }

        for (let j = 0; j < STERN_WAKE_SEGMENT_COUNT; j++) {
            const mesh = this.segments[j];
            if (j + 1 >= points) {
                mesh.visible = false;
                continue;
            }
            this.placeQuad(this.positions[j], j, j + 1);
            mesh.visible = true;
        }
    }

    /** Flat quad spanning strip points `a` (nearer the ship) and `b`. */
    private placeQuad(position: THREE.BufferAttribute, a: number, b: number): void {
        const wa = sternWakeHalfWidthAt(this.stripDist[a]);
        const wb = sternWakeHalfWidthAt(this.stripDist[b]);
        position.setXYZ(0, this.stripX[a] - this.stripNX[a] * wa, 0, this.stripZ[a] - this.stripNZ[a] * wa);
        position.setXYZ(1, this.stripX[a] + this.stripNX[a] * wa, 0, this.stripZ[a] + this.stripNZ[a] * wa);
        position.setXYZ(2, this.stripX[b] - this.stripNX[b] * wb, 0, this.stripZ[b] - this.stripNZ[b] * wb);
        position.setXYZ(3, this.stripX[b] + this.stripNX[b] * wb, 0, this.stripZ[b] + this.stripNZ[b] * wb);
        position.needsUpdate = true;
    }
}

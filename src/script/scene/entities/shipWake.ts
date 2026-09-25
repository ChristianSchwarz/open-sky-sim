/**
 * Ship wake + four bow-wave arms (Kelvin inner ±19.47°, outer ±38.94°).
 * Stern foam is left in world space; bow spray drifts along each arm.
 *
 * The puffs here are the churn close to the ship. The long trail behind it is
 * {@link SternWakeRibbon} — a dithered 2 km strip, which a particle pool this
 * size cannot hold (see that module).
 */
import * as THREE from 'three';
import { Palette, PaletteCategory } from '../../config/palettes/palette';
import { PointEmitter } from '../../physics/particles/emitters/pointEmitter';
import { ParticleSystem } from '../../physics/particles/particleSystem';
import { CanvasPainter } from '../../render/screen/canvasPainter';
import { attachToRenderList } from '../../render/renderList';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials/materials';
import { updateUniforms } from '../utils';
import { Entity } from '../entity';
import { Scene, SceneLayers } from '../scene';
import { ARRESTOR_DECK_MID_X, ArrestorCarrierPose } from './arrestorCables';
import { SternWakeRibbon } from './sternWake';

type FoamKind = 'stern' | 'bow';

type FoamEmitter = {
    local: readonly [number, number, number];
    kind: FoamKind;
    rate: number;
    /**
     * Bow only: signed angle from the aft track (deg).
     * Negative = port, positive = starboard.
     */
    armDeg?: number;
};

/**
 * Kelvin full apex 38.94°. Four bow arms:
 *   inner  ±19.47° (half of 38.94° each side)
 *   outer  ±38.94° (full Kelvin angle each side — wider V)
 */
const KELVIN_FULL_ANGLE_DEG = 38.94;
const KELVIN_HALF_ANGLE_DEG = KELVIN_FULL_ANGLE_DEG * 0.5;

/** Lateral centreline of the kuz hull / landing deck (not model X=0). */
const MID_X = ARRESTOR_DECK_MID_X;

/** One big stern wake on the hull centreline (carrier-local; stern ≈ +Z). */
const STERN_EMITTERS: FoamEmitter[] = [
    { local: [MID_X, 0.25, 122], kind: 'stern', rate: 22 },
];

/** Four bow-wave arms from the tip on the sailing centreline. */
const BOW_EMITTERS: FoamEmitter[] = [
    { local: [MID_X, 0.3, -176], kind: 'bow', rate: 12, armDeg: -KELVIN_FULL_ANGLE_DEG },
    { local: [MID_X, 0.3, -176], kind: 'bow', rate: 12, armDeg: -KELVIN_HALF_ANGLE_DEG },
    { local: [MID_X, 0.3, -176], kind: 'bow', rate: 12, armDeg: KELVIN_HALF_ANGLE_DEG },
    { local: [MID_X, 0.3, -176], kind: 'bow', rate: 12, armDeg: KELVIN_FULL_ANGLE_DEG },
];

const ALL_EMITTERS: FoamEmitter[] = [...STERN_EMITTERS, ...BOW_EMITTERS];

/**
 * Pool for the stern churn plus four bow arms. At the rates and lifespans below
 * the steady-state demand (~1700) fits, so no live puff is ever recycled away —
 * which used to truncate both the stern trail and the far ends of the bow arms.
 */
const FOAM_PARTICLE_COUNT = 2000;
const FOAM_SURFACE_Y = 0.18;

/**
 * Churn immediately astern, blending into the head of {@link SternWakeRibbon}.
 * ~10–16 s at cruise ≈ 125–200 m; the ribbon carries the rest of the 2 km.
 */
const STERN_LIFE_MIN = 10;
const STERN_LIFE_SPAN = 6;

/** Speed of foam along each Kelvin arm (m/s), world frame. */
const BOW_ARM_SPEED_MPS = 4.5;

/**
 * Denser than the ribbon head (0.6) at the transom, fading to the ribbon's own
 * density ~200 m astern — where these puffs expire — so the handover from
 * churn to strip has no visible seam.
 */
const STERN_DITHER_START = 0.72;
const STERN_DITHER_END = 0.55;
const BOW_DITHER_START = 0.7;
const BOW_DITHER_END = 0.1;

type FoamParticleExtra = {
    kind: FoamKind;
    /** Foam tint (stern off-white vs bow white). */
    r: number;
    g: number;
    b: number;
};

const STERN_COLOR = new THREE.Color('#e8f0f4');
const BOW_COLOR = new THREE.Color('#ffffff');

export class ShipWakeEntity implements Entity {

    readonly tags: string[] = [];
    enabled = true;

    private readonly system: ParticleSystem;
    private readonly extras: FoamParticleExtra[];
    private readonly root = new THREE.Object3D();
    private readonly emitPos = new THREE.Vector3();
    private readonly emitAccum = new Float32Array(ALL_EMITTERS.length);
    /** Local aft-out arm direction before quaternion. */
    private readonly armLocal = new THREE.Vector3();
    private readonly armWorld = new THREE.Vector3();
    private readonly aftWorld = new THREE.Vector3();
    private readonly sternWorld = new THREE.Vector3();
    private readonly sternRibbon: SternWakeRibbon;

    // One instanced draw for the whole wake — a mesh per puff (2000 meshes and
    // materials) used to dominate the scene's draw-call count.
    private readonly geometry: THREE.InstancedBufferGeometry;
    private readonly attrOffset: THREE.InstancedBufferAttribute;
    private readonly attrScale: THREE.InstancedBufferAttribute;
    private readonly attrRotation: THREE.InstancedBufferAttribute;
    private readonly attrColor: THREE.InstancedBufferAttribute;

    constructor(
        materials: SceneMaterialManager,
        private readonly getCarrierPose: () => ArrestorCarrierPose,
    ) {
        // Added first: neither the ribbon nor the puffs write depth, so draw
        // order decides, and the puffs must sit on top of the strip.
        this.sternRibbon = new SternWakeRibbon(materials);
        this.root.add(this.sternRibbon.object);

        this.system = new ParticleSystem(
            {
                systemMaxParticles: FOAM_PARTICLE_COUNT,
                systemReSpawn: true,
                emitterSpawnRatePerSecond: 0,
                particleLifeMin: STERN_LIFE_MIN,
                particleLifeMax: STERN_LIFE_MIN + STERN_LIFE_SPAN,
                particleSizeStartMin: 4,
                particleSizeStartMax: 7,
                particleSizeEndMin: 16,
                particleSizeEndMax: 26,
                particleRotationStartMin: 0,
                particleRotationStartMax: Math.PI * 2,
                particleRotationEndMin: -Math.PI,
                particleRotationEndMax: Math.PI,
            },
            new PointEmitter(0, 0),
        );
        this.extras = Array.from({ length: FOAM_PARTICLE_COUNT }, () => ({
            kind: 'stern' as FoamKind,
            r: STERN_COLOR.r, g: STERN_COLOR.g, b: STERN_COLOR.b,
        }));

        const disc = new THREE.CircleGeometry(1, 6);
        this.geometry = new THREE.InstancedBufferGeometry();
        this.geometry.index = disc.index;
        this.geometry.attributes = disc.attributes;
        this.attrOffset = new THREE.InstancedBufferAttribute(new Float32Array(FOAM_PARTICLE_COUNT * 3), 3);
        this.attrScale = new THREE.InstancedBufferAttribute(new Float32Array(FOAM_PARTICLE_COUNT), 1);
        this.attrRotation = new THREE.InstancedBufferAttribute(new Float32Array(FOAM_PARTICLE_COUNT), 1);
        this.attrColor = new THREE.InstancedBufferAttribute(new Float32Array(FOAM_PARTICLE_COUNT * 4), 4);
        this.geometry.setAttribute('offset', this.attrOffset);
        this.geometry.setAttribute('scale', this.attrScale);
        this.geometry.setAttribute('rotation', this.attrRotation);
        this.geometry.setAttribute('color', this.attrColor);
        this.geometry.instanceCount = 0;

        const material = materials.build({
            type: SceneMaterialPrimitiveType.PARTICLE_MESH,
            category: PaletteCategory.TERRAIN_SHALLOW_WATER,
            depthWrite: false,
        }) as THREE.RawShaderMaterial;
        // Foam lies on the water surface instead of billboarding.
        material.defines = { GROUND_PLANE: 1 };

        const mesh = new THREE.Mesh(this.geometry, material);
        mesh.frustumCulled = false;
        mesh.onBeforeRender = updateUniforms;
        this.root.add(mesh);
    }

    init(_scene: Scene): void {
        //
    }

    /** Feed the 2 km dithered strip the live transom point and aft heading. */
    private updateSternRibbon(pose: ArrestorCarrierPose): void {
        const q = pose.quaternion;
        const [lx, , lz] = STERN_EMITTERS[0].local;
        this.sternWorld.set(lx, 0, lz);
        // Aft along the wake = opposite the bow (+Z local → world).
        this.aftWorld.set(0, 0, 1);
        if (q) {
            this.sternWorld.applyQuaternion(q);
            this.aftWorld.applyQuaternion(q);
        }
        this.sternWorld.add(pose.position as THREE.Vector3);
        this.sternRibbon.update(this.sternWorld, this.aftWorld);
    }

    update(delta: number): void {
        const pose = this.getCarrierPose();
        const q = pose.quaternion;
        this.updateSternRibbon(pose);

        for (let e = 0; e < ALL_EMITTERS.length; e++) {
            const emitter = ALL_EMITTERS[e];
            this.emitAccum[e] += emitter.rate * delta;
            const n = Math.floor(this.emitAccum[e]);
            if (n <= 0) {
                continue;
            }
            this.emitAccum[e] -= n;
            const [lx, ly, lz] = emitter.local;
            this.emitPos.set(lx, ly, lz);
            if (q) {
                this.emitPos.applyQuaternion(q);
            }
            this.emitPos.add(pose.position as THREE.Vector3);
            this.emitPos.y = FOAM_SURFACE_Y;
            this.system.position.copy(this.emitPos);
            const spawned = this.system.burst(n, true);
            let left = spawned;
            for (let i = 0; i < this.system.particles.length && left > 0; i++) {
                const p = this.system.particles[i];
                if (!p.isActive || p.life > 1e-6) {
                    continue;
                }
                if (p.position.distanceToSquared(this.emitPos) > 0.05) {
                    continue;
                }
                const extra = this.extras[i];
                extra.kind = emitter.kind;
                p.position.y = FOAM_SURFACE_Y;
                if (emitter.kind === 'bow') {
                    // ~4× prior bow life → long arms.
                    p.lifespan = 14 + Math.random() * 14;
                    p.sizeStart = 2.0 + Math.random() * 1.5;
                    p.sizeEnd = 8 + Math.random() * 6;
                    const armDeg = emitter.armDeg ?? KELVIN_HALF_ANGLE_DEG;
                    const armRad = armDeg * Math.PI / 180;
                    // Aft = +Z local; rotate about Y so |armDeg| is off the track.
                    this.armLocal.set(Math.sin(armRad), 0, Math.cos(armRad));
                    this.armWorld.copy(this.armLocal);
                    if (q) {
                        this.armWorld.applyQuaternion(q);
                    }
                    const speed = BOW_ARM_SPEED_MPS * (0.85 + Math.random() * 0.3);
                    p.velocity.copy(this.armWorld).multiplyScalar(speed);
                    extra.r = BOW_COLOR.r;
                    extra.g = BOW_COLOR.g;
                    extra.b = BOW_COLOR.b;
                } else {
                    // Churn astern; the ribbon carries the trail beyond it.
                    p.lifespan = STERN_LIFE_MIN + Math.random() * STERN_LIFE_SPAN;
                    p.sizeStart = 4 + Math.random() * 3;
                    p.sizeEnd = 16 + Math.random() * 10;
                    p.velocity.set(
                        (Math.random() - 0.5) * 0.25,
                        0,
                        (Math.random() - 0.5) * 0.25,
                    );
                    extra.r = STERN_COLOR.r;
                    extra.g = STERN_COLOR.g;
                    extra.b = STERN_COLOR.b;
                }
                left--;
            }
        }

        this.system.update(delta);

        // Compact live puffs into the instanced attributes.
        const offsets = this.attrOffset.array as Float32Array;
        const scales = this.attrScale.array as Float32Array;
        const rotations = this.attrRotation.array as Float32Array;
        const colors = this.attrColor.array as Float32Array;
        let n = 0;
        for (let i = 0; i < this.system.particles.length; i++) {
            const p = this.system.particles[i];
            if (!p.isActive) {
                continue;
            }
            p.position.y = FOAM_SURFACE_Y;
            p.velocity.y = 0;
            const t = p.lifespan > 1e-6 ? p.life / p.lifespan : 1;
            const extra = this.extras[i];
            let alpha: number;
            if (extra.kind === 'bow') {
                alpha = BOW_DITHER_START + (BOW_DITHER_END - BOW_DITHER_START) * t;
            } else {
                // Linear, ending on the ribbon head's density so the handover
                // from puffs to strip is invisible.
                alpha = STERN_DITHER_START + (STERN_DITHER_END - STERN_DITHER_START) * t;
            }
            offsets[n * 3] = p.position.x;
            offsets[n * 3 + 1] = p.position.y;
            offsets[n * 3 + 2] = p.position.z;
            scales[n] = p.sizeStart + (p.sizeEnd - p.sizeStart) * t;
            rotations[n] = p.rotationStart + (p.rotationEnd - p.rotationStart) * t;
            colors[n * 4] = extra.r;
            colors[n * 4 + 1] = extra.g;
            colors[n * 4 + 2] = extra.b;
            colors[n * 4 + 3] = alpha;
            n++;
        }
        this.geometry.instanceCount = n;
        this.attrOffset.needsUpdate = true;
        this.attrScale.needsUpdate = true;
        this.attrRotation.needsUpdate = true;
        this.attrColor.needsUpdate = true;
    }

    render3D(
        _targetWidth: number,
        _targetHeight: number,
        _camera: THREE.Camera,
        lists: Map<string, THREE.Scene>,
        _palette: Palette,
    ): void {
        const list = lists.get(SceneLayers.EntityFX);
        if (list) {
            attachToRenderList(list, this.root);
        }
    }

    render2D(
        _targetWidth: number,
        _targetHeight: number,
        _camera: THREE.Camera,
        _lists: Set<string>,
        _painter: CanvasPainter,
        _palette: Palette,
    ): void {
        //
    }
}

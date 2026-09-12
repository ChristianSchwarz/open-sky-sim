import * as THREE from 'three';
import { Palette, PaletteCategory, PaletteColor, PaletteColorShade } from '../../config/palettes/palette';
import { DAMAGE_SMOKE_PARTICLE_COUNT } from '../../defs';
import { PointEmitter } from '../../physics/particles/emitters/pointEmitter';
import { ParticleSystem } from '../../physics/particles/particleSystem';
import { SimHitEvent } from '../../physics/sim/simTypes';
import { CanvasPainter } from '../../render/screen/canvasPainter';
import { SceneMaterialManager, SceneMaterialPrimitiveType, SceneMaterialUniforms } from '../materials/materials';
import { updateUniforms } from '../utils';
import { Entity } from '../entity';
import { Scene, SceneLayers } from '../scene';
import { attachToRenderList } from '../../render/renderList';
import { clamp, lerp } from '../../utils/math';

/** Steady upward rise (m/s). */
const RISE_MPS = 20;
/** Small random horizontal drift (m/s). */
const DRIFT_MPS = 0.9;
/** How long a leak keeps emitting after the last hit while still alive (s). */
const LEAK_EMIT_DURATION_SEC = 14;
/**
 * Base emit rate at low speed (puffs/s). Sized with the pool so a cruising
 * aircraft's ~30 s of puffs fit without recycling the tail early.
 */
const LEAK_EMIT_RATE = 8;
/** At this airspeed (m/s), emit rate is ~2× base; scales linearly with speed. */
const SPEED_REF_MPS = 80;
/** Ground wreck plume — denser than in-flight. */
const CRASH_EMIT_RATE = 40;
const MAX_LEAKS = 8;
const MAX_HITS_PER_FRAME = 6;

const FLAME_DITHER = 0.75;
const SMOKE_DITHER_START = 0.72;
/** End of puff — near-zero (not 0: that disables dithering) so the tail vanishes. */
const SMOKE_DITHER_END = 0.02;
/**
 * Life fraction still on fire (yellow→red). Kept short so longer puff life
 * mostly adds gray smoke, not more flame.
 */
const FIRE_PHASE_END = 0.12;
/** How much of the start→end size growth happens during the fire phase. */
const FIRE_SIZE_GROWTH = 0.1;

export type DamageSmokePose = {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    velocity: THREE.Vector3;
    /** False after the killing blow — leak keeps emitting until reset. */
    isAlive: boolean;
    /** True after ground impact — pin the emitter at the wreck. */
    isCrashed: boolean;
};

type Leak = {
    active: boolean;
    targetId: string;
    localOffset: THREE.Vector3;
    emitRemaining: number;
    emitAccum: number;
    /** Lethal damage or crash — never time out. */
    permanent: boolean;
    /** Ground impact — emit from pinPos instead of following the hull. */
    crashed: boolean;
    pinPos: THREE.Vector3;
    /** Last emitter world position (used if pose disappears). */
    lastEmitPos: THREE.Vector3;
};

/**
 * Hit fire/smoke: puffs spawn at the impact point on the airframe, rise at
 * {@link RISE_MPS}, drift sideways, and cool yellow → red → gray.
 */
export class DamageSmokeField implements Entity {

    readonly tags: string[] = [];
    enabled = true;

    private readonly system: ParticleSystem;
    private readonly puffs: THREE.Mesh[] = [];
    private readonly root = new THREE.Object3D();
    private readonly leaks: Leak[] = [];
    private poseProvider: ((targetId: string) => DamageSmokePose | undefined) | undefined;

    private readonly worldPos = new THREE.Vector3();
    private readonly localOffset = new THREE.Vector3();
    private readonly invQuat = new THREE.Quaternion();
    private readonly tmpColor = new THREE.Color();
    private readonly tmpColorB = new THREE.Color();
    private readonly yellow = new THREE.Color();
    private readonly red = new THREE.Color();
    private readonly smoke = new THREE.Color();
    private readonly smokeB = new THREE.Color();

    constructor(materials: SceneMaterialManager) {
        // Near-zero emitter kick — we set absolute plume velocity after burst.
        this.system = new ParticleSystem(
            {
                systemMaxParticles: DAMAGE_SMOKE_PARTICLE_COUNT,
                systemReSpawn: true,
                emitterSpawnRatePerSecond: 0,
                particleLifeMin: 22,
                particleLifeMax: 30,
                particleSizeStartMin: 0.8,
                particleSizeStartMax: 1.3,
                particleSizeEndMin: 16,
                particleSizeEndMax: 24,
                particleRotationStartMin: -Math.PI,
                particleRotationStartMax: Math.PI,
                particleRotationEndMin: -Math.PI * 1.2,
                particleRotationEndMax: Math.PI * 1.2,
            },
            new PointEmitter(0.02, 0.08),
        );

        const geo = new THREE.CircleGeometry(1, 6);
        for (let i = 0; i < DAMAGE_SMOKE_PARTICLE_COUNT; i++) {
            const mat = materials.build({
                type: SceneMaterialPrimitiveType.MESH,
                category: PaletteCategory.FX_SMOKE,
                depthWrite: false,
                shaded: false,
                alphaDither: FLAME_DITHER,
                colorDither: true,
            });
            mat.side = THREE.DoubleSide;
            const mesh = new THREE.Mesh(geo, mat);
            mesh.frustumCulled = false;
            mesh.visible = false;
            mesh.onBeforeRender = updateUniforms;
            this.puffs.push(mesh);
            this.root.add(mesh);
        }

        for (let i = 0; i < MAX_LEAKS; i++) {
            this.leaks.push({
                active: false,
                targetId: '',
                localOffset: new THREE.Vector3(),
                emitRemaining: 0,
                emitAccum: 0,
                permanent: false,
                crashed: false,
                pinPos: new THREE.Vector3(),
                lastEmitPos: new THREE.Vector3(),
            });
        }
    }

    setPoseProvider(provider: (targetId: string) => DamageSmokePose | undefined): void {
        this.poseProvider = provider;
    }

    spawnFromHits(hits: SimHitEvent[]): void {
        if (!this.poseProvider) {
            return;
        }
        const n = Math.min(hits.length, MAX_HITS_PER_FRAME);
        for (let i = 0; i < n; i++) {
            const hit = hits[i];
            if (hit.source === 'scrape') {
                continue;
            }
            const pose = this.poseProvider(hit.targetId);
            if (!pose) {
                continue;
            }
            this.worldPos.set(hit.position[0], hit.position[1], hit.position[2]);
            this.openLeak(hit.targetId, pose, this.worldPos);
        }
    }

    /**
     * Gray smoke puffs pinned at world impact points (terrain scrapes).
     * No hull leak / no fire phase — smoke only on the ground.
     */
    spawnGroundScrapes(hits: SimHitEvent[]): void {
        let spawned = 0;
        for (let i = 0; i < hits.length && spawned < MAX_HITS_PER_FRAME; i++) {
            const hit = hits[i];
            if (hit.source !== 'scrape') {
                continue;
            }
            this.worldPos.set(hit.position[0], hit.position[1], hit.position[2]);
            this.system.position = this.worldPos;
            this.emitGroundSmokePuffs(3 + (hit.damage >= 20 ? 3 : 0));
            spawned++;
        }
    }

    /** Debug: open a leak near the aircraft origin. */
    spawnDebugLeak(targetId: string): void {
        const pose = this.poseProvider?.(targetId);
        if (!pose) {
            return;
        }
        this.worldPos.copy(pose.position);
        this.worldPos.y += 1;
        this.openLeak(targetId, pose, this.worldPos);
    }

    /**
     * Keep (or start) a pinned plume at the wreck after ground impact.
     * Safe to call every crash transition — does not reset an existing plume.
     */
    ensureCrashPlume(targetId: string): void {
        const pose = this.poseProvider?.(targetId);
        let slot = this.findLeak(targetId);
        if (!slot) {
            if (!pose) {
                return;
            }
            this.openLeak(targetId, pose, pose.position);
            slot = this.findLeak(targetId);
        }
        if (!slot) {
            return;
        }
        slot.permanent = true;
        if (pose) {
            this.localOffset.copy(slot.localOffset).applyQuaternion(pose.quaternion);
            this.worldPos.copy(pose.position).add(this.localOffset);
        } else {
            this.worldPos.copy(slot.lastEmitPos);
        }
        if (!slot.crashed) {
            slot.crashed = true;
            slot.pinPos.copy(this.worldPos);
        }
        slot.lastEmitPos.copy(slot.pinPos);
        slot.emitAccum = Math.max(slot.emitAccum, 2);
    }

    private openLeak(targetId: string, pose: DamageSmokePose, hitWorld: THREE.Vector3): void {
        let slot = this.findLeak(targetId);
        if (!slot) {
            slot = this.allocLeak();
            // Fresh occupancy — clear leftover wreck state from a prior aircraft.
            slot.permanent = false;
            slot.crashed = false;
        }
        slot.active = true;
        slot.targetId = targetId;
        // Don't shorten a permanent wreck plume if hits keep arriving.
        if (!slot.permanent) {
            slot.emitRemaining = LEAK_EMIT_DURATION_SEC;
        }
        slot.emitAccum = Math.max(slot.emitAccum, 1);

        // Store offset in aircraft local space so the emitter tracks the hull.
        this.invQuat.copy(pose.quaternion).invert();
        this.localOffset.copy(hitWorld).sub(pose.position).applyQuaternion(this.invQuat);
        slot.localOffset.copy(this.localOffset);
        slot.lastEmitPos.copy(hitWorld);
        if (!pose.isAlive || pose.isCrashed) {
            slot.permanent = true;
        }
        if (pose.isCrashed && !slot.crashed) {
            slot.crashed = true;
            slot.pinPos.copy(hitWorld);
        }
    }

    private findLeak(targetId: string): Leak | undefined {
        for (let i = 0; i < this.leaks.length; i++) {
            if (this.leaks[i].active && this.leaks[i].targetId === targetId) {
                return this.leaks[i];
            }
        }
        return undefined;
    }

    private allocLeak(): Leak {
        for (let i = 0; i < this.leaks.length; i++) {
            if (!this.leaks[i].active) {
                return this.leaks[i];
            }
        }
        // Prefer reclaiming a timed leak over a permanent wreck plume.
        let best = -1;
        for (let i = 0; i < this.leaks.length; i++) {
            if (this.leaks[i].permanent) {
                continue;
            }
            if (best < 0 || this.leaks[i].emitRemaining < this.leaks[best].emitRemaining) {
                best = i;
            }
        }
        if (best < 0) {
            best = 0;
        }
        return this.leaks[best];
    }

    reset(): void {
        this.system.reset();
        for (let i = 0; i < this.leaks.length; i++) {
            this.leaks[i].active = false;
            this.leaks[i].emitRemaining = 0;
            this.leaks[i].emitAccum = 0;
            this.leaks[i].permanent = false;
            this.leaks[i].crashed = false;
        }
        for (let i = 0; i < this.puffs.length; i++) {
            this.puffs[i].visible = false;
        }
    }

    init(_scene: Scene): void {
        //
    }

    private cachePaletteColors(palette: Palette): void {
        this.yellow.set(PaletteColor(palette, PaletteCategory.FX_FIRE__B));
        this.red.set(PaletteColor(palette, PaletteCategory.FX_FIRE));
        this.smoke.set(PaletteColor(palette, PaletteCategory.FX_SMOKE));
        this.smokeB.set(PaletteColorShade(palette, PaletteCategory.FX_SMOKE));
    }

    /** heat 0 = yellow, ~0.45 = red, 1 = gray smoke. */
    private applyHeatColors(heat01: number): void {
        const heat = clamp(heat01, 0, 1);
        if (heat < 0.45) {
            const t = heat / 0.45;
            this.tmpColor.copy(this.yellow).lerp(this.red, t);
            this.tmpColorB.copy(this.yellow);
        } else if (heat < 0.75) {
            const t = (heat - 0.45) / 0.3;
            this.tmpColor.copy(this.red).lerp(this.smoke, t);
            this.tmpColorB.copy(this.red).lerp(this.smokeB, t);
        } else {
            this.tmpColor.copy(this.smoke);
            this.tmpColorB.copy(this.smokeB);
        }
    }

    private emitAtLeak(leak: Leak, rate: number, delta: number, crashed: boolean): void {
        leak.emitAccum += rate * delta;
        const toSpawn = Math.floor(leak.emitAccum);
        if (toSpawn > 0) {
            leak.emitAccum -= toSpawn;
            this.emitPuffs(toSpawn, crashed);
        }
    }

    update(delta: number): void {
        if (this.poseProvider) {
            for (let i = 0; i < this.leaks.length; i++) {
                const leak = this.leaks[i];
                if (!leak.active) {
                    continue;
                }
                if (!leak.permanent) {
                    leak.emitRemaining -= delta;
                    if (leak.emitRemaining <= 0) {
                        leak.active = false;
                        continue;
                    }
                }
                const pose = this.poseProvider(leak.targetId);
                if (!pose) {
                    // Permanent / crashed plumes keep going from the last known spot.
                    if (leak.permanent || leak.crashed) {
                        if (!leak.crashed) {
                            leak.crashed = true;
                            leak.pinPos.copy(leak.lastEmitPos);
                        }
                        this.system.position = leak.pinPos;
                        this.emitAtLeak(leak, CRASH_EMIT_RATE, delta, true);
                        continue;
                    }
                    leak.active = false;
                    continue;
                }

                if (!pose.isAlive || pose.isCrashed) {
                    leak.permanent = true;
                }

                this.localOffset.copy(leak.localOffset).applyQuaternion(pose.quaternion);
                this.worldPos.copy(pose.position).add(this.localOffset);
                if (pose.isCrashed || leak.crashed) {
                    if (!leak.crashed) {
                        leak.crashed = true;
                        leak.pinPos.copy(this.worldPos);
                    }
                    this.worldPos.copy(leak.pinPos);
                }
                leak.lastEmitPos.copy(this.worldPos);
                this.system.position = this.worldPos;

                const speed = pose.velocity.length();
                const rate = leak.crashed
                    ? CRASH_EMIT_RATE
                    : LEAK_EMIT_RATE * (1 + speed / SPEED_REF_MPS);
                this.emitAtLeak(leak, rate, delta, leak.crashed);
            }
        }
        this.system.update(delta);
    }

    private emitPuffs(count: number, crashed: boolean): void {
        const prevSpawns: number[] = [];
        for (let i = 0; i < this.system.particles.length; i++) {
            prevSpawns.push(this.system.particles[i].spawns);
        }
        this.system.burst(count, true);
        for (let i = 0; i < this.system.particles.length; i++) {
            const p = this.system.particles[i];
            // spawns bumps on every activation — catches recycled slots that stay "was active".
            if (p.isActive && p.spawns !== prevSpawns[i]) {
                // Same plume behaviour in-flight and on the wreck: rise, drift,
                // long smoke life, widen, dither out to zero.
                p.velocity.set(
                    (Math.random() * 2 - 1) * DRIFT_MPS,
                    RISE_MPS * (0.9 + Math.random() * 0.2),
                    (Math.random() * 2 - 1) * DRIFT_MPS,
                );
                p.lifespan = 22 + Math.random() * 8;
                if (crashed) {
                    // Slightly larger origin on the ground fire only.
                    p.sizeStart = Math.max(p.sizeStart, 2.2 + Math.random() * 1.2);
                }
                p.sizeEnd = 16 + Math.random() * 8;
            }
        }
    }

    /** Short gray puffs at a ground scrape — skips the yellow/red fire phase. */
    private emitGroundSmokePuffs(count: number): void {
        const prevSpawns: number[] = [];
        for (let i = 0; i < this.system.particles.length; i++) {
            prevSpawns.push(this.system.particles[i].spawns);
        }
        this.system.burst(count, true);
        for (let i = 0; i < this.system.particles.length; i++) {
            const p = this.system.particles[i];
            if (p.isActive && p.spawns !== prevSpawns[i]) {
                p.velocity.set(
                    (Math.random() * 2 - 1) * DRIFT_MPS * 1.4,
                    RISE_MPS * (0.35 + Math.random() * 0.25),
                    (Math.random() * 2 - 1) * DRIFT_MPS * 1.4,
                );
                p.lifespan = 4 + Math.random() * 3;
                // Start past the fire phase so syncPuffs colours as gray smoke only.
                p.life = Math.max(p.life, FIRE_PHASE_END * p.lifespan + 1e-3);
                p.sizeStart = 1.2 + Math.random() * 0.8;
                p.sizeEnd = 6 + Math.random() * 4;
            }
        }
    }

    private syncPuffs(camera: THREE.Camera, palette: Palette): void {
        this.cachePaletteColors(palette);
        for (let i = 0; i < this.puffs.length; i++) {
            const p = this.system.particles[i];
            const mesh = this.puffs[i];
            if (!p.isActive) {
                mesh.visible = false;
                continue;
            }
            const progress = p.life / p.lifespan;
            // Most widening happens after the flame dies — smoke billows out.
            const sizeT = progress < FIRE_PHASE_END
                ? (progress / FIRE_PHASE_END) * FIRE_SIZE_GROWTH
                : FIRE_SIZE_GROWTH
                    + (1 - FIRE_SIZE_GROWTH)
                    * ((progress - FIRE_PHASE_END) / (1 - FIRE_PHASE_END));
            const size = p.sizeStart + (p.sizeEnd - p.sizeStart) * sizeT;
            mesh.visible = true;
            mesh.position.copy(p.position);
            mesh.scale.setScalar(size);

            // Yellow → red over the fire phase, then gray smoke for the rest.
            const heat = progress >= FIRE_PHASE_END ? 1 : progress / FIRE_PHASE_END;
            this.applyHeatColors(heat);
            const u = (mesh.material as THREE.ShaderMaterial).uniforms as SceneMaterialUniforms;
            u.color.value.copy(this.tmpColor);
            u.colorSecondary.value.copy(this.tmpColorB);
            // Ease-out dissolve: dense early, then a long thin tail to near-zero.
            const fadeT = 1 - (1 - progress) * (1 - progress);
            u.alphaDither.value = lerp(fadeT, SMOKE_DITHER_START, SMOKE_DITHER_END);

            mesh.lookAt(camera.position);
            mesh.rotateZ(p.rotationStart + (p.rotationEnd - p.rotationStart) * progress);
        }
    }

    render3D(_targetWidth: number, _targetHeight: number, camera: THREE.Camera, lists: Map<string, THREE.Scene>, palette: Palette): void {
        this.syncPuffs(camera, palette);
        const list = lists.get(SceneLayers.EntityFX);
        if (!list) {
            return;
        }
        attachToRenderList(list, this.root);
    }

    render2D(_targetWidth: number, _targetHeight: number, _camera: THREE.Camera, _lists: Set<string>, _painter: CanvasPainter, _palette: Palette): void {
        //
    }
}

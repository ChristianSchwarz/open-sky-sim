import * as THREE from 'three';
import { Palette, PaletteCategory } from '../../config/palettes/palette';
import { DEBRIS_PARTICLE_COUNT } from '../../defs';
import { SphereEmitter } from '../../physics/particles/emitters/sphereEmitter';
import { ConstantForce } from '../../physics/particles/forces/constantForce';
import { LinearDragForce } from '../../physics/particles/forces/linearDragForce';
import { ParticleSystem } from '../../physics/particles/particleSystem';
import { SimHitEvent } from '../../physics/sim/simTypes';
import { CanvasPainter } from '../../render/screen/canvasPainter';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials/materials';
import { updateUniforms } from '../utils';
import { Entity } from '../entity';
import { Scene, SceneLayers } from '../scene';
import { attachToRenderList } from '../../render/renderList';

const DEBRIS_PER_HIT = 6;
const DEBRIS_MAX_HITS_PER_FRAME = 6;
/** Inherit only a fraction of target velocity so chips visibly peel off. */
const DEBRIS_VELOCITY_INHERIT = 0.2;

const SPARK_COUNT = 48;
const SPARKS_PER_SCRAPE = 10;
const SPARK_MAX_SCRAPES_PER_FRAME = 6;
/** Short streak length along travel (local +Z), metres. */
const SPARK_LENGTH_M = 0.55;
const SPARK_WIDTH_M = 0.06;

/** Gray / brown palette picks for metal and dirt chips. */
const DEBRIS_COLORS: PaletteCategory[] = [
    PaletteCategory.VEHICLE_PLANE_GREY,
    PaletteCategory.SCENERY_BUILDING_CONCRETE,
    PaletteCategory.SCENERY_BUILDING_METAL,
    PaletteCategory.SCENERY_FIELD_OCHRE,
    PaletteCategory.SCENERY_TREE_TRUNK,
    PaletteCategory.SCENERY_ROAD_SECONDARY,
];

/** Hot glowing sparks for ground scrapes. */
const SPARK_COLORS: PaletteCategory[] = [
    PaletteCategory.FX_FIRE,
    PaletteCategory.FX_FIRE__B,
    PaletteCategory.LIGHT_YELLOW,
    PaletteCategory.SCENERY_FIELD_YELLOW,
];

/**
 * Hit debris (gun chips) plus short glowing scrape sparks at ground impacts.
 */
export class DebrisField implements Entity {

    readonly tags: string[] = [];
    enabled = true;

    private readonly system: ParticleSystem;
    private readonly emitter: SphereEmitter;
    private readonly chips: THREE.Mesh[] = [];
    /** Per-chip tumble axis (unit vectors). */
    private readonly spinAxes: THREE.Vector3[] = [];

    private readonly sparkSystem: ParticleSystem;
    private readonly sparkEmitter: SphereEmitter;
    private readonly sparks: THREE.Mesh[] = [];

    private readonly root = new THREE.Object3D();
    private readonly hitPos = new THREE.Vector3();
    private readonly hitVel = new THREE.Vector3();
    private readonly tmpQuat = new THREE.Quaternion();
    private readonly tmpFwd = new THREE.Vector3();

    constructor(materials: SceneMaterialManager) {
        // Tight shell + low kick so chips peel off the hull instead of exploding out.
        this.emitter = new SphereEmitter(1.5, 3.5, 2, 10);
        this.system = new ParticleSystem(
            {
                systemMaxParticles: DEBRIS_PARTICLE_COUNT,
                systemReSpawn: true,
                emitterSpawnRatePerSecond: 0,
                particleLifeMin: 2.5,
                particleLifeMax: 4.5,
                particleSizeStartMin: 0.6,
                particleSizeStartMax: 1.4,
                particleSizeEndMin: 0.3,
                particleSizeEndMax: 0.8,
                particleRotationStartMin: 0,
                particleRotationStartMax: Math.PI * 2,
                particleRotationEndMin: Math.PI * 4,
                particleRotationEndMax: Math.PI * 10,
            },
            this.emitter,
        );
        this.system.addForce(new ConstantForce(new THREE.Vector3(0, -9.80665, 0)));
        this.system.addForce(new LinearDragForce(0.55));

        const chipGeo = new THREE.PlaneGeometry(1, 1);
        for (let i = 0; i < DEBRIS_PARTICLE_COUNT; i++) {
            const mat = materials.build({
                type: SceneMaterialPrimitiveType.MESH,
                category: DEBRIS_COLORS[i % DEBRIS_COLORS.length],
                depthWrite: false,
                shaded: false,
            });
            mat.side = THREE.DoubleSide;
            const mesh = new THREE.Mesh(chipGeo, mat);
            mesh.frustumCulled = false;
            mesh.visible = false;
            mesh.onBeforeRender = updateUniforms;
            this.chips.push(mesh);
            this.root.add(mesh);
            this.spinAxes.push(new THREE.Vector3(
                Math.random() * 2 - 1,
                Math.random() * 2 - 1,
                Math.random() * 2 - 1,
            ).normalize());
        }

        // Short bright streaks kicked up from the ground contact.
        this.sparkEmitter = new SphereEmitter(0.05, 0.25, 8, 22);
        this.sparkSystem = new ParticleSystem(
            {
                systemMaxParticles: SPARK_COUNT,
                systemReSpawn: true,
                emitterSpawnRatePerSecond: 0,
                particleLifeMin: 0.12,
                particleLifeMax: 0.35,
                particleSizeStartMin: 0.7,
                particleSizeStartMax: 1.2,
                particleSizeEndMin: 0.15,
                particleSizeEndMax: 0.4,
                particleRotationStartMin: 0,
                particleRotationStartMax: 0,
                particleRotationEndMin: 0,
                particleRotationEndMax: 0,
            },
            this.sparkEmitter,
        );
        this.sparkSystem.addForce(new ConstantForce(new THREE.Vector3(0, -18, 0)));
        this.sparkSystem.addForce(new LinearDragForce(1.2));

        const sparkGeo = new THREE.BoxGeometry(SPARK_WIDTH_M, SPARK_WIDTH_M, SPARK_LENGTH_M);
        for (let i = 0; i < SPARK_COUNT; i++) {
            const mat = materials.build({
                type: SceneMaterialPrimitiveType.MESH,
                category: SPARK_COLORS[i % SPARK_COLORS.length],
                depthWrite: false,
                shaded: false,
            });
            const mesh = new THREE.Mesh(sparkGeo, mat);
            mesh.frustumCulled = false;
            mesh.visible = false;
            mesh.onBeforeRender = updateUniforms;
            this.sparks.push(mesh);
            this.root.add(mesh);
        }
    }

    /** Spawn a short burst at each gun hit. Caps work per frame under heavy fire. */
    spawnFromHits(hits: SimHitEvent[]): void {
        const n = Math.min(hits.length, DEBRIS_MAX_HITS_PER_FRAME);
        for (let i = 0; i < n; i++) {
            const hit = hits[i];
            if (hit.source === 'scrape') {
                continue;
            }
            this.hitPos.set(hit.position[0], hit.position[1], hit.position[2]);
            this.hitVel.set(
                hit.velocity[0] * DEBRIS_VELOCITY_INHERIT,
                hit.velocity[1] * DEBRIS_VELOCITY_INHERIT,
                hit.velocity[2] * DEBRIS_VELOCITY_INHERIT,
            );
            this.burstDebrisAt(this.hitPos, this.hitVel);
        }
        this.syncDebrisMeshes();
    }

    /**
     * Short glowing streaks at terrain scrape points (with ground smoke elsewhere).
     * Bias kicks sparks along the aircraft motion and slightly upward.
     */
    spawnGroundScrapes(hits: SimHitEvent[]): void {
        let spawned = 0;
        for (let i = 0; i < hits.length && spawned < SPARK_MAX_SCRAPES_PER_FRAME; i++) {
            const hit = hits[i];
            if (hit.source !== 'scrape') {
                continue;
            }
            this.hitPos.set(hit.position[0], hit.position[1], hit.position[2]);
            this.hitVel.set(
                hit.velocity[0] * 0.15,
                hit.velocity[1] * 0.15 + 6,
                hit.velocity[2] * 0.15,
            );
            this.sparkEmitter.setVelocityBias(this.hitVel);
            this.sparkSystem.position = this.hitPos;
            this.sparkSystem.burst(SPARKS_PER_SCRAPE, true);
            spawned++;
        }
        this.syncSparkMeshes();
    }

    /** Debug helper: emit one burst at a world position (e.g. Tab key). */
    spawnDebugBurst(position: THREE.Vector3, velocity?: THREE.Vector3): void {
        if (velocity) {
            this.hitVel.copy(velocity).multiplyScalar(DEBRIS_VELOCITY_INHERIT);
        } else {
            this.hitVel.set(0, 0, 0);
        }
        this.burstDebrisAt(position, this.hitVel);
        this.syncDebrisMeshes();
    }

    private burstDebrisAt(position: THREE.Vector3, velocityBias: THREE.Vector3, count = DEBRIS_PER_HIT): void {
        this.emitter.setVelocityBias(velocityBias);
        this.system.position = position;
        this.system.burst(count, true);
    }

    private syncDebrisMeshes(): void {
        for (let i = 0; i < this.chips.length; i++) {
            const p = this.system.particles[i];
            const mesh = this.chips[i];
            if (!p.isActive) {
                mesh.visible = false;
                continue;
            }
            const progress = p.life / p.lifespan;
            const size = p.sizeStart + (p.sizeEnd - p.sizeStart) * progress;
            const angle = p.rotationStart + (p.rotationEnd - p.rotationStart) * progress;
            mesh.visible = true;
            mesh.position.copy(p.position);
            mesh.scale.set(size, size * (0.55 + (i % 3) * 0.15), 1);
            this.tmpQuat.setFromAxisAngle(this.spinAxes[i], angle);
            mesh.quaternion.copy(this.tmpQuat);
        }
    }

    private syncSparkMeshes(): void {
        for (let i = 0; i < this.sparks.length; i++) {
            const p = this.sparkSystem.particles[i];
            const mesh = this.sparks[i];
            if (!p.isActive) {
                mesh.visible = false;
                continue;
            }
            const progress = p.life / p.lifespan;
            const lenScale = p.sizeStart + (p.sizeEnd - p.sizeStart) * progress;
            mesh.visible = true;
            mesh.position.copy(p.position);
            // Thin streak: shrink width as it dies, keep some length along velocity.
            mesh.scale.set(0.7 + (1 - progress) * 0.5, 0.7 + (1 - progress) * 0.5, lenScale);
            this.tmpFwd.copy(p.velocity);
            if (this.tmpFwd.lengthSq() < 1e-6) {
                this.tmpFwd.set(0, 1, 0);
            } else {
                this.tmpFwd.normalize();
            }
            this.tmpQuat.setFromUnitVectors(FORWARD_Z, this.tmpFwd);
            mesh.quaternion.copy(this.tmpQuat);
        }
    }

    init(_scene: Scene): void {
        //
    }

    update(delta: number): void {
        this.system.update(delta);
        this.sparkSystem.update(delta);
        this.syncDebrisMeshes();
        this.syncSparkMeshes();
    }

    render3D(_targetWidth: number, _targetHeight: number, _camera: THREE.Camera, lists: Map<string, THREE.Scene>, _palette: Palette): void {
        const list = lists.get(SceneLayers.EntityFlats) || lists.get(SceneLayers.EntityFX);
        if (!list) {
            return;
        }
        attachToRenderList(list, this.root);
    }

    render2D(_targetWidth: number, _targetHeight: number, _camera: THREE.Camera, _lists: Set<string>, _painter: CanvasPainter, _palette: Palette): void {
        //
    }
}

const FORWARD_Z = new THREE.Vector3(0, 0, 1);

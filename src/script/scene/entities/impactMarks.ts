import * as THREE from 'three';
import { FrameShift } from '../../terrain/geodesy';
import { Palette, PaletteCategory } from '../../config/palettes/palette';
import { CanvasPainter } from '../../render/screen/canvasPainter';
import { attachToRenderList } from '../../render/renderList';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials/materials';
import { updateUniforms } from '../utils';
import { Entity } from '../entity';
import { Scene, SceneLayers } from '../scene';
import { UP } from '../../utils/math';
import { MovingSurface } from './movingSurface';

/** Impact marks kept at once; past this the oldest is overwritten. */
const MAX_MARKS = 400;
/** Burn marks kept at once, in a pool of their own so they never push out the impact scars. */
const MAX_BURN_MARKS = 600;
/** Lift above the ground so a mark clears coplanar terrain depth (see aircraftShadow). */
const SURFACE_EPSILON_M = 0.12;
const DITHER_MIN = 0.12;
const DITHER_MAX = 0.42;
/**
 * Burn marks start at a level too thin to see (0 would mean solid: the shader
 * only dithers above a hair over zero) and darken to their target.
 */
const BURN_START_LEVEL = 0.004;
const BURN_LEVEL_MIN = 0.18;
const BURN_LEVEL_MAX = 0.6;
/** A burn mark grows from this fraction of its final size as it darkens. */
const BURN_START_SIZE = 0.55;

interface Mark {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    width: number;
    length: number;
    /** Darkness it is heading for, and how fast it gets there (level per second); 0 rate = fixed. */
    target: number;
    rate: number;
    /** Laid on a moving surface (a carrier deck): it goes along with it. */
    moving: boolean;
}

/** One instanced mesh of flat stippled blobs, as a ring buffer. */
class MarkPool {

    readonly mesh: THREE.InstancedMesh;
    private readonly level: THREE.InstancedBufferAttribute;
    private readonly marks: Mark[] = [];
    private next = 0;
    /** Marks still darkening. */
    private growing = 0;
    /** Marks that move with a surface. */
    private movers = 0;

    private readonly _m = new THREE.Matrix4();
    private readonly _tilt = new THREE.Quaternion();
    private readonly _yaw = new THREE.Quaternion();
    private readonly _scale = new THREE.Vector3();

    constructor(materials: SceneMaterialManager, private readonly capacity: number) {
        // An 8-sided blob lying flat (normal +Y); stretched along Z it reads as a gouge.
        const geo = new THREE.CircleGeometry(0.5, 8).rotateX(-Math.PI / 2);
        this.level = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(DITHER_MAX), 1);
        this.level.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('ditherLevel', this.level);
        const mat = materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.SCENERY_TREE_SHADOW,
            depthWrite: false,
            shaded: false,
            colorDither: false,
            vertexAlphaDither: true,
        });
        mat.side = THREE.DoubleSide;
        this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.frustumCulled = false;
        this.mesh.count = 0;
        this.mesh.visible = false;
        this.mesh.onBeforeRender = updateUniforms;
    }

    get size(): number {
        return this.marks.length;
    }

    add(
        position: THREE.Vector3, normal: THREE.Vector3, dirX: number, dirZ: number,
        length: number, width: number, level: number, target = level, rate = 0, moving = false,
    ): void {
        let mark = this.marks[this.next];
        if (mark === undefined) {
            mark = {
                position: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
                width: 1, length: 1, target: 0, rate: 0, moving: false,
            };
            this.marks[this.next] = mark;
        } else if (mark.rate > 0 && this.level.array[this.next] < mark.target) {
            // Overwriting a mark that was still darkening.
            this.growing--;
        }
        mark.position.copy(position).addScaledVector(normal, SURFACE_EPSILON_M);
        const heading = Math.hypot(dirX, dirZ) > 1e-6 ? Math.atan2(dirX, dirZ) : Math.random() * Math.PI * 2;
        this._yaw.setFromAxisAngle(UP, heading);
        this._tilt.setFromUnitVectors(UP, normal);
        mark.quaternion.copy(this._tilt).multiply(this._yaw);
        mark.width = width;
        mark.length = length;
        mark.target = target;
        mark.rate = rate;
        if (mark.moving) {
            this.movers--;
        }
        mark.moving = moving;
        if (moving) {
            this.movers++;
        }
        if (rate > 0) {
            this.growing++;
        }

        this.level.array[this.next] = level;
        this.level.needsUpdate = true;
        this.write(this.next, mark, rate > 0 ? BURN_START_SIZE : 1);
        this.next = (this.next + 1) % this.capacity;
        this.mesh.count = this.marks.length;
        this.mesh.visible = true;
    }

    /** Darken the marks that are still darkening, and let them grow to full size. */
    update(delta: number): void {
        if (this.growing <= 0) {
            return;
        }
        const levels = this.level.array;
        let still = 0;
        for (let i = 0; i < this.marks.length; i++) {
            const mark = this.marks[i];
            if (mark.rate <= 0 || levels[i] >= mark.target) {
                continue;
            }
            levels[i] = Math.min(mark.target, levels[i] + mark.rate * delta);
            const done = (levels[i] - BURN_START_LEVEL) / Math.max(1e-6, mark.target - BURN_START_LEVEL);
            this.write(i, mark, BURN_START_SIZE + (1 - BURN_START_SIZE) * Math.min(1, done));
            if (levels[i] < mark.target) {
                still++;
            }
        }
        this.growing = still;
        this.level.needsUpdate = true;
    }

    /** Move the marks laid on a moving surface along with it. */
    carry(velocity: THREE.Vector3, delta: number): void {
        if (this.movers <= 0) {
            return;
        }
        for (let i = 0; i < this.marks.length; i++) {
            const m = this.marks[i];
            if (!m.moving) {
                continue;
            }
            m.position.addScaledVector(velocity, delta);
            const done = m.rate > 0
                ? (this.level.array[i] - BURN_START_LEVEL) / Math.max(1e-6, m.target - BURN_START_LEVEL)
                : 1;
            this.write(i, m, m.rate > 0 ? BURN_START_SIZE + (1 - BURN_START_SIZE) * Math.min(1, done) : 1);
        }
    }

    clear(): void {
        this.marks.length = 0;
        this.next = 0;
        this.growing = 0;
        this.movers = 0;
        this.mesh.count = 0;
        this.mesh.visible = false;
    }

    rebase(shift: FrameShift): void {
        for (let i = 0; i < this.marks.length; i++) {
            shift.point(this.marks[i].position);
            shift.orientation(this.marks[i].quaternion);
            const m = this.marks[i];
            const done = m.rate > 0
                ? (this.level.array[i] - BURN_START_LEVEL) / Math.max(1e-6, m.target - BURN_START_LEVEL)
                : 1;
            this.write(i, m, m.rate > 0 ? BURN_START_SIZE + (1 - BURN_START_SIZE) * Math.min(1, done) : 1);
        }
    }

    private write(index: number, mark: Mark, size: number): void {
        this._scale.set(mark.width * size, 1, mark.length * size);
        this._m.compose(mark.position, mark.quaternion, this._scale);
        this.mesh.setMatrixAt(index, this._m);
        this.mesh.instanceMatrix.needsUpdate = true;
    }
}

/**
 * Scorch, pock and gouge marks left on the ground by a crash, and the burn
 * marks that appear under its fires as they burn. Each is a flat stippled blob
 * laid on the terrain like the aircraft's own ground shadow.
 */
export class ImpactMarks implements Entity {

    readonly tags: string[] = [];
    enabled = true;

    private readonly root = new THREE.Object3D();
    private readonly impact: MarkPool;
    private readonly burn: MarkPool;
    private moving: MovingSurface | undefined;

    constructor(materials: SceneMaterialManager) {
        this.impact = new MarkPool(materials, MAX_MARKS);
        this.burn = new MarkPool(materials, MAX_BURN_MARKS);
        this.root.add(this.impact.mesh);
        this.root.add(this.burn.mesh);
    }

    update(delta: number): void {
        this.burn.update(delta);
        if (this.moving) {
            this.impact.carry(this.moving.velocity, delta);
            this.burn.carry(this.moving.velocity, delta);
        }
    }

    /** Marks laid on this surface go along with it. */
    setMovingSurface(surface: MovingSurface | undefined): void {
        this.moving = surface;
    }

    init(_scene: Scene): void {
        //
    }

    /**
     * Lay a mark. `position` is the ground point (its Y is lifted a hair here),
     * `normal` the ground normal, `dirX/dirZ` the way its long axis runs.
     * `strength` 0..1 is how dark it is.
     */
    add(
        position: THREE.Vector3, normal: THREE.Vector3, dirX: number, dirZ: number,
        length: number, width: number, strength: number,
    ): void {
        const level = DITHER_MIN + (DITHER_MAX - DITHER_MIN) * Math.min(1, Math.max(0, strength));
        this.impact.add(
            position, normal, dirX, dirZ, length, width, level, level, 0,
            this.moving?.contains(position.x, position.y, position.z) ?? false);
    }

    /**
     * Lay a burn mark under a fire. It starts invisible and darkens, and grows
     * to its full size, over `growSeconds`; `strength` 0..1 is how dark it ends up.
     */
    addBurn(
        position: THREE.Vector3, normal: THREE.Vector3, dirX: number, dirZ: number,
        length: number, width: number, strength: number, growSeconds: number,
    ): void {
        const target = BURN_LEVEL_MIN + (BURN_LEVEL_MAX - BURN_LEVEL_MIN) * Math.min(1, Math.max(0, strength));
        this.burn.add(
            position, normal, dirX, dirZ, length, width,
            BURN_START_LEVEL, target, (target - BURN_START_LEVEL) / Math.max(0.1, growSeconds),
            this.moving?.contains(position.x, position.y, position.z) ?? false);
    }

    clear(): void {
        this.impact.clear();
        this.burn.clear();
    }

    rebase(shift: FrameShift): void {
        this.impact.rebase(shift);
        this.burn.rebase(shift);
    }

    render3D(_targetWidth: number, _targetHeight: number, _camera: THREE.Camera, lists: Map<string, THREE.Scene>, _palette: Palette): void {
        const list = lists.get(SceneLayers.EntityFX);
        if (!list || this.impact.size + this.burn.size === 0) {
            return;
        }
        attachToRenderList(list, this.root);
    }

    render2D(_targetWidth: number, _targetHeight: number, _camera: THREE.Camera, _lists: Set<string>, _painter: CanvasPainter, _palette: Palette): void {
        //
    }
}

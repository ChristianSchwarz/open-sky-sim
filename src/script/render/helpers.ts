import * as THREE from 'three';
import { Palette } from '../config/palettes/palette';
import { Model, ModelAnimation, modelHasAnim, modelMatchesPaletteTime } from '../scene/models/models';
import { assertExpr, assertIsDefined } from '../utils/asserts';
import { ParticleSystem } from '../physics/particles/particleSystem';
import { lerp } from '../utils/math';
import { PARTICLE_MESH_ATTR_COLOR, PARTICLE_MESH_ATTR_OFFSET, PARTICLE_MESH_ATTR_ROTATION, PARTICLE_MESH_ATTR_SCALE } from '../scene/models/lib/particleMeshModelBuilder';
import { SceneMaterialData } from '../scene/materials/materials';
import { attachToRenderList } from './renderList';


export function visibleWidthAtDistance(camera: THREE.PerspectiveCamera, position: number | THREE.Vector3): number {
    const d = typeof position === 'number' ? position : camera.position.distanceTo(position);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    return camera.aspect * 2 * Math.tan(fov / 2) * d;
}

export function modelScaledMaxSize(maxSize: number, scale: THREE.Vector3): number {
    const maxScale = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
    return maxSize * maxScale;
}

export const DEFAULT_LOD_BIAS = 3;

const ANIM_ROTATE_UP_SPEED = 0.4; // Revolutions per second
const REF_WIDTH = 320; // Pixels

enum PlaybackStatus {
    PLAYING,
    STOPPED
}

type LodAttachGroups = {
    group: THREE.Object3D;
    groupAnim: THREE.Object3D;
    hasAnim: boolean;
    paletteTime: Palette['time'];
    triangles: number;
};

/** Sums mesh triangle counts (incl. InstancedMesh) under an Object3D — used for the HUD's live triangle-count readout. */
function countObjectTriangles(root: THREE.Object3D): number {
    let total = 0;
    root.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
            const geometry = mesh.geometry;
            const vertexCount = geometry.index ? geometry.index.count : geometry.attributes.position.count;
            const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
            total += (vertexCount / 3) * instances;
        }
    });
    return total;
}

export class LODHelper {

    private elapsed: number = 0;

    /** Triangle count actually attached to the render lists by the last addToRenderList() call. */
    lastTriangles: number = 0;

    // Built groups cached per LOD level so several render passes with different
    // cameras (main view, weapons-target MFD, map MFD) can each pick their own
    // LOD in the same frame without clearing and re-adding all the meshes on
    // every pass. Safe because ModelManager.getModel clones per call, so LOD
    // levels within one model never share mesh objects.
    private flatsGroups: Map<number, LodAttachGroups> = new Map();
    private volumesGroups: Map<number, LodAttachGroups> = new Map();

    private animActions: THREE.AnimationAction[] = [];
    private animMixers: THREE.AnimationMixer[] = [];
    private playback: PlaybackStatus = PlaybackStatus.STOPPED;
    private originalPlaybackDuration: number = 0; // seconds
    private playbackDuration: number = 0; // seconds

    constructor(public model: Model, private bias: number = DEFAULT_LOD_BIAS) {
        if (model.animations.length !== 0) {
            this.createActions();
        }
    }

    private createActions() {
        //! Just volumes at LOD 0
        const map = new Map(this.model.lod[0].volumes.map(model => ([model.name, model])));
        this.model.animations.forEach(clip => {
            this.originalPlaybackDuration = Math.max(this.originalPlaybackDuration, clip.duration);
            const root = map.get(clip.name.replace('Action', ''));
            assertIsDefined(root, clip.name);
            const mixer = new THREE.AnimationMixer(root);
            this.animMixers.push(mixer);
            const action = mixer.clipAction(clip);
            action.loop = THREE.LoopOnce;
            action.clampWhenFinished = true;
            this.animActions.push(action);
        });
    }

    update(delta: number): void {
        this.elapsed += delta;
        if (this.playback === PlaybackStatus.PLAYING) {
            this.playback = PlaybackStatus.STOPPED;
            for (let i = 0; i < this.animMixers.length; i++) {
                this.animMixers[i].update(delta);
                if (this.animActions[i].isRunning()) {
                    this.playback = PlaybackStatus.PLAYING;
                }
            }
        }
    }

    play() {
        this.playback = PlaybackStatus.PLAYING;
        const timeScale = this.originalPlaybackDuration / this.playbackDuration
        for (let i = 0; i < this.animActions.length; i++) {
            this.animActions[i].timeScale = timeScale;
            this.animActions[i].play();
            this.animActions[i].paused = false;
        }
    }

    playBackwards() {
        this.playback = PlaybackStatus.PLAYING;
        const timeScale = this.originalPlaybackDuration / this.playbackDuration
        for (let i = 0; i < this.animActions.length; i++) {
            this.animActions[i].timeScale = -timeScale;
            this.animActions[i].play();
            this.animActions[i].paused = false;
        }
    }

    // [0,1]
    setPlaybackPosition(p: number) {
        this.playback = PlaybackStatus.STOPPED;
        const timeScale = this.originalPlaybackDuration / this.playbackDuration;
        for (let i = 0; i < this.animMixers.length; i++) {
            this.animActions[i].timeScale = timeScale;
            this.animActions[i].paused = false;
            this.animActions[i].play();
            this.animMixers[i].setTime(this.animActions[i].getClip().duration * p / timeScale);
            this.animActions[i].paused = true;
        }
    }

    setPlaybackDuration(seconds: number) {
        this.playbackDuration = seconds;
        const timeScale = this.originalPlaybackDuration / this.playbackDuration
        for (let i = 0; i < this.animMixers.length; i++) {
            this.animActions[i].timeScale = timeScale;
        }
    }

    addToRenderList(
        position: THREE.Vector3, quaternion: THREE.Quaternion, scale: THREE.Vector3,
        targetWidth: number, camera: THREE.Camera, palette: Palette,
        flatsId: string, volumesId: string, lists: Map<string, THREE.Scene>,
        forceLodLevel?: number) {

        const hasFlats = lists.has(flatsId);
        const hasVolumes = lists.has(volumesId);
        if (!hasFlats && !hasVolumes) return;

        const requestedLod = forceLodLevel !== undefined ? forceLodLevel : getLodLevel(position, scale, targetWidth, camera, this.model.maxSize, this.bias);
        const lodLevel = resolveLodLevel(this.model, requestedLod);
        this.lastTriangles = 0;
        if (lodLevel < 0) return;

        if (hasFlats && this.model.lod[lodLevel].flats.length > 0) {
            this.subRender(
                position, quaternion, scale,
                this.flatsGroups, this.model.lod[lodLevel].flats,
                flatsId, lists, palette, lodLevel,
            );
        }
        if (hasVolumes && this.model.lod[lodLevel].volumes.length > 0) {
            this.subRender(
                position, quaternion, scale,
                this.volumesGroups, this.model.lod[lodLevel].volumes,
                volumesId, lists, palette, lodLevel,
            );
        }
    }

    private subRender(
        position: THREE.Vector3, quaternion: THREE.Quaternion, scale: THREE.Vector3,
        groups: Map<number, LodAttachGroups>, collection: THREE.Object3D[], listId: string, lists: Map<string, THREE.Scene>,
        palette: Palette, lodLevel: number) {

        const list = lists.get(listId);
        assertIsDefined(list);

        let entry = groups.get(lodLevel);
        if (entry === undefined) {
            entry = {
                group: new THREE.Object3D(),
                groupAnim: new THREE.Object3D(),
                hasAnim: false,
                paletteTime: palette.time,
                triangles: 0,
            };
            groups.set(lodLevel, entry);
            this.populateGroups(entry, collection, palette.time);
        } else if (entry.paletteTime !== palette.time) {
            // Day/night flip: meshes tagged with a palette time appear or
            // disappear, so this LOD level's groups must be rebuilt.
            entry.paletteTime = palette.time;
            this.populateGroups(entry, collection, palette.time);
        }

        this.lastTriangles += entry.triangles;
        const { group, groupAnim, hasAnim } = entry;
        group.position.copy(position);
        group.quaternion.copy(quaternion);
        group.scale.copy(scale);
        attachToRenderList(list, group);

        if (hasAnim) {
            groupAnim.position.copy(position);
            groupAnim.quaternion.copy(quaternion);
            groupAnim.rotateY(2 * Math.PI * this.elapsed * ANIM_ROTATE_UP_SPEED);
            groupAnim.scale.copy(scale);
            attachToRenderList(list, groupAnim);
        }
    }

    private populateGroups(entry: LodAttachGroups, collection: THREE.Object3D[], time: Palette['time']) {
        entry.group.clear();
        entry.groupAnim.clear();
        entry.hasAnim = false;
        for (let i = 0; i < collection.length; i++) {
            const m = collection[i];
            if (modelMatchesPaletteTime(m, time)) {
                if (modelHasAnim(m, ModelAnimation.ROTATE_UP)) {
                    entry.hasAnim = true;
                    entry.groupAnim.add(m);
                } else {
                    entry.group.add(m);
                }
            }
        }
        entry.triangles = countObjectTriangles(entry.group) + countObjectTriangles(entry.groupAnim);
    }
}

class ParticleSystemHelper {

    private objVolumes: THREE.Object3D = new THREE.Object3D();

    constructor(public model: Model, private bias: number = DEFAULT_LOD_BIAS) { }

    updateAttributes(system: ParticleSystem) {
        assertExpr(this.model.lod.length > 0 && this.model.lod[0].volumes.length > 0);

        const mesh = this.model.lod[0].volumes[0] as THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material>;
        const material = mesh.material;
        const data = material.userData as SceneMaterialData
        assertIsDefined(data.ramp);
        const geometry = mesh.geometry;

        const offsets = this.getAttribute(geometry, PARTICLE_MESH_ATTR_OFFSET);
        const scales = this.getAttribute(geometry, PARTICLE_MESH_ATTR_SCALE);
        const rotations = this.getAttribute(geometry, PARTICLE_MESH_ATTR_ROTATION);
        const colors = this.getAttribute(geometry, PARTICLE_MESH_ATTR_COLOR);

        for (let i = 0; i < system.particles.length; i++) {
            const particle = system.particles[i];
            if (!particle.isActive) {
                scales.setX(i, 0.0);
                continue;
            }
            const progress = particle.life / particle.lifespan;
            const position = particle.position;
            const colorIndex = Math.min(data.ramp.length - 1, Math.floor(data.ramp.length * progress));
            const color = data.ramp[colorIndex];
            offsets.setXYZ(i, position.x, position.y, position.z);
            scales.setX(i, lerp(progress, particle.sizeStart, particle.sizeEnd));
            rotations.setX(i, lerp(progress, particle.rotationStart, particle.rotationEnd));
            colors.setXYZW(i, color.r, color.g, color.b, 1.0 - progress);
        }
        offsets.needsUpdate = true;
        scales.needsUpdate = true;
        rotations.needsUpdate = true;
        colors.needsUpdate = true;
    }

    getAttribute(geometry: THREE.InstancedBufferGeometry, id: string): THREE.BufferAttribute | THREE.InterleavedBufferAttribute {
        const attribute = geometry.attributes[id];
        assertIsDefined(attribute, id);
        return attribute;
    }

    addToRenderList(
        position: THREE.Vector3, scale: THREE.Vector3,
        targetWidth: number, camera: THREE.Camera, palette: Palette,
        volumesId: string, lists: Map<string, THREE.Scene>,
        forceLodLevel?: number) {

        const hasVolumes = lists.has(volumesId);
        if (!hasVolumes) return;

        const requestedLod = forceLodLevel !== undefined ? forceLodLevel : getLodLevel(position, scale, targetWidth, camera, this.model.maxSize, this.bias);
        const lodLevel = resolveLodLevel(this.model, requestedLod);
        if (lodLevel < 0) return;

        if (hasVolumes && this.model.lod[lodLevel].volumes.length > 0) {
            this.subRender(position, scale, this.objVolumes, this.model.lod[lodLevel].volumes, volumesId, lists, palette);
        }
    }

    private subRender(
        position: THREE.Vector3, scale: THREE.Vector3,
        dst: THREE.Object3D, collection: THREE.Object3D[], listId: string, lists: Map<string, THREE.Scene>,
        palette: Palette) {

        const list = lists.get(listId);
        assertIsDefined(list);
        dst.clear();
        for (let i = 0; i < collection.length; i++) {
            const m = collection[i];
            if (modelMatchesPaletteTime(m, palette.time)) {
                dst.add(m);
            }
        }
        dst.position.copy(position);
        dst.scale.copy(scale);
        attachToRenderList(list, dst);
    }
}

export function getLodLevel(position: THREE.Vector3, scale: THREE.Vector3, targetWidth: number, camera: THREE.Camera, modelMaxSize: number, bias: number = DEFAULT_LOD_BIAS): number {
    if ('isPerspectiveCamera' in camera === false || modelMaxSize === 0) {
        return 0;
    }
    const visibleWidthAtD = visibleWidthAtDistance(camera as THREE.PerspectiveCamera, position);
    if (visibleWidthAtD === 0) {
        return 0; // Camera and model at the same spot, can't get closer than that
    }
    const relativeSize = modelScaledMaxSize(modelMaxSize, scale) / visibleWidthAtD;
    const referenceSize = relativeSize * REF_WIDTH;
    const realSize = relativeSize * targetWidth;
    const ratio = realSize / referenceSize;
    const scaledRelativeSize = relativeSize * ratio;
    return scaledRelativeSize >= 1 ? 0 : Math.max(0, Math.floor(-Math.log2(scaledRelativeSize)) - bias);
}

/** True when a LOD level carries at least one drawable mesh. */
function lodLevelHasGeometry(model: Model, lodLevel: number): boolean {
    const level = model.lod[lodLevel];
    return level !== undefined && (level.flats.length > 0 || level.volumes.length > 0);
}

/** Indices of LOD levels that contain at least one mesh, ascending. */
function populatedLodLevels(model: Model): number[] {
    const levels: number[] = [];
    for (let i = 0; i < model.lod.length; i++) {
        if (lodLevelHasGeometry(model, i)) {
            levels.push(i);
        }
    }
    return levels;
}

/**
 * Map a requested screen-size LOD to a level that actually has geometry.
 * Imported aircraft often ship placeholder empty LOD scenes (1..5); without
 * this fallback they vanish once {@link getLodLevel} steps above 0.
 * Returns -1 when the model should be culled (no levels, or beyond the
 * coarsest authored LOD on assets with a real multi-LOD chain).
 */
export function resolveLodLevel(model: Model, requestedLod: number): number {
    const populated = populatedLodLevels(model);
    if (populated.length === 0) {
        return -1;
    }
    if (requestedLod >= model.lod.length) {
        // Scenery with several populated LODs is culled once past the end.
        // Single-populated imports keep their mesh visible at any distance.
        return populated.length > 1 ? -1 : populated[0];
    }
    for (let lod = requestedLod; lod >= 0; lod--) {
        if (lodLevelHasGeometry(model, lod)) {
            return lod;
        }
    }
    return populated[0];
}

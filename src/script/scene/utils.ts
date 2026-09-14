import * as THREE from 'three';
import { FogQuality } from '../config/profiles/profile';
import { COCKPIT_FOV, H_RES, V_RES } from '../defs';
import { visibleWidthAtDistance } from '../render/helpers';
import { RENDER_ORIGIN } from '../render/renderOrigin';
import { WeaponsTarget } from './entities/weaponsTarget';
import { PlayerEntity } from './entities/player';
import { SceneMaterialData, SceneMaterialUniforms } from './materials/materials';

const camDir = new THREE.Vector3();
const camPos = new THREE.Vector3();
const pos = new THREE.Vector3();

// camDir/camD are identical for every object in a render pass, but this runs
// per object via onBeforeRender — and getWorldDirection walks the parent chain
// each call. Recompute only when the render pass (frame counter) or camera
// changes; with thousands of objects this is a double-digit CPU saving.
let camCacheFrame = -1;
let camCacheCamera: THREE.Camera | undefined;
let camD = 0;

function refreshCameraCache(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    const frame = renderer.info.render.frame;
    if (frame === camCacheFrame && camera === camCacheCamera) {
        return;
    }
    camCacheFrame = frame;
    camCacheCamera = camera;
    if ('isPerspectiveCamera' in camera === false) {
        camDir.set(0, -1, 0);
    } else {
        camera.getWorldDirection(camDir).setY(0.0).normalize();
    }
    camPos.copy(camera.position);
    camD = camPos.negate().dot(camDir);
}

interface UniformRefreshStamp {
    __uniformFrame?: number;
    __uniformCamera?: THREE.Camera;
}

export function updateUniforms(this: THREE.Mesh, renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, group: THREE.Group) {
    const m = (material as THREE.ShaderMaterial);
    const u = m.uniforms as SceneMaterialUniforms;
    const data = m.userData as SceneMaterialData | undefined;

    // A material without scene data carries none of the uniforms below.
    if (!data || !('category' in data)) {
        return;
    }

    // Unshaded materials have no per-object uniforms — everything below is
    // pass-global. Refresh once per material per render pass; leaving
    // uniformsNeedUpdate false afterwards lets three.js skip the full uniform
    // re-upload on every draw (the dominant CPU cost with many meshes).
    if (data && !data.shaded) {
        const stamp = data as SceneMaterialData & UniformRefreshStamp;
        const frame = renderer.info.render.frame;
        if (stamp.__uniformFrame === frame && stamp.__uniformCamera === camera) {
            return;
        }
        stamp.__uniformFrame = frame;
        stamp.__uniformCamera = camera;
    }

    refreshCameraCache(renderer, camera);
    const fogType = data ? data.fog : FogQuality.LOW;

    if (u.uRenderOrigin) {
        (u.uRenderOrigin.value as THREE.Vector3).copy(RENDER_ORIGIN);
    }

    if (data?.shaded) {
        this.getWorldPosition(pos.copy(this.position));

        if (fogType === FogQuality.HIGH) {
            u.distance.value = pos.distanceTo(camera.position);
        } else if (fogType === FogQuality.LOW) {
            u.distance.value = pos.dot(camDir) + camD;
        } else {
            u.distance.value = 0;
        }

        (u.normalModelMatrix.value as THREE.Matrix3).getNormalMatrix(this.matrixWorld);
        if (u.clipBelowY && data.clipBelowYAbs > -1e20) {
            u.clipBelowY.value = data.clipBelowYAbs - RENDER_ORIGIN.y;
        }
    } else {
        (u.vCameraPos.value as THREE.Vector3).copy(camera.position);
        (u.vCameraNormal.value as THREE.Vector3).copy(camDir);
        u.vCameraD.value = camD;
    }
    u.fogType.value = fogType;

    const target = renderer.getRenderTarget();
    u.halfWidth.value = Math.floor((target?.width || H_RES) * 0.5);
    u.halfHeight.value = Math.floor((target?.height || V_RES) * 0.5);

    m.uniformsNeedUpdate = true;
}

const TARGET_SIZE_FACTOR = 2.0;
const TARGET_MAX_SIZE = 250;
const TARGET_CAMERA_MIN_ALTITUDE = 15;
const TARGET_CAMERA_ADAPTIVE_THRESHOLD = 5000;
const TARGET_CAMERA_CONSTANT_NEAR = 10;
const TARGET_CAMERA_CONSTANT_FAR = 10000;

// Returns the camera zoom factor
export function updateTargetCamera(actor: PlayerEntity, mainCamera: THREE.PerspectiveCamera, targetCamera: THREE.PerspectiveCamera): number {
    const weaponsTarget = actor.weaponsTarget;
    if (!weaponsTarget) return 0;

    const actorPosition = actor.getDisplayPosition();
    const d = actorPosition.distanceTo(weaponsTarget.position);
    const weaponsTargetZoomFactor = getWeaponsTargetZoomFactor(mainCamera, weaponsTarget, d);

    targetCamera.position.copy(actorPosition).setY(Math.max(TARGET_CAMERA_MIN_ALTITUDE, actorPosition.y));
    camPos.addVectors(weaponsTarget.position, weaponsTarget.localCenter);
    targetCamera.lookAt(camPos);
    targetCamera.fov = COCKPIT_FOV * 1 / weaponsTargetZoomFactor;
    if (d > TARGET_CAMERA_ADAPTIVE_THRESHOLD) {
        targetCamera.near = actorPosition.distanceTo(weaponsTarget.position) / 2;
        targetCamera.far = actorPosition.distanceTo(weaponsTarget.position) * 2;
    } else {
        targetCamera.near = TARGET_CAMERA_CONSTANT_NEAR;
        targetCamera.far = TARGET_CAMERA_CONSTANT_FAR;
    }
    targetCamera.updateProjectionMatrix();
    return weaponsTargetZoomFactor;
}

function getWeaponsTargetZoomFactor(mainCamera: THREE.PerspectiveCamera, weaponsTarget: WeaponsTarget, distance: number): number {
    const farWidth = visibleWidthAtDistance(mainCamera, distance);
    const relativeSize = TARGET_SIZE_FACTOR * Math.min(TARGET_MAX_SIZE, weaponsTarget.maxSize) / farWidth;
    return Math.pow(2, relativeSize >= 1 ? 0 : Math.max(0, Math.floor(-Math.log2(relativeSize))));
}
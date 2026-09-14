import * as THREE from 'three';
import { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PaletteCategory, PaletteTime } from '../../config/palettes/palette';
import { assertIsDefined } from '../../utils/asserts';
import { isZero } from '../../utils/math';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials/materials';
import { updateUniforms } from '../utils';
import { aircraftPackStore, isPackUrl, parsePackUrl } from '../../state/aircraftPack';
import { SHADOW_ALPHA_DITHER } from '../entities/aircraftShadow';


export interface ModelLodLevel {
    flats: THREE.Object3D[];
    volumes: THREE.Object3D[];
};

export interface Model {
    lod: ModelLodLevel[];
    animations: THREE.AnimationClip[];
    maxSize: number;
    center: THREE.Vector3;
}

export const LIB_PREFFIX = 'lib:';
export type ModelLoadedListener = (url: string, model: Model) => void;

// The GLASS material is drawn as a flat dark-grey surface with a light ordered
// dither, so canopies read as tinted glass without a real alpha-blend pipeline.
// alphaDither is roughly "fraction of pixels kept" (0.5 ≈ half see-through);
// a higher value means a lighter, sparser dither. Both are easy to tweak.
const GLASS_COLOR = '#333333';
const GLASS_ALPHA_DITHER = 0.65;
// Legacy mod imports tagged glass as the default import_mod.py hex instead of GLASS.
const LEGACY_GLASS_MATERIAL_NAMES = new Set(['GLASS', '#d1f7ff']);
/** Reserved material token from import_mod.py for TCA collider meshes. */
const COLLISION_MATERIAL = 'COLLISION';

function isGlassMaterialName(matName: string): boolean {
    return LEGACY_GLASS_MATERIAL_NAMES.has(matName);
}

function isCollisionMaterialName(matName: string): boolean {
    return matName === COLLISION_MATERIAL;
}

/** Land/water flats must write depth so entities under the ground are occluded. */
function isTerrainCategory(category: PaletteCategory): boolean {
    return (category as string).startsWith('TERRAIN_');
}

function shouldDepthWrite(isFlat: boolean, category: PaletteCategory): boolean {
    return !isFlat || isTerrainCategory(category);
}

export interface ModelLibBuilder {
    readonly type: string;
    build(materials: SceneMaterialManager): Model;
}

enum RequestStatus {
    LOADING,
    COMPLETED,
    ERROR
}

interface ModelWrapper {
    model: Model;
    status: RequestStatus;
    pending: { model: Model; listener?: ModelLoadedListener }[];
}

export function modelMatchesPaletteTime(obj: THREE.Object3D, time: PaletteTime): boolean {
    const modelTime = obj.userData.time as string | undefined;
    return !modelTime || modelTime === time;
}

export enum ModelAnimation {
    ROTATE_UP = 'rotateUp'
}

export function modelHasAnim(obj: THREE.Object3D, type: ModelAnimation): boolean {
    const modelAnim = obj.userData.anim as ModelAnimation | undefined;
    return modelAnim !== undefined && modelAnim === type;
}

export class ModelManager {

    private libBuilders: Map<string, ModelLibBuilder> = new Map();
    private models: Map<string, ModelWrapper> = new Map();
    private gltfLoader: GLTFLoader = new GLTFLoader();

    constructor(private materials: SceneMaterialManager, libBuilders: ModelLibBuilder[]) {
        libBuilders.forEach(b => this.libBuilders.set(b.type, b));
    }

    getModel(url: string, listener?: ModelLoadedListener): Model {
        let modelWrapper = this.models.get(url);

        if (modelWrapper === undefined) {
            if (url.startsWith(LIB_PREFFIX)) {
                const libType = url.substring(LIB_PREFFIX.length);
                const builder = this.libBuilders.get(libType);
                assertIsDefined(builder, `"${libType}"`);
                modelWrapper = {
                    model: builder.build(this.materials),
                    status: RequestStatus.COMPLETED,
                    pending: []
                }
            } else if (isPackUrl(url)) {
                modelWrapper = {
                    model: this.empty(),
                    status: RequestStatus.LOADING,
                    pending: []
                };
                const { packId, path } = parsePackUrl(url);
                const pack = aircraftPackStore.get(packId);
                if (!pack) {
                    modelWrapper.status = RequestStatus.ERROR;
                    console.error(`Error loading "${url}": pack "${packId}" is not loaded`);
                } else {
                    const loader = new GLTFLoader(pack.createLoadingManager());
                    loader.load(
                        pack.getBlobUrl(path),
                        this.getLoadFn(url, modelWrapper),
                        undefined,
                        this.getErrorFn(url, modelWrapper),
                    );
                }
            } else {
                modelWrapper = {
                    model: this.empty(),
                    status: RequestStatus.LOADING,
                    pending: []
                }
                this.gltfLoader.load(url, this.getLoadFn(url, modelWrapper), undefined, this.getErrorFn(url, modelWrapper));
            }
            this.models.set(url, modelWrapper);
        }

        const newModel = this.empty();

        if (modelWrapper.status === RequestStatus.LOADING) {
            modelWrapper.pending.push({ model: newModel, listener: listener });
        } else if (modelWrapper.status === RequestStatus.COMPLETED) {
            this.copyTo(modelWrapper.model, newModel);
            if (listener) listener(url, newModel);
        }

        return newModel;
    }

    /** Drop cached models for a pack so a rebuilt archive is loaded fresh. */
    invalidatePack(packId: string): void {
        const prefix = `pack:${packId}/`;
        for (const url of [...this.models.keys()]) {
            if (url.startsWith(prefix)) {
                this.models.delete(url);
            }
        }
    }

    /** Resolves when the model at {@link url} has finished loading (no-op if cached). */
    waitForModel(url: string): Promise<void> {
        return new Promise((resolve) => {
            this.getModel(url, () => resolve());
        });
    }


    private getLoadFn(url: string, wrapper: ModelWrapper): (gltf: GLTF) => void {
        return (gltf: GLTF) => {
            wrapper.model = this.processModel(gltf, wrapper.model, url);
            wrapper.status = RequestStatus.COMPLETED;
            wrapper.pending.forEach(p => {
                this.copyTo(wrapper.model, p.model);
                if (p.listener) p.listener(url, p.model);
            });
            wrapper.pending = [];
        }
    }

    private getErrorFn(url: string, wrapper: ModelWrapper): (error: unknown) => void {
        return (error: unknown) => {
            wrapper.status = RequestStatus.ERROR;
            wrapper.pending = [];
            console.error(`Error loading "${url}":`, error);
        }
    }

    private processModel(gltf: GLTF, model: Model, url: string = ''): Model {
        const scenes = [...gltf.scenes].sort(this.sortingFn);
        const AABBox = new THREE.Box3();
        const worldAABB = new THREE.Box3();
        const isShadowModel = ModelManager.isShadowModelUrl(url);
        const isKuzModel = ModelManager.isKuzModelUrl(url);
        model.lod = scenes.map(scene => {
            const level: ModelLodLevel = {
                flats: [],
                volumes: []
            };
            // Bake ancestor transforms before extracting meshes — LODHelper
            // reparents each mesh into a fresh group, which would otherwise drop
            // rotations on intermediate Groups (e.g. kuz carrier's 90° X tilt).
            scene.updateWorldMatrix(true, true);
            scene.traverse(child => {
                if ('isGroup' in child) return;
                const obj = child as THREE.Mesh | THREE.LineSegments | THREE.Points;
                if (!obj.geometry) return;

                const srcMat = ('material' in obj && obj.material && !Array.isArray(obj.material))
                    ? (obj.material as THREE.Material)
                    : undefined;
                const matName = srcMat?.name ?? '';
                const isCollision = isCollisionMaterialName(matName)
                    || ModelManager.isCollisionModelUrl(url);
                if (isCollision) {
                    // Keep the mesh in the loaded graph for debugging, but never draw it.
                    obj.visible = false;
                    return;
                }

                obj.matrix.copy(obj.matrixWorld);
                obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
                obj.matrixAutoUpdate = true;

                obj.geometry.computeBoundingBox();
                obj.onBeforeRender = updateUniforms;

                const localAABB = obj.geometry.boundingBox;
                assertIsDefined(localAABB);
                worldAABB.copy(localAABB).applyMatrix4(obj.matrix);
                AABBox.union(worldAABB);

                // Flats are ground-aligned (zero thickness in world Y).
                const isFlat = isZero(worldAABB.max.y || 0.0) && isZero(worldAABB.min.y || 0.0);
                if (isFlat) {
                    level.flats.push(obj);
                } else {
                    obj.geometry.rotateY(0.0001); //! HACK: Fixes issue dithering axis-aligned triangles
                    level.volumes.push(obj);
                }

                if ('isMesh' in obj) {
                    if (isShadowModel) {
                        // Imported packs historically tagged shadows VEHICLE_PLANE_GREY;
                        // always map *_shadow models to a black alpha-stippled silhouette.
                        obj.material = this.materials.build({
                            type: SceneMaterialPrimitiveType.MESH,
                            category: PaletteCategory.SCENERY_TREE_SHADOW,
                            shaded: false,
                            depthWrite: false,
                            colorDither: false,
                            alphaDither: SHADOW_ALPHA_DITHER,
                        });
                    } else if (isGlassMaterialName(matName)) {
                        obj.material = this.materials.build({
                            type: SceneMaterialPrimitiveType.MESH,
                            category: PaletteCategory.GLASS,
                            rawColor: GLASS_COLOR,
                            shaded: false,
                            alphaDither: GLASS_ALPHA_DITHER,
                            depthWrite: !isFlat
                        });
                        (obj.material as THREE.ShaderMaterial).side = THREE.DoubleSide;
                    } else {
                        const rawColor = ModelManager.rawColorFor(matName);
                        let category = rawColor
                            ? PaletteCategory.VEHICLE_PLANE_GREY
                            : ModelManager.paletteCategoryOrFallback(matName);
                        // Kuz hull exports as building metal (light grey); use navy
                        // engine charcoal so the carrier reads darker at sea.
                        if (isKuzModel && category === PaletteCategory.SCENERY_BUILDING_METAL) {
                            category = PaletteCategory.VEHICLE_PLANE_ENGINE;
                        }
                        obj.material = this.materials.build({
                            type: SceneMaterialPrimitiveType.MESH,
                            category,
                            rawColor,
                            shaded: !isFlat,
                            depthWrite: shouldDepthWrite(isFlat, category),
                            // Hide kuz hull below sea level (opaque water alone cannot occlude it).
                            ...(isKuzModel && !isFlat ? { clipBelowY: 0.05 } : {}),
                        });
                        // Mod imports and textured scenery often need both sides
                        // (original glTF doubleSided, or #rrggbb raw-color meshes).
                        if (rawColor || srcMat?.side === THREE.DoubleSide) {
                            (obj.material as THREE.ShaderMaterial).side = THREE.DoubleSide;
                        }
                    }
                } else if ('isLineSegments' in child) {
                    const lineCategory = isShadowModel
                        ? PaletteCategory.SCENERY_TREE_SHADOW
                        : ModelManager.paletteCategoryOrFallback(
                            (obj.material as THREE.LineBasicMaterial).name);
                    obj.material = this.materials.build({
                        type: SceneMaterialPrimitiveType.LINE,
                        category: lineCategory,
                        depthWrite: shouldDepthWrite(isFlat, lineCategory)
                    });
                } else if ('isPoints' in child) {
                    const pointCategory = isShadowModel
                        ? PaletteCategory.SCENERY_TREE_SHADOW
                        : ModelManager.paletteCategoryOrFallback(
                            (obj.material as THREE.PointsMaterial).name);
                    obj.material = this.materials.build({
                        type: SceneMaterialPrimitiveType.POINT,
                        category: pointCategory,
                        depthWrite: shouldDepthWrite(isFlat, pointCategory)
                    });
                }
            });

            level.flats.sort(this.sortingFn);
            level.volumes.sort(this.sortingFn);
            return level;
        });
        model.animations = gltf.animations;
        model.maxSize = Math.max(...AABBox.getSize(new THREE.Vector3()).toArray());
        AABBox.getCenter(model.center);
        return model;
    }

    /** True for flyable-aircraft ground-shadow assets (`*_shadow.gltf` / `.glb`). */
    private static isShadowModelUrl(url: string): boolean {
        const path = isPackUrl(url) ? parsePackUrl(url).path : url;
        return /_shadow\.(gltf|glb)(\?|#|$)/i.test(path);
    }

    /** True for the Kuznetsov carrier hull (`kuz.glb`). */
    private static isKuzModelUrl(url: string): boolean {
        const path = isPackUrl(url) ? parsePackUrl(url).path : url;
        return /(^|\/)kuz\.(gltf|glb)(\?|#|$)/i.test(path);
    }

    /** True for flyable-aircraft collider assets (`*_collision.gltf` / `.glb`). */
    private static isCollisionModelUrl(url: string): boolean {
        const path = isPackUrl(url) ? parsePackUrl(url).path : url;
        return /_collision\.(gltf|glb)(\?|#|$)/i.test(path);
    }

    private sortingFn(a: THREE.Object3D, b: THREE.Object3D) {
        return parseInt(a.name.charAt(0)) - parseInt(b.name.charAt(0));
    }

    /**
     * Material names shaped like '#rrggbb' carry a literal colour (models that
     * bring their own per-polygon palette, e.g. an imported mod) rather than a
     * PaletteCategory. Returns the CSS colour, or undefined for category names.
     */
    private static rawColorFor(name: string): string | undefined {
        return /^#[0-9a-fA-F]{6}$/.test(name) ? name : undefined;
    }

    /** Map a glTF material name to a PaletteCategory; unknown names fall back. */
    private static paletteCategoryOrFallback(name: string): PaletteCategory {
        const values = Object.values(PaletteCategory) as string[];
        if (values.includes(name)) {
            return name as PaletteCategory;
        }
        return PaletteCategory.VEHICLE_PLANE_GREY;
    }

    private empty(): Model {
        return { lod: [], animations: [], maxSize: 0, center: new THREE.Vector3() };
    }

    private copyTo(src: Model, dst: Model) {
        dst.lod = src.lod.map(level => ({
            flats: level.flats.map(obj => this.cloneObj(obj)),
            volumes: level.volumes.map(obj => this.cloneObj(obj))
        }));
        dst.animations = src.animations; // No need to copy the clips
        dst.maxSize = src.maxSize;
        dst.center.copy(src.center);
    }

    private cloneObj(obj: THREE.Object3D): THREE.Object3D {
        const o = obj.clone();
        o.onBeforeRender = updateUniforms;
        return o;
    }
}

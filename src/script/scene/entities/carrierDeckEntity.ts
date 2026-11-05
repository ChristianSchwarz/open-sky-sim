/**
 * The Kuznetsov's deck paint, lights and Luna landing sight, riding with the
 * ship. Built once from the hull's own triangles (the collision bake of
 * kuz.glb), so a re-export of the hull keeps the paint on it.
 *
 * Draws in EntityFX, after the carrier's volumes: the paint is unlit, does
 * not write depth and sits PAINT_LIFT_M above the deck, the way runway paint
 * sits on pavement. Thin lines go at a distance where they would only sparkle.
 */
import * as THREE from 'three';
import { Palette, PaletteCategory, PaletteTime } from '../../config/palettes/palette';
import { CanvasPainter } from '../../render/screen/canvasPainter';
import { attachToRenderList } from '../../render/renderList';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials/materials';
import { updateUniforms } from '../utils';
import { Entity } from '../entity';
import { Scene, SceneLayers } from '../scene';
import { ArrestorCarrierPose } from './arrestorCables';
import { ANGLED_DECK_AXIS, KUZ_DECK_Y } from './carrierDeckLayout';
import { DeckPaint, carrierDeckMarkings } from './carrierDeckMarkings';
import { CarrierDeckSurface } from './carrierDeckSurface';
import { buildCarrierLights } from './carrierLights';

/** Paint above the deck plane (m), as runway paint above pavement. */
const PAINT_LIFT_M = 0.04;
/** Line paint is dropped where a pixel spans more than this (m): beyond ~2 km. */
const PAINT_MAX_FOOTPRINT_M = 2;
/** Beyond this the whole deck set is not drawn (the lights fade out sooner on their own). */
const DRAW_RANGE_M = 25000;

const PAINT_STYLE: Record<DeckPaint, { category: PaletteCategory; rawColor?: string; far?: boolean }> = {
    white: { category: PaletteCategory.SCENERY_BASE_RUNWAY_LINES },
    yellow: { category: PaletteCategory.SCENERY_FIELD_YELLOW },
    red: { category: PaletteCategory.SCENERY_BUILDING_METAL_RED },
    dark: { category: PaletteCategory.SCENERY_TREE_SHADOW, rawColor: '#1c1d20' },
    lip: { category: PaletteCategory.SCENERY_BUILDING_METAL_WHITE, far: true },
};

export class CarrierDeckEntity implements Entity {
    readonly tags: string[] = [];
    enabled = true;

    private readonly root = new THREE.Object3D();
    private readonly night = new THREE.Group();
    private readonly anchor = new THREE.Vector3();

    constructor(
        materials: SceneMaterialManager,
        private readonly getCarrierPose: () => ArrestorCarrierPose,
        hullTriangles: ArrayLike<number>,
    ) {
        const deck = new CarrierDeckSurface(hullTriangles);
        for (const [paint, xz] of carrierDeckMarkings()) {
            const soup = deck.drape(xz, PAINT_LIFT_M);
            if (soup.length === 0) continue;
            const style = PAINT_STYLE[paint];
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soup), 3));
            geometry.computeBoundingSphere();
            const material = materials.build({
                type: SceneMaterialPrimitiveType.MESH,
                category: style.category,
                rawColor: style.rawColor,
                shaded: false,
                depthWrite: false,
                maxFootprintM: style.far ? undefined : PAINT_MAX_FOOTPRINT_M,
            });
            (material as THREE.ShaderMaterial).side = THREE.DoubleSide;
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = 'carrierPaint:' + paint;
            mesh.onBeforeRender = updateUniforms;
            mesh.frustumCulled = false;
            this.root.add(mesh);
        }

        const { night, luna } = buildCarrierLights(deck, materials);
        for (const o of night) this.night.add(o);
        this.root.add(this.night);
        for (const o of luna) this.root.add(o);
        this.root.add(this.lunaHousing(materials, luna));
        this.anchor.set(0, 14, 0);
        this.syncRoot();
    }

    /** A dark panel behind the Luna's lights, so the unit reads by day. */
    private lunaHousing(materials: SceneMaterialManager, luna: THREE.Object3D[]): THREE.Object3D {
        const box = new THREE.Box3();
        for (const o of luna) {
            const g = (o as THREE.Points).geometry;
            g.computeBoundingBox();
            if (g.boundingBox) box.union(g.boundingBox);
        }
        const centre = box.getCenter(new THREE.Vector3());
        const across = box.getSize(new THREE.Vector3());
        const width = Math.hypot(across.x, across.z) + 1;
        const height = across.y + 1;
        const material = materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.SCENERY_TREE_SHADOW,
            rawColor: '#202226',
            shaded: false,
            depthWrite: true,
        });
        (material as THREE.ShaderMaterial).side = THREE.DoubleSide;
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
        // Face aft down the angled deck, a little forward of the lights.
        panel.position.copy(centre).addScaledVector(ANGLED_DECK_AXIS as THREE.Vector3, 0.15);
        panel.lookAt(panel.position.clone().sub(ANGLED_DECK_AXIS as THREE.Vector3));
        panel.name = 'lunaHousing';
        panel.onBeforeRender = updateUniforms;
        // Its post, down to the deck.
        const postHeight = Math.max(0.5, centre.y - height / 2 - KUZ_DECK_Y);
        const post = new THREE.Mesh(new THREE.PlaneGeometry(0.4, postHeight), material);
        post.position.set(0, -(height + postHeight) / 2, 0.01);
        post.onBeforeRender = updateUniforms;
        panel.add(post);
        return panel;
    }

    private syncRoot(): void {
        const pose = this.getCarrierPose();
        this.root.position.copy(pose.position as THREE.Vector3);
        if (pose.quaternion) {
            this.root.quaternion.copy(pose.quaternion);
        } else {
            this.root.quaternion.identity();
        }
        this.root.updateMatrixWorld(true);
    }

    init(_scene: Scene): void {
        //
    }

    update(_delta: number): void {
        this.syncRoot();
    }

    render3D(
        _targetWidth: number,
        _targetHeight: number,
        camera: THREE.Camera,
        lists: Map<string, THREE.Scene>,
        palette: Palette,
    ): void {
        this.syncRoot();
        const at = this.root.localToWorld(this.anchor.set(0, 14, 0));
        if (camera.position.distanceTo(at) > DRAW_RANGE_M) return;
        this.night.visible = palette.time === PaletteTime.NIGHT;
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

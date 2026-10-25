/**
 * Land arresting wires (landArrestorWires.ts): straight when idle, V-bent to
 * the hook while one holds the player - the carrier's ArrestorCablesEntity
 * for wires that are not on a ship.
 *
 * Near the camera thin black ribbons, beyond ARRESTOR_LOD_LINE_M 1px lines.
 * The wires are read through `getWires` every frame, so a floating-origin
 * re-base (which moves the game's own records) moves them too.
 */
import * as THREE from 'three';
import { Palette, PaletteCategory } from '../../config/palettes/palette';
import { SimProxyFlightModel } from '../../physics/model/simProxyFlightModel';
import { CanvasPainter } from '../../render/screen/canvasPainter';
import { attachToRenderList } from '../../render/renderList';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials/materials';
import { updateUniforms } from '../utils';
import { Entity } from '../entity';
import { Scene, SceneLayers } from '../scene';
import { PlayerEntity } from './player';
import { latchedHookTipWorld } from './arrestorCables';
import { LandArrestorWire } from './landArrestorWires';

/** Ribbon half-width (m), as on the carrier. */
const WIRE_HALF_W_M = 0.04;
/** Camera distance (m) beyond which a wire is a 1px line. */
const ARRESTOR_LOD_LINE_M = 350;
/** Nothing is drawn for a wire farther than this (m). */
const WIRE_DRAW_RANGE_M = 6000;

type WireView = {
    wire: LandArrestorWire;
    legA: THREE.Mesh;
    legAPos: THREE.BufferAttribute;
    legB: THREE.Mesh;
    legBPos: THREE.BufferAttribute;
    line: THREE.Line;
    linePos: THREE.BufferAttribute;
};

export class LandArrestorWiresEntity implements Entity {

    readonly tags: string[] = [];
    enabled = true;

    private readonly root = new THREE.Object3D();
    private readonly views: WireView[] = [];
    private readonly ribbonMat: THREE.Material;
    private readonly lineMat: THREE.Material;
    private readonly mid = new THREE.Vector3();
    private readonly latchedMid = new THREE.Vector3();
    private readonly hinge = new THREE.Vector3();
    private readonly fallbackDir = new THREE.Vector3(0, -1, -1);
    private builtFor: readonly LandArrestorWire[] | undefined;

    constructor(
        materials: SceneMaterialManager,
        private readonly getWires: () => readonly LandArrestorWire[],
        private readonly getPlayer: () => PlayerEntity,
    ) {
        this.ribbonMat = materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.SCENERY_TREE_SHADOW,
            shaded: false,
            depthWrite: false,
            colorDither: false,
            rawColor: '#000000',
        });
        this.lineMat = materials.build({
            type: SceneMaterialPrimitiveType.LINE,
            category: PaletteCategory.SCENERY_TREE_SHADOW,
            depthWrite: false,
            rawColor: '#000000',
        });
    }

    /** One view per wire; rebuilt when the game hands over a new list. */
    private syncViews(): void {
        const wires = this.getWires();
        if (wires === this.builtFor) {
            return;
        }
        this.builtFor = wires;
        for (const v of this.views) {
            this.root.remove(v.legA, v.legB, v.line);
            v.legA.geometry.dispose();
            v.legB.geometry.dispose();
            v.line.geometry.dispose();
        }
        this.views.length = 0;
        for (const wire of wires) {
            const legA = this.makeQuad();
            const legB = this.makeQuad();
            const lineGeom = new THREE.BufferGeometry();
            const linePos = new THREE.BufferAttribute(new Float32Array(9), 3);
            lineGeom.setAttribute('position', linePos);
            const line = new THREE.Line(lineGeom, this.lineMat);
            line.frustumCulled = false;
            line.onBeforeRender = updateUniforms;
            this.root.add(legA, legB, line);
            this.views.push({
                wire, legA, legB, line, linePos,
                legAPos: legA.geometry.getAttribute('position') as THREE.BufferAttribute,
                legBPos: legB.geometry.getAttribute('position') as THREE.BufferAttribute,
            });
        }
    }

    private makeQuad(): THREE.Mesh {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
        geom.setIndex([0, 1, 2, 2, 1, 3]);
        const mesh = new THREE.Mesh(geom, this.ribbonMat);
        mesh.frustumCulled = false;
        mesh.onBeforeRender = updateUniforms;
        return mesh;
    }

    /** Flat ribbon from a to b, laid across its own direction. */
    private placeRibbon(pos: THREE.BufferAttribute, a: THREE.Vector3, b: THREE.Vector3): void {
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        const hx = (-dz / len) * WIRE_HALF_W_M;
        const hz = (dx / len) * WIRE_HALF_W_M;
        pos.setXYZ(0, a.x - hx, a.y, a.z - hz);
        pos.setXYZ(1, a.x + hx, a.y, a.z + hz);
        pos.setXYZ(2, b.x - hx, b.y, b.z - hz);
        pos.setXYZ(3, b.x + hx, b.y, b.z + hz);
        pos.needsUpdate = true;
    }

    /** The latched wire's id and the hook tip it runs to, or -1. */
    private latchedTip(out: THREE.Vector3): number {
        const player = this.getPlayer();
        const fm = player.getFlightModel();
        if (!(fm instanceof SimProxyFlightModel)) {
            return -1;
        }
        const id = fm.getArrestorLatch();
        const view = this.views.find(v => v.wire.id === id);
        if (view === undefined) {
            return -1;
        }
        // Same tip as the drawn tailhook: on the hinge -> sheave ray.
        player.updateDisplayTransform();
        player.getArrestorHookHingeBody(this.hinge);
        this.hinge.applyQuaternion(player.getDisplayQuaternion()).add(player.getDisplayPosition());
        latchedHookTipWorld(this.hinge, view.wire.a, out, undefined, this.fallbackDir);
        return id;
    }

    private rebuild(camera: THREE.Camera): void {
        this.syncViews();
        const latched = this.latchedTip(this.latchedMid);
        for (const v of this.views) {
            const { a, b } = v.wire;
            const mid = v.wire.id === latched
                ? this.latchedMid
                : this.mid.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
            const dist = camera.position.distanceTo(mid);
            const near = dist < ARRESTOR_LOD_LINE_M;
            const inRange = dist < WIRE_DRAW_RANGE_M;
            v.legA.visible = inRange && near;
            v.legB.visible = inRange && near;
            v.line.visible = inRange && !near;
            if (!inRange) {
                continue;
            }
            this.placeRibbon(v.legAPos, a, mid);
            this.placeRibbon(v.legBPos, mid, b);
            v.linePos.setXYZ(0, a.x, a.y, a.z);
            v.linePos.setXYZ(1, mid.x, mid.y, mid.z);
            v.linePos.setXYZ(2, b.x, b.y, b.z);
            v.linePos.needsUpdate = true;
        }
    }

    init(_scene: Scene): void {
        //
    }

    update(_delta: number): void {
        //
    }

    render3D(
        _targetWidth: number,
        _targetHeight: number,
        camera: THREE.Camera,
        lists: Map<string, THREE.Scene>,
        _palette: Palette,
    ): void {
        // After the combat-sim pump, so the V tracks the live hook.
        this.rebuild(camera);
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

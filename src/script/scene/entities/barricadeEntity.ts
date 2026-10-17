/**
 * The carrier's emergency barricade: rig state and drawing.
 *
 * Owns what the deck crew does — swing the stanchions up, lace fresh webbing,
 * strike it after a catch — and draws the shape barricadeWrap.ts builds for
 * that state, in carrier-local space under a root that follows the ship. The
 * sim only hears "armed" and a generation number (see game.ts).
 *
 * Straps are flat ribbons (double-sided: they bend every which way on the
 * airframe), the purchase cables black ribbons, the stanchions boxes hinged
 * at their feet. Far off, everything drops to 1 px lines like the wires do.
 */
import * as THREE from 'three';
import { Palette, PaletteCategory } from '../../config/palettes/palette';
import { CanvasPainter } from '../../render/screen/canvasPainter';
import { attachToRenderList } from '../../render/renderList';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials/materials';
import { updateUniforms } from '../utils';
import { Entity } from '../entity';
import { Scene, SceneLayers } from '../scene';
import { ArrestorCarrierPose } from './arrestorCables';
import {
    BARRICADE_DECK_Y,
    BARRICADE_HEIGHT_M,
    BARRICADE_LOCAL_Z,
    BARRICADE_MID_X,
    BARRICADE_RAISE_S,
} from './barricadeSpec';
import { BarricadeAirframeProfile, BarricadeNetShape, buildBarricadeShape } from './barricadeWrap';
import { BarricadeNetMotion } from './barricadeNetMotion';
import { flutterStraps } from './barricadeWind';

/** Load-strap and engaging-strap widths (m). */
const LOAD_STRAP_W_M = 0.15;
const ENGAGING_STRAP_W_M = 0.2;
/** The straps gloving the wing, close together, so a little narrower. */
const GLOVE_STRAP_W_M = 0.15;
const CABLE_W_M = 0.05;
/** Stanchion cross-section (m). */
const STANCHION_SIDE_M = 0.45;
/** Nylon webbing, black wire rope, deck-grey stanchions. */
const WEBBING_COLOR = '#d6d0bf';
const CABLE_COLOR = '#000000';
const STANCHION_COLOR = '#7c8186';
/** Camera distance at which ribbons give way to lines, with hysteresis (m). */
const LOD_LINE_M = 350;
const LOD_HYSTERESIS_M = 25;
/** Vertex budget for every ribbon of one frame. */
const MAX_RIBBON_VERTS = 4096;
const MAX_LINE_VERTS = 2048;

/** Rig phase as the HUD and the sim see it. */
export const enum BarricadeRigPhase {
    STOWED,
    RAISING,
    RIGGED,
    LOWERING,
}

/** The aircraft in the net, as drawn: world pose, velocity relative to the ship, and its profile. */
export interface BarricadeCatch {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    velocity: THREE.Vector3;
    profile: BarricadeAirframeProfile;
}

export class BarricadeEntity implements Entity {

    readonly tags: string[] = [];
    enabled = true;

    /** 0 = flush with the deck, 1 = upright. */
    private raise = 0;
    private target = 0;
    /** Webbing laced between the stanchions (gone once it has caught something). */
    private webbing = false;
    private expended = false;
    private generationCounter = 0;

    private readonly root = new THREE.Object3D();
    private readonly straps: RibbonBuffer;
    private readonly cables: RibbonBuffer;
    private readonly lines: THREE.LineSegments;
    private readonly linePos: THREE.BufferAttribute;
    private readonly stanchions: THREE.Mesh[] = [];
    private useLines = false;

    /** Springs that carry the webbing from curtain to wrap (drawing only). */
    private readonly motion = new BarricadeNetMotion();
    /** Time not yet given to {@link motion}: update() adds, the first rebuild after it spends. */
    private pendingDelta = 0;
    /** Clock for the wind in the webbing (s). */
    private windTime = 0;
    private readonly localVel = new THREE.Vector3();

    private readonly invQuat = new THREE.Quaternion();
    private readonly localPos = new THREE.Vector3();
    private readonly localQuat = new THREE.Quaternion();
    private readonly lodAnchor = new THREE.Vector3();

    constructor(
        materials: SceneMaterialManager,
        private readonly getCarrierPose: () => ArrestorCarrierPose,
        private readonly getCatch: () => BarricadeCatch | undefined,
    ) {
        const flat = (color: string) => materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.VEHICLE_PLANE_GREY,
            shaded: false,
            depthWrite: true,
            colorDither: false,
            rawColor: color,
        });
        this.straps = new RibbonBuffer(flat(WEBBING_COLOR), MAX_RIBBON_VERTS);
        this.cables = new RibbonBuffer(flat(CABLE_COLOR), 64);
        this.root.add(this.straps.mesh, this.cables.mesh);

        const lineGeom = new THREE.BufferGeometry();
        this.linePos = new THREE.BufferAttribute(new Float32Array(MAX_LINE_VERTS * 3), 3);
        this.linePos.setUsage(THREE.DynamicDrawUsage);
        lineGeom.setAttribute('position', this.linePos);
        this.lines = new THREE.LineSegments(lineGeom, materials.build({
            type: SceneMaterialPrimitiveType.LINE,
            category: PaletteCategory.VEHICLE_PLANE_GREY,
            depthWrite: false,
            rawColor: WEBBING_COLOR,
        }));
        this.lines.frustumCulled = false;
        this.lines.onBeforeRender = updateUniforms;
        this.root.add(this.lines);

        // Hinged at the foot: the box hangs off its pivot along +Y.
        const box = new THREE.BoxGeometry(STANCHION_SIDE_M, BARRICADE_HEIGHT_M, STANCHION_SIDE_M)
            .translate(0, BARRICADE_HEIGHT_M * 0.5, 0);
        const stanchionMat = flat(STANCHION_COLOR);
        for (let i = 0; i < 2; i++) {
            const m = new THREE.Mesh(box, stanchionMat);
            m.frustumCulled = false;
            m.onBeforeRender = updateUniforms;
            this.stanchions.push(m);
            this.root.add(m);
        }
        this.lodAnchor.set(BARRICADE_MID_X, BARRICADE_DECK_Y, BARRICADE_LOCAL_Z);
        this.syncRoot();
        this.rebuild();
    }

    /** Raise the stanchions with fresh webbing, or strike the rig if it is up. */
    toggle(): void {
        if (this.target > 0) {
            this.target = 0;
            return;
        }
        this.lace();
        this.target = 1;
    }

    /** Rigged and ready at once (the short-final spawn starts that way). */
    /**
     * A new spawn: fresh webbing laced (a new generation, so the sim lets go
     * of anything the old one held), standing at once if `raised`, flush
     * otherwise and ready for K.
     */
    reset(raised: boolean): void {
        this.generationCounter++;
        this.webbing = true;
        this.expended = false;
        this.raise = raised ? 1 : 0;
        this.target = this.raise;
        this.motion.reset();
    }

    /** The sim reported a catch: this webbing is spent. */
    markExpended(): void {
        this.expended = true;
    }

    /** Fully up, laced and unused. */
    get armed(): boolean {
        return this.raise >= 1 && this.webbing && !this.expended;
    }

    /** Which webbing is up; the sim lets a held aircraft go when it changes. */
    get generation(): number {
        return this.generationCounter;
    }

    get phase(): BarricadeRigPhase {
        if (this.target > 0) return this.raise >= 1 ? BarricadeRigPhase.RIGGED : BarricadeRigPhase.RAISING;
        return this.raise <= 0 ? BarricadeRigPhase.STOWED : BarricadeRigPhase.LOWERING;
    }

    /** HUD device-stack label, undefined while stowed. */
    status(engaged: boolean): string | undefined {
        if (engaged) return 'BARR ENG';
        switch (this.phase) {
            case BarricadeRigPhase.RAISING: return 'BARR RIG';
            case BarricadeRigPhase.RIGGED: return this.expended ? 'BARR SPENT' : 'BARR UP';
            case BarricadeRigPhase.LOWERING: return 'BARR DN';
            default: return undefined;
        }
    }

    private lace(): void {
        if (!this.webbing || this.expended) {
            this.generationCounter++;
        }
        this.webbing = true;
        this.expended = false;
    }

    init(_scene: Scene): void {
        //
    }

    update(delta: number): void {
        this.pendingDelta += delta;
        this.windTime += delta;
        const step = delta / BARRICADE_RAISE_S;
        this.raise = this.target > this.raise
            ? Math.min(this.target, this.raise + step)
            : Math.max(this.target, this.raise - step);
        // Struck after a catch: the crew cuts the spent webbing away.
        if (this.expended && this.raise <= 0) {
            this.webbing = false;
        }
    }

    render3D(
        _targetWidth: number,
        _targetHeight: number,
        camera: THREE.Camera,
        lists: Map<string, THREE.Scene>,
        _palette: Palette,
    ): void {
        // After the sim pump, so the wrap follows the drawn aircraft.
        this.syncRoot();
        this.updateLod(camera);
        this.rebuild();
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

    private syncRoot(): void {
        const pose = this.getCarrierPose();
        this.root.position.copy(pose.position as THREE.Vector3);
        this.root.quaternion.copy(pose.quaternion ?? this.localQuat.identity());
        this.root.updateMatrixWorld(true);
    }

    private updateLod(camera: THREE.Camera): void {
        const anchor = this.localPos.copy(this.lodAnchor).applyQuaternion(this.root.quaternion).add(this.root.position);
        const dist = camera.position.distanceTo(anchor);
        if (this.useLines ? dist < LOD_LINE_M - LOD_HYSTERESIS_M : dist > LOD_LINE_M + LOD_HYSTERESIS_M) {
            this.useLines = !this.useLines;
        }
    }

    private rebuild(): void {
        const caught = this.getCatch();
        let shape: BarricadeNetShape;
        // Render passes can call this more than once a frame; only the first moves the net.
        // A stalled frame (hidden tab, load) is not a reason to fling the net.
        const dt = Math.min(this.pendingDelta, 0.1);
        this.pendingDelta = 0;
        if (caught) {
            this.invQuat.copy(this.root.quaternion).invert();
            this.localPos.copy(caught.position).sub(this.root.position).applyQuaternion(this.invQuat);
            this.localQuat.copy(this.invQuat).multiply(caught.quaternion);
            const target = buildBarricadeShape(this.raise, true, {
                pose: { position: this.localPos, quaternion: this.localQuat },
                profile: caught.profile,
            });
            const halfSpan = profileHalfSpan(caught.profile);
            if (!this.motion.active) {
                // From the curtain as it hung the instant before.
                this.localVel.copy(caught.velocity).applyQuaternion(this.invQuat);
                this.motion.begin(buildBarricadeShape(this.raise, true), target, this.localPos, this.localVel, halfSpan);
            }
            shape = this.motion.step(dt, target, this.localPos, halfSpan);
        } else {
            this.motion.reset();
            shape = buildBarricadeShape(this.raise, this.webbing && !this.expended);
        }

        for (let i = 0; i < 2; i++) {
            const { base, top } = shape.stanchions[i];
            const m = this.stanchions[i];
            m.position.copy(base);
            // Pitch about the lateral axis: lying flat points the head aft (+Z).
            m.rotation.set(Math.atan2(top.z - base.z, top.y - base.y), 0, 0);
            // Flush in its deck recess when stowed.
            m.visible = top.y - base.y > 0.01;
        }

        // Light nylon: the wind over the deck keeps the loose straps moving.
        const verticals = flutterStraps(shape.verticals, shape.slung, this.windTime);
        const near = !this.useLines;
        this.straps.mesh.visible = near;
        this.cables.mesh.visible = near;
        this.lines.visible = !near;
        if (near) {
            this.straps.begin();
            // Caught, the upper strap is gone: the lower one holds the webbing.
            if (!caught) this.straps.add(shape.upper, LOAD_STRAP_W_M);
            this.straps.add(shape.lower, LOAD_STRAP_W_M);
            for (const v of verticals) this.straps.add(v, ENGAGING_STRAP_W_M);
            for (const g of shape.glove) this.straps.add(g, GLOVE_STRAP_W_M);
            this.straps.end();
            this.cables.begin();
            for (const c of shape.cables) this.cables.add(c, CABLE_W_M);
            this.cables.end();
        } else {
            let n = 0;
            const push = (pts: readonly THREE.Vector3[]) => {
                for (let i = 0; i + 1 < pts.length && n + 2 <= MAX_LINE_VERTS; i++) {
                    this.linePos.setXYZ(n++, pts[i].x, pts[i].y, pts[i].z);
                    this.linePos.setXYZ(n++, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
                }
            };
            if (!caught) push(shape.upper);
            push(shape.lower);
            for (const v of verticals) push(v);
            for (const g of shape.glove) push(g);
            this.lines.geometry.setDrawRange(0, n);
            this.linePos.needsUpdate = true;
        }
    }
}

/** Wingtip distance from the centreline, from the profile's leading edges. */
function profileHalfSpan(profile: BarricadeAirframeProfile): number {
    let half = 0;
    for (const side of profile.leadingEdge) {
        for (const p of side) half = Math.max(half, Math.abs(p.x));
    }
    return half;
}

const _t = new THREE.Vector3();
const _side = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _y = new THREE.Vector3(0, 1, 0);

/**
 * Flat ribbons along polylines, rebuilt every frame into one buffer. The
 * width runs across the deck axis — a strap spanning the deck stands on edge
 * like a belt, one hanging down lies flat across — and each quad is emitted in
 * both windings, since the webbing is seen from either side.
 */
class RibbonBuffer {
    readonly mesh: THREE.Mesh;
    private readonly pos: THREE.BufferAttribute;
    private readonly index: THREE.BufferAttribute;
    private verts = 0;
    private indices = 0;

    constructor(material: THREE.Material, private readonly maxVerts: number) {
        const geom = new THREE.BufferGeometry();
        this.pos = new THREE.BufferAttribute(new Float32Array(maxVerts * 3), 3);
        this.pos.setUsage(THREE.DynamicDrawUsage);
        // Two quads (both windings) per segment, two verts per point.
        this.index = new THREE.BufferAttribute(new Uint16Array(maxVerts * 6), 1);
        this.index.setUsage(THREE.DynamicDrawUsage);
        geom.setAttribute('position', this.pos);
        geom.setIndex(this.index);
        this.mesh = new THREE.Mesh(geom, material);
        this.mesh.frustumCulled = false;
        this.mesh.onBeforeRender = updateUniforms;
    }

    begin(): void {
        this.verts = 0;
        this.indices = 0;
    }

    add(pts: readonly THREE.Vector3[], width: number): void {
        if (pts.length < 2 || this.verts + pts.length * 2 > this.maxVerts) return;
        const first = this.verts;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[Math.max(0, i - 1)];
            const b = pts[Math.min(pts.length - 1, i + 1)];
            _t.subVectors(b, a);
            _side.crossVectors(_t, _z);
            if (_side.lengthSq() < 1e-6 * Math.max(1e-6, _t.lengthSq())) _side.crossVectors(_t, _y);
            _side.normalize().multiplyScalar(width * 0.5);
            const p = pts[i];
            this.pos.setXYZ(this.verts++, p.x - _side.x, p.y - _side.y, p.z - _side.z);
            this.pos.setXYZ(this.verts++, p.x + _side.x, p.y + _side.y, p.z + _side.z);
        }
        for (let i = 0; i + 1 < pts.length; i++) {
            const v = first + i * 2;
            for (const k of [v, v + 1, v + 2, v + 2, v + 1, v + 3, v, v + 2, v + 1, v + 2, v + 3, v + 1]) {
                this.index.setX(this.indices++, k);
            }
        }
    }

    end(): void {
        this.mesh.geometry.setDrawRange(0, this.indices);
        this.pos.needsUpdate = true;
        this.index.needsUpdate = true;
        this.mesh.visible = this.mesh.visible && this.indices > 0;
    }
}

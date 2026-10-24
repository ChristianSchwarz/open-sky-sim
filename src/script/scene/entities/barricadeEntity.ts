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
import { buildRiggedWeb, WebLayout } from '../../physics/barricade/webLayout';

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
/** Rolled back this far (m) from the furthest it ran, the jet has let the webbing go slack. */
const ROLLBACK_SLACK_M = 2;
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

/** The sim's rigid-body webbing for one rig generation: particle positions, carrier-local (xyz interleaved). */
export interface BarricadeWebState {
    generation: number;
    positions: Float32Array;
    /** The aircraft in reach as the web met it (carrier-local position xyz, quaternion xyzw), and its bounds (body frame). */
    body?: ArrayLike<number>;
    bodyBox?: ArrayLike<number>;
    /** That aircraft where it is drawn this frame (world). */
    drawn?: { position: THREE.Vector3; quaternion: THREE.Quaternion };
    /** A catch on the scripted run-out, the webbing not meeting the aircraft. */
    scriptedCatch?: boolean;
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
    private readonly localVel = new THREE.Vector3();

    private readonly invQuat = new THREE.Quaternion();
    private readonly localPos = new THREE.Vector3();
    /** The furthest the caught jet has run into the net (carrier-local z, m). */
    private furthestZ = 0;
    private readonly localQuat = new THREE.Quaternion();
    private readonly lodAnchor = new THREE.Vector3();

    /** The webbing's topology, the same layout the sim's solver steps (see drawWeb). */
    private webLayout: WebLayout | undefined;
    private webLines: THREE.Vector3[][] = [];
    private webCables: THREE.Vector3[][] = [];

    constructor(
        materials: SceneMaterialManager,
        private readonly getCarrierPose: () => ArrestorCarrierPose,
        private readonly getCatch: () => BarricadeCatch | undefined,
        private readonly getWeb: () => BarricadeWebState | undefined = () => undefined,
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

    /** Laced and standing, used or not: the sim keeps its webbing while this holds. */
    get webbingUp(): boolean {
        return this.raise >= 1 && this.webbing;
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
        // Rigged, the sim's webbing is the net, from the moment it stands to the moment it is
        // struck: one representation, so nothing changes shape at the catch. Except a jet the
        // sim caught on its scripted run-out, without the webbing meeting it (its drawn airframe
        // not baked in time, see Game.syncBarricadeAirframe): that one is wrapped from its pose.
        const web = this.getWeb();
        const caught = this.getCatch();
        if (web && this.webbingUp && web.generation === this.generationCounter && !(caught && web.scriptedCatch)) {
            this.pendingDelta = 0;
            this.motion.reset();
            this.lastWebDrawn = this.webToDrawn(web);
            this.drawWeb(this.lastWebDrawn, buildBarricadeShape(this.raise, false));
            return;
        }
        let shape: BarricadeNetShape;
        // Render passes can call this more than once a frame; only the first moves the net.
        // A stalled frame (hidden tab, load) is not a reason to fling the net.
        const dt = Math.min(this.pendingDelta, 0.1);
        this.pendingDelta = 0;
        if (caught) {
            this.invQuat.copy(this.root.quaternion).invert();
            this.localPos.copy(caught.position).sub(this.root.position).applyQuaternion(this.invQuat);
            this.localQuat.copy(this.invQuat).multiply(caught.quaternion);
            // The pull holds the webbing taut until the jet rolls back from
            // the furthest it got (landing runs toward −z).
            if (!this.motion.active) this.furthestZ = this.localPos.z;
            this.furthestZ = Math.min(this.furthestZ, this.localPos.z);
            const slack = (this.localPos.z - this.furthestZ) / ROLLBACK_SLACK_M;
            const target = buildBarricadeShape(this.raise, true, {
                pose: { position: this.localPos, quaternion: this.localQuat, slack },
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

        const verticals = shape.verticals;
        const near = !this.useLines;
        this.straps.mesh.visible = near;
        this.cables.mesh.visible = near;
        this.lines.visible = !near;
        if (near) {
            this.straps.begin();
            // Caught, the upper strap is gone: the lower one holds the webbing.
            if (!caught) this.straps.add(shape.upper, LOAD_STRAP_W_M);
            // Caught, the webbing lies on the airframe: drawn flat along it.
            const flat = !!caught;
            this.straps.add(shape.lower, LOAD_STRAP_W_M, flat);
            for (const v of verticals) this.straps.add(v, ENGAGING_STRAP_W_M, flat);
            for (const g of shape.glove) this.straps.add(g, GLOVE_STRAP_W_M, flat);
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

    /**
     * The sim's webbing as ribbons: both load straps, every engaging strap
     * and the purchase cables from their anchors to the load straps' ends,
     * through the particles the sim stepped. The stanchions stand as the rig
     * drew them.
     */
    /**
     * The webbing moved onto the aircraft as drawn. The sim met the aircraft
     * at its physics pose, while the aircraft is drawn interpolated between
     * physics steps, or, stopped on the deck, frozen to the ship (Player's
     * carrier ride): 0.3-0.5 m apart in a 45 m/s catch. Drawn as stepped, the
     * webbing then ran through the drawn skin, 4-25 links a frame, though the
     * sim had none through its collider. So the particles near the aircraft
     * go with it, from the pose the sim met to the pose drawn, fading to the
     * ship's frame WEB_DRAWN_FADE_M from its bounds, where the anchors are.
     */
    private webToDrawn(web: BarricadeWebState): Float32Array {
        const { positions, body, bodyBox: box, drawn } = web;
        if (!body || !box || !drawn) return positions;
        const out = this.webDrawn.length === positions.length ? this.webDrawn : (this.webDrawn = new Float32Array(positions.length));
        // The drawn pose in the ship's frame.
        this.invQuat.copy(this.root.quaternion).invert();
        const pd = _dp.copy(drawn.position).sub(this.root.position).applyQuaternion(this.invQuat);
        const qd = _dq.copy(this.invQuat).multiply(drawn.quaternion);
        const ps = _sp.set(body[0], body[1], body[2]);
        const qsInv = _sq.set(body[3], body[4], body[5], body[6]).invert();
        // A respawn or reset between the two is not a lag to follow.
        if (pd.distanceTo(ps) > WEB_DRAWN_MAX_LAG_M) return positions;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1], z = positions[i + 2];
            const b = _b.set(x - ps.x, y - ps.y, z - ps.z).applyQuaternion(qsInv);
            const dx = Math.max(box[0] - b.x, 0, b.x - box[3]);
            const dy = Math.max(box[1] - b.y, 0, b.y - box[4]);
            const dz = Math.max(box[2] - b.z, 0, b.z - box[5]);
            const d = Math.hypot(dx, dy, dz);
            const t = Math.min(1, Math.max(0, (d - WEB_DRAWN_FULL_M) / (WEB_DRAWN_FADE_M - WEB_DRAWN_FULL_M)));
            const w = 1 - t * t * (3 - 2 * t);
            b.applyQuaternion(qd).add(pd);
            out[i] = x + w * (b.x - x);
            out[i + 1] = y + w * (b.y - y);
            out[i + 2] = z + w * (b.z - z);
        }
        return out;
    }
    private webDrawn = new Float32Array(0);
    /** The webbing's particles as last drawn (carrier-local), for the dev hook. */
    lastWebDrawn: Float32Array | undefined;

    private drawWeb(positions: Float32Array, rig: BarricadeNetShape): void {
        const layout = this.webLayout ??= buildRiggedWeb();
        if (positions.length !== 3 * layout.count) return;
        if (this.webLines.length === 0) {
            const chains = [layout.upperBelt, layout.lowerBelt, ...layout.straps];
            this.webLines = chains.map(c => c.map(() => new THREE.Vector3()));
            this.webCables = layout.tethers.map(() => [new THREE.Vector3(), new THREE.Vector3()]);
        }
        const chains = [layout.upperBelt, layout.lowerBelt, ...layout.straps];
        chains.forEach((c, k) => {
            const line = this.webLines[k];
            for (let n = 0; n < c.length; n++) {
                const i = 3 * c[n];
                line[n].set(positions[i], positions[i + 1], positions[i + 2]);
            }
        });
        layout.tethers.forEach((t, k) => {
            const i = 3 * t.i;
            this.webCables[k][0].set(t.anchor[0], t.anchor[1], t.anchor[2]);
            this.webCables[k][1].set(positions[i], positions[i + 1], positions[i + 2]);
        });
        for (let i = 0; i < 2; i++) {
            const { base, top } = rig.stanchions[i];
            const m = this.stanchions[i];
            m.position.copy(base);
            m.rotation.set(Math.atan2(top.z - base.z, top.y - base.y), 0, 0);
            m.visible = top.y - base.y > 0.01;
        }
        const near = !this.useLines;
        this.straps.mesh.visible = near;
        this.cables.mesh.visible = near;
        this.lines.visible = !near;
        if (near) {
            this.straps.begin();
            this.straps.add(this.webLines[0], LOAD_STRAP_W_M);
            this.straps.add(this.webLines[1], LOAD_STRAP_W_M);
            for (let k = 2; k < this.webLines.length; k++) this.straps.add(this.webLines[k], ENGAGING_STRAP_W_M);
            this.straps.end();
            this.cables.begin();
            for (const c of this.webCables) this.cables.add(c, CABLE_W_M);
            this.cables.end();
        } else {
            let n = 0;
            for (const pts of this.webLines) {
                for (let i = 0; i + 1 < pts.length && n + 2 <= MAX_LINE_VERTS; i++) {
                    this.linePos.setXYZ(n++, pts[i].x, pts[i].y, pts[i].z);
                    this.linePos.setXYZ(n++, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
                }
            }
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

/**
 * Webbing within WEB_DRAWN_FULL_M of the aircraft's bounds moves wholly with
 * it as drawn (see webToDrawn), none past WEB_DRAWN_FADE_M (m); past
 * WEB_DRAWN_MAX_LAG_M between the two poses it is not a lag but a jump.
 */
const WEB_DRAWN_FULL_M = 0.75;
const WEB_DRAWN_FADE_M = 4;
const WEB_DRAWN_MAX_LAG_M = 3;
const _dp = new THREE.Vector3();
const _sp = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _sq = new THREE.Quaternion();
const _t = new THREE.Vector3();
const _side = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
/** A strap point this close to the deck (m) is drawn lying flat on it. */
const RIBBON_FLAT_ON_DECK_M = 0.1;
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

    /**
     * `flat` lays the width along the deck plane (webbing on a wing or the
     * deck) instead of across the deck axis (a belt standing on edge between
     * the stanchions): on edge, a strap running spanwise over a wing stood
     * half its width down through the skin it lies on.
     */
    add(pts: readonly THREE.Vector3[], width: number, flat = false): void {
        if (pts.length < 2 || this.verts + pts.length * 2 > this.maxVerts) return;
        const first = this.verts;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[Math.max(0, i - 1)];
            const b = pts[Math.min(pts.length - 1, i + 1)];
            _t.subVectors(b, a);
            const p = pts[i];
            // Webbing lying on the deck lies flat on it; anything else across
            // the deck axis (a strap fore and aft on the deck would otherwise
            // stand up on edge as a blade).
            const lying = flat || p.y < BARRICADE_DECK_Y + RIBBON_FLAT_ON_DECK_M;
            _side.crossVectors(_t, lying ? _y : _z);
            if (_side.lengthSq() < 1e-6 * Math.max(1e-6, _t.lengthSq())) _side.crossVectors(_t, lying ? _z : _y);
            _side.normalize().multiplyScalar(width * 0.5);
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

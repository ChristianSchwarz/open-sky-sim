/**
 * The carrier's emergency barricade: rig state and drawing.
 *
 * Owns what the deck crew does — swing the stanchions up, lace fresh webbing,
 * strike it after a catch — and draws the webbing as the sim's rigid-body
 * solver steps it (physics/barricade), in carrier-local space under a root
 * that follows the ship. Going up and coming down, before the sim steps it,
 * the solver's rigged net swings with the stanchions.
 *
 * Straps are flat ribbons (double-sided: they bend every which way on the
 * airframe), each engaging strap two plies, a loop slung over the upper
 * belt; the purchase cables black ribbons, the stanchions boxes hinged at
 * their feet. Far off, everything drops to 1 px lines like the wires do.
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
    BARRICADE_HALF_SPAN_M,
    BARRICADE_HEIGHT_M,
    BARRICADE_LOCAL_Z,
    BARRICADE_MID_X,
    BARRICADE_RAISE_S,
} from './barricadeSpec';
import { buildRiggedWeb, WebLayout } from '../../physics/barricade/webLayout';

/** Load-strap and engaging-strap widths (m). */
const LOAD_STRAP_W_M = 0.15;
const ENGAGING_STRAP_W_M = 0.2;
const CABLE_W_M = 0.05;
/** An engaging strap's two plies stand this far apart at its eye (m), either side of the upper belt; sewn together at the lower. */
const PLY_GAP_M = 0.025;
/** Swung flat, the webbing lies this far above the deck (m). */
const DECK_CLEARANCE_M = 0.02;
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

/** The sim's rigid-body webbing for one rig generation: particle positions, carrier-local (xyz interleaved). */
export interface BarricadeWebState {
    generation: number;
    positions: Float32Array;
    /** The aircraft in reach as the web met it (carrier-local position xyz, quaternion xyzw), and its bounds (body frame). */
    body?: ArrayLike<number>;
    bodyBox?: ArrayLike<number>;
    /** That aircraft where it is drawn this frame (world). */
    drawn?: { position: THREE.Vector3; quaternion: THREE.Quaternion };
    /** Settled and warmed up (BarricadeWeb.ready), and how far each tether has paid out (m). */
    warm?: boolean;
    payout?: readonly number[];
    /** Whether each tensioning pendant still holds: upper (port, starboard), then lower (port, starboard). */
    pendantsHeld?: readonly boolean[];
}

/** The solver's net hung and still before anything touched it: what the stanchions swing up and down (see curtain). */
let restWeb: Float32Array | undefined;

/** Stanchion foot and head, port then starboard: hinged at the deck, swinging up from lying flat with the head aft. */
interface StanchionPose { base: THREE.Vector3; top: THREE.Vector3 }

/** The deck under the barricade (WebDeck in the game): its height at (x, z), and at the barricade line. */
export interface BarricadeDeck {
    heightAt(x: number, z: number): number;
    readonly reference: number;
}
const FLAT_DECK: BarricadeDeck = { heightAt: () => BARRICADE_DECK_Y, reference: BARRICADE_DECK_Y };

function stanchionPoses(raise: number, deck: BarricadeDeck): [StanchionPose, StanchionPose] {
    const theta = THREE.MathUtils.clamp(raise, 0, 1) * Math.PI * 0.5;
    const make = (x: number) => {
        const base = new THREE.Vector3(x, deck.heightAt(x, BARRICADE_LOCAL_Z), BARRICADE_LOCAL_Z);
        const top = base.clone().add(new THREE.Vector3(0, BARRICADE_HEIGHT_M * Math.sin(theta), BARRICADE_HEIGHT_M * Math.cos(theta)));
        return { base, top };
    };
    return [make(BARRICADE_MID_X - BARRICADE_HALF_SPAN_M), make(BARRICADE_MID_X + BARRICADE_HALF_SPAN_M)];
}

/**
 * A rigged point (carrier-local) swung with the stanchions to `raise`:
 * about their hinge line at the deck, the way their heads go, kept clear of
 * the deck.
 */
function swing(out: THREE.Vector3, x: number, y: number, z: number, raise: number, deck: BarricadeDeck): THREE.Vector3 {
    const theta = THREE.MathUtils.clamp(raise, 0, 1) * Math.PI * 0.5;
    const hinge = deck.reference;
    const a = y - hinge, b = z - BARRICADE_LOCAL_Z;
    const s = Math.sin(theta), c = Math.cos(theta);
    const nz = BARRICADE_LOCAL_Z + a * c + b * s;
    return out.set(x, Math.max(deck.heightAt(x, nz) + DECK_CLEARANCE_M, hinge + a * s - b * c), nz);
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

    private readonly invQuat = new THREE.Quaternion();
    private readonly localPos = new THREE.Vector3();
    private readonly localQuat = new THREE.Quaternion();
    private readonly lodAnchor = new THREE.Vector3();

    /** The webbing's topology, the same layout the sim's solver steps (see drawWeb). */
    private webLayout: WebLayout | undefined;
    private webLines: THREE.Vector3[][] = [];
    /** Per engaging strap, its two plies (see PLY_GAP_M). */
    private webPlies: THREE.Vector3[][] = [];
    private webCables: THREE.Vector3[][] = [];
    private webPendants: THREE.Vector3[][] = [];
    private curtainPos = new Float32Array(0);

    constructor(
        materials: SceneMaterialManager,
        private readonly getCarrierPose: () => ArrestorCarrierPose,
        private readonly getWeb: () => BarricadeWebState | undefined = () => undefined,
        private readonly getDeck: () => BarricadeDeck | undefined = () => undefined,
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
        // After the sim pump, so the webbing follows the drawn aircraft.
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
        const deck = this.deck = this.getDeck() ?? FLAT_DECK;
        const stanchions = stanchionPoses(this.raise, deck);
        // Rigged, the sim's webbing is the net, from the moment it stands to the moment it is
        // struck: one representation, so nothing changes shape at the catch.
        const web = this.getWeb();
        if (web && this.webbingUp && web.generation === this.generationCounter) {
            // Hung and still, untouched: the net the stanchions carry up and down from now on.
            if (!restWeb && web.warm && !web.body && !this.expended && web.payout?.every(p => Math.abs(p) < 0.01)) {
                restWeb = web.positions.slice();
            }
            this.lastWebDrawn = this.webToDrawn(web);
            this.drawWeb(this.lastWebDrawn, stanchions, 1, web.pendantsHeld);
            return;
        }
        // Flush, unlaced, or cut away after a catch: the stanchions alone.
        if (this.raise <= 0 || !this.webbing || this.expended) {
            this.drawWeb(undefined, stanchions, this.raise);
            return;
        }
        this.drawWeb(this.curtain(this.raise), stanchions, this.raise);
    }

    /** The solver's rigged net swung with the stanchions to `raise` (see swing). */
    private curtain(raise: number): Float32Array {
        const layout = this.webLayout ??= buildRiggedWeb();
        const src = restWeb ?? layout.x;
        // The layout's own rig stands on the flat deck; the sim's on the real one.
        const lift = restWeb ? 0 : this.deck.reference - layout.deckY;
        if (this.curtainPos.length !== src.length) this.curtainPos = new Float32Array(src.length);
        const out = this.curtainPos;
        for (let i = 0; i < src.length; i += 3) {
            swing(_t, src[i], src[i + 1] + lift, src[i + 2], raise, this.deck);
            out[i] = _t.x;
            out[i + 1] = _t.y;
            out[i + 2] = _t.z;
        }
        return out;
    }

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
            out[i + 2] = z + w * (b.z - z);
            // Carried with the drawn aircraft, still not into the deck.
            out[i + 1] = Math.max(this.deck.heightAt(out[i], out[i + 2]) + DECK_CLEARANCE_M, y + w * (b.y - y));
        }
        return out;
    }
    private webDrawn = new Float32Array(0);
    /** The deck this frame (getDeck, or the flat plane), and its height for the ribbons. */
    private deck: BarricadeDeck = FLAT_DECK;
    private readonly floorAt = (x: number, z: number) => this.deck.heightAt(x, z);
    /** The webbing's particles as last drawn (carrier-local), for the dev hook. */
    lastWebDrawn: Float32Array | undefined;

    private drawWeb(positions: Float32Array | undefined, stanchions: [StanchionPose, StanchionPose], raise: number,
        pendantsHeld: readonly boolean[] = [true, true, true, true]): void {
        for (let i = 0; i < 2; i++) {
            const { base, top } = stanchions[i];
            const m = this.stanchions[i];
            m.position.copy(base);
            // Pitch about the lateral axis: lying flat points the head aft (+Z).
            m.rotation.set(Math.atan2(top.z - base.z, top.y - base.y), 0, 0);
            // Flush in its deck recess when stowed.
            m.visible = top.y - base.y > 0.01;
        }
        const layout = this.webLayout ??= buildRiggedWeb();
        if (!positions || positions.length !== 3 * layout.count) {
            this.straps.mesh.visible = this.cables.mesh.visible = this.lines.visible = false;
            return;
        }
        if (this.webLines.length === 0) {
            const chains = [layout.upperBelt, layout.lowerBelt, ...layout.straps];
            this.webLines = chains.map(c => c.map(() => new THREE.Vector3()));
            this.webPlies = layout.straps.flatMap(c => [c.map(() => new THREE.Vector3()), c.map(() => new THREE.Vector3())]);
            this.webCables = layout.tethers.map(() => [new THREE.Vector3(), new THREE.Vector3()]);
            this.webPendants = [...layout.pendants, ...layout.lowerPendants].map(() => [new THREE.Vector3(), new THREE.Vector3()]);
        }
        const chains = [layout.upperBelt, layout.lowerBelt, ...layout.straps];
        chains.forEach((c, k) => {
            const line = this.webLines[k];
            for (let n = 0; n < c.length; n++) {
                const i = 3 * c[n];
                line[n].set(positions[i], positions[i + 1], positions[i + 2]);
            }
        });
        this.buildPlies();
        // The purchase cables, deck sheave to shackle, where both belts meet.
        layout.tethers.forEach((t, k) => {
            const i = 3 * t.i;
            // From the deck sheave (at deck level: drawn on, not in, the deck).
            this.webCables[k][0].set(t.anchor[0], Math.max(t.anchor[1], this.deck.heightAt(t.anchor[0], t.anchor[2]) + DECK_CLEARANCE_M), t.anchor[2]);
            this.webCables[k][1].set(positions[i], positions[i + 1], positions[i + 2]);
        });
        // The tensioning pendants, until they let go: stanchion head to the upper belt's corner,
        // and stanchion base to the lower belt's end (the shackle).
        layout.upperHeads.forEach((corner, k) => {
            const i = 3 * corner;
            this.webPendants[k][0].copy(stanchions[k].top);
            this.webPendants[k][1].set(positions[i], positions[i + 1], positions[i + 2]);
        });
        layout.shackles.forEach((shackle, k) => {
            const i = 3 * shackle;
            const base = stanchions[k].base;
            this.webPendants[2 + k][0].set(base.x, Math.max(base.y, this.deck.heightAt(base.x, base.z) + DECK_CLEARANCE_M), base.z);
            this.webPendants[2 + k][1].set(positions[i], positions[i + 1], positions[i + 2]);
        });
        const near = !this.useLines;
        this.straps.mesh.visible = near;
        this.cables.mesh.visible = near;
        this.lines.visible = !near;
        if (near) {
            const floor = this.floorAt;
            this.straps.begin();
            this.straps.add(this.webLines[0], LOAD_STRAP_W_M, false, floor);
            this.straps.add(this.webLines[1], LOAD_STRAP_W_M, false, floor);
            for (const ply of this.webPlies) this.straps.add(ply, ENGAGING_STRAP_W_M, false, floor);
            this.straps.end();
            this.cables.begin();
            for (const c of this.webCables) this.cables.add(c, CABLE_W_M, false, floor);
            this.webPendants.forEach((p, k) => { if (pendantsHeld[k]) this.cables.add(p, CABLE_W_M, false, floor); });
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

    /**
     * Each engaging strap as the loop it is: two plies from its station on
     * the lower belt, either side of the upper belt at its eye. The solver
     * steps the loop as one chain (its plies hang together); they part by
     * PLY_GAP_M at the eye, across both the strap and the belt there.
     */
    private buildPlies(): void {
        const upper = this.webLines[0];
        for (let s = 0; s + 2 < this.webLines.length; s++) {
            const line = this.webLines[s + 2];
            const eye = line[0];
            let j = 0, best = Infinity;
            for (let k = 0; k < upper.length; k++) {
                const d = upper[k].distanceToSquared(eye);
                if (d < best) { best = d; j = k; }
            }
            const along = _side.subVectors(upper[Math.min(j + 1, upper.length - 1)], upper[Math.max(j - 1, 0)]);
            const down = _t.subVectors(line[1], eye);
            const n = _ply.crossVectors(down, along);
            if (n.lengthSq() < 1e-12) n.set(0, 0, 1);
            n.normalize();
            const a = this.webPlies[2 * s], b = this.webPlies[2 * s + 1];
            const last = line.length - 1;
            for (let m = 0; m <= last; m++) {
                const gap = PLY_GAP_M * (1 - m / last);
                a[m].copy(line[m]).addScaledVector(n, gap);
                b[m].copy(line[m]).addScaledVector(n, -gap);
            }
        }
    }
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
const _ply = new THREE.Vector3();
const _side = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
/** A strap point this close to the deck (m) is drawn lying flat on it. */
const RIBBON_FLAT_ON_DECK_M = 0.1;
/** No ribbon vertex lower than this above the deck (m). */
const RIBBON_DECK_CLEARANCE_M = 0.005;
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
    add(pts: readonly THREE.Vector3[], width: number, flat = false, floorAt: (x: number, z: number) => number = () => BARRICADE_DECK_Y): void {
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
            const floor = floorAt(p.x, p.z);
            const lying = flat || p.y < floor + RIBBON_FLAT_ON_DECK_M;
            _side.crossVectors(_t, lying ? _y : _z);
            if (_side.lengthSq() < 1e-6 * Math.max(1e-6, _t.lengthSq())) _side.crossVectors(_t, lying ? _z : _y);
            _side.normalize().multiplyScalar(width * 0.5);
            // Neither edge of the ribbon into the deck (one standing on edge reached half its width down).
            const lo = floor + RIBBON_DECK_CLEARANCE_M;
            this.pos.setXYZ(this.verts++, p.x - _side.x, Math.max(lo, p.y - _side.y), p.z - _side.z);
            this.pos.setXYZ(this.verts++, p.x + _side.x, Math.max(lo, p.y + _side.y), p.z + _side.z);
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

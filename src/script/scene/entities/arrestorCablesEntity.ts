/**
 * Carrier arrestor cables: straight when idle, V-bent to the hook while trapped.
 * Renders in EntityFX (after carrier volumes) with normal depth testing so the
 * aircraft occludes the wires while deck clearance keeps them visible on the ship.
 *
 * Near the camera: thin black mesh ribbons. Beyond ~350 m: 1px THREE.Line strokes
 * so the wires stay readable when the ribbon would shrink below a pixel.
 *
 * The root tracks the live carrier pose each frame so cables stay on the deck
 * even if the ship translates or yaws.
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
import {
    ARRESTOR_CABLE_Y,
    arrestorCableLocals,
    ArrestorCableLocal,
    ArrestorCarrierPose,
    arrestorCableStartWorld,
    latchedHookTipWorld,
} from './arrestorCables';

/** Fallback deck Y if the ground sampler is unavailable (carrier-local). */
const ARRESTOR_DECK_Y_FALLBACK = 13.55;
/** How far above the deck surface the visible cable sits (m). */
const ARRESTOR_CABLE_CLEARANCE_M = 0.35;
/** Visible cable ribbon half-width (m) — thin wire, still readable as a mesh. */
const ARRESTOR_CABLE_HALF_W_M = 0.04;
/** Camera distance (m) at which ribbons switch to 1px lines. */
const ARRESTOR_LOD_LINE_M = 350;
/** Hysteresis band (m) around the LOD switch to avoid flicker. */
const ARRESTOR_LOD_HYSTERESIS_M = 25;

type CableRibbon = {
    local: ArrestorCableLocal;
    /** Near LOD: cable segment sheave A → mid. */
    cableA: THREE.Mesh;
    cableAPos: THREE.BufferAttribute;
    /** Near LOD: cable segment mid → sheave B. */
    cableB: THREE.Mesh;
    cableBPos: THREE.BufferAttribute;
    /** Far LOD: 1px polyline A → mid → B. */
    line: THREE.Line;
    linePos: THREE.BufferAttribute;
};

export class ArrestorCablesEntity implements Entity {

    readonly tags: string[] = [];
    enabled = true;

    private readonly root = new THREE.Object3D();
    private readonly cables: CableRibbon[] = [];
    private readonly tipWorld = new THREE.Vector3();
    private readonly tipLocal = new THREE.Vector3();
    private readonly hingeWorld = new THREE.Vector3();
    private readonly sheaveWorld = new THREE.Vector3();
    private readonly hingeBody = new THREE.Vector3();
    private readonly fallbackDir = new THREE.Vector3();
    private readonly invQuat = new THREE.Quaternion();
    private readonly sampleWorld = new THREE.Vector3();
    private readonly lodAnchorLocal = new THREE.Vector3();
    private readonly lodAnchorWorld = new THREE.Vector3();
    /** true = far LOD (lines), false = near LOD (mesh ribbons). */
    private useLineLod = false;
    /** Skip static rebuilds: geometry only changes while a hook is latched. */
    private cablesBuilt = false;
    private lastRebuiltLatch = -1;

    constructor(
        materials: SceneMaterialManager,
        private readonly getCarrierPose: () => ArrestorCarrierPose,
        private readonly getPlayer: () => PlayerEntity,
        private readonly groundHeightAt: (x: number, z: number) => number = () => ARRESTOR_DECK_Y_FALLBACK,
    ) {
        const pose = this.getCarrierPose();
        this.root.position.copy(pose.position as THREE.Vector3);
        if (pose.quaternion) {
            this.root.quaternion.copy(pose.quaternion);
        }

        // Solid black wire (rawColor so it stays black on the darkened deck).
        // depthTest stays on so the aircraft occludes the wire; clearance above
        // the deck keeps the stroke visible over the carrier mesh.
        const cableMat = materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.SCENERY_TREE_SHADOW,
            shaded: false,
            depthWrite: false,
            colorDither: false,
            rawColor: '#000000',
        });

        const lineMat = materials.build({
            type: SceneMaterialPrimitiveType.LINE,
            category: PaletteCategory.SCENERY_TREE_SHADOW,
            depthWrite: false,
            rawColor: '#000000',
        });

        // LOD distance is measured to the mean of all cable midpoints.
        let sumX = 0;
        let sumZ = 0;
        const locals = arrestorCableLocals();
        for (const local of locals) {
            sumX += (local.ax + local.bx) * 0.5;
            sumZ += (local.az + local.bz) * 0.5;
        }
        this.lodAnchorLocal.set(sumX / locals.length, ARRESTOR_CABLE_Y, sumZ / locals.length);

        for (const local of locals) {
            const midX = (local.ax + local.bx) * 0.5;
            const midZ = (local.az + local.bz) * 0.5;

            const cableA = this.makeQuad(cableMat);
            const cableB = this.makeQuad(cableMat);
            const cableAPos = cableA.geometry.getAttribute('position') as THREE.BufferAttribute;
            const cableBPos = cableB.geometry.getAttribute('position') as THREE.BufferAttribute;

            const lineGeom = new THREE.BufferGeometry();
            const linePos = new THREE.BufferAttribute(new Float32Array(9), 3);
            lineGeom.setAttribute('position', linePos);
            const line = new THREE.Line(lineGeom, lineMat);
            line.frustumCulled = false;
            line.onBeforeRender = updateUniforms;

            this.root.add(cableA);
            this.root.add(cableB);
            this.root.add(line);

            this.cables.push({
                local,
                cableA, cableAPos, cableB, cableBPos,
                line, linePos,
            });
            this.placeCableQuad(cableA, cableAPos, local.ax, local.az, midX, midZ);
            this.placeCableQuad(cableB, cableBPos, midX, midZ, local.bx, local.bz);
            this.placeCableLine(linePos, local.ax, local.az, midX, midZ, local.bx, local.bz);
        }
        this.applyLodVisibility();
    }

    private makeQuad(mat: THREE.Material): THREE.Mesh {
        const geom = new THREE.BufferGeometry();
        const pos = new THREE.BufferAttribute(new Float32Array(4 * 3), 3);
        geom.setAttribute('position', pos);
        geom.setIndex([0, 1, 2, 2, 1, 3]);
        geom.computeBoundingSphere();
        const mesh = new THREE.Mesh(geom, mat);
        mesh.frustumCulled = false;
        mesh.onBeforeRender = updateUniforms;
        return mesh;
    }

    /** Sync root TRS from the live carrier pose. */
    private syncRootPose(): ArrestorCarrierPose {
        const pose = this.getCarrierPose();
        this.root.position.copy(pose.position as THREE.Vector3);
        if (pose.quaternion) {
            this.root.quaternion.copy(pose.quaternion);
        } else {
            this.root.quaternion.identity();
        }
        return pose;
    }

    /** World XZ for a carrier-local deck point (yaw applied). */
    private localDeckToWorldXZ(localX: number, localZ: number): { x: number; z: number } {
        this.sampleWorld.set(localX, 0, localZ).applyQuaternion(this.root.quaternion);
        return {
            x: this.root.position.x + this.sampleWorld.x,
            z: this.root.position.z + this.sampleWorld.z,
        };
    }

    /** Sampled deck Y in carrier-local space (never below the authored cable rest height). */
    private deckLocalY(localX: number, localZ: number, liftM: number): number {
        const w = this.localDeckToWorldXZ(localX, localZ);
        const sampled = this.groundHeightAt(w.x, w.z);
        const deckWorld = Math.max(sampled, ARRESTOR_DECK_Y_FALLBACK, ARRESTOR_CABLE_Y - 0.3);
        return deckWorld + liftM - this.root.position.y;
    }

    private cableLocalY(localX: number, localZ: number): number {
        return this.deckLocalY(localX, localZ, ARRESTOR_CABLE_CLEARANCE_M);
    }

    /**
     * Flat ribbon from (ax,az) → (bx,bz) at the given local Y sampler.
     * Vertices are explicit so bent V-legs keep full length (no scaled boxes).
     */
    private placeRibbonQuad(
        mesh: THREE.Mesh,
        pos: THREE.BufferAttribute,
        ax: number,
        az: number,
        bx: number,
        bz: number,
        halfW: number,
        yAt: (x: number, z: number) => number,
    ): void {
        const dx = bx - ax;
        const dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) {
            mesh.visible = false;
            return;
        }
        // Visibility for cable quads is driven by LOD; only mark degenerate as hidden.
        const hx = (-dz / len) * halfW;
        const hz = (dx / len) * halfW;
        const y0 = yAt(ax, az);
        const y1 = yAt(bx, bz);
        pos.setXYZ(0, ax - hx, y0, az - hz);
        pos.setXYZ(1, ax + hx, y0, az + hz);
        pos.setXYZ(2, bx - hx, y1, bz - hz);
        pos.setXYZ(3, bx + hx, y1, bz + hz);
        pos.needsUpdate = true;
        mesh.geometry.computeBoundingSphere();
    }

    private placeCableQuad(
        mesh: THREE.Mesh,
        pos: THREE.BufferAttribute,
        ax: number, az: number, bx: number, bz: number,
    ): void {
        this.placeRibbonQuad(mesh, pos, ax, az, bx, bz, ARRESTOR_CABLE_HALF_W_M, (x, z) => this.cableLocalY(x, z));
    }

    private placeCableLine(
        pos: THREE.BufferAttribute,
        ax: number, az: number,
        midX: number, midZ: number,
        bx: number, bz: number,
        midY?: number,
    ): void {
        const ay = this.cableLocalY(ax, az);
        const by = this.cableLocalY(bx, bz);
        const my = midY ?? this.cableLocalY(midX, midZ);
        pos.setXYZ(0, ax, ay, az);
        pos.setXYZ(1, midX, my, midZ);
        pos.setXYZ(2, bx, by, bz);
        pos.needsUpdate = true;
    }

    /** Show mesh ribbons near the camera, 1px lines when far (with hysteresis). */
    private updateLodFromCamera(camera: THREE.Camera): void {
        this.lodAnchorWorld.copy(this.lodAnchorLocal).applyQuaternion(this.root.quaternion).add(this.root.position);
        const dist = camera.position.distanceTo(this.lodAnchorWorld);
        if (this.useLineLod) {
            if (dist < ARRESTOR_LOD_LINE_M - ARRESTOR_LOD_HYSTERESIS_M) {
                this.useLineLod = false;
            }
        } else if (dist > ARRESTOR_LOD_LINE_M + ARRESTOR_LOD_HYSTERESIS_M) {
            this.useLineLod = true;
        }
        this.applyLodVisibility();
    }

    private applyLodVisibility(): void {
        const near = !this.useLineLod;
        for (const c of this.cables) {
            c.cableA.visible = near;
            c.cableB.visible = near;
            c.line.visible = !near;
        }
    }

    init(_scene: Scene): void {
        //
    }

    update(_delta: number): void {
        this.syncRootPose();
        this.rebuildCableGeometry();
    }

    /**
     * Bend/rest layout for all cables. Call after the player display pose is
     * current — also from render3D because pumpCombatSim runs after scene.update
     * and would otherwise leave the V-mid a snapshot behind the hook.
     */
    private rebuildCableGeometry(): void {
        const pose = this.syncRootPose();

        const player = this.getPlayer();
        const fm = player.getFlightModel();
        let latch = -1;
        if (fm instanceof SimProxyFlightModel) {
            latch = fm.getArrestorLatch();
        }
        // Unlatched cables are static in carrier-local space — the layout and
        // deck heights never change, so the (deck-sampling) rebuild is pure
        // waste. Rebuild only on first build or while a hook is latched.
        if (latch < 0 && this.lastRebuiltLatch < 0 && this.cablesBuilt) {
            return;
        }
        this.cablesBuilt = true;
        this.lastRebuiltLatch = latch;
        if (fm instanceof SimProxyFlightModel) {
            if (latch >= 0) {
                // Same tip as the rendered tailhook (hinge → sheave ray), converted
                // with explicit pose math (matrixWorld invert was placing the apex
                // in the wrong frame and stretching ribbons across the ocean).
                player.updateDisplayTransform();
                player.getArrestorHookHingeBody(this.hingeBody);
                this.hingeWorld.copy(this.hingeBody)
                    .applyQuaternion(player.getDisplayQuaternion())
                    .add(player.getDisplayPosition());
                arrestorCableStartWorld(latch, pose, this.sheaveWorld);
                this.fallbackDir.set(0, -1, -1);
                latchedHookTipWorld(
                    this.hingeWorld, this.sheaveWorld, this.tipWorld, undefined, this.fallbackDir,
                );
                this.worldHookToCarrierLocal(this.tipWorld, pose, this.tipLocal);
            }
        }

        for (let i = 0; i < this.cables.length; i++) {
            const c = this.cables[i];
            const L = c.local;
            let midX: number;
            let midZ: number;
            if (i === latch) {
                midX = this.tipLocal.x;
                midZ = this.tipLocal.z;
            } else {
                midX = (L.ax + L.bx) * 0.5;
                midZ = (L.az + L.bz) * 0.5;
            }
            this.placeCableQuad(c.cableA, c.cableAPos, L.ax, L.az, midX, midZ);
            this.placeCableQuad(c.cableB, c.cableBPos, midX, midZ, L.bx, L.bz);

            let midY = this.cableLocalY(midX, midZ);
            if (i === latch) {
                midY = Math.max(this.tipLocal.y, midY);
                this.raiseQuadEnd(c.cableAPos, 2, 3, midY);
                this.raiseQuadStart(c.cableBPos, midY);
            }
            this.placeCableLine(c.linePos, L.ax, L.az, midX, midZ, L.bx, L.bz, midY);
            c.line.geometry.computeBoundingSphere();
        }
        this.applyLodVisibility();
    }

    /** Inverse of {@link carrierLocalToWorld} (translation + optional yaw). */
    private worldHookToCarrierLocal(
        world: THREE.Vector3,
        pose: ArrestorCarrierPose,
        out: THREE.Vector3,
    ): THREE.Vector3 {
        out.copy(world).sub(pose.position as THREE.Vector3);
        if (pose.quaternion) {
            this.invQuat.copy(pose.quaternion).invert();
            out.applyQuaternion(this.invQuat);
        }
        return out;
    }

    private raiseQuadEnd(pos: THREE.BufferAttribute, i0: number, i1: number, y: number): void {
        pos.setY(i0, y);
        pos.setY(i1, y);
        pos.needsUpdate = true;
    }

    private raiseQuadStart(pos: THREE.BufferAttribute, y: number): void {
        pos.setY(0, y);
        pos.setY(1, y);
        pos.needsUpdate = true;
    }

    render3D(
        _targetWidth: number,
        _targetHeight: number,
        camera: THREE.Camera,
        lists: Map<string, THREE.Scene>,
        _palette: Palette,
    ): void {
        // Rebuild after combat-sim pump so the V-mid tracks the live hook tip.
        this.rebuildCableGeometry();
        this.updateLodFromCamera(camera);
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

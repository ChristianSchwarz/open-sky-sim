import * as THREE from 'three';
import { SceneMaterialManager } from '../materials/materials';
import { Model } from '../models/models';
import { SceneLayers } from '../scene';
import { AfterburnerCones } from './afterburnerCones';
import { FlyableAircraftDef } from './aircraftDef';
import { countBodyMeshVertices, deriveWingtipOriginsFromModel } from './wingtipOrigins';
import { sweptTip, tipSweepsFromDef, TipSweep } from './wingSweep';
import { WingtipTrails } from './wingtipTrails';

/**
 * Shared exterior FX for any flyable aircraft (player or AI): afterburner
 * plumes (AB1/AB2) and wingtip vortex trails. Built from the same
 * {@link FlyableAircraftDef} so only the control input differs between seats.
 */
export class AircraftFx {
    private afterburnerCones: AfterburnerCones;
    private wingtipTrails: WingtipTrails;
    private afterburnerPanesBound = false;
    private wingtipsReady = false;
    private hasNozzles = false;
    private readonly thrustOrigin = new THREE.Vector3();
    private hasThrustOrigin = false;
    private readonly _v = new THREE.Vector3();
    /** Wingtips that ride on sweeping wings, and where the sweep [0,1] is read from. */
    private tipSweeps: [TipSweep, TipSweep] | null = null;
    private wingSweepUnit: () => number = () => 0;
    private readonly _sweptLeft = new THREE.Vector3();
    private readonly _sweptRight = new THREE.Vector3();

    constructor(private readonly materials: SceneMaterialManager) {
        this.afterburnerCones = new AfterburnerCones(materials);
        this.wingtipTrails = new WingtipTrails(materials);
    }

    /** Reconfigure nozzles / trails from an aircraft def (call on load/swap). */
    configureFromDef(def: FlyableAircraftDef): void {
        this.afterburnerPanesBound = false;
        this.wingtipsReady = false;

        this.wingtipTrails = new WingtipTrails(this.materials);
        this.wingtipTrails.reset();

        const nozzles = def.fx?.nozzles ?? null;
        this.hasNozzles = !!(nozzles && nozzles.length > 0);
        this.afterburnerCones.setNozzles(
            nozzles ? nozzles.map(n => new THREE.Vector3().fromArray(n)) : null,
            def.fx?.nozzleRadius ?? null,
        );

        this.hasThrustOrigin = this.hasNozzles;
        if (nozzles && nozzles.length > 0) {
            this.thrustOrigin.set(0, 0, 0);
            for (const n of nozzles) {
                this.thrustOrigin.add(this._v.fromArray(n));
            }
            this.thrustOrigin.multiplyScalar(1 / nozzles.length);
        }

        this.tipSweeps = tipSweepsFromDef(def);
        const tips = def.fx?.wingtips ?? null;
        if (tips && tips.length >= 2) {
            this.wingtipTrails.setTipOrigins(
                new THREE.Vector3().fromArray(tips[0]),
                new THREE.Vector3().fromArray(tips[1]),
            );
            this.wingtipTrails.reset();
            this.wingtipsReady = true;
        }
    }

    /** Where a swing-wing aircraft's current sweep [0,1] comes from (call once). */
    setWingSweepSource(source: () => number): void {
        this.wingSweepUnit = source;
    }

    /** Body-model load callback — bind nozzle glow + wingtip origins. */
    onBodyModelLoaded(model: Model): void {
        this.bindAfterburnerNozzles(model);
        this.bindWingtipOrigins(model);
    }

    /** Retry once the body LOD is available (from the update loop). */
    ensureBound(model: Model): void {
        if (model.lod.length === 0) {
            return;
        }
        if (!this.afterburnerPanesBound) {
            this.bindAfterburnerNozzles(model);
        }
        this.bindWingtipOrigins(model);
    }

    /**
     * @param throttleLever Pilot throttle [0,1] selecting AB1/AB2 stage.
     * @param abDetents     True when the FM runs the afterburner quadrant.
     */
    update(
        throttleLever: number,
        abDetents: boolean,
        displayPosition: THREE.Vector3,
        displayQuaternion: THREE.Quaternion,
        displayVelocity: THREE.Vector3,
    ): void {
        const hasAfterburner = abDetents || this.hasNozzles;
        this.afterburnerCones.update(
            throttleLever,
            hasAfterburner,
            displayPosition,
            displayQuaternion,
        );
        if (this.wingtipsReady) {
            if (this.tipSweeps) {
                const sweep = this.wingSweepUnit();
                this.wingtipTrails.setTipOrigins(
                    sweptTip(this._sweptLeft, this.tipSweeps[0], sweep),
                    sweptTip(this._sweptRight, this.tipSweeps[1], sweep),
                );
            }
            this.wingtipTrails.update(
                displayPosition,
                displayQuaternion,
                displayVelocity,
            );
        }
    }

    addAfterburnerToRenderList(lists: Map<string, THREE.Scene>): void {
        this.afterburnerCones.addToRenderList(SceneLayers.EntityVolumes, lists);
    }

    addTrailsToRenderList(lists: Map<string, THREE.Scene>, camera: THREE.Camera): void {
        if (this.wingtipsReady) {
            this.wingtipTrails.addToRenderList(SceneLayers.EntityFX, lists, camera);
        }
    }

    resetTrails(): void {
        this.wingtipTrails.reset();
    }

    getThrustOrigin(target: THREE.Vector3): THREE.Vector3 | null {
        if (!this.hasThrustOrigin) {
            return null;
        }
        return target.copy(this.thrustOrigin);
    }

    private bindAfterburnerNozzles(model: Model): void {
        if (this.afterburnerPanesBound) {
            return;
        }
        this.afterburnerPanesBound = true;
    }

    private bindWingtipOrigins(model: Model): void {
        if (this.wingtipsReady) {
            return;
        }
        if (countBodyMeshVertices(model) < 8) {
            return;
        }
        const derived = deriveWingtipOriginsFromModel(model);
        if (!derived) {
            return;
        }
        this.wingtipTrails.setTipOrigins(derived.left, derived.right);
        this.wingtipTrails.reset();
        this.wingtipsReady = true;
    }
}

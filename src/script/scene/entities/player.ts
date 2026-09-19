import * as THREE from 'three';
import { AudioClip } from '../../audio/audioSystem';
import { isOverlayKeyEvent } from '../../input/overlayKeys';
import { Palette } from "../../config/palettes/palette";
import { PITCH_STICK_AFT_UNITS, PITCH_STICK_FWD_UNITS, PLANE_DISTANCE_TO_GROUND } from '../../defs';
import { FlightModel } from '../../physics/model/flightModel';
import { FcsPitchLimiter } from '../../physics/fm2/fcs';
import { LODHelper, getLodLevel } from '../../render/helpers';
import { CanvasPainter } from "../../render/screen/canvasPainter";
import { HUDFocusMode } from '../../state/gameDefs';
import { clamp, easeOutQuad, easeOutQuint, FORWARD, RIGHT, UP } from '../../utils/math';
import { Entity, ENTITY_TAGS } from "../entity";
import { SceneMaterialManager } from '../materials/materials';
import { ModelManager, Model } from '../models/models';
import { Scene, SceneLayers } from "../scene";
import { AircraftFx } from './aircraftFx';
import { AircraftForceVectors } from './aircraftForceVectors';
import { setAircraftShadowPose } from './aircraftShadow';
import { trackAircraftMaterial, trackAircraftMesh } from './aircraftDebug';
import { SUN_STATE } from '../materials/shaders/sun';
import { WeaponsTarget } from './weaponsTarget';
import { ControlAxis, ControlSurfaceConfig, FlyableAircraftDef } from './aircraftDef';
import { Combatant, Faction } from '../../weapons/combatant';
import { CombatSimClient } from '../../physics/sim/combatSimClient';
import { SimProxyFlightModel } from '../../physics/model/simProxyFlightModel';
import { PLAYER_SIM_ID } from '../../physics/sim/simIds';
import {
    arrestorCableStartWorld,
    arrestorHookPlacementForAircraft,
    ArrestorCarrierPose,
    DEFAULT_ARRESTOR_HOOK_BODY,
    DEFAULT_ARRESTOR_HOOK_HINGE,
    latchedHookTipWorld,
} from './arrestorCables';

const ENGINE_LOWEST_VOLUME = 0.05; // [0,1]

const LANDING_GEAR_ANIM_DURATION = 3; // Seconds

const FLAPS_ANIM_DURATION = 2; // Seconds
const FLAPS_EXTENDED_ANGLE = Math.PI / 5; // Radians
const AIRBRAKE_ANIM_DURATION = 1.5; // Seconds
const TAILHOOK_ANIM_DURATION = 1.5; // Seconds

/**
 * Visible roll-deflection gains (fraction of a surface's hinge range at full
 * roll). Roll is tail-dominant (~80% differential stabilator / ~20% aileron),
 * so the stabilator shows the large, clearly visible roll deflection and the
 * flaperon only its small aileron share. Visual only — the physics split lives
 * in the FM2 config (taileronRollFraction / aileron max deflection).
 */
const ROLL_VIS_TAILERON = 0.6;
const ROLL_VIS_AILERON = 0.15;
/** Horizontal radius (m) around Kuz origin to treat as on-deck for display ride. */
const CARRIER_DISPLAY_RIDE_RADIUS_M = 200;
/** Max ship-relative groundspeed (m/s) before frozen display glue engages. */
const CARRIER_DISPLAY_PARK_REL_SPEED_MPS = 2.0;

/** Slats begin deploying above this absolute AoA (rad). */
const SLAT_AOA_ONSET_RAD = 10 * Math.PI / 180;
/** Slats reach full extension at this absolute AoA (rad). */
const SLAT_AOA_FULL_RAD = 18 * Math.PI / 180;

interface ControlSurfaceDescriptor {
    model: LODHelper;
    position: THREE.Vector3;
    axis: THREE.Vector3;
    value: () => number;
    range: number;
}

export enum AircraftDeviceState {
    RETRACTING,
    RETRACTED,
    EXTENDING,
    EXTENDED
}

export interface PlayerSpawnState {
    velocity?: THREE.Vector3;
    throttle?: number;
    airborne?: boolean;
}

export class PlayerEntity implements Entity {

    private scene: Scene | undefined;
    private readonly models: ModelManager;
    private modelBody!: LODHelper;
    private modelShadow!: LODHelper;
    private modelLandingGear: LODHelper | undefined;
    private modelTailhook: LODHelper | undefined;
    private shadowPosition = new THREE.Vector3();
    private shadowQuaternion = new THREE.Quaternion();
    private shadowScale = new THREE.Vector3();
    /** Solid-ground Y under the aircraft (flat datum, hills, decks). Defaults to water/flat Y=0. */
    private groundHeightAt: (x: number, z: number) => number = () => 0;
    /**
     * Scene position -> height above the ellipsoid. Identity until the terrain
     * wires it, which is what a scene with no curved ground would want anyway.
     */
    private altitudeAt: (x: number, y: number, z: number) => number = (_x, y) => y;

    private controlSurfaceDescriptors: ControlSurfaceDescriptor[] = [];
    private cockpitOffset = new THREE.Vector3();

    private flightModel: FlightModel;

    private inEngineAudio: AudioClip;
    private outEngineAudio: AudioClip;
    private enginePlaying: boolean = false;
    private engineStarted: boolean = false;

    private landingGearState: AircraftDeviceState = AircraftDeviceState.EXTENDED;
    private landingGearProgress = LANDING_GEAR_ANIM_DURATION;
    /** True when the gear model carries a retract clip (doors stay visible when up). */
    private gearAnimated = false;

    private flapsState: AircraftDeviceState = AircraftDeviceState.EXTENDED;
    private flapsProgress = FLAPS_ANIM_DURATION;
    private flapsProgressUnit = 1.0;
    private airbrakesState: AircraftDeviceState = AircraftDeviceState.RETRACTED;
    private airbrakesProgress = 0;
    private airbrakesProgressUnit = 0;
    /** Tailhook: sim owns the commanded state, this is the visible swing. */
    private hookState: AircraftDeviceState = AircraftDeviceState.RETRACTED;
    private hookProgress = 0;
    private hookProgressUnit = 0;

    private readonly fx: AircraftFx;
    private forceVectors: AircraftForceVectors;
    private _forceVectorsEnabled = false;
    /** Body-frame point where thrust is drawn (engine nozzle centroid). */
    private thrustOrigin = new THREE.Vector3();
    private hasThrustOrigin = false;

    private obj = new THREE.Object3D();

    private displayPosition = new THREE.Vector3();
    private displayQuaternion = new THREE.Quaternion();
    private displayVelocity = new THREE.Vector3();

    private pitch: number = 0; // [-1, 1] normalized command to flight model
    private pitchStickUnits: number = 0; // [-PITCH_STICK_FWD_UNITS, +PITCH_STICK_AFT_UNITS]
    private roll: number = 0; // [-1, 1]
    private yaw: number = 0; // [-1, 1]
    private throttle: number = 0; // [0, 1]
    private wheelBrakes: boolean = false;
    /** FBW AoA/g limiters on (true) or overridden off by the pilot (false). */
    private limitersEnabled: boolean = true;
    /** Active pitch AoA/g limiter strategy (keys 1/2/3). */
    private pitchLimiterMode: FcsPitchLimiter = FcsPitchLimiter.SOFT;

    private velocity: THREE.Vector3 = new THREE.Vector3(); // m/s

    private target: WeaponsTarget | undefined;

    private _nightVision: boolean = false;
    private hudFocus: HUDFocusMode = HUDFocusMode.DISABLED;

    /**
     * Shared combat sim client. The player's physics, gun and autopilot all run
     * inside its worker (id {@link PLAYER_SIM_ID}); this entity is a render proxy
     * plus input source. Undefined until the game wires combat up.
     */
    private combatSim: CombatSimClient | undefined;
    /** True once the sim has been told this aircraft carries a gun. */
    private hasGunFlag = false;
    private readonly maxHealth = 100;
    private health = this.maxHealth;
    readonly faction: Faction = Faction.PLAYER;

    private _v = new THREE.Vector3();
    private _q = new THREE.Quaternion();
    private readonly _hinge = new THREE.Vector3();
    private readonly _hookDir = new THREE.Vector3();
    private readonly _hookStowedDir = new THREE.Vector3();
    private readonly _qStowed = new THREE.Quaternion();
    private readonly _hookTip = new THREE.Vector3();
    private readonly _hookTipBody = new THREE.Vector3(...DEFAULT_ARRESTOR_HOOK_BODY);
    /** Live carrier pose for latched-hook sheave aiming; falls back to default origin. */
    private getArrestorCarrierPose: (() => ArrestorCarrierPose) | undefined;
    private readonly _hookHingeBody = new THREE.Vector3(...DEFAULT_ARRESTOR_HOOK_HINGE);
    /**
     * Visual ride with the steaming Kuznetsov: frozen ship-local offset captured
     * once on park, then display = kuz.position + rideLocal every frame.
     */
    private carrierRideActive = false;
    private readonly carrierRideLocal = new THREE.Vector3();

    readonly tags: string[] = [ENTITY_TAGS.AIRCRAFT];

    enabled: boolean = true;
    private simulationPaused = false;
    private _exteriorView: boolean = false;
    private _showcaseMode = false;
    private showcasePosition = new THREE.Vector3(0, PLANE_DISTANCE_TO_GROUND, 0);
    private showcaseQuaternion = new THREE.Quaternion();
    private showcasePickLists: Map<string, THREE.Scene> = new Map([
        ['showcasePickFlats', new THREE.Scene()],
        ['showcasePickVolumes', new THREE.Scene()],
    ]);
    private showcasePickTmpPoint = new THREE.Vector3();
    private showcasePickTmpClosest = new THREE.Vector3();
    private showcasePickSphere = new THREE.Sphere();

    // Heading increases CCW, radians
    constructor(models: ModelManager, def: FlyableAircraftDef, flightModel: FlightModel, materials: SceneMaterialManager, inEngineAudio: AudioClip, outEngineAudio: AudioClip, position: THREE.Vector3, heading: number) {
        this.models = models;
        this.fx = new AircraftFx(materials);
        this.forceVectors = new AircraftForceVectors(materials);

        this.buildFromDef(def);

        this.flightModel = flightModel;
        this.flightModel.position = position;
        this.flightModel.quaternion = this._q.setFromAxisAngle(UP, heading);
        this.obj.position.copy(position);
        this.obj.quaternion.setFromAxisAngle(UP, heading);
        this.updateDisplayTransform();
        this.inEngineAudio = inEngineAudio;
        this.outEngineAudio = outEngineAudio;

        this.fx.ensureBound(this.modelBody.model);
    }

    /** (Re)build all visual models and control surfaces from an aircraft def. */
    private buildFromDef(def: FlyableAircraftDef): void {
        this.fx.configureFromDef(def);

        this.modelBody = new LODHelper(this.models.getModel(def.body, (_, model) => {
            // Operate on the model the loader hands back rather than this.modelBody:
            // for an already-cached body the listener fires synchronously, before
            // this.modelBody has been reassigned, so this.modelBody would still be
            // the previous aircraft.
            this.fx.onBodyModelLoaded(model);
            this.trackAircraftModel(model);
        }));
        const shadowModel = this.models.getModel(def.shadow);
        this.modelShadow = new LODHelper(shadowModel, 5);
        this.trackAircraftModel(shadowModel);

        if (def.collision) {
            // Prefetch so the asset is resident; meshes stay visible=false in ModelManager.
            const collisionModel = this.models.getModel(def.collision);
            this.trackAircraftModel(collisionModel);
        }

        this.modelLandingGear = undefined;
        this.gearAnimated = false;
        if (def.gear) {
            const animated = def.gearAnimated ?? true;
            this.gearAnimated = animated;
            this.models.getModel(def.gear, (_, model) => {
                this.modelLandingGear = new LODHelper(model);
                if (animated) {
                    this.modelLandingGear.setPlaybackDuration(LANDING_GEAR_ANIM_DURATION);
                    this.modelLandingGear.setPlaybackPosition(1);
                }
                this.trackAircraftModel(model);
            });
        }

        const tailhookModel = this.models.getModel('lib:tailhook');
        this.modelTailhook = new LODHelper(tailhookModel);
        this.trackAircraftModel(tailhookModel);

        const hook = arrestorHookPlacementForAircraft(def);
        this._hookTipBody.fromArray(hook.tip);
        this._hookHingeBody.fromArray(hook.hinge);

        this.cockpitOffset.fromArray(def.cockpitOffset);

        // Anchor the thrust force arrow at the nozzle exit centroid when present.
        this.hasThrustOrigin = this.fx.getThrustOrigin(this.thrustOrigin) !== null;

        this.controlSurfaceDescriptors = def.surfaces.map((s: ControlSurfaceConfig) => {
            const surfaceModel = this.models.getModel(s.model);
            this.trackAircraftModel(surfaceModel);
            return {
                model: new LODHelper(surfaceModel),
                position: new THREE.Vector3().fromArray(s.pivot),
                axis: new THREE.Vector3().fromArray(s.axis),
                value: () => this.surfaceValue(s.control, s.sign),
                range: s.rangeRad,
            };
        });
    }

    private trackAircraftModel(model: Model): void {
        for (const lod of model.lod) {
            for (const obj of lod.flats) {
                this.traverseAndTrackMeshes(obj);
            }
            for (const obj of lod.volumes) {
                this.traverseAndTrackMeshes(obj);
            }
        }
    }

    private traverseAndTrackMeshes(obj: THREE.Object3D): void {
        obj.traverse(child => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;
                const mat = mesh.material;
                if (mat) {
                    if (Array.isArray(mat)) {
                        mat.forEach(m => trackAircraftMaterial(m));
                    } else {
                        trackAircraftMaterial(mat);
                    }
                }
                trackAircraftMesh(mesh);
            } else if ((child as THREE.LineSegments).isLineSegments) {
                const mesh = child as THREE.LineSegments;
                const mat = mesh.material;
                if (mat) {
                    if (Array.isArray(mat)) {
                        mat.forEach(m => trackAircraftMaterial(m));
                    } else {
                        trackAircraftMaterial(mat);
                    }
                }
                trackAircraftMesh(mesh);
            }
        });
    }

    /** Swap the visual aircraft at runtime (flight model swapped separately). */
    loadAircraft(def: FlyableAircraftDef): void {
        this.buildFromDef(def);
        this.fx.ensureBound(this.modelBody.model);
    }

    /** Normalized [0, 1] slat deployment from flaps and high angle of attack. */
    private slatDeploymentUnit(): number {
        const flapDeploy = this.flapsProgressUnit;
        const aoa = Math.abs(this.flightModel.getAngleOfAttack());
        const aoaDeploy = aoa <= SLAT_AOA_ONSET_RAD
            ? 0
            : clamp((aoa - SLAT_AOA_ONSET_RAD) / (SLAT_AOA_FULL_RAD - SLAT_AOA_ONSET_RAD), 0, 1);
        return Math.max(flapDeploy, aoaDeploy);
    }

    /** Map a surface's control binding to a normalized deflection value. */
    private surfaceValue(control: ControlAxis, sign: number): number {
        // FCS-mediated axes are driven by the FCS-commanded (limited) deflection —
        // NOT raw stick — so fly-by-wire shaping (AoA limiter, roll/yaw laws) is
        // visible on the model. The commanded values are exposed in the same
        // polarity/scale as the raw stick, so the existing per-surface sign/range
        // still render correctly. Flaps/slats are not FCS-mediated (kept as-is).
        //
        // Roll is a special case: the rate-command loop relaxes the aileron
        // command back toward neutral once the commanded roll rate is reached, so
        // in a SUSTAINED roll the surfaces would barely deflect even at full
        // stick. To keep the roll visible on the model we blend in the pilot's
        // roll demand and take the larger magnitude (both share +right polarity).
        const rollCmd = this.flightModel.getCommandedAileron();
        const rollDemand = this.rollInput;
        const roll = Math.abs(rollDemand) > Math.abs(rollCmd) ? rollDemand : rollCmd;
        const pitch = this.flightModel.getCommandedElevator();
        switch (control) {
            case 'pitch': return sign * pitch;
            case 'roll': return sign * roll;
            case 'yaw': return sign * this.flightModel.getCommandedRudder();
            case 'flaps': return sign * this.flapsProgressUnit;
            case 'slats': return sign * this.slatDeploymentUnit();
            case 'airbrake': return sign * this.airbrakesProgressUnit;
            // Flaperons: flap camber blended with the ailerons' SHARE of the roll.
            // Roll is tail-dominant (~20% aileron), so the flaperon shows only a
            // small roll deflection.
            case 'flaperonLeft':
                return this.flapsProgressUnit * -FLAPS_EXTENDED_ANGLE
                    - (1.0 - this.flapsProgressUnit * 0.5) * ROLL_VIS_AILERON * roll;
            case 'flaperonRight':
                return this.flapsProgressUnit * FLAPS_EXTENDED_ANGLE
                    - (1.0 - this.flapsProgressUnit * 0.5) * ROLL_VIS_AILERON * roll;
            // All-moving stabilator: pitch plus the DOMINANT differential
            // (taileron) roll deflection, so the tail-driven roll is clearly
            // visible. Left/right take opposite roll signs; a right roll raises
            // the right stabilator trailing edge (same sense as the right aileron).
            case 'stabilatorLeft':
                return sign * (pitch - ROLL_VIS_TAILERON * roll);
            case 'stabilatorRight':
                return sign * (pitch + ROLL_VIS_TAILERON * roll);
            default: return 0;
        }
    }

    /** Cockpit eye offset in the body frame (m). */
    getCockpitOffset(target: THREE.Vector3): THREE.Vector3 {
        return target.copy(this.cockpitOffset);
    }

    init(scene: Scene): void {
        this.scene = scene;
        this.setupInput();
    }

    update(delta: number): void {
        if (this.simulationPaused) {
            return;
        }
        const simHealth = this.flightModel.getSimHealth();
        if (simHealth >= 0) {
            this.health = simHealth;
        }

        if (!this.isWorkerControlled()) {
            if (this.health <= 0) {
                this.pitch = 0;
                this.pitchStickUnits = 0;
                this.roll = 0;
                this.yaw = 0;
                this.throttle = 0;
            }
            this.flightModel.setPitch(this.pitch);
            this.flightModel.setRoll(this.roll);
            this.flightModel.setYaw(this.yaw);
            this.flightModel.setThrottle(this.throttle);
            this.flightModel.setLandingGearDeployed(this.landingGearState === AircraftDeviceState.EXTENDED);
            this.flightModel.setFlapsExtended(this.flapsState === AircraftDeviceState.EXTENDED);
            this.flightModel.setAirbrakesExtended(this.airbrakesState === AircraftDeviceState.EXTENDED);
            this.flightModel.setWheelBrakes(this.wheelBrakes);
            this.flightModel.setLimitersEnabled(this.limitersEnabled);
            this.flightModel.setPitchLimiterMode(this.pitchLimiterMode);
            this.flightModel.update(delta);
        } else {
            this.flightModel.update(delta);
        }

        // Mirror sim-authoritative gear/flaps for airframe animation.
        if (this.isWorkerControlled()) {
            const gear = this.flightModel.getSimGearDeployed();
            if (gear !== null) {
                this.setLandingGearDeployed(gear);
            }
            const flaps = this.flightModel.getSimFlapsExtended();
            if (flaps !== null) {
                this.setFlapsExtended(flaps);
            }
            const airbrakes = this.flightModel.getSimAirbrakesExtended();
            if (airbrakes !== null) {
                this.setAirbrakesExtended(airbrakes);
            }
            const hook = this.flightModel.getSimHookDeployed();
            if (hook !== null) {
                this.setHookDeployed(hook);
            }
        }

        this.obj.position.copy(this.flightModel.position);
        this.obj.quaternion.copy(this.flightModel.quaternion);
        this.velocity.copy(this.flightModel.velocityVector);

        this.updateAudio();
        this.fx.ensureBound(this.modelBody.model);
        this.syncCarrierDisplayRide();
        this.updateDisplayTransform();
        this.fx.update(
            this.throttleUnit,
            this.flightModel.useAfterburnerThrottleDetents(),
            this.displayPosition,
            this.displayQuaternion,
            this.displayVelocity,
        );

        if (!this.isCrashed) {
            this.updateLandingGear(delta);
            this.updateFlaps(delta);
            this.updateAirbrakes(delta);
            this.updateTailhook(delta);
        }
    }

    private isWorkerControlled(): boolean {
        return this.flightModel instanceof SimProxyFlightModel;
    }

    getFlightModel(): FlightModel {
        return this.flightModel;
    }

    updateDisplayTransform(): void {
        if (this._showcaseMode) {
            this.displayPosition.copy(this.showcasePosition);
            this.displayQuaternion.copy(this.showcaseQuaternion);
            this.displayVelocity.set(0, 0, 0);
            return;
        }
        this.flightModel.getRenderPosition(this.displayPosition);
        this.flightModel.getRenderQuaternion(this.displayQuaternion);
        this.flightModel.getRenderVelocity(this.displayVelocity);
        if (this.carrierRideActive && this.getArrestorCarrierPose) {
            const pose = this.getArrestorCarrierPose();
            this.displayPosition.set(
                pose.position.x + this.carrierRideLocal.x,
                pose.position.y + this.carrierRideLocal.y,
                pose.position.z + this.carrierRideLocal.z,
            );
        }
    }

    /**
     * Capture a frozen ship-local offset once when nearly stopped on deck.
     * Do not engage during landing rollout — that felt like instant glue.
     */
    private syncCarrierDisplayRide(): void {
        const poseFn = this.getArrestorCarrierPose;
        if (!poseFn || !this.isLanded || this.throttleUnit > 0.05 || this.isCrashed) {
            this.carrierRideActive = false;
            return;
        }
        // While a cable is on the hook, follow physics display so the V-bend
        // tracks the moving tip (frozen ride would desync during pull-out).
        if (this.flightModel instanceof SimProxyFlightModel
            && this.flightModel.getArrestorLatch() >= 0) {
            this.carrierRideActive = false;
            return;
        }
        const pose = poseFn();
        const dx = this.obj.position.x - pose.position.x;
        const dz = this.obj.position.z - pose.position.z;
        if (dx * dx + dz * dz > CARRIER_DISPLAY_RIDE_RADIUS_M * CARRIER_DISPLAY_RIDE_RADIUS_M) {
            this.carrierRideActive = false;
            return;
        }
        const cv = pose.velocity;
        const relSpd = cv
            ? Math.hypot(this.velocity.x - cv.x, this.velocity.z - cv.z)
            : Math.hypot(this.velocity.x, this.velocity.z);
        if (relSpd > CARRIER_DISPLAY_PARK_REL_SPEED_MPS) {
            this.carrierRideActive = false;
            return;
        }
        if (!this.carrierRideActive) {
            this.carrierRideLocal.set(
                this.obj.position.x - pose.position.x,
                this.obj.position.y - pose.position.y,
                this.obj.position.z - pose.position.z,
            );
            this.carrierRideActive = true;
        }
    }

    reset(position: THREE.Vector3, heading: number, spawn?: PlayerSpawnState) {
        this.flightModel.reset();
        this.flightModel.position = position;
        this.flightModel.quaternion = this._q.setFromAxisAngle(UP, heading);
        this.obj.position.copy(position);
        this.obj.quaternion.setFromAxisAngle(UP, heading);

        const airborne = spawn?.airborne ?? false;
        if (spawn?.velocity) {
            this.velocity.copy(spawn.velocity);
            this.flightModel.velocityVector = spawn.velocity;
        } else {
            this.velocity.set(0, 0, 0);
        }
        this.flightModel.setLanded(!airborne);

        this.pitch = 0;
        this.pitchStickUnits = 0;
        this.roll = 0;
        this.yaw = 0;
        this.throttle = spawn?.throttle ?? 0;
        this.wheelBrakes = false;
        this.limitersEnabled = true;
        this.pitchLimiterMode = FcsPitchLimiter.SOFT;
        this.carrierRideActive = false;
        this.flightModel.setThrottle(this.throttle);
        if (airborne) {
            this.flightModel.syncEffectiveThrottle();
            this.flightModel.snapPhysicsState();
        }
        this.updateDisplayTransform();

        this.landingGearState = AircraftDeviceState.EXTENDED;
        this.modelLandingGear?.setPlaybackPosition(1);
        this.landingGearProgress = LANDING_GEAR_ANIM_DURATION;

        this.flapsState = AircraftDeviceState.EXTENDED;
        this.flapsProgress = FLAPS_ANIM_DURATION;
        this.flapsProgressUnit = 1.0;
        this.airbrakesState = AircraftDeviceState.RETRACTED;
        this.airbrakesProgress = 0;
        this.airbrakesProgressUnit = 0;
        this.hookState = AircraftDeviceState.RETRACTED;
        this.hookProgress = 0;
        this.hookProgressUnit = 0;

        this.engineStarted = false;

        this.fx.resetTrails();

        this.target = undefined;

        this.health = this.maxHealth;
    }

    private updateFlaps(delta: number) {
        if (this.flapsState === AircraftDeviceState.EXTENDING) {
            this.flapsProgress += delta;
            if (this.flapsProgress >= FLAPS_ANIM_DURATION) {
                this.flapsProgress = FLAPS_ANIM_DURATION;
                this.flapsProgressUnit = 1.0;
                this.flapsState = AircraftDeviceState.EXTENDED;
            }
        } else if (this.flapsState === AircraftDeviceState.RETRACTING) {
            this.flapsProgress -= delta;
            if (this.flapsProgress <= 0) {
                this.flapsProgress = 0;
                this.flapsProgressUnit = 0;
                this.flapsState = AircraftDeviceState.RETRACTED;
            }
        }
        if (this.flapsState === AircraftDeviceState.EXTENDING || this.flapsState === AircraftDeviceState.RETRACTING) {
            this.flapsProgressUnit = this.flapsProgress / FLAPS_ANIM_DURATION;
        }
    }

    private updateAirbrakes(delta: number) {
        if (this.airbrakesState === AircraftDeviceState.EXTENDING) {
            this.airbrakesProgress += delta;
            if (this.airbrakesProgress >= AIRBRAKE_ANIM_DURATION) {
                this.airbrakesProgress = AIRBRAKE_ANIM_DURATION;
                this.airbrakesProgressUnit = 1.0;
                this.airbrakesState = AircraftDeviceState.EXTENDED;
            }
        } else if (this.airbrakesState === AircraftDeviceState.RETRACTING) {
            this.airbrakesProgress -= delta;
            if (this.airbrakesProgress <= 0) {
                this.airbrakesProgress = 0;
                this.airbrakesProgressUnit = 0;
                this.airbrakesState = AircraftDeviceState.RETRACTED;
            }
        }
        if (this.airbrakesState === AircraftDeviceState.EXTENDING || this.airbrakesState === AircraftDeviceState.RETRACTING) {
            this.airbrakesProgressUnit = this.airbrakesProgress / AIRBRAKE_ANIM_DURATION;
        }
    }

    private updateTailhook(delta: number) {
        if (this.hookState === AircraftDeviceState.EXTENDING) {
            this.hookProgress += delta;
            if (this.hookProgress >= TAILHOOK_ANIM_DURATION) {
                this.hookProgress = TAILHOOK_ANIM_DURATION;
                this.hookProgressUnit = 1.0;
                this.hookState = AircraftDeviceState.EXTENDED;
            }
        } else if (this.hookState === AircraftDeviceState.RETRACTING) {
            this.hookProgress -= delta;
            if (this.hookProgress <= 0) {
                this.hookProgress = 0;
                this.hookProgressUnit = 0;
                this.hookState = AircraftDeviceState.RETRACTED;
            }
        }
        if (this.hookState === AircraftDeviceState.EXTENDING || this.hookState === AircraftDeviceState.RETRACTING) {
            this.hookProgressUnit = this.hookProgress / TAILHOOK_ANIM_DURATION;
        }
    }

    private updateLandingGear(delta: number) {
        if (this.landingGearState === AircraftDeviceState.EXTENDING || this.landingGearState === AircraftDeviceState.RETRACTING) {
            this.modelLandingGear?.update(delta);
        }
        if (this.landingGearState === AircraftDeviceState.EXTENDING) {
            this.landingGearProgress += delta;
            if (this.landingGearProgress >= LANDING_GEAR_ANIM_DURATION) {
                this.landingGearProgress = LANDING_GEAR_ANIM_DURATION;
                this.landingGearState = AircraftDeviceState.EXTENDED;
            }
        } else if (this.landingGearState === AircraftDeviceState.RETRACTING) {
            this.landingGearProgress -= delta;
            if (this.landingGearProgress <= 0) {
                this.landingGearProgress = 0;
                this.landingGearState = AircraftDeviceState.RETRACTED;
            }
        }
    }

    private updateAudio() {
        const engineAudio = this._exteriorView ? this.outEngineAudio : this.inEngineAudio;

        if (this.isCrashed) {
            if (this.enginePlaying === true) {
                engineAudio.stop();
                this.enginePlaying = false;
            }
            return;
        }

        let throttle = this.flightModel.getThrottleAudioLevel();

        if (throttle > 0 && this.enginePlaying === false) {
            engineAudio.play();
            this.enginePlaying = true;
        }

        if (this.enginePlaying) {
            if (throttle > ENGINE_LOWEST_VOLUME) {
                this.engineStarted = true;
            }
            if (this.engineStarted) {
                throttle = Math.max(ENGINE_LOWEST_VOLUME, throttle);
            }
            const x = throttle;
            const factorRate = easeOutQuad(x);
            const factorGain = easeOutQuint(x);
            engineAudio.rate = 0.25 + 1.75 * factorRate;
            engineAudio.gain = 1.0 * factorGain;
        }
    }

    setFlightModel(flightModel: FlightModel) {
        flightModel.reset();
        flightModel.setCrashed(this.flightModel.isCrashed());
        flightModel.setLanded(this.flightModel.isLanded());
        this.flightModel = flightModel;
        this.flightModel.position = this.obj.position;
        this.flightModel.quaternion = this.obj.quaternion;
        this.flightModel.velocityVector = this.velocity;
        this.updateDisplayTransform();
        this.fx.update(
            this.throttleUnit,
            this.flightModel.useAfterburnerThrottleDetents(),
            this.displayPosition,
            this.displayQuaternion,
            this.displayVelocity,
        );
    }

    set exteriorView(isExteriorView: boolean) {
        if (isExteriorView === this._exteriorView) return;

        this._exteriorView = isExteriorView;
        if (this.enginePlaying && !isExteriorView) {
            this.outEngineAudio.stop();
            this.inEngineAudio.play();
        }
        else if (this.enginePlaying && isExteriorView) {
            this.outEngineAudio.play();
            this.inEngineAudio.stop();
        }
    }

    get exteriorView(): boolean {
        return this._exteriorView;
    }

    get nightVision(): boolean {
        return this._nightVision;
    }

    get isLanded(): boolean {
        return this.flightModel.isLanded();
    }

    get isOnGround(): boolean {
        return this.flightModel.position.y <= PLANE_DISTANCE_TO_GROUND + 0.05;
    }

    get isCrashed(): boolean {
        return this.flightModel.isCrashed();
    }

    get isAutopilotEnabled(): boolean {
        if (this.flightModel instanceof SimProxyFlightModel) {
            return this.flightModel.getSimAutopilot();
        }
        return false;
    }

    get forceVectorsEnabled(): boolean {
        return this._forceVectorsEnabled;
    }

    /** Toggle the debug per-part force-vector overlay (lift/drag/thrust/weight). */
    setForceVectorsEnabled(enabled: boolean): void {
        this._forceVectorsEnabled = enabled;
        this.flightModel.setForceVectorsRequested(enabled);
        this.combatSim?.setForceVectorsRequested(PLAYER_SIM_ID, enabled);
    }

    /** Get aircraft model node for debug manipulation. */
    getModelNode(): LODHelper {
        return this.modelBody;
    }

    render3D(targetWidth: number, targetHeight: number, camera: THREE.Camera, lists: Map<string, THREE.Scene>, palette: Palette): void {

        // No planform silhouette once the sun is too low to cast one.
        if (!this.isCrashed && !this._showcaseMode && SUN_STATE.shadowStrength > 0) {
            setAircraftShadowPose(
                this.displayPosition, this.displayQuaternion, this.groundHeightAt,
                0.5 * this.modelShadow.model.maxSize,
                this.shadowPosition, this.shadowQuaternion, this.shadowScale, this._v);
            this.modelShadow.addToRenderList(
                this.shadowPosition, this.shadowQuaternion, this.shadowScale,
                targetWidth, camera, palette,
                // After EntityVolumes so deck/hull meshes do not overwrite the silhouette.
                SceneLayers.EntityFX, SceneLayers.EntityFX, lists);
        }

        if (this._exteriorView) {
            this.updateDisplayTransform();
            this.fx.update(
                this.throttleUnit,
                this.flightModel.useAfterburnerThrottleDetents(),
                this.displayPosition,
                this.displayQuaternion,
                this.displayVelocity,
            );
            const lodCount = this.modelBody.model.lod.length;
            const lod = lodCount === 0 ? 0 : Math.min(
                getLodLevel(this.displayPosition, this.obj.scale, targetWidth, camera, this.modelBody.model.maxSize),
                lodCount - 1,
            );

            this.modelBody.addToRenderList(
                this.displayPosition, this.displayQuaternion, this.obj.scale,
                targetWidth, camera, palette,
                SceneLayers.EntityFlats, SceneLayers.EntityVolumes, lists, lod);

            this.fx.addAfterburnerToRenderList(lists);

            if (this._forceVectorsEnabled) {
                const samples = this.flightModel.getForceVectors();
                if (this.hasThrustOrigin) {
                    for (const s of samples) {
                        if (s.part === 'engine') {
                            s.origin[0] = this.thrustOrigin.x;
                            s.origin[1] = this.thrustOrigin.y;
                            s.origin[2] = this.thrustOrigin.z;
                        }
                    }
                }
                this.forceVectors.update(this.displayPosition, this.displayQuaternion, samples);
                this.forceVectors.addToRenderList(SceneLayers.EntityVolumes, lists);
            }

            if (lod === 0) {
                // Animated gear keeps rendering when retracted so bay doors stay
                // closed in-clip; static gear is simply hidden when up.
                const showLandingGear = this._showcaseMode
                    || this.gearAnimated
                    || this.landingGearState !== AircraftDeviceState.RETRACTED;
                if (showLandingGear) {
                    this.modelLandingGear?.addToRenderList(
                        this.displayPosition, this.displayQuaternion, this.obj.scale,
                        targetWidth, camera, palette,
                        SceneLayers.EntityFlats, SceneLayers.EntityVolumes, lists, 0);
                }
                // Tailhook only once the pilot lowers it (H); hidden while stowed.
                const showTailhook = this._showcaseMode
                    || this.hookState !== AircraftDeviceState.RETRACTED;
                if (showTailhook && this.modelTailhook) {
                    this.renderTailhook(targetWidth, camera, palette, lists);
                }

                for (let i = 0; i < this.controlSurfaceDescriptors.length; i++) {
                    const d = this.controlSurfaceDescriptors[i];
                    const deflection = this._showcaseMode || this.isCrashed ? 0 : d.value() * d.range;

                    this._q.setFromAxisAngle(this._v.copy(d.axis).applyQuaternion(this.displayQuaternion), deflection).multiply(this.displayQuaternion);
                    this._v.copy(d.position).applyQuaternion(this.displayQuaternion).add(this.displayPosition);
                    d.model.addToRenderList(
                        this._v, this._q, this.obj.scale,
                        targetWidth, camera, palette,
                        SceneLayers.EntityFlats, SceneLayers.EntityVolumes, lists, 0);
                }
            }

            if (!this._showcaseMode) {
                this.fx.addTrailsToRenderList(lists, camera);
            }
        }
    }

    /**
     * Place the tailhook at the belly hinge. Idle: points aft along the body
     * hinge→tip. Latched: tip on hinge→sheave ray so arm and cable leg align.
     * Mid-swing it slerps between stowed (flush aft along the belly) and down.
     */
    private renderTailhook(
        targetWidth: number,
        camera: THREE.Camera,
        palette: Palette,
        lists: Map<string, THREE.Scene>,
    ): void {
        if (!this.modelTailhook) return;

        this._hinge.copy(this._hookHingeBody)
            .applyQuaternion(this.displayQuaternion)
            .add(this.displayPosition);

        let latch = -1;
        if (!this._showcaseMode && this.flightModel instanceof SimProxyFlightModel) {
            latch = this.flightModel.getArrestorLatch();
        }

        if (latch >= 0) {
            // Shared tip with the bent wire: colinear hinge → tip → left sheave.
            this._hookTip.copy(this._hookTipBody).sub(this._hookHingeBody)
                .applyQuaternion(this.displayQuaternion);
            arrestorCableStartWorld(
                latch,
                this.getArrestorCarrierPose?.() ?? undefined,
                this._v,
            );
            latchedHookTipWorld(
                this._hinge, this._v, this._v, this._hookDir, this._hookTip,
            );
        } else {
            this._hookDir.copy(this._hookTipBody).sub(this._hookHingeBody)
                .applyQuaternion(this.displayQuaternion);
            this._hookDir.normalize();
        }
        this._q.setFromUnitVectors(FORWARD, this._hookDir);

        const deploy = this._showcaseMode ? 1 : this.hookProgressUnit;
        if (deploy < 1) {
            // Stowed arm lies flush aft along the belly; it swings down from there.
            this._hookStowedDir.set(0, 0, -1).applyQuaternion(this.displayQuaternion);
            this._qStowed.setFromUnitVectors(FORWARD, this._hookStowedDir);
            this._qStowed.slerp(this._q, deploy);
            this._q.copy(this._qStowed);
        }

        this.modelTailhook.addToRenderList(
            this._hinge, this._q, this.obj.scale,
            targetWidth, camera, palette,
            SceneLayers.EntityFlats, SceneLayers.EntityVolumes, lists, 0);
    }

    render2D(targetWidth: number, targetHeight: number, camera: THREE.Camera, lists: Set<string>, painter: CanvasPainter, palette: Palette): void {
        // Nothing
    }

    /**
     * Build temporary showcase render lists and return ray intersections against
     * the same mesh objects used by exterior rendering (LOD 0).
     */
    raycastShowcase(raycaster: THREE.Raycaster, targetWidth: number, camera: THREE.Camera, palette: Palette): THREE.Intersection[] {
        const flats = this.showcasePickLists.get('showcasePickFlats');
        const volumes = this.showcasePickLists.get('showcasePickVolumes');
        if (!flats || !volumes) {
            return [];
        }
        flats.clear();
        volumes.clear();

        this.modelBody.addToRenderList(
            this.displayPosition, this.displayQuaternion, this.obj.scale,
            targetWidth, camera, palette,
            'showcasePickFlats', 'showcasePickVolumes', this.showcasePickLists, 0);

        const showLandingGear = this._showcaseMode
            || this.gearAnimated
            || this.landingGearState !== AircraftDeviceState.RETRACTED;
        if (showLandingGear) {
            this.modelLandingGear?.addToRenderList(
                this.displayPosition, this.displayQuaternion, this.obj.scale,
                targetWidth, camera, palette,
                'showcasePickFlats', 'showcasePickVolumes', this.showcasePickLists, 0);
        }

        for (let i = 0; i < this.controlSurfaceDescriptors.length; i++) {
            const d = this.controlSurfaceDescriptors[i];
            this._q.copy(this.displayQuaternion);
            this._v.copy(d.position).applyQuaternion(this.displayQuaternion).add(this.displayPosition);
            d.model.addToRenderList(
                this._v, this._q, this.obj.scale,
                targetWidth, camera, palette,
                'showcasePickFlats', 'showcasePickVolumes', this.showcasePickLists, 0);
        }

        const objects = [...flats.children, ...volumes.children];
        if (objects.length === 0) {
            return [];
        }
        const intersections = raycaster.intersectObjects(objects, true);
        if (intersections.length > 0) {
            return intersections;
        }

        // Fallback for thin/holed imported meshes: if the ray misses triangles,
        // select the nearest mesh whose world-space bounding sphere lies close
        // to the ray. This greatly improves hover reliability on models with
        // sparse geometry or cutouts.
        for (const root of objects) {
            root.updateMatrixWorld(true);
        }
        let bestObject: THREE.Object3D | null = null;
        let bestDistance = Infinity;
        for (const root of objects) {
            root.traverse((obj) => {
                if (!('isMesh' in obj)) {
                    return;
                }
                const mesh = obj as THREE.Mesh;
                const geometry = mesh.geometry;
                if (!geometry.boundingSphere) {
                    geometry.computeBoundingSphere();
                }
                if (!geometry.boundingSphere) {
                    return;
                }
                this.showcasePickSphere.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
                raycaster.ray.closestPointToPoint(this.showcasePickSphere.center, this.showcasePickTmpClosest);
                const toClosest = this.showcasePickTmpPoint.copy(this.showcasePickTmpClosest).sub(raycaster.ray.origin);
                const alongRay = toClosest.dot(raycaster.ray.direction);
                if (alongRay < 0) {
                    return;
                }
                const d2 = this.showcasePickTmpClosest.distanceToSquared(this.showcasePickSphere.center);
                const radius = this.showcasePickSphere.radius * 1.25;
                if (d2 > radius * radius) {
                    return;
                }
                if (alongRay < bestDistance) {
                    bestDistance = alongRay;
                    bestObject = mesh;
                }
            });
        }
        if (!bestObject) {
            return [];
        }
        this.showcasePickTmpPoint.copy(raycaster.ray.direction).multiplyScalar(bestDistance).add(raycaster.ray.origin);
        return [{
            distance: bestDistance,
            point: this.showcasePickTmpPoint.clone(),
            object: bestObject,
        } as THREE.Intersection];
    }

    setPitch(pitch: number) {
        this.pitchStickUnits = pitch >= 0
            ? pitch * PITCH_STICK_AFT_UNITS
            : pitch * PITCH_STICK_FWD_UNITS;
        this.pitch = this.normalizedPitchFromStickUnits(this.pitchStickUnits);
    }

    stepPitchStickUnits(delta: number) {
        this.pitchStickUnits = clamp(
            this.pitchStickUnits + delta,
            -PITCH_STICK_FWD_UNITS,
            PITCH_STICK_AFT_UNITS,
        );
        this.pitch = this.normalizedPitchFromStickUnits(this.pitchStickUnits);
    }

    private normalizedPitchFromStickUnits(units: number): number {
        return units >= 0
            ? units / PITCH_STICK_AFT_UNITS
            : units / PITCH_STICK_FWD_UNITS;
    }

    setSimulationPaused(paused: boolean): void {
        this.simulationPaused = paused;
        this.combatSim?.setInputEnabled(PLAYER_SIM_ID, !paused);
    }

    setShowcaseMode(enabled: boolean): void {
        if (enabled === this._showcaseMode) {
            return;
        }
        this._showcaseMode = enabled;
        if (enabled) {
            this.showcasePosition.set(0, PLANE_DISTANCE_TO_GROUND, 0);
            this.showcaseQuaternion.identity();
        }
        this.updateDisplayTransform();
    }

    get showcaseMode(): boolean {
        return this._showcaseMode;
    }

    get controlsEnabled(): boolean {
        return !this.simulationPaused;
    }

    setRoll(roll: number) {
        this.roll = roll;
    }

    setYaw(yaw: number) {
        this.yaw = yaw;
    }

    setWheelBrakes(applied: boolean) {
        this.wheelBrakes = applied;
    }

    /** Drive the gear to a target state (used by the AI pilot). */
    setLandingGearDeployed(deployed: boolean) {
        const isDeployed = this.landingGearState === AircraftDeviceState.EXTENDED
            || this.landingGearState === AircraftDeviceState.EXTENDING;
        if (deployed !== isDeployed) {
            this.toggleLandingGear();
        }
    }

    /** Drive the flaps to a target state (used by the AI pilot). */
    setFlapsExtended(extended: boolean) {
        const isExtended = this.flapsState === AircraftDeviceState.EXTENDED
            || this.flapsState === AircraftDeviceState.EXTENDING;
        if (extended !== isExtended) {
            this.toggleFlaps();
        }
    }

    /** Drive the airbrakes to a target state (used by the AI pilot / B key). */
    setAirbrakesExtended(extended: boolean) {
        const isExtended = this.airbrakesState === AircraftDeviceState.EXTENDED
            || this.airbrakesState === AircraftDeviceState.EXTENDING;
        if (extended !== isExtended) {
            this.toggleAirbrakes();
        }
    }

    /** Drive the tailhook to a target state (sim-owned, toggled by the H key). */
    setHookDeployed(deployed: boolean) {
        const isDeployed = this.hookState === AircraftDeviceState.EXTENDED
            || this.hookState === AircraftDeviceState.EXTENDING;
        if (deployed !== isDeployed) {
            this.toggleTailhook();
        }
    }

    /** Wire the shared combat sim client (physics/gun/autopilot run in its worker). */
    setCombatSimClient(client: CombatSimClient) {
        this.combatSim = client;
    }

    /**
     * Solid-ground sampler used to place the planform shadow (carrier/hills/flat).
     * Reads the terrain mesh on screen, not the DEM: the shadow has to land on
     * the triangles the depth test compares it against. See drawnGroundHeightAt.
     */
    setGroundHeightAt(fn: (x: number, z: number) => number): void {
        this.groundHeightAt = fn;
    }

    /**
     * Scene Y -> altimeter altitude.
     *
     * The scene is a tangent plane at the play area's origin and the terrain is
     * drawn curving away from it, so scene Y understates true altitude by more
     * the further out you fly — ~1.8 km at the corner of a three-degree area,
     * which is why an altimeter reading raw Y showed zero with the ground still
     * a kilometre below. See `HeightSampler.geodeticAltitudeAtEnu`.
     */
    setAltitudeAt(fn: (x: number, y: number, z: number) => number): void {
        this.altitudeAt = fn;
    }

    /** Height above the ellipsoid of the drawn aircraft, in metres. */
    getDisplayAltitude(): number {
        const p = this.displayPosition;
        return this.altitudeAt(p.x, p.y, p.z);
    }

    /** Mark that this aircraft carries a gun (config lives in the sim descriptor). */
    setHasGun(hasGun: boolean) {
        this.hasGunFlag = hasGun;
    }

    // --- Combatant ---------------------------------------------------------

    readPosition(target: THREE.Vector3): THREE.Vector3 {
        return target.copy(this.obj.position);
    }

    readVelocity(target: THREE.Vector3): THREE.Vector3 {
        return target.copy(this.velocity);
    }

    getHitRadius(): number {
        return 10;
    }

    isAlive(): boolean {
        return !this.isCrashed && this.health > 0;
    }

    applyDamage(amount: number): void {
        if (this.health <= 0) {
            return;
        }
        this.health -= amount;
        if (this.health <= 0) {
            this.health = 0;
            // Flameout only; ground impact still sets crashed via the flight model.
            this.flightModel.setThrottle(0);
            this.flightModel.syncEffectiveThrottle();
        }
    }

    get healthFraction(): number {
        return this.health / this.maxHealth;
    }

    get gunAmmo(): number {
        const ammo = this.flightModel.getSimAmmo();
        return ammo >= 0 ? ammo : 0;
    }

    get hasGun(): boolean {
        return this.hasGunFlag;
    }

    setThrottle(throttle: number) {
        this.throttle = throttle;
    }

    adjustThrottle(step: number) {
        this.throttle = this.flightModel.adjustThrottleInput(this.throttle, step);
    }

    stepThrottle(direction: 1 | -1) {
        if (this.flightModel.useAfterburnerThrottleDetents()) {
            this.throttle = this.flightModel.stepThrottleDetent(this.throttle, direction);
        } else {
            this.adjustThrottle(direction * 0.01 * 33);
        }
    }

    useAfterburnerThrottleDetents(): boolean {
        return this.flightModel.useAfterburnerThrottleDetents();
    }

    isInThrottleAbDetentBand(): boolean {
        return this.flightModel.isInThrottleAbDetentBand(this.throttle);
    }

    set position(p: THREE.Vector3) {
        this.obj.position.copy(p);
    }

    get position() {
        return this.obj.position;
    }

    set quaternion(q: THREE.Quaternion) {
        this.obj.quaternion.copy(q);
    }

    get quaternion() {
        return this.obj.quaternion;
    }

    getDisplayPosition(): THREE.Vector3 {
        return this.displayPosition;
    }

    getDisplayQuaternion(): THREE.Quaternion {
        return this.displayQuaternion;
    }

    /** Body-frame arrestor hook hinge (matches the visible tailhook). */
    getArrestorHookHingeBody(out: THREE.Vector3): THREE.Vector3 {
        return out.copy(this._hookHingeBody);
    }

    /** World-space hook tip matching the rendered tailhook / cable V-mid. */
    getArrestorHookTipWorld(out: THREE.Vector3): THREE.Vector3 {
        return out.copy(this._hookTipBody)
            .applyQuaternion(this.displayQuaternion)
            .add(this.displayPosition);
    }

    /** Provide the live carrier pose so a latched hook aims at the moving sheave. */
    setArrestorCarrierPoseProvider(getPose: () => ArrestorCarrierPose): void {
        this.getArrestorCarrierPose = getPose;
    }

    private getBarricadeStatus: (() => string | undefined) | undefined;

    /**
     * Ship-side barricade status for the HUD device stack (undefined when the
     * net is stowed). Provided by the game, which owns the carrier's systems.
     */
    setBarricadeStatusProvider(get: () => string | undefined): void {
        this.getBarricadeStatus = get;
    }

    get barricadeStatus(): string | undefined {
        return this.getBarricadeStatus?.();
    }

    getDisplayVelocity(): THREE.Vector3 {
        return this.displayVelocity;
    }

    getDisplayWorldDirection(v: THREE.Vector3): THREE.Vector3 {
        return v.copy(FORWARD).applyQuaternion(this.displayQuaternion);
    }

    getDisplayWorldUp(v: THREE.Vector3): THREE.Vector3 {
        return v.copy(UP).applyQuaternion(this.displayQuaternion);
    }

    getDisplayWorldRight(v: THREE.Vector3): THREE.Vector3 {
        return v.copy(RIGHT).applyQuaternion(this.displayQuaternion);
    }

    getWorldDirection(v: THREE.Vector3): THREE.Vector3 {
        return this.obj.getWorldDirection(v);
    }

    getWorldUp(v: THREE.Vector3): THREE.Vector3 {
        return v
            .copy(UP)
            .applyQuaternion(this.obj.quaternion);
    }

    getWorldRight(v: THREE.Vector3): THREE.Vector3 {
        return v
            .copy(RIGHT)
            .applyQuaternion(this.obj.quaternion);
    }

    get throttleUnit(): number {
        return this.isWorkerControlled()
            ? this.flightModel.getPilotThrottle()
            : this.throttle;
    }

    get pitchInput(): number {
        return this.isWorkerControlled()
            ? this.flightModel.getPilotPitch()
            : this.pitch;
    }

    /** Max nose-up / nose-down elevator-command clamp bounds (same +nose-up
     *  polarity as the pitch input), ±1 with the FBW limiters OFF. */
    get elevatorLimitHigh(): number {
        return this.flightModel.getElevatorCommandLimitHigh();
    }

    get elevatorLimitLow(): number {
        return this.flightModel.getElevatorCommandLimitLow();
    }

    get rollInput(): number {
        return this.isWorkerControlled()
            ? this.flightModel.getPilotRoll()
            : this.roll;
    }

    get yawInput(): number {
        return this.isWorkerControlled()
            ? this.flightModel.getPilotYaw()
            : this.yaw;
    }

    get rawSpeed(): number {
        return this.velocity.length();
    }

    get velocityVector(): THREE.Vector3 {
        return this.velocity;
    }

    /** Scratch list reused by target cycling; never handed out. */
    private readonly targetCandidates: WeaponsTarget[] = [];

    get weaponsTarget(): WeaponsTarget | undefined {
        return this.target;
    }

    /** Designate a weapons target (or clear with undefined). */
    setWeaponsTarget(target: WeaponsTarget | undefined): void {
        this.target = target;
    }

    get stallStatus(): number {
        return this.flightModel.getStallStatus();
    }

    get angleOfAttack(): number {
        return this.flightModel.getAngleOfAttack();
    }

    get loadFactorG(): number {
        return this.flightModel.getLoadFactorG();
    }

    get engineThrustKn(): number {
        return this.flightModel.getEngineThrustKn();
    }

    get throttleHudText(): string {
        return this.flightModel.getThrottleHudText();
    }

    get hudFocusMode(): HUDFocusMode {
        return this.hudFocus;
    }

    get landingGear(): AircraftDeviceState {
        return this.landingGearState;
    }

    get flaps(): AircraftDeviceState {
        return this.flapsState;
    }

    get airbrakes(): AircraftDeviceState {
        return this.airbrakesState;
    }

    get tailhook(): AircraftDeviceState {
        return this.hookState;
    }

    get wheelBrakesApplied(): boolean {
        return this.isWorkerControlled()
            ? this.flightModel.getWheelBrakesApplied()
            : this.wheelBrakes;
    }

    get fcsLimitersEnabled(): boolean {
        return this.isWorkerControlled()
            ? this.flightModel.isLimitersEnabled()
            : this.limitersEnabled;
    }

    /** Active pitch AoA/g limiter strategy (keys 1/2/3). */
    get fcsPitchLimiterMode(): FcsPitchLimiter {
        return this.isWorkerControlled()
            ? this.flightModel.getPitchLimiterMode()
            : this.pitchLimiterMode;
    }

    private setupInput() {
        document.addEventListener('keypress', (event: KeyboardEvent) => {
            if (!isOverlayKeyEvent(event) && !this.isCrashed && this.controlsEnabled) {
                switch (event.key) {
                    case 't': {
                        this.pickTarget();
                        break;
                    }
                    case 'i': {
                        this._nightVision = !this._nightVision;
                        break;
                    }
                    case 'u': {
                        this.hudFocus += 1;
                        this.hudFocus %= HUDFocusMode._LENGTH;
                        break;
                    }
                }
            }
        });
    }

    private pickTarget() {
        const candidates = this.collectWeaponsTargets(this.targetCandidates);
        if (candidates.length === 0) {
            this.target = undefined;
            return;
        }
        const current = this.target !== undefined ? candidates.indexOf(this.target) : -1;
        const next = current + 1;
        this.target = next >= candidates.length ? undefined : candidates[next];
    }

    /**
     * The designatable weapons targets, in cycling order: the fixed ground
     * installations followed by any live airborne enemy aircraft. Fills and
     * returns `out`, so callers that poll it (the tactical MFD) reuse one array
     * instead of allocating per scan.
     */
    collectWeaponsTargets(out: WeaponsTarget[] = []): WeaponsTarget[] {
        out.length = 0;
        if (!this.scene) {
            return out;
        }
        for (const entity of this.scene.listByTag(ENTITY_TAGS.TARGET)) {
            out.push(entity as unknown as WeaponsTarget);
        }
        for (const entity of this.scene.listByTag(ENTITY_TAGS.AIRCRAFT)) {
            if (entity === this) {
                continue;
            }
            const combatant = entity as unknown as Combatant;
            if (combatant.faction === Faction.ENEMY && combatant.isAlive()) {
                out.push(entity as unknown as WeaponsTarget);
            }
        }
        return out;
    }

    private toggleFlaps() {
        if (this.flapsState === AircraftDeviceState.EXTENDED || this.flapsState === AircraftDeviceState.EXTENDING) {
            this.flapsState = AircraftDeviceState.RETRACTING;
        } else {
            this.flapsState = AircraftDeviceState.EXTENDING;
        }
    }

    private toggleAirbrakes() {
        if (this.airbrakesState === AircraftDeviceState.EXTENDED || this.airbrakesState === AircraftDeviceState.EXTENDING) {
            this.airbrakesState = AircraftDeviceState.RETRACTING;
        } else {
            this.airbrakesState = AircraftDeviceState.EXTENDING;
        }
    }

    private toggleTailhook() {
        if (this.hookState === AircraftDeviceState.EXTENDED || this.hookState === AircraftDeviceState.EXTENDING) {
            this.hookState = AircraftDeviceState.RETRACTING;
        } else {
            this.hookState = AircraftDeviceState.EXTENDING;
        }
    }

    private toggleLandingGear() {
        if (this.landingGearState === AircraftDeviceState.EXTENDED || this.landingGearState === AircraftDeviceState.EXTENDING) {
            if (!this.isLanded) {
                if (this.landingGearState === AircraftDeviceState.EXTENDED) {
                    this.modelLandingGear?.setPlaybackPosition(1.0);
                }
                this.landingGearState = AircraftDeviceState.RETRACTING;
                this.modelLandingGear?.playBackwards();
            }
        } else {
            if (this.landingGearState === AircraftDeviceState.RETRACTED) {
                this.modelLandingGear?.setPlaybackPosition(0.0);
            }
            this.landingGearState = AircraftDeviceState.EXTENDING;
            this.modelLandingGear?.play();
        }
    }
}

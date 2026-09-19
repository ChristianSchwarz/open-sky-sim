import { Fm2AircraftConfig } from '../../physics/fm2/fm2AircraftConfig';

/**
 * How a control surface's deflection is driven from the pilot's inputs.
 *   pitch/roll/yaw : signed stick/pedal input.
 *   flaps          : flap deployment progress [0,1].
 *   slats          : leading-edge slats — follow flaps and high AoA.
 *   airbrake       : speedbrake / airbrake deployment progress [0,1].
 *   flaperonLeft/Right : the F-22's combined flap + roll blend (kept so the
 *                        default aircraft animates exactly as before).
 *   stabilatorLeft/Right : an all-moving tail that combines pitch with a
 *                        differential (taileron) roll deflection, so the roll
 *                        the tail actually flies is visible on the model.
 */
export type ControlAxis = 'pitch' | 'roll' | 'yaw' | 'flaps' | 'slats' | 'airbrake'
    | 'flaperonLeft' | 'flaperonRight' | 'stabilatorLeft' | 'stabilatorRight';

/** A single animated control surface loaded as its own hinge-pivoted model. */
export interface ControlSurfaceConfig {
    role: string;
    /** glTF/GLB path of the hinge-pivoted surface model. */
    model: string;
    /** Hinge pivot in the aircraft body frame (m). */
    pivot: [number, number, number];
    /** Hinge axis (body frame unit vector). */
    axis: [number, number, number];
    control: ControlAxis;
    /** Deflection sign multiplier. */
    sign: number;
    /** Maximum deflection scale (rad) applied to the control value. */
    rangeRad: number;
}

/** TCA hardpoint / loadout attachment empty (body frame). */
interface AircraftAttachmentConfig {
    name: string;
    position: [number, number, number];
    /** Local +Z forward axis in body frame. */
    forward: [number, number, number];
}

/** Optional visual effects; omit fields to use auto-derived defaults. */
interface AircraftFxConfig {
    /** Wingtip vortex trail origins [left, right] (body frame); null/omit auto-derives. */
    wingtips?: [[number, number, number], [number, number, number]] | null;
    /** Afterburner nozzle exit origins (body frame); null uses the twin default. */
    nozzles?: [number, number, number][] | null;
    /** Representative nozzle radius (m) for sizing the plume/interior; null uses default. */
    nozzleRadius?: number | null;
}

/** Optional spawn metadata from TCA Aircraft2 JSON. */
interface AircraftSpawnConfig {
    /** Ground-contact tweak from TCA SpawnOffset (metres). Not applied to FM2 runway spawn Y — see game.runwaySpawnPosition. */
    offset?: number;
    /** Ramp heading offset from TCA SpawnRotation (degrees). */
    rotation?: number;
    /** Map/radar blip RGB from TCA DotColors. */
    dotColors?: [number, number, number];
}

/** Baked TCA collider geometry in the aircraft body frame (same as body glTF). */
export interface AircraftCollisionMesh {
    /** Flat triangle soup: 9 floats per triangle (v0xyz, v1xyz, v2xyz). */
    triangles: number[];
    aabb: { min: [number, number, number]; max: [number, number, number] };
}

/** Everything needed to build and fly a player aircraft. */
export interface FlyableAircraftDef {
    id: string;
    name: string;
    /** Exterior body model path. */
    body: string;
    /** Flattened shadow silhouette model path. */
    shadow: string;
    /** Invisible TCA collider / hitbox mesh (optional). */
    collision?: string;
    /** Baked body-frame collision triangles + AABB for the combat worker. */
    collisionMesh?: AircraftCollisionMesh;
    /** Landing-gear model path (optional). */
    gear?: string;
    /** True when the gear model carries a retract/extend animation clip. */
    gearAnimated?: boolean;
    surfaces: ControlSurfaceConfig[];
    fx?: AircraftFxConfig;
    /** Hardpoint/loadout attachment empties from the source mod (optional). */
    attachments?: AircraftAttachmentConfig[] | null;
    /** Cockpit eye offset from the aircraft origin (body frame, m): [x, y, z]. */
    cockpitOffset: [number, number, number];
    /** Optional spawn metadata from the source mod. */
    spawn?: AircraftSpawnConfig;
    /** FM2 flight-dynamics config; when set, the FM2 model flies this aircraft. */
    flight?: Fm2AircraftConfig;
    /** TCA / mod canonical type name (groups liveries of the same airframe). */
    canonicalName?: string;
    /** Spawn-menu aircraft label without livery suffix. */
    modelName?: string;
    /** Livery / material label when multiple variants exist. */
    liveryName?: string;
}

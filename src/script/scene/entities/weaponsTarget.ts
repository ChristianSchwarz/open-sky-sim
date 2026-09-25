import * as THREE from 'three';

/**
 * Something the player can designate as a weapons target: shown in the target
 * MFD (MFD2), framed by the target camera, and boxed by the main HUD. Implemented
 * by fixed {@link GroundTargetEntity} installations and by airborne enemy aircraft.
 */
export interface WeaponsTarget {
    /** World/display position used for the target camera, range and bearing. */
    readonly position: THREE.Vector3;
    /** Offset from {@link position} to the visual centre of the target. */
    readonly localCenter: THREE.Vector3;
    /** Largest visible extent (m); drives the target-camera zoom factor. */
    readonly maxSize: number;
    /** Short type label shown in the target MFD. */
    readonly targetType: string;
    /** Location / status label shown in the target MFD. */
    readonly targetLocation: string;
    /** True for airborne targets (enemy aircraft), false for fixed ground targets. */
    readonly airborne: boolean;
    /**
     * Optional world velocity (m/s). Airborne combatants expose this for AI
     * gunnery / telemetry; ground installations omit it. The HUD gun pipper
     * uses target range only (no automatic lead).
     */
    readVelocity?(out: THREE.Vector3): THREE.Vector3;
    /** Airspeed (m/s). Airborne combatants only. */
    readonly targetSpeedMps?: number;
    /** Instantaneous load factor (g). Airborne combatants only. */
    readonly targetLoadFactorG?: number;
    /** Remaining hull [0, 1]. Airborne combatants only. */
    readonly targetHealthFraction?: number;
    /** Raw pilot stick pitch command [-1, 1]. Airborne combatants only. */
    readonly targetStickPitch?: number;
    /** Raw pilot stick roll command [-1, 1]. Airborne combatants only. */
    readonly targetStickRoll?: number;
    /** Pilot throttle-lever position [0, 1]. Airborne combatants only. */
    readonly targetThrottle?: number;
    /** Current AI maneuver / phase label (e.g. PURSUE, SHAW:HIGH_YO_YO). */
    readonly targetManeuver?: string;
    /**
     * The runway to fly down, for a target the ILS can guide to.
     *
     * Present on airfields, which no longer all point the same way: the sim
     * used to have one runway on heading 0, and the needles could be derived
     * from a position alone. Absent leaves the legacy geometry, which is what
     * the authored airbase still uses.
     */
    readonly approachRunway?: {
        readonly center: THREE.Vector3;
        /** Scene heading (rad) landing on this runway; 0 faces +Z. */
        readonly heading: number;
        readonly halfLength: number;
    };
}

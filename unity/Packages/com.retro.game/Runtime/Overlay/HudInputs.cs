using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// weaponsTarget.ts WeaponsTarget, the part the HUD and the exterior data
    /// readout use: the designated target's position (box, gun range, ILS),
    /// its type (ILS for "Airbase" / "Carrier") and labels.
    /// </summary>
    public sealed class HudTarget
    {
        /// <summary>World/display position, scene frame (m). For a carrier this is the ship's live origin.</summary>
        public Vec3d Position;
        /// <summary>Offset from Position to the target's visual centre (m); the gun range is measured to Position + LocalCenter.</summary>
        public Vec3d LocalCenter;
        /// <summary>Short type label ("Airbase", "Carrier", "SAM Radar", an aircraft type, ...).</summary>
        public string TargetType = "";
        /// <summary>Location / status label (exterior readout only).</summary>
        public string TargetLocation = "";
        /// <summary>True for airborne targets; an airborne target never drives the ILS.</summary>
        public bool Airborne;
        /// <summary>The runway an airfield target guides down; null for the legacy airbase geometry.</summary>
        public ApproachRunway ApproachRunway;
    }

    /// <summary>
    /// One frame of everything hud.ts reads from the PlayerEntity, the config
    /// and the perf globals. Positions and directions are in the scene frame
    /// (x east, y up, z south, metres); the body frame is three.js's object
    /// frame (+Z nose, +Y up). All "display" values are the interpolated pose
    /// the frame draws, not the physics step's.
    /// </summary>
    public sealed class HudInputs
    {
        /// <summary>Settings: the active unit system (config unitSystem).</summary>
        public UnitSystem Units = UnitSystem.Metric;
        /// <summary>Settings / player: HUD focus mode (PlayerEntity.hudFocusMode).</summary>
        public HudFocusMode FocusMode = HudFocusMode.Disabled;
        /// <summary>Settings: the active flight model is FM3 (its FCS label reads "FCS FM3").</summary>
        public bool FlightModelFm3;

        /// <summary>getDisplayPosition (m).</summary>
        public Vec3d Position;
        /// <summary>getDisplayQuaternion: body to scene.</summary>
        public Quatd Quaternion = Quatd.Identity;
        /// <summary>getDisplayVelocity (m/s, scene frame).</summary>
        public Vec3d Velocity;
        /// <summary>getDisplayAltitude: height above the WGS84 ellipsoid (m), not scene y.</summary>
        public double AltitudeM;

        /// <summary>stallStatus in [-1, 1]; values >= 0 mean stalled.</summary>
        public double StallStatus = -1;
        /// <summary>angleOfAttack (rad).</summary>
        public double AngleOfAttackRad;
        /// <summary>loadFactorG (g).</summary>
        public double LoadFactorG = 1;
        /// <summary>isLanded: on the ground or deck (suppresses the STALL text).</summary>
        public bool IsLanded = true;
        /// <summary>isAutopilotEnabled ("AP" above the throttle readout).</summary>
        public bool AutopilotEnabled;
        /// <summary>hasGun: shows the GUN/HULL readout and the gun pipper.</summary>
        public bool HasGun;
        /// <summary>gunAmmo (rounds).</summary>
        public int GunAmmo;
        /// <summary>healthFraction in [0, 1].</summary>
        public double HealthFraction = 1;

        /// <summary>pitchInput / rollInput / yawInput: pilot stick and pedal commands in [-1, 1] (pitch + = aft / nose up).</summary>
        public double PitchInput, RollInput, YawInput;
        /// <summary>elevatorLimitHigh / Low: the FCS elevator-command clamp in [-1, 1] (same polarity as PitchInput).</summary>
        public double ElevatorLimitHigh = 1, ElevatorLimitLow = -1;
        /// <summary>throttleUnit: the pilot's throttle lever in [0, 1].</summary>
        public double Throttle;
        /// <summary>throttleHudText: the flight model's throttle label (e.g. "MIL 82%", "AB2").</summary>
        public string ThrottleHudText = "";
        /// <summary>fcsLimitersEnabled.</summary>
        public bool FcsLimitersEnabled = true;
        /// <summary>fcsPitchLimiterMode: Retro.Sim.FcsPitchLimiter value (1 SOFT, 2 PREDICTIVE, 3 SMOOTH); others show no label.</summary>
        public int FcsPitchLimiterMode = 1;

        /// <summary>weaponsTarget, or null.</summary>
        public HudTarget Target;

        /// <summary>performance.now() at render time (ms): drives the FPS readout's EMA.</summary>
        public double NowMs;
        /// <summary>__terrainStats.triangles: terrain triangles drawn last frame.</summary>
        public double TerrainTriangles;
        /// <summary>__fieldStats.cloud + __fieldStats.cirrus: cloud triangles drawn last frame.</summary>
        public double CloudTriangles;
        /// <summary>__sceneTriangles: all triangles the GPU drew last frame (objects = the remainder).</summary>
        public double SceneTriangles;
    }
}

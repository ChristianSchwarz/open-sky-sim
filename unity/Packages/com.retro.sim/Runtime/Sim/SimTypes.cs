namespace Retro.Sim
{
    /// <summary>Who writes an aircraft's command buffer: the client (keyboard/gamepad) or an in-sim AI pilot.</summary>
    public enum SimControlMode
    {
        External,
        Ai,
    }

    /// <summary>Which physics flies a sim-owned aircraft: FM2, FM2's free-fly mode, or FM3.</summary>
    public enum SimFlightModelKind
    {
        Fm2,
        Debug,
        Fm3,
    }

    /// <summary>The normalized command channel for one externally-controlled aircraft (port of simTypes.ts).</summary>
    public sealed class SimControlInputs
    {
        public double Pitch;
        public double Roll;
        public double Yaw;
        public double Throttle;
        public bool LandingGearDeployed;
        public bool FlapsExtended;
        public bool AirbrakesExtended;
        /// <summary>Tailhook lowered; required to snag an arrestor cable.</summary>
        public bool HookDeployed;
        public bool WheelBrakesApplied;
        public FcsPitchLimiter PitchLimiterMode;
        public bool LimitersEnabled;
        public bool WantForceVectors;
        /// <summary>Trigger held this frame (only meaningful for aircraft with a gun).</summary>
        public bool Firing;
    }

    public sealed class SimGunConfig
    {
        public double MuzzleVelocity;
        public double RoundsPerSecond;
        public double Damage;
        public double Ammo;
        public double[] MuzzleOffset = new double[3];
        public double? Spread;
    }

    public sealed class SimAircraftSpawn
    {
        public double[] Position = new double[3];
        public double[] Quaternion = { 0, 0, 0, 1 };
        /// <summary>Optional; null leaves the model's velocity alone.</summary>
        public double[] Velocity;
        public bool Landed;
        public double Throttle;
        public bool Airborne;
    }

    public sealed class SimAircraftDesc
    {
        public string Id;
        /// <summary>Faction (see <see cref="Faction"/>).</summary>
        public Faction Faction;
        public SimControlMode Control;
        /// <summary>Flight model; when null, <see cref="Kinematic"/> picks between Debug and Fm2.</summary>
        public SimFlightModelKind? Model;
        public bool? Kinematic;
        public Fm2AircraftConfig AircraftConfig;
        /// <summary>Present when this aircraft can be flown by an in-sim AI pilot.</summary>
        public AiPilotOptions PilotOptions;
        public double HitRadius;
        public double MaxHealth;
        public SimGunConfig Gun;
        /// <summary>Baked collider triangles (body frame); null means the hit sphere.</summary>
        public AircraftCollisionMesh Collision;
        public SimAircraftSpawn Spawn;
        public bool Enabled;
    }

    /// <summary>A confirmed hit this frame, for SFX / feedback on the render side.</summary>
    public sealed class SimHitEvent
    {
        /// <summary>World-space impact point (mesh surface or hit-sphere entry).</summary>
        public double[] Position;
        /// <summary>Target world velocity at impact (m/s).</summary>
        public double[] Velocity;
        public string TargetId;
        public double Damage;
        /// <summary>For a ground scrape: how fast the contact point was going into the surface (m/s).</summary>
        public double? ImpactSpeed;
        /// <summary>Crash-scale severity (0.2 .. 1.5) when the sim has already worked it out.</summary>
        public double? Severity;
        /// <summary>"gun" (also the meaning of null) or "scrape".</summary>
        public string Source;
        /// <summary>For a scrape: the airframe is sliding at this contact point.</summary>
        public bool? Slide;
    }
}

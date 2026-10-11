using System;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// One simulated aircraft: a sim flight model (FM2 or FM3) plus its command
    /// buffer, an optional in-sim AI pilot and gun (port of SimAircraft in
    /// physics/sim/combatSim.ts). A pilot can fly it, guns can hit it, and the
    /// sim-side player input writes it.
    /// </summary>
    public sealed class SimAircraft : IPilotableAircraft, ICombatant, ISimPlayerInputSink
    {
        public readonly string Id;
        private readonly Faction faction;
        public SimControlMode Control { get; set; }
        public bool Enabled;
        public SimFlightModelKind ModelKind;

        public FlightModel Model;
        public IAiPilotController Pilot;
        public Gun Gun;

        public double Health { get; set; }
        public double MaxHealth;
        public readonly double HitRadius;
        public AircraftCollisionMesh Collision;
        private bool afterburner;

        /// <summary>Firing decision resolved this frame (pilot solution or external trigger).</summary>
        public bool Firing;

        /// <summary>When set, this aircraft engages any live combatant of this faction (see CombatSim.SelectTargetFor).</summary>
        public Faction? TargetFaction;
        /// <summary>Id of the auto-selected target, so a re-scan can score the incumbent.</summary>
        public string AutoTargetId;
        /// <summary>Id handed to CombatSim.SetTarget, so a rebuilt pilot gets it back.</summary>
        public string ExplicitTargetId;
        /// <summary>Id handed to CombatSim.SetFormationLead, likewise.</summary>
        public string FormationLeadId;

        /// <summary>Seconds since last solid-world scrape FX.</summary>
        public double ScrapeFxCooldown;
        /// <summary>Seconds until the next burst of sparks and dust from a sliding belly.</summary>
        public double SlideFxCooldown;

        /// <summary>Latched arrestor cable index within the active field, or -1.</summary>
        public int ArrestorLatch = -1;
        /// <summary>Which arrestor field is latched (carrier index), or -1.</summary>
        public int ArrestorFieldIndex = -1;
        /// <summary>Deck-axis projection of the hook at snag time (for pull-out distance).</summary>
        public double ArrestorSnagAlong;
        /// <summary>True after pull-out finished; cable stays bent until the plane taxis away.</summary>
        public bool ArrestorHeld;
        /// <summary>Sticky: stay on-deck until gear up / leave carrier height / not landed.</summary>
        public bool CarrierDeckSticky;
        /// <summary>Ship-local XZ park offset valid while kinematically locked to the deck.</summary>
        public bool CarrierParkLocalValid;
        public double CarrierParkLocalX;
        public double CarrierParkLocalZ;
        /// <summary>Ship-local XZ offset for a wreck riding the moving deck.</summary>
        public bool CrashedCarrierLocalValid;
        public double CrashedCarrierLocalX;
        public double CrashedCarrierLocalZ;
        public Vec3d HookBody;
        public Vec3d PrevHook;
        public bool HasPrevHook;
        public Vec3d HookNow;
        /// <summary>Previous-step CG.</summary>
        public Vec3d PrevPos;
        public bool HasPrevPos;

        // Normalized command buffer, written by the pilot (ai) or the client (external).
        private double inPitch;
        private double inRoll;
        private double inYaw;
        private double inThrottle;
        private bool inGear = true;
        private bool inFlaps = true;
        private bool inAirbrakes;
        /// <summary>Tailhook lowered (player 'H'); AI pilots auto-hook with the gear.</summary>
        private bool inHook;
        private bool inBrakes;
        private FcsPitchLimiter inLimiterMode = FcsPitchLimiter.Soft;
        private bool inLimiters = true;
        private bool inForceVectors;
        private bool externalFiring;

        private AiPilotOptions pilotOptions;

        public SimAircraft(SimAircraftDesc desc, SceneWorldQuery world, IProjectileSink sink)
        {
            Id = desc.Id;
            faction = desc.Faction;
            Control = desc.Control;
            Enabled = desc.Enabled;
            ModelKind = SimFlightModel.ModelKindFromDesc(desc);
            HitRadius = desc.HitRadius;
            Collision = desc.Collision;
            MaxHealth = desc.MaxHealth;
            Health = desc.MaxHealth;
            afterburner = SimPlayerInput.Fm2UsesAfterburner(desc.AircraftConfig);
            double[] hook = desc.AircraftConfig?.Hook ?? ArrestorCables.DefaultArrestorHookBody;
            HookBody = new Vec3d(hook[0], hook[1], hook[2]);
            Model = SimFlightModel.Create(ModelKind, desc.AircraftConfig);
            BindWorld(world);
            if (desc.Gun != null)
            {
                var cfg = new GunConfig
                {
                    MuzzleVelocity = desc.Gun.MuzzleVelocity,
                    RoundsPerSecond = desc.Gun.RoundsPerSecond,
                    Damage = desc.Gun.Damage,
                    Ammo = desc.Gun.Ammo,
                    MuzzleOffset = new Vec3d(desc.Gun.MuzzleOffset[0], desc.Gun.MuzzleOffset[1], desc.Gun.MuzzleOffset[2]),
                    Spread = desc.Gun.Spread,
                };
                Gun = new Gun(cfg, sink, faction);
            }
            BuildPilot(desc.PilotOptions, world);
            ApplySpawn(desc.Spawn);
        }

        public Faction Faction => faction;

        /// <summary>Push terrain/obstacle query into the flight model.</summary>
        public void BindWorld(SceneWorldQuery world)
        {
            Model.SetWorldQuery(world);
        }

        public void BuildPilot(AiPilotOptions options, SceneWorldQuery world, bool forceRebuild = false)
        {
            pilotOptions = options ?? pilotOptions;
            if (pilotOptions == null || world == null)
            {
                return;
            }
            if (Pilot != null && !forceRebuild)
            {
                return;
            }
            AiFlightPhase? prevPhase = Pilot?.GetPhase();
            Pilot = AiPilotFactory.CreateAiPilot(this, world, pilotOptions);
            if (prevPhase.HasValue)
            {
                Pilot.SetPhase(prevPhase.Value);
            }
        }

        /// <summary>Replace pilot options and rebuild the controller (e.g. AI model switch on spawn).</summary>
        public void SetPilotOptions(AiPilotOptions options, SceneWorldQuery world)
        {
            BuildPilot(options, world, true);
        }

        public void ApplySpawn(SimAircraftSpawn spawn)
        {
            ArrestorLatch = -1;
            ArrestorFieldIndex = -1;
            ArrestorSnagAlong = 0;
            ArrestorHeld = false;
            CarrierDeckSticky = false;
            CarrierParkLocalValid = false;
            CrashedCarrierLocalValid = false;
            HasPrevHook = false;
            HasPrevPos = false;
            Model.Position = new Vec3d(spawn.Position[0], spawn.Position[1], spawn.Position[2]);
            Model.Quaternion = new Quatd(spawn.Quaternion[0], spawn.Quaternion[1], spawn.Quaternion[2], spawn.Quaternion[3]);
            if (spawn.Velocity != null)
            {
                Model.Velocity = new Vec3d(spawn.Velocity[0], spawn.Velocity[1], spawn.Velocity[2]);
            }
            inThrottle = spawn.Throttle;
            Model.SetThrottle(spawn.Throttle);
            Model.SetLanded(spawn.Landed);
            inGear = !spawn.Airborne;
            inFlaps = !spawn.Airborne;
            inAirbrakes = false;
            inHook = false;
            if (spawn.Airborne)
            {
                Model.SyncEffectiveThrottle();
                Model.SnapPhysicsState();
            }
        }

        public void Respawn(SimAircraftSpawn spawn)
        {
            Model.Reset();
            Health = MaxHealth;
            inPitch = inRoll = inYaw = 0;
            inBrakes = false;
            inAirbrakes = false;
            inHook = false;
            Gun?.Reset();
            ApplySpawn(spawn);
            Enabled = true;
        }

        public void ResetGun()
        {
            Gun?.Reset();
        }

        public void SetExternalInputs(SimControlInputs inputs)
        {
            inPitch = inputs.Pitch;
            inRoll = inputs.Roll;
            inYaw = inputs.Yaw;
            inThrottle = inputs.Throttle;
            inGear = inputs.LandingGearDeployed;
            inFlaps = inputs.FlapsExtended;
            inAirbrakes = inputs.AirbrakesExtended;
            inHook = inputs.HookDeployed;
            inBrakes = inputs.WheelBrakesApplied;
            inLimiterMode = inputs.PitchLimiterMode;
            inLimiters = inputs.LimitersEnabled;
            inForceVectors = inputs.WantForceVectors;
            externalFiring = inputs.Firing;
        }

        public void ApplyInputsToModel()
        {
            // Dead airframes: no thrust, no stick; the wreck coasts ballistically.
            if (Health <= 0)
            {
                inThrottle = 0;
                inPitch = 0;
                inRoll = 0;
                inYaw = 0;
            }
            Model.SetPitch(inPitch);
            Model.SetRoll(inRoll);
            Model.SetYaw(inYaw);
            Model.SetThrottle(inThrottle);
            if (Health <= 0)
            {
                Model.SyncEffectiveThrottle();
            }
            Model.SetLandingGearDeployed(inGear);
            Model.SetFlapsExtended(inFlaps);
            Model.SetAirbrakesExtended(inAirbrakes);
            Model.SetWheelBrakes(inBrakes);
            Model.SetPitchLimiterMode(inLimiterMode);
            Model.SetLimitersEnabled(inLimiters);
            Model.SetForceVectorsRequested(inForceVectors);
        }

        public void ResolveFiring()
        {
            if (Model.IsCrashed)
            {
                Firing = false;
                return;
            }
            Firing = Control == SimControlMode.Ai
                ? (Pilot?.IsFiring ?? false)
                : externalFiring;
        }

        // --- IAircraftControlChannel: the pilot writes the buffer -----------------

        public void SetPitch(double pitch) => inPitch = pitch;
        public void SetRoll(double roll) => inRoll = roll;
        public void SetYaw(double yaw) => inYaw = yaw;
        public void SetThrottle(double throttle) => inThrottle = throttle;
        public void SetWheelBrakes(bool applied) => inBrakes = applied;
        public void SetLandingGearDeployed(bool deployed) => inGear = deployed;
        public void SetFlapsExtended(bool extended) => inFlaps = extended;
        public void SetAirbrakesExtended(bool extended) => inAirbrakes = extended;

        // --- ISimPlayerInputSink (keyboard / gamepad) -----------------------------

        public bool IsOnGround() => Model.Position.Y <= SimConstants.PlaneDistanceToGround + 0.05;

        public double GetThrottle() => inThrottle;

        public bool GetAfterburner() => afterburner;

        public void ToggleGear() => inGear = !inGear;

        public void ToggleFlaps() => inFlaps = !inFlaps;

        public void ToggleAirbrakes() => inAirbrakes = !inAirbrakes;

        public void ToggleHook() => inHook = !inHook;

        public void SetHookDeployed(bool deployed) => inHook = deployed;

        public void ToggleAutopilot() => Control = Control == SimControlMode.Ai ? SimControlMode.External : SimControlMode.Ai;

        public void SetPitchLimiterMode(FcsPitchLimiter mode) => inLimiterMode = mode;

        public void SetAfterburnerFromConfig(Fm2AircraftConfig config) => afterburner = SimPlayerInput.Fm2UsesAfterburner(config);

        // --- IAircraftObservation --------------------------------------------------

        public Vec3d GetPosition() => Model.Position;
        public Vec3d GetVelocity() => Model.Velocity;
        public Quatd GetQuaternion() => Model.Quaternion;
        public double GetAirspeed() => Model.Velocity.Length;
        public double GetAltitude() => Model.Position.Y;
        public double GetAngleOfAttack() => Model.AngleOfAttack;
        public double GetLoadFactorG() => Model.LoadFactorG;
        public double GetStallStatus() => Model.GetStallStatus();
        public bool IsLanded() => Model.IsLanded;
        public bool IsCrashed() => Model.IsCrashed;
        public bool IsGearDeployed() => inGear;
        /// <summary>The roll input applied this step (+right), for drawing the surfaces.</summary>
        public double GetRollInput() => inRoll;
        public bool IsFlapsExtended() => inFlaps;
        public bool IsAirbrakesExtended() => inAirbrakes;
        /// <summary>AI pilots have no hook control of their own: theirs follows the gear.</summary>
        public bool IsHookDeployed() => Control == SimControlMode.Ai ? inGear : inHook;

        /// <summary>The input buffer as the HUD mirrors it, for aircraft without a sim-side input handler.</summary>
        public void ReadCommandMirror(SimInputMirror mirror, SimPlayerInput input)
        {
            mirror.Pitch = inPitch;
            mirror.Roll = inRoll;
            mirror.Yaw = inYaw;
            mirror.Throttle = inThrottle;
            mirror.PitchStickUnits = 0;
            mirror.WheelBrakes = inBrakes;
            mirror.LimitersEnabled = inLimiters;
            mirror.PitchLimiterMode = inLimiterMode;
            mirror.Autopilot = Control == SimControlMode.Ai;
            input?.ReadMirror(mirror, Control);
        }

        // --- ICombatant --------------------------------------------------------------

        public Vec3d ReadPosition() => Model.Position;
        public Vec3d ReadVelocity() => Model.Velocity;
        public double GetHitRadius() => HitRadius;
        public bool IsAlive() => Enabled && Health > 0 && !Model.IsCrashed;

        /// <summary>How far from its origin the airframe reaches: its collision mesh's box, else its hit sphere.</summary>
        public double CollisionReach()
        {
            ColliderAabb box = Collision?.Aabb;
            if (box != null)
            {
                return 0.5 * JsMath.Hypot(box.Max[0] - box.Min[0], box.Max[1] - box.Min[1], box.Max[2] - box.Min[2]) + 1;
            }
            return HitRadius;
        }

        public void ApplyDamage(double amount)
        {
            if (Health <= 0)
            {
                return;
            }
            Health -= amount;
            if (Health <= 0)
            {
                Health = 0;
                // Gun kill: flameout only; keep integrating so the wreck coasts.
                inThrottle = 0;
                Model.SetThrottle(0);
                Model.SyncEffectiveThrottle();
            }
        }
    }

    /// <summary>
    /// A combatant whose kinematic state is injected from outside the sim (e.g. the
    /// player flying a model elsewhere). AI pilots can target it, and projectiles
    /// can hit it, without it being simulated here.
    /// </summary>
    public sealed class ExternalCombatant : ICombatant
    {
        private Faction faction = Faction.PLAYER;
        private Vec3d pos;
        private Vec3d vel;
        private bool alive = true;
        public double HitRadius = 10;

        public Faction Faction => faction;

        public void SetState(Faction f, Vec3d position, Vec3d velocity, bool isAlive)
        {
            faction = f;
            pos = position;
            vel = velocity;
            alive = isAlive;
        }

        public void Rebase(FrameShift shift)
        {
            pos = shift.Point(pos);
            vel = shift.Vector(vel);
        }

        public Vec3d ReadPosition() => pos;
        public Vec3d ReadVelocity() => vel;
        public double GetHitRadius() => HitRadius;
        public bool IsAlive() => alive;
        public void ApplyDamage(double amount)
        {
            // Damage is owned by the external model.
        }
    }
}

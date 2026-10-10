using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>The pitch limiter strategies (keys 1/2/3). FM2 only acts on them.</summary>
    public enum FcsPitchLimiter
    {
        Soft = 1,
        Predictive = 2,
        Smooth = 3,
    }

    /// <summary>What the flight models need from the world: the highest solid ground at (x, z).</summary>
    public interface IGroundQuery
    {
        /// <summary>Scene Y of the highest solid surface; -Infinity where there is none.</summary>
        double GroundHeightAt(double x, double z);
    }

    public enum ForceVectorKind
    {
        Lift,
        Drag,
        Thrust,
        Weight,
    }

    /// <summary>A per-part force for the debug overlay; body frame (m, N).</summary>
    public struct ForceVectorSample
    {
        public string Part;
        public ForceVectorKind Kind;
        public Vec3d Origin;
        public Vec3d Vec;
    }

    /// <summary>
    /// Base class of the flight models (port of physics/model/flightModel.ts).
    ///
    /// The physics advances in fixed 1/120 s steps from Update(delta), with the
    /// remainder carried and the previous state kept for render interpolation.
    /// All state is double precision in scene axes (x east, y up, z south).
    /// </summary>
    public abstract class FlightModel
    {
        public const double SimFps = 120;
        public const double SimDelta = 1.0 / SimFps;

        private static readonly double[] EmptyGearCompression = Array.Empty<double>();

        protected Vec3d position;
        protected Quatd quaternion = Quatd.Identity;
        /// <summary>m/s, world.</summary>
        protected Vec3d velocity;

        protected bool crashed;
        private double pendingHardLanding;
        private double hardLandingCooldownS;
        protected bool landed = true;
        protected bool landingGearDeployed = true;
        protected bool flapsExtended = true;
        protected bool airbrakesExtended;
        protected bool wheelBrakesApplied;
        protected bool forebodyLaminar;
        protected FcsPitchLimiter pitchLimiterMode = FcsPitchLimiter.Soft;
        protected bool limitersEnabled = true;
        protected double elevatorCommandLimitHigh = 1;
        protected double elevatorCommandLimitLow = -1;

        protected double pitch;
        protected double roll;
        protected double yaw;
        protected double throttle;
        protected double effectiveThrottle;

        protected double angleOfAttackRad;
        protected double loadFactorG = 1;
        protected double engineThrustN;
        protected double commandedElevator;
        protected double commandedAileron;
        protected double commandedRudder;
        /// <summary>World-frame linear acceleration from the last step (m/s^2).</summary>
        protected Vec3d accelWorld;

        protected List<ForceVectorSample> forceVectors = new List<ForceVectorSample>();
        protected bool forceVectorsRequested;

        /// <summary>Scene position to height above the ellipsoid; identity on Y until the terrain wires in.</summary>
        private Func<double, double, double, double> altitudeAt = (x, y, z) => y;

        private Vec3d prevPosition;
        private Quatd prevQuaternion = Quatd.Identity;
        private Vec3d prevVelocity;
        private double deltaRemainder;

        public abstract void Step(double delta);

        /// <summary>[-1, 1]; values >= 0 mean stall.</summary>
        public abstract double GetStallStatus();

        public virtual void Activate()
        {
        }

        public virtual void Reset()
        {
            position = Vec3d.Zero;
            quaternion = Quatd.FromAxisAngle(SimConstants.Up, 0);
            velocity = Vec3d.Zero;
            crashed = false;
            landed = true;
            landingGearDeployed = true;
            flapsExtended = true;
            airbrakesExtended = false;
            wheelBrakesApplied = false;
            forebodyLaminar = false;
            pitchLimiterMode = FcsPitchLimiter.Soft;
            limitersEnabled = true;
            elevatorCommandLimitHigh = 1;
            elevatorCommandLimitLow = -1;
            pitch = 0;
            roll = 0;
            yaw = 0;
            throttle = 0;
            effectiveThrottle = 0;
            angleOfAttackRad = 0;
            loadFactorG = 1;
            engineThrustN = 0;
            commandedElevator = 0;
            commandedAileron = 0;
            commandedRudder = 0;
            accelWorld = Vec3d.Zero;
            deltaRemainder = 0;
            SyncPreviousState();
        }

        /// <summary>Align render interpolation after a teleport or airborne spawn.</summary>
        public virtual void SnapPhysicsState() => SyncPreviousState();

        /// <summary>Note a hard but survivable touchdown (0..1 toward destroyed); one per 2 s.</summary>
        protected void ReportHardLanding(double fraction)
        {
            if (hardLandingCooldownS > 0 || fraction <= 0) return;
            pendingHardLanding = Math.Max(pendingHardLanding, fraction);
            hardLandingCooldownS = 2;
        }

        public double ConsumeHardLanding()
        {
            double v = pendingHardLanding;
            pendingHardLanding = 0;
            return v;
        }

        public void Update(double delta)
        {
            deltaRemainder += delta;
            while (deltaRemainder >= SimDelta)
            {
                hardLandingCooldownS = Math.Max(0, hardLandingCooldownS - SimDelta);
                SavePreviousState();
                Step(SimDelta);
                deltaRemainder -= SimDelta;
            }
        }

        /// <summary>1 = latest physics state, 0 = previous.</summary>
        public double RenderInterpolationAlpha => 1 - deltaRemainder / SimDelta;

        public Vec3d RenderPosition => Vec3d.Lerp(prevPosition, position, RenderInterpolationAlpha);
        public Quatd RenderQuaternion => Quatd.Slerp(prevQuaternion, quaternion, RenderInterpolationAlpha);
        public Vec3d RenderVelocity => Vec3d.Lerp(prevVelocity, velocity, RenderInterpolationAlpha);

        /// <summary>Carry the state into a re-based scene frame; subclasses with world-frame state extend this.</summary>
        public virtual void Rebase(FrameShift shift)
        {
            position = shift.Point(position);
            quaternion = shift.Orientation(quaternion);
            velocity = shift.Vector(velocity);
            accelWorld = shift.Vector(accelWorld);
            prevPosition = shift.Point(prevPosition);
            prevQuaternion = shift.Orientation(prevQuaternion);
            prevVelocity = shift.Vector(prevVelocity);
        }

        private void SavePreviousState() => SyncPreviousState();

        private void SyncPreviousState()
        {
            prevPosition = position;
            prevQuaternion = quaternion;
            prevVelocity = velocity;
        }

        public virtual void SetPitch(double v) => pitch = v;
        public virtual void SetRoll(double v) => roll = v;
        public virtual void SetYaw(double v) => yaw = v;
        public virtual void SetThrottle(double v) => throttle = v;

        /// <summary>Match the spooled engine to the commanded throttle (airborne spawn).</summary>
        public virtual void SyncEffectiveThrottle() => effectiveThrottle = throttle;

        /// <summary>Select the aircraft; generic models ignore it.</summary>
        public virtual void SetAircraft(Fm2AircraftConfig config)
        {
        }

        public virtual void SetAltitudeAt(Func<double, double, double, double> fn) => altitudeAt = fn;

        /// <summary>Height above the ellipsoid of this aircraft: what the atmosphere sees.</summary>
        protected double AtmosphereAltitudeM => altitudeAt(position.X, position.Y, position.Z);

        public virtual void SetLandingGearDeployed(bool v) => landingGearDeployed = v;
        public virtual void SetFlapsExtended(bool v) => flapsExtended = v;
        public virtual void SetAirbrakesExtended(bool v) => airbrakesExtended = v;
        public virtual void SetWheelBrakes(bool v) => wheelBrakesApplied = v;
        public bool IsWheelBrakesApplied => wheelBrakesApplied;
        public virtual void SetForebodyLaminar(bool v) => forebodyLaminar = v;
        public bool IsForebodyLaminar => forebodyLaminar;
        public virtual void SetPitchLimiterMode(FcsPitchLimiter mode) => pitchLimiterMode = mode;
        public FcsPitchLimiter PitchLimiterMode => pitchLimiterMode;

        public double PilotPitch => pitch;
        public double PilotRoll => roll;
        public double PilotYaw => yaw;
        public double PilotThrottle => throttle;

        public virtual void SetLimitersEnabled(bool v) => limitersEnabled = v;
        public bool IsLimitersEnabled => limitersEnabled;
        public double ElevatorCommandLimitHigh => elevatorCommandLimitHigh;
        public double ElevatorCommandLimitLow => elevatorCommandLimitLow;

        public virtual void SetLanded(bool v) => landed = v;
        public bool IsLanded => landed;
        public virtual void SetCrashed(bool v) => crashed = v;
        public bool IsCrashed => crashed;

        public bool IsLandingGearDeployed => landingGearDeployed;
        public bool IsFlapsExtended => flapsExtended;
        public bool IsAirbrakesExtended => airbrakesExtended;

        public virtual Vec3d Position { get => position; set => position = value; }
        public virtual Quatd Quaternion { get => quaternion; set => quaternion = value; }
        public virtual Vec3d Velocity { get => velocity; set => velocity = value; }

        public double EffectiveThrottle => effectiveThrottle;
        public double AngleOfAttack => angleOfAttackRad;
        public double LoadFactorG => loadFactorG;

        /// <summary>FCS-commanded surface deflections in raw-stick polarity, for animation.</summary>
        public double CommandedElevator => commandedElevator;
        public double CommandedAileron => commandedAileron;
        public double CommandedRudder => commandedRudder;

        public Vec3d AccelerationWorld => accelWorld;

        /// <summary>An external impulse (N s, world, through the CG) and angular impulse (N m s, world). Rigid bodies only.</summary>
        public virtual void ApplyExternalWrench(Vec3d impulseWorld, Vec3d angularImpulseWorld)
        {
        }

        public double EngineThrustKn => engineThrustN / 1000;

        /// <summary>Per-leg oleo compression (m). Empty for models without gear legs.</summary>
        public virtual IReadOnlyList<double> GearCompression => EmptyGearCompression;

        public double GearCompressionMean
        {
            get
            {
                IReadOnlyList<double> c = GearCompression;
                if (c.Count == 0) return 0;
                double sum = 0;
                for (int i = 0; i < c.Count; i++) sum += c[i];
                return sum / c.Count;
            }
        }

        public void SetForceVectorsRequested(bool requested)
        {
            forceVectorsRequested = requested;
            if (!requested) forceVectors = new List<ForceVectorSample>();
        }

        public IReadOnlyList<ForceVectorSample> ForceVectors => forceVectors;

        public virtual bool UseAfterburnerThrottleDetents => false;

        public virtual double StepThrottleDetent(double current, int direction) => Math.Max(0, Math.Min(1, current + direction * 0.01));

        public virtual bool IsInThrottleAbDetentBand(double lever) => false;

        public virtual double AdjustThrottleInput(double current, double step) => Math.Max(0, Math.Min(1, current + step));

        public virtual string ThrottleHudText => "THR " + JsMath.Round(100 * effectiveThrottle).ToString(System.Globalization.CultureInfo.InvariantCulture);

        public virtual double ThrottleAudioLevel => effectiveThrottle;

        public virtual string EngineNozzleColor => "#0a0a0a";
    }
}

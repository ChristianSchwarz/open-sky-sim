using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>Optional per-model behaviour flags (orthogonal to the aircraft config).</summary>
    public sealed class Fm2ModelOptions
    {
        /// <summary>
        /// No-aerodynamics "free-fly" mode: stick rotates the airframe directly and
        /// speed follows the throttle. Handy for inspecting scenery/models without the
        /// rigid-body aerodynamics fighting the camera (the old DEBUG flight model).
        /// </summary>
        public bool? Kinematic;
    }

    /// <summary>
    /// FM2: rigid-body "parts" flight model (port of physics/model/fm2FlightModel.ts).
    ///
    /// Unlike the kinematic Realistic model, FM2 is a genuine 6-DOF rigid body. Every
    /// aerodynamic force is produced by a discrete lifting surface at its real
    /// location, so all moments, and the pitch/roll/yaw rate damping, emerge from the
    /// geometry. A fly-by-wire layer closes rate/g loops around the airframe. Landing
    /// gear is modelled as spring-damper contact points, so weight-on-wheels, takeoff
    /// rotation and ground stability are also just rigid-body reactions.
    /// </summary>
    public class Fm2FlightModel : FlightModel
    {
        private const double Gravity = 9.80665;

        private const double ThrottleUpRate = 0.10;
        private const double ThrottleDownRate = 0.07;

        /// <summary>
        /// Half-extent (m) of the XZ samples around each gear point. A single point
        /// under the axle lets the tyre dig into rising terrain by ~radius x slope;
        /// taking the max height in this footprint keeps the whole wheel above the deck.
        /// </summary>
        private const double GearContactFootprintM = 0.45;
        /// <summary>Finite-difference half-step (m) for heightfield surface normals.</summary>
        private const double GroundNormalEpsM = 0.5;

        private struct SurfaceControls
        {
            public double WingLeftAoa;
            public double WingRightAoa;
            public double HtailLeftAoa;
            public double HtailRightAoa;
            public double VtailAoa;
            public double AileronLeftAoa;
            public double AileronRightAoa;
        }

        private readonly Fm2AircraftConfig config;
        private readonly bool kinematic;

        private readonly RigidBody rb;
        private readonly Fm2Fcs fcs;

        private readonly AeroSurface fuselage;
        private readonly AeroSurface wingLeft;
        private readonly AeroSurface wingRight;
        private readonly AeroSurface htailLeft;
        private readonly AeroSurface htailRight;
        private readonly AeroSurface vtail;
        /// <summary>Optional dedicated aileron surfaces (present when the config supplies them).</summary>
        private readonly AeroSurface aileronLeft;
        private readonly AeroSurface aileronRight;
        /// <summary>
        /// Optional forward strake/LERX surface: the real, fixed-arm source of the
        /// post-stall nose-up moment (replaces the old scripted CG relocation).
        /// </summary>
        private readonly AeroSurface foreStrake;
        /// <summary>All lifting surfaces in build order; the step and the force-vector snapshot both iterate it.</summary>
        private readonly AeroSurface[] allSurfaces;

        /// <summary>Current integration timestep (s), published to the surfaces for their separation-state lag.</summary>
        private double currentStepDt = 1.0 / 120;

        /// <summary>Reference dynamic pressure at the design cruise condition (Pa).</summary>
        private readonly double qRef;

        private double stall = -1;

        /// <summary>Per-leg oleo compression from the last gear-force step (m).</summary>
        private readonly double[] gearCompression;
        /// <summary>Sink rate (m/s) as the step's contacts began, before the ground clamps zero it.</summary>
        private double stepSinkMps;

        /// <summary>Body Y when level on flat ground (deepest gear contact at world y = 0).</summary>
        private double GroundRestY => Fm2AircraftConfig.GroundRestHeight(config);

        private double MaxGearStrokeM => config.Gear.MaxStrokeM ?? 0.35;

        /// <summary>Terrain / obstacle query from the combat worker (optional).</summary>
        private IGroundQuery world;

        // State carried between the step's helpers (the TS keeps these as scratch vectors).
        private Vec3d velBody;
        private Vec3d forceBody;
        private Vec3d momentBody;
        private Vec3d gearForceWorld;
        private Vec3d gearMomentBody;
        private Quatd invOrient = Quatd.Identity;
        /// <summary>Last forebody asymmetry side force (body frame, N); for the debug overlay.</summary>
        private Vec3d forebodyForceBody;

        public Fm2FlightModel(Fm2AircraftConfig config = null, Fm2ModelOptions options = null)
        {
            config ??= Fm2Defaults.Default();
            this.config = config;
            kinematic = options?.Kinematic ?? false;
            rb = new RigidBody(config.Geometry.MassKg, new InertiaDiagonal(
                config.Inertia.Pitch,
                config.Inertia.Yaw,
                config.Inertia.Roll));
            fcs = new Fm2Fcs(config.Fcs);
            fuselage = new AeroSurface(config.Surfaces.Fuselage);
            wingLeft = new AeroSurface(config.Surfaces.WingLeft);
            wingRight = new AeroSurface(config.Surfaces.WingRight);
            htailLeft = new AeroSurface(config.Surfaces.HtailLeft);
            htailRight = new AeroSurface(config.Surfaces.HtailRight);
            vtail = new AeroSurface(config.Surfaces.Vtail);
            if (config.Surfaces.AileronLeft != null)
            {
                aileronLeft = new AeroSurface(config.Surfaces.AileronLeft);
            }
            if (config.Surfaces.AileronRight != null)
            {
                aileronRight = new AeroSurface(config.Surfaces.AileronRight);
            }
            if (config.Surfaces.ForeStrake != null)
            {
                foreStrake = new AeroSurface(config.Surfaces.ForeStrake);
            }
            var surfaces = new List<AeroSurface> { fuselage, wingLeft, wingRight, htailLeft, htailRight, vtail };
            if (aileronLeft != null) surfaces.Add(aileronLeft);
            if (aileronRight != null) surfaces.Add(aileronRight);
            if (foreStrake != null) surfaces.Add(foreStrake);
            allSurfaces = surfaces.ToArray();
            qRef = 0.5 * AeroUtils.IsaAirDensity(config.Envelope.CruiseAltitudeM)
                * Math.Pow(config.Envelope.CruiseSpeedMps, 2);
            gearCompression = new double[config.Gear.Points.Length];
        }

        /// <summary>Terrain height + obstacles for gear contact (flat Y = 0 when unset).</summary>
        public void SetWorldQuery(IGroundQuery world)
        {
            this.world = world;
        }

        /// <summary>Solid ground Y under a world XZ (hills + flat datum).</summary>
        private double GroundHeightAt(double x, double z)
        {
            return world == null ? 0 : world.GroundHeightAt(x, z);
        }

        /// <summary>
        /// Highest solid ground under a gear tyre footprint (centre + footprint on X/Z).
        /// Flat ground unchanged; on ramps/hills the uphill side of the tyre sets the contact.
        /// </summary>
        private double GroundHeightUnderGear(double x, double z)
        {
            const double r = GearContactFootprintM;
            return Math.Max(Math.Max(Math.Max(Math.Max(
                GroundHeightAt(x, z),
                GroundHeightAt(x + r, z)),
                GroundHeightAt(x - r, z)),
                GroundHeightAt(x, z + r)),
                GroundHeightAt(x, z - r));
        }

        public override void Reset()
        {
            base.Reset();
            rb.Reset();
            fcs.Reset();
            stall = -1;
            for (int i = 0; i < gearCompression.Length; i++)
            {
                gearCompression[i] = 0;
            }
            foreach (AeroSurface s in allSurfaces)
            {
                s.ResetState();
            }
        }

        public override void Rebase(FrameShift shift)
        {
            base.Rebase(shift);
            rb.Orientation = quaternion;
            rb.VelocityWorld = velocity;
        }

        /// <summary>Keep the rigid body in sync after external teleports / solid-world pushes.</summary>
        public override void SnapPhysicsState()
        {
            base.SnapPhysicsState();
            rb.Orientation = quaternion;
            rb.VelocityWorld = velocity;
        }

        /// <summary>Zero body rates (kinematic deck park).</summary>
        public void ClearAngularVelocity()
        {
            rb.AngularVelocityBody = Vec3d.Zero;
        }

        public double MassKg => rb.Mass;

        /// <summary>World velocity of the airframe at a world point (m/s).</summary>
        public Vec3d PointVelocity(Vec3d pointWorld)
        {
            Vec3d r = pointWorld - position;
            Vec3d omegaWorld = rb.AngularVelocityBody.Rotate(quaternion);
            return Vec3d.Cross(omegaWorld, r) + velocity;
        }

        /// <summary>Inverse effective mass of the body at a world point along a world direction (1/kg).</summary>
        public double InvEffectiveMass(Vec3d pointWorld, Vec3d dirWorld)
        {
            Vec3d r = pointWorld - position;
            // r x d in the body frame, through the (diagonal) inertia.
            invOrient = quaternion.Conjugate();
            Vec3d v = Vec3d.Cross(r, dirWorld).Rotate(invOrient);
            InertiaDiagonal I = rb.Inertia;
            return 1 / rb.Mass + v.X * v.X / I.X + v.Y * v.Y / I.Y + v.Z * v.Z / I.Z;
        }

        /// <summary>
        /// Inward speed of the body at pointWorld along normalWorld (m/s). Zero when
        /// the contact is separating or sliding purely tangentially.
        /// </summary>
        public double ContactSpeedIntoNormal(Vec3d pointWorld, Vec3d normalWorld)
        {
            rb.Orientation = quaternion;
            rb.VelocityWorld = velocity;
            Vec3d r = pointWorld - position;
            Vec3d omegaWorld = rb.AngularVelocityBody.Rotate(rb.Orientation);
            Vec3d contactVel = Vec3d.Cross(omegaWorld, r) + rb.VelocityWorld;
            double vn = Vec3d.Dot(contactVel, normalWorld);
            return vn < 0 ? -vn : 0;
        }

        /// <summary>
        /// Mild drag at a world contact point while scraping a solid. Bleeds a fraction
        /// of the contact-point velocity into an impulse at that point (linear +
        /// angular): no bounce, no whole-body speed dump.
        /// </summary>
        public void ApplyContactDragAt(Vec3d pointWorld, double dt, double dragPerSec, double massFraction, double maxFrac)
        {
            if (kinematic || dt <= 0) return;

            rb.Orientation = quaternion;
            rb.VelocityWorld = velocity;
            invOrient = rb.Orientation.Conjugate();

            Vec3d r = pointWorld - position;
            Vec3d omegaWorld = rb.AngularVelocityBody.Rotate(rb.Orientation);
            Vec3d contactVel = Vec3d.Cross(omegaWorld, r) + rb.VelocityWorld;

            double speed = contactVel.Length;
            if (speed < 1e-3)
            {
                velocity = rb.VelocityWorld;
                return;
            }

            double frac = 1 - Math.Exp(-dragPerSec * dt);
            if (frac > maxFrac) frac = maxFrac;
            // Impulse opposing contact velocity; scaled so a tip scrape does not act like full-mass braking.
            double jScale = -frac * rb.Mass * massFraction;
            Vec3d friction = contactVel * jScale;

            rb.VelocityWorld = rb.VelocityWorld.AddScaled(friction, 1 / rb.Mass);
            Vec3d v = Vec3d.Cross(r, friction).Rotate(invOrient);
            InertiaDiagonal I = rb.Inertia;
            Vec3d w = rb.AngularVelocityBody;
            w.X += v.X / I.X;
            w.Y += v.Y / I.Y;
            w.Z += v.Z / I.Z;
            rb.AngularVelocityBody = w;

            velocity = rb.VelocityWorld;
            quaternion = rb.Orientation;
        }

        /// <summary>
        /// Take a wrench from something that has hold of the airframe. The linear
        /// impulse goes straight into world velocity, the angular impulse into the
        /// body rates through the inertia; impulses rather than forces keep both
        /// independent of the caller's step length.
        /// </summary>
        public override void ApplyExternalWrench(Vec3d impulseWorld, Vec3d angularImpulseWorld)
        {
            if (kinematic) return;
            bool linear = impulseWorld.LengthSquared > 1e-12;
            bool angular = angularImpulseWorld.LengthSquared > 1e-12;
            if (!linear && !angular) return;

            rb.Orientation = quaternion;
            rb.VelocityWorld = velocity;
            invOrient = rb.Orientation.Conjugate();

            if (linear)
            {
                rb.VelocityWorld = rb.VelocityWorld.AddScaled(impulseWorld, 1 / rb.Mass);
                velocity = rb.VelocityWorld;
            }
            if (angular)
            {
                Vec3d v = angularImpulseWorld.Rotate(invOrient);
                InertiaDiagonal I = rb.Inertia;
                Vec3d w = rb.AngularVelocityBody;
                w.X += v.X / I.X;
                w.Y += v.Y / I.Y;
                w.Z += v.Z / I.Z;
                rb.AngularVelocityBody = w;
            }
        }

        public override void Step(double delta)
        {
            if (crashed) return;

            if (kinematic)
            {
                StepKinematic(delta);
                return;
            }

            SpoolThrottle(delta);
            // Publish the timestep for the surfaces' unsteady separation-state lag.
            currentStepDt = delta;

            // Adopt any externally set orientation / velocity as the rigid-body state.
            rb.Orientation = quaternion;
            rb.VelocityWorld = velocity;

            // Height above the ellipsoid, not scene Y: away from the play area's origin
            // the two differ by up to ~1.8 km, and feeding raw Y to the ISA model would
            // fly the aircraft through air a fifth too dense out there.
            double altitude = AtmosphereAltitudeM;
            double airDensity = AeroUtils.AirDensity(altitude);

            // Body-frame velocity through the air.
            invOrient = rb.Orientation.Conjugate();
            velBody = rb.VelocityWorld.Rotate(invOrient);
            double speed = velBody.Length;

            // Aircraft angle of attack (in the body X-plane) and sideslip.
            double aoa = ComputeBodyAoa(speed);
            angleOfAttackRad = aoa;

            double dynamicPressure = AeroUtils.DynamicPressure(airDensity, speed);
            double mach = AeroUtils.MachNumber(speed, altitude);

            // Fly-by-wire: stick/pedals + state to surface commands.
            FcsOutput fcsOut = fcs.Update(new FcsInput
            {
                PitchStick = pitch,
                RollStick = roll,
                // Negated so positive pedal yaws the nose the same way as the other
                // flight models (right pedal -> nose right); only the pilot command is
                // flipped, the yaw-damper/ARI feedback keeps its stabilising sign.
                YawPedal = -yaw,
                PitchRate = rb.AngularVelocityBody.X,
                YawRate = rb.AngularVelocityBody.Y,
                RollRate = rb.AngularVelocityBody.Z,
                LoadFactorG = loadFactorG,
                AoaRad = aoa,
                DynamicPressure = dynamicPressure,
                QRef = qRef,
                Speed = speed,
                AltitudeM = altitude,
                FlapsExtended = flapsExtended,
                Landed = landed,
                PitchLimiterMode = pitchLimiterMode,
                LimitersEnabled = limitersEnabled,
            }, delta);

            SurfaceControls controls = MapControls(fcsOut.Elevator, fcsOut.Aileron, fcsOut.Rudder);

            // Publish the FCS-commanded deflections in the SAME polarity as the raw
            // pilot stick they replace: the elevator g-command already uses +cmd = nose
            // up; aileron/rudder are commanded with the opposite internal sign (and the
            // pilot yaw is negated on the way in), so both are negated here.
            commandedElevator = fcsOut.Elevator;
            commandedAileron = -fcsOut.Aileron;
            commandedRudder = -fcsOut.Rudder;
            elevatorCommandLimitHigh = fcsOut.ElevatorLimitHi;
            elevatorCommandLimitLow = fcsOut.ElevatorLimitLo;

            // ---- Aerodynamic force & moment build-up from the rigid parts. ----
            forceBody = Vec3d.Zero;
            momentBody = Vec3d.Zero;

            Fm2FlapsConfig flaps = config.Flaps;
            double camber = flapsExtended ? flaps.AoaBiasRad : 0;
            double stallShift = flapsExtended ? flaps.StallReductionRad : 0;
            double wingExtraCd = flapsExtended ? flaps.ExtraCd : 0;

            // Blended lifting body at the CG (no flaps, no control incidence).
            AccumulateSurface(fuselage, 0, 0, 0, 0, airDensity);
            AccumulateSurface(wingLeft, controls.WingLeftAoa, camber, stallShift, wingExtraCd, airDensity);
            AccumulateSurface(wingRight, controls.WingRightAoa, camber, stallShift, wingExtraCd, airDensity);
            AccumulateSurface(htailLeft, controls.HtailLeftAoa, 0, 0, 0, airDensity);
            AccumulateSurface(htailRight, controls.HtailRightAoa, 0, 0, 0, airDensity);
            AccumulateSurface(vtail, controls.VtailAoa, 0, 0, 0, airDensity);
            if (aileronLeft != null)
            {
                AccumulateSurface(aileronLeft, controls.AileronLeftAoa, 0, 0, 0, airDensity);
            }
            if (aileronRight != null)
            {
                AccumulateSurface(aileronRight, controls.AileronRightAoa, 0, 0, 0, airDensity);
            }
            if (foreStrake != null)
            {
                // Real forward strake/LERX: no flaps, no control incidence. Its own lift
                // curve (vortex lift + unsteady lag) through its fixed arm ahead of the CG
                // is the genuine post-stall pitch-up source.
                AccumulateSurface(foreStrake, 0, 0, 0, 0, airDensity);
            }

            // Forebody vortex asymmetry (Ericsson nose slice): only in the subscale /
            // laminar Reynolds regime; at full scale it contributes nothing.
            ApplyForebodyAsymmetry(aoa, dynamicPressure, speed);

            // Fuselage / parasite / gear / wave drag along the relative wind.
            AddBodyDrag(dynamicPressure, speed, mach);

            // Thrust along the nose (+Z body).
            double thrustN = ComputeThrustN(effectiveThrottle, altitude);
            engineThrustN = thrustN;
            forceBody.Z += thrustN;

            // Landing-gear reactions (computed in world, moment folded into body frame).
            ComputeGearForces();

            // Load factor: specific normal (body-up) force / g, incl. gear reaction.
            double gearBodyUpY = gearForceWorld.Rotate(invOrient).Y;
            loadFactorG = (forceBody.Y + gearBodyUpY) / (config.Geometry.MassKg * Gravity);

            // Transonic pitch-damping augmentation (added Cmq): only ramps in above the
            // configured qNorm knee, so only transonic overspeed gets the extra damping.
            ApplyTransonicPitchDamp(dynamicPressure, rb.AngularVelocityBody.X);

            // ---- Integrate rotational dynamics (body frame). ----
            momentBody = momentBody + gearMomentBody;
            rb.IntegrateAngular(momentBody, delta);

            // ---- Integrate translational dynamics (world frame). ----
            Vec3d forceWorld = forceBody.Rotate(rb.Orientation);
            forceWorld = forceWorld + gearForceWorld;
            forceWorld.Y -= config.Geometry.MassKg * Gravity; // gravity
            accelWorld = forceWorld / config.Geometry.MassKg;
            rb.IntegrateLinear(forceWorld, delta, ref position);

            // Publish rigid-body state back to the base model.
            quaternion = rb.Orientation;
            velocity = rb.VelocityWorld;
            // How fast it was sinking as it met the ground, before the contact clamps take it out.
            stepSinkMps = Math.Max(0, -velocity.Y);
            // Soft springs alone tunnel on rising terrain; clamp contacts to the heightfield.
            ResolveGearTerrainPenetration();
            ClampParkedGroundSpeed();

            UpdateStallState(speed, aoa, altitude);
            HandleGroundState();
        }

        private void SpoolThrottle(double delta)
        {
            if (effectiveThrottle > throttle)
            {
                effectiveThrottle = Math.Max(throttle, effectiveThrottle - ThrottleDownRate * delta);
            }
            else if (effectiveThrottle < throttle)
            {
                effectiveThrottle = Math.Min(throttle, effectiveThrottle + ThrottleUpRate * delta);
            }
        }

        private SurfaceControls MapControls(double elevator, double aileron, double rudder)
        {
            double maxStabilator = config.Fcs.MaxStabilatorRad;
            double maxAileron = config.AileronMaxDeflectionRad;
            double maxRudder = config.Fcs.MaxRudderRad;
            // Elevator: +cmd = nose up -> negative stabilator incidence (tail lift down).
            // A single real hardware deflection limit applies at every speed/AoA.
            double elevatorAoa = -elevator * maxStabilator;
            // Differential tail (taileron) assists roll.
            double taileronAoa = aileron * config.Fcs.TaileronRollFraction * maxStabilator;
            // Roll incidence goes to the dedicated aileron surfaces when present; only an
            // airframe without them falls back to deflecting the whole wing (legacy).
            double aileronAoa = aileron * maxAileron;
            bool hasAilerons = aileronLeft != null || aileronRight != null;
            return new SurfaceControls
            {
                WingLeftAoa = hasAilerons ? 0 : aileronAoa,
                WingRightAoa = hasAilerons ? 0 : -aileronAoa,
                HtailLeftAoa = elevatorAoa + taileronAoa,
                HtailRightAoa = elevatorAoa - taileronAoa,
                VtailAoa = -rudder * maxRudder,
                AileronLeftAoa = hasAilerons ? aileronAoa : 0,
                AileronRightAoa = hasAilerons ? -aileronAoa : 0,
            };
        }

        /// <summary>Delivered thrust (N) at altitude for the configured engine.</summary>
        private double ComputeThrustN(double lever, double altitude)
        {
            Fm2EngineConfig e = config.Engine;
            if (e.Afterburner)
            {
                // Afterburner F100-class quadrant + lapse for the default aircraft.
                return F16Engine.ThrustN(lever, altitude);
            }
            // Plain idle-to-military schedule with the same ISA density lapse.
            double slKn = e.IdleThrustKn + (e.MilThrustKn - e.IdleThrustKn) * JsMath.Clamp(lever, 0, 1);
            double rho = AeroUtils.AirDensity(altitude);
            return slKn * 1000 * AeroUtils.ThrustDensityFactor(rho, altitude);
        }

        private void AccumulateSurface(AeroSurface surface, double controlAoa, double camber,
            double stallShift, double extraCd, double airDensity)
        {
            var input = new SurfaceInput
            {
                VelocityBody = velBody,
                AngularVelocityBody = rb.AngularVelocityBody,
                AirDensity = airDensity,
                ControlDeltaAoaRad = controlAoa,
                CamberBiasRad = camber,
                StallShiftRad = stallShift,
                ExtraCd = extraCd,
                Dt = currentStepDt,
            };
            surface.Accumulate(input, ref forceBody, ref momentBody);
        }

        /// <summary>
        /// Forebody vortex asymmetry, the high-alpha "nose slice" (Ericsson,
        /// ICAS-92-4.6R). Above the onset AoA a slender forebody sheds an asymmetric
        /// vortex pair whose side force, on the long nose arm, makes a large yawing
        /// moment; the direction locks in with the vehicle's own coning motion, so it
        /// is self-reinforcing. That coupling only develops in laminar / subscale flow,
        /// so it is applied ONLY in that regime; at full scale (default) it is a no-op.
        /// </summary>
        private void ApplyForebodyAsymmetry(double aoa, double dynamicPressure, double speed)
        {
            forebodyForceBody = Vec3d.Zero;
            Fm2ForebodyAsymmetryConfig cfg = config.ForebodyAsymmetry;
            if (cfg == null || !forebodyLaminar) return;

            double cy = ForebodyAsymmetry.Cy(
                aoa,
                rb.AngularVelocityBody.Y, // yaw rate about +Y (the coning motion)
                rb.AngularVelocityBody.X, // pitch rate about +X (nose-AoA shift)
                speed, cfg);
            if (cy == 0) return;

            // Side force along body +X, applied at the nose (0, 0, armZ) relative to the
            // (fixed) CG, giving a pure yawing moment about +Y.
            double fx = dynamicPressure * cfg.RefAreaM2 * cy;
            forebodyForceBody = new Vec3d(fx, 0, 0);
            forceBody.X += fx;
            momentBody.Y += cfg.ArmZ * fx;
        }

        /// <summary>
        /// Transonic pitch-damping augmentation (an added aerodynamic Cmq term). As q
        /// climbs into transonic overspeed the FCS's fixed lags erode the short-period
        /// phase margin; this adds a pitch-rate damping moment scaling with q S c that
        /// ramps in only above the qNorm knee, leaving the maneuvering envelope
        /// unchanged. pitchRate about +X is nose-down-positive, so the moment opposes
        /// the rate regardless of sign.
        /// </summary>
        private void ApplyTransonicPitchDamp(double dynamicPressure, double pitchRate)
        {
            Fm2TransonicPitchDampConfig cfg = config.TransonicPitchDamp;
            if (cfg == null) return;
            double qNorm = dynamicPressure / Math.Max(qRef, 1);
            if (qNorm <= cfg.QKnee) return;
            double ramp = JsMath.Clamp(qNorm / cfg.QKnee - 1, 0, cfg.MaxRamp ?? 2);
            Fm2GeometryConfig g = config.Geometry;
            momentBody.X -= cfg.Gain * dynamicPressure * g.WingAreaM2 * g.MeanChordM * pitchRate * ramp;
        }

        /// <summary>
        /// No-aerodynamics free-fly step (kinematic / DEBUG mode). Stick rotates the
        /// airframe directly, speed follows the throttle, with simple ground and
        /// altitude clamps.
        /// </summary>
        private void StepKinematic(double delta)
        {
            effectiveThrottle = throttle;
            engineThrustN = 0;

            // No FCS in free-fly mode: drive the visible surfaces straight from the raw
            // stick (already in the exposed display polarity) so they still animate.
            commandedElevator = pitch;
            commandedAileron = roll;
            commandedRudder = yaw;
            elevatorCommandLimitHigh = 1;
            elevatorCommandLimitLow = -1;

            if (!SimConstants.IsZero(roll)) quaternion = Fm2Math.RotateOnAxis(quaternion, Vec3d.UnitZ, roll * SimConstants.RollRate * delta);
            if (!SimConstants.IsZero(pitch)) quaternion = Fm2Math.RotateOnAxis(quaternion, Vec3d.UnitX, -pitch * SimConstants.PitchRate * delta);
            if (!SimConstants.IsZero(yaw)) quaternion = Fm2Math.RotateOnAxis(quaternion, Vec3d.UnitY, -yaw * SimConstants.YawRate * delta);

            // Automatic yaw into the turn when rolling (coordinated look-around feel).
            Vec3d forward = Fm2Math.GetWorldDirection(quaternion);
            if (-0.99 < forward.Y && forward.Y < 0.99)
            {
                Vec3d prjForward = forward;
                prjForward.Y = 0;
                Vec3d up = SimConstants.Up.Rotate(quaternion);
                Vec3d prjUp = Fm2Math.ProjectOnPlane(up, prjForward);
                prjUp.Y = 0;
                double sign = (prjForward.X * prjUp.Z - prjForward.Z * prjUp.X) > 0 ? -1 : 1;
                quaternion = Fm2Math.RotateOnWorldAxis(quaternion, SimConstants.Up,
                    sign * prjUp.Length * prjUp.Length * prjForward.Length * 2.0 * SimConstants.YawRate * delta);
            }

            double speed = effectiveThrottle * SimConstants.MaxSpeed;
            position = Fm2Math.TranslateOnAxis(position, quaternion, Vec3d.UnitZ, speed * delta);

            if (position.Y < SimConstants.PlaneDistanceToGround)
            {
                position.Y = SimConstants.PlaneDistanceToGround;
                Vec3d d = Fm2Math.GetWorldDirection(quaternion);
                if (d.Y < 0.0)
                {
                    d.Y = 0;
                    d = d + position;
                    quaternion = Fm2Math.LookAt(position, d, SimConstants.Up);
                }
            }
            if (position.Y > SimConstants.MaxAltitude) position.Y = SimConstants.MaxAltitude;

            Vec3d prevVel = velocity;
            velocity = SimConstants.Forward.Rotate(quaternion) * speed;
            if (delta > 0)
            {
                accelWorld = (velocity - prevVel) / delta;
            }
            else
            {
                accelWorld = Vec3d.Zero;
            }

            landed = position.Y <= SimConstants.PlaneDistanceToGround;
            stall = -1;
        }

        /// <summary>Parasite (fuselage + gear) and transonic wave drag along the relative wind.</summary>
        private void AddBodyDrag(double dynamicPressure, double speed, double mach)
        {
            if (speed < 1e-3) return;
            Fm2WaveDragConfig waveDrag = config.WaveDrag;
            double cd0 = config.BodyCd0
                + (landingGearDeployed ? config.GearCd : 0)
                + (airbrakesExtended ? config.AirbrakeCd : 0);
            if (mach > waveDrag.MachOnset)
            {
                double excess = (mach - waveDrag.MachOnset) / waveDrag.MachOnset;
                cd0 += waveDrag.Scale * excess * excess;
            }
            double dragN = dynamicPressure * config.Geometry.WingAreaM2 * cd0;
            // Opposes body velocity (acts through CG, no moment).
            forceBody = forceBody + velBody * (-dragN / speed);
        }

        /// <summary>
        /// Upward unit normal of the solid heightfield at (x, z). Flat ground gives +Y;
        /// ramps/hills tilt so gear spring/friction act along the local surface.
        /// </summary>
        private Vec3d SampleGroundNormal(double x, double z)
        {
            const double e = GroundNormalEpsM;
            double hL = GroundHeightAt(x - e, z);
            double hR = GroundHeightAt(x + e, z);
            double hD = GroundHeightAt(x, z - e);
            double hU = GroundHeightAt(x, z + e);
            return new Vec3d(-(hR - hL) / (2 * e), 1, -(hU - hD) / (2 * e)).Normalized();
        }

        /// <summary>Spring-damper landing gear. Accumulates world force and body moment.</summary>
        private void ComputeGearForces()
        {
            gearForceWorld = Vec3d.Zero;
            gearMomentBody = Vec3d.Zero;
            for (int i = 0; i < gearCompression.Length; i++)
            {
                gearCompression[i] = 0;
            }

            if (!landingGearDeployed) return;

            Vec3d omegaWorld = rb.AngularVelocityBody.Rotate(rb.Orientation);

            Fm2GearConfig gear = config.Gear;
            double maxStroke = MaxGearStrokeM;
            for (int i = 0; i < gear.Points.Length; i++)
            {
                double[] gp = gear.Points[i];
                Vec3d v = new Vec3d(gp[0], gp[1], gp[2]).Rotate(rb.Orientation);
                Vec3d gearWorld = v + position;
                double groundY = GroundHeightUnderGear(gearWorld.X, gearWorld.Z);
                double penetration = groundY - gearWorld.Y;
                if (penetration <= 0) continue;

                double compression = penetration < maxStroke ? penetration : maxStroke;
                gearCompression[i] = compression;

                Vec3d groundNormal = SampleGroundNormal(gearWorld.X, gearWorld.Z);

                // Velocity of the contact point through the world.
                Vec3d contactVel = Vec3d.Cross(omegaWorld, v) + rb.VelocityWorld;
                double vIntoSurface = Vec3d.Dot(contactVel, groundNormal);

                // Spring-damper along the local heightfield normal (not always +Y).
                double normalMag = gear.Stiffness * penetration - gear.Damping * vIntoSurface;
                if (normalMag < 0) normalMag = 0;

                Vec3d friction = groundNormal * normalMag;

                // Friction in the tangent plane, opposing sliding along the surface.
                Vec3d vTan = contactVel.AddScaled(groundNormal, -vIntoSurface);
                double vh = vTan.Length;
                if (vh > 1e-3)
                {
                    double rolling = wheelBrakesApplied ? gear.BrakeFriction : gear.RollFriction;
                    double mu = Math.Max(rolling, gear.SideFriction * SideSlipFraction(vTan.X, vTan.Z));
                    friction = friction.AddScaled(vTan, -(mu * normalMag) / vh);
                }

                gearForceWorld = gearForceWorld + friction;

                // Moment about CG: r_world x F_world, expressed in the body frame.
                gearMomentBody = gearMomentBody + Vec3d.Cross(v, friction).Rotate(invOrient);
            }
        }

        /// <summary>
        /// Lift the body so no gear contact tunnels deeper than the oleo stroke below the
        /// local heightfield. Correction is vertical: the solid constraint is
        /// y >= groundHeightAt(x, z).
        /// </summary>
        private void ResolveGearTerrainPenetration()
        {
            if (!landingGearDeployed) return;

            Fm2GearConfig gear = config.Gear;
            double maxStroke = MaxGearStrokeM;
            double maxPen = 0;
            foreach (double[] gp in gear.Points)
            {
                Vec3d v = new Vec3d(gp[0], gp[1], gp[2]).Rotate(rb.Orientation);
                Vec3d gearWorld = v + position;
                double pen = GroundHeightUnderGear(gearWorld.X, gearWorld.Z) - gearWorld.Y;
                if (pen > maxPen) maxPen = pen;
            }
            double excess = maxPen - maxStroke;
            if (excess <= 0) return;

            position.Y += excess;
            if (velocity.Y < 0)
            {
                velocity.Y = 0;
                rb.VelocityWorld.Y = 0;
            }
        }

        /// <summary>Stop residual ground creep once the aircraft has settled on the runway.</summary>
        private void ClampParkedGroundSpeed()
        {
            if (!landed) return;
            double terrainY = GroundHeightAt(position.X, position.Z);
            if (position.Y > terrainY + GroundRestY + 0.25) return;
            // Leave the rollout alone once the pilot advances the throttle.
            if (throttle > 0.01 || effectiveThrottle > 0.05) return;

            double vh = JsMath.Hypot(velocity.X, velocity.Z);
            if (vh > 0.25) return;

            velocity.X = 0;
            velocity.Z = 0;
            rb.VelocityWorld.X = 0;
            rb.VelocityWorld.Z = 0;
        }

        /// <summary>Higher effective friction for sideways (non-rolling) contact motion.</summary>
        private double SideSlipFraction(double vhx, double vhz)
        {
            Vec3d fwd = SimConstants.Forward.Rotate(rb.Orientation);
            double fwx = fwd.X, fwz = fwd.Z;
            double fwLen = Fm2Math.Or(JsMath.Hypot(fwx, fwz), 1);
            double vh = Fm2Math.Or(JsMath.Hypot(vhx, vhz), 1);
            double along = Math.Abs((vhx * fwx + vhz * fwz) / (fwLen * vh));
            return JsMath.Clamp(1 - along, 0, 1);
        }

        /// <summary>
        /// Body-frame AoA. At very low airspeed (tail-slide apex) the velocity vector is
        /// unreliable, so fall back to pitch attitude for FBW / stall telemetry.
        /// </summary>
        private double ComputeBodyAoa(double speed)
        {
            if (speed > 1)
            {
                return JsTrig.Atan2(-velBody.Y, velBody.Z);
            }
            if (speed > 0.15)
            {
                return JsTrig.Atan2(-velBody.Y, velBody.Z);
            }
            Vec3d fwd = new Vec3d(0, 0, 1).Rotate(rb.Orientation);
            return JsTrig.Asin(JsMath.Clamp(fwd.Y, -1, 1));
        }

        private void UpdateStallState(double speed, double aoa, double altitude)
        {
            if (landed) { stall = -1; return; }
            double stallAoa = config.Envelope.StallAoaRad;
            double minFlyingSpeed = config.Envelope.MinFlyingSpeedMps;
            double aoaStall = speed > 5 ? JsMath.Clamp((Math.Abs(aoa) - stallAoa * 0.85) / (stallAoa * 0.3), 0, 1) : 0;
            double speedStall = altitude > SimConstants.PlaneDistanceToGround + 5
                ? JsMath.Clamp((minFlyingSpeed - speed) / minFlyingSpeed, 0, 1) : 0;
            double level = Math.Max(aoaStall, speedStall);
            stall = level > 0 ? level : -1;
        }

        private void HandleGroundState()
        {
            double terrainY = GroundHeightAt(position.X, position.Z);
            double restY = terrainY + GroundRestY;
            bool onGround = position.Y <= restY + 0.25;

            if (position.Y > restY + 0.3)
            {
                landed = false;
            }

            // CG hard floor (gear contacts already clamped in ResolveGearTerrainPenetration).
            if (landingGearDeployed)
            {
                double minY = restY - MaxGearStrokeM;
                if (position.Y < minY)
                {
                    position.Y = minY;
                    if (velocity.Y < 0)
                    {
                        velocity.Y = 0;
                        rb.VelocityWorld.Y = 0;
                    }
                }
            }

            if (!onGround) return;

            Vec3d fwd = SimConstants.Forward.Rotate(rb.Orientation);
            Vec3d right = SimConstants.Right.Rotate(rb.Orientation);
            double speed = velocity.Length;
            double pitchAngle = JsTrig.Asin(JsMath.Clamp(fwd.Y, -1, 1));
            double rollAngle = JsTrig.Asin(JsMath.Clamp(right.Y, -1, 1));

            Fm2EnvelopeConfig env = config.Envelope;
            // The sink rate the aircraft arrived with: the gear stops and clamps it, so by
            // now the velocity says nothing. (Mid-stroke spring travel at a normal rate is
            // not a hard landing.)
            double sink = stepSinkMps;
            bool badAttitude = Math.Abs(rollAngle) > env.LandingMaxRollRad || pitchAngle < env.LandingMinPitchRad;

            if (!landingGearDeployed)
            {
                // A belly landing is judged once, at touchdown; after that it is sliding,
                // held up by the ground contact (the solid-world response).
                if (landed)
                {
                    return;
                }
                double hardness = LandingLimits.BellyHardness(sink, speed, rollAngle, pitchAngle, env.LandingMinPitchRad);
                if (hardness > LandingLimits.BellyFatalHardness)
                {
                    crashed = true;
                    return;
                }
                ReportHardLanding(LandingLimits.DamageFraction(hardness, LandingLimits.BellySoftHardness, LandingLimits.BellyFatalHardness));
                landed = true;
                return;
            }
            // Gear down: up to the envelope's limit it is a landing; past it the airframe
            // is damaged; far past it, it is fatal.
            if (sink > LandingLimits.GearFatalSinkMps)
            {
                crashed = true;
                return;
            }
            ReportHardLanding(LandingLimits.DamageFraction(sink, env.LandingMaxVerticalSpeedMps, LandingLimits.GearFatalSinkMps));
            if (!landed && speed > env.LandingMaxSpeedMps && badAttitude)
            {
                crashed = true;
                return;
            }
            if (speed < env.LandingMaxSpeedMps && Math.Abs(rollAngle) < env.LandingMaxRollRad)
            {
                landed = true;
            }
        }

        public override double GetStallStatus() => stall;

        public override IReadOnlyList<double> GearCompression => gearCompression;

        /// <summary>
        /// A body-frame snapshot of the net force on each body part for the debug
        /// overlay: lift and drag per surface, the forebody side force when live, thrust
        /// along +Z and weight rotated into the body frame. Kinematic mode has no
        /// aerodynamics, so nothing is produced.
        /// </summary>
        public List<ForceVectorSample> GetForceVectorSnapshot()
        {
            var samples = new List<ForceVectorSample>();
            if (kinematic) return samples;

            foreach (AeroSurface s in allSurfaces)
            {
                Vec3d p = s.PositionBody;
                samples.Add(new ForceVectorSample { Part = s.Name, Kind = ForceVectorKind.Lift, Origin = p, Vec = s.LiftForceBody });
                samples.Add(new ForceVectorSample { Part = s.Name, Kind = ForceVectorKind.Drag, Origin = p, Vec = s.DragForceBody });
            }

            // Forebody vortex-asymmetry side force (nose slice), when live.
            Vec3d fb = forebodyForceBody;
            if (fb.LengthSquared > 0)
            {
                double armZ = config.ForebodyAsymmetry?.ArmZ ?? 0;
                samples.Add(new ForceVectorSample
                {
                    Part = "forebody", Kind = ForceVectorKind.Lift, Origin = new Vec3d(0, 0, armZ), Vec = fb,
                });
            }

            // Thrust acts along the body +Z (nose) through the CG.
            samples.Add(new ForceVectorSample
            {
                Part = "engine", Kind = ForceVectorKind.Thrust, Origin = Vec3d.Zero, Vec = new Vec3d(0, 0, engineThrustN),
            });

            // Weight: world-down force rotated into the current body frame.
            double weightWorldY = -config.Geometry.MassKg * Gravity;
            invOrient = quaternion.Conjugate();
            Vec3d w = new Vec3d(0, weightWorldY, 0).Rotate(invOrient);
            samples.Add(new ForceVectorSample { Part = "cg", Kind = ForceVectorKind.Weight, Origin = Vec3d.Zero, Vec = w });

            return samples;
        }

        // --- Throttle quadrant behaviour. Afterburner aircraft use the F100-class
        // quadrant with MIL/AB detents; others use a plain linear 0-100% lever. ---
        private bool Afterburner => config.Engine.Afterburner;
        public override string ThrottleHudText => Afterburner ? F16Engine.HudText(throttle) : base.ThrottleHudText;
        public override bool UseAfterburnerThrottleDetents => Afterburner;
        public override double StepThrottleDetent(double current, int direction) => Afterburner ? F16Engine.StepDetent(current, direction) : base.StepThrottleDetent(current, direction);
        public override bool IsInThrottleAbDetentBand(double lever) => Afterburner ? F16Engine.IsAbDetentBand(lever) : base.IsInThrottleAbDetentBand(lever);
        public override double AdjustThrottleInput(double current, double step) => Afterburner ? F16Engine.AdjustInput(current, step) : base.AdjustThrottleInput(current, step);
        public F16ThrottleZone ThrottleZone => Afterburner ? F16Engine.Zone(effectiveThrottle) : F16ThrottleZone.Mil;
        public override double ThrottleAudioLevel => Afterburner ? F16Engine.AudioLevel(effectiveThrottle) : base.ThrottleAudioLevel;
        public override string EngineNozzleColor => Afterburner ? F16Engine.NozzleColor(effectiveThrottle) : base.EngineNozzleColor;
    }
}

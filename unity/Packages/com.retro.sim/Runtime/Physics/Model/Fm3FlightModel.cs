using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// FM3, the physical flight model (port of physics/model/fm3FlightModel.ts).
    ///
    /// A 6-DOF rigid body (full inertia tensor, engine rotor momentum, RK4, no rate
    /// limit) whose loads come from the airframe's geometry: lifting surfaces cut
    /// into strips with full-range section aerodynamics and unsteady separation, a
    /// lifting line with the tail's downwash delay and wake, strake vortex lift and
    /// slender-body fuselage forces (Fm3Aero). Stall, departure, deep stall and
    /// spins are whatever those produce; nothing here is keyed to a manoeuvre. A
    /// fly-by-wire system (Fm3Fcs) flies it through rate- and position-limited
    /// actuators, and spring-damper gear carries it on the ground.
    ///
    /// See docs/fm3-physical-flight-model.md.
    /// </summary>
    public class Fm3FlightModel : FlightModel
    {
        public const double Gravity = 9.80665;
        public const double Deg = Math.PI / 180;

        private readonly Fm2AircraftConfig config;
        public readonly Fm3Airframe Airframe;
        public readonly Fm3Aero Aero;
        private readonly RigidBody6 rb = new RigidBody6();
        private readonly Fm3Actuators actuators;
        private readonly Fm3Fcs fcs;
        private readonly Fm3FcsConfig fcsConfig;
        private readonly Fm3Engine engine;
        private readonly Fm3GroundContact gear;

        private readonly AeroEnvironment env = new AeroEnvironment
        {
            Rho = 1.225, SoundSpeed = 340, HeightAboveGround = double.PositiveInfinity, GearDown = 1,
        };
        private readonly double[] nozzle;
        private readonly double[] thrustAxis;
        private readonly double massKg;

        private double thrustN;
        private double stall = -1;
        /// <summary>Steps the rigid body's NaN guard has rolled back.</summary>
        public int NanGuardTrips;
        private double sideslipRad;

        private readonly Fm3FcsInput fcsInput = new Fm3FcsInput
        {
            PitchStick = 0, RollStick = 0, Pedal = 0, Alpha = 0, Beta = 0, P = 0, Q = 0, R = 0, Nz = 1,
            Qbar = 0, StaticPressure = 101325, Landed = true, LimitersEnabled = true, FlapsExtended = true, AirbrakesExtended = false,
        };

        // Scratch.
        private readonly double[] vb = new double[3];
        private readonly double[] fAero = new double[3];
        private readonly double[] mAero = new double[3];
        private readonly double[] tmp = new double[3];
        private readonly double[] tmp2 = new double[3];
        private readonly double[] prevVel = new double[3];
        private double stageLoadFactor = 1;
        private readonly WrenchFunction wrench;

        public Fm3FlightModel(Fm2AircraftConfig config = null)
        {
            config = config ?? Fm2Defaults.Default();
            this.config = config;
            Airframe = config.Fm3 ?? F16Airframe.Default;
            fcsConfig = Fm3Fcs.F16;
            Aero = new Fm3Aero(Airframe);
            actuators = new Fm3Actuators(Airframe, Aero.Controls);
            fcs = new Fm3Fcs(fcsConfig);

            Fm3EngineSpec eng = Airframe.Engines.Length > 0 ? Airframe.Engines[0] : null;
            engine = new Fm3Engine(new EngineSchedule
            {
                IdleThrustN = eng != null ? eng.IdleThrustN : config.Engine.IdleThrustKn * 1000,
                MilThrustN = eng != null ? eng.MilThrustN : config.Engine.MilThrustKn * 1000,
                AbMinThrustN = config.Engine.Afterburner ? (eng != null ? eng.AbMinThrustN : config.Engine.AbMinThrustKn * 1000) : 0,
                MaxThrustN = config.Engine.Afterburner
                    ? (eng != null ? eng.MaxThrustN : config.Engine.AbMaxThrustKn * 1000)
                    : (eng != null ? eng.MilThrustN : config.Engine.MilThrustKn * 1000),
                MilLeverEnd = config.Engine.MilLeverEnd,
                AbMinLeverEnd = config.Engine.AbMinLeverEnd,
            });
            double[] cg = Airframe.Mass.Cg;
            nozzle = eng != null
                ? Fm3Frames.NasaToSim(new[] { eng.Nozzle[0] - cg[0], eng.Nozzle[1] - cg[1], eng.Nozzle[2] - cg[2] })
                : new double[] { 0, 0, 0 };
            thrustAxis = eng != null ? Fm3Frames.NasaToSim(eng.Axis) : new double[] { 0, 0, 1 };

            massKg = Airframe.Mass.MassKg;
            rb.SetMassProperties(massKg, Fm3Frames.InertiaNasaToSim(Airframe.Mass.Inertia));
            double h = eng != null ? eng.RotorMomentum : 0;
            rb.RotorMomentum[0] = thrustAxis[0] * h;
            rb.RotorMomentum[1] = thrustAxis[1] * h;
            rb.RotorMomentum[2] = thrustAxis[2] * h;

            gear = new Fm3GroundContact(config.Gear);
            wrench = Wrench;
            Reset();
        }

        private void Wrench(double[] pos, double[] vel, double[] quat, double[] omega, int stage, double[] force, double[] moment)
        {
            RigidBody6.RotateWorldToBody(quat, vel[0], vel[1], vel[2], vb);
            double[] fa = fAero;
            double[] ma = mAero;
            Aero.Evaluate(vb[0], vb[1], vb[2], omega[0], omega[1], omega[2], env, fa, ma, stage == 0);
            double t = thrustN;
            double ax = thrustAxis[0] * t, ay = thrustAxis[1] * t, az = thrustAxis[2] * t;
            double[] n = nozzle;
            moment[0] = ma[0] + (n[1] * az - n[2] * ay);
            moment[1] = ma[1] + (n[2] * ax - n[0] * az);
            moment[2] = ma[2] + (n[0] * ay - n[1] * ax);
            RigidBody6.RotateBodyToWorld(quat, fa[0] + ax, fa[1] + ay, fa[2] + az, force);
            force[1] -= massKg * Gravity;
            double gearUp = 0;
            if (landingGearDeployed)
            {
                gearUp = gear.AddForces(pos, vel, quat, omega, wheelBrakesApplied, force, moment, stage == 0);
            }
            if (stage == 0)
            {
                stageLoadFactor = (fa[1] + gearUp) / (massKg * Gravity);
            }
        }

        public void SetWorldQuery(IGroundQuery world)
        {
            gear.World = world;
        }

        public override void Reset()
        {
            base.Reset();
            Array.Clear(rb.Pos, 0, 3);
            Array.Clear(rb.Vel, 0, 3);
            rb.Quat[0] = 0; rb.Quat[1] = 0; rb.Quat[2] = 0; rb.Quat[3] = 1;
            Array.Clear(rb.Omega, 0, 3);
            Aero.Reset();
            actuators.Reset();
            fcs.Reset();
            engine.Power = 0;
            thrustN = 0;
            stall = -1;
            stageLoadFactor = 1;
            sideslipRad = 0;
            for (int i = 0; i < gear.Count; i++) gear.Compression[i] = 0;
        }

        /// <summary>Pull externally set pose and velocity into the rigid body.</summary>
        public override void Rebase(FrameShift shift)
        {
            base.Rebase(shift);
            AdoptExternalState();
        }

        private void AdoptExternalState()
        {
            Vec3d p = position, v = velocity;
            Quatd q = quaternion;
            rb.Pos[0] = p.X; rb.Pos[1] = p.Y; rb.Pos[2] = p.Z;
            rb.Quat[0] = q.X; rb.Quat[1] = q.Y; rb.Quat[2] = q.Z; rb.Quat[3] = q.W;
            rb.Vel[0] = v.X; rb.Vel[1] = v.Y; rb.Vel[2] = v.Z;
        }

        private void PublishState()
        {
            position = new Vec3d(rb.Pos[0], rb.Pos[1], rb.Pos[2]);
            quaternion = new Quatd(rb.Quat[0], rb.Quat[1], rb.Quat[2], rb.Quat[3]);
            velocity = new Vec3d(rb.Vel[0], rb.Vel[1], rb.Vel[2]);
        }

        /// <summary>
        /// Airborne spawn: match the engine to the lever, settle the aerodynamic
        /// states for the current flight condition, and trim the pitch integrator
        /// so the aircraft starts near 1 g instead of with a transient.
        /// </summary>
        public override void SyncEffectiveThrottle()
        {
            base.SyncEffectiveThrottle();
            engine.Sync(throttle);
            effectiveThrottle = engine.EquivalentLever();
            AdoptExternalState();
            RefreshAtmosphere();
            ReadSensors();
            double[] w = rb.Omega;
            Aero.Settle(vb[0], vb[1], vb[2], w[0], w[1], w[2], env);
            fcs.TrimTo(0, fcsInput);
        }

        public void ClearAngularVelocity()
        {
            Array.Clear(rb.Omega, 0, 3);
        }

        public double ContactSpeedIntoNormal(Vec3d pointWorld, Vec3d normalWorld)
        {
            double[] t = tmp;
            RigidBody6.RotateBodyToWorld(quaternion, rb.Omega[0], rb.Omega[1], rb.Omega[2], t);
            double rx = pointWorld.X - position.X;
            double ry = pointWorld.Y - position.Y;
            double rz = pointWorld.Z - position.Z;
            double vx = velocity.X + (t[1] * rz - t[2] * ry);
            double vy = velocity.Y + (t[2] * rx - t[0] * rz);
            double vz = velocity.Z + (t[0] * ry - t[1] * rx);
            double vn = vx * normalWorld.X + vy * normalWorld.Y + vz * normalWorld.Z;
            return vn < 0 ? -vn : 0;
        }

        /// <summary>Scrape friction at a contact point: an impulse opposing its velocity (as FM2).</summary>
        public void ApplyContactDragAt(Vec3d pointWorld, double dt, double dragPerSec, double massFraction, double maxFrac)
        {
            if (dt <= 0) return;
            double[] t = tmp;
            RigidBody6.RotateBodyToWorld(quaternion, rb.Omega[0], rb.Omega[1], rb.Omega[2], t);
            double rx = pointWorld.X - position.X;
            double ry = pointWorld.Y - position.Y;
            double rz = pointWorld.Z - position.Z;
            double vx = velocity.X + (t[1] * rz - t[2] * ry);
            double vy = velocity.Y + (t[2] * rx - t[0] * rz);
            double vz = velocity.Z + (t[0] * ry - t[1] * rx);
            double speed = Math.Sqrt(vx * vx + vy * vy + vz * vz);
            if (speed < 1e-3) return;
            double frac = 1 - Math.Exp(-dragPerSec * dt);
            if (frac > maxFrac) frac = maxFrac;
            double j = -frac * massKg * massFraction;
            ApplyImpulse(vx * j, vy * j, vz * j, ry * (vz * j) - rz * (vy * j), rz * (vx * j) - rx * (vz * j), rx * (vy * j) - ry * (vx * j));
        }

        public double MassKg => massKg;

        public Vec3d PointVelocity(Vec3d pointWorld)
        {
            double[] t = tmp;
            RigidBody6.RotateBodyToWorld(quaternion, rb.Omega[0], rb.Omega[1], rb.Omega[2], t);
            double rx = pointWorld.X - position.X;
            double ry = pointWorld.Y - position.Y;
            double rz = pointWorld.Z - position.Z;
            return new Vec3d(
                velocity.X + (t[1] * rz - t[2] * ry),
                velocity.Y + (t[2] * rx - t[0] * rz),
                velocity.Z + (t[0] * ry - t[1] * rx));
        }

        public double InvEffectiveMass(Vec3d pointWorld, Vec3d dirWorld)
        {
            double rx = pointWorld.X - position.X;
            double ry = pointWorld.Y - position.Y;
            double rz = pointWorld.Z - position.Z;
            double cx = ry * dirWorld.Z - rz * dirWorld.Y;
            double cy = rz * dirWorld.X - rx * dirWorld.Z;
            double cz = rx * dirWorld.Y - ry * dirWorld.X;
            double[] b = tmp2;
            RigidBody6.RotateWorldToBody(quaternion, cx, cy, cz, b);
            double[] Ii = rb.InertiaInv;
            double ex = Ii[0] * b[0] + Ii[1] * b[1] + Ii[2] * b[2];
            double ey = Ii[3] * b[0] + Ii[4] * b[1] + Ii[5] * b[2];
            double ez = Ii[6] * b[0] + Ii[7] * b[1] + Ii[8] * b[2];
            return 1 / massKg + b[0] * ex + b[1] * ey + b[2] * ez;
        }

        public override void ApplyExternalWrench(Vec3d impulseWorld, Vec3d angularImpulseWorld)
        {
            ApplyImpulse(impulseWorld.X, impulseWorld.Y, impulseWorld.Z, angularImpulseWorld.X, angularImpulseWorld.Y, angularImpulseWorld.Z);
        }

        /// <summary>Linear impulse (world) into velocity; angular impulse (world) through the full inertia tensor.</summary>
        private void ApplyImpulse(double jx, double jy, double jz, double lx, double ly, double lz)
        {
            velocity.X += jx / massKg;
            velocity.Y += jy / massKg;
            velocity.Z += jz / massKg;
            if (lx != 0 || ly != 0 || lz != 0)
            {
                double[] b = tmp2;
                RigidBody6.RotateWorldToBody(quaternion, lx, ly, lz, b);
                double[] Ii = rb.InertiaInv;
                rb.Omega[0] += Ii[0] * b[0] + Ii[1] * b[1] + Ii[2] * b[2];
                rb.Omega[1] += Ii[3] * b[0] + Ii[4] * b[1] + Ii[5] * b[2];
                rb.Omega[2] += Ii[6] * b[0] + Ii[7] * b[1] + Ii[8] * b[2];
            }
        }

        private void RefreshAtmosphere()
        {
            double altitude = AtmosphereAltitudeM;
            env.Rho = AeroUtils.AirDensity(altitude);
            env.SoundSpeed = AeroUtils.SpeedOfSound(altitude);
            double[] p = rb.Pos;
            env.HeightAboveGround = p[1] - gear.GroundHeightAt(p[0], p[2]);
            env.GearDown = landingGearDeployed ? 1 : 0;
        }

        /// <summary>Air data and body rates from the current rigid-body state into the FCS input.</summary>
        private void ReadSensors()
        {
            RigidBody6.RotateWorldToBody(rb.Quat, rb.Vel[0], rb.Vel[1], rb.Vel[2], vb);
            double speed = Math.Sqrt(vb[0] * vb[0] + vb[1] * vb[1] + vb[2] * vb[2]);
            Fm3FcsInput input = fcsInput;
            double alpha;
            if (speed > 1)
            {
                alpha = JsTrig.Atan2(-vb[1], vb[2]);
                sideslipRad = JsTrig.Asin(JsMath.Clamp(-vb[0] / speed, -1, 1));
            }
            else
            {
                // Tail-slide apex: the velocity vector says nothing; fall back to attitude (as FM2).
                double[] t = tmp;
                RigidBody6.RotateBodyToWorld(rb.Quat, 0, 0, 1, t);
                alpha = JsTrig.Asin(JsMath.Clamp(t[1], -1, 1));
                sideslipRad = 0;
            }
            input.Alpha = alpha;
            input.Beta = sideslipRad;
            double[] w = rb.Omega;
            input.P = w[2];
            input.Q = -w[0];
            input.R = -w[1];
            input.Nz = stageLoadFactor;
            input.Qbar = 0.5 * env.Rho * speed * speed;
            input.StaticPressure = env.Rho * 287.053 * (env.SoundSpeed * env.SoundSpeed / (1.4 * 287.053));
            input.PitchStick = pitch;
            input.RollStick = roll;
            input.Pedal = yaw;
            input.Landed = landed;
            input.LimitersEnabled = limitersEnabled;
            input.FlapsExtended = flapsExtended;
            input.AirbrakesExtended = airbrakesExtended;
            angleOfAttackRad = alpha;
        }

        public override void Step(double delta)
        {
            if (crashed) return;
            AdoptExternalState();
            RefreshAtmosphere();

            double altitude = AtmosphereAltitudeM;
            engine.Update(delta, throttle);
            effectiveThrottle = engine.EquivalentLever();
            thrustN = engine.ThrustN(env.Rho, altitude);
            engineThrustN = thrustN;

            ReadSensors();
            fcs.Update(fcsInput, delta, actuators.Command);
            actuators.Update(delta);
            PublishSurfaceCommands();

            double[] w = rb.Omega;
            Aero.Advance(delta, vb[0], vb[1], vb[2], w[0], w[1], w[2], env);

            if (landingGearDeployed)
            {
                gear.SamplePlanes(rb.Pos, rb.Quat);
            }
            else
            {
                for (int i = 0; i < gear.Count; i++) gear.Compression[i] = 0;
            }

            prevVel[0] = rb.Vel[0]; prevVel[1] = rb.Vel[1]; prevVel[2] = rb.Vel[2];
            if (!rb.Step(delta, wrench))
            {
                NanGuardTrips++;
                Array.Clear(rb.Omega, 0, 3);
            }
            accelWorld = new Vec3d(
                (rb.Vel[0] - prevVel[0]) / delta,
                (rb.Vel[1] - prevVel[1]) / delta,
                (rb.Vel[2] - prevVel[2]) / delta);
            loadFactorG = stageLoadFactor;

            if (landingGearDeployed)
            {
                double excess = gear.ExcessPenetration(rb.Pos, rb.Quat);
                if (excess > 0)
                {
                    rb.Pos[1] += excess;
                    if (rb.Vel[1] < 0) rb.Vel[1] = 0;
                }
            }
            PublishState();
            ClampParkedGroundSpeed();
            UpdateStall();
            HandleGroundState();
        }

        private void PublishSurfaceCommands()
        {
            double[] pos = Aero.Controls;
            double stab = 0.5 * (pos[(int)Fm3Channel.StabL] + pos[(int)Fm3Channel.StabR]);
            double maxStab = fcsConfig.Pitch.MaxStab;
            double maxAileron = fcsConfig.Roll.MaxAileron;
            double maxRudder = fcsConfig.Yaw.MaxRudder;
            commandedElevator = JsMath.Clamp(-stab / maxStab, -1, 1);
            commandedAileron = JsMath.Clamp(0.5 * (pos[(int)Fm3Channel.FlapL] - pos[(int)Fm3Channel.FlapR]) / maxAileron, -1, 1);
            commandedRudder = JsMath.Clamp(pos[(int)Fm3Channel.Rudder] / maxRudder, -1, 1);
            elevatorCommandLimitHigh = 1;
            elevatorCommandLimitLow = -1;
        }

        private void UpdateStall()
        {
            if (landed)
            {
                stall = -1;
                return;
            }
            double separated = Aero.WingSeparatedFraction();
            stall = separated > 0.15 ? Math.Min(1, (separated - 0.15) / 0.5) : -1;
        }

        /// <summary>Stop residual creep once settled on the runway with the engine idle (as FM2).</summary>
        private void ClampParkedGroundSpeed()
        {
            if (!landed) return;
            double terrainY = gear.GroundHeightAt(position.X, position.Z);
            if (position.Y > terrainY + gear.RestHeight + 0.25) return;
            if (throttle > 0.01 || effectiveThrottle > 0.05) return;
            if (JsMath.Hypot(velocity.X, velocity.Z) > 0.25) return;
            velocity.X = 0;
            velocity.Z = 0;
            rb.Vel[0] = 0;
            rb.Vel[2] = 0;
        }

        /// <summary>Landed and crash rules on the configured envelope (as FM2).</summary>
        private void HandleGroundState()
        {
            // How fast it was sinking as it met the ground, before the floor clamp below takes it out.
            double sink = Math.Max(0, -velocity.Y);
            double terrainY = gear.GroundHeightAt(position.X, position.Z);
            double restY = terrainY + gear.RestHeight;
            bool onGround = position.Y <= restY + 0.25;
            if (position.Y > restY + 0.3) landed = false;

            if (landingGearDeployed)
            {
                double minY = restY - gear.MaxStroke;
                if (position.Y < minY)
                {
                    position.Y = minY;
                    rb.Pos[1] = minY;
                    if (velocity.Y < 0)
                    {
                        velocity.Y = 0;
                        rb.Vel[1] = 0;
                    }
                }
            }
            if (!onGround) return;

            Vec3d fwd = SimConstants.Forward.Rotate(quaternion);
            Vec3d right = SimConstants.Right.Rotate(quaternion);
            double speed = velocity.Length;
            double pitchAngle = JsTrig.Asin(JsMath.Clamp(fwd.Y, -1, 1));
            double rollAngle = JsTrig.Asin(JsMath.Clamp(right.Y, -1, 1));
            Fm2EnvelopeConfig envl = config.Envelope;
            bool badAttitude = Math.Abs(rollAngle) > envl.LandingMaxRollRad || pitchAngle < envl.LandingMinPitchRad;
            if (!landingGearDeployed)
            {
                // A belly landing is judged once, at touchdown; after that it is sliding, held up by the
                // ground contact (the solid-world response), which needs the weight it carries.
                if (landed)
                {
                    return;
                }
                double hardness = LandingLimits.BellyHardness(sink, speed, rollAngle, pitchAngle, envl.LandingMinPitchRad);
                if (hardness > LandingLimits.BellyFatalHardness)
                {
                    crashed = true;
                    return;
                }
                ReportHardLanding(LandingLimits.DamageFraction(hardness, LandingLimits.BellySoftHardness, LandingLimits.BellyFatalHardness));
                landed = true;
                return;
            }
            // Gear down: up to the envelope's limit it is a landing; past it the airframe is damaged
            // (gear legs shear, the structure bends); far past it, it is fatal.
            if (sink > LandingLimits.GearFatalSinkMps)
            {
                crashed = true;
                return;
            }
            ReportHardLanding(LandingLimits.DamageFraction(sink, envl.LandingMaxVerticalSpeedMps, LandingLimits.GearFatalSinkMps));
            if (!landed && speed > envl.LandingMaxSpeedMps && badAttitude)
            {
                crashed = true;
                return;
            }
            if (speed < envl.LandingMaxSpeedMps && Math.Abs(rollAngle) < envl.LandingMaxRollRad)
            {
                landed = true;
            }
        }

        public override double GetStallStatus() => stall;

        /// <summary>Sideslip angle (rad), NASA convention: positive with the wind from starboard.</summary>
        public double Sideslip => sideslipRad;

        public override IReadOnlyList<double> GearCompression => gear.Compression;

        public List<ForceVectorSample> GetForceVectorSnapshot()
        {
            RigidBody6.RotateWorldToBody(rb.Quat, rb.Vel[0], rb.Vel[1], rb.Vel[2], vb);
            List<ForceVectorSample> samples = Aero.ForceVectorSnapshot(vb[0], vb[1], vb[2]);
            samples.Add(new ForceVectorSample
            {
                Part = "engine", Kind = ForceVectorKind.Thrust, Origin = new Vec3d(nozzle[0], nozzle[1], nozzle[2]),
                Vec = new Vec3d(thrustAxis[0] * thrustN, thrustAxis[1] * thrustN, thrustAxis[2] * thrustN),
            });
            double[] wgt = tmp;
            RigidBody6.RotateWorldToBody(rb.Quat, 0, -massKg * Gravity, 0, wgt);
            samples.Add(new ForceVectorSample { Part = "cg", Kind = ForceVectorKind.Weight, Origin = Vec3d.Zero, Vec = new Vec3d(wgt[0], wgt[1], wgt[2]) });
            return samples;
        }

        // --- Throttle quadrant: FM2's F100 quadrant for afterburning engines. ---
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

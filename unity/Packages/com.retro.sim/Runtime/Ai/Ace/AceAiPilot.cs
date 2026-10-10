using System;
using Retro.Core;
using static Retro.Sim.AiMath;

namespace Retro.Sim
{
    /// <summary>
    /// "Ace" AI pilot model: an elite dogfighter built on the same
    /// FSM -> command -> <see cref="FlightControlComputer"/> pipeline as
    /// <see cref="ShawAiPilot"/> and <see cref="AggressiveAiPilot"/>, with two
    /// capabilities neither of those has:
    ///
    /// 1. Post-stall maneuvers. COBRA_BRAKE and KULBIT are open-loop, timed
    ///    departures from controlled flight; the FCC's closed loops would fight
    ///    them, so this pilot flies them directly on the stick (see
    ///    UpdatePostStall). It vetoes the FSM's request when there is not
    ///    enough height or the airspeed is outside the window, and abandons one in
    ///    progress if the ground comes up.
    /// 2. Ballistic trigger discipline. The FSM's gun envelope is only
    ///    permission; the shot is taken only when the predicted miss distance puts
    ///    the round inside the target's hit radius (see HasGunSolution).
    ///
    /// All non-ENGAGE mission phases delegate to a classic <see cref="AiPilot"/> so
    /// takeoff/RTB/nav stay shared across every model.
    /// </summary>
    public sealed class AceAiPilot : IAiPilotController
    {
        /// <summary>Post-stall maneuver durations (s).</summary>
        private const double COBRA_DURATION = 1.5;
        private const double KULBIT_DURATION = 2.0;
        /// <summary>Fraction of the maneuver flown at idle before slamming the throttle back in.</summary>
        private const double COBRA_IDLE_FRACTION = 0.65;
        private const double KULBIT_IDLE_FRACTION = 0.7;
        /// <summary>Seconds before another post-stall maneuver may be entered.</summary>
        private const double PSM_COOLDOWN = 8;
        /// <summary>
        /// Height above local terrain (m) required to *enter* a post-stall maneuver.
        /// While departed, the FCC's terrain-avoidance loop is not running, so the
        /// altitude to recover in has to be bought up front.
        /// </summary>
        private const double PSM_MIN_AGL = 800;
        /// <summary>Below this AGL an in-progress maneuver is abandoned back to the FCC.</summary>
        private const double PSM_ABORT_AGL = 400;
        /// <summary>Airspeed windows (m/s) in which each maneuver actually works.</summary>
        private const double COBRA_SPEED_MIN = 140, COBRA_SPEED_MAX = 330;
        private const double KULBIT_SPEED_MIN = 110, KULBIT_SPEED_MAX = 270;

        /// <summary>Roll gain used to hold wings level through a post-stall maneuver.</summary>
        private const double PSM_ROLL_KP = 2.2;

        /// <summary>Smoothing on the finite-difference target-acceleration estimate.</summary>
        private const double TARGET_ACC_EMA = 0.25;

        /// <summary>
        /// How far outside the target's hit radius the ballistic solution may miss and
        /// still be worth a trigger pull. Tight — this model shoots when the round
        /// connects, not to apply pressure.
        /// </summary>
        private const double ACCURACY_MARGIN = 1.6;

        private readonly IPilotableAircraft aircraft;
        private readonly IWorldQuery world;
        private readonly AiPilot classic;
        private readonly AceTacticalFSM fsm;
        private readonly FlightControlComputer fcc;

        private AiFlightPhase phase = AiFlightPhase.NAVIGATE;
        private ICombatant target;
        private bool firing;
        private string lastManeuver = "ACE";

        private readonly double gunRange;
        private readonly double bulletSpeed;

        /// <summary>Post-stall maneuver in progress, if any.</summary>
        private PostStallRequest? psmActive;
        private double psmElapsed;
        private double psmCooldown;

        private bool hasPrevTargetVel;
        private Vec3d prevTargetVel;

        private readonly AceSnapshot selfSnap;
        private readonly AceSnapshot tgtSnap;
        private Vec3d right;
        private Vec3d up;

        public AceAiPilot(IPilotableAircraft aircraft, IWorldQuery world, AiPilotOptions options = null)
        {
            options ??= new AiPilotOptions();
            this.aircraft = aircraft;
            this.world = world;
            classic = new AiPilot(aircraft, world, options);
            gunRange = options.GunRange ?? 900;
            bulletSpeed = options.BulletSpeed ?? 1000;
            fsm = new AceTacticalFSM(new AceTacticalFsmOptions
            {
                GunRange = gunRange,
                BulletSpeed = bulletSpeed,
                CombatSpeed = options.CombatSpeed ?? 200,
                MaxSpeed = options.MaxSpeed ?? 240,
            });
            fcc = new FlightControlComputer(aircraft, world, new FlightControlComputerOptions
            {
                MaxSpeed = options.MaxSpeed ?? 240,
                HardDeck = options.HardDeck ?? 150,
                PitchKp = options.PitchKp,
                PitchKd = options.PitchKd,
                PitchSlew = options.PitchSlew,
            });

            double corner = options.CombatSpeed ?? 200;
            selfSnap = MakeSnapshot(corner);
            tgtSnap = MakeSnapshot(corner);
        }

        private static AceSnapshot MakeSnapshot(double cornerVelocity)
        {
            return new AceSnapshot
            {
                Forward = new Vec3d(0, 0, 1),
                Up = new Vec3d(0, 1, 0),
                Right = new Vec3d(1, 0, 0),
                CornerVelocity = cornerVelocity,
                MaxG = 9,
            };
        }

        public AiFlightPhase GetPhase() => phase;

        public void SetPhase(AiFlightPhase phase)
        {
            this.phase = phase;
            classic.SetPhase(phase);
        }

        public void SetTarget(ICombatant target)
        {
            if (!ReferenceEquals(target, this.target))
            {
                // The acceleration estimate is a finite difference on one target's
                // velocity; carrying it across a target swap would inject a bogus
                // spike into the next gun solution.
                hasPrevTargetVel = false;
            }
            this.target = target;
            classic.SetTarget(target);
        }

        public void SetFormationLead(ICombatant lead)
        {
            // Formation is a non-ENGAGE phase, flown by the delegated classic pilot.
            classic.SetFormationLead(lead);
        }

        public bool IsFiring => firing;

        public string GetManeuverLabel()
        {
            if (phase != AiFlightPhase.ENGAGE)
            {
                return classic.GetManeuverLabel();
            }
            return $"ACE:{lastManeuver}";
        }

        /// <summary>Test hook: current Ace tactical posture while engaging.</summary>
        public string GetAceStateLabel() => fsm.GetState().ToString();

        /// <summary>Test hook: post-stall maneuver in progress, if any.</summary>
        public PostStallRequest? GetPostStallManeuver() => psmActive;

        public void Update(double delta)
        {
            firing = false;
            psmCooldown = Math.Max(0, psmCooldown - delta);

            if (aircraft.IsCrashed())
            {
                psmActive = null;
                aircraft.SetThrottle(0);
                aircraft.SetWheelBrakes(true);
                return;
            }

            // Non-combat phases: classic takeoff / nav / RTB / landing.
            if (phase != AiFlightPhase.ENGAGE || target == null || !target.IsAlive())
            {
                psmActive = null;
                classic.SetPhase(phase);
                classic.SetTarget(target);
                classic.Update(delta);
                phase = classic.GetPhase();
                firing = classic.IsFiring;
                lastManeuver = classic.GetManeuverLabel();
                return;
            }

            FillSnapshots(delta);

            // A maneuver already in progress owns the stick until it finishes.
            if (psmActive != null)
            {
                UpdatePostStall(delta);
                return;
            }

            AceFlightCommand command = fsm.Update(selfSnap, tgtSnap, delta);
            lastManeuver = command.ManeuverName.ToString();

            if (command.PostStall != null && CanEnterPostStall(command.PostStall.Value))
            {
                psmActive = command.PostStall;
                psmElapsed = 0;
                UpdatePostStall(delta);
                return;
            }

            bool preempted = fcc.ApplyCommand(command, delta);
            firing = !preempted && command.FireGuns && HasGunSolution();
        }

        /// <summary>Height above the terrain directly below (m).</summary>
        private double Agl()
        {
            Vec3d p = selfSnap.Position;
            return p.Y - world.GroundHeightAt(p.X, p.Z);
        }

        private bool CanEnterPostStall(PostStallRequest kind)
        {
            if (psmCooldown > 0) return false;
            if (Agl() < PSM_MIN_AGL) return false;
            double min = kind == PostStallRequest.COBRA ? COBRA_SPEED_MIN : KULBIT_SPEED_MIN;
            double max = kind == PostStallRequest.COBRA ? COBRA_SPEED_MAX : KULBIT_SPEED_MAX;
            double v = selfSnap.Airspeed;
            return v >= min && v <= max;
        }

        /// <summary>
        /// Fly the timed post-stall maneuver directly: full aft stick, wings held
        /// level, throttle cut for the departure and slammed back in for the
        /// recovery. Bypassing the FCC also bypasses its terrain-avoidance loop,
        /// hence the AGL abort.
        /// </summary>
        private void UpdatePostStall(double delta)
        {
            if (psmActive == null) return;
            PostStallRequest kind = psmActive.Value;

            psmElapsed += delta;
            double duration = kind == PostStallRequest.COBRA ? COBRA_DURATION : KULBIT_DURATION;

            if (psmElapsed >= duration || Agl() < PSM_ABORT_AGL)
            {
                EndPostStall();
                return;
            }

            double t = psmElapsed / duration;
            double idleFraction = kind == PostStallRequest.COBRA ? COBRA_IDLE_FRACTION : KULBIT_IDLE_FRACTION;

            IPilotableAircraft ac = aircraft;
            ac.SetLandingGearDeployed(false);
            ac.SetFlapsExtended(false);
            ac.SetWheelBrakes(false);
            // The Cobra is a braking maneuver; the Kulbit needs the thrust to carry
            // the nose over the top.
            ac.SetAirbrakesExtended(kind == PostStallRequest.COBRA && t < idleFraction);
            ac.SetThrottle(t < idleFraction ? (kind == PostStallRequest.COBRA ? 0 : 0.35) : 1);
            ac.SetPitch(1);
            ac.SetRoll(JsMath.Clamp(-Bank() * PSM_ROLL_KP, -1, 1));
            ac.SetYaw(0);

            // The nose sweeps through the bandit during both maneuvers — take the
            // shot if the solution is there as it passes.
            firing = HasGunSolution();
        }

        private void EndPostStall()
        {
            psmActive = null;
            psmElapsed = 0;
            psmCooldown = PSM_COOLDOWN;
        }

        /// <summary>Bank angle (rad, + right) from the cached body axes.</summary>
        private double Bank() => JsTrig.Atan2(right.Y, up.Y);

        /// <summary>
        /// True when the ballistic solution predicts the round passing inside the
        /// target's hit radius (with ACCURACY_MARGIN slack). Unlike a fixed
        /// angular cone this accounts for range, the round inheriting our own
        /// velocity, the target's acceleration and the gravity drop.
        /// </summary>
        private bool HasGunSolution()
        {
            ICombatant t = target;
            if (t == null || !t.IsAlive()) return false;

            AceSnapshot self = selfSnap;
            AceSnapshot tgt = tgtSnap;
            if (DistanceTo(self.Position, tgt.Position) > gunRange) return false;

            double tof = DogfightGeometry.BallisticAimPoint(out Vec3d _,
                self.Position, self.Velocity,
                tgt.Position, tgt.Velocity, tgt.Acceleration,
                bulletSpeed);
            Vec3d bulletVel = self.Forward * bulletSpeed + self.Velocity;
            double miss = DogfightGeometry.PredictedMissDistance(
                self.Position, bulletVel,
                tgt.Position, tgt.Velocity, tgt.Acceleration,
                tof);
            return miss <= t.GetHitRadius() * ACCURACY_MARGIN;
        }

        private void FillSnapshots(double delta)
        {
            IPilotableAircraft ac = aircraft;
            selfSnap.Position = ac.GetPosition();
            selfSnap.Velocity = ac.GetVelocity();
            Quatd quat = ac.GetQuaternion();
            Vec3d fwd = SimConstants.Forward.Rotate(quat);
            right = SimConstants.Right.Rotate(quat);
            up = SimConstants.Up.Rotate(quat);
            selfSnap.Forward = fwd;
            selfSnap.Right = right;
            selfSnap.Up = up;
            selfSnap.Altitude = ac.GetAltitude();
            selfSnap.Airspeed = ac.GetAirspeed();

            Vec3d tpos = target.ReadPosition();
            Vec3d tvel = target.ReadVelocity();
            tgtSnap.Position = tpos;
            tgtSnap.Velocity = tvel;
            tgtSnap.Altitude = tpos.Y;
            tgtSnap.Airspeed = tvel.Length;

            // Finite-difference target acceleration, smoothed: the gun solution
            // extrapolates the bandit through its turn rather than along a straight
            // line, which is the difference between tracking a hard-turning target
            // and shooting behind it.
            if (hasPrevTargetVel && delta > 1e-4)
            {
                Vec3d acc = (tvel - prevTargetVel) / delta;
                tgtSnap.Acceleration = Lerp(tgtSnap.Acceleration, acc, TARGET_ACC_EMA);
            }
            else
            {
                tgtSnap.Acceleration = new Vec3d(0, 0, 0);
            }
            prevTargetVel = tvel;
            hasPrevTargetVel = true;

            // Approximate target body axes from velocity for the scissors geometry.
            ShawSnapshots.FillTargetAxes(tgtSnap, tvel);
        }
    }
}

using Retro.Core;
using static Retro.Sim.AiMath;

namespace Retro.Sim
{
    /// <summary>
    /// Shaw Fighter Combat AI pilot model. During ENGAGE it runs the doctrinal
    /// tactical FSM → Flight Control Computer pipeline; all other mission phases
    /// delegate to a classic <see cref="AiPilot"/> so takeoff/RTB/nav stay shared.
    /// </summary>
    public sealed class ShawAiPilot : IAiPilotController
    {
        private readonly IPilotableAircraft aircraft;
        private readonly AiPilot classic;
        private readonly FighterTacticalFSM fsm;
        private readonly FlightControlComputer fcc;

        private AiFlightPhase phase = AiFlightPhase.NAVIGATE;
        private ICombatant target;
        private bool firing;
        private string lastManeuver = "SHAW";

        private readonly AircraftSnapshot selfSnap;
        private readonly AircraftSnapshot tgtSnap;

        public ShawAiPilot(IPilotableAircraft aircraft, IWorldQuery world, AiPilotOptions options = null)
        {
            options ??= new AiPilotOptions();
            this.aircraft = aircraft;
            classic = new AiPilot(aircraft, world, options);
            fsm = new FighterTacticalFSM(new FighterTacticalFsmOptions
            {
                GunRange = options.GunRange ?? 900,
                CombatSpeed = options.CombatSpeed ?? 200,
                MaxSpeed = options.MaxSpeed ?? 240,
                OvershootVc = 80,
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
            selfSnap = new AircraftSnapshot
            {
                CornerVelocity = corner,
                MaxG = 9,
            };
            tgtSnap = new AircraftSnapshot
            {
                Up = new Vec3d(0, 1, 0),
                Right = new Vec3d(1, 0, 0),
                CornerVelocity = corner,
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
            return $"SHAW:{lastManeuver}";
        }

        /// <summary>Test hook: current Shaw tactical posture while engaging.</summary>
        public string GetShawStateLabel() => fsm.GetState().ToString();

        public void Update(double delta)
        {
            firing = false;
            if (aircraft.IsCrashed())
            {
                aircraft.SetThrottle(0);
                aircraft.SetWheelBrakes(true);
                return;
            }

            // Non-combat phases: classic takeoff / nav / RTB / landing.
            if (phase != AiFlightPhase.ENGAGE || target == null || !target.IsAlive())
            {
                classic.SetPhase(phase);
                classic.SetTarget(target);
                classic.Update(delta);
                phase = classic.GetPhase();
                firing = classic.IsFiring;
                lastManeuver = classic.GetManeuverLabel();
                return;
            }

            FillSnapshots();
            FlightCommand command = fsm.Update(selfSnap, tgtSnap, delta);
            lastManeuver = command.ManeuverName.ToString();
            bool preempted = fcc.ApplyCommand(command, delta);
            firing = !preempted && command.FireGuns;
        }

        private void FillSnapshots()
        {
            IPilotableAircraft ac = aircraft;
            selfSnap.Position = ac.GetPosition();
            selfSnap.Velocity = ac.GetVelocity();
            Quatd quat = ac.GetQuaternion();
            selfSnap.Forward = SimConstants.Forward.Rotate(quat);
            selfSnap.Right = SimConstants.Right.Rotate(quat);
            selfSnap.Up = SimConstants.Up.Rotate(quat);
            selfSnap.Altitude = ac.GetAltitude();
            selfSnap.Airspeed = ac.GetAirspeed();

            Vec3d tpos = target.ReadPosition();
            Vec3d tvel = target.ReadVelocity();
            ShawSnapshots.FillTarget(tgtSnap, tpos, tvel);
        }
    }

    /// <summary>The target-snapshot fill the Shaw, Aggressive and Ace pilots share line for line.</summary>
    internal static class ShawSnapshots
    {
        public static void FillTarget(AircraftSnapshot tgtSnap, Vec3d tpos, Vec3d tvel)
        {
            tgtSnap.Position = tpos;
            tgtSnap.Velocity = tvel;
            tgtSnap.Altitude = tpos.Y;
            tgtSnap.Airspeed = tvel.Length;
            FillTargetAxes(tgtSnap, tvel);
        }

        /// <summary>Approximate target body axes from velocity (for scissors / lead-turn / reversal geometry).</summary>
        public static void FillTargetAxes(AircraftSnapshot tgtSnap, Vec3d tvel)
        {
            if (tvel.LengthSquared > 1e-6)
            {
                tgtSnap.Forward = Normalize(tvel);
            }
            else
            {
                tgtSnap.Forward = new Vec3d(0, 0, 1);
            }
            tgtSnap.Up = new Vec3d(0, 1, 0);
            tgtSnap.Right = Vec3d.Cross(tgtSnap.Up, tgtSnap.Forward);
            if (tgtSnap.Right.LengthSquared < 1e-6)
            {
                tgtSnap.Right = new Vec3d(1, 0, 0);
            }
            else
            {
                tgtSnap.Right = Normalize(tgtSnap.Right);
            }
            tgtSnap.Up = Normalize(Vec3d.Cross(tgtSnap.Forward, tgtSnap.Right));
        }
    }
}

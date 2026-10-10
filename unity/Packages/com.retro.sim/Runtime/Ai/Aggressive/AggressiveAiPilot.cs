using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// "Berserker" AI pilot model: a maximally aggressive fighter doctrine built
    /// on the same FSM -> FlightCommand -> FlightControlComputer pipeline as
    /// <see cref="ShawAiPilot"/> (see <see cref="AggressiveTacticalFSM"/> for the tactics —
    /// it never disengages to rebuild energy and never breaks defensively off a
    /// tracking threat, converting it into a scissors counter-attack instead).
    /// All non-ENGAGE mission phases delegate to a classic <see cref="AiPilot"/> so
    /// takeoff/RTB/nav stay shared across every model.
    /// </summary>
    public sealed class AggressiveAiPilot : IAiPilotController
    {
        private readonly IPilotableAircraft aircraft;
        private readonly AiPilot classic;
        private readonly AggressiveTacticalFSM fsm;
        private readonly FlightControlComputer fcc;

        private AiFlightPhase phase = AiFlightPhase.NAVIGATE;
        private ICombatant target;
        private bool firing;
        private string lastManeuver = "AGGRESSIVE";

        private readonly AircraftSnapshot selfSnap;
        private readonly AircraftSnapshot tgtSnap;

        public AggressiveAiPilot(IPilotableAircraft aircraft, IWorldQuery world, AiPilotOptions options = null)
        {
            options ??= new AiPilotOptions();
            this.aircraft = aircraft;
            classic = new AiPilot(aircraft, world, options);
            fsm = new AggressiveTacticalFSM(new FighterTacticalFsmOptions
            {
                GunRange = options.GunRange ?? 900,
                CombatSpeed = options.CombatSpeed ?? 210,
                MaxSpeed = options.MaxSpeed ?? 240,
                OvershootVc = 110,
            });
            fcc = new FlightControlComputer(aircraft, world, new FlightControlComputerOptions
            {
                MaxSpeed = options.MaxSpeed ?? 240,
                HardDeck = options.HardDeck ?? 150,
                PitchKp = options.PitchKp,
                PitchKd = options.PitchKd,
                PitchSlew = options.PitchSlew,
            });

            double corner = options.CombatSpeed ?? 210;
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
            return $"AGGRESSIVE:{lastManeuver}";
        }

        /// <summary>Test hook: current Aggressive tactical posture while engaging.</summary>
        public string GetAggressiveStateLabel() => fsm.GetState().ToString();

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
            AggressiveFlightCommand command = fsm.Update(selfSnap, tgtSnap, delta);
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

            // Approximate target body axes from velocity for scissors / reversal.
            ShawSnapshots.FillTarget(tgtSnap, target.ReadPosition(), target.ReadVelocity());
        }
    }
}

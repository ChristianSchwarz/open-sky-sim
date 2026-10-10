using System;
using Retro.Core;
using static Retro.Sim.AiMath;

namespace Retro.Sim
{
    public sealed class AceTacticalFsmOptions
    {
        public double? GunRange;
        public double? BulletSpeed;
        public double? OvershootVc;
        public double? CombatSpeed;
        public double? MaxSpeed;
    }

    /// <summary>
    /// "Ace" tactical FSM: an elite dogfighter that fights in the vertical, manages
    /// energy deliberately, and finishes with post-stall maneuvers.
    ///
    /// It reuses the same geometry (<see cref="ShawGeometry.ComputeTacticalGeometry"/>)
    /// and <see cref="FlightControlComputer"/> pipeline as the Shaw and Aggressive
    /// models, but differs from both:
    /// - vs. Aggressive (never disengages): the ace *does* extend and zoom-climb
    ///   (RESET) once it is decisively down on energy, then re-enters from above
    ///   rather than grinding out a losing turn circle.
    /// - vs. Shaw (fair doctrinal BFM): every neutral pass is answered in the
    ///   vertical, overshoots are killed with a barrel-roll attack instead of a
    ///   plain lag pursuit, and a bandit that reaches guns range on our six is met
    ///   with a Cobra or Kulbit — a signature post-stall reversal — rather than
    ///   only a break turn or defensive spiral.
    /// - vs. both: the gun envelope here is only *permission* to shoot. The aim
    ///   direction is the full ballistic lead solution (round inherits our own
    ///   velocity, target acceleration extrapolated, gravity drop held over), and
    ///   the pilot layer additionally requires a predicted hit before firing.
    /// </summary>
    public sealed class AceTacticalFSM
    {
        private const double DEG = Math.PI / 180;

        // --- Tactical-state hysteresis ----------------------------------------------
        // Enter/exit thresholds are offset (as in the Shaw and Aggressive FSMs) so
        // geometry sitting right on a boundary doesn't flicker the state — and with it
        // the aim-direction *method* — every frame.
        private const double CONTROL_ENTER_AOT = 70 * DEG;
        private const double CONTROL_EXIT_AOT = 85 * DEG;
        private const double CONTROL_ENTER_RANGE = 3500;
        private const double CONTROL_EXIT_RANGE = 4000;
        private const double EVADE_ENTER_TAA = 45 * DEG;
        private const double EVADE_EXIT_TAA = 60 * DEG;
        private const double EVADE_ENTER_ATA = 110 * DEG;
        private const double EVADE_EXIT_ATA = 95 * DEG;
        private const double EVADE_ENTER_RANGE = 2000;
        private const double EVADE_EXIT_RANGE = 2400;

        // --- Energy discipline ------------------------------------------------------
        // Energy height deficit (m) at which the ace stops fighting for angles and
        // buys energy back instead. Exiting well before parity keeps it from
        // oscillating in and out of RESET around the threshold.
        private const double RESET_ENTER_DEFICIT = 900;
        private const double RESET_EXIT_DEFICIT = 250;
        /// <summary>Below this range the fight is too close to safely turn tail and extend.</summary>
        private const double RESET_MIN_RANGE = 1200;
        /// <summary>A bandit pointing this close at us keeps us in the fight regardless of energy.</summary>
        private const double RESET_MAX_TAA = 70 * DEG;

        // --- Break/reversal side latch ----------------------------------------------
        // Break and scissors direction is a binary left/right choice driven by a dot
        // product that naturally sits near zero, so it needs the same hysteresis the
        // Aggressive FSM uses for its post-merge reversal, or the aircraft snap-rolls
        // left/right/left instead of committing to one side.
        private const double SIDE_LATCH_DEADBAND = 0.25;

        /// <summary>Rolling-scissors barrel rate (rad/s) around the line of sight.</summary>
        private const double SCISSORS_RATE = 1.6;

        /// <summary>Bandit closing this fast (m/s) means an overshoot is developing.</summary>
        private const double DEFAULT_OVERSHOOT_VC = 90;
        /// <summary>Lag-pursuit aim point sits this far (m) behind the bandit.</summary>
        private const double LAG_DISTANCE = 260;

        private static readonly Vec3d WORLD_UP = new Vec3d(0, 1, 0);

        private AceState currentState = AceState.MERGE;
        private AceManeuverType latchedManeuver = AceManeuverType.LEAD_TURN;
        /// <summary>Latched break/scissors direction (-1/0/1).</summary>
        private double breakSide;
        /// <summary>Rolling-scissors barrel phase (rad).</summary>
        private double scissorsPhase;

        private readonly double gunMaxRange;
        private readonly double bulletSpeed;
        private readonly double overshootVc;
        private readonly double combatSpeed;
        private readonly double maxSpeed;

        private Vec3d dir;

        public AceTacticalFSM(AceTacticalFsmOptions options = null)
        {
            options ??= new AceTacticalFsmOptions();
            gunMaxRange = options.GunRange ?? 900;
            bulletSpeed = options.BulletSpeed ?? 1000;
            overshootVc = options.OvershootVc ?? DEFAULT_OVERSHOOT_VC;
            combatSpeed = options.CombatSpeed ?? 200;
            maxSpeed = options.MaxSpeed ?? 240;
        }

        public AceState GetState() => currentState;

        public string GetManeuverLabel() => latchedManeuver.ToString();

        public AceFlightCommand Update(AceSnapshot self, AceSnapshot target, double delta)
        {
            TacticalGeometry geom = ShawGeometry.ComputeTacticalGeometry(self, target);
            AceState nextState = EvaluateState(geom);
            // The barrel phase only accumulates while actually scissoring, so each
            // new rolling scissors starts from the geometry it entered on.
            if (nextState == AceState.EVADE)
            {
                scissorsPhase += SCISSORS_RATE * delta;
            }
            else
            {
                scissorsPhase = 0;
            }
            // Drop the side latch on every state change so the next break/scissors
            // picks a fresh side instead of inheriting a stale one.
            if (nextState != currentState)
            {
                breakSide = 0;
            }
            currentState = nextState;

            switch (currentState)
            {
                case AceState.CONTROL: return ExecuteControl(self, target, geom);
                case AceState.EVADE: return ExecuteEvade(self, geom);
                case AceState.RESET: return ExecuteReset(self, geom);
                case AceState.MERGE:
                default: return ExecuteMerge(self, target, geom);
            }
        }

        /// <summary>
        /// Priority: survive first (EVADE), then refuse to fight on from a hopeless
        /// energy state (RESET), then press the angles we have (CONTROL), else work
        /// the merge. RESET is deliberately gated on *not* being threatened —
        /// extending in front of a bandit already pointing at us is how aircraft
        /// die.
        /// </summary>
        private AceState EvaluateState(TacticalGeometry geom)
        {
            double evadeTaa = currentState == AceState.EVADE ? EVADE_EXIT_TAA : EVADE_ENTER_TAA;
            double evadeAta = currentState == AceState.EVADE ? EVADE_EXIT_ATA : EVADE_ENTER_ATA;
            double evadeRange = currentState == AceState.EVADE ? EVADE_EXIT_RANGE : EVADE_ENTER_RANGE;
            if (geom.Taa < evadeTaa && geom.Ata > evadeAta && geom.Range < evadeRange)
            {
                return AceState.EVADE;
            }

            double resetDeficit = currentState == AceState.RESET ? RESET_EXIT_DEFICIT : RESET_ENTER_DEFICIT;
            if (geom.EnergyDelta < -resetDeficit && geom.Range > RESET_MIN_RANGE && geom.Taa > RESET_MAX_TAA)
            {
                return AceState.RESET;
            }

            double controlAot = currentState == AceState.CONTROL ? CONTROL_EXIT_AOT : CONTROL_ENTER_AOT;
            double controlRange = currentState == AceState.CONTROL ? CONTROL_EXIT_RANGE : CONTROL_ENTER_RANGE;
            if (geom.Aot < controlAot && geom.Range < controlRange)
            {
                return AceState.CONTROL;
            }
            return AceState.MERGE;
        }

        /// <summary>
        /// Latch a binary left/right choice with hysteresis around a dot product
        /// that naturally sits near zero (see SIDE_LATCH_DEADBAND).
        /// </summary>
        private static double ResolveSide(double current, double dot)
        {
            if (current == 0)
            {
                return dot >= 0 ? 1 : -1;
            }
            if (current > 0 && dot < -SIDE_LATCH_DEADBAND) return -1;
            if (current < 0 && dot > SIDE_LATCH_DEADBAND) return 1;
            return current;
        }

        /// <summary>
        /// Full ballistic lead solution; the aim *direction* is what the nose must
        /// track for the round to arrive where the bandit will be. Falls back to
        /// raw LOS if the solution degenerates at zero range.
        /// </summary>
        private void BallisticDirection(AceSnapshot self, AceSnapshot target, TacticalGeometry geom)
        {
            DogfightGeometry.BallisticAimPoint(out Vec3d aim,
                self.Position, self.Velocity,
                target.Position, target.Velocity, target.Acceleration,
                bulletSpeed);
            dir = aim - self.Position;
            if (dir.LengthSquared < 1e-9)
            {
                dir = geom.LosVector;
            }
            else
            {
                dir = Normalize(dir);
            }
        }

        private AceFlightCommand ExecuteControl(AceSnapshot self, AceSnapshot target, TacticalGeometry geom)
        {
            AceManeuverType maneuver = AceManeuverType.LEAD_PURSUIT;
            double targetSpeed = Math.Min(maxSpeed, self.CornerVelocity * 1.05);
            bool useAirbrakes = false;
            bool allowHardTurn = true;

            bool overshooting = geom.ClosureRate > overshootVc;

            if (overshooting && geom.Range < 500)
            {
                // Knife-fight overshoot: barrel-roll around the bandit's flight
                // path. Rolling out of plane stretches our flight path (and so
                // bleeds forward velocity toward theirs) without ever pointing the
                // nose away, which a plain lag pursuit would.
                maneuver = AceManeuverType.BARREL_ROLL_ATTACK;
                breakSide = ResolveSide(breakSide, Vec3d.Dot(self.Right, geom.LosVector));
                dir = Normalize(geom.LosVector
                    .AddScaled(self.Up, 0.85)
                    .AddScaled(self.Right, breakSide * 0.85));
                targetSpeed = self.CornerVelocity * 0.85;
                useAirbrakes = true;
            }
            else if (overshooting && geom.EnergyDelta > 0)
            {
                // Energy to spare: trade the excess closure for altitude and come
                // back down with the angles preserved.
                maneuver = AceManeuverType.HIGH_YO_YO;
                dir = Normalize(geom.LosVector.AddScaled(self.Up, 0.6));
                targetSpeed = self.CornerVelocity;
                allowHardTurn = false;
            }
            else if (overshooting)
            {
                // No energy to yo-yo with: pull to a point behind the bandit and
                // let the range stabilise there.
                maneuver = AceManeuverType.LAG_PURSUIT;
                Vec3d tmp = target.Position.AddScaled(target.Forward, -LAG_DISTANCE);
                dir = Normalize(tmp - self.Position);
                targetSpeed = self.CornerVelocity;
            }
            else if (self.Airspeed < self.CornerVelocity * 0.85 && geom.Range > 700)
            {
                // Slow and not yet in guns: unload downhill to get back to corner
                // speed while cutting across the inside of the bandit's turn.
                maneuver = AceManeuverType.LOW_YO_YO;
                dir = Normalize(geom.LosVector.AddScaled(self.Up, -0.45));
                targetSpeed = maxSpeed;
            }
            else
            {
                BallisticDirection(self, target, geom);
            }

            latchedManeuver = maneuver;
            return new AceFlightCommand
            {
                StateName = AceState.CONTROL,
                ManeuverName = maneuver,
                TargetDirection = dir,
                TargetSpeed = targetSpeed,
                TargetGForce = self.MaxG,
                UseAirbrakes = useAirbrakes,
                FireGuns = geom.Range <= gunMaxRange && geom.Ata < 8 * DEG,
                AllowHardTurn = allowHardTurn,
            };
        }

        private AceFlightCommand ExecuteMerge(AceSnapshot self, AceSnapshot target, TacticalGeometry geom)
        {
            AceManeuverType maneuver = AceManeuverType.LEAD_TURN;
            double targetSpeed = maxSpeed;
            bool fireGuns = false;

            if (geom.Range <= gunMaxRange && geom.Ata < 6 * DEG)
            {
                // A head-on pass is a fleeting shot: take it on the full ballistic
                // solution, and don't wander off the aim line for it.
                maneuver = AceManeuverType.HEAD_ON_SNAPSHOT;
                BallisticDirection(self, target, geom);
                fireGuns = true;
            }
            else if (geom.Range < 1200 && geom.ClosureRate > 0)
            {
                // The ace answer to a merge is the vertical: pull up through the
                // pass so the fight starts with us on top of the bandit's turn
                // circle. The aim sits far enough off the nose that the FCC's
                // hard-turn path takes it as a max-G pull.
                maneuver = AceManeuverType.VERTICAL_REPOSITION;
                dir = Normalize(self.Forward.AddScaled(self.Up, 1.6));
            }
            else
            {
                // Lead turn onto where the bandit will be, biased high so the
                // merge is entered with an altitude advantage.
                double tof = geom.Range / Math.Max(1, bulletSpeed * 0.35);
                Vec3d tmp = target.Position.AddScaled(target.Velocity, tof);
                dir = Normalize(Normalize(tmp - self.Position).AddScaled(WORLD_UP, 0.25));
                targetSpeed = Math.Min(maxSpeed, Math.Max(combatSpeed, self.CornerVelocity * 1.1));
            }

            latchedManeuver = maneuver;
            return new AceFlightCommand
            {
                StateName = AceState.MERGE,
                ManeuverName = maneuver,
                TargetDirection = dir,
                TargetSpeed = targetSpeed,
                TargetGForce = self.MaxG,
                UseAirbrakes = false,
                FireGuns = fireGuns,
                AllowHardTurn = true,
            };
        }

        private AceFlightCommand ExecuteEvade(AceSnapshot self, TacticalGeometry geom)
        {
            AceManeuverType maneuver;
            double targetSpeed = Math.Min(maxSpeed, self.CornerVelocity);
            bool useAirbrakes = false;
            PostStallRequest? postStall = null;
            bool fireGuns = false;

            if (geom.Range < 550 && geom.ClosureRate > overshootVc * 0.5)
            {
                // Guns-range bandit closing fast: brake out from in front of their
                // gun solution. The pilot vetoes this if there is no room for it.
                maneuver = AceManeuverType.COBRA_BRAKE;
                postStall = PostStallRequest.COBRA;
                dir = Normalize(self.Forward.AddScaled(self.Up, 1.2));
                targetSpeed = self.CornerVelocity * 0.6;
                useAirbrakes = true;
            }
            else if (geom.Range < 800 && geom.ClosureRate < -10)
            {
                // They slid past: flip the nose straight back onto them before the
                // separation lets them re-enter.
                maneuver = AceManeuverType.KULBIT;
                postStall = PostStallRequest.KULBIT;
                dir = geom.LosVector;
                fireGuns = geom.Ata < 12 * DEG && geom.Range <= gunMaxRange;
            }
            else if (geom.Range < 900)
            {
                // Rolling scissors: barrel out of plane around the line of sight so
                // the bandit's tracking solution never settles and their own
                // closure forces the overshoot for us.
                maneuver = AceManeuverType.ROLLING_SCISSORS;
                breakSide = ResolveSide(breakSide, Vec3d.Dot(self.Right, geom.LosVector));
                double c = JsTrig.Cos(scissorsPhase);
                double s = JsTrig.Sin(scissorsPhase);
                dir = Normalize(geom.LosVector
                    .AddScaled(self.Right, breakSide * c * 0.9)
                    .AddScaled(self.Up, s * 0.9));
                fireGuns = geom.Ata < 10 * DEG && geom.Range <= gunMaxRange;
            }
            else if (self.Altitude > 1500 && geom.EnergyDelta > -RESET_ENTER_DEFICIT)
            {
                // Descending max-rate spiral: the turn is tighter and gravity pays
                // for the G, so the bandit has to match it while bleeding.
                maneuver = AceManeuverType.DEFENSIVE_SPIRAL;
                breakSide = ResolveSide(breakSide, Vec3d.Dot(self.Right, geom.LosVector));
                dir = Normalize((self.Right * breakSide)
                    .AddScaled(geom.LosVector, 0.7)
                    .AddScaled(self.Up, -0.5));
                targetSpeed = maxSpeed;
            }
            else
            {
                // Plain max-G break into the threat: the shortest path out of their
                // gun envelope, and the start of every angles fight.
                maneuver = AceManeuverType.BREAK_TURN;
                breakSide = ResolveSide(breakSide, Vec3d.Dot(self.Right, geom.LosVector));
                dir = Normalize((self.Right * breakSide)
                    .AddScaled(geom.LosVector, 0.5));
            }

            latchedManeuver = maneuver;
            return new AceFlightCommand
            {
                StateName = AceState.EVADE,
                ManeuverName = maneuver,
                TargetDirection = dir,
                TargetSpeed = targetSpeed,
                TargetGForce = self.MaxG,
                UseAirbrakes = useAirbrakes,
                FireGuns = fireGuns,
                AllowHardTurn = true,
                PostStall = postStall,
            };
        }

        private AceFlightCommand ExecuteReset(AceSnapshot self, TacticalGeometry geom)
        {
            AceManeuverType maneuver;

            if (self.Altitude > 2500 && self.Airspeed < self.CornerVelocity)
            {
                // Altitude in the bank but no speed: sell the altitude back for
                // corner speed while the nose comes around onto the bandit.
                maneuver = AceManeuverType.SPLIT_S;
                dir = Normalize(geom.LosVector.AddScaled(self.Up, -1.1));
            }
            else
            {
                // Extend away and zoom: the separation buys the seconds the climb
                // needs, and the re-entry then comes from above.
                maneuver = AceManeuverType.ZOOM_CLIMB;
                dir = Normalize((geom.LosVector * -1).AddScaled(self.Up, 0.7));
            }

            latchedManeuver = maneuver;
            return new AceFlightCommand
            {
                StateName = AceState.RESET,
                ManeuverName = maneuver,
                TargetDirection = dir,
                TargetSpeed = maxSpeed,
                TargetGForce = self.MaxG * 0.6,
                UseAirbrakes = false,
                // Never spend a trigger pull while deliberately not pointing at them.
                FireGuns = false,
                AllowHardTurn = true,
            };
        }
    }
}

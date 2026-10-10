using System;
using Retro.Core;
using static Retro.Sim.AiMath;

namespace Retro.Sim
{
    /// <summary>
    /// "Berserker" tactical FSM: a maximally aggressive fighter doctrine, reusing
    /// the same geometry (<see cref="ShawGeometry.ComputeTacticalGeometry"/>) and
    /// flight-control pipeline as <see cref="FighterTacticalFSM"/> (Shaw) but with a
    /// very different philosophy.
    ///
    /// Unlike the balanced BFM <see cref="AiPilot"/> (which disengages via EXTEND to
    /// rebuild energy and breaks defensively off a tracking threat) or Shaw's fair
    /// doctrinal Offensive/Neutral/Defensive matrix, this model:
    /// - Never disengages/extends to rebuild energy — it always presses the attack
    ///   regardless of energy state.
    /// - Never breaks defensively away from a threat — a bandit tracking us from
    ///   the rear is answered with a scissors counter-attack turned *into* the
    ///   threat, not a break turn or defensive spiral away from it.
    /// - Commits to head-on gunfights on a neutral merge instead of a cautious
    ///   lead turn / energy climb.
    /// - Fires with a wider tracking-angle cone and out to a longer range than
    ///   Shaw/Classic, trading accuracy for constant pressure (snap-shooting).
    /// </summary>
    public sealed class AggressiveTacticalFSM
    {
        // --- Side-selection latch --------------------------------------------------
        // Picking which way to reverse after a merge (POST_MERGE_REVERSAL) is a
        // binary left/right choice driven by the sign of a dot product that
        // naturally sits near zero while the two aircraft rotate relative to each
        // other. Without hysteresis that sign flips almost every frame, which reads
        // as the aircraft snap-rolling left/right/left instead of committing to one
        // direction — the same class of bug the heading-error turn latches elsewhere
        // (e.g. AiPilot's TURN_LATCH_ENTER/RELEASE) exist to prevent.
        // (SCISSORS_COUNTER has no such choice: it always turns straight at the
        // bandit's bearing — see ExecuteCounter.)
        private const double SIDE_LATCH_DEADBAND = 0.25;

        // --- Tactical-state hysteresis ----------------------------------------------
        // Enter/exit thresholds are offset so geometry sitting right at a boundary
        // doesn't flicker the state (and therefore the aim-direction *method* —
        // e.g. lead-pursuit intercept vs. raw LOS) every frame.
        private const double ATTACK_ENTER_AOT = 75 * Math.PI / 180;
        private const double ATTACK_EXIT_AOT = 90 * Math.PI / 180;
        private const double ATTACK_ENTER_RANGE = 5000;
        private const double ATTACK_EXIT_RANGE = 5500;
        private const double COUNTER_ENTER_TAA = 60 * Math.PI / 180;
        private const double COUNTER_EXIT_TAA = 75 * Math.PI / 180;
        private const double COUNTER_ENTER_ATA = 120 * Math.PI / 180;
        private const double COUNTER_EXIT_ATA = 105 * Math.PI / 180;
        private const double COUNTER_ENTER_RANGE = 2500;
        private const double COUNTER_EXIT_RANGE = 2750;

        private AggressiveState currentState = AggressiveState.MERGE;
        private AggressiveManeuverType latchedManeuver = AggressiveManeuverType.HEAD_ON_PRESS;
        /// <summary>Latched reversal direction for POST_MERGE_REVERSAL (-1/0/1).</summary>
        private double mergeReversalSide;

        private readonly double gunMaxRange;
        /// <summary>Snap-shoot beyond the "clean" gun range: trades accuracy for pressure.</summary>
        private readonly double snapShotRange;
        private readonly double overshootVc;
        private readonly double combatSpeed;
        private readonly double maxSpeed;

        public AggressiveTacticalFSM(FighterTacticalFsmOptions options = null)
        {
            options ??= new FighterTacticalFsmOptions();
            gunMaxRange = options.GunRange ?? 900;
            snapShotRange = gunMaxRange * 1.2;
            // Looser than Shaw's default (80): tolerates more closure before
            // yo-yo-ing away, staying nose-on/close far longer.
            overshootVc = options.OvershootVc ?? 110;
            combatSpeed = options.CombatSpeed ?? 210;
            maxSpeed = options.MaxSpeed ?? 240;
        }

        public AggressiveState GetState() => currentState;

        public string GetManeuverLabel() => latchedManeuver.ToString();

        public AggressiveFlightCommand Update(AircraftSnapshot self, AircraftSnapshot target, double delta)
        {
            TacticalGeometry geom = ShawGeometry.ComputeTacticalGeometry(self, target);
            AggressiveState nextState = EvaluateState(geom);
            // Reset the reversal-side latch whenever we're not in MERGE, so the
            // *next* time we enter it picks a fresh side from the current
            // geometry instead of inheriting a stale one.
            if (nextState != AggressiveState.MERGE) mergeReversalSide = 0;
            currentState = nextState;

            switch (currentState)
            {
                case AggressiveState.COUNTER: return ExecuteCounter(self, target, geom);
                case AggressiveState.ATTACK: return ExecuteAttack(self, target, geom);
                case AggressiveState.MERGE:
                default: return ExecuteMerge(self, target, geom);
            }
        }

        /// <summary>
        /// Threat detection mirrors the doctrinal models' geometry (bandit
        /// tracking us from our rear hemisphere, in range) but the *response*
        /// never disengages — see ExecuteCounter. Offense is judged more
        /// generously (wider cone, longer range) than Shaw/Classic, matching the
        /// doctrine of always pressing rather than holding out for a clean shot.
        /// Thresholds widen once already in a state (hysteresis) so geometry
        /// sitting right at a boundary doesn't flicker the state every frame.
        /// </summary>
        private AggressiveState EvaluateState(TacticalGeometry geom)
        {
            double counterTaa = currentState == AggressiveState.COUNTER ? COUNTER_EXIT_TAA : COUNTER_ENTER_TAA;
            double counterAta = currentState == AggressiveState.COUNTER ? COUNTER_EXIT_ATA : COUNTER_ENTER_ATA;
            double counterRange = currentState == AggressiveState.COUNTER ? COUNTER_EXIT_RANGE : COUNTER_ENTER_RANGE;
            if (geom.Taa < counterTaa && geom.Ata > counterAta && geom.Range < counterRange)
            {
                return AggressiveState.COUNTER;
            }
            double attackAot = currentState == AggressiveState.ATTACK ? ATTACK_EXIT_AOT : ATTACK_ENTER_AOT;
            double attackRange = currentState == AggressiveState.ATTACK ? ATTACK_EXIT_RANGE : ATTACK_ENTER_RANGE;
            if (geom.Aot < attackAot && geom.Range < attackRange)
            {
                return AggressiveState.ATTACK;
            }
            return AggressiveState.MERGE;
        }

        /// <summary>
        /// Latch a binary left/right choice with hysteresis around a dot product
        /// that naturally sits near zero (see SIDE_LATCH_DEADBAND) so the chosen
        /// side only flips once the geometry has clearly crossed over, instead of
        /// chattering every frame.
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

        private AggressiveFlightCommand ExecuteAttack(AircraftSnapshot self, AircraftSnapshot target, TacticalGeometry geom)
        {
            AggressiveManeuverType maneuver = AggressiveManeuverType.LEAD_PURSUIT;
            double targetSpeed = Math.Min(maxSpeed, combatSpeed * 1.05);
            bool allowHardTurn = true;
            Vec3d dir;

            // High yo-yo only when an overshoot is truly imminent at knife-fight
            // range — no low-yo-yo/lag-pursuit caution otherwise, it just muscles
            // the lead-pursuit turn at max-G.
            if (geom.ClosureRate > overshootVc && geom.Range < 700)
            {
                maneuver = AggressiveManeuverType.HIGH_YO_YO;
                dir = Normalize(geom.LosVector.AddScaled(self.Up, 0.55));
                targetSpeed = combatSpeed * 0.9;
                allowHardTurn = false;
            }
            else
            {
                double tof = geom.Range / 800;
                Vec3d lead = target.Position.AddScaled(target.Velocity, tof);
                dir = Normalize(lead - self.Position);
            }

            latchedManeuver = maneuver;
            bool fireGuns = geom.Range <= snapShotRange && geom.Ata < 14 * Math.PI / 180;
            return new AggressiveFlightCommand
            {
                StateName = AggressiveState.ATTACK,
                ManeuverName = maneuver,
                TargetDirection = dir,
                TargetSpeed = targetSpeed,
                TargetGForce = self.MaxG,
                UseAirbrakes = false,
                FireGuns = fireGuns,
                AllowHardTurn = allowHardTurn,
            };
        }

        private AggressiveFlightCommand ExecuteMerge(AircraftSnapshot self, AircraftSnapshot target, TacticalGeometry geom)
        {
            // No lead turn / energy climb finesse: drive nose-to-nose and take
            // the gunfight if it's in range, then commit to the tightest
            // possible reversal to regain an offensive angle right after the pass.
            AggressiveManeuverType maneuver = AggressiveManeuverType.HEAD_ON_PRESS;
            Vec3d dir = geom.LosVector;
            double targetSpeed = Math.Min(maxSpeed, combatSpeed * 1.1);

            if (geom.Range < 1500 && geom.ClosureRate > 0)
            {
                maneuver = AggressiveManeuverType.POST_MERGE_REVERSAL;
                mergeReversalSide = ResolveSide(mergeReversalSide, Vec3d.Dot(self.Right, target.Velocity));
                dir = Normalize(self.Forward.AddScaled(self.Right, mergeReversalSide * 1.4));
            }

            latchedManeuver = maneuver;
            return new AggressiveFlightCommand
            {
                StateName = AggressiveState.MERGE,
                ManeuverName = maneuver,
                TargetDirection = dir,
                TargetSpeed = targetSpeed,
                TargetGForce = self.MaxG,
                UseAirbrakes = false,
                FireGuns = geom.Range <= snapShotRange && geom.Ata < 10 * Math.PI / 180,
                AllowHardTurn = true,
            };
        }

        private AggressiveFlightCommand ExecuteCounter(AircraftSnapshot self, AircraftSnapshot target, TacticalGeometry geom)
        {
            // Never break away: always turn straight at the bandit's current
            // bearing — not away from it, and not toward some computed
            // lateral "cut" that can point somewhere else entirely — closing the
            // angle as fast as possible forces an overshoot instead of extending
            // range to escape. This is the core "never flees" trait. A slight
            // upward bias keeps it a scissoring pull rather than a flat, literal
            // collision course (mirrors AiPilot's alwaysEngage scissors-into-threat).
            const AggressiveManeuverType maneuver = AggressiveManeuverType.SCISSORS_COUNTER;
            Vec3d dir = Normalize(geom.LosVector.AddScaled(self.Up, 0.12));

            latchedManeuver = maneuver;
            return new AggressiveFlightCommand
            {
                StateName = AggressiveState.COUNTER,
                ManeuverName = maneuver,
                TargetDirection = dir,
                TargetSpeed = Math.Min(maxSpeed, self.CornerVelocity * 1.05),
                TargetGForce = self.MaxG,
                UseAirbrakes = false,
                FireGuns = geom.Range <= snapShotRange && geom.Ata < 14 * Math.PI / 180,
                AllowHardTurn = true,
            };
        }
    }
}

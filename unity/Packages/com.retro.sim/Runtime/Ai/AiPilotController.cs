namespace Retro.Sim
{
    /// <summary>
    /// Shared surface for every in-worker AI pilot model (classic BFM and Shaw).
    /// CombatSim only talks to this contract — never to a concrete class.
    /// </summary>
    public interface IAiPilotController
    {
        void Update(double delta);
        void SetPhase(AiFlightPhase phase);
        void SetTarget(ICombatant target);
        /// <summary>
        /// Aircraft whose wing this pilot flies in <see cref="AiFlightPhase.FORMATION"/>
        /// (the wingman role). Independent of <see cref="SetTarget"/>, which stays the
        /// bandit: a wingman needs both to peel off and to rejoin afterwards.
        /// </summary>
        void SetFormationLead(ICombatant lead);
        AiFlightPhase GetPhase();
        bool IsFiring { get; }
        /// <summary>Short maneuver / phase label for MFD telemetry and tests.</summary>
        string GetManeuverLabel();
    }
}

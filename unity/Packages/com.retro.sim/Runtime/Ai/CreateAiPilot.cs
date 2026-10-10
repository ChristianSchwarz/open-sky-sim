namespace Retro.Sim
{
    /// <summary>Which AI pilot model to instantiate (state/gameDefs.ts AiPilotModels).</summary>
    public enum AiPilotModels
    {
        CLASSIC,
        SHAW,
        AGGRESSIVE,
        ACE,
    }

    public static class AiPilotFactory
    {
        /// <summary>
        /// Build the in-worker AI pilot for the requested model. Omitting
        /// <see cref="AiPilotOptions.Model"/> (or CLASSIC) preserves prior behaviour.
        /// </summary>
        public static IAiPilotController CreateAiPilot(IPilotableAircraft aircraft, IWorldQuery world, AiPilotOptions options = null)
        {
            options ??= new AiPilotOptions();
            AiPilotModels model = options.Model ?? AiPilotModels.CLASSIC;
            if (model == AiPilotModels.SHAW)
            {
                return new ShawAiPilot(aircraft, world, options);
            }
            if (model == AiPilotModels.AGGRESSIVE)
            {
                return new AggressiveAiPilot(aircraft, world, options);
            }
            if (model == AiPilotModels.ACE)
            {
                return new AceAiPilot(aircraft, world, options);
            }
            return new AiPilot(aircraft, world, options);
        }
    }
}

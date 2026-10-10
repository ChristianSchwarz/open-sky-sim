using System;

namespace Retro.Sim
{
    /// <summary>FM3 physical post-stall model. STUB: replaced by the port of physics/model/fm3FlightModel.ts.</summary>
    public class Fm3FlightModel : FlightModel
    {
        public Fm3FlightModel(Fm2AircraftConfig config = null)
        {
        }

        public override void Step(double delta) => throw new NotImplementedException("FM3 not ported yet");

        public override double GetStallStatus() => throw new NotImplementedException("FM3 not ported yet");
    }
}

using System;

namespace Retro.Sim
{
    /// <summary>FM2 rigid-body "parts" model. STUB: replaced by the port of physics/model/fm2FlightModel.ts.</summary>
    public class Fm2FlightModel : FlightModel
    {
        public Fm2FlightModel(Fm2AircraftConfig config = null)
        {
        }

        public override void Step(double delta) => throw new NotImplementedException("FM2 not ported yet");

        public override double GetStallStatus() => throw new NotImplementedException("FM2 not ported yet");
    }
}

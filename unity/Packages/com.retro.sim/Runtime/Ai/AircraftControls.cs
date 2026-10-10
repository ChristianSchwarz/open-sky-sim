using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// Command sink for an aircraft: exactly the normalized inputs a human pilot
    /// produces. An AI pilot writes to this and never touches physics or control
    /// surfaces directly (see <see cref="IAircraftObservation"/> for the matching
    /// state source). Both the player's plane and a spawned opponent implement it.
    /// </summary>
    public interface IAircraftControlChannel
    {
        /// <summary>[-1, 1], +1 = nose up (aft stick).</summary>
        void SetPitch(double pitch);
        /// <summary>[-1, 1], +1 = roll right.</summary>
        void SetRoll(double roll);
        /// <summary>[-1, 1], +1 = nose right (right pedal).</summary>
        void SetYaw(double yaw);
        /// <summary>[0, 1], 0 = idle, 1 = full (afterburner for AB-capable jets).</summary>
        void SetThrottle(double throttle);
        void SetWheelBrakes(bool applied);
        void SetLandingGearDeployed(bool deployed);
        void SetFlapsExtended(bool extended);
        void SetAirbrakesExtended(bool extended);
    }

    /// <summary>
    /// Read-only rigid-body / envelope state an AI pilot observes each frame.
    /// </summary>
    public interface IAircraftObservation
    {
        /// <summary>World position (m).</summary>
        Vec3d GetPosition();
        /// <summary>World velocity (m/s).</summary>
        Vec3d GetVelocity();
        /// <summary>Body orientation.</summary>
        Quatd GetQuaternion();
        /// <summary>Speed over ground (m/s).</summary>
        double GetAirspeed();
        /// <summary>Altitude above the flat datum (m) — equal to position.y.</summary>
        double GetAltitude();
        /// <summary>Angle of attack (rad).</summary>
        double GetAngleOfAttack();
        /// <summary>Load factor (g).</summary>
        double GetLoadFactorG();
        /// <summary>&gt;= 0 means stalling.</summary>
        double GetStallStatus();
        bool IsLanded();
        bool IsCrashed();
        bool IsGearDeployed();
        bool IsFlapsExtended();
        bool IsAirbrakesExtended();
    }

    /// <summary>An aircraft an <see cref="AiPilot"/> can fully fly: it both accepts commands and reports state.</summary>
    public interface IPilotableAircraft : IAircraftControlChannel, IAircraftObservation { }
}

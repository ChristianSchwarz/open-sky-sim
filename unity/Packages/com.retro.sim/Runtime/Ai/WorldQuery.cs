using System.Collections.Generic;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>A static world obstacle approximated as an upright cylinder for avoidance.</summary>
    public sealed class Obstacle
    {
        /// <summary>Base position (ground level) in world space.</summary>
        public Vec3d Position;
        /// <summary>Horizontal safety radius (m).</summary>
        public double Radius;
        /// <summary>Top height above ground (m).</summary>
        public double Height;
    }

    /// <summary>One runway an AI can take off from or land on.</summary>
    public sealed class Runway
    {
        /// <summary>Runway centre (threshold-to-threshold midpoint), world space.</summary>
        public Vec3d Center;
        /// <summary>Runway heading (rad), 0 = aligned with +Z (approach from -Z).</summary>
        public double Heading;
        /// <summary>Half the paved length along the runway axis (m).</summary>
        public double HalfLength;
        /// <summary>Half the paved width across the runway axis (m).</summary>
        public double HalfWidth;
    }

    /// <summary>
    /// Read-only view of the world an AI pilot uses for terrain/obstacle clearance
    /// and navigation (port of the WorldQuery interface in ai/worldQuery.ts).
    /// <see cref="IGroundQuery.GroundHeightAt"/> is the highest solid ground Y at
    /// (x, z): flat datum, hills, ski jumps, surface pads, scenery + carrier meshes.
    /// </summary>
    public interface IWorldQuery : IGroundQuery
    {
        /// <summary>True if (x, z) is over land rather than water.</summary>
        bool IsLand(double x, double z);
        /// <summary>All static building/scenery obstacles.</summary>
        IReadOnlyList<Obstacle> Obstacles();
        /// <summary>
        /// Every runway in the play area, longest first. A pilot picks once and
        /// keeps it — see <see cref="NearestRunway"/> — rather than re-deciding
        /// mid-approach, which would hand off to a different runway the moment
        /// one drifted closer.
        /// </summary>
        IReadOnlyList<Runway> Runways();
        /// <summary>The main runway of the area: the one a session starts on.</summary>
        Runway Runway();
        /// <summary>Closest runway to a point, for choosing somewhere to come home to.</summary>
        Runway NearestRunway(double x, double z);
    }

    /// <summary>
    /// The obstacle lookup the TypeScript reaches through
    /// <c>world instanceof SceneWorldQuery</c> (AiPilot.avoidObstacles). The
    /// scene-backed world query is not ported yet; when it is, it implements
    /// this, and worlds that do not (test worlds) skip obstacle avoidance
    /// exactly as the TypeScript does for non-scene worlds.
    /// </summary>
    public interface ISceneObstacleQuery
    {
        /// <summary>Nearest obstacle whose edge lies within <paramref name="horizon"/> of (x, z), or null.</summary>
        Obstacle NearestObstacleWithin(double x, double z, double horizon);
    }
}

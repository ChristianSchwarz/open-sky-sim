using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// Ground that moves, such as a carrier deck steaming along (port of
    /// scene/entities/movingSurface.ts MovingSurface). Things that come to rest
    /// on it (wreckage, a lake of burning fuel, scorch marks) go with it instead
    /// of being left behind in the world.
    /// </summary>
    public interface IMovingSurface
    {
        /// <summary>The surface's velocity (m/s), live: read every frame.</summary>
        Vec3d Velocity { get; }

        /// <summary>Whether a point is standing on the surface (on the deck, not high above it or in the sea beside it).</summary>
        bool Contains(double x, double y, double z);
    }
}

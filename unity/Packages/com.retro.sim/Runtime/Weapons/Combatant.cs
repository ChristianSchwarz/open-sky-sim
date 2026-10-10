using Retro.Core;

namespace Retro.Sim
{
    public enum Faction
    {
        PLAYER,
        ENEMY,
    }

    /// <summary>Something a gun can hit and damage, and an AI pilot can pursue (port of weapons/combatant.ts).</summary>
    public interface ICombatant
    {
        Faction Faction { get; }
        /// <summary>The current world position (m).</summary>
        Vec3d ReadPosition();
        /// <summary>The current world velocity (m/s).</summary>
        Vec3d ReadVelocity();
        /// <summary>Hit-sphere radius (m).</summary>
        double GetHitRadius();
        /// <summary>Still a valid, targetable, damageable entity.</summary>
        bool IsAlive();
        /// <summary>Apply <paramref name="amount"/> points of damage (from a projectile hit).</summary>
        void ApplyDamage(double amount);
    }
}

using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// Wingtip trail origins from a body model's vertices (port of wingtipOrigins.ts),
    /// for aircraft whose def carries no <c>fx.wingtips</c> (the built-in F-22).
    /// </summary>
    public static class WingtipOrigins
    {
        /// <summary>
        /// countBodyMeshVertices: the input is LOD0's body-mesh positions (volumes then
        /// flats, every mesh's position attribute in order), xyz float32 triples in
        /// the body frame of the scene (+X left wing, +Y up, +Z forward).
        /// </summary>
        public static int CountVertices(ReadOnlySpan<float> lod0Positions) => lod0Positions.Length / 3;

        /// <summary>
        /// deriveWingtipOriginsFromModel: the outermost vertex on each side (x &gt; 0.05 is
        /// the left wing, x &lt; -0.05 the right; first of equals wins). Null with fewer
        /// than 8 vertices, an empty side, a tip within 0.3 m of the centreline or a
        /// span under 0.6 m.
        /// </summary>
        public static (Vec3d Left, Vec3d Right)? Derive(ReadOnlySpan<float> lod0Positions)
        {
            int count = lod0Positions.Length / 3;
            if (count < 8) return null;
            int left = -1, right = -1;
            for (int i = 0; i < count; i++)
            {
                float x = lod0Positions[i * 3];
                if (x > 0.05)
                {
                    if (left < 0 || x > lod0Positions[left * 3]) left = i;
                }
                else if (x < -0.05)
                {
                    if (right < 0 || x < lod0Positions[right * 3]) right = i;
                }
            }
            if (left < 0 || right < 0) return null;
            Vec3d l = At(lod0Positions, left), r = At(lod0Positions, right);
            if (l.X < 0.3 || r.X > -0.3 || l.X - r.X < 0.6) return null;
            return (l, r);
        }

        private static Vec3d At(ReadOnlySpan<float> p, int i) => new Vec3d(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    }
}

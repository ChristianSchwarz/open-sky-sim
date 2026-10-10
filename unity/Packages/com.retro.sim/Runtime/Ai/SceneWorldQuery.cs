using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// Concrete <see cref="IWorldQuery"/> backed by hill colliders, ski jumps,
    /// carrier meshes, a land/water sampler, the static obstacle list and the
    /// runways (port of SceneWorldQuery in ai/worldQuery.ts). Implements
    /// <see cref="ISceneObstacleQuery"/>, which is what the AI pilot's
    /// <c>instanceof SceneWorldQuery</c> obstacle check tests for.
    /// </summary>
    public sealed class SceneWorldQuery : IWorldQuery, ISceneObstacleQuery
    {
        private readonly List<HillCollider> hills;
        private readonly Func<double, double, bool> isLandFn;
        private readonly List<Obstacle> obstacleList;
        private readonly IReadOnlyList<Runway> runwayList;
        private readonly IReadOnlyList<SkiJumpCollider> skiJumps;
        private readonly IReadOnlyList<CarrierMeshCollider> carrierMeshes;
        private readonly Func<double, double, double> baseHeightAt;
        private readonly IReadOnlyList<CarrierMeshCollider> sceneryMeshes;
        private readonly SurfacePadIndex padIndex;

        public SceneWorldQuery(
            List<HillCollider> hills,
            Func<double, double, bool> isLandFn,
            List<Obstacle> obstacleList,
            IReadOnlyList<Runway> runwayList,
            IReadOnlyList<SkiJumpCollider> skiJumps = null,
            IReadOnlyList<CarrierMeshCollider> carrierMeshes = null,
            Func<double, double, double> baseHeightAt = null,
            IReadOnlyList<SurfacePadCollider> surfacePads = null,
            IReadOnlyList<CarrierMeshCollider> sceneryMeshes = null)
        {
            this.hills = hills;
            this.isLandFn = isLandFn;
            this.obstacleList = obstacleList;
            this.runwayList = runwayList;
            this.skiJumps = skiJumps ?? Array.Empty<SkiJumpCollider>();
            this.carrierMeshes = carrierMeshes ?? Array.Empty<CarrierMeshCollider>();
            this.baseHeightAt = baseHeightAt ?? ((x, z) => 0);
            this.sceneryMeshes = sceneryMeshes ?? Array.Empty<CarrierMeshCollider>();
            padIndex = new SurfacePadIndex(surfacePads ?? Array.Empty<SurfacePadCollider>());
        }

        /// <summary>
        /// More static ground after the world was built (an airfield's buildings
        /// streamed in mid-flight), appended in place so every holder sees them.
        /// </summary>
        public void AddStaticColliders(IReadOnlyList<SurfacePadCollider> pads, IReadOnlyList<Obstacle> obstacles)
        {
            padIndex.Add(pads);
            obstacleList.AddRange(obstacles);
        }

        public double GroundHeightAt(double x, double z)
        {
            // Math.max(a, b, c, d, e, f) folded left; NaN propagates as in JS.
            double m = baseHeightAt(x, z);
            m = Math.Max(m, HillColliders.SampleHillSurfaceY(x, z, hills));
            m = Math.Max(m, SkiJump.SampleSkiJumpSurfaceYMax(x, z, skiJumps));
            m = Math.Max(m, padIndex.SampleYMax(x, z));
            m = Math.Max(m, CarrierDeck.SampleCarrierMeshSurfaceYMax(x, z, sceneryMeshes));
            m = Math.Max(m, CarrierHeightAt(x, z));
            return m;
        }

        /// <summary>Carrier-deck surface Y at (x, z), or -Infinity if no carrier triangle covers it.</summary>
        public double CarrierHeightAt(double x, double z)
        {
            return CarrierDeck.SampleCarrierMeshSurfaceYMax(x, z, carrierMeshes);
        }

        /// <summary>First carrier mesh origin, or false if none.</summary>
        public bool CarrierOrigin(out Vec3d origin)
        {
            if (carrierMeshes.Count == 0)
            {
                origin = default;
                return false;
            }
            CarrierMeshCollider c = carrierMeshes[0];
            origin = new Vec3d(c.OriginX, c.OriginY, c.OriginZ);
            return true;
        }

        public bool IsLand(double x, double z) => isLandFn(x, z);

        public IReadOnlyList<Obstacle> Obstacles() => obstacleList;

        public IReadOnlyList<Runway> Runways() => runwayList;

        public Runway Runway() => runwayList.Count > 0 ? runwayList[0] : null;

        public Runway NearestRunway(double x, double z)
        {
            Runway best = runwayList.Count > 0 ? runwayList[0] : null;
            double bestSq = double.PositiveInfinity;
            for (int i = 0; i < runwayList.Count; i++)
            {
                Runway r = runwayList[i];
                double dx = r.Center.X - x;
                double dz = r.Center.Z - z;
                double d = dx * dx + dz * dz;
                if (d < bestSq)
                {
                    bestSq = d;
                    best = r;
                }
            }
            return best;
        }

        /// <summary>Move carrier collision soups when the ship translates (local mesh frame unchanged).</summary>
        public void SetCarrierMeshOrigins(IReadOnlyList<Vec3d> origins)
        {
            for (int i = 0; i < carrierMeshes.Count && i < origins.Count; i++)
            {
                CarrierMeshCollider c = carrierMeshes[i];
                c.OriginX = origins[i].X;
                c.OriginY = origins[i].Y;
                c.OriginZ = origins[i].Z;
            }
        }

        /// <summary>Nearest obstacle whose safety cylinder the point is within `horizon` metres of, or null.</summary>
        public Obstacle NearestObstacleWithin(double x, double z, double horizon)
        {
            Obstacle best = null;
            double bestDist = double.PositiveInfinity;
            for (int i = 0; i < obstacleList.Count; i++)
            {
                Obstacle o = obstacleList[i];
                // TMP.set(dx, 0, dz).length(): sqrt of the sum of squares.
                double dx = x - o.Position.X, dz = z - o.Position.Z;
                double d = Math.Sqrt(dx * dx + 0 * 0 + dz * dz) - o.Radius;
                if (d < horizon && d < bestDist)
                {
                    bestDist = d;
                    best = o;
                }
            }
            return best;
        }
    }
}

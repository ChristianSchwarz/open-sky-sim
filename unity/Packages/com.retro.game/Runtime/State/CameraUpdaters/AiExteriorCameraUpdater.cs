using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// aiExteriorCameraUpdater.ts: F6 exterior view - mirror of F2, but
    /// orbiting the AI opponent and looking at the player. Press F6 again to
    /// toggle behind/front of the enemy.
    /// </summary>
    public sealed class AiExteriorCameraUpdater : CameraUpdater
    {
        /// <summary>Initial opponent standoff ahead of the player (m).</summary>
        public const double AiSpawnDistanceM = 500;

        /// <summary>Match the F2 exterior back/front offset (m).</summary>
        private const double ExteriorChaseDistanceM = 40;
        private const double ExteriorChaseHeightM = 5;

        private readonly IChaseTarget _orbitSubject;
        private ExteriorViewHeading _heading;

        public AiExteriorCameraUpdater(
            ICameraActor actor, CameraPose camera, IChaseTarget orbitSubject,
            ExteriorViewHeading heading = ExteriorViewHeading.Back)
            : base(actor, camera)
        {
            _orbitSubject = orbitSubject;
            _heading = heading;
        }

        public void SetHeading(ExteriorViewHeading heading)
        {
            _heading = heading;
        }

        public override void Update(double delta)
        {
            Vec3d subjectPos = _orbitSubject.GetDisplayPosition();
            Vec3d playerPos = actor.GetDisplayPosition();

            Vec3d v = SceneAxes.Forward.Rotate(_orbitSubject.GetDisplayQuaternion());
            v.Y = 0;
            if (v.LengthSquared < 1e-6)
            {
                v = new Vec3d(0, 0, 1);
            }
            else
            {
                v = v.Normalized();
            }

            camera.Position = subjectPos;
            camera.LookAt(playerPos);
            camera.Position = camera.Position
                .AddScaled(SceneAxes.Up, ExteriorChaseHeightM)
                .AddScaled(v, ExteriorChaseDistanceM * (_heading == ExteriorViewHeading.Back ? 1 : -1));
            camera.LookAt(playerPos);
        }
    }
}

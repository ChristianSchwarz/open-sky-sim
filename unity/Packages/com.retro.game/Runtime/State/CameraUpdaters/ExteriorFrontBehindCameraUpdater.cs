using Retro.Core;

namespace Retro.Game
{
    public enum ExteriorViewHeading
    {
        Front,
        Back,
    }

    /// <summary>exteriorFrontBehindCameraUpdater.ts: chase view ahead of or behind the player, or orbiting it toward a target.</summary>
    public sealed class ExteriorFrontBehindCameraUpdater : CameraUpdater
    {
        private readonly ExteriorViewHeading _heading;
        private IChaseTarget _lookAtTarget;

        public ExteriorFrontBehindCameraUpdater(ICameraActor actor, CameraPose camera, ExteriorViewHeading heading)
            : base(actor, camera)
        {
            _heading = heading;
        }

        public void SetLookAtTarget(IChaseTarget target)
        {
            _lookAtTarget = target;
        }

        public override void Update(double delta)
        {
            Vec3d playerPos = actor.GetDisplayPosition();

            if (_lookAtTarget != null)
            {
                Vec3d enemyPos = _lookAtTarget.GetDisplayPosition();
                // Orbit around the player on the horizontal plane, staying on the far
                // side from the enemy so both aircraft stay in frame.
                Vec3d v = enemyPos - playerPos;
                v.Y = 0;
                if (v.LengthSquared < 1e-6)
                {
                    v = new Vec3d(0, 0, 1);
                }
                else
                {
                    v = v.Normalized();
                }
                camera.Position = playerPos.AddScaled(v, -40).AddScaled(SceneAxes.Up, 5);
                camera.LookAt(enemyPos);
                return;
            }

            Vec3d f = SceneAxes.Forward.Rotate(actor.GetDisplayQuaternion());
            f.Y = 0;
            f = f.Normalized();
            Vec3d p = playerPos.AddScaled(f, _heading == ExteriorViewHeading.Front ? 1 : -1);
            camera.Position = playerPos;
            camera.LookAt(p);
            camera.Position = camera.Position
                .AddScaled(SceneAxes.Up, 5)
                .AddScaled(f, 40.0 * (_heading == ExteriorViewHeading.Back ? 1 : -1));
        }
    }
}

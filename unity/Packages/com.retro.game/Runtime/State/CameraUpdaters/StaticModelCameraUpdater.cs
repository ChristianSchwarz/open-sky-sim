using Retro.Core;

namespace Retro.Game
{
    /// <summary>staticModelCameraUpdater.ts: a side view of a model placed at a position and heading.</summary>
    public sealed class StaticModelCameraUpdater : CameraUpdater
    {
        private Vec3d _target;
        private double _heading;

        public StaticModelCameraUpdater(ICameraActor actor, CameraPose camera) : base(actor, camera) { }

        public void SetTarget(Vec3d position, double heading)
        {
            _target = position;
            _heading = heading;
        }

        public override void Update(double delta)
        {
            Quatd orientation = Quatd.FromAxisAngle(SceneAxes.Up, _heading);
            Vec3d forward = SceneAxes.Forward.Rotate(orientation);
            forward.Y = 0;
            forward = forward.Normalized();
            var side = new Vec3d(forward.Z, 0, -forward.X);
            camera.Position = _target.AddScaled(side, 35).AddScaled(SceneAxes.Up, 5);
            camera.Up = SceneAxes.Up;
            camera.LookAt(_target);
        }
    }
}

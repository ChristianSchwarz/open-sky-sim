using Retro.Core;

namespace Retro.Game
{
    public enum ExteriorViewSide
    {
        Left,
        Right,
    }

    /// <summary>exteriorSideCameraUpdater.ts: a view from beside the aircraft, level, 35 m out.</summary>
    public sealed class ExteriorSideCameraUpdater : CameraUpdater
    {
        private readonly ExteriorViewSide _side;

        public ExteriorSideCameraUpdater(ICameraActor actor, CameraPose camera, ExteriorViewSide side)
            : base(actor, camera)
        {
            _side = side;
        }

        public override void Update(double delta)
        {
            Quatd displayQuat = actor.GetDisplayQuaternion();
            bool isUp = Vec3d.Dot(SceneAxes.Up.Rotate(displayQuat), SceneAxes.Up) >= 0;

            Vec3d t = SceneAxes.Forward.Rotate(displayQuat);
            t.Y = 0;
            t = (t * (isUp ? 1.0 : -1)).Normalized();
            t = new Vec3d(t.Z, t.Y, -t.X);
            camera.Position = actor.GetDisplayPosition()
                .AddScaled(t, 35 * (_side == ExteriorViewSide.Right && isUp ? -1 : 1));
            camera.LookAt(actor.GetDisplayPosition());
        }
    }
}

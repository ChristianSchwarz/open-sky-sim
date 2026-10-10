namespace Retro.Game
{
    /// <summary>showcaseCameraUpdater.ts: a fixed three-quarter view of the aircraft for the showcase screen.</summary>
    public sealed class ShowcaseCameraUpdater : CameraUpdater
    {
        public ShowcaseCameraUpdater(ICameraActor actor, CameraPose camera) : base(actor, camera) { }

        public override void Update(double delta)
        {
            Retro.Core.Vec3d pivot = actor.GetDisplayPosition();
            var side = new Retro.Core.Vec3d(SceneAxes.Forward.Z, 0, -SceneAxes.Forward.X);
            camera.Position = pivot.AddScaled(side, 35).AddScaled(SceneAxes.Up, 5);
            camera.Up = SceneAxes.Up;
            camera.LookAt(pivot);
        }
    }
}

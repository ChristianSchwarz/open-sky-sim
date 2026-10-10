namespace Retro.Game
{
    /// <summary>targetToCameraUpdater.ts: from the player, zoomed onto the weapons target.</summary>
    public sealed class TargetToCameraUpdater : CameraUpdater
    {
        public TargetToCameraUpdater(ICameraActor actor, CameraPose camera) : base(actor, camera) { }

        public override void Update(double delta)
        {
            TargetCamera.RestoreMainCameraParameters(camera);
            TargetCamera.UpdateTargetCamera(actor, camera, camera);
        }
    }
}

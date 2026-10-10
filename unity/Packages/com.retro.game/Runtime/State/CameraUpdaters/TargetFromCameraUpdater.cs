using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>targetFromCameraUpdater.ts: from beside the weapons target, looking back at the player.</summary>
    public sealed class TargetFromCameraUpdater : CameraUpdater
    {
        private const double MinHeight = 5;
        private const double MaxMargin = 300;

        public TargetFromCameraUpdater(ICameraActor actor, CameraPose camera) : base(actor, camera) { }

        public override void Update(double delta)
        {
            WeaponsTarget target = actor.WeaponsTarget;
            if (target == null) return;

            Vec3d actorPosition = actor.GetDisplayPosition();
            camera.Position = target.Position + target.LocalCenter;
            Vec3d v = (camera.Position - actorPosition).Normalized();
            Vec3d p = target.Position.AddScaled(v, Math.Min(target.MaxSize, MaxMargin));
            p.Y = Math.Max(p.Y, MinHeight);
            camera.Position = p;
            camera.LookAt(actorPosition);
        }
    }
}

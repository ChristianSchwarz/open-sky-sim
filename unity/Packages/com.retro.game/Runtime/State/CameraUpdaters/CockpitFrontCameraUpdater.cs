using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>cockpitFrontCameraUpdater.ts: the eye in the cockpit, looking along the nose or padlocked on the target.</summary>
    public sealed class CockpitFrontCameraUpdater : CameraUpdater
    {
        private bool _padlock;

        public CockpitFrontCameraUpdater(ICameraActor actor, CameraPose camera) : base(actor, camera) { }

        public void SetPadlock(bool enabled)
        {
            _padlock = enabled;
        }

        public bool IsPadlock() => _padlock;

        public override void Update(double delta)
        {
            Vec3d offset = actor.GetCockpitOffset();

            Vec3d forward = actor.GetDisplayWorldDirection();
            camera.Position = actor.GetDisplayPosition().AddScaled(forward, offset.Z);

            Vec3d up = actor.GetDisplayWorldUp();
            camera.Position = camera.Position.AddScaled(up, offset.Y);

            Vec3d right = actor.GetDisplayWorldRight();
            camera.Position = camera.Position.AddScaled(right, offset.X);

            WeaponsTarget target = _padlock ? actor.WeaponsTarget : null;
            if (target != null)
            {
                // Padlock: keep the eye point in the cockpit but look at the target.
                // Aircraft up preserves bank so the fixed HUD glass stays airframe-aligned.
                Vec3d lookAt = target.Position + target.LocalCenter;
                camera.Up = actor.GetDisplayWorldUp();
                camera.LookAt(lookAt);
                return;
            }

            camera.Quaternion = actor.GetDisplayQuaternion();
            // The three.js camera forward vector points towards -Z in opposition to
            // the Object3D pointing towards +Z
            camera.RotateOnAxis(SceneAxes.Up, Math.PI);
        }
    }
}

using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>crashedCameraUpdater.ts: circles the wreck slowly, 50 m out and 25 m up.</summary>
    public sealed class CrashedCameraUpdater : CameraUpdater
    {
        private double _progress;

        public CrashedCameraUpdater(ICameraActor actor, CameraPose camera) : base(actor, camera) { }

        public override void Update(double delta)
        {
            _progress += delta * 0.5;
            while (_progress >= (2 * Math.PI))
            {
                _progress -= (2 * Math.PI);
            }

            camera.Quaternion = Quatd.FromAxisAngle(SceneAxes.Up, _progress);

            Vec3d v = SceneAxes.Forward.Rotate(camera.Quaternion);
            v.Y = 0;
            v = v.Normalized();
            // Follow the cockpit as it tumbles away; the stopped hull position if it broke up nowhere.
            if (!actor.GetWreckFocus(out Vec3d focus))
            {
                focus = actor.GetDisplayPosition();
            }
            camera.Position = focus.AddScaled(SceneAxes.Up, 25).AddScaled(v, 50.0 * -1);
            Vec3d p = focus.AddScaled(v, 50);
            camera.LookAt(p);
        }
    }
}

using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// fixedCameraUpdater.ts: a camera nailed to a world position, looking
    /// along a bearing and pitch. Heading is degrees clockwise from north
    /// (scene -z), pitch is degrees with up positive.
    /// </summary>
    public sealed class FixedCameraUpdater : CameraUpdater
    {
        private const double PitchLimitDeg = 89;

        private Vec3d _position;
        private Vec3d _direction = new Vec3d(0, 0, -1);
        private double _headingDeg;
        private double _pitchDeg;

        /// <summary>The actor is not read; null is fine.</summary>
        public FixedCameraUpdater(ICameraActor actor, CameraPose camera) : base(actor, camera) { }

        public void SetPose(Vec3d position, double headingDeg, double pitchDeg)
        {
            _position = position;
            Turn(headingDeg - _headingDeg, pitchDeg - _pitchDeg);
        }

        /// <summary>Turn by degrees: heading clockwise, pitch up positive, pitch held short of the poles.</summary>
        public void Turn(double headingDeg, double pitchDeg)
        {
            _headingDeg = (((_headingDeg + headingDeg) % 360) + 360) % 360;
            _pitchDeg = Math.Max(-PitchLimitDeg, Math.Min(PitchLimitDeg, _pitchDeg + pitchDeg));
            double h = _headingDeg * Math.PI / 180;
            double p = _pitchDeg * Math.PI / 180;
            _direction = new Vec3d(
                Math.Sin(h) * Math.Cos(p),
                Math.Sin(p),
                -Math.Cos(h) * Math.Cos(p));
        }

        /// <summary>Carry the pose into a re-based frame: same place, same view of it.</summary>
        public void Rebase(FrameShift shift)
        {
            _position = shift.Point(_position);
            Vec3d d = shift.Vector(_direction);
            _direction = d;
            _headingDeg = ((Math.Atan2(d.X, -d.Z) * 180 / Math.PI) + 360) % 360;
            _pitchDeg = Math.Asin(Math.Max(-1, Math.Min(1, d.Y))) * 180 / Math.PI;
        }

        /// <summary>Where the camera is, in scene metres.</summary>
        public Vec3d GetPosition() => _position;

        /// <summary>Degrees clockwise from north.</summary>
        public double Heading => _headingDeg;

        /// <summary>Degrees, up positive.</summary>
        public double Pitch => _pitchDeg;

        /// <summary>
        /// Slide the camera: `forward` along its heading (level, so pitching down
        /// does not sink it), `right` across it, `up` along world up. Metres.
        /// </summary>
        public void Move(double forward, double right, double up)
        {
            double x = _direction.X;
            double z = _direction.Z;
            double len = JsText.Or(JsMath.Hypot(x, z), 1);
            double fx = x / len;
            double fz = z / len;
            _position.X += fx * forward - fz * right;
            _position.Z += fz * forward + fx * right;
            _position.Y += up;
        }

        public override void Update(double delta)
        {
            camera.Position = _position;
            camera.Up = SceneAxes.Up;
            camera.LookAt(_position + _direction);
        }
    }
}

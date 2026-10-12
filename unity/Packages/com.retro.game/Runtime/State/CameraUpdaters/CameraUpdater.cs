using Retro.Core;

namespace Retro.Game
{
    /// <summary>Anything that can be chased by an exterior camera (aiExteriorCameraUpdater.ts ChaseTarget).</summary>
    public interface IChaseTarget
    {
        Vec3d GetDisplayPosition();
        Quatd GetDisplayQuaternion();
    }

    /// <summary>A placed entity: world position and orientation (the carrier's GroundTargetEntity).</summary>
    public interface IPosedEntity
    {
        Vec3d Position { get; }
        Quatd Quaternion { get; }
    }

    /// <summary>weaponsTarget.ts WeaponsTarget.</summary>
    public sealed class WeaponsTarget
    {
        /// <summary>World/display position used for the target camera, range and bearing.</summary>
        public Vec3d Position;
        /// <summary>Offset from Position to the visual centre of the target.</summary>
        public Vec3d LocalCenter;
        /// <summary>Largest visible extent (m); drives the target-camera zoom factor.</summary>
        public double MaxSize;
        /// <summary>Short type label shown in the target MFD.</summary>
        public string TargetType = "";
        /// <summary>Location / status label shown in the target MFD.</summary>
        public string TargetLocation = "";
        /// <summary>True for airborne targets (enemy aircraft), false for fixed ground targets.</summary>
        public bool Airborne;
        /// <summary>The runway the ILS guides down, on an airfield target; null for the legacy one.</summary>
        public ApproachRunway ApproachRunway;
    }

    /// <summary>
    /// What the camera updaters read from the player entity (PlayerEntity in
    /// the TS). The Unity layer implements it over its player: display pose
    /// (interpolated for rendering), the cockpit eye offset, the current
    /// weapons target and the wreck focus.
    /// </summary>
    public interface ICameraActor : IChaseTarget
    {
        /// <summary>Eye offset in the airframe: x right, y up, z forward (m).</summary>
        Vec3d GetCockpitOffset();
        /// <summary>FORWARD (+Z) rotated by the display quaternion.</summary>
        Vec3d GetDisplayWorldDirection();
        /// <summary>UP (+Y) rotated by the display quaternion.</summary>
        Vec3d GetDisplayWorldUp();
        /// <summary>+X rotated by the display quaternion.</summary>
        Vec3d GetDisplayWorldRight();
        /// <summary>The current weapons target, or null.</summary>
        WeaponsTarget WeaponsTarget { get; }
        /// <summary>Where the crash camera should look, when the aircraft broke up; false otherwise.</summary>
        bool GetWreckFocus(out Vec3d focus);
    }

    /// <summary>cameraUpdater.ts: drives one camera from one actor, once a frame.</summary>
    public abstract class CameraUpdater
    {
        protected ICameraActor actor;
        protected CameraPose camera;

        protected CameraUpdater(ICameraActor actor, CameraPose camera)
        {
            this.actor = actor;
            this.camera = camera;
        }

        public abstract void Update(double delta);
    }
}

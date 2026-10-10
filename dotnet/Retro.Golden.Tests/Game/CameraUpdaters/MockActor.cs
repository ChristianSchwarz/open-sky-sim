using Retro.Core;
using Retro.Game;

namespace Retro.Golden.Tests.Game.CameraUpdaters;

/// <summary>The mockActor of cockpitFrontCameraUpdater.test.ts: a pose, an eye offset and a settable target.</summary>
internal sealed class MockActor : ICameraActor
{
    public Vec3d Position = new(0, 100, 0);
    public Quatd Quaternion = Quatd.Identity;
    public Vec3d CockpitOffset = new(0, 1, 8);
    public WeaponsTarget Target;
    public Vec3d? WreckFocus;

    public Vec3d GetCockpitOffset() => CockpitOffset;
    public Vec3d GetDisplayPosition() => Position;
    public Quatd GetDisplayQuaternion() => Quaternion;
    public Vec3d GetDisplayWorldDirection() => SceneAxes.Forward.Rotate(Quaternion);
    public Vec3d GetDisplayWorldUp() => SceneAxes.Up.Rotate(Quaternion);
    public Vec3d GetDisplayWorldRight() => new Vec3d(1, 0, 0).Rotate(Quaternion);
    public WeaponsTarget WeaponsTarget => Target;

    public bool GetWreckFocus(out Vec3d focus)
    {
        focus = WreckFocus ?? default;
        return WreckFocus != null;
    }

    public static WeaponsTarget MakeTarget(Vec3d position) => new()
    {
        Position = position,
        LocalCenter = new Vec3d(0, 0, 0),
        MaxSize = 15,
        TargetType = "BANDIT",
        TargetLocation = "AIR",
        Airborne = true,
    };
}

using System;
using Retro.Core;
using Retro.Game;
using Xunit;

namespace Retro.Golden.Tests.Game.CameraUpdaters;

/// <summary>Port of src/script/state/cameraUpdaters/cockpitFrontCameraUpdater.test.ts.</summary>
public class CockpitFrontCameraUpdaterTests
{
    [Fact]
    public void LooksAlongTheAircraftNoseWhenPadlockIsOff()
    {
        var camera = new CameraPose(50, 1.6, 1, 40000);
        var actor = new MockActor();
        var updater = new CockpitFrontCameraUpdater(actor, camera);
        updater.Update(0);

        Vec3d forward = camera.GetWorldDirection();
        Assert.True(Vec3d.Dot(forward, SceneAxes.Forward) > 0.99);
    }

    [Fact]
    public void LooksAtTheWeaponsTargetWhenPadlockIsOn()
    {
        var camera = new CameraPose(50, 1.6, 1, 40000);
        var actor = new MockActor();
        var targetPos = new Vec3d(0, 200, 500);
        actor.Target = MockActor.MakeTarget(targetPos);

        var updater = new CockpitFrontCameraUpdater(actor, camera);
        updater.SetPadlock(true);
        updater.Update(0);

        Vec3d toTarget = (targetPos - camera.Position).Normalized();
        Vec3d forward = camera.GetWorldDirection();
        Assert.True(Vec3d.Dot(forward, toTarget) > 0.99);
    }

    [Fact]
    public void PlacesTheAirframeHudBelowAHighPadlockedTarget()
    {
        var camera = new CameraPose(50, 1.6, 1, 40000);
        var actor = new MockActor();
        // Target high above and ahead: padlock looks up; nose projects lower.
        var targetPos = new Vec3d(0, 400, 300);
        actor.Target = MockActor.MakeTarget(targetPos);

        var updater = new CockpitFrontCameraUpdater(actor, camera);
        updater.SetPadlock(true);
        updater.Update(0);

        const double halfH = 100;
        Vec3d nose = camera.Project(camera.Position.AddScaled(SceneAxes.Forward, 100));
        double noseY = JsMath.Round(-(nose.Y * halfH) + halfH);

        Vec3d tgt = camera.Project(targetPos);
        double tgtY = JsMath.Round(-(tgt.Y * halfH) + halfH);

        // Screen Y grows downward: target near centre, nose (HUD) below it.
        Assert.True(Math.Abs(tgtY - halfH) < 4, $"expected target near centre, got {tgtY}");
        Assert.True(noseY > tgtY, $"expected nose Y {noseY} below target Y {tgtY}");
        Assert.True(noseY > halfH, $"expected nose below screen centre, got {noseY}");
    }
}

using System;
using Retro.Core;
using Retro.Game;
using Xunit;

namespace Retro.Golden.Tests.Game.CameraUpdaters;

/// <summary>Port of src/script/state/cameraUpdaters/fixedCameraUpdater.test.ts.</summary>
public class FixedCameraUpdaterTests
{
    /// <summary>utils/math.ts vectorHeading: whole degrees clockwise from north (scene -z).</summary>
    internal static double VectorHeading(Vec3d v)
    {
        double bearing = JsMath.Round(Math.Atan2(v.X, -v.Z) / (2 * Math.PI) * 360);
        if (bearing < 0)
        {
            bearing = 360 + bearing;
        }
        return bearing;
    }

    private static Vec3d Forward(CameraPose camera) => camera.GetWorldDirection();

    [Fact]
    public void SitsAtThePositionAndFacesTheBearing()
    {
        var camera = new CameraPose();
        var updater = new FixedCameraUpdater(null, camera);
        updater.SetPose(new Vec3d(100, 50, -200), 90, 0);
        updater.Update(0);
        Assert.Equal(new Vec3d(100, 50, -200), camera.Position);
        Assert.Equal(90, VectorHeading(Forward(camera)));
        Assert.True(Math.Abs(Forward(camera).Y) < 1e-6);
    }

    [Fact]
    public void PitchesUpAndDown()
    {
        var camera = new CameraPose();
        var updater = new FixedCameraUpdater(null, camera);
        updater.SetPose(new Vec3d(), 0, -30);
        updater.Update(0);
        Vec3d f = Forward(camera);
        Assert.True(Math.Abs(f.Y + 0.5) < 1e-6);
        Assert.True(f.Z < 0);
        Assert.Equal(0, VectorHeading(f));
    }

    [Fact]
    public void MoveSlidesAlongTheLevelHeadingAcrossItAndUp()
    {
        var camera = new CameraPose();
        var updater = new FixedCameraUpdater(null, camera);
        updater.SetPose(new Vec3d(), 90, -45);
        updater.Move(10, 2, 3);
        updater.Update(0);
        Vec3d p = camera.Position;
        Assert.True(Math.Abs(p.X - 10) < 1e-9, $"x {p.X}");
        Assert.True(Math.Abs(p.Z - 2) < 1e-9, $"z {p.Z}");
        Assert.Equal(3, p.Y);
    }

    [Fact]
    public void TurnTurnsTheHeadingClockwiseAndPitchesClampedShortOfThePoles()
    {
        var camera = new CameraPose();
        var updater = new FixedCameraUpdater(null, camera);
        updater.SetPose(new Vec3d(), 350, 0);
        updater.Turn(20, 0);
        updater.Update(0);
        Assert.Equal(10, VectorHeading(Forward(camera)));
        updater.Turn(0, 200);
        updater.Update(0);
        Assert.True(Forward(camera).Y > 0.999);
        Assert.True(Forward(camera).Y < 1);
    }

    [Fact]
    public void RebaseKeepsThePlaceAndTheViewOfIt()
    {
        // Not in the TS tests: a pure translation leaves heading and pitch alone.
        var camera = new CameraPose();
        var updater = new FixedCameraUpdater(null, camera);
        updater.SetPose(new Vec3d(10, 20, 30), 45, -10);
        updater.Rebase(new FrameShift(Quatd.Identity, new Vec3d(-1000, 0, 500)));
        Assert.Equal(new Vec3d(-990, 20, 530), updater.GetPosition());
        Assert.True(Math.Abs(updater.Heading - 45) < 1e-9);
        Assert.True(Math.Abs(updater.Pitch + 10) < 1e-9);
    }
}

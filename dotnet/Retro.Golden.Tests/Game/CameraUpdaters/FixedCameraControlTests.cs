using System;
using System.Collections.Generic;
using Retro.Game;
using Xunit;

namespace Retro.Golden.Tests.Game.CameraUpdaters;

/// <summary>Port of src/script/state/cameraUpdaters/fixedCameraControl.test.ts.</summary>
public class FixedCameraControlTests
{
    private static readonly FixedCameraTuning T = new()
    {
        StartMps = 20, MaxMps = 3000, GrowthPerS = 2, TurnDegPerS = 45, EaseS = 0.3,
    };

    private static FixedCameraInput Idle(double forward = 0, double right = 0, double up = 0, double yaw = 0, double pitch = 0) =>
        new() { Forward = forward, Right = right, Up = up, Yaw = yaw, Pitch = pitch };

    [Fact]
    public void MapsTheKeysToSignedAxes()
    {
        var w = FixedCameraControl.FixedCameraInputOf(new HashSet<string> { "ArrowUp", "ArrowLeft", "PageDown", "Numpad6", "Numpad2" });
        Assert.Equal((1.0, -1.0, -1.0, 1.0, -1.0), (w.Forward, w.Right, w.Up, w.Yaw, w.Pitch));
    }

    [Fact]
    public void StartsSlowDoublesEverySecondHeldAndStopsAtTheCap()
    {
        var r = FixedCameraControl.ZeroFixedCameraRates();
        FixedCameraControl.StepFixedCameraRates(r, Idle(forward: 1), 1.0 / 60, T);
        Assert.Equal(20, r.Forward);
        for (int i = 0; i < 60; i++) FixedCameraControl.StepFixedCameraRates(r, Idle(forward: 1), 1.0 / 60, T);
        Assert.True(Math.Abs(r.Forward - 40) < 0.5, $"after 1 s: {r.Forward}");
        for (int i = 0; i < 60 * 10; i++) FixedCameraControl.StepFixedCameraRates(r, Idle(forward: 1), 1.0 / 60, T);
        Assert.Equal(3000, r.Forward);
    }

    [Fact]
    public void ReversesAtTheStartSpeedAndCoastsToRestWhenReleased()
    {
        var r = FixedCameraControl.ZeroFixedCameraRates();
        r.Up = 500;
        FixedCameraControl.StepFixedCameraRates(r, Idle(up: -1), 1.0 / 60, T);
        Assert.Equal(-20, r.Up);
        bool moving = true;
        for (int i = 0; i < 300 && moving; i++) moving = FixedCameraControl.StepFixedCameraRates(r, Idle(), 1.0 / 60, T);
        Assert.False(moving);
        Assert.Equal(0, r.Up);
    }

    [Fact]
    public void EasesTurnsTowardTheFixedRate()
    {
        var r = FixedCameraControl.ZeroFixedCameraRates();
        FixedCameraControl.StepFixedCameraRates(r, Idle(yaw: 1), 0.3, T);
        Assert.True(r.Yaw > 28 && r.Yaw < 29, $"one tau: {r.Yaw}");
        for (int i = 0; i < 30; i++) FixedCameraControl.StepFixedCameraRates(r, Idle(yaw: 1), 0.3, T);
        Assert.True(r.Yaw > 44.99);
    }
}

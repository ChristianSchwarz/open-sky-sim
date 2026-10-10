using System;
using Retro.Core;
using Retro.Game;
using Xunit;

namespace Retro.Golden.Tests.Game;

/// <summary>Port of src/script/state/flightRecorder.test.ts.</summary>
public class FlightRecorderTests
{
    private static readonly Vec3d Up = new(0, 1, 0);

    private static ReplayPose Pose(double x, double yaw = 0)
    {
        var p = ReplayPose.New();
        p.Position = new Vec3d(x, 100, 0);
        p.Quaternion = Quatd.FromAxisAngle(Up, yaw);
        p.Devices.Gear = true;
        p.Devices.Throttle = 0.5;
        return p;
    }

    /// <summary>
    /// The angle three.js Quaternion.angleTo measures, 2 acos|a.b|, written as
    /// 2 atan2(|v|, |w|) of the relative rotation. acos is ill-conditioned
    /// next to 1: a last-bit difference between .NET's and V8's sin/acos
    /// (which the slerp goes through) turns a dot of 1 - 1e-16 into 3e-8 rad
    /// and would fail a 1e-9 bound that is about orientation, not libm.
    /// </summary>
    private static double AngleTo(Quatd a, Quatd b)
    {
        Quatd d = a.Conjugate() * b;
        return 2 * Math.Atan2(Math.Sqrt(d.X * d.X + d.Y * d.Y + d.Z * d.Z), Math.Abs(d.W));
    }

    [Fact]
    public void InterpolatesBetweenSamples()
    {
        var r = new FlightRecorder(10, 60);
        r.Record(0.1, Pose(0));
        r.Record(0.1, Pose(10));
        var output = ReplayPose.New();
        Assert.True(r.Sample((r.StartTime + r.EndTime) / 2, output));
        Assert.True(Math.Abs(output.Position.X - 5) < 1e-9);
        Assert.True(output.Devices.Gear);
    }

    [Fact]
    public void SlerpsOrientation()
    {
        var r = new FlightRecorder(10, 60);
        r.Record(0.1, Pose(0, 0));
        r.Record(0.1, Pose(0, Math.PI / 2));
        var output = ReplayPose.New();
        r.Sample((r.StartTime + r.EndTime) / 2, output);
        Quatd expected = Quatd.FromAxisAngle(Up, Math.PI / 4);
        Assert.True(AngleTo(output.Quaternion, expected) < 1e-9);
    }

    [Fact]
    public void DropsTheOldestSamplesOnceFull()
    {
        var r = new FlightRecorder(10, 1); // 10 slots
        for (int i = 0; i < 25; i++) r.Record(0.1, Pose(i));
        Assert.Equal(10, r.Length);
        var output = ReplayPose.New();
        r.Sample(r.StartTime, output);
        Assert.Equal(15, JsMath.Round(output.Position.X));
        r.Sample(r.EndTime, output);
        Assert.Equal(24, JsMath.Round(output.Position.X));
    }

    [Fact]
    public void RecordsNothingBetweenSampleTicks()
    {
        var r = new FlightRecorder(10, 60);
        for (int i = 0; i < 50; i++) r.Record(0.01, Pose(i));
        Assert.True(r.Length >= 4 && r.Length <= 6);
    }

    [Fact]
    public void ReturnsFalseWhenEmptyAndClampsOutsideTheSpan()
    {
        var r = new FlightRecorder(10, 60);
        var output = ReplayPose.New();
        Assert.False(r.Sample(0, output));
        r.Record(0.1, Pose(1));
        r.Record(0.1, Pose(2));
        r.Sample(1e6, output);
        Assert.Equal(2, JsMath.Round(output.Position.X));
    }

    [Fact]
    public void AppliesARebaseToEveryStoredPose()
    {
        var r = new FlightRecorder(10, 60);
        r.Record(0.1, Pose(1));
        r.Record(0.1, Pose(2));
        // The TS test passes a duck-typed shift that only moves x by -1000;
        // a FrameShift with no rotation is the same thing.
        var shift = new FrameShift(Quatd.Identity, new Vec3d(-1000, 0, 0));
        r.Rebase(shift);
        var output = ReplayPose.New();
        r.Sample(r.EndTime, output);
        Assert.Equal(-998, JsMath.Round(output.Position.X));
    }

    [Fact]
    public void ReplayPlayerLoopsPausesSeeksAndChangesSpeed()
    {
        var r = new FlightRecorder(10, 60);
        for (int i = 0; i < 11; i++) r.Record(0.1, Pose(i)); // ~1 s
        var p = new ReplayPlayer(r);
        p.Start();
        Assert.Equal(r.StartTime, p.Time);
        p.Advance(0.5);
        Assert.True(Math.Abs(p.Time - (r.StartTime + 0.5)) < 1e-9);
        p.Paused = true;
        p.Advance(10);
        Assert.True(Math.Abs(p.Time - (r.StartTime + 0.5)) < 1e-9);
        p.Paused = false;
        p.ChangeSpeed(1);
        Assert.Equal(2, p.Speed);
        p.Advance(10); // past the end -> loops
        Assert.Equal(r.StartTime, p.Time);
        p.Seek(-100);
        Assert.Equal(r.StartTime, p.Time);
    }
}

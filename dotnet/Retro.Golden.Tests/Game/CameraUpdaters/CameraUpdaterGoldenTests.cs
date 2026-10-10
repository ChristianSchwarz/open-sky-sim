using System;
using System.Text.Json;
using Retro.Core;
using Retro.Game;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests.Game.CameraUpdaters;

/// <summary>
/// Every camera updater against three.js. There are no TS unit tests for
/// most of them; these poses were produced by running the TypeScript updaters
/// (bundled with esbuild, three r1xx from node_modules) on the same mock actor
/// and printing camera.position / camera.quaternion / fov / near / far.
/// </summary>
public class CameraUpdaterGoldenTests
{
    private const string Expected = """
{"q":[-0.2242495391756806,-0.8311805440083869,0.2904674150601727,0.4177077066917465],"qInv":[0.4841117795224336,-0.029490150417772344,0.86106771394601,0.15273672759278306],"cockpit":{"p":[1228.2930800351048,811.0219816640365,-4325.9352258619965],"q":[-0.2904674150601727,0.41770770669174645,-0.22424953917568058,0.8311805440083869],"fov":50,"near":1,"far":40000},"cockpitPadlock":{"p":[1228.2930800351048,811.0219816640365,-4325.9352258619965],"q":[0.28177671178747554,0.8826016209515435,-0.142624456732786,-0.34824492491581766],"fov":50,"near":1,"far":40000},"extFront":{"p":[1269.028374665955,817.25,-4301.556155816006],"q":[0,0.4975710478916956,0,0.8674232255940348],"fov":50,"near":1,"far":40000},"extBack":{"p":[1199.971625334045,817.25,-4341.943844183994],"q":[0,0.867423225594035,0,-0.49757104789169554],"fov":50,"near":1,"far":40000},"extLookAt":{"p":[1209.0414725709081,817.25,-4352.6022832403405],"q":[-0.030236660534375865,0.9373218812436566,-0.08415005315568769,-0.3367969772065606],"fov":50,"near":1,"far":40000},"sideLeft":{"p":[1216.830386339005,812.25,-4291.537672167289],"q":[0,-0.26152498288990056,0,0.9651967070625745],"fov":50,"near":1,"far":40000},"sideRight":{"p":[1252.169613660995,812.25,-4351.962327832711],"q":[0,0.9651967070625744,0,0.2615249828899006],"fov":50,"near":1,"far":40000},"sideRightInverted":{"p":[1215.589419294615,812.25,-4292.298515531724],"q":[0,-0.28153953114270264,0,0.95954962998479],"fov":50,"near":1,"far":40000},"targetTo":{"p":[1234.5,812.25,-4321.75],"q":[-0.01035937964155137,0.9265495000425656,-0.025585108399964706,-0.37515877898894473],"fov":0.78125,"near":10,"far":10000},"targetToFar":{"p":[10,15,20],"q":[0.0012327358532290616,-0.3155953957611584,0.00040999962476922065,0.9488929646893699],"fov":1.5625,"near":7505.043454237956,"far":30020.173816951825},"targetFrom":{"p":[3012.504172797277,950.9933221381015,-2487.090353460075],"q":[-0.025138924023191154,0.3752898657864727,0.010182704415782708,0.9265105847575128],"fov":50,"near":1,"far":40000},"targetFromFar":{"p":[9212.814706176358,29.220043660006016,-12210.423606683229],"q":[0.013420232622315537,0.9222349196340877,-0.032142203922652615,0.3850578256455327],"fov":50,"near":1,"far":40000},"showcase":{"p":[1269.5,817.25,-4321.75],"q":[-0.050126106817788736,0.7053278481779176,0.05012610681778873,0.7053278481779176],"fov":50,"near":1,"far":40000},"staticModel":{"p":[-70.59753910393711,17,46.70262586631435],"q":[0.021935747692525865,0.9485273458194067,0.06740976296195218,-0.3086593932855031],"fov":50,"near":1,"far":40000},"carrier":{"p":[8928.264390910048,44,1430.3293290652834],"q":[0.019398369210429114,0.919917521578213,0.04588145776870342,-0.3889348899216841],"fov":50,"near":1,"far":40000},"crashed":{"p":[1196.3864453819294,837.25,-4354.112894715636],"q":[0.05131276003416065,0.9007403602433659,0.11088620556683705,-0.41681896969945736],"fov":50,"near":1,"far":40000},"crashedWreck":{"p":[1282.8551096272274,815,-4346.968635642369],"q":[0.021273100487166293,0.9773485311293473,0.12031710237117972,-0.17280364224163053],"fov":50,"near":1,"far":40000},"aiBack":{"p":[1533.658839392316,905,-3978.3879077652746],"q":[-0.09391875399402136,0.34896581063937443,0.03517499973365624,0.9317536423576525],"fov":50,"near":1,"far":40000},"aiFront":{"p":[1466.341160607684,905,-4021.6120922347254],"q":[-0.11322738884022324,0.3206419213995535,0.03863866330216161,0.9396144796435661],"fov":50,"near":1,"far":40000},"fixed":{"p":[32.24735885824218,8,20.17503074949623],"q":[0.07211990371296048,0.8702299270469718,0.13394119647935002,-0.4685705383887637],"fov":50,"near":1,"far":40000},"project":[0.01064477221633439,0.026668774949424823,0.9993070295631319],"worldDir":[0.6950995713149776,0.05550653372046961,0.7167674732241082]}
""";

    private static readonly JsonElement Fx = JsonDocument.Parse(Expected).RootElement;
    private static readonly Quatd Q = Golden.Q(Fx.GetProperty("q"));
    private static readonly Quatd QInv = Golden.Q(Fx.GetProperty("qInv"));
    private static readonly Vec3d Pos = new(1234.5, 812.25, -4321.75);

    private static WeaponsTarget Target => new()
    {
        Position = new Vec3d(3000, 950, -2500), LocalCenter = new Vec3d(0, 2.5, 1), MaxSize = 18, Airborne = true,
    };

    private static WeaponsTarget FarTarget => new()
    {
        Position = new Vec3d(9000, 50, -12000), LocalCenter = new Vec3d(0, 4, 0), MaxSize = 300,
    };

    private sealed class Chase : IChaseTarget
    {
        public Vec3d GetDisplayPosition() => new(1500, 900, -4000);
        public Quatd GetDisplayQuaternion() => QInv;
    }

    private sealed class Carrier : IPosedEntity
    {
        public Vec3d Position => new(9000, 0, 1500);
        public Quatd Quaternion => Quatd.FromAxisAngle(SceneAxes.Up, 0.8);
    }

    private static MockActor Actor(Vec3d pos, Quatd q, WeaponsTarget target = null, Vec3d? wreck = null) => new()
    {
        Position = pos, Quaternion = q, CockpitOffset = new Vec3d(0.3, 1.1, 7.5), Target = target, WreckFocus = wreck,
    };

    private static CameraPose Cam() => new(50, 1.6, 1, 40000);

    private static void Check(Mismatches m, string name, CameraPose cam)
    {
        JsonElement e = Fx.GetProperty(name);
        m.Close($"{name} position", V3(e.GetProperty("p")), cam.Position, 1e-9);
        Quatd q = Golden.Q(e.GetProperty("q"));
        m.Close($"{name} qx", q.X, cam.Quaternion.X, 1e-12);
        m.Close($"{name} qy", q.Y, cam.Quaternion.Y, 1e-12);
        m.Close($"{name} qz", q.Z, cam.Quaternion.Z, 1e-12);
        m.Close($"{name} qw", q.W, cam.Quaternion.W, 1e-12);
        m.Close($"{name} fov", Num(e, "fov"), cam.Fov, 1e-12);
        m.Close($"{name} near", Num(e, "near"), cam.Near, 1e-9);
        m.Close($"{name} far", Num(e, "far"), cam.Far, 1e-9);
    }

    [Fact]
    public void EveryUpdaterMatchesThreeJs()
    {
        var m = new Mismatches();
        CameraPose c;

        c = Cam(); new CockpitFrontCameraUpdater(Actor(Pos, Q, Target), c).Update(0); Check(m, "cockpit", c);
        c = Cam(); { var u = new CockpitFrontCameraUpdater(Actor(Pos, Q, Target), c); u.SetPadlock(true); u.Update(0); } Check(m, "cockpitPadlock", c);
        c = Cam(); new ExteriorFrontBehindCameraUpdater(Actor(Pos, Q), c, ExteriorViewHeading.Front).Update(0); Check(m, "extFront", c);
        c = Cam(); new ExteriorFrontBehindCameraUpdater(Actor(Pos, Q), c, ExteriorViewHeading.Back).Update(0); Check(m, "extBack", c);
        c = Cam(); { var u = new ExteriorFrontBehindCameraUpdater(Actor(Pos, Q), c, ExteriorViewHeading.Back); u.SetLookAtTarget(new Chase()); u.Update(0); } Check(m, "extLookAt", c);
        c = Cam(); new ExteriorSideCameraUpdater(Actor(Pos, Q), c, ExteriorViewSide.Left).Update(0); Check(m, "sideLeft", c);
        c = Cam(); new ExteriorSideCameraUpdater(Actor(Pos, Q), c, ExteriorViewSide.Right).Update(0); Check(m, "sideRight", c);
        c = Cam(); new ExteriorSideCameraUpdater(Actor(Pos, QInv), c, ExteriorViewSide.Right).Update(0); Check(m, "sideRightInverted", c);
        c = Cam(); new TargetToCameraUpdater(Actor(Pos, Q, Target), c).Update(0); Check(m, "targetTo", c);
        c = Cam(); new TargetToCameraUpdater(Actor(new Vec3d(10, 3, 20), Q, FarTarget), c).Update(0); Check(m, "targetToFar", c);
        c = Cam(); new TargetFromCameraUpdater(Actor(Pos, Q, Target), c).Update(0); Check(m, "targetFrom", c);
        c = Cam(); new TargetFromCameraUpdater(Actor(Pos, Q, FarTarget), c).Update(0); Check(m, "targetFromFar", c);
        c = Cam(); new ShowcaseCameraUpdater(Actor(Pos, Q), c).Update(0); Check(m, "showcase", c);
        c = Cam(); { var u = new StaticModelCameraUpdater(Actor(Pos, Q), c); u.SetTarget(new Vec3d(-50, 12, 75), 2.2); u.Update(0); } Check(m, "staticModel", c);
        c = Cam(); new CarrierOverSternCameraUpdater(Actor(Pos, Q), c, new Carrier()).Update(0); Check(m, "carrier", c);
        c = Cam(); { var u = new CrashedCameraUpdater(Actor(Pos, Q), c); u.Update(1.3); u.Update(13); } Check(m, "crashed", c);
        c = Cam(); new CrashedCameraUpdater(Actor(Pos, Q, null, new Vec3d(1300, 790, -4300)), c).Update(0.7); Check(m, "crashedWreck", c);
        c = Cam(); new AiExteriorCameraUpdater(Actor(Pos, Q), c, new Chase()).Update(0); Check(m, "aiBack", c);
        c = Cam(); new AiExteriorCameraUpdater(Actor(Pos, Q), c, new Chase(), ExteriorViewHeading.Front).Update(0); Check(m, "aiFront", c);
        c = Cam(); { var u = new FixedCameraUpdater(null, c); u.SetPose(new Vec3d(5, 6, 7), 123.4, -17.5); u.Move(30, -4, 2); u.Update(0); } Check(m, "fixed", c);

        c = Cam();
        { var u = new CockpitFrontCameraUpdater(Actor(Pos, Q, Target), c); u.SetPadlock(true); u.Update(0); }
        m.Close("project", V3(Fx.GetProperty("project")), c.Project(new Vec3d(3100, 1000, -2400)), 1e-12);
        m.Close("worldDir", V3(Fx.GetProperty("worldDir")), c.GetWorldDirection(), 1e-12);

        m.AssertNone();
    }

    [Fact]
    public void UpdatersWithNothingToFollowLeaveTheCameraAlone()
    {
        var c = Cam();
        c.Position = new Vec3d(1, 2, 3);
        new TargetFromCameraUpdater(Actor(Pos, Q), c).Update(0);
        new CarrierOverSternCameraUpdater(Actor(Pos, Q), c).Update(0);
        Assert.Equal(new Vec3d(1, 2, 3), c.Position);
        Assert.Equal(Quatd.Identity, c.Quaternion);
        Assert.Equal(0, TargetCamera.UpdateTargetCamera(Actor(Pos, Q), c, c));
    }
}

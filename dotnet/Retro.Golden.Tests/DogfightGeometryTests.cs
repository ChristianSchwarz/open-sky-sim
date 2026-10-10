using System.Text.Json;
using Retro.Core;
using Retro.Sim;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

public class DogfightGeometryTests
{
    private static readonly JsonElement Fx = Load("dogfight_geometry.json");

    [Fact]
    public void AllFunctionsMatchTheOracle()
    {
        var m = new Mismatches();
        double tol = Num(Fx.GetProperty("tolerances"), "absolute");
        int i = 0;
        foreach (JsonElement c in Fx.GetProperty("cases").EnumerateArray())
        {
            string at = $"case {i++}";
            Vec3d myPos = V3(c.GetProperty("myPos")), myVel = V3(c.GetProperty("myVel"));
            Vec3d tgtPos = V3(c.GetProperty("tgtPos")), tgtVel = V3(c.GetProperty("tgtVel"));
            Vec3d tgtAcc = V3(c.GetProperty("tgtAcc")), fwd = V3(c.GetProperty("fwd"));
            double muzzle = Num(c, "muzzleSpeed");

            m.Close($"{at} speed", Num(c, "speed"), JsMath.Hypot(myVel.X, myVel.Y, myVel.Z), tol);
            m.Close($"{at} energy", Num(c, "specificEnergyHeight"), DogfightGeometry.SpecificEnergyHeight(myPos.Y, Num(c, "speed")), tol);
            m.Close($"{at} closure", Num(c, "closureRate"), DogfightGeometry.ClosureRate(myPos, myVel, tgtPos, tgtVel), tol);
            m.Close($"{at} tracking", Num(c, "trackingAngle"), DogfightGeometry.TrackingAngle(myPos, fwd, tgtPos), tol);
            m.Close($"{at} aspect", Num(c, "aspectAngle"), DogfightGeometry.AspectAngle(myPos, tgtPos, tgtVel), tol);
            m.Close($"{at} angleOff", Num(c, "angleOff"), DogfightGeometry.AngleOff(myVel, tgtVel), tol);

            Vec3d relPos = tgtPos - myPos, relVel = tgtVel - myVel;
            double tof = DogfightGeometry.SolveInterceptTime(relPos, relVel, muzzle);
            m.Close($"{at} tof", Num(c, "solveInterceptTime"), tof, tol);
            m.Close($"{at} tofClamped", Num(c, "solveInterceptTimeClamped"), DogfightGeometry.SolveInterceptTime(relPos, relVel, muzzle, 1.0), tol);

            double aimTof = DogfightGeometry.BallisticAimPoint(out Vec3d aim, myPos, myVel, tgtPos, tgtVel, tgtAcc, muzzle);
            JsonElement ap = c.GetProperty("ballisticAimPoint");
            m.Close($"{at} aim", V3(ap.GetProperty("point")), aim, tol);
            m.Close($"{at} aim tof", Num(ap, "tof"), aimTof, tol);

            Vec3d nose = fwd.LengthSquared > 1e-9 ? fwd.Normalized() : fwd;
            Vec3d bulletVel = nose * muzzle + myVel;
            m.Close($"{at} miss", Num(c, "predictedMissDistance"),
                DogfightGeometry.PredictedMissDistance(myPos, bulletVel, tgtPos, tgtVel, tgtAcc, tof), tol);
        }
        m.AssertNone();
    }
}

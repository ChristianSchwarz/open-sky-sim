using System;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// The flight models the combat sim can own (port of physics/sim/simFlightModel.ts):
    /// the <see cref="FlightModel"/> contract plus the contact and terrain hooks the
    /// sim drives directly. FM2 and FM3 both carry them; these extensions dispatch.
    /// </summary>
    public static class SimFlightModel
    {
        public static FlightModel Create(SimFlightModelKind kind, Fm2AircraftConfig config = null)
        {
            if (kind == SimFlightModelKind.Fm3) return new Fm3FlightModel(config);
            return new Fm2FlightModel(config, new Fm2ModelOptions { Kinematic = kind == SimFlightModelKind.Debug });
        }

        /// <summary>The model a description asks for; older descriptions only carry `kinematic`.</summary>
        public static SimFlightModelKind ModelKindFromDesc(SimAircraftDesc desc)
        {
            return desc.Model ?? (desc.Kinematic == true ? SimFlightModelKind.Debug : SimFlightModelKind.Fm2);
        }

        private static Exception Unsupported(FlightModel m) =>
            new InvalidOperationException($"{m.GetType().Name} is not a sim flight model");

        public static void SetWorldQuery(this FlightModel m, IGroundQuery world)
        {
            if (m is Fm2FlightModel f2) f2.SetWorldQuery(world);
            else if (m is Fm3FlightModel f3) f3.SetWorldQuery(world);
            else throw Unsupported(m);
        }

        public static void ClearAngularVelocity(this FlightModel m)
        {
            if (m is Fm2FlightModel f2) f2.ClearAngularVelocity();
            else if (m is Fm3FlightModel f3) f3.ClearAngularVelocity();
            else throw Unsupported(m);
        }

        public static double ContactSpeedIntoNormal(this FlightModel m, Vec3d pointWorld, Vec3d normalWorld)
        {
            if (m is Fm2FlightModel f2) return f2.ContactSpeedIntoNormal(pointWorld, normalWorld);
            if (m is Fm3FlightModel f3) return f3.ContactSpeedIntoNormal(pointWorld, normalWorld);
            throw Unsupported(m);
        }

        public static void ApplyContactDragAt(this FlightModel m, Vec3d pointWorld, double dt, double dragPerSec, double massFraction, double maxFrac)
        {
            if (m is Fm2FlightModel f2) f2.ApplyContactDragAt(pointWorld, dt, dragPerSec, massFraction, maxFrac);
            else if (m is Fm3FlightModel f3) f3.ApplyContactDragAt(pointWorld, dt, dragPerSec, massFraction, maxFrac);
            else throw Unsupported(m);
        }

        /// <summary>The aircraft's mass (kg).</summary>
        public static double GetMassKg(this FlightModel m)
        {
            if (m is Fm2FlightModel f2) return f2.MassKg;
            if (m is Fm3FlightModel f3) return f3.MassKg;
            throw Unsupported(m);
        }

        /// <summary>World velocity of the material point of the airframe now at pointWorld.</summary>
        public static Vec3d PointVelocity(this FlightModel m, Vec3d pointWorld)
        {
            if (m is Fm2FlightModel f2) return f2.PointVelocity(pointWorld);
            if (m is Fm3FlightModel f3) return f3.PointVelocity(pointWorld);
            throw Unsupported(m);
        }

        /// <summary>1/m + (r x d) . I^-1 (r x d): the rigid body's effective inverse mass at a point.</summary>
        public static double InvEffectiveMass(this FlightModel m, Vec3d pointWorld, Vec3d dirWorld)
        {
            if (m is Fm2FlightModel f2) return f2.InvEffectiveMass(pointWorld, dirWorld);
            if (m is Fm3FlightModel f3) return f3.InvEffectiveMass(pointWorld, dirWorld);
            throw Unsupported(m);
        }
    }

    /// <summary>
    /// The slice of the mirrored DEM (terrain/heightMirror.ts MirroredHeightField)
    /// the combat sim reads. The sim's default is <see cref="UnconfiguredHeightField"/>,
    /// which answers exactly as the TS mirror does before it is configured.
    /// </summary>
    public interface ISimHeightField
    {
        /// <summary>Scene Y of the DEM at (x, z).</summary>
        double HeightAtWorld(double x, double z);
        /// <summary>Height above the ellipsoid of a point in the air.</summary>
        double GeodeticAltitudeAtWorld(double x, double y, double z);
        /// <summary>True when the answer here is as good as the render thread's.</summary>
        bool IsAuthoritativeAt(double x, double z);
        bool IsLandAtWorld(double x, double z);
    }

    /// <summary>An unconfigured mirror: sea level 0, altitude = scene Y, never authoritative, no land.</summary>
    public sealed class UnconfiguredHeightField : ISimHeightField
    {
        public double HeightAtWorld(double x, double z) => 0;
        public double GeodeticAltitudeAtWorld(double x, double y, double z) => y;
        public bool IsAuthoritativeAt(double x, double z) => false;
        public bool IsLandAtWorld(double x, double z) => false;
    }
}

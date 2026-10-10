using System;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>Flight condition and control state seen by one surface.</summary>
    public struct SurfaceInput
    {
        /// <summary>Body-frame velocity of the CG through the air (m/s).</summary>
        public Vec3d VelocityBody;
        /// <summary>Body-frame angular velocity (rad/s).</summary>
        public Vec3d AngularVelocityBody;
        /// <summary>Air density (kg/m^3).</summary>
        public double AirDensity;
        /// <summary>Effective incidence added by control deflection (rad).</summary>
        public double ControlDeltaAoaRad;
        /// <summary>Symmetric camber bias, e.g. flaps (rad).</summary>
        public double CamberBiasRad;
        /// <summary>Reduction of the stall AoA, e.g. from flaps (rad).</summary>
        public double StallShiftRad;
        /// <summary>Additional profile drag coefficient (referenced to this surface's area).</summary>
        public double ExtraCd;
        /// <summary>Integration timestep (s); drives the unsteady separation-state lag.</summary>
        public double Dt;
    }

    /// <summary>
    /// A single rigid aerodynamic surface for the FM2 parts model (port of
    /// physics/fm2/aeroSurface.ts).
    ///
    /// Given the body-frame linear and angular velocity and the air density, the
    /// surface computes its lift + drag and the moment about the CG. The airflow
    /// it sees includes the velocity from rotation at its own location,
    /// u_local = v_body + w x r, so pitch, roll and yaw damping all emerge from the
    /// geometry.
    /// </summary>
    public sealed class AeroSurface
    {
        public readonly string Name;
        private readonly SurfaceGeometry geom;

        /// <summary>Application point relative to the (fixed) CG; also the moment arm.</summary>
        private readonly Vec3d position;
        private readonly Vec3d up;
        private readonly Vec3d forward;
        private readonly Vec3d span;

        /// <summary>Last computed angle of attack for this surface (rad).</summary>
        public double LastAoaRad;

        /// <summary>
        /// Lagged effective AoA the SEPARATED flow sees (rad). Ericsson's cobra
        /// physics: dynamic pitching makes vortex formation / breakdown lag the
        /// geometric AoA, so separation is delayed on rapid pitch-up and reattachment
        /// is delayed on the way down (hysteresis). Feeds the CL/CD separation blend
        /// and the vortex window; the attached term stays on the instantaneous AoA.
        /// With UnsteadyTauS unset/0 it tracks the geometric AoA exactly.
        /// </summary>
        private double aoaSepLagged;
        private bool sepLagInitialized;

        /// <summary>Last lift force this surface produced (body frame, N); for debug overlays.</summary>
        public Vec3d LiftForceBody;
        /// <summary>Last drag force this surface produced (body frame, N); for debug overlays.</summary>
        public Vec3d DragForceBody;

        public AeroSurface(SurfaceGeometry geom)
        {
            this.geom = geom;
            Name = geom.Name;
            position = new Vec3d(geom.Position[0], geom.Position[1], geom.Position[2]);
            up = new Vec3d(geom.Up[0], geom.Up[1], geom.Up[2]).Normalized();
            forward = new Vec3d(geom.Forward[0], geom.Forward[1], geom.Forward[2]).Normalized();
            // Spanwise axis (the direction ignored when measuring AoA).
            span = Vec3d.Cross(up, forward).Normalized();
        }

        public Vec3d PositionBody => position;

        /// <summary>Clear transient (unsteady) aero state so a re-init snaps to the trim AoA.</summary>
        public void ResetState()
        {
            LastAoaRad = 0;
            aoaSepLagged = 0;
            sepLagInitialized = false;
        }

        /// <summary>Accumulate this surface's body-frame force (N) and moment about the CG (N m).</summary>
        public void Accumulate(in SurfaceInput input, ref Vec3d outForce, ref Vec3d outMoment)
        {
            // Local velocity through the air at the surface: v + w x r.
            Vec3d rot = Vec3d.Cross(input.AngularVelocityBody, position);
            // Once this surface's flow is separated, cut its rate-damping contribution
            // (a stalled tail damps far less). Uses last step's AoA as the separation
            // gauge so a transient high-AoA pitch overshoot can survive (cobra).
            double dampScale = geom.HighAoaDampingScale ?? 1;
            if (dampScale < 1 && Math.Abs(LastAoaRad) > geom.StallAoaRad)
            {
                rot = rot * dampScale;
            }
            Vec3d u = input.VelocityBody + rot;

            // Remove the spanwise component (that flow does not make lift here).
            double spanComp = Vec3d.Dot(u, span);
            u = u.AddScaled(span, -spanComp);

            double speedSq = u.LengthSquared;
            if (speedSq < 1e-4)
            {
                LastAoaRad = 0;
                LiftForceBody = Vec3d.Zero;
                DragForceBody = Vec3d.Zero;
                return;
            }
            double speed = Math.Sqrt(speedSq);

            double uf = Vec3d.Dot(u, forward);
            double uu = Vec3d.Dot(u, up);
            double aoa = JsTrig.Atan2(-uu, uf);
            LastAoaRad = aoa;

            double effectiveAoa = aoa + input.ControlDeltaAoaRad + input.CamberBiasRad;

            // Advance the unsteady separation-state lag (Ericsson hysteresis). With no
            // UnsteadyTauS (or a non-positive dt) it snaps to the geometric AoA, so the
            // surface is exactly quasi-steady.
            double tau = geom.UnsteadyTauS ?? 0;
            if (!sepLagInitialized || tau <= 0 || input.Dt <= 0)
            {
                aoaSepLagged = effectiveAoa;
                sepLagInitialized = true;
            }
            else
            {
                aoaSepLagged += (effectiveAoa - aoaSepLagged) * (1 - Math.Exp(-input.Dt / tau));
            }

            double stall = geom.StallAoaRad - input.StallShiftRad;
            double cl = LiftCoefficient(
                effectiveAoa, geom.LiftSlopePerRad, stall, geom.VortexLiftScale ?? 0,
                geom.ZeroLiftAoaRad ?? 0, geom.ClMax, aoaSepLagged);
            double cd = DragCoefficient(
                effectiveAoa, cl, geom.Cd0 + input.ExtraCd, geom.InducedK,
                stall, geom.FlatPlateCd ?? DefaultFlatPlateCd, aoaSepLagged);

            // Drag acts downstream (direction the air is moving relative to the surface).
            Vec3d dragDir = u * (-1 / speed);
            // Lift is perpendicular to the relative wind, in the surface's lift plane.
            Vec3d liftDir = Vec3d.Cross(span, dragDir).Normalized();

            double q = 0.5 * input.AirDensity * speedSq;
            double area = geom.AreaM2;
            double lift = q * area * cl;
            double drag = q * area * cd;

            LiftForceBody = liftDir * lift;
            DragForceBody = dragDir * drag;

            double fx = liftDir.X * lift + dragDir.X * drag;
            double fy = liftDir.Y * lift + dragDir.Y * drag;
            double fz = liftDir.Z * lift + dragDir.Z * drag;
            outForce.X += fx;
            outForce.Y += fy;
            outForce.Z += fz;

            // Moment about the (fixed) CG: r x F.
            double rx = position.X, ry = position.Y, rz = position.Z;
            outMoment.X += ry * fz - rz * fy;
            outMoment.Y += rz * fx - rx * fz;
            outMoment.Z += rx * fy - ry * fx;
        }

        /// <summary>Fully-separated flat-plate lift amplitude: CL ~ 1.1 sin(2 alpha).</summary>
        private const double FlatPlateCl = 1.1;
        /// <summary>Logistic steepness (per rad) of the attached-to-separated LIFT blend across stall.</summary>
        private const double LiftSeparationSteepness = 8;
        /// <summary>Soft-clip knee exponent for the attached lift.</summary>
        private const double ClSoftclipExponent = 4;

        /// <summary>
        /// Lift coefficient over the whole AoA range as one smooth (C1) curve: attached
        /// lift slope*(alpha - alpha0) softly saturated toward +-CLmax with a p-norm knee,
        /// blended by a logistic window centred on stall into flat-plate lift
        /// 1.1 sin(2 alpha), plus an optional raised-cosine vortex/strake bump from stall
        /// to 90 degrees. The blend and the vortex window key off aoaSepRad (the lagged
        /// separation-state AoA), giving Ericsson's hysteresis.
        /// </summary>
        public static double LiftCoefficient(
            double aoaRad, double slopePerRad, double stallRad, double vortexScale = 0,
            double alpha0 = 0, double? clMaxOverride = null, double? aoaSepRad = null)
        {
            double aoaSep = aoaSepRad ?? aoaRad;
            double sign = Fm2Math.Or(JsMath.Sign(aoaRad), 1);
            double clMax = clMaxOverride ?? (slopePerRad * stallRad);

            double linear = slopePerRad * (aoaRad - alpha0);
            double norm = Math.Abs(linear) / clMax;
            double attached = linear / Math.Pow(1 + Math.Pow(norm, ClSoftclipExponent), 1 / ClSoftclipExponent);

            // Fully-separated flat-plate lift (odd in alpha, so lift reverses past +-90 degrees).
            double flat = FlatPlateCl * JsTrig.Sin(2 * aoaRad);

            double magSep = Math.Abs(aoaSep);
            double sep = 1 / (1 + Math.Exp(-LiftSeparationSteepness * (magSep - stallRad)));
            double cl = (1 - sep) * attached + sep * flat;

            // Optional vortex / strake lift: a raised-cosine bump spanning stall to ~90
            // degrees, peaking ~50 degrees, keyed on the lagged AoA.
            if (vortexScale > 0)
            {
                double vortexPeak = 50 * (Math.PI / 180);
                double vortexEnd = 90 * (Math.PI / 180);
                if (magSep > stallRad && magSep < vortexEnd)
                {
                    double half = magSep <= vortexPeak
                        ? (magSep - stallRad) / (vortexPeak - stallRad)
                        : (vortexEnd - magSep) / (vortexEnd - vortexPeak);
                    double window = 0.5 * (1 - JsTrig.Cos(Math.PI * JsMath.Clamp(half, 0, 1)));
                    cl += sign * window * clMax * vortexScale;
                }
            }
            return cl;
        }

        /// <summary>Logistic steepness of the attached-to-separated drag transition (per rad).</summary>
        private const double DragSeparationSteepness = 15;
        private const double DefaultFlatPlateCd = 2.0;

        /// <summary>
        /// Drag coefficient over the whole AoA range after Walter Bislin: the attached
        /// parabolic polar CD0 + K CL^2 blended across stall into a flat-plate term
        /// flatPlateCd * 1/2 (1 - cos 2 alpha). The blend keys off aoaSepRad.
        /// </summary>
        public static double DragCoefficient(
            double aoaRad, double cl, double parasiticCd, double inducedK,
            double stallRad, double flatPlateCd = DefaultFlatPlateCd, double? aoaSepRad = null)
        {
            double aoaSep = aoaSepRad ?? aoaRad;
            double attached = parasiticCd + inducedK * cl * cl;
            double flatPlate = flatPlateCd * 0.5 * (1 - JsTrig.Cos(2 * aoaRad));
            double sep = 1 / (1 + Math.Exp(-DragSeparationSteepness * (Math.Abs(aoaSep) - stallRad)));
            return (1 - sep) * attached + sep * flatPlate;
        }
    }
}

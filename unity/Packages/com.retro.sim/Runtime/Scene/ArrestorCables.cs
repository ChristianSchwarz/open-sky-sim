using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>One cable as local endpoints relative to the carrier origin.</summary>
    public struct ArrestorCableLocal
    {
        public double Ax, Ay, Az, Bx, By, Bz;
    }

    /// <summary>One cable in world space.</summary>
    public sealed class ArrestorCableSegment
    {
        public Vec3d A;
        public Vec3d B;
    }

    /// <summary>World-space cable field for one carrier.</summary>
    public sealed class ArrestorCableField
    {
        public double OriginX;
        public double OriginY;
        public double OriginZ;
        /// <summary>Unit vector: landing / roll-out direction (toward bow).</summary>
        public Vec3d DeckAxis;
        public List<ArrestorCableSegment> Segments = new List<ArrestorCableSegment>();
    }

    /// <summary>Live carrier placement used to transform cable locals into world space.</summary>
    public sealed class ArrestorCarrierPose
    {
        public Vec3d Position;
        /// <summary>Identity when null (carrier yaw = 0).</summary>
        public Quatd? Quaternion;
        public Vec3d? Velocity;
    }

    /// <summary>
    /// Carrier arrestor cables: local layout, snag detection and deck-axis arrest
    /// (port of scene/entities/arrestorCables.ts, collider logic only).
    /// </summary>
    public static class ArrestorCables
    {
        /// <summary>Approximate Kuznetsov deck mid-X.</summary>
        public const double ArrestorDeckMidX = (-34.33 + 43.83) * 0.5;
        /// <summary>Half-width of each cable across the landing lane (m).</summary>
        public const double ArrestorHalfSpanM = 18;
        /// <summary>Cable height in carrier-local Y.</summary>
        public const double ArrestorCableY = 13.85;
        /// <summary>Local Z of the four wires, stern to bow (landing along -Z).</summary>
        public static readonly double[] ArrestorCableLocalZ = { 95, 83, 71, 59 };

        /// <summary>Max horizontal miss from cable for a catch (m).</summary>
        public const double ArrestorCatchRadiusM = 2.0;
        /// <summary>Max |hookY - cableY| allowed for a catch (m).</summary>
        private const double ArrestorCatchVertM = 2.5;
        /// <summary>Minimum along-deck speed to snag (m/s).</summary>
        private const double ArrestorMinSnagSpeedMps = 15;
        /// <summary>Release when along-deck speed drops below this (m/s).</summary>
        public const double ArrestorStopSpeedMps = 0.5;
        /// <summary>After a completed trap, drop the cable once groundspeed exceeds this (m/s).</summary>
        public const double ArrestorReleaseSpeedMps = 3.0;
        /// <summary>Deck run-out from snag to full stop (m).</summary>
        public const double ArrestorPullOutM = 140;
        /// <summary>Cap on arrest deceleration (m/s^2); ~4 g.</summary>
        private const double ArrestorMaxDecelMps2 = 4.0 * 9.80665;

        /// <summary>Hook assembly sits this far above the belly line it was authored at.</summary>
        private const double TailhookMountUpM = 0.7;

        /// <summary>afterburnerCones.ts DEFAULT_ENGINE_NOZZLES.</summary>
        public static readonly double[][] DefaultEngineNozzles =
        {
            new[] { -0.75, 0.05, -4.85 },
            new[] { 0.75, 0.05, -4.85 },
        };

        /// <summary>Default body-frame hook tip; coincides with default nozzle exit Z.</summary>
        public static readonly double[] DefaultArrestorHookBody = { 0, -1.7 + TailhookMountUpM, -4.85 };

        /// <summary>Hinge sits this far above the tip in body Y (m).</summary>
        private const double ArrestorHookHingeUpM = 0.75;
        /// <summary>Hinge sits this far forward of the tip in body +Z (m).</summary>
        public const double ArrestorHookHingeFwdM = 1.0;

        public static readonly double[] DefaultArrestorHookHinge =
        {
            DefaultArrestorHookBody[0],
            DefaultArrestorHookBody[1] + ArrestorHookHingeUpM,
            DefaultArrestorHookBody[2] + ArrestorHookHingeFwdM,
        };

        /// <summary>Arm length hinge to tip (m).</summary>
        public static readonly double TailhookArmLengthM = JsMath.Hypot(ArrestorHookHingeUpM, ArrestorHookHingeFwdM);

        /// <summary>state/worldLayout.ts CARRIER_ORIGIN.</summary>
        public static readonly Vec3d ArrestorCarrierOrigin = new Vec3d(10000, 0, -2000);

        /// <summary>Place the hook tip at the nozzle exits; falls back to an explicit tip, then the default.</summary>
        public static double[] ResolveArrestorHookTip(double[] explicitHook, double[] nozzleZs, double? tipYOpt)
        {
            double tipY = tipYOpt ?? DefaultArrestorHookBody[1];
            if (nozzleZs != null && nozzleZs.Length > 0)
            {
                double aft = nozzleZs[0];
                for (int i = 1; i < nozzleZs.Length; i++)
                {
                    aft = Math.Min(aft, nozzleZs[i]);
                }
                return new[] { 0, tipY, aft };
            }
            if (explicitHook != null)
            {
                return new[] { explicitHook[0], explicitHook[1], explicitHook[2] };
            }
            return new[] { DefaultArrestorHookBody[0], tipY, DefaultArrestorHookBody[2] };
        }

        /// <summary>Map a carrier-local point into world space.</summary>
        public static Vec3d CarrierLocalToWorld(double localX, double localY, double localZ, ArrestorCarrierPose pose)
        {
            var o = new Vec3d(localX, localY, localZ);
            if (pose.Quaternion.HasValue)
            {
                o = o.Rotate(pose.Quaternion.Value);
            }
            return o + pose.Position;
        }

        /// <summary>World position of the left sheave ("start") of cable `index`.</summary>
        public static Vec3d ArrestorCableStartWorld(int index, ArrestorCarrierPose pose)
        {
            ArrestorCableLocal[] locals = ArrestorCableLocals();
            int i = Math.Max(0, Math.Min(locals.Length - 1, index));
            ArrestorCableLocal c = locals[i];
            return CarrierLocalToWorld(c.Ax, c.Ay, c.Az, pose);
        }

        /// <summary>Latched visual tip: on the hinge-to-sheave ray at the arm length.</summary>
        public static Vec3d LatchedHookTipWorld(Vec3d hinge, Vec3d sheave, out Vec3d outDir, Vec3d? fallbackDir = null)
        {
            Vec3d dir = sheave - hinge;
            if (dir.LengthSquared < 1e-8)
            {
                if (fallbackDir.HasValue && fallbackDir.Value.LengthSquared > 1e-8)
                {
                    dir = fallbackDir.Value;
                }
                else
                {
                    dir = new Vec3d(0, -ArrestorHookHingeUpM, -ArrestorHookHingeFwdM);
                }
            }
            dir = dir.Normalized();
            outDir = dir;
            return hinge.AddScaled(dir, TailhookArmLengthM);
        }

        /// <summary>Four lateral cables in carrier-local space.</summary>
        public static ArrestorCableLocal[] ArrestorCableLocals()
        {
            double mid = ArrestorDeckMidX;
            double hs = ArrestorHalfSpanM;
            double y = ArrestorCableY;
            var result = new ArrestorCableLocal[ArrestorCableLocalZ.Length];
            for (int i = 0; i < result.Length; i++)
            {
                double z = ArrestorCableLocalZ[i];
                result[i] = new ArrestorCableLocal { Ax = mid - hs, Ay = y, Az = z, Bx = mid + hs, By = y, Bz = z };
            }
            return result;
        }

        /// <summary>Build world segments from a carrier origin (optional orientation).</summary>
        public static ArrestorCableField BuildArrestorCableField(
            double originX, double originY, double originZ, Vec3d? deckAxis = null, Quatd? orientation = null)
        {
            ArrestorCableLocal[] locals = ArrestorCableLocals();
            var pose = new ArrestorCarrierPose { Position = new Vec3d(originX, originY, originZ), Quaternion = orientation };
            var segments = new List<ArrestorCableSegment>();
            foreach (ArrestorCableLocal c in locals)
            {
                segments.Add(new ArrestorCableSegment
                {
                    A = CarrierLocalToWorld(c.Ax, c.Ay, c.Az, pose),
                    B = CarrierLocalToWorld(c.Bx, c.By, c.Bz, pose),
                });
            }
            Vec3d axis = deckAxis ?? new Vec3d(0, 0, -1);
            if (orientation.HasValue)
            {
                axis = axis.Rotate(orientation.Value);
            }
            return new ArrestorCableField
            {
                OriginX = originX,
                OriginY = originY,
                OriginZ = originZ,
                DeckAxis = axis.Normalized(),
                Segments = segments,
            };
        }

        /// <summary>Hook world position from CG pose and body-frame hook.</summary>
        public static Vec3d HookWorldPos(Vec3d position, Quatd quaternion, Vec3d hookBody)
        {
            return hookBody.Rotate(quaternion) + position;
        }

        /// <summary>Distance from point P to segment AB.</summary>
        public static double DistancePointToSegment(Vec3d p, Vec3d a, Vec3d b)
        {
            double abx = b.X - a.X;
            double aby = b.Y - a.Y;
            double abz = b.Z - a.Z;
            double apx = p.X - a.X;
            double apy = p.Y - a.Y;
            double apz = p.Z - a.Z;
            double abLenSq = abx * abx + aby * aby + abz * abz;
            double t = abLenSq > 1e-12 ? (apx * abx + apy * aby + apz * abz) / abLenSq : 0;
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
            double cx = a.X + abx * t;
            double cy = a.Y + aby * t;
            double cz = a.Z + abz * t;
            double dx = p.X - cx;
            double dy = p.Y - cy;
            double dz = p.Z - cz;
            return Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }

        /// <summary>Returns the latched cable index, or -1 if no snag.</summary>
        public static int TrySnag(Vec3d hook, Vec3d? prevHook, Vec3d vel, ArrestorCableField field, bool hookDown)
        {
            if (!hookDown) return -1;
            double along = Vec3d.Dot(vel, field.DeckAxis);
            if (along < ArrestorMinSnagSpeedMps) return -1;

            for (int i = 0; i < field.Segments.Count; i++)
            {
                ArrestorCableSegment seg = field.Segments[i];
                double cableY = (seg.A.Y + seg.B.Y) * 0.5;
                if (Math.Abs(hook.Y - cableY) > ArrestorCatchVertM) continue;

                double cableZ = (seg.A.Z + seg.B.Z) * 0.5;
                double midX = (seg.A.X + seg.B.X) * 0.5;
                double halfSpan = Math.Abs(seg.B.X - seg.A.X) * 0.5;
                bool inLane = Math.Abs(hook.X - midX) <= halfSpan + ArrestorCatchRadiusM;

                bool crossed = false;
                if (prevHook.HasValue)
                {
                    // Landing along -Z: crossed when previous Z was aft of the wire.
                    crossed = prevHook.Value.Z > cableZ && hook.Z <= cableZ;
                }
                if (crossed && inLane)
                {
                    return i;
                }

                double d = DistancePointToSegment(hook, seg.A, seg.B);
                if (d <= ArrestorCatchRadiusM && inLane)
                {
                    return i;
                }
            }
            return -1;
        }

        /// <summary>
        /// Scrub along-deck speed to reach targetAlong in remainingDist metres
        /// (a = v^2 / 2s, capped). Returns true while still trapping.
        /// </summary>
        public static bool ApplyArrestorVelocity(
            ref Vec3d vel, Vec3d deckAxis, double dt, double remainingDist = ArrestorPullOutM, double targetAlong = 0)
        {
            double along = Vec3d.Dot(vel, deckAxis);
            double rel = along - targetAlong;
            if (Math.Abs(rel) <= ArrestorStopSpeedMps || remainingDist <= 0)
            {
                if (rel != 0)
                {
                    vel = vel.AddScaled(deckAxis, -rel);
                }
                return false;
            }
            double aNeeded = (rel * rel) / (2 * Math.Max(remainingDist, 0.25));
            double a = Math.Min(aNeeded, ArrestorMaxDecelMps2);
            double dv = JsMath.Sign(rel) * Math.Min(Math.Abs(rel), a * dt);
            vel = vel.AddScaled(deckAxis, -dv);
            return true;
        }
    }
}

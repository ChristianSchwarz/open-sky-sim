using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// One wingtip's trail (wingtipTrails.ts WingTrailSide): a ring of the last
    /// <see cref="WingtipTrails.PositionCount"/> tip samples in scene coordinates,
    /// and its camera-facing segment quads laid out as instance matrices, oldest
    /// first, each with its own dither level.
    /// </summary>
    public sealed class WingTrailSide
    {
        private readonly Vec3d[] history = new Vec3d[WingtipTrails.PositionCount];
        private int head;
        private Vec3d lastSample;
        private bool hasLastSample;

        /// <summary>
        /// setMatrixAt targets: per drawn segment a column-major 4x4 (three.js
        /// Matrix4.elements order), float32 as the InstancedMesh stores it. Only the
        /// first <see cref="DrawnCount"/> * 16 entries are this frame's; the rest are left over.
        /// </summary>
        public readonly float[] Matrices = new float[WingtipTrails.SegmentCount * 16];

        /// <summary>Per drawn segment its <c>ditherLevel</c> (opacity, 0.05 oldest to 0.9 newest), float32.</summary>
        public readonly float[] Levels = new float[WingtipTrails.SegmentCount];

        /// <summary>Samples held (up to PositionCount).</summary>
        public int SampleCount { get; private set; }

        /// <summary>Segments laid out by the last <see cref="LayoutSegments"/> (the instance count).</summary>
        public int DrawnCount { get; private set; }

        /// <summary>Whether the side is drawn (root.visible).</summary>
        public bool Visible { get; private set; }

        public void Reset()
        {
            head = 0;
            SampleCount = 0;
            hasLastSample = false;
            DrawnCount = 0;
            Visible = false;
        }

        /// <summary>tryPush: record the tip once it is <paramref name="spacingM"/> from the last sample.</summary>
        public void TryPush(Vec3d tipWorld, double spacingM)
        {
            if (!hasLastSample || DistanceSquared(lastSample, tipWorld) >= spacingM * spacingM)
            {
                history[head] = tipWorld;
                head = (head + 1) % WingtipTrails.PositionCount;
                SampleCount = Math.Min(SampleCount + 1, WingtipTrails.PositionCount);
                lastSample = tipWorld;
                hasLastSample = true;
            }
        }

        private static double DistanceSquared(Vec3d a, Vec3d b)
        {
            double dx = a.X - b.X, dy = a.Y - b.Y, dz = a.Z - b.Z;
            return dx * dx + dy * dy + dz * dz;
        }

        /// <summary>historyAt: the sample <paramref name="ageFromNewest"/> pushes ago.</summary>
        public Vec3d HistoryAt(int ageFromNewest) =>
            history[(head - 1 - ageFromNewest + WingtipTrails.PositionCount * 2) % WingtipTrails.PositionCount];

        /// <summary>
        /// layoutSegments: one quad per pair of consecutive samples (the newest joined
        /// to <paramref name="currentTip"/>), skipping those under 1 cm. Each quad is the
        /// unit XY plane scaled to (2 * SegmentWidth, length, 1), its Y along the trail,
        /// turned about the trail toward the camera, centred on the segment midpoint.
        /// </summary>
        public void LayoutSegments(Vec3d cameraPos, Vec3d currentTip)
        {
            if (SampleCount == 0)
            {
                Visible = false;
                return;
            }
            int segmentLimit = Math.Min(WingtipTrails.SegmentCount, SampleCount);
            int drawn = 0;
            for (int i = 0; i < WingtipTrails.SegmentCount; i++)
            {
                int age = WingtipTrails.SegmentCount - 1 - i;
                if (age >= segmentLimit) continue;
                Vec3d from, to;
                if (age == 0)
                {
                    from = HistoryAt(0);
                    to = currentTip;
                }
                else
                {
                    from = HistoryAt(age);
                    to = HistoryAt(age - 1);
                }
                Vec3d dir = to - from;
                double length = dir.Length;
                if (length < 0.01) continue;
                dir = dir * (1 / length);
                Vec3d mid = (from + to) * 0.5;

                Vec3d viewDir = cameraPos - mid;
                viewDir = viewDir.LengthSquared < 1e-8 ? new Vec3d(0, 0, 1) : viewDir.Normalized();
                Vec3d right = Vec3d.Cross(dir, viewDir);
                if (right.LengthSquared < 1e-6) right = Vec3d.Cross(dir, Vec3d.UnitY);
                right = right.Normalized();
                Vec3d up = Vec3d.Cross(right, dir).Normalized();

                Quatd q = Quatd.FromRotationMatrix(new Mat3d(
                    right.X, dir.X, up.X,
                    right.Y, dir.Y, up.Y,
                    right.Z, dir.Z, up.Z));
                Compose(Matrices, drawn * 16, mid, q, WingtipTrails.SegmentWidth * 2, length, 1);
                Levels[drawn] = (float)WingtipTrails.SegmentDither(i);
                drawn++;
            }
            DrawnCount = drawn;
            Visible = drawn > 0;
        }

        /// <summary>three.js Matrix4.compose written into a Float32Array at <paramref name="o"/>.</summary>
        private static void Compose(float[] te, int o, Vec3d p, Quatd q, double sx, double sy, double sz)
        {
            double x = q.X, y = q.Y, z = q.Z, w = q.W;
            double x2 = x + x, y2 = y + y, z2 = z + z;
            double xx = x * x2, xy = x * y2, xz = x * z2;
            double yy = y * y2, yz = y * z2, zz = z * z2;
            double wx = w * x2, wy = w * y2, wz = w * z2;
            te[o] = (float)((1 - (yy + zz)) * sx);
            te[o + 1] = (float)((xy + wz) * sx);
            te[o + 2] = (float)((xz - wy) * sx);
            te[o + 3] = 0f;
            te[o + 4] = (float)((xy - wz) * sy);
            te[o + 5] = (float)((1 - (xx + zz)) * sy);
            te[o + 6] = (float)((yz + wx) * sy);
            te[o + 7] = 0f;
            te[o + 8] = (float)((xz + wy) * sz);
            te[o + 9] = (float)((yz - wx) * sz);
            te[o + 10] = (float)((1 - (xx + yy)) * sz);
            te[o + 11] = 0f;
            te[o + 12] = (float)p.X;
            te[o + 13] = (float)p.Y;
            te[o + 14] = (float)p.Z;
            te[o + 15] = 1f;
        }

        /// <summary>
        /// The four corners of drawn segment <paramref name="k"/> (the PlaneGeometry(1, 1)
        /// vertices (-0.5, 0.5), (0.5, 0.5), (-0.5, -0.5), (0.5, -0.5) through its
        /// matrix), for a frontend that builds one ribbon mesh instead of instancing.
        /// Computed from the float32 matrix, in float.
        /// </summary>
        public void SegmentCorners(int k, Span<float> xyz12)
        {
            int o = k * 16;
            ReadOnlySpan<float> m = Matrices;
            for (int c = 0; c < 4; c++)
            {
                float u = (c & 1) == 0 ? -0.5f : 0.5f;
                float v = c < 2 ? 0.5f : -0.5f;
                xyz12[c * 3] = m[o] * u + m[o + 4] * v + m[o + 12];
                xyz12[c * 3 + 1] = m[o + 1] * u + m[o + 5] * v + m[o + 13];
                xyz12[c * 3 + 2] = m[o + 2] * u + m[o + 6] * v + m[o + 14];
            }
        }

        /// <summary>rebase: carry every history slot (used or not) and the last sample into the new frame.</summary>
        public void Rebase(FrameShift shift)
        {
            for (int i = 0; i < history.Length; i++) history[i] = shift.Point(history[i]);
            lastSample = shift.Point(lastSample);
        }
    }

    /// <summary>
    /// Wingtip vortex trails, CPU side (port of wingtipTrails.ts). Every
    /// <see cref="Update"/> carries the two tips (body frame, moved
    /// <see cref="AftOffsetM"/> aft) into the scene and records each once it has
    /// moved a speed-dependent spacing; <see cref="Layout"/> turns the history
    /// into camera-facing segments. The oracle has no g, AoA, altitude or
    /// humidity condition: a trail forms at any speed (MIN_TRAIL_SPEED_MPS = 0),
    /// and its fade is by sample age only (segment dither 0.05 oldest to 0.9 newest).
    /// </summary>
    public sealed class WingtipTrails
    {
        /// <summary>POSITION_COUNT: samples per side.</summary>
        public const int PositionCount = 51;
        /// <summary>SEGMENT_COUNT: segments (instances) per side.</summary>
        public const int SegmentCount = 50;
        public const double DitherMin = 0.05;
        public const double DitherMax = 0.9;
        /// <summary>SEGMENT_WIDTH: half the quad width (m); quads are 2 * 0.0784 m wide.</summary>
        public const double SegmentWidth = 0.0784;
        /// <summary>WINGTIP_TRAIL_AFT_OFFSET_M: tip origins move this far aft (-Z body).</summary>
        public const double AftOffsetM = 1;
        public const double MinTrailSpeedMps = 0;
        public const double SampleSpacingSpeedFactor = 0.028;
        public const double MinSampleSpacingM = 0.45;
        public const double MaxSampleSpacingM = 3.5;

        /// <summary>F16_PROFILE.wingSpanM / 2: the last-resort tips when none are set.</summary>
        private const double DefaultWingtipOutward = 9.45 * 0.5;
        public static readonly Vec3d DefaultLeftWingtip = new Vec3d(DefaultWingtipOutward, -0.28, -2.7);
        public static readonly Vec3d DefaultRightWingtip = new Vec3d(-DefaultWingtipOutward, -0.28, -2.7);

        /// <summary>TRAIL_WHITE '#ffffff': both tones of the trail material.</summary>
        public static readonly float[] TrailColor = { 1f, 1f, 1f };

        public readonly WingTrailSide Left = new WingTrailSide();
        public readonly WingTrailSide Right = new WingTrailSide();

        private Vec3d leftTipBody = DefaultLeftWingtip;
        private Vec3d rightTipBody = DefaultRightWingtip;

        /// <summary>The scene tip positions of the last <see cref="Update"/> (the newest segment's end).</summary>
        public Vec3d LeftTip { get; private set; }
        public Vec3d RightTip { get; private set; }

        /// <summary>segmentDither: the opacity of the segment drawn at slot <paramref name="index"/> (0 oldest).</summary>
        public static double SegmentDither(int index) =>
            DitherMin + (DitherMax - DitherMin) * ((double)index / (SegmentCount - 1));

        /// <summary>sampleSpacingM: clamp(speed * 0.028, 0.45, 3.5) metres between samples.</summary>
        public static double SampleSpacingM(double speedMps) =>
            Math.Min(MaxSampleSpacingM, Math.Max(MinSampleSpacingM, speedMps * SampleSpacingSpeedFactor));

        public void Reset()
        {
            Left.Reset();
            Right.Reset();
        }

        /// <summary>setTipOrigins: the tips in the body frame (+Z forward).</summary>
        public void SetTipOrigins(Vec3d left, Vec3d right)
        {
            leftTipBody = left;
            rightTipBody = right;
        }

        /// <summary>update: place both tips by the display pose and push a sample where due.</summary>
        public void Update(Vec3d displayPosition, Quatd displayQuaternion, Vec3d displayVelocity)
        {
            double speed = displayVelocity.Length;
            if (speed >= MinTrailSpeedMps)
            {
                double spacing = SampleSpacingM(speed);
                LeftTip = new Vec3d(leftTipBody.X, leftTipBody.Y, leftTipBody.Z - AftOffsetM).Rotate(displayQuaternion) + displayPosition;
                RightTip = new Vec3d(rightTipBody.X, rightTipBody.Y, rightTipBody.Z - AftOffsetM).Rotate(displayQuaternion) + displayPosition;
                Left.TryPush(LeftTip, spacing);
                Right.TryPush(RightTip, spacing);
            }
        }

        /// <summary>The render-list half of addToRenderList: lay out both sides facing the camera.</summary>
        public void Layout(Vec3d cameraPos)
        {
            Left.LayoutSegments(cameraPos, LeftTip);
            Right.LayoutSegments(cameraPos, RightTip);
        }

        /// <summary>rebase: the histories move; the current tips do not (the next update re-places them).</summary>
        public void Rebase(FrameShift shift)
        {
            Left.Rebase(shift);
            Right.Rebase(shift);
        }
    }
}

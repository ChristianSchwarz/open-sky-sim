using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// The structural damage of a living aircraft (port of
    /// scene/entities/airframeDamage.ts): how far its fuselage has bent, and which
    /// wing sections and parts have been torn off, from the hard ground impacts
    /// that did not destroy it. When it is finally destroyed the break-up carries
    /// on from here (see <see cref="WreckSource.Damage"/>).
    ///
    /// All geometry here is in the body frame, in metres: the aircraft draws
    /// <see cref="Root"/> at its own pose (position and rotation, no scale), in
    /// place of the undamaged airframe.
    /// </summary>
    public sealed class AirframeDamage
    {
        /// <summary>The hardest impact so far, as a crash severity (0.2 .. 1.5). 0 = undamaged.</summary>
        public double Severity;

        /// <summary>Wing sections (body cells 3..6) torn off so far.</summary>
        public readonly HashSet<int> RippedCells = new HashSet<int>();

        /// <summary>Parts torn off so far (gear 0, control surface i = 1 + i, second and later gear legs 1000 + ...).</summary>
        public readonly HashSet<int> RippedParts = new HashSet<int>();

        /// <summary>The bent, torn airframe in the body frame: draw it at the aircraft pose. Null while undamaged.</summary>
        public List<WreckMeshData> Root;

        /// <summary>The fuselage's two joints (index 1: fore/middle, 2: middle/aft; 0 unused), summed over the impacts.</summary>
        public readonly JointState[] Joints = { new JointState(), new JointState(), new JointState() };

        /// <summary>How far each wing section (cell 3-6) is folded, summed over the impacts (+ = tip up), rad.</summary>
        public readonly Dictionary<int, double> WingFold = new Dictionary<int, double>();

        /// <summary>How each part still on is carried by the bend.</summary>
        public readonly Dictionary<int, PartBend> PartBends = new Dictionary<int, PartBend>();

        /// <summary>
        /// The gear legs that are still on are part of <see cref="Root"/> (bent, the
        /// torn ones gone): the aircraft must not draw its gear model as well.
        /// </summary>
        public bool GearInRoot;

        /// <summary>Parts on a folded wing: drawn with <see cref="Root"/> as they are, not posed from their own model.</summary>
        public readonly HashSet<int> RootParts = new HashSet<int>();

        /// <summary>Where fuel fires have been started (-1 fuselage, else the wing cell), once each.</summary>
        public readonly HashSet<int> FireSites = new HashSet<int>();

        /// <summary>When (field time, s) the last blow landed: close blows are one impact.</summary>
        public double LastBlowAt = double.NegativeInfinity;

        /// <summary>True once the airframe has been bent or torn.</summary>
        public bool Active => Root != null;

        public bool IsPartRipped(int id) => RippedParts.Contains(id);

        /// <summary>
        /// Carry a part's pose along with the bend: <paramref name="position"/> /
        /// <paramref name="quaternion"/> are its undamaged world pose and are replaced
        /// by where it now is. The body pose and scale are those the airframe is drawn with.
        /// </summary>
        public void TransformPart(int id, ref Vec3d position, ref Quatd quaternion, Vec3d bodyPosition, Quatd bodyQuaternion, Vec3d scale)
        {
            if (!PartBends.TryGetValue(id, out PartBend bend))
            {
                return;
            }
            Quatd inv = bodyQuaternion.Conjugate();
            // Into the body frame, in model units.
            Vec3d p = WreckMath.Div((position - bodyPosition).Rotate(inv), scale);
            p = WreckMath.ApplyMatrix4(p, bend.M);
            p = WreckMath.Mul(p, scale);
            position = p.Rotate(bodyQuaternion) + bodyPosition;
            // Its own turn, then the section's.
            Quatd q = inv * quaternion;
            q = bend.Q * q;
            quaternion = bodyQuaternion * q;
        }

        /// <summary>Throw the damaged airframe away (a new aircraft).</summary>
        public void Reset()
        {
            Severity = 0;
            RippedCells.Clear();
            RippedParts.Clear();
            PartBends.Clear();
            foreach (JointState j in Joints)
            {
                j.Yaw = 0;
                j.Pitch = 0;
                j.Shift = 0;
            }
            WingFold.Clear();
            GearInRoot = false;
            RootParts.Clear();
            FireSites.Clear();
            LastBlowAt = double.NegativeInfinity;
            Root = null;
        }

        /// <summary>Replace the drawn airframe.</summary>
        public void SetRoot(List<WreckMeshData> root)
        {
            Root = root;
        }
    }

    /// <summary>
    /// Per-aircraft crash edge detector (port of wreckField.ts WreckTracker).
    /// Remembers the velocity from a few frames back, because by the time the
    /// aircraft reads as crashed the sim has already bled off speed in the
    /// contact response.
    /// </summary>
    public sealed class WreckTracker
    {
        private const int VelocityHistory = 8;

        /// <summary>True while the aircraft is shown as a wreck (its own mesh must stay hidden).</summary>
        public bool Shown;

        public WreckField Field;

        private readonly Vec3d[] history = new Vec3d[VelocityHistory];
        private int cursor;
        private int filled;
        private bool wasCrashed;

        /// <summary>
        /// Call once per rendered frame. Returns the pre-impact velocity on the
        /// frame the aircraft first reads as crashed, otherwise null.
        /// </summary>
        public Vec3d? Sample(bool crashed, Vec3d velocity)
        {
            if (!crashed)
            {
                history[cursor] = velocity;
                cursor = (cursor + 1) % VelocityHistory;
                filled = System.Math.Min(filled + 1, VelocityHistory);
                wasCrashed = false;
                Shown = false;
                return null;
            }
            if (wasCrashed)
            {
                return null;
            }
            wasCrashed = true;
            // The oldest sample still on record.
            int oldest = filled < VelocityHistory ? 0 : cursor;
            return history[oldest];
        }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// Breaks a crashed aircraft into rigid pieces that keep moving on their own
    /// (port of scene/entities/wreckField.ts, engine-free).
    ///
    /// Where it hit decides what happens: the body is cut into fuselage and wing
    /// sections, the wings fold and the fuselage dislocates and bends at its two
    /// joints, and the sections nearest the impact (and the weakest joints, and
    /// everything on a hard enough hit) come away as separate fragments, each with
    /// the velocity the airframe had at that spot, less what the ground took, plus
    /// a kick away from it. Sections that hold stay together as one lump. Gear legs
    /// and control surfaces are pieces of their own. Pieces bounce, slide, split
    /// further, topple and settle, ride a moving deck, float and sink in the sea.
    ///
    /// <see cref="ApplyDamage"/> is the survivable side: an impact that bends and
    /// tears a living aircraft, kept in an <see cref="AirframeDamage"/>.
    ///
    /// Every Math.random draw of the TS goes through the injected random source,
    /// in the TS order, so a seeded source replays the golden oracle. The frame
    /// is the scene's (x east, y up, z south; body +Z is the nose).
    /// </summary>
    public sealed partial class WreckField
    {
        // --- constants (wreckField.ts) --------------------------------------------------

        /// <summary>Vertices closer than this (m) are one vertex when working out what is connected.</summary>
        internal const double WeldM = 0.06;
        private const int ComponentMinTris = 10;
        private const int ComponentMaxKeep = 6;
        private static readonly int[][] CellNeighbours = { new[] { 1 }, new[] { 0, 2, 3, 5 }, new[] { 1 }, new[] { 1, 4 }, new[] { 3 }, new[] { 1, 6 }, new[] { 5 } };

        private const double Gravity = 9.80665;
        private const double TrailStepM = 3;
        private const int TrailMarksMax = 30;
        private const double ShardMinSeverity = 0.35;
        private const int ShardMax = 9;
        private const int ShardMaxTris = 36;
        private const int ShardMinSourceTris = 24;
        private const int ShardMinLeftTris = 8;
        private const double SplitMinImpactMps = 8;
        private const double SplitSureImpactMps = 38;
        private const int SplitMaxDepth = 3;
        private const double SplitMinSizeM = 2.5;
        private const double FuselageTearThreshold = 1.15;
        private const double WingTearThreshold = 0.7;
        private const double PartTearThreshold = 0.6;
        private const double DislocateMinSeverity = 0.22;
        private const double DislocateBaseHalfWidths = 0.25;
        private const double DislocatePerSeverityHalfWidths = 0.6;
        private const double DislocateMaxHalfWidths = 1.2;
        private const double KinkBaseRad = 0.08;
        private const double KinkPerSeverityRad = 0.25;
        private const double KinkMaxRad = 0.5;
        private const double DislocateNearJointShare = 0.7;
        private const double BendRampFrom = 0.2;
        private const double BendRampTo = 0.5;
        private const double CumulativeShare = 0.35;
        private const double SameImpactS = 0.6;
        private static readonly double WingBendMaxRad = 20 * Math.PI / 180;
        private const double WingBendMinRad = 0.06;
        private const double GearBendGain = 3;
        private const double GearBendMaxRad = 2.4;
        private const double GearLegMergeM = 0.15;
        private const int GearLegIdBase = 1000;
        private const double BendBaseRad = 0.1;
        private const double BendPerSeverityRad = 1.6;
        private const double BendMaxRad = 2.4;
        private const double BendPlaneBlowShare = 0.5;
        private const double BendUpShare = 0.75;
        private const double WaterEntryKeep = 0.45;
        private const double WaterSpinKeep = 0.6;
        private const double WaterDragPerS = 2.4;
        private const double WaterSpinDragPerS = 1.6;
        private const double WaterSinkMps = 0.7;
        private const double WaterFloatS = 10;
        private const double WaterSinkEaseS = 2;
        private const double WaterFloatDepth = 0.3;
        private const double WaterBobM = 0.15;
        private const double FoamRateBase = 3;
        private const double FoamRatePerM = 2.5;
        private const double FoamFloatingStrength = 0.55;
        private const double FoamEntryS = 1.5;
        private const double FoamNoneDepthM = 8;
        private const int FoamEntryPuffs = 8;
        private const double WaterSinkRelaxPerS = 3;
        private const double WaterSubmergedM = 1.2;
        private const double WaterHideDepthM = 25;
        private const int MaxFragments = 80;
        private const double MaxStepS = 1.0 / 30;
        private const int Substeps = 2;
        private const double SleepSpeedMps = 0.45;
        private const double SleepSpinRadps = 0.35;
        private const double ToppleMinHalfM = 1.2;
        private const double ToppleMinUp = 0.45;
        private const double ToppleRadps2 = 2.5;
        private const double SettleMinHalfM = 1.0;
        private const double SettleFlatness = 0.7;
        private const double SettleMinSin = 0.15;
        private const double SettleGiveUpS = 14;
        private const double ReseatIntervalS = 0.25;
        private const double ReseatSinkM = 0.03;
        private const double ReseatHangM = 0.4;
        private const double TallRatio = 1.15;
        private const double SleepAfterS = 0.8;
        private const double BaseFriction = 0.25;
        private const int CellCount = 7;
        private static readonly double[] CellWeakness = { 1.0, 0.95, 1.15, 1.1, 1.3, 1.1, 1.3 };

        private static double BendRamp(double severity) =>
            JsMath.Clamp((severity - BendRampFrom) / (BendRampTo - BendRampFrom), 0, 1);

        // --- callbacks (the TS optional members) ------------------------------------------

        /// <summary>Called once per break-up, for debris, dust and fires.</summary>
        public Action<WreckEvent> OnBreakup;

        /// <summary>A mark on the ground: ground point, ground normal, long-axis direction (dirX, dirZ, horizontal, not normalised), length, width, darkness 0..1.</summary>
        public Action<Vec3d, Vec3d, double, double, double, double, double> OnMark;

        /// <summary>A scratch laid by a burning piece should smoulder: ground point, seconds, intensity 0..1.</summary>
        public Action<Vec3d, double, double> OnBurn;

        /// <summary>A piece broke apart (or parts were torn off a living aircraft): where, how fast it was going, strength.</summary>
        public Action<Vec3d, Vec3d, double> OnSplit;

        /// <summary>Dust kicked up by a piece striking or sliding along the ground: where, the piece's velocity, puff count, strength.</summary>
        public Action<Vec3d, Vec3d, int, double> OnDust;

        /// <summary>A piece has gone into the water: where (on the surface), its velocity, how hard (0.2..1.6).</summary>
        public Action<Vec3d, Vec3d, double> OnSplash;

        /// <summary>Foam on the water round a piece in it: centre of the patch (on the surface), the piece's size (m), puffs to lay.</summary>
        public Action<Vec3d, double, int> OnFoam;

        /// <summary>A living aircraft was bent or torn by an impact it survived: fuel fires start where.</summary>
        public Action<WreckDamageEvent> OnDamage;

        /// <summary>A new piece exists (C# only: the frontend builds its meshes once).</summary>
        public event Action<WreckFragment> FragmentAdded;

        /// <summary>A piece is gone (split, dropped over the cap, or cleared).</summary>
        public event Action<WreckFragment> FragmentRemoved;

        // --- state ----------------------------------------------------------------------

        private readonly Func<double> random;
        private readonly List<WreckFragment> fragments = new List<WreckFragment>();
        private readonly List<WreckFire> fires = new List<WreckFire>();

        private struct BodyFrameInfo
        {
            public double Cx, ZMin, ZMax, HalfSpan;
        }

        /// <summary>Where the body sits in its own frame (from the last slice).</summary>
        private BodyFrameInfo? bodyFrame;

        /// <summary>How far the last break-up shifted the rear of the fuselage sideways (m, signed, toward +x of the body); 0 if left in line.</summary>
        public double LastDislocationM;

        /// <summary>The twist (rad, signed) of that dislocation.</summary>
        public double LastKinkRad;

        /// <summary>The angle (rad) the tail was bent through by the last break-up.</summary>
        public double LastBendRad;

        /// <summary>The upward (+) or downward (-) part of that bend, rad.</summary>
        public double LastBendUpRad;

        /// <summary>The size of the whole fold now, summed over every impact so far (rad).</summary>
        public double LastTotalBendRad;

        private OrderedIntSet lastBentCells = new OrderedIntSet();
        private OrderedIntSet lastBrokenCells = new OrderedIntSet();

        /// <summary>Seconds of simulated time (sum of update deltas): damage blows are told apart by it.</summary>
        private double clock;

        /// <summary>Triangles dropped as scraps (joined to nothing) by the last break-up.</summary>
        public int LastScrapTriangles;

        private Dictionary<WreckChunk, PartBend> lastPartBends = new Dictionary<WreckChunk, PartBend>();
        private IWreckMovingSurface movingSurface;
        private Func<double, double, bool> isWaterAt;
        private Func<double, double, double> waterSurfaceAt;
        private readonly List<(WreckFragment Fragment, double Impact)> pendingSplits = new List<(WreckFragment, double)>();

        private sealed class Cockpit
        {
            public WreckFragment Fragment;
            public Vec3d Local;
            public Quatd Q0;
        }

        private readonly Dictionary<string, Cockpit> cockpits = new Dictionary<string, Cockpit>();
        private int serial;
        private Func<double, double, double> groundHeightAt = (x, z) => 0;

        /// <summary>TOPPLE_AXIS: the direction the topple/settle helpers leave for the torque.</summary>
        private Vec3d toppleAxis;

        /// <param name="random">Math.random; a seeded source replays the oracle. Null picks a time-seeded one.</param>
        public WreckField(Func<double> random = null)
        {
            this.random = random ?? Retro.Sim.Gun.Mulberry32((uint)Environment.TickCount);
        }

        /// <summary>The live pieces, oldest first (the TS root's children, same order).</summary>
        public IReadOnlyList<WreckFragment> Fragments => fragments;

        /// <summary>Every fire riding on a piece (the TS fires list).</summary>
        public IReadOnlyList<WreckFire> Fires => fires;

        /// <summary>Tell the field where the sea is: pieces going into it splash and sink instead of landing.</summary>
        public void SetWaterTest(Func<double, double, bool> fn, Func<double, double, double> surface = null)
        {
            isWaterAt = fn;
            waterSurfaceAt = surface;
        }

        /// <summary>True if a point is open water.</summary>
        public bool InWater(double x, double z) => isWaterAt != null && isWaterAt(x, z);

        /// <summary>Wreckage lying on this surface goes along with it.</summary>
        public void SetMovingSurface(IWreckMovingSurface surface)
        {
            movingSurface = surface;
        }

        public void SetGroundHeightAt(Func<double, double, double> fn)
        {
            groundHeightAt = fn;
        }

        /// <summary>A floating-origin re-base: every piece's pose and motion into the new frame.</summary>
        public void Rebase(FrameShift shift)
        {
            foreach (WreckFragment f in fragments)
            {
                f.Position = shift.Point(f.Position);
                f.Quaternion = shift.Orientation(f.Quaternion);
                f.Velocity = shift.Vector(f.Velocity);
                f.Spin = shift.Vector(f.Spin);
            }
        }

        /// <summary>Remove every fragment (respawn).</summary>
        public void Clear()
        {
            foreach (WreckFragment f in fragments)
            {
                DisposeFragment(f);
            }
            fragments.Clear();
            fires.Clear();
            pendingSplits.Clear();
            cockpits.Clear();
        }

        // --- break-up -------------------------------------------------------------------

        /// <summary>
        /// Take the aircraft apart. Returns false when there is nothing drawable to
        /// break up (model not loaded), in which case the caller keeps drawing it.
        /// </summary>
        public bool Spawn(WreckSource src)
        {
            LastScrapTriangles = 0;
            List<WreckChunk> bodyChunks = SliceBody(src);
            if (bodyChunks == null)
            {
                return false;
            }
            List<WreckChunk> partChunks = SlicePartChunks(src);
            // What was torn off by earlier, survivable impacts is already gone.
            if (src.Damage != null)
            {
                AirframeDamage damage = src.Damage;
                bodyChunks = bodyChunks.Where(c => !damage.RippedCells.Contains(c.Cell)).ToList();
                partChunks = partChunks.Where(c => c.PartId == null || !damage.RippedParts.Contains(c.PartId.Value)).ToList();
            }

            // Impact point: the lowest vertex of the airframe.
            Vec3d impact = LowestVertex(bodyChunks.Concat(partChunks));

            Vec3d groundN = GroundNormal(src.Position.X + impact.X, src.Position.Z + impact.Z);
            Vec3d v = src.Velocity;
            double vn = Vec3d.Dot(v, groundN);
            Vec3d vNormal = groundN * vn;
            Vec3d vTangent = v - vNormal;
            double speedInto = Math.Max(0, -vn);
            double speedAlong = vTangent.Length;
            // Already bent and torn: the final blow counts for more (see ApplyDamage).
            double crash = JsMath.Clamp((speedInto + 0.35 * speedAlong) / 110, 0.2, 1.5);
            double prior = src.Damage?.Severity ?? 0;
            double severity = prior > 0
                ? Math.Min(1.5, Math.Max(crash, prior) + CumulativeShare * Math.Min(crash, prior))
                : crash;
            double size = Math.Max(src.Body.MaxSize, 1) * Math.Max(src.Scale.X, 1e-3);

            // The wings fold up where the blow reached them, then the fuselage bends round the impact.
            // (What the airframe has already had is kept; this crash adds its own bend, in its own direction.)
            var priorFold = new Dictionary<int, double>();
            if (src.Damage != null)
            {
                foreach (KeyValuePair<int, double> kv in src.Damage.WingFold) priorFold[kv.Key] = kv.Value;
            }
            var priorJoints = new JointState[3];
            for (int i = 0; i < 3; i++)
            {
                priorJoints[i] = new JointState
                {
                    Yaw = src.Damage?.Joints[i].Yaw ?? 0,
                    Pitch = src.Damage?.Joints[i].Pitch ?? 0,
                    Shift = src.Damage?.Joints[i].Shift ?? 0,
                };
            }
            BendWings(bodyChunks, partChunks, src, impact, crash, size, priorFold);
            DislocateFuselage(bodyChunks, partChunks, src, impact, crash, priorJoints);
            BendGearLegs(partChunks, src, impact, severity, size);

            // Decide which sections break away; the rest stay on the airframe.
            var looseBody = new List<WreckChunk>();
            var hullBody = new List<WreckChunk>();
            var looseParts = new List<WreckChunk>();
            var keptParts = new List<WreckChunk>();
            var keptGear = new List<WreckChunk>();
            bool BreaksAway(WreckChunk chunk, bool isPart)
            {
                Vec3d centre = chunk.Box.Center;
                double d = Math.Min(1.15, Vec3d.Distance(centre, impact) / size);
                double near = 1.15 - d;
                double score = severity * chunk.Weakness * near
                    + 0.6 * Math.Max(0, severity - 0.7)
                    + (random() - 0.5) * 0.3 * BendRamp(severity);
                // The fuselage dislocates and folds first; only a blow far past what takes a wing off
                // tears one of its sections away, at a joint.
                if (!isPart && chunk.Cell >= 0 && chunk.Cell <= 2)
                {
                    return score > FuselageTearThreshold;
                }
                if (!isPart && lastBrokenCells.Contains(chunk.Cell))
                {
                    return true;
                }
                return score > (isPart ? PartTearThreshold : WingTearThreshold);
            }
            foreach (WreckChunk chunk in bodyChunks)
            {
                (BreaksAway(chunk, false) ? looseBody : hullBody).Add(chunk);
            }
            foreach (WreckChunk chunk in partChunks)
            {
                if (BreaksAway(chunk, true))
                {
                    looseParts.Add(chunk);
                }
                else if (chunk.Gear)
                {
                    keptGear.Add(chunk);
                }
                else
                {
                    keptParts.Add(chunk);
                }
            }

            // Small burning shards torn off and flung clear, cut out of the airframe's own triangles.
            int shardCount = severity < ShardMinSeverity
                ? 0
                : (int)JsMath.Clamp(JsMath.Round(1 + 6 * (severity - 0.2)), 1, ShardMax);
            List<WreckChunk> shards = shardCount > 0 ? ExtractShards(bodyChunks, shardCount, size) : new List<WreckChunk>();

            serial++;

            // What stays on the airframe is one piece only where its sections are really joined.
            var comps = new List<(List<WreckChunk> Chunks, bool Hull)>();
            foreach (WreckChunk c in looseBody) comps.Add((new List<WreckChunk> { c }, false));
            foreach (List<WreckChunk> joined in JoinedSections(hullBody)) comps.Add((joined, true));
            // Gear and surfaces still on are fixed to the section nearest them (the gear to the fuselage).
            List<WreckChunk> HostOf(WreckChunk part, bool fuselageOnly)
            {
                Vec3d centre = part.Box.Center;
                List<WreckChunk> pool = fuselageOnly && bodyChunks.Any(c => c.Cell <= 2) ? bodyChunks.Where(c => c.Cell <= 2).ToList() : bodyChunks;
                WreckChunk host = null;
                double hostD = double.PositiveInfinity;
                foreach (WreckChunk c in pool)
                {
                    double d = c.Box.DistanceToPoint(centre);
                    if (d < hostD)
                    {
                        hostD = d;
                        host = c;
                    }
                }
                foreach ((List<WreckChunk> chunks, bool _) in comps)
                {
                    if (host != null && chunks.Contains(host)) return chunks;
                }
                return null;
            }
            foreach (WreckChunk gear in keptGear)
            {
                HostOf(gear, true)?.Add(gear);
            }
            foreach (WreckChunk part in keptParts)
            {
                HostOf(part, false)?.Add(part);
            }
            foreach (WreckChunk part in looseParts)
            {
                comps.Add((new List<WreckChunk> { part }, false));
            }
            var owner = new Dictionary<WreckChunk, WreckFragment>();
            foreach ((List<WreckChunk> chunks, bool hull) in comps)
            {
                WreckFragment frag = BuildFragment(chunks, hull, src.Position, vNormal, vTangent, groundN, impact, severity, size);
                foreach (WreckChunk chunk in chunks)
                {
                    owner[chunk] = frag;
                }
            }

            // The cockpit piece, for the cameras.
            if (src.Cockpit.HasValue)
            {
                Vec3d eye = src.Cockpit.Value.Rotate(src.Quaternion);
                WreckFragment best = null;
                double bestD = double.PositiveInfinity;
                foreach (WreckChunk chunk in bodyChunks)
                {
                    double d = chunk.Box.DistanceToPoint(eye);
                    if (d < bestD && owner.ContainsKey(chunk))
                    {
                        bestD = d;
                        best = owner[chunk];
                    }
                }
                if (best != null)
                {
                    cockpits[src.Id] = new Cockpit { Fragment = best, Local = eye - best.Centre, Q0 = src.Quaternion };
                }
            }

            // Fires stay with the piece they were on: the fuselage burns wherever it ends up,
            // smaller fires smoulder at each wing root.
            var newFires = new List<WreckFire>();
            foreach (WreckChunk chunk in bodyChunks)
            {
                owner.TryGetValue(chunk, out WreckFragment frag);
                if (!chunk.Anchor.HasValue || frag == null)
                {
                    continue;
                }
                WreckFireKind kind = chunk.Cell == 1 ? WreckFireKind.Fuselage : WreckFireKind.WingRoot;
                if (kind == WreckFireKind.WingRoot && severity < 0.35 && random() < 0.5)
                {
                    continue;
                }
                newFires.Add(new WreckFire { Fragment = frag, Local = chunk.Anchor.Value - frag.Centre, Kind = kind });
            }
            fires.AddRange(newFires);
            if (!newFires.Any(f => f.Kind == WreckFireKind.Fuselage))
            {
                // No middle section (tiny model): burn the last piece built.
                WreckFragment frag = fragments.Count > 0 ? fragments[fragments.Count - 1] : null;
                if (frag != null)
                {
                    var fallback = new WreckFire { Fragment = frag, Local = Vec3d.Zero, Kind = WreckFireKind.Fuselage };
                    newFires.Add(fallback);
                    fires.Add(fallback);
                }
            }

            foreach (WreckChunk shard in shards)
            {
                WreckFragment frag = BuildFragment(new List<WreckChunk> { shard }, false, src.Position, vNormal, vTangent, groundN, impact, severity, size);
                BurstSideways(frag, vTangent, impact, severity);
                var brand = new WreckFire { Fragment = frag, Local = Vec3d.Zero, Kind = WreckFireKind.Brand };
                newFires.Add(brand);
                fires.Add(brand);
            }

            while (fragments.Count > MaxFragments)
            {
                WreckFragment oldest = fragments[0];
                fragments.RemoveAt(0);
                DisposeFragment(oldest);
            }

            bool water = InWater(src.Position.X + impact.X, src.Position.Z + impact.Z);
            if (!water)
            {
                MarkFirstImpact(src.Position, impact, groundN, vTangent, severity);
            }
            OnBreakup?.Invoke(new WreckEvent
            {
                Water = water,
                Id = src.Id,
                Position = impact + src.Position,
                Velocity = v,
                Normal = groundN,
                Severity = severity,
                Fires = newFires,
            });
            return fragments.Count > 0;
        }

        // --- survivable damage -------------------------------------------------------------

        /// <summary>
        /// A hard impact that did not destroy the aircraft: bend its fuselage and tear
        /// off whatever the blow is hard enough to take (wing sections, gear legs,
        /// control surfaces), which fly off as pieces, while the rest carries on. The
        /// result is kept in <paramref name="state"/>; only a harder impact than any so
        /// far (damage adds up) changes anything. <paramref name="hit"/> is the impact
        /// point in the scene. Returns whether anything changed.
        /// </summary>
        public bool ApplyDamage(WreckSource src, AirframeDamage state, double severity, Vec3d hit)
        {
            double blow = JsMath.Clamp(severity, 0.2, 1.5);
            bool sameImpact = clock - state.LastBlowAt < SameImpactS;
            double sev = sameImpact
                ? Math.Max(blow, state.Severity)
                : JsMath.Clamp(Math.Max(blow, state.Severity) + CumulativeShare * Math.Min(blow, state.Severity), 0.2, 1.5);
            state.LastBlowAt = clock;
            if (sev <= state.Severity + 0.01)
            {
                return false;
            }
            // The airframe in its own frame, at the origin, so what is cut is in the body frame.
            Quatd inv = src.Quaternion.Conjugate();
            var parts = new List<WreckPart>();
            for (int i = 0; i < src.Parts.Count; i++)
            {
                WreckPart part = src.Parts[i];
                parts.Add(new WreckPart
                {
                    Model = part.Model,
                    Kind = part.Kind,
                    Id = part.Id ?? i,
                    Position = (part.Position - src.Position).Rotate(inv),
                    Quaternion = inv * part.Quaternion,
                });
            }
            var body = new WreckSource
            {
                Id = src.Id,
                Body = src.Body,
                Position = Vec3d.Zero,
                Quaternion = Quatd.Identity,
                Scale = src.Scale,
                Velocity = src.Velocity.Rotate(inv),
                Parts = parts,
                Cockpit = src.Cockpit,
                Damage = null,
            };
            List<WreckChunk> bodyChunks = SliceBody(body);
            if (bodyChunks == null)
            {
                return false;
            }
            List<WreckChunk> partChunks = SlicePartChunks(body);
            bool gearPresent = partChunks.Any(c => c.Gear);
            bodyChunks = bodyChunks.Where(c => !state.RippedCells.Contains(c.Cell)).ToList();
            partChunks = partChunks.Where(c => c.PartId == null || !state.RippedParts.Contains(c.PartId.Value)).ToList();

            Vec3d hitLocal = (hit - src.Position).Rotate(inv);
            double size = Math.Max(src.Body.MaxSize, 1) * Math.Max(src.Scale.X, 1e-3);
            // What this blow bends is its own: added to what is already bent, in its own direction.
            double bendBy = sameImpact ? sev - state.Severity : blow;
            HashSet<int> wingParts = BendWings(bodyChunks, partChunks, body, hitLocal, bendBy, size, state.WingFold);
            DislocateFuselage(bodyChunks, partChunks, body, hitLocal, bendBy, state.Joints);
            Dictionary<WreckChunk, PartBend> bends = lastPartBends;
            BendGearLegs(partChunks, body, hitLocal, sev, size);

            // What this blow is hard enough to tear off, by the same measure as a crash.
            bool Tears(WreckChunk chunk, bool isPart)
            {
                Vec3d centre = chunk.Box.Center;
                double near = 1.15 - Math.Min(1.15, Vec3d.Distance(centre, hitLocal) / size);
                double score = sev * chunk.Weakness * near + 0.6 * Math.Max(0, sev - 0.7) + (random() - 0.5) * 0.3 * BendRamp(sev);
                return score > (isPart ? PartTearThreshold : WingTearThreshold);
            }
            bool frontPlus = src.Cockpit.HasValue && bodyFrame.HasValue
                ? src.Cockpit.Value.Z >= 0.5 * (bodyFrame.Value.ZMin + bodyFrame.Value.ZMax) : true;
            // The fuselage thirds run from low z to high z: the tail is the one away from the cockpit.
            int aftCell = frontPlus ? 0 : 2;
            bool FuselageTears(WreckChunk chunk)
            {
                Vec3d centre = chunk.Box.Center;
                double near = 1.15 - Math.Min(1.15, Vec3d.Distance(centre, hitLocal) / size);
                double score = sev * chunk.Weakness * near + 0.6 * Math.Max(0, sev - 0.7)
                    + (random() - 0.5) * 0.3 * BendRamp(sev);
                return score > FuselageTearThreshold;
            }
            var torn = new List<WreckChunk>();
            var kept = new List<WreckChunk>();
            foreach (WreckChunk chunk in bodyChunks)
            {
                // A blow that the aircraft survives can take its tail section off, never the nose or the middle.
                bool tearsFuselage = chunk.Cell == aftCell && FuselageTears(chunk);
                bool folded = chunk.Cell >= 3 && lastBrokenCells.Contains(chunk.Cell);
                if ((chunk.Cell >= 3 && Tears(chunk, false)) || tearsFuselage || folded)
                {
                    torn.Add(chunk);
                    state.RippedCells.Add(chunk.Cell);
                }
                else
                {
                    kept.Add(chunk);
                }
            }
            state.PartBends.Clear();
            var keptGear = new List<WreckChunk>();
            state.RootParts.Clear();
            foreach (WreckChunk chunk in partChunks)
            {
                if (chunk.PartId != null && Tears(chunk, true))
                {
                    torn.Add(chunk);
                    state.RippedParts.Add(chunk.PartId.Value);
                }
                else if (chunk.Gear)
                {
                    keptGear.Add(chunk); // drawn with the airframe, bent
                }
                else if (chunk.PartId != null && wingParts.Contains(chunk.PartId.Value))
                {
                    keptGear.Add(chunk); // on a folded wing: drawn with the airframe, as it is now
                    state.RootParts.Add(chunk.PartId.Value);
                }
                else if (chunk.PartId != null)
                {
                    if (bends.TryGetValue(chunk, out PartBend bend))
                    {
                        state.PartBends[chunk.PartId.Value] = bend;
                    }
                }
            }

            // The torn pieces fly off with the aircraft's own motion, out of the body frame and into the world.
            if (torn.Count > 0)
            {
                Vec3d groundN = GroundNormal(hit.X, hit.Z);
                Vec3d v = src.Velocity;
                Vec3d vNormal = groundN * Vec3d.Dot(v, groundN);
                Vec3d vTangent = v - vNormal;
                Vec3d impactRel = hit - src.Position;
                serial++;
                foreach (WreckChunk chunk in torn)
                {
                    RotateChunk(chunk, src.Quaternion);
                    BuildFragment(new List<WreckChunk> { chunk }, false, src.Position, vNormal, vTangent, groundN, impactRel, sev, size);
                }
                OnSplit?.Invoke(hit, v, Math.Min(1.5, sev));
            }

            // What is left is drawn, in the body frame, at the aircraft pose.
            var root = new List<WreckMeshData>();
            foreach (WreckChunk chunk in kept.Concat(keptGear))
            {
                foreach (WreckChunkMesh cm in chunk.Meshes)
                {
                    root.Add(ToMeshData(cm, Vec3d.Zero, false));
                }
            }
            state.Severity = sev;
            state.GearInRoot = gearPresent;
            state.SetRoot(root);
            IgniteDamage(src, state, bodyChunks, hitLocal, sev, torn);
            return true;
        }

        /// <summary>
        /// Fuel fires start as soon as the airframe is bent or torn: at the fuselage
        /// where it was bent, and at the root of each wing section that was bent or
        /// torn off, once per site. Positions are in the body frame, in metres.
        /// (Like the TS, nothing is recorded while no <see cref="OnDamage"/> listens.)
        /// </summary>
        private void IgniteDamage(WreckSource src, AirframeDamage state, List<WreckChunk> bodyChunks, Vec3d hitLocal, double sev, List<WreckChunk> torn)
        {
            if (OnDamage == null || !bodyFrame.HasValue)
            {
                return;
            }
            BodyFrameInfo frame = bodyFrame.Value;
            double sx = src.Scale.X;
            double sz = src.Scale.Z;
            var list = new List<WreckDamageFire>();
            WreckChunk middle = bodyChunks.FirstOrDefault(c => c.Cell == 1);
            double midY = middle != null && !middle.Box.IsEmpty ? middle.Box.Center.Y : hitLocal.Y;
            if ((LastDislocationM != 0 || LastBendRad != 0) && !state.FireSites.Contains(-1))
            {
                state.FireSites.Add(-1);
                double z = JsMath.Clamp(hitLocal.Z, frame.ZMin * sz, frame.ZMax * sz);
                list.Add(new WreckDamageFire { Kind = WreckFireKind.Fuselage, Local = new Vec3d(frame.Cx * sx, midY, z) });
            }
            var cells = new OrderedIntSet();
            foreach (int c in lastBentCells) cells.Add(c);
            foreach (WreckChunk c in torn)
            {
                if (c.Cell >= 3)
                {
                    cells.Add(c.Cell);
                }
            }
            foreach (int cell in cells)
            {
                if (state.FireSites.Contains(cell))
                {
                    continue;
                }
                state.FireSites.Add(cell);
                WreckChunk chunk = bodyChunks.FirstOrDefault(c => c.Cell == cell);
                int side = cell < 5 ? -1 : 1;
                int level = (cell - 3) % 2;
                double z = chunk != null && !chunk.Box.IsEmpty ? chunk.Box.Center.Z : hitLocal.Z;
                double x = (frame.Cx + side * (level == 0 ? 0.2 : 0.6) * frame.HalfSpan) * sx;
                list.Add(new WreckDamageFire { Kind = WreckFireKind.WingRoot, Local = new Vec3d(x, midY, z) });
            }
            if (list.Count > 0)
            {
                OnDamage(new WreckDamageEvent { Id = src.Id, Severity = sev, Fires = list });
            }
        }

        /// <summary>Turn a chunk's data (positions, normals, box, anchor) by a rotation.</summary>
        private static void RotateChunk(WreckChunk chunk, Quatd q)
        {
            chunk.Box.MakeEmpty();
            foreach (WreckChunkMesh cm in chunk.Meshes)
            {
                List<double> pos = cm.Pos;
                List<double> nrm = cm.Nrm;
                if (pos != null)
                {
                    for (int i = 0; i + 2 < pos.Count; i += 3)
                    {
                        Vec3d p = new Vec3d(pos[i], pos[i + 1], pos[i + 2]).Rotate(q);
                        pos[i] = p.X;
                        pos[i + 1] = p.Y;
                        pos[i + 2] = p.Z;
                        chunk.Box.ExpandByPoint(p);
                    }
                }
                if (nrm != null)
                {
                    for (int i = 0; i + 2 < nrm.Count; i += 3)
                    {
                        Vec3d p = new Vec3d(nrm[i], nrm[i + 1], nrm[i + 2]).Rotate(q);
                        nrm[i] = p.X;
                        nrm[i + 1] = p.Y;
                        nrm[i + 2] = p.Z;
                    }
                }
            }
            if (chunk.Anchor.HasValue)
            {
                chunk.Anchor = chunk.Anchor.Value.Rotate(q);
            }
        }

        // --- per frame ------------------------------------------------------------------

        /// <summary>Step every piece (two substeps of at most 1/60 s each), then apply the splits they asked for.</summary>
        public void Update(double delta)
        {
            clock += delta;
            double dt = Math.Min(delta, MaxStepS) / Substeps;
            if (dt <= 0)
            {
                return;
            }
            CarryWithSurface(delta);
            ReseatSleepers(delta);
            for (int s = 0; s < Substeps; s++)
            {
                foreach (WreckFragment f in fragments)
                {
                    if (!f.Asleep)
                    {
                        Step(f, dt);
                    }
                }
                ApplySplits();
            }
        }

        /// <summary>
        /// A piece at rest is not stepped, so every so often it checks its contact
        /// points against the ground: sunk in, it is lifted out; left hanging over a
        /// gap, it wakes and falls.
        /// </summary>
        private void ReseatSleepers(double delta)
        {
            foreach (WreckFragment f in fragments)
            {
                if (!f.Asleep || f.Disposed || f.Wet)
                {
                    continue;
                }
                f.ReseatS = (f.ReseatS ?? random() * ReseatIntervalS) + delta;
                if (f.ReseatS < ReseatIntervalS)
                {
                    continue;
                }
                f.ReseatS = 0;
                double sunk = 0;
                double lowestGap = double.PositiveInfinity;
                foreach (Vec3d c in f.Corners)
                {
                    Vec3d r = c.Rotate(f.Quaternion);
                    double wx = f.Position.X + r.X;
                    double wz = f.Position.Z + r.Z;
                    double gap = f.Position.Y + r.Y - groundHeightAt(wx, wz);
                    sunk = Math.Max(sunk, -gap);
                    lowestGap = Math.Min(lowestGap, gap);
                }
                if (sunk > ReseatSinkM)
                {
                    f.Position = new Vec3d(f.Position.X, f.Position.Y + sunk, f.Position.Z);
                }
                else if (lowestGap > ReseatHangM)
                {
                    f.Asleep = false;
                    f.RestTime = 0;
                }
            }
        }

        /// <summary>Note which pieces lie on the moving surface this frame, and carry the ones at rest along with it.</summary>
        private void CarryWithSurface(double delta)
        {
            IWreckMovingSurface surface = movingSurface;
            foreach (WreckFragment f in fragments)
            {
                Vec3d p = f.Position;
                // Judged by the piece's lowest point: a tall piece has its centre well above the deck.
                double probeY = p.Y;
                if (surface != null)
                {
                    double[] e = WreckMath.RotationFromQuaternion(f.Quaternion);
                    double hy = Math.Abs(e[1]) * f.Half.X + Math.Abs(e[5]) * f.Half.Y + Math.Abs(e[9]) * f.Half.Z;
                    probeY = p.Y - hy + 0.5;
                }
                // A piece in the water is in the water: the ship's motion does not carry it.
                f.OnMover = !f.Wet && surface != null && surface.Contains(p.X, probeY, p.Z);
                if (f.OnMover && f.Asleep)
                {
                    f.Position = p.AddScaled(surface.Velocity, delta);
                }
            }
        }

        // --- cameras and fires -------------------------------------------------------------

        /// <summary>
        /// Where the aircraft's origin and orientation would be if the airframe were
        /// still rigid with its cockpit piece, so cameras that place themselves from
        /// the aircraft pose follow the cockpit after a crash.
        /// </summary>
        public bool CockpitBodyPose(string id, out Vec3d position, out Quatd quaternion)
        {
            position = default;
            quaternion = Quatd.Identity;
            if (!cockpits.TryGetValue(id, out Cockpit c) || c.Fragment.Disposed)
            {
                return false;
            }
            WreckFragment f = c.Fragment;
            position = f.OriginLocal.Rotate(f.Quaternion) + f.Position;
            quaternion = f.Quaternion * c.Q0;
            if (f.Wet)
            {
                // A camera riding the cockpit down stays above the water and watches it go.
                position = new Vec3d(position.X, Math.Max(position.Y, f.WaterY + 1), position.Z);
            }
            return true;
        }

        /// <summary>World position of the pilot's eye on its wreck piece; false if none (or dropped).</summary>
        public bool CockpitWorld(string id, out Vec3d position)
        {
            position = default;
            if (!cockpits.TryGetValue(id, out Cockpit c) || c.Fragment.Disposed)
            {
                return false;
            }
            position = c.Local.Rotate(c.Fragment.Quaternion) + c.Fragment.Position;
            return true;
        }

        /// <summary>World position of a fire; false once its fragment has been dropped or has sunk.</summary>
        public bool FireWorld(WreckFire fire, out Vec3d position)
        {
            position = default;
            if (fire.Fragment.Disposed || fire.Fragment.Submerged)
            {
                return false;
            }
            position = fire.Local.Rotate(fire.Fragment.Quaternion) + fire.Fragment.Position;
            return true;
        }

        private void DisposeFragment(WreckFragment f)
        {
            f.Disposed = true;
            FragmentRemoved?.Invoke(f);
        }

        private Vec3d GroundNormal(double x, double z)
        {
            const double e = 2;
            double dx = groundHeightAt(x + e, z) - groundHeightAt(x - e, z);
            double dz = groundHeightAt(x, z + e) - groundHeightAt(x, z - e);
            return new Vec3d(-dx / (2 * e), 1, -dz / (2 * e)).Normalized();
        }

        /// <summary>A Set&lt;number&gt; that keeps insertion order, as JS sets do.</summary>
        internal sealed class OrderedIntSet : IEnumerable<int>
        {
            private readonly List<int> items = new List<int>();
            private readonly HashSet<int> set = new HashSet<int>();

            public void Add(int v)
            {
                if (set.Add(v)) items.Add(v);
            }

            public bool Contains(int v) => set.Contains(v);

            public int Count => items.Count;

            public IEnumerator<int> GetEnumerator() => items.GetEnumerator();

            System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => items.GetEnumerator();
        }

        /// <summary>Test hook: the wing cells the last fold bent, in order.</summary>
        public IReadOnlyList<int> LastBentCells => lastBentCells.ToList();

        /// <summary>Test hook: the wing cells the last fold would have bent past the maximum.</summary>
        public IReadOnlyList<int> LastBrokenCells => lastBrokenCells.ToList();
    }
}

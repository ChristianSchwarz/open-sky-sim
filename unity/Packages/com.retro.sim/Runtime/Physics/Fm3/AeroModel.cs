using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>Everything the aerodynamics needs that isn't the rigid-body state.</summary>
    public sealed class AeroEnvironment
    {
        public double Rho;
        public double SoundSpeed;
        /// <summary>CG height above the ground (m), for ground effect.</summary>
        public double HeightAboveGround;
        /// <summary>Landing gear extension, 0..1.</summary>
        public double GearDown;
    }

    public struct NasaCoefficients
    {
        public double CX, CY, CZ;
        public double Cl, Cm, Cn;
        public double CL, CD;
    }

    public sealed class StaticCondition
    {
        public double Alpha;
        public double? Beta;
        public double? Speed;
        public double? Rho;
        public double? SoundSpeed;
        /// <summary>NASA body rates (rad/s).</summary>
        public double? P, Q, R;
        public double? HeightAboveGround;
        public double? GearDown;
        public Dictionary<Fm3Channel, double> Controls;
    }

    public struct StripLoad
    {
        public string Name;
        public double[] Force;
        public double[] Moment;
    }

    public struct StripDiagnostic
    {
        public string Group;
        public double Alpha;
        public double Separation;
        public double InducedAngle;
        public double Cl;
        public double Cd;
        public double WakeQ;
    }

    /// <summary>
    /// FM3 aerodynamics (port of physics/fm3/aeroModel.ts): turns an
    /// <see cref="Fm3Airframe"/> into the force and moment on the rigid body.
    ///
    /// Every contribution is computed from the local flow at its own location (the
    /// CG's velocity through the air plus w x r) so rate damping, sideslip effects
    /// and the asymmetric loads of a rolling, yawing, stalled aircraft come out of
    /// the geometry:
    ///
    ///  - Lifting surfaces are cut into spanwise strips. Each strip resolves its
    ///    local velocity into the plane normal to its quarter-chord line (simple
    ///    sweep theory), subtracts the induced velocity of the lifting line, and
    ///    applies the section forces of SectionAero at its centre of pressure.
    ///  - Circulation builds up with a lag of order chord / airspeed; the tail feels
    ///    the wing's circulation from one wake-transport time ago (that delay is the
    ///    physical Cm-alpha-dot), and sits in the wing's separated wake when it passes
    ///    through it (Silverstein-Katzoff).
    ///  - Strakes add vortex lift by the Polhamus suction analogy, lost as vortex
    ///    breakdown moves up the strake, earlier on the windward side in sideslip.
    ///  - Slender bodies take a potential normal force from their area growth and a
    ///    viscous crossflow force (Allen and Perkins), each section with its own w x r.
    ///  - Gear legs and speedbrakes are drag areas at their own positions.
    ///
    /// The slow states (separation, circulation, induced velocity, wake, vortex
    /// breakdown) advance once per step in Advance; within an integration step
    /// Evaluate holds them fixed.
    ///
    /// Internally everything is sim body axes relative to the CG (see Fm3Frames);
    /// Coefficients reports NASA-axis coefficients for validation.
    /// </summary>
    public sealed class Fm3Aero
    {
        /// <summary>
        /// Separation angle gained per radian of leading-edge droop: half the droop.
        /// Much less and the F-16's outer panels stall at its 25 degree AoA limit, where
        /// the reference tables still show full roll damping (Clp), and a rolling pull
        /// overshoots the limiter.
        /// </summary>
        private const double LefSepGain = 0.5;
        /// <summary>Zero-lift angle shift per radian of leading-edge droop.</summary>
        private const double LefAlpha0Gain = 0.1;
        private const double LefCdGain = 0.1;
        /// <summary>Flaps add camber; the separation angle (measured past zero lift) grows by this share of it.</summary>
        private const double FlapSepGain = 0.7;
        private const double FlapCdGain = 1.2;
        /// <summary>Low-pass on each strip's alpha-dot estimate (s).</summary>
        private const double AlphaRateTauS = 0.03;
        /// <summary>Wing circulation history kept for the tail's downwash delay.</summary>
        private const int GammaHistory = 96;
        /// <summary>
        /// Spanwise smoothing of circulation between neighbouring strips, scaled by how
        /// separated they are. A lifting line past stall has more than one solution:
        /// neighbouring strips can settle on opposite sides of the lift peak, each
        /// propping the other up with the vortex shed between them, and nothing in
        /// real separated flow keeps a jump that sharp. Attached flow is left alone.
        /// </summary>
        private const double SeparatedGammaSmoothing = 0.2;
        /// <summary>Wake-angle change (rad) below which the interpolated influences are reused.</summary>
        private const double InfluenceReuseRad = 0.25 * Math.PI / 180;

        private sealed class StripDef
        {
            public int Group;
            public int Role;
            /// <summary>+1 as defined (starboard for mirrored surfaces), -1 for the mirror copy.</summary>
            public int Side;
            public bool VortexFromStrakes;
            public double[] A, B, P, N, F, S, Te;
            /// <summary>Mirror-image nodes in a root endplate, when the surface has one.</summary>
            public double[] ImageA, ImageB;
            public double ChordN, Ds;
            public SectionParams Section;
            public double QFactor;
            public int AllMovingCh;
            public double AllMovingGain;
            public int FlapCh;
            public double FlapTau, FlapGain, FlapCf;
            public int LefCh;
            public double LefGain;
            /// <summary>NASA y of the control point, for pairing tail strips with the wing ahead.</summary>
            public double Lateral;
            /// <summary>NASA x of the control point.</summary>
            public double Longitudinal;
        }

        private sealed class StrakeDef
        {
            public double[] C;
            public double[] Aug;
            public double OutX;
            public double Area;
            public double Cr;
            public double Kp;
            public double Kv;
            public Fm3Strake St;
            public int Group;
        }

        private sealed class SegDef
        {
            public double[] R;
            public double Len, W, H, DA, Cdc, Pot;
            public int Group;
        }

        private sealed class BluffDef
        {
            public double[] R;
            public double CdA;
            public int Deploy;
            public int Group;
        }

        public readonly Fm3Airframe Airframe;
        /// <summary>Surface deflections by channel (rad), indexed by Fm3Channel.</summary>
        public readonly double[] Controls = new double[Fm3Channels.Count];

        /// <summary>Force-vector groups, in order.</summary>
        public readonly List<string> GroupNames = new List<string>();

        // ---- Strips (wing strips first) ----
        public readonly int StripCount;
        public readonly int WingStripCount;
        private readonly double[] px, py, pz;
        private readonly double[] nx, ny, nz;
        private readonly double[] fx, fy, fz;
        private readonly double[] sx, sy, sz;
        private readonly double[] tex, tey, tez;
        private readonly double[] chordN;
        private readonly double[] stripArea;
        private readonly double[] qFactor;
        private readonly SectionParams[] sections;
        private readonly int[] stripGroup;
        private readonly int[] allMovingCh;
        private readonly double[] allMovingGain;
        private readonly int[] flapCh;
        private readonly double[] flapTau;
        private readonly double[] flapGain;
        private readonly double[] flapCf;
        private readonly int[] lefCh;
        private readonly double[] lefGain;
        /// <summary>For tail strips: the wing strip whose wake it may sit in (-1 for wing strips).</summary>
        private readonly int[] wakeSource;
        private readonly InfluenceTable influence;
        private readonly double[] influenceNow;
        private double influenceAlpha = double.NaN;
        private double influenceBeta = double.NaN;
        /// <summary>Mean wing-to-tail distance along the body axis (m).</summary>
        private readonly double tailArm;
        private readonly int[] neighborI;
        private readonly int[] neighborJ;
        private readonly double[] gammaScratch;
        private readonly int[] stripSide;
        private readonly bool[] stripVortexFromStrakes;
        /// <summary>For each strip fed by a strake vortex, that strake's index (-1 otherwise).</summary>
        private readonly int[] stripStrake;

        // Strip states.
        public readonly double[] Separation;
        public readonly double[] Circulation;
        public readonly double[] InducedVelocity;
        public readonly double[] WakeQ;
        private readonly double[] alphaPrev;
        private readonly double[] alphaRate;
        private readonly bool[] hasPrev;
        private readonly double[] gammaHistory;
        private int historyHead;
        private int historyFilled;
        private readonly double[] gammaEffective;

        // Per-strip results of the last recorded evaluation.
        public readonly double[] LastAlpha;
        private readonly double[] lastSpeed;
        private readonly double[] lastMach;
        private readonly double[] lastCl;
        private readonly double[] lastCd;
        private readonly double[] lastDAlpha0;
        private readonly double[] lastDAlphaSep;

        // ---- Strakes ----
        private readonly int strakeCount;
        private readonly double[] stx, sty, stz;
        private readonly double[] stOutX;
        private readonly double[] stArea;
        private readonly double[] stRootChord;
        private readonly double[] stKp, stKv, stCd90;
        private readonly double[] stBurstTE, stBurstApex;
        private readonly double[] stSweepSens;
        private readonly double[] stTau1, stTau2;
        private readonly double[] stCd0;
        private readonly double[] stAugArea;
        private readonly double[] stAugX, stAugY, stAugZ;
        private readonly int[] stGroup;
        public readonly double[] StrakeBurst;
        private readonly double[] stAlpha;
        private readonly double[] stAlphaPrev;
        private readonly double[] stRate;
        private readonly double[] stBeta;
        private readonly double[] stSpeed;

        // ---- Body segments ----
        private readonly int segCount;
        private readonly double[] bx, by, bz;
        private readonly double[] segLength;
        private readonly double[] segWidth, segHeight;
        private readonly double[] segDArea;
        private readonly double[] segCdc;
        private readonly double[] segPotential;
        private readonly int[] segGroup;

        // ---- Bluff bodies ----
        private readonly int bluffCount;
        private readonly double[] blx, bly, blz;
        private readonly double[] blCdA;
        private readonly int[] blDeploy;
        private readonly int[] blGroup;
        private readonly double speedbrakeMax;

        // ---- Scratch ----
        private readonly SectionModifiers mods = new SectionModifiers();
        private readonly SectionForces sf = new SectionForces();
        private readonly double[] scratchF = new double[3];
        private readonly double[] scratchM = new double[3];

        // ---- Force-vector recording ----
        private readonly double[] groupF;
        private readonly double[] groupM;
        private readonly double[] groupP;
        private readonly double[] groupW;
        private readonly List<ForceVectorKind> groupKind = new List<ForceVectorKind>();

        private static double[] Map<T>(List<T> items, Func<T, double> get)
        {
            var o = new double[items.Count];
            for (int i = 0; i < o.Length; i++) o[i] = get(items[i]);
            return o;
        }

        private static int[] MapInt<T>(List<T> items, Func<T, int> get)
        {
            var o = new int[items.Count];
            for (int i = 0; i < o.Length; i++) o[i] = get(items[i]);
            return o;
        }

        private int AddGroup(string name, ForceVectorKind kind = ForceVectorKind.Lift)
        {
            GroupNames.Add(name);
            groupKind.Add(kind);
            return GroupNames.Count - 1;
        }

        public Fm3Aero(Fm3Airframe airframe)
        {
            Airframe = airframe;
            double[] cg = airframe.Mass.Cg;
            Func<double[], double[]> toSim = p => Fm3Frames.NasaToSim(V.Sub(p, cg));

            // --- Strips ---
            var strips = new List<StripDef>();
            var ordered = new List<Fm3LiftingSurface>();
            foreach (Fm3LiftingSurface s in airframe.Surfaces) if (s.Role == Fm3SurfaceRole.Wing) ordered.Add(s);
            foreach (Fm3LiftingSurface s in airframe.Surfaces) if (s.Role == Fm3SurfaceRole.Tail) ordered.Add(s);
            foreach (Fm3LiftingSurface surface in ordered)
            {
                BuildStrips(surface, AddGroup(surface.Name), toSim, strips);
            }
            int n = strips.Count;
            StripCount = n;
            int wingCount = 0;
            foreach (StripDef s in strips) if (s.Role == 0) wingCount++;
            WingStripCount = wingCount;
            px = Map(strips, s => s.P[0]); py = Map(strips, s => s.P[1]); pz = Map(strips, s => s.P[2]);
            nx = Map(strips, s => s.N[0]); ny = Map(strips, s => s.N[1]); nz = Map(strips, s => s.N[2]);
            fx = Map(strips, s => s.F[0]); fy = Map(strips, s => s.F[1]); fz = Map(strips, s => s.F[2]);
            sx = Map(strips, s => s.S[0]); sy = Map(strips, s => s.S[1]); sz = Map(strips, s => s.S[2]);
            tex = Map(strips, s => s.Te[0]); tey = Map(strips, s => s.Te[1]); tez = Map(strips, s => s.Te[2]);
            chordN = Map(strips, s => s.ChordN);
            stripArea = Map(strips, s => s.ChordN * s.Ds);
            qFactor = Map(strips, s => s.QFactor);
            sections = new SectionParams[n];
            for (int i = 0; i < n; i++) sections[i] = strips[i].Section;
            stripGroup = MapInt(strips, s => s.Group);
            allMovingCh = MapInt(strips, s => s.AllMovingCh);
            allMovingGain = Map(strips, s => s.AllMovingGain);
            flapCh = MapInt(strips, s => s.FlapCh);
            flapTau = Map(strips, s => s.FlapTau);
            flapGain = Map(strips, s => s.FlapGain);
            flapCf = Map(strips, s => s.FlapCf);
            lefCh = MapInt(strips, s => s.LefCh);
            lefGain = Map(strips, s => s.LefGain);

            // Tail strips look for the wing strip at the nearest lateral station on
            // their own side (a centreline fin takes the starboard root).
            int nWing = WingStripCount;
            wakeSource = new int[n];
            for (int i = 0; i < n; i++) wakeSource[i] = -1;
            double wingX = 0, tailX = 0;
            for (int i = 0; i < nWing; i++) wingX += strips[i].Longitudinal;
            for (int i = nWing; i < n; i++)
            {
                tailX += strips[i].Longitudinal;
                int best = -1;
                double bestD = double.PositiveInfinity;
                for (int j = 0; j < nWing; j++)
                {
                    if (strips[i].Lateral * strips[j].Lateral < -1e-6) continue;
                    double d = Math.Abs(Math.Abs(strips[i].Lateral) - Math.Abs(strips[j].Lateral));
                    if (d < bestD) { bestD = d; best = j; }
                }
                wakeSource[i] = best;
            }
            tailArm = nWing > 0 && n > nWing ? Math.Max(0.5, wingX / nWing - tailX / (n - nWing)) : 0;

            var set = new HorseshoeSet
            {
                Count = n,
                Ax = Map(strips, s => s.A[0]), Ay = Map(strips, s => s.A[1]), Az = Map(strips, s => s.A[2]),
                Bx = Map(strips, s => s.B[0]), By = Map(strips, s => s.B[1]), Bz = Map(strips, s => s.B[2]),
                Px = px, Py = py, Pz = pz,
                Nx = nx, Ny = ny, Nz = nz,
                // A small core, only to keep a control point next to a node finite;
                // anything chord-sized would under-predict the induced flow.
                Core = Map(strips, s => 0.1 * Math.Min(s.ChordN, 2 * s.Ds)),
                HasImage = new byte[n],
                Iax = Map(strips, s => s.ImageA != null ? s.ImageA[0] : 0),
                Iay = Map(strips, s => s.ImageA != null ? s.ImageA[1] : 0),
                Iaz = Map(strips, s => s.ImageA != null ? s.ImageA[2] : 0),
                Ibx = Map(strips, s => s.ImageB != null ? s.ImageB[0] : 0),
                Iby = Map(strips, s => s.ImageB != null ? s.ImageB[1] : 0),
                Ibz = Map(strips, s => s.ImageB != null ? s.ImageB[2] : 0),
            };
            for (int i = 0; i < n; i++) set.HasImage[i] = strips[i].ImageA != null ? (byte)1 : (byte)0;
            influence = new InfluenceTable(set, InfluenceTable.WakeAlphas, InfluenceTable.WakeBetas);
            influenceNow = new double[n * n];

            // Neighbouring strips share a node of the lifting line.
            var pairI = new List<int>();
            var pairJ = new List<int>();
            for (int i = 0; i < n; i++)
            {
                for (int j = i + 1; j < n; j++)
                {
                    StripDef si = strips[i], sj = strips[j];
                    if (Same(si.A, sj.A) || Same(si.A, sj.B) || Same(si.B, sj.A) || Same(si.B, sj.B))
                    {
                        pairI.Add(i);
                        pairJ.Add(j);
                    }
                }
            }
            neighborI = pairI.ToArray();
            neighborJ = pairJ.ToArray();
            gammaScratch = new double[n];
            stripSide = MapInt(strips, s => s.Side);
            stripVortexFromStrakes = new bool[n];
            for (int i = 0; i < n; i++) stripVortexFromStrakes[i] = strips[i].VortexFromStrakes;

            Separation = new double[n];
            Circulation = new double[n];
            InducedVelocity = new double[n];
            WakeQ = new double[n];
            alphaPrev = new double[n];
            alphaRate = new double[n];
            hasPrev = new bool[n];
            gammaHistory = new double[GammaHistory * Math.Max(1, nWing)];
            gammaEffective = new double[n];
            LastAlpha = new double[n];
            lastSpeed = new double[n];
            lastMach = new double[n];
            lastCl = new double[n];
            lastCd = new double[n];
            lastDAlpha0 = new double[n];
            lastDAlphaSep = new double[n];

            // --- Strakes ---
            var strakes = new List<StrakeDef>();
            foreach (Fm3Strake st in airframe.Strakes)
            {
                int group = AddGroup(st.Name);
                int[] sides = st.Mirror ? new[] { 1, -1 } : new[] { 1 };
                foreach (int side in sides)
                {
                    double[] centroidN = { st.Apex[0] - (2.0 / 3) * st.RootChord, side * (Math.Abs(st.Apex[1]) + st.Span / 3), st.Apex[2] };
                    double[] augmentedN = { st.AugmentedX ?? st.Apex[0] - st.RootChord, side * (Math.Abs(st.Apex[1]) + st.Span), st.Apex[2] };
                    double aspect = 4 * st.Span / st.RootChord;
                    strakes.Add(new StrakeDef
                    {
                        C = toSim(centroidN),
                        Aug = toSim(augmentedN),
                        OutX = Fm3Frames.NasaToSim(new double[] { 0, side, 0 })[0],
                        Area = 0.5 * st.RootChord * st.Span,
                        Cr = st.RootChord,
                        Kp = st.KPotential ?? Math.PI * aspect / 2,
                        Kv = st.KVortex ?? Math.PI,
                        St = st,
                        Group = group,
                    });
                }
            }
            int sk = strakes.Count;
            strakeCount = sk;
            stx = Map(strakes, s => s.C[0]); sty = Map(strakes, s => s.C[1]); stz = Map(strakes, s => s.C[2]);
            stOutX = Map(strakes, s => s.OutX);
            stArea = Map(strakes, s => s.Area);
            stRootChord = Map(strakes, s => s.Cr);
            stKp = Map(strakes, s => s.Kp); stKv = Map(strakes, s => s.Kv); stCd90 = Map(strakes, s => s.St.Cd90);
            stBurstTE = Map(strakes, s => s.St.BurstTrailingEdge);
            stBurstApex = Map(strakes, s => s.St.BurstApex);
            stSweepSens = Map(strakes, s => s.St.BurstSweepSensitivity);
            stTau1 = Map(strakes, s => s.St.BurstTau1);
            stTau2 = Map(strakes, s => s.St.BurstTau2);
            stCd0 = Map(strakes, s => s.St.Cd0);
            stAugArea = Map(strakes, s => s.St.AugmentedArea ?? 0);
            stAugX = Map(strakes, s => s.Aug[0]); stAugY = Map(strakes, s => s.Aug[1]); stAugZ = Map(strakes, s => s.Aug[2]);
            stGroup = MapInt(strakes, s => s.Group);
            StrakeBurst = new double[sk];
            for (int k = 0; k < sk; k++) StrakeBurst[k] = 1;
            var strakeSides = new double[sk];
            for (int k = 0; k < sk; k++) strakeSides[k] = JsMath.Sign(StOutXSign(strakes[k].OutX));
            stripStrake = new int[n];
            for (int i = 0; i < n; i++)
            {
                stripStrake[i] = -1;
                if (!stripVortexFromStrakes[i]) continue;
                stripStrake[i] = Array.FindIndex(strakeSides, side => side == stripSide[i]);
            }
            stAlpha = new double[sk];
            stAlphaPrev = new double[sk];
            stRate = new double[sk];
            stBeta = new double[sk];
            stSpeed = new double[sk];

            // --- Bodies ---
            var segs = new List<SegDef>();
            foreach (Fm3Body body in airframe.Bodies)
            {
                int group = AddGroup(body.Name);
                double[][] st = body.Stations;
                double length = st[0][0] - st[st.Length - 1][0];
                double maxD = double.NegativeInfinity;
                foreach (double[] s in st) maxD = Math.Max(maxD, Math.Sqrt(s[2] * s[3]));
                double eta = CrossflowEta(length / Math.Max(maxD, 1e-3));
                for (int k = 0; k + 1 < st.Length; k++)
                {
                    double x0 = st[k][0], z0 = st[k][1], w0 = st[k][2], h0 = st[k][3];
                    double x1 = st[k + 1][0], z1 = st[k + 1][1], w1 = st[k + 1][2], h1 = st[k + 1][3];
                    segs.Add(new SegDef
                    {
                        R = toSim(new[] { (x0 + x1) / 2, 0, (z0 + z1) / 2 }),
                        Len = x0 - x1,
                        W = (w0 + w1) / 2,
                        H = (h0 + h1) / 2,
                        DA = Math.PI * (w1 * h1 - w0 * h0) / 4,
                        Cdc = body.CrossflowCd * eta,
                        Pot = body.PotentialFactor ?? 1,
                        Group = group,
                    });
                }
            }
            segCount = segs.Count;
            bx = Map(segs, s => s.R[0]); by = Map(segs, s => s.R[1]); bz = Map(segs, s => s.R[2]);
            segLength = Map(segs, s => s.Len);
            segWidth = Map(segs, s => s.W); segHeight = Map(segs, s => s.H);
            segDArea = Map(segs, s => s.DA);
            segCdc = Map(segs, s => s.Cdc);
            segPotential = Map(segs, s => s.Pot);
            segGroup = MapInt(segs, s => s.Group);

            // --- Bluff bodies ---
            var bluffGroups = new Dictionary<string, int>();
            var bluff = new List<BluffDef>();
            foreach (Fm3BluffBody b in airframe.BluffBodies)
            {
                string key = b.Deploy == Fm3BluffDeploy.Always ? "drag" : b.Deploy == Fm3BluffDeploy.Gear ? "gear" : "speedbrake";
                if (!bluffGroups.ContainsKey(key)) bluffGroups[key] = AddGroup(key, ForceVectorKind.Drag);
                bluff.Add(new BluffDef
                {
                    R = toSim(b.Position),
                    CdA = b.CdA,
                    Deploy = b.Deploy == Fm3BluffDeploy.Gear ? 1 : b.Deploy == Fm3BluffDeploy.Speedbrake ? 2 : 0,
                    Group = bluffGroups[key],
                });
            }
            bluffCount = bluff.Count;
            blx = Map(bluff, b => b.R[0]);
            bly = Map(bluff, b => b.R[1]);
            blz = Map(bluff, b => b.R[2]);
            blCdA = Map(bluff, b => b.CdA);
            blDeploy = MapInt(bluff, b => b.Deploy);
            blGroup = MapInt(bluff, b => b.Group);
            Fm3Actuator sbActuator = Array.Find(airframe.Actuators, a => a.Channel == Fm3Channel.Speedbrake);
            speedbrakeMax = sbActuator != null && sbActuator.Max > 0 ? sbActuator.Max : 1;

            int groups = GroupNames.Count;
            groupF = new double[groups * 3];
            groupM = new double[groups * 3];
            groupP = new double[groups * 3];
            groupW = new double[groups];

            Reset();
        }

        private static bool Same(double[] p, double[] q) =>
            Math.Abs(p[0] - q[0]) + Math.Abs(p[1] - q[1]) + Math.Abs(p[2] - q[2]) < 1e-6;

        /// <summary>Side (+1 starboard, -1 port) of a strake from its outboard sim-X direction (starboard is -X).</summary>
        private static double StOutXSign(double outX) => outX < 0 ? 1 : -1;

        /// <summary>Attached flow, no circulation: the state of an aircraft that has not flown yet.</summary>
        public void Reset()
        {
            Fill(Separation, 1);
            Fill(Circulation, 0);
            Fill(InducedVelocity, 0);
            Fill(WakeQ, 1);
            Fill(alphaPrev, 0);
            Fill(alphaRate, 0);
            Array.Clear(hasPrev, 0, hasPrev.Length);
            Fill(gammaHistory, 0);
            historyHead = 0;
            historyFilled = 0;
            Fill(gammaEffective, 0);
            Fill(StrakeBurst, 1);
            Fill(stAlphaPrev, 0);
            Fill(stRate, 0);
        }

        private static void Fill(double[] a, double v)
        {
            for (int i = 0; i < a.Length; i++) a[i] = v;
        }

        /// <summary>
        /// Aerodynamic force and moment about the CG, sim body axes, for the CG
        /// moving at (vx, vy, vz) through the air with body rates (wx, wy, wz). Slow
        /// states are read, never written, unless record is set; then per-strip
        /// results are kept for Advance and the force-vector overlay.
        /// </summary>
        public void Evaluate(
            double vx, double vy, double vz, double wx, double wy, double wz,
            AeroEnvironment env, double[] force, double[] moment, bool record)
        {
            double Fx = 0, Fy = 0, Fz = 0, Mx = 0, My = 0, Mz = 0;
            double rho = env.Rho;
            double a = env.SoundSpeed > 1 ? env.SoundSpeed : 340;
            double[] ctl = Controls;
            if (record)
            {
                Fill(groupF, 0);
                Fill(groupM, 0);
                Fill(groupP, 0);
                Fill(groupW, 0);
            }

            // ---- Lifting strips ----
            for (int i = 0; i < StripCount; i++)
            {
                double rx = px[i], ry = py[i], rz = pz[i];
                double nxi = nx[i], nyi = ny[i], nzi = nz[i];
                double w = InducedVelocity[i];
                double ux = vx + (wy * rz - wz * ry) - w * nxi;
                double uy = vy + (wz * rx - wx * rz) - w * nyi;
                double uz = vz + (wx * ry - wy * rx) - w * nzi;
                double sxi = sx[i], syi = sy[i], szi = sz[i];
                double us = ux * sxi + uy * syi + uz * szi;
                double unx = ux - us * sxi, uny = uy - us * syi, unz = uz - us * szi;
                double un2 = unx * unx + uny * uny + unz * unz;
                if (un2 < 1e-4)
                {
                    if (record) { lastSpeed[i] = 0; lastCl[i] = 0; lastCd[i] = 0; }
                    continue;
                }
                double un = Math.Sqrt(un2);
                double cfx = fx[i], cfy = fy[i], cfz = fz[i];
                double alpha = JsTrig.Atan2(-(unx * nxi + uny * nyi + unz * nzi), unx * cfx + uny * cfy + unz * cfz);

                double cnx = nxi, cny = nyi, cnz = nzi, ccx = cfx, ccy = cfy, ccz = cfz;
                int amc = allMovingCh[i];
                if (amc >= 0)
                {
                    double d = ctl[amc] * allMovingGain[i];
                    if (d != 0)
                    {
                        // Deflecting an all-moving surface rotates its chord nose-up by d.
                        alpha += d;
                        double cd = JsTrig.Cos(d), sd = JsTrig.Sin(d);
                        ccx = cfx * cd + nxi * sd; ccy = cfy * cd + nyi * sd; ccz = cfz * cd + nzi * sd;
                        cnx = nxi * cd - cfx * sd; cny = nyi * cd - cfy * sd; cnz = nzi * cd - cfz * sd;
                        if (alpha > Math.PI) alpha -= 2 * Math.PI;
                        else if (alpha <= -Math.PI) alpha += 2 * Math.PI;
                    }
                }

                double dA0 = 0, dSep = 0, dCd = 0;
                int flc = flapCh[i];
                if (flc >= 0)
                {
                    double d = ctl[flc] * flapGain[i];
                    if (d != 0)
                    {
                        double shift = flapTau[i] * SectionAero.FlapDeflectionEfficiency(d) * d;
                        dA0 -= shift;
                        dSep += FlapSepGain * shift;
                        double s = JsTrig.Sin(d);
                        dCd += FlapCdGain * flapCf[i] * s * s;
                    }
                }
                int lc = lefCh[i];
                if (lc >= 0)
                {
                    double d = ctl[lc] * lefGain[i];
                    if (d != 0)
                    {
                        dSep += LefSepGain * d;
                        dA0 -= LefAlpha0Gain * d;
                        double s = JsTrig.Sin(d);
                        dCd += LefCdGain * s * s;
                    }
                }
                SectionParams section = sections[i];
                double mach = un / a;
                dCd += SectionWaveDrag(mach, section.Thickness);
                mods.DAlpha0 = dA0;
                mods.DAlphaSep = dSep;
                mods.DCd0 = dCd;
                int strake = stripStrake[i];
                mods.VortexScale = strake >= 0 ? StrakeBurst[strake] : 1;
                SectionAero.Forces(alpha, Separation[i], section, mods, mach, sf);

                double qa = 0.5 * rho * un2 * qFactor[i] * WakeQ[i] * stripArea[i];
                double drag = sf.CdProfile / un;
                double fxs = qa * (sf.Cn * cnx + sf.Cc * ccx - drag * unx);
                double fys = qa * (sf.Cn * cny + sf.Cc * ccy - drag * uny);
                double fzs = qa * (sf.Cn * cnz + sf.Cc * ccz - drag * unz);
                // Centre of pressure along the (deflected) chord.
                double off = (0.25 - sf.Xcp) * chordN[i];
                double ax = rx + off * ccx, ay = ry + off * ccy, az = rz + off * ccz;
                Fx += fxs; Fy += fys; Fz += fzs;
                Mx += ay * fzs - az * fys;
                My += az * fxs - ax * fzs;
                Mz += ax * fys - ay * fxs;
                if (sf.Cm != 0)
                {
                    // Couple about the span axis, nose-up positive: axis = chord x normal.
                    double c = qa * chordN[i] * sf.Cm;
                    Mx += c * (ccy * cnz - ccz * cny);
                    My += c * (ccz * cnx - ccx * cnz);
                    Mz += c * (ccx * cny - ccy * cnx);
                }

                if (record)
                {
                    LastAlpha[i] = alpha;
                    lastSpeed[i] = un;
                    lastMach[i] = mach;
                    lastDAlpha0[i] = dA0;
                    lastDAlphaSep[i] = dSep;
                    double ca = JsTrig.Cos(alpha), sa = JsTrig.Sin(alpha);
                    lastCl[i] = sf.Cn * ca + sf.Cc * sa;
                    lastCd[i] = sf.Cn * sa - sf.Cc * ca + sf.CdProfile;
                    RecordGroup(stripGroup[i], fxs, fys, fzs, ax, ay, az);
                }
            }

            // ---- Strakes: Polhamus suction analogy ----
            for (int k = 0; k < strakeCount; k++)
            {
                double rx = stx[k], ry = sty[k], rz = stz[k];
                double ux = vx + (wy * rz - wz * ry);
                double uy = vy + (wz * rx - wx * rz);
                double uz = vz + (wx * ry - wy * rx);
                double v2s = ux * ux + uy * uy + uz * uz;
                if (v2s < 1e-4) continue;
                double v = Math.Sqrt(v2s);
                // Strake plane: normal +Y (up), chord +Z (forward), outboard +-X.
                double alpha = JsTrig.Atan2(-uy, uz);
                double sa = JsTrig.Sin(alpha), ca = JsTrig.Cos(alpha);
                double absSa = sa < 0 ? -sa : sa;
                double cn;
                if (ca >= 0)
                {
                    double b = StrakeBurst[k];
                    cn = stKp[k] * sa * ca + (b * stKv[k] + (1 - b) * stCd90[k]) * sa * absSa;
                }
                else
                {
                    cn = stCd90[k] * sa * absSa;
                }
                double q = 0.5 * rho * v2s;
                double qa = q * stArea[k];
                double drag = stCd0[k] / v;
                double fxs = qa * (-drag * ux);
                double fys = qa * (cn - drag * uy);
                double fzs = qa * (-drag * uz);
                Fx += fxs; Fy += fys; Fz += fzs;
                Mx += ry * fzs - rz * fys;
                My += rz * fxs - rx * fzs;
                Mz += rx * fys - ry * fxs;
                // Augmented vortex lift on the wing under the vortex, while it lasts.
                double augF = 0;
                if (ca >= 0 && stAugArea[k] > 0)
                {
                    augF = q * stAugArea[k] * stKv[k] * sa * absSa * StrakeBurst[k];
                    double ax = stAugX[k], az = stAugZ[k];
                    Fy += augF;
                    Mx += -az * augF;
                    Mz += ax * augF;
                }
                if (record)
                {
                    stAlpha[k] = alpha;
                    stSpeed[k] = v;
                    double sb = (ux * stOutX[k]) / v;
                    stBeta[k] = JsTrig.Asin(sb > 1 ? 1 : sb < -1 ? -1 : sb);
                    RecordGroup(stGroup[k], fxs, fys, fzs, rx, ry, rz);
                    if (augF != 0) RecordGroup(stGroup[k], 0, augF, 0, stAugX[k], stAugY[k], stAugZ[k]);
                }
            }

            // ---- Slender bodies ----
            for (int k = 0; k < segCount; k++)
            {
                double rx = bx[k], ry = by[k], rz = bz[k];
                double ux = vx + (wy * rz - wz * ry);
                double uy = vy + (wz * rx - wx * rz);
                double ua = vz + (wx * ry - wy * rx);
                double uc2 = ux * ux + uy * uy;
                if (uc2 < 1e-6) continue;
                double uc = Math.Sqrt(uc2);
                double ex = ux / uc, ey = uy / uc;
                // Potential flow: rho u_axial u_cross dS (slender-body theory), with
                // Jorgensen's cos(alpha/2) for high incidence; alpha here runs 0..pi.
                double alphaB = JsTrig.Atan2(uc, ua);
                double nPot = rho * ua * uc * segDArea[k] * segPotential[k] * JsTrig.Cos(0.5 * alphaB);
                // Viscous crossflow on the projected width of the elliptical section.
                double halfW = 0.5 * segWidth[k], halfH = 0.5 * segHeight[k];
                double proj = 2 * Math.Sqrt(halfW * halfW * ey * ey + halfH * halfH * ex * ex);
                double nVisc = 0.5 * rho * uc2 * proj * segCdc[k] * segLength[k];
                double nTotal = nPot + nVisc;
                double fxs = -ex * nTotal, fys = -ey * nTotal;
                Fx += fxs; Fy += fys;
                Mx += -rz * fys;
                My += rz * fxs;
                Mz += rx * fys - ry * fxs;
                if (record) RecordGroup(segGroup[k], fxs, fys, 0, rx, ry, rz);
            }

            // ---- Bluff bodies (gear legs, speedbrakes) ----
            for (int k = 0; k < bluffCount; k++)
            {
                int mode = blDeploy[k];
                double deploy = mode == 1 ? env.GearDown
                    : mode == 2 ? ctl[(int)Fm3Channel.Speedbrake] / speedbrakeMax
                        : 1;
                if (deploy <= 0) continue;
                double rx = blx[k], ry = bly[k], rz = blz[k];
                double ux = vx + (wy * rz - wz * ry);
                double uy = vy + (wz * rx - wx * rz);
                double uz = vz + (wx * ry - wy * rx);
                double v = Math.Sqrt(ux * ux + uy * uy + uz * uz);
                double k2 = -0.5 * rho * v * blCdA[k] * deploy;
                double fxs = k2 * ux, fys = k2 * uy, fzs = k2 * uz;
                Fx += fxs; Fy += fys; Fz += fzs;
                Mx += ry * fzs - rz * fys;
                My += rz * fxs - rx * fzs;
                Mz += rx * fys - ry * fxs;
                if (record) RecordGroup(blGroup[k], fxs, fys, fzs, rx, ry, rz);
            }

            // ---- Lumped parasite and wave drag, through the CG ----
            double v2 = vx * vx + vy * vy + vz * vz;
            if (v2 > 1e-4)
            {
                double v = Math.Sqrt(v2);
                double cd = Airframe.MiscCd0 + InterpolateTable(Airframe.BodyWaveDrag, v / a);
                double k2 = -0.5 * rho * v * cd * Airframe.Reference.AreaM2;
                Fx += k2 * vx; Fy += k2 * vy; Fz += k2 * vz;
            }

            force[0] = Fx; force[1] = Fy; force[2] = Fz;
            moment[0] = Mx; moment[1] = My; moment[2] = Mz;
        }

        private void RecordGroup(int g, double gfx, double gfy, double gfz, double x, double y, double z)
        {
            int o = g * 3;
            groupF[o] += gfx; groupF[o + 1] += gfy; groupF[o + 2] += gfz;
            groupM[o] += y * gfz - z * gfy;
            groupM[o + 1] += z * gfx - x * gfz;
            groupM[o + 2] += x * gfy - y * gfx;
            double w = Math.Sqrt(gfx * gfx + gfy * gfy + gfz * gfz);
            groupP[o] += w * x; groupP[o + 1] += w * y; groupP[o + 2] += w * z;
            groupW[g] += w;
        }

        /// <summary>
        /// Advance the slow aerodynamic states by dt from the current flight
        /// condition: separation (Goman-Khrabrov), circulation, induced velocity
        /// with the tail's downwash delay, wake blanketing and vortex breakdown.
        /// </summary>
        public void Advance(
            double dt, double vx, double vy, double vz, double wx, double wy, double wz,
            AeroEnvironment env)
        {
            Evaluate(vx, vy, vz, wx, wy, wz, env, scratchF, scratchM, true);
            double rateBlend = 1 - Math.Exp(-dt / AlphaRateTauS);
            int n = StripCount;
            InterpolateInfluence(vx, vy, vz);

            for (int i = 0; i < n; i++)
            {
                double speed = lastSpeed[i];
                if (speed <= 0) continue;
                double alpha = LastAlpha[i];
                double d = alpha - alphaPrev[i];
                if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
                double raw = hasPrev[i] ? d / dt : 0;
                alphaPrev[i] = alpha;
                hasPrev[i] = true;
                alphaRate[i] += (raw - alphaRate[i]) * rateBlend;

                SectionParams section = sections[i];
                double a0 = section.Alpha0 + lastDAlpha0[i];
                double rate = alphaRate[i];
                double regimeRate = SectionAero.IsForwardFlow(alpha)
                    ? (alpha >= a0 ? rate : -rate)
                    : (alpha >= 0 ? -rate : rate);
                mods.DAlpha0 = lastDAlpha0[i];
                mods.DAlphaSep = lastDAlphaSep[i];
                mods.DCd0 = 0;
                double chord = chordN[i];
                double target = SectionAero.SeparationTarget(alpha, regimeRate, speed, chord, section, mods, lastMach[i]);
                Separation[i] = SectionAero.AdvanceSeparation(Separation[i], target, dt, speed, chord, section.Tau1);

                RelaxCirculation(i, speed, 1 - Math.Exp(-dt * Math.Max(speed, 5) / (Airframe.WakeTau * chord)));
            }
            SmoothSeparatedCirculation();

            PushHistory();
            UpdateInducedVelocity(vx, vy, vz, env, true);
            UpdateWake(vx, vy, vz);
            AdvanceStrakes(dt, false);
        }

        /// <summary>
        /// Put the slow states at the steady solution for the current condition
        /// (separation on its static curve, circulation converged, no delay) as a
        /// wind tunnel would see it, or for an airborne spawn.
        /// </summary>
        public void Settle(
            double vx, double vy, double vz, double wx, double wy, double wz,
            AeroEnvironment env, int iterations = 80)
        {
            for (int it = 0; it < iterations; it++)
            {
                Evaluate(vx, vy, vz, wx, wy, wz, env, scratchF, scratchM, true);
                InterpolateInfluence(vx, vy, vz);
                for (int i = 0; i < StripCount; i++)
                {
                    double speed = lastSpeed[i];
                    if (speed <= 0) continue;
                    mods.DAlpha0 = lastDAlpha0[i];
                    mods.DAlphaSep = lastDAlphaSep[i];
                    mods.DCd0 = 0;
                    double target = SectionAero.SeparationTarget(LastAlpha[i], 0, speed, chordN[i], sections[i], mods, lastMach[i]);
                    Separation[i] = target;
                    RelaxCirculation(i, speed, 0.5);
                }
                SmoothSeparatedCirculation();
                UpdateInducedVelocity(vx, vy, vz, env, false);
                UpdateWake(vx, vy, vz);
                AdvanceStrakes(0, true);
            }
            for (int i = 0; i < StripCount; i++)
            {
                alphaPrev[i] = LastAlpha[i];
                alphaRate[i] = 0;
                hasPrev[i] = true;
            }
            int nWing = WingStripCount;
            for (int h = 0; h < GammaHistory; h++)
            {
                for (int j = 0; j < nWing; j++) gammaHistory[h * nWing + j] = Circulation[j];
            }
            historyFilled = GammaHistory;
            for (int k = 0; k < strakeCount; k++)
            {
                stAlphaPrev[k] = stAlpha[k];
                stRate[k] = 0;
            }
        }

        private void InterpolateInfluence(double vx, double vy, double vz)
        {
            double v = Math.Sqrt(vx * vx + vy * vy + vz * vz);
            double alpha = 0, beta = 0;
            if (v > 1)
            {
                alpha = JsTrig.Atan2(-vy, vz);
                double sb = -vx / v;
                beta = JsTrig.Asin(sb > 1 ? 1 : sb < -1 ? -1 : sb);
            }
            // The influences change slowly with the wake's direction; re-blending
            // the tables every step while it has hardly moved is most of the cost.
            if (Math.Abs(alpha - influenceAlpha) < InfluenceReuseRad && Math.Abs(beta - influenceBeta) < InfluenceReuseRad)
            {
                return;
            }
            influenceAlpha = alpha;
            influenceBeta = beta;
            influence.Interpolate(alpha, beta, influenceNow);
        }

        /// <summary>
        /// Relax one strip's circulation towards Kutta-Joukowski's 1/2 V c C_L. The
        /// strip's own trailing legs react against any change within the step, so
        /// the update treats that self-influence implicitly; without it, the narrow
        /// tip strips of a fast aircraft overshoot and ring.
        /// </summary>
        private void RelaxCirculation(int i, double speed, double lambda)
        {
            double target = 0.5 * speed * chordN[i] * lastCl[i] * qFactor[i] * WakeQ[i];
            double self = Math.Abs(influenceNow[i * StripCount + i]);
            double k = 0.5 * chordN[i] * sections[i].CnAlpha * self;
            Circulation[i] += lambda * (target - Circulation[i]) / (1 + lambda * k);
        }

        private void SmoothSeparatedCirculation()
        {
            double[] g = Circulation;
            double[] next = gammaScratch;
            Array.Copy(g, next, g.Length);
            for (int k = 0; k < neighborI.Length; k++)
            {
                int i = neighborI[k], j = neighborJ[k];
                double separated = 1 - Math.Min(Separation[i], Separation[j]);
                if (separated <= 0) continue;
                double d = SeparatedGammaSmoothing * separated * (g[j] - g[i]);
                next[i] += d;
                next[j] -= d;
            }
            Array.Copy(next, g, g.Length);
        }

        private void PushHistory()
        {
            int nWing = WingStripCount;
            if (nWing == 0) return;
            historyHead = (historyHead + 1) % GammaHistory;
            int o = historyHead * nWing;
            for (int j = 0; j < nWing; j++) gammaHistory[o + j] = Circulation[j];
            if (historyFilled < GammaHistory) historyFilled++;
        }

        private void UpdateInducedVelocity(double vx, double vy, double vz, AeroEnvironment env, bool delayed)
        {
            int n = StripCount;
            int nWing = WingStripCount;
            double[] gEff = gammaEffective;
            for (int j = 0; j < n; j++) gEff[j] = Circulation[j];

            // The tail sees the wing's circulation from one wake-transport time ago.
            double delaySteps = 0;
            if (delayed && nWing > 0 && n > nWing)
            {
                double v = Math.Sqrt(vx * vx + vy * vy + vz * vz);
                delaySteps = Math.Min(Math.Min(historyFilled - 1, GammaHistory - 1), tailArm / Math.Max(v, 1) * 120);
                if (delaySteps < 0) delaySteps = 0;
            }

            // Ground effect: the image vortex system cancels part of the induced flow (McCormick).
            double hb = 16 * env.HeightAboveGround / Airframe.Reference.SpanM;
            double sigma = !double.IsNaN(hb) && !double.IsInfinity(hb) ? (hb * hb) / (1 + hb * hb) : 1;

            double[] A = influenceNow;
            if (delaySteps > 0)
            {
                double lo = Math.Floor(delaySteps);
                double t = delaySteps - lo;
                int loI = (int)lo;
                int h0 = (historyHead - loI + GammaHistory) % GammaHistory;
                int h1 = (historyHead - loI - 1 + GammaHistory) % GammaHistory;
                for (int i = 0; i < n; i++)
                {
                    double wsum = 0;
                    int row = i * n;
                    if (i >= nWing)
                    {
                        for (int j = 0; j < nWing; j++)
                        {
                            double g = (1 - t) * gammaHistory[h0 * nWing + j] + t * gammaHistory[h1 * nWing + j];
                            wsum += A[row + j] * g;
                        }
                    }
                    else
                    {
                        for (int j = 0; j < nWing; j++) wsum += A[row + j] * gEff[j];
                    }
                    for (int j = nWing; j < n; j++) wsum += A[row + j] * gEff[j];
                    InducedVelocity[i] = sigma * wsum;
                }
            }
            else
            {
                for (int i = 0; i < n; i++)
                {
                    double wsum = 0;
                    int row = i * n;
                    for (int j = 0; j < n; j++) wsum += A[row + j] * gEff[j];
                    InducedVelocity[i] = sigma * wsum;
                }
            }
        }

        /// <summary>Silverstein-Katzoff wake of the wing strip ahead, over each tail strip (NACA TR-651).</summary>
        private void UpdateWake(double vx, double vy, double vz)
        {
            double v = Math.Sqrt(vx * vx + vy * vy + vz * vz);
            for (int i = 0; i < WingStripCount; i++) WakeQ[i] = 1;
            if (v < 1)
            {
                for (int i = WingStripCount; i < StripCount; i++) WakeQ[i] = 1;
                return;
            }
            double ffx = -vx / v, ffy = -vy / v, ffz = -vz / v;
            for (int i = WingStripCount; i < StripCount; i++)
            {
                int j = wakeSource[i];
                double q = 1;
                if (j >= 0)
                {
                    // The wake leaves along the freestream, pushed off it by the wing's
                    // far-field downwash (twice the downwash at the lifting line).
                    double dx = ffx, dy = ffy, dz = ffz;
                    double eps = Math.Min(0.35, 2 * Math.Max(0, -InducedVelocity[j]) / v);
                    if (eps > 0)
                    {
                        double nd = nx[j] * ffx + ny[j] * ffy + nz[j] * ffz;
                        double ppx = nx[j] - nd * ffx, ppy = ny[j] - nd * ffy, ppz = nz[j] - nd * ffz;
                        double pl = Math.Sqrt(ppx * ppx + ppy * ppy + ppz * ppz);
                        if (pl > 1e-6)
                        {
                            ppx /= pl; ppy /= pl; ppz /= pl;
                            dx = ffx - eps * ppx; dy = ffy - eps * ppy; dz = ffz - eps * ppz;
                            double dl = Math.Sqrt(dx * dx + dy * dy + dz * dz);
                            dx /= dl; dy /= dl; dz /= dl;
                        }
                    }
                    double rx = px[i] - tex[j], ry = py[i] - tey[j], rz = pz[i] - tez[j];
                    double along = rx * dx + ry * dy + rz * dz;
                    if (along > 0)
                    {
                        double qx = rx - along * dx, qy = ry - along * dy, qz = rz - along * dz;
                        double across = Math.Sqrt(qx * qx + qy * qy + qz * qz);
                        double c = chordN[j];
                        double cd = lastCd[j] > 0.005 ? lastCd[j] : 0.005;
                        double halfWidth = 0.68 * c * Math.Sqrt(cd * (along / c + 0.15));
                        if (across < halfWidth)
                        {
                            double centre = Math.Min(0.95, 2.42 * Math.Sqrt(cd) / (along / c + 0.3));
                            double shape = JsTrig.Cos(0.5 * Math.PI * across / halfWidth);
                            q = 1 - centre * shape * shape;
                        }
                    }
                }
                WakeQ[i] = q;
            }
        }

        /// <summary>Vortex breakdown on the strakes, lagged like separation.</summary>
        private void AdvanceStrakes(double dt, bool steady)
        {
            for (int k = 0; k < strakeCount; k++)
            {
                double speed = stSpeed[k];
                if (speed <= 0) continue;
                double alpha = stAlpha[k];
                double absAlpha = Math.Abs(alpha);
                double rate = 0;
                if (!steady && dt > 0)
                {
                    rate = (absAlpha - Math.Abs(stAlphaPrev[k])) / dt;
                    stRate[k] += (rate - stRate[k]) * (1 - Math.Exp(-dt / AlphaRateTauS));
                    rate = stRate[k];
                }
                stAlphaPrev[k] = alpha;
                double chordTime = stRootChord[k] / Math.Max(speed, 1);
                double lagged = steady ? absAlpha : absAlpha - stTau2[k] * chordTime * rate;
                // Windward (positive outboard sideslip) sees less sweep: breakdown comes earlier.
                double shift = -stSweepSens[k] * stBeta[k];
                double lo = stBurstTE[k] + shift;
                double hi = stBurstApex[k] + shift;
                double target;
                if (JsTrig.Cos(alpha) < 0 || lagged >= hi) target = 0;
                else if (lagged <= lo) target = 1;
                else
                {
                    double t = (lagged - lo) / (hi - lo);
                    target = 1 - t * t * (3 - 2 * t);
                }
                if (steady)
                {
                    StrakeBurst[k] = target;
                }
                else
                {
                    double tau = stTau1[k] * chordTime;
                    StrakeBurst[k] += (target - StrakeBurst[k]) * (1 - Math.Exp(-dt / tau));
                }
            }
        }

        /// <summary>
        /// Per-group force and moment about the CG from the last recorded
        /// evaluation, sim body axes (for diagnostics; the couple of cambered
        /// sections is not included).
        /// </summary>
        public List<StripLoad> GroupLoads()
        {
            var o = new List<StripLoad>();
            for (int g = 0; g < GroupNames.Count; g++)
            {
                o.Add(new StripLoad
                {
                    Name = GroupNames[g],
                    Force = new[] { groupF[g * 3], groupF[g * 3 + 1], groupF[g * 3 + 2] },
                    Moment = new[] { groupM[g * 3], groupM[g * 3 + 1], groupM[g * 3 + 2] },
                });
            }
            return o;
        }

        /// <summary>Per-strip state from the last recorded evaluation, for diagnostics.</summary>
        public List<StripDiagnostic> StripDiagnostics()
        {
            var o = new List<StripDiagnostic>();
            for (int i = 0; i < StripCount; i++)
            {
                double speed = lastSpeed[i];
                o.Add(new StripDiagnostic
                {
                    Group = GroupNames[stripGroup[i]],
                    Alpha = LastAlpha[i],
                    Separation = Separation[i],
                    InducedAngle = speed > 0 ? InducedVelocity[i] / speed : 0,
                    Cl = lastCl[i],
                    Cd = lastCd[i],
                    WakeQ = WakeQ[i],
                });
            }
            return o;
        }

        /// <summary>Area-weighted fraction of wing strips whose flow has separated (f &lt; 0.5).</summary>
        public double WingSeparatedFraction()
        {
            double sep = 0, total = 0;
            for (int i = 0; i < WingStripCount; i++)
            {
                total += stripArea[i];
                if (Separation[i] < 0.5) sep += stripArea[i];
            }
            return total > 0 ? sep / total : 0;
        }

        /// <summary>
        /// Body-frame force-vector samples from the last recorded evaluation: per
        /// group, the resultant at its force-weighted centre, split into lift and
        /// drag against the relative wind (sim to display origin is the CG).
        /// </summary>
        public List<ForceVectorSample> ForceVectorSnapshot(double vx, double vy, double vz)
        {
            var o = new List<ForceVectorSample>();
            double v = Math.Sqrt(vx * vx + vy * vy + vz * vz);
            double dx = v > 1e-3 ? -vx / v : 0, dy = v > 1e-3 ? -vy / v : 0, dz = v > 1e-3 ? -vz / v : 0;
            for (int g = 0; g < GroupNames.Count; g++)
            {
                double w = groupW[g];
                if (w <= 0) continue;
                int i = g * 3;
                double gfx = groupF[i], gfy = groupF[i + 1], gfz = groupF[i + 2];
                var origin = new Vec3d(groupP[i] / w, groupP[i + 1] / w, groupP[i + 2] / w);
                double d = gfx * dx + gfy * dy + gfz * dz;
                var drag = new Vec3d(d * dx, d * dy, d * dz);
                if (groupKind[g] == ForceVectorKind.Drag)
                {
                    o.Add(new ForceVectorSample { Part = GroupNames[g], Kind = ForceVectorKind.Drag, Origin = origin, Vec = new Vec3d(gfx, gfy, gfz) });
                    continue;
                }
                o.Add(new ForceVectorSample { Part = GroupNames[g], Kind = ForceVectorKind.Lift, Origin = origin, Vec = new Vec3d(gfx - drag.X, gfy - drag.Y, gfz - drag.Z) });
                o.Add(new ForceVectorSample { Part = GroupNames[g], Kind = ForceVectorKind.Drag, Origin = origin, Vec = drag });
            }
            return o;
        }

        private void SetControls(StaticCondition c)
        {
            Fill(Controls, 0);
            if (c.Controls == null) return;
            foreach (KeyValuePair<Fm3Channel, double> kv in c.Controls)
            {
                Controls[(int)kv.Key] = kv.Value;
            }
        }

        /// <summary>
        /// The wind tunnel: NASA body-axis coefficients about the reference point
        /// for a held attitude and rates, with the slow states settled.
        /// </summary>
        public NasaCoefficients Coefficients(StaticCondition c)
        {
            double speed = c.Speed ?? 100;
            double rho = c.Rho ?? 1.225;
            double beta = c.Beta ?? 0;
            SetControls(c);
            // NASA (u, v, w) to sim (-v, -w, u).
            double u = speed * JsTrig.Cos(c.Alpha) * JsTrig.Cos(beta);
            double vN = speed * JsTrig.Sin(beta);
            double w = speed * JsTrig.Sin(c.Alpha) * JsTrig.Cos(beta);
            double vx = -vN, vy = -w, vz = u;
            double p = c.P ?? 0, q = c.Q ?? 0, r = c.R ?? 0;
            double wx = -q, wy = -r, wz = p;
            var env = new AeroEnvironment
            {
                Rho = rho,
                SoundSpeed = c.SoundSpeed ?? 340.3,
                HeightAboveGround = c.HeightAboveGround ?? double.PositiveInfinity,
                GearDown = c.GearDown ?? 0,
            };
            Reset();
            Settle(vx, vy, vz, wx, wy, wz, env);
            var f = new double[3];
            var m = new double[3];
            Evaluate(vx, vy, vz, wx, wy, wz, env, f, m, false);

            double[] F = Fm3Frames.SimToNasa(f);
            double[] Mcg = Fm3Frames.SimToNasa(m);
            double[] arm = V.Sub(Airframe.Mass.Cg, Airframe.Reference.MomentRef);
            double[] M = V.Add(Mcg, V.Cross(arm, F));
            Fm3Reference rf = Airframe.Reference;
            double qS = 0.5 * rho * speed * speed * rf.AreaM2;
            double CX = F[0] / qS, CY = F[1] / qS, CZ = F[2] / qS;
            double ca = JsTrig.Cos(c.Alpha), sa = JsTrig.Sin(c.Alpha), cb = JsTrig.Cos(beta), sb = JsTrig.Sin(beta);
            return new NasaCoefficients
            {
                CX = CX, CY = CY, CZ = CZ,
                Cl = M[0] / (qS * rf.SpanM),
                Cm = M[1] / (qS * rf.ChordM),
                Cn = M[2] / (qS * rf.SpanM),
                CL = CX * sa - CZ * ca,
                CD = -(CX * ca * cb + CY * sb + CZ * sa * cb),
            };
        }

        /// <summary>
        /// Pitch damping, Cmq + Cm-alpha-dot per unit of q c / 2V about the CG, by forced
        /// oscillation: the body pitches +-amplitude about c.Alpha at omega rad/s with the
        /// flight path held, and the moment in phase with alpha-dot is the damping. Unlike
        /// Coefficients it carries the lags of separation, circulation, downwash and
        /// vortex breakdown, which decide it past stall. One cycle settles; the next is
        /// measured.
        /// </summary>
        public double PitchDamping(StaticCondition c, double amplitude = Math.PI / 36, double omega = 0.8)
        {
            double speed = c.Speed ?? 100;
            double rho = c.Rho ?? 1.225;
            double beta = c.Beta ?? 0;
            SetControls(c);
            var env = new AeroEnvironment
            {
                Rho = rho,
                SoundSpeed = c.SoundSpeed ?? 340.3,
                HeightAboveGround = c.HeightAboveGround ?? double.PositiveInfinity,
                GearDown = c.GearDown ?? 0,
            };
            double wy = -(c.R ?? 0), wz = c.P ?? 0;
            var v = new double[3];
            // NASA (u, v, w) to sim (-v, -w, u).
            void VelocityAt(double alpha)
            {
                v[0] = -speed * JsTrig.Sin(beta);
                v[1] = -speed * JsTrig.Sin(alpha) * JsTrig.Cos(beta);
                v[2] = speed * JsTrig.Cos(alpha) * JsTrig.Cos(beta);
            }
            VelocityAt(c.Alpha);
            Reset();
            Settle(v[0], v[1], v[2], 0, wy, wz, env);

            var f = new double[3];
            var m = new double[3];
            const double dt = 1.0 / 120;
            int cycle = (int)Math.Max(1, JsMath.Round(2 * Math.PI / omega / dt));
            double inPhase = 0;
            for (int i = 0; i < 2 * cycle; i++)
            {
                double t = i * dt;
                VelocityAt(c.Alpha + amplitude * JsTrig.Sin(omega * t));
                // q = alpha-dot, and sim w about +X is -q.
                double wx = -amplitude * omega * JsTrig.Cos(omega * t);
                Advance(dt, v[0], v[1], v[2], wx, wy, wz, env);
                Evaluate(v[0], v[1], v[2], wx, wy, wz, env, f, m, true);
                // NASA pitching moment is -M about sim +X.
                if (i >= cycle) inPhase -= m[0] * JsTrig.Cos(omega * t);
            }
            Fm3Reference rf = Airframe.Reference;
            double qSc = 0.5 * rho * speed * speed * rf.AreaM2 * rf.ChordM;
            return 2 * inPhase / cycle / qSc / (rf.ChordM / (2 * speed) * amplitude * omega);
        }

        /// <summary>Jorgensen's crossflow factor eta against body fineness ratio.</summary>
        private static double CrossflowEta(double fineness)
        {
            double[][] table = { new[] { 2, 0.56 }, new[] { 4, 0.6 }, new[] { 8, 0.66 }, new[] { 12, 0.7 }, new[] { 20, 0.75 }, new[] { 40, 0.82 } };
            if (fineness <= table[0][0]) return table[0][1];
            for (int i = 1; i < table.Length; i++)
            {
                if (fineness <= table[i][0])
                {
                    double t = (fineness - table[i - 1][0]) / (table[i][0] - table[i - 1][0]);
                    return table[i - 1][1] + t * (table[i][1] - table[i - 1][1]);
                }
            }
            return table[table.Length - 1][1];
        }

        /// <summary>Transonic drag rise of a section (Korn's drag divergence, Lock's fourth-power rise).</summary>
        private static double SectionWaveDrag(double mach, double thickness)
        {
            double mcrit = 0.87 - thickness - 0.108;
            if (mach <= mcrit) return 0;
            const double peak = 1.05;
            double excess = (mach < peak ? mach : peak) - mcrit;
            double rise = 20 * excess * excess * excess * excess;
            if (mach <= peak) return rise;
            // Supersonic: decays towards thin-airfoil wave drag 4(t/c)^2/sqrt(M^2 - 1).
            double linear = 4 * thickness * thickness / Math.Sqrt(mach * mach - 1);
            double linearAtPeak = 4 * thickness * thickness / Math.Sqrt(peak * peak - 1);
            return rise * (linear / linearAtPeak);
        }

        private static double InterpolateTable(double[][] table, double x)
        {
            if (table.Length == 0) return 0;
            if (x <= table[0][0]) return table[0][1];
            for (int i = 1; i < table.Length; i++)
            {
                if (x <= table[i][0])
                {
                    double t = (x - table[i - 1][0]) / (table[i][0] - table[i - 1][0]);
                    return table[i - 1][1] + t * (table[i][1] - table[i - 1][1]);
                }
            }
            return table[table.Length - 1][1];
        }

        /// <summary>
        /// Cut one surface (and its mirror image) into strips. Nodes follow the
        /// quarter-chord line; each strip's normal comes from its twisted chord and
        /// span directions, and its bound vortex is oriented so positive circulation
        /// lifts along the normal.
        /// </summary>
        private static void BuildStrips(
            Fm3LiftingSurface surface, int group, Func<double[], double[]> toSim, List<StripDef> o)
        {
            int role = surface.Role == Fm3SurfaceRole.Wing ? 0 : 1;
            int[] sides = surface.Mirror ? new[] { 1, -1 } : new[] { 1 };
            int nStrips = Math.Max(1, surface.Strips);
            double rootTwist = surface.RootTwist ?? 0;
            double tipTwist = surface.TipTwist ?? 0;
            double[] downstream = { -1, 0, 0 };
            foreach (int side in sides)
            {
                for (int k = 0; k < nStrips; k++)
                {
                    // Closer together towards a free tip, where the loading falls away.
                    // A root, or a tip that joins another panel, is not a free edge:
                    // strips bunched there would only shed spurious vortices between them.
                    bool uniform = surface.Spacing == Fm3StripSpacing.Uniform;
                    double t0 = uniform ? (double)k / nStrips : JsTrig.Sin(0.5 * Math.PI * k / nStrips);
                    double t1 = uniform ? (double)(k + 1) / nStrips : JsTrig.Sin(0.5 * Math.PI * (k + 1) / nStrips);
                    double tm = 0.5 * (t0 + t1);
                    double ChordAt(double t) => surface.RootChord + t * (surface.TipChord - surface.RootChord);
                    double[] Quarter(double t) => V.Add(V.Lerp(surface.RootLE, surface.TipLE, t), new[] { -0.25 * ChordAt(t), 0, 0 });
                    double[] A = Quarter(t0);
                    double[] B = Quarter(t1);
                    double[] P = Quarter(tm);
                    double[] le = V.Lerp(surface.RootLE, surface.TipLE, tm);
                    double chord = ChordAt(tm);
                    double twist = rootTwist + tm * (tipTwist - rootTwist);
                    double[] s = V.Normalize(V.Sub(B, A));
                    double ds = V.Length(V.Sub(B, A));
                    double[] chordBack = V.RotateAbout(new double[] { -1, 0, 0 }, s, twist);
                    double[] nn = V.Normalize(V.Cross(chordBack, s));
                    double[] perp = V.Sub(chordBack, V.Scale(s, V.Dot(chordBack, s)));
                    double chordN = chord * V.Length(perp);
                    double[] f = V.Scale(V.Normalize(perp), -1);
                    double[] te = V.Add(le, V.Scale(chordBack, chord));
                    if (side < 0)
                    {
                        A = V.MirrorY(A); B = V.MirrorY(B); P = V.MirrorY(P); le = V.MirrorY(le); te = V.MirrorY(te);
                        s = V.MirrorY(s); chordBack = V.MirrorY(chordBack); nn = V.MirrorY(nn); f = V.MirrorY(f);
                    }
                    if (V.Dot(V.Cross(downstream, V.Sub(B, A)), nn) < 0)
                    {
                        double[] tmp = A; A = B; B = tmp;
                    }
                    // Root endplate: reflect the horseshoe in the root plane, reversed so
                    // its trailing leg at the root cancels the real one.
                    double[] imageA = null;
                    double[] imageB = null;
                    if (surface.RootEndplate)
                    {
                        double[] spanDir = V.Sub(surface.TipLE, surface.RootLE);
                        double[] m = V.Normalize(new[] { 0, spanDir[1], spanDir[2] });
                        double[] origin = surface.RootLE;
                        if (side < 0) { m = V.MirrorY(m); origin = V.MirrorY(origin); }
                        double[] Reflect(double[] p) => V.Sub(p, V.Scale(m, 2 * V.Dot(V.Sub(p, origin), m)));
                        imageA = toSim(Reflect(B));
                        imageB = toSim(Reflect(A));
                    }

                    var def = new StripDef
                    {
                        Group = group, Role = role, ImageA = imageA, ImageB = imageB, Side = side,
                        VortexFromStrakes = surface.VortexFromStrakes,
                        A = toSim(A), B = toSim(B), P = toSim(P), Te = toSim(te),
                        N = Fm3Frames.NasaToSim(nn), F = Fm3Frames.NasaToSim(f), S = Fm3Frames.NasaToSim(s),
                        ChordN = chordN, Ds = ds, Section = surface.Section, QFactor = surface.QFactor ?? 1,
                        AllMovingCh = -1, AllMovingGain = 0,
                        FlapCh = -1, FlapTau = 0, FlapGain = 0, FlapCf = 0,
                        LefCh = -1, LefGain = 0,
                        Lateral = P[1],
                        Longitudinal = P[0],
                    };
                    if (surface.Controls != null)
                    {
                        foreach (Fm3ControlSegment seg in surface.Controls)
                        {
                            if (tm < seg.SpanFrom || tm > seg.SpanTo) continue;
                            int ch = (int)(side > 0 ? seg.Channel : (seg.MirrorChannel ?? seg.Channel));
                            double gain = seg.Gain ?? 1;
                            if (seg.Kind == Fm3ControlKind.AllMoving)
                            {
                                def.AllMovingCh = ch; def.AllMovingGain = gain;
                            }
                            else if (seg.Kind == Fm3ControlKind.Flap)
                            {
                                def.FlapCh = ch; def.FlapGain = gain;
                                def.FlapCf = seg.ChordFraction ?? 0.25;
                                def.FlapTau = SectionAero.FlapEffectiveness(def.FlapCf);
                            }
                            else
                            {
                                def.LefCh = ch; def.LefGain = gain;
                            }
                        }
                    }
                    o.Add(def);
                }
            }
        }

        /// <summary>The small Vec3 helpers of aeroModel.ts, on double[3].</summary>
        private static class V
        {
            public static double[] Sub(double[] a, double[] b) => new[] { a[0] - b[0], a[1] - b[1], a[2] - b[2] };
            public static double[] Add(double[] a, double[] b) => new[] { a[0] + b[0], a[1] + b[1], a[2] + b[2] };
            public static double[] Scale(double[] a, double k) => new[] { a[0] * k, a[1] * k, a[2] * k };
            public static double Dot(double[] a, double[] b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
            public static double[] Cross(double[] a, double[] b) =>
                new[] { a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0] };
            public static double Length(double[] a) => Math.Sqrt(Dot(a, a));
            public static double[] Normalize(double[] a) => Scale(a, 1 / Length(a));
            public static double[] Lerp(double[] a, double[] b, double t) =>
                new[] { a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2]) };
            public static double[] MirrorY(double[] a) => new[] { a[0], -a[1], a[2] };

            /// <summary>Rodrigues rotation of v about unit axis k by angle theta.</summary>
            public static double[] RotateAbout(double[] v, double[] k, double theta)
            {
                double c = JsTrig.Cos(theta), s = JsTrig.Sin(theta);
                double[] kv = Cross(k, v);
                double kdv = Dot(k, v);
                return new[]
                {
                    v[0] * c + kv[0] * s + k[0] * kdv * (1 - c),
                    v[1] * c + kv[1] * s + k[1] * kdv * (1 - c),
                    v[2] * c + kv[2] * s + k[2] * kdv * (1 - c),
                };
            }
        }
    }
}

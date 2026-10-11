using System;
using System.Collections.Generic;
using System.Globalization;
using Retro.Core;
using Retro.Sim;

namespace Retro.Game
{
    /// <summary>
    /// What a damaged aircraft looks like to the smoke field (damageSmokeField.ts DamageSmokePose).
    /// </summary>
    public sealed class DamageSmokePose
    {
        public Vec3d Position;
        public Quatd Quaternion = Quatd.Identity;
        public Vec3d Velocity;
        /// <summary>False after the killing blow: the leak keeps emitting until reset.</summary>
        public bool IsAlive = true;
        /// <summary>True after ground impact: the emitter is pinned at the wreck.</summary>
        public bool IsCrashed;
    }

    /// <summary>What a contact touched (game.ts surfaceKindAt): brown dust, white spray, gray dust.</summary>
    public enum SmokeSurfaceKind
    {
        Dirt,
        Water,
        Concrete,
    }

    /// <summary>A fire's anchor (addAnchoredFire `where`): writes the emitter's world position; false once the anchor is gone.</summary>
    public delegate bool SmokeAnchor(out Vec3d world);

    /// <summary>onPoolMark: ground point, direction, length, width, and char (true) or the wider scorch (false).</summary>
    public delegate void PoolMarkHandler(Vec3d position, double dirX, double dirZ, double length, double width, bool charMark);

    /// <summary>onBurnMark: ground point, radius (m), final darkness 0..1, seconds to darken (start invisible).</summary>
    public delegate void BurnMarkHandler(Vec3d position, double radius, double strength, double growSeconds);

    /// <summary>
    /// Hit fire and smoke, crash fires and the lake of burning fuel, dust,
    /// splashes and foam: port of scene/entities/damageSmokeField.ts
    /// (DamageSmokeField), CPU half. One 4800-puff <see cref="CpuParticleSystem"/>
    /// feeds one instanced draw.
    ///
    /// Every Math.random draw goes through the injected <c>random</c> in the TS
    /// order, so a seeded source replays the oracle (tests/golden/damage_smoke.json).
    ///
    /// Per frame: the entry points (as events arrive), then <see cref="Update"/>,
    /// then <see cref="SyncPuffs"/> (the TS render3D) which compacts the live
    /// puffs, in slot order, into the instance arrays exactly as the TS fills its
    /// InstancedMesh: <see cref="InstanceMatrices"/>, <see cref="DitherLevels"/>,
    /// <see cref="ToneA"/>, <see cref="ToneB"/> (float32), the first
    /// <see cref="InstanceCount"/> entries being this frame's.
    /// </summary>
    public sealed class DamageSmokeField
    {
        // ------------------------------------------------------------ constants (TS names)

        /// <summary>defs.ts DAMAGE_SMOKE_PARTICLE_COUNT.</summary>
        public const int ParticleCount = 4800;

        public const double RiseMps = 20;
        public const double DriftMps = 0.9;
        public const double LeakEmitDurationSec = 14;
        public const double LeakEmitRate = 8;
        public const double SpeedRefMps = 80;
        public const double CrashEmitRate = 40;
        public const int MaxLeaks = 8;
        public const int MaxHitsPerFrame = 6;

        public const double FlameDither = 0.75;
        public const double SmokeDitherStart = 0.72;
        public const double SmokeDitherEnd = 0.02;
        public const double FirePhaseEnd = 0.12;
        public const double FireSizeGrowth = 0.1;
        private static readonly double[] FireRampHeat = { 0, 0.18, 0.4, 0.65, 0.85 };
        public const double FireToneBLead = 0.14;
        public const double BlackPuffChance = 0.09;
        public const double SmokeToneBLead = 0.2;
        public const double SmokePuffChance = 0.16;
        public const double SmokeGapMinS = 0.12;
        public const double SmokeGapVariationS = 0.22;
        public const double BurnOutFlameBelow = 0.08;
        public const double BurnMinRate = 0.12;
        public const double BurnRandomBreaksPerS = 1.4;
        public const double BurnGapGrowth = 5;
        public const double FireColourSeconds = 4.2;
        public const double TrickleRate = 1.8;
        public const double TrickleRateSmall = 0.8;
        public const double PoolOuterScorchAfterS = 2.5;
        public const int MaxFirePools = 6;
        public const int MaxPoolPoints = 96;
        public const double PoolPointStepM = 2.5;
        public const double PoolLifeS = 170;
        public const double PoolSpreadS = 3.5;
        public const double PoolFlameRate = 63;
        public const double PoolFlameRatePerStrength = 84;
        public const double PoolMaxAreaFactor = 4;
        public const double PoolMaxFlameRate = 364;
        public const int MaxFuelDrops = 160;
        public const double FuelGravity = 9.80665;
        public const double SpillDropsBase = 24;
        public const double SpillDropsPerStrength = 40;
        public const double SpillCarry = 0.1;
        public const double FuelTrailIntervalS = 0.09;
        public const double FuelMinFallM = 0.5;
        public const double FuelMergeM = 4;
        public const double FuelSplashRadiusM = 1.2;
        public const double FuelPuddleBaseM = 2.5;
        public const double FuelPuddlePerDropM = 0.5;
        public const double FuelCharStepM = 1.5;
        public const double FuelFeedReachM = 90;
        public const double PoolBurnMarkRate = 2.2;
        public const double FireBurnMarkRate = 0.7;
        public const double FireBurnMarkRateSmall = 0.3;
        public const double SpotBurnMarkRate = 0.12;
        public const double BurnMarkReachM = 4;
        public const double BurnMarkGrowMinS = 12;
        public const double BurnMarkGrowMaxS = 35;
        public const double PoolSmokeRate = 5;
        public const int MaxBurnSpots = 48;
        public const double SpotTrickleRate = 0.35;
        public const double BurnSpotRate = 6;
        public const int MaxAnchoredFires = 24;
        public const double EarlyBoostRate = 5;
        public const double EarlyBoostRateSmall = 2.4;
        public const double EarlyTauS = 16;
        public const double EarlyTauSmallS = 7;
        public const double EarlyBoostSpot = 2.4;
        public const double EarlyTauSpotS = 5;
        public const double EarlySizeStartBoost = 1.3;
        public const double EarlySizeEndBoost = 0.7;
        public const double EarlyRiseBoost = 0.55;
        public const double DustDitherStart = 0.8;

        /// <summary>Per-slot puff kinds (the TS dustFlags values).</summary>
        public const byte KindFire = 0, KindDust = 1, KindSmoke = 2, KindBlack = 3, KindSpray = 4, KindMist = 5, KindFoam = 6, KindConcrete = 7;

        // ------------------------------------------------------------ state types (public for inspection)

        public sealed class Leak
        {
            public bool Active;
            public string TargetId = "";
            public Vec3d LocalOffset;
            public double EmitRemaining;
            public double EmitAccum;
            public double Pause;
            /// <summary>Lethal damage or crash: never times out.</summary>
            public bool Permanent;
            /// <summary>Ground impact: emits from PinPos instead of following the hull.</summary>
            public bool Crashed;
            public Vec3d PinPos;
            public Vec3d LastEmitPos;
        }

        public sealed class AnchoredFire
        {
            public bool Active;
            public string TargetId = "";
            public SmokeAnchor Where = NoAnchor;
            public double Rate;
            /// <summary>Seconds left; +Infinity burns until reset.</summary>
            public double Remaining;
            public double Life;
            public bool Small;
            public double Accum;
            public double MarkAccum;
            public double DripRate;
            public double DripAccum;
            public Vec3d LastPos;
            public Vec3d Vel;
            public bool HasLast;
            public double Pause;
            public double Trickle;
            public double TrickleLife;
        }

        public sealed class BurnSpot
        {
            public double Trickle;
            public double TrickleLife;
            public bool Active;
            public Vec3d Position;
            public double Remaining;
            public double Life;
            public double Intensity;
            public double Accum;
            public double MarkAccum;
            public double Pause;
            public bool Moving;
        }

        public sealed class PoolPoint
        {
            public Vec3d Position;
            public double Born;
            public double DirX;
            public double DirZ;
            public double Segment;
            public bool Outer;
            public bool Moving;
            public double Volume;
            public double RadiusNow;
            public double CharRadius;
        }

        public sealed class FirePool
        {
            public bool Active;
            public double Radius = 1;
            public double Strength = 1;
            public double Age;
            public double Life = 1;
            public double FlameAccum;
            public double SmokeAccum;
            public double MarkAccum;
            public readonly List<PoolPoint> Trail = new List<PoolPoint>();
            public Vec3d Origin;
            public bool OriginMoving;
            public double DirX;
            public double DirZ = 1;
        }

        public sealed class FuelDrop
        {
            public bool Active;
            public Vec3d Position;
            public Vec3d Velocity;
            public double TrailTimer;
            public bool Streak = true;
            public double Flame = 1;
            public double Early = 1;
        }

        private static bool NoAnchor(out Vec3d world)
        {
            world = default;
            return false;
        }

        /// <summary>A three.js Color: linear RGB in doubles.</summary>
        private struct Rgb
        {
            public double R, G, B;

            public Rgb(double r, double g, double b)
            {
                R = r;
                G = g;
                B = b;
            }

            /// <summary>Color.lerp: this += (c - this) * alpha.</summary>
            public Rgb Lerp(Rgb c, double alpha) =>
                new Rgb(R + (c.R - R) * alpha, G + (c.G - G) * alpha, B + (c.B - B) * alpha);

            public Rgb Scale(double s) => new Rgb(R * s, G * s, B * s);
        }

        // ------------------------------------------------------------ fields

        private readonly Func<double> random;
        private readonly CpuParticleSystem system;
        private readonly Leak[] leaks = new Leak[MaxLeaks];
        private readonly AnchoredFire[] anchored = new AnchoredFire[MaxAnchoredFires];
        private readonly BurnSpot[] burnSpots = new BurnSpot[MaxBurnSpots];
        private int nextBurnSpot;
        private readonly FirePool[] pools = new FirePool[MaxFirePools];
        private int nextPool;
        private IMovingSurface movingSurface;
        private Func<double, double, bool> isWaterAt;
        private readonly FuelDrop[] fuelDrops = new FuelDrop[MaxFuelDrops];
        private int nextFuelDrop;
        private readonly List<Vec3d> dropPuffAt = new List<Vec3d>();
        private readonly List<double> dropPuffFlame = new List<double>();
        private readonly List<double> dropPuffEarly = new List<double>();
        private Func<double, double, double> groundHeightAt;
        private readonly byte[] dustFlags = new byte[ParticleCount];
        private Func<string, DamageSmokePose> poseProvider;
        private readonly int[] spawnSnapshot = new int[ParticleCount];

        /// <summary>Shared emitter scratch (the TS worldPos).</summary>
        private Vec3d worldPos;

        private Rgb tmpColor, tmpColorB;
        private Rgb yellow, orange, red, darkRed;
        private static readonly Rgb Black = new Rgb(0, 0, 0);
        private static readonly Rgb White = new Rgb(1, 1, 1);
        private Rgb smoke, smokeB, smokeC, smokeLead;
        private Rgb dust, dustB, concreteA, concreteB;
        private Rgb sprayA, sprayB, mistA, mistB, foamA, foamB;
        private readonly Rgb[] rampA = new Rgb[5];
        private readonly Rgb[] rampB = new Rgb[5];

        // ------------------------------------------------------------ callbacks and outputs

        /// <summary>Marks the ground where the lake burns (onPoolMark).</summary>
        public PoolMarkHandler OnPoolMark;

        /// <summary>A burn mark under a fire (onBurnMark).</summary>
        public BurnMarkHandler OnBurnMark;

        /// <summary>What the surface under a contact is (surfaceAt); null: scrapes throw plain gray smoke.</summary>
        public Func<double, double, SmokeSurfaceKind> SurfaceAt;

        /// <summary>Per live puff the column-major 4x4 instance matrix, float32 (instanceMatrix): compose(position, rotation, size).</summary>
        public readonly float[] InstanceMatrices = new float[ParticleCount * 16];

        /// <summary>Per live puff the dither opacity, float32 (`ditherLevel`); slots past the count keep old values (initially 0.75).</summary>
        public readonly float[] DitherLevels = new float[ParticleCount];

        /// <summary>Per live puff the primary tone, linear rgb float32 (`toneA`).</summary>
        public readonly float[] ToneA = new float[ParticleCount * 3];

        /// <summary>Per live puff the secondary dither tone, linear rgb float32 (`toneB`).</summary>
        public readonly float[] ToneB = new float[ParticleCount * 3];

        /// <summary>Per live puff its centre in double (scene space), for camera-relative placement.</summary>
        public readonly Vec3d[] InstancePositions = new Vec3d[ParticleCount];

        /// <summary>Per live puff its rotation (faces the camera, or lies flat for foam, then spun about its own Z).</summary>
        public readonly Quatd[] InstanceRotations = new Quatd[ParticleCount];

        /// <summary>Per live puff the disc radius (m): the uniform scale of a unit hexagon.</summary>
        public readonly double[] InstanceSizes = new double[ParticleCount];

        /// <summary>Per live puff its kind (KindFire .. KindConcrete).</summary>
        public readonly byte[] InstanceKinds = new byte[ParticleCount];

        /// <summary>Live puffs written by the last <see cref="SyncPuffs"/> (the InstancedMesh count).</summary>
        public int InstanceCount { get; private set; }

        /// <summary>The mesh's visible flag: some puff is live.</summary>
        public bool Visible => InstanceCount > 0;

        // ------------------------------------------------------------ inspection

        public CpuParticleSystem System => system;
        public IReadOnlyList<Leak> Leaks => leaks;
        public IReadOnlyList<AnchoredFire> Anchored => anchored;
        public IReadOnlyList<BurnSpot> BurnSpots => burnSpots;
        public IReadOnlyList<FirePool> Pools => pools;
        public IReadOnlyList<FuelDrop> FuelDrops => fuelDrops;
        /// <summary>The per-slot kind (the TS dustFlags).</summary>
        public IReadOnlyList<byte> SlotKinds => dustFlags;

        /// <param name="random">Math.random stand-in in [0, 1); seed it to replay the oracle.</param>
        public DamageSmokeField(Func<double> random)
        {
            this.random = random ?? throw new ArgumentNullException(nameof(random));
            // Near-zero emitter kick: the plume velocity is set after the burst.
            system = new CpuParticleSystem(new CpuParticleSystemConfig
            {
                SystemMaxParticles = ParticleCount,
                SystemReSpawn = true,
                EmitterSpawnRatePerSecond = 0,
                ParticleLifeMin = 22,
                ParticleLifeMax = 30,
                ParticleSizeStartMin = 0.8,
                ParticleSizeStartMax = 1.3,
                ParticleSizeEndMin = 16,
                ParticleSizeEndMax = 24,
                ParticleRotationStartMin = -Math.PI,
                ParticleRotationStartMax = Math.PI,
                ParticleRotationEndMin = -Math.PI * 1.2,
                ParticleRotationEndMax = Math.PI * 1.2,
            }, 0.02, 0.08, this.random);
            for (int i = 0; i < ParticleCount; i++) DitherLevels[i] = (float)FlameDither;
            for (int i = 0; i < MaxFuelDrops; i++) fuelDrops[i] = new FuelDrop();
            for (int i = 0; i < MaxFirePools; i++) pools[i] = new FirePool();
            for (int i = 0; i < MaxBurnSpots; i++) burnSpots[i] = new BurnSpot();
            for (int i = 0; i < MaxAnchoredFires; i++) anchored[i] = new AnchoredFire();
            for (int i = 0; i < MaxLeaks; i++) leaks[i] = new Leak();
        }

        // ------------------------------------------------------------ small helpers (module functions in the TS)

        private static double Clamp(double n, double min, double max) => Math.Max(min, Math.Min(n, max));

        private static double FlameShare(double burn) =>
            Clamp((burn - BurnOutFlameBelow) / (1 - BurnOutFlameBelow), 0, 1);

        private static double BurnRate(double burn) => BurnMinRate + (1 - BurnMinRate) * Clamp(burn, 0, 1);

        private double SmokeGap(double burn = 1)
        {
            double growth = 1 + BurnGapGrowth * (1 - Clamp(burn, 0, 1));
            return (SmokeGapMinS + random() * SmokeGapVariationS) * growth;
        }

        /// <summary>Which kind a new fire puff is: 0 flame, 2 pure smoke, 3 pure black.</summary>
        private int PickPuffKind(double flame = 1, double early = 0)
        {
            if (random() > flame)
            {
                return 2;
            }
            double calm = 1 - 0.7 * early;
            double r = random();
            if (r < BlackPuffChance * calm)
            {
                return 3;
            }
            return r < (BlackPuffChance + SmokePuffChance) * calm ? 2 : 0;
        }

        private static bool IsFinite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);

        // ------------------------------------------------------------ wiring

        /// <summary>Carry everything into a re-based frame.</summary>
        public void Rebase(FrameShift shift)
        {
            system.Rebase(shift);
            foreach (Leak leak in leaks)
            {
                leak.PinPos = shift.Point(leak.PinPos);
                leak.LastEmitPos = shift.Point(leak.LastEmitPos);
            }
            foreach (BurnSpot spot in burnSpots)
            {
                spot.Position = shift.Point(spot.Position);
            }
            foreach (FuelDrop drop in fuelDrops)
            {
                drop.Position = shift.Point(drop.Position);
                drop.Velocity = shift.Vector(drop.Velocity);
            }
            foreach (AnchoredFire fire in anchored)
            {
                fire.LastPos = shift.Point(fire.LastPos);
                fire.Vel = shift.Vector(fire.Vel);
            }
            foreach (FirePool pool in pools)
            {
                pool.Origin = shift.Point(pool.Origin);
                foreach (PoolPoint point in pool.Trail)
                {
                    point.Position = shift.Point(point.Position);
                }
            }
        }

        /// <summary>Whether a point is open water; fuel landing there splashes and is gone, and nothing is scorched.</summary>
        public void SetWaterTest(Func<double, double, bool> fn) => isWaterAt = fn;

        /// <summary>A lake of fuel and burning scratches laid on this surface go along with it.</summary>
        public void SetMovingSurface(IMovingSurface surface) => movingSurface = surface;

        public void SetGroundHeightAt(Func<double, double, double> fn) => groundHeightAt = fn;

        public void SetPoseProvider(Func<string, DamageSmokePose> provider) => poseProvider = provider;

        private bool OnMovingSurface(Vec3d p) => movingSurface != null && movingSurface.Contains(p.X, p.Y, p.Z);

        // ------------------------------------------------------------ entry points

        /// <summary>
        /// A splash where something heavy went into the water: a column of spray
        /// and a lingering mist (strength 0.15 .. 1.6).
        /// </summary>
        public void SpawnSplash(Vec3d position, double strength)
        {
            double s = Clamp(strength, 0.15, 1.6);
            worldPos = position;
            system.Position = worldPos;
            BurstTagged((int)JsMath.Round(8 + 22 * s), KindSpray, p =>
            {
                double a = random() * Math.PI * 2;
                double outward = (1 + random() * 4) * (0.5 + 0.6 * s);
                double vy = (4 + random() * 10) * (0.5 + 0.6 * s);
                p.Velocity = new Vec3d(JsTrig.Cos(a) * outward, vy, JsTrig.Sin(a) * outward);
                p.Lifespan = 1.0 + random() * 0.9;
                p.SizeStart = (0.9 + random() * 1.2) * (0.7 + 0.5 * s);
                p.SizeEnd = (3 + random() * 3) * (0.7 + 0.5 * s);
                return -1;
            });
            BurstTagged((int)JsMath.Round(6 + 14 * s), KindMist, p =>
            {
                double a = random() * Math.PI * 2;
                double outward = (2 + random() * 6) * (0.6 + 0.5 * s);
                double vy = 0.5 + random() * 2;
                p.Velocity = new Vec3d(JsTrig.Cos(a) * outward, vy, JsTrig.Sin(a) * outward);
                p.Lifespan = 3 + random() * 2.5;
                p.SizeStart = (2.5 + random() * 2) * (0.7 + 0.5 * s);
                p.SizeEnd = (10 + random() * 7) * (0.7 + 0.5 * s);
                return -1;
            });
        }

        /// <summary>
        /// Foam on the water round a piece in it: <paramref name="count"/> flat white
        /// puffs over a patch about <paramref name="radius"/> across. Position on the surface.
        /// </summary>
        public void SpawnFoam(Vec3d position, double radius, double count)
        {
            double r = Clamp(radius, 0.5, 10);
            worldPos = position;
            system.Position = worldPos;
            BurstTagged((int)Math.Max(1, JsMath.Round(count)), KindFoam, p =>
            {
                double a = random() * Math.PI * 2;
                double d = Math.Sqrt(random()) * (r * 0.9 + 0.6);
                p.Position = new Vec3d(position.X + JsTrig.Cos(a) * d, position.Y + 0.08, position.Z + JsTrig.Sin(a) * d);
                double outward = 0.2 + random() * 0.7;
                p.Velocity = new Vec3d(JsTrig.Cos(a) * outward, 0, JsTrig.Sin(a) * outward);
                p.Lifespan = 2.6 + random() * 1.8;
                double k = Clamp(r / 3, 0.7, 1.6);
                p.SizeStart = (1.3 + random() * 1.1) * k;
                p.SizeEnd = (3 + random() * 2) * k;
                return -1;
            });
        }

        /// <summary>Gun (non-scrape) hits: open or refresh a leak at the impact point on the airframe (at most six a frame).</summary>
        public void SpawnFromHits(IReadOnlyList<SimHitEvent> hits)
        {
            if (poseProvider == null)
            {
                return;
            }
            int n = Math.Min(hits.Count, MaxHitsPerFrame);
            for (int i = 0; i < n; i++)
            {
                SimHitEvent hit = hits[i];
                if (hit.Source == "scrape")
                {
                    continue;
                }
                DamageSmokePose pose = poseProvider(hit.TargetId);
                if (pose == null)
                {
                    continue;
                }
                worldPos = new Vec3d(hit.Position[0], hit.Position[1], hit.Position[2]);
                OpenLeak(hit.TargetId, pose, worldPos);
            }
        }

        /// <summary>Puffs at ground scrapes (source "scrape"), coloured for the surface when <see cref="SurfaceAt"/> is set.</summary>
        public void SpawnGroundScrapes(IReadOnlyList<SimHitEvent> hits)
        {
            int spawned = 0;
            for (int i = 0; i < hits.Count && spawned < MaxHitsPerFrame; i++)
            {
                SimHitEvent hit = hits[i];
                if (hit.Source != "scrape")
                {
                    continue;
                }
                worldPos = new Vec3d(hit.Position[0], hit.Position[1], hit.Position[2]);
                system.Position = worldPos;
                bool slide = hit.Slide == true;
                if (SurfaceAt != null)
                {
                    SpawnContactPuffs(
                        worldPos, SurfaceAt(hit.Position[0], hit.Position[2]),
                        slide ? 2 : 4 + (hit.Damage >= 20 ? 3 : 0), slide ? 0.5 : 1);
                }
                else
                {
                    EmitGroundSmokePuffs(3 + (hit.Damage >= 20 ? 3 : 0));
                }
                spawned++;
            }
        }

        /// <summary>A few small puffs at a contact point on the surface; scale 1 an impact, less a slide.</summary>
        public void SpawnContactPuffs(Vec3d position, SmokeSurfaceKind surface, double count, double scale)
        {
            worldPos = position;
            system.Position = worldPos;
            double s = Clamp(scale, 0.2, 1.5);
            byte kind = surface == SmokeSurfaceKind.Water ? KindSpray : surface == SmokeSurfaceKind.Concrete ? KindConcrete : KindDust;
            BurstTagged((int)Math.Max(1, JsMath.Round(count)), kind, p =>
            {
                double a = random() * Math.PI * 2;
                double outward = (0.8 + random() * 2.2) * (0.6 + 0.6 * s);
                double vy = (0.6 + random() * 2.2) * (0.6 + 0.6 * s);
                p.Velocity = new Vec3d(JsTrig.Cos(a) * outward, vy, JsTrig.Sin(a) * outward);
                p.Lifespan = 0.9 + random() * 0.9;
                // Dust stays in its dust phase for its life, so it keeps its colour.
                p.Life = Math.Max(p.Life, FirePhaseEnd * p.Lifespan + 1e-3);
                p.SizeStart = (0.35 + random() * 0.4) * (0.7 + 0.6 * s);
                p.SizeEnd = (1.6 + random() * 1.4) * (0.7 + 0.6 * s);
                return -1;
            });
        }

        /// <summary>Debug: open a leak a metre above the aircraft origin.</summary>
        public void SpawnDebugLeak(string targetId)
        {
            DamageSmokePose pose = poseProvider?.Invoke(targetId);
            if (pose == null)
            {
                return;
            }
            worldPos = pose.Position;
            worldPos.Y += 1;
            OpenLeak(targetId, pose, worldPos);
        }

        /// <summary>Keep (or start) a pinned plume at the wreck after ground impact; safe every crash transition.</summary>
        public void EnsureCrashPlume(string targetId)
        {
            if (HasAnchored(targetId))
            {
                return;
            }
            DamageSmokePose pose = poseProvider?.Invoke(targetId);
            Leak slot = FindLeak(targetId);
            if (slot == null)
            {
                if (pose == null)
                {
                    return;
                }
                OpenLeak(targetId, pose, pose.Position);
                slot = FindLeak(targetId);
            }
            if (slot == null)
            {
                return;
            }
            slot.Permanent = true;
            if (pose != null)
            {
                Vec3d offset = slot.LocalOffset.Rotate(pose.Quaternion);
                worldPos = pose.Position + offset;
            }
            else
            {
                worldPos = slot.LastEmitPos;
            }
            if (!slot.Crashed)
            {
                slot.Crashed = true;
                slot.PinPos = worldPos;
            }
            slot.LastEmitPos = slot.PinPos;
            slot.EmitAccum = Math.Max(slot.EmitAccum, 2);
        }

        /// <summary>Set a patch of ground alight for <paramref name="life"/> seconds (newest spots win once the 48 are used).</summary>
        public void AddBurnSpot(Vec3d position, double life, double intensity)
        {
            BurnSpot spot = burnSpots[nextBurnSpot];
            nextBurnSpot = (nextBurnSpot + 1) % MaxBurnSpots;
            spot.Active = true;
            spot.Position = position;
            spot.Remaining = life;
            spot.Life = life;
            spot.Intensity = intensity;
            spot.Accum = random();
            spot.Pause = 0;
            spot.Trickle = life;
            spot.TrickleLife = life;
            spot.Moving = OnMovingSurface(position);
        }

        /// <summary>The fireball at the moment of impact (severity 0.2 .. 1.5).</summary>
        public void SpawnFireball(Vec3d position, Vec3d velocity, double severity)
        {
            double s = Clamp(severity, 0.2, 1.5);
            worldPos = position;
            system.Position = worldPos;
            BurstTagged((int)JsMath.Round(50 + 80 * s), KindFire, p =>
            {
                double a = random() * Math.PI * 2;
                double outward = (4 + random() * 14) * (0.6 + 0.5 * s);
                double vx = JsTrig.Cos(a) * outward + velocity.X * 0.08;
                double vy = 3 + random() * 12 * (0.6 + 0.5 * s);
                double vz = JsTrig.Sin(a) * outward + velocity.Z * 0.08;
                p.Velocity = new Vec3d(vx, vy, vz);
                p.Lifespan = 4 + random() * 3;
                p.SizeStart = (3.5 + random() * 3.5) * (0.7 + 0.5 * s);
                p.SizeEnd = (16 + random() * 12) * (0.7 + 0.5 * s);
                return random() < 0.05 ? KindBlack : KindFire;
            });
        }

        /// <summary>True once this aircraft's fires ride on its wreck fragments.</summary>
        public bool HasAnchored(string targetId)
        {
            foreach (AnchoredFire a in anchored)
            {
                if (a.Active && a.TargetId == targetId)
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// A fire that follows <paramref name="where"/> (a wreck fragment or a damage point).
        /// <paramref name="life"/> +Infinity burns until reset; <paramref name="trickle"/> seconds of
        /// smoke after the flames; <paramref name="drips"/> burning fuel drops shed per second.
        /// </summary>
        public void AddAnchoredFire(string targetId, SmokeAnchor where, double rate, double life, bool small, double? trickle = null, double? drips = null)
        {
            AnchoredFire slot = null;
            foreach (AnchoredFire a in anchored)
            {
                if (!a.Active)
                {
                    slot = a;
                    break;
                }
            }
            if (slot == null)
            {
                return;
            }
            slot.Active = true;
            slot.TargetId = targetId;
            slot.Where = where;
            slot.Rate = rate;
            slot.Life = life;
            slot.Remaining = life;
            slot.Small = small;
            slot.Accum = 2;
            slot.Pause = 0;
            slot.Trickle = trickle ?? 0;
            slot.TrickleLife = trickle ?? 0;
            slot.DripRate = drips ?? 0;
            slot.DripAccum = 0;
            slot.HasLast = false;
        }

        /// <summary>Tan dust thrown up at an impact or kicked up by a sliding piece, biased along its travel.</summary>
        public void SpawnDust(Vec3d position, Vec3d velocity, int count, double strength)
        {
            worldPos = position;
            system.Position = worldPos;
            double s = Clamp(strength, 0.2, 1.5);
            BurstTagged(count, KindDust, p =>
            {
                double a = random() * Math.PI * 2;
                double outward = (3 + random() * 9) * s;
                double vx = JsTrig.Cos(a) * outward + velocity.X * 0.25;
                double vy = (1 + random() * 5) * s;
                double vz = JsTrig.Sin(a) * outward + velocity.Z * 0.25;
                p.Velocity = new Vec3d(vx, vy, vz);
                p.Lifespan = 4 + random() * 4;
                p.Life = Math.Max(p.Life, FirePhaseEnd * p.Lifespan + 1e-3);
                p.SizeStart = (1.5 + random() * 1.5) * (0.6 + 0.4 * s);
                p.SizeEnd = (9 + random() * 8) * (0.6 + 0.4 * s);
                return -1;
            });
        }

        /// <summary>
        /// Start a lake of burning fuel at a crash: it is made of the fuel that
        /// falls and lands (the crash's spray now, wreck drips later).
        /// </summary>
        public void AddFirePool(Vec3d impact, Vec3d velocity, double severity)
        {
            FirePool pool = pools[nextPool];
            nextPool = (nextPool + 1) % MaxFirePools;
            double strength = Clamp(severity, 0.3, 1.5);
            pool.Radius = 6 + 6 * strength;
            pool.Strength = strength;
            pool.Age = 0;
            pool.Life = PoolLifeS;
            pool.FlameAccum = 0;
            pool.SmokeAccum = 0;
            pool.MarkAccum = 0;
            pool.Trail.Clear();
            pool.Origin = impact;
            pool.OriginMoving = OnMovingSurface(impact);
            double len = JsMath.Hypot(velocity.X, velocity.Z);
            pool.DirX = len > 1e-3 ? velocity.X / len : 0;
            pool.DirZ = len > 1e-3 ? velocity.Z / len : 1;
            pool.Active = true;
            SpillFuel(impact, velocity, strength);
        }

        public void Reset()
        {
            system.Reset();
            Array.Clear(dustFlags, 0, dustFlags.Length);
            foreach (AnchoredFire a in anchored) a.Active = false;
            foreach (BurnSpot b in burnSpots) b.Active = false;
            foreach (FirePool pool in pools)
            {
                pool.Active = false;
                pool.Trail.Clear();
            }
            foreach (FuelDrop drop in fuelDrops) drop.Active = false;
            foreach (Leak leak in leaks)
            {
                leak.Active = false;
                leak.EmitRemaining = 0;
                leak.EmitAccum = 0;
                leak.Pause = 0;
                leak.Permanent = false;
                leak.Crashed = false;
            }
            InstanceCount = 0;
        }

        // ------------------------------------------------------------ bursts

        /// <summary>Burst <paramref name="count"/> puffs, run <paramref name="init"/> on each new one (slot order) and tag it with its return value, or <paramref name="kind"/> when that is negative.</summary>
        private void BurstTagged(int count, byte kind, Func<CpuParticle, int> init)
        {
            CpuParticle[] particles = system.Particles;
            for (int i = 0; i < particles.Length; i++) spawnSnapshot[i] = particles[i].Spawns;
            system.Burst(count, true);
            for (int i = 0; i < particles.Length; i++)
            {
                CpuParticle p = particles[i];
                if (p.IsActive && p.Spawns != spawnSnapshot[i])
                {
                    int over = init(p);
                    dustFlags[i] = over >= 0 ? (byte)over : kind;
                }
            }
        }

        private void OpenLeak(string targetId, DamageSmokePose pose, Vec3d hitWorld)
        {
            Leak slot = FindLeak(targetId);
            if (slot == null)
            {
                slot = AllocLeak();
                slot.Permanent = false;
                slot.Crashed = false;
            }
            slot.Active = true;
            slot.TargetId = targetId;
            if (!slot.Permanent)
            {
                slot.EmitRemaining = LeakEmitDurationSec;
            }
            slot.EmitAccum = Math.Max(slot.EmitAccum, 1);
            slot.LocalOffset = (hitWorld - pose.Position).Rotate(pose.Quaternion.Conjugate());
            slot.LastEmitPos = hitWorld;
            if (!pose.IsAlive || pose.IsCrashed)
            {
                slot.Permanent = true;
            }
            if (pose.IsCrashed && !slot.Crashed)
            {
                slot.Crashed = true;
                slot.PinPos = hitWorld;
            }
        }

        private Leak FindLeak(string targetId)
        {
            foreach (Leak leak in leaks)
            {
                if (leak.Active && leak.TargetId == targetId)
                {
                    return leak;
                }
            }
            return null;
        }

        private Leak AllocLeak()
        {
            foreach (Leak leak in leaks)
            {
                if (!leak.Active)
                {
                    return leak;
                }
            }
            // Prefer reclaiming a timed leak over a permanent wreck plume.
            int best = -1;
            for (int i = 0; i < leaks.Length; i++)
            {
                if (leaks[i].Permanent)
                {
                    continue;
                }
                if (best < 0 || leaks[i].EmitRemaining < leaks[best].EmitRemaining)
                {
                    best = i;
                }
            }
            if (best < 0)
            {
                best = 0;
            }
            return leaks[best];
        }

        private void EmitAtLeak(Leak leak, double rate, double delta, bool crashed)
        {
            if (leak.Pause > 0)
            {
                leak.Pause -= delta;
                return;
            }
            leak.EmitAccum += rate * delta;
            double toSpawn = Math.Floor(leak.EmitAccum);
            if (toSpawn > 0)
            {
                leak.EmitAccum -= toSpawn;
                if (EmitPuffs((int)toSpawn, crashed))
                {
                    leak.Pause = SmokeGap();
                }
            }
        }

        // ------------------------------------------------------------ the frame

        /// <summary>One simulation step: leaks, the deck, anchored fires, burn spots, lakes, falling fuel, then the pool.</summary>
        public void Update(double delta)
        {
            if (poseProvider != null)
            {
                foreach (Leak leak in leaks)
                {
                    if (!leak.Active)
                    {
                        continue;
                    }
                    if (!leak.Permanent)
                    {
                        leak.EmitRemaining -= delta;
                        if (leak.EmitRemaining <= 0)
                        {
                            leak.Active = false;
                            continue;
                        }
                    }
                    if (HasAnchored(leak.TargetId))
                    {
                        // The wreck's own fires have taken over from the pinned plume.
                        leak.Active = false;
                        continue;
                    }
                    DamageSmokePose pose = poseProvider(leak.TargetId);
                    if (pose == null)
                    {
                        if (leak.Permanent || leak.Crashed)
                        {
                            if (!leak.Crashed)
                            {
                                leak.Crashed = true;
                                leak.PinPos = leak.LastEmitPos;
                            }
                            system.Position = leak.PinPos;
                            EmitAtLeak(leak, CrashEmitRate, delta, true);
                            continue;
                        }
                        leak.Active = false;
                        continue;
                    }
                    if (!pose.IsAlive || pose.IsCrashed)
                    {
                        leak.Permanent = true;
                    }
                    worldPos = pose.Position + leak.LocalOffset.Rotate(pose.Quaternion);
                    if (pose.IsCrashed || leak.Crashed)
                    {
                        if (!leak.Crashed)
                        {
                            leak.Crashed = true;
                            leak.PinPos = worldPos;
                        }
                        worldPos = leak.PinPos;
                    }
                    leak.LastEmitPos = worldPos;
                    system.Position = worldPos;
                    double speed = pose.Velocity.Length;
                    double rate = leak.Crashed ? CrashEmitRate : LeakEmitRate * (1 + speed / SpeedRefMps);
                    EmitAtLeak(leak, rate, delta, leak.Crashed);
                }
            }
            CarryWithSurface(delta);
            UpdateAnchored(delta);
            UpdateBurnSpots(delta);
            UpdateFirePools(delta);
            UpdateFuelDrops(delta);
            system.Update(delta);
        }

        // ------------------------------------------------------------ lakes

        private void ScorchPoolEdges(FirePool pool)
        {
            if (OnPoolMark == null)
            {
                return;
            }
            foreach (PoolPoint point in pool.Trail)
            {
                if (!point.Outer && pool.Age - point.Born >= PoolOuterScorchAfterS)
                {
                    point.Outer = true;
                    OnPoolMark(point.Position, point.DirX, point.DirZ, point.RadiusNow * 2.4, point.RadiusNow * 2.4, false);
                }
            }
        }

        private void SpreadPuddles(FirePool pool, double delta)
        {
            double k = 1 - Math.Exp(-delta / PoolSpreadS);
            foreach (PoolPoint point in pool.Trail)
            {
                double target = Math.Min(pool.Radius, FuelPuddleBaseM + FuelPuddlePerDropM * point.Volume);
                point.RadiusNow += (target - point.RadiusNow) * k;
                if (OnPoolMark != null && point.RadiusNow - point.CharRadius >= FuelCharStepM)
                {
                    point.CharRadius = point.RadiusNow;
                    double a = random() * Math.PI * 2;
                    double edge = point.RadiusNow * 0.7;
                    var at = new Vec3d(
                        point.Position.X + JsTrig.Cos(a) * edge, point.Position.Y, point.Position.Z + JsTrig.Sin(a) * edge);
                    if (groundHeightAt != null)
                    {
                        at.Y = groundHeightAt(at.X, at.Z);
                    }
                    OnPoolMark(at, JsTrig.Cos(a), JsTrig.Sin(a), point.RadiusNow * 1.2, point.RadiusNow * 1.2, true);
                }
            }
        }

        private void UpdateFirePools(double delta)
        {
            foreach (FirePool pool in pools)
            {
                if (!pool.Active)
                {
                    continue;
                }
                pool.Age += delta;
                if (pool.Age >= pool.Life)
                {
                    pool.Active = false;
                    continue;
                }
                if (pool.Trail.Count == 0)
                {
                    continue;
                }
                SpreadPuddles(pool, delta);
                ScorchPoolEdges(pool);
                double burn = 1 - pool.Age / pool.Life;
                double early = Math.Exp(-pool.Age / 14);
                double areaFactor = Clamp(0.75 + 0.25 * pool.Trail.Count, 1, PoolMaxAreaFactor);
                double rate = Math.Min(
                    PoolMaxFlameRate,
                    (PoolFlameRate + PoolFlameRatePerStrength * pool.Strength)
                        * (0.2 + 0.8 * burn) * (1 + 0.9 * early) * areaFactor);
                pool.FlameAccum += rate * delta;
                double flames = Math.Floor(pool.FlameAccum);
                if (flames > 0)
                {
                    pool.FlameAccum -= flames;
                    EmitPoolFlames(pool, (int)flames, early, burn);
                }
                if (OnBurnMark != null && burn > 0.2)
                {
                    pool.MarkAccum += PoolBurnMarkRate * areaFactor * delta;
                    double marks = Math.Floor(pool.MarkAccum);
                    if (marks > 0)
                    {
                        pool.MarkAccum -= marks;
                        for (int m = 0; m < marks; m++)
                        {
                            Vec3d at = PoolPointAt(pool, 0.95);
                            Scorch(at.X, at.Y, at.Z, pool.Radius * (0.2 + 0.25 * random()));
                        }
                    }
                }
                pool.SmokeAccum += PoolSmokeRate * (0.3 + 0.7 * burn) * Math.Sqrt(areaFactor) * delta;
                double columns = Math.Floor(pool.SmokeAccum);
                if (columns > 0)
                {
                    pool.SmokeAccum -= columns;
                    EmitPoolSmoke(pool, (int)columns);
                }
            }
        }

        /// <summary>Ask for a burn mark of the given radius at a ground point (not on open water).</summary>
        private void Scorch(double x, double y, double z, double radius)
        {
            if (isWaterAt != null && isWaterAt(x, z))
            {
                return;
            }
            if (OnBurnMark == null)
            {
                return;
            }
            double strength = 0.55 + random() * 0.45;
            double grow = BurnMarkGrowMinS + random() * (BurnMarkGrowMaxS - BurnMarkGrowMinS);
            OnBurnMark(new Vec3d(x, y, z), radius, strength, grow);
        }

        /// <summary>A random point on the lake (poolPoint); <paramref name="inner"/> &lt; 1 keeps toward the middle.</summary>
        private Vec3d PoolPointAt(FirePool pool, double inner = 1)
        {
            PoolPoint point = pool.Trail[(int)Math.Floor(random() * pool.Trail.Count)];
            double r = Math.Sqrt(random()) * inner * point.RadiusNow;
            double a = random() * Math.PI * 2;
            var outp = new Vec3d(point.Position.X + JsTrig.Cos(a) * r, point.Position.Y, point.Position.Z + JsTrig.Sin(a) * r);
            if (groundHeightAt != null)
            {
                outp.Y = groundHeightAt(outp.X, outp.Z);
            }
            return outp;
        }

        private void EmitPoolFlames(FirePool pool, int count, double early, double burn)
        {
            double flame = Math.Max(FlameShare(burn), early);
            worldPos = pool.Trail[0].Position;
            system.Position = worldPos;
            BurstTagged(count, KindFire, p =>
            {
                p.Position = PoolPointAt(pool);
                double vx = (random() * 2 - 1) * DriftMps;
                double vy = 1.5 + random() * 4.5;
                double vz = (random() * 2 - 1) * DriftMps;
                p.Velocity = new Vec3d(vx, vy, vz);
                p.Lifespan = 2.4 + random() * 2.2;
                p.SizeStart = (1.8 + random() * 1.7) * (1 + 0.4 * early);
                p.SizeEnd = (3.9 + random() * 2.8) * (1 + 0.3 * early);
                return PickPuffKind(flame, early);
            });
        }

        private void EmitPoolSmoke(FirePool pool, int count)
        {
            worldPos = pool.Trail[0].Position;
            system.Position = worldPos;
            BurstTagged(count, KindBlack, p =>
            {
                p.Position = PoolPointAt(pool, 0.6);
                double vx = (random() * 2 - 1) * DriftMps;
                double vy = 9 + random() * 8;
                double vz = (random() * 2 - 1) * DriftMps;
                p.Velocity = new Vec3d(vx, vy, vz);
                p.Lifespan = 11 + random() * 7;
                p.SizeStart = 3.5 + random() * 2.5;
                p.SizeEnd = 20 + random() * 12;
                return random() < 0.7 ? KindBlack : KindSmoke;
            });
        }

        /// <summary>What was laid on a moving surface goes along with it (lake points, crash site, burning scratches).</summary>
        private void CarryWithSurface(double delta)
        {
            IMovingSurface surface = movingSurface;
            if (surface == null)
            {
                return;
            }
            Vec3d v = surface.Velocity;
            foreach (FirePool pool in pools)
            {
                if (!pool.Active)
                {
                    continue;
                }
                if (pool.OriginMoving)
                {
                    pool.Origin = pool.Origin.AddScaled(v, delta);
                }
                foreach (PoolPoint point in pool.Trail)
                {
                    if (point.Moving)
                    {
                        point.Position = point.Position.AddScaled(v, delta);
                    }
                }
            }
            foreach (BurnSpot spot in burnSpots)
            {
                if (spot.Active && spot.Moving)
                {
                    spot.Position = spot.Position.AddScaled(v, delta);
                }
            }
        }

        // ------------------------------------------------------------ falling fuel

        private void ShedFuel(AnchoredFire fire, double delta)
        {
            if (fire.HasLast && delta > 0)
            {
                fire.Vel = (worldPos - fire.LastPos) / delta;
                double speed = fire.Vel.Length;
                if (speed > 80)
                {
                    fire.Vel = fire.Vel * (80 / speed);
                }
            }
            fire.LastPos = worldPos;
            fire.HasLast = true;
            if (fire.DripRate <= 0 || groundHeightAt == null)
            {
                return;
            }
            double ground = groundHeightAt(worldPos.X, worldPos.Z);
            Vec3d from = worldPos;
            from.Y = Math.Max(from.Y, ground + FuelMinFallM);
            double burn = IsFinite(fire.Life) ? Clamp(fire.Remaining / fire.Life, 0, 1) : 1;
            double early = Freshness(fire);
            fire.DripAccum += fire.DripRate * (0.3 + 0.7 * burn) * delta;
            while (fire.DripAccum >= 1)
            {
                fire.DripAccum -= 1;
                SpawnFuelDrop(from, fire.Vel, Math.Max(FlameShare(burn), early), early);
            }
        }

        private void SpawnFuelDrop(Vec3d origin, Vec3d carried, double flame, double early)
        {
            double x = origin.X + (random() - 0.5) * 1.2;
            double y = origin.Y - random() * 0.3;
            double z = origin.Z + (random() - 0.5) * 1.2;
            double vx = carried.X * 0.55 + (random() - 0.5) * 3;
            double vy = carried.Y * 0.55 + random() * 1.5;
            double vz = carried.Z * 0.55 + (random() - 0.5) * 3;
            LaunchFuelDrop(x, y, z, vx, vy, vz, true, flame, early);
        }

        private void LaunchFuelDrop(double x, double y, double z, double vx, double vy, double vz, bool streak, double flame, double early)
        {
            FuelDrop drop = fuelDrops[nextFuelDrop];
            nextFuelDrop = (nextFuelDrop + 1) % MaxFuelDrops;
            drop.Active = true;
            drop.Streak = streak;
            drop.Flame = flame;
            drop.Early = early;
            drop.TrailTimer = random() * FuelTrailIntervalS;
            drop.Position = new Vec3d(x, y, z);
            drop.Velocity = new Vec3d(vx, vy, vz);
        }

        /// <summary>The crash ruptures the tanks: fuel sprays out, carried forward, and rains down ahead of the impact.</summary>
        private void SpillFuel(Vec3d impact, Vec3d velocity, double strength)
        {
            int count = (int)JsMath.Round(SpillDropsBase + SpillDropsPerStrength * strength);
            for (int i = 0; i < count; i++)
            {
                double x = impact.X + (random() - 0.5) * 6;
                double y = impact.Y + 0.4 + random() * 2.2;
                double z = impact.Z + (random() - 0.5) * 6;
                double vx = velocity.X * SpillCarry + (random() - 0.5) * 10;
                double vy = 2 + random() * 9 * (0.6 + 0.5 * strength);
                double vz = velocity.Z * SpillCarry + (random() - 0.5) * 10;
                LaunchFuelDrop(x, y, z, vx, vy, vz, i % 2 == 0, 1, 1);
            }
        }

        private void UpdateFuelDrops(double delta)
        {
            if (groundHeightAt == null)
            {
                return;
            }
            dropPuffAt.Clear();
            dropPuffFlame.Clear();
            dropPuffEarly.Clear();
            foreach (FuelDrop drop in fuelDrops)
            {
                if (!drop.Active)
                {
                    continue;
                }
                drop.Velocity.Y -= FuelGravity * delta;
                drop.Position = drop.Position.AddScaled(drop.Velocity, delta);
                double ground = groundHeightAt(drop.Position.X, drop.Position.Z);
                if (drop.Position.Y <= ground + 0.05)
                {
                    drop.Active = false;
                    LandFuel(drop.Position.X, ground, drop.Position.Z);
                    continue;
                }
                drop.TrailTimer += delta;
                if (drop.Streak && drop.TrailTimer >= FuelTrailIntervalS)
                {
                    drop.TrailTimer = 0;
                    dropPuffAt.Add(drop.Position);
                    dropPuffFlame.Add(drop.Flame);
                    dropPuffEarly.Add(drop.Early);
                }
            }
            if (dropPuffAt.Count > 0)
            {
                // A short streak of flame behind each falling drop, all in one burst.
                int next = 0;
                worldPos = dropPuffAt[0];
                system.Position = worldPos;
                BurstTagged(dropPuffAt.Count, KindFire, p =>
                {
                    int i = next++ % dropPuffAt.Count;
                    p.Position = dropPuffAt[i];
                    double vx = (random() - 0.5) * 1.2;
                    double vy = (random() - 0.5) * 1.2;
                    double vz = (random() - 0.5) * 1.2;
                    p.Velocity = new Vec3d(vx, vy, vz);
                    p.Lifespan = 0.9 + random() * 0.7;
                    p.SizeStart = 0.5 + random() * 0.4;
                    p.SizeEnd = 1.6 + random() * 1.0;
                    return PickPuffKind(dropPuffFlame[i], dropPuffEarly[i]);
                });
            }
        }

        /// <summary>How fresh the youngest active lake is (1 right after the crash, easing to 0); 0 with none.</summary>
        private double LakeEarly()
        {
            double early = 0;
            foreach (FirePool pool in pools)
            {
                if (pool.Active)
                {
                    early = Math.Max(early, Math.Exp(-pool.Age / 14));
                }
            }
            return early;
        }

        /// <summary>How fresh a fire is: 1 when it starts, falling to 0.</summary>
        private static double Freshness(AnchoredFire fire)
        {
            return IsFinite(fire.Life)
                ? Math.Exp(-(fire.Life - fire.Remaining) / Math.Min(fire.Small ? EarlyTauSmallS : EarlyTauS, fire.Life * 0.3))
                : 0;
        }

        /// <summary>How much of its life the youngest active lake has left (1 with none).</summary>
        private double LakeBurn()
        {
            double burn = 0;
            bool any = false;
            foreach (FirePool pool in pools)
            {
                if (pool.Active)
                {
                    any = true;
                    burn = Math.Max(burn, 1 - pool.Age / pool.Life);
                }
            }
            return any ? burn : 1;
        }

        /// <summary>A drop of burning fuel hits the ground: it splashes, scorches and feeds the lake (or splashes on the sea).</summary>
        private void LandFuel(double x, double ground, double z)
        {
            if (isWaterAt != null && isWaterAt(x, z))
            {
                worldPos = new Vec3d(x, ground, z);
                SpawnSplash(worldPos, 0.2);
                return;
            }
            worldPos = new Vec3d(x, ground + 0.2, z);
            system.Position = worldPos;
            double burn = LakeBurn();
            double early = LakeEarly();
            double flame = Math.Max(FlameShare(burn), early);
            BurstTagged(3, KindFire, p =>
            {
                double vx = (random() - 0.5) * 5;
                double vy = 1 + random() * 3;
                double vz = (random() - 0.5) * 5;
                p.Velocity = new Vec3d(vx, vy, vz);
                p.Lifespan = 1.6 + random() * 1.2;
                p.SizeStart = 1.0 + random() * 0.8;
                p.SizeEnd = 3 + random() * 2;
                return PickPuffKind(flame, early);
            });
            Scorch(x, ground, z, 0.8 + random() * 0.7);
            FeedLake(x, ground, z);
        }

        /// <summary>Fuel has landed: add the spot to the lake it belongs to, unless it is already part of it.</summary>
        private void FeedLake(double x, double y, double z)
        {
            FirePool best = null;
            double bestReach = FuelFeedReachM;
            double bestToPoint = double.PositiveInfinity;
            PoolPoint bestPoint = null;
            foreach (FirePool pool in pools)
            {
                if (!pool.Active)
                {
                    continue;
                }
                double toPoint = double.PositiveInfinity;
                PoolPoint nearest = null;
                foreach (PoolPoint point in pool.Trail)
                {
                    double d = JsMath.Hypot(point.Position.X - x, point.Position.Z - z);
                    if (d < toPoint)
                    {
                        toPoint = d;
                        nearest = point;
                    }
                }
                double reach = Math.Min(toPoint, JsMath.Hypot(pool.Origin.X - x, pool.Origin.Z - z));
                if (reach < bestReach)
                {
                    bestReach = reach;
                    bestToPoint = toPoint;
                    bestPoint = nearest;
                    best = pool;
                }
            }
            if (best == null)
            {
                return;
            }
            if (bestPoint != null && bestToPoint < FuelMergeM)
            {
                bestPoint.Volume += 1;
                return;
            }
            if (best.Trail.Count >= MaxPoolPoints)
            {
                return;
            }
            var position = new Vec3d(x, y, z);
            best.Trail.Add(new PoolPoint
            {
                Position = position,
                Born = best.Age,
                DirX = best.DirX,
                DirZ = best.DirZ,
                Segment = 0,
                Outer = false,
                Moving = movingSurface != null && movingSurface.Contains(x, y, z),
                Volume = 1,
                RadiusNow = FuelSplashRadiusM,
                CharRadius = FuelSplashRadiusM,
            });
            OnPoolMark?.Invoke(position, best.DirX, best.DirZ, FuelSplashRadiusM * 2.4, FuelSplashRadiusM * 2.4, true);
        }

        // ------------------------------------------------------------ burn spots and anchored fires

        private void UpdateBurnSpots(double delta)
        {
            foreach (BurnSpot spot in burnSpots)
            {
                if (!spot.Active)
                {
                    continue;
                }
                spot.Remaining -= delta;
                if (spot.Remaining <= 0)
                {
                    spot.Trickle -= delta;
                    if (spot.Trickle <= 0)
                    {
                        spot.Active = false;
                        continue;
                    }
                    if (spot.Pause > 0)
                    {
                        spot.Pause -= delta;
                        continue;
                    }
                    EmitSpotWisp(spot, delta);
                    continue;
                }
                if (OnBurnMark != null && groundHeightAt != null)
                {
                    spot.MarkAccum += SpotBurnMarkRate * spot.Intensity * delta;
                    if (spot.MarkAccum >= 1)
                    {
                        spot.MarkAccum -= 1;
                        double gy = groundHeightAt(spot.Position.X, spot.Position.Z);
                        Scorch(spot.Position.X, gy, spot.Position.Z, 0.9 + random() * 0.7);
                    }
                }
                if (spot.Pause > 0)
                {
                    spot.Pause -= delta;
                    continue;
                }
                double burn = spot.Remaining / spot.Life;
                if (random() < (1 - burn) * BurnRandomBreaksPerS * delta)
                {
                    spot.Pause = SmokeGap(burn);
                    continue;
                }
                double early = Math.Exp(-(spot.Life - spot.Remaining) / EarlyTauSpotS);
                spot.Accum += BurnSpotRate * spot.Intensity * BurnRate(burn) * (1 + EarlyBoostSpot * early) * delta;
                double n = Math.Floor(spot.Accum);
                if (n > 0)
                {
                    spot.Accum -= n;
                    worldPos = spot.Position;
                    system.Position = worldPos;
                    bool gap = false;
                    double flame = FlameShare(burn);
                    BurstTagged((int)n, KindFire, p =>
                    {
                        double vx = (random() * 2 - 1) * DriftMps;
                        double vy = 3 + random() * 4;
                        double vz = (random() * 2 - 1) * DriftMps;
                        p.Velocity = new Vec3d(vx, vy, vz);
                        p.Lifespan = 4 + random() * 3;
                        p.SizeStart = 0.8 + random() * 0.6;
                        p.SizeEnd = 3.5 + random() * 2.5;
                        int kind = PickPuffKind(flame);
                        gap = gap || kind != 0;
                        return kind;
                    });
                    if (gap)
                    {
                        spot.Pause = SmokeGap(burn);
                    }
                }
            }
        }

        private void EmitSpotWisp(BurnSpot spot, double delta)
        {
            double left = spot.TrickleLife > 0 ? Clamp(spot.Trickle / spot.TrickleLife, 0, 1) : 0;
            spot.Accum += SpotTrickleRate * spot.Intensity * (0.25 + 0.75 * left) * delta;
            double n = Math.Floor(spot.Accum);
            if (n <= 0)
            {
                return;
            }
            spot.Accum -= n;
            worldPos = spot.Position;
            system.Position = worldPos;
            BurstTagged((int)n, KindSmoke, p =>
            {
                double vx = (random() * 2 - 1) * DriftMps * 0.6;
                double vy = 2 + random() * 2.5;
                double vz = (random() * 2 - 1) * DriftMps * 0.6;
                p.Velocity = new Vec3d(vx, vy, vz);
                p.Lifespan = 7 + random() * 5;
                p.SizeStart = 0.5 + random() * 0.3;
                p.SizeEnd = 2.5 + random() * 1.5;
                return -1;
            });
            if (random() < 0.6)
            {
                spot.Pause = SmokeGap(0) * (1 + 2 * (1 - left));
            }
        }

        private void UpdateAnchored(double delta)
        {
            foreach (AnchoredFire fire in anchored)
            {
                if (!fire.Active)
                {
                    continue;
                }
                fire.Remaining -= delta;
                if (!fire.Where(out Vec3d at))
                {
                    fire.Active = false;
                    continue;
                }
                worldPos = at;
                bool smouldering = fire.Remaining <= 0;
                if (smouldering)
                {
                    fire.Trickle -= delta;
                    if (fire.Trickle <= 0)
                    {
                        fire.Active = false;
                        continue;
                    }
                }
                if (!smouldering && OnBurnMark != null && groundHeightAt != null)
                {
                    double ground = groundHeightAt(worldPos.X, worldPos.Z);
                    if (worldPos.Y - ground < BurnMarkReachM)
                    {
                        fire.MarkAccum += (fire.Small ? FireBurnMarkRateSmall : FireBurnMarkRate) * delta;
                        if (fire.MarkAccum >= 1)
                        {
                            fire.MarkAccum -= 1;
                            Scorch(worldPos.X, ground, worldPos.Z, (fire.Small ? 1.1 : 2.3) * (0.7 + 0.6 * random()));
                        }
                    }
                }
                if (!smouldering)
                {
                    ShedFuel(fire, delta);
                }
                if (fire.Pause > 0)
                {
                    fire.Pause -= delta;
                    continue;
                }
                system.Position = worldPos;
                if (smouldering)
                {
                    EmitTrickle(fire, delta);
                    continue;
                }
                double burn = IsFinite(fire.Life) ? Clamp(fire.Remaining / fire.Life, 0, 1) : 1;
                if (random() < (1 - burn) * BurnRandomBreaksPerS * delta)
                {
                    fire.Pause = SmokeGap(burn);
                    continue;
                }
                double early = Freshness(fire);
                double boost = 1 + (fire.Small ? EarlyBoostRateSmall : EarlyBoostRate) * early;
                fire.Accum += fire.Rate * BurnRate(burn) * boost * delta;
                double n = Math.Floor(fire.Accum);
                if (n > 0)
                {
                    fire.Accum -= n;
                    if (EmitPuffs((int)n, true, fire.Small, Math.Max(FlameShare(burn), early), early))
                    {
                        fire.Pause = SmokeGap(burn);
                    }
                }
            }
        }

        private void EmitTrickle(AnchoredFire fire, double delta)
        {
            double left = fire.TrickleLife > 0 ? Clamp(fire.Trickle / fire.TrickleLife, 0, 1) : 0;
            fire.Accum += (fire.Small ? TrickleRateSmall : TrickleRate) * (0.25 + 0.75 * left) * delta;
            double n = Math.Floor(fire.Accum);
            if (n <= 0)
            {
                return;
            }
            fire.Accum -= n;
            bool small = fire.Small;
            BurstTagged((int)n, KindSmoke, p =>
            {
                double vx = (random() * 2 - 1) * DriftMps;
                double vy = RiseMps * (0.2 + random() * 0.12);
                double vz = (random() * 2 - 1) * DriftMps;
                p.Velocity = new Vec3d(vx, vy, vz);
                p.Lifespan = 16 + random() * 8;
                p.SizeStart = small ? 0.7 + random() * 0.4 : 1.1 + random() * 0.6;
                p.SizeEnd = small ? 4 + random() * 2 : 7 + random() * 4;
                return -1;
            });
            if (random() < 0.6)
            {
                fire.Pause = SmokeGap(0) * (1 + 2 * (1 - left));
            }
        }

        /// <summary>The plume puffs (leaks and anchored fires); true if any came out as smoke or black, to break the stream.</summary>
        private bool EmitPuffs(int count, bool crashed, bool small = false, double flame = 1, double early = 0)
        {
            bool nonFlame = false;
            CpuParticle[] particles = system.Particles;
            for (int i = 0; i < particles.Length; i++) spawnSnapshot[i] = particles[i].Spawns;
            system.Burst(count, true);
            for (int i = 0; i < particles.Length; i++)
            {
                CpuParticle p = particles[i];
                if (!p.IsActive || p.Spawns == spawnSnapshot[i])
                {
                    continue;
                }
                double vx = (random() * 2 - 1) * DriftMps;
                double vy = RiseMps * (0.9 + random() * 0.2);
                double vz = (random() * 2 - 1) * DriftMps;
                p.Lifespan = 22 + random() * 8;
                if (small)
                {
                    vy *= 0.55;
                    p.Lifespan = 11 + random() * 5;
                    p.SizeStart = 1.0 + random() * 0.6;
                    p.SizeEnd = 6 + random() * 4;
                }
                else
                {
                    if (crashed)
                    {
                        p.SizeStart = Math.Max(p.SizeStart, 2.2 + random() * 1.2);
                    }
                    p.SizeEnd = 16 + random() * 8;
                }
                vy *= 1 + EarlyRiseBoost * early;
                p.Velocity = new Vec3d(vx, vy, vz);
                p.SizeStart *= 1 + EarlySizeStartBoost * early;
                p.SizeEnd *= 1 + EarlySizeEndBoost * early;
                int kind = PickPuffKind(flame, early);
                nonFlame = nonFlame || kind != 0;
                dustFlags[i] = (byte)kind;
            }
            return nonFlame;
        }

        /// <summary>Short gray puffs at a ground scrape with no surface probe: no fire phase.</summary>
        private void EmitGroundSmokePuffs(int count)
        {
            CpuParticle[] particles = system.Particles;
            for (int i = 0; i < particles.Length; i++) spawnSnapshot[i] = particles[i].Spawns;
            system.Burst(count, true);
            for (int i = 0; i < particles.Length; i++)
            {
                CpuParticle p = particles[i];
                if (!p.IsActive || p.Spawns == spawnSnapshot[i])
                {
                    continue;
                }
                double vx = (random() * 2 - 1) * DriftMps * 1.4;
                double vy = RiseMps * (0.35 + random() * 0.25);
                double vz = (random() * 2 - 1) * DriftMps * 1.4;
                p.Velocity = new Vec3d(vx, vy, vz);
                p.Lifespan = 4 + random() * 3;
                p.Life = Math.Max(p.Life, FirePhaseEnd * p.Lifespan + 1e-3);
                p.SizeStart = 1.2 + random() * 0.8;
                p.SizeEnd = 6 + random() * 4;
                dustFlags[i] = KindSmoke;
            }
        }

        // ------------------------------------------------------------ colours

        /// <summary>three.js SRGBToLinear.</summary>
        private static double SrgbToLinear(double c) =>
            c < 0.04045 ? c * 0.0773993808 : Math.Pow(c * 0.9478672986 + 0.0521327014, 2.4);

        /// <summary>three.js LinearToSRGB.</summary>
        private static double LinearToSrgb(double c) =>
            c < 0.0031308 ? c * 12.92 : 1.055 * Math.Pow(c, 0.41666) - 0.055;

        /// <summary>new THREE.Color().setHex(hex): sRGB bytes into the linear working space.</summary>
        private static Rgb FromHex(int hex) => new Rgb(
            SrgbToLinear(((hex >> 16) & 255) / 255.0),
            SrgbToLinear(((hex >> 8) & 255) / 255.0),
            SrgbToLinear((hex & 255) / 255.0));

        /// <summary>Color.set("#rrggbb") (also "#rgb").</summary>
        private static Rgb FromCss(string css)
        {
            string h = css.Substring(1);
            if (h.Length == 3)
            {
                h = new string(new[] { h[0], h[0], h[1], h[1], h[2], h[2] });
            }
            return FromHex(int.Parse(h, NumberStyles.HexNumber, CultureInfo.InvariantCulture));
        }

        /// <summary>Color.getHSL(...).s (in sRGB).</summary>
        private static double Saturation(Rgb c)
        {
            double r = LinearToSrgb(c.R), g = LinearToSrgb(c.G), b = LinearToSrgb(c.B);
            double max = Math.Max(r, Math.Max(g, b));
            double min = Math.Min(r, Math.Min(g, b));
            double lightness = (min + max) / 2.0;
            if (min == max)
            {
                return 0;
            }
            double delta = max - min;
            return lightness <= 0.5 ? delta / (max + min) : delta / (2 - max - min);
        }

        private void CachePaletteColors(Palette palette)
        {
            yellow = FromCss(palette.Color(PaletteCategory.FX_FIRE__B));
            orange = FromCss(palette.Color(PaletteCategory.FX_FIRE));
            if (Saturation(orange) > 0.2)
            {
                // Coloured palette: take the reds from the red end of the hue wheel.
                red = FromHex(0xd81a0a);
                darkRed = FromHex(0x5e0a04);
            }
            else
            {
                // Grayscale palette (night vision): stay gray, just darker.
                red = orange.Scale(0.72);
                darkRed = orange.Scale(0.36);
            }
            smoke = FromCss(palette.Color(PaletteCategory.FX_SMOKE));
            smokeB = FromCss(palette.Color(PaletteCategory.FX_SMOKE__B));
            smokeC = FromCss(palette.Color(PaletteCategory.FX_SMOKE__C));
            smokeLead = SmokeAt(SmokeToneBLead);
            rampA[0] = yellow; rampA[1] = orange; rampA[2] = red; rampA[3] = darkRed; rampA[4] = smoke;
            rampB[0] = yellow; rampB[1] = orange; rampB[2] = red; rampB[3] = darkRed; rampB[4] = smokeLead;
            dust = FromCss(palette.Color(PaletteCategory.SCENERY_FIELD_OCHRE));
            dustB = FromCss(palette.ColorShade(PaletteCategory.SCENERY_FIELD_OCHRE));
            concreteA = smokeB;
            concreteB = smokeC;
            sprayA = smokeC.Lerp(White, 0.7);
            sprayB = smokeC.Lerp(White, 0.45);
            mistA = smokeC.Lerp(White, 0.35);
            mistB = smokeC.Lerp(White, 0.15);
            foamA = smokeC.Lerp(White, 0.9);
            foamB = smokeC.Lerp(White, 0.65);
        }

        /// <summary>Default smoke colour at age 0..1: FX_SMOKE, FX_SMOKE__B, then FX_SMOKE__C.</summary>
        private Rgb SmokeAt(double age)
        {
            double a = Clamp(age, 0, 1);
            return a < 0.5 ? smoke.Lerp(smokeB, a * 2) : smokeB.Lerp(smokeC, (a - 0.5) * 2);
        }

        private void ApplySmokeAge(double age)
        {
            tmpColor = SmokeAt(age);
            tmpColorB = SmokeAt(age + SmokeToneBLead);
        }

        private static Rgb SampleRamp(Rgb[] ramp, double heat)
        {
            double h = Clamp(heat, 0, 1);
            int last = FireRampHeat.Length - 1;
            if (h >= FireRampHeat[last])
            {
                return ramp[last];
            }
            int i = 0;
            while (i < last - 1 && h >= FireRampHeat[i + 1])
            {
                i++;
            }
            double t = (h - FireRampHeat[i]) / (FireRampHeat[i + 1] - FireRampHeat[i]);
            return ramp[i].Lerp(ramp[i + 1], t);
        }

        private void ApplyHeatColors(double heat01)
        {
            tmpColor = SampleRamp(rampA, heat01);
            tmpColorB = SampleRamp(rampB, heat01 + FireToneBLead);
        }

        // ------------------------------------------------------------ draw

        /// <summary>Euler(-PI/2, 0, 0, 'XYZ') as three.js turns it into a quaternion (foam lies flat).</summary>
        private static readonly Quatd FlatOnWater = FlatQuaternion();

        private static Quatd FlatQuaternion()
        {
            double x = -Math.PI / 2;
            double c1 = JsTrig.Cos(x / 2), c2 = JsTrig.Cos(0.0), c3 = JsTrig.Cos(0.0);
            double s1 = JsTrig.Sin(x / 2), s2 = JsTrig.Sin(0.0), s3 = JsTrig.Sin(0.0);
            return new Quatd(
                s1 * c2 * c3 + c1 * s2 * s3,
                c1 * s2 * c3 - s1 * c2 * s3,
                c1 * c2 * s3 + s1 * s2 * c3,
                c1 * c2 * c3 - s1 * s2 * s3);
        }

        private static readonly Vec3d ObjectUp = new Vec3d(0, 1, 0);

        /// <summary>
        /// The TS syncPuffs (run by render3D): compact the live puffs, in slot
        /// order, into the instance arrays. Each puff is a unit hexagon
        /// (CircleGeometry(1, 6), normal +Z) scaled to its size, turned to face
        /// <paramref name="cameraPosition"/> (Object3D.lookAt, so its +Z points
        /// at the camera) or laid flat for foam, then spun about its Z.
        /// </summary>
        public void SyncPuffs(Vec3d cameraPosition, Palette palette)
        {
            CachePaletteColors(palette);
            int live = 0;
            CpuParticle[] particles = system.Particles;
            for (int i = 0; i < particles.Length && i < ParticleCount; i++)
            {
                CpuParticle p = particles[i];
                if (!p.IsActive)
                {
                    continue;
                }
                double progress = p.Life / p.Lifespan;
                double sizeT = progress < FirePhaseEnd
                    ? (progress / FirePhaseEnd) * FireSizeGrowth
                    : FireSizeGrowth + (1 - FireSizeGrowth) * ((progress - FirePhaseEnd) / (1 - FirePhaseEnd));
                double size = p.SizeStart + (p.SizeEnd - p.SizeStart) * sizeT;

                byte flag = dustFlags[i];
                bool isDust = flag == KindDust;
                if (flag == KindFoam)
                {
                    tmpColor = foamA;
                    tmpColorB = foamB;
                }
                else if (flag == KindSpray)
                {
                    tmpColor = sprayA;
                    tmpColorB = sprayB;
                }
                else if (flag == KindMist)
                {
                    tmpColor = mistA;
                    tmpColorB = mistB;
                }
                else if (flag == KindConcrete)
                {
                    tmpColor = concreteA;
                    tmpColorB = concreteB;
                }
                else if (isDust)
                {
                    tmpColor = dust;
                    tmpColorB = dustB;
                }
                else if (flag == KindBlack)
                {
                    tmpColor = Black;
                    tmpColorB = Black;
                }
                else
                {
                    double fireEnd = Clamp(FireColourSeconds / p.Lifespan, FirePhaseEnd, 0.5);
                    if (flag == KindSmoke)
                    {
                        ApplySmokeAge(progress);
                    }
                    else if (progress >= fireEnd)
                    {
                        ApplySmokeAge((progress - fireEnd) / (1 - fireEnd));
                    }
                    else
                    {
                        ApplyHeatColors(progress / fireEnd);
                    }
                }
                ToneA[live * 3] = (float)tmpColor.R;
                ToneA[live * 3 + 1] = (float)tmpColor.G;
                ToneA[live * 3 + 2] = (float)tmpColor.B;
                ToneB[live * 3] = (float)tmpColorB.R;
                ToneB[live * 3 + 1] = (float)tmpColorB.G;
                ToneB[live * 3 + 2] = (float)tmpColorB.B;
                double fadeT = 1 - (1 - progress) * (1 - progress);
                double start = isDust || flag == KindMist || flag == KindFoam || flag == KindConcrete ? DustDitherStart : SmokeDitherStart;
                DitherLevels[live] = (float)(start + fadeT * (SmokeDitherEnd - start));

                Quatd q = flag == KindFoam
                    ? FlatOnWater
                    // Object3D.lookAt for a non-camera: Matrix4.lookAt(target, position, up).
                    : CameraPose.LookRotation(cameraPosition, p.Position, ObjectUp);
                q = q * Quatd.FromAxisAngle(Vec3d.UnitZ, p.RotationStart + (p.RotationEnd - p.RotationStart) * progress);

                InstancePositions[live] = p.Position;
                InstanceRotations[live] = q;
                InstanceSizes[live] = size;
                InstanceKinds[live] = flag;
                WriteMatrix(live * 16, p.Position, q, size);
                live++;
            }
            InstanceCount = live;
        }

        /// <summary>Matrix4.compose(position, quaternion, (s, s, s)) written as float32 (setMatrixAt).</summary>
        private void WriteMatrix(int o, Vec3d position, Quatd q, double s)
        {
            double x = q.X, y = q.Y, z = q.Z, w = q.W;
            double x2 = x + x, y2 = y + y, z2 = z + z;
            double xx = x * x2, xy = x * y2, xz = x * z2;
            double yy = y * y2, yz = y * z2, zz = z * z2;
            double wx = w * x2, wy = w * y2, wz = w * z2;
            float[] te = InstanceMatrices;
            te[o] = (float)((1 - (yy + zz)) * s);
            te[o + 1] = (float)((xy + wz) * s);
            te[o + 2] = (float)((xz - wy) * s);
            te[o + 3] = 0;
            te[o + 4] = (float)((xy - wz) * s);
            te[o + 5] = (float)((1 - (xx + zz)) * s);
            te[o + 6] = (float)((yz + wx) * s);
            te[o + 7] = 0;
            te[o + 8] = (float)((xz + wy) * s);
            te[o + 9] = (float)((yz - wx) * s);
            te[o + 10] = (float)((1 - (xx + yy)) * s);
            te[o + 11] = 0;
            te[o + 12] = (float)position.X;
            te[o + 13] = (float)position.Y;
            te[o + 14] = (float)position.Z;
            te[o + 15] = 1;
        }
    }
}

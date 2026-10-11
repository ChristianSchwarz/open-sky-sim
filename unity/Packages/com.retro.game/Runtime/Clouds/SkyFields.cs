using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// The game's two scenery fields as state/game.ts sets them up: the cumulus deck (9 x 9 tiles
    /// of 6 km, 2 x 2 cells each, about 1.4 km up) and the cirrus band (7 x 7 tiles of 60 km,
    /// about 9.2 km up), both over a +-10,000 km area, plus the altitude functions they use.
    /// There is no cloud-cover setting, wind drift or per-area density in the web game: the
    /// probabilities below are fixed.
    /// </summary>
    public static class SkyFields
    {
        public const double CloudBaseAltitudeM = 1400;
        public const double CloudAltitudeVariationM = 500;
        /// <summary>Just under HIGH_ALTITUDE_M: a separate band above the cumulus deck.</summary>
        public const double CirrusBaseAltitudeM = 9200;
        public const double CirrusAltitudeVariationM = 400;

        /// <summary>terrain/lod.ts SPACE_SKY_ALTITUDE_M: both fields are switched off (no fade) at and above this camera y.</summary>
        public const double SpaceSkyAltitudeM = 100_000;

        /// <summary>Clouds' LOD bias: levels shed well before the default bias (3) would.</summary>
        public const int CloudLodBias = -2;

        /// <summary>The fields' area: a huge Box2 so they cover wherever the player roams.</summary>
        public static readonly FieldArea Area = new FieldArea(-1e7, -1e7, 1e7, 1e7);

        /// <summary>cloudAltitudeAt: base of a cumulus cell at field x/z (field coordinates, not scene).</summary>
        public static double CloudAltitudeAt(double x, double z) =>
            CloudBaseAltitudeM + JsTrig.Sin(x * 0.00021) * JsTrig.Cos(z * 0.00017) * CloudAltitudeVariationM;

        /// <summary>cirrusAltitudeAt.</summary>
        public static double CirrusAltitudeAt(double x, double z) =>
            CirrusBaseAltitudeM + JsTrig.Sin(x * 0.00013 + 5) * JsTrig.Cos(z * 0.00009 + 5) * CirrusAltitudeVariationM;

        /// <summary>cloudFieldOptions: 12 % large, 18 % medium, 15 % small, 55 % open sky.</summary>
        public static SceneryFieldSettings CloudSettings() => new SceneryFieldSettings
        {
            TilesInField = 9,
            CellsInTile = 2,
            TileLength = 6000,
            CellVariations = new[]
            {
                new SceneryFieldCellVariation { Probability = 0.12, Model = "lib:cloudLarge", Jitter = 1, RandomRotation = true, LodBias = CloudLodBias },
                new SceneryFieldCellVariation { Probability = 0.18, Model = "lib:cloudMedium", Jitter = 1, RandomRotation = true, LodBias = CloudLodBias },
                new SceneryFieldCellVariation { Probability = 0.15, Model = "lib:cloudSmall", Jitter = 1, RandomRotation = true, LodBias = CloudLodBias },
                new SceneryFieldCellVariation { Probability = 0.55, Model = "lib:cloudNone", Jitter = 0, RandomRotation = false },
            },
        };

        /// <summary>cirrusFieldOptions: 8 % wide, 12 % thin, 80 % none; no rotation (one wind-shear heading).</summary>
        public static SceneryFieldSettings CirrusSettings() => new SceneryFieldSettings
        {
            TilesInField = 7,
            CellsInTile = 2,
            TileLength = 60000,
            CellVariations = new[]
            {
                new SceneryFieldCellVariation { Probability = 0.08, Model = "lib:cirrusWide", Jitter = 1, RandomRotation = false },
                new SceneryFieldCellVariation { Probability = 0.12, Model = "lib:cirrusThin", Jitter = 1, RandomRotation = false },
                new SceneryFieldCellVariation { Probability = 0.8, Model = "lib:cirrusNone", Jitter = 0, RandomRotation = false },
            },
        };

        public static SceneryField CreateCloudField(Func<double> random) =>
            new SceneryField(Area, CloudSettings(), CloudAltitudeAt, random);

        public static SceneryField CreateCirrusField(Func<double> random) =>
            new SceneryField(Area, CirrusSettings(), CirrusAltitudeAt, random);

        /// <summary>applySpaceSkyState: whether the fields draw for this camera (showcase views keep them).</summary>
        public static bool FieldsEnabled(double cameraY, bool showcase) => cameraY < SpaceSkyAltitudeM || showcase;
    }
}

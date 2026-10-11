namespace Retro.Game
{
    /// <summary>A single puff within a cumulus cluster, local metres (cloudModelBuilder.ts CloudPuffLobe).</summary>
    public readonly struct CloudPuffLobe
    {
        public readonly double X, Y, Z, R;

        public CloudPuffLobe(double x, double y, double z, double r)
        {
            X = x;
            Y = y;
            Z = z;
            R = r;
        }
    }

    /// <summary>
    /// One elongated wisp within a cirrus streak (cirrusModelBuilder.ts CirrusWisp): a unit
    /// icosahedron scaled to length (x), height (y) and width (z), local metres.
    /// </summary>
    public readonly struct CirrusWisp
    {
        public readonly double X, Y, Z, Length, Width, Height;

        public CirrusWisp(double x, double y, double z, double length, double width, double height)
        {
            X = x;
            Y = y;
            Z = z;
            Length = length;
            Width = width;
            Height = height;
        }
    }

    /// <summary>The hand-placed lobe clusters and streaks (CLOUD_PUFF_SHAPES, CIRRUS_STREAK_SHAPES).</summary>
    public static class CloudShapes
    {
        private static CloudPuffLobe L(double x, double y, double z, double r) => new CloudPuffLobe(x, y, z, r);

        private static CirrusWisp W(double x, double y, double z, double length, double width, double height) =>
            new CirrusWisp(x, y, z, length, width, height);

        public static readonly CloudPuffLobe[] Small =
        {
            L(0, 0, 0, 110), L(95, 20, 45, 85), L(-90, 15, -40, 80), L(15, 55, -15, 70), L(-50, 30, 60, 65),
            L(70, 10, -70, 60), L(-30, 45, 40, 55), L(110, 5, -30, 50), L(-100, 40, 20, 55), L(40, 60, -40, 48),
        };

        public static readonly CloudPuffLobe[] Medium =
        {
            L(-170, 0, 0, 150), L(30, 30, 30, 190), L(200, 8, -25, 160), L(60, 85, -10, 120), L(-60, 60, 45, 105),
            L(-140, 40, -80, 90), L(150, 60, 80, 95), L(10, 120, -40, 80), L(260, 30, 20, 100), L(-220, 15, 10, 110),
            L(90, 30, -90, 90), L(100, 100, 60, 85), L(-100, 90, -50, 80), L(180, 100, -70, 75),
        };

        public static readonly CloudPuffLobe[] Large =
        {
            L(-230, 0, 0, 200), L(30, 15, 60, 260), L(260, 8, -45, 210), L(80, 120, -15, 180), L(-90, 170, 45, 150),
            L(15, 250, 0, 120), L(-200, 60, -120, 140), L(220, 70, 120, 150), L(-50, 220, -60, 100), L(120, 280, 20, 90),
            L(330, 30, 10, 130), L(-320, 20, 0, 140), L(0, 40, 130, 120), L(-30, 40, -180, 130), L(150, 150, 80, 110),
            L(-150, 140, -80, 100), L(0, 200, 100, 95), L(200, 40, 180, 110), L(-220, 40, -180, 100),
        };

        public static readonly CirrusWisp[] Thin =
        {
            W(0, 0, 0, 13500, 2400, 525),
            W(7800, 90, 675, 9300, 1800, 420),
            W(-7050, -75, -525, 8400, 1650, 390),
            W(3600, 45, -840, 7800, 1500, 360),
            W(-4200, -36, 780, 7200, 1440, 345),
            W(10200, 120, -180, 6000, 1260, 300),
        };

        public static readonly CirrusWisp[] Wide =
        {
            W(0, 0, 0, 21000, 3900, 675),
            W(11400, 150, 975, 14250, 3000, 570),
            W(-10800, -120, -1125, 13500, 2850, 540),
            W(3300, 240, -2550, 10500, 2250, 450),
            W(-5400, 60, 2100, 9600, 2040, 420),
            W(15600, -60, -1200, 8400, 1800, 390),
            W(-14400, 180, 900, 9000, 1950, 405),
            W(6600, -90, 2850, 7800, 1680, 360),
        };
    }
}

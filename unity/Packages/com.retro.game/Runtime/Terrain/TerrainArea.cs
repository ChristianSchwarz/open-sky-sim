namespace Retro.Game
{
    /// <summary>
    /// One baked area of the terrain manifest (manifest.ts TerrainArea: a
    /// named LonLatBounds), degrees.
    /// </summary>
    public sealed class TerrainArea
    {
        public string Name = "";
        public double West;
        public double South;
        public double East;
        public double North;

        public TerrainArea() { }

        public TerrainArea(string name, double west, double south, double east, double north)
        {
            Name = name;
            West = west;
            South = south;
            East = east;
            North = north;
        }
    }

    public static class PlayArea
    {
        /// <summary>playArea.ts areaContains: inclusive on every edge.</summary>
        public static bool AreaContains(TerrainArea area, double lat, double lon)
        {
            return lon >= area.West && lon <= area.East && lat >= area.South && lat <= area.North;
        }
    }
}

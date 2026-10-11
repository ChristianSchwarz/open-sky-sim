using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>One kind of cell content (sceneryField.ts SceneryFieldCellVariation).</summary>
    public sealed class SceneryFieldCellVariation
    {
        /// <summary>All variations together should sum to at most 1.</summary>
        public double Probability;
        /// <summary>Model URL, e.g. "lib:cloudLarge" (see <see cref="SkyModels"/>).</summary>
        public string Model;
        /// <summary>[0,1]: random offset within the cell, 1 = out to the cell edge.</summary>
        public double Jitter;
        /// <summary>Random yaw in quarter turns.</summary>
        public bool RandomRotation;
        /// <summary>LOD bias; null = SimpleEntity's DEFAULT_LOD_BIAS (3).</summary>
        public int? LodBias;
    }

    /// <summary>sceneryField.ts SceneryFieldSettings.</summary>
    public sealed class SceneryFieldSettings
    {
        /// <summary>Field side, tiles.</summary>
        public int TilesInField;
        /// <summary>Tile side, cells.</summary>
        public int CellsInTile;
        /// <summary>Tile side, metres.</summary>
        public double TileLength;
        public SceneryFieldCellVariation[] CellVariations;
    }

    /// <summary>A three.js Box2 in field x/z (containsPoint is inclusive).</summary>
    public readonly struct FieldArea
    {
        public readonly double MinX, MinZ, MaxX, MaxZ;

        public FieldArea(double minX, double minZ, double maxX, double maxZ)
        {
            MinX = minX;
            MinZ = minZ;
            MaxX = maxX;
            MaxZ = maxZ;
        }

        public bool Contains(double x, double z) => !(x < MinX || x > MaxX || z < MinZ || z > MaxZ);

        public FieldArea Expanded(double s) => new FieldArea(MinX - s, MinZ - s, MaxX + s, MaxZ + s);
    }

    /// <summary>
    /// Six planes (normal . p + constant >= 0 inside), with three.js Frustum.intersectsSphere.
    /// Fill it from the camera's planes in scene axes; <see cref="FromProjectionMatrix"/> is
    /// three's setFromProjectionMatrix (WebGL clip space) for a column-major projScreen matrix.
    /// </summary>
    public sealed class FieldFrustum
    {
        public readonly double[] Planes = new double[24];

        public void SetPlane(int i, double nx, double ny, double nz, double constant)
        {
            Planes[i * 4] = nx;
            Planes[i * 4 + 1] = ny;
            Planes[i * 4 + 2] = nz;
            Planes[i * 4 + 3] = constant;
        }

        public bool IntersectsSphere(Vec3d c, double radius)
        {
            double negRadius = -radius;
            for (int i = 0; i < 6; i++)
            {
                double d = Planes[i * 4] * c.X + Planes[i * 4 + 1] * c.Y + Planes[i * 4 + 2] * c.Z + Planes[i * 4 + 3];
                if (d < negRadius) return false;
            }
            return true;
        }

        /// <summary>Frustum.setFromProjectionMatrix(projection * matrixWorldInverse), WebGL coordinate system.</summary>
        public static FieldFrustum FromProjectionMatrix(double[] me)
        {
            var f = new FieldFrustum();
            f.SetNormalised(0, me[3] - me[0], me[7] - me[4], me[11] - me[8], me[15] - me[12]);
            f.SetNormalised(1, me[3] + me[0], me[7] + me[4], me[11] + me[8], me[15] + me[12]);
            f.SetNormalised(2, me[3] + me[1], me[7] + me[5], me[11] + me[9], me[15] + me[13]);
            f.SetNormalised(3, me[3] - me[1], me[7] - me[5], me[11] - me[9], me[15] - me[13]);
            f.SetNormalised(4, me[3] - me[2], me[7] - me[6], me[11] - me[10], me[15] - me[14]);
            f.SetNormalised(5, me[3] + me[2], me[7] + me[6], me[11] + me[10], me[15] + me[14]);
            return f;
        }

        /// <summary>Plane.setComponents(...).normalize().</summary>
        private void SetNormalised(int i, double x, double y, double z, double w)
        {
            double inv = 1.0 / Math.Sqrt(x * x + y * y + z * z);
            SetPlane(i, x * inv, y * inv, z * inv, w * inv);
        }
    }

    /// <summary>The render pass a field is collected for: what SceneryField.render3D reads off the camera.</summary>
    public struct FieldView
    {
        /// <summary>Camera position, scene metres (the field's own frame, before any camera-relative shift).</summary>
        public Vec3d CameraPosition;
        /// <summary>tan(verticalFov / 2). The web game uses Math.tan(fovDeg * PI / 180 / 2); fov is 50 deg in the cockpit.</summary>
        public double TanHalfFov;
        /// <summary>Viewport width / height.</summary>
        public double Aspect;
        /// <summary>Render-target width in pixels (the supersampled width when SSAA is on).</summary>
        public double TargetWidth;
        /// <summary>Camera frustum, or null to skip the per-cell frustum test.</summary>
        public FieldFrustum Frustum;
    }

    /// <summary>One drawn cell: model, LOD level and transform (scale is always 1).</summary>
    public struct FieldInstance
    {
        /// <summary>Tile slot in the field (row-major over the TilesInField^2 tiles) and cell in it.</summary>
        public int Tile, Cell;
        public int Variation;
        public SkyShapeModel Model;
        /// <summary>Scene position of the model's origin (the base centre), metres.</summary>
        public Vec3d Position;
        /// <summary>Yaw about +Y in quarter turns (0..3) and the same as a quaternion.</summary>
        public int QuarterTurns;
        public Quatd Rotation;
        /// <summary>Resolved LOD level (resolveLodLevel); -1 only when collected with includeUndrawn.</summary>
        public int Lod;
    }

    /// <summary>
    /// sceneryField.ts SceneryField: a TilesInField x TilesInField block of tiles, each
    /// CellsInTile x CellsInTile cells, dealt once at construction (variation, jitter offset,
    /// quarter-turn yaw) and wrapped around the camera every pass, so a tile that falls off one
    /// side of the field reappears on the other with the same contents. Positions, heights, earth
    /// drop, area and frustum tests and the screen-size LOD are computed per pass by
    /// <see cref="Collect"/>.
    /// </summary>
    public sealed class SceneryField
    {
        private readonly SceneryFieldSettings _options;
        private readonly FieldArea _area;
        private readonly FieldArea _paddedArea;
        private readonly Func<double, double, double> _heightAt;
        private readonly int _tileMinIndex, _tileMaxIndex;
        private readonly double _fieldLength, _cellLength;

        /// <summary>Per tile slot, per cell (row-major).</summary>
        public readonly Cell[][] Tiles;

        /// <summary>One dealt cell (FieldTileElement).</summary>
        public readonly struct Cell
        {
            public readonly int Variation;
            public readonly SkyShapeModel Model;
            public readonly int LodBias;
            /// <summary>Offset from the tile centre, metres.</summary>
            public readonly double OffsetX, OffsetZ;
            public readonly int QuarterTurns;
            public readonly Quatd Rotation;

            public Cell(int variation, SkyShapeModel model, int lodBias, double offsetX, double offsetZ, int quarterTurns, Quatd rotation)
            {
                Variation = variation;
                Model = model;
                LodBias = lodBias;
                OffsetX = offsetX;
                OffsetZ = offsetZ;
                QuarterTurns = quarterTurns;
                Rotation = rotation;
            }
        }

        /// <summary>Scene -> field x/z, moved by <see cref="Rebase"/> so a re-base keeps the same patch of sky.</summary>
        public double FieldOffsetX { get; private set; }
        public double FieldOffsetZ { get; private set; }

        /// <summary>SceneLayers on/off: the game turns both fields off at and above SPACE_SKY_ALTITUDE_M.</summary>
        public bool Enabled = true;

        /// <summary>Per-cell frustum test radius (cellLength).</summary>
        public double CullRadius { get; }

        public SceneryFieldSettings Settings => _options;

        /// <param name="random">
        /// Uniform [0,1) source used only while dealing the cells. The web game uses Math.random,
        /// so every session gets a different sky; pass a seeded one (e.g. Gun.Mulberry32) for a
        /// repeatable one.
        /// </param>
        public SceneryField(FieldArea area, SceneryFieldSettings options, Func<double, double, double> heightAt,
            Func<double> random, Func<string, SkyShapeModel> models = null)
        {
            models ??= SkyModels.Get;
            _options = options;
            _area = area;
            _heightAt = heightAt ?? ((x, z) => 0);
            int n = options.TilesInField;
            _tileMinIndex = (int)Math.Ceiling(-n / 2.0);
            _tileMaxIndex = (int)Math.Ceiling(n / 2.0);
            _fieldLength = n * options.TileLength;
            _cellLength = options.TileLength / options.CellsInTile;
            CullRadius = _cellLength;
            _paddedArea = area.Expanded(options.TileLength * 2);

            Tiles = new Cell[n * n][];
            for (int i = 0; i < Tiles.Length; i++)
            {
                var tile = new Cell[options.CellsInTile * options.CellsInTile];
                for (int row = 0; row < options.CellsInTile; row++)
                {
                    for (int col = 0; col < options.CellsInTile; col++)
                    {
                        tile[row * options.CellsInTile + col] = BuildCell(row, col, random, models);
                    }
                }
                Tiles[i] = tile;
            }
        }

        private Cell BuildCell(int row, int col, Func<double> random, Func<string, SkyShapeModel> models)
        {
            int variation = PickVariation(random());
            SceneryFieldCellVariation v = _options.CellVariations[variation];
            // genElementOffset: always two draws, whatever the jitter.
            double theta = random() * 2 * Math.PI;
            double rho = random();
            double sqRho = Math.Sqrt(rho);
            double x = (col + 0.5) * _cellLength - _options.TileLength / 2 + v.Jitter * _cellLength / 2 * sqRho * JsTrig.Cos(theta);
            double z = (row + 0.5) * _cellLength - _options.TileLength / 2 + v.Jitter * _cellLength / 2 * sqRho * JsTrig.Sin(theta);
            int turns = 0;
            Quatd rotation = Quatd.Identity;
            if (v.RandomRotation)
            {
                turns = (int)Math.Floor(random() * 4);
                rotation = YawQuaternion(turns * 0.5 * Math.PI);
            }
            return new Cell(variation, models(v.Model), v.LodBias ?? ModelLod.DefaultLodBias, x, z, turns, rotation);
        }

        /// <summary>Quaternion.setFromAxisAngle(UP, angle).</summary>
        private static Quatd YawQuaternion(double angle)
        {
            double half = angle / 2, s = JsTrig.Sin(half);
            return new Quatd(0 * s, 1 * s, 0 * s, JsTrig.Cos(half));
        }

        /// <summary>pickRandomCellVariation: walk the cumulative probabilities.</summary>
        private int PickVariation(double n)
        {
            int index = -1;
            SceneryFieldCellVariation[] vs = _options.CellVariations;
            while (n >= 0 && index < vs.Length - 1)
            {
                index++;
                n -= vs[index].Probability;
            }
            return index < 0 ? 0 : index;
        }

        /// <summary>
        /// SceneryField.rebase: keep the field where it was around the new origin. The field's
        /// axes do not turn with the frame.
        /// </summary>
        public void Rebase(FrameShift shift)
        {
            Vec3d anchor = (-shift.Offset).Rotate(shift.Rotation.Conjugate());
            FieldOffsetX += anchor.X;
            FieldOffsetZ += anchor.Z;
        }

        /// <summary>
        /// render3D's CPU half: every cell of the 9 x 9 (or n x n) wrapped tiles that passes the
        /// area and frustum tests and resolves to a drawable LOD level is appended to `output`,
        /// in the oracle's order (tile rows north to south, columns west to east, cells row-major).
        /// Nothing is appended when the field is disabled or the camera is outside the padded area.
        /// With `includeUndrawn`, cells that pass the area and frustum tests but resolve to no
        /// level (open-sky cells, clouds past their last LOD) are appended too, with Lod = -1.
        /// </summary>
        public void Collect(in FieldView view, List<FieldInstance> output, bool includeUndrawn = false)
        {
            if (!Enabled) return;
            double camX = view.CameraPosition.X + FieldOffsetX;
            double camZ = view.CameraPosition.Z + FieldOffsetZ;
            if (!_paddedArea.Contains(camX, camZ)) return;

            double tileLength = _options.TileLength;
            int idx = 0;
            for (int row = _tileMinIndex; row < _tileMaxIndex; row++)
            {
                double z = Math.Floor((camZ + row * tileLength) / _fieldLength + 0.5) * _fieldLength - row * tileLength;
                for (int col = _tileMinIndex; col < _tileMaxIndex; col++)
                {
                    double x = Math.Floor((camX + col * tileLength) / _fieldLength + 0.5) * _fieldLength - col * tileLength;
                    int tileIndex = idx++;
                    Cell[] tile = Tiles[tileIndex];
                    for (int i = 0; i < tile.Length; i++)
                    {
                        Cell item = tile[i];
                        double fx = x + item.OffsetX;
                        double fz = z + item.OffsetZ;
                        double wx = fx - FieldOffsetX;
                        double wz = fz - FieldOffsetZ;
                        // The deck follows the earth down from the frame's origin.
                        double drop = (wx * wx + wz * wz) / (2 * Geodesy.Wgs84A);
                        var position = new Vec3d(wx, _heightAt(fx, fz) - drop, wz);
                        if (!_area.Contains(fx, fz)) continue;
                        if (view.Frustum != null && !view.Frustum.IntersectsSphere(position, CullRadius)) continue;
                        int requested = SkyLod.GetLodLevel(position, view, item.Model.MaxSize, item.LodBias);
                        int lod = SkyLod.Resolve(item.Model, requested);
                        if (lod < 0 && !includeUndrawn) continue;
                        output.Add(new FieldInstance
                        {
                            Tile = tileIndex, Cell = i, Variation = item.Variation, Model = item.Model, Position = position,
                            QuarterTurns = item.QuarterTurns, Rotation = item.Rotation, Lod = lod,
                        });
                    }
                }
            }
        }
    }

    /// <summary>render/helpers.ts getLodLevel and resolveLodLevel, exact for a unit-scale entity.</summary>
    public static class SkyLod
    {
        /// <summary>REF_WIDTH, pixels.</summary>
        private const double RefWidth = 320;

        public static int GetLodLevel(Vec3d position, in FieldView view, double modelMaxSize, int bias)
        {
            if (modelMaxSize == 0) return 0;
            Vec3d c = view.CameraPosition;
            double dx = c.X - position.X, dy = c.Y - position.Y, dz = c.Z - position.Z;
            double d = Math.Sqrt(dx * dx + dy * dy + dz * dz);
            double visible = view.Aspect * 2 * view.TanHalfFov * d;
            if (visible == 0) return 0;
            double relativeSize = modelMaxSize * 1 / visible;
            double referenceSize = relativeSize * RefWidth;
            double realSize = relativeSize * view.TargetWidth;
            double ratio = realSize / referenceSize;
            double scaled = relativeSize * ratio;
            return scaled >= 1 ? 0 : (int)Math.Max(0, FloorNegLog2(scaled) - bias);
        }

        /// <summary>resolveLodLevel: -1 = draw nothing.</summary>
        public static int Resolve(SkyShapeModel model, int requested)
        {
            int populated = 0, first = -1;
            for (int i = 0; i < model.LodCount; i++)
            {
                if (!model.LevelHasGeometry(i)) continue;
                if (first < 0) first = i;
                populated++;
            }
            if (populated == 0) return -1;
            if (requested >= model.LodCount) return populated > 1 ? -1 : first;
            for (int lod = requested; lod >= 0; lod--)
            {
                if (model.LevelHasGeometry(lod)) return lod;
            }
            return first;
        }

        /// <summary>
        /// Math.floor(-Math.log2(x)) for 0 &lt; x &lt; 1 from the exponent bits (netstandard2.1 has
        /// no Math.Log2, and Math.Log(x, 2) misses exact powers of two, where the floor turns).
        /// </summary>
        private static double FloorNegLog2(double x)
        {
            if (double.IsNaN(x) || x < 0) return double.NaN;
            if (x == 0) return double.PositiveInfinity;
            long bits = BitConverter.DoubleToInt64Bits(x);
            int biased = (int)((bits >> 52) & 0x7ff);
            long fraction = bits & 0xfffffffffffffL;
            int exponent;
            if (biased == 0)
            {
                exponent = -1022;
                while ((fraction & (1L << 52)) == 0)
                {
                    fraction <<= 1;
                    exponent--;
                }
                fraction &= 0xfffffffffffffL;
            }
            else
            {
                exponent = biased - 1023;
            }
            // x = (1 + f) * 2^e: -log2 x = -e - log2(1 + f), whose floor is -e - 1 unless f = 0.
            return fraction == 0 ? -exponent : -exponent - 1;
        }
    }
}

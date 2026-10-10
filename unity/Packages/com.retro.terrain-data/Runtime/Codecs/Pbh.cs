using System;
using System.Collections.Generic;
using System.IO;
using Retro.Core;

namespace Retro.Terrain
{
    public enum RoofForm
    {
        Flat = 1,
        Gabled = 2,
        Hipped = 3,
        HalfHipped = 4,
        Skillion = 5,
        Pyramidal = 6,
    }

    /// <summary>A building's true local frame: point (u, v, h) sits at u*A + v*B + h*Up from the tile centre.</summary>
    public sealed class PbhFrame
    {
        public Vec3d A;
        public Vec3d B;
        public Vec3d Up;
    }

    public sealed class PbhBuilding
    {
        public int FirstRing;
        public int RingCount;
        public int FirstVert;
        public double BaseM;
        public double EaveM;
        public double RidgeM;
        public RoofForm Form;
        /// <summary>Radians, from A toward B.</summary>
        public double RidgeAngle;
        public int RoofTone;
        public int WallTone;
        /// <summary>1 = no walls, 2 = RoofRgb valid.</summary>
        public int Flags;
        /// <summary>0xRRGGBB, sRGB.</summary>
        public int RoofRgb;
    }

    /// <summary>A decoded PBH1 building tile (v1-v2): parameters, extruded at runtime.</summary>
    public sealed class PbhTile
    {
        public TileKey Id;
        public PbhFrame Frame;
        /// <summary>Most prominent first.</summary>
        public List<PbhBuilding> Buildings;
        public byte[] RingSizes;
        /// <summary>(u, v) metre pairs; the first ring of a building is the CCW outline, later rings CW courtyards.</summary>
        public float[] Verts;
    }

    public static class PbhCodec
    {
        public const uint Magic = 0x31484250; // 'PBH1'
        public const int MaxVersion = 2;
        public const int HeaderBytes = 64;
        public const int BuildingBytes = 20;
        public const double StepM = 0.25;
        public const double HeightStepM = 0.1;
        public const int FlagNoWalls = 1, FlagRoofRgb = 2;

        public static PbhTile Decode(byte[] raw)
        {
            if (raw.Length < HeaderBytes) throw new InvalidDataException($"PBH1 too short: {raw.Length}");
            Bytes.Magic(raw, Magic, "PBH1");
            int version = Bytes.U8(raw, 4);
            if (version < 1 || version > MaxVersion) throw new InvalidDataException($"PBH1 version {version}, expected 1 to {MaxVersion}");
            var id = new TileKey(Bytes.U8(raw, 5), (int)Bytes.U32(raw, 8), (int)Bytes.U32(raw, 12));
            Func<int, double> f = i => Bytes.F32(raw, 16 + i * 4);
            var frame = new PbhFrame
            {
                A = new Vec3d(f(0), f(1), f(2)),
                B = new Vec3d(f(3), f(4), f(5)),
                Up = new Vec3d(f(6), f(7), f(8)),
            };
            int count = (int)Bytes.U32(raw, 52), ringCount = (int)Bytes.U32(raw, 56), vertCount = (int)Bytes.U32(raw, 60);
            int bBytes = Bytes.Align4(count * BuildingBytes), rBytes = Bytes.Align4(ringCount);
            int need = HeaderBytes + bBytes + rBytes + vertCount * 4;
            if (raw.Length < need) throw new InvalidDataException($"PBH1 {id}: {raw.Length} bytes, {need} needed");

            byte[] ringSizes = Bytes.Section<byte>(raw, HeaderBytes + bBytes, ringCount);
            var firstVertOfRing = new int[ringCount + 1];
            for (int r = 0; r < ringCount; r++) firstVertOfRing[r + 1] = firstVertOfRing[r] + ringSizes[r];

            var verts = new float[vertCount * 2];
            int vo = HeaderBytes + bBytes + rBytes;
            for (int i = 0; i < vertCount; i++)
            {
                verts[i * 2] = (float)(Bytes.I16(raw, vo + i * 4) * StepM);
                verts[i * 2 + 1] = (float)(Bytes.I16(raw, vo + i * 4 + 2) * StepM);
            }

            var buildings = new List<PbhBuilding>(count);
            for (int i = 0; i < count; i++)
            {
                int o = HeaderBytes + i * BuildingBytes;
                int firstRing = (int)Bytes.U32(raw, o);
                double baseM = Bytes.I16(raw, o + 4) * HeightStepM;
                buildings.Add(new PbhBuilding
                {
                    FirstRing = firstRing,
                    RingCount = Bytes.U8(raw, o + 15),
                    FirstVert = firstVertOfRing[Math.Min(firstRing, ringCount)],
                    BaseM = baseM,
                    EaveM = baseM + Bytes.U16(raw, o + 6) * HeightStepM,
                    RidgeM = baseM + Bytes.U16(raw, o + 8) * HeightStepM,
                    Form = (RoofForm)Bytes.U8(raw, o + 12),
                    RidgeAngle = Bytes.U16(raw, o + 10) / 65536.0 * 2 * Math.PI,
                    RoofTone = Bytes.U8(raw, o + 13),
                    WallTone = Bytes.U8(raw, o + 14),
                    Flags = Bytes.U8(raw, o + 16),
                    RoofRgb = (Bytes.U8(raw, o + 17) << 16) | (Bytes.U8(raw, o + 18) << 8) | Bytes.U8(raw, o + 19),
                });
            }
            return new PbhTile { Id = id, Frame = frame, Buildings = buildings, RingSizes = ringSizes, Verts = verts };
        }
    }
}

#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using Retro.Game;
using Xunit;

namespace Retro.Golden.Tests;

/// <summary>
/// The reference CPU rasteriser on cases whose browser output is exact and
/// can be worked out by hand: 1-px spans, odd and even line widths,
/// fillRect, strokeRect outlines, a clip, and glyphs from the real atlases.
/// </summary>
public class CanvasRasterizerTests
{
    private static readonly Dictionary<HudFont, RgbaImage> Atlases = new();

    private static RgbaImage Atlas(HudFont font)
    {
        lock (Atlases)
        {
            if (!Atlases.TryGetValue(font, out RgbaImage? img))
            {
                string path = Path.Combine(Golden.Root, "..", "..", font.Atlas);
                img = Png.Decode(File.ReadAllBytes(path));
                Atlases[font] = img;
            }
            return img;
        }
    }

    private static RgbaImage Draw(int w, int h, Action<CanvasCommandPainter> paint)
    {
        var p = new CanvasCommandPainter(w, h);
        paint(p);
        var r = new CanvasRasterizer(w, h, Atlas);
        r.Run(p.Commands);
        return r.ToImage();
    }

    private static (byte r, byte g, byte b, byte a) At(RgbaImage img, int x, int y)
    {
        int o = (y * img.Width + x) * 4;
        return (img.Pixels[o], img.Pixels[o + 1], img.Pixels[o + 2], img.Pixels[o + 3]);
    }

    /// <summary>Every pixel is `expect(x, y)` (null = transparent).</summary>
    private static void AssertPixels(RgbaImage img, Func<int, int, (byte, byte, byte, byte)?> expect)
    {
        var bad = new List<string>();
        for (int y = 0; y < img.Height; y++)
        {
            for (int x = 0; x < img.Width; x++)
            {
                var want = expect(x, y) ?? ((byte)0, (byte)0, (byte)0, (byte)0);
                var got = At(img, x, y);
                if (got != want) bad.Add($"({x},{y}) want {want} got {got}");
            }
        }
        Assert.True(bad.Count == 0, string.Join("\n", bad.GetRange(0, Math.Min(20, bad.Count))));
    }

    private static readonly (byte, byte, byte, byte) Red = (255, 0, 0, 255);

    [Fact]
    public void OnePixelSpans()
    {
        var img = Draw(12, 12, p =>
        {
            p.SetColor("#ff0000");
            p.HLine(2, 5, 3);
            p.HLine(9, 7, 8);
            p.VLine(10, 6, 1);
            p.Line(0, 9, 3, 6);
        });
        AssertPixels(img, (x, y) =>
            (y == 3 && x >= 2 && x <= 5) || (y == 8 && x >= 7 && x <= 9) || (x == 10 && y >= 1 && y <= 6) || (x + y == 9 && x <= 3)
                ? Red : null);
    }

    [Fact]
    public void LineWidths()
    {
        // Width 2 straddles the row: full on y, half on y - 1 and y + 1. Width 3 is three full rows.
        var two = Draw(8, 8, p => { p.SetColor("#ff0000"); p.SetLineWidth(2); p.HLine(1, 4, 3); });
        AssertPixels(two, (x, y) => x >= 1 && x <= 4 && y >= 2 && y <= 4 ? (y == 3 ? Red : ((byte)255, (byte)0, (byte)0, (byte)128)) : null);
        var three = Draw(8, 8, p => { p.SetColor("#ff0000"); p.SetLineWidth(3); p.VLine(3, 1, 5); });
        AssertPixels(three, (x, y) => x >= 2 && x <= 4 && y >= 1 && y <= 5 ? Red : null);
    }

    [Fact]
    public void RectanglesFillAndStroke()
    {
        var img = Draw(16, 10, p =>
        {
            p.SetBackground("#00ff00");
            p.FillRect(1, 1, 3, 2);
            p.SetColor("#0000ff");
            p.Rectangle(6, 1, 5, 4);
            p.Rectangle(13, 1, 2, 2, true);
        });
        (byte, byte, byte, byte) green = (0, 255, 0, 255), blue = (0, 0, 255, 255);
        AssertPixels(img, (x, y) =>
        {
            if (x >= 1 && x <= 3 && y >= 1 && y <= 2) return green;
            if (x >= 6 && x <= 10 && y >= 1 && y <= 4 && (x == 6 || x == 10 || y == 1 || y == 4)) return blue;
            if (x >= 13 && x <= 14 && y >= 1 && y <= 2) return green;
            return null;
        });
    }

    [Fact]
    public void ClipRectangleIsOneShortAndClearRestores()
    {
        // ClipCanvasPainter.rectangle(x, y, w, h) clips to rect(x, y, w - 1, h - 1): pixels x..x+w-2.
        var img = Draw(10, 10, p =>
        {
            p.SetBackground("#ff0000");
            IClipPainter clip = p.Clip().Rectangle(2, 2, 4, 4).Clip();
            p.FillRect(0, 0, 10, 10);
            clip.Clear();
            p.FillRect(9, 9, 1, 1);
        });
        AssertPixels(img, (x, y) => (x >= 2 && x <= 4 && y >= 2 && y <= 4) || (x == 9 && y == 9) ? Red : null);
    }

    [Fact]
    public void UntintedAndTintedGlyphs()
    {
        foreach (HudFont font in new[] { HudFont.Small, HudFont.Medium, HudFont.Large })
        {
            RgbaImage atlas = Atlas(font);
            var (sx, sy) = HudFontAtlas.Coords('K', font.CharWidth, font.CharHeight);
            var (tx, ty) = HudFontAtlas.Coords('7', font.CharWidth, font.CharHeight);
            int cw = font.CharWidth, ch = font.CharHeight;
            var img = Draw(40, 20, p =>
            {
                p.Text(font, 1, 2, "K");
                p.Text(font, 20, 2, "7", "#ff0000");
            });
            int lit = 0;
            AssertPixels(img, (x, y) =>
            {
                if (x >= 1 && x < 1 + cw && y >= 2 && y < 2 + ch)
                {
                    var t = At(atlas, sx + x - 1, sy + y - 2);
                    if (t.a == 0) return null;
                    lit++;
                    return t;
                }
                if (x >= 20 && x < 20 + cw && y >= 2 && y < 2 + ch)
                {
                    var t = At(atlas, tx + x - 20, ty + y - 2);
                    return t.a == 0 ? null : Red;
                }
                return null;
            });
            Assert.True(lit > 3, $"{font.Id}: K has {lit} lit texels");
        }
    }

    [Fact]
    public void AlphaGlyphFromFillRects()
    {
        var img = Draw(8, 8, p => p.Text(HudFont.Small, 1, 1, "α", "#ff0000"));
        int[] rows = HudFontAtlas.AlphaGlyphRows;
        AssertPixels(img, (x, y) =>
        {
            int col = x - 1, row = y - 1;
            if (col < 0 || col > 2 || row < 0 || row > 4) return null;
            return ((rows[row] >> (2 - col)) & 1) != 0 ? Red : null;
        });
    }

    [Fact]
    public void SegmentQuadFollowsTheTransform()
    {
        var m = CanvasMatrix.Identity.Translated(10, 20).Rotated(Math.PI / 2).Scaled(2, 2);
        // hLine(0, 1, 0) in this frame: (0, .5) -> (2, .5), width 1 user = 2 px.
        var (x0, y0) = m.Apply(0, 0.5);
        var (x1, y1) = m.Apply(2, 0.5);
        var q = CanvasCommandPainter.SegmentQuad(x0, y0, x1, y1, 1, m);
        var expect = new[] { m.Apply(0, 0), m.Apply(2, 0), m.Apply(2, 1), m.Apply(0, 1) };
        for (int i = 0; i < 4; i++)
        {
            Assert.Equal(expect[i].Item1, q[i].x, 9);
            Assert.Equal(expect[i].Item2, q[i].y, 9);
        }
    }
}

/// <summary>Just enough PNG (8-bit indexed or RGBA, non-interlaced) for the font atlases.</summary>
public static class Png
{
    public static RgbaImage Decode(byte[] b)
    {
        int p = 8, w = 0, h = 0, colorType = 0;
        byte[] plte = Array.Empty<byte>(), trns = Array.Empty<byte>();
        var idat = new MemoryStream();
        while (p < b.Length)
        {
            int len = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
            string type = System.Text.Encoding.ASCII.GetString(b, p + 4, 4);
            var data = new ArraySegment<byte>(b, p + 8, len);
            switch (type)
            {
                case "IHDR":
                    w = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
                    h = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
                    if (data[8] != 8 || data[12] != 0) throw new NotSupportedException("bit depth / interlace");
                    colorType = data[9];
                    break;
                case "PLTE": plte = data.ToArray(); break;
                case "tRNS": trns = data.ToArray(); break;
                case "IDAT": idat.Write(b, p + 8, len); break;
            }
            p += 12 + len;
        }
        int bpp = colorType switch { 3 => 1, 6 => 4, _ => throw new NotSupportedException("colour type " + colorType) };
        idat.Position = 0;
        var raw = new MemoryStream();
        using (var z = new ZLibStream(idat, CompressionMode.Decompress)) z.CopyTo(raw);
        byte[] r = raw.ToArray();
        int stride = w * bpp;
        var prev = new byte[stride];
        var img = new RgbaImage(w, h);
        for (int y = 0; y < h; y++)
        {
            int ft = r[y * (stride + 1)];
            var line = new byte[stride];
            Array.Copy(r, y * (stride + 1) + 1, line, 0, stride);
            for (int x = 0; x < stride; x++)
            {
                int a = x >= bpp ? line[x - bpp] : 0, up = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
                int v = line[x];
                switch (ft)
                {
                    case 1: v += a; break;
                    case 2: v += up; break;
                    case 3: v += (a + up) / 2; break;
                    case 4:
                    {
                        int pp = a + up - c, pa = Math.Abs(pp - a), pb = Math.Abs(pp - up), pc = Math.Abs(pp - c);
                        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
                        break;
                    }
                }
                line[x] = (byte)v;
            }
            for (int x = 0; x < w; x++)
            {
                int o = (y * w + x) * 4;
                if (colorType == 3)
                {
                    int i = line[x];
                    img.Pixels[o] = plte[i * 3];
                    img.Pixels[o + 1] = plte[i * 3 + 1];
                    img.Pixels[o + 2] = plte[i * 3 + 2];
                    img.Pixels[o + 3] = i < trns.Length ? trns[i] : (byte)255;
                }
                else
                {
                    Array.Copy(line, x * 4, img.Pixels, o, 4);
                }
            }
            prev = line;
        }
        return img;
    }
}

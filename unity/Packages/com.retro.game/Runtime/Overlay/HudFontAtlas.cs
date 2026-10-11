using System;
using System.Collections.Generic;

namespace Retro.Game
{
    /// <summary>
    /// The glyph layout of the HUD font atlases (text.ts codeToCoords,
    /// HUDFontNumberMap, HUDFontLetterMap, ALPHA_GLYPH_ROWS), so a frontend can
    /// draw glyphs from the same PNGs.
    ///
    /// Each atlas is a grid of 8 columns by 5 rows of cells, a cell being the
    /// glyph plus one pixel of padding right and below: cell (col, row) has its
    /// glyph at (col * (charWidth + 1), row * (charHeight + 1)), charWidth by
    /// charHeight pixels. Atlases are square: small 32 x 32 (3 x 5 glyphs),
    /// medium 48 x 48 (5 x 8), large 64 x 64 (7 x 11). Glyph texels are opaque
    /// white (palette index 21 of an 8-bit indexed PNG), everything else fully
    /// transparent.
    ///
    /// Rows 0-3 hold A-Z (row-major, 8 per row, Z at (1, 3)); digits 0-5 sit at
    /// (2..7, 3), 6-9 at (0..3, 4); then '.' (4, 4), ':' (5, 4), '-' (6, 4) and
    /// a blank cell (7, 4) that every unmapped code draws.
    /// </summary>
    public static class HudFontAtlas
    {
        public const int Columns = 8;
        public const int Rows = 5;
        /// <summary>text.ts FONT_CHAR_PADDING.</summary>
        public const int CharPadding = 1;
        /// <summary>text.ts GREEK_SMALL_ALPHA: drawn from fillRects, not the atlas.</summary>
        public const char GreekSmallAlpha = 'α';
        /// <summary>text.ts ALPHA_GLYPH_ROWS: a 3 x 5 bitmap, most significant bit leftmost.</summary>
        public static readonly int[] AlphaGlyphRows = { 0b010, 0b101, 0b111, 0b101, 0b010 };
        public const int AlphaGlyphWidth = 3;

        private static readonly (int col, int row)[] NumberCells =
        {
            (2, 3), (3, 3), (4, 3), (5, 3), (6, 3), (7, 3), (0, 4), (1, 4), (2, 4), (3, 4),
        };

        /// <summary>The atlas PNG's size in pixels (read from assets/font-hud-*.png).</summary>
        public static (int width, int height) AtlasSize(HudFont font)
        {
            if (font == HudFont.Small) return (32, 32);
            if (font == HudFont.Medium) return (48, 48);
            if (font == HudFont.Large) return (64, 64);
            throw new ArgumentException("unknown font " + font?.Id);
        }

        /// <summary>The font by its text.ts id (HUD_SMALL, HUD_MEDIUM, HUD_LARGE).</summary>
        public static HudFont ById(string id) => id switch
        {
            "HUD_SMALL" => HudFont.Small,
            "HUD_MEDIUM" => HudFont.Medium,
            "HUD_LARGE" => HudFont.Large,
            _ => throw new ArgumentException("unknown font " + id),
        };

        /// <summary>
        /// text.ts codeToCoords, cell only. Bug-for-bug: the ranges are
        /// inclusive one past the end, so ':' (58) falls in the digit range,
        /// misses the map and draws the blank cell, not its own glyph at (5, 4);
        /// '[' (91) and '{' (123, folded to '[') draw blank the same way.
        /// </summary>
        public static (int col, int row) Cell(int code)
        {
            const int ascii0 = 48, bigA = 65, smallA = 97, letters = 26, numbers = 10;
            int c = code;
            if (c >= smallA && c <= smallA + letters)
            {
                c -= smallA - bigA;
            }
            if (c >= ascii0 && c <= ascii0 + numbers)
            {
                c -= ascii0;
                return c < numbers ? NumberCells[c] : (7, 4);
            }
            if (c >= bigA && c <= bigA + letters)
            {
                c -= bigA;
                return c < letters ? (c % Columns, c / Columns) : (7, 4);
            }
            if (c == 46) return (4, 4);
            if (c == 58) return (5, 4);
            if (c == 45) return (6, 4);
            return (7, 4);
        }

        /// <summary>text.ts codeToCoords: the glyph's top-left in the atlas.</summary>
        public static (int srcX, int srcY) Coords(int code, int charWidth, int charHeight)
        {
            var (col, row) = Cell(code);
            return (col * (charWidth + CharPadding), row * (charHeight + CharPadding));
        }
    }

    /// <summary>
    /// An atlas as drawImage sees it: the PNG itself (Tint null) or the tinted
    /// copy text.ts createColor makes. Tint is the colour string the copy was
    /// made with (the first spelling seen; the cache key is lower-cased).
    /// </summary>
    public sealed class HudAtlasImage
    {
        public readonly HudFont Font;
        public readonly string Tint;

        public HudAtlasImage(HudFont font, string tint)
        {
            Font = font;
            Tint = tint;
        }

        /// <summary>The label the golden streams use: atlas:&lt;font&gt; or tint:&lt;font&gt;:&lt;colour&gt;.</summary>
        public string Label => Tint == null ? "atlas:" + Font.Id : "tint:" + Font.Id + ":" + Tint;
    }

    /// <summary>
    /// text.ts TextRenderer over a <see cref="Canvas2D"/>: alignment, effects
    /// (SHADOW, BACKGROUND, BOLD), the alpha glyph from fillRects, and the
    /// tinted-atlas cache. Tinting itself (multiply then destination-in) is a
    /// frontend job; <see cref="Tints"/> records which copies the browser
    /// would have made, in order.
    /// </summary>
    public sealed class HudTextRenderer
    {
        private readonly Canvas2D ctx;
        private readonly Dictionary<HudFont, HudAtlasImage> sources = new Dictionary<HudFont, HudAtlasImage>();
        private readonly Dictionary<(HudFont, string), HudAtlasImage> tinted = new Dictionary<(HudFont, string), HudAtlasImage>();

        /// <summary>Every tinted copy made, in creation order.</summary>
        public readonly List<HudAtlasImage> Tints = new List<HudAtlasImage>();

        public HudTextRenderer(Canvas2D ctx, IEnumerable<string> colors = null)
        {
            this.ctx = ctx;
            var all = colors == null ? new List<string>() : new List<string>(colors);
            foreach (HudFont font in new[] { HudFont.Small, HudFont.Medium, HudFont.Large })
            {
                sources[font] = new HudAtlasImage(font, null);
                // onImageLoaded: the atlas is complete at once; later duplicates overwrite.
                foreach (string c in all)
                {
                    var img = new HudAtlasImage(font, c);
                    Tints.Add(img);
                    tinted[(font, c.ToLowerInvariant())] = img;
                }
            }
        }

        /// <summary>getColoredAtlas: the PNG for null or "", else the cached tinted copy.</summary>
        public HudAtlasImage Atlas(HudFont font, string color)
        {
            if (string.IsNullOrEmpty(color)) return sources[font];
            string key = color.ToLowerInvariant();
            if (!tinted.TryGetValue((font, key), out HudAtlasImage img))
            {
                img = new HudAtlasImage(font, color);
                Tints.Add(img);
                tinted[(font, key)] = img;
            }
            return img;
        }

        public void Text(HudFont font, double x, double y, string text, string color, TextAlignment alignment,
            TextEffect effect = TextEffect.None, string effectColor = "")
        {
            int charWidth = font.CharWidth;
            int charHeight = font.CharHeight;
            int charSpacing = font.CharSpacing;
            HudAtlasImage src = Atlas(font, color);
            int n = text.Length;
            double x0 = x;
            if (alignment == TextAlignment.Right)
            {
                x0 = x - n * charWidth - (n - 1) * charSpacing;
            }
            else if (alignment == TextAlignment.Center)
            {
                x0 = x - Math.Floor((n * charWidth + (n - 1) * charSpacing) / 2.0);
            }

            if (effect == TextEffect.Background)
            {
                ctx.FillStyle = effectColor;
                ctx.FillRect(x0 - 1, y - 1, n * (charWidth + charSpacing) + 1, charHeight + 2);
            }

            for (int i = 0; i < n; i++)
            {
                char c = text[i];
                double dstX = x0 + i * (charWidth + charSpacing);

                if (c == HudFontAtlas.GreekSmallAlpha)
                {
                    DrawAlphaGlyph(dstX, y, charWidth, charHeight, color, effect, effectColor);
                    continue;
                }

                var (srcX, srcY) = HudFontAtlas.Coords(c, charWidth, charHeight);

                if (effect == TextEffect.Shadow)
                {
                    ctx.DrawImage(Atlas(font, effectColor), srcX, srcY, charWidth, charHeight, dstX + 1, y + 1, charWidth, charHeight);
                }
                if (effect == TextEffect.Bold)
                {
                    ctx.DrawImage(src, srcX, srcY, charWidth, charHeight, dstX + 1, y, charWidth, charHeight);
                    ctx.DrawImage(src, srcX, srcY, charWidth, charHeight, dstX, y + 1, charWidth, charHeight);
                }
                ctx.DrawImage(src, srcX, srcY, charWidth, charHeight, dstX, y, charWidth, charHeight);
            }
        }

        private void DrawAlphaGlyph(double x, double y, int charWidth, int charHeight, string color, TextEffect effect, string effectColor)
        {
            int glyphWidth = HudFontAtlas.AlphaGlyphWidth;
            int[] rows = HudFontAtlas.AlphaGlyphRows;
            int glyphHeight = rows.Length;
            int pixelW = Math.Max(1, charWidth / glyphWidth);
            int pixelH = Math.Max(1, charHeight / glyphHeight);
            int offsetX = (charWidth - pixelW * glyphWidth) / 2;
            int offsetY = (charHeight - pixelH * glyphHeight) / 2;

            void DrawAt(int dx, int dy, string fill)
            {
                ctx.FillStyle = fill;
                for (int row = 0; row < glyphHeight; row++)
                {
                    int bits = rows[row];
                    for (int col = 0; col < glyphWidth; col++)
                    {
                        if (((bits >> (glyphWidth - 1 - col)) & 1) != 0)
                        {
                            ctx.FillRect(x + offsetX + col * pixelW + dx, y + offsetY + row * pixelH + dy, pixelW, pixelH);
                        }
                    }
                }
            }

            string f = string.IsNullOrEmpty(color) ? "#ffffff" : color;
            if (effect == TextEffect.Shadow)
            {
                DrawAt(1, 1, effectColor);
            }
            if (effect == TextEffect.Bold)
            {
                DrawAt(1, 0, f);
                DrawAt(0, 1, f);
            }
            DrawAt(0, 0, f);
        }
    }
}

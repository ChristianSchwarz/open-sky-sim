using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

namespace Retro.Game
{
    /// <summary>text.ts TextAlignment.</summary>
    public enum TextAlignment
    {
        Center,
        Left,
        Right,
    }

    /// <summary>text.ts TextEffect.</summary>
    public enum TextEffect
    {
        None,
        Shadow,
        Background,
        Bold,
    }

    /// <summary>
    /// text.ts Font: the three bitmap HUD fonts. The atlas is the PNG under
    /// assets/ (its layout and glyph mapping live in the text renderer).
    /// </summary>
    public sealed class HudFont
    {
        public static readonly HudFont Small = new HudFont("HUD_SMALL", "assets/font-hud-small.png", 3, 5, 1);
        public static readonly HudFont Medium = new HudFont("HUD_MEDIUM", "assets/font-hud-medium.png", 5, 8, 1);
        public static readonly HudFont Large = new HudFont("HUD_LARGE", "assets/font-hud-large.png", 7, 11, 1);

        public readonly string Id;
        public readonly string Atlas;
        public readonly int CharWidth;
        public readonly int CharHeight;
        public readonly int CharSpacing;

        private HudFont(string id, string atlas, int charWidth, int charHeight, int charSpacing)
        {
            Id = id;
            Atlas = atlas;
            CharWidth = charWidth;
            CharHeight = charHeight;
            CharSpacing = charSpacing;
        }
    }

    /// <summary>canvasPainter.ts BatchCanvasPainter: one stroked path of pixel spans, drawn on Commit.</summary>
    public interface IBatchPainter
    {
        IBatchPainter HLine(double x0, double x1, double y);
        IBatchPainter VLine(double x, double y0, double y1);
        IBatchPainter Line(double x0, double y0, double x1, double y1);
        /// <summary>The points define the hypotenuse: left to right fills the bottom, right to left the top.</summary>
        IBatchPainter RightTriangle(double x0, double y0, double x1, double y1);
        void Commit();
    }

    /// <summary>canvasPainter.ts ClipCanvasPainter: a clip path, applied by Clip, released by Clear.</summary>
    public interface IClipPainter
    {
        IClipPainter Rectangle(double x, double y, double width, double height);
        IClipPainter Circle(double x, double y, double radius);
        IClipPainter Clip();
        void Clear();
    }

    /// <summary>
    /// canvasPainter.ts CanvasPainter, as the overlay code calls it. Colours are
    /// CSS strings as the palette gives them ("#rrggbb"). Coordinates are canvas
    /// pixels, y down. The overlay ports draw through this and nothing else, so
    /// the same call stream can be recorded on both sides (golden tests) and
    /// rasterised by the Unity layer.
    /// </summary>
    public interface ICanvasPainter
    {
        void SetColor(string color);
        void SetBackground(string color);
        void SetTextEffect(TextEffect effect, string effectColor);
        void SetLineWidth(double width);
        /// <summary>The whole canvas when no rectangle is given.</summary>
        void Clear(double? x = null, double? y = null, double? width = null, double? height = null);
        void FillRect(double x, double y, double width, double height);
        void HLine(double x0, double x1, double y);
        void VLine(double x, double y0, double y1);
        void Line(double x0, double y0, double x1, double y1);
        void RightTriangle(double x0, double y0, double x1, double y1);
        void Rectangle(double x, double y, double width, double height, bool fill = false);
        void Circle(double x, double y, double radius, bool fill = false);
        /// <summary>Color null draws the atlas in its own (white) colour.</summary>
        void Text(HudFont font, double x, double y, string text, string color = null, TextAlignment alignment = TextAlignment.Left);
        /// <summary>A raster (an opaque handle the frontend knows how to draw), nearest-sampled.</summary>
        void Image(object image, double x, double y, double width, double height);
        void PushTransform(double originX, double originY, double rotation, double scale);
        void PopTransform();
        IBatchPainter Batch();
        IClipPainter Clip();
    }

    /// <summary>
    /// Records every call as an array [name, args...], the format of
    /// tools/golden/recordingPainter.ts: fonts by id, alignment and effect by
    /// their TS enum names, omitted optionals as null, images numbered by first
    /// appearance ("img0", "img1", ...).
    /// </summary>
    public sealed class RecordingPainter : ICanvasPainter, IBatchPainter, IClipPainter
    {
        public readonly List<object[]> Calls = new List<object[]>();
        private readonly Dictionary<object, string> images = new Dictionary<object, string>(ReferenceComparer.Instance);

        private sealed class ReferenceComparer : IEqualityComparer<object>
        {
            public static readonly ReferenceComparer Instance = new ReferenceComparer();
            public new bool Equals(object a, object b) => ReferenceEquals(a, b);
            public int GetHashCode(object o) => RuntimeHelpers.GetHashCode(o);
        }

        private void Add(params object[] call) => Calls.Add(call);

        public static string AlignmentName(TextAlignment a) => a switch
        {
            TextAlignment.Center => "CENTER",
            TextAlignment.Right => "RIGHT",
            _ => "LEFT",
        };

        public static string EffectName(TextEffect e) => e switch
        {
            TextEffect.Shadow => "SHADOW",
            TextEffect.Background => "BACKGROUND",
            TextEffect.Bold => "BOLD",
            _ => "NONE",
        };

        public void SetColor(string color) => Add("setColor", color);
        public void SetBackground(string color) => Add("setBackground", color);
        public void SetTextEffect(TextEffect effect, string effectColor) => Add("setTextEffect", EffectName(effect), effectColor);
        public void SetLineWidth(double width) => Add("setLineWidth", width);
        public void Clear(double? x = null, double? y = null, double? width = null, double? height = null) => Add("clear", x, y, width, height);
        public void FillRect(double x, double y, double width, double height) => Add("fillRect", x, y, width, height);
        public void HLine(double x0, double x1, double y) => Add("hLine", x0, x1, y);
        public void VLine(double x, double y0, double y1) => Add("vLine", x, y0, y1);
        public void Line(double x0, double y0, double x1, double y1) => Add("line", x0, y0, x1, y1);
        public void RightTriangle(double x0, double y0, double x1, double y1) => Add("rightTriangle", x0, y0, x1, y1);
        public void Rectangle(double x, double y, double width, double height, bool fill = false) => Add("rectangle", x, y, width, height, fill);
        public void Circle(double x, double y, double radius, bool fill = false) => Add("circle", x, y, radius, fill);

        public void Text(HudFont font, double x, double y, string text, string color = null, TextAlignment alignment = TextAlignment.Left) =>
            Add("text", font.Id, x, y, text, color, AlignmentName(alignment));

        public void Image(object image, double x, double y, double width, double height)
        {
            if (!images.TryGetValue(image, out string id))
            {
                id = "img" + images.Count;
                images[image] = id;
            }
            Add("image", id, x, y, width, height);
        }

        public void PushTransform(double originX, double originY, double rotation, double scale) => Add("pushTransform", originX, originY, rotation, scale);
        public void PopTransform() => Add("popTransform");

        public IBatchPainter Batch()
        {
            Add("batch");
            return this;
        }

        public IClipPainter Clip()
        {
            Add("clip");
            return this;
        }

        IBatchPainter IBatchPainter.HLine(double x0, double x1, double y)
        {
            Add("b.hLine", x0, x1, y);
            return this;
        }

        IBatchPainter IBatchPainter.VLine(double x, double y0, double y1)
        {
            Add("b.vLine", x, y0, y1);
            return this;
        }

        IBatchPainter IBatchPainter.Line(double x0, double y0, double x1, double y1)
        {
            Add("b.line", x0, y0, x1, y1);
            return this;
        }

        IBatchPainter IBatchPainter.RightTriangle(double x0, double y0, double x1, double y1)
        {
            Add("b.rightTriangle", x0, y0, x1, y1);
            return this;
        }

        void IBatchPainter.Commit() => Add("b.commit");

        IClipPainter IClipPainter.Rectangle(double x, double y, double width, double height)
        {
            Add("c.rectangle", x, y, width, height);
            return this;
        }

        IClipPainter IClipPainter.Circle(double x, double y, double radius)
        {
            Add("c.circle", x, y, radius);
            return this;
        }

        IClipPainter IClipPainter.Clip()
        {
            Add("c.clip");
            return this;
        }

        void IClipPainter.Clear() => Add("c.clear");
    }
}

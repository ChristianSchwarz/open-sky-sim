#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Retro.Game;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>
/// Replays tests/golden/canvas_painter.json: each scene's painter script
/// through CanvasCommandPainter, compared at the context level (every
/// CanvasRenderingContext2D call and assignment, exact), at the command level
/// (the mock context's browser-semantics interpretation, 1e-12) and by the
/// tinted atlases made.
/// </summary>
public class CanvasPainterTests
{
    private static readonly JsonElement Fx = Load("canvas_painter.json");

    public static IEnumerable<object[]> Scenes() =>
        Load("canvas_painter.json").GetProperty("scenes").EnumerateArray().Select(s => new object[] { s.GetProperty("name").GetString()! });

    private static JsonElement Scene(string name) =>
        Fx.GetProperty("scenes").EnumerateArray().First(s => s.GetProperty("name").GetString() == name);

    private static (CanvasCommandPainter painter, Canvas2D ctx) Run(JsonElement scene)
    {
        var ctx = new Canvas2D(scene.GetProperty("width").GetInt32(), scene.GetProperty("height").GetInt32())
        {
            Log = new List<object[]>(),
        };
        var colors = scene.GetProperty("textColors").EnumerateArray().Select(c => c.GetString()!).ToList();
        var painter = new CanvasCommandPainter(ctx, colors);
        var replay = new PainterReplay(painter);
        foreach (JsonElement call in scene.GetProperty("script").EnumerateArray()) replay.Apply(call);
        return (painter, ctx);
    }

    [Theory]
    [MemberData(nameof(Scenes))]
    public void ContextCallsMatch(string name)
    {
        JsonElement scene = Scene(name);
        var (_, ctx) = Run(scene);
        PainterCalls.AssertSame(scene.GetProperty("calls"), ctx.Log!, name);
    }

    [Theory]
    [MemberData(nameof(Scenes))]
    public void CommandsMatch(string name)
    {
        JsonElement scene = Scene(name);
        var (_, ctx) = Run(scene);
        var flat = ctx.Commands.Select(c => CanvasCommandFormat.ToCall(c, ctx)).ToList();
        PainterCalls.AssertSame(scene.GetProperty("commands"), flat, name, 1e-12);
    }

    [Theory]
    [MemberData(nameof(Scenes))]
    public void TintsMatch(string name)
    {
        JsonElement scene = Scene(name);
        var (painter, _) = Run(scene);
        var tints = scene.GetProperty("tints").EnumerateArray().ToList();
        Assert.Equal(tints.Count, painter.TextRenderer.Tints.Count);
        for (int i = 0; i < tints.Count; i++)
        {
            HudAtlasImage t = painter.TextRenderer.Tints[i];
            var (w, h) = HudFontAtlas.AtlasSize(t.Font);
            Assert.Equal(tints[i].GetProperty("font").GetString(), t.Font.Id);
            Assert.Equal(tints[i].GetProperty("color").GetString(), t.Tint);
            Assert.Equal(tints[i].GetProperty("width").GetInt32(), w);
            Assert.Equal(tints[i].GetProperty("height").GetInt32(), h);
            // text.ts createColor, the recipe a frontend's tint must reproduce.
            string src = "atlas:" + t.Font.Id;
            var recipe = new List<object[]>
            {
                new object[] { "drawImage", src, 0.0, 0.0 },
                new object[] { "set", "fillStyle", t.Tint },
                new object[] { "set", "globalCompositeOperation", "multiply" },
                new object[] { "fillRect", 0.0, 0.0, (double)w, (double)h },
                new object[] { "set", "globalCompositeOperation", "destination-in" },
                new object[] { "drawImage", src, 0.0, 0.0 },
            };
            PainterCalls.AssertSame(tints[i].GetProperty("calls"), recipe, $"{name} tint {i}");
        }
    }

    [Fact]
    public void FontAtlasSizes()
    {
        foreach (JsonElement f in Fx.GetProperty("fonts").EnumerateArray())
        {
            HudFont font = HudFontAtlas.ById(f.GetProperty("id").GetString()!);
            var (w, h) = HudFontAtlas.AtlasSize(font);
            Assert.Equal(f.GetProperty("width").GetInt32(), w);
            Assert.Equal(f.GetProperty("height").GetInt32(), h);
            Assert.Equal(f.GetProperty("atlas").GetString(), font.Atlas);
            Assert.Equal(f.GetProperty("charWidth").GetInt32(), font.CharWidth);
            Assert.Equal(f.GetProperty("charHeight").GetInt32(), font.CharHeight);
            // The 8 x 5 grid fits the atlas.
            Assert.True(HudFontAtlas.Columns * (font.CharWidth + 1) <= w);
            Assert.True(HudFontAtlas.Rows * (font.CharHeight + 1) <= h);
        }
    }

    [Fact]
    public void GlyphCells()
    {
        Assert.Equal((0, 0), HudFontAtlas.Cell('A'));
        Assert.Equal((0, 0), HudFontAtlas.Cell('a'));
        Assert.Equal((1, 3), HudFontAtlas.Cell('Z'));
        Assert.Equal((2, 3), HudFontAtlas.Cell('0'));
        Assert.Equal((3, 4), HudFontAtlas.Cell('9'));
        Assert.Equal((4, 4), HudFontAtlas.Cell('.'));
        Assert.Equal((6, 4), HudFontAtlas.Cell('-'));
        // Bug-for-bug: ':' lands in the digit range and draws blank.
        Assert.Equal((7, 4), HudFontAtlas.Cell(':'));
        Assert.Equal((7, 4), HudFontAtlas.Cell('['));
        Assert.Equal((7, 4), HudFontAtlas.Cell('{'));
        Assert.Equal((7, 4), HudFontAtlas.Cell(' '));
        Assert.Equal((28, 0), HudFontAtlas.Coords('H', 3, 5));
        Assert.Equal((12, 18), HudFontAtlas.Coords('S', 5, 8));
    }
}

/// <summary>Applies RecordingPainter-format calls (JSON) to an ICanvasPainter.</summary>
public sealed class PainterReplay
{
    private readonly ICanvasPainter painter;
    private IBatchPainter? batch;
    private IClipPainter? clip;
    private readonly Dictionary<string, object> images = new();

    public PainterReplay(ICanvasPainter painter) => this.painter = painter;

    private static TextAlignment Align(string s) => s switch
    {
        "CENTER" => TextAlignment.Center,
        "RIGHT" => TextAlignment.Right,
        _ => TextAlignment.Left,
    };

    private static TextEffect Effect(string s) => s switch
    {
        "SHADOW" => TextEffect.Shadow,
        "BACKGROUND" => TextEffect.Background,
        "BOLD" => TextEffect.Bold,
        _ => TextEffect.None,
    };

    public void Apply(JsonElement call)
    {
        JsonElement[] a = call.EnumerateArray().ToArray();
        string name = a[0].GetString()!;
        double N(int i) => a[i].GetDouble();
        string? S(int i) => a[i].ValueKind == JsonValueKind.Null ? null : a[i].GetString();
        switch (name)
        {
            case "setColor": painter.SetColor(S(1)!); break;
            case "setBackground": painter.SetBackground(S(1)!); break;
            case "setTextEffect": painter.SetTextEffect(Effect(S(1)!), S(2)!); break;
            case "setLineWidth": painter.SetLineWidth(N(1)); break;
            case "clear":
                if (a[1].ValueKind == JsonValueKind.Null) painter.Clear();
                else painter.Clear(N(1), N(2), N(3), N(4));
                break;
            case "fillRect": painter.FillRect(N(1), N(2), N(3), N(4)); break;
            case "hLine": painter.HLine(N(1), N(2), N(3)); break;
            case "vLine": painter.VLine(N(1), N(2), N(3)); break;
            case "line": painter.Line(N(1), N(2), N(3), N(4)); break;
            case "rightTriangle": painter.RightTriangle(N(1), N(2), N(3), N(4)); break;
            case "rectangle": painter.Rectangle(N(1), N(2), N(3), N(4), a[5].GetBoolean()); break;
            case "circle": painter.Circle(N(1), N(2), N(3), a[4].GetBoolean()); break;
            case "text": painter.Text(HudFontAtlas.ById(S(1)!), N(2), N(3), S(4)!, S(5), Align(S(6)!)); break;
            case "image":
            {
                string id = S(1)!;
                if (!images.TryGetValue(id, out object? img))
                {
                    img = new object();
                    images[id] = img;
                }
                painter.Image(img, N(2), N(3), N(4), N(5));
                break;
            }
            case "pushTransform": painter.PushTransform(N(1), N(2), N(3), N(4)); break;
            case "popTransform": painter.PopTransform(); break;
            case "batch": batch = painter.Batch(); break;
            case "b.hLine": batch!.HLine(N(1), N(2), N(3)); break;
            case "b.vLine": batch!.VLine(N(1), N(2), N(3)); break;
            case "b.line": batch!.Line(N(1), N(2), N(3), N(4)); break;
            case "b.rightTriangle": batch!.RightTriangle(N(1), N(2), N(3), N(4)); break;
            case "b.commit": batch!.Commit(); break;
            case "clip": clip = painter.Clip(); break;
            case "c.rectangle": clip!.Rectangle(N(1), N(2), N(3), N(4)); break;
            case "c.circle": clip!.Circle(N(1), N(2), N(3)); break;
            case "c.clip": clip!.Clip(); break;
            case "c.clear": clip!.Clear(); break;
            default: throw new InvalidOperationException("unknown painter call " + name);
        }
    }
}

/// <summary>CanvasCommands as the flat arrays of tools/golden/mockContext2d.ts.</summary>
public static class CanvasCommandFormat
{
    private static IEnumerable<object> M(CanvasMatrix m) => new object[] { m.A, m.B, m.C, m.D, m.E, m.F };

    private static IEnumerable<object> Shapes(PathShape[] shapes)
    {
        yield return (double)shapes.Length;
        foreach (PathShape s in shapes)
        {
            switch (s.Kind)
            {
                case PathShapeKind.Segment:
                    yield return "seg"; yield return s.X0; yield return s.Y0; yield return s.X1; yield return s.Y1;
                    break;
                case PathShapeKind.Rect:
                    yield return "rect"; yield return s.X; yield return s.Y; yield return s.W; yield return s.H;
                    foreach (object o in M(s.M)) yield return o;
                    break;
                case PathShapeKind.Arc:
                    yield return "arc"; yield return s.Cx; yield return s.Cy; yield return s.R; yield return s.Start; yield return s.End; yield return s.Ccw;
                    foreach (object o in M(s.M)) yield return o;
                    break;
            }
        }
    }

    public static object[] ToCall(CanvasCommand c, Canvas2D ctx)
    {
        var o = new List<object?>();
        switch (c)
        {
            case ClearRectCommand k: o.AddRange(new object[] { "clearRect", k.X, k.Y, k.W, k.H }); o.AddRange(M(k.M)); break;
            case FillRectCommand k: o.AddRange(new object[] { "fillRect", k.Color, k.X, k.Y, k.W, k.H }); o.AddRange(M(k.M)); break;
            case StrokeRectCommand k: o.AddRange(new object[] { "strokeRect", k.Color, k.LineWidth, k.X, k.Y, k.W, k.H }); o.AddRange(M(k.M)); break;
            case StrokePathCommand k: o.AddRange(new object[] { "strokePath", k.Color, k.LineWidth }); o.AddRange(M(k.M)); o.AddRange(Shapes(k.Shapes)); break;
            case FillPathCommand k: o.AddRange(new object[] { "fillPath", k.Color }); o.AddRange(M(k.M)); o.AddRange(Shapes(k.Shapes)); break;
            case GlyphCommand k:
                o.AddRange(new object?[] { "glyph", k.Font.Id, k.Tint, k.Sx, k.Sy, k.Sw, k.Sh, k.Dx, k.Dy, k.Dw, k.Dh, k.Smooth });
                o.AddRange(M(k.M));
                break;
            case ImageCommand k:
                o.AddRange(new object[] { "image", ctx.LabelOf(k.Image), k.Dx, k.Dy, k.Dw, k.Dh, k.Smooth });
                o.AddRange(M(k.M));
                break;
            case ClipPushCommand k: o.Add("clipPush"); o.AddRange(Shapes(k.Shapes)); break;
            case ClipPopCommand _: o.Add("clipPop"); break;
        }
        return o.ToArray()!;
    }
}

using System;
using System.Collections.Generic;
using System.Text.Json;
using Xunit;

namespace Retro.Golden.Tests;

/// <summary>
/// Compares a Retro.Game.RecordingPainter call list with one recorded by
/// tools/golden/recordingPainter.ts: same calls in the same order, strings and
/// booleans exact, numbers within a relative tolerance (exact by default),
/// null for omitted optionals.
/// </summary>
public static class PainterCalls
{
    public static void AssertSame(JsonElement expected, IReadOnlyList<object[]> actual, string label, double tolerance = 0)
    {
        int n = expected.GetArrayLength();
        int i = 0;
        foreach (JsonElement call in expected.EnumerateArray())
        {
            Assert.True(i < actual.Count, $"{label}: missing call #{i} {call}");
            object[] a = actual[i];
            int argc = call.GetArrayLength();
            Assert.True(argc == a.Length, $"{label}: call #{i} expected {call}, got {Show(a)}");
            int j = 0;
            foreach (JsonElement arg in call.EnumerateArray())
            {
                object v = a[j];
                string where = $"{label}: call #{i} arg {j} (expected {call}, got {Show(a)})";
                switch (arg.ValueKind)
                {
                    case JsonValueKind.Null:
                        Assert.True(v == null, where);
                        break;
                    case JsonValueKind.String:
                        Assert.True(v is string s && s == arg.GetString(), where);
                        break;
                    case JsonValueKind.True:
                    case JsonValueKind.False:
                        Assert.True(v is bool b && b == arg.GetBoolean(), where);
                        break;
                    case JsonValueKind.Number:
                    {
                        double e = arg.GetDouble();
                        double g = Convert.ToDouble(v);
                        double diff = Math.Abs(e - g);
                        Assert.True(diff <= tolerance * Math.Max(1, Math.Abs(e)), where);
                        break;
                    }
                    default:
                        Assert.Fail($"{where}: unexpected JSON {arg.ValueKind}");
                        break;
                }
                j++;
            }
            i++;
        }
        Assert.True(actual.Count == n, $"{label}: {actual.Count - n} extra calls, first {(actual.Count > n ? Show(actual[n]) : "")}");
    }

    public static string Show(object[] call) => "[" + string.Join(", ", Array.ConvertAll(call, o => o switch
    {
        null => "null",
        string s => "\"" + s + "\"",
        bool b => b ? "true" : "false",
        IFormattable f => f.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
        _ => o.ToString(),
    })) + "]";
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Retro.Core
{
    public enum JsonKind
    {
        Null,
        Bool,
        Number,
        String,
        Array,
        Object,
    }

    /// <summary>
    /// A parsed JSON value: what JSON.parse gives the TS game, for the data
    /// files Unity's JsonUtility cannot read (nested arrays, nullable fields).
    /// Numbers are doubles, parsed correctly rounded as JSON.parse does.
    /// </summary>
    public sealed class JsonValue
    {
        public static readonly JsonValue Null = new JsonValue(JsonKind.Null);

        public readonly JsonKind Kind;
        private readonly bool boolean;
        private readonly double number;
        private readonly string text;
        private readonly List<JsonValue> items;
        private readonly Dictionary<string, JsonValue> fields;
        private readonly List<string> order;

        private JsonValue(JsonKind kind, bool b = false, double n = 0, string s = null,
            List<JsonValue> a = null, Dictionary<string, JsonValue> o = null, List<string> keys = null)
        {
            Kind = kind;
            boolean = b;
            number = n;
            text = s;
            items = a;
            fields = o;
            order = keys;
        }

        public bool IsNull => Kind == JsonKind.Null;
        public bool AsBool => Kind == JsonKind.Bool ? boolean : throw Wrong(JsonKind.Bool);
        public double AsNumber => Kind == JsonKind.Number ? number : throw Wrong(JsonKind.Number);
        public int AsInt => (int)AsNumber;
        public string AsString => Kind == JsonKind.String ? text : throw Wrong(JsonKind.String);
        public IReadOnlyList<JsonValue> Items => Kind == JsonKind.Array ? items : throw Wrong(JsonKind.Array);
        /// <summary>Object keys in document order.</summary>
        public IReadOnlyList<string> Keys => Kind == JsonKind.Object ? order : throw Wrong(JsonKind.Object);
        public int Count => Kind == JsonKind.Array ? items.Count : Kind == JsonKind.Object ? order.Count : 0;

        /// <summary>A field, or <see cref="Null"/> when absent (like reading an undefined property).</summary>
        public JsonValue this[string key] =>
            Kind == JsonKind.Object && fields.TryGetValue(key, out JsonValue v) ? v : Null;

        public JsonValue this[int index] => Items[index];

        public bool Has(string key) => Kind == JsonKind.Object && fields.ContainsKey(key);

        /// <summary>The number, or `fallback` for null/absent (`?? fallback`).</summary>
        public double Num(double fallback) => Kind == JsonKind.Number ? number : fallback;
        public double? OptNum => Kind == JsonKind.Number ? number : (double?)null;
        public string Str(string fallback) => Kind == JsonKind.String ? text : fallback;
        public bool Bool(bool fallback) => Kind == JsonKind.Bool ? boolean : fallback;

        /// <summary>An array of numbers (null elements become NaN).</summary>
        public double[] Numbers()
        {
            var output = new double[Items.Count];
            for (int i = 0; i < output.Length; i++) output[i] = items[i].Num(double.NaN);
            return output;
        }

        /// <summary>An array of number arrays, e.g. `[[lat, lon], ...]`.</summary>
        public double[][] NumberRows()
        {
            var output = new double[Items.Count][];
            for (int i = 0; i < output.Length; i++) output[i] = items[i].Numbers();
            return output;
        }

        private InvalidOperationException Wrong(JsonKind wanted) =>
            new InvalidOperationException($"JSON value is {Kind}, not {wanted}");

        internal static JsonValue Of(bool b) => new JsonValue(JsonKind.Bool, b: b);
        internal static JsonValue Of(double n) => new JsonValue(JsonKind.Number, n: n);
        internal static JsonValue Of(string s) => new JsonValue(JsonKind.String, s: s);
        internal static JsonValue Of(List<JsonValue> a) => new JsonValue(JsonKind.Array, a: a);
        internal static JsonValue Of(Dictionary<string, JsonValue> o, List<string> keys) =>
            new JsonValue(JsonKind.Object, o: o, keys: keys);
    }

    /// <summary>A strict RFC 8259 parser (no comments, no trailing commas), like JSON.parse.</summary>
    public static class JsonReader
    {
        public static JsonValue Parse(string json)
        {
            int i = 0;
            JsonValue v = ParseValue(json, ref i);
            SkipWhite(json, ref i);
            if (i != json.Length) throw Error(json, i, "trailing characters");
            return v;
        }

        private static void SkipWhite(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
        }

        private static FormatException Error(string s, int i, string what) =>
            new FormatException($"JSON: {what} at offset {i}");

        private static JsonValue ParseValue(string s, ref int i)
        {
            SkipWhite(s, ref i);
            if (i >= s.Length) throw Error(s, i, "unexpected end");
            char c = s[i];
            switch (c)
            {
                case '{': return ParseObject(s, ref i);
                case '[': return ParseArray(s, ref i);
                case '"': return JsonValue.Of(ParseString(s, ref i));
                case 't': Expect(s, ref i, "true"); return JsonValue.Of(true);
                case 'f': Expect(s, ref i, "false"); return JsonValue.Of(false);
                case 'n': Expect(s, ref i, "null"); return JsonValue.Null;
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return JsonValue.Of(ParseNumber(s, ref i));
                    throw Error(s, i, $"unexpected '{c}'");
            }
        }

        private static void Expect(string s, ref int i, string word)
        {
            if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) throw Error(s, i, "bad literal");
            i += word.Length;
        }

        private static JsonValue ParseObject(string s, ref int i)
        {
            i++;
            var fields = new Dictionary<string, JsonValue>();
            var keys = new List<string>();
            SkipWhite(s, ref i);
            if (i < s.Length && s[i] == '}')
            {
                i++;
                return JsonValue.Of(fields, keys);
            }
            while (true)
            {
                SkipWhite(s, ref i);
                if (i >= s.Length || s[i] != '"') throw Error(s, i, "expected a key");
                string key = ParseString(s, ref i);
                SkipWhite(s, ref i);
                if (i >= s.Length || s[i] != ':') throw Error(s, i, "expected ':'");
                i++;
                JsonValue v = ParseValue(s, ref i);
                // JSON.parse keeps the last of a duplicated key, in the first one's place.
                if (!fields.ContainsKey(key)) keys.Add(key);
                fields[key] = v;
                SkipWhite(s, ref i);
                if (i < s.Length && s[i] == ',')
                {
                    i++;
                    continue;
                }
                if (i < s.Length && s[i] == '}')
                {
                    i++;
                    return JsonValue.Of(fields, keys);
                }
                throw Error(s, i, "expected ',' or '}'");
            }
        }

        private static JsonValue ParseArray(string s, ref int i)
        {
            i++;
            var items = new List<JsonValue>();
            SkipWhite(s, ref i);
            if (i < s.Length && s[i] == ']')
            {
                i++;
                return JsonValue.Of(items);
            }
            while (true)
            {
                items.Add(ParseValue(s, ref i));
                SkipWhite(s, ref i);
                if (i < s.Length && s[i] == ',')
                {
                    i++;
                    continue;
                }
                if (i < s.Length && s[i] == ']')
                {
                    i++;
                    return JsonValue.Of(items);
                }
                throw Error(s, i, "expected ',' or ']'");
            }
        }

        private static string ParseString(string s, ref int i)
        {
            i++;
            var sb = new StringBuilder();
            while (true)
            {
                if (i >= s.Length) throw Error(s, i, "unterminated string");
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c < ' ') throw Error(s, i - 1, "control character in string");
                if (c != '\\')
                {
                    sb.Append(c);
                    continue;
                }
                if (i >= s.Length) throw Error(s, i, "bad escape");
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw Error(s, i, "bad \\u escape");
                        int code = 0;
                        for (int k = 0; k < 4; k++)
                        {
                            int h = HexDigit(s[i + k]);
                            if (h < 0) throw Error(s, i + k, "bad \\u escape");
                            code = code * 16 + h;
                        }
                        sb.Append((char)code);
                        i += 4;
                        break;
                    default: throw Error(s, i, "bad escape");
                }
            }
        }

        private static int HexDigit(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        }

        private static bool IsDigit(string s, int i) => i < s.Length && s[i] >= '0' && s[i] <= '9';

        /// <summary>
        /// The RFC 8259 number grammar exactly, as JSON.parse takes it: no
        /// leading zeros, '+', bare '.', or hex. Too large a magnitude is
        /// +-Infinity, as in JS.
        /// </summary>
        private static double ParseNumber(string s, ref int i)
        {
            int start = i;
            if (s[i] == '-') i++;
            if (!IsDigit(s, i)) throw Error(s, i, "bad number");
            if (s[i] == '0') i++;
            else while (IsDigit(s, i)) i++;
            if (i < s.Length && s[i] == '.')
            {
                i++;
                if (!IsDigit(s, i)) throw Error(s, i, "bad number");
                while (IsDigit(s, i)) i++;
            }
            if (i < s.Length && (s[i] == 'e' || s[i] == 'E'))
            {
                i++;
                if (i < s.Length && (s[i] == '+' || s[i] == '-')) i++;
                if (!IsDigit(s, i)) throw Error(s, i, "bad number");
                while (IsDigit(s, i)) i++;
            }
            string text = s.Substring(start, i - start);
            try
            {
                return double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture);
            }
            catch (OverflowException)
            {
                // Older runtimes throw where .NET Core 3+ (and JS) give Infinity.
                return text[0] == '-' ? double.NegativeInfinity : double.PositiveInfinity;
            }
        }
    }
}

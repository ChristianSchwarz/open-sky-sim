using System.Globalization;
using System.Text;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// JSON.stringify, for the few places the port has to write the exact
    /// text the web game would (the stored settings): object keys in the order
    /// written, numbers as Number.prototype.toString prints them (non-finite
    /// as null), strings escaped as JSON.stringify escapes them. System.Text.Json
    /// is not available to Unity's netstandard2.1, and its escaping differs.
    /// </summary>
    public sealed class JsJsonWriter
    {
        private readonly StringBuilder sb = new StringBuilder();
        // One flag per open container: whether a value was written in it yet.
        private readonly System.Collections.Generic.List<bool> open = new System.Collections.Generic.List<bool>();
        private bool afterKey;

        public override string ToString() => sb.ToString();

        public JsJsonWriter BeginObject()
        {
            Separate();
            sb.Append('{');
            open.Add(false);
            return this;
        }

        public JsJsonWriter EndObject()
        {
            sb.Append('}');
            open.RemoveAt(open.Count - 1);
            return this;
        }

        public JsJsonWriter BeginArray()
        {
            Separate();
            sb.Append('[');
            open.Add(false);
            return this;
        }

        public JsJsonWriter EndArray()
        {
            sb.Append(']');
            open.RemoveAt(open.Count - 1);
            return this;
        }

        public JsJsonWriter Key(string key)
        {
            Separate();
            AppendString(sb, key);
            sb.Append(':');
            afterKey = true;
            return this;
        }

        public JsJsonWriter String(string value)
        {
            Separate();
            if (value == null) sb.Append("null");
            else AppendString(sb, value);
            return this;
        }

        public JsJsonWriter Number(double value)
        {
            Separate();
            AppendNumber(sb, value);
            return this;
        }

        public JsJsonWriter Bool(bool value)
        {
            Separate();
            sb.Append(value ? "true" : "false");
            return this;
        }

        public JsJsonWriter Null()
        {
            Separate();
            sb.Append("null");
            return this;
        }

        /// <summary>A parsed value written back out (key order kept).</summary>
        public JsJsonWriter Value(JsonValue value)
        {
            switch (value.Kind)
            {
                case JsonKind.Null: return Null();
                case JsonKind.Bool: return Bool(value.AsBool);
                case JsonKind.Number: return Number(value.AsNumber);
                case JsonKind.String: return String(value.AsString);
                case JsonKind.Array:
                    BeginArray();
                    foreach (JsonValue item in value.Items) Value(item);
                    return EndArray();
                default:
                    BeginObject();
                    foreach (string key in value.Keys)
                    {
                        Key(key);
                        Value(value[key]);
                    }
                    return EndObject();
            }
        }

        private void Separate()
        {
            if (afterKey)
            {
                afterKey = false;
                return;
            }
            if (open.Count == 0) return;
            if (open[open.Count - 1]) sb.Append(',');
            open[open.Count - 1] = true;
        }

        /// <summary>JSON.stringify of a value: what <see cref="JsJsonWriter.Value"/> writes.</summary>
        public static string Stringify(JsonValue value) => new JsJsonWriter().Value(value).ToString();

        /// <summary>JSON.stringify(number): toString digits, null for NaN and the infinities.</summary>
        public static void AppendNumber(StringBuilder sb, double value)
        {
            sb.Append(JsText.IsFinite(value) ? JsText.NumberToString(value) : "null");
        }

        /// <summary>
        /// JSON.stringify(string) (ES2019, well-formed): " and \ escaped, the
        /// control characters as \b \t \n \f \r or \u00xx, lone surrogates as
        /// \udxxx, everything else as it is.
        /// </summary>
        public static void AppendString(StringBuilder sb, string s)
        {
            sb.Append('"');
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); continue;
                    case '\\': sb.Append("\\\\"); continue;
                    case '\b': sb.Append("\\b"); continue;
                    case '\t': sb.Append("\\t"); continue;
                    case '\n': sb.Append("\\n"); continue;
                    case '\f': sb.Append("\\f"); continue;
                    case '\r': sb.Append("\\r"); continue;
                }
                if (c < ' ')
                {
                    AppendEscape(sb, c);
                }
                else if (char.IsHighSurrogate(c))
                {
                    if (i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                    {
                        sb.Append(c).Append(s[i + 1]);
                        i++;
                    }
                    else
                    {
                        AppendEscape(sb, c);
                    }
                }
                else if (char.IsLowSurrogate(c))
                {
                    AppendEscape(sb, c);
                }
                else
                {
                    sb.Append(c);
                }
            }
            sb.Append('"');
        }

        private static void AppendEscape(StringBuilder sb, char c)
        {
            sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
        }
    }
}

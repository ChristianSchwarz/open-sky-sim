using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using System.Text;

namespace Retro.Game
{
    /// <summary>
    /// The JavaScript string and number conversions the ported game state
    /// relies on, where the C# namesakes differ: Number(string),
    /// Number.prototype.toString, toFixed, String.prototype.trim, the
    /// whitespace class of a JS regex, and the URL decoders.
    /// </summary>
    public static class JsText
    {
        /// <summary>
        /// The characters JS `\s` and `trim()` treat as space: WhiteSpace plus
        /// LineTerminator (tab, LF, VT, FF, CR, space, U+00A0, U+1680,
        /// U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF).
        /// Unlike .NET's `\s` this has U+FEFF and not U+0085. A regex
        /// character-class body, built from code points so no source file
        /// carries the raw characters.
        /// </summary>
        public static readonly string WhitespaceClass = new string(new[]
        {
            '\\', 't', '\\', 'n', '\\', 'v', '\\', 'f', '\\', 'r', ' ',
            (char)0x00a0, (char)0x1680, (char)0x2000, '-', (char)0x200a,
            (char)0x2028, (char)0x2029, (char)0x202f, (char)0x205f, (char)0x3000, (char)0xfeff,
        });

        public static bool IsWhitespace(char c)
        {
            switch (c)
            {
                case '\t': case '\n': case '\v': case '\f': case '\r': case ' ':
                case (char)0x00a0: case (char)0x1680: case (char)0x2028: case (char)0x2029:
                case (char)0x202f: case (char)0x205f: case (char)0x3000: case (char)0xfeff:
                    return true;
                default:
                    return c >= (char)0x2000 && c <= (char)0x200a;
            }
        }

        /// <summary>String.prototype.trim.</summary>
        public static string Trim(string s)
        {
            int start = 0, end = s.Length;
            while (start < end && IsWhitespace(s[start])) start++;
            while (end > start && IsWhitespace(s[end - 1])) end--;
            return s.Substring(start, end - start);
        }

        /// <summary>JS truthiness of a string: neither null (undefined) nor empty.</summary>
        public static bool Truthy(string s) => !string.IsNullOrEmpty(s);

        /// <summary>`a || b` on strings.</summary>
        public static string Or(string a, string b) => Truthy(a) ? a : b;

        /// <summary>`a || b` on numbers: 0 and NaN are falsy.</summary>
        public static double Or(double a, double b) => a != 0 && !double.IsNaN(a) ? a : b;

        /// <summary>Number(string): the StringToNumber conversion.</summary>
        public static double ToNumber(string s)
        {
            if (s == null)
            {
                return double.NaN;
            }
            string t = Trim(s);
            if (t.Length == 0)
            {
                return 0;
            }
            switch (t)
            {
                case "Infinity":
                case "+Infinity":
                    return double.PositiveInfinity;
                case "-Infinity":
                    return double.NegativeInfinity;
            }
            if (t.Length > 2 && t[0] == '0')
            {
                int radix = t[1] == 'x' || t[1] == 'X' ? 16 : t[1] == 'o' || t[1] == 'O' ? 8 : t[1] == 'b' || t[1] == 'B' ? 2 : 0;
                if (radix != 0)
                {
                    double v = 0;
                    for (int i = 2; i < t.Length; i++)
                    {
                        int d = DigitValue(t[i]);
                        if (d < 0 || d >= radix)
                        {
                            return double.NaN;
                        }
                        v = v * radix + d;
                    }
                    return v;
                }
            }
            if (!IsDecimalLiteral(t))
            {
                return double.NaN;
            }
            return double.Parse(t, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint | NumberStyles.AllowExponent,
                CultureInfo.InvariantCulture);
        }

        private static int DigitValue(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        }

        /// <summary>StrDecimalLiteral without the Infinity forms: [+-](digits[.digits]|.digits)[e[+-]digits].</summary>
        private static bool IsDecimalLiteral(string t)
        {
            int i = 0, n = t.Length;
            if (i < n && (t[i] == '+' || t[i] == '-')) i++;
            int intDigits = 0, fracDigits = 0;
            while (i < n && t[i] >= '0' && t[i] <= '9') { i++; intDigits++; }
            if (i < n && t[i] == '.')
            {
                i++;
                while (i < n && t[i] >= '0' && t[i] <= '9') { i++; fracDigits++; }
            }
            if (intDigits + fracDigits == 0) return false;
            if (i < n && (t[i] == 'e' || t[i] == 'E'))
            {
                i++;
                if (i < n && (t[i] == '+' || t[i] == '-')) i++;
                int expDigits = 0;
                while (i < n && t[i] >= '0' && t[i] <= '9') { i++; expDigits++; }
                if (expDigits == 0) return false;
            }
            return i == n;
        }

        /// <summary>Number.isFinite.</summary>
        public static bool IsFinite(double x) => !double.IsNaN(x) && !double.IsInfinity(x);

        /// <summary>
        /// Number.prototype.toString(): the shortest digits that round-trip
        /// (which .NET's "R" also produces), laid out by the ECMAScript rules.
        /// </summary>
        public static string NumberToString(double x)
        {
            if (double.IsNaN(x)) return "NaN";
            if (x == 0) return "0";
            if (double.IsPositiveInfinity(x)) return "Infinity";
            if (double.IsNegativeInfinity(x)) return "-Infinity";
            if (x < 0) return "-" + NumberToString(-x);

            string r = x.ToString("R", CultureInfo.InvariantCulture);
            int ePos = r.IndexOfAny(new[] { 'E', 'e' });
            string mantissa = ePos >= 0 ? r.Substring(0, ePos) : r;
            int exp = ePos >= 0 ? int.Parse(r.Substring(ePos + 1), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture) : 0;
            int dot = mantissa.IndexOf('.');
            string digits = dot >= 0 ? mantissa.Remove(dot, 1) : mantissa;
            int point = (dot >= 0 ? dot : mantissa.Length) + exp;
            int lead = 0;
            while (lead < digits.Length - 1 && digits[lead] == '0') lead++;
            digits = digits.Substring(lead);
            point -= lead;
            digits = digits.TrimEnd('0');
            if (digits.Length == 0) return "0";

            int k = digits.Length;
            int nExp = point;
            if (k <= nExp && nExp <= 21)
            {
                return digits + new string('0', nExp - k);
            }
            if (0 < nExp && nExp <= 21)
            {
                return digits.Substring(0, nExp) + "." + digits.Substring(nExp);
            }
            if (-6 < nExp && nExp <= 0)
            {
                return "0." + new string('0', -nExp) + digits;
            }
            int e = nExp - 1;
            string sign = e < 0 ? "-" : "+";
            string tail = "e" + sign + Math.Abs(e).ToString(CultureInfo.InvariantCulture);
            return k == 1 ? digits + tail : digits.Substring(0, 1) + "." + digits.Substring(1) + tail;
        }

        /// <summary>
        /// Number.prototype.toFixed: the exact binary value scaled by 10^digits
        /// and rounded half up in magnitude (1.25 -> "1.3", where .NET's "F1"
        /// gives "1.2"), with -0 shown as "0" but a negative that rounds to
        /// zero keeping its sign ("-0.00"). Done in BigInteger so ties are exact.
        /// </summary>
        public static string ToFixed(double x, int digits)
        {
            if (double.IsNaN(x)) return "NaN";
            if (Math.Abs(x) >= 1e21 || double.IsInfinity(x)) return NumberToString(x);
            bool negative = x < 0;
            if (negative) x = -x;
            long bits = BitConverter.DoubleToInt64Bits(x);
            int exponent = (int)((bits >> 52) & 0x7FF);
            long mantissa = bits & 0xFFFFFFFFFFFFFL;
            if (exponent == 0) exponent = 1;
            else mantissa |= 1L << 52;
            exponent -= 1075; // x = mantissa * 2^exponent
            BigInteger num = mantissa * BigInteger.Pow(10, digits);
            BigInteger den = BigInteger.One;
            if (exponent >= 0) num <<= exponent;
            else den <<= -exponent;
            BigInteger n = BigInteger.Divide(2 * num + den, 2 * den);
            string s = n.ToString(CultureInfo.InvariantCulture);
            if (digits > 0)
            {
                if (s.Length <= digits) s = new string('0', digits + 1 - s.Length) + s;
                s = s.Substring(0, s.Length - digits) + "." + s.Substring(s.Length - digits);
            }
            return negative ? "-" + s : s;
        }

        /// <summary>
        /// encodeURIComponent: everything but A-Z a-z 0-9 - _ . ! ~ * ' ( ) is
        /// UTF-8 percent-encoded (upper-case hex). A lone surrogate, where JS
        /// throws a URIError, gives null.
        /// </summary>
        public static string EncodeUriComponent(string s)
        {
            var sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || "-_.!~*'()".IndexOf(c) >= 0)
                {
                    sb.Append(c);
                    continue;
                }
                string unit;
                if (char.IsHighSurrogate(c))
                {
                    if (i + 1 >= s.Length || !char.IsLowSurrogate(s[i + 1])) return null;
                    unit = s.Substring(i, 2);
                    i++;
                }
                else if (char.IsLowSurrogate(c))
                {
                    return null;
                }
                else
                {
                    unit = c.ToString();
                }
                foreach (byte b in Encoding.UTF8.GetBytes(unit))
                {
                    sb.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
                }
            }
            return sb.ToString();
        }

        /// <summary>
        /// decodeURIComponent; null where JS would throw a URIError (a lone or
        /// malformed escape, or bytes that are not UTF-8).
        /// </summary>
        public static string DecodeUriComponent(string s)
        {
            if (s.IndexOf('%') < 0) return s;
            var sb = new StringBuilder(s.Length);
            var bytes = new List<byte>();
            var utf8 = new UTF8Encoding(false, true);
            int i = 0;
            while (i < s.Length)
            {
                if (s[i] != '%')
                {
                    sb.Append(s[i]);
                    i++;
                    continue;
                }
                bytes.Clear();
                while (i < s.Length && s[i] == '%')
                {
                    if (i + 2 >= s.Length) return null;
                    int hi = DigitValue(s[i + 1]), lo = DigitValue(s[i + 2]);
                    if (hi < 0 || lo < 0) return null;
                    bytes.Add((byte)(hi * 16 + lo));
                    i += 3;
                }
                try
                {
                    sb.Append(utf8.GetString(bytes.ToArray()));
                }
                catch (ArgumentException)
                {
                    return null;
                }
            }
            return sb.ToString();
        }

        /// <summary>
        /// The application/x-www-form-urlencoded parser URLSearchParams uses:
        /// split on '&amp;', drop empty pieces, split each at its first '=',
        /// '+' to space, lenient percent-decoding, UTF-8 with replacement.
        /// </summary>
        public static List<KeyValuePair<string, string>> ParseFormUrlEncoded(string input)
        {
            var list = new List<KeyValuePair<string, string>>();
            foreach (string piece in input.Split('&'))
            {
                if (piece.Length == 0) continue;
                int eq = piece.IndexOf('=');
                string name = eq >= 0 ? piece.Substring(0, eq) : piece;
                string value = eq >= 0 ? piece.Substring(eq + 1) : "";
                list.Add(new KeyValuePair<string, string>(FormDecode(name), FormDecode(value)));
            }
            return list;
        }

        private static string FormDecode(string s)
        {
            s = s.Replace('+', ' ');
            byte[] raw = Encoding.UTF8.GetBytes(s);
            var outBytes = new List<byte>(raw.Length);
            for (int i = 0; i < raw.Length; i++)
            {
                if (raw[i] == (byte)'%' && i + 2 < raw.Length
                    && DigitValue((char)raw[i + 1]) >= 0 && DigitValue((char)raw[i + 2]) >= 0)
                {
                    outBytes.Add((byte)(DigitValue((char)raw[i + 1]) * 16 + DigitValue((char)raw[i + 2])));
                    i += 2;
                }
                else
                {
                    outBytes.Add(raw[i]);
                }
            }
            return new UTF8Encoding(false, false).GetString(outBytes.ToArray());
        }
    }
}

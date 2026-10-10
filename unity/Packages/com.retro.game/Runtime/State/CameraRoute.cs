using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Retro.Game
{
    // Port of src/script/state/cameraRoute.ts: a fixed camera placed from the
    // page URL, written the way Google Maps writes a 3D view after `/maps/`:
    // `?@45.93,6.87,2500a,150h,85t` (the same works after a `#`). Latitude and
    // longitude first, then suffixed values: `a` metres above the ellipsoid
    // (`m` read the same), `h` bearing clockwise from north, `t` tilt with 0
    // straight down and 90 at the horizon. Other Maps suffixes (`y`, `z`, `d`,
    // `r`) are accepted and ignored. The older
    // `?lat=45.93&lng=6.87&alt=2500&hdg=150&pitch=-5` form, pitch being t - 90,
    // is still read.
    //
    // writeCameraRouteToLocation, cameraRouteFromLocation and
    // clearCameraRouteFromLocation (window.location / history.replaceState) are
    // not ported. The Unity layer supplies the launch URL or command line as a
    // search/hash pair for ParseCameraRoute, and where it can rewrite it, uses
    // SearchWithCameraRoute / WithoutRoute for the query.

    public sealed class CameraRoute : IEquatable<CameraRoute>
    {
        public double Lat;
        public double Lon;
        public double AltM;
        public double HeadingDeg;
        public double PitchDeg;

        public CameraRoute() { }

        public CameraRoute(double lat, double lon, double altM, double headingDeg, double pitchDeg)
        {
            Lat = lat;
            Lon = lon;
            AltM = altM;
            HeadingDeg = headingDeg;
            PitchDeg = pitchDeg;
        }

        public bool Equals(CameraRoute o) => o != null
            && Lat.Equals(o.Lat) && Lon.Equals(o.Lon) && AltM.Equals(o.AltM)
            && HeadingDeg.Equals(o.HeadingDeg) && PitchDeg.Equals(o.PitchDeg);

        public override bool Equals(object obj) => obj is CameraRoute r && Equals(r);
        public override int GetHashCode() => HashCode.Combine(Lat, Lon, AltM, HeadingDeg, PitchDeg);
        public override string ToString() => $"{{lat {Lat}, lon {Lon}, alt {AltM}, hdg {HeadingDeg}, pitch {PitchDeg}}}";
    }

    public static class CameraRoutes
    {
        /// <summary>The older named parameters, still read and dropped when the URL is rewritten.</summary>
        private static readonly string[] LegacyParams = { "lat", "lng", "alt", "hdg", "pitch" };
        private const double DefaultAltM = 1000;
        private const double PitchLimitDeg = 89;

        private static string StripHash(string hash) => hash.StartsWith("#", StringComparison.Ordinal) ? hash.Substring(1) : hash;

        /// <summary>URLSearchParams over the query, with fragment parameters the query lacks appended.</summary>
        private static List<KeyValuePair<string, string>> Params(string search, string hash)
        {
            List<KeyValuePair<string, string>> query = JsText.ParseFormUrlEncoded(StripLeadingQuestion(search));
            List<KeyValuePair<string, string>> fragment = JsText.ParseFormUrlEncoded(StripHash(hash));
            foreach (KeyValuePair<string, string> kv in fragment)
            {
                if (!Has(query, kv.Key))
                {
                    query.Add(kv);
                }
            }
            return query;
        }

        /// <summary>URLSearchParams drops one leading '?' from its init string.</summary>
        private static string StripLeadingQuestion(string s) => s.StartsWith("?", StringComparison.Ordinal) ? s.Substring(1) : s;

        private static bool Has(List<KeyValuePair<string, string>> p, string key) => p.Any(kv => kv.Key == key);

        private static string Get(List<KeyValuePair<string, string>> p, string key)
        {
            foreach (KeyValuePair<string, string> kv in p)
            {
                if (kv.Key == key) return kv.Value;
            }
            return null;
        }

        /// <summary>A parameter of ours: an `@` view or one of the legacy names.</summary>
        private static bool IsRouteParam(string key) =>
            key.StartsWith("@", StringComparison.Ordinal) || LegacyParams.Contains(key);

        private static double? Num(List<KeyValuePair<string, string>> p, string key)
        {
            string raw = Get(p, key);
            if (raw == null || JsText.Trim(raw) == "")
            {
                return null;
            }
            double n = JsText.ToNumber(raw);
            return JsText.IsFinite(n) ? n : double.NaN;
        }

        private sealed class RawRoute
        {
            public double Lat;
            public double Lon;
            public double? AltM;
            public double? HeadingDeg;
            public double? PitchDeg;
        }

        // /^\s*([-+]?\d*\.?\d+)([a-z])\s*$/i with JS's \s and ASCII \d; \z for JS's $.
        private static readonly Regex Token = new Regex(
            "^[" + JsText.WhitespaceClass + "]*([-+]?[0-9]*\\.?[0-9]+)([A-Za-z])[" + JsText.WhitespaceClass + "]*\\z",
            RegexOptions.CultureInvariant);

        /// <summary>`@lat,lng,2500a,150h,85t` as Google Maps writes it, or null.</summary>
        private static RawRoute ParseAtView(string view)
        {
            // A pasted Maps URL may carry its `/data=...` path segment along.
            string body = view.StartsWith("@", StringComparison.Ordinal) ? view.Substring(1) : view;
            int slash = body.IndexOf('/');
            string[] parts = (slash >= 0 ? body.Substring(0, slash) : body).Split(',');
            string latRaw = parts.Length > 0 ? parts[0] : null;
            string lonRaw = parts.Length > 1 ? parts[1] : null;
            if (latRaw == null || lonRaw == null || JsText.Trim(latRaw) == "" || JsText.Trim(lonRaw) == "")
            {
                return null;
            }
            var route = new RawRoute { Lat = JsText.ToNumber(latRaw), Lon = JsText.ToNumber(lonRaw) };
            for (int i = 2; i < parts.Length; i++)
            {
                Match m = Token.Match(parts[i]);
                if (!m.Success)
                {
                    return null;
                }
                double value = JsText.ToNumber(m.Groups[1].Value);
                switch (m.Groups[2].Value.ToLowerInvariant())
                {
                    case "a":
                    case "m":
                        route.AltM = value;
                        break;
                    case "h":
                        route.HeadingDeg = value;
                        break;
                    case "t":
                        route.PitchDeg = value - 90;
                        break;
                }
            }
            return route;
        }

        private static RawRoute ParseLegacy(List<KeyValuePair<string, string>> p)
        {
            double? lat = Num(p, "lat");
            double? lon = Num(p, "lng");
            if (lat == null || lon == null)
            {
                return null;
            }
            return new RawRoute
            {
                Lat = lat.Value,
                Lon = lon.Value,
                AltM = Num(p, "alt"),
                HeadingDeg = Num(p, "hdg"),
                PitchDeg = Num(p, "pitch"),
            };
        }

        /// <summary>The route in `search`/`hash`, or null when absent or malformed.</summary>
        public static CameraRoute ParseCameraRoute(string search, string hash = "")
        {
            List<KeyValuePair<string, string>> p = Params(search, hash);
            string view = p.Select(kv => kv.Key).FirstOrDefault(k => k.StartsWith("@", StringComparison.Ordinal));
            RawRoute raw = view != null ? ParseAtView(view) : ParseLegacy(p);
            if (raw == null)
            {
                return null;
            }
            double lat = raw.Lat, lon = raw.Lon;
            double altM = raw.AltM ?? DefaultAltM;
            double headingDeg = raw.HeadingDeg ?? 0;
            double pitchDeg = raw.PitchDeg ?? 0;
            if (new[] { lat, lon, altM, headingDeg, pitchDeg }.Any(n => !JsText.IsFinite(n)))
            {
                return null;
            }
            if (Math.Abs(lat) > 90 || Math.Abs(lon) > 180)
            {
                return null;
            }
            double heading = headingDeg >= 0 && headingDeg < 360 ? headingDeg : ((headingDeg % 360) + 360) % 360;
            double pitch = Math.Max(-PitchLimitDeg, Math.Min(PitchLimitDeg, pitchDeg));
            return new CameraRoute(lat, lon, altM, heading == 0 ? 0 : heading, pitch == 0 ? 0 : pitch);
        }

        /// <summary>(+n.toFixed(digits)).toString()</summary>
        private static string Fix(double n, int digits) => JsText.NumberToString(JsText.ToNumber(JsText.ToFixed(n, digits)));

        /// <summary>The route as Google Maps writes a view, `@45.93,6.87,2500a,150h,85t`.</summary>
        public static string FormatCameraRoute(CameraRoute route)
        {
            return "@" + Fix(route.Lat, 5) + "," + Fix(route.Lon, 5) + "," + Fix(route.AltM, 0) + "a,"
                + Fix(route.HeadingDeg, 0) + "h," + Fix(route.PitchDeg + 90, 0) + "t";
        }

        /// <summary>
        /// The page's query with the route set, written as-is (`@` and `,` are
        /// legal in a query). Other parameters are kept; any earlier route, in
        /// either form, is replaced.
        /// </summary>
        public static string SearchWithCameraRoute(string search, CameraRoute route)
        {
            string query = StripLeadingQuestion(search);
            var kept = query.Length > 0
                ? query.Split('&').Where(p => p.Length > 0 && !IsRouteParam(DecodeKey(p.Split('=')[0]))).ToList()
                : new List<string>();
            return "?" + string.Join("&", new[] { FormatCameraRoute(route) }.Concat(kept));
        }

        private static string DecodeKey(string key)
        {
            return JsText.DecodeUriComponent(key.Replace('+', ' ')) ?? key;
        }

        /// <summary>
        /// `params` without our route, in either form, serialised the way
        /// URLSearchParams.toString does - for the Unity layer rewriting a URL.
        /// </summary>
        public static string WithoutRoute(string query)
        {
            var p = JsText.ParseFormUrlEncoded(StripLeadingQuestion(query)).Where(kv => !IsRouteParam(kv.Key));
            return string.Join("&", p.Select(kv => FormEncode(kv.Key) + "=" + FormEncode(kv.Value)));
        }

        /// <summary>The application/x-www-form-urlencoded serializer: space to '+', keep *-._ and alphanumerics.</summary>
        private static string FormEncode(string s)
        {
            var sb = new System.Text.StringBuilder();
            foreach (byte b in System.Text.Encoding.UTF8.GetBytes(s))
            {
                char c = (char)b;
                if (c == ' ')
                {
                    sb.Append('+');
                }
                else if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '*' || c == '-' || c == '.' || c == '_')
                {
                    sb.Append(c);
                }
                else
                {
                    sb.Append('%').Append(b.ToString("X2", System.Globalization.CultureInfo.InvariantCulture));
                }
            }
            return sb.ToString();
        }
    }
}

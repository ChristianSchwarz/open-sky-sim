using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace Retro.Game
{
    // Port of src/script/state/spawnSearch.ts: finding somewhere to start a
    // flight - an airfield by ICAO, IATA or name, a place by name, or a bare
    // coordinate.
    //
    // Airfields are searched locally across every baked area. Places are
    // geocoded through OSM's Nominatim; that request (searchPlaces) is not
    // ported. The Unity layer must supply it: GET
    // https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=<encodeURIComponent(query)>
    // with Accept: application/json, only when the player submits a search
    // (never per keystroke), at most once per 1100 ms, a non-2xx status being a
    // failure; it parses the JSON into NominatimPlace records and hands them to
    // PlacesFromNominatim.
    //
    // Whatever is found is checked against the baked areas, because the sim can
    // only start where there is terrain; a hit outside them is still listed.

    /// <summary>One airfield as the search sees it.</summary>
    public sealed class AirfieldEntry
    {
        public string Icao = "";
        public string Iata = "";
        public string Name = "";
        public string Area = "";
        public double Lat;
        public double Lon;
        /// <summary>Longest runway, m.</summary>
        public double LengthM;
    }

    public enum SpawnDestinationKind
    {
        Airfield,
        Place,
        Coordinates,
    }

    /// <summary>Somewhere a flight can be started from, or found but not startable.</summary>
    public sealed class SpawnDestination
    {
        public SpawnDestinationKind Kind;
        /// <summary>First line: the name.</summary>
        public string Label = "";
        /// <summary>Second line: identifiers, area, what kind of place.</summary>
        public string Detail = "";
        public double Lat;
        public double Lon;
        /// <summary>Baked area holding it; null when there is no terrain there.</summary>
        public string Area;
        /// <summary>For an airfield, the key the spawn picker uses (`icao || name`); otherwise null.</summary>
        public string AirfieldKey;
    }

    /// <summary>The fields of a Nominatim `jsonv2` result this reads; absent fields are null.</summary>
    public sealed class NominatimPlace
    {
        public string Lat;
        public string Lon;
        public string Name;
        public string DisplayName = "";
        public string Type;
        public string Addresstype;
    }

    /// <summary>
    /// Where a destination in another area is kept across the reload into that
    /// area (the TS uses sessionStorage key `rfs.pendingSpawn`, so it cannot
    /// leak into a later visit). The Unity layer supplies the store; any
    /// failure is treated as "nothing saved".
    /// </summary>
    public interface IPendingDestinationStore
    {
        void Write(SpawnDestination destination);
        /// <summary>The saved destination, or null.</summary>
        SpawnDestination Read();
        void Remove();
    }

    public static class SpawnSearch
    {
        public const string NominatimUrl = "https://nominatim.openstreetmap.org/search";
        /// <summary>Nominatim's usage policy: an absolute maximum of one request per second.</summary>
        public const double NominatimMinIntervalMs = 1100;

        public static AirfieldEntry AirfieldEntryOf(Airfield airfield)
        {
            double length = 0;
            foreach (AirfieldRunway r in airfield.Runways)
            {
                length = Math.Max(length, r.LengthM);
            }
            return new AirfieldEntry
            {
                Icao = airfield.Icao,
                Iata = airfield.Iata ?? "",
                Name = airfield.Name,
                Area = airfield.Area,
                Lat = airfield.Lat,
                Lon = airfield.Lon,
                LengthM = length,
            };
        }

        /// <summary>The key an airfield is chosen by everywhere else: `icao || name`.</summary>
        public static string AirfieldKey(string icao, string name) => JsText.Or(icao, name);

        public static string AirfieldKey(AirfieldEntry entry) => AirfieldKey(entry.Icao, entry.Name);

        /// <summary>The baked area holding a point, if any. First one wins where they overlap.</summary>
        public static string AreaAt(IReadOnlyList<TerrainArea> areas, double lat, double lon)
        {
            foreach (TerrainArea a in areas)
            {
                if (PlayArea.AreaContains(a, lat, lon))
                {
                    return a.Name;
                }
            }
            return null;
        }

        private static readonly Regex CombiningMarks = new Regex(
            new string(new[] { '[', (char)0x0300, '-', (char)0x036f, ']' }), RegexOptions.CultureInvariant);

        /// <summary>s.normalize('NFD') with the combining marks U+0300..U+036F removed, lower-cased.</summary>
        private static string Fold(string s)
        {
            return CombiningMarks.Replace(s.Normalize(NormalizationForm.FormD), "").ToLowerInvariant();
        }

        /// <summary>
        /// How well an airfield matches; 0 for not at all. Identifiers beat
        /// names, a whole identifier beats a prefix, a word start in the name
        /// beats the middle of a word.
        /// </summary>
        private static double AirfieldScore(AirfieldEntry entry, IReadOnlyList<string> words, string whole)
        {
            string icao = entry.Icao.ToLowerInvariant();
            string iata = entry.Iata.ToLowerInvariant();
            if (whole == icao || whole == iata)
            {
                return 1000;
            }
            string name = Fold(entry.Name);
            string hay = icao + " " + iata + " " + name;
            double score = 0;
            foreach (string word in words)
            {
                if (hay.IndexOf(word, StringComparison.Ordinal) < 0)
                {
                    return 0;
                }
                if (icao.StartsWith(word, StringComparison.Ordinal) || iata.StartsWith(word, StringComparison.Ordinal))
                {
                    score += 50;
                }
                else if (name.StartsWith(word, StringComparison.Ordinal)
                    || name.IndexOf(" " + word, StringComparison.Ordinal) >= 0
                    || name.IndexOf("-" + word, StringComparison.Ordinal) >= 0)
                {
                    score += 20;
                }
                else
                {
                    score += 5;
                }
            }
            return score;
        }

        private static readonly Regex WordSeparators = new Regex("[" + JsText.WhitespaceClass + ",]+", RegexOptions.CultureInvariant);

        /// <summary>
        /// Airfields matching `query`, best first; ties go to the longer runway,
        /// which is the one more likely meant. Every word has to appear somewhere.
        /// </summary>
        public static List<AirfieldEntry> SearchAirfields(IReadOnlyList<AirfieldEntry> entries, string query, int limit = 12)
        {
            string whole = Fold(JsText.Trim(query));
            List<string> words = WordSeparators.Split(whole).Where(w => w.Length > 0).ToList();
            if (words.Count == 0)
            {
                return new List<AirfieldEntry>();
            }
            var scored = entries
                .Select(entry => (entry, score: AirfieldScore(entry, words, whole)))
                .Where(s => s.score > 0)
                .ToList();
            // Array.prototype.sort is stable; so is OrderBy. The comparator is
            // `b.score - a.score || b.entry.lengthM - a.entry.lengthM`.
            return scored
                .OrderBy(s => s, Comparer<(AirfieldEntry entry, double score)>.Create((a, b) =>
                {
                    double d = JsText.Or(b.score - a.score, b.entry.LengthM - a.entry.LengthM);
                    return d > 0 ? 1 : d < 0 ? -1 : 0;
                }))
                .Take(Math.Max(0, limit))
                .Select(s => s.entry)
                .ToList();
        }

        private static readonly Regex CoordinatePattern = new Regex(
            "^[" + JsText.WhitespaceClass + "]*(-?[0-9]+(?:\\.[0-9]+)?)[" + JsText.WhitespaceClass + "]*°?["
            + JsText.WhitespaceClass + "]*([NSns])?[" + JsText.WhitespaceClass + "]*[,;" + JsText.WhitespaceClass + "]["
            + JsText.WhitespaceClass + "]*(-?[0-9]+(?:\\.[0-9]+)?)[" + JsText.WhitespaceClass + "]*°?["
            // \z, not $: .NET's $ also matches before a final \n, JS's does not.
            + JsText.WhitespaceClass + "]*([EWew])?[" + JsText.WhitespaceClass + "]*\\z",
            RegexOptions.CultureInvariant);

        /// <summary>
        /// A coordinate typed as `lat, lon` (or with a space between), in decimal
        /// degrees, optionally with N/S/E/W suffixes. Null for anything else.
        /// </summary>
        public static (double Lat, double Lon)? ParseCoordinates(string query)
        {
            Match m = CoordinatePattern.Match(query);
            if (!m.Success)
            {
                return null;
            }
            double lat = JsText.ToNumber(m.Groups[1].Value);
            double lon = JsText.ToNumber(m.Groups[3].Value);
            if (m.Groups[2].Success && m.Groups[2].Value.ToUpperInvariant() == "S")
            {
                lat = -lat;
            }
            if (m.Groups[4].Success && m.Groups[4].Value.ToUpperInvariant() == "W")
            {
                lon = -lon;
            }
            if (!JsText.IsFinite(lat) || !JsText.IsFinite(lon) || Math.Abs(lat) > 90 || Math.Abs(lon) > 180)
            {
                return null;
            }
            return (lat, lon);
        }

        public static SpawnDestination AirfieldDestination(AirfieldEntry entry, string currentArea)
        {
            string ids = string.Join(" / ", new[] { entry.Icao, entry.Iata }.Where(id => id.Length > 0));
            string where = entry.Area == currentArea ? "" : " · " + entry.Area + " (reloads)";
            return new SpawnDestination
            {
                Kind = SpawnDestinationKind.Airfield,
                Label = JsText.Or(JsText.Or(entry.Name, entry.Icao), "Unnamed airfield"),
                Detail = (ids.Length > 0 ? ids + " · " : "") + JsText.NumberToString(Retro.Core.JsMath.Round(entry.LengthM))
                    + " m runway" + where,
                Lat = entry.Lat,
                Lon = entry.Lon,
                Area = entry.Area,
                AirfieldKey = AirfieldKey(entry),
            };
        }

        /// <summary>Where a found point is, for the second line.</summary>
        private static string LocationDetail(string area, string currentArea, string prefix)
        {
            if (area == null)
            {
                return prefix + "no terrain baked here";
            }
            return area == currentArea ? prefix + "fly here" : prefix + area + " (reloads)";
        }

        public static SpawnDestination CoordinateDestination(
            double lat, double lon, IReadOnlyList<TerrainArea> areas, string currentArea)
        {
            string area = AreaAt(areas, lat, lon);
            return new SpawnDestination
            {
                Kind = SpawnDestinationKind.Coordinates,
                Label = JsText.ToFixed(lat, 5) + ", " + JsText.ToFixed(lon, 5),
                Detail = LocationDetail(area, currentArea, "Coordinates · "),
                Lat = lat,
                Lon = lon,
                Area = area,
            };
        }

        /// <summary>
        /// Already-parsed Nominatim results as destinations: startable first,
        /// the geocoder's own ranking within each group; bad coordinates skipped.
        /// </summary>
        public static List<SpawnDestination> PlacesFromNominatim(
            IReadOnlyList<NominatimPlace> results, IReadOnlyList<TerrainArea> areas, string currentArea)
        {
            var output = new List<SpawnDestination>();
            foreach (NominatimPlace r in results)
            {
                double lat = JsText.ToNumber(r.Lat);
                double lon = JsText.ToNumber(r.Lon);
                if (!JsText.IsFinite(lat) || !JsText.IsFinite(lon))
                {
                    continue;
                }
                string area = AreaAt(areas, lat, lon);
                // display_name repeats the name first; the rest is the context.
                string[] parts = r.DisplayName.Split(new[] { ", " }, StringSplitOptions.None);
                string label = JsText.Or(JsText.Or(r.Name, parts[0]), r.DisplayName);
                int skip = JsText.Truthy(r.Name) && parts[0] == r.Name ? 1 : 0;
                string[] rest = parts.Skip(skip).ToArray();
                string context = string.Join(", ", rest.Skip(Math.Max(0, rest.Length - 3)));
                string kind = (r.Addresstype ?? r.Type ?? "").Replace('_', ' ');
                output.Add(new SpawnDestination
                {
                    Kind = SpawnDestinationKind.Place,
                    Label = label,
                    Detail = LocationDetail(area, currentArea,
                        string.Join(" · ", new[] { kind, context }.Where(s => s.Length > 0)) + " · "),
                    Lat = lat,
                    Lon = lon,
                    Area = area,
                });
            }
            return output.Where(d => d.Area != null).Concat(output.Where(d => d.Area == null)).ToList();
        }

        /// <summary>The Nominatim search URL for a query, or null for a blank one (searchPlaces sends nothing then).</summary>
        public static string NominatimSearchUrl(string query)
        {
            string q = JsText.Trim(query);
            if (q.Length == 0)
            {
                return null;
            }
            return NominatimUrl + "?format=jsonv2&limit=8&q=" + JsText.EncodeUriComponent(q);
        }

        /// <summary>savePendingDestination: a failing store means the reload lands at the area's default start.</summary>
        public static void SavePendingDestination(IPendingDestinationStore store, SpawnDestination destination)
        {
            try
            {
                store.Write(destination);
            }
            catch (Exception)
            {
                // No storage: the reload lands at the area's default start instead.
            }
        }

        /// <summary>takePendingDestination: the destination saved before a reload, removed as it is read.</summary>
        public static SpawnDestination TakePendingDestination(IPendingDestinationStore store)
        {
            try
            {
                SpawnDestination dest = store.Read();
                store.Remove();
                if (dest == null)
                {
                    return null;
                }
                return JsText.IsFinite(dest.Lat) && JsText.IsFinite(dest.Lon) ? dest : null;
            }
            catch (Exception)
            {
                return null;
            }
        }
    }
}

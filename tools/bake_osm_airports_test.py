"""Tests for tools/bake_osm_airports.py.

The parts a wrong answer would be hard to spot in the rendered world: which way
a runway points, how long it is, and what surface the terrain is laid on. A
heading read backwards still draws a runway — just one you land on downwind.
"""
from __future__ import annotations

import math
import unittest

from bake_osm_airports import (
    DEFAULT_TAXIWAY_WIDTH_M,
    Airfield,
    Bounds,
    LocalFrame,
    MIN_RUNWAY_LENGTH_M,
    Runway,
    angle_delta_deg,
    dedupe_runways,
    bearing_deg,
    designator_bearing,
    designator_for,
    fit_axis,
    grade_airfield,
    merge_items,
    metres_per_degree,
    parse_ref,
    pavement_pad,
    platform_pads,
    runway_from_way,
    taxiway_width_m,
)

# Gran Canaria, near the 03L threshold. Any mid-latitude point would do; a real
# one keeps the metres-per-degree numbers honest.
LAT0, LON0 = 27.9300, -15.3860


def way_from_bearing(way_id: int, bearing: float, length_m: float, tags: dict,
                     lat: float = LAT0, lon: float = LON0) -> tuple:
    """A two-node way centred on (lat, lon), running along `bearing`."""
    frame = LocalFrame(lat, lon)
    half = length_m / 2.0
    e = math.sin(math.radians(bearing)) * half
    n = math.cos(math.radians(bearing)) * half
    a = frame.to_lonlat(-e, -n)
    b = frame.to_lonlat(e, n)
    nodes = {1: a, 2: b}
    return {'type': 'way', 'id': way_id, 'nodes': [1, 2], 'tags': tags}, nodes


class LocalFrameTest(unittest.TestCase):

    def test_metres_per_degree_is_the_familiar_number(self):
        m_lat, m_lon = metres_per_degree(0.0)
        self.assertAlmostEqual(m_lat, 110574, delta=50)
        self.assertAlmostEqual(m_lon, 111320, delta=50)
        # Longitude shrinks by cos(lat); latitude barely moves.
        m_lat45, m_lon45 = metres_per_degree(45.0)
        self.assertAlmostEqual(m_lon45 / m_lon, math.cos(math.radians(45)), delta=0.002)
        self.assertGreater(m_lat45, m_lat)

    def test_round_trips_metres_through_lon_lat(self):
        frame = LocalFrame(LAT0, LON0)
        lon, lat = frame.to_lonlat(1500.0, -2200.0)
        e, n = frame.to_m(lon, lat)
        self.assertAlmostEqual(e, 1500.0, places=6)
        self.assertAlmostEqual(n, -2200.0, places=6)


class BearingTest(unittest.TestCase):

    def test_bearing_is_clockwise_from_north(self):
        self.assertAlmostEqual(bearing_deg(0, 1), 0.0)
        self.assertAlmostEqual(bearing_deg(1, 0), 90.0)
        self.assertAlmostEqual(bearing_deg(0, -1), 180.0)
        self.assertAlmostEqual(bearing_deg(-1, 0), 270.0)

    def test_delta_takes_the_short_way_round(self):
        self.assertAlmostEqual(angle_delta_deg(5.0, 355.0), 10.0)
        self.assertAlmostEqual(angle_delta_deg(355.0, 5.0), -10.0)


class DesignatorTest(unittest.TestCase):

    def test_parses_the_forms_osm_uses(self):
        self.assertEqual(parse_ref('03L/21R'), ['03L', '21R'])
        self.assertEqual(parse_ref('09/27'), ['09', '27'])
        self.assertEqual(parse_ref('  9/27 '), ['9', '27'])
        self.assertEqual(parse_ref(None), [])
        self.assertEqual(parse_ref('grass'), [])

    def test_designator_bearing_reads_tens_of_degrees(self):
        self.assertEqual(designator_bearing('03L'), 30.0)
        self.assertEqual(designator_bearing('27'), 270.0)
        # 36 is north, which is bearing 0.
        self.assertEqual(designator_bearing('36'), 0.0)
        self.assertIsNone(designator_bearing('L'))
        self.assertIsNone(designator_bearing('40'))

    def test_derived_designator_never_reads_zero(self):
        # A runway pointing due north is 36, not 00 — there is no runway 00.
        self.assertEqual(designator_for(0.0), '36')
        self.assertEqual(designator_for(359.0), '36')
        self.assertEqual(designator_for(87.0), '09')
        self.assertEqual(designator_for(184.0), '18')


class FitAxisTest(unittest.TestCase):

    def test_recovers_the_direction_through_noisy_nodes(self):
        # A way digitised with intermediate nodes a metre either side of the
        # centreline. First-to-last would tilt with whichever end wandered.
        bearing = 32.0
        ax = math.sin(math.radians(bearing))
        ay = math.cos(math.radians(bearing))
        wobble = [0.0, 1.2, -0.9, 0.6, -1.4, 0.0]
        pts = []
        for i, w in enumerate(wobble):
            t = -1500.0 + i * 600.0
            pts.append((ax * t - ay * w, ay * t + ax * w))
        _, direction = fit_axis(pts)
        self.assertAlmostEqual(bearing_deg(*direction) % 180.0, bearing, places=1)


class RunwayFromWayTest(unittest.TestCase):

    def test_reads_heading_length_and_thresholds(self):
        way, nodes = way_from_bearing(1, 32.0, 3100.0, {'aeroway': 'runway', 'ref': '03L/21R'})
        r = runway_from_way(way, nodes, 'international')
        self.assertIsNotNone(r)
        self.assertAlmostEqual(r.heading_deg, 32.0, places=1)
        self.assertAlmostEqual(r.length_m, 3100.0, delta=1.0)
        self.assertEqual(r.ref, '03L/21R')
        self.assertFalse(r.ref_derived)
        # `ref` is magnetic and the geometry is true, so the difference is
        # declination — about two degrees here, not a hundred and eighty.
        self.assertAlmostEqual(r.ref_delta_deg, 2.0, places=1)
        self.assertAlmostEqual(r.lat, LAT0, places=5)
        self.assertAlmostEqual(r.lon, LON0, places=5)
        # Thresholds come out in the order the ref names them: 03L end first.
        frame = LocalFrame(LAT0, LON0)
        e, n = frame.to_m(r.thresholds[0][1], r.thresholds[0][0])
        self.assertAlmostEqual(bearing_deg(-e, -n), 32.0, places=1)

    def test_a_way_drawn_backwards_is_turned_to_match_its_ref(self):
        # OSM way direction is arbitrary; the designator is not. Drawn from the
        # 21R end, this still has to come out as a 03L runway.
        way, nodes = way_from_bearing(2, 212.0, 3100.0, {'aeroway': 'runway', 'ref': '03L/21R'})
        r = runway_from_way(way, nodes, 'international')
        self.assertAlmostEqual(r.heading_deg, 32.0, places=1)
        self.assertAlmostEqual(abs(r.ref_delta_deg), 2.0, places=1)

    def test_derives_a_ref_when_osm_has_none(self):
        way, nodes = way_from_bearing(3, 87.0, 1400.0, {'aeroway': 'runway'})
        r = runway_from_way(way, nodes, 'regional')
        self.assertEqual(r.ref, '09/27')
        self.assertTrue(r.ref_derived)
        self.assertIsNone(r.ref_delta_deg)

    def test_width_falls_back_to_the_aerodrome_class(self):
        way, nodes = way_from_bearing(4, 90.0, 2000.0, {'aeroway': 'runway'})
        self.assertEqual(runway_from_way(way, nodes, 'international').width_m, 45.0)
        self.assertEqual(runway_from_way(way, nodes, 'regional').width_m, 30.0)
        self.assertEqual(runway_from_way(way, nodes, 'ga').width_m, 18.0)

    def test_a_tagged_width_wins_over_the_class_default(self):
        way, nodes = way_from_bearing(5, 90.0, 2000.0, {'aeroway': 'runway', 'width': '60 m'})
        self.assertEqual(runway_from_way(way, nodes, 'ga').width_m, 60.0)

    def test_a_runway_mapped_as_an_area_has_its_width_measured(self):
        # A closed rectangle 2000 x 45, running 090.
        frame = LocalFrame(LAT0, LON0)
        corners = [(-1000, -22.5), (1000, -22.5), (1000, 22.5), (-1000, 22.5)]
        nodes = {}
        ids = []
        for i, (along, across) in enumerate(corners, start=1):
            # bearing 090: along is east, across is north.
            nodes[i] = frame.to_lonlat(along, across)
            ids.append(i)
        way = {'type': 'way', 'id': 6, 'nodes': ids + [ids[0]],
               'tags': {'aeroway': 'runway', 'area': 'yes'}}
        r = runway_from_way(way, nodes, 'ga')
        self.assertAlmostEqual(r.length_m, 2000.0, delta=1.0)
        self.assertAlmostEqual(r.width_m, 45.0, delta=0.5)
        self.assertTrue(r.width_measured)
        self.assertAlmostEqual(r.heading_deg % 180.0, 90.0, places=1)

    def test_a_displaced_threshold_is_paint_rather_than_a_runway(self):
        # La Palma maps one as its own aeroway=runway way lying on the real
        # strip. Taken at face value it becomes a second coincident runway.
        way, nodes = way_from_bearing(
            8, 179.0, 900.0,
            {'aeroway': 'runway', 'runway': 'displaced_threshold'})
        self.assertIsNone(runway_from_way(way, nodes, 'regional'))


class PavementPadTest(unittest.TestCase):
    """The pavement `runway_from_way` turns away still gets flattened.

    Holzdorf's displaced threshold is hundreds of metres of real concrete
    beyond the mapped runway strip - dropped outright, that pavement is never
    cut flat or painted as built ground.
    """

    def test_a_displaced_threshold_becomes_a_pad(self):
        way, nodes = way_from_bearing(
            8, 179.0, 300.0,
            {'aeroway': 'runway', 'runway': 'displaced_threshold', 'surface': 'concrete'})
        pad = pavement_pad(way, nodes, default_width=45.0)
        self.assertIsNotNone(pad)
        self.assertAlmostEqual(pad['headingDeg'] % 180.0, 179.0 % 180.0, places=1)
        self.assertAlmostEqual(pad['halfD'] - pad['featherM'], 150.0, delta=1.0)
        self.assertAlmostEqual(pad['halfW'] - pad['featherM'], 45.0 / 2.0, delta=0.5)

    def test_a_tagged_width_beats_the_default(self):
        way, nodes = way_from_bearing(
            9, 90.0, 300.0, {'aeroway': 'runway', 'runway': 'blast_pad', 'width': '60'})
        pad = pavement_pad(way, nodes, default_width=18.0)
        self.assertAlmostEqual(pad['halfW'] - pad['featherM'], 30.0, delta=0.5)

    def test_a_degenerate_way_yields_no_pad(self):
        way, nodes = way_from_bearing(10, 90.0, 0.0, {'aeroway': 'runway', 'runway': 'stopway'})
        self.assertIsNone(pavement_pad(way, nodes, default_width=18.0))

    def test_keeps_the_length_tag_beside_the_measured_one(self):
        # La Palma again: the way measures 2112 m and the tag declares 2200.
        # The geometry places the runway; the tag is kept so the disagreement
        # is visible rather than silently resolved.
        way, nodes = way_from_bearing(
            9, 179.0, 2112.0, {'aeroway': 'runway', 'ref': '18/36', 'length': '2200'})
        r = runway_from_way(way, nodes, 'regional')
        self.assertAlmostEqual(r.length_m, 2112.0, delta=1.0)
        self.assertEqual(r.length_tag_m, 2200.0)

    def test_an_impossibly_narrow_width_tag_is_disbelieved(self):
        # Dzhankoi carries width=12 on 2.5 km of concrete - narrower than the
        # taxiways beside it. Honoured, it would draw as a ribbon.
        way, nodes = way_from_bearing(
            10, 50.0, 2513.0, {'aeroway': 'runway', 'width': '12'})
        r = runway_from_way(way, nodes, 'military')
        self.assertEqual(r.width_m, 45.0)
        self.assertTrue(r.width_implausible)

    def test_a_genuinely_narrow_short_strip_keeps_its_width(self):
        way, nodes = way_from_bearing(
            11, 50.0, 700.0, {'aeroway': 'runway', 'width': '12'})
        r = runway_from_way(way, nodes, 'ga')
        self.assertEqual(r.width_m, 12.0)
        self.assertFalse(r.width_implausible)

    def test_a_farm_strip_is_not_a_runway(self):
        way, nodes = way_from_bearing(7, 90.0, MIN_RUNWAY_LENGTH_M - 1.0, {'aeroway': 'runway'})
        self.assertIsNone(runway_from_way(way, nodes, 'ga'))

    def test_a_runway_laid_in_plates_says_so(self):
        way, nodes = way_from_bearing(
            45, 45.0, 3220.0, {'aeroway': 'runway', 'ref': '04R/22L', 'surface': 'concrete:plates'})
        r = runway_from_way(way, nodes, 'military')
        self.assertEqual(r.surface, 'concrete')
        self.assertTrue(r.plates)
        way, nodes = way_from_bearing(
            46, 45.0, 3220.0, {'aeroway': 'runway', 'ref': '04/22', 'surface': 'concrete'})
        self.assertFalse(runway_from_way(way, nodes, 'military').plates)

    def test_a_steel_deck_is_kept_however_short(self):
        # Saki's NITKA: 218 m of metal, no ref.
        way, nodes = way_from_bearing(
            45, 220.0, 218.0, {'aeroway': 'runway', 'surface': 'metal'})
        r = runway_from_way(way, nodes, 'military')
        self.assertIsNotNone(r)
        self.assertEqual(r.surface, 'metal')


class DedupeRunwaysTest(unittest.TestCase):
    """OSM often maps one strip twice - a centreline and an area."""

    def runway(self, bearing, length, offset_m=0.0, ref='05/23', measured=False):
        frame = LocalFrame(LAT0, LON0)
        ax = math.sin(math.radians(bearing))
        ay = math.cos(math.radians(bearing))
        lon, lat = frame.to_lonlat(-ay * offset_m, ax * offset_m)
        return Runway(
            ref=ref, heading_deg=bearing, length_m=length, width_m=45.0,
            surface='concrete', lit=True, lat=lat, lon=lon,
            thresholds=[[lat, lon], [lat, lon]], osm_id=1,
            ref_derived=False, ref_delta_deg=0.0, width_measured=measured,
            length_tag_m=None, width_implausible=False,
        )

    def test_a_coincident_pair_collapses_to_the_measured_one(self):
        # Oktyabrskoye: 3294 m centreline and a 3323 m area, same strip.
        line = self.runway(58.5, 3294.0)
        area = self.runway(58.6, 3323.0, measured=True)
        kept = dedupe_runways([line, area])
        self.assertEqual(len(kept), 1)
        self.assertTrue(kept[0].width_measured)

    def test_strips_in_line_are_two_runways(self):
        a = self.runway(45.0, 219.0)
        b = self.runway(45.0, 214.0)
        frame = LocalFrame(a.lat, a.lon)
        b.lon, b.lat = frame.to_lonlat(1500.0, 1500.0)
        self.assertEqual(len(dedupe_runways([a, b])), 2)

    def test_parallel_runways_are_two_runways(self):
        # Las Palmas 03L / 03R sit about 180 m apart. Merging them would
        # delete a runway that is really there.
        left = self.runway(21.4, 3103.0, offset_m=-90.0, ref='03L/21R')
        right = self.runway(21.4, 3099.0, offset_m=90.0, ref='03R/21L')
        self.assertEqual(len(dedupe_runways([left, right])), 2)

    def test_crossing_runways_are_two_runways(self):
        self.assertEqual(len(dedupe_runways(
            [self.runway(50.0, 2500.0, ref='05/23'),
             self.runway(140.0, 2000.0, ref='14/32')])), 2)


class TaxiwayWidthTest(unittest.TestCase):
    """667 of 684 taxiways carry no width tag, so the default is what is drawn."""

    def test_follows_the_aerodrome_class(self):
        # Annex 14's code letters: E for an international field, down to B for
        # a light-aircraft strip. One number for all of them put an
        # international taxiway through every gliding club in Brandenburg.
        self.assertEqual(taxiway_width_m({}, 'international'), 23.0)
        self.assertEqual(taxiway_width_m({}, 'military'), 18.0)
        self.assertEqual(taxiway_width_m({}, 'regional'), 15.0)
        self.assertEqual(taxiway_width_m({}, 'ga'), 10.5)

    def test_gets_narrower_as_the_field_gets_smaller(self):
        widths = [DEFAULT_TAXIWAY_WIDTH_M[k]
                  for k in ('international', 'military', 'regional', 'ga')]
        self.assertEqual(widths, sorted(widths, reverse=True))

    def test_a_tagged_width_wins(self):
        self.assertEqual(taxiway_width_m({'width': '16'}, 'international'), 16.0)
        self.assertEqual(taxiway_width_m({'width': '10.5 m'}, 'ga'), 10.5)

    def test_a_width_too_narrow_to_be_a_taxiway_is_disbelieved(self):
        # A service road or a footpath that picked up the tag.
        self.assertEqual(taxiway_width_m({'width': '2'}, 'regional'), 15.0)

    def test_an_unknown_class_falls_back_to_the_smallest(self):
        self.assertEqual(taxiway_width_m({}, 'seaplane base'), 10.5)


class FakeDem:
    """A DEM given as a function of local metres about (LAT0, LON0)."""

    def __init__(self, height):
        self.frame = LocalFrame(LAT0, LON0)
        self.height = height

    def sample_bilinear(self, lon: float, lat: float) -> float:
        return self.height(*self.frame.to_m(lon, lat))

    sample = sample_bilinear


def runway_at(ref: str, heading: float, length: float, e: float = 0.0, n: float = 0.0,
              surface: str = 'asphalt', width: float = 45.0) -> Runway:
    lon, lat = LocalFrame(LAT0, LON0).to_lonlat(e, n)
    return Runway(
        ref=ref, heading_deg=heading, length_m=length, width_m=width,
        surface=surface, lit=True, lat=lat, lon=lon,
        thresholds=[[lat, lon], [lat, lon]], osm_id=1,
        ref_derived=False, ref_delta_deg=0.0, width_measured=False,
        length_tag_m=None, width_implausible=False,
    )


def graded(runways, height, **kw) -> Airfield:
    airfield = Airfield(name='Test', icao='TEST', iata='', kind='international',
                        lat=LAT0, lon=LON0, ele_tag_m=None, osm_id=1, runways=runways, **kw)
    airfield.pads = platform_pads(airfield)
    reason = grade_airfield(airfield, FakeDem(height))
    if reason is not None:
        raise AssertionError(reason)
    return airfield


def profile_slopes(pad: dict):
    prof = pad['profile']
    step = 2 * pad['halfD'] / (len(prof) - 1)
    return [(b - a) / step for a, b in zip(prof, prof[1:])], step


class GradeAirfieldTest(unittest.TestCase):

    def test_a_gentle_slope_is_left_as_the_ground_has_it(self):
        # 0.6 % up to the north: within every limit, so the runway follows it.
        airfield = graded([runway_at('18/36', 0.0, 3000.0)], lambda e, n: 100.0 + 0.006 * n)
        pad = airfield.pads[-1]
        slopes, _ = profile_slopes(pad)
        for s in slopes:
            self.assertAlmostEqual(s, 0.006, places=4)
        self.assertEqual(airfield.fit['runways'][0]['status'], 'ok')
        self.assertAlmostEqual(pad['heightMsl'], 100.0, places=1)

    def test_a_hill_under_a_long_runway_is_graded_to_annex_14(self):
        # A 12 m hump halfway down: the ground rises 6 % on its flanks.
        hump = lambda e, n: 100.0 + 12.0 * math.exp(-(n / 200.0) ** 2)
        airfield = graded([runway_at('18/36', 0.0, 3000.0)], hump)
        pad = airfield.pads[-1]
        slopes, step = profile_slopes(pad)
        self.assertLessEqual(max(abs(s) for s in slopes), 0.0125 + 1e-6)
        prof = pad['profile']
        self.assertLessEqual((max(prof) - min(prof)) / (step * (len(prof) - 1)), 0.01 + 1e-6)
        report = airfield.fit['runways'][0]
        self.assertEqual(report['status'], 'graded')
        self.assertGreater(report['naturalLocal'], 0.03)
        # Cut into the hill and filled either side, not a shelf at one level.
        self.assertGreater(max(prof) - min(prof), 2.0)

    def test_a_crossing_runway_meets_the_first_one_without_a_step(self):
        ground = lambda e, n: 100.0 + 0.008 * n + 0.004 * e
        airfield = graded([runway_at('18/36', 0.0, 3000.0), runway_at('09/27', 90.0, 2000.0)], ground)
        longest, crossing = airfield.pads[-2], airfield.pads[-1]
        # Both at the crossing point, the middle of each.
        mid = lambda p: p['profile'][len(p['profile']) // 2]
        self.assertAlmostEqual(mid(longest), mid(crossing), delta=0.05)

    def test_a_steep_grass_strip_keeps_its_slope(self):
        airfield = graded([runway_at('09/27', 90.0, 600.0, surface='grass', width=30.0)],
                          lambda e, n: 500.0 + 0.08 * e)
        report = airfield.fit['runways'][0]
        self.assertEqual(report['status'], 'steep')
        slopes, _ = profile_slopes(airfield.pads[-1])
        self.assertAlmostEqual(max(slopes), 0.08, places=3)

    def test_a_steep_paved_strip_is_graded_and_reported(self):
        airfield = graded([runway_at('09/27', 90.0, 600.0)], lambda e, n: 500.0 + 0.08 * e)
        report = airfield.fit['runways'][0]
        self.assertEqual(report['status'], 'suspect')
        slopes, _ = profile_slopes(airfield.pads[-1])
        self.assertLessEqual(max(abs(s) for s in slopes), 0.02 + 1e-6)

    def test_a_taxiway_on_level_ground_gets_no_pads(self):
        frame = LocalFrame(LAT0, LON0)
        pts = [frame.to_lonlat(100.0, -500.0), frame.to_lonlat(400.0, -500.0), frame.to_lonlat(400.0, 500.0)]
        taxiway = {'widthM': 18.0, 'points': [[lat, lon] for lon, lat in pts]}
        airfield = graded([runway_at('18/36', 0.0, 3000.0)], lambda e, n: 100.0, taxiways=[taxiway])
        self.assertEqual(airfield.fit['taxiways']['pads'], 0)
        self.assertEqual(len(airfield.pads), 1)

    def test_a_steep_taxiway_is_graded_into_pads_pinned_to_the_runway(self):
        # Ground falling 5 % eastwards; the taxiway leaves the runway due east.
        frame = LocalFrame(LAT0, LON0)
        pts = [frame.to_lonlat(0.0, 0.0), frame.to_lonlat(400.0, 0.0)]
        taxiway = {'widthM': 18.0, 'points': [[lat, lon] for lon, lat in pts]}
        airfield = graded([runway_at('18/36', 0.0, 3000.0)], lambda e, n: 100.0 - 0.05 * e,
                          taxiways=[taxiway])
        taxi = airfield.fit['taxiways']
        self.assertGreater(taxi['pads'], 0)
        pad = airfield.pads[0]
        slopes, _ = profile_slopes(pad)
        self.assertLessEqual(max(abs(s) for s in slopes), 0.015 + 1e-6)
        # Taxiways first, so the runway is applied over them where they meet.
        self.assertNotIn('gradient', pad)
        self.assertEqual(airfield.pads[-1]['halfW'] - airfield.pads[-1]['featherM'], 45.0 / 2 + 10.0)

    def test_the_summary_plane_is_the_primary_runway(self):
        airfield = graded([runway_at('18/36', 0.0, 3000.0)], lambda e, n: 100.0 + 0.006 * n)
        self.assertAlmostEqual(airfield.plane['heightMsl'], 100.0, places=1)
        self.assertAlmostEqual(airfield.plane['gradient'], 0.006, places=4)


class PlatformPadsTest(unittest.TestCase):

    def airfield(self, **kw) -> Airfield:
        runway = Runway(
            ref='03/21', heading_deg=32.0, length_m=3100.0, width_m=45.0,
            surface='asphalt', lit=True, lat=LAT0, lon=LON0,
            thresholds=[[LAT0, LON0], [LAT0, LON0]], osm_id=1,
            ref_derived=False, ref_delta_deg=2.0, width_measured=False,
            length_tag_m=None, width_implausible=False,
        )
        return Airfield(name='Test', icao='TEST', iata='', kind='international',
                        lat=LAT0, lon=LON0, ele_tag_m=None, osm_id=1,
                        runways=[runway], **kw)

    def test_the_pad_covers_the_runway_and_a_margin(self):
        pads = platform_pads(self.airfield())
        self.assertEqual(len(pads), 1)
        pad = pads[0]
        self.assertAlmostEqual(pad['headingDeg'], 32.0)
        # Half-extents are the pad's outer edge, feather included, so the
        # fully flattened core is what is left inside them: the pavement plus
        # a 10 m margin on every side, no ICAO strip.
        self.assertAlmostEqual(pad['halfD'] - pad['featherM'], 3100.0 / 2.0 + 10.0)
        self.assertAlmostEqual(pad['halfW'] - pad['featherM'], 45.0 / 2.0 + 10.0)

    def test_an_apron_pad_lines_up_with_the_runway(self):
        frame = LocalFrame(LAT0, LON0)
        ring = [frame.to_lonlat(*p) for p in
                ((200, 100), (600, 100), (600, 400), (200, 400), (200, 100))]
        apron = {'ring': [[lat, lon] for lon, lat in ring]}
        pads = platform_pads(self.airfield(aprons=[apron]))
        self.assertEqual(len(pads), 2)
        # Not the apron's own axis: an irregular blob's principal direction
        # swings with its shape and would tilt the pad against the runway.
        self.assertAlmostEqual(pads[1]['headingDeg'], 32.0)

    def test_extra_pads_from_displaced_thresholds_are_included(self):
        # Otherwise a real displaced threshold - pavement the runway strip's
        # own overrun does not reach - never gets flattened or painted.
        way, nodes = way_from_bearing(20, 32.0, 300.0, {}, lat=LAT0, lon=LON0)
        extra = pavement_pad(way, nodes, default_width=45.0)
        pads = platform_pads(self.airfield(extra_pads=[extra]))
        self.assertEqual(len(pads), 2)
        self.assertIn(extra, pads)


class MergeItemsTest(unittest.TestCase):
    """A scoped bake looked at one box and knows nothing about the rest."""

    def test_replaces_inside_the_bbox_and_keeps_everything_outside(self):
        bbox = Bounds(-16.0, 27.0, -15.0, 28.5)
        previous = [
            {'icao': 'GCLP', 'name': 'old Gran Canaria', 'lat': 27.93, 'lon': -15.39},
            {'icao': 'EDDB', 'name': 'Berlin', 'lat': 52.36, 'lon': 13.50},
        ]
        fresh = [{'icao': 'GCLP', 'name': 'Gran Canaria', 'lat': 27.93, 'lon': -15.39}]
        out = merge_items(previous, fresh, bbox)
        self.assertEqual([i['name'] for i in out], ['Berlin', 'Gran Canaria'])

    def test_is_sorted_so_a_re_bake_produces_a_readable_diff(self):
        bbox = Bounds(0.0, 0.0, 1.0, 1.0)
        fresh = [{'icao': 'ZZZZ', 'name': 'b', 'lat': 0.5, 'lon': 0.5},
                 {'icao': 'AAAA', 'name': 'a', 'lat': 0.5, 'lon': 0.5}]
        self.assertEqual([i['icao'] for i in merge_items([], fresh, bbox)],
                         ['AAAA', 'ZZZZ'])


# --- ownership, the LRU mask cache and the progress lines --------------------

import contextlib
import io
import re

import bake_osm_airports
from bake_osm_airports import ski_jump_tags
from bake_osm_airports import (
    AerodromeIndex,
    LandMask,
    ORPHAN_ASSIGN_RADIUS_M,
    StageProgress,
    airfield_to_json,
    assemble_airfields,
)


def aerodrome_way(way_id: int, lat: float, lon: float, half_m: float, tags: dict,
                  first_node: int) -> tuple:
    """A square aerodrome polygon `half_m` metres about (lat, lon)."""
    frame = LocalFrame(lat, lon)
    corners = [frame.to_lonlat(e, n) for e, n in
               ((-half_m, -half_m), (half_m, -half_m), (half_m, half_m), (-half_m, half_m))]
    ids = list(range(first_node, first_node + 4))
    nodes = dict(zip(ids, corners))
    tags = {'aeroway': 'aerodrome', **tags}
    return {'type': 'way', 'id': way_id, 'nodes': ids + [ids[0]], 'tags': tags}, nodes


def aerodrome_node(node_id: int, lat: float, lon: float, tags: dict) -> dict:
    return {'type': 'node', 'id': node_id, 'lat': lat, 'lon': lon,
            'tags': {'aeroway': 'aerodrome', **tags}}


def runway_way(way_id: int, lat: float, lon: float, first_node: int, bearing: float = 90.0) -> tuple:
    way, nodes = way_from_bearing(way_id, bearing, 1500.0, {'aeroway': 'runway'}, lat=lat, lon=lon)
    a, b = nodes[1], nodes[2]
    way['nodes'] = [first_node, first_node + 1]
    return way, {first_node: a, first_node + 1: b}


def offset(lat: float, lon: float, east_m: float, north_m: float) -> tuple:
    lon2, lat2 = LocalFrame(lat, lon).to_lonlat(east_m, north_m)
    return lat2, lon2


def elements_and_nodes(*pairs) -> dict:
    """Build an Overpass-shaped answer from (element, nodes) pairs and bare elements."""
    elements = []
    nodes = {}
    for item in pairs:
        if isinstance(item, tuple):
            el, ns = item
            elements.append(el)
            nodes.update(ns)
        else:
            elements.append(item)
    elements += [{'type': 'node', 'id': nid, 'lat': lat, 'lon': lon}
                 for nid, (lon, lat) in nodes.items()]
    return {'elements': elements}


class OwnerTest(unittest.TestCase):

    def test_a_ski_jump_keeps_its_short_run_up_and_rises_away_from_it(self):
        # Saki's T2: a 213 m concrete run-up ending at a ramp 50 m long.
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        main = runway_way(12, LAT0, LON0, first_node=300)
        lat_r, lon_r = offset(LAT0, LON0, -800.0, 800.0)
        run_up, run_nodes = way_from_bearing(
            13, 45.0, 213.0, {'aeroway': 'runway', 'ref': '04/22', 'surface': 'concrete'},
            lat=lat_r, lon=lon_r)
        run_up['nodes'] = [400, 401]
        run_nodes = {400: run_nodes[1], 401: run_nodes[2]}
        # The ramp starts at the run-up's 22 end (north-east) and runs on 50 m.
        end_lon, end_lat = run_nodes[401]
        frame = LocalFrame(end_lat, end_lon)
        ax, ay = math.sin(math.radians(45.0)), math.cos(math.radians(45.0))
        corners = [(-ay * 12 + ax * a, ax * 12 + ay * a) for a in (0.0, 50.0)]
        corners = [corners[0], corners[1], (corners[1][0] + 2 * ay * 12, corners[1][1] - 2 * ax * 12),
                   (corners[0][0] + 2 * ay * 12, corners[0][1] - 2 * ax * 12)]
        ramp_nodes = {500 + i: frame.to_lonlat(e, n) for i, (e, n) in enumerate(corners)}
        ramp = {'type': 'way', 'id': 14, 'nodes': [500, 501, 502, 503, 500], 'tags': {
            'building': 'yes', 'building:levels': '0', 'roof:shape': 'skillion',
            'roof:height': '8', 'name': 'T2 ski-jump'}}
        found = assemble_airfields(elements_and_nodes(field, main, (run_up, run_nodes), (ramp, ramp_nodes)))
        self.assertEqual(len(found), 1)
        refs = sorted(r.ref for r in found[0].runways)
        self.assertIn('04/22', refs)
        self.assertTrue(next(r for r in found[0].runways if r.ref == '04/22').ski_jump)
        jump = found[0].ski_jumps[0]
        self.assertTrue(jump['runUpFound'])
        self.assertEqual(jump['heightM'], 8.0)
        self.assertAlmostEqual(jump['lengthM'], 50.0, delta=1.0)
        self.assertLess(abs(((jump['headingDeg'] - 45.0) + 180.0) % 360.0 - 180.0), 2.0)
        # The base is where the run-up ends.
        e, n = frame.to_m(jump['lon'], jump['lat'])
        self.assertLess(math.hypot(e, n), 2.0)

    def test_a_run_up_that_runs_over_the_ramp_still_points_it_uphill(self):
        # As Saki maps it now: the runway way goes on over the ramp to its lip.
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        main = runway_way(12, LAT0, LON0, first_node=300)
        lat_r, lon_r = offset(LAT0, LON0, -800.0, 800.0)
        run_up, run_nodes = way_from_bearing(
            13, 45.0, 173.0, {'aeroway': 'runway', 'ref': 'T-2 ski-jump'}, lat=lat_r, lon=lon_r)
        run_up['nodes'] = [400, 401]
        run_nodes = {400: run_nodes[1], 401: run_nodes[2]}
        # The ramp is the last 59 m of the run-up.
        end_lon, end_lat = run_nodes[401]
        frame = LocalFrame(end_lat, end_lon)
        ax, ay = math.sin(math.radians(45.0)), math.cos(math.radians(45.0))
        def at(a, c):
            return frame.to_lonlat(ax * a + ay * c, ay * a - ax * c)
        ramp_nodes = {500: at(-59, -13), 501: at(0, -13), 502: at(0, 13), 503: at(-59, 13)}
        ramp = {'type': 'way', 'id': 14, 'nodes': [500, 501, 502, 503, 500], 'tags': {
            'building': 'yes', 'building:levels': '0', 'roof:shape': 'skillion',
            'roof:height': '8', 'name': 'T2 ski-jump'}}
        found = assemble_airfields(elements_and_nodes(field, main, (run_up, run_nodes), (ramp, ramp_nodes)))
        jump = found[0].ski_jumps[0]
        self.assertTrue(jump['runUpFound'])
        self.assertLess(abs(((jump['headingDeg'] - 45.0) + 180.0) % 360.0 - 180.0), 2.0)
        e, n = frame.to_m(jump['lon'], jump['lat'])
        self.assertAlmostEqual(e * ax + n * ay, -59.0, delta=2.0)
        run = next(r for r in found[0].runways if r.ski_jump)
        self.assertTrue(run.ref_derived)
        self.assertEqual(run.ref, '04/22')

    def test_a_short_runway_on_a_steel_deck_is_the_deck_runway(self):
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        main = runway_way(12, LAT0, LON0, first_node=300)
        lat_d, lon_d = offset(LAT0, LON0, -800.0, 800.0)
        deck, deck_nodes = aerodrome_way(14, lat_d, lon_d, 150.0, {}, first_node=500)
        deck['tags'] = {'area': 'yes', 'name': 'NITKA', 'surface': 'metal'}
        line, line_nodes = way_from_bearing(
            13, 45.0, 218.0, {'aeroway': 'runway', 'name': 'Practice aircraft carrier runway'},
            lat=lat_d, lon=lon_d)
        line['nodes'] = [400, 401]
        line_nodes = {400: line_nodes[1], 401: line_nodes[2]}
        found = assemble_airfields(elements_and_nodes(field, main, (deck, deck_nodes), (line, line_nodes)))
        self.assertEqual(sorted(r.surface for r in found[0].runways), ['gravel', 'metal'])

    def test_a_skillion_with_no_height_below_its_roof_is_a_ramp(self):
        # How Saki's T2 is tagged now: `height=0`, no `building:levels`.
        self.assertTrue(ski_jump_tags({
            'building': 'yes', 'height': '0', 'roof:shape': 'skillion', 'roof:height': '8'}))
        self.assertTrue(ski_jump_tags({
            'building': 'yes', 'building:levels': '0', 'roof:shape': 'skillion'}))
        # A lean-to shed has storeys under its skillion roof.
        self.assertFalse(ski_jump_tags({
            'building': 'yes', 'building:levels': '1', 'roof:shape': 'skillion'}))
        self.assertFalse(ski_jump_tags({'building': 'yes', 'height': '0', 'roof:shape': 'gabled'}))

    def test_a_short_runway_with_no_ramp_is_still_a_farm_strip(self):
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        main = runway_way(12, LAT0, LON0, first_node=300)
        lat_r, lon_r = offset(LAT0, LON0, -800.0, 800.0)
        short, short_nodes = way_from_bearing(13, 45.0, 213.0, {'aeroway': 'runway'}, lat=lat_r, lon=lon_r)
        short['nodes'] = [400, 401]
        short_nodes = {400: short_nodes[1], 401: short_nodes[2]}
        found = assemble_airfields(elements_and_nodes(field, main, (short, short_nodes)))
        self.assertEqual(len(found[0].runways), 1)

    def test_a_steel_deck_outline_is_a_deck_with_a_pad(self):
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        runway = runway_way(12, LAT0, LON0, first_node=300)
        deck, deck_nodes = aerodrome_way(14, LAT0, LON0, 30.0, {}, first_node=500)
        deck['tags'] = {'area': 'yes', 'name': 'NITKA', 'surface': 'metal'}
        found = assemble_airfields(elements_and_nodes(field, runway, (deck, deck_nodes)))
        self.assertEqual(len(found), 1)
        self.assertEqual([d['name'] for d in found[0].decks], ['NITKA'])
        self.assertEqual(len(found[0].decks[0]['ring']), 5)
        self.assertEqual(len(found[0].extra_pads), 1)

    def test_aprons_and_taxiways_keep_their_surface_tag(self):
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        runway = runway_way(12, LAT0, LON0, first_node=300)
        apron, apron_nodes = aerodrome_way(14, LAT0, LON0, 60.0, {}, first_node=500)
        apron['tags'] = {'aeroway': 'apron', 'surface': 'concrete:plates'}
        taxi, taxi_nodes = way_from_bearing(15, 0.0, 300.0, {'aeroway': 'taxiway'})
        taxi['nodes'] = [600, 601]
        taxi_nodes = {600: taxi_nodes[1], 601: taxi_nodes[2]}
        found = assemble_airfields(elements_and_nodes(
            field, runway, (apron, apron_nodes), (taxi, taxi_nodes)))
        self.assertEqual(found[0].aprons[0].get('surface'), 'concrete:plates')
        self.assertNotIn('surface', found[0].taxiways[0])

    def test_an_arresting_wire_goes_with_its_aerodrome(self):
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        runway = runway_way(12, LAT0, LON0, first_node=300)
        wire, wire_nodes = way_from_bearing(
            13, 0.0, 36.0, {'barrier': 'cable_barrier', 'material': 'wire', 'name': 'Svetlana-2'})
        wire['nodes'] = [400, 401]
        wire_nodes = {400: wire_nodes[1], 401: wire_nodes[2]}
        found = assemble_airfields(elements_and_nodes(field, runway, (wire, wire_nodes)))
        self.assertEqual(len(found), 1)
        self.assertEqual(len(found[0].arresting_wires), 1)
        self.assertEqual(found[0].arresting_wires[0]['name'], 'Svetlana-2')
        self.assertEqual(len(found[0].arresting_wires[0]['points']), 2)

    def test_an_embankment_goes_with_its_aerodrome_and_keeps_a_believable_height(self):
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        runway = runway_way(12, LAT0, LON0, first_node=300)
        bank, bank_nodes = way_from_bearing(13, 90.0, 40.0, {'man_made': 'embankment', 'height': '4'})
        bank['nodes'] = [400, 401]
        bank_nodes = {400: bank_nodes[1], 401: bank_nodes[2]}
        tall, tall_nodes = way_from_bearing(14, 0.0, 40.0, {'man_made': 'embankment', 'height': '80'})
        tall['nodes'] = [500, 501]
        tall_nodes = {500: tall_nodes[1], 501: tall_nodes[2]}
        found = assemble_airfields(elements_and_nodes(
            field, runway, (bank, bank_nodes), (tall, tall_nodes)))
        self.assertEqual(len(found), 1)
        self.assertEqual(len(found[0].embankments), 2)
        self.assertEqual(found[0].embankments[0]['heightM'], 4.0)
        self.assertEqual(len(found[0].embankments[0]['points']), 2)
        self.assertNotIn('heightM', found[0].embankments[1])
        self.assertEqual(airfield_to_json(found[0])['embankments'], found[0].embankments)

    def test_an_embankment_outside_every_aerodrome_is_dropped(self):
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        runway = runway_way(12, LAT0, LON0, first_node=300)
        bank, bank_nodes = way_from_bearing(13, 90.0, 40.0, {'man_made': 'embankment'})
        bank['nodes'] = [400, 401]
        # Twenty kilometres north: beside a road, not a field.
        bank_nodes = {400: (LON0, LAT0 + 0.18), 401: (LON0 + 0.0005, LAT0 + 0.18)}
        found = assemble_airfields(elements_and_nodes(field, runway, (bank, bank_nodes)))
        self.assertEqual(found[0].embankments, [])
        self.assertNotIn('embankments', airfield_to_json(found[0]))

    def test_an_airstrip_hosts_its_runway_like_an_aerodrome(self):
        strip, strip_nodes = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Farm'}, first_node=100)
        strip['tags']['aeroway'] = 'airstrip'
        runway = runway_way(12, LAT0, LON0, first_node=300)
        found = assemble_airfields(elements_and_nodes((strip, strip_nodes), runway))
        self.assertEqual([a.name for a in found], ['Farm'])
        self.assertEqual(len(found[0].perimeter) > 0, True)

    def test_a_taxilane_is_laid_as_a_taxiway(self):
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        runway = runway_way(12, LAT0, LON0, first_node=300)
        lane, lane_nodes = way_from_bearing(15, 0.0, 120.0, {'aeroway': 'taxilane'})
        lane['nodes'] = [600, 601]
        lane_nodes = {600: lane_nodes[1], 601: lane_nodes[2]}
        found = assemble_airfields(elements_and_nodes(field, runway, (lane, lane_nodes)))
        self.assertEqual(len(found[0].taxiways), 1)
        self.assertTrue(found[0].taxiways[0]['taxilane'])

    def test_a_helipad_node_is_a_default_square_and_an_area_keeps_its_outline(self):
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        runway = runway_way(12, LAT0, LON0, first_node=300)
        lat, lon = offset(LAT0, LON0, 0.0, 400.0)
        node = {'type': 'node', 'id': 700, 'lat': lat, 'lon': lon,
                'tags': {'aeroway': 'helipad', 'ref': 'H1'}}
        area, area_nodes = aerodrome_way(16, *offset(LAT0, LON0, 0.0, -400.0), 15.0, {}, first_node=800)
        area['tags'] = {'aeroway': 'helipad', 'surface': 'concrete'}
        found = assemble_airfields(elements_and_nodes(field, runway, node, (area, area_nodes)))
        pads = found[0].helipads
        self.assertEqual(len(pads), 2)
        self.assertEqual((pads[0]['widthM'], pads[0]['ref']), (20.0, 'H1'))
        self.assertAlmostEqual(pads[1]['widthM'], 30.0, delta=0.5)
        self.assertEqual(pads[1]['surface'], 'concrete')
        self.assertEqual(airfield_to_json(found[0])['helipads'], pads)

    def test_a_holding_position_node_becomes_a_bar_across_its_taxiway(self):
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        runway = runway_way(12, LAT0, LON0, first_node=300)
        taxi, taxi_nodes = way_from_bearing(15, 0.0, 300.0, {'aeroway': 'taxiway', 'width': '20'},
                                            lat=offset(LAT0, LON0, 0.0, 200.0)[0])
        taxi['nodes'] = [600, 601]
        taxi_nodes = {600: taxi_nodes[1], 601: taxi_nodes[2]}
        lat, lon = offset(LAT0, LON0, 3.0, 150.0)
        hold = {'type': 'node', 'id': 700, 'lat': lat, 'lon': lon,
                'tags': {'aeroway': 'holding_position'}}
        lat, lon = offset(LAT0, LON0, 0.0, -900.0)
        lost = {'type': 'node', 'id': 701, 'lat': lat, 'lon': lon,
                'tags': {'aeroway': 'holding_position'}}
        found = assemble_airfields(elements_and_nodes(field, runway, (taxi, taxi_nodes), hold, lost))
        holds = found[0].holding_positions
        self.assertEqual(len(holds), 1)
        self.assertEqual(holds[0]['kind'], 'runway')
        (a_lat, a_lon), (b_lat, b_lon) = holds[0]['points']
        frame = LocalFrame(LAT0, LON0)
        ae, an = frame.to_m(a_lon, a_lat)
        be, bn = frame.to_m(b_lon, b_lat)
        # Across a north-south taxiway: east-west, as wide as it, on its centreline.
        self.assertAlmostEqual(abs(be - ae), 20.0, delta=0.1)
        self.assertAlmostEqual(an, bn, delta=0.1)
        self.assertAlmostEqual((ae + be) / 2, 0.0, delta=0.1)

    def test_a_papi_takes_the_heading_of_the_runway_it_stands_beside(self):
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        runway = runway_way(12, LAT0, LON0, first_node=300)
        lat, lon = offset(LAT0, LON0, -400.0, 60.0)
        papi = {'type': 'node', 'id': 700, 'lat': lat, 'lon': lon,
                'tags': {'aeroway': 'navigationaid', 'navigationaid': 'PAPI'}}
        lat, lon = offset(LAT0, LON0, 0.0, 1500.0)
        far = {'type': 'node', 'id': 701, 'lat': lat, 'lon': lon,
               'tags': {'aeroway': 'navigationaid', 'navigationaid': 'vasi'}}
        edge = {'type': 'node', 'id': 702, 'lat': LAT0, 'lon': LON0,
                'tags': {'aeroway': 'navigationaid', 'navigationaid': 'rwe'}}
        found = assemble_airfields(elements_and_nodes(field, runway, papi, far, edge))
        # The edge light is one of thousands and not kept.
        papi_out, far_out = found[0].navigation_aids
        self.assertEqual(papi_out['type'], 'papi')
        self.assertAlmostEqual(papi_out['headingDeg'], found[0].runways[0].heading_deg)
        self.assertNotIn('headingDeg', far_out)

    def test_windsocks_stands_gates_bridges_and_fuel_go_with_their_aerodrome(self):
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'Saki'}, first_node=100)
        runway = runway_way(12, LAT0, LON0, first_node=300)

        def point(node_id, tags):
            lat, lon = offset(LAT0, LON0, 50.0, 300.0)
            return {'type': 'node', 'id': node_id, 'lat': lat, 'lon': lon, 'tags': tags}
        bridge, bridge_nodes = way_from_bearing(15, 90.0, 30.0, {'aeroway': 'jet_bridge'})
        bridge['nodes'] = [600, 601]
        bridge_nodes = {600: bridge_nodes[1], 601: bridge_nodes[2]}
        stand, stand_nodes = way_from_bearing(16, 0.0, 60.0, {'aeroway': 'parking_position', 'ref': '12'})
        stand['nodes'] = [610, 611]
        stand_nodes = {610: stand_nodes[1], 611: stand_nodes[2]}
        found = assemble_airfields(elements_and_nodes(
            field, runway, (bridge, bridge_nodes), (stand, stand_nodes),
            point(700, {'aeroway': 'windsock', 'lit': 'yes'}),
            point(701, {'aeroway': 'gate', 'ref': 'A3'}),
            point(702, {'aeroway': 'fuel'})))
        a = found[0]
        self.assertEqual(a.windsocks[0]['lit'], True)
        self.assertEqual(a.gates[0]['ref'], 'A3')
        self.assertEqual(len(a.fuel), 1)
        self.assertEqual(a.jet_bridges[0]['widthM'], 3.0)
        self.assertEqual((a.parking_positions[0]['ref'], len(a.parking_positions[0]['points'])), ('12', 2))
        out = airfield_to_json(a)
        for key in ('windsocks', 'gates', 'fuel', 'jetBridges', 'parkingPositions'):
            self.assertIn(key, out)
        self.assertNotIn('helipads', out)

    def test_first_listed_polygon_wins_when_two_contain_the_runway(self):
        outer = aerodrome_way(10, LAT0, LON0, 6000.0, {'name': 'outer'}, first_node=100)
        inner = aerodrome_way(11, LAT0, LON0, 2000.0, {'name': 'inner'}, first_node=200)
        runway = runway_way(12, LAT0, LON0, first_node=300)
        for order in ((outer, inner), (inner, outer)):
            found = assemble_airfields(elements_and_nodes(*order, runway))
            self.assertEqual([a.name for a in found], [order[0][0]['tags']['name']])
            self.assertEqual(len(found[0].runways), 1)

    def test_a_polygon_beats_a_nearer_node(self):
        field = aerodrome_way(10, LAT0, LON0, 3000.0, {'name': 'polygon'}, first_node=100)
        lat_n, lon_n = offset(LAT0, LON0, 500.0, 0.0)
        near = aerodrome_node(20, lat_n, lon_n, {'name': 'node'})
        runway = runway_way(12, LAT0, LON0, first_node=300)
        found = assemble_airfields(elements_and_nodes(near, field, runway))
        self.assertEqual([a.name for a in found], ['polygon'])

    def test_nearest_node_within_radius_wins_regardless_of_order(self):
        lat_a, lon_a = offset(LAT0, LON0, 0.0, 4000.0)
        lat_b, lon_b = offset(LAT0, LON0, -3000.0, 0.0)
        far = aerodrome_node(20, lat_a, lon_a, {'name': 'four km north'})
        near = aerodrome_node(21, lat_b, lon_b, {'name': 'three km west'})
        runway = runway_way(12, LAT0, LON0, first_node=300)
        for order in ((far, near), (near, far)):
            found = assemble_airfields(elements_and_nodes(*order, runway))
            self.assertEqual([a.name for a in found], ['three km west'])

    def test_earlier_node_wins_a_tie(self):
        # Two nodes mapped on the same spot (it happens: a duplicated import)
        # are the only exact tie - anywhere else each node measures in its
        # own frame and one of them is a hair closer.
        lat_a, lon_a = offset(LAT0, LON0, 0.0, 2000.0)
        north = aerodrome_node(20, lat_a, lon_a, {'name': 'north'})
        south = aerodrome_node(21, lat_a, lon_a, {'name': 'south'})
        runway = runway_way(12, LAT0, LON0, first_node=300)
        for order in ((north, south), (south, north)):
            found = assemble_airfields(elements_and_nodes(*order, runway))
            self.assertEqual([a.name for a in found], [order[0]['tags']['name']])

    def test_a_runway_beyond_the_radius_becomes_its_own_airstrip(self):
        lat_a, lon_a = offset(LAT0, LON0, 0.0, ORPHAN_ASSIGN_RADIUS_M + 200.0)
        node = aerodrome_node(20, lat_a, lon_a, {'name': 'too far'})
        runway = runway_way(12, LAT0, LON0, first_node=300)
        found = assemble_airfields(elements_and_nodes(node, runway))
        self.assertEqual([a.name for a in found], ['airstrip 12'])
        self.assertEqual(found[0].kind, 'ga')

    def test_radius_is_measured_in_the_node_frame_just_inside_and_just_outside(self):
        # The candidate box is a hair wider than the radius; the metric test
        # is what decides, so 4990 m attaches and 5010 m does not, east or north.
        for east, north, expect in ((4990.0, 0.0, 'node'), (0.0, 4990.0, 'node'),
                                    (5010.0, 0.0, 'airstrip 12'), (0.0, 5010.0, 'airstrip 12')):
            lat_a, lon_a = offset(LAT0, LON0, east, north)
            node = aerodrome_node(20, lat_a, lon_a, {'name': 'node'})
            runway = runway_way(12, LAT0, LON0, first_node=300)
            found = assemble_airfields(elements_and_nodes(node, runway))
            self.assertEqual([a.name for a in found], [expect], (east, north))

    def test_index_answers_none_with_no_aerodromes_at_all(self):
        self.assertIsNone(AerodromeIndex([]).owner(LON0, LAT0))


class LandMaskLruTest(unittest.TestCase):

    def test_is_land_refreshes_recency_and_evicts_the_oldest(self):
        reads = []
        original = bake_osm_airports.read_lwm
        bake_osm_airports.read_lwm = lambda out_dir, zoom, x, y: reads.append((x, y)) or None
        try:
            mask = LandMask('nowhere', 12, 257)
            mask._cache_cap = 2
            span = mask.span
            top = 90.0 - 0.5 * span
            mask.is_land(-180.0 + 0.5 * span, top)   # (0, 0)
            mask.is_land(-180.0 + 1.5 * span, top)   # (1, 0)
            mask.is_land(-180.0 + 0.5 * span, top)   # (0, 0) again: now newest, no read
            mask.is_land(-180.0 + 2.5 * span, top)   # (2, 0) evicts (1, 0), not (0, 0)
            self.assertEqual(list(mask._cache), [(0, 0), (2, 0)])
            self.assertEqual(reads, [(0, 0), (1, 0), (2, 0)])
        finally:
            bake_osm_airports.read_lwm = original


class StageProgressTest(unittest.TestCase):
    # The importer's regex, verbatim from tools/areaImport.ts parseProgress.
    PCT = re.compile(r'\((\d+(?:\.\d+)?)%(?: of stage)?\)')

    def run_phases(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            p = StageProgress([('a', 'first', 1), ('b', 'second', 1), ('c', 'third', 2)],
                              min_interval_s=0.0)
            p.begin('a')
            p.update(0.5, '1/2')
            p.end('done')
            p.skip('b', 'not needed')
            p.begin('c')
            p.update(0.25)
            p.end()
        return buf.getvalue().splitlines()

    def test_lines_carry_the_percentage_the_importer_reads(self):
        lines = self.run_phases()
        self.assertEqual(lines[0], 'phase 1/3  first')
        self.assertEqual(lines[1], '  first 1/2  (12.5% of stage)')
        self.assertIn('phase 2/3  second - skipped, not needed', lines)
        pcts = [float(m.group(1)) for m in map(self.PCT.search, lines) if m]
        self.assertEqual(pcts, sorted(pcts))
        self.assertEqual(pcts[-1], 100.0)
        # The skipped phase's weight is gone: `c` alone is two thirds of what
        # is left, and a quarter of it lands at 1/3 + 2/3 * 1/4.
        self.assertIn('  third  (50.0% of stage)', lines)

    def test_skipping_the_running_phase_leaves_nothing_in_flight(self):
        with contextlib.redirect_stdout(io.StringIO()):
            p = StageProgress([('a', 'first', 1), ('b', 'second', 1)], min_interval_s=0.0)
            p.begin('a')
            p.update(0.5)
            p.skip('a', 'failed')
            self.assertEqual(p.percent(), 0.0)
            p.begin('b')
            p.end()
            self.assertEqual(p.percent(), 100.0)



class ExitCodeTest(unittest.TestCase):
    def test_partial_is_distinct_from_failure(self):
        # The importer keys on this: 2 is "manifest written, an area's
        # airfields carried over because Overpass failed", 1 is a broken bake.
        self.assertEqual(bake_osm_airports.EXIT_PARTIAL, 2)
        self.assertNotIn(bake_osm_airports.EXIT_PARTIAL, (0, 1))

if __name__ == '__main__':
    unittest.main()


class BboxAreaNameTest(unittest.TestCase):
    """A chunk of an importer area is tagged with that area, not 'bbox'."""

    MANIFEST = {'areas': [
        {'name': 'DACH', 'west': 5.0, 'south': 45.0, 'east': 17.0, 'north': 53.0},
        {'name': 'inner', 'west': 10.0, 'south': 47.0, 'east': 12.0, 'north': 49.0},
    ]}

    def test_exact_bounds_name_the_area(self):
        from bake_osm_airports import Bounds, bbox_area_name
        self.assertEqual(bbox_area_name(self.MANIFEST, Bounds(10.0, 47.0, 12.0, 49.0)), 'inner')

    def test_a_chunk_names_the_smallest_area_holding_it(self):
        from bake_osm_airports import Bounds, bbox_area_name
        self.assertEqual(bbox_area_name(self.MANIFEST, Bounds(6.0, 46.0, 8.0, 48.0)), 'DACH')
        self.assertEqual(bbox_area_name(self.MANIFEST, Bounds(10.5, 47.5, 11.5, 48.5)), 'inner')

    def test_a_box_outside_every_area_is_still_bbox(self):
        from bake_osm_airports import Bounds, bbox_area_name
        self.assertEqual(bbox_area_name(self.MANIFEST, Bounds(-16.0, 27.0, -15.0, 28.0)), 'bbox')
        self.assertEqual(bbox_area_name(self.MANIFEST, Bounds(16.0, 52.0, 18.0, 54.0)), 'bbox')

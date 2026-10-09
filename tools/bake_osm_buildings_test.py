"""Tests for tools/bake_osm_buildings.py: tag parsing, assembly, filing and the BVR1 format."""
from __future__ import annotations

import math
import unittest

from bake_osm_buildings import (
    KIND_AIRFIELD, KIND_CIVIC, KIND_HOUSE, KIND_RELIGIOUS, KIND_YES, ORIENTATION_ACROSS, ROOF_SHAPES,
    Building, assemble_buildings, building_kind, building_tag_predicate, buildings_by_tile,
    decode_bvr, encode_bvr, parse_colour, parse_count, parse_direction_deg, parse_length_m,
)
from osm_common import Bounds, tile_bounds


def _node(nid: int, lon: float, lat: float) -> dict:
    return {'type': 'node', 'id': nid, 'lon': lon, 'lat': lat}


def _way(wid: int, nodes, **tags) -> dict:
    return {'type': 'way', 'id': wid, 'nodes': list(nodes), 'tags': tags}


# A 10 x 10 m-ish square at 47 N (1e-4 deg lat = 11 m, 1.3e-4 deg lon = 10 m).
def _square(base: int, lon: float, lat: float, size: float = 1e-4):
    return [
        _node(base + 0, lon, lat), _node(base + 1, lon + 1.3 * size, lat),
        _node(base + 2, lon + 1.3 * size, lat + size), _node(base + 3, lon, lat + size),
    ]


class Parse(unittest.TestCase):
    def test_lengths(self):
        self.assertAlmostEqual(parse_length_m('12'), 12.0)
        self.assertAlmostEqual(parse_length_m('12.5 m'), 12.5)
        self.assertAlmostEqual(parse_length_m('7,5'), 7.5)
        self.assertAlmostEqual(parse_length_m('30 ft'), 9.144)
        self.assertAlmostEqual(parse_length_m("10'6\""), 3.2004, places=4)
        self.assertTrue(math.isnan(parse_length_m('tall')))
        self.assertTrue(math.isnan(parse_length_m(None)))

    def test_counts_and_directions(self):
        self.assertEqual(parse_count('2'), 2.0)
        self.assertEqual(parse_count('2;3'), 2.0)
        self.assertTrue(math.isnan(parse_count('many')))
        self.assertEqual(parse_direction_deg('SW'), 225.0)
        self.assertEqual(parse_direction_deg('370'), 10.0)

    def test_colours(self):
        self.assertEqual(parse_colour('#a00'), 0xaa0000)
        self.assertEqual(parse_colour('#8B4513'), 0x8b4513)
        self.assertEqual(parse_colour('Dark Red'), 0x8b0000)
        self.assertEqual(parse_colour('terracotta'), 0xc0603c)
        self.assertEqual(parse_colour('rainbow'), -1)

    def test_kinds(self):
        self.assertEqual(building_kind({'building': 'detached'}), KIND_HOUSE)
        self.assertEqual(building_kind({'building': 'yes', 'amenity': 'place_of_worship'}), KIND_RELIGIOUS)
        self.assertEqual(building_kind({'building': 'yes', 'amenity': 'school'}), KIND_CIVIC)
        self.assertEqual(building_kind({'building': 'yes'}), KIND_YES)

    def test_predicate(self):
        self.assertTrue(building_tag_predicate({'building': 'yes'}))
        self.assertFalse(building_tag_predicate({'building': 'no'}))
        self.assertFalse(building_tag_predicate({'building': 'yes', 'location': 'underground'}))
        self.assertFalse(building_tag_predicate({'building:part': 'yes'}))


class Assemble(unittest.TestCase):
    def test_closed_ways_become_buildings_with_tags(self):
        data = {'elements': [
            *_square(1, 11.0, 47.0),
            _way(100, [1, 2, 3, 4, 1], building='house', **{
                'roof:shape': 'gabled', 'roof:orientation': 'across', 'building:levels': '2',
                'roof:colour': 'red'}),
            *_square(11, 11.01, 47.0, size=1e-5),  # ~1 m^2: dropped
            _way(101, [11, 12, 13, 14, 11], building='shed'),
            _way(102, [1, 2, 3], building='yes'),  # not closed: dropped
            _way(103, [1, 2, 3, 4, 1], building='yes', aeroway='hangar'),  # the airfield draws it
        ]}
        got = assemble_buildings(data)
        self.assertEqual(len(got), 2)
        self.assertEqual(next(b for b in got if b.osm_id == 103).kind, KIND_AIRFIELD)
        b = next(b for b in got if b.osm_id == 100)
        self.assertEqual(b.osm_id, 100)
        self.assertEqual(b.kind, KIND_HOUSE)
        self.assertEqual(b.roof_shape, ROOF_SHAPES['gabled'])
        self.assertEqual(b.roof_orientation, ORIENTATION_ACROSS)
        self.assertEqual(b.levels, 2.0)
        self.assertEqual(b.roof_colour, 0xff0000)
        self.assertEqual(len(b.rings), 1)
        self.assertEqual(len(b.rings[0]), 4)  # open ring

    def test_multipolygon_keeps_its_courtyard(self):
        outer = [_node(1, 11.0, 47.0), _node(2, 11.001, 47.0), _node(3, 11.001, 47.001), _node(4, 11.0, 47.001)]
        inner = [_node(5, 11.0004, 47.0004), _node(6, 11.0006, 47.0004), _node(7, 11.0006, 47.0006),
                 _node(8, 11.0004, 47.0006)]
        data = {'elements': [
            *outer, *inner,
            _way(10, [1, 2, 3, 4, 1]), _way(11, [5, 6, 7, 8, 5]),
            {'type': 'relation', 'id': 7, 'tags': {'type': 'multipolygon', 'building': 'apartments'},
             'members': [{'type': 'way', 'ref': 10, 'role': 'outer'}, {'type': 'way', 'ref': 11, 'role': 'inner'}]},
        ]}
        got = assemble_buildings(data)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0].osm_id, -7)
        self.assertEqual(len(got[0].rings), 2)


class FileAndFormat(unittest.TestCase):
    def test_filed_by_centroid_whole(self):
        t = tile_bounds(12, 2173, 966)
        # Straddles the tile's east edge, centroid inside it.
        lon = t.east - 0.00005
        b = Building(1, 0, 0, 0, math.nan, math.nan, math.nan, math.nan, math.nan, math.nan, -1, -1,
                     [[(lon - 0.0001, t.south + 0.01), (lon + 0.00008, t.south + 0.01),
                       (lon + 0.00008, t.south + 0.0101), (lon - 0.0001, t.south + 0.0101)]])
        owned = buildings_by_tile([b], 12, Bounds(t.west, t.south, t.east + 0.1, t.north))
        self.assertEqual(list(owned), [(2173, 966)])
        self.assertEqual(len(owned[(2173, 966)][0].rings[0]), 4)

    def test_round_trip(self):
        b = Building(-42, 1, 2, 1, 9.5, math.nan, 2.0, 3.0, math.nan, 225.0, 0xaa0000, -1,
                     [[(11.0, 47.0), (11.0001, 47.0), (11.0001, 47.0001)],
                      [(11.00002, 47.00002), (11.00004, 47.00002), (11.00004, 47.00004)]])
        got = decode_bvr(encode_bvr([b]))
        self.assertEqual(len(got), 1)
        g = got[0]
        self.assertEqual((g.osm_id, g.kind, g.roof_shape, g.roof_orientation), (-42, 1, 2, 1))
        self.assertAlmostEqual(g.height, 9.5)
        self.assertTrue(math.isnan(g.min_height))
        self.assertEqual(g.roof_colour, 0xaa0000)
        self.assertEqual(g.wall_colour, -1)
        self.assertEqual(len(g.rings), 2)
        self.assertAlmostEqual(g.rings[0][1][0], 11.0001, places=7)
        self.assertAlmostEqual(g.rings[1][2][1], 47.00004, places=7)


if __name__ == '__main__':
    unittest.main()

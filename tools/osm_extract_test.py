"""Tests for tools/osm_extract.py: picking the smallest covering Geofabrik region."""
from __future__ import annotations

import unittest

from osm_extract import _geometry_bbox, find_region, parse_bbox


def _feature(id_, west, south, east, north, pbf='https://example.test/x.osm.pbf'):
    return {
        'properties': {'id': id_, 'name': id_, 'urls': {'pbf': pbf}},
        'geometry': {
            'type': 'Polygon',
            'coordinates': [[
                [west, south], [east, south], [east, north], [west, north], [west, south],
            ]],
        },
    }


class ParseBbox(unittest.TestCase):
    def test_reads_four_comma_separated_numbers(self):
        self.assertEqual(parse_bbox('7.6,45.9,7.8,46.0'), (7.6, 45.9, 7.8, 46.0))

    def test_rejects_the_wrong_count(self):
        with self.assertRaises(ValueError):
            parse_bbox('1,2,3')


class GeometryBbox(unittest.TestCase):
    def test_reads_a_polygon(self):
        self.assertEqual(
            _geometry_bbox({'type': 'Polygon', 'coordinates': [[[0, 0], [2, 0], [2, 3], [0, 3], [0, 0]]]}),
            (0, 0, 2, 3),
        )

    def test_reads_every_ring_of_a_multipolygon(self):
        geom = {
            'type': 'MultiPolygon',
            'coordinates': [
                [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
                [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]],
            ],
        }
        self.assertEqual(_geometry_bbox(geom), (0, 0, 6, 6))

    def test_ignores_a_point_or_line(self):
        self.assertIsNone(_geometry_bbox({'type': 'Point', 'coordinates': [1, 2]}))


class FindRegion(unittest.TestCase):
    def test_picks_the_smallest_region_that_fully_contains_the_bbox(self):
        index = {'features': [
            _feature('europe', -30, 30, 45, 75),
            _feature('switzerland', 5.9, 45.8, 10.5, 47.9),
            _feature('france', -5.5, 41, 9.9, 51.5),
        ]}
        region = find_region(index, (7.6, 45.9, 7.8, 46.0))
        self.assertEqual(region['id'], 'switzerland')

    def test_rejects_a_region_that_only_partially_overlaps(self):
        index = {'features': [_feature('france', -5.5, 41, 5.0, 51.5)]}
        with self.assertRaises(LookupError):
            find_region(index, (7.6, 45.9, 7.8, 46.0))

    def test_skips_a_feature_with_no_pbf_url(self):
        no_pbf = _feature('vatican-shp-only', 12.4, 41.9, 12.5, 41.91, pbf=None)
        del no_pbf['properties']['urls']['pbf']
        index = {'features': [no_pbf, _feature('italy', 6, 36, 19, 47)]}
        region = find_region(index, (12.4, 41.9, 12.45, 41.905))
        self.assertEqual(region['id'], 'italy')


if __name__ == '__main__':
    unittest.main()

"""Tests for tools/osm_extract.py: picking the extracts that cover a bbox."""
from __future__ import annotations

import unittest

from shapely.geometry import box

from osm_extract import Source, _bbox_from_clip_name, _geometry_bbox, parse_bbox, plan_sources, regions_near


def _feature(id_, west, south, east, north, pbf='https://example.test/x.osm.pbf'):
    return {
        'properties': {'id': id_, 'name': id_, 'urls': {'pbf': pbf},
                       'parent': None if id_ == 'europe' else 'europe'},
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


def _ids(sources):
    return [s.path or s.region['id'] for s in sources]


class PlanSources(unittest.TestCase):
    # Erz in miniature: Germany west of 13.8, Czechia east of it, and a
    # DACH whose *rectangle* spans both but whose polygon is Germany plus a
    # strip south of the box (Austria) - the shape that fooled the old picker.
    GERMANY = _feature('germany', 6, 47, 13.8, 55)
    CZECHIA = _feature('czech-republic', 13.8, 48.5, 19, 51.1)
    EUROPE = _feature('europe', -30, 30, 45, 75)
    BOX = (12.0, 49.7, 15.0, 51.0)

    def dach(self):
        f = _feature('dach', 6, 46, 17, 55)
        f['geometry'] = {'type': 'MultiPolygon', 'coordinates': [
            [[[6, 47], [13.8, 47], [13.8, 55], [6, 55], [6, 47]]],
            [[[9, 46], [17, 46], [17, 49], [9, 49], [9, 46]]],
        ]}
        return f

    def near(self, *features):
        return regions_near({'features': list(features)}, self.BOX)

    def test_a_box_across_a_border_takes_the_country_on_disk_and_downloads_the_other(self):
        near = self.near(self.GERMANY, self.CZECHIA, self.EUROPE, self.dach())
        local = [Source(g, 4.8e9, path='germany.osm.pbf') for f, g in near if f['properties']['id'] == 'germany']
        local += [Source(g, 6.2e9, path='dach.osm.pbf') for f, g in near if f['properties']['id'] == 'dach']
        self.assertEqual(_ids(plan_sources(self.BOX, near, local)), ['germany.osm.pbf', 'czech-republic'])

    def test_a_rectangle_that_covers_the_box_is_not_enough(self):
        near = self.near(self.dach(), self.CZECHIA)
        self.assertEqual(sorted(_ids(plan_sources(self.BOX, near, []))), ['czech-republic', 'dach'])

    def test_a_country_beats_its_continent(self):
        box_ = (12.0, 50.0, 13.0, 51.0)
        near = regions_near({'features': [self.GERMANY, self.EUROPE]}, box_)
        self.assertEqual(_ids(plan_sources(box_, near, [])), ['germany'])

    def test_an_earlier_clip_beats_the_country_on_disk(self):
        box_ = (12.3, 50.5, 12.7, 50.8)
        near = regions_near({'features': [self.GERMANY]}, box_)
        local = [Source(near[0][1], 4.8e9, path='germany.osm.pbf'),
                 Source(box(12.0, 50.0, 14.0, 52.0), 2e8, path='clip.osm.pbf')]
        self.assertEqual(_ids(plan_sources(box_, near, local)), ['clip.osm.pbf'])

    def test_open_sea_in_the_box_needs_no_extract(self):
        box_ = (13.0, 54.0, 15.0, 56.0)  # half of it north of every region
        near = regions_near({'features': [self.GERMANY]}, box_)
        self.assertEqual(_ids(plan_sources(box_, near, [])), ['germany'])

    def test_sea_only_the_continent_reaches_needs_no_extract(self):
        box_ = (13.0, 54.0, 15.0, 56.0)  # Europe's polygon covers the sea north of Germany
        near = regions_near({'features': [self.GERMANY, self.EUROPE]}, box_)
        self.assertEqual(_ids(plan_sources(box_, near, [])), ['germany'])

    def test_no_region_near_the_box_is_an_error(self):
        with self.assertRaises(LookupError):
            plan_sources((100, 0, 101, 1), [], [])

    def test_skips_a_feature_with_no_pbf_url(self):
        no_pbf = _feature('vatican-shp-only', 12.4, 41.9, 12.5, 41.91, pbf=None)
        del no_pbf['properties']['urls']['pbf']
        self.assertEqual([f['properties']['id'] for f, _ in
                          regions_near({'features': [no_pbf]}, (12.4, 41.9, 12.45, 41.905))], [])


class BboxFromClipName(unittest.TestCase):
    def test_reads_negative_coordinates(self):
        self.assertEqual(
            _bbox_from_clip_name('-15.9_27.6_-15.2_28.2.osm.pbf'), (-15.9, 27.6, -15.2, 28.2))

    def test_ignores_a_partial_or_foreign_file(self):
        self.assertIsNone(_bbox_from_clip_name('1_2_3_4.osm.pbf.part'))
        self.assertIsNone(_bbox_from_clip_name('lisbon.osm.pbf'))


if __name__ == '__main__':
    unittest.main()

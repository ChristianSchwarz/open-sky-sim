"""Tests for tools/osm_landuse.py.

No network: every test builds its own small Overpass-shaped element list or
synthetic polygon grid, matching the rest of this repo's OSM bake tests
(bake_osm_coast_test.py, bake_osm_airports_test.py) - plain unittest, no
mocking.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

import numpy as np
from shapely.geometry import box

from osm_landuse import (
    CLS_BARE,
    CLS_BUILT,
    CLS_CROP,
    CLS_GRASS,
    CLS_SHRUB,
    CLS_SNOW,
    CLS_TREE,
    CLS_WETLAND,
    LANDUSE_TAG_TO_CLASS,
    _BUILT_TAGS,
    _VEGETATION_TAGS,
    _query_for,
    _reject_if_empty,
    assemble_landuse_polygons,
    build_landuse_index,
    overpass_landuse_query,
    stamp_landuse_classes,
)
from osm_common import Bounds

ALLOWED_CLASSES = {
    CLS_TREE, CLS_SHRUB, CLS_GRASS, CLS_CROP, CLS_BUILT, CLS_BARE, CLS_SNOW, CLS_WETLAND,
}
# The three ids this module must never assign: the coastline bake owns
# land/water geometrically, and Sand is bake-assigned downstream in the mesh
# bake's shore-adjacency logic.
FORBIDDEN_CLASSES = {0, 8, 12}  # CLS_UNKNOWN, CLS_WATER, CLS_SAND


class TagTableTest(unittest.TestCase):

    def test_every_class_is_one_this_module_is_allowed_to_emit(self):
        for _key, _value, cls in LANDUSE_TAG_TO_CLASS:
            self.assertIn(cls, ALLOWED_CLASSES)
            self.assertNotIn(cls, FORBIDDEN_CLASSES)

    def test_vegetation_and_built_groups_partition_the_full_table(self):
        self.assertEqual(_VEGETATION_TAGS + _BUILT_TAGS, LANDUSE_TAG_TO_CLASS)
        self.assertEqual(len(set(_VEGETATION_TAGS) & set(_BUILT_TAGS)), 0)

    def test_query_for_contains_expected_overpass_clauses(self):
        b = Bounds(-15.65, 27.90, -15.55, 28.00)
        query = _query_for([('landuse', 'farmland', CLS_CROP)], b)
        self.assertIn('way["landuse"="farmland"](27.9,-15.65,28.0,-15.55);', query)
        self.assertIn('relation["landuse"="farmland"](27.9,-15.65,28.0,-15.55);', query)


def _square_way(way_id: int, tags: dict, west: float, south: float,
                east: float, north: float, node_id0: int) -> tuple:
    """A closed 4-node way around a rectangle, and its node dict."""
    ring = [(west, south), (east, south), (east, north), (west, north), (west, south)]
    node_ids = list(range(node_id0, node_id0 + len(ring)))
    nodes = dict(zip(node_ids, ring))
    return {'type': 'way', 'id': way_id, 'nodes': node_ids, 'tags': tags}, nodes


class AssembleLandusePolygonsTest(unittest.TestCase):

    def test_tagged_closed_ways_become_classed_polygons(self):
        farm_way, farm_nodes = _square_way(
            1, {'landuse': 'farmland'}, 0.0, 0.0, 1.0, 1.0, 100)
        wood_way, wood_nodes = _square_way(
            2, {'natural': 'wood'}, 2.0, 0.0, 3.0, 1.0, 200)
        untagged_way, untagged_nodes = _square_way(
            3, {'highway': 'residential'}, 4.0, 0.0, 5.0, 1.0, 300)

        elements = [farm_way, wood_way, untagged_way]
        for nodes in (farm_nodes, wood_nodes, untagged_nodes):
            for nid, (lon, lat) in nodes.items():
                elements.append({'type': 'node', 'id': nid, 'lon': lon, 'lat': lat})

        polys, classes = assemble_landuse_polygons({'elements': elements})

        self.assertEqual(len(polys), 2)
        self.assertEqual(sorted(classes), sorted([CLS_CROP, CLS_TREE]))
        for poly in polys:
            self.assertTrue(poly.is_valid)
            self.assertGreater(poly.area, 0)


class StampLanduseClassesTest(unittest.TestCase):
    BOUNDS = (0.0, 0.0, 1.0, 1.0)
    SIZE = 21  # 21x21 nodes over a 1deg tile, 0.05deg apart.

    def grid(self):
        return np.full((self.SIZE, self.SIZE), CLS_GRASS, dtype=np.uint8)

    def test_a_smaller_polygon_wins_the_pixels_it_shares_with_a_larger_one(self):
        big = box(0.1, 0.1, 0.9, 0.9)
        small = box(0.4, 0.4, 0.6, 0.6)
        polys = [big, small]
        classes_in = [CLS_TREE, CLS_BUILT]
        tree = build_landuse_index(polys)

        grid = self.grid()
        changed = stamp_landuse_classes(grid, self.BOUNDS, self.SIZE, tree, polys, classes_in)

        self.assertGreater(changed, 0)
        mid = self.SIZE // 2
        self.assertEqual(grid[mid, mid], CLS_BUILT)
        # Inside the big square but outside the small one.
        near_edge = int(0.15 / (1.0 / (self.SIZE - 1)))
        self.assertEqual(grid[near_edge, near_edge], CLS_TREE)
        # Outside both squares, untouched.
        self.assertEqual(grid[0, 0], CLS_GRASS)

    def test_no_polygons_is_a_no_op(self):
        grid = self.grid()
        tree = build_landuse_index([])
        changed = stamp_landuse_classes(grid, self.BOUNDS, self.SIZE, tree, [], [])
        self.assertEqual(changed, 0)
        self.assertTrue(np.all(grid == CLS_GRASS))


class RejectIfEmptyTest(unittest.TestCase):
    """The regression case for a real silent-truncation bug found while
    verifying the landuse-cutting mesh feature: overpass.osm.ch answered a
    real, populated Yalta bbox with a clean HTTP 200, no remark, and zero
    elements - a truncated answer indistinguishable from a genuinely bare
    bbox by status code alone.
    """

    def test_rejects_an_empty_answer(self):
        with self.assertRaises(RuntimeError):
            _reject_if_empty('vegetation/agriculture', {'elements': []})

    def test_accepts_a_populated_answer(self):
        _reject_if_empty('vegetation/agriculture', {'elements': [{'type': 'way', 'id': 1}]})


class OverpassLanduseQueryRetryTest(unittest.TestCase):
    """`overpass_landuse_query` itself, with `overpass_fetch` faked out -
    no network, deterministic - covering what the validate guard actually
    buys once wired through `overpass_fetch`'s own retry/mirror machinery
    (tested for real in osm_common_test.py).
    """

    def test_drops_a_group_that_stays_empty_after_every_retry_without_failing_the_whole_fetch(self):
        # overpass_fetch itself already retries internally; from this
        # module's point of view a group that is still empty once
        # overpass_fetch gives up raises, and that must not take the whole
        # bake down with it - the other group's real elements still come
        # through.
        def fake_fetch(query, label, refresh, validate=None, **_extra):
            if 'vegetation' in label:
                if validate is not None:
                    validate({'elements': []})  # exercises the same rejection path
                raise RuntimeError('all Overpass mirrors failed: vegetation stayed empty')
            return {'elements': [{'type': 'way', 'id': 42}]}

        # The fetch is made per grid cell through osm_common's client, so
        # that is what gets faked; every cell of the built group answers
        # the same way 42, which the union keeps once.
        with patch('osm_common.overpass_fetch', side_effect=fake_fetch):
            data = overpass_landuse_query((0.0, 0.0, 1.0, 1.0))
        self.assertEqual(data['elements'], [{'type': 'way', 'id': 42}])

    def test_a_genuinely_populated_response_is_never_rejected(self):
        def fake_fetch(query, label, refresh, validate=None, **_extra):
            # One way per group, the same one from every cell of that group.
            data = {'elements': [{'type': 'way', 'id': 1 if 'vegetation' in label else 2}]}
            if validate is not None:
                validate(data)  # must not raise
            return data

        with patch('osm_common.overpass_fetch', side_effect=fake_fetch):
            data = overpass_landuse_query((0.0, 0.0, 1.0, 1.0))
        self.assertEqual(len(data['elements']), 2, 'one element from each of the two groups')


if __name__ == '__main__':
    unittest.main()

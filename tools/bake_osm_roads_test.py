"""Tests for tools/bake_osm_roads.py: chaining, the class cut, the clip and the file format."""
from __future__ import annotations

import unittest

from shapely.strtree import STRtree

from bake_osm_roads import (
    CLASS_BYTE,
    FALLBACK_WIDTH_M,
    Bounds,
    assemble_roads,
    class_cut_for_zoom,
    clip_roads,
    decode_rvr,
    encode_rvr,
    road_class,
    road_width_m,
)


def _node(nid: int, lon: float, lat: float) -> dict:
    return {'type': 'node', 'id': nid, 'lon': lon, 'lat': lat}


def _way(wid: int, nodes, **tags) -> dict:
    return {'type': 'way', 'id': wid, 'nodes': list(nodes), 'tags': tags}


class ClassAndWidth(unittest.TestCase):
    def test_links_fold_into_their_parent_class(self):
        self.assertEqual(road_class({'highway': 'motorway_link'}), 'motorway')
        self.assertEqual(road_class({'highway': 'primary'}), 'primary')

    def test_unwanted_kinds_are_dropped(self):
        for kind in ('service', 'track', 'path', 'footway', 'cycleway', 'living_street'):
            self.assertIsNone(road_class({'highway': kind}), kind)
        self.assertIsNone(road_class({'highway': 'residential', 'area': 'yes'}))

    def test_width_prefers_tag_then_lanes_then_fallback(self):
        self.assertEqual(road_width_m({'width': '14 m'}, 'primary'), 14.0)
        self.assertEqual(road_width_m({'lanes': '4'}, 'primary'), 14.0)
        self.assertEqual(road_width_m({}, 'primary'), FALLBACK_WIDTH_M['primary'])

    def test_class_cut_thins_with_zoom(self):
        self.assertIsNone(class_cut_for_zoom(7))
        self.assertEqual(class_cut_for_zoom(8), CLASS_BYTE['trunk'])
        self.assertEqual(class_cut_for_zoom(10), CLASS_BYTE['secondary'])
        self.assertEqual(class_cut_for_zoom(12), CLASS_BYTE['residential'])
        self.assertEqual(class_cut_for_zoom(15), CLASS_BYTE['residential'])


class Chaining(unittest.TestCase):
    def test_two_ways_meeting_end_to_end_become_one_run(self):
        data = {'elements': [
            _node(1, 0.0, 0.0), _node(2, 1.0, 0.0), _node(3, 2.0, 0.0),
            _way(10, [1, 2], highway='primary'),
            _way(11, [2, 3], highway='primary'),
        ]}
        roads = assemble_roads(data)
        self.assertEqual(len(roads), 1)
        self.assertEqual(list(roads[0].line.coords), [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)])
        self.assertEqual(roads[0].cls, CLASS_BYTE['primary'])

    def test_a_way_pointing_the_other_way_is_reversed_into_the_run(self):
        data = {'elements': [
            _node(1, 0.0, 0.0), _node(2, 1.0, 0.0), _node(3, 2.0, 0.0),
            _way(10, [1, 2], highway='primary'),
            _way(11, [3, 2], highway='primary'),
        ]}
        roads = assemble_roads(data)
        self.assertEqual(len(roads), 1)
        self.assertEqual(len(roads[0].line.coords), 3)

    def test_a_junction_ends_the_run(self):
        data = {'elements': [
            _node(1, 0.0, 0.0), _node(2, 1.0, 0.0), _node(3, 2.0, 0.0), _node(4, 1.0, 1.0),
            _way(10, [1, 2], highway='primary'),
            _way(11, [2, 3], highway='primary'),
            _way(12, [2, 4], highway='primary'),
        ]}
        roads = assemble_roads(data)
        self.assertEqual(len(roads), 3)

    def test_different_classes_never_chain(self):
        data = {'elements': [
            _node(1, 0.0, 0.0), _node(2, 1.0, 0.0), _node(3, 2.0, 0.0),
            _way(10, [1, 2], highway='primary'),
            _way(11, [2, 3], highway='secondary'),
        ]}
        roads = assemble_roads(data)
        self.assertEqual(sorted(r.cls for r in roads), [CLASS_BYTE['primary'], CLASS_BYTE['secondary']])

    def test_a_ring_road_terminates(self):
        data = {'elements': [
            _node(1, 0.0, 0.0), _node(2, 1.0, 0.0), _node(3, 1.0, 1.0),
            _way(10, [1, 2], highway='primary'),
            _way(11, [2, 3], highway='primary'),
            _way(12, [3, 1], highway='primary'),
        ]}
        roads = assemble_roads(data)
        self.assertEqual(len(roads), 1)
        coords = list(roads[0].line.coords)
        self.assertEqual(coords[0], coords[-1])
        self.assertEqual(len(coords), 4)


class ClipAndFormat(unittest.TestCase):
    def test_clip_keeps_each_crossing_part_and_sorts_by_class(self):
        data = {'elements': [
            _node(1, -1.0, 0.5), _node(2, 2.0, 0.5),
            _node(3, 0.2, -1.0), _node(4, 0.2, 0.3), _node(5, 0.2, 2.0),
            _way(10, [1, 2], highway='residential'),
            _way(11, [3, 4, 5], highway='motorway'),
        ]}
        roads = assemble_roads(data)
        tree = STRtree([r.line for r in roads])
        parts = clip_roads(roads, tree, Bounds(0.0, 0.0, 1.0, 1.0), 0.0)
        self.assertEqual([p[0] for p in parts], [CLASS_BYTE['motorway'], CLASS_BYTE['residential']])
        for _cls, _w, pts in parts:
            for lon, lat in pts:
                self.assertTrue(-1e-9 <= lon <= 1 + 1e-9 and -1e-9 <= lat <= 1 + 1e-9)

    def test_rvr_round_trip(self):
        parts = [
            (CLASS_BYTE['motorway'], 25.0, [(0.1, 0.2), (0.3, 0.4)]),
            (CLASS_BYTE['residential'], 5.0, [(0.5, 0.6), (0.7, 0.8), (0.9, 1.0)]),
        ]
        back = decode_rvr(encode_rvr(parts))
        self.assertEqual(len(back), 2)
        self.assertEqual(back[0][0], CLASS_BYTE['motorway'])
        self.assertAlmostEqual(back[0][1], 25.0)
        self.assertEqual(len(back[1][2]), 3)
        self.assertAlmostEqual(back[1][2][2][1], 1.0, places=5)


class Tolerance(unittest.TestCase):
    def test_leaf_keeps_nodes_to_metres_coarse_levels_to_half_a_cell(self):
        from bake_osm_roads import LEAF_SIMPLIFY_M, METRES_PER_DEGREE, line_tolerance_deg
        self.assertAlmostEqual(line_tolerance_deg(12, 12) * METRES_PER_DEGREE, LEAF_SIMPLIFY_M, places=6)
        half_cell_z11 = (180.0 / (1 << 11)) / 256 * 0.5
        self.assertAlmostEqual(line_tolerance_deg(11, 12), half_cell_z11)
        self.assertGreater(line_tolerance_deg(11, 12) * METRES_PER_DEGREE, LEAF_SIMPLIFY_M)


if __name__ == '__main__':
    unittest.main()


class SpanMasking(unittest.TestCase):
    def test_leaf_roads_leave_bridge_and_tunnel_ways_out(self):
        data = {'elements': [
            _node(1, 0.0, 0.0), _node(2, 1.0, 0.0), _node(3, 2.0, 0.0), _node(4, 3.0, 0.0),
            _way(10, [1, 2], highway='primary'),
            _way(11, [2, 3], highway='primary', bridge='yes'),
            _way(12, [3, 4], highway='primary', tunnel='yes'),
        ]}
        self.assertEqual(len(assemble_roads(data)), 1)  # all chained into one run
        (leaf,) = assemble_roads(data, skip_spans=True)
        self.assertEqual(list(leaf.line.coords), [(0.0, 0.0), (1.0, 0.0)])


class BridgeOwnership(unittest.TestCase):
    def test_a_span_is_filed_whole_under_the_tile_holding_its_midpoint(self):
        from bake_osm_roads import bridges_by_tile, span_midpoint
        from osm_bridges import Bridge
        # z12 tiles are ~0.088 degrees wide; this span straddles the x=2048 border at lon 0.
        span = Bridge(1, 9.0, 0, 0.0, [(-0.001, 0.05), (0.002, 0.05)])
        got = bridges_by_tile([span], 12, Bounds(-1.0, -1.0, 1.0, 1.0))
        self.assertEqual(sum(len(v) for v in got.values()), 1)
        mid = span_midpoint(span.points)
        self.assertAlmostEqual(mid[0], 0.0005, places=4)

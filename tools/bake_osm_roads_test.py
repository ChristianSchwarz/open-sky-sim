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
    RAIL_CLASS,
    is_main_rail,
    keeps_class,
    merge_answers,
    write_levels,
    crossing_parts,
    TRACK_CROSSING_CLASS,
    CROSSING_MARGIN_M,
    is_rail_bridge,
    merge_rail_bridges,
    rail_bridges,
    rail_class_of,
    RAIL_SERVICE_CLASS,
    rbr_path,
    RAIL_DECK_MARGIN_M,
    rvr_path,
    Road,
    rail_width_m,
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
        span = Bridge(1, 9.0, 0, 0.0, 0, [(-0.001, 0.05), (0.002, 0.05)])
        got = bridges_by_tile([span], 12, Bounds(-1.0, -1.0, 1.0, 1.0))
        self.assertEqual(sum(len(v) for v in got.values()), 1)
        mid = span_midpoint(span.points)
        self.assertAlmostEqual(mid[0], 0.0005, places=4)


class CoarserLevelsFromDiskTest(unittest.TestCase):
    """A coarser .rvr tile comes from the tiles below it on disk.

    It used to be clipped from one bake's roads, so the chunk baked last
    emptied the shared coarser tiles of every neighbouring chunk's roads.
    """

    def test_two_chunks_and_a_bridge_all_reach_the_coarser_tile(self):
        import os
        import tempfile
        from shapely.geometry import LineString
        from bake_osm_roads import (Road, decode_rvr, rvr_path, write_levels)
        from osm_bridges import Bridge, encode_rbr
        from osm_common import CLASS_BYTE, Bounds, tile_bounds
        tmp = tempfile.mkdtemp()
        z, px, py = 11, 2200, 434
        tiles = {12: {(px * 2 + qx, py * 2 + qy) for qx in (0, 1) for qy in (0, 1)}, 11: {(px, py)}}
        motorway = CLASS_BYTE['motorway']

        def leaf_road(qx, qy):
            b = tile_bounds(12, px * 2 + qx, py * 2 + qy)
            mid = (b.south + b.north) / 2
            return Road(motorway, 20.0, LineString([(b.west, mid), (b.east, mid)]))

        def bake_chunk(cells):
            b0 = tile_bounds(12, *min(cells))
            b1 = tile_bounds(12, *max(cells))
            box_ = Bounds(min(b0.west, b1.west), min(b0.south, b1.south),
                          max(b0.east, b1.east), max(b0.north, b1.north))
            roads = [leaf_road(x - px * 2, y - py * 2) for x, y in cells]
            write_levels(tmp, tiles, box_, 11, 12, roads)

        # Chunk A: the northern children; chunk B, baked later: the southern.
        bake_chunk([(px * 2, py * 2), (px * 2 + 1, py * 2)])
        # A bridge span on the leaf, kept out of its .rvr like a real bake does.
        sb = tile_bounds(12, px * 2, py * 2 + 1)
        span = [(sb.west, sb.south + 1e-4), (sb.east, sb.south + 1e-4)]
        os.makedirs(os.path.join(tmp, '12', str(px * 2)), exist_ok=True)
        with open(os.path.join(tmp, '12', str(px * 2), f'{py * 2 + 1}.rbr'), 'wb') as fh:
            fh.write(encode_rbr([Bridge(0, 25.0, 1, 0.0, motorway, span)]))
        bake_chunk([(px * 2, py * 2 + 1), (px * 2 + 1, py * 2 + 1)])

        with open(rvr_path(tmp, z, px, py), 'rb') as fh:
            parts = decode_rvr(fh.read())
        self.assertEqual(len(parts), 5, 'four leaf runs from two chunks plus the bridge span')
        self.assertIn(25.0, [round(w, 3) for _, w, _ in parts])


class Railways(unittest.TestCase):
    def test_main_lines_only(self):
        self.assertTrue(is_main_rail({'railway': 'rail'}))
        self.assertTrue(is_main_rail({'railway': 'light_rail', 'bridge': 'yes'}))
        self.assertFalse(is_main_rail({'railway': 'rail', 'service': 'siding'}))
        self.assertFalse(is_main_rail({'railway': 'rail', 'tunnel': 'yes'}))
        self.assertFalse(is_main_rail({'railway': 'subway'}))
        self.assertFalse(is_main_rail({'railway': 'abandoned'}))

    def test_width_follows_tracks(self):
        self.assertEqual(rail_width_m({'railway': 'rail'}), 5.0)
        self.assertEqual(rail_width_m({'railway': 'rail', 'tracks': '2'}), 10.0)
        self.assertEqual(rail_width_m({'railway': 'rail', 'tracks': 'x'}), 5.0)

    def test_rail_past_every_road_class_and_from_z9(self):
        self.assertEqual(RAIL_CLASS, max(CLASS_BYTE.values()) + 1)
        self.assertFalse(keeps_class(RAIL_CLASS, 8))
        self.assertTrue(keeps_class(RAIL_CLASS, 9))
        self.assertTrue(keeps_class(RAIL_CLASS, 12))
        self.assertTrue(keeps_class(CLASS_BYTE['trunk'], 8))
        self.assertFalse(keeps_class(CLASS_BYTE['residential'], 11))

    def test_rails_chain_and_merge_with_roads(self):
        roads = {'elements': [
            _node(1, 13.0, 52.0), _node(2, 13.0, 52.01), _node(3, 13.0, 52.02),
            _way(10, [1, 2], highway='primary'),
        ]}
        rails = {'elements': [
            _node(2, 13.0, 52.01), _node(3, 13.0, 52.02), _node(1, 13.0, 52.0),
            _way(20, [1, 2], railway='rail'), _way(21, [2, 3], railway='rail'),
            _way(22, [1, 3], railway='rail', tunnel='yes'),
        ]}
        merged = merge_answers(roads, rails)
        self.assertEqual(sum(1 for el in merged['elements'] if el['type'] == 'node'), 3)
        runs = assemble_roads(merged)
        rail = [r for r in runs if r.cls == RAIL_CLASS]
        self.assertEqual(len(rail), 1)
        self.assertEqual(len(rail[0].line.coords), 3)
        self.assertEqual(len([r for r in runs if r.cls == CLASS_BYTE['primary']]), 1)


class RailsOnly(unittest.TestCase):
    def test_leaf_keeps_its_roads_and_swaps_its_rails(self):
        import os
        import tempfile
        from shapely.geometry import LineString
        from bake_osm_roads import tile_bounds
        z, x, y = 12, 4400, 860
        b = tile_bounds(z, x, y)
        mid = (b.south + b.north) / 2
        road = (CLASS_BYTE['primary'], 12.0, [(b.west + 1e-5, mid), (b.east - 1e-5, mid)])
        stale_rail = (RAIL_CLASS, 5.0, [(b.west + 1e-5, b.south + 1e-5), (b.east - 1e-5, b.north - 1e-5)])
        with tempfile.TemporaryDirectory() as out:
            path = rvr_path(out, z, x, y)
            os.makedirs(os.path.dirname(path))
            with open(path, 'wb') as fh:
                fh.write(encode_rvr([road, stale_rail]))
            lon = (b.west + b.east) / 2
            rail = Road(RAIL_CLASS, 10.0, LineString([(lon, b.south - 0.01), (lon, b.north + 0.01)]))
            write_levels(out, {z: {(x, y)}}, b, z, z, [rail], keep_leaf_roads=True)
            with open(path, 'rb') as fh:
                parts = decode_rvr(fh.read())
        kept = parts[0]
        self.assertEqual((kept[0], kept[1], len(kept[2])), (road[0], road[1], 2))
        for got, want in zip(kept[2], road[2]):
            self.assertAlmostEqual(got[0], want[0], places=4)
            self.assertAlmostEqual(got[1], want[1], places=4)
        rails = [p for p in parts if p[0] == RAIL_CLASS]
        self.assertEqual(len(rails), 1)
        self.assertEqual(rails[0][1], 10.0)


class RailBridges(unittest.TestCase):
    def _answer(self):
        return {'elements': [
            _node(1, 13.0, 52.0), _node(2, 13.0, 52.001), _node(3, 13.0, 52.002), _node(4, 13.0, 52.003),
            _way(30, [1, 2], railway='rail'),
            _way(31, [2, 3], railway='rail', bridge='yes', tracks='2'),
            _way(32, [3, 4], railway='rail'),
        ]}

    def test_bridge_ways_become_rail_spans(self):
        self.assertTrue(is_rail_bridge({'railway': 'rail', 'bridge': 'viaduct'}))
        self.assertFalse(is_rail_bridge({'railway': 'rail', 'bridge': 'no'}))
        self.assertTrue(is_rail_bridge({'railway': 'rail', 'service': 'yard', 'bridge': 'yes'}))
        self.assertFalse(is_rail_bridge({'railway': 'rail', 'tunnel': 'yes', 'bridge': 'yes'}))
        spans = rail_bridges(self._answer())
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0].cls, RAIL_CLASS)
        self.assertEqual(spans[0].deck_width_m, 10.0 + RAIL_DECK_MARGIN_M)

    def test_the_leaf_leaves_the_bridge_out_and_coarser_levels_keep_it(self):
        leaf = [r for r in assemble_roads(self._answer(), skip_spans=True) if r.cls == RAIL_CLASS]
        whole = [r for r in assemble_roads(self._answer()) if r.cls == RAIL_CLASS]
        self.assertEqual(sorted(len(r.line.coords) for r in leaf), [2, 2])
        self.assertEqual([len(r.line.coords) for r in whole], [4])

    def test_merge_keeps_road_spans_and_swaps_rail_spans(self):
        import os
        import tempfile
        from bake_osm_roads import Bridge, decode_rbr, encode_rbr, tile_bounds, tile_range_for_bounds
        span = rail_bridges(self._answer())[0]
        mid = span.points[0]
        x, y, _x1, _y1 = tile_range_for_bounds(12, Bounds(mid[0], mid[1] + 0.0005, mid[0], mid[1] + 0.0005))
        b = tile_bounds(12, x, y)
        road_span = Bridge(1, 12.0, 0, 0.0, CLASS_BYTE['primary'], [(b.west + 1e-4, b.south + 1e-4), (b.west + 2e-4, b.south + 1e-4)])
        old_rail = Bridge(1, 7.0, 0, 0.0, RAIL_CLASS, [(b.west + 1e-4, b.north - 1e-4), (b.west + 2e-4, b.north - 1e-4)])
        with tempfile.TemporaryDirectory() as out:
            path = rbr_path(out, 12, x, y)
            os.makedirs(os.path.dirname(path))
            with open(path, 'wb') as fh:
                fh.write(encode_rbr([road_span, old_rail]))
            files, written = merge_rail_bridges(out, {12: {(x, y)}}, b, 12, [span])
            with open(path, 'rb') as fh:
                back = decode_rbr(fh.read())
            self.assertEqual((files, written), (1, 1))
            self.assertEqual([s.cls for s in back], [CLASS_BYTE['primary'], RAIL_CLASS])
            self.assertEqual(back[1].deck_width_m, span.deck_width_m)
            # The bridge gone from OSM: its deck goes too, the road span stays.
            merge_rail_bridges(out, {12: {(x, y)}}, b, 12, [])
            with open(path, 'rb') as fh:
                self.assertEqual([s.cls for s in decode_rbr(fh.read())], [CLASS_BYTE['primary']])


class ServiceTrack(unittest.TestCase):
    def test_sidings_are_their_own_class_on_the_leaf_only(self):
        self.assertEqual(rail_class_of({'railway': 'rail', 'service': 'siding'}), RAIL_SERVICE_CLASS)
        self.assertEqual(rail_class_of({'railway': 'rail'}), RAIL_CLASS)
        self.assertIsNone(rail_class_of({'railway': 'rail', 'service': 'siding', 'tunnel': 'yes'}))
        self.assertTrue(keeps_class(RAIL_SERVICE_CLASS, 12))
        self.assertFalse(keeps_class(RAIL_SERVICE_CLASS, 11))

    def test_a_passing_loop_beside_the_main_line_is_its_own_run(self):
        data = {'elements': [
            _node(1, 13.0, 52.0), _node(2, 13.0, 52.01),
            _node(3, 13.00005, 52.0), _node(4, 13.00005, 52.01),
            _way(40, [1, 2], railway='rail', usage='main'),
            _way(41, [3, 4], railway='rail', service='siding'),
        ]}
        runs = assemble_roads(data)
        self.assertEqual(sorted(r.cls for r in runs), [RAIL_CLASS, RAIL_SERVICE_CLASS])



class LevelCrossings(unittest.TestCase):
    def test_a_road_across_the_track_marks_a_stretch_as_wide_as_the_road(self):
        from bake_osm_roads import tile_bounds, METRES_PER_DEGREE
        import math
        b = tile_bounds(12, 4400, 860)
        lat = (b.south + b.north) / 2
        lon = (b.west + b.east) / 2
        kx = METRES_PER_DEGREE * math.cos(math.radians(lat))
        rail = (RAIL_CLASS, 5.0, [(lon - 200 / kx, lat), (lon + 200 / kx, lat)])
        # A 9 m road straight across, and one at 30 degrees.
        road = (CLASS_BYTE['secondary'], 9.0, [(lon, lat - 100 / METRES_PER_DEGREE), (lon, lat + 100 / METRES_PER_DEGREE)])
        out = crossing_parts([rail, road], b)
        self.assertEqual(len(out), 1)
        cls, width, pts = out[0]
        self.assertEqual((cls, width), (TRACK_CROSSING_CLASS, 9.0))
        length = (pts[-1][0] - pts[0][0]) * kx
        self.assertAlmostEqual(length, 9.0 + 2 * CROSSING_MARGIN_M, delta=0.05)
        dx, dy = 100 * math.cos(math.radians(30)), 100 * math.sin(math.radians(30))
        oblique = (CLASS_BYTE['secondary'], 9.0, [(lon - dx / kx, lat - dy / METRES_PER_DEGREE),
                                                  (lon + dx / kx, lat + dy / METRES_PER_DEGREE)])
        cls, width, pts = crossing_parts([rail, oblique], b)[0]
        self.assertAlmostEqual((pts[-1][0] - pts[0][0]) * kx, 9.0 / math.sin(math.radians(30)) + 2 * CROSSING_MARGIN_M, delta=0.1)

    def test_no_crossing_without_an_intersection(self):
        from bake_osm_roads import tile_bounds
        b = tile_bounds(12, 4400, 860)
        lat = (b.south + b.north) / 2
        lon = (b.west + b.east) / 2
        rail = (RAIL_CLASS, 5.0, [(lon - 0.002, lat), (lon + 0.002, lat)])
        road = (CLASS_BYTE['primary'], 9.0, [(lon - 0.002, lat + 0.001), (lon + 0.002, lat + 0.001)])
        self.assertEqual(crossing_parts([rail, road], b), [])


class RvrPrecision(unittest.TestCase):
    def test_rvr2_keeps_points_to_well_under_a_millimetre(self):
        pts = [(35.0592712345, 45.2894412345), (35.0601234567, 45.2887654321)]
        back = decode_rvr(encode_rvr([(CLASS_BYTE['primary'], 7.0, pts)]))
        for (lon, lat), (blon, blat) in zip(pts, back[0][2]):
            self.assertLess(abs(lon - blon) * 78000, 0.001)
            self.assertLess(abs(lat - blat) * 111320, 0.001)

    def test_rvr1_still_decodes(self):
        import struct as st
        import zlib as zl
        payload = b'RVR1' + st.pack('<H', 1) + st.pack('<Bf H', 2, 9.0, 2) + st.pack('<ffff', 13.0, 52.0, 13.1, 52.1)
        back = decode_rvr(zl.compress(payload))
        self.assertEqual(back[0][0], 2)
        self.assertAlmostEqual(back[0][2][1][0], 13.1, places=5)

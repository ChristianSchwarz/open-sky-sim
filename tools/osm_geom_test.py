"""Tests for the `out geom;` answer shape and the mirror-aware empty guard."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from osm_common import (  # noqa: E402
    OVERPASS_UNTRUSTED_EMPTY, expand_geometry, refuse_untrusted_empty, merge_elements, nodes_map,
    relation_rings, ways_map,
)


def pt(lon, lat):
    return {'lon': lon, 'lat': lat}


class ExpandGeometryTest(unittest.TestCase):
    def test_old_form_passes_through(self):
        data = {'elements': [{'type': 'way', 'id': 1, 'nodes': [1, 2]},
                             {'type': 'node', 'id': 1, 'lon': 0, 'lat': 0}]}
        self.assertIs(expand_geometry(data), data)

    def test_way_geometry_becomes_nodes(self):
        data = {'elements': [{'type': 'way', 'id': 7, 'tags': {'natural': 'coastline'},
                              'nodes': [10, 11, 12],
                              'geometry': [pt(1, 1), pt(2, 1), pt(2, 2)]}]}
        out = expand_geometry(data)['elements']
        way = ways_map(out)[7]
        self.assertNotIn('geometry', way)
        self.assertEqual(way['tags'], {'natural': 'coastline'})
        nodes = nodes_map(out)
        self.assertEqual([nodes[n] for n in way['nodes']], [(1, 1), (2, 1), (2, 2)])
        self.assertTrue(all(n < 0 for n in way['nodes']))

    def test_shared_vertex_gets_one_node(self):
        data = {'elements': [
            {'type': 'way', 'id': 1, 'geometry': [pt(0, 0), pt(1, 0)]},
            {'type': 'way', 'id': 2, 'geometry': [pt(1, 0), pt(1, 1)]},
        ]}
        out = expand_geometry(data)['elements']
        ways = ways_map(out)
        self.assertEqual(ways[1]['nodes'][-1], ways[2]['nodes'][0])
        self.assertEqual(sum(1 for e in out if e['type'] == 'node'), 3)

    def test_relation_members_become_ways_and_chain(self):
        square = [pt(0, 0), pt(1, 0), pt(1, 1), pt(0, 1), pt(0, 0)]
        data = {'elements': [{
            'type': 'relation', 'id': 5, 'tags': {'natural': 'water'},
            'members': [
                {'type': 'way', 'ref': 21, 'role': 'outer', 'geometry': square[:3]},
                {'type': 'way', 'ref': 22, 'role': 'outer', 'geometry': square[2:]},
                {'type': 'node', 'ref': 99, 'role': 'label', 'lat': 0.5, 'lon': 0.5},
            ]}]}
        out = expand_geometry(data)['elements']
        ways = ways_map(out)
        self.assertEqual(set(ways), {21, 22})
        rel = next(e for e in out if e['type'] == 'relation')
        self.assertTrue(all('geometry' not in m for m in rel['members']))
        rings = relation_rings(rel, ways, nodes_map(out))
        self.assertEqual(len(rings), 1)
        self.assertEqual(rings[0][0], rings[0][-1])
        self.assertEqual(len(rings[0]), 5)

    def test_matched_way_wins_over_member_copy(self):
        geom = [pt(0, 0), pt(1, 0)]
        data = {'elements': [
            {'type': 'way', 'id': 3, 'tags': {'natural': 'coastline'}, 'geometry': geom},
            {'type': 'relation', 'id': 4, 'members': [
                {'type': 'way', 'ref': 3, 'role': 'outer', 'geometry': geom}]},
        ]}
        out = expand_geometry(data)['elements']
        self.assertEqual(sum(1 for e in out if e['type'] == 'way'), 1)
        self.assertEqual(ways_map(out)[3]['tags'], {'natural': 'coastline'})

    def test_null_vertex_is_skipped(self):
        data = {'elements': [{'type': 'way', 'id': 1, 'geometry': [pt(0, 0), None, pt(1, 0)]}]}
        out = expand_geometry(data)['elements']
        self.assertEqual(len(ways_map(out)[1]['nodes']), 2)

    def test_merge_across_answers_keeps_shared_vertex_once(self):
        a = expand_geometry({'elements': [{'type': 'way', 'id': 1, 'geometry': [pt(0, 0), pt(1, 0)]}]})
        b = expand_geometry({'elements': [{'type': 'way', 'id': 2, 'geometry': [pt(1, 0), pt(2, 0)]}]})
        out = merge_elements([a, b])['elements']
        self.assertEqual(sum(1 for e in out if e['type'] == 'node'), 3)
        ways = ways_map(out)
        self.assertEqual(ways[1]['nodes'][-1], ways[2]['nodes'][0])


class RefuseUntrustedEmptyTest(unittest.TestCase):
    def test_trusted_mirror_empty_is_believed(self):
        refuse_untrusted_empty()({'elements': []}, mirror='https://overpass-api.de/api/interpreter')

    def test_cache_hit_empty_is_believed(self):
        refuse_untrusted_empty()({'elements': []})

    def test_untrusted_mirror_empty_is_refused_every_time(self):
        validate = refuse_untrusted_empty()
        for _ in range(3):
            with self.assertRaises(RuntimeError):
                validate({'elements': []}, mirror=OVERPASS_UNTRUSTED_EMPTY[0])

    def test_non_empty_is_fine_anywhere(self):
        refuse_untrusted_empty()({'elements': [{'type': 'node'}]}, mirror=OVERPASS_UNTRUSTED_EMPTY[0])


class SeaCellSkipperTest(unittest.TestCase):
    """The DEM merge writes a z7 tile only where there is land, so the
    pyramid answers which fetch cells hold none."""

    def _pdm(self, grid):
        import struct, zlib
        import numpy as np
        from osm_common import PDM_MAGIC
        n = grid.shape[0]
        lo, hi = float(grid.min()), float(grid.max())
        scale = (hi - lo) / 65000.0 if hi > lo else 1.0
        q = np.round((grid - lo) / scale).astype('<u2')
        header = struct.pack('<4sHBBffff', PDM_MAGIC, n, 0, 0, lo, hi, scale, 0.0)
        return zlib.compress(header + q.tobytes())

    def test_no_level_means_ask_everything(self):
        import tempfile
        from osm_common import Bounds, sea_cell_skipper
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(sea_cell_skipper(tmp)(Bounds(0, 0, 1, 1)))

    def test_missing_tile_is_sea_and_a_tile_with_land_is_not(self):
        import tempfile
        import numpy as np
        from osm_common import bounds_cells, Bounds, sea_cell_skipper, tile_range_for_bounds
        with tempfile.TemporaryDirectory() as tmp:
            cell = bounds_cells(Bounds(7.9, 54.1, 7.95, 54.2))[0]
            x, y, _x1, _y1 = tile_range_for_bounds(7, Bounds(
                (cell.west + cell.east) / 2, (cell.south + cell.north) / 2,
                (cell.west + cell.east) / 2, (cell.south + cell.north) / 2))
            os.makedirs(os.path.join(tmp, '7', str(x)))
            skip = sea_cell_skipper(tmp)
            self.assertTrue(skip(cell), 'no tile at all is a cell with no land')
            path = os.path.join(tmp, '7', str(x), f'{y}.pdm')
            flat = np.zeros((5, 5), dtype=np.float32)
            with open(path, 'wb') as fh:
                fh.write(self._pdm(flat))
            self.assertTrue(skip(cell), 'a tile that never rises above sea level is sea')
            flat[2, 2] = 12.0
            with open(path, 'wb') as fh:
                fh.write(self._pdm(flat))
            self.assertFalse(skip(cell), 'one point of land keeps the cell')


if __name__ == '__main__':
    unittest.main()


class RelationPolygonsTest(unittest.TestCase):
    """A water relation's `inner` rings are islands and must come out as holes."""

    def _lake_with_island(self):
        from osm_common import relation_polygons
        outer = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10), pt(0, 0)]
        island = [pt(4, 4), pt(6, 4), pt(6, 6), pt(4, 6), pt(4, 4)]
        data = {'elements': [{
            'type': 'relation', 'id': 5, 'tags': {'natural': 'water'},
            'members': [
                {'type': 'way', 'ref': 21, 'role': 'outer', 'geometry': outer[:3]},
                {'type': 'way', 'ref': 22, 'role': 'outer', 'geometry': outer[2:]},
                {'type': 'way', 'ref': 31, 'role': 'inner', 'geometry': island[:3]},
                {'type': 'way', 'ref': 32, 'role': 'inner', 'geometry': island[2:]},
            ]}]}
        out = expand_geometry(data)['elements']
        rel = next(e for e in out if e['type'] == 'relation')
        return relation_polygons(rel, ways_map(out), nodes_map(out))

    def test_island_is_a_hole(self):
        from shapely.geometry import Point
        polys = self._lake_with_island()
        self.assertEqual(len(polys), 1)
        lake = polys[0]
        self.assertEqual(len(lake.interiors), 1)
        self.assertAlmostEqual(lake.area, 100 - 4)
        self.assertFalse(lake.contains(Point(5, 5)))
        self.assertTrue(lake.contains(Point(1, 1)))

    def test_outer_rings_alone_still_ignore_holes(self):
        rings = None
        outer = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10), pt(0, 0)]
        island = [pt(4, 4), pt(6, 4), pt(6, 6), pt(4, 6), pt(4, 4)]
        data = {'elements': [{
            'type': 'relation', 'id': 5, 'members': [
                {'type': 'way', 'ref': 21, 'role': 'outer', 'geometry': outer},
                {'type': 'way', 'ref': 31, 'role': 'inner', 'geometry': island},
            ]}]}
        out = expand_geometry(data)['elements']
        rel = next(e for e in out if e['type'] == 'relation')
        rings = relation_rings(rel, ways_map(out), nodes_map(out))
        self.assertEqual(len(rings), 1)

    def test_inner_in_no_outer_is_dropped(self):
        from osm_common import relation_polygons
        outer = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10), pt(0, 0)]
        stray = [pt(20, 20), pt(21, 20), pt(21, 21), pt(20, 20)]
        data = {'elements': [{
            'type': 'relation', 'id': 5, 'members': [
                {'type': 'way', 'ref': 21, 'role': 'outer', 'geometry': outer},
                {'type': 'way', 'ref': 31, 'role': 'inner', 'geometry': stray},
            ]}]}
        out = expand_geometry(data)['elements']
        rel = next(e for e in out if e['type'] == 'relation')
        polys = relation_polygons(rel, ways_map(out), nodes_map(out))
        self.assertEqual(len(polys), 1)
        self.assertEqual(len(polys[0].interiors), 0)

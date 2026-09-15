"""Tests for the `out geom;` answer shape and the mirror-aware empty guard."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from osm_common import (  # noqa: E402
    OVERPASS_UNTRUSTED_EMPTY, accept_empty_once, expand_geometry, merge_elements, nodes_map,
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


class AcceptEmptyOnceTest(unittest.TestCase):
    def test_trusted_mirror_empty_is_believed(self):
        accept_empty_once()({'elements': []}, mirror='https://overpass-api.de/api/interpreter')

    def test_cache_hit_empty_is_believed(self):
        accept_empty_once()({'elements': []})

    def test_untrusted_mirror_empty_is_refused_once(self):
        validate = accept_empty_once()
        with self.assertRaises(RuntimeError):
            validate({'elements': []}, mirror=OVERPASS_UNTRUSTED_EMPTY[0])
        validate({'elements': []}, mirror=OVERPASS_UNTRUSTED_EMPTY[0])

    def test_non_empty_is_fine_anywhere(self):
        accept_empty_once()({'elements': [{'type': 'node'}]}, mirror=OVERPASS_UNTRUSTED_EMPTY[0])


if __name__ == '__main__':
    unittest.main()

"""Tests for tools/osm_bridges.py: picking spans out of a road answer, classifying, the RBR1 format."""
from __future__ import annotations

import unittest

from osm_bridges import (
    STRUCTURE_BYTE,
    classify_structure,
    decode_rbr,
    deck_width_m,
    encode_rbr,
    extract_bridges,
)


def _node(nid: int, lon: float, lat: float) -> dict:
    return {'type': 'node', 'id': nid, 'lon': lon, 'lat': lat}


def _way(wid: int, nodes, **tags) -> dict:
    return {'type': 'way', 'id': wid, 'nodes': list(nodes), 'tags': tags}


# 0.001 degrees of longitude at 0 latitude is ~111 m.
def _answer(*ways) -> dict:
    return {'elements': [_node(1, 0.0, 0.0), _node(2, 0.001, 0.0), _node(3, 0.01, 0.0), *ways]}


class Extract(unittest.TestCase):
    def test_only_bridge_and_tunnel_ways_are_kept(self):
        data = _answer(
            _way(10, [1, 2], highway='primary', bridge='yes'),
            _way(11, [2, 3], highway='primary'),
            _way(12, [1, 3], highway='primary', tunnel='yes'),
            _way(13, [1, 2], highway='primary', bridge='no'),
            _way(14, [1, 2], railway='rail', bridge='yes'),
        )
        got = extract_bridges(data)
        self.assertEqual(len(got), 2)
        self.assertEqual({b.structure for b in got},
                         {STRUCTURE_BYTE['beam'], STRUCTURE_BYTE['tunnel']})

    def test_a_span_is_not_chained_into_its_neighbours(self):
        data = _answer(
            _way(10, [1, 2], highway='primary', bridge='yes'),
            _way(11, [2, 3], highway='primary', bridge='yes'),
        )
        self.assertEqual(len(extract_bridges(data)), 2)

    def test_layer_and_maxheight_are_read(self):
        data = _answer(_way(10, [1, 2], highway='primary', bridge='yes', layer='2', maxheight='4,5 m'))
        (b,) = extract_bridges(data)
        self.assertEqual(b.layer, 2)
        self.assertEqual(b.clearance_m, 4.5)


class Classify(unittest.TestCase):
    def test_tag_wins_over_length(self):
        self.assertEqual(classify_structure({'bridge:structure': 'arch'}, 10), STRUCTURE_BYTE['arch'])
        self.assertEqual(classify_structure({'bridge': 'suspension'}, 10), STRUCTURE_BYTE['suspension'])

    def test_untagged_is_slab_then_beam_never_a_guessed_cable_span(self):
        for length, want in ((20, 'slab'), (100, 'beam'), (300, 'beam'), (900, 'beam')):
            self.assertEqual(classify_structure({'bridge': 'yes'}, length), STRUCTURE_BYTE[want], length)

    def test_deck_width_prefers_width_then_lanes(self):
        self.assertEqual(deck_width_m({'width': '10'}), 12.0)
        self.assertEqual(deck_width_m({'lanes': '2'}), 9.0)
        self.assertEqual(deck_width_m({}), 9.0)


class Format(unittest.TestCase):
    def test_round_trip(self):
        data = _answer(_way(10, [1, 2, 3], highway='primary', bridge='viaduct', layer='1', width='12'))
        want = extract_bridges(data)
        got = decode_rbr(encode_rbr(want))
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0].structure, want[0].structure)
        self.assertEqual(got[0].layer, 1)
        self.assertAlmostEqual(got[0].deck_width_m, 14.0)
        self.assertEqual(len(got[0].points), 3)

    def test_bad_magic_is_refused(self):
        import zlib
        with self.assertRaises(ValueError):
            decode_rbr(zlib.compress(b'XXXX\x00\x00'))


if __name__ == '__main__':
    unittest.main()

"""Tests for tools/measure_lidar.py: reads, reductions, sources in order, the LMS1 bytes."""
from __future__ import annotations

import gzip
import math
import struct
import unittest

import numpy as np

import measure_lidar as ml


class Bilinear(unittest.TestCase):
    def test_reads_a_plane_exactly_and_misses_outside(self):
        # A 1 m grid whose top-left corner is (1000, 2000), height = x + 2 y.
        h, w = 10, 10
        cols, rows = np.meshgrid(np.arange(w), np.arange(h))
        xs = 1000 + cols + 0.5
        ys = 2000 - rows - 0.5
        arr = xs + 2 * ys
        px = np.array([1003.2, 1007.9, 1020.0])
        py = np.array([1995.4, 1991.1, 1995.0])
        v = ml.bilinear(arr, 1000, 2000, 1.0, -1.0, px, py)
        self.assertAlmostEqual(v[0], 1003.2 + 2 * 1995.4, places=9)
        self.assertAlmostEqual(v[1], 1007.9 + 2 * 1991.1, places=9)
        self.assertTrue(math.isnan(v[2]))

    def test_a_missing_corner_is_no_read(self):
        arr = np.full((4, 4), 5.0)
        arr[1, 1] = np.nan
        v = ml.bilinear(arr, 0, 4, 1.0, -1.0, np.array([1.2, 3.0]), np.array([2.4, 0.6]))
        self.assertTrue(math.isnan(v[0]))
        self.assertEqual(v[1], 5.0)


class Stations(unittest.TestCase):
    def test_lines_are_sampled_evenly_with_their_ends(self):
        lat = 47.0
        kx = ml.m_per_deg_lon(lat)
        pts = [(11.0, lat), (11.0 + 23.0 / kx, lat), (11.0 + 23.0 / kx, lat + 17.0 / ml.M_PER_DEG_LAT)]
        lon, la, de, dn = ml.sample_line(pts, 5.0)
        self.assertEqual(len(lon), 9)       # 40 m in 8 steps
        self.assertAlmostEqual(lon[0], 11.0)
        self.assertAlmostEqual(la[-1], pts[-1][1])
        self.assertAlmostEqual(de[0], 1.0)
        self.assertAlmostEqual(dn[-1], 1.0)

    def test_an_embankment_reads_as_its_height_above_the_ground_beside(self):
        # A road running north on a 4 m fill 12 m wide, on ground sloping east.
        lat, lon = 47.0, 11.0
        kx = ml.m_per_deg_lon(lat)
        rl, ra = ml.station_reads(np.array([lon]), np.array([lat]), np.array([0.0]), np.array([1.0]), np.array([3.5]))
        east = (rl - lon) * kx
        ground = 500 + 0.05 * east
        v = np.where(np.abs(east) <= 6, ground + 4, ground)
        crown, side = ml.reduce_reads(v)
        self.assertAlmostEqual(crown[0], 504.0, places=6)
        self.assertAlmostEqual(side[0], 500.0, places=6)   # the slope averages out over both sides

    def test_one_side_missing_still_reads(self):
        v = np.full((1, 27), 100.0)
        v[0, :5] = 103.0
        v[0, 16:] = np.nan
        crown, side = ml.reduce_reads(v)
        self.assertEqual(crown[0], 103.0)
        self.assertEqual(side[0], 100.0)

    def test_approach_stations_run_outwards_from_each_end(self):
        lat = 47.0
        kx = ml.m_per_deg_lon(lat)
        # 40 m east, with a duplicate node a few centimetres from the start.
        pts = [(11.0, lat), (11.0 + 0.03 / kx, lat), (11.0 + 40.0 / kx, lat)]
        a, b = ml.approach_stations(pts)
        self.assertTrue(np.all(a[0] < 11.0), 'start stations lie west of the start')
        self.assertAlmostEqual((11.0 - a[0][0]) * kx, 2.0, places=3)
        self.assertTrue(np.all(b[0] > pts[-1][0]), 'end stations lie east of the end')


class FakeSource(ml.Source):
    def __init__(self, sid, bbox, value):
        super().__init__({})
        self.id = sid
        self.bbox = bbox
        self.value = value

    def heights(self, lons, lats):
        return np.where(lons < 11.5, self.value, np.nan)


class SourceOrder(unittest.TestCase):
    def test_first_source_with_the_crown_wins_and_the_rest_fall_through(self):
        first = FakeSource(1, (11.0, 47.0, 12.0, 48.0), 10.0)
        second = FakeSource(2, (10.0, 46.0, 13.0, 49.0), 20.0)
        second.heights = lambda lons, lats: np.full(lons.shape, 20.0)
        lons = np.array([11.2, 11.8, 12.5])
        lats = np.array([47.5, 47.5, 47.5])
        zero = np.zeros(3)
        crown, side, src = ml.measure_stations([first, second], lons, lats, zero, zero + 1, zero + 3)
        self.assertEqual(list(src), [1, 2, 2])
        self.assertEqual(list(crown), [10.0, 20.0, 20.0])


class Tiers(unittest.TestCase):
    def test_bed_tiers_follow_railbed(self):
        # railBed.ts bedTierOf over ptr.ts RoadClass 0..11.
        self.assertEqual([ml.bed_tier(c) for c in range(12)], [1, 2, 2, 3, 3, 3, 3, 0, 0, -1, -1, -1])


class Lms(unittest.TestCase):
    def test_header_and_layout(self):
        x, y = 4348, 966
        west, south, _e, _n = ml.tile_bounds(12, x, y)
        lon = np.array([west + 0.01, west + 0.01 + 4e-5])
        lat = np.array([south + 0.02, south + 0.02])
        blob = ml.encode_lms(12, x, y, 7, 9, 0b110, [(2, 3.5, lon, lat, np.array([700.0, np.nan]),
                                                       np.array([1.25, np.nan]), np.array([1, 0]))], [2.5, np.nan])
        h = ml.decode_lms_header(blob[:40])
        self.assertEqual((h['x'], h['y'], h['rvrSig'], h['rbrSig'], h['attempted'], h['lines'], h['bridges']),
                         (x, y, 7, 9, 6, 1, 1))
        o = 40
        tier, _r, half, n, qx, qy = struct.unpack_from('<BBHHii', blob, o)
        self.assertEqual((tier, half, n, qx, qy), (2, 35, 2, 100000, 200000))
        o += 14
        self.assertEqual(struct.unpack_from('<hh', blob, o), (400, 0))
        o += 4
        self.assertEqual(struct.unpack_from('<HH', blob, o), (9000, 0))
        o += 4
        self.assertEqual(struct.unpack_from('<hh', blob, o), (125, ml.NO_LIFT))
        o += 4
        self.assertEqual(struct.unpack_from('<BB', blob, o), (1, 0))
        o += 2
        self.assertEqual(struct.unpack_from('<hh', blob, o), (250, ml.NO_LIFT))
        self.assertEqual(o + 4, len(blob))
        self.assertEqual(gzip.decompress(gzip.compress(blob)), blob)


if __name__ == '__main__':
    unittest.main()

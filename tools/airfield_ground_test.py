"""Tests for tools/airfield_ground.py: the airfield's ground from its surroundings."""
from __future__ import annotations

import unittest

import numpy as np

from airfield_ground import (
    AirfieldGround, Perimeter, airfield_perimeters, fill_bounds, harmonic_fill, ring_mask,
)

# A square field about 1 km a side near Kempten.
RING = [(10.30, 47.70), (10.313, 47.70), (10.313, 47.709), (10.30, 47.709), (10.30, 47.70)]
FIELD = Perimeter(1, RING, (10.30, 47.70, 10.313, 47.709))


def west_east_ground(bounds, rows, cols):
    """Imagery that is forest to the west and farmland to the east, with a
    grey airfield painted where the perimeter is."""
    colors = np.zeros((rows, cols, 3), dtype=np.uint8)
    colors[:, : cols // 2] = (40, 80, 40)
    colors[:, cols // 2:] = (160, 150, 90)
    inside = ring_mask(RING, bounds, rows, cols)
    colors[inside] = (128, 128, 128)
    return colors, np.ones((rows, cols), dtype=bool)


class HarmonicFillTest(unittest.TestCase):
    def test_constant_border_fills_constant(self):
        values = np.zeros((40, 50, 3), dtype=np.float32)
        values[...] = (10, 20, 30)
        known = np.ones((40, 50), dtype=bool)
        known[5:35, 5:45] = False
        values[~known] = 255
        out = harmonic_fill(values, known)
        np.testing.assert_allclose(out[20, 25], (10, 20, 30), atol=0.5)

    def test_linear_border_fills_linear(self):
        # A harmonic fill reproduces a linear ramp exactly.
        rows, cols = 64, 64
        ramp = np.linspace(0, 200, cols, dtype=np.float32)
        values = np.repeat(ramp[None, :, None], rows, axis=0).repeat(3, axis=2)
        known = np.zeros((rows, cols), dtype=bool)
        known[0, :] = known[-1, :] = known[:, 0] = known[:, -1] = True
        start = values.copy()
        start[~known] = 0
        out = harmonic_fill(start, known)
        self.assertLess(np.abs(out - values).max(), 2.0)

    def test_known_cells_untouched(self):
        rng = np.random.default_rng(1)
        values = rng.uniform(0, 255, (30, 30, 3)).astype(np.float32)
        known = rng.uniform(size=(30, 30)) > 0.5
        out = harmonic_fill(values, known)
        np.testing.assert_array_equal(out[known], values[known])


class AirfieldGroundTest(unittest.TestCase):
    def test_tile_inside_perimeter_loses_the_grey(self):
        ground = AirfieldGround([FIELD], west_east_ground)
        size = 129
        bounds = (10.29, 47.69, 10.323, 47.719)
        colors = np.full((size, size, 3), 128, dtype=np.uint8)
        changed = ground.apply(colors, bounds, size)
        self.assertGreater(changed, 0)
        dx = (bounds[2] - bounds[0]) / (size - 1)
        dy = (bounds[3] - bounds[1]) / (size - 1)
        def at(lon, lat):
            return colors[round((bounds[3] - lat) / dy), round((lon - bounds[0]) / dx)].astype(int)
        west = at(10.3015, 47.7045)
        east = at(10.3115, 47.7045)
        # Forest-ish near the west fence, farmland-ish near the east, never grey.
        self.assertGreater(west[1] - west[0], 15)
        self.assertGreater(east[0], west[0] + 40)
        # Outside the perimeter nothing changes.
        np.testing.assert_array_equal(at(10.295, 47.695), (128, 128, 128))

    def test_neighbouring_tiles_agree_on_shared_edge(self):
        ground = AirfieldGround([FIELD], west_east_ground)
        size = 65
        mid = 10.3065
        left = np.zeros((size, size, 3), dtype=np.uint8)
        right = np.zeros((size, size, 3), dtype=np.uint8)
        ground.apply(left, (10.29, 47.69, mid, 47.719), size)
        ground.apply(right, (mid, 47.69, 10.323, 47.719), size)
        np.testing.assert_array_equal(left[:, -1], right[:, 0])

    def test_no_known_ground_leaves_tile_alone(self):
        def all_water(bounds, rows, cols):
            return np.zeros((rows, cols, 3), dtype=np.uint8), np.zeros((rows, cols), dtype=bool)
        ground = AirfieldGround([FIELD], all_water)
        colors = np.full((33, 33, 3), 77, dtype=np.uint8)
        ground.apply(colors, (10.29, 47.69, 10.323, 47.719), 33)
        self.assertTrue((colors == 77).all())


class ManifestTest(unittest.TestCase):
    def test_perimeters_from_manifest(self):
        manifest = {'airfields': {'items': [
            {'osmId': 5, 'perimeter': [[47.70, 10.30], [47.70, 10.31], [47.71, 10.31], [47.70, 10.30]]},
            {'osmId': 6},
        ]}}
        got = airfield_perimeters(manifest)
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0].ring[1], (10.31, 47.70))
        self.assertEqual(got[0].bounds, (10.30, 47.70, 10.31, 47.71))

    def test_perimeter_ring_from_polygon(self):
        from shapely.geometry import MultiPolygon, Polygon
        from bake_osm_airports import perimeter_ring
        small = Polygon([(0, 0), (0.001, 0), (0.001, 0.001), (0, 0.001)])
        big = Polygon([(1, 1), (1.01, 1), (1.01, 1.01), (1, 1.01), (1.000001, 1.005)])
        ring = perimeter_ring(MultiPolygon([small, big]))
        # The larger piece, as [lat, lon], with the near-collinear node dropped.
        self.assertIn([1.0, 1.01], ring)
        self.assertEqual(len(ring), 5)

    def test_huge_field_grid_is_capped(self):
        big = Perimeter(2, [], (10.0, 47.0, 10.5, 47.3))
        _, rows, cols = fill_bounds(big)
        self.assertLessEqual(max(rows, cols), 768)


if __name__ == '__main__':
    unittest.main()

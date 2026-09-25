"""Tests for the raster windowing in tools/bake_planet_cover.py.

`Source.read_onto` is the one place a tile meets a source raster, and the two
disagree about their edges: the tile grid is fixed by the pyramid, the raster by
whatever `fetch_cover_sources.py` last downloaded. Everything here is about that
seam.
"""
from __future__ import annotations

import os
import tempfile
import unittest

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds

from bake_planet_cover import (
    CLS_BUILT, CLS_GRASS, CLS_TREE, CLS_UNKNOWN, PLC_FLAG_REAL_IMAGERY, Source,
    build_parent_cover, decode_plc, encode_plc, majority_decimate, stamp_airfield_classes,
)

NODATA = 255


def write_raster(path: str, west: float, south: float, east: float, north: float,
                 width: int, height: int) -> None:
    """A single-band raster of a constant value, covering the given box."""
    with rasterio.open(
        path, 'w', driver='GTiff', width=width, height=height, count=1,
        dtype='uint8', crs='EPSG:4326', nodata=NODATA,
        transform=from_bounds(west, south, east, north, width, height),
    ) as ds:
        ds.write(np.full((height, width), 7, dtype='uint8'), 1)


class ReadOntoTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, 'src.tif')
        # 100 px across one degree: one pixel is 0.01 deg.
        write_raster(self.path, 0.0, 0.0, 1.0, 1.0, 100, 100)
        self.src = Source(self.path, [1], NODATA)

    def tearDown(self):
        self.src.close()

    def test_a_tile_overlapping_by_less_than_a_pixel_is_skipped(self):
        """The narrow-bbox crash: rounding takes the sliver away.

        The tile really does overlap, so the bounds test lets it through, and
        then round_offsets puts the window's first column at the raster's width.
        Window.intersection raises on that rather than returning nothing, which
        killed the whole bake instead of skipping one tile.
        """
        self.assertIsNone(
            self.src.read_onto((1.0 - 1e-9, 0.2, 1.5, 0.7), 32, Resampling.nearest))
        # ...and the same on the other three sides.
        self.assertIsNone(
            self.src.read_onto((-0.5, 0.2, 1e-9, 0.7), 32, Resampling.nearest))
        self.assertIsNone(
            self.src.read_onto((0.2, 1.0 - 1e-9, 0.7, 1.5), 32, Resampling.nearest))
        self.assertIsNone(
            self.src.read_onto((0.2, -0.5, 0.7, 1e-9), 32, Resampling.nearest))

    def test_a_tile_clear_of_the_raster_is_skipped(self):
        self.assertIsNone(
            self.src.read_onto((2.0, 2.0, 3.0, 3.0), 32, Resampling.nearest))

    def test_a_tile_inside_the_raster_reads(self):
        out = self.src.read_onto((0.2, 0.2, 0.7, 0.7), 32, Resampling.nearest)
        self.assertIsNotNone(out)
        self.assertEqual(out.shape, (1, 32, 32))
        self.assertTrue(np.all(out == 7))

    def test_a_tile_hanging_off_the_edge_reads_the_part_that_exists(self):
        """Clamping has to keep the data where it belongs, not shift it."""
        out = self.src.read_onto((0.5, 0.2, 1.5, 0.7), 32, Resampling.nearest)
        self.assertIsNotNone(out)
        # The western half is inside the raster, the eastern half is not.
        self.assertTrue(np.all(out[0, :, :14] == 7), 'inside the raster went blank')
        self.assertTrue(np.all(out[0, :, 18:] == NODATA), 'data spilled past the edge')


class StampAirfieldClassesTest(unittest.TestCase):
    """The ground under a runway must not be whatever grew there before it."""

    # A 0.01 deg tile near the Gran Canaria play origin, 33 nodes a side, so a
    # node is roughly 35 m.
    BOUNDS = (-15.40, 28.00, -15.39, 28.01)
    SIZE = 33

    def grid(self):
        return np.full((self.SIZE, self.SIZE), CLS_GRASS, dtype=np.uint8)

    def pad(self, **kw):
        base = {
            'lat': 28.005, 'lon': -15.395, 'headingDeg': 0.0,
            'halfD': 400.0, 'halfW': 120.0, 'featherM': 40.0,
        }
        base.update(kw)
        return base

    def test_paints_the_core_and_leaves_the_rest(self):
        classes = self.grid()
        changed = stamp_airfield_classes(classes, self.BOUNDS, self.SIZE, [self.pad()])
        self.assertGreater(changed, 0)
        self.assertEqual(classes[self.SIZE // 2, self.SIZE // 2], CLS_BUILT)
        # The corners are far outside a 240 x 800 m strip through the middle.
        for row, col in ((0, 0), (0, -1), (-1, 0), (-1, -1)):
            self.assertEqual(classes[row, col], CLS_GRASS)

    def test_turns_with_the_runway(self):
        along = self.grid()
        across = self.grid()
        stamp_airfield_classes(along, self.BOUNDS, self.SIZE, [self.pad(headingDeg=0.0)])
        stamp_airfield_classes(across, self.BOUNDS, self.SIZE, [self.pad(headingDeg=90.0)])
        mid = self.SIZE // 2
        # 8 nodes off centre is ~276 m north or ~246 m east: inside the 360 m
        # core along the strip, well outside the 80 m core across it. So a
        # north-south strip is built up the middle column and not along the
        # middle row, and turned 90 degrees it is exactly the other way round.
        self.assertEqual(along[8, mid], CLS_BUILT)
        self.assertEqual(along[mid, 8], CLS_GRASS)
        self.assertEqual(across[mid, 8], CLS_BUILT)
        self.assertEqual(across[8, mid], CLS_GRASS)

    def test_a_pad_on_another_island_touches_nothing(self):
        classes = self.grid()
        changed = stamp_airfield_classes(
            classes, self.BOUNDS, self.SIZE, [self.pad(lat=27.93, lon=-15.39)])
        self.assertEqual(changed, 0)
        self.assertTrue(np.all(classes == CLS_GRASS))

    def test_no_pads_is_a_no_op(self):
        classes = self.grid()
        self.assertEqual(stamp_airfield_classes(classes, self.BOUNDS, self.SIZE, []), 0)


class DecodePlcTest(unittest.TestCase):
    def roundtrip(self, flags: int) -> None:
        size = 5
        classes = np.arange(size * size, dtype=np.uint8).reshape(size, size) % CLS_BUILT
        colors = np.arange(size * size * 3, dtype=np.uint8).reshape(size, size, 3)
        blob = encode_plc(size, flags, classes, colors)
        path = os.path.join(tempfile.mkdtemp(), 'tile.plc')
        with open(path, 'wb') as fh:
            fh.write(blob)
        out_classes, out_colors, out_flags = decode_plc(path)
        np.testing.assert_array_equal(out_classes, classes)
        np.testing.assert_array_equal(out_colors, colors)
        self.assertEqual(out_flags, flags)

    def test_roundtrips_with_real_imagery_flag_set(self):
        self.roundtrip(PLC_FLAG_REAL_IMAGERY)

    def test_roundtrips_with_no_flags(self):
        self.roundtrip(0)


class MajorityDecimateTest(unittest.TestCase):
    def test_picks_the_neighbourhood_majority_over_a_lone_point_sample(self):
        # A 5x5 all-Grass child except node (2,2), which is Built. Decimated
        # at stride 2, node (1,1) in the output corresponds to child (2,2) -
        # a bare point sample would read Built; the majority in its
        # neighbourhood is Grass.
        child = np.full((5, 5), CLS_GRASS, dtype=np.uint8)
        child[2, 2] = CLS_BUILT
        self.assertEqual(child[0::2, 0::2][1, 1], CLS_BUILT, 'test setup: point sample must disagree')
        result = majority_decimate(child, r=1)
        self.assertEqual(result[1, 1], CLS_GRASS)

    def test_ties_go_to_the_lowest_class_id(self):
        # A 2x2 neighbourhood split evenly between Tree and Grass at the
        # decimated node - cover_patches.py's own tie-break convention says
        # the lower id (Tree=1 < Grass=3) wins.
        child = np.array([
            [CLS_TREE, CLS_GRASS],
            [CLS_GRASS, CLS_TREE],
        ], dtype=np.uint8)
        result = majority_decimate(child, r=1)
        self.assertEqual(result[0, 0], CLS_TREE)

    def test_zero_radius_is_a_plain_point_sample(self):
        child = np.full((5, 5), CLS_GRASS, dtype=np.uint8)
        child[2, 2] = CLS_BUILT
        result = majority_decimate(child, r=0)
        np.testing.assert_array_equal(result, child[0::2, 0::2])


class BuildParentCoverTest(unittest.TestCase):
    SIZE = 5  # half = 2, each quadrant contributes a 3x3 block

    def child(self, cls: int, color: int, flags: int = 0):
        classes = np.full((self.SIZE, self.SIZE), cls, dtype=np.uint8)
        colors = np.full((self.SIZE, self.SIZE, 3), color, dtype=np.uint8)
        return classes, colors, flags

    def test_all_four_quadrants_vote_and_point_decimate(self):
        children = {
            (0, 0): self.child(CLS_TREE, 10, PLC_FLAG_REAL_IMAGERY),
            (1, 0): self.child(CLS_GRASS, 20),
            (0, 1): self.child(CLS_BUILT, 30),
            (1, 1): self.child(CLS_TREE, 40),
        }
        classes, colors, flags = build_parent_cover(children, self.SIZE, r=1)
        self.assertEqual(classes.shape, (self.SIZE, self.SIZE))
        self.assertEqual(classes[0, 0], CLS_TREE, 'top-left quadrant')
        self.assertEqual(classes[0, self.SIZE - 1], CLS_GRASS, 'top-right quadrant')
        self.assertEqual(classes[self.SIZE - 1, 0], CLS_BUILT, 'bottom-left quadrant')
        self.assertEqual(classes[self.SIZE - 1, self.SIZE - 1], CLS_TREE, 'bottom-right quadrant')
        self.assertEqual(colors[0, 0, 0], 10)
        self.assertEqual(flags, PLC_FLAG_REAL_IMAGERY, 'ORs across children, even if only one has it')

    def test_a_missing_quadrant_stays_at_the_default_rather_than_raising(self):
        # The routine coastal case: an ocean-only sibling was never baked.
        children = {
            (0, 0): self.child(CLS_TREE, 10),
        }
        classes, colors, flags = build_parent_cover(children, self.SIZE, r=1)
        self.assertEqual(classes[0, 0], CLS_TREE, 'present quadrant is voted/decimated normally')
        self.assertEqual(classes[self.SIZE - 1, self.SIZE - 1], CLS_UNKNOWN, 'absent quadrant keeps the default')
        self.assertEqual(colors[self.SIZE - 1, self.SIZE - 1, 0], 0)
        self.assertEqual(flags, 0)

    def test_no_quadrants_is_all_default(self):
        classes, colors, flags = build_parent_cover({}, self.SIZE, r=1)
        self.assertTrue(np.all(classes == CLS_UNKNOWN))
        self.assertTrue(np.all(colors == 0))
        self.assertEqual(flags, 0)


if __name__ == '__main__':
    unittest.main()

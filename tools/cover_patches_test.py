"""Tests for tools/cover_patches.py."""
from __future__ import annotations

import unittest

import numpy as np

from cover_patches import (
    CLS_UNKNOWN,
    CLS_WATER,
    enlarge_patches,
    halo_nodes,
    majority_pass,
    radius_nodes,
)

# A land class that is not water and not nodata.
GRASS = 3
SHRUB = 2
BUILT = 5


def field(value: int, size: int = 41) -> np.ndarray:
    return np.full((size, size), value, dtype=np.uint8)


class RadiusTest(unittest.TestCase):

    def test_radius_comes_from_ground_distance(self):
        # 250 m over 19 m nodes is a ~13-node patch, so a 6.6 -> 7 half-window.
        self.assertEqual(radius_nodes(250, 19.0), 7)
        # The same target over 76 m nodes (four zooms coarser) is much smaller.
        self.assertEqual(radius_nodes(250, 76.0), 2)

    def test_a_node_coarser_than_the_target_disables_the_filter(self):
        # From about z9 up a single node spans more ground than the patch, and
        # facets there are kilometres wide. Nothing to smooth.
        self.assertEqual(radius_nodes(250, 304.0), 0)
        self.assertEqual(radius_nodes(0, 19.0), 0)

    def test_halo_covers_every_pass(self):
        # One pass reaches r nodes; two reach 2r. Reading less is what puts a
        # seam down a tile border.
        self.assertEqual(halo_nodes(250, 19.0, passes=2), 14)
        self.assertEqual(halo_nodes(250, 19.0, passes=1), 7)
        self.assertEqual(halo_nodes(250, 304.0), 0)


class MajorityTest(unittest.TestCase):

    def test_absorbs_an_isolated_speck(self):
        a = field(GRASS)
        a[20, 20] = BUILT
        out = majority_pass(a, 3)
        self.assertEqual(out[20, 20], GRASS)
        self.assertFalse((out == BUILT).any())

    def test_keeps_a_region_wider_than_the_window(self):
        a = field(GRASS)
        a[10:30, 10:30] = SHRUB
        out = majority_pass(a, 3)
        # The interior survives untouched; only the boundary rounds.
        self.assertTrue((out[14:26, 14:26] == SHRUB).all())
        self.assertTrue((out[0:6, 0:6] == GRASS).all())

    def test_a_zero_radius_is_a_no_op(self):
        a = field(GRASS)
        a[20, 20] = BUILT
        self.assertTrue((majority_pass(a, 0) == a).all())

    def test_preserves_dtype_and_shape(self):
        a = field(GRASS, size=33)
        out = majority_pass(a, 2)
        self.assertEqual(out.dtype, np.uint8)
        self.assertEqual(out.shape, (33, 33))


class FixedClassTest(unittest.TestCase):

    def test_water_is_never_reassigned(self):
        a = field(GRASS)
        a[0:20, :] = CLS_WATER
        out = majority_pass(a, 5)
        self.assertEqual(int((out == CLS_WATER).sum()), int((a == CLS_WATER).sum()))
        self.assertTrue((out[0:20, :] == CLS_WATER).all())

    def test_water_casts_no_votes_so_a_headland_survives(self):
        # A small spit of land in open sea. If the sea could vote it would win
        # every window here and the land would simply disappear.
        a = field(CLS_WATER)
        a[19:22, 19:22] = GRASS
        out = majority_pass(a, 6)
        self.assertTrue((out[19:22, 19:22] == GRASS).all())
        self.assertEqual(int((out == CLS_WATER).sum()), int((a == CLS_WATER).sum()))

    def test_nodata_is_held_and_silent_too(self):
        a = field(CLS_UNKNOWN)
        a[19:22, 19:22] = GRASS
        out = majority_pass(a, 6)
        self.assertTrue((out[19:22, 19:22] == GRASS).all())
        self.assertTrue((out[0, 0] == CLS_UNKNOWN))

    def test_land_still_merges_with_water_present(self):
        a = field(GRASS)
        a[:, 0:15] = CLS_WATER
        a[25, 25] = BUILT
        out = majority_pass(a, 4)
        self.assertEqual(out[25, 25], GRASS)
        self.assertTrue((out[:, 0:15] == CLS_WATER).all())


class SeamTest(unittest.TestCase):
    """The property the whole approach was chosen for."""

    def rough(self, size: int = 80) -> np.ndarray:
        """Blocks of cover on a grass background, roughly landcover-shaped.

        Per-node noise will not do: at that density the majority is the same
        in every window, so a tile reaches the same answer whether or not it
        can see past its own border, and the test proves nothing.
        """
        rng = np.random.default_rng(3)
        a = np.full((size, size), GRASS, dtype=np.uint8)
        for _ in range(60):
            y, x = rng.integers(0, size - 6, 2)
            h, w = rng.integers(4, 14, 2)
            a[y:y + h, x:x + w] = rng.choice([SHRUB, BUILT, CLS_WATER])
        return a

    def test_a_full_halo_reproduces_the_wider_view_exactly(self):
        patch_m, node_m, passes = 250.0, 19.0, 2
        halo = halo_nodes(patch_m, node_m, passes)
        self.assertGreater(halo, 0)

        world = self.rough()
        # What a tile in the middle of a larger raster should come out as.
        expected = enlarge_patches(world, patch_m, node_m, passes)[30:50, 30:50]

        # Reading with the full halo must reproduce it byte for byte.
        with_halo = world[30 - halo:50 + halo, 30 - halo:50 + halo]
        got = enlarge_patches(with_halo, patch_m, node_m, passes)[halo:-halo, halo:-halo]
        self.assertTrue((got == expected).all(), 'a full halo must be seam-free')

    def test_no_halo_does_disagree_at_the_border(self):
        # Guards the guarantee from the other side: if this ever stops being
        # true the halo has quietly stopped being necessary, and the test above
        # would pass whether or not the caller read one.
        patch_m, node_m, passes = 250.0, 19.0, 2
        world = self.rough()
        expected = enlarge_patches(world, patch_m, node_m, passes)[30:50, 30:50]
        naive = enlarge_patches(world[30:50, 30:50], patch_m, node_m, passes)
        self.assertTrue((naive != expected).any())


class EnlargeTest(unittest.TestCase):

    def test_two_passes_reach_further_than_one(self):
        rng = np.random.default_rng(7)
        a = rng.choice(np.array([GRASS, SHRUB], dtype=np.uint8), size=(60, 60), p=[0.6, 0.4])
        one = enlarge_patches(a, 250, 19.0, passes=1)
        two = enlarge_patches(a, 250, 19.0, passes=2)
        self.assertTrue((one != two).any())

    def test_a_coarse_tile_is_returned_untouched(self):
        a = field(GRASS)
        a[20, 20] = BUILT
        out = enlarge_patches(a, 250, 304.0)
        self.assertIs(out, a)


if __name__ == '__main__':
    unittest.main()

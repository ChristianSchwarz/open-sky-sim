"""Tests for tools/measure_buildings.py: colour maths, haze, registration and roof sampling on synthetic blocks."""
from __future__ import annotations

import unittest

import numpy as np

from measure_buildings import (
    RES_M, Block, block_shift, decode_bcs, encode_bcs, gradient, haze_veil, lab_to_srgb, luminance,
    sample_roof, srgb_to_lab,
)


def _block(img: np.ndarray) -> Block:
    # 1 px = 1e-5 deg either way; the tests work in pixels anyway.
    return Block(img, 11.0, 47.5, 1e-5, 1e-5)


def _house(img: np.ndarray, x0: int, y0: int, x1: int, y1: int, colour) -> None:
    img[y0:y1, x0:x1] = colour


class Colour(unittest.TestCase):
    def test_lab_round_trip(self):
        rgb = np.array([[156.0, 115.0, 93.0], [20.0, 200.0, 30.0], [255.0, 255.0, 255.0], [0.0, 0.0, 0.0]])
        back = lab_to_srgb(srgb_to_lab(rgb))
        self.assertTrue(np.all(np.abs(back - rgb) <= 1.0), back)


class Haze(unittest.TestCase):
    def test_veil_is_the_darkest_channel_less_a_floor(self):
        img = np.full((100, 100, 3), 120, dtype=np.uint8)
        img[:5, :, :] = (40, 55, 42)  # tree shade: dark, green
        self.assertAlmostEqual(haze_veil(_block(img)), 40 - 8, delta=0.5)

    def test_no_veil_over_deep_shadow(self):
        img = np.full((100, 100, 3), 120, dtype=np.uint8)
        img[:5, :, :] = 3
        self.assertEqual(haze_veil(_block(img)), 0.0)


class Registration(unittest.TestCase):
    def test_block_shift_finds_the_lean(self):
        img = np.full((256, 256, 3), 90, dtype=np.uint8)
        rings = []
        for i in range(4):
            x0, y0 = 30 + i * 50, 40 + i * 40
            # The roofs drawn 4 px east and 3 px south of their footprints.
            _house(img, x0 + 4, y0 + 3, x0 + 24, y0 + 19, (170, 90, 70))
            rings.append([(x0, y0), (x0 + 20, y0), (x0 + 20, y0 + 16), (x0, y0 + 16)])
        grad = gradient(luminance(img.astype(np.float32)))
        dx, dy, _ = block_shift(grad, rings, 12)
        # A hard edge lights two neighbouring pixels of a central-difference
        # gradient, so a synthetic box ties one pixel (0.5 m) either way.
        self.assertLessEqual(abs(dx - 4), 1)
        self.assertLessEqual(abs(dy - 3), 1)


class Sampling(unittest.TestCase):
    def test_roof_colour_ignores_an_overhanging_tree(self):
        img = np.full((120, 120, 3), 100, dtype=np.uint8)
        _house(img, 20, 20, 80, 70, (150, 80, 60))
        img[20:40, 20:40] = (60, 120, 50)  # a crown over one corner
        got = sample_roof(_block(img), np.ones(3, dtype=np.float32), 0.0,
                          [[(20, 20), (80, 20), (80, 70), (20, 70)]])
        self.assertIsNotNone(got)
        rgb, confidence, pixels = got
        self.assertTrue(np.all(np.abs(rgb - np.array([150, 80, 60])) <= 2), rgb)
        self.assertGreater(confidence, 0.5)
        self.assertGreater(pixels, 100)

    def test_two_lit_halves_give_a_colour_between_them(self):
        img = np.full((120, 120, 3), 100, dtype=np.uint8)
        _house(img, 20, 20, 80, 45, (180, 100, 80))  # sunlit half
        _house(img, 20, 45, 80, 70, (120, 66, 52))  # shaded half
        rgb, _c, _n = sample_roof(_block(img), np.ones(3, dtype=np.float32), 0.0,
                                  [[(20, 20), (80, 20), (80, 70), (20, 70)]])
        self.assertTrue(120 <= rgb[0] <= 180, rgb)

    def test_the_veil_comes_off(self):
        img = np.full((120, 120, 3), 100, dtype=np.uint8)
        _house(img, 20, 20, 80, 70, (150, 110, 90))
        rgb, _c, _n = sample_roof(_block(img), np.ones(3, dtype=np.float32), 30.0,
                                  [[(20, 20), (80, 20), (80, 70), (20, 70)]])
        expect = (np.array([150, 110, 90]) - 30) / (1 - 30 / 255)
        self.assertTrue(np.all(np.abs(rgb - expect) <= 2), (rgb, expect))

    def test_white_is_no_data(self):
        img = np.full((120, 120, 3), 255, dtype=np.uint8)
        self.assertIsNone(sample_roof(_block(img), np.ones(3, dtype=np.float32), 0.0,
                                      [[(20, 20), (80, 20), (80, 70), (20, 70)]]))

    def test_a_footprint_too_small_to_read(self):
        img = np.full((120, 120, 3), 100, dtype=np.uint8)
        self.assertIsNone(sample_roof(_block(img), np.ones(3, dtype=np.float32), 0.0,
                                      [[(20, 20), (23, 20), (23, 23), (20, 23)]]))


class Store(unittest.TestCase):
    def test_round_trip(self):
        recs = [(-7, 1, 2, 3, 200, 1, 9, -4, 5), (42, 150, 80, 60, 255, 1, 31, 0, 0)]
        sig, got = decode_bcs(encode_bcs(0xDEADBEEF, recs))
        self.assertEqual(sig, 0xDEADBEEF)
        self.assertEqual(got, sorted(recs))
        self.assertEqual(RES_M, 0.5)


if __name__ == '__main__':
    unittest.main()

"""Tests for tools/measure_roof_shapes.py: the roof template fit on synthetic surfaces, and the BHS1 format."""
from __future__ import annotations

import math
import unittest

import numpy as np

from measure_roof_shapes import (
    FLAT, GABLED, GRID_M, HALF_HIPPED, HIPPED, PYRAMIDAL, SKILLION, decode_bhs, encode_bhs, fit_building, fit_roof,
    min_area_rect, shape_fn,
)


def house(form: int, length=14.0, width=9.0, angle_deg=23.0, eave=506.0, rise=4.0, flip=False, noise=0.0, seed=1,
          t0=0.0):
    """Outline and surface points of a roof over a rotated rectangle, ridge along its long side."""
    a = math.radians(angle_deg)
    c, s = math.cos(a), math.sin(a)
    L, W = length / 2, width / 2
    corners = np.array([[-L, -W], [L, -W], [L, W], [-L, W]])
    rot = lambda p: np.stack([p[:, 0] * c - p[:, 1] * s + 650000, p[:, 0] * s + p[:, 1] * c + 5260000], axis=1)  # noqa: E731
    gs = np.arange(-L + 0.2, L, 0.4)
    gt = np.arange(-W + 0.2, W, 0.4)
    S, T = np.meshgrid(gs, gt)
    S, T = S.ravel(), T.ravel()
    f = shape_fn(form, S, -T if flip else T, L, W, t0)
    h = eave + rise * f  # f is all zero for a flat roof
    h = h + np.random.default_rng(seed).normal(0, noise, h.shape)
    pts = rot(np.stack([S, T], axis=1))
    return rot(corners), pts[:, 0], pts[:, 1], h


class Fit(unittest.TestCase):
    def check(self, form, **kw):
        outline, px, py, h = house(form, **kw)
        got = fit_roof(outline, px, py, h)
        self.assertIsNotNone(got)
        self.assertEqual(got['form'], form, got)
        self.assertAlmostEqual(got['eave'], kw.get('eave', 506.0), delta=0.15)
        rise = 0.0 if form == FLAT else kw.get('rise', 4.0)
        self.assertAlmostEqual(got['ridge'], kw.get('eave', 506.0) + rise, delta=0.2)
        return got

    def test_every_form_comes_back(self):
        for form in (FLAT, GABLED, HIPPED, HALF_HIPPED, PYRAMIDAL):
            with self.subTest(form=form):
                self.check(form, noise=0.1)

    def test_gable_ridge_azimuth(self):
        got = self.check(GABLED, angle_deg=23.0, noise=0.1)
        # Ridge 23 deg from east toward north: compass 67 (or the opposite way, 247).
        self.assertAlmostEqual(min(abs(got['azimuth'] - 67.0), abs(got['azimuth'] - 247.0)), 0.0, delta=1.0)

    def test_skillion_knows_which_side_is_up(self):
        for flip in (False, True):
            with self.subTest(flip=flip):
                outline, px, py, h = house(SKILLION, rise=2.5, flip=flip, noise=0.05)
                got = fit_roof(outline, px, py, h)
                self.assertEqual(got['form'], SKILLION)
                # The quarter turn counter-clockwise from the ridge axis points uphill.
                phi = got['phi'] + math.pi / 2
                up = np.array([math.cos(phi), math.sin(phi)])
                hi = np.argmax(h)
                lo = np.argmin(h)
                self.assertGreater((np.array([px[hi] - px[lo], py[hi] - py[lo]]) @ up), 0)

    def test_an_off_centre_ridge_is_still_a_gable(self):
        # The first Garmisch run called these skillion: the ridge 1.8 m off the middle.
        outline, px, py, h = house(GABLED, t0=1.8, noise=0.1)
        got = fit_roof(outline, px, py, h)
        self.assertEqual(got['form'], GABLED)
        # Measured from whichever end the rectangle's long axis starts at.
        self.assertAlmostEqual(abs(got['offset']), 1.8, delta=0.5)

    def test_a_low_pitch_is_flat(self):
        outline, px, py, h = house(GABLED, rise=0.3, noise=0.1)
        self.assertEqual(fit_roof(outline, px, py, h)['form'], FLAT)

    def test_a_chimney_does_not_change_the_answer(self):
        outline, px, py, h = house(GABLED, noise=0.05)
        h = h.copy()
        h[:12] += 3.0
        got = fit_roof(outline, px, py, h)
        self.assertEqual(got['form'], GABLED)
        self.assertAlmostEqual(got['ridge'], 510.0, delta=0.2)

    def test_too_few_points(self):
        outline, px, py, h = house(GABLED)
        self.assertIsNone(fit_roof(outline, px[:10], py[:10], h[:10]))

    def test_min_area_rect(self):
        outline, *_ = house(GABLED, angle_deg=23.0)
        ang, long, short = min_area_rect(outline)
        self.assertAlmostEqual(long, 14.0, places=6)
        self.assertAlmostEqual(short, 9.0, places=6)
        self.assertAlmostEqual(math.degrees(ang) % 180.0, 23.0, places=6)


class Registration(unittest.TestCase):
    def test_the_footprint_is_slid_onto_its_roof(self):
        # A 12 x 8 m gable on flat ground at 500 m, the OSM outline 1.2 m west and 0.8 m north of it.
        gx0, gy1, n = 1000.0, 2040.0, 100
        rows, cols = np.indices((n, n))
        x = gx0 + (cols + 0.5) * GRID_M
        y = gy1 - (rows + 0.5) * GRID_M
        ground = np.full((n, n), 500.0, dtype=np.float32)
        inside = (x > 1014) & (x < 1026) & (y > 2016) & (y < 2024)
        t = y - 2020.0
        surf = np.where(inside, 505.0 + 3.5 * (1 - np.abs(t) / 4.0), 500.0).astype(np.float32)
        outline = np.array([[1014, 2016], [1026, 2016], [1026, 2024], [1014, 2024]], dtype=float) + [-1.2, 0.8]
        got = fit_building(outline, [], (surf, ground, gx0, gy1))
        self.assertEqual(got['form'], GABLED)
        self.assertAlmostEqual(got['shift'][0], 1.2, delta=0.41)
        self.assertAlmostEqual(got['shift'][1], -0.8, delta=0.41)
        self.assertAlmostEqual(got['ridge'] - got['ground'], 8.5, delta=0.3)

    def test_nothing_standing_is_absent(self):
        n = 60
        flat = np.full((n, n), 500.0, dtype=np.float32)
        outline = np.array([[1005, 2005], [1015, 2005], [1015, 2015], [1005, 2015]], dtype=float)
        got = fit_building(outline, [], (flat, flat.copy(), 1000.0, 2024.0))
        self.assertTrue(got['absent'])


class Store(unittest.TestCase):
    def test_round_trip(self):
        recs = [(5, GABLED, 0, 6700, 580, 990, 12, 240, 300), (-3, 0, 1, 0, 0, 0, 0, 0, 40)]
        sig, got = decode_bhs(encode_bhs(0x1234, recs))
        self.assertEqual(sig, 0x1234)
        self.assertEqual(got, sorted(recs))


class Sources(unittest.TestCase):
    def test_leaves_go_to_their_state(self):
        import measure_roof_shapes as m
        self.assertEqual(m.source_for(4348, 967).name, 'bavaria')
        self.assertEqual(m.source_for(4392, 855).name, 'brandenburg')
        self.assertIsNone(m.source_for(4254, 888))  # Cologne

    def test_brandenburg_window_lands_on_the_tile_lattice(self):
        import measure_roof_shapes as m
        dom = m.BrandenburgBdom()
        n = dom.cells
        # Each cell holds its own centre's easting, so a slip of one cell shows.
        cols = np.arange(n) * GRID_M + GRID_M / 2
        for ix in (368, 369):
            dom.mem[(ix, 5807)] = np.tile((ix * 1000 + cols).astype(np.float32), (n, 1))
        # A window straddling the two tiles' shared edge at x = 369000.
        surf, gx0, gy1 = dom.read(368990.1, 5807500.0, 369010.3, 5807510.0)
        centres = gx0 + (np.arange(surf.shape[1]) + 0.5) * GRID_M
        np.testing.assert_allclose(surf[0], centres, atol=1e-3)
        self.assertTrue(np.isfinite(surf).all())


if __name__ == '__main__':
    unittest.main()

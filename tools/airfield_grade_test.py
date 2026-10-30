"""Tests for tools/airfield_grade.py: the profiles runways and taxiways are
laid on, and the limits they are held to."""
from __future__ import annotations

import unittest

import numpy as np

import airfield_grade as AG


class SolveTest(unittest.TestCase):

    def test_every_limit_holds_exactly_on_steep_ground(self):
        s = AG.stations_along(3000.0)
        step = float(s[1] - s[0])
        g, report = AG.grade_profile(100 + 0.03 * s, step, AG.RUNWAY_CODE_4, paved=True)
        stats = AG.profile_stats(g, step)
        self.assertLessEqual(stats['local'], 0.0125 + 1e-9)
        self.assertLessEqual(stats['overall'], 0.01 + 1e-9)
        self.assertGreaterEqual(stats['minRadiusM'], 30000.0 * (1 - 1e-6))
        self.assertEqual(report['status'], 'suspect')

    def test_dem_noise_on_level_ground_is_not_called_steep(self):
        s = AG.stations_along(3000.0)
        step = float(s[1] - s[0])
        rng = np.random.default_rng(7)
        _g, report = AG.grade_profile(100 + 0.004 * s + rng.normal(0, 0.5, len(s)),
                                      step, AG.RUNWAY_CODE_4, paved=True)
        self.assertEqual(report['status'], 'ok')

    def test_a_building_in_the_dem_does_not_lift_the_runway(self):
        s = AG.stations_along(2000.0)
        step = float(s[1] - s[0])
        h = np.full(len(s), 50.0)
        h[40:44] += 15.0
        g, _ = AG.grade_profile(h, step, AG.RUNWAY_CODE_4, paved=True)
        self.assertLess(float(np.max(g)) - 50.0, 0.5)

    def test_a_pin_is_held(self):
        g, _ = AG.grade_profile(np.full(20, 103.0), 20.0, AG.TAXIWAY_LARGE, paved=True, pins={0: 100.0})
        self.assertAlmostEqual(float(g[0]), 100.0, places=2)
        self.assertLessEqual(float(np.max(np.abs(np.diff(g)))) / 20.0, 0.015 + 1e-9)

    def test_stations_without_a_height_are_bridged(self):
        s = AG.stations_along(1000.0)
        h = 10 + 0.005 * s
        h[10:20] = np.nan
        g, _ = AG.grade_profile(h, float(s[1] - s[0]), AG.RUNWAY_CODE_12, paved=True)
        self.assertTrue(np.all(np.isfinite(g)))
        self.assertAlmostEqual(float(g[15]), float(10 + 0.005 * s[15]), delta=0.2)

    def test_limits_follow_the_runway_code(self):
        self.assertIs(AG.runway_limits(3000.0, 'asphalt'), AG.RUNWAY_CODE_4)
        self.assertIs(AG.runway_limits(1500.0, 'asphalt'), AG.RUNWAY_CODE_3)
        self.assertIs(AG.runway_limits(800.0, 'grass'), AG.RUNWAY_CODE_12)
        self.assertIs(AG.taxiway_limits(800.0), AG.TAXIWAY_SMALL)


class ApronPlaneTest(unittest.TestCase):

    def test_a_steep_apron_is_clamped_to_one_percent(self):
        x, y = np.meshgrid(np.arange(-100, 101, 20.0), np.arange(-100, 101, 20.0))
        fit = AG.fit_apron_plane(x.ravel(), y.ravel(), (20 + 0.03 * x).ravel())
        self.assertAlmostEqual(fit['gradient'], 0.01)
        self.assertAlmostEqual(fit['gradientRaw'], 0.03, places=6)
        self.assertAlmostEqual(fit['gradientHeadingDeg'], 90.0, places=6)
        self.assertAlmostEqual(fit['heightMsl'], 20.0, places=6)


if __name__ == '__main__':
    unittest.main()

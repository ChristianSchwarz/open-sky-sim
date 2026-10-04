"""Tests for tools/osm_turnouts.py: switch detection, the fitted curve, the zones."""
from __future__ import annotations

import math
import unittest

from osm_turnouts import (
    MAX_DEVIATION_M, TurnoutStats, _distance_to, fit_arc, fit_turnouts, zone_length_m,
)

LAT0, LON0 = 52.0, 13.0
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 111320.0


def ll(x: float, y: float):
    """Metres east/north of the origin as (lon, lat)."""
    return (LON0 + x / KX, LAT0 + y / KY)


def xy(p):
    return ((p[0] - LON0) * KX, (p[1] - LAT0) * KY)


def true_turnout(radius: float, turn_deg: float, straight: float):
    """A real diverging track off +x, turning left: arc then straight, in metres."""
    phi = math.radians(turn_deg)
    pts = []
    for k in range(0, 41):
        a = phi * k / 40
        pts.append((radius * math.sin(a), radius * (1 - math.cos(a))))
    ex, ey = pts[-1]
    pts.append((ex + straight * math.cos(phi), ey + straight * math.sin(phi)))
    return pts


def heading_deg(a, b):
    return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))


class FitArc(unittest.TestCase):
    def test_recovers_a_turnout_mapped_as_a_coarse_chord(self):
        real = true_turnout(190.0, 6.0, 120.0)
        # Mapped sparsely: the switch, one node part way round, the far end.
        mapped = [real[0], real[20], real[-1]]
        curve = fit_arc((1.0, 0.0), mapped, 190.0)
        self.assertIsNotNone(curve)
        # Leaves the through track tangentially...
        self.assertLess(abs(heading_deg(curve[0], curve[1])), 1.0)
        # ...stays near the real track, and ends on the mapped line.
        for p in curve:
            self.assertLess(_distance_to(p, real), MAX_DEVIATION_M)
        self.assertEqual(curve[-1], mapped[-1])

    def test_refuses_a_line_that_leaves_steeply_and_straight(self):
        # 20 degrees straight off the switch: no 300 m curve stays within
        # the deviation cap of it.
        mapped = [(0.0, 0.0), (100 * math.cos(math.radians(20)), 100 * math.sin(math.radians(20)))]
        self.assertIsNone(fit_arc((1.0, 0.0), mapped, 300.0))

    def test_refuses_a_short_stub(self):
        self.assertIsNone(fit_arc((1.0, 0.0), [(0.0, 0.0), (10.0, 0.5)], 190.0))

    def test_turns_right_as_well_as_left(self):
        real = [(x, -y) for x, y in true_turnout(190.0, 6.0, 120.0)]
        curve = fit_arc((1.0, 0.0), [real[0], real[20], real[-1]], 190.0)
        self.assertIsNotNone(curve)
        self.assertTrue(all(p[1] <= 1e-6 for p in curve))


class FitTurnouts(unittest.TestCase):
    def _network(self, split_main: bool):
        nodes = {}
        real = true_turnout(190.0, 6.0, 120.0)
        nodes[1] = ll(-200, 0)
        nodes[2] = ll(0, 0)            # the switch
        nodes[3] = ll(300, 0)
        nodes[10] = ll(*real[20])
        nodes[11] = ll(*real[-1])
        runs = []
        if split_main:
            runs.append((7, [1, 2]))
            runs.append((7, [2, 3]))
        else:
            runs.append((7, [1, 2, 3]))
        runs.append((8, [2, 10, 11]))
        return runs, nodes

    def test_a_siding_off_a_main_line_gets_its_curve_and_zones(self):
        for split in (False, True):
            runs, nodes = self._network(split)
            stats = TurnoutStats()
            coords = fit_turnouts(runs, nodes, {7: 300.0, 8: 190.0}, stats)
            self.assertEqual((stats.found, stats.fitted, stats.refused), (1, 1, 0), f'split={split}')
            siding = [xy(p) for p in coords[-1]]
            self.assertLess(abs(heading_deg(siding[0], siding[1])), 1.0)
            # The main line keeps its mapped shape.
            for r in range(len(runs) - 1):
                self.assertEqual(coords[r], [nodes[n] for n in runs[r][1]])
            t = stats.turnouts[0]
            self.assertEqual(t.radius_m, 190.0)
            for zone in (t.diverging_zone, t.through_zone):
                pts = [xy(p) for p in zone]
                length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
                self.assertAlmostEqual(length, zone_length_m(190.0), delta=0.5)
            # The through zone runs along the main line, the way the siding goes.
            through = [xy(p) for p in t.through_zone]
            self.assertTrue(all(abs(p[1]) < 0.01 and p[0] >= -0.01 for p in through))

    def test_a_crossing_at_a_right_angle_is_no_turnout(self):
        nodes = {1: ll(-100, 0), 2: ll(0, 0), 3: ll(100, 0), 4: ll(0, -100), 5: ll(0, 100)}
        stats = TurnoutStats()
        fit_turnouts([(7, [1, 2, 3]), (7, [4, 2, 5])], nodes, {7: 300.0}, stats)
        self.assertEqual(stats.found, 0)

    def test_a_y_split_fits_one_turnout_not_two(self):
        # Main split at the switch, siding leaving at 6 degrees: only the
        # siding is the diverging track, though each main half could pair
        # with it as a near-straight line.
        runs, nodes = self._network(True)
        stats = TurnoutStats()
        fit_turnouts(runs, nodes, {7: 300.0, 8: 190.0}, stats)
        self.assertEqual(stats.fitted, 1)
        self.assertEqual(len(stats.turnouts), 1)


class Anchors(unittest.TestCase):
    def test_a_curve_stops_at_a_node_another_track_starts_from(self):
        # A siding off the main line, and a second siding branching off the
        # first 40 m along it: the first siding's curve must still pass
        # through that node, or the second starts beside it.
        real = true_turnout(190.0, 6.0, 120.0)
        nodes = {1: ll(-200, 0), 2: ll(0, 0), 3: ll(300, 0)}
        nodes[10] = ll(*real[13])          # ~40 m along the first siding
        nodes[11] = ll(*real[-1])
        nodes[20] = ll(real[13][0] + 100, real[13][1] + 30)
        runs = [(7, [1, 2, 3]), (8, [2, 10, 11]), (8, [10, 20])]
        stats = TurnoutStats()
        coords = fit_turnouts(runs, nodes, {7: 300.0, 8: 190.0}, stats)
        branch = xy(nodes[10])
        siding = [xy(p) for p in coords[1]]
        self.assertLess(min(math.hypot(p[0] - branch[0], p[1] - branch[1]) for p in siding), 0.01)
        self.assertEqual(coords[2][0], nodes[10])


if __name__ == '__main__':
    unittest.main()

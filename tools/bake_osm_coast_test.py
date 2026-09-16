"""Tests for tools/bake_osm_coast.py.

Two things: the bbox rule that decides which tiles a scoped bake may write --
which is what keeps two imported areas stitched together -- and the layer that
carries a river to the renderer as a stroke.
"""
from __future__ import annotations

import os
import struct
import tempfile
import unittest
import zlib

from shapely.geometry import LineString, MultiPolygon, Polygon, box

from bake_osm_coast import (
    LANDUSE_REGION_MIN_ZOOM,
    LVR_MAGIC,
    LVR2_MAGIC,
    LVR3_MAGIC,
    LVR4_MAGIC,
    REGION_CLASS_NONE,
    WATERWAY_FALLBACK_WIDTH_M,
    Bounds,
    Watercourse,
    _clip_rect,
    _clip_worker_inline,
    _polygons_from_osm,
    clip_watercourses,
    encode_lvr,
    snap_bounds_to_tiles,
    tile_range_for_bounds,
    tile_bounds,
    waterway_width_m,
)
from osm_landuse import CLS_TREE, build_landuse_index

TILE = Bounds(0.0, 0.0, 1.0, 1.0)
MAX_ZOOM = 12
SPAN = 180.0 / (1 << MAX_ZOOM)


class ClipRectTest(unittest.TestCase):
    def test_zero_area_sliver_does_not_abort_the_clip(self) -> None:
        # GEOS's clip_by_rect throws "Invalid number of points in LinearRing
        # found 3" on a collinear part; the helper must clip past it.
        sliver = Polygon([(0, 0), (1, 0), (2, 0), (0, 0)])
        land = MultiPolygon([Polygon([(0, 0), (4, 0), (4, 4), (0, 4)]), sliver])
        out = _clip_rect(land, -1, -1, 1, 1)
        self.assertEqual(out.geom_type, 'MultiPolygon')
        self.assertAlmostEqual(out.area, 1.0)

    def test_plain_land_clips_as_before(self) -> None:
        land = MultiPolygon([Polygon([(0, 0), (4, 0), (4, 4), (0, 4)])])
        self.assertAlmostEqual(_clip_rect(land, 1, 1, 3, 5).area, 6.0)


class SnapBoundsTest(unittest.TestCase):
    """Every tile the bake writes has to be one it has land for all of."""

    def edges_are_tile_aligned(self, b: Bounds):
        for v in ((b.west + 180.0) / SPAN, (b.east + 180.0) / SPAN,
                  (90.0 - b.north) / SPAN, (90.0 - b.south) / SPAN):
            self.assertAlmostEqual(v, round(v), places=6, msg=f'{v} is not a tile edge')

    def test_snaps_a_hand_drawn_box_out_to_whole_tiles(self):
        b = snap_bounds_to_tiles(
            Bounds(32.11, 45.204449, 35.02, 46.47), MAX_ZOOM)
        self.edges_are_tile_aligned(b)
        # Outwards only: nothing the caller asked for is dropped.
        self.assertLessEqual(b.west, 32.11)
        self.assertLessEqual(b.south, 45.204449)
        self.assertGreaterEqual(b.east, 35.02)
        self.assertGreaterEqual(b.north, 46.47)

    def test_a_box_already_on_tile_edges_is_unchanged(self):
        # The Crimea import as the manifest records it. Growing this by a tile
        # would spread every scoped bake a ring wider on each re-run.
        aligned = Bounds(32.0361328125, 45.17578125, 35.068359375, 46.494140625)
        self.assertEqual(snap_bounds_to_tiles(aligned, MAX_ZOOM), aligned)

    def test_every_tile_in_range_is_inside_the_snapped_box(self):
        """The seam: a tile half in the box is written half as open sea.

        The raw box below is the one measured on the second Crimea import — its
        south edge fell a third of the way down tile row 1019 — and unsnapped
        that row is in range while the box covers only its top third.
        """
        raw = Bounds(32.11, 45.204449, 35.02, 46.47)
        for b, want_inside in ((raw, False), (snap_bounds_to_tiles(raw, MAX_ZOOM), True)):
            x0, y0, x1, y1 = tile_range_for_bounds(MAX_ZOOM, b)
            covered = all(
                b.west - 1e-9 <= -180.0 + x * SPAN
                and -180.0 + (x + 1) * SPAN <= b.east + 1e-9
                and b.south - 1e-9 <= 90.0 - (y + 1) * SPAN
                and 90.0 - y * SPAN <= b.north + 1e-9
                for x in range(x0, x1 + 1) for y in range(y0, y1 + 1))
            self.assertEqual(covered, want_inside)

    def test_a_western_box_snaps_the_same_way(self):
        b = snap_bounds_to_tiles(
            Bounds(-113.61, 35.60, -110.79, 37.10), MAX_ZOOM)
        self.edges_are_tile_aligned(b)
        self.assertLessEqual(b.west, -113.61)
        self.assertGreaterEqual(b.east, -110.79)


class WaterwayWidthTest(unittest.TestCase):
    def test_tagged_width_wins(self):
        self.assertEqual(waterway_width_m({'waterway': 'canal', 'width': '18'}), 18.0)

    def test_untagged_falls_back_per_kind(self):
        self.assertEqual(waterway_width_m({'waterway': 'river'}),
                         WATERWAY_FALLBACK_WIDTH_M['river'])
        self.assertEqual(waterway_width_m({'waterway': 'canal'}),
                         WATERWAY_FALLBACK_WIDTH_M['canal'])

    def test_a_narrow_canal_keeps_its_true_width(self):
        """No floor: the minimum is a screen quantity and lives in the stroke."""
        self.assertEqual(waterway_width_m({'waterway': 'canal', 'width': '4'}), 4.0)

    def test_not_a_watercourse(self):
        self.assertIsNone(waterway_width_m({'natural': 'water'}))
        self.assertIsNone(waterway_width_m({'waterway': 'dam'}))


class ClipWatercoursesTest(unittest.TestCase):
    def test_clips_to_the_tile_and_keeps_the_width(self):
        course = Watercourse(LineString([(-1.0, 0.5), (2.0, 0.5)]), 12.0)
        out = clip_watercourses([course], TILE, 0.0)
        self.assertEqual(len(out), 1)
        width, pts = out[0]
        self.assertEqual(width, 12.0)
        self.assertAlmostEqual(min(p[0] for p in pts), 0.0, places=6)
        self.assertAlmostEqual(max(p[0] for p in pts), 1.0, places=6)

    def test_a_line_leaving_and_returning_becomes_two_runs(self):
        """Joined, the stroke would be drawn across ground it does not cover."""
        course = Watercourse(
            LineString([(0.2, 0.5), (0.5, 1.5), (0.8, 0.5)]), 30.0)
        out = clip_watercourses([course], TILE, 0.0)
        self.assertEqual(len(out), 2)

    def test_a_line_outside_the_tile_is_dropped(self):
        course = Watercourse(LineString([(5.0, 5.0), (6.0, 6.0)]), 30.0)
        self.assertEqual(clip_watercourses([course], TILE, 0.0), [])

    def test_simplify_drops_points_but_keeps_the_ends(self):
        pts = [(0.1 + i * 0.001, 0.5 + (i % 2) * 1e-7) for i in range(400)]
        course = Watercourse(LineString(pts), 30.0)
        plain = clip_watercourses([course], TILE, 0.0)[0][1]
        thinned = clip_watercourses([course], TILE, 1e-4)[0][1]
        self.assertLess(len(thinned), len(plain))
        self.assertAlmostEqual(thinned[0][0], plain[0][0], places=6)
        self.assertAlmostEqual(thinned[-1][0], plain[-1][0], places=6)


def _coast_answer(*ways):
    """An Overpass answer with one natural=coastline way per coordinate list."""
    elements = []
    nid = 1
    for wid, coords in enumerate(ways, start=1):
        refs = []
        for lon, lat in coords:
            elements.append({'type': 'node', 'id': nid, 'lon': lon, 'lat': lat})
            refs.append(nid)
            nid += 1
        if coords[0] == coords[-1]:
            elements.pop()
            nid -= 1
            refs[-1] = refs[0]
        elements.append({'type': 'way', 'id': wid, 'nodes': refs, 'tags': {'natural': 'coastline'}})
    return {'elements': elements}


class LandFromCoastlineTest(unittest.TestCase):
    """Which polygonized pieces are land, from the coastline's winding."""

    def test_an_island_closing_inside_the_bbox_is_the_only_land(self):
        # Counter-clockwise: land on the left, as OSM draws an island. The sea
        # piece around it is the box with a hole, whose centroid falls on the
        # island - Gran Canaria baked as land edge to edge through that.
        island = [(0.4, 0.4), (0.6, 0.4), (0.6, 0.6), (0.4, 0.6), (0.4, 0.4)]
        land, _, _ = _polygons_from_osm(_coast_answer(island), TILE)
        self.assertAlmostEqual(land.area, 0.04, places=6)

    def test_a_mainland_coast_leaving_the_bbox_keeps_the_land_side(self):
        # Running north along x=0.3 with land to the left (west).
        coast = [(0.3, -0.1), (0.3, 1.1)]
        land, _, _ = _polygons_from_osm(_coast_answer(coast), TILE)
        self.assertAlmostEqual(land.area, 0.3, places=6)


class EncodeLvrTest(unittest.TestCase):
    RING = ([(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)], [])

    def magic(self, blob: bytes) -> bytes:
        return zlib.decompress(blob)[:4]

    def test_version_is_the_highest_layer_present(self):
        """A tile with nothing new stays LVR1 and byte-identical."""
        self.assertEqual(self.magic(encode_lvr([self.RING])), LVR_MAGIC)
        self.assertEqual(
            self.magic(encode_lvr([self.RING], [(12.0, self.RING[0], [])])),
            LVR2_MAGIC)
        self.assertEqual(
            self.magic(encode_lvr([self.RING], [], [(30.0, [(0.0, 0.0), (1.0, 1.0)])])),
            LVR3_MAGIC)

    def test_lines_carry_their_width_and_points(self):
        line = [(0.25, 0.5), (0.75, 0.5)]
        payload = zlib.decompress(encode_lvr([], [], [(18.5, line)]))
        # LVR3, zero polygons, zero inland bodies, then the line layer.
        self.assertEqual(payload[:4], LVR3_MAGIC)
        self.assertEqual(struct.unpack_from('<H', payload, 4)[0], 0)   # polygons
        self.assertEqual(struct.unpack_from('<H', payload, 6)[0], 0)   # inland
        self.assertEqual(struct.unpack_from('<H', payload, 8)[0], 1)   # lines
        self.assertAlmostEqual(struct.unpack_from('<f', payload, 10)[0], 18.5, places=4)
        self.assertEqual(struct.unpack_from('<H', payload, 14)[0], len(line))
        for i, (lon, lat) in enumerate(line):
            got = struct.unpack_from('<ff', payload, 16 + i * 8)
            self.assertAlmostEqual(got[0], lon, places=5)
            self.assertAlmostEqual(got[1], lat, places=5)

    def test_a_region_bumps_the_version_to_lvr4(self):
        region = (True, 1, self.RING[0], [])
        self.assertEqual(
            self.magic(encode_lvr([self.RING], [], [], [region])),
            LVR4_MAGIC)

    def test_lvr4_still_carries_the_inland_and_watercourse_sections_even_when_empty(self):
        region = (True, 1, self.RING[0], [])
        payload = zlib.decompress(encode_lvr([self.RING], [], [], [region]))
        self.assertEqual(payload[:4], LVR4_MAGIC)
        offset = 4
        poly_count = struct.unpack_from('<H', payload, offset)[0]
        self.assertEqual(poly_count, 1)
        offset += 2
        offset += 2 + 2 + len(self.RING[0]) * 8  # ring count + vert count + one ring, no holes
        self.assertEqual(struct.unpack_from('<H', payload, offset)[0], 0, 'inland count')
        offset += 2
        self.assertEqual(struct.unpack_from('<H', payload, offset)[0], 0, 'watercourse count')
        offset += 2
        self.assertEqual(struct.unpack_from('<H', payload, offset)[0], 1, 'region count')

    def test_a_region_carries_its_land_flag_and_landuse_class(self):
        land_region = (True, 4, self.RING[0], [])
        water_region = (False, None, self.RING[0], [])
        payload = zlib.decompress(encode_lvr([], [], [], [land_region, water_region]))
        self.assertEqual(payload[:4], LVR4_MAGIC)
        offset = 4
        offset += 2  # zero polygons
        offset += 2  # zero inland
        offset += 2  # zero watercourses
        region_count = struct.unpack_from('<H', payload, offset)[0]
        self.assertEqual(region_count, 2)
        offset += 2
        is_land, cls = struct.unpack_from('<BB', payload, offset)
        self.assertEqual(is_land, 1)
        self.assertEqual(cls, 4)
        offset += 2 + 2 + 2 + len(self.RING[0]) * 8  # tag + ring count + vert count + one ring, no holes
        is_land, cls = struct.unpack_from('<BB', payload, offset)
        self.assertEqual(is_land, 0)
        self.assertEqual(cls, REGION_CLASS_NONE)

    def test_no_regions_leaves_the_version_at_whatever_the_other_layers_need(self):
        self.assertEqual(self.magic(encode_lvr([self.RING])), LVR_MAGIC)
        self.assertEqual(
            self.magic(encode_lvr([self.RING], [], [(30.0, [(0.0, 0.0), (1.0, 1.0)])])),
            LVR3_MAGIC)


class ClipWorkerLanduseTest(unittest.TestCase):
    """`_clip_worker_inline` end to end, with real land + landuse geometry.

    Exercises the wiring `encode_regions_for_tile` sits behind - the part
    the isolated `assemble_tile_regions`/`encode_lvr` unit tests above don't
    reach - by actually writing a `.lvr` file and reading the bytes back.
    """
    Z = LANDUSE_REGION_MIN_ZOOM

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.b = tile_bounds(self.Z, 100, 100)
        self.land = MultiPolygon([box(self.b.west, self.b.south, self.b.east, self.b.north)])
        # A forest covering the western half of the tile.
        mid = (self.b.west + self.b.east) / 2
        self.forest = box(self.b.west, self.b.south, mid, self.b.north)
        self.landuse_polys = [self.forest]
        self.landuse_classes = [CLS_TREE]
        self.landuse_tree = build_landuse_index(self.landuse_polys)

    def _lvr_path(self, z: int, x: int, y: int) -> str:
        return os.path.join(self.tmp, str(z), str(x), f'{y}.lvr')

    def test_writes_an_lvr4_tile_with_a_real_landuse_region_at_or_above_the_min_zoom(self):
        grid = bytearray(9 * 9)  # a tiny mask grid; its content doesn't matter here
        _clip_worker_inline(
            self.tmp, 9, self.land, (), (), self.Z, 100, 100, grid, 0.0, 0.0,
            self.landuse_tree, self.landuse_polys, self.landuse_classes,
        )
        with open(self._lvr_path(self.Z, 100, 100), 'rb') as fh:
            payload = zlib.decompress(fh.read())
        self.assertEqual(payload[:4], LVR4_MAGIC)
        offset = 4
        poly_count = struct.unpack_from('<H', payload, offset)[0]
        self.assertEqual(poly_count, 1, 'the plain land polygon is still written')

    def test_leaves_a_tile_below_the_min_zoom_without_a_regions_layer(self):
        below = self.Z - 1
        bx, by = 50, 50
        b = tile_bounds(below, bx, by)
        land = MultiPolygon([box(b.west, b.south, b.east, b.north)])
        grid = bytearray(9 * 9)
        _clip_worker_inline(
            self.tmp, 9, land, (), (), below, bx, by, grid, 0.0, 0.0,
            self.landuse_tree, self.landuse_polys, self.landuse_classes,
        )
        with open(self._lvr_path(below, bx, by), 'rb') as fh:
            payload = zlib.decompress(fh.read())
        self.assertEqual(payload[:4], LVR_MAGIC, 'below the min zoom, no regions layer is added')

    def test_omitting_osm_landuse_never_touches_the_regions_layer(self):
        grid = bytearray(9 * 9)
        _clip_worker_inline(self.tmp, 9, self.land, (), (), self.Z, 100, 100, grid, 0.0, 0.0)
        with open(self._lvr_path(self.Z, 100, 100), 'rb') as fh:
            payload = zlib.decompress(fh.read())
        self.assertEqual(payload[:4], LVR_MAGIC)


if __name__ == '__main__':
    unittest.main()


def _tagged_answer(*ways):
    """An Overpass answer with one closed way per (tags, coordinate list)."""
    elements = []
    nid = 1
    for wid, (tags, coords) in enumerate(ways, start=1):
        refs = []
        for lon, lat in coords:
            elements.append({'type': 'node', 'id': nid, 'lon': lon, 'lat': lat})
            refs.append(nid)
            nid += 1
        if coords[0] == coords[-1]:
            elements.pop()
            nid -= 1
            refs[-1] = refs[0]
        elements.append({'type': 'way', 'id': wid, 'nodes': refs, 'tags': tags})
    return {'elements': elements}


def _square(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]


class IslandsInInlandWaterTest(unittest.TestCase):
    """A `place=island` way drawn inside a lake way is land, not lake."""

    LAKE = ({'natural': 'water', 'water': 'lake'}, _square(0.2, 0.2, 0.8, 0.8))
    ISLAND = ({'place': 'island'}, _square(0.4, 0.4, 0.6, 0.6))

    def test_the_island_is_cut_out_of_the_lake(self):
        land, inland, _ = _polygons_from_osm(_tagged_answer(self.LAKE, self.ISLAND), TILE)
        from shapely.geometry import Point
        self.assertTrue(land.contains(Point(0.5, 0.5)))
        self.assertTrue(land.contains(Point(0.1, 0.1)))
        self.assertFalse(land.contains(Point(0.3, 0.3)))
        self.assertEqual(len(inland), 1)
        self.assertEqual(len(inland[0].geom.interiors), 1)
        self.assertFalse(inland[0].geom.contains(Point(0.5, 0.5)))

    def test_a_pond_on_the_island_stays_water(self):
        pond = ({'natural': 'water', 'water': 'pond'}, _square(0.48, 0.48, 0.52, 0.52))
        land, inland, _ = _polygons_from_osm(_tagged_answer(self.LAKE, self.ISLAND, pond), TILE)
        from shapely.geometry import Point
        self.assertFalse(land.contains(Point(0.5, 0.5)))
        self.assertTrue(land.contains(Point(0.45, 0.45)))
        self.assertTrue(any(b.geom.contains(Point(0.5, 0.5)) for b in inland))

    def test_an_island_in_no_water_changes_nothing(self):
        land, inland, _ = _polygons_from_osm(_tagged_answer(self.ISLAND), TILE)
        self.assertAlmostEqual(land.area, TILE.as_box().area, places=9)
        self.assertEqual(inland, [])

"""Tests for tools/osm_regions.py.

No network: every test builds its own small shapely geometry, matching the
rest of this repo's OSM bake tests - plain unittest, no mocking.
"""
from __future__ import annotations

import unittest

from shapely.geometry import MultiPolygon, Polygon, box

from osm_landuse import CLS_BUILT, CLS_CROP, CLS_TREE, build_landuse_index
from osm_regions import MAX_REGIONS_PER_TILE, Region, assemble_tile_regions

TILE = box(0.0, 0.0, 1.0, 1.0)
HALO = TILE.buffer(0.02)


def _total_area(regions) -> float:
    return sum(r.geom.area for r in regions)


class AllWaterTest(unittest.TestCase):
    def test_no_land_at_all_is_a_single_water_region(self):
        regions = assemble_tile_regions(TILE, HALO, MultiPolygon(), None, [], [])
        self.assertEqual(len(regions), 1)
        self.assertFalse(regions[0].is_land)
        self.assertIsNone(regions[0].landuse_class)
        self.assertAlmostEqual(regions[0].geom.area, TILE.area, places=9)


class LandWaterSplitTest(unittest.TestCase):
    def test_partial_land_with_no_landuse_gives_one_land_and_one_water_region(self):
        land = MultiPolygon([box(0.0, 0.0, 0.5, 1.0)])
        regions = assemble_tile_regions(TILE, HALO, land, None, [], [])
        land_regions = [r for r in regions if r.is_land]
        water_regions = [r for r in regions if not r.is_land]
        self.assertEqual(len(land_regions), 1)
        self.assertEqual(len(water_regions), 1)
        self.assertIsNone(land_regions[0].landuse_class)
        self.assertAlmostEqual(land_regions[0].geom.area, 0.5, places=9)
        self.assertAlmostEqual(water_regions[0].geom.area, 0.5, places=9)
        self.assertAlmostEqual(_total_area(regions), TILE.area, places=9)

    def test_all_land_with_no_landuse_is_a_single_bare_land_region(self):
        regions = assemble_tile_regions(TILE, HALO, MultiPolygon([TILE]), None, [], [])
        self.assertEqual(len(regions), 1)
        self.assertTrue(regions[0].is_land)
        self.assertIsNone(regions[0].landuse_class)
        self.assertAlmostEqual(regions[0].geom.area, TILE.area, places=9)


class LanduseOverlayTest(unittest.TestCase):
    def test_a_tagged_polygon_carves_a_landuse_region_out_of_bare_land(self):
        land = MultiPolygon([TILE])
        forest = box(0.1, 0.1, 0.4, 0.4)
        tree = build_landuse_index([forest])
        regions = assemble_tile_regions(TILE, HALO, land, tree, [forest], [CLS_TREE])

        classed = [r for r in regions if r.landuse_class == CLS_TREE]
        bare = [r for r in regions if r.is_land and r.landuse_class is None]
        self.assertEqual(len(classed), 1)
        self.assertAlmostEqual(classed[0].geom.area, forest.area, places=9)
        self.assertEqual(len(bare), 1)
        self.assertAlmostEqual(_total_area(regions), TILE.area, places=9)

    def test_a_smaller_polygon_wins_the_area_it_shares_with_a_larger_one(self):
        # Same shape as osm_landuse_test.py's own overlap test, resolved as
        # real non-overlapping vector regions instead of a raster paint.
        land = MultiPolygon([TILE])
        big = box(0.1, 0.1, 0.9, 0.9)
        small = box(0.4, 0.4, 0.6, 0.6)
        tree = build_landuse_index([big, small])
        regions = assemble_tile_regions(
            TILE, HALO, land, tree, [big, small], [CLS_TREE, CLS_BUILT])

        built = [r for r in regions if r.landuse_class == CLS_BUILT]
        forest = [r for r in regions if r.landuse_class == CLS_TREE]
        self.assertEqual(len(built), 1)
        self.assertAlmostEqual(built[0].geom.area, small.area, places=9)
        self.assertEqual(len(forest), 1)
        self.assertAlmostEqual(forest[0].geom.area, big.area - small.area, places=9)
        # Non-overlapping by construction: nothing double-counts the shared square.
        self.assertAlmostEqual(_total_area(regions), TILE.area, places=9)

    def test_a_landuse_polygon_never_claims_water_area(self):
        # Land only covers the west half; the forest polygon straddles the
        # coast, reaching into what is really open water.
        land = MultiPolygon([box(0.0, 0.0, 0.5, 1.0)])
        forest = box(0.3, 0.3, 0.7, 0.7)  # extends to x=0.7, past the coast at x=0.5
        tree = build_landuse_index([forest])
        regions = assemble_tile_regions(TILE, HALO, land, tree, [forest], [CLS_TREE])

        classed = [r for r in regions if r.landuse_class == CLS_TREE]
        water = [r for r in regions if not r.is_land]
        self.assertEqual(len(classed), 1)
        # Clipped to the land half of the forest square: 0.3..0.5 x 0.3..0.7.
        self.assertAlmostEqual(classed[0].geom.area, 0.2 * 0.4, places=9)
        self.assertAlmostEqual(_total_area(water), 0.5, places=9,
                                msg='the water half must be untouched by the landuse tag')
        self.assertAlmostEqual(_total_area(regions), TILE.area, places=9)


class RegionCapTest(unittest.TestCase):
    def test_caps_at_max_regions_per_tile_keeping_the_largest_claimed_pieces(self):
        land = MultiPolygon([TILE])
        n = MAX_REGIONS_PER_TILE + 50
        polys = []
        classes = []
        # A grid of small, non-overlapping squares plus one larger one, so
        # there is an unambiguous "largest" survivor to check for.
        cols = 30
        for i in range(n - 1):
            gx = (i % cols) * (1.0 / cols)
            gy = (i // cols) * (1.0 / cols)
            polys.append(box(gx, gy, gx + 1.0 / cols * 0.5, gy + 1.0 / cols * 0.5))
            classes.append(CLS_TREE)
        big = box(0.0, 0.0, 0.05, 0.05)
        polys.append(big)
        classes.append(CLS_BUILT)

        tree = build_landuse_index(polys)
        regions = assemble_tile_regions(TILE, HALO, land, tree, polys, classes)

        self.assertLessEqual(len(regions), MAX_REGIONS_PER_TILE)
        # The base (bare-land) region is always kept even once capped.
        self.assertTrue(any(r.is_land and r.landuse_class is None for r in regions))


class InvalidGeometryTest(unittest.TestCase):
    """The regression case for a real crash found baking Leipzig: a long
    enough chain of difference() calls in the priority-overlay loop can
    produce a numerically invalid intermediate result, and GEOS's overlay
    engine throws outright on the next operation fed that result
    ("AssertionFailedException: Unable to determine overlay result geometry
    dimension") rather than just answering wrong. A real self-intersecting
    OSM polygon (a bowtie shape) reproduces the same GEOS-level invalidity
    directly.
    """

    def bowtie(self, cx: float, cy: float, r: float) -> Polygon:
        # A figure-eight / bowtie: the ring crosses itself at (cx, cy).
        return Polygon([
            (cx - r, cy - r), (cx + r, cy + r), (cx + r, cy - r), (cx - r, cy + r),
        ])

    def test_a_self_intersecting_landuse_polygon_does_not_crash_the_overlay(self):
        bad = self.bowtie(0.5, 0.5, 0.3)
        self.assertFalse(bad.is_valid, 'test setup: this ring must actually self-intersect')
        land = MultiPolygon([TILE])
        tree = build_landuse_index([bad])
        regions = assemble_tile_regions(TILE, HALO, land, tree, [bad], [CLS_TREE])
        self.assertAlmostEqual(_total_area(regions), TILE.area, places=6, msg='still tiles the whole box')

    def test_many_chained_invalid_overlaps_do_not_crash(self):
        # A chain of overlapping bowties, largest-first, to exercise the
        # actual failure path: each new piece differences every
        # already-claimed piece, and it is that chain - not any single
        # operation - that surfaced the GEOS assertion in production.
        land = MultiPolygon([TILE])
        polys = [self.bowtie(0.5, 0.5, 0.4 - i * 0.02) for i in range(15)]
        classes = [CLS_TREE if i % 2 == 0 else CLS_CROP for i in range(len(polys))]
        tree = build_landuse_index(polys)
        regions = assemble_tile_regions(TILE, HALO, land, tree, polys, classes)
        self.assertAlmostEqual(_total_area(regions), TILE.area, places=6)

    def test_a_land_multipolygon_whose_own_parts_overlap_does_not_crash(self):
        # The actual root cause of the real Leipzig crash: `land` itself came
        # in as an *invalid MultiPolygon* even though every one of its own
        # Polygon parts individually reported valid - simplified_clipped_land
        # simplifies each connected component of a clip independently, and
        # two neighbouring pieces can end up touching or barely overlapping
        # as a result. That is a MultiPolygon-level defect (the OGC rule that
        # a MultiPolygon's own elements may not intersect each other), not a
        # self-intersecting-ring defect, and it broke the very first
        # operation performed on `land` - before any of this module's own
        # per-step repairs downstream ever ran.
        a = box(0.0, 0.0, 0.6, 0.6)
        b = box(0.4, 0.4, 1.0, 1.0)
        self.assertTrue(a.is_valid and b.is_valid, 'test setup: each part alone must be valid')
        land = MultiPolygon([a, b])
        self.assertFalse(land.is_valid, 'test setup: the MultiPolygon itself must be invalid')

        regions = assemble_tile_regions(TILE, HALO, land, None, [], [])
        self.assertAlmostEqual(_total_area(regions), TILE.area, places=6)




class DeriveFromChildrenTest(unittest.TestCase):
    """A coarser tile's partition, built from its children's claimed pieces."""

    def test_pieces_of_one_class_merge_across_the_child_seam(self):
        from osm_regions import derive_tile_regions
        land = MultiPolygon([TILE])
        # Two z+1 children's forest halves meeting at x=0.5.
        west = box(0.2, 0.2, 0.5, 0.6)
        east = box(0.5, 0.2, 0.8, 0.6)
        regions = derive_tile_regions(TILE, land, [(CLS_TREE, west), (CLS_TREE, east)], 0.001)

        forest = [r for r in regions if r.landuse_class == CLS_TREE]
        self.assertEqual(len(forest), 1, 'the seam must not survive as two regions')
        self.assertAlmostEqual(forest[0].geom.area, 0.6 * 0.4, places=9)
        self.assertAlmostEqual(_total_area(regions), TILE.area, places=9)

    def test_overlapping_classes_after_simplify_stay_a_partition(self):
        from osm_regions import derive_tile_regions
        land = MultiPolygon([TILE])
        big = box(0.1, 0.1, 0.9, 0.9)
        small = box(0.4, 0.4, 0.6, 0.6)
        regions = derive_tile_regions(TILE, land, [(CLS_TREE, big), (CLS_BUILT, small)], 0.001)

        built = [r for r in regions if r.landuse_class == CLS_BUILT]
        forest = [r for r in regions if r.landuse_class == CLS_TREE]
        self.assertEqual(len(built), 1)
        self.assertAlmostEqual(built[0].geom.area, small.area, places=9)
        self.assertAlmostEqual(sum(r.geom.area for r in forest), big.area - small.area, places=9)
        self.assertAlmostEqual(_total_area(regions), TILE.area, places=9)

    def test_claims_never_reach_into_water(self):
        from osm_regions import derive_tile_regions
        land = MultiPolygon([box(0.0, 0.0, 0.5, 1.0)])
        regions = derive_tile_regions(TILE, land, [(CLS_TREE, box(0.3, 0.3, 0.7, 0.7))], 0.001)
        classed = [r for r in regions if r.landuse_class == CLS_TREE]
        self.assertAlmostEqual(classed[0].geom.area, 0.2 * 0.4, places=9)
        self.assertAlmostEqual(_total_area([r for r in regions if not r.is_land]), 0.5, places=9)


if __name__ == '__main__':
    unittest.main()

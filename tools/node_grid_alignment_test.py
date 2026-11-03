"""Two neighbouring tiles must sample their shared edge at the same points.

A tile's nodes sit on its edges (node i at i/(size-1) of the span, the DEM's
sample_grid): the last column of one tile and the first of its eastern
neighbour are the same world points. The rasterio paths built their grids
with from_bounds over the tile's own box, whose pixel centres sit at
(i+0.5)/size - half a cell inside each edge - so the two tiles read two
different points for one node, and the .plc cover, the OSM landuse stamp and
the .lwm mask were half a cell off the heights. These cases put a feature
narrower than a cell on the shared edge: only a grid whose edge pixels are
the edge nodes sees it, from both sides.
"""
from __future__ import annotations

import os
import tempfile
import unittest

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from shapely.geometry import MultiPolygon, box
from shapely.prepared import prep

from bake_osm_coast import LAND, rasterize_tile
from bake_planet_cover import Source
from osm_common import Bounds, node_pixel_bounds
from osm_landuse import CLS_BUILT, CLS_GRASS, build_landuse_index, stamp_landuse_classes

SIZE = 33
WEST_TILE = (0.5, 0.5, 1.0, 1.0)
EAST_TILE = (1.0, 0.5, 1.5, 1.0)


class NodePixelBoundsTest(unittest.TestCase):

    def test_pixel_centres_are_the_nodes(self):
        west, south, east, north = node_pixel_bounds(*WEST_TILE, SIZE)
        t = from_bounds(west, south, east, north, SIZE, SIZE)
        for i in (0, SIZE // 2, SIZE - 1):
            lon, lat = t * (i + 0.5, i + 0.5)
            self.assertAlmostEqual(lon, WEST_TILE[0] + (WEST_TILE[2] - WEST_TILE[0]) * i / (SIZE - 1))
            self.assertAlmostEqual(lat, WEST_TILE[3] - (WEST_TILE[3] - WEST_TILE[1]) * i / (SIZE - 1))


class CoverReadSharedEdgeTest(unittest.TestCase):
    """bake_planet_cover.py: a source read onto the node grid, as bake_tile reads it."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, 'cols.tif')
        # 0.01 deg pixels, each holding its own column number; shifted by a
        # third of a pixel so no node falls on a pixel edge.
        w, h = 200, 200
        with rasterio.open(
            self.path, 'w', driver='GTiff', width=w, height=h, count=1, dtype='uint8',
            crs='EPSG:4326', nodata=255, transform=from_bounds(-0.0033, 0.0, 1.9967, 2.0, w, h),
        ) as ds:
            ds.write(np.tile(np.arange(w, dtype='uint8'), (h, 1)), 1)
        self.src = Source(self.path, [1], 255)

    def tearDown(self):
        self.src.close()

    def read(self, tile):
        return self.src.read_onto(node_pixel_bounds(*tile, SIZE), SIZE, Resampling.nearest)[0]

    def test_shared_edge_nodes_read_the_same_pixel(self):
        a = self.read(WEST_TILE)
        b = self.read(EAST_TILE)
        np.testing.assert_array_equal(a[:, SIZE - 1], b[:, 0])
        # ...and it is the pixel under lon 1.0, not one either side of it.
        self.assertTrue(np.all(a[:, SIZE - 1] == int((1.0 + 0.0033) / 0.01)))

    def test_shared_edge_nodes_read_the_same_pixel_through_the_halo(self):
        # The halo read: a bigger node grid at the same spacing, cropped back.
        halo = 3
        pad = halo * (WEST_TILE[3] - WEST_TILE[1]) / (SIZE - 1)

        def read_halo(tile):
            w, s, e, n = tile
            size = SIZE + 2 * halo
            got = self.src.read_onto(node_pixel_bounds(w - pad, s - pad, e + pad, n + pad, size), size, Resampling.nearest)[0]
            return got[halo:halo + SIZE, halo:halo + SIZE]

        a = read_halo(WEST_TILE)
        b = read_halo(EAST_TILE)
        np.testing.assert_array_equal(a[:, SIZE - 1], b[:, 0])
        np.testing.assert_array_equal(a, self.read(WEST_TILE))


class LanduseStampSharedEdgeTest(unittest.TestCase):
    """osm_landuse.py stamp_landuse_classes."""

    def test_a_strip_on_the_shared_edge_is_stamped_on_both_sides(self):
        # Narrower than a node spacing (0.0156 deg), centred on lon 1.0.
        strip = box(0.996, 0.5, 1.004, 1.0)
        polys, classes = [strip], [CLS_BUILT]
        tree = build_landuse_index(polys)
        grids = []
        for tile in (WEST_TILE, EAST_TILE):
            g = np.full((SIZE, SIZE), CLS_GRASS, dtype=np.uint8)
            stamp_landuse_classes(g, tile, SIZE, tree, polys, classes)
            grids.append(g)
        a, b = grids
        mid = slice(2, SIZE - 2)  # clear of the strip's own north and south ends
        self.assertTrue(np.all(a[mid, SIZE - 1] == CLS_BUILT))
        self.assertTrue(np.all(b[mid, 0] == CLS_BUILT))
        self.assertTrue(np.all(a[:, :SIZE - 1] == CLS_GRASS))
        self.assertTrue(np.all(b[:, 1:] == CLS_GRASS))


class CoastMaskSharedEdgeTest(unittest.TestCase):
    """bake_osm_coast.py rasterize_tile: the rasterio path agrees with the point test."""

    def test_rasterio_path_samples_the_nodes_like_the_point_test(self):
        land = MultiPolygon([box(0.996, 0.4, 1.004, 1.1), box(0.7, 0.62, 0.8, 0.71)])
        land_prep = prep(land)
        masks = []
        for tile in (WEST_TILE, EAST_TILE):
            b = Bounds(*tile)
            got = np.frombuffer(bytes(rasterize_tile(land_prep, land, b, SIZE)), dtype=np.uint8).reshape(SIZE, SIZE)
            lons = b.west + (b.east - b.west) * np.arange(SIZE) / (SIZE - 1)
            lats = b.north - (b.north - b.south) * np.arange(SIZE) / (SIZE - 1)
            want = np.array([[land_prep.contains_properly(_pt(lon, lat)) for lon in lons] for lat in lats])
            np.testing.assert_array_equal(got == LAND, want)
            masks.append(got)
        a, b = masks
        np.testing.assert_array_equal(a[:, SIZE - 1], b[:, 0])
        self.assertTrue(np.all(a[:, SIZE - 1] == LAND))


def _pt(lon, lat):
    from shapely.geometry import Point
    return Point(lon, lat)


if __name__ == '__main__':
    unittest.main()

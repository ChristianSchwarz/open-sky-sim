"""Tests for tools/fetch_planet_dem.py."""
from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import numpy as np
from rasterio.transform import from_origin
from rasterio.windows import Window

import fetch_planet_dem
from fetch_planet_dem import (
    ARCSEC_DEG,
    DST_PAD_PX,
    NODATA,
    SRC_PAD_PX,
    TILE_SIZE,
    auto_max_zoom,
    cache_path,
    ensure_cached,
    fabdem_block_name,
    fabdem_tile_name,
    fabdem_tile_url,
    glue_negative_values,
    http_url,
    lattice_step,
    mosaic_into,
    parse_bbox,
    snap_bbox_to_pixels,
    snap_bbox_to_tiles,
    square_windows,
    target_grid,
    tile_name,
    tiles_for_bbox,
)


class ParseBboxTest(unittest.TestCase):

    def test_reads_west_south_east_north(self):
        self.assertEqual(parse_bbox('6.0,45.6,8.0,46.6'), (6.0, 45.6, 8.0, 46.6))

    def test_tolerates_spaces(self):
        self.assertEqual(parse_bbox(' 6 , 45 , 8 , 46 '), (6.0, 45.0, 8.0, 46.0))

    def test_rejects_wrong_arity(self):
        with self.assertRaises(ValueError):
            parse_bbox('1,2,3')

    def test_rejects_inverted_axes(self):
        with self.assertRaises(ValueError):
            parse_bbox('8,45,6,46')
        with self.assertRaises(ValueError):
            parse_bbox('6,46,8,45')

    def test_rejects_outside_wgs84(self):
        with self.assertRaises(ValueError):
            parse_bbox('179,45,181,46')

    def test_rejects_antimeridian_span(self):
        # west > east is how a bbox crossing 180 would be written. Nothing
        # downstream splits it, so it has to be refused rather than silently
        # fetched inside out.
        with self.assertRaises(ValueError):
            parse_bbox('179,45,-179,46')


class GlueNegativeValuesTest(unittest.TestCase):

    def test_glues_a_western_bbox(self):
        # The Canaries coverage. Left split, argparse reads it as an option.
        self.assertEqual(
            glue_negative_values(['--bbox', '-18.66,26.97,-12.61,30.49']),
            ['--bbox=-18.66,26.97,-12.61,30.49'],
        )

    def test_leaves_a_positive_bbox_split(self):
        self.assertEqual(
            glue_negative_values(['--bbox', '6,45,8,46']),
            ['--bbox', '6,45,8,46'],
        )

    def test_leaves_other_options_alone(self):
        self.assertEqual(
            glue_negative_values(['--out', 'a.tif', '--arcsec', '3']),
            ['--out', 'a.tif', '--arcsec', '3'],
        )

    def test_keeps_following_options(self):
        self.assertEqual(
            glue_negative_values(['--bbox', '-1,2,3,4', '--out', 'a.tif']),
            ['--bbox=-1,2,3,4', '--out', 'a.tif'],
        )

    def test_trailing_bbox_without_a_value_is_left_for_argparse(self):
        self.assertEqual(glue_negative_values(['--bbox']), ['--bbox'])


class TileNameTest(unittest.TestCase):

    def test_northern_western_corner(self):
        self.assertEqual(tile_name(28, -16), 'Copernicus_DSM_COG_10_N28_00_W016_00_DEM')

    def test_southern_eastern_corner(self):
        self.assertEqual(tile_name(-1, 0), 'Copernicus_DSM_COG_10_S01_00_E000_00_DEM')

    def test_pads_to_archive_widths(self):
        # Two digits of latitude, three of longitude — an unpadded name is a 404.
        self.assertEqual(tile_name(5, 5), 'Copernicus_DSM_COG_10_N05_00_E005_00_DEM')


class TilesForBboxTest(unittest.TestCase):

    def test_covers_every_square_the_bbox_touches(self):
        names = tiles_for_bbox((6.0, 45.6, 8.0, 46.6))
        self.assertEqual(names, [
            'Copernicus_DSM_COG_10_N45_00_E006_00_DEM',
            'Copernicus_DSM_COG_10_N45_00_E007_00_DEM',
            'Copernicus_DSM_COG_10_N46_00_E006_00_DEM',
            'Copernicus_DSM_COG_10_N46_00_E007_00_DEM',
        ])

    def test_bbox_inside_one_square(self):
        self.assertEqual(
            tiles_for_bbox((7.6, 45.9, 7.8, 46.0)),
            ['Copernicus_DSM_COG_10_N45_00_E007_00_DEM'],
        )

    def test_negative_longitudes_floor_away_from_zero(self):
        # -15.5 sits in the square named W016, not W015.
        self.assertIn('Copernicus_DSM_COG_10_N28_00_W016_00_DEM',
                      tiles_for_bbox((-15.5, 28.2, -15.4, 28.3)))


class FabdemNamingTest(unittest.TestCase):

    def test_tile_name_matches_the_published_convention(self):
        # N44E007_FABDEM_V1-2.tif is the archive's own documented example.
        self.assertEqual(fabdem_tile_name(44, 7), 'N44E007_FABDEM_V1-2')

    def test_southern_western_tile(self):
        self.assertEqual(fabdem_tile_name(-25, -115), 'S25W115_FABDEM_V1-2')

    def test_block_is_the_enclosing_ten_degree_square(self):
        # Also a published example: N44E007 ships under N40E000-N50E010.
        self.assertEqual(fabdem_block_name(44, 7), 'N40E000-N50E010_FABDEM_V1-2')

    def test_block_floors_negative_coordinates_away_from_zero(self):
        self.assertEqual(fabdem_block_name(-25, -115), 'S30W120-S20W110_FABDEM_V1-2')

    def test_block_corner_exactly_on_a_ten_degree_line_belongs_to_the_square_above(self):
        self.assertEqual(fabdem_block_name(40, 0), 'N40E000-N50E010_FABDEM_V1-2')

    def test_url_nests_the_tile_under_its_block(self):
        url = fabdem_tile_url(44, 7)
        self.assertTrue(url.endswith(
            '/N40E000-N50E010_FABDEM_V1-2/N44E007_FABDEM_V1-2.tif'))
        self.assertTrue(url.startswith('https://'))


class MaxZoomTest(unittest.TestCase):

    def test_one_arcsec_matches_the_existing_pyramid(self):
        # The whole point of the 1 arcsec default: the Canaries pyramid was
        # baked to z12, and an imported area has to land on the same depth or
        # the merged pyramid is a patchwork.
        self.assertEqual(auto_max_zoom(ARCSEC_DEG, TILE_SIZE), 12)

    def test_coarser_source_bakes_shallower(self):
        self.assertLess(auto_max_zoom(3 * ARCSEC_DEG, TILE_SIZE), 12)


class SnapBboxTest(unittest.TestCase):

    Z = 12
    SPAN = 180.0 / (1 << 12)

    def test_snapped_box_contains_the_request(self):
        req = (7.6, 45.9, 7.8, 46.0)
        w, s, e, n = snap_bbox_to_tiles(req, self.Z)
        self.assertLessEqual(w, req[0])
        self.assertLessEqual(s, req[1])
        self.assertGreaterEqual(e, req[2])
        self.assertGreaterEqual(n, req[3])

    def test_edges_land_on_tile_boundaries(self):
        w, s, e, n = snap_bbox_to_tiles((7.6, 45.9, 7.8, 46.0), self.Z)
        for lon in (w, e):
            self.assertAlmostEqual((lon + 180.0) / self.SPAN,
                                   round((lon + 180.0) / self.SPAN), places=6)
        for lat in (s, n):
            self.assertAlmostEqual((90.0 - lat) / self.SPAN,
                                   round((90.0 - lat) / self.SPAN), places=6)

    def test_is_idempotent(self):
        once = snap_bbox_to_tiles((7.6, 45.9, 7.8, 46.0), self.Z)
        self.assertEqual(snap_bbox_to_tiles(once, self.Z), once)

    def test_adjacent_requests_share_a_whole_tile_column(self):
        # The bug this exists for: two areas meeting at 7.8 must both fully
        # own the tile column their shared edge runs through, or whichever
        # merges second writes fake sea over the other's ground.
        a = snap_bbox_to_tiles((7.6, 45.9, 7.8, 46.0), self.Z)
        b = snap_bbox_to_tiles((7.8, 45.9, 8.0, 46.0), self.Z)
        self.assertGreater(a[2], b[0], 'snapped neighbours must overlap, not abut')
        seam = (b[0] + 180.0) / self.SPAN
        self.assertAlmostEqual(seam, round(seam), places=6)

    def test_western_hemisphere(self):
        w, s, e, n = snap_bbox_to_tiles((-15.7, 27.9, -15.5, 28.1), self.Z)
        self.assertLessEqual(w, -15.7)
        self.assertGreaterEqual(e, -15.5)
        self.assertAlmostEqual((w + 180.0) / self.SPAN,
                               round((w + 180.0) / self.SPAN), places=6)

    def test_clamps_to_the_wgs84_domain(self):
        w, s, e, n = snap_bbox_to_tiles((-179.99, -89.99, -179.9, -89.9), self.Z)
        self.assertGreaterEqual(w, -180.0)
        self.assertGreaterEqual(s, -90.0)


class LatticeStepTest(unittest.TestCase):

    Z = 12
    SPAN = 180.0 / (1 << 12)

    def test_a_whole_number_of_steps_spans_a_tile(self):
        step = lattice_step(ARCSEC_DEG, self.Z)
        self.assertAlmostEqual(self.SPAN / step, round(self.SPAN / step), places=9)

    def test_stays_close_to_the_step_asked_for(self):
        step = lattice_step(ARCSEC_DEG, self.Z)
        self.assertLess(abs(step - ARCSEC_DEG) / ARCSEC_DEG, 0.01)

    def test_tile_snap_then_pixel_snap_is_a_no_op(self):
        # The regression this guards: with an incommensurate step the pixel
        # snap grew the box a sliver past the tile edge, the bake claimed the
        # next tile along, and filled it with sea.
        step = lattice_step(ARCSEC_DEG, self.Z)
        tiles = snap_bbox_to_tiles((7.6, 45.9, 7.8, 46.0), self.Z)
        pixels = snap_bbox_to_pixels(tiles, step)
        for a, b in zip(tiles, pixels):
            self.assertAlmostEqual(a, b, places=9)

    def test_holds_for_a_western_box_too(self):
        step = lattice_step(ARCSEC_DEG, self.Z)
        tiles = snap_bbox_to_tiles((-15.7, 27.9, -15.5, 28.1), self.Z)
        for a, b in zip(tiles, snap_bbox_to_pixels(tiles, step)):
            self.assertAlmostEqual(a, b, places=9)

    def test_still_bakes_to_the_same_zoom(self):
        self.assertEqual(auto_max_zoom(lattice_step(ARCSEC_DEG, 12), TILE_SIZE), 12)


class SnapPixelsTest(unittest.TestCase):

    def test_edges_land_on_the_global_lattice(self):
        w, s, e, n = snap_bbox_to_pixels((7.6, 45.9, 7.8, 46.0), ARCSEC_DEG)
        for lon in (w, e):
            self.assertAlmostEqual((lon + 180.0) / ARCSEC_DEG,
                                   round((lon + 180.0) / ARCSEC_DEG), places=4)
        for lat in (s, n):
            self.assertAlmostEqual((90.0 - lat) / ARCSEC_DEG,
                                   round((90.0 - lat) / ARCSEC_DEG), places=4)

    def test_only_grows_the_box(self):
        req = (7.6, 45.9, 7.8, 46.0)
        w, s, e, n = snap_bbox_to_pixels(req, ARCSEC_DEG)
        self.assertLessEqual(w, req[0])
        self.assertLessEqual(s, req[1])
        self.assertGreaterEqual(e, req[2])
        self.assertGreaterEqual(n, req[3])

    def test_is_idempotent(self):
        once = snap_bbox_to_pixels((7.6, 45.9, 7.8, 46.0), ARCSEC_DEG)
        twice = snap_bbox_to_pixels(once, ARCSEC_DEG)
        for a, b in zip(once, twice):
            self.assertAlmostEqual(a, b, places=9)

    def test_neighbouring_areas_share_pixel_centres(self):
        # The crack this exists for: sampling the same ground through two
        # differently-aligned lattices disagrees by metres on a steep slope,
        # so a shared tile edge stops matching its neighbour.
        a = snap_bbox_to_pixels(snap_bbox_to_tiles((7.6, 45.9, 7.8, 46.0), 12), ARCSEC_DEG)
        b = snap_bbox_to_pixels(snap_bbox_to_tiles((7.8, 45.9, 8.0, 46.0), 12), ARCSEC_DEG)
        offset = (b[0] - a[0]) / ARCSEC_DEG
        self.assertAlmostEqual(offset, round(offset), places=4,
                               msg='neighbour origins must differ by whole pixels')


class TargetGridTest(unittest.TestCase):

    def test_grid_uses_exactly_the_step_asked_for(self):
        bounds = snap_bbox_to_pixels((7.6, 45.9, 7.8, 46.0), ARCSEC_DEG)
        transform, width, height = target_grid(bounds, ARCSEC_DEG)
        self.assertAlmostEqual(transform.a, ARCSEC_DEG, places=12)
        self.assertAlmostEqual(-transform.e, ARCSEC_DEG, places=12)
        # North-up: origin is the north-west corner and rows run south.
        self.assertAlmostEqual(transform.c, bounds[0])
        self.assertAlmostEqual(transform.f, bounds[3])
        self.assertLess(transform.e, 0)

    def test_grid_covers_the_snapped_bounds(self):
        bounds = snap_bbox_to_pixels((7.6, 45.9, 7.8, 46.0), ARCSEC_DEG)
        _, width, height = target_grid(bounds, ARCSEC_DEG)
        self.assertAlmostEqual(width * ARCSEC_DEG, bounds[2] - bounds[0], places=9)
        self.assertAlmostEqual(height * ARCSEC_DEG, bounds[3] - bounds[1], places=9)


class SquareWindowsTest(unittest.TestCase):
    """A 1 degree, 3600 px square against a target grid at the same step."""

    STEP = ARCSEC_DEG
    SQUARE = from_origin(-17.0, 33.0, ARCSEC_DEG, ARCSEC_DEG)

    def test_square_fully_inside_the_grid_reads_everything(self):
        grid = from_origin(-18.0, 34.0, self.STEP, self.STEP)
        src, dst = square_windows(self.SQUARE, 3600, 3600, grid, 7200, 7200)
        # Padding cannot leave the raster, so the whole square is the window.
        self.assertEqual((src.col_off, src.row_off, src.width, src.height), (0, 0, 3600, 3600))
        # The square sits one degree in from the grid's west and north edges;
        # the target window is its footprint rounded outwards, and an edge
        # landing on a pixel boundary may round either way by one.
        self._assert_around(dst, 3600, 3600, 3600, 3600, DST_PAD_PX)

    def _assert_around(self, win, col0, row0, width, height, pad):
        self.assertLessEqual(win.col_off, col0)
        self.assertGreaterEqual(win.col_off, col0 - pad - 1)
        self.assertLessEqual(win.row_off, row0)
        self.assertGreaterEqual(win.row_off, row0 - pad - 1)
        self.assertGreaterEqual(win.col_off + win.width, col0 + width)
        self.assertLessEqual(win.col_off + win.width, col0 + width + pad + 1)
        self.assertGreaterEqual(win.row_off + win.height, row0 + height)
        self.assertLessEqual(win.row_off + win.height, row0 + height + pad + 1)

    def test_bbox_clipping_a_sliver_reads_only_the_sliver(self):
        # A grid covering just the square's south-east 100x100 px corner.
        grid = from_origin(-16.0 - 100 * self.STEP, 32.0 + 100 * self.STEP, self.STEP, self.STEP)
        src, dst = square_windows(self.SQUARE, 3600, 3600, grid, 100, 100)
        # The grid is the corner, so the target window is clipped to all of it.
        self.assertEqual((dst.col_off, dst.row_off, dst.width, dst.height), (0, 0, 100, 100))
        # The sliver, plus the padding bilinear needs, clipped at the raster's
        # own east and south edges.
        self._assert_around(src, 3500, 3500, 100, 100, SRC_PAD_PX)
        self.assertEqual(src.col_off + src.width, 3600)
        self.assertEqual(src.row_off + src.height, 3600)
        self.assertLess(src.width * src.height, 0.01 * 3600 * 3600)

    def test_source_window_covers_every_target_pixel_with_margin(self):
        # Whatever the alignment, every target pixel centre in the target
        # window must map strictly inside the source window with room for
        # its bilinear neighbours - or the windowed read would differ from a
        # whole-square read at the seam.
        grid = from_origin(-17.3 + 0.37 * self.STEP, 33.4 - 0.61 * self.STEP,
                           self.STEP * 1.0013, self.STEP * 1.0013)
        src, dst = square_windows(self.SQUARE, 3600, 3600, grid, 2000, 2000)
        for col in (dst.col_off, dst.col_off + dst.width - 1):
            x = grid.c + (col + 0.5) * grid.a
            sx = (x - self.SQUARE.c) / self.SQUARE.a
            if 0 <= sx < 3600:
                self.assertGreaterEqual(sx - 1.0, src.col_off)
                self.assertLessEqual(sx + 1.0, src.col_off + src.width)
        for row in (dst.row_off, dst.row_off + dst.height - 1):
            y = grid.f + (row + 0.5) * grid.e
            sy = (y - self.SQUARE.f) / self.SQUARE.e
            if 0 <= sy < 3600:
                self.assertGreaterEqual(sy - 1.0, src.row_off)
                self.assertLessEqual(sy + 1.0, src.row_off + src.height)

    def test_square_outside_the_grid_is_none(self):
        grid = from_origin(10.0, 50.0, self.STEP, self.STEP)
        self.assertIsNone(square_windows(self.SQUARE, 3600, 3600, grid, 100, 100))

    def test_decimated_read_aligns_to_whole_cells(self):
        # At 3 arcsec every read cell is 3 source pixels; a window starting
        # mid-cell would sample different cells from a whole-square read.
        grid = from_origin(-16.5, 32.5, 3 * self.STEP, 3 * self.STEP)
        src, _ = square_windows(self.SQUARE, 3600, 3600, grid, 300, 300, factor=3)
        self.assertEqual(src.col_off % 3, 0)
        self.assertEqual(src.row_off % 3, 0)
        self.assertEqual(src.width % 3, 0)
        self.assertEqual(src.height % 3, 0)

    def test_decimation_drops_the_trailing_partial_cell(self):
        # 3600 // 7 cells of 7 px reach only to 3598, as `width // factor`
        # would have; the window must not read past that.
        grid = from_origin(-16.02, 32.02, 7 * self.STEP, 7 * self.STEP)
        src, _ = square_windows(self.SQUARE, 3600, 3600, grid, 20, 20, factor=7)
        self.assertLessEqual(src.col_off + src.width, (3600 // 7) * 7)
        self.assertLessEqual(src.row_off + src.height, (3600 // 7) * 7)


class CachePathTest(unittest.TestCase):

    def test_strips_the_vsicurl_prefix(self):
        self.assertEqual(http_url('/vsicurl/https://x/y/N44E007_FABDEM_V1-2.tif'),
                         'https://x/y/N44E007_FABDEM_V1-2.tif')

    def test_leaves_a_local_path_alone(self):
        self.assertEqual(http_url('data/imports/.dem-cache/a.tif'), 'data/imports/.dem-cache/a.tif')

    def test_cache_file_is_named_by_the_square(self):
        path = cache_path('/vsicurl/' + fabdem_tile_url(44, 7), cache_dir='cache')
        self.assertEqual(path, os.path.join('cache', 'N44E007_FABDEM_V1-2.tif'))

    def test_the_two_archives_cannot_collide(self):
        cop = cache_path('/vsicurl/https://x/' + tile_name(44, 7) + '.tif', 'c')
        fab = cache_path('/vsicurl/' + fabdem_tile_url(44, 7), 'c')
        self.assertNotEqual(cop, fab)


class _FakeResponse:

    def __init__(self, chunks, content_length=None, status=200):
        self._chunks = chunks
        self.headers = {} if content_length is None else {'Content-Length': str(content_length)}
        self.status = status

    def raise_for_status(self):
        if self.status != 200:
            raise IOError(f'HTTP {self.status}')

    def iter_content(self, chunk_size):
        yield from self._chunks

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class EnsureCachedTest(unittest.TestCase):

    URL = '/vsicurl/https://example.test/tiles/N44E007_FABDEM_V1-2.tif'

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = os.path.join(self.tmp.name, 'cache')

    def tearDown(self):
        self.tmp.cleanup()

    def test_downloads_once_and_reads_from_disk_after(self):
        with mock.patch.object(fetch_planet_dem.requests, 'get',
                               return_value=_FakeResponse([b'abc', b'def'], 6)) as get:
            first = ensure_cached(self.URL, self.cache)
            second = ensure_cached(self.URL, self.cache)
        self.assertEqual(first, second)
        self.assertEqual(get.call_count, 1)
        self.assertEqual(get.call_args.args[0], 'https://example.test/tiles/N44E007_FABDEM_V1-2.tif')
        with open(first, 'rb') as fh:
            self.assertEqual(fh.read(), b'abcdef')
        self.assertEqual(os.listdir(self.cache), ['N44E007_FABDEM_V1-2.tif'],
                         'no temp file may be left beside the square')

    def test_a_short_download_leaves_nothing_behind(self):
        # A run killed mid-download, or a proxy cutting the body: the next run
        # must see no square at all rather than a truncated one it trusts.
        with mock.patch.object(fetch_planet_dem.requests, 'get',
                               return_value=_FakeResponse([b'abc'], 6)):
            with self.assertRaises(IOError):
                ensure_cached(self.URL, self.cache)
        self.assertEqual(os.listdir(self.cache), [])

    def test_a_404_is_raised_and_not_cached(self):
        with mock.patch.object(fetch_planet_dem.requests, 'get',
                               return_value=_FakeResponse([], status=404)):
            with self.assertRaises(IOError):
                ensure_cached(self.URL, self.cache)
        self.assertEqual(os.listdir(self.cache), [])


class MosaicIntoTest(unittest.TestCase):
    """The merge is fed by a fake fetcher, so it is only the compositing on
    trial: order of precedence, skipping, and the window bookkeeping."""

    def _fetch(self, blocks):
        # blocks: name -> (window, array | None, err | None)
        def fetch(url, dst_transform, dst_shape, step_deg, cache_dir):
            win, block, err = blocks[url]
            return url, win, block, err
        return fetch

    def test_first_square_wins_where_two_overlap(self):
        out = np.full((4, 4), NODATA, dtype=np.float32)
        a = np.full((2, 4), 1.0, dtype=np.float32)
        b = np.full((3, 4), 2.0, dtype=np.float32)
        used = mosaic_into(out, None, ['a', 'b'], ARCSEC_DEG, jobs=8, cache_dir=None, fetch=self._fetch({
            'a': (Window(0, 0, 4, 2), a, None),
            'b': (Window(0, 1, 4, 3), b, None),
        }))
        self.assertEqual(used, 2)
        np.testing.assert_array_equal(out[0], 1.0)
        np.testing.assert_array_equal(out[1], 1.0)
        np.testing.assert_array_equal(out[2], 2.0)
        np.testing.assert_array_equal(out[3], 2.0)

    def test_order_is_the_callers_not_the_pools(self):
        # Squares that finish out of order must merge in the order given: the
        # output of a run cannot depend on which fetch the network answered
        # first. The fetcher here stalls the first square so the second is
        # certain to complete first.
        import threading
        import time as _time
        out = np.full((2, 2), NODATA, dtype=np.float32)
        started = threading.Event()

        def fetch(url, dst_transform, dst_shape, step_deg, cache_dir):
            if url == 'slow':
                started.wait(1.0)
                _time.sleep(0.05)
                return url, Window(0, 0, 2, 2), np.full((2, 2), 1.0, np.float32), None
            started.set()
            return url, Window(0, 0, 2, 2), np.full((2, 2), 2.0, np.float32), None

        mosaic_into(out, None, ['slow', 'fast'], ARCSEC_DEG, jobs=2, cache_dir=None, fetch=fetch)
        np.testing.assert_array_equal(out, 1.0)

    def test_nodata_in_a_block_does_not_overwrite(self):
        out = np.full((2, 2), NODATA, dtype=np.float32)
        a = np.array([[5.0, NODATA], [NODATA, NODATA]], dtype=np.float32)
        b = np.full((2, 2), 7.0, dtype=np.float32)
        mosaic_into(out, None, ['a', 'b'], ARCSEC_DEG, cache_dir=None, fetch=self._fetch({
            'a': (Window(0, 0, 2, 2), a, None),
            'b': (Window(0, 0, 2, 2), b, None),
        }))
        np.testing.assert_array_equal(out, [[5.0, 7.0], [7.0, 7.0]])

    def test_failed_and_empty_squares_are_skipped(self):
        out = np.full((2, 2), NODATA, dtype=np.float32)
        used = mosaic_into(out, None, ['missing', 'void', 'off', 'ok'], ARCSEC_DEG, cache_dir=None,
                           fetch=self._fetch({
                               'missing': (None, None, 'HTTP response code: 404'),
                               'void': (Window(0, 0, 2, 2), np.full((2, 2), NODATA, np.float32), None),
                               'off': (None, None, None),
                               'ok': (Window(1, 1, 1, 1), np.full((1, 1), 3.0, np.float32), None),
                           }))
        self.assertEqual(used, 1)
        np.testing.assert_array_equal(out, [[NODATA, NODATA], [NODATA, 3.0]])

    def test_block_lands_at_its_window(self):
        out = np.full((5, 6), NODATA, dtype=np.float32)
        mosaic_into(out, None, ['a'], ARCSEC_DEG, cache_dir=None, fetch=self._fetch({
            'a': (Window(2, 1, 3, 2), np.full((2, 3), 9.0, np.float32), None),
        }))
        filled = out != NODATA
        self.assertEqual(int(filled.sum()), 6)
        self.assertTrue(filled[1:3, 2:5].all())

    def test_no_sources_is_zero(self):
        out = np.full((2, 2), NODATA, dtype=np.float32)
        self.assertEqual(mosaic_into(out, None, [], ARCSEC_DEG, cache_dir=None, fetch=self._fetch({})), 0)


if __name__ == '__main__':
    unittest.main()

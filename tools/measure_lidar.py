#!/usr/bin/env python3
"""Measure the graded lines and the bridge ends against open lidar terrain models.

The road and rail grading (railBed.ts, run in the bake by
tools/bake_planet_grade.ts) invents every embankment and cutting from the 30 m
land, which sees none of them; a 1-2 m lidar terrain model records them. This
stage reads the lidar along every line the beds grade and beyond every bridge
end, and keeps only the answers - no raster is stored - in the lidar store
(tools/bake/lidarStore.ts, LMS1, data/imports/lidar/store/12/x/y.lms):

  lines    every STEP_M along each graded-class line of the leaf's .rvr
           (STREET_STEP_M for streets): the crown, the median height across
           the carriageway, and the side, the median ground SIDE_FROM_M to
           SIDE_TO_M out on each side, the mean of the two; stored as crown
           and lift = crown - side.
  bridges  per .rbr span end: the median lift of the approach APPROACH_FROM_M
           to APPROACH_TO_M beyond it, along the span. The terrain model fills
           in under a short span, so the approach is read beyond the end.

It reads the planet pyramid's OSM vectors (.rvr, .rbr), not the meshes, so it
runs once per area and a re-mesh or re-grade keeps it; a re-baked .rvr or .rbr
changes its signature and its leaf is measured again on the next run.

Sources are tried in SOURCES order per station (one station's 27 reads come
from one source); a source with no data there (outside its territory, a 404)
passes to the next. Heights stay in each source's own datum: the bake takes
the difference to the land per tile and source.

Usage::

    python tools/measure_lidar.py --bbox 11.03,47.46,11.17,47.60 [--jobs 6]
    python tools/measure_lidar.py --leaf 4348,966 --force
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import math
import os
import shutil
import struct
import sys
import time
import urllib.error
import urllib.request
import zipfile
import zlib
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_osm_roads import decode_rvr  # noqa: E402
from osm_bridges import decode_rbr  # noqa: E402

LEAF_ZOOM = 12
PLANET_DIR = 'assets/planet'
STORE_DIR = 'data/imports/lidar/store'
CACHE_DIR = 'data/imports/lidar/.cache'
USER_AGENT = 'retroflightsim-terrain-bake (lidar corridor sampler)'

# Keep in step with tools/bake/lidarStore.ts.
LMS_MAGIC = b'LMS1'
LMS_VERSION = 1
LMS_DEG = 1e-7
CROWN_OFFSET_M = -200.0
NO_LIFT = -32768
STEP_M = 5.0
STREET_STEP_M = 10.0

# Keep in step with railBed.ts bedTierOf and ptr.ts RoadClass.
RAIL, RAIL_SERVICE = 7, 8
STREET_TIER = 3


def bed_tier(cls: int) -> int:
    if cls in (RAIL, RAIL_SERVICE):
        return 0
    if cls == 0:
        return 1
    if cls in (1, 2):
        return 2
    if cls in (3, 4, 5, 6):
        return STREET_TIER
    return -1


# The reads, as tools/bake/lidarGrid.ts had them for the prototype.
CROWN_MIN_HALF_M = 2.0
CROWN_FRACTIONS = (-1.0, -0.5, 0.0, 0.5, 1.0)
SIDE_FROM_M, SIDE_TO_M, SIDE_STEP_M = 20.0, 40.0, 2.0
SIDE_OFFSETS = np.arange(SIDE_FROM_M, SIDE_TO_M + 1e-9, SIDE_STEP_M)
APPROACH_STATIONS_M = (2.0, 4.0, 6.0, 8.0, 10.0, 12.0)
# A span's direction is taken from its first node this far from the end (OSM
# often has two a few centimetres apart there).
APPROACH_DIR_MIN_M = 2.0

M_PER_DEG_LAT = 111132.92


def m_per_deg_lon(lat: float) -> float:
    return 111412.84 * math.cos(math.radians(lat))


def tile_bounds(z: int, x: int, y: int) -> Tuple[float, float, float, float]:
    span = 180.0 / (1 << z)
    west = -180.0 + x * span
    north = 90.0 - y * span
    return west, north - span, west + span, north


def crc32_file(path: str) -> int:
    if not os.path.exists(path):
        return 0
    with open(path, 'rb') as fh:
        return zlib.crc32(fh.read()) & 0xFFFFFFFF


# --- sources -----------------------------------------------------------------

def http_get(url: str, timeout: float = 120.0, tries: int = 4) -> Optional[bytes]:
    """The body; None for a client error (no such tile, a coverage asked
    outside its extent); retries throttling, server errors and timeouts with
    backoff."""
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as ex:
            if 400 <= ex.code < 500 and ex.code not in (408, 429):
                return None
            if attempt == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == tries - 1:
                raise
        time.sleep(2 * (attempt + 1))
    return None


def bilinear(arr: np.ndarray, x0: float, y0: float, dx: float, dy: float,
             xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Heights at (xs, ys) from a north-up grid whose top-left corner is (x0, y0)
    and pixel size (dx, dy < 0); NaN where a corner is missing. Clamped at the
    edge: a point in the outer half pixel takes the edge row or column."""
    h, w = arr.shape
    col = (xs - x0) / dx - 0.5
    row = (ys - y0) / dy - 0.5
    out = np.full(xs.shape, np.nan)
    inside = (col > -1) & (col < w) & (row > -1) & (row < h)
    if not inside.any():
        return out
    c = np.clip(np.floor(col[inside]).astype(np.int64), 0, max(0, w - 2))
    r = np.clip(np.floor(row[inside]).astype(np.int64), 0, max(0, h - 2))
    fx = np.clip(col[inside] - c, 0.0, 1.0)
    fy = np.clip(row[inside] - r, 0.0, 1.0)
    c1 = np.minimum(c + 1, w - 1)
    r1 = np.minimum(r + 1, h - 1)
    a, b, d, e = arr[r, c], arr[r, c1], arr[r1, c], arr[r1, c1]
    out[inside] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + d * (1 - fx) * fy + e * fx * fy
    return out


def to_crs(crs: str, lons: np.ndarray, lats: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    from rasterio.warp import transform
    xs, ys = transform('EPSG:4326', crs, lons.tolist(), lats.tolist())
    return np.asarray(xs), np.asarray(ys)


def read_raster(data: bytes) -> Tuple[np.ndarray, Tuple[float, float, float, float]]:
    """A GeoTIFF (or a zip holding one, or holding XYZ text) as a float grid
    with NaN for nodata, and (x0, y0, dx, dy) of its top-left corner."""
    if data[:2] == b'PK':
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            names = zf.namelist()
            tif = [n for n in names if n.lower().endswith(('.tif', '.tiff'))]
            if tif:
                return read_raster(zf.read(tif[0]))
            xyz = [n for n in names if n.lower().endswith(('.xyz', '.txt', '.asc'))]
            if xyz:
                return read_xyz(zf.read(xyz[0]))
            raise ValueError(f'no raster in zip: {names[:5]}')
    if data[:4] in (b'II*\x00', b'MM\x00*', b'II+\x00', b'MM\x00+'):
        from rasterio.io import MemoryFile
        with MemoryFile(data) as mf, mf.open() as ds:
            arr = ds.read(1).astype(np.float64)
            if ds.nodata is not None:
                arr[arr == ds.nodata] = np.nan
            arr[arr < -1000] = np.nan
            t = ds.transform
            return arr, (t.c, t.f, t.a, t.e)
    return read_xyz(data)


def read_xyz(data: bytes) -> Tuple[np.ndarray, Tuple[float, float, float, float]]:
    """XYZ text (x y z per line, cell centres on a regular grid) as a grid."""
    vals = np.array(data.replace(b',', b' ').replace(b';', b' ').split(), dtype=np.float64)
    pts = vals[: len(vals) // 3 * 3].reshape(-1, 3)
    xs, ys = np.unique(pts[:, 0]), np.unique(pts[:, 1])
    dx = float(np.min(np.diff(xs))) if len(xs) > 1 else 1.0
    dy = float(np.min(np.diff(ys))) if len(ys) > 1 else 1.0
    w = int(round((xs[-1] - xs[0]) / dx)) + 1
    h = int(round((ys[-1] - ys[0]) / dy)) + 1
    arr = np.full((h, w), np.nan)
    c = np.round((pts[:, 0] - xs[0]) / dx).astype(np.int64)
    r = np.round((ys[-1] - pts[:, 1]) / dy).astype(np.int64)
    arr[r, c] = pts[:, 2]
    arr[arr < -1000] = np.nan
    return arr, (xs[0] - dx / 2, ys[-1] + dy / 2, dx, -dy)


class Source:
    """One lidar terrain model: where it may have data, its CRS, its reads."""
    id = 0
    name = ''
    bbox = (0.0, 0.0, 0.0, 0.0)   # lon/lat w, s, e, n it may cover
    crs = ''

    def __init__(self, stats: dict):
        self.stats = stats

    def covers(self, lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
        w, s, e, n = self.bbox
        return (lons >= w) & (lons <= e) & (lats >= s) & (lats <= n)

    def intersects(self, box: Sequence[float]) -> bool:
        w, s, e, n = self.bbox
        return not (box[2] < w or box[0] > e or box[3] < s or box[1] > n)

    def prepare(self, box: Sequence[float]) -> None:
        """Called once per leaf before its reads (lon/lat w, s, e, n)."""

    def heights(self, lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
        xs, ys = to_crs(self.crs, lons, lats)
        return self.heights_xy(xs, ys)

    def heights_xy(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        raise NotImplementedError


class TiledSource(Source):
    """A source served as square files `tile_m` on a side in its CRS, fetched
    whole into a disk cache (bounded, oldest out) and a few kept in memory."""
    tile_m = 1000.0
    # Decoded tiles kept per worker, bytes: a 2 km tile is four 1 km ones, and
    # eight workers each holding two dozen of them pushed the page file over
    # the disk's last gigabytes.
    keep_bytes = 160e6
    cache_ext = '.bin'

    def __init__(self, stats: dict):
        super().__init__(stats)
        self.mem: 'OrderedDict[Tuple[int, int], Optional[Tuple[np.ndarray, tuple]]]' = OrderedDict()
        self.mem_bytes = 0
        self.dir = os.path.join(CACHE_DIR, self.name)

    def url(self, ix: int, iy: int) -> Optional[str]:
        raise NotImplementedError

    def cache_name(self, ix: int, iy: int) -> str:
        return f'{ix}_{iy}'

    def load(self, ix: int, iy: int) -> Optional[Tuple[np.ndarray, tuple]]:
        key = (ix, iy)
        if key in self.mem:
            self.mem.move_to_end(key)
            return self.mem[key]
        base = os.path.join(self.dir, self.cache_name(ix, iy))
        data: Optional[bytes] = None
        if os.path.exists(base + '.none'):
            grid = None
        else:
            if os.path.exists(base + self.cache_ext):
                with open(base + self.cache_ext, 'rb') as fh:
                    data = fh.read()
                os.utime(base + self.cache_ext)
                self.stats['cacheHits'] += 1
            else:
                url = self.url(ix, iy)
                data = http_get(url) if url else None
                if data is not None and data.lstrip()[:1] == b'<':
                    data = None     # an exception report or a portal page, not heights
                os.makedirs(self.dir, exist_ok=True)
                if data is None:
                    open(base + '.none', 'wb').close()
                else:
                    self.stats['downloadedMB'] += len(data) / 1e6
                    self.stats['downloads'] += 1
                    tmp = f'{base}.{os.getpid()}.part'
                    with open(tmp, 'wb') as fh:
                        fh.write(data)
                    try:
                        os.replace(tmp, base + self.cache_ext)
                    except OSError:
                        os.remove(tmp)
            grid = read_raster(data) if data is not None else None
            if grid is not None:
                grid = (grid[0].astype(np.float32), grid[1])
        self.mem[key] = grid
        self.mem_bytes += grid[0].nbytes if grid is not None else 0
        while self.mem_bytes > self.keep_bytes and len(self.mem) > 1:
            _k, old = self.mem.popitem(last=False)
            self.mem_bytes -= old[0].nbytes if old is not None else 0
        return grid

    def heights_xy(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        out = np.full(xs.shape, np.nan)
        ix = np.floor(xs / self.tile_m).astype(np.int64)
        iy = np.floor(ys / self.tile_m).astype(np.int64)
        keys = ix * 1_000_000 + iy
        for key in np.unique(keys):
            sel = keys == key
            grid = self.load(int(ix[sel][0]), int(iy[sel][0]))
            if grid is None:
                continue
            arr, (x0, y0, dx, dy) = grid
            out[sel] = bilinear(arr, x0, y0, dx, dy, xs[sel], ys[sel])
        return out


class Bavaria(TiledSource):
    """Bayerische Vermessungsverwaltung DGM1 (CC BY 4.0): 1 km GeoTIFFs named by
    their south-west corner in km, EPSG:25832, DHHN2016 heights."""
    id = 1
    name = 'bavaria'
    bbox = (8.95, 47.25, 13.86, 50.58)
    crs = 'EPSG:25832'
    cache_ext = '.tif'

    def url(self, ix: int, iy: int) -> Optional[str]:
        return f'https://download1.bayernwolke.de/a/dgm/dgm1/{ix}_{iy}.tif'


class Austria(Source):
    """BEV ALS DTM 1 m (CC BY 4.0), 2025 release: 55 cloud-optimised GeoTIFFs of
    50 km in EPSG:3035, EVRF2000-Austria heights. Read in windows from the first
    overview (2 m), one 512-pixel block at a time, over HTTP ranges."""
    id = 2
    name = 'austria'
    bbox = (9.4, 46.3, 17.2, 49.1)
    crs = 'EPSG:3035'
    url_template = ('/vsicurl/https://data.bev.gv.at/download/ALS/DTM/20250915/'
                    'ALS_DTM_CRS3035RES50000mN{n}E{e}.tif')
    overview = 0
    keep_blocks = 96

    def __init__(self, stats: dict):
        super().__init__(stats)
        self.datasets: Dict[Tuple[int, int], object] = {}
        self.blocks: 'OrderedDict[tuple, Optional[Tuple[np.ndarray, tuple]]]' = OrderedDict()

    def dataset(self, e: int, n: int):
        key = (e, n)
        if key not in self.datasets:
            import rasterio
            try:
                self.datasets[key] = rasterio.open(self.url_template.format(n=n, e=e), overview_level=self.overview)
            except rasterio.errors.RasterioIOError:
                self.datasets[key] = None
        return self.datasets[key]

    def block(self, ds_key: Tuple[int, int], bx: int, by: int):
        key = (ds_key, bx, by)
        if key in self.blocks:
            self.blocks.move_to_end(key)
            return self.blocks[key]
        from rasterio.windows import Window
        ds = self.dataset(*ds_key)
        grid = None
        if ds is not None:
            bw, bh = ds.block_shapes[0][1], ds.block_shapes[0][0]
            c0, r0 = max(0, bx * bw - 1), max(0, by * bh - 1)
            c1, r1 = min(ds.width, (bx + 1) * bw + 1), min(ds.height, (by + 1) * bh + 1)
            if c1 > c0 and r1 > r0:
                arr = ds.read(1, window=Window(c0, r0, c1 - c0, r1 - r0)).astype(np.float32)
                self.stats['blocks'] += 1
                if ds.nodata is not None:
                    arr[arr == ds.nodata] = np.nan
                arr[arr < -1000] = np.nan
                t = ds.transform
                grid = (arr, (t.c + c0 * t.a, t.f + r0 * t.e, t.a, t.e))
        self.blocks[key] = grid
        if len(self.blocks) > self.keep_blocks:
            self.blocks.popitem(last=False)
        return grid

    def heights_xy(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        out = np.full(xs.shape, np.nan)
        e = (np.floor((xs + 0.5) / 50000) * 50000).astype(np.int64)
        n = (np.floor((ys - 0.5) / 50000) * 50000).astype(np.int64)
        for de, dn in set(zip(e.tolist(), n.tolist())):
            sel_ds = (e == de) & (n == dn)
            ds = self.dataset(de, dn)
            if ds is None:
                continue
            t = ds.transform
            bw, bh = ds.block_shapes[0][1], ds.block_shapes[0][0]
            col = (xs[sel_ds] - t.c) / t.a
            row = (ys[sel_ds] - t.f) / t.e
            bx = np.floor(col / bw).astype(np.int64)
            by = np.floor(row / bh).astype(np.int64)
            idx = np.nonzero(sel_ds)[0]
            for kx, ky in set(zip(bx.tolist(), by.tolist())):
                sel = (bx == kx) & (by == ky)
                grid = self.block((de, dn), kx, ky)
                if grid is None:
                    continue
                arr, (x0, y0, dx, dy) = grid
                out[idx[sel]] = bilinear(arr, x0, y0, dx, dy, xs[idx[sel]], ys[idx[sel]])
        return out


class Wcs(TiledSource):
    """A state served by an OGC WCS 2.0 that cuts any box: one GetCoverage per
    1 km block a line touches, at half resolution (2 m, SCALEFACTOR) where the
    model is 1 m - a quarter of the bytes, and an embankment is still several
    pixels across."""
    base = ''
    coverage = ''
    axes = ('x', 'y')
    scale: Optional[float] = 0.5

    def url(self, ix: int, iy: int) -> Optional[str]:
        x0, y0 = ix * self.tile_m, iy * self.tile_m
        ax, ay = self.axes
        u = (f'{self.base}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID={self.coverage}'
             f'&FORMAT=image/tiff&SUBSET={ax}({x0:.0f},{x0 + self.tile_m:.0f})&SUBSET={ay}({y0:.0f},{y0 + self.tile_m:.0f})')
        return u + (f'&SCALEFACTOR={self.scale}' if self.scale else '')


class StacTiles(TiledSource):
    """1 km cloud-optimised GeoTIFFs found through a STAC API, fetched whole: the
    newest year of each tile. `parse(item id)` gives (E km, N km, year)."""
    stac = ''

    def __init__(self, stats: dict):
        super().__init__(stats)
        self.urls: Dict[Tuple[int, int], Tuple[int, str]] = {}
        self.searched: set = set()

    def parse(self, item_id: str) -> Tuple[int, int, int]:
        raise NotImplementedError

    def asset(self, assets: dict) -> Optional[str]:
        raise NotImplementedError

    def prepare(self, box: Sequence[float]) -> None:
        key = tuple(round(v, 4) for v in box)
        if key in self.searched:
            return
        self.searched.add(key)
        url: Optional[str] = f'{self.stac}?bbox={box[0]},{box[1]},{box[2]},{box[3]}&limit=100'
        while url:
            body = http_get(url)
            if body is None:
                return
            page = json.loads(body)
            for f in page.get('features', []):
                try:
                    e, n, year = self.parse(f['id'])
                except (IndexError, ValueError):
                    continue
                href = self.asset(f.get('assets', {}))
                if href and self.urls.get((e, n), (0, ''))[0] < year:
                    self.urls[(e, n)] = (year, href)
            url = next((l['href'] for l in page.get('links', []) if l.get('rel') == 'next'), None)

    def url(self, ix: int, iy: int) -> Optional[str]:
        hit = self.urls.get((ix, iy))
        return hit[1] if hit else None

    def cache_name(self, ix: int, iy: int) -> str:
        hit = self.urls.get((ix, iy))
        return f'{ix}_{iy}_{hit[0] if hit else 0}'


class Switzerland(StacTiles):
    """swisstopo swissALTI3D (OGD, "(c) Data: swisstopo"), 2 m: 1 km cloud-optimised
    GeoTIFFs in EPSG:2056, LN02 heights, through the STAC API."""
    id = 3
    name = 'switzerland'
    bbox = (5.9, 45.8, 10.55, 47.85)
    crs = 'EPSG:2056'
    stac = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swissalti3d/items'

    def parse(self, item_id: str) -> Tuple[int, int, int]:
        p = item_id.split('_')        # swissalti3d_{year}_{E}-{N}
        e, n = p[2].split('-')
        return int(e), int(n), int(p[1])

    def asset(self, assets: dict) -> Optional[str]:
        return next((a['href'] for k, a in assets.items() if k.endswith('_2_2056_5728.tif')), None)


class Niedersachsen(StacTiles):
    """LGLN DGM1 (CC BY 4.0): 1 km cloud-optimised GeoTIFFs in EPSG:25832 through
    its STAC API. Its WCS answers too, but about 9 s a block."""
    id = 4
    name = 'niedersachsen'
    bbox = (6.6, 51.29, 11.7, 53.95)
    crs = 'EPSG:25832'
    stac = 'https://dgm.stac.lgln.niedersachsen.de/collections/dgm1/items'

    def parse(self, item_id: str) -> Tuple[int, int, int]:
        p = item_id.split('_')        # dgm1_32_{E}_{N}_1_ni_{year}
        return int(p[2]), int(p[3]), int(p[-1])

    def asset(self, assets: dict) -> Optional[str]:
        return assets.get('dgm1-tif', {}).get('href')


class BadenWuerttemberg(Wcs):
    """LGL DGM1 (dl-de/by-2-0) through its open WCS, EPSG:25832."""
    id = 5
    name = 'baden-wuerttemberg'
    bbox = (7.5, 47.5, 10.5, 49.8)
    crs = 'EPSG:25832'
    base = 'https://owsproxy.lgl-bw.de/owsproxy/wcs/WCS_INSP_BW_Hoehe_Coverage_DGM1'
    coverage = 'EL.ElevationGridCoverage'
    axes = ('E', 'N')


class BrandenburgBerlin(Wcs):
    """LGB DGM1 (dl-de/by-2-0) through its WCS, EPSG:25833; covers Berlin too
    (attribution: Geoportal Berlin)."""
    id = 6
    name = 'brandenburg-berlin'
    bbox = (11.2, 51.35, 14.8, 53.6)
    crs = 'EPSG:25833'
    base = 'https://isk.geobasis-bb.de/ows/dgm_wcs'
    coverage = 'bb_dgm'


class Hessen(Wcs):
    """HVBG DGM1 (dl-de/zero-2-0, automated retrieval allowed) through its WCS, EPSG:25832."""
    id = 7
    name = 'hessen'
    bbox = (7.7, 49.38, 10.3, 51.66)
    crs = 'EPSG:25832'
    base = 'https://inspire-hessen.de/raster/dgm1/ows'
    coverage = 'he_dgm1'
    axes = ('E', 'N')


class Nrw(Wcs):
    """Geobasis NRW DGM1 (dl-de/zero-2-0) through its WCS, EPSG:25832."""
    id = 8
    name = 'nrw'
    bbox = (5.85, 50.32, 9.47, 52.54)
    crs = 'EPSG:25832'
    base = 'https://www.wcs.nrw.de/geobasis/wcs_nw_dgm'
    coverage = 'nw_dgm'


class RheinlandPfalz(TiledSource):
    """LVermGeo RLP DGM1 (dl-de/by-2-0): 1 km GeoTIFFs named with their survey
    year, which the folder listing (9 MB, kept a month) gives per tile."""
    id = 10
    name = 'rheinland-pfalz'
    bbox = (6.1, 48.96, 8.51, 50.95)
    crs = 'EPSG:25832'
    folder = 'https://geobasis-rlp.de/data/dgm1/current/tif/'

    def __init__(self, stats: dict):
        super().__init__(stats)
        self.years: Optional[Dict[Tuple[int, int], str]] = None

    def year(self, ix: int, iy: int) -> Optional[str]:
        if self.years is None:
            import re
            path = os.path.join(self.dir, 'listing.json')
            if os.path.exists(path) and time.time() - os.path.getmtime(path) < 30 * 86400:
                with open(path, encoding='utf-8') as fh:
                    self.years = {tuple(int(v) for v in k.split('_')): y for k, y in json.load(fh).items()}
            else:
                body = http_get(self.folder) or b''
                found = re.findall(rb'dgm1_32_(\d+)_(\d+)_1_rp_(\d+)\.tif', body)
                self.years = {(int(e), int(n)): y.decode() for e, n, y in found}
                os.makedirs(self.dir, exist_ok=True)
                tmp = f'{path}.{os.getpid()}.part'
                with open(tmp, 'w', encoding='utf-8') as fh:
                    json.dump({f'{e}_{n}': y for (e, n), y in self.years.items()}, fh)
                os.replace(tmp, path)
        return self.years.get((ix, iy))

    def url(self, ix: int, iy: int) -> Optional[str]:
        y = self.year(ix, iy)
        return f'{self.folder}dgm1_32_{ix}_{iy}_1_rp_{y}.tif' if y else None


class MecklenburgVorpommern(TiledSource):
    """LAiV MV DGM1 (CC BY 4.0): 2 km GeoTIFFs in EPSG:25833 named by their
    south-west corner in km."""
    id = 11
    name = 'mecklenburg-vorpommern'
    bbox = (10.5, 53.0, 14.5, 54.75)
    crs = 'EPSG:25833'
    tile_m = 2000.0

    def url(self, ix: int, iy: int) -> Optional[str]:
        return ('https://www.geodaten-mv.de/dienste/dgm_download?index=4&dataset=ca268792-s2q1-4a39-b34c-9ec5bf9a4469'
                f'&file=dgm1_33_{ix * 2}_{iy * 2}_2_gtiff.tif')


class Thueringen(TiledSource):
    """TLBG DGM1 2020-2025 (dl-de/by-2-0): 1 km zipped XYZ text in EPSG:25832."""
    id = 13
    name = 'thueringen'
    bbox = (9.85, 50.2, 12.7, 51.65)
    crs = 'EPSG:25832'

    def url(self, ix: int, iy: int) -> Optional[str]:
        return f'https://geoportal.geoportal-th.de/hoehendaten/DGM/dgm_2020-2025/dgm1_32_{ix}_{iy}_1_th_2020-2025.zip'


class GranCanaria(Wcs):
    """IGN MDT 5 m (CC BY 4.0) through the INSPIRE WCS, EPSG:4083 (REGCAN95 /
    UTM 28N). The 2 m model is only in the manual download centre."""
    id = 17
    name = 'gran-canaria'
    bbox = (-18.3, 27.6, -13.3, 29.45)
    crs = 'EPSG:4083'
    base = 'https://servicios.idee.es/wcs-inspire/mdt'
    coverage = 'Elevacion4083_5'
    scale = None


# In the order a station tries them. Not read yet (no open, scriptable access
# found, 2026-10-06): Sachsen-Anhalt (its WCS answers 403), Sachsen and
# Schleswig-Holstein (no scriptable tile download), Hamburg and Bremen (whole-city
# archives; Bremen's licence unclear), Saarland (its WCS is fee-based).
SOURCE_TYPES = [Bavaria, Austria, Switzerland, Niedersachsen, BadenWuerttemberg, BrandenburgBerlin, Hessen, Nrw,
                RheinlandPfalz, MecklenburgVorpommern, Thueringen, GranCanaria]


# --- measuring ----------------------------------------------------------------

def sample_line(points: Sequence[Tuple[float, float]], step: float):
    """Stations every `step` metres along a lon/lat polyline (its ends
    included): lon, lat and the unit heading (east, north)."""
    lat0 = points[0][1]
    kx, ky = m_per_deg_lon(lat0), M_PER_DEG_LAT
    p = np.array(points, dtype=np.float64)
    x = (p[:, 0] - p[0, 0]) * kx
    y = (p[:, 1] - p[0, 1]) * ky
    seg = np.hypot(np.diff(x), np.diff(y))
    keep = np.concatenate([[True], seg > 1e-3])
    x, y = x[keep], y[keep]
    if len(x) < 2:
        return None
    seg = np.hypot(np.diff(x), np.diff(y))
    s = np.concatenate([[0.0], np.cumsum(seg)])
    total = s[-1]
    n = max(2, int(math.ceil(total / step - 1e-6)) + 1)
    d = np.linspace(0.0, total, n)
    i = np.clip(np.searchsorted(s, d, side='right') - 1, 0, len(seg) - 1)
    t = (d - s[i]) / seg[i]
    sx = x[i] + (x[i + 1] - x[i]) * t
    sy = y[i] + (y[i + 1] - y[i]) * t
    de = (x[i + 1] - x[i]) / seg[i]
    dn = (y[i + 1] - y[i]) / seg[i]
    return p[0, 0] + sx / kx, p[0, 1] + sy / ky, de, dn


def station_reads(lons: np.ndarray, lats: np.ndarray, de: np.ndarray, dn: np.ndarray, half: np.ndarray):
    """The 27 read points of each station: 5 across the crown, then 11 each
    side. Returns (lon, lat) arrays shaped (stations, 27)."""
    h = np.maximum(CROWN_MIN_HALF_M, half)[:, None]
    offs = np.concatenate([
        np.array(CROWN_FRACTIONS)[None, :] * h,
        h + SIDE_OFFSETS[None, :],
        -(h + SIDE_OFFSETS[None, :]),
    ], axis=1)
    ne, nn = -dn[:, None], de[:, None]   # left normal
    kx = 111412.84 * np.cos(np.radians(lats))[:, None]
    return lons[:, None] + ne * offs / kx, lats[:, None] + nn * offs / M_PER_DEG_LAT


def reduce_reads(v: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """(crown, side) per station from its 27 reads; NaN where unmeasured."""
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        crown = np.nanmedian(v[:, :5], axis=1)
        left = np.nanmedian(v[:, 5:16], axis=1)
        right = np.nanmedian(v[:, 16:27], axis=1)
    side = np.where(np.isfinite(left) & np.isfinite(right), (left + right) / 2,
                    np.where(np.isfinite(left), left, right))
    return crown, side


def measure_stations(sources: List[Source], lons, lats, de, dn, half):
    """Crown, side and source id per station; each station is read whole from
    the first source (in order) that has its crown."""
    n = len(lons)
    crown = np.full(n, np.nan)
    side = np.full(n, np.nan)
    src = np.zeros(n, np.uint8)
    if n == 0:
        return crown, side, src
    rl, ra = station_reads(lons, lats, de, dn, half)
    for s in sources:
        todo = (src == 0) & s.covers(lons, lats)
        if not todo.any():
            continue
        idx = np.nonzero(todo)[0]
        v = s.heights(rl[idx].ravel(), ra[idx].ravel()).reshape(len(idx), -1)
        c, sd = reduce_reads(v)
        ok = np.isfinite(c)
        crown[idx[ok]] = c[ok]
        side[idx[ok]] = sd[ok]
        src[idx[ok]] = s.id
    return crown, side, src


def approach_stations(points: Sequence[Tuple[float, float]]):
    """For each end of a span: the stations beyond it along the span (lon,
    lat, heading), or None where the span is too short to have a direction."""
    out = []
    last = len(points) - 1
    for end in (0, 1):
        i, step = (0, 1) if end == 0 else (last, -1)
        lon_e, lat_e = points[i]
        kx = m_per_deg_lon(lat_e)
        dist = lambda k: math.hypot((points[k][0] - lon_e) * kx, (points[k][1] - lat_e) * M_PER_DEG_LAT)
        j = i + step
        while 0 <= j + step <= last and dist(j) < APPROACH_DIR_MIN_M:
            j += step
        if not (0 <= j <= last):
            out.append(None)
            continue
        de = (lon_e - points[j][0]) * kx
        dn = (lat_e - points[j][1]) * M_PER_DEG_LAT
        ln = math.hypot(de, dn)
        if ln < 0.5:
            out.append(None)
            continue
        ue, un = de / ln, dn / ln
        s = np.array(APPROACH_STATIONS_M)
        out.append((lon_e + ue * s / kx, lat_e + un * s / M_PER_DEG_LAT, ue, un))
    return out


def encode_lms(z, x, y, rvr_sig, rbr_sig, attempted, lines, bridge_lifts) -> bytes:
    """LMS1 (tools/bake/lidarStore.ts). `lines`: (tier, half, lon, lat, crown, lift, source)."""
    west, south, _e, _n = tile_bounds(z, x, y)
    out = bytearray()
    out += LMS_MAGIC
    out += struct.pack('<BBHIIIIIIII', LMS_VERSION, z, 0, x, y, rvr_sig, rbr_sig, attempted,
                       len(lines), len(bridge_lifts) // 2, 0)
    for tier, half, lon, lat, crown, lift, src in lines:
        n = len(lon)
        qx = np.round((np.asarray(lon) - west) / LMS_DEG).astype(np.int64)
        qy = np.round((np.asarray(lat) - south) / LMS_DEG).astype(np.int64)
        d = np.stack([np.diff(qx), np.diff(qy)], axis=1)
        if np.abs(d).max(initial=0) > 32767:
            raise ValueError('LMS: samples too far apart')
        out += struct.pack('<BBHHii', tier, 0, int(round(half * 10)), n, int(qx[0]), int(qy[0]))
        out += d.astype('<i2').tobytes()
        c = np.where(np.isfinite(crown), np.clip(np.round((crown - CROWN_OFFSET_M) * 10), 1, 65535), 0)
        out += c.astype('<u2').tobytes()
        out += cm(lift).tobytes()
        out += np.asarray(src, np.uint8).tobytes()
    out += cm(np.asarray(bridge_lifts, np.float64)).tobytes()
    return bytes(out)


def cm(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, np.float64)
    return np.where(np.isfinite(v), np.clip(np.round(np.nan_to_num(v) * 100), -32767, 32767), NO_LIFT).astype('<i2')


def decode_lms_header(data: bytes) -> dict:
    if data[:4] != LMS_MAGIC:
        raise ValueError('LMS: bad magic')
    version, z, _r, x, y, rvr_sig, rbr_sig, attempted, lines, bridges, _r2 = struct.unpack_from('<BBHIIIIIIII', data, 4)
    return {'version': version, 'z': z, 'x': x, 'y': y, 'rvrSig': rvr_sig, 'rbrSig': rbr_sig,
            'attempted': attempted, 'lines': lines, 'bridges': bridges}


def store_path(x: int, y: int) -> str:
    return os.path.join(STORE_DIR, str(LEAF_ZOOM), str(x), f'{y}.lms')


def planet_path(x: int, y: int, ext: str) -> str:
    return os.path.join(PLANET_DIR, str(LEAF_ZOOM), str(x), f'{y}{ext}')


def leaf_sources(x: int, y: int) -> List[type]:
    box = tile_bounds(LEAF_ZOOM, x, y)
    probe = Source({})
    out = []
    for t in SOURCE_TYPES:
        probe.bbox = t.bbox
        if probe.intersects(box):
            out.append(t)
    return out


def up_to_date(x: int, y: int) -> bool:
    p = store_path(x, y)
    if not os.path.exists(p):
        return False
    try:
        with gzip.open(p, 'rb') as fh:
            h = decode_lms_header(fh.read(40))
    except (OSError, ValueError, struct.error):
        return False
    mask = sum(1 << t.id for t in leaf_sources(x, y))
    return (h['version'] == LMS_VERSION and h['rvrSig'] == crc32_file(planet_path(x, y, '.rvr'))
            and h['rbrSig'] == crc32_file(planet_path(x, y, '.rbr')) and (mask & ~h['attempted']) == 0)


_WORKER: dict = {}


def _worker_sources() -> Tuple[Dict[int, Source], dict]:
    if not _WORKER:
        import rasterio
        env = rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',
                           GDAL_HTTP_USERAGENT=USER_AGENT, GDAL_HTTP_MAX_RETRY='4', GDAL_HTTP_RETRY_DELAY='3',
                           GDAL_HTTP_MULTIRANGE='YES', GDAL_CACHEMAX=256, VSI_CACHE='TRUE')
        env.__enter__()
        stats = {'downloads': 0, 'downloadedMB': 0.0, 'cacheHits': 0, 'blocks': 0}
        _WORKER['env'] = env
        _WORKER['stats'] = stats
        _WORKER['sources'] = {t.id: t(stats) for t in SOURCE_TYPES}
    return _WORKER['sources'], _WORKER['stats']


def measure_leaf(x: int, y: int) -> dict:
    """Measure one leaf and write its store file; a summary for the log."""
    t0 = time.time()
    sources_by_id, stats = _worker_sources()
    before = dict(stats)
    box = tile_bounds(LEAF_ZOOM, x, y)
    types = leaf_sources(x, y)
    sources = [sources_by_id[t.id] for t in types]
    for s in sources:
        s.prepare(box)
    rvr_p, rbr_p = planet_path(x, y, '.rvr'), planet_path(x, y, '.rbr')
    roads = []
    if os.path.exists(rvr_p):
        with open(rvr_p, 'rb') as fh:
            roads = decode_rvr(fh.read())
    spans = []
    if os.path.exists(rbr_p):
        with open(rbr_p, 'rb') as fh:
            spans = decode_rbr(fh.read())

    # Every station of the leaf in one batch, so each source tile is read once.
    lines_meta = []
    L, A, E, N, H = [], [], [], [], []
    for cls, width, pts in roads:
        tier = bed_tier(cls)
        if tier < 0 or len(pts) < 2:
            continue
        st = sample_line(pts, STREET_STEP_M if tier == STREET_TIER else STEP_M)
        if st is None:
            continue
        lon, lat, de, dn = st
        lines_meta.append((tier, width / 2, len(lon)))
        L.append(lon); A.append(lat); E.append(de); N.append(dn); H.append(np.full(len(lon), width / 2))
    bridge_slots = []
    for b in spans:
        for st in approach_stations(b.points):
            if st is None:
                bridge_slots.append(0)
                continue
            lon, lat, ue, un = st
            bridge_slots.append(len(lon))
            L.append(lon); A.append(lat); E.append(np.full(len(lon), ue)); N.append(np.full(len(lon), un))
            H.append(np.full(len(lon), b.deck_width_m / 2))
    cat = lambda xs: np.concatenate(xs) if xs else np.zeros(0)
    crown, side, src = measure_stations(sources, cat(L), cat(A), cat(E), cat(N), cat(H))

    lines, o = [], 0
    measured = total = 0
    for (tier, half, n), lon, lat in zip(lines_meta, L, A):
        c, sd, sr = crown[o:o + n], side[o:o + n], src[o:o + n]
        lines.append((tier, half, lon, lat, c, c - sd, sr))
        measured += int(np.isfinite(c).sum())
        total += n
        o += n
    lifts = []
    ends_measured = 0
    for n in bridge_slots:
        if n == 0:
            lifts.append(np.nan)
            continue
        v = (crown[o:o + n] - side[o:o + n])
        v = v[np.isfinite(v)]
        lifts.append(float(np.median(v)) if len(v) else np.nan)
        ends_measured += int(len(v) > 0)
        o += n
    attempted = sum(1 << t.id for t in types)
    blob = gzip.compress(encode_lms(LEAF_ZOOM, x, y, crc32_file(rvr_p), crc32_file(rbr_p), attempted, lines, lifts), 6)
    p = store_path(x, y)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = f'{p}.{os.getpid()}.part'
    with open(tmp, 'wb') as fh:
        fh.write(blob)
    os.replace(tmp, p)
    by_source: Dict[int, float] = {}
    for tier, half, lon, lat, c, lift, sr in lines:
        step = STREET_STEP_M if tier == STREET_TIER else STEP_M
        for sid in np.unique(sr):
            by_source[int(sid)] = by_source.get(int(sid), 0.0) + float((sr == sid).sum()) * step / 1000
    return {
        'leaf': (x, y), 'seconds': time.time() - t0, 'stations': total, 'measured': measured,
        'ends': len(bridge_slots), 'endsMeasured': ends_measured, 'bytes': len(blob), 'kmBySource': by_source,
        'downloadedMB': stats['downloadedMB'] - before['downloadedMB'], 'downloads': stats['downloads'] - before['downloads'],
        'cacheHits': stats['cacheHits'] - before['cacheHits'], 'blocks': stats['blocks'] - before['blocks'],
    }


def trim_cache(limit_bytes: float) -> None:
    """Oldest-used files out until the cache is under its limit."""
    files = []
    for root, _dirs, names in os.walk(CACHE_DIR):
        for nm in names:
            if nm.endswith('.bin') or nm.endswith('.tif'):
                p = os.path.join(root, nm)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                files.append((st.st_mtime, st.st_size, p))
    total = sum(f[1] for f in files)
    if total <= limit_bytes:
        return
    for _m, size, p in sorted(files):
        try:
            os.remove(p)
            total -= size
        except OSError:
            continue
        if total <= limit_bytes * 0.8:
            break


def leaves_in(bbox: Sequence[float]) -> List[Tuple[int, int]]:
    span = 180.0 / (1 << LEAF_ZOOM)
    w, s, e, n = bbox
    x0, x1 = int(math.floor((w + 180) / span)), int(math.floor((e + 180) / span))
    y0, y1 = int(math.floor((90 - n) / span)), int(math.floor((90 - s) / span))
    out = []
    for y in range(y0, y1 + 1):          # row order: neighbours share source tiles
        for x in range(x0, x1 + 1):
            if os.path.exists(planet_path(x, y, '.rvr')) or os.path.exists(planet_path(x, y, '.rbr')):
                out.append((x, y))
    return out


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--bbox', help='west,south,east,north')
    ap.add_argument('--leaf', help='x,y of one z12 leaf')
    ap.add_argument('--jobs', type=int, default=max(1, min(6, (os.cpu_count() or 2) - 1)))
    ap.add_argument('--force', action='store_true', help='measure leaves already up to date')
    ap.add_argument('--cache-gb', type=float, default=2.0)
    ap.add_argument('--min-free-gb', type=float, default=3.0)
    args = ap.parse_args(argv)
    if args.leaf:
        leaves = [tuple(int(v) for v in args.leaf.split(','))]
    elif args.bbox:
        leaves = leaves_in([float(v) for v in args.bbox.split(',')])
    else:
        ap.error('give --bbox or --leaf')
    todo = [k for k in leaves if args.force or not up_to_date(*k)]
    todo = [k for k in todo if leaf_sources(*k)]
    print(f'measure_lidar: {len(leaves)} leaves with vectors, {len(todo)} to measure '
          f'({len(leaves) - len(todo)} up to date or outside every source)', flush=True)
    t0 = time.time()
    agg = {'stations': 0, 'measured': 0, 'ends': 0, 'endsMeasured': 0, 'bytes': 0, 'downloadedMB': 0.0,
           'downloads': 0, 'cacheHits': 0, 'blocks': 0}
    km: Dict[int, float] = {}
    failed = 0
    done = 0

    def account(r: dict) -> None:
        nonlocal done
        done += 1
        for k in agg:
            agg[k] += r[k]
        for sid, v in r['kmBySource'].items():
            km[sid] = km.get(sid, 0.0) + v
        if done % 10 == 0 or done == len(todo) or args.leaf:
            el = time.time() - t0
            eta = el / done * (len(todo) - done)
            print(f'  {done}/{len(todo)} leaves, last {r["leaf"][0]}/{r["leaf"][1]} {r["seconds"]:.1f} s; '
                  f'{agg["measured"]}/{agg["stations"]} stations measured, {agg["downloadedMB"]:.0f} MB down, '
                  f'{agg["blocks"]} COG blocks; {el / 60:.1f} min, ~{eta / 60:.0f} min left', flush=True)

    if args.jobs <= 1 or len(todo) <= 1:
        for k in todo:
            account(measure_leaf(*k))
            trim_cache(args.cache_gb * 1e9)
    else:
        with ProcessPoolExecutor(args.jobs) as pool:
            pending = {}
            it = iter(todo)
            for k in it:
                pending[pool.submit(measure_leaf, *k)] = k
                if len(pending) >= args.jobs * 2:
                    break
            while pending:
                for f in as_completed(list(pending)):
                    k = pending.pop(f)
                    try:
                        account(f.result())
                    except Exception as ex:  # noqa: BLE001 - one leaf's failure is logged, the rest go on
                        failed += 1
                        print(f'  leaf {k[0]}/{k[1]} failed: {ex!r}', flush=True)
                    if done % 20 == 0:
                        trim_cache(args.cache_gb * 1e9)
                    if shutil.disk_usage('.').free < args.min_free_gb * 1e9:
                        print(f'measure_lidar: under {args.min_free_gb} GB free; stopping (re-run resumes)', flush=True)
                        for p in pending:
                            p.cancel()
                        return 2
                    nxt = next(it, None)
                    if nxt is not None:
                        pending[pool.submit(measure_leaf, *nxt)] = nxt
                    break
    names = {t.id: t.name for t in SOURCE_TYPES}
    names[0] = 'unmeasured'
    by = ', '.join(f'{names.get(s, s)} {v:.0f} km' for s, v in sorted(km.items()))
    print(f'measure_lidar: {done} leaves in {(time.time() - t0) / 60:.1f} min, {failed} failed; '
          f'stations {agg["measured"]}/{agg["stations"]} measured ({by}); bridge ends {agg["endsMeasured"]}/{agg["ends"]}; '
          f'store +{agg["bytes"] / 1e6:.1f} MB; {agg["downloads"]} files {agg["downloadedMB"]:.0f} MB down, '
          f'{agg["cacheHits"]} cache hits, {agg["blocks"]} COG blocks', flush=True)
    return 1 if failed else 0


if __name__ == '__main__':
    code = main()
    sys.stdout.flush()
    sys.stderr.flush()
    # GDAL's curl teardown can hang the interpreter's exit on Windows.
    os._exit(code)

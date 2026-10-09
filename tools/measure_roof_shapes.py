#!/usr/bin/env python3
"""Measure every building's height and roof shape in open surface models (phase 3 of docs/terrain-buildings.md).

Per z12 leaf with OSM footprints (.bvr): for each building, the digital
surface model (roofs and all) is read over its footprint and the terrain
model under it, and the roof shapes the runtime can build
(src/script/terrain/buildingRoofs.ts) are fitted to the surface. Only the
answers are kept - form, eave and ridge height above the ground, ridge
azimuth, fit error - in the building shape store (BHS1,
data/imports/buildings/shape/12/x/y.bhs), keyed by OSM id, which
tools/bake_planet_buildings.ts reads. A leaf whose .bvr is unchanged since
it was measured is skipped.

The fit. Every runtime roof is eave + rise * f(s, t), where (s, t) are
metres along and across the ridge from the middle of the footprint's
extent, L and W the half-extents along and across, and f a fixed shape:

  flat        0                                        (one parameter)
  gabled      1 - |t| / W
  hipped      min(W - |t|, L - |s|) / W                (ends at the sides' pitch)
  half-hipped min(1 - |t| / W, 0.5 + 2 (L - |s|) / W)
  pyramidal   min(1 - |t| / W, 1 - |s| / L)
  skillion    (t + W) / 2W                             (and mirrored)

- exactly the planes roofPlanes() builds, so the fitted eave and rise go
straight back into the runtime. Except for one thing: a real ridge is often
not on the middle of the footprint's extent (an L-shaped outline, a
lean-to wing, a saltbox), and a centred gable then fits worse than a single
tilted plane - the first run on Garmisch called a third of the town
skillion. So every symmetric shape also takes a ridge offset t0, searched
over +-RIDGE_OFFSET_FRACTION of W, |t| becoming |t - t0|. The runtime still
draws the roof centred, with the same mean eave and the same ridge, which
is all the offset was needed for: the form. With the shape fixed, the surface is linear
in (eave, rise): each candidate (form x ridge along or across the
footprint's minimum-area rectangle x skillion side) is an ordinary least
squares fit, refitted once without the points it misses by more than
OUTLIER_M (a chimney, a dormer, an overhanging tree). The candidate with
the lowest BIC wins, the rarer shapes carrying a small prior penalty.
Fitting the absolute surface, not surface minus terrain: a roof is a plane
whatever the slope under it.

Sources (SOURCES), each a 20 cm surface from image matching of the state's
aerial survey over its 1 m lidar terrain, same height datum (DHHN2016):

  Bavaria       DOM20 over DGM1, CC BY 4.0, "Datenquelle: Bayerische
                Vermessungsverwaltung - www.geodaten.bayern.de", EPSG:25832.
                DOM20 files are 35 MB per km2 but tiled, so only the 256 px
                blocks under buildings are read, over HTTP ranges, and
                nothing of them is stored.
  Brandenburg   bDOM over DGM1, dl-de/by-2-0, "(c) GeoBasis-DE/LGB",
                EPSG:25833, 1 km zipped GeoTIFFs. A bDOM tile (~29 MB) can
                only be fetched whole, so it is kept once read, averaged to
                GRID_M as int16 cm (~5 MB, DSM_CACHE_DIR).

Berlin publishes its surface models at 1 m only (2 km XYZ text), too coarse
for these fits; its LoD2 (tools/import_lod2.py) stands above them anyway.

Each footprint is registered to the surface first (see register): OSM
outlines sit 1-2 m off the roofs, and a misplaced outline puts ground
inside the fit.

The window read around each footprint (surface and ground, int16 cm) is
kept per leaf in POINTS_DIR, ~60 MB for a town leaf, so a change to the
fit or the registration re-runs from disk (`--refit`) instead of reading
the surface model over the network again.

Usage::

    python tools/measure_roof_shapes.py --bbox 11.03,47.46,11.17,47.60 [--jobs 6]
    python tools/measure_roof_shapes.py --bbox 11.03,47.46,11.17,47.60 --refit
    python tools/measure_roof_shapes.py --leaf 4348,967 --force
"""

from __future__ import annotations

import argparse
import math
import os
import struct
import sys
import time
import warnings
import zlib
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import Polygon

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_osm_buildings import Building, building_centroid, decode_bvr  # noqa: E402

# All-NaN blocks (no data) are expected; nanmean need not say so for each.
warnings.filterwarnings('ignore', category=RuntimeWarning)

LEAF_ZOOM = 12
PLANET_DIR = 'assets/planet'
STORE_DIR = 'data/imports/buildings/shape'
POINTS_DIR = 'data/imports/buildings/.points'
DTM_CACHE_DIR = 'data/imports/lidar/.cache/bavaria'
DSM_CACHE_DIR = 'data/imports/buildings/.dsm'
USER_AGENT = 'retroflightsim-terrain-bake (roof shape fitter)'

# Keep in step with tools/bake/buildingShapeStore.ts.
BHS_MAGIC = b'BHS1'
BHS_VERSION = 1
_BHS_HEAD = struct.Struct('<4sBBHII')  # magic, version, 0, 0, bvr crc32, count
# id, form, flags, azimuth (0.01 deg), eave (cm above ground), ridge (cm), rmse (cm), confidence (/255), points
_BHS_REC = struct.Struct('<qBBHHHHBH')
FLAG_ABSENT = 1  # the surface model shows no building here (gone, or built since)
# The form beat the best fit of any other form by FORM_SURE_BIC: trust the
# form and ridge, not only the heights. The confidence byte is about the heights.
FLAG_FORM_SURE = 2
FORM_SURE_BIC = 10.0

# RoofForm values (src/script/terrain/pbh.ts).
FLAT, GABLED, HIPPED, HALF_HIPPED, SKILLION, PYRAMIDAL = 1, 2, 3, 4, 5, 6
FORM_NAMES = {FLAT: 'flat', GABLED: 'gabled', HIPPED: 'hipped', HALF_HIPPED: 'half-hipped',
              SKILLION: 'skillion', PYRAMIDAL: 'pyramidal'}

GRID_M = 0.4  # DOM20 averaged 2 x 2
MARGIN_M = 3.2
# Footprints are slid over the surface by up to this much to sit on their roofs
# (OSM outlines are traced off older or leaning imagery): the shift that
# covers the most standing structure, by at least REGISTER_MIN_GAIN of the
# footprint more than none, the middle of the shifts within REGISTER_TIE.
REGISTER_REACH_M = 2.4
REGISTER_MIN_GAIN = 0.05
REGISTER_TIE = 0.02
NODATA_CM = -32768
ERODE_M = 0.4
OUTLIER_M = 1.2
MIN_POINTS = 20
RIDGE_OFFSET_FRACTION = 0.5
RIDGE_OFFSET_STEPS = 11
# A footprint whose surface stands less than this over the ground has no building in the model.
MIN_STANDING_M = 1.5
# Below this rise, or this slope, a pitched fit is a flat roof with noise.
MIN_RISE_M = 0.8
MIN_SLOPE = 0.12
# BIC prior penalties for the rarer shapes.
PRIOR = {FLAT: 0.0, GABLED: 0.0, HIPPED: 2.0, HALF_HIPPED: 6.0, PYRAMIDAL: 6.0, SKILLION: 4.0}


def tile_bounds(z: int, x: int, y: int) -> Tuple[float, float, float, float]:
    span = 180.0 / (1 << z)
    west = -180.0 + x * span
    north = 90.0 - y * span
    return west, north - span, west + span, north


def planet_path(x: int, y: int, ext: str) -> str:
    return os.path.join(PLANET_DIR, str(LEAF_ZOOM), str(x), f'{y}{ext}')


def store_path(x: int, y: int) -> str:
    return os.path.join(STORE_DIR, str(LEAF_ZOOM), str(x), f'{y}.bhs')


def crc32_file(path: str) -> int:
    with open(path, 'rb') as fh:
        return zlib.crc32(fh.read()) & 0xFFFFFFFF


# --- geometry ---------------------------------------------------------------------

def min_area_rect(pts: np.ndarray) -> Tuple[float, float, float]:
    """(angle of the long side from +x toward +y, long, short) of the minimum-area rectangle."""
    p = sorted(map(tuple, pts))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower: list = []
    for q in p:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], q) <= 0:
            lower.pop()
        lower.append(q)
    upper: list = []
    for q in reversed(p):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], q) <= 0:
            upper.pop()
        upper.append(q)
    hull = np.array(lower[:-1] + upper[:-1])
    best = (0.0, 0.0, 0.0)
    best_area = math.inf
    for i in range(len(hull)):
        a, b = hull[i], hull[(i + 1) % len(hull)]
        ang = math.atan2(b[1] - a[1], b[0] - a[0])
        c, s = math.cos(ang), math.sin(ang)
        ps = hull[:, 0] * c + hull[:, 1] * s
        pt = -hull[:, 0] * s + hull[:, 1] * c
        ls, lt = ps.max() - ps.min(), pt.max() - pt.min()
        if ls * lt < best_area - 1e-9:
            best_area = ls * lt
            best = (ang, ls, lt) if ls >= lt else (ang + math.pi / 2, lt, ls)
    return best


def shape_fn(form: int, s: np.ndarray, t: np.ndarray, L: float, W: float, t0: float = 0.0) -> np.ndarray:
    L, W = max(L, 0.5), max(W, 0.5)
    if form != SKILLION:
        t = t - t0
    if form == FLAT:
        return np.zeros_like(s)
    if form == GABLED:
        return 1 - np.abs(t) / W
    if form == HIPPED:
        return np.minimum(W - np.abs(t), L - np.abs(s)) / W
    if form == HALF_HIPPED:
        return np.minimum(1 - np.abs(t) / W, 0.5 + 2 * (L - np.abs(s)) / W)
    if form == PYRAMIDAL:
        return np.minimum(1 - np.abs(t) / W, 1 - np.abs(s) / L)
    if form == SKILLION:
        return (t + W) / (2 * W)
    raise ValueError(form)


def fit_roof(outline: np.ndarray, px: np.ndarray, py: np.ndarray, h: np.ndarray) -> Optional[dict]:
    """The best roof over points (px, py, h) inside `outline` (all in metres, x east, y north).

    Returns form, eave, ridge (absolute), azimuth of the ridge axis in compass
    degrees (for a skillion: the axis whose quarter turn counter-clockwise
    points uphill), rmse and points used.
    """
    n = len(h)
    if n < MIN_POINTS:
        return None
    ang, _long, _short = min_area_rect(outline)
    best: Optional[dict] = None
    best_by_form: Dict[int, float] = {}
    for orient in (0.0, math.pi / 2):
        for flip in (0.0, math.pi):
            phi = ang + orient + flip
            c, s_ = math.cos(phi), math.sin(phi)
            os_ = outline[:, 0] * c + outline[:, 1] * s_
            ot = -outline[:, 0] * s_ + outline[:, 1] * c
            sc, tc = (os_.max() + os_.min()) / 2, (ot.max() + ot.min()) / 2
            L, W = (os_.max() - os_.min()) / 2, (ot.max() - ot.min()) / 2
            ps = px * c + py * s_ - sc
            pt = -px * s_ + py * c - tc
            forms = [SKILLION] if flip else [FLAT, GABLED, HIPPED, HALF_HIPPED, PYRAMIDAL]
            if flip == 0.0:
                forms.append(SKILLION)
            if orient:
                forms = [f for f in forms if f != FLAT and f != PYRAMIDAL]
            for form in forms:
                offsets = [0.0] if form in (FLAT, SKILLION) else list(
                    np.linspace(-RIDGE_OFFSET_FRACTION, RIDGE_OFFSET_FRACTION, RIDGE_OFFSET_STEPS) * W)
                for t0 in offsets:
                    f = shape_fn(form, ps, pt, L, W, t0)
                    keep = np.ones(n, dtype=bool)
                    coef = None
                    for _ in range(2):
                        A = np.stack([np.ones(keep.sum()), f[keep]], axis=1) if form != FLAT else np.ones((keep.sum(), 1))
                        coef, *_ = np.linalg.lstsq(A, h[keep], rcond=None)
                        pred = coef[0] + (coef[1] * f if form != FLAT else 0)
                        res = h - pred
                        keep = np.abs(res) <= OUTLIER_M
                        if keep.sum() < MIN_POINTS:
                            break
                    if coef is None or keep.sum() < MIN_POINTS:
                        continue
                    rise = float(coef[1]) if form != FLAT else 0.0
                    if form != FLAT and (rise < MIN_RISE_M or rise / max(W, 0.5) < MIN_SLOPE * (1 if form != SKILLION else 0.5)):
                        continue
                    # The eave as the runtime's centred roof has it: the mean
                    # of the two walls' heights, which is where f is 0 on
                    # average whatever the offset.
                    eave = float(coef[0])
                    # Scored over every point, outliers capped: a shape must not
                    # win by throwing away the points it cannot explain.
                    capped = np.minimum(np.abs(res), OUTLIER_M * 2)
                    rss = float(np.sum(capped ** 2))
                    k = 1 if form == FLAT else 2 if form == SKILLION else 3
                    bic = n * math.log(max(rss / n, 1e-4)) + k * math.log(n) + PRIOR[form]
                    best_by_form[form] = min(best_by_form.get(form, math.inf), bic)
                    if best is None or bic < best['bic']:
                        best = {'form': form, 'eave': eave, 'ridge': eave + rise, 'phi': phi, 'bic': bic,
                                'rmse': math.sqrt(rss / n), 'points': int(keep.sum()),
                                'kept': float(keep.mean()), 'offset': float(t0)}
    if best is None:
        return None
    best['bics'] = best_by_form
    others = [v for f, v in best_by_form.items() if f != best['form']]
    best['bicGap'] = (min(others) - best['bic']) if others else math.inf
    # Compass azimuth of the ridge axis: phi is from east toward north.
    best['azimuth'] = (90.0 - math.degrees(best['phi'])) % 360.0
    return best


# --- rasters -----------------------------------------------------------------------

_GDAL_ENV = None


def gdal_env():
    global _GDAL_ENV
    if _GDAL_ENV is None:
        import rasterio
        _GDAL_ENV = rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif',
                                 GDAL_HTTP_MULTIRANGE='YES', GDAL_HTTP_MERGE_CONSECUTIVE_RANGES='YES',
                                 GDAL_CACHEMAX=512, GDAL_HTTP_USERAGENT=USER_AGENT,
                                 GDAL_HTTP_MAX_RETRY='4', GDAL_HTTP_RETRY_DELAY='2')
        _GDAL_ENV.__enter__()
    return _GDAL_ENV


class Dom20:
    """Bavaria's DOM20 tiles, opened over HTTP and read by window."""

    def __init__(self):
        self.open: Dict[Tuple[int, int], object] = {}

    def dataset(self, ix: int, iy: int):
        key = (ix, iy)
        if key not in self.open:
            import rasterio
            gdal_env()
            url = f'/vsicurl/https://download1.bayernwolke.de/a/dom20/DOM/32{ix}_{iy}_20_DOM.tif'
            try:
                self.open[key] = rasterio.open(url)
            except Exception:  # noqa: BLE001 - no tile there
                self.open[key] = None
            while len(self.open) > 8:
                old = next(iter(self.open))
                if self.open[old] is not None:
                    self.open[old].close()
                del self.open[old]
        return self.open[key]

    def read(self, x0: float, y0: float, x1: float, y1: float) -> Optional[Tuple[np.ndarray, float, float]]:
        """The surface over [x0, x1] x [y0, y1] (EPSG:25832) at GRID_M, north up, NaN for none; and its top-left corner."""
        from rasterio.windows import from_bounds
        ix0, ix1 = int(x0 // 1000), int(x1 // 1000)
        iy0, iy1 = int(y0 // 1000), int(y1 // 1000)
        # Snap to the grid so every tile's pixels land on the same lattice.
        gx0, gy1 = math.floor(x0 / GRID_M) * GRID_M, math.ceil(y1 / GRID_M) * GRID_M
        w = int(math.ceil((x1 - gx0) / GRID_M)) + 1
        hgt = int(math.ceil((gy1 - y0) / GRID_M)) + 1
        out = np.full((hgt, w), np.nan, dtype=np.float32)
        for ix in range(ix0, ix1 + 1):
            for iy in range(iy0, iy1 + 1):
                ds = self.dataset(ix, iy)
                if ds is None:
                    continue
                bx0, by0 = max(gx0, ix * 1000.0), max(gy1 - hgt * GRID_M, iy * 1000.0)
                bx1, by1 = min(gx0 + w * GRID_M, ix * 1000.0 + 1000), min(gy1, iy * 1000.0 + 1000)
                if bx1 <= bx0 or by1 <= by0:
                    continue
                win = from_bounds(bx0, by0, bx1, by1, ds.transform).round_offsets().round_lengths()
                a = ds.read(1, window=win, boundless=False).astype(np.float32)
                a[a <= -9000] = np.nan
                hh, ww = (a.shape[0] // 2) * 2, (a.shape[1] // 2) * 2
                if hh == 0 or ww == 0:
                    continue
                a = np.nanmean(a[:hh, :ww].reshape(hh // 2, 2, ww // 2, 2), axis=(1, 3))
                r0 = int(round((gy1 - by1) / GRID_M))
                c0 = int(round((bx0 - gx0) / GRID_M))
                rr, cc = min(a.shape[0], hgt - r0), min(a.shape[1], w - c0)
                if rr > 0 and cc > 0:
                    out[r0:r0 + rr, c0:c0 + cc] = a[:rr, :cc]
        return out, gx0, gy1


class Dgm1:
    """Bavaria's DGM1, whole 1 km files in the lidar stage's cache."""
    cache_dir = DTM_CACHE_DIR

    def __init__(self):
        self.mem: Dict[Tuple[int, int], Optional[np.ndarray]] = {}

    def download(self, ix: int, iy: int) -> bytes:
        """The tile's GeoTIFF; raises where there is none."""
        import urllib.request
        req = urllib.request.Request(f'https://download1.bayernwolke.de/a/dgm/dgm1/{ix}_{iy}.tif',
                                     headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()

    def grid(self, ix: int, iy: int) -> Optional[np.ndarray]:
        key = (ix, iy)
        if key in self.mem:
            return self.mem[key]
        path = os.path.join(self.cache_dir, f'{ix}_{iy}.tif')
        if not os.path.exists(path):
            os.makedirs(self.cache_dir, exist_ok=True)
            try:
                data = self.download(ix, iy)
            except Exception:  # noqa: BLE001 - no tile there
                self.mem[key] = None
                return None
            tmp = f'{path}.{os.getpid()}.part'
            with open(tmp, 'wb') as fh:
                fh.write(data)
            os.replace(tmp, path)
        import rasterio
        with rasterio.open(path) as ds:
            arr = ds.read(1).astype(np.float32)
            arr[arr < -1000] = np.nan
            # Grid of cell centres: (ix*1000 + 0.5 + col, iy*1000 + 999.5 - row).
        self.mem[key] = arr
        if len(self.mem) > 16:
            self.mem.pop(next(iter(self.mem)))
        return arr

    def heights(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        out = np.full(xs.shape, np.nan, dtype=np.float32)
        ix = np.floor(xs / 1000).astype(np.int64)
        iy = np.floor(ys / 1000).astype(np.int64)
        for key in set(zip(ix.tolist(), iy.tolist())):
            sel = (ix == key[0]) & (iy == key[1])
            g = self.grid(*key)
            if g is None:
                continue
            col = np.clip(np.round(xs[sel] - key[0] * 1000 - 0.5).astype(np.int64), 0, g.shape[1] - 1)
            row = np.clip(np.round(key[1] * 1000 + 999.5 - ys[sel]).astype(np.int64), 0, g.shape[0] - 1)
            out[sel] = g[row, col]
        return out


def zip_member(data: bytes, suffix: str) -> bytes:
    """The first member of a zip whose name ends in `suffix`; raises where there is none."""
    import io
    import zipfile
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        name = next(n for n in z.namelist() if n.lower().endswith(suffix))
        return z.read(name)


def http_get(url: str, timeout: float = 300) -> Optional[bytes]:
    """The body, or None for a missing file (4xx) or after the retries."""
    import urllib.error
    import urllib.request
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as ex:
            if 400 <= ex.code < 500 and ex.code not in (408, 429):
                return None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(3 * (attempt + 1))
    return None


class BrandenburgDgm1(Dgm1):
    """LGB's DGM1, 1 km zipped GeoTIFFs, EPSG:25833: same 1 m cell-centred lattice as Bavaria's."""
    cache_dir = 'data/imports/lidar/.cache/brandenburg-dgm1'

    def download(self, ix, iy):
        data = http_get(f'https://data.geobasis-bb.de/geobasis/daten/dgm/tif/dgm_33{ix}-{iy}.zip')
        if data is None:
            raise FileNotFoundError(f'no DGM1 tile {ix}_{iy}')
        return zip_member(data, '.tif')


class BrandenburgBdom:
    """LGB's bDOM: 20 cm in whole 1 km zipped GeoTIFFs, kept averaged to GRID_M once read."""
    cache_dir = os.path.join(DSM_CACHE_DIR, 'brandenburg')
    cells = int(round(1000 / GRID_M))

    def __init__(self):
        self.mem: Dict[Tuple[int, int], Optional[np.ndarray]] = {}

    def grid(self, ix: int, iy: int) -> Optional[np.ndarray]:
        """The tile at GRID_M, north up from its top-left corner (ix*1000, iy*1000+1000), NaN for none."""
        key = (ix, iy)
        if key in self.mem:
            return self.mem[key]
        path = os.path.join(self.cache_dir, f'{ix}_{iy}.npz')
        none = path[:-4] + '.none'
        arr = None
        if os.path.exists(path):
            cm = np.load(path)['cm']
            arr = np.where(cm == NODATA_CM, np.nan, cm / 100.0).astype(np.float32)
        elif not os.path.exists(none):
            data = http_get(f'https://data.geobasis-bb.de/geobasis/daten/bdom/tif/bdom_33{ix}-{iy}.zip')
            os.makedirs(self.cache_dir, exist_ok=True)
            if data is None:
                open(none, 'wb').close()
            else:
                import rasterio
                from rasterio.io import MemoryFile
                with MemoryFile(zip_member(data, '.tif')) as mf, mf.open() as ds:
                    a = ds.read(1).astype(np.float32)
                    if ds.nodata is not None:
                        a[a == ds.nodata] = np.nan
                    a[a <= -9000] = np.nan
                    step = int(round(GRID_M / ds.res[0]))
                    hh, ww = (a.shape[0] // step) * step, (a.shape[1] // step) * step
                    arr = np.nanmean(a[:hh, :ww].reshape(hh // step, step, ww // step, step), axis=(1, 3))
                cm = np.where(np.isfinite(arr), np.round(arr * 100), NODATA_CM).astype(np.int16)
                tmp = f'{path}.{os.getpid()}.tmp.npz'
                np.savez_compressed(tmp, cm=cm)
                os.replace(tmp, path)
        self.mem[key] = arr
        while len(self.mem) > 6:
            self.mem.pop(next(iter(self.mem)))
        return arr

    def read(self, x0: float, y0: float, x1: float, y1: float) -> Optional[Tuple[np.ndarray, float, float]]:
        """As Dom20.read, in EPSG:25833."""
        gx0, gy1 = math.floor(x0 / GRID_M) * GRID_M, math.ceil(y1 / GRID_M) * GRID_M
        w = int(math.ceil((x1 - gx0) / GRID_M)) + 1
        hgt = int(math.ceil((gy1 - y0) / GRID_M)) + 1
        out = np.full((hgt, w), np.nan, dtype=np.float32)
        for ix in range(int(x0 // 1000), int(x1 // 1000) + 1):
            for iy in range(int(y0 // 1000), int(y1 // 1000) + 1):
                g = self.grid(ix, iy)
                if g is None:
                    continue
                # The window's cell (R, C) is the tile's (R + dr, C + dc).
                dc = int(round((gx0 - ix * 1000.0) / GRID_M))
                dr = int(round((iy * 1000.0 + 1000 - gy1) / GRID_M))
                r0, r1 = max(0, -dr), min(hgt, g.shape[0] - dr)
                c0, c1 = max(0, -dc), min(w, g.shape[1] - dc)
                if r1 > r0 and c1 > c0:
                    out[r0:r1, c0:c1] = g[r0 + dr:r1 + dr, c0 + dc:c1 + dc]
        return out, gx0, gy1


class Surface:
    """One state's surface and terrain models, and the projection they are in."""

    def __init__(self, name: str, crs: str, box: Tuple[float, float, float, float], dom, dgm):
        self.name, self.crs, self.box, self.dom, self.dgm = name, crs, box, dom, dgm

    def covers(self, w: float, s: float, e: float, n: float) -> bool:
        bw, bs, be, bn = self.box
        return not (e < bw or w > be or n < bs or s > bn)


SOURCES = [
    Surface('bavaria', 'EPSG:25832', (8.95, 47.25, 13.86, 50.58), Dom20, Dgm1),
    Surface('brandenburg', 'EPSG:25833', (11.2, 51.3, 14.8, 53.6), BrandenburgBdom, BrandenburgDgm1),
]


def source_for(x: int, y: int) -> Optional[Surface]:
    """The source a leaf is measured in: the first whose box holds the leaf's centre."""
    w, s, e, n = tile_bounds(LEAF_ZOOM, x, y)
    cx, cy = (w + e) / 2, (s + n) / 2
    return next((src for src in SOURCES if src.covers(cx, cy, cx, cy)), None)


# --- one leaf ----------------------------------------------------------------------

def to_utm(lons: Sequence[float], lats: Sequence[float], crs: str = 'EPSG:25832') -> Tuple[np.ndarray, np.ndarray]:
    from rasterio.warp import transform
    xs, ys = transform('EPSG:4326', crs, list(lons), list(lats))
    return np.asarray(xs), np.asarray(ys)


def read_window(dom, dgm: Dgm1, outline: np.ndarray) -> Optional[Tuple[np.ndarray, np.ndarray, float, float]]:
    """The surface and the ground over the footprint's box plus MARGIN_M, on the GRID_M lattice, NaN for none;
    and the top-left corner (x, y) of the grid."""
    x0, y0 = outline.min(axis=0) - MARGIN_M
    x1, y1 = outline.max(axis=0) + MARGIN_M
    got = dom.read(x0, y0, x1, y1)
    if got is None:
        return None
    surf, gx0, gy1 = got
    if not np.isfinite(surf).any():
        return None
    rows, cols = np.indices(surf.shape)
    ground = dgm.heights((gx0 + (cols + 0.5) * GRID_M).ravel(), (gy1 - (rows + 0.5) * GRID_M).ravel())
    ground = ground.reshape(surf.shape)
    if not np.isfinite(ground).any():
        return None
    return surf, ground, gx0, gy1


def footprint_mask(outline: np.ndarray, holes: List[np.ndarray], shape: Tuple[int, int], gx0: float, gy1: float
                   ) -> Optional[np.ndarray]:
    try:
        poly = Polygon(outline, holes).buffer(-ERODE_M)
    except Exception:  # noqa: BLE001
        return None
    if poly.is_empty:
        poly = Polygon(outline)
    img = Image.new('L', (shape[1], shape[0]), 0)
    draw = ImageDraw.Draw(img)
    for p in list(getattr(poly, 'geoms', [poly])):
        draw.polygon([((x - gx0) / GRID_M - 0.5, (gy1 - y) / GRID_M - 0.5) for x, y in p.exterior.coords], fill=1)
        for hole in p.interiors:
            draw.polygon([((x - gx0) / GRID_M - 0.5, (gy1 - y) / GRID_M - 0.5) for x, y in hole.coords], fill=0)
    return np.asarray(img, dtype=bool)


def register(mask: np.ndarray, tall: np.ndarray) -> Tuple[int, int]:
    """The (columns, rows) shift that lays the footprint over the most standing structure.

    Among shifts within REGISTER_TIE of the best, the smallest: a roof that
    overhangs its walls covers the footprint over a plateau of shifts, and
    the middle of that plateau is where the walls are.
    """
    reach = int(round(REGISTER_REACH_M / GRID_M))
    n = mask.sum()
    if n == 0:
        return 0, 0
    scores = {}
    h, w = mask.shape
    ys, xs = np.nonzero(mask)
    for dy in range(-reach, reach + 1):
        for dx in range(-reach, reach + 1):
            yy, xx = ys + dy, xs + dx
            ok = (yy >= 0) & (yy < h) & (xx >= 0) & (xx < w)
            scores[(dx, dy)] = float(tall[yy[ok], xx[ok]].sum()) / n
    best = max(scores.values())
    if best - scores[(0, 0)] < REGISTER_MIN_GAIN:
        return 0, 0
    near = [k for k, v in scores.items() if v >= best - REGISTER_TIE]
    pts = np.array(near, dtype=float)
    # The middle of the plateau, snapped to the shift nearest it.
    mid = pts.mean(axis=0)
    k = near[int(np.argmin(((pts - mid) ** 2).sum(axis=1)))]
    return k


def fit_building(outline: np.ndarray, holes: List[np.ndarray], window: Tuple[np.ndarray, np.ndarray, float, float]
                 ) -> Optional[dict]:
    surf, ground, gx0, gy1 = window
    mask = footprint_mask(outline, holes, surf.shape, gx0, gy1)
    if mask is None:
        return None
    valid = np.isfinite(surf) & np.isfinite(ground)
    tall = valid & (surf - np.where(np.isfinite(ground), ground, 0) > MIN_STANDING_M)
    dx, dy = register(mask, tall)
    if dx or dy:
        shift = np.array([dx * GRID_M, -dy * GRID_M])
        outline = outline + shift
        holes = [hh + shift for hh in holes]
        mask = footprint_mask(outline, holes, surf.shape, gx0, gy1)
    sel = mask & valid
    rows, cols = np.nonzero(sel)
    if len(rows) < MIN_POINTS:
        return None
    px = gx0 + (cols + 0.5) * GRID_M
    py = gy1 - (rows + 0.5) * GRID_M
    h = surf[rows, cols].astype(np.float64)
    g_cells = ground[rows, cols]
    g = float(np.median(g_cells))
    standing = float(np.median(h - g_cells))
    if standing < MIN_STANDING_M:
        return {'absent': True, 'ground': g, 'points': len(h)}
    fit = fit_roof(outline, px, py, h)
    if fit is None:
        return None
    fit['ground'] = g
    fit['absent'] = False
    fit['shift'] = (dx * GRID_M, -dy * GRID_M)
    return fit


def points_path(x: int, y: int) -> str:
    return os.path.join(POINTS_DIR, str(LEAF_ZOOM), str(x), f'{y}.npz')


def load_points(x: int, y: int, signature: int) -> Optional[Dict[int, Tuple[np.ndarray, np.ndarray, float, float]]]:
    """The windows kept for a leaf, by OSM id, or None when there are none for this .bvr."""
    path = points_path(x, y)
    if not os.path.exists(path):
        return None
    try:
        with np.load(path) as z:
            if int(z['signature']) != signature or 'meta' not in z.files:
                return None
            ids, meta, starts = z['ids'], z['meta'], z['starts']
            surf, ground = z['surf'], z['ground']
    except (OSError, ValueError, KeyError):
        return None
    out = {}
    for i, bid in enumerate(ids.tolist()):
        a, b = starts[i], starts[i + 1]
        rows, cols = int(meta[i, 0]), int(meta[i, 1])
        base, gx0, gy1 = meta[i, 2], meta[i, 3], meta[i, 4]
        sv = surf[a:b].reshape(rows, cols).astype(np.float32)
        gv = ground[a:b].reshape(rows, cols).astype(np.float32)
        sv = np.where(sv == NODATA_CM, np.nan, sv / 100.0 + base)
        gv = np.where(gv == NODATA_CM, np.nan, gv / 100.0 + base)
        out[bid] = (sv.astype(np.float32), gv.astype(np.float32), float(gx0), float(gy1))
    return out


def save_points(x: int, y: int, signature: int, windows: Dict[int, Tuple[np.ndarray, np.ndarray, float, float]]) -> None:
    ids = sorted(windows)
    meta = np.zeros((len(ids), 5), dtype=np.float64)
    starts = np.zeros(len(ids) + 1, dtype=np.int64)
    surfs, grounds = [], []
    for i, bid in enumerate(ids):
        sv, gv, gx0, gy1 = windows[bid]
        both = np.concatenate([sv[np.isfinite(sv)], gv[np.isfinite(gv)]])
        base = float(np.floor(both.min())) if len(both) else 0.0
        enc = lambda a: np.where(np.isfinite(a), np.clip(np.round((a - base) * 100), -32767, 32767), NODATA_CM)  # noqa: E731
        surfs.append(enc(sv).astype(np.int16).ravel())
        grounds.append(enc(gv).astype(np.int16).ravel())
        meta[i] = (sv.shape[0], sv.shape[1], base, gx0, gy1)
        starts[i + 1] = starts[i] + sv.size
    path = points_path(x, y)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp.npz'
    np.savez_compressed(tmp, signature=np.int64(signature), ids=np.array(ids, dtype=np.int64), meta=meta, starts=starts,
                        surf=np.concatenate(surfs) if surfs else np.zeros(0, np.int16),
                        ground=np.concatenate(grounds) if grounds else np.zeros(0, np.int16))
    os.replace(tmp, path)


def measure_leaf(x: int, y: int) -> dict:
    t0 = time.time()
    bvr = planet_path(x, y, '.bvr')
    signature = crc32_file(bvr)
    cached = load_points(x, y, signature)
    read: Dict[int, Tuple[np.ndarray, np.ndarray, float, float]] = {}
    buildings: List[Building] = decode_bvr(open(bvr, 'rb').read())
    lons = [p[0] for b in buildings for r in b.rings for p in r]
    lats = [p[1] for b in buildings for r in b.rings for p in r]
    src = source_for(x, y)
    xs, ys = to_utm(lons, lats, src.crs) if lons else (np.zeros(0), np.zeros(0))
    # Nearby buildings read the same DOM blocks: go in order of km tile, then row.
    k = 0
    items = []
    for b in buildings:
        rings = []
        for r in b.rings:
            rings.append(np.stack([xs[k:k + len(r)], ys[k:k + len(r)]], axis=1))
            k += len(r)
        c = rings[0].mean(axis=0)
        items.append((int(c[0] // 1000), int(c[1] // 1000), -int(c[1] // 50), int(c[0] // 50), b, rings))
    items.sort(key=lambda it: it[:4])
    dom, dgm = src.dom(), src.dgm()
    records = []
    stats = {'leaf': (x, y), 'buildings': len(buildings), 'measured': 0, 'absent': 0, 'unfit': 0, 'formSure': 0,
             'forms': {}, 'byKind': {}}
    for _ix, _iy, _r, _c, b, rings in items:
        try:
            if cached is not None:
                win = cached.get(b.osm_id)
            else:
                win = read_window(dom, dgm, rings[0])
                if win is not None:
                    read[b.osm_id] = win
            m = fit_building(rings[0], rings[1:], win) if win is not None else None
        except Exception as ex:  # noqa: BLE001 - one building's failure is counted, the rest go on
            m = None
            stats.setdefault('errors', []).append(repr(ex)[:120])
        if m is None:
            stats['unfit'] += 1
            continue
        if m['absent']:
            stats['absent'] += 1
            records.append((b.osm_id, 0, FLAG_ABSENT, 0, 0, 0, 0, 0, min(65535, m['points'])))
            continue
        eave = max(0.0, m['eave'] - m['ground'])
        ridge = max(eave, m['ridge'] - m['ground'])
        # The heights' confidence: image-matched surfaces carry 0.3-0.5 m of
        # noise on a clean roof, dormers and chimneys more, so the error is
        # scored from 0.3 m (sure) to 2 m (useless).
        conf = max(0.0, min(1.0, (1.0 - (m['rmse'] - 0.3) / 1.7) * min(1.0, m['kept'] / 0.6)
                                * min(1.0, m['points'] / 60)))
        flags = FLAG_FORM_SURE if m['bicGap'] >= FORM_SURE_BIC else 0
        stats['formSure'] += 1 if flags else 0
        records.append((b.osm_id, m['form'], flags, int(round(m['azimuth'] * 100)) % 36000,
                        min(65535, int(round(eave * 100))), min(65535, int(round(ridge * 100))),
                        min(65535, int(round(m['rmse'] * 100))), int(round(conf * 255)), min(65535, m['points'])))
        stats['measured'] += 1
        name = FORM_NAMES[m['form']]
        stats['forms'][name] = stats['forms'].get(name, 0) + 1
        stats['byKind'].setdefault(b.kind, []).append((eave, ridge, m['form'], conf))
    if cached is None:
        save_points(x, y, signature, read)
    write_store(x, y, signature, records)
    stats['seconds'] = time.time() - t0
    return stats


def encode_bhs(signature: int, records) -> bytes:
    parts = [_BHS_HEAD.pack(BHS_MAGIC, BHS_VERSION, 0, 0, signature, len(records))]
    parts.extend(_BHS_REC.pack(*r) for r in sorted(records))
    return zlib.compress(b''.join(parts), 6)


def decode_bhs(blob: bytes) -> Tuple[int, List[tuple]]:
    data = zlib.decompress(blob)
    magic, version, _a, _b, signature, count = _BHS_HEAD.unpack_from(data, 0)
    if magic != BHS_MAGIC or version != BHS_VERSION:
        raise ValueError('not a BHS1 file')
    return signature, [_BHS_REC.unpack_from(data, _BHS_HEAD.size + i * _BHS_REC.size) for i in range(count)]


def write_store(x: int, y: int, signature: int, records) -> None:
    path = store_path(x, y)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as fh:
        fh.write(encode_bhs(signature, records))
    os.replace(tmp, path)


def up_to_date(x: int, y: int) -> bool:
    path = store_path(x, y)
    if not os.path.exists(path):
        return False
    try:
        signature, _ = decode_bhs(open(path, 'rb').read())
    except (OSError, ValueError, zlib.error, struct.error):
        return False
    return signature == crc32_file(planet_path(x, y, '.bvr'))


def leaves_in(bbox: Sequence[float]) -> List[Tuple[int, int]]:
    span = 180.0 / (1 << LEAF_ZOOM)
    w, s, e, n = bbox
    x0, x1 = int(math.floor((w + 180) / span)), int(math.floor((e + 180) / span))
    y0, y1 = int(math.floor((90 - n) / span)), int(math.floor((90 - s) / span))
    out = []
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if os.path.exists(planet_path(x, y, '.bvr')) and source_for(x, y) is not None:
                out.append((x, y))
    return out


KIND_NAMES = {0: 'yes', 1: 'house', 2: 'residential', 3: 'small', 4: 'farm', 5: 'greenhouse', 6: 'industrial',
              7: 'commercial', 8: 'civic', 9: 'religious', 10: 'roof', 11: 'tower', 12: 'tank', 13: 'ruin'}


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--bbox', help='west,south,east,north')
    ap.add_argument('--leaf', help='x,y of one z12 leaf')
    ap.add_argument('--force', action='store_true', help='measure leaves already up to date')
    ap.add_argument('--refit', action='store_true',
                    help='fit again every leaf whose points are kept (no network); implies --force')
    ap.add_argument('--jobs', type=int, default=max(1, min(6, (os.cpu_count() or 2) - 1)))
    args = ap.parse_args(argv)
    if args.refit:
        args.force = True
    if args.leaf:
        leaves = [tuple(int(v) for v in args.leaf.split(','))]
    elif args.bbox:
        leaves = leaves_in([float(v) for v in args.bbox.split(',')])
    else:
        ap.error('give --bbox or --leaf')
    todo = [k for k in leaves if args.force or not up_to_date(*k)]
    print(f'measure_roof_shapes: {len(leaves)} leaves with buildings, {len(todo)} to measure', flush=True)
    t0 = time.time()
    tot = {'buildings': 0, 'measured': 0, 'absent': 0, 'unfit': 0, 'formSure': 0}
    forms: Dict[str, int] = {}
    by_kind: Dict[int, list] = {}
    errors: List[str] = []
    failed = 0
    done = 0
    with ProcessPoolExecutor(max(1, args.jobs)) as pool:
        futures = {pool.submit(measure_leaf, x, y): (x, y) for x, y in todo}
        for f in as_completed(futures):
            x, y = futures[f]
            try:
                r = f.result()
            except Exception as ex:  # noqa: BLE001 - one leaf's failure is logged, the rest go on
                failed += 1
                print(f'  leaf {x}/{y} failed: {ex!r}', flush=True)
                continue
            done += 1
            for k in tot:
                tot[k] += r[k]
            for name, v in r['forms'].items():
                forms[name] = forms.get(name, 0) + v
            for kind, v in r['byKind'].items():
                by_kind.setdefault(kind, []).extend(v)
            errors.extend(r.get('errors', []))
            print(f'  {done}/{len(todo)} {x}/{y}: {r["measured"]}/{r["buildings"]} fitted, {r["absent"]} absent, '
                  f'{r["seconds"]:.0f} s', flush=True)
    print(f'measure_roof_shapes: {tot["measured"]}/{tot["buildings"]} fitted ({tot["formSure"]} with the form sure), '
          f'{tot["absent"]} not in the surface model, '
          f'{tot["unfit"]} unfit; {failed} leaves failed; {(time.time() - t0) / 60:.1f} min', flush=True)
    print('  forms: ' + ', '.join(f'{k} {v}' for k, v in sorted(forms.items(), key=lambda kv: -kv[1])))
    print('  by kind (confident fits): eave median / ridge median, share flat')
    for kind, v in sorted(by_kind.items(), key=lambda kv: -len(kv[1])):
        good = [e for e in v if e[3] >= 0.4]
        if len(good) < 5:
            continue
        ea = np.median([e[0] for e in good])
        ri = np.median([e[1] for e in good])
        flat = np.mean([e[2] == FLAT for e in good])
        print(f'    {KIND_NAMES.get(kind, kind):12s} n={len(good):5d}  eave {ea:5.1f} m  ridge {ri:5.1f} m  flat {flat:4.0%}')
    if errors:
        print(f'  {len(errors)} building errors, e.g. {errors[0]}')
    return 1 if failed else 0


if __name__ == '__main__':
    code = main()
    sys.stdout.flush()
    os._exit(code)

#!/usr/bin/env python3
"""Measure every building's roof colour in open orthophotos (phase 2 of docs/terrain-buildings.md).

Per z12 leaf with OSM footprints (.bvr, tools/bake_osm_buildings.py): the
orthophoto is fetched in blocks of BLOCK_PX pixels at RES_M, only where
buildings are, and each building's roof colour is read off it. Only the
answers are kept - no raster - in the building colour store (BCS1,
data/imports/buildings/store/12/x/y.bcs), keyed by OSM id, which
tools/bake_planet_buildings.ts reads. A leaf whose .bvr has not changed
since it was measured is skipped, so a re-run resumes.

Per block:

  colour balance  mosaics shift white balance from flight strip to flight
                  strip. The asphalt under the OSM roads (the leaf's .rvr)
                  is close to neutral grey, so its mean colour gives the
                  block's channel gains, applied at half strength (square
                  root) and clamped to GAIN_RANGE.
  registration    an orthophoto is not a true ortho: a roof leans away from
                  the image's nadir by its height times the tangent of the
                  view angle, metres at the edge of a frame. The block's
                  footprint outlines are cross-correlated with the image's
                  gradient magnitude over +-BLOCK_SHIFT_M; each building then
                  refines that by +-BUILDING_SHIFT_M on its own outline.
  haze            an orthophoto is shot through kilometres of air, which
                  lays a grey veil over everything: the deepest shadows of a
                  block read ~45/255 where they are near black. The veil is
                  the block's VEIL_PERCENTILE darkest value of its darkest
                  channel, less VEIL_FLOOR, taken off all three channels
                  alike (the darkest pixels are green tree shade, so a per-
                  channel veil would tint every roof magenta) and the range
                  stretched back to 255. A clay roof goes from (156, 115, 93)
                  to about (141, 93, 68).
  sampling        the footprint shrunk by ERODE_M, less vegetation (an
                  overhanging crown); the median colour in CIELAB of the
                  pixels in the KEEP_BAND of brightness - both halves of a
                  gable, the way a level surface would read, which is what
                  the game's own lighting expects, with cast shadows and
                  skylights cut off at either end.

Sources: Bavaria's DOP40 (40 cm, CC BY 4.0, "Datenquelle: Bayerische
Vermessungsverwaltung - www.geodaten.bayern.de"). Outside a source the WMS
answers white, which reads as no data. More sources (basemap.at,
SWISSIMAGE, the other German states) slot into SOURCES.

The last source is the fallback that covers everywhere: Sentinel-2 L2A true
colour at 10 m (Sentinel2 below). A roof is one to a few pixels of it, mixed
with whatever lies beside the roof, so it takes none of the fine steps above
(no registration, no haze, no asphalt balance - L2A is already surface
reflectance) and instead reads the pixels under the footprint weighted by
their cover. Its confidence is capped at COARSE_MAX_CONFIDENCE and falls with
the roof's size, so the bake (MIN_ROOF_CONFIDENCE) takes it only for roofs of
about 70 m2 and up: warehouses, blocks, halls. Smaller roofs keep their rule
colour rather than a blend of the street.

Usage::

    python tools/measure_buildings.py --bbox 11.03,47.46,11.17,47.60 [--jobs 4]
    python tools/measure_buildings.py --leaf 4173,1035 --force
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import math
import os
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import MultiPolygon, Polygon

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_osm_buildings import Building, building_centroid, decode_bvr  # noqa: E402
from bake_osm_roads import decode_rvr  # noqa: E402

LEAF_ZOOM = 12
PLANET_DIR = 'assets/planet'
STORE_DIR = 'data/imports/buildings/store'
CACHE_DIR = 'data/imports/ortho/.cache'
USER_AGENT = 'retroflightsim-terrain-bake (roof colour sampler)'

# Keep in step with tools/bake/buildingColourStore.ts.
BCS_MAGIC = b'BCS1'
# 2: colours with the haze taken out (version 1 had none).
BCS_VERSION = 2
_BCS_HEAD = struct.Struct('<4sBBHII')  # magic, version, reserved, reserved, bvr signature, count
_BCS_REC = struct.Struct('<qBBBBBBbb')  # id, r, g, b, confidence, source, pixels/8, dx, dy (SHIFT_STEP_M)
SHIFT_STEP_M = 0.25

RES_M = 0.5
BLOCK_PX = 2048
MARGIN_M = 40.0
BLOCK_SHIFT_M = 6.0
BUILDING_SHIFT_M = 1.5
ERODE_M = 1.0
MIN_PIXELS = 8
KEEP_BAND = (15.0, 85.0)
VEIL_PERCENTILE = 0.5
VEIL_FLOOR = 8.0
GAIN_RANGE = (0.85, 1.18)
MIN_ROAD_PIXELS = 400

# The Sentinel-2 fallback: confidence ceiling, supersampling of a footprint, and
# which scenes to read (the same summer window as the ground cover).
COARSE_MAX_CONFIDENCE = 0.5
COARSE_SUPERSAMPLE = 4
SCENE_CELL_DEG = 0.25
SCENE_START, SCENE_END, SCENE_MAX_CLOUD = '2023-06-01', '2023-08-31', 10.0

M_PER_DEG_LAT = 111132.92


def m_per_deg_lon(lat: float) -> float:
    return 111412.84 * math.cos(math.radians(lat))


def tile_bounds(z: int, x: int, y: int) -> Tuple[float, float, float, float]:
    span = 180.0 / (1 << z)
    west = -180.0 + x * span
    north = 90.0 - y * span
    return west, north - span, west + span, north


def planet_path(x: int, y: int, ext: str) -> str:
    return os.path.join(PLANET_DIR, str(LEAF_ZOOM), str(x), f'{y}{ext}')


def store_path(x: int, y: int) -> str:
    return os.path.join(STORE_DIR, str(LEAF_ZOOM), str(x), f'{y}.bcs')


def crc32_file(path: str) -> int:
    with open(path, 'rb') as fh:
        return zlib.crc32(fh.read()) & 0xFFFFFFFF


def leaf_buildings(x: int, y: int) -> Tuple[List[Building], int]:
    """The leaf's OSM buildings (.bvr) and those only LoD2 has (.bvl, tools/import_lod2.py), and one
    crc32 over both files: a leaf is measured again when either changes."""
    blobs = [open(planet_path(x, y, ext), 'rb').read() for ext in ('.bvr', '.bvl')
             if os.path.exists(planet_path(x, y, ext))]
    buildings: List[Building] = []
    crc = 0
    for blob in blobs:
        buildings.extend(decode_bvr(blob))
        crc = zlib.crc32(blob, crc)
    return buildings, crc & 0xFFFFFFFF


# --- sources -------------------------------------------------------------------

def http_get(url: str, timeout: float = 120.0, tries: int = 4) -> Optional[bytes]:
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


class Source:
    id = 0
    name = ''
    # A coarse lon/lat box; outside it the source is not asked at all.
    box = (0.0, 0.0, 0.0, 0.0)
    # Ground size of a pixel for a source that is coarser than the roofs it
    # colours; None for the orthophotos, which are read at RES_M.
    res_m: Optional[float] = None

    def covers(self, w: float, s: float, e: float, n: float) -> bool:
        bw, bs, be, bn = self.box
        return not (e < bw or w > be or n < bs or s > bn)

    def fetch(self, w: float, s: float, e: float, n: float, width: int, height: int) -> Tuple[Optional[np.ndarray], bool]:
        """The block as HxWx3 uint8, north up, and whether it came from the cache."""
        raise NotImplementedError


class WmsSource(Source):
    url = ''
    layer = ''

    def fetch(self, w, s, e, n, width, height):
        # WMS 1.3.0 in EPSG:4326 takes latitude first.
        params = {
            'SERVICE': 'WMS', 'REQUEST': 'GetMap', 'VERSION': '1.3.0', 'LAYERS': self.layer, 'STYLES': '',
            'CRS': 'EPSG:4326', 'BBOX': f'{s:.8f},{w:.8f},{n:.8f},{e:.8f}',
            'WIDTH': str(width), 'HEIGHT': str(height), 'FORMAT': 'image/jpeg',
        }
        url = f'{self.url}?{urllib.parse.urlencode(params)}'
        key = hashlib.sha1(url.encode()).hexdigest()[:20]
        path = os.path.join(CACHE_DIR, self.name, key[:2], f'{key}.jpg')
        hit = os.path.exists(path)
        if hit:
            with open(path, 'rb') as fh:
                data = fh.read()
        else:
            data = http_get(url)
            if data is None or data[:2] != b'\xff\xd8':
                return None, False
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + '.tmp'
            with open(tmp, 'wb') as fh:
                fh.write(data)
            os.replace(tmp, path)
        img = np.asarray(Image.open(io.BytesIO(data)).convert('RGB'))
        return img, hit


class Bavaria(WmsSource):
    """Bayerische Vermessungsverwaltung DOP40, 40 cm (CC BY 4.0)."""
    id = 1
    name = 'bavaria-dop40'
    box = (8.9, 47.2, 13.9, 50.6)
    url = 'https://geoservices.bayern.de/od/wms/dop/v1/dop40'
    layer = 'by_dop40c'


class BrandenburgBerlin(WmsSource):
    """LGB DOP20c, 20 cm, Brandenburg with Berlin (dl-de/by-2-0, "© GeoBasis-DE/LGB;
    © Geoportal Berlin"). Outside the two states it answers white, like Bavaria's."""
    id = 2
    name = 'brandenburg-berlin-dop20'
    box = (11.2, 51.3, 14.8, 53.6)
    url = 'https://isk.geobasis-bb.de/mapproxy/dop20c/service/wms'
    layer = 'bebb_dop20c'


class Sentinel2(Source):
    """Sentinel-2 L2A true colour, 10 m, the fallback anywhere no orthophoto is wired.

    Contains modified Copernicus Sentinel data. The least cloudy summer scene
    of each MGRS square, found through Earth Search and read as COG windows
    (tools/fetch_cover_sources.py does the same for the ground cover)."""
    id = 3
    name = 'sentinel2-l2a'
    box = (-180.0, -90.0, 180.0, 90.0)
    res_m = 10.0

    _cells: Dict[Tuple[int, int], List[str]] = {}

    def _scenes(self, w: float, s: float, e: float, n: float) -> List[str]:
        import json
        import fetch_cover_sources as fcs
        cx = int(math.floor(((w + e) / 2) / SCENE_CELL_DEG))
        cy = int(math.floor(((s + n) / 2) / SCENE_CELL_DEG))
        if (cx, cy) in self._cells:
            return self._cells[(cx, cy)]
        path = os.path.join(CACHE_DIR, self.name, 'scenes', f'{cx}_{cy}.json')
        if os.path.exists(path):
            with open(path, encoding='utf-8') as fh:
                hrefs = json.load(fh)
        else:
            pad = 0.02
            cell = (cx * SCENE_CELL_DEG - pad, cy * SCENE_CELL_DEG - pad,
                    (cx + 1) * SCENE_CELL_DEG + pad, (cy + 1) * SCENE_CELL_DEG + pad)
            with contextlib.redirect_stdout(io.StringIO()):
                hrefs = fcs.find_scenes(cell, SCENE_START, SCENE_END, SCENE_MAX_CLOUD, 12)
            if hrefs:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, 'w', encoding='utf-8') as fh:
                    json.dump(hrefs, fh)
        self._cells[(cx, cy)] = hrefs
        return hrefs

    def fetch(self, w, s, e, n, width, height):
        import fetch_cover_sources as fcs
        from rasterio.enums import Resampling
        from rasterio.transform import from_origin
        key = hashlib.sha1(f'{w:.7f},{s:.7f},{e:.7f},{n:.7f},{width},{height}'.encode()).hexdigest()[:20]
        path = os.path.join(CACHE_DIR, self.name, key[:2], f'{key}.npy')
        if os.path.exists(path):
            try:
                return np.load(path), True
            except (OSError, ValueError):
                pass
        hrefs = self._scenes(w, s, e, n)
        if not hrefs:
            return None, False
        transform = from_origin(w, n, (e - w) / width, (n - s) / height)
        out = np.zeros((3, height, width), dtype=np.uint8)
        fcs._worker_pool(4)
        with contextlib.redirect_stdout(io.StringIO()):
            used = fcs.mosaic_into(out, transform, [fcs.vsicurl(h) for h in hrefs], [1, 2, 3],
                                   Resampling.bilinear, nodata=0, target_m=self.res_m, jobs=4)
        if used == 0:
            return None, False
        img = np.ascontiguousarray(np.moveaxis(out, 0, -1))
        # Pixels no scene reached read as white, which no_data() already treats as missing.
        img[~np.any(img != 0, axis=2)] = 255
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + '.tmp.npy'
        np.save(tmp, img)
        os.replace(tmp, path)
        return img, False


SOURCES: List[Source] = [Bavaria(), BrandenburgBerlin(), Sentinel2()]
SOURCE_NAMES = {s.id: s.name for s in SOURCES}


# --- colour --------------------------------------------------------------------

def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    c = rgb / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], axis=1)


def lab_to_srgb(lab: np.ndarray) -> np.ndarray:
    fy = (lab[..., 0] + 16) / 116
    fx = fy + lab[..., 1] / 500
    fz = fy - lab[..., 2] / 200
    f = np.stack([fx, fy, fz], axis=-1)
    xyz = np.where(f ** 3 > 216 / 24389, f ** 3, (116 * f - 16) / (24389 / 27)) * np.array([0.95047, 1.0, 1.08883])
    m = np.array([[3.2404542, -1.5371385, -0.4985314],
                  [-0.9692660, 1.8760108, 0.0415560],
                  [0.0556434, -0.2040259, 1.0572252]])
    lin = np.clip(xyz @ m.T, 0, 1)
    c = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)
    return np.clip(np.round(c * 255), 0, 255)


def luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def vegetation(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return (2 * g - r - b > 20) & (g > r)


def no_data(rgb: np.ndarray) -> np.ndarray:
    return (rgb[..., 0] >= 254) & (rgb[..., 1] >= 254) & (rgb[..., 2] >= 254)


# --- one block -------------------------------------------------------------------

class Block:
    """An orthophoto block and the lon/lat -> pixel mapping of it."""

    def __init__(self, img: np.ndarray, w: float, n: float, dlon: float, dlat: float, coarse: bool = False):
        self.coarse = coarse
        self.img = img.astype(np.float32)
        self.w, self.n, self.dlon, self.dlat = w, n, dlon, dlat
        self.h, self.wpx = img.shape[0], img.shape[1]

    def px(self, lon: float, lat: float) -> Tuple[float, float]:
        return (lon - self.w) / self.dlon, (self.n - lat) / self.dlat


def haze_veil(block: Block) -> float:
    """The grey the air adds to every pixel of the block, in 0..255 (see the module notes)."""
    rgb = block.img.reshape(-1, 3)
    rgb = rgb[~no_data(rgb)]
    if len(rgb) < 1000:
        return 0.0
    dark = np.percentile(rgb, VEIL_PERCENTILE, axis=0).min()
    return float(max(0.0, min(80.0, dark - VEIL_FLOOR)))


def channel_gains(block: Block, roads) -> Tuple[np.ndarray, int]:
    """Per-channel gains that turn the asphalt under the block's roads neutral grey."""
    mask = Image.new('L', (block.wpx, block.h), 0)
    draw = ImageDraw.Draw(mask)
    for cls, width, pts in roads:
        if cls > 6 or len(pts) < 2:
            continue
        line = [block.px(lon, lat) for lon, lat in pts]
        draw.line(line, fill=1, width=max(2, int(round(width * 0.5 / RES_M))))
    sel = np.asarray(mask, dtype=bool)
    rgb = block.img[sel]
    rgb = rgb[~vegetation(rgb) & ~no_data(rgb)]
    if len(rgb) < MIN_ROAD_PIXELS:
        return np.ones(3, dtype=np.float32), len(rgb)
    lum = luminance(rgb)
    lo, hi = np.percentile(lum, [20, 80])
    rgb = rgb[(lum >= lo) & (lum <= hi)]
    if len(rgb) < MIN_ROAD_PIXELS // 2:
        return np.ones(3, dtype=np.float32), len(rgb)
    mean = rgb.mean(axis=0)
    # Half strength: weathered asphalt is itself a little warm, and the full
    # correction turned every tile roof pink.
    gains = np.clip(np.sqrt(mean.mean() / np.maximum(mean, 1.0)), *GAIN_RANGE).astype(np.float32)
    return gains, len(rgb)


def gradient(lum: np.ndarray) -> np.ndarray:
    g = np.zeros_like(lum)
    gx = lum[1:-1, 2:] - lum[1:-1, :-2]
    gy = lum[2:, 1:-1] - lum[:-2, 1:-1]
    g[1:-1, 1:-1] = np.hypot(gx, gy)
    return g


def block_shift(grad: np.ndarray, rings_px: List[List[Tuple[float, float]]], reach_px: int) -> Tuple[int, int, float]:
    """The (dx, dy) that best lays the outlines on the image's edges, and how much better than none."""
    edges = Image.new('L', (grad.shape[1], grad.shape[0]), 0)
    draw = ImageDraw.Draw(edges)
    for ring in rings_px:
        if len(ring) >= 2:
            draw.line(ring + [ring[0]], fill=1, width=1)
    e = np.asarray(edges, dtype=np.float32)
    if e.sum() < 50:
        return 0, 0, 0.0
    g = grad - grad.mean()
    e = e - e.mean()
    corr = np.fft.irfft2(np.fft.rfft2(g) * np.conj(np.fft.rfft2(e)), s=g.shape)
    best, bx, by = -np.inf, 0, 0
    for dy in range(-reach_px, reach_px + 1):
        for dx in range(-reach_px, reach_px + 1):
            v = corr[dy % corr.shape[0], dx % corr.shape[1]]
            if v > best:
                best, bx, by = v, dx, dy
    zero = corr[0, 0]
    return bx, by, float((best - zero) / max(abs(zero), 1e-6))


def outline_points(rings_px: List[List[Tuple[float, float]]]) -> np.ndarray:
    pts = []
    for ring in rings_px:
        for i in range(len(ring)):
            (x0, y0), (x1, y1) = ring[i], ring[(i + 1) % len(ring)]
            n = max(1, int(math.hypot(x1 - x0, y1 - y0)))
            for k in range(n):
                t = k / n
                pts.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    return np.asarray(pts, dtype=np.float32)


def outline_score(grad: np.ndarray, pts: np.ndarray, dx: float, dy: float) -> float:
    xs = np.clip(np.round(pts[:, 0] + dx).astype(np.int64), 0, grad.shape[1] - 1)
    ys = np.clip(np.round(pts[:, 1] + dy).astype(np.int64), 0, grad.shape[0] - 1)
    return float(grad[ys, xs].mean())


def rasterise(poly, x0: int, y0: int, w: int, h: int) -> np.ndarray:
    img = Image.new('L', (w, h), 0)
    draw = ImageDraw.Draw(img)
    parts = list(poly.geoms) if isinstance(poly, MultiPolygon) else [poly]
    for p in parts:
        if p.is_empty:
            continue
        draw.polygon([(x - x0, y - y0) for x, y in p.exterior.coords], fill=1)
        for hole in p.interiors:
            draw.polygon([(x - x0, y - y0) for x, y in hole.coords], fill=0)
    return np.asarray(img, dtype=bool)


def sample_roof(block: Block, gains: np.ndarray, veil: float, rings_px: List[List[Tuple[float, float]]]
                ) -> Optional[Tuple[np.ndarray, float, int]]:
    """(sRGB colour, confidence 0..1, pixels used) of one roof, or None."""
    try:
        poly = Polygon(rings_px[0], rings_px[1:])
        if not poly.is_valid:
            poly = poly.buffer(0)
    except Exception:  # noqa: BLE001 - a broken outline is skipped, not fatal
        return None
    shrunk = poly.buffer(-ERODE_M / RES_M)
    if shrunk.is_empty or shrunk.area < MIN_PIXELS * 2:
        shrunk = poly.buffer(-0.5 * ERODE_M / RES_M)
    if shrunk.is_empty or shrunk.area < MIN_PIXELS:
        return None
    minx, miny, maxx, maxy = shrunk.bounds
    x0, y0 = max(0, int(math.floor(minx))), max(0, int(math.floor(miny)))
    x1, y1 = min(block.wpx, int(math.ceil(maxx)) + 1), min(block.h, int(math.ceil(maxy)) + 1)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    mask = rasterise(shrunk, x0, y0, x1 - x0, y1 - y0)
    rgb = block.img[y0:y1, x0:x1][mask]
    total = len(rgb)
    if total < MIN_PIXELS:
        return None
    if no_data(rgb).mean() > 0.5:
        return None
    rgb = rgb[~vegetation(rgb)]
    if len(rgb) < MIN_PIXELS:
        return None
    rgb = np.clip((rgb * gains - veil) / (1.0 - veil / 255.0), 0, 255)
    lum = luminance(rgb)
    lo, hi = np.percentile(lum, KEEP_BAND)
    rgb = rgb[(lum >= lo) & (lum <= hi)]
    if len(rgb) < MIN_PIXELS // 2:
        return None
    lab = srgb_to_lab(rgb.astype(np.float64))
    med = np.median(lab, axis=0)
    spread = float(np.median(np.abs(lab[:, 1:] - med[1:])))
    kept = len(rgb) / total
    confidence = min(1.0, len(rgb) / 40.0) * min(1.0, kept * 3.0) * max(0.0, 1.0 - spread / 20.0)
    return lab_to_srgb(med), confidence, len(rgb)


def sample_coarse(block: Block, rings_px: List[List[Tuple[float, float]]]
                  ) -> Optional[Tuple[np.ndarray, float, int]]:
    """(sRGB colour, confidence 0..1, pixels touched) of one roof in a coarse block, or None.

    Each pixel the footprint touches counts by the share of it the footprint
    covers; green pixels (a garden, a tree beside the house) are left out."""
    from shapely import affinity
    try:
        poly = Polygon(rings_px[0], rings_px[1:])
        if not poly.is_valid:
            poly = poly.buffer(0)
    except Exception:  # noqa: BLE001 - a broken outline is skipped, not fatal
        return None
    if poly.is_empty:
        return None
    minx, miny, maxx, maxy = poly.bounds
    x0, y0 = max(0, int(math.floor(minx))), max(0, int(math.floor(miny)))
    x1, y1 = min(block.wpx, int(math.ceil(maxx))), min(block.h, int(math.ceil(maxy)))
    if x1 <= x0 or y1 <= y0:
        return None
    ss = COARSE_SUPERSAMPLE
    big = affinity.scale(poly, xfact=ss, yfact=ss, origin=(0, 0))
    mask = rasterise(big, x0 * ss, y0 * ss, (x1 - x0) * ss, (y1 - y0) * ss)
    cover = mask.reshape(y1 - y0, ss, x1 - x0, ss).mean(axis=(1, 3))
    rgb = block.img[y0:y1, x0:x1]
    live = (cover > 0) & ~no_data(rgb)
    total = float(cover[live].sum())
    if total <= 0:
        return None
    live &= ~vegetation(rgb)
    kept = float(cover[live].sum())
    if kept <= 0:
        return None
    wts = cover[live]
    lab = srgb_to_lab(rgb[live].astype(np.float64))
    mean = (lab * wts[:, None]).sum(axis=0) / wts.sum()
    confidence = COARSE_MAX_CONFIDENCE * min(1.0, kept) * (kept / total)
    return lab_to_srgb(mean), confidence, int(live.sum())


# --- one leaf ----------------------------------------------------------------------

def measure_leaf(x: int, y: int) -> dict:
    t0 = time.time()
    buildings, signature = leaf_buildings(x, y)
    roads = decode_rvr(open(planet_path(x, y, '.rvr'), 'rb').read()) if os.path.exists(planet_path(x, y, '.rvr')) else []
    w, s, e, n = tile_bounds(LEAF_ZOOM, x, y)
    lat_c = (s + n) / 2
    dlat = RES_M / M_PER_DEG_LAT
    dlon = RES_M / m_per_deg_lon(lat_c)
    blk_lon, blk_lat = BLOCK_PX * dlon, BLOCK_PX * dlat
    by_block: Dict[Tuple[int, int], List[Building]] = {}
    for b in buildings:
        lon, lat = building_centroid(b)
        key = (int(math.floor((lon - w) / blk_lon)), int(math.floor((n - lat) / blk_lat)))
        by_block.setdefault(key, []).append(b)

    stats = {'leaf': (x, y), 'buildings': len(buildings), 'measured': 0, 'noData': 0, 'tooSmall': 0,
             'blocks': 0, 'cacheHits': 0, 'downloadedMB': 0.0, 'shiftM': [], 'gains': [], 'veil': []}
    records: List[Tuple[int, int, int, int, int, int, int, int, int]] = []
    margin_lon, margin_lat = MARGIN_M / m_per_deg_lon(lat_c), MARGIN_M / M_PER_DEG_LAT

    def fetch(key):
        bi, bj = key
        bw, bn = w + bi * blk_lon - margin_lon, n - bj * blk_lat + margin_lat
        be, bs = bw + blk_lon + 2 * margin_lon, bn - blk_lat - 2 * margin_lat
        for src in SOURCES:
            if not src.covers(bw, bs, be, bn):
                continue
            # The same ground at the source's own pixel size: the 2208 px of
            # the orthophotos, or about 110 for a 10 m source.
            size = int(math.ceil((BLOCK_PX * RES_M + 2 * MARGIN_M) / (src.res_m or RES_M)))
            img, hit = src.fetch(bw, bs, be, bn, size, size)
            if img is not None and no_data(img).mean() < 0.98:
                return key, src, Block(img, bw, bn, (be - bw) / size, (bn - bs) / size,
                                       coarse=src.res_m is not None), hit
        return key, None, None, False

    with ThreadPoolExecutor(4) as pool:
        for key, src, block, hit in pool.map(fetch, sorted(by_block)):
            members = by_block[key]
            if block is None:
                stats['noData'] += len(members)
                continue
            stats['blocks'] += 1
            stats['cacheHits'] += 1 if hit else 0
            if block.coarse:
                for b in members:
                    got = sample_coarse(block, [[block.px(lon, lat) for lon, lat in r] for r in b.rings])
                    if got is None:
                        stats['tooSmall'] += 1
                        continue
                    rgb, conf, npx = got
                    stats['measured'] += 1
                    records.append((b.osm_id, int(rgb[0]), int(rgb[1]), int(rgb[2]),
                                    int(round(conf * 255)), src.id, min(255, npx), 0, 0))
                continue
            gains, _road_px = channel_gains(block, roads)
            veil = haze_veil(block)
            stats['gains'].append(gains.tolist())
            stats['veil'].append(veil)
            grad = gradient(luminance(block.img))
            rings = {id(b): [[block.px(lon, lat) for lon, lat in r] for r in b.rings] for b in members}
            reach = int(round(BLOCK_SHIFT_M / RES_M))
            bdx, bdy, _gain = block_shift(grad, [r for b in members for r in rings[id(b)]], reach)
            fine = int(round(BUILDING_SHIFT_M / RES_M))
            for b in members:
                rp = rings[id(b)]
                pts = outline_points(rp)
                best = (outline_score(grad, pts, bdx, bdy), bdx, bdy)
                for ey in range(-fine, fine + 1):
                    for ex in range(-fine, fine + 1):
                        sc = outline_score(grad, pts, bdx + ex, bdy + ey)
                        if sc > best[0] * 1.05:
                            best = (sc, bdx + ex, bdy + ey)
                _sc, dx, dy = best
                shifted = [[(px + dx, py + dy) for px, py in r] for r in rp]
                got = sample_roof(block, gains, veil, shifted)
                if got is None:
                    stats['tooSmall'] += 1
                    continue
                rgb, conf, npx = got
                stats['measured'] += 1
                stats['shiftM'].append(math.hypot(dx, dy) * RES_M)
                q = lambda v: max(-127, min(127, int(round(v * RES_M / SHIFT_STEP_M))))  # noqa: E731
                records.append((b.osm_id, int(rgb[0]), int(rgb[1]), int(rgb[2]),
                                int(round(conf * 255)), src.id, min(255, npx // 8), q(dx), q(-dy)))

    write_store(x, y, signature, records)
    stats['seconds'] = time.time() - t0
    return stats


def encode_bcs(signature: int, records) -> bytes:
    parts = [_BCS_HEAD.pack(BCS_MAGIC, BCS_VERSION, 0, 0, signature, len(records))]
    parts.extend(_BCS_REC.pack(*r) for r in sorted(records))
    return zlib.compress(b''.join(parts), 6)


def decode_bcs(blob: bytes) -> Tuple[int, List[tuple]]:
    data = zlib.decompress(blob)
    magic, version, _a, _b, signature, count = _BCS_HEAD.unpack_from(data, 0)
    if magic != BCS_MAGIC or version != BCS_VERSION:
        raise ValueError('not a BCS1 file')
    return signature, [_BCS_REC.unpack_from(data, _BCS_HEAD.size + i * _BCS_REC.size) for i in range(count)]


def write_store(x: int, y: int, signature: int, records) -> None:
    path = store_path(x, y)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as fh:
        fh.write(encode_bcs(signature, records))
    os.replace(tmp, path)


def up_to_date(x: int, y: int) -> bool:
    path = store_path(x, y)
    if not os.path.exists(path):
        return False
    try:
        signature, _ = decode_bcs(open(path, 'rb').read())
    except (OSError, ValueError, zlib.error, struct.error):
        return False
    return signature == leaf_buildings(x, y)[1]


def leaves_in(bbox: Sequence[float]) -> List[Tuple[int, int]]:
    span = 180.0 / (1 << LEAF_ZOOM)
    w, s, e, n = bbox
    x0, x1 = int(math.floor((w + 180) / span)), int(math.floor((e + 180) / span))
    y0, y1 = int(math.floor((90 - n) / span)), int(math.floor((90 - s) / span))
    return [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)
            if os.path.exists(planet_path(x, y, '.bvr'))]


def leaf_covered(x: int, y: int) -> bool:
    return any(src.covers(*tile_bounds(LEAF_ZOOM, x, y)) for src in SOURCES)


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--bbox', help='west,south,east,north')
    ap.add_argument('--leaf', help='x,y of one z12 leaf')
    ap.add_argument('--force', action='store_true', help='measure leaves already up to date')
    ap.add_argument('--jobs', type=int, default=max(1, min(6, (os.cpu_count() or 2) - 1)),
                    help='leaves measured at once, each in its own process')
    args = ap.parse_args(argv)
    if args.leaf:
        leaves = [tuple(int(v) for v in args.leaf.split(','))]
    elif args.bbox:
        leaves = leaves_in([float(v) for v in args.bbox.split(',')])
    else:
        ap.error('give --bbox or --leaf')
    todo = [k for k in leaves if leaf_covered(*k) and (args.force or not up_to_date(*k))]
    print(f'measure_buildings: {len(leaves)} leaves with buildings, {len(todo)} to measure', flush=True)
    t0 = time.time()
    tot = {'buildings': 0, 'measured': 0, 'noData': 0, 'tooSmall': 0, 'blocks': 0, 'cacheHits': 0}
    shifts: List[float] = []
    veils: List[float] = []
    failed = 0
    done = 0

    def account(r: dict) -> None:
        nonlocal done
        done += 1
        for k in tot:
            tot[k] += r[k]
        shifts.extend(r['shiftM'])
        veils.extend(r['veil'])
        x, y = r['leaf']
        print(f'  {done}/{len(todo)} {x}/{y}: {r["measured"]}/{r["buildings"]} roofs, {r["blocks"]} blocks '
              f'({r["cacheHits"]} cached), {r["seconds"]:.1f} s', flush=True)

    with ProcessPoolExecutor(max(1, args.jobs)) as pool:
        futures = {pool.submit(measure_leaf, x, y): (x, y) for x, y in todo}
        for f in as_completed(futures):
            try:
                account(f.result())
            except Exception as ex:  # noqa: BLE001 - one leaf's failure is logged, the rest go on
                failed += 1
                x, y = futures[f]
                print(f'  leaf {x}/{y} failed: {ex!r}', flush=True)
    med_shift = float(np.median(shifts)) if shifts else 0.0
    print(f'measure_buildings: {tot["measured"]}/{tot["buildings"]} roofs measured, {tot["noData"]} outside every '
          f'source, {tot["tooSmall"]} too small or unreadable; {tot["blocks"]} blocks ({tot["cacheHits"]} cached); '
          f'median shift {med_shift:.1f} m, median veil {float(np.median(veils)) if veils else 0.0:.0f}/255; '
          f'{failed} leaves failed; {(time.time() - t0) / 60:.1f} min', flush=True)
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())

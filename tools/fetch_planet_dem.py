#!/usr/bin/env python3
"""Fetch a DEM for an arbitrary area, as the height source stage 1 bakes from.

``bake_planet_dem.py`` takes one axis-aligned EPSG:4326 GeoTIFF and turns it
into the .pdm pyramid. That has always meant ``data/output_hh.tif``, which only
covers the Canaries, so no other part of the world could be baked at all. This
tool writes the same kind of file for any bbox, out of a public 1 arcsec DEM
archive - FABDEM by default, or raw Copernicus DEM GLO-30 with ``--source
copernicus``.

Both archives are 1 degree squares read over ``/vsicurl/`` so only the windows
overlapping the bbox are transferred, and both are named by their south-west
corner - but they are not the same data. Copernicus GLO-30 is a *surface*
model: its height at a runway includes the hangar sitting on it, and in a
forest it is canopy height, not ground. FABDEM (Forest And Buildings removed
Copernicus DEM, University of Bristol) is Copernicus GLO-30 with a machine-
learned correction that strips that bias back out, so a flat airfield reads
flat and a forested valley reads as the valley floor. Same 1 arcsec grid, same
EGM2008-referenced heights, so it drops into this pipeline as a straight
replacement.

Copernicus publishes squares only where there is land, so ``tileList.txt`` is
fetched once and cached: an all-ocean square is skipped by name rather than by
waiting for a 404. FABDEM has no equivalent published index here, so an
all-ocean FABDEM square is simply skipped when the fetch 404s.

Output resolution defaults to 1 arcsec, the archive's own latitude spacing.
That matters more than it looks. ``bake_planet_dem.py`` derives the pyramid's
max zoom from the source pixel, and 1 arcsec lands on **z12** - the same depth
the existing Canaries pyramid was baked to. Fetching at the default therefore
keeps one uniform pyramid rather than a patchwork of depths.

The fetched box is then snapped outwards so the area owns every tile it
touches, and the pixel step is nudged (1 arcsec -> 1.0013 at z12) so a whole
number of pixels spans a tile. Both exist for the same reason: an area whose
raster stops halfway across a tile leaves the bake filling the rest with sea
level, and merging a neighbour later writes that fake ocean over real ground.
Snapped and on the shared lattice, neighbouring areas agree on their common
tiles to within quantisation. ``--no-snap`` turns both off, which is only
useful for reproducing that failure.

Longitude spacing in the archive widens towards the poles (1.5 arcsec above
50 deg, 2 arcsec above 60, and so on). Every square carries its own transform
and is reprojected onto this tool's uniform grid, so a bbox spanning two bands
merges with no special handling.

Usage::

    python tools/fetch_planet_dem.py --bbox 6.0,45.6,8.0,46.6 --out data/imports/alps.tif

Add ``--source copernicus`` to fetch the raw surface model instead, e.g. for
reproducing an old bake or comparing the two with ``compare_planet_dem.py``.

Then bake it as usual::

    python tools/bake_planet_dem.py --input data/imports/alps.tif --out assets/planet

Requires ``rasterio``, ``numpy`` and ``requests``::

    pip install rasterio numpy requests
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import threading
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, List, Optional, Sequence, Set, Tuple

import numpy as np

warnings.filterwarnings('ignore', category=DeprecationWarning, module='rasterio')

try:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import from_origin
    from rasterio.warp import reproject
    from rasterio.windows import Window
    from rasterio.windows import bounds as window_bounds
    from rasterio.windows import from_bounds as window_from_bounds
    from rasterio.windows import transform as window_transform
except ImportError:  # pragma: no cover - dependency hint
    print('error: rasterio is required (pip install rasterio numpy requests)', file=sys.stderr)
    raise

try:
    import requests
except ImportError:  # pragma: no cover - dependency hint
    print('error: requests is required (pip install requests)', file=sys.stderr)
    raise

DEFAULT_OUT = 'data/imports/dem.tif'

COP_BUCKET = 'https://copernicus-dem-30m.s3.amazonaws.com'
COP_TILE_URL = COP_BUCKET + '/{name}/{name}.tif'
COP_TILE_LIST = COP_BUCKET + '/tileList.txt'
TILE_LIST_CACHE = 'data/imports/.copernicus-tiles.txt'

# Public HF-hosted mirror of FABDEM v1.2 (links-ads/fabdem-v12), one COG per 1
# degree tile, bundled under 10x10 degree "block" folders that mirror how the
# University of Bristol ships the original zips. Verified directly (not just
# documented): the resolve URL 302s to a presigned, range-request-capable CDN
# location, so /vsicurl/ windowed reads work the same as against Copernicus's
# S3 bucket.
FABDEM_VERSION = 'V1-2'
FABDEM_BUCKET = 'https://huggingface.co/buckets/links-ads/fabdem/resolve/tiles'
DEFAULT_SOURCE = 'fabdem'

ARCSEC_DEG = 1.0 / 3600.0

# Below the bake's VALID_MIN_M, so a void still reads as void even if the
# nodata tag is lost somewhere in the chain, rather than as a 32 km deep hole.
NODATA = -32768.0

# Must track DEFAULT_TILE_SIZE in bake_planet_dem.py. Only used to report the
# zoom this fetch will bake to.
TILE_SIZE = 257

# A bake is quadratic in span and the mesh stage is the slow half, so a
# fat-fingered bbox is worth stopping before it downloads for an hour.
DEFAULT_MAX_SPAN_DEG = 6.0

# Pixels fetched beyond the claimed tiles. A node landing exactly on the raster
# edge has no pixel centre to its outside, so the sampler clamps it to the
# first one - half a pixel off, which on an alpine slope is metres. The tile
# next door samples that same edge by interpolating, and the two no longer
# agree: a crack straight down the shared edge. One pixel of margin is enough
# to interpolate; two is enough not to think about rounding.
MARGIN_PX = 2

# GeoTIFF tag naming the tiles this raster is authoritative for, as distinct
# from the slightly larger area it covers. Without it the bake reads the margin
# as real coverage and claims the tiles next door on the strength of two pixels.
CLAIM_TAG = 'RETRO_CLAIM_BBOX'

# Each square is one HTTP-backed read, so the fetch is latency-bound and GDAL
# releases the GIL while it waits - a thread pool overlaps the squares' network
# time. Same figure as fetch_cover_sources.py, for the same per-host reasons.
DEFAULT_JOBS = 8

# Both archives are immutable products (a square never changes once
# published), so a downloaded square is kept byte-for-byte and read from disk
# on every later run - a re-fetch of the same area, a neighbour sharing a
# square, or a bake at a different --arcsec all skip the network.
DEM_CACHE_DIR = 'data/imports/.dem-cache'

# Source pixels read beyond the ones the target window strictly maps onto.
# Bilinear needs the neighbour on each side, and the warper's own source
# window estimate rounds outwards by a pixel or so; four is enough that a
# windowed read samples exactly what a whole-square read would have.
SRC_PAD_PX = 4

# Target pixels around a square's footprint that its reprojection is allowed
# to fill. A square's edge pixel centre sits half a source pixel inside its
# bounds, and the target lattice is not aligned to it, so the last target
# column a square touches can round either way.
DST_PAD_PX = 1

GDAL_ENV = dict(
    # A COG is one file; do not list its directory on open (a wasted round
    # trip against S3, and a slow one against the HF CDN).
    GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR',
    GDAL_HTTP_MULTIPLEX='YES',
    GDAL_HTTP_VERSION='2',
    # Range reads land in this cache; a square's IFD and the blocks a window
    # touches are well inside it.
    CPL_VSIL_CURL_CACHE_SIZE=str(64 * 1024 * 1024),
    # libcurl has no timeout by default: a stalled connection hangs the run
    # with nothing printed. Bounded, it becomes an exception the per-square
    # skip already handles.
    GDAL_HTTP_CONNECTTIMEOUT=10,
    GDAL_HTTP_TIMEOUT=60,
    GDAL_HTTP_MAX_RETRY=2,
    GDAL_HTTP_RETRY_DELAY=2,
    GDAL_NUM_THREADS='ALL_CPUS',
)


def parse_bbox(text: str) -> Tuple[float, float, float, float]:
    parts = [p.strip() for p in text.split(',')]
    if len(parts) != 4:
        raise ValueError('bbox must be west,south,east,north')
    west, south, east, north = (float(p) for p in parts)
    if west >= east:
        raise ValueError('bbox west must be below east (antimeridian spans are not supported)')
    if south >= north:
        raise ValueError('bbox south must be below north')
    if west < -180.0 or east > 180.0 or south < -90.0 or north > 90.0:
        raise ValueError('bbox must lie inside the WGS84 domain')
    return west, south, east, north


def tile_name(lat: int, lon: int) -> str:
    """Archive name for the 1 degree square with that south-west corner."""
    ns = 'N' if lat >= 0 else 'S'
    ew = 'E' if lon >= 0 else 'W'
    return f'Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM'


def iter_bbox_cells(bounds: Tuple[float, float, float, float]):
    """Every 1 degree (lat, lon) south-west corner the bbox touches."""
    west, south, east, north = bounds
    lat = int(math.floor(south))
    while lat < north:
        lon = int(math.floor(west))
        while lon < east:
            yield lat, lon
            lon += 1
        lat += 1


def tiles_for_bbox(bounds: Tuple[float, float, float, float]) -> List[str]:
    return [tile_name(lat, lon) for lat, lon in iter_bbox_cells(bounds)]


def fabdem_coord_tag(lat: int, lon: int) -> str:
    """e.g. (44, 7) -> 'N44E007' - the archive's per-tile and per-block corner tag."""
    ns = 'N' if lat >= 0 else 'S'
    ew = 'E' if lon >= 0 else 'W'
    return f'{ns}{abs(lat):02d}{ew}{abs(lon):03d}'


def fabdem_tile_name(lat: int, lon: int) -> str:
    return f'{fabdem_coord_tag(lat, lon)}_FABDEM_{FABDEM_VERSION}'


def fabdem_block_name(lat: int, lon: int) -> str:
    """The 10x10 degree folder a tile ships under, named by its own SW/NE corners."""
    lat0, lon0 = 10 * (lat // 10), 10 * (lon // 10)
    return (f'{fabdem_coord_tag(lat0, lon0)}-{fabdem_coord_tag(lat0 + 10, lon0 + 10)}'
            f'_FABDEM_{FABDEM_VERSION}')


def fabdem_tile_url(lat: int, lon: int) -> str:
    tile = fabdem_tile_name(lat, lon)
    return f'{FABDEM_BUCKET}/{fabdem_block_name(lat, lon)}/{tile}.tif'


def load_tile_list(refresh: bool = False) -> Optional[Set[str]]:
    """Every square the archive publishes, cached on disk.

    Returns None when the list cannot be had, in which case the caller falls
    back to trying each candidate and letting the read fail.
    """
    if not refresh and os.path.exists(TILE_LIST_CACHE):
        with open(TILE_LIST_CACHE, encoding='utf-8') as fh:
            return {line.strip() for line in fh if line.strip()}
    try:
        res = requests.get(COP_TILE_LIST, timeout=120)
        res.raise_for_status()
    except Exception as exc:  # noqa: BLE001 - the fallback is a slower fetch, not a failure
        print(f'  could not fetch tileList.txt ({exc}); probing squares individually')
        return None
    os.makedirs(os.path.dirname(TILE_LIST_CACHE) or '.', exist_ok=True)
    with open(TILE_LIST_CACHE, 'w', encoding='utf-8') as fh:
        fh.write(res.text)
    return {line.strip() for line in res.text.splitlines() if line.strip()}


def lattice_step(step_deg: float, zoom: int) -> float:
    """Round `step_deg` to an exact subdivision of a tile at `zoom`.

    An arcsecond does not divide a tile (a z12 tile is 158.2 of them), so a
    lattice anchored at -180 and a tile grid anchored at -180 drift apart. Snap
    a box to tiles and then to that lattice and it grows a sliver past the tile
    edge; the bake sees the sliver, claims the next tile along, and fills the
    99% it cannot see with sea level - which is the same cliff as an
    unsnapped fetch, just one tile over.

    Rounding the step so a whole number of them spans a tile makes the two
    grids the same grid, and the two snaps agree. The adjustment is tiny: 1
    arcsec becomes 1.0013 arcsec at z12.
    """
    tile_span = 180.0 / (1 << zoom)
    n = max(1, int(round(tile_span / step_deg)))
    return tile_span / n


def snap_bbox_to_pixels(
    bounds: Tuple[float, float, float, float], step_deg: float,
) -> Tuple[float, float, float, float]:
    """Grow `bounds` outwards to the global `step_deg` lattice anchored at
    (-180, 90).

    Two areas fetched separately otherwise land on different pixel lattices,
    because a grid sized to its own bbox has its own step. Sampling the same
    ground through two lattices disagrees by tens of metres on a steep slope,
    and where the two areas meet, one tile's east edge no longer matches its
    neighbour's west edge - a crack down the tile boundary that the mesh bake
    faithfully reproduces. Anchoring every fetch to one global lattice makes
    the overlap bit-comparable instead.
    """
    west, south, east, north = bounds
    return (
        max(-180.0, -180.0 + math.floor(round((west + 180.0) / step_deg, 6)) * step_deg),
        max(-90.0, 90.0 - math.ceil(round((90.0 - south) / step_deg, 6)) * step_deg),
        min(180.0, -180.0 + math.ceil(round((east + 180.0) / step_deg, 6)) * step_deg),
        min(90.0, 90.0 - math.floor(round((90.0 - north) / step_deg, 6)) * step_deg),
    )


def target_grid(bounds: Tuple[float, float, float, float], step_deg: float):
    """A north-up EPSG:4326 grid over `bounds` at exactly `step_deg`.

    The step is the one asked for rather than one divided out of the span, so
    that a bbox already on the global lattice keeps its pixel centres there.
    """
    west, south, east, north = bounds
    width = max(1, int(round((east - west) / step_deg)))
    height = max(1, int(round((north - south) / step_deg)))
    return from_origin(west, north, step_deg, step_deg), width, height


def snap_bbox_to_tiles(
    bounds: Tuple[float, float, float, float], zoom: int,
) -> Tuple[float, float, float, float]:
    """Grow `bounds` outwards to whole tile edges at `zoom`.

    Without this, two areas fetched side by side both half-cover the tile their
    shared edge runs through, and the bake fills the half it cannot see with
    sea level - so whichever is merged second writes a cliff of fake ocean over
    the other's ground. Snapping means every fetch owns the tiles it touches
    outright, and a shared edge tile is complete in both.
    """
    west, south, east, north = bounds
    span = 180.0 / (1 << zoom)

    def lower(value: float) -> int:
        return int(math.floor(round(value / span, 9)))

    def upper(value: float) -> int:
        # An edge landing exactly on a tile boundary belongs to the tile below
        # it, not to the empty one starting there.
        return int(math.ceil(round(value / span, 9)))

    x0, x1 = lower(west + 180.0), upper(east + 180.0)
    y0, y1 = lower(90.0 - north), upper(90.0 - south)
    return (
        max(-180.0, -180.0 + x0 * span),
        max(-90.0, 90.0 - y1 * span),
        min(180.0, -180.0 + x1 * span),
        min(90.0, 90.0 - y0 * span),
    )


def auto_max_zoom(deg_per_pixel: float, tile_size: int) -> int:
    """Mirror of bake_planet_dem.auto_max_zoom, so the fetch can report it."""
    intervals = tile_size - 1
    for z in range(0, 24):
        if (180.0 / (1 << z)) / intervals <= deg_per_pixel:
            return z
    return 23


def source_name(url: str) -> str:
    return url.rsplit('/', 1)[-1]


def http_url(source: str) -> str:
    """The plain URL behind a ``/vsicurl/`` path (a local path is left alone)."""
    return source[len('/vsicurl/'):] if source.startswith('/vsicurl/') else source


def cache_path(source: str, cache_dir: str = DEM_CACHE_DIR) -> str:
    return os.path.join(cache_dir, source_name(source))


def ensure_cached(source: str, cache_dir: str = DEM_CACHE_DIR) -> str:
    """The local copy of an archive square, downloading it on first use.

    The whole file is kept, not the window this run happened to need: the
    next area over wants a different window of the same square, and a
    re-bake at another --arcsec wants another overview level of it. The
    download lands in a per-thread temp file and is renamed into place only
    once its length matches what the server announced, so a run killed
    mid-download leaves no truncated square for the next one to trust.
    """
    path = cache_path(source, cache_dir)
    if os.path.exists(path):
        return path
    os.makedirs(cache_dir, exist_ok=True)
    part = f'{path}.part-{os.getpid()}-{threading.get_ident()}'
    try:
        with requests.get(http_url(source), stream=True, timeout=(10, 60)) as res:
            res.raise_for_status()
            expected = res.headers.get('Content-Length')
            got = 0
            with open(part, 'wb') as fh:
                for chunk in res.iter_content(chunk_size=1 << 20):
                    fh.write(chunk)
                    got += len(chunk)
        if expected is not None and int(expected) != got:
            raise IOError(f'short download: {got} of {expected} bytes')
        os.replace(part, path)
    except BaseException:
        try:
            os.remove(part)
        except OSError:
            pass
        raise
    return path


def _round_out(window: Window, pad: int, width: int, height: int) -> Optional[Window]:
    """Grow a float window outwards to whole pixels plus `pad`, clipped to a
    `width` x `height` raster. None when nothing is left."""
    col0 = max(0, int(math.floor(window.col_off)) - pad)
    row0 = max(0, int(math.floor(window.row_off)) - pad)
    col1 = min(width, int(math.ceil(window.col_off + window.width)) + pad)
    row1 = min(height, int(math.ceil(window.row_off + window.height)) + pad)
    if col1 <= col0 or row1 <= row0:
        return None
    return Window(col0, row0, col1 - col0, row1 - row0)


def _align_to(window: Window, factor: int, width: int, height: int) -> Optional[Window]:
    """Snap a window outwards to multiples of `factor` pixels, so a decimated
    read of it samples the same cells a decimated read of the whole raster
    would - a partial cell at the end is dropped the same way `width //
    factor` drops it."""
    if factor <= 1:
        return window
    col0 = (int(window.col_off) // factor) * factor
    row0 = (int(window.row_off) // factor) * factor
    col1 = min((width // factor) * factor,
               int(math.ceil((window.col_off + window.width) / factor)) * factor)
    row1 = min((height // factor) * factor,
               int(math.ceil((window.row_off + window.height) / factor)) * factor)
    if col1 <= col0 or row1 <= row0:
        return None
    return Window(col0, row0, col1 - col0, row1 - row0)


def square_windows(
    src_transform, src_width: int, src_height: int,
    dst_transform, dst_width: int, dst_height: int,
    factor: int = 1,
) -> Optional[Tuple[Window, Window]]:
    """(source window, target window) for one square against the target grid.

    The target window is the square's own footprint on the target grid -
    padded a pixel, clipped to the grid - so the reprojection fills O(square)
    pixels rather than a whole-grid temporary. The source window is then
    whatever maps onto that target window, padded enough that bilinear at its
    edges sees the same neighbours a whole-square read would, so a bbox that
    clips a sliver of a square transfers a sliver of it. None when the square
    misses the grid entirely.
    """
    src_bounds = window_bounds(Window(0, 0, src_width, src_height), src_transform)
    dst = _round_out(window_from_bounds(*src_bounds, transform=dst_transform),
                     DST_PAD_PX, dst_width, dst_height)
    if dst is None:
        return None
    src = _round_out(window_from_bounds(*window_bounds(dst, dst_transform), transform=src_transform),
                     SRC_PAD_PX, src_width, src_height)
    if src is None:
        return None
    src = _align_to(src, factor, src_width, src_height)
    if src is None:
        return None
    return src, dst


FetchResult = Tuple[str, Optional[Window], Optional[np.ndarray], Optional[str]]


def fetch_square(
    source: str,
    dst_transform,
    dst_shape: Tuple[int, int],
    step_deg: float,
    cache_dir: Optional[str] = DEM_CACHE_DIR,
) -> FetchResult:
    """Read the part of one square the target grid needs and reproject it.

    Standalone (no shared output array) so a thread pool can run several at
    once. Returns (name, target window, reprojected block, error) - the block
    is the target window's size, NODATA where the square had nothing.
    """
    name = source_name(source)
    try:
        path = ensure_cached(source, cache_dir) if cache_dir else source
        with rasterio.Env(**GDAL_ENV), rasterio.open(path) as src:
            # Height is a continuous field, so decimating a read costs detail
            # rather than saving nothing - but a caller who asked for a coarse
            # grid should still hit the COG's own overviews instead of
            # dragging full-resolution float32 over the wire per square.
            factor = max(1, int(step_deg / max(abs(src.transform.a), 1e-12)))
            windows = square_windows(
                src.transform, src.width, src.height,
                dst_transform, dst_shape[1], dst_shape[0], factor)
            if windows is None:
                return name, None, None, None
            src_win, dst_win = windows
            out_w = max(1, int(src_win.width) // factor)
            out_h = max(1, int(src_win.height) // factor)
            data = src.read(
                1,
                window=src_win,
                out_shape=(out_h, out_w),
                resampling=Resampling.bilinear,
            ).astype(np.float32)
            src_transform = src.window_transform(src_win) * rasterio.Affine.scale(
                src_win.width / out_w, src_win.height / out_h)
            block = np.full((int(dst_win.height), int(dst_win.width)), NODATA, dtype=np.float32)
            reproject(
                source=data,
                destination=block,
                src_transform=src_transform,
                src_crs=src.crs,
                dst_transform=window_transform(dst_win, dst_transform),
                dst_crs='EPSG:4326',
                src_nodata=src.nodata if src.nodata is not None else NODATA,
                dst_nodata=NODATA,
                resampling=Resampling.bilinear,
                num_threads=4,
            )
    except Exception as exc:  # noqa: BLE001 - one missing square must not sink the run
        return name, None, None, str(exc)
    return name, dst_win, block, None


def mosaic_into(
    out: np.ndarray,
    dst_transform,
    sources: Sequence[str],
    step_deg: float,
    jobs: int = DEFAULT_JOBS,
    cache_dir: Optional[str] = DEM_CACHE_DIR,
    fetch: Callable[..., FetchResult] = fetch_square,
) -> int:
    """Reproject each square onto the target grid, first real height wins.

    The squares do not overlap, so precedence never actually arbitrates - the
    filled mask is here to report coverage and to notice a square that came
    back entirely void. Up to `jobs` squares are fetched at once; the merge
    itself walks the results in the order the squares were given, so the
    output does not depend on which fetch finished first.
    """
    used = 0
    total = len(sources)
    filled = np.zeros(out.shape, dtype=bool)
    jobs = max(1, min(jobs, total)) if total else 1
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        results = pool.map(
            lambda url: fetch(url, dst_transform, out.shape, step_deg, cache_dir),
            sources,
        )
        for i, (name, win, block, err) in enumerate(results):
            if err is not None:
                print(f'  [{i + 1}/{total}] skipped {name}: {err}', flush=True)
                continue
            if win is None:
                print(f'  [{i + 1}/{total}] {name} lies outside the grid', flush=True)
                continue
            rows = slice(int(win.row_off), int(win.row_off + win.height))
            cols = slice(int(win.col_off), int(win.col_off + win.width))
            view = out[rows, cols]
            fresh = (block != NODATA) & ~filled[rows, cols]
            if not fresh.any():
                print(f'  [{i + 1}/{total}] nothing new from {name}', flush=True)
                continue
            view[fresh] = block[fresh]
            filled[rows, cols] |= fresh
            used += 1
            print(f'  [{i + 1}/{total}] merged {name} -> {100.0 * filled.mean():.1f}% covered',
                  flush=True)
    return used


def write_tif(
    path: str,
    data: np.ndarray,
    transform,
    claim: Optional[Tuple[float, float, float, float]] = None,
) -> None:
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with rasterio.open(
        path, 'w',
        driver='GTiff',
        width=data.shape[1], height=data.shape[0], count=1,
        dtype=data.dtype, crs='EPSG:4326', transform=transform,
        nodata=NODATA,
        tiled=True, blockxsize=512, blockysize=512,
        compress='DEFLATE', predictor=3, num_threads='ALL_CPUS',
    ) as dst:
        dst.write(data, 1)
        if claim is not None:
            dst.update_tags(**{CLAIM_TAG: ','.join(f'{v:.10f}' for v in claim)})
        dst.build_overviews([2, 4, 8, 16], Resampling.average)
    mb = os.path.getsize(path) / 1048576
    print(f'wrote {path}: {data.shape[1]}x{data.shape[0]}, {mb:.1f} MB')


def glue_negative_values(argv: Sequence[str]) -> List[str]:
    """Rewrite ``--bbox -18.6,...`` into the ``--bbox=-18.6,...`` argparse takes.

    A bbox in the western hemisphere starts with a minus, and argparse reads
    that as the next option rather than as this one's value - so the plainest
    possible invocation fails, the Canaries coverage included. Its
    negative-number escape hatch does not help either: it only recognises a
    bare number, and a bbox has commas in it.
    """
    out: List[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == '--bbox' and i + 1 < len(argv) and argv[i + 1].startswith('-'):
            out.append(f'{arg}={argv[i + 1]}')
            i += 2
            continue
        out.append(arg)
        i += 1
    return out


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description='Fetch a 1 arcsec DEM for a bbox.')
    ap.add_argument('--bbox', required=True, help='west,south,east,north in degrees')
    ap.add_argument('--out', default=DEFAULT_OUT, help=f'output GeoTIFF (default {DEFAULT_OUT})')
    ap.add_argument('--source', choices=['fabdem', 'copernicus'], default=DEFAULT_SOURCE,
                    help='DEM archive to fetch (default fabdem - Copernicus GLO-30 with its '
                         'forest/building height bias removed; copernicus fetches the raw '
                         'surface model instead)')
    ap.add_argument('--arcsec', type=float, default=1.0,
                    help='output pixel in arcseconds (default 1.0, the archive spacing)')
    ap.add_argument('--max-span', type=float, default=DEFAULT_MAX_SPAN_DEG,
                    help=f'refuse a bbox wider or taller than this (default {DEFAULT_MAX_SPAN_DEG} deg)')
    ap.add_argument('--no-snap', action='store_true',
                    help='do not grow the bbox to whole tile edges (leaves a '
                         'shared edge tile half-covered, which merges badly)')
    ap.add_argument('--refresh-tile-list', action='store_true',
                    help='re-fetch the cached archive tile list')
    ap.add_argument('--jobs', type=int, default=DEFAULT_JOBS,
                    help=f'squares fetched at once (default {DEFAULT_JOBS})')
    ap.add_argument('--no-cache', action='store_true',
                    help=f'read squares straight off the archive instead of keeping '
                         f'a copy under {DEM_CACHE_DIR}')
    args = ap.parse_args(glue_negative_values(sys.argv[1:] if argv is None else argv))
    t_start = time.perf_counter()

    try:
        bounds = parse_bbox(args.bbox)
    except ValueError as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 2
    west, south, east, north = bounds

    span_lon = east - west
    span_lat = north - south
    if max(span_lon, span_lat) > args.max_span:
        print(f'error: bbox spans {span_lon:.2f} x {span_lat:.2f} deg, over the '
              f'{args.max_span} deg limit. Bake cost grows with area; pass '
              '--max-span to override.', file=sys.stderr)
        return 2

    mid_lat = 0.5 * (south + north)
    km_lon = span_lon * 111.32 * math.cos(math.radians(mid_lat))
    km_lat = span_lat * 110.57
    print(f'bbox      {west:.5f},{south:.5f} .. {east:.5f},{north:.5f}')
    print(f'          {km_lon:.0f} x {km_lat:.0f} km')

    step_deg = args.arcsec * ARCSEC_DEG
    zoom = auto_max_zoom(step_deg, TILE_SIZE)
    claim: Optional[Tuple[float, float, float, float]] = None
    if not args.no_snap:
        step_deg = lattice_step(step_deg, zoom)
    print(f'pixel     {step_deg / ARCSEC_DEG:.4f} arcsec '
          f'({step_deg * 111320:.0f} m at the equator) -> bakes to z{zoom}')

    if not args.no_snap:
        # Tiles first so the area owns every tile it touches, then pixels so it
        # shares a lattice with every other fetch. With a commensurate step the
        # second snap is a no-op; it stays so that assumption is enforced
        # rather than assumed.
        bounds = snap_bbox_to_pixels(snap_bbox_to_tiles(bounds, zoom), step_deg)
        west, south, east, north = bounds
        print(f'snapped   {west:.5f},{south:.5f} .. {east:.5f},{north:.5f} '
              f'(whole z{zoom} tiles, on the shared lattice)')
        claim = bounds
        pad = MARGIN_PX * step_deg
        bounds = (max(-180.0, west - pad), max(-90.0, south - pad),
                  min(180.0, east + pad), min(90.0, north + pad))
        west, south, east, north = bounds
        print(f'margin    +{MARGIN_PX} px each side, so tile-edge nodes '
              'interpolate instead of clamping')

    print(f'source    {args.source}')
    if args.source == 'copernicus':
        candidates = tiles_for_bbox(bounds)
        published = load_tile_list(args.refresh_tile_list)
        if published is not None:
            wanted = [n for n in candidates if n in published]
            skipped = len(candidates) - len(wanted)
            print(f'squares   {len(wanted)} of {len(candidates)} published'
                  + (f' ({skipped} all-ocean skipped)' if skipped else ''))
        else:
            wanted = candidates
            print(f'squares   {len(wanted)} candidates')

        if not wanted:
            print('error: the archive publishes no squares for this bbox - it is all '
                  'open ocean. Pick an area with land in it.', file=sys.stderr)
            return 1
        urls = [f'/vsicurl/{COP_TILE_URL.format(name=n)}' for n in wanted]
    else:
        cells = list(iter_bbox_cells(bounds))
        print(f'squares   {len(cells)} candidates (no published land index - '
              f'all-ocean squares are skipped on fetch instead)')
        urls = [f'/vsicurl/{fabdem_tile_url(lat, lon)}' for lat, lon in cells]

    transform, width, height = target_grid(bounds, step_deg)
    print(f'grid      {width} x {height} px ({width * height * 4 / 1048576:.0f} MB in memory)')
    out = np.full((height, width), NODATA, dtype=np.float32)
    cache_dir = None if args.no_cache else DEM_CACHE_DIR
    print(f'cache     {cache_dir or "off"}, {max(1, args.jobs)} squares at a time')

    t_mosaic = time.perf_counter()
    used = mosaic_into(out, transform, urls, step_deg, jobs=args.jobs, cache_dir=cache_dir)
    print(f'mosaic    {time.perf_counter() - t_mosaic:.1f} s')
    if used == 0:
        print('error: no DEM squares could be read', file=sys.stderr)
        return 1

    real = out != NODATA
    if not real.any():
        print('error: every square read back void', file=sys.stderr)
        return 1
    land = real & (out > 0.5)
    if not land.any():
        print('error: no land above sea level in this bbox - the bake would '
              'write an empty pyramid.', file=sys.stderr)
        return 1

    heights = out[real]
    print(f'heights   {heights.min():.1f} .. {heights.max():.1f} m, '
          f'{100.0 * land.mean():.1f}% land')

    write_tif(args.out, out, transform, claim)
    print(f'total     {time.perf_counter() - t_start:.1f} s')
    print(f'\nnext: python tools/bake_planet_dem.py --input {args.out} --out assets/planet')
    return 0


if __name__ == '__main__':
    sys.exit(main())

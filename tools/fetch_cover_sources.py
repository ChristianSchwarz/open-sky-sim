#!/usr/bin/env python3
"""Fetch the observed-cover sources the terrain bake colours facets from.

Two open datasets, clipped to the pyramid's own coverage and written as two
plain EPSG:4326 GeoTIFFs under ``data/cover``:

``landcover.tif``
    ESA WorldCover 2021 v200 - 10 m, 11 classes, CC-BY 4.0. Read straight out
    of the public ``esa-worldcover`` S3 bucket over ``/vsicurl/``, so only the
    overview level and the tiles actually overlapping the coverage are ever
    transferred.

``imagery.tif``
    Sentinel-2 L2A true colour. Scenes are discovered through the Earth Search
    STAC API and read from the public ``sentinel-cogs`` bucket. The ``visual``
    asset is used rather than raw B04/B03/B02: it is the same data already
    stretched to 8-bit sRGB by the Copernicus processor, which is exactly what
    a facet colour wants and saves this tool inventing its own stretch.

Both are written at a deliberately coarse resolution - see ``--landcover-m``
and ``--imagery-m``. A facet at the finest zoom covers 30-100 m of ground, so
anything sharper is averaged away in the mesh bake anyway, and the difference
between 10 m and 40 m here is the difference between a 2 GB download and a
50 MB one.

Neither file is a build input the runtime ever sees; ``data/cover`` is
gitignored, and re-running this is the only way to get them back.

Usage::

    python tools/fetch_cover_sources.py
    python tools/fetch_cover_sources.py --no-imagery
    python tools/fetch_cover_sources.py --imagery-m 20 --max-cloud 2

Requires ``rasterio``, ``numpy`` and ``requests``::

    pip install rasterio numpy requests
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

warnings.filterwarnings('ignore', category=DeprecationWarning, module='rasterio')

try:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import array_bounds, from_origin
    from rasterio.warp import reproject, transform_bounds
    from rasterio.windows import Window, from_bounds as window_from_bounds
except ImportError:  # pragma: no cover - dependency hint
    print('error: rasterio is required (pip install rasterio numpy requests)', file=sys.stderr)
    raise

try:
    import requests
except ImportError:  # pragma: no cover - dependency hint
    print('error: requests is required (pip install requests)', file=sys.stderr)
    raise

DEFAULT_MANIFEST = 'assets/planet/manifest.json'
DEFAULT_OUT = 'data/cover'

WORLDCOVER_BASE = (
    'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/'
    'ESA_WorldCover_10m_2021_v200_{tile}_Map.tif'
)
STAC_SEARCH = 'https://earth-search.aws.element84.com/v1/search'
# Enough to reach every grid square in a coverage this size, and a stop so a
# bad query cannot page forever.
MAX_STAC_PAGES = 12

DEG_PER_M = 1.0 / 111320.0

# Each source is one HTTP-backed GDAL read (a WorldCover tile or a Sentinel-2
# scene, both /vsicurl/), so this is latency-bound, not CPU-bound: a scene
# spends most of its time waiting on the network, and GDAL releases the GIL
# while it does, which is what makes a thread pool - not a process pool - the
# right tool here. 8 keeps a single run well under any per-host connection
# limit the S3 buckets impose while still overlapping enough scenes that a
# `--max-scenes 60` imagery mosaic is minutes, not the better part of an hour.
DEFAULT_JOBS = 8


def worldcover_tiles(west: float, south: float, east: float, north: float) -> List[str]:
    """WorldCover tile names covering a bbox. The grid is 3 degrees, named by
    its south-west corner."""
    names = []
    lat = int(math.floor(south / 3.0) * 3)
    while lat < north:
        lon = int(math.floor(west / 3.0) * 3)
        while lon < east:
            ns = 'N' if lat >= 0 else 'S'
            ew = 'E' if lon >= 0 else 'W'
            names.append(f'{ns}{abs(lat):02d}{ew}{abs(lon):03d}')
            lon += 3
        lat += 3
    return names


def target_grid(bounds: Tuple[float, float, float, float], metres: float):
    """A north-up EPSG:4326 grid over `bounds` at roughly `metres` per pixel.

    Spacing is set from the latitude span, which unlike the longitude span does
    not shrink towards the poles - so the pixel is never coarser than asked for.
    """
    west, south, east, north = bounds
    step = metres * DEG_PER_M
    width = max(1, int(math.ceil((east - west) / step)))
    height = max(1, int(math.ceil((north - south) / step)))
    return from_origin(west, north, (east - west) / width, (north - south) / height), width, height


def source_metres_per_pixel(src) -> float:
    """Ground sample distance of an open raster, whatever its CRS says in."""
    step = abs(src.transform.a)
    if src.crs and src.crs.is_geographic:
        return step / DEG_PER_M
    return step


def decimation_for(src, target_m: float) -> int:
    """How much to shrink a source read by, to land near the target pixel.

    This is the difference between a usable tool and an unusable one. Warping
    straight from the full-resolution band pulls every one of a 10 m scene's
    120 million pixels over the network to produce a 40 m mosaic - about 300 MB
    per scene, times thirty-odd scenes. Reading decimated first hits the COG's
    own overviews instead and moves a fraction of that.
    """
    src_m = source_metres_per_pixel(src)
    if src_m <= 0:
        return 1
    # Half a step of headroom: resampling down from slightly finer than the
    # target is free, resampling up from coarser is visible.
    return max(1, int(target_m / src_m))


def _source_name(url: str) -> str:
    return url.rsplit('/', 2)[-2] if url.endswith(('TCI.tif', 'visual.tif')) \
        else url.rsplit('/', 1)[-1]


# Source pixels of slack around the target footprint, before decimation. Enough
# that the resampling kernel at the crop edge sees the same neighbours it would
# have seen in an uncropped read, so the crop is invisible in the mosaic.
WINDOW_PAD_PX = 4


def source_window(src, dst_transform, dst_shape, factor: int) -> Optional[Window]:
    """The part of `src` that can land on the target grid, or None if none can.

    The target is EPSG:4326 and the sources are UTM (Sentinel-2) or geographic
    (WorldCover), so the target bounds are pushed through `transform_bounds`
    (densified, so a UTM zone's curved edge is not cut by a straight chord),
    padded, then snapped outward to a multiple of the decimation factor. The
    snapping matters: a decimated read samples the COG overview relative to
    the window origin, and keeping that origin on the same lattice a full-
    raster read would use is what keeps the cropped result pixel-identical to
    the uncropped one rather than half a pixel adrift.
    """
    dst_bounds = array_bounds(dst_shape[1], dst_shape[2], dst_transform)
    try:
        west, south, east, north = transform_bounds(
            'EPSG:4326', src.crs, *dst_bounds, densify_pts=21)
    except Exception:  # noqa: BLE001 - out-of-zone bounds; fall back to the whole raster
        return Window(0, 0, src.width, src.height)
    if not all(math.isfinite(v) for v in (west, south, east, north)):
        return Window(0, 0, src.width, src.height)
    win = window_from_bounds(west, south, east, north, transform=src.transform)
    pad = WINDOW_PAD_PX * factor
    col0 = int(math.floor((win.col_off - pad) / factor)) * factor
    row0 = int(math.floor((win.row_off - pad) / factor)) * factor
    col1 = int(math.ceil((win.col_off + win.width + pad) / factor)) * factor
    row1 = int(math.ceil((win.row_off + win.height + pad) / factor)) * factor
    col0, row0 = max(0, col0), max(0, row0)
    col1, row1 = min(src.width, col1), min(src.height, row1)
    if col1 <= col0 or row1 <= row0:
        return None
    return Window(col0, row0, col1 - col0, row1 - row0)


def _fetch_reprojected(
    url: str,
    dst_transform,
    dst_shape: Tuple[int, int, int],
    dst_dtype,
    bands: Sequence[int],
    resampling: Resampling,
    nodata: int,
    target_m: float,
) -> Tuple[str, Optional[np.ndarray], Optional[str]]:
    """Read and reproject one source onto the target grid.

    Standalone (no shared `out` array) so a thread pool can run several of
    these at once - the network wait for one scene overlaps the read/reproject
    CPU work of another instead of the two queueing behind each other.
    Returns (name, reprojected array or None, error message or None).

    GDAL's `/vsicurl/` has no timeout by default - libcurl waits forever on a
    stalled S3/CloudFront connection - and `mosaic_into`'s `pool.map()` yields
    results in submission order, so one stuck read blocks every other source
    behind it and the whole run hangs with nothing printed (stdout is fully
    buffered once it isn't a tty). Bounding it here turns that into an
    exception the existing `except` below already knows how to skip past.
    """
    name = _source_name(url)
    try:
        with rasterio.Env(
            GDAL_HTTP_CONNECTTIMEOUT=10, GDAL_HTTP_TIMEOUT=60, GDAL_HTTP_MAX_RETRY=2,
        ), rasterio.open(url) as src:
            factor = decimation_for(src, target_m)
            tmp = np.full(dst_shape, nodata, dtype=dst_dtype)
            # Only the part of the source under the target grid is fetched. A
            # scene that clips the bbox by 5% used to transfer 100% of its
            # overview; now it transfers the 5%.
            win = source_window(src, dst_transform, dst_shape, factor)
            if win is None:
                return name, tmp, None
            out_w = max(1, int(win.width) // factor)
            out_h = max(1, int(win.height) // factor)
            data = src.read(
                list(bands),
                window=win,
                out_shape=(len(bands), out_h, out_w),
                resampling=resampling,
            )
            src_transform = src.window_transform(win) * rasterio.Affine.scale(
                win.width / out_w, win.height / out_h)
            reproject(
                source=data,
                destination=tmp,
                src_transform=src_transform,
                src_crs=src.crs,
                dst_transform=dst_transform,
                dst_crs='EPSG:4326',
                dst_nodata=nodata,
                src_nodata=src.nodata if src.nodata is not None else nodata,
                resampling=resampling,
                num_threads=4,
            )
    except Exception as exc:  # noqa: BLE001 - one bad scene must not sink the run
        return name, None, str(exc)
    return name, tmp, None


def mosaic_into(
    out: np.ndarray,
    dst_transform,
    sources: Sequence[str],
    bands: Sequence[int],
    resampling: Resampling,
    nodata: int,
    target_m: float,
    jobs: int = DEFAULT_JOBS,
) -> int:
    """Reproject each source onto the target grid, first non-nodata wins.

    Sources are taken in the order given, so the caller decides precedence -
    for imagery that means cloud-free scenes first. The fetch+reproject of
    each source is independent of every other, so up to `jobs` of them run at
    once; only the merge into `out` - where order decides which source wins a
    pixel two of them cover - stays a sequential pass over the results in the
    original, caller-decided order.
    """
    used = 0
    filled = np.zeros(out.shape[1:], dtype=bool)
    jobs = max(1, min(jobs, len(sources))) if sources else 1
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        results = pool.map(
            lambda url: _fetch_reprojected(
                url, dst_transform, out.shape, out.dtype, bands, resampling, nodata, target_m),
            sources,
        )
        for name, tmp, err in results:
            if err is not None:
                print(f'  skipped {name}: {err}')
                continue
            fresh = np.any(tmp != nodata, axis=0) & ~filled
            if not fresh.any():
                print(f'  nothing new from {name}')
                continue
            for b in range(out.shape[0]):
                out[b][fresh] = tmp[b][fresh]
            filled |= fresh
            used += 1
            pct = 100.0 * filled.mean()
            print(f'  merged {name} -> {pct:.1f}% covered')
    return used


def write_tif(path: str, data: np.ndarray, transform, nodata: Optional[int]) -> None:
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with rasterio.open(
        path, 'w',
        driver='GTiff',
        width=data.shape[2], height=data.shape[1], count=data.shape[0],
        dtype=data.dtype, crs='EPSG:4326', transform=transform,
        nodata=nodata,
        tiled=True, blockxsize=512, blockysize=512,
        compress='DEFLATE', predictor=1, num_threads='ALL_CPUS',
    ) as dst:
        dst.write(data)
        dst.build_overviews([2, 4, 8, 16], Resampling.average)
    mb = os.path.getsize(path) / 1048576
    print(f'wrote {path}: {data.shape[2]}x{data.shape[1]}, {mb:.1f} MB')


def rfc3339(day: str, end_of_day: bool) -> str:
    """Earth Search rejects a bare date; it wants a full RFC3339 instant."""
    if 'T' in day:
        return day
    return f'{day}T23:59:59Z' if end_of_day else f'{day}T00:00:00Z'


def find_scenes(
    bounds: Tuple[float, float, float, float],
    start: str,
    end: str,
    max_cloud: float,
    limit: int,
) -> List[str]:
    """Best low-cloud Sentinel-2 `visual` asset per MGRS grid square."""
    body = {
        'collections': ['sentinel-2-l2a'],
        'bbox': list(bounds),
        'datetime': f'{rfc3339(start, False)}/{rfc3339(end, True)}',
        'query': {'eo:cloud_cover': {'lt': max_cloud}},
        'sortby': [{'field': 'properties.eo:cloud_cover', 'direction': 'asc'}],
        'limit': 100,
    }
    # Paginate. A single page is 100 scenes, and one busy grid square can
    # easily fill that on its own - which is how a naive single-page search
    # comes back holding nothing but the cloud-free open ocean and misses
    # every square with an island in it.
    features: List[dict] = []
    for _ in range(MAX_STAC_PAGES):
        res = requests.post(STAC_SEARCH, json=body, timeout=120)
        res.raise_for_status()
        page = res.json()
        features.extend(page.get('features', []))
        # Follow the link's body as the spec says to, rather than fishing for
        # a token: Earth Search names its cursor `next`, sets `merge: false`,
        # and hands back a complete replacement body. Looking for a `token` key
        # finds nothing, stops after one page, and leaves the search holding
        # whatever sorted first — which for a cloud sort is the open ocean.
        nxt = next((l for l in page.get('links', []) if l.get('rel') == 'next'), None)
        following = (nxt or {}).get('body')
        if not isinstance(following, dict) or not following:
            break
        following = {**body, **following} if nxt.get('merge') else following
        if following == body:
            break
        body = following
    print(f'STAC: {len(features)} scenes under {max_cloud}% cloud')

    # One scene per grid square, the least cloudy. More than that is redundant
    # data for the same ground, and the merge would never reach it.
    best: Dict[str, Tuple[float, str]] = {}
    for f in features:
        props = f.get('properties', {})
        href = f.get('assets', {}).get('visual', {}).get('href')
        if not href:
            continue
        grid = props.get('grid:code') or f.get('id', '')[:10]
        cloud = float(props.get('eo:cloud_cover', 100.0))
        if grid not in best or cloud < best[grid][0]:
            best[grid] = (cloud, href)
    picked = sorted(best.items(), key=lambda kv: kv[1][0])[:limit]
    print(f'  {len(best)} grid squares, taking {len(picked)}')
    if len(best) > len(picked):
        print(f'  NOTE: {len(best) - len(picked)} squares dropped by --max-scenes; '
              'coverage will have holes')
    return [href for _, (_, href) in picked]


def vsicurl(url: str) -> str:
    return f'/vsicurl/{url}' if url.startswith('http') else url


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--manifest', default=DEFAULT_MANIFEST,
                    help='pyramid manifest, for the coverage bbox')
    ap.add_argument('--bbox', help='west,south,east,north; overrides the manifest')
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--landcover-m', type=float, default=20.0,
                    help='metres per pixel for landcover.tif (default 20)')
    ap.add_argument('--imagery-m', type=float, default=40.0,
                    help='metres per pixel for imagery.tif (default 40)')
    ap.add_argument('--max-cloud', type=float, default=10.0)
    ap.add_argument('--start', default='2023-06-01')
    ap.add_argument('--end', default='2023-08-31')
    # High enough to hold every MGRS square over the Canaries (33 of them).
    # Scenes that add nothing are skipped in seconds, so an over-generous cap
    # costs far less than a hole in the mosaic.
    ap.add_argument('--max-scenes', type=int, default=60)
    ap.add_argument('--no-landcover', action='store_true')
    ap.add_argument('--no-imagery', action='store_true')
    ap.add_argument('--jobs', type=int, default=DEFAULT_JOBS,
                    help=f'sources fetched concurrently (default {DEFAULT_JOBS})')
    args = ap.parse_args()
    started = time.time()

    if args.bbox:
        west, south, east, north = (float(v) for v in args.bbox.split(','))
    else:
        if not os.path.exists(args.manifest):
            print(f'error: no manifest at {args.manifest}; pass --bbox instead', file=sys.stderr)
            sys.exit(1)
        with open(args.manifest, encoding='utf-8') as fh:
            cov = json.load(fh)['coverage']
        west, south, east, north = cov['west'], cov['south'], cov['east'], cov['north']
    bounds = (west, south, east, north)
    print(f'coverage: {west:.4f},{south:.4f} .. {east:.4f},{north:.4f}')

    sources: Dict[str, str] = {}

    if not args.no_landcover:
        tiles = worldcover_tiles(west, south, east, north)
        print(f'\nlandcover: {len(tiles)} WorldCover tiles ({", ".join(tiles)})')
        transform, width, height = target_grid(bounds, args.landcover_m)
        out = np.zeros((1, height, width), dtype=np.uint8)
        urls = [vsicurl(WORLDCOVER_BASE.format(tile=t)) for t in tiles]
        # Mode, not nearest: at 20 m each output pixel covers four source ones,
        # and the majority of them is a truer answer than whichever happens to
        # land under the sample point.
        t0 = time.time()
        used = mosaic_into(
            out, transform, urls, [1], Resampling.mode,
            nodata=0, target_m=args.landcover_m, jobs=args.jobs,
        )
        if used == 0:
            print('error: no landcover tiles could be read', file=sys.stderr)
            sys.exit(1)
        path = os.path.join(args.out, 'landcover.tif')
        write_tif(path, out, transform, nodata=0)
        sources['landcover'] = path
        print(f'  landcover merged in {time.time() - t0:.1f}s')

    if not args.no_imagery:
        print('\nimagery: searching Sentinel-2 L2A')
        try:
            hrefs = find_scenes(bounds, args.start, args.end, args.max_cloud, args.max_scenes)
        except Exception as exc:  # noqa: BLE001
            print(f'  STAC search failed: {exc}')
            hrefs = []
        if not hrefs:
            print('  no scenes found; the bake will fall back to class colours')
        else:
            transform, width, height = target_grid(bounds, args.imagery_m)
            out = np.zeros((3, height, width), dtype=np.uint8)
            t0 = time.time()
            used = mosaic_into(
                out, transform, [vsicurl(h) for h in hrefs], [1, 2, 3],
                Resampling.average, nodata=0, target_m=args.imagery_m, jobs=args.jobs,
            )
            print(f'  imagery merged in {time.time() - t0:.1f}s')
            if used > 0:
                path = os.path.join(args.out, 'imagery.tif')
                write_tif(path, out, transform, nodata=0)
                sources['imagery'] = path

    os.makedirs(args.out, exist_ok=True)
    index = os.path.join(args.out, 'sources.json')
    # Register what is on disk, not just what this run produced: fetching one
    # source on its own is normal, and it must not un-register the other. The
    # directory is the truth here rather than the previous index, which may
    # itself have been written by a run that dropped something.
    for key in ('landcover', 'imagery'):
        candidate = os.path.join(args.out, f'{key}.tif')
        if key not in sources and os.path.exists(candidate):
            sources[key] = candidate
            print(f'keeping existing {candidate}')
    with open(index, 'w', encoding='utf-8') as fh:
        json.dump(sources, fh, indent=2)
        fh.write('\n')
    print(f'\nwrote {index}')
    print(f'done in {time.time() - started:.1f}s')
    print('next: python tools/bake_planet_cover.py')


if __name__ == '__main__':
    main()

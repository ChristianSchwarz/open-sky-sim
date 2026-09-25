#!/usr/bin/env python3
"""Turn NOAA ETOPO 2022 (60 arcsec) into the coarse global DEM stage 1 bakes from.

ETOPO carries ocean depth as negative heights. The sim's ocean is flat at sea
level - the pyramid's ``seaLevel`` is 0 and every water tile is built from it -
so bathymetry would only widen the quantisation range and put a seabed under
the water sheet. Heights below zero are therefore clamped to zero.

Land that really is below sea level (the Dead Sea shore, the Netherlands, the
Caspian depression) is clamped with the rest. The pyramid's own coast mask
decides what is water at the resolutions where that matters; this raster only
has to be right about relief, and a few hundred metres of depression is not
visible at a 1.85 km pixel.

The output is an axis-aligned EPSG:4326 GeoTIFF, the shape ``bake_planet_dem.py``
and ``merge_planet_dem.py`` take, written in row strips so the 466 MB source is
never held whole.

Usage::

    python tools/prep_global_dem.py \\
        --input data/global/ETOPO_2022_v1_60s_N90W180_surface.tif \\
        --out data/global/global_dem.tif

Requires ``rasterio`` and ``numpy``.
"""

from __future__ import annotations

import argparse
import sys
from typing import Iterable, Optional

import numpy as np
import rasterio
from rasterio.windows import Window

STRIP_ROWS = 512


def prep(input_path: str, out_path: str) -> int:
    with rasterio.open(input_path) as src:
        # ETOPO is tagged EPSG:9518, a WGS 84 realisation that differs from
        # EPSG:4326 by centimetres. Any geographic CRS will do; it is restamped.
        if src.crs is None or not src.crs.is_geographic:
            print(f'{input_path}: expected a geographic CRS, got {src.crs}', file=sys.stderr)
            return 1
        profile = src.profile.copy()
        profile.update(dtype='float32', compress='deflate', predictor=3, tiled=True,
                       blockxsize=256, blockysize=256, count=1, nodata=None, crs='EPSG:4326')
        lowest = np.inf
        highest = -np.inf
        clamped = 0
        total = 0
        with rasterio.open(out_path, 'w', **profile) as dst:
            for row in range(0, src.height, STRIP_ROWS):
                rows = min(STRIP_ROWS, src.height - row)
                window = Window(0, row, src.width, rows)
                strip = src.read(1, window=window).astype(np.float32)
                if src.nodata is not None:
                    strip[strip == src.nodata] = 0.0
                strip[~np.isfinite(strip)] = 0.0
                lowest = min(lowest, float(strip.min()))
                highest = max(highest, float(strip.max()))
                below = strip < 0.0
                clamped += int(below.sum())
                total += strip.size
                np.maximum(strip, 0.0, out=strip)
                dst.write(strip, 1, window=window)
    print(f'{src.width}x{src.height} px, height range {lowest:.0f} .. {highest:.0f} m in the source')
    print(f'clamped {clamped / total * 100:.1f}% of pixels (ocean and depressions) to 0 m')
    print(f'wrote {out_path}')
    return 0


def main(argv: Optional[Iterable[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--input', required=True, help='ETOPO 2022 60s surface GeoTIFF')
    ap.add_argument('--out', default='data/global/global_dem.tif')
    args = ap.parse_args(argv)
    return prep(args.input, args.out)


if __name__ == '__main__':
    sys.exit(main())

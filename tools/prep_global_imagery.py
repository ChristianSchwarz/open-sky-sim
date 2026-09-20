#!/usr/bin/env python3
"""Georeference NASA Blue Marble (500 m, 21600x10800 JPEG) as an EPSG:4326 GeoTIFF.

The Blue Marble Next Generation JPEGs are plain equirectangular pictures with
no georeferencing: column 0 is 180 W, row 0 is 90 N, and they cover the whole
sphere. ``bake_planet_cover.py`` reads imagery as GeoTIFFs, so this stamps the
world bounds onto the picture and writes it tiled and compressed, in row strips
so the 700 MB decoded image is never held whole.

Usage::

    python tools/prep_global_imagery.py \
        --input data/global/bluemarble_june_21600x10800.jpg \
        --out data/global/bluemarble.tif

Requires ``rasterio``.
"""

from __future__ import annotations

import argparse
import sys
from typing import Iterable, Optional

import rasterio
from rasterio.transform import from_bounds
from rasterio.windows import Window

STRIP_ROWS = 512


def prep(input_path: str, out_path: str) -> int:
    with rasterio.open(input_path) as src:
        if src.count < 3:
            print(f'{input_path}: expected an RGB image, got {src.count} bands', file=sys.stderr)
            return 1
        if src.width != 2 * src.height:
            print(f'{input_path}: {src.width}x{src.height} is not a 2:1 world map', file=sys.stderr)
            return 1
        profile = {
            'driver': 'GTiff', 'dtype': 'uint8', 'count': 3,
            'width': src.width, 'height': src.height,
            'crs': 'EPSG:4326', 'transform': from_bounds(-180, -90, 180, 90, src.width, src.height),
            'compress': 'deflate', 'tiled': True, 'blockxsize': 256, 'blockysize': 256,
            'photometric': 'RGB',
        }
        with rasterio.open(out_path, 'w', **profile) as dst:
            for row in range(0, src.height, STRIP_ROWS):
                rows = min(STRIP_ROWS, src.height - row)
                window = Window(0, row, src.width, rows)
                dst.write(src.read([1, 2, 3], window=window), window=window)
    print(f'wrote {out_path} ({src.width}x{src.height}, world bounds)')
    return 0


def main(argv: Optional[Iterable[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--input', required=True, help='Blue Marble 21600x10800 JPEG')
    ap.add_argument('--out', default='data/global/bluemarble.tif')
    args = ap.parse_args(argv)
    return prep(args.input, args.out)


if __name__ == '__main__':
    sys.exit(main())

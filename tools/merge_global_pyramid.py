#!/usr/bin/env python3
"""Merge a coarse global pyramid into an existing regional ``assets/planet`` tree.

The regional tree holds detailed heights and cover for a few baked areas and
nothing anywhere else. A coarse global pyramid (``prep_global_dem.py`` ->
``bake_planet_dem.py`` -> ``bake_planet_cover.py``, z0..z6) holds a rough
version of the whole world. This tool puts the two together so the planet is
never empty.

Why it is not a copy. A regional tile at z6 or above that overlaps an area
is an *ancestor*: the DEM bake built it from its four children and filled any
quadrant it had no data for with sea level. Overwriting it with the global tile
would throw the area's detail away; keeping it would leave fake ocean beside
real land. So every tile at or below the global tree's deepest level is built
node by node:

    node inside a baked area's box   -> the regional tile's height and cover
    any other node                   -> the global tile's

Each of those tiles is independent of its neighbours and of its own children
(a composite is never decimated from anything), so there is no ancestor to
repair afterwards. Tiles deeper than the global tree are not touched.

A tile the regional tree lacks is copied across as it is. ``.lvr`` and ``.lwm``
coast files stay with the regional tiles that own them.

Stages 3+ then need re-running for the changed tiles: the mesh
(``bake_planet_mesh.ts --max-zoom N``) and the far textures.

Usage::

    python tools/merge_global_pyramid.py --global data/global/scratch-pdm --out assets/planet

Requires ``numpy``.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from typing import Dict, List, Optional, Set, Tuple

import numpy as np

import bake_planet_cover as cover
import bake_planet_dem as dem

Box = Tuple[float, float, float, float]

# Edge nodes sit exactly on the box; a hair of slack keeps them inside.
BOX_EPS = 1e-9


def area_boxes(manifest: dict) -> List[Box]:
    return [(a['west'], a['south'], a['east'], a['north']) for a in manifest.get('areas', [])]


def inside_mask(z: int, x: int, y: int, n: int, boxes: List[Box]) -> np.ndarray:
    """Which of a tile's ``n * n`` nodes fall inside any baked area.

    Row 0 is the tile's north edge and column 0 its west edge, the layout every
    stage of the bake uses.
    """
    west, south, east, north = cover.tile_bounds(z, x, y)
    lons = west + (east - west) * np.arange(n) / (n - 1)
    lats = north - (north - south) * np.arange(n) / (n - 1)
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    mask = np.zeros((n, n), dtype=bool)
    for bw, bs, be, bn in boxes:
        mask |= (lon_grid >= bw - BOX_EPS) & (lon_grid <= be + BOX_EPS) \
            & (lat_grid >= bs - BOX_EPS) & (lat_grid <= bn + BOX_EPS)
    return mask


def classify_from_imagery(colors: np.ndarray, heights: np.ndarray) -> np.ndarray:
    """A landcover class for every node, guessed from its colour and height.

    The global tree has satellite colour and no landcover raster, so every node
    comes out of the cover bake as ``CLS_UNKNOWN`` - and the three class-driven
    colour modes (landcover, hybrid, swatch) then paint the whole planet one
    tone. Blue Marble is a composite of what the ground looks like from orbit,
    so its colour is a fair stand-in: white is snow, dark green is forest,
    lighter green is grass, olive is scrub, pale tan is sand, the rest is bare
    ground. Ocean is anything at or below sea level, whatever colour it is.

    Coarse on purpose. It only has to send a 2 km node to the right tone.
    """
    rgb = colors.astype(np.float64)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    peak = rgb.max(axis=-1)
    sat = (peak - rgb.min(axis=-1)) / np.maximum(peak, 1.0)
    lum = 0.30 * r + 0.59 * g + 0.11 * b

    out = np.full(colors.shape[:2], cover.CLS_BARE, dtype=np.uint8)
    green = (g >= r * 1.02) & (g >= b * 1.05)
    out[green] = cover.CLS_GRASS
    out[green & (r >= g * 0.93)] = cover.CLS_SHRUB
    out[green & (lum < 80)] = cover.CLS_TREE
    out[(~green) & (lum >= 150) & (sat < 0.45) & (r >= g)] = cover.CLS_SAND
    out[(lum > 185) & (sat < 0.14)] = cover.CLS_SNOW
    out[heights <= 0.5] = cover.CLS_WATER
    return out


def reclassify_tile(root: str, z: int, x: int, y: int, boxes: List[Box]) -> bool:
    """Give a global-sourced node its class, leaving the areas' own cover alone."""
    plc = os.path.join(root, str(z), str(x), f'{y}.plc')
    tile = dem.read_tile(root, z, x, y)
    if tile is None or not os.path.exists(plc):
        return False
    heights = np.nan_to_num(tile[0], nan=0.0)
    classes, colors, flags = cover.decode_plc(plc)
    n = classes.shape[0]
    outside = ~inside_mask(z, x, y, n, boxes)
    fresh = classify_from_imagery(colors, heights)
    merged = np.where(outside & (classes == cover.CLS_UNKNOWN), fresh, classes).astype(np.uint8)
    if np.array_equal(merged, classes):
        return False
    with open(plc, 'wb') as fh:
        fh.write(cover.encode_plc(n, flags, merged, np.ascontiguousarray(colors)))
    return True


def load_index(root: str) -> Dict[int, Set[Tuple[int, int]]]:
    with open(os.path.join(root, 'index.bin'), 'rb') as fh:
        return dem.unpack_index(fh.read())


def copy_tile(src_root: str, dst_root: str, z: int, x: int, y: int, exts: Tuple[str, ...]) -> int:
    copied = 0
    for ext in exts:
        src = os.path.join(src_root, str(z), str(x), f'{y}{ext}')
        if not os.path.exists(src):
            continue
        dst_dir = os.path.join(dst_root, str(z), str(x))
        os.makedirs(dst_dir, exist_ok=True)
        shutil.copyfile(src, os.path.join(dst_dir, f'{y}{ext}'))
        copied += 1
    return copied


def composite_tile(
    global_root: str, out_root: str, z: int, x: int, y: int, boxes: List[Box],
) -> Optional[str]:
    """Rewrite one regional tile with global data outside the baked areas."""
    regional = dem.read_tile(out_root, z, x, y)
    if regional is None:
        return None
    reg_grid, reg_err = regional
    n = reg_grid.shape[0]
    inside = inside_mask(z, x, y, n, boxes)

    glob = dem.read_tile(global_root, z, x, y)
    if glob is None:
        # Open ocean in the global tree: outside the areas the tile is sea level.
        glob_grid, glob_err = np.full((n, n), 0.0), 0.0
    else:
        glob_grid, glob_err = glob
        glob_grid = np.nan_to_num(glob_grid, nan=0.0)
    reg_clean = np.where(np.isfinite(reg_grid), reg_grid, 0.0)
    merged = np.where(inside, reg_clean, glob_grid)
    blob = dem.encode_tile(merged, max(reg_err, glob_err))
    dem.write_tile(out_root, z, x, y, blob)

    reg_plc = os.path.join(out_root, str(z), str(x), f'{y}.plc')
    glob_plc = os.path.join(global_root, str(z), str(x), f'{y}.plc')
    note = 'heights'
    if os.path.exists(reg_plc) and os.path.exists(glob_plc):
        rc, rcol, rflags = cover.decode_plc(reg_plc)
        gc, gcol, gflags = cover.decode_plc(glob_plc)
        classes = np.where(inside, rc, gc).astype(np.uint8)
        colors = np.where(inside[..., None], rcol, gcol).astype(np.uint8)
        with open(reg_plc, 'wb') as fh:
            fh.write(cover.encode_plc(n, rflags | gflags, classes, colors))
        note = 'heights+cover'
    return note


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--global', dest='global_root', required=True, help='coarse global pyramid to merge in')
    ap.add_argument('--out', default='assets/planet', help='regional pyramid, edited in place')
    ap.add_argument('--dry-run', action='store_true', help='report what would change and write nothing')
    ap.add_argument('--reclassify', action='store_true',
                    help='only classify unknown global nodes in an already merged tree, in place')
    args = ap.parse_args()

    with open(os.path.join(args.out, 'manifest.json'), encoding='utf-8') as fh:
        manifest = json.load(fh)
    with open(os.path.join(args.global_root, 'manifest.json'), encoding='utf-8') as fh:
        gmanifest = json.load(fh)
    boxes = area_boxes(manifest)
    if not boxes:
        print('error: the regional manifest lists no areas, so there is nothing to protect', file=sys.stderr)
        return 1
    global_max = gmanifest['maxZoom']
    if args.reclassify:
        changed = 0
        for z, tiles in sorted(load_index(args.out).items()):
            if z > global_max:
                continue
            for (x, y) in sorted(tiles):
                changed += reclassify_tile(args.out, z, x, y, boxes)
        print(f'reclassified {changed} tiles')
        return 0
    regional = load_index(args.out)
    glob = load_index(args.global_root)
    print(f'regional areas: {len(boxes)}; global z0..{global_max}')

    merged_index: Dict[int, Set[Tuple[int, int]]] = {z: set(t) for z, t in regional.items()}
    composited = copied = 0
    for z in range(0, global_max + 1):
        have = regional.get(z, set())
        for (x, y) in sorted(glob.get(z, set()) | have):
            if (x, y) in have:
                composited += 1
                if not args.dry_run:
                    composite_tile(args.global_root, args.out, z, x, y, boxes)
            else:
                copied += 1
                if not args.dry_run:
                    copy_tile(args.global_root, args.out, z, x, y, ('.pdm', '.plc'))
                merged_index.setdefault(z, set()).add((x, y))
        print(f'  z{z}: {len(have)} regional, {len(glob.get(z, set()))} global, {len(merged_index.get(z, set()))} after')
    print(f'{composited} tiles composited, {copied} copied from the global tree')
    if args.dry_run:
        return 0
    reclassified = sum(
        reclassify_tile(args.out, z, x, y, boxes)
        for z, tiles in merged_index.items() if z <= global_max for (x, y) in tiles)
    print(f'{reclassified} tiles had unknown global nodes classified from imagery')

    with open(os.path.join(args.out, 'index.bin'), 'wb') as fh:
        fh.write(dem.pack_index(dem.index_levels(merged_index)))
    manifest['global'] = {
        'maxZoom': global_max,
        'sources': ['NOAA ETOPO 2022 60 arcsec surface', 'NASA Blue Marble Next Generation, June'],
    }
    manifest['heightMax'] = max(manifest.get('heightMax', 0.0), gmanifest.get('heightMax', 0.0))
    with open(os.path.join(args.out, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2)
        fh.write('\n')
    print('index.bin and manifest.json rewritten')
    return 0


if __name__ == '__main__':
    sys.exit(main())

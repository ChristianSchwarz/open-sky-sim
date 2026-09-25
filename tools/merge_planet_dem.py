#!/usr/bin/env python3
"""Bake a DEM into an *existing* .pdm pyramid instead of replacing it.

``bake_planet_dem.py`` owns the whole tree: it samples one raster, decimates it
all the way to z0, and writes index.bin and manifest.json from just that run.
Running it twice therefore does not give you two areas, it gives you the second
one. This tool is the additive form - it writes the new area's tiles and then
repairs every ancestor those tiles changed.

The repair is the whole problem. Tiles are a global quadtree, so a new area
shares ancestors with everything already baked: a z0 tile is the ancestor of a
hemisphere. ``build_parent`` decimates four children into one parent and fills
any quadrant it was not given with sea level, so rebuilding an ancestor from
only the *new* children would erase whichever siblings came from the previous
bake. The fix is to load those siblings back off disk and hand ``build_parent``
all four - which is what ``decode_tile`` in bake_planet_dem.py exists for.

Dequantising a sibling costs half a quantisation step, a few centimetres on a
tile with kilometres of relief. That is the price of not keeping every source
raster around forever, and it does not compound: a rebuilt ancestor is written
from its children, never from its own previous self.

Where the new area overlaps something already baked, the new data wins.

Usage::

    python tools/merge_planet_dem.py --input data/imports/alps.tif --out assets/planet

Stages 2-4 then have to be re-run for the new area - a merged tile has heights
but no coastline, cover or mesh until they are.

Requires ``rasterio`` and ``numpy``.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import warnings
from typing import Dict, List, Optional, Sequence, Set, Tuple

import numpy as np

warnings.filterwarnings('ignore', category=DeprecationWarning, module='rasterio')

try:
    import rasterio
except ImportError:  # pragma: no cover - dependency hint
    print('error: rasterio is required (pip install rasterio numpy)', file=sys.stderr)
    raise

from bake_planet_dem import (
    DEFAULT_JOBS,
    LAND_EPSILON_M,
    Bounds,
    area_name_for,
    build_parent,
    encode_tile,
    index_levels,
    mask_has_land,
    merge_area,
    open_sampler,
    pack_index,
    parent_geometric_error,
    read_tile,
    sample_leaf_level_parallel,
    tile_bounds,
    tile_range_for_bounds,
    unpack_index,
    write_tile,
)

QUADRANTS = ((0, 0), (1, 0), (0, 1), (1, 1))

# Written by fetch_planet_dem.py. See MARGIN_PX there: the raster deliberately
# reaches past the tiles it owns so edge nodes interpolate, and this says where
# the ownership actually stops.
CLAIM_TAG = 'RETRO_CLAIM_BBOX'


def read_claim(input_path: str) -> Optional[Bounds]:
    """The tile box this raster is authoritative for, if it declares one."""
    with rasterio.open(input_path) as src:
        raw = src.tags().get(CLAIM_TAG)
    if not raw:
        return None
    try:
        west, south, east, north = (float(v) for v in raw.split(','))
    except ValueError:
        print(f'  ignoring unreadable {CLAIM_TAG}: {raw!r}')
        return None
    return Bounds(west, south, east, north)


def load_manifest(out_dir: str) -> dict:
    path = os.path.join(out_dir, 'manifest.json')
    if not os.path.exists(path):
        raise FileNotFoundError(
            f'no pyramid at {out_dir} - there is nothing to merge into. Bake '
            'the first area with bake_planet_dem.py.')
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def load_index(out_dir: str, manifest: dict) -> Dict[int, Set[Tuple[int, int]]]:
    path = os.path.join(out_dir, manifest.get('indexPath', 'index.bin'))
    with open(path, 'rb') as fh:
        return unpack_index(fh.read())


def gather_children(
    out_dir: str,
    z: int,
    parent: Tuple[int, int],
    fresh: Dict[Tuple[int, int], np.ndarray],
    fresh_errors: Dict[Tuple[int, int], float],
    stats: Dict[str, int],
) -> Tuple[Dict[Tuple[int, int], np.ndarray], Dict[Tuple[int, int], float]]:
    """All four children of `parent` at level `z`, new ones plus disk ones.

    `fresh` holds the quadrants this run just produced. Anything missing is
    read back out of the pyramid, because leaving it out would have
    build_parent write sea level over ground a previous bake established.
    """
    px, py = parent
    children: Dict[Tuple[int, int], np.ndarray] = {}
    errors: Dict[Tuple[int, int], float] = {}
    for qx, qy in QUADRANTS:
        quadrant = (qx, qy)
        if quadrant in fresh:
            children[quadrant] = fresh[quadrant]
            errors[quadrant] = fresh_errors.get(quadrant, 0.0)
            continue
        existing = read_tile(out_dir, z, px * 2 + qx, py * 2 + qy)
        if existing is None:
            continue
        grid, err = existing
        children[quadrant] = grid
        errors[quadrant] = err
        stats['reloaded'] += 1
    return children, errors


def merge(args: argparse.Namespace) -> int:
    started = time.time()
    manifest = load_manifest(args.out)
    tile_size = int(manifest['tileSize'])
    max_zoom = int(manifest['maxZoom'])
    min_zoom = int(manifest['minZoom'])
    sea_level = float(manifest.get('seaLevel', 0.0))

    existing_tiles = load_index(args.out, manifest)
    existing_total = sum(len(v) for v in existing_tiles.values())
    print(f'pyramid     {args.out}: {existing_total} tiles, z{min_zoom}..{max_zoom}, '
          f'tileSize {tile_size}')

    sampler = open_sampler(args.input, sea_level)
    src_bounds = sampler.bounds
    node_spacing = (180.0 / (1 << max_zoom)) / (tile_size - 1)
    print(f'source      {args.input}')
    print(f'            lon [{src_bounds.west:.5f}, {src_bounds.east:.5f}] '
          f'lat [{src_bounds.south:.5f}, {src_bounds.north:.5f}]')
    print(f'            {sampler.deg_per_pixel:.8f} deg/px vs z{max_zoom} node '
          f'spacing {node_spacing:.8f} deg')
    if sampler.deg_per_pixel > node_spacing * 2:
        print(f'  NOTE: source is coarser than the pyramid depth; z{max_zoom} '
              'tiles here will be upsampled from it')

    # --- finest level ----------------------------------------------------
    # Tiles come from the claim, heights from the whole raster. The margin
    # between them exists to be sampled, not to be claimed: reading tile
    # candidacy off the raster would hand this area the tiles next door on the
    # strength of two pixels, and fill them with sea.
    claim = read_claim(args.input)
    if claim is None:
        claim = src_bounds
        print('            no claim tag; taking the raster bounds as the tile '
              'claim (edge tiles may not match a neighbour exactly)')
    else:
        print(f'claim       lon [{claim.west:.5f}, {claim.east:.5f}] '
              f'lat [{claim.south:.5f}, {claim.north:.5f}]')

    mask, cell_lon, cell_lat = sampler.land_mask(sea_level)
    x0, y0, x1, y1 = tile_range_for_bounds(max_zoom, claim)
    candidates = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)
                  if mask_has_land(mask, src_bounds, cell_lon, cell_lat,
                                   tile_bounds(max_zoom, x, y))]
    print(f'level {max_zoom:2d}    {len(candidates)} candidate tiles')

    level_grids = sample_leaf_level_parallel(
        args.input, sea_level, candidates, max_zoom, tile_size, args.jobs)
    print(f'level {max_zoom:2d}    {len(level_grids)} tiles with land')
    if not level_grids:
        print('error: no land in the source bbox; nothing to merge', file=sys.stderr)
        return 1

    if args.dry_run:
        touched = len(level_grids)
        keys = set(level_grids)
        for z in range(max_zoom, min_zoom, -1):
            keys = {(x >> 1, y >> 1) for x, y in keys}
            touched += len(keys)
        overlap = len(set(level_grids) & existing_tiles.get(max_zoom, set()))
        print(f'\ndry run: would write {touched} tiles '
              f'({overlap} of the finest overwrite existing ones)')
        return 0

    # --- write, then repair every ancestor -------------------------------
    merged_tiles = {z: set(v) for z, v in existing_tiles.items()}
    level_errors: Dict[int, float] = {}
    tile_errors: Dict[Tuple[int, int], float] = {}
    stats = {'written': 0, 'reloaded': 0, 'bytes': 0}
    height_min = float(manifest.get('heightMin', math.inf))
    height_max = float(manifest.get('heightMax', -math.inf))

    for z in range(max_zoom, min_zoom - 1, -1):
        level_max_error = 0.0
        items = sorted(level_grids.items())
        for i, ((x, y), grid) in enumerate(items):
            err = tile_errors.get((x, y), 0.0)
            level_max_error = max(level_max_error, err)
            finite = np.isfinite(grid)
            if finite.any():
                height_min = min(height_min, float(np.min(grid[finite])))
                height_max = max(height_max, float(np.max(grid[finite])))
            stats['bytes'] += write_tile(args.out, z, x, y, encode_tile(grid, err))
            stats['written'] += 1
            merged_tiles.setdefault(z, set()).add((x, y))
            if len(items) > 40 and (i % max(1, len(items) // 20)) == 0:
                print(f'  writing {i + 1}/{len(items)} at z{z}', flush=True)
        level_errors[z] = level_max_error
        rebuilt = len(level_grids)

        if z == min_zoom:
            print(f'level {z:2d}    wrote {rebuilt} tiles, max error '
                  f'{level_max_error:.2f} m')
            break

        # Group this level's new tiles by parent, then top each parent up with
        # whatever siblings the pyramid already had.
        by_parent: Dict[Tuple[int, int], Dict[Tuple[int, int], np.ndarray]] = {}
        by_parent_err: Dict[Tuple[int, int], Dict[Tuple[int, int], float]] = {}
        for (x, y), grid in level_grids.items():
            key = (x >> 1, y >> 1)
            by_parent.setdefault(key, {})[(x & 1, y & 1)] = grid
            by_parent_err.setdefault(key, {})[(x & 1, y & 1)] = tile_errors.get((x, y), 0.0)

        before_reloaded = stats['reloaded']
        parents: Dict[Tuple[int, int], np.ndarray] = {}
        next_errors: Dict[Tuple[int, int], float] = {}
        for key, fresh in by_parent.items():
            children, errors = gather_children(
                args.out, z, key, fresh, by_parent_err[key], stats)
            parent = build_parent(children, tile_size, sea_level)
            parents[key] = parent
            next_errors[key] = parent_geometric_error(parent, children, errors, tile_size)

        reloaded = stats['reloaded'] - before_reloaded
        print(f'level {z:2d}    wrote {rebuilt} tiles, max error '
              f'{level_max_error:.2f} m, {len(parents)} ancestors to repair'
              + (f' ({reloaded} siblings reloaded)' if reloaded else ''))
        level_grids = parents
        tile_errors = next_errors

    # --- merge the pyramid-wide records ----------------------------------
    with open(os.path.join(args.out, manifest.get('indexPath', 'index.bin')), 'wb') as fh:
        fh.write(pack_index(index_levels(merged_tiles)))

    cov = manifest['coverage']
    # A union box, not a union of boxes. Two distant areas therefore claim
    # everything between them, which nothing in the bake minds - but the
    # runtime walks this rectangle to pin its coarse tier, so it should be
    # driven off index.bin before areas get far apart.
    manifest['coverage'] = {
        'west': min(cov['west'], claim.west),
        'south': min(cov['south'], claim.south),
        'east': max(cov['east'], claim.east),
        'north': max(cov['north'], claim.north),
    }
    manifest['heightMin'] = height_min
    manifest['heightMax'] = height_max
    # Record the area itself, not just its contribution to the union box, so
    # the runtime has somewhere to offer to fly to.
    areas = manifest.get('areas')
    if not areas:
        # A pyramid baked before areas were recorded has none, and its whole
        # coverage is one area by construction. Seed it before appending, or
        # the first import would list only itself and the ground everything was
        # built around would become unnamed and unreachable.
        areas = merge_area([], args.existing_name, Bounds(
            cov['west'], cov['south'], cov['east'], cov['north'],
        ))
        print(f'areas       none recorded; adopting existing coverage as '
              f'"{args.existing_name}"')
    name = area_name_for(args.input, args.name)
    if args.extend_area:
        # A chunked import merges one box after another under one name; each
        # must grow the entry the previous chunk wrote, not replace it.
        prior = next((a for a in areas if a.get('name') == name), None)
        if prior:
            claim = Bounds(
                min(prior['west'], claim.west), min(prior['south'], claim.south),
                max(prior['east'], claim.east), max(prior['north'], claim.north),
            )
    manifest['areas'] = merge_area(areas, name, claim)
    print(f'areas       {", ".join(a["name"] for a in manifest["areas"])}')

    errors = list(manifest.get('levelGeometricErrorM', []))
    while len(errors) <= max_zoom:
        errors.append(0.0)
    for z, err in level_errors.items():
        # Monotone max: an untouched tile elsewhere may still be the worst on
        # its level, and this run never looked at it.
        errors[z] = max(errors[z], err)
    manifest['levelGeometricErrorM'] = errors

    with open(os.path.join(args.out, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2)
        fh.write('\n')

    total = sum(len(v) for v in merged_tiles.values())
    print(f'\nwrote {stats["written"]} tiles ({stats["bytes"] / 1048576:.1f} MB), '
          f'reloaded {stats["reloaded"]} siblings')
    print(f'pyramid now {total} tiles (was {existing_total})')
    print(f'coverage    {manifest["coverage"]}')
    print(f'height      {height_min:.2f} .. {height_max:.2f} m')
    print(f'done in {time.time() - started:.1f}s')
    print('\nnext: re-run stages 2-4 for the new area (coast, cover, mesh)')
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--input', required=True, help='source DEM GeoTIFF for the new area')
    ap.add_argument('--out', default='assets/planet', help='existing pyramid to merge into')
    ap.add_argument('--name', help='name for this area in the manifest '
                                   '(default: the input file stem)')
    ap.add_argument('--existing-name', default='home',
                    help='name to give the coverage already baked, when the '
                         'manifest predates areas being recorded (default: home)')
    ap.add_argument('--extend-area', action='store_true',
                    help='grow an existing area entry of the same name to the '
                         'union with this box instead of replacing it '
                         '(chunked imports)')
    ap.add_argument('--dry-run', action='store_true',
                    help='report what would be written and stop')
    ap.add_argument('--jobs', type=int, default=DEFAULT_JOBS,
                    help=f'worker processes for leaf-tile sampling (default {DEFAULT_JOBS})')
    args = ap.parse_args(argv)
    try:
        return merge(args)
    except (FileNotFoundError, ValueError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())

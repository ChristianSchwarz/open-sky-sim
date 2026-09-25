#!/usr/bin/env python3
"""Diff two .pdm pyramids tile by tile.

Written for the merge spike: the question "does merging area B into a pyramid
already holding area A give the same thing as baking A+B in one go" only has an
answer if the two trees can be compared, and a byte compare cannot answer it
(quantisation is per tile, so a different height range re-quantises everything).

Usage::

    python tools/compare_planet_dem.py --a assets/planet --b /tmp/other
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, Optional, Sequence, Set, Tuple

import numpy as np

from bake_planet_dem import read_tile, unpack_index


def load(out_dir: str) -> Tuple[dict, Dict[int, Set[Tuple[int, int]]]]:
    with open(os.path.join(out_dir, 'manifest.json'), encoding='utf-8') as fh:
        manifest = json.load(fh)
    with open(os.path.join(out_dir, manifest.get('indexPath', 'index.bin')), 'rb') as fh:
        return manifest, unpack_index(fh.read())


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--a', required=True)
    ap.add_argument('--b', required=True)
    ap.add_argument('--tolerance', type=float, default=1.0,
                    help='metres of per-node difference to treat as agreement')
    args = ap.parse_args(argv)

    man_a, idx_a = load(args.a)
    man_b, idx_b = load(args.b)

    keys_a = {(z, x, y) for z, coords in idx_a.items() for x, y in coords}
    keys_b = {(z, x, y) for z, coords in idx_b.items() for x, y in coords}
    only_a = keys_a - keys_b
    only_b = keys_b - keys_a
    print(f'tiles       a={len(keys_a)} b={len(keys_b)} '
          f'only-a={len(only_a)} only-b={len(only_b)}')
    for label, keys in (('only in a', only_a), ('only in b', only_b)):
        for k in sorted(keys)[:8]:
            print(f'  {label}: {k[0]}/{k[1]}/{k[2]}')

    worst: list = []
    agree = 0
    for z, x, y in sorted(keys_a & keys_b):
        ta = read_tile(args.a, z, x, y)
        tb = read_tile(args.b, z, x, y)
        if ta is None or tb is None:
            print(f'  MISSING FILE for indexed tile {z}/{x}/{y}')
            continue
        ga, ea = ta
        gb, eb = tb
        both = np.isfinite(ga) & np.isfinite(gb)
        diff = np.abs(ga[both] - gb[both]) if both.any() else np.zeros(1)
        peak = float(diff.max())
        if peak <= args.tolerance:
            agree += 1
        worst.append((peak, float(np.mean(diff)), z, x, y, ea, eb))

    worst.sort(reverse=True)
    print(f'\nagree within {args.tolerance} m: {agree}/{len(worst)} shared tiles')
    print('\nworst tiles:')
    print(f'  {"tile":>12}  {"max diff":>9}  {"mean":>8}  {"err a":>9}  {"err b":>9}')
    for peak, mean, z, x, y, ea, eb in worst[:10]:
        print(f'  {f"{z}/{x}/{y}":>12}  {peak:9.3f}  {mean:8.3f}  {ea:9.2f}  {eb:9.2f}')

    for field in ('coverage', 'heightMin', 'heightMax', 'maxZoom', 'tileSize'):
        va, vb = man_a.get(field), man_b.get(field)
        flag = '' if va == vb else '   <-- differs'
        print(f'{field:12} a={va} b={vb}{flag}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

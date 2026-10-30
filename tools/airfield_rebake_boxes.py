#!/usr/bin/env python3
"""The boxes to re-bake so every airfield's terrain is laid on its pads again.

A change to how airfield pads are baked (tools/bake_osm_airports.py) only
reaches the ground once the leaves under them are re-meshed and re-graded
(tools/rebake_box.ts), and a graded leaf cannot be re-graded in place. This
lists the leaves each airfield's pads reach, joins touching ones into blocks,
and prints one box per block, west,south,east,north, inset so only those
leaves are re-baked - one per line, for a driver to feed rebake_box --bbox.

Usage::

    python tools/airfield_rebake_boxes.py [--area DACH] [--manifest assets/planet/manifest.json]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Dict, List, Set, Tuple

LEAF_ZOOM = 12
INSET_DEG = 1e-5


def leaf_of(lon: float, lat: float) -> Tuple[int, int]:
    span = 180.0 / (1 << LEAF_ZOOM)
    return int(math.floor((lon + 180.0) / span)), int(math.floor((90.0 - lat) / span))


def pad_leaves(pad: dict) -> Set[Tuple[int, int]]:
    """The leaves a pad's circumscribed reach touches."""
    reach = math.hypot(pad['halfD'] + pad['featherM'], pad['halfW'] + pad['featherM'])
    dlat = reach / 110540.0
    dlon = reach / (111320.0 * max(0.05, math.cos(math.radians(pad['lat']))))
    x0, y1 = leaf_of(pad['lon'] - dlon, pad['lat'] - dlat)
    x1, y0 = leaf_of(pad['lon'] + dlon, pad['lat'] + dlat)
    return {(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)}


def blocks(leaves: Set[Tuple[int, int]]) -> List[Set[Tuple[int, int]]]:
    """Leaves joined into 8-connected blocks."""
    seen: Set[Tuple[int, int]] = set()
    out = []
    for start in sorted(leaves):
        if start in seen:
            continue
        block, todo = set(), [start]
        seen.add(start)
        while todo:
            x, y = todo.pop()
            block.add((x, y))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    n = (x + dx, y + dy)
                    if n in leaves and n not in seen:
                        seen.add(n)
                        todo.append(n)
        out.append(block)
    return out


def box_of(block: Set[Tuple[int, int]]) -> List[float]:
    span = 180.0 / (1 << LEAF_ZOOM)
    xs = [x for x, _ in block]
    ys = [y for _, y in block]
    return [-180.0 + min(xs) * span + INSET_DEG, 90.0 - (max(ys) + 1) * span + INSET_DEG,
            -180.0 + (max(xs) + 1) * span - INSET_DEG, 90.0 - min(ys) * span - INSET_DEG]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--manifest', default='assets/planet/manifest.json')
    ap.add_argument('--area', help='only the airfields of this area')
    args = ap.parse_args()
    with open(args.manifest, encoding='utf-8') as fh:
        items = (json.load(fh).get('airfields') or {}).get('items') or []
    leaves: Set[Tuple[int, int]] = set()
    for airfield in items:
        if args.area and airfield.get('area') != args.area:
            continue
        for pad in airfield.get('pads') or []:
            leaves |= pad_leaves(pad)
    found = blocks(leaves)
    # Biggest blocks first, so a driver resumed part way has done the most.
    found.sort(key=lambda b: -len(b))
    for block in found:
        print(','.join(f'{v:.6f}' for v in box_of(block)))
    rect = sum((lambda b: (max(x for x, _ in b) - min(x for x, _ in b) + 1)
                * (max(y for _, y in b) - min(y for _, y in b) + 1))(b) for b in found)
    print(f'{len(leaves)} leaves in {len(found)} blocks, {rect} leaves in their boxes', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

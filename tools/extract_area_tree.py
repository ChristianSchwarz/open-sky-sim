#!/usr/bin/env python3
"""Copy one baked area out of the terrain tree into a stand-alone tree.

The full ``assets/terrain`` holds every imported area and is far too big for
static hosting such as GitHub Pages. This writes a second tree that holds only
the tiles one area's box touches, at every level, with indexes, manifest and
airfields cut down to match, so it can be deployed on its own
(``npm run deploy:pages -- --terrain <out>``) or tried locally with
``?terrain=terrain-<name>``.

Ancestors are copied as they are: a coarse tile (z0-z2) that also covers
another area still shows that area's ground, but only from altitudes where the
globe map is drawn over everything outside the manifest's areas. Index entries
the copy leaves out read as sea at runtime, like any unbaked quadrant.

Bake caches the runtime never reads (``index_meta.json``,
``ground_means.json``, ``swatch_histogram.bin``) are not copied.

Usage::

    python tools/extract_area_tree.py --area Mallorca --out assets/terrain-mallorca
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from typing import Dict, Optional, Sequence

from bake_planet_dem import Bounds, tile_bounds, unpack_index
from delete_area import pack_full_index


def load_json(path: str) -> dict:
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def save_json(path: str, doc: dict) -> None:
    with open(path, 'w', encoding='utf-8') as fh:
        json.dump(doc, fh, separators=(',', ':'))


def in_box(p: dict, box: Bounds) -> bool:
    return box.west <= p['lon'] <= box.east and box.south <= p['lat'] <= box.north


def tile_layers(manifest: dict) -> Dict[str, dict]:
    """Every manifest entry that is a tile layer: a path template plus an index."""
    return {k: v for k, v in manifest.items()
            if isinstance(v, dict) and 'indexPath' in v and '{z}' in v.get('path', '')}


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--area', required=True, help='area name in the manifest')
    ap.add_argument('--src', default='assets/terrain', help='full terrain tree')
    ap.add_argument('--out', required=True, help='tree to write (replaced if it exists)')
    args = ap.parse_args(argv)

    src = os.path.abspath(args.src)
    out = os.path.abspath(args.out)
    if out == src:
        sys.exit('--out must not be the source tree')
    manifest = load_json(os.path.join(src, 'manifest.json'))
    area = next((a for a in manifest.get('areas', []) if a['name'] == args.area), None)
    if area is None:
        names = ', '.join(a['name'] for a in manifest.get('areas', []))
        sys.exit(f'no area "{args.area}" (have: {names})')
    box = Bounds(float(area['west']), float(area['south']),
                 float(area['east']), float(area['north']))
    # A capped area's runtime quadtree stops at its leaves; anything finer
    # left over from an earlier full-depth bake would only be dead weight.
    max_zoom = int(area.get('leafZoom', 99))

    if os.path.exists(out):
        if not os.path.exists(os.path.join(out, 'manifest.json')):
            sys.exit(f'{out} exists and is not a terrain tree; not replacing it')
        shutil.rmtree(out)
    os.makedirs(out)

    total_files = 0
    total_bytes = 0
    for name, layer in tile_layers(manifest).items():
        index_rel = layer['indexPath']
        index_path = os.path.join(src, index_rel)
        if not os.path.exists(index_path):
            continue
        ext = os.path.splitext(layer['path'])[1]
        with open(index_path, 'rb') as fh:
            index = unpack_index(fh.read())
        zooms = sorted(index)
        kept: Dict[int, set] = {}
        files = 0
        size = 0
        for z in zooms:
            if z > max_zoom:
                continue
            for (x, y) in index[z]:
                if not tile_bounds(z, x, y).intersects(box):
                    continue
                rel = os.path.join(str(z), str(x), f'{y}{ext}')
                tile = os.path.join(src, rel)
                if not os.path.exists(tile):
                    continue
                os.makedirs(os.path.join(out, str(z), str(x)), exist_ok=True)
                shutil.copyfile(tile, os.path.join(out, rel))
                kept.setdefault(z, set()).add((x, y))
                files += 1
                size += os.path.getsize(tile)
        # Same level range as the source: the runtime reads min/max zoom off it.
        with open(os.path.join(out, index_rel), 'wb') as fh:
            fh.write(pack_full_index(kept, zooms[0] if zooms else 0,
                                     zooms[-1] if zooms else 0))
        print(f'{name:10s} {files:6d} tiles {size / 1e6:8.1f} MB')
        total_files += files
        total_bytes += size

    coverage = {k: area[k] for k in ('west', 'south', 'east', 'north')}
    manifest['areas'] = [area]
    manifest['coverage'] = coverage
    if isinstance(manifest.get('flattenPads'), list):
        manifest['flattenPads'] = [p for p in manifest['flattenPads'] if in_box(p, box)]
    af = manifest.get('airfields')
    if af and af.get('path'):
        doc = load_json(os.path.join(src, af['path']))
        doc['items'] = [i for i in doc.get('items', []) if in_box(i, box)]
        doc['coverage'] = coverage
        af['count'] = len(doc['items'])
        save_json(os.path.join(out, af['path']), doc)
        print(f'airfields  {af["count"]:6d}')
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2)
    print(f'total      {total_files:6d} tiles {total_bytes / 1e6:8.1f} MB -> {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

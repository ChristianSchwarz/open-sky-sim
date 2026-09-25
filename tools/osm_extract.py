#!/usr/bin/env python3
"""Resolve a bbox to a local `.osm.pbf`, downloading and clipping it if needed.

This is what makes `--pbf` automatic: every import used to either hit the
live Overpass mirrors (slow, 429/504-prone on a real area) or need a human to
hand-pick and download a Geofabrik extract first (see tools/README.md before
2026-09-24). Neither is what the in-app importer should do, so this script
does the whole thing without a human in the loop:

1. Fetch and cache Geofabrik's own extract index (`index-v1.json`), which
   lists every region it publishes together with a `.osm.pbf` URL and a
   polygon of what it covers.
2. Pick the smallest region whose polygon's bbox fully contains the requested
   bbox — small beats big so a country extract is preferred over its
   continent when both cover the box.
3. Download that region's raw `.osm.pbf` once, into `data/imports/geofabrik/`,
   and keep it there: the next import inside the same region reuses it.
4. Clip it down to the requested bbox with `clip_pbf.clip_pbf`, into
   `data/imports/pbf/<bbox>.osm.pbf` — the file every bake stage actually
   reads, sized to the bbox rather than the whole region (see clip_pbf.py's
   own docstring for why that matters).
5. Record the downloaded region's coverage in `data/osm-cache/extracts.json`,
   so the importer's map can shade "you already have this on disk".

Usage::

    python tools/osm_extract.py --bbox 7.6,45.9,7.8,46.0 --out data/imports/pbf/area.osm.pbf

Requires ``osmium`` and ``requests``::

    pip install osmium requests
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Dict, List, Optional, Sequence, Tuple

try:
    import requests
except ImportError:
    print('error: requests is required (pip install requests)', file=sys.stderr)
    raise

try:
    import osmium  # noqa: F401  (clip_pbf needs it; fail early with the same message it would)
except ImportError:
    print('error: osmium is required (pip install osmium)', file=sys.stderr)
    raise

from clip_pbf import clip_pbf
from osm_common import glue_negative_bbox

GEOFABRIK_INDEX_URL = 'https://download.geofabrik.de/index-v1.json'
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_CACHE = os.path.join(PROJECT_ROOT, 'data', 'osm-cache', 'geofabrik-index.json')
REGIONS_DIR = os.path.join(PROJECT_ROOT, 'data', 'imports', 'geofabrik')
COVERAGE_FILE = os.path.join(PROJECT_ROOT, 'data', 'osm-cache', 'extracts.json')
# The index changes as Geofabrik adds/splits regions, but not from one import
# to the next - a week-old copy is still the right answer.
INDEX_MAX_AGE_S = 7 * 24 * 3600


def parse_bbox(text: str) -> Tuple[float, float, float, float]:
    parts = [float(p.strip()) for p in text.split(',')]
    if len(parts) != 4:
        raise ValueError('bbox must be west,south,east,north')
    return parts[0], parts[1], parts[2], parts[3]


def load_index(refresh: bool = False) -> dict:
    if not refresh and os.path.exists(INDEX_CACHE):
        age = time.time() - os.path.getmtime(INDEX_CACHE)
        if age < INDEX_MAX_AGE_S:
            with open(INDEX_CACHE, 'r', encoding='utf-8') as fh:
                return json.load(fh)
    print(f'fetching Geofabrik extract index from {GEOFABRIK_INDEX_URL}')
    res = requests.get(GEOFABRIK_INDEX_URL, timeout=60)
    res.raise_for_status()
    data = res.json()
    os.makedirs(os.path.dirname(INDEX_CACHE), exist_ok=True)
    with open(INDEX_CACHE, 'w', encoding='utf-8') as fh:
        json.dump(data, fh)
    return data


def _geometry_bbox(geometry: dict) -> Optional[Tuple[float, float, float, float]]:
    """Min/max lon/lat over every coordinate in a GeoJSON Polygon/MultiPolygon.

    Geofabrik's index ships each region's real coverage polygon, not a bbox,
    but "does this region's bbox contain the requested bbox" is all the
    picker needs - a coarser, cheaper test than true polygon containment, and
    one that never rejects a region whose polygon actually does cover the box
    (only its bounding rectangle is used, which is never smaller than the
    polygon).
    """
    kind = geometry.get('type')
    coords = geometry.get('coordinates')
    if not coords:
        return None
    lons: List[float] = []
    lats: List[float] = []

    def walk(node):
        if isinstance(node, (int, float)):
            return
        if node and isinstance(node[0], (int, float)):
            lons.append(node[0])
            lats.append(node[1])
            return
        for child in node:
            walk(child)

    walk(coords)
    if kind not in ('Polygon', 'MultiPolygon') or not lons:
        return None
    return min(lons), min(lats), max(lons), max(lats)


def find_region(index: dict, bbox: Tuple[float, float, float, float]) -> dict:
    """The smallest Geofabrik region whose bbox fully contains `bbox`."""
    west, south, east, north = bbox
    best: Optional[dict] = None
    best_area: float = float('inf')
    for feature in index.get('features', []):
        props = feature.get('properties', {})
        urls = props.get('urls', {})
        if 'pbf' not in urls:
            continue
        rbbox = _geometry_bbox(feature.get('geometry', {}))
        if not rbbox:
            continue
        rw, rs, re, rn = rbbox
        if rw <= west and rs <= south and re >= east and rn >= north:
            area = (re - rw) * (rn - rs)
            if area < best_area:
                best_area = area
                best = {'id': props.get('id'), 'name': props.get('name', props.get('id')),
                        'pbf_url': urls['pbf'], 'bbox': rbbox}
    if not best:
        raise LookupError(
            f'no Geofabrik region covers [{west},{south},{east},{north}] - '
            'the bbox may fall outside all mapped land, or straddle a region split; '
            'download and pass a covering extract by hand with --pbf instead')
    return best


def _region_path(region_id: str) -> str:
    return os.path.join(REGIONS_DIR, f'{region_id.replace("/", "-")}.osm.pbf')


def ensure_region_downloaded(region: dict) -> str:
    path = _region_path(region['id'])
    if os.path.exists(path):
        return path
    os.makedirs(REGIONS_DIR, exist_ok=True)
    part = f'{path}.part'
    print(f'downloading {region["name"]} ({region["id"]}) from {region["pbf_url"]}')
    started = time.time()
    try:
        with requests.get(region['pbf_url'], stream=True, timeout=(10, 60)) as res:
            res.raise_for_status()
            total = res.headers.get('Content-Length')
            total_mb = int(total) / (1 << 20) if total else None
            got = 0
            with open(part, 'wb') as fh:
                for chunk in res.iter_content(chunk_size=1 << 20):
                    fh.write(chunk)
                    got += len(chunk)
                    got_mb = got / (1 << 20)
                    if total_mb:
                        pct = min(100.0, 100.0 * got / int(total))
                        print(f'\r  {got_mb:.1f}/{total_mb:.1f} MB ({pct:.1f}%)', end='', flush=True)
                    else:
                        print(f'\r  {got_mb:.1f} MB', end='', flush=True)
        print(f'\ndownloaded {region["name"]} in {time.time() - started:.1f}s')
        os.replace(part, path)
    except BaseException:
        try:
            os.remove(part)
        except OSError:
            pass
        raise
    return path


def _record_coverage(region: dict) -> None:
    """Appends/updates this region in the coverage index the importer's map reads."""
    entries: Dict[str, dict] = {}
    if os.path.exists(COVERAGE_FILE):
        try:
            with open(COVERAGE_FILE, 'r', encoding='utf-8') as fh:
                for e in json.load(fh):
                    entries[e['id']] = e
        except (json.JSONDecodeError, KeyError, OSError):
            entries = {}
    west, south, east, north = region['bbox']
    entries[region['id']] = {
        'id': region['id'], 'name': region['name'],
        'west': west, 'south': south, 'east': east, 'north': north,
    }
    os.makedirs(os.path.dirname(COVERAGE_FILE), exist_ok=True)
    with open(COVERAGE_FILE, 'w', encoding='utf-8') as fh:
        json.dump(list(entries.values()), fh, indent=2)


def ensure_extract(
    bbox: Tuple[float, float, float, float], out_path: str, refresh_index: bool = False,
) -> str:
    """Resolves, downloads and clips whatever `.osm.pbf` covers `bbox`, returns `out_path`."""
    if os.path.exists(out_path):
        print(f'{out_path} already covers this bbox, reusing it')
        return out_path
    index = load_index(refresh_index)
    region = find_region(index, bbox)
    region_path = ensure_region_downloaded(region)
    _record_coverage(region)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    clip_pbf(region_path, out_path, bbox)
    return out_path


def main(argv: Sequence[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--bbox', required=True, help='west,south,east,north degrees')
    ap.add_argument('--out', required=True, help='clipped .osm.pbf to write')
    ap.add_argument('--refresh-index', action='store_true', help='re-download the Geofabrik extract index')
    args = ap.parse_args(glue_negative_bbox(list(argv)))

    ensure_extract(parse_bbox(args.bbox), args.out, args.refresh_index)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))

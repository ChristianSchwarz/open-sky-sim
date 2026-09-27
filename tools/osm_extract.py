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
2. Pick the sources that together cover the bbox (see `plan_sources`):
   files already on disk first - a region an earlier import downloaded, or
   an earlier import's clip - then Geofabrik regions for whatever is left.
   Coverage is tested against each region's real polygon: a box across a
   border (Erz: Germany and Czechia) needs two extracts, and no single one
   covers it short of the whole continent.
3. Download each chosen region's raw `.osm.pbf` once, into
   `data/imports/geofabrik/`, and keep it there: the next import inside the
   same region reuses it.
4. Clip each source down to the requested bbox with `clip_pbf.clip_pbf`, and
   merge the clips (duplicates along the border dropped) into
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
from dataclasses import dataclass
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

from shapely.geometry import box, shape
from shapely.ops import unary_union

from clip_pbf import clip_pbf, merge_pbfs
from osm_common import glue_negative_bbox

GEOFABRIK_INDEX_URL = 'https://download.geofabrik.de/index-v1.json'
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_CACHE = os.path.join(PROJECT_ROOT, 'data', 'osm-cache', 'geofabrik-index.json')
REGIONS_DIR = os.path.join(PROJECT_ROOT, 'data', 'imports', 'geofabrik')
CLIPS_DIR = os.path.join(PROJECT_ROOT, 'data', 'imports', 'pbf')
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

    Only a cheap prefilter and the rectangle the importer's map shades. It is
    not a coverage test: DACH's rectangle covers Czechia, its polygon does
    not, and picking by rectangle left Erz's Czech half with no OSM at all
    (2026-09-26).
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


# A set of sources covering all but this share of what needs covering is
# enough: region polygons are hand-drawn and meet with slivers between them.
COVER_TOLERANCE = 0.005


@dataclass(eq=False)
class Source:
    """One candidate file for the clip: on disk (`path`) or to download (`region`)."""
    geom: object
    size: float
    path: Optional[str] = None
    region: Optional[dict] = None

    @property
    def label(self) -> str:
        return self.path or f'{self.region["name"]} ({self.region["id"]})'


def regions_near(index: dict, bbox: Tuple[float, float, float, float]) -> List[Tuple[dict, object]]:
    """Every Geofabrik region with a .pbf whose polygon touches `bbox`, as (feature, geometry)."""
    west, south, east, north = bbox
    target = box(west, south, east, north)
    out = []
    for feature in index.get('features', []):
        props = feature.get('properties', {})
        if 'pbf' not in props.get('urls', {}):
            continue
        rbbox = _geometry_bbox(feature.get('geometry', {}))
        if not rbbox or rbbox[0] > east or rbbox[2] < west or rbbox[1] > north or rbbox[3] < south:
            continue
        geom = shape(feature['geometry'])
        if not geom.is_valid:
            geom = geom.buffer(0)
        if geom.intersects(target):
            out.append((feature, geom))
    return out


def _region_info(feature: dict) -> dict:
    props = feature['properties']
    return {'id': props.get('id'), 'name': props.get('name', props.get('id')),
            'pbf_url': props['urls']['pbf'], 'bbox': _geometry_bbox(feature['geometry'])}


def plan_sources(
    bbox: Tuple[float, float, float, float],
    near: Sequence[Tuple[dict, object]],
    local: Sequence[Source],
) -> List[Source]:
    """The files that together cover `bbox`, on disk first.

    What must be covered is the bbox where any region reaches at all - open
    sea no extract covers needs nothing. Each step takes the candidate
    covering the most of what is left, and among those within a percent of
    it the smallest - by file size on disk, by polygon area online. Files on
    disk go first (Germany beats DACH for a German box; an earlier clip beats
    both), then downloads, continents only once nothing smaller reaches the
    remainder: for Erz that is Germany on disk plus the Czech Republic, not
    Europe, and not seven kraje - scoring coverage per square degree picked
    Prague and then the kraj "with Praha" around it. Raises LookupError when
    no region reaches the bbox.
    """
    west, south, east, north = bbox
    target = box(west, south, east, north)
    if not near:
        raise LookupError(
            f'no Geofabrik region reaches [{west},{south},{east},{north}] - '
            'the bbox may be open sea; pass a covering extract by hand with --pbf instead')
    need = target.intersection(unary_union([g for _, g in near]))
    need_area = need.area
    enough = COVER_TOLERANCE * need_area
    chosen: List[Source] = []
    local_paths = {os.path.normcase(os.path.abspath(s.path)) for s in local if s.path}
    remote = [(f, Source(g, g.area, region=_region_info(f))) for f, g in near
              if os.path.normcase(os.path.abspath(_region_path(f['properties']['id']))) not in local_paths]
    below_continent = [s for f, s in remote if f['properties'].get('parent')]
    continents = [s for f, s in remote if not f['properties'].get('parent')]

    def pick(gains):
        top = max(g for g, _ in gains)
        return min((c for g, c in gains if g >= top - 0.01 * need_area), key=lambda c: c.size)

    uncovered = need
    for candidates in (list(local), below_continent, continents):
        while uncovered.area > enough:
            gains = [(uncovered.intersection(c.geom).area, c) for c in candidates if c not in chosen]
            gains = [(g, c) for g, c in gains if g > enough]
            if not gains:
                break
            chosen.append(pick(gains))
            uncovered = uncovered.difference(chosen[-1].geom)
    if uncovered.area > enough:
        print(f'warning: {100 * uncovered.area / need_area:.1f}% of the bbox is in no extract; '
              'it will have no OSM data')
    return chosen


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
    """Resolves, downloads and clips whatever `.osm.pbf` files cover `bbox`, returns `out_path`."""
    if os.path.exists(out_path):
        print(f'{out_path} already covers this bbox, reusing it')
        return out_path
    index = load_index(refresh_index)
    near = regions_near(index, bbox)
    sources = plan_sources(bbox, near, local_sources(near, out_path))
    if not sources:
        raise LookupError(f'nothing covers {bbox}')
    print('sources     ' + ', '.join(s.label for s in sources))
    paths = []
    for source in sources:
        if source.path:
            paths.append(source.path)
        else:
            paths.append(ensure_region_downloaded(source.region))
            _record_coverage(source.region)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    if len(paths) == 1:
        clip_pbf(paths[0], out_path, bbox)
        return out_path
    # `.pbf` so osmium can tell the format from the name (a bare `.src1`
    # failed to open), but not `*.osm.pbf`, so a half-finished part is never
    # taken for an earlier import's clip.
    parts = [f'{out_path}.src{i}.pbf' for i in range(len(paths))]
    try:
        for src, part in zip(paths, parts):
            clip_pbf(src, part, bbox)
        merge_pbfs(parts, out_path)
    finally:
        for part in parts:
            if os.path.exists(part):
                os.remove(part)
    return out_path


def _bbox_from_clip_name(name: str) -> Optional[Tuple[float, float, float, float]]:
    """`12.6_51.3_14.7_52.4.osm.pbf` -> its bbox; the importer names its clips this way."""
    if not name.endswith('.osm.pbf'):
        return None
    parts = name[:-len('.osm.pbf')].split('_')
    if len(parts) != 4:
        return None
    try:
        west, south, east, north = (float(p) for p in parts)
    except ValueError:
        return None
    return west, south, east, north


def local_sources(near: Sequence[Tuple[dict, object]], out_path: str) -> List[Source]:
    """Every `.osm.pbf` already on disk that a clip could be cut from.

    Two kinds: Geofabrik regions an earlier import downloaded (their polygon
    from the index), and earlier imports' own clips (their bbox, from the
    file name). A clip holds everything in its bbox plus clip_pbf's margin,
    so cutting a box inside it gives the same file cutting the regions would.
    """
    out: List[Source] = []
    by_path = {os.path.normcase(os.path.abspath(_region_path(f['properties']['id']))): g for f, g in near}
    if os.path.isdir(REGIONS_DIR):
        for name in os.listdir(REGIONS_DIR):
            path = os.path.join(REGIONS_DIR, name)
            geom = by_path.get(os.path.normcase(os.path.abspath(path)))
            if geom is not None:
                out.append(Source(geom, os.path.getsize(path), path=path))
    if os.path.isdir(CLIPS_DIR):
        skip = os.path.normcase(os.path.abspath(out_path))
        for name in os.listdir(CLIPS_DIR):
            path = os.path.join(CLIPS_DIR, name)
            cbbox = _bbox_from_clip_name(name)
            if cbbox and os.path.normcase(os.path.abspath(path)) != skip:
                out.append(Source(box(*cbbox), os.path.getsize(path), path=path))
    return out


def main(argv: Sequence[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--bbox', required=True, help='west,south,east,north degrees')
    ap.add_argument('--out', required=True, help='clipped .osm.pbf to write')
    ap.add_argument('--refresh-index', action='store_true', help='re-download the Geofabrik extract index')
    args = ap.parse_args(glue_negative_bbox(list(argv)))
    # Region names are not ASCII ("Ústecký kraj"), and a Windows pipe
    # defaults to cp1252, which raised on the first print of one.
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

    ensure_extract(parse_bbox(args.bbox), args.out, args.refresh_index)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))

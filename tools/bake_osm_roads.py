#!/usr/bin/env python3
"""Bake OSM roads into per-tile vector files (.rvr) in the planet pyramid.

Fetches every ``highway=*`` way of the classes worth drawing from the air,
chains OSM's junction-split ways back into runs, and writes one zlib
``RVR1`` file per DEM tile per zoom with the runs clipped to the tile. The
class set thins with the zoom - a z8 tile carries motorways and trunks, a
z12 leaf everything down to residential streets - so a coarse tile never
carries more line than it can show. ``tools/bake_planet_roads.ts`` drapes
these over the finished meshes into the ``.ptr`` sidecars the runtime
strokes.

Nothing here touches the ``.lvr`` files: roads are their own layer with
their own bake, so widths and class cuts can change without re-fetching the
coast or re-baking a single mesh.

Usage::

    python tools/bake_osm_roads.py --bbox 12.35,50.76,15.12,52.56
    python tools/bake_osm_roads.py --manifest assets/planet/manifest.json

Requires ``shapely`` and ``requests``.
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time
import zlib
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

try:
    from shapely.geometry import LineString, box
    from shapely.strtree import STRtree
except ImportError:
    print('error: shapely is required (pip install shapely)', file=sys.stderr)
    raise

from osm_common import (
    OVERPASS_OUT,
    Bounds,
    glue_negative_bbox,
    load_manifest,
    nodes_map,
    overpass_fetch_cells,
    parse_bbox,
    snap_bounds_to_tiles,
    tagged_width_m,
    tile_bounds,
    tile_range_for_bounds,
    ways_map,
)
from bake_osm_coast import decode_index, scan_pdm_tiles
from osm_bridges import Bridge, encode_rbr, extract_bridges, is_span, polyline_length_m

RVR_MAGIC = b'RVR1'

# Road classes, most important first. The byte travels through the .rvr and
# the .ptr into the runtime, which colours and gates by it, so the order is
# part of the format: tools/bake/rvr.ts and src/script/terrain/ptr.ts hold
# the same table.
ROAD_CLASSES: Tuple[str, ...] = (
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
)
CLASS_BYTE: Dict[str, int] = {name: i for i, name in enumerate(ROAD_CLASSES)}

# Carriageway width when OSM tags neither `width` nor `lanes`, which is most
# ways. A lane is 3.5 m; these are the usual counts plus verges, and they are
# only a floor for the stroke - the renderer holds a pixel minimum anyway.
FALLBACK_WIDTH_M: Dict[str, float] = {
    'motorway': 25.0, 'trunk': 18.0, 'primary': 12.0, 'secondary': 9.0,
    'tertiary': 7.0, 'unclassified': 5.0, 'residential': 5.0,
}
LANE_WIDTH_M = 3.5

# The coarsest class byte a zoom level carries (inclusive). Residential
# streets are three quarters of OSM's road ways and invisible under the
# stroke's pixel floor from any height a coarse tile is drawn at, so they
# reach only the leaf; motorways and trunks are the only roads that read
# from 50 km, so they are all a z8 tile gets. Levels coarser than the first
# entry get nothing.
CLASS_CUT_BY_ZOOM: Dict[int, int] = {
    8: CLASS_BYTE['trunk'],
    9: CLASS_BYTE['trunk'],
    10: CLASS_BYTE['secondary'],
    11: CLASS_BYTE['tertiary'],
    12: CLASS_BYTE['residential'],
}
DEFAULT_MIN_ZOOM = min(CLASS_CUT_BY_ZOOM)

# Douglas-Peucker tolerance in grid cells of the level being written. The
# same figure the coast bake gives a watercourse, for the same reason: the
# line is stroked, not cut against anything, so a dropped vertex costs a
# little shape and no continuity.
LINE_SIMPLIFY_CELLS = 0.5
GRID_CELLS = 256

# The leaf level's tolerance in metres, instead of half a cell (see
# line_tolerance_deg). One and a half: well inside the narrowest road's
# half-width, and the spline through the kept nodes covers the rest.
LEAF_SIMPLIFY_M = 1.5
# Metres per degree of latitude. Used on longitude too, which only makes the
# tolerance tighter east-west, never looser.
METRES_PER_DEGREE = 111320.0

# Fetch cell zoom. Roads are the heaviest thing asked of Overpass here -
# residential streets alone outnumber every water feature several times
# over - so the cells are a quarter the area of the coast bake's z7 ones,
# which keeps a city cell inside the mirrors' timeout.
ROAD_CELL_ZOOM = 8


@dataclass
class Road:
    cls: int
    width_m: float
    line: LineString


def class_cut_for_zoom(z: int) -> Optional[int]:
    """The coarsest class byte zoom `z` carries, or None for a level too coarse for any road."""
    if z < min(CLASS_CUT_BY_ZOOM):
        return None
    return CLASS_CUT_BY_ZOOM.get(z, CLASS_CUT_BY_ZOOM[max(CLASS_CUT_BY_ZOOM)])


def road_class(tags: dict) -> Optional[str]:
    """The base class of a highway way, links folded into their parent, or None."""
    value = tags.get('highway', '')
    if tags.get('area') == 'yes':
        return None
    if value.endswith('_link'):
        value = value[:-5]
    return value if value in CLASS_BYTE else None


def road_width_m(tags: dict, cls: str) -> float:
    tagged = tagged_width_m(tags)
    if tagged is not None:
        return tagged
    lanes = tags.get('lanes')
    if lanes:
        try:
            count = float(str(lanes).split(';')[0])
            if count > 0:
                return count * LANE_WIDTH_M
        except ValueError:
            pass
    return FALLBACK_WIDTH_M[cls]


def overpass_roads_query(c: Bounds) -> str:
    classes = '|'.join(ROAD_CLASSES)
    return f'''[out:json][timeout:240];
(
  way["highway"~"^({classes})(_link)?$"]["area"!="yes"]({c.as_overpass()});
);
{OVERPASS_OUT}
'''


def assemble_roads(data: dict, skip_spans: bool = False) -> List[Road]:
    """Chain the fetched ways into runs, one per class.

    OSM splits a road into a new way at every junction and every change of
    tag, so a motorway is hundreds of ways a few hundred metres long. Drawn
    one way at a time each would start and end its own stroke - a vertex
    pair doubled at every crossroads and a ribbon that breaks there. Two
    ways of the same class meeting end to end at a node nothing else of
    that class touches are one run; a node three or more ways share is a
    junction and the runs end there.
    """
    elements = data.get('elements', [])
    nodes = nodes_map(elements)
    ways = ways_map(elements)

    per_class: Dict[int, List[Tuple[List[int], float]]] = {}
    for way in ways.values():
        tags = way.get('tags', {})
        cls = road_class(tags)
        if cls is None:
            continue
        # The leaf draws a bridge as a deck and a tunnel not at all, so the
        # ground stroke must not also run through the valley under it.
        if skip_spans and is_span(tags):
            continue
        ids = [nid for nid in way.get('nodes', []) if nid in nodes]
        if len(ids) < 2:
            continue
        per_class.setdefault(CLASS_BYTE[cls], []).append((ids, road_width_m(tags, cls)))

    roads: List[Road] = []
    for cls_byte, items in per_class.items():
        for ids, width in _chain(items):
            coords = [nodes[nid] for nid in ids]
            if len(coords) >= 2:
                roads.append(Road(cls_byte, width, LineString(coords)))
    return roads


def _chain(items: Sequence[Tuple[List[int], float]]) -> List[Tuple[List[int], float]]:
    """Join node-id paths end to end wherever exactly two of them meet."""
    ends: Dict[int, List[int]] = {}
    for i, (ids, _w) in enumerate(items):
        ends.setdefault(ids[0], []).append(i)
        ends.setdefault(ids[-1], []).append(i)
    used = [False] * len(items)
    out: List[Tuple[List[int], float]] = []

    def next_at(node: int, current: int) -> Optional[int]:
        touching = ends.get(node, [])
        if len(touching) != 2:
            return None
        other = touching[0] if touching[1] == current else touching[1]
        return None if other == current or used[other] else other

    for i in range(len(items)):
        if used[i]:
            continue
        used[i] = True
        ids = list(items[i][0])
        width = items[i][1]
        # Grow forward from the tail, then backward from the head; `current`
        # is the way whose end sits at the growing node.
        for forward in (True, False):
            current = i
            while ids[0] != ids[-1]:
                node = ids[-1] if forward else ids[0]
                j = next_at(node, current)
                if j is None:
                    break
                used[j] = True
                seg = list(items[j][0])
                width = max(width, items[j][1])
                if forward:
                    if seg[0] != node:
                        seg.reverse()
                    ids.extend(seg[1:])
                else:
                    if seg[-1] != node:
                        seg.reverse()
                    ids = seg[:-1] + ids
                current = j
        out.append((ids, width))
    return out


def clip_roads(
    roads: Sequence[Road], tree: STRtree, b: Bounds, tolerance: float,
) -> List[Tuple[int, float, List[Tuple[float, float]]]]:
    """Clip the runs to a tile as (class, width_m, points) parts, simplified.

    Each part a crossing leaves is kept on its own, like a watercourse: a
    stroke joined across the tile would draw a road through ground it does
    not cover. The clip is to the tile box exactly; the sidecar is draped on
    this tile's own mesh, so a run over the border would be drawn twice at
    two heights.
    """
    tile_box = box(b.west, b.south, b.east, b.north)
    out: List[Tuple[int, float, List[Tuple[float, float]]]] = []
    for idx in tree.query(tile_box):
        road = roads[int(idx)]
        try:
            clipped = road.line.intersection(tile_box)
        except Exception:
            continue
        if clipped.is_empty:
            continue
        parts = ([clipped] if isinstance(clipped, LineString)
                 else [g for g in getattr(clipped, 'geoms', []) if isinstance(g, LineString)])
        for part in parts:
            if tolerance > 0:
                part = part.simplify(tolerance, preserve_topology=False)
            pts = [(float(x), float(y)) for x, y in part.coords]
            if len(pts) >= 2:
                out.append((road.cls, road.width_m, pts))
    out.sort(key=lambda r: r[0])
    return out


def encode_rvr(parts: Sequence[Tuple[int, float, Sequence[Tuple[float, float]]]]) -> bytes:
    """RVR1: u16 count, then per road u8 class, f32 width, u16 n, n x (f32 lon, f32 lat); zlib."""
    payload = bytearray(RVR_MAGIC)
    payload += struct.pack('<H', len(parts))
    for cls, width, pts in parts:
        payload += struct.pack('<Bf H', cls, float(width), len(pts))
        for lon, lat in pts:
            payload += struct.pack('<ff', float(lon), float(lat))
    return zlib.compress(bytes(payload), 6)


def decode_rvr(blob: bytes) -> List[Tuple[int, float, List[Tuple[float, float]]]]:
    payload = zlib.decompress(blob)
    if payload[:4] != RVR_MAGIC:
        raise ValueError('bad RVR magic')
    (count,) = struct.unpack_from('<H', payload, 4)
    off = 6
    out = []
    for _ in range(count):
        cls, width, n = struct.unpack_from('<Bf H', payload, off)
        off += struct.calcsize('<Bf H')
        pts = []
        for _p in range(n):
            lon, lat = struct.unpack_from('<ff', payload, off)
            off += 8
            pts.append((lon, lat))
        out.append((cls, width, pts))
    return out


def rvr_path(out_dir: str, z: int, x: int, y: int) -> str:
    return os.path.join(out_dir, str(z), str(x), f'{y}.rvr')


def write_rvr(out_dir: str, z: int, x: int, y: int, blob: bytes) -> int:
    path = rvr_path(out_dir, z, x, y)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as fh:
        fh.write(blob)
    return len(blob)


def rbr_path(out_dir: str, z: int, x: int, y: int) -> str:
    return os.path.join(out_dir, str(z), str(x), f'{y}.rbr')


def write_rbr(out_dir: str, z: int, x: int, y: int, blob: bytes) -> int:
    path = rbr_path(out_dir, z, x, y)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as fh:
        fh.write(blob)
    return len(blob)


def span_midpoint(points: Sequence[Tuple[float, float]]) -> Tuple[float, float]:
    """The point half way along a polyline by length: the span's owner tile is the one holding it."""
    half = polyline_length_m(points) / 2
    run = 0.0
    for a, b in zip(points, points[1:]):
        leg = polyline_length_m([a, b])
        if leg > 0 and run + leg >= half:
            t = (half - run) / leg
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        run += leg
    return points[-1]


def bridges_by_tile(bridges: Sequence[Bridge], z: int, bbox: Bounds) -> Dict[Tuple[int, int], List[Bridge]]:
    """Each span filed under the one tile of level `z` that holds its midpoint.

    A span is never clipped: cut at a tile border its deck would end in the
    air. It is drawn whole by its owner and may overhang the neighbour.
    """
    out: Dict[Tuple[int, int], List[Bridge]] = {}
    for b in bridges:
        lon, lat = span_midpoint(b.points)
        if not (bbox.west <= lon <= bbox.east and bbox.south <= lat <= bbox.north):
            continue
        x, y, _x1, _y1 = tile_range_for_bounds(z, Bounds(lon, lat, lon, lat))
        out.setdefault((x, y), []).append(b)
    return out


def line_tolerance_deg(z: int, max_zoom: int) -> float:
    """Douglas-Peucker tolerance for zoom `z`, in degrees.

    Half a grid cell everywhere but the leaf. At the leaf a cell is ~19 m, so
    half of one let a node stray ~10 m: on a road 5-25 m wide that put a
    visible corner at every dropped curve node, and the stroke bake smooths
    the line into a spline through what survives, which can only bring back
    the shape the nodes still carry. The leaf is drawn from close enough for
    that shape to show, so it keeps its nodes to LEAF_SIMPLIFY_M.
    """
    cells = ((180.0 / (1 << z)) / GRID_CELLS) * LINE_SIMPLIFY_CELLS
    if z >= max_zoom:
        return min(cells, LEAF_SIMPLIFY_M / METRES_PER_DEGREE)
    return cells


def bake(args: argparse.Namespace) -> int:
    started = time.time()
    manifest_path = args.manifest or os.path.join(args.out, 'manifest.json')
    if not os.path.isfile(manifest_path):
        print(f'error: manifest not found: {manifest_path}', file=sys.stderr)
        return 2
    manifest = load_manifest(manifest_path)
    out_dir = args.out or os.path.dirname(manifest_path)
    max_zoom = manifest.get('maxZoom', 12)
    min_zoom = max(args.min_zoom, manifest.get('minZoom', 0))
    cov = manifest.get('coverage', {})
    asked = parse_bbox(args.bbox) if args.bbox else Bounds(
        cov['west'], cov['south'], cov['east'], cov['north'])
    bbox = snap_bounds_to_tiles(asked, max_zoom)
    print(f'coverage    lon [{bbox.west:.5f}, {bbox.east:.5f}] lat [{bbox.south:.5f}, {bbox.north:.5f}]')
    print(f'zoom        {min_zoom}..{max_zoom}')

    print('fetching OSM roads', flush=True)
    received = [0]

    def on_progress(n: int) -> None:
        if n - received[0] > 4 * 1024 * 1024:
            received[0] = n
            print(f'  {n / 1048576:.1f} MB received', flush=True)

    data = overpass_fetch_cells(overpass_roads_query, bbox, 'roads', args.refresh_osm,
                                on_progress=on_progress, zoom=ROAD_CELL_ZOOM)
    if args.fetch_only:
        print('fetch-only: cache filled, nothing baked')
        return 0
    roads = assemble_roads(data)
    # The leaf's own set, spans left out, only when there are bridge files to
    # replace them: a run of them missing from the leaf and present nowhere
    # else would be a hole in the road.
    leaf_roads = assemble_roads(data, skip_spans=not args.no_bridges)
    way_count = sum(1 for el in data.get('elements', []) if el.get('type') == 'way')
    print(f'assembled   {len(roads)} runs from {way_count} ways')
    if not roads:
        print('no roads in this box; nothing written')
        return 0

    # The .pdm files on disk, topped up from the index, the way the coast
    # bake enumerates them: a road is only worth writing where a mesh will
    # be baked, and that is wherever there are heights.
    index_path = os.path.join(out_dir, manifest.get('indexPath', 'index.bin'))
    tiles = scan_pdm_tiles(out_dir, min_zoom, max_zoom)
    if os.path.isfile(index_path):
        for z, coords in decode_index(index_path, min_zoom, max_zoom).items():
            if coords:
                tiles[z] = coords | tiles.get(z, set())

    total_files = 0
    total_bytes = 0
    total_parts = 0
    removed = 0
    for z in range(min_zoom, max_zoom + 1):
        cut = class_cut_for_zoom(z)
        x0, y0, x1, y1 = tile_range_for_bounds(z, bbox)
        level_tiles = sorted(t for t in tiles.get(z, ()) if x0 <= t[0] <= x1 and y0 <= t[1] <= y1)
        if cut is None or not level_tiles:
            continue
        level_roads = [r for r in (leaf_roads if z >= max_zoom else roads) if r.cls <= cut]
        tree = STRtree([r.line for r in level_roads])
        tol = line_tolerance_deg(z, max_zoom)
        files = 0
        parts_written = 0
        level_bytes = 0
        for x, y in level_tiles:
            parts = clip_roads(level_roads, tree, tile_bounds(z, x, y), tol)
            path = rvr_path(out_dir, z, x, y)
            if not parts:
                if os.path.isfile(path):
                    os.remove(path)
                    removed += 1
                continue
            level_bytes += write_rvr(out_dir, z, x, y, encode_rvr(parts))
            files += 1
            parts_written += len(parts)
        total_files += files
        total_bytes += level_bytes
        total_parts += parts_written
        print(f'level {z:2d}    {files}/{len(level_tiles)} tiles carry roads, '
              f'{parts_written} runs, {level_bytes / 1024:.0f} KB, classes <= {ROAD_CLASSES[cut]}',
              flush=True)

    # Bridges ride only the leaf: a span is a few hundred metres, and the
    # deck and piers are drawn from close enough that a coarser tile has no
    # use for them. Filed by midpoint, never clipped (see bridges_by_tile).
    bridge_files = 0
    bridge_spans = 0
    spans = [] if args.no_bridges else extract_bridges(data)
    owned = bridges_by_tile(spans, max_zoom, bbox)
    on_disk = {t for t in tiles.get(max_zoom, ())}
    for (x, y), items in sorted(owned.items()):
        if (x, y) not in on_disk:
            continue
        write_rbr(out_dir, max_zoom, x, y, encode_rbr(items))
        bridge_files += 1
        bridge_spans += len(items)
    print(f'bridges     {bridge_spans}/{len(spans)} spans in {bridge_files} leaf tiles (.rbr)')

    previous = (manifest.get('roads') or {}).get('coverage')
    merged = {
        'west': min(previous['west'], bbox.west) if previous else bbox.west,
        'south': min(previous['south'], bbox.south) if previous else bbox.south,
        'east': max(previous['east'], bbox.east) if previous else bbox.east,
        'north': max(previous['north'], bbox.north) if previous else bbox.north,
    }
    manifest['roads'] = {
        'path': '{z}/{x}/{y}.rvr',
        'source': 'osm',
        'minZoom': min_zoom,
        'coverage': merged,
        'bridges': {'path': '{z}/{x}/{y}.rbr', 'zoom': max_zoom},
    }
    with open(manifest_path, 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2)
        fh.write('\n')
    print(f'\nwrote {total_files} road tiles, {total_parts} runs, {total_bytes / 1048576:.1f} MB (.rvr)'
          + (f'; removed {removed} stale' if removed else ''))
    print(f'updated {manifest_path} (roads)')
    print(f'done in {time.time() - started:.1f}s')
    return 0


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--manifest', help='planet manifest.json (default: {out}/manifest.json)')
    parser.add_argument('--out', default='assets/planet', help='planet asset directory')
    parser.add_argument('--bbox', help='west,south,east,north degrees (default: manifest coverage)')
    parser.add_argument('--min-zoom', type=int, default=DEFAULT_MIN_ZOOM,
                        help=f'coarsest level that carries roads (default {DEFAULT_MIN_ZOOM})')
    parser.add_argument('--refresh-osm', action='store_true',
                        help='ignore the cached Overpass response and re-fetch')
    parser.add_argument('--no-bridges', action='store_true',
                        help='keep bridge and tunnel ways in the leaf road strokes and write no .rbr')
    parser.add_argument('--fetch-only', action='store_true',
                        help='only fetch the Overpass answers into the cache; bake nothing')
    raw = list(argv) if argv is not None else sys.argv[1:]
    args = parser.parse_args(glue_negative_bbox(raw))
    return bake(args)


if __name__ == '__main__':
    raise SystemExit(main())

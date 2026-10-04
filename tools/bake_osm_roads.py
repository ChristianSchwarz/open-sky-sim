#!/usr/bin/env python3
"""Bake OSM roads and railways into per-tile vector files (.rvr) in the planet pyramid.

Fetches every ``highway=*`` way of the classes worth drawing from the air,
chains OSM's junction-split ways back into runs, and writes one zlib
``RVR1`` file per DEM tile per zoom with the runs clipped to the tile. The
class set thins with the zoom - a z8 tile carries motorways and trunks, a
z12 leaf everything down to residential streets - so a coarse tile never
carries more line than it can show. ``tools/bake_planet_roads.ts`` drapes
these over the finished meshes into the ``.ptr`` sidecars the runtime
strokes.

Railways ride the same files as two more class bytes: ``RAIL_CLASS``
for main lines (``railway=rail|light_rail|narrow_gauge`` with no
``service`` tag) from ``RAIL_MIN_ZOOM`` down, and ``RAIL_SERVICE_CLASS``
for sidings, passing loops, spurs and yards on the leaf only. Tunnels are
left out. Each is fetched as a query and cache of its own, so a road cache
filled before railways existed is still used.

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
import math
import json
import os
import struct
import sys
import time
import zlib
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

try:
    from shapely.geometry import LineString, Point, box
    from shapely.ops import substring
    from shapely.strtree import STRtree
except ImportError:
    print('error: shapely is required (pip install shapely)', file=sys.stderr)
    raise

from osm_pbf import pbf_elements_groups

from osm_common import (
    CLASS_BYTE, ROAD_CLASSES, road_class_byte,
    OVERPASS_OUT,
    Bounds,
    glue_negative_bbox,
    load_manifest,
    replace_file,
    update_manifest,
    nodes_map,
    overpass_fetch_groups,
    parse_bbox,
    snap_bounds_to_tiles,
    tagged_width_m,
    tile_bounds,
    tile_range_for_bounds,
    ways_map,
)
from bake_osm_coast import decode_index, scan_pdm_tiles
from osm_turnouts import TurnoutStats, fit_turnouts
from osm_bridges import (
    Bridge, _layer, classify_structure, decode_rbr, encode_rbr, extract_bridges, is_span, polyline_length_m,
)

RVR_MAGIC = b'RVR1'
# RVR2: the same, but points as float32 offsets from a float64 origin. A
# float32 longitude resolves only ~0.3-0.4 m at 35 E, enough to set a siding
# down beside the main line it leaves and to put kinks in every turnout curve.
RVR2_MAGIC = b'RVR2'

# ROAD_CLASSES / CLASS_BYTE now live in osm_common.py, shared with
# osm_bridges.py; ROAD_CLASSES is re-exported here so the rest of this module
# reads the same as before.

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

# Railways: one class byte past the road classes, so every ordering test on
# road bytes (`cls <= cut`) leaves them out; `keeps_class` lets them in from
# RAIL_MIN_ZOOM. A main line is as long and as straight as a trunk road and
# reads from about as far, but there are fewer of them, so they start one
# level below the motorways.
RAIL_CLASS = len(ROAD_CLASSES)
RAIL_MIN_ZOOM = 9
# Service track - sidings, passing loops beside a main line, spurs, yards -
# on the leaf only: it is what makes a station read as several tracks close
# up, and nothing anyone can pick out from where a coarser tile is drawn.
RAIL_SERVICE_CLASS = RAIL_CLASS + 1
RAIL_SERVICE_MIN_ZOOM = 12
RAIL_CLASSES = (RAIL_CLASS, RAIL_SERVICE_CLASS)
# A turnout's switch zones (osm_turnouts.py), as polylines from the switch:
# along the diverging track and along the through track. Leaf only, never
# drawn: the stroke bake flags the track vertices lying on them.
TRACK_ZONE_DIVERGING_CLASS = RAIL_SERVICE_CLASS + 1
TRACK_ZONE_THROUGH_CLASS = RAIL_SERVICE_CLASS + 2
# A level crossing: the stretch of track a road crosses at grade, as a
# polyline along the track (crossing_parts). Leaf only, never drawn: the
# stroke bake flags the track on it, which then lets the road show through
# with the rails over it.
TRACK_CROSSING_CLASS = RAIL_SERVICE_CLASS + 3
ZONE_CLASSES = (TRACK_ZONE_DIVERGING_CLASS, TRACK_ZONE_THROUGH_CLASS, TRACK_CROSSING_CLASS)
# Everything --rails-only owns in a leaf file: the track and its zones.
TRACK_LAYER_CLASSES = RAIL_CLASSES + ZONE_CLASSES
# Turnout radius by the diverging track's class: a 1:12 turnout on a main
# line, the German 190 m siding turnout on service track.
TURNOUT_RADIUS_M: Dict[int, float] = {RAIL_CLASS: 300.0, RAIL_SERVICE_CLASS: 190.0}
# Leaf simplification for track, metres: a turnout curve simplified to the
# roads' 1.5 m is one chord with a kink at the switch.
RAIL_LEAF_SIMPLIFY_M = 0.05
CLASS_NAMES: Tuple[str, ...] = ROAD_CLASSES + (
    'rail', 'rail_service', 'zone_diverging', 'zone_through', 'crossing')
# A level crossing's track stretch runs this far past the road's edges, metres.
CROSSING_MARGIN_M = 0.5
# The shallowest angle a crossing's length is worked out at: a road meeting
# the track more obliquely is taken as crossing at this.
CROSSING_MIN_DEG = 20.0
# Longest a crossing stretch may be either side of the road's centreline, metres.
CROSSING_MAX_HALF_M = 30.0
RAIL_TYPES = ('rail', 'light_rail', 'narrow_gauge')
# Ballast bed per track. Germany maps a double-track line as two ways a few
# metres apart, so two single-track strokes side by side are the corridor.
RAIL_TRACK_WIDTH_M = 5.0
# Parapets and walkways either side of the track bed on a rail bridge deck.
RAIL_DECK_MARGIN_M = 2.0

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


def keeps_class(cls: int, z: int) -> bool:
    """Whether a tile of zoom `z` carries runs of class byte `cls`."""
    if cls == RAIL_CLASS:
        return z >= RAIL_MIN_ZOOM
    if cls == RAIL_SERVICE_CLASS or cls in ZONE_CLASSES:
        return z >= RAIL_SERVICE_MIN_ZOOM
    cut = class_cut_for_zoom(z)
    return cut is not None and cls <= cut


def rail_class_of(tags: dict) -> Optional[int]:
    """RAIL_CLASS for a main line, RAIL_SERVICE_CLASS for service track, None for neither or underground."""
    if tags.get('railway') not in RAIL_TYPES or tags.get('area') == 'yes':
        return None
    tunnel = tags.get('tunnel')
    if (tunnel and tunnel != 'no') or tags.get('covered') == 'yes':
        return None
    return RAIL_SERVICE_CLASS if tags.get('service') else RAIL_CLASS


def is_main_rail(tags: dict) -> bool:
    """A main line above ground: no sidings or yards."""
    return rail_class_of(tags) == RAIL_CLASS


def is_rail_bridge(tags: dict) -> bool:
    """A main-line railway way carried on a bridge (tunnels never reach here, see is_main_rail)."""
    bridge = tags.get('bridge')
    return rail_class_of(tags) is not None and bool(bridge and bridge != 'no')


def rail_bridges(data: dict) -> List[Bridge]:
    """Every rail bridge span in an answer, one per way, as osm_bridges.extract_bridges does for roads.

    The class byte is the way's rail class, so the bridge bake gives the deck the
    ballast colour and the level above the leaf adds the span back into its
    rail stroke (see child_roads).
    """
    elements = data.get('elements', [])
    nodes = nodes_map(elements)
    out: List[Bridge] = []
    for way in ways_map(elements).values():
        tags = way.get('tags', {})
        if not is_rail_bridge(tags):
            continue
        pts = [nodes[n] for n in way.get('nodes', []) if n in nodes]
        if len(pts) < 2:
            continue
        out.append(Bridge(
            structure=classify_structure(tags, polyline_length_m(pts)),
            deck_width_m=rail_width_m(tags) + RAIL_DECK_MARGIN_M,
            layer=_layer(tags),
            clearance_m=0.0,
            cls=rail_class_of(tags),
            points=[(float(lon), float(lat)) for lon, lat in pts],
        ))
    return out


def rail_width_m(tags: dict) -> float:
    tagged = tagged_width_m(tags)
    if tagged is not None:
        return tagged
    try:
        tracks = int(str(tags.get('tracks', '1')).split(';')[0])
    except ValueError:
        tracks = 1
    return max(1, min(tracks, 8)) * RAIL_TRACK_WIDTH_M


def road_class(tags: dict) -> Optional[str]:
    """The base class name of a highway way, or None. See road_class_byte."""
    byte = road_class_byte(tags)
    return ROAD_CLASSES[byte] if byte is not None else None


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


def road_tag_predicate(tags: dict) -> bool:
    """The same test `overpass_roads_query` encodes as QL, for the PBF path."""
    return road_class_byte(tags) is not None


def overpass_rails_query(c: Bounds) -> str:
    types = '|'.join(RAIL_TYPES)
    return f'''[out:json][timeout:240];
(
  way["railway"~"^({types})$"][!"service"]({c.as_overpass()});
);
{OVERPASS_OUT}
'''


def rail_tag_predicate(tags: dict) -> bool:
    """`overpass_rails_query` for the PBF path (tunnels are dropped at assembly)."""
    return tags.get('railway') in RAIL_TYPES and not tags.get('service')


def overpass_rail_service_query(c: Bounds) -> str:
    types = '|'.join(RAIL_TYPES)
    return f'''[out:json][timeout:240];
(
  way["railway"~"^({types})$"]["service"]({c.as_overpass()});
);
{OVERPASS_OUT}
'''


def rail_service_tag_predicate(tags: dict) -> bool:
    """`overpass_rail_service_query` for the PBF path."""
    return tags.get('railway') in RAIL_TYPES and bool(tags.get('service'))


def merge_answers(*answers: Optional[dict]) -> dict:
    """One element list from several fetches; a node or way in two is kept once."""
    seen: Set[Tuple[str, int]] = set()
    out: List[dict] = []
    for data in answers:
        for el in (data or {}).get('elements', []):
            key = (el.get('type', ''), el.get('id', 0))
            if key in seen:
                continue
            seen.add(key)
            out.append(el)
    return {'elements': out}


def assemble_roads(data: dict, skip_spans: bool = False,
                   turnout_stats: Optional[TurnoutStats] = None) -> List[Road]:
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
        rail = rail_class_of(tags)
        if rail is not None:
            # Like a road bridge: the leaf draws the span as a deck.
            if skip_spans and is_rail_bridge(tags):
                continue
            ids = [nid for nid in way.get('nodes', []) if nid in nodes]
            if len(ids) >= 2:
                per_class.setdefault(rail, []).append((ids, rail_width_m(tags)))
            continue
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
    track: List[Tuple[int, List[int]]] = []
    track_widths: List[float] = []
    for cls_byte, items in per_class.items():
        for ids, width in _chain(items):
            if cls_byte in RAIL_CLASSES:
                track.append((cls_byte, ids))
                track_widths.append(width)
                continue
            coords = [nodes[nid] for nid in ids]
            if len(coords) >= 2:
                roads.append(Road(cls_byte, width, LineString(coords)))
    # Track across both classes at once: a siding leaves a main line.
    stats = turnout_stats if turnout_stats is not None else TurnoutStats()
    fitted = fit_turnouts(track, nodes, TURNOUT_RADIUS_M, stats)
    for (cls_byte, _ids), width, coords in zip(track, track_widths, fitted):
        if len(coords) >= 2:
            roads.append(Road(cls_byte, width, LineString(coords)))
    for t in stats.turnouts:
        if len(t.diverging_zone) >= 2:
            roads.append(Road(TRACK_ZONE_DIVERGING_CLASS, 0.0, LineString(t.diverging_zone)))
        if len(t.through_zone) >= 2:
            roads.append(Road(TRACK_ZONE_THROUGH_CLASS, 0.0, LineString(t.through_zone)))
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
    track_tolerance: Optional[float] = None,
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
        tol = track_tolerance if track_tolerance is not None and road.cls in TRACK_LAYER_CLASSES else tolerance
        for part in parts:
            if tol > 0:
                part = part.simplify(tol, preserve_topology=False)
            pts = [(float(x), float(y)) for x, y in part.coords]
            if len(pts) >= 2:
                out.append((road.cls, road.width_m, pts))
    out.sort(key=lambda r: r[0])
    return out


def crossing_parts(
    parts: Sequence[Tuple[int, float, Sequence[Tuple[float, float]]]], b: Bounds,
) -> List[Tuple[int, float, List[Tuple[float, float]]]]:
    """Level crossings in one leaf tile's parts, as TRACK_CROSSING_CLASS polylines along the track.

    A road crossing a track in the leaf is at grade: both draw their bridges
    as decks and their tunnels not at all, so neither carries a span here.
    The stretch reaches across the road's width at the angle it crosses,
    plus CROSSING_MARGIN_M either side. Width is the road's, for reference.
    """
    lat0 = (b.south + b.north) / 2
    lon0 = (b.west + b.east) / 2
    kx = METRES_PER_DEGREE * math.cos(math.radians(lat0))
    ky = METRES_PER_DEGREE

    def metres(pts: Sequence[Tuple[float, float]]) -> LineString:
        return LineString([((lon - lon0) * kx, (lat - lat0) * ky) for lon, lat in pts])

    rails = [metres(pts) for cls, _w, pts in parts if cls in RAIL_CLASSES and len(pts) >= 2]
    roads = [(metres(pts), w) for cls, w, pts in parts if cls < len(ROAD_CLASSES) and len(pts) >= 2]
    if not rails or not roads:
        return []
    tree = STRtree([r for r, _w in roads])
    out: List[Tuple[int, float, List[Tuple[float, float]]]] = []

    def tangent(line: LineString, d: float) -> Tuple[float, float]:
        a = line.interpolate(max(0.0, d - 0.5))
        c = line.interpolate(min(line.length, d + 0.5))
        dx, dy = c.x - a.x, c.y - a.y
        n = math.hypot(dx, dy) or 1.0
        return dx / n, dy / n

    for rail in rails:
        for idx in tree.query(rail):
            road, width = roads[int(idx)]
            hit = rail.intersection(road)
            if hit.is_empty:
                continue
            points = [hit] if isinstance(hit, Point) else [g for g in getattr(hit, 'geoms', []) if isinstance(g, Point)]
            for pt in points:
                d = rail.project(pt)
                tr = tangent(rail, d)
                tw = tangent(road, road.project(pt))
                sin = abs(tr[0] * tw[1] - tr[1] * tw[0])
                sin = max(sin, math.sin(math.radians(CROSSING_MIN_DEG)))
                half = min(CROSSING_MAX_HALF_M, max(0.5, width / 2) / sin + CROSSING_MARGIN_M)
                piece = substring(rail, max(0.0, d - half), min(rail.length, d + half))
                if not isinstance(piece, LineString) or len(piece.coords) < 2:
                    continue
                pts = [(lon0 + x / kx, lat0 + y / ky) for x, y in piece.coords]
                out.append((TRACK_CROSSING_CLASS, float(width), pts))
    return out


def encode_rvr(parts: Sequence[Tuple[int, float, Sequence[Tuple[float, float]]]]) -> bytes:
    """RVR2: f64 lon0, f64 lat0, u16 count, then per road u8 class, f32 width,
    u16 n, n x (f32 lon - lon0, f32 lat - lat0); zlib. Sub-millimetre at any
    tile; RVR1 (absolute f32 lon/lat) still decodes."""
    all_pts = [p for _c, _w, pts in parts for p in pts]
    lon0 = min((p[0] for p in all_pts), default=0.0)
    lat0 = min((p[1] for p in all_pts), default=0.0)
    payload = bytearray(RVR2_MAGIC)
    payload += struct.pack('<ddH', lon0, lat0, len(parts))
    for cls, width, pts in parts:
        payload += struct.pack('<Bf H', cls, float(width), len(pts))
        for lon, lat in pts:
            payload += struct.pack('<ff', float(lon) - lon0, float(lat) - lat0)
    return zlib.compress(bytes(payload), 6)


def decode_rvr(blob: bytes) -> List[Tuple[int, float, List[Tuple[float, float]]]]:
    payload = zlib.decompress(blob)
    if payload[:4] == RVR2_MAGIC:
        lon0, lat0, count = struct.unpack_from('<ddH', payload, 4)
        off = 4 + struct.calcsize('<ddH')
    elif payload[:4] == RVR_MAGIC:
        lon0 = lat0 = 0.0
        (count,) = struct.unpack_from('<H', payload, 4)
        off = 6
    else:
        raise ValueError('bad RVR magic')
    out = []
    for _ in range(count):
        cls, width, n = struct.unpack_from('<Bf H', payload, off)
        off += struct.calcsize('<Bf H')
        pts = []
        for _p in range(n):
            lon, lat = struct.unpack_from('<ff', payload, off)
            off += 8
            pts.append((lon0 + lon, lat0 + lat))
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


def child_roads(out_dir: str, z: int, x: int, y: int, max_zoom: int) -> List[Road]:
    """The runs of tile (z, x, y)'s four children on disk, as Roads.

    A coarser tile used to be clipped from this bake's own roads, which only
    cover this bake's bbox, so every chunk of an import and every later
    import emptied the shared coarser tiles of their neighbours' roads (the
    same flaw as the coast bake's ancestors, see its child_inputs). The
    children on disk hold every bake's roads. A leaf carries its bridge and
    tunnel spans in its .rbr instead of its .rvr, so for the level just
    above the leaf those spans are added back, or every bridge would be a
    gap in the coarser strokes.
    """
    out: List[Road] = []
    for qx, qy in ((0, 0), (1, 0), (0, 1), (1, 1)):
        cx, cy = x * 2 + qx, y * 2 + qy
        path = rvr_path(out_dir, z + 1, cx, cy)
        if os.path.isfile(path):
            with open(path, 'rb') as fh:
                for cls, width, pts in decode_rvr(fh.read()):
                    if len(pts) >= 2:
                        out.append(Road(cls, width, LineString(pts)))
        span_path = rbr_path(out_dir, z + 1, cx, cy)
        if z + 1 == max_zoom and os.path.isfile(span_path):
            with open(span_path, 'rb') as fh:
                for span in decode_rbr(fh.read()):
                    if span.cls != 255 and len(span.points) >= 2:
                        # The track bed, not the deck with its parapets.
                        width = span.deck_width_m - (RAIL_DECK_MARGIN_M if span.cls in RAIL_CLASSES else 0.0)
                        out.append(Road(span.cls, width, LineString(span.points)))
    return out


def write_levels(
    out_dir: str, tiles: Dict[int, Set[Tuple[int, int]]], bbox: Bounds,
    min_zoom: int, max_zoom: int, leaf_roads: Optional[Sequence[Road]],
    keep_leaf_roads: bool = False,
) -> Tuple[int, int, int, int]:
    """Writes the .rvr tiles in `bbox`, finest level first.

    The leaf is clipped from `leaf_roads` (None leaves it alone, for
    --rebuild-ancestors); every coarser level from the level below it on
    disk, see child_roads. With `keep_leaf_roads` (--rails-only) a leaf
    keeps the road runs already on disk verbatim and only its railways come
    from `leaf_roads`. Returns (files, bytes, runs, stale files removed).
    """
    total_files = 0
    total_bytes = 0
    total_parts = 0
    removed = 0
    for z in range(max_zoom, min_zoom - 1, -1):
        cut = class_cut_for_zoom(z)
        x0, y0, x1, y1 = tile_range_for_bounds(z, bbox)
        level_tiles = sorted(t for t in tiles.get(z, ()) if x0 <= t[0] <= x1 and y0 <= t[1] <= y1)
        if cut is None or not level_tiles or (z >= max_zoom and leaf_roads is None):
            continue
        tol = line_tolerance_deg(z, max_zoom)
        if z >= max_zoom:
            level_roads = [r for r in leaf_roads if keeps_class(r.cls, z)]
            tree = STRtree([r.line for r in level_roads])
        files = 0
        parts_written = 0
        level_bytes = 0
        level_crossings = 0
        for x, y in level_tiles:
            if z < max_zoom:
                level_roads = [r for r in child_roads(out_dir, z, x, y, max_zoom) if keeps_class(r.cls, z)]
                tree = STRtree([r.line for r in level_roads])
            track_tol = min(tol, RAIL_LEAF_SIMPLIFY_M / METRES_PER_DEGREE) if z >= max_zoom else None
            parts = clip_roads(level_roads, tree, tile_bounds(z, x, y), tol, track_tol) if level_roads else []
            path = rvr_path(out_dir, z, x, y)
            if keep_leaf_roads and z >= max_zoom:
                on_disk = []
                if os.path.isfile(path):
                    with open(path, 'rb') as fh:
                        blob = fh.read()
                    try:
                        on_disk = decode_rvr(blob)
                    except Exception as err:
                        # A file cut short by an interrupted bake: its roads
                        # are gone until the next full road bake of the area.
                        print(f'  warning: {path} unreadable ({err}); rewritten with track only', flush=True)
                if not parts and not any(p[0] in TRACK_LAYER_CLASSES for p in on_disk):
                    # No railway here before or now: the file stays as it is.
                    if on_disk:
                        files += 1
                        parts_written += len(on_disk)
                    continue
                parts = sorted([p for p in on_disk if p[0] not in TRACK_LAYER_CLASSES] + parts, key=lambda p: p[0])
            if z >= max_zoom and parts:
                crossings = crossing_parts(parts, tile_bounds(z, x, y))
                if crossings:
                    level_crossings += len(crossings)
                    parts = sorted(parts + crossings, key=lambda p: p[0])
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
              f'{parts_written} runs, {level_bytes / 1024:.0f} KB, classes <= {ROAD_CLASSES[cut]}'
              + (' + rail' if keeps_class(RAIL_CLASS, z) else '')
              + (f'; {level_crossings} level crossings' if level_crossings else ''),
              flush=True)
    return total_files, total_bytes, total_parts, removed


def known_tiles(out_dir: str, manifest: dict, min_zoom: int, max_zoom: int) -> Dict[int, Set[Tuple[int, int]]]:
    """The .pdm files on disk, topped up from the index, the way the coast
    bake enumerates them: a road is only worth writing where a mesh will be
    baked, and that is wherever there are heights."""
    index_path = os.path.join(out_dir, manifest.get('indexPath', 'index.bin'))
    tiles = scan_pdm_tiles(out_dir, min_zoom, max_zoom)
    if os.path.isfile(index_path):
        for z, coords in decode_index(index_path, min_zoom, max_zoom).items():
            if coords:
                tiles[z] = coords | tiles.get(z, set())
    return tiles


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

    if getattr(args, 'rebuild_ancestors', False):
        # The repair for tiles written before coarser levels came from disk:
        # nothing fetched, the leaf left alone.
        files, size, parts, removed = write_levels(
            out_dir, known_tiles(out_dir, manifest, min_zoom, max_zoom), bbox, min_zoom, max_zoom, None)
        print(f'rebuilt {files} coarser road tiles, {parts} runs'
              + (f'; removed {removed} stale' if removed else '') + f' in {time.time() - started:.1f}s')
        return 0

    if args.rails_only:
        return bake_rails_only(args, manifest_path, manifest, out_dir, bbox, min_zoom, max_zoom, started)

    if args.pbf:
        print(f'reading OSM roads from {args.pbf}', flush=True)
        # One scan of the file for both; each keeps its own cache entry, so
        # a road cache from before railways is still a hit.
        groups = [('roads', road_tag_predicate)] + ([] if args.no_rail else [
            ('rails', rail_tag_predicate), ('rail_service', rail_service_tag_predicate)])
        answers = pbf_elements_groups(args.pbf, bbox, groups, include_relations=False,
                                      refresh=args.refresh_osm)
        data = merge_answers(*answers.values())
        print(f'  {sum(1 for el in data["elements"] if el["type"] == "way")} ways')
    else:
        print('fetching OSM roads', flush=True)
        received = [0]

        def on_progress(n: int) -> None:
            if n - received[0] > 4 * 1024 * 1024:
                received[0] = n
                print(f'  {n / 1048576:.1f} MB received', flush=True)

        # Railways are their own query and cache: the road cells already
        # fetched stay valid, and only the rail cells are new.
        groups = [(overpass_roads_query, 'roads', None)]
        if not args.no_rail:
            groups.append((overpass_rails_query, 'rails', None))
            groups.append((overpass_rail_service_query, 'rail_service', None))
        answers = overpass_fetch_groups(
            groups, bbox, args.refresh_osm,
            on_progress=(lambda _g, n: on_progress(n)), zoom=ROAD_CELL_ZOOM)
        data = merge_answers(*answers)
    if args.fetch_only:
        print('fetch-only: cache filled, nothing baked')
        return 0
    roads = assemble_roads(data)
    # The leaf's own set, spans left out, only when there are bridge files to
    # replace them: a run of them missing from the leaf and present nowhere
    # else would be a hole in the road.
    turnouts = TurnoutStats()
    leaf_roads = assemble_roads(data, skip_spans=not args.no_bridges, turnout_stats=turnouts)
    way_count = sum(1 for el in data.get('elements', []) if el.get('type') == 'way')
    rail_runs = sum(1 for r in roads if r.cls in RAIL_CLASSES)
    print(f'assembled   {len(roads)} runs ({rail_runs} rail) from {way_count} ways')
    print(f'turnouts    {turnouts.found} found, {turnouts.fitted} curved, {turnouts.refused} left as mapped')
    if not roads:
        print('no roads in this box; nothing written')
        return 0

    tiles = known_tiles(out_dir, manifest, min_zoom, max_zoom)

    # Bridges before the levels: z11 is derived from the z12 tiles on disk,
    # and a leaf's spans live in its .rbr, not its .rvr.
    # They ride only the leaf: a span is a few hundred metres, and the
    # deck and piers are drawn from close enough that a coarser tile has no
    # use for them. Filed by midpoint, never clipped (see bridges_by_tile).
    bridge_files = 0
    bridge_spans = 0
    spans = [] if args.no_bridges else extract_bridges(data) + rail_bridges(data)
    owned = bridges_by_tile(spans, max_zoom, bbox)
    on_disk = {t for t in tiles.get(max_zoom, ())}
    for (x, y), items in sorted(owned.items()):
        if (x, y) not in on_disk:
            continue
        write_rbr(out_dir, max_zoom, x, y, encode_rbr(items))
        bridge_files += 1
        bridge_spans += len(items)
    print(f'bridges     {bridge_spans}/{len(spans)} spans in {bridge_files} leaf tiles (.rbr)')

    total_files, total_bytes, total_parts, removed = write_levels(
        out_dir, tiles, bbox, min_zoom, max_zoom, leaf_roads)

    # Locked and re-read: the importer runs this alongside the coast and
    # airfield bakes, which write the same manifest meanwhile. Writing back
    # the copy loaded at start silently dropped the airfields they had added.
    def set_roads(manifest: dict) -> None:
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
    update_manifest(manifest_path, set_roads)
    print(f'\nwrote {total_files} road tiles, {total_parts} runs, {total_bytes / 1048576:.1f} MB (.rvr)'
          + (f'; removed {removed} stale' if removed else ''))
    print(f'updated {manifest_path} (roads)')
    print(f'done in {time.time() - started:.1f}s')
    return 0


def merge_rail_bridges(
    out_dir: str, tiles: Dict[int, Set[Tuple[int, int]]], bbox: Bounds, max_zoom: int,
    spans: Sequence[Bridge],
) -> Tuple[int, int]:
    """Swap the rail spans of every leaf .rbr in `bbox` for `spans`, road spans kept.

    Every leaf in the box is visited, not only those that get a span, so a
    rail bridge gone from OSM leaves no deck behind. Returns (files written
    or removed, spans written).
    """
    owned = bridges_by_tile(spans, max_zoom, bbox)
    x0, y0, x1, y1 = tile_range_for_bounds(max_zoom, bbox)
    files = 0
    written = 0
    for x, y in sorted(tiles.get(max_zoom, ())):
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            continue
        path = rbr_path(out_dir, max_zoom, x, y)
        on_disk: List[Bridge] = []
        if os.path.isfile(path):
            with open(path, 'rb') as fh:
                on_disk = decode_rbr(fh.read())
        new = owned.get((x, y), [])
        had_rail = any(b.cls in RAIL_CLASSES for b in on_disk)
        if not new and not had_rail:
            continue
        items = [b for b in on_disk if b.cls not in RAIL_CLASSES] + list(new)
        if items:
            write_rbr(out_dir, max_zoom, x, y, encode_rbr(items))
        else:
            os.remove(path)
        files += 1
        written += len(new)
    return files, written


def bake_rails_only(
    args: argparse.Namespace, manifest_path: str, manifest: dict, out_dir: str, bbox: Bounds,
    min_zoom: int, max_zoom: int, started: float,
) -> int:
    """Add railways to a pyramid whose roads are already baked.

    Fetches only the railways; every leaf keeps its road runs from disk
    (see write_levels' keep_leaf_roads) and the coarser levels are derived
    from the leaves as always. For areas whose OSM extract is gone - a road
    re-read would mean the whole road net from Overpass.
    """
    if args.pbf:
        print(f'reading OSM railways from {args.pbf}', flush=True)
        answers = pbf_elements_groups(
            args.pbf, bbox, [('rails', rail_tag_predicate), ('rail_service', rail_service_tag_predicate)],
            include_relations=False, refresh=args.refresh_osm)
        data = merge_answers(*answers.values())
    else:
        print('fetching OSM railways', flush=True)
        data = merge_answers(*overpass_fetch_groups(
            [(overpass_rails_query, 'rails', None), (overpass_rail_service_query, 'rail_service', None)],
            bbox, args.refresh_osm, zoom=ROAD_CELL_ZOOM))
    if args.fetch_only:
        print('fetch-only: cache filled, nothing baked')
        return 0
    # The leaf's rails leave their bridges out, which become decks below.
    turnouts = TurnoutStats()
    rails = [r for r in assemble_roads(data, skip_spans=not args.no_bridges, turnout_stats=turnouts)
             if r.cls in TRACK_LAYER_CLASSES]
    print(f'assembled   {sum(1 for r in rails if r.cls in RAIL_CLASSES)} rail runs')
    print(f'turnouts    {turnouts.found} found, {turnouts.fitted} curved, {turnouts.refused} left as mapped')
    tiles = known_tiles(out_dir, manifest, min_zoom, max_zoom)
    if not args.no_bridges:
        # Before the levels: the level above the leaf adds each leaf's spans
        # back into its strokes (child_roads).
        files_b, spans_b = merge_rail_bridges(out_dir, tiles, bbox, max_zoom, rail_bridges(data))
        print(f'bridges     {spans_b} rail spans, {files_b} leaf .rbr rewritten')
    files, size, parts, removed = write_levels(
        out_dir, tiles, bbox, min_zoom, max_zoom, rails, keep_leaf_roads=True)
    print(f'\nwrote {files} road tiles, {parts} runs, {size / 1048576:.1f} MB (.rvr)'
          + (f'; removed {removed} stale' if removed else ''))
    print(f'done in {time.time() - started:.1f}s')
    return 0


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--manifest', help='planet manifest.json (default: {out}/manifest.json)')
    parser.add_argument('--out', default='assets/planet', help='planet asset directory')
    parser.add_argument('--bbox', help='west,south,east,north degrees (default: manifest coverage)')
    parser.add_argument('--pbf', help='read roads from this local .osm.pbf instead of Overpass '
                                       '(pip install osmium)')
    parser.add_argument('--min-zoom', type=int, default=DEFAULT_MIN_ZOOM,
                        help=f'coarsest level that carries roads (default {DEFAULT_MIN_ZOOM})')
    parser.add_argument('--refresh-osm', action='store_true',
                        help='ignore the cached Overpass response and re-fetch')
    parser.add_argument('--no-bridges', action='store_true',
                        help='keep bridge and tunnel ways in the leaf road strokes and write no .rbr')
    parser.add_argument('--no-rail', action='store_true',
                        help='leave railways out (roads only, as before railways existed)')
    parser.add_argument('--rails-only', action='store_true',
                        help='fetch only railways and add them to the leaf road files already on disk, '
                             'then re-derive the coarser levels; roads are not re-read')
    parser.add_argument('--fetch-only', action='store_true',
                        help='only fetch the Overpass answers into the cache; bake nothing')
    parser.add_argument('--rebuild-ancestors', action='store_true',
                        help='re-derive every level above the leaf in the bbox from the tiles on '
                             'disk; fetches nothing and leaves the leaf alone')
    raw = list(argv) if argv is not None else sys.argv[1:]
    args = parser.parse_args(glue_negative_bbox(raw))
    return bake(args)


if __name__ == '__main__':
    raise SystemExit(main())

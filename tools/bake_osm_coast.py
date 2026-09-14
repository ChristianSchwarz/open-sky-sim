#!/usr/bin/env python3
"""Bake OSM land/water coast masks into the planet quadtree pyramid.

Reads an existing ``assets/planet`` tree (manifest + index from DEM bake),
assembles land polygons from OpenStreetMap, rasterises them onto the same
257-node geographic grid as ``.pdm`` tiles, and writes ``.lwm`` files plus a
``coastMask`` block in ``manifest.json``.

Data sources (in priority order):

1. ``--land-shp PATH`` — shapefile from osmcoastline (preferred)
2. ``--pbf PATH`` — run osmcoastline if installed, else parse with Overpass-style logic
3. Overpass API for ``--bbox`` or manifest ``coverage``

Usage::

    python tools/bake_osm_coast.py --manifest assets/planet/manifest.json
    python tools/bake_osm_coast.py --bbox -18.66,26.97,-12.61,30.49 --out assets/planet
    python tools/bake_osm_coast.py --manifest assets/planet/manifest.json --pbf data/canary-islands.osm.pbf

Requires ``shapely`` and ``requests``::

    pip install shapely requests

Optional: ``osmcoastline`` binary for robust coastline assembly from PBF.
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing as mp
import os
import struct
import subprocess
import sys
import pickle
import tempfile
import time
import zlib
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import numpy as np

try:
    import requests
    import shapely
    from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box, mapping, shape
    from shapely.affinity import scale as affine_scale
    from shapely.ops import polygonize, unary_union
    from shapely.prepared import prep
    from shapely.strtree import STRtree
    from shapely.wkb import dumps as wkb_dumps, loads as wkb_loads
except ImportError:
    print('error: shapely and requests are required (pip install shapely requests)', file=sys.stderr)
    raise

from osm_common import (
    DemSampler,
    LAND,
    LWM_MAGIC,
    WATER,
    Bounds,
    glue_negative_bbox,
    load_manifest,
    merge_elements,
    nodes_map as _nodes_map,
    overpass_fetch as _overpass_fetch,
    overpass_fetch_cells,
    parse_bbox,
    read_lwm,
    relation_rings as _relation_rings,
    snap_bounds_to_tiles,
    tagged_width_m as _tagged_width_m,
    tile_bounds,
    tile_range_for_bounds,
    ways_map as _ways_map,
)

try:
    from rasterio.features import rasterize
    from rasterio.transform import from_bounds as transform_from_bounds
    HAS_RASTERIO = True
except ImportError:
    HAS_RASTERIO = False

# Optional: only needed for --osm-landuse. Same guarded shape as
# bake_planet_cover.py's own HAS_OSM_LANDUSE - a bake that never passes
# --osm-landuse never needs shapely's STRtree or the landuse tag table.
try:
    from osm_landuse import assemble_landuse_polygons, build_landuse_index, overpass_landuse_query
    from osm_regions import Region, assemble_tile_regions, derive_tile_regions
    HAS_OSM_LANDUSE = True
except ImportError:
    HAS_OSM_LANDUSE = False


LVR_MAGIC = b'LVR1'
LVR2_MAGIC = b'LVR2'
LVR3_MAGIC = b'LVR3'
LVR4_MAGIC = b'LVR4'

# Below this zoom a tile's own grid is already coarser than any landuse
# boundary is worth cutting precisely (see the cell-size table in the
# feature's design notes: ~19-150 m per cell across z9-z12, the range the
# boundary-adaptive mesh tessellation actually engages). A low-zoom tile's
# box is also huge - near-hemisphere at z0/z1 - so its landuse STRtree query
# would return far more candidates than any single leaf tile ever does; below
# this zoom the tile simply keeps its LVR1-3 layers, and the raster `.plc`
# pyramid stays the source of truth for colour there, same as today.
LANDUSE_REGION_MIN_ZOOM = 9

# No OSM landuse tag on this region - bare land, or water. Matches
# tools/bake/lvr.ts's REGION_CLASS_NONE.
REGION_CLASS_NONE = 0xFF

# Rasterizing and clipping are one tile against a fixed set of polygons each,
# with no interaction between tiles, so both loops are split across this many
# worker processes by default. Leaving one core free keeps the machine
# responsive to everything else.
DEFAULT_JOBS = max(1, (os.cpu_count() or 1) - 1)

# Inland water bodies whose surface is flat: a lake sits at one elevation, and
# the eye reads a non-level water surface as broken instantly. Flowing water
# does not - a river descends across a tile - so it follows the DEM instead.
# OSM's `water=*` subtag separates the two; an untagged `natural=water` is
# overwhelmingly a lake or a pond, so absence means flat.
FLOWING_WATER_SUBTYPES = frozenset((
    'river', 'stream', 'canal', 'ditch', 'drain', 'tidal_channel',
))

# Perimeter percentile used for a flat body's surface height. See
# :func:`flat_body_height` for why it is a low one.
SURFACE_PERCENTILE = 5.0

# Below this share of the bbox, assembled land is treated as a failed coastline
# assembly rather than as open sea. See the check in :func:`bake`.
MIN_PLAUSIBLE_LAND_FRACTION = 0.005


# Width to assume for a watercourse OSM maps as a bare centreline with no
# `width` tag on it, which is most of them. Used for two things: the water
# polygon it is buffered into, and the stroke the overlay draws it with.
WATERWAY_FALLBACK_WIDTH_M = {'river': 30.0, 'canal': 12.0}

# Douglas-Peucker tolerance for a watercourse centreline, in grid cells of the
# level being written.
#
# Generous next to the 0.15 cells the coast gets, because these lines are not
# cut against anything: they are drawn as a stroke, so a vertex dropped here
# costs a little shape and no continuity at all. It is what keeps a z8 tile
# from carrying every bend the z12 one does.
LINE_SIMPLIFY_CELLS = 0.5


def decode_index(index_path: str, min_zoom: int, max_zoom: int) -> Dict[int, Set[Tuple[int, int]]]:
    """Return {z: {(x,y), ...}} from PIX1 index.bin."""
    tiles: Dict[int, Set[Tuple[int, int]]] = {z: set() for z in range(min_zoom, max_zoom + 1)}
    with open(index_path, 'rb') as fh:
        data = fh.read()
    if len(data) < 8 or data[:4] != b'PIX1':
        return tiles
    min_z, max_z = struct.unpack_from('<HH', data, 4)
    offset = 8
    for z in range(min_z, max_z + 1):
        if offset + 16 > len(data):
            break
        min_x, min_y, w, h = struct.unpack_from('<IIII', data, offset)
        offset += 16
        nbytes = (w * h + 7) // 8
        if offset + nbytes > len(data):
            break
        bits = data[offset:offset + nbytes]
        offset += nbytes
        for dy in range(h):
            for dx in range(w):
                idx = dy * w + dx
                if bits[idx >> 3] & (1 << (idx & 7)):
                    tiles[z].add((min_x + dx, min_y + dy))
    return tiles


def scan_pdm_tiles(out_dir: str, min_zoom: int, max_zoom: int) -> Dict[int, Set[Tuple[int, int]]]:
    tiles: Dict[int, Set[Tuple[int, int]]] = {z: set() for z in range(min_zoom, max_zoom + 1)}
    for z in range(min_zoom, max_zoom + 1):
        zdir = os.path.join(out_dir, str(z))
        if not os.path.isdir(zdir):
            continue
        for xname in os.listdir(zdir):
            xpath = os.path.join(zdir, xname)
            if not os.path.isdir(xpath):
                continue
            try:
                x = int(xname)
            except ValueError:
                continue
            for fname in os.listdir(xpath):
                if fname.endswith('.pdm'):
                    try:
                        y = int(fname[:-4])
                        tiles[z].add((x, y))
                    except ValueError:
                        pass
    return tiles


PhaseProgress = Callable[[float, str], None]
"""(fraction of the current phase done, 0..1; a short detail such as `12/40`)."""

# The bytes a fetch has received, turned into a guess at how far along it is:
# Overpass sends no Content-Length, so this is an asymptote that keeps the bar
# moving and never reaches the end before the answer does. 8 MB is about half
# of a typical regional coastline answer.
FETCH_HALFWAY_BYTES = 8 * 1024 * 1024


def fetch_fraction(received: int) -> float:
    return received / (received + FETCH_HALFWAY_BYTES)


def format_mb(n: int) -> str:
    return f'{n / (1024 * 1024):.1f} MB'


class StageProgress:
    """Whole-stage progress for the in-app importer, across weighted phases.

    tools/areaImport.ts reads `(NN.N% of stage)` off the end of a line as this
    stage's own percentage and shows it in the import dialog. Every phase is
    a weighted slice of the whole, so the percentage moves through the
    Overpass fetches and the polygon assembly too - the minutes that used to
    sit at 0% with nothing in the log.

    A phase that turns out not to apply (no `--osm-landuse`, no inland water)
    is skipped and its weight dropped, so the percentage still reaches 100
    and only ever moves forward. The phase numbering stays over the full
    list, so `phase 6/8 ... skipped` reads as what it is.
    """

    def __init__(self, phases: Sequence[Tuple[str, str, float]], min_interval_s: float = 0.5):
        self._phases = [(key, label, float(weight)) for key, label, weight in phases]
        self._index = {key: i for i, (key, _l, _w) in enumerate(self._phases)}
        self._done: Set[str] = set()
        self._skipped: Set[str] = set()
        self._current: Optional[str] = None
        self._label = ''
        self._fraction = 0.0
        self._phase_started = 0.0
        self._last_print = 0.0
        self._min_interval = min_interval_s

    def _weight(self, key: str) -> float:
        return self._phases[self._index[key]][2]

    def percent(self) -> float:
        active = sum(w for k, _l, w in self._phases if k not in self._skipped)
        if active <= 0:
            return 100.0
        done = sum(self._weight(k) for k in self._done)
        if self._current is not None and self._current not in self._done:
            done += self._fraction * self._weight(self._current)
        return max(0.0, min(100.0, 100.0 * done / active))

    def _heading(self, key: str, label: str) -> str:
        return f'phase {self._index[key] + 1}/{len(self._phases)}  {label}'

    def begin(self, key: str, label: Optional[str] = None) -> None:
        if self._current is not None and self._current not in self._done:
            self.end()
        self._current = key
        self._label = label or self._phases[self._index[key]][1]
        self._fraction = 0.0
        self._phase_started = time.monotonic()
        self._last_print = 0.0
        print(self._heading(key, self._label), flush=True)

    def update(self, fraction: float, detail: str = '', force: bool = False) -> None:
        """Report where the current phase is. Throttled to keep the log sane."""
        self._fraction = max(self._fraction, max(0.0, min(1.0, fraction)))
        now = time.monotonic()
        if not force and fraction < 1.0 and now - self._last_print < self._min_interval:
            return
        self._last_print = now
        tail = f' {detail}' if detail else ''
        print(f'  {self._label}{tail}  ({self.percent():.1f}% of stage)', flush=True)

    def skip(self, key: str, reason: str) -> None:
        self._skipped.add(key)
        print(f'{self._heading(key, self._phases[self._index[key]][1])} - skipped, {reason}',
              flush=True)

    def end(self, summary: str = '') -> None:
        if self._current is None:
            return
        self.update(1.0, force=True)
        self._done.add(self._current)
        elapsed = time.monotonic() - self._phase_started
        tail = f', {summary}' if summary else ''
        print(f'  {self._label} done in {elapsed:.1f}s{tail}', flush=True)
        self._current = None


def overpass_query(
    b: Bounds, refresh: bool = False, progress: Optional[StageProgress] = None,
) -> dict:
    """Fetch the coastline and the water features as two separate requests.

    Two requests, not one union of many clauses, because Overpass quietly
    returns fewer elements when it is asked for everything at once. On the
    Crimea bbox the combined query came back with 504 coastline ways and the
    coastline-only query with 667 - no `remark`, no error, no missing nodes,
    just 163 ways short. 504 does not close the chain, so `polygonize` returned
    one face the size of the bbox and the whole peninsula baked as open sea.

    Splitting them also makes the cache finer: a change to which water features
    are wanted no longer forces the coastline to be downloaded again.

    Each is fetched one grid cell at a time (see `overpass_fetch_cells`), a
    couple of cells in flight at once, so the answer covers the cells' union
    - a superset of `b` that the caller clips.
    """
    def coastline(c: Bounds) -> str:
        return f'''[out:json][timeout:240];
(
  way["natural"="coastline"]({c.as_overpass()});
  relation["natural"="coastline"]({c.as_overpass()});
  relation["place"="island"]({c.as_overpass()});
);
out body;
>;
out skel qt;
'''

    def features(c: Bounds) -> str:
        return f'''[out:json][timeout:240];
(
  way["natural"="water"]({c.as_overpass()});
  relation["natural"="water"]({c.as_overpass()});
  way["natural"="bay"]({c.as_overpass()});
  relation["natural"="bay"]({c.as_overpass()});
  way["waterway"="riverbank"]({c.as_overpass()});
  way["waterway"~"^(river|canal)$"]({c.as_overpass()});
  way["landuse"="reservoir"]({c.as_overpass()});
  relation["landuse"="reservoir"]({c.as_overpass()});
);
out body;
>;
out skel qt;
'''
    answers: List[dict] = []
    for key, label, query_for in (('coast', 'coastline', coastline),
                                  ('water', 'water features', features)):
        extra: Dict[str, object] = {}
        if progress is not None:
            progress.begin(key)

            def on_bytes(received: int) -> None:
                progress.update(fetch_fraction(received), f'{format_mb(received)} received')
            extra['on_progress'] = on_bytes
        got = overpass_fetch_cells(query_for, b, label, refresh, **extra)
        answers.append(got)
        if progress is not None:
            progress.end(f'{len(got.get("elements", []))} elements')
    return merge_elements(answers)


def _way_line(way: dict, nodes: Dict[int, Tuple[float, float]]) -> Optional[LineString]:
    coords = [nodes[nid] for nid in way.get('nodes', []) if nid in nodes]
    if len(coords) < 2:
        return None
    return LineString(coords)


@dataclass
class Watercourse:
    """One river or canal as OSM maps it: a centreline and a true width.

    Kept as a line all the way to the tile, because that is the only form a
    watercourse survives in. Cut into the terrain it has to be at least a
    couple of grid cells across to land on a node at all, and most of them are
    not: a 12 m canal is under one cell at Potsdam z12 and a fifth of one at
    z10. As a line it has no width to lose, and the renderer strokes it.
    """
    line: object
    width_m: float


@dataclass
class WaterBody:
    """One inland body, with the surface height the mesh bake will sit it at.

    `height` is None until :func:`resolve_body_heights` fills it in, and stays
    None for flowing water, which follows the DEM per-node instead.
    """
    geom: object
    flat: bool
    height: Optional[float] = None


def waterway_width_m(tags: dict) -> Optional[float]:
    """A centreline watercourse's true width in metres, or None if it is not one.

    The tagged `width` where OSM has one, and a per-kind fallback where it does
    not, because most watercourses are mapped as a bare line with no width on
    them at all.

    True width, with no floor. A floor was tried - drawn at 2.5 grid cells,
    which is 48 m at Potsdam - and it is the wrong place to solve this: a 12 m
    canal has to be drawn wide enough to see from 20 km and no wider than it is
    from 200 m, and no single number in metres is both. The minimum width is a
    *screen* quantity, so it belongs in the stroke that draws the centreline -
    see WATERCOURSE_MIN_PIXELS in the renderer.
    """
    kind = tags.get('waterway', '')
    if kind not in WATERWAY_FALLBACK_WIDTH_M:
        return None
    return _tagged_width_m(tags) or WATERWAY_FALLBACK_WIDTH_M[kind]


def buffer_waterway(line: LineString, width_m: float, lat: float) -> Optional[Polygon]:
    """Widen a centreline into a polygon, in metres rather than in degrees.

    Buffering lon/lat directly would make the river narrower east-west than
    north-south — by a factor of cos(lat), which is 1.6 at Berlin. So the line
    is squeezed by that factor, buffered round, and stretched back.
    """
    shrink = max(0.05, math.cos(math.radians(lat)))
    try:
        squeezed = affine_scale(line, xfact=shrink, yfact=1.0, origin=(0.0, 0.0))
        buffered = squeezed.buffer((width_m / 2.0) / 110540.0, resolution=4)
        widened = affine_scale(buffered, xfact=1.0 / shrink, yfact=1.0, origin=(0.0, 0.0))
    except Exception:
        return None
    if widened.is_empty or not isinstance(widened, Polygon):
        return None
    return widened


def _water_kind(tags: dict) -> Optional[str]:
    """'ocean', 'flat' or 'flowing' - or None when these tags are not water.

    A bay is the sea reaching inland, so it belongs to the ocean surface at sea
    level and must keep being subtracted from land exactly as it always was.
    Everything else tagged as water is an inland body carrying its own
    elevation, which is the whole point of this split.
    """
    natural = tags.get('natural', '')
    if natural == 'bay':
        return 'ocean'
    if tags.get('waterway', '') == 'riverbank':
        return 'flowing'
    if tags.get('landuse', '') == 'reservoir':
        return 'flat'
    if natural == 'water':
        return 'flowing' if tags.get('water', '') in FLOWING_WATER_SUBTYPES else 'flat'
    return None


def _polygons_from_osm(
    data: dict, bbox: Bounds, progress: Optional[PhaseProgress] = None,
) -> Tuple[MultiPolygon, List[WaterBody], List[Watercourse]]:
    """Return (land_multipolygon, inland_bodies, watercourses) clipped to bbox.

    `progress(fraction, detail)`, when given, hears each step of the
    assembly: the way and relation walks by count, then the polygonize,
    classify and subtract steps, which are single geometry operations that
    can each take a while on a regional bbox.

    Land is assembled exactly as it always was - every water polygon, inland
    ones included, is still subtracted from it - so the ocean shoreline this
    produces is unchanged. The inland bodies are reported *alongside* it, which
    is what lets the mesh bake tell a lake at 900 m from open sea at 0 m
    instead of drowning both at sea level.

    The watercourse centrelines are reported alongside both, at true width, and
    are the *only* thing that can carry a narrow canal: it is far too thin for
    the node grid to hold, so it reaches the screen as a stroke drawn over the
    terrain rather than as water cut into it.
    """
    elements = data.get('elements', [])
    nodes = _nodes_map(elements)
    ways = _ways_map(elements)
    relations = [el for el in elements if el.get('type') == 'relation']

    coastline_lines: List[LineString] = []
    water_polys: List[Polygon] = []
    land_polys: List[Polygon] = []
    inland_parts: List[Tuple[Polygon, bool]] = []
    courses: List[Watercourse] = []
    widened_lines = 0

    def tell(fraction: float, detail: str) -> None:
        if progress is not None:
            progress(fraction, detail)

    way_total = max(1, len(ways))
    way_step = max(1, way_total // 50)
    for i, way in enumerate(ways.values()):
        if i % way_step == 0 or i + 1 == way_total:
            tell(0.3 * (i + 1) / way_total, f'ways {i + 1}/{way_total}')
        tags = way.get('tags', {})
        line = _way_line(way, nodes)
        if line is None:
            continue
        natural = tags.get('natural', '')
        kind = _water_kind(tags)
        if natural == 'coastline':
            coastline_lines.append(line)
        elif kind is not None:
            coords = list(line.coords)
            if len(coords) >= 4 and coords[0] == coords[-1]:
                try:
                    poly = Polygon(coords)
                except Exception:
                    continue
                water_polys.append(poly)
                if kind != 'ocean':
                    inland_parts.append((poly, kind == 'flat'))
        else:
            # A watercourse mapped as a centreline, which is how OSM maps most
            # of them: on one Berlin tile there were 36 water areas and 20
            # waterway lines. Kept twice over.
            #
            # As a line, because that is what the overlay strokes and it is the
            # only form that survives a grid too coarse to hold the river.
            #
            # And, buffered to true width, as water like any other polygon - so
            # a wide river still gets a real water surface with a shoreline cut
            # around it, and the land under it is still subtracted.
            width = waterway_width_m(tags)
            if width is None:
                continue
            courses.append(Watercourse(line, width))
            widened = buffer_waterway(line, width, line.centroid.y)
            if widened is None:
                continue
            water_polys.append(widened)
            # Flowing, never flat: a river descends across a tile, so it takes
            # its surface from the DEM.
            inland_parts.append((widened, False))
            widened_lines += 1

    rel_total = max(1, len(relations))
    for i, rel in enumerate(relations):
        tell(0.3 + 0.1 * (i + 1) / rel_total, f'relations {i + 1}/{len(relations)}')
        tags = rel.get('tags', {})
        natural = tags.get('natural', '')
        place = tags.get('place', '')
        kind = _water_kind(tags)
        rings = _relation_rings(rel, ways, nodes)
        for ring in rings:
            if len(ring) < 4:
                continue
            try:
                poly = Polygon(ring)
            except Exception:
                continue
            if not poly.is_valid:
                poly = poly.buffer(0)
            if kind is not None:
                water_polys.append(poly)
                if kind != 'ocean':
                    inland_parts.append((poly, kind == 'flat'))
            elif natural == 'coastline' or place == 'island':
                land_polys.append(poly)

    clip = bbox.as_box()
    land_from_coast: List[Polygon] = []
    if coastline_lines:
        # Polygonize coastline linework + bbox boundary to split land/sea.
        bbox_ring = LineString([
            (bbox.west, bbox.south), (bbox.east, bbox.south),
            (bbox.east, bbox.north), (bbox.west, bbox.north), (bbox.west, bbox.south),
        ])
        # Node the linework before polygonizing. `polygonize` does not split lines
        # where they cross; it only closes rings out of segments that already share
        # endpoints. An island whose coastline closes on itself inside the bbox
        # needs no help - which is why the Canaries baked correctly - but a
        # mainland coast runs off the edge, and its crossing with the bbox ring is
        # not a shared endpoint until something nodes it. Unnoded, the crossings
        # never close and the whole bbox comes out as ocean.
        tell(0.4, f'noding {len(coastline_lines)} coastline ways')
        linework = unary_union(coastline_lines + [bbox_ring])
        tell(0.45, 'polygonizing')
        pieces = list(polygonize(linework))

        # Classify each piece as land or sea from the coastline's own winding
        # direction, per OSM convention: land is on the left of a `natural=
        # coastline` way, sea on the right. A fixed "assume the southwest
        # corner is ocean" corner probe used to do this instead, which broke
        # on this bbox - the coast only clips its NE corner (the rest is deep
        # inland Brandenburg), so the SW corner sits on land and the probe
        # picked the 99.5%-of-the-box land piece as "ocean", leaving ~0% land.
        # Voting over every coastline segment on a piece's boundary is robust
        # to a piece bordering several coastline ways with occasional noise.
        #
        # Each segment asks which side of it the piece actually lies on, by
        # probing a point just off its left and right. It used to compare the
        # segment against the piece's centroid, which is wrong for any piece
        # with a hole: the sea around an island that closes inside the bbox is
        # the bbox with the island punched out, its centroid lands on the
        # island, every coastline segment voted "land", and the whole import
        # box baked as land with a straight-edged coast along the box.
        # Measured on Gran Canaria: land fraction 1.0 of the box.
        #
        # The vote is cast once per segment, not once per piece per segment:
        # the pieces sit in an STRtree, and each segment's two probe points
        # are looked up in it in one bulk query. Walking every segment for
        # every piece was quadratic - 270 pieces by 51k segments on Madeira
        # was fourteen million GEOS calls and 317 s, with every download
        # already cached.
        tell(0.5, f'classifying {len(pieces)} pieces')
        land_votes = np.zeros(len(pieces), dtype=np.int64)
        sea_votes = np.zeros(len(pieces), dtype=np.int64)
        if pieces:
            starts: List[np.ndarray] = []
            ends: List[np.ndarray] = []
            for line in coastline_lines:
                coords = np.asarray(line.coords, dtype=np.float64)
                if len(coords) >= 2:
                    starts.append(coords[:-1])
                    ends.append(coords[1:])
            p1 = np.concatenate(starts) if starts else np.zeros((0, 2))
            p2 = np.concatenate(ends) if ends else np.zeros((0, 2))
            d = p2 - p1
            length = np.hypot(d[:, 0], d[:, 1])
            keep = length > 0
            p1, d, length = p1[keep], d[keep], length[keep]
            mid = p1 + d * 0.5
            off = np.minimum(length * 0.25, 1e-6) / length
            normal = np.column_stack([-d[:, 1], d[:, 0]]) * off[:, None]
            left = shapely.points(mid + normal)
            right = shapely.points(mid - normal)
            mids = shapely.points(mid)

            tree = STRtree(pieces)
            # (segment, piece) pairs whose probe point falls inside the piece.
            lseg, lpiece = tree.query(left, predicate='within')
            rseg, rpiece = tree.query(right, predicate='within')
            # The segment must lie on the piece's boundary, as before: a way
            # that dangles inside a face without bounding it says nothing
            # about which side of it is sea.
            boundaries = np.array([p.boundary for p in pieces], dtype=object)
            on_edge_l = shapely.distance(boundaries[lpiece], mids[lseg]) <= 1e-9
            lseg, lpiece = lseg[on_edge_l], lpiece[on_edge_l]
            on_edge_r = shapely.distance(boundaries[rpiece], mids[rseg]) <= 1e-9
            rseg, rpiece = rseg[on_edge_r], rpiece[on_edge_r]
            # A right-side vote only where the left probe was not already
            # inside the same piece, matching the old elif.
            n = len(pieces)
            left_pairs = set((lseg * n + lpiece).tolist())
            right_ok = np.array([(s * n + p) not in left_pairs for s, p in zip(rseg, rpiece)], dtype=bool)
            np.add.at(land_votes, lpiece, 1)
            np.add.at(sea_votes, rpiece[right_ok], 1)

        for i, piece in enumerate(pieces):
            if piece.area > 0 and not sea_votes[i] > land_votes[i]:
                land_from_coast.append(piece)
        # `place=island` relations only mean something next to a coastline:
        # polygonizing swallows a real island's shoreline into the same "sea"
        # piece as the water around it unless the island is re-added as land
        # by hand. Restricted to here, or `land_polys` picking up any
        # `place=island` relation elsewhere in the bbox - a river island with
        # nothing to do with the sea, which is what Berlin's Spreeinsel and
        # Kleiner Rohrwall are - would make `land_from_coast` non-empty on a
        # bbox with no coastline at all, skipping the clip-minus-water
        # fallback below and leaving the box almost entirely "water" instead
        # of "land everywhere but the mapped water features".
        land_from_coast.extend(land_polys)
    # else: no coastline way touches this bbox at all - it is entirely
    # inland, so there is no sea to probe for and no `land_polys` island to
    # re-add either. `land_from_coast` stays empty, which is what sends this
    # box down the clip-minus-water fallback below instead of being
    # classified as ocean by a corner probe that no longer exists.

    tell(0.8, f'merging {len(water_polys)} water polygons')
    water_union = unary_union(water_polys) if water_polys else Polygon()
    tell(0.85, f'merging {len(land_from_coast)} land pieces')
    land_union = unary_union(land_from_coast) if land_from_coast else Polygon()
    tell(0.9, 'subtracting water from land')
    if land_union.is_empty:
        land_union = clip.difference(water_union)
    else:
        land_union = land_union.difference(water_union)
    land_union = land_union.intersection(clip)
    water_union = water_union.intersection(clip)
    if land_union.is_empty:
        land_union = Polygon()
    if water_union.is_empty:
        water_union = Polygon()

    land_mp = land_union if isinstance(land_union, MultiPolygon) else (
        MultiPolygon([land_union]) if isinstance(land_union, Polygon) and not land_union.is_empty else MultiPolygon()
    )
    # One body per connected piece: two lakes that touch are one surface, and
    # a lake mapped twice (as a way and again in a relation) must not become
    # two bodies fighting over the same water at two different heights.
    def bodies_of(parts: List[Polygon], flat: bool) -> List[WaterBody]:
        if not parts:
            return []
        merged = unary_union(parts).intersection(clip)
        if merged.is_empty:
            return []
        if isinstance(merged, Polygon):
            geoms: Sequence[Polygon] = [merged]
        elif isinstance(merged, MultiPolygon):
            geoms = list(merged.geoms)
        else:
            geoms = [g for g in getattr(merged, 'geoms', []) if isinstance(g, Polygon)]
        return [WaterBody(g, flat) for g in geoms if not g.is_empty and g.area > 0]

    if widened_lines:
        print(f'  {widened_lines} centreline watercourses kept as strokes '
              f'and buffered into water')
    tell(0.95, f'merging {len(inland_parts)} inland water parts into bodies')
    inland = (bodies_of([p for p, flat in inland_parts if flat], True)
              + bodies_of([p for p, flat in inland_parts if not flat], False))
    return land_mp, inland, courses


def load_land_shp(path: str, bbox: Bounds) -> MultiPolygon:
    try:
        import shapefile  # pyshp
    except ImportError:
        try:
            import fiona
            from shapely.geometry import shape
            geoms = []
            with fiona.open(path) as src:
                for feat in src:
                    g = shape(feat['geometry'])
                    geoms.append(g)
            land = unary_union(geoms)
            return land.intersection(bbox.as_box())
        except ImportError:
            print('error: shapefile input requires pyshp or fiona', file=sys.stderr)
            raise
    sf = shapefile.Reader(path)
    geoms = []
    for shp in sf.shapes():
        pts = shp.points
        parts = list(shp.parts) + [len(pts)]
        for i in range(len(parts) - 1):
            ring = pts[parts[i]:parts[i + 1]]
            if len(ring) >= 4:
                try:
                    geoms.append(Polygon(ring))
                except Exception:
                    pass
    land = unary_union(geoms)
    return land.intersection(bbox.as_box())


def run_osmcoastline(pbf: str, out_shp: str) -> bool:
    for cmd in ('osmcoastline', 'osmcoastline.exe'):
        try:
            subprocess.run(
                [cmd, '-o', out_shp, pbf],
                check=True,
                capture_output=True,
                timeout=600,
            )
            return True
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
    return False


# Perimeter samples per body. A cap, not a target: a lake with a 400 km shore
# does not need a sample every 20 m to place a percentile.
MAX_PERIMETER_SAMPLES = 2048
MIN_PERIMETER_SAMPLES = 8


def flat_body_height(
    body: WaterBody, dem: DemSampler, cell_deg: float, sea_level: float = 0.0,
) -> Optional[float]:
    """Surface height for a flat body: a low percentile of the DEM around it.

    Measured from the body's *perimeter*, one step outside it - not from its
    interior. Both choices were forced by real tiles:

    - The interior is not the water surface. Where a reservoir has dropped
      below its mapped extent the DEM under the polygon is dry canyon; on Lake
      Powell it spans 442 m with no plateau anywhere in it to find.
    - What reads as broken from the air is water standing *above* the ground
      beside it. Land above water is simply a shore. So the height that matters
      is the one the shoreline agrees with, and it has to sit under the lowest
      part of that shore rather than at its average - taking the perimeter
      median leaves half the shoreline leaking.

    A low percentile rather than the minimum, because the minimum is one bad
    DEM sample away from sinking the whole lake: on Powell that is 895 m
    against the 927 m the 5th percentile gives.

    Samples below the sea datum are set aside first. A coastal lagoon tagged
    `natural=water` has open sea along part of its perimeter, and sampling the
    sea floor there dragged the percentile under water: measured on the African
    coast in the Canary bake, 31 bodies came out at up to -49.5 m and one of
    them was 4.9 km across, which is a pit rather than a lagoon.

    Set aside, not clamped, and only when something is left. A lake that genuinely
    sits below sea level - the Dead Sea, the Salton Sea, the Caspian - has a
    perimeter that is below it too, so nothing survives the filter and the raw
    percentile is used. Those are real elevations and must come through intact.
    """
    try:
        outline = body.geom.buffer(cell_deg)
    except Exception:
        return None
    if outline.is_empty:
        return None
    if isinstance(outline, Polygon):
        rings = [outline.exterior]
    else:
        rings = [g.exterior for g in getattr(outline, 'geoms', []) if isinstance(g, Polygon)]
    samples: List[float] = []
    for ring in rings:
        length = ring.length
        if length <= 0:
            continue
        count = int(min(MAX_PERIMETER_SAMPLES, max(8, length / max(cell_deg, 1e-9))))
        for i in range(count):
            p = ring.interpolate(i / count, normalized=True)
            h = dem.sample(p.x, p.y)
            if math.isfinite(h):
                samples.append(h)
    if len(samples) < MIN_PERIMETER_SAMPLES:
        return None
    dry = [h for h in samples if h > sea_level]
    if len(dry) >= MIN_PERIMETER_SAMPLES:
        samples = dry
    return float(np.percentile(samples, SURFACE_PERCENTILE))


def resolve_body_heights(
    bodies: Sequence[WaterBody], dem: DemSampler, cell_deg: float, sea_level: float = 0.0,
    progress: Optional[PhaseProgress] = None,
) -> int:
    """Fill in `height` for every flat body. Returns how many resolved.

    A body the DEM cannot answer for keeps `height = None` and is baked as
    flowing water, following the terrain. That is never flat, but it is never
    broken either, which is the right way round for a fallback.
    """
    resolved = 0
    flat_total = sum(1 for b in bodies if b.flat)
    seen = 0
    for body in bodies:
        if not body.flat:
            continue
        seen += 1
        if progress is not None:
            progress(seen / max(1, flat_total), f'{seen}/{flat_total} flat bodies')
        body.height = flat_body_height(body, dem, cell_deg, sea_level)
        if body.height is not None:
            resolved += 1
    return resolved


def assemble_land(
    bbox: Bounds, args: argparse.Namespace, progress: Optional[StageProgress] = None,
) -> Tuple[MultiPolygon, List[WaterBody], List[Watercourse]]:
    # osmcoastline emits the ocean shoreline and nothing else, so those two
    # paths carry no inland water and no watercourses. They still bake
    # correctly - a lake simply stays part of the land it sits in, which is
    # what they did before.
    def as_mp(geom) -> MultiPolygon:
        if isinstance(geom, Polygon):
            return MultiPolygon([geom]) if not geom.is_empty else MultiPolygon()
        return geom

    def from_shapefile(shp: str) -> Tuple[MultiPolygon, List[WaterBody], List[Watercourse]]:
        # One shapefile stands in for all three Overpass-path phases.
        if progress is not None:
            progress.begin('coast', f'loading land polygons from {shp}')
        land = as_mp(load_land_shp(shp, bbox))
        if progress is not None:
            progress.end(f'{len(land.geoms)} polygons')
            progress.skip('water', 'shapefile input carries no inland water')
            progress.skip('land', 'shapefile input is already assembled')
        return land, [], []

    if args.land_shp:
        print(f'loading land polygons from {args.land_shp}')
        return from_shapefile(args.land_shp)

    if args.pbf:
        with tempfile.TemporaryDirectory() as tmp:
            shp = os.path.join(tmp, 'land_polygons.shp')
            if run_osmcoastline(args.pbf, shp):
                print(f'osmcoastline produced {shp}')
                return from_shapefile(shp)
            print('osmcoastline not available — falling back to Overpass', file=sys.stderr)

    data = overpass_query(bbox, getattr(args, 'refresh_osm', False), progress)
    print(f'  {len(data.get("elements", []))} OSM elements')
    if progress is not None:
        progress.begin('land')
    land, inland, courses = _polygons_from_osm(data, bbox, progress.update if progress is not None else None)
    # The answer covers whole grid cells around the bbox, so a lake or a
    # river wholly outside it came along too. Land is already clipped; the
    # bodies and courses are kept only where they reach the bbox, or the
    # height sampling would go looking for DEM that was never fetched.
    clip = bbox.as_box()
    inland = [body for body in inland if body.geom.intersects(clip)]
    courses = [course for course in courses if course.line.intersects(clip)]
    if progress is not None:
        progress.end(f'{len(land.geoms)} land polygons, {len(inland)} inland bodies, '
                     f'{len(courses)} watercourses')
    return land, inland, courses


def rasterize_tile(land_prep, land_geom, b: Bounds, n: int) -> bytearray:
    """Return row-major uint8 mask (LAND/WATER)."""
    if land_geom.is_empty:
        # No land reaches this tile: all water, whichever backend. The
        # block path hands in a clipped piece with no prepared geometry,
        # so this must not fall through to the point tests below.
        return bytearray(bytes([WATER]) * (n * n))
    if HAS_RASTERIO:
        # rasterio row 0 = north; matches PDM node ordering.
        transform = transform_from_bounds(b.west, b.south, b.east, b.north, n, n)
        geoms = land_geom.geoms if isinstance(land_geom, MultiPolygon) else [land_geom]
        shapes = [(g, LAND) for g in geoms if not g.is_empty]
        grid = rasterize(
            shapes,
            out_shape=(n, n),
            transform=transform,
            fill=WATER,
            dtype=np.uint8,
        )
        return bytearray(grid.tobytes(order='C'))
    out = bytearray(n * n)
    lon_step = (b.east - b.west) / (n - 1)
    lat_step = (b.north - b.south) / (n - 1)
    for row in range(n):
        lat = b.north - row * lat_step
        for col in range(n):
            lon = b.west + col * lon_step
            out[row * n + col] = LAND if land_prep.contains(Point(lon, lat)) else WATER
    return out


def encode_lwm(grid: bytes, n: int) -> bytes:
    header = struct.pack('<4sHBB', LWM_MAGIC, n, 0, 0)
    payload = header + grid
    return zlib.compress(payload, 6)


def vector_simplify_tol(z: int, max_zoom: int, tile_size: int) -> float:
    """Degrees — ~15% of a grid cell, scaled coarser at lower zoom."""
    span = 180.0 / (1 << z)
    cell = span / max(1, tile_size - 1)
    return cell * 0.15 * (2 ** max(0, max_zoom - z))


def simplified_clipped_land(
    land: MultiPolygon,
    b: Bounds,
    tolerance: float,
) -> List[Polygon]:
    """Land clipped to a tile and simplified, as a flat list of Polygons.

    The shared first half of `clip_vector_polys` below, split out so
    `osm_regions.assemble_tile_regions` can overlay landuse polygons against
    exactly the same simplified boundary the `.lvr` polygon layer itself
    uses at this tile - not a second, independently-simplified copy of it,
    which is exactly the failure mode that made inland water rings
    unsimplified in the first place (see shoreline.ts's own docstring on
    that). Whatever this returns is final: nothing downstream simplifies it
    again.
    """
    tile_box = box(b.west, b.south, b.east, b.north)
    clipped = land.intersection(tile_box)
    if clipped.is_empty:
        return []
    if isinstance(clipped, Polygon):
        geoms: Sequence[Polygon] = [clipped]
    elif isinstance(clipped, MultiPolygon):
        geoms = list(clipped.geoms)
    else:
        # A GeometryCollection, which is what an intersection returns when the
        # land also touches the tile along an edge or at a corner: polygons
        # plus a stray line or point. Returning nothing here discarded every
        # scrap of land on the tile, and it came out as open water from edge to
        # edge - 12/4391/856 in the Berlin bake, 77.6% land by area.
        geoms = [g for g in getattr(clipped, 'geoms', []) if isinstance(g, Polygon)]
    out: List[Polygon] = []
    for geom in geoms:
        if geom.is_empty:
            continue
        out.extend(_simplified_parts(geom, tolerance))
    return out


def clip_vector_polys(
    land: MultiPolygon,
    b: Bounds,
    tolerance: float,
) -> List[Tuple[List[Tuple[float, float]], List[List[Tuple[float, float]]]]]:
    """Clip OSM land to a tile and return (exterior, holes) coord lists."""
    out: List[Tuple[List[Tuple[float, float]], List[List[Tuple[float, float]]]]] = []
    for poly in simplified_clipped_land(land, b, tolerance):
        rings = _rings_of(poly)
        if rings is not None:
            out.append(rings)
    return out


def _simplified_parts(geom: Polygon, tolerance: float) -> List[Polygon]:
    """Simplify a clipped piece, as a list of polygons.

    A list rather than one polygon because `simplify` may hand back a
    MultiPolygon - a shape that touches itself at a point comes apart when the
    tolerance pulls it open, and `preserve_topology` keeps the pieces rather
    than the join. The old code tested `isinstance(..., Polygon)` and dropped
    anything else on the floor, which threw away the entire land polygon of a
    tile whenever it happened: on the Berlin bake that was 12/4391/856, which
    came out as open water from edge to edge.
    """
    simplified = geom.simplify(tolerance, preserve_topology=True) if tolerance > 0 else geom
    if simplified.is_empty:
        return []
    if isinstance(simplified, Polygon):
        return [simplified]
    return [g for g in getattr(simplified, 'geoms', []) if isinstance(g, Polygon) and not g.is_empty]


def _rings_of(poly: Polygon) -> Optional[Tuple[List[Tuple[float, float]], List[List[Tuple[float, float]]]]]:
    ext = [(float(x), float(y)) for x, y in poly.exterior.coords[:-1]]
    if len(ext) < 3:
        return None
    holes: List[List[Tuple[float, float]]] = []
    for interior in poly.interiors:
        ring = [(float(x), float(y)) for x, y in interior.coords[:-1]]
        if len(ring) >= 3:
            holes.append(ring)
    return ext, holes


def _encode_ring(ring: Sequence[Tuple[float, float]]) -> bytes:
    out = struct.pack('<H', len(ring))
    for lon, lat in ring:
        out += struct.pack('<ff', float(lon), float(lat))
    return out


def clip_inland_bodies(
    bodies: Sequence[WaterBody],
    b: Bounds,
    tolerance: float,
) -> List[Tuple[Optional[float], List[Tuple[float, float]], List[List[Tuple[float, float]]]]]:
    """Clip inland bodies to a tile, carrying each body's surface height along.

    The height is resolved once per body, over its whole perimeter, and then
    stamped onto every clipped piece. That is what keeps a lake spanning four
    tiles - or the same lake rebuilt at four zoom levels - at a single height,
    so it cannot step or crack along a seam.
    """
    tile_box = box(b.west, b.south, b.east, b.north)
    out: List[Tuple[Optional[float], List[Tuple[float, float]], List[List[Tuple[float, float]]]]] = []
    for body in bodies:
        minx, miny, maxx, maxy = body.geom.bounds
        if maxx < b.west or minx > b.east or maxy < b.south or miny > b.north:
            continue
        clipped = body.geom.intersection(tile_box)
        if clipped.is_empty:
            continue
        if isinstance(clipped, Polygon):
            geoms: Sequence[Polygon] = [clipped]
        elif isinstance(clipped, MultiPolygon):
            geoms = list(clipped.geoms)
        else:
            geoms = [g for g in getattr(clipped, 'geoms', []) if isinstance(g, Polygon)]
        for geom in geoms:
            if geom.is_empty:
                continue
            for poly in _simplified_parts(geom, tolerance):
                rings = _rings_of(poly)
                if rings is not None:
                    out.append((body.height, rings[0], rings[1]))
    return out


def clip_watercourses(
    courses: Sequence[Watercourse],
    b: Bounds,
    tolerance: float,
) -> List[Tuple[float, List[Tuple[float, float]]]]:
    """Clip watercourse centrelines to a tile as (width_m, points) runs.

    A line crossing a tile corner comes back as several runs, and each is kept
    separately rather than joined: they are strokes, and a stroke joined across
    ground it does not cover would draw a river through the land between.

    The clip is to the tile box exactly, with no margin. The stroke is drawn on
    the tile's own mesh, so a run reaching past the border would be drawn twice
    - once by each tile - at two different terrain heights.
    """
    tile_box = box(b.west, b.south, b.east, b.north)
    out: List[Tuple[float, List[Tuple[float, float]]]] = []
    for course in courses:
        minx, miny, maxx, maxy = course.line.bounds
        if maxx < b.west or minx > b.east or maxy < b.south or miny > b.north:
            continue
        try:
            clipped = course.line.intersection(tile_box)
        except Exception:
            continue
        if clipped.is_empty:
            continue
        parts = ([clipped] if isinstance(clipped, LineString)
                 else [g for g in getattr(clipped, 'geoms', [])
                       if isinstance(g, LineString)])
        for part in parts:
            if tolerance > 0:
                part = part.simplify(tolerance, preserve_topology=False)
            pts = [(float(x), float(y)) for x, y in part.coords]
            if len(pts) >= 2:
                out.append((course.width_m, pts))
    return out


def _encode_polys(
    polys: Sequence[Tuple[List[Tuple[float, float]], List[List[Tuple[float, float]]]]],
) -> bytes:
    out = struct.pack('<H', len(polys))
    for ext, holes in polys:
        out += struct.pack('<H', 1 + len(holes))
        out += _encode_ring(ext)
        for hole in holes:
            out += _encode_ring(hole)
    return out


def encode_lvr(
    polys: Sequence[Tuple[List[Tuple[float, float]], List[List[Tuple[float, float]]]]],
    inland: Sequence[Tuple[Optional[float], List[Tuple[float, float]], List[List[Tuple[float, float]]]]] = (),
    lines: Sequence[Tuple[float, List[Tuple[float, float]]]] = (),
    regions: Sequence[
        Tuple[bool, Optional[int], List[Tuple[float, float]], List[List[Tuple[float, float]]]]
    ] = (),
) -> bytes:
    """LVR4 with combined regions, LVR3 with watercourses, LVR2 with inland
    water, LVR1 with none of those.

    The version is the highest layer the tile actually has something in, so a
    tile with no lake, no river and no landuse region stays LVR1 and
    byte-identical to what is already baked - adding a layer re-writes only
    the tiles it has something to say about. Layers below the chosen version
    are still written in full (an LVR4 tile carries its inland and
    watercourse sections even when both are empty) - `decodeLvr` in
    tools/bake/lvr.ts reads every section up to and including its own magic,
    unconditionally.

    A body with no resolved height writes NaN, which the mesh bake reads as
    "follow the DEM" - the same treatment flowing water gets. A region with
    no OSM landuse tag (bare land, or water) writes REGION_CLASS_NONE.
    """
    if not inland and not lines and not regions:
        return zlib.compress(bytes(bytearray(LVR_MAGIC) + _encode_polys(polys)), 6)
    magic = LVR4_MAGIC if regions else (LVR3_MAGIC if lines else LVR2_MAGIC)
    payload = bytearray(magic)
    payload += _encode_polys(polys)
    payload += struct.pack('<H', len(inland))
    for height, ext, holes in inland:
        payload += struct.pack('<f', float('nan') if height is None else float(height))
        payload += struct.pack('<H', 1 + len(holes))
        payload += _encode_ring(ext)
        for hole in holes:
            payload += _encode_ring(hole)
    if magic in (LVR3_MAGIC, LVR4_MAGIC):
        payload += struct.pack('<H', len(lines))
        for width_m, pts in lines:
            payload += struct.pack('<f', float(width_m))
            payload += _encode_ring(pts)
    if magic == LVR4_MAGIC:
        payload += struct.pack('<H', len(regions))
        for is_land, cls, ext, holes in regions:
            payload += struct.pack(
                '<BB', 1 if is_land else 0, REGION_CLASS_NONE if cls is None else cls)
            payload += struct.pack('<H', 1 + len(holes))
            payload += _encode_ring(ext)
            for hole in holes:
                payload += _encode_ring(hole)
    return zlib.compress(bytes(payload), 6)


def write_lvr(out_dir: str, z: int, x: int, y: int, blob: bytes) -> int:
    path = os.path.join(out_dir, str(z), str(x))
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, f'{y}.lvr'), 'wb') as fh:
        fh.write(blob)
    return len(blob)


def write_lwm(out_dir: str, z: int, x: int, y: int, blob: bytes) -> int:
    path = os.path.join(out_dir, str(z), str(x))
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, f'{y}.lwm'), 'wb') as fh:
        fh.write(blob)
    return len(blob)


def _progress_reporter(
    total: int, label: str, gate: int = 1, progress: Optional[PhaseProgress] = None,
):
    """Closure that reports `label i/total` on a ~2% cadence. Cosmetic only.

    With `progress` it hands the count to the stage model instead of printing
    it, and ignores `gate`: the stage percentage should move even through a
    level of five tiles.
    """
    step = max(1, total // 50)
    state = {'done': 0}

    def report() -> None:
        state['done'] += 1
        done = state['done']
        if done % step != 0 and done != total:
            return
        if progress is not None:
            progress(done / total, f'{done}/{total}')
        elif total > gate:
            print(f'  {label} {done}/{total}', flush=True)

    return report


# Per-worker state shared by the rasterize and clip workers. Loaded once per
# worker process, from the pickle the parent publishes, on the first task.
_wk_state_path = ''
_wk_loaded = False
_wk_out_dir = ''
_wk_tile_size = 0
_wk_land: Optional[MultiPolygon] = None
_wk_land_prep = None
_wk_inland: Sequence['WaterBody'] = ()
_wk_courses: Sequence['Watercourse'] = ()
_wk_landuse_tree: Optional['STRtree'] = None
_wk_landuse_polys: Sequence[Polygon] = ()
_wk_landuse_classes: Sequence[int] = ()


def _init_worker(state_path: str) -> None:
    global _wk_state_path
    _wk_state_path = state_path


def _ensure_worker_state() -> None:
    """Load the bake's shared inputs, the first time this worker needs them."""
    global _wk_loaded, _wk_out_dir, _wk_tile_size, _wk_land, _wk_land_prep, _wk_inland, _wk_courses
    global _wk_landuse_tree, _wk_landuse_polys, _wk_landuse_classes
    if _wk_loaded:
        return
    with open(_wk_state_path, 'rb') as fh:
        state = pickle.load(fh)
    _wk_out_dir = state['out_dir']
    _wk_tile_size = state['tile_size']
    _wk_land = state['land']
    _wk_land_prep = None if HAS_RASTERIO else prep(_wk_land)
    _wk_inland = state['inland']
    _wk_courses = state['courses']
    _wk_landuse_polys = state['landuse_polys']
    _wk_landuse_classes = state['landuse_classes']
    # Built here rather than shipped: an STRtree over a few thousand
    # polygons takes milliseconds to build and far longer to pickle.
    _wk_landuse_tree = STRtree(_wk_landuse_polys) if _wk_landuse_polys else None
    _wk_loaded = True


RasterBlock = Tuple[int, List[Tuple[int, int]]]
"""(zoom, the tiles of one block) - the unit of rasterize work."""

# Tiles per block side. A block is clipped out of the land once and its
# tiles are rasterized from that piece, so the land's full vertex count is
# paid per block, not per tile.
RASTER_BLOCK_TILES = 8


def _polygonal(geom) -> MultiPolygon:
    """Just the polygon parts of a clip result, as one MultiPolygon."""
    if geom.is_empty:
        return MultiPolygon()
    if isinstance(geom, Polygon):
        return MultiPolygon([geom])
    if isinstance(geom, MultiPolygon):
        return geom
    parts = [g for g in getattr(geom, 'geoms', []) if isinstance(g, Polygon) and not g.is_empty]
    return MultiPolygon(parts)


def _clip_rect(geom, west: float, south: float, east: float, north: float) -> MultiPolygon:
    """The polygon parts of `geom` inside a rectangle.

    `clip_by_rect` is a plain cut with no topology and is what makes the
    block rasterize cheap, but GEOS refuses it on a zero-area part - a
    collinear sliver the land union can carry after simplification, which
    it reports as "Invalid number of points in LinearRing found 3". One
    such sliver in a regional box killed a 33-minute bake at the last
    stage. When the cut refuses, fall back to a topological intersection
    of the repaired geometry, which drops the sliver and is only paid for
    the block that holds one.
    """
    try:
        return _polygonal(shapely.clip_by_rect(geom, west, south, east, north))
    except shapely.errors.GEOSException:
        return _polygonal(shapely.make_valid(geom).intersection(box(west, south, east, north)))


def rasterize_block(land, z: int, tiles: Sequence[Tuple[int, int]], n: int) -> List[Tuple[int, int, bytearray]]:
    """Rasterize a block of tiles from the land clipped to the block.

    `rasterize_tile` hands rasterio the whole land geometry for every
    tile, and a regional box's land runs to hundreds of thousands of
    vertices - a Pamir box measured 425k, 3.7 s per tile, nine minutes for
    the level on 19 workers. Clipping is a plain rectangle cut with no
    topology (`clip_by_rect`), done once per block and once more per tile,
    so each tile rasterizes only the geometry that reaches it. The clip
    rectangle is padded by a cell, so no pixel centre ever sits on a clip
    edge and the result is the same as rasterizing the full land.
    """
    xs = [x for x, _ in tiles]
    ys = [y for _, y in tiles]
    nw = tile_bounds(z, min(xs), min(ys))
    se = tile_bounds(z, max(xs), max(ys))
    cell = (nw.north - nw.south) / max(1, n - 1)
    block = _clip_rect(land, nw.west - cell, se.south - cell, se.east + cell, nw.north + cell)
    out: List[Tuple[int, int, bytearray]] = []
    for x, y in tiles:
        b = tile_bounds(z, x, y)
        piece = _clip_rect(block, b.west - cell, b.south - cell, b.east + cell, b.north + cell)
        out.append((x, y, rasterize_tile(None, piece, b, n)))
    return out


def raster_blocks(z: int, tiles: Sequence[Tuple[int, int]]) -> List[RasterBlock]:
    """The tiles grouped into aligned blocks of RASTER_BLOCK_TILES a side."""
    groups: Dict[Tuple[int, int], List[Tuple[int, int]]] = {}
    for x, y in tiles:
        groups.setdefault((x // RASTER_BLOCK_TILES, y // RASTER_BLOCK_TILES), []).append((x, y))
    return [(z, groups[key]) for key in sorted(groups)]


def _rasterize_worker(task: RasterBlock) -> List[Tuple[int, int, bytearray]]:
    _ensure_worker_state()
    z, tiles = task
    if not HAS_RASTERIO:
        # The point-in-polygon fallback tests against the prepared full land.
        return [(x, y, rasterize_tile(_wk_land_prep, _wk_land, tile_bounds(z, x, y), _wk_tile_size))
                for x, y in tiles]
    return rasterize_block(_wk_land, z, tiles, _wk_tile_size)


ClipTask = Tuple[int, int, int, bytearray, float, float, Optional[List[Tuple[int, bytes]]]]
"""(z, x, y, mask grid, simplify tol, line tol, the children's claimed landuse pieces or None)."""


def _clip_worker(task: ClipTask) -> 'Tuple[int, int, ClipResult]':
    _ensure_worker_state()
    z, x, y, grid, tol, line_tol, child_claims = task
    return x, y, _clip_worker_inline(
        _wk_out_dir, _wk_tile_size, _wk_land, _wk_inland, _wk_courses, z, x, y, grid, tol, line_tol,
        _wk_landuse_tree, _wk_landuse_polys, _wk_landuse_classes, child_claims,
    )


class TilePool:
    """One pool of worker processes for the whole bake, or none at all.

    The rasterize pass and every one of the thirteen clip levels used to
    spawn a pool of their own. On Windows a spawned worker re-imports
    shapely, rasterio and numpy from scratch, and each pool's initargs
    shipped the entire landuse polygon set and its STRtree by pickle to
    every worker again - overhead that did no work and, measured on
    Madeira, took longer than rasterizing the 75 tiles it was spawned for.

    The pool is started as early as the bake can, before the Overpass
    fetches and the single-threaded polygon assembly, so the worker
    start-up overlaps them. What the workers need is not known until that
    assembly is done, so it is `publish`ed to one pickle file afterwards
    and each worker loads it once on its first task - the same bytes as
    initargs would carry, but written once instead of serialised per
    worker through the pipe.

    `jobs == 1` (or nothing to do) runs everything inline in this process
    instead, which keeps a single-worker bake free of multiprocessing.
    """

    def __init__(self, jobs: int) -> None:
        self.jobs = max(1, jobs)
        self.pool = None
        self._dir: Optional[tempfile.TemporaryDirectory] = None
        self.state_path = ''

    def start(self) -> 'TilePool':
        if self.jobs > 1 and self.pool is None:
            self._dir = tempfile.TemporaryDirectory(prefix='coast-bake-')
            self.state_path = os.path.join(self._dir.name, 'state.pickle')
            ctx = mp.get_context('spawn')
            self.pool = ctx.Pool(self.jobs, initializer=_init_worker, initargs=(self.state_path,))
        return self

    def publish(self, **state) -> None:
        """Write what every worker will load: the bake's shared inputs."""
        if self.pool is None:
            return
        with open(self.state_path, 'wb') as fh:
            pickle.dump(state, fh, protocol=pickle.HIGHEST_PROTOCOL)

    def __enter__(self) -> 'TilePool':
        return self.start()

    def __exit__(self, *exc) -> None:
        self.close()

    def close(self) -> None:
        if self.pool is not None:
            self.pool.close()
            self.pool.join()
            self.pool = None
        if self._dir is not None:
            self._dir.cleanup()
            self._dir = None

    def map(self, fn, inline, tasks, chunksize: int = 8):
        """`fn` across the workers, unordered; `inline(task)` here when there are none."""
        if self.pool is None or len(tasks) <= 1:
            return (inline(t) for t in tasks)
        return self.pool.imap_unordered(fn, tasks, chunksize=chunksize)


def rasterize_level_parallel(
    land: MultiPolygon,
    tile_size: int,
    z: int,
    tiles: Sequence[Tuple[int, int]],
    pool: TilePool,
    progress: Optional[PhaseProgress] = None,
) -> Dict[Tuple[int, int], bytearray]:
    """Rasterizes every tile at the finest level, across the pool's workers.

    Each tile only reads the same fixed `land` polygon and writes its own grid
    keyed by (x, y) - independent of every other tile, with no order
    dependence in the result (every caller re-sorts before writing). The
    ancestor levels below it are a different story: `build_parent_mask`
    reloads siblings off disk and must run level by level, serially - see
    `bake()`.
    """
    level_grids: Dict[Tuple[int, int], bytearray] = {}
    total = len(tiles)
    if total == 0:
        return level_grids
    report = _progress_reporter(total, 'rasterize', gate=0, progress=progress)

    land_prep = None if HAS_RASTERIO else prep(land)

    def inline(task: RasterBlock) -> List[Tuple[int, int, bytearray]]:
        bz, block_tiles = task
        if not HAS_RASTERIO:
            return [(x, y, rasterize_tile(land_prep, land, tile_bounds(bz, x, y), tile_size))
                    for x, y in block_tiles]
        return rasterize_block(land, bz, block_tiles, tile_size)

    for block in pool.map(_rasterize_worker, inline, raster_blocks(z, tiles), chunksize=1):
        for x, y, grid in block:
            level_grids[(x, y)] = grid
            report()
    return level_grids


def clip_level_parallel(
    out_dir: str,
    tile_size: int,
    land: MultiPolygon,
    inland: Sequence['WaterBody'],
    courses: Sequence['Watercourse'],
    z: int,
    tol: float,
    line_tol: float,
    items: Sequence[Tuple[Tuple[int, int], bytearray]],
    pool: TilePool,
    landuse_tree: Optional['STRtree'] = None,
    landuse_polys: Sequence[Polygon] = (),
    landuse_classes: Sequence[int] = (),
    progress: Optional[PhaseProgress] = None,
    child_claims: Optional[Dict[Tuple[int, int], List[Tuple[int, bytes]]]] = None,
) -> Tuple[int, int, int, int, int, Dict[Tuple[int, int], List[Tuple[int, bytes]]]]:
    """Writes .lwm and clips+writes .lvr for one level, across the pool's workers.

    Each tile's mask is already decided (`items` carries the grid), so all
    that is left per tile is independent: clip the same fixed `land`/`inland`/
    `courses` to that tile's box and write its own two files. Returns
    (total_lwm_bytes, written, lvr_written, total_lvr_bytes, total_lines,
    claims), where `claims` maps each tile to the landuse pieces it claimed,
    for the next level up to derive its regions from; `child_claims` is the
    same map one level finer, already grouped under this level's keys.

    What must NOT be parallelised is the ancestor rebuild that follows this
    level in `bake()`: it reloads siblings this level just wrote back off
    disk and decimates level by level, so it has to see every write here
    completed in order, one level at a time.
    """
    total = len(items)
    total_bytes = 0
    written = 0
    lvr_written = 0
    total_lvr_bytes = 0
    total_lines = 0
    claims: Dict[Tuple[int, int], List[Tuple[int, bytes]]] = {}
    if total == 0:
        return total_bytes, written, lvr_written, total_lvr_bytes, total_lines, claims
    report = _progress_reporter(total, f'clip {z}', gate=40, progress=progress)

    def inline(task: ClipTask) -> Tuple[int, int, ClipResult]:
        tz, x, y, grid, ttol, tline_tol, kids = task
        return x, y, _clip_worker_inline(
            out_dir, tile_size, land, inland, courses, tz, x, y, grid, ttol, tline_tol,
            landuse_tree, landuse_polys, landuse_classes, kids,
        )

    tasks: List[ClipTask] = [
        (z, x, y, grid, tol, line_tol, child_claims.get((x, y)) if child_claims is not None else None)
        for (x, y), grid in items
    ]
    for x, y, (lwm_bytes, has_lvr, lvr_bytes, num_lines, tile_claims) in pool.map(_clip_worker, inline, tasks):
        total_bytes += lwm_bytes
        written += 1
        if has_lvr:
            lvr_written += 1
            total_lvr_bytes += lvr_bytes
            total_lines += num_lines
        if tile_claims is not None:
            claims[(x, y)] = tile_claims
        report()
    return total_bytes, written, lvr_written, total_lvr_bytes, total_lines, claims


def encode_regions_for_tile(
    simplified_land: Sequence[Polygon],
    landuse_tree: Optional['STRtree'],
    landuse_polys: Sequence[Polygon],
    landuse_classes: Sequence[int],
    b: Bounds,
    child_claims: Optional[Sequence[Tuple[int, bytes]]] = None,
    tol: float = 0.0,
) -> Tuple[
    List[Tuple[bool, Optional[int], List[Tuple[float, float]], List[List[Tuple[float, float]]]]],
    List[Tuple[int, bytes]],
]:
    """The tile's combined land/landuse partition, as LVR4-ready ring tuples,
    plus its claimed landuse pieces as (class, WKB) for the parent tile to
    derive its own partition from.

    `simplified_land` must be the same list `clip_vector_polys` builds this
    tile's own `.lvr` polygon layer from - see `simplified_clipped_land`'s
    docstring for why reusing it, rather than re-clipping and re-simplifying
    independently, is what keeps this layer's outer boundary from cracking
    against the plain coastline layer.

    With `child_claims` (the pieces of this tile's four children one level
    finer) and this level's simplify `tol`, the partition is derived from
    them instead of resolved from the landuse polygons again.
    """
    if landuse_tree is None:
        return [], []
    tile_box = box(b.west, b.south, b.east, b.north)
    land_mp = MultiPolygon(list(simplified_land)) if simplified_land else MultiPolygon()
    if child_claims is not None:
        # A coarser level: the children one level finer already resolved
        # every landuse boundary here, so their pieces are merged rather
        # than the overlay run again over four times the candidates.
        regions = derive_tile_regions(
            tile_box, land_mp, [(cls, wkb_loads(blob)) for cls, blob in child_claims], tol)
    else:
        # Widens only the STRtree query below, guarding a candidate whose true
        # geometry reaches the tile but whose envelope is a hair outside it after
        # floating-point clipping - see assemble_tile_regions's own docstring.
        halo_box = tile_box.buffer((b.east - b.west) * 0.02)
        regions = assemble_tile_regions(tile_box, halo_box, land_mp, landuse_tree, landuse_polys, landuse_classes)
    out: List[Tuple[bool, Optional[int], List[Tuple[float, float]], List[List[Tuple[float, float]]]]] = []
    claims: List[Tuple[int, bytes]] = []
    for region in regions:
        rings = _rings_of(region.geom)
        if rings is None:
            continue
        ext, holes = rings
        out.append((region.is_land, region.landuse_class, ext, holes))
        if region.is_land and region.landuse_class is not None:
            claims.append((region.landuse_class, wkb_dumps(region.geom)))
    return out, claims


ClipResult = Tuple[int, bool, int, int, Optional[List[Tuple[int, bytes]]]]
"""(lwm bytes, wrote an .lvr, lvr bytes, watercourse strokes, claimed landuse pieces or None)."""


def _clip_worker_inline(
    out_dir: str, tile_size: int, land, inland, courses,
    z: int, x: int, y: int, grid: bytearray, tol: float, line_tol: float,
    landuse_tree=None, landuse_polys: Sequence[Polygon] = (), landuse_classes: Sequence[int] = (),
    child_claims: Optional[Sequence[Tuple[int, bytes]]] = None,
) -> ClipResult:
    """Same body as `_clip_worker`, without the module-global indirection - used for the `jobs == 1` path.

    The claimed landuse pieces come back only from levels whose parent still
    carries regions (z > LANDUSE_REGION_MIN_ZOOM); the parent derives its
    partition from them.
    """
    lwm_bytes = write_lwm(out_dir, z, x, y, encode_lwm(bytes(grid), tile_size))
    b = tile_bounds(z, x, y)
    simplified_land = simplified_clipped_land(land, b, tol)
    polys: List[Tuple[List[Tuple[float, float]], List[List[Tuple[float, float]]]]] = []
    for poly in simplified_land:
        rings = _rings_of(poly)
        if rings is not None:
            polys.append(rings)
    inland_polys = clip_inland_bodies(inland, b, tol) if inland else []
    lines = clip_watercourses(courses, b, line_tol) if courses else []
    regions: list = []
    claims: Optional[List[Tuple[int, bytes]]] = None
    if landuse_tree is not None and z >= LANDUSE_REGION_MIN_ZOOM:
        regions, claims = encode_regions_for_tile(
            simplified_land, landuse_tree, landuse_polys, landuse_classes, b, child_claims, tol)
        if z <= LANDUSE_REGION_MIN_ZOOM:
            claims = None
    if not (polys or inland_polys or lines or regions):
        return lwm_bytes, False, 0, 0, claims
    lvr_bytes = write_lvr(out_dir, z, x, y, encode_lvr(polys, inland_polys, lines, regions))
    return lwm_bytes, True, lvr_bytes, len(lines), claims


def build_parent_mask(children: Dict[Tuple[int, int], bytearray], n: int) -> bytearray:
    half = (n - 1) // 2
    parent = bytearray(n * n)
    for (qx, qy), child in children.items():
        for row in range(half + 1):
            for col in range(half + 1):
                parent[(qy * half + row) * n + (qx * half + col)] = child[row * 2 * n + col * 2]
    return parent


def bake(args: argparse.Namespace) -> int:
    started = time.time()
    manifest_path = args.manifest or os.path.join(args.out, 'manifest.json')
    if not os.path.isfile(manifest_path):
        print(f'error: manifest not found: {manifest_path}', file=sys.stderr)
        return 2
    manifest = load_manifest(manifest_path)
    out_dir = args.out or os.path.dirname(manifest_path)
    tile_size = manifest.get('tileSize', 257)
    min_zoom = manifest.get('minZoom', 0)
    max_zoom = manifest.get('maxZoom', 12)
    cov = manifest.get('coverage', {})
    asked = parse_bbox(args.bbox) if args.bbox else Bounds(
        cov['west'], cov['south'], cov['east'], cov['north'],
    )
    # Whole tiles only: a tile the bbox cuts through would be written land on
    # one side and open sea on the other, over whatever was baked there before.
    bbox = snap_bounds_to_tiles(asked, max_zoom)

    print(f'coverage    lon [{bbox.west:.5f}, {bbox.east:.5f}] '
          f'lat [{bbox.south:.5f}, {bbox.north:.5f}]')
    if bbox != asked:
        print(f'            snapped out to whole zoom-{max_zoom} tiles from '
              f'lon [{asked.west:.5f}, {asked.east:.5f}] '
              f'lat [{asked.south:.5f}, {asked.north:.5f}]')
    print(f'zoom        {min_zoom}..{max_zoom}  tileSize={tile_size}')

    # Weights are a rough share of wall-clock on a regional bbox with cached
    # DEM tiles: the two Overpass answers and the landuse one dominate when
    # they are not cached, the tile work when they are.
    progress = StageProgress([
        ('coast', 'fetching OSM coastline', 12),
        ('water', 'fetching OSM water features', 8),
        ('land', 'assembling land and water polygons', 10),
        ('landuse-fetch', 'fetching OSM landuse', 12),
        ('landuse', 'assembling landuse polygons', 4),
        ('heights', 'sampling inland water heights', 4),
        ('rasterize', f'rasterizing zoom {max_zoom} tiles', 20),
        ('clip', 'writing coast and vector tiles', 30),
    ])

    # Workers start now, so their spawn overlaps the fetches and the
    # single-threaded polygon assembly; they get their inputs later, see
    # TilePool.publish.
    pool = TilePool(args.jobs).start()

    land, inland, courses = assemble_land(bbox, args, progress)
    if not inland and not courses:
        # A silently truncated Overpass answer looks exactly like a box with
        # no water in it, and one such answer was cached and baked for a
        # Berlin box in September 2026: every lake and river came out as
        # land. The per-cell fetch now re-checks an empty cell on another
        # mirror, but this is still worth a line in the log.
        print('warning: no inland water or watercourses at all in this box; if that is '
              'wrong, re-run with --refresh-osm', file=sys.stderr)
    if land.is_empty:
        print('error: no land polygons assembled — check bbox / OSM data', file=sys.stderr)
        return 2

    landuse_tree = None
    landuse_polys: List[Polygon] = []
    landuse_classes: List[int] = []
    if getattr(args, 'osm_landuse', False):
        if not HAS_OSM_LANDUSE:
            print('error: --osm-landuse requires shapely and its own dependencies '
                  '(the osm_landuse/osm_regions modules failed to import)', file=sys.stderr)
            return 2
        progress.begin('landuse-fetch')

        def on_landuse_bytes(index: int, count: int, label: str, received: int) -> None:
            progress.update((index + fetch_fraction(received)) / count,
                            f'({label}) {format_mb(received)} received')
        landuse_data = overpass_landuse_query(
            (bbox.west, bbox.south, bbox.east, bbox.north), args.refresh_osm,
            on_progress=on_landuse_bytes)
        progress.end(f'{len(landuse_data.get("elements", []))} elements')
        progress.begin('landuse')
        landuse_polys, landuse_classes = assemble_landuse_polygons(landuse_data, progress.update)
        print(f'landuse     {len(landuse_polys)} OSM polygons')
        if landuse_polys:
            progress.update(1.0, 'building spatial index', force=True)
            landuse_tree = build_landuse_index(landuse_polys)
        progress.end(f'{len(landuse_polys)} polygons')
    else:
        progress.skip('landuse-fetch', '--osm-landuse not given')
        progress.skip('landuse', '--osm-landuse not given')

    # A mainland coast that fails to close comes out as a handful of islets
    # rather than as nothing, so `is_empty` above does not catch it and the
    # bake writes an entire region as open ocean.
    #
    # It happens because Overpass returns only the coastline ways that touch
    # the bbox: a chain that leaves and re-enters loses the segment between,
    # and `polygonize` cannot close a face across the gap. Crimea landed at
    # 0.000005 of 4.797 deg² this way - 504 coastline ways in, one polygon the
    # size of the whole bbox out, every tile open water.
    #
    # Islands close on themselves and are unaffected, which is why the Canaries
    # have always baked correctly through this path.
    land_fraction = land.area / max(bbox.as_box().area, 1e-12)
    if land_fraction < MIN_PLAUSIBLE_LAND_FRACTION and not args.allow_tiny_land:
        print(f'error: assembled land covers {land_fraction * 100:.4f}% of the bbox, which',
              file=sys.stderr)
        print('       reads as a coastline that did not close rather than an empty sea.',
              file=sys.stderr)
        print('       Build land polygons with osmcoastline and pass --land-shp or --pbf;',
              file=sys.stderr)
        print("       see the priority order in this file's docstring.", file=sys.stderr)
        print('       Pass --allow-tiny-land if the bbox really is almost all water.',
              file=sys.stderr)
        return 2
    print(f'land area   {land.area:.6f} deg²')

    # Inland surface heights come off the DEM that was merged in before this
    # stage ran, so the pyramid is already on disk to read.
    flat_count = sum(1 for b in inland if b.flat)
    if flat_count:
        progress.begin('heights')
        cell_deg = (180.0 / (1 << max_zoom)) / max(1, tile_size - 1)
        dem = DemSampler(out_dir, max_zoom, tile_size)
        resolved = resolve_body_heights(
            inland, dem, cell_deg, manifest.get('seaLevel', 0.0), progress.update)
        print(f'inland      {len(inland)} bodies ({flat_count} flat, '
              f'{len(inland) - flat_count} flowing), {resolved} heights resolved')
        if resolved < flat_count:
            print(f'            {flat_count - resolved} flat bodies had no DEM '
                  f'underneath — baked as flowing water')
        progress.end(f'{resolved}/{flat_count} resolved')
    else:
        progress.skip('heights', 'no flat inland water' if not inland
                      else f'{len(inland)} inland bodies all flowing')

    index_path = os.path.join(out_dir, manifest.get('indexPath', 'index.bin'))
    pdm_tiles = scan_pdm_tiles(out_dir, min_zoom, max_zoom)
    indexed = decode_index(index_path, min_zoom, max_zoom) if os.path.isfile(index_path) else {}
    for z, coords in indexed.items():
        if coords:
            pdm_tiles[z] = coords | pdm_tiles.get(z, set())
    pdm_count = sum(len(v) for v in pdm_tiles.values())
    print(f'pdm tiles   {pdm_count} across zoom {min_zoom}..{max_zoom}')

    # Tiles to bake at max zoom: every indexed PDM tile plus bbox neighbours
    # so open ocean inside the OSM coverage still resolves as water.
    max_tiles: Set[Tuple[int, int]] = set()
    for z, coords in pdm_tiles.items():
        if z == max_zoom:
            max_tiles.update(coords)

    # ...but only inside the bbox. `land` was assembled for the bbox and
    # nothing else, so rasterising a tile outside it does not produce "no data
    # here", it produces open ocean - and writes that over a coast baked
    # earlier. Scoping the tile set is what makes a second area addable
    # without re-fetching OSM for the first.
    bx0, by0, bx1, by1 = tile_range_for_bounds(max_zoom, bbox)
    outside = {t for t in max_tiles if not (bx0 <= t[0] <= bx1 and by0 <= t[1] <= by1)}
    max_tiles -= outside
    if outside:
        print(f'bbox        {len(outside)} PDM tiles outside it left alone')

    if not max_tiles or args.include_ocean_tiles:
        for y in range(by0, by1 + 1):
            for x in range(bx0, bx1 + 1):
                max_tiles.add((x, y))

    total_bytes = 0
    total_lvr_bytes = 0
    total_tiles = 0
    total_lvr_tiles = 0
    total_lines = 0

    progress.begin('rasterize')
    pool.publish(out_dir=out_dir, tile_size=tile_size, land=land, inland=inland, courses=courses,
                 landuse_polys=landuse_polys, landuse_classes=landuse_classes)
    with pool:
        level_grids = rasterize_level_parallel(
            land, tile_size, max_zoom, sorted(max_tiles), pool, progress.update)
        progress.end(f'{len(level_grids)} tiles, {args.jobs} workers')

        print(f'level {max_zoom:2d}    {len(level_grids)} tiles')

        # How many tiles the level walk below will write in all, so its share of
        # the stage moves at one steady rate instead of restarting every level.
        # Ancestor tiles come from the child keys alone (siblings reloaded off
        # disk fill quadrants of a parent that is being written anyway).
        clip_total = 0
        keys = set(level_grids)
        for z in range(max_zoom, min_zoom - 1, -1):
            clip_total += len(keys)
            keys = {(x >> 1, y >> 1) for x, y in keys}
        clip_done = 0
        progress.begin('clip')
        progress.update(0.0, f'{clip_total} tiles over zoom {max_zoom}..{min_zoom}', force=True)

        child_claims: Optional[Dict[Tuple[int, int], List[Tuple[int, bytes]]]] = None
        for z in range(max_zoom, min_zoom - 1, -1):
            tol = vector_simplify_tol(z, max_zoom, tile_size)
            line_tol = ((180.0 / (1 << z)) / max(1, tile_size - 1)) * LINE_SIMPLIFY_CELLS
            items = sorted(level_grids.items())
            level_started = time.monotonic()

            def level_progress(fraction: float, detail: str, z=z, n=len(items)) -> None:
                progress.update((clip_done + fraction * n) / max(1, clip_total), f'zoom {z} {detail}')
            level_bytes, written, lvr_written, level_lvr_bytes, level_lines, level_claims = clip_level_parallel(
                out_dir, tile_size, land, inland, courses, z, tol, line_tol, items, pool,
                landuse_tree, landuse_polys, landuse_classes, progress=level_progress,
                child_claims=child_claims)
            # The landuse pieces this level claimed, grouped under the parent
            # tiles that will derive their own regions from them.
            child_claims = {}
            for (x, y), pieces in level_claims.items():
                child_claims.setdefault((x >> 1, y >> 1), []).extend(pieces)
            clip_done += len(items)
            total_bytes += level_bytes
            total_lvr_bytes += level_lvr_bytes
            total_lines += level_lines
            total_tiles += written
            total_lvr_tiles += lvr_written
            print(f'level {z:2d}    wrote {written} .lwm + {lvr_written} .lvr tiles '
                  f'in {time.monotonic() - level_started:.1f}s', flush=True)
            if z == min_zoom:
                break
            progress.update(clip_done / max(1, clip_total), f'zoom {z - 1} building ancestors',
                            force=True)
            parents: Dict[Tuple[int, int], bytearray] = {}
            parent_children: Dict[Tuple[int, int], Dict[Tuple[int, int], bytearray]] = {}
            for (x, y), grid in level_grids.items():
                key = (x >> 1, y >> 1)
                parent_children.setdefault(key, {})[(x & 1, y & 1)] = grid
            reloaded = 0
            for key, children in parent_children.items():
                # Top the quadrants up from disk before decimating, or the coast of
                # every area baked before this one is replaced with open water in
                # the ancestors they share.
                for qx, qy in ((0, 0), (1, 0), (0, 1), (1, 1)):
                    if (qx, qy) in children:
                        continue
                    sibling = read_lwm(out_dir, z, key[0] * 2 + qx, key[1] * 2 + qy)
                    if sibling is not None:
                        children[(qx, qy)] = sibling
                        reloaded += 1
                parents[key] = build_parent_mask(children, tile_size)
            if reloaded:
                print(f'            {reloaded} siblings reloaded for {len(parents)} ancestors')
            level_grids = parents

    # Union with whatever was already masked, not a replacement: this run only
    # looked at its own bbox, and the tiles baked outside it are still there.
    previous = (manifest.get('coastMask') or {}).get('coverage')
    if previous:
        masked = {
            'west': min(previous['west'], bbox.west),
            'south': min(previous['south'], bbox.south),
            'east': max(previous['east'], bbox.east),
            'north': max(previous['north'], bbox.north),
        }
    else:
        masked = {
            'west': bbox.west, 'south': bbox.south,
            'east': bbox.east, 'north': bbox.north,
        }
    progress.end(f'{total_tiles} .lwm + {total_lvr_tiles} .lvr tiles')
    manifest['version'] = 3
    manifest['coastMask'] = {
        'enabled': True,
        'path': '{z}/{x}/{y}.lwm',
        'vectorPath': '{z}/{x}/{y}.lvr',
        'source': 'osm',
        'coverage': masked,
    }
    with open(manifest_path, 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2)
        fh.write('\n')

    print(f'\nwrote {total_tiles} coast tiles, {total_bytes / (1024 * 1024):.1f} MB (.lwm)')
    print(f'wrote {total_lvr_tiles} vector tiles, {total_lvr_bytes / (1024 * 1024):.1f} MB (.lvr)')
    if courses:
        print(f'wrote {total_lines} watercourse strokes from {len(courses)} centrelines')
    print(f'updated {manifest_path} (version 3 + coastMask)')
    print(f'done in {time.time() - started:.1f}s')
    return 0


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--manifest', help='planet manifest.json (default: {out}/manifest.json)')
    parser.add_argument('--out', default='assets/planet', help='planet asset directory')
    parser.add_argument('--bbox', help='west,south,east,north degrees (default: manifest coverage)')
    parser.add_argument('--pbf', help='regional OSM PBF for osmcoastline')
    parser.add_argument('--land-shp', help='pre-built land polygons shapefile (osmcoastline output)')
    parser.add_argument('--allow-tiny-land', action='store_true',
                        help='accept a bbox that really is almost all water')
    parser.add_argument('--refresh-osm', action='store_true',
                        help='ignore the cached Overpass response and re-fetch')
    parser.add_argument('--osm-landuse', action='store_true',
                        help='cut real landuse-polygon boundaries into the coast vector layer '
                             '(z%d+ only); requires shapely' % LANDUSE_REGION_MIN_ZOOM)
    parser.add_argument('--include-ocean-tiles', action='store_true',
                        help='also bake every tile in the bbox at max zoom (slow; default: PDM tiles only)')
    parser.add_argument('--jobs', type=int, default=DEFAULT_JOBS,
                        help=f'worker processes for rasterizing and clipping (default {DEFAULT_JOBS})')
    raw = list(argv) if argv is not None else sys.argv[1:]
    args = parser.parse_args(glue_negative_bbox(raw))
    return bake(args)


if __name__ == '__main__':
    raise SystemExit(main())

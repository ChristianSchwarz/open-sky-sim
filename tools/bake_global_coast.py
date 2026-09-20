#!/usr/bin/env python3
"""Cut a coastline for the coarse global tiles out of their own heights.

The mesh bake decides what is land from a tile's coast polygons (``.lvr``), and
only from those: the heights fill the interior, they never say where the shore
is. A tile with no ``.lvr`` is therefore all sea, however high its DEM rises.
The regional bake writes one per tile from OpenStreetMap, which is right and
unaffordable for the whole planet, so the global tiles (see
``merge_global_pyramid.py``) had none, and every coarse tile over a continent
came out as ocean with nothing drawn on it.

This writes the ``.lvr`` and ``.lwm`` for those tiles from the DEM instead: the
sea-level contour of the tile's own 257x257 heights, found on a 4x bilinear
upsample so the shore sits between nodes and not on them. At the global tree's
resolution (1.85 km) that is the coastline to within a node, which is all a
tile seen from orbit can use.

A tile that overlaps a baked area already has OSM coast polygons, and inside
the area they are the better ones. So there the two are merged:

    inside the areas   -> the existing polygons
    everywhere else    -> the DEM contour

and the lake and river layers of the existing ``.lvr`` are carried through
untouched (they are everything after the polygon section).

Usage::

    python tools/bake_global_coast.py --out assets/planet

Requires ``numpy``, ``opencv-python`` and ``shapely``.
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import zlib
from typing import List, Optional, Tuple

import cv2
import numpy as np
from shapely.geometry import MultiPolygon, Polygon, box
from shapely.ops import unary_union

import bake_osm_coast as coast
import bake_planet_cover as cover
import bake_planet_dem as dem
import merge_global_pyramid as merge

Ring = List[Tuple[float, float]]

# Upsample factor for the contour: the shore lands between nodes.
UPSAMPLE = 4
# Anything above this many metres is land, matching the mesh bake's WATER_HEIGHT_EPS_M.
LAND_M = 0.5
# Ring simplification, in nodes. A node at z6 is a kilometre; a tenth of one is far under
# anything the tile can show.
SIMPLIFY_NODES = 0.15
# Land smaller than this many node-squares is dropped: a single-sample island at 1.85 km
# is noise in the source, not an island.
MIN_AREA_NODES = 1.5


def contour_polygons(heights: np.ndarray, west: float, south: float, east: float, north: float) -> List[Polygon]:
    """Land polygons, in lon/lat, from the sea-level contour of a node grid."""
    n = heights.shape[0]
    grid = np.nan_to_num(heights, nan=0.0).astype(np.float32)
    if not (grid > LAND_M).any():
        return []
    size = (n - 1) * UPSAMPLE + 1
    fine = cv2.resize(grid, (size, size), interpolation=cv2.INTER_LINEAR)
    mask = (fine > LAND_M).astype(np.uint8)
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return []
    hierarchy = hierarchy[0]

    span = size - 1

    def to_lonlat(points: np.ndarray) -> Ring:
        xs = points[:, 0, 0] / span
        ys = points[:, 0, 1] / span
        return [(west + (east - west) * float(x), north - (north - south) * float(y)) for x, y in zip(xs, ys)]

    polys: List[Polygon] = []
    for i, contour in enumerate(contours):
        if hierarchy[i][3] != -1 or len(contour) < 3:
            continue
        holes = []
        child = hierarchy[i][2]
        while child != -1:
            if len(contours[child]) >= 3:
                holes.append(to_lonlat(contours[child]))
            child = hierarchy[child][0]
        poly = Polygon(to_lonlat(contour), holes)
        if not poly.is_valid:
            poly = poly.buffer(0)
        polys.append(poly)

    node_deg2 = ((east - west) / (n - 1)) * ((north - south) / (n - 1))
    tol = SIMPLIFY_NODES * (east - west) / (n - 1)
    out: List[Polygon] = []
    for poly in polys:
        for part in (poly.geoms if isinstance(poly, MultiPolygon) else [poly]):
            if part.is_empty or part.area < MIN_AREA_NODES * node_deg2:
                continue
            simple = part.simplify(tol, preserve_topology=True)
            if not simple.is_empty:
                out.extend(simple.geoms if isinstance(simple, MultiPolygon) else [simple])
    return out


def read_polys(payload: bytes, offset: int) -> Tuple[List[Polygon], int]:
    """The leading polygon section of an LVR payload, and where it ends."""
    (count,) = struct.unpack_from('<H', payload, offset)
    offset += 2
    polys: List[Polygon] = []
    for _ in range(count):
        (rings,) = struct.unpack_from('<H', payload, offset)
        offset += 2
        parsed: List[Ring] = []
        for _r in range(rings):
            (npts,) = struct.unpack_from('<H', payload, offset)
            offset += 2
            pts = struct.unpack_from('<' + 'ff' * npts, payload, offset)
            offset += 8 * npts
            parsed.append(list(zip(pts[0::2], pts[1::2])))
        if parsed and len(parsed[0]) >= 3:
            poly = Polygon(parsed[0], [r for r in parsed[1:] if len(r) >= 3])
            polys.append(poly if poly.is_valid else poly.buffer(0))
    return polys, offset


def rings_of(poly: Polygon) -> Tuple[Ring, List[Ring]]:
    return list(poly.exterior.coords)[:-1], [list(h.coords)[:-1] for h in poly.interiors]


def flatten(geom) -> List[Polygon]:
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    return [g for part in geom.geoms for g in flatten(part)]


def bake_tile(out: str, z: int, x: int, y: int, areas: List[Tuple[float, float, float, float]]) -> str:
    tile = dem.read_tile(out, z, x, y)
    if tile is None:
        return 'no heights'
    heights = tile[0]
    n = heights.shape[0]
    west, south, east, north = cover.tile_bounds(z, x, y)
    lvr_path = os.path.join(out, str(z), str(x), f'{y}.lvr')

    dem_polys = contour_polygons(heights, west, south, east, north)
    tail = b''
    magic = coast.LVR_MAGIC
    kind = 'dem'
    if os.path.exists(lvr_path):
        with open(lvr_path, 'rb') as fh:
            payload = zlib.decompress(fh.read())
        magic = payload[:4]
        osm_polys, end = read_polys(payload, 4)
        tail = payload[end:]
        inside = unary_union([box(*a) for a in areas]) if areas else Polygon()
        dem_part = unary_union(dem_polys).difference(inside) if dem_polys else Polygon()
        osm_part = unary_union(osm_polys).intersection(inside) if osm_polys else Polygon()
        dem_polys = flatten(unary_union([dem_part, osm_part]))
        kind = 'merged'

    body = coast._encode_polys([rings_of(p) for p in dem_polys])
    blob = zlib.compress(bytes(magic) + body + tail, 6)
    coast.write_lvr(out, z, x, y, blob)

    geom = unary_union(dem_polys) if dem_polys else Polygon()
    mask = coast.rasterize_tile(None, geom, coast.Bounds(west, south, east, north), n)
    coast.write_lwm(out, z, x, y, coast.encode_lwm(bytes(mask), n))
    return kind


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default='assets/planet', help='the merged pyramid, edited in place')
    ap.add_argument('--max-zoom', type=int, default=None, help='deepest global zoom (default: manifest global.maxZoom)')
    args = ap.parse_args()

    with open(os.path.join(args.out, 'manifest.json'), encoding='utf-8') as fh:
        manifest = json.load(fh)
    max_zoom = args.max_zoom if args.max_zoom is not None else manifest.get('global', {}).get('maxZoom')
    if max_zoom is None:
        print('error: the manifest has no "global" block; run merge_global_pyramid.py first', file=sys.stderr)
        return 1
    areas = merge.area_boxes(manifest)
    index = merge.load_index(args.out)
    counts = {'dem': 0, 'merged': 0}
    total = sum(len(t) for z, t in index.items() if z <= max_zoom)
    done = 0
    for z in sorted(index):
        if z > max_zoom:
            continue
        for (x, y) in sorted(index[z]):
            kind = bake_tile(args.out, z, x, y, areas)
            counts[kind] = counts.get(kind, 0) + 1
            done += 1
        print(f'  z{z} done ({done}/{total})')
    print(f'coast written: {counts["dem"]} from the DEM, {counts["merged"]} merged with OSM')
    return 0


if __name__ == '__main__':
    sys.exit(main())

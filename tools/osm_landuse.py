#!/usr/bin/env python3
"""Fetch OSM natural/landuse polygons and paint them onto the cover class grid.

A separate module from ``bake_planet_cover.py`` because that file is
documented (see its ``_metres_per_degree`` docstring) to depend on rasterio
and numpy only, not shapely. Assembling OSM polygons needs shapely -
``nodes_map``/``ways_map``/``relation_rings`` from ``osm_common.py``, and an
``STRtree`` to find which of many separately-classified polygons owns a given
tile. ``bake_planet_cover.py`` imports this module lazily behind a
``try/except`` (the same shape as ``HAS_RASTERIO`` in ``bake_osm_coast.py``),
so a bake that never passes ``--osm-landuse`` never needs shapely installed.

Modeled on ``bake_osm_coast.py``'s ``overpass_query()``/``_polygons_from_osm``,
reusing ``osm_common.py``'s Overpass client and element helpers rather than
re-implementing the way-id de-dup / relation-ring assembly that already cost
a mis-baked peninsula once (see ``osm_common.ways_map``'s docstring).

Unlike the coastline bake, which folds everything into one land/water union,
every polygon here keeps its own class - this is "which of thousands of
separately-tagged shapes contains this point", not one in/out test. That is
what needs a spatial index (``build_landuse_index``) where the coast bake
gets away without one.
"""

from __future__ import annotations

import sys
from typing import Callable, Dict, List, Optional, Sequence, Tuple

try:
    from shapely.geometry import Polygon, box
    from shapely.strtree import STRtree
except ImportError:
    print('error: shapely is required for --osm-landuse (pip install shapely)', file=sys.stderr)
    raise

try:
    import numpy as np
    from rasterio.features import rasterize
    from rasterio.transform import from_bounds as transform_from_bounds
except ImportError:
    print('error: rasterio and numpy are required (pip install rasterio numpy)', file=sys.stderr)
    raise

from osm_common import (
    Bounds, merge_elements, nodes_map, overpass_fetch, overpass_fetch_cells, relation_rings, ways_map,
)

# Compact TerrainClass ids this module may emit. Must match
# src/script/terrain/tones.ts and tools/bake_planet_cover.py's own copy -
# duplicated rather than imported (the same trade tools/cover_patches.py
# already makes) so this module's shapely dependency loads only when
# --osm-landuse is actually asked for.
#
# Deliberately missing CLS_UNKNOWN, CLS_WATER (the coastline bake already
# owns the land/water split geometrically, and cover_patches.py's CLS_WATER
# is a fixed class that never gets voted over) and CLS_SAND (bake-assigned
# downstream in the mesh bake's shore-adjacency logic, never read from a
# source here).
CLS_TREE = 1
CLS_SHRUB = 2
CLS_GRASS = 3
CLS_CROP = 4
CLS_BUILT = 5
CLS_BARE = 6
CLS_SNOW = 7
CLS_WETLAND = 9

# (key, value, TerrainClass). Split into two Overpass requests below -
# combining every clause into one query risks the same silent-truncation
# failure mode bake_osm_coast.py's overpass_query() found on a real bbox
# (504 elements back instead of 667, no error, no remark): a truncated
# answer doesn't close rings and previously baked a whole peninsula wrong.
# Splitting also caches finer - a change to one group doesn't force the
# other to re-fetch.
_VEGETATION_TAGS: List[Tuple[str, str, int]] = [
    ('natural', 'wood', CLS_TREE),
    ('landuse', 'forest', CLS_TREE),
    ('natural', 'scrub', CLS_SHRUB),
    ('natural', 'heath', CLS_SHRUB),
    ('natural', 'grassland', CLS_GRASS),
    ('landuse', 'meadow', CLS_GRASS),
    ('landuse', 'grass', CLS_GRASS),
    ('landuse', 'village_green', CLS_GRASS),
    ('landuse', 'farmland', CLS_CROP),
    ('landuse', 'orchard', CLS_CROP),
    ('landuse', 'vineyard', CLS_CROP),
    ('landuse', 'allotments', CLS_CROP),
]
_BUILT_TAGS: List[Tuple[str, str, int]] = [
    ('landuse', 'residential', CLS_BUILT),
    ('landuse', 'commercial', CLS_BUILT),
    ('landuse', 'industrial', CLS_BUILT),
    ('landuse', 'retail', CLS_BUILT),
    ('natural', 'bare_rock', CLS_BARE),
    ('natural', 'scree', CLS_BARE),
    ('natural', 'shingle', CLS_BARE),
    ('landuse', 'quarry', CLS_BARE),
    ('natural', 'glacier', CLS_SNOW),
    ('natural', 'wetland', CLS_WETLAND),
]
LANDUSE_TAG_TO_CLASS: List[Tuple[str, str, int]] = _VEGETATION_TAGS + _BUILT_TAGS


def _query_for(tags: Sequence[Tuple[str, str, int]], b: Bounds) -> str:
    clauses: List[str] = []
    for key, value, _cls in tags:
        clauses.append(f'  way["{key}"="{value}"]({b.as_overpass()});')
        clauses.append(f'  relation["{key}"="{value}"]({b.as_overpass()});')
    body = '\n'.join(clauses)
    return f'[out:json][timeout:240];\n(\n{body}\n);\nout body;\n>;\nout skel qt;\n'


def _reject_if_empty(label: str, data: dict) -> None:
    """Raise on a clean, remark-free answer that still has nothing in it.

    overpass_fetch()'s own docstring documents the failure mode this guards:
    overpass.osm.ch has been seen answering a heavy query with HTTP 200, no
    remark, and a silently truncated `elements: []` - indistinguishable from
    "this bbox really has none" by status code or remark alone. Left
    unguarded, that answer is *cached*, and the mirror that produced it is
    marked as having succeeded (`_mirror_succeeded`) rather than penalized -
    so the very next bake of the same bbox reuses the same wrong empty
    answer, and the bad mirror stays first in line to answer the next one.
    Measured live on a Yalta test bbox: the vegetation query truncated to 0
    elements this way, where a bypassed-cache retry against a different
    mirror answered with 93758.

    Unconditional rather than cross-checked against a sibling query (the
    shape bake_osm_airports.py's own reject_if_suspiciously_empty uses,
    where an aerodrome-count reference is already in hand): this module has
    no such reference at fetch time. The cost of being wrong the other way -
    a bbox that genuinely has no vegetation or built tags at all - is that
    `overpass_fetch` spends its full mirror/round retry budget confirming
    that before giving up, not a wrong answer; see the try/except around
    this function's caller for what happens once every attempt is
    exhausted.
    """
    if not data.get('elements'):
        raise RuntimeError(f'{label} came back with zero elements - likely a truncated answer')


LanduseFetchProgress = Callable[[int, int, str, int], None]
"""(group index, group count, group label, bytes received so far)."""


def overpass_landuse_query(
    bbox: Tuple[float, float, float, float], refresh: bool = False,
    on_progress: Optional[LanduseFetchProgress] = None,
) -> dict:
    """Fetch OSM natural/landuse polygons as two grouped Overpass requests.

    `on_progress`, when given, hears every download's byte count as it grows,
    tagged with which of the groups it belongs to.

    `bbox` crosses the module boundary as a plain (west, south, east, north)
    tuple rather than an osm_common.Bounds - bake_planet_cover.py's own
    tile_bounds()/parse_bbox() already return plain tuples everywhere, and
    this keeps its callers from needing to import osm_common just to build
    the argument.

    A group that comes back suspiciously empty after every mirror and retry
    round is dropped with a warning rather than raising - see
    _reject_if_empty's docstring for why an empty answer cannot be told apart
    from a real one at the query level; a genuinely bare bbox (open ocean,
    a desert with no natural= or landuse= tags at all) must still bake.
    """
    b = Bounds(*bbox)
    answers: List[dict] = []
    groups = (('vegetation/agriculture', _VEGETATION_TAGS),
              ('built/bare/snow/wetland', _BUILT_TAGS))
    for index, (label, tags) in enumerate(groups):
        extra: Dict[str, object] = {}
        if on_progress is not None:
            def bytes_seen(received: int, index=index, label=label) -> None:
                on_progress(index, len(groups), label, received)
            extra['on_progress'] = bytes_seen
        try:
            # One request per grid cell, each cached on its own, with the
            # empty-answer guard `_reject_if_empty` describes applied per
            # cell in its one-retry form: a cell of open ocean really is
            # empty, and must not burn the whole retry budget proving it.
            data = overpass_fetch_cells(
                lambda cell, tags=tags: _query_for(tags, cell), b, f'landuse ({label})', refresh,
                **extra,
            )
        except Exception as err:
            print(f'  landuse ({label}) unavailable ({err}) - baking without it', file=sys.stderr)
            continue
        answers.append(data)
    return merge_elements(answers)


def _class_for_tags(tags: dict) -> Optional[int]:
    for key, value, cls in LANDUSE_TAG_TO_CLASS:
        if tags.get(key) == value:
            return cls
    return None


def _polygon_from_way(way: dict, nodes: Dict[int, Tuple[float, float]]) -> Optional[Polygon]:
    coords = [nodes[nid] for nid in way.get('nodes', []) if nid in nodes]
    if len(coords) < 4 or coords[0] != coords[-1]:
        return None
    try:
        poly = Polygon(coords)
    except Exception:
        return None
    if not poly.is_valid:
        poly = poly.buffer(0)
    return poly if isinstance(poly, Polygon) and not poly.is_empty else None


def assemble_landuse_polygons(
    data: dict, progress: Optional[Callable[[float, str], None]] = None,
) -> Tuple[List[Polygon], List[int]]:
    """Parallel (polygons, TerrainClass ids), one entry per OSM shape.

    `progress(fraction, detail)`, when given, is called as the ways and then
    the relations are walked.

    Every polygon keeps its own class rather than folding into one union,
    unlike bake_osm_coast.py's land/water assembly - that is the whole reason
    a caller needs build_landuse_index/stamp_landuse_classes rather than a
    single contains() test.

    Known gap: a way that is both individually tagged and a member of a
    tagged multipolygon relation can be counted twice. bake_osm_coast.py
    does not fully solve the equivalent case for water either; left as a
    known limitation rather than solved here.
    """
    elements = data.get('elements', [])
    nodes = nodes_map(elements)
    ways = ways_map(elements)
    relations = [el for el in elements if el.get('type') == 'relation']

    polys: List[Polygon] = []
    classes: List[int] = []

    # Ways are the bulk of it; relations are few but each carries many rings.
    way_total = max(1, len(ways))
    way_step = max(1, way_total // 50)
    for i, way in enumerate(ways.values()):
        if progress is not None and (i % way_step == 0 or i + 1 == way_total):
            progress(0.8 * (i + 1) / way_total, f'ways {i + 1}/{way_total}')
        cls = _class_for_tags(way.get('tags') or {})
        if cls is None:
            continue
        poly = _polygon_from_way(way, nodes)
        if poly is not None:
            polys.append(poly)
            classes.append(cls)

    rel_total = max(1, len(relations))
    for i, rel in enumerate(relations):
        if progress is not None:
            progress(0.8 + 0.2 * (i + 1) / rel_total, f'relations {i + 1}/{len(relations)}')
        cls = _class_for_tags(rel.get('tags') or {})
        if cls is None:
            continue
        for ring in relation_rings(rel, ways, nodes):
            if len(ring) < 4:
                continue
            try:
                poly = Polygon(ring)
            except Exception:
                continue
            if not poly.is_valid:
                poly = poly.buffer(0)
            if isinstance(poly, Polygon) and not poly.is_empty:
                polys.append(poly)
                classes.append(cls)

    return polys, classes


def build_landuse_index(polys: Sequence[Polygon]) -> STRtree:
    """Once per bake, over every fetched polygon."""
    return STRtree(list(polys))


def stamp_landuse_classes(
    classes: np.ndarray,
    bounds: Tuple[float, float, float, float],
    size: int,
    tree: STRtree,
    polys: Sequence[Polygon],
    poly_classes: Sequence[int],
) -> int:
    """Paint OSM landuse polygons over the class grid. Returns nodes changed.

    No clip step first (unlike bake_osm_coast.py's clip_vector_polys): the
    output here is a per-node raster class, not vector rings, so there is no
    topology for a tile-edge GeometryCollection to break -
    rasterio.features.rasterize() tests each candidate against the tile's own
    transform/out_shape directly, burning only the pixels that fall inside.

    Candidates are burned largest-first so a smaller, more specific shape (a
    farmyard mapped inside a farmland relation) wins the pixels they share -
    rasterize()'s default MergeAlg.replace overwrites with each later shape
    in the list.
    """
    if len(polys) == 0:
        return 0
    west, south, east, north = bounds
    idxs = tree.query(box(west, south, east, north))
    if len(idxs) == 0:
        return 0
    candidates = sorted(
        ((polys[i], poly_classes[i]) for i in idxs),
        key=lambda pc: pc[0].area, reverse=True,
    )
    before = classes.copy()
    transform = transform_from_bounds(west, south, east, north, size, size)
    rasterize(candidates, out=classes, transform=transform, all_touched=False)
    return int(np.count_nonzero(classes != before))

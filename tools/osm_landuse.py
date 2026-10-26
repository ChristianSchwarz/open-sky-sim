#!/usr/bin/env python3
"""Fetch OSM natural/landuse polygons and paint them onto the cover class grid.

A separate module from ``bake_planet_cover.py`` because that file is
documented (see its ``_metres_per_degree`` docstring) to depend on rasterio
and numpy only, not shapely. Assembling OSM polygons needs shapely -
``nodes_map``/``ways_map``/``relation_polygons`` from ``osm_common.py``, and an
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
    Bounds, OVERPASS_OUT, merge_elements, nodes_map, overpass_fetch, overpass_fetch_cells,
    overpass_fetch_groups, relation_polygons, ways_map,
)

# Compact TerrainClass ids this module may emit. Must match
# src/script/terrain/tones.ts and tools/bake_planet_cover.py's own copy -
# duplicated rather than imported (the same trade tools/cover_patches.py
# already makes) so this module's shapely dependency loads only when
# --osm-landuse is actually asked for.
#
# Deliberately missing CLS_UNKNOWN and CLS_WATER: the coastline bake already
# owns the land/water split geometrically, and cover_patches.py's CLS_WATER
# is a fixed class that never gets voted over. CLS_SAND is shared with the
# mesh bake's shore-adjacency logic, which promotes bare facets near the coast
# to sand; a mapped beach, dune or desert says the same thing directly.
CLS_TREE = 1
CLS_SHRUB = 2
CLS_GRASS = 3
CLS_CROP = 4
CLS_BUILT = 5
CLS_BARE = 6
CLS_SNOW = 7
CLS_WETLAND = 9
CLS_MANGROVE = 10
CLS_MOSS = 11
CLS_SAND = 12
CLS_HEATH = 14

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
    ('natural', 'heath', CLS_HEATH),
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
# The rest of natural=*: the open biomes - coast and desert sand, rock,
# upland tundra, moorland - that the two groups above never asked for. A group
# of its own so adding it left the other two groups' cached answers valid.
# natural=water/bay/strait stay out for the same reason CLS_WATER does.
_NATURAL_TAGS: List[Tuple[str, str, int]] = [
    ('natural', 'sand', CLS_SAND),
    ('natural', 'beach', CLS_SAND),
    ('natural', 'dune', CLS_SAND),
    ('natural', 'desert', CLS_SAND),
    ('natural', 'rock', CLS_BARE),
    ('natural', 'stone', CLS_BARE),
    ('natural', 'mud', CLS_BARE),
    ('natural', 'fell', CLS_MOSS),
    ('natural', 'tundra', CLS_MOSS),
    ('natural', 'moor', CLS_HEATH),
    ('natural', 'shrubbery', CLS_SHRUB),
]
LANDUSE_TAG_TO_CLASS: List[Tuple[str, str, int]] = _VEGETATION_TAGS + _BUILT_TAGS + _NATURAL_TAGS

# Sub-tags that refine what a matched key=value means on the ground:
# (key, value, refining key, refining value, TerrainClass). The first match
# wins over the plain table's class; no extra fetch needed, as Overpass
# returns every tag of an element it matched.
_REFINEMENTS: List[Tuple[str, str, str, str, int]] = [
    ('natural', 'wetland', 'wetland', 'mangrove', CLS_MANGROVE),
]

# What a natural=beach is made of, by its surface=* tag. Sand, and a beach
# with no surface tag, stay CLS_SAND. A list (`pebblestone;sand`) is taken by
# its first value, the one the mapper put first.
_BEACH_SURFACE_TO_CLASS: Dict[str, int] = {
    'sand': CLS_SAND,
    'fine_sand': CLS_SAND,
    'shingle': CLS_BARE,
    'pebbles': CLS_BARE,
    'pebblestone': CLS_BARE,
    'gravel': CLS_BARE,
    'fine_gravel': CLS_BARE,
    'rock': CLS_BARE,
    'rocky': CLS_BARE,
    'stone': CLS_BARE,
    'stones': CLS_BARE,
    'boulders': CLS_BARE,
    'ground': CLS_BARE,
    'dirt': CLS_BARE,
    'earth': CLS_BARE,
    'mud': CLS_BARE,
    'unpaved': CLS_BARE,
    'compacted': CLS_BARE,
    'grass': CLS_GRASS,
    # A paved city beach is a promenade, and reads as one from the air.
    'concrete': CLS_BUILT,
    'asphalt': CLS_BUILT,
    'paved': CLS_BUILT,
    'paving_stones': CLS_BUILT,
    'concrete:plates': CLS_BUILT,
    'wood': CLS_BUILT,
}


def _query_for(tags: Sequence[Tuple[str, str, int]], b: Bounds) -> str:
    clauses: List[str] = []
    for key, value, _cls in tags:
        clauses.append(f'  way["{key}"="{value}"]({b.as_overpass()});')
        clauses.append(f'  relation["{key}"="{value}"]({b.as_overpass()});')
    body = '\n'.join(clauses)
    return f'[out:json][timeout:240];\n(\n{body}\n);\n{OVERPASS_OUT}\n'


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
    skip_cell: Optional[Callable[[Bounds], bool]] = None,
) -> dict:
    """Fetch OSM natural/landuse polygons as three grouped Overpass requests.

    `on_progress`, when given, hears every download's byte count as it grows,
    tagged with which of the groups it belongs to. `skip_cell`, when given,
    names the grid cells not worth asking about at all - the ones the DEM
    says are open sea (see osm_common.sea_cell_skipper).

    Every group goes out in one batch, one request per grid cell, so the
    mirror slots stay busy across them.

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
    groups = (('vegetation/agriculture', _VEGETATION_TAGS),
              ('built/bare/snow/wetland', _BUILT_TAGS),
              ('natural', _NATURAL_TAGS))
    extra: Dict[str, object] = {}
    if on_progress is not None:
        def bytes_seen(index: int, received: int) -> None:
            on_progress(index, len(groups), groups[index][0], received)
        extra['on_progress'] = bytes_seen
    # One request per grid cell, each cached on its own, with the
    # empty-answer guard `_reject_if_empty` describes applied per cell in
    # its one-retry form: a cell of open ocean really is empty, and must
    # not burn the whole retry budget proving it. A group that fails after
    # every retry is dropped - baked without - rather than failing the bake.
    answers = overpass_fetch_groups(
        [(lambda cell, tags=tags: _query_for(tags, cell), f'landuse ({label})', skip_cell)
         for label, tags in groups],
        b, refresh, tolerate=[True] * len(groups), **extra)
    for (label, _tags), answer in zip(groups, answers):
        if answer is None:
            print(f'  landuse ({label}) - baking without it', file=sys.stderr)
    return merge_elements([a for a in answers if a is not None])


def landuse_tag_predicate(tags: dict) -> bool:
    """The tag test `_query_for` encodes as QL clauses, for the local-PBF path."""
    return _class_for_tags(tags) is not None


def _class_for_tags(tags: dict) -> Optional[int]:
    for key, value, sub_key, sub_value, cls in _REFINEMENTS:
        if tags.get(key) == value and tags.get(sub_key) == sub_value:
            return cls
    if tags.get('natural') == 'beach':
        surface = (tags.get('surface') or '').split(';')[0].strip().lower()
        return _BEACH_SURFACE_TO_CLASS.get(surface, CLS_SAND)
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
        # Holes included: a forest relation's `inner` rings are the clearings
        # and villages inside it, and stamping them as forest was wrong.
        for poly in relation_polygons(rel, ways, nodes):
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

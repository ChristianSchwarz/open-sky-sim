#!/usr/bin/env python3
"""Combine the coastline land polygon with OSM landuse polygons into one
non-overlapping, tagged partition of a tile.

`bake_osm_coast.py`'s own `.lvr` layer already carries precise land/water
ring geometry; `osm_landuse.py` carries real landuse polygons but only ever
burns them onto a raster (`stamp_landuse_classes`), discarding the vector
overlap-resolution it does along the way. This module does the equivalent
resolution in vector space, scoped to one tile at a time, so the result can
be persisted as rings too (the LVR4 layer in `tools/bake/lvr.ts`) and the
mesh bake can cut real geometry along a landuse edge the same way it already
does along the coast.

Scoped per tile deliberately, not run once globally: a bbox's landuse fetch
routinely assembles tens of thousands of polygons, and an iterative
priority-ordered overlay across all of them at once is a known bad pattern
for GEOS (the cost of each step grows with the accumulated complexity of
everything already claimed). `osm_landuse.py`'s own `stamp_landuse_classes`
already avoids this the same way, with an `STRtree` query scoped to one
tile's bbox - this module does the same query, just resolves the winner
geometrically instead of burning it onto a raster.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence

import numpy as np
from shapely import make_valid, unary_union
from shapely.geometry import MultiPolygon, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

# A fixed-precision grid for every overlay op below (intersection/difference/
# union), in degrees - about 0.1 mm at the equator, far finer than anything
# that could be a real boundary but coarse enough to collapse the
# near-duplicate points and hairline slivers real OSM geometry routinely
# has. Passed as `grid_size` to GEOS's fixed-precision overlay rather than
# left at the floating-point default: a real Leipzig bake hit
# `TopologyException: side location conflict... This can occur if the input
# geometry is invalid` on 3 of 299 tiles with the default (grid_size=0)
# overlay, even after every input was already repaired with make_valid() -
# floating-point overlay can still lose the numerical sweep-line ordering it
# needs on two edges that are valid but pathologically close together, which
# a fixed precision grid removes by construction.
OVERLAY_GRID_SIZE = 1e-9

# Land can never lose area to a landuse tag - see the module docstring in
# osm_landuse.py: "the coastline bake already owns the land/water split
# geometrically". A wetland or farmland polygon that strays over the OSM
# water polygon (both occur in real data - a marsh commonly overlaps
# natural=water at its edge) is clipped to the already-resolved land shape
# before it can win any pixels, exactly as `stamp_landuse_classes` does by
# construction (LANDUSE_TAG_TO_CLASS has no water-producing tag at all).

# A generous ceiling on how many pieces one tile's partition may carry.
# Real per-tile landuse density in this codebase's own areas runs to the
# tens; this is headroom, not a target. Exceeding it drops the
# smallest/lowest-priority claimed pieces first - a bake-time data-hygiene
# decision this module can make selectively, which the mesh bake's own
# triangle-budget coarsening cannot (it can only coarsen everything at once).
MAX_REGIONS_PER_TILE = 512


@dataclass
class Region:
    """One non-overlapping piece of a tile's combined land/landuse partition."""

    geom: Polygon
    is_land: bool
    landuse_class: Optional[int]  # None: bare land (no OSM tag), or water


def _polys_of(geom: BaseGeometry) -> List[Polygon]:
    """A geometry as a flat list of its constituent Polygons.

    The same shape `clip_vector_polys` already uses for a tile-box
    intersection: a clip against a box can come back as a Polygon, a
    MultiPolygon, or (when the input also touches the box along an edge or
    at a corner) a GeometryCollection mixing polygons with a stray line or
    point - which `.geoms` iterates over just as happily, but only the
    Polygon members are useful here.
    """
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return [g for g in geom.geoms if not g.is_empty]
    return [g for g in getattr(geom, 'geoms', []) if isinstance(g, Polygon) and not g.is_empty]


def _valid(geom: BaseGeometry) -> BaseGeometry:
    """Repair a geometry, and coerce it strictly to Polygon/MultiPolygon,
    before it feeds the next overlay op.

    GEOS's overlay engine (difference/intersection/union) can produce a
    technically invalid result even from two valid inputs - rare on any one
    call, but assemble_tile_regions chains hundreds of overlay operations per
    tile in its priority loop, each one's output feeding the next as an
    input, so a numerically degenerate result from one step becomes an
    invalid input to the next. Left unrepaired that does not just produce a
    wrong-but-valid answer - GEOS's own overlay code can throw outright
    ("AssertionFailedException: Unable to determine overlay result geometry
    dimension"), which is what a real Leipzig bake hit once this feature had
    enough real landuse density to exercise a long chain.

    A plain `is_valid` check is not enough to catch this: a `buffer(0)` (or
    `make_valid()`) repair on a genuinely degenerate input can itself come
    back as a `GeometryCollection` mixing a real polygon with a stray line or
    point - a shape shapely considers "valid" (validity is a simple-features
    notion, and a collection can't fail it the way a self-intersecting ring
    does), but one GEOS's overlay code can still choke on once it is fed back
    in as one side of the *next* difference() in the chain. So this always
    reduces to plain polygon area, dropping any lower-dimensional debris,
    rather than trusting `is_valid` alone. `make_valid()` (GEOS's own repair)
    is used ahead of the older `buffer(0)` trick - reproduced on the actual
    Leipzig failure, where `buffer(0)` alone was not sufficient to stop the
    assertion from recurring one step later in the same chain.
    """
    if geom.is_empty:
        return geom
    repaired = geom if geom.is_valid else make_valid(geom)
    if isinstance(repaired, (Polygon, MultiPolygon)):
        return repaired
    polys = _polys_of(repaired)
    if not polys:
        return Polygon()
    return polys[0] if len(polys) == 1 else MultiPolygon(polys)


def assemble_tile_regions(
    tile_box: Polygon,
    halo_box: Polygon,
    land: 'MultiPolygon | Polygon',
    landuse_tree: Optional[STRtree],
    landuse_polys: Sequence[Polygon],
    landuse_classes: Sequence[int],
) -> List[Region]:
    """The combined land/water + landuse partition for one tile, clipped tight to it.

    `land` should already be at its final, simplified boundary (the same
    object `.lvr`'s own polygon layer clips from) - this function does not
    simplify anything itself, so two regions sharing an edge always agree on
    it exactly. See tools/bake/regions.ts's own docstring for why that
    matters: independently simplifying two adjacent pieces is exactly the
    failure mode that made inland water rings unsimplified in the first place.

    `halo_box` only widens the STRtree query, guarding against a candidate
    whose true geometry reaches the tile but whose envelope is a hair
    outside it after floating-point clipping; every geometric operation
    below still clips tight to `tile_box`.
    """
    # `land` can be an invalid MultiPolygon even when every one of its own
    # Polygon parts individually reports valid - a real Leipzig tile hit
    # exactly this, 11 parts each individually is_valid=True but the
    # MultiPolygon as a whole False, because two neighbouring pieces (clipped
    # and simplified independently by simplified_clipped_land, one piece per
    # connected component) ended up touching or barely overlapping. That is
    # a MultiPolygon-level defect - the OGC rule that a MultiPolygon's own
    # elements may not intersect each other - which no amount of repairing
    # intermediate *results* further down this function can fix, since it
    # was already broken on the very first operation performed on it.
    local_land = _valid(_valid(land).intersection(tile_box, grid_size=OVERLAY_GRID_SIZE))
    if local_land.is_empty:
        return [Region(tile_box, False, None)]

    candidates: List[tuple] = []
    if landuse_tree is not None and len(landuse_polys) > 0:
        idxs = landuse_tree.query(halo_box)
        # The exact reverse of the largest-first order this used to walk,
        # ties included: a shape mapped twice with two tags has two
        # equal-area candidates, and which of them wins must not depend on
        # sort direction.
        candidates = sorted(
            ((landuse_polys[i], landuse_classes[i]) for i in idxs),
            key=lambda pc: pc[0].area, reverse=True,
        )[::-1]

    # Priority-ordered vector overlay, smallest first: the smaller polygon
    # wins wherever two overlap (a park inside a residential area is the
    # park), the exact vector equivalent of stamp_landuse_classes's
    # largest-first raster paint order, where the smallest is painted last.
    #
    # Walking smallest-first means each candidate only has to give up the
    # area already claimed, rather than every earlier claim having to be
    # re-cut around each new one. That earlier shape was quadratic in the
    # candidate count - every candidate re-differenced every claimed piece,
    # and each result went back through make_valid - and it is what made a
    # z11 level take four times longer than the z12 level above it: a
    # coarser tile sees four times the candidates, so sixteen times the
    # work. Measured on Madeira: 26 z11 tiles in 480 s.
    #
    # Most landuse polygons never touch each other at all, so the subtract
    # is also limited to the claims whose bounding boxes overlap the piece,
    # found with a vectorised bounds test instead of a GEOS call each.
    claimed: List[tuple] = []
    claimed_bounds = np.zeros((0, 4), dtype=np.float64)
    for poly, cls in candidates:
        piece = _valid(poly)
        piece = _valid(piece.intersection(local_land, grid_size=OVERLAY_GRID_SIZE))
        piece = _valid(piece.intersection(tile_box, grid_size=OVERLAY_GRID_SIZE))
        if piece.is_empty:
            continue
        if claimed:
            x0, y0, x1, y1 = piece.bounds
            hit = np.flatnonzero(
                (claimed_bounds[:, 0] <= x1) & (claimed_bounds[:, 2] >= x0)
                & (claimed_bounds[:, 1] <= y1) & (claimed_bounds[:, 3] >= y0))
            if len(hit):
                taken = unary_union([claimed[i][0] for i in hit], grid_size=OVERLAY_GRID_SIZE)
                piece = _valid(piece.difference(_valid(taken), grid_size=OVERLAY_GRID_SIZE))
                if piece.is_empty:
                    continue
        claimed.append((piece, cls))
        claimed_bounds = np.vstack([claimed_bounds, np.array(piece.bounds, dtype=np.float64)])

    return _finish_regions(tile_box, local_land, claimed)


def derive_tile_regions(
    tile_box: Polygon,
    land: 'MultiPolygon | Polygon',
    child_claims: Sequence[tuple],
    tolerance: float,
) -> List[Region]:
    """A coarser tile's partition, built from its four children's claimed pieces.

    `child_claims` is every (class, geometry) landuse piece the children one
    level finer resolved, in the children's own coordinates. Running the
    overlay again at this level would query four times the candidates the
    children did and resolve the same boundaries a second time; the z12
    partition is already exact, so a z11 tile is that partition unioned per
    class across the child seams, simplified with this level's tolerance,
    and clipped to this level's own simplified land - which is what makes
    its outer edge agree exactly with the plain coastline layer, the same
    way `assemble_tile_regions` clips to `local_land`.

    Simplifying each class on its own can leave two classes overlapping by
    a hair along a shared edge. The pieces are re-resolved smallest-first
    over the handful of classes a tile carries, so the result stays a
    partition, and anything under a grid cell of that level is dropped.
    """
    local_land = _valid(_valid(land).intersection(tile_box, grid_size=OVERLAY_GRID_SIZE))
    if local_land.is_empty:
        return [Region(tile_box, False, None)]

    by_class: dict = {}
    for cls, geom in child_claims:
        if geom is not None and not geom.is_empty:
            by_class.setdefault(cls, []).append(geom)
    min_area = tolerance * tolerance
    merged: List[tuple] = []
    for cls, parts in by_class.items():
        geom = _valid(unary_union(parts, grid_size=OVERLAY_GRID_SIZE))
        geom = _valid(geom.simplify(tolerance, preserve_topology=True))
        geom = _valid(geom.intersection(local_land, grid_size=OVERLAY_GRID_SIZE))
        parts_kept = [p for p in _polys_of(geom) if p.area >= min_area]
        if parts_kept:
            merged.append((parts_kept[0] if len(parts_kept) == 1 else MultiPolygon(parts_kept), cls))
    merged.sort(key=lambda gc: gc[0].area)

    claimed: List[tuple] = []
    covered: Optional[BaseGeometry] = None
    for geom, cls in merged:
        if covered is not None:
            geom = _valid(geom.difference(covered, grid_size=OVERLAY_GRID_SIZE))
            if geom.is_empty:
                continue
        claimed.append((geom, cls))
        covered = geom if covered is None else _valid(unary_union([covered, geom], grid_size=OVERLAY_GRID_SIZE))
    return _finish_regions(tile_box, local_land, claimed)


def _finish_regions(tile_box: Polygon, local_land: BaseGeometry, claimed: List[tuple]) -> List[Region]:
    """Bare land and water around the claimed pieces, then the per-tile cap.

    `claimed` is smallest-first, as both builders above leave it.
    """
    # Every step below is validated separately, not just the end of the
    # chain: the real Leipzig failure this guards was exactly a raw,
    # unrepaired *intermediate* result (a difference() whose output came back
    # mixed-dimension) fed straight into the next operation, which threw
    # before _valid() on the final expression ever got a chance to run.
    covered = None
    if claimed:
        covered = _valid(unary_union([g for g, _ in claimed if not g.is_empty], grid_size=OVERLAY_GRID_SIZE))
    bare_land = local_land
    if covered is not None:
        bare_land = _valid(local_land.difference(covered, grid_size=OVERLAY_GRID_SIZE))
        bare_land = _valid(bare_land.intersection(tile_box, grid_size=OVERLAY_GRID_SIZE))
    water = _valid(tile_box.difference(local_land, grid_size=OVERLAY_GRID_SIZE))

    regions: List[Region] = []
    # Emitted largest-first, as before: tools/bake/regions.ts breaks a
    # shared-edge tie in favour of the later region, and that should stay
    # the smaller one.
    for geom, cls in reversed(claimed):
        for part in _polys_of(geom.intersection(tile_box, grid_size=OVERLAY_GRID_SIZE)):
            regions.append(Region(part, True, cls))
    for part in _polys_of(bare_land):
        regions.append(Region(part, True, None))
    for part in _polys_of(water):
        regions.append(Region(part, False, None))

    if len(regions) > MAX_REGIONS_PER_TILE:
        # Keep every bare-land/water piece (the base layer, always kept) and
        # drop the smallest claimed landuse pieces first - the ones the
        # overlay itself already ranked least important.
        base = [r for r in regions if r.landuse_class is None]
        claimed_regions = sorted(
            (r for r in regions if r.landuse_class is not None),
            key=lambda r: r.geom.area, reverse=True,
        )
        keep = max(0, MAX_REGIONS_PER_TILE - len(base))
        regions = base + claimed_regions[:keep]

    return regions

"""Enlarge landcover patches so a facet paints a region, not a pixel.

ESA WorldCover is a 10 m product and it is right at 10 m - a single shed
really is built-up. At the scale a terrain facet paints, that truth is noise:
on a baked z12 tile the class raster holds 1550 separate regions, 60% of them
four nodes or smaller, and the mesh comes out as confetti.

This applies a local majority filter over the *land* classes, twice, with the
window sized from a ground distance rather than a node count so it means the
same thing at every zoom.

Two properties are the whole reason it is a majority filter rather than a
merge of small connected regions:

**It is local.** Filtering a tile that was read with a halo of
``halo_nodes()`` gives bit-identical results to filtering the entire
archipelago at once, so adjacent tiles cannot disagree along their shared
edge. Region merging is global by nature: two tiles would have to reach the
same verdict about a region that straddles their border, and where they did
not, the disagreement would show as a seam.

**Water never moves.** Sea and nodata are fixed points - never reassigned,
and never allowed to vote. Along any coast the sea is the local majority by a
wide margin, so a filter that let it vote would swallow headlands and coastal
villages whole. Holding it fixed also leaves the coastline exactly as the
mesh bake's "don't average the sea into a land facet" rule expects to find it.

Pure numpy on purpose: no rasterio, so it imports and tests anywhere.
"""

from __future__ import annotations

from typing import Iterable

import numpy as np

# Compact TerrainClass ids that take no part in the vote. Must match
# src/script/terrain/tones.ts.
CLS_UNKNOWN = 0
CLS_WATER = 8

FIXED_CLASSES = (CLS_UNKNOWN, CLS_WATER)

# Two reaches the target and a third buys nothing. Measured on tile
# 12/3744/1411 with r = 7: raw 1550 regions / 33 m median, one pass 95 / 152 m,
# two passes 40 / 269 m, three passes 41 / 276 m.
DEFAULT_PASSES = 2


def radius_nodes(patch_m: float, metres_per_node: float, passes: int = DEFAULT_PASSES) -> int:
    """Half-window, in nodes, for a patch that should read as `patch_m` across.

    Returns 0 when a single node already spans more ground than the target -
    true from about z9 up, where facets are kilometres wide and there is
    nothing left to smooth.
    """
    if patch_m <= 0 or metres_per_node <= 0 or passes < 1:
        return 0
    return int(round(patch_m / (2.0 * metres_per_node)))


def halo_nodes(patch_m: float, metres_per_node: float, passes: int = DEFAULT_PASSES) -> int:
    """Nodes of context a caller must read beyond a tile for exact results.

    Each pass reads `r` nodes either side, so `passes * r` is the distance an
    input node can influence. Read that much extra, filter, crop, and the
    interior matches what filtering the whole raster would have produced.
    """
    return max(0, passes) * radius_nodes(patch_m, metres_per_node, passes)


def _box_sums(mask: np.ndarray, r: int) -> np.ndarray:
    """Count of set nodes in each (2r+1)^2 window, clamped at the borders.

    Via a summed-area table, so this costs one pass over the array whatever
    the window size - the alternative is O(nodes * window^2), and the window
    here is 15 nodes across.
    """
    height, width = mask.shape
    table = np.zeros((height + 1, width + 1), dtype=np.int32)
    table[1:, 1:] = mask.astype(np.int32).cumsum(0).cumsum(1)
    y0 = np.clip(np.arange(height) - r, 0, height)
    y1 = np.clip(np.arange(height) + r + 1, 0, height)
    x0 = np.clip(np.arange(width) - r, 0, width)
    x1 = np.clip(np.arange(width) + r + 1, 0, width)
    return (table[np.ix_(y1, x1)] - table[np.ix_(y0, x1)]
            - table[np.ix_(y1, x0)] + table[np.ix_(y0, x0)])


def majority_pass(
    classes: np.ndarray, r: int, fixed: Iterable[int] = FIXED_CLASSES,
) -> np.ndarray:
    """One local-majority pass over the land classes.

    A node takes the commonest land class in its window. Nodes holding a fixed
    class keep it, fixed classes cast no votes, and a node whose window holds
    no land at all keeps what it had rather than being handed an arbitrary
    winner.

    Ties go to the lowest class id, which is arbitrary but has to be stable:
    the caller relies on this being a pure function of its input.
    """
    if r < 1:
        return classes
    fixed = tuple(fixed)
    held = np.isin(classes, fixed)

    votes = None
    winner = None
    # Ascending, so a strict `>` leaves ties with the lowest id.
    for value in np.unique(classes):
        if value in fixed:
            continue
        count = _box_sums(classes == value, r)
        if votes is None:
            votes = count
            winner = np.full(classes.shape, value, dtype=classes.dtype)
        else:
            better = count > votes
            votes = np.where(better, count, votes)
            winner = np.where(better, value, winner)

    if votes is None:
        return classes
    return np.where(held | (votes == 0), classes, winner).astype(classes.dtype)


def enlarge_patches(
    classes: np.ndarray,
    patch_m: float,
    metres_per_node: float,
    passes: int = DEFAULT_PASSES,
    fixed: Iterable[int] = FIXED_CLASSES,
) -> np.ndarray:
    """Merge landcover speckle into patches that read as `patch_m` across.

    Returns the input unchanged when the tile is already coarser than the
    target. The caller is responsible for having read `halo_nodes()` of
    context; without it the outermost nodes differ from what a wider view
    would have produced, and adjacent tiles show a seam.
    """
    r = radius_nodes(patch_m, metres_per_node, passes)
    if r < 1:
        return classes
    out = classes
    for _ in range(passes):
        out = majority_pass(out, r, fixed)
    return out

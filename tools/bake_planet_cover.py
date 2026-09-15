#!/usr/bin/env python3
"""Bake observed ground cover onto the planet quadtree grid.

Reads an existing ``assets/planet`` tree - the one ``bake_planet_dem.py``
wrote - and, for every ``.pdm`` height tile, resamples the landcover and
imagery rasters onto that tile's own ``size * size`` geographic grid, writing
a matching ``.plc``::

    {z}/{x}/{y}.plc     zlib-compressed PLC1: one class + one sRGB triple
                        per grid node

``tools/bake_planet_mesh.ts`` then reduces those per-node values to one class
and one colour per *facet*, and bakes them into the mesh. This step exists so
that reduction happens against the same grid the heights use, instead of every
mesh bake reprojecting a global raster.

Three rules live here rather than downstream:

* WorldCover's sparse 10..100 codes are compacted to the dense 0..15
  ``TerrainClass`` range the mesh format carries. The map is the one in
  ``src/script/terrain/tones.ts`` and the two must agree.
* Landcover speckle is merged into patches that read at a stated ground
  distance (``--patch-m``); see ``tools/cover_patches.py`` for why that is a
  majority filter and not a region merge. Tiles are read with a halo so the
  result is identical to filtering the whole coverage at once and no seam can
  appear along a tile border.
* Where imagery is missing - no scene, cloud, or no imagery at all - the node
  takes a plausible ground colour for its class instead (``CLASS_COLORS``, not
  ESA's map legend). That keeps every tile fully populated, so the mesh bake
  never has to know which sources were around, and the imagery-driven modes
  degrade to a flat-but-plausible look rather than to grey.

Usage::

    python tools/bake_planet_cover.py
    python tools/bake_planet_cover.py --landcover data/cover/landcover.tif
    python tools/bake_planet_cover.py --max-zoom 10 --only 12/3745/1410
    python tools/bake_planet_cover.py --patch-m 150

With no ``--landcover`` / ``--imagery``, ``data/cover/sources.json`` is used
if ``tools/fetch_cover_sources.py`` has been run.

Requires ``rasterio`` and ``numpy``::

    pip install rasterio numpy
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing as mp
import os
import struct
import sys
import time
import warnings
import zlib
from typing import TYPE_CHECKING, Dict, List, Optional, Sequence, Tuple

import numpy as np

from cover_patches import FIXED_CLASSES, _box_sums, enlarge_patches, halo_nodes

warnings.filterwarnings('ignore', category=DeprecationWarning, module='rasterio')

try:
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import from_bounds as transform_from_bounds
    from rasterio.warp import reproject
except ImportError:  # pragma: no cover - dependency hint
    print('error: rasterio is required (pip install rasterio numpy)', file=sys.stderr)
    raise

if TYPE_CHECKING:
    from shapely.geometry import Polygon
    from shapely.strtree import STRtree

# Optional: only needed for --osm-landuse. This file otherwise depends on
# rasterio/numpy alone (see _metres_per_degree's docstring below), so the
# import is guarded rather than unconditional - a bake that never passes
# --osm-landuse never needs shapely installed. Same shape as HAS_RASTERIO in
# bake_osm_coast.py.
try:
    from osm_landuse import (
        assemble_landuse_polygons, build_landuse_index,
        overpass_landuse_query, stamp_landuse_classes,
    )
    HAS_OSM_LANDUSE = True
except ImportError:
    HAS_OSM_LANDUSE = False

PLC_MAGIC = b'PLC1'
PLC_VERSION = 1
PLC_HEADER_BYTES = 16
PLC_FLAG_REAL_IMAGERY = 1 << 0

DEFAULT_SRC = 'assets/planet'
DEFAULT_SOURCES = 'data/cover/sources.json'

# Window radius, in child nodes, majority_decimate votes over around each
# decimated position when building an ancestor tile - "itself plus immediate
# neighbours", not a wider smooth. A window this small still turns a single
# noisy outlier node into the real local majority without eating into a
# genuinely small class region the way a wider one could.
ANCESTOR_VOTE_RADIUS = 1

# Every tile reads its own window of the same landcover/imagery rasters and
# writes its own .plc - independent of every other tile, so this is the same
# shape of embarrassingly-parallel work `bake_planet_dem.py` and
# `bake_osm_coast.py` already split across worker processes. Threads would not
# do it: the per-node numpy work (LUT indexing, the patch filter, colour
# compositing) holds the GIL, so only separate processes actually overlap.
DEFAULT_JOBS = max(1, (os.cpu_count() or 1) - 1)

# Ground distance a landcover patch should read as. Measured on tile
# 12/3744/1411, this takes the raster from 1550 regions with a 33 m median to
# 40 regions with a 269 m median, and drops the share of tile area sitting in
# sub-250 m regions from 23% to 1%.
DEFAULT_PATCH_M = 250.0

# Compact TerrainClass ids. Must match src/script/terrain/tones.ts.
CLS_UNKNOWN = 0
CLS_TREE = 1
CLS_SHRUB = 2
CLS_GRASS = 3
CLS_CROP = 4
CLS_BUILT = 5
CLS_BARE = 6
CLS_SNOW = 7
CLS_WATER = 8
CLS_WETLAND = 9
CLS_MANGROVE = 10
CLS_MOSS = 11
CLS_SAND = 12   # bake-assigned downstream, never read from the raster

WORLDCOVER_TO_CLASS: Dict[int, int] = {
    10: CLS_TREE,
    20: CLS_SHRUB,
    30: CLS_GRASS,
    40: CLS_CROP,
    50: CLS_BUILT,
    60: CLS_BARE,
    70: CLS_SNOW,
    80: CLS_WATER,
    90: CLS_WETLAND,
    95: CLS_MANGROVE,
    100: CLS_MOSS,
}

# What each cover actually looks like from the air, used wherever there is no
# imagery to sample.
#
# Deliberately NOT ESA's own map legend. Those colours - scarlet for built-up,
# lemon for grassland, magenta for cropland - are chosen to be told apart on a
# map, and they are ruinous here twice over: they are what the imagery-driven
# modes fall back to, and they feed the bake's swatch table, which then hands
# real ground the nearest of them.
#
# These are eyeballed for the Canaries: volcanic, arid, sparsely green.
CLASS_COLORS: Dict[int, Tuple[int, int, int]] = {
    CLS_UNKNOWN: (0x6B, 0x6A, 0x5E),
    CLS_TREE: (0x2E, 0x4A, 0x2A),
    CLS_SHRUB: (0x6B, 0x6A, 0x45),
    CLS_GRASS: (0x7B, 0x7D, 0x4E),
    CLS_CROP: (0x6D, 0x7A, 0x3C),
    CLS_BUILT: (0x8E, 0x8A, 0x84),
    CLS_BARE: (0x8A, 0x72, 0x56),
    CLS_SNOW: (0xE8, 0xEC, 0xF0),
    CLS_WATER: (0x1E, 0x3A, 0x52),
    CLS_WETLAND: (0x4A, 0x63, 0x50),
    CLS_MANGROVE: (0x2F, 0x50, 0x40),
    CLS_MOSS: (0x7D, 0x7A, 0x5C),
    CLS_SAND: (0xCB, 0xB2, 0x87),
}


def _metres_per_degree(lat_deg: float) -> Tuple[float, float]:
    """Metres per degree of latitude and of longitude.

    A local copy of the series in ``bake_osm_airports.py``. Importing it would
    pull shapely in behind it, and this file deliberately depends on rasterio
    and numpy only - the same trade the ``.pdm`` reader in the coast bake makes.
    """
    lat = math.radians(lat_deg)
    return (111132.92 - 559.82 * math.cos(2 * lat) + 1.175 * math.cos(4 * lat),
            111412.84 * math.cos(lat) - 93.5 * math.cos(3 * lat))


def airfield_pads(manifest: dict) -> List[dict]:
    """Every airfield platform rectangle the airports bake recorded."""
    out: List[dict] = []
    for airfield in (manifest.get('airfields') or {}).get('items') or []:
        out.extend(airfield.get('pads') or [])
    return out


def stamp_airfield_classes(
    classes: np.ndarray, bounds: Tuple[float, float, float, float],
    size: int, pads: Sequence[dict],
) -> int:
    """Paint the airfield platforms as built ground. Returns nodes changed.

    The cover raster does not know an airfield is there. WorldCover has Gran
    Canaria's runways as a patchwork of bare and built at 10 m, and a grass
    field as grass - and whatever the ground was before it was paved is the one
    thing it must not be afterwards. So the platform the mesh bake flattens is
    also the platform the cover bake paints.

    Only the flat core, never the feather, which is the same rule the mesh bake
    and the height sampler use for what counts as paved: the feather is where
    the airfield blends into the countryside, and it should look like it.

    Written into the classes before the colour pass, so a tile with no imagery
    picks up the built-up colour from the class LUT for free.
    """
    if not pads:
        return 0
    west, south, east, north = bounds
    lons = west + (east - west) * np.arange(size) / (size - 1)
    lats = north - (north - south) * np.arange(size) / (size - 1)
    changed = 0
    for pad in pads:
        half_d = pad['halfD']
        half_w = pad['halfW']
        feather = pad.get('featherM', 0.0)
        reach = math.hypot(half_d + feather, half_w + feather)
        m_lat, m_lon = _metres_per_degree(pad['lat'])
        m_lon = max(1.0, m_lon)
        if (pad['lat'] < south - reach / m_lat or pad['lat'] > north + reach / m_lat
                or pad['lon'] < west - reach / m_lon or pad['lon'] > east + reach / m_lon):
            continue
        core_d = max(0.0, half_d - feather)
        core_w = max(0.0, half_w - feather)
        if core_d <= 0 or core_w <= 0:
            continue
        e = (lons - pad['lon']) * m_lon
        n = (lats - pad['lat']) * m_lat
        heading = math.radians(pad.get('headingDeg', 0.0))
        ax, ay = math.sin(heading), math.cos(heading)
        # Rows are latitude, columns are longitude, matching the class grid.
        along = e[None, :] * ax + n[:, None] * ay
        across = e[None, :] * ay - n[:, None] * ax
        mask = (np.abs(along) <= core_d) & (np.abs(across) <= core_w)
        if mask.any():
            changed += int(mask.sum())
            classes[mask] = CLS_BUILT
    return changed


def build_class_lut() -> np.ndarray:
    """256-entry lookup so the whole raster converts in one indexing op."""
    lut = np.full(256, CLS_UNKNOWN, dtype=np.uint8)
    for code, cls in WORLDCOVER_TO_CLASS.items():
        lut[code] = cls
    return lut


def build_color_lut() -> np.ndarray:
    lut = np.zeros((256, 3), dtype=np.uint8)
    lut[:] = CLASS_COLORS[CLS_UNKNOWN]
    for cls, rgb in CLASS_COLORS.items():
        lut[cls] = rgb
    return lut


def tile_bounds(z: int, x: int, y: int) -> Tuple[float, float, float, float]:
    """Geographic quadtree: level z has 2^(z+1) columns by 2^z rows."""
    span = 180.0 / (1 << z)
    west = -180.0 + x * span
    north = 90.0 - y * span
    return west, north - span, west + span, north


def pdm_size(path: str) -> int:
    """Grid size straight out of the PDM1 header, without inflating the body."""
    with open(path, 'rb') as fh:
        head = fh.read(4)
        if head == b'PDM1':
            rest = head + fh.read(20)
        else:
            fh.seek(0)
            rest = zlib.decompress(fh.read())[:24]
    if rest[:4] != b'PDM1':
        raise ValueError(f'{path}: not a PDM1 tile')
    return struct.unpack_from('<H', rest, 4)[0]


class Source:
    """One raster, opened once and windowed per tile."""

    def __init__(self, path: str, bands: Sequence[int], nodata: int):
        self.path = path
        self.bands = list(bands)
        self.nodata = nodata
        self.ds = rasterio.open(path)

    def close(self) -> None:
        self.ds.close()

    def read_onto(
        self, bounds: Tuple[float, float, float, float], size: int, resampling: Resampling,
    ) -> Optional[np.ndarray]:
        """Resample this raster onto a size*size grid over `bounds`.

        Returns None when the raster does not reach the tile at all, which is
        the common case: most of an ocean-heavy coverage has no land in it.
        """
        west, south, east, north = bounds
        sw, ss, se, sn = self.ds.bounds
        if east <= sw or west >= se or north <= ss or south >= sn:
            return None

        # Read a window, decimated so a coarse tile does not pull a whole
        # continent's worth of pixels into memory, then reproject that exact
        # window onto the target grid. Reading straight to out_shape would snap
        # the window to whole source pixels and shift the result by up to half
        # of one; going through the window's own transform does not.
        window = self.ds.window(west, south, east, north).round_offsets().round_lengths()
        # Clamped to the raster by hand rather than with Window.intersection,
        # which *raises* on an empty overlap instead of returning an empty
        # window - so the degenerate check below never ran and the bake died
        # with "Intersection is empty" instead of skipping the tile.
        #
        # The bounds test above does not prevent it. A tile overlapping the
        # raster by less than a pixel passes that test, and then round_offsets
        # takes the overlap away: on a one-tile-wide bbox the raster came out
        # 123 px across and a tile asked for a window at column 123.
        col_off = max(0, int(window.col_off))
        row_off = max(0, int(window.row_off))
        col_end = min(int(self.ds.width), int(window.col_off + window.width))
        row_end = min(int(self.ds.height), int(window.row_off + window.height))
        if col_end - col_off < 1 or row_end - row_off < 1:
            return None
        window = rasterio.windows.Window(
            col_off, row_off, col_end - col_off, row_end - row_off)
        # 4x the target is plenty to resample from and bounds the read.
        out_w = int(min(window.width, size * 4))
        out_h = int(min(window.height, size * 4))
        data = self.ds.read(
            self.bands,
            window=window,
            out_shape=(len(self.bands), out_h, out_w),
            resampling=resampling,
            boundless=False,
        )
        src_transform = self.ds.window_transform(window) * rasterio.Affine.scale(
            window.width / out_w, window.height / out_h)

        dst = np.zeros((len(self.bands), size, size), dtype=data.dtype)
        reproject(
            source=data,
            destination=dst,
            src_transform=src_transform,
            src_crs=self.ds.crs,
            src_nodata=self.nodata,
            dst_transform=transform_from_bounds(west, south, east, north, size, size),
            dst_crs='EPSG:4326',
            dst_nodata=self.nodata,
            resampling=resampling,
        )
        if not np.any(dst != self.nodata):
            return None
        return dst


def encode_plc(size: int, flags: int, classes: np.ndarray, colors: np.ndarray) -> bytes:
    header = struct.pack('<4sBBHII', PLC_MAGIC, PLC_VERSION, flags, size, 0, 0)
    return zlib.compress(header + classes.tobytes() + colors.tobytes(), 6)


def decode_plc(path: str) -> Tuple[np.ndarray, np.ndarray, int]:
    """Inverse of `encode_plc`. Returns (classes, colors, flags).

    `flags` matters as much as the arrays here: it carries
    PLC_FLAG_REAL_IMAGERY, and an ancestor built from this tile as a child
    needs to OR that bit forward, or every ancestor silently loses track of
    which of its descendants actually had real imagery.
    """
    with open(path, 'rb') as fh:
        payload = zlib.decompress(fh.read())
    magic, _version, flags, size, _pad0, _pad1 = struct.unpack_from('<4sBBHII', payload, 0)
    if magic != PLC_MAGIC:
        raise ValueError(f'{path}: not a {PLC_MAGIC.decode()} tile')
    n = size * size
    classes = np.frombuffer(payload, dtype=np.uint8, count=n, offset=PLC_HEADER_BYTES).reshape(size, size)
    colors = np.frombuffer(
        payload, dtype=np.uint8, count=n * 3, offset=PLC_HEADER_BYTES + n,
    ).reshape(size, size, 3)
    return classes, colors, flags


def majority_decimate(child: np.ndarray, r: int, fixed=FIXED_CLASSES) -> np.ndarray:
    """Vote-then-decimate: the majority class in a window around each even
    node, then point-decimated at the same (0::2, 0::2) stride
    bake_planet_dem.py's build_parent() and bake_osm_coast.py's
    build_parent_mask() already use for height and land/water.

    Not the same as subsample-then-vote (which would silently narrow the
    neighbourhood to whatever survived the stride first) and not a 2x2
    block-reshape (adjacent output nodes' windows overlap - a radius-1 window
    around output node (1,2) and one around (1,3) share child column 5 -  so
    non-overlapping block reduction answers a different question). Reuses
    cover_patches.py's own vote/tie-break convention (FIXED_CLASSES never
    vote and are never reassigned, ties go to the lowest class id) rather
    than inventing a second one - this is that same convention, run once
    over the whole child array via `_box_sums`, then subsampled.

    Windows never cross into a sibling child's array - only `child` itself is
    read - so a shared quadrant edge between two ancestors can occasionally
    disagree on a marginal tie. That is the same order of risk DEM/coastline
    already accept from silently double-writing a shared edge; not worth
    engineering around for an occasional single-node flicker.
    """
    if r < 1:
        return child[0::2, 0::2]
    held = np.isin(child, fixed)
    votes = None
    winner = None
    for value in np.unique(child):
        if value in fixed:
            continue
        count = _box_sums(child == value, r)
        if votes is None:
            votes = count
            winner = np.full(child.shape, value, dtype=child.dtype)
        else:
            better = count > votes
            votes = np.where(better, count, votes)
            winner = np.where(better, value, winner)
    result = child if votes is None else np.where(held | (votes == 0), child, winner).astype(child.dtype)
    return result[0::2, 0::2]


def build_parent_cover(
    children: Dict[Tuple[int, int], Tuple[np.ndarray, np.ndarray, int]],
    size: int, r: int,
) -> Tuple[np.ndarray, np.ndarray, int]:
    """Combine up to four child (classes, colors, flags) tiles into one
    parent, the cover-bake analogue of build_parent/build_parent_mask.

    Classes vote (majority_decimate); colours point-decimate, deliberately
    not vote - a windowed mean would average two DISJOINT pixel sets at every
    shared quadrant edge (quadrant A's neighbours vs quadrant B's), producing
    a small but near-guaranteed colour seam wherever there's a gradient
    nearby. Point decimation keeps the same "both quadrants provably agree at
    the shared node" property DEM/coastline already rely on for height and
    land/water.

    A missing quadrant - the routine case for any coastal tile, since
    ocean-only leaf tiles never get a .pdm/.plc at all - is simply never
    written, left at the CLS_UNKNOWN/zero default. This mirrors
    build_parent's flat sea_level fill for the same situation; it is not an
    error case to guard against.
    """
    half = (size - 1) // 2
    classes = np.full((size, size), CLS_UNKNOWN, dtype=np.uint8)
    colors = np.zeros((size, size, 3), dtype=np.uint8)
    flags = 0
    for (qx, qy), (child_classes, child_colors, child_flags) in children.items():
        y0, y1 = qy * half, qy * half + half + 1
        x0, x1 = qx * half, qx * half + half + 1
        classes[y0:y1, x0:x1] = majority_decimate(child_classes, r)
        colors[y0:y1, x0:x1] = child_colors[0::2, 0::2, :]
        flags |= child_flags & PLC_FLAG_REAL_IMAGERY
    return classes, colors, flags


def bake_tile(
    z: int, x: int, y: int,
    src_dir: str,
    out_root: str,
    landcover: Sequence[Source],
    imagery: Sequence[Source],
    class_lut: np.ndarray,
    color_lut: np.ndarray,
    patch_m: float,
    pads: Sequence[dict],
    osm_tree: Optional['STRtree'] = None,
    osm_polys: Sequence['Polygon'] = (),
    osm_classes: Sequence[int] = (),
) -> Optional[Tuple[int, bool, int, int]]:
    """Bakes and writes one tile's .plc. Returns (bytes written, has real
    imagery, nodes repainted as airfield pavement, nodes repainted from OSM
    landuse polygons), or None if this tile has no .pdm to bake against.

    Factored out of `bake()` so a multiprocessing worker can call it too, one
    tile per call - the same split `sample_leaf_level_parallel` in
    `bake_planet_dem.py` makes for the same reason (independent-per-tile work,
    no ordering to preserve).
    """
    stem = os.path.join(src_dir, str(z), str(x), str(y))
    pdm = f'{stem}.pdm'
    if not os.path.exists(pdm):
        return None
    size = pdm_size(pdm)
    bounds = tile_bounds(z, x, y)
    west, south, east, north = bounds
    node_m = ((north - south) / (size - 1)) * 110540

    # Read the class raster with a halo, so the majority filter below sees the
    # same neighbourhood a node would have had in the whole coverage. Without
    # it the outermost nodes are filtered against a truncated window and
    # adjacent tiles disagree along their shared edge.
    halo = halo_nodes(patch_m, node_m)
    pad = halo * ((north - south) / (size - 1))
    read_bounds = (west - pad, south - pad, east + pad, north + pad)
    read_size = size + 2 * halo

    # Classes. Mode resampling, because averaging category codes invents
    # categories that are not there - halfway between built-up and bare is not
    # "somewhat built-up", it is a different class entirely.
    classes = np.zeros((read_size, read_size), dtype=np.uint8)
    for src_lc in landcover:
        got = src_lc.read_onto(read_bounds, read_size, Resampling.mode)
        if got is None:
            continue
        fresh = (classes == CLS_UNKNOWN) & (got[0] != 0)
        classes[fresh] = class_lut[got[0]][fresh]

    classes = enlarge_patches(classes, patch_m, node_m)
    if halo:
        classes = classes[halo:halo + size, halo:halo + size]
    # The crop leaves a view into the padded array; the encoder needs the
    # bytes contiguous.
    classes = np.ascontiguousarray(classes)
    osm_nodes = 0
    if osm_tree is not None:
        osm_nodes = stamp_landuse_classes(classes, bounds, size, osm_tree, osm_polys, osm_classes)
    paved_nodes = stamp_airfield_classes(classes, bounds, size, pads)

    # Colour. Average, because this one really is a continuous quantity.
    colors = np.zeros((size, size, 3), dtype=np.uint8)
    covered = np.zeros((size, size), dtype=bool)
    for src_img in imagery:
        got = src_img.read_onto(bounds, size, Resampling.average)
        if got is None:
            continue
        fresh = (~covered) & np.any(got != 0, axis=0)
        if not fresh.any():
            continue
        for b in range(3):
            colors[..., b][fresh] = got[b][fresh]
        covered |= fresh

    gaps = ~covered
    if gaps.any():
        colors[gaps] = color_lut[classes][gaps]

    flags = PLC_FLAG_REAL_IMAGERY if covered.any() else 0

    out_dir = os.path.join(out_root, str(z), str(x))
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f'{y}.plc')
    blob = encode_plc(size, flags, classes, colors)
    with open(out_path, 'wb') as fh:
        fh.write(blob)
    return len(blob), bool(covered.any()), paved_nodes, osm_nodes


# Per-worker state for cover_level_parallel, set once by _init_cover_worker.
# A rasterio Dataset does not survive being pickled across a process boundary
# (see the same note on `open_sampler` in bake_planet_dem.py), so each worker
# opens its own handles on the same landcover/imagery files rather than
# sharing the caller's.
_cover_src_dir = ''
_cover_out_root = ''
_cover_landcover: List[Source] = []
_cover_imagery: List[Source] = []
_cover_class_lut: Optional[np.ndarray] = None
_cover_color_lut: Optional[np.ndarray] = None
_cover_patch_m = 0.0
_cover_pads: Sequence[dict] = ()
# Shapely structures, not file paths - unlike the raster Sources above,
# these have no open OS handle to survive being pickled across the spawn
# boundary, so they ship straight through initargs (the same thing
# bake_osm_coast.py's own worker pool does with its land/inland/courses
# geometries).
_cover_osm_tree: Optional['STRtree'] = None
_cover_osm_polys: Sequence['Polygon'] = ()
_cover_osm_classes: Sequence[int] = ()


def _init_cover_worker(
    src_dir: str, out_root: str,
    landcover_paths: Sequence[str], imagery_paths: Sequence[str],
    patch_m: float, pads: Sequence[dict],
    osm_tree: Optional['STRtree'], osm_polys: Sequence['Polygon'], osm_classes: Sequence[int],
) -> None:
    global _cover_src_dir, _cover_out_root, _cover_landcover, _cover_imagery
    global _cover_class_lut, _cover_color_lut, _cover_patch_m, _cover_pads
    global _cover_osm_tree, _cover_osm_polys, _cover_osm_classes

    def vsicurl(p: str) -> str:
        return f'/vsicurl/{p}' if p.startswith('http') else p

    _cover_src_dir = src_dir
    _cover_out_root = out_root
    _cover_landcover = [Source(vsicurl(p), [1], 0) for p in landcover_paths]
    _cover_imagery = [Source(vsicurl(p), [1, 2, 3], 0) for p in imagery_paths]
    _cover_class_lut = build_class_lut()
    _cover_color_lut = build_color_lut()
    _cover_patch_m = patch_m
    _cover_pads = pads
    _cover_osm_tree = osm_tree
    _cover_osm_polys = osm_polys
    _cover_osm_classes = osm_classes


def _cover_worker(zxy: Tuple[int, int, int]) -> Optional[Tuple[int, bool, int, int]]:
    z, x, y = zxy
    assert _cover_class_lut is not None and _cover_color_lut is not None
    return bake_tile(
        z, x, y, _cover_src_dir, _cover_out_root,
        _cover_landcover, _cover_imagery,
        _cover_class_lut, _cover_color_lut, _cover_patch_m, _cover_pads,
        _cover_osm_tree, _cover_osm_polys, _cover_osm_classes,
    )


def build_ancestor_tile(src_dir: str, out_root: str, pz: int, px: int, py: int) -> Optional[Tuple[int, int]]:
    """Decimate one parent's .plc from its children on disk.

    Returns (bytes written, flags), or None when no child was ever baked -
    every quadrant ocean-only, nothing to derive the parent from.
    """
    children: Dict[Tuple[int, int], Tuple[np.ndarray, np.ndarray, int]] = {}
    for qx in (0, 1):
        for qy in (0, 1):
            child_path = os.path.join(out_root, str(pz + 1), str(px * 2 + qx), f'{py * 2 + qy}.plc')
            if os.path.exists(child_path):
                children[(qx, qy)] = decode_plc(child_path)
    if not children:
        return None
    size = pdm_size(os.path.join(src_dir, str(pz), str(px), f'{py}.pdm'))
    classes, colors, flags = build_parent_cover(children, size, ANCESTOR_VOTE_RADIUS)
    out_dir = os.path.join(out_root, str(pz), str(px))
    os.makedirs(out_dir, exist_ok=True)
    blob = encode_plc(size, flags, classes, colors)
    with open(os.path.join(out_dir, f'{py}.plc'), 'wb') as fh:
        fh.write(blob)
    return len(blob), flags


def _ancestor_worker(zxy: Tuple[int, int, int]) -> Optional[Tuple[int, int]]:
    z, x, y = zxy
    return build_ancestor_tile(_cover_src_dir, _cover_out_root, z, x, y)


def worker_count(jobs: int, tiles: int) -> int:
    """How many processes to spawn for `tiles` tiles.

    Measured on a 20-core Windows box: a spawned worker costs a couple of
    seconds to import rasterio and shapely, and the per-tile work is memory
    bound, so more workers than physical cores make it slower, not faster -
    Crimea's 1511 tiles took 126 s on 6 workers and 176 s on 19; Madeira's
    137 took 12 s in-process and 39 s on 19. So: one worker per ~48 tiles,
    at most 8, and none at all for a small import.
    """
    if tiles <= 96:
        return 1
    return max(1, min(jobs, 8, -(-tiles // 48)))


def bake_tiles(
    tiles: Sequence[Tuple[int, int, int]],
    src_dir: str,
    out_root: str,
    landcover: Sequence[Source],
    imagery: Sequence[Source],
    landcover_paths: Sequence[str],
    imagery_paths: Sequence[str],
    class_lut: np.ndarray,
    color_lut: np.ndarray,
    patch_m: float,
    pads: Sequence[dict],
    pool=None,
    osm_tree: Optional['STRtree'] = None,
    osm_polys: Sequence['Polygon'] = (),
    osm_classes: Sequence[int] = (),
) -> Tuple[int, int, int, int, int]:
    """Bakes every tile, across the worker `pool` (in this process when None).
    Returns (written, with_imagery, paved_nodes, osm_nodes, total_bytes)."""
    written = 0
    with_imagery = 0
    paved_nodes = 0
    osm_nodes = 0
    total_bytes = 0
    total = len(tiles)

    def accept(result: Optional[Tuple[int, bool, int, int]]) -> None:
        nonlocal written, with_imagery, paved_nodes, osm_nodes, total_bytes
        if result is None:
            return
        blob_len, has_imagery, paved, osm = result
        written += 1
        total_bytes += blob_len
        paved_nodes += paved
        osm_nodes += osm
        if has_imagery:
            with_imagery += 1

    def report(done: int) -> None:
        if done % 50 == 0 or done == total:
            pct = 100.0 * done / max(1, total)
            sys.stdout.write(f'\r  {done}/{total} ({pct:.1f}%)  {total_bytes / 1048576:.1f} MB')
            sys.stdout.flush()

    if pool is None:
        for i, (z, x, y) in enumerate(tiles):
            accept(bake_tile(
                z, x, y, src_dir, out_root, landcover, imagery,
                class_lut, color_lut, patch_m, pads,
                osm_tree, osm_polys, osm_classes,
            ))
            report(i + 1)
        sys.stdout.write('\n')
        return written, with_imagery, paved_nodes, osm_nodes, total_bytes

    for i, result in enumerate(pool.imap_unordered(_cover_worker, tiles, chunksize=8)):
        accept(result)
        report(i + 1)
    sys.stdout.write('\n')
    return written, with_imagery, paved_nodes, osm_nodes, total_bytes


def glue_negative_bbox(argv: Sequence[str]) -> List[str]:
    """Rewrite ``--bbox -9.7,...`` into the ``--bbox=-9.7,...`` argparse takes.

    A western bbox starts with a minus, which argparse reads as the next option
    rather than this one's value.
    """
    out: List[str] = []
    i = 0
    while i < len(argv):
        if argv[i] == '--bbox' and i + 1 < len(argv) and argv[i + 1].startswith('-'):
            out.append(f'--bbox={argv[i + 1]}')
            i += 2
            continue
        out.append(argv[i])
        i += 1
    return out


def parse_bbox(text: str) -> Tuple[float, float, float, float]:
    parts = [p.strip() for p in text.split(',')]
    if len(parts) != 4:
        raise ValueError('bbox must be west,south,east,north')
    return tuple(float(p) for p in parts)  # type: ignore[return-value]


def tile_overlaps(z: int, x: int, y: int, bbox: Tuple[float, float, float, float]) -> bool:
    west, south, east, north = tile_bounds(z, x, y)
    bw, bs, be, bn = bbox
    return not (east <= bw or west >= be or north <= bs or south >= bn)


def union_bounds(tiles: Sequence[Tuple[int, int, int]]) -> Tuple[float, float, float, float]:
    """West/south/east/north spanning every tile, for the OSM landuse fetch.

    Only meant for a same-zoom tile list (e.g. from ``--only``): ``tiles``
    scoped by ``--bbox`` still holds every zoom from 0 up to ``--max-zoom``
    that overlaps it, and a z0/z1 tile spans nearly a whole hemisphere, so
    unioning across zooms would blow the fetch back out to roughly the
    original --bbox's own scope was trying to avoid. Callers with a real
    ``--bbox`` should use ``parse_bbox()`` directly instead of this.
    """
    wests, souths, easts, norths = zip(*(tile_bounds(z, x, y) for z, x, y in tiles))
    return min(wests), min(souths), max(easts), max(norths)


def walk_tiles(src: str, max_zoom: int) -> List[Tuple[int, int, int]]:
    out: List[Tuple[int, int, int]] = []
    for z in range(0, max_zoom + 1):
        zdir = os.path.join(src, str(z))
        if not os.path.isdir(zdir):
            continue
        for xs in os.listdir(zdir):
            xdir = os.path.join(zdir, xs)
            if not os.path.isdir(xdir):
                continue
            for name in os.listdir(xdir):
                if name.endswith('.pdm'):
                    out.append((z, int(xs), int(name[:-4])))
    out.sort()
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--src', default=DEFAULT_SRC, help='pyramid to read and write into')
    ap.add_argument('--out', help='write .plc here instead of alongside the .pdm')
    ap.add_argument('--landcover', action='append', default=[],
                    help='landcover raster (repeatable; local path or http URL)')
    ap.add_argument('--imagery', action='append', default=[],
                    help='true-colour raster (repeatable; local path or http URL)')
    ap.add_argument('--sources', default=DEFAULT_SOURCES,
                    help='fetch_cover_sources.py index, used when no raster is given')
    ap.add_argument('--patch-m', type=float, default=DEFAULT_PATCH_M,
                    help='ground size a landcover patch should read as, in metres '
                         f'(default {DEFAULT_PATCH_M:.0f}; 0 disables the filter)')
    ap.add_argument('--max-zoom', type=int)
    ap.add_argument('--only', action='append', default=[], help='z/x/y, repeatable')
    ap.add_argument('--bbox', help='west,south,east,north degrees; bake only tiles '
                                   'overlapping it (default: every tile in the pyramid)')
    ap.add_argument('--jobs', type=int, default=DEFAULT_JOBS,
                    help=f'tiles baked concurrently (default {DEFAULT_JOBS})')
    ap.add_argument('--osm-landuse', action='store_true',
                    help='paint OSM natural/landuse polygons over the raster class grid '
                         '(opt-in; requires shapely and either --bbox or --only)')
    ap.add_argument('--refresh-osm', action='store_true',
                    help='bypass the Overpass cache for --osm-landuse')
    args = ap.parse_args(glue_negative_bbox(sys.argv[1:]))

    manifest_path = os.path.join(args.src, 'manifest.json')
    if not os.path.exists(manifest_path):
        print(f'error: no manifest at {manifest_path}', file=sys.stderr)
        print('Run tools/bake_planet_dem.py first.', file=sys.stderr)
        sys.exit(1)
    with open(manifest_path, encoding='utf-8') as fh:
        manifest = json.load(fh)

    landcover_paths = list(args.landcover)
    imagery_paths = list(args.imagery)
    if not landcover_paths and not imagery_paths and os.path.exists(args.sources):
        with open(args.sources, encoding='utf-8') as fh:
            found = json.load(fh)
        if found.get('landcover'):
            landcover_paths = [found['landcover']]
        if found.get('imagery'):
            imagery_paths = [found['imagery']]
        print(f'using sources from {args.sources}')

    if not landcover_paths and not imagery_paths:
        print('error: no cover sources. Run tools/fetch_cover_sources.py, or pass',
              file=sys.stderr)
        print('       --landcover / --imagery explicitly.', file=sys.stderr)
        sys.exit(1)

    def vsicurl(p: str) -> str:
        return f'/vsicurl/{p}' if p.startswith('http') else p

    landcover = [Source(vsicurl(p), [1], 0) for p in landcover_paths]
    imagery = [Source(vsicurl(p), [1, 2, 3], 0) for p in imagery_paths]
    for s in landcover + imagery:
        print(f'  {s.path}: {s.ds.width}x{s.ds.height} {s.ds.crs}')

    class_lut = build_class_lut()
    color_lut = build_color_lut()

    max_zoom = manifest.get('maxZoom', 0)
    if args.max_zoom is not None:
        max_zoom = min(max_zoom, args.max_zoom)

    if args.only:
        tiles = [tuple(int(v) for v in spec.split('/')) for spec in args.only]
    else:
        tiles = walk_tiles(args.src, max_zoom)

    if args.bbox:
        # The cover rasters were fetched for one area. A tile outside them
        # reads back nothing, which is not "leave it alone" - it is a .plc of
        # unknown class and LUT colour, written straight over whatever an
        # earlier bake produced there. Scope the tile list instead.
        bbox = parse_bbox(args.bbox)
        before = len(tiles)
        tiles = [t for t in tiles if tile_overlaps(t[0], t[1], t[2], bbox)]
        print(f'bbox: {len(tiles)} of {before} tiles overlap it; '
              f'{before - len(tiles)} left alone')

    out_root = args.out or args.src
    patch = f'{args.patch_m:.0f} m patches' if args.patch_m > 0 else 'raw classes'
    jobs = worker_count(args.jobs, len(tiles))
    print(f'baking cover for {len(tiles)} tiles -> {out_root} ({patch}), {jobs} job(s)')

    pads = airfield_pads(manifest)
    if pads:
        print(f'airfields: {len(pads)} platform rectangles painted as built ground')

    osm_tree = None
    osm_polys: List = []
    osm_classes: List[int] = []
    if args.osm_landuse:
        if not HAS_OSM_LANDUSE:
            print('error: --osm-landuse requires shapely (pip install shapely)', file=sys.stderr)
            sys.exit(1)
        if not args.bbox and not args.only:
            print('error: --osm-landuse requires --bbox or --only (refusing a planet-wide '
                  'Overpass fetch on a bare full-pyramid run)', file=sys.stderr)
            sys.exit(1)
        # Prefer the bbox the caller actually asked for. `tiles` (from
        # --bbox) spans every zoom 0..max-zoom that overlaps it, and a
        # z0/z1 tile is nearly a whole hemisphere wide - union_bounds() over
        # that would blow the fetch back out past the point of scoping it.
        # --only has no such mixture (it's whatever specific tiles were
        # named), so union_bounds() over exactly those is correct there.
        fetch_bbox = parse_bbox(args.bbox) if args.bbox else union_bounds(tiles)
        print(f'fetching OSM landuse for {len(tiles)} tiles...')
        # The same cells the coast bake fetched, and the same open-sea
        # cells it skipped, so this is a cache hit end to end.
        from osm_common import sea_cell_skipper
        data = overpass_landuse_query(
            fetch_bbox, args.refresh_osm,
            skip_cell=sea_cell_skipper(args.src, manifest.get('seaLevel', 0.0)))
        osm_polys, osm_classes = assemble_landuse_polygons(data)
        print(f'  {len(osm_polys)} landuse polygons assembled')
        if osm_polys:
            osm_tree = build_landuse_index(osm_polys)

    # Named tiles make no promise their neighbours/children exist or were
    # just baked this run - the wrong shape for a parent/child dependency
    # chain, so --only keeps the old direct-raw-resample behaviour for every
    # tile it names, unconditionally.
    by_zoom: Dict[int, List[Tuple[int, int, int]]] = {}
    for t in tiles:
        by_zoom.setdefault(t[0], []).append(t)
    finest = tiles if args.only else by_zoom.get(max_zoom, [])

    t0 = time.time()
    # One pool for the leaf tiles and every ancestor level: a spawned worker
    # pays its imports once, not once per phase.
    pool = None
    if jobs > 1:
        pool = mp.get_context('spawn').Pool(
            jobs, initializer=_init_cover_worker,
            initargs=(args.src, out_root, landcover_paths, imagery_paths, args.patch_m, pads,
                      osm_tree, osm_polys, osm_classes))
    written, with_imagery, paved_nodes, osm_nodes, total_bytes = bake_tiles(
        finest, args.src, out_root, landcover, imagery,
        landcover_paths, imagery_paths, class_lut, color_lut, args.patch_m, pads, pool,
        osm_tree, osm_polys, osm_classes,
    )

    for s in landcover + imagery:
        s.close()

    if not args.only:
        # Every level above the finest is built by decimating its own four
        # children, never by independently resampling the raw sources again
        # - the cover-bake analogue of bake_planet_dem.py's build_parent()
        # and bake_osm_coast.py's build_parent_mask(). One level at a time:
        # each parent needs all four (up to four - see build_parent_cover)
        # children gathered first.
        ancestor_levels = sorted((z for z in by_zoom if z < max_zoom), reverse=True)
        if ancestor_levels:
            print(f'building {sum(len(by_zoom[z]) for z in ancestor_levels)} '
                  f'ancestor tiles from their children...')
        # Level by level, coarsest last: a parent reads the children the
        # previous level just wrote. Within a level every parent is
        # independent, so a level goes across the pool.
        t_anc = time.time()
        for z in ancestor_levels:
            level = by_zoom[z]
            if pool is None:
                results = (build_ancestor_tile(args.src, out_root, pz, px, py) for pz, px, py in level)
            else:
                results = pool.imap_unordered(_ancestor_worker, level, chunksize=8)
            for result in results:
                if result is None:
                    continue
                blob_len, flags = result
                written += 1
                total_bytes += blob_len
                if flags & PLC_FLAG_REAL_IMAGERY:
                    with_imagery += 1
        if ancestor_levels:
            print(f'  ancestors built in {time.time() - t_anc:.1f}s')
    if pool is not None:
        pool.close()
        pool.join()

    secs = time.time() - t0
    print(f'wrote {written} cover tiles, {total_bytes / 1048576:.1f} MB in {secs:.1f}s')
    print(f'  {with_imagery}/{max(1, written)} carry real imagery; '
          f'the rest fall back to class colours')
    if paved_nodes:
        print(f'  {paved_nodes} nodes repainted as airfield pavement')
    if osm_nodes:
        print(f'  {osm_nodes} nodes repainted from OSM landuse polygons')
    print('next: npm run bake:mesh')


if __name__ == '__main__':
    main()

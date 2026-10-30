"""Airfield ground colour from the countryside around it, not the imagery.

Inside an aerodrome's perimeter the imagery is the airfield itself: runways,
aprons, terminals and car parks, a grey rectangle the size of the field that
the modelled pavement then sits on top of, slightly offset and never quite the
same shape. So the cover bake paints every node inside the perimeter from the
ground just outside it instead, interpolated across the field.

The interpolation is harmonic (Laplace's equation with the outside as fixed
values): smooth, exact at the fence, and with no preferred direction, so a
field between a forest and farmland blends from one to the other.

It is solved once per airfield on a grid of its own, never per tile. A tile
only sees part of a large field, and a fill solved inside each tile would
disagree with its neighbour's along the shared edge; sampling one per-airfield
solution gives every tile, and every zoom built from them, the same values.

Depends on rasterio and numpy only, like bake_planet_cover.py.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np
from rasterio.features import rasterize
from rasterio.transform import from_bounds as transform_from_bounds

#: Grid spacing of an airfield's own fill, about a z12 cover node's.
FILL_CELL_M = 20.0
#: Ground read outside the perimeter on every side: the ring the fill is
#: drawn from, and room for the box blur below.
FILL_MARGIN_M = 120.0
#: A huge field gets coarser cells rather than an unbounded grid.
FILL_MAX_CELLS = 768
#: Relaxation sweeps per multigrid level; the coarse levels have already put
#: the low frequencies in place, so a couple of dozen settle the rest.
SWEEPS_PER_LEVEL = 24
#: Over-relaxation factor for `_relax`; 1 is Gauss-Seidel, under 2 is stable.
OMEGA = 1.6

Bounds = Tuple[float, float, float, float]


@dataclass
class Perimeter:
    """One airfield's outline, `ring` as (lon, lat), and its bounds."""
    key: int
    ring: List[Tuple[float, float]]
    bounds: Bounds


@dataclass
class AirfieldFill:
    """The filled colour grid over one airfield's bounds plus margin.

    Rows run north to south, columns west to east, cell centres at
    `west + (col + 0.5) * cell_w` - a rasterio grid over `bounds`.
    """
    bounds: Bounds
    colors: np.ndarray  # (rows, cols, 3) float32


def _metres_per_degree(lat_deg: float) -> Tuple[float, float]:
    lat = math.radians(lat_deg)
    return (111132.92 - 559.82 * math.cos(2 * lat) + 1.175 * math.cos(4 * lat),
            111412.84 * math.cos(lat) - 93.5 * math.cos(3 * lat))


def airfield_perimeters(manifest: dict) -> List[Perimeter]:
    """Every airfield's perimeter the airports bake recorded."""
    out: List[Perimeter] = []
    for i, airfield in enumerate((manifest.get('airfields') or {}).get('items') or []):
        ring = airfield.get('perimeter') or []
        if len(ring) < 4:
            continue
        pts = [(float(p[1]), float(p[0])) for p in ring]
        lons = [p[0] for p in pts]
        lats = [p[1] for p in pts]
        out.append(Perimeter(airfield.get('osmId', i), pts, (min(lons), min(lats), max(lons), max(lats))))
    return out


def fill_bounds(perimeter: Perimeter) -> Tuple[Bounds, int, int]:
    """The grid an airfield's fill is solved on: bounds, rows, cols."""
    west, south, east, north = perimeter.bounds
    m_lat, m_lon = _metres_per_degree((south + north) / 2)
    m_lon = max(1.0, m_lon)
    west -= FILL_MARGIN_M / m_lon
    east += FILL_MARGIN_M / m_lon
    south -= FILL_MARGIN_M / m_lat
    north += FILL_MARGIN_M / m_lat
    width_m = (east - west) * m_lon
    height_m = (north - south) * m_lat
    cell = max(FILL_CELL_M, max(width_m, height_m) / FILL_MAX_CELLS)
    cols = max(4, int(math.ceil(width_m / cell)))
    rows = max(4, int(math.ceil(height_m / cell)))
    return (west, south, east, north), rows, cols


def ring_mask(ring: Sequence[Tuple[float, float]], bounds: Bounds, rows: int, cols: int) -> np.ndarray:
    """Cells of a rasterio grid over `bounds` whose centre is inside the ring."""
    transform = transform_from_bounds(*bounds, cols, rows)
    geom = {'type': 'Polygon', 'coordinates': [list(ring)]}
    return rasterize([(geom, 1)], out_shape=(rows, cols), transform=transform,
                     fill=0, dtype='uint8').astype(bool)


def _box_blur_known(values: np.ndarray, known: np.ndarray) -> np.ndarray:
    """3x3 mean over the known cells only: speckle out of the fence line."""
    w = known.astype(np.float32)
    v = values * w[..., None]
    pw = np.pad(w, 1)
    pv = np.pad(v, ((1, 1), (1, 1), (0, 0)))
    rows, cols = known.shape
    sw = np.zeros_like(w)
    sv = np.zeros_like(v)
    for dy in range(3):
        for dx in range(3):
            sw += pw[dy:dy + rows, dx:dx + cols]
            sv += pv[dy:dy + rows, dx:dx + cols]
    out = values.copy()
    ok = known & (sw > 0)
    out[ok] = sv[ok] / sw[ok][:, None]
    return out


def _relax(values: np.ndarray, known: np.ndarray, sweeps: int) -> np.ndarray:
    """Relax the unknown cells towards the mean of their four neighbours.

    Red-black over-relaxation: each sweep updates one checkerboard colour
    from the other, overshooting by OMEGA, which settles several times faster
    than plain Jacobi for the same cost. The grid edge mirrors itself (edge
    padding), so the fill does not lean towards a value that is not there.
    """
    v = values.copy()
    rows, cols = known.shape
    parity = (np.arange(rows)[:, None] + np.arange(cols)[None, :]) % 2
    free = [~known & (parity == 0), ~known & (parity == 1)]
    for _ in range(sweeps):
        for colour in free:
            p = np.pad(v, ((1, 1), (1, 1), (0, 0)), mode='edge')
            mean = (p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]) * 0.25
            v[colour] += OMEGA * (mean[colour] - v[colour])
    return v


def harmonic_fill(values: np.ndarray, known: np.ndarray) -> np.ndarray:
    """Fill the cells not `known` so the result is harmonic between them.

    Multigrid in its simplest form: solve a half-resolution copy first, take
    it as the starting guess, then relax. Plain relaxation from a flat start
    needs on the order of (cells across)^2 sweeps to carry the fence colour
    into the middle of a large field; this needs a few dozen per level.
    """
    values = values.astype(np.float32)
    if known.all():
        return values
    if not known.any():
        return values
    rows, cols = known.shape
    if min(rows, cols) <= 8:
        start = values.copy()
        start[~known] = values[known].mean(axis=0)
        return _relax(start, known, SWEEPS_PER_LEVEL * 4)

    # Half resolution: a coarse cell is known when any of its 2x2 is, and
    # holds the mean of those.
    r2, c2 = (rows + 1) // 2, (cols + 1) // 2
    pr, pc = r2 * 2 - rows, c2 * 2 - cols
    kv = np.pad(values * known[..., None], ((0, pr), (0, pc), (0, 0)))
    kw = np.pad(known.astype(np.float32), ((0, pr), (0, pc)))
    sv = kv.reshape(r2, 2, c2, 2, 3).sum(axis=(1, 3))
    sw = kw.reshape(r2, 2, c2, 2).sum(axis=(1, 3))
    coarse_known = sw > 0
    coarse = np.zeros((r2, c2, 3), dtype=np.float32)
    coarse[coarse_known] = sv[coarse_known] / sw[coarse_known][:, None]
    coarse = harmonic_fill(coarse, coarse_known)

    start = values.copy()
    up = np.repeat(np.repeat(coarse, 2, axis=0), 2, axis=1)[:rows, :cols]
    start[~known] = up[~known]
    return _relax(start, known, SWEEPS_PER_LEVEL)


def build_fill(
    perimeter: Perimeter,
    read_colors: Callable[[Bounds, int, int], Optional[Tuple[np.ndarray, np.ndarray]]],
) -> Optional[AirfieldFill]:
    """Solve one airfield's fill.

    `read_colors(bounds, rows, cols)` returns the ground colour over that grid
    as (rows, cols, 3) and which cells it actually has, or None for no data -
    the cover bake's imagery with its class-colour fallback.
    """
    bounds, rows, cols = fill_bounds(perimeter)
    got = read_colors(bounds, rows, cols)
    if got is None:
        return None
    colors, valid = got
    inside = ring_mask(perimeter.ring, bounds, rows, cols)
    known = valid & ~inside
    if not known.any():
        return None
    colors = colors.astype(np.float32)
    colors = _box_blur_known(colors, known)
    return AirfieldFill(bounds, harmonic_fill(colors, known))


def sample_fill(fill: AirfieldFill, lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
    """Bilinear colour of the fill at each (lon, lat), as (n, 3) float32."""
    west, south, east, north = fill.bounds
    rows, cols = fill.colors.shape[:2]
    fx = (lons - west) / (east - west) * cols - 0.5
    fy = (north - lats) / (north - south) * rows - 0.5
    fx = np.clip(fx, 0, cols - 1)
    fy = np.clip(fy, 0, rows - 1)
    x0 = np.minimum(np.floor(fx).astype(int), cols - 2) if cols > 1 else np.zeros_like(fx, dtype=int)
    y0 = np.minimum(np.floor(fy).astype(int), rows - 2) if rows > 1 else np.zeros_like(fy, dtype=int)
    tx = (fx - x0)[:, None]
    ty = (fy - y0)[:, None]
    c = fill.colors
    x1 = np.minimum(x0 + 1, cols - 1)
    y1 = np.minimum(y0 + 1, rows - 1)
    top = c[y0, x0] * (1 - tx) + c[y0, x1] * tx
    bottom = c[y1, x0] * (1 - tx) + c[y1, x1] * tx
    return top * (1 - ty) + bottom * ty


def _overlaps(a: Bounds, b: Bounds) -> bool:
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


class AirfieldGround:
    """Per-process cache of airfield fills, applied tile by tile.

    Each cover worker keeps its own: a fill is a pure function of its
    airfield and the sources, so two workers that both solve one get the same
    answer, and only the few tiles over a field ever ask for it.
    """

    def __init__(self, perimeters: Sequence[Perimeter],
                 read_colors: Callable[[Bounds, int, int], Optional[Tuple[np.ndarray, np.ndarray]]]):
        self.perimeters = list(perimeters)
        self.read_colors = read_colors
        self._fills: Dict[int, Optional[AirfieldFill]] = {}

    def fill_for(self, perimeter: Perimeter) -> Optional[AirfieldFill]:
        if perimeter.key not in self._fills:
            self._fills[perimeter.key] = build_fill(perimeter, self.read_colors)
        return self._fills[perimeter.key]

    def apply(self, colors: np.ndarray, bounds: Bounds, size: int) -> int:
        """Repaint a tile's nodes inside any perimeter. Returns nodes changed.

        `colors` is the tile's (size, size, 3) node grid, rows north to south,
        nodes on the tile edges.
        """
        west, south, east, north = bounds
        dx = (east - west) / (size - 1)
        dy = (north - south) / (size - 1)
        # A rasterio grid whose cell centres are the nodes.
        node_bounds = (west - dx / 2, south - dy / 2, east + dx / 2, north + dy / 2)
        changed = 0
        for perimeter in self.perimeters:
            if not _overlaps(perimeter.bounds, node_bounds):
                continue
            mask = ring_mask(perimeter.ring, node_bounds, size, size)
            if not mask.any():
                continue
            fill = self.fill_for(perimeter)
            if fill is None:
                continue
            rows, cols = np.nonzero(mask)
            lons = west + cols * dx
            lats = north - rows * dy
            rgb = sample_fill(fill, lons, lats)
            colors[rows, cols] = np.clip(np.rint(rgb), 0, 255).astype(np.uint8)
            changed += int(mask.sum())
        return changed

"""Give the leaves of a capped area the road and bridge data a z12 leaf has.

An area can stop short of the pyramid's maxZoom (its manifest entry's
`leafZoom`, src/script/terrain/leafZoom.ts). The OSM stages know nothing of
that: bake_osm_roads.py files every road class at leaf tolerance, and every
bridge span, only at maxZoom, and leaves the levels above as thinned parents
(tertiary and up at z11, half-cell simplified, no spans). A capped leaf is
meshed, draped, bridged and graded from its own tile's files, so this writes
them from the maxZoom tiles beneath it:

  .rvr  every child's roads, replacing the thinned parent
  .rbr  every child's bridge spans
  .lvr  land, water and land-use regions re-clipped from the children at the
        leaf's tolerances, without the parent's thinning (bake_osm_coast.py
        builds ancestors the same way, then drops what their level can't show)

Building footprints stay at maxZoom: the roof stores are keyed there, and
bake_planet_buildings.ts reads them beneath a capped leaf itself.

Run after the OSM stages and before the mesh bake; a roads re-bake rewrites
the thinned parent, so every mesh run is preceded by this one.

  python tools/gather_capped_leaves.py [--bbox w,s,e,n] [--out assets/planet]
"""
import argparse
import os
import sys
from typing import Iterable, Optional

from shapely.geometry import MultiPolygon
from shapely.ops import unary_union

from bake_osm_coast import (
    LINE_SIMPLIFY_CELLS, WaterBody, _clip_worker_inline, child_inputs, vector_simplify_tol,
)
from bake_osm_roads import decode_rvr, encode_rvr, rbr_path, rvr_path
from osm_bridges import decode_rbr, encode_rbr
import osm_regions
from osm_common import Bounds, load_manifest, parse_bbox, read_lwm, replace_file, tile_range_for_bounds

RVR_MAX_ROADS = 0xFFFF


def gather_lvr(out_dir: str, z: int, x: int, y: int, max_zoom: int, tile_size: int) -> int:
    """Re-clips tile (z, x, y)'s .lvr from the maxZoom tiles beneath it as a leaf; returns its regions."""
    grid = read_lwm(out_dir, z, x, y)
    if grid is None:
        return 0
    n = 1 << (max_zoom - 1 - z)
    land_parts, bodies, courses, claims = [], [], [], None
    for py in range(y * n, (y + 1) * n):
        for px in range(x * n, (x + 1) * n):
            land, inland, lines, child_claims = child_inputs(out_dir, max_zoom - 1, px, py)
            if not land.is_empty:
                land_parts.append(land)
            bodies += inland
            courses += lines
            if child_claims is not None:
                claims = (claims or []) + child_claims
    # A flat lake split across child_inputs calls is one body again.
    flat = {}
    for body in [b for b in bodies if b.flat]:
        flat.setdefault(body.height, []).append(body.geom)
    bodies = [b for b in bodies if not b.flat] + [WaterBody(unary_union(g), True, h) for h, g in flat.items()]
    land = unary_union(land_parts) if land_parts else MultiPolygon()
    # The pieces a z12 tile may carry, for each z12 tile this one covers.
    cap = osm_regions.MAX_REGIONS_PER_TILE
    osm_regions.MAX_REGIONS_PER_TILE = cap * 4 ** (max_zoom - z)
    tol = vector_simplify_tol(max_zoom, max_zoom, tile_size)
    line_tol = ((180.0 / (1 << max_zoom)) / max(1, tile_size - 1)) * LINE_SIMPLIFY_CELLS
    try:
        _clip_worker_inline(out_dir, tile_size, land, bodies, courses, z, x, y, grid, tol, line_tol,
                            child_claims=claims)
    finally:
        osm_regions.MAX_REGIONS_PER_TILE = cap
    return len(claims or [])


def capped_areas(manifest: dict, max_zoom: int) -> list:
    return [a for a in manifest.get('areas', []) if a.get('leafZoom') is not None and a['leafZoom'] < max_zoom]


def gather(out_dir: str, z: int, x: int, y: int, max_zoom: int) -> tuple:
    """Writes tile (z, x, y)'s .rvr and .rbr from its maxZoom children; returns (roads, spans)."""
    n = 1 << (max_zoom - z)
    roads, spans = [], []
    for cy in range(y * n, (y + 1) * n):
        for cx in range(x * n, (x + 1) * n):
            path = rvr_path(out_dir, max_zoom, cx, cy)
            if os.path.isfile(path):
                with open(path, 'rb') as fh:
                    roads += decode_rvr(fh.read())
            path = rbr_path(out_dir, max_zoom, cx, cy)
            if os.path.isfile(path):
                with open(path, 'rb') as fh:
                    spans += decode_rbr(fh.read())
    if len(roads) > RVR_MAX_ROADS or len(spans) > RVR_MAX_ROADS:
        raise ValueError(f'{z}/{x}/{y}: {len(roads)} roads, {len(spans)} spans past the u16 count')
    for path, items, encode in ((rvr_path(out_dir, z, x, y), roads, encode_rvr),
                                (rbr_path(out_dir, z, x, y), spans, encode_rbr)):
        if items:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            replace_file(path, encode(items))
        elif os.path.isfile(path):
            os.remove(path)
    return len(roads), len(spans)


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', default='assets/planet', help='the planet pyramid (default: assets/planet)')
    parser.add_argument('--bbox', help='west,south,east,north degrees (default: every capped area)')
    args = parser.parse_args(list(argv) if argv is not None else None)

    manifest = load_manifest(os.path.join(args.out, 'manifest.json'))
    max_zoom = manifest.get('maxZoom', 12)
    tile_size = manifest.get('tileSize', 257)
    scope = parse_bbox(args.bbox) if args.bbox else None
    tiles = roads = spans = regions = 0
    for area in capped_areas(manifest, max_zoom):
        z = area['leafZoom']
        box = Bounds(area['west'], area['south'], area['east'], area['north'])
        if scope is not None:
            box = Bounds(max(box.west, scope.west), max(box.south, scope.south),
                         min(box.east, scope.east), min(box.north, scope.north))
            if box.west >= box.east or box.south >= box.north:
                continue
        x0, y0, x1, y1 = tile_range_for_bounds(z, box)
        span = 180.0 / (1 << z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                # A tile is the area's when its centre is (leafZoom.ts).
                lon, lat = -180.0 + (x + 0.5) * span, 90.0 - (y + 0.5) * span
                if not (area['west'] <= lon <= area['east'] and area['south'] <= lat <= area['north']):
                    continue
                if not os.path.isfile(os.path.join(args.out, str(z), str(x), f'{y}.pdm')):
                    continue
                r, s = gather(args.out, z, x, y, max_zoom)
                regions += gather_lvr(args.out, z, x, y, max_zoom, tile_size)
                tiles += 1
                roads += r
                spans += s
        print(f'{area["name"]}: leaves z{z}', flush=True)
    print(f'gathered {tiles} capped leaves: {roads} roads, {spans} bridge spans, {regions} land-use pieces from z{max_zoom}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
